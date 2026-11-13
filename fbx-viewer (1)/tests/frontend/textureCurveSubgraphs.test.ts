import { describe, expect, it } from 'vitest';
import { createNode, normalizeTextureGraph } from '../../texturing/graph/document';
import { TextureGraphEvaluator } from '../../texturing/graph/evaluator';
import { feedbackPairs, feedKeys } from '../../texturing/graph/iterate';
import { wireFits } from '../../texturing/graph/material';
import { textureNodeDefinition, textureNodeDefinitionByType } from '../../texturing/graph/registry';
import type { CurvePaths, TexGraphLink, TexGraphNode, TextureGraph } from '../../texturing/graph/types';

const graph = (nodes: TexGraphNode[], links: TexGraphLink[]): TextureGraph =>
    normalizeTextureGraph({ version: 1, size: { w: 7, h: 7 }, seed: 0, parameters: [], nodes, links });

const node = (type: string, id: string, params: Record<string, unknown> = {}): TexGraphNode =>
    { return { ...createNode(type, 0, 0, params), id }; };

const link = (from: string, fromOutput: string, to: string, toInput: string): TexGraphLink =>
    ({ from, fromOutput, to, toInput });

const pathsAt = (y: number): CurvePaths => [
    { points: [[0.1, y], [0.9, y]], closed: false },
];

/** The CPU path pipeline can be tested without a real graphics context. */
const fakeGpu = () => ({
    maxSize: 4096,
    memory: { live: 0, idle: 0 },
    onRestored: () => () => undefined,
    image: (width: number, height: number, kind = 'gray', precision = 8) => ({ target: {}, width, height, kind, precision }),
    constant: () => ({}),
    retain: <T>(image: T) => image,
    release: () => undefined,
    clear: () => undefined,
    pass: async () => undefined,
    readPixelLater: async () => null,
});

/** Straight line offset: its direction (left of +x) is toward +y. */
const averageY = (paths: CurvePaths): number =>
    paths[0].points.reduce((total, point) => total + point[1], 0) / paths[0].points.length;

const innerGraph = () => graph([
    node('curveInput', 'enter', { name: 'Track' }),
    node('pathOffset', 'offset', { distance: 0.04, copies: 1, keep: false }),
    node('curveOutput', 'leave', { name: 'Track' }),
], [
    link('enter', 'path', 'offset', 'in'),
    link('offset', 'path', 'leave', 'in'),
]);

