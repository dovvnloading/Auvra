/// <reference types="@webgpu/types" />
import type * as THREE from "three";
import type { GpuFrame, GpuPass, GpuTarget } from "../frame";
import type { EnvironmentProduct } from "../lightingWgsl";
import type { DepthPyramidProduct } from "../passes/depthPyramid";
import { SCREEN_PARAM_WORDS, SCREEN_PROGRAMS, SCREEN_WORKGROUP, type ScreenProgram, type ScreenProgramName } from "./screenShaders";

/**
 * SCREEN LIGHTING
 *
 * Light worked out each frame from what is on screen, in compute:
 *  - Ambient occlusion and contact shadows: how much of the hemisphere round each pixel the depth blocks, and whether
 *    something close by stands between it and the sun. Traced at half size, eased over frames, denoised along surfaces
 *    and brought up to full size against the depth.
 *  - Bounced light: a few rays from each pixel through the depth bring the lit colour of what they land on, or the sky's
 *    light if they escape. The difference from the indirect light lighting gave that pixel is eased over frames and
 *    smoothed along surfaces, so a sunlit wall tints the floor beside it and a room is darker inside than out.
 *  - Reflections: each glossy pixel follows its mirror ray by whole patches of the screen, using the surface pass's depth
 *    pyramid (the farthest depth of each patch) and a chain of nearest depths kept here, and takes the lit colour it
 *    meets. Faded toward the screen edges and for rough surfaces, with the environment where the ray found nothing.
 *
 * The tracing runs after the surface buffer and before lighting, which is what lets lighting use occlusion, so the
 * colour a ray finds comes from the last frame's lit picture, looked up where that surface was then. Bounced light and
 * reflections go back onto the lit picture in a second pass after lighting, and that same step keeps the picture for
 * the next frame, as it was before they were added: light does not build on itself from frame to frame.
 *
 * Publishes in frame.products:
 *   "ao": ScreenOcclusionProduct, screen size. Red is ambient occlusion with its strength applied, green is the sun's
 *         contact shadow; for both, 1 is open. Only while either is on.
 *   "reflections": ScreenReflectionsProduct, half size. Only while they are on.
 * Reads, each optional: "depthPyramid", "environment", "gi", "shadowMaps".
 */

/** "ao": read red for occlusion, green for the sun's contact shadow. */
export interface ScreenOcclusionProduct {
  view: GPUTextureView;
}

/** "reflections": rgba16float. rgb is what a surface sees, the environment where no ray landed; alpha is how far a ray can be trusted. */
export interface ScreenReflectionsProduct {
  view: GPUTextureView;
  width: number;
  height: number;
}

/** What the effect shows: the lit picture, or one part on its own. */
export type GpuScreenView = "final" | "bounce" | "reflections";

export interface GpuScreenSettings {
  /** Strength of the bounced light; 0 turns it off. */
  bounce: number;
  /** How far bounced light reaches, in metres. */
  bounceRadius: number;
  /** Strength of reflections; 0 turns them off. */
  reflections: number;
  /** How far a reflection ray travels, in metres. */
  reflectionDistance: number;
  /** The power occlusion is raised to; 0 turns it off. */
  aoIntensity: number;
  /** World-space radius in metres that occlusion is gathered over. */
  aoRadius: number;
  /** How far toward the sun a contact shadow looks, in metres; 0 turns it off. */
  contactShadowLength: number;
  view: GpuScreenView;
}

export const GPU_SCREEN_DEFAULTS: Readonly<GpuScreenSettings> = {
  bounce: 1,
  bounceRadius: 3,
  reflections: 1,
  reflectionDistance: 20,
  aoIntensity: 2,
  aoRadius: 1.5,
  contactShadowLength: 0.25,
  view: "final",
};

/** The fields of a level's post-process stack that this takes. */
export interface ScreenStackSettings {
  ambientOcclusion: boolean;
  aoIntensity: number;
  aoRadius: number;
  globalIllumination: boolean;
  giIntensity: number;
  reflections: boolean;
  reflectionIntensity: number;
}

