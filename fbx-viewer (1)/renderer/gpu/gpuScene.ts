/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { meshLodChain, meshLodReady } from "../../utils/meshLod";
import { GrowableBuffer, RangeAllocator, RecordTable } from "./buffers";
import type { DrawRange, GeometryEntry, GeometryPool } from "./geometryPool";
import { LOD_GROUP_WORDS, LOD_LAYOUT_ENTRIES, LOD_LEVEL_WORDS } from "./lodSelect";
import type { MaterialEntry, MaterialPool } from "./materialPool";
import { INSTANCE_FLAG, INSTANCE_WORDS } from "./shaders";
import { reportGpu } from "./report";

/**
 * THE GPU SCENE
 *
 * A three.js scene as tables on the graphics card. Every drawn thing is a row in the instance table, and every
 * distinct geometry and material pair is a draw group: a hundred separate crates are a hundred rows and one draw.
 * The scene graph stays the source of truth; each frame the walk below writes only the rows whose matrices moved,
 * and compute passes decide from the table what each view draws.
 *
 * A group holds one slot per detail level: one draw over the same vertices with fewer indices, and the cull shader
 * puts each instance in the slot its size on the screen calls for (lodSelect.ts). A skinned or morphing mesh is a
 * posed copy: its own run of the vertex table, which the skinning pass writes every frame, and its own group.
 *
 * What a group draws may change while it is drawn, as a terrain chunk's indices or a trail's draw range do. That is
 * written straight into its entries of the draw table, with no new layout, so a pass reading draw arguments takes them
 * from that table each frame. Only new or resized groups, or a material that has changed, make a new layout.
 */

export const DRAW_ARGS_WORDS = 5;
const INITIAL_INSTANCES = 4096;
const MIN_GROUP_CAPACITY = 8;
/** Frames an object may go unseen, hidden or removed, before its rows are given back. */
const FORGET_AFTER = 120;
/** Frames before an object nothing can draw yet is looked at again. */
const RETRY_AFTER = 30;
/** Frames before an object that failed outright is tried again. */
const REFUSED_FOR = 600;
/** Milliseconds a frame may spend making detail levels; the rest wait for later frames and draw in full meanwhile. */
const LEVEL_BUDGET_MS = 2;

// Where things lie in a row, past the matrices (see INSTANCE_WGSL).
const ROW_SPHERE = 24;
const ROW_COLOR = 28;
const ROW_GROUP = 32;
const ROW_FLAGS = 33;
const ROW_LAYERS = 34;
const ROW_PREVIOUS_OFFSET = 35;

const LINES_NONE = 0;
const LINES_STRIP = 1;
const LINES_LOOP = 2;
const LINES_WIRE = 3;

/** One detail level of a group: an entry of the group-offset and draw tables. */
export interface DrawSlot {
  /** Which entry. The full level's is the group's id; coarser ones come after all the groups. */
  slot: number;
  /** How far this level's surface strays, in the geometry's own units; 0 for the full level. */
  error: number;
  range: DrawRange;
  firstVisible: number;
}

/** A mesh drawn from its own vertices, which the skinning pass writes each frame. */
export interface PosedMesh {
  mesh: THREE.Mesh;
  /** What it is posed from: its vertices, skin weights and morph deltas. */
  source: GeometryEntry;
  vertexBase: number;
  previousBase: number;
  vertexCount: number;
  /** It has no past: the next posing makes previous positions equal to current ones. */
  fresh: boolean;
  groups: DrawGroup[];
}

export interface DrawGroup {
  key: string;
  /** Its number in the instance rows, and the slot of its full level. */
  id: number;
  /** What it draws, its full level's indices included. Not the mesh's own geometry when that had to be welded for levels. */
  geometry: GeometryEntry;
  material: MaterialEntry;
  /** Its full level's range, the same as `slots[0].range`. */
  range: DrawRange;
  topology: GPUPrimitiveTopology;
  baseVertex: number;
  instances: number;
  capacity: number;
  /** Where its full level starts in the visible list, the same as `slots[0].firstVisible`. */
  firstVisible: number;
  /** Its detail levels, full first. Every slot has `capacity` places in the visible list and draws from `baseVertex`. */
  slots: DrawSlot[];
  /** The geometries its coarser levels draw from, which nothing else looks at from frame to frame. */
  levelEntries: GeometryEntry[];
  /** Drawn by the forward pass from its list, not in the surface buffer: see GpuScene.forward. */
  forward: boolean;
  /** The posed mesh it draws, when it is one's. */
  posed: PosedMesh | null;
  /** The mesh's own geometry. */
  source: GeometryEntry;
  materialRevision: number;
  /** Drawn by the cluster pass in the main view. */
  clustered?: boolean;
  /** Always forward, whatever its material: sprites, points and lines. */
  forwardKind: boolean;
  /** A mesh, so its material can turn it into a wireframe. */
  meshLike: boolean;
  lines: number;
  arrayed: boolean;
  partIndex: number;
  partStart: number;
  partCount: number;
  drawStart: number;
  drawCount: number;
  placement: number;
  levelEdits: number;
  seenFrame: number;
}

export interface ForwardItem {
  object: THREE.Mesh;
  part: ObjectPart;
}

export interface ObjectPart {
  group: DrawGroup;
  firstInstance: number;
  count: number;
  /** Its place on the forward list, kept so that the list costs nothing to make. */
  forwardItem: ForwardItem;
}

interface ObjectRecord {
  object: THREE.Mesh;
  parts: ObjectPart[];
  lastSeen: number;
  retryAt: number;
  listIndex: number;
  /** Doubles, as three's matrices are, or a value a float cannot hold would look moved every frame. */
  matrix: Float64Array;
  flags: number;
  layers: number;
  count: number;
  materialMask: number;
  instanceVersion: number;
  colorVersion: number;
  previousOffset: number;
  sphere: THREE.Sphere | null;
  sphereRadius: number;
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  entry: GeometryEntry | null;
  placement: number;
  posed: PosedMesh | null;
  moved: boolean;
  hidden: boolean;
  /** Its rows have no past: what they hold is not this object's. */
  first: boolean;
}

