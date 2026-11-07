import * as THREE from 'three';
import { materialLibrary } from '../runtime/materials/materialLibrary';
import { canBindMaterialGraph } from '../runtime/materials/graphMaterial';
import { isGraphUpgraded } from '../runtime/materials/physicalSurface';
import { rebuildNormalZ } from './textureCompression/compressTextures';
import { CARD_FRINGE_KEY } from './processing/ModelMaterials';
import { MAX_PARAMETER_NAME_LENGTH, type MaterialParameterValue, type MaterialParameterValues } from '../runtime/materials/materialGraph';

/**
 * Per-model material overrides, keyed by material name. Every field is
 * optional: an unset field keeps the material's imported value. Applying is
 * idempotent and reversible: the first time a material is touched its
 * imported values are captured, and every apply restores them before laying
 * the overrides on top, so removing a field (or a whole entry) reverts it.
 *
 * Every map a material is given (base, normal, roughness, metalness) is an
 * override field here. Older projects kept a model's painted base maps apart,
 * as one texture per material name (the model's `textureOverrides`): those are
 * taken in as painted base maps when the model loads (withLegacyBaseMaps).
 */
export interface MaterialOverride {
  /** Base colour, `#rrggbb` (sRGB). */
  color?: string;
  /** 0..1 (standard/physical materials only). */
  roughness?: number;
  /** 0..1 (standard/physical materials only). */
  metalness?: number;
  /** Emissive colour, `#rrggbb` (sRGB). */
  emissive?: string;
  /** 0..MAX_EMISSIVE_INTENSITY. */
  emissiveIntensity?: number;
  /** 0..1; below 1 the material renders transparent. */
  opacity?: number;
  /** Logical texture id (textures domain) replacing the base-colour map. */
  mapTextureId?: string;
  /**
   * How the base map draws: true for a painted picture (Retexture's, or one of the older per-model
   * texture overrides), which shows its own colours, is cut out where it is see-through and is drawn
   * from both sides; false for a plain base map. Set either way, it also says an older per-model texture
   * override for this material has been taken in, so it is not taken in again.
   */
  paintedMap?: boolean;
  /** Logical texture id (textures domain) replacing the normal map. */
  normalTextureId?: string;
  /** Logical texture id replacing the roughness map (standard/physical materials only). */
  roughnessTextureId?: string;
  /** Logical texture id replacing the metalness map (standard/physical materials only). */
  metalnessTextureId?: string;
  /** A material asset (materials domain) whose node graph shades the material instead. */
  materialId?: string;
  /**
   * Values for the material asset's parameters: a number, or 2, 3 or 4 numbers (a Vector 2, a colour
   * or a Vector). A list, not a map by name, so no parameter name ever becomes a document key.
   */
  parameters?: MaterialParameterSetting[];
  // A physical material's values (glTF files using the coat, sheen, transmission, specular, index of
  // refraction, thin film or anisotropy extensions); materials of other kinds ignore them.
  /** Clear coat amount, 0..1. */
  coat?: number;
  coatRoughness?: number;
  /** Sheen colour, `#rrggbb` (sRGB); black turns the sheen off. */
  sheenColor?: string;
  sheenRoughness?: number;
  /** Thin film (iridescence) amount, 0..1. */
  thinFilm?: number;
  /** Thin film thickness in nanometres. */
  thinFilmThickness?: number;
  transmission?: number;
  /** Thickness of the volume behind a transmissive surface, in metres. */
  thickness?: number;
  /** Colour light takes on through the volume, `#rrggbb` (sRGB), reached at `attenuationDistance`. */
  attenuationColor?: string;
  attenuationDistance?: number;
  dispersion?: number;
  /** Index of refraction. */
  ior?: number;
  specularWeight?: number;
  /** Specular colour, `#rrggbb` (sRGB). */
  specularColor?: string;
  anisotropy?: number;
  /** Anisotropy direction, in degrees. */
  anisotropyRotation?: number;
}

/** The physical values an override can hold, with their ranges. */
export const PHYSICAL_OVERRIDE_RANGES = {
  coat: [0, 1], coatRoughness: [0, 1], sheenRoughness: [0, 1], thinFilm: [0, 1], thinFilmThickness: [0, 2000],
  transmission: [0, 1], thickness: [0, 1000], attenuationDistance: [0.0001, 1e6], dispersion: [0, 10], ior: [1, 5],
  specularWeight: [0, 1], anisotropy: [0, 1], anisotropyRotation: [0, 360],
} as const;

export type PhysicalOverrideNumber = keyof typeof PHYSICAL_OVERRIDE_RANGES;
export type PhysicalOverrideColor = 'sheenColor' | 'attenuationColor' | 'specularColor';
const PHYSICAL_OVERRIDE_COLORS: readonly PhysicalOverrideColor[] = ['sheenColor', 'attenuationColor', 'specularColor'];

export interface MaterialParameterSetting {
  name: string;
  /** A number, a colour or vector, a texture's id, or a switch's choice. */
  value: MaterialParameterValue;
}

export type MaterialOverrides = Record<string, MaterialOverride>;
export type MaterialOverrideField = keyof MaterialOverride;
export type MaterialTextureSlot = 'map' | 'normal' | 'roughness' | 'metalness';
/** Returns the texture to bind for a logical texture id, or nothing when it is not available (yet). */
export type MaterialTextureResolver = (textureId: string, slot: MaterialTextureSlot) => THREE.Texture | null | undefined;

