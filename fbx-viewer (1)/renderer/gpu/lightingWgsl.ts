/// <reference types="@webgpu/types" />
import type * as THREE from "three";
import { GrowableBuffer } from "./buffers";
import type { GpuCore } from "./device";
import type { GpuFrame } from "./frame";
import type { ShadowMapsProduct } from "./passes/shadows";
import { reportGpu } from "./report";
import { MAX_PROBES, type ProbesProduct } from "./probes";
import type { CloudShadowProduct, SkyFogProduct, SkyVisibilityProduct } from "./sky/skySettings";

/**
 * LIGHTING
 *
 * How light reaches a surface, written once so that everything lit looks the same whichever pass drew it. The numbers
 * follow three.js r164's physically based lighting: point and spot intensity in candela falling off with distance
 * squared inside a range window, directional intensity as irradiance, ambient and hemisphere as irradiance times
 * albedo over pi, and image-based light by the split-sum approximation.
 *
 * All of it is one bind group, group 3, the slot left free by the view (0), the scene (1) and the material (2). A pass
 * that lights something takes frame.products "lighting" (see `LightingProduct`), adds its `layout` as group 3 of its
 * pipeline, pastes its `wgsl` into its shader after VIEW_WGSL and CAMERA_BINDINGS_WGSL, and then writes:
 *
 *   var input = lightingInput(worldPosition, normal, viewDirection, albedo, roughness, metalness, pixel);
 *   input.occlusion = occlusion;
 *   let lit = lightingApplyFog(lightSurface(input) + emissive, worldPosition);
 *
 * Lights are looked up through a grid of screen tiles and depth slices (passes/lightClusters.ts builds it), so a pixel
 * only pays for the lights that can reach it. The lookup goes by world position through the main camera's own matrices,
 * which keeps it right for a pass drawing at another resolution.
 *
 * Products read here:
 *   "environment" = `EnvironmentProduct`, image-based light.
 *   "shadowMaps"  = `ShadowMapsProduct` (passes/shadows.ts), the sun's cascades and the local lights' atlas.
 *   "cloudShadow" = `CloudShadowProduct`, how the clouds overhead shade the sun.
 *   "skyVisibility" = `SkyVisibilityProduct`, how much of the sky each place can see.
 */

export const LIGHTING_GROUP = 3;
export const CLUSTER_GRID = { x: 16, y: 9, z: 24 } as const;
export const CLUSTER_COUNT = CLUSTER_GRID.x * CLUSTER_GRID.y * CLUSTER_GRID.z;
export const MAX_LOCAL_LIGHTS = 4096;
export const MAX_SUNS = 8;
export const SHADOW_TAPS = 16;

const BITS_PER_WORD = 32;
const MAX_WORDS_PER_CLUSTER = Math.ceil(MAX_LOCAL_LIGHTS / BITS_PER_WORD);
const LOCAL_LIGHT_WORDS = 24;
const UNIFORM_WORDS = 320;
const CASCADES = 4;
const POINT_LIGHT_CONE = -2;
const NOISE_FRAMES = 64;
/**
 * The irradiance below which a light that never quite reaches zero counts as out of reach. It only matters for a light
 * whose `distance` is 0 or very long, and it is low enough that a polished floor's highlight does not visibly pop.
 */
const REACH_CUTOFF = 0.001;

/** "lighting": what a pass needs to light something. */
export interface LightingProduct {
  layout: GPUBindGroupLayout;
  bindGroup: GPUBindGroup;
  wgsl: string;
  /** The owner, for passes that read its buffers directly. */
  resources: LightingResources;
}

/** "environment": image-based light. */
export interface EnvironmentProduct {
  /** 27 numbers, nine rgb spherical harmonic coefficients of radiance in three.js's order. */
  diffuseSH: Float32Array;
  /** A cube with its mips filtered for roughness, the mip at roughness * (specularMips - 1). */
  specular: GPUTextureView;
  specularMips: number;
}

/** Structures, shared with the compute shader that builds the grid. */
export const LIGHTING_TYPES_WGSL = /* wgsl */ `
const LIGHTING_PI = 3.141592653589793;
const LIGHTING_RECIPROCAL_PI = 0.3183098861837907;
const LIGHTING_SUNS = ${MAX_SUNS}u;
const LIGHTING_GRID_X = ${CLUSTER_GRID.x}u;
const LIGHTING_GRID_Y = ${CLUSTER_GRID.y}u;
const LIGHTING_GRID_Z = ${CLUSTER_GRID.z}u;

struct LightingSun {
  // Toward the sun.
  direction: vec3f,
  color: vec3f,
}

struct LocalLight {
  position: vec3f,
  // Where the light's range window closes; 0 is no window, as three.js has it.
  range: f32,
  // From what it shines at toward the light, as three.js has it.
  direction: vec3f,
  decay: f32,
  color: vec3f,
  // The cosine of the cone's edge; below -1 for a point light, which has no cone.
  coneCos: f32,
  // A sphere around everything the light reaches, what the grid tests against.
  cullCenter: vec3f,
  cullRadius: f32,
  penumbraCos: f32,
  // First row in the shadow table, or negative for none.
  shadowEntry: i32,
  shadowBias: f32,
  shadowNormalBias: f32,
  shadowRadius: f32,
  cullRange: f32,
  pad0: f32,
  pad1: f32,
}

struct LightingUniforms {
  suns: array<LightingSun, LIGHTING_SUNS>,
  ambient: vec4f,
  hemiSky: vec4f,
  hemiGround: vec4f,
  // rgb, then 0 no fog, 1 between two distances, 2 exponential squared.
  fogColor: vec4f,
  // near, far, density.
  fogParams: vec4f,
  clusterView: mat4x4f,
  // What ndc is from a view position: scale x, scale y, shift x, shift y.
  clusterProjection: vec4f,
  // Camera near, where the exponential slices start, far, slices per unit of log depth.
  clusterDepth: vec4f,
  environmentSH: array<vec4f, 9>,
  cascadeMatrices: array<mat4x4f, ${CASCADES}>,
  cascadeSplits: vec4f,
  // The sun's depth bias and normal bias as three.js has them, its filter radius in texels, the frame's noise phase.
  shadowParams: vec4f,
  // Per cascade, what the shadow pass asks for: the least to move along the normal, and what to add to depth.
  cascadeLift: vec4f,
  cascadeBias: vec4f,
  sunCount: u32,
  localCount: u32,
  wordsPerCluster: u32,
  orthographic: u32,
  cascadeCount: u32,
  cascadeSun: i32,
  environmentMips: f32,
  // How grey heavy cloud has made the air, for fog that takes the sky's colour.
  fogGrey: f32,
  // What the sky's table is scaled by, and how far fog takes its colour over fogColor (0: not at all).
  fogSky: vec4f,
  probeCount: u32,
  probeMips: f32,
  probePad0: f32,
  probePad1: f32,
  // Where each reflection probe is and how far it reaches, then its strength.
  probeSpheres: array<vec4f, ${MAX_PROBES}>,
  probeIntensities: array<vec4f, ${MAX_PROBES}>,
  // The clouds' weather map: tiles per metre, its drift, and the amount under which there is no cloud.
  cloudMap: vec4f,
  // How the sun's rays lean per metre of height, the clouds' height, how dark their shadow (0: none).
  cloudSun: vec4f,
  // The sky visibility map: its corner in the world's x and z, 1 / its side, the height its heights count from.
  skyArea: vec4f,
  // How far covered places lose the sky, the least they keep, the width of a cloud's edge, 1 with the map on.
  skyLimits: vec4f,
}
`;

