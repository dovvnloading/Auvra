import { encodePng, encodePng16 } from '../png';

/**
 * PICTURE FILES
 *
 * Writers for the file kinds pictures are downloaded as: PNG (8 or 16 bits), TGA (8 bits), TIFF (8, 16 or
 * 32-bit float, uncompressed) and OpenEXR (half or full float, uncompressed scan lines). Each takes the
 * same picture: values per pixel (one for grey, three or four for colour), rows from the top, in 0..1
 * (floats may go past 1 in the float kinds).
 */

export type PictureFormat = 'png8' | 'png16' | 'tga' | 'tiff8' | 'tiff16' | 'tiff32' | 'exr16' | 'exr32';

export const PICTURE_FORMATS: ReadonlyArray<{ value: PictureFormat; label: string; extension: string }> = [
    { value: 'png8', label: 'PNG, 8 bits', extension: 'png' },
    { value: 'png16', label: 'PNG, 16 bits', extension: 'png' },
    { value: 'tga', label: 'TGA, 8 bits', extension: 'tga' },
    { value: 'tiff8', label: 'TIFF, 8 bits', extension: 'tif' },
    { value: 'tiff16', label: 'TIFF, 16 bits', extension: 'tif' },
    { value: 'tiff32', label: 'TIFF, 32-bit float', extension: 'tif' },
    { value: 'exr16', label: 'EXR, half float', extension: 'exr' },
    { value: 'exr32', label: 'EXR, full float', extension: 'exr' },
];

export const extensionOf = (format: PictureFormat): string => PICTURE_FORMATS.find((each) => each.value === format)?.extension ?? 'png';

export interface PictureData {
    width: number;
    height: number;
    /** Values per pixel: 1 grey, 3 colour, 4 colour and alpha. */
    channels: 1 | 3 | 4;
    /** Rows from the top. */
    data: Float32Array;
}

const to8 = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 255);
const to16 = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 65535);

/** The half float nearest a value (any sign, up to 65504). */
const half = (value: number): number => {
    if (Number.isNaN(value)) return 0x7e00;
    const sign = value < 0 ? 0x8000 : 0;
    const magnitude = Math.min(65504, Math.abs(value));
    if (magnitude < 2 ** -24) return sign;
    let exponent = Math.floor(Math.log2(magnitude));
    if (exponent < -14) return sign | Math.round(magnitude * 2 ** 24);
    let fraction = Math.round((magnitude / 2 ** exponent - 1) * 1024);
    if (fraction === 1024) { fraction = 0; exponent++; }
    return sign | ((exponent + 15) << 10) | fraction;
};

/** PNG has grey or colour with alpha: colour without alpha is written with alpha full. */
const asPngPixels = <T extends Uint8Array | Uint16Array>(picture: PictureData, make: (length: number) => T, convert: (value: number) => number, full: number): { pixels: T; channels: 1 | 4 } => {
    const count = picture.width * picture.height;
    const channels = picture.channels === 1 ? 1 : 4;
    const pixels = make(count * channels);
    for (let i = 0; i < count; i++) {
        if (channels === 1) { pixels[i] = convert(picture.data[i]); continue; }
        for (let c = 0; c < 3; c++) pixels[i * 4 + c] = convert(picture.data[i * picture.channels + c]);
        pixels[i * 4 + 3] = picture.channels === 4 ? convert(picture.data[i * 4 + 3]) : full;
    }
    return { pixels, channels };
};

/** An uncompressed TGA: grey (type 3) or colour (type 2, BGR or BGRA), rows from the top. */
export const writeTga = (picture: PictureData): Uint8Array => {
    const { width, height, channels } = picture;
    const out = new Uint8Array(18 + width * height * channels);
    out[2] = channels === 1 ? 3 : 2;
    out[12] = width & 255; out[13] = width >> 8;
    out[14] = height & 255; out[15] = height >> 8;
    out[16] = channels * 8;
    // Rows from the top; the alpha bits.
    out[17] = 0x20 | (channels === 4 ? 8 : 0);
    for (let i = 0; i < width * height; i++) {
        const at = 18 + i * channels;
        if (channels === 1) { out[at] = to8(picture.data[i]); continue; }
        out[at] = to8(picture.data[i * channels + 2]);
        out[at + 1] = to8(picture.data[i * channels + 1]);
        out[at + 2] = to8(picture.data[i * channels]);
        if (channels === 4) out[at + 3] = to8(picture.data[i * 4 + 3]);
    }
    return out;
};

