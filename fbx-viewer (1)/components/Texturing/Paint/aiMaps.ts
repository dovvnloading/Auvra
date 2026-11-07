import { hostProviderService, type ProviderModel } from '../../../services/HostProviderService';
import { estimateJobCost } from '../../../services/providerPricing';
import { textureService } from '../../../services/TextureGenerationService';
import type { AiMapRole } from '../../../texturing/paint/photoMaterial';
import type { StorePicture } from './photoImport';

/**
 * THE AI MATCHING-MAPS STEP FOR PHOTO MATERIALS
 *
 * A photo material's tiled colour, with its lighting taken out (never the raw photo, whose light and
 * edges would be read into the maps), sent to the provider set up for surface maps; the normal,
 * roughness, metal and height it gives back line up with that colour, and are kept in the texture
 * library for the graph to mix with its own (photoMaterial.withAiMaps).
 */

const MAPS_PROVIDER = 'fal';
const ROLES: readonly AiMapRole[] = ['normal', 'roughness', 'metalness', 'height'];
/** The largest side sent. */
export const AI_MAPS_LARGEST = 1024;

/** The model that makes surface maps, when a provider for them is set up; null otherwise. */
export const aiMapsModel = async (): Promise<ProviderModel | null> => {
    try {
        return (await hostProviderService.listModels(MAPS_PROVIDER, 'media.maps'))[0] ?? null;
    } catch {
        return null;
    }
};

/** About what refining a colour `side` pixels across comes to, in micro-USD (null when not known). */
export const aiMapsCost = (model: ProviderModel, side: number): number | null => estimateJobCost(model, (Math.min(side, AI_MAPS_LARGEST) ** 2) / 1_000_000);

/**
 * Maps made by `model` for `colour` (a PNG), kept in the texture library under Photos named after
 * `baseName`. The host's own copies are let go once kept here.
 */
export const makeAiMaps = async (colour: Blob, model: ProviderModel, baseName: string, store: StorePicture): Promise<{ role: AiMapRole; texture: string }[]> => {
    const assetId = await textureService.ingestPicture(colour);
    const route = await hostProviderService.loadConfiguredRoute('media.maps');
    if (route?.modelId !== model.id) await hostProviderService.routeCapability(MAPS_PROVIDER, 'media.maps', model.id);
    const job = await textureService.submit(assetId, 'Surface maps for this texture', 'media.maps');
    const preview = await textureService.follow(job);
    const maps = preview.maps ?? [];
    const kept: { role: AiMapRole; texture: string }[] = [];
    try {
        for (const map of maps) {
            if (!(ROLES as readonly string[]).includes(map.role)) continue;
            const blob = await (await fetch(map.previewUrl)).blob();
            const bitmap = await createImageBitmap(blob);
            const size = { width: bitmap.width, height: bitmap.height };
            bitmap.close();
            kept.push({ role: map.role as AiMapRole, texture: await store(blob, `${baseName} AI ${map.role}`, size, 'Photos') });
        }
    } finally {
        const urls = new Set([preview.previewUrl, ...maps.map((map) => map.previewUrl)]);
        for (const url of urls) if (url) URL.revokeObjectURL(url);
        for (const map of maps) void textureService.discard(job.jobId, map.previewAssetId).catch(() => undefined);
    }
    if (!kept.length) throw new Error('The AI gave back no maps for this colour.');
    return kept;
};
