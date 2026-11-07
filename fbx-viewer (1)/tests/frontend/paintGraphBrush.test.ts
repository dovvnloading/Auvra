import { describe, expect, it } from 'vitest';
import { createTextureGraph } from '../../texturing/graph/document';
import { applyPreset, presetFrom, readPresets } from '../../texturing/paint/brushLibrary';
import { readGraphStamp, stampOutputs, stampSize } from '../../texturing/paint/graphStamps';
import { DEFAULT_BRUSH } from '../../texturing/paint/strokes';

describe('graphs as brushes', () => {
    it('stamp one of a graph\'s outputs, named as the graph names them', () => {
        const graph = createTextureGraph();
        const resolve = (id: string) => (id === 'noise' ? { id, name: 'Noise', graph } : undefined);
        const outputs = stampOutputs(resolve, 'noise');
        expect(outputs.length).toBe(graph.nodes.filter((node) => node.type === 'output').length);
        expect(outputs.map((output) => output.label)).toContain('Base colour');
        expect(stampOutputs(resolve, 'gone')).toEqual([]);
        // Drawn at the graph's size, between 64 and 1024 across.
        expect([stampSize(12), stampSize(9), stampSize(3)]).toEqual([10, 9, 6]);
    });

    it('keep the graph, output and values with the brush, and read them back safely', () => {
        const brush = { ...DEFAULT_BRUSH, shape: 'graph' as const, graphStamp: { graphId: 'noise', output: 'out1', values: { scale: 3 } } };
        const back = readPresets(JSON.parse(JSON.stringify([presetFrom(brush, 'Noise stamp')])))[0];
        expect(back.settings.shape).toBe('graph');
        expect(back.settings.graphStamp).toEqual(brush.graphStamp);
        expect(applyPreset(DEFAULT_BRUSH, back).graphStamp).toEqual(brush.graphStamp);
        expect(readGraphStamp({ graphId: '', output: 'x' })).toBeNull();
        // Laying its colour is kept with it, and only a true value turns it on.
        expect(readGraphStamp({ graphId: 'g', colour: true })?.colour).toBe(true);
        expect(readGraphStamp({ graphId: 'g', colour: 'yes' })?.colour).toBeUndefined();
        expect(readGraphStamp({ graphId: 'g', values: [1, 2] })).toEqual({ graphId: 'g', output: '', values: {} });
    });
});
