/// <reference types="@webgpu/types" />
import type { SkyFrame } from "../../../components/Environment/sky/SkyRenderer";
import { CLOUD_EDGE, cloudThreshold, GROUND_RADIUS, TOP_RADIUS } from "../../../runtime/sky/atmosphere";
import type { AtmosphereTables } from "./atmosphereTables";

/**
 * VOLUMETRIC CLOUDS
 *
 * Clouds are a thick shell of air far overhead, ray marched from the camera's position into their own map of the upper
 * sky (a stereographic projection, so the crowded horizon gets the most texels). A sixteenth of the map's texels are
 * traced each frame and the rest are carried over from the last frame's map, followed along as wind and the camera move
 * the clouds; so the cost does not depend on the screen, turning the camera costs nothing, and the Sky Light and
 * reflections see the same clouds.
 *
 * Their shapes come from tiling 3D noise (billowy Perlin-Worley for the body, finer Worley eating at the edges) under a
 * 2D weather map that says where clouds are. Light follows the usual model for thick cloud: attenuated toward the sun,
 * with its strongest scattering forward (the silver lining) and a few fainter, softer orders standing in for the many
 * times light bounces inside.
 */

/** The clouds' weather map repeats this often per kilometre, at Cloud Size 1. */
export const WEATHER_TILES_PER_KM = 0.055;

const SHAPE_SIZE = 64;
const DETAIL_SIZE = 32;
const WEATHER_SIZE = 512;
/** The noise is made over a few frames, this many slices at a time, so a level does not stall when clouds first show. */
const NOISE_SLICES_PER_FRAME = 16;
/** The clouds' map's side and march steps, by quality. */
const CLOUD_MAPS: Record<"low" | "medium" | "high", { size: number; steps: number }> = {
  low: { size: 1024, steps: 32 },
  medium: { size: 1536, steps: 48 },
  high: { size: 2048, steps: 64 },
};
/** Blended over what was there, once settled: light each texel by several frames' worth of rays. */
const CLOUD_SETTLE_BLEND = 0.3;
/** A full pass over the map, in frames; each frame one of these tiles' texels. */
const CLOUD_PASS = 16;
/** Tile order, so a pass fills in evenly. */
const TILES = [0, 10, 2, 8, 5, 15, 7, 13, 1, 11, 3, 9, 4, 14, 6, 12];
const TRACE_WORDS = 36;

const TILING_NOISE_WGSL = /* wgsl */ `
fn wrapped(a: vec3f, b: f32) -> vec3f { return a - b * floor(a / b); }

fn hash3(input: vec3f) -> vec3f {
  let p = vec3f(dot(input, vec3f(127.1, 311.7, 74.7)), dot(input, vec3f(269.5, 183.3, 246.1)), dot(input, vec3f(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}

// Bright at the centre of each cell and dark between: billows. Tiles every 'period' cells.
fn worley(p: vec3f, period: f32) -> f32 {
  let cell = floor(p);
  let f = p - cell;
  var nearest = 1.0;
  for (var x = -1; x <= 1; x++) {
    for (var y = -1; y <= 1; y++) {
      for (var z = -1; z <= 1; z++) {
        let o = vec3f(f32(x), f32(y), f32(z));
        let d = o + hash3(wrapped(cell + o, period)) - f;
        nearest = min(nearest, dot(d, d));
      }
    }
  }
  return 1.0 - sqrt(nearest);
}

fn gradientNoise(p: vec3f, period: f32) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let n000 = dot(hash3(wrapped(i, period)) * 2.0 - 1.0, f);
  let n100 = dot(hash3(wrapped(i + vec3f(1.0, 0.0, 0.0), period)) * 2.0 - 1.0, f - vec3f(1.0, 0.0, 0.0));
  let n010 = dot(hash3(wrapped(i + vec3f(0.0, 1.0, 0.0), period)) * 2.0 - 1.0, f - vec3f(0.0, 1.0, 0.0));
  let n110 = dot(hash3(wrapped(i + vec3f(1.0, 1.0, 0.0), period)) * 2.0 - 1.0, f - vec3f(1.0, 1.0, 0.0));
  let n001 = dot(hash3(wrapped(i + vec3f(0.0, 0.0, 1.0), period)) * 2.0 - 1.0, f - vec3f(0.0, 0.0, 1.0));
  let n101 = dot(hash3(wrapped(i + vec3f(1.0, 0.0, 1.0), period)) * 2.0 - 1.0, f - vec3f(1.0, 0.0, 1.0));
  let n011 = dot(hash3(wrapped(i + vec3f(0.0, 1.0, 1.0), period)) * 2.0 - 1.0, f - vec3f(0.0, 1.0, 1.0));
  let n111 = dot(hash3(wrapped(i + vec3f(1.0, 1.0, 1.0), period)) * 2.0 - 1.0, f - vec3f(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}

fn perlinFbm(p: vec3f, period: f32, octaves: i32) -> f32 {
  var sum = 0.0;
  var amplitude = 1.0;
  var frequency = 1.0;
  var total = 0.0;
  for (var i = 0; i < octaves; i++) {
    sum += gradientNoise(p * frequency, period * frequency) * amplitude;
    total += amplitude;
    frequency *= 2.0;
    amplitude *= 0.5;
  }
  return sum / total * 0.5 + 0.5;
}

fn worleyFbm(p: vec3f, period: f32) -> f32 {
  return worley(p, period) * 0.625 + worley(p * 2.0, period * 2.0) * 0.25 + worley(p * 4.0, period * 4.0) * 0.125;
}

fn remap(value: f32, fromLow: f32, fromHigh: f32, toLow: f32, toHigh: f32) -> f32 {
  return toLow + (value - fromLow) * (toHigh - toLow) / (fromHigh - fromLow);
}
`;

