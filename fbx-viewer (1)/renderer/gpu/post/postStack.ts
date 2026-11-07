/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { skyLight } from "../../../runtime/daylight";
import { AUTO_EXPOSURE_REFERENCE, whiteBalance } from "../../../runtime/postEffects";
import { cameraStillnessFor, contrastFadeFor, isCameraCut, temporalJitter } from "../../../runtime/temporal/temporalSettings";
import type { GpuCore } from "../device";
import type { GpuFrame, GpuPass } from "../frame";
import { BindCache, ImagePool, type PostImage, type PostResource, type ResolvedImage } from "./postImages";
import {
  BLOOM_BRIGHT_WGSL, BLOOM_DOWN_WGSL, BLOOM_UP_WGSL, BOKEH_WGSL, COC_WGSL, DOF_MASK_WGSL, EXPOSURE_WGSL, FXAA_PREPARE_WGSL, FXAA_WGSL, GRADE_WGSL,
  HAZE_WGSL, KAWASE_WGSL, LENS_WGSL, MOTION_BLUR_WGSL, MOTION_VELOCITY_WGSL, POST_FIELD as F, POST_UNIFORM_FLOATS, SHAFT_BLUR_WGSL, SHAFT_MASK_WGSL,
} from "./postShaders";
import type { GpuPostConfig } from "./postSettings";
import { RESOLVE_WGSL, TEMPORAL_OUTPUT_WGSL } from "./temporalShaders";

/**
 * THE POST STACK
 *
 * One pass in the "post" stage that takes the lit HDR target to the finished HDR picture, by compute, in the WebGL
 * stack's order:
 *
 *   haze on the lit scene, at the render scale
 *   temporal resolve and sharpening, up to the display's size
 *   depth of field and light shafts
 *   motion blur
 *   auto exposure, white balance and bloom
 *   edge smoothing, when temporal anti-aliasing is off
 *
 * Tone mapping and all that follows it on display values happens in the present pass (present.ts).
 *
 * In the WebGL stack effects that follow one another without a blur between them share one input, and this keeps that:
 * with no motion blur, exposure and bloom measure the picture from before the shafts, and bloom is laid over the
 * exposed picture without being exposed itself.
 *
 * Product "resolved": ResolvedImage, the finished HDR picture at the size of `frame.viewport`.
 *
 * Temporal history belongs to a camera at a display size, so editor views sharing one canvas keep theirs apart. A new
 * render scale keeps it: history is at the display's size, and the picture only softens for a moment.
 */

/** A new frame's least share of a pixel once it has settled, at the nearest sample: at rest, and in motion. */
const BLEND_FLOOR = [0.05, 0.12] as const;
/** How far history may stray from the colours around it, in standard deviations: at rest, and in motion. */
const CLIP_SPREAD = [1.5, 1] as const;
/** The in-focus band spans this fraction of the focus distance, so near focus gives a shallower field, as with a lens. */
const FOCUS_RANGE_RATIO = 0.5;
const AUTO_EXPOSURE_RESPONSE = 0.5;
const AUTO_EXPOSURE_MIN = 0.6;
const AUTO_EXPOSURE_MAX = 2.5;
const AUTO_EXPOSURE_BRIGHTEN = 3;
const AUTO_EXPOSURE_DARKEN = 1.2;
const BLOOM_LEVELS = 8;
const WORKGROUP_SIZE = 8;
/** A history not added to for this many frames holds nothing the present can use. */
const HISTORY_STALE_FRAMES = 16;
/** A camera not seen for this many frames gives back what was kept for it. */
const VIEWS_KEPT_FRAMES = 240;

/**
 * This frame's offset inside the drawn pixel, in drawn pixels with y up, each axis within -0.5..0.5, as the renderer's
 * "temporal.jitter" setting wants it: a smaller picture cycles through more spots, so it takes the render scale.
 */
export const haltonJitter = (frame: number, scale = 1): readonly [number, number] => {
  const spot = temporalJitter(frame, scale, { x: 0, y: 0 });
  return [spot.x, spot.y];
};

interface PipelineSpec {
  code: string;
  constants?: Record<string, number>;
}