/** Where things fall in the grid; expects `lighting` to be bound. */
export const LIGHTING_CLUSTER_WGSL = /* wgsl */ `
fn lightingViewDepth(world: vec3f) -> f32 {
  let m = lighting.clusterView;
  return -(m[0][2] * world.x + m[1][2] * world.y + m[2][2] * world.z + m[3][2]);
}

fn lightingSliceOf(depth: f32) -> u32 {
  let start = lighting.clusterDepth.y;
  let slice = log(max(depth, start) / start) * lighting.clusterDepth.w;
  return min(u32(slice), LIGHTING_GRID_Z - 1u);
}

// The near edge of a slice. The first takes in everything from the camera's near and the last ends at its far, so that
// no depth falls outside the grid, even an orthographic camera's near that sits behind it.
fn lightingSliceDepth(slice: u32) -> f32 {
  if (slice == 0u) { return lighting.clusterDepth.x; }
  if (slice >= LIGHTING_GRID_Z) { return lighting.clusterDepth.z; }
  return lighting.clusterDepth.y * exp(f32(slice) / lighting.clusterDepth.w);
}

fn lightingClusterOf(world: vec3f) -> u32 {
  let at = lighting.clusterView * vec4f(world, 1.0);
  let depth = -at.z;
  let w = select(max(depth, 1e-4), 1.0, lighting.orthographic != 0u);
  let ndc = at.xy * lighting.clusterProjection.xy / w - lighting.clusterProjection.zw;
  let x = u32(clamp((ndc.x + 1.0) * 0.5 * f32(LIGHTING_GRID_X), 0.0, f32(LIGHTING_GRID_X - 1u)));
  // Rows count down from the top of the screen.
  let y = u32(clamp((1.0 - ndc.y) * 0.5 * f32(LIGHTING_GRID_Y), 0.0, f32(LIGHTING_GRID_Y - 1u)));
  return x + LIGHTING_GRID_X * (y + LIGHTING_GRID_Y * lightingSliceOf(depth));
}
`;

/** The bindings of the lighting group. */
const LIGHTING_BINDINGS_WGSL = /* wgsl */ `
@group(${LIGHTING_GROUP}) @binding(0) var<uniform> lighting: LightingUniforms;
@group(${LIGHTING_GROUP}) @binding(1) var<storage, read> lightingLocals: array<LocalLight>;
@group(${LIGHTING_GROUP}) @binding(2) var<storage, read> lightingClusterWords: array<u32>;
@group(${LIGHTING_GROUP}) @binding(3) var<storage, read> lightingShadowEntries: array<mat4x4f>;
@group(${LIGHTING_GROUP}) @binding(4) var lightingEnvironment: texture_cube<f32>;
@group(${LIGHTING_GROUP}) @binding(5) var lightingEnvironmentSampler: sampler;
@group(${LIGHTING_GROUP}) @binding(6) var lightingCascades: texture_depth_2d_array;
@group(${LIGHTING_GROUP}) @binding(7) var lightingCascadeSampler: sampler_comparison;
@group(${LIGHTING_GROUP}) @binding(8) var lightingAtlas: texture_depth_2d;
@group(${LIGHTING_GROUP}) @binding(9) var lightingAtlasSampler: sampler_comparison;
@group(${LIGHTING_GROUP}) @binding(10) var lightingSkyView: texture_2d<f32>;
@group(${LIGHTING_GROUP}) @binding(11) var lightingSkyViewSampler: sampler;
@group(${LIGHTING_GROUP}) @binding(12) var lightingProbes: texture_cube_array<f32>;
@group(${LIGHTING_GROUP}) @binding(13) var lightingCloudWeather: texture_2d<f32>;
@group(${LIGHTING_GROUP}) @binding(14) var lightingCloudSampler: sampler;
@group(${LIGHTING_GROUP}) @binding(15) var lightingSkySeen: texture_2d<f32>;
`;

