import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { decodeAstcBlock, encodeAstcBlock } from '../../utils/textureCompression/astcEncoder';
import { decodeEtc2Block, encodeEtc2Block } from '../../utils/textureCompression/etc2Encoder';
import { decodeLevel, encodeLevel, textureMemoryBytes, type MaterialTextureFormat } from '../../utils/textureCompression/materialTextureEncoder';
import { compressionSignature, unpackCompressed } from '../../texturing/compressedContainer';
import { createMaterialTextureLoader, phoneVersionsKept, textureFromCompressed, type CompressedTextureCache } from '../../texturing/materialTextureLoader';
import { PHONE_SUPPORTS, clearTextureSettings, keptFormat, setTextureSourceAsset } from '../../texturing/textureSettings';
import { encodePng16 } from '../../texturing/png';

// The test page's Blob cannot stream; the PNG reader and writer stream theirs (a worker's can).
if (!('stream' in Blob.prototype)) {
    Object.defineProperty(Blob.prototype, 'stream', {
        value(this: Blob) {
            const blob = this;
            return new ReadableStream({ async start(controller) { controller.enqueue(new Uint8Array(await blob.arrayBuffer())); controller.close(); } });
        },
    });
}

afterEach(() => { clearTextureSettings(); vi.restoreAllMocks(); });

/** A picture with smooth gradients and some detail, as textures have: RGBA rows. */
const picture = (width: number, height: number, alpha: boolean): Uint8Array => {
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        out[i] = Math.round(255 * x / (width - 1));
        out[i + 1] = Math.round(255 * y / (height - 1));
        out[i + 2] = Math.round(128 + 100 * Math.sin(x * 0.3) * Math.cos(y * 0.2));
        out[i + 3] = alpha ? Math.round(255 * (x + y) / (width + height - 2)) : 255;
    }
    return out;
};

/** Root-mean-square and largest difference per channel. */
const difference = (a: Uint8Array, b: Uint8Array, channels: number[]): { rms: number; max: number } => {
    let sum = 0, max = 0, count = 0;
    for (let i = 0; i < a.length; i += 4) for (const c of channels) {
        const d = Math.abs(a[i + c] - b[i + c]);
        sum += d * d;
        max = Math.max(max, d);
        count++;
    }
    return { rms: Math.sqrt(sum / count), max };
};

const roundTrip = (format: MaterialTextureFormat, rgba: Uint8Array, width: number, height: number) => decodeLevel(encodeLevel(rgba, width, height, format), width, height, format);

const bitsOf = (bytes: Uint8Array, at: number, count: number): number => {
    let value = 0;
    for (let i = 0; i < count; i++) value |= ((bytes[(at + i) >> 3] >> ((at + i) & 7)) & 1) << i;
    return value;
};

