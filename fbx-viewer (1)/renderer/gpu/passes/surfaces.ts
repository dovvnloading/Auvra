/// <reference types="@webgpu/types" />
import * as THREE from "three";
import type { GpuCore } from "../device";
import { TARGET_FORMATS, type GpuFrame, type GpuPass, type GpuTarget, type GpuViewDrawer } from "../frame";
import { DRAW_ARGS_WORDS, type DrawGroup, type GpuScene } from "../gpuScene";
import { LOD_BIND_GROUP, LOD_LAYOUT_ENTRIES, LOD_SELECT_WGSL } from "../lodSelect";
import type { MaterialEntry } from "../materialPool";
import { CAMERA_BINDINGS_WGSL, INSTANCE_WGSL, VIEW_WGSL, shadowShader, surfaceBufferShader } from "../shaders";
import type { SurfaceKind } from "../surfaces";
import { DepthPyramid, DepthPyramidPipelines, type DepthPyramidProduct } from "./depthPyramid";
import { reportGpu } from "../report";

/**
 * THE SURFACE PASS
 *
 * Decides on the graphics card what each view can see, then draws it. A compute shader walks the instance table and
 * writes, for each draw slot, how many rows survived and which: one indirect draw per slot then draws exactly those. A
 * slot is one detail level of a draw group, and the shader sends each row to the level its size on the screen calls for.
 *
 * The main view does this twice so that what is hidden is not drawn. The first round tests against last frame's depth
 * pyramid and draws what passes, which is nearly everything that will be seen. A pyramid is built from that new depth,
 * and the second round tests only what failed the first against it, drawing what turns out to be visible after all:
 * something that came out from behind a wall last frame's depth still shows. So last frame's picture can only ever
 * cost a late draw, never a missing object.
 *
 * The drawing is recorded once into render bundles and replayed every frame, because what is drawn changes in the
 * buffers the cull writes, not in the commands. Bundles are recorded again only when the commands themselves would be
 * different: new groups, a rebuilt material, a pipeline that became ready, a buffer that was replaced.
 *
 * One renderer can draw several scenes, and several cameras of one scene, in turn: the four editor views. Group
 * numbers belong to a scene and last frame's depth belongs to a camera, so what is kept here is kept per scene, and
 * the main view's pyramid and lists per camera within it. Only the compiled pipelines are shared by all of them.
 *
 * Other views (shadow cascades) use `cullView` and `drawDepth` from the stage they run in, with no occlusion test.
 *
 * Publishes in frame.products:
 *   "depthPyramid": DepthPyramidProduct, built from the finished surface buffer's depth, for this frame's camera.
 *   "surfaceStats": SurfaceStats, what the surface buffer could have drawn this frame, before culling.
 */

export interface SurfaceStats {
  /** Opaque triangle groups. */
  groups: number;
  /** Rows in those groups. */
  instances: number;
}

/**
 * Extra depth offset for `drawDepth`, as the pipeline takes it. Depth is reversed, so pushing a caster away from the
 * light takes negative numbers.
 */
export interface GpuDepthOptions {
  depthBias?: number;
  depthBiasSlopeScale?: number;
}

const CULL_WORKGROUP = 64;
const DRAW_ARGS_BYTES = DRAW_ARGS_WORDS * 4;
const ID_BYTES = 4;
/**
 * Frames a scene, camera or other view may go undrawn, such as a light switched off, before its buffers are freed.
 * Every editor view on screen is a frame of its own, so this is counted generously.
 */
const FORGET_AFTER = 600;
const GROWTH = 1.5;

const NO_BIAS: GpuDepthOptions = {};