const NOISE_WGSL = /* wgsl */ `
${TILING_NOISE_WGSL}
struct Slices { first: u32, size: u32 }
@group(0) @binding(0) var<uniform> slices: Slices;
@group(0) @binding(1) var volumeOut: texture_storage_3d<rgba8unorm, write>;

// One slice of the tiling cloud body: R billowy Perlin-Worley, G, B and A Worley at rising frequencies.
@compute @workgroup_size(8, 8, 1) fn shapeMain(@builtin(global_invocation_id) id: vec3u) {
  let p = (vec3f(f32(id.x), f32(id.y), f32(id.z + slices.first)) + 0.5) / f32(slices.size);
  let perlin = perlinFbm(p * 4.0, 4.0, 5);
  let billows = worleyFbm(p * 4.0, 4.0);
  let body = clamp(remap(perlin, billows - 1.0, 1.0, 0.0, 1.0), 0.0, 1.0);
  textureStore(volumeOut, vec3u(id.x, id.y, id.z + slices.first), vec4f(body, worleyFbm(p * 4.0, 4.0), worleyFbm(p * 8.0, 8.0), worleyFbm(p * 16.0, 16.0)));
}

// One slice of the fine detail that eats at the clouds' edges.
@compute @workgroup_size(8, 8, 1) fn detailMain(@builtin(global_invocation_id) id: vec3u) {
  let p = (vec3f(f32(id.x), f32(id.y), f32(id.z + slices.first)) + 0.5) / f32(slices.size);
  textureStore(volumeOut, vec3u(id.x, id.y, id.z + slices.first), vec4f(worleyFbm(p * 4.0, 4.0), worleyFbm(p * 8.0, 8.0), worleyFbm(p * 16.0, 16.0), 1.0));
}
`;

const NOISE_MIP_WGSL = /* wgsl */ `
@group(0) @binding(0) var above: texture_3d<f32>;
@group(0) @binding(1) var below: texture_storage_3d<rgba8unorm, write>;

// Each mip the average of the eight texels above it.
@compute @workgroup_size(4, 4, 4) fn mipMain(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(below);
  if (id.x >= size.x || id.y >= size.y || id.z >= size.z) { return; }
  let p = vec3i(id) * 2;
  var sum = vec4f(0.0);
  for (var x = 0; x < 2; x++) {
    for (var y = 0; y < 2; y++) {
      for (var z = 0; z < 2; z++) {
        sum += textureLoad(above, p + vec3i(x, y, z), 0);
      }
    }
  }
  textureStore(below, id, sum / 8.0);
}
`;

