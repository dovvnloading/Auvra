/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { TERRAIN_BRUSH_UNIFORMS } from "../../../components/Environment/Terrain/terrainBrushOverlay";
import { TERRAIN_LAYER_USAGE_COLOURS, type TerrainLayerUniforms } from "../../../components/Environment/Terrain/terrainLayerMaterial";
import { MAX_TERRAIN_LAYERS } from "../../../components/Environment/Terrain/terrainSplatCodec";
import { isWeatherPatched } from "../../../runtime/weatherSurfaces";
import { MATERIAL_FLAG, type SurfaceKind } from "../surfaces";
import { BAKED_VOLUME_WGSL } from "./bakedVolume";
import { WEATHER_WGSL } from "./weather";
import { INSTANCE_INVERSE_WGSL, STIPPLE_WGSL, worldBindEntries, worldLayoutEntries, worldWgsl } from "./world";

/**
 * TERRAIN
 *
 * The two looks of components/Environment/Terrain/terrainLayerMaterial.ts, each marked by `userData.terrainSurface`.
 * Painted terrain blends up to eight layers by two splat maps, each texel of which holds the weights of the height
 * sample at the same grid position. A layer's colour with its height, and its normal with its roughness, are slices of
 * two texture arrays. Layers are tiled in metres along the terrain, turned, tinted, varied, projected from the sides on
 * cliffs and, where a layer asks, blended by height so the taller one shows first. Unpainted terrain is grass, worn earth
 * and rock by slope, varied by a soft noise in the world. Rain, snow and baked light land on both as on any lit surface,
 * and both draw the editor's brush, region and layer views (terrainBrushOverlay.ts) where the WebGL2 one does, after
 * the light: a tint is taken out of the colour and given off instead.
 */

const LAYERS = MAX_TERRAIN_LAYERS;

const usageColours = TERRAIN_LAYER_USAGE_COLOURS.map((hex) => {
  const { r, g, b } = new THREE.Color(hex);
  return `vec3f(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)})`;
}).join(", ");

const COMMON_FIELDS = /* wgsl */ `
  // Colour and opacity.
  color: vec4f,
  // Metalness, alpha test, 1 to blend by height, layer count.
  params: vec4f,
  // The splat map's size in texels; the plane's in its own units.
  sizes: vec4f,
  flags: u32, pad0: u32, pad1: u32, pad2: u32,
  // The brush: its centre on the ground, its radius and where its fade starts, in metres.
  brush: vec4f,
  // Its colour; 1 in w to tint the region.
  brushColour: vec4f,
  // A rectangle on the ground: min x, min z, max x, max z; empty when max < min.
  brushRect: vec4f,
  // 1 in x to colour by layer.
  views: vec4f,
`;

