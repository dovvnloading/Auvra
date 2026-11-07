/// <reference types="@webgpu/types" />
import * as THREE from "three";
import type { TextureEntry, TexturePool } from "./texturePool";

/**
 * SURFACES
 *
 * What a pixel of a material looks like, separate from how it is lit. A surface kind is a piece of WGSL
 * declaring its bindings in group 2 and a function `surface(in: SurfaceIn) -> SurfaceOut`; the passes
 * (shaders.ts) compile it into a surface-buffer shader, a shadow shader and a forward shader. Terrain, water
 * or a material graph are other kinds beside the standard one: each brings its code and how to pack its numbers.
 * A kind may also move vertices with `displace`, which every pass that draws it then runs.
 */

export interface SurfaceBindInput {
  uniform: GPUBufferBinding;
  maps: (TextureEntry | null)[];
  pool: TexturePool;
  material: THREE.Material;
}

export interface SurfaceKind {
  /** Names the WGSL below: two kinds with the same id must be the same code. */
  readonly id: string;
  /** Declares group(2) bindings, `surface()` and, with `displaces`, `displace()`. */
  readonly wgsl: string;
  /** Whether the kind defines `displace()`. */
  readonly displaces?: boolean;
  /**
   * Whether its `displace()` reads the vertex it moves from its own `var<private> displaceVertex: Vertex`, for the uv
   * and colour `displace()` is not handed.
   */
  readonly readsVertex?: boolean;
  layoutEntries(): GPUBindGroupLayoutEntry[];
  textures(material: THREE.Material): (THREE.Texture | null | undefined)[];
  bindGroupEntries(input: SurfaceBindInput): GPUBindGroupEntry[];
  pack(material: THREE.Material, floats: Float32Array, words: Uint32Array, maps: (TextureEntry | null)[]): void;
}

/** Flags a surface reads from `material.flags`. */
export const MATERIAL_FLAG = {
  hasMap: 1,
  hasNormalMap: 2,
  hasRoughnessMap: 4,
  hasMetalnessMap: 8,
  hasAoMap: 16,
  hasEmissiveMap: 32,
  hasAlphaMap: 64,
  hasLightMap: 128,
  vertexColors: 256,
  flatShading: 512,
  unlit: 1024,
  doubleSided: 2048,
  backSide: 4096,
  alphaToCoverage: 8192,
  normalMapObjectSpace: 16384,
  hasBumpMap: 32768,
  /** It takes the rain and snow (surfaces/weather.ts). */
  takesWeather: 65536,
  /** It blends in the forward pass rather than being a solid part of the surface buffer. */
  transparent: 131072,
} as const;

/** A uniform slice and a run of texture and sampler pairs: the layout most kinds need. */
export const textureLayoutEntries = (textureCount: number, visibility: GPUShaderStageFlags = 3): GPUBindGroupLayoutEntry[] => {
  const entries: GPUBindGroupLayoutEntry[] = [{ binding: 0, visibility, buffer: { type: "uniform" } }];
  for (let index = 0; index < textureCount; index++) {
    entries.push({ binding: 1 + index * 2, visibility, texture: { sampleType: "float" } });
    entries.push({ binding: 2 + index * 2, visibility, sampler: { type: "filtering" } });
  }
  return entries;
};

/** Entries for that layout: a missing map binds `fallbacks[index]`. */
export const textureBindEntries = (input: SurfaceBindInput, fallbacks: TextureEntry[]): GPUBindGroupEntry[] => {
  const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: input.uniform }];
  fallbacks.forEach((fallback, index) => {
    const map = input.maps[index] ?? fallback;
    entries.push({ binding: 1 + index * 2, resource: map.view });
    entries.push({ binding: 2 + index * 2, resource: map.sampler });
  });
  return entries;
};

/** Writes a texture's uv transform as two rows, at `at`. */
export const packTransform = (floats: Float32Array, at: number, texture: THREE.Texture | null | undefined): void => {
  if (!texture) {
    floats[at] = 1;
    floats[at + 5] = 1;
    return;
  }
  if (texture.matrixAutoUpdate) texture.updateMatrix();
  const e = texture.matrix.elements;
  floats[at] = e[0];
  floats[at + 1] = e[3];
  floats[at + 2] = e[6];
  floats[at + 3] = texture.channel ?? 0;
  floats[at + 4] = e[1];
  floats[at + 5] = e[4];
  floats[at + 6] = e[7];
};

/**
 * A normal-map texel in the space around the surface, by the tangent when the mesh has one and otherwise by how the
 * position and the uv change across the pixel. The derivatives are taken first, in whatever flow the caller is in, so
 * no choice about the pixel comes before them.
 */
