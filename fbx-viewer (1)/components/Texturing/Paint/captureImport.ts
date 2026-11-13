import type { MaterialAsset } from '../../../runtime/materials/materialLibrary';
import { captureMaterialGraph, captureName } from '../../../texturing/paint/captureMaterial';
import type { CaptureSet, CapturePictures } from '../../../texturing/paint/captureProtocol';
import { keepGraphMaterial, type StorePicture } from './photoImport';

export const storeCaptureMaterial = async (set: CaptureSet, pictures: CapturePictures, store: StorePicture): Promise<MaterialAsset> => {
    const { size } = set;
    const base = captureName(set.names);
    const dimensions = { width: size, height: size };
    // One at a time: each is a change to the project.
    const colourId = await store(pictures.colour, `${base} colour`, dimensions, 'Photos');
    const normalId = await store(pictures.normal, `${base} normal`, dimensions, 'Photos');
    const heightId = await store(pictures.height, `${base} height`, dimensions, 'Photos');
    // The graph at the maps' size, at least 512 across.
    const power = Math.max(9, Math.round(Math.log2(size)));
    return keepGraphMaterial(base, captureMaterialGraph({ colour: colourId, normal: normalId, height: heightId }, power));
};
