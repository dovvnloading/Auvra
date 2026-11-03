import * as THREE from 'three';
import { materialLibrary } from '../runtime/materials/materialLibrary';
import { CARD_FRINGE_KEY } from './processing/ModelMaterials';
import { MAX_PARAMETER_NAME_LENGTH, type MaterialParameterValues } from '../runtime/materials/materialGraph';

/**
 * Per-model material overrides, keyed by material name. Every field is
 * optional: an unset field keeps the material's imported value. Applying is
 * idempotent and reversible: the first time a material is touched its
 * imported values are captured, and every apply restores them before laying
 * the overrides on top, so removing a field (or a whole entry) reverts it.
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
  /** Logical texture id (textures domain) replacing the normal map. */
  normalTextureId?: string;
  /** Logical texture id replacing the roughness map (standard/physical materials only). */
  roughnessTextureId?: string;
  /** Logical texture id replacing the metalness map (standard/physical materials only). */
  metalnessTextureId?: string;
  /** A material asset (materials domain) whose node graph shades the material instead. */
  materialId?: string;
  /**
   * Values for the material asset's parameters: a number, or an RGB / XYZ triple. A list, not a
   * map by name, so no parameter name ever becomes a document key.
   */
  parameters?: MaterialParameterSetting[];
}

export interface MaterialParameterSetting {
  name: string;
  value: number | number[];
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

const normalizeParameterValue = (value: unknown): number | number[] | undefined => {
  const single = parameterNumber(value);
  if (single !== undefined) return single;
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  const triple = value.map(parameterNumber);
  return triple.every((component): component is number => component !== undefined) ? triple : undefined;
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
    normalTextureId: normalizeTextureId(source.normalTextureId),
    roughnessTextureId: normalizeTextureId(source.roughnessTextureId),
    metalnessTextureId: normalizeTextureId(source.metalnessTextureId),
    materialId: normalizeTextureId(source.materialId),
    parameters: normalizeParameters(source.parameters),
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
  texture.colorSpace = slot === 'map' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.flipY = flipY;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.userData[TEXTURE_ID_KEY] = textureId;
  texture.userData[TEXTURE_SLOT_KEY] = slot;
  return texture;
};

const overrideTextureKey = (texture: THREE.Texture | null | undefined): string | null => {
  const textureId = texture?.userData?.[TEXTURE_ID_KEY];
  const slot = texture?.userData?.[TEXTURE_SLOT_KEY];
  return typeof textureId === 'string' && (slot === 'map' || slot === 'normal' || slot === 'roughness' || slot === 'metalness') ? `${slot}:${textureId}` : null;
};

interface MaterialBaseline {
  color?: THREE.Color;
  roughness?: number;
  metalness?: number;
  emissive?: THREE.Color;
  emissiveIntensity?: number;
  opacity: number;
  transparent: boolean;
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
});

const baselineOf = (material: THREE.Material): MaterialBaseline => {
  let baseline = baselines.get(material);
  if (!baseline) {
    baseline = captureBaseline(material as OverridableMaterial);
    baselines.set(material, baseline);
  }
  return baseline;
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
const programKey = (material: OverridableMaterial) => `${Boolean(material.map)}|${Boolean(material.normalMap)}|${Boolean(material.roughnessMap)}|${Boolean(material.metalnessMap)}|${material.transparent}`;

const restoreBaseline = (material: OverridableMaterial, baseline: MaterialBaseline) => {
  if (baseline.color && material.color) material.color.copy(baseline.color);
  if (baseline.roughness !== undefined) material.roughness = baseline.roughness;
  if (baseline.metalness !== undefined) material.metalness = baseline.metalness;
  if (baseline.emissive && material.emissive) material.emissive.copy(baseline.emissive);
  if (baseline.emissiveIntensity !== undefined) material.emissiveIntensity = baseline.emissiveIntensity;
  material.opacity = baseline.opacity;
  material.transparent = baseline.transparent;
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
export const applyMaterialOverrides = (
  root: THREE.Object3D,
  overrides: MaterialOverrides,
  resolveTexture?: MaterialTextureResolver,
): ApplyMaterialOverridesResult => {
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
    // A map or transparency rebound since the last apply (retexture, texture
    // preview) becomes the imported value, so restoring never puts back a
    // replaced, disposed map.
    const mapRebound = baseline.hasMap && (material.map ?? null) !== baseline.appliedMap;
    if (mapRebound) baseline.map = material.map ?? null;
    if (baseline.hasNormalMap && (material.normalMap ?? null) !== baseline.appliedNormalMap) baseline.normalMap = material.normalMap ?? null;
    if (baseline.hasRoughnessMap && (material.roughnessMap ?? null) !== baseline.appliedRoughnessMap) baseline.roughnessMap = material.roughnessMap ?? null;
    if (baseline.hasMetalnessMap && (material.metalnessMap ?? null) !== baseline.appliedMetalnessMap) baseline.metalnessMap = material.metalnessMap ?? null;
    if (mapRebound || material.transparent !== baseline.appliedTransparent) baseline.transparent = material.transparent;
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
        if (map) material.map = map;
      }
      if (baseline.hasNormalMap) {
        const normalMap = bindTexture(override.normalTextureId, 'normal');
        if (normalMap) material.normalMap = normalMap;
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
    baseline.appliedMap = material.map ?? null;
    baseline.appliedNormalMap = material.normalMap ?? null;
    baseline.appliedRoughnessMap = material.roughnessMap ?? null;
    baseline.appliedMetalnessMap = material.metalnessMap ?? null;
    baseline.appliedTransparent = material.transparent;
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
}

export interface ModelMaterialInfo {
  /** Override key ('' for an unnamed material, which cannot be overridden). */
  name: string;
  /** three.js material type, e.g. MeshStandardMaterial. */
  type: string;
  /** Distinct material instances sharing the name. */
  instanceCount: number;
  /** Imported values of the first instance. */
  base: MaterialValues;
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
    byName.set(material.name, { name: material.name, type: material.type, instanceCount: 1, base: readMaterialBaseValues(material) });
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
  loadTexture?(url: string): Promise<THREE.Texture>;
  /** Throws when the caller no longer wants the result (checked after every load). */
  assertCurrent?(): void;
}

/**
 * Load the textures a stored `materialOverrides` value references and apply
 * it to a freshly loaded model. Bound textures become owned by the model's
 * materials; any other loaded texture is disposed, including on failure.
 * Returns the normalized overrides to keep on the model.
 */
export const hydrateMaterialOverrides = async (
  root: THREE.Object3D,
  value: unknown,
  options: HydrateMaterialOverridesOptions,
): Promise<MaterialOverrides> => {
  const overrides = normalizeMaterialOverrides(value);
  if (Object.keys(overrides).length === 0) return overrides;
  const load = options.loadTexture ?? ((url: string) => new THREE.TextureLoader().loadAsync(url));
  const loaded = new Map<string, THREE.Texture>();
  const flipY = overrideTextureFlipY(root);
  let bound = new Set<string>();
  try {
    for (const { textureId, slot } of materialOverrideTextureIds(overrides)) {
      const url = options.resolveTextureUrl(textureId);
      if (!url) continue;
      const texture = await load(url);
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
