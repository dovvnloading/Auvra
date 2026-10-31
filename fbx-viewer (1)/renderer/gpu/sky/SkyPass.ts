/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { CLOUD_EDGE, GROUND_RADIUS, TOP_RADIUS } from "../../../runtime/sky/atmosphere";
import type { GpuCore } from "../device";
import type { GpuFrame, GpuPass, GpuRendererApi, GpuStage } from "../frame";
import { CAMERA_BINDINGS_WGSL, VIEW_WGSL } from "../shaders";
import { AtmosphereTables } from "./atmosphereTables";
import { CloudMap } from "./cloudMap";
import { DOME_BYTES, domeBindGroupLayout, DomeBindings, domeWgsl, writeDome } from "./dome";
import { NEUTRAL_CAPTURE, SkyCapture } from "./skyCapture";
import { SkyOverlay } from "./skyOverlay";
import {
  SKY_PASS_SETTING, SKY_SETTINGS,
  type CloudShadowProduct, type GpuClassicSky, type GpuSkySettings, type SkyFogProduct, type SkyTransmittanceProduct, type SkyVisibilityProduct,
} from "./skySettings";
import { SkyVisibility } from "./skyVisibility";

/**
 * THE SKY
 *
 * Fills what the scene left uncovered in the HDR target: the atmosphere with its clouds, stars and moon, a panorama, the
 * classic analytic sky, or, in a level with no sky, the scene's own background. It does its work in three places. As the
 * frame starts it brings the tables, clouds and Sky Light up to date and publishes them (skySettings.ts says what), so
 * lighting reads them the same frame; in the shadow stage it keeps the sky visibility map; and after lighting it fills
 * the pixels where depth is still 0. A pixel's light here is linear and goes on to tone mapping with everything else.
 */

const FILL_BYTES = 112;
const WORKGROUP = 8;

const FILL_HEAD_WGSL = /* wgsl */ `
${VIEW_WGSL}
${CAMERA_BINDINGS_WGSL}

// A pixel's way out into the world: by turning, not from a point, so it holds however far the camera is from the origin.
fn viewDirection(pixel: vec2u, size: vec2u) -> vec3f {
  let uv = (vec2f(pixel) + 0.5) / vec2f(size);
  let p = view.inverseProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.5, 1.0);
  let local = p.xyz / p.w;
  let m = view.viewMatrix;
  return normalize(vec3f(dot(m[0].xyz, local), dot(m[1].xyz, local), dot(m[2].xyz, local)));
}
`;

const TARGETS_WGSL = (group: number): string => /* wgsl */ `
@group(${group}) @binding(0) var hdrTarget: texture_storage_2d<rgba16float, write>;
@group(${group}) @binding(1) var depthTarget: texture_depth_2d;
`;

const FILL_DOME_WGSL = /* wgsl */ `
${FILL_HEAD_WGSL}
${domeWgsl(1)}
${TARGETS_WGSL(2)}

@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP}) fn fillDome(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(depthTarget);
  if (id.x >= size.x || id.y >= size.y) { return; }
  if (textureLoad(depthTarget, id.xy, 0) > 0.0) { return; }
  textureStore(hdrTarget, id.xy, vec4f(domeColour(viewDirection(id.xy, size)), 1.0));
}
`;