const LIGHTING_FUNCTIONS_WGSL = /* wgsl */ `
struct LightingInput {
  worldPosition: vec3f,
  normal: vec3f,
  // From the surface toward the eye.
  viewDirection: vec3f,
  albedo: vec3f,
  roughness: f32,
  metalness: f32,
  // Dims what arrives indirectly: the material's occlusion, times the screen's where there is one.
  occlusion: f32,
  // The pixel, for the noise that turns the shadow filter from one pixel to the next.
  pixel: vec2f,
  // Irradiance gathered some other way, which takes the place of the ambient lights.
  indirectIrradiance: vec3f,
  hasIndirect: bool,
  // The baked light is already in what the surface emits, so the ambient lights would count it twice.
  hasBakedLight: bool,
  receivesShadow: bool,
}

fn lightingInput(worldPosition: vec3f, normal: vec3f, viewDirection: vec3f, albedo: vec3f, roughness: f32, metalness: f32, pixel: vec2f) -> LightingInput {
  var input: LightingInput;
  input.worldPosition = worldPosition;
  input.normal = normal;
  input.viewDirection = viewDirection;
  input.albedo = albedo;
  input.roughness = roughness;
  input.metalness = metalness;
  input.occlusion = 1.0;
  input.pixel = pixel;
  input.indirectIrradiance = vec3f(0.0);
  input.hasIndirect = false;
  input.hasBakedLight = false;
  input.receivesShadow = true;
  return input;
}

fn F_Schlick(f0: vec3f, f90: f32, dotVH: f32) -> vec3f {
  let fresnel = exp2((-5.55473 * dotVH - 6.98316) * dotVH);
  return f0 * (1.0 - fresnel) + f90 * fresnel;
}

fn V_SmithGGXCorrelated(alpha: f32, dotNL: f32, dotNV: f32) -> f32 {
  let a2 = alpha * alpha;
  let gv = dotNL * sqrt(a2 + (1.0 - a2) * dotNV * dotNV);
  let gl = dotNV * sqrt(a2 + (1.0 - a2) * dotNL * dotNL);
  return 0.5 / max(gv + gl, 1e-6);
}

fn D_GGX(alpha: f32, dotNH: f32) -> f32 {
  let a2 = alpha * alpha;
  let denominator = dotNH * dotNH * (a2 - 1.0) + 1.0;
  return LIGHTING_RECIPROCAL_PI * a2 / (denominator * denominator);
}

// A surface's response, worked out once and then used for every light.
struct LightingMaterial {
  normal: vec3f,
  viewDirection: vec3f,
  diffuse: vec3f,
  f0: vec3f,
  roughness: f32,
  alpha: f32,
  dotNV: f32,
}

fn lightingDirect(m: LightingMaterial, toLight: vec3f, dotNL: f32, color: vec3f) -> vec3f {
  // A light exactly opposite the eye has no halfway direction, and normalizing nothing would poison the pixel.
  let halfway = m.viewDirection + toLight;
  let h = halfway / max(length(halfway), 1e-6);
  let dotNH = saturate(dot(m.normal, h));
  let dotVH = saturate(dot(m.viewDirection, h));
  let f = F_Schlick(m.f0, 1.0, dotVH);
  let v = V_SmithGGXCorrelated(m.alpha, dotNL, m.dotNV);
  let d = D_GGX(m.alpha, dotNH);
  return dotNL * color * (m.diffuse * LIGHTING_RECIPROCAL_PI + f * (v * d));
}

// Irradiance from nine spherical harmonic coefficients of radiance, three.js's order and constants.
fn lightingIrradianceSH(n: vec3f) -> vec3f {
  var result = lighting.environmentSH[0].rgb * 0.886227;
  result += lighting.environmentSH[1].rgb * 2.0 * 0.511664 * n.y;
  result += lighting.environmentSH[2].rgb * 2.0 * 0.511664 * n.z;
  result += lighting.environmentSH[3].rgb * 2.0 * 0.511664 * n.x;
  result += lighting.environmentSH[4].rgb * 2.0 * 0.429043 * n.x * n.y;
  result += lighting.environmentSH[5].rgb * 2.0 * 0.429043 * n.y * n.z;
  result += lighting.environmentSH[6].rgb * (0.743125 * n.z * n.z - 0.247708);
  result += lighting.environmentSH[7].rgb * 2.0 * 0.429043 * n.x * n.z;
  result += lighting.environmentSH[8].rgb * 0.429043 * (n.x * n.x - n.y * n.y);
  return result;
}

// The analytic stand-in for the table of the split-sum approximation: how much of the environment a surface reflects,
// as a scale on its reflectance at facing and a bias from its reflectance at grazing.
fn lightingDFG(dotNV: f32, roughness: f32) -> vec2f {
  let r = roughness * vec4f(-1.0, -0.0275, -0.572, 0.022) + vec4f(1.0, 0.0425, 1.04, -0.04);
  let a004 = min(r.x * r.x, exp2(-9.28 * dotNV)) * r.x + r.y;
  return vec2f(-1.04, 1.04) * a004 + r.zw;
}

fn lightingSpecularOcclusion(dotNV: f32, occlusion: f32, roughness: f32) -> f32 {
  return saturate(pow(dotNV + occlusion, exp2(-16.0 * roughness - 1.0)) - 1.0 + occlusion);
}

// How much of the sky a point can see: over the top of what stands there, or from under it by how open the place around
// is. A wall is read a little out from itself, where the map shows the ground it stands on and not its own top.
fn lightingSkyVisibility(point: vec3f, normal: vec3f) -> f32 {
  if (lighting.skyLimits.w <= 0.0) { return 1.0; }
  let area = lighting.skyArea;
  let uv = (point.xz + normal.xz * 3.0 / (512.0 * area.z) - area.xy) * area.z;
  let inside = min(uv, vec2f(1.0) - uv);
  let fade = smoothstep(0.0, 0.08, min(inside.x, inside.y));
  if (fade <= 0.0) { return 1.0; }
  let sampled = textureSampleLevel(lightingSkySeen, lightingEnvironmentSampler, clamp(uv, vec2f(0.001), vec2f(0.999)), 0.0).rgb;
  let under = sampled.b - (point.y - area.w);
  var seen = mix(sampled.r, sampled.g, smoothstep(0.3, 1.4, under));
  // A wall only ever faced half the sky: it loses less of what it had than the ground does.
  seen = mix(sqrt(seen), seen, abs(normal.y));
  return max(mix(1.0, seen, fade * lighting.skyLimits.x), lighting.skyLimits.y);
}

// How much the clouds overhead let the sun through at a point.
fn lightingCloudShade(point: vec3f) -> f32 {
  let strength = lighting.cloudSun.w;
  if (strength <= 0.0) { return 1.0; }
  let at = (point.xz + lighting.cloudSun.xy * (lighting.cloudSun.z - point.y)) * lighting.cloudMap.x + lighting.cloudMap.yz;
  let amount = textureSampleLevel(lightingCloudWeather, lightingCloudSampler, at, 0.0).r;
  return 1.0 - strength * smoothstep(lighting.cloudMap.w, lighting.cloudMap.w + lighting.skyLimits.z, amount);
}

// All that does not come straight from a light: ambient, hemisphere, gathered light and the environment.
fn lightingIndirect(s: LightingInput, m: LightingMaterial) -> vec3f {
  var irradiance = vec3f(0.0);
  var environmentIrradiance = vec3f(0.0);
  let hasEnvironment = lighting.environmentMips > 0.0;
  if (s.hasIndirect) {
    // Taken as the environment's irradiance rather than the plain ambient, so reflection still takes its share.
    environmentIrradiance = s.indirectIrradiance;
  } else if (!s.hasBakedLight) {
    let hemi = mix(lighting.hemiGround.rgb, lighting.hemiSky.rgb, 0.5 * m.normal.y + 0.5);
    irradiance = lighting.ambient.rgb + hemi;
    if (hasEnvironment) {
      environmentIrradiance = lightingIrradianceSH(m.normal);
    }
  }
  // What the sky gives a place is only what it can see of the sky. Gathered light has already seen for itself.
  let skySeen = lightingSkyVisibility(s.worldPosition, m.normal);
  if (!s.hasIndirect) { environmentIrradiance *= skySeen; }

  var radiance = vec3f(0.0);
  // The nearest reflection probe holding this point sees what is really around it, where the sky would not.
  var probe = -1;
  var probeDistance = 1e30;
  for (var index = 0u; index < lighting.probeCount; index++) {
    let sphere = lighting.probeSpheres[index];
    let away = distance(s.worldPosition, sphere.xyz);
    if (away <= sphere.w && away < probeDistance) {
      probe = i32(index);
      probeDistance = away;
    }
  }
  if (hasEnvironment || probe >= 0) {
    // Leaning a rough surface's reflection toward its normal keeps it from gathering light from behind itself.
    let reflected = normalize(mix(reflect(-m.viewDirection, m.normal), m.normal, m.roughness * m.roughness));
    if (probe >= 0) {
      let level = m.roughness * (lighting.probeMips - 1.0);
      // Its faces are laid out mirrored in z: see probes.ts.
      radiance = textureSampleLevel(lightingProbes, lightingEnvironmentSampler, reflected * vec3f(1.0, 1.0, -1.0), probe, level).rgb * lighting.probeIntensities[probe].x;
    } else {
      let level = m.roughness * (lighting.environmentMips - 1.0);
      radiance = textureSampleLevel(lightingEnvironment, lightingEnvironmentSampler, reflected, level).rgb * skySeen;
    }
  }

  // One bounce off the microfacets, and the energy of the further bounces that a single-bounce model loses.
  let fab = lightingDFG(m.dotNV, m.roughness);
  let single = m.f0 * fab.x + vec3f(fab.y);
  let lost = 1.0 - (fab.x + fab.y);
  let average = m.f0 + (vec3f(1.0) - m.f0) * 0.047619;
  let multiple = single * average / (vec3f(1.0) - lost * average) * lost;
  let total = single + multiple;
  let remaining = m.diffuse * (1.0 - max(total.r, max(total.g, total.b)));
  let cosineWeighted = environmentIrradiance * LIGHTING_RECIPROCAL_PI;

  let diffuse = irradiance * m.diffuse * LIGHTING_RECIPROCAL_PI + remaining * cosineWeighted;
  let specular = radiance * single + multiple * cosineWeighted;
  return diffuse * s.occlusion + specular * lightingSpecularOcclusion(m.dotNV, s.occlusion, m.roughness);
}

// A direction that differs from pixel to pixel, to start the shadow filter's spiral from. It moves with the frames only
// while the camera is jittering, because only then is something averaging the frames together.
fn lightingNoiseDirection(pixel: vec2f) -> vec2f {
  let phase = select(0.0, lighting.shadowParams.w, any(view.jitter.xy != vec2f(0.0)));
  let at = pixel + phase * 5.588238;
  let noise = fract(52.9829189 * fract(dot(at, vec2f(0.06711056, 0.00583715))));
  let angle = noise * 2.0 * LIGHTING_PI;
  return vec2f(cos(angle), sin(angle));
}

// The turn from one tap to the next, by the golden angle: what spreads the taps evenly over a disk.
const LIGHTING_GOLDEN_TURN = mat2x2f(-0.73736888, 0.67549029, -0.67549029, -0.73736888);
const LIGHTING_TAPS = ${SHADOW_TAPS}u;

struct LightingShadowLook {
  uvDepth: vec3f,
  radius: f32,
  inside: bool,
}

// Where a surface looks in a shadow map. The surface is lifted along its normal before looking, by as much as a plane
// tilted from the light rises over the filter's width: exactly what stops a filtered surface shadowing itself, which a
// fixed lift would only do up to some angle.
fn lightingShadowLook(shadowMatrix: mat4x4f, s: LightingInput, toLight: vec3f, dotNL: f32, stepSize: f32, texels: f32, radiusTexels: f32, leastLift: f32, normalBias: f32, depthOffset: f32) -> LightingShadowLook {
  let here = shadowMatrix * vec4f(s.worldPosition, 1.0);
  let across = normalize(cross(toLight, select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(toLight.y) > 0.9)));
  let beside = shadowMatrix * vec4f(s.worldPosition + across * stepSize, 1.0);
  let uvPerWorld = length(beside.xy / beside.w - here.xy / here.w) / stepSize;
  let texelWorld = 1.0 / max(uvPerWorld * texels, 1e-6);
  let sinNL = sqrt(max(1.0 - dotNL * dotNL, 0.0));
  let lift = max(leastLift, normalBias + (radiusTexels + 1.0) * texelWorld * sinNL);
  let lifted = shadowMatrix * vec4f(s.worldPosition + s.normal * lift, 1.0);

  var look: LightingShadowLook;
  look.radius = radiusTexels / texels;
  if (lifted.w <= 0.0) {
    look.inside = false;
    return look;
  }
  let uvDepth = lifted.xyz / lifted.w;
  look.uvDepth = vec3f(uvDepth.xy, uvDepth.z + depthOffset);
  look.inside = all(uvDepth >= vec3f(0.0)) && all(uvDepth <= vec3f(1.0));
  return look;
}

fn lightingCascadeShade(cascade: u32, s: LightingInput, toLight: vec3f, dotNL: f32, start: vec2f) -> f32 {
  let texels = f32(textureDimensions(lightingCascades).x);
  // Depth runs the other way here, 1 at the light, so a negative three.js bias, toward the light, raises it.
  let depthOffset = lighting.cascadeBias[cascade] - lighting.shadowParams.x;
  let look = lightingShadowLook(lighting.cascadeMatrices[cascade], s, toLight, dotNL, 1.0, texels, lighting.shadowParams.z, lighting.cascadeLift[cascade], lighting.shadowParams.y, depthOffset);
  if (!look.inside) { return 1.0; }
  var direction = start;
  var sum = 0.0;
  for (var tap = 0u; tap < LIGHTING_TAPS; tap++) {
    let offset = direction * sqrt((f32(tap) + 0.5) / f32(LIGHTING_TAPS)) * look.radius;
    sum += textureSampleCompareLevel(lightingCascades, lightingCascadeSampler, look.uvDepth.xy + offset, i32(cascade), look.uvDepth.z);
    direction = LIGHTING_GOLDEN_TURN * direction;
  }
  return sum / f32(LIGHTING_TAPS);
}

// The sun's shadow. Near the end of a cascade it fades into the next, so the change in sharpness never shows as a line;
// past the last there is no shadow, and the last fades out to that.
fn lightingSunShadow(s: LightingInput, depth: f32, toLight: vec3f, dotNL: f32, start: vec2f) -> f32 {
  let count = lighting.cascadeCount;
  var cascade = 0u;
  while (cascade < count && depth > lighting.cascadeSplits[cascade]) { cascade++; }
  if (cascade >= count) { return 1.0; }
  let shade = lightingCascadeShade(cascade, s, toLight, dotNL, start);
  let end = lighting.cascadeSplits[cascade];
  let begin = select(0.0, lighting.cascadeSplits[max(cascade, 1u) - 1u], cascade > 0u);
  let band = max((end - begin) * 0.1, 1e-4);
  let blend = saturate((depth - (end - band)) / band);
  if (blend <= 0.0) { return shade; }
  var next = 1.0;
  if (cascade + 1u < count) { next = lightingCascadeShade(cascade + 1u, s, toLight, dotNL, start); }
  return mix(shade, next, blend);
}

// A point light's row for a direction from the light: the cube face it falls on.
fn lightingCubeFace(away: vec3f) -> i32 {
  let size = abs(away);
  if (size.x >= size.y && size.x >= size.z) { return select(1, 0, away.x > 0.0); }
  if (size.y >= size.z) { return select(3, 2, away.y > 0.0); }
  return select(5, 4, away.z > 0.0);
}

fn lightingLocalShadow(s: LightingInput, light: LocalLight, toLight: vec3f, gap: f32, dotNL: f32, start: vec2f) -> f32 {
  var entry = light.shadowEntry;
  if (light.coneCos < -1.0) { entry += lightingCubeFace(-toLight); }
  let texels = f32(textureDimensions(lightingAtlas).x);
  let look = lightingShadowLook(lightingShadowEntries[u32(entry)], s, toLight, dotNL, max(gap * 0.05, 1e-3), texels, light.shadowRadius, 0.0, light.shadowNormalBias, -light.shadowBias);
  if (!look.inside) { return 1.0; }
  var direction = start;
  var sum = 0.0;
  for (var tap = 0u; tap < LIGHTING_TAPS; tap++) {
    let offset = direction * sqrt((f32(tap) + 0.5) / f32(LIGHTING_TAPS)) * look.radius;
    sum += textureSampleCompareLevel(lightingAtlas, lightingAtlasSampler, look.uvDepth.xy + offset, look.uvDepth.z);
    direction = LIGHTING_GOLDEN_TURN * direction;
  }
  return sum / f32(LIGHTING_TAPS);
}

fn lightingAttenuation(light: LocalLight, gap: f32) -> f32 {
  var falloff = 1.0 / max(pow(gap, light.decay), 0.01);
  if (light.range > 0.0) {
    let ratio = gap / light.range;
    let squared = ratio * ratio;
    let window = saturate(1.0 - squared * squared);
    falloff *= window * window;
  }
  return falloff;
}

// The light a surface reflects toward the eye. What it emits and fog are the caller's to add.
fn lightSurface(s: LightingInput) -> vec3f {
  var m: LightingMaterial;
  m.normal = s.normal;
  m.viewDirection = s.viewDirection;
  m.diffuse = s.albedo * (1.0 - s.metalness);
  m.f0 = mix(vec3f(0.04), s.albedo, s.metalness);
  // A roughness of nothing would be a light's highlight at no width and infinite height.
  m.roughness = clamp(s.roughness, 0.0525, 1.0);
  m.alpha = m.roughness * m.roughness;
  m.dotNV = saturate(dot(s.normal, s.viewDirection));

  var result = lightingIndirect(s, m);
  let start = lightingNoiseDirection(s.pixel);

  for (var index = 0u; index < lighting.sunCount; index++) {
    let toLight = lighting.suns[index].direction;
    let dotNL = saturate(dot(s.normal, toLight));
    if (dotNL <= 0.0) { continue; }
    var color = lighting.suns[index].color;
    if (s.receivesShadow && i32(index) == lighting.cascadeSun) {
      color *= lightingSunShadow(s, lightingViewDepth(s.worldPosition), toLight, dotNL, start) * lightingCloudShade(s.worldPosition);
    }
    result += lightingDirect(m, toLight, dotNL, color);
  }

  if (lighting.localCount == 0u) { return result; }
  let cluster = lightingClusterOf(s.worldPosition) * lighting.wordsPerCluster;
  for (var word = 0u; word < lighting.wordsPerCluster; word++) {
    var bits = lightingClusterWords[cluster + word];
    while (bits != 0u) {
      let index = word * 32u + countTrailingZeros(bits);
      bits &= bits - 1u;
      let light = lightingLocals[index];
      let offset = light.position - s.worldPosition;
      let gap = max(length(offset), 1e-4);
      let toLight = offset / gap;
      let dotNL = saturate(dot(s.normal, toLight));
      if (dotNL <= 0.0) { continue; }
      var strength = lightingAttenuation(light, gap);
      if (light.coneCos >= -1.0) {
        // Worked by hand: a smoothstep between equal edges, a spot with no penumbra, has no defined result.
        let t = saturate((dot(toLight, light.direction) - light.coneCos) / max(light.penumbraCos - light.coneCos, 1e-5));
        strength *= t * t * (3.0 - 2.0 * t);
      }
      if (strength <= 0.0) { continue; }
      var color = light.color * strength;
      if (s.receivesShadow && light.shadowEntry >= 0) {
        color *= lightingLocalShadow(s, light, toLight, gap, dotNL, start);
      }
      result += lightingDirect(m, toLight, dotNL, color);
    }
  }
  return result;
}

// scene.fog by the distance along the camera's axis, not from the eye, as three.js measures it.
// The sky behind a point, for the fog in front of it: never below the horizon, where it would be the ground's colour.
fn lightingSkyColour(toward: vec3f) -> vec3f {
  let direction = normalize(vec3f(toward.x, max(toward.y, 0.035), toward.z));
  let latitude = asin(direction.y);
  let v = 0.5 + 0.5 * sqrt(latitude / 1.570796);
  let u = clamp(atan2(direction.z, direction.x) / 6.283185 + 0.5, 0.002, 0.998);
  let sky = textureSampleLevel(lightingSkyView, lightingSkyViewSampler, vec2f(u, v), 0.0).rgb * lighting.fogSky.rgb;
  return mix(sky, vec3f(dot(sky, vec3f(0.2126, 0.7152, 0.0722))), lighting.fogGrey);
}

fn lightingApplyFog(color: vec3f, worldPosition: vec3f) -> vec3f {
  let mode = lighting.fogColor.w;
  if (mode < 0.5) { return color; }
  let depth = lightingViewDepth(worldPosition);
  var factor: f32;
  if (mode < 1.5) {
    let t = saturate((depth - lighting.fogParams.x) / max(lighting.fogParams.y - lighting.fogParams.x, 1e-5));
    factor = t * t * (3.0 - 2.0 * t);
  } else {
    let amount = lighting.fogParams.z * depth;
    factor = 1.0 - exp(-amount * amount);
  }
  var tint = lighting.fogColor.rgb;
  if (lighting.fogSky.a > 0.0) {
    tint = mix(tint, lightingSkyColour(worldPosition - view.eye.xyz), lighting.fogSky.a);
  }
  return mix(color, tint, factor);
}
`;