const OVERLAY_WGSL = /* wgsl */ `
// What the WebGL2 material mixes into its lit colour, as a share of the colour taken away and a colour given off.
struct TerrainOverlay { keep: f32, glow: vec3f }

fn terrainOverlay(world: vec3f, uv: vec2f) -> TerrainOverlay {
  var overlay = TerrainOverlay(1.0, vec3f(0.0));
  if (material.brushColour.w > 0.5) {
    let regionSize = vec2f(textureDimensions(regionTexture));
    let regionAt = (vec2f(uv.x, 1.0 - uv.y) * (regionSize - 1.0) + 0.5) / regionSize;
    let amount = textureSampleLevel(regionTexture, regionSampler, regionAt, 0.0).r * 0.4;
    overlay = TerrainOverlay(overlay.keep * (1.0 - amount), overlay.glow * (1.0 - amount) + vec3f(0.04, 0.26, 0.9) * amount);
  }
  let radius = material.brush.z;
  let inner = material.brush.w;
  let brushDistance = distance(world.xz, material.brush.xy);
  let brushPixel = max(fwidth(brushDistance), 1e-4);
  if (radius > 0.0 && brushDistance < radius + 1.0) {
    let outer = 1.0 - smoothstep(0.0, brushPixel * 1.5, abs(brushDistance - radius) - brushPixel * 0.75);
    let fadeStart = 1.0 - smoothstep(0.0, brushPixel * 1.5, abs(brushDistance - inner) - brushPixel * 0.25);
    let band = max(radius - inner, 1e-4);
    let fill = select(0.0, 1.0 - clamp((brushDistance - inner) / band, 0.0, 1.0), brushDistance < radius);
    let amount = max(max(outer * 0.95, fadeStart * 0.45), fill * 0.08);
    overlay = TerrainOverlay(overlay.keep * (1.0 - amount), overlay.glow * (1.0 - amount) + material.brushColour.rgb * amount);
  }
  let rect = material.brushRect;
  let rectLow = world.xz - rect.xy;
  let rectHigh = rect.zw - world.xz;
  let rectEdge = min(min(rectLow.x, rectLow.y), min(rectHigh.x, rectHigh.y));
  let rectPixel = max(fwidth(rectEdge), 1e-4);
  if (rect.z >= rect.x) {
    let line = 1.0 - smoothstep(0.0, rectPixel * 1.5, abs(rectEdge) - rectPixel * 0.75);
    let amount = max(line * 0.95, select(0.0, 0.12, rectEdge > 0.0));
    overlay = TerrainOverlay(overlay.keep * (1.0 - amount), overlay.glow * (1.0 - amount) + material.brushColour.rgb * amount);
  }
  return overlay;
}

// The overlay is worked out before any loop that skips layers: its edges are smoothed by derivatives.
fn terrainFinish(in: SurfaceIn, color: vec3f, normal: vec3f, roughness: f32, overlay: TerrainOverlay) -> SurfaceOut {
  var out = surfaceDefaults(in);
  out.albedo = material.color.rgb * in.instanceColor.rgb * color;
  out.opacity = material.color.a;
  out.alphaTest = material.params.y;
  out.roughness = roughness;
  out.metalness = material.params.x;
  out.normal = normal;
  if ((material.flags & ${MATERIAL_FLAG.flatShading}u) != 0u) { out.normal = in.geometricNormal; }
  if ((material.flags & ${MATERIAL_FLAG.takesWeather}u) != 0u) { out = applyWeather(in, out); }
  out = applyBakedVolume(in, out);
  out.albedo *= overlay.keep;
  out.emissive = out.emissive * overlay.keep + overlay.glow;
  return out;
}
`;

const LAYERS_WORLD_BINDING = 11;

