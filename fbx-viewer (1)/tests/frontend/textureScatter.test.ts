import { describe, expect, it } from 'vitest';
import { resolvePrecision, resolveSeed, resolveSize, resolveTiling, tilingAxes } from '../../texturing/graph/inherit';
import { shaderSeed } from '../../texturing/graph/document';
import {
    densityPoints, depthOf, floatBits, hash1, hashU, packCopies, picturePoints, poissonDisc, spacingOf, stackPixel, type ScatterCopy,
} from '../../texturing/graph/scatter';

describe('scatter placement', () => {
    it('keeps Poisson-disc points at least their spacing apart, round the edges too, and fills the square', () => {
        const spacing = 0.06;
        const points = poissonDisc(spacing, 7, true);
        let closest = Infinity;
        for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) closest = Math.min(closest, spacingOf(points[i], points[j], true));
        expect(closest).toBeGreaterThanOrEqual(spacing);
        // A filled square holds roughly one point per (spacing * 1.5)^2 or so; far more than a sparse throw.
        expect(points.length).toBeGreaterThan(0.5 / (spacing * spacing * 2));
        for (const [x, y] of points) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThan(1); }
        expect(poissonDisc(spacing, 7, true)).toEqual(points);
        expect(poissonDisc(spacing, 8, true)).not.toEqual(points);
    });

    it('places density points only where the map is bright, and spaced when asked', () => {
        // Left half white, right half black (4 × 1, bottom row first).
        const values = [1, 1, 0, 0];
        const points = densityPoints(values, 4, 1, 300, 3);
        expect(points.length).toBe(300);
        expect(points.every(([x]) => x < 0.5)).toBe(true);
        const spaced = densityPoints(values, 4, 1, 300, 3, 0.05, false);
        for (let i = 0; i < spaced.length; i++) for (let j = i + 1; j < spaced.length; j++) expect(spacingOf(spaced[i], spaced[j], false)).toBeGreaterThanOrEqual(0.05);
        // A quarter as bright, a quarter as likely.
        const shares = densityPoints([0.25, 1], 2, 1, 4000, 5);
        const left = shares.filter(([x]) => x < 0.5).length;
        expect(left / (shares.length - left)).toBeGreaterThan(0.18);
        expect(left / (shares.length - left)).toBeLessThan(0.33);
    });

    it('puts one point in the middle of each white pixel of a placement picture', () => {
        expect(picturePoints([0, 1, 1, 0], 2, 2)).toEqual([[0.75, 0.25], [0.25, 0.75]]);
    });

    it('packs copies three texels each, mirror flags as 1 and 2', () => {
        const copy: ScatterCopy = { x: 0.25, y: 0.5, halfWidth: 0.1, halfHeight: 0.05, turn: 1, pattern: 2, random: 0.5, mirrorX: true, mirrorY: true, tiltX: 0.1, tiltY: -0.1, brightness: 0.8, lift: 0 };
        const packed = packCopies([copy, { ...copy, mirrorY: false }]);
        expect(packed.width).toBe(2);
        expect([...packed.data[0].slice(0, 4)]).toEqual([0.25, 0.5, Math.fround(0.1), Math.fround(0.05)]);
        expect(packed.data[1][3]).toBe(3);
        expect(packed.data[1][7]).toBe(1);
    });

    it('hashes exactly as the shaders do', () => {
        expect(hashU(0)).toBe(0);
        expect(hashU(1)).toBe(hashU(1));
        expect(floatBits(1)).toBe(0x3f800000);
        const value = hash1(3, 4, 12.5);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
        expect(hash1(3, 4, 12.5)).toBe(value);
        expect(hash1(4, 3, 12.5)).not.toBe(value);
    });
});

