import { describe, expect, it } from 'vitest';
import { blendedSample, describeMatrix, tileSafeMatrix, transformMatrix, transformPlace, type Mat2 } from '../../texturing/graph/safeTransform';
import { textureNodeDefinitionByType } from '../../texturing/graph/registry';

/** A picture repeating every 1 across and down, with detail in both directions. */
const pattern = (u: number, v: number): number => Math.sin(2 * Math.PI * u) + 0.5 * Math.cos(2 * Math.PI * (2 * v + u)) + 0.25 * Math.sin(2 * Math.PI * 3 * v);

const ODD: Array<{ rotation: number; scale: [number, number]; offset: [number, number] }> = [
    { rotation: 17, scale: [0.37, 0.61], offset: [0.13, -0.2] },
    { rotation: 33.3, scale: [1, 1], offset: [0, 0] },
    { rotation: -71.9, scale: [0.23, 0.23], offset: [0.4, 0.07] },
    { rotation: 133, scale: [2.7, 0.8], offset: [-0.31, 0.5] },
];

/** The largest difference between a result's left and right edges, and its top and bottom. */
const edgeGap = (result: (u: number, v: number) => number): number => {
    let worst = 0;
    for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        worst = Math.max(worst, Math.abs(result(0, t) - result(1, t)), Math.abs(result(t, 0) - result(t, 1)));
    }
    return worst;
};

describe('safe transform', () => {
    it('snaps to whole-numbered matrices, which keep a repeating picture seamless at odd turns and sizes', () => {
        for (const { rotation, scale, offset } of ODD) {
            const exact = transformMatrix(rotation, scale);
            const safe = tileSafeMatrix(exact);
            expect(safe.every(Number.isInteger)).toBe(true);
            expect(safe[0] * safe[3] - safe[1] * safe[2]).not.toBe(0);
            const snapped = (u: number, v: number) => pattern(...transformPlace(safe, offset, u, v));
            expect(edgeGap(snapped)).toBeLessThan(1e-9);
            // The exact transform does not tile at these.
            const raw = (u: number, v: number) => pattern(...transformPlace(exact, offset, u, v));
            if (rotation !== 33.3 || scale[0] !== 1) expect(edgeGap(raw)).toBeGreaterThan(0.01);
        }
    });

    it('keeps the exact turn and size and blends the seams so the edges meet', () => {
        for (const { rotation, scale, offset } of ODD) {
            const exact = transformMatrix(rotation, scale);
            const read = (u: number, v: number) => pattern(...transformPlace(exact, offset, u, v));
            const result = (u: number, v: number) => blendedSample(read, u, v, 0.15);
            expect(edgeGap(result)).toBeLessThan(1e-9);
            // Away from the far edges it is the exact transform.
            expect(result(0.4, 0.3)).toBeCloseTo(read(0.4, 0.3), 12);
        }
    });

    it('snaps to the nearest seamless turn and size, and says what they are', () => {
        // Half size at no turn is seamless as it is.
        expect(tileSafeMatrix(transformMatrix(0, [0.5, 0.5]))).toEqual([2, -0, 0, 2]);
        // About 27 degrees at about 0.45: the lattice step (2, 1).
        const near = tileSafeMatrix(transformMatrix(26, [0.44, 0.44]));
        expect(near).toEqual([2, -1, 1, 2]);
        const said = describeMatrix(near);
        expect(said.rotation).toBeCloseTo(26.57, 1);
        expect(said.scale[0]).toBeCloseTo(1 / Math.sqrt(5), 6);
        expect(said.slant).toBe(false);
        // Larger than the picture cannot tile: it snaps to the picture's own size, turned as near as it can.
        const big = describeMatrix(tileSafeMatrix(transformMatrix(80, [3, 3])));
        expect(big.scale[0]).toBe(1);
        expect(Math.abs(big.rotation)).toBe(90);
        // A flat result is never given.
        const flat: Mat2 = [0.4, 0.4, 0.4, 0.4];
        const fixed = tileSafeMatrix(flat);
        expect(fixed[0] * fixed[3] - fixed[1] * fixed[2]).not.toBe(0);
    });

    it('is a node of its own, and an option on Transform', () => {
        expect(textureNodeDefinitionByType('safeTransform')?.params.map((param) => param.key)).toEqual(['offset', 'rotation', 'scale', 'mode', 'blend']);
        expect(textureNodeDefinitionByType('transform')?.params.find((param) => param.key === 'safe')?.default).toBe(false);
    });
});
