/**
 * THE POST STACK'S SHADERS
 *
 * Each step of the stack as compute, in the order they run: sunlit haze on the lit scene, then on the steady picture
 * depth of field, light shafts, motion blur, auto exposure, white balance and bloom, then edge smoothing when temporal
 * anti-aliasing is off. They do what the WebGL stack's effects do, number for number. uv here has y going down, as
 * texture coordinates do in WebGPU, and depth is reversed (1 near, 0 far); where the numbers below were written for
 * depth running the other way, the far end of it is one minus this depth.
 *
 * All of them read one uniform block, written once a frame. Each shader's bindings run from 0 in the order given to
 * the stack's dispatch.
 */

export const POST_UNIFORM_FLOATS = 128;

/** Where each field of the uniform block starts, in floats. */
export const POST_FIELD = {
  inverseProjection: 0,
  cameraWorld: 16,
  reprojection: 32,
  previousViewProjection: 48,
  inputSize: 64,
  outputSize: 66,
  jitter: 68,
  jitterUv: 70,
  blendFloor: 72,
  clipSpread: 74,
  depthToDistance: 76,
  perspective: 78,
  hasHistory: 79,
  contrastFade: 80,
  cameraStillness: 81,
  sharpness: 82,
  time: 83,
  sunDirection: 84,
  fogDensity: 87,
  sunColor: 88,
  hazeIntensity: 91,
  sunUv: 92,
  aspect: 94,
  shaftsIntensity: 95,
  shaftsTint: 96,
  delta: 99,
  balance: 100,
  bokehScale: 103,
  focusDistance: 104,
  focusRange: 105,
  cameraNear: 106,
  cameraFar: 107,
  reference: 108,
  response: 109,
  minExposure: 110,
  maxExposure: 111,
  compensation: 112,
  brighten: 113,
  darken: 114,
  firstMeasure: 115,
  bloomIntensity: 116,
  bloomThreshold: 117,
  bloomSmoothing: 118,
  bloomRadius: 119,
  blurStrength: 120,
  displayExposure: 121,
  lensDepthOfField: 122,
  lensShafts: 123,
  gradeExposure: 124,
  gradeBloom: 125,
} as const;

export const POST_WGSL = /* wgsl */ `
struct Post {
  // This view's camera with no jitter in it, in three.js's clip space (depth -1 to 1, y up).
  inverseProjection: mat4x4f,
  cameraWorld: mat4x4f,
  // From this frame's clip space, jitter left out, to the last frame's.
  reprojection: mat4x4f,
  previousViewProjection: mat4x4f,
  inputSize: vec2f,
  outputSize: vec2f,
  // The offset of this frame's samples, in drawn pixels and in uv, y down.
  jitter: vec2f,
  jitterUv: vec2f,
  // The newest frame's least share once a pixel has settled: at rest and in motion.
  blendFloor: vec2f,
  // How much of the colour box, in standard deviations, history may stay inside: at rest and in motion.
  clipSpread: vec2f,
  // From clip-space z to distance along the view: A and B of B / (z + A).
  depthToDistance: vec2f,
  perspective: f32,
  hasHistory: f32,
  contrastFade: f32,
  cameraStillness: f32,
  sharpness: f32,
  time: f32,
  sunDirection: vec3f,
  fogDensity: f32,
  sunColor: vec3f,
  hazeIntensity: f32,
  sunUv: vec2f,
  aspect: f32,
  shaftsIntensity: f32,
  shaftsTint: vec3f,
  delta: f32,
  balance: vec3f,
  bokehScale: f32,
  focusDistance: f32,
  focusRange: f32,
  cameraNear: f32,
  cameraFar: f32,
  reference: f32,
  response: f32,
  minExposure: f32,
  maxExposure: f32,
  compensation: f32,
  brighten: f32,
  darken: f32,
  firstMeasure: f32,
  bloomIntensity: f32,
  bloomThreshold: f32,
  bloomSmoothing: f32,
  bloomRadius: f32,
  blurStrength: f32,
  displayExposure: f32,
  lensDepthOfField: f32,
  lensShafts: f32,
  gradeExposure: f32,
  gradeBloom: f32,
  padding0: f32,
  padding1: f32,
}
`;

