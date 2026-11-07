/// <reference types="@webgpu/types" />
import type * as THREE from "three";
import { boundMaterialGraph } from "../../../runtime/materials/graphMaterial";
import { isWeatherPatched } from "../../../runtime/weatherSurfaces";
import { MATERIAL_FLAG, STANDARD_BODY_WGSL, packStandard, standardFallbacks, standardMaps, textureBindEntries, textureLayoutEntries, type SurfaceKind } from "../surfaces";
import { BAKED_VOLUME_WGSL } from "./bakedVolume";
import { PHYSICAL_LAYERS_WGSL } from "./physicalLayers";
import { WEATHER_WGSL } from "./weather";
import { WIND_WGSL, packWind, windSwayOf } from "./wind";
import { INSTANCE_INVERSE_WGSL, STIPPLE_WGSL, worldBindEntries, worldLayoutEntries, worldWgsl } from "./world";

/**
 * LIT MATERIALS
 *
 * Standard, physical, Lambert, Phong and toon materials as the level draws them: the standard surface, then the rain and
 * snow when the material takes them, then the baked light. One kind serves all of that, as a change in the weather or a
 * material starting to take it should not change what draws it. Swaying in the wind makes a kind of its own, because
 * moving vertices costs every pass that draws it, and so does what only physical materials have.
 *
 * Hair, lashes and leaf cards need nothing further here: utils/processing/ModelMaterials.ts splits them into an
 * alpha-tested body and a blended fringe, two plain materials these kinds draw as they are.
 *
 * What a physical material's clearcoat, sheen and transmission add is physicalLayers.ts's to say: the same as a material
 * graph's coat, sheen and transmission add.
 *
 * Drawn in the forward pass, a physical material has all its maps and all the frame's lighting in one shader, three
 * pictures more than the sixteen every card promises. On a card with no more than that it goes by its numbers alone.
 */

const STANDARD_TEXTURES = 8;
const PHYSICAL_TEXTURES = 3;
/** How many pictures a forward shader needs with a physical material's maps in it: those, the world's and the lighting's. */
const FORWARD_PHYSICAL_PICTURES = 19;

const PHYSICAL_MAPS_WGSL = /* wgsl */ `
@group(2) @binding(${1 + STANDARD_TEXTURES * 2}) var clearcoatTexture: texture_2d<f32>;
@group(2) @binding(${2 + STANDARD_TEXTURES * 2}) var clearcoatSampler: sampler;
@group(2) @binding(${3 + STANDARD_TEXTURES * 2}) var sheenTexture: texture_2d<f32>;
@group(2) @binding(${4 + STANDARD_TEXTURES * 2}) var sheenSampler: sampler;
@group(2) @binding(${5 + STANDARD_TEXTURES * 2}) var transmissionTexture: texture_2d<f32>;
@group(2) @binding(${6 + STANDARD_TEXTURES * 2}) var transmissionSampler: sampler;

fn physicalTexels(in: SurfaceIn) -> mat3x3f {
  let uv = mapUv(in, 0u);
  return mat3x3f(
    vec3f(textureSample(clearcoatTexture, clearcoatSampler, uv).r),
    textureSample(sheenTexture, sheenSampler, uv).rgb,
    vec3f(textureSample(transmissionTexture, transmissionSampler, uv).r),
  );
}
`;

const PHYSICAL_NO_MAPS_WGSL = /* wgsl */ `
fn physicalTexels(in: SurfaceIn) -> mat3x3f { return mat3x3f(vec3f(1.0), vec3f(1.0), vec3f(1.0)); }
`;

const PHYSICAL_WGSL = /* wgsl */ `
${PHYSICAL_LAYERS_WGSL}
fn applyPhysical(in: SurfaceIn, plain: SurfaceOut) -> SurfaceOut {
  let texels = physicalTexels(in);
  let layers = PhysicalLayers(
    material.extra[0].x * texels[0].x,
    material.extra[0].y,
    material.extra[1].rgb * texels[1],
    material.extra[0].z,
    material.extra[0].w * texels[2].x,
    vec3f(1.0),
  );
  return applyPhysicalLayers(in, plain, layers, (material.flags & ${MATERIAL_FLAG.transparent}u) != 0u);
}
`;

const SWAY_WGSL = /* wgsl */ `
fn displace(local: vec3f, normal: vec3f, instance: Instance, time: f32) -> vec3f {
  let shape = material.extra[2];
  return local + instanceLocalDirection(instance, windOffset(local, instance, shape.x, shape.y, shape.z, shape.w));
}
`;

const litWgsl = (physical: boolean, maps: boolean, sways: boolean, worldBinding: number): string => /* wgsl */ `
${STANDARD_BODY_WGSL}
${worldWgsl(worldBinding)}
${STIPPLE_WGSL}
${WEATHER_WGSL}
${BAKED_VOLUME_WGSL}
${physical ? `${maps ? PHYSICAL_MAPS_WGSL : PHYSICAL_NO_MAPS_WGSL}${PHYSICAL_WGSL}` : ""}
${sways ? `${INSTANCE_INVERSE_WGSL}${WIND_WGSL}${SWAY_WGSL}` : ""}
fn surface(in: SurfaceIn) -> SurfaceOut {
  var out = standardSurface(in);
  ${physical ? "out = applyPhysical(in, out);" : ""}
  if ((material.flags & ${MATERIAL_FLAG.takesWeather}u) != 0u) { out = applyWeather(in, out); }
  return applyBakedVolume(in, out);
}
`;