export interface SceneLight {
  light: THREE.Light;
}

type BeforeRender = (renderer: unknown, scene: unknown, camera: unknown, geometry: unknown, material: unknown, group: unknown) => void;

const _world = new THREE.Matrix4();
const _instance = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _color = new THREE.Color();
const _draw = new Uint32Array(DRAW_ARGS_WORDS);
const DEFAULT_BEFORE_RENDER = THREE.Object3D.prototype.onBeforeRender;

const isSprite = (object: THREE.Object3D): boolean => !!(object as THREE.Sprite).isSprite;
const isPoints = (object: THREE.Object3D): boolean => !!(object as THREE.Points).isPoints;
const isLine = (object: THREE.Object3D): boolean => !!(object as THREE.Line).isLine;

const flagsOf = (object: THREE.Object3D): number => {
  let flags = INSTANCE_FLAG.active;
  // As in three.js, a sprite never goes in a shadow map.
  if (object.castShadow && !isSprite(object)) flags |= INSTANCE_FLAG.castsShadow;
  if (object.receiveShadow) flags |= INSTANCE_FLAG.receivesShadow;
  if (!object.frustumCulled) flags |= INSTANCE_FLAG.alwaysVisible;
  return flags;
};

const wantsPose = (mesh: THREE.Mesh, entry: GeometryEntry): boolean => {
  const skinned = mesh as THREE.SkinnedMesh;
  if (skinned.isSkinnedMesh && skinned.skeleton && entry.skinCount > 0) return true;
  return !!mesh.morphTargetInfluences?.length && entry.morphTargets > 0;
};

/** Whether `geometry` is a detail level of `full`: what a hook choosing levels on the CPU swaps in. */
const isLevelOf = (full: THREE.BufferGeometry, geometry: THREE.BufferGeometry): boolean => {
  if (full.attributes.position !== geometry.attributes.position) return false;
  const levels = meshLodChain(full);
  for (let level = 0; level < levels.length; level++) if (levels[level].geometry === geometry) return true;
  return false;
};

export class GpuScene {
  readonly instances = new RecordTable(INSTANCE_WORDS, INITIAL_INSTANCES);
  readonly instanceBuffer: GrowableBuffer;
  /** For each slot, where its run of the visible list starts. */
  readonly groupFirst: GrowableBuffer;
  /** For each slot, its draw's arguments with no instances yet. */
  readonly drawTemplate: GrowableBuffer;
  /** For each group, where its coarser levels start in `lodLevels` and how many there are (lodSelect.ts). */
  readonly lodGroups: GrowableBuffer;
  /** For each coarser level, its error and its slot (lodSelect.ts). */
  readonly lodLevels: GrowableBuffer;
  readonly lodLayout: GPUBindGroupLayout;
  private lodBind: GPUBindGroup | null = null;
  private lodBindGeneration = -1;
  private readonly allocator = new RangeAllocator();
  private readonly records = new Map<THREE.Object3D, ObjectRecord>();
  private readonly recordList: ObjectRecord[] = [];
  private readonly groups = new Map<string, DrawGroup>();
  groupList: DrawGroup[] = [];
  /** How many slots the draw tables have: groups' full levels and then their coarser ones. */
  slotCount = 0;
  /** Goes up when groups were added or their ranges moved: what was recorded over them is recorded again. */
  layoutRevision = 0;
  private layoutDirty = true;
  /** Goes up when the draw table was changed without a new layout. */
  drawRevision = 0;
  visibleCapacity = 0;
  directional: THREE.DirectionalLight[] = [];
  local: (THREE.PointLight | THREE.SpotLight)[] = [];
  ambient = new THREE.Color();
  hemiSky = new THREE.Color();
  hemiGround = new THREE.Color();
  /**
   * What the forward pass draws this frame: anything transparent, and sprites, points and lines whatever their material.
   * A part's rows are `firstInstance` on for `count`; `object` says what it is. Their groups have `forward` set, and the
   * surface buffer leaves those out.
   */
  forward: ForwardItem[] = [];
  /** The posed meshes seen this frame, for the skinning pass. */
  posed: PosedMesh[] = [];
  private seen = 0;
  private levelsReady = false;
  private readonly levelQueue: DrawGroup[] = [];
  private renderer: unknown = null;
  private camera: THREE.Camera | null = null;
  private viewer: THREE.Camera | null = null;
  private scene: THREE.Scene | null = null;
  private readonly brokenCallbacks = new WeakSet<THREE.Object3D>();
  private readonly refused = new WeakMap<THREE.Object3D, number>();
  private knownDeaths = 0;

  constructor(
    private readonly device: GPUDevice,
    private readonly geometries: GeometryPool,
    private readonly materials: MaterialPool,
  ) {
    this.instanceBuffer = new GrowableBuffer(device, "gpu instances", GPUBufferUsage.STORAGE, INITIAL_INSTANCES * INSTANCE_WORDS * 4);
    this.groupFirst = new GrowableBuffer(device, "gpu group offsets", GPUBufferUsage.STORAGE, 4096);
    this.drawTemplate = new GrowableBuffer(device, "gpu draw template", GPUBufferUsage.STORAGE, 4096 * DRAW_ARGS_WORDS);
    this.lodGroups = new GrowableBuffer(device, "gpu detail level groups", GPUBufferUsage.STORAGE, 4096);
    this.lodLevels = new GrowableBuffer(device, "gpu detail levels", GPUBufferUsage.STORAGE, 4096);
    this.lodLayout = device.createBindGroupLayout({ label: "gpu detail levels", entries: LOD_LAYOUT_ENTRIES });
    const ready = () => { this.levelsReady = true; };
    void meshLodReady.then(ready, ready);
  }

