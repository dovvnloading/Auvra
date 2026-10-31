/// <reference types="@webgpu/types" />
import * as THREE from "three";
import type { TerrainLayerUniforms } from "../../../components/Environment/Terrain/terrainLayerMaterial";
import { isWeatherPatched } from "../../../runtime/weatherSurfaces";
import { MATERIAL_FLAG, textureBindEntries, textureLayoutEntries, type SurfaceKind } from "../surfaces";
import { BAKED_VOLUME_WGSL } from "./bakedVolume";
import { WEATHER_WGSL } from "./weather";
import { STIPPLE_WGSL, worldBindEntries, worldLayoutEntries, worldWgsl } from "./world";

/**
 * TERRAIN
 *
 * The two looks of components/Environment/Terrain/terrainLayerMaterial.ts, each marked by `userData.terrainSurface`.
 * Painted terrain blends up to four tiled texture layers by a splat map, each texel of which holds the weights of the
 * height sample at the same grid position; layers that do not exist are masked out and the remaining weights
 * renormalised, and a place with no weight left shows layer 0. Unpainted terrain is grass, worn earth and rock by slope,
 * varied by a soft noise in the world. Rain, snow and baked light land on both as on any lit surface.
 */

const COMMON_WGSL = /* wgsl */ `
struct TerrainMaterial {
  // Colour and opacity.
  color: vec4f,
  // Roughness, metalness, alpha test.
  params: vec4f,
  // How often each layer tiles.
  tiling: vec4f,
  // 1 for each layer that exists.
  mask: vec4f,
  // The splat map's size; what keeps tiles square in the world.
  splat: vec4f,
  flags: u32, pad0: u32, pad1: u32, pad2: u32,
}
@group(2) @binding(0) var<uniform> material: TerrainMaterial;

fn terrainFinish(in: SurfaceIn, color: vec3f) -> SurfaceOut {
  var out = surfaceDefaults(in);
  out.albedo = material.color.rgb * in.instanceColor.rgb * color;
  out.opacity = material.color.a;
  out.alphaTest = material.params.z;
  out.roughness = material.params.x;
  out.metalness = material.params.y;
  if ((material.flags & ${MATERIAL_FLAG.flatShading}u) != 0u) { out.normal = in.geometricNormal; }
  if ((material.flags & ${MATERIAL_FLAG.takesWeather}u) != 0u) { out = applyWeather(in, out); }
  return applyBakedVolume(in, out);
}
`;

const LAYER_COUNT = 4;
const LAYERS_WORLD_BINDING = 1 + (1 + LAYER_COUNT) * 2;

const LAYERS_WGSL = /* wgsl */ `
${COMMON_WGSL}
@group(2) @binding(1) var splatTexture: texture_2d<f32>;
@group(2) @binding(2) var splatSampler: sampler;
@group(2) @binding(3) var layer0Texture: texture_2d<f32>;
@group(2) @binding(4) var layer0Sampler: sampler;
@group(2) @binding(5) var layer1Texture: texture_2d<f32>;
@group(2) @binding(6) var layer1Sampler: sampler;
@group(2) @binding(7) var layer2Texture: texture_2d<f32>;
@group(2) @binding(8) var layer2Sampler: sampler;
@group(2) @binding(9) var layer3Texture: texture_2d<f32>;
@group(2) @binding(10) var layer3Sampler: sampler;
${worldWgsl(LAYERS_WORLD_BINDING)}
${STIPPLE_WGSL}
${WEATHER_WGSL}
${BAKED_VOLUME_WGSL}

fn surface(in: SurfaceIn) -> SurfaceOut {
  // Splat texel (column, row) holds the weights of the vertex of the same grid position. The mesh's row 0 is at uv.y = 1
  // and the splat map's row 0 at v = 0.
  let size = material.splat.xy;
  let splatUv = vec2f(in.uv0.x * (size.x - 1.0) + 0.5, (1.0 - in.uv0.y) * (size.y - 1.0) + 0.5) / size;
  var weights = textureSample(splatTexture, splatSampler, splatUv) * material.mask;
  let sum = dot(weights, vec4f(1.0));
  weights = select(vec4f(1.0, 0.0, 0.0, 0.0), weights / max(sum, 0.0001), sum > 0.0001);
  let baseUv = in.uv0 * material.splat.zw;
  var color = textureSample(layer0Texture, layer0Sampler, baseUv * material.tiling.x).rgb * weights.x;
  color += textureSample(layer1Texture, layer1Sampler, baseUv * material.tiling.y).rgb * weights.y;
  color += textureSample(layer2Texture, layer2Sampler, baseUv * material.tiling.z).rgb * weights.z;
  color += textureSample(layer3Texture, layer3Sampler, baseUv * material.tiling.w).rgb * weights.w;
  return terrainFinish(in, color);
}
`;

