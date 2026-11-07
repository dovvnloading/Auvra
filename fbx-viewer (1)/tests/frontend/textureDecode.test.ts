import { describe, expect, it } from 'vitest';
import { decodePicture, holdsLightBeyondWhite, limitPictureSize, pictureToRgba8, sniffPictureFormat, browserReadsWholly } from '../../texturing/textureDecode';
import { encodePng16 } from '../../texturing/png';

// The test page's Blob cannot stream; the PNG reader and writer stream theirs (a worker's can).
if (!('stream' in Blob.prototype)) {
    Object.defineProperty(Blob.prototype, 'stream', {
        value(this: Blob) {
            const blob = this;
            return new ReadableStream({
                async start(controller) {
                    controller.enqueue(new Uint8Array(await blob.arrayBuffer()));
                    controller.close();
                },
            });
        },
    });
}

/** A little-endian 16-bit greyscale TIFF, uncompressed, one strip. */
const tiff16 = (width: number, height: number, samples: number[]): Uint8Array => {
    const tags: Array<[number, number, number, number]> = [
        [256, 3, 1, width], [257, 3, 1, height], [258, 3, 1, 16], [259, 3, 1, 1], [262, 3, 1, 1],
        [273, 4, 1, 0], [277, 3, 1, 1], [278, 3, 1, height], [279, 4, 1, samples.length * 2],
    ];
    const ifdSize = 2 + tags.length * 12 + 4;
    const dataAt = 8 + ifdSize;
    const bytes = new Uint8Array(dataAt + samples.length * 2);
    const view = new DataView(bytes.buffer);
    bytes.set([0x49, 0x49, 0x2a, 0x00]);
    view.setUint32(4, 8, true);
    view.setUint16(8, tags.length, true);
    tags.forEach(([tag, type, count, value], i) => {
        const at = 10 + i * 12;
        view.setUint16(at, tag, true);
        view.setUint16(at + 2, type, true);
        view.setUint32(at + 4, count, true);
        const written = tag === 273 ? dataAt : value;
        if (type === 3) view.setUint16(at + 8, written, true);
        else view.setUint32(at + 8, written, true);
    });
    samples.forEach((sample, i) => view.setUint16(dataAt + i * 2, sample, true));
    return bytes;
};

/** A PSD with its flattened picture: RGB, `depth` bits, raw or run-length packed. */
const psd = (width: number, height: number, depth: 8 | 16, planes: number[][], packed: boolean): Uint8Array => {
    const size = depth / 8;
    const header = new Uint8Array(26 + 4 + 4 + 4 + 2);
    const view = new DataView(header.buffer);
    header.set([0x38, 0x42, 0x50, 0x53]);
    view.setUint16(4, 1);
    view.setUint16(12, planes.length);
    view.setUint32(14, height);
    view.setUint32(18, width);
    view.setUint16(22, depth);
    view.setUint16(24, 3);
    view.setUint16(38, packed ? 1 : 0);
    const raw = planes.map((plane) => {
        const out = new Uint8Array(plane.length * size);
        const v = new DataView(out.buffer);
        plane.forEach((sample, i) => (size === 1 ? (out[i] = sample) : v.setUint16(i * 2, sample)));
        return out;
    });
    if (!packed) return new Uint8Array([...header, ...raw.flatMap(plane => [...plane])]);
    // PackBits, each row as one literal run.
    const rowBytes = width * size;
    const rows: number[][] = [];
    for (const plane of raw) for (let y = 0; y < height; y++) rows.push([rowBytes - 1, ...plane.subarray(y * rowBytes, (y + 1) * rowBytes)]);
    const counts = rows.flatMap(row => [row.length >> 8, row.length & 255]);
    return new Uint8Array([...header, ...counts, ...rows.flat()]);
};

