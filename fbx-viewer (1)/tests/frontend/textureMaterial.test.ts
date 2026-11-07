import { describe, expect, it } from 'vitest';
import type { GpuImage } from '../../texturing/gpu/textureGpu';
import {
    MATERIAL_CHANNELS,
    adjustRoughness,
    blendedHeight,
    channelOfKey,
    decodeNormal,
    encodeNormal,
    heightWeight,
    materialOf,
    materialResults,
    mixNormals,
    outputChannelOf,
    scaleHeight,
    scaleNormal,
    tilingTransform,
    turnNormal,
    wireFits,
    type Vec3,
} from '../../texturing/graph/material';
import { MATERIAL_NODES } from '../../texturing/graph/nodes/materials';
import { TEXTURE_NODE_DEFINITIONS } from '../../texturing/graph/registry';

const close = (actual: readonly number[], expected: readonly number[], digits = 5) => actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], digits));
const length = (colour: Vec3) => Math.hypot(...decodeNormal(colour));
const image = (name: string) => ({ name } as unknown as GpuImage);

describe('material wires: type rules', () => {
    it('lets a material wire into material inputs and Outputs only, and images anywhere but material inputs', () => {
        expect(wireFits('material', { kind: 'material' })).toBe(true);
        expect(wireFits('material', { kind: 'any', material: true })).toBe(true);
        expect(wireFits('material', { kind: 'any' })).toBe(false);
        expect(wireFits('material', { kind: 'color' })).toBe(false);
        expect(wireFits('color', { kind: 'material' })).toBe(false);
        expect(wireFits('gray', { kind: 'material' })).toBe(false);
        expect(wireFits('gray', { kind: 'color' })).toBe(true);
        expect(wireFits('color', { kind: 'any', material: true })).toBe(true);
    });

    it('gives each Output its own channel of a material, a named image its base colour or height', () => {
        expect(outputChannelOf('roughness', 'gray')).toBe('roughness');
        expect(outputChannelOf('custom', 'color')).toBe('baseColor');
        expect(outputChannelOf('custom', 'gray')).toBe('height');
    });

    it('keeps a material as one picture per channel under its output, and reads it back', () => {
        const results = materialResults('out', { normal: image('n'), baseColor: image('b') });
        expect(Object.keys(results)).toEqual(['out:baseColor', 'out:normal']);
        expect(channelOfKey('out:normal')).toBe('normal');
        expect(channelOfKey('mask')).toBeNull();
        expect(materialOf(results, 'out')).toEqual({ baseColor: image('b'), normal: image('n') });
        expect(materialOf(results, 'other')).toBeNull();
    });

    it('has the eight material nodes registered, each with a material pin', () => {
        expect(MATERIAL_NODES.map((node) => node.type)).toEqual(['makeMaterial', 'splitMaterial', 'materialBlend', 'materialHeightBlend', 'materialMultiBlend', 'materialSwitch', 'materialTransform', 'materialAdjust']);
        for (const node of MATERIAL_NODES) {
            expect(TEXTURE_NODE_DEFINITIONS).toContain(node);
            expect([...node.inputs, ...node.outputs].some((port) => port.kind === 'material')).toBe(true);
        }
        const split = MATERIAL_NODES.find((node) => node.type === 'splitMaterial')!;
        expect(split.outputs.map((port) => port.key)).toEqual([...MATERIAL_CHANNELS]);
    });
});

describe('material wires: blending maths', () => {
    it('mixes normals as directions, so the result stays one unit long', () => {
        const right = encodeNormal([1, 0, 0]);
        const up = encodeNormal([0, 0, 1]);
        close(mixNormals(right, up, 0), right);
        close(mixNormals(right, up, 1), up);
        const half = mixNormals(right, up, 0.5);
        expect(length(half)).toBeCloseTo(1, 5);
        close(decodeNormal(half), [Math.SQRT1_2, 0, Math.SQRT1_2]);
    });

    it('works out where the top shows from the two heights, the mask, offset and contrast', () => {
        expect(heightWeight(0.5, 0.5, 1, 0.5, 0.9)).toBeCloseTo(0.5, 5);
        expect(heightWeight(0.9, 0.2, 1, 0.5, 0.9)).toBe(1);
        expect(heightWeight(0.2, 0.9, 1, 0.5, 0.9)).toBe(0);
        // A black mask keeps the top under; raising the offset brings it back.
        expect(heightWeight(0.9, 0.5, 0, 0.5, 0.9)).toBe(0);
        expect(heightWeight(0.9, 0.5, 0, 1, 0.9)).toBe(1);
        // Low contrast softens the edge.
        expect(heightWeight(0.55, 0.5, 1, 0.5, 0)).toBeCloseTo(0.55, 5);
        expect(blendedHeight(0.8, 0.3, 0)).toBe(0.3);
        expect(blendedHeight(0.8, 0.3, 1)).toBe(0.8);
        expect(blendedHeight(0.1, 0.3, 1)).toBe(0.3);
    });

    it('scales heights round their middle, normals in steepness and roughness both ways', () => {
        expect(scaleHeight(0.8, 0)).toBe(0.5);
        expect(scaleHeight(0.6, 2)).toBeCloseTo(0.7, 6);
        expect(scaleHeight(0.9, 4)).toBe(1);
        const slope = encodeNormal([0.6, 0, 0.8]);
        close(scaleNormal(slope, 0), [0.5, 0.5, 1]);
        close(scaleNormal(slope, 1), slope);
        expect(length(scaleNormal(slope, 3))).toBeCloseTo(1, 5);
        expect(adjustRoughness(0.4, 0)).toBe(0.4);
        expect(adjustRoughness(0.4, 1)).toBe(1);
        expect(adjustRoughness(0.4, -1)).toBe(0);
        expect(adjustRoughness(0.4, 0.5)).toBeCloseTo(0.7, 6);
    });

    it('turns normals with their pictures and keeps tiling whole', () => {
        // Turning a slope that faces right a quarter turn makes it face down the picture.
        close(decodeNormal(turnNormal(encodeNormal([1, 0, 0]), 90)), [0, -1, 0]);
        close(turnNormal(encodeNormal([0.6, 0, 0.8]), 360), encodeNormal([0.6, 0, 0.8]));
        close(decodeNormal(turnNormal(encodeNormal([0.6, 0, 0.8]), 0, [-1, 1])), [-0.6, 0, 0.8]);
        expect(tilingTransform([1.4, -2.6], 100, true)).toEqual({ repeats: [1, -3], degrees: 90 });
        expect(tilingTransform([0.2, 3], 44, true)).toEqual({ repeats: [1, 3], degrees: 0 });
        expect(tilingTransform([1.4, -2.6], 100, false)).toEqual({ repeats: [1.4, -2.6], degrees: 100 });
    });
});
