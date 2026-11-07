import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { compressionSignature, packCompressed, unpackCompressed } from '../../texturing/compressedContainer';
import { createMaterialTextureLoader, type CompressedTextureCache } from '../../texturing/materialTextureLoader';
import { clearTextureSettings, normalizeTextureSettings, setTextureSettings, setTextureSourceAsset, withKeptCompression } from '../../texturing/textureSettings';
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

const ALL = { bptc: true, rgtc: true };
const SOURCE = 'a'.repeat(64);

/** An 8×8 colour picture as a data URL the loader fetches. */
const pictureUrl = async (): Promise<string> => {
    const samples = new Uint16Array(8 * 8 * 4).map((_, i) => (i * 997) % 65535);
    const bytes = new Uint8Array(await (await encodePng16(samples, 8, 8, 4)).arrayBuffer());
    return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
};

/** A cache in memory, counting what it is asked. */
const memoryCache = () => {
    const kept = new Map<string, Uint8Array>();
    const asked: string[] = [];
    const cache: CompressedTextureCache = {
        find: async (_id, signature) => { asked.push(signature); return kept.get(signature) ?? null; },
        keep: async (_id, signature, packed) => { kept.set(signature, packed); },
    };
    return { cache, kept, asked };
};

afterEach(() => clearTextureSettings());

describe('compressed textures kept in the project', () => {
    it('are packed and read back as they were', () => {
        const levels = [{ data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), width: 4, height: 4 }, { data: new Uint8Array(16).fill(7), width: 2, height: 2 }];
        const back = unpackCompressed(packCompressed({ format: 'bc7', width: 4, height: 4, levels }));
        expect(back?.format).toBe('bc7');
        expect(back?.levels.map(level => [level.width, Array.from(level.data)])).toEqual(levels.map(level => [level.width, Array.from(level.data)]));
        expect(unpackCompressed(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
    });

    it('are signed by the file, its role and settings, which way up and what the GPU takes', () => {
        const base = compressionSignature(SOURCE, 'colour', undefined, true, ALL);
        expect(compressionSignature(SOURCE, 'colour', undefined, true, ALL)).toBe(base);
        for (const other of [
            compressionSignature('b'.repeat(64), 'colour', undefined, true, ALL),
            compressionSignature(SOURCE, 'normal', undefined, true, ALL),
            compressionSignature(SOURCE, 'colour', { maxSize: 512 }, true, ALL),
            compressionSignature(SOURCE, 'colour', { compression: 'bc4' }, true, ALL),
            compressionSignature(SOURCE, 'colour', undefined, false, ALL),
            compressionSignature(SOURCE, 'colour', undefined, true, { bptc: false, rgtc: true }),
        ]) expect(other).not.toBe(base);
        // What it is drawn with, not what it is kept beside, decides it.
        expect(compressionSignature(SOURCE, 'colour', { wrap: 'clamp', preview: { assetId: SOURCE } }, true, ALL)).toBe(base);
    });

    it('are compressed once, kept, and loaded as they are the next time', async () => {
        setTextureSourceAsset('albedo', SOURCE);
        const { cache, kept, asked } = memoryCache();
        const load = createMaterialTextureLoader({ compress: true, cache, support: ALL });
        const url = await pictureUrl();
        const first = await load(url, { textureId: 'albedo', slot: 'map', flipY: true });
        expect(first).toBeInstanceOf(THREE.CompressedTexture);
        await Promise.resolve();
        expect(kept.size).toBe(1);
        // A miss, then a hit: the second load reads the kept blocks, not the file.
        const again = await load('data:text/plain,not-a-picture', { textureId: 'albedo', slot: 'map', flipY: true });
        expect(again).toBeInstanceOf(THREE.CompressedTexture);
        expect(asked).toHaveLength(2);
        expect(asked[0]).toBe(asked[1]);
        expect((again as THREE.CompressedTexture).mipmaps.length).toBe((first as THREE.CompressedTexture).mipmaps.length);
        expect(again.colorSpace).toBe(THREE.SRGBColorSpace);
    });

    it('are made again when the settings change, and not at all when compression is off', async () => {
        setTextureSourceAsset('albedo', SOURCE);
        const { cache, kept } = memoryCache();
        const url = await pictureUrl();
        await createMaterialTextureLoader({ compress: true, cache, support: ALL })(url, { textureId: 'albedo', slot: 'map', flipY: true });
        setTextureSettings('albedo', { maxSize: 4 });
        await createMaterialTextureLoader({ compress: true, cache, support: ALL })(url, { textureId: 'albedo', slot: 'map', flipY: true });
        await Promise.resolve();
        expect(kept.size).toBe(2);
        const off = memoryCache();
        const whole = await createMaterialTextureLoader({ compress: false, cache: off.cache, support: ALL })(url, { textureId: 'albedo', slot: 'map', flipY: true });
        expect(whole).not.toBeInstanceOf(THREE.CompressedTexture);
        expect(off.asked).toEqual([]);
    });

    it('are listed with the texture\'s settings, the newest few kept', () => {
        let settings = withKeptCompression(undefined, 'one', 'c'.repeat(64));
        // Up to eight: a desktop's and phones' versions, each way up.
        for (const signature of ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'two']) settings = withKeptCompression(settings, signature, 'd'.repeat(64));
        expect(settings.compressed?.map(entry => entry.signature)).toEqual(['three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'two']);
        expect(normalizeTextureSettings({ compressed: [{ signature: 'x', assetId: 'e'.repeat(64) }, { signature: 'y', assetId: 'bad' }] })).toEqual({ compressed: [{ signature: 'x', assetId: 'e'.repeat(64) }] });
    });
});