  get instanceCount(): number {
    return this.allocator.end;
  }

  /** The tables `pickSlot` reads, for bind group LOD_BIND_GROUP of what uses it (lodSelect.ts). */
  get lodBindGroup(): GPUBindGroup {
    const generation = this.lodGroups.generation + this.lodLevels.generation;
    if (!this.lodBind || this.lodBindGeneration !== generation) {
      this.lodBindGeneration = generation;
      this.lodBind = this.device.createBindGroup({
        label: "gpu detail levels",
        layout: this.lodLayout,
        entries: [
          { binding: 0, resource: { buffer: this.lodGroups.buffer } },
          { binding: 1, resource: { buffer: this.lodLevels.buffer } },
        ],
      });
    }
    return this.lodBind;
  }

  /**
   * Walks the scene: rows for what is new or moved, lights gathered, and what went away forgotten. The scene's own and
   * each object's `onBeforeRender` run here, once a frame, as three's renderer would run them; objects' are only run
   * given a `camera`, since that is what they look at. `viewer` is who the frame is for: a light it cannot see does not
   * light its picture, and a level-of-detail object chooses by its distance, as three's renderer has it.
   */
  extract(scene: THREE.Scene, frame: number, renderer?: unknown, camera?: THREE.Camera, viewer?: THREE.Camera): void {
    this.renderer = renderer ?? null;
    this.camera = camera ?? null;
    this.viewer = viewer ?? null;
    this.scene = scene;
    this.directional.length = 0;
    this.local.length = 0;
    this.forward.length = 0;
    this.posed.length = 0;
    this.ambient.setRGB(0, 0, 0);
    this.hemiSky.setRGB(0, 0, 0);
    this.hemiGround.setRGB(0, 0, 0);
    this.seen = 0;
    this.geometries.beginFrame();
    this.beforeRenderScene(scene);
    this.walk(scene, frame);
    if (this.seen !== this.recordList.length) this.sweep(frame);
    this.sealGoneMaterials(frame);
    this.giveLevels();
    if (this.layoutDirty) this.layout();
    this.instances.ensure(this.allocator.end);
    if (this.instanceBuffer.ensure(this.instances.data.byteLength)) this.instances.markAllDirty(this.allocator.end);
    this.instances.upload(this.instanceBuffer);
  }

  /**
   * A group stays in what was recorded while its objects are hidden, and a hidden object's material is not looked at. If
   * a picture of it was destroyed in that time, its bind group would throw away every frame it was still recorded in.
   */
  private sealGoneMaterials(frame: number): void {
    const deaths = this.materials.pictureDeaths;
    if (deaths === this.knownDeaths) return;
    this.knownDeaths = deaths;
    for (const group of this.groups.values()) {
      if (group.seenFrame !== frame) this.materials.checkPictures(group.material);
    }
  }

  /** Takes every group not drawn in `frame` out of what is recorded until it is drawn again, and has the rest recorded anew. */
  sealHidden(frame: number): void {
    for (const group of this.groups.values()) {
      if (group.seenFrame !== frame) this.materials.seal(group.material);
    }
    this.layoutDirty = true;
  }

  private beforeRenderScene(scene: THREE.Scene): void {
    if (scene.onBeforeRender === DEFAULT_BEFORE_RENDER || this.brokenCallbacks.has(scene)) return;
    try {
      (scene.onBeforeRender as unknown as BeforeRender).call(scene, this.renderer, scene, this.camera, null, undefined, undefined);
    } catch (error) {
      this.brokenCallbacks.add(scene);
      reportGpu("[gpu] the scene's onBeforeRender failed and is no longer called", error);
    }
  }

