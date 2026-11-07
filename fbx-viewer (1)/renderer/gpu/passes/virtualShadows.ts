/// <reference types="@webgpu/types" />
import * as THREE from "three";
import type { GpuCore } from "../device";
import type { GpuFrame, GpuPass } from "../frame";
import type { GpuScene } from "../gpuScene";
import { CAMERA_BINDINGS_WGSL, VIEW_WGSL } from "../shaders";
import { isLitMaterial } from "../surfaces/lit";
import {
  casterWatchFor,
  DepthTileClearer,
  drawShadowDepth,
  findSun,
  makeLightPlane,
  numberSetting,
  readLightPlane,
  SAME_DIRECTION,
  shadowSettings,
  writeLightView,
  type CasterChanges,
  type CasterWatch,
} from "./shadows";

/**
 * PAGE-BASED SUN SHADOWS
 *
 * One enormous shadow map for the sun that only exists where it is looked at. Around the camera lie twelve square
 * windows onto the light's plane, each twice as wide as the last and each cut into 128 by 128 pages of 126 texels: about
 * 16K texels a side for every level. A pixel on screen needs the level whose texels are about its own size, so shadows
 * are as sharp far away as they are close by.
 *
 * Only the pages pixels ask for are real. After the surfaces are drawn, a compute shader goes over the depth buffer and
 * marks the pages it wants; those marks reach the CPU a frame or two later. Each wanted page takes a tile of one depth
 * atlas, and is drawn with a view of its own. A page stays in the atlas from frame to frame until a caster changes over
 * it, and when room is needed the page unused the longest goes first, so a still scene draws nothing at all.
 *
 * Until a page is drawn, lookups fall through to the next level up. A coarse block of pages always stays around the
 * camera, so there is always something to fall to. A sun that keeps moving would have to redraw every page every frame,
 * so while it moves nothing is drawn here, the product is withdrawn, and the cascades carry the sun.
 *
 * The windows follow the camera in whole pages, and page numbers wrap around inside the table, so a page that stays in
 * a level's window stays where it is. All pages share one depth scale, from the highest caster to the lowest receiver,
 * so a page can be compared with whenever it was drawn. With several editor views in one frame, one camera owns the
 * pages; the others use cascades.
 *
 * The pass runs after the surfaces because it reads their depth. ShadowPass adds it when "shadows.virtual" is first on,
 * and from then on it answers that setting itself, giving back its memory while the setting is off.
 *
 * Publishes in frame.products while ready, and withdraws while not:
 *   "virtualShadows": VirtualShadowsProduct. Its `wgsl` gives `virtualShadow(worldPosition, worldNormal) -> f32`, 1 lit
 *   and 0 in shadow. It adds four bindings, so that it can share a group with the lighting code; whoever calls it adds
 *   `virtualShadowLayoutEntries` to that group's layout and the product's `bindGroupEntries` to its bind group.
 *
 * Read from frame.products:
 *   "virtualShadowsReader": true, set by a pass that calls `virtualShadow`. Only then are cascades left undrawn; without
 *   a reader they carry on, and the picture is right either way.
 *
 * Settings: "shadows.virtual", "shadows.virtual.atlas" (side of the atlas in texels), "shadows.virtual.pagesPerFrame" and
 * "shadows.virtual.pageSize" (the world width of the finest level's pages), besides "shadows.distance".
 */

export interface VirtualShadowsProduct {
  /** One u32 a page, level by level: 0 for none, otherwise the atlas tile plus one. */
  pageTable: GPUBuffer;
  /** A depth32float 2d. */
  atlas: GPUTextureView;
  /** The lookup at the default group and bindings. `virtualShadowsWgsl` gives it at others. */
  wgsl: string;
  params: GPUBuffer;
  sampler: GPUSampler;
  bindGroupEntries(firstBinding?: number): GPUBindGroupEntry[];
}

/** The lighting code's group, and the first binding after its own. */
export const VIRTUAL_SHADOW_GROUP = 3;
export const VIRTUAL_SHADOW_FIRST_BINDING = 10;
export const VIRTUAL_SHADOW_BINDINGS = 4;
export const VIRTUAL_SHADOWS_READER = "virtualShadowsReader";
/** The last frame an effect lit something through the cascades, which it sets each time: they go on being drawn for it. */
export const CASCADES_WANTED = "cascadesWanted";
const CASCADES_WANTED_FRAMES = 16;
const PRODUCT = "virtualShadows";

const LEVELS = 12;
const MAX_LEVELS = 16;
const PAGE_TEXELS = 128;
/** A texel around every page, so that filtering at its edge stays within its own tile. */
const PAGE_GUTTER = 1;
const PAGE_USABLE = PAGE_TEXELS - 2 * PAGE_GUTTER;
const PAGES_PER_SIDE = 128;
const PAGE_MASK = PAGES_PER_SIDE - 1;
const PAGES_PER_LEVEL = PAGES_PER_SIDE * PAGES_PER_SIDE;
const WORDS_PER_LEVEL = PAGES_PER_LEVEL / 32;
const MARK_WORDS = WORDS_PER_LEVEL * LEVELS;
const WINDOW_CENTRE = PAGES_PER_SIDE / 2;
/** Pages from the camera that a level is used out to: short of its window's edge, so filtering stays inside too. */
const PAGE_REACH = WINDOW_CENTRE - 4;
const MARK_WORKGROUP = 8;
/** Depth is read one pixel in this many each way, a different one each frame. */
const MARK_STEP = 2;
const MARK_OFFSETS: ReadonlyArray<readonly [number, number]> = [[0, 0], [1, 1], [1, 0], [0, 1]];
const READBACKS = 4;

