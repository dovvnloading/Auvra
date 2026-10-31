import { CAMERA_BINDINGS_WGSL, VIEW_WGSL } from "../shaders";

/**
 * SCREEN LIGHTING SHADERS
 *
 * The compute programs behind screenPasses.ts, each with the bindings it declares written beside it. Group 0 is the
 * frame's view; group 1 is the program's own, and binding 0 there is always the settings (ScreenParams).
 *
 * Half-size textures hold a value and the pixel's distance from the camera in alpha, with 0 where there is no surface:
 * that distance is how later steps tell which surface a value belongs to.
 */

export const SCREEN_WORKGROUP = 8;

export type ScreenBinding = Omit<GPUBindGroupLayoutEntry, "binding" | "visibility">;

export interface ScreenProgram {
  code: string;
  /** Binding 0 is this list's first entry, and so on. */
  bindings: readonly ScreenBinding[];
  entryPoint?: string;
  constants?: Record<string, number>;
}

const PARAMS: ScreenBinding = { buffer: { type: "uniform" } };
const DEPTH: ScreenBinding = { texture: { sampleType: "depth" } };
const LOAD: ScreenBinding = { texture: { sampleType: "unfilterable-float" } };
const FILTERED: ScreenBinding = { texture: { sampleType: "float" } };
const CUBE: ScreenBinding = { texture: { sampleType: "float", viewDimension: "cube" } };
const LINEAR: ScreenBinding = { sampler: { type: "filtering" } };
const WRITE_HDR: ScreenBinding = { storageTexture: { access: "write-only", format: "rgba16float" } };
const WRITE_BYTES: ScreenBinding = { storageTexture: { access: "write-only", format: "rgba8unorm" } };
const WRITE_DEPTH: ScreenBinding = { storageTexture: { access: "write-only", format: "r32float" } };

/** Written by writeParams in screenPasses.ts, word for word. */
export const SCREEN_PARAM_WORDS = 72;

const COMMON_WGSL = /* wgsl */ `
${VIEW_WGSL}
${CAMERA_BINDINGS_WGSL}

struct ScreenParams {
  // xyz: toward the sun. w: 1 when there is one.
  sun: vec4f,
  ambient: vec4f,
  hemiSky: vec4f,
  hemiGround: vec4f,
  // The environment's light as nine spherical harmonic coefficients, at this frame's strength.
  sh: array<vec4f, 9>,
  // radius, falloff, intensity (0 off), contact shadow length (0 off)
  occlusion: vec4f,
  // bounce radius, bounce strength, reflection distance, reflection strength
  light: vec4f,
  // frame 0 to 63, 1 when last frame's lit picture exists, 1 when occlusion has history, 1 when bounce has history
  state: vec4f,
  // environment intensity, environment mip levels (0 none), what to show (0 all, 1 bounce, 2 reflections), 1 when the depth pyramid exists
  extra: vec4f,
  // 1 when gathered light takes the place of the ambient lights; the rest unused
  flags: vec4f,
}

@group(1) @binding(0) var<uniform> params: ScreenParams;

const PI = 3.14159265;
const TAU = 6.28318531;

// Interleaved gradient noise: well spread from pixel to pixel.
fn noiseAt(pixel: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(pixel, vec2f(0.06711056, 0.00583715))));
}

fn decodeNormal(e: vec2f) -> vec3f {
  var n = vec3f(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  if (n.z < 0.0) {
    let flipped = (vec2f(1.0) - abs(n.yx)) * select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0));
    n = vec3f(flipped, n.z);
  }
  return normalize(n);
}

fn worldAt(uv: vec2f, depth: f32) -> vec3f {
  let at = view.inverseViewProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  return at.xyz / at.w;
}

// How far in front of the camera a depth lies, along the way it looks.
fn distanceOf(depth: f32) -> f32 {
  let m = view.inverseProjection;
  return -(m[2][2] * depth + m[3][2]) / (m[2][3] * depth + m[3][3]);
}

// A world point's uv and depth.
fn project(world: vec3f) -> vec3f {
  let clip = view.viewProjection * vec4f(world, 1.0);
  let at = clip.xyz / clip.w;
  return vec3f(at.x * 0.5 + 0.5, 0.5 - at.y * 0.5, at.z);
}

fn onScreen(uv: vec2f) -> bool {
  return uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0;
}

fn pixelOf(uv: vec2f) -> vec2i {
  return clamp(vec2i(uv * view.size.xy), vec2i(0), vec2i(view.size.xy) - vec2i(1));
}

fn uvOfPixel(pixel: vec2i) -> vec2f {
  return (vec2f(pixel) + 0.5) * view.size.zw;
}
`;

// The environment's reflection from a direction, read just as lighting reads it, so that the two can be compared.
const ENVIRONMENT_WGSL = (texture: number, sampler: number): string => /* wgsl */ `
@group(1) @binding(${texture}) var environmentTexture: texture_cube<f32>;
@group(1) @binding(${sampler}) var linearSampler: sampler;

// Lighting's own limit on how smooth a surface is.
fn lightingRoughness(roughness: f32) -> f32 {
  return clamp(roughness, 0.0525, 1.0);
}

// Leaning a rough surface's reflection toward its normal, as lighting does.
fn reflectionDirection(toEye: vec3f, normal: vec3f, roughness: f32) -> vec3f {
  return normalize(mix(reflect(-toEye, normal), normal, roughness * roughness));
}

fn environmentFrom(direction: vec3f, roughness: f32) -> vec3f {
  if (params.extra.y < 0.5) { return vec3f(0.0); }
  return textureSampleLevel(environmentTexture, linearSampler, direction, roughness * (params.extra.y - 1.0)).rgb * params.extra.x;
}
`;

// --- THE NEAREST-DEPTH CHAIN ---

/*
 * The surface pass's depth pyramid holds the farthest depth of each patch, which says when a ray has gone behind
 * everything there. Stepping over a patch the ray is in front of takes the nearest depth instead: the farthest cannot
 * promise that no nearer surface stands in the way. So tracing keeps a second chain with the same footprints, whose
 * level L is this texture's mip L - 1, as level 0 would only be the depth target over again.
 */