const WEATHER_WGSL = /* wgsl */ `
${TILING_NOISE_WGSL}
@group(0) @binding(0) var weatherOut: texture_storage_2d<rgba8unorm, write>;

// Where clouds are: R how much cloud a place tends to have, G what kind (low and flat, or tall). Tiles.
@compute @workgroup_size(8, 8) fn weatherMain(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(weatherOut);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec3f((vec2f(id.xy) + 0.5) / vec2f(size), 0.37);
  let broad = perlinFbm(p * 5.0, 5.0, 5);
  let billows = worleyFbm(p * 8.0, 8.0);
  let amount = clamp(remap(broad, 0.3, 0.72, 0.0, 1.0), 0.0, 1.0) * 0.62 + billows * 0.38;
  let kind = perlinFbm(p * 3.0 + 7.0, 3.0, 3);
  textureStore(weatherOut, id.xy, vec4f(amount, clamp(remap(kind, 0.35, 0.65, 0.0, 1.0), 0.0, 1.0), 0.0, 1.0));
}
`;

const TRACE_WGSL = /* wgsl */ `
const SKY_PI = 3.14159265358979;

struct Trace {
  planet: vec2f,
  viewRadius: f32,
  keyStrength: f32,
  keyDirection: vec3f,
  threshold: f32,
  ambient: vec3f,
  edge: f32,
  groundAmbient: vec3f,
  weatherTiling: f32,
  offset: vec2f,
  // How far the clouds moved since the last frame's map, and the camera's rise.
  motion: vec2f,
  base: f32,
  depth: f32,
  density: f32,
  detailAmount: f32,
  shapeScale: f32,
  skyToCloud: f32,
  skyGrey: f32,
  phase: f32,
  tile: vec2u,
  steps: u32,
  reset: u32,
  blend: f32,
  rise: f32,
}

@group(0) @binding(0) var<uniform> trace: Trace;
@group(0) @binding(1) var shapeNoise: texture_3d<f32>;
@group(0) @binding(2) var detailNoise: texture_3d<f32>;
@group(0) @binding(3) var weatherMap: texture_2d<f32>;
@group(0) @binding(4) var transmittanceTable: texture_2d<f32>;
@group(0) @binding(5) var skyViewTable: texture_2d<f32>;
@group(0) @binding(6) var history: texture_2d<f32>;
@group(0) @binding(7) var mapOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(8) var tilingSampler: sampler;
@group(0) @binding(9) var clampSampler: sampler;
@group(0) @binding(10) var skyViewSampler: sampler;

fn transmittanceUvFor(r: f32, mu: f32) -> vec2f {
  let top = trace.planet.y;
  let ground = trace.planet.x;
  let h = sqrt(top * top - ground * ground);
  let rho = sqrt(max(0.0, r * r - ground * ground));
  let discriminant = r * r * (mu * mu - 1.0) + top * top;
  let d = max(0.0, -r * mu + sqrt(max(0.0, discriminant)));
  let dMin = top - r;
  let dMax = rho + h;
  return vec2f((d - dMin) / max(dMax - dMin, 1e-5), rho / h);
}

fn raySphere(origin: vec3f, direction: vec3f, radius: f32) -> f32 {
  let b = dot(origin, direction);
  let c = dot(origin, origin) - radius * radius;
  let d = b * b - c;
  if (d < 0.0) { return -1.0; }
  let root = sqrt(d);
  let near = -b - root;
  if (near > 0.0) { return near; }
  let far = -b + root;
  return select(-1.0, far, far > 0.0);
}

fn linearStep(low: f32, high: f32, value: f32) -> f32 { return clamp((value - low) / (high - low), 0.0, 1.0); }

fn reMap(value: f32, fromLow: f32, fromHigh: f32, toLow: f32, toHigh: f32) -> f32 {
  return toLow + (value - fromLow) * (toHigh - toLow) / (fromHigh - fromLow);
}

fn cloudDensity(point: vec3f, height: f32, fine: bool, lod: f32) -> f32 {
  let weatherAt = (point.xz + trace.offset) * trace.weatherTiling / trace.shapeScale;
  let weather = textureSampleLevel(weatherMap, tilingSampler, weatherAt, 0.0).rg;
  let cover = linearStep(trace.threshold, trace.threshold + trace.edge, weather.r);
  if (cover <= 0.001) { return 0.0; }
  // Rounded below; flat-topped or tall by what kind of cloud grows here, thin at the top.
  let peak = mix(0.38, 1.0, weather.g * weather.g);
  let profile = smoothstep(0.0, 0.07, height) * (1.0 - smoothstep(peak * 0.55, peak, height));
  if (profile <= 0.0) { return 0.0; }
  let at = vec3f(point.x + trace.offset.x, point.y * 1.8, point.z + trace.offset.y) * 0.17 / trace.shapeScale;
  let shape = textureSampleLevel(shapeNoise, tilingSampler, at, lod);
  // Both noises sit in narrow bands (measured): spread them to the full range, so they carve real shapes.
  let body0 = linearStep(0.6, 0.74, shape.r);
  let billows = linearStep(0.36, 0.62, shape.g * 0.42 + shape.b * 0.34 + shape.a * 0.24);
  let base = body0 * 0.45 + billows * 0.55;
  // What is left once coverage and height have eaten the shape away.
  var body = clamp(reMap(base * profile, 1.0 - cover, 1.0, 0.0, 1.0), 0.0, 1.0);
  if (body <= 0.0) { return 0.0; }
  if (fine && trace.detailAmount > 0.0) {
    let detailAt = vec3f(point.x + trace.offset.x, point.y, point.z + trace.offset.y) * 1.3 / trace.shapeScale;
    let detail = textureSampleLevel(detailNoise, tilingSampler, detailAt, lod).rgb;
    var wisps = linearStep(0.22, 0.78, detail.r * 0.5 + detail.g * 0.3 + detail.b * 0.2);
    // Wispy at the base, billowed higher up.
    wisps = mix(1.0 - wisps, wisps, clamp(height * 5.0, 0.0, 1.0));
    body = clamp(reMap(body, wisps * trace.detailAmount * 0.85, 1.0, 0.0, 1.0), 0.0, 1.0);
  }
  // Dense soon after its edge, as a cloud is: not a slow fade through its whole body.
  return min(body * 3.2, 1.0);
}

fn henyeyGreenstein(c: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * SKY_PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

// Forward glow and a little scattered back.
fn cloudPhase(c: f32) -> f32 {
  return mix(henyeyGreenstein(c, -0.2), henyeyGreenstein(c, 0.82), 0.55);
}

fn sunwardDepth(point: vec3f, innerRadius: f32, depth: f32, extinction: f32) -> f32 {
  var sum = 0.0;
  var stride = 0.09;
  var p = point;
  for (var i = 0; i < 6; i++) {
    p += trace.keyDirection * stride;
    let height = (sqrt(dot(p, p)) - innerRadius) / depth;
    if (height >= 1.0) { break; }
    if (height > 0.0) { sum += cloudDensity(p, height, false, 1.0 + f32(i) * 0.5) * stride; }
    stride *= 1.7;
  }
  return sum * extinction;
}

fn viewUv(direction: vec3f) -> vec2f {
  let latitude = asin(clamp(direction.y, -1.0, 1.0));
  return vec2f(atan2(direction.z, direction.x) / (2.0 * SKY_PI) + 0.5, 0.5 + 0.5 * sign(latitude) * sqrt(abs(latitude) / (SKY_PI * 0.5)));
}

// What this texel of the map showed last frame: the same cloud, where it was then. Clouds move with the wind and against
// the camera, at their own height; the place they were is found by moving back by that, from there to the map.
fn carriedOver(pixel: vec2u, direction: vec3f) -> vec4f {
  if (trace.reset != 0u) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  if (abs(trace.motion.x) + abs(trace.motion.y) + abs(trace.rise) < 1e-6) { return textureLoad(history, pixel, 0); }
  let origin = vec3f(0.0, trace.viewRadius, 0.0);
  let t = raySphere(origin, direction, trace.planet.x + trace.base + trace.depth * 0.35);
  if (t <= 0.0) { return textureLoad(history, pixel, 0); }
  let before = normalize(direction * t + vec3f(trace.motion.x, trace.rise, trace.motion.y));
  if (before.y <= 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let uv = before.xz / (1.0 + before.y) * 0.5 + 0.5;
  return textureSampleLevel(history, clampSampler, uv, 0.0);
}

fn traced(direction: vec3f, pixel: vec2u) -> vec4f {
  let inner = trace.planet.x + trace.base;
  let outer = inner + trace.depth;
  let origin = vec3f(0.0, trace.viewRadius, 0.0);
  let start = select(0.0, raySphere(origin, direction, inner), trace.viewRadius < inner);
  var stop = raySphere(origin, direction, outer);
  if (start < 0.0 || stop <= start) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  // Past this the clouds are lost in the haze anyway.
  stop = min(stop, start + 70.0);

  let at = vec2f(pixel) + 0.5;
  let noise = fract(52.9829189 * fract(dot(at, vec2f(0.06711056, 0.00583715))) + trace.phase);
  let dt = (stop - start) / f32(trace.steps);
  let extinction = 46.0 * trace.density;
  let cosine = dot(direction, trace.keyDirection);
  var light = vec3f(0.0);
  var through = 1.0;
  var firstHit = -1.0;
  for (var i = 0u; i < trace.steps; i++) {
    let t = start + (f32(i) + noise) * dt;
    let point = origin + direction * t;
    let radius = sqrt(dot(point, point));
    let height = (radius - inner) / trace.depth;
    if (height < 0.0 || height > 1.0) { continue; }
    let lod = clamp(t / 18.0, 0.0, 2.0);
    let density = cloudDensity(point, height, t < 35.0, lod);
    if (density <= 0.002) { continue; }
    if (firstHit < 0.0) { firstHit = t; }
    let sigma = density * extinction;
    let toward = sunwardDepth(point, inner, trace.depth, extinction);
    let mu = dot(point, trace.keyDirection) / radius;
    let sunlight = textureSampleLevel(transmittanceTable, clampSampler, transmittanceUvFor(radius, mu), 0.0).rgb * trace.keyStrength;
    // Three orders of scattering, each softer and reaching deeper than the last.
    var a = 1.0;
    var b = 1.0;
    var c = 1.0;
    var scattered = 0.0;
    for (var order = 0; order < 3; order++) {
      scattered += a * exp(-toward * b) * cloudPhase(cosine * c);
      a *= 0.5;
      b *= 0.42;
      c *= 0.5;
    }
    // Thick cloud is nearly white for what light falls on it: most of what lights it has bounced many times over and
    // comes from every way. That is what makes a cloud bright on the side away from the sun. Some of it gets all the
    // way through: under a thick deck the light is dim and even, not black.
    scattered += 0.26 * (0.66 * exp(-toward * 0.11) + 0.34 * exp(-toward * 0.009));
    // Dark at the sunny edge of a thick cloud's folds, where light has not yet built up.
    scattered *= 1.0 - 0.4 * exp(-toward * 1.8) * (1.0 - 0.75 * max(cosine, 0.0));
    var ambient = mix(trace.groundAmbient, trace.ambient, clamp(height * 1.2 + 0.15, 0.0, 1.0)) * 2.5;
    // Deep inside, what light there is has lost the blue sky's colour.
    ambient = mix(vec3f(dot(ambient, vec3f(0.2126, 0.7152, 0.0722))), ambient, exp(-toward * 0.02));
    let source = (sunlight * scattered + ambient) * sigma;
    let stepThrough = exp(-sigma * dt);
    light += through * (source - source * stepThrough) / max(sigma, 1e-4);
    through *= stepThrough;
    if (through < 0.008) { break; }
  }
  if (firstHit > 0.0) {
    // Distant clouds sink into the air between: toward the sky's own colour there.
    var sky = textureSampleLevel(skyViewTable, skyViewSampler, viewUv(direction), 0.0).rgb * trace.skyToCloud;
    sky = mix(sky, vec3f(dot(sky, vec3f(0.2126, 0.7152, 0.0722))), trace.skyGrey);
    let airLeft = exp(-firstHit / 38.0);
    light = mix(sky * (1.0 - through), light, airLeft);
  }
  return vec4f(max(light, vec3f(0.0)), through);
}

// Output: light (per unit of sunlight) and how much of the sky behind shows.
@compute @workgroup_size(8, 8) fn traceMain(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(mapOut);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let q = uv * 2.0 - 1.0;
  let rr = dot(q, q);
  if (rr > 1.08) {
    textureStore(mapOut, id.xy, vec4f(0.0, 0.0, 0.0, 1.0));
    return;
  }
  let direction = normalize(vec3f(2.0 * q.x, max(1.0 - rr, 0.0), 2.0 * q.y) / (1.0 + rr));
  let before = carriedOver(id.xy, direction);
  if ((id.x & 3u) != trace.tile.x || (id.y & 3u) != trace.tile.y) {
    textureStore(mapOut, id.xy, before);
    return;
  }
  textureStore(mapOut, id.xy, mix(before, traced(direction, id.xy), trace.blend));
}
`;

