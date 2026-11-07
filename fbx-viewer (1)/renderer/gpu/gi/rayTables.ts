/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { BOUNDS_FLOATS, buildBvh, NODE_FLOATS, type Bvh } from "../../../runtime/raytracing/bvh";
import {
  coarseGridIndices,
  geometryTriangles,
  keepSlots,
  rayMaterialFor,
  raysSeeMaterial,
  simplifyTriangles,
  type MeshTriangles,
  type RayFilter,
  type RayMaterial,
  type TextureMean,
} from "../../../runtime/raytracing/rayScene";
import { GrowableBuffer, RangeAllocator, RecordTable } from "../buffers";
import {
  POSE_WGSL,
  POSED_TRIANGLE_WORDS,
  RAY_INSTANCE_WORDS,
  RAY_MATERIAL_WORDS,
  RAY_NODE_WORDS,
  RAY_TRIANGLE_WORDS,
  REFIT_MESH_WGSL,
  REFIT_SCENE_WGSL,
  RT_INSTANCE_BOX,
  RT_INSTANCE_NO_SHADOW,
  RT_INSTANCE_ONE_WAY,
} from "./rayWgsl";

/**
 * THE RAY SCENE ON THE GRAPHICS CARD
 *
 * What rays see of a level, in storage buffers compute can walk. A tree over the triangles of each distinct geometry,
 * built once on the CPU however many objects share it, and one tree over the instances placing them in the world. The
 * CPU builds a tree's shape; every frame compute fits its boxes to where things are now, so a moved crate costs a
 * matrix and a thousand crates cost one tree.
 *
 * A skinned mesh, while there are few of them, has a tree of its own over its real triangles: compute writes them from
 * the posed vertices skinning left in the vertex table, then refits that tree. Past the limit, or until the skinning
 * pass can say where its vertices are, a character is a box around its bones.
 */

const TRIANGLE_VERTEX_FLOATS = 9;
const TRIANGLE_BYTES = RAY_TRIANGLE_WORDS * 4;
const NODE_BYTES = RAY_NODE_WORDS * 4;

/** A mesh of more triangles than this is simplified first: bounced light and what a mirror shows do not need them. */
const MAX_MESH_TRIANGLES = 200000;
/** Terrain cells along a side, at most. */
const MAX_TERRAIN_CELLS = 256;
const MAX_INSTANCES = 1 << 18;
/** Refits loosen a tree: its shape is built again this often while something keeps moving, more rarely for a huge one. */
const REBUILD_AFTER_MOVES = 240;
const REBUILD_INSTANCES = 4096;
/** Frames between looks through the scene for what was added or removed. */
const SCAN_INTERVAL = 15;
/** Frames an unused mesh tree stays, in case the view that used it comes straight back. */
const MESH_GRACE = 300;
/** Skinned meshes with real triangles: past this, a character is a box. */
const MAX_POSED_MESHES = 16;
const MAX_POSED_TRIANGLES = 400000;
/** Fits the unit box to a character's bones, with room for the flesh around them. */
const CHARACTER_MARGIN = 0.18;
/** How far a character's box must change, in metres, before the tree hears about it. */
const CHARACTER_MOVE = 0.05;

/** Where skinning left a mesh's posed vertices in the vertex table: null while it has not posed it. */
export type PosedVertexLookup = (mesh: THREE.Mesh) => number | null;

export interface GpuRaySceneStats {
  triangles: number;
  meshes: number;
  instances: number;
  posedMeshes: number;
  pending: number;
  bytes: number;
}

interface MeshTree {
  key: string;
  root: number;
  nodeCount: number;
  firstTriangle: number;
  triangleCount: number;
  /** Box around the mesh, in its own space: min x, y, z, max x, y, z. */
  bounds: Float32Array;
  /** Objects using it now, and the frame the last of them went. */
  users: number;
  idleSince: number;
  /** For a posed mesh's own tree: its shape, and each triangle's three vertices in leaf order. */
  posed: { bvh: Bvh; vertices: Uint32Array } | null;
}

interface Tracked {
  node: THREE.Mesh;
  tree: MeshTree;
  firstMaterial: number;
  materialKey: string;
  /** Instances of it, from `first` in the table. */
  first: number;
  count: number;
  flags: number;
  seen: number;
  /** What its instances were last placed by: as exact as the matrix itself, or an unmoved object would look moved. */
  matrix: Float64Array;
  instanceVersion: number;
  /** The last frame it asked for a tree of a new shape. */
  asked: number;
  bones?: THREE.Bone[];
  /** Where its posed vertices are, for a mesh with real triangles. */
  vertexBase?: number;
}

interface BuiltShape {
  mesh: MeshTriangles;
  /** Three per triangle, for a tree whose triangles come from posed vertices. */
  vertices?: Uint32Array;
}

const _box = new THREE.Box3();
const _matrix = new THREE.Matrix4();
const _inverse = new THREE.Matrix4();
const _instance = new THREE.Matrix4();
const _point = new THREE.Vector3();

/** Writes the box around `bounds` (min, max in its own space) after `matrix`, as six floats at `at`. */
const worldBounds = (bounds: Float32Array, matrix: THREE.Matrix4, out: Float32Array, at: number): void => {
  const e = matrix.elements;
  for (let axis = 0; axis < 3; axis++) {
    let low = e[12 + axis];
    let high = e[12 + axis];
    for (let column = 0; column < 3; column++) {
      const a = e[column * 4 + axis] * bounds[column];
      const b = e[column * 4 + axis] * bounds[column + 3];
      low += Math.min(a, b);
      high += Math.max(a, b);
    }
    out[at + axis] = low;
    out[at + 3 + axis] = high;
  }
};