const DEFAULT_PAGE_SIZE = 0.25;
const DEFAULT_PAGES_PER_FRAME = 48;
const MAX_PAGES_PER_FRAME = 64;
const DEFAULT_DISTANCE = 200;
/** Frames a page was last asked for within which it is not given up for another. */
const RECENT_FRAMES = 12;
/** Frames the sun has to hold still before pages are drawn for it. */
const SETTLE_FRAMES = 8;
/** Pages either way from the camera's page that are always kept, whatever pixels ask for. */
const FALLBACK_RADIUS = 4;
/** Share of the atlas asked for at which levels get coarser, and at which they come back; apart, or it would flip. */
const CROWDED = 0.85;
const ROOMY = 0.18;
const BIAS_HOLD_FRAMES = 30;
/** Frames a camera goes unseen before another may take over its pages. */
const CAMERA_KEPT_FRAMES = 30;
const MAX_LEVEL_BIAS = 4;

const PARAM_WORDS = 24 + MAX_LEVELS * 4;

const PAGE_FREE = 0;
const PAGE_CLEAN = 1;
const PAGE_DIRTY = 2;
/** Claimed this frame, and on its way to being drawn. */
const PAGE_NEW = 3;

const PAGE_KEYS = Array.from({ length: MAX_PAGES_PER_FRAME }, (_, index) => `shadow page ${index}`);

const COMMON_WGSL = /* wgsl */ `
const VIRTUAL_PAGE_TEXELS = ${PAGE_TEXELS}.0;
const VIRTUAL_PAGE_GUTTER = ${PAGE_GUTTER}.0;
const VIRTUAL_PAGE_USABLE = ${PAGE_USABLE}.0;
const VIRTUAL_PAGE_REACH = ${PAGE_REACH}.0;
const VIRTUAL_PAGES_PER_SIDE = ${PAGES_PER_SIDE}i;
const VIRTUAL_PAGE_MASK = ${PAGE_MASK}i;

struct VirtualShadowParams {
  // xyz, then the world width of a page of the finest level.
  right: vec4f,
  // xyz, then the number of levels.
  up: vec4f,
  // xyz, then the depth scale's far end along it.
  toSun: vec4f,
  // The eye, then world units a pixel covers at distance one.
  camera: vec4f,
  // One over the depth scale's length, the atlas's tiles a side, levels added for a full atlas, 1 for a parallel camera.
  settings: vec4f,
  markOffset: vec4u,
  // Each level's window: the page number at its low corner.
  origins: array<vec4i, ${MAX_LEVELS}>,
}

fn virtualPlaneOf(world: vec3f) -> vec2f {
  return vec2f(dot(world, virtualParams.right.xyz), dot(world, virtualParams.up.xyz));
}

fn virtualPageWorld(level: i32) -> f32 {
  return virtualParams.right.w * f32(1u << u32(level));
}

// The level a point wants: the one whose texels are the size of a pixel there, or wider if it has to reach that far.
fn virtualLevelOf(world: vec3f) -> i32 {
  let away = abs(virtualPlaneOf(world) - virtualPlaneOf(virtualParams.camera.xyz));
  let reach = max(away.x, away.y);
  let distance = length(world - virtualParams.camera.xyz);
  let pixel = virtualParams.camera.w * select(distance, 1.0, virtualParams.settings.w > 0.5);
  let finest = virtualParams.right.w / VIRTUAL_PAGE_USABLE;
  let sharp = ceil(log2(max(pixel / finest, 1e-6)) + virtualParams.settings.z);
  let fits = ceil(log2(max(reach / (virtualParams.right.w * VIRTUAL_PAGE_REACH), 1e-6)));
  return clamp(i32(max(sharp, fits)), 0, i32(virtualParams.up.w) - 1);
}

fn virtualInWindow(level: i32, page: vec2i) -> bool {
  let within = page - virtualParams.origins[level].xy;
  return all(within >= vec2i(0)) && all(within < vec2i(VIRTUAL_PAGES_PER_SIDE));
}

fn virtualSlotOf(level: i32, page: vec2i) -> u32 {
  let wrapped = page & vec2i(VIRTUAL_PAGE_MASK);
  return u32(wrapped.y * VIRTUAL_PAGES_PER_SIDE + wrapped.x);
}
`;