  private walk(object: THREE.Object3D, frame: number): void {
    if (!object.visible) return;
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh || isLine(object) || isPoints(object) || isSprite(object)) {
      if (mesh.geometry && mesh.material) this.visit(mesh, frame);
    } else if ((object as THREE.Light).isLight) {
      if (!this.viewer || object.layers.test(this.viewer.layers)) this.gatherLight(object as THREE.Light);
    } else if ((object as THREE.LOD).isLOD && (object as THREE.LOD).autoUpdate && this.viewer) {
      (object as THREE.LOD).update(this.viewer);
    }
    const { children } = object;
    for (let index = 0; index < children.length; index++) this.walk(children[index], frame);
  }

  private gatherLight(light: THREE.Light): void {
    if ((light as THREE.DirectionalLight).isDirectionalLight) {
      if (light.intensity > 0) this.directional.push(light as THREE.DirectionalLight);
    } else if ((light as THREE.PointLight).isPointLight || (light as THREE.SpotLight).isSpotLight) {
      if (light.intensity > 0) this.local.push(light as THREE.PointLight);
    } else if ((light as THREE.AmbientLight).isAmbientLight) {
      _color.copy(light.color).multiplyScalar(light.intensity);
      this.ambient.add(_color);
    } else if ((light as THREE.HemisphereLight).isHemisphereLight) {
      const hemisphere = light as THREE.HemisphereLight;
      _color.copy(hemisphere.color).multiplyScalar(light.intensity);
      this.hemiSky.add(_color);
      _color.copy(hemisphere.groundColor).multiplyScalar(light.intensity);
      this.hemiGround.add(_color);
    }
  }

  /** Whether the record no longer answers to the object and has to be made again. */
  private stale(record: ObjectRecord, mesh: THREE.Mesh, frame: number): boolean {
    if (record.material !== mesh.material) return true;
    if (record.geometry !== mesh.geometry && !isLevelOf(record.geometry, mesh.geometry)) return true;
    const { entry } = record;
    if (!entry || !record.parts.length) return frame >= record.retryAt;
    this.geometries.check(entry);
    if (entry.released) return true;
    if (wantsPose(mesh, entry) !== (record.posed !== null)) return true;
    // A posed copy is as long as what it copies, and starts over when that changes shape.
    if (record.posed && record.placement !== entry.placement) return true;
    const instanced = mesh as unknown as THREE.InstancedMesh;
    return !!instanced.isInstancedMesh && instanced.instanceMatrix.count !== record.parts[0].count;
  }

  /** One object that cannot be made sense of is left out of the picture, and named once. Nothing else goes with it. */
  private visit(mesh: THREE.Mesh, frame: number): void {
    const held = this.refused.get(mesh);
    if (held !== undefined && frame < held) return;
    try {
      this.draw(mesh, frame);
    } catch (error) {
      this.refused.set(mesh, frame + REFUSED_FOR);
      reportGpu(`[gpu] "${mesh.name || mesh.type}" could not be drawn:`, error);
      const record = this.records.get(mesh);
      if (record) this.forget(record);
    }
  }

  private draw(mesh: THREE.Mesh, frame: number): void {
    let record = this.records.get(mesh);
    if (record && this.stale(record, mesh, frame)) {
      this.forget(record);
      record = undefined;
    }
    if (!record) {
      record = this.create(mesh, frame);
      record.listIndex = this.recordList.length;
      this.recordList.push(record);
      this.records.set(mesh, record);
    }
    record.lastSeen = frame;
    this.seen++;
    const { parts } = record;
    if (!parts.length) return;
    if (record.hidden) {
      record.hidden = false;
      record.first = true;
      if (record.posed) record.posed.fresh = true;
    }
    let materialMask = 0;
    for (let index = 0; index < parts.length; index++) {
      const { group } = parts[index];
      if (group.seenFrame !== frame) this.syncGroup(group, frame);
      if (group.material.material.visible) materialMask |= 1 << (index % 31);
    }
    if (this.camera && mesh.onBeforeRender !== DEFAULT_BEFORE_RENDER) this.beforeRender(mesh, record);
    this.writeRows(mesh, record, materialMask);
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (part.group.forward && part.group.material.material.visible) this.forward.push(part.forwardItem);
    }
    if (record.posed) this.posed.push(record.posed);
  }

  private beforeRender(mesh: THREE.Mesh, record: ObjectRecord): void {
    if (this.brokenCallbacks.has(mesh)) return;
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    try {
      (mesh.onBeforeRender as unknown as BeforeRender).call(mesh, this.renderer, this.scene, this.camera, record.geometry, material, null);
    } catch (error) {
      // Some are written for the WebGL renderer alone. One of those is no reason for a frame to fail, or for a warning each frame.
      this.brokenCallbacks.add(mesh);
      reportGpu(`[gpu] onBeforeRender of "${mesh.name || mesh.type}" failed and is no longer called`, error);
    }
  }

  /** What may have changed about a group since last frame, looked at once a frame however many objects share it. */
  private syncGroup(group: DrawGroup, frame: number): void {
    group.seenFrame = frame;
    // A material may come in late or change its mind about being transparent, so it is looked at every frame.
    const material = this.materials.acquire(group.material.material, frame);
    if (material) {
      group.material = material;
      if (material.revision !== group.materialRevision) {
        group.materialRevision = material.revision;
        group.forward = group.forwardKind || material.state.transparent;
        this.layoutDirty = true;
        if (group.meshLike && material.state.wireframe !== (group.lines === LINES_WIRE)) {
          group.lines = material.state.wireframe ? LINES_WIRE : LINES_NONE;
          group.topology = material.state.wireframe ? "line-list" : "triangle-list";
          if (material.state.wireframe) this.dropLevels(group);
          this.placeGroup(group);
        }
      }
    }
    const source = this.geometries.check(group.source);
    if (source.released) return;
    this.geometries.touch(group.geometry);
    for (let index = 0; index < group.levelEntries.length; index++) this.geometries.touch(group.levelEntries[index]);
    // Levels over welded vertices are a copy of what the mesh had, and do not follow what it has now.
    if (group.geometry !== source && source.vertexEdits !== group.levelEdits) this.dropLevels(group);
    const { drawRange } = source.geometry;
    if (group.placement !== source.placement || group.drawStart !== drawRange.start || group.drawCount !== drawRange.count) this.placeGroup(group);
  }

  private topologyOf(mesh: THREE.Mesh, material: THREE.Material): GPUPrimitiveTopology {
    if (isPoints(mesh)) return "point-list";
    if (isLine(mesh)) return "line-list";
    if (isSprite(mesh)) return "triangle-list";
    return (material as THREE.MeshBasicMaterial).wireframe ? "line-list" : "triangle-list";
  }

  private linesOf(mesh: THREE.Mesh, material: THREE.Material): number {
    if (isLine(mesh)) {
      if ((mesh as unknown as THREE.LineSegments).isLineSegments) return LINES_NONE;
      return (mesh as unknown as THREE.LineLoop).isLineLoop ? LINES_LOOP : LINES_STRIP;
    }
    if (isPoints(mesh) || isSprite(mesh)) return LINES_NONE;
    return (material as THREE.MeshBasicMaterial).wireframe ? LINES_WIRE : LINES_NONE;
  }

  private create(mesh: THREE.Mesh, frame: number): ObjectRecord {
    const record: ObjectRecord = {
      object: mesh,
      parts: [],
      lastSeen: frame,
      retryAt: frame + RETRY_AFTER,
      listIndex: 0,
      matrix: new Float64Array(16).fill(NaN),
      flags: -1,
      layers: 0,
      count: -1,
      materialMask: -1,
      instanceVersion: -1,
      colorVersion: -1,
      previousOffset: 0,
      sphere: null,
      sphereRadius: 0,
      geometry: mesh.geometry,
      material: mesh.material,
      entry: null,
      placement: 0,
      posed: null,
      moved: true,
      hidden: false,
      first: true,
    };
    const entry = this.geometries.acquire(mesh.geometry);
    if (!entry) return record;
    record.entry = entry;
    record.placement = entry.placement;
    const instanced = mesh as unknown as THREE.InstancedMesh;
    const count = instanced.isInstancedMesh ? instanced.instanceMatrix.count : 1;
    const pose = wantsPose(mesh, entry);
    const add = (material: THREE.Material, partStart: number, partCount: number, partIndex: number, arrayed: boolean) => {
      const materialEntry = this.materials.acquire(material, frame);
      if (!materialEntry) return;
      if (pose && !record.posed) {
        const { vertexBase, previousBase } = this.geometries.allocatePosed(entry.vertexCount);
        record.posed = { mesh, source: entry, vertexBase, previousBase, vertexCount: entry.vertexCount, fresh: true, groups: [] };
      }
      const kind = isSprite(mesh) ? "s" : isPoints(mesh) ? "p" : isLine(mesh) ? ((mesh as unknown as THREE.LineSegments).isLineSegments ? "ls" : (mesh as unknown as THREE.LineLoop).isLineLoop ? "ll" : "l") : "m";
      const key = record.posed
        ? `posed:${mesh.id}:${material.uuid}:${partIndex}`
        : `${mesh.geometry.id}:${material.uuid}:${partIndex}:${kind}${arrayed ? "a" : ""}`;
      let group = this.groups.get(key);
      if (!group) {
        group = this.makeGroup(key, mesh, entry, material, materialEntry, record.posed, partStart, partCount, partIndex, arrayed);
        this.groups.set(key, group);
        this.layoutDirty = true;
        this.levelQueue.push(group);
      } else if (group.source !== entry) {
        // The geometry was freed and has come back, somewhere else.
        group.source = entry;
        group.geometry = entry;
        group.slots.length = 1;
        group.levelEntries = [];
        this.layoutDirty = true;
        this.placeGroup(group);
        this.levelQueue.push(group);
      }
      group.instances += count;
      if (group.instances > group.capacity) {
        group.capacity = Math.max(MIN_GROUP_CAPACITY, Math.ceil(group.instances * 1.5));
        this.layoutDirty = true;
      }
      const part: ObjectPart = { group, firstInstance: this.allocator.allocate(count), count, forwardItem: null as unknown as ForwardItem };
      part.forwardItem = { object: mesh, part };
      record.parts.push(part);
      if (record.posed) record.posed.groups.push(group);
    };

    const materials = mesh.material;
    try {
      if (Array.isArray(materials)) {
        const { groups } = mesh.geometry;
        if (groups.length) {
          groups.forEach((part, index) => {
            const material = materials[part.materialIndex ?? 0];
            if (material) add(material, part.start, part.count, index, true);
          });
        } else if (materials[0]) {
          add(materials[0], 0, Infinity, 0, true);
        }
      } else {
        add(materials, 0, Infinity, 0, false);
      }
    } catch (error) {
      // Part way through: what the parts made so far took is given back.
      this.giveBack(record);
      throw error;
    }
    this.instances.ensure(this.allocator.end);
    return record;
  }

  private makeGroup(
    key: string, mesh: THREE.Mesh, entry: GeometryEntry, material: THREE.Material, materialEntry: MaterialEntry,
    posed: PosedMesh | null, partStart: number, partCount: number, partIndex: number, arrayed: boolean,
  ): DrawGroup {
    const forwardKind = isSprite(mesh) || isPoints(mesh) || isLine(mesh);
    const range: DrawRange = { firstIndex: 0, indexCount: 0 };
    const group: DrawGroup = {
      key,
      id: -1,
      geometry: entry,
      material: materialEntry,
      range,
      topology: this.topologyOf(mesh, material),
      baseVertex: 0,
      instances: 0,
      capacity: 0,
      firstVisible: 0,
      slots: [{ slot: -1, error: 0, range, firstVisible: 0 }],
      levelEntries: [],
      forward: forwardKind || materialEntry.state.transparent,
      posed,
      source: entry,
      materialRevision: materialEntry.revision,
      forwardKind,
      meshLike: !forwardKind,
      lines: this.linesOf(mesh, material),
      arrayed,
      partIndex,
      partStart,
      partCount,
      drawStart: 0,
      drawCount: 0,
      placement: 0,
      levelEdits: entry.vertexEdits,
      seenFrame: -1,
    };
    this.placeGroup(group);
    return group;
  }

  /** Works out what the group's full level draws, from where its geometry now lies and its draw range. */
  private placeGroup(group: DrawGroup): void {
    const { source, range } = group;
    if (group.slots.length > 1 && source.reshaped) this.dropLevels(group);
    const { drawRange } = source.geometry;
    group.placement = source.placement;
    group.drawStart = drawRange.start;
    group.drawCount = drawRange.count;
    if (group.lines === LINES_NONE) {
      const entry = group.geometry;
      const start = Math.max(drawRange.start, group.partStart);
      const end = Math.min(entry.indexCount, drawRange.start + drawRange.count, group.partStart + group.partCount);
      range.firstIndex = entry.indexBase + start;
      range.indexCount = Math.max(0, end - start);
    } else {
      const edges = group.lines === LINES_WIRE ? this.geometries.wireRange(source) : this.geometries.stripRange(source, group.lines === LINES_LOOP);
      range.firstIndex = edges.firstIndex;
      range.indexCount = edges.indexCount;
    }
    group.baseVertex = group.posed ? group.posed.vertexBase : group.geometry.vertexBase;
    this.writeDraws(group);
  }

  /** Puts a group's draws in the table where it stands. A layout on its way writes them all anyway. */
  private writeDraws(group: DrawGroup): void {
    if (group.id < 0 || this.layoutDirty) return;
    for (let level = 0; level < group.slots.length; level++) {
      const slot = group.slots[level];
      _draw[0] = slot.range.indexCount;
      _draw[1] = 0;
      _draw[2] = slot.range.firstIndex;
      _draw[3] = group.baseVertex;
      _draw[4] = 0;
      this.drawTemplate.write(slot.slot * DRAW_ARGS_WORDS * 4, _draw);
    }
    this.drawRevision++;
  }

  /** Back to the full level alone, from the mesh's own geometry. */
  private dropLevels(group: DrawGroup): void {
    if (group.slots.length > 1) this.layoutDirty = true;
    group.slots.length = 1;
    group.levelEntries = [];
    const { posed, source } = group;
    if (group.geometry === source) return;
    group.geometry = source;
    if (posed && posed.source !== source) this.repose(posed, source);
    else this.placeGroup(group);
  }

  /** A posed mesh's copy made anew from other vertices: every group of it draws from the new run. */
  private repose(posed: PosedMesh, onto: GeometryEntry): void {
    this.geometries.releasePosed(posed.vertexBase, posed.previousBase, posed.vertexCount);
    const { vertexBase, previousBase } = this.geometries.allocatePosed(onto.vertexCount);
    posed.source = onto;
    posed.vertexBase = vertexBase;
    posed.previousBase = previousBase;
    posed.vertexCount = onto.vertexCount;
    posed.fresh = true;
    for (let index = 0; index < posed.groups.length; index++) {
      const group = posed.groups[index];
      group.geometry = onto;
      group.levelEdits = group.source.vertexEdits;
      if (onto === group.source) {
        group.slots.length = 1;
        group.levelEntries = [];
      }
      this.placeGroup(group);
    }
    this.layoutDirty = true;
  }

  /** Detail levels for the groups waiting for them, as far as this frame's budget goes. */
  private giveLevels(): void {
    if (!this.levelsReady || !this.levelQueue.length) return;
    const started = performance.now();
    while (this.levelQueue.length) {
      const group = this.levelQueue.pop() as DrawGroup;
      if (this.groups.get(group.key) === group) this.attachLevels(group);
      if (performance.now() - started > LEVEL_BUDGET_MS) break;
    }
  }

  private attachLevels(group: DrawGroup): void {
    const { source } = group;
    // The forward pass draws its parts in full, so levels would be made for nothing.
    if (source.released || source.reshaped || group.slots.length > 1 || group.topology !== "triangle-list" || group.forward) return;
    const { drawRange } = source.geometry;
    if (drawRange.start !== 0 || drawRange.count < source.indexCount) return;
    // Geometries over one set of vertices (terrain chunks, or a level of some other mesh) already are someone's levels.
    if (source.run.users.length > 1 && !source.hasLevels) return;
    const levels = meshLodChain(source.geometry);
    if (levels.length < 2) return;
    const base = this.geometries.acquire(levels[0].geometry);
    if (!base) return;
    source.hasLevels = true;
    const sourceGroups = source.geometry.groups;
    const usesParts = group.arrayed && sourceGroups.length > 0;
    const slots: DrawSlot[] = [group.slots[0]];
    const levelEntries: GeometryEntry[] = [];
    for (let level = 1; level < levels.length; level++) {
      const { geometry, error } = levels[level];
      const entry = this.geometries.acquire(geometry);
      if (!entry) break;
      levelEntries.push(entry);
      if (usesParts) {
        // A level made ahead of time may not say which of its triangles go with which material.
        const part = geometry.groups[group.partIndex];
        if (!part || part.materialIndex !== sourceGroups[group.partIndex].materialIndex) break;
        slots.push({ slot: -1, error, range: { firstIndex: entry.indexBase + part.start, indexCount: part.count }, firstVisible: 0 });
      } else {
        slots.push({ slot: -1, error, range: { firstIndex: entry.indexBase, indexCount: entry.indexCount }, firstVisible: 0 });
      }
    }
    if (slots.length < 2) return;
    group.slots = slots;
    group.levelEntries = levelEntries;
    group.levelEdits = source.vertexEdits;
    this.layoutDirty = true;
    const { posed } = group;
    if (posed && posed.source !== base) {
      this.repose(posed, base);
    } else {
      group.geometry = base;
      this.placeGroup(group);
    }
  }

  private writeRows(mesh: THREE.Mesh, record: ObjectRecord, materialMask: number): void {
    const elements = mesh.matrixWorld.elements;
    const { matrix } = record;
    let moved = false;
    for (let index = 0; index < 16; index++) {
      if (matrix[index] !== elements[index]) {
        moved = true;
        break;
      }
    }
    const instanced = mesh as unknown as THREE.InstancedMesh;
    const isInstanced = !!instanced.isInstancedMesh;
    const instanceVersion = isInstanced ? instanced.instanceMatrix.version : 0;
    // Plus one: three shows a colour attribute for the first time at version 0, and that differs from none.
    const colorVersion = isInstanced && instanced.instanceColor ? instanced.instanceColor.version + 1 : 0;
    const count = isInstanced ? instanced.count : 1;
    const { posed } = record;
    const flags = flagsOf(mesh) | (posed ? INSTANCE_FLAG.posed : 0);
    const layers = mesh.layers.mask;
    const previousOffset = posed ? posed.previousBase - posed.vertexBase : 0;
    const own = posed && !isInstanced ? (mesh as unknown as THREE.SkinnedMesh).boundingSphere ?? null : null;
    if (!own && !record.geometry.boundingSphere) record.geometry.computeBoundingSphere();
    const sphere = own ?? record.geometry.boundingSphere;
    const sphereRadius = sphere ? sphere.radius : 0;
    const instanceMoved = moved || instanceVersion !== record.instanceVersion;
    const changed = instanceMoved || colorVersion !== record.colorVersion || flags !== record.flags || layers !== record.layers
      || materialMask !== record.materialMask || previousOffset !== record.previousOffset || sphere !== record.sphere || sphereRadius !== record.sphereRadius;
    // A row that moved last frame and not this one still has to bring its previous matrix up to date.
    if (!changed && !record.moved && !record.first) {
      if (count !== record.count) this.writeCount(record, flags, count);
      return;
    }
    const { first } = record;
    record.first = false;
    record.moved = instanceMoved;
    matrix.set(elements);
    record.instanceVersion = instanceVersion;
    record.colorVersion = colorVersion;
    record.flags = flags;
    record.layers = layers;
    record.count = count;
    record.materialMask = materialMask;
    record.previousOffset = previousOffset;
    record.sphere = sphere;
    record.sphereRadius = sphereRadius;

    // A sprite's quad turns about its centre to face each view, so all it can reach is around that point.
    let radius = sphereRadius;
    if (isSprite(mesh)) {
      const { center } = mesh as unknown as THREE.Sprite;
      radius = Math.SQRT1_2 + Math.hypot(center.x - 0.5, center.y - 0.5);
    } else if (posed && !own) {
      radius *= 2;
    }
    const rowFlags = instanceMoved ? flags | INSTANCE_FLAG.moved : flags;
    const { data } = this.instances;
    const uints = this.instances.uints;
    const { parts } = record;
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex];
      const shown = part.group.material.material.visible;
      for (let row = 0; row < part.count; row++) {
        const at = (part.firstInstance + row) * INSTANCE_WORDS;
        if (isInstanced) {
          instanced.getMatrixAt(row, _instance);
          _world.multiplyMatrices(mesh.matrixWorld, _instance);
        } else {
          _world.copy(mesh.matrixWorld);
        }
        const e = _world.elements;
        // What was current becomes previous. A row written for the first time has no past: it uses the present.
        if (!first) for (let word = 0; word < 12; word++) data[at + 12 + word] = data[at + word];
        data[at] = e[0]; data[at + 1] = e[4]; data[at + 2] = e[8]; data[at + 3] = e[12];
        data[at + 4] = e[1]; data[at + 5] = e[5]; data[at + 6] = e[9]; data[at + 7] = e[13];
        data[at + 8] = e[2]; data[at + 9] = e[6]; data[at + 10] = e[10]; data[at + 11] = e[14];
        if (first) for (let word = 0; word < 12; word++) data[at + 12 + word] = data[at + word];
        if (sphere) _sphere.center.copy(sphere.center).applyMatrix4(_world);
        else _sphere.center.set(e[12], e[13], e[14]);
        data[at + ROW_SPHERE] = _sphere.center.x;
        data[at + ROW_SPHERE + 1] = _sphere.center.y;
        data[at + ROW_SPHERE + 2] = _sphere.center.z;
        data[at + ROW_SPHERE + 3] = radius * _world.getMaxScaleOnAxis();
        if (isInstanced && instanced.instanceColor) {
          instanced.getColorAt(row, _color);
          data[at + ROW_COLOR] = _color.r;
          data[at + ROW_COLOR + 1] = _color.g;
          data[at + ROW_COLOR + 2] = _color.b;
        } else {
          data[at + ROW_COLOR] = 1;
          data[at + ROW_COLOR + 1] = 1;
          data[at + ROW_COLOR + 2] = 1;
        }
        data[at + ROW_COLOR + 3] = 1;
        uints[at + ROW_GROUP] = part.group.id < 0 ? 0 : part.group.id;
        uints[at + ROW_FLAGS] = !shown || row >= count ? 0 : rowFlags | (part.group.clustered ? INSTANCE_FLAG.clustered : 0);
        uints[at + ROW_LAYERS] = layers;
        // A Uint32Array wraps a negative number to the same bits an i32 reads back.
        uints[at + ROW_PREVIOUS_OFFSET] = previousOffset;
      }
      this.instances.markDirty(part.firstInstance, part.count);
    }
  }

  /** Only how many of an instanced mesh's rows are drawn has changed, so only the rows between the two counts are written. */
  private writeCount(record: ObjectRecord, flags: number, count: number): void {
    const uints = this.instances.uints;
    const low = Math.min(count, record.count);
    const high = Math.max(count, record.count);
    record.count = count;
    const { parts } = record;
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex];
      const end = Math.min(high, part.count);
      if (end <= low) continue;
      const shown = part.group.material.material.visible;
      for (let row = low; row < end; row++) uints[(part.firstInstance + row) * INSTANCE_WORDS + ROW_FLAGS] = shown && row < count ? flags : 0;
      this.instances.markDirty(part.firstInstance + low, end - low);
    }
  }

  private hideRows(part: ObjectPart): void {
    const uints = this.instances.uints;
    for (let row = 0; row < part.count; row++) uints[(part.firstInstance + row) * INSTANCE_WORDS + ROW_FLAGS] = 0;
    this.instances.markDirty(part.firstInstance, part.count);
  }

  /** Hides what was not seen this frame, and gives back what has been gone long enough. */
  private sweep(frame: number): void {
    const list = this.recordList;
    for (let index = list.length - 1; index >= 0; index--) {
      const record = list[index];
      if (record.lastSeen === frame) continue;
      if (!record.hidden) {
        record.hidden = true;
        for (let part = 0; part < record.parts.length; part++) this.hideRows(record.parts[part]);
      }
      if (frame - record.lastSeen > FORGET_AFTER) this.forget(record);
    }
  }

  /** What an object's parts hold in the tables. */
  private giveBack(record: ObjectRecord): void {
    for (let index = 0; index < record.parts.length; index++) {
      const part = record.parts[index];
      if (part.firstInstance + part.count <= this.instances.capacity) this.hideRows(part);
      this.allocator.release(part.firstInstance, part.count);
      part.group.instances -= part.count;
      if (part.group.instances <= 0) {
        this.groups.delete(part.group.key);
        this.layoutDirty = true;
      }
    }
    record.parts.length = 0;
    if (record.posed) this.geometries.releasePosed(record.posed.vertexBase, record.posed.previousBase, record.posed.vertexCount);
    record.posed = null;
  }

  private forget(record: ObjectRecord): void {
    this.giveBack(record);
    const list = this.recordList;
    const last = list.pop() as ObjectRecord;
    if (last !== record) {
      list[record.listIndex] = last;
      last.listIndex = record.listIndex;
    }
    this.records.delete(record.object);
  }

  /** Numbers the groups and their slots, gives each slot its run of the visible list, and writes the tables the cull pass and the draws read. */
  private layout(): void {
    this.layoutDirty = false;
    this.layoutRevision++;
    const list = [...this.groups.values()];
    let slots = list.length;
    let levels = 0;
    let first = 0;
    for (let id = 0; id < list.length; id++) {
      const group = list[id];
      group.id = id;
      for (let level = 0; level < group.slots.length; level++) {
        const slot = group.slots[level];
        slot.slot = level === 0 ? id : slots++;
        slot.firstVisible = first;
        first += group.capacity;
      }
      group.firstVisible = group.slots[0].firstVisible;
      levels += group.slots.length - 1;
    }
    this.groupList = list;
    this.slotCount = slots;
    this.visibleCapacity = Math.max(first, 1);
    const offsets = new Uint32Array(Math.max(slots, 1));
    const template = new Uint32Array(Math.max(slots, 1) * DRAW_ARGS_WORDS);
    const lodGroups = new Uint32Array(Math.max(list.length, 1) * LOD_GROUP_WORDS);
    const lodFloats = new Float32Array(Math.max(levels, 1) * LOD_LEVEL_WORDS);
    const lodWords = new Uint32Array(lodFloats.buffer);
    let levelAt = 0;
    for (let id = 0; id < list.length; id++) {
      const group = list[id];
      lodGroups[id * LOD_GROUP_WORDS] = levelAt;
      lodGroups[id * LOD_GROUP_WORDS + 1] = group.slots.length - 1;
      for (let level = 0; level < group.slots.length; level++) {
        const slot = group.slots[level];
        offsets[slot.slot] = slot.firstVisible;
        const at = slot.slot * DRAW_ARGS_WORDS;
        template[at] = slot.range.indexCount;
        template[at + 1] = 0;
        template[at + 2] = slot.range.firstIndex;
        template[at + 3] = group.baseVertex;
        template[at + 4] = 0;
        if (level > 0) {
          lodFloats[levelAt * LOD_LEVEL_WORDS] = slot.error;
          lodWords[levelAt * LOD_LEVEL_WORDS + 1] = slot.slot;
          levelAt++;
        }
      }
    }
    this.groupFirst.ensure(offsets.byteLength);
    this.drawTemplate.ensure(template.byteLength);
    this.lodGroups.ensure(lodGroups.byteLength);
    this.lodLevels.ensure(lodFloats.byteLength);
    this.groupFirst.write(0, offsets);
    this.drawTemplate.write(0, template);
    this.lodGroups.write(0, lodGroups);
    this.lodLevels.write(0, lodFloats);
    // Every row names its group by number, and the numbers may have changed.
    const uints = this.instances.uints;
    const records = this.recordList;
    for (let index = 0; index < records.length; index++) {
      const { parts } = records[index];
      for (let which = 0; which < parts.length; which++) {
        const part = parts[which];
        const { id } = part.group;
        if (!part.count || uints[part.firstInstance * INSTANCE_WORDS + ROW_GROUP] === id) continue;
        for (let row = 0; row < part.count; row++) uints[(part.firstInstance + row) * INSTANCE_WORDS + ROW_GROUP] = id;
        this.instances.markDirty(part.firstInstance, part.count);
      }
    }
  }

  /** Hands the main view's drawing of a group's rows to the cluster pass. */
  markClustered(group: DrawGroup): void {
    if (group.clustered) return;
    group.clustered = true;
    const uints = this.instances.uints;
    for (let index = 0; index < this.recordList.length; index++) {
      for (const part of this.recordList[index].parts) {
        if (part.group !== group) continue;
        for (let row = 0; row < part.count; row++) {
          const at = (part.firstInstance + row) * INSTANCE_WORDS + ROW_FLAGS;
          if (uints[at]) uints[at] |= INSTANCE_FLAG.clustered;
        }
        this.instances.markDirty(part.firstInstance, part.count);
      }
    }
    this.instances.upload(this.instanceBuffer);
  }

  /** Adds the number of every row that draws a group to `into`. */
  rowsOf(group: DrawGroup, into: number[]): void {
    for (let index = 0; index < this.recordList.length; index++) {
      for (const part of this.recordList[index].parts) {
        if (part.group !== group) continue;
        for (let row = 0; row < part.count; row++) into.push(part.firstInstance + row);
      }
    }
  }

  destroy(): void {
    for (let index = 0; index < this.recordList.length; index++) {
      const { posed } = this.recordList[index];
      if (posed) this.geometries.releasePosed(posed.vertexBase, posed.previousBase, posed.vertexCount);
    }
    this.instanceBuffer.destroy();
    this.groupFirst.destroy();
    this.drawTemplate.destroy();
    this.lodGroups.destroy();
    this.lodLevels.destroy();
  }
}