/** All of it: what a lit pass pastes into its shader, after the view's WGSL. */
export const LIGHTING_WGSL = `${LIGHTING_TYPES_WGSL}${LIGHTING_BINDINGS_WGSL}${LIGHTING_CLUSTER_WGSL}${LIGHTING_FUNCTIONS_WGSL}`;

/** The lighting group's layout. Layouts made from the same entries are interchangeable. */
export const createLightingLayout = (device: GPUDevice): GPUBindGroupLayout => {
  const visibility = GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;
  return device.createBindGroupLayout({
    label: "gpu lighting",
    entries: [
      { binding: 0, visibility, buffer: { type: "uniform", minBindingSize: UNIFORM_WORDS * 4 } },
      { binding: 1, visibility, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility, buffer: { type: "read-only-storage" } },
      { binding: 4, visibility, texture: { sampleType: "float", viewDimension: "cube" } },
      { binding: 5, visibility, sampler: { type: "filtering" } },
      { binding: 6, visibility, texture: { sampleType: "depth", viewDimension: "2d-array" } },
      { binding: 7, visibility, sampler: { type: "comparison" } },
      { binding: 8, visibility, texture: { sampleType: "depth", viewDimension: "2d" } },
      { binding: 9, visibility, sampler: { type: "comparison" } },
      { binding: 10, visibility, texture: { sampleType: "float", viewDimension: "2d" } },
      { binding: 11, visibility, sampler: { type: "filtering" } },
      { binding: 12, visibility, texture: { sampleType: "float", viewDimension: "cube-array" } },
      { binding: 13, visibility, texture: { sampleType: "float", viewDimension: "2d" } },
      { binding: 14, visibility, sampler: { type: "filtering" } },
      { binding: 15, visibility, texture: { sampleType: "float", viewDimension: "2d" } },
    ],
  });
};

