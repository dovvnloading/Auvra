import {
  MAX_RAMP_STOPS,
  STAGE_OUTPUTS,
  compileMaterialGraph,
  materialGraphFeatures,
  materialGraphSettings,
  textureSlot,
  type CompiledMaterialGraph,
  type MaterialGraph,
  type MaterialUniformSpec,
  type PhysicalFeature,
  type TextureSlot,
} from "../../../runtime/materials/materialGraph";
import { forwardHead } from "../shaders";
import { MAPPED_NORMAL_WGSL, type SurfaceKind } from "../surfaces";
import { BAKED_VOLUME_WGSL } from "./bakedVolume";
import { GLSL_SUPPORT_WGSL, GlslError, GlslTranslator, wgslType, type GlslContext, type GlslFunction } from "./glslToWgsl";
import { PHYSICAL_LAYERS_WGSL, PHYSICAL_LOBE_WGSL } from "./physicalLayers";
import { WEATHER_WGSL } from "./weather";
import { WIND_WGSL } from "./wind";
import { INSTANCE_INVERSE_WGSL, STIPPLE_WGSL, worldWgsl } from "./world";
import { reportGpu } from "../report";

/**
 * MATERIAL GRAPHS IN WGSL
 *
 * What runtime/materials/materialGlsl.ts is to the WebGL path: the functions graph nodes call, by the same names. A graph
 * is compiled by the very compiler and node definitions the WebGL path uses, for the same part of the graph and the same
 * uniforms, and the GLSL statements that come out are translated (glslToWgsl.ts), so each node has one definition, every
 * node comes along by that, and so does a Custom GLSL node's code. What is written here is what the translation is
 * placed in: the function a surface kind is, what its builtins read, and the numbers it holds.
 *
 * Around the graph, a graph-shaded material is drawn as the WebGL path's shader stages draw it
 * (runtime/materials/shaderStages.ts):
 * - the coat (with its colour), sheen and transmission a graph works out, and its specular, index of refraction and
 *   thin film, as physicalLayers.ts carries them (anisotropy is not drawn); metal flakes are worked into the colour,
 *   metalness, roughness and normal by the compiler, as on the WebGL path;
 * - with "Keep the model's own maps", what the graph leaves unwired read from the material's own maps and values (its
 *   colour, roughness, metalness, normal and emission), as three's own code reads them on the WebGL path;
 * - rain and snow on whatever colour and roughness the graph worked out, when the weather patch reached the material;
 * - for a material swaying in the wind, its vertices moved from where the graph's vertex offset left them, which makes
 *   a kind of its own, as for any lit material (lit.ts).
 */

interface WgslHelper {
  needs?: readonly string[];
  returns: string;
  params: readonly string[];
  outs?: readonly number[];
  source: string;
}

const RAMP_TYPE = `vec4[${MAX_RAMP_STOPS}]`;

/** A Triplanar Normal Map's projections, `read` reading the map at a UV; `green` is -1 to flip a DirectX map's green. */
const triplanarNormalWgsl = (name: string, read: (uv: string) => string): string => `
@diagnostic(off, derivative_uniformity)
fn ${name}(map: texture_2d<f32>, mapSampler: sampler, position: vec3f, normal: vec3f, sharpness: f32, strength: f32, green: f32) -> vec3f {
  let n = normalize(normal);
  var weights = pow(abs(n), vec3f(sharpness));
  weights /= max(weights.x + weights.y + weights.z, 1e-5);
  let facing = select(vec3f(1.0), vec3f(-1.0), n < vec3f(0.0));
  var x = ${read("vec2f(-facing.x * position.z, position.y)")}.xyz * 2.0 - 1.0;
  var y = ${read("vec2f(-facing.y * position.x, position.z)")}.xyz * 2.0 - 1.0;
  var z = ${read("vec2f(facing.z * position.x, position.y)")}.xyz * 2.0 - 1.0;
  // The map's own x turns with each projection's u, and each projection's normal is laid onto the surface's (whiteout).
  x = vec3f(x.x * strength * -facing.x, x.y * green * strength, x.z);
  y = vec3f(y.x * strength * -facing.y, y.y * green * strength, y.z);
  z = vec3f(z.x * strength * facing.z, z.y * green * strength, z.z);
  x = vec3f(x.xy + n.zy, abs(x.z) * n.x);
  y = vec3f(y.xy + n.xz, abs(y.z) * n.y);
  z = vec3f(z.xy + n.xy, abs(z.z) * n.z);
  return normalize(x.zyx * weights.x + y.xzy * weights.y + z.xyz * weights.z);
}`;

