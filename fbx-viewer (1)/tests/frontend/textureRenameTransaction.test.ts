import { describe, expect, it } from 'vitest';
import type { ProjectChange } from '../../utils/projectService';
import type { TextureParameterRenamePlan } from '../../texturing/graph/renameProjectParameter';
import {
    commitTextureParameterRename, RenameProjectSyncError,
    undoTextureParameterRename, type RenameProjectHost,
} from '../../texturing/graph/renameTransaction';

const before: ProjectChange[] = [
    { domain: 'materials', operation: 'upsert', id: 'mat', value: { id: 'mat', textureGraph: { values: { wear: 0.3 } } } },
    { domain: 'models', operation: 'upsert', id: 'model', value: { id: 'model', materialOverrides: { Steel: { parameters: [{ name: 'wear', value: 0.3 }] } } } },
];
const after: ProjectChange[] = [
    { domain: 'materials', operation: 'upsert', id: 'mat', value: { id: 'mat', textureGraph: { values: { patina: 0.3 } } } },
    { domain: 'models', operation: 'upsert', id: 'model', value: { id: 'model', materialOverrides: { Steel: { parameters: [{ name: 'patina', value: 0.3 }] } } } },
];
const plan = (): TextureParameterRenamePlan => ({
    impact: {
        sourceMaterialId: 'mat', from: 'wear', to: 'patina', materials: ['mat'], models: ['model'],
        objects: [], metadata: [], nestedNodes: 0, paintReferences: 0, modelOverrides: 1, objectOverrides: 0, sharedPresets: 0,
    },
    changes: after,
    undoChanges: before,
    changedMaterials: [],
});

const makeHost = () => {
    const current = { projectId: 'project-a' as string | null, revision: 12, readOnly: false };
    const calls: ProjectChange[][] = [];
    let fail = false;
    const host: RenameProjectHost = {
        getStatus: () => ({ ...current }),
        applyChanges: async (changes) => {
            calls.push(changes);
            if (fail) throw new Error('Host rejected the transaction');
            current.revision++;
            return { revision: current.revision };
        },
    };
    return { current, calls, host, reject: () => { fail = true; } };
};

describe('M0 project-wide rename commit coordinator', () => {
    it('commits dependent documents in one host transaction, then publishes, with one inverse batch', async () => {
        const { current, calls, host } = makeHost();
        const published: ProjectChange[][] = [];
        const receipt = await commitTextureParameterRename(plan(), host, { projectId: 'project-a', revision: 12 },
            async (changes) => { published.push([...changes]); });
        expect(calls).toEqual([after]);
        expect(published).toEqual([after]);
        expect(receipt).toMatchObject({
            projectId: 'project-a', beforeRevision: 12, afterRevision: 13, undoChanges: before, redoChanges: after,
        });
        expect(current.revision).toBe(13);

        const undoneRevision = await undoTextureParameterRename(receipt, host,
            async (changes) => { published.push([...changes]); });
        expect(undoneRevision).toBe(14);
        expect(calls).toEqual([after, before]);
        expect(published).toEqual([after, before]);
        expect(current.revision).toBe(14);
    });

    it('does not publish changes or trigger a rollback after a rejected host transaction', async () => {
        const { calls, host, reject } = makeHost();
        reject();
        let published = false;
        await expect(commitTextureParameterRename(plan(), host, { projectId: 'project-a', revision: 12 },
            () => { published = true; })).rejects.toThrow(/Host rejected/);
        expect(calls).toEqual([after]);
        expect(published).toBe(false);
    });

    it('refuses stale revisions, project switches and read-only projects before touching the host', async () => {
        const { current, calls, host } = makeHost();
        current.revision++;
        await expect(commitTextureParameterRename(plan(), host, { projectId: 'project-a', revision: 12 },
            () => undefined)).rejects.toThrow(/edited since/);
        current.revision = 12;
        current.projectId = 'other-project';
        await expect(commitTextureParameterRename(plan(), host, { projectId: 'project-a', revision: 12 },
            () => undefined)).rejects.toThrow(/active project changed/);
        current.projectId = 'project-a';
        current.readOnly = true;
        await expect(commitTextureParameterRename(plan(), host, { projectId: 'project-a', revision: 12 },
            () => undefined)).rejects.toThrow(/read-only/);
        expect(calls).toHaveLength(0);
    });

    it('cannot overwrite newer changes through the inverse batch', async () => {
        const { current, calls, host } = makeHost();
        const receipt = await commitTextureParameterRename(plan(), host, { projectId: 'project-a', revision: 12 },
            () => undefined);
        current.revision++;
        await expect(undoTextureParameterRename(receipt, host, () => undefined)).rejects.toThrow(/edited since/);
        expect(calls).toEqual([after]);
    });

    it('reports a committed-but-unsynchronized state instead of blindly retrying or rolling back', async () => {
        const { current, calls, host } = makeHost();
        let count = 0;
        await expect(commitTextureParameterRename(plan(), host, { projectId: 'project-a', revision: 12 },
            () => { count++; throw new Error('React state unavailable'); })).rejects.toBeInstanceOf(RenameProjectSyncError);
        expect(count).toBe(1);
        expect(current.revision).toBe(13);
        expect(calls).toEqual([after]);
    });

    it('rejects an incomplete plan before applying any partial set', async () => {
        const { calls, host } = makeHost();
        const incomplete = plan();
        incomplete.undoChanges = [];
        await expect(commitTextureParameterRename(incomplete, host, { projectId: 'project-a', revision: 12 },
            () => undefined)).rejects.toThrow(/incomplete inverse/);
        expect(calls).toEqual([]);
    });
});