const LAYERS_WGSL = /* wgsl */ `
struct TerrainMaterial {
${COMMON_FIELDS}
  // 1 / tile size, cos and sin of its turn, height contrast.
  layerUv: array<vec4f, ${LAYERS}>,
  // Half floats: tint red and green; tint blue and normal strength; roughness and variation. Then 1 for cliffs.
  layerLook: array<vec4u, ${LAYERS}>,
}
@group(2) @binding(0) var<uniform> material: TerrainMaterial;
@group(2) @binding(1) var splatTexture: texture_2d<f32>;
@group(2) @binding(2) var splatSampler: sampler;
@group(2) @binding(3) var splat2Texture: texture_2d<f32>;
@group(2) @binding(4) var splat2Sampler: sampler;
@group(2) @binding(5) var albedoLayers: texture_2d_array<f32>;
@group(2) @binding(6) var albedoSampler: sampler;
@group(2) @binding(7) var detailLayers: texture_2d_array<f32>;
@group(2) @binding(8) var detailSampler: sampler;
@group(2) @binding(9) var regionTexture: texture_2d<f32>;
@group(2) @binding(10) var regionSampler: sampler;
${worldWgsl(LAYERS_WORLD_BINDING)}
${STIPPLE_WGSL}
${WEATHER_WGSL}
${BAKED_VOLUME_WGSL}
${INSTANCE_INVERSE_WGSL}
${OVERLAY_WGSL}

var<private> TERRAIN_LAYER_USAGE: array<vec3f, ${LAYERS}> = array<vec3f, ${LAYERS}>(${usageColours});

fn terrainHash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn terrainNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(terrainHash(i), terrainHash(i + vec2f(1.0, 0.0)), u.x),
             mix(terrainHash(i + vec2f(0.0, 1.0)), terrainHash(i + vec2f(1.0, 1.0)), u.x), u.y);
}

struct TerrainSample { albedo: vec4f, normal: vec3f, roughness: f32 }

// Lookups in a loop are given their gradients: the rates of change are worked out once, up front.
fn terrainSampleLayer(layer: u32, at: vec2f, dx: vec2f, dy: vec2f) -> TerrainSample {
  let settings = material.layerUv[layer];
  let turn = mat2x2f(settings.y, settings.z, -settings.z, settings.y);
  let uv = turn * at * settings.x;
  let gradX = turn * dx * settings.x;
  let gradY = turn * dy * settings.x;
  let albedo = textureSampleGrad(albedoLayers, albedoSampler, uv, layer, gradX, gradY);
  let detail = textureSampleGrad(detailLayers, detailSampler, uv, layer, gradX, gradY);
  let strength = unpack2x16float(material.layerLook[layer].y).y;
  let slope = ((detail.rg * 2.0 - 1.0) * strength) * turn;
  return TerrainSample(albedo, vec3f(slope, sqrt(max(0.0, 1.0 - min(1.0, dot(slope, slope))))), detail.b);
}

fn surface(in: SurfaceIn) -> SurfaceOut {
  let instance = instances[in.instanceId];
  let scale = vec3f(
    length(vec3f(instance.world0.x, instance.world1.x, instance.world2.x)),
    length(vec3f(instance.world0.y, instance.world1.y, instance.world2.y)),
    length(vec3f(instance.world0.z, instance.world1.z, instance.world2.z)));
  // Where the pixel is along the plane and above it, in metres, and which way the ground faces in the plane's own space.
  let metres = in.uv0 * material.sizes.zw * scale.xy;
  let heightMetres = instanceLocalPoint(instance, in.worldPosition).z * scale.z;
  let localNormal = normalize(mat3x3f(instance.world0.xyz, instance.world1.xyz, instance.world2.xyz) * in.normal);
  let dx = dpdx(metres);
  let dy = dpdy(metres);
  let dxHeight = dpdx(heightMetres);
  let dyHeight = dpdy(heightMetres);
  let overlay = terrainOverlay(in.worldPosition, in.uv0);

  // Splat texel (column, row) holds the weights of the vertex of the same grid position. The mesh's row 0 is at uv.y = 1
  // and the splat map's row 0 at v = 0.
  let size = material.sizes.xy;
  let splatUv = vec2f(in.uv0.x * (size.x - 1.0) + 0.5, (1.0 - in.uv0.y) * (size.y - 1.0) + 0.5) / size;
  let weightsA = textureSample(splatTexture, splatSampler, splatUv);
  let weightsB = textureSample(splat2Texture, splat2Sampler, splatUv);
  var weights = array<f32, ${LAYERS}>(weightsA.r, weightsA.g, weightsA.b, weightsA.a, weightsB.r, weightsB.g, weightsB.b, weightsB.a);
  let count = u32(material.params.w);
  var weightSum = 0.0;
  for (var layer = 0u; layer < count; layer++) { weightSum += weights[layer]; }
  if (weightSum < 0.0001) { weights[0] = 1.0; weightSum = 1.0; }

  var sideWeights = pow(abs(localNormal), vec3f(6.0));
  sideWeights /= max(sideWeights.x + sideWeights.y + sideWeights.z, 1e-4);

  var colours: array<vec3f, ${LAYERS}>;
  var normals: array<vec3f, ${LAYERS}>;
  var roughnesses: array<f32, ${LAYERS}>;
  var heights: array<f32, ${LAYERS}>;
  // A layer with almost no weight is skipped: most of the ground shows two or three, and each costs lookups.
  for (var layer = 0u; layer < count; layer++) {
    let share = weights[layer] / weightSum;
    weights[layer] = share;
    if (share < 0.004) { continue; }
    let look = material.layerLook[layer];
    let s = terrainSampleLayer(layer, metres, dx, dy);
    var albedo = s.albedo;
    var roughness = s.roughness;
    var blended = vec3f(s.normal.xy + localNormal.xy, abs(s.normal.z) * localNormal.z);
    if (look.w != 0u && sideWeights.z < 0.98) {
      // Steep ground also takes the texture from the sides; normals blended as Golus's whiteout.
      let sx = terrainSampleLayer(layer, vec2f(heightMetres, metres.y), vec2f(dxHeight, dx.y), vec2f(dyHeight, dy.y));
      let sy = terrainSampleLayer(layer, vec2f(metres.x, heightMetres), vec2f(dx.x, dxHeight), vec2f(dy.x, dyHeight));
      albedo = albedo * sideWeights.z + sx.albedo * sideWeights.x + sy.albedo * sideWeights.y;
      roughness = roughness * sideWeights.z + sx.roughness * sideWeights.x + sy.roughness * sideWeights.y;
      let tx = vec3f(sx.normal.xy + localNormal.zy, abs(sx.normal.z) * localNormal.x);
      let ty = vec3f(sy.normal.xy + localNormal.xz, abs(sy.normal.z) * localNormal.y);
      blended = tx.zyx * sideWeights.x + ty.xzy * sideWeights.y + blended * sideWeights.z;
    }
    let tint = vec3f(unpack2x16float(look.x), unpack2x16float(look.y).x);
    let surfaceLook = unpack2x16float(look.z);
    var colour = albedo.rgb * tint;
    if (surfaceLook.y > 0.0) {
      let broad = terrainNoise(metres * 0.021) * 0.6 + terrainNoise(metres * 0.097) * 0.4;
      colour *= 1.0 + (broad - 0.5) * 0.9 * surfaceLook.y;
    }
    colours[layer] = colour;
    normals[layer] = blended;
    roughnesses[layer] = roughness * surfaceLook.x;
    heights[layer] = albedo.a;
  }

  if (material.params.z > 0.5) {
    // The taller layer shows first where layers meet, so gravel sits between the cobbles.
    var tallest = -1000.0;
    for (var layer = 0u; layer < count; layer++) {
      if (weights[layer] < 0.004) { continue; }
      let value = weights[layer] + (heights[layer] - 0.5) * material.layerUv[layer].w;
      heights[layer] = value;
      tallest = max(tallest, value);
    }
    var sharpened = 0.0;
    for (var layer = 0u; layer < count; layer++) {
      if (weights[layer] < 0.004) { continue; }
      weights[layer] = max(heights[layer] - (tallest - 0.2), 0.0);
      sharpened += weights[layer];
    }
    for (var layer = 0u; layer < count; layer++) { weights[layer] /= max(sharpened, 1e-4); }
  }

  var color = vec3f(0.0);
  var normalSum = vec3f(0.0);
  var roughnessSum = 0.0;
  var counted = 0.0;
  var usage = vec3f(0.0);
  for (var layer = 0u; layer < count; layer++) {
    let share = weights[layer];
    usage += TERRAIN_LAYER_USAGE[layer] * share;
    if (share < 0.004) { continue; }
    color += colours[layer] * share;
    normalSum += normals[layer] * share;
    roughnessSum += roughnesses[layer] * share;
    counted += share;
  }
  color /= max(counted, 1e-4);
  if (material.views.x > 0.5) { color = usage / max(counted, 1e-4); }
  let normal = worldNormalOf(instance, normalize(normalSum));
  return terrainFinish(in, color, select(-normal, normal, in.frontFacing), clamp(roughnessSum / max(counted, 1e-4), 0.0, 1.0), overlay);
}
`;