const HELPERS: Readonly<Record<string, WgslHelper>> = {
  // --- Hashing: pcg3d (Jarzynski and Olano, "Hash Functions for GPU Rendering", 2020) ---
  mgPcg3: {
    returns: "uvec3",
    params: ["uvec3"],
    source: `
fn mgPcg3(start: vec3u) -> vec3u {
  var v = start * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v = v ^ (v >> vec3u(16u));
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}`,
  },
  mgHash33: {
    needs: ["mgPcg3"],
    returns: "vec3",
    params: ["vec3"],
    source: `
fn mgHash33(cell: vec3f) -> vec3f {
  return vec3f(mgPcg3(vec3u(vec3i(floor(cell))))) * (1.0 / 4294967295.0);
}`,
  },
  mgGradient3: {
    needs: ["mgHash33"],
    returns: "vec3",
    params: ["vec3"],
    source: `
fn mgGradient3(cell: vec3f) -> vec3f {
  return normalize(mgHash33(cell) * 2.0 - 1.0 + vec3f(1e-4));
}`,
  },

  // --- Noise, each from 0 to 1 ---
  // The value noise the first Noise node used, kept so materials made with it look the same.
  mgLegacyNoise: {
    returns: "float",
    params: ["vec2"],
    source: `
fn mgLegacyHash(start: vec2f) -> f32 {
  var p = fract(start * vec2f(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
fn mgLegacyNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mgLegacyHash(i), mgLegacyHash(i + vec2f(1.0, 0.0)), u.x),
             mix(mgLegacyHash(i + vec2f(0.0, 1.0)), mgLegacyHash(i + vec2f(1.0, 1.0)), u.x), u.y);
}`,
  },
  mgValueNoise: {
    needs: ["mgHash33"],
    returns: "float",
    params: ["vec3"],
    source: `
fn mgValueNoise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = mgHash33(i).x;
  let b = mgHash33(i + vec3f(1, 0, 0)).x;
  let c = mgHash33(i + vec3f(0, 1, 0)).x;
  let d = mgHash33(i + vec3f(1, 1, 0)).x;
  let e = mgHash33(i + vec3f(0, 0, 1)).x;
  let f1 = mgHash33(i + vec3f(1, 0, 1)).x;
  let g = mgHash33(i + vec3f(0, 1, 1)).x;
  let h = mgHash33(i + vec3f(1, 1, 1)).x;
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, f1, u.x), mix(g, h, u.x), u.y), u.z);
}`,
  },
  mgGradientNoise: {
    needs: ["mgGradient3"],
    returns: "float",
    params: ["vec3"],
    source: `
fn mgGradientNoise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let n000 = dot(mgGradient3(i), f);
  let n100 = dot(mgGradient3(i + vec3f(1, 0, 0)), f - vec3f(1, 0, 0));
  let n010 = dot(mgGradient3(i + vec3f(0, 1, 0)), f - vec3f(0, 1, 0));
  let n110 = dot(mgGradient3(i + vec3f(1, 1, 0)), f - vec3f(1, 1, 0));
  let n001 = dot(mgGradient3(i + vec3f(0, 0, 1)), f - vec3f(0, 0, 1));
  let n101 = dot(mgGradient3(i + vec3f(1, 0, 1)), f - vec3f(1, 0, 1));
  let n011 = dot(mgGradient3(i + vec3f(0, 1, 1)), f - vec3f(0, 1, 1));
  let n111 = dot(mgGradient3(i + vec3f(1, 1, 1)), f - vec3f(1, 1, 1));
  let n = mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
  return clamp(n * 0.9 + 0.5, 0.0, 1.0);
}`,
  },
  mgSimplexNoise: {
    needs: ["mgGradient3"],
    returns: "float",
    params: ["vec3"],
    source: `
fn mgSimplexNoise(p: vec3f) -> f32 {
  let s = floor(p + dot(p, vec3f(1.0 / 3.0)));
  let x0 = p - s + dot(s, vec3f(1.0 / 6.0));
  let e = step(vec3f(0.0), x0 - x0.yzx);
  let i1 = e * (1.0 - e.zxy);
  let i2 = 1.0 - e.zxy * (1.0 - e);
  let x1 = x0 - i1 + 1.0 / 6.0;
  let x2 = x0 - i2 + 1.0 / 3.0;
  let x3 = x0 - 0.5;
  var w = max(0.6 - vec4f(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), vec4f(0.0));
  let d = vec4f(dot(mgGradient3(s), x0), dot(mgGradient3(s + i1), x1), dot(mgGradient3(s + i2), x2), dot(mgGradient3(s + 1.0), x3));
  w *= w;
  w *= w;
  return clamp(dot(d, w) * 16.0 + 0.5, 0.0, 1.0);
}`,
  },
  mgVoronoi: {
    needs: ["mgHash33"],
    returns: "void",
    params: ["vec3", "float", "float", "float", "vec3"],
    outs: [2, 3, 4],
    source: `
fn mgVoronoi(p: vec3f, jitter: f32, nearest: ptr<function, f32>, second: ptr<function, f32>, cell: ptr<function, vec3f>) {
  let i = floor(p);
  let f = fract(p);
  var d1 = 8.0;
  var d2 = 8.0;
  *cell = vec3f(0.0);
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let offset = vec3f(f32(x), f32(y), f32(z));
        let h = mgHash33(i + offset);
        let r = offset + h * jitter - f;
        let d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; *cell = h; }
        else if (d < d2) { d2 = d; }
      }
    }
  }
  *nearest = sqrt(d1);
  *second = sqrt(d2);
}`,
  },

  // --- Car paint (materialGlsl.ts mgMetalFlakes, mgFlakeNormal) ---
  mgMetalFlakes: {
    needs: ["mgHash33"],
    returns: "vec4",
    params: ["vec3", "float", "float"],
    source: `
@diagnostic(off, derivative_uniformity)
fn mgMetalFlakes(p: vec3f, size: f32, density: f32) -> vec4f {
  let q = p / max(size, 1e-4);
  let i = floor(q);
  let f = q - i;
  var nearest = 8.0;
  var cell = i;
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let offset = vec3f(f32(x), f32(y), f32(z));
        let r = offset + mgHash33(i + offset) - f;
        let d = dot(r, r);
        if (d < nearest) { nearest = d; cell = i + offset; }
      }
    }
  }
  let h = mgHash33(cell + vec3f(59.0, 131.0, 227.0));
  let share = clamp(density, 0.0, 1.0);
  let present = select(0.0, 1.0, h.x < share);
  let turn = h.y * 6.2831853;
  let lean = 0.7 * sqrt(h.z);
  let tilt = normalize(vec3f(cos(turn) * lean, sin(turn) * lean, 1.0));
  let sharp = 1.0 - smoothstep(0.4, 1.2, length(fwidth(q)));
  return vec4f(normalize(mix(vec3f(0.0, 0.0, 1.0), tilt, sharp)), mix(share, present, sharp));
}`,
  },
  mgFlakeNormal: {
    returns: "vec3",
    params: ["vec3", "vec4"],
    source: `
fn mgFlakeNormal(normal: vec3f, flake: vec4f) -> vec3f {
  let n = normalize(normal);
  let side = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(n.z) < 0.999);
  let t = normalize(cross(side, n));
  let b = cross(n, t);
  let leant = normalize(t * flake.x + b * flake.y + n * flake.z);
  return normalize(mix(n, leant, flake.w));
}`,
  },

  // --- Colour ---
  mgRgbToHsv: {
    returns: "vec3",
    params: ["vec3"],
    source: `
fn mgRgbToHsv(c: vec3f) -> vec3f {
  let k = vec4f(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  let p = select(vec4f(c.gb, k.xy), vec4f(c.bg, k.wz), c.g < c.b);
  let q = select(vec4f(c.r, p.yzx), vec4f(p.xyw, c.r), c.r < p.x);
  let d = q.x - min(q.w, q.y);
  return vec3f(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}`,
  },
  mgHsvToRgb: {
    returns: "vec3",
    params: ["vec3"],
    source: `
fn mgHsvToRgb(c: vec3f) -> vec3f {
  let p = abs(fract(c.xxx + vec3f(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3f(1.0), clamp(p - 1.0, vec3f(0.0), vec3f(1.0)), c.y);
}`,
  },
  mgLuminance: {
    returns: "float",
    params: ["vec3"],
    source: `
fn mgLuminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}`,
  },
  mgOverlay: {
    returns: "vec3",
    params: ["vec3", "vec3"],
    source: `
fn mgOverlay(base: vec3f, blend: vec3f) -> vec3f {
  return mix(2.0 * base * blend, 1.0 - 2.0 * (1.0 - base) * (1.0 - blend), step(vec3f(0.5), base));
}`,
  },
  mgSoftLight: {
    returns: "vec3",
    params: ["vec3", "vec3"],
    source: `
fn mgSoftLight(base: vec3f, blend: vec3f) -> vec3f {
  let dark = base - (1.0 - 2.0 * blend) * base * (1.0 - base);
  let d = mix(((16.0 * base - 12.0) * base + 4.0) * base, sqrt(max(base, vec3f(0.0))), step(vec3f(0.25), base));
  let light = base + (2.0 * blend - 1.0) * (d - base);
  return mix(dark, light, step(vec3f(0.5), blend));
}`,
  },
  mgRamp: {
    returns: "vec3",
    params: [RAMP_TYPE, "float", "int"],
    source: `
fn mgRamp(given: array<vec4f, ${MAX_RAMP_STOPS}>, t: f32, mode: i32) -> vec3f {
  var stops = given;
  if (t <= stops[0].w) { return stops[0].rgb; }
  for (var i = 1; i < ${MAX_RAMP_STOPS}; i++) {
    if (t <= stops[i].w) {
      var f = clamp((t - stops[i - 1].w) / max(stops[i].w - stops[i - 1].w, 1e-5), 0.0, 1.0);
      if (mode == 1) { f = 0.0; }
      else if (mode == 2) { f = f * f * (3.0 - 2.0 * f); }
      return mix(stops[i - 1].rgb, stops[i].rgb, f);
    }
  }
  return stops[${MAX_RAMP_STOPS - 1}].rgb;
}`,
  },

  // --- Normals and tangent space ---
  // Reoriented normal mapping (Barre-Brisebois and Hill, 2012) on tangent-space normals.
  mgNormalBlend: {
    returns: "vec3",
    params: ["vec3", "vec3"],
    source: `
fn mgNormalBlend(base: vec3f, detail: vec3f) -> vec3f {
  let t = base + vec3f(0.0, 0.0, 1.0);
  let u = detail * vec3f(-1.0, -1.0, 1.0);
  return normalize(t * dot(t, u) / t.z - u);
}`,
  },
  // A tangent-space normal from a height, through the height's and the UV's screen-space derivatives.
  mgNormalFromHeight: {
    returns: "vec3",
    params: ["float", "vec2", "float"],
    source: `
fn mgNormalFromHeight(height: f32, uv: vec2f, strength: f32) -> vec3f {
  let dhd = vec2f(dpdx(height), dpdy(height));
  let duvx = dpdx(uv);
  let duvy = dpdy(uv);
  let det = duvx.x * duvy.y - duvx.y * duvy.x;
  if (abs(det) < 1e-12) { return vec3f(0.0, 0.0, 1.0); }
  // dh/du and dh/dv, solving dh/dx = dh/du du/dx + dh/dv dv/dx (and the same in y).
  let grad = vec2f(dhd.x * duvy.y - dhd.y * duvx.y, dhd.y * duvx.x - dhd.x * duvy.x) / det;
  return normalize(vec3f(-grad * strength, 1.0));
}`,
  },
  // The surface's tangent frame (tangent, bitangent, normal) from derivatives, for meshes with or without tangents.
  mgTangentFrame: {
    returns: "mat3",
    params: ["vec3", "vec3", "vec2"],
    source: `
fn mgTangentFrame(position: vec3f, normal: vec3f, uv: vec2f) -> mat3x3f {
  let dp1 = dpdx(position);
  let dp2 = dpdy(position);
  let duv1 = dpdx(uv);
  let duv2 = dpdy(uv);
  let dp2perp = cross(dp2, normal);
  let dp1perp = cross(normal, dp1);
  let t = dp2perp * duv1.x + dp1perp * duv2.x;
  let b = dp2perp * duv1.y + dp1perp * duv2.y;
  let scale = inverseSqrt(max(max(dot(t, t), dot(b, b)), 1e-20));
  return mat3x3f(t * scale, b * scale, normal);
}`,
  },

  // --- Parallax occlusion mapping: steep parallax refined between its last two steps, and the height field's shadow
  // toward the light, both marched in the surface's own (tangent) space. A texture is its texture and its sampler. ---
  mgParallaxUv: {
    returns: "vec2",
    params: ["sampler2D", "vec2", "vec3", "float", "float"],
    source: `
@diagnostic(off, derivative_uniformity)
fn mgParallaxUv(heightMap: texture_2d<f32>, heightSampler: sampler, uv: vec2f, toEye: vec3f, depth: f32, layers: f32) -> vec2f {
  let dx = dpdx(uv);
  let dy = dpdy(uv);
  // Fewer steps head-on, where the view crosses few heights.
  let steps = max(mix(layers, layers * 0.5, abs(toEye.z)), 1.0);
  let stepDepth = 1.0 / steps;
  let shift = toEye.xy / max(toEye.z, 0.08) * depth / steps;
  var at = uv;
  var ground = 1.0 - textureSampleGrad(heightMap, heightSampler, at, dx, dy).r;
  var reached = 0.0;
  for (var i = 0; i < 64; i++) {
    if (reached >= ground || f32(i) >= steps) { break; }
    at -= shift;
    ground = 1.0 - textureSampleGrad(heightMap, heightSampler, at, dx, dy).r;
    reached += stepDepth;
  }
  let before = at + shift;
  let below = ground - reached;
  let above = (1.0 - textureSampleGrad(heightMap, heightSampler, before, dx, dy).r) - reached + stepDepth;
  let weight = clamp(below / min(below - above, -1e-5), 0.0, 1.0);
  return mix(at, before, weight);
}`,
  },
  mgParallaxShadow: {
    returns: "float",
    params: ["sampler2D", "vec2", "vec3", "float", "float"],
    source: `
@diagnostic(off, derivative_uniformity)
fn mgParallaxShadow(heightMap: texture_2d<f32>, heightSampler: sampler, uv: vec2f, light: vec3f, depth: f32, layers: f32) -> f32 {
  // A light below the surface leaves it unlit anyway; so does no sun, whose direction is nothing.
  if (light.z <= 0.0) { return 1.0; }
  let dx = dpdx(uv);
  let dy = dpdy(uv);
  let height = textureSampleGrad(heightMap, heightSampler, uv, dx, dy).r;
  let steps = max(layers, 1.0);
  let rise = (1.0 - height) / steps;
  let shift = light.xy / max(light.z, 0.08) * depth * (1.0 - height) / steps;
  var level = height + rise;
  var at = uv + shift;
  var blocked = 0.0;
  for (var i = 0; i < 64; i++) {
    if (f32(i) >= steps || level >= 1.0) { break; }
    // What rises above the ray toward the light shades the point: softer the further away it is.
    blocked = max(blocked, (textureSampleGrad(heightMap, heightSampler, at, dx, dy).r - level) * (1.0 - f32(i) / steps));
    level += rise;
    at += shift;
  }
  return 1.0 - clamp(blocked * 8.0, 0.0, 1.0);
}`,
  },

  // --- A normal map projected from the three axes (runtime/materials/triplanarNormal.ts), as a world-space normal ---
  mgTriplanarNormal: {
    returns: "vec3",
    params: ["sampler2D", "vec3", "vec3", "float", "float", "float"],
    source: triplanarNormalWgsl("mgTriplanarNormal", (uv) => `textureSample(map, mapSampler, ${uv})`),
  },
  // The same where vertices read it: they have no neighbours to choose a mip level from, so the largest is read.
  mgTriplanarNormalVertex: {
    returns: "vec3",
    params: ["sampler2D", "vec3", "vec3", "float", "float", "float"],
    source: triplanarNormalWgsl("mgTriplanarNormalVertex", (uv) => `textureSampleLevel(map, mapSampler, ${uv}, 0.0)`),
  },

  // --- What vertices call for helpers that read how things change across the screen, which vertices cannot ---
  // No neighbours to slope toward: the surface as it is.
  mgNormalFromHeightVertex: {
    returns: "vec3",
    params: ["float", "vec2", "float"],
    source: `
fn mgNormalFromHeightVertex(height: f32, uv: vec2f, strength: f32) -> vec3f {
  return vec3f(0.0, 0.0, 1.0);
}`,
  },
  // A frame round the normal alone (its tangent along whichever axis lies flattest across it).
  mgTangentFrameVertex: {
    returns: "mat3",
    params: ["vec3", "vec3", "vec2"],
    source: `
fn mgTangentFrameVertex(position: vec3f, normal: vec3f, uv: vec2f) -> mat3x3f {
  let n = normalize(normal);
  let across = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.x) > 0.9);
  let t = normalize(cross(across, n));
  return mat3x3f(t, cross(n, t), n);
}`,
  },
  // Parallax marches across pixels: a vertex reads its own place, unshadowed.
  mgParallaxUvVertex: {
    returns: "vec2",
    params: ["sampler2D", "vec2", "vec3", "float", "float"],
    source: `
fn mgParallaxUvVertex(heightMap: texture_2d<f32>, heightSampler: sampler, uv: vec2f, toEye: vec3f, depth: f32, layers: f32) -> vec2f {
  return uv;
}`,
  },
  mgParallaxShadowVertex: {
    returns: "float",
    params: ["sampler2D", "vec2", "vec3", "float", "float"],
    source: `
fn mgParallaxShadowVertex(heightMap: texture_2d<f32>, heightSampler: sampler, uv: vec2f, light: vec3f, depth: f32, layers: f32) -> f32 {
  return 1.0;
}`,
  },
};

