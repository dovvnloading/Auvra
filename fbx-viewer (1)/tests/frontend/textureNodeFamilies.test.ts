import { describe, expect, it } from 'vitest';
import { defaultNodeParams } from '../../texturing/graph/document';
import { FILTER_NODES, FILTER_REFERENCES, FILTER_SHADERS, inverseBilinear } from '../../texturing/graph/nodes/filters';
import { textureNodeDefinitionByType } from '../../texturing/graph/registry';

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