const GROUND_WORLD_BINDING = 3;

const GROUND_WGSL = /* wgsl */ `
struct TerrainMaterial {
${COMMON_FIELDS}
}
@group(2) @binding(0) var<uniform> material: TerrainMaterial;
@group(2) @binding(1) var regionTexture: texture_2d<f32>;
@group(2) @binding(2) var regionSampler: sampler;
${worldWgsl(GROUND_WORLD_BINDING)}
${STIPPLE_WGSL}
${WEATHER_WGSL}
${BAKED_VOLUME_WGSL}
${OVERLAY_WGSL}

fn groundHash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn groundNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(groundHash(i), groundHash(i + vec2f(1.0, 0.0)), u.x),
             mix(groundHash(i + vec2f(0.0, 1.0)), groundHash(i + vec2f(1.0, 1.0)), u.x), u.y);
}

fn surface(in: SurfaceIn) -> SurfaceOut {
  let overlay = terrainOverlay(in.worldPosition, in.uv0);
  let at = in.worldPosition.xz;
  let variation = groundNoise(at * 0.08) * 0.65 + groundNoise(at * 0.45) * 0.35;
  let slope = 1.0 - clamp(abs(normalize(in.normal).y), 0.0, 1.0);
  // Linear-light colours: two greens, a dry earth and a grey stone.
  let grass = mix(vec3f(0.045, 0.095, 0.022), vec3f(0.085, 0.13, 0.035), variation);
  let earth = mix(vec3f(0.11, 0.075, 0.042), vec3f(0.15, 0.11, 0.065), variation);
  let rock = mix(vec3f(0.16, 0.15, 0.14), vec3f(0.22, 0.21, 0.19), variation);
  var ground = mix(grass, earth, smoothstep(0.16, 0.32, slope + (variation - 0.5) * 0.12));
  ground = mix(ground, rock, smoothstep(0.42, 0.62, slope));
  return terrainFinish(in, ground, in.normal, material.params.z, overlay);
}
`;

