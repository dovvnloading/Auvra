/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { RangeAllocator } from "../buffers";
import type { GpuCore } from "../device";
import type { GpuFrame, GpuPass, GpuRendererApi, GpuViewDrawer, GpuViewSpec } from "../frame";
import type { DrawGroup, GpuScene } from "../gpuScene";
import { INSTANCE_FLAG, INSTANCE_WORDS } from "../shaders";
import { STANDARD_SURFACE } from "../surfaces";
import type { GpuDepthOptions } from "./surfaces";
import type { VirtualShadowPass } from "./virtualShadows";

/**
 * SHADOW MAPS
 *
 * The sun draws into four cascades, each fitted to the sphere around one slice of the view: the sphere is the same size
 * however the camera turns and is moved in whole texels, so its shadows hold still while the camera moves. Casters
 * between the slice and the sun are kept by reaching back to the highest caster in the scene.
 *
 * Spot lights (one view) and point lights (six) share one atlas. Lights are taken nearest first, up to a fixed number
 * of views a frame, and each gets tiles sized by how bright it is and how much of the screen it can reach.
 *
 * Maps are drawn only when they would come out different. The two far cascades and every local view keep what they
 * drew until the light or the view changes, or a caster changed inside the view. What counts as changed is read from
 * the instance table itself (see CasterWatch), and anything that deforms without its row changing counts every frame.
 *
 * Publishes in frame.products:
 *   "shadowMaps": ShadowMapsProduct.
 *
 * The matrices take a world position to [uv.x, uv.y, depth, w], with y going down in uv and depth reversed (1 at the
 * light, 0 far away). Cascades have w of 1; atlas entries are perspective, so divide by w. A point is lit when its depth
 * is greater than the map's. A point light's six entries run +x, -x, +y, -y, +z, -z: take the face from the largest
 * axis of (point - light), `first + axis * 2 + (negative ? 1 : 0)`.
 *
 * Settings read from the renderer: "shadows.distance", "shadows.resolution", "shadows.look" (how far the camera is from
 * what it orbits, which the slices reach on by, 0 when it orbits nothing) and "shadows.virtual", which adds the
 * page-based sun shadows of virtualShadows.ts and hands the sun over to them whenever they are ready.
 */

export interface ShadowCascadesProduct {
  /** A 2d-array of depth32float. Always a valid view, even with a count of 0. */
  view: GPUTextureView;
  /** Comparison "greater", filtering. */
  sampler: GPUSampler;
  /** Four mat4: world to [uv.x, uv.y, depth, 1]. */
  matrices: Float32Array;
  /** How far along the view each cascade ends. */
  splits: Float32Array;
  /** 4, or 0 when no light casts or page-based shadows have taken the sun over. */
  count: number;
  /** Which of gpuScene.directional is the sun; -1 when none casts. */
  sunIndex: number;
  /** World units to move a point along its normal before looking it up, per cascade. */
  normalOffset: Float32Array;
  /** To add to a point's depth before comparing, per cascade. */
  bias: Float32Array;
}

export interface ShadowAtlasProduct {
  /** A 2d of depth32float. */
  view: GPUTextureView;
  /** Comparison "greater", filtering. */
  sampler: GPUSampler;
  /** One mat4 an entry: world to [uv.x, uv.y, depth, w] in the atlas. */
  entries: Float32Array;
  /** For each of gpuScene.local, its first entry or -1. */
  lightToEntry: Int32Array;
  count: number;
}

export interface ShadowMapsProduct {
  cascades: ShadowCascadesProduct;
  atlas: ShadowAtlasProduct | null;
}

export const CASCADE_COUNT = 4;
const DEFAULT_RESOLUTION = 2048;
const MIN_RESOLUTION = 256;
const DEFAULT_DISTANCE = 200;
/** Even a level that asks for no distance shadows still has the sharp shadows around the camera. */
const MIN_DISTANCE = 25;
/** How much of the split scheme is logarithmic rather than even: near cascades tight, far ones reaching the distance. */
const SPLIT_BLEND = 0.75;
/** Share of a slice by which it starts before the last one ended, so that lighting can blend across the join. */
const SLICE_OVERLAP = 0.1;
/** Cascades from here on may keep what they drew. */
const FIRST_KEPT_CASCADE = 2;
/** Room around a kept cascade's slice, so a camera moving a little does not have to draw it again. */
const KEPT_ROOM = 1.08;
/** How far above the highest caster a kept cascade reaches, so a caster lifting a little does not have to draw it again. */
const KEPT_HEADROOM = 4;
/** Squared. Levels move the sun's light about with the camera, which leaves rounding noise in its direction. */
export const SAME_DIRECTION = 1e-10;
/** In texels. */
const NORMAL_OFFSET_TEXELS = 1.5;
const BIAS_TEXELS = 1;

const ATLAS_SIZE = 4096;
export const MAX_LOCAL_VIEWS = 32;
const MIN_TILE = 128;
const MAX_TILE = 1024;
/** Share of the atlas that lights' tiles may ask for together, leaving room for tiles to come and go. */
const ATLAS_FILL = 0.8;
/** Texels past a point light's face at each edge: lookups near the edge filter into its own picture. */
const FACE_GUARD_TEXELS = 4;
/** Light this faint no longer shows, for sizing a light's reach. */
const FAINT = 0.02;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_FORWARD = new THREE.Vector3(0, 0, 1);

/** Depth is reversed, so pushing a caster away from the light takes a negative number. */
export const SHADOW_DEPTH_OPTIONS: GpuDepthOptions = { depthBiasSlopeScale: -1.5 };

type BiasedDrawer = GpuViewDrawer & {
  drawDepth(frame: GpuFrame, viewOffset: number, viewKey: string, pass: GPURenderPassEncoder, depthFormat: GPUTextureFormat, options?: GpuDepthOptions): void;
};

/** Draws what `cullView` chose for a shadow view, with the slope bias shadow maps use. */
export const drawShadowDepth = (frame: GpuFrame, viewOffset: number, viewKey: string, pass: GPURenderPassEncoder): void => {
  (frame.drawer as BiasedDrawer).drawDepth(frame, viewOffset, viewKey, pass, "depth32float", SHADOW_DEPTH_OPTIONS);
};

/** The renderer's named settings, as the frame carries them. */
export const shadowSettings = (frame: GpuFrame): ReadonlyMap<string, unknown> | null =>
  (frame.products.get("renderer") as GpuRendererApi | undefined)?.settings ?? null;