/** A baseline TIFF, little-endian, one uncompressed strip: 8 or 16 bits unsigned, or 32-bit float. */
export const writeTiff = (picture: PictureData, bits: 8 | 16 | 32): Uint8Array => {
    const { width, height, channels } = picture;
    const bytes = bits / 8;
    const dataSize = width * height * channels * bytes;
    const tags: Array<[number, number, number, number[]]> = []; // tag, type (3 short, 4 long), count, values
    const dataAt = 8;
    const ifdAt = dataAt + dataSize + ((dataAt + dataSize) % 2);
    tags.push([256, 4, 1, [width]], [257, 4, 1, [height]]);
    tags.push([258, 3, channels, Array(channels).fill(bits)]);
    tags.push([259, 3, 1, [1]], [262, 3, 1, [channels === 1 ? 1 : 2]], [273, 4, 1, [dataAt]], [277, 3, 1, [channels]], [278, 4, 1, [height]], [279, 4, 1, [dataSize]], [284, 3, 1, [1]]);
    if (channels === 4) tags.push([338, 3, 1, [2]]);
    tags.push([339, 3, channels, Array(channels).fill(bits === 32 ? 3 : 1)]);
    // Arrays of more than two shorts live outside the entry: placed after the directory.
    const entries = tags.length;
    let extraAt = ifdAt + 2 + entries * 12 + 4;
    const extras: Array<{ at: number; values: number[] }> = [];
    const out = new Uint8Array(extraAt + tags.reduce((sum, [, type, count]) => sum + (type === 3 && count > 2 ? count * 2 : 0), 0));
    const view = new DataView(out.buffer);
    out[0] = 0x49; out[1] = 0x49; view.setUint16(2, 42, true); view.setUint32(4, ifdAt, true);
    view.setUint16(ifdAt, entries, true);
    tags.forEach(([tag, type, count, values], i) => {
        const at = ifdAt + 2 + i * 12;
        view.setUint16(at, tag, true);
        view.setUint16(at + 2, type, true);
        view.setUint32(at + 4, count, true);
        if (type === 3 && count > 2) {
            view.setUint32(at + 8, extraAt, true);
            extras.push({ at: extraAt, values });
            extraAt += count * 2;
        } else if (type === 3) values.forEach((value, k) => view.setUint16(at + 8 + k * 2, value, true));
        else view.setUint32(at + 8, values[0], true);
    });
    view.setUint32(ifdAt + 2 + entries * 12, 0, true);
    for (const extra of extras) extra.values.forEach((value, k) => view.setUint16(extra.at + k * 2, value, true));
    for (let i = 0; i < width * height * channels; i++) {
        const value = picture.data[i];
        const at = dataAt + i * bytes;
        if (bits === 8) out[at] = to8(value);
        else if (bits === 16) view.setUint16(at, to16(value), true);
        else view.setFloat32(at, value, true);
    }
    return out;
};

/** An OpenEXR file: one part, uncompressed scan lines of half or full floats (Y for grey, else R, G, B and A). */
export const writeExr = (picture: PictureData, bits: 16 | 32): Uint8Array => {
    const { width, height, channels } = picture;
    const names = channels === 1 ? ['Y'] : channels === 3 ? ['B', 'G', 'R'] : ['A', 'B', 'G', 'R'];
    const source = (name: string) => (name === 'Y' || name === 'R' ? 0 : name === 'G' ? 1 : name === 'B' ? 2 : 3);
    const bytes = bits / 8;
    const header: number[] = [];
    const text = (value: string) => { for (const character of value) header.push(character.charCodeAt(0)); header.push(0); };
    const int32 = (value: number) => header.push(value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >>> 24) & 255);
    const float32 = (value: number) => { const v = new DataView(new ArrayBuffer(4)); v.setFloat32(0, value, true); for (let k = 0; k < 4; k++) header.push(v.getUint8(k)); };
    const attribute = (name: string, type: string, size: number, write: () => void) => { text(name); text(type); int32(size); write(); };
    attribute('channels', 'chlist', names.length * (names[0].length + 1 + 16) + 1, () => {
        for (const name of names) { text(name); int32(bits === 16 ? 1 : 2); header.push(0, 0, 0, 0); int32(1); int32(1); }
        header.push(0);
    });
    attribute('compression', 'compression', 1, () => header.push(0));
    attribute('dataWindow', 'box2i', 16, () => { int32(0); int32(0); int32(width - 1); int32(height - 1); });
    attribute('displayWindow', 'box2i', 16, () => { int32(0); int32(0); int32(width - 1); int32(height - 1); });
    attribute('lineOrder', 'lineOrder', 1, () => header.push(0));
    attribute('pixelAspectRatio', 'float', 4, () => float32(1));
    attribute('screenWindowCenter', 'v2f', 8, () => { float32(0); float32(0); });
    attribute('screenWindowWidth', 'float', 4, () => float32(1));
    header.push(0);
    const lineSize = width * names.length * bytes;
    const start = 8 + header.length + height * 8;
    const out = new Uint8Array(start + height * (8 + lineSize));
    const view = new DataView(out.buffer);
    view.setUint32(0, 20000630, true);
    view.setUint32(4, 2, true);
    out.set(header, 8);
    for (let y = 0; y < height; y++) {
        const lineAt = start + y * (8 + lineSize);
        view.setBigUint64(8 + header.length + y * 8, BigInt(lineAt), true);
        view.setInt32(lineAt, y, true);
        view.setInt32(lineAt + 4, lineSize, true);
        names.forEach((name, c) => {
            for (let x = 0; x < width; x++) {
                const value = picture.data[(y * width + x) * channels + Math.min(channels - 1, source(name))];
                const at = lineAt + 8 + (c * width + x) * bytes;
                if (bits === 16) view.setUint16(at, half(value), true);
                else view.setFloat32(at, value, true);
            }
        });
    }
    return out;
};

/** A picture written as a file of the given kind. */
export const writePicture = async (picture: PictureData, format: PictureFormat): Promise<Blob> => {
    switch (format) {
        case 'png8': { const { pixels, channels } = asPngPixels(picture, (n) => new Uint8Array(n), to8, 255); return encodePng(pixels, picture.width, picture.height, channels); }
        case 'png16': { const { pixels, channels } = asPngPixels(picture, (n) => new Uint16Array(n), to16, 65535); return encodePng16(pixels, picture.width, picture.height, channels); }
        case 'tga': return new Blob([writeTga(picture)], { type: 'image/x-tga' });
        case 'tiff8': return new Blob([writeTiff(picture, 8)], { type: 'image/tiff' });
        case 'tiff16': return new Blob([writeTiff(picture, 16)], { type: 'image/tiff' });
        case 'tiff32': return new Blob([writeTiff(picture, 32)], { type: 'image/tiff' });
        case 'exr16': return new Blob([writeExr(picture, 16)], { type: 'image/x-exr' });
        case 'exr32': return new Blob([writeExr(picture, 32)], { type: 'image/x-exr' });
    }
};