export const VIRTUAL_MARK_WGSL = /* wgsl */ `
${VIEW_WGSL}${CAMERA_BINDINGS_WGSL}${COMMON_WGSL}
@group(1) @binding(0) var<uniform> virtualParams: VirtualShadowParams;
@group(1) @binding(1) var virtualDepth: texture_depth_2d;
@group(1) @binding(2) var<storage, read_write> virtualMarks: array<atomic<u32>>;

fn markPage(level: i32, page: vec2i) {
  if (!virtualInWindow(level, page)) { return; }
  let slot = virtualSlotOf(level, page);
  let word = u32(level) * ${WORDS_PER_LEVEL}u + (slot >> 5u);
  let bit = 1u << (slot & 31u);
  // Reading first keeps most pixels of a page from all writing the same word.
  if ((atomicLoad(&virtualMarks[word]) & bit) == 0u) { atomicOr(&virtualMarks[word], bit); }
}

@compute @workgroup_size(${MARK_WORKGROUP}, ${MARK_WORKGROUP}) fn markPages(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(virtualDepth);
  let pixel = id.xy * ${MARK_STEP}u + virtualParams.markOffset.xy;
  if (any(pixel >= size)) { return; }
  let depth = textureLoad(virtualDepth, pixel, 0);
  // Nothing was drawn here: only sky.
  if (depth <= 0.0) { return; }
  let uv = (vec2f(pixel) + 0.5) / vec2f(size);
  let at = view.inverseViewProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let world = at.xyz / at.w;
  let level = virtualLevelOf(world);
  let coords = virtualPlaneOf(world) / virtualPageWorld(level);
  // Close to an edge, the lookup's lift along the normal and its filter can land on the next page too.
  let margin = 3.0 / VIRTUAL_PAGE_USABLE;
  let low = vec2i(floor(coords - margin));
  let high = vec2i(floor(coords + margin));
  for (var y = low.y; y <= high.y; y++) {
    for (var x = low.x; x <= high.x; x++) {
      markPage(level, vec2i(x, y));
    }
  }
}
`;

/** The lookup, with its bindings at a group and first binding of the caller's choosing. */
export const virtualShadowsWgsl = (group: number = VIRTUAL_SHADOW_GROUP, firstBinding: number = VIRTUAL_SHADOW_FIRST_BINDING): string => /* wgsl */ `
${COMMON_WGSL}
@group(${group}) @binding(${firstBinding}) var<uniform> virtualParams: VirtualShadowParams;
@group(${group}) @binding(${firstBinding + 1}) var<storage, read> virtualPageTable: array<u32>;
@group(${group}) @binding(${firstBinding + 2}) var virtualAtlas: texture_depth_2d;
@group(${group}) @binding(${firstBinding + 3}) var virtualSampler: sampler_comparison;

// One filtered lookup: the wanted level's page if it is there, otherwise the nearest coarser one. Nothing at all is lit.
fn virtualTap(plane: vec2f, depth: f32, start: i32) -> f32 {
  let levels = i32(virtualParams.up.w);
  for (var level = start; level < levels; level++) {
    let coords = plane / virtualPageWorld(level);
    let whole = floor(coords);
    let page = vec2i(whole);
    if (!virtualInWindow(level, page)) { continue; }
    let entry = virtualPageTable[u32(level) * ${PAGES_PER_LEVEL}u + virtualSlotOf(level, page)];
    if (entry == 0u) { continue; }
    let tile = entry - 1u;
    let side = u32(virtualParams.settings.y);
    let local = coords - whole;
    let within = (vec2f(local.x, 1.0 - local.y) * VIRTUAL_PAGE_USABLE + VIRTUAL_PAGE_GUTTER) / VIRTUAL_PAGE_TEXELS;
    let uv = (vec2f(f32(tile % side), f32(tile / side)) + within) / f32(side);
    return textureSampleCompareLevel(virtualAtlas, virtualSampler, uv, depth);
  }
  return 1.0;
}

// How much of the sun reaches a surface: 1 lit, 0 in shadow.
fn virtualShadow(worldPosition: vec3f, worldNormal: vec3f) -> f32 {
  let level = virtualLevelOf(worldPosition);
  let texel = virtualPageWorld(level) / VIRTUAL_PAGE_USABLE;
  let lifted = worldPosition + worldNormal * texel * 1.5;
  let plane = virtualPlaneOf(lifted);
  let toDepth = virtualParams.settings.x;
  // Above nothing: a receiver below the depth scale still has to count as nearer than an empty texel.
  let depth = max((dot(lifted, virtualParams.toSun.xyz) - virtualParams.toSun.w + texel) * toDepth, 1e-7);
  let half = texel * 0.5;
  var sum = virtualTap(plane + vec2f(-half, -half), depth, level);
  sum += virtualTap(plane + vec2f(half, -half), depth, level);
  sum += virtualTap(plane + vec2f(-half, half), depth, level);
  sum += virtualTap(plane + vec2f(half, half), depth, level);
  return sum * 0.25;
}
`;

/** What the group holding the lookup needs in its layout. */
export const virtualShadowLayoutEntries = (firstBinding: number = VIRTUAL_SHADOW_FIRST_BINDING): GPUBindGroupLayoutEntry[] => {
  const visibility = GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;
  return [
    { binding: firstBinding, visibility, buffer: { type: "uniform" } },
    { binding: firstBinding + 1, visibility, buffer: { type: "read-only-storage" } },
    { binding: firstBinding + 2, visibility, texture: { sampleType: "depth" } },
    { binding: firstBinding + 3, visibility, sampler: { type: "comparison" } },
  ];
};

interface Readback {
  buffer: GPUBuffer;
  /** Free, written by a frame that has yet to be submitted, or on its way to the CPU. */
  state: "free" | "copied" | "mapping";
}

interface Resources {
  atlasTexture: GPUTexture;
  atlasView: GPUTextureView;
  tilesPerSide: number;
  capacity: number;
  pageTable: GPUBuffer;
  marks: GPUBuffer;
  params: GPUBuffer;
  readbacks: Readback[];
  sampler: GPUSampler;
  clearer: DepthTileClearer;
  markLayout: GPUBindGroupLayout;
  markPipeline: GPUComputePipeline;
  markGroup: GPUBindGroup | null;
  markDepth: GPUTextureView | null;
  product: VirtualShadowsProduct;
  /** The page table as the shader sees it. */
  table: Uint32Array;
  /** What each table slot is held by, drawn or not. */
  owners: Int32Array;
  dirtyLow: Int32Array;
  dirtyHigh: Int32Array;
  tileState: Uint8Array;
  tileLevel: Uint8Array;
  tileX: Int32Array;
  tileY: Int32Array;
  tileUsed: Int32Array;
  freeTiles: number[];
  latestMarks: Uint32Array;
}