const NEAREST_WGSL = /* wgsl */ `
@group(1) @binding(1) var depthSource: texture_depth_2d;
@group(1) @binding(2) var levelSource: texture_2d<f32>;
@group(1) @binding(3) var levelOut: texture_storage_2d<r32float, write>;

// Where the level above is odd, a third column or row: every texel covers all of its part of the screen.
@compute @workgroup_size(${SCREEN_WORKGROUP}, ${SCREEN_WORKGROUP}) fn fromDepth(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(levelOut))) { return; }
  let above = textureDimensions(depthSource);
  let last = above - vec2u(1u);
  let extra = above % vec2u(2u);
  var nearest = 0.0;
  for (var y = 0u; y < 2u + extra.y; y++) {
    for (var x = 0u; x < 2u + extra.x; x++) {
      nearest = max(nearest, textureLoad(depthSource, min(id.xy * 2u + vec2u(x, y), last), 0));
    }
  }
  textureStore(levelOut, id.xy, vec4f(nearest, 0.0, 0.0, 1.0));
}

@compute @workgroup_size(${SCREEN_WORKGROUP}, ${SCREEN_WORKGROUP}) fn fromLevel(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(levelOut))) { return; }
  let above = textureDimensions(levelSource);
  let last = above - vec2u(1u);
  let extra = above % vec2u(2u);
  var nearest = 0.0;
  for (var y = 0u; y < 2u + extra.y; y++) {
    for (var x = 0u; x < 2u + extra.x; x++) {
      nearest = max(nearest, textureLoad(levelSource, min(id.xy * 2u + vec2u(x, y), last), 0).r);
    }
  }
  textureStore(levelOut, id.xy, vec4f(nearest, 0.0, 0.0, 1.0));
}
`;

// --- OCCLUSION AND CONTACT SHADOWS ---

const OCCLUSION_SAMPLES = 16;

/** A spiral over a disc lifted onto the hemisphere: more samples toward the rim, where a surface loses its view first. */
const hemisphereSamples = (count: number): string => {
  const points: string[] = [];
  for (let k = 0; k < count; k++) {
    const theta = 2.399963 * k;
    const r = Math.sqrt(k + 0.5) / Math.sqrt(count);
    const x = r * Math.cos(theta);
    const y = r * Math.sin(theta);
    points.push(`vec3f(${x.toFixed(6)}, ${y.toFixed(6)}, ${Math.sqrt(1 - x * x - y * y).toFixed(6)})`);
  }
  return points.join(", ");
};

const DENOISE_SAMPLES = 8;
const DENOISE_RINGS = 11;
/** Half-size texels: twelve at full size. */
const DENOISE_RADIUS = 6;

/** A disc walked in a spiral. */
const diskSamples = (count: number, rings: number): string => {
  const points: string[] = [];
  for (let i = 0; i < count; i++) {
    const angle = ((2 * Math.PI * rings) / count) * i;
    const r = ((i + 1) / count) ** 0.75;
    points.push(`vec2f(${(Math.cos(angle) * r).toFixed(6)}, ${(Math.sin(angle) * r).toFixed(6)})`);
  }
  return points.join(", ");
};

// Each half-size pixel: how much of the hemisphere around it the depth blocks, and whether the way toward the sun is
// blocked close by. Output: occlusion (1 open), sun (1 reaches), 0, distance.
const OCCLUSION_TRACE_WGSL = /* wgsl */ `
@group(1) @binding(1) var depthTexture: texture_depth_2d;
@group(1) @binding(2) var output: texture_storage_2d<rgba16float, write>;

const HEMISPHERE = array<vec3f, ${OCCLUSION_SAMPLES}>(${hemisphereSamples(OCCLUSION_SAMPLES)});
const CONTACT_STEPS = 10;

fn depthAt(pixel: vec2i) -> f32 {
  return textureLoad(depthTexture, clamp(pixel, vec2i(0), vec2i(view.size.xy) - vec2i(1)), 0);
}

fn worldAtPixel(pixel: vec2i, depth: f32) -> vec3f {
  return worldAt(uvOfPixel(pixel), depth);
}

// The surface's true facing, from depth: normal maps would have it occlude itself. On each axis the side whose slope
// runs on evenly, so that an edge does not bend it.
fn normalFromDepth(pixel: vec2i, depth: f32, world: vec3f) -> vec3f {
  let l1 = depthAt(pixel - vec2i(1, 0));
  let l2 = depthAt(pixel - vec2i(2, 0));
  let r1 = depthAt(pixel + vec2i(1, 0));
  let r2 = depthAt(pixel + vec2i(2, 0));
  let b1 = depthAt(pixel - vec2i(0, 1));
  let b2 = depthAt(pixel - vec2i(0, 2));
  let t1 = depthAt(pixel + vec2i(0, 1));
  let t2 = depthAt(pixel + vec2i(0, 2));
  var dx: vec3f;
  if (abs(2.0 * l1 - l2 - depth) < abs(2.0 * r1 - r2 - depth)) {
    dx = world - worldAtPixel(pixel - vec2i(1, 0), l1);
  } else {
    dx = worldAtPixel(pixel + vec2i(1, 0), r1) - world;
  }
  var dy: vec3f;
  if (abs(2.0 * b1 - b2 - depth) < abs(2.0 * t1 - t2 - depth)) {
    dy = world - worldAtPixel(pixel - vec2i(0, 1), b1);
  } else {
    dy = worldAtPixel(pixel + vec2i(0, 1), t1) - world;
  }
  let across = cross(dx, dy);
  let toEye = view.eye.xyz - world;
  if (dot(across, across) <= 1e-24) { return normalize(toEye); }
  let n = normalize(across);
  return select(n, -n, dot(n, toEye) < 0.0);
}

fn occlusionAt(pixel: vec2i, depth: f32, world: vec3f, normal: vec3f, n0: f32, n1: f32) -> f32 {
  let radius = params.occlusion.x;
  let falloff = params.occlusion.y;
  let helper = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), normal.y > 0.99);
  let tangent = normalize(cross(helper, normal));
  let bitangent = cross(normal, tangent);
  let angle = n0 * TAU;
  let c = cos(angle);
  let s = sin(angle);
  var occluded = 0.0;
  var total = 0.0;
  var along = n1;
  for (var i = 0; i < ${OCCLUSION_SAMPLES}; i++) {
    let h = HEMISPHERE[i];
    let direction = tangent * (c * h.x - s * h.y) + bitangent * (s * h.x + c * h.y) + normal * h.z;
    let amount = fract(along);
    along += ${(1 / OCCLUSION_SAMPLES).toFixed(6)};
    let q = project(world + direction * (radius * amount));
    if (!all(q * (vec3f(1.0) - q) > vec3f(0.0))) { continue; }
    total += 1.0;
    let at = pixelOf(q.xy);
    if (all(at == pixel)) { continue; }
    let found = textureLoad(depthTexture, at, 0);
    if (found == depth) { continue; }
    let surface = distanceOf(found);
    let point = distanceOf(q.z);
    if (surface < point) {
      occluded += smoothstep(0.0, 1.0, falloff / max(point - surface, 1e-5));
    }
  }
  return clamp(1.0 - occluded / max(total, 1.0), 0.0, 1.0);
}

// A short walk toward the sun through the depth: what shadow maps are too coarse to see where things touch.
fn contactAt(world: vec3f, normal: vec3f, distance: f32, jitter: f32) -> f32 {
  let reach = params.occlusion.w;
  if (reach <= 0.0 || params.sun.w < 0.5) { return 1.0; }
  let toSun = params.sun.xyz;
  if (dot(normal, toSun) <= 0.0) { return 1.0; }
  // Under a pixel or two on screen there is nothing to find.
  if (view.params.y > 0.0 && view.params.y * reach / distance < 1.5) { return 1.0; }
  let origin = world + normal * (0.005 + distance * 0.002);
  for (var i = 0; i < CONTACT_STEPS; i++) {
    let t = reach * (f32(i) + jitter) / f32(CONTACT_STEPS);
    let q = project(origin + toSun * t);
    if (!all(q * (vec3f(1.0) - q) > vec3f(0.0))) { break; }
    let behind = distanceOf(q.z) - distanceOf(textureLoad(depthTexture, pixelOf(q.xy), 0));
    // In front of the ray point and not so far that the ray has only passed behind something.
    if (behind > 0.0 && behind < 0.03 + t * 0.5) {
      return smoothstep(0.6, 1.0, t / reach);
    }
  }
  return 1.0;
}

@compute @workgroup_size(${SCREEN_WORKGROUP}, ${SCREEN_WORKGROUP}) fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(output);
  if (any(id.xy >= dims)) { return; }
  let pixel = pixelOf((vec2f(id.xy) + 0.5) / vec2f(dims));
  let depth = textureLoad(depthTexture, pixel, 0);
  if (depth <= 0.0) {
    textureStore(output, id.xy, vec4f(1.0, 1.0, 0.0, 0.0));
    return;
  }
  let world = worldAtPixel(pixel, depth);
  let normal = normalFromDepth(pixel, depth, world);
  let distance = distanceOf(depth);
  let at = vec2f(id.xy);
  let n0 = noiseAt(at + params.state.x * 5.588238);
  let n1 = noiseAt(at * 1.37 + params.state.x * 3.1416 + 17.0);
  var open = 1.0;
  if (params.occlusion.z > 0.0) { open = occlusionAt(pixel, depth, world, normal, n0, n1); }
  textureStore(output, id.xy, vec4f(open, contactAt(world, normal, distance, n1), 0.0, distance));
}
`;

