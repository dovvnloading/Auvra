/// <reference path="./utif.d.ts" />
import * as THREE from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import UTIF from 'three/examples/jsm/libs/utif.module.js';
import { readPng16 } from './png';

/**
 * TEXTURE DECODING
 *
 * Pictures imported as textures, read without the browser's 8-bit decoder so they keep their depth:
 * PNG at 8 or 16 bits, TIFF at 8, 16 or 32 (float) bits, OpenEXR and Radiance HDR (floating point),
 * TGA, and PSD (its flattened, merged picture, at 8, 16 or 32 bits). Every decoder gives the same thing:
 * four floats a pixel (red, green, blue, alpha), rows from the top, values 0..1 for whole-number pictures
 * and as stored for floating-point ones. JPEG and WebP, which are only ever 8-bit, go through the browser.
 * Runs in a worker (texturePipeline.worker.ts) as well as here.
 */

export type PictureFormat = 'png' | 'jpeg' | 'webp' | 'tiff' | 'exr' | 'hdr' | 'tga' | 'psd';

export interface DecodedPicture {
    width: number;
    height: number;
    /** Bits a channel the file holds. */
    depth: 8 | 16 | 32;
    /** Channels the file holds: 1 grey, 2 grey and alpha, 3 colour, 4 colour and alpha. */
    channels: 1 | 2 | 3 | 4;
    /** Floating point, with light beyond 1 (EXR, HDR, float TIFF and PSD). */
    hdr: boolean;
    /** Red, green, blue and alpha for each pixel, rows from the top. */
    rgba: Float32Array;
}

/** File name endings imported as textures, for the file picker. */
export const TEXTURE_FILE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.exr', '.hdr', '.tga', '.psd'] as const;
export const TEXTURE_FILE_ACCEPT = ['image/png', 'image/jpeg', 'image/webp', ...TEXTURE_FILE_EXTENSIONS].join(',');

const extensionOf = (name: string): string => name.toLowerCase().slice(name.lastIndexOf('.'));

/** What kind of picture the bytes are, by their signature (TGA, which has none, by its name). */
export const sniffPictureFormat = (bytes: Uint8Array, name = ''): PictureFormat | null => {
    const starts = (...signature: number[]) => signature.every((value, at) => bytes[at] === value);
    if (starts(0x89, 0x50, 0x4e, 0x47)) return 'png';
    if (starts(0xff, 0xd8, 0xff)) return 'jpeg';
    if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
    if (starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a)) return 'tiff';
    if (starts(0x76, 0x2f, 0x31, 0x01)) return 'exr';
    if (starts(0x38, 0x42, 0x50, 0x53)) return 'psd';
    if (starts(0x23, 0x3f)) return 'hdr';
    return extensionOf(name) === '.tga' ? 'tga' : null;
};

/** Whether the browser's own decoder reads a picture of this kind without losing anything. */
export const browserReadsWholly = (format: PictureFormat, depth: number): boolean =>
    format === 'jpeg' || format === 'webp' || (format === 'png' && depth <= 8);

/** A PNG's bits a channel, from its header (0 when it is not a PNG). */
export const pngDepthOf = (bytes: Uint8Array): number => (sniffPictureFormat(bytes) === 'png' && bytes.length > 24 ? bytes[24] : 0);

const asBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** Rows turned over, for decoders that give them from the bottom. */
const flipRows = (rgba: Float32Array, width: number, height: number): Float32Array => {
    const row = width * 4;
    const out = new Float32Array(rgba.length);
    for (let y = 0; y < height; y++) out.set(rgba.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    return out;
};

/** Four channels from one, two, three or four a pixel. */
const toRgba = (source: ArrayLike<number>, width: number, height: number, channels: number, scale = 1): Float32Array => {
    const out = new Float32Array(width * height * 4);
    for (let pixel = 0, at = 0; pixel < width * height; pixel++, at += channels) {
        const o = pixel * 4;
        if (channels <= 2) {
            const v = source[at] * scale;
            out[o] = v; out[o + 1] = v; out[o + 2] = v;
            out[o + 3] = channels === 2 ? source[at + 1] * scale : 1;
        } else {
            out[o] = source[at] * scale; out[o + 1] = source[at + 1] * scale; out[o + 2] = source[at + 2] * scale;
            out[o + 3] = channels === 4 ? source[at + 3] * scale : 1;
        }
    }
    return out;
};

// --- PNG -----------------------------------------------------------------------------------------

const decodePng = async (bytes: Uint8Array): Promise<DecodedPicture> => {
    const depth = pngDepthOf(bytes);
    const colourType = bytes[25];
    const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, 1 | 2 | 3 | 4>)[colourType];
    const { width, height, data } = await readPng16(new Blob([asBuffer(bytes)]));
    return { width, height, depth: depth === 16 ? 16 : 8, channels: channels ?? 4, hdr: false, rgba: data };
};

// --- TIFF ----------------------------------------------------------------------------------------

interface TiffImage { width: number; height: number; data: Uint8Array; t258?: number[]; t277?: number[]; t262?: number[]; t339?: number[]; t284?: number[] }

const decodeTiff = (bytes: Uint8Array): DecodedPicture => {
    const buffer = asBuffer(bytes);
    const ifds = UTIF.decode(buffer) as TiffImage[];
    const image = ifds[0];
    if (!image) throw new Error('This TIFF file holds no picture.');
    UTIF.decodeImage(buffer, image);
    const bits = image.t258?.[0] ?? 8;
    const samples = image.t277?.[0] ?? (image.t258?.length ?? 1);
    const photometric = image.t262?.[0] ?? 2;
    const float = image.t339?.[0] === 3;
    const planar = image.t284?.[0] === 2;
    const plain = !planar && (photometric === 1 || photometric === 2) && samples >= 1 && samples <= 4 && (bits === 8 || bits === 16 || (bits === 32 && float));
    if (!plain) {
        // Palettes, CMYK and the like: whatever UTIF makes of them, at 8 bits.
        const rgba8 = UTIF.toRGBA8(image) as Uint8Array;
        return { width: image.width, height: image.height, depth: 8, channels: 4, hdr: false, rgba: toRgba(rgba8, image.width, image.height, 4, 1 / 255) };
    }
    const little = bytes[0] === 0x49;
    const view = new DataView(image.data.buffer, image.data.byteOffset, image.data.byteLength);
    const count = image.width * image.height * samples;
    const values = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        if (bits === 8) values[i] = image.data[i] / 255;
        else if (bits === 16) values[i] = view.getUint16(i * 2, little) / 65535;
        else values[i] = view.getFloat32(i * 4, little);
    }
    return {
        width: image.width, height: image.height, depth: bits as 8 | 16 | 32, channels: samples as 1 | 2 | 3 | 4,
        hdr: float, rgba: toRgba(values, image.width, image.height, samples),
    };
};

// --- PSD -----------------------------------------------------------------------------------------

/** Unpacks one PackBits run-length row of `length` bytes from `source` at `at`, into `out` at `to`. */
const unpackBits = (source: Uint8Array, at: number, end: number, out: Uint8Array, to: number, length: number): void => {
    let written = 0;
    while (at < end && written < length) {
        const header = (source[at++] << 24) >> 24;
        if (header >= 0) {
            const run = Math.min(header + 1, length - written);
            out.set(source.subarray(at, at + run), to + written);
            at += header + 1;
            written += run;
        } else if (header !== -128) {
            const run = Math.min(1 - header, length - written);
            out.fill(source[at++], to + written, to + written + run);
            written += run;
        }
    }
};

/**
 * A PSD's flattened picture: the merged image Photoshop keeps after the layers (saved with "Maximize
 * compatibility"), RGB or greyscale, raw or run-length packed, at 8, 16 or 32 bits.
 */