/** Helpers that read textures with a mip level chosen by the pixels around, and the one vertices call in their place. */
const VERTEX_HELPERS: Readonly<Record<string, string>> = {
  mgTriplanarNormal: "mgTriplanarNormalVertex",
  mgNormalFromHeight: "mgNormalFromHeightVertex",
  mgTangentFrame: "mgTangentFrameVertex",
  mgParallaxUv: "mgParallaxUvVertex",
  mgParallaxShadow: "mgParallaxShadowVertex",
};

/** The helpers' WGSL, dependencies first, for the names asked for; names that are not helpers are left out. */
const helperSource = (names: Iterable<string>): string => {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const helper = HELPERS[name];
    if (helper) {
      for (const need of helper.needs ?? []) visit(need);
      ordered.push(helper.source);
    } else if (GLSL_SUPPORT_WGSL[name]) {
      ordered.push(GLSL_SUPPORT_WGSL[name]);
    }
  };
  for (const name of names) visit(name);
  return ordered.join("\n");
};

const helperFunctions = (): Record<string, GlslFunction> =>
  Object.fromEntries(Object.entries(HELPERS).map(([name, helper]) => [name, { returns: helper.returns, params: helper.params, outs: helper.outs }]));

// ---------------------------------------------------------------------------
// What a graph's numbers look like in its uniform buffer
// ---------------------------------------------------------------------------