describe('ASTC 4×4', () => {
    it('keeps colour within a few steps of the picture', () => {
        const rgba = picture(64, 64, false);
        const back = roundTrip('astc', rgba, 64, 64);
        const colour = difference(rgba, back, [0, 1, 2]);
        // One partition: a block's colours lie on one line, as BC7's mode 6 keeps them.
        expect(colour.rms).toBeLessThan(4);
        expect(colour.max).toBeLessThan(24);
        expect(difference(rgba, back, [3]).max).toBe(0);
    });

    it('keeps alpha where it varies, and colour with it', () => {
        const rgba = picture(64, 64, true);
        const back = roundTrip('astc', rgba, 64, 64);
        expect(difference(rgba, back, [3]).rms).toBeLessThan(3);
        expect(difference(rgba, back, [0, 1, 2]).rms).toBeLessThan(6);
    });

    it('writes valid blocks: a 4×4 weight grid, one partition, colour end points at 8 bits', () => {
        // Colour along one line, as most blocks are.
        const line = new Uint8Array(64);
        for (let i = 0; i < 16; i++) line.set([100 + i * 2, 50 + i, 30 + i * 2, 255], i * 4);
        const opaque = encodeAstcBlock(line);
        expect(bitsOf(opaque, 0, 11)).toBe(0b00001010011);
        expect(bitsOf(opaque, 11, 2)).toBe(0);
        expect(bitsOf(opaque, 13, 4)).toBe(8);
        const withAlpha = encodeAstcBlock(picture(4, 4, true));
        expect(bitsOf(withAlpha, 0, 11)).toBe(0b00001000010);
        expect(bitsOf(withAlpha, 13, 4)).toBe(12);
        // A flat colour comes back exactly.
        const flat = new Uint8Array(64);
        for (let i = 0; i < 16; i++) flat.set([200, 40, 90, 255], i * 4);
        const out = new Uint8Array(64);
        decodeAstcBlock(encodeAstcBlock(flat), out);
        expect(Array.from(out)).toEqual(Array.from(flat));
    });

    it('never asks the decoder for blue contraction', () => {
        let split = 0;
        for (let seed = 1; seed < 200; seed++) {
            const block = new Uint8Array(64).map((_, i) => ((i * 37 + seed * 101) * 2654435761) >>> 24);
            for (let i = 3; i < 64; i += 4) block[i] = 255;
            const bytes = encodeAstcBlock(block);
            if (bitsOf(bytes, 11, 2) === 0) {
                const v = Array.from({ length: 6 }, (_, k) => bitsOf(bytes, 17 + k * 8, 8));
                expect(v[1] + v[3] + v[5]).toBeGreaterThanOrEqual(v[0] + v[2] + v[4]);
                continue;
            }
            split++;
            // Two partitions in mode 8 keep 4-bit end points, (r0, r1, g0, g1, b0, b1) each; mode 6 has no contraction.
            if (bitsOf(bytes, 25, 4) !== 8) continue;
            for (let part = 0; part < 2; part++) {
                const v = Array.from({ length: 6 }, (_, k) => bitsOf(bytes, 29 + (part * 6 + k) * 4, 4));
                expect(v[1] + v[3] + v[5]).toBeGreaterThanOrEqual(v[0] + v[2] + v[4]);
            }
        }
        // Noise has no one line of colour: most of these blocks are split.
        expect(split).toBeGreaterThan(50);
    });

    it('keeps two colours of one brightness apart', () => {
        // A red and a blue that sum alike: a search for their line started from grey would find none, and blur both.
        const block = new Uint8Array(64);
        for (let i = 0; i < 16; i++) block.set((i & 3) < 2 ? [220, 30, 40, 255] : [20, 60, 210, 255], i * 4);
        const out = new Uint8Array(64);
        decodeAstcBlock(encodeAstcBlock(block), out);
        expect(difference(block, out, [0, 1, 2]).max).toBeLessThanOrEqual(1);
    });

    it('splits a block of colours one line cannot hold in two partitions, and decodes them as a graphics card does', () => {
        // Red on the left; green over blue on the right.
        const block = new Uint8Array(64);
        for (let i = 0; i < 16; i++) block.set((i & 3) < 2 ? [220, 30, 40, 255] : (i >> 2) < 2 ? [40, 200, 60, 255] : [20, 60, 210, 255], i * 4);
        const bytes = encodeAstcBlock(block);
        expect(bitsOf(bytes, 11, 2)).toBe(1);
        // Both partitions take one colour endpoint mode (the field's low bits 0).
        expect(bitsOf(bytes, 23, 2)).toBe(0);
        expect([6, 8]).toContain(bitsOf(bytes, 25, 4));
        const out = new Uint8Array(64);
        decodeAstcBlock(bytes, out);
        expect(difference(block, out, [0, 1, 2]).max).toBeLessThanOrEqual(8);
        expect(difference(block, out, [3]).max).toBe(0);
        // On a picture of hard-edged shapes, splitting keeps the colours far closer.
        const shapes = new Uint8Array(32 * 32 * 4);
        for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) shapes.set((x * 3 + y * 5) % 23 < 11 ? [235, 225, 210, 255] : [30, 90, 160, 255], (y * 32 + x) * 4);
        expect(difference(shapes, roundTrip('astc', shapes, 32, 32), [0, 1, 2]).rms).toBeLessThan(6);
    });
});

