import { Blob as NodeBlob } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createNode, graphContentKey } from '../../texturing/graph/document';
import type { TextureGraph } from '../../texturing/graph/types';
import { DataUtils } from 'three';
import { encodePng, encodePng16, pngBitDepth, readPng16, readPng16Half, toHalf } from '../../texturing/png';
import { crc32 } from '../../texturing/zip';

// The test page's Blob cannot be read as a stream; Node's can, as a browser's can.
globalThis.Blob = NodeBlob as unknown as typeof Blob;

/** A PNG chunk, as the format lays it out. */
const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
};

/** Small RGB, grayscale or RGBA PNG with explicit, unfiltered samples and optional chunk order. */
const keyedPng = (
    colourType: 0 | 2 | 6, depth: 8 | 16, samples: readonly number[],
    transparency?: Uint8Array, placement: 'before' | 'after' | 'duplicate' = 'before',
): Blob => {
    const channels = colourType === 0 ? 1 : colourType === 2 ? 3 : 4;
    if (samples.length % channels !== 0) throw new Error('invalid PNG test pixels');
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, samples.length / channels);
    view.setUint32(4, 1);
    header[8] = depth;
    header[9] = colourType;
    const pixels = new Uint8Array(1 + samples.length * (depth / 8));
    samples.forEach((sample, i) => {
        if (depth === 16) {
            pixels[1 + i * 2] = sample >>> 8;
            pixels[2 + i * 2] = sample & 255;
        } else pixels[1 + i] = sample;
    });
    const keyed = transparency ? chunk('tRNS', transparency) : null;
    const image = chunk('IDAT', new Uint8Array(deflateSync(pixels)));
    const parts: Uint8Array[] = [chunk('IHDR', header)];
    if (keyed && placement !== 'after') parts.push(keyed);
    parts.push(image);
    if (keyed && placement !== 'before') parts.push(keyed);
    parts.push(chunk('IEND', new Uint8Array(0)));
    return new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ...parts]);
};

