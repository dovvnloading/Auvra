import {
  MAX_RAMP_STOPS,
  compileMaterialGraph,
  materialGraphSettings,
  textureSlot,
  type CompiledMaterialGraph,
  type MaterialGraph,
  type MaterialUniformSpec,
  type TextureSlot,
} from "../../../runtime/materials/materialGraph";
import { forwardHead } from "../shaders";
import { MAPPED_NORMAL_WGSL, type SurfaceKind } from "../surfaces";
import { BAKED_VOLUME_WGSL } from "./bakedVolume";
import { GLSL_SUPPORT_WGSL, GlslError, GlslTranslator, wgslType, type GlslContext, type GlslFunction } from "./glslToWgsl";
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
 */

interface WgslHelper {
  needs?: readonly string[];
  returns: string;
  params: readonly string[];
  outs?: readonly number[];
  source: string;
}

const RAMP_TYPE = `vec4[${MAX_RAMP_STOPS}]`;

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

export const GRAPH_FLAG = { vertexColors: 1, flatShading: 2 } as const;

const FIELD_LAYOUT: Readonly<Record<string, { align: number; size: number; type: string }>> = {
  float: { align: 4, size: 4, type: "f32" },
  vec2: { align: 8, size: 8, type: "vec2f" },
  vec3: { align: 16, size: 12, type: "vec3f" },
  color: { align: 16, size: 12, type: "vec3f" },
  ramp: { align: 16, size: MAX_RAMP_STOPS * 16, type: `array<vec4f, ${MAX_RAMP_STOPS}>` },
};

/** The fixed start of a graph's uniform buffer: time, alpha test, flags, then the normal scale, in bytes. */
const FIELDS_START = 24;

export interface GraphField {
  name: string;
  kind: MaterialUniformSpec["kind"];
  /** In bytes. */
  offset: number;
}

export interface GraphTexture {
  name: string;
  slot: TextureSlot;
}

export interface CompiledGraphWgsl {
  /** Changes only when the shader would: the same wiring and static settings make the same code. */
  key: string;
  id: string;
  wgsl: string;
  displaces: boolean;
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
  functions: { ...functions, mgVertexColorAttribute: { returns: "vec3" } },
  called,
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

/** A Custom GLSL node's function, or one giving nothing when its code cannot be used: the rest of the graph still draws. */
const translateGlobal = (source: string, functions: Record<string, GlslFunction>, context: GlslContext): string => {
  try {
    return new GlslTranslator(context).fn(source);
  } catch (error) {
    const header = /^\s*(\w+)\s+(\w+)\s*\(([^)]*)\)/.exec(source);
    if (!header || !(error instanceof GlslError)) throw error;
    reportGpu(`[gpu] A Custom GLSL node's code cannot be used: ${error.message}`);
    functions[header[2]] = { returns: header[1], params: ["vec4", "vec4", "vec4", "vec4"] };
    return `fn ${header[2]}(a: vec4f, b: vec4f, c: vec4f, d: vec4f) -> ${wgslType(header[1])} { return ${wgslType(header[1])}(); }`;
  }
};

/**
 * A graph as a surface kind's code. Throws if the nodes' code cannot be translated, which is a fault in a node definition,
 * not in anything a person wrote: that only reaches a Custom GLSL node's function, which is replaced above.
 */