// Comes first in a shader. A surface kind may take a derivative under a branch, and without this that one line stops
// the whole shader compiling, and everything of that kind is missing from the picture.
/** Is a sphere hidden behind what `pyramid` (a binding the shader declares) holds? */
export const OCCLUDED_WGSL = /* wgsl */ `
// Whether everything in the footprint of the bounds is nearer than the bounds' nearest point. The sphere is projected
// as the box around it, which works for any projection and is never smaller than the sphere; the extremes of a box
// under a projection are at its corners as long as all of it is in front of the eye. Anything unsure answers false.
fn occluded(clip: mat4x4f, sphere: vec4f) -> bool {
  let center = clip * vec4f(sphere.xyz, 1.0);
  let dx = clip[0] * sphere.w;
  let dy = clip[1] * sphere.w;
  let dz = clip[2] * sphere.w;
  var low = vec2f(1e30);
  var high = vec2f(-1e30);
  var nearest = 0.0;
  for (var corner = 0u; corner < 8u; corner++) {
    let p = center
      + dx * select(-1.0, 1.0, (corner & 1u) != 0u)
      + dy * select(-1.0, 1.0, (corner & 2u) != 0u)
      + dz * select(-1.0, 1.0, (corner & 4u) != 0u);
    // Behind the eye: the box wraps around the camera and has no footprint to test.
    if (p.w <= 1e-5) { return false; }
    let ndc = p.xyz / p.w;
    low = min(low, ndc.xy);
    high = max(high, ndc.xy);
    nearest = max(nearest, ndc.z);
  }
  // In front of the near plane.
  if (nearest >= 1.0) { return false; }

  let fullSize = vec2f(textureDimensions(pyramid, 0));
  // A pixel of margin: the pyramid was drawn with a camera jitter that the matrix being tested may not have.
  let margin = vec2f(1.0) / fullSize;
  var uvLow = vec2f(low.x, -high.y) * 0.5 + 0.5 - margin;
  var uvHigh = vec2f(high.x, -low.y) * 0.5 + 0.5 + margin;
  // Nothing on the screen to compare with.
  if (any(uvHigh <= vec2f(0.0)) || any(uvLow >= vec2f(1.0))) { return false; }
  uvLow = max(uvLow, vec2f(0.0));
  uvHigh = min(uvHigh, vec2f(1.0));

  // The level at which the footprint is no wider than a texel, so that it touches at most two across and two down. A
  // level's size is rounded down, which only makes its texels wider, so this holds on any screen size.
  let extent = (uvHigh - uvLow) * fullSize;
  let wanted = u32(ceil(log2(max(max(extent.x, extent.y), 1.0))));
  let level = min(wanted, textureNumLevels(pyramid) - 1u);
  let size = textureDimensions(pyramid, level);
  let last = size - vec2u(1u);
  let a = min(vec2u(uvLow * vec2f(size)), last);
  let b = min(vec2u(uvHigh * vec2f(size)), last);
  if (any(b - a > vec2u(1u))) { return false; }
  var farthest = textureLoad(pyramid, a, level).r;
  farthest = min(farthest, textureLoad(pyramid, vec2u(b.x, a.y), level).r);
  farthest = min(farthest, textureLoad(pyramid, vec2u(a.x, b.y), level).r);
  farthest = min(farthest, textureLoad(pyramid, b, level).r);
  // Reversed depth: a smaller number is farther away.
  return nearest < farthest;
}

`;

const DERIVATIVES_WGSL = "diagnostic(off, derivative_uniformity);\n";

// Only the instance table in group 1, not the frame's whole scene group: the cull reads no vertices, and with those two
// tables this would be ten storage buffers where WebGPU only promises eight, and a card with eight could not cull at all.
const CULL_WGSL = /* wgsl */ `
${VIEW_WGSL}${INSTANCE_WGSL}${CAMERA_BINDINGS_WGSL}

@group(1) @binding(0) var<storage, read> instances: array<Instance>;

struct DrawArgs {
  indexCount: u32,
  instanceCount: atomic<u32>,
  firstIndex: u32,
  baseVertex: i32,
  firstInstance: u32,
}

struct RetestList { count: atomic<u32>, rows: array<u32> }
struct RetestDispatch { x: atomic<u32>, y: u32, z: u32 }
struct RetestRows { count: u32, rows: array<u32> }

@group(2) @binding(0) var<storage, read_write> args: array<DrawArgs>;
@group(2) @binding(1) var<storage, read_write> visible: array<u32>;
@group(2) @binding(2) var<storage, read> groupFirst: array<u32>;
@group(2) @binding(3) var pyramid: texture_2d<f32>;
@group(2) @binding(4) var<storage, read_write> retest: RetestList;
@group(2) @binding(5) var<storage, read_write> retestDispatch: RetestDispatch;
@group(2) @binding(6) var<storage, read> retestRows: RetestRows;
${LOD_SELECT_WGSL}
// Into the run of the detail level this row's size on the screen calls for.
fn append(row: u32) {
  let instance = instances[row];
  let run = pickSlot(instance, instance.group);
  let slot = atomicAdd(&args[run].instanceCount, 1u);
  visible[groupFirst[run] + slot] = row;
}

fn viewTakes(flags: u32, layers: u32) -> bool {
  if ((flags & INSTANCE_ACTIVE) == 0u) { return false; }
  if ((layers & view.layers) == 0u) { return false; }
  if (view.kind == 1u && (flags & INSTANCE_CASTS_SHADOW) == 0u) { return false; }
  if (view.kind == 0u && (flags & INSTANCE_CLUSTERED) != 0u) { return false; }
  return true;
}

fn inFrustum(sphere: vec4f) -> bool {
  let count = min(view.planeCount, 6u);
  for (var index = 0u; index < count; index++) {
    let plane = view.planes[index];
    if (dot(plane.xyz, sphere.xyz) + plane.w < -sphere.w) { return false; }
  }
  return true;
}

${OCCLUDED_WGSL}
// Every row by frustum alone: shadow views and any other view without a pyramid.
@compute @workgroup_size(${CULL_WORKGROUP}) fn cullAll(@builtin(global_invocation_id) id: vec3u) {
  let row = id.x;
  // The last workgroup runs past the rows in use, and possibly past the end of the table.
  if (row >= arrayLength(&instances)) { return; }
  let flags = instances[row].flags;
  if (!viewTakes(flags, instances[row].layers)) { return; }
  if ((flags & INSTANCE_ALWAYS_VISIBLE) == 0u && !inFrustum(instances[row].sphere)) { return; }
  append(row);
}

// Round one of the main view: where this row's bounds are now, against the depth the camera saw last frame.
@compute @workgroup_size(${CULL_WORKGROUP}) fn cullEarly(@builtin(global_invocation_id) id: vec3u) {
  let row = id.x;
  if (row >= arrayLength(&instances)) { return; }
  let flags = instances[row].flags;
  if (!viewTakes(flags, instances[row].layers)) { return; }
  if ((flags & INSTANCE_ALWAYS_VISIBLE) == 0u) {
    let sphere = instances[row].sphere;
    if (!inFrustum(sphere)) { return; }
    if (occluded(view.previousViewProjection, sphere)) {
      let at = atomicAdd(&retest.count, 1u);
      retest.rows[at] = row;
      // The second round only runs as many workgroups as this list needs.
      atomicMax(&retestDispatch.x, at / ${CULL_WORKGROUP}u + 1u);
      return;
    }
  }
  append(row);
}

// Round two: what round one held back, against the depth just drawn.
@compute @workgroup_size(${CULL_WORKGROUP}) fn cullLate(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= retestRows.count) { return; }
  let row = retestRows.rows[id.x];
  if (occluded(view.viewProjection, instances[row].sphere)) { return; }
  append(row);
}
`;

