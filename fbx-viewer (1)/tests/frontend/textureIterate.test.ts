import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createNode, normalizeTextureGraph, readTextureGraph } from '../../texturing/graph/document';
import { MAX_PASSES, feedKeys, feedbackPairs, passCount, runPasses } from '../../texturing/graph/iterate';
import { TextureGraphEvaluator } from '../../texturing/graph/evaluator';
import { MATERIAL_CHANNELS, materialKey } from '../../texturing/graph/material';
import { createFunctionNode, FN_RESULT_TYPE } from '../../texturing/graph/functionGraph';
import { wireFits } from '../../texturing/graph/material';
import { nodeBindings, valuePinKey } from '../../texturing/graph/nodeKit';
import { INPUT_NODE_TYPE, ITERATE_NODE_TYPE, MATERIAL_INPUT_NODE_TYPE, MATERIAL_OUTPUT_NODE_TYPE, OUTPUT_NODE_TYPE } from '../../texturing/graph/nodes/io';
import { LEGACY_PIXEL_SETTINGS, PIXEL_PROCESSOR_TYPE, VALUE_PROCESSOR_TYPE, readNamedSettings, settingKeyFor } from '../../texturing/graph/nodes/processors';
import { textureNodeDefinition } from '../../texturing/graph/registry';
import { createTextureGraph } from '../../texturing/graph/document';
import type { TexGraphNode, TextureGraph } from '../../texturing/graph/types';

const noGraphs = () => undefined;

describe('Iterate', () => {
    const inner = (): TextureGraph => {
        const graph = createTextureGraph();
        const state = createNode(INPUT_NODE_TYPE, 0, 0, { name: 'State', kind: 'gray' });
        const mask = createNode(INPUT_NODE_TYPE, 0, 200, { name: 'mask', kind: 'gray' });
        const next = createNode(OUTPUT_NODE_TYPE, 400, 0, { channel: 'custom', name: 'state', kind: 'gray' });
        const extra = createNode(OUTPUT_NODE_TYPE, 400, 200, { channel: 'custom', name: 'Preview', kind: 'color' });
        return { ...graph, nodes: [state, mask, next, extra], links: [] };
    };

    it('feeds each Output into the Input of the same name, letter case aside', () => {
        const graph = inner();
        const pairs = feedbackPairs(graph);
        expect(pairs).toEqual([{ output: graph.nodes[2].id, input: 'State' }]);
        expect(feedbackPairs({ nodes: graph.nodes.filter((node) => node.type !== INPUT_NODE_TYPE) })).toEqual([]);
    });

    it('runs the set number of passes, each taking the last one\'s results, and gives back all but the last', async () => {
        const released: number[] = [];
        const seen: Array<{ pass: number; state: number | null; mask: number | null }> = [];
        let made = 0;
        const result = await runPasses<number>(4, { state: 1, mask: 7 }, [{ output: 'out', input: 'state' }], async (inputs, pass) => {
            seen.push({ pass, state: inputs.state, mask: inputs.mask });
            made++;
            return { out: (inputs.state ?? 0) * 2, side: 100 + pass };
        }, (value) => released.push(value));
        expect(made).toBe(4);
        // 1 -> 2 -> 4 -> 8 -> 16: each pass doubles what the last made; the mask goes in every pass as it is.
        expect(seen.map((step) => step.state)).toEqual([1, 2, 4, 8]);
        expect(seen.every((step) => step.mask === 7)).toBe(true);
        expect(seen.map((step) => step.pass)).toEqual([0, 1, 2, 3]);
        expect(result).toEqual({ out: 16, side: 103 });
        // Every pass's results but the last went back, once each.
        expect(released.sort((a, b) => a - b)).toEqual([2, 4, 8, 100, 101, 102]);
    });

    it('gives back what it holds when a pass fails', async () => {
        const released: number[] = [];
        await expect(runPasses<number>(5, { state: 1 }, [{ output: 'out', input: 'state' }], async (inputs, pass) => {
            if (pass === 2) throw new Error('broke');
            return { out: (inputs.state ?? 0) + 1 };
        }, (value) => released.push(value))).rejects.toThrow('broke');
        expect(released).toEqual([2, 3]);
    });

    it('keeps passes between one and the cap', () => {
        expect(passCount(0)).toBe(1);
        expect(passCount(12.4)).toBe(12);
        expect(passCount(10000)).toBe(MAX_PASSES);
        expect(passCount('nonsense')).toBe(1);
    });

    it('takes its pins from the graph it runs, and says what feeds back', () => {
        const graph = inner();
        const node: TexGraphNode = createNode(ITERATE_NODE_TYPE, 0, 0, { graph: 'g' });
        const definition = textureNodeDefinition(node, (id) => (id === 'g' ? { id: 'g', name: 'Erode', graph } : undefined))!;
        expect(definition.inputs.map((port) => port.key)).toEqual(['State', 'mask']);
        expect(definition.outputs.map((port) => port.label)).toEqual(['state', 'Preview']);
        expect(definition.description).toContain('state into State');
        expect(definition.params.find((param) => param.key === 'passes')?.max).toBe(MAX_PASSES);
        expect(textureNodeDefinition(createNode(ITERATE_NODE_TYPE, 0, 0), noGraphs)!.inputs).toEqual([]);
    });
});