describe('ETC2', () => {
    it('keeps colour within a few steps of the picture', () => {
        const rgba = picture(64, 64, false);
        const back = roundTrip('etc2', rgba, 64, 64);
        const colour = difference(rgba, back, [0, 1, 2]);
        // ETC's halves share one hue each, so it keeps less than ASTC.
        expect(colour.rms).toBeLessThan(8);
        expect(colour.max).toBeLessThan(40);
    });

    it('keeps alpha in its EAC block', () => {
        const rgba = picture(64, 64, true);
        const back = roundTrip('etc2a', rgba, 64, 64);
        expect(difference(rgba, back, [3]).rms).toBeLessThan(2);
        expect(difference(rgba, back, [0, 1, 2]).rms).toBeLessThan(8);
        // Opaque ETC2 reads opaque.
        expect(difference(rgba, roundTrip('etc2', rgba, 64, 64), [3]).max).toBe(255 - Math.min(...Array.from(rgba).filter((_, i) => i % 4 === 3)));
    });

    it('keeps a difference of bases only where it stays in range, so no decoder reads another mode', () => {
        for (let seed = 1; seed < 300; seed++) {
            const block = new Uint8Array(64).map((_, i) => ((i * 53 + seed * 97) * 2654435761) >>> 24);
            const bytes = encodeEtc2Block(block);
            const high = new DataView(bytes.buffer).getUint32(0);
            if (!((high >> 1) & 1)) continue;
            const signed = (value: number) => (value & 4 ? value - 8 : value);
            for (const [base, delta] of [[27, 24], [19, 16], [11, 8]]) {
                const sum = ((high >>> base) & 31) + signed((high >>> delta) & 7);
                expect(sum).toBeGreaterThanOrEqual(0);
                expect(sum).toBeLessThanOrEqual(31);
            }
        }
        // A flat colour comes back within its base's rounding.
        const flat = new Uint8Array(64);
        for (let i = 0; i < 16; i++) flat.set([200, 40, 90, 255], i * 4);
        const out = new Uint8Array(64);
        decodeEtc2Block(encodeEtc2Block(flat), out);
        expect(difference(flat, out, [0, 1, 2]).max).toBeLessThanOrEqual(3);
    });
});