/** NaN and infinity by their bits, since a shader compiler may assume a comparison never meets them. */
export const SAFE_COLOUR_WGSL = /* wgsl */ `
fn safeColour(c: vec3f) -> vec3f {
  let exponent = bitcast<vec3u>(c) & vec3u(0x7f800000u);
  if (any(exponent == vec3u(0x7f800000u)) || any(c < vec3f(0.0))) { return vec3f(0.0); }
  return min(c, vec3f(1e4));
}
`;

/** This frame's depth at a place in the steady picture: where it lies with the frame's jitter in it. */
const DEPTH_AT_WGSL = /* wgsl */ `
fn depthAt(uv: vec2f) -> f32 {
  let at = vec2i(floor((uv + u.jitterUv) * u.inputSize));
  return textureLoad(depthMap, clamp(at, vec2i(0), vec2i(u.inputSize) - vec2i(1)), 0);
}
`;

// ---------------------------------------------------------------------------
// Sunlit haze

export const HAZE_WGSL = /* wgsl */ `
${POST_WGSL}
@group(0) @binding(0) var<uniform> u: Post;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var depthMap: texture_depth_2d;
@group(0) @binding(3) var writeTo: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(writeTo);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let at = vec2i(id.xy);
  let input = textureLoad(source, at, 0);
  let depth = textureLoad(depthMap, at, 0);
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let sky = depth <= 1e-5;
  let clipZ = 1.0 - 2.0 * max(depth, 1e-5);
  var viewPosition = u.inverseProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, clipZ, 1.0);
  viewPosition /= viewPosition.w;
  let ray = normalize((u.cameraWorld * vec4f(viewPosition.xyz, 0.0)).xyz);
  // How much fog lies along the ray (the scene's own exponential fog), the sky counting as far.
  let along = select(length(viewPosition.xyz), 400.0, sky);
  let thickness = u.fogDensity * along;
  let fog = 1.0 - exp(-thickness * thickness);
  // Light scattered toward the eye, strongly forward (Henyey-Greenstein, g = 0.7), plus a soft glow.
  let cosine = dot(ray, u.sunDirection);
  let g = 0.7;
  let phase = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosine, 1.5) * 0.006 + 0.004;
  let skyShare = select(1.0, 0.35, sky);
  textureStore(writeTo, id.xy, vec4f(input.rgb + u.sunColor * phase * fog * u.hazeIntensity * skyShare, input.a));
}
`;

// ---------------------------------------------------------------------------
// Light shafts

export const SHAFT_MASK_WGSL = /* wgsl */ `
${POST_WGSL}
@group(0) @binding(0) var<uniform> u: Post;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var depthMap: texture_depth_2d;
@group(0) @binding(3) var linearClamp: sampler;
@group(0) @binding(4) var writeTo: texture_storage_2d<rgba16float, write>;
${DEPTH_AT_WGSL}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(writeTo);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  // Only the open sky shines through, and only its glare around the sun: anything in front blocks the light.
  let sky = select(0.0, 1.0, depthAt(uv) <= 1e-5);
  let c = textureSampleLevel(source, linearClamp, uv, 0.0).rgb;
  let toSun = (uv - u.sunUv) * vec2f(u.aspect, 1.0);
  let near = exp(-dot(toSun, toSun) * 12.0);
  textureStore(writeTo, id.xy, vec4f(min(max(c - vec3f(0.8), vec3f(0.0)), vec3f(8.0)) * sky * near, 1.0));
}
`;

export const SHAFT_BLUR_WGSL = /* wgsl */ `
${POST_WGSL}
@group(0) @binding(0) var<uniform> u: Post;
@group(0) @binding(1) var mask: texture_2d<f32>;
@group(0) @binding(2) var linearClamp: sampler;
@group(0) @binding(3) var writeTo: texture_storage_2d<rgba16float, write>;

const DENSITY = 0.9;
const DECAY = 0.965;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(writeTo);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let stride = (uv - u.sunUv) * DENSITY / 64.0;
  var at = uv;
  var sum = vec3f(0.0);
  var weight = 1.0;
  for (var i = 0; i < 64; i++) {
    at -= stride;
    sum += textureSampleLevel(mask, linearClamp, at, 0.0).rgb * weight;
    weight *= DECAY;
  }
  textureStore(writeTo, id.xy, vec4f(sum / 64.0, 1.0));
}
`;

