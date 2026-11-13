import { describe, expect, it } from 'vitest';
import { createMaterialGraph, type MaterialGraph } from '../../runtime/materials/materialGraph';
import { materialAssetDocument, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import { createNode, normalizeTextureGraph } from '../../texturing/graph/document';
import { planTextureParameterRename, type ProjectModelForRename, type ProjectObjectForRename } from '../../texturing/graph/renameProjectParameter';

const surface = (): MaterialGraph => createMaterialGraph();
const graph = (nodes: ReturnType<typeof createNode>[] = [], parameters = [
    { name: 'wear', label: 'Wear', kind: 'float' as const, default: 0.25 },
]) => normalizeTextureGraph({ version: 1, size: { w: 8, h: 8 }, seed: 7, nodes, links: [], parameters });
const material = (id: string, textureGraph?: Record<string, unknown>, paint?: Record<string, unknown>): MaterialAsset =>
    ({ id, name: id, graph: surface(), ...(textureGraph ? { textureGraph } : {}), ...(paint ? { paint } : {}) });

const fixture = () => {
    const source = material('source', {
        graph: graph([createNode('uniformValue', 0, 0, { value: { $bind: 'wear' } })]),
        values: { wear: 0.7 },
        bakeSize: 10,
        layout: 'engine',
        extraOlderField: 'keep-me',
    });
    const used = material('used', { graph: graph([
        { ...createNode('subgraph', 0, 0, { graph: 'source', wear: 0.3 }), id: 'sub' },
        { ...createNode('iterate', 0, 0, { graph: 'source', wear: 0.5, passes: 2 }), id: 'iter' },
        { ...createNode('subgraph', 0, 0, { graph: 'unrelated', wear: 0.6 }), id: 'other' },
    ], []), values: {}, bakeSize: 11, layout: 'separate' });
    const paint = material('paint', undefined, {
        version: 1,
        modelId: 'm1',
        materialNames: ['Wood'],
        layers: [{
            id: 'folder', kind: 'folder', layers: [{
                id: 'fill', kind: 'fill', fill: {
                    baseColor: { kind: 'graph', graphId: 'source', output: 'a', values: { wear: 0.1, another: 2 } },
                    roughness: { kind: 'graph', graphId: 'elsewhere', output: 'a', values: { wear: 0.9 } },
                },
                mask: [{ id: 'mask1', graphId: 'source', values: { wear: 0.8 } },
                    { id: 'mask2', graphId: 'other', values: { wear: 0.9 } }],
            }],
        }],
    });
    const models: ProjectModelForRename[] = [
        { id: 'm1', name: 'crate', materialOverrides: {
            Wood: { materialId: 'source', roughness: 0.1, parameters: [{ name: 'wear', value: 0.2 }, { name: 'GRAPH_SEED', value: 5 }] },
            Metal: { materialId: 'used', parameters: [{ name: 'wear', value: 0.9 }] },
        } },
        { id: 'm2', materialOverrides: { Wood: { materialId: 'source', parameters: [{ name: 'wear', value: 0.3 }] } } },
    ];
    const objects: ProjectObjectForRename[] = [
        { id: 'o1', modelId: 'm1', materialOverrides: {
            Wood: { parameters: [{ name: 'wear', value: 0.01 }, { name: 'GRAPH_SEED', value: 13 }] },
            Metal: { parameters: [{ name: 'wear', value: 0.99 }] },
        } },
        { id: 'o2', modelId: 'm2', materialOverrides: { Wood: { parameters: [{ name: 'wear', value: 0.66 }] } } },
        { id: 'o3', modelId: 'm1', materialOverrides: { Metal: { parameters: [{ name: 'wear', value: 0.45 }] } } },
    ];
    const metadata = [{ id: 'texture-graph-presets', settings: { version: 1, presets: [
        { id: 'a', graphId: 'source', values: { wear: 0.3, other: 4 } },
        { id: 'b', graphId: 'used', values: { wear: 0.2 } },
    ] } }];
    return { sourceMaterialId: 'source', from: 'wear', to: 'patina', materials: [source, used, paint], models, objects, metadata };
};

describe('M0 transactional texture parameter rename planner', () => {
    it('collects one reversible host batch for source, subgraph, Iterate, paint, model, object and shared presets', () => {
        const input = fixture();
        const old = JSON.stringify(input);
        const plan = planTextureParameterRename(input);
        expect(JSON.stringify(input)).toBe(old);
        expect(plan.impact).toMatchObject({
            sourceMaterialId: 'source', from: 'wear', to: 'patina',
            materials: ['source', 'used', 'paint'], models: ['m1', 'm2'], objects: ['o1', 'o2'],
            metadata: ['texture-graph-presets'],
            nestedNodes: 2, paintReferences: 2, modelOverrides: 2, objectOverrides: 2, sharedPresets: 1,
        });
        expect(plan.changes.map(change => `${change.domain}:${change.id}`)).toEqual([
            'materials:source', 'materials:used', 'materials:paint',
            'models:m1', 'models:m2', 'objects:o1', 'objects:o2', 'metadata:texture-graph-presets',
        ]);
        expect(plan.undoChanges.map(c => [c.domain, c.id])).toEqual(plan.changes.map(c => [c.domain, c.id]));

        const afterSource = plan.changedMaterials.find(m => m.id === 'source')!;
        const stored = afterSource.textureGraph as { graph: { parameters: Array<{ name: string }>; nodes: Array<{ params: Record<string, unknown> }> }; values: Record<string, unknown>; extraOlderField?: string };
        expect(stored.extraOlderField).toBe('keep-me');
        expect(stored.graph.parameters[0].name).toBe('patina');
        expect(stored.values).toEqual({ patina: 0.7 });
        expect(stored.graph.nodes[0].params.value).toEqual({ $bind: 'patina' });

        const afterUsed = plan.changedMaterials.find(m => m.id === 'used')!;
        const nodes = (afterUsed.textureGraph as { graph: { nodes: Array<{ params: Record<string, unknown> }> } }).graph.nodes;
        expect(nodes[0].params.patina).toBe(0.3);
        expect(nodes[1].params.patina).toBe(0.5);
        expect(nodes[2].params.wear).toBe(0.6);
        expect(Object.hasOwn(nodes[0].params, 'wear')).toBe(false);

        const afterPaint = plan.changedMaterials.find(m => m.id === 'paint')!.paint as { layers: any[] };
        const fill = afterPaint.layers[0].layers[0].fill;
        expect(fill.baseColor.values).toEqual({ patina: 0.1, another: 2 });
        expect(fill.roughness.values).toEqual({ wear: 0.9 });
        expect(afterPaint.layers[0].layers[0].mask[0].values).toEqual({ patina: 0.8 });
        expect(afterPaint.layers[0].layers[0].mask[1].values).toEqual({ wear: 0.9 });

        const afterModel = plan.changes.find(c => c.domain === 'models' && c.id === 'm1')!.value as ProjectModelForRename;
        expect((afterModel.materialOverrides as any).Wood.parameters[0].name).toBe('patina');
        expect((afterModel.materialOverrides as any).Metal.parameters[0].name).toBe('wear');
        const afterObject = plan.changes.find(c => c.domain === 'objects' && c.id === 'o1')!.value as ProjectObjectForRename;
        expect((afterObject.materialOverrides as any).Wood.parameters[0].name).toBe('patina');
        expect((afterObject.materialOverrides as any).Metal.parameters[0].name).toBe('wear');

        const metadata = plan.changes.find(c => c.domain === 'metadata')!.value as { settings: { presets: Array<{ values: Record<string, unknown> }> } };
        expect(metadata.settings.presets[0].values).toEqual({ patina: 0.3, other: 4 });
        expect(metadata.settings.presets[1].values).toEqual({ wear: 0.2 });

        expect(plan.undoChanges[0].value).toEqual(materialAssetDocument(input.materials[0]));
        expect(plan.undoChanges.at(-1)?.value).toEqual(input.metadata[0]);
    });

    it('rejects target-name collisions before producing any mutations', () => {
        const sourceCollision = fixture();
        sourceCollision.to = 'not a name';
        expect(() => planTextureParameterRename(sourceCollision)).toThrow(/letters|digits|underscore/i);

        const nodeCollision = fixture();
        const used = nodeCollision.materials[1].textureGraph as any;
        used.graph.nodes[0].params.patina = 123;
        expect(() => planTextureParameterRename(nodeCollision)).toThrow(/already exists in graph node/);

        const paintedCollision = fixture();
        const fill = (paintedCollision.materials[2].paint as any).layers[0].layers[0].fill.baseColor;
        fill.values.patina = 0;
        expect(() => planTextureParameterRename(paintedCollision)).toThrow(/already exists in paint fill/);

        const modelCollision = fixture();
        (modelCollision.models[0].materialOverrides as any).Wood.parameters.push({ name: 'patina', value: 5 });
        expect(() => planTextureParameterRename(modelCollision)).toThrow(/already exists in model/);
    });

    it('refuses newer paint or graph schema where a matching reference would be rewritten', () => {
        const futurePaint = fixture();
        (futurePaint.materials[2].paint as any).version = 2;
        expect(() => planTextureParameterRename(futurePaint)).toThrow(/unsupported paint document/);
        const futureGraph = fixture();
        (futureGraph.materials[1].textureGraph as any).graph.version = 2;
        expect(() => planTextureParameterRename(futureGraph)).toThrow(/unsupported graph version/);
    });

    it('does not rewrite unrelated uses of the same parameter name', () => {
        const input = fixture();
        input.materials.splice(1, 2);
        input.models.splice(0);
        input.objects.splice(0);
        input.metadata.splice(0);
        const plan = planTextureParameterRename(input);
        expect(plan.impact.materials).toEqual(['source']);
        expect(plan.impact.nestedNodes).toBe(0);
        expect(plan.impact.modelOverrides).toBe(0);
        expect(plan.changes).toHaveLength(1);
    });
});
