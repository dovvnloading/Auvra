import { useCallback } from 'react';
import { useAssets } from '../../context/AssetContext';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { materialLibrary } from '../../runtime/materials/materialLibrary';
import type { TextureData } from '../../types';
import { dbOperations } from '../../utils/db';
import { projectService } from '../../utils/projectService';

/** Picture types kept as they are, and their file endings; anything else is stored as PNG. */
const STORED_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/**
 * Keeping pictures the texturing tools make in the project's texture library (in a folder of their
 * own, without a notice for each), and letting go of pictures they replaced.
 */
export const useTextureStore = () => {
    const { setTextures } = useAssets();
    const addToList = setTextures as unknown as (update: (previous: TextureData[]) => TextureData[]) => void;

    const store = useCallback(async (blob: Blob, name: string, size: { width: number; height: number }, folder: string): Promise<string> => {
        projectService.assertWritable();
        const id = crypto.randomUUID();
        // Named and typed as what the picture is: a photo may be a JPEG or WebP, which the host checks.
        const type = STORED_TYPES[blob.type] ? blob.type : 'image/png';
        const file = new File([blob], `${name.replace(/[^\w .-]+/g, '_').slice(0, 120)}.${STORED_TYPES[type]}`, { type });
        const assetId = await projectService.uploadAsset(file);
        await projectService.applyChanges([{ domain: 'textures', operation: 'upsert', id, value: { id, name: name.slice(0, 256), assetId, dimensions: size, folder } }]);
        const url = URL.createObjectURL(blob);
        materialLibrary.addTextureUrl(id, url);
        addToList((previous) => [...previous, { id, name: name.slice(0, 256), url, dimensions: size, folder }]);
        return id;
    }, [addToList]);

    const discard = useCallback(async (ids: readonly string[]): Promise<void> => {
        for (const id of ids) {
            try {
                await dbOperations.deleteTexture(id);
                materialLibrary.releaseTexture(id);
                addToList((previous) => previous.filter((texture) => {
                    if (texture.id !== id) return true;
                    URL.revokeObjectURL(texture.url);
                    return false;
                }));
            } catch (error) {
                // A picture something else still uses stays in the library.
                frontendDiagnostics.failure('texturing_old_picture_kept', error);
            }
        }
    }, [addToList]);

    return { store, discard };
};