// ---------------------------------------------------------------------------
// Depth of field

export const COC_WGSL = /* wgsl */ `
${POST_WGSL}
@group(0) @binding(0) var<uniform> u: Post;
@group(0) @binding(1) var depthMap: texture_depth_2d;
@group(0) @binding(2) var writeTo: texture_storage_2d<rgba16float, write>;
${DEPTH_AT_WGSL}

// Depth as a share of the way from the near plane to the far one.
fn linearDepth(depth: f32) -> f32 {
  if (u.perspective < 0.5) { return 1.0 - depth; }
  let near = u.cameraNear;
  let far = u.cameraFar;
  let viewZ = -(near * far) / (near + (far - near) * depth);
  return clamp((viewZ + near) / (near - far), 0.0, 1.0);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(writeTo);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let signedDistance = linearDepth(depthAt(uv)) - u.focusDistance;
  let magnitude = smoothstep(0.0, max(u.focusRange, 1e-6), abs(signedDistance));
  // r in front of the focus, g behind it.
  let sides = vec2f(step(signedDistance, 0.0), step(0.0, signedDistance));
  textureStore(writeTo, id.xy, vec4f(magnitude * sides, 0.0, 1.0));
}
`;

/** One round of softening the near side's circle of confusion, so what is in front of the focus has a soft edge. */
export const KAWASE_WGSL = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linearClamp: sampler;
@group(0) @binding(2) var writeTo: texture_storage_2d<rgba16float, write>;

override KERNEL: f32 = 0.0;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(writeTo);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let texel = 1.0 / vec2f(size);
  let uv = (vec2f(id.xy) + 0.5) * texel;
  let reach = texel * KERNEL + texel * 0.5;
  let sum = textureSampleLevel(source, linearClamp, vec2f(uv.x - reach.x, uv.y + reach.y), 0.0)
    + textureSampleLevel(source, linearClamp, vec2f(uv.x + reach.x, uv.y + reach.y), 0.0)
    + textureSampleLevel(source, linearClamp, vec2f(uv.x + reach.x, uv.y - reach.y), 0.0)
    + textureSampleLevel(source, linearClamp, vec2f(uv.x - reach.x, uv.y - reach.y), 0.0);
  textureStore(writeTo, id.xy, sum * 0.25);
}
`;

/** Takes out what is in focus before the far side blurs, so sharp things do not bleed onto what lies behind them. */
export const DOF_MASK_WGSL = /* wgsl */ `
${POST_WGSL}
@group(0) @binding(0) var<uniform> u: Post;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var coc: texture_2d<f32>;
@group(0) @binding(3) var writeTo: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(writeTo);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let at = vec2i(id.xy);
  let strength = clamp(textureLoad(coc, at, 0).g * u.bokehScale, 0.0, 1.0);
  let input = textureLoad(source, at, 0);
  textureStore(writeTo, id.xy, vec4f(input.rgb * strength, input.a));
}
`;

const GOLDEN_ANGLE = 2.39996323;

/** Eighty points spiralling over a disc: one in five for filling the highlights, the rest for the blur. */
const bokehKernels = (): { blur: string[]; fill: string[] } => {
  const blur: string[] = [];
  const fill: string[] = [];
  const reach = Math.sqrt(80);
  for (let i = 0; i < 80; i++) {
    const angle = i * GOLDEN_ANGLE;
    const radius = Math.sqrt(i) / reach;
    const point = `vec2f(${(radius * Math.cos(angle)).toFixed(8)}, ${(radius * Math.sin(angle)).toFixed(8)})`;
    (i % 5 === 0 ? fill : blur).push(point);
  }
  return { blur, fill };
};

const KERNELS = bokehKernels();

/** The bokeh: a wide blur over the disc, then the brightest of a few taps to fill the holes between them. */
export const BOKEH_WGSL = /* wgsl */ `
${POST_WGSL}
@group(0) @binding(0) var<uniform> u: Post;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var coc: texture_2d<f32>;
@group(0) @binding(3) var linearClamp: sampler;
@group(0) @binding(4) var writeTo: texture_storage_2d<rgba16float, write>;

override FOREGROUND: bool = false;
override FILL: bool = false;