describe('PNG pictures', () => {
    it('keeps 16-bit grey and colour values whole', async () => {
        const grey = new Uint16Array(5 * 3).map((_, i) => (i * 4099) % 65536);
        const back = await readPng16(await encodePng16(grey, 5, 3, 1));
        expect(await pngBitDepth(await encodePng16(grey, 5, 3, 1))).toBe(16);
        for (let p = 0; p < grey.length; p++) {
            expect(Math.round(back.data[p * 4] * 65535)).toBe(grey[p]);
            expect(back.data[p * 4 + 3]).toBe(1);
        }
        const colour = new Uint16Array(4 * 4 * 4).map((_, i) => (i * 7919) % 65536);
        const again = await readPng16(await encodePng16(colour, 4, 4, 4));
        for (let i = 0; i < colour.length; i++) expect(Math.round(again.data[i] * 65535)).toBe(colour[i]);
    });

    it('reads 16-bit pictures into half floats: one value a pixel for grey, four for colour', async () => {
        const grey = new Uint16Array(5 * 3).map((_, i) => (i * 4099) % 65536);
        const back = await readPng16Half(await encodePng16(grey, 5, 3, 1));
        expect(back.channels).toBe(1);
        expect(back.data).toBeInstanceOf(Uint16Array);
        expect(back.data.length).toBe(grey.length);
        // Half floats keep 11 bits: within a part in 2048 of the value.
        for (let p = 0; p < grey.length; p++) expect(Math.abs(DataUtils.fromHalfFloat(back.data[p]) - grey[p] / 65535)).toBeLessThanOrEqual(grey[p] / 65535 / 2048 + 1e-7);
        const colour = new Uint16Array(4 * 4 * 4).map((_, i) => (i * 7919) % 65536);
        const again = await readPng16Half(await encodePng16(colour, 4, 4, 4));
        expect(again.channels).toBe(4);
        for (let i = 0; i < colour.length; i++) expect(Math.abs(DataUtils.fromHalfFloat(again.data[i]) - colour[i] / 65535)).toBeLessThanOrEqual(colour[i] / 65535 / 2048 + 1e-7);
        // An 8-bit picture reads into half floats too.
        const rgb = await readPng16Half(await encodePng(new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]), 2, 1));
        expect(DataUtils.fromHalfFloat(rgb.data[7])).toBe(1);
        expect(DataUtils.fromHalfFloat(rgb.data[4])).toBeCloseTo(40 / 255, 3);
        // Both readers agree.
        const full = await readPng16(await encodePng16(colour, 4, 4, 4));
        for (let i = 0; i < colour.length; i++) expect(Math.abs(full.data[i] - DataUtils.fromHalfFloat(again.data[i]))).toBeLessThanOrEqual(full.data[i] / 2048 + 1e-7);
        // The nearest half, exactly at its edges.
        expect(toHalf(1)).toBe(0x3c00);
        expect(toHalf(0.5)).toBe(0x3800);
        expect(toHalf(0)).toBe(0);
        expect(DataUtils.fromHalfFloat(toHalf(2 ** -20))).toBe(2 ** -20);
    });

    it('writes grey maps with one value per pixel, read back exactly', async () => {
        const grey = new Uint8Array(7 * 2).map((_, i) => (i * 37) % 256);
        const blob = await encodePng(grey, 7, 2, 1);
        expect(new Uint8Array(await blob.slice(25, 26).arrayBuffer())[0]).toBe(0);
        const back = await readPng16(blob);
        for (let p = 0; p < grey.length; p++) expect(Math.round(back.data[p * 4] * 255)).toBe(grey[p]);
    });

    it('preserves 8-bit RGB tRNS key transparency in float and half-float readers', async () => {
        const file = keyedPng(2, 8, [31, 17, 50, 31, 17, 51, 31, 17, 50], new Uint8Array([0, 31, 0, 17, 0, 50]));
        const full = await readPng16(file);
        expect(full.channels).toBe(4);
        expect([full.data[3], full.data[7], full.data[11]]).toEqual([0, 1, 0]);
        expect(Math.round(full.data[4] * 255)).toBe(31);
        expect(Math.round(full.data[6] * 255)).toBe(51);
        const half = await readPng16Half(file);
        expect(half.channels).toBe(4);
        expect([half.data[3], half.data[7], half.data[11]]).toEqual([toHalf(0), toHalf(1), toHalf(0)]);
        expect(DataUtils.fromHalfFloat(half.data[4])).toBeCloseTo(31 / 255, 3);
    });

    it('matches 16-bit RGB tRNS keys at full source precision', async () => {
        const file = keyedPng(2, 16, [500, 12345, 65000, 500, 12345, 64999],
            new Uint8Array([0x01, 0xf4, 0x30, 0x39, 0xfd, 0xe8]));
        const full = await readPng16(file);
        const half = await readPng16Half(file);
        expect(full.channels).toBe(4);
        expect([full.data[3], full.data[7]]).toEqual([0, 1]);
        expect([half.data[3], half.data[7]]).toEqual([0, 0x3c00]);
        expect(full.data[6]).toBeCloseTo(64999 / 65535, 6);
    });

    it.each([
        [8, [0, 140, 255], [0, 140]],
        [16, [0, 1000, 65535], [0x03, 0xe8]],
    ] as const)('preserves %i-bit grayscale tRNS without quantizing the source', async (depth, samples, key) => {
        const file = keyedPng(0, depth, samples, new Uint8Array(key));
        const full = await readPng16(file);
        expect(full.channels).toBe(2);
        expect([full.data[3], full.data[7], full.data[11]]).toEqual([1, 0, 1]);
        expect(full.data[4]).toBe(full.data[5]);
        const half = await readPng16Half(file);
        expect(half.channels).toBe(4); // A transparent gray texture needs an alpha channel.
        expect([half.data[3], half.data[7], half.data[11]]).toEqual([0x3c00, 0, 0x3c00]);
        expect(half.data[4]).toBe(half.data[5]);
        expect(half.data[5]).toBe(half.data[6]);
    });

    it('keeps unkeyed RGB and grayscale pictures opaque', async () => {
        const rgb = await readPng16(keyedPng(2, 8, [10, 20, 30, 40, 50, 60]));
        expect(rgb.channels).toBe(3);
        expect([rgb.data[3], rgb.data[7]]).toEqual([1, 1]);
        const gray = await readPng16Half(keyedPng(0, 16, [1000, 2000]));
        expect(gray.channels).toBe(1);
        expect(gray.data.length).toBe(2);
    });

    it('rejects malformed, repeated, late or illegal tRNS chunks', async () => {
        const invalid = [
            keyedPng(2, 8, [10, 20, 30], new Uint8Array([0, 10])),
            keyedPng(0, 8, [10], new Uint8Array([0, 10, 0, 20, 0, 30])),
            keyedPng(2, 8, [10, 20, 30], new Uint8Array([1, 10, 0, 20, 0, 30])),
            keyedPng(6, 8, [10, 20, 30, 255], new Uint8Array([0, 10, 0, 20, 0, 30])),
            keyedPng(2, 8, [10, 20, 30], new Uint8Array([0, 10, 0, 20, 0, 30]), 'after'),
            keyedPng(2, 8, [10, 20, 30], new Uint8Array([0, 10, 0, 20, 0, 30]), 'duplicate'),
        ];
        for (const file of invalid) {
            await expect(readPng16(file)).rejects.toThrow('transparency');
            await expect(readPng16Half(file)).rejects.toThrow('transparency');
        }
    });

    it('reads every row filter other tools write', async () => {
        const width = 3;
        const height = 5;
        const pixels = new Uint8Array(width * height * 3).map((_, i) => (i * 53 + 11) % 256);
        const row = width * 3;
        const raw = new Uint8Array((row + 1) * height);
        for (let y = 0; y < height; y++) {
            const filter = y;
            raw[y * (row + 1)] = filter;
            for (let i = 0; i < row; i++) {
                const x = pixels[y * row + i];
                const left = i >= 3 ? pixels[y * row + i - 3] : 0;
                const up = y > 0 ? pixels[(y - 1) * row + i] : 0;
                const corner = y > 0 && i >= 3 ? pixels[(y - 1) * row + i - 3] : 0;
                const p = left + up - corner;
                const paeth = Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - corner) ? left : Math.abs(p - up) <= Math.abs(p - corner) ? up : corner;
                const predicted = [0, left, up, (left + up) >> 1, paeth][filter];
                raw[y * (row + 1) + 1 + i] = (x - predicted) & 255;
            }
        }
        const header = new Uint8Array(13);
        new DataView(header.buffer).setUint32(0, width);
        new DataView(header.buffer).setUint32(4, height);
        header[8] = 8;
        header[9] = 2;
        const file = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))]);
        const back = await readPng16(file);
        for (let p = 0; p < width * height; p++) {
            for (let c = 0; c < 3; c++) expect(Math.round(back.data[p * 4 + c] * 255)).toBe(pixels[p * 3 + c]);
        }
    });
    it('rejects tiny PNG files claiming impossible pixel dimensions before inflation', async () => {
        const header = new Uint8Array(13);
        const view = new DataView(header.buffer);
        view.setUint32(0, 60_000);
        view.setUint32(4, 60_000);
        header[8] = 8;
        header[9] = 6;
        const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
        const file = new Blob([signature, chunk('IHDR', header), chunk('IDAT', new Uint8Array(deflateSync(new Uint8Array(5)))), chunk('IEND', new Uint8Array(0))]);
        await expect(readPng16(file)).rejects.toThrow('pixel budget');
        await expect(readPng16Half(file)).rejects.toThrow('pixel budget');
    });

    it('caps actual inflated PNG scanlines and rejects short streams', async () => {
        const header = new Uint8Array(13);
        const view = new DataView(header.buffer);
        view.setUint32(0, 1);
        view.setUint32(4, 1);
        header[8] = 8;
        header[9] = 6;
        const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
        const file = (raw: Uint8Array) => new Blob([signature, chunk('IHDR', header), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))]);
        await expect(readPng16(file(new Uint8Array(100_000)))).rejects.toThrow('declared decoded scanline');
        await expect(readPng16(file(new Uint8Array(4)))).rejects.toThrow('truncated decoded scanlines');
    });

    it('validates chunk lengths, CRCs and split IDAT streams', async () => {
        const header = new Uint8Array(13);
        const view = new DataView(header.buffer);
        view.setUint32(0, 1);
        view.setUint32(4, 1);
        header[8] = 8;
        header[9] = 6;
        const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
        const compressed = new Uint8Array(deflateSync(new Uint8Array([0, 10, 20, 30, 255])));
        const split = Math.floor(compressed.length / 2);
        const valid = new Uint8Array(await new Blob([signature, chunk('IHDR', header),
            chunk('IDAT', compressed.subarray(0, split)), chunk('IDAT', compressed.subarray(split)),
            chunk('IEND', new Uint8Array(0))]).arrayBuffer());
        const decoded = await readPng16(new Blob([valid]));
        expect(Array.from(decoded.data).map((value) => Math.round(value * 255))).toEqual([10, 20, 30, 255]);
        const badLength = valid.slice();
        new DataView(badLength.buffer).setUint32(8, 0xffffffff);
        await expect(readPng16(new Blob([badLength]))).rejects.toThrow('chunk length');
        const badCrc = valid.slice();
        badCrc[29] ^= 1;
        await expect(readPng16(new Blob([badCrc]))).rejects.toThrow('checksum');
    });

    it('rejects oversized PNG sources before requesting the backing buffer', async () => {
        const oversized = {
            size: 161 * 1024 * 1024,
            arrayBuffer: async () => { throw new Error('must not buffer oversized source'); },
        } as unknown as Blob;
        await expect(readPng16(oversized)).rejects.toThrow('file budget');
    });

});

describe('graph content keys', () => {
    const graphOf = (nodes: TextureGraph['nodes']): TextureGraph => ({ version: 1, size: { w: 9, h: 9 }, seed: 0, nodes, links: [], parameters: [] });

    it('change when a graph used two levels down changes, and not when its nodes only move', () => {
        const inner = graphOf([createNode('perlinNoise', 0, 0, { scale: 4 })]);
        const middle = graphOf([{ ...createNode('subgraph', 0, 0), params: { graph: 'inner' } }]);
        const outer = graphOf([{ ...createNode('subgraph', 0, 0), params: { graph: 'middle' } }]);
        const graphs: Record<string, TextureGraph> = { inner, middle };
        const resolve = (id: string) => (graphs[id] ? { graph: graphs[id] } : undefined);
        const before = graphContentKey(outer, resolve, () => false);
        graphs.inner = { ...inner, nodes: inner.nodes.map((node) => ({ ...node, x: node.x + 300 })) };
        expect(graphContentKey(outer, resolve, () => false)).toBe(before);
        graphs.inner = { ...inner, nodes: inner.nodes.map((node) => ({ ...node, params: { ...node.params, scale: 9 } })) };
        expect(graphContentKey(outer, resolve, () => false)).not.toBe(before);
    });
});
