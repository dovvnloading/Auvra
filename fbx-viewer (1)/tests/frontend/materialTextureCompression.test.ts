import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
    decodeLevel,
    encodeLevel,
    encodeMaterialTexture,
    kaiserMipLevels,
    textureMemoryBytes,
} from '../../utils/textureCompression/materialTextureEncoder';
import { clearTextureSettings, keptFormat, limitedSize, normalizeTextureSettings, setTextureSettings, textureRole } from '../../texturing/textureSettings';
import { textureFromPicture } from '../../texturing/materialTextureLoader';
import type { DecodedPicture } from '../../texturing/textureDecode';

/** A smooth gradient with some colour, `size` pixels a side. */
const gradient = (size: number): Uint8Array => {
    const rgba = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const o = (y * size + x) * 4;
        rgba.set([Math.round(x / (size - 1) * 255), Math.round(y / (size - 1) * 200), 90, 255 - x * 4], o);
    }
    return rgba;
};

const worstError = (a: Uint8Array, b: Uint8Array, channels: number[]) => {
    let worst = 0;
    for (let i = 0; i < a.length; i += 4) for (const c of channels) worst = Math.max(worst, Math.abs(a[i + c] - b[i + c]));
    return worst;
};

const ALL: { bptc: boolean; rgtc: boolean } = { bptc: true, rgtc: true };

afterEach(() => clearTextureSettings());

describe('material texture compression', () => {
    it('keeps colour and alpha close in BC7', () => {
        // Along one line of colour in each block (as most blocks are), sixteen steps keep it within a few levels.
        const ramp = new Uint8Array(16 * 16 * 4);
        for (let i = 0; i < 256; i++) ramp.set([(i % 16) * 16, (i % 16) * 8 + 40, 200 - (i % 16) * 6, 255 - (i % 16) * 3], i * 4);
        expect(encodeLevel(ramp, 16, 16, 'bc7').length).toBe(16 * 16);
        expect(worstError(ramp, decodeLevel(encodeLevel(ramp, 16, 16, 'bc7'), 16, 16, 'bc7'), [0, 1, 2, 3])).toBeLessThanOrEqual(6);
        // Colour changing two ways in a block is fitted with one line (mode 6 only): close on average.
        const rgba = gradient(16);
        const back = decodeLevel(encodeLevel(rgba, 16, 16, 'bc7'), 16, 16, 'bc7');
        let total = 0;
        for (let i = 0; i < rgba.length; i++) total += Math.abs(rgba[i] - back[i]);
        expect(total / rgba.length).toBeLessThan(8);
    });

    it('keeps one channel close in BC4, read back 0..1 from the signed format', () => {
        const rgba = gradient(8);
        const encoded = encodeLevel(rgba, 8, 8, 'bc4');
        expect(encoded.length).toBe(8 * 8 / 2);
        // End points are 0..127: non-negative as signed bytes.
        for (let block = 0; block < encoded.length; block += 8) expect(encoded[block]).toBeLessThanOrEqual(127);
        expect(worstError(rgba, decodeLevel(encoded, 8, 8, 'bc4'), [0])).toBeLessThanOrEqual(10);
    });

    it('keeps a normal map\'s directions in BC5', () => {
        const rgba = new Uint8Array(8 * 8 * 4);
        for (let i = 0; i < 64; i++) rgba.set([128 + (i % 8) * 8, 128 - (i % 8) * 4, 230, 255], i * 4);
        expect(worstError(rgba, decodeLevel(encodeLevel(rgba, 8, 8, 'bc5'), 8, 8, 'bc5'), [0, 1])).toBeLessThanOrEqual(6);
    });

    it('makes mip levels down to one pixel, normals unit length at each', () => {
        const normals = new Uint8Array(8 * 8 * 4);
        for (let i = 0; i < 64; i++) normals.set(i % 2 ? [255, 128, 128, 255] : [0, 128, 128, 255], i * 4);
        const levels = kaiserMipLevels(normals, 8, 8, 'normal');
        expect(levels.map(level => level.width)).toEqual([8, 4, 2, 1]);
        for (const level of levels.slice(1)) {
            const [x, y, z] = [0, 1, 2].map(c => level.data[c] / 255 * 2 - 1);
            expect(Math.hypot(x, y, z)).toBeCloseTo(1, 1);
        }
        // Colour is filtered in linear light: black and white average lighter than mid-grey bytes.
        const checker = new Uint8Array(4 * 4 * 4);
        for (let i = 0; i < 16; i++) checker.set(((i + Math.floor(i / 4)) % 2) ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);
        expect(kaiserMipLevels(checker, 4, 4, 'colour')[2].data[0]).toBeGreaterThan(160);
        expect(encodeMaterialTexture(gradient(16), 16, 16, 'bc7', 'colour').length).toBe(5);
    });

    it('counts what a texture takes on the GPU, mip levels included', () => {
        expect(textureMemoryBytes(1024, 1024, 'rgba8', false)).toBe(4 * 1024 * 1024);
        expect(textureMemoryBytes(1024, 1024, 'bc7', false)).toBe(1024 * 1024);
        expect(textureMemoryBytes(1024, 1024, 'bc4', false)).toBe(512 * 1024);
        // Mip levels add about a third; small levels still take whole 4×4 blocks.
        expect(textureMemoryBytes(1024, 1024, 'bc7')).toBeGreaterThan(1024 * 1024 * 1.33);
        expect(textureMemoryBytes(1024, 1024, 'bc7')).toBeLessThan(1024 * 1024 * 1.34);
        expect(textureMemoryBytes(2, 2, 'bc7', false)).toBe(16);
    });
});

