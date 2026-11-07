import { describe, expect, it } from 'vitest';
import { evenSpans, fitSegments, isLoop, offsetPath, pathLength, roundCorners, type Point } from '../../texturing/graph/curves';
import { createNode, normalizeTextureGraph } from '../../texturing/graph/document';
import { TextureGraphEvaluator } from '../../texturing/graph/evaluator';
import { wireFits } from '../../texturing/graph/material';
import { textureNodeDefinitionByType } from '../../texturing/graph/registry';
import type { CurvePaths, TexGraphLink, TexGraphNode } from '../../texturing/graph/types';

const square: Point[] = [[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75], [0.25, 0.25]];
const near = (a: Point, b: Point) => { expect(a[0]).toBeCloseTo(b[0], 6); expect(a[1]).toBeCloseTo(b[1], 6); };

describe('path tools', () => {
    it('move a path to its left (or right), mitring the corners and keeping a loop a loop', () => {
        // The square runs anticlockwise (u across, v up): its left is inside.
        const inset = offsetPath(square, true, 0.05);
        expect(isLoop(inset)).toBe(true);
        near(inset[0], [0.3, 0.3]);
        near(inset[2], [0.7, 0.7]);
        near(offsetPath(square, true, -0.05)[1], [0.8, 0.2]);
        // An open line moves square to itself, ends included.
        const line = offsetPath([[0.1, 0.5], [0.9, 0.5]], false, 0.1);
        near(line[0], [0.1, 0.6]);
        near(line[1], [0.9, 0.6]);
        // A hairpin's mitre stops at four times the distance.
        const hairpin = offsetPath([[0, 0], [1, 0.001], [0, 0.002]], false, 0.01);
        expect(Math.hypot(hairpin[1][0] - 1, hairpin[1][1] - 0.001)).toBeLessThanOrEqual(0.0400001);
    });

    it('round corners pass after pass, keep open ends, cut paths to even spans and fit what the shaders take', () => {
        const once = roundCorners(square, true, 1);
        expect(isLoop(once)).toBe(true);
        expect(once.length).toBe(9);
        near(once[0], [0.375, 0.25]);
        const open = roundCorners([[0, 0], [0.5, 0.5], [1, 0]], false, 2);
        near(open[0], [0, 0]);
        near(open[open.length - 1], [1, 0]);
        expect(Math.max(...open.map((point) => point[1]))).toBeLessThan(0.5);
        // The points stop doubling at the limit.
        expect(roundCorners(square, true, 6, 1, 40).length).toBeLessThanOrEqual(41);

        const even = evenSpans(square, 8);
        expect(even.length).toBe(9);
        expect(isLoop(even)).toBe(true);
        for (let i = 0; i < 8; i++) expect(Math.hypot(even[i + 1][0] - even[i][0], even[i + 1][1] - even[i][1])).toBeCloseTo(0.25, 6);

        const wiggly: Point[] = Array.from({ length: 3000 }, (_, i) => [i / 2999, 0.5 + 0.1 * Math.sin(i / 50)]);
        const fitted = fitSegments([wiggly, wiggly], 1000);
        expect(fitted.reduce((sum, path) => sum + path.length - 1, 0)).toBeLessThanOrEqual(1000);
        expect(pathLength(fitted[0])).toBeCloseTo(pathLength(wiggly), 2);
    });
});

