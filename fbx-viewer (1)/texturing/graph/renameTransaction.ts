import type { ProjectChange } from '../../utils/projectService';
import type { TextureParameterRenamePlan } from './renameProjectParameter';

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