var<private> BLUR_KERNEL = array<vec2f, 64>(${KERNELS.blur.join(", ")});
var<private> FILL_KERNEL = array<vec2f, 16>(${KERNELS.fill.join(", ")});

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(writeTo);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let texel = 1.0 / vec2f(size);
  let uv = (vec2f(id.xy) + 0.5) * texel;
  let circle = textureLoad(coc, vec2i(id.xy), 0).rg * u.bokehScale;
  let own = select(circle.y, circle.x, FOREGROUND);
  if (own == 0.0) {
    textureStore(writeTo, id.xy, textureSampleLevel(source, linearClamp, uv, 0.0));
    return;
  }
  let stride = texel * select(circle.y, max(circle.x, circle.y), FOREGROUND);
  if (FILL) {
    var brightest = textureSampleLevel(source, linearClamp, uv, 0.0);
    for (var i = 0; i < 16; i++) {
      brightest = max(brightest, textureSampleLevel(source, linearClamp, uv + stride * FILL_KERNEL[i], 0.0));
    }
    textureStore(writeTo, id.xy, brightest);
  } else {
    var sum = vec4f(0.0);
    for (var i = 0; i < 64; i++) {
      sum += textureSampleLevel(source, linearClamp, uv + stride * BLUR_KERNEL[i], 0.0);
    }
    textureStore(writeTo, id.xy, sum / 64.0);
  }
}
`;

/** Depth of field and light shafts laid over the picture they were worked out from. */
export const LENS_WGSL = /* wgsl */ `
${POST_WGSL}
@group(0) @binding(0) var<uniform> u: Post;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var coc: texture_2d<f32>;
@group(0) @binding(3) var cocBlurred: texture_2d<f32>;
@group(0) @binding(4) var farColour: texture_2d<f32>;
@group(0) @binding(5) var nearColour: texture_2d<f32>;
@group(0) @binding(6) var shafts: texture_2d<f32>;
@group(0) @binding(7) var linearClamp: sampler;
@group(0) @binding(8) var writeTo: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(writeTo);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let at = vec2i(id.xy);
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let input = textureLoad(source, at, 0);
  var c = input.rgb;
  if (u.lensDepthOfField > 0.5) {
    let near = min(textureLoad(cocBlurred, at, 0).r * u.bokehScale, 1.0);
    let far = min(textureLoad(coc, at, 0).g * u.bokehScale, 1.0);
    c = c * (1.0 - far) + textureLoad(farColour, at, 0).rgb;
    c = mix(c, textureLoad(nearColour, at, 0).rgb, near);
  }
  if (u.lensShafts > 0.5) {
    c += textureSampleLevel(shafts, linearClamp, uv, 0.0).rgb * u.shaftsTint * u.shaftsIntensity;
  }
  textureStore(writeTo, id.xy, vec4f(c, input.a));
}
`;

// ---------------------------------------------------------------------------
// Motion blur

/** Each pixel's motion on screen since the last frame, from its depth and the camera's previous view, at half size. */
export const MOTION_VELOCITY_WGSL = /* wgsl */ `
${POST_WGSL}
@group(0) @binding(0) var<uniform> u: Post;
@group(0) @binding(1) var depthMap: texture_depth_2d;
@group(0) @binding(2) var writeTo: texture_storage_2d<rgba16float, write>;
${DEPTH_AT_WGSL}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(writeTo);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let clipZ = 1.0 - 2.0 * max(depthAt(uv), 1e-5);
  var viewPosition = u.inverseProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, clipZ, 1.0);
  viewPosition /= viewPosition.w;
  let before = u.previousViewProjection * (u.cameraWorld * vec4f(viewPosition.xyz, 1.0));
  let ndc = before.xy / before.w;
  var velocity = (uv - vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5)) * u.blurStrength;
  // What is close to the camera moves with it (the character it follows): spare it.
  velocity *= smoothstep(2.0, 6.0, -viewPosition.z);
  let speed = length(velocity);
  if (speed > 0.06) { velocity *= 0.06 / speed; }
  textureStore(writeTo, id.xy, vec4f(velocity, 0.0, 1.0));
}
`;

export const MOTION_BLUR_WGSL = /* wgsl */ `
${POST_WGSL}
@group(0) @binding(0) var<uniform> u: Post;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var velocityMap: texture_2d<f32>;
@group(0) @binding(3) var linearClamp: sampler;
@group(0) @binding(4) var writeTo: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(writeTo);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let input = textureLoad(source, vec2i(id.xy), 0);
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let velocity = textureSampleLevel(velocityMap, linearClamp, uv, 0.0).xy;
  if (length(velocity) < 0.0005) {
    textureStore(writeTo, id.xy, input);
    return;
  }
  let jitter = fract(sin(dot(uv * vec2f(size), vec2f(12.9898, 78.233)) + u.time) * 43758.5453);
  var sum = input.rgb;
  for (var i = 1; i <= 8; i++) {
    let t = (f32(i) + jitter) / 8.0 - 0.5;
    sum += textureSampleLevel(source, linearClamp, uv - velocity * t, 0.0).rgb;
  }
  textureStore(writeTo, id.xy, vec4f(sum / 9.0, input.a));
}
`;

// ---------------------------------------------------------------------------
// Auto exposure

/**
 * The scene's average brightness (log, centre-weighted) over a grid of cells, eased toward each frame. [0] holds the
 * adapted average and [1] the exposure it asks for. Nothing is read back.
 */
export const EXPOSURE_WGSL = /* wgsl */ `
${POST_WGSL}
${SAFE_COLOUR_WGSL}
@group(0) @binding(0) var<uniform> u: Post;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var linearClamp: sampler;
@group(0) @binding(3) var<storage, read_write> adapted: array<f32>;

