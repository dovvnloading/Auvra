/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { packTransform, textureBindEntries, textureLayoutEntries, type SurfaceKind } from "../surfaces";

/**
 * THE REST OF THREE'S MATERIALS
 *
 * Materials whose look is not a surface taking light, so that the standard surface would draw them as something else:
 * the two that show their geometry's numbers, the one that reads a picture of a lit ball, the one that is only shadow,
 * and dashed lines. What three.js writes for the first two goes straight to the screen, which is why they skip the tone
 * mapping (materialPool.ts).
 */

const uniformOnly: Pick<SurfaceKind, "layoutEntries" | "textures" | "bindGroupEntries"> = {
  layoutEntries: () => textureLayoutEntries(0),
  textures: () => [],
  bindGroupEntries: (input) => [{ binding: 0, resource: input.uniform }],
};

const SHOWN_LINEAR_WGSL = /* wgsl */ `
fn shownLinear(value: vec3f) -> vec3f {
  return select(pow((value + vec3f(0.055)) / 1.055, vec3f(2.4)), value / 12.92, value <= vec3f(0.04045));
}
`;

// --- NORMALS ---

const NORMAL_WGSL = /* wgsl */ `
struct Shown { opacity: vec4f }
@group(2) @binding(0) var<uniform> shown: Shown;
${SHOWN_LINEAR_WGSL}

fn surface(in: SurfaceIn) -> SurfaceOut {
  var out = surfaceDefaults(in);
  let m = view.viewMatrix;
  let viewNormal = normalize(vec3f(dot(vec3f(m[0][0], m[1][0], m[2][0]), in.normal), dot(vec3f(m[0][1], m[1][1], m[2][1]), in.normal), dot(vec3f(m[0][2], m[1][2], m[2][2]), in.normal)));
  out.albedo = shownLinear(viewNormal * 0.5 + vec3f(0.5));
  out.opacity = shown.opacity.x;
  out.unlit = true;
  return out;
}
`;

const packOpacity: SurfaceKind["pack"] = (material, floats) => {
  floats[0] = material.opacity;
};

const NORMAL_SURFACE: SurfaceKind = { id: "show-normals", wgsl: NORMAL_WGSL, ...uniformOnly, pack: packOpacity };

// --- DEPTH ---

const DEPTH_WGSL = /* wgsl */ `
struct Shown { opacity: vec4f }
@group(2) @binding(0) var<uniform> shown: Shown;
${SHOWN_LINEAR_WGSL}

fn surface(in: SurfaceIn) -> SurfaceOut {
  var out = surfaceDefaults(in);
  // Reversed depth is the one minus what three.js writes for its plain packing, which is what is shown.
  let clip = view.viewProjection * vec4f(in.worldPosition, 1.0);
  out.albedo = shownLinear(vec3f(saturate(clip.z / clip.w)));
  out.opacity = shown.opacity.x;
  out.unlit = true;
  return out;
}
`;

const DEPTH_SURFACE: SurfaceKind = { id: "show-depth", wgsl: DEPTH_WGSL, ...uniformOnly, pack: packOpacity };

// --- MATCAP ---

const MATCAP_WGSL = /* wgsl */ `
struct Matcap { color: vec4f, map0: vec4f, map1: vec4f }
@group(2) @binding(0) var<uniform> look: Matcap;
@group(2) @binding(1) var mapTexture: texture_2d<f32>;
@group(2) @binding(2) var mapSampler: sampler;
@group(2) @binding(3) var matcapTexture: texture_2d<f32>;
@group(2) @binding(4) var matcapSampler: sampler;

fn surface(in: SurfaceIn) -> SurfaceOut {
  var out = surfaceDefaults(in);
  let m = view.viewMatrix;
  let normal = normalize(vec3f(dot(vec3f(m[0][0], m[1][0], m[2][0]), in.normal), dot(vec3f(m[0][1], m[1][1], m[2][1]), in.normal), dot(vec3f(m[0][2], m[1][2], m[2][2]), in.normal)));
  let toEye = normalize(vec3f(dot(vec3f(m[0][0], m[1][0], m[2][0]), in.viewDirection), dot(vec3f(m[0][1], m[1][1], m[2][1]), in.viewDirection), dot(vec3f(m[0][2], m[1][2], m[2][2]), in.viewDirection)));
  // A frame around the line to the eye, as three.js makes it.
  let across = normalize(vec3f(toEye.z, 0.0, -toEye.x));
  let up = cross(toEye, across);
  let at = vec2f(dot(across, normal), dot(up, normal)) * 0.495 + vec2f(0.5);
  let uv = vec2f(dot(look.map0.xyz, vec3f(in.uv0, 1.0)), dot(look.map1.xyz, vec3f(in.uv0, 1.0)));
  let mapped = textureSample(mapTexture, mapSampler, uv);
  let lit = textureSample(matcapTexture, matcapSampler, vec2f(at.x, 1.0 - at.y));
  out.albedo = look.color.rgb * mapped.rgb * lit.rgb * in.instanceColor.rgb;
  out.opacity = look.color.a * mapped.a;
  out.alphaTest = look.map0.w;
  out.unlit = true;
  return out;
}
`;

