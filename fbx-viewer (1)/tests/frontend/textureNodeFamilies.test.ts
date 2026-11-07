import { describe, expect, it } from 'vitest';
import { defaultNodeParams } from '../../texturing/graph/document';
import { FILTER_NODES, FILTER_REFERENCES, FILTER_SHADERS, inverseBilinear } from '../../texturing/graph/nodes/filters';
import { GEOMETRY_NODES, reoriented, solvePoisson, transformedNormal, uncombined } from '../../texturing/graph/nodes/geometry';
import { textureNodeDefinitionByType } from '../../texturing/graph/registry';
import { transformMatrix } from '../../texturing/graph/safeTransform';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SEED = 4321.5;
const withDefaults = (type: string, extra: Record<string, unknown> = {}) => ({ ...defaultNodeParams(textureNodeDefinitionByType(type)!), ...extra });

/** A picture that repeats every 1 across and down, read the same at both edges. */
const tiling = (u0: number, v0: number): number => {
    const u = u0 - Math.floor(u0);
    const v = v0 - Math.floor(v0);
    return 0.5 + 0.3 * Math.sin(2 * Math.PI * u) + 0.15 * Math.cos(2 * Math.PI * (2 * v + u)) + 0.05 * Math.sin(6 * Math.PI * v);
};

/** The largest difference between a picture's left and right edges, and top and bottom. */
const edgeGap = (picture: (u: number, v: number) => number): number => {
    let gap = 0;
    for (let i = 0; i <= 30; i++) {
        const t = (i + 0.31) / 31;
        gap = Math.max(gap, Math.abs(picture(0, t) - picture(1, t)), Math.abs(picture(t, 0) - picture(t, 1)));
    }
    return gap;
};

