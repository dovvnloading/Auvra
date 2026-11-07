import { describe, expect, it } from 'vitest';
import { createTextureGraph, formulaScope, readTextureGraph, resolveNodeParams } from '../../texturing/graph/document';
import { textureNodeDefinition } from '../../texturing/graph/registry';
import { captureMaterialGraph } from '../../texturing/paint/captureMaterial';
import { PHOTO_PARAMETERS, baseColourSource, isPhotoGraph, photoMaterialGraph, photoMaterialName, withAiMaps } from '../../texturing/paint/photoMaterial';

describe('photo to material', () => {
    it('builds a graph of ordinary nodes, every wire to a pin that is there', () => {
        const graph = photoMaterialGraph('photo-texture', 10);
        const types = graph.nodes.map((node) => node.type);
        for (const type of ['bitmap', 'makeTile', 'lightingRemoval', 'colourEqualizer', 'grayscale', 'blur', 'highpass', 'normalFromHeight', 'aoFromHeight', 'curves', 'levels', 'colorToMask']) expect(types).toContain(type);
        expect(graph.nodes.find((node) => node.type === 'bitmap')!.params.texture).toBe('photo-texture');
        for (const link of graph.links) {
            const from = textureNodeDefinition(graph.nodes.find((node) => node.id === link.from)!, () => undefined)!;
            const to = textureNodeDefinition(graph.nodes.find((node) => node.id === link.to)!, () => undefined)!;
            expect(from.outputs.map((port) => port.key)).toContain(link.fromOutput);
            expect(to.inputs.map((port) => port.key)).toContain(link.toInput);
        }
        // An output for every channel a material draws with.
        expect(graph.nodes.filter((node) => node.type === 'output').map((node) => node.params.channel).sort()).toEqual(['ambientOcclusion', 'baseColor', 'height', 'metallic', 'normal', 'roughness']);
        // Occlusion and the shading taken out come from the large-scale height; the height output from the detailed one, and
        // the normal from the detailed one lightly smoothed.
        const named = (name: string) => graph.nodes.find((node) => node.name === name)!;
        const into = (node: { id: string }, input = 'in') => graph.nodes.find((each) => each.id === graph.links.find((link) => link.to === node.id && link.toInput === input)?.from)?.name;
        expect(into(named('Occlusion'))).toBe('Large-scale height');
        expect(into(named('Lighting removed'), 'height')).toBe('Large-scale height');
        expect(into(named('Normal'))).toBe('Smoothed height');
        expect(into(named('Smoothed height'))).toBe('Height');
        expect(into(graph.nodes.find((node) => node.type === 'output' && node.params.channel === 'height')!)).toBe('Height');
        // Read back as the graph editor reads it, nothing is lost.
        const back = readTextureGraph(JSON.parse(JSON.stringify(graph)));
        expect(back.problems).toEqual([]);
        expect(back.graph.nodes.length).toBe(graph.nodes.length);
        expect(back.graph.links.length).toBe(graph.links.length);
    });

    it('sets its steps from a Strength row of parameters, by link or formula', () => {
        const graph = photoMaterialGraph('photo', 10);
        expect(graph.groups?.map((group) => group.name)).toEqual(['Strength', 'Metal']);
        expect(PHOTO_PARAMETERS.filter((parameter) => parameter.group === 'Strength').map((parameter) => parameter.name)).toEqual(['tileWidth', 'lighting', 'depth', 'invertHeight', 'roughLow', 'roughHigh']);
        const values = { tileWidth: 0.3, lighting: 0.5, depth: 0.5, invertHeight: true, roughLow: 0.2, roughHigh: 0.9, metalColour: [1, 0.8, 0.2, 1], metalRange: 0.25 };
        const scope = formulaScope(graph, values, 1024, 1024);
        const settings = (type: string) => {
            const node = graph.nodes.find((each) => each.type === type)!;
            const problems: string[] = [];
            const resolved = resolveNodeParams(textureNodeDefinition(node, () => undefined)!, node, values, scope, problems);
            expect(problems).toEqual([]);
            return resolved;
        };
        expect(settings('makeTile').width).toBe(0.3);
        // Half as much occlusion as shading is taken out: the occlusion is a soft one.
        expect(settings('lightingRemoval')).toMatchObject({ occlusionAmount: 0.25, shadingAmount: 0.5, depth: expect.closeTo(0.03, 6) });
        // A strength of a few: slopes are per metre of the graph's size in the world.
        expect(settings('normalFromHeight').intensity).toBeCloseTo(3);
        expect(graph.nodes.filter((node) => node.type === 'levels').map((node) => resolveNodeParams(textureNodeDefinition(node, () => undefined)!, node, values, scope)).map((resolved) => [resolved.outLow, resolved.outHigh])).toEqual([[1, 0], [0.2, 0.9]]);
        expect(settings('colorToMask')).toMatchObject({ color: [1, 0.8, 0.2, 1], range: 0.25 });
    });

    it('takes AI maps in beside its own, mixed by a parameter, and replaces them when given again', () => {
        const graph = photoMaterialGraph('photo', 10);
        expect(isPhotoGraph(graph)).toBe(true);
        expect(isPhotoGraph(captureMaterialGraph({ colour: 'c', normal: 'n', height: 'h' }))).toBe(true);
        expect(isPhotoGraph(createTextureGraph())).toBe(false);
        // What is sent: the tiled colour with its lighting taken out.
        expect(baseColourSource(graph)?.name).toBe('Colour evened out');
        const refined = withAiMaps(graph, [{ role: 'normal', texture: 'ai-n' }, { role: 'roughness', texture: 'ai-r' }, { role: 'metalness', texture: 'ai-m' }]);
        expect(refined.parameters.find((parameter) => parameter.name === 'aiMix')?.default).toBe(0.5);
        expect(refined.groups?.map((group) => group.name)).toContain('AI maps');
        const intoOutput = (channel: string) => {
            const output = refined.nodes.find((node) => node.type === 'output' && node.params.channel === channel)!;
            return refined.nodes.find((node) => node.id === refined.links.find((link) => link.to === output.id)!.from)!;
        };
        expect(intoOutput('roughness').name).toBe("Roughness with the AI's");
        expect(intoOutput('metallic').name).toBe("Metallic with the AI's");
        expect(intoOutput('normal').type).toBe('normalAdjust');
        // The graph's own roughness is still there, under the mix.
        const mix = intoOutput('roughness');
        const under = refined.links.find((link) => link.to === mix.id && link.toInput === 'background')!;
        expect(refined.nodes.find((node) => node.id === under.from)!.name).toBe('Roughness range');
        expect(mix.params.opacity).toEqual({ $bind: 'aiMix' });
        for (const link of refined.links) {
            const from = textureNodeDefinition(refined.nodes.find((node) => node.id === link.from)!, () => undefined)!;
            const to = textureNodeDefinition(refined.nodes.find((node) => node.id === link.to)!, () => undefined)!;
            expect(from.outputs.map((port) => port.key)).toContain(link.fromOutput);
            expect(to.inputs.map((port) => port.key)).toContain(link.toInput);
        }
        expect(readTextureGraph(JSON.parse(JSON.stringify(refined))).problems).toEqual([]);
        // Given again: the same nodes, new pictures. The graph it came from is untouched.
        const again = withAiMaps(refined, [{ role: 'normal', texture: 'ai-n2' }]);
        expect(again.nodes.length).toBe(refined.nodes.length);
        expect(again.nodes.find((node) => node.name === 'AI normal')!.params.texture).toBe('ai-n2');
        expect(graph.nodes.some((node) => node.name?.startsWith('AI '))).toBe(false);
    });

    it('names the material after the photo', () => {
        expect(photoMaterialName('rusty_metal_02_diff_2k.jpg')).toBe('Rusty metal 02 diff 2k');
        expect(photoMaterialName('.png')).toBe('Photo');
    });
});