const PIPELINES = {
  haze: { code: HAZE_WGSL },
  resolve: { code: RESOLVE_WGSL },
  temporalOutput: { code: TEMPORAL_OUTPUT_WGSL },
  shaftMask: { code: SHAFT_MASK_WGSL },
  shaftBlur: { code: SHAFT_BLUR_WGSL },
  coc: { code: COC_WGSL },
  kawase0: { code: KAWASE_WGSL, constants: { KERNEL: 0 } },
  kawase1: { code: KAWASE_WGSL, constants: { KERNEL: 1 } },
  kawase2: { code: KAWASE_WGSL, constants: { KERNEL: 2 } },
  dofMask: { code: DOF_MASK_WGSL },
  bokehFarBase: { code: BOKEH_WGSL, constants: { FOREGROUND: 0, FILL: 0 } },
  bokehFarFill: { code: BOKEH_WGSL, constants: { FOREGROUND: 0, FILL: 1 } },
  bokehNearBase: { code: BOKEH_WGSL, constants: { FOREGROUND: 1, FILL: 0 } },
  bokehNearFill: { code: BOKEH_WGSL, constants: { FOREGROUND: 1, FILL: 1 } },
  lens: { code: LENS_WGSL },
  motionVelocity: { code: MOTION_VELOCITY_WGSL },
  motionBlur: { code: MOTION_BLUR_WGSL },
  exposure: { code: EXPOSURE_WGSL },
  bloomBright: { code: BLOOM_BRIGHT_WGSL },
  bloomDown: { code: BLOOM_DOWN_WGSL },
  bloomUp: { code: BLOOM_UP_WGSL },
  grade: { code: GRADE_WGSL },
  fxaaPrepare: { code: FXAA_PREPARE_WGSL },
  fxaa: { code: FXAA_WGSL },
} satisfies Record<string, PipelineSpec>;

type PipelineName = keyof typeof PIPELINES;

/** One camera at one display size: what its temporal resolve carries from frame to frame. */
interface TemporalHistory {
  available: boolean;
  /** Which of the two pictures is newest. */
  flipped: boolean;
  lastFrame: number;
  readonly previousViewProjection: THREE.Matrix4;
  readonly lastPosition: THREE.Vector3;
  readonly lastFacing: THREE.Vector3;
}

/** One camera: what its effects carry from frame to frame. */
interface PostView {
  readonly id: number;
  lastUsed: number;
  readonly histories: Map<string, TemporalHistory>;
  /** [0] the adapted average brightness, [1] the exposure it asks for. */
  readonly exposure: GPUBuffer;
  firstMeasure: boolean;
  readonly blurPrevious: THREE.Matrix4;
  blurPlaced: boolean;
}

/** What one device needs; made when first run, and given back when the pass is disposed. */
interface PostDeviceState {
  device: GPUDevice;
  pool: ImagePool;
  binds: BindCache;
  poolGeneration: number;
  uniforms: GPUBuffer;
  sampler: GPUSampler;
  blackTexture: GPUTexture;
  black: GPUTextureView;
}

const _cleanViewProjection = new THREE.Matrix4();
const _reprojection = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _facing = new THREE.Vector3();
const _sun = new THREE.Vector3();

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

export class GpuPostPass implements GpuPass {
  readonly id = "post-stack";
  readonly stage = "post" as const;
  readonly order = 0;

  private config: GpuPostConfig | null = null;
  private state: PostDeviceState | null = null;
  private readonly pipelines = new Map<PipelineName, GPUComputePipeline>();
  private readonly modules = new Map<string, GPUShaderModule>();
  private readonly views = new Map<THREE.Camera, PostView>();
  private readonly uniformData = new Float32Array(POST_UNIFORM_FLOATS);
  private nextViewId = 1;
  private lastJitter: readonly [number, number] = [0, 0];
  private jitterFrame = -1;
  private lastViewSweep = 0;

  constructor(private readonly core: GpuCore) {}

  configure(config: GpuPostConfig): void {
    this.config = config;
  }

  /**
   * What goes in the renderer's "temporal.jitter" setting. Keeping what it last answered means the resolve accounts
   * for exactly the offset the frame was drawn with.
   */
  readonly jitter = (frame: number): readonly [number, number] => {
    this.lastJitter = haltonJitter(frame, this.config?.renderScale ?? 1);
    this.jitterFrame = frame;
    return this.lastJitter;
  };

