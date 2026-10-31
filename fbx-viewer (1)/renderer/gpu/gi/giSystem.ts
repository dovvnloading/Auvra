/// <reference types="@webgpu/types" />
import * as THREE from "three";
import {
  ATLAS_HEIGHT,
  ATLAS_WIDTH,
  CASCADE_RATIO,
  GI_CASCADES,
  GI_QUALITY,
  MAX_PROBES_PER_FRAME,
  MAX_RAYS_PER_PROBE,
  PROBES_PER_CASCADE,
  ProbeCascade,
  sphericalFibonacci,
  type DynamicGiSettings,
  type ScheduledProbe,
} from "../../../runtime/lighting/dynamicGi/probeGrid";
import type { RayFilter } from "../../../runtime/raytracing/rayScene";
import type { GpuFrame, GpuPass } from "../frame";
import type { LightingProduct } from "../lightingWgsl";
import type { SkyEnvironmentProduct } from "../sky/skySettings";
import type { GiProbesProduct, GiProduct } from "./giScreen";
import { GiLighting } from "./giShared";
import {
  BALL_VERTICES,
  CLEAR_WGSL,
  INTEGRATE_WGSL,
  LIGHTING_VIEW_WGSL,
  PROBE_BYTES,
  PROBE_RAY_BYTES,
  PROBE_VIEW_WGSL,
  RAY_VIEW_WGSL,
  REFLECTION_COMPOSE_WGSL,
  REFLECTION_RAYS_WGSL,
  REFLECTION_SMOOTH_WGSL,
  SCRATCH_STRIDE,
  STORE_WGSL,
  TRACE_RAYS_WORKGROUP,
  TRACE_WGSL,
} from "./giWgsl";
import { GpuRayScene, type PosedVertexLookup } from "./rayTables";
import { TextureMeans } from "./textureMeans";

/**
 * DYNAMIC GLOBAL ILLUMINATION
 *
 * Light that bounces around a level as it is now: every frame a few hundred probes around the camera send rays through
 * the ray scene (rayTables.ts) in compute, and the pixels read what they gather (giScreen.ts). So it needs no bake and
 * takes in what is off screen: turn from a sunlit red wall and the floor stays tinted; move the sun, a lamp or a wall and
 * the room follows within a second or so.
 *
 * The probes are where runtime/lighting/dynamicGi/probeGrid.ts says, with the same settings as ever.
 *
 * Passes, in frame order:
 *   gathering   "prepare" order 100, after skinning: refits the trees, traces, integrates, stores.
 *   reflections "afterSurfaces" order 40: rays for glossy pixels.
 *   compose     "afterLighting" order 20: the change reflections make to the lit picture.
 *   view        "afterLighting" order 90: only when a level asks to see the light itself.
 *
 * Writes:
 *   "giProbes" = `GiProbesProduct`, for giScreen.ts.
 *   "rayReflections" = `RayReflectionsProduct`, while rays are drawing reflections.
 * Reads "environment", "lighting", "ao" and the screen's reflections, each if there.
 */

/** Half-size rgba16float: what rays saw in rgb, and in a how much of the environment's reflection that takes the place of. */
export interface RayReflectionsProduct {
  view: GPUTextureView;
}

/** What the level says each frame; the component changes it in place. */
export interface GiRun {
  settings: DynamicGiSettings;
  include: RayFilter;
  /** Whether rays draw reflections: only as the level is meant to look, and not on a machine running slow. */
  reflections: boolean;
  /** Goes up once per frame the page draws: several views of one level gather once between them. */
  tick: number;
}

/**
 * Seconds a large change takes to settle at each cascade. Light carries on bouncing through what the probes hold, so a
 * room takes a few of these to fill or to drain.
 */
const SETTLE_SECONDS = 0.5;
/** How many ticks an orthographic view waits before gathering in place of a perspective one that has stopped. */
const ORTHOGRAPHIC_PATIENCE = 30;
const CLEAR_CAPACITY = GI_CASCADES * PROBES_PER_CASCADE;
/** Frames per second are smoothed so a hitch does not lurch the light. */
const FPS_SMOOTHING = 0.05;
const COMPUTE = GPUShaderStage.COMPUTE;

const read = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: COMPUTE, buffer: { type: "read-only-storage" } });
const write = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: COMPUTE, buffer: { type: "storage" } });
const uniform = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: COMPUTE, buffer: { type: "uniform" } });
const atlasWrite = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } });

const _position = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();

