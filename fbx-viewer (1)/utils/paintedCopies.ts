import { MATERIAL_PICTURE_NODE_TYPE, OUTPUT_NODE_TYPE, defaultParams, normalizeMaterialGraph, type MaterialGraph } from '../runtime/materials/materialGraph';
import type { MaterialAsset } from '../runtime/materials/materialLibrary';
import type { MaterialOverrides } from './materialOverrides';

/**
 * PAINTED COPIES
 *
 * A picture painted onto a model's material (Retexture's results, the mask tool's) is kept as a material
 * document the model owns: its painted picture as its base colour, everything else (normal, roughness,
 * metalness, occlusion, emission maps and values) the model's own, through the surface's "keep the model's
 * own maps" setting. The material's override points at the copy (its materialId); Reset Textures drops it.
 *
 * Material Overrides and Retexture still edit a painted base map (an override's mapTextureId with
 * paintedMap): expandPaintedCopies shows each copy that way, and contractPaintedCopies turns them back
 * into copies as the overrides are saved. Older projects' painted base maps draw as they always did and
 * become copies the next time the model's overrides are saved.
 */

/** Who owns a painted copy: a model, for one of its materials. */
export interface PaintedCopyOwner { modelId: string; material: string }

/** The surface of a painted copy: the painted picture over the model's own maps, cut out where it is see-through, both sides. */
export const paintedCopyGraph = (): MaterialGraph => normalizeMaterialGraph({
    nodes: [
        { id: 'output', type: OUTPUT_NODE_TYPE, x: 480, y: 120, params: { ...defaultParams(OUTPUT_NODE_TYPE), ownMaps: true, blendMode: 'masked', alphaClip: 0.5, twoSided: true } },
        { id: 'painted', type: MATERIAL_PICTURE_NODE_TYPE, x: 160, y: 120, params: { ...defaultParams(MATERIAL_PICTURE_NODE_TYPE), output: 'baseColor' } },
    ],
    links: [
        { fromNode: 'painted', fromOutput: 'rgb', toNode: 'output', toInput: 'baseColor' },
        { fromNode: 'painted', fromOutput: 'a', toNode: 'output', toInput: 'opacity' },
    ],
});

/** Whether an asset is a painted copy some model owns (not a material to list or give to others). */
export const isPaintedCopy = (asset: Pick<MaterialAsset, 'owner'> | undefined): boolean => Boolean(asset?.owner);

/**
 * The overrides with each painted base map kept as a painted copy the model owns: the copies to save
 * (new, or carrying a new picture) and the model's copies no longer used, to delete once the overrides are saved.
 */
export const contractPaintedCopies = (
    modelId: string,
    overrides: MaterialOverrides,
    assets: readonly MaterialAsset[],
    newId: () => string = () => crypto.randomUUID(),
): { overrides: MaterialOverrides; upserts: MaterialAsset[]; removals: string[] } => {
    const owned = assets.filter(asset => asset.owner?.modelId === modelId);
    const used = new Set<string>();
    const upserts: MaterialAsset[] = [];
    const next: MaterialOverrides = {};
    for (const [name, entry] of Object.entries(overrides)) {
        if (entry.paintedMap && entry.mapTextureId && !entry.materialId) {
            const existing = owned.find(asset => asset.owner?.material === name);
            const copy: MaterialAsset = {
                id: existing?.id ?? newId(),
                name: `Painted ${name}`,
                graph: existing?.graph ?? paintedCopyGraph(),
                owner: { modelId, material: name },
                pictures: { baseColor: entry.mapTextureId },
            };
            if (existing?.pictures?.baseColor !== entry.mapTextureId) upserts.push(copy);
            used.add(copy.id);
            const { mapTextureId: _map, paintedMap: _painted, ...rest } = entry;
            next[name] = { ...rest, materialId: copy.id };
        } else {
            if (entry.materialId) used.add(entry.materialId);
            next[name] = entry;
        }
    }
    return { overrides: next, upserts, removals: owned.filter(asset => !used.has(asset.id)).map(asset => asset.id) };
};

/** The overrides with each painted copy shown as the painted base map it carries (what Material Overrides and Retexture edit). */
export const expandPaintedCopies = (overrides: MaterialOverrides | undefined, lookup: (id: string) => MaterialAsset | undefined): MaterialOverrides => {
    const next: MaterialOverrides = {};
    for (const [name, entry] of Object.entries(overrides ?? {})) {
        const copy = entry.materialId ? lookup(entry.materialId) : undefined;
        const picture = copy?.owner ? copy.pictures?.baseColor : undefined;
        if (!picture) { next[name] = entry; continue; }
        const { materialId: _copy, ...rest } = entry;
        next[name] = { ...rest, mapTextureId: picture, paintedMap: true };
    }
    return next;
};
