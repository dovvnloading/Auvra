import type { MaterialAsset } from '../../../runtime/materials/materialLibrary';
import { encodePng, encodePng16 } from '../../../texturing/png';
import { captureMaps, captureMaterialGraph, captureName } from '../../../texturing/paint/captureMaterial';
import { estimateLightAzimuths, lightDirection, linearBrightness, type CapturePhoto, type LightEstimate } from '../../../texturing/paint/photometricStereo';
import { isPhotoFile, keepGraphMaterial, type StorePicture } from './photoImport';

/** How many photos a capture takes. */
export const CAPTURE_FEWEST = 3;
export const CAPTURE_MOST = 8;
/** The largest side a capture is worked out at. */
const LARGEST = 1024;
const THUMBNAIL = 112;

/** Photos of one surface lit from several sides, read for working out its material. */
export interface CaptureSet {
    names: string[];
    /** The side, in pixels, they are worked out at (a power of two): the middle square of each photo. */
    size: number;
    photos: CapturePhoto[];
    /** A small picture of each, as a data URL. */
    thumbnails: string[];
    /** The lights as the photos suggest them. */
    estimate: LightEstimate;
    /** False when the photos are not all one size (likely not taken from one spot). */
    sameSize: boolean;
}

/** The middle square of a picture drawn `side` across onto a canvas. */
const squareOf = (bitmap: ImageBitmap, side: number): CanvasRenderingContext2D => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = side;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('The photos could not be read.');
    const square = Math.min(bitmap.width, bitmap.height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, (bitmap.width - square) / 2, (bitmap.height - square) / 2, square, square, 0, 0, side, side);
    return context;
};

/** Reads three to eight photos for a capture and works out where their lights were. */
export const readCaptureSet = async (files: readonly File[]): Promise<CaptureSet> => {
    const chosen = files.filter(isPhotoFile);
    if (chosen.length < CAPTURE_FEWEST || chosen.length > CAPTURE_MOST) throw new Error(`Choose ${CAPTURE_FEWEST} to ${CAPTURE_MOST} photos of the same surface, each lit from a different side.`);
    const bitmaps = await Promise.all(chosen.map((file) => createImageBitmap(file)));
    try {
        const shortest = Math.min(...bitmaps.map((bitmap) => Math.min(bitmap.width, bitmap.height)));
        const size = Math.max(64, Math.min(LARGEST, 2 ** Math.floor(Math.log2(shortest))));
        const sameSize = bitmaps.every((bitmap) => bitmap.width === bitmaps[0].width && bitmap.height === bitmaps[0].height);
        const photos = bitmaps.map((bitmap): CapturePhoto => {
            const pixels = squareOf(bitmap, size).getImageData(0, 0, size, size).data;
            const rgb = new Float32Array(size * size * 3);
            for (let i = 0; i < size * size; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = pixels[i * 4 + c] / 255;
            return { rgb };
        });
        const thumbnails = bitmaps.map((bitmap) => squareOf(bitmap, THUMBNAIL).canvas.toDataURL('image/jpeg', 0.8));
        const estimate = estimateLightAzimuths(photos.map(linearBrightness), size, size);
        return { names: chosen.map((file) => file.name), size, photos, thumbnails, estimate, sameSize };
    } finally {
        for (const bitmap of bitmaps) bitmap.close();
    }
};

/**
 * A material from a capture: its colour, normal and height worked out with the lights given (azimuths
 * and one elevation, in radians), made to tile, kept in the texture library (under Photos), and a
 * texture graph built round them.
 */
export const createCaptureMaterial = async (set: CaptureSet, azimuths: readonly number[], elevation: number, store: StorePicture): Promise<MaterialAsset> => {
    const { size } = set;
    const maps = captureMaps(set.photos, azimuths.map((azimuth) => lightDirection(azimuth, elevation)), size, size);
    const colour = new Uint8ClampedArray(size * size * 4);
    const normal = new Uint8ClampedArray(size * size * 4);
    const height = new Uint16Array(size * size);
    for (let i = 0; i < size * size; i++) {
        for (let c = 0; c < 3; c++) {
            colour[i * 4 + c] = Math.round(maps.albedo[i * 3 + c] * 255);
            normal[i * 4 + c] = Math.round((maps.normal[i * 3 + c] * 0.5 + 0.5) * 255);
        }
        colour[i * 4 + 3] = normal[i * 4 + 3] = 255;
        height[i] = Math.round(maps.heightMap[i] * 65535);
    }
    const base = captureName(set.names);
    const dimensions = { width: size, height: size };
    // One at a time: each is a change to the project.
    const colourId = await store(await encodePng(colour, size, size), `${base} colour`, dimensions, 'Photos');
    const normalId = await store(await encodePng(normal, size, size), `${base} normal`, dimensions, 'Photos');
    const heightId = await store(await encodePng16(height, size, size, 1), `${base} height`, dimensions, 'Photos');
    // The graph at the maps' size, at least 512 across.
    const power = Math.max(9, Math.round(Math.log2(size)));
    return keepGraphMaterial(base, captureMaterialGraph({ colour: colourId, normal: normalId, height: heightId }, power));
};