const CELLS = 64;

fn tap(uv: vec2f) -> vec3f {
  return safeColour(textureSampleLevel(source, linearClamp, uv, 0.0).rgb);
}

@compute @workgroup_size(1)
fn main() {
  var total = vec2f(0.0);
  for (var y = 0; y < CELLS; y++) {
    for (var x = 0; x < CELLS; x++) {
      let uv = (vec2f(f32(x), f32(y)) + 0.5) / f32(CELLS);
      // Four taps a cell, so small bright things are not missed between samples.
      let o = 0.25 / f32(CELLS);
      let c = (tap(uv + vec2f(-o, -o)) + tap(uv + vec2f(o, -o)) + tap(uv + vec2f(-o, o)) + tap(uv + vec2f(o, o))) * 0.25;
      let luminance = dot(c, vec3f(0.2126, 0.7152, 0.0722));
      // Centre-weighted metering: the middle of the view counts most.
      let weight = 1.0 - 0.7 * smoothstep(0.1, 0.75, length(uv - vec2f(0.5)) * 1.4);
      total += vec2f(log(max(luminance, 1e-4)) * weight, weight);
    }
  }
  let current = exp(total.x / max(total.y, 1e-4));
  let before = select(adapted[0], current, u.firstMeasure > 0.5);
  // The eye takes longer to adjust to the dark than to glare.
  let rate = select(u.brighten, u.darken, current > before);
  let eased = before + (current - before) * (1.0 - exp(-u.delta * rate));
  adapted[0] = eased;
  let average = max(eased, 1e-4);
  adapted[1] = clamp(pow(u.reference / average, u.response), u.minExposure, u.maxExposure) * u.compensation;
}
`;

// ---------------------------------------------------------------------------
// Bloom

/** What is bright enough to glow. */
export const BLOOM_BRIGHT_WGSL = /* wgsl */ `
${POST_WGSL}
${SAFE_COLOUR_WGSL}
@group(0) @binding(0) var<uniform> u: Post;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var writeTo: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(writeTo);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let c = safeColour(textureLoad(source, vec2i(id.xy), 0).rgb);
  let luminance = dot(c, vec3f(0.2126729, 0.7151522, 0.0721750));
  let bright = smoothstep(u.bloomThreshold, u.bloomThreshold + max(u.bloomSmoothing, 1e-5), luminance) * luminance;
  textureStore(writeTo, id.xy, vec4f(c * clamp(bright, 0.0, 1.0), bright));
}
`;

/** Thirteen taps down a level, those past the picture's edge counting for nothing. */
export const BLOOM_DOWN_WGSL = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linearClamp: sampler;
@group(0) @binding(2) var writeTo: texture_storage_2d<rgba16float, write>;

const WEIGHT_INNER = 0.125;
const WEIGHT_OUTER = 0.0555555;

fn tap(uv: vec2f, offset: vec2f, weight: f32) -> vec4f {
  let at = uv + offset;
  if (at.x < 0.0 || at.x > 1.0 || at.y < 0.0 || at.y > 1.0) { return vec4f(0.0); }
  return textureSampleLevel(source, linearClamp, at, 0.0) * weight;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(writeTo);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let t = 1.0 / vec2f(textureDimensions(source));
  var c = tap(uv, t * vec2f(-1.0, 1.0), WEIGHT_INNER)
    + tap(uv, t * vec2f(1.0, 1.0), WEIGHT_INNER)
    + tap(uv, t * vec2f(-1.0, -1.0), WEIGHT_INNER)
    + tap(uv, t * vec2f(1.0, -1.0), WEIGHT_INNER);
  c += tap(uv, t * vec2f(-2.0, 2.0), WEIGHT_OUTER)
    + tap(uv, t * vec2f(0.0, 2.0), WEIGHT_OUTER)
    + tap(uv, t * vec2f(2.0, 2.0), WEIGHT_OUTER)
    + tap(uv, t * vec2f(-2.0, 0.0), WEIGHT_OUTER);
  c += tap(uv, t * vec2f(2.0, 0.0), WEIGHT_OUTER)
    + tap(uv, t * vec2f(-2.0, -2.0), WEIGHT_OUTER)
    + tap(uv, t * vec2f(0.0, -2.0), WEIGHT_OUTER)
    + tap(uv, t * vec2f(2.0, -2.0), WEIGHT_OUTER);
  c += textureSampleLevel(source, linearClamp, uv, 0.0) * WEIGHT_OUTER;
  textureStore(writeTo, id.xy, c);
}
`;

