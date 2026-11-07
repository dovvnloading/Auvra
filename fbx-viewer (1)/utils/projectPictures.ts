import { normalizeTextureSettings } from '../texturing/textureSettings';
import { projectService } from './projectService';
import { nativeDomainRecords } from './projectRecords';
import { portableSettings, type LibraryPicture } from './userMaterialLibrary';

/**
 * PICTURES THE PROJECT KEEPS, READ FROM THE PROJECT
 *
 * The editor loads the pictures the open level needs, so a material's own pictures (what its texture graph last
 * made, say) may be in the project without being loaded. Taking a material out of the project (into My library, or
 * a material package) reads those from the project itself: each picture's record and its file (and the 8-bit
 * preview of a deep one).
 */

/** The pictures of `textureIds` the project keeps, as the library keeps pictures; those it does not keep are left out. */
export const readProjectPictures = async (textureIds: readonly string[]): Promise<LibraryPicture[]> => {
    if (!textureIds.length || !projectService.getStatus().projectId) return [];
    const wanted = new Set(textureIds);
    const read = async (assetId: unknown): Promise<Blob | undefined> => {
        if (typeof assetId !== 'string' || !assetId) return undefined;
        const response = await projectService.fetchAsset(assetId);
        return response.ok ? response.blob() : undefined;
    };
    const pictures: LibraryPicture[] = [];
    for (const record of nativeDomainRecords(await projectService.getSnapshotAll('textures'), 'textures')) {
        if (!wanted.has(record.id)) continue;
        const file = await read(record.assetId);
        if (!file) continue;
        const settings = normalizeTextureSettings(record.settings);
        const preview = settings?.preview ? await read(settings.preview.assetId) : undefined;
        let width = Number(record.dimensions?.width) || 0;
        let height = Number(record.dimensions?.height) || 0;
        if (!width || !height) {
            // A record without its size: the picture says it (one the browser cannot read is left out).
            const bitmap = await createImageBitmap(preview ?? file).catch(() => null);
            if (!bitmap) continue;
            width = bitmap.width;
            height = bitmap.height;
            bitmap.close();
        }
        const kept = portableSettings(settings);
        pictures.push({
            id: record.id,
            name: typeof record.name === 'string' && record.name ? record.name.slice(0, 256) : 'Picture',
            file,
            dimensions: { width, height },
            ...(kept ? { settings: kept } : {}),
            ...(preview ? { preview } : {}),
        });
    }
    return pictures;
};