// Eases each pixel over frames from where the same surface was last frame; alpha's distance turns away what is not.
// Output as the trace's, with the frames gathered in blue, so that a newly seen pixel settles fast.
const OCCLUSION_TEMPORAL_WGSL = /* wgsl */ `
@group(1) @binding(1) var depthTexture: texture_depth_2d;
@group(1) @binding(2) var motionTexture: texture_2d<f32>;
@group(1) @binding(3) var currentTexture: texture_2d<f32>;
@group(1) @binding(4) var historyTexture: texture_2d<f32>;
@group(1) @binding(5) var output: texture_storage_2d<rgba16float, write>;

const MOST_FRAMES = 10.0;

@compute @workgroup_size(${SCREEN_WORKGROUP}, ${SCREEN_WORKGROUP}) fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(output);
  if (any(id.xy >= dims)) { return; }
  let now = textureLoad(currentTexture, id.xy, 0);
  if (now.a <= 0.0) {
    textureStore(output, id.xy, now);
    return;
  }
  var result = now.rg;
  var frames = 1.0;
  if (params.state.z > 0.5) {
    let pixel = pixelOf((vec2f(id.xy) + 0.5) / vec2f(dims));
    let uv = uvOfPixel(pixel);
    let before = uv + textureLoad(motionTexture, pixel, 0).xy;
    if (onScreen(before)) {
      let clip = view.previousViewProjection * vec4f(worldAt(uv, textureLoad(depthTexture, pixel, 0)), 1.0);
      let expected = select(clip.w, now.a, view.orthographic != 0u);
      let past = textureLoad(historyTexture, vec2i(before * vec2f(dims)), 0);
      if (past.a > 0.0 && abs(past.a - expected) < expected * 0.06 + 0.02) {
        frames = min(past.b + 1.0, MOST_FRAMES);
        result = mix(past.rg, now.rg, 1.0 / frames);
      }
    }
  }
  textureStore(output, id.xy, vec4f(result, frames, now.a));
}
`;

// One round of the denoise: a turned disc of neighbours counted by how near they lie to this surface's plane and how
// alike they face. The sun's channel keeps closer in, as a contact shadow's edge is what it is for.
const OCCLUSION_BLUR_WGSL = /* wgsl */ `
@group(1) @binding(1) var depthTexture: texture_depth_2d;
@group(1) @binding(2) var normalTexture: texture_2d<f32>;
@group(1) @binding(3) var source: texture_2d<f32>;
@group(1) @binding(4) var output: texture_storage_2d<rgba16float, write>;

override blurRound: f32 = 0.0;

const DISK = array<vec2f, ${DENOISE_SAMPLES}>(${diskSamples(DENOISE_SAMPLES, DENOISE_RINGS)});

@compute @workgroup_size(${SCREEN_WORKGROUP}, ${SCREEN_WORKGROUP}) fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(output);
  if (any(id.xy >= dims)) { return; }
  let centre = textureLoad(source, id.xy, 0);
  if (centre.a <= 0.0) {
    textureStore(output, id.xy, centre);
    return;
  }
  let half = vec2f(dims);
  let pixel = pixelOf((vec2f(id.xy) + 0.5) / half);
  let world = worldAt(uvOfPixel(pixel), textureLoad(depthTexture, pixel, 0));
  let normal = decodeNormal(textureLoad(normalTexture, pixel, 0).xy);
  let angle = noiseAt(vec2f(id.xy) + blurRound * 7.31) * TAU;
  let c = cos(angle);
  let s = sin(angle);
  var sum = centre.rg;
  var count = vec2f(1.0);
  for (var i = 0; i < ${DENOISE_SAMPLES}; i++) {
    let d = DISK[i];
    let at = vec2i(floor(vec2f(id.xy) + 0.5 + vec2f(c * d.x - s * d.y, s * d.x + c * d.y) * ${DENOISE_RADIUS.toFixed(1)}));
    if (any(at < vec2i(0)) || any(at >= vec2i(dims))) { continue; }
    let neighbour = textureLoad(source, at, 0);
    if (neighbour.a <= 0.0) { continue; }
    let there = pixelOf((vec2f(at) + 0.5) / half);
    let found = textureLoad(depthTexture, there, 0);
    if (found <= 0.0) { continue; }
    let plane = abs(dot(worldAt(uvOfPixel(there), found) - world, normal));
    let w = exp(-plane / params.occlusion.y) * max(dot(normal, decodeNormal(textureLoad(normalTexture, there, 0).xy)), 0.0);
    sum.x += neighbour.r * w;
    count.x += w;
    let close = w * (1.0 - length(d));
    sum.y += neighbour.g * close;
    count.y += close;
  }
  textureStore(output, id.xy, vec4f(sum / count, centre.b, centre.a));
}
`;