describe('blurs, warps and transforms', () => {
    it('keep a tiling picture tiling where they move it about', () => {
        const cases: Array<[string, Record<string, unknown>]> = [
            ['skew', { amount: 0.3 }], ['skew', { amount: 0.77, offset: [0.1, -0.2] }], ['skew', { amount: -1.3, axis: 'down' }],
            ['symmetry', { mode: 'across' }], ['symmetry', { mode: 'down' }], ['symmetry', { mode: 'four' }], ['symmetry', { mode: 'eight' }],
            ['symmetry', { mode: 'kaleidoscope', segments: 7, repeats: 3, angle: 20 }],
            ['mapRotation', { range: 120, cells: 5 }], ['clone', { to: [0.95, 0.02], from: [0.3, 0.6], size: 0.2 }], ['noiseUpscale', { octaves: 4 }],
        ];
        const rotationMap = (u: number, v: number) => tiling(v + 0.3, u);
        for (const [type, extra] of cases) {
            const params = withDefaults(type, extra);
            expect(edgeGap((u, v) => FILTER_REFERENCES[type](tiling, u, v, params, SEED, { rotation: rotationMap })), `${type} ${JSON.stringify(extra)}`).toBeLessThan(1e-9);
        }
        // Without blending its seams, a slant breaks tiling: the blend is what keeps it.
        expect(edgeGap((u, v) => FILTER_REFERENCES.skew(tiling, u, v, withDefaults('skew', { amount: 0.3, seamless: false }), SEED))).toBeGreaterThan(0.01);
    });

    it('read their input round each pixel through the kit, which wraps where the node tiles', () => {
        expect(Object.keys(FILTER_SHADERS).length).toBeGreaterThanOrEqual(8);
        for (const [type, glsl] of Object.entries(FILTER_SHADERS)) {
            expect(glsl, type).not.toMatch(/texture\(t_|texelFetch\(t_/);
            expect(glsl, type).toMatch(/[cg]_in\(/);
        }
    });

    it('places a picture into a quad and finds it again', () => {
        const a = [0.1, 0.1];
        const b = [0.9, 0.2];
        const c = [0.2, 0.8];
        const d = [0.8, 0.95];
        const at = (s: number, t: number) => [0, 1].map((k) => a[k] * (1 - s) * (1 - t) + b[k] * s * (1 - t) + c[k] * (1 - s) * t + d[k] * s * t);
        for (const [s, t] of [[0.25, 0.4], [0.5, 0.5], [0.9, 0.1], [0, 1]]) {
            const [rs, rt] = inverseBilinear(at(s, t), a, b, c, d);
            expect(rs).toBeCloseTo(s, 6);
            expect(rt).toBeCloseTo(t, 6);
        }
        expect(inverseBilinear([0.3, 0.7], [0, 0], [1, 0], [0, 1], [1, 1]).map((x) => Number(x.toFixed(9)))).toEqual([0.3, 0.7]);
    });

    it('every node says what it does', () => {
        for (const definition of FILTER_NODES) expect(definition.description.length, definition.type).toBeGreaterThan(40);
    });
});

describe('geometry effects and normals', () => {
    const unit = (v: number[]) => { const l = Math.hypot(...v); return v.map((x) => x / l); };

    it('takes a base normal back out of a combined one', () => {
        for (const [base, detail] of [[[0.3, -0.2, 0.93], [0.1, 0.4, 0.91]], [[-0.5, 0.1, 0.86], [0, 0, 1]], [[0, 0, 1], [0.6, 0.2, 0.77]]]) {
            const combined = unit(reoriented(unit(base), unit(detail)));
            uncombined(combined, base).forEach((value, k) => expect(value).toBeCloseTo(unit(detail)[k], 5));
        }
    });

    it("turns, mirrors and steepens a normal map's directions with its picture", () => {
        // Read through a quarter turn, a slope across becomes a slope down.
        const quarter = transformedNormal(unit([0.5, 0, 0.87]), transformMatrix(90, [1, 1]));
        expect(Math.abs(quarter[0])).toBeLessThan(1e-9);
        expect(Math.abs(quarter[1])).toBeGreaterThan(0.4);
        // Mirrored across, the slope across turns round.
        expect(transformedNormal(unit([0.5, 0.2, 0.84]), transformMatrix(0, [-1, 1]))[0]).toBeLessThan(0);
        // Half the size, twice as many repeats: the same heights over half the distance are steeper.
        const n = unit([0.3, 0, 0.95]);
        expect(transformedNormal(n, transformMatrix(0, [0.5, 0.5]))[0]).toBeGreaterThan(n[0]);
    });

    it('solves a height from its slopes by multigrid, the error falling with each cycle', () => {
        const size = 32;
        const height = (x: number, y: number) => Math.sin(2 * Math.PI * x / size) * 3 + Math.cos(2 * Math.PI * (2 * y + x) / size) * 2;
        const slopes = (x: number, y: number) => [(height(x + 1, y) - height(x - 1, y)) / 2, (height(x, y + 1) - height(x, y - 1)) / 2];
        const f = new Float64Array(size * size);
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) f[y * size + x] = (slopes(x + 1, y)[0] - slopes(x - 1, y)[0] + slopes(x, y + 1)[1] - slopes(x, y - 1)[1]) / 2;
        const error = (cycles: number) => {
            const h = solvePoisson(f, size, cycles);
            const mean = h.reduce((a, b) => a + b, 0) / h.length;
            let worst = 0;
            for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) worst = Math.max(worst, Math.abs(h[y * size + x] - mean - height(x, y)));
            return worst;
        };
        const one = error(1);
        const six = error(6);
        expect(six).toBeLessThan(one);
        // Against heights spanning 10: within a few hundredths (the slopes' own steps make the rest).
        expect(six).toBeLessThan(0.15);
    });

    it('reads round each pixel only through wrapping reads, so tiling pictures stay tiling', () => {
        const source = readFileSync(resolve(__dirname, '../../texturing/graph/nodes/geometry.ts'), 'utf8');
        expect(source).not.toMatch(/texture\(t_|texelFetch\(t_/);
        for (const definition of GEOMETRY_NODES) expect(definition.description.length, definition.type).toBeGreaterThan(40);
    });
});