export const MAPPED_NORMAL_WGSL = /* wgsl */ `
fn mappedNormal(in: SurfaceIn, normal: vec3f, texel: vec3f, uv: vec2f) -> vec3f {
  let dpx = dpdx(in.worldPosition);
  let dpy = dpdy(in.worldPosition);
  let dux = dpdx(uv);
  let duy = dpdy(uv);
  if (dot(in.tangent, in.tangent) > 0.0) {
    let t = normalize(in.tangent - normal * dot(normal, in.tangent));
    let b = cross(normal, t) * in.bitangentSign;
    return normalize(t * texel.x + b * texel.y + normal * texel.z);
  }
  let dp2perp = cross(dpy, normal);
  let dp1perp = cross(normal, dpx);
  let tangent = dp2perp * dux.x + dp1perp * duy.x;
  let bitangent = dp2perp * dux.y + dp1perp * duy.y;
  let scale = max(dot(tangent, tangent), dot(bitangent, bitangent));
  if (scale <= 0.0) { return normal; }
  let inverse = inverseSqrt(scale);
  return normalize(tangent * inverse * texel.x + bitangent * inverse * texel.y + normal * texel.z);
}
`;

/**
 * The standard surface as a function, `standardSurface`, for kinds that build on it. Word 84 onward (`extra`) is theirs:
 * what a physical material or a swaying one adds (surfaces/lit.ts).
 */
export const STANDARD_BODY_WGSL = /* wgsl */ `
struct StandardMaterial {
  color: vec4f,
  emissive: vec4f,
  params: vec4f,
  params2: vec4f,
  flags: u32, pad0: u32, pad1: u32, pad2: u32,
  transforms: array<vec4f, 16>,
  extra: array<vec4f, 3>,
}
@group(2) @binding(0) var<uniform> material: StandardMaterial;
@group(2) @binding(1) var mapTexture: texture_2d<f32>;
@group(2) @binding(2) var mapSampler: sampler;
@group(2) @binding(3) var normalTexture: texture_2d<f32>;
@group(2) @binding(4) var normalSampler: sampler;
@group(2) @binding(5) var roughnessTexture: texture_2d<f32>;
@group(2) @binding(6) var roughnessSampler: sampler;
@group(2) @binding(7) var metalnessTexture: texture_2d<f32>;
@group(2) @binding(8) var metalnessSampler: sampler;
@group(2) @binding(9) var aoTexture: texture_2d<f32>;
@group(2) @binding(10) var aoSampler: sampler;
@group(2) @binding(11) var emissiveTexture: texture_2d<f32>;
@group(2) @binding(12) var emissiveSampler: sampler;
@group(2) @binding(13) var alphaTexture: texture_2d<f32>;
@group(2) @binding(14) var alphaSampler: sampler;
@group(2) @binding(15) var lightTexture: texture_2d<f32>;
@group(2) @binding(16) var lightSampler: sampler;

fn mapUv(in: SurfaceIn, index: u32) -> vec2f {
  let row0 = material.transforms[index * 2u];
  let row1 = material.transforms[index * 2u + 1u];
  let uv = select(in.uv0, in.uv1, row0.w > 0.5);
  return vec2f(dot(row0.xyz, vec3f(uv, 1.0)), dot(row1.xyz, vec3f(uv, 1.0)));
}

${MAPPED_NORMAL_WGSL}

fn standardSurface(in: SurfaceIn) -> SurfaceOut {
  var out = surfaceDefaults(in);
  let flags = material.flags;
  // Every map is read whatever the flags say: uniform control flow keeps derivatives legal, and a missing map is
  // a neutral pixel. The flags only choose the work that costs more than the read.
  var color = material.color;
  color *= textureSample(mapTexture, mapSampler, mapUv(in, 0u));
  if ((flags & ${MATERIAL_FLAG.vertexColors}u) != 0u) { color *= in.vertexColor; }
  color = vec4f(color.rgb * in.instanceColor.rgb, color.a);
  color.a *= textureSample(alphaTexture, alphaSampler, mapUv(in, 6u)).g;
  out.albedo = color.rgb;
  out.opacity = color.a;
  out.alphaTest = material.params.w;

  let roughnessTexel = textureSample(roughnessTexture, roughnessSampler, mapUv(in, 2u));
  let metalnessTexel = textureSample(metalnessTexture, metalnessSampler, mapUv(in, 3u));
  out.roughness = clamp(material.params.x * roughnessTexel.g, 0.0, 1.0);
  out.metalness = clamp(material.params.y * metalnessTexel.b, 0.0, 1.0);
  let aoTexel = textureSample(aoTexture, aoSampler, mapUv(in, 4u)).r;
  out.occlusion = mix(1.0, aoTexel, material.params.z);
  out.emissive = material.emissive.rgb * textureSample(emissiveTexture, emissiveSampler, mapUv(in, 5u)).rgb;

  let normalTexel = textureSample(normalTexture, normalSampler, mapUv(in, 1u)).xy * 2.0 - 1.0;
  if ((flags & ${MATERIAL_FLAG.flatShading}u) != 0u) { out.normal = in.geometricNormal; }
  if ((flags & ${MATERIAL_FLAG.hasNormalMap}u) != 0u) {
    // The third component comes from the first two: a compressed normal map keeps only those, and a full one agrees.
    let depth = sqrt(saturate(1.0 - dot(normalTexel, normalTexel)));
    out.normal = mappedNormal(in, out.normal, vec3f(normalTexel * material.params2.xy, depth), mapUv(in, 1u));
  }
  let lightTexel = textureSample(lightTexture, lightSampler, mapUv(in, 7u));
  if ((flags & ${MATERIAL_FLAG.hasLightMap}u) != 0u) {
    out.bakedLight = lightTexel.rgb * material.params2.z;
    out.hasBakedLight = true;
  }
  out.unlit = (flags & ${MATERIAL_FLAG.unlit}u) != 0u;
  return out;
}
`;