/**
 * How far a light reaches: its range window if that is the nearer limit, otherwise where its falloff has taken it below
 * what can be seen. A decay of nothing never falls off, so it reaches everything.
 */
const reachOf = (brightest: number, decay: number, range: number): number => {
  const fades = decay > 0 ? Math.pow(brightest / REACH_CUTOFF, 1 / decay) : Infinity;
  return Math.min(range > 0 ? Math.min(range, fades) : fades, 1e9);
};

/** The buffers behind the lighting group, what goes in them, and the bind group over them. */
export class LightingResources {
  readonly layout: GPUBindGroupLayout;
  readonly uniformBuffer: GPUBuffer;
  readonly localBuffer: GPUBuffer;
  readonly clusterBuffer: GPUBuffer;
  readonly product: LightingProduct;
  /** Lights in the local table this frame. */
  localCount = 0;
  /** Words in the bit grid per cluster this frame: only as many as this frame's lights need. */
  wordsPerCluster = 1;

  private readonly device: GPUDevice;
  private readonly shadowEntries: GrowableBuffer;
  private readonly floats = new Float32Array(UNIFORM_WORDS);
  private readonly uints = new Uint32Array(this.floats.buffer);
  private readonly ints = new Int32Array(this.floats.buffer);
  private readonly localFloats = new Float32Array(MAX_LOCAL_LIGHTS * LOCAL_LIGHT_WORDS);
  private readonly localInts = new Int32Array(this.localFloats.buffer);
  private readonly fallbackTextures: GPUTexture[];
  private readonly fallbackEnvironment: GPUTextureView;
  private readonly fallbackCascades: GPUTextureView;
  private readonly fallbackAtlas: GPUTextureView;
  private readonly fallbackComparison: GPUSampler;
  private readonly fallbackSkyView: GPUTextureView;
  private readonly fallbackProbes: GPUTextureView;
  private readonly environmentSampler: GPUSampler;
  private bound: unknown[] = [];
  private bindGroup: GPUBindGroup;
  private writtenFor: GpuFrame | null = null;
  private warnedLocal = false;
  private warnedSuns = false;

