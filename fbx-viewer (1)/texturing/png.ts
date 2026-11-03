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

/** An RGBA picture, rows top first, as PNG. */
export const encodePng = async (pixels: Uint8Array | Uint8ClampedArray, width: number, height: number): Promise<Blob> => {
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header[8] = 8;
    header[9] = 6;
    const row = width * 4;
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
 * A picture's pixels as stored, not multiplied by alpha, ready to upload as a texture whose first
 * row is the first row of the file.
 */
export const readPicture = (blob: Blob): Promise<ImageBitmap> =>
    createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' });
