import { describe, expect, it, vi } from 'vitest';
import { createMaterialGraph } from '../../runtime/materials/materialGraph';
import { materialAssetDocument, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import { normalizeTextureGraph, createNode } from '../../texturing/graph/document';
import { planTextureParameterRename } from '../../texturing/graph/renameProjectParameter';
import { readTextureRenameInventory } from '../../texturing/graph/renameSnapshot';
import {
    commitTextureParameterRename, replayTextureParameterRename,
    type RenameSnapshotHost,
} from '../../texturing/graph/renameTransaction';
import type { ProjectChange, ProjectSnapshot } from '../../utils/projectService';

const source: MaterialAsset = {
    id: 'source', name: 'source', graph: createMaterialGraph(), textureGraph: {
        graph: normalizeTextureGraph({
            version: 1, size: { w: 8, h: 8 }, seed: 6, nodes: [], links: [],
            parameters: [{ name: 'wear', label: 'Wear', kind: 'float', default: 0.3 }],
        }),
        values: { wear: 0.6 },
    },
};
const nested: MaterialAsset = {
    id: 'nested', name: 'nested', graph: createMaterialGraph(), textureGraph: {
        graph: normalizeTextureGraph({
            version: 1, size: { w: 8, h: 8 }, seed: 2, links: [],
            nodes: [{ ...createNode('subgraph', 0, 0, { graph: 'source', wear: 0.7 }), id: 'using-source' }],
            parameters: [],
        }),
        values: {},
    },
};

const fixture = () => {
    const status = { projectId: 'project-a' as string | null, revision: 8, readOnly: false };
    const documents: Record<string, Array<Record<string, unknown>>> = {
        materials: [source, nested].map(asset => structuredClone(materialAssetDocument(asset)) as unknown as Record<string, unknown>),
        models: [{ id: 'model', materialOverrides: {
            Wood: { materialId: 'source', parameters: [{ name: 'wear', value: 0.35 }] },
        } }],
        objects: [{ id: 'object', modelId: 'model', materialOverrides: {
            Wood: { parameters: [{ name: 'wear', value: 0.4 }] },
        } }],
        prefabs: [{ id: 'prefab', rootId: 'root', objects: [
            { id: 'root', type: 'light' }, { id: 'child', modelId: 'model', materialOverrides: {
                Wood: { parameters: [{ name: 'wear', value: 0.45 }] },
            } },
        ] }],
        metadata: [{ id: 'texture-graph-presets', settings: { version: 1, presets: [
            { id: 'preset', graphId: 'source', values: { wear: 0.5 } },
        ] } }],
    };
    const snapshot = (): ProjectSnapshot => ({
        projectId: status.projectId ?? undefined, revision: status.revision, hasMore: false,
        domains: structuredClone(documents),
    });
    const applied: ProjectChange[][] = [];
    let fail = false;
    const host: RenameSnapshotHost = {
        getStatus: () => ({ ...status }),
        getSnapshotAll: vi.fn(async () => snapshot()),
        applyChanges: vi.fn(async (changes: ProjectChange[]) => {
            applied.push(changes);
            if (fail) throw new Error('native transaction rejected');
            for (const change of changes) {
                const records = documents[change.domain];
                if (!records || !change.id || change.operation !== 'upsert') throw new Error('invalid fixture batch');
                const index = records.findIndex(doc => doc.id === change.id);
                if (index < 0) throw new Error('missing fixture document');
                records[index] = structuredClone(change.value as Record<string, unknown>);
            }
            return { revision: ++status.revision };
        }),
    };
    const plan = () => planTextureParameterRename({
        ...readTextureRenameInventory(snapshot(), null, { projectId: 'project-a', revision: status.revision }),
        sourceMaterialId: 'source', from: 'wear', to: 'patina',
    });
    return { host, status, documents, applied, snapshot, plan, reject: () => { fail = true; } };
};

describe('live project parameter rename history', () => {
    it('renames five document domains in one batch and replays them after unrelated revisions', async () => {
        const { host, status, documents, applied, plan } = fixture();
        const original = structuredClone(documents);
        const receipt = await commitTextureParameterRename(plan(), host, { projectId: 'project-a', revision: 8 }, () => undefined);
        expect(applied).toHaveLength(1);
        expect(applied[0].map(change => change.domain)).toEqual([
            'materials', 'materials', 'models', 'objects', 'prefabs', 'metadata',
        ]);
        expect(documents.prefabs[0]).toMatchObject({ objects: [{ id: 'root' }, {
            id: 'child', materialOverrides: { Wood: { parameters: [{ name: 'patina', value: 0.45 }] } },
        }] });
        // A later revision in an unaffected domain is safe to preserve.
        documents.metadata.push({ id: 'unrelated-editor-state', settings: { view: 'x' } });
        status.revision++;
        await replayTextureParameterRename(receipt, 'undo', host, () => undefined);
        expect(applied).toHaveLength(2);
        expect(documents.materials).toEqual(original.materials);
        expect(documents.models).toEqual(original.models);
        expect(documents.objects).toEqual(original.objects);
        expect(documents.prefabs).toEqual(original.prefabs);
        expect(documents.metadata).toEqual([...original.metadata, { id: 'unrelated-editor-state', settings: { view: 'x' } }]);
        await replayTextureParameterRename(receipt, 'redo', host, () => undefined);
        expect(applied).toHaveLength(3);
        expect(documents.models[0]).toMatchObject({ materialOverrides: {
            Wood: { parameters: [{ name: 'patina', value: 0.35 }] },
        } });
    });

    it('blocks undo when another asset starts referencing the renamed parameter', async () => {
        const { host, documents, applied, status, plan } = fixture();
        const receipt = await commitTextureParameterRename(plan(), host, { projectId: 'project-a', revision: 8 }, () => undefined);
        // The original six documents remain unchanged: only a NEW model was
        // added, so document-equality checks alone are insufficient.
        documents.models.push({ id: 'later-model', materialOverrides: {
            Stone: { materialId: 'source', parameters: [{ name: 'patina', value: 0.82 }] },
        } });
        status.revision++;
        await expect(replayTextureParameterRename(receipt, 'undo', host, () => undefined))
            .rejects.toThrow(/new dependent models\/later-model/);
        expect(applied).toHaveLength(1);
    });

    it('blocks redo when another asset starts referencing the restored old name', async () => {
        const { host, documents, applied, status, plan } = fixture();
        const receipt = await commitTextureParameterRename(plan(), host, { projectId: 'project-a', revision: 8 }, () => undefined);
        await replayTextureParameterRename(receipt, 'undo', host, () => undefined);
        documents.models.push({ id: 'later-model', materialOverrides: {
            Stone: { materialId: 'source', parameters: [{ name: 'wear', value: 0.82 }] },
        } });
        status.revision++;
        await expect(replayTextureParameterRename(receipt, 'redo', host, () => undefined))
            .rejects.toThrow(/new dependent models\/later-model/);
        expect(applied).toHaveLength(2);
    });

    it('refuses to restore any dependent document changed after the rename', async () => {
        const { host, documents, applied, plan } = fixture();
        const receipt = await commitTextureParameterRename(plan(), host, { projectId: 'project-a', revision: 8 }, () => undefined);
        (documents.objects[0].materialOverrides as { Wood: { parameters: Array<{ value: number }> } })
            .Wood.parameters[0].value = 0.99;
        await expect(replayTextureParameterRename(receipt, 'undo', host, () => undefined))
            .rejects.toThrow(/objects\/object was edited/);
        expect(applied).toHaveLength(1);
    });

    it('fails closed for missing domains, a different project and a rejected host batch', async () => {
        const { host, status, documents, applied, plan, reject } = fixture();
        const receipt = await commitTextureParameterRename(plan(), host, { projectId: 'project-a', revision: 8 }, () => undefined);
        delete documents.prefabs;
        await expect(replayTextureParameterRename(receipt, 'undo', host, () => undefined)).rejects.toThrow(/prefabs/);
        documents.prefabs = [];
        status.projectId = 'other-project';
        await expect(replayTextureParameterRename(receipt, 'undo', host, () => undefined)).rejects.toThrow(/active project changed/);
        status.projectId = 'project-a';
        documents.prefabs = [structuredClone(receipt.redoChanges.find(change => change.domain === 'prefabs')!.value as Record<string, unknown>)];
        reject();
        await expect(replayTextureParameterRename(receipt, 'undo', host, () => undefined)).rejects.toThrow(/native transaction rejected/);
        expect(applied).toHaveLength(2);
    });
});