export const decodePsd = (bytes: Uint8Array): DecodedPicture => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint16(4);
    const planes = view.getUint16(12);
    const height = view.getUint32(14);
    const width = view.getUint32(18);
    const depth = view.getUint16(22);
    const mode = view.getUint16(24);
    if (mode !== 3 && mode !== 1) throw new Error('This PSD file is not RGB or greyscale: save it as RGB to import it.');
    if (depth !== 8 && depth !== 16 && depth !== 32) throw new Error('This PSD file has a bit depth that is not read here.');
    const wide = version === 2;
    let at = 26;
    at += 4 + view.getUint32(at);
    at += 4 + view.getUint32(at);
    at += (wide ? 8 : 4) + (wide ? Number(view.getBigUint64(at)) : view.getUint32(at));
    const compression = view.getUint16(at);
    at += 2;
    const size = depth / 8;
    const rowBytes = width * size;
    const planeBytes = rowBytes * height;
    const colour = mode === 3 ? 3 : 1;
    const kept = Math.min(planes, colour + 1);
    const data = new Uint8Array(kept * planeBytes);
    if (compression === 0) {
        for (let plane = 0; plane < kept; plane++) data.set(bytes.subarray(at + plane * planeBytes, at + (plane + 1) * planeBytes), plane * planeBytes);
    } else if (compression === 1) {
        // A table of each row's packed length, every plane's rows in turn, then the rows themselves.
        const counts = planes * height;
        const countBytes = wide ? 4 : 2;
        let rowAt = at + counts * countBytes;
        for (let row = 0; row < counts; row++) {
            const length = wide ? view.getUint32(at + row * 4) : view.getUint16(at + row * 2);
            const plane = Math.floor(row / height);
            if (plane < kept) unpackBits(bytes, rowAt, rowAt + length, data, plane * planeBytes + (row % height) * rowBytes, rowBytes);
            rowAt += length;
        }
    } else {
        throw new Error('This PSD file is packed in a way not read here (ZIP): save it with Maximize compatibility.');
    }
    const samples = new DataView(data.buffer);
    const read = (plane: number, pixel: number): number => {
        const offset = plane * planeBytes + pixel * size;
        if (size === 1) return data[offset] / 255;
        if (size === 2) return samples.getUint16(offset) / 65535;
        return samples.getFloat32(offset);
    };
    const rgba = new Float32Array(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel++) {
        const o = pixel * 4;
        const first = read(0, pixel);
        rgba[o] = first;
        rgba[o + 1] = colour === 3 ? read(1, pixel) : first;
        rgba[o + 2] = colour === 3 ? read(2, pixel) : first;
        rgba[o + 3] = kept > colour ? read(colour, pixel) : 1;
    }
    return { width, height, depth: depth as 8 | 16 | 32, channels: (kept > colour ? colour + 1 : colour) as 1 | 2 | 3 | 4, hdr: depth === 32, rgba };
};

// --- EXR, HDR and TGA (three's loaders, which need no page) -------------------------------------

const decodeExr = (bytes: Uint8Array): DecodedPicture => {
    const loader = new EXRLoader();
    loader.setDataType(THREE.FloatType);
    const result = loader.parse(asBuffer(bytes)) as unknown as { width: number; height: number; data: Float32Array };
    const channels = result.data.length === result.width * result.height ? 1 : 4;
    // three's EXR rows come from the bottom.
    const rgba = flipRows(toRgba(result.data, result.width, result.height, channels), result.width, result.height);
    return { width: result.width, height: result.height, depth: 32, channels: channels === 1 ? 1 : 4, hdr: true, rgba };
};

const decodeHdr = (bytes: Uint8Array): DecodedPicture => {
    const loader = new RGBELoader();
    loader.setDataType(THREE.FloatType);
    const result = loader.parse(asBuffer(bytes)) as unknown as { width: number; height: number; data: Float32Array };
    return { width: result.width, height: result.height, depth: 32, channels: 3, hdr: true, rgba: toRgba(result.data, result.width, result.height, 4) };
};