export const MAX_EMISSIVE_INTENSITY = 100;
export const MAX_MATERIAL_OVERRIDES = 256;
const MAX_NAME_LENGTH = 256;
const MAX_TEXTURE_ID_LENGTH = 128;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** userData keys tagging a texture bound by an override, so it can be found and reused. */
const TEXTURE_ID_KEY = 'materialOverrideTextureId';
const TEXTURE_SLOT_KEY = 'materialOverrideSlot';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const normalizeNumber = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : undefined;

const normalizeColor = (value: unknown): string | undefined =>
  typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : undefined;

const normalizeTextureId = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXTURE_ID_LENGTH ? value : undefined;

/** Parameters kept per material, at most. */
export const MAX_MATERIAL_PARAMETERS = 64;
/** Parameter values stay within this magnitude (colours and vectors are not clamped to 0..1). */
const MAX_PARAMETER_MAGNITUDE = 1e6;

const parameterNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? clamp(value, -MAX_PARAMETER_MAGNITUDE, MAX_PARAMETER_MAGNITUDE) : undefined;

/** Numbers a vector parameter holds: a Vector 2, a colour or Vector, or four. */
const MIN_PARAMETER_COMPONENTS = 2;
const MAX_PARAMETER_COMPONENTS = 4;

const normalizeParameterValue = (value: unknown): MaterialParameterValue | undefined => {
  if (typeof value === 'boolean') return value;
  // A texture parameter names a texture by its id.
  if (typeof value === 'string') return normalizeTextureId(value);
  const single = parameterNumber(value);
  if (single !== undefined) return single;
  if (!Array.isArray(value) || value.length < MIN_PARAMETER_COMPONENTS || value.length > MAX_PARAMETER_COMPONENTS) return undefined;
  const components = value.map(parameterNumber);
  return components.every((component): component is number => component !== undefined) ? components : undefined;
};

const normalizeParameters = (value: unknown): MaterialParameterSetting[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const result: MaterialParameterSetting[] = [];
  for (const entry of value) {
    if (result.length >= MAX_MATERIAL_PARAMETERS) break;
    if (!entry || typeof entry !== 'object') continue;
    const { name, value: raw } = entry as { name?: unknown; value?: unknown };
    if (typeof name !== 'string' || !name || name.length > MAX_PARAMETER_NAME_LENGTH || name !== name.trim()) continue;
    if (result.some(setting => setting.name === name)) continue;
    const parsed = normalizeParameterValue(raw);
    if (parsed !== undefined) result.push({ name, value: parsed });
  }
  // By name, so the same settings always compare (and save) the same.
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result.length ? result : undefined;
};

/** A material's parameter settings by name, as its asset's graph takes them. */
export const materialParameterValues = (settings: readonly MaterialParameterSetting[] | undefined): MaterialParameterValues | undefined =>
  settings?.length ? Object.fromEntries(settings.map(setting => [setting.name, setting.value])) : undefined;

/** A clean override with only valid fields (numbers clamped), or null when nothing valid remains. */
export const normalizeMaterialOverride = (value: unknown): MaterialOverride | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const candidate: MaterialOverride = {
    color: normalizeColor(source.color),
    roughness: normalizeNumber(source.roughness, 0, 1),
    metalness: normalizeNumber(source.metalness, 0, 1),
    emissive: normalizeColor(source.emissive),
    emissiveIntensity: normalizeNumber(source.emissiveIntensity, 0, MAX_EMISSIVE_INTENSITY),
    opacity: normalizeNumber(source.opacity, 0, 1),
    mapTextureId: normalizeTextureId(source.mapTextureId),
    paintedMap: typeof source.paintedMap === 'boolean' ? source.paintedMap : undefined,
    normalTextureId: normalizeTextureId(source.normalTextureId),
    roughnessTextureId: normalizeTextureId(source.roughnessTextureId),
    metalnessTextureId: normalizeTextureId(source.metalnessTextureId),
    materialId: normalizeTextureId(source.materialId),
    parameters: normalizeParameters(source.parameters),
    ...Object.fromEntries(Object.entries(PHYSICAL_OVERRIDE_RANGES).map(([key, [min, max]]) => [key, normalizeNumber(source[key], min, max)])),
    ...Object.fromEntries(PHYSICAL_OVERRIDE_COLORS.map((key) => [key, normalizeColor(source[key])])),
  };
  const result = Object.fromEntries(Object.entries(candidate).filter(([, field]) => field !== undefined)) as MaterialOverride;
  return Object.keys(result).length > 0 ? result : null;
};

/** Sanitize a stored `materialOverrides` value; anything malformed is dropped. */
export const normalizeMaterialOverrides = (value: unknown): MaterialOverrides => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: MaterialOverrides = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(result).length >= MAX_MATERIAL_OVERRIDES) break;
    if (!name || name.length > MAX_NAME_LENGTH) continue;
    const override = normalizeMaterialOverride(entry);
    if (override) result[name] = override;
  }
  return result;
};

/**
 * Immutable single-field edit. `undefined` clears the field; an entry left
 * with no fields is removed.
 */
export const setMaterialOverrideField = <K extends MaterialOverrideField>(
  overrides: MaterialOverrides,
  materialName: string,
  field: K,
  value: MaterialOverride[K] | undefined,
): MaterialOverrides => {
  const entry: MaterialOverride = { ...(overrides[materialName] || {}) };
  if (value === undefined) delete entry[field];
  else entry[field] = value;
  const next = { ...overrides };
  if (Object.keys(entry).length === 0) delete next[materialName];
  else next[materialName] = entry;
  return next;
};

