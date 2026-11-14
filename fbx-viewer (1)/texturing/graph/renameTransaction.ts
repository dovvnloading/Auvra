import type { ProjectChange, ProjectSnapshot } from '../../utils/projectService';
import { readTextureRenameInventory } from './renameSnapshot';
import { planTextureParameterRename, type RenameImpact, type TextureParameterRenamePlan } from './renameProjectParameter';

/**
 * M0.2 — Safe host-bound commit/undo primitive for an exposed texture graph
 * parameter rename. This is deliberately NOT wired into local graph history:
 * a material-only undo cannot restore project models, objects or presets.
 *
 * The caller must construct a plan from an authoritative complete snapshot
 * and pass the snapshot's exact project identity and revision. The host owns
 * the single project.applyChanges transaction and rejects stale revisions.
 */

export interface RenameProjectStatus {
    projectId: string | null;
    revision: number;
    readOnly: boolean;
}

/** Narrow dependency boundary, easy to fake without a real host/browser. */
export interface RenameProjectHost {
    getStatus(): RenameProjectStatus;
    applyChanges(changes: ProjectChange[]): Promise<{ revision?: number } | null>;
}

export interface RenameTransactionReceipt {
    projectId: string;
    /** The source and parameter names are needed to detect NEW dependents on replay. */
    impact: RenameImpact;
    /** Revision when the original plan was computed. */
    beforeRevision: number;
    /** Revision after the one host commit (the only safe immediate undo base). */
    afterRevision: number;
    /** Inverse changes prepared from full document snapshots, not partial edits. */
    undoChanges: ProjectChange[];
    redoChanges: ProjectChange[];
}

export class RenameProjectSyncError extends Error {
    readonly committed = true;

    constructor(message: string, readonly originalFailure: unknown) {
        super(message);
        this.name = 'RenameProjectSyncError';
    }
}

/** Verify session and optimistic concurrency before touching any project data. */
const checkStatus = (
    status: RenameProjectStatus,
    projectId: string,
    revision: number,
): void => {
    if (!projectId || status.projectId !== projectId) {
        throw new Error('The active project changed; the parameter rename was not applied.');
    }
    if (status.readOnly) throw new Error('The project is read-only; the parameter rename was not applied.');
    if (!Number.isSafeInteger(revision) || status.revision !== revision) {
        throw new Error('The project was edited since the rename plan was created; recompute the plan first.');
    }
};

/** Commit once; publish local state only after an acknowledged host transaction. */
const applyBatch = async (
    host: RenameProjectHost,
    projectId: string,
    revision: number,
    changes: ProjectChange[],
    afterCommit: (changes: readonly ProjectChange[]) => void | Promise<void>,
): Promise<number> => {
    checkStatus(host.getStatus(), projectId, revision);
    if (!changes.length) throw new Error('The rename plan has no project changes to apply.');
    const result = await host.applyChanges(changes);
    const now = host.getStatus();
    // A protocol response may carry the revision before its status event has
    // propagated. The response is authoritative when available.
    const nextRevision = result?.revision ?? now.revision;
    if (now.projectId !== projectId) {
        throw new RenameProjectSyncError('The rename was sent but the active project switched; reload to verify saved state.', null);
    }
    if (!Number.isSafeInteger(nextRevision) || nextRevision <= revision) {
        throw new RenameProjectSyncError('The rename response has no advanced project revision; reload to verify the saved project.', null);
    }
    try {
        await afterCommit(changes);
    } catch (failure) {
        // Never issue a blind "rollback" after the host accepted the commit:
        // the revision may already be used by another valid edit.
        throw new RenameProjectSyncError('The rename was saved, but the editor could not refresh its local state. Reload this project before editing.', failure);
    }
    return nextRevision;
};

/**
 * Keep a graph/material/model/object/preset rename in one native host batch.
 * A rejected transaction does not call afterCommit, so the editor's in-memory
 * state can remain unchanged. The caller handles all postcommit domain sync.
 */
export const commitTextureParameterRename = async (
    plan: TextureParameterRenamePlan,
    host: RenameProjectHost,
    expected: { projectId: string; revision: number },
    afterCommit: (changes: readonly ProjectChange[]) => void | Promise<void>,
): Promise<RenameTransactionReceipt> => {
    if (plan.changes.length !== plan.undoChanges.length) throw new Error('The rename plan has incomplete inverse snapshots.');
    const afterRevision = await applyBatch(host, expected.projectId, expected.revision, plan.changes, afterCommit);
    return {
        projectId: expected.projectId,
        impact: plan.impact,
        beforeRevision: expected.revision,
        afterRevision,
        undoChanges: plan.undoChanges,
        redoChanges: plan.changes,
    };
};

