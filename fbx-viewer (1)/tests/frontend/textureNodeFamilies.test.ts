import { describe, expect, it } from 'vitest';
import { defaultNodeParams } from '../../texturing/graph/document';
import { FILTER_NODES, FILTER_REFERENCES, FILTER_SHADERS, inverseBilinear } from '../../texturing/graph/nodes/filters';
import { GEOMETRY_NODES, reoriented, solvePoisson, transformedNormal, uncombined } from '../../texturing/graph/nodes/geometry';
import { MESH_READING_NODE_TYPES } from '../../texturing/graph/nodes/io';
import { STAND_IN_MAPS, WEATHERING_NODES, WEATHERING_REFERENCES, type WeatherMaps } from '../../texturing/graph/nodes/weathering';
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

describe('mesh-based weathering', () => {
    const facing = (x: number, y: number, z: number): [number, number, number] => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; };
    const WORN: WeatherMaps = { curvature: 0.85, cavity: 0.3, occlusion: 0.6, thickness: 0.3, facing: facing(0.3, 0.8, 0.5) };
    /** A node's mask over the whole picture, on the average. */
    const mean = (type: string, maps: WeatherMaps, extra: Record<string, unknown> = {}): number => {
        const params = withDefaults(type, extra);
        let sum = 0;
        for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) sum += WEATHERING_REFERENCES[type]((x + 0.5) / 24, (y + 0.5) / 24, maps, params, SEED);
        return sum / 576;
    };

    it('every node reads the model\'s maps, says what it does, and has its CPU twin', () => {
        expect(WEATHERING_NODES.map((node) => node.type).sort()).toEqual(Object.keys(WEATHERING_REFERENCES).sort());
        for (const definition of WEATHERING_NODES) {
            expect(MESH_READING_NODE_TYPES.has(definition.type), definition.type).toBe(true);
            expect(definition.category).toBe('Weathering');
            expect(definition.description.length, definition.type).toBeGreaterThan(40);
            expect(textureNodeDefinitionByType(definition.type), definition.type).toBe(definition);
        }
    });

    it('keeps a material made with stand-ins tiling, its noise repeating with the picture', () => {
        for (const type of Object.keys(WEATHERING_REFERENCES)) {
            for (const maps of [STAND_IN_MAPS, WORN]) {
                for (const extra of [{}, { scale: 7.4 }]) {
                    const params = withDefaults(type, extra);
                    expect(edgeGap((u, v) => WEATHERING_REFERENCES[type](u, v, maps, params, SEED)), `${type} ${JSON.stringify(extra)}`).toBeLessThan(1e-9);
                }
            }
        }
    });

    it('puts each kind of wear and grime where it belongs on the model', () => {
        // Edges wear and the wear spreads with the amount; a flat stand-in has no edges to wear.
        expect(mean('edgeWear', STAND_IN_MAPS)).toBe(0);
        expect(mean('edgeWear', WORN)).toBeGreaterThan(0.2);
        expect(mean('edgeWear', WORN, { amount: 0.8 })).toBeGreaterThan(mean('edgeWear', WORN, { amount: 0.3 }));
        // Dirt gathers in hidden corners and crevices.
        expect(mean('meshDirt', { ...STAND_IN_MAPS, occlusion: 0.2, cavity: 0.2 })).toBeGreaterThan(mean('meshDirt', STAND_IN_MAPS) + 0.3);
        // Dust settles on what faces up, not on what faces down.
        expect(mean('meshDust', STAND_IN_MAPS)).toBeGreaterThan(0.5);
        expect(mean('meshDust', { ...STAND_IN_MAPS, facing: [1, 0, 0] })).toBeLessThan(0.05);
        expect(mean('meshDust', { ...STAND_IN_MAPS, facing: [0, -1, 0] })).toBeLessThan(0.05);
        // The sun bleaches what faces it.
        const sun = facing(Math.cos(Math.PI / 3) * Math.cos(Math.PI / 6), Math.sin(Math.PI / 3), Math.cos(Math.PI / 3) * Math.sin(Math.PI / 6));
        expect(mean('sunBleach', { ...STAND_IN_MAPS, facing: sun })).toBeGreaterThan(mean('sunBleach', { ...STAND_IN_MAPS, facing: [-sun[0], -sun[1], -sun[2]] }) + 0.5);
        // Without a cavity map, crevices come from the hollow half of the curvature.
        expect(mean('meshDirt', { curvature: 0.1, occlusion: 1, facing: [0, 1, 0], thickness: 0.5 })).toBeGreaterThan(mean('meshDirt', STAND_IN_MAPS) + 0.2);
    });

    it('builds a mask from the weights given, levelled and turned round on request', () => {
        const only = { edges: 1, cavities: 0, hidden: 0, thin: 0, up: 0, down: 0, noise: 0, level: 0.5, contrast: 2 };
        const params = withDefaults('maskBuilder', only);
        expect(WEATHERING_REFERENCES.maskBuilder(0.3, 0.6, WORN, params, SEED)).toBeCloseTo(Math.min(1, Math.max(0, ((0.85 - 0.5) * 2 - 0.5) * 2 + 0.5)), 9);
        const inverted = withDefaults('maskBuilder', { ...only, invert: true });
        expect(WEATHERING_REFERENCES.maskBuilder(0.3, 0.6, WORN, inverted, SEED)).toBeCloseTo(1 - WEATHERING_REFERENCES.maskBuilder(0.3, 0.6, WORN, params, SEED), 9);
        // Thin parts count when asked.
        const thin = withDefaults('maskBuilder', { ...only, edges: 0, thin: 1 });
        expect(WEATHERING_REFERENCES.maskBuilder(0.3, 0.6, { ...WORN, thickness: 0.1 }, thin, SEED)).toBeGreaterThan(WEATHERING_REFERENCES.maskBuilder(0.3, 0.6, { ...WORN, thickness: 0.9 }, thin, SEED));
    });
});
