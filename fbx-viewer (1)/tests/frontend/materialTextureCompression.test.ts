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
        // Colour changing two ways in a block, with alpha, is fitted with one line (mode 6): close on average.
        const rgba = gradient(16);
        const back = decodeLevel(encodeLevel(rgba, 16, 16, 'bc7'), 16, 16, 'bc7');
        let total = 0;
        for (let i = 0; i < rgba.length; i++) total += Math.abs(rgba[i] - back[i]);
        expect(total / rgba.length).toBeLessThan(8);
    });

    it('splits opaque BC7 blocks of colours one line cannot hold (modes 1 and 3), and keeps them exactly opaque', () => {
        const modeOf = (byte: number) => { let mode = 0; while (mode < 8 && !((byte >> mode) & 1)) mode++; return mode; };
        // Red on the left, green over blue on the right: three colours, two of them on one line.
        const block = new Uint8Array(4 * 4 * 4);
        for (let i = 0; i < 16; i++) block.set((i & 3) < 2 ? [220, 30, 40, 255] : (i >> 2) < 2 ? [40, 200, 60, 255] : [20, 60, 210, 255], i * 4);
        const encoded = encodeLevel(block, 4, 4, 'bc7');
        expect([1, 3]).toContain(modeOf(encoded[0]));
        const back = decodeLevel(encoded, 4, 4, 'bc7');
        expect(worstError(block, back, [0, 1, 2])).toBeLessThanOrEqual(4);
        expect(worstError(block, back, [3])).toBe(0);
        // A red and a blue that sum alike stay apart in one line (mode 6), and opaque stays opaque there too.
        const pair = new Uint8Array(4 * 4 * 4);
        for (let i = 0; i < 16; i++) pair.set((i & 3) < 2 ? [220, 30, 40, 255] : [20, 60, 210, 255], i * 4);
        const pairBack = decodeLevel(encodeLevel(pair, 4, 4, 'bc7'), 4, 4, 'bc7');
        expect(worstError(pair, pairBack, [0, 1, 2])).toBeLessThanOrEqual(2);
        expect(worstError(pair, pairBack, [3])).toBe(0);
        // Hard-edged shapes come back far closer than one line a block could keep them.
        const shapes = new Uint8Array(32 * 32 * 4);
        for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) shapes.set((x * 3 + y * 5) % 23 < 11 ? [235, 225, 210, 255] : (x + y) % 13 < 6 ? [30, 90, 160, 255] : [180, 40, 30, 255], (y * 32 + x) * 4);
        const shapesBack = decodeLevel(encodeLevel(shapes, 32, 32, 'bc7'), 32, 32, 'bc7');
        let total = 0;
        for (let i = 0; i < shapes.length; i++) total += Math.abs(shapes[i] - shapesBack[i]);
        expect(total / shapes.length).toBeLessThan(4);
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
        const back = decodeLevel(encodeLevel(rgba, 8, 8, 'bc5'), 8, 8, 'bc5');
        expect(worstError(rgba, back, [0, 1])).toBeLessThanOrEqual(6);
        // Decoded, a normal's Z is rebuilt from X and Y and it is opaque.
        expect(back[2]).toBeGreaterThan(127);
        expect(back[3]).toBe(255);
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

    it('estimates the capped dimensions of narrow strip textures', () => {
        expect(limitedSize(1, 8192, 256)).toEqual({ width: 1, height: 256 });
        expect(limitedSize(8192, 1, 256)).toEqual({ width: 256, height: 1 });
        expect(limitedSize(2, 8192, 256)).toEqual({ width: 1, height: 256 });
        expect(limitedSize(8192, 2, 256)).toEqual({ width: 256, height: 1 });
        expect(limitedSize(1, 8192, undefined)).toEqual({ width: 1, height: 8192 });
    });

    it('compresses floating-point normal and data maps that stay within white, and keeps floating-point colour whole', () => {
        const float = { ...picture, depth: 32 };
        expect(keptFormat('normal', undefined, ALL, float)).toBe('bc5');
        expect(keptFormat('data', undefined, ALL, { ...float, channels: 1 })).toBe('bc4');
        expect(keptFormat('colour', undefined, ALL, float)).toBe('half');
        // Asked for, floating-point colour is compressed.
        expect(keptFormat('colour', { compression: 'bc7' }, ALL, float)).toBe('bc7');
        // Kept whole, a floating-point picture stays in half floats.
        expect(keptFormat('normal', { compression: 'none' }, ALL, float)).toBe('half');
        expect(keptFormat('normal', undefined, { bptc: true, rgtc: false }, float)).toBe('half');
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
        const image = texture.image as { width: number; height: number };
        expect([image.width, image.height]).toEqual([256, 256]);
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
