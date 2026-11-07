import { MATERIALS_DOMAIN, materialAssetDocument, materialLibrary, type MaterialAsset } from '../../../runtime/materials/materialLibrary';
import { createMaterialGraph } from '../../../runtime/materials/materialGraph';
import { projectService } from '../../../utils/projectService';
import { guessInvertHeight, photoMaterialGraph, photoMaterialName } from '../../../texturing/paint/photoMaterial';
import { newTextureGraphStored } from '../TextureGraphWorkspace';

/** Picture files a photo material is made from. */
export const PHOTO_ACCEPT = 'image/png,image/jpeg,image/webp';

export const isPhotoFile = (file: File): boolean => /^image\/(png|jpeg|webp)$/.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name);

/** The size, across and down, a photo is looked at to guess which way its height runs. */
const LOOK_SIZE = 128;

/** A photo's brightness at a small size (for guessing which way its height runs); empty when it cannot be read. */
const brightnessOf = (bitmap: ImageBitmap): number[] => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = LOOK_SIZE;
    const context = canvas.getContext('2d');
    if (!context) return [];
    context.drawImage(bitmap, 0, 0, LOOK_SIZE, LOOK_SIZE);
    const pixels = context.getImageData(0, 0, LOOK_SIZE, LOOK_SIZE).data;
    const out: number[] = [];
    for (let i = 0; i < pixels.length; i += 4) out.push((0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]) / 255);
    return out;
};

/** Keeps a picture in the project's texture library (the texture store's store), giving its texture id. */
export type StorePicture = (blob: Blob, name: string, size: { width: number; height: number }, folder: string) => Promise<string>;

/**
 * A texture graph material made from a photo: the photo kept in the texture library (under Photos), the
 * graph built round it (photoMaterialGraph) at about the photo's own size, and the material kept in the
 * project. Gives the material.
 */
export const createPhotoMaterial = async (file: File, store: StorePicture): Promise<MaterialAsset> => {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    const invertHeight = guessInvertHeight(brightnessOf(bitmap), LOOK_SIZE);
    bitmap.close();
    const base = photoMaterialName(file.name);
    const textureId = await store(file, base, size, 'Photos');
    // The graph's size: the photo's, between 512 and 2048 across.
    const power = Math.min(11, Math.max(9, Math.round(Math.log2(Math.max(size.width, size.height)))));
    const taken = new Set(materialLibrary.list().map((asset) => asset.name));
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
    const asset: MaterialAsset = { id: crypto.randomUUID(), name, graph: createMaterialGraph(), textureGraph: newTextureGraphStored(photoMaterialGraph(textureId, power, { invertHeight })) };
    materialLibrary.upsert(asset);
    try {
        await projectService.applyChanges([{ domain: MATERIALS_DOMAIN, operation: 'upsert', id: asset.id, value: materialAssetDocument(asset) }]);
    } catch (error) {
        materialLibrary.remove(asset.id);
        throw error;
    }
    return asset;
};
