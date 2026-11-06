import { describe, expect, it } from 'vitest';
import { evaluateExpression, expressionError } from '../../texturing/graph/expressions';
import {
    MAX_NODES,
    createFunctionGraph,
    createTextureGraph,
    formulaScope,
    graphReadsMeshMaps,
    graphTextureIds,
    mixSeeds,
    normalizeTextureGraph,
    parameterValues,
    readTextureGraph,
    resolveNodeParams,
    shaderSeed,
    subgraphRunSeed,
    unknownNodeTypes,
    wouldCycle,
} from '../../texturing/graph/document';
import { sampleCurve } from '../../texturing/graph/nodeKit';
import { pixelProcessorCost } from '../../texturing/graph/nodes/io';
import { mainInput } from '../../texturing/graph/evaluator';
import { TEXTURE_NODE_DEFINITIONS, placeholderDefinition, textureNodeDefinition, textureNodeDefinitionByType } from '../../texturing/graph/registry';
import { outputNodeKind, type TextureGraph } from '../../texturing/graph/types';
import { GraphHistory, materialHistory } from '../../components/Texturing/graphEditing';
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

    it('drops dangling wires, second wires into one input, and loops, and says so', () => {
        const { graph, problems } = readTextureGraph({
            nodes: [
                { id: 'a', type: 'levels', x: 0, y: 0, params: {} },
                { id: 'b', type: 'invert', x: 0, y: 0, params: {} },
                { id: 'c', type: 'blur', x: 0, y: 0, params: {} },
            ],
            links: [
                { from: 'a', fromOutput: 'out', to: 'b', toInput: 'in' },
                { from: 'b', fromOutput: 'out', to: 'a', toInput: 'in' },
                { from: 'a', fromOutput: 'out', to: 'b', toInput: 'in' },
                { from: 'c', fromOutput: 'out', to: 'b', toInput: 'in' },
                { from: 'gone', fromOutput: 'out', to: 'c', toInput: 'in' },
            ],
            parameters: [{ name: 'bad name', kind: 'float', default: 1 }, { name: 'wear', kind: 'float', default: 2 }],
        });
        expect(graph.nodes.map((node) => node.id)).toEqual(['a', 'b', 'c']);
        expect(graph.links).toEqual([{ from: 'a', fromOutput: 'out', to: 'b', toInput: 'in' }]);
        expect(graph.parameters.map((parameter) => parameter.name)).toEqual(['wear']);
        expect(problems.join(' ')).toMatch(/4 wires were left out/);
        expect(wouldCycle(graph, 'b', 'a')).toBe(true);
        expect(wouldCycle(graph, 'a', 'b')).toBe(false);
    });

    it('keeps nodes of unknown types with their settings and wires, so nothing is lost on the next save', () => {
        const stored = {
            nodes: [
                { id: 'a', type: 'perlinNoise', x: 0, y: 0, params: {} },
                { id: 'future', type: 'snowCover', x: 40, y: 10, params: { depth: 0.3, nested: { a: [1, 2] } }, size: { mode: 'graph', w: 1, h: 0 }, precision: 32 },
                { id: 'out', type: 'output', x: 0, y: 0, params: { channel: 'baseColor' } },
            ],
            links: [
                { from: 'a', fromOutput: 'out', to: 'future', toInput: 'height' },
                { from: 'future', fromOutput: 'covered', to: 'out', toInput: 'in' },
            ],
            parameters: [],
        };
        const { graph, problems } = readTextureGraph(stored);
        expect(problems).toEqual([]);
        const kept = graph.nodes.find((node) => node.id === 'future')!;
        expect(kept).toEqual({ id: 'future', type: 'snowCover', x: 40, y: 10, params: { depth: 0.3, nested: { a: [1, 2] } }, size: { mode: 'graph', w: 1, h: 0 }, precision: 32 });
        expect(graph.links).toEqual(stored.links);
        expect(unknownNodeTypes(graph)).toEqual(['snowCover']);
        // Read again (as the next save would be), nothing changes.
        expect(normalizeTextureGraph(JSON.parse(JSON.stringify(graph)))).toEqual(graph);
        // On the canvas it keeps a pin for each of its wires.
        const placeholder = placeholderDefinition(kept, graph.links);
        expect(placeholder.inputs.map((port) => port.key)).toEqual(['height']);
        expect(placeholder.outputs.map((port) => port.key)).toEqual(['covered']);
        expect(textureNodeDefinition(kept, () => undefined)).toBeNull();
    });

    it('opens big graphs whole and says what it could not open', () => {
        const nodes = Array.from({ length: 3000 }, (_, i) => ({ id: `n${i}`, type: 'invert', x: i, y: 0, params: {} }));
        const links = nodes.slice(1).map((node, i) => ({ from: `n${i}`, fromOutput: 'out', to: node.id, toInput: 'in' }));
        const { graph, problems } = readTextureGraph({ nodes, links, parameters: [] });
        expect(graph.nodes).toHaveLength(3000);
        expect(graph.links).toHaveLength(2999);
        expect(problems).toEqual([]);
        const damaged = readTextureGraph({ nodes: [{ id: 'x', type: 'invert', params: {} }, { id: 'x', type: 'invert' }, { type: 'invert' }], links: [], parameters: [] });
        expect(damaged.graph.nodes).toHaveLength(1);
        expect(damaged.problems).toEqual(['2 damaged nodes were left out.']);
        expect(MAX_NODES).toBeGreaterThanOrEqual(10000);
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

    it('keeps a node\'s own name, colour, folding and bypass, and only bypass changes what it draws', () => {
        const graph = normalizeTextureGraph({
            nodes: [{ id: 'n', type: 'blur', x: 0, y: 0, params: {}, name: '  Soft edges ', color: '#AA3311', collapsed: true, bypass: true }, { id: 'm', type: 'blur', params: {}, name: 7, color: 'red', collapsed: 'yes' }],
            links: [],
            parameters: [],
        });
        expect(graph.nodes[0]).toMatchObject({ name: 'Soft edges', color: '#aa3311', collapsed: true, bypass: true });
        expect(Object.keys(graph.nodes[1])).not.toEqual(expect.arrayContaining(['name', 'color', 'collapsed', 'bypass']));
        const stored = readStoredGraph({ graph: createTextureGraph() });
        const renamed = { ...stored, graph: { ...stored.graph, nodes: stored.graph.nodes.map((node) => ({ ...node, name: 'Mine', color: '#112233', collapsed: true })) } };
        const bypassed = { ...stored, graph: { ...stored.graph, nodes: stored.graph.nodes.map((node, index) => (index === 0 ? { ...node, bypass: true } : node)) } };
        expect(bakeSignature(renamed, () => undefined)).toBe(bakeSignature(stored, () => undefined));
        expect(bakeSignature(bypassed, () => undefined)).not.toBe(bakeSignature(stored, () => undefined));
        // A blend passes its background through; most nodes their first input; a generator cannot be bypassed.
        expect(mainInput(textureNodeDefinitionByType('blend')!)).toBe('background');
        expect(mainInput(textureNodeDefinitionByType('blur')!)).toBe('in');
        expect(mainInput(textureNodeDefinitionByType('perlinNoise')!)).toBeNull();
        expect(textureNodeDefinitionByType('reroute')!.inputs.map((port) => port.key)).toEqual(['in']);
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

    it('checks ZIP entries as the format says', () => {
        expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    });

    it('gives hand-written pixels a cost that grows with their reads and loops', () => {
        expect(pixelProcessorCost('vec4 v = c_a(uv);\noutColor = v;')).toBe(16);
        const looped = pixelProcessorCost('vec4 s = vec4(0.0);\nfor (int i = 0; i < 64; i++) { s += c_a(uv + vec2(float(i)) * 0.001) + c_b(uv); }\noutColor = s;');
        expect(looped).toBeGreaterThan(256);
        expect(looped).toBeLessThanOrEqual(1024);
    });
});

describe('texture graph seeds', () => {
    it('hashes graph and node seeds so pairs that summed alike no longer meet', () => {
        // 0 * 7919 + 7919 * 131 and 131 * 7919 + 0 * 131 were the same seed.
        expect(shaderSeed(0, 7919)).not.toBe(shaderSeed(131, 0));
        expect(shaderSeed(3, 4)).toBe(shaderSeed(3, 4));
        const seeds = new Set<number>();
        for (let graph = 0; graph < 40; graph++) for (let node = 0; node < 40; node++) seeds.add(shaderSeed(graph, node));
        expect(seeds.size).toBeGreaterThan(1590);
        for (const seed of seeds) {
            expect(seed).toBeLessThan(2 ** 20 + 1);
            expect(seed % 1).toBe(0.5);
        }
        expect(mixSeeds(1, 2)).not.toBe(mixSeeds(2, 1));
    });

    it('runs each copy of a sub-graph with its own seed unless it is set not to vary', () => {
        const a = subgraphRunSeed(5, 'copy-a', 0, true, 0);
        const b = subgraphRunSeed(5, 'copy-b', 0, true, 0);
        expect(a).not.toBe(b);
        expect(subgraphRunSeed(5, 'copy-a', 0, true, 0)).toBe(a);
        // The outer graph's seed reaches the copies.
        expect(subgraphRunSeed(6, 'copy-a', 0, true, 0)).not.toBe(a);
        // Pinned: the seed alone sets the look.
        expect(subgraphRunSeed(5, 'copy-a', 7, false, 0)).toBe(subgraphRunSeed(9, 'copy-b', 7, false, 0));
        expect(subgraphRunSeed(5, 'copy-a', 7, false, 0)).not.toBe(subgraphRunSeed(5, 'copy-a', 8, false, 0));
    });

    it('gives sub-graph nodes a seed and a vary switch after the graph\'s own parameters', () => {
        const inner = createFunctionGraph();
        const definition = textureNodeDefinition({ id: 's', type: 'subgraph', x: 0, y: 0, params: { graph: 'g' } }, () => ({ id: 'g', name: 'Mask', graph: inner }))!;
        expect(definition.params.map((param) => param.key)).toEqual(['graph', '$seed', '$vary']);
        expect(definition.params.find((param) => param.key === '$vary')!.default).toBe(true);
    });
});

describe('texture graph outputs', () => {
    it('lets a named image be grey, and gives graphs using it a grey pin', () => {
        expect(outputNodeKind({ channel: 'custom' })).toBe('color');
        expect(outputNodeKind({ channel: 'custom', kind: 'gray' })).toBe('gray');
        expect(outputNodeKind({ channel: 'roughness', kind: 'color' })).toBe('gray');
        expect(outputNodeKind({ channel: 'baseColor' })).toBe('color');
        const inner = createFunctionGraph();
        const definition = textureNodeDefinition({ id: 's', type: 'subgraph', x: 0, y: 0, params: { graph: 'g' } }, () => ({ id: 'g', name: 'Mask', graph: inner }))!;
        expect(definition.outputs.map((port) => port.kind)).toEqual(['gray']);
        const colour: TextureGraph = { ...inner, nodes: inner.nodes.map((node) => (node.type === 'output' ? { ...node, params: { ...node.params, kind: 'color' } } : node)) };
        const coloured = textureNodeDefinition({ id: 's', type: 'subgraph', x: 0, y: 0, params: { graph: 'g' } }, () => ({ id: 'g', name: 'Mask', graph: colour }))!;
        expect(coloured.outputs.map((port) => port.kind)).toEqual(['color']);
    });

    it('knows when a graph reads mesh maps, through the graphs it uses', () => {
        const plain = createTextureGraph();
        expect(graphReadsMeshMaps(plain, () => undefined)).toBe(false);
        const reads = normalizeTextureGraph({ nodes: [{ id: 't', type: 'triplanar', params: {} }], links: [], parameters: [] });
        expect(graphReadsMeshMaps(reads, () => undefined)).toBe(true);
        const user = normalizeTextureGraph({ nodes: [{ id: 's', type: 'subgraph', params: { graph: 'inner' } }], links: [], parameters: [] });
        expect(graphReadsMeshMaps(user, (id) => (id === 'inner' ? { graph: reads } : undefined))).toBe(true);
        expect(graphReadsMeshMaps(user, () => undefined)).toBe(false);
    });
});

describe('texture graph undo', () => {
    interface Snapshot { graph: string; values: Record<string, number>; bakeSize: number }

    it('steps back and forth through whole states, values and picture settings included', () => {
        const history = new GraphHistory<Snapshot>();
        const first: Snapshot = { graph: 'a', values: { wear: 0.2 }, bakeSize: 11 };
        const second: Snapshot = { graph: 'a', values: { wear: 0.7 }, bakeSize: 11 };
        const third: Snapshot = { graph: 'a', values: { wear: 0.7 }, bakeSize: 12 };
        history.record(first, undefined, 0);
        history.record(second, undefined, 5000);
        expect(history.undo(third)).toEqual(second);
        expect(history.undo(second)).toEqual(first);
        expect(history.canUndo).toBe(false);
        expect(history.redo(first)).toEqual(second);
        expect(history.redo(second)).toEqual(third);
        expect(history.canRedo).toBe(false);
    });

    it('merges quick changes of one value into one step, and a new change ends redo', () => {
        const history = new GraphHistory<number>();
        history.record(1, 'value:wear', 0);
        history.record(2, 'value:wear', 300);
        history.record(3, 'value:wear', 600);
        expect(history.undo(4)).toBe(1);
        expect(history.canUndo).toBe(false);
        history.record(1, 'value:wear', 700);
        expect(history.canRedo).toBe(false);
        // Another value, or the same one after a pause, is a step of its own.
        history.record(5, 'value:scale', 800);
        history.record(6, 'value:scale', 5000);
        expect(history.undo(7)).toBe(6);
        expect(history.undo(6)).toBe(5);
    });

    it('keeps each material\'s history while others are open, as long as it was touched lately', () => {
        const bricks = materialHistory<number>('bricks-undo-test');
        bricks.record(1, undefined, 0);
        materialHistory<number>('tiles-undo-test').record(2, undefined, 0);
        // Opening the material again (a new screen) finds its steps where they were.
        expect(materialHistory<number>('bricks-undo-test')).toBe(bricks);
        expect(materialHistory<number>('bricks-undo-test').canUndo).toBe(true);
        for (let i = 0; i < 40; i++) materialHistory<number>(`other-${i}-undo-test`);
        expect(materialHistory<number>('bricks-undo-test').canUndo).toBe(false);
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
