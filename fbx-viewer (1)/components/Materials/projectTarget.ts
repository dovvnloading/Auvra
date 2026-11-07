import { useCallback } from 'react';
import { useAssets } from '../../context/AssetContext';
import { useScene } from '../../context/SceneContext';
import { MATERIALS_DOMAIN, materialAssetDocument, materialLibrary } from '../../runtime/materials/materialLibrary';
import { setTextureSettings, setTextureSourceAsset } from '../../texturing/textureSettings';
import type { TextureData } from '../../types';
import { projectService } from '../../utils/projectService';
import type { LibraryPicture } from '../../utils/userMaterialLibrary';
import type { ProjectTarget } from '../../utils/userMaterialLibraryActions';

/**
 * The open project as a place materials are brought into, from My library or a material package: each picture
 * becomes one of its textures, and each material is saved among its materials.
 */

/** Adds a picture from the library to the open project as its own texture, in `folder`; returns its id there. */
const useAddPicture = () => {
    const { setTextures } = useAssets();
    const addToList = setTextures as unknown as (update: (previous: TextureData[]) => TextureData[]) => void;
    return useCallback(async (picture: LibraryPicture, folder: string): Promise<string> => {
        const id = crypto.randomUUID();
        const assetId = await projectService.uploadAsset(new File([picture.file], picture.name, { type: picture.file.type }));
        const previewAssetId = picture.preview ? await projectService.uploadAsset(new File([picture.preview], `${picture.name} preview.png`, { type: 'image/png' })) : null;
        const settings = previewAssetId ? { ...(picture.settings ?? {}), preview: { assetId: previewAssetId } } : picture.settings;
        const name = picture.name.slice(0, 256);
        await projectService.applyChanges([{ domain: 'textures', operation: 'upsert', id, value: { id, name, assetId, dimensions: picture.dimensions, folder, ...(settings ? { settings } : {}) } }]);
        setTextureSettings(id, settings);
        setTextureSourceAsset(id, assetId);
        // A deep picture is shown by its preview and drawn by its own file.
        const url = URL.createObjectURL(picture.preview ?? picture.file);
        const sourceUrl = picture.preview ? URL.createObjectURL(picture.file) : undefined;
        materialLibrary.addTextureUrl(id, sourceUrl ?? url);
        addToList((previous) => [...previous, { id, name, url, dimensions: picture.dimensions, folder, ...(settings ? { settings } : {}), ...(sourceUrl ? { sourceUrl } : {}) }]);
        return id;
    }, [addToList]);
};

/** The open project as a place materials are brought into (their pictures as its textures); null when none is open. */
export const useProjectTarget = () => {
    const addPicture = useAddPicture();
    const { projectStatus } = useScene();
    return useCallback((): ProjectTarget | null => (projectStatus.projectId ? {
        projectId: projectStatus.projectId,
        projectName: projectStatus.name ?? '',
        materialNames: materialLibrary.list().map(material => material.name),
        addPicture,
        saveMaterial: async (material) => {
            await projectService.applyChanges([{ domain: MATERIALS_DOMAIN, operation: 'upsert', id: material.id, value: materialAssetDocument(material) }]);
            materialLibrary.upsert(material);
        },
        newId: () => crypto.randomUUID(),
        hasMaterial: (id) => materialLibrary.get(id) !== undefined,
    } : null), [addPicture, projectStatus.name, projectStatus.projectId]);
};