// The half-size result at every full-size pixel, from the four nearest on the same surface, with the strength applied:
// what lighting reads is final. Red is occlusion, green the sun's contact shadow.
const OCCLUSION_RESOLVE_WGSL = /* wgsl */ `
@group(1) @binding(1) var depthTexture: texture_depth_2d;
@group(1) @binding(2) var source: texture_2d<f32>;
@group(1) @binding(3) var output: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(${SCREEN_WORKGROUP}, ${SCREEN_WORKGROUP}) fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(output);
  if (any(id.xy >= dims)) { return; }
  let depth = textureLoad(depthTexture, id.xy, 0);
  if (depth <= 0.0) {
    textureStore(output, id.xy, vec4f(1.0));
    return;
  }
  let z = distanceOf(depth);
  let half = vec2i(textureDimensions(source));
  let at = (vec2f(id.xy) + 0.5) / vec2f(dims) * vec2f(half) - 0.5;
  let base = floor(at);
  let f = at - base;
  var sum = vec2f(0.0);
  var total = 0.0;
  for (var i = 0; i < 4; i++) {
    let o = vec2i(i % 2, i / 2);
    let s = textureLoad(source, clamp(vec2i(base) + o, vec2i(0), half - vec2i(1)), 0);
    var w = select(1.0 - f.x, f.x, o.x == 1) * select(1.0 - f.y, f.y, o.y == 1) + 1e-3;
    w *= select(0.0, exp(-abs(s.a - z) / (z * 0.05 + 0.02)), s.a > 0.0);
    sum += s.rg * w;
    total += w;
  }
  let value = select(vec2f(1.0), sum / max(total, 1e-4), total > 1e-4);
  textureStore(output, id.xy, vec4f(pow(max(value.x, 1e-4), params.occlusion.z), value.y, 1.0, 1.0));
}
`;

// --- BOUNCED LIGHT ---

// The indirect light reaching each half-size pixel, less the indirect light lighting already gave it. A ray that lands
// on a surface brings that surface's lit colour, taken from last frame's picture where the surface was then; one that
// escapes brings the sky's light from its direction. So an open surface comes out unchanged, and an enclosed one loses
// the sky it cannot see and gains what bounces in. Where gathered light has taken the place of the ambient lights, an
// escaping ray brings what was gathered for this pixel, so that it adds nothing to it and this keeps only what is near.
const BOUNCE_TRACE_WGSL = /* wgsl */ `
@group(1) @binding(1) var depthTexture: texture_depth_2d;
@group(1) @binding(2) var normalTexture: texture_2d<f32>;
@group(1) @binding(3) var motionTexture: texture_2d<f32>;
@group(1) @binding(4) var litTexture: texture_2d<f32>;
@group(1) @binding(5) var gatheredTexture: texture_2d<f32>;
@group(1) @binding(6) var output: texture_storage_2d<rgba16float, write>;

const RAYS = 4;
const STEPS = 10;

fn cosineDirection(n: vec3f, xi: vec2f) -> vec3f {
  let phi = TAU * xi.x;
  let r = sqrt(xi.y);
  let t = normalize(select(cross(n, vec3f(1.0, 0.0, 0.0)), cross(n, vec3f(0.0, 1.0, 0.0)), abs(n.y) < 0.99));
  let b = cross(n, t);
  return normalize(t * (cos(phi) * r) + b * (sin(phi) * r) + n * sqrt(max(0.0, 1.0 - xi.y)));
}

// The ambient lights as radiance from a world direction. The hemisphere weight is chosen so that its cosine-weighted
// average over a surface's hemisphere is lighting's own hemisphere term; so are the harmonics' two forms below.
fn ambientFrom(weight: f32) -> vec3f {
  return (params.ambient.rgb + mix(params.hemiGround.rgb, params.hemiSky.rgb, clamp(weight, 0.0, 1.0))) / PI;
}

fn environmentRadiance(d: vec3f) -> vec3f {
  var light = params.sh[0].rgb * 0.282095;
  light += (params.sh[1].rgb * d.y + params.sh[2].rgb * d.z + params.sh[3].rgb * d.x) * 0.488603;
  light += (params.sh[4].rgb * d.x * d.y + params.sh[5].rgb * d.y * d.z + params.sh[7].rgb * d.x * d.z) * 1.092548;
  light += params.sh[6].rgb * 0.315392 * (3.0 * d.z * d.z - 1.0);
  light += params.sh[8].rgb * 0.546274 * (d.x * d.x - d.y * d.y);
  return max(light, vec3f(0.0));
}

fn environmentAverage(n: vec3f) -> vec3f {
  var light = params.sh[0].rgb * 0.886227;
  light += (params.sh[1].rgb * n.y + params.sh[2].rgb * n.z + params.sh[3].rgb * n.x) * 1.023328;
  light += (params.sh[4].rgb * n.x * n.y + params.sh[5].rgb * n.y * n.z + params.sh[7].rgb * n.x * n.z) * 0.858086;
  light += params.sh[6].rgb * (0.743125 * n.z * n.z - 0.247708);
  light += params.sh[8].rgb * 0.429043 * (n.x * n.x - n.y * n.y);
  return max(light, vec3f(0.0)) / PI;
}

@compute @workgroup_size(${SCREEN_WORKGROUP}, ${SCREEN_WORKGROUP}) fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(output);
  if (any(id.xy >= dims)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(dims);
  let pixel = pixelOf(uv);
  let depth = textureLoad(depthTexture, pixel, 0);
  if (depth <= 0.0) {
    textureStore(output, id.xy, vec4f(0.0));
    return;
  }
  let world = worldAt(uvOfPixel(pixel), depth);
  let normal = decodeNormal(textureLoad(normalTexture, pixel, 0).xy);
  let distance = distanceOf(depth);
  let origin = world + normal * (0.02 + distance * 0.01);
  let at = vec2f(id.xy);
  let n0 = noiseAt(at + params.state.x * 5.588238);
  let n1 = noiseAt(at * 1.37 + params.state.x * 3.1416 + 17.0);
  let radius = params.light.x;
  let hasGathered = params.flags.x > 0.5;
  var gatheredHere = vec3f(0.0);
  if (hasGathered) {
    gatheredHere = textureLoad(gatheredTexture, vec2i(uv * vec2f(textureDimensions(gatheredTexture))), 0).rgb / PI;
  }
  var sum = vec3f(0.0);
  for (var r = 0; r < RAYS; r++) {
    let xi = fract(vec2f(n0, n1) + vec2f(f32(r) * 0.618034, f32(r) * 0.381966));
    let direction = cosineDirection(normal, xi);
    let jitter = fract(n1 + f32(r) * 0.25);
    let sky = select(ambientFrom(0.5 + 0.75 * direction.y) + environmentRadiance(direction), gatheredHere, hasGathered);
    var gathered = sky;
    for (var s = 0; s < STEPS; s++) {
      let along = (f32(s) + jitter) / f32(STEPS);
      let t = radius * along * along + 0.05;
      let q = project(origin + direction * t);
      if (q.z >= 1.0 || q.z <= 0.0 || !onScreen(q.xy)) { break; }
      let there = pixelOf(q.xy);
      let behind = distanceOf(q.z) - distanceOf(textureLoad(depthTexture, there, 0));
      // The scene's surface lies just in front of the ray point: the ray went in there.
      if (behind > 0.0 && behind < 0.15 + t * 0.3) {
        let before = q.xy + textureLoad(motionTexture, there, 0).xy;
        // Nothing to take from a picture that does not show it yet: as if it escaped.
        if (params.state.y > 0.5 && onScreen(before)) {
          // The lit side of what it met; the back of something brings nothing.
          let facing = dot(decodeNormal(textureLoad(normalTexture, there, 0).xy), direction);
          let hit = select(vec3f(0.0), min(textureLoad(litTexture, pixelOf(before), 0).rgb, vec3f(6.0)), facing < 0.0);
          // Far blockers fade toward the sky: past the reach the screen cannot say what light comes round them.
          gathered = mix(hit, sky, smoothstep(0.4, 1.0, t / radius));
        }
        break;
      }
    }
    sum += gathered;
  }
  let already = select(ambientFrom(0.5 + 0.5 * normal.y) + environmentAverage(normal), gatheredHere, hasGathered);
  textureStore(output, id.xy, vec4f(sum / f32(RAYS) - already, distance));
}
`;