/** The one vertex buffer: each drawn instance's row number, from the group's run of the visible list. */
const INSTANCE_ID_LAYOUT: GPUVertexBufferLayout[] = [{
  arrayStride: ID_BYTES,
  stepMode: "instance",
  attributes: [{ shaderLocation: 0, offset: 0, format: "uint32" }],
}];

const SURFACE_FORMATS: GPUTextureFormat[] = [TARGET_FORMATS.albedo, TARGET_FORMATS.normal, TARGET_FORMATS.emissive, TARGET_FORMATS.motion];

const isSurfaceGroup = (group: DrawGroup): boolean => !group.forward && group.topology === "triangle-list";

const fourBytes = (bytes: number): number => Math.max(ID_BYTES, Math.ceil(bytes / ID_BYTES) * ID_BYTES);

/**
 * Which faces a shadow view draws, as three.js chooses them so that the two renderers agree: the material's
 * `shadowSide`, or otherwise the far side of what it shows, which keeps a lit surface from shadowing itself.
 */
const shadowCull = ({ material, state }: MaterialEntry): GPUCullMode => {
  const side = material.shadowSide;
  if (side === null || side === undefined) return state.cull === "back" ? "front" : state.cull === "front" ? "back" : "none";
  return side === THREE.DoubleSide ? "none" : side === THREE.BackSide ? "front" : "back";
};

interface PipelineEntry {
  /** Creation order, what draws are sorted by. */
  id: number;
  /** Null until the driver has finished compiling it, and for good if that failed. */
  pipeline: GPURenderPipeline | null;
  /** A depth-only pipeline that runs no surface code needs no material. */
  bindsMaterial: boolean;
  masked: boolean;
}

interface RecordedBundle {
  bundle: GPURenderBundle | null;
  layout: number;
  geometry: number;
  instanceBuffer: number;
  materials: number;
  pipelines: number;
  list: number;
  viewOffset: number;
  camera: GPUBindGroup;
}

interface CachedGroup {
  token: number;
  group: GPUBindGroup | null;
}

const cachedGroup = (slot: CachedGroup, token: number, make: () => GPUBindGroup): GPUBindGroup => {
  if (!slot.group || slot.token !== token) {
    slot.group = make();
    slot.token = token;
  }
  return slot.group;
};

/** One view's cull output: an indirect draw for every slot, and every slot's run of visible rows. */
class CullList {
  args: GPUBuffer;
  visible: GPUBuffer;
  /** Goes up when either buffer is replaced. */
  revision = 0;
  lastUsed = 0;
  readonly plainGroup: CachedGroup = { token: -1, group: null };
  readonly occlusionGroup: CachedGroup = { token: -1, group: null };
  surfaceBundle: RecordedBundle | null = null;
  readonly depthBundles = new Map<string, RecordedBundle>();

  constructor(private readonly device: GPUDevice, private readonly label: string, gpuScene: GpuScene) {
    // At least one entry: an empty scene still binds these, and the shader will not take a buffer too short for one.
    this.args = this.makeArgs(Math.max(gpuScene.slotCount, 1) * DRAW_ARGS_BYTES);
    this.visible = this.makeVisible(fourBytes(gpuScene.visibleCapacity * ID_BYTES));
  }

