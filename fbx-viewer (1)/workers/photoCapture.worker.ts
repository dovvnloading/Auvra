/// <reference lib="webworker" />

import { isDedicatedWorkerMessage } from './dedicatedWorkerMessage';
import { encodePng, encodePng16 } from '../texturing/png';
import { captureMaps } from '../texturing/paint/captureMaps';
import { estimateLightAzimuths, lightDirection, linearBrightness, type CapturePhoto } from '../texturing/paint/photometricStereo';
import { CAPTURE_FEWEST, CAPTURE_MOST, type CaptureRequest, type CaptureReply } from '../texturing/paint/captureProtocol';

const LARGEST = 1024;
const THUMBNAIL = 112;

/** The middle square of a picture drawn `side` across onto a canvas. */
const squareOf = (bitmap: ImageBitmap, side: number): OffscreenCanvasRenderingContext2D => {
    const canvas = new OffscreenCanvas(side, side);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('The photos could not be read.');
    const square = Math.min(bitmap.width, bitmap.height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, (bitmap.width - square) / 2, (bitmap.height - square) / 2, square, square, 0, 0, side, side);
    return context;
};

/** Reads three to eight photos for a capture and works out where their lights were. */
const readCaptureSet = async (chosen: readonly File[]) => {
    if (chosen.length < CAPTURE_FEWEST || chosen.length > CAPTURE_MOST) throw new Error(`Choose ${CAPTURE_FEWEST} to ${CAPTURE_MOST} photos of the same surface, each lit from a different side.`);
    const bitmaps: ImageBitmap[] = [];
    try {
        for (const file of chosen) bitmaps.push(await createImageBitmap(file));
        const shortest = Math.min(...bitmaps.map((bitmap) => Math.min(bitmap.width, bitmap.height)));
        const size = Math.max(64, Math.min(LARGEST, 2 ** Math.floor(Math.log2(shortest))));
        const sameSize = bitmaps.every((bitmap) => bitmap.width === bitmaps[0].width && bitmap.height === bitmaps[0].height);
        const photos = bitmaps.map((bitmap): CapturePhoto => {
            const pixels = squareOf(bitmap, size).getImageData(0, 0, size, size).data;
            const rgb = new Float32Array(size * size * 3);
            for (let i = 0; i < size * size; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = pixels[i * 4 + c] / 255;
            return { rgb };
        });
        const thumbnails = await Promise.all(bitmaps.map(async bitmap => {
            const jpeg = await squareOf(bitmap, THUMBNAIL).canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
            return new FileReaderSync().readAsDataURL(jpeg);
        }));
        const estimate = estimateLightAzimuths(photos.map(linearBrightness), size, size);
        return { names: chosen.map((file) => file.name), size, photos, thumbnails, estimate, sameSize };
    } finally {
        for (const bitmap of bitmaps) bitmap.close();
    }
};

async function makePictures(photos: CapturePhoto[], size: number, azimuths: number[], elevation: number) {
    const maps = captureMaps(photos, azimuths.map((azimuth) => lightDirection(azimuth, elevation)), size, size);
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
    return {
        colour: await encodePng(colour, size, size),
        normal: await encodePng(normal, size, size),
        height: await encodePng16(height, size, size, 1),
    };
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
let prepared: Awaited<ReturnType<typeof readCaptureSet>> | undefined;
scope.onmessage = async (event: MessageEvent<CaptureRequest>) => {
    if (!isDedicatedWorkerMessage(event)) return;
    let reply: CaptureReply;
    try {
        if (event.data.kind === 'read') {
            prepared = await readCaptureSet(event.data.files);
            const { size, names, thumbnails, estimate, sameSize } = prepared;
            reply = { kind: 'read', set: { size, names, thumbnails, estimate, sameSize } };
        } else {
            if (!prepared) throw new Error('Read the capture photos before rendering their maps.');
            const pictures = await makePictures(prepared.photos, prepared.size, event.data.azimuths, event.data.elevation);
            reply = { kind: 'render', pictures };
        }
    } catch (error) {
        reply = { kind: 'error', message: error instanceof Error ? error.message : 'The photo capture failed.' };
    }
    scope.postMessage(reply);
};