// Eases each pixel's bounce over frames, restarting where the same surface was not on screen or something else stood
// there. History is read without filtering: a blend across an edge would be true of neither side, pass the distance
// check and stay.
const BOUNCE_TEMPORAL_WGSL = /* wgsl */ `
@group(1) @binding(1) var depthTexture: texture_depth_2d;
@group(1) @binding(2) var motionTexture: texture_2d<f32>;
@group(1) @binding(3) var currentTexture: texture_2d<f32>;
@group(1) @binding(4) var historyTexture: texture_2d<f32>;
@group(1) @binding(5) var output: texture_storage_2d<rgba16float, write>;

const BLEND = 0.12;

@compute @workgroup_size(${SCREEN_WORKGROUP}, ${SCREEN_WORKGROUP}) fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(output);
  if (any(id.xy >= dims)) { return; }
  let now = textureLoad(currentTexture, id.xy, 0);
  if (now.a <= 0.0) {
    textureStore(output, id.xy, vec4f(0.0));
    return;
  }
  var result = now.rgb;
  if (params.state.w > 0.5) {
    let pixel = pixelOf((vec2f(id.xy) + 0.5) / vec2f(dims));
    let uv = uvOfPixel(pixel);
    let before = uv + textureLoad(motionTexture, pixel, 0).xy;
    if (onScreen(before)) {
      let clip = view.previousViewProjection * vec4f(worldAt(uv, textureLoad(depthTexture, pixel, 0)), 1.0);
      let past = textureLoad(historyTexture, vec2i(before * vec2f(dims)), 0);
      if (past.a > 0.0 && abs(past.a - clip.w) < clip.w * 0.06 + 0.02) {
        result = mix(past.rgb, now.rgb, BLEND);
      }
    }
  }
  textureStore(output, id.xy, vec4f(result, now.a));
}
`;

// One step of an edge-stopping blur: neighbours count by how alike their distance and facing are.
const BOUNCE_SMOOTH_WGSL = /* wgsl */ `
@group(1) @binding(1) var normalTexture: texture_2d<f32>;
@group(1) @binding(2) var source: texture_2d<f32>;
@group(1) @binding(3) var output: texture_storage_2d<rgba16float, write>;

override stride: i32 = 1;

@compute @workgroup_size(${SCREEN_WORKGROUP}, ${SCREEN_WORKGROUP}) fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(output);
  if (any(id.xy >= dims)) { return; }
  let centre = textureLoad(source, id.xy, 0);
  if (centre.a <= 0.0) {
    textureStore(output, id.xy, centre);
    return;
  }
  let half = vec2f(dims);
  let normal = decodeNormal(textureLoad(normalTexture, pixelOf((vec2f(id.xy) + 0.5) / half), 0).xy);
  var sum = vec3f(0.0);
  var total = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let at = clamp(vec2i(id.xy) + vec2i(x, y) * stride, vec2i(0), vec2i(dims) - vec2i(1));
      let s = textureLoad(source, at, 0);
      if (s.a <= 0.0) { continue; }
      var w = select(1.0, 2.0, x == 0) * select(1.0, 2.0, y == 0);
      w *= exp(-abs(s.a - centre.a) / (centre.a * 0.04 + 0.02));
      let there = decodeNormal(textureLoad(normalTexture, pixelOf((vec2f(at) + 0.5) / half), 0).xy);
      w *= pow(max(dot(normal, there), 0.0), 8.0);
      sum += s.rgb * w;
      total += w;
    }
  }
  textureStore(output, id.xy, vec4f(sum / max(total, 1e-4), centre.a));
}
`;

// --- REFLECTIONS ---