/**
 * One safe immediate inverse transaction. If ANY change has happened since
 * commit (including an unrelated save), refuse rather than overwriting it.
 * Application-wide undo/redo integration must manage intervening revisions.
 */
export const undoTextureParameterRename = async (
    receipt: RenameTransactionReceipt,
    host: RenameProjectHost,
    afterCommit: (changes: readonly ProjectChange[]) => void | Promise<void>,
): Promise<number> => applyBatch(host, receipt.projectId, receipt.afterRevision, receipt.undoChanges, afterCommit);

/** A complete, single-revision host snapshot is needed to replay a rename safely. */
export interface RenameSnapshotHost extends RenameProjectHost {
    getSnapshotAll(): Promise<ProjectSnapshot | null>;
}

/**
 * Project-level undo/redo, not graph-local history. An unrelated project save is
 * allowed, but every affected document must still equal the exact value written
 * by the previous rename/undo. Refuse rather than clobbering a later edit.
 *
 * The snapshot validator checks all five reference-bearing domains, including
 * empty domains and saved prefab members, before any write is attempted.
 */
export const replayTextureParameterRename = async (
    receipt: RenameTransactionReceipt,
    direction: 'undo' | 'redo',
    host: RenameSnapshotHost,
    afterCommit: (changes: readonly ProjectChange[]) => void | Promise<void>,
): Promise<number> => {
    const status = host.getStatus();
    checkStatus(status, receipt.projectId, status.revision);
    const snapshot = await host.getSnapshotAll();
    if (!snapshot || snapshot.projectId !== receipt.projectId || snapshot.revision !== status.revision) {
        throw new Error('The project changed while checking the rename history. Nothing was overwritten.');
    }
    const inventory = readTextureRenameInventory(snapshot, null, {
        projectId: receipt.projectId, revision: snapshot.revision,
    });
    const documents: Record<string, ReadonlyMap<string, unknown>> = {
        materials: inventory.materialDocuments,
        models: new Map(inventory.models.map(doc => [doc.id, doc] as const)),
        objects: new Map(inventory.objects.map(doc => [doc.id, doc] as const)),
        prefabs: new Map(inventory.prefabs.map(doc => [doc.id, doc] as const)),
        metadata: new Map(inventory.metadata.map(doc => [doc.id, doc] as const)),
    };
    // Full-document equality protects documents changed by the first rename.
    // It does NOT protect a newly created model, prefab or shared preset that
    // starts consuming the renamed key later. Re-plan against the complete
    // current project so reversing this rename cannot strand new references.
    const impact = receipt.impact;
    const fresh = planTextureParameterRename({
        ...inventory,
        sourceMaterialId: impact.sourceMaterialId,
        from: direction === 'undo' ? impact.to : impact.from,
        to: direction === 'undo' ? impact.from : impact.to,
    });
    const expected = direction === 'undo' ? receipt.redoChanges : receipt.undoChanges;
    const changes = direction === 'undo' ? receipt.undoChanges : receipt.redoChanges;
    if (!expected.length || expected.length !== changes.length) {
        throw new Error('The parameter rename history has incomplete snapshots.');
    }
    const originallyAffected = new Set(expected.map(change => `${change.domain}/${change.id ?? ''}`));
    for (const change of fresh.changes) {
        if (!originallyAffected.has(`${change.domain}/${change.id ?? ''}`)) {
            throw new Error(`Cannot ${direction} parameter rename: a new dependent ${change.domain}/${change.id ?? '(unknown)'} now references the parameter. No documents were overwritten.`);
        }
    }
    for (const change of expected) {
        if (!change.id || change.operation !== 'upsert' || !documents[change.domain]?.has(change.id)
            || JSON.stringify(documents[change.domain].get(change.id)) !== JSON.stringify(change.value)) {
            throw new Error(`Cannot ${direction} parameter rename: ${change.domain}/${change.id ?? '(unknown)'} was edited or removed after the rename. No documents were overwritten.`);
        }
    }
    return applyBatch(host, receipt.projectId, snapshot.revision, changes, afterCommit);
};