/** Flags in a graph's uniform buffer: `blended` is a material drawn blended, `takesWeather` one the weather patch reached. */
export const GRAPH_FLAG = { vertexColors: 1, flatShading: 2, takesWeather: 4, blended: 8 } as const;

const FIELD_LAYOUT: Readonly<Record<string, { align: number; size: number; type: string }>> = {
  float: { align: 4, size: 4, type: "f32" },
  vec2: { align: 8, size: 8, type: "vec2f" },
  vec3: { align: 16, size: 12, type: "vec3f" },
  color: { align: 16, size: 12, type: "vec3f" },
  ramp: { align: 16, size: MAX_RAMP_STOPS * 16, type: `array<vec4f, ${MAX_RAMP_STOPS}>` },
};

/**
 * The fixed start of a graph's uniform buffer, in bytes: time, alpha test, flags, the normal scale, then how the
 * material sways (wind.ts packWind) at GRAPH_WIND_AT, in floats.
 */
const FIELDS_START = 48;
export const GRAPH_WIND_AT = 8;

/** The parts of a physical surface a graph's kind carries, and the Material Output inputs each reads. */
const LAYER_OUTPUTS: Partial<Record<PhysicalFeature, readonly string[]>> = {
  specular: ["specularWeight", "specularColor", "ior"],
  coat: ["coat", "coatRoughness", "coatColor"],
  sheen: ["sheenColor", "sheenRoughness"],
  thinFilm: ["thinFilm", "thinFilmThickness"],
  transmission: ["transmission"],
  // Worked into the colour, metalness, roughness and normal by the graph's compiler (materialGraph.ts flakeSurface).
  flakes: ["flakeDensity", "flakeSize", "flakeColor"],
};