// Each glossy half-size pixel follows its mirror ray across the screen, in pixels and depth, in which a ray is a straight
// line. Instead of equal steps it takes whole patches at a time from the two depth chains: a patch the ray stays in
// front of the nearest depth of, or behind the farthest depth of by more than a surface's thickness, holds nothing it
// can meet, and it moves up a level to try a bigger one. Otherwise it looks closer, a level down, until a single pixel
// says. What it finds is coloured from last frame's picture, where that surface was then.
// Output: lit colour, how far to trust it.
const REFLECTION_TRACE_WGSL = /* wgsl */ `
@group(1) @binding(1) var depthTexture: texture_depth_2d;
@group(1) @binding(2) var normalTexture: texture_2d<f32>;
@group(1) @binding(3) var emissiveTexture: texture_2d<f32>;
@group(1) @binding(4) var motionTexture: texture_2d<f32>;
@group(1) @binding(5) var litTexture: texture_2d<f32>;
// Level L is mip L - 1: see the nearest-depth chain.
@group(1) @binding(6) var nearestChain: texture_2d<f32>;
// The surface pass's depth pyramid: level L is mip L.
@group(1) @binding(7) var farthestChain: texture_2d<f32>;
@group(1) @binding(8) var output: texture_storage_2d<rgba16float, write>;

const MOST_STEPS = 72;

var<private> rayStart: vec3f;
var<private> rayDelta: vec3f;
var<private> rayDirection: vec3f;
var<private> rayLength: f32;
var<private> startW: f32;
var<private> endW: f32;

// How far along the ray in the world, for a share t of it on screen: t runs evenly on screen, not in the world.
fn travelled(t: f32) -> f32 {
  return rayLength * t * startW / max(endW * (1.0 - t) + t * startW, 1e-6);
}

fn thicknessAt(t: f32) -> f32 {
  return 0.2 + travelled(t) * 0.15;
}

fn nearestAt(cell: vec2i, level: i32) -> f32 {
  if (level == 0) { return textureLoad(depthTexture, cell, 0); }
  return textureLoad(nearestChain, cell, level - 1).r;
}

// The share of the ray at which it meets a surface, or below 0.
fn traceRay(reach: f32) -> f32 {
  let screen = vec2i(view.size.xy);
  let hasFarthest = params.extra.w > 0.5;
  let topLevel = i32(textureNumLevels(nearestChain));
  let nudge = 0.02 / max(max(abs(rayDelta.x), abs(rayDelta.y)), 1.0);
  var level = 0;
  var t = 0.0;
  for (var i = 0; i < MOST_STEPS && t < reach; i++) {
    let p = rayStart + rayDelta * t;
    if (p.z <= 0.0) { return -1.0; }
    let shift = vec2u(u32(level));
    let cell = clamp(vec2i(p.xy) >> shift, vec2i(0), max(screen >> shift, vec2i(1)) - vec2i(1));
    let nearest = nearestAt(cell, level);
    let low = vec2f(cell << shift);
    let edge = select(low, low + f32(1 << u32(level)), rayDelta.xy > vec2f(0.0));
    var leave = reach;
    if (rayDelta.x != 0.0) { leave = min(leave, (edge.x - rayStart.x) / rayDelta.x); }
    if (rayDelta.y != 0.0) { leave = min(leave, (edge.y - rayStart.y) / rayDelta.y); }
    leave = max(leave, t);
    let zLeave = rayStart.z + rayDelta.z * leave;

    let inFront = p.z > nearest;
    if (inFront && zLeave >= nearest) {
      t = leave + nudge;
      level = min(level + 1, topLevel);
      continue;
    }
    if (level > 0) {
      if (inFront) {
        // It reaches the nearest depth inside this patch: nothing here before that.
        t = max(t, (nearest - rayStart.z) / rayDelta.z);
      } else if (hasFarthest) {
        let closest = max(p.z, zLeave);
        let farthest = textureLoad(farthestChain, cell, level).r;
        if (closest < farthest && distanceOf(closest) - distanceOf(farthest) > thicknessAt(t)) {
          t = leave + nudge;
          level = min(level + 1, topLevel);
          continue;
        }
      }
      level -= 1;
      continue;
    }
    // A single pixel, and the ray meets its surface or is behind it.
    if (nearest > 0.0) {
      let crossing = select(t, (nearest - rayStart.z) / rayDelta.z, inFront);
      let behind = distanceOf(rayStart.z + rayDelta.z * crossing) - distanceOf(nearest);
      // A surface facing along the ray is only its own, or one it passed behind: it carries on.
      let facing = dot(decodeNormal(textureLoad(normalTexture, cell, 0).xy), rayDirection);
      if (behind < thicknessAt(crossing) && facing < 0.05) { return crossing; }
    }
    t = leave + nudge;
    if (hasFarthest || inFront) { level = min(1, topLevel); }
  }
  return -1.0;
}

@compute @workgroup_size(${SCREEN_WORKGROUP}, ${SCREEN_WORKGROUP}) fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(output);
  if (any(id.xy >= dims)) { return; }
  textureStore(output, id.xy, vec4f(0.0));
  // Nothing to colour a hit with until a frame has been lit.
  if (params.state.y < 0.5) { return; }
  let pixel = pixelOf((vec2f(id.xy) + 0.5) / vec2f(dims));
  let depth = textureLoad(depthTexture, pixel, 0);
  let surface = textureLoad(normalTexture, pixel, 0);
  let roughness = surface.z;
  if (depth <= 0.0 || roughness > 0.75 || textureLoad(emissiveTexture, pixel, 0).a > 0.875) { return; }
  let world = worldAt(uvOfPixel(pixel), depth);
  let normal = decodeNormal(surface.xy);
  // The noise holds still, so that the pattern on a rough surface does not crawl.
  let n0 = noiseAt(vec2f(id.xy));
  let n1 = noiseAt(vec2f(id.xy) * 1.37 + 17.0);
  let scatter = vec3f(n0 - 0.5, n1 - 0.5, fract(n0 + n1) - 0.5) * roughness * roughness * 0.8;
  let direction = reflect(normalize(world - view.eye.xyz), normalize(normal + scatter));
  if (dot(direction, normal) <= 0.0) { return; }

  let origin = world + normal * (0.01 + distanceOf(depth) * 0.004);
  var distance = params.light.z;
  let nearPlane = view.params.z * 1.01;
  let clipStart = view.viewProjection * vec4f(origin, 1.0);
  if (clipStart.w < nearPlane) { return; }
  var clipEnd = view.viewProjection * vec4f(origin + direction * distance, 1.0);
  if (clipEnd.w < nearPlane) {
    distance *= (nearPlane - clipStart.w) / (clipEnd.w - clipStart.w);
    clipEnd = view.viewProjection * vec4f(origin + direction * distance, 1.0);
  }
  let size = view.size.xy;
  let a = clipStart.xyz / clipStart.w;
  let b = clipEnd.xyz / clipEnd.w;
  rayStart = vec3f((a.x * 0.5 + 0.5) * size.x, (0.5 - a.y * 0.5) * size.y, a.z);
  rayDelta = vec3f((b.x * 0.5 + 0.5) * size.x, (0.5 - b.y * 0.5) * size.y, b.z) - rayStart;
  rayDirection = direction;
  rayLength = distance;
  startW = clipStart.w;
  endW = clipEnd.w;
  // Straight back along the view it barely crosses a pixel, and there is nothing to meet.
  if (max(abs(rayDelta.x), abs(rayDelta.y)) < 1.0) { return; }

  // Where it leaves the screen.
  var reach = 1.0;
  if (rayDelta.x > 0.0) { reach = min(reach, (size.x - rayStart.x) / rayDelta.x); }
  if (rayDelta.x < 0.0) { reach = min(reach, -rayStart.x / rayDelta.x); }
  if (rayDelta.y > 0.0) { reach = min(reach, (size.y - rayStart.y) / rayDelta.y); }
  if (rayDelta.y < 0.0) { reach = min(reach, -rayStart.y / rayDelta.y); }

  let found = traceRay(reach);
  if (found < 0.0) { return; }
  let hit = (rayStart.xy + rayDelta.xy * found) * view.size.zw;
  let there = pixelOf(hit);
  let before = hit + textureLoad(motionTexture, there, 0).xy;
  if (!onScreen(before)) { return; }
  let edge = smoothstep(vec2f(0.0), vec2f(0.08), hit) * (vec2f(1.0) - smoothstep(vec2f(0.92), vec2f(1.0), hit));
  var confidence = edge.x * edge.y;
  confidence *= 1.0 - smoothstep(0.6, 1.0, travelled(found) / params.light.z);
  confidence *= 1.0 - smoothstep(0.5, 0.75, roughness);
  textureStore(output, id.xy, vec4f(min(textureLoad(litTexture, pixelOf(before), 0).rgb, vec3f(8.0)), confidence));
}
`;

