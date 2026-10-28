import type { LoadedModelData } from '../types';

/**
 * The one model the Scene tab's viewer shows, as an engine's asset viewer shows one asset: the
 * selected model when it is in the viewer, else the first model put in the viewer, else none.
 */
export const viewerModel = <T extends Pick<LoadedModelData, 'id' | 'isPlacedInScene'>>(
    models: readonly T[],
    selectedModelId: string | null,
): T | null =>
    models.find(model => model.isPlacedInScene && model.id === selectedModelId)
    ?? models.find(model => model.isPlacedInScene)
    ?? null;
