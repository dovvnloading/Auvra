import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { deepTexture, deepUpload } from '../../components/Texturing/deepPictures';
import { bitmapCrop, bitmapScale } from '../../texturing/graph/nodes/io';
import { textureNodeDefinitionByType } from '../../texturing/graph/registry';

const picture = (depth: 8 | 16 | 32) => ({
    width: 2, height: 1, depth, channels: 4 as const, hdr: false,
    // Two pixels: a value no 8-bit picture holds (0.5 + 1/2000), and one past white.
    rgba: new Float32Array([0.5005, 0.25, 0.125, 1, 1.75, 0, 0, 1]),
});

describe('Bitmap at its depth', () => {
    it('keeps a 16-bit picture as half floats and a float picture as full floats', () => {
        const half = deepUpload(picture(16));
        expect(half.type).toBe(THREE.HalfFloatType);
        expect(half.depth).toBe(16);
        expect(half.data).toBeInstanceOf(Uint16Array);
        expect(THREE.DataUtils.fromHalfFloat((half.data as Uint16Array)[0])).toBeCloseTo(0.5005, 3);
        const full = deepUpload(picture(32));
        expect(full.type).toBe(THREE.FloatType);
        expect(full.depth).toBe(32);
        expect((full.data as Float32Array)[4]).toBeCloseTo(1.75, 6);
        // An 8-bit picture loses nothing as bytes.
        const bytes = deepUpload(picture(8));
        expect(bytes.type).toBe(THREE.UnsignedByteType);
        expect(bytes.data[0]).toBe(128);
    });

    it('makes a texture that says its depth, and the node draws at that depth', () => {
        const texture = deepTexture(picture(16) as never);
        expect(texture.userData.auvraDepth).toBe(16);
        expect(texture.type).toBe(THREE.HalfFloatType);
        expect(texture.colorSpace).toBe(THREE.NoColorSpace);
        const bitmap = textureNodeDefinitionByType('bitmap')!;
        const lookup = (id: string) => (id === 'deep' ? texture : id === 'float' ? deepTexture(picture(32) as never) : id === 'plain' ? new THREE.Texture() : null);
        expect(bitmap.precisionOf!({ texture: 'deep' }, lookup)).toBe(16);
        expect(bitmap.precisionOf!({ texture: 'float' }, lookup)).toBe(32);
        expect(bitmap.precisionOf!({ texture: 'plain' }, lookup)).toBeUndefined();
        expect(bitmap.precisionOf!({ texture: '' }, lookup)).toBeUndefined();
    });

    it('crops inside the picture and fits, fills or stretches it to the node', () => {
        expect(bitmapCrop([0.25, 0.5], [0.5, 0.75])).toEqual([0.25, 0.5, 0.5, 0.5]);
        expect(bitmapCrop(undefined, undefined)).toEqual([0, 0, 1, 1]);
        expect(bitmapScale('stretch', 2, 1)).toEqual([1, 1]);
        // A picture twice as wide as the square node: fitted, its width fills and half the height is see-through.
        expect(bitmapScale('fit', 2, 1)).toEqual([1, 2]);
        // Filled, its height fills and half its width is cut.
        expect(bitmapScale('fill', 2, 1)).toEqual([0.5, 1]);
        expect(bitmapScale('fit', 0.5, 1)).toEqual([2, 1]);
        expect(bitmapScale('fill', 0.5, 1)).toEqual([1, 0.5]);
        expect(textureNodeDefinitionByType('bitmap')!.params.map((param) => param.key)).toEqual(['texture', 'colour', 'cropFrom', 'cropSize', 'fit']);
    });
});
