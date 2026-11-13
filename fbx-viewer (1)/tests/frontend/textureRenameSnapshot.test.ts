import { describe, expect, it } from 'vitest';
import { createMaterialGraph } from '../../runtime/materials/materialGraph';
import { materialAssetDocument, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import { createNode, normalizeTextureGraph } from '../../texturing/graph/document';
import { planTextureParameterRename, requiresProjectWideParameterRename } from '../../texturing/graph/renameProjectParameter';
import { readTextureRenameInventory } from '../../texturing/graph/renameSnapshot';
import type { ProjectSnapshot } from '../../utils/projectService';

const graph = (nodes: ReturnType<typeof createNode>[] = []) => normalizeTextureGraph({
    version: 1, size: { w: 8, h: 8 }, seed: 1, nodes, links: [],
    parameters: [{ name: 'wear', kind: 'float' as const, default: 0.3, label: 'Wear' }],
});
const material = (id: string, textureGraph?: Record<string, unknown>, paint?: Record<string, unknown>): MaterialAsset => ({
    id, name: id, graph: createMaterialGraph(),
    ...(textureGraph ? { textureGraph } : {}),
    ...(paint ? { paint } : {}),
});

const fixture = (): { snapshot: ProjectSnapshot; live: MaterialAsset[] } => {
    const live = [
        material('source', { graph: graph(), values: { wear: 0.3 } }),
        material('dependent', {
            graph: graph([{ ...createNode('subgraph', 0, 0, { graph: 'source', wear: 0.4 }), id: 'using-source' }]),
            values: {},
        }),
        material('paint', undefined, {
            version: 1, modelId: 'model', layers: [{
                id: 'fill', kind: 'fill',
                fill: { baseColor: { kind: 'graph', graphId: 'source', values: { wear: 0.5 } } },
            }],
        }),
    ];
    return {
        live,
        snapshot: {
            projectId: 'project-a', revision: 7, hasMore: false,
            domains: {
                materials: live.map(value => JSON.parse(JSON.stringify(materialAssetDocument(value)))),
                models: [{ id: 'model', materialOverrides: {
                    Wood: { materialId: 'source', parameters: [{ name: 'wear', value: 0.1 }] },
                } }],
                objects: [{ id: 'object', modelId: 'model', materialOverrides: {
                    Wood: { parameters: [{ name: 'wear', value: 0.2 }] },
                } }, { id: 'light', type: 'light' }],
                prefabs: [],
                metadata: [{ id: 'texture-graph-presets', settings: {
                    version: 1, presets: [{ id: 'preset', graphId: 'source', values: { wear: 0.8 } }],
                } }],
            },
        },
    };
};
const inventory = (data: ReturnType<typeof fixture>) =>
    readTextureRenameInventory(data.snapshot, data.live, { projectId: 'project-a', revision: 7 });
const domains = (data: ReturnType<typeof fixture>): Record<string, unknown> =>
    data.snapshot.domains as Record<string, unknown>;

const planWithPaintAssets = (...paintAssets: MaterialAsset[]) => {
    const live = [material('source', { graph: graph() }), ...paintAssets];
    const snapshot = {
        projectId: 'project-a', revision: 7, hasMore: false,
        domains: { materials: live.map(materialAssetDocument), models: [], objects: [], prefabs: [], metadata: [] },
    };
    return planTextureParameterRename({
        ...inventory({ live, snapshot }), sourceMaterialId: 'source', from: 'wear', to: 'patina',
    });
};

describe('texture parameter rename host inventory safety', () => {
    it('accepts complete matching saved documents and includes dependent references in the plan', () => {
        const data = fixture();
        const checked = inventory(data);
        expect(checked.materials).toHaveLength(3);
        expect(checked.models).toHaveLength(1);
        expect(checked.objects.map(item => item.id)).toEqual(['object']);
        const plan = planTextureParameterRename({
            ...checked, sourceMaterialId: 'source', from: 'wear', to: 'patina',
        });
        expect(requiresProjectWideParameterRename(plan.impact)).toBe(true);
        expect(plan.impact).toMatchObject({
            materials: ['source', 'dependent', 'paint'], models: ['model'], objects: ['object'],
            nestedNodes: 1, paintReferences: 1, modelOverrides: 1, objectOverrides: 1, sharedPresets: 1,
        });
    });

    it('allows a local rename in a project with export templates and unrelated saved smart materials', () => {
        const templates = material('templates', undefined, { exportTemplates: [] });
        const smart = material('smart', undefined, { smartMaterial: { version: 1, at: 12, layer: {
            id: 'fill', kind: 'fill', fill: { roughness: { kind: 'graph', graphId: 'other', values: { wear: 0.8 } } },
        } } });
        const plan = planWithPaintAssets(templates, smart);
        expect(requiresProjectWideParameterRename(plan.impact)).toBe(false);
        expect(plan.impact.materials).toEqual(['source']);
    });

    it('plans a reversible rename for graph fills and masks inside a saved smart material', () => {
        const smart = material('smart', undefined, { smartMaterial: { version: 1, at: 12, layer: {
            id: 'folder', kind: 'folder', layers: [{ id: 'fill', kind: 'fill',
                fill: { roughness: { kind: 'graph', graphId: 'source', values: { wear: 0.8 } } },
                mask: [{ id: 'mask', kind: 'generator', graphId: 'source', values: { wear: 0.2 } }],
            }],
        } } });
        const before = structuredClone(materialAssetDocument(smart));
        const plan = planWithPaintAssets(smart);
        expect(requiresProjectWideParameterRename(plan.impact)).toBe(true);
        expect(plan.impact.paintReferences).toBe(2);
        expect(plan.changedMaterials.find(asset => asset.id === 'smart')?.paint).toMatchObject({
            smartMaterial: { layer: { layers: [{
                fill: { roughness: { values: { patina: 0.8 } } }, mask: [{ values: { patina: 0.2 } }],
            }] } },
        });
        expect(materialAssetDocument(smart)).toEqual(before);
        expect(plan.undoChanges.find(change => change.id === 'smart')?.value).toEqual(before);
    });

    it('rejects malformed paint variants even alongside valid export templates', () => {
        for (const paint of [
            { exportTemplates: [], layers: null },
            { exportTemplates: [], smartMaterial: { version: 2, layer: {} } },
            { smartMaterial: { version: 1, layer: null } },
            { exportTemplates: {} },
        ]) {
            expect(() => planWithPaintAssets(material('paint', undefined, paint))).toThrow(/unsupported paint document/);
        }
    });

    it('requires every reference-bearing domain even when it contains no documents', () => {
        for (const name of ['materials', 'models', 'objects', 'prefabs', 'metadata']) {
            const data = fixture();
            delete domains(data)[name];
            expect(() => inventory(data)).toThrow(name);
        }
        const empty = fixture();
        domains(empty).metadata = [];
        expect(inventory(empty).metadata).toEqual([]);
    });

    it('blocks a saved prefab override even when the prefab has no placed instances', () => {
        const data = fixture();
        const saved = domains(data);
        saved.objects = [];
        saved.models = [{ id: 'model', materialOverrides: { Wood: { materialId: 'source' }, Metal: { materialId: 'dependent' } } }];
        const member = { id: 'member', modelId: 'model', materialOverrides: { Wood: { parameters: [{ name: 'wear', value: 0.6 }] } } };
        saved.prefabs = [{ id: 'kit', objects: [member] }];
        const plan = () => planTextureParameterRename({
            ...inventory(data), sourceMaterialId: 'source', from: 'wear', to: 'patina',
        });
        expect(plan).toThrow(/prefab "kit" object "member" overrides "wear"/);

        saved.prefabs = [{ id: 'kit', objects: [{ ...member, materialOverrides: { Metal: member.materialOverrides.Wood } }] }];
        expect(plan).not.toThrow();

        saved.prefabs = [{ id: 'kit', objects: [{ ...member, modelId: 'missing-model' }] }];
        expect(plan).toThrow(/model is missing/);
    });

    it('rejects malformed prefab members before planning', () => {
        for (const members of [null, [null], [{ id: 'p' }, { id: 'p' }], [{ id: 'p', materialOverrides: { Wood: { parameters: null } } }]]) {
            const data = fixture();
            domains(data).prefabs = [{ id: 'kit', objects: members }];
            expect(() => inventory(data)).toThrow(/prefab/i);
        }
    });

    it('rejects incomplete, mixed-project and stale snapshot envelopes', () => {
        for (const patch of [
            { projectId: 'another-project' }, { revision: 8 }, { hasMore: true }, { domains: undefined },
        ]) {
            const data = fixture();
            data.snapshot = { ...data.snapshot, ...patch };
            expect(() => inventory(data)).toThrow();
        }
        const data = fixture();
        expect(() => readTextureRenameInventory(data.snapshot, data.live, {
            projectId: 'project-a', revision: 6,
        })).toThrow(/changed/);
    });

    it('rejects invalid document identities rather than dropping hidden dependents', () => {
        for (const invalid of [[null], [{ id: 'model' }, { id: 'model' }], [{ missingId: true }]]) {
            const data = fixture();
            domains(data).models = invalid;
            expect(() => inventory(data)).toThrow();
        }
    });

    it('rejects malformed references and records without model identity', () => {
        const cases: Array<(data: ReturnType<typeof fixture>) => void> = [
            (data) => { (domains(data).models as any[])[0].materialOverrides = ['invalid']; },
            (data) => { (domains(data).models as any[])[0].materialOverrides.Wood = null; },
            (data) => { (domains(data).models as any[])[0].materialOverrides.Wood.materialId = 12; },
            (data) => { (domains(data).models as any[])[0].materialOverrides.Wood.parameters = { wear: 0.1 }; },
            (data) => { (domains(data).objects as any[])[0].materialOverrides.Wood.parameters = [null]; },
            (data) => { (domains(data).objects as any[])[0].modelId = undefined; },
            (data) => { (domains(data).objects as any[])[0].materialOverrides = ['invalid']; },
            (data) => { (domains(data).materials as any[])[1].textureGraph = { graph: { version: 2 } }; },
            (data) => { (domains(data).materials as any[])[2].paint.version = 2; },
            (data) => { (domains(data).materials as any[])[0].graph = null; },
            (data) => { (domains(data).metadata as any[])[0].settings.version = 2; },
        ];
        for (const corrupt of cases) {
            const data = fixture();
            corrupt(data);
            expect(() => inventory(data)).toThrow();
        }
    });

    it('blocks unsaved edits to values or dependent material graphs', () => {
        const dirtyValue = fixture();
        dirtyValue.live[0] = {
            ...dirtyValue.live[0],
            textureGraph: { ...dirtyValue.live[0].textureGraph, values: { wear: 0.91 } },
        };
        expect(() => inventory(dirtyValue)).toThrow(/differs from the saved project/);

        const dirtyDependent = fixture();
        dirtyDependent.live[1] = {
            ...dirtyDependent.live[1],
            textureGraph: { ...dirtyDependent.live[1].textureGraph, values: { unsaved: 2 } },
        };
        expect(() => inventory(dirtyDependent)).toThrow(/differs from the saved project/);
    });

    it('accepts saved picture maps after the native host sorts their keys', () => {
        const data = fixture();
        data.live[0] = { ...data.live[0], pictures: { normal: 'texture-n', baseColor: 'texture-c' } };
        const documents = data.live.map(materialAssetDocument);
        documents[0] = { ...documents[0], pictures: { baseColor: 'texture-c', normal: 'texture-n' } };
        domains(data).materials = documents;
        expect(inventory(data).materials).toEqual(data.live);
    });

    it('blocks a material missing from either the editor or the project snapshot', () => {
        const extraLive = fixture();
        extraLive.live.push(material('unsaved'));
        expect(() => inventory(extraLive)).toThrow(/does not match/);

        const missingLive = fixture();
        missingLive.live.pop();
        expect(() => inventory(missingLive)).toThrow(/does not match/);

        const changedHost = fixture();
        (domains(changedHost).materials as any[])[0].textureGraph.values.wear = 0.99;
        expect(() => inventory(changedHost)).toThrow(/differs from the saved project/);
    });

    it('rejects duplicate in-memory material IDs', () => {
        const data = fixture();
        data.live.push(data.live[0]);
        expect(() => inventory(data)).toThrow(/duplicate/);
    });
});
