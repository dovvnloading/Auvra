import { crc32 } from './zip';

/**
 * PNG pictures written and read exactly. A canvas multiplies colour by alpha before it writes a PNG,
 * which ruins the colour of faintly painted pixels; painted layers keep value and coverage apart, so
 * they are written here byte for byte, and read back without the browser touching them.
 */

const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
};

const deflate = async (data: Uint8Array): Promise<Uint8Array> => {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
};

/** An RGBA picture (or a grey one, one value per pixel, when `channels` is 1), rows top first, as PNG. */
export const encodePng = async (pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, channels: 1 | 4 = 4): Promise<Blob> => {
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header[8] = 8;
    header[9] = channels === 1 ? 0 : 6;
    const row = width * channels;
    const raw = new Uint8Array((row + 1) * height);
    for (let y = 0; y < height; y++) {
        // Filter "up" squeezes painted pictures well and costs nothing to work out.
        const at = y * (row + 1);
        raw[at] = y === 0 ? 0 : 2;
        const line = pixels.subarray(y * row, (y + 1) * row);
        if (y === 0) raw.set(line, at + 1);
        else {
            const above = pixels.subarray((y - 1) * row, y * row);
            for (let i = 0; i < row; i++) raw[at + 1 + i] = (line[i] - above[i]) & 255;
        }
    }
    const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    return new Blob([signature, chunk('IHDR', header), chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array(0))] as BlobPart[], { type: 'image/png' });
};

/**
 * A 16-bit picture as PNG: one grey value or four RGBA values per pixel, 0..65535, rows in the order
 * given. Browsers read such files at 8 bits; readPng16 reads them whole.
 */
export const encodePng16 = async (samples: Uint16Array, width: number, height: number, channels: 1 | 4): Promise<Blob> => {
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header[8] = 16;
    header[9] = channels === 1 ? 0 : 6;
    const row = width * channels * 2;
    const bytes = new Uint8Array(row * height);
    for (let i = 0; i < samples.length; i++) {
        bytes[i * 2] = samples[i] >> 8;
        bytes[i * 2 + 1] = samples[i] & 255;
    }
    const raw = new Uint8Array((row + 1) * height);
    for (let y = 0; y < height; y++) {
        const at = y * (row + 1);
        raw[at] = y === 0 ? 0 : 2;
        const line = bytes.subarray(y * row, (y + 1) * row);
        if (y === 0) raw.set(line, at + 1);
        else {
            const above = bytes.subarray((y - 1) * row, y * row);
            for (let i = 0; i < row; i++) raw[at + 1 + i] = (line[i] - above[i]) & 255;
        }
    }
    const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    return new Blob([signature, chunk('IHDR', header), chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array(0))] as BlobPart[], { type: 'image/png' });
};

/** The bits per channel a PNG file keeps (8 or 16), or 0 when it is not a PNG. */
export const pngBitDepth = async (blob: Blob): Promise<number> => {
    const head = new Uint8Array(await blob.slice(0, 26).arrayBuffer());
    if (head.length < 26 || head[0] !== 137 || head[1] !== 80 || head[2] !== 78 || head[3] !== 71) return 0;
    return head[24];
};

/** A PNG's rows, unfiltered in place: each row is a filter byte, then `row` bytes of samples. */
interface PngRows { width: number; height: number; depth: 8 | 16; channels: 1 | 2 | 3 | 4; raw: Uint8Array; row: number }

/** Reads a PNG (grey, grey and alpha, RGB or RGBA, 8 or 16 bits, not interlaced) to its rows of samples. */
const readRows = async (blob: Blob): Promise<PngRows> => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 8;
    let width = 0, height = 0, depth = 0, colourType = 0;
    const parts: Uint8Array[] = [];
    while (at + 8 <= bytes.length) {
        const length = view.getUint32(at);
        const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
        const data = bytes.subarray(at + 8, at + 8 + length);
        if (type === 'IHDR') {
            width = view.getUint32(at + 8);
            height = view.getUint32(at + 12);
            depth = data[8];
            colourType = data[9];
            if (data[12] !== 0) throw new Error('Interlaced PNG pictures are not read here.');
        } else if (type === 'IDAT') parts.push(data);
        else if (type === 'IEND') break;
        at += 12 + length;
    }
    const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as const)[colourType as 0 | 2 | 4 | 6];
    if (!channels || (depth !== 8 && depth !== 16)) throw new Error('This PNG picture is of a kind not read here.');
    const stream = new Blob(parts as BlobPart[]).stream().pipeThrough(new DecompressionStream('deflate'));
    const raw = new Uint8Array(await new Response(stream).arrayBuffer());
    const stride = depth / 8 * channels;
    const row = width * stride;
    // Unfiltered where it lies (the row above is already unfiltered when a row needs it): no second copy.
    for (let y = 0; y < height; y++) {
        const start = y * (row + 1);
        const filter = raw[start];
        const line = start + 1;
        const above = start + 1 - (row + 1);
        for (let i = 0; i < row; i++) {
            const left = i >= stride ? raw[line + i - stride] : 0;
            const up = y > 0 ? raw[above + i] : 0;
            const corner = y > 0 && i >= stride ? raw[above + i - stride] : 0;
            let value = raw[line + i];
            if (filter === 1) value += left;
            else if (filter === 2) value += up;
            else if (filter === 3) value += (left + up) >> 1;
            else if (filter === 4) {
                const p = left + up - corner;
                const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
                value += pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
            }
            raw[line + i] = value & 255;
        }
    }
    return { width, height, depth, channels, raw, row };
};