describe('phones and devices without BC', () => {
    const shape = { channels: 4, depth: 8, hdr: false, width: 256, height: 256 };

    it('take ASTC, else ETC2 (with alpha for colour that has it), and desktops keep BC', () => {
        const desktop = { bptc: true, rgtc: true };
        expect(keptFormat('colour', undefined, desktop, shape)).toBe('bc7');
        expect(keptFormat('normal', undefined, desktop, shape)).toBe('bc5');
        expect(keptFormat('colour', undefined, PHONE_SUPPORTS[0], shape)).toBe('astc');
        expect(keptFormat('normal', undefined, PHONE_SUPPORTS[0], shape)).toBe('astc');
        expect(keptFormat('colour', undefined, PHONE_SUPPORTS[1], shape)).toBe('etc2a');
        expect(keptFormat('colour', undefined, PHONE_SUPPORTS[1], { ...shape, channels: 3 })).toBe('etc2');
        expect(keptFormat('normal', undefined, PHONE_SUPPORTS[1], shape)).toBe('etc2');
        expect(keptFormat('data', { compression: 'bc4' }, PHONE_SUPPORTS[0], { ...shape, channels: 1 })).toBe('astc');
        expect(keptFormat('colour', { compression: 'none' }, PHONE_SUPPORTS[0], shape)).toBe('rgba8');
        expect(keptFormat('colour', undefined, { bptc: false, rgtc: false }, shape)).toBe('rgba8');
        expect(textureMemoryBytes(256, 256, 'etc2', false)).toBe(32768);
        expect(textureMemoryBytes(256, 256, 'astc', false)).toBe(65536);
    });

    it('keep their blocks apart from a desktop\'s, which keeps its old signature', () => {
        const source = 'a'.repeat(64);
        const desktop = compressionSignature(source, 'colour', undefined, true, { bptc: true, rgtc: true });
        expect(desktop.endsWith('|br')).toBe(true);
        expect(compressionSignature(source, 'colour', undefined, true, { bptc: true, rgtc: true, astc: true, etc2: true })).toBe(desktop);
        const phones = PHONE_SUPPORTS.map(support => compressionSignature(source, 'colour', undefined, true, support));
        expect(phones.map(signature => signature.split('|').pop())).toEqual(['--ae', '---e']);
    });

    it('are given their own versions as the editor draws a texture, so a built game carries them', async () => {
        const samples = new Uint16Array(8 * 8 * 4).map((_, i) => (i * 997) % 65535);
        const bytes = new Uint8Array(await (await encodePng16(samples, 8, 8, 4)).arrayBuffer());
        const url = `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
        setTextureSourceAsset('tex', 'b'.repeat(64));
        const kept = new Map<string, Uint8Array>();
        const cache: CompressedTextureCache = { find: async (_id, signature) => kept.get(signature) ?? null, keep: async (_id, signature, packed) => { kept.set(signature, packed); } };
        const load = createMaterialTextureLoader({ compress: true, cache, support: { bptc: true, rgtc: true }, alsoKeepFor: PHONE_SUPPORTS });
        const texture = await load(url, { textureId: 'tex', slot: 'map', flipY: true });
        expect(texture.format).toBe(THREE.RGBA_BPTC_Format);
        await phoneVersionsKept();
        const formats = [...kept.values()].map(packed => unpackCompressed(packed)?.format).sort();
        expect(formats).toEqual(['astc', 'bc7', 'etc2a']);
        // A phone finds its version and loads it without compressing.
        const onPhone = compressionSignature('b'.repeat(64), 'colour', undefined, true, PHONE_SUPPORTS[0]);
        const phoneTexture = textureFromCompressed(unpackCompressed(kept.get(onPhone)!)!, 'colour', undefined);
        expect(phoneTexture.format).toBe(THREE.RGBA_ASTC_4x4_Format);
        expect(phoneTexture.colorSpace).toBe(THREE.SRGBColorSpace);
        // Drawn again, nothing is made twice.
        const before = new Map(kept);
        await load(url, { textureId: 'tex', slot: 'map', flipY: true });
        await phoneVersionsKept();
        expect([...kept.entries()].every(([signature, packed]) => before.get(signature) === packed)).toBe(true);
    });
    it('backfills phone variants on a desktop-only cache hit without redecoding complete variants', async () => {
        const samples = new Uint16Array(8 * 8 * 4).map((_, i) => (i * 997) % 65535);
        const bytes = new Uint8Array(await (await encodePng16(samples, 8, 8, 4)).arrayBuffer());
        const url = `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
        const source = 'c'.repeat(64);
        const textureId = 'cached-desktop-only';
        const request = { textureId, slot: 'map' as const, flipY: true };
        const desktop = { bptc: true, rgtc: true };
        setTextureSourceAsset(textureId, source);
        const kept = new Map<string, Uint8Array>();
        const cache: CompressedTextureCache = {
            find: async (_id, signature) => kept.get(signature) ?? null,
            keep: async (_id, signature, packed) => { kept.set(signature, packed); },
        };
        const desktopSignature = compressionSignature(source, 'colour', undefined, true, desktop);
        const initialLoad = createMaterialTextureLoader({ compress: true, cache, support: desktop });
        await initialLoad(url, request);
        expect([...kept.keys()]).toEqual([desktopSignature]);

        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const loadWithPhones = createMaterialTextureLoader({ compress: true, cache, support: desktop, alsoKeepFor: PHONE_SUPPORTS });
        const cachedTexture = await loadWithPhones(url, request);
        expect(cachedTexture.format).toBe(THREE.RGBA_BPTC_Format);
        await phoneVersionsKept();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect([...kept.values()].map(packed => unpackCompressed(packed)?.format).sort())
            .toEqual(['astc', 'bc7', 'etc2a']);

        // Every requested phone signature exists: no source fetch/decode and no new encoding.
        fetchSpy.mockClear();
        const completed = new Map(kept);
        await loadWithPhones(url, request);
        await phoneVersionsKept();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect([...kept.entries()].every(([signature, packed]) => completed.get(signature) === packed)).toBe(true);

        // Several simultaneous hits with one missing format share one migration.
        const astcSignature = compressionSignature(source, 'colour', undefined, true, PHONE_SUPPORTS[0]);
        const etcSignature = compressionSignature(source, 'colour', undefined, true, PHONE_SUPPORTS[1]);
        const previousAstc = kept.get(astcSignature);
        kept.delete(etcSignature);
        fetchSpy.mockClear();
        const textures = await Promise.all(Array.from({ length: 6 }, () => loadWithPhones(url, request)));
        expect(textures.every(texture => texture.format === THREE.RGBA_BPTC_Format)).toBe(true);
        await phoneVersionsKept();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(kept.get(astcSignature)).toBe(previousAstc);
        expect(unpackCompressed(kept.get(etcSignature)!)?.format).toBe('etc2a');
    });

});