/** Where a posed mesh's vertices are this frame, from the scene's list of them, made only if it is asked. */
const posedLookupOf = (frame: GpuFrame): PosedVertexLookup => {
  let table: Map<THREE.Object3D, number> | null = null;
  return (mesh) => {
    if (!table) {
      table = new Map();
      for (const posed of frame.gpuScene.posed) table.set(posed.mesh, posed.vertexBase);
    }
    return table.get(mesh) ?? null;
  };
};

export class GpuGi {
  readonly rayScene: GpuRayScene;
  readonly lighting: GiLighting;
  readonly means: TextureMeans;
  readonly atlasView: GPUTextureView;
  readonly probesProduct: GiProbesProduct;
  frameCount = 0;

  private readonly atlas: GPUTexture;
  private readonly rays: GPUBuffer;
  private readonly scratch: GPUBuffer;
  private readonly probeList: GPUBuffer;
  private readonly clearList: GPUBuffer;
  private readonly clearParams: GPUBuffer;
  private readonly gatherParams: GPUBuffer;
  private readonly rayWays: GPUBuffer;
  private readonly traceLayout: GPUBindGroupLayout;
  private readonly traceGroup: GPUBindGroup;
  private readonly integrateGroup: GPUBindGroup;
  private readonly storeGroup: GPUBindGroup;
  private readonly clearGroup: GPUBindGroup;
  private readonly integrateIrradiance: GPUComputePipeline;
  private readonly integrateVisibility: GPUComputePipeline;
  private readonly integrateOffset: GPUComputePipeline;
  private readonly storeProbes: GPUComputePipeline;
  private readonly clearProbes: GPUComputePipeline;
  private tracePipeline: GPUComputePipeline | null = null;

  private readonly cascades: ProbeCascade[] = [];
  private spacing = 0;
  private readonly scheduled: ScheduledProbe[] = [];
  private readonly grids: [number, number, number, number][] = [];
  private readonly clearCodes = new Uint32Array(CLEAR_CAPACITY);
  private readonly listData = new Float32Array(MAX_PROBES_PER_FRAME * (PROBE_BYTES / 4));
  private readonly listWords = new Uint32Array(this.listData.buffer);
  private readonly paramsData = new Float32Array(12);
  private readonly paramsWords = new Uint32Array(this.paramsData.buffer);
  private directionCount = 0;
  private framesPerSecond = 60;
  private gatheredTick = -1;
  private perspectiveTick = -1000;
  private disposed = false;

