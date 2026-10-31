/// <reference types="@webgpu/types" />
import type * as THREE from "three";
import { isWeatherPatched, type WindSway } from "../../../runtime/weatherSurfaces";
import { MATERIAL_FLAG, STANDARD_BODY_WGSL, packStandard, standardFallbacks, standardMaps, textureBindEntries, textureLayoutEntries, type SurfaceKind } from "../surfaces";
import { BAKED_VOLUME_WGSL } from "./bakedVolume";
import { WEATHER_WGSL } from "./weather";
import { WIND_WGSL } from "./wind";
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
 * What a physical material adds, as far as one layer of surface can carry it:
 * - clearcoat: a shinier surface, more so at grazing angles, with the light the coat keeps taken from what is under it;
 * - sheen: a soft brightening toward the edges, with the base dimmed by what the sheen takes;
 * - transmission: a blended material gets more see-through; a solid one, which has nothing behind it in the surface
 *   buffer to show, is stippled away by what lets light through, and the temporal resolve smooths that into glass.
 * Index of refraction, specular tint, iridescence and anisotropy change the lobe itself, which the surface buffer does
 * not hold.
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
fn applyPhysical(in: SurfaceIn, plain: SurfaceOut) -> SurfaceOut {
  var out = plain;
  let texels = physicalTexels(in);
  let coatTexel = texels[0].x;
  let sheenTexel = texels[1];
  let transmissionTexel = texels[2].x;
  let facing = clamp(dot(out.normal, in.viewDirection), 0.0, 1.0);
  let edge = pow(1.0 - facing, 5.0);
  let reflected = 0.04 + 0.96 * edge;

  let coat = material.extra[0].x * coatTexel;
  out.roughness = mix(out.roughness, material.extra[0].y, coat * mix(0.5, 1.0, edge));
  out.albedo *= 1.0 - coat * reflected;

  let sheen = material.extra[1].rgb * sheenTexel;
  let rim = pow(1.0 - facing, mix(5.0, 2.0, material.extra[0].z));
  out.albedo = out.albedo * (1.0 - 0.157 * max(max(sheen.r, sheen.g), sheen.b)) + sheen * rim * (1.0 - out.metalness);

  let transmission = material.extra[0].w * transmissionTexel;
  if (transmission > 0.0) {
    let seen = mix(1.0, max(reflected, 0.12), transmission);
    out.albedo *= 1.0 - transmission * 0.85;
    out.opacity *= seen;
    if ((material.flags & ${MATERIAL_FLAG.transparent}u) == 0u && view.kind == 0u) {
      out.alphaTest = max(out.alphaTest, surfaceStipple(in));
    }
  }
  return out;
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

/** The sway the weather patch gave a material; as on the WebGL path, none without that patch. */
const swayOf = (material: THREE.Material): WindSway | null => {
  if (!isWeatherPatched(material)) return null;
  const wind = material.userData.windSway as WindSway | null | undefined;
  return wind && wind.sway > 0 ? wind : null;
};

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
  if (sways) {
    const wind = swayOf(material);
    const shape = material.userData.windShape as { bottom: number; height: number } | undefined;
    floats[92] = wind?.sway ?? 0;
    floats[93] = wind?.flutter ?? 0;
    floats[94] = shape?.bottom ?? 0;
    floats[95] = Math.max(1e-3, shape?.height ?? 1);
  }
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
  const physical = m.isMeshPhysicalMaterial === true && (m.clearcoat > 0 || m.sheen > 0 || m.transmission > 0);
  const sways = swayOf(material) !== null;
  if (physical && !forwardHoldsPhysicalMaps && (material.transparent || !material.toneMapped || m.wireframe)) return sways ? LIT_PHYSICAL_NO_MAPS_WIND_SURFACE : LIT_PHYSICAL_NO_MAPS_SURFACE;
  if (physical) return sways ? LIT_PHYSICAL_WIND_SURFACE : LIT_PHYSICAL_SURFACE;
  return sways ? LIT_WIND_SURFACE : LIT_SURFACE;
};
