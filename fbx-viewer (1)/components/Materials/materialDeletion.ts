import type { LevelObject, LoadedModelData } from '../../types';
import type { MaterialOverrides } from '../../utils/materialOverrides';

/**
 * DELETING A MATERIAL ASSET
 *
 * What uses a material asset, said plainly before it is deleted (deleting returns those models to their
 * own materials), and what an undo puts back: the asset itself and the models' overrides that named it.
 */

export interface MaterialUses {
    /** Models whose material overrides name it, with their overrides as they are now. */
    models: Array<{ id: string; name: string; overrides: MaterialOverrides }>;
    /** Decals (placed objects' components) drawing it. */
    decals: number;
}

/** What uses a material asset. */
export const materialUses = (
    assetId: string,
    models: ReadonlyArray<Pick<LoadedModelData, 'id' | 'name' | 'materialOverrides'>>,
    objects: ReadonlyArray<Pick<LevelObject, 'components'>>,
): MaterialUses => ({
    models: models
        .filter(model => Object.values(model.materialOverrides ?? {}).some(override => override.materialId === assetId))
        .map(model => ({ id: model.id, name: model.name, overrides: structuredClone(model.materialOverrides ?? {}) })),
    decals: objects.reduce((count, object) => count + (object.components ?? []).filter(component => component.props?.materialId === assetId).length, 0),
});

const listNames = (names: readonly string[]): string => {
    const shown = names.slice(0, 3);
    const rest = names.length - shown.length;
    return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0] ?? '';
};

/** The question asked before deleting, naming what uses it. */
export const deleteMaterialQuestion = (name: string, uses: MaterialUses): { title: string; message: string } => {
    const parts: string[] = [];
    const names = listNames(uses.models.map(model => model.name));
    if (uses.models.length) parts.push(uses.models.length === 1 ? `the model ${names}` : `${uses.models.length} models (${names})`);
    if (uses.decals) parts.push(uses.decals === 1 ? 'a decal' : `${uses.decals} decals`);
    const message = parts.length
        ? `It is used by ${parts.join(' and ')}, which go back to their own materials. You can undo this.`
        : 'Nothing uses it. You can undo this.';
    return { title: `Delete "${name}"?`, message };
};
