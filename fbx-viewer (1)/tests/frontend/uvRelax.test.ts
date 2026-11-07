import { describe, expect, it } from 'vitest';
import { densityScales, islandAreas, islandLinks, relaxIsland, straighteningTurn, texelDensity, turnIsland, type IslandShape } from '../../texturing/uv/relax';

/** A 3 × 3 grid of vertices (two triangles a cell) on the model, laid flat on the picture as given. */
const grid = (place: (x: number, y: number) => [number, number]): IslandShape => {
    const positions: number[] = [];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) positions.push(x, y, 0);
    const corners: number[] = [];
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
        const a = y * 3 + x, b = a + 1, c = a + 3, d = a + 4;
        corners.push(a, b, d, a, d, c);
    }
    const uv = new Float64Array(corners.length * 2);
    corners.forEach((v, i) => { const [u, w] = place(v % 3, Math.floor(v / 3)); uv[i * 2] = u; uv[i * 2 + 1] = w; });
    return { uv, corners, positions };
};

const vertexUv = (shape: IslandShape, uv: Float64Array, vertex: number): [number, number] => {
    const i = Array.from(shape.corners).indexOf(vertex);
    return [uv[i * 2], uv[i * 2 + 1]];
};

describe('relaxing islands', () => {
    it('settles a pulled vertex back to the middle of its neighbours, leaving the edge where it is', () => {
        // The middle vertex (4) dragged off towards a corner.
        const shape = grid((x, y) => (x === 1 && y === 1 ? [0.18, 0.18] : [x * 0.1, y * 0.1]));
        expect(islandLinks(shape.corners).edge.has(4)).toBe(false);
        const relaxed = relaxIsland(shape);
        const [u, v] = vertexUv(shape, relaxed, 4);
        expect(u).toBeCloseTo(0.1, 3);
        expect(v).toBeCloseTo(0.1, 3);
        for (const corner of [0, 2, 6, 8, 1, 3]) expect(vertexUv(shape, relaxed, corner)).toEqual(vertexUv(shape, shape.uv, corner));
        // Every corner of one vertex moves together.
        const at = Array.from(shape.corners).map((vertex, i) => (vertex === 4 ? [relaxed[i * 2], relaxed[i * 2 + 1]] : null)).filter(Boolean);
        expect(new Set(at.map((pair) => pair!.join(','))).size).toBe(1);
    });

    it('keeps pinned vertices where they are', () => {
        const shape = grid((x, y) => (x === 1 && y === 1 ? [0.18, 0.18] : [x * 0.1, y * 0.1]));
        const relaxed = relaxIsland(shape, { pinned: new Set([4]) });
        expect(vertexUv(shape, relaxed, 4)).toEqual([0.18, 0.18]);
    });
});

describe('straightening islands', () => {
    it('turns an island so its edges run along U and V', () => {
        const angle = 0.3;
        const shape = grid((x, y) => [x * 0.1 * Math.cos(angle) - y * 0.1 * Math.sin(angle), x * 0.1 * Math.sin(angle) + y * 0.1 * Math.cos(angle)]);
        const turn = straighteningTurn(shape);
        expect(turn).toBeCloseTo(-angle, 4);
        const straight = turnIsland(shape.uv, turn);
        const [u0, v0] = vertexUv(shape, straight, 0);
        const [u2, v2] = vertexUv(shape, straight, 2);
        expect(v2 - v0).toBeCloseTo(0, 4);
        expect(u2 - u0).toBeCloseTo(0.2, 4);
        // An island already straight is left as it is.
        expect(straighteningTurn(grid((x, y) => [x * 0.1, y * 0.1]))).toBeCloseTo(0, 6);
    });
});

describe('texel density', () => {
    it('measures texels per model unit and the scales that even islands out', () => {
        const small = grid((x, y) => [x * 0.05, y * 0.05]);
        const large = grid((x, y) => [x * 0.2, y * 0.2]);
        const areas = [islandAreas(small), islandAreas(large)];
        expect(areas[1].model).toBeCloseTo(4, 6);
        expect(texelDensity(areas[0], 1024)).toBeCloseTo(51.2, 3);
        expect(texelDensity(areas[1], 1024)).toBeCloseTo(204.8, 3);
        const scales = densityScales(areas, 1024);
        // Scaled, both islands have the same density.
        expect(texelDensity(areas[0], 1024) * scales[0]).toBeCloseTo(texelDensity(areas[1], 1024) * scales[1], 6);
        expect(densityScales(areas, 1024, 102.4)).toEqual([2, 0.5]);
    });
});