describe('curve wires', () => {
    it('go only from a curve output into a curve input', () => {
        expect(wireFits('curve', { kind: 'curve' })).toBe(true);
        expect(wireFits('curve', { kind: 'gray' })).toBe(false);
        expect(wireFits('curve', { kind: 'any', material: true })).toBe(false);
        expect(wireFits('gray', { kind: 'curve' })).toBe(false);
        expect(wireFits('value', { kind: 'curve' })).toBe(false);
        const pins = (type: string) => {
            const definition = textureNodeDefinitionByType(type)!;
            return { in: definition.inputs.filter((port) => port.kind === 'curve').map((port) => port.key), out: definition.outputs.filter((port) => port.kind === 'curve').map((port) => port.key) };
        };
        expect(pins('maskToPaths').out).toEqual(['paths']);
        expect(pins('curve')).toEqual({ in: ['curve'], out: ['path'] });
        expect(pins('curveBridge').in).toEqual(['a', 'b']);
        for (const type of ['pathOffset', 'pathSmooth', 'pathResample']) expect(pins(type), type).toEqual({ in: ['in'], out: ['path'] });
        expect(pins('pathJoin')).toEqual({ in: ['a', 'b'], out: ['path'] });
        // Points a wired curve takes the place of say so, for the 2D view.
        expect(textureNodeDefinitionByType('curveBridge')!.params.filter((param) => param.replacedBy).map((param) => [param.key, param.replacedBy])).toEqual([['curveA', 'a'], ['curveB', 'b']]);
    });

    /** A GPU that draws nothing, reading back a white disc for Mask to paths to trace. */
    const fakeGpu = () => {
        const passes: Array<{ fragment: string; uniforms: Record<string, unknown> }> = [];
        const image = (width: number, height: number, kind = 'gray', precision = 8) => ({ target: {}, kind, precision, width, height, refs: 1 });
        const gpu = {
            maxSize: 4096,
            memory: { live: 0, idle: 0 },
            onRestored: () => () => undefined,
            image, constant: () => ({}), retain: (x: unknown) => x, release: () => undefined, clear: () => undefined,
            pass: async (_target: unknown, options: { fragment: string; uniforms?: Record<string, unknown> }) => { passes.push({ fragment: options.fragment, uniforms: options.uniforms ?? {} }); },
            readRgba8Later: async (target: { width: number; height: number }) => {
                const bytes = new Uint8Array(target.width * target.height * 4);
                for (let y = 0; y < target.height; y++) for (let x = 0; x < target.width; x++) {
                    const inside = Math.hypot((x + 0.5) / target.width - 0.5, (y + 0.5) / target.height - 0.5) < 0.25;
                    bytes.fill(inside ? 255 : 0, (y * target.width + x) * 4, (y * target.width + x) * 4 + 4);
                }
                return bytes;
            },
            readPixelLater: async () => null,
        };
        return { gpu, passes };
    };

    const graphOf = (nodes: TexGraphNode[], links: TexGraphLink[]) => normalizeTextureGraph({ version: 1, size: { w: 7, h: 7 }, seed: 0, parameters: [], nodes, links });
    const radiusOf = (paths: CurvePaths | undefined) => {
        const points = paths![0].points;
        return points.reduce((sum, point) => sum + Math.hypot(point[0] - 0.5, point[1] - 0.5), 0) / points.length;
    };

    it('carry a mask\'s outlines through the path tools to a Curve, a Bridge and a scatter', async () => {
        const { gpu, passes } = fakeGpu();
        const evaluator = new TextureGraphEvaluator(gpu as never, () => undefined, () => null);
        const graph = graphOf([
            { ...createNode('perlinNoise', 0, 0), id: 'mask' },
            { ...createNode('maskToPaths', 0, 0, { smoothness: 0 }), id: 'trace' },
            { ...createNode('pathOffset', 0, 0, { distance: 0.05, copies: 2, keep: true }), id: 'offset' },
            { ...createNode('pathSmooth', 0, 0, { passes: 2 }), id: 'smooth' },
            { ...createNode('pathSmooth', 0, 0), id: 'skipped', bypass: true },
            { ...createNode('curve', 0, 0), id: 'drawn' },
            { ...createNode('curve', 0, 0), id: 'own' },
            { ...createNode('pathJoin', 0, 0, { connect: true, close: true }), id: 'join' },
            { ...createNode('curveBridge', 0, 0, { steps: 16 }), id: 'bridge' },
            { ...createNode('curveScatter', 0, 0, { spacing: 0.05 }), id: 'scatter' },
        ], [
            { from: 'mask', fromOutput: 'out', to: 'trace', toInput: 'in' },
            { from: 'trace', fromOutput: 'paths', to: 'offset', toInput: 'in' },
            { from: 'offset', fromOutput: 'path', to: 'smooth', toInput: 'in' },
            { from: 'smooth', fromOutput: 'path', to: 'skipped', toInput: 'in' },
            { from: 'skipped', fromOutput: 'path', to: 'drawn', toInput: 'curve' },
            { from: 'trace', fromOutput: 'paths', to: 'join', toInput: 'a' },
            { from: 'own', fromOutput: 'path', to: 'join', toInput: 'b' },
            { from: 'own', fromOutput: 'path', to: 'bridge', toInput: 'a' },
            { from: 'trace', fromOutput: 'paths', to: 'scatter', toInput: 'curve' },
        ]);
        const states = await evaluator.evaluate({ graph, targets: ['drawn', 'join', 'bridge', 'scatter'] });
        for (const [id, state] of states) expect(state.error, id).toBeUndefined();

        // The disc's outline, one closed loop a quarter of the picture out from its middle.
        const traced = states.get('trace')!.curves!.paths;
        expect(traced).toHaveLength(1);
        expect(traced[0].closed).toBe(true);
        expect(radiusOf(traced)).toBeCloseTo(0.25, 1);
        // The original kept, then two rings a step further each way along the outline's left.
        const offset = states.get('offset')!.curves!.path;
        expect(offset).toHaveLength(3);
        const step = radiusOf([offset[1]]) - radiusOf([offset[0]]);
        expect(Math.abs(step)).toBeCloseTo(0.05, 2);
        expect(radiusOf([offset[2]]) - radiusOf([offset[0]])).toBeCloseTo(2 * step, 2);
        // Smoothed, then passed through a bypassed node as it is, into a Curve that draws it and gives it on.
        const smooth = states.get('smooth')!.curves!.path;
        expect(smooth[0].points.length).toBeGreaterThan(offset[0].points.length);
        expect(states.get('skipped')!.curves!.path).toBe(smooth);
        expect(states.get('drawn')!.curves!.path.map((path) => path.points.length)).toEqual(smooth.map((path) => path.points.length));
        expect(Object.keys(states.get('drawn')!.outputs)).toEqual(['out', 'fill', 'along']);
        // A Curve with nothing wired in gives its own points' curve.
        expect(states.get('own')!.curves!.path).toHaveLength(1);
        expect(states.get('own')!.curves!.path[0].closed).toBe(false);
        // Joined end to start into one closed path.
        const joined = states.get('join')!.curves!.path;
        expect(joined).toHaveLength(1);
        expect(joined[0].closed).toBe(true);
        expect(isLoop(joined[0].points)).toBe(true);
        expect(joined[0].points.length).toBe(traced[0].points.length - 1 + states.get('own')!.curves!.path[0].points.length + 1);
        // The Bridge drew its band from the wired curve (its second edge its own points): 16 quads.
        expect(passes.some((pass) => pass.uniforms.uQuads === 16)).toBe(true);
        // Copies along the traced loop: about its length over the spacing.
        const scatterPass = passes.find((pass) => typeof pass.uniforms.uStamps === 'number' && pass.fragment.includes('uGrayPattern'))!;
        expect(scatterPass.uniforms.uStamps).toBe(Math.round(pathLength(traced[0].points) / 0.05));
        evaluator.dispose();
    });

    it('give no paths from a node that failed, rather than the points placed on the node', async () => {
        const { gpu } = fakeGpu();
        const evaluator = new TextureGraphEvaluator(gpu as never, () => undefined, () => null);
        const graph = graphOf([
            { ...createNode('pathOffset', 0, 0), id: 'offset' },
            { ...createNode('curve', 0, 0), id: 'drawn' },
        ], [{ from: 'offset', fromOutput: 'path', to: 'drawn', toInput: 'curve' }]);
        const states = await evaluator.evaluate({ graph, targets: ['drawn'] });
        // Nothing wired into the offset: it gives no paths, and the Curve draws none.
        expect(states.get('offset')!.curves!.path).toEqual([]);
        expect(states.get('drawn')!.curves!.path).toEqual([]);
        evaluator.dispose();
    });
});