// Softens reflections on rougher surfaces, keeping to the surface they fall on, weighted by trust so that a missed ray
// next door does not darken a hit.
//
// Two outputs: what is published, the colour a surface sees with the environment standing in where the ray found nothing
// and the trust in alpha; and what compose adds from, the found colour multiplied by its trust, which filters cleanly.
const REFLECTION_SMOOTH_WGSL = /* wgsl */ `
@group(1) @binding(1) var depthTexture: texture_depth_2d;
@group(1) @binding(2) var normalTexture: texture_2d<f32>;
@group(1) @binding(3) var source: texture_2d<f32>;
@group(1) @binding(6) var output: texture_storage_2d<rgba16float, write>;
@group(1) @binding(7) var found: texture_storage_2d<rgba16float, write>;
${ENVIRONMENT_WGSL(4, 5)}

@compute @workgroup_size(${SCREEN_WORKGROUP}, ${SCREEN_WORKGROUP}) fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(output);
  if (any(id.xy >= dims)) { return; }
  let half = vec2f(dims);
  let pixel = pixelOf((vec2f(id.xy) + 0.5) / half);
  let depth = textureLoad(depthTexture, pixel, 0);
  if (depth <= 0.0) {
    textureStore(output, id.xy, vec4f(0.0));
    textureStore(found, id.xy, vec4f(0.0));
    return;
  }
  let surface = textureLoad(normalTexture, pixel, 0);
  let normal = decodeNormal(surface.xy);
  let roughness = surface.z;
  let z = distanceOf(depth);
  let spread = 1.0 + roughness * 6.0;
  var sum = vec4f(0.0);
  var total = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let at = clamp(vec2i(floor(vec2f(id.xy) + 0.5 + vec2f(f32(x), f32(y)) * spread)), vec2i(0), vec2i(dims) - vec2i(1));
      let there = pixelOf((vec2f(at) + 0.5) / half);
      var w = select(1.0, 2.0, x == 0) * select(1.0, 2.0, y == 0);
      w *= exp(-abs(distanceOf(textureLoad(depthTexture, there, 0)) - z) / (z * 0.03 + 0.02));
      w *= pow(max(dot(normal, decodeNormal(textureLoad(normalTexture, there, 0).xy)), 0.0), 16.0);
      let s = textureLoad(source, at, 0);
      sum += vec4f(s.rgb * s.a, s.a) * w;
      total += w;
    }
  }
  let confidence = sum.a / max(total, 1e-4);
  let hit = select(vec3f(0.0), sum.rgb / max(sum.a, 1e-5), sum.a > 0.0);
  let toEye = normalize(view.eye.xyz - worldAt(uvOfPixel(pixel), depth));
  let rough = lightingRoughness(roughness);
  let environment = environmentFrom(reflectionDirection(toEye, normal, rough), rough);
  textureStore(output, id.xy, vec4f(mix(environment, hit, confidence), confidence));
  textureStore(found, id.xy, vec4f(hit * confidence, confidence));
}
`;

// --- BACK ONTO THE LIT PICTURE ---

