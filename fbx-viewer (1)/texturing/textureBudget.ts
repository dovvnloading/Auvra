import type { LevelObject, LoadedModelData, TextureData } from '../types';
import { textureMemoryBytes } from '../utils/textureCompression/materialTextureEncoder';
import { keptFormat, limitedSize, textureRole, type CompressionSupport, type KeptFormat, type TextureSettings } from './textureSettings';

/**
 * TEXTURE MEMORY
 *
 * What a project's textures cost on the GPU, worked out from their sizes and settings (as the material
 * library would keep them: compressed by role, limited in size, with mip levels), per material asset and
 * per level, with plain warnings where it is a lot.
 */

export interface TextureCost {
    id: string;
    name: string;
    width: number;
    height: number;
    format: KeptFormat;
    bytes: number;
}

type TextureInfo = Pick<TextureData, 'id' | 'name' | 'dimensions'> & { settings?: TextureSettings };

/** What one texture costs where it is read in `slot` (as colour, a normal or data). */
export const textureCost = (texture: TextureInfo, slot: 'map' | 'normal' | 'data', support: CompressionSupport): TextureCost => {
    const settings = texture.settings;
    const { width, height } = limitedSize(texture.dimensions.width || 1, texture.dimensions.height || 1, settings?.maxSize);
    const source = settings?.source;
    const format = keptFormat(textureRole(slot, settings), settings, support, {
        channels: source?.channels ?? 4, depth: source?.depth ?? 8, hdr: source?.hdr === true, width, height,
    });
    return { id: texture.id, name: texture.name, width, height, format, bytes: textureMemoryBytes(width, height, format, settings?.mips !== false) };
};

/** The total of costs counted once each, largest first. */
export const sumCosts = (costs: Iterable<TextureCost>): { bytes: number; textures: TextureCost[] } => {
    const byId = new Map<string, TextureCost>();
    for (const cost of costs) {
        const known = byId.get(cost.id);
        // The same texture read two ways is kept once: counted at its dearer way.
        if (!known || cost.bytes > known.bytes) byId.set(cost.id, cost);
    }
    const textures = [...byId.values()].sort((a, b) => b.bytes - a.bytes);
    return { bytes: textures.reduce((sum, cost) => sum + cost.bytes, 0), textures };
};

/** Texture ids anywhere in a document, by their keys (`textureId`, `mapTextureId`...) and texture parameter values. */
export const textureIdsIn = (value: unknown, known: ReadonlySet<string>, into = new Set<string>()): Set<string> => {
    if (Array.isArray(value)) for (const item of value) textureIdsIn(item, known, into);
    else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            if (typeof child === 'string' && (/textureId$/i.test(key) || (key === 'value' && known.has(child)) || (key === 'texture' && known.has(child)))) {
                if (known.has(child)) into.add(child);
            } else textureIdsIn(child, known, into);
        }
    }
    return into;
};

interface MaterialInfo { id: string; name: string; textureIds: readonly string[]; slots?: ReadonlyMap<string, 'map' | 'normal' | 'data'> }

/** What a material asset's textures cost. */
export const materialTextureCost = (material: MaterialInfo, textures: ReadonlyMap<string, TextureInfo>, support: CompressionSupport) =>
    sumCosts(material.textureIds.flatMap((id) => {
        const texture = textures.get(id);
        return texture ? [textureCost(texture, material.slots?.get(id) ?? 'map', support)] : [];
    }));

/**
 * What a level's textures cost: those of the material assets its placed models' materials use (and their
 * own values), the textures its objects name (decals, terrain layers, material overrides).
 */
export const levelTextureCost = (
    objects: readonly LevelObject[],
    models: readonly Pick<LoadedModelData, 'id' | 'materialOverrides'>[],
    materials: ReadonlyMap<string, MaterialInfo>,
    textures: ReadonlyMap<string, TextureInfo>,
    support: CompressionSupport,
) => {
    const known = new Set(textures.keys());
    const costs: TextureCost[] = [];
    const add = (id: string, slot: 'map' | 'normal' | 'data' = 'map') => {
        const texture = textures.get(id);
        if (texture) costs.push(textureCost(texture, slot, support));
    };
    const addMaterial = (materialId: unknown) => {
        const material = typeof materialId === 'string' ? materials.get(materialId) : undefined;
        for (const id of material?.textureIds ?? []) add(id, material?.slots?.get(id));
    };
    const placed = new Set(objects.map(object => object.modelId).filter(Boolean));
    for (const model of models) {
        if (!placed.has(model.id)) continue;
        for (const override of Object.values(model.materialOverrides ?? {})) addMaterial(override.materialId);
        for (const id of textureIdsIn(model.materialOverrides, known)) add(id);
    }
    for (const object of objects) {
        for (const component of object.components ?? []) addMaterial(component.props?.materialId);
        for (const id of textureIdsIn(object, known)) add(id);
    }
    return sumCosts(costs);
};

const megabytes = (bytes: number): string => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(bytes >= 10 * 1024 ** 2 ? 0 : 1)} MB`);

/** Bytes in plain words. */
export const memoryWords = megabytes;

/** Plain warnings about what a level's textures cost, against the game's asset memory (in MB) when it has one. */
export const budgetWarnings = (level: { bytes: number; textures: readonly TextureCost[] }, budgetMb?: number): string[] => {
    const warnings: string[] = [];
    if (budgetMb && level.bytes > budgetMb * 1024 ** 2) {
        warnings.push(`This level's textures need ${megabytes(level.bytes)}, more than the game's ${budgetMb} MB of asset memory. Compress textures or limit their size.`);
    }
    for (const texture of level.textures) {
        if ((texture.format === 'rgba8' || texture.format === 'half') && texture.bytes >= 16 * 1024 ** 2) {
            const why = texture.format === 'half' ? 'it is floating point' : 'it is not compressed';
            warnings.push(`${texture.name} takes ${megabytes(texture.bytes)} because ${why}: compression or a smaller size limit would take far less.`);
        } else if (texture.width >= 8192 || texture.height >= 8192) {
            warnings.push(`${texture.name} is drawn at ${texture.width}×${texture.height}: a size limit of 4096 would take a quarter of the memory.`);
        }
    }
    return warnings;
};