const canonicalOverrides = (overrides: MaterialOverrides): string => JSON.stringify(
  Object.keys(overrides).sort().map((name) => [name, Object.entries(overrides[name]).sort(([a], [b]) => a.localeCompare(b))]),
);

/** Same entries and values, ignoring key order. */
export const materialOverridesEqual = (a: MaterialOverrides, b: MaterialOverrides): boolean =>
  canonicalOverrides(a) === canonicalOverrides(b);

/**
 * The overrides with a model's older per-material texture overrides (`textureOverrides`) taken in, as
 * painted base maps, where an override has not decided its base map yet: it has no base map of its own,
 * and no `paintedMap` either way (which a base map cleared or replaced in Material Overrides leaves).
 * The same overrides when there is nothing to take in.
 */
export const withLegacyBaseMaps = (overrides: MaterialOverrides, legacy: unknown): MaterialOverrides => {
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return overrides;
  let next = overrides;
  for (const [name, value] of Object.entries(legacy as Record<string, unknown>)) {
    const textureId = normalizeTextureId(value);
    if (!name || name.length > MAX_NAME_LENGTH || !textureId) continue;
    const entry = next[name];
    if (entry?.mapTextureId !== undefined || entry?.paintedMap !== undefined) continue;
    if (!entry && Object.keys(next).length >= MAX_MATERIAL_OVERRIDES) continue;
    next = { ...next, [name]: { ...entry, mapTextureId: textureId, paintedMap: true } };
  }
  return next;
};

/**
 * The overrides with a material's base map set (or cleared, with undefined) from Material Overrides,
 * which sets plain base maps. Where the base map was a painted one, or an older texture override was
 * taken in, `paintedMap` stays as false, so the older override is not taken in again on the next load.
 */
export const withBaseMap = (overrides: MaterialOverrides, materialName: string, textureId: string | undefined): MaterialOverrides => {
  const entry = overrides[materialName];
  let next = setMaterialOverrideField(overrides, materialName, 'mapTextureId', textureId);
  if (entry?.paintedMap !== undefined) next = setMaterialOverrideField(next, materialName, 'paintedMap', false);
  return next;
};

/**
 * The overrides with `textureId` as the painted base map of each named material, beside whatever else
 * their overrides hold: how the mask tool and the host's texture commit put a picture on a material.
 */
export const withPaintedBaseMap = (overrides: MaterialOverrides, materialNames: Iterable<string>, textureId: string): MaterialOverrides => {
  let next = overrides;
  for (const name of materialNames) next = { ...next, [name]: { ...next[name], mapTextureId: textureId, paintedMap: true } };
  return next;
};

/**
 * The overrides without their painted base maps (Retexture's results, the mask tool's pictures and the
 * older per-model texture overrides taken in), so their materials wear their imported maps again: what
 * Reset Textures leaves. The same overrides when there are none.
 */
export const withoutPaintedBaseMaps = (overrides: MaterialOverrides): MaterialOverrides => {
  let next = overrides;
  for (const [name, entry] of Object.entries(overrides)) {
    if (entry.paintedMap !== true) continue;
    next = setMaterialOverrideField(next, name, 'mapTextureId', undefined);
    next = setMaterialOverrideField(next, name, 'paintedMap', undefined);
  }
  return next;
};

/** Texture ids referenced by the overrides, per slot. */
export const materialOverrideTextureIds = (overrides: MaterialOverrides): Array<{ textureId: string; slot: MaterialTextureSlot }> => {
  const seen = new Set<string>();
  const result: Array<{ textureId: string; slot: MaterialTextureSlot }> = [];
  const add = (textureId: string | undefined, slot: MaterialTextureSlot) => {
    if (!textureId || seen.has(`${slot}:${textureId}`)) return;
    seen.add(`${slot}:${textureId}`);
    result.push({ textureId, slot });
  };
  for (const entry of Object.values(overrides)) {
    add(entry.mapTextureId, 'map');
    add(entry.normalTextureId, 'normal');
    add(entry.roughnessTextureId, 'roughness');
    add(entry.metalnessTextureId, 'metalness');
  }
  return result;
};

/** userData flag on a model root whose UVs use the glTF top-left origin (native .glb/.gltf imports). */
export const UV_ORIGIN_TOP_LEFT_KEY = 'uvOriginTopLeft';

/** `flipY` for an image texture bound to `root`'s materials: false for glTF-convention UVs, true otherwise. */
export const overrideTextureFlipY = (root: THREE.Object3D): boolean => root.userData?.[UV_ORIGIN_TOP_LEFT_KEY] !== true;

/**
 * Mark a texture as bound for `textureId` in `slot` and give it that slot's
 * colour space, the model's UV orientation and repeat wrapping (as imported
 * maps have). Call it before the texture is first uploaded.
 */
export const tagOverrideTexture = (texture: THREE.Texture, textureId: string, slot: MaterialTextureSlot, flipY = true): THREE.Texture => {
  // One set up from its texture settings (texturing/materialTextureLoader.ts) is laid out already.
  if (texture.userData?.auvraTextureSettings !== true) {
    texture.colorSpace = slot === 'map' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.flipY = flipY;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
  }
  texture.userData[TEXTURE_ID_KEY] = textureId;
  texture.userData[TEXTURE_SLOT_KEY] = slot;
  return texture;
};

const overrideTextureKey = (texture: THREE.Texture | null | undefined): string | null => {
  const textureId = texture?.userData?.[TEXTURE_ID_KEY];
  const slot = texture?.userData?.[TEXTURE_SLOT_KEY];
  return typeof textureId === 'string' && (slot === 'map' || slot === 'normal' || slot === 'roughness' || slot === 'metalness') ? `${slot}:${textureId}` : null;
};

