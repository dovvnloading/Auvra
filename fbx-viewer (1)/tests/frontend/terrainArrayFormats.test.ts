import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { arrayLevels, compressTerrainArrays, sliceRgba, terrainArrayFormats } from '../../components/Environment/Terrain/terrainLayerTextures';
import { PHONE_SUPPORTS } from '../../texturing/textureSettings';
import { decodeLevel, encodeMaterialTexture } from '../../utils/textureCompression/materialTextureEncoder';

const SIZE = 16;
const LAYERS = 2;

/** An array of `channels` per pixel, each layer a different smooth picture. */
const array = (channels: 2 | 4, colorSpace: THREE.ColorSpace, fill: (layer: number, x: number, y: number, channel: number) => number): THREE.DataArrayTexture => {
    const data = new Uint8Array(SIZE * SIZE * LAYERS * channels);
    for (let layer = 0; layer < LAYERS; layer++) for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
        for (let c = 0; c < channels; c++) data[((layer * SIZE + y) * SIZE + x) * channels + c] = fill(layer, x, y, c);
    }
    const texture = new THREE.DataArrayTexture(data, SIZE, SIZE, LAYERS);
    texture.colorSpace = colorSpace;
    return texture;
};

const encode = async (rgba: Uint8Array, width: number, height: number, format: Parameters<typeof encodeMaterialTexture>[3], kind: Parameters<typeof encodeMaterialTexture>[4], mips: boolean) => encodeMaterialTexture(rgba, width, height, format, kind, mips);

describe('terrain arrays compressed by role', () => {
    it('take BC7 for colour and BC5 for normals and for height with roughness, ASTC or ETC2 on phones', () => {
        expect(terrainArrayFormats({ bptc: true, rgtc: true })).toEqual({ albedo: 'bc7', detail: 'bc5', surface: 'bc5' });
        expect(terrainArrayFormats(PHONE_SUPPORTS[0])).toEqual({ albedo: 'astc', detail: 'astc', surface: 'astc' });
        expect(terrainArrayFormats(PHONE_SUPPORTS[1])).toEqual({ albedo: 'etc2', detail: 'etc2', surface: 'etc2' });
        // Nothing compressed where the card takes none of them: the arrays stay whole.
        expect(terrainArrayFormats({ bptc: false, rgtc: false })).toBeNull();
        expect(terrainArrayFormats({ bptc: true, rgtc: false })).toBeNull();
    });

    it('read a two-channel slice as RGBA, a normal\'s blue rebuilt', () => {
        const data = new Uint8Array([128, 128, 255, 128, 0, 0]);
        expect(Array.from(sliceRgba(data, 2, 1, 0, true))).toEqual([128, 128, 255, 255]);
        expect(Array.from(sliceRgba(data, 2, 1, 1, true))).toEqual([255, 128, 128, 255]);
        expect(Array.from(sliceRgba(data, 2, 1, 2))).toEqual([0, 0, 0, 255]);
    });

    it('lay each layer\'s levels one after another', () => {
        const levels = arrayLevels([
            [{ data: new Uint8Array([1, 1]), width: 4, height: 4 }, { data: new Uint8Array([2]), width: 2, height: 2 }],
            [{ data: new Uint8Array([3, 3]), width: 4, height: 4 }, { data: new Uint8Array([4]), width: 2, height: 2 }],
        ]);
        expect(levels.map(level => [level.width, Array.from(level.data)])).toEqual([[4, [1, 1, 3, 3]], [2, [2, 4]]]);
    });

    it('come out as compressed arrays holding every layer, close to the pictures', async () => {
        const arrays = {
            albedo: array(4, THREE.SRGBColorSpace, (layer, x, y, c) => (c === 3 ? 255 : Math.round(((x + y * (c + 1) + layer * 40) * 255) / 80) & 255)),
            detail: array(2, THREE.NoColorSpace, (layer, x, y, c) => 128 + Math.round(40 * Math.sin((c ? y : x) * 0.4 + layer))),
            surface: array(2, THREE.NoColorSpace, (layer, x, y, c) => (c === 0 ? x * 16 : 255 - y * 12 - layer * 20)),
        };
        const made = await compressTerrainArrays(arrays, LAYERS, SIZE, { albedo: 'bc7', detail: 'bc5', surface: 'bc5' }, encode);
        expect(made.albedo).toBeInstanceOf(THREE.CompressedArrayTexture);
        expect(made.albedo.format).toBe(THREE.RGBA_BPTC_Format);
        expect(made.detail.format).toBe(THREE.RED_GREEN_RGTC2_Format);
        expect(made.surface.format).toBe(THREE.RED_GREEN_RGTC2_Format);
        expect(made.albedo.colorSpace).toBe(THREE.SRGBColorSpace);
        expect(made.surface.colorSpace).toBe(THREE.NoColorSpace);
        const levels = made.surface.mipmaps as unknown as Array<{ data: Uint8Array; width: number; height: number }>;
        // 16 × 16 down to 1 × 1, each level holding both layers' blocks (16 bytes a 4 × 4 block).
        expect(levels.map(level => level.width)).toEqual([16, 8, 4, 2, 1]);
        expect(levels[0].data.length).toBe(LAYERS * (SIZE / 4) * (SIZE / 4) * 16);
        // The second layer's height and roughness come back within a few steps.
        const blocks = (SIZE / 4) * (SIZE / 4) * 16;
        const decoded = decodeLevel(levels[0].data.subarray(blocks, blocks * 2), SIZE, SIZE, 'bc5');
        const source = sliceRgba(arrays.surface.image.data as unknown as Uint8Array, 2, SIZE, 1);
        let worst = 0;
        for (let i = 0; i < SIZE * SIZE; i++) for (const c of [0, 1]) worst = Math.max(worst, Math.abs(decoded[i * 4 + c] - source[i * 4 + c]));
        expect(worst).toBeLessThanOrEqual(8);
        // As phones take them.
        const phone = await compressTerrainArrays(arrays, LAYERS, SIZE, { albedo: 'astc', detail: 'astc', surface: 'astc' }, encode);
        expect(phone.albedo.format).toBe(THREE.RGBA_ASTC_4x4_Format);
        expect((phone.detail.mipmaps as unknown as Array<{ data: Uint8Array }>)[0].data.length).toBe(LAYERS * (SIZE / 4) * (SIZE / 4) * 16);
    });
});