type LitMaterial = THREE.MeshPhysicalMaterial;

const physicalMaps = (material: THREE.Material) => {
  const m = material as LitMaterial;
  return [...standardMaps(material), m.clearcoatMap, m.sheenColorMap, m.transmissionMap];
};

const packLit = (physical: boolean, sways: boolean): SurfaceKind["pack"] => (material, floats, words, maps) => {
  packStandard(material, floats, words, maps);
  if (isWeatherPatched(material)) words[16] |= MATERIAL_FLAG.takesWeather;
  if (physical) {
    const m = material as LitMaterial;
    floats[84] = m.clearcoat ?? 0;
    floats[85] = m.clearcoatRoughness ?? 0;
    floats[86] = m.sheenRoughness ?? 1;
    floats[87] = m.transmission ?? 0;
    const sheen = m.sheen ?? 0;
    floats[88] = m.sheenColor ? m.sheenColor.r * sheen : 0;
    floats[89] = m.sheenColor ? m.sheenColor.g * sheen : 0;
    floats[90] = m.sheenColor ? m.sheenColor.b * sheen : 0;
  }
  if (sways) packWind(material, floats, 92);
};

const litKind = (physical: boolean, sways: boolean, maps = physical): SurfaceKind => {
  const textures = STANDARD_TEXTURES + (maps ? PHYSICAL_TEXTURES : 0);
  const worldBinding = 1 + textures * 2;
  return {
    id: `lit${physical ? "+physical" : ""}${physical && !maps ? "-maps" : ""}${sways ? "+wind" : ""}`,
    wgsl: litWgsl(physical, maps, sways, worldBinding),
    displaces: sways,
    layoutEntries: () => [...textureLayoutEntries(textures), ...worldLayoutEntries(worldBinding)],
    textures: maps ? physicalMaps : standardMaps,
    bindGroupEntries: (input) => {
      const { white } = input.pool;
      const fallbacks = maps ? [...standardFallbacks(input.pool), white, white, white] : standardFallbacks(input.pool);
      return [...textureBindEntries(input, fallbacks), ...worldBindEntries(input.pool, worldBinding)];
    },
    pack: packLit(physical, sways),
  };
};

export const LIT_SURFACE = litKind(false, false);
export const LIT_WIND_SURFACE = litKind(false, true);
export const LIT_PHYSICAL_SURFACE = litKind(true, false);
export const LIT_PHYSICAL_WIND_SURFACE = litKind(true, true);
const LIT_PHYSICAL_NO_MAPS_SURFACE = litKind(true, false, false);
const LIT_PHYSICAL_NO_MAPS_WIND_SURFACE = litKind(true, true, false);

export const LIT_SURFACES: readonly SurfaceKind[] = [
  LIT_SURFACE, LIT_WIND_SURFACE, LIT_PHYSICAL_SURFACE, LIT_PHYSICAL_WIND_SURFACE, LIT_PHYSICAL_NO_MAPS_SURFACE, LIT_PHYSICAL_NO_MAPS_WIND_SURFACE,
];

let forwardHoldsPhysicalMaps = true;

/** Says how many pictures one shader may read on this device. */
export const setPicturesPerShader = (pictures: number): void => {
  forwardHoldsPhysicalMaps = pictures >= FORWARD_PHYSICAL_PICTURES;
};

/** The materials three lights, and so the materials the baked light and the weather reach. */
export const isLitMaterial = (material: THREE.Material): boolean => {
  const m = material as unknown as Record<string, unknown>;
  return m.isMeshStandardMaterial === true || m.isMeshLambertMaterial === true || m.isMeshPhongMaterial === true || m.isMeshToonMaterial === true;
};

export const litSurfaceFor = (material: THREE.Material): SurfaceKind => {
  const m = material as LitMaterial;
  // A graph switches the physical parts it uses on with values of 1 and gives their amounts itself
  // (runtime/materials/physicalSurface.ts): drawn plain, while its own kind is not fit to draw, it shows none of them.
  const physical = m.isMeshPhysicalMaterial === true && !boundMaterialGraph(material) && (m.clearcoat > 0 || m.sheen > 0 || m.transmission > 0);
  const sways = windSwayOf(material) !== null;
  if (physical && !forwardHoldsPhysicalMaps && (material.transparent || !material.toneMapped || m.wireframe)) return sways ? LIT_PHYSICAL_NO_MAPS_WIND_SURFACE : LIT_PHYSICAL_NO_MAPS_SURFACE;
  if (physical) return sways ? LIT_PHYSICAL_WIND_SURFACE : LIT_PHYSICAL_SURFACE;
  return sways ? LIT_WIND_SURFACE : LIT_SURFACE;
};