/** A physical material's own values, as imported. */
interface PhysicalBaseline {
  clearcoat: number;
  clearcoatRoughness: number;
  sheen: number;
  sheenColor: THREE.Color;
  sheenRoughness: number;
  iridescence: number;
  iridescenceThicknessRange: [number, number];
  transmission: number;
  thickness: number;
  attenuationColor: THREE.Color;
  attenuationDistance: number;
  dispersion: number;
  ior: number;
  specularIntensity: number;
  specularColor: THREE.Color;
  anisotropy: number;
  anisotropyRotation: number;
}

/** Whether a material is physical as imported (not only while a graph needs it to be). */
const isOwnPhysical = (material: THREE.Material): material is THREE.MeshPhysicalMaterial =>
  (material as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial === true && !isGraphUpgraded(material);

const capturePhysical = (material: THREE.MeshPhysicalMaterial): PhysicalBaseline => ({
  clearcoat: material.clearcoat,
  clearcoatRoughness: material.clearcoatRoughness,
  sheen: material.sheen,
  sheenColor: material.sheenColor.clone(),
  sheenRoughness: material.sheenRoughness,
  iridescence: material.iridescence,
  iridescenceThicknessRange: [material.iridescenceThicknessRange[0], material.iridescenceThicknessRange[1]],
  transmission: material.transmission,
  thickness: material.thickness,
  attenuationColor: material.attenuationColor.clone(),
  attenuationDistance: material.attenuationDistance,
  dispersion: material.dispersion,
  ior: material.ior,
  specularIntensity: material.specularIntensity,
  specularColor: material.specularColor.clone(),
  anisotropy: material.anisotropy,
  anisotropyRotation: material.anisotropyRotation,
});

const restorePhysical = (material: THREE.MeshPhysicalMaterial, physical: PhysicalBaseline): void => {
  material.clearcoat = physical.clearcoat;
  material.clearcoatRoughness = physical.clearcoatRoughness;
  material.sheen = physical.sheen;
  material.sheenColor.copy(physical.sheenColor);
  material.sheenRoughness = physical.sheenRoughness;
  material.iridescence = physical.iridescence;
  material.iridescenceThicknessRange = [physical.iridescenceThicknessRange[0], physical.iridescenceThicknessRange[1]];
  material.transmission = physical.transmission;
  material.thickness = physical.thickness;
  material.attenuationColor.copy(physical.attenuationColor);
  material.attenuationDistance = physical.attenuationDistance;
  material.dispersion = physical.dispersion;
  material.ior = physical.ior;
  material.specularIntensity = physical.specularIntensity;
  material.specularColor.copy(physical.specularColor);
  material.anisotropy = physical.anisotropy;
  material.anisotropyRotation = physical.anisotropyRotation;
};

/** Lays an override's physical values onto a physical material (whose own values were just restored). */
const applyPhysical = (material: THREE.MeshPhysicalMaterial, override: MaterialOverride): void => {
  if (override.coat !== undefined) material.clearcoat = override.coat;
  if (override.coatRoughness !== undefined) material.clearcoatRoughness = override.coatRoughness;
  if (override.sheenColor) {
    material.sheenColor.set(override.sheenColor);
    // Black is no sheen; any colour turns it on, as glTF's sheen does.
    material.sheen = material.sheenColor.getHex() === 0 ? 0 : 1;
  }
  if (override.sheenRoughness !== undefined) material.sheenRoughness = override.sheenRoughness;
  if (override.thinFilm !== undefined) material.iridescence = override.thinFilm;
  if (override.thinFilmThickness !== undefined) {
    material.iridescenceThicknessRange = [Math.min(material.iridescenceThicknessRange[0], override.thinFilmThickness), override.thinFilmThickness];
  }
  if (override.transmission !== undefined) material.transmission = override.transmission;
  if (override.thickness !== undefined) material.thickness = override.thickness;
  if (override.attenuationColor) material.attenuationColor.set(override.attenuationColor);
  if (override.attenuationDistance !== undefined) material.attenuationDistance = override.attenuationDistance;
  if (override.dispersion !== undefined) material.dispersion = override.dispersion;
  if (override.ior !== undefined) material.ior = override.ior;
  if (override.specularWeight !== undefined) material.specularIntensity = override.specularWeight;
  if (override.specularColor) material.specularColor.set(override.specularColor);
  if (override.anisotropy !== undefined) material.anisotropy = override.anisotropy;
  if (override.anisotropyRotation !== undefined) material.anisotropyRotation = THREE.MathUtils.degToRad(override.anisotropyRotation);
};

interface MaterialBaseline {
  color?: THREE.Color;
  roughness?: number;
  metalness?: number;
  emissive?: THREE.Color;
  emissiveIntensity?: number;
  opacity: number;
  transparent: boolean;
  /** How it is cut out and which sides it draws: a painted base map changes these. */
  alphaTest: number;
  side: THREE.Side;
  forceSinglePass: boolean;
  hasMap: boolean;
  map: THREE.Texture | null;
  hasNormalMap: boolean;
  normalMap: THREE.Texture | null;
  hasRoughnessMap: boolean;
  roughnessMap: THREE.Texture | null;
  hasMetalnessMap: boolean;
  metalnessMap: THREE.Texture | null;
  /** What the last apply left bound; a different value means code outside the override layer rebound it. */
  appliedMap: THREE.Texture | null;
  appliedNormalMap: THREE.Texture | null;
  appliedRoughnessMap: THREE.Texture | null;
  appliedMetalnessMap: THREE.Texture | null;
  appliedTransparent: boolean;
  appliedAlphaTest: number;
  appliedSide: THREE.Side;
  appliedForceSinglePass: boolean;
  /** A physical material's own physical values; null for other kinds. */
  physical: PhysicalBaseline | null;
}

/** Imported values, kept off `userData` so clones and JSON export stay untouched. */
const baselines = new WeakMap<THREE.Material, MaterialBaseline>();

type OverridableMaterial = THREE.Material & {
  color?: THREE.Color;
  roughness?: number;
  metalness?: number;
  emissive?: THREE.Color;
  emissiveIntensity?: number;
  map?: THREE.Texture | null;
  normalMap?: THREE.Texture | null;
  roughnessMap?: THREE.Texture | null;
  metalnessMap?: THREE.Texture | null;
};

const isColor = (value: unknown): value is THREE.Color => Boolean(value && (value as THREE.Color).isColor);

const captureBaseline = (material: OverridableMaterial): MaterialBaseline => ({
  color: isColor(material.color) ? material.color.clone() : undefined,
  roughness: typeof material.roughness === 'number' ? material.roughness : undefined,
  metalness: typeof material.metalness === 'number' ? material.metalness : undefined,
  emissive: isColor(material.emissive) ? material.emissive.clone() : undefined,
  emissiveIntensity: typeof material.emissiveIntensity === 'number' ? material.emissiveIntensity : undefined,
  opacity: material.opacity,
  transparent: material.transparent,
  alphaTest: material.alphaTest,
  side: material.side,
  forceSinglePass: material.forceSinglePass,
  hasMap: 'map' in material,
  map: material.map ?? null,
  hasNormalMap: 'normalMap' in material,
  normalMap: material.normalMap ?? null,
  hasRoughnessMap: 'roughnessMap' in material,
  roughnessMap: material.roughnessMap ?? null,
  hasMetalnessMap: 'metalnessMap' in material,
  metalnessMap: material.metalnessMap ?? null,
  appliedMap: material.map ?? null,
  appliedNormalMap: material.normalMap ?? null,
  appliedRoughnessMap: material.roughnessMap ?? null,
  appliedMetalnessMap: material.metalnessMap ?? null,
  appliedTransparent: material.transparent,
  appliedAlphaTest: material.alphaTest,
  appliedSide: material.side,
  appliedForceSinglePass: material.forceSinglePass,
  physical: isOwnPhysical(material) ? capturePhysical(material) : null,
});

const baselineOf = (material: THREE.Material): MaterialBaseline => {
  let baseline = baselines.get(material);
  if (!baseline) {
    baseline = captureBaseline(material as OverridableMaterial);
    baselines.set(material, baseline);
  }
  return baseline;
};

/**
 * Notes how materials look as imported, before a tool puts a look of its own on them that an override
 * will later hold (Retexture trying results on): restoring then puts back what they had, not the result.
 */
export const rememberImportedLook = (materials: readonly THREE.Material[]): void => {
  for (const material of materials) baselineOf(material);
};

const collectMaterials = (root: THREE.Object3D): THREE.Material[] => {
  const materials = new Set<THREE.Material>();
  root.traverse((child) => {
    const material = (child as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!material) return;
    for (const candidate of Array.isArray(material) ? material : [material]) {
      // A card fringe's stand-in for the parts it does not draw is no material of the model's.
      if (candidate && !candidate.userData[CARD_FRINGE_KEY]) materials.add(candidate);
    }
  });
  return [...materials];
};

/** Shader-affecting state: a change needs `material.needsUpdate`. */
const programKey = (material: OverridableMaterial) =>
  `${Boolean(material.map)}|${Boolean(material.normalMap)}|${Boolean(material.roughnessMap)}|${Boolean(material.metalnessMap)}|${material.transparent}|${material.alphaTest > 0}|${material.side}|${material.forceSinglePass}`;

const restoreBaseline = (material: OverridableMaterial, baseline: MaterialBaseline) => {
  if (baseline.color && material.color) material.color.copy(baseline.color);
  if (baseline.roughness !== undefined) material.roughness = baseline.roughness;
  if (baseline.metalness !== undefined) material.metalness = baseline.metalness;
  if (baseline.emissive && material.emissive) material.emissive.copy(baseline.emissive);
  if (baseline.emissiveIntensity !== undefined) material.emissiveIntensity = baseline.emissiveIntensity;
  material.opacity = baseline.opacity;
  material.transparent = baseline.transparent;
  material.alphaTest = baseline.alphaTest;
  material.side = baseline.side;
  material.forceSinglePass = baseline.forceSinglePass;
  if (baseline.hasMap) material.map = baseline.map;
  if (baseline.hasNormalMap) material.normalMap = baseline.normalMap;
  if (baseline.hasRoughnessMap) material.roughnessMap = baseline.roughnessMap;
  if (baseline.hasMetalnessMap) material.metalnessMap = baseline.metalnessMap;
};

export interface ApplyMaterialOverridesResult {
  /** Material names that matched an override entry. */
  appliedMaterialNames: Set<string>;
  /** `${slot}:${textureId}` keys of the textures now bound by overrides. */
  boundTextureKeys: Set<string>;
  /** Texture ids an override asked for that the resolver could not supply (the imported map stays). */
  missingTextureIds: Set<string>;
}

/**
 * How a painted texture is drawn: cut out where it is see-through, and from both sides. three draws anything see-through and
 * two-sided twice, rebuilding the material each time for every mesh in every frame; only blended glass gains from that.
 */
export const drawAsPaintedTexture = (material: THREE.Material): void => {
  material.transparent = true;
  material.alphaTest = 0.5;
  material.side = THREE.DoubleSide;
  material.forceSinglePass = true;
  material.needsUpdate = true;
};

/**
 * Apply `overrides` to every material under `root` (matched by material
 * name). Materials touched by an earlier apply but absent from `overrides`
 * revert to their imported values. Textures come from `resolveTexture`; they
 * are bound, never disposed here.
 */
/** Unlit, Lambert, Phong and toon materials as standard ones, kept per material so each converts once. */
const converted = new WeakMap<THREE.Material, THREE.MeshStandardMaterial>();
const originals = new WeakMap<THREE.Material, THREE.Material>();

/** Whether a material is of a kind a material asset cannot shade until it is converted. */
export const convertsForAsset = (material: THREE.Material): boolean => {
  const m = material as THREE.MeshBasicMaterial & THREE.MeshPhongMaterial & THREE.MeshLambertMaterial & THREE.MeshToonMaterial;
  return !!(m.isMeshBasicMaterial || m.isMeshPhongMaterial || m.isMeshLambertMaterial || m.isMeshToonMaterial);
};

/** A standard material keeping another's colour, maps, emission and how it blends (its asset decides the rest). */
export const standardCopyOf = (material: THREE.Material): THREE.MeshStandardMaterial => {
  let copy = converted.get(material);
  if (copy) return copy;
  const m = material as THREE.MeshPhongMaterial & THREE.MeshBasicMaterial;
  copy = new THREE.MeshStandardMaterial({
    name: material.name, color: m.color?.clone() ?? new THREE.Color(1, 1, 1), map: m.map ?? null, alphaMap: m.alphaMap ?? null,
    emissive: m.emissive?.clone() ?? new THREE.Color(0, 0, 0), emissiveMap: m.emissiveMap ?? null, emissiveIntensity: m.emissiveIntensity ?? 1,
    normalMap: m.normalMap ?? null, aoMap: m.aoMap ?? null, transparent: material.transparent, opacity: material.opacity,
    side: material.side, alphaTest: material.alphaTest, vertexColors: material.vertexColors,
    // Phong's shininess as a roughness, roughly; the others were matte.
    roughness: m.isMeshPhongMaterial ? Math.max(0.05, 1 - Math.sqrt(Math.min(m.shininess ?? 30, 1000) / 1000)) : 1, metalness: 0,
  });
  converted.set(material, copy);
  originals.set(copy, material);
  return copy;
};

/**
 * Meshes' unlit, Lambert, Phong and toon materials whose override names a material asset, swapped for standard copies
 * that can take it (Material Overrides' "Convert to a material"); a copy whose override no longer names one gives the
 * mesh its own material back.
 */
const convertForAssets = (root: THREE.Object3D, overrides: MaterialOverrides): void => {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    let changed = false;
    const next = list.map((material) => {
      if (!material) return material;
      const wanted = Boolean(material.name && overrides[material.name]?.materialId);
      if (wanted && convertsForAsset(material)) { changed = true; return standardCopyOf(material); }
      const original = originals.get(material);
      if (!wanted && original) { changed = true; return original; }
      return material;
    });
    if (changed) mesh.material = Array.isArray(mesh.material) ? next : next[0];
  });
};

