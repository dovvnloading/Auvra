import { describe, expect, it } from 'vitest';
import { evaluateExpression, expressionError } from '../../texturing/graph/expressions';
import { createTextureGraph, normalizeTextureGraph, parameterValues, formulaScope, resolveNodeParams, wouldCycle, graphTextureIds } from '../../texturing/graph/document';
import { sampleCurve } from '../../texturing/graph/nodeKit';
import { labelIslands } from '../../texturing/graph/nodes/distance';
import { TEXTURE_NODE_DEFINITIONS, textureNodeDefinitionByType } from '../../texturing/graph/registry';
import { bakeSignature, readStoredGraph } from '../../texturing/graph/stored';
import { crc32 } from '../../texturing/zip';
import { materialAssetDocument, readMaterialAsset, withoutAssetTexture } from '../../runtime/materials/materialLibrary';
import { createMaterialGraph } from '../../runtime/materials/materialGraph';

describe('texture graph formulas', () => {
    it('reads arithmetic, functions, vectors and conditions', () => {
        expect(evaluateExpression('1 + 2 * 3', {})).toBe(7);
        expect(evaluateExpression('2 ^ 3 ^ 2', {})).toBe(512);
        expect(evaluateExpression('clamp(wear * 2, 0, 1)', { wear: 0.8 })).toBe(1);
        expect(evaluateExpression('vec3(1, 2, 3) * 2', {})).toEqual([2, 4, 6]);
        expect(evaluateExpression('a > 1 ? 10 : 20', { a: 2 })).toBe(10);
        expect(evaluateExpression('lerp(0, 10, 0.25)', {})).toBe(2.5);
        expect(evaluateExpression('-x', { x: 3 })).toBe(-3);
    });

    it('takes a power before a sign, as written maths does', () => {
        expect(evaluateExpression('-2^2', {})).toBe(-4);
        expect(evaluateExpression('(-2)^2', {})).toBe(4);
        expect(evaluateExpression('2^-1', {})).toBe(0.5);
        expect(evaluateExpression('-2 * 3', {})).toBe(-6);
        expect(evaluateExpression('-x^2 + 1', { x: 3 })).toBe(-8);
        expect(evaluateExpression('!0 && 1', {})).toBe(1);
    });

    it('explains formulas that do not read, without running anything', () => {
        expect(expressionError('wear +', ['wear'])).toMatch(/ends too soon/);
        expect(expressionError('nothing * 2', ['wear'])).toMatch(/No parameter called "nothing"/);
        expect(expressionError('alert(1)', [])).toMatch(/No function called "alert"/);
        expect(expressionError('wear * 2', ['wear'])).toBeNull();
    });

    it('never gives back infinities', () => {
        expect(evaluateExpression('1 / 0', {})).toBe(0);
        expect(evaluateExpression('log(0)', {})).toBeLessThan(0);
    });
});