const VISIBLE = 3;

const pair = (binding: number, viewDimension: GPUTextureViewDimension = "2d"): GPUBindGroupLayoutEntry[] => [
  { binding, visibility: VISIBLE, texture: { sampleType: "float", viewDimension } },
  { binding: binding + 1, visibility: VISIBLE, sampler: { type: "filtering" } },
];

const regionOf = (material: THREE.Material): THREE.Texture | undefined => (material.userData.terrainRegion as THREE.IUniform<THREE.Texture> | undefined)?.value;

const packCommon = (material: THREE.Material, floats: Float32Array, words: Uint32Array): void => {
  const m = material as THREE.MeshStandardMaterial;
  floats[0] = m.color.r;
  floats[1] = m.color.g;
  floats[2] = m.color.b;
  floats[3] = m.opacity;
  floats[4] = m.metalness;
  floats[5] = m.alphaTest;
  let flags = 0;
  if (m.flatShading) flags |= MATERIAL_FLAG.flatShading;
  if (isWeatherPatched(material)) flags |= MATERIAL_FLAG.takesWeather;
  words[12] = flags;
  const brush = TERRAIN_BRUSH_UNIFORMS;
  floats[16] = brush.terrainBrushCentre.value.x;
  floats[17] = brush.terrainBrushCentre.value.y;
  floats[18] = brush.terrainBrushRadius.value;
  floats[19] = brush.terrainBrushInner.value;
  floats[20] = brush.terrainBrushColour.value.r;
  floats[21] = brush.terrainBrushColour.value.g;
  floats[22] = brush.terrainBrushColour.value.b;
  floats[23] = brush.terrainRegionShow.value;
  brush.terrainBrushRect.value.toArray(floats, 24);
  floats[28] = brush.terrainShowLayerUsage.value;
};

