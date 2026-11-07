import { describe, expect, it } from 'vitest';
import { layoutAlong, pathLength, readPaths, sampleAt, samplePath, type PathPoint } from '../../texturing/paint/paths';

const point = (x: number, y: number, size = 1, opacity = 1): PathPoint => ({ position: [x, y, 0], normal: [0, 0, 1], size, opacity });

describe('path sampling', () => {
    it('samples a line at even steps, blending size and opacity between its points', () => {
        const samples = samplePath([point(0, 0, 1, 1), point(10, 0, 3, 0)], 1, false);
        expect(samples).toHaveLength(11);
        samples.forEach((sample, i) => {
            expect(sample.distance).toBeCloseTo(i, 6);
            expect(sample.position[0]).toBeCloseTo(i, 3);
            expect(sample.position[1]).toBeCloseTo(0, 6);
            expect(sample.tangent[0]).toBeCloseTo(1, 3);
        });
        expect(samples[5].size).toBeCloseTo(2, 2);
        expect(samples[5].opacity).toBeCloseTo(0.5, 2);
        expect(pathLength([point(0, 0), point(10, 0)], false)).toBeCloseTo(10, 3);
    });

    it('runs a smooth curve through every point, and round to the start when closed', () => {
        const square = [point(0, 0), point(10, 0), point(10, 10), point(0, 10)];
        const open = samplePath(square, 0.25, false);
        for (const corner of square.slice(1, 3)) {
            const nearest = Math.min(...open.map((sample) => Math.hypot(sample.position[0] - corner.position[0], sample.position[1] - corner.position[1])));
            expect(nearest).toBeLessThan(0.2);
        }
        const closed = samplePath(square, 0.25, true);
        const first = closed[0].position, last = closed[closed.length - 1].position;
        expect(Math.hypot(first[0] - last[0], first[1] - last[1])).toBeLessThan(0.3);
        expect(closed[closed.length - 1].distance).toBeGreaterThan(open[open.length - 1].distance);
        for (const sample of closed) expect(Math.hypot(...sample.tangent)).toBeCloseTo(1, 6);
        expect(samplePath([point(2, 3)], 1, false)).toHaveLength(1);
        expect(samplePath([], 1, false)).toEqual([]);
    });

    it('lays letters one after another until the path runs out', () => {
        expect(layoutAlong([2, 2, 2], 7, 0.5)).toEqual([1, 3.5, 6]);
        expect(layoutAlong([2, 2, 2], 6.9, 0.5)).toEqual([1, 3.5, null]);
        const samples = samplePath([point(0, 0), point(10, 0)], 1, false);
        expect(sampleAt(samples, 3.4)?.distance).toBeCloseTo(3, 6);
        expect(sampleAt([], 1)).toBeNull();
    });

    it('reads stored paths safely', () => {
        const [path] = readPaths([{ id: 'p1', name: 'Seam', closed: true, style: 'text', text: 'Hi', gap: 99, points: [{ position: [1, 2, 3], normal: [0, 1, 0], size: -1, opacity: 4 }, { position: 'x' }] }, { name: 'no id' }]);
        expect(path.points).toHaveLength(2);
        expect(path.points[0]).toEqual({ position: [1, 2, 3], normal: [0, 1, 0], size: 1e-6, opacity: 1 });
        expect(path.points[1].position).toEqual([0, 0, 0]);
        expect(path.gap).toBe(10);
        expect(path.style).toBe('text');
        expect(readPaths([{ id: 'q', points: [], style: 'laser' }])[0].style).toBe('brush');
        expect(readPaths('junk')).toEqual([]);
    });
});