  private ensureState(): PostDeviceState {
    if (this.state) return this.state;
    const { device } = this.core;
    const blackTexture = device.createTexture({ label: "post black", size: [1, 1], format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING });
    this.state = {
      device,
      pool: new ImagePool(device),
      binds: new BindCache(device),
      poolGeneration: 0,
      uniforms: device.createBuffer({ label: "post uniforms", size: POST_UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      sampler: device.createSampler({ label: "post linear clamp", minFilter: "linear", magFilter: "linear" }),
      blackTexture,
      black: blackTexture.createView(),
    };
    return this.state;
  }

  private pipeline(name: PipelineName): GPUComputePipeline {
    const made = this.pipelines.get(name);
    if (made) return made;
    const spec: PipelineSpec = PIPELINES[name];
    const { device } = this.core;
    let module = this.modules.get(spec.code);
    if (!module) {
      module = device.createShaderModule({ label: `post ${name}`, code: spec.code });
      this.modules.set(spec.code, module);
    }
    const pipeline = device.createComputePipeline({
      label: `post ${name}`,
      layout: "auto",
      compute: { module, entryPoint: "main", constants: spec.constants },
    });
    this.pipelines.set(name, pipeline);
    return pipeline;
  }

  private run(compute: GPUComputePassEncoder, name: PipelineName, resources: readonly PostResource[], width: number, height: number): void {
    const pipeline = this.pipeline(name);
    compute.setPipeline(pipeline);
    compute.setBindGroup(0, this.state!.binds.group(pipeline, resources));
    compute.dispatchWorkgroups(Math.ceil(width / WORKGROUP_SIZE), Math.ceil(height / WORKGROUP_SIZE));
  }

  /** A full-size picture to write to that is not the one being read. */
  private other(current: PostImage, width: number, height: number): PostImage {
    const { pool } = this.state!;
    const first = pool.image("swap.a", width, height);
    return first === current ? pool.image("swap.b", width, height) : first;
  }

  private viewOf(camera: THREE.Camera, frameNumber: number): PostView {
    let view = this.views.get(camera);
    if (!view) {
      view = {
        id: this.nextViewId++,
        lastUsed: frameNumber,
        histories: new Map(),
        exposure: this.core.device.createBuffer({ label: "post exposure", size: 16, usage: GPUBufferUsage.STORAGE }),
        firstMeasure: true,
        blurPrevious: new THREE.Matrix4(),
        blurPlaced: false,
      };
      this.views.set(camera, view);
    }
    view.lastUsed = frameNumber;
    return view;
  }

  private historyOf(view: PostView, width: number, height: number, frameNumber: number): TemporalHistory {
    const key = `${width}x${height}`;
    let history = view.histories.get(key);
    if (!history) {
      history = {
        available: false,
        flipped: false,
        lastFrame: frameNumber,
        previousViewProjection: new THREE.Matrix4(),
        lastPosition: new THREE.Vector3(),
        lastFacing: new THREE.Vector3(),
      };
      view.histories.set(key, history);
    }
    if (frameNumber - history.lastFrame > HISTORY_STALE_FRAMES) history.available = false;
    return history;
  }

  private sweepViews(frameNumber: number): void {
    if (frameNumber - this.lastViewSweep < VIEWS_KEPT_FRAMES) return;
    this.lastViewSweep = frameNumber;
    for (const [camera, view] of this.views) {
      for (const [key, history] of view.histories) {
        if (frameNumber - history.lastFrame > VIEWS_KEPT_FRAMES) view.histories.delete(key);
      }
      if (frameNumber - view.lastUsed <= VIEWS_KEPT_FRAMES) continue;
      view.exposure.destroy();
      this.views.delete(camera);
    }
  }

  execute(frame: GpuFrame): void {
    const config = this.config;
    if (!config) return;
    const state = this.ensureState();
    const { pool, sampler, black } = state;
    const { camera, targets, viewport, frameNumber } = frame;
    pool.beginFrame(frameNumber);
    if (state.poolGeneration !== pool.generation) {
      state.binds.clear();
      state.poolGeneration = pool.generation;
    }

    const temporal = config.antialias === "temporal";
    const outputWidth = temporal ? viewport.width : targets.width;
    const outputHeight = temporal ? viewport.height : targets.height;
    const view = this.viewOf(camera, frameNumber);
    const data = this.uniformData;
    const u = state.uniforms;
    const depth = targets.depth.view;

    // What this frame's sky and camera ask of the effects.
    const hazeOn = config.sunHaze && config.sunHazeIntensity > 0 && skyLight.fogDensity > 0;
    const shaftsShown = config.lightShafts ? this.placeShafts(camera, config.lightShaftsIntensity, outputWidth, outputHeight) : 0;
    const shaftsOn = shaftsShown > 0;
    const dofOn = config.depthOfField;
    const blurOn = config.motionBlur && view.blurPlaced;
    const balanced = config.temperature !== 0 || config.tint !== 0;
    const gradeOn = config.autoExposure || config.bloom || balanced;

    const history = temporal ? this.historyOf(view, outputWidth, outputHeight, frameNumber) : null;
    this.writeFrameUniforms(frame, config, view, history, outputWidth, outputHeight, { dofOn, shaftsOn, balanced, hazeOn });
    state.device.queue.writeBuffer(u, 0, data);

    const compute = frame.encoder.beginComputePass({ label: "gpu post stack" });
    let image: PostImage = { texture: targets.hdr.texture, view: targets.hdr.view, width: targets.width, height: targets.height, levels: [targets.hdr.view] };

    if (hazeOn) {
      const lit = pool.image("lit", targets.width, targets.height);
      this.run(compute, "haze", [u, image.view, depth, lit.view], lit.width, lit.height);
      image = lit;
    }

    if (history) {
      image = this.resolve(compute, frame, view, history, image, outputWidth, outputHeight);
    }

    // Effects with no blur between them share one input, as in the WebGL stack.
    const shared = image;
    if (dofOn || shaftsOn) {
      const dof = dofOn ? this.depthOfField(compute, shared, depth) : null;
      const shafts = shaftsOn ? this.shafts(compute, shared, depth) : black;
      const lens = this.other(image, outputWidth, outputHeight);
      this.run(compute, "lens", [
        u, image.view, dof?.coc ?? black, dof?.cocBlurred ?? black, dof?.far ?? black, dof?.near ?? black, shafts, sampler, lens.view,
      ], outputWidth, outputHeight);
      image = lens;
    }

    if (blurOn) {
      const velocity = pool.image("motion.velocity", Math.round(outputWidth / 2), Math.round(outputHeight / 2));
      this.run(compute, "motionVelocity", [u, depth, velocity.view], velocity.width, velocity.height);
      const blurred = this.other(image, outputWidth, outputHeight);
      this.run(compute, "motionBlur", [u, image.view, velocity.view, sampler, blurred.view], outputWidth, outputHeight);
      image = blurred;
    }
    // A blur is where the run of shared input ends: what follows it measures the blurred picture.
    const measured = blurOn ? image : shared;

    if (gradeOn) {
      if (config.autoExposure) this.run(compute, "exposure", [u, measured.view, sampler, view.exposure], 1, 1);
      const bloom = config.bloom ? this.bloom(compute, measured) : black;
      const graded = this.other(image, outputWidth, outputHeight);
      this.run(compute, "grade", [u, image.view, bloom, sampler, view.exposure, graded.view], outputWidth, outputHeight);
      image = graded;
    }

    if (config.antialias === "smaa") {
      const prepared = pool.image("fxaa.prepared", outputWidth, outputHeight);
      this.run(compute, "fxaaPrepare", [u, image.view, prepared.view], outputWidth, outputHeight);
      const smoothed = this.other(image, outputWidth, outputHeight);
      this.run(compute, "fxaa", [u, prepared.view, sampler, smoothed.view], outputWidth, outputHeight);
      image = smoothed;
    }
    compute.end();

    view.firstMeasure = !config.autoExposure;
    if (config.motionBlur) {
      view.blurPrevious.multiplyMatrices((camera as THREE.PerspectiveCamera).projectionMatrix, camera.matrixWorldInverse);
      view.blurPlaced = true;
    } else {
      view.blurPlaced = false;
    }

    const resolved: ResolvedImage = { texture: image.texture, view: image.view, width: image.width, height: image.height, frameNumber };
    frame.products.set("resolved", resolved);
    pool.sweep();
    this.sweepViews(frameNumber);
  }

  /** Where the sun stands on screen and how much of it shows: none behind the camera or below the horizon. */
  private placeShafts(camera: THREE.Camera, strength: number, width: number, height: number): number {
    const data = this.uniformData;
    _sun.set(skyLight.sun.x, skyLight.sun.y, skyLight.sun.z);
    camera.getWorldDirection(_facing);
    const facing = _facing.dot(_sun);
    const above = THREE.MathUtils.smoothstep(skyLight.sun.y, -0.02, 0.08);
    const shown = THREE.MathUtils.smoothstep(facing, 0.1, 0.45) * above * Math.min(1, skyLight.sunStrength / 1.5);
    if (shown <= 0.001 || strength <= 0) return 0;
    camera.getWorldPosition(_position);
    _sun.multiplyScalar(1000).add(_position).project(camera);
    data[F.sunUv] = _sun.x * 0.5 + 0.5;
    data[F.sunUv + 1] = 0.5 - _sun.y * 0.5;
    data[F.aspect] = width / Math.max(1, height);
    data[F.shaftsIntensity] = shown * strength;
    data[F.shaftsTint] = skyLight.sunColor[0];
    data[F.shaftsTint + 1] = skyLight.sunColor[1];
    data[F.shaftsTint + 2] = skyLight.sunColor[2];
    return shown;
  }

  private writeFrameUniforms(
    frame: GpuFrame,
    config: GpuPostConfig,
    view: PostView,
    history: TemporalHistory | null,
    outputWidth: number,
    outputHeight: number,
    active: { dofOn: boolean; shaftsOn: boolean; balanced: boolean; hazeOn: boolean },
  ): void {
    const data = this.uniformData;
    const camera = frame.camera as THREE.PerspectiveCamera;
    const { targets } = frame;
    const projection = camera.projectionMatrix.elements;

    data.set(camera.projectionMatrixInverse.elements, F.inverseProjection);
    data.set(camera.matrixWorld.elements, F.cameraWorld);
    data.set(view.blurPrevious.elements, F.previousViewProjection);
    data[F.inputSize] = targets.width;
    data[F.inputSize + 1] = targets.height;
    data[F.outputSize] = outputWidth;
    data[F.outputSize + 1] = outputHeight;
    data[F.time] = frame.time;
    data[F.delta] = Math.min(0.25, Math.max(0, frame.delta));
    data[F.depthToDistance] = projection[10];
    data[F.depthToDistance + 1] = projection[14];
    data[F.perspective] = projection[15] === 0 ? 1 : 0;
    data[F.blendFloor] = BLEND_FLOOR[0];
    data[F.blendFloor + 1] = BLEND_FLOOR[1];
    data[F.clipSpread] = CLIP_SPREAD[0];
    data[F.clipSpread + 1] = CLIP_SPREAD[1];
    data[F.contrastFade] = contrastFadeFor(config.renderScale);
    data[F.sharpness] = config.sharpness;

    // The surfaces were drawn shifted by this, up in clip space, which is down the texture's y.
    const jitter = history && this.jitterFrame === frame.frameNumber ? this.lastJitter : ([0, 0] as const);
    data[F.jitter] = jitter[0];
    data[F.jitter + 1] = -jitter[1];
    data[F.jitterUv] = jitter[0] / targets.width;
    data[F.jitterUv + 1] = -jitter[1] / targets.height;

    if (history) {
      camera.getWorldPosition(_position);
      camera.getWorldDirection(_facing);
      const moved = _position.distanceTo(history.lastPosition);
      const cut = history.available && isCameraCut(moved, _facing.dot(history.lastFacing));
      data[F.cameraStillness] = history.available ? cameraStillnessFor(moved) : 1;
      const carryOn = history.available && !cut;
      data[F.hasHistory] = carryOn ? 1 : 0;
      _cleanViewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      // No past to measure from: the first frame after a cut has no motion.
      if (!carryOn) history.previousViewProjection.copy(_cleanViewProjection);
      _reprojection.copy(_cleanViewProjection).invert().premultiply(history.previousViewProjection);
      data.set(_reprojection.elements, F.reprojection);
      history.previousViewProjection.copy(_cleanViewProjection);
      history.lastPosition.copy(_position);
      history.lastFacing.copy(_facing);
    }

    if (active.hazeOn) {
      const strength = skyLight.sunStrength * THREE.MathUtils.smoothstep(skyLight.sun.y, -0.05, 0.05);
      data[F.sunDirection] = skyLight.sun.x;
      data[F.sunDirection + 1] = skyLight.sun.y;
      data[F.sunDirection + 2] = skyLight.sun.z;
      data[F.sunColor] = skyLight.sunColor[0] * strength;
      data[F.sunColor + 1] = skyLight.sunColor[1] * strength;
      data[F.sunColor + 2] = skyLight.sunColor[2] * strength;
      data[F.fogDensity] = skyLight.fogDensity;
      data[F.hazeIntensity] = config.sunHazeIntensity;
    }

    const near = camera.near;
    const far = camera.far;
    data[F.cameraNear] = near;
    data[F.cameraFar] = far;
    data[F.focusDistance] = clamp01((config.focusDistance - near) / (far - near));
    data[F.focusRange] = clamp01((config.focusDistance * FOCUS_RANGE_RATIO - near) / (far - near));
    data[F.bokehScale] = config.bokehScale;
    data[F.lensDepthOfField] = active.dofOn ? 1 : 0;
    data[F.lensShafts] = active.shaftsOn ? 1 : 0;

    data[F.blurStrength] = config.motionBlurStrength;

    data[F.reference] = AUTO_EXPOSURE_REFERENCE;
    data[F.response] = AUTO_EXPOSURE_RESPONSE;
    data[F.minExposure] = AUTO_EXPOSURE_MIN;
    data[F.maxExposure] = AUTO_EXPOSURE_MAX;
    data[F.compensation] = 2 ** config.exposureCompensation;
    data[F.brighten] = AUTO_EXPOSURE_BRIGHTEN * config.adaptationSpeed;
    data[F.darken] = AUTO_EXPOSURE_DARKEN * config.adaptationSpeed;
    data[F.firstMeasure] = view.firstMeasure ? 1 : 0;
    data[F.gradeExposure] = config.autoExposure ? 1 : 0;

    const balance = active.balanced ? whiteBalance(config.temperature, config.tint) : ([1, 1, 1] as const);
    data[F.balance] = balance[0];
    data[F.balance + 1] = balance[1];
    data[F.balance + 2] = balance[2];

    data[F.gradeBloom] = config.bloom ? 1 : 0;
    data[F.bloomIntensity] = config.bloomIntensity;
    data[F.bloomThreshold] = config.bloomThreshold;
    data[F.bloomSmoothing] = config.bloomSmoothing;
    data[F.bloomRadius] = config.bloomRadius;

    data[F.displayExposure] = config.exposure;
  }

  /** Gathers the lit picture into this camera's history and hands back the sharpened result at the display's size. */
  private resolve(
    compute: GPUComputePassEncoder,
    frame: GpuFrame,
    view: PostView,
    history: TemporalHistory,
    input: PostImage,
    width: number,
    height: number,
  ): PostImage {
    const { pool, sampler, uniforms: u } = this.state!;
    const { targets } = frame;
    const colourA = pool.image(`${view.id}.history.a`, width, height);
    const colourB = pool.image(`${view.id}.history.b`, width, height);
    const companionA = pool.image(`${view.id}.companion.a`, width, height);
    const companionB = pool.image(`${view.id}.companion.b`, width, height);
    const readColour = history.flipped ? colourB : colourA;
    const readCompanion = history.flipped ? companionB : companionA;
    const writeColour = history.flipped ? colourA : colourB;
    const writeCompanion = history.flipped ? companionA : companionB;
    this.run(compute, "resolve", [
      u, input.view, targets.depth.view, targets.motion.view, readColour.view, readCompanion.view, sampler, writeColour.view, writeCompanion.view,
    ], width, height);
    history.flipped = !history.flipped;
    history.available = true;
    history.lastFrame = frame.frameNumber;
    const sharpened = this.other(input, width, height);
    this.run(compute, "temporalOutput", [u, writeColour.view, sharpened.view], width, height);
    return sharpened;
  }

  /** Beams of sunlight: the sky's glare around the sun, drawn out from it at half size. */
  private shafts(compute: GPUComputePassEncoder, input: PostImage, depth: GPUTextureView): GPUTextureView {
    const { pool, sampler, uniforms: u } = this.state!;
    const width = Math.max(1, Math.round(input.width / 2));
    const height = Math.max(1, Math.round(input.height / 2));
    const mask = pool.image("shafts.mask", width, height);
    const blur = pool.image("shafts.blur", width, height);
    this.run(compute, "shaftMask", [u, input.view, depth, sampler, mask.view], width, height);
    this.run(compute, "shaftBlur", [u, mask.view, sampler, blur.view], width, height);
    return blur.view;
  }

  /** Circles of confusion and the blurred far and near pictures, for the lens step to lay over the sharp one. */
  private depthOfField(
    compute: GPUComputePassEncoder,
    input: PostImage,
    depth: GPUTextureView,
  ): { coc: GPUTextureView; cocBlurred: GPUTextureView; far: GPUTextureView; near: GPUTextureView } {
    const { pool, sampler, uniforms: u } = this.state!;
    const { width, height } = input;
    const coc = pool.image("dof.coc", width, height);
    const softA = pool.image("dof.soft.a", width, height);
    const softB = pool.image("dof.soft.b", width, height);
    const masked = pool.image("dof.masked", width, height);
    const working = pool.image("dof.working", width, height);
    const far = pool.image("dof.far", width, height);
    const near = pool.image("dof.near", width, height);
    this.run(compute, "coc", [u, depth, coc.view], width, height);
    this.run(compute, "kawase0", [coc.view, sampler, softA.view], width, height);
    this.run(compute, "kawase1", [softA.view, sampler, softB.view], width, height);
    this.run(compute, "kawase1", [softB.view, sampler, softA.view], width, height);
    this.run(compute, "kawase2", [softA.view, sampler, softB.view], width, height);
    this.run(compute, "dofMask", [u, input.view, coc.view, masked.view], width, height);
    this.run(compute, "bokehFarBase", [u, masked.view, coc.view, sampler, working.view], width, height);
    this.run(compute, "bokehFarFill", [u, working.view, coc.view, sampler, far.view], width, height);
    this.run(compute, "bokehNearBase", [u, input.view, softB.view, sampler, working.view], width, height);
    this.run(compute, "bokehNearFill", [u, working.view, softB.view, sampler, near.view], width, height);
    return { coc: coc.view, cocBlurred: softB.view, far: far.view, near: near.view };
  }

  /** What is bright enough to glow, blurred by going down a chain of smaller pictures and back up it. */
  private bloom(compute: GPUComputePassEncoder, input: PostImage): GPUTextureView {
    const { pool, sampler, uniforms: u } = this.state!;
    const bright = pool.image("bloom.bright", input.width, input.height);
    this.run(compute, "bloomBright", [u, input.view, bright.view], input.width, input.height);
    const width = Math.max(1, Math.round(input.width / 2));
    const height = Math.max(1, Math.round(input.height / 2));
    const levels = Math.min(BLOOM_LEVELS, Math.floor(Math.log2(Math.max(width, height))) + 1);
    const down = pool.image("bloom.down", width, height, levels);
    const up = pool.image("bloom.up", width, height, Math.max(1, levels - 1));
    const widthAt = (level: number) => Math.max(1, width >> level);
    const heightAt = (level: number) => Math.max(1, height >> level);
    let previous = bright.view;
    for (let level = 0; level < levels; level++) {
      this.run(compute, "bloomDown", [previous, sampler, down.levels[level]], widthAt(level), heightAt(level));
      previous = down.levels[level];
    }
    for (let level = levels - 2; level >= 0; level--) {
      this.run(compute, "bloomUp", [u, previous, down.levels[level], sampler, up.levels[level]], widthAt(level), heightAt(level));
      previous = up.levels[level];
    }
    return previous;
  }

  /** Gives back the GPU's memory; the next frame run makes what it needs again. */
  dispose(): void {
    for (const view of this.views.values()) view.exposure.destroy();
    this.views.clear();
    if (!this.state) return;
    this.state.pool.dispose();
    this.state.uniforms.destroy();
    this.state.blackTexture.destroy();
    this.state = null;
  }
}