export const compileGraphWgsl = (graph: MaterialGraph): CompiledGraphWgsl => {
  const settings = materialGraphSettings(graph);
  const fragment = compileMaterialGraph(graph, { stage: "fragment" });
  const vertex: CompiledMaterialGraph | null = fragment.connected.has("worldPositionOffset") ? compileMaterialGraph(graph, { stage: "vertex" }) : null;
  const key = [fragment.key, vertex?.key ?? "-", settings.blendMode === "opaque", settings.unlit].join("#");

  const specs = new Map<string, MaterialUniformSpec>();
  for (const stage of [fragment, vertex]) for (const spec of stage?.uniforms ?? []) specs.set(spec.name, spec);
  const all = [...specs.values()];

  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const textures: GraphTexture[] = all.filter((spec) => spec.kind === "texture").map((spec) => ({ name: spec.name, slot: textureSlot(nodes.get(spec.nodeId)!) }));

  // The numbers' places, in the order WGSL lays out a struct.
  const fields: GraphField[] = [];
  let offset = FIELDS_START;
  for (const spec of all) {
    if (spec.kind === "texture") continue;
    const layout = FIELD_LAYOUT[spec.kind];
    offset = Math.ceil(offset / layout.align) * layout.align;
    fields.push({ name: spec.name, kind: spec.kind, offset });
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
      const name = /^\s*\w+\s+(\w+)/.exec(source)?.[1] ?? source;
      if (!globals.has(name)) globals.set(name, translateGlobal(source, functions, context()));
    }
  };
  translateGlobals(fragment, () => fragmentContext(all, functions, called));
  translateGlobals(vertex, () => vertexContext(all, functions, called));

  const surfaceTranslator = new GlslTranslator(fragmentContext(all, functions, called));
  const statements = surfaceTranslator.statements(fragment.statements.join("\n"));
  const output = (name: string, type: string) => surfaceTranslator.expression(fragment.outputs[name], type);
  const baseColor = output("baseColor", "vec3");
  const opacity = settings.blendMode === "opaque" ? "1.0" : output("opacity", "float");
  const metalness = output("metalness", "float");
  const roughness = output("roughness", "float");
  const emissive = output("emissive", "vec3");
  const occlusion = output("occlusion", "float");
  const normal = fragment.connected.has("normal") ? output("normal", "vec3") : null;

  let displace = "";
  if (vertex) {
    const vertexTranslator = new GlslTranslator(vertexContext(all, functions, called));
    const vertexStatements = vertexTranslator.statements(vertex.statements.join("\n"));
    const worldOffset = vertexTranslator.expression(vertex.outputs.worldPositionOffset, "vec3");
    displace = /* wgsl */ `
${INSTANCE_INVERSE_WGSL}
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
  return local + instanceLocalDirection(instance, ${worldOffset});
}
`;
  }

  // What the pixels read of where they are on the object comes from the instance, when surfaces can tell which one it is.
  const knowsInstance = surfaceKnowsInstance();
  const objectBuiltins = knowsInstance ? /* wgsl */ `
${vertex ? "" : INSTANCE_INVERSE_WGSL}
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
  const fieldDeclarations = all.filter((spec) => spec.kind !== "texture").map((spec) => `  ${spec.name}: ${FIELD_LAYOUT[spec.kind].type},`).join("\n");
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
${fieldDeclarations}
}
@group(2) @binding(0) var<uniform> material: GraphMaterial;
${textureDeclarations}
${worldWgsl(worldBinding)}
${STIPPLE_WGSL}
${BAKED_VOLUME_WGSL}
${MAPPED_NORMAL_WGSL}

var<private> mgIn: SurfaceIn;

fn mgWorldNormal() -> vec3f { return select(mgIn.normal, mgIn.geometricNormal, (material.flags & ${GRAPH_FLAG.flatShading}u) != 0u); }
fn mgVertexColor() -> vec3f { return select(vec3f(1.0), mgIn.vertexColor.rgb, (material.flags & ${GRAPH_FLAG.vertexColors}u) != 0u); }
${objectBuiltins}
${helperSource(needed)}
${[...globals.values()].join("\n")}
${displace}

@diagnostic(off, derivative_uniformity)
fn surface(in: SurfaceIn) -> SurfaceOut {
  mgIn = in;
  var out = surfaceDefaults(in);
  ${statements}
  out.albedo = (${baseColor}) * mgVertexColor() * in.instanceColor.rgb;
  out.opacity = ${opacity};
  out.alphaTest = material.alphaTest;
  out.metalness = clamp(${metalness}, 0.0, 1.0);
  out.roughness = clamp(${roughness}, 0.0, 1.0);
  out.emissive = ${emissive};
  out.occlusion = ${occlusion};
  out.normal = mgWorldNormal();
  ${normal ? `let mgMapped = ${normal};\n  out.normal = mappedNormal(in, out.normal, vec3f(mgMapped.xy * material.normalScale, mgMapped.z), in.uv0);` : ""}
  out.unlit = ${settings.unlit};
  return applyBakedVolume(in, out);
}
`;

  return {
    key,
    id: `graph-${hashOf(key)}`,
    wgsl,
    displaces: vertex !== null,
    fields,
    textures,
    bytes,
    animated: fragment.builtins.has("time") || !!vertex?.builtins.has("time"),
    worldBinding,
  };
};