describe('Iterate: whole materials, and only what a pass changes drawn again', () => {
    it('takes and gives whole materials, a Material output feeding the Material input of its name, every channel', () => {
        const graph = createTextureGraph();
        const input = createNode(MATERIAL_INPUT_NODE_TYPE, 0, 0, { name: 'Surface' });
        const output = createNode(MATERIAL_OUTPUT_NODE_TYPE, 400, 0, { name: 'surface' });
        const inner: TextureGraph = { ...graph, nodes: [input, output], links: [] };
        const pairs = feedbackPairs(inner);
        expect(pairs).toEqual([{ output: output.id, input: 'Surface', material: true }]);
        const keys = feedKeys(pairs);
        expect(keys.length).toBe(MATERIAL_CHANNELS.length);
        expect(keys[0]).toEqual({ output: materialKey(output.id, MATERIAL_CHANNELS[0]), input: materialKey('Surface', MATERIAL_CHANNELS[0]) });
        const node = createNode(ITERATE_NODE_TYPE, 0, 0, { graph: 'inner' });
        const definition = textureNodeDefinition(node, (id) => (id === 'inner' ? { id, name: 'Inner', graph: inner } : undefined))!;
        expect(definition.inputs.map((port) => [port.key, port.kind])).toEqual([['Surface', 'material']]);
        expect(definition.outputs.map((port) => [port.key, port.kind])).toEqual([[output.id, 'material']]);
    });

    const signaturesAt = (graph: TextureGraph, iteration: { index: number; count: number }, seed: number) => {
        const evaluator = new TextureGraphEvaluator({ maxSize: 4096, onRestored: () => () => undefined } as never, () => undefined, () => null);
        const prepared = (evaluator as unknown as { prepare(request: object): { info: Map<string, { signature: string }> } }).prepare({ graph, targets: graph.nodes.map((n) => n.id), iteration, seed });
        return new Map([...prepared.info].map(([id, details]) => [id, details.signature]));
    };

    it('draws again in a pass only what reads the pass, what follows a new seed, and what they reach', () => {
        const gradient = { ...createNode('gradient', 0, 0), id: 'gradient' };
        const noise = { ...createNode('perlinNoise', 0, 200), id: 'noise' };
        const levels = { ...createNode('levels', 200, 0), id: 'levels' };
        const pass = { ...createFunctionNode('fnPass', 0, 0), id: 'p' };
        const result = { ...createFunctionNode(FN_RESULT_TYPE, 0, 0), id: 'r' };
        const counter = { ...createNode(PIXEL_PROCESSOR_TYPE, 0, 400, { mode: 'graph', function: { nodes: [pass, result], links: [{ from: 'p', fromOutput: 'out', to: 'r', toInput: 'value' }] } }), id: 'counter' };
        const graph = normalizeTextureGraph({ ...createTextureGraph(), nodes: [gradient, noise, levels, counter], links: [{ from: 'gradient', fromOutput: 'out', to: 'levels', toInput: 'in' }] });
        // Same seed, another pass: only the processor reading the pass changes.
        const first = signaturesAt(graph, { index: 0, count: 4 }, 7);
        const second = signaturesAt(graph, { index: 1, count: 4 }, 7);
        expect(second.get('counter')).not.toBe(first.get('counter'));
        for (const id of ['gradient', 'noise', 'levels']) expect(second.get(id), id).toBe(first.get(id));
        // A new seed: the noise (which has a seed) changes; the gradient and its levels do not.
        const reseeded = signaturesAt(graph, { index: 1, count: 4 }, 8);
        expect(reseeded.get('noise')).not.toBe(second.get('noise'));
        expect(reseeded.get('gradient')).toBe(second.get('gradient'));
        expect(reseeded.get('levels')).toBe(second.get('levels'));
    });
});