describe('curve graph boundaries', () => {
    it('exposes only curve-to-curve pins and keeps output pin IDs stable through renames', () => {
        const curveIn = textureNodeDefinitionByType('curveInput')!;
        const curveOut = textureNodeDefinitionByType('curveOutput')!;
        expect(curveIn.outputs).toMatchObject([{ key: 'path', kind: 'curve' }]);
        expect(curveOut.inputs).toMatchObject([{ key: 'in', kind: 'curve' }]);
        expect(wireFits(curveIn.outputs[0].kind, curveOut.inputs[0])).toBe(true);
        expect(wireFits('gray', curveOut.inputs[0])).toBe(false);
        expect(wireFits('curve', { kind: 'color' })).toBe(false);

        const source = innerGraph();
        const resolve = (id: string) => id === 'inner' ? { id, name: 'Inner paths', graph: source } : undefined;
        const ref = node('subgraph', 'sub', { graph: 'inner' });
        const definition = textureNodeDefinition(ref, resolve)!;
        expect(definition.inputs).toMatchObject([{ key: 'Track', kind: 'curve' }]);
        expect(definition.outputs).toMatchObject([{ key: 'leave', kind: 'curve' }]);

        const renamed = graph(source.nodes.map((item) => item.id === 'leave'
            ? { ...item, params: { ...item.params, name: 'New label' } } : item), source.links);
        const renamedDef = textureNodeDefinition(ref, (id) => id === 'inner' ? { id, name: 'Inner paths', graph: renamed } : undefined)!;
        expect(renamedDef.outputs).toMatchObject([{ key: 'leave', label: 'New label', kind: 'curve' }]);
    });

    it('passes a curve through a nested graph and preserves empty missing inputs', async () => {
        const source = innerGraph();
        const resolve = (id: string) => id === 'inner' ? { id, name: 'Inner paths', graph: source } : undefined;
        const gpu = fakeGpu();
        const evaluator = new TextureGraphEvaluator(gpu as never, resolve, () => null);
        const outer = graph([
            node('curve', 'drawn', { points: [[0.1, 0.5], [0.9, 0.5]], closed: false }),
            node('subgraph', 'sub', { graph: 'inner' }),
            node('pathSmooth', 'after', { passes: 1 }),
            node('subgraph', 'empty', { graph: 'inner' }),
        ], [
            link('drawn', 'path', 'sub', 'Track'),
            link('sub', 'leave', 'after', 'in'),
        ]);
        const states = await evaluator.evaluate({ graph: outer, targets: ['after', 'empty'] });
        for (const [id, state] of states) expect(state.error, id).toBeUndefined();
        const supplied = states.get('sub')!.curves!.leave;
        expect(supplied).toHaveLength(1);
        expect(averageY(supplied)).toBeCloseTo(0.54, 5);
        expect(states.get('after')!.curves!.path).toHaveLength(1);
        expect(averageY(states.get('after')!.curves!.path)).toBeCloseTo(0.54, 5);
        expect(states.get('empty')!.curves!.leave).toEqual([]);
        evaluator.dispose();
    });

    it('invalidates nested CPU curve inputs only when their coordinates change', async () => {
        const source = innerGraph();
        const gpu = fakeGpu();
        const evaluator = new TextureGraphEvaluator(gpu as never, () => undefined, () => null);
        const first = await evaluator.evaluate({ graph: source, targets: ['leave'], externalCurves: { Track: pathsAt(0.2) } });
        const initial = first.get('leave')!;
        expect(initial.error).toBeUndefined();
        expect(averageY(initial.curves!.path)).toBeCloseTo(0.24, 5);
        const identical = await evaluator.evaluate({ graph: source, targets: ['leave'], externalCurves: { Track: pathsAt(0.2) } });
        expect(identical.get('leave')).toBe(initial);
        const changed = await evaluator.evaluate({ graph: source, targets: ['leave'], externalCurves: { Track: pathsAt(0.7) } });
        expect(changed.get('leave')).not.toBe(initial);
        expect(averageY(changed.get('leave')!.curves!.path)).toBeCloseTo(0.74, 5);
        const missing = await evaluator.evaluate({ graph: source, targets: ['leave'], externalCurves: {} });
        expect(missing.get('leave')!.curves!.path).toEqual([]);
        evaluator.dispose();
    });

    it('runs Iterate feedback on paths, keeping them separate from GPU image ownership', async () => {
        const source = innerGraph();
        const pairs = feedbackPairs(source);
        expect(pairs).toEqual([{ output: 'leave', input: 'Track', curve: true }]);
        expect(feedKeys(pairs)).toEqual([]);
        const resolve = (id: string) => id === 'inner' ? { id, name: 'Inner paths', graph: source } : undefined;
        const iter = node('iterate', 'iter', { graph: 'inner', passes: 3, newSeed: false });
        const definition = textureNodeDefinition(iter, resolve)!;
        expect(definition.inputs).toMatchObject([{ key: 'Track', kind: 'curve' }]);
        expect(definition.outputs).toMatchObject([{ key: 'leave', kind: 'curve' }]);

        const outer = graph([
            node('curve', 'drawn', { points: [[0.1, 0.2], [0.9, 0.2]], closed: false }),
            iter,
        ], [link('drawn', 'path', 'iter', 'Track')]);
        const gpu = fakeGpu();
        const evaluator = new TextureGraphEvaluator(gpu as never, resolve, () => null);
        const states = await evaluator.evaluate({ graph: outer, targets: ['iter'] });
        for (const [id, state] of states) expect(state.error, id).toBeUndefined();
        expect(states.get('iter')!.curves!.leave).toHaveLength(1);
        expect(averageY(states.get('iter')!.curves!.leave)).toBeCloseTo(0.32, 5);
        expect(states.get('iter')!.outputs).toEqual({});
        evaluator.dispose();
    });
});
