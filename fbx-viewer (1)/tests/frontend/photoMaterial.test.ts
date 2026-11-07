import { describe, expect, it } from 'vitest';
import { formulaScope, readTextureGraph, resolveNodeParams } from '../../texturing/graph/document';
import { textureNodeDefinition } from '../../texturing/graph/registry';
import { PHOTO_PARAMETERS, photoMaterialGraph, photoMaterialName } from '../../texturing/paint/photoMaterial';

describe('photo to material', () => {
    it('builds a graph of ordinary nodes, every wire to a pin that is there', () => {
        const graph = photoMaterialGraph('photo-texture', 10);
        const types = graph.nodes.map((node) => node.type);
        for (const type of ['bitmap', 'makeTile', 'lightingRemoval', 'colourEqualizer', 'grayscale', 'highpass', 'normalFromHeight', 'aoFromHeight', 'curves', 'levels', 'colorToMask']) expect(types).toContain(type);
        expect(graph.nodes.find((node) => node.type === 'bitmap')!.params.texture).toBe('photo-texture');
        for (const link of graph.links) {
            const from = textureNodeDefinition(graph.nodes.find((node) => node.id === link.from)!, () => undefined)!;
            const to = textureNodeDefinition(graph.nodes.find((node) => node.id === link.to)!, () => undefined)!;
            expect(from.outputs.map((port) => port.key)).toContain(link.fromOutput);
            expect(to.inputs.map((port) => port.key)).toContain(link.toInput);
        }
        // An output for every channel a material draws with.
        expect(graph.nodes.filter((node) => node.type === 'output').map((node) => node.params.channel).sort()).toEqual(['ambientOcclusion', 'baseColor', 'height', 'metallic', 'normal', 'roughness']);
        // Read back as the graph editor reads it, nothing is lost.
        const back = readTextureGraph(JSON.parse(JSON.stringify(graph)));
        expect(back.problems).toEqual([]);
        expect(back.graph.nodes.length).toBe(graph.nodes.length);
        expect(back.graph.links.length).toBe(graph.links.length);
    });

    it('sets its steps from a Strength row of parameters, by link or formula', () => {
        const graph = photoMaterialGraph('photo', 10);
        expect(graph.groups?.map((group) => group.name)).toEqual(['Strength', 'Metal']);
        expect(PHOTO_PARAMETERS.filter((parameter) => parameter.group === 'Strength').map((parameter) => parameter.name)).toEqual(['tileWidth', 'lighting', 'depth', 'roughLow', 'roughHigh']);
        const values = { tileWidth: 0.3, lighting: 0.5, depth: 0.5, roughLow: 0.2, roughHigh: 0.9, metalColour: [1, 0.8, 0.2, 1], metalRange: 0.25 };
        const scope = formulaScope(graph, values, 1024, 1024);
        const settings = (type: string) => {
            const node = graph.nodes.find((each) => each.type === type)!;
            const problems: string[] = [];
            const resolved = resolveNodeParams(textureNodeDefinition(node, () => undefined)!, node, values, scope, problems);
            expect(problems).toEqual([]);
            return resolved;
        };
        expect(settings('makeTile').width).toBe(0.3);
        expect(settings('lightingRemoval')).toMatchObject({ occlusionAmount: 0.5, shadingAmount: 0.5, depth: expect.closeTo(0.055, 6) });
        expect(settings('normalFromHeight').intensity).toBeCloseTo(8);
        expect(settings('levels')).toMatchObject({ outLow: 0.2, outHigh: 0.9 });
        expect(settings('colorToMask')).toMatchObject({ color: [1, 0.8, 0.2, 1], range: 0.25 });
    });

    it('names the material after the photo', () => {
        expect(photoMaterialName('rusty_metal_02_diff_2k.jpg')).toBe('Rusty metal 02 diff 2k');
        expect(photoMaterialName('.png')).toBe('Photo');
    });
});