export const applyMaterialOverrides = (
  root: THREE.Object3D,
  overrides: MaterialOverrides,
  resolveTexture?: MaterialTextureResolver,
): ApplyMaterialOverridesResult => {
  convertForAssets(root, overrides);
  const result: ApplyMaterialOverridesResult = {
    appliedMaterialNames: new Set(),
    boundTextureKeys: new Set(),
    missingTextureIds: new Set(),
  };
  const bindTexture = (textureId: string | undefined, slot: MaterialTextureSlot): THREE.Texture | null => {
    if (!textureId) return null;
    const texture = resolveTexture?.(textureId, slot) ?? null;
    if (!texture) {
      result.missingTextureIds.add(textureId);
      return null;
    }
    result.boundTextureKeys.add(`${slot}:${textureId}`);
    return texture;
  };

  for (const raw of collectMaterials(root)) {
    const material = raw as OverridableMaterial;
    const override = material.name ? overrides[material.name] : undefined;
    if (!override && !baselines.has(material)) continue;
    const before = programKey(material);
    const baseline = baselineOf(material);
    // A map or drawing rebound since the last apply (a texture preview, an older
    // tool) becomes the imported value, so restoring never puts back a replaced,
    // disposed map. A map an override is about to bind (one tagged for it, as
    // Retexture's are when saved) is not the imported value, nor is how it draws.
    const rebound = (slot: THREE.Texture | null | undefined, applied: THREE.Texture | null) =>
      (slot ?? null) !== applied && overrideTextureKey(slot) === null;
    const overrideMapPut = (material.map ?? null) !== baseline.appliedMap && overrideTextureKey(material.map) !== null;
    const mapRebound = baseline.hasMap && rebound(material.map, baseline.appliedMap);
    if (mapRebound) baseline.map = material.map ?? null;
    if (baseline.hasNormalMap && rebound(material.normalMap, baseline.appliedNormalMap)) baseline.normalMap = material.normalMap ?? null;
    if (baseline.hasRoughnessMap && rebound(material.roughnessMap, baseline.appliedRoughnessMap)) baseline.roughnessMap = material.roughnessMap ?? null;
    if (baseline.hasMetalnessMap && rebound(material.metalnessMap, baseline.appliedMetalnessMap)) baseline.metalnessMap = material.metalnessMap ?? null;
    if (!overrideMapPut) {
      if (mapRebound || material.transparent !== baseline.appliedTransparent) baseline.transparent = material.transparent;
      if (mapRebound || material.alphaTest !== baseline.appliedAlphaTest) baseline.alphaTest = material.alphaTest;
      if (mapRebound || material.side !== baseline.appliedSide) baseline.side = material.side;
      if (mapRebound || material.forceSinglePass !== baseline.appliedForceSinglePass) baseline.forceSinglePass = material.forceSinglePass;
    }
    restoreBaseline(material, baseline);
    if (override) {
      result.appliedMaterialNames.add(material.name);
      if (override.color && material.color) material.color.set(override.color);
      if (override.roughness !== undefined && baseline.roughness !== undefined) material.roughness = override.roughness;
      if (override.metalness !== undefined && baseline.metalness !== undefined) material.metalness = override.metalness;
      if (override.emissive && material.emissive) material.emissive.set(override.emissive);
      if (override.emissiveIntensity !== undefined && baseline.emissiveIntensity !== undefined) {
        material.emissiveIntensity = override.emissiveIntensity;
      }
      if (override.opacity !== undefined) {
        material.opacity = override.opacity;
        material.transparent = baseline.transparent || override.opacity < 1;
      }
      if (baseline.hasMap) {
        const map = bindTexture(override.mapTextureId, 'map');
        if (map) {
          material.map = map;
          if (override.paintedMap) {
            // A painted picture shows its own colours: a plain colour tinted nothing until now.
            if (!baseline.map && override.color === undefined) material.color?.set(0xffffff);
            material.transparent = true;
            material.alphaTest = 0.5;
            material.side = THREE.DoubleSide;
            material.forceSinglePass = true;
          }
        }
      }
      if (baseline.hasNormalMap) {
        const normalMap = bindTexture(override.normalTextureId, 'normal');
        if (normalMap) {
          material.normalMap = normalMap;
          // A normal map compressed to red and green (BC5) has its blue rebuilt in the shader.
          if (normalMap.format === THREE.RED_GREEN_RGTC2_Format) rebuildNormalZ(material);
        }
      }
      // A map is multiplied by the value, so with a map the value steps aside unless the override sets it too.
      if (baseline.hasRoughnessMap) {
        const roughnessMap = bindTexture(override.roughnessTextureId, 'roughness');
        if (roughnessMap) {
          material.roughnessMap = roughnessMap;
          if (override.roughness === undefined) material.roughness = 1;
        }
      }
      if (baseline.hasMetalnessMap) {
        const metalnessMap = bindTexture(override.metalnessTextureId, 'metalness');
        if (metalnessMap) {
          material.metalnessMap = metalnessMap;
          if (override.metalness === undefined) material.metalness = 1;
        }
      }
    }
    // An assigned material asset shades it by its graph instead (or no longer, once unassigned).
    materialLibrary.assign(material, override?.materialId ?? null, overrideTextureFlipY(root), materialParameterValues(override?.parameters));
    // A physical material's own values: as imported, then this override's. A material asset shading it
    // decides them itself, and letting go of one gives the material back the values it had, so they are
    // laid on after it has.
    if (baseline.physical && isOwnPhysical(material) && !override?.materialId) {
      restorePhysical(material, baseline.physical);
      if (override) applyPhysical(material, override);
    }
    baseline.appliedMap = material.map ?? null;
    baseline.appliedNormalMap = material.normalMap ?? null;
    baseline.appliedRoughnessMap = material.roughnessMap ?? null;
    baseline.appliedMetalnessMap = material.metalnessMap ?? null;
    baseline.appliedTransparent = material.transparent;
    baseline.appliedAlphaTest = material.alphaTest;
    baseline.appliedSide = material.side;
    baseline.appliedForceSinglePass = material.forceSinglePass;
    if (programKey(material) !== before) material.needsUpdate = true;
  }
  return result;
};