const GROUND_WORLD_BINDING = 1;

const GROUND_WGSL = /* wgsl */ `
${COMMON_WGSL}
${worldWgsl(GROUND_WORLD_BINDING)}
${STIPPLE_WGSL}
${WEATHER_WGSL}
${BAKED_VOLUME_WGSL}

fn groundHash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn groundNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(groundHash(i), groundHash(i + vec2f(1.0, 0.0)), u.x),
             mix(groundHash(i + vec2f(0.0, 1.0)), groundHash(i + vec2f(1.0, 1.0)), u.x), u.y);
}

fn surface(in: SurfaceIn) -> SurfaceOut {
  let at = in.worldPosition.xz;
  let variation = groundNoise(at * 0.08) * 0.65 + groundNoise(at * 0.45) * 0.35;
  let slope = 1.0 - clamp(abs(normalize(in.normal).y), 0.0, 1.0);
  // Linear-light colours: two greens, a dry earth and a grey stone.
  let grass = mix(vec3f(0.045, 0.095, 0.022), vec3f(0.085, 0.13, 0.035), variation);
  let earth = mix(vec3f(0.11, 0.075, 0.042), vec3f(0.15, 0.11, 0.065), variation);
  let rock = mix(vec3f(0.16, 0.15, 0.14), vec3f(0.22, 0.21, 0.19), variation);
  var ground = mix(grass, earth, smoothstep(0.16, 0.32, slope + (variation - 0.5) * 0.12));
  ground = mix(ground, rock, smoothstep(0.42, 0.62, slope));
  return terrainFinish(in, ground);
}
`;

const packCommon = (material: THREE.Material, floats: Float32Array, words: Uint32Array): void => {
  const m = material as THREE.MeshStandardMaterial;
  floats[0] = m.color.r;
  floats[1] = m.color.g;
  floats[2] = m.color.b;
  floats[3] = m.opacity;
  floats[4] = m.roughness;
  floats[5] = m.metalness;
  floats[6] = m.alphaTest;
  let flags = 0;
  if (m.flatShading) flags |= MATERIAL_FLAG.flatShading;
  if (isWeatherPatched(material)) flags |= MATERIAL_FLAG.takesWeather;
  words[20] = flags;
};

const layersOf = (material: THREE.Material): TerrainLayerUniforms => material.userData.terrainUniforms as TerrainLayerUniforms;

export const TERRAIN_LAYERS_SURFACE: SurfaceKind = {
  id: "terrain-layers",
  wgsl: LAYERS_WGSL,
  layoutEntries: () => [...textureLayoutEntries(1 + LAYER_COUNT), ...worldLayoutEntries(LAYERS_WORLD_BINDING)],
  textures: (material) => {
    const layers = layersOf(material);
    return [layers.terrainSplat.value, layers.terrainLayer0.value, layers.terrainLayer1.value, layers.terrainLayer2.value, layers.terrainLayer3.value];
  },
  bindGroupEntries: (input) => {
    const { white, black } = input.pool;
    return [...textureBindEntries(input, [black, white, white, white, white]), ...worldBindEntries(input.pool, LAYERS_WORLD_BINDING)];
  },
  pack(material, floats, words) {
    packCommon(material, floats, words);
    const layers = layersOf(material);
    layers.terrainLayerTiling.value.toArray(floats, 8);
    layers.terrainLayerMask.value.toArray(floats, 12);
    layers.terrainSplatSize.value.toArray(floats, 16);
    layers.terrainUvAspect.value.toArray(floats, 18);
  },
};

export const TERRAIN_GROUND_SURFACE: SurfaceKind = {
  id: "terrain-ground",
  wgsl: GROUND_WGSL,
  layoutEntries: () => [...textureLayoutEntries(0), ...worldLayoutEntries(GROUND_WORLD_BINDING)],
  textures: () => [],
  bindGroupEntries: (input) => [...textureBindEntries(input, []), ...worldBindEntries(input.pool, GROUND_WORLD_BINDING)],
  pack: packCommon,
};

export const terrainSurfaceFor = (material: THREE.Material): SurfaceKind | null => {
  switch (material.userData.terrainSurface) {
    case "layers": return TERRAIN_LAYERS_SURFACE;
    case "ground": return TERRAIN_GROUND_SURFACE;
    default: return null;
  }
};