/** A level's post-process stack in these terms. */
export const screenSettingsFromStack = (stack: ScreenStackSettings): Partial<GpuScreenSettings> => ({
  aoIntensity: stack.ambientOcclusion ? stack.aoIntensity : 0,
  aoRadius: stack.aoRadius,
  bounce: stack.globalIllumination ? stack.giIntensity : 0,
  reflections: stack.reflections ? stack.reflectionIntensity : 0,
});

const HDR: GPUTextureFormat = "rgba16float";
const BYTES: GPUTextureFormat = "rgba8unorm";
const NOISE_FRAMES = 64;
/** Bind groups kept before the old ones are let go: enough for every view in use, and a new one is cheap. */
const MOST_GROUPS = 256;
/** What the stack's occlusion fades over: the radius, times its falloff setting of 0.2 of the radius, times 0.2 again. */
const FALLOFF_PER_RADIUS_SQUARED = 0.04;

interface BuiltProgram {
  name: ScreenProgramName;
  layout: GPUBindGroupLayout;
  pipeline: GPUComputePipeline;
}

/** What only exists while there is a device. */
interface DeviceParts {
  device: GPUDevice;
  params: GPUBuffer;
  paramsBinding: GPUBufferBinding;
  sampler: GPUSampler;
  blankTexture: GPUTexture;
  blank: GPUTextureView;
  blankCubeTexture: GPUTexture;
  blankCube: GPUTextureView;
}

interface NearestChain {
  texture: GPUTexture;
  /** Every level, for reading. */
  view: GPUTextureView;
  levels: GPUTextureView[];
}

export class ScreenLightingPasses {
  readonly settings: GpuScreenSettings;
  /** Before lighting: traces everything and publishes what lighting reads. */
  readonly trace: GpuPass;
  /** After lighting: bounced light and reflections onto the lit picture. */
  readonly compose: GpuPass;
  readonly passes: readonly GpuPass[];

  private parts: DeviceParts | null = null;
  private cameraLayout: GPUBindGroupLayout | null = null;
  private readonly programs = new Map<ScreenProgramName, BuiltProgram>();
  private readonly modules = new Map<string, GPUShaderModule>();
  private readonly groups = new Map<string, GPUBindGroup>();
  private readonly ids = new WeakMap<object, number>();
  private nextId = 1;
  private readonly textures = new Map<string, GpuTarget>();
  private nearest: NearestChain | null = null;
  private readonly paramData = new Float32Array(SCREEN_PARAM_WORDS);

  private width = 0;
  private height = 0;
  private halfWidth = 0;
  private halfHeight = 0;
  private camera: THREE.Camera | null = null;
  private noisePhase = 0;
  /** Which of the two history textures holds the last frame. */
  private occlusionHistory = 0;
  private bounceHistory = 0;
  private occlusionHasHistory = false;
  private bounceHasHistory = false;
  /** Whether "lit" holds a frame. */
  private litExists = false;

  /** What the trace left for compose this frame. */
  private tracedFrame = -1;
  private occlusionView: GPUTextureView | null = null;
  private bounceView: GPUTextureView | null = null;
  private foundView: GPUTextureView | null = null;
  private environmentView: GPUTextureView | null = null;

  private products: Map<string, unknown> | null = null;
  private occlusionProduct: ScreenOcclusionProduct | null = null;
  private reflectionsProduct: ScreenReflectionsProduct | null = null;
  private disposed = false;

  /** `settings` is kept and read each frame, so changing it in place is how settings change. */
  constructor(settings: GpuScreenSettings = { ...GPU_SCREEN_DEFAULTS }) {
    this.settings = settings;
    this.trace = {
      id: "screen-lighting",
      stage: "afterSurfaces",
      order: 20,
      execute: (frame) => this.runTrace(frame),
      dispose: () => this.dispose(),
    };
    this.compose = {
      id: "screen-lighting-compose",
      stage: "afterLighting",
      // Ahead of what goes over the lit picture: what stands in the air veils reflections as well.
      order: -10,
      execute: (frame) => this.runCompose(frame),
      dispose: () => this.dispose(),
    };
    this.passes = [this.trace, this.compose];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unpublish();
    this.releaseSized();
    this.programs.clear();
    this.modules.clear();
    if (this.parts) {
      this.parts.params.destroy();
      this.parts.blankTexture.destroy();
      this.parts.blankCubeTexture.destroy();
      this.parts = null;
    }
  }