export const numberSetting = (settings: ReadonlyMap<string, unknown> | null, key: string, fallback: number): number => {
  const value = settings?.get(key);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

export const findSun = (scene: GpuScene): number => scene.directional.findIndex((light) => light.castShadow);

/** The axes of the plane a directional light's maps lie in, the same whatever the camera does. */
export interface LightPlane {
  toSun: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
}

export const makeLightPlane = (): LightPlane => ({ toSun: new THREE.Vector3(0, 1, 0), right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 0, -1) });

const _from = new THREE.Vector3();
const _to = new THREE.Vector3();

export const readLightPlane = (light: THREE.DirectionalLight, out: LightPlane): void => {
  _from.setFromMatrixPosition(light.matrixWorld);
  _to.setFromMatrixPosition(light.target.matrixWorld);
  out.toSun.subVectors(_from, _to);
  if (out.toSun.lengthSq() < 1e-12) out.toSun.set(0, 1, 0);
  out.toSun.normalize();
  out.right.crossVectors(Math.abs(out.toSun.y) > 0.999 ? WORLD_FORWARD : WORLD_UP, out.toSun).normalize();
  out.up.crossVectors(out.toSun, out.right);
};

/** World to the light's view, looking from `eye` along -toSun: no inversion, so nothing drifts. */
export const writeLightView = (out: THREE.Matrix4, plane: LightPlane, eye: THREE.Vector3): void => {
  const { right: r, up: u, toSun: t } = plane;
  out.set(
    r.x, r.y, r.z, -r.dot(eye),
    u.x, u.y, u.z, -u.dot(eye),
    t.x, t.y, t.z, -t.dot(eye),
    0, 0, 0, 1,
  );
};

const _clip = new THREE.Matrix4();

/** A view's world to map matrix: x and y from clip to uv within a square `scale` of the map at the offset, depth reversed. */
const writeShadowMatrix = (out: Float32Array, at: number, projection: THREE.Matrix4, viewInverse: THREE.Matrix4, scale: number, offsetX: number, offsetY: number): void => {
  _clip.multiplyMatrices(projection, viewInverse);
  const e = _clip.elements;
  for (let column = 0; column < 4; column++) {
    const x = e[column * 4];
    const y = e[column * 4 + 1];
    const z = e[column * 4 + 2];
    const w = e[column * 4 + 3];
    out[at + column * 4] = (0.5 * x + 0.5 * w) * scale + offsetX * w;
    out[at + column * 4 + 1] = (-0.5 * y + 0.5 * w) * scale + offsetY * w;
    out[at + column * 4 + 2] = -0.5 * z + 0.5 * w;
    out[at + column * 4 + 3] = w;
  }
};