/** A tent over the level below, mixed with the same level on the way down by the blur's radius. */
export const BLOOM_UP_WGSL = /* wgsl */ `
${POST_WGSL}
@group(0) @binding(0) var<uniform> u: Post;
@group(0) @binding(1) var lower: texture_2d<f32>;
@group(0) @binding(2) var support: texture_2d<f32>;
@group(0) @binding(3) var linearClamp: sampler;
@group(0) @binding(4) var writeTo: texture_storage_2d<rgba16float, write>;

fn tap(uv: vec2f, weight: f32) -> vec4f {
  return textureSampleLevel(lower, linearClamp, uv, 0.0) * weight;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(writeTo);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let t = 1.0 / vec2f(textureDimensions(lower));
  let c = tap(uv + t * vec2f(-1.0, 1.0), 0.0625)
    + tap(uv + t * vec2f(0.0, 1.0), 0.125)
    + tap(uv + t * vec2f(1.0, 1.0), 0.0625)
    + tap(uv + t * vec2f(-1.0, 0.0), 0.125)
    + tap(uv, 0.25)
    + tap(uv + t * vec2f(1.0, 0.0), 0.125)
    + tap(uv + t * vec2f(-1.0, -1.0), 0.0625)
    + tap(uv + t * vec2f(0.0, -1.0), 0.125)
    + tap(uv + t * vec2f(1.0, -1.0), 0.0625);
  let base = textureSampleLevel(support, linearClamp, uv, 0.0);
  textureStore(writeTo, id.xy, mix(base, c, u.bloomRadius));
}
`;

// ---------------------------------------------------------------------------
// Exposure, white balance and bloom laid over the picture

export const GRADE_WGSL = /* wgsl */ `
${POST_WGSL}
@group(0) @binding(0) var<uniform> u: Post;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var bloom: texture_2d<f32>;
@group(0) @binding(3) var linearClamp: sampler;
@group(0) @binding(4) var<storage, read> adapted: array<f32>;
@group(0) @binding(5) var writeTo: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(writeTo);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let input = textureLoad(source, vec2i(id.xy), 0);
  var c = input.rgb;
  if (u.gradeExposure > 0.5) { c *= adapted[1]; }
  c *= u.balance;
  if (u.gradeBloom > 0.5) {
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
    let glow = textureSampleLevel(bloom, linearClamp, uv, 0.0).rgb * u.bloomIntensity;
    // Screen, in HDR values as the WebGL stack has it.
    c = c + glow - min(c * glow, vec3f(1.0));
  }
  textureStore(writeTo, id.xy, vec4f(c, input.a));
}
`;

// ---------------------------------------------------------------------------
// Edge smoothing, when temporal anti-aliasing is off