/** Values shown for a material (its imported values when overrides have touched it). */
export interface MaterialValues {
  color: string | null;
  roughness: number | null;
  metalness: number | null;
  emissive: string | null;
  emissiveIntensity: number | null;
  opacity: number;
  hasMapSlot: boolean;
  hasNormalSlot: boolean;
  hasRoughnessSlot: boolean;
  hasMetalnessSlot: boolean;
  /** A physical material's own values, shown as Material Overrides edits them; null for other kinds. */
  physical: PhysicalValues | null;
}

/** A physical material's values as Material Overrides shows them: colours as `#rrggbb`, the direction in degrees. */
export type PhysicalValues = Record<PhysicalOverrideNumber, number> & Record<PhysicalOverrideColor, string>;

const physicalValuesOf = (physical: PhysicalBaseline): PhysicalValues => ({
  coat: physical.clearcoat,
  coatRoughness: physical.clearcoatRoughness,
  sheenColor: physical.sheen > 0 ? `#${physical.sheenColor.getHexString()}` : '#000000',
  sheenRoughness: physical.sheenRoughness,
  thinFilm: physical.iridescence,
  thinFilmThickness: physical.iridescenceThicknessRange[1],
  transmission: physical.transmission,
  thickness: physical.thickness,
  attenuationColor: `#${physical.attenuationColor.getHexString()}`,
  attenuationDistance: physical.attenuationDistance,
  dispersion: physical.dispersion,
  ior: physical.ior,
  specularWeight: physical.specularIntensity,
  specularColor: `#${physical.specularColor.getHexString()}`,
  anisotropy: physical.anisotropy,
  anisotropyRotation: THREE.MathUtils.radToDeg(physical.anisotropyRotation),
});