  constructor(core: GpuCore) {
    const { device } = core;
    this.device = device;
    this.layout = createLightingLayout(device);
    this.uniformBuffer = device.createBuffer({ label: "gpu lighting", size: UNIFORM_WORDS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.localBuffer = device.createBuffer({ label: "gpu local lights", size: this.localFloats.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.clusterBuffer = device.createBuffer({ label: "gpu light clusters", size: CLUSTER_COUNT * MAX_WORDS_PER_CLUSTER * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.shadowEntries = new GrowableBuffer(device, "gpu shadow entries", GPUBufferUsage.STORAGE, 64 * 16);

    // Stand-ins for what has not been published, so that there is one pipeline however the frame is made up. The
    // counts in the uniforms keep the shader from ever reading them.
    const environment = device.createTexture({ label: "gpu no environment", size: [1, 1, 6], format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING });
    const cascades = device.createTexture({ label: "gpu no cascades", size: [1, 1, 1], format: "depth32float", usage: GPUTextureUsage.TEXTURE_BINDING });
    const atlas = device.createTexture({ label: "gpu no atlas", size: [1, 1, 1], format: "depth32float", usage: GPUTextureUsage.TEXTURE_BINDING });
    const skyView = device.createTexture({ label: "gpu no sky table", size: [1, 1], format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING });
    this.fallbackSkyView = skyView.createView();
    const probes = device.createTexture({ label: "gpu no probes", size: [1, 1, 6], format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING });
    this.fallbackProbes = probes.createView({ dimension: "cube-array", arrayLayerCount: 6 });
    this.fallbackTextures = [environment, cascades, atlas, skyView, probes];
    this.fallbackEnvironment = environment.createView({ dimension: "cube" });
    this.fallbackCascades = cascades.createView({ dimension: "2d-array" });
    this.fallbackAtlas = atlas.createView({ dimension: "2d" });
    this.fallbackComparison = device.createSampler({ label: "gpu no shadow", compare: "greater" });
    this.environmentSampler = device.createSampler({ label: "gpu environment", magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });

    this.bindGroup = this.makeBindGroup(this.fallbackEnvironment, this.fallbackCascades, this.fallbackComparison, this.fallbackAtlas, this.fallbackComparison, this.fallbackSkyView, this.environmentSampler, this.fallbackProbes, this.fallbackSkyView, this.environmentSampler, this.fallbackSkyView);
    this.product = { layout: this.layout, bindGroup: this.bindGroup, wgsl: LIGHTING_WGSL, resources: this };
  }

  /**
   * Brings everything up to date for this frame and publishes it. The lights go up once a frame; what other passes
   * publish is looked at each time, since an environment may arrive between the clusters and the lighting.
   */
  refresh(frame: GpuFrame): LightingProduct {
    if (this.writtenFor !== frame) {
      this.writtenFor = frame;
      this.writeLights(frame);
      this.writeLocals(frame);
    }
    this.writePublished(frame);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.floats);
    frame.products.set("lighting", this.product);
    return this.product;
  }

  destroy(): void {
    this.uniformBuffer.destroy();
    this.localBuffer.destroy();
    this.clusterBuffer.destroy();
    this.shadowEntries.destroy();
    for (const texture of this.fallbackTextures) texture.destroy();
  }

  private writeLights(frame: GpuFrame): void {
    const { floats, uints } = this;
    const { gpuScene, camera, scene } = frame;
    const suns = gpuScene.directional;
    if (suns.length > MAX_SUNS && !this.warnedSuns) {
      this.warnedSuns = true;
      reportGpu(`[gpu] ${suns.length} directional lights in the scene; the first ${MAX_SUNS} light it`);
    }
    const sunCount = Math.min(suns.length, MAX_SUNS);
    for (let index = 0; index < sunCount; index++) {
      const light = suns[index];
      // A row for every light, even one out of the camera's layers, because the shadow pass counts by the same list.
      const scale = light.layers.test(camera.layers) ? light.intensity : 0;
      const at = index * 8;
      const placed = light.matrixWorld.elements;
      const aim = light.target.matrixWorld.elements;
      const dx = placed[12] - aim[12];
      const dy = placed[13] - aim[13];
      const dz = placed[14] - aim[14];
      const size = Math.hypot(dx, dy, dz) || 1;
      floats[at] = dx / size;
      floats[at + 1] = dy / size;
      floats[at + 2] = dz / size;
      floats[at + 4] = light.color.r * scale;
      floats[at + 5] = light.color.g * scale;
      floats[at + 6] = light.color.b * scale;
    }
    floats[64] = gpuScene.ambient.r;
    floats[65] = gpuScene.ambient.g;
    floats[66] = gpuScene.ambient.b;
    floats[68] = gpuScene.hemiSky.r;
    floats[69] = gpuScene.hemiSky.g;
    floats[70] = gpuScene.hemiSky.b;
    floats[72] = gpuScene.hemiGround.r;
    floats[73] = gpuScene.hemiGround.g;
    floats[74] = gpuScene.hemiGround.b;

    const fog = scene.fog as (THREE.Fog & THREE.FogExp2) | null;
    floats[79] = 0;
    if (fog && (fog.isFog || fog.isFogExp2)) {
      floats[76] = fog.color.r;
      floats[77] = fog.color.g;
      floats[78] = fog.color.b;
      floats[79] = fog.isFogExp2 ? 2 : 1;
      floats[80] = fog.near ?? 0;
      floats[81] = fog.far ?? 0;
      floats[82] = fog.density ?? 0;
    }

    // The camera's own numbers, read from its projection so that any camera will do.
    floats.set(camera.matrixWorldInverse.elements, 84);
    const p = camera.projectionMatrix.elements;
    const orthographic = p[15] === 1;
    floats[100] = p[0];
    floats[101] = p[5];
    floats[102] = orthographic ? -p[12] : p[8];
    floats[103] = orthographic ? -p[13] : p[9];
    const near = orthographic ? (p[14] + 1) / p[10] : p[14] / (p[10] - 1);
    let far = orthographic ? (p[14] - 1) / p[10] : p[14] / (p[10] + 1);
    if (!Number.isFinite(far) || far <= near) far = Math.abs(near) * 1e6 + 1;
    // A logarithm needs a start above zero. A perspective near always is one; an orthographic one may sit behind the
    // camera, and then the first slice takes in everything up to here.
    const start = Math.max(near, (far - near) * 1e-3, 1e-3);
    floats[104] = near;
    floats[105] = start;
    floats[106] = far;
    floats[107] = CLUSTER_GRID.z / Math.max(Math.log(far / start), 1e-3);
    uints[224] = sunCount;
    uints[227] = orthographic ? 1 : 0;
  }

  private writeLocals(frame: GpuFrame): void {
    const { localFloats, localInts } = this;
    const { gpuScene, camera } = frame;
    const lights = gpuScene.local;
    if (lights.length > MAX_LOCAL_LIGHTS && !this.warnedLocal) {
      this.warnedLocal = true;
      reportGpu(`[gpu] ${lights.length} point and spot lights in the scene; the first ${MAX_LOCAL_LIGHTS} light it`);
    }
    const count = Math.min(lights.length, MAX_LOCAL_LIGHTS);
    const shadowMaps = frame.products.get("shadowMaps") as ShadowMapsProduct | undefined;
    const lightToEntry = shadowMaps?.atlas?.lightToEntry;
    for (let index = 0; index < count; index++) {
      const light = lights[index];
      const at = index * LOCAL_LIGHT_WORDS;
      const placed = light.matrixWorld.elements;
      const px = placed[12];
      const py = placed[13];
      const pz = placed[14];
      // Out of the camera's layers: a row with no reach, because the shadow atlas counts by the same list.
      const scale = light.layers.test(camera.layers) ? light.intensity : 0;
      const r = light.color.r * scale;
      const g = light.color.g * scale;
      const b = light.color.b * scale;
      const brightest = Math.max(r, g, b);
      const reach = brightest > 0 ? reachOf(brightest, light.decay, light.distance) : 0;
      let dx = 0;
      let dy = 0;
      let dz = 0;
      let coneCos = POINT_LIGHT_CONE;
      let penumbraCos = 1;
      let cullX = px;
      let cullY = py;
      let cullZ = pz;
      let cullRadius = reach;
      const spot = light as THREE.SpotLight;
      if (spot.isSpotLight) {
        const aim = spot.target.matrixWorld.elements;
        dx = px - aim[12];
        dy = py - aim[13];
        dz = pz - aim[14];
        const size = Math.hypot(dx, dy, dz) || 1;
        dx /= size;
        dy /= size;
        dz /= size;
        coneCos = Math.cos(spot.angle);
        penumbraCos = Math.cos(spot.angle * (1 - spot.penumbra));
        // The smallest sphere around the cone. A narrow cone's passes through its tip and its rim; a wide cone's is
        // centred on its rim's circle.
        if (spot.angle < Math.PI / 2) {
          const sine = Math.sin(spot.angle);
          const away = coneCos >= sine ? reach / (2 * coneCos) : reach * coneCos;
          cullRadius = coneCos >= sine ? away : reach * sine;
          cullX = px - dx * away;
          cullY = py - dy * away;
          cullZ = pz - dz * away;
        }
      }
      localFloats[at] = px;
      localFloats[at + 1] = py;
      localFloats[at + 2] = pz;
      localFloats[at + 3] = light.distance;
      localFloats[at + 4] = dx;
      localFloats[at + 5] = dy;
      localFloats[at + 6] = dz;
      localFloats[at + 7] = light.decay;
      localFloats[at + 8] = r;
      localFloats[at + 9] = g;
      localFloats[at + 10] = b;
      localFloats[at + 11] = coneCos;
      localFloats[at + 12] = cullX;
      localFloats[at + 13] = cullY;
      localFloats[at + 14] = cullZ;
      localFloats[at + 15] = cullRadius;
      localFloats[at + 16] = penumbraCos;
      localInts[at + 17] = lightToEntry?.[index] ?? -1;
      localFloats[at + 18] = light.shadow?.bias ?? 0;
      localFloats[at + 19] = light.shadow?.normalBias ?? 0;
      localFloats[at + 20] = filterRadius(light.shadow?.radius);
      localFloats[at + 21] = reach;
    }
    if (count) this.device.queue.writeBuffer(this.localBuffer, 0, localFloats, 0, count * LOCAL_LIGHT_WORDS);
    this.localCount = count;
    this.wordsPerCluster = Math.max(1, Math.ceil(count / BITS_PER_WORD));
    this.uints[225] = count;
    this.uints[226] = this.wordsPerCluster;
  }

  /** What other passes published: the environment and the shadow maps. */
  private writePublished(frame: GpuFrame): void {
    const { floats, uints, ints } = this;
    const environment = frame.products.get("environment") as EnvironmentProduct | undefined;
    if (environment) {
      for (let coefficient = 0; coefficient < 9; coefficient++) {
        floats[108 + coefficient * 4] = environment.diffuseSH[coefficient * 3];
        floats[109 + coefficient * 4] = environment.diffuseSH[coefficient * 3 + 1];
        floats[110 + coefficient * 4] = environment.diffuseSH[coefficient * 3 + 2];
      }
    }
    floats[230] = environment ? environment.specularMips : 0;
    const skyFog = frame.products.get("skyFog") as SkyFogProduct | undefined;
    const takesSky = !!skyFog?.followsSky && skyFog.share > 0;
    floats[231] = skyFog?.grey ?? 0;
    floats[232] = skyFog?.scale[0] ?? 1;
    floats[233] = skyFog?.scale[1] ?? 1;
    floats[234] = skyFog?.scale[2] ?? 1;
    floats[235] = takesSky ? skyFog.share : 0;
    const probes = frame.products.get("probes") as ProbesProduct | undefined;
    this.uints[236] = probes?.count ?? 0;
    floats[237] = probes?.mips ?? 0;
    if (probes) {
      floats.set(probes.spheres, 240);
      floats.set(probes.intensities, 272);
    }
    const cloud = frame.products.get("cloudShadow") as CloudShadowProduct | undefined;
    floats[304] = cloud?.tiling ?? 0;
    floats[305] = cloud?.driftU ?? 0;
    floats[306] = cloud?.driftV ?? 0;
    floats[307] = cloud?.threshold ?? 0;
    floats[308] = cloud?.leanX ?? 0;
    floats[309] = cloud?.leanZ ?? 0;
    floats[310] = cloud?.height ?? 0;
    floats[311] = cloud?.strength ?? 0;
    const seen = frame.products.get("skyVisibility") as SkyVisibilityProduct | undefined;
    floats[312] = seen?.cornerX ?? 0;
    floats[313] = seen?.cornerZ ?? 0;
    floats[314] = seen?.inverseSide ?? 0;
    floats[315] = seen?.originY ?? 0;
    floats[316] = seen?.occlusion ?? 0;
    floats[317] = seen?.floor ?? 1;
    floats[318] = cloud?.edge ?? 0;
    floats[319] = seen ? 1 : 0;

    const shadowMaps = frame.products.get("shadowMaps") as ShadowMapsProduct | undefined;
    const cascades = shadowMaps?.cascades ?? null;
    const atlas = shadowMaps?.atlas ?? null;
    uints[228] = cascades ? Math.min(cascades.count, CASCADES) : 0;
    ints[229] = cascades && cascades.count > 0 ? cascades.sunIndex : -1;
    if (cascades) {
      floats.set(cascades.matrices.subarray(0, CASCADES * 16), 144);
      floats.set(cascades.splits.subarray(0, CASCADES), 208);
      floats.set(cascades.normalOffset.subarray(0, CASCADES), 216);
      floats.set(cascades.bias.subarray(0, CASCADES), 220);
      const shadow = frame.gpuScene.directional[cascades.sunIndex]?.shadow;
      floats[212] = shadow?.bias ?? 0;
      floats[213] = shadow?.normalBias ?? 0;
      floats[214] = filterRadius(shadow?.radius);
    }
    floats[215] = frame.frameNumber % NOISE_FRAMES;
    if (atlas?.entries.byteLength) {
      this.shadowEntries.ensure(atlas.entries.byteLength);
      this.shadowEntries.write(0, atlas.entries);
    }

    const next = this.makeOrReuseBindGroup(
      environment?.specular ?? this.fallbackEnvironment,
      cascades?.view ?? this.fallbackCascades,
      cascades?.sampler ?? this.fallbackComparison,
      atlas?.view ?? this.fallbackAtlas,
      atlas?.sampler ?? this.fallbackComparison,
      skyFog?.view ?? this.fallbackSkyView,
      skyFog?.sampler ?? this.environmentSampler,
      probes?.view ?? this.fallbackProbes,
      cloud?.weather ?? this.fallbackSkyView,
      cloud?.sampler ?? this.environmentSampler,
      seen?.view ?? this.fallbackSkyView,
    );
    this.product.bindGroup = next;
  }

  private makeOrReuseBindGroup(environment: GPUTextureView, cascades: GPUTextureView, cascadeSampler: GPUSampler, atlas: GPUTextureView, atlasSampler: GPUSampler, skyView: GPUTextureView, skySampler: GPUSampler, probes: GPUTextureView, cloudWeather: GPUTextureView, cloudSampler: GPUSampler, skySeen: GPUTextureView): GPUBindGroup {
    const wanted = [environment, cascades, cascadeSampler, atlas, atlasSampler, skyView, skySampler, probes, cloudWeather, cloudSampler, skySeen, this.shadowEntries.buffer];
    if (wanted.every((resource, index) => resource === this.bound[index])) return this.bindGroup;
    this.bindGroup = this.makeBindGroup(environment, cascades, cascadeSampler, atlas, atlasSampler, skyView, skySampler, probes, cloudWeather, cloudSampler, skySeen);
    return this.bindGroup;
  }

  private makeBindGroup(environment: GPUTextureView, cascades: GPUTextureView, cascadeSampler: GPUSampler, atlas: GPUTextureView, atlasSampler: GPUSampler, skyView: GPUTextureView, skySampler: GPUSampler, probes: GPUTextureView, cloudWeather: GPUTextureView, cloudSampler: GPUSampler, skySeen: GPUTextureView): GPUBindGroup {
    this.bound = [environment, cascades, cascadeSampler, atlas, atlasSampler, skyView, skySampler, probes, cloudWeather, cloudSampler, skySeen, this.shadowEntries.buffer];
    return this.device.createBindGroup({
      label: "gpu lighting",
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.localBuffer } },
        { binding: 2, resource: { buffer: this.clusterBuffer } },
        { binding: 3, resource: { buffer: this.shadowEntries.buffer } },
        { binding: 4, resource: environment },
        { binding: 5, resource: this.environmentSampler },
        { binding: 6, resource: cascades },
        { binding: 7, resource: cascadeSampler },
        { binding: 8, resource: atlas },
        { binding: 9, resource: atlasSampler },
        { binding: 10, resource: skyView },
        { binding: 11, resource: skySampler },
        { binding: 12, resource: probes },
        { binding: 13, resource: cloudWeather },
        { binding: 14, resource: cloudSampler },
        { binding: 15, resource: skySeen },
      ],
    });
  }
}

/** A light's shadow filter radius in texels; a bit over its radius, since the disk is sparser than a full grid. */
const filterRadius = (radius: number | undefined): number => Math.max(radius ?? 1, 0.5) * 1.5;