const characterBox = (bones: THREE.Bone[], out: THREE.Matrix4): void => {
  _box.makeEmpty();
  for (const bone of bones) _box.expandByPoint(_point.setFromMatrixPosition(bone.matrixWorld));
  if (_box.isEmpty()) {
    out.makeScale(1e-3, 1e-3, 1e-3);
    return;
  }
  const { min, max } = _box;
  out.makeScale(max.x - min.x + CHARACTER_MARGIN * 2, max.y - min.y + CHARACTER_MARGIN * 2, max.z - min.z + CHARACTER_MARGIN * 2);
  out.setPosition((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
};

const unitBoxTriangles = (): MeshTriangles => {
  const box = new THREE.BoxGeometry(1, 1, 1);
  const triangles = geometryTriangles(box, false);
  box.dispose();
  return triangles as MeshTriangles;
};

/** The geometry a mesh tree was built from. */
const geometryOfKey = (key: string): string => key.slice(0, key.indexOf(":"));

/** Nodes grouped by how deep they are, shallowest first: a refit runs the groups from the back. */
const levelsOf = (roots: readonly number[], leftOf: (node: number) => number): { order: Uint32Array; spans: [number, number][] } => {
  const order: number[] = [];
  const spans: [number, number][] = [];
  let level: number[] = [...roots];
  while (level.length) {
    spans.push([order.length, level.length]);
    const next: number[] = [];
    for (const node of level) {
      order.push(node);
      const left = leftOf(node);
      if (left >= 0) next.push(left, left + 1);
    }
    level = next;
  }
  return { order: Uint32Array.from(order), spans };
};

export class GpuRayScene {
  readonly triangles: GrowableBuffer;
  readonly meshNodes: GrowableBuffer;
  readonly sceneNodes: GrowableBuffer;
  readonly instanceBuffer: GrowableBuffer;
  readonly materialBuffer: GrowableBuffer;
  /** The five tables as compute reads them, in the order of raySceneWgsl. */
  readonly layout: GPUBindGroupLayout;

  private readonly instances = new RecordTable(RAY_INSTANCE_WORDS, 1024);
  private readonly materials = new RecordTable(RAY_MATERIAL_WORDS, 256);
  private readonly triangleSlots = new RangeAllocator();
  private readonly nodeSlots = new RangeAllocator();
  private readonly posedTriangles: GrowableBuffer;
  private readonly sceneOrder: GrowableBuffer;
  private readonly meshOrder: GrowableBuffer;

  private readonly trees = new Map<string, MeshTree>();
  /** The tree built last for each geometry: what a mesh changing shape uses until its newest shape is built. */
  private readonly latest = new Map<string, MeshTree>();
  private readonly tracked = new Map<THREE.Object3D, Tracked>();
  private readonly queue: { key: string; build: () => BuiltShape | null }[] = [];
  private readonly queued = new Set<string>();
  private readonly materialSlots = new Map<string, number>();
  private frame = 0;
  private movesSinceBuild = 0;
  private layoutChanged = true;
  /** A tree was just built, or a texture's average came in: no waiting for the next look. */
  private lookNow = false;
  private moved = false;
  private instanceCount = 0;
  private bounds = new Float32Array(0);
  private unitBox: MeshTree | null = null;

  // How the frame's refit goes.
  private readonly rangeStep: number;
  private ranges: GPUBuffer;
  private rangeBytes: number;
  private sceneSpans: [number, number][] = [];
  private meshSpans: [number, number][] = [];
  private sceneRangeFirst = 1;
  private meshRangeFirst = 1;
  private posedTriangleCount = 0;
  private posedMeshCount = 0;
  private posedChanged = false;
  private sceneStale = true;
  private scanPosedMeshes = 0;
  private scanPosedTriangles = 0;

  private readonly refitLayouts: { pose: GPUBindGroupLayout; mesh: GPUBindGroupLayout; scene: GPUBindGroupLayout };
  private readonly refitPipelines: { pose: GPUComputePipeline; mesh: GPUComputePipeline; scene: GPUComputePipeline };
  private refitGroups: { key: string; pose: GPUBindGroup; mesh: GPUBindGroup; scene: GPUBindGroup } | null = null;
  private tablesGroup: { key: string; group: GPUBindGroup } | null = null;

  constructor(private readonly device: GPUDevice) {
    const storage = GPUBufferUsage.STORAGE;
    this.triangles = new GrowableBuffer(device, "gi ray triangles", storage, 4096 * TRIANGLE_BYTES);
    this.meshNodes = new GrowableBuffer(device, "gi ray mesh nodes", storage, 4096 * NODE_BYTES);
    this.sceneNodes = new GrowableBuffer(device, "gi ray scene nodes", storage, 1024 * NODE_BYTES);
    this.instanceBuffer = new GrowableBuffer(device, "gi ray instances", storage, 1024 * RAY_INSTANCE_WORDS * 4);
    this.materialBuffer = new GrowableBuffer(device, "gi ray materials", storage, 256 * RAY_MATERIAL_WORDS * 4);
    this.posedTriangles = new GrowableBuffer(device, "gi posed triangles", storage, 1024 * POSED_TRIANGLE_WORDS * 4);
    this.sceneOrder = new GrowableBuffer(device, "gi scene refit order", storage, 4096);
    this.meshOrder = new GrowableBuffer(device, "gi mesh refit order", storage, 4096);
    this.rangeStep = Math.max(device.limits.minUniformBufferOffsetAlignment, 16);
    this.rangeBytes = this.rangeStep * 128;
    this.ranges = device.createBuffer({ label: "gi refit levels", size: this.rangeBytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const compute = GPUShaderStage.COMPUTE;
    const read = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: compute, buffer: { type: "read-only-storage" } });
    const write = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: compute, buffer: { type: "storage" } });
    const range: GPUBindGroupLayoutEntry = { binding: 0, visibility: compute, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 16 } };
    this.layout = device.createBindGroupLayout({ label: "gi ray scene", entries: [0, 1, 2, 3, 4].map(read) });
    this.refitLayouts = {
      pose: device.createBindGroupLayout({ label: "gi pose", entries: [range, read(1), read(2), write(3)] }),
      mesh: device.createBindGroupLayout({ label: "gi refit mesh", entries: [range, read(1), write(2), read(3)] }),
      scene: device.createBindGroupLayout({ label: "gi refit scene", entries: [range, read(1), write(2), read(3), read(4)] }),
    };
    const pipeline = (label: string, code: string, entryPoint: string, layout: GPUBindGroupLayout): GPUComputePipeline => device.createComputePipeline({
      label,
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: device.createShaderModule({ label, code }), entryPoint },
    });
    this.refitPipelines = {
      pose: pipeline("gi pose triangles", POSE_WGSL, "poseTriangles", this.refitLayouts.pose),
      mesh: pipeline("gi refit mesh trees", REFIT_MESH_WGSL, "refitMesh", this.refitLayouts.mesh),
      scene: pipeline("gi refit scene tree", REFIT_SCENE_WGSL, "refitScene", this.refitLayouts.scene),
    };
  }

  get stats(): GpuRaySceneStats {
    let triangles = 0;
    for (const tree of this.trees.values()) triangles += tree.triangleCount;
    const bytes = this.triangles.bytes + this.meshNodes.bytes + this.sceneNodes.bytes + this.instanceBuffer.bytes + this.materialBuffer.bytes + this.posedTriangles.bytes;
    return { triangles, meshes: this.trees.size, instances: this.instanceCount, posedMeshes: this.posedMeshCount, pending: this.queue.length, bytes };
  }

  /** Whether everything found so far has its tree: light built on anything less is about to change. */
  get settled(): boolean {
    return this.queue.length === 0;
  }

  /** Has the next update look through the scene at once. */
  lookAgain(): void {
    this.lookNow = true;
  }

  /**
   * Keeps the tables up with `root`: a look for what was added or removed every few frames, the trees that needs for
   * up to `budgetMs`, and every frame what moved. Call it before anything recorded this frame uses the tables, since
   * a table that grows is replaced.
   */
  update(root: THREE.Object3D, include: RayFilter, mean: TextureMean, posed: PosedVertexLookup | null, budgetMs = 4): void {
    this.frame++;
    if (this.frame === 1 || this.lookNow || this.frame % SCAN_INTERVAL === 0) this.scan(root, include, mean, posed);
    this.buildQueued(budgetMs);
    if (this.layoutChanged) this.layOut();
    else this.followMoves();
    this.upload();
  }

  /** Looks at every mesh below `root` and builds all it needs, however long that takes: for a bake. */
  settle(root: THREE.Object3D, include: RayFilter, mean: TextureMean): void {
    this.frame++;
    this.scan(root, include, mean, null);
    this.buildQueued(Infinity);
    this.frame++;
    this.scan(root, include, mean, null);
    this.layOut();
    this.upload();
  }

  private upload(): void {
    if (this.posedChanged) this.writePosedTable();
    this.instances.upload(this.instanceBuffer);
    this.materials.upload(this.materialBuffer);
  }

  private treeKey(mesh: THREE.Mesh): string {
    const { geometry } = mesh;
    const position = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    const { index } = geometry;
    // Which slots it draws from, and which of them rays can see, decide what the tree holds.
    const slots = Array.isArray(mesh.material) ? mesh.material.map((material) => (raysSeeMaterial(material) ? 1 : 0)).join("") : "s";
    return `${geometry.uuid}:${position?.version ?? 0}:${mesh.userData?.isTerrain ? "t" : index?.version ?? "n"}:${index?.count ?? 0}:${slots}`;
  }

  private scan(root: THREE.Object3D, include: RayFilter, mean: TextureMean, posed: PosedVertexLookup | null): void {
    this.lookNow = false;
    const { frame } = this;
    this.materialSlots.clear();
    this.scanPosedMeshes = 0;
    this.scanPosedTriangles = 0;
    let materialCount = 0;
    const placeMaterials = (materials: THREE.Material[]): { first: number; key: string } => {
      const key = materials.map((material) => material.uuid).join(",");
      const known = this.materialSlots.get(key);
      if (known !== undefined) return { first: known, key };
      const first = materialCount;
      this.materialSlots.set(key, first);
      materialCount += materials.length;
      this.materials.ensure(materialCount);
      materials.forEach((material, slot) => this.writeMaterial(first + slot, rayMaterialFor(material, mean)));
      return { first, key };
    };

    const visit = (node: THREE.Object3D): void => {
      const mesh = node as THREE.Mesh;
      // A terrain's whole mesh stays hidden beside the pieces it draws: rays want it all the same.
      if (!node.visible && !(mesh.isMesh && node.userData?.isTerrain)) return;
      // Instances that change places as the view turns: the whole set stands beside them, holding still, for rays.
      if (mesh.isMesh && !mesh.userData?.shuffledInstances && include(mesh)) {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        if (materials.some(raysSeeMaterial)) {
          const skinned = mesh as THREE.SkinnedMesh;
          const vertexBase = posed ? posed(mesh) : null;
          if (vertexBase !== null || (skinned.isSkinnedMesh && skinned.skeleton)) this.trackPosed(mesh, vertexBase, placeMaterials(materials), frame);
          else this.trackMesh(mesh, placeMaterials(materials), frame);
        }
      }
      for (const child of node.children) visit(child);
    };
    visit(root);

    for (const [owner, entry] of this.tracked) {
      if (entry.seen === frame) continue;
      this.tracked.delete(owner);
      if (entry.tree.posed) this.posedChanged = true;
      this.releaseTree(entry.tree);
      this.layoutChanged = true;
    }
    for (const tree of this.trees.values()) {
      if (tree.users === 0 && tree !== this.unitBox && frame - tree.idleSince > MESH_GRACE) this.freeTree(tree);
    }
  }

  private writeMaterial(index: number, material: RayMaterial): void {
    const { data, uints } = this.materials;
    const at = index * RAY_MATERIAL_WORDS;
    const values = [material.albedo[0], material.albedo[1], material.albedo[2], 0, material.emissive[0], material.emissive[1], material.emissive[2], 0];
    let changed = uints[at + 3] !== material.flags;
    for (let k = 0; k < RAY_MATERIAL_WORDS; k++) {
      if (k === 3) continue;
      // As the table holds it: a colour is rarely exact in 32 bits, and would look changed on every look.
      if (data[at + k] !== Math.fround(values[k])) {
        data[at + k] = values[k];
        changed = true;
      }
    }
    uints[at + 3] = material.flags;
    if (changed) this.materials.markDirty(index);
  }

  private trackMesh(mesh: THREE.Mesh, material: { first: number; key: string }, frame: number): void {
    const key = this.treeKey(mesh);
    const existing = this.tracked.get(mesh);
    const instanced = mesh as THREE.InstancedMesh;
    const count = instanced.isInstancedMesh ? instanced.count : 1;
    const flags = mesh.castShadow ? 0 : RT_INSTANCE_NO_SHADOW;
    const built = this.trees.get(key);
    if (!existing) {
      if (!built) {
        this.requestTree(key, mesh);
        return;
      }
      built.users++;
      this.tracked.set(mesh, {
        node: mesh, tree: built, firstMaterial: material.first, materialKey: material.key, first: 0, count, flags, seen: frame,
        matrix: new Float64Array(16), instanceVersion: -1, asked: frame,
      });
      this.layoutChanged = true;
      return;
    }
    existing.seen = frame;
    if (existing.count !== count || existing.materialKey !== material.key || existing.firstMaterial !== material.first || existing.flags !== flags) {
      existing.count = count;
      existing.materialKey = material.key;
      existing.firstMaterial = material.first;
      existing.flags = flags;
      this.layoutChanged = true;
    }
    if (existing.tree.key === key) return;
    // Its shape changed, perhaps on every frame of a sculpting stroke. It keeps the shape it had rather than leave a
    // hole in what rays see, takes the latest that has been built, and asks for another only so often.
    if (!built && frame - existing.asked >= SCAN_INTERVAL) {
      existing.asked = frame;
      this.requestTree(key, mesh);
    }
    const latest = built ?? this.latest.get(mesh.geometry.uuid);
    if (!latest || latest === existing.tree) return;
    this.releaseTree(existing.tree);
    // A shape left for good: nothing will come back for it.
    if (existing.tree.users === 0 && geometryOfKey(existing.tree.key) === mesh.geometry.uuid) this.freeTree(existing.tree);
    latest.users++;
    existing.tree = latest;
    this.layoutChanged = true;
  }

  /** A mesh skinning poses: its real triangles if there is room for them, or else as a box or as it stands at rest. */
  private trackPosed(mesh: THREE.Mesh, vertexBase: number | null, material: { first: number; key: string }, frame: number): void {
    const triangles = Math.floor((mesh.geometry.index?.count ?? mesh.geometry.getAttribute("position")?.count ?? 0) / 3);
    const roomy = this.scanPosedMeshes < MAX_POSED_MESHES && this.scanPosedTriangles + triangles <= MAX_POSED_TRIANGLES;
    const skinned = mesh as THREE.SkinnedMesh;
    const standIn = (): void => {
      if (skinned.isSkinnedMesh && skinned.skeleton) this.trackCharacter(skinned, material, frame);
      else this.trackMesh(mesh, material, frame);
    };
    if (vertexBase === null || !roomy || !triangles) {
      standIn();
      return;
    }
    this.scanPosedMeshes++;
    this.scanPosedTriangles += triangles;
    const flags = RT_INSTANCE_ONE_WAY | (mesh.castShadow ? 0 : RT_INSTANCE_NO_SHADOW);
    const slots = Array.isArray(mesh.material) ? mesh.material.map((one) => (raysSeeMaterial(one) ? 1 : 0)).join("") : "s";
    // Its own tree, however many meshes share the geometry: each stands in its own pose.
    const key = `${mesh.uuid}:${mesh.geometry.uuid}:${mesh.geometry.index?.count ?? 0}:${slots}:posed`;
    const built = this.trees.get(key);
    const existing = this.tracked.get(mesh);
    if (!existing || existing.tree.key !== key) {
      if (!built) {
        // What it was stands in until the tree is ready.
        this.requestPosedTree(key, mesh);
        standIn();
        return;
      }
      if (existing) this.releaseTree(existing.tree);
      if (existing?.tree.posed) this.posedChanged = true;
      built.users++;
      this.tracked.set(mesh, {
        node: mesh, tree: built, firstMaterial: material.first, materialKey: material.key, first: 0, count: 1, flags, seen: frame,
        matrix: new Float64Array(16), instanceVersion: -1, asked: frame, vertexBase,
      });
      this.posedChanged = true;
      this.layoutChanged = true;
      return;
    }
    existing.seen = frame;
    if (existing.vertexBase !== vertexBase) {
      existing.vertexBase = vertexBase;
      this.posedChanged = true;
    }
    if (existing.materialKey !== material.key || existing.firstMaterial !== material.first || existing.flags !== flags) {
      existing.materialKey = material.key;
      existing.firstMaterial = material.first;
      existing.flags = flags;
      this.layoutChanged = true;
    }
  }

  private trackCharacter(mesh: THREE.SkinnedMesh, material: { first: number; key: string }, frame: number): void {
    // By the bones themselves: some loaders give each mesh of one character a skeleton of its own.
    let owner: THREE.Object3D = mesh.skeleton.bones[0] ?? mesh;
    while ((owner.parent as THREE.Bone | null)?.isBone) owner = owner.parent as THREE.Object3D;
    const flags = RT_INSTANCE_ONE_WAY | RT_INSTANCE_BOX | (mesh.castShadow ? 0 : RT_INSTANCE_NO_SHADOW);
    const existing = this.tracked.get(owner);
    if (existing) {
      // One box for all of it, taking its material from whichever mesh comes first.
      if (existing.seen === frame) return;
      existing.seen = frame;
      if (existing.materialKey !== material.key || existing.firstMaterial !== material.first || existing.flags !== flags) {
        existing.materialKey = material.key;
        existing.firstMaterial = material.first;
        existing.flags = flags;
        this.layoutChanged = true;
      }
      return;
    }
    const box = this.unitBoxTree();
    box.users++;
    this.tracked.set(owner, {
      node: mesh, tree: box, firstMaterial: material.first, materialKey: material.key, first: 0, count: 1, flags, seen: frame,
      matrix: new Float64Array(16), instanceVersion: -1, asked: frame, bones: mesh.skeleton.bones,
    });
    this.layoutChanged = true;
  }

  private unitBoxTree(): MeshTree {
    if (!this.unitBox) this.unitBox = this.addTree("unit-box:", { mesh: unitBoxTriangles() });
    return this.unitBox;
  }

  private requestTree(key: string, mesh: THREE.Mesh): void {
    if (this.queued.has(key)) return;
    this.queued.add(key);
    const { geometry } = mesh;
    const slotted = Array.isArray(mesh.material);
    const seen = Array.isArray(mesh.material) ? mesh.material.map(raysSeeMaterial) : null;
    const terrain = mesh.userData?.isTerrain === true;
    this.queue.push({
      key,
      build: () => {
        const plane = (geometry as THREE.PlaneGeometry).parameters;
        if (terrain && plane?.widthSegments) {
          const stride = Math.max(1, Math.ceil(Math.max(plane.widthSegments, plane.heightSegments) / MAX_TERRAIN_CELLS));
          const coarse = geometryTriangles(geometry, false, coarseGridIndices(plane.widthSegments, plane.heightSegments, stride));
          return coarse ? { mesh: coarse } : null;
        }
        const triangles = geometryTriangles(geometry, slotted);
        if (!triangles) return null;
        return { mesh: simplifyTriangles(seen ? keepSlots(triangles, seen) : triangles, MAX_MESH_TRIANGLES) };
      },
    });
  }

  private requestPosedTree(key: string, mesh: THREE.Mesh): void {
    if (this.queued.has(key)) return;
    this.queued.add(key);
    const { geometry } = mesh;
    const slotted = Array.isArray(mesh.material);
    const seen = Array.isArray(mesh.material) ? mesh.material.map(raysSeeMaterial) : null;
    this.queue.push({
      key,
      build: () => {
        const whole = geometryTriangles(geometry, slotted);
        if (!whole) return null;
        const index = geometry.index?.array;
        const kept: number[] = [];
        for (let triangle = 0; triangle < whole.count; triangle++) {
          if (!seen || seen[whole.slots[triangle]] !== false) kept.push(triangle);
        }
        const shape: MeshTriangles = { positions: new Float32Array(kept.length * TRIANGLE_VERTEX_FLOATS), slots: new Uint16Array(kept.length), count: kept.length };
        const vertices = new Uint32Array(kept.length * 3);
        kept.forEach((triangle, to) => {
          shape.slots[to] = whole.slots[triangle];
          shape.positions.set(whole.positions.subarray(triangle * TRIANGLE_VERTEX_FLOATS, (triangle + 1) * TRIANGLE_VERTEX_FLOATS), to * TRIANGLE_VERTEX_FLOATS);
          for (let corner = 0; corner < 3; corner++) vertices[to * 3 + corner] = index ? index[triangle * 3 + corner] : triangle * 3 + corner;
        });
        return { mesh: shape, vertices };
      },
    });
  }

  private buildQueued(budgetMs: number): void {
    const start = performance.now();
    while (this.queue.length) {
      const next = this.queue.shift() as { key: string; build: () => BuiltShape | null };
      this.queued.delete(next.key);
      const shape = next.build();
      if (shape?.mesh.count) this.addTree(next.key, shape);
      if (performance.now() - start >= budgetMs) return;
    }
  }

  private addTree(key: string, shape: BuiltShape): MeshTree {
    const { mesh } = shape;
    const bounds = new Float32Array(mesh.count * BOUNDS_FLOATS);
    const whole = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    for (let triangle = 0; triangle < mesh.count; triangle++) {
      const at = triangle * TRIANGLE_VERTEX_FLOATS;
      const to = triangle * BOUNDS_FLOATS;
      for (let axis = 0; axis < 3; axis++) {
        const a = mesh.positions[at + axis], b = mesh.positions[at + 3 + axis], c = mesh.positions[at + 6 + axis];
        const low = Math.min(a, b, c), high = Math.max(a, b, c);
        bounds[to + axis] = low;
        bounds[to + 3 + axis] = high;
        whole[axis] = Math.min(whole[axis], low);
        whole[3 + axis] = Math.max(whole[3 + axis], high);
      }
    }
    const bvh = buildBvh(bounds, mesh.count);
    const firstTriangle = this.triangleSlots.allocate(mesh.count);
    const root = this.nodeSlots.allocate(bvh.nodeCount);
    this.triangles.ensure((firstTriangle + mesh.count) * TRIANGLE_BYTES);
    this.meshNodes.ensure((root + bvh.nodeCount) * NODE_BYTES);

    const triangleData = new Float32Array(mesh.count * RAY_TRIANGLE_WORDS);
    const triangleWords = new Uint32Array(triangleData.buffer);
    const p = mesh.positions;
    for (let index = 0; index < mesh.count; index++) {
      const from = bvh.order[index] * TRIANGLE_VERTEX_FLOATS;
      const to = index * RAY_TRIANGLE_WORDS;
      triangleData[to] = p[from];
      triangleData[to + 1] = p[from + 1];
      triangleData[to + 2] = p[from + 2];
      triangleWords[to + 3] = mesh.slots[bvh.order[index]];
      triangleData[to + 4] = p[from + 3] - p[from];
      triangleData[to + 5] = p[from + 4] - p[from + 1];
      triangleData[to + 6] = p[from + 5] - p[from + 2];
      triangleData[to + 8] = p[from + 6] - p[from];
      triangleData[to + 9] = p[from + 7] - p[from + 1];
      triangleData[to + 10] = p[from + 8] - p[from + 2];
    }
    this.triangles.write(firstTriangle * TRIANGLE_BYTES, triangleData);
    this.meshNodes.write(root * NODE_BYTES, this.packNodes(bvh, firstTriangle, root));

    let posed: MeshTree["posed"] = null;
    if (shape.vertices) {
      const vertices = new Uint32Array(mesh.count * 3);
      for (let index = 0; index < mesh.count; index++) {
        const from = bvh.order[index] * 3;
        vertices[index * 3] = shape.vertices[from];
        vertices[index * 3 + 1] = shape.vertices[from + 1];
        vertices[index * 3 + 2] = shape.vertices[from + 2];
      }
      posed = { bvh, vertices };
    }
    this.lookNow = true;
    const tree: MeshTree = { key, root, nodeCount: bvh.nodeCount, firstTriangle, triangleCount: mesh.count, bounds: whole, users: 0, idleSince: this.frame, posed };
    this.trees.set(key, tree);
    this.latest.set(geometryOfKey(key), tree);
    return tree;
  }

  /** A tree in the table's form: interior links and leaf ranges moved to where the tree lies, as whole numbers. */
  private packNodes(bvh: Bvh, firstTriangle: number, root: number): Float32Array {
    const data = new Float32Array(bvh.nodeCount * RAY_NODE_WORDS);
    const words = new Uint32Array(data.buffer);
    const signed = new Int32Array(data.buffer);
    for (let node = 0; node < bvh.nodeCount; node++) {
      const at = node * NODE_FLOATS;
      data[at] = bvh.nodes[at];
      data[at + 1] = bvh.nodes[at + 1];
      data[at + 2] = bvh.nodes[at + 2];
      data[at + 4] = bvh.nodes[at + 4];
      data[at + 5] = bvh.nodes[at + 5];
      data[at + 6] = bvh.nodes[at + 6];
      const count = bvh.nodes[at + 7];
      words[at + 3] = count === 0 ? bvh.nodes[at + 3] + root : count > 0 ? bvh.nodes[at + 3] + firstTriangle : 0;
      signed[at + 7] = count;
    }
    return data;
  }

  private releaseTree(tree: MeshTree): void {
    tree.users = Math.max(0, tree.users - 1);
    if (tree.users === 0) tree.idleSince = this.frame;
  }

  private freeTree(tree: MeshTree): void {
    if (!this.trees.delete(tree.key)) return;
    if (this.latest.get(geometryOfKey(tree.key)) === tree) this.latest.delete(geometryOfKey(tree.key));
    this.triangleSlots.release(tree.firstTriangle, tree.triangleCount);
    this.nodeSlots.release(tree.root, tree.nodeCount);
  }

  /** Hands each tracked mesh its instance slots and builds the top tree's shape. */
  private layOut(): void {
    this.layoutChanged = false;
    this.movesSinceBuild = 0;
    let count = 0;
    for (const entry of this.tracked.values()) {
      const room = Math.max(0, MAX_INSTANCES - count);
      entry.first = count;
      count += Math.min(entry.count, room);
    }
    this.instanceCount = count;
    this.instances.ensure(Math.max(count, 1));
    if (this.bounds.length < count * BOUNDS_FLOATS) this.bounds = new Float32Array(count * BOUNDS_FLOATS * 2);
    for (const entry of this.tracked.values()) {
      const slots = Math.min(entry.count, Math.max(0, count - entry.first));
      this.writeInstances(entry, slots);
    }
    const tree = buildBvh(this.bounds.subarray(0, count * BOUNDS_FLOATS), count, 1);
    this.writeSceneTree(tree);
    this.sceneStale = true;
  }

  private followMoves(): void {
    this.moved = false;
    for (const entry of this.tracked.values()) {
      const slots = Math.min(entry.count, Math.max(0, this.instanceCount - entry.first));
      if (slots > 0 && this.hasMoved(entry)) this.writeInstances(entry, slots);
    }
    if (!this.moved) return;
    this.sceneStale = true;
    const rebuildAfter = REBUILD_AFTER_MOVES * Math.max(1, this.instanceCount / REBUILD_INSTANCES);
    if (++this.movesSinceBuild >= rebuildAfter) this.layOut();
  }

  private hasMoved(entry: Tracked): boolean {
    if (entry.bones) {
      // A character breathing in place does not change what light does: only a box that has really moved counts.
      characterBox(entry.bones, _matrix);
      const box = _matrix.elements;
      for (let k = 0; k < 16; k++) {
        if (Math.abs(entry.matrix[k] - box[k]) > CHARACTER_MOVE) return true;
      }
      return false;
    }
    const instanced = entry.node as THREE.InstancedMesh;
    if (instanced.isInstancedMesh && instanced.instanceMatrix.version !== entry.instanceVersion) return true;
    const elements = entry.node.matrixWorld.elements;
    const { matrix } = entry;
    for (let k = 0; k < 16; k++) {
      if (matrix[k] !== elements[k]) return true;
    }
    return false;
  }

  private writeInstances(entry: Tracked, slots: number): void {
    this.moved = true;
    if (entry.bones) {
      characterBox(entry.bones, _matrix);
      entry.matrix.set(_matrix.elements);
    } else {
      entry.matrix.set(entry.node.matrixWorld.elements);
    }
    const instanced = entry.node as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) entry.instanceVersion = instanced.instanceMatrix.version;
    const { data, uints } = this.instances;
    for (let slot = 0; slot < slots; slot++) {
      if (entry.bones) characterBox(entry.bones, _matrix);
      else if (instanced.isInstancedMesh) {
        instanced.getMatrixAt(slot, _instance);
        _matrix.multiplyMatrices(entry.node.matrixWorld, _instance);
      } else _matrix.copy(entry.node.matrixWorld);
      const index = entry.first + slot;
      worldBounds(entry.tree.bounds, _matrix, this.bounds, index * BOUNDS_FLOATS);
      const e = _inverse.copy(_matrix).invert().elements;
      const w = _matrix.elements;
      const to = index * RAY_INSTANCE_WORDS;
      data[to] = e[0];
      data[to + 1] = e[4];
      data[to + 2] = e[8];
      data[to + 3] = e[12];
      data[to + 4] = e[1];
      data[to + 5] = e[5];
      data[to + 6] = e[9];
      data[to + 7] = e[13];
      data[to + 8] = e[2];
      data[to + 9] = e[6];
      data[to + 10] = e[10];
      data[to + 11] = e[14];
      data[to + 12] = w[0];
      data[to + 13] = w[4];
      data[to + 14] = w[8];
      data[to + 15] = w[12];
      data[to + 16] = w[1];
      data[to + 17] = w[5];
      data[to + 18] = w[9];
      data[to + 19] = w[13];
      data[to + 20] = w[2];
      data[to + 21] = w[6];
      data[to + 22] = w[10];
      data[to + 23] = w[14];
      uints[to + 24] = entry.tree.root;
      uints[to + 25] = entry.firstMaterial;
      uints[to + 26] = entry.flags;
      uints[to + 27] = 0;
    }
    if (slots > 0) this.instances.markDirty(entry.first, slots);
  }

  /** The top tree as compute reads it: a leaf names its instance outright. And the levels its refit goes through. */
  private writeSceneTree(tree: Bvh): void {
    const data = this.packNodes(tree, 0, 0);
    const words = new Uint32Array(data.buffer);
    for (let node = 0; node < tree.nodeCount; node++) {
      const at = node * RAY_NODE_WORDS;
      if (tree.nodes[at + 7] > 0) words[at + 3] = tree.order[tree.nodes[at + 3]];
    }
    this.sceneNodes.ensure(data.byteLength);
    this.sceneNodes.write(0, data);
    const { order, spans } = levelsOf(tree.nodeCount && tree.nodes[7] >= 0 ? [0] : [], (node) => (tree.nodes[node * NODE_FLOATS + 7] === 0 ? tree.nodes[node * NODE_FLOATS + 3] : -1));
    this.sceneSpans = spans;
    if (order.length) {
      this.sceneOrder.ensure(order.byteLength);
      this.sceneOrder.write(0, order);
    }
    this.writeRanges();
  }

  /** Lists every posed triangle and the levels of the posed trees. */
  private writePosedTable(): void {
    this.posedChanged = false;
    let triangles = 0;
    let meshes = 0;
    for (const entry of this.tracked.values()) {
      if (entry.tree.posed && entry.vertexBase !== undefined) {
        triangles += entry.tree.triangleCount;
        meshes++;
      }
    }
    this.posedTriangleCount = triangles;
    this.posedMeshCount = meshes;
    const table = new Uint32Array(triangles * POSED_TRIANGLE_WORDS);
    const roots: number[] = [];
    const lefts = new Map<number, number>();
    let to = 0;
    for (const entry of this.tracked.values()) {
      const { tree, vertexBase } = entry;
      if (!tree.posed || vertexBase === undefined) continue;
      const { vertices, bvh } = tree.posed;
      for (let index = 0; index < tree.triangleCount; index++) {
        table[to++] = tree.firstTriangle + index;
        table[to++] = vertexBase + vertices[index * 3];
        table[to++] = vertexBase + vertices[index * 3 + 1];
        table[to++] = vertexBase + vertices[index * 3 + 2];
      }
      roots.push(tree.root);
      for (let node = 0; node < bvh.nodeCount; node++) {
        const at = node * NODE_FLOATS;
        if (bvh.nodes[at + 7] === 0) lefts.set(tree.root + node, tree.root + bvh.nodes[at + 3]);
      }
    }
    if (table.length) {
      this.posedTriangles.ensure(table.byteLength);
      this.posedTriangles.write(0, table);
    }
    const { order, spans } = levelsOf(roots, (node) => lefts.get(node) ?? -1);
    this.meshSpans = spans;
    if (order.length) {
      this.meshOrder.ensure(order.byteLength);
      this.meshOrder.write(0, order);
    }
    this.writeRanges();
    this.sceneStale = true;
  }

  /** One small uniform per dispatch of the refit, reached by a dynamic offset: first, how many. */
  private writeRanges(): void {
    const needed = (1 + this.sceneSpans.length + this.meshSpans.length) * this.rangeStep;
    if (needed > this.rangeBytes) {
      this.ranges.destroy();
      this.rangeBytes = Math.ceil(needed * 1.5);
      this.ranges = this.device.createBuffer({ label: "gi refit levels", size: this.rangeBytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.refitGroups = null;
    }
    const stepWords = this.rangeStep / 4;
    const words = new Uint32Array(this.rangeBytes / 4);
    words[0] = this.posedTriangleCount;
    this.sceneRangeFirst = 1;
    this.sceneSpans.forEach(([first, count], index) => {
      words[(this.sceneRangeFirst + index) * stepWords] = first;
      words[(this.sceneRangeFirst + index) * stepWords + 1] = count;
    });
    this.meshRangeFirst = 1 + this.sceneSpans.length;
    this.meshSpans.forEach(([first, count], index) => {
      words[(this.meshRangeFirst + index) * stepWords] = first;
      words[(this.meshRangeFirst + index) * stepWords + 1] = count;
    });
    this.device.queue.writeBuffer(this.ranges, 0, words);
  }

  /**
   * Records this frame's work on the trees: posed triangles written from `vertices`, the posed meshes' trees fitted to
   * them, and the tree over the instances fitted to everything.
   */
  encodeRefit(encoder: GPUCommandEncoder, vertices: GrowableBuffer): void {
    const posed = this.posedTriangleCount > 0;
    if (!posed && !this.sceneStale) return;
    this.sceneStale = false;
    const groups = this.refitBindGroups(vertices);
    const pass = encoder.beginComputePass({ label: "gi trees" });
    if (posed) {
      pass.setPipeline(this.refitPipelines.pose);
      pass.setBindGroup(0, groups.pose, [0]);
      pass.dispatchWorkgroups(Math.ceil(this.posedTriangleCount / 64));
      pass.setPipeline(this.refitPipelines.mesh);
      for (let level = this.meshSpans.length - 1; level >= 0; level--) {
        pass.setBindGroup(0, groups.mesh, [(this.meshRangeFirst + level) * this.rangeStep]);
        pass.dispatchWorkgroups(Math.ceil(this.meshSpans[level][1] / 64));
      }
    }
    pass.setPipeline(this.refitPipelines.scene);
    for (let level = this.sceneSpans.length - 1; level >= 0; level--) {
      pass.setBindGroup(0, groups.scene, [(this.sceneRangeFirst + level) * this.rangeStep]);
      pass.dispatchWorkgroups(Math.ceil(this.sceneSpans[level][1] / 64));
    }
    pass.end();
  }

  private refitBindGroups(vertices: GrowableBuffer): NonNullable<GpuRayScene["refitGroups"]> {
    const key = [
      this.triangles.generation, this.meshNodes.generation, this.sceneNodes.generation, this.instanceBuffer.generation,
      this.posedTriangles.generation, this.sceneOrder.generation, this.meshOrder.generation, vertices.generation,
    ].join();
    if (this.refitGroups?.key === key) return this.refitGroups;
    const { device, ranges } = this;
    const range: GPUBindGroupEntry = { binding: 0, resource: { buffer: ranges, offset: 0, size: 16 } };
    const bind = (binding: number, buffer: GrowableBuffer): GPUBindGroupEntry => ({ binding, resource: { buffer: buffer.buffer } });
    this.refitGroups = {
      key,
      pose: device.createBindGroup({ label: "gi pose", layout: this.refitLayouts.pose, entries: [range, bind(1, this.posedTriangles), bind(2, vertices), bind(3, this.triangles)] }),
      mesh: device.createBindGroup({ label: "gi refit mesh", layout: this.refitLayouts.mesh, entries: [range, bind(1, this.meshOrder), bind(2, this.meshNodes), bind(3, this.triangles)] }),
      scene: device.createBindGroup({ label: "gi refit scene", layout: this.refitLayouts.scene, entries: [range, bind(1, this.sceneOrder), bind(2, this.sceneNodes), bind(3, this.instanceBuffer), bind(4, this.meshNodes)] }),
    };
    return this.refitGroups;
  }

  /** The five tables for raySceneWgsl: made again whenever one of them has been replaced. */
  bindGroup(): GPUBindGroup {
    const key = `${this.triangles.generation}/${this.meshNodes.generation}/${this.sceneNodes.generation}/${this.instanceBuffer.generation}/${this.materialBuffer.generation}`;
    if (this.tablesGroup?.key === key) return this.tablesGroup.group;
    const group = this.device.createBindGroup({
      label: "gi ray scene",
      layout: this.layout,
      entries: [this.triangles, this.meshNodes, this.sceneNodes, this.instanceBuffer, this.materialBuffer].map((table, binding) => ({ binding, resource: { buffer: table.buffer } })),
    });
    this.tablesGroup = { key, group };
    return group;
  }

  destroy(): void {
    for (const buffer of [this.triangles, this.meshNodes, this.sceneNodes, this.instanceBuffer, this.materialBuffer, this.posedTriangles, this.sceneOrder, this.meshOrder]) buffer.destroy();
    this.ranges.destroy();
  }
}