const FILL_PLAIN_WGSL = /* wgsl */ `
${FILL_HEAD_WGSL}
const PLAIN_PI = 3.141592653589793;

struct Plain {
  colour: vec3f,
  intensity: f32,
  turn: mat3x3f,
  sunDirection: vec3f,
  sunE: f32,
  betaR: vec3f,
  sunFade: f32,
  betaM: vec3f,
  mieG: f32,
}
@group(1) @binding(0) var<uniform> plain: Plain;
@group(1) @binding(1) var backgroundImage: texture_2d<f32>;
@group(1) @binding(2) var backgroundCube: texture_cube<f32>;
@group(1) @binding(3) var backgroundSampler: sampler;
${TARGETS_WGSL(2)}

fn covered(id: vec3u, size: vec2u) -> bool {
  return id.x >= size.x || id.y >= size.y || textureLoad(depthTarget, id.xy, 0) > 0.0;
}

// A single colour, for a background of one or when there is none.
@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP}) fn fillFlat(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(depthTarget);
  if (covered(id, size)) { return; }
  textureStore(hdrTarget, id.xy, vec4f(plain.colour * plain.intensity, 1.0));
}

// An image wrapped round the sky.
@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP}) fn fillEquirect(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(depthTarget);
  if (covered(id, size)) { return; }
  let direction = plain.turn * viewDirection(id.xy, size);
  let uv = vec2f(atan2(direction.z, direction.x) / (2.0 * PLAIN_PI) + 0.5, asin(clamp(direction.y, -1.0, 1.0)) / PLAIN_PI + 0.5);
  textureStore(hdrTarget, id.xy, vec4f(textureSampleLevel(backgroundImage, backgroundSampler, uv, 0.0).rgb * plain.intensity, 1.0));
}

// An image laid flat on the screen.
@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP}) fn fillScreen(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(depthTarget);
  if (covered(id, size)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  textureStore(hdrTarget, id.xy, vec4f(textureSampleLevel(backgroundImage, backgroundSampler, vec2f(uv.x, 1.0 - uv.y), 0.0).rgb * plain.intensity, 1.0));
}

// Six images round the camera.
@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP}) fn fillCube(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(depthTarget);
  if (covered(id, size)) { return; }
  let direction = plain.turn * viewDirection(id.xy, size);
  textureStore(hdrTarget, id.xy, vec4f(textureSampleLevel(backgroundCube, backgroundSampler, direction, 0.0).rgb * plain.intensity, 1.0));
}

// The older analytic sky: the sun's height and the haze make its colour, with no tables.
fn rayleighPhase(cosTheta: f32) -> f32 { return 0.05968310365946075 * (1.0 + pow(cosTheta, 2.0)); }

fn hgPhase(cosTheta: f32, g: f32) -> f32 {
  let g2 = pow(g, 2.0);
  let inverse = 1.0 / pow(1.0 - 2.0 * g * cosTheta + g2, 1.5);
  return 0.07957747154594767 * ((1.0 - g2) * inverse);
}

@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP}) fn fillClassic(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(depthTarget);
  if (covered(id, size)) { return; }
  let direction = viewDirection(id.xy, size);
  let up = vec3f(0.0, 1.0, 0.0);
  // Optical length, cut off at 90 degrees to avoid the formula's singularity.
  let zenithAngle = acos(max(0.0, dot(up, direction)));
  let inverse = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - ((zenithAngle * 180.0) / PLAIN_PI), -1.253));
  let sR = 8.4e3 * inverse;
  let sM = 1.25e3 * inverse;
  // Combined extinction.
  let fex = exp(-(plain.betaR * sR + plain.betaM * sM));
  // In scattering.
  let cosTheta = dot(direction, plain.sunDirection);
  let betaRTheta = plain.betaR * rayleighPhase(cosTheta * 0.5 + 0.5);
  let betaMTheta = plain.betaM * hgPhase(cosTheta, plain.mieG);
  let share = (betaRTheta + betaMTheta) / (plain.betaR + plain.betaM);
  var lin = pow(plain.sunE * share * (vec3f(1.0) - fex), vec3f(1.5));
  lin *= mix(vec3f(1.0), pow(plain.sunE * share * fex, vec3f(0.5)), clamp(pow(1.0 - dot(up, plain.sunDirection), 5.0), 0.0, 1.0));
  // The night sky, and the sun's disc.
  var l0 = vec3f(0.1) * fex;
  let sundisk = smoothstep(0.9999566769464484, 0.9999566769464484 + 0.00002, cosTheta);
  l0 += (plain.sunE * 19000.0 * fex) * sundisk;
  let tex = (lin + l0) * 0.04 + vec3f(0.0, 0.0003, 0.00075);
  let colour = pow(tex, vec3f(1.0 / (1.2 + (1.2 * plain.sunFade))));
  textureStore(hdrTarget, id.xy, vec4f(colour, 1.0));
}
`;