export interface ModelMaterialInfo {
  /** Override key ('' for an unnamed material, which cannot be overridden). */
  name: string;
  /** three.js material type, e.g. MeshStandardMaterial. */
  type: string;
  /** Distinct material instances sharing the name. */
  instanceCount: number;
  /** Imported values of the first instance. */
  base: MaterialValues;
  /** Whether a material asset can shade it: only standard (lit, physically based) materials take one. */
  takesAsset: boolean;
}

const hexOf = (color: THREE.Color | undefined): string | null => (color ? `#${color.getHexString()}` : null);

/** Imported values of `material` (unchanged by any overrides applied so far). */
export const readMaterialBaseValues = (material: THREE.Material): MaterialValues => {
  const baseline = baselines.get(material) ?? captureBaseline(material as OverridableMaterial);
  return {
    color: hexOf(baseline.color),
    roughness: baseline.roughness ?? null,
    metalness: baseline.metalness ?? null,
    emissive: hexOf(baseline.emissive),
    emissiveIntensity: baseline.emissiveIntensity ?? null,
    opacity: baseline.opacity,
    hasMapSlot: baseline.hasMap,
    hasNormalSlot: baseline.hasNormalMap,
    hasRoughnessSlot: baseline.hasRoughnessMap,
    hasMetalnessSlot: baseline.hasMetalnessMap,
    physical: baseline.physical ? physicalValuesOf(baseline.physical) : null,
  };
};