/** The parts carried as layers over the surface (the rest change its reflection: PHYSICAL_LOBE_WGSL). */
const OVER_LAYERS: readonly PhysicalFeature[] = ["coat", "sheen", "transmission"];

/**
 * What a graph keeping the model's own maps reads of the material for an input it leaves unwired, as three's own code
 * reads it: the maps (a missing one reads as white, or flat for a normal map) and the material's own values.
 */
interface OwnRead {
  /** Unwired, all of these, the input is the material's own. */
  unless: readonly string[];
  textures: readonly GraphTexture[];
  fields: ReadonlyArray<{ name: string; kind: "float" | "color"; own: string }>;
}

const OWN_READS: Readonly<Record<"baseColor" | "roughness" | "metalness" | "normal" | "emissive", OwnRead>> = {
  baseColor: { unless: ["baseColor"], textures: [{ name: "mgOwnMap", slot: "map", own: "map" }], fields: [{ name: "mgOwnColor", kind: "color", own: "color" }] },
  roughness: { unless: ["roughness"], textures: [{ name: "mgOwnRoughnessMap", slot: "data", own: "roughnessMap" }], fields: [{ name: "mgOwnRoughness", kind: "float", own: "roughness" }] },
  metalness: { unless: ["metalness"], textures: [{ name: "mgOwnMetalnessMap", slot: "data", own: "metalnessMap" }], fields: [{ name: "mgOwnMetalness", kind: "float", own: "metalness" }] },
  normal: { unless: ["normal"], textures: [{ name: "mgOwnNormalMap", slot: "normal", own: "normalMap" }], fields: [] },
  emissive: {
    unless: ["emissive", "emissiveStrength"],
    textures: [{ name: "mgOwnEmissiveMap", slot: "map", own: "emissiveMap" }],
    fields: [{ name: "mgOwnEmissive", kind: "color", own: "emissive" }, { name: "mgOwnEmissiveIntensity", kind: "float", own: "emissiveIntensity" }],
  },
};

const OWN_NORMAL_WGSL = /* wgsl */ `
@diagnostic(off, derivative_uniformity)
fn mgOwnNormal() -> vec3f {
  let texel = textureSample(mgOwnNormalMap, mgOwnNormalMap_sampler, mgIn.uv0).xy * 2.0 - 1.0;
  // Blue comes from red and green: a compressed normal map keeps only those, and a full one agrees.
  return vec3f(texel, sqrt(saturate(1.0 - dot(texel, texel))));
}`;

/** The parts of a physical surface a (normalised) graph uses that its kind carries. */
export const graphLayers = (graph: MaterialGraph): PhysicalFeature[] => materialGraphFeatures(graph).filter((feature) => LAYER_OUTPUTS[feature] !== undefined);

export interface CompileGraphWgslOptions {
  /** Whether the material sways in the wind (wind.ts windSwayOf): its kind moves the vertices. */
  sways?: boolean;
}

export interface GraphField {
  name: string;
  kind: MaterialUniformSpec["kind"];
  /** In bytes. */
  offset: number;
  /** The material's own value this holds (the property's name), rather than a graph uniform. */
  own?: string;
}

export interface GraphTexture {
  name: string;
  slot: TextureSlot;
  /** The material's own map this reads (the property's name), rather than a graph uniform's texture. */
  own?: string;
}

export interface CompiledGraphWgsl {
  /** Changes only when the shader would: the same wiring and static settings make the same code. */
  key: string;
  id: string;
  wgsl: string;
  displaces: boolean;
  /** Whether its `displace()` reads the vertex it moves (SurfaceKind.readsVertex): a graph's vertex offset does. */
  readsVertex: boolean;
  /** Whether it moves the vertices in the wind. */
  sways: boolean;
  /** The parts of a physical surface it carries. */
  layers: PhysicalFeature[];
  fields: GraphField[];
  textures: GraphTexture[];
  /** How large a uniform buffer it needs, in bytes. */
  bytes: number;
  /** Whether it reads the time, so it changes from frame to frame. */
  animated: boolean;
  worldBinding: number;
}

const hashOf = (text: string): string => {
  const fnv = (seed: number) => {
    let hash = seed >>> 0;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  };
  return `${fnv(0x811c9dc5)}${fnv(0x01000193)}`;
};

/** Whether surfaces can tell which instance they are on (shaders.ts SurfaceIn.instanceId). */
const PROBE_KIND = { id: "probe", wgsl: "", layoutEntries: () => [], textures: () => [], bindGroupEntries: () => [], pack: () => undefined } satisfies SurfaceKind;
const surfaceKnowsInstance = (): boolean => /struct SurfaceIn \{[^}]*\binstanceId\b/.test(forwardHead(PROBE_KIND));

const fragmentContext = (specs: readonly MaterialUniformSpec[], functions: Record<string, GlslFunction>, called: (name: string) => void): GlslContext => ({
  stage: "fragment",
  variables: {
    ...graphUniformVariables(specs),
    uMaterialTime: { code: "material.time", type: "float" },
    cameraPosition: { code: "view.eye.xyz", type: "vec3" },
    vUv: { code: "mgIn.uv0", type: "vec2" },
    vMgWorldPosition: { code: "mgIn.worldPosition", type: "vec3" },
    vMgLocalPosition: { code: "mgLocalPosition()", type: "vec3" },
    vMgObjectPosition: { code: "mgObjectPosition()", type: "vec3" },
    vMgLocalNormal: { code: "mgLocalNormal()", type: "vec3" },
    // Nodes work out tangent frames with these. Around the camera in the world gives what they do around it in view space.
    vViewPosition: { code: "(view.eye.xyz - mgIn.worldPosition)", type: "vec3" },
  },
  textures: graphTextureNames(specs),
  functions: {
    ...functions,
    mgWorldNormal: { returns: "vec3" },
    mgViewNormal: { code: "mgWorldNormal", returns: "vec3" },
    mgVertexColor: { returns: "vec3" },
    mgSunDirection: { returns: "vec3" },
  },
  called,
});