const volume = (device: GPUDevice, label: string, size: number, mips: number): GPUTexture => device.createTexture({
  label,
  size: [size, size, size],
  dimension: "3d",
  format: "rgba8unorm",
  mipLevelCount: mips,
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
});

type Quality = keyof typeof CLOUD_MAPS;

const isVolumetric = (quality: string): quality is Quality => quality === "low" || quality === "medium" || quality === "high";

/** The clouds' noise, weather and map, and when each is made. */
export class CloudMap {
  private readonly shape: GPUTexture;
  private readonly detail: GPUTexture;
  private readonly weather: GPUTexture;
  readonly weatherView: GPUTextureView;
  readonly tilingSampler: GPUSampler;
  private readonly noiseStep: GPUBuffer;
  private readonly traceBuffer: GPUBuffer;
  private readonly traceData = new Float32Array(TRACE_WORDS);
  private readonly traceWords = new Uint32Array(this.traceData.buffer);

  private noiseSlice = 0;
  private noiseDone = false;
  private shapePipeline: GPUComputePipeline | null = null;
  private detailPipeline: GPUComputePipeline | null = null;
  private tracePipeline: GPUComputePipeline | null = null;
  private traceCompiling = false;

  private mapSize = 0;
  private maps: [GPUTexture, GPUTexture] | null = null;
  private mapViews: [GPUTextureView, GPUTextureView] | null = null;
  private traceGroups: [GPUBindGroup, GPUBindGroup] | null = null;
  /** The map last written. */
  private front = 0;
  private cloudKey = "";
  private fresh = 0;
  private reset = false;
  private tile = 0;
  private lastOffsetX = 0;
  private lastOffsetZ = 0;
  private lastRadius = 0;
  private disposed = false;

