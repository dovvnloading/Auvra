import { MATERIALS_DOMAIN, materialAssetDocument, materialLibrary, type MaterialAsset } from '../../../runtime/materials/materialLibrary';
import { createMaterialGraph } from '../../../runtime/materials/materialGraph';
import { projectService } from '../../../utils/projectService';
import { photoMaterialGraph, photoMaterialName } from '../../../texturing/paint/photoMaterial';
import { newTextureGraphStored } from '../TextureGraphWorkspace';

/** Picture files a photo material is made from. */
export const PHOTO_ACCEPT = 'image/png,image/jpeg,image/webp';

export const isPhotoFile = (file: File): boolean => /^image\/(png|jpeg|webp)$/.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name);

/** Keeps a picture in the project's texture library (the texture store's \`store\`), giving its texture id. */
export type StorePicture = (blob: Blob, name: string, size: { width: number; height: number }, folder: string) => Promise<string>;

/**
 * A texture graph material made from a photo: the photo kept in the texture library (under Photos), the
 * graph built round it (photoMaterialGraph) at about the photo's own size, and the material kept in the
 * project. Gives the material.
 */
export const createPhotoMaterial = async (file: File, store: StorePicture): Promise<MaterialAsset> => {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    const base = photoMaterialName(file.name);
    const textureId = await store(file, base, size, 'Photos');
    // The graph's size: the photo's, between 512 and 2048 across.
    const power = Math.min(11, Math.max(9, Math.round(Math.log2(Math.max(size.width, size.height)))));
    const taken = new Set(materialLibrary.list().map((asset) => asset.name));
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
    const asset: MaterialAsset = { id: crypto.randomUUID(), name, graph: createMaterialGraph(), textureGraph: newTextureGraphStored(photoMaterialGraph(textureId, power)) };
    materialLibrary.upsert(asset);
    try {
        await projectService.applyChanges([{ domain: MATERIALS_DOMAIN, operation: 'upsert', id: asset.id, value: materialAssetDocument(asset) }]);
    } catch (error) {
        materialLibrary.remove(asset.id);
        throw error;
    }
    return asset;
};