  constructor(private readonly device: GPUDevice) {
    this.rayScene = new GpuRayScene(device);
    this.lighting = new GiLighting(device);
    this.means = new TextureMeans(device, () => this.rayScene.lookAgain());

    this.atlas = device.createTexture({
      label: "gi atlas",
      size: [ATLAS_WIDTH, ATLAS_HEIGHT],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    this.atlasView = this.atlas.createView();
    this.probesProduct = { lighting: this.lighting, atlas: this.atlasView };

    const buffer = (label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer => device.createBuffer({ label, size, usage });
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const uniforms = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    this.rays = buffer("gi rays", MAX_PROBES_PER_FRAME * MAX_RAYS_PER_PROBE * PROBE_RAY_BYTES, GPUBufferUsage.STORAGE);
    this.scratch = buffer("gi scratch", MAX_PROBES_PER_FRAME * SCRATCH_STRIDE * 16, GPUBufferUsage.STORAGE);
    this.probeList = buffer("gi probe list", this.listData.byteLength, storage);
    this.clearList = buffer("gi clear list", this.clearCodes.byteLength, storage);
    this.clearParams = buffer("gi clear count", 16, uniforms);
    this.gatherParams = buffer("gi gather", this.paramsData.byteLength, uniforms);
    this.rayWays = buffer("gi ray directions", MAX_RAYS_PER_PROBE * 16, uniforms);

    this.traceLayout = device.createBindGroupLayout({ label: "gi trace", entries: [uniform(0), read(1), write(2), uniform(3)] });
    const integrateLayout = device.createBindGroupLayout({
      label: "gi integrate",
      entries: [uniform(0), read(1), read(2), { binding: 3, visibility: COMPUTE, texture: { sampleType: "unfilterable-float" } }, write(4)],
    });
    const storeLayout = device.createBindGroupLayout({ label: "gi store", entries: [uniform(0), read(1), read(2), atlasWrite(3)] });
    const clearLayout = device.createBindGroupLayout({ label: "gi clear", entries: [uniform(0), read(1), atlasWrite(2)] });

    const bound = (binding: number, target: GPUBuffer): GPUBindGroupEntry => ({ binding, resource: { buffer: target } });
    this.traceGroup = device.createBindGroup({ label: "gi trace", layout: this.traceLayout, entries: [bound(0, this.gatherParams), bound(1, this.probeList), bound(2, this.rays), bound(3, this.rayWays)] });
    this.integrateGroup = device.createBindGroup({
      label: "gi integrate",
      layout: integrateLayout,
      entries: [bound(0, this.gatherParams), bound(1, this.probeList), bound(2, this.rays), { binding: 3, resource: this.atlasView }, bound(4, this.scratch)],
    });
    this.storeGroup = device.createBindGroup({ label: "gi store", layout: storeLayout, entries: [bound(0, this.gatherParams), bound(1, this.probeList), bound(2, this.scratch), { binding: 3, resource: this.atlasView }] });
    this.clearGroup = device.createBindGroup({ label: "gi clear", layout: clearLayout, entries: [bound(0, this.clearParams), bound(1, this.clearList), { binding: 2, resource: this.atlasView }] });

    const integrateModule = device.createShaderModule({ label: "gi integrate", code: INTEGRATE_WGSL });
    const integrate = device.createPipelineLayout({ label: "gi integrate", bindGroupLayouts: [integrateLayout] });
    const made = (label: string, layout: GPUPipelineLayout, module: GPUShaderModule, entryPoint: string): GPUComputePipeline =>
      device.createComputePipeline({ label, layout, compute: { module, entryPoint } });
    this.integrateIrradiance = made("gi integrate irradiance", integrate, integrateModule, "integrateIrradiance");
    this.integrateVisibility = made("gi integrate visibility", integrate, integrateModule, "integrateVisibility");
    this.integrateOffset = made("gi integrate offset", integrate, integrateModule, "integrateOffset");
    this.storeProbes = made("gi store", device.createPipelineLayout({ bindGroupLayouts: [storeLayout] }), device.createShaderModule({ label: "gi store", code: STORE_WGSL }), "storeProbes");
    this.clearProbes = made("gi clear", device.createPipelineLayout({ bindGroupLayouts: [clearLayout] }), device.createShaderModule({ label: "gi clear", code: CLEAR_WGSL }), "clearProbes");

    // The trace is a big shader: compiled in the background, so the editor does not stall on it.
    void device.createComputePipelineAsync({
      label: "gi trace",
      layout: device.createPipelineLayout({ label: "gi trace", bindGroupLayouts: [this.lighting.layout, this.rayScene.layout, this.traceLayout] }),
      compute: { module: device.createShaderModule({ label: "gi trace", code: TRACE_WGSL }), entryPoint: "traceProbeRays" },
    }).then((pipeline) => {
      if (!this.disposed) this.tracePipeline = pipeline;
    }, (error: unknown) => console.error("[gpu] the probes' trace would not compile", error));
  }

  /** What the ray scene holds now and what is still to come in, for the inspector and for checks. */
  get status() {
    return {
      ...this.rayScene.stats,
      traceReady: this.tracePipeline !== null,
      waiting: this.cascades.reduce((sum, cascade) => sum + cascade.pending, 0),
      frame: this.frameCount,
    };
  }

  /** Whether rays can be traced yet: reflections wait for the probes, which light what they meet. */
  get traceReady(): boolean {
    return this.tracePipeline !== null;
  }

  /** One frame's gathering, once per frame the page draws, whatever number of views there are. */
  gather(frame: GpuFrame, run: GiRun): void {
    const perspective = (frame.camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
    if (perspective) this.perspectiveTick = run.tick;
    // An orthographic view's camera stands far outside the level, and the probes follow the camera.
    else if (run.tick - this.perspectiveTick < ORTHOGRAPHIC_PATIENCE) return;
    if (this.gatheredTick === run.tick) return;
    this.gatheredTick = run.tick;

    this.frameCount++;
    const { device, encoder, gpuScene } = frame;
    this.framesPerSecond += (Math.min(240, Math.max(15, 1 / Math.max(frame.delta, 1e-3))) - this.framesPerSecond) * FPS_SMOOTHING;
    this.means.run(frame.textures);
    this.rayScene.update(frame.scene, run.include, this.means.mean, posedLookupOf(frame));

    const { settings } = run;
    frame.camera.getWorldPosition(_position);
    const cleared = this.placeCascades(settings.spacing, _position);
    const environment = frame.products.get("environment") as SkyEnvironmentProduct | undefined;
    this.lighting.update({
      directional: gpuScene.directional,
      local: gpuScene.local,
      ambient: gpuScene.ambient,
      hemiSky: gpuScene.hemiSky,
      hemiGround: gpuScene.hemiGround,
      environment,
      grids: this.grids,
      intensity: settings.intensity,
      bounce: settings.bounce,
      frame: this.frameCount,
      centre: _position,
      // The grid of lights covers the widest cascade with room to spare.
      cellSize: (settings.spacing * CASCADE_RATIO ** (GI_CASCADES - 1) * 20) / 32,
    });
    frame.products.set("giProbes", this.probesProduct);

    this.rayScene.encodeRefit(encoder, frame.geometries.vertices);
    if (cleared > 0) {
      device.queue.writeBuffer(this.clearList, 0, this.clearCodes, 0, cleared);
      device.queue.writeBuffer(this.clearParams, 0, new Uint32Array([cleared, 0, 0, 0]));
      const pass = encoder.beginComputePass({ label: "gi clear" });
      pass.setPipeline(this.clearProbes);
      pass.setBindGroup(0, this.clearGroup);
      pass.dispatchWorkgroups(1, 1, cleared);
      pass.end();
    }
    if (this.tracePipeline) this.trace(frame, settings, this.tracePipeline, environment);
  }

  private placeCascades(baseSpacing: number, eye: THREE.Vector3): number {
    if (baseSpacing !== this.spacing) {
      this.spacing = baseSpacing;
      this.cascades.length = 0;
      for (let index = 0; index < GI_CASCADES; index++) this.cascades.push(new ProbeCascade(index, baseSpacing * CASCADE_RATIO ** index));
    }
    let cleared = 0;
    this.cascades.forEach((cascade, index) => {
      const entered = cascade.recentre(eye.x, eye.y, eye.z);
      for (let at = 0; at < entered.length && cleared < CLEAR_CAPACITY; at++) this.clearCodes[cleared++] = index * PROBES_PER_CASCADE + entered[at];
      const [x, y, z] = cascade.corner();
      this.grids[index] = [x, y, z, cascade.spacing];
    });
    return cleared;
  }

  private trace(frame: GpuFrame, settings: DynamicGiSettings, pipeline: GPUComputePipeline, environment: SkyEnvironmentProduct | undefined): void {
    const { device, encoder } = frame;
    const plan = GI_QUALITY[settings.quality];
    const rayCount = Math.min(plan.rays, MAX_RAYS_PER_PROBE);
    const { scheduled } = this;
    scheduled.length = 0;
    this.cascades.forEach((cascade, index) => cascade.take(plan.probes[index], scheduled));
    const count = Math.min(scheduled.length, MAX_PROBES_PER_FRAME);
    if (!count) return;

    const { listData, listWords, paramsData, paramsWords } = this;
    for (let index = 0; index < count; index++) {
      const probe = scheduled[index];
      const at = index * (PROBE_BYTES / 4);
      listData[at] = probe.x;
      listData[at + 1] = probe.y;
      listData[at + 2] = probe.z;
      listWords[at + 3] = probe.cascade * PROBES_PER_CASCADE + probe.cell;
      _axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      _quaternion.setFromAxisAngle(_axis, Math.random() * Math.PI * 2);
      listData[at + 4] = _quaternion.x;
      listData[at + 5] = _quaternion.y;
      listData[at + 6] = _quaternion.z;
      listData[at + 7] = _quaternion.w;
    }
    device.queue.writeBuffer(this.probeList, 0, listData, 0, count * (PROBE_BYTES / 4));
    this.setRays(rayCount);

    paramsWords[0] = rayCount;
    paramsWords[1] = count;
    this.cascades.forEach((cascade, index) => {
      const framesBetween = PROBES_PER_CASCADE / Math.max(plan.probes[index], 1);
      paramsData[4 + index] = 1 - Math.exp(-framesBetween / (SETTLE_SECONDS * this.framesPerSecond));
      paramsData[8 + index] = cascade.spacing;
    });
    device.queue.writeBuffer(this.gatherParams, 0, paramsData);

    // Each step its own pass: what one writes the next reads, and a pass tracks what is bound as one.
    const tracing = encoder.beginComputePass({ label: "gi trace" });
    tracing.setPipeline(pipeline);
    tracing.setBindGroup(0, this.lighting.bindGroup(this.atlasView, this.lighting.environmentView(environment)));
    tracing.setBindGroup(1, this.rayScene.bindGroup());
    tracing.setBindGroup(2, this.traceGroup);
    tracing.dispatchWorkgroups(Math.ceil(rayCount / TRACE_RAYS_WORKGROUP[0]), Math.ceil(count / TRACE_RAYS_WORKGROUP[1]));
    tracing.end();

    const integrating = encoder.beginComputePass({ label: "gi integrate" });
    integrating.setBindGroup(0, this.integrateGroup);
    integrating.setPipeline(this.integrateIrradiance);
    integrating.dispatchWorkgroups(1, 1, count);
    integrating.setPipeline(this.integrateVisibility);
    integrating.dispatchWorkgroups(2, 2, count);
    integrating.setPipeline(this.integrateOffset);
    integrating.dispatchWorkgroups(Math.ceil(count / 16));
    integrating.end();

    const storing = encoder.beginComputePass({ label: "gi store" });
    storing.setPipeline(this.storeProbes);
    storing.setBindGroup(0, this.storeGroup);
    storing.dispatchWorkgroups(1, 1, count);
    storing.end();
  }

  /** The set of directions each probe turns its own way. */
  private setRays(rayCount: number): void {
    if (this.directionCount === rayCount) return;
    this.directionCount = rayCount;
    const directions = sphericalFibonacci(rayCount);
    const rows = new Float32Array(MAX_RAYS_PER_PROBE * 4);
    for (let index = 0; index < rayCount; index++) rows.set(directions.subarray(index * 3, index * 3 + 3), index * 4);
    this.device.queue.writeBuffer(this.rayWays, 0, rows);
  }

  destroy(): void {
    this.disposed = true;
    this.rayScene.destroy();
    this.lighting.destroy();
    this.means.destroy();
    this.atlas.destroy();
    for (const buffer of [this.rays, this.scratch, this.probeList, this.clearList, this.clearParams, this.gatherParams, this.rayWays]) buffer.destroy();
  }
}

/** The stage "prepare" pass that keeps the probes up to date. */
class GiGatherPass implements GpuPass {
  readonly id = "gi-gather";
  readonly stage = "prepare";
  readonly order = 100;
  private products: GpuFrame["products"] | null = null;

  constructor(private readonly gi: GpuGi, private readonly run: GiRun) {}

  execute(frame: GpuFrame): void {
    this.products = frame.products;
    this.gi.gather(frame, this.run);
  }

  dispose(): void {
    this.products?.delete("giProbes");
    this.products = null;
  }
}

/** Half-size rays for glossy pixels, softened, for the compose to put on the lit picture. */
class GiReflectionPass implements GpuPass {
  readonly id = "gi-reflections";
  readonly stage = "afterSurfaces";
  readonly order = 40;
  private readonly inputLayout: GPUBindGroupLayout;
  private readonly smoothLayout: GPUBindGroupLayout;
  private readonly smoothPipeline: GPUComputePipeline;
  private tracePipeline: GPUComputePipeline | null = null;
  private asked = false;
  private images: { raw: GPUTexture; rawView: GPUTextureView; smooth: GPUTexture; smoothView: GPUTextureView; width: number; height: number } | null = null;
  private groups: { trace: GPUBindGroup; smooth: GPUBindGroup; views: GPUTextureView[] } | null = null;
  private products: GpuFrame["products"] | null = null;
  private disposed = false;

  constructor(private readonly device: GPUDevice, private readonly gi: GpuGi, private readonly run: GiRun) {
    const unfiltered: GPUTextureBindingLayout = { sampleType: "unfilterable-float" };
    const depth: GPUTextureBindingLayout = { sampleType: "depth" };
    this.inputLayout = device.createBindGroupLayout({
      label: "gi reflection rays",
      entries: [
        { binding: 0, visibility: COMPUTE, texture: depth },
        { binding: 1, visibility: COMPUTE, texture: unfiltered },
        { binding: 2, visibility: COMPUTE, texture: unfiltered },
        atlasWrite(3),
      ],
    });
    this.smoothLayout = device.createBindGroupLayout({
      label: "gi reflection smooth",
      entries: [
        { binding: 0, visibility: COMPUTE, texture: depth },
        { binding: 1, visibility: COMPUTE, texture: unfiltered },
        { binding: 2, visibility: COMPUTE, texture: unfiltered },
        atlasWrite(3),
      ],
    });
    this.smoothPipeline = device.createComputePipeline({
      label: "gi reflection smooth",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.smoothLayout] }),
      compute: { module: device.createShaderModule({ label: "gi reflection smooth", code: REFLECTION_SMOOTH_WGSL }), entryPoint: "smoothReflections" },
    });
  }

  private ask(frame: GpuFrame): void {
    if (this.asked) return;
    this.asked = true;
    void this.device.createComputePipelineAsync({
      label: "gi reflection rays",
      layout: this.device.createPipelineLayout({ label: "gi reflection rays", bindGroupLayouts: [frame.cameraLayout, this.gi.lighting.layout, this.gi.rayScene.layout, this.inputLayout] }),
      compute: {
        module: this.device.createShaderModule({ label: "gi reflection rays", code: REFLECTION_RAYS_WGSL }),
        entryPoint: "traceReflections",
        // A character's box is fine for bounced light, wrong in a mirror.
        constants: { RT_SKIP_BOXES: 1 },
      },
    }).then((pipeline) => {
      if (!this.disposed) this.tracePipeline = pipeline;
    }, (error: unknown) => console.error("[gpu] the reflections' rays would not compile", error));
  }

  private imagesFor(width: number, height: number): NonNullable<GiReflectionPass["images"]> {
    if (this.images?.width === width && this.images.height === height) return this.images;
    this.images?.raw.destroy();
    this.images?.smooth.destroy();
    const texture = (label: string): GPUTexture => this.device.createTexture({
      label,
      size: [width, height],
      format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    const raw = texture("gi reflection rays");
    const smooth = texture("gi reflections");
    this.images = { raw, rawView: raw.createView(), smooth, smoothView: smooth.createView(), width, height };
    return this.images;
  }

  execute(frame: GpuFrame): void {
    this.products = frame.products;
    if (!this.run.reflections) {
      frame.products.delete("rayReflections");
      return;
    }
    this.ask(frame);
    if (!this.tracePipeline || !this.gi.traceReady) {
      frame.products.delete("rayReflections");
      return;
    }
    const { targets } = frame;
    const images = this.imagesFor(Math.max(1, targets.width >> 1), Math.max(1, targets.height >> 1));
    const screen = (frame.products.get("reflections") as { view: GPUTextureView } | undefined)?.view ?? frame.textures.black.view;
    const views = [targets.depth.view, targets.normal.view, screen, images.rawView, images.smoothView];
    if (!this.groups || !views.every((view, index) => view === this.groups?.views[index])) {
      this.groups = {
        views,
        trace: this.device.createBindGroup({
          label: "gi reflection rays",
          layout: this.inputLayout,
          entries: [targets.depth.view, targets.normal.view, screen, images.rawView].map((resource, binding) => ({ binding, resource })),
        }),
        smooth: this.device.createBindGroup({
          label: "gi reflection smooth",
          layout: this.smoothLayout,
          entries: [targets.depth.view, targets.normal.view, images.rawView, images.smoothView].map((resource, binding) => ({ binding, resource })),
        }),
      };
    }
    const environment = frame.products.get("environment") as SkyEnvironmentProduct | undefined;
    const { lighting } = this.gi;
    const tracing = frame.encoder.beginComputePass({ label: "gi reflection rays" });
    tracing.setPipeline(this.tracePipeline);
    tracing.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    tracing.setBindGroup(1, lighting.bindGroup(this.gi.atlasView, lighting.environmentView(environment)));
    tracing.setBindGroup(2, this.gi.rayScene.bindGroup());
    tracing.setBindGroup(3, this.groups.trace);
    tracing.dispatchWorkgroups(Math.ceil(images.width / 8), Math.ceil(images.height / 8));
    tracing.end();
    const smoothing = frame.encoder.beginComputePass({ label: "gi reflection smooth" });
    smoothing.setPipeline(this.smoothPipeline);
    smoothing.setBindGroup(0, this.groups.smooth);
    smoothing.dispatchWorkgroups(Math.ceil(images.width / 8), Math.ceil(images.height / 8));
    smoothing.end();
    frame.products.set("rayReflections", { view: images.smoothView } satisfies RayReflectionsProduct);
  }

  dispose(): void {
    this.disposed = true;
    this.products?.delete("rayReflections");
    this.products = null;
    this.images?.raw.destroy();
    this.images?.smooth.destroy();
  }
}

/** The change reflections and sky visibility make to the lit picture, drawn over it. */
class GiComposePass implements GpuPass {
  readonly id = "gi-compose";
  readonly stage = "afterLighting";
  readonly order = 20;
  private readonly inputLayout: GPUBindGroupLayout;
  private readonly emptyLayout: GPUBindGroupLayout;
  private readonly emptyGroup: GPUBindGroup;
  private readonly params: GPUBuffer;
  private readonly paramsData = new Uint32Array(4);
  private pipeline: GPURenderPipeline | null = null;
  private inputs: { group: GPUBindGroup; views: GPUTextureView[] } | null = null;

  constructor(private readonly device: GPUDevice) {
    const fragment = GPUShaderStage.FRAGMENT;
    const unfiltered: GPUTextureBindingLayout = { sampleType: "unfilterable-float" };
    this.inputLayout = device.createBindGroupLayout({
      label: "gi compose",
      entries: [
        { binding: 0, visibility: fragment, texture: { sampleType: "depth" } },
        { binding: 1, visibility: fragment, texture: unfiltered },
        { binding: 2, visibility: fragment, texture: unfiltered },
        { binding: 3, visibility: fragment, texture: unfiltered },
        { binding: 4, visibility: fragment, texture: unfiltered },
        { binding: 5, visibility: fragment, texture: unfiltered },
        { binding: 6, visibility: fragment, texture: unfiltered },
        { binding: 7, visibility: fragment, buffer: { type: "uniform" } },
      ],
    });
    this.emptyLayout = device.createBindGroupLayout({ label: "gi compose nothing", entries: [] });
    this.emptyGroup = device.createBindGroup({ layout: this.emptyLayout, entries: [] });
    this.params = device.createBuffer({ label: "gi compose", size: this.paramsData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  private pipelineFor(frame: GpuFrame, lighting: LightingProduct): GPURenderPipeline {
    if (this.pipeline) return this.pipeline;
    const module = this.device.createShaderModule({ label: "gi compose", code: REFLECTION_COMPOSE_WGSL });
    this.pipeline = this.device.createRenderPipeline({
      label: "gi compose",
      layout: this.device.createPipelineLayout({ label: "gi compose", bindGroupLayouts: [frame.cameraLayout, this.emptyLayout, this.inputLayout, lighting.layout] }),
      vertex: { module, entryPoint: "fullscreenVertex" },
      fragment: {
        module,
        entryPoint: "composeReflections",
        targets: [{
          format: "rgba16float",
          // Adds the change: it may well be negative, and a float target holds that for the sum.
          blend: { color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" } },
        }],
      },
      primitive: { topology: "triangle-list" },
    });
    return this.pipeline;
  }

  execute(frame: GpuFrame): void {
    const lighting = frame.products.get("lighting") as LightingProduct | undefined;
    const indirect = frame.products.get("gi") as GiProduct | undefined;
    if (!lighting || !indirect) return;
    const reflections = frame.products.get("rayReflections") as RayReflectionsProduct | undefined;
    const occlusion = frame.products.get("ao") as { view: GPUTextureView } | undefined;
    this.paramsData[0] = reflections ? 1 : 0;
    this.device.queue.writeBuffer(this.params, 0, this.paramsData);
    const { targets, textures } = frame;
    const views = [targets.depth.view, targets.albedo.view, targets.normal.view, targets.emissive.view, reflections?.view ?? textures.black.view, indirect.view, occlusion?.view ?? textures.white.view];
    if (!this.inputs || !views.every((view, index) => view === this.inputs?.views[index])) {
      this.inputs = {
        views,
        group: this.device.createBindGroup({
          label: "gi compose",
          layout: this.inputLayout,
          entries: [...views.map((resource, binding) => ({ binding, resource })), { binding: 7, resource: { buffer: this.params } }],
        }),
      };
    }
    const pass = frame.encoder.beginRenderPass({
      label: "gi compose",
      colorAttachments: [{ view: targets.hdr.view, loadOp: "load", storeOp: "store" }],
    });
    pass.setPipeline(this.pipelineFor(frame, lighting));
    pass.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    pass.setBindGroup(1, this.emptyGroup);
    pass.setBindGroup(2, this.inputs.group);
    pass.setBindGroup(3, lighting.bindGroup);
    pass.draw(3);
    pass.end();
  }

  dispose(): void {
    this.params.destroy();
  }
}

/** The views that show the light itself: the scene as rays see it, the probes, or only indirect light. */
class GiViewPass implements GpuPass {
  readonly id = "gi-view";
  readonly stage = "afterLighting";
  readonly order = 90;
  private readonly hdrLayout: GPUBindGroupLayout;
  private readonly lightingLayout: GPUBindGroupLayout;
  private readonly lightingPipeline: GPUComputePipeline;
  private rayPipeline: GPUComputePipeline | null = null;
  private rayAsked = false;
  private ballPipeline: GPURenderPipeline | null = null;
  private disposed = false;

  constructor(private readonly device: GPUDevice, private readonly gi: GpuGi, private readonly run: GiRun) {
    this.hdrLayout = device.createBindGroupLayout({ label: "gi ray view", entries: [atlasWrite(0)] });
    this.lightingLayout = device.createBindGroupLayout({
      label: "gi lighting view",
      entries: [
        { binding: 0, visibility: COMPUTE, texture: { sampleType: "depth" } },
        { binding: 1, visibility: COMPUTE, texture: { sampleType: "unfilterable-float" } },
        atlasWrite(2),
      ],
    });
    this.lightingPipeline = device.createComputePipeline({
      label: "gi lighting view",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.lightingLayout] }),
      compute: { module: device.createShaderModule({ label: "gi lighting view", code: LIGHTING_VIEW_WGSL }), entryPoint: "showLighting" },
    });
  }

  private showRays(frame: GpuFrame): void {
    if (!this.rayAsked) {
      this.rayAsked = true;
      void this.device.createComputePipelineAsync({
        label: "gi ray view",
        layout: this.device.createPipelineLayout({ label: "gi ray view", bindGroupLayouts: [frame.cameraLayout, this.gi.lighting.layout, this.gi.rayScene.layout, this.hdrLayout] }),
        compute: { module: this.device.createShaderModule({ label: "gi ray view", code: RAY_VIEW_WGSL }), entryPoint: "traceView" },
      }).then((pipeline) => {
        if (!this.disposed) this.rayPipeline = pipeline;
      }, (error: unknown) => console.error("[gpu] the ray view would not compile", error));
    }
    if (!this.rayPipeline) return;
    const { targets } = frame;
    const environment = frame.products.get("environment") as SkyEnvironmentProduct | undefined;
    const { lighting } = this.gi;
    const pass = frame.encoder.beginComputePass({ label: "gi ray view" });
    pass.setPipeline(this.rayPipeline);
    pass.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    pass.setBindGroup(1, lighting.bindGroup(this.gi.atlasView, lighting.environmentView(environment)));
    pass.setBindGroup(2, this.gi.rayScene.bindGroup());
    pass.setBindGroup(3, this.device.createBindGroup({ layout: this.hdrLayout, entries: [{ binding: 0, resource: targets.hdr.view }] }));
    pass.dispatchWorkgroups(Math.ceil(targets.width / 8), Math.ceil(targets.height / 8));
    pass.end();
  }

  private showLighting(frame: GpuFrame): void {
    const indirect = frame.products.get("gi") as GiProduct | undefined;
    if (!indirect) return;
    const { targets } = frame;
    const pass = frame.encoder.beginComputePass({ label: "gi lighting view" });
    pass.setPipeline(this.lightingPipeline);
    pass.setBindGroup(0, this.device.createBindGroup({
      layout: this.lightingLayout,
      entries: [{ binding: 0, resource: targets.depth.view }, { binding: 1, resource: indirect.view }, { binding: 2, resource: targets.hdr.view }],
    }));
    pass.dispatchWorkgroups(Math.ceil(targets.width / 8), Math.ceil(targets.height / 8));
    pass.end();
  }

  private showProbes(frame: GpuFrame): void {
    const { targets } = frame;
    const environment = frame.products.get("environment") as SkyEnvironmentProduct | undefined;
    const { lighting } = this.gi;
    if (!this.ballPipeline) {
      const module = this.device.createShaderModule({ label: "gi probe view", code: PROBE_VIEW_WGSL });
      this.ballPipeline = this.device.createRenderPipeline({
        label: "gi probe view",
        layout: this.device.createPipelineLayout({ label: "gi probe view", bindGroupLayouts: [frame.cameraLayout, lighting.layout] }),
        vertex: { module, entryPoint: "ballVertex" },
        fragment: { module, entryPoint: "ballFragment", targets: [{ format: "rgba16float" }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: "depth32float", depthWriteEnabled: false, depthCompare: "greater" },
      });
    }
    const pass = frame.encoder.beginRenderPass({
      label: "gi probe view",
      colorAttachments: [{ view: targets.hdr.view, loadOp: "load", storeOp: "store" }],
      depthStencilAttachment: { view: targets.depth.view, depthReadOnly: true },
    });
    pass.setPipeline(this.ballPipeline);
    pass.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    pass.setBindGroup(1, lighting.bindGroup(this.gi.atlasView, lighting.environmentView(environment)));
    pass.draw(BALL_VERTICES, PROBES_PER_CASCADE);
    pass.end();
  }

  execute(frame: GpuFrame): void {
    const { view } = this.run.settings;
    if (view === "rays") this.showRays(frame);
    else if (view === "probes") this.showProbes(frame);
    else if (view === "lighting") this.showLighting(frame);
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** The passes that gather light and put it to use, for one running GpuGi. */
export const createGiPasses = (device: GPUDevice, gi: GpuGi, run: GiRun): GpuPass[] => [
  new GiGatherPass(gi, run),
  new GiReflectionPass(device, gi, run),
  new GiComposePass(device),
  new GiViewPass(device, gi, run),
];