/** A model's materials grouped by name, in traversal order. */
export const listModelMaterials = (root: THREE.Object3D): ModelMaterialInfo[] => {
  const byName = new Map<string, ModelMaterialInfo>();
  for (const material of collectMaterials(root)) {
    const existing = byName.get(material.name);
    if (existing) {
      existing.instanceCount += 1;
      continue;
    }
    byName.set(material.name, { name: material.name, type: material.type, instanceCount: 1, base: readMaterialBaseValues(material), takesAsset: canBindMaterialGraph(material) });
  }
  return [...byName.values()];
};

/** Override-bound textures currently on `root`'s materials, keyed `${slot}:${textureId}`. */
export const collectOverrideTextures = (root: THREE.Object3D): Map<string, THREE.Texture> => {
  const result = new Map<string, THREE.Texture>();
  for (const material of collectMaterials(root) as OverridableMaterial[]) {
    for (const texture of [material.map, material.normalMap, material.roughnessMap, material.metalnessMap]) {
      const key = overrideTextureKey(texture);
      if (key && texture && !result.has(key)) result.set(key, texture);
    }
  }
  return result;
};

export const overrideTextureCacheKey = (textureId: string, slot: MaterialTextureSlot): string => `${slot}:${textureId}`;

export interface HydrateMaterialOverridesOptions {
  /** URL of a logical texture id, or nothing when the project has no such texture. */
  resolveTextureUrl(textureId: string): string | undefined;
  /** Defaults to THREE.TextureLoader. */
  /** Loads a texture for the way it is read (the project's texture loader: decoded at its depth, compressed by role). */
  loadTexture?(url: string, request: { textureId: string; slot: 'map' | 'normal' | 'data'; flipY: boolean }): Promise<THREE.Texture>;
  /** Throws when the caller no longer wants the result (checked after every load). */
  assertCurrent?(): void;
}

/**
 * Load the textures a stored `materialOverrides` value references and apply
 * it to a freshly loaded model, with the model's older `textureOverrides`
 * (`legacyBaseMaps`) taken in as painted base maps. Bound textures become owned
 * by the model's materials; any other loaded texture is disposed, including on
 * failure. Returns the normalized overrides to keep on the model.
 */
export const hydrateMaterialOverrides = async (
  root: THREE.Object3D,
  value: unknown,
  options: HydrateMaterialOverridesOptions,
  legacyBaseMaps?: unknown,
): Promise<MaterialOverrides> => {
  const overrides = withLegacyBaseMaps(normalizeMaterialOverrides(value), legacyBaseMaps);
  if (Object.keys(overrides).length === 0) return overrides;
  const load = options.loadTexture ?? ((url: string) => new THREE.TextureLoader().loadAsync(url));
  // Read as a material reads them: colour, a normal, or data (roughness, metalness).
  const readAs = (slot: MaterialTextureSlot): 'map' | 'normal' | 'data' => (slot === 'map' ? 'map' : slot === 'normal' ? 'normal' : 'data');
  const loaded = new Map<string, THREE.Texture>();
  const flipY = overrideTextureFlipY(root);
  let bound = new Set<string>();
  try {
    for (const { textureId, slot } of materialOverrideTextureIds(overrides)) {
      const url = options.resolveTextureUrl(textureId);
      if (!url) continue;
      const texture = await load(url, { textureId, slot: readAs(slot), flipY });
      loaded.set(overrideTextureCacheKey(textureId, slot), tagOverrideTexture(texture, textureId, slot, flipY));
      options.assertCurrent?.();
    }
    bound = applyMaterialOverrides(root, overrides, (textureId, slot) => loaded.get(overrideTextureCacheKey(textureId, slot))).boundTextureKeys;
    return overrides;
  } finally {
    for (const [key, texture] of loaded) {
      if (!bound.has(key)) texture.dispose();
    }
  }
};
