/// <reference types="@webgpu/types" />
import type * as THREE from "three";
import type { SkyFrame } from "../../../components/Environment/sky/SkyRenderer";

/**
 * WHAT THE SKY IS TOLD, AND WHAT IT GIVES
 *
 * The level's sky component writes one GpuSkySettings under renderer settings "sky", and changes it in place every
 * frame. The atmosphere's part of it is the same frame the WebGL sky takes, so one set of numbers makes the same look
 * on either renderer. Without any settings the sky pass fills from the scene's own background and gives a dim neutral
 * environment.
 *
 * Products the sky publishes in `frame.products`, from the "prepare" stage on, so lighting reads them the same frame:
 *   "environment"       SkyEnvironmentProduct: image-based light, always there once the pass has run.
 *   "cloudShadow"       CloudShadowProduct: where clouds shade the land. Only while they do.
 *   "skyVisibility"     SkyVisibilityProduct: how much sky each place around the camera sees. Only while it is on.
 *   "skyFog"            SkyFogProduct: the sky's colour for distant fog to melt into. Only with an atmosphere.
 *
 * The WGSL at the bottom reads each of them; a pass adds it to its shader and binds the views.
 */

export const SKY_SETTINGS = "sky";
/** Where the renderer's one SkyPass is kept (see skyPassFor in SkyPass.ts). */
export const SKY_PASS_SETTING = "sky.pass";

export type Rgb = [number, number, number];

/** The older analytic sky. */
export interface GpuClassicSky {
  /** Toward the sun; its length matters only a little, as in the shader this came from. */
  sunPosition: THREE.Vector3;
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
}

/** The classic sky's stars and moon, drawn as things on the sky. */
export interface GpuNightSky {
  /** Three numbers a star, at the sky's own radius. */
  starPositions: Float32Array;
  starSizes: Float32Array;
  starBrightness: Float32Array;
  starOpacity: number;
  starTime: number;
  moonDirection: THREE.Vector3;
  moonOpacity: number;
}

/** The flat painted cloud layer. */
export interface GpuFlatClouds {
  coverage: number;
  storm: number;
  light: number;
  flash: number;
  offset: THREE.Vector2;
  sunDirection: THREE.Vector3;
  sunColor: THREE.Color;
  horizon: THREE.Color;
  shade: THREE.Color;
}

/** A lightning bolt on the sky. */
export interface GpuBolt {
  positions: Float32Array;
  edges: Float32Array;
  indices: ArrayLike<number>;
  /** Goes up when the bolt's shape changes. */
  version: number;
  brightness: number;
}

/** A soft panel of the plain lighting rig (runtime panels from components/Scene/localEnvironmentCapture.ts). */
export interface GpuRigPanel {
  color: THREE.Color;
  intensity: number;
  position: readonly [number, number, number];
  scale: readonly [number, number];
}

export interface GpuSkyCapture {
  /** Goes up each time the sky wants capturing again. */
  request: number;
  /** The sky as it is, a panorama image, the plain lighting rig, or a dim neutral gradient. */
  source: "sky" | "image" | "rig" | "neutral";
  /** Side of the cube, texels. */
  resolution: number;
  lowerSolid: boolean;
  lower: Rgb;
  tint: Rgb;
  image: THREE.Texture | null;
  rig: GpuRigPanel[];
  /** On the diffuse coefficients, every frame: what the sky's strength is at this hour. */
  diffuseScale: number;
  /** Baked into the specular cube when it is made. */
  specularScale: number;
}

export interface GpuSkySceneValues {
  fogScale: Rgb;
  fogFollowsSky: boolean;
  fogShare: number;
  fogGrey: number;
  lightOn: boolean;
  occlusion: number;
  occlusionFloor: number;
  cloudTiling: number;
  cloudDriftU: number;
  cloudDriftV: number;
  cloudThreshold: number;
  cloudLeanX: number;
  cloudLeanZ: number;
  cloudHeight: number;
  cloudStrength: number;
}

export interface GpuSkySettings {
  /** "atmosphere" covers a panorama too: frame.panorama says so. "none": the scene's background. */
  model: "atmosphere" | "classic" | "none";
  /** The same frame the WebGL sky takes. */
  frame: SkyFrame;
  classic: GpuClassicSky;
  night: GpuNightSky | null;
  flatClouds: GpuFlatClouds | null;
  bolt: GpuBolt | null;
  capture: GpuSkyCapture;
  scene: GpuSkySceneValues;
  /** Keep the sky visibility map up to date, this far either side of the camera. */
  visibilityOn: boolean;
  visibilityHalfSide: number;
}

/**
 * Image-based light. `specular` is a cube sampled with the world direction as it is; each mip is prefiltered for
 * roughness = mip / (specularMips - 1), and its light already carries the level's reflection strength.
 *
 * `diffuseSH` is nine RGB triples of radiance, already at this frame's strength, in the order
 * L00, L1-1 (y), L10 (z), L11 (x), L2-2 (xy), L2-1 (yz), L20 (3z^2 - 1), L21 (xz), L22 (x^2 - y^2): lightingIrradianceSH
 * in lightingWgsl.ts turns them into irradiance. Both carry their strength, so scene.environmentIntensity stays 1. The
 * array stays the same object from frame to frame; `specular` is a new view when a capture finishes, and the whole
 * product is then a new object.
 */
export interface SkyEnvironmentProduct {
  diffuseSH: Float32Array;
  specular: GPUTextureView;
  specularMips: number;
  sampler: GPUSampler;
}

/** How clouds shade the land, read by lightingCloudShade in lightingWgsl.ts. */
export interface CloudShadowProduct {
  /** The clouds' weather map; R is how much cloud a place tends to have. Tiles. */
  weather: GPUTextureView;
  sampler: GPUSampler;
  /** Map tiles per metre, then its drift. */
  tiling: number;
  driftU: number;
  driftV: number;
  /** Below this much in the map, no cloud; `edge` further, full cloud. */
  threshold: number;
  edge: number;
  /** How the sun's rays lean per metre of height, the clouds' height in metres, and how dark their shadow is. */
  leanX: number;
  leanZ: number;
  height: number;
  strength: number;
}

/** How much sky each place around the camera can see, read by lightingSkyVisibility in lightingWgsl.ts. */
export interface SkyVisibilityProduct {
  /** R over the top of what stands there, G under it, B its height. */
  view: GPUTextureView;
  sampler: GPUSampler;
  /** The map's corner in the world's x and z, 1 / its side, and the height its heights count from. */
  cornerX: number;
  cornerZ: number;
  inverseSide: number;
  originY: number;
  /** How far covered places lose the sky, and the least they keep. */
  occlusion: number;
  floor: number;
}

/** The sky's colour behind fog, read by lightingSkyColour in lightingWgsl.ts. */
export interface SkyFogProduct {
  view: GPUTextureView;
  sampler: GPUSampler;
  /** On the table's colour. */
  scale: Rgb;
  /** Fog takes the sky's colour at all. */
  followsSky: boolean;
  /** How far it takes the sky's colour over the weather's. */
  share: number;
  /** How grey heavy cloud has made the air. */
  grey: number;
}