export const DEPTH_CLEAR_WGSL = /* wgsl */ `
@vertex fn clearVertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let corner = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** Clears the viewport's part of a depth32float map to far, for a pass that has to keep the rest of it. */
export class DepthTileClearer {
  private readonly pipeline: GPURenderPipeline;

  constructor(device: GPUDevice) {
    this.pipeline = device.createRenderPipeline({
      label: "gpu shadow tile clear",
      layout: "auto",
      vertex: { module: device.createShaderModule({ label: "gpu shadow tile clear", code: DEPTH_CLEAR_WGSL }), entryPoint: "clearVertex" },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" },
    });
  }

  clear(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.pipeline);
    pass.draw(3);
  }
}

/** What has changed for one reader since it last looked. */
export interface CasterChanges {
  /** Centre and radius of each place something changed, before and after. */
  spheres: Float32Array;
  count: number;
  /** Too much changed to list, or a change that is not about one place. */
  everything: boolean;
}

export interface CasterExtents {
  /** How far toward the sun the highest caster reaches; -Infinity with no casters. */
  top: number;
  /** How far from the sun anything that casts or receives reaches; Infinity with nothing. */
  bottom: number;
}

const MAX_CHANGES = 256;
/** A row's words kept to compare: world 12, sphere 4, flags, layers, what it draws. */
const SNAPSHOT_WORDS = 19;
const SNAPSHOT_SPHERE = 12;
const SNAPSHOT_FLAGS = 16;
const SNAPSHOT_LAYERS = 17;
const SNAPSHOT_DRAWS = 18;
const ROW_SPHERE = 24;
const ROW_GROUP = 32;
const ROW_FLAGS = 33;
const ROW_LAYERS = 34;
/** A row that deforms can reach past the sphere of its rest pose. */
const LIVE_REACH = 2;
const CASTER = INSTANCE_FLAG.active | INSTANCE_FLAG.castsShadow;
const CASTS_OR_RECEIVES = INSTANCE_FLAG.castsShadow | INSTANCE_FLAG.receivesShadow;

const mix = (hash: number, value: number): number => (Math.imul(hash, 31) + (value | 0)) | 0;
const fixed = (value: number): number => Math.round(value * 4096);

/** Whether a group's depth can change with nothing in its rows changing. */
const isLive = ({ geometry, material }: DrawGroup): boolean =>
  geometry.skinCount > 0 || geometry.morphTargets > 0 || !!material.kind.displaces
  // Holes come from the surface's code, and only the standard surface's are known to depend on nothing but its numbers.
  || (material.state.masked && material.kind !== STANDARD_SURFACE);

/** Everything about a group that shapes its depth, apart from where its rows are. */
const groupShadowKey = ({ geometry, material }: DrawGroup): number => {
  const { state } = material;
  const source = material.material;
  let key = mix(0, geometry.version);
  key = mix(key, state.cull === "none" ? 0 : state.cull === "back" ? 1 : 2);
  key = mix(key, source.shadowSide ?? -1);
  key = mix(key, state.transparent ? 1 : 0);
  key = mix(key, fixed(state.depthBias));
  key = mix(key, fixed(state.depthBiasSlope));
  if (state.masked) {
    key = mix(key, material.revision);
    key = mix(key, fixed(source.alphaTest));
    key = mix(key, fixed(source.opacity));
    const map = (source as THREE.MeshStandardMaterial).map;
    if (map) {
      key = mix(key, fixed(map.offset.x));
      key = mix(key, fixed(map.offset.y));
      key = mix(key, fixed(map.repeat.x));
      key = mix(key, fixed(map.repeat.y));
      key = mix(key, fixed(map.rotation));
    }
  }
  return key;
};

/**
 * Finds what changed for shadows by comparing the instance table with a copy of it: a row that differs in any way from
 * what was last seen, wherever that came from, and rows of groups that deform without their rows changing. A pipeline
 * that finished compiling counts as everything, since a map drawn before it is missing what it draws.
 */
export class CasterWatch {
  /** Goes up whenever a caster's row changed. */
  revision = 0;
  private readonly readers = new Set<CasterChanges>();
  private words = new Uint32Array(0);
  private floats = new Float32Array(0);
  private live = new Uint8Array(64);
  private draws = new Int32Array(64);
  private readonly groupKeys = new WeakMap<DrawGroup, number>();
  private seenFrame = -1;
  private pipelines = -1;
  private readonly extent: CasterExtents = { top: -Infinity, bottom: Infinity };
  private extentRevision = -1;
  private readonly extentDirection = new THREE.Vector3();

  constructor(private readonly scene: GpuScene) {}

  /** A reader's list of changes, which it empties as it reads. It starts with everything changed. */
  subscribe(): CasterChanges {
    const changes: CasterChanges = { spheres: new Float32Array(MAX_CHANGES * 4), count: 0, everything: true };
    this.readers.add(changes);
    return changes;
  }

  unsubscribe(changes: CasterChanges): void {
    this.readers.delete(changes);
  }

  /** Brings the readers up to date with this frame's table. Later calls in the same frame do nothing. */
  update(frame: GpuFrame): void {
    if (this.seenFrame === frame.frameNumber) return;
    this.seenFrame = frame.frameNumber;
    // Not part of the frame contract: without it no map can be known to be whole, so everything is drawn every frame.
    const pipelines = (frame.drawer as unknown as { pipelineRevision?: number } | null)?.pipelineRevision;
    if (pipelines === undefined || pipelines !== this.pipelines) this.changeEverything();
    this.pipelines = pipelines ?? -1;
    this.readGroups();
    this.readRows();
  }

  /** How far casters and receivers reach along a direction. */
  extents(toSun: THREE.Vector3): CasterExtents {
    if (this.extentRevision === this.revision && this.extentDirection.distanceToSquared(toSun) < SAME_DIRECTION) return this.extent;
    this.extentRevision = this.revision;
    this.extentDirection.copy(toSun);
    let top = -Infinity;
    let bottom = Infinity;
    const { x, y, z } = toSun;
    const { data, uints } = this.scene.instances;
    const rows = this.scene.instanceCount;
    for (let row = 0; row < rows; row++) {
      const at = row * INSTANCE_WORDS;
      const flags = uints[at + ROW_FLAGS];
      if ((flags & INSTANCE_FLAG.active) === 0 || (flags & CASTS_OR_RECEIVES) === 0) continue;
      const along = data[at + ROW_SPHERE] * x + data[at + ROW_SPHERE + 1] * y + data[at + ROW_SPHERE + 2] * z;
      const radius = data[at + ROW_SPHERE + 3];
      if (along - radius < bottom) bottom = along - radius;
      if ((flags & INSTANCE_FLAG.castsShadow) !== 0 && along + radius > top) top = along + radius;
    }
    this.extent.top = top;
    this.extent.bottom = bottom;
    return this.extent;
  }

  private changeEverything(): void {
    for (const reader of this.readers) reader.everything = true;
  }

  private addChange(x: number, y: number, z: number, radius: number): void {
    for (const reader of this.readers) {
      if (reader.count >= MAX_CHANGES) {
        reader.everything = true;
        continue;
      }
      const at = reader.count++ * 4;
      reader.spheres[at] = x;
      reader.spheres[at + 1] = y;
      reader.spheres[at + 2] = z;
      reader.spheres[at + 3] = radius;
    }
  }

  private readGroups(): void {
    const groups = this.scene.groupList;
    if (groups.length > this.live.length) {
      this.live = new Uint8Array(groups.length * 2);
      this.draws = new Int32Array(groups.length * 2);
    }
    for (let id = 0; id < groups.length; id++) {
      const group = groups[id];
      const key = groupShadowKey(group);
      const known = this.groupKeys.get(group);
      if (known !== undefined && known !== key) this.changeEverything();
      this.groupKeys.set(group, key);
      this.live[id] = isLive(group) ? 1 : 0;
      this.draws[id] = mix(group.geometry.geometry.id, group.material.slot);
    }
  }

  private readRows(): void {
    const rows = this.scene.instanceCount;
    if (rows * SNAPSHOT_WORDS > this.words.length) {
      const next = new Uint32Array(Math.ceil(rows * 1.5) * SNAPSHOT_WORDS);
      next.set(this.words);
      this.words = next;
      this.floats = new Float32Array(next.buffer);
    }
    const { data, uints } = this.scene.instances;
    const { words, floats, live, draws } = this;
    for (let row = 0; row < rows; row++) {
      const at = row * INSTANCE_WORDS;
      const to = row * SNAPSHOT_WORDS;
      const flags = uints[at + ROW_FLAGS] & ~INSTANCE_FLAG.moved;
      const was = words[to + SNAPSHOT_FLAGS];
      const casts = (flags & CASTER) === CASTER;
      const cast = (was & CASTER) === CASTER;
      if (!casts && !cast) {
        words[to + SNAPSHOT_FLAGS] = flags;
        continue;
      }
      const group = uints[at + ROW_GROUP];
      const drew = draws[group] >>> 0;
      let changed = flags !== was || uints[at + ROW_LAYERS] !== words[to + SNAPSHOT_LAYERS] || drew !== words[to + SNAPSHOT_DRAWS];
      for (let word = 0; !changed && word < 12; word++) changed = uints[at + word] !== words[to + word];
      for (let word = 0; !changed && word < 4; word++) changed = uints[at + ROW_SPHERE + word] !== words[to + SNAPSHOT_SPHERE + word];
      const deforms = live[group] === 1 || (flags & INSTANCE_FLAG.posed) !== 0;
      if (!changed && !(deforms && casts)) continue;
      const reach = deforms ? LIVE_REACH : 1;
      if (changed && cast) this.addChange(floats[to + SNAPSHOT_SPHERE], floats[to + SNAPSHOT_SPHERE + 1], floats[to + SNAPSHOT_SPHERE + 2], floats[to + SNAPSHOT_SPHERE + 3] * reach);
      if (casts) this.addChange(data[at + ROW_SPHERE], data[at + ROW_SPHERE + 1], data[at + ROW_SPHERE + 2], data[at + ROW_SPHERE + 3] * reach);
      if (!changed) continue;
      for (let word = 0; word < 12; word++) words[to + word] = uints[at + word];
      for (let word = 0; word < 4; word++) words[to + SNAPSHOT_SPHERE + word] = uints[at + ROW_SPHERE + word];
      words[to + SNAPSHOT_FLAGS] = flags;
      words[to + SNAPSHOT_LAYERS] = uints[at + ROW_LAYERS];
      words[to + SNAPSHOT_DRAWS] = drew;
      this.revision++;
    }
  }
}

const watches = new WeakMap<GpuScene, CasterWatch>();

/** The one watch over a scene: however many passes read it, the table is compared once a frame. */
export const casterWatchFor = (scene: GpuScene): CasterWatch => {
  let watch = watches.get(scene);
  if (!watch) {
    watch = new CasterWatch(scene);
    watches.set(scene, watch);
  }
  return watch;
};

const _changeSphere = new THREE.Sphere();

const changesTouch = (changes: CasterChanges, frustum: THREE.Frustum): boolean => {
  const { spheres, count } = changes;
  for (let index = 0; index < count; index++) {
    const at = index * 4;
    _changeSphere.center.set(spheres[at], spheres[at + 1], spheres[at + 2]);
    _changeSphere.radius = spheres[at + 3];
    if (frustum.intersectsSphere(_changeSphere)) return true;
  }
  return false;
};

interface AtlasTile {
  x: number;
  y: number;
  size: number;
  shelf: Shelf;
}

interface Shelf {
  y: number;
  height: number;
  capacity: number;
  /** Where on the shelf a tile is free. */
  free: number[];
}

/** Square tiles of a power-of-two size on shelves as tall as they are. A shelf with nothing on it goes back for any size. */
export class ShelfAtlas {
  private rows = new RangeAllocator();
  private shelves = new Map<number, Shelf[]>();

  constructor(readonly size: number) {}

  allocate(size: number): AtlasTile | null {
    let list = this.shelves.get(size);
    if (!list) {
      list = [];
      this.shelves.set(size, list);
    }
    for (const shelf of list) {
      const x = shelf.free.pop();
      if (x !== undefined) return { x, y: shelf.y, size, shelf };
    }
    const y = this.rows.allocate(size);
    if (y + size > this.size) {
      this.rows.release(y, size);
      return null;
    }
    const capacity = Math.floor(this.size / size);
    const shelf: Shelf = { y, height: size, capacity, free: [] };
    for (let index = capacity - 1; index >= 0; index--) shelf.free.push(index * size);
    list.push(shelf);
    return { x: shelf.free.pop()!, y, size, shelf };
  }

  release(tile: AtlasTile): void {
    const { shelf } = tile;
    shelf.free.push(tile.x);
    if (shelf.free.length < shelf.capacity) return;
    const list = this.shelves.get(shelf.height);
    const at = list ? list.indexOf(shelf) : -1;
    if (at < 0) return;
    list!.splice(at, 1);
    this.rows.release(shelf.y, shelf.height);
  }

  reset(): void {
    this.rows = new RangeAllocator();
    this.shelves = new Map();
  }
}

interface CascadeState {
  key: string;
  projection: THREE.Matrix4;
  viewInverse: THREE.Matrix4;
  eye: THREE.Vector3;
  frustum: THREE.Frustum;
  /** The sphere the map holds: moved onto the texel grid, with any room. */
  centre: THREE.Vector3;
  radius: number;
  top: number;
  start: number;
  end: number;
  resolution: number;
  layers: number;
  light: THREE.DirectionalLight | null;
  toSun: THREE.Vector3;
  drawn: boolean;
}

interface LocalView {
  slot: number;
  tile: AtlasTile | null;
  projection: THREE.Matrix4;
  viewInverse: THREE.Matrix4;
  eye: THREE.Vector3;
  frustum: THREE.Frustum;
  matrix: Float32Array;
  drawn: boolean;
}

type LocalLight = THREE.PointLight | THREE.SpotLight;

interface LocalRecord {
  light: LocalLight;
  index: number;
  distance: number;
  range: number;
  /** The size wanted this frame and the size its tiles are. */
  wanted: number;
  size: number;
  views: LocalView[];
  signature: Float64Array;
  seen: number;
}

const SIGNATURE_WORDS = 12;
const LOCAL_KEYS = Array.from({ length: MAX_LOCAL_VIEWS }, (_, slot) => `shadow local ${slot}`);
const FACE_DIRECTIONS = [
  new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
];
const FACE_UPS = [
  WORLD_UP, WORLD_UP,
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
  WORLD_UP, WORLD_UP,
];

const NDC_CORNERS: ReadonlyArray<readonly [number, number]> = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
const _slice = Array.from({ length: 8 }, () => new THREE.Vector3());
const _rayNear = new THREE.Vector3();
const _rayFar = new THREE.Vector3();
const _sliceNear = new THREE.Vector3();
const _sliceFar = new THREE.Vector3();

/** How far along the view the camera's own near or far plane is. */
const planeDepth = (camera: THREE.Camera, ndcZ: number): number => -_rayNear.set(0, 0, ndcZ).applyMatrix4(camera.projectionMatrixInverse).z;

/**
 * The tightest sphere with its centre between the middles of the slice's two ends, around the view from `start` to
 * `end`. Worked out in view space and rounded up, so it has exactly the same radius however the camera moves or turns.
 */
const sliceSphere = (camera: THREE.Camera, start: number, end: number, out: THREE.Vector3): number => {
  _sliceNear.set(0, 0, 0);
  _sliceFar.set(0, 0, 0);
  NDC_CORNERS.forEach(([x, y], index) => {
    _rayNear.set(x, y, -1).applyMatrix4(camera.projectionMatrixInverse);
    _rayFar.set(x, y, 1).applyMatrix4(camera.projectionMatrixInverse);
    const depthNear = -_rayNear.z;
    const span = -_rayFar.z - depthNear;
    _slice[index].lerpVectors(_rayNear, _rayFar, span > 0 ? (start - depthNear) / span : 0);
    _slice[index + 4].lerpVectors(_rayNear, _rayFar, span > 0 ? (end - depthNear) / span : 1);
    _sliceNear.add(_slice[index]);
    _sliceFar.add(_slice[index + 4]);
  });
  _sliceNear.multiplyScalar(0.25);
  _sliceFar.multiplyScalar(0.25);
  let nearSquared = 0;
  let farSquared = 0;
  for (let index = 0; index < 4; index++) {
    nearSquared = Math.max(nearSquared, _slice[index].distanceToSquared(_sliceNear));
    farSquared = Math.max(farSquared, _slice[index + 4].distanceToSquared(_sliceFar));
  }
  const lengthSquared = _sliceNear.distanceToSquared(_sliceFar);
  const along = lengthSquared > 0 ? THREE.MathUtils.clamp((lengthSquared + farSquared - nearSquared) / (2 * lengthSquared), 0, 1) : 0.5;
  out.lerpVectors(_sliceNear, _sliceFar, along);
  let radius = 0;
  for (const corner of _slice) radius = Math.max(radius, corner.distanceTo(out));
  out.applyMatrix4(camera.matrixWorld);
  return Math.ceil(radius * 1.01 * 1024) / 1024;
};

/** The practical split scheme: where each cascade ends along the view. */
const writeSplits = (out: Float32Array, near: number, far: number): void => {
  for (let index = 1; index <= CASCADE_COUNT; index++) {
    const t = index / CASCADE_COUNT;
    const even = near + (far - near) * t;
    const log = near * (far / near) ** t;
    out[index - 1] = SPLIT_BLEND * log + (1 - SPLIT_BLEND) * even;
  }
};

const _plane = makeLightPlane();
const _centre = new THREE.Vector3();
const _cameraEye = new THREE.Vector3();
const _position = new THREE.Vector3();
const _target = new THREE.Vector3();
const _lookAt = new THREE.Matrix4();
const _cameraClip = new THREE.Matrix4();
const _cameraFrustum = new THREE.Frustum();
const _reachSphere = new THREE.Sphere();
const _dummyMatrix = new THREE.Matrix4();
const _dummyEye = new THREE.Vector3();

const rangeOf = (light: LocalLight): number => {
  const camera = light.shadow.camera;
  return Math.max(light.distance || camera.far, camera.near + 0.01);
};

const isSpot = (light: LocalLight): light is THREE.SpotLight => !!(light as THREE.SpotLight).isSpotLight;

/** What a light's tile should measure: what it can reach on the screen, weighted by how bright it is. */
const wantedTexels = (light: LocalLight, distance: number, range: number, focal: number, perspective: boolean): number => {
  const reach = Math.min(range, Math.sqrt(Math.max(light.intensity, 0) / FAINT));
  const across = perspective ? (focal * reach) / Math.max(distance, reach, 1e-3) : focal * reach;
  const brightness = THREE.MathUtils.clamp(0.4 + 0.12 * Math.log2(1 + light.intensity), 0.4, 1.25);
  // A face sees a quarter of what is around the light.
  return across * brightness * (isSpot(light) ? 1 : 0.5);
};

const powerOfTwoTile = (texels: number): number =>
  THREE.MathUtils.clamp(2 ** Math.round(Math.log2(Math.max(texels, 1))), MIN_TILE, MAX_TILE);

export class ShadowPass implements GpuPass {
  readonly id = "shadows";
  readonly stage = "shadow" as const;
  readonly order = 0;

  private readonly device: GPUDevice;
  private readonly sampler: GPUSampler;
  private cascadeTexture: GPUTexture;
  private cascadeLayers: GPUTextureView[] = [];
  private cascadeResolution = 0;
  private readonly cascadeStates: CascadeState[] = [];
  private readonly product: ShadowMapsProduct;

  private atlasTexture: GPUTexture | null = null;
  private atlasView: GPUTextureView | null = null;
  private clearer: DepthTileClearer | null = null;
  private readonly shelves = new ShelfAtlas(ATLAS_SIZE);
  private readonly records = new Map<LocalLight, LocalRecord>();
  private readonly candidates: { light: LocalLight; index: number; range: number; distance: number }[] = [];
  private readonly picked: LocalRecord[] = [];
  private readonly slots: (LocalView | null)[] = new Array<LocalView | null>(MAX_LOCAL_VIEWS).fill(null);
  private readonly slotOffsets = new Array<number>(MAX_LOCAL_VIEWS).fill(0);
  private readonly redraw: LocalView[] = [];
  private readonly entries = new Float32Array(MAX_LOCAL_VIEWS * 16);
  private lightToEntry = new Int32Array(16);
  private readonly atlasProduct: { view: GPUTextureView | null; sampler: GPUSampler; entries: Float32Array; lightToEntry: Int32Array; count: number };
  private readonly signature = new Float64Array(SIGNATURE_WORDS);

  private watch: CasterWatch | null = null;
  private changes: CasterChanges | null = null;
  private virtual: VirtualShadowPass | null = null;
  private virtualLoading = false;
  private disposed = false;

  constructor(private readonly core: GpuCore) {
    const { device } = core;
    this.device = device;
    this.sampler = device.createSampler({
      label: "gpu shadow compare",
      compare: "greater",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    // Lighting always has something to bind; the real one is made when a light first casts.
    this.cascadeTexture = this.makeCascades(1);
    for (let index = 0; index < CASCADE_COUNT; index++) {
      this.cascadeStates.push({
        key: `shadow cascade ${index}`,
        projection: new THREE.Matrix4(),
        viewInverse: new THREE.Matrix4(),
        eye: new THREE.Vector3(),
        frustum: new THREE.Frustum(),
        centre: new THREE.Vector3(),
        radius: 0,
        top: 0,
        start: 0,
        end: 0,
        resolution: 0,
        layers: 0,
        light: null,
        toSun: new THREE.Vector3(),
        drawn: false,
      });
    }
    this.product = {
      cascades: {
        view: this.cascadeTexture.createView({ label: "gpu shadow cascades", dimension: "2d-array" }),
        sampler: this.sampler,
        matrices: new Float32Array(CASCADE_COUNT * 16),
        splits: new Float32Array(CASCADE_COUNT),
        count: 0,
        sunIndex: -1,
        normalOffset: new Float32Array(CASCADE_COUNT),
        bias: new Float32Array(CASCADE_COUNT),
      },
      atlas: null,
    };
    this.atlasProduct = { view: null, sampler: this.sampler, entries: this.entries, lightToEntry: this.lightToEntry, count: 0 };
  }

  execute(frame: GpuFrame): void {
    this.syncVirtual(frame);
    const changes = this.readChanges(frame);
    this.drawCascades(frame, changes);
    this.product.atlas = this.drawLocal(frame, changes);
    changes.count = 0;
    changes.everything = false;
    frame.products.set("shadowMaps", this.product);
  }

  dispose(): void {
    this.disposed = true;
    this.cascadeTexture.destroy();
    this.atlasTexture?.destroy();
    if (this.watch && this.changes) this.watch.unsubscribe(this.changes);
  }

  /** The page-based pass is loaded and added the first time it is asked for; from then on it answers the setting itself. */
  private syncVirtual(frame: GpuFrame): void {
    if (this.virtual || this.virtualLoading) return;
    const renderer = frame.products.get("renderer") as GpuRendererApi | undefined;
    if (!renderer?.settings.get("shadows.virtual")) return;
    this.virtualLoading = true;
    void import("./virtualShadows").then(({ VirtualShadowPass }) => {
      this.virtualLoading = false;
      if (this.disposed) return;
      this.virtual = new VirtualShadowPass(this.core);
      renderer.addPass(this.virtual);
    }).catch((error: unknown) => {
      console.error("[gpu] page-based shadows failed to load", error);
    });
  }

  private readChanges(frame: GpuFrame): CasterChanges {
    const watch = casterWatchFor(frame.gpuScene);
    if (watch !== this.watch || !this.changes) {
      if (this.watch && this.changes) this.watch.unsubscribe(this.changes);
      this.watch = watch;
      this.changes = watch.subscribe();
    }
    watch.update(frame);
    return this.changes;
  }

  private makeCascades(resolution: number): GPUTexture {
    const texture = this.device.createTexture({
      label: "gpu shadow cascades",
      size: [resolution, resolution, CASCADE_COUNT],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.cascadeLayers = Array.from({ length: CASCADE_COUNT }, (_, baseArrayLayer) => texture.createView({
      label: `gpu shadow cascade ${baseArrayLayer}`,
      dimension: "2d",
      baseArrayLayer,
      arrayLayerCount: 1,
    }));
    this.cascadeResolution = resolution;
    return texture;
  }

  private ensureCascades(resolution: number): void {
    if (resolution === this.cascadeResolution) return;
    this.cascadeTexture.destroy();
    this.cascadeTexture = this.makeCascades(resolution);
    this.product.cascades.view = this.cascadeTexture.createView({ label: "gpu shadow cascades", dimension: "2d-array" });
    for (const state of this.cascadeStates) state.drawn = false;
  }

  private drawCascades(frame: GpuFrame, changes: CasterChanges): void {
    const { cascades } = this.product;
    const { gpuScene, camera, drawer } = frame;
    const sunIndex = findSun(gpuScene);
    cascades.sunIndex = sunIndex;
    cascades.count = 0;
    if (sunIndex < 0 || !drawer || !this.watch) {
      this.forgetCascades();
      return;
    }

    const sun = gpuScene.directional[sunIndex];
    readLightPlane(sun, _plane);
    // Page-based shadows that are ready for this frame's sun carry it: nothing to draw here.
    if (this.virtual?.readyFor(frame, _plane.toSun)) {
      this.forgetCascades();
      return;
    }

    const settings = shadowSettings(frame);
    const limit = Math.min(frame.device.limits.maxTextureDimension2D, 8192);
    const resolution = THREE.MathUtils.clamp(Math.round(numberSetting(settings, "shadows.resolution", DEFAULT_RESOLUTION)), MIN_RESOLUTION, limit);
    this.ensureCascades(resolution);

    // A camera that orbits something counts on from it, as distance shadows always have.
    const distance = Math.max(numberSetting(settings, "shadows.distance", DEFAULT_DISTANCE), MIN_DISTANCE) + Math.max(0, numberSetting(settings, "shadows.look", 0));
    const near = Math.max(planeDepth(camera, -1), 1e-3);
    const far = Math.max(Math.min(distance, planeDepth(camera, 1)), near * 1.01);
    writeSplits(cascades.splits, near, far);

    const layers = camera.layers.mask;
    const extents = this.watch.extents(_plane.toSun);
    const normalBias = sun.shadow?.normalBias ?? 0;

    for (let index = 0; index < CASCADE_COUNT; index++) {
      const state = this.cascadeStates[index];
      const start = index === 0 ? near : cascades.splits[index - 1] * (1 - SLICE_OVERLAP);
      const end = cascades.splits[index];
      const needed = sliceSphere(camera, start, end, _centre);
      const mayKeep = index >= FIRST_KEPT_CASCADE;
      const keep = mayKeep
        && state.drawn
        && !changes.everything
        && state.light === sun
        && state.resolution === resolution
        && state.layers === layers
        && state.start === start
        && state.end === end
        && state.toSun.distanceToSquared(_plane.toSun) < SAME_DIRECTION
        && _centre.distanceTo(state.centre) + needed <= state.radius
        && extents.top <= state.top
        && !changesTouch(changes, state.frustum);
      if (!keep) this.fitCascade(state, sun, index, start, end, needed, mayKeep, resolution, layers, extents.top, normalBias);

      // Written every frame, in the same place: a recorded draw holds its view's offset.
      const offset = frame.writeView(this.cascadeSpec(state, resolution, layers));
      if (keep) continue;
      drawer.cullView(frame, offset, state.key);
      const pass = frame.encoder.beginRenderPass({
        label: state.key,
        colorAttachments: [],
        depthStencilAttachment: { view: this.cascadeLayers[index], depthClearValue: 0, depthLoadOp: "clear", depthStoreOp: "store" },
      });
      drawShadowDepth(frame, offset, state.key, pass);
      pass.end();
      state.drawn = true;
    }
    cascades.count = CASCADE_COUNT;
  }

  /** Changes are only followed while a cascade is in use: one that went unused may no longer be right. */
  private forgetCascades(): void {
    for (const state of this.cascadeStates) state.drawn = false;
  }

  private cascadeSpec(state: CascadeState, resolution: number, layers: number): GpuViewSpec {
    return { projection: state.projection, matrixWorldInverse: state.viewInverse, eye: state.eye, width: resolution, height: resolution, layers, kind: 1, orthographic: true };
  }

  /** Points a cascade at `_centre` from the sun: its centre on the texel grid, its near side past every caster. */
  private fitCascade(state: CascadeState, sun: THREE.DirectionalLight, index: number, start: number, end: number, needed: number, mayKeep: boolean, resolution: number, layers: number, casterTop: number, normalBias: number): void {
    const { cascades } = this.product;
    const { right, up, toSun } = _plane;
    const radius = mayKeep ? needed * KEPT_ROOM : needed;
    const texel = (2 * radius) / resolution;
    const across = Math.round(_centre.dot(right) / texel) * texel;
    const along = Math.round(_centre.dot(up) / texel) * texel;
    const depth = _centre.dot(toSun);
    state.centre.copy(right).multiplyScalar(across).addScaledVector(up, along).addScaledVector(toSun, depth);
    const top = Math.max(depth + radius, casterTop + (mayKeep ? KEPT_HEADROOM : 0));
    const range = top - (depth - radius);
    state.eye.copy(state.centre).addScaledVector(toSun, top + 1 - depth);
    writeLightView(state.viewInverse, _plane, state.eye);
    state.projection.makeOrthographic(-radius, radius, radius, -radius, 1, 1 + range);
    _clip.multiplyMatrices(state.projection, state.viewInverse);
    state.frustum.setFromProjectionMatrix(_clip);
    state.radius = radius;
    state.top = top;
    state.start = start;
    state.end = end;
    state.resolution = resolution;
    state.layers = layers;
    state.light = sun;
    state.toSun.copy(toSun);
    writeShadowMatrix(cascades.matrices, index * 16, state.projection, state.viewInverse, 1, 0, 0);
    cascades.normalOffset[index] = Math.max(texel * NORMAL_OFFSET_TEXELS, normalBias);
    cascades.bias[index] = (texel * BIAS_TEXELS) / range;
  }

  private drawLocal(frame: GpuFrame, changes: CasterChanges): ShadowAtlasProduct | null {
    const { drawer, gpuScene } = frame;
    if (!drawer) return null;
    this.pickLights(frame);
    this.fitToAtlas();
    this.placeTiles(frame.frameNumber);
    if (!this.picked.length) return null;

    this.ensureAtlas();
    const layers = frame.camera.layers.mask;
    this.redraw.length = 0;
    let highestSlot = -1;
    for (const record of this.picked) {
      this.refreshRecord(record, layers, changes);
      for (const view of record.views) {
        if (!view.tile) continue;
        highestSlot = Math.max(highestSlot, view.slot);
        if (!view.drawn) this.redraw.push(view);
      }
    }

    // Every slot's view is written every frame, in order: a recorded draw holds its view's offset.
    for (let slot = 0; slot <= highestSlot; slot++) {
      const view = this.slots[slot];
      this.slotOffsets[slot] = frame.writeView(view?.tile
        ? { projection: view.projection, matrixWorldInverse: view.viewInverse, eye: view.eye, width: view.tile.size, height: view.tile.size, layers, kind: 1, orthographic: false }
        : { projection: _dummyMatrix, matrixWorldInverse: _dummyMatrix, eye: _dummyEye, width: 1, height: 1, layers: 0, kind: 1, orthographic: false });
    }
    if (this.redraw.length) this.drawViews(frame);
    return this.publishAtlas(gpuScene);
  }

  /** The lights that may touch the screen, nearest first, as many as there are views for. */
  private pickLights(frame: GpuFrame): void {
    const { camera, gpuScene, targets } = frame;
    _cameraClip.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _cameraFrustum.setFromProjectionMatrix(_cameraClip);
    _cameraEye.setFromMatrixPosition(camera.matrixWorld);
    const elements = camera.projectionMatrix.elements;
    const focal = (elements[5] * targets.height) / 2;
    const perspective = elements[15] === 0;

    const { candidates, picked } = this;
    candidates.length = 0;
    picked.length = 0;
    gpuScene.local.forEach((light, index) => {
      if (!light.castShadow) return;
      _position.setFromMatrixPosition(light.matrixWorld);
      const range = rangeOf(light);
      _reachSphere.center.copy(_position);
      _reachSphere.radius = range;
      if (_cameraFrustum.intersectsSphere(_reachSphere)) candidates.push({ light, index, range, distance: _position.distanceTo(_cameraEye) });
    });
    candidates.sort((a, b) => a.distance - b.distance);

    let views = 0;
    for (const { light, index, range, distance } of candidates) {
      const needs = isSpot(light) ? 1 : 6;
      if (views + needs > MAX_LOCAL_VIEWS) continue;
      views += needs;
      const record = this.records.get(light) ?? this.makeRecord(light, needs);
      record.index = index;
      record.range = range;
      record.distance = distance;
      const texels = wantedTexels(light, distance, range, focal, perspective);
      // Close to its present size it stays that size, so that a light moving about does not keep being drawn again.
      record.wanted = record.size && texels < record.size * 1.5 && texels > record.size * 0.6 ? record.size : powerOfTwoTile(texels);
      record.seen = frame.frameNumber;
      picked.push(record);
    }
  }

  private makeRecord(light: LocalLight, views: number): LocalRecord {
    const record: LocalRecord = {
      light,
      index: 0,
      distance: 0,
      range: 0,
      wanted: 0,
      size: 0,
      views: Array.from({ length: views }, () => ({
        slot: -1,
        tile: null,
        projection: new THREE.Matrix4(),
        viewInverse: new THREE.Matrix4(),
        eye: new THREE.Vector3(),
        frustum: new THREE.Frustum(),
        matrix: new Float32Array(16),
        drawn: false,
      })),
      signature: new Float64Array(SIGNATURE_WORDS).fill(NaN),
      seen: -1,
    };
    this.records.set(light, record);
    return record;
  }

  /** Takes sizes down, farthest lights first, until what is asked for fits. */
  private fitToAtlas(): void {
    const { picked } = this;
    const room = ATLAS_SIZE * ATLAS_SIZE * ATLAS_FILL;
    let area = 0;
    for (const record of picked) area += record.views.length * record.wanted * record.wanted;
    while (area > room) {
      let shrunk = false;
      for (let index = picked.length - 1; index >= 0 && area > room; index--) {
        const record = picked[index];
        if (record.wanted <= MIN_TILE) continue;
        area -= record.views.length * record.wanted * record.wanted * 0.75;
        record.wanted /= 2;
        shrunk = true;
      }
      if (!shrunk) return;
    }
  }

  private releaseTiles(record: LocalRecord): void {
    for (const view of record.views) {
      if (view.tile) this.shelves.release(view.tile);
      view.tile = null;
      view.drawn = false;
    }
  }

  private releaseSlots(record: LocalRecord): void {
    for (const view of record.views) {
      if (view.slot >= 0) this.slots[view.slot] = null;
      view.slot = -1;
    }
  }

  /** Lights that dropped out give their tiles back; the rest keep theirs unless their size changed. */
  private placeTiles(frameNumber: number): void {
    for (const [light, record] of this.records) {
      if (record.seen === frameNumber) continue;
      this.releaseTiles(record);
      this.releaseSlots(record);
      this.records.delete(light);
    }
    for (const record of this.picked) {
      if (record.size !== record.wanted) this.releaseTiles(record);
      record.size = record.wanted;
    }
    const needing = this.picked.filter((record) => !record.views[0].tile).sort((a, b) => b.size - a.size);
    let packed = true;
    for (const record of needing) {
      if (!this.placeRecord(record)) packed = false;
    }
    if (!packed) {
      // Gaps in the wrong places: everyone again, largest first. Their total fits, so this always places them.
      this.shelves.reset();
      for (const record of this.picked) {
        for (const view of record.views) {
          view.tile = null;
          view.drawn = false;
        }
      }
      for (const record of [...this.picked].sort((a, b) => b.size - a.size)) {
        if (!this.placeRecord(record)) this.releaseTiles(record);
      }
    }
    for (const record of this.picked) {
      for (const view of record.views) {
        if (view.slot >= 0) continue;
        view.slot = this.slots.indexOf(null);
        this.slots[view.slot] = view;
      }
    }
  }

  private placeRecord(record: LocalRecord): boolean {
    for (const view of record.views) {
      const tile = this.shelves.allocate(record.size);
      if (!tile) {
        this.releaseTiles(record);
        return false;
      }
      view.tile = tile;
      view.drawn = false;
    }
    return true;
  }

  /** Aims a light's views again if it changed, and notes which have to be drawn. */
  private refreshRecord(record: LocalRecord, layers: number, changes: CasterChanges): void {
    const { light, signature, size } = record;
    const shadowCamera = light.shadow.camera;
    _position.setFromMatrixPosition(light.matrixWorld);
    const spot = isSpot(light) ? light : null;
    if (spot) _target.setFromMatrixPosition(spot.target.matrixWorld);
    else _target.set(0, 0, 0);
    const now = this.signature;
    now[0] = _position.x;
    now[1] = _position.y;
    now[2] = _position.z;
    now[3] = _target.x;
    now[4] = _target.y;
    now[5] = _target.z;
    now[6] = spot ? spot.angle * spot.shadow.focus : 0;
    now[7] = shadowCamera.near;
    now[8] = record.range;
    now[9] = size;
    now[10] = layers;
    now[11] = 0;
    let moved = false;
    for (let word = 0; word < SIGNATURE_WORDS; word++) moved ||= now[word] !== signature[word];
    if (moved) signature.set(now);

    for (let face = 0; face < record.views.length; face++) {
      const view = record.views[face];
      if (!view.tile) continue;
      if (moved) view.drawn = false;
      if (view.drawn && (changes.everything || changesTouch(changes, view.frustum))) view.drawn = false;
      if (view.drawn) continue;
      this.aimView(record, view, face);
    }
  }

  private aimView(record: LocalRecord, view: LocalView, face: number): void {
    const { light, range, size } = record;
    const near = light.shadow.camera.near;
    const spot = isSpot(light) ? light : null;
    let tangent: number;
    if (spot) {
      const angle = THREE.MathUtils.clamp(spot.angle * spot.shadow.focus, 0.01, 1.48);
      tangent = Math.tan(angle);
      _lookAt.lookAt(_position, _target, WORLD_UP);
    } else {
      tangent = size / (size - 2 * FACE_GUARD_TEXELS);
      _target.addVectors(_position, FACE_DIRECTIONS[face]);
      _lookAt.lookAt(_position, _target, FACE_UPS[face]);
    }
    _lookAt.setPosition(_position);
    view.eye.copy(_position);
    view.viewInverse.copy(_lookAt).invert();
    view.projection.makePerspective(-near * tangent, near * tangent, near * tangent, -near * tangent, near, range);
    _clip.multiplyMatrices(view.projection, view.viewInverse);
    view.frustum.setFromProjectionMatrix(_clip);
    const tile = view.tile!;
    writeShadowMatrix(view.matrix, 0, view.projection, view.viewInverse, tile.size / ATLAS_SIZE, tile.x / ATLAS_SIZE, tile.y / ATLAS_SIZE);
  }

  private ensureAtlas(): void {
    if (this.atlasTexture) return;
    this.atlasTexture = this.device.createTexture({
      label: "gpu shadow atlas",
      size: [ATLAS_SIZE, ATLAS_SIZE],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.atlasView = this.atlasTexture.createView({ label: "gpu shadow atlas" });
    this.clearer = new DepthTileClearer(this.device);
  }

  private drawViews(frame: GpuFrame): void {
    const { redraw } = this;
    for (const view of redraw) frame.drawer!.cullView(frame, this.slotOffsets[view.slot], LOCAL_KEYS[view.slot]);
    // The atlas's other tiles keep what they hold.
    const pass = frame.encoder.beginRenderPass({
      label: "gpu shadow atlas",
      colorAttachments: [],
      depthStencilAttachment: { view: this.atlasView!, depthLoadOp: "load", depthStoreOp: "store" },
    });
    for (const view of redraw) {
      const tile = view.tile!;
      pass.setViewport(tile.x, tile.y, tile.size, tile.size, 0, 1);
      pass.setScissorRect(tile.x, tile.y, tile.size, tile.size);
      this.clearer!.clear(pass);
      drawShadowDepth(frame, this.slotOffsets[view.slot], LOCAL_KEYS[view.slot], pass);
      view.drawn = true;
    }
    pass.end();
  }

  private publishAtlas(gpuScene: GpuScene): ShadowAtlasProduct {
    const lights = gpuScene.local.length;
    if (this.lightToEntry.length < lights) this.lightToEntry = new Int32Array(lights * 2);
    this.lightToEntry.fill(-1, 0, lights);
    let count = 0;
    for (const record of this.picked) {
      if (!record.views[0].tile) continue;
      this.lightToEntry[record.index] = count;
      for (const view of record.views) this.entries.set(view.matrix, count++ * 16);
    }
    const product = this.atlasProduct;
    product.view = this.atlasView;
    product.entries = this.entries.subarray(0, count * 16);
    product.lightToEntry = this.lightToEntry.subarray(0, lights);
    product.count = count;
    return product as ShadowAtlasProduct;
  }
}