const CLASSIC_RAYLEIGH: readonly [number, number, number] = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const CLASSIC_MIE: readonly [number, number, number] = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const CLASSIC_CUTOFF = 1.6110731556870734;
const CLASSIC_STEEPNESS = 1.5;
const CLASSIC_EE = 1000;

const _sunDirection = new THREE.Vector3();
const _matrix = new THREE.Matrix4();
const _matrix3 = new THREE.Matrix3();
const _euler = new THREE.Euler();
const _black = new THREE.Color(0, 0, 0);

type PlainMode = "fillFlat" | "fillEquirect" | "fillScreen" | "fillCube" | "fillClassic";

/** Six images uploaded as a cube, for a background that is one. */
interface CubeBackground {
  source: THREE.CubeTexture;
  version: number;
  texture: GPUTexture;
  view: GPUTextureView;
}

const cubeFaceImages = (texture: THREE.CubeTexture): (ImageBitmap | HTMLImageElement | HTMLCanvasElement)[] | null => {
  const images = texture.image as unknown as (ImageBitmap | HTMLImageElement | HTMLCanvasElement)[] | undefined;
  if (!Array.isArray(images) || images.length !== 6) return null;
  const copyable = images.every((image) => image && (image as ImageBitmap).width > 0);
  return copyable ? images : null;
};

export class SkyPass implements GpuPass {
  readonly id = "sky";
  readonly stage: GpuStage = "afterLighting";
  readonly order = 0;
  /** The two that go with it, which the renderer runs earlier in the frame. See `register`. */
  readonly companions: readonly GpuPass[];

  private readonly device: GPUDevice;
  private readonly settings: Map<string, unknown> | null;
  private readonly capture: SkyCapture;
  private readonly overlay: SkyOverlay;
  private tables: AtmosphereTables | null = null;
  private clouds: CloudMap | null = null;
  private visibility: SkyVisibility | null = null;

  private readonly domeBuffer: GPUBuffer;
  private readonly domeData = new Float32Array(DOME_BYTES / 4);
  private readonly domeLayout: GPUBindGroupLayout;
  private readonly domeBindings: DomeBindings;
  private readonly plainLayout: GPUBindGroupLayout;
  private readonly targetLayout: GPUBindGroupLayout;
  private readonly plainBuffer: GPUBuffer;
  private readonly plainData = new Float32Array(FILL_BYTES / 4);
  private readonly backgroundSampler: GPUSampler;
  private readonly blackCube: GPUTexture;
  private readonly blackCubeView: GPUTextureView;
  private cubeBackground: CubeBackground | null = null;

  private domePipeline: GPUComputePipeline | null = null;
  private plainPipelines = new Map<PlainMode, GPUComputePipeline>();
  private plainModule: GPUShaderModule | null = null;
  private plainPipelineLayout: GPUPipelineLayout | null = null;

  private readonly targetGroups = new WeakMap<GPUTextureView, GPUBindGroup>();

  private preparedFrame = -1;
  private lastSkyTime = NaN;
  private active: GpuSkySettings | null = null;
  private disposed = false;

