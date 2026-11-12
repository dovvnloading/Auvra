/// <reference path="./utif.d.ts" />
import * as THREE from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import UTIF from 'three/examples/jsm/libs/utif.module.js';
import { readPng16, checkedTexturePixels, MAX_TEXTURE_IMPORT_DECODED_BYTES, MAX_TEXTURE_IMPORT_SOURCE_BYTES } from './png';

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
    /**
     * Holds light beyond white: a Radiance HDR file, or a floating-point picture with values above 1 or
     * below 0. Floating-point pictures that stay within 0 to 1, as most EXR normal, roughness and height
     * maps do, are not: they are compressed like any other map.
     */
    hdr: boolean;
    /** Red, green, blue and alpha for each pixel, rows from the top. */
    rgba: Float32Array;
}

/** File name endings imported as textures, for the file picker. */
export const TEXTURE_FILE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.exr', '.hdr', '.tga', '.psd'] as const;
export const TEXTURE_FILE_ACCEPT = ['image/png', 'image/jpeg', 'image/webp', ...TEXTURE_FILE_EXTENSIONS].join(',');

/** How far past white or below black a map may stray and still not hold light (normal maps often overshoot a little). */
const BEYOND_WHITE_SLACK = 0.05;

/** Whether any colour value lies beyond white or below black (alpha aside), past a little slack. */
export const holdsLightBeyondWhite = (rgba: Float32Array): boolean => {
    for (let i = 0; i < rgba.length; i++) {
        if (i % 4 === 3) continue;
        const value = rgba[i];
        if (value > 1 + BEYOND_WHITE_SLACK || value < -BEYOND_WHITE_SLACK) return true;
    }
    return false;
};

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
    // The PNG reader reports effective channels: a tRNS key supplies alpha
    // even when the source has only grey or RGB colour samples.
    const { width, height, channels, data } = await readPng16(new Blob([asBuffer(bytes)]));
    return { width, height, depth: depth === 16 ? 16 : 8, channels, hdr: false, rgba: data };
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
    const rgba = toRgba(values, image.width, image.height, samples);
    return {
        width: image.width, height: image.height, depth: bits as 8 | 16 | 32, channels: samples as 1 | 2 | 3 | 4,
        hdr: float && holdsLightBeyondWhite(rgba), rgba,
    };
};

// --- PSD -----------------------------------------------------------------------------------------

/** Read a PackBits row without accepting short or overflowing runs. */
const unpackBits = (source: Uint8Array, at: number, end: number, out: Uint8Array, to: number, length: number): void => {
    let written = 0;
    while (at < end && written < length) {
        const header = (source[at++] << 24) >> 24;
        if (header >= 0) {
            const run = header + 1;
            if (run > length - written || run > end - at) throw new Error('The PSD has a damaged packed row.');
            out.set(source.subarray(at, at + run), to + written);
            at += run;
            written += run;
        } else if (header !== -128) {
            const run = 1 - header;
            if (run > length - written || at >= end) throw new Error('The PSD has a damaged packed row.');
            out.fill(source[at++], to + written, to + written + run);
            written += run;
        }
    }
    // A trailing -128 is a legal PackBits no-op; other surplus or missing
    // payload is an invalid row rather than implicit transparent pixels.
    while (at < end && source[at] === 0x80) at++;
    if (written !== length || at !== end) throw new Error('The PSD has a truncated or excessive packed row.');
};

/**
 * A PSD's flattened picture: the merged image Photoshop keeps after the layers (saved with "Maximize
 * compatibility"), RGB or greyscale, raw or run-length packed, at 8, 16 or 32 bits.
 */
