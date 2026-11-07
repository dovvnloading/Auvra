import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
    FLIPBOOK_FRAMES, cookTimeStep, flipbookCell, flipbookFrameAt, flipbookFrameSize, flipbookGrid, frameTime, readAnimation, timeAt, untilNextStep,
} from '../../texturing/graph/animation';
import { compileFunction, createFunctionNode, FN_RESULT_TYPE, runFunction } from '../../texturing/graph/functionGraph';
import { createNode, normalizeTextureGraph } from '../../texturing/graph/document';
import { TextureGraphEvaluator } from '../../texturing/graph/evaluator';
import { graphAnimates, textureNodeDefinitionByType } from '../../texturing/graph/registry';
import { timeValues } from '../../texturing/graph/nodes/time';
import type { TextureGraph } from '../../texturing/graph/types';
import { materialGraphForTextures, rewriteMaterialPictures } from '../../texturing/materialOutput';
import { FLIPBOOK_FRAMES_NODE_TYPE } from '../../runtime/materials/materialNodes';
import { MaterialCookPlanner, cookAnimation, cookRequestFor, cookSignature } from '../../runtime/materials/materialCooking';
import type { MaterialAsset } from '../../runtime/materials/materialLibrary';

describe('the graph\'s time', () => {
    it('goes round its loop, and flipbooks fill their grids exactly', () => {
        expect(timeAt(9, 4)).toEqual({ seconds: 1, loop: 4, phase: 0.25 });
        expect(timeAt(-1, 4).seconds).toBe(3);
        for (const frames of FLIPBOOK_FRAMES) {
            const { columns, rows } = flipbookGrid(frames);
            expect(columns * rows, `${frames}`).toBe(frames);
            expect(columns).toBeGreaterThanOrEqual(rows);
        }
        expect(flipbookGrid(12)).toEqual({ columns: 4, rows: 3 });
        // Frames run along the rows from the top left.
        expect(flipbookCell(0, 4, 3)).toEqual([0, 2 / 3, 0.25, 1 / 3]);
        expect(flipbookCell(5, 4, 3)).toEqual([0.25, 1 / 3, 0.25, 1 / 3]);
        expect(frameTime(4, 16, 4)).toBe(1);
        expect(flipbookFrameAt(3.99, 16, 4)).toBe(15);
        expect(flipbookFrameAt(4.01, 16, 4)).toBe(0);
        // The whole flipbook is the pictures' size: 16 frames of 1024 are 256 each.
        expect(flipbookFrameSize({ w: 10, h: 10 }, 16)).toEqual({ w: 8, h: 8 });
        expect(readAnimation({ loop: -3, frames: 13, play: 'cook', rate: 1000 })).toEqual({ loop: 0.1, frames: 16, play: 'cook', rate: 60 });
    });

    it('steps a cooked animation round whole steps of its loop', () => {
        expect(cookTimeStep(0.3, 4, 2)).toBe(0);
        expect(cookTimeStep(0.6, 4, 2)).toBe(0.5);
        expect(cookTimeStep(4.6, 4, 2)).toBe(0.5);
        expect(cookTimeStep(3.99, 4, 2)).toBe(3.5);
        expect(untilNextStep(0.6, 4, 2)).toBeCloseTo(0.4, 9);
        // A loop not a whole number of steps long still comes round evenly.
        const steps = new Set(Array.from({ length: 300 }, (_, i) => cookTimeStep(i * 0.01, 3, 2)));
        expect(steps.size).toBe(6);
    });

    it('gives the Time node\'s values, and a function graph\'s Time on the CPU', () => {
        const values = timeValues(1, 0.25, 2);
        expect(values.phase).toBeCloseTo(0.5, 12);
        expect(values.circle[0]).toBeCloseTo(-1, 12);
        expect(values.out).toBe(1);
        const time = createFunctionNode('fnTime', 0, 0);
        const result = { ...createFunctionNode(FN_RESULT_TYPE, 0, 0), id: 'r' };
        const ir = compileFunction({ nodes: [{ ...time, id: 't' }, result], links: [{ from: 't', fromOutput: 'phase', to: 'r', toInput: 'value' }] }, { use: 'value' }).ir!;
        expect(runFunction(ir, { time: 1.5, phase: 0.375 })).toEqual([0.375]);
    });
});

/** A graph with a noise and a Pixel processor; `animated` gives the processor's function a Time node. */
const graphOf = (animated: boolean): TextureGraph => {
    const noise = { ...createNode('perlinNoise', 0, 0), id: 'noise' };
    const time = { ...createFunctionNode('fnTime', 0, 0), id: 't' };
    const result = { ...createFunctionNode(FN_RESULT_TYPE, 0, 0), id: 'r' };
    const fn = animated
        ? { nodes: [time, result], links: [{ from: 't', fromOutput: 'phase', to: 'r', toInput: 'value' }] }
        : { nodes: [result], links: [] };
    const processor = { ...createNode('pixelProcessor', 200, 0, { mode: 'graph', function: fn }), id: 'proc' };
    return normalizeTextureGraph({ version: 1, size: { w: 6, h: 6 }, seed: 1, nodes: [noise, processor], links: [], parameters: [], animation: { loop: 2, frames: 8, play: 'flipbook', rate: 4 } });
};

const signatures = (graph: TextureGraph, time: number): Map<string, string> => {
    const evaluator = new TextureGraphEvaluator({ maxSize: 4096, onRestored: () => () => undefined } as never, () => undefined, () => null);
    const prepared = (evaluator as unknown as { prepare(request: object): { info: Map<string, { signature: string }> } }).prepare({ graph, targets: graph.nodes.map((node) => node.id), time });
    return new Map([...prepared.info].map(([id, details]) => [id, details.signature]));
};