  constructor(core: GpuCore, settings?: Map<string, unknown>) {
    const { device } = core;
    this.device = device;
    this.settings = settings ?? null;
    this.capture = new SkyCapture(device);
    this.overlay = new SkyOverlay(device);
    this.domeBuffer = device.createBuffer({ label: "sky dome", size: DOME_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.domeLayout = domeBindGroupLayout(device);
    this.domeBindings = new DomeBindings(device, this.domeLayout, this.domeBuffer);
    this.plainBuffer = device.createBuffer({ label: "sky plain", size: FILL_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.plainLayout = device.createBindGroupLayout({
      label: "sky plain",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float", viewDimension: "cube" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
      ],
    });
    this.targetLayout = device.createBindGroupLayout({
      label: "sky targets",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth" } },
      ],
    });
    this.backgroundSampler = device.createSampler({ label: "sky background", magFilter: "linear", minFilter: "linear", addressModeU: "repeat" });
    this.blackCube = device.createTexture({
      label: "sky black cube",
      size: [1, 1, 6],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.blackCubeView = this.blackCube.createView({ dimension: "cube" });
    this.companions = [
      { id: "sky-prepare", stage: "prepare", order: 1000, execute: (frame) => this.prepare(frame) },
      { id: "sky-visibility", stage: "shadow", order: 1000, execute: (frame) => this.updateVisibility(frame) },
    ];
  }

  /** Adds this pass and the two that go with it to `renderer`. */
  register(renderer: GpuRendererApi): void {
    renderer.addPass(this);
    for (const pass of this.companions) renderer.addPass(pass);
  }

  unregister(renderer: GpuRendererApi): void {
    renderer.removePass(this);
    for (const pass of this.companions) renderer.removePass(pass);
  }

  /** The clouds' shader has compiled and their noise is made: what the Sky Light waits for to take them in. */
  get cloudsReady(): boolean {
    return !!this.clouds?.ready;
  }

  /** A capture of the sky itself is in the environment. */
  get hasSkyCapture(): boolean {
    return this.capture.hasSkyCapture;
  }

  /** Frees what only a sky needs, for when a level with one goes away. Made again when the next one comes. */
  releaseSky(): void {
    this.clouds?.dispose();
    this.clouds = null;
    this.tables?.dispose();
    this.tables = null;
    this.visibility?.dispose();
    this.visibility = null;
    this.domeBindings.clear();
    this.lastSkyTime = NaN;
  }

  private settingsOf(frame: GpuFrame): GpuSkySettings | null {
    const map = this.settings ?? (frame.products.get("renderer") as GpuRendererApi | undefined)?.settings;
    return (map?.get(SKY_SETTINGS) as GpuSkySettings | undefined) ?? null;
  }

  /** The frame's first look at the sky: tables, clouds, the Sky Light, and what they publish. */
  private prepare(frame: GpuFrame): void {
    if (this.preparedFrame === frame.frameNumber || this.disposed) return;
    this.preparedFrame = frame.frameNumber;
    const settings = this.settingsOf(frame);
    this.active = settings;
    const atmosphere = settings?.model === "atmosphere" ? settings : null;
    if (atmosphere) {
      const { device } = this;
      this.tables ??= new AtmosphereTables(device);
      this.clouds ??= new CloudMap(device, this.tables);
      // A second view drawing the same frame of the sky changes nothing.
      if (atmosphere.frame.time !== this.lastSkyTime) {
        this.lastSkyTime = atmosphere.frame.time;
        this.tables.update(frame.encoder, atmosphere.frame);
        this.clouds.update(frame.encoder, atmosphere.frame);
      }
    }
    const sky = atmosphere && this.tables && this.clouds ? { frame: atmosphere.frame, tables: this.tables, clouds: this.clouds } : null;
    this.capture.update(frame, settings?.capture ?? NEUTRAL_CAPTURE, sky);
    this.publish(frame, settings);
  }

  private publish(frame: GpuFrame, settings: GpuSkySettings | null): void {
    const { products } = frame;
    if (this.capture.product) products.set("environment", this.capture.product);
    const { tables, clouds, visibility } = this;
    const atmospheric = settings?.model === "atmosphere" && !!tables;
    if (atmospheric && tables && settings) {
      const transmittance: SkyTransmittanceProduct = {
        view: tables.transmittance.view,
        sampler: tables.clampSampler,
        groundRadius: GROUND_RADIUS,
        topRadius: TOP_RADIUS,
        viewRadius: tables.viewRadius,
      };
      products.set("skyTransmittance", transmittance);
      const values = settings.scene;
      const fog: SkyFogProduct = {
        view: tables.skyView.view,
        sampler: tables.skyViewSampler,
        scale: values.fogScale,
        followsSky: values.fogFollowsSky,
        share: values.fogShare,
        grey: values.fogGrey,
      };
      products.set("skyFog", fog);
    } else {
      products.delete("skyTransmittance");
      products.delete("skyFog");
    }
    if (atmospheric && settings && clouds?.weatherReady && settings.scene.cloudStrength > 0) {
      const values = settings.scene;
      const shadow: CloudShadowProduct = {
        weather: clouds.weatherView,
        sampler: clouds.tilingSampler,
        tiling: values.cloudTiling,
        driftU: values.cloudDriftU,
        driftV: values.cloudDriftV,
        threshold: values.cloudThreshold,
        edge: CLOUD_EDGE,
        leanX: values.cloudLeanX,
        leanZ: values.cloudLeanZ,
        height: values.cloudHeight,
        strength: values.cloudStrength,
      };
      products.set("cloudShadow", shadow);
    } else {
      products.delete("cloudShadow");
    }
    if (settings?.visibilityOn && settings.scene.lightOn && visibility?.drawn) {
      const seen: SkyVisibilityProduct = {
        view: visibility.view,
        sampler: visibility.sampler,
        cornerX: visibility.cornerX,
        cornerZ: visibility.cornerZ,
        inverseSide: visibility.inverseSide,
        originY: visibility.originY,
        occlusion: settings.scene.occlusion,
        floor: settings.scene.occlusionFloor,
      };
      products.set("skyVisibility", seen);
    } else {
      products.delete("skyVisibility");
    }
  }

  private updateVisibility(frame: GpuFrame): void {
    this.prepare(frame);
    const settings = this.active;
    if (!settings?.visibilityOn || settings.model !== "atmosphere" || !frame.drawer) return;
    this.visibility ??= new SkyVisibility(this.device);
    this.visibility.update(frame, settings.visibilityHalfSide, settings.frame.time);
  }

  /** Several views share a canvas, each with targets of its own. */
  private targetsGroup(frame: GpuFrame): GPUBindGroup {
    const { hdr, depth } = frame.targets;
    let group = this.targetGroups.get(hdr.view);
    if (group) return group;
    group = this.device.createBindGroup({
      label: "sky targets",
      layout: this.targetLayout,
      entries: [
        { binding: 0, resource: hdr.view },
        { binding: 1, resource: depth.view },
      ],
    });
    this.targetGroups.set(hdr.view, group);
    return group;
  }

  private fillDome(frame: GpuFrame, settings: GpuSkySettings): boolean {
    const { tables, clouds } = this;
    if (!tables || !clouds) return false;
    const { device } = this;
    if (!this.domePipeline) {
      const module = device.createShaderModule({ label: "sky dome fill", code: FILL_DOME_WGSL });
      this.domePipeline = device.createComputePipeline({
        label: "sky dome fill",
        layout: device.createPipelineLayout({ bindGroupLayouts: [frame.cameraLayout, this.domeLayout, this.targetLayout] }),
        compute: { module, entryPoint: "fillDome" },
      });
    }
    const panorama = frame.textures.acquire(settings.frame.panorama);
    writeDome(this.domeData, settings.frame, {
      viewRadius: tables.viewRadius,
      cloudsOn: clouds.showing,
      cloudTexel: clouds.texel,
      panoramaOn: !!panorama,
    });
    device.queue.writeBuffer(this.domeBuffer, 0, this.domeData);
    const pass = frame.encoder.beginComputePass({ label: "sky fill" });
    pass.setPipeline(this.domePipeline);
    pass.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    pass.setBindGroup(1, this.domeBindings.groupFor(
      tables.skyView.view,
      tables.transmittance.view,
      clouds.view ?? frame.textures.black.view,
      panorama?.view ?? frame.textures.black.view,
      tables.skyViewSampler,
      tables.clampSampler,
      panorama?.sampler ?? tables.clampSampler,
    ));
    pass.setBindGroup(2, this.targetsGroup(frame));
    pass.dispatchWorkgroups(Math.ceil(frame.targets.width / WORKGROUP), Math.ceil(frame.targets.height / WORKGROUP));
    pass.end();
    return true;
  }

  private plainPipeline(frame: GpuFrame, mode: PlainMode): GPUComputePipeline {
    let pipeline = this.plainPipelines.get(mode);
    if (pipeline) return pipeline;
    const { device } = this;
    this.plainModule ??= device.createShaderModule({ label: "sky plain fill", code: FILL_PLAIN_WGSL });
    this.plainPipelineLayout ??= device.createPipelineLayout({ bindGroupLayouts: [frame.cameraLayout, this.plainLayout, this.targetLayout] });
    pipeline = device.createComputePipeline({
      label: `sky ${mode}`,
      layout: this.plainPipelineLayout,
      compute: { module: this.plainModule, entryPoint: mode },
    });
    this.plainPipelines.set(mode, pipeline);
    return pipeline;
  }

  private writeClassic(classic: GpuClassicSky): void {
    const data = this.plainData;
    const position = classic.sunPosition;
    const direction = _sunDirection.copy(position).normalize();
    const zenith = Math.min(1, Math.max(-1, direction.y));
    const sunE = CLASSIC_EE * Math.max(0, 1 - Math.exp(-((CLASSIC_CUTOFF - Math.acos(zenith)) / CLASSIC_STEEPNESS)));
    const sunFade = 1 - Math.min(1, Math.max(0, 1 - Math.exp(position.y / 450000)));
    const rayleigh = classic.rayleigh - (1 - sunFade);
    const c = 0.2 * classic.turbidity * 10e-18;
    data[16] = direction.x;
    data[17] = direction.y;
    data[18] = direction.z;
    data[19] = sunE;
    for (let channel = 0; channel < 3; channel++) {
      data[20 + channel] = CLASSIC_RAYLEIGH[channel] * rayleigh;
      data[24 + channel] = 0.434 * c * CLASSIC_MIE[channel] * classic.mieCoefficient;
    }
    data[23] = sunFade;
    data[27] = classic.mieDirectionalG;
  }

  private cubeView(texture: THREE.CubeTexture): GPUTextureView | null {
    const images = cubeFaceImages(texture);
    if (!images) return null;
    const held = this.cubeBackground;
    if (held?.source === texture && held.version === texture.version) return held.view;
    held?.texture.destroy();
    const { device } = this;
    const { width, height } = images[0];
    const gpu = device.createTexture({
      label: "sky background cube",
      size: [width, height, 6],
      format: texture.colorSpace === THREE.SRGBColorSpace ? "rgba8unorm-srgb" : "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    images.forEach((image, layer) => {
      device.queue.copyExternalImageToTexture({ source: image }, { texture: gpu, origin: [0, 0, layer], colorSpace: "srgb" }, [width, height]);
    });
    const view = gpu.createView({ dimension: "cube" });
    this.cubeBackground = { source: texture, version: texture.version, texture: gpu, view };
    return view;
  }

  /** The turn a background is read through, as three.js makes it. */
  private writeTurn(scene: THREE.Scene): void {
    const rotation = (scene as unknown as { backgroundRotation?: THREE.Euler }).backgroundRotation;
    _euler.set(0, 0, 0);
    if (rotation) _euler.set(-rotation.x, -rotation.y, -rotation.z, rotation.order);
    const turn = _matrix3.setFromMatrix4(_matrix.makeRotationFromEuler(_euler)).elements;
    const data = this.plainData;
    data[4] = turn[0];
    data[5] = turn[1];
    data[6] = turn[2];
    data[8] = turn[3];
    data[9] = turn[4];
    data[10] = turn[5];
    data[12] = turn[6];
    data[13] = turn[7];
    data[14] = turn[8];
  }

  /** The classic sky, or whatever the scene has for a background. */
  private fillPlain(frame: GpuFrame, classic: GpuClassicSky | null): void {
    const { scene } = frame;
    const data = this.plainData;
    const background = scene.background as THREE.Color | THREE.Texture | null;
    let mode: PlainMode = "fillFlat";
    let image = frame.textures.black.view;
    let imageSampler: GPUSampler = this.backgroundSampler;
    let cube = this.blackCubeView;
    const colour = (background as THREE.Color | null)?.isColor ? (background as THREE.Color) : _black;
    data[0] = colour.r;
    data[1] = colour.g;
    data[2] = colour.b;
    data[3] = (scene as unknown as { backgroundIntensity?: number }).backgroundIntensity ?? 1;
    this.writeTurn(scene);
    if (classic) {
      mode = "fillClassic";
      this.writeClassic(classic);
    } else if (background && (background as THREE.Texture).isTexture) {
      const texture = background as THREE.Texture;
      if ((texture as THREE.CubeTexture).isCubeTexture) {
        const view = this.cubeView(texture as THREE.CubeTexture);
        if (view) {
          cube = view;
          mode = "fillCube";
        }
      } else {
        const entry = frame.textures.acquire(texture);
        // A float image can only be filtered where the graphics card can do it: the rest show a flat background.
        const readable = entry && (entry.texture.format !== "rgba32float" || frame.core.features.float32Filterable);
        if (entry && readable) {
          image = entry.view;
          imageSampler = entry.sampler;
          mode = texture.mapping === THREE.EquirectangularReflectionMapping || texture.mapping === THREE.EquirectangularRefractionMapping ? "fillEquirect" : "fillScreen";
        }
      }
    }
    this.device.queue.writeBuffer(this.plainBuffer, 0, data);
    const pass = frame.encoder.beginComputePass({ label: "sky fill" });
    pass.setPipeline(this.plainPipeline(frame, mode));
    pass.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    pass.setBindGroup(1, this.device.createBindGroup({
      label: "sky plain",
      layout: this.plainLayout,
      entries: [
        { binding: 0, resource: { buffer: this.plainBuffer } },
        { binding: 1, resource: image },
        { binding: 2, resource: cube },
        { binding: 3, resource: imageSampler },
      ],
    }));
    pass.setBindGroup(2, this.targetsGroup(frame));
    pass.dispatchWorkgroups(Math.ceil(frame.targets.width / WORKGROUP), Math.ceil(frame.targets.height / WORKGROUP));
    pass.end();
  }

  execute(frame: GpuFrame): void {
    this.prepare(frame);
    const settings = this.active;
    // Only a camera with a point of view looks out at a sky; any other sees the plain background.
    const perspective = (frame.camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
    if (settings?.model === "atmosphere" && perspective) {
      if (!this.fillDome(frame, settings)) this.fillPlain(frame, null);
    } else if (settings?.model === "classic" && perspective) {
      this.fillPlain(frame, settings.classic);
    } else {
      this.fillPlain(frame, null);
    }
    if (settings) this.overlay.draw(frame, settings);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseSky();
    this.capture.dispose();
    this.overlay.dispose();
    this.domeBuffer.destroy();
    this.plainBuffer.destroy();
    this.blackCube.destroy();
    this.cubeBackground?.texture.destroy();
  }
}

/**
 * The renderer's one sky pass, made and added the first time it is asked for. Anything may ask, so a level's sky and a
 * plain canvas with only a background share it.
 */
export const skyPassFor = (renderer: GpuRendererApi): SkyPass => {
  let pass = renderer.settings.get(SKY_PASS_SETTING) as SkyPass | undefined;
  if (!pass) {
    pass = new SkyPass(renderer.core, renderer.settings);
    pass.register(renderer);
    renderer.settings.set(SKY_PASS_SETTING, pass);
  }
  return pass;
};