const vertexContext = (specs: readonly MaterialUniformSpec[], functions: Record<string, GlslFunction>, called: (name: string) => void): GlslContext => ({
  stage: "vertex",
  variables: {
    ...graphUniformVariables(specs),
    uMaterialTime: { code: "material.time", type: "float" },
    cameraPosition: { code: "view.eye.xyz", type: "vec3" },
    uv: { code: "vec2f(displaceVertex.u0, displaceVertex.v0)", type: "vec2" },
    mgVertexLocal: { code: "mgVertexLocal", type: "vec3" },
    mgVertexWorld: { code: "mgVertexWorld", type: "vec3" },
    mgVertexOrigin: { code: "mgVertexOrigin", type: "vec3" },
    mgVertexWorldNormal: { code: "mgVertexWorldNormal", type: "vec3" },
    MG_OBJECT_NORMAL: { code: "mgObjectNormal", type: "vec3" },
  },
  textures: graphTextureNames(specs),
  functions: {
    ...functions,
    ...Object.fromEntries(Object.entries(VERTEX_HELPERS).map(([name, vertexName]) => [name, { ...functions[name], code: vertexName }])),
    mgVertexColorAttribute: { returns: "vec3" },
  },
  called: (name) => called(VERTEX_HELPERS[name] ?? name),
});

const graphUniformVariables = (specs: readonly MaterialUniformSpec[]): Record<string, { code: string; type: string }> => {
  const variables: Record<string, { code: string; type: string }> = {};
  for (const spec of specs) {
    if (spec.kind === "texture") continue;
    variables[spec.name] = { code: `material.${spec.name}`, type: spec.kind === "ramp" ? RAMP_TYPE : spec.kind === "color" ? "vec3" : spec.kind };
  }
  return variables;
};

const graphTextureNames = (specs: readonly MaterialUniformSpec[]): Record<string, { texture: string; sampler: string }> => {
  const textures: Record<string, { texture: string; sampler: string }> = {};
  for (const spec of specs) {
    if (spec.kind === "texture") textures[spec.name] = { texture: spec.name, sampler: `${spec.name}_sampler` };
  }
  return textures;
};