describe('named settings and value pins', () => {
    it('keeps usable, unique names and the right shapes', () => {
        const settings = readNamedSettings([
            { key: 'amount', label: 'Amount', kind: 'float', default: '0.25', min: 0, max: 2 },
            { key: 'amount', label: 'Again', kind: 'float', default: 1 },
            { key: 'code', label: 'Taken by the node', kind: 'float', default: 1 },
            { key: '9lives', label: 'Bad name', kind: 'float', default: 1 },
            { key: 'tint', kind: 'color', default: 0.5 },
            { key: 'flip', kind: 'bool', default: 1 },
        ]);
        expect(settings.map((setting) => setting.key)).toEqual(['amount', 'tint', 'flip']);
        expect(settings[0]).toMatchObject({ default: 0.25, min: 0, max: 2 });
        expect(settings[1]).toMatchObject({ label: 'tint', default: [0.5, 0.5, 0.5, 1] });
        expect(settings[2].default).toBe(true);
        expect(settingKeyFor('Edge wear', ['edgeWear'])).toBe('edgeWear2');
        expect(settingKeyFor('Output', [])).toBe('output2');
    });

    it('are settings of the processor, which can be exposed like any other', () => {
        const node: TexGraphNode = createNode(PIXEL_PROCESSOR_TYPE, 0, 0, { settings: [{ key: 'amount', label: 'Amount', kind: 'float', default: 0.5, min: 0, max: 1 }], amount: 0.5 });
        const definition = textureNodeDefinition(node, noGraphs)!;
        expect(definition.params.map((param) => param.key)).toContain('amount');
        expect(textureNodeDefinition({ ...node }, noGraphs)).toBe(definition);
    });

    it('keeps an older Pixel processor working: its code and its four numbers and tint', () => {
        const graph = createTextureGraph();
        const old = { id: 'p', type: PIXEL_PROCESSOR_TYPE, x: 0, y: 0, params: { code: 'outColor = vec4(p_x);', x: 0.3, tint: [1, 0, 0, 1] } };
        const read = readTextureGraph({ ...graph, nodes: [...graph.nodes, old] }).graph.nodes.find((node) => node.id === 'p')!;
        expect(read.params.mode).toBe('code');
        expect(readNamedSettings(read.params.settings).map((setting) => setting.key)).toEqual(LEGACY_PIXEL_SETTINGS.map((setting) => setting.key));
        expect(read.params.x).toBe(0.3);
        // A new one starts with a function graph.
        expect(createNode(PIXEL_PROCESSOR_TYPE, 0, 0).params.mode).toBe('graph');
    });

    it('shows a setting as a pin that follows a value, read on the GPU', () => {
        const node: TexGraphNode = { ...createNode('levels', 0, 0), valuePins: ['mid', 'nonsense'] };
        const definition = textureNodeDefinition(node, noGraphs)!;
        const pin = definition.inputs.find((port) => port.key === valuePinKey('mid'));
        expect(pin?.kind).toBe('value');
        expect(definition.inputs.filter((port) => port.kind === 'value')).toHaveLength(1);
        const value = { width: 1, height: 1 } as never;
        const bound = nodeBindings(definition, {
            input: (key) => (key === valuePinKey('mid') ? value : null), params: { mid: 0.5 }, seed: 0.5, texture: () => null, tiling: [true, true],
        }, () => new THREE.Texture());
        expect(bound.declarations).toContain('uniform sampler2D v_mid;');
        expect(bound.declarations).toMatch(/#define p_mid \(clamp\(texelFetch\(v_mid, ivec2\(0\), 0\)\.x, [\d.]+, [\d.]+\)\)/);
        expect(bound.declarations).not.toContain('uniform float p_mid;');
        expect(bound.inputs.v_mid).toBe(value);
        // Nothing wired in: the setting's own value.
        const unwired = nodeBindings(definition, { input: () => null, params: { mid: 0.5 }, seed: 0.5, texture: () => null, tiling: [true, true] }, () => new THREE.Texture());
        expect(unwired.declarations).toContain('uniform float p_mid;');
        // Pins survive saving.
        const graph = createTextureGraph();
        expect(normalizeTextureGraph({ ...graph, nodes: [...graph.nodes, node] }).nodes.at(-1)?.valuePins).toEqual(['mid', 'nonsense']);
    });

    it('lets a value into a setting pin or a picture input, and nothing else into a setting pin', () => {
        expect(wireFits('value', { kind: 'value' })).toBe(true);
        expect(wireFits('gray', { kind: 'value' })).toBe(false);
        expect(wireFits('material', { kind: 'value' })).toBe(false);
        expect(wireFits('value', { kind: 'color' })).toBe(true);
        expect(wireFits('value', { kind: 'material' })).toBe(false);
        const processor = textureNodeDefinition(createNode(VALUE_PROCESSOR_TYPE, 0, 0), noGraphs)!;
        expect(processor.outputs).toEqual([{ key: 'out', label: 'Value', kind: 'value' }]);
        expect(processor.settingsInShader).toBe(true);
    });
});
