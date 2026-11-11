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

type PackedHeader = {
    format: string; width: number; height: number;
    levels: Array<{ width: number; height: number; offset: number; length: number }>;
};

/** Rebuild a container after changing its JSON metadata, keeping the original block payload. */
const changeHeader = (bytes: Uint8Array, change: (header: PackedHeader) => void): Uint8Array => {
    const oldLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + oldLength))) as PackedHeader;
    change(header);
    const encoded = new TextEncoder().encode(JSON.stringify(header));
    const payload = bytes.subarray(8 + oldLength);
    const output = new Uint8Array(8 + encoded.length + payload.length);
    output.set(bytes.subarray(0, 4));
    new DataView(output.buffer).setUint32(4, encoded.length, true);
    output.set(encoded, 8);
    output.set(payload, 8 + encoded.length);
    return output;
};

describe('compressed textures kept in the project', () => {
    it('are packed and read back as they were', () => {
        const levels = [{ data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), width: 4, height: 4 }, { data: new Uint8Array(16).fill(7), width: 2, height: 2 }];
        const back = unpackCompressed(packCompressed({ format: 'bc7', width: 4, height: 4, levels }));
        expect(back?.format).toBe('bc7');
        expect(back?.levels.map(level => [level.width, Array.from(level.data)])).toEqual(levels.map(level => [level.width, Array.from(level.data)]));
        expect(unpackCompressed(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
    });

    it('rejects truncated, mismatched and tampered cached mip chains before upload', () => {
        const valid = packCompressed({
            format: 'bc7', width: 8, height: 8,
            levels: [
                { width: 8, height: 8, data: new Uint8Array(64).fill(1) },
                { width: 4, height: 4, data: new Uint8Array(16).fill(2) },
                { width: 2, height: 2, data: new Uint8Array(16).fill(3) },
                { width: 1, height: 1, data: new Uint8Array(16).fill(4) },
            ],
        });
        expect(unpackCompressed(valid)?.levels.map(level => [level.width, level.height, level.data.length]))
            .toEqual([[8, 8, 64], [4, 4, 16], [2, 2, 16], [1, 1, 16]]);
        const broken = [
            valid.subarray(0, valid.length - 15), // A partial final GPU block
            changeHeader(valid, header => { header.format = 'unknown'; }),
            changeHeader(valid, header => { header.width = 32768; }),
            changeHeader(valid, header => { header.levels[0].length = 1; }),
            changeHeader(valid, header => { header.levels[1].offset = 0; }),
            changeHeader(valid, header => { header.levels[1].offset += 16; }),
            changeHeader(valid, header => { header.levels[1].width = 3; }),
            changeHeader(valid, header => { header.levels.push({ ...header.levels[3] }); }),
            new Uint8Array([...valid, 99]), // Payload not described by any mip
        ];
        for (const bytes of broken) expect(unpackCompressed(bytes)).toBeNull();
        const badHeaderLength = valid.slice();
        new DataView(badHeaderLength.buffer).setUint32(4, badHeaderLength.length, true);
        expect(unpackCompressed(badHeaderLength)).toBeNull();
    });

    it('checks each format\'s exact 4×4 block size, even on small or non-square levels', () => {
        for (const [format, blockBytes] of [
            ['bc4', 8], ['bc5', 16], ['bc7', 16],
            ['astc', 16], ['etc2', 8], ['etc2a', 16],
        ] as const) {
            const valid = packCompressed({
                format, width: 5, height: 3,
                levels: [{ width: 5, height: 3, data: new Uint8Array(blockBytes * 2) }],
            });
            expect(unpackCompressed(valid)?.levels[0].data.length).toBe(blockBytes * 2);
            expect(unpackCompressed(valid.subarray(0, valid.length - 1))).toBeNull();
        }
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

    it('regenerates a texture from its source when the cached mip payload is damaged', async () => {
        setTextureSourceAsset('albedo', SOURCE);
        const { cache, kept } = memoryCache();
        const signature = compressionSignature(SOURCE, 'colour', undefined, true, ALL);
        const valid = packCompressed({ format: 'bc7', width: 4, height: 4,
            levels: [{ width: 4, height: 4, data: new Uint8Array(16).fill(1) }],
        });
        kept.set(signature, valid.subarray(0, valid.length - 15));
        const texture = await createMaterialTextureLoader({ compress: true, cache, support: ALL })(
            await pictureUrl(), { textureId: 'albedo', slot: 'map', flipY: true },
        ) as THREE.CompressedTexture;
        expect(texture).toBeInstanceOf(THREE.CompressedTexture);
        expect(texture.image.width).toBe(8); // The source, not the cached 4×4 header.
        await Promise.resolve();
        expect(unpackCompressed(kept.get(signature)!)).not.toBeNull();
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
