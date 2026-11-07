import type { MaterialOverrides } from '../../../utils/materialOverrides';
import { newFillLayer, type FillSource, type PaintChannel, type PaintDocument, type PaintLayer } from '../../../texturing/paint/paintTypes';

/**
 * RETEXTURE RESULTS AS LAYERS
 *
 * What Retexture made for a texture set comes into Paint as a fill layer of its picture (and the surface
 * maps that went with it), to mask and paint over like any other layer, instead of only an override.
 * Found two ways, both read only:
 * - the result the set wears: a painted copy the model owns (utils/paintedCopies.ts: the override names
 *   it by materialId, its base colour picture is the result) or, in older projects, an override's
 *   painted base map; with the override's normal, roughness and metalness maps;
 * - results kept in the texture library from Retexture: named after the model and the set
 *   ("<model> <set> - <words>"), surface maps after them with the map's name.
 */

export interface RetextureResult {
    key: string;
    /** What it is called in the list: the words it was made from, where known. */
    name: string;
    textures: Partial<Record<'baseColor' | 'normal' | 'roughness' | 'metallic', string>>;
}

/** The start of a kept result's name, as Retexture names it (models' and sets' names cleaned as it cleans them). */
export const retextureNamePrefix = (modelName: string, partName: string): string =>
    `${modelName} ${partName} - `.replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trimStart();

const SURFACE_SUFFIXES: ReadonlyArray<[string, 'normal' | 'roughness' | 'metallic']> = [[' normal', 'normal'], [' roughness', 'roughness'], [' metalness', 'metallic']];

/**
 * The Retexture results a texture set can take as a layer: the one it wears, then those kept in the
 * texture library for it, newest last as the library lists them.
 */
export const retextureResults = (
    set: { modelName: string; partName: string; materialNames: readonly string[] },
    overrides: MaterialOverrides | undefined,
    assetOf: (id: string) => { owner?: { modelId: string; material: string }; pictures?: Partial<Record<string, string>> } | undefined,
    textures: ReadonlyArray<{ id: string; name: string }>,
): RetextureResult[] => {
    const results: RetextureResult[] = [];
    const seen = new Set<string>();
    for (const name of set.materialNames) {
        const entry = overrides?.[name];
        if (!entry) continue;
        const copy = entry.materialId ? assetOf(entry.materialId) : undefined;
        const base = copy?.owner ? copy.pictures?.baseColor : entry.paintedMap ? entry.mapTextureId : undefined;
        if (!base || seen.has(base)) continue;
        seen.add(base);
        const named = textures.find((texture) => texture.id === base)?.name;
        results.push({
            key: `worn:${base}`,
            name: `Worn now${named ? `: ${named.split(' - ').slice(1).join(' - ') || named}` : ''}`,
            textures: { baseColor: base, ...(entry.normalTextureId ? { normal: entry.normalTextureId } : {}), ...(entry.roughnessTextureId ? { roughness: entry.roughnessTextureId } : {}), ...(entry.metalnessTextureId ? { metallic: entry.metalnessTextureId } : {}) },
        });
    }
    const prefix = retextureNamePrefix(set.modelName, set.partName);
    const kept = textures.filter((texture) => texture.name.startsWith(prefix));
    for (const texture of kept) {
        if (SURFACE_SUFFIXES.some(([suffix]) => texture.name.endsWith(suffix)) || seen.has(texture.id)) continue;
        seen.add(texture.id);
        const result: RetextureResult = { key: `kept:${texture.id}`, name: texture.name.slice(prefix.length) || texture.name, textures: { baseColor: texture.id } };
        for (const [suffix, channel] of SURFACE_SUFFIXES) {
            const surface = kept.find((other) => other.name === `${texture.name}${suffix}`);
            if (surface) result.textures[channel] = surface.id;
        }
        results.push(result);
    }
    return results;
};

/** A fill layer of a Retexture result: its picture on base colour and its surface maps on theirs, along the UVs (channels the set paints). */
export const retextureLayer = (document: PaintDocument, result: RetextureResult): PaintLayer => {
    const fills: Partial<Record<PaintChannel, FillSource>> = {};
    for (const [channel, textureId] of Object.entries(result.textures) as Array<[PaintChannel, string]>) {
        if (document.channels.includes(channel)) fills[channel] = { kind: 'texture', textureId, projection: 'uv', scale: 1, rotation: 0, sharpness: 4 };
    }
    return newFillLayer(document, `Retexture: ${result.name}`.slice(0, 80), fills);
};