const STANDARD_WGSL = /* wgsl */ `
${STANDARD_BODY_WGSL}
fn surface(in: SurfaceIn) -> SurfaceOut { return standardSurface(in); }
`;

export const standardMaps = (material: THREE.Material) => {
  const m = material as THREE.MeshStandardMaterial & THREE.MeshBasicMaterial;
  return [m.map, m.normalMap, m.roughnessMap, m.metalnessMap, m.aoMap, m.emissiveMap, m.alphaMap, m.lightMap];
};

const STANDARD_FLAGS = [
  MATERIAL_FLAG.hasMap, MATERIAL_FLAG.hasNormalMap, MATERIAL_FLAG.hasRoughnessMap, MATERIAL_FLAG.hasMetalnessMap,
  MATERIAL_FLAG.hasAoMap, MATERIAL_FLAG.hasEmissiveMap, MATERIAL_FLAG.hasAlphaMap, MATERIAL_FLAG.hasLightMap,
];

/** Materials drawn without light. */
const isUnlit = (material: THREE.Material): boolean => {
  const m = material as THREE.MeshBasicMaterial & THREE.LineBasicMaterial & THREE.PointsMaterial & THREE.SpriteMaterial;
  return !!(m.isMeshBasicMaterial || m.isLineBasicMaterial || m.isPointsMaterial || m.isSpriteMaterial);
};

/** The standard surface's stand-ins for maps a material does not have, in the order of `standardMaps`. */
export const standardFallbacks = (pool: TexturePool): TextureEntry[] => {
  const { white, flatNormal } = pool;
  return [white, flatNormal, white, white, white, white, white, white];
};

export const packStandard: SurfaceKind["pack"] = (material, floats, words, maps) => {
  const m = material as THREE.MeshStandardMaterial & THREE.MeshPhongMaterial;
  const unlit = isUnlit(material);
  const color = m.color;
  floats[0] = color ? color.r : 1;
  floats[1] = color ? color.g : 1;
  floats[2] = color ? color.b : 1;
  floats[3] = material.opacity;
  const emissive = m.emissive;
  const intensity = m.emissiveIntensity ?? 1;
  floats[4] = emissive ? emissive.r * intensity : 0;
  floats[5] = emissive ? emissive.g * intensity : 0;
  floats[6] = emissive ? emissive.b * intensity : 0;
  const shininess = m.shininess;
  floats[8] = m.roughness ?? (shininess !== undefined ? Math.sqrt(2 / (Math.max(shininess, 1) + 2)) : 1);
  floats[9] = m.metalness ?? 0;
  floats[10] = m.aoMapIntensity ?? 1;
  floats[11] = material.alphaTest;
  floats[12] = m.normalScale?.x ?? 1;
  floats[13] = m.normalScale?.y ?? 1;
  floats[14] = m.lightMapIntensity ?? 1;
  floats[15] = m.envMapIntensity ?? 1;
  let flags = 0;
  standardMaps(material).forEach((texture, index) => {
    if (maps[index]) flags |= STANDARD_FLAGS[index];
    packTransform(floats, 20 + index * 8, texture);
  });
  if (material.vertexColors) flags |= MATERIAL_FLAG.vertexColors;
  if (m.flatShading) flags |= MATERIAL_FLAG.flatShading;
  if (unlit) flags |= MATERIAL_FLAG.unlit;
  if (material.side === THREE.DoubleSide) flags |= MATERIAL_FLAG.doubleSided;
  if (material.side === THREE.BackSide) flags |= MATERIAL_FLAG.backSide;
  if (material.transparent) flags |= MATERIAL_FLAG.transparent;
  words[16] = flags;
};

/**
 * The standard surface: every built-in three.js material, as far as its numbers go. Phong and Lambert take the
 * roughness their look is nearest to. Lit materials go on to the kinds in surfaces/lit.ts, which add what the level
 * asks of them; this one is what is left: materials without light, and any material before those kinds are installed.
 */
export const STANDARD_SURFACE: SurfaceKind = {
  id: "standard",
  wgsl: STANDARD_WGSL,
  layoutEntries: () => textureLayoutEntries(8),
  textures: standardMaps,
  bindGroupEntries: (input) => textureBindEntries(input, standardFallbacks(input.pool)),
  pack: packStandard,
};