/** A Radiance HDR picture of flat (unpacked) RGBE pixels. */
const hdr = (pixels: number[][]): Uint8Array => {
    const head = new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X ${pixels.length}\n`);
    return new Uint8Array([...head, ...pixels.flat()]);
};

describe('texture pictures', () => {
    it('are known by their signature, TGA by its name', () => {
        expect(sniffPictureFormat(tiff16(1, 1, [0]))).toBe('tiff');
        expect(sniffPictureFormat(psd(1, 1, 8, [[0], [0], [0]], false))).toBe('psd');
        expect(sniffPictureFormat(hdr([[128, 128, 128, 128]]))).toBe('hdr');
        expect(sniffPictureFormat(new Uint8Array([0, 0, 2]), 'Bricks.TGA')).toBe('tga');
        expect(sniffPictureFormat(new Uint8Array([1, 2, 3]), 'notes.txt')).toBeNull();
        expect(browserReadsWholly('png', 8)).toBe(true);
        expect(browserReadsWholly('png', 16)).toBe(false);
        expect(browserReadsWholly('exr', 32)).toBe(false);
    });

    it('keep a 16-bit PNG\'s depth', async () => {
        const blob = await encodePng16(new Uint16Array([1000, 1001, 65535, 0]), 2, 2, 1);
        const picture = await decodePicture(new Uint8Array(await blob.arrayBuffer()), 'height.png');
        expect([picture.width, picture.height, picture.depth, picture.channels]).toEqual([2, 2, 16, 1]);
        // Two values one step apart at 16 bits stay apart (at 8 bits they would be the same).
        expect(picture.rgba[0]).toBeCloseTo(1000 / 65535, 7);
        expect(picture.rgba[4]).toBeCloseTo(1001 / 65535, 7);
        expect(picture.rgba[4]).not.toBe(picture.rgba[0]);
    });

    it('keep a 16-bit TIFF\'s depth', async () => {
        const picture = await decodePicture(tiff16(2, 1, [1000, 1001]));
        expect([picture.width, picture.height, picture.depth, picture.channels, picture.hdr]).toEqual([2, 1, 16, 1, false]);
        expect(picture.rgba[0]).toBeCloseTo(1000 / 65535, 7);
        expect(picture.rgba[4]).toBeCloseTo(1001 / 65535, 7);
        expect(picture.rgba[3]).toBe(1);
    });

    it('read a PSD\'s flattened picture, raw or packed, at its depth', async () => {
        const planes = [[0, 65535], [1000, 1001], [30000, 30001]];
        for (const packed of [false, true]) {
            const picture = await decodePicture(psd(2, 1, 16, planes, packed));
            expect([picture.width, picture.height, picture.depth, picture.channels]).toEqual([2, 1, 16, 3]);
            expect(picture.rgba[1]).toBeCloseTo(1000 / 65535, 7);
            expect(picture.rgba[5]).toBeCloseTo(1001 / 65535, 7);
            expect(picture.rgba[4]).toBeCloseTo(1, 7);
        }
        const eight = await decodePicture(psd(1, 1, 8, [[255], [128], [0], [64]], true));
        expect(eight.channels).toBe(4);
        expect(eight.rgba[3]).toBeCloseTo(64 / 255, 5);
    });

    it('keep light beyond 1 in an HDR picture', async () => {
        // A mantissa of 128 at exponent 131 is about 4.
        const picture = await decodePicture(hdr([[128, 64, 32, 131], [0, 0, 0, 0]]));
        expect([picture.width, picture.height, picture.depth, picture.hdr]).toEqual([2, 1, 32, true]);
        expect(picture.rgba[0]).toBeGreaterThan(3.9);
        expect(picture.rgba[0]).toBeCloseTo(picture.rgba[1] * 2, 3);
        // Its 8-bit preview is tone-mapped rather than clipped flat.
        const preview = pictureToRgba8(picture);
        expect(preview[0]).toBeGreaterThan(preview[1]);
    });

    it('say a floating-point picture holds light beyond white only when its values do', () => {
        expect(holdsLightBeyondWhite(new Float32Array([0.5, 0.5, 1, 1, 0, 0.2, 0.9, 1]))).toBe(false);
        // A map overshooting white a little (as normal maps often do) is not light beyond it; alpha is not light.
        expect(holdsLightBeyondWhite(new Float32Array([0.5, 0.5, 1.024, 5]))).toBe(false);
        expect(holdsLightBeyondWhite(new Float32Array([0.5, 0.5, 1, 1, 1.5, 0.2, 0.9, 1]))).toBe(true);
        expect(holdsLightBeyondWhite(new Float32Array([-0.5, 0.5, 1, 1]))).toBe(true);
    });

    it('show floating-point colour in sRGB and other floating-point pictures as stored', () => {
        const picture = { width: 1, height: 1, depth: 32 as const, channels: 4 as const, hdr: false, rgba: new Float32Array([0.2, 0.5, 1, 1]) };
        expect(Array.from(pictureToRgba8(picture))).toEqual([51, 128, 255, 255]);
        const shown = pictureToRgba8(picture, true);
        expect(shown[0]).toBe(Math.round(Math.pow(0.2, 1 / 2.2) * 255));
        expect(shown[3]).toBe(255);
    });

    it('read an 8-bit TGA', async () => {
        const bytes = new Uint8Array(18 + 6);
        bytes[2] = 2;
        bytes[12] = 2;
        bytes[14] = 1;
        bytes[16] = 24;
        bytes[17] = 0x20;
        bytes.set([0, 0, 255, 255, 0, 0], 18);
        const picture = await decodePicture(bytes, 'pixel.tga');
        expect([picture.width, picture.height, picture.depth]).toEqual([2, 1, 8]);
        expect(Array.from(pictureToRgba8(picture).slice(0, 8))).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
    });

    it('say plainly what they cannot read', async () => {
        await expect(decodePicture(new Uint8Array([1, 2, 3, 4]), 'notes.txt')).rejects.toThrow('not a picture');
    });

    it('are scaled down by halves to their size limit', async () => {
        const picture = await decodePicture(tiff16(8, 4, Array.from({ length: 32 }, (_, i) => i * 1000)));
        const limited = limitPictureSize(picture, 2);
        expect([limited.width, limited.height]).toEqual([2, 1]);
        expect(limitPictureSize(picture, undefined)).toBe(picture);
    });
});