const _plane = makeLightPlane();
const _eye = new THREE.Vector3();
const _viewInverse = new THREE.Matrix4();
const _projection = new THREE.Matrix4();
const paramFloats = new Float32Array(PARAM_WORDS);
const paramWords = new Uint32Array(paramFloats.buffer);
const paramInts = new Int32Array(paramFloats.buffer);

export class VirtualShadowPass implements GpuPass {
  readonly id = "virtual shadows";
  readonly stage = "afterSurfaces" as const;
  readonly order = -10;

  private readonly device: GPUDevice;
  private resources: Resources | null = null;
  private ready = false;
  private camera: THREE.Camera | null = null;
  private cameraSeen = 0;
  private scene: GpuScene | null = null;
  private watch: CasterWatch | null = null;
  private changes: CasterChanges | null = null;
  private readonly plane = makeLightPlane();
  private planeKnown = false;
  private settled = 0;
  /** The depth scale along the sun. Only ever wider, until the sun moves. */
  private top = -Infinity;
  private bottom = Infinity;
  private pageSize = DEFAULT_PAGE_SIZE;
  private layers = 0;
  private readonly origins = new Int32Array(LEVELS * 2).fill(0x7fffffff);
  private levelBias = 0;
  private biasHold = 0;
  private marksFresh = false;
  /** Table slots pixels asked for that have no tile yet, coarsest first. */
  private readonly wanted: number[] = [];
  private readonly fallback: number[] = [];
  private readonly drawing: number[] = [];
  private evictable: number[] | null = null;

  constructor(core: GpuCore) {
    this.device = core.device;
  }

  /** Whether this frame's sun can be left to these pages, which is what lets ShadowPass skip the cascades. */
  readyFor(frame: GpuFrame, toSun: THREE.Vector3): boolean {
    if (!this.ready || this.camera !== frame.camera || this.scene !== frame.gpuScene || !this.resources) return false;
    if (frame.products.get(VIRTUAL_SHADOWS_READER) !== true) return false;
    if (!shadowSettings(frame)?.get("shadows.virtual")) return false;
    // What is lit outside the surface buffer reads the cascades.
    if (frame.gpuScene.forward.some((item) => isLitMaterial(item.part.group.material.material))) return false;
    const wanted = frame.products.get(CASCADES_WANTED) as number | undefined;
    if (wanted !== undefined && frame.frameNumber - wanted < CASCADES_WANTED_FRAMES) return false;
    if (this.plane.toSun.distanceToSquared(toSun) >= SAME_DIRECTION) return false;
    // Would need a new depth scale, and so every page again, later this frame.
    const { top, bottom } = casterWatchFor(frame.gpuScene).extents(this.plane.toSun);
    return !(top > this.top || bottom < this.bottom);
  }

  execute(frame: GpuFrame): void {
    frame.products.delete(PRODUCT);
    const settings = shadowSettings(frame);
    if (!settings?.get("shadows.virtual")) {
      this.release();
      return;
    }
    const r = this.resources ?? this.create(frame, settings);
    this.startReadbacks(r);

    const sunIndex = findSun(frame.gpuScene);
    if (sunIndex < 0 || !frame.drawer) {
      this.ready = false;
      return;
    }
    if (!this.takeCamera(frame, r)) return;

    const watch = casterWatchFor(frame.gpuScene);
    if (watch !== this.watch || !this.changes) {
      if (this.watch && this.changes) this.watch.unsubscribe(this.changes);
      this.watch = watch;
      this.changes = watch.subscribe();
    }
    watch.update(frame);

    this.readSun(frame.gpuScene.directional[sunIndex], r);
    if (this.settled < SETTLE_FRAMES) {
      this.settled++;
      return;
    }
    if (!this.fitDepthScale(watch, r)) {
      this.ready = false;
      return;
    }

    const pageSize = Math.max(numberSetting(settings, "shadows.virtual.pageSize", DEFAULT_PAGE_SIZE), 1e-3);
    const layers = frame.camera.layers.mask;
    if (pageSize !== this.pageSize || layers !== this.layers) {
      this.pageSize = pageSize;
      this.layers = layers;
      this.unmapAll(r);
    }

    this.moveWindows(frame, r);
    this.applyChanges(frame.frameNumber, this.changes, r);
    this.readMarks(frame.frameNumber, r);
    this.claimFallback(frame.frameNumber, numberSetting(settings, "shadows.distance", DEFAULT_DISTANCE), r);
    this.choosePages(frame.frameNumber, Math.round(numberSetting(settings, "shadows.virtual.pagesPerFrame", DEFAULT_PAGES_PER_FRAME)), r);
    if (this.drawing.length) this.drawPages(frame, r);
    this.uploadTable(r);
    this.uploadParams(frame, r);
    this.markPages(frame, r);

    this.ready = this.fallbackDrawn(r);
    if (this.ready) frame.products.set(PRODUCT, r.product);
  }

  dispose(): void {
    this.release();
  }