export const decodePsd = (bytes: Uint8Array): DecodedPicture => {
    if (bytes.byteLength > MAX_TEXTURE_IMPORT_SOURCE_BYTES) throw new Error('PSD exceeds the texture import file budget.');
    if (bytes.byteLength < 40 || bytes[0] !== 0x38 || bytes[1] !== 0x42
        || bytes[2] !== 0x50 || bytes[3] !== 0x53) {
        throw new Error('The PSD header is malformed.');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint16(4);
    if (version !== 1 && version !== 2) throw new Error('The PSD version is unsupported.');
    const planes = view.getUint16(12);
    const height = view.getUint32(14);
    const width = view.getUint32(18);
    const depth = view.getUint16(22);
    const mode = view.getUint16(24);
    if (mode !== 3 && mode !== 1) throw new Error('This PSD file is not RGB or greyscale: save it as RGB to import it.');
    if (depth !== 8 && depth !== 16 && depth !== 32) throw new Error('This PSD file has a bit depth that is not read here.');
    const colour = mode === 3 ? 3 : 1;
    if (planes < colour || planes > 16) throw new Error('The PSD has an unsupported channel count.');
    const pixels = checkedTexturePixels(width, height);
    const wide = version === 2;
    const size = depth / 8;
    const rowBytes = width * size;
    const planeBytes = rowBytes * height;
    const kept = Math.min(planes, colour + 1);
    if (planes * planeBytes > MAX_TEXTURE_IMPORT_DECODED_BYTES) {
        throw new Error('PSD planes exceed the texture import decompression budget.');
    }

    let at = 26;
    const skipSection = (lengthBytes: 4 | 8): void => {
        if (at + lengthBytes > bytes.byteLength) throw new Error('The PSD has truncated metadata.');
        const length = lengthBytes === 8 ? Number(view.getBigUint64(at)) : view.getUint32(at);
        if (!Number.isSafeInteger(length) || length > bytes.byteLength - at - lengthBytes) {
            throw new Error('The PSD has a damaged section length.');
        }
        at += lengthBytes + length;
    };
    skipSection(4); // Colour mode data
    skipSection(4); // Image resources
    skipSection(wide ? 8 : 4); // Layer/mask info
    if (at + 2 > bytes.byteLength) throw new Error('The PSD is missing its flattened image.');
    const compression = view.getUint16(at);
    at += 2;

    const data = new Uint8Array(kept * planeBytes);
    if (compression === 0) {
        if (planes * planeBytes > bytes.byteLength - at) throw new Error('The PSD has truncated raw image data.');
        for (let plane = 0; plane < kept; plane++) {
            data.set(bytes.subarray(at + plane * planeBytes, at + (plane + 1) * planeBytes), plane * planeBytes);
        }
    } else if (compression === 1) {
        // Validate the complete lengths table and all row boundaries before
        // decoding. A malformed PackBits run must never silently fill a row.
        const counts = planes * height;
        const countBytes = wide ? 4 : 2;
        if (counts > Math.floor((bytes.byteLength - at) / countBytes)) {
            throw new Error('The PSD has a truncated packed-row table.');
        }
        let rowAt = at + counts * countBytes;
        for (let index = 0; index < counts; index++) {
            const length = wide ? view.getUint32(at + index * 4) : view.getUint16(at + index * 2);
            if (length > bytes.byteLength - rowAt) throw new Error('The PSD has a truncated packed row.');
            const plane = Math.floor(index / height);
            if (plane < kept) {
                unpackBits(bytes, rowAt, rowAt + length, data,
                    plane * planeBytes + (index % height) * rowBytes, rowBytes);
            }
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
    const rgba = new Float32Array(pixels * 4);
    for (let pixel = 0; pixel < pixels; pixel++) {
        const o = pixel * 4;
        const first = read(0, pixel);
        rgba[o] = first;
        rgba[o + 1] = colour === 3 ? read(1, pixel) : first;
        rgba[o + 2] = colour === 3 ? read(2, pixel) : first;
        rgba[o + 3] = kept > colour ? read(colour, pixel) : 1;
    }
    return { width, height, depth: depth as 8 | 16 | 32, channels: (kept > colour ? colour + 1 : colour) as 1 | 2 | 3 | 4, hdr: depth === 32 && holdsLightBeyondWhite(rgba), rgba };
};

// --- EXR, HDR and TGA (three's loaders, which need no page) -------------------------------------

const decodeExr = (bytes: Uint8Array): DecodedPicture => {
    const loader = new EXRLoader();
    loader.setDataType(THREE.FloatType);
    const result = loader.parse(asBuffer(bytes)) as unknown as { width: number; height: number; data: Float32Array };
    const channels = result.data.length === result.width * result.height ? 1 : 4;
    // three's EXR rows come from the bottom.
    const rgba = flipRows(toRgba(result.data, result.width, result.height, channels), result.width, result.height);
    return { width: result.width, height: result.height, depth: 32, channels: channels === 1 ? 1 : 4, hdr: holdsLightBeyondWhite(rgba), rgba };
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
            // Even palette and interlaced PNGs, which use the browser decoder,
            // must pass the byte and pixel budgets BEFORE bitmap creation.
            if (bytes.byteLength > MAX_TEXTURE_IMPORT_SOURCE_BYTES) {
                throw new Error('PNG exceeds the texture import file budget.');
            }
            if (bytes.byteLength < 29 || bytes[12] !== 0x49 || bytes[13] !== 0x48
                || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
                throw new Error('The PNG header is malformed.');
            }
            const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            checkedTexturePixels(header.getUint32(16), header.getUint32(20));
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

/**
 * Each channel as a byte. Light beyond white is tone-mapped so its bright parts show; `linearColour`
 * (a floating-point picture read as colour, which holds light rather than sRGB values) is encoded to sRGB
 * for showing. Other pictures, normal and data maps among them, keep their values.
 */
export const pictureToRgba8 = (picture: DecodedPicture, linearColour = false): Uint8Array => {
    const out = new Uint8Array(picture.width * picture.height * 4);
    const { rgba, hdr } = picture;
    for (let i = 0; i < rgba.length; i++) {
        let value = rgba[i];
        if (hdr && i % 4 !== 3) value = Math.pow(value / (1 + value), 1 / 2.2);
        else if (linearColour && i % 4 !== 3) value = Math.pow(Math.max(0, value), 1 / 2.2);
        out[i] = Math.round(Math.min(1, Math.max(0, value)) * 255);
    }
    return out;
};

/** Each channel as a half float, optionally reversing DirectX normal-map green without quantizing or mutating the source. */
export const pictureToHalf = (picture: DecodedPicture, flipGreen = false): Uint16Array => {
    const out = new Uint16Array(picture.rgba.length);
    for (let i = 0; i < out.length; i++) {
        const value = picture.rgba[i];
        out[i] = THREE.DataUtils.toHalfFloat(flipGreen && i % 4 === 1 ? 1 - value : value);
    }
    return out;
};

/** The picture scaled down (by halves, averaging) until neither side is over `limit`; the same picture within it. */
export const limitPictureSize = (picture: DecodedPicture, limit: number | undefined): DecodedPicture => {
    let current = picture;
    while (limit && limit > 0 && (current.width > limit || current.height > limit) && (current.width > 1 || current.height > 1)) {
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