describe('scatter stacking', () => {
    const fragments = [{ copy: 0, value: 0.4 }, { copy: 1, value: 0.9 }, { copy: 2, value: 0.6 }];

    it('keeps the taller copy where the higher wins, whatever order they were drawn in; ties keep the first', () => {
        expect(stackPixel(fragments, 'higher')).toEqual({ copy: 1, value: 0.9 });
        expect(stackPixel([...fragments].reverse(), 'higher')).toEqual({ copy: 1, value: 0.9 });
        expect(stackPixel([{ copy: 5, value: 0.5 }, { copy: 6, value: 0.5 }], 'higher')?.copy).toBe(5);
        expect(depthOf(0.9)).toBeLessThan(depthOf(0.4));
    });

    it('takes the brightest, adds up, or lays the last on top; empty parts never win', () => {
        expect(stackPixel(fragments, 'max')?.value).toBe(0.9);
        expect(stackPixel(fragments, 'add')?.value).toBeCloseTo(1.9, 6);
        expect(stackPixel(fragments, 'over')).toEqual({ copy: 2, value: 0.6 });
        expect(stackPixel([{ copy: 0, value: 0.7 }, { copy: 1, value: 0 }], 'over')?.copy).toBe(0);
        expect(stackPixel([{ copy: 0, value: 0 }], 'higher')).toBeNull();
    });
});

describe('where a node\'s settings come from', () => {
    it('resolves tiling from the node, its input or the graph', () => {
        expect(resolveTiling('none', 'both', 'both', true)).toBe('none');
        expect(resolveTiling(undefined, 'horizontal', 'both', true)).toBe('horizontal');
        expect(resolveTiling(undefined, undefined, 'vertical', true)).toBe('vertical');
        expect(resolveTiling(undefined, 'horizontal', 'vertical', false)).toBe('vertical');
        expect(resolveTiling('graph', 'horizontal', 'none', true)).toBe('none');
        expect(resolveTiling('input', undefined, 'none', false)).toBe('none');
        expect(tilingAxes('horizontal')).toEqual([true, false]);
        expect(tilingAxes('none')).toEqual([false, false]);
    });

    it('resolves bit depth as fixed, from the graph, or from the widest input', () => {
        expect(resolvePrecision(32, [8], 16, 'color')).toBe(32);
        expect(resolvePrecision('graph', [8], 16, 'color')).toBe(16);
        expect(resolvePrecision('graph', [8], undefined, 'gray')).toBe(16);
        expect(resolvePrecision('auto', [8, 16], 32, 'color')).toBe(16);
        expect(resolvePrecision(undefined, [], undefined, 'color')).toBe(8);
    });

    it('resolves the seed mixed with the graph\'s, its input\'s, or alone', () => {
        expect(resolveSeed(undefined, 3, 10, 99)).toBe(shaderSeed(10, 3));
        expect(resolveSeed('input', 3, 10, 99)).toBe(shaderSeed(99, 3));
        expect(resolveSeed('input', 3, 10, undefined)).toBe(shaderSeed(10, 3));
        expect(resolveSeed('fixed', 3, 10, 99)).toBe(shaderSeed(0, 3));
        expect(resolveSeed('fixed', 3, 11, 99)).toBe(resolveSeed('fixed', 3, 10, 99));
    });

    it('resolves the size from the input or the graph, scaled, or fixed', () => {
        const graph = { width: 1024, height: 1024 };
        expect(resolveSize('input', undefined, { width: 256, height: 512 }, graph)).toEqual({ width: 256, height: 512 });
        expect(resolveSize('input', { w: 1, h: -1 }, { width: 256, height: 512 }, graph)).toEqual({ width: 512, height: 256 });
        expect(resolveSize('input', undefined, undefined, graph)).toEqual(graph);
        expect(resolveSize('graph', { w: -1, h: 0 }, { width: 8, height: 8 }, graph)).toEqual({ width: 512, height: 1024 });
        expect(resolveSize('absolute', { w: 9, h: 11 }, undefined, graph)).toEqual({ width: 512, height: 2048 });
    });
});