  private release(): void {
    this.ready = false;
    if (this.watch && this.changes) this.watch.unsubscribe(this.changes);
    this.watch = null;
    this.changes = null;
    this.camera = null;
    this.scene = null;
    this.planeKnown = false;
    const r = this.resources;
    if (!r) return;
    this.resources = null;
    r.atlasTexture.destroy();
    r.pageTable.destroy();
    r.marks.destroy();
    r.params.destroy();
    for (const readback of r.readbacks) readback.buffer.destroy();
  }

  private create(frame: GpuFrame, settings: ReadonlyMap<string, unknown>): Resources {
    const { device } = this;
    const limit = Math.min(device.limits.maxTextureDimension2D, 8192);
    const asked = numberSetting(settings, "shadows.virtual.atlas", 8192);
    const tilesPerSide = Math.max(8, Math.floor(Math.min(asked, limit) / PAGE_TEXELS));
    const capacity = tilesPerSide * tilesPerSide;
    const atlasTexture = device.createTexture({
      label: "gpu shadow pages",
      size: [tilesPerSide * PAGE_TEXELS, tilesPerSide * PAGE_TEXELS],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const atlasView = atlasTexture.createView({ label: "gpu shadow pages" });
    const pageTable = device.createBuffer({ label: "gpu shadow page table", size: LEVELS * PAGES_PER_LEVEL * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const marks = device.createBuffer({ label: "gpu shadow page marks", size: MARK_WORDS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const params = device.createBuffer({ label: "gpu shadow page settings", size: PARAM_WORDS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const sampler = device.createSampler({
      label: "gpu shadow pages compare",
      compare: "greater",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    const markLayout = device.createBindGroupLayout({
      label: "gpu shadow page marks",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    const wgsl = virtualShadowsWgsl();
    const r: Resources = {
      atlasTexture,
      atlasView,
      tilesPerSide,
      capacity,
      pageTable,
      marks,
      params,
      readbacks: Array.from({ length: READBACKS }, (): Readback => ({
        buffer: device.createBuffer({ label: "gpu shadow page marks readback", size: MARK_WORDS * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
        state: "free",
      })),
      sampler,
      clearer: new DepthTileClearer(device),
      markLayout,
      markPipeline: device.createComputePipeline({
        label: "gpu shadow page marks",
        layout: device.createPipelineLayout({ bindGroupLayouts: [frame.cameraLayout, markLayout] }),
        compute: { module: device.createShaderModule({ label: "gpu shadow page marks", code: VIRTUAL_MARK_WGSL }), entryPoint: "markPages" },
      }),
      markGroup: null,
      markDepth: null,
      product: {
        pageTable,
        atlas: atlasView,
        wgsl,
        params,
        sampler,
        bindGroupEntries: (firstBinding = VIRTUAL_SHADOW_FIRST_BINDING) => [
          { binding: firstBinding, resource: { buffer: params } },
          { binding: firstBinding + 1, resource: { buffer: pageTable } },
          { binding: firstBinding + 2, resource: atlasView },
          { binding: firstBinding + 3, resource: sampler },
        ],
      },
      table: new Uint32Array(LEVELS * PAGES_PER_LEVEL),
      owners: new Int32Array(LEVELS * PAGES_PER_LEVEL).fill(-1),
      dirtyLow: new Int32Array(LEVELS).fill(PAGES_PER_LEVEL),
      dirtyHigh: new Int32Array(LEVELS).fill(-1),
      tileState: new Uint8Array(capacity),
      tileLevel: new Uint8Array(capacity),
      tileX: new Int32Array(capacity),
      tileY: new Int32Array(capacity),
      tileUsed: new Int32Array(capacity),
      freeTiles: [],
      latestMarks: new Uint32Array(MARK_WORDS),
    };
    for (let tile = capacity - 1; tile >= 0; tile--) r.freeTiles.push(tile);
    this.resources = r;
    return r;
  }

  /**
   * Marks copied last frame have been submitted by now, so they can be asked for. Asking any sooner is not allowed: a
   * buffer on its way to being mapped cannot be used by a command buffer yet to be submitted.
   */
  private startReadbacks(r: Resources): void {
    for (const readback of r.readbacks) {
      if (readback.state !== "copied") continue;
      readback.state = "mapping";
      readback.buffer.mapAsync(GPUMapMode.READ).then(() => {
        if (this.resources !== r) return;
        r.latestMarks.set(new Uint32Array(readback.buffer.getMappedRange()));
        readback.buffer.unmap();
        readback.state = "free";
        this.marksFresh = true;
      }).catch(() => {
        // Destroyed with the pass, or the device was lost: nothing is waiting for it.
        readback.state = "free";
      });
    }
  }

  /** One camera owns the pages until it has gone unseen for a while. */
  private takeCamera(frame: GpuFrame, r: Resources): boolean {
    if (this.camera !== frame.camera) {
      if (this.camera && frame.frameNumber - this.cameraSeen < CAMERA_KEPT_FRAMES) return false;
      this.camera = frame.camera;
      this.unmapAll(r);
    }
    if (this.scene !== frame.gpuScene) {
      this.scene = frame.gpuScene;
      this.planeKnown = false;
    }
    this.cameraSeen = frame.frameNumber;
    return true;
  }

  private readSun(sun: THREE.DirectionalLight, r: Resources): void {
    readLightPlane(sun, _plane);
    if (this.planeKnown && this.plane.toSun.distanceToSquared(_plane.toSun) < SAME_DIRECTION) return;
    this.planeKnown = true;
    this.plane.toSun.copy(_plane.toSun);
    this.plane.right.copy(_plane.right);
    this.plane.up.copy(_plane.up);
    this.top = -Infinity;
    this.bottom = Infinity;
    this.settled = 0;
    this.ready = false;
    this.unmapAll(r);
  }

  /** Keeps the depth scale around everything, with room to spare. False with nothing that casts. */
  private fitDepthScale(watch: CasterWatch, r: Resources): boolean {
    const { top, bottom } = watch.extents(this.plane.toSun);
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) return false;
    if (top <= this.top && bottom >= this.bottom) return true;
    const room = Math.max((top - bottom) * 0.25, 16);
    this.top = Math.max(top + room, Number.isFinite(this.top) ? this.top : -Infinity);
    this.bottom = Math.min(bottom - room, Number.isFinite(this.bottom) ? this.bottom : Infinity);
    this.unmapAll(r);
    return true;
  }

  private unmapAll(r: Resources): void {
    r.table.fill(0);
    r.owners.fill(-1);
    r.tileState.fill(PAGE_FREE);
    r.freeTiles.length = 0;
    for (let tile = r.capacity - 1; tile >= 0; tile--) r.freeTiles.push(tile);
    r.dirtyLow.fill(0);
    r.dirtyHigh.fill(PAGES_PER_LEVEL - 1);
    this.wanted.length = 0;
    this.origins.fill(0x7fffffff);
  }

  private setTable(r: Resources, level: number, slot: number, value: number): void {
    const at = level * PAGES_PER_LEVEL + slot;
    if (r.table[at] === value) return;
    r.table[at] = value;
    if (slot < r.dirtyLow[level]) r.dirtyLow[level] = slot;
    if (slot > r.dirtyHigh[level]) r.dirtyHigh[level] = slot;
  }

  private slotOf(x: number, y: number): number {
    return (y & PAGE_MASK) * PAGES_PER_SIDE + (x & PAGE_MASK);
  }

  private freeTile(r: Resources, tile: number): void {
    const level = r.tileLevel[tile];
    const slot = this.slotOf(r.tileX[tile], r.tileY[tile]);
    if (r.owners[level * PAGES_PER_LEVEL + slot] === tile) {
      r.owners[level * PAGES_PER_LEVEL + slot] = -1;
      this.setTable(r, level, slot, 0);
    }
    r.tileState[tile] = PAGE_FREE;
    r.freeTiles.push(tile);
  }

  /** Each level's window to the page the camera is in; pages it left are given up. */
  private moveWindows(frame: GpuFrame, r: Resources): void {
    _eye.setFromMatrixPosition(frame.camera.matrixWorld);
    const x = _eye.dot(this.plane.right);
    const y = _eye.dot(this.plane.up);
    let moved = false;
    for (let level = 0; level < LEVELS; level++) {
      const world = this.pageSize * 2 ** level;
      const originX = Math.floor(x / world) - WINDOW_CENTRE;
      const originY = Math.floor(y / world) - WINDOW_CENTRE;
      if (originX !== this.origins[level * 2] || originY !== this.origins[level * 2 + 1]) moved = true;
      this.origins[level * 2] = originX;
      this.origins[level * 2 + 1] = originY;
    }
    if (!moved) return;
    for (let tile = 0; tile < r.capacity; tile++) {
      if (r.tileState[tile] === PAGE_FREE) continue;
      const level = r.tileLevel[tile];
      const withinX = r.tileX[tile] - this.origins[level * 2];
      const withinY = r.tileY[tile] - this.origins[level * 2 + 1];
      if (withinX < 0 || withinX >= PAGES_PER_SIDE || withinY < 0 || withinY >= PAGES_PER_SIDE) this.freeTile(r, tile);
    }
  }

  /** A page a caster changed over is drawn again if it is still in use, and given up if not. */
  private applyChanges(frameNumber: number, changes: CasterChanges, r: Resources): void {
    const { right, up } = this.plane;
    const { spheres, count, everything } = changes;
    if (everything || count) {
      for (let tile = 0; tile < r.capacity; tile++) {
        if (r.tileState[tile] === PAGE_FREE) continue;
        let touched = everything;
        if (!touched) {
          const world = this.pageSize * 2 ** r.tileLevel[tile];
          const lowX = r.tileX[tile] * world;
          const lowY = r.tileY[tile] * world;
          for (let index = 0; index < count && !touched; index++) {
            const at = index * 4;
            const radius = spheres[at + 3];
            const x = spheres[at] * right.x + spheres[at + 1] * right.y + spheres[at + 2] * right.z;
            if (x + radius < lowX || x - radius > lowX + world) continue;
            const y = spheres[at] * up.x + spheres[at + 1] * up.y + spheres[at + 2] * up.z;
            touched = y + radius >= lowY && y - radius <= lowY + world;
          }
        }
        if (!touched) continue;
        if (frameNumber - r.tileUsed[tile] > RECENT_FRAMES) this.freeTile(r, tile);
        else r.tileState[tile] = PAGE_DIRTY;
      }
    }
    changes.count = 0;
    changes.everything = false;
  }

  /** What pixels asked for: pages they have keep being used; those they do not have are wanted. */
  private readMarks(frameNumber: number, r: Resources): void {
    if (!this.marksFresh) return;
    this.marksFresh = false;
    const { wanted } = this;
    wanted.length = 0;
    let asked = 0;
    for (let level = LEVELS - 1; level >= 0; level--) {
      const first = level * WORDS_PER_LEVEL;
      for (let word = 0; word < WORDS_PER_LEVEL; word++) {
        let bits = r.latestMarks[first + word];
        while (bits !== 0) {
          const bit = 31 - Math.clz32(bits & -bits);
          bits &= bits - 1;
          asked++;
          const at = level * PAGES_PER_LEVEL + word * 32 + bit;
          const owner = r.owners[at];
          if (owner >= 0) r.tileUsed[owner] = frameNumber;
          else wanted.push(at);
        }
      }
    }
    if (this.biasHold > 0) {
      this.biasHold--;
    } else if (asked > r.capacity * CROWDED && this.levelBias < MAX_LEVEL_BIAS) {
      this.levelBias++;
      this.biasHold = BIAS_HOLD_FRAMES;
    } else if (asked < r.capacity * ROOMY && this.levelBias > 0) {
      this.levelBias--;
      this.biasHold = BIAS_HOLD_FRAMES;
    }
  }

  /** The block around the camera that lookups can always fall to: wide enough for a good part of the shadow distance. */
  private claimFallback(frameNumber: number, distance: number, r: Resources): void {
    const level = THREE.MathUtils.clamp(Math.ceil(Math.log2(Math.max(distance / 4 / this.pageSize, 1))), 0, LEVELS - 1);
    const centreX = this.origins[level * 2] + WINDOW_CENTRE;
    const centreY = this.origins[level * 2 + 1] + WINDOW_CENTRE;
    const { fallback } = this;
    fallback.length = 0;
    for (let y = -FALLBACK_RADIUS; y <= FALLBACK_RADIUS; y++) {
      for (let x = -FALLBACK_RADIUS; x <= FALLBACK_RADIUS; x++) {
        const at = level * PAGES_PER_LEVEL + this.slotOf(centreX + x, centreY + y);
        const owner = r.owners[at];
        if (owner >= 0) r.tileUsed[owner] = frameNumber;
        fallback.push(at);
      }
    }
  }

  private fallbackDrawn(r: Resources): boolean {
    for (const at of this.fallback) if (r.table[at] === 0) return false;
    return true;
  }

  /** A tile from those free, or from the page unused the longest; none if every page is in recent use. */
  private takeTile(frameNumber: number, r: Resources): number {
    const free = r.freeTiles.pop();
    if (free !== undefined) return free;
    if (!this.evictable) {
      const list: number[] = [];
      for (let tile = 0; tile < r.capacity; tile++) {
        if (r.tileState[tile] !== PAGE_FREE && frameNumber - r.tileUsed[tile] > RECENT_FRAMES) list.push(tile);
      }
      // The oldest last, to be popped first.
      list.sort((a, b) => r.tileUsed[b] - r.tileUsed[a]);
      this.evictable = list;
    }
    const tile = this.evictable.pop();
    if (tile === undefined) return -1;
    this.freeTile(r, tile);
    return r.freeTiles.pop()!;
  }

  private claim(frameNumber: number, at: number, r: Resources): boolean {
    const tile = this.takeTile(frameNumber, r);
    if (tile < 0) return false;
    const level = Math.floor(at / PAGES_PER_LEVEL);
    const slot = at - level * PAGES_PER_LEVEL;
    const originX = this.origins[level * 2];
    const originY = this.origins[level * 2 + 1];
    r.tileLevel[tile] = level;
    r.tileX[tile] = originX + (((slot & PAGE_MASK) - originX) & PAGE_MASK);
    r.tileY[tile] = originY + (((slot >> 7) - originY) & PAGE_MASK);
    r.tileUsed[tile] = frameNumber;
    r.tileState[tile] = PAGE_NEW;
    r.owners[at] = tile;
    this.drawing.push(tile);
    return true;
  }

  /**
   * This frame's pages, up to the budget. The fallback block first, then what is missing, coarsest first, since each
   * level falls back on the one above. At least half the budget stays for pages that changed, so moving shadows keep up.
   */
  private choosePages(frameNumber: number, asked: number, r: Resources): void {
    const budget = THREE.MathUtils.clamp(asked, 1, MAX_PAGES_PER_FRAME);
    const { drawing } = this;
    drawing.length = 0;
    this.evictable = null;

    let changed = 0;
    for (let tile = 0; tile < r.capacity; tile++) if (r.tileState[tile] === PAGE_DIRTY) changed++;
    const forMissing = budget - Math.min(changed, budget >> 1);

    let room = true;
    for (const at of this.fallback) {
      if (!room || drawing.length >= forMissing) break;
      if (r.owners[at] < 0) room = this.claim(frameNumber, at, r);
    }
    for (const at of this.wanted) {
      if (!room || drawing.length >= forMissing) break;
      if (r.owners[at] < 0) room = this.claim(frameNumber, at, r);
    }
    const claimed = drawing.length;
    for (let tile = 0; tile < r.capacity; tile++) if (r.tileState[tile] === PAGE_DIRTY) drawing.push(tile);
    if (drawing.length > budget) {
      const tail = drawing.splice(claimed);
      tail.sort((a, b) => r.tileLevel[b] - r.tileLevel[a]);
      drawing.push(...tail.slice(0, budget - claimed));
    }
  }

  private drawPages(frame: GpuFrame, r: Resources): void {
    const { encoder } = frame;
    const drawer = frame.drawer!;
    const { drawing, plane } = this;
    const span = this.top - this.bottom;
    const offsets: number[] = [];
    for (let index = 0; index < drawing.length; index++) {
      const tile = drawing[index];
      const world = this.pageSize * 2 ** r.tileLevel[tile];
      const half = (world * PAGE_TEXELS) / PAGE_USABLE / 2;
      _eye.copy(plane.right).multiplyScalar((r.tileX[tile] + 0.5) * world)
        .addScaledVector(plane.up, (r.tileY[tile] + 0.5) * world)
        .addScaledVector(plane.toSun, this.top + 1);
      writeLightView(_viewInverse, plane, _eye);
      _projection.makeOrthographic(-half, half, half, -half, 1, 1 + span);
      const offset = frame.writeView({ projection: _projection, matrixWorldInverse: _viewInverse, eye: _eye, width: PAGE_TEXELS, height: PAGE_TEXELS, layers: this.layers, kind: 1, orthographic: true });
      offsets.push(offset);
      drawer.cullView(frame, offset, PAGE_KEYS[index]);
    }
    const pass = encoder.beginRenderPass({
      label: "gpu shadow pages",
      colorAttachments: [],
      depthStencilAttachment: { view: r.atlasView, depthLoadOp: "load", depthStoreOp: "store" },
    });
    for (let index = 0; index < drawing.length; index++) {
      const tile = drawing[index];
      const x = (tile % r.tilesPerSide) * PAGE_TEXELS;
      const y = Math.floor(tile / r.tilesPerSide) * PAGE_TEXELS;
      pass.setViewport(x, y, PAGE_TEXELS, PAGE_TEXELS, 0, 1);
      pass.setScissorRect(x, y, PAGE_TEXELS, PAGE_TEXELS);
      r.clearer.clear(pass);
      drawShadowDepth(frame, offsets[index], PAGE_KEYS[index], pass);
      r.tileState[tile] = PAGE_CLEAN;
      this.setTable(r, r.tileLevel[tile], this.slotOf(r.tileX[tile], r.tileY[tile]), tile + 1);
    }
    pass.end();
  }

  private uploadTable(r: Resources): void {
    for (let level = 0; level < LEVELS; level++) {
      const low = r.dirtyLow[level];
      const high = r.dirtyHigh[level];
      if (high < low) continue;
      const first = level * PAGES_PER_LEVEL + low;
      this.device.queue.writeBuffer(r.pageTable, first * 4, r.table, first, high - low + 1);
      r.dirtyLow[level] = PAGES_PER_LEVEL;
      r.dirtyHigh[level] = -1;
    }
  }

  private uploadParams(frame: GpuFrame, r: Resources): void {
    const { right, up, toSun } = this.plane;
    const projection = frame.camera.projectionMatrix.elements;
    const floats = paramFloats;
    _eye.setFromMatrixPosition(frame.camera.matrixWorld);
    floats[0] = right.x;
    floats[1] = right.y;
    floats[2] = right.z;
    floats[3] = this.pageSize;
    floats[4] = up.x;
    floats[5] = up.y;
    floats[6] = up.z;
    floats[7] = LEVELS;
    floats[8] = toSun.x;
    floats[9] = toSun.y;
    floats[10] = toSun.z;
    floats[11] = this.bottom;
    floats[12] = _eye.x;
    floats[13] = _eye.y;
    floats[14] = _eye.z;
    floats[15] = 2 / Math.max(Math.abs(projection[5]) * frame.targets.height, 1e-6);
    floats[16] = 1 / (this.top - this.bottom);
    floats[17] = r.tilesPerSide;
    floats[18] = this.levelBias;
    floats[19] = projection[15] === 0 ? 0 : 1;
    const offset = MARK_OFFSETS[frame.frameNumber % MARK_OFFSETS.length];
    paramWords[20] = offset[0];
    paramWords[21] = offset[1];
    for (let level = 0; level < LEVELS; level++) {
      paramInts[24 + level * 4] = this.origins[level * 2];
      paramInts[25 + level * 4] = this.origins[level * 2 + 1];
    }
    this.device.queue.writeBuffer(r.params, 0, floats);
  }

  /** Over this frame's depth: which pages it wants, on its way back to the CPU. Skipped if the way back is full. */
  private markPages(frame: GpuFrame, r: Resources): void {
    const readback = r.readbacks.find((entry) => entry.state === "free");
    if (!readback) return;
    const { encoder, targets } = frame;
    if (r.markDepth !== targets.depth.view || !r.markGroup) {
      r.markDepth = targets.depth.view;
      r.markGroup = this.device.createBindGroup({
        label: "gpu shadow page marks",
        layout: r.markLayout,
        entries: [
          { binding: 0, resource: { buffer: r.params } },
          { binding: 1, resource: targets.depth.view },
          { binding: 2, resource: { buffer: r.marks } },
        ],
      });
    }
    encoder.clearBuffer(r.marks);
    const pass = encoder.beginComputePass({ label: "gpu shadow page marks" });
    pass.setPipeline(r.markPipeline);
    pass.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    pass.setBindGroup(1, r.markGroup);
    const cells = MARK_STEP * MARK_WORKGROUP;
    pass.dispatchWorkgroups(Math.ceil(targets.width / cells), Math.ceil(targets.height / cells));
    pass.end();
    encoder.copyBufferToBuffer(r.marks, 0, readback.buffer, 0, MARK_WORDS * 4);
    readback.state = "copied";
  }
}