  private unpublish(): void {
    const { products } = this;
    if (!products) return;
    if (products.get("ao") === this.occlusionProduct) products.delete("ao");
    if (products.get("reflections") === this.reflectionsProduct) products.delete("reflections");
    this.occlusionProduct = null;
    this.reflectionsProduct = null;
  }

  private partsFor(device: GPUDevice): DeviceParts {
    if (this.parts?.device === device) return this.parts;
    this.releaseSized();
    this.programs.clear();
    this.modules.clear();
    const params = device.createBuffer({ label: "gpu screen params", size: this.paramData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const blankTexture = device.createTexture({ label: "gpu screen blank", size: [1, 1], format: HDR, usage: GPUTextureUsage.TEXTURE_BINDING });
    const blankCubeTexture = device.createTexture({ label: "gpu screen no environment", size: [1, 1, 6], format: HDR, usage: GPUTextureUsage.TEXTURE_BINDING });
    this.parts = {
      device,
      params,
      paramsBinding: { buffer: params },
      sampler: device.createSampler({ label: "gpu screen linear", magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" }),
      blankTexture,
      blank: blankTexture.createView(),
      blankCubeTexture,
      blankCube: blankCubeTexture.createView({ dimension: "cube" }),
    };
    return this.parts;
  }

  private releaseSized(): void {
    for (const target of this.textures.values()) target.texture.destroy();
    this.textures.clear();
    this.nearest?.texture.destroy();
    this.nearest = null;
    this.groups.clear();
    this.width = 0;
    this.height = 0;
    this.occlusionHasHistory = false;
    this.bounceHasHistory = false;
    this.litExists = false;
  }

  /** Follows the device, the frame's targets and the camera. */
  private follow(frame: GpuFrame): void {
    this.products = frame.products;
    this.partsFor(frame.device);
    if (frame.cameraLayout !== this.cameraLayout) {
      this.cameraLayout = frame.cameraLayout;
      this.programs.clear();
      this.groups.clear();
    }
    const { width, height } = frame.targets;
    if (width !== this.width || height !== this.height) {
      this.releaseSized();
      this.width = width;
      this.height = height;
      this.halfWidth = Math.max(1, Math.round(width / 2));
      this.halfHeight = Math.max(1, Math.round(height / 2));
    }
    if (frame.camera !== this.camera) {
      // What another camera saw is no history for this one.
      this.camera = frame.camera;
      this.occlusionHasHistory = false;
      this.bounceHasHistory = false;
      this.litExists = false;
    }
  }

  private texture(name: string, width: number, height: number, format: GPUTextureFormat, extraUsage = 0): GpuTarget {
    let target = this.textures.get(name);
    if (!target) {
      const texture = this.parts!.device.createTexture({
        label: `gpu screen ${name}`,
        size: [width, height],
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | extraUsage,
      });
      target = { texture, view: texture.createView() };
      this.textures.set(name, target);
    }
    return target;
  }

  private half(name: string): GPUTextureView {
    return this.texture(name, this.halfWidth, this.halfHeight, HDR).view;
  }

  private lit(): GpuTarget {
    return this.texture("lit", this.width, this.height, HDR, GPUTextureUsage.COPY_DST);
  }

  private program(name: ScreenProgramName): BuiltProgram {
    const built = this.programs.get(name);
    if (built) return built;
    const { device } = this.parts!;
    const spec: ScreenProgram = SCREEN_PROGRAMS[name];
    const label = `gpu screen ${name}`;
    const layout = device.createBindGroupLayout({
      label,
      entries: spec.bindings.map((entry, binding) => ({ ...entry, binding, visibility: GPUShaderStage.COMPUTE })),
    });
    let module = this.modules.get(spec.code);
    if (!module) {
      module = device.createShaderModule({ label, code: spec.code });
      this.modules.set(spec.code, module);
    }
    const pipeline = device.createComputePipeline({
      label,
      layout: device.createPipelineLayout({ label, bindGroupLayouts: [this.cameraLayout!, layout] }),
      compute: { module, entryPoint: spec.entryPoint ?? "main", ...(spec.constants ? { constants: spec.constants } : {}) },
    });
    const program: BuiltProgram = { name, layout, pipeline };
    this.programs.set(name, program);
    return program;
  }

  private idOf(resource: object): number {
    let id = this.ids.get(resource);
    if (!id) {
      id = this.nextId++;
      this.ids.set(resource, id);
    }
    return id;
  }

  /** The settings, then `resources`, by binding. The same resources get the same group. */
  private groupFor(program: BuiltProgram, resources: readonly GPUBindingResource[]): GPUBindGroup {
    const { device, paramsBinding } = this.parts!;
    let key: string = program.name;
    for (const resource of resources) key += `/${this.idOf(resource)}`;
    let group = this.groups.get(key);
    if (!group) {
      if (this.groups.size >= MOST_GROUPS) this.groups.clear();
      group = device.createBindGroup({
        label: `gpu screen ${program.name}`,
        layout: program.layout,
        entries: [paramsBinding, ...resources].map((resource, binding) => ({ binding, resource })),
      });
      this.groups.set(key, group);
    }
    return group;
  }

  private dispatch(pass: GPUComputePassEncoder, name: ScreenProgramName, resources: readonly GPUBindingResource[], width: number, height: number): void {
    const program = this.program(name);
    pass.setPipeline(program.pipeline);
    pass.setBindGroup(1, this.groupFor(program, resources));
    pass.dispatchWorkgroups(Math.ceil(width / SCREEN_WORKGROUP), Math.ceil(height / SCREEN_WORKGROUP));
  }

  /** The sun that casts the cascades when there is one, as that is the shadow this sharpens; otherwise the strongest. */
  private sunOf(frame: GpuFrame): THREE.DirectionalLight | null {
    const { directional } = frame.gpuScene;
    if (directional.length === 0) return null;
    const cascades = (frame.products.get("shadowMaps") as { cascades?: { sunIndex: number } | null } | undefined)?.cascades;
    if (cascades && directional[cascades.sunIndex]) return directional[cascades.sunIndex];
    let strongest = directional[0];
    for (const light of directional) if (light.intensity > strongest.intensity) strongest = light;
    return strongest;
  }

  private writeParams(frame: GpuFrame, sun: THREE.DirectionalLight | null, environment: EnvironmentProduct | undefined, hasGathered: boolean, hasPyramid: boolean): void {
    const { settings, paramData: data } = this;
    const { gpuScene, scene } = frame;
    data.fill(0);
    if (sun) {
      const from = sun.matrixWorld.elements;
      const to = sun.target.matrixWorld.elements;
      const x = from[12] - to[12];
      const y = from[13] - to[13];
      const z = from[14] - to[14];
      const size = Math.hypot(x, y, z);
      if (size > 0) {
        data[0] = x / size;
        data[1] = y / size;
        data[2] = z / size;
        data[3] = 1;
      }
    }
    data[4] = gpuScene.ambient.r;
    data[5] = gpuScene.ambient.g;
    data[6] = gpuScene.ambient.b;
    data[8] = gpuScene.hemiSky.r;
    data[9] = gpuScene.hemiSky.g;
    data[10] = gpuScene.hemiSky.b;
    data[12] = gpuScene.hemiGround.r;
    data[13] = gpuScene.hemiGround.g;
    data[14] = gpuScene.hemiGround.b;
    // Lighting's own reading: the product's numbers times the scene's environment intensity.
    const intensity = (scene as unknown as { environmentIntensity?: number }).environmentIntensity ?? 1;
    if (environment) {
      for (let coefficient = 0; coefficient < 9; coefficient++) {
        for (let channel = 0; channel < 3; channel++) {
          data[16 + coefficient * 4 + channel] = environment.diffuseSH[coefficient * 3 + channel] * intensity;
        }
      }
    }
    data[52] = settings.aoRadius;
    data[53] = Math.max(settings.aoRadius * settings.aoRadius * FALLOFF_PER_RADIUS_SQUARED, 1e-4);
    data[54] = settings.aoIntensity;
    data[55] = sun ? settings.contactShadowLength : 0;
    data[56] = settings.bounceRadius;
    data[57] = settings.bounce;
    data[58] = settings.reflectionDistance;
    data[59] = settings.reflections;
    data[60] = this.noisePhase;
    data[61] = this.litExists ? 1 : 0;
    data[62] = this.occlusionHasHistory ? 1 : 0;
    data[63] = this.bounceHasHistory ? 1 : 0;
    data[64] = intensity;
    data[65] = environment ? environment.specularMips : 0;
    data[66] = settings.view === "bounce" ? 1 : settings.view === "reflections" ? 2 : 0;
    data[67] = hasPyramid ? 1 : 0;
    data[68] = hasGathered ? 1 : 0;
    frame.device.queue.writeBuffer(this.parts!.params, 0, data);
  }

  private runTrace(frame: GpuFrame): void {
    if (this.disposed) return;
    const { settings } = this;
    // A ray needs a perspective camera to be a straight line by these sums; occlusion does not.
    const perspective = (frame.camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
    const wantsBounce = perspective && settings.bounce > 0;
    const wantsReflections = perspective && settings.reflections > 0;
    const sun = this.sunOf(frame);
    const wantsOcclusion = settings.aoIntensity > 0 || (settings.contactShadowLength > 0 && sun !== null);

    this.occlusionView = null;
    this.bounceView = null;
    this.foundView = null;
    if (!wantsOcclusion) {
      frame.products.delete("ao");
      this.occlusionHasHistory = false;
    }
    if (!wantsReflections) frame.products.delete("reflections");
    if (!wantsBounce) this.bounceHasHistory = false;
    if (!wantsBounce && !wantsReflections) this.litExists = false;
    if (!wantsOcclusion && !wantsBounce && !wantsReflections) return;

    this.follow(frame);
    this.noisePhase = (this.noisePhase + 1) % NOISE_FRAMES;

    const environment = frame.products.get("environment") as EnvironmentProduct | undefined;
    const gathered = frame.products.get("gi") as { view: GPUTextureView } | undefined;
    const pyramid = wantsReflections ? this.pyramidFor(frame) : null;
    this.writeParams(frame, sun, environment, !!gathered, !!pyramid);
    this.environmentView = environment?.specular ?? this.parts!.blankCube;

    const pass = frame.encoder.beginComputePass({ label: "gpu screen lighting" });
    pass.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    if (wantsOcclusion) this.traceOcclusion(frame, pass);
    if (wantsBounce) this.traceBounce(frame, pass, gathered?.view ?? this.parts!.blank);
    if (wantsReflections) this.traceReflections(frame, pass, pyramid);
    pass.end();
    this.tracedFrame = frame.frameNumber;
  }

  /** The surface pass's pyramid, if it has the levels the nearest chain does. */
  private pyramidFor(frame: GpuFrame): GPUTextureView | null {
    const pyramid = frame.products.get("depthPyramid") as DepthPyramidProduct | undefined;
    if (!pyramid) return null;
    const levels = this.chainLevels(frame.targets.width, frame.targets.height);
    return pyramid.mips > levels ? pyramid.view : null;
  }

  /** Levels below the depth target itself. */
  private chainLevels(width: number, height: number): number {
    return Math.max(1, Math.floor(Math.log2(Math.max(width, height))));
  }

  private traceOcclusion(frame: GpuFrame, pass: GPUComputePassEncoder): void {
    const { targets, products } = frame;
    const { halfWidth: w, halfHeight: h } = this;
    const depth = targets.depth.view;
    const raw = this.half("occlusionRaw");
    this.dispatch(pass, "occlusionTrace", [depth, raw], w, h);
    const read = this.half(`occlusionHistory${this.occlusionHistory}`);
    this.occlusionHistory = 1 - this.occlusionHistory;
    const written = this.half(`occlusionHistory${this.occlusionHistory}`);
    this.dispatch(pass, "occlusionTemporal", [depth, targets.motion.view, raw, read, written], w, h);
    this.occlusionHasHistory = true;
    const first = this.half("occlusionBlur0");
    const second = this.half("occlusionBlur1");
    this.dispatch(pass, "occlusionBlurFirst", [depth, targets.normal.view, written, first], w, h);
    this.dispatch(pass, "occlusionBlurSecond", [depth, targets.normal.view, first, second], w, h);
    const { view } = this.texture("occlusion", this.width, this.height, BYTES);
    this.dispatch(pass, "occlusionResolve", [depth, second, view], this.width, this.height);
    this.occlusionView = view;
    if (this.occlusionProduct?.view !== view) this.occlusionProduct = { view };
    products.set("ao", this.occlusionProduct);
  }

  private traceBounce(frame: GpuFrame, pass: GPUComputePassEncoder, gathered: GPUTextureView): void {
    const { targets } = frame;
    const { halfWidth: w, halfHeight: h } = this;
    const depth = targets.depth.view;
    const motion = targets.motion.view;
    const raw = this.half("bounceRaw");
    this.dispatch(pass, "bounceTrace", [depth, targets.normal.view, motion, this.lit().view, gathered, raw], w, h);
    const read = this.half(`bounceHistory${this.bounceHistory}`);
    this.bounceHistory = 1 - this.bounceHistory;
    const written = this.half(`bounceHistory${this.bounceHistory}`);
    this.dispatch(pass, "bounceTemporal", [depth, motion, raw, read, written], w, h);
    this.bounceHasHistory = true;
    const first = this.half("bounceSmooth0");
    const second = this.half("bounceSmooth1");
    this.dispatch(pass, "bounceSmoothFirst", [targets.normal.view, written, first], w, h);
    this.dispatch(pass, "bounceSmoothSecond", [targets.normal.view, first, second], w, h);
    this.bounceView = second;
  }

  private nearestChain(): NearestChain {
    if (this.nearest) return this.nearest;
    const mipLevelCount = this.chainLevels(this.width, this.height);
    const texture = this.parts!.device.createTexture({
      label: "gpu screen nearest depth",
      size: [Math.max(1, this.width >> 1), Math.max(1, this.height >> 1)],
      format: "r32float",
      mipLevelCount,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    const levels: GPUTextureView[] = [];
    for (let level = 0; level < mipLevelCount; level++) levels.push(texture.createView({ baseMipLevel: level, mipLevelCount: 1 }));
    this.nearest = { texture, view: texture.createView(), levels };
    return this.nearest;
  }

  private traceReflections(frame: GpuFrame, pass: GPUComputePassEncoder, pyramid: GPUTextureView | null): void {
    const { targets, products } = frame;
    const { halfWidth: w, halfHeight: h } = this;
    const parts = this.parts!;
    const depth = targets.depth.view;
    const chain = this.nearestChain();
    chain.levels.forEach((level, index) => {
      const levelWidth = Math.max(1, this.width >> (index + 1));
      const levelHeight = Math.max(1, this.height >> (index + 1));
      if (index === 0) this.dispatch(pass, "nearestFromDepth", [depth, parts.blank, level], levelWidth, levelHeight);
      else this.dispatch(pass, "nearestFromLevel", [depth, chain.levels[index - 1], level], levelWidth, levelHeight);
    });
    const raw = this.half("reflectionRaw");
    this.dispatch(pass, "reflectionTrace", [depth, targets.normal.view, targets.emissive.view, targets.motion.view, this.lit().view, chain.view, pyramid ?? chain.view, raw], w, h);
    const view = this.half("reflections");
    const found = this.half("reflectionFound");
    this.dispatch(pass, "reflectionSmooth", [depth, targets.normal.view, raw, this.environmentView!, parts.sampler, view, found], w, h);
    this.foundView = found;
    if (this.reflectionsProduct?.view !== view) this.reflectionsProduct = { view, width: w, height: h };
    products.set("reflections", this.reflectionsProduct);
  }

  private runCompose(frame: GpuFrame): void {
    if (this.disposed || this.tracedFrame !== frame.frameNumber || (!this.bounceView && !this.foundView)) return;
    const { targets, encoder } = frame;
    const parts = this.parts!;
    const lit = this.lit();
    encoder.copyTextureToTexture({ texture: targets.hdr.texture }, { texture: lit.texture }, [this.width, this.height]);
    this.litExists = true;
    const pass = encoder.beginComputePass({ label: "gpu screen lighting compose" });
    pass.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    this.dispatch(pass, "compose", [
      targets.depth.view,
      targets.normal.view,
      targets.albedo.view,
      targets.emissive.view,
      lit.view,
      this.bounceView ?? parts.blank,
      this.foundView ?? parts.blank,
      this.occlusionView ?? parts.blank,
      this.environmentView!,
      parts.sampler,
      targets.hdr.view,
    ], this.width, this.height);
    pass.end();
  }
}
