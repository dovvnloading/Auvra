import { describe, expect, it } from 'vitest';
import { graphContentKey } from '../../texturing/graph/document';
import { textureNodeDefinition } from '../../texturing/graph/registry';
import { createPaintDocument, newFillLayer, newFolder, newPaintLayer, type PaintDocument } from '../../texturing/paint/paintTypes';
import { PAINT_STACK_NODE, PAINT_STACK_NODE_TYPE, paintStackEntries, paintStackEntry, stackLayers } from '../../texturing/paint/stackNode';

const painted = (): PaintDocument => {
    const document = createPaintDocument('model', ['Body'], 10);
    const grime = newFolder('Grime', [newPaintLayer(document, 'Streaks')]);
    document.layers = [newFillLayer(document, 'Base', { baseColor: { kind: 'colour', value: [0.5, 0.2, 0.1] } }), grime];
    return document;
};

describe('paint stacks as graph nodes', () => {
    it('are offered to graphs as a graph each, and one per folder, with an output per channel', () => {
        const document = painted();
        const asset = { id: 'helmet', name: 'Helmet body', paint: document as unknown as Record<string, unknown> };
        const entries = paintStackEntries([asset, { id: 'plain', name: 'Plain' }]);
        const folder = document.layers[1];
        expect(entries.map((entry) => entry.id)).toEqual(['paint:helmet', `paint:helmet:${folder.id}`]);
        expect(entries[1].name).toBe('Helmet body: Grime (paint folder)');
        const graph = entries[0].graph;
        const node = graph.nodes.find((each) => each.type === PAINT_STACK_NODE_TYPE)!;
        expect(node.params).toMatchObject({ asset: 'helmet', folder: '' });
        // Each channel the set paints comes out of an Output of its own.
        expect(graph.nodes.filter((each) => each.type === 'output').map((each) => each.params.channel)).toEqual(document.channels.filter((channel) => PAINT_STACK_NODE.outputs.some((port) => port.key === channel)));
        expect(graph.links.every((link) => link.from === node.id && link.fromOutput === graph.nodes.find((each) => each.id === link.to)!.params.channel)).toBe(true);
        expect(paintStackEntry(`paint:helmet:${folder.id}`, (id) => (id === 'helmet' ? asset : undefined))?.graph.nodes[0].params.folder).toBe(folder.id);
        expect(paintStackEntry('graph-asset', () => asset)).toBeUndefined();
    });

    it('draw again when the painting changes: the used graph carries its revision', () => {
        const document = painted();
        const before = paintStackEntries([{ id: 'helmet', name: 'Helmet', paint: document as unknown as Record<string, unknown> }])[0].graph;
        const changed = { ...document, layers: [...document.layers, newPaintLayer(document, 'Scratches')] };
        const after = paintStackEntries([{ id: 'helmet', name: 'Helmet', paint: changed as unknown as Record<string, unknown> }])[0].graph;
        expect(graphContentKey(after, () => undefined, () => true)).not.toBe(graphContentKey(before, () => undefined, () => true));
    });

    it('put a folder together on its own, and are a node the graph knows', () => {
        const document = painted();
        expect(stackLayers(document, '')).toBe(document.layers);
        expect(stackLayers(document, document.layers[1].id)).toEqual([document.layers[1]]);
        expect(stackLayers(document, 'gone')).toBeNull();
        expect(textureNodeDefinition({ id: 'n', type: PAINT_STACK_NODE_TYPE, x: 0, y: 0, params: {} }, () => undefined)).toBe(PAINT_STACK_NODE);
    });
});