const MATCAP_SURFACE: SurfaceKind = {
  id: "matcap",
  wgsl: MATCAP_WGSL,
  layoutEntries: () => textureLayoutEntries(2),
  textures: (material) => {
    const m = material as THREE.MeshMatcapMaterial;
    return [m.map, m.matcap];
  },
  bindGroupEntries: (input) => textureBindEntries(input, [input.pool.white, input.pool.white]),
  pack(material, floats) {
    const m = material as THREE.MeshMatcapMaterial;
    m.color.toArray(floats, 0);
    floats[3] = m.opacity;
    packTransform(floats, 4, m.map);
    floats[7] = m.alphaTest;
  },
};

// --- ONLY THE SHADOW ---

const SHADOW_ONLY_WGSL = /* wgsl */ `
struct ShadowOnly { color: vec4f }
@group(2) @binding(0) var<uniform> look: ShadowOnly;

fn surface(in: SurfaceIn) -> SurfaceOut {
  var out = surfaceDefaults(in);
  out.albedo = look.color.rgb;
  out.emissive = look.color.rgb;
  out.opacity = look.color.a;
  out.catchesShadow = true;
  return out;
}
`;

const SHADOW_ONLY_SURFACE: SurfaceKind = {
  id: "shadow-only",
  wgsl: SHADOW_ONLY_WGSL,
  ...uniformOnly,
  pack(material, floats) {
    const m = material as THREE.ShadowMaterial;
    m.color.toArray(floats, 0);
    floats[3] = m.opacity;
  },
};

// --- DASHES ---

const DASHED_WGSL = /* wgsl */ `
struct Dashes { color: vec4f, pattern: vec4f }
@group(2) @binding(0) var<uniform> look: Dashes;

fn surface(in: SurfaceIn) -> SurfaceOut {
  var out = surfaceDefaults(in);
  out.albedo = look.color.rgb * in.instanceColor.rgb;
  out.opacity = look.color.a;
  out.unlit = true;
  // Geometry keeps a line's length so far where a second set of uvs would be.
  let along = in.uv1.x * look.pattern.x;
  out.alphaTest = select(0.0, 2.0, fract(along / look.pattern.y) * look.pattern.y > look.pattern.z);
  return out;
}
`;

const DASHED_SURFACE: SurfaceKind = {
  id: "dashed-line",
  wgsl: DASHED_WGSL,
  ...uniformOnly,
  pack(material, floats) {
    const m = material as THREE.LineDashedMaterial;
    m.color.toArray(floats, 0);
    floats[3] = m.opacity;
    floats[4] = m.scale;
    floats[5] = Math.max(m.dashSize + m.gapSize, 1e-5);
    floats[6] = m.dashSize;
  },
};

export const BUILTIN_LOOKS: readonly { test: (material: THREE.Material) => boolean; kind: SurfaceKind }[] = [
  { test: (material) => (material as THREE.MeshNormalMaterial).isMeshNormalMaterial === true, kind: NORMAL_SURFACE },
  { test: (material) => (material as THREE.MeshDepthMaterial).isMeshDepthMaterial === true, kind: DEPTH_SURFACE },
  { test: (material) => (material as THREE.MeshMatcapMaterial).isMeshMatcapMaterial === true, kind: MATCAP_SURFACE },
  { test: (material) => (material as THREE.ShadowMaterial).isShadowMaterial === true, kind: SHADOW_ONLY_SURFACE },
  { test: (material) => (material as THREE.LineDashedMaterial).isLineDashedMaterial === true, kind: DASHED_SURFACE },
];

/** Whether what a material writes goes straight to the screen, past tone mapping. */
export const skipsToneMapping = (material: THREE.Material): boolean =>
  (material as THREE.MeshNormalMaterial).isMeshNormalMaterial === true || (material as THREE.MeshDepthMaterial).isMeshDepthMaterial === true;