describe('texture graph documents', () => {
    it('makes a new material graph with an output for every engine channel', () => {
        const graph = createTextureGraph();
        const channels = graph.nodes.filter((node) => node.type === 'output').map((node) => node.params.channel);
        expect(channels).toEqual(expect.arrayContaining(['baseColor', 'normal', 'roughness', 'metallic', 'ambientOcclusion', 'height']));
        expect(normalizeTextureGraph(JSON.parse(JSON.stringify(graph)))).toEqual(graph);
    });

    it('drops unknown nodes, dangling wires, second wires into one input, and loops', () => {
        const graph = normalizeTextureGraph({
            nodes: [
                { id: 'a', type: 'levels', x: 0, y: 0, params: {} },
                { id: 'b', type: 'invert', x: 0, y: 0, params: {} },
                { id: 'c', type: 'not-a-node', x: 0, y: 0, params: {} },
            ],
            links: [
                { from: 'a', fromOutput: 'out', to: 'b', toInput: 'in' },
                { from: 'b', fromOutput: 'out', to: 'a', toInput: 'in' },
                { from: 'a', fromOutput: 'out', to: 'b', toInput: 'in' },
                { from: 'c', fromOutput: 'out', to: 'b', toInput: 'in' },
            ],
            parameters: [{ name: 'bad name', kind: 'float', default: 1 }, { name: 'wear', kind: 'float', default: 2 }],
        });
        expect(graph.nodes.map((node) => node.id)).toEqual(['a', 'b']);
        expect(graph.links).toEqual([{ from: 'a', fromOutput: 'out', to: 'b', toInput: 'in' }]);
        expect(graph.parameters.map((parameter) => parameter.name)).toEqual(['wear']);
        expect(wouldCycle(graph, 'b', 'a')).toBe(true);
        expect(wouldCycle(graph, 'a', 'b')).toBe(false);
    });

    it('follows parameters and formulas in node settings, within each setting\'s limits', () => {
        const graph = normalizeTextureGraph({
            nodes: [{ id: 'n', type: 'perlinNoise', x: 0, y: 0, params: { scale: { $expr: 'detail * 4' }, contrast: { $bind: 'punch' } } }],
            links: [],
            parameters: [{ name: 'detail', kind: 'int', default: 3 }, { name: 'punch', kind: 'float', default: 9 }],
        });
        const definition = textureNodeDefinitionByType('perlinNoise')!;
        const values = parameterValues(graph, { detail: 5 });
        const problems: string[] = [];
        const params = resolveNodeParams(definition, graph.nodes[0], values, formulaScope(graph, values, 1024, 1024), problems);
        expect(params.scale).toBe(20);
        // Contrast stops at its own most.
        expect(params.contrast).toBe(4);
        expect(problems).toEqual([]);
    });

    it('reports a setting whose parameter is gone and keeps its default', () => {
        const graph = normalizeTextureGraph({ nodes: [{ id: 'n', type: 'perlinNoise', x: 0, y: 0, params: { scale: { $bind: 'gone' } } }], links: [], parameters: [] });
        const problems: string[] = [];
        const params = resolveNodeParams(textureNodeDefinitionByType('perlinNoise')!, graph.nodes[0], {}, {}, problems);
        expect(params.scale).toBe(8);
        expect(problems[0]).toMatch(/gone/);
    });

    it('lists the pictures a graph draws from', () => {
        const graph = normalizeTextureGraph({ nodes: [{ id: 'b', type: 'bitmap', x: 0, y: 0, params: { texture: 'tex-1' } }], links: [], parameters: [] });
        expect(graphTextureIds(graph)).toEqual(['tex-1']);
    });

    it('signs what the pictures depend on, and not where nodes sit', () => {
        const stored = readStoredGraph({ graph: createTextureGraph() });
        const moved = { ...stored, graph: { ...stored.graph, nodes: stored.graph.nodes.map((node) => ({ ...node, x: node.x + 50 })) } };
        const changed = { ...stored, graph: { ...stored.graph, seed: 7 } };
        expect(bakeSignature(moved, () => undefined)).toBe(bakeSignature(stored, () => undefined));
        expect(bakeSignature(changed, () => undefined)).not.toBe(bakeSignature(stored, () => undefined));
    });

    it('gives every node a unique type, a description and settings whose defaults read back', () => {
        const types = new Set<string>();
        for (const definition of TEXTURE_NODE_DEFINITIONS) {
            expect(types.has(definition.type)).toBe(false);
            types.add(definition.type);
            expect(definition.description.length).toBeGreaterThan(10);
            for (const param of definition.params) expect(param.label).toBeTruthy();
        }
        expect(types.size).toBeGreaterThan(60);
    });
});

describe('texture graph helpers', () => {
    it('draws curves through their points without overshooting', () => {
        const points = [{ x: 0, y: 0 }, { x: 0.5, y: 0.9 }, { x: 1, y: 1 }];
        expect(sampleCurve(points, 0.5)).toBeCloseTo(0.9);
        for (let x = 0; x <= 1; x += 0.05) {
            const y = sampleCurve(points, x);
            expect(y).toBeGreaterThanOrEqual(-1e-9);
            expect(y).toBeLessThanOrEqual(1 + 1e-9);
        }
    });

    it('labels islands of a mask, joined across the edges as the tiled image is', () => {
        // 4×3: short columns at x=0 and x=3 meet across the left and right edges.
        const width = 4;
        const height = 3;
        const mask = new Uint8Array(width * height);
        for (let y = 0; y < 2; y++) { mask[y * width] = 255; mask[y * width + 3] = 255; }
        const lone = new Uint8Array(width * height);
        lone.set(mask);
        const islands = labelIslands(lone, width, height, 1);
        expect(islands.count).toBe(1);
        expect(Array.from(islands.boxes)).toEqual([3, 0, 2, 2]);
        const two = new Uint8Array(width * height);
        two[0] = 255;
        two[2 * width + 2] = 255;
        expect(labelIslands(two, width, height, 1).count).toBe(2);
    });

    it('checks ZIP entries as the format says', () => {
        expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    });
});

describe('materials made by texture graphs', () => {
    it('keeps the texture graph and the pictures it names with the material, and lets them go together', () => {
        const asset = readMaterialAsset({ id: 'm', name: 'Bricks', graph: createMaterialGraph(), textureGraph: { graph: { nodes: [{ id: 'b', type: 'bitmap', params: { texture: 'photo' } }] }, baked: { textures: { baseColor: 'made-1' } } } })!;
        const document = materialAssetDocument(asset);
        expect(document.textureIds.sort()).toEqual(['made-1', 'photo']);
        expect(document.textureGraph).toBeTruthy();
        const cleared = withoutAssetTexture(asset, 'photo');
        expect(materialAssetDocument(cleared).textureIds).toEqual(['made-1']);
        expect(withoutAssetTexture(asset, 'unrelated')).toBe(asset);
    });
});