/** GLSL without its comments: the compiler marks each node's code with them (runtime/materials/shaderErrors.ts). */
const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** A global function's return type and name. */
const functionHeader = (source: string): RegExpExecArray | null => /^\s*(\w+)\s+(\w+)\s*\(/.exec(withoutComments(source));

/**
 * A Custom GLSL node's function, or one giving nothing when its code cannot be used: the rest of the graph still draws.
 * Either way it becomes one of `functions`, for the code translated after it to call.
 */
const translateGlobal = (source: string, functions: Record<string, GlslFunction>, context: GlslContext): string => {
  const header = functionHeader(source);
  try {
    const translated = new GlslTranslator(context).fn(source);
    // The translator makes the function known to the context it was given, a copy for this stage.
    if (header && context.functions[header[2]]) functions[header[2]] = context.functions[header[2]];
    return translated;
  } catch (error) {
    if (!header || !(error instanceof GlslError)) throw error;
    reportGpu(`[gpu] A Custom GLSL node's code cannot be used: ${error.message}`);
    functions[header[2]] = { returns: header[1], params: ["vec4", "vec4", "vec4", "vec4"] };
    return `fn ${header[2]}(a: vec4f, b: vec4f, c: vec4f, d: vec4f) -> ${wgslType(header[1])} { return ${wgslType(header[1])}(); }`;
  }
};

const FIRST_SUN_NORMALIZED = /normalize\(\s*inverseTransformDirection\(\s*directionalLights\[0\]\.direction\s*,\s*viewMatrix\s*\)\s*\)/g;
const FIRST_SUN = /inverseTransformDirection\(\s*directionalLights\[0\]\.direction\s*,\s*viewMatrix\s*\)/g;

/**
 * What nodes' GLSL reads of three's own lights, in this path's terms. Parallax shades toward the first sun, which three
 * gives in view space, behind a check that there is one: here mgSunDirection() is that direction in the world, and
 * nothing where there is no sun, which the code reading it takes as no light, so the check goes. Any other
 * preprocessor line is left for the translator to refuse.
 */
const withThreesLightsTranslated = (statements: readonly string[]): string[] => {
  const kept: string[] = [];
  const dropped: boolean[] = [];
  for (const line of statements.flatMap((statement) => statement.split("\n"))) {
    const directive = /^\s*#\s*(\w+)\s*(.*?)\s*$/.exec(line);
    if (!directive) {
      kept.push(line.replace(FIRST_SUN_NORMALIZED, "mgSunDirection()").replace(FIRST_SUN, "mgSunDirection()"));
      continue;
    }
    const [, word, rest] = directive;
    if (word === "if" && /^NUM_DIR_LIGHTS\s*>\s*0$/.test(rest)) {
      dropped.push(true);
      continue;
    }
    if (word.startsWith("if")) dropped.push(false);
    else if (word === "endif" && dropped.pop()) continue;
    kept.push(line);
  }
  return kept;
};

/**
 * A graph as a surface kind's code. Throws if the nodes' code cannot be translated, which is a fault in a node definition,
 * not in anything a person wrote: that only reaches a Custom GLSL node's function, which is replaced above.
 */
export const compileGraphWgsl = (graph: MaterialGraph, options: CompileGraphWgslOptions = {}): CompiledGraphWgsl => {
  const settings = materialGraphSettings(graph);
  const sways = options.sways === true;
  // An unlit graph shows its colour as it is: the WebGL path sets a physical surface up only for its lighting.
  const layers = settings.unlit ? [] : graphLayers(graph);
  const outputs = [...STAGE_OUTPUTS.fragment, ...layers.flatMap((feature) => LAYER_OUTPUTS[feature] ?? [])];
  const fragment = compileMaterialGraph(graph, { stage: "fragment", outputs });
  const vertex: CompiledMaterialGraph | null = fragment.connected.has("worldPositionOffset") ? compileMaterialGraph(graph, { stage: "vertex" }) : null;
  // Keeping the model's own maps, each unwired input it covers is read from the material.
  const own = (settings.keepOwnMaps && !settings.unlit
    ? (Object.keys(OWN_READS) as Array<keyof typeof OWN_READS>).filter((input) => OWN_READS[input].unless.every((wired) => !fragment.connected.has(wired)))
    : []);
  const key = [fragment.key, vertex?.key ?? "-", settings.blendMode === "opaque", settings.unlit, settings.normalSpace, layers.join(","), sways ? "wind" : "still", `own:${own.join(",")}`].join("#");

  const specs = new Map<string, MaterialUniformSpec>();
  for (const stage of [fragment, vertex]) for (const spec of stage?.uniforms ?? []) specs.set(spec.name, spec);
  const all = [...specs.values()];

  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const textures: GraphTexture[] = all.filter((spec) => spec.kind === "texture").map((spec) => ({ name: spec.name, slot: textureSlot(nodes.get(spec.nodeId)!) }));
  for (const input of own) textures.push(...OWN_READS[input].textures);

  // The numbers' places, in the order WGSL lays out a struct: the graph's, then the material's own it reads.
  const fields: GraphField[] = [];
  let offset = FIELDS_START;
  const numbers: Array<{ name: string; kind: MaterialUniformSpec["kind"]; own?: string }> = [
    ...all.filter((spec) => spec.kind !== "texture").map((spec) => ({ name: spec.name, kind: spec.kind })),
    ...own.flatMap((input) => OWN_READS[input].fields),
  ];
  for (const number of numbers) {
    const layout = FIELD_LAYOUT[number.kind];
    offset = Math.ceil(offset / layout.align) * layout.align;
    fields.push({ name: number.name, kind: number.kind, offset, ...(number.own ? { own: number.own } : {}) });
    offset += layout.size;
  }
  const bytes = Math.ceil(offset / 16) * 16;

  const needed = new Set<string>([...fragment.helpers, ...(vertex?.helpers ?? [])]);
  const called = (name: string) => { needed.add(name); };
  const functions = helperFunctions();

  // Each function once: a node feeding both stages gives the same one to each.
  const globals = new Map<string, string>();
  const translateGlobals = (stage: CompiledMaterialGraph | null, context: () => GlslContext) => {
    for (const source of stage?.globals ?? []) {
      const name = functionHeader(source)?.[2] ?? source;
      if (!globals.has(name)) globals.set(name, translateGlobal(source, functions, context()));
    }
  };
  translateGlobals(fragment, () => fragmentContext(all, functions, called));
  translateGlobals(vertex, () => vertexContext(all, functions, called));

  const surfaceTranslator = new GlslTranslator(fragmentContext(all, functions, called));
  const statements = surfaceTranslator.statements(withThreesLightsTranslated(fragment.statements).join("\n"));
  const output = (name: string, type: string) => surfaceTranslator.expression(fragment.outputs[name], type);
  const ownTexel = (name: string, channels: string) => `textureSample(${name}, ${name}_sampler, mgIn.uv0).${channels}`;
  const baseColor = own.includes("baseColor") ? `material.mgOwnColor * ${ownTexel("mgOwnMap", "rgb")}` : output("baseColor", "vec3");
  const opacity = settings.blendMode === "opaque" ? "1.0" : output("opacity", "float");
  const metalness = own.includes("metalness") ? `material.mgOwnMetalness * ${ownTexel("mgOwnMetalnessMap", "b")}` : output("metalness", "float");
  const roughness = own.includes("roughness") ? `material.mgOwnRoughness * ${ownTexel("mgOwnRoughnessMap", "g")}` : output("roughness", "float");
  const emissive = own.includes("emissive") ? `material.mgOwnEmissive * ${ownTexel("mgOwnEmissiveMap", "rgb")}` : output("emissive", "vec3");
  const emissiveStrength = own.includes("emissive") ? "material.mgOwnEmissiveIntensity" : output("emissiveStrength", "float");
  const occlusion = output("occlusion", "float");
  const ownNormal = own.includes("normal");
  const normal = fragment.connected.has("normal") ? output("normal", "vec3") : ownNormal ? "mgOwnNormal()" : null;
  // A world-space normal (Triplanar Normal Map) is the surface's normal as it is; a tangent-space one is a normal map's.
  const mapped = !normal ? "" : settings.normalSpace === "world" && !ownNormal
    ? `out.normal = normalize(${normal});`
    : `let mgMapped = ${normal};\n  out.normal = mappedNormal(in, out.normal, vec3f(mgMapped.xy * material.normalScale, mgMapped.z), in.uv0);`;
  // How much of the direct light its own relief lets through (Parallax's shadow).
  const selfShadow = fragment.connected.has("selfShadow") ? `out.selfShadow = clamp(${output("selfShadow", "float")}, 0.0, 1.0);` : "";
  // A graph reading the vertex colours uses them as it likes: they are not multiplied in again.
  const albedo = fragment.builtins.has("vertexColor") ? `(${baseColor})` : `(${baseColor}) * mgVertexColor()`;

  // The coat, sheen and transmission it works out, as physicalLayers.ts takes them; a part it does not use is none.
  const layer = (feature: PhysicalFeature, value: () => string, none: string) => (layers.includes(feature) ? value() : none);
  const over = layers.some((feature) => OVER_LAYERS.includes(feature));
  // Its specular and thin film first: they change what the surface reflects, under any coat.
  const lobe = layers.includes("specular") || layers.includes("thinFilm");
  const ior = layer("specular", () => output("ior", "float"), "1.5");
  const lobeCall = lobe ? /* wgsl */ `
  out = applyPhysicalLobe(in, out, PhysicalLobe(
    ${layer("specular", () => `min(vec3f(((${ior}) - 1.0) / ((${ior}) + 1.0) * (((${ior}) - 1.0) / ((${ior}) + 1.0))) * max(${output("specularColor", "vec3")}, vec3f(0.0)), vec3f(1.0)) * clamp(${output("specularWeight", "float")}, 0.0, 1.0)`, "vec3f(0.04)")},
    ${layer("thinFilm", () => `clamp(${output("thinFilm", "float")}, 0.0, 1.0)`, "0.0")},
    ${layer("thinFilm", () => `max(${output("thinFilmThickness", "float")}, 0.0)`, "0.0")},
  ));` : "";
  const physical = lobeCall + (over ? /* wgsl */ `
  out = applyPhysicalLayers(in, out, PhysicalLayers(
    ${layer("coat", () => `clamp(${output("coat", "float")}, 0.0, 1.0)`, "0.0")},
    ${layer("coat", () => `clamp(${output("coatRoughness", "float")}, 0.0, 1.0)`, "0.0")},
    ${layer("sheen", () => `max(${output("sheenColor", "vec3")}, vec3f(0.0))`, "vec3f(0.0)")},
    ${layer("sheen", () => `clamp(${output("sheenRoughness", "float")}, 0.07, 1.0)`, "1.0")},
    ${layer("transmission", () => `clamp(${output("transmission", "float")}, 0.0, 1.0)`, "0.0")},
    ${layer("coat", () => `clamp(${output("coatColor", "vec3")}, vec3f(0.0), vec3f(1.0))`, "vec3f(1.0)")},
  ), (material.flags & ${GRAPH_FLAG.blended}u) != 0u);` : "");

  // The wind moves a vertex from where the graph's vertex offset left it, as on the WebGL path.
  const windMove = (at: string) => `instanceLocalDirection(instance, windOffset(${at}, instance, material.wind.x, material.wind.y, material.wind.z, material.wind.w))`;
  let displace = "";
  if (vertex) {
    const vertexTranslator = new GlslTranslator(vertexContext(all, functions, called));
    const vertexStatements = vertexTranslator.statements(vertex.statements.join("\n"));
    const worldOffset = vertexTranslator.expression(vertex.outputs.worldPositionOffset, "vec3");
    displace = /* wgsl */ `
var<private> displaceVertex: Vertex;
var<private> mgVertexLocal: vec3f;
var<private> mgVertexWorld: vec3f;
var<private> mgVertexOrigin: vec3f;
var<private> mgVertexWorldNormal: vec3f;
var<private> mgObjectNormal: vec3f;

fn mgVertexColorAttribute() -> vec3f {
  let wanted = (material.flags & ${GRAPH_FLAG.vertexColors}u) != 0u && displaceVertex.color != 0u;
  return select(vec3f(1.0), unpack4x8unorm(displaceVertex.color).rgb, wanted);
}

fn displace(local: vec3f, normal: vec3f, instance: Instance, time: f32) -> vec3f {
  mgVertexLocal = local;
  mgObjectNormal = normal;
  mgVertexWorld = worldOf(instance, local);
  mgVertexOrigin = vec3f(instance.world0.w, instance.world1.w, instance.world2.w);
  mgVertexWorldNormal = worldNormalOf(instance, normal);
  ${vertexStatements}
  let mgOffsetLocal = local + instanceLocalDirection(instance, ${worldOffset});
  return ${sways ? `mgOffsetLocal + ${windMove("mgOffsetLocal")}` : "mgOffsetLocal"};
}
`;
  } else if (sways) {
    displace = /* wgsl */ `
fn displace(local: vec3f, normal: vec3f, instance: Instance, time: f32) -> vec3f {
  return local + ${windMove("local")};
}
`;
  }

  // What the pixels read of where they are on the object comes from the instance, when surfaces can tell which one it is.
  const knowsInstance = surfaceKnowsInstance();
  const objectBuiltins = knowsInstance ? /* wgsl */ `
fn mgLocalPosition() -> vec3f { return instanceLocalPoint(instances[mgIn.instanceId], mgIn.worldPosition); }
fn mgObjectPosition() -> vec3f {
  let instance = instances[mgIn.instanceId];
  return vec3f(instance.world0.w, instance.world1.w, instance.world2.w);
}
fn mgLocalNormal() -> vec3f { return normalize(instanceLocalDirection(instances[mgIn.instanceId], mgIn.normal)); }
` : /* wgsl */ `
fn mgLocalPosition() -> vec3f { return mgIn.worldPosition; }
fn mgObjectPosition() -> vec3f { return vec3f(0.0); }
fn mgLocalNormal() -> vec3f { return mgIn.normal; }
`;

  const worldBinding = 1 + textures.length * 2;
  const fieldDeclarations = fields.map((field) => `  ${field.name}: ${FIELD_LAYOUT[field.kind].type},`).join("\n");
  const textureDeclarations = textures.map((texture, index) => [
    `@group(2) @binding(${1 + index * 2}) var ${texture.name}: texture_2d<f32>;`,
    `@group(2) @binding(${2 + index * 2}) var ${texture.name}_sampler: sampler;`,
  ].join("\n")).join("\n");

  const wgsl = /* wgsl */ `
struct GraphMaterial {
  time: f32,
  alphaTest: f32,
  flags: u32,
  pad: f32,
  normalScale: vec2f,
  pad2: vec2f,
  // How it sways, and where its plant stands (wind.ts).
  wind: vec4f,
${fieldDeclarations}
}
@group(2) @binding(0) var<uniform> material: GraphMaterial;
${textureDeclarations}
${worldWgsl(worldBinding)}
${STIPPLE_WGSL}
${WEATHER_WGSL}
${BAKED_VOLUME_WGSL}
${MAPPED_NORMAL_WGSL}
${over ? PHYSICAL_LAYERS_WGSL : ""}
${lobe ? PHYSICAL_LOBE_WGSL : ""}
${vertex || sways || knowsInstance ? INSTANCE_INVERSE_WGSL : ""}
${sways ? WIND_WGSL : ""}

var<private> mgIn: SurfaceIn;

fn mgWorldNormal() -> vec3f { return select(mgIn.normal, mgIn.geometricNormal, (material.flags & ${GRAPH_FLAG.flatShading}u) != 0u); }
// Toward the first sun, in the world; nothing where there is none (world.ts).
fn mgSunDirection() -> vec3f { return surfaceWorld.sun.xyz; }
// The colours three's own shader would multiply in: the vertices', when the material uses them, and the instance's.
fn mgVertexColor() -> vec3f {
  return select(vec3f(1.0), mgIn.vertexColor.rgb, (material.flags & ${GRAPH_FLAG.vertexColors}u) != 0u) * mgIn.instanceColor.rgb;
}
${objectBuiltins}
${helperSource(needed)}
${ownNormal ? OWN_NORMAL_WGSL : ""}
${[...globals.values()].join("\n")}
${displace}

@diagnostic(off, derivative_uniformity)
fn surface(in: SurfaceIn) -> SurfaceOut {
  mgIn = in;
  var out = surfaceDefaults(in);
  ${statements}
  out.albedo = ${albedo};
  out.opacity = ${opacity};
  out.alphaTest = material.alphaTest;
  out.metalness = clamp(${metalness}, 0.0, 1.0);
  out.roughness = clamp(${roughness}, 0.0, 1.0);
  out.emissive = (${emissive}) * (${emissiveStrength});
  out.occlusion = ${occlusion};
  out.normal = mgWorldNormal();
  ${mapped}
  ${selfShadow}
  out.unlit = ${settings.unlit};
  ${physical}
  if ((material.flags & ${GRAPH_FLAG.takesWeather}u) != 0u) { out = applyWeather(in, out); }
  return applyBakedVolume(in, out);
}
`;

  return {
    key,
    id: `graph-${hashOf(key)}`,
    wgsl,
    displaces: vertex !== null || sways,
    readsVertex: vertex !== null,
    sways,
    layers,
    fields,
    textures,
    bytes,
    animated: fragment.builtins.has("time") || !!vertex?.builtins.has("time"),
    worldBinding,
  };
};