// Bounced light on what the surface scatters, then reflections by its reflectance, so metals reflect their own colour and
// other surfaces mostly at grazing angles. The lit picture already holds the environment's reflection, and where a ray
// found something that was the wrong thing to see: as much as the ray is trusted, it comes out again by lighting's own
// numbers, and what was found goes in. Runs over a copy of the lit picture; sky and unlit surfaces are left as they are
// in the target, and baked surfaces keep the indirect light they were baked with.
const COMPOSE_WGSL = /* wgsl */ `
@group(1) @binding(1) var depthTexture: texture_depth_2d;
@group(1) @binding(2) var normalTexture: texture_2d<f32>;
@group(1) @binding(3) var albedoTexture: texture_2d<f32>;
@group(1) @binding(4) var emissiveTexture: texture_2d<f32>;
@group(1) @binding(5) var litTexture: texture_2d<f32>;
@group(1) @binding(6) var bounceTexture: texture_2d<f32>;
@group(1) @binding(7) var foundTexture: texture_2d<f32>;
@group(1) @binding(8) var occlusionTexture: texture_2d<f32>;
@group(1) @binding(11) var output: texture_storage_2d<rgba16float, write>;
${ENVIRONMENT_WGSL(9, 10)}

// The half-size bounce at a full-size pixel, from the four nearest samples on the same surface.
fn bounceAt(uv: vec2f, z: f32) -> vec3f {
  let half = vec2i(textureDimensions(bounceTexture));
  let at = uv * vec2f(half) - 0.5;
  let base = floor(at);
  let f = at - base;
  var sum = vec3f(0.0);
  var total = 0.0;
  for (var i = 0; i < 4; i++) {
    let o = vec2i(i % 2, i / 2);
    let s = textureLoad(bounceTexture, clamp(vec2i(base) + o, vec2i(0), half - vec2i(1)), 0);
    var w = select(1.0 - f.x, f.x, o.x == 1) * select(1.0 - f.y, f.y, o.y == 1) + 1e-3;
    w *= select(0.0, exp(-abs(s.a - z) / (z * 0.05 + 0.02)), s.a > 0.0);
    sum += s.rgb * w;
    total += w;
  }
  return select(vec3f(0.0), sum / max(total, 1e-4), total > 1e-4);
}

// How much of the environment a surface reflects, as lighting works it out.
fn reflectance(f0: vec3f, dotNV: f32, roughness: f32) -> vec3f {
  let r = roughness * vec4f(-1.0, -0.0275, -0.572, 0.022) + vec4f(1.0, 0.0425, 1.04, -0.04);
  let a004 = min(r.x * r.x, exp2(-9.28 * dotNV)) * r.x + r.y;
  let fab = vec2f(-1.04, 1.04) * a004 + r.zw;
  return f0 * fab.x + vec3f(fab.y);
}

fn specularOcclusion(dotNV: f32, occlusion: f32, roughness: f32) -> f32 {
  return saturate(pow(dotNV + occlusion, exp2(-16.0 * roughness - 1.0)) - 1.0 + occlusion);
}

@compute @workgroup_size(${SCREEN_WORKGROUP}, ${SCREEN_WORKGROUP}) fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(output);
  if (any(id.xy >= dims)) { return; }
  let depth = textureLoad(depthTexture, id.xy, 0);
  let model = textureLoad(emissiveTexture, id.xy, 0).a;
  if (depth <= 0.0 || model > 0.875) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(dims);
  let surface = textureLoad(normalTexture, id.xy, 0);
  let albedo = textureLoad(albedoTexture, id.xy, 0);
  let roughness = lightingRoughness(surface.z);
  let metalness = surface.w;
  let normal = decodeNormal(surface.xy);
  let toEye = normalize(view.eye.xyz - worldAt(uv, depth));
  let dotNV = saturate(dot(normal, toEye));
  let scatter = reflectance(mix(vec3f(0.04), albedo.rgb, metalness), dotNV, roughness);
  let occlusion = albedo.a * select(1.0, textureLoad(occlusionTexture, id.xy, 0).r, params.occlusion.z > 0.0);
  let lit = textureLoad(litTexture, id.xy, 0);
  var color = lit.rgb;
  let z = distanceOf(depth);
  let bounceStrength = params.light.y;
  if (bounceStrength > 0.0 && model < 0.25) {
    let diffuse = albedo.rgb * (1.0 - metalness) * max(vec3f(1.0) - scatter, vec3f(0.0));
    color = max(color + diffuse * bounceAt(uv, z) * occlusion * bounceStrength, vec3f(0.0));
  }
  let reflectionStrength = params.light.w;
  let hits = textureSampleLevel(foundTexture, linearSampler, uv, 0.0);
  if (reflectionStrength > 0.0 && hits.a > 0.001) {
    let environment = environmentFrom(reflectionDirection(toEye, normal, roughness), roughness);
    let already = environment * specularOcclusion(dotNV, occlusion, roughness);
    color = max(color + scatter * (hits.rgb - already * hits.a) * reflectionStrength, vec3f(0.0));
  }
  let show = params.extra.z;
  // Grey where nothing changes; darker where sky light is lost, coloured where light bounces in.
  if (show > 0.5 && show < 1.5) { color = vec3f(0.25) + bounceAt(uv, z); }
  if (show > 1.5) { color = hits.rgb; }
  textureStore(output, id.xy, vec4f(color, lit.a));
}
`;

const program = (body: string, bindings: readonly ScreenBinding[], extra: Pick<ScreenProgram, "entryPoint" | "constants"> = {}): ScreenProgram => ({
  code: `${COMMON_WGSL}${body}`,
  bindings: [PARAMS, ...bindings],
  ...extra,
});

export const SCREEN_PROGRAMS = {
  nearestFromDepth: program(NEAREST_WGSL, [DEPTH, LOAD, WRITE_DEPTH], { entryPoint: "fromDepth" }),
  nearestFromLevel: program(NEAREST_WGSL, [DEPTH, LOAD, WRITE_DEPTH], { entryPoint: "fromLevel" }),
  occlusionTrace: program(OCCLUSION_TRACE_WGSL, [DEPTH, WRITE_HDR]),
  occlusionTemporal: program(OCCLUSION_TEMPORAL_WGSL, [DEPTH, LOAD, LOAD, LOAD, WRITE_HDR]),
  occlusionBlurFirst: program(OCCLUSION_BLUR_WGSL, [DEPTH, LOAD, LOAD, WRITE_HDR], { constants: { blurRound: 0 } }),
  occlusionBlurSecond: program(OCCLUSION_BLUR_WGSL, [DEPTH, LOAD, LOAD, WRITE_HDR], { constants: { blurRound: 1 } }),
  occlusionResolve: program(OCCLUSION_RESOLVE_WGSL, [DEPTH, LOAD, WRITE_BYTES]),
  bounceTrace: program(BOUNCE_TRACE_WGSL, [DEPTH, LOAD, LOAD, LOAD, LOAD, WRITE_HDR]),
  bounceTemporal: program(BOUNCE_TEMPORAL_WGSL, [DEPTH, LOAD, LOAD, LOAD, WRITE_HDR]),
  bounceSmoothFirst: program(BOUNCE_SMOOTH_WGSL, [LOAD, LOAD, WRITE_HDR], { constants: { stride: 1 } }),
  bounceSmoothSecond: program(BOUNCE_SMOOTH_WGSL, [LOAD, LOAD, WRITE_HDR], { constants: { stride: 2 } }),
  reflectionTrace: program(REFLECTION_TRACE_WGSL, [DEPTH, LOAD, LOAD, LOAD, LOAD, LOAD, LOAD, WRITE_HDR]),
  reflectionSmooth: program(REFLECTION_SMOOTH_WGSL, [DEPTH, LOAD, LOAD, CUBE, LINEAR, WRITE_HDR, WRITE_HDR]),
  compose: program(COMPOSE_WGSL, [DEPTH, LOAD, LOAD, LOAD, LOAD, LOAD, FILTERED, LOAD, CUBE, LINEAR, WRITE_HDR]),
} as const satisfies Record<string, ScreenProgram>;

export type ScreenProgramName = keyof typeof SCREEN_PROGRAMS;