  private makeArgs(size: number): GPUBuffer {
    return this.device.createBuffer({ label: `gpu draw args ${this.label}`, size, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  private makeVisible(size: number): GPUBuffer {
    return this.device.createBuffer({ label: `gpu visible rows ${this.label}`, size, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE });
  }

  /**
   * Makes room for the scene's slots as they are now and sets every one back to no instances. The arguments are taken
   * from the scene's table every frame because they can change there with no new layout, as a terrain chunk's indices do.
   */
  reset(encoder: GPUCommandEncoder, gpuScene: GpuScene): void {
    const argBytes = gpuScene.slotCount * DRAW_ARGS_BYTES;
    const listBytes = gpuScene.visibleCapacity * ID_BYTES;
    if (argBytes > this.args.size) {
      const size = fourBytes(Math.max(argBytes, this.args.size * GROWTH));
      this.args.destroy();
      this.args = this.makeArgs(size);
      this.revision++;
    }
    if (listBytes > this.visible.size) {
      const size = fourBytes(Math.max(listBytes, this.visible.size * GROWTH));
      this.visible.destroy();
      this.visible = this.makeVisible(size);
      this.revision++;
    }
    if (argBytes) encoder.copyBufferToBuffer(gpuScene.drawTemplate.buffer, 0, this.args, 0, argBytes);
  }

  destroy(): void {
    this.args.destroy();
    this.visible.destroy();
  }
}

/** What one camera of one scene keeps from frame to frame. */
class MainView {
  readonly pyramid: DepthPyramid;
  readonly early: CullList;
  readonly late: CullList;
  /** Rows the first round held back. */
  retest: GPUBuffer | null = null;
  retestGeneration = 0;
  /** Indirect dispatch of the second round. Apart from the list because it may not be written while it is dispatching. */
  readonly retestDispatch: GPUBuffer;
  lastUsed = 0;

  constructor(private readonly device: GPUDevice, pipelines: DepthPyramidPipelines, frame: GpuFrame) {
    this.pyramid = new DepthPyramid(device, pipelines, frame.targets.width, frame.targets.height);
    this.early = new CullList(device, "main", frame.gpuScene);
    this.late = new CullList(device, "main late", frame.gpuScene);
    this.retestDispatch = device.createBuffer({
      label: "gpu retest dispatch",
      size: 12,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    // Only the width is ever cleared and grown; the other two stay one.
    new Uint32Array(this.retestDispatch.getMappedRange()).set([0, 1, 1]);
    this.retestDispatch.unmap();
  }

  /** An empty retest list with room for every row. */
  resetRetest(encoder: GPUCommandEncoder, rows: number): GPUBuffer {
    // The count and at least one row, for the same reason as a list's arguments.
    const bytes = ID_BYTES + Math.max(rows, 1) * ID_BYTES;
    if (!this.retest || bytes > this.retest.size) {
      const size = fourBytes(Math.max(bytes, (this.retest?.size ?? 0) * GROWTH));
      this.retest?.destroy();
      this.retest = this.device.createBuffer({ label: "gpu retest rows", size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.retestGeneration++;
    }
    encoder.clearBuffer(this.retest, 0, ID_BYTES);
    encoder.clearBuffer(this.retestDispatch, 0, ID_BYTES);
    return this.retest;
  }

  destroy(): void {
    this.pyramid.destroy();
    this.early.destroy();
    this.late.destroy();
    this.retest?.destroy();
    this.retestDispatch.destroy();
  }
}

/** Everything kept for one scene: group numbers and layouts mean nothing to another. */
class SceneState {
  readonly mainViews = new Map<THREE.Camera, MainView>();
  /** Shadow views and the like, by the key their pass gives them. */
  readonly views = new Map<string, CullList>();
  readonly stats: SurfaceStats = { groups: 0, instances: 0 };
  /** The scene's instance table as the cull binds it. */
  readonly rowsGroup: CachedGroup = { token: -1, group: null };
  materialStamp = 0;
  stampFrame = -1;
  lastUsed = 0;

  /** The material stamp bundles compare with and the stats, worked out once a frame however many views ask. */
  stamp(frame: GpuFrame): void {
    this.lastUsed = frame.frameNumber;
    if (this.stampFrame === frame.frameNumber) return;
    this.stampFrame = frame.frameNumber;
    let materials = 0;
    let groups = 0;
    let instances = 0;
    for (const group of frame.gpuScene.groupList) {
      // Revisions only go up, so the sum over the same groups moves whenever any one does; other groups mean a new layout.
      materials += group.material.revision;
      if (isSurfaceGroup(group)) {
        groups++;
        instances += group.instances;
      }
    }
    this.materialStamp = materials;
    this.stats.groups = groups;
    this.stats.instances = instances;
  }

  forgetIdle(frameNumber: number): void {
    for (const [camera, main] of this.mainViews) {
      if (frameNumber - main.lastUsed > FORGET_AFTER) {
        main.destroy();
        this.mainViews.delete(camera);
      }
    }
    for (const [key, list] of this.views) {
      if (frameNumber - list.lastUsed > FORGET_AFTER) {
        list.destroy();
        this.views.delete(key);
      }
    }
  }

  destroy(): void {
    for (const main of this.mainViews.values()) main.destroy();
    for (const list of this.views.values()) list.destroy();
    this.mainViews.clear();
    this.views.clear();
  }
}

interface CullPipelines {
  rowsLayout: GPUBindGroupLayout;
  plainLayout: GPUBindGroupLayout;
  earlyLayout: GPUBindGroupLayout;
  lateLayout: GPUBindGroupLayout;
  all: GPUComputePipeline;
  early: GPUComputePipeline;
  late: GPUComputePipeline;
}

export class SurfacePass implements GpuPass, GpuViewDrawer {
  readonly id = "surfaces";
  readonly stage = "surfaces" as const;
  readonly order = 0;

  private readonly device: GPUDevice;
  private readonly pyramidPipelines: DepthPyramidPipelines;
  /** A map rather than a weak one so that a scene no longer drawn has its GPU memory given back at a known time. */
  private readonly scenes = new Map<GpuScene, SceneState>();
  private cull: CullPipelines | null = null;
  private readonly modules = new Map<string, GPUShaderModule>();
  private readonly pipelineLayouts = new Map<string, GPUPipelineLayout>();
  private readonly pipelines = new Map<string, PipelineEntry>();
  private pipelineRevision = 0;
  private nextPipelineId = 0;

  constructor(private readonly core: GpuCore) {
    this.device = core.device;
    this.pyramidPipelines = new DepthPyramidPipelines(core.device);
  }

  execute(frame: GpuFrame): void {
    const { encoder, gpuScene, targets, mainViewOffset } = frame;
    const state = this.sceneState(frame);
    this.forgetIdle(frame.frameNumber);
    const main = this.mainView(frame, state);
    const { pyramid, early, late } = main;
    pyramid.ensure(targets.width, targets.height);

    const cull = this.cullPipelines(frame);
    early.reset(encoder, gpuScene);
    // A new pyramid has nothing in it, and so no round two: everything in the frustum simply draws.
    const history = pyramid.built;
    const rowGroups = Math.ceil(gpuScene.instanceCount / CULL_WORKGROUP);
    const retest = history ? main.resetRetest(encoder, gpuScene.instanceCount) : null;

    const round1 = this.beginCull(frame, state, cull, "gpu cull main", mainViewOffset);
    if (retest) {
      round1.setPipeline(cull.early);
      round1.setBindGroup(2, this.earlyGroup(frame, cull, main, retest));
    } else {
      round1.setPipeline(cull.all);
      round1.setBindGroup(2, this.plainGroup(frame, cull, early));
    }
    round1.dispatchWorkgroups(rowGroups);
    round1.end();
    this.drawSurfaces(frame, state, early, "clear");

    if (retest) {
      pyramid.build(encoder, targets.depth.view);
      late.reset(encoder, gpuScene);
      const round2 = this.beginCull(frame, state, cull, "gpu cull main late", mainViewOffset);
      round2.setPipeline(cull.late);
      round2.setBindGroup(2, this.lateGroup(frame, cull, main, retest));
      round2.dispatchWorkgroupsIndirect(main.retestDispatch, 0);
      round2.end();
      this.drawSurfaces(frame, state, late, "load");
    }

    // What the second round drew belongs in the pyramid too, for next frame's first round and for this frame's readers.
    pyramid.build(encoder, targets.depth.view);
    const product: DepthPyramidProduct = { view: pyramid.view, mips: pyramid.mips };
    frame.products.set("depthPyramid", product);
    frame.products.set("surfaceStats", state.stats);
  }

  cullView(frame: GpuFrame, viewOffset: number, viewKey: string): void {
    const state = this.sceneState(frame);
    let list = state.views.get(viewKey);
    if (!list) {
      list = new CullList(this.device, viewKey, frame.gpuScene);
      state.views.set(viewKey, list);
    }
    list.lastUsed = frame.frameNumber;
    list.reset(frame.encoder, frame.gpuScene);
    const cull = this.cullPipelines(frame);
    const pass = this.beginCull(frame, state, cull, `gpu cull ${viewKey}`, viewOffset);
    pass.setPipeline(cull.all);
    pass.setBindGroup(2, this.plainGroup(frame, cull, list));
    pass.dispatchWorkgroups(Math.ceil(frame.gpuScene.instanceCount / CULL_WORKGROUP));
    pass.end();
  }

  /** The last argument is beyond the frame contract: leave it out for no offset but the material's own. */
  drawDepth(frame: GpuFrame, viewOffset: number, viewKey: string, pass: GPURenderPassEncoder, depthFormat: GPUTextureFormat, options: GpuDepthOptions = NO_BIAS): void {
    const state = this.sceneState(frame);
    const list = state.views.get(viewKey);
    if (!list) return;
    const bias = options.depthBias ?? 0;
    const slope = options.depthBiasSlopeScale ?? 0;
    const key = `${depthFormat}|${bias}|${slope}`;
    let recorded = list.depthBundles.get(key);
    if (!recorded || this.isStale(recorded, frame, state, list, viewOffset)) {
      recorded = this.record(frame, state, list, viewOffset, { label: `gpu depth ${viewKey}`, colorFormats: [], depthStencilFormat: depthFormat }, (group) => {
        // Lines, points and sprites have no shadow. A transparent surface does, as in three.js.
        if (group.topology !== "triangle-list" || group.forwardKind) return null;
        return this.depthEntry(frame, group, depthFormat, bias, slope);
      });
      list.depthBundles.set(key, recorded);
    }
    if (recorded.bundle) pass.executeBundles([recorded.bundle]);
  }

  dispose(): void {
    for (const state of this.scenes.values()) state.destroy();
    this.scenes.clear();
  }

  private sceneState(frame: GpuFrame): SceneState {
    let state = this.scenes.get(frame.gpuScene);
    if (!state) {
      state = new SceneState();
      this.scenes.set(frame.gpuScene, state);
    }
    state.stamp(frame);
    return state;
  }

  private mainView(frame: GpuFrame, state: SceneState): MainView {
    let main = state.mainViews.get(frame.camera);
    if (!main) {
      main = new MainView(this.device, this.pyramidPipelines, frame);
      state.mainViews.set(frame.camera, main);
    }
    main.lastUsed = frame.frameNumber;
    return main;
  }

  private forgetIdle(frameNumber: number): void {
    for (const [gpuScene, state] of this.scenes) {
      if (frameNumber - state.lastUsed > FORGET_AFTER) {
        state.destroy();
        this.scenes.delete(gpuScene);
      } else {
        state.forgetIdle(frameNumber);
      }
    }
  }

  private cullPipelines(frame: GpuFrame): CullPipelines {
    if (this.cull) return this.cull;
    const { device } = this;
    const visibility = GPUShaderStage.COMPUTE;
    const rowsLayout = device.createBindGroupLayout({ label: "gpu cull rows", entries: [{ binding: 0, visibility, buffer: { type: "read-only-storage" } }] });
    // Made here rather than taken from a scene: every scene's detail tables are bound with the same shape of layout.
    const lodLayout = device.createBindGroupLayout({ label: "gpu cull detail levels", entries: LOD_LAYOUT_ENTRIES });
    const lists: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility, buffer: { type: "storage" } },
      { binding: 1, visibility, buffer: { type: "storage" } },
      { binding: 2, visibility, buffer: { type: "read-only-storage" } },
    ];
    const pyramid: GPUBindGroupLayoutEntry = { binding: 3, visibility, texture: { sampleType: "unfilterable-float" } };
    const plainLayout = device.createBindGroupLayout({ label: "gpu cull", entries: lists });
    const earlyLayout = device.createBindGroupLayout({
      label: "gpu cull early",
      entries: [...lists, pyramid, { binding: 4, visibility, buffer: { type: "storage" } }, { binding: 5, visibility, buffer: { type: "storage" } }],
    });
    const lateLayout = device.createBindGroupLayout({
      label: "gpu cull late",
      entries: [...lists, pyramid, { binding: 6, visibility, buffer: { type: "read-only-storage" } }],
    });
    const module = device.createShaderModule({ label: "gpu cull", code: CULL_WGSL });
    const make = (entryPoint: string, layout: GPUBindGroupLayout) => device.createComputePipeline({
      label: `gpu ${entryPoint}`,
      layout: device.createPipelineLayout({ bindGroupLayouts: [frame.cameraLayout, rowsLayout, layout, lodLayout] }),
      compute: { module, entryPoint },
    });
    this.cull = {
      rowsLayout,
      plainLayout,
      earlyLayout,
      lateLayout,
      all: make("cullAll", plainLayout),
      early: make("cullEarly", earlyLayout),
      late: make("cullLate", lateLayout),
    };
    return this.cull;
  }

  private listEntries(frame: GpuFrame, list: CullList): GPUBindGroupEntry[] {
    return [
      { binding: 0, resource: { buffer: list.args } },
      { binding: 1, resource: { buffer: list.visible } },
      { binding: 2, resource: { buffer: frame.gpuScene.groupFirst.buffer } },
    ];
  }

  private plainGroup(frame: GpuFrame, cull: CullPipelines, list: CullList): GPUBindGroup {
    const token = list.revision + frame.gpuScene.groupFirst.generation;
    return cachedGroup(list.plainGroup, token, () => this.device.createBindGroup({
      label: "gpu cull",
      layout: cull.plainLayout,
      entries: this.listEntries(frame, list),
    }));
  }

  private earlyGroup(frame: GpuFrame, cull: CullPipelines, main: MainView, retest: GPUBuffer): GPUBindGroup {
    const list = main.early;
    const token = list.revision + frame.gpuScene.groupFirst.generation + main.pyramid.generation + main.retestGeneration;
    return cachedGroup(list.occlusionGroup, token, () => this.device.createBindGroup({
      label: "gpu cull early",
      layout: cull.earlyLayout,
      entries: [
        ...this.listEntries(frame, list),
        { binding: 3, resource: main.pyramid.view },
        { binding: 4, resource: { buffer: retest } },
        { binding: 5, resource: { buffer: main.retestDispatch } },
      ],
    }));
  }

  private lateGroup(frame: GpuFrame, cull: CullPipelines, main: MainView, retest: GPUBuffer): GPUBindGroup {
    const list = main.late;
    const token = list.revision + frame.gpuScene.groupFirst.generation + main.pyramid.generation + main.retestGeneration;
    return cachedGroup(list.occlusionGroup, token, () => this.device.createBindGroup({
      label: "gpu cull late",
      layout: cull.lateLayout,
      entries: [
        ...this.listEntries(frame, list),
        { binding: 3, resource: main.pyramid.view },
        { binding: 6, resource: { buffer: retest } },
      ],
    }));
  }

  private beginCull(frame: GpuFrame, state: SceneState, cull: CullPipelines, label: string, viewOffset: number): GPUComputePassEncoder {
    const { gpuScene } = frame;
    const rows = cachedGroup(state.rowsGroup, gpuScene.instanceBuffer.generation, () => this.device.createBindGroup({
      label: "gpu cull rows",
      layout: cull.rowsLayout,
      entries: [{ binding: 0, resource: { buffer: gpuScene.instanceBuffer.buffer } }],
    }));
    const pass = frame.encoder.beginComputePass({ label });
    pass.setBindGroup(0, frame.cameraBindGroup, [viewOffset]);
    pass.setBindGroup(1, rows);
    pass.setBindGroup(LOD_BIND_GROUP, gpuScene.lodBindGroup);
    return pass;
  }

  private drawSurfaces(frame: GpuFrame, state: SceneState, list: CullList, loadOp: GPULoadOp): void {
    const { targets, mainViewOffset } = frame;
    const colour = (target: GpuTarget): GPURenderPassColorAttachment => ({ view: target.view, loadOp, storeOp: "store", clearValue: [0, 0, 0, 0] });
    const pass = frame.encoder.beginRenderPass({
      label: loadOp === "clear" ? "gpu surfaces" : "gpu surfaces late",
      colorAttachments: [colour(targets.albedo), colour(targets.normal), colour(targets.emissive), colour(targets.motion)],
      depthStencilAttachment: { view: targets.depth.view, depthLoadOp: loadOp, depthStoreOp: "store", depthClearValue: 0 },
    });
    if (!list.surfaceBundle || this.isStale(list.surfaceBundle, frame, state, list, mainViewOffset)) {
      list.surfaceBundle = this.record(frame, state, list, mainViewOffset, { label: "gpu surfaces", colorFormats: SURFACE_FORMATS, depthStencilFormat: TARGET_FORMATS.depth }, (group) =>
        isSurfaceGroup(group) ? this.surfaceEntry(frame, group) : null);
    }
    if (list.surfaceBundle.bundle) pass.executeBundles([list.surfaceBundle.bundle]);
    pass.end();
  }

  /**
   * The frame's scene bind group is not compared. The renderer may make a new one each time it turns to another scene,
   * over the same buffers; the generations here are what say the buffers themselves have changed.
   */
  private isStale(recorded: RecordedBundle, frame: GpuFrame, state: SceneState, list: CullList, viewOffset: number): boolean {
    return recorded.layout !== frame.gpuScene.layoutRevision
      || recorded.geometry !== frame.geometries.generation
      || recorded.instanceBuffer !== frame.gpuScene.instanceBuffer.generation
      || recorded.materials !== state.materialStamp
      || recorded.pipelines !== this.pipelineRevision
      || recorded.list !== list.revision
      // A bundle holds its bind groups and dynamic offset, and cannot take them from the pass it runs in.
      || recorded.viewOffset !== viewOffset
      || recorded.camera !== frame.cameraBindGroup;
  }

  /** One bundle for a view's chosen groups, sorted so that pipelines and materials change as seldom as they can. */
  private record(
    frame: GpuFrame,
    state: SceneState,
    list: CullList,
    viewOffset: number,
    descriptor: GPURenderBundleEncoderDescriptor,
    choose: (group: DrawGroup) => PipelineEntry | null,
  ): RecordedBundle {
    const draws: { group: DrawGroup; entry: PipelineEntry }[] = [];
    for (const group of frame.gpuScene.groupList) {
      const entry = choose(group);
      // Not compiled yet, or the material has not been bound yet: it joins when the bundle is next recorded.
      if (!entry?.pipeline || (entry.bindsMaterial && !group.material.bindGroup)) continue;
      draws.push({ group, entry });
    }
    // Holes last: they are drawn the most slowly, and whatever is already in front of them saves them the work.
    draws.sort((a, b) => Number(a.entry.masked) - Number(b.entry.masked) || a.entry.id - b.entry.id || a.group.material.slot - b.group.material.slot);

    let bundle: GPURenderBundle | null = null;
    if (draws.length) {
      const encoder = this.device.createRenderBundleEncoder(descriptor);
      encoder.setBindGroup(0, frame.cameraBindGroup, [viewOffset]);
      encoder.setBindGroup(1, frame.sceneBindGroup);
      encoder.setIndexBuffer(frame.geometries.indices.buffer, "uint32");
      let pipeline: GPURenderPipeline | null = null;
      let material: GPUBindGroup | null = null;
      for (const { group, entry } of draws) {
        if (entry.pipeline !== pipeline) {
          pipeline = entry.pipeline;
          encoder.setPipeline(pipeline!);
        }
        if (entry.bindsMaterial && group.material.bindGroup !== material) {
          material = group.material.bindGroup;
          encoder.setBindGroup(2, material);
        }
        // One draw per detail level, each over its own run of the visible list.
        for (const slot of group.slots) {
          encoder.setVertexBuffer(0, list.visible, slot.firstVisible * ID_BYTES);
          encoder.drawIndexedIndirect(list.args, slot.slot * DRAW_ARGS_BYTES);
        }
      }
      bundle = encoder.finish({ label: descriptor.label });
    }
    return {
      bundle,
      layout: frame.gpuScene.layoutRevision,
      geometry: frame.geometries.generation,
      instanceBuffer: frame.gpuScene.instanceBuffer.generation,
      materials: state.materialStamp,
      pipelines: this.pipelineRevision,
      list: list.revision,
      viewOffset,
      camera: frame.cameraBindGroup,
    };
  }

  private module(key: string, code: () => string): GPUShaderModule {
    let module = this.modules.get(key);
    if (!module) {
      module = this.device.createShaderModule({ label: `gpu ${key}`, code: code() });
      this.modules.set(key, module);
    }
    return module;
  }

  /** Camera and scene, and the kind's material group when there is a kind. */
  private pipelineLayout(frame: GpuFrame, kind: SurfaceKind | null): GPUPipelineLayout {
    const key = kind?.id ?? "";
    let layout = this.pipelineLayouts.get(key);
    if (!layout) {
      layout = this.device.createPipelineLayout({
        label: `gpu surface ${key}`,
        bindGroupLayouts: kind ? [frame.cameraLayout, frame.sceneLayout, frame.materials.layoutFor(kind)] : [frame.cameraLayout, frame.sceneLayout],
      });
      this.pipelineLayouts.set(key, layout);
    }
    return layout;
  }

  /** The pipeline for a key, starting its compile the first time it is asked for. */
  private pipelineEntry(key: string, bindsMaterial: boolean, masked: boolean, describe: () => GPURenderPipelineDescriptor): PipelineEntry {
    const known = this.pipelines.get(key);
    if (known) return known;
    const entry: PipelineEntry = { id: this.nextPipelineId++, pipeline: null, bindsMaterial, masked };
    this.pipelines.set(key, entry);
    this.device.createRenderPipelineAsync(describe()).then((pipeline) => {
      entry.pipeline = pipeline;
      this.pipelineRevision++;
    }).catch((error: unknown) => {
      reportGpu(`[gpu] pipeline ${key} failed`, error);
    });
    return entry;
  }

  private surfaceEntry(frame: GpuFrame, group: DrawGroup): PipelineEntry {
    const { kind, state } = group.material;
    // A polygon offset pushes away from the eye, and with reversed depth that is towards smaller numbers.
    const depthBias = Math.round(-state.depthBias);
    const depthBiasSlopeScale = -state.depthBiasSlope;
    const key = `surface|${kind.id}|${state.masked ? 1 : 0}|${state.cull}|${depthBias}|${depthBiasSlopeScale}`;
    return this.pipelineEntry(key, true, state.masked, () => {
      const module = this.module(`surface ${kind.id}`, () => `${DERIVATIVES_WGSL}${surfaceBufferShader(kind)}`);
      return {
        label: `gpu ${key}`,
        layout: this.pipelineLayout(frame, kind),
        vertex: { module, entryPoint: "vertexMain", buffers: INSTANCE_ID_LAYOUT },
        fragment: { module, entryPoint: "fragmentMain", targets: SURFACE_FORMATS.map((format) => ({ format })) },
        primitive: { topology: "triangle-list", cullMode: state.cull, frontFace: "ccw" },
        depthStencil: { format: TARGET_FORMATS.depth, depthWriteEnabled: true, depthCompare: "greater", depthBias, depthBiasSlopeScale },
      };
    });
  }

  private depthEntry(frame: GpuFrame, group: DrawGroup, format: GPUTextureFormat, bias: number, slope: number): PipelineEntry {
    const { kind, state } = group.material;
    const runsSurface = state.masked || !!kind.displaces;
    const cullMode = shadowCull(group.material);
    const depthBias = Math.round(bias - state.depthBias);
    const depthBiasSlopeScale = slope - state.depthBiasSlope;
    // Without surface code every kind compiles to the same shader, so they all share these pipelines and draw together.
    const key = `depth|${runsSurface ? kind.id : ""}|${state.masked ? 1 : 0}|${cullMode}|${format}|${depthBias}|${depthBiasSlopeScale}`;
    return this.pipelineEntry(key, runsSurface, state.masked, () => {
      const module = runsSurface
        ? this.module(`depth ${kind.id} ${state.masked ? "masked" : "solid"}`, () => `${DERIVATIVES_WGSL}${shadowShader(kind, state.masked)}`)
        : this.module("depth plain", () => shadowShader(kind, false));
      return {
        label: `gpu ${key}`,
        layout: this.pipelineLayout(frame, runsSurface ? kind : null),
        vertex: { module, entryPoint: "vertexMain", buffers: INSTANCE_ID_LAYOUT },
        fragment: runsSurface ? { module, entryPoint: "fragmentMain", targets: [] } : undefined,
        // Where the card allows it, a caster between the light and the map's near plane is flattened onto the map
        // rather than cut away, which would leave a hole in its shadow.
        primitive: { topology: "triangle-list", cullMode, frontFace: "ccw", unclippedDepth: this.core.features.depthClipControl },
        depthStencil: { format, depthWriteEnabled: true, depthCompare: "greater", depthBias, depthBiasSlopeScale },
      };
    });
  }
}