  /** Whether the map holds clouds to show. */
  showing = false;

  constructor(private readonly device: GPUDevice, private readonly tables: AtmosphereTables) {
    this.shape = volume(device, "sky cloud shape", SHAPE_SIZE, 7);
    this.detail = volume(device, "sky cloud detail", DETAIL_SIZE, 6);
    this.weather = device.createTexture({
      label: "sky cloud weather",
      size: [WEATHER_SIZE, WEATHER_SIZE],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    this.weatherView = this.weather.createView();
    this.tilingSampler = device.createSampler({
      label: "sky cloud tiling",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
      addressModeW: "repeat",
    });
    this.noiseStep = device.createBuffer({ label: "sky cloud noise step", size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.traceBuffer = device.createBuffer({ label: "sky cloud trace", size: TRACE_WORDS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** The clouds' map as last written, for the dome to read. */
  get view(): GPUTextureView | null {
    return this.mapViews ? this.mapViews[this.front] : null;
  }

  get texel(): number {
    return this.mapSize ? 1 / this.mapSize : 0.001;
  }

  /** The weather map is whole, and clouds can be drawn. */
  get ready(): boolean {
    return this.noiseDone && !!this.tracePipeline;
  }

  /** The weather map is whole: it can shade the land. */
  get weatherReady(): boolean {
    return this.noiseDone;
  }

  private workOnNoise(encoder: GPUCommandEncoder): void {
    const { device } = this;
    this.shapePipeline ??= this.makeNoisePipeline("shapeMain");
    this.detailPipeline ??= this.makeNoisePipeline("detailMain");
    const total = SHAPE_SIZE + DETAIL_SIZE;
    if (this.noiseSlice < total) {
      const inShape = this.noiseSlice < SHAPE_SIZE;
      const size = inShape ? SHAPE_SIZE : DETAIL_SIZE;
      const first = inShape ? this.noiseSlice : this.noiseSlice - SHAPE_SIZE;
      const count = Math.min(NOISE_SLICES_PER_FRAME, size - first);
      device.queue.writeBuffer(this.noiseStep, 0, new Uint32Array([first, size, 0, 0]));
      const pipeline = inShape ? this.shapePipeline : this.detailPipeline;
      const target = inShape ? this.shape : this.detail;
      const pass = encoder.beginComputePass({ label: "sky cloud noise" });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.noiseStep } },
          { binding: 1, resource: target.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
        ],
      }));
      pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8), count);
      pass.end();
      this.noiseSlice += count;
      return;
    }
    // All the slices drawn: the mips, and the weather map.
    const mipModule = device.createShaderModule({ label: "sky cloud noise mips", code: NOISE_MIP_WGSL });
    const mipPipeline = device.createComputePipeline({ label: "sky cloud noise mips", layout: "auto", compute: { module: mipModule, entryPoint: "mipMain" } });
    const weatherModule = device.createShaderModule({ label: "sky cloud weather", code: WEATHER_WGSL });
    const weatherPipeline = device.createComputePipeline({ label: "sky cloud weather", layout: "auto", compute: { module: weatherModule, entryPoint: "weatherMain" } });
    const pass = encoder.beginComputePass({ label: "sky cloud noise mips" });
    pass.setPipeline(mipPipeline);
    for (const [texture, size, mips] of [[this.shape, SHAPE_SIZE, 7], [this.detail, DETAIL_SIZE, 6]] as const) {
      for (let mip = 1; mip < mips; mip++) {
        pass.setBindGroup(0, device.createBindGroup({
          layout: mipPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: texture.createView({ baseMipLevel: mip - 1, mipLevelCount: 1 }) },
            { binding: 1, resource: texture.createView({ baseMipLevel: mip, mipLevelCount: 1 }) },
          ],
        }));
        const groups = Math.ceil((size >> mip) / 4);
        pass.dispatchWorkgroups(groups, groups, groups);
      }
    }
    pass.setPipeline(weatherPipeline);
    pass.setBindGroup(0, device.createBindGroup({
      layout: weatherPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: this.weatherView }],
    }));
    pass.dispatchWorkgroups(Math.ceil(WEATHER_SIZE / 8), Math.ceil(WEATHER_SIZE / 8));
    pass.end();
    this.noiseDone = true;
  }

  private makeNoisePipeline(entryPoint: string): GPUComputePipeline {
    const { device } = this;
    this.noiseModule ??= device.createShaderModule({ label: "sky cloud noise", code: NOISE_WGSL });
    return device.createComputePipeline({ label: `sky cloud ${entryPoint}`, layout: "auto", compute: { module: this.noiseModule, entryPoint } });
  }

  private noiseModule: GPUShaderModule | null = null;

  private compileTrace(): void {
    // A big shader: compiled in the background, so the editor does not stall on it.
    if (this.traceCompiling) return;
    this.traceCompiling = true;
    const module = this.device.createShaderModule({ label: "sky cloud trace", code: TRACE_WGSL });
    void this.device.createComputePipelineAsync({ label: "sky cloud trace", layout: "auto", compute: { module, entryPoint: "traceMain" } }).then((pipeline) => {
      if (!this.disposed) this.tracePipeline = pipeline;
    }, (error: unknown) => {
      console.error("[gpu] the clouds' shader failed", error);
    });
  }

  private ensureMaps(size: number): void {
    if (this.mapSize === size && this.maps) return;
    this.destroyMaps();
    const { device } = this;
    const make = (label: string) => device.createTexture({
      label,
      size: [size, size],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    this.maps = [make("sky cloud map a"), make("sky cloud map b")];
    this.mapViews = [this.maps[0].createView(), this.maps[1].createView()];
    this.mapSize = size;
    this.traceGroups = null;
    this.cloudKey = "";
  }

  private destroyMaps(): void {
    this.maps?.forEach((texture) => texture.destroy());
    this.maps = null;
    this.mapViews = null;
    this.traceGroups = null;
    this.mapSize = 0;
  }

  private groups(pipeline: GPUComputePipeline): [GPUBindGroup, GPUBindGroup] {
    if (this.traceGroups) return this.traceGroups;
    const { device, tables } = this;
    const views = this.mapViews!;
    const make = (read: number, write: number) => device.createBindGroup({
      label: "sky cloud trace",
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.traceBuffer } },
        { binding: 1, resource: this.shape.createView() },
        { binding: 2, resource: this.detail.createView() },
        { binding: 3, resource: this.weatherView },
        { binding: 4, resource: tables.transmittance.view },
        { binding: 5, resource: tables.skyView.view },
        { binding: 6, resource: views[read] },
        { binding: 7, resource: views[write] },
        { binding: 8, resource: this.tilingSampler },
        { binding: 9, resource: tables.clampSampler },
        { binding: 10, resource: tables.skyViewSampler },
      ],
    });
    // Index by the map written.
    this.traceGroups = [make(1, 0), make(0, 1)];
    return this.traceGroups;
  }

  /** Brings the clouds up to `frame`. Call once a frame, after the tables. */
  update(encoder: GPUCommandEncoder, frame: SkyFrame): void {
    const clouds = frame.clouds;
    const quality = clouds.quality;
    const volumetric = isVolumetric(quality);
    this.showing = volumetric && clouds.coverage > 0.005 && !!this.tracePipeline && this.noiseDone;
    if (!volumetric || clouds.coverage <= 0.005) {
      this.cloudKey = "";
      return;
    }
    if (!this.noiseDone) {
      this.workOnNoise(encoder);
      this.compileTrace();
      return;
    }
    this.compileTrace();
    const pipeline = this.tracePipeline;
    if (!pipeline) return;

    const map = CLOUD_MAPS[quality];
    this.ensureMaps(map.size);
    const key = [clouds.coverage.toFixed(3), clouds.base, clouds.depth, clouds.density, clouds.detail, clouds.scale, clouds.quality].join();
    if (key !== this.cloudKey) {
      if (this.cloudKey === "") this.reset = true;
      this.cloudKey = key;
      this.fresh = CLOUD_PASS;
    }

    const radius = this.tables.viewRadius;
    const data = this.traceData;
    const words = this.traceWords;
    data[0] = GROUND_RADIUS;
    data[1] = TOP_RADIUS;
    data[2] = radius;
    data[3] = clouds.keyStrength;
    data[4] = clouds.key.x;
    data[5] = clouds.key.y;
    data[6] = clouds.key.z;
    data[7] = cloudThreshold(clouds.coverage);
    data.set(clouds.ambient, 8);
    data[11] = CLOUD_EDGE;
    data.set(clouds.groundAmbient, 12);
    data[15] = WEATHER_TILES_PER_KM;
    data[16] = clouds.offsetX;
    data[17] = clouds.offsetZ;
    // A cloud stands at a place plus the offset: last frame the same cloud stood this much further along.
    data[18] = this.reset ? 0 : clouds.offsetX - this.lastOffsetX;
    data[19] = this.reset ? 0 : clouds.offsetZ - this.lastOffsetZ;
    data[20] = clouds.base;
    data[21] = clouds.depth;
    data[22] = clouds.density;
    data[23] = clouds.detail;
    data[24] = clouds.scale;
    data[25] = frame.skyScale[1] / Math.max(frame.cloudScale[1], 1e-6);
    data[26] = frame.skyGrey;
    // Every tile of a pass shares its noise: a phase per frame would leave the tiles different, as a fine grid.
    data[27] = (Math.floor(this.tile / TILES.length) % 64) * 0.61803398875;
    const tile = TILES[this.tile % TILES.length];
    words[28] = tile & 3;
    words[29] = tile >> 2;
    words[30] = map.steps;
    words[31] = this.reset ? 1 : 0;
    data[32] = this.fresh > 0 ? 1 : CLOUD_SETTLE_BLEND;
    data[33] = this.reset ? 0 : radius - this.lastRadius;
    this.device.queue.writeBuffer(this.traceBuffer, 0, data);
    this.tile += 1;
    if (this.fresh > 0) this.fresh -= 1;
    this.lastOffsetX = clouds.offsetX;
    this.lastOffsetZ = clouds.offsetZ;
    this.lastRadius = radius;
    this.reset = false;

    const write = 1 - this.front;
    const pass = encoder.beginComputePass({ label: "sky cloud trace" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.groups(pipeline)[write]);
    pass.dispatchWorkgroups(Math.ceil(map.size / 8), Math.ceil(map.size / 8));
    pass.end();
    this.front = write;
    this.showing = true;
  }

  dispose(): void {
    this.disposed = true;
    this.shape.destroy();
    this.detail.destroy();
    this.weather.destroy();
    this.noiseStep.destroy();
    this.traceBuffer.destroy();
    this.destroyMaps();
  }
}
