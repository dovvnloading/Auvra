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
 *   "skyTransmittance"  SkyTransmittanceProduct: how much light gets through the air. Only with an atmosphere.
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

/** Table of light through the air: look it up with SKY_TRANSMITTANCE_WGSL. Radii are kilometres. */
export interface SkyTransmittanceProduct {
  view: GPUTextureView;
  sampler: GPUSampler;
  groundRadius: number;
  topRadius: number;
  /** The camera's distance from the planet's centre. */
  viewRadius: number;
}

/** How clouds shade the land: see CLOUD_SHADE_WGSL. */
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

/** How much sky each place around the camera can see: see SKY_VISIBILITY_WGSL. */
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

/** The sky's colour behind fog: see SKY_FOG_WGSL. */
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

/** Light through the air from `r` (km from the centre) at `mu`, the cosine from straight up. */
export const SKY_TRANSMITTANCE_WGSL = /* wgsl */ `
fn skyTransmittanceUv(r: f32, mu: f32, groundRadius: f32, topRadius: f32) -> vec2f {
  let h = sqrt(topRadius * topRadius - groundRadius * groundRadius);
  let rho = sqrt(max(0.0, r * r - groundRadius * groundRadius));
  let discriminant = r * r * (mu * mu - 1.0) + topRadius * topRadius;
  let d = max(0.0, -r * mu + sqrt(max(0.0, discriminant)));
  let dMin = topRadius - r;
  let dMax = rho + h;
  return vec2f((d - dMin) / max(dMax - dMin, 1e-5), rho / h);
}
`;

/**
 * How much the clouds overhead let the sun through at a world point: 1 clear, less in shade.
 * `map` is tiling, driftU, driftV, threshold; `sun` is leanX, leanZ, height, strength.
 */
export const CLOUD_SHADE_WGSL = /* wgsl */ `
fn cloudShade(point: vec3f, weather: texture_2d<f32>, weatherSampler: sampler, map: vec4f, sun: vec4f, edge: f32) -> f32 {
  if (sun.w <= 0.0) { return 1.0; }
  let at = (point.xz + sun.xy * (sun.z - point.y)) * map.x + map.yz;
  let amount = textureSampleLevel(weather, weatherSampler, at, 0.0).r;
  return 1.0 - sun.w * smoothstep(map.w, map.w + edge, amount);
}
`;

/**
 * How much of the sky a point can see, over the top of what stands there or from under it by how open the place around
 * is. A wall is read a little out from itself, where the map shows the ground it stands on and not its own top.
 * `area` is cornerX, cornerZ, inverseSide, originY; `limits` is occlusion, floor.
 */
export const SKY_VISIBILITY_WGSL = /* wgsl */ `
fn skyVisibility(point: vec3f, normal: vec3f, map: texture_2d<f32>, mapSampler: sampler, area: vec4f, limits: vec2f) -> f32 {
  let uv = (point.xz + normal.xz * 3.0 / (512.0 * area.z) - area.xy) * area.z;
  let inside = min(uv, vec2f(1.0) - uv);
  let fade = smoothstep(0.0, 0.08, min(inside.x, inside.y));
  if (fade <= 0.0) { return 1.0; }
  let sampled = textureSampleLevel(map, mapSampler, clamp(uv, vec2f(0.001), vec2f(0.999)), 0.0).rgb;
  let under = sampled.b - (point.y - area.w);
  var seen = mix(sampled.r, sampled.g, smoothstep(0.3, 1.4, under));
  // A wall only ever faced half the sky: it loses less of what it had than the ground does.
  seen = mix(sqrt(seen), seen, abs(normal.y));
  return max(mix(1.0, seen, fade * limits.x), limits.y);
}
`;

/** The sky behind a point for the fog in front of it: never below the horizon, where it would be the ground's colour. */
export const SKY_FOG_WGSL = /* wgsl */ `
fn skyFogColour(toward: vec3f, table: texture_2d<f32>, tableSampler: sampler, scale: vec3f, grey: f32) -> vec3f {
  let direction = normalize(vec3f(toward.x, max(toward.y, 0.035), toward.z));
  let latitude = asin(direction.y);
  let uv = vec2f(atan2(direction.z, direction.x) / 6.283185 + 0.5, 0.5 + 0.5 * sqrt(latitude / 1.570796));
  let sky = textureSampleLevel(table, tableSampler, uv, 0.0).rgb * scale;
  return mix(sky, vec3f(dot(sky, vec3f(0.2126, 0.7152, 0.0722))), grey);
}
`;