describe('animated texture graphs', () => {
    it('draw again only what reads the time as it changes, and keep their animation settings', () => {
        const graph = graphOf(true);
        expect(graph.animation).toEqual({ loop: 2, frames: 8, play: 'flipbook', rate: 4 });
        expect(graphAnimates(graph, () => undefined)).toBe(true);
        expect(graphAnimates(graphOf(false), () => undefined)).toBe(false);
        const early = signatures(graph, 0.25);
        const late = signatures(graph, 0.75);
        expect(late.get('proc')).not.toBe(early.get('proc'));
        expect(late.get('noise')).toBe(early.get('noise'));
        // Round the loop (2 seconds) is the same time.
        expect(signatures(graph, 2.25).get('proc')).toBe(early.get('proc'));
        // Nothing reads the time: nothing draws again.
        const still = graphOf(false);
        expect(signatures(still, 0.75).get('proc')).toBe(signatures(still, 0.25).get('proc'));
        expect(textureNodeDefinitionByType('time')?.readsTime?.({})).toBe(true);
    });

    it('play their baked flipbook through a Flipbook Frames node wired into every picture', () => {
        const flipbook = { frames: 12, columns: 4, rows: 3, loop: 2 };
        const graph = materialGraphForTextures({ baseColor: 'c', normal: 'n', orm: 'o' }, { flipbook });
        const node = graph.nodes.find((candidate) => candidate.type === FLIPBOOK_FRAMES_NODE_TYPE)!;
        expect(node.params).toMatchObject(flipbook);
        for (const id of ['baseColor', 'normal', 'orm']) expect(graph.links.some((link) => link.fromNode === node.id && link.toNode === id && link.toInput === 'uv'), id).toBe(true);
        // With height, the flipbook moves the parallax, which moves the rest.
        const withHeight = materialGraphForTextures({ baseColor: 'c', height: 'h' }, { flipbook });
        expect(withHeight.links.some((link) => link.fromNode === 'flipbook' && link.toNode === 'parallax')).toBe(true);
        // Making the pictures again: a flipbook kept updates its node; one taken away makes the graph again.
        const asset = { graph: rewriteMaterialPictures({ graph: materialGraphForTextures({}), pictures: {} }, { baseColor: 'c' }, { flipbook }).graph, pictures: { baseColor: 'c' } };
        const longer = rewriteMaterialPictures(asset, { baseColor: 'c2' }, { flipbook: { ...flipbook, loop: 5 } });
        expect(longer.graph.nodes.find((candidate) => candidate.type === FLIPBOOK_FRAMES_NODE_TYPE)?.params.loop).toBe(5);
        const still = rewriteMaterialPictures(asset, { baseColor: 'c3' }, { flipbook: null });
        expect(still.graph.nodes.some((candidate) => candidate.type === FLIPBOOK_FRAMES_NODE_TYPE)).toBe(false);
    });
});

/** A material whose texture graph animates, cooked as it plays (or as a flipbook). */
const animatedCrate = (play: 'cook' | 'flipbook'): MaterialAsset => ({
    id: 'crate',
    name: 'Crate',
    graph: materialGraphForTextures({ baseColor: 'baked' }),
    pictures: { baseColor: 'baked' },
    textureGraph: { graph: { nodes: [], links: [], size: { w: 8, h: 8 }, parameters: [], animation: { loop: 2, rate: 2, frames: 8, play } }, values: {}, bakeSize: 8, layout: 'engine' },
});

describe('animated graphs cooked by the game', () => {
    it('ask for the time step they are at, each step its own set', () => {
        const asset = animatedCrate('cook');
        expect(cookAnimation(asset)).toEqual({ loop: 2, rate: 2 });
        expect(cookAnimation(animatedCrate('flipbook'))).toBeNull();
        expect(cookRequestFor(asset, {}, 0.7).time).toBe(0.5);
        expect(cookRequestFor(asset, {}, 2.7).time).toBe(0.5);
        const at = (now: number) => cookSignature(cookRequestFor(asset, {}, now));
        expect(at(0.7)).toBe(at(2.6));
        expect(at(0.7)).not.toBe(at(1.2));
        // A flipbook (or a graph that does not animate) has no time: one set.
        expect(cookRequestFor(animatedCrate('flipbook'), {}, 0.7).time).toBeUndefined();
    });

    it('draw their uses again at each next step, once however many uses ask', async () => {
        let now = 0.2;
        const later: Array<{ ms: number; task: () => void }> = [];
        const host = { addTextureUrl: vi.fn(), releaseTexture: vi.fn(), rebindAsset: vi.fn() };
        const cooked: Array<number | undefined> = [];
        const planner = new MaterialCookPlanner(host, {
            cook: async (request) => { cooked.push(request.time); return { baseColor: new Blob(['frame']) }; },
        }, null, { nextFrame: (task) => setTimeout(task, 0), urlOf: () => 'blob:frame', clock: () => now, later: (ms, task) => later.push({ ms, task }) });
        const asset = animatedCrate('cook');
        const [a, b] = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
        planner.pictures(asset, {}, a);
        planner.pictures(asset, {}, b);
        expect(later.length).toBe(1);
        expect(later[0].ms).toBeGreaterThan(250);
        expect(later[0].ms).toBeLessThan(400);
        await planner.settled();
        expect(cooked).toEqual([0]);
        now = 0.6;
        later[0].task();
        expect(host.rebindAsset).toHaveBeenCalledWith('crate');
        planner.pictures(asset, {}, a);
        await planner.settled();
        expect(cooked).toEqual([0, 0.5]);
    });
});