/**
 * Reads a PNG (grey, grey and alpha, RGB or RGBA, 8 or 16 bits, not interlaced) to floats 0..1, four
 * per pixel (grey repeated, alpha 1 when absent), rows in the order of the file. Four bytes a value:
 * prefer readPng16Half, which the GPU's 16-bit images take as they are.
 */
export const readPng16 = async (blob: Blob): Promise<{ width: number; height: number; data: Float32Array }> => {
    const { width, height, depth, channels, raw, row } = await readRows(blob);
    const data = new Float32Array(width * height * 4);
    const scale = depth === 16 ? 1 / 65535 : 1 / 255;
    const size = depth / 8;
    const sample = (offset: number) => (depth === 16 ? (raw[offset] << 8) | raw[offset + 1] : raw[offset]) * scale;
    for (let y = 0, o = 0; y < height; y++) {
        for (let x = 0, base = y * (row + 1) + 1; x < width; x++, base += size * channels, o += 4) {
            if (channels <= 2) {
                const v = sample(base);
                data[o] = v;
                data[o + 1] = v;
                data[o + 2] = v;
                data[o + 3] = channels === 2 ? sample(base + size) : 1;
            } else {
                data[o] = sample(base);
                data[o + 1] = sample(base + size);
                data[o + 2] = sample(base + 2 * size);
                data[o + 3] = channels === 4 ? sample(base + 3 * size) : 1;
            }
        }
    }
    return { width, height, data };
};

/** The bits of the half float nearest `value` (0..1): 10 bits of fraction, rounded, small values kept as subnormals. */
export const toHalf = (value: number): number => {
    if (!(value > 0)) return 0;
    let exponent = Math.floor(Math.log2(value));
    if (value / 2 ** exponent >= 2) exponent++;
    else if (value / 2 ** exponent < 1) exponent--;
    // Below 2^-14 halves have no implicit one: steps of 2^-24.
    if (exponent < -14) return Math.round(value * 2 ** 24);
    let fraction = Math.round((value / 2 ** exponent - 1) * 1024);
    if (fraction === 1024) { fraction = 0; exponent++; }
    return ((exponent + 15) << 10) | fraction;
};

/** Half-float bits of every 16-bit (and 8-bit) sample value, worked out once. */
let halves16: Uint16Array | null = null;
let halves8: Uint16Array | null = null;
const HALF_ONE = 0x3c00;
const halfTable = (depth: 8 | 16): Uint16Array => {
    if (depth === 16) {
        if (!halves16) { halves16 = new Uint16Array(65536); for (let i = 0; i < 65536; i++) halves16[i] = toHalf(i / 65535); }
        return halves16;
    }
    if (!halves8) { halves8 = new Uint16Array(256); for (let i = 0; i < 256; i++) halves8[i] = toHalf(i / 255); }
    return halves8;
};

/**
 * Reads a PNG (grey, grey and alpha, RGB or RGBA, 8 or 16 bits, not interlaced) to half floats 0..1,
 * as a 16-bit GPU image keeps them: the bits of each value, ready for a HalfFloatType texture. A grey
 * picture gives one value per pixel (`channels` 1, for a RedFormat texture), the rest four (grey
 * repeated, alpha 1 when absent). Rows come in the order of the file. Two bytes a value, against four
 * for readPng16: a 4K colour picture takes 128 MB instead of 256, and no full copy is made on the way.
 */
export const readPng16Half = async (blob: Blob): Promise<{ width: number; height: number; channels: 1 | 4; data: Uint16Array }> => {
    const { width, height, depth, channels, raw, row } = await readRows(blob);
    const table = halfTable(depth);
    const size = depth / 8;
    const out = channels === 1 ? 1 : 4;
    const data = new Uint16Array(width * height * out);
    const sample = depth === 16 ? (offset: number) => table[(raw[offset] << 8) | raw[offset + 1]] : (offset: number) => table[raw[offset]];
    for (let y = 0, o = 0; y < height; y++) {
        for (let x = 0, base = y * (row + 1) + 1; x < width; x++, base += size * channels, o += out) {
            if (channels === 1) data[o] = sample(base);
            else if (channels === 2) {
                const v = sample(base);
                data[o] = v;
                data[o + 1] = v;
                data[o + 2] = v;
                data[o + 3] = sample(base + size);
            } else {
                data[o] = sample(base);
                data[o + 1] = sample(base + size);
                data[o + 2] = sample(base + 2 * size);
                data[o + 3] = channels === 4 ? sample(base + 3 * size) : HALF_ONE;
            }
        }
    }
    return { width, height, channels: out, data };
};

/**
 * A picture's pixels as stored, not multiplied by alpha, ready to upload as a texture whose first
 * row is the first row of the file.
 */
export const readPicture = (blob: Blob): Promise<ImageBitmap> =>
    createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' });