const DISPLAY_COMPRESSION_WGSL = /* wgsl */ `
fn compressColour(c: vec3f) -> vec3f { return c / (1.0 + max(c.r, max(c.g, c.b))); }
fn expandColour(c: vec3f) -> vec3f { return c / max(1.0 - max(c.r, max(c.g, c.b)), 1e-3); }
`;

/**
 * The picture as the eye will take it: edges are found and blended on values the tone curve has as good as settled,
 * so a very bright pixel cannot outweigh its neighbours and leave its edge stepped. Brightness goes in alpha.
 */
export const FXAA_PREPARE_WGSL = /* wgsl */ `
${POST_WGSL}
${SAFE_COLOUR_WGSL}
${DISPLAY_COMPRESSION_WGSL}
@group(0) @binding(0) var<uniform> u: Post;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var writeTo: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(writeTo);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let c = compressColour(safeColour(textureLoad(source, vec2i(id.xy), 0).rgb) * u.displayExposure);
  textureStore(writeTo, id.xy, vec4f(c, sqrt(dot(c, vec3f(0.2126729, 0.7151522, 0.0721750)))));
}
`;

export const FXAA_WGSL = /* wgsl */ `
${POST_WGSL}
${DISPLAY_COMPRESSION_WGSL}
@group(0) @binding(0) var<uniform> u: Post;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var linearClamp: sampler;
@group(0) @binding(3) var writeTo: texture_storage_2d<rgba16float, write>;

const EDGE_THRESHOLD_MIN = 0.0312;
const EDGE_THRESHOLD_MAX = 0.125;
const SUBPIXEL_QUALITY = 0.75;
const SAMPLES = 12;

fn quality(q: i32) -> f32 {
  if (q < 5) { return 1.0; }
  if (q == 5) { return 1.5; }
  if (q < 10) { return 2.0; }
  if (q < 11) { return 4.0; }
  return 8.0;
}

fn lumaAt(uv: vec2f) -> f32 {
  return textureSampleLevel(source, linearClamp, uv, 0.0).a;
}

fn finish(id: vec2u, c: vec3f) {
  textureStore(writeTo, id, vec4f(expandColour(c) / max(u.displayExposure, 1e-4), 1.0));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(writeTo);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let texel = 1.0 / vec2f(size);
  let uv = (vec2f(id.xy) + 0.5) * texel;
  let centre = textureSampleLevel(source, linearClamp, uv, 0.0);
  let lumaCenter = centre.a;
  let lumaDown = lumaAt(uv + vec2f(0.0, -1.0) * texel);
  let lumaUp = lumaAt(uv + vec2f(0.0, 1.0) * texel);
  let lumaLeft = lumaAt(uv + vec2f(-1.0, 0.0) * texel);
  let lumaRight = lumaAt(uv + vec2f(1.0, 0.0) * texel);
  let lumaMin = min(lumaCenter, min(min(lumaDown, lumaUp), min(lumaLeft, lumaRight)));
  let lumaMax = max(lumaCenter, max(max(lumaDown, lumaUp), max(lumaLeft, lumaRight)));
  let lumaRange = lumaMax - lumaMin;
  if (lumaRange < max(EDGE_THRESHOLD_MIN, lumaMax * EDGE_THRESHOLD_MAX)) {
    finish(id.xy, centre.rgb);
    return;
  }
  let lumaDownLeft = lumaAt(uv + vec2f(-1.0, -1.0) * texel);
  let lumaUpRight = lumaAt(uv + vec2f(1.0, 1.0) * texel);
  let lumaUpLeft = lumaAt(uv + vec2f(-1.0, 1.0) * texel);
  let lumaDownRight = lumaAt(uv + vec2f(1.0, -1.0) * texel);
  let lumaDownUp = lumaDown + lumaUp;
  let lumaLeftRight = lumaLeft + lumaRight;
  let lumaLeftCorners = lumaDownLeft + lumaUpLeft;
  let lumaDownCorners = lumaDownLeft + lumaDownRight;
  let lumaRightCorners = lumaDownRight + lumaUpRight;
  let lumaUpCorners = lumaUpRight + lumaUpLeft;
  let edgeHorizontal = abs(-2.0 * lumaLeft + lumaLeftCorners) + abs(-2.0 * lumaCenter + lumaDownUp) * 2.0 + abs(-2.0 * lumaRight + lumaRightCorners);
  let edgeVertical = abs(-2.0 * lumaUp + lumaUpCorners) + abs(-2.0 * lumaCenter + lumaLeftRight) * 2.0 + abs(-2.0 * lumaDown + lumaDownCorners);
  let isHorizontal = edgeHorizontal >= edgeVertical;
  var stepLength = select(texel.x, texel.y, isHorizontal);
  let luma1 = select(lumaLeft, lumaDown, isHorizontal);
  let luma2 = select(lumaRight, lumaUp, isHorizontal);
  let gradient1 = abs(luma1 - lumaCenter);
  let gradient2 = abs(luma2 - lumaCenter);
  let is1Steepest = gradient1 >= gradient2;
  let gradientScaled = 0.25 * max(gradient1, gradient2);
  var lumaLocalAverage = 0.5 * (luma2 + lumaCenter);
  if (is1Steepest) {
    stepLength = -stepLength;
    lumaLocalAverage = 0.5 * (luma1 + lumaCenter);
  }
  var currentUv = uv;
  if (isHorizontal) { currentUv.y += stepLength * 0.5; } else { currentUv.x += stepLength * 0.5; }
  let offset = select(vec2f(0.0, texel.y), vec2f(texel.x, 0.0), isHorizontal);
  var uv1 = currentUv - offset * quality(0);
  var uv2 = currentUv + offset * quality(0);
  var lumaEnd1 = lumaAt(uv1) - lumaLocalAverage;
  var lumaEnd2 = lumaAt(uv2) - lumaLocalAverage;
  var reached1 = abs(lumaEnd1) >= gradientScaled;
  var reached2 = abs(lumaEnd2) >= gradientScaled;
  var reachedBoth = reached1 && reached2;
  if (!reached1) { uv1 -= offset * quality(1); }
  if (!reached2) { uv2 += offset * quality(1); }
  if (!reachedBoth) {
    for (var i = 2; i < SAMPLES; i++) {
      if (!reached1) { lumaEnd1 = lumaAt(uv1) - lumaLocalAverage; }
      if (!reached2) { lumaEnd2 = lumaAt(uv2) - lumaLocalAverage; }
      reached1 = abs(lumaEnd1) >= gradientScaled;
      reached2 = abs(lumaEnd2) >= gradientScaled;
      reachedBoth = reached1 && reached2;
      if (!reached1) { uv1 -= offset * quality(i); }
      if (!reached2) { uv2 += offset * quality(i); }
      if (reachedBoth) { break; }
    }
  }
  let distance1 = select(uv.y - uv1.y, uv.x - uv1.x, isHorizontal);
  let distance2 = select(uv2.y - uv.y, uv2.x - uv.x, isHorizontal);
  let isDirection1 = distance1 < distance2;
  let distanceFinal = min(distance1, distance2);
  let edgeThickness = distance1 + distance2;
  let isLumaCenterSmaller = lumaCenter < lumaLocalAverage;
  let correctVariation1 = (lumaEnd1 < 0.0) != isLumaCenterSmaller;
  let correctVariation2 = (lumaEnd2 < 0.0) != isLumaCenterSmaller;
  let correctVariation = select(correctVariation2, correctVariation1, isDirection1);
  let pixelOffset = -distanceFinal / edgeThickness + 0.5;
  var finalOffset = select(0.0, pixelOffset, correctVariation);
  let lumaAverage = (1.0 / 12.0) * (2.0 * (lumaDownUp + lumaLeftRight) + lumaLeftCorners + lumaRightCorners);
  let subPixelOffset1 = clamp(abs(lumaAverage - lumaCenter) / lumaRange, 0.0, 1.0);
  let subPixelOffset2 = (-2.0 * subPixelOffset1 + 3.0) * subPixelOffset1 * subPixelOffset1;
  let subPixelOffsetFinal = subPixelOffset2 * subPixelOffset2 * SUBPIXEL_QUALITY;
  finalOffset = max(finalOffset, subPixelOffsetFinal);
  var finalUv = uv;
  if (isHorizontal) { finalUv.y += finalOffset * stepLength; } else { finalUv.x += finalOffset * stepLength; }
  finish(id.xy, textureSampleLevel(source, linearClamp, finalUv, 0.0).rgb);
}
`;