const decodeTga = (bytes: Uint8Array): DecodedPicture => {
    const result = new TGALoader().parse(asBuffer(bytes)) as unknown as { width: number; height: number; data: Uint8Array };
    return { width: result.width, height: result.height, depth: 8, channels: 4, hdr: false, rgba: toRgba(result.data, result.width, result.height, 4, 1 / 255) };
};

/** An 8-bit picture the browser reads (JPEG, WebP, or what else fails here), in a worker or a page. */
const decodeWithBrowser = async (bytes: Uint8Array): Promise<DecodedPicture> => {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') throw new Error('This picture can only be read where a browser is.');
    const bitmap = await createImageBitmap(new Blob([asBuffer(bytes)]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    bitmap.close();
    return { width: canvas.width, height: canvas.height, depth: 8, channels: 4, hdr: false, rgba: toRgba(pixels, canvas.width, canvas.height, 4, 1 / 255) };
};

/** Decodes a picture file, keeping its depth. Throws, in plain words, on what it cannot read. */
export const decodePicture = async (bytes: Uint8Array, name = ''): Promise<DecodedPicture> => {
    const format = sniffPictureFormat(bytes, name);
    switch (format) {
        case 'png': {
            // Palette and interlaced PNGs are 8-bit pictures the browser reads.
            const interlaced = bytes[28] === 1;
            return bytes[25] === 3 || interlaced ? decodeWithBrowser(bytes) : decodePng(bytes);
        }
        case 'tiff': return decodeTiff(bytes);
        case 'psd': return decodePsd(bytes);
        case 'exr': return decodeExr(bytes);
        case 'hdr': return decodeHdr(bytes);
        case 'tga': return decodeTga(bytes);
        case 'jpeg':
        case 'webp': return decodeWithBrowser(bytes);
        default: throw new Error('This file is not a picture that can be imported as a texture.');
    }
};

// --- What is made from a decoded picture --------------------------------------------------------

/** Each channel as a byte, for an 8-bit preview: floating-point light tone-mapped so its bright parts show. */
export const pictureToRgba8 = (picture: DecodedPicture): Uint8Array => {
    const out = new Uint8Array(picture.width * picture.height * 4);
    const { rgba, hdr } = picture;
    for (let i = 0; i < rgba.length; i++) {
        let value = rgba[i];
        if (hdr && i % 4 !== 3) value = Math.pow(value / (1 + value), 1 / 2.2);
        out[i] = Math.round(Math.min(1, Math.max(0, value)) * 255);
    }
    return out;
};

/** Each channel as a half float (the GPU's 16-bit floats), keeping a deep picture's depth. */
export const pictureToHalf = (picture: DecodedPicture): Uint16Array => {
    const out = new Uint16Array(picture.rgba.length);
    for (let i = 0; i < out.length; i++) out[i] = THREE.DataUtils.toHalfFloat(picture.rgba[i]);
    return out;
};

/** The picture scaled down (by halves, averaging) until neither side is over `limit`; the same picture within it. */
export const limitPictureSize = (picture: DecodedPicture, limit: number | undefined): DecodedPicture => {
    let current = picture;
    while (limit && limit > 0 && (current.width > limit || current.height > limit) && current.width > 1 && current.height > 1) {
        const width = Math.max(1, current.width >> 1);
        const height = Math.max(1, current.height >> 1);
        const rgba = new Float32Array(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                for (let c = 0; c < 4; c++) {
                    let sum = 0;
                    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
                        const sx = Math.min(current.width - 1, x * 2 + dx);
                        const sy = Math.min(current.height - 1, y * 2 + dy);
                        sum += current.rgba[(sy * current.width + sx) * 4 + c];
                    }
                    rgba[(y * width + x) * 4 + c] = sum / 4;
                }
            }
        }
        current = { ...current, width, height, rgba };
    }
    return current;
};