const half = (value: number): number => THREE.DataUtils.toHalfFloat(Math.max(-65504, Math.min(65504, value)));
const halves = (low: number, high: number): number => (half(low) | (half(high) << 16)) >>> 0;

const layersOf = (material: THREE.Material): TerrainLayerUniforms => material.userData.terrainUniforms as TerrainLayerUniforms;

export const TERRAIN_LAYERS_SURFACE: SurfaceKind = {
  id: "terrain-layers-8",
  wgsl: LAYERS_WGSL,
  layoutEntries: () => [
    { binding: 0, visibility: VISIBLE, buffer: { type: "uniform" } },
    ...pair(1), ...pair(3), ...pair(5, "2d-array"), ...pair(7, "2d-array"), ...pair(9),
    ...worldLayoutEntries(LAYERS_WORLD_BINDING),
  ],
  textures: (material) => {
    const layers = layersOf(material);
    return [layers.terrainSplat.value, layers.terrainSplat2.value, layers.terrainAlbedoArray.value, layers.terrainDetailArray.value, regionOf(material)];
  },
  bindGroupEntries: (input) => {
    const { black, whiteLayers, flatNormalLayers } = input.pool;
    const fallbacks = [black, black, whiteLayers, flatNormalLayers, black];
    const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: input.uniform }];
    fallbacks.forEach((fallback, index) => {
      const map = input.maps[index] ?? fallback;
      entries.push({ binding: 1 + index * 2, resource: map.view }, { binding: 2 + index * 2, resource: map.sampler });
    });
    return [...entries, ...worldBindEntries(input.pool, LAYERS_WORLD_BINDING)];
  },
  pack(material, floats, words) {
    packCommon(material, floats, words);
    const layers = layersOf(material);
    floats[6] = layers.terrainHeightBlend.value;
    floats[7] = Math.max(1, Math.min(LAYERS, layers.terrainLayerCount.value));
    floats[8] = layers.terrainSplatSize.value.x;
    floats[9] = layers.terrainSplatSize.value.y;
    floats[10] = layers.terrainPlaneSize.value.x;
    floats[11] = layers.terrainPlaneSize.value.y;
    for (let layer = 0; layer < LAYERS; layer++) {
      layers.terrainLayerUv.value[layer].toArray(floats, 32 + layer * 4);
      const look = layers.terrainLayerLook.value[layer];
      const surface = layers.terrainLayerSurface.value[layer];
      const at = 64 + layer * 4;
      words[at] = halves(look.x, look.y);
      words[at + 1] = halves(look.z, look.w);
      words[at + 2] = halves(surface.x, surface.z);
      words[at + 3] = surface.y > 0.5 ? 1 : 0;
    }
  },
};

export const TERRAIN_GROUND_SURFACE: SurfaceKind = {
  id: "terrain-ground",
  wgsl: GROUND_WGSL,
  layoutEntries: () => [{ binding: 0, visibility: VISIBLE, buffer: { type: "uniform" } }, ...pair(1), ...worldLayoutEntries(GROUND_WORLD_BINDING)],
  textures: (material) => [regionOf(material)],
  bindGroupEntries: (input) => {
    const region = input.maps[0] ?? input.pool.black;
    return [
      { binding: 0, resource: input.uniform },
      { binding: 1, resource: region.view },
      { binding: 2, resource: region.sampler },
      ...worldBindEntries(input.pool, GROUND_WORLD_BINDING),
    ];
  },
  pack(material, floats, words) {
    packCommon(material, floats, words);
    // The ground's own roughness, where the layers' blend weight goes: theirs comes from their maps.
    floats[6] = (material as THREE.MeshStandardMaterial).roughness;
  },
};

export const terrainSurfaceFor = (material: THREE.Material): SurfaceKind | null => {
  switch (material.userData.terrainSurface) {
    case "layers": return TERRAIN_LAYERS_SURFACE;
    case "ground": return TERRAIN_GROUND_SURFACE;
    default: return null;
  }
};