describe('the format a texture is kept in', () => {
    const picture = { channels: 4, depth: 8, hdr: false, width: 512, height: 512 };

    it('follows its role: BC7 colour, BC5 normals, BC4 for one channel of data', () => {
        expect(keptFormat(textureRole('map', undefined), undefined, ALL, picture)).toBe('bc7');
        expect(keptFormat(textureRole('normal', undefined), undefined, ALL, picture)).toBe('bc5');
        expect(keptFormat(textureRole('data', undefined), undefined, ALL, { ...picture, channels: 1 })).toBe('bc4');
        // Packed data (occlusion, roughness, metalness) keeps its channels in BC7.
        expect(keptFormat(textureRole('data', undefined), undefined, ALL, picture)).toBe('bc7');
        // A texture marked a normal map is one wherever it is read.
        expect(textureRole('map', { normalMap: true })).toBe('normal');
        expect(textureRole('map', { colorSpace: 'data' })).toBe('data');
    });

    it('follows its settings, and keeps whole what cannot be compressed', () => {
        expect(keptFormat('colour', { compression: 'none' }, ALL, picture)).toBe('rgba8');
        expect(keptFormat('colour', { compression: 'bc4' }, ALL, picture)).toBe('bc4');
        expect(keptFormat('colour', undefined, ALL, { ...picture, hdr: true })).toBe('half');
        expect(keptFormat('colour', undefined, ALL, { ...picture, width: 510 })).toBe('rgba8');
        expect(keptFormat('colour', undefined, { bptc: false, rgtc: true }, picture)).toBe('rgba8');
        expect(keptFormat('normal', undefined, { bptc: true, rgtc: false }, picture)).toBe('rgba8');
        expect(limitedSize(4096, 2048, 1024)).toEqual({ width: 1024, height: 512 });
    });

    it('stores settings made safe', () => {
        expect(normalizeTextureSettings({
            colorSpace: 'data', normalMap: true, compression: 'bc5', maxSize: 1024, wrap: 'clamp', filter: 'nearest', mips: false,
            source: { format: 'exr', depth: 32, channels: 4, hdr: true }, preview: { assetId: 'a'.repeat(64) }, extra: 1,
        })).toEqual({
            colorSpace: 'data', normalMap: true, compression: 'bc5', maxSize: 1024, wrap: 'clamp', filter: 'nearest', mips: false,
            source: { format: 'exr', depth: 32, channels: 4, hdr: true }, preview: { assetId: 'a'.repeat(64) },
        });
        expect(normalizeTextureSettings({ maxSize: 1000, compression: 'astc', wrap: 'tile', preview: { assetId: 'x' } })).toBeUndefined();
    });
});

describe('a material texture made from its picture', () => {
    const picture = (width: number, height: number, extra: Partial<DecodedPicture> = {}): DecodedPicture => ({
        width, height, depth: 16, channels: 4, hdr: false, rgba: new Float32Array(width * height * 4).fill(0.5), ...extra,
    });

    it('is kept whole where nothing is compressed, with its settings', async () => {
        setTextureSettings('t', { wrap: 'mirror', filter: 'nearest', maxSize: 256 });
        const { texture, format } = await textureFromPicture(picture(512, 512), { textureId: 't', slot: 'map', flipY: true }, false);
        expect(format).toBe('rgba8');
        expect([texture.image.width, texture.image.height]).toEqual([256, 256]);
        expect(texture.wrapS).toBe(THREE.MirroredRepeatWrapping);
        expect(texture.magFilter).toBe(THREE.NearestFilter);
        expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);
        expect(texture.userData.auvraTextureSettings).toBe(true);
    });

    it('keeps floating-point light as half floats, read as stored', async () => {
        const { texture, format } = await textureFromPicture(picture(4, 4, { hdr: true, depth: 32 }), { textureId: 'sky', slot: 'map', flipY: false }, true);
        expect(format).toBe('half');
        expect(texture.type).toBe(THREE.HalfFloatType);
        expect(texture.colorSpace).toBe(THREE.NoColorSpace);
    });
});
