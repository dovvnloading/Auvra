import { frontendDiagnostics } from '../../diagnostics/runtime';
import { materialAssetDocument, materialLibrary, MATERIALS_DOMAIN, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import { editorSession } from '../../utils/editorSession';
import { projectService } from '../../utils/projectService';

/** Debounced material edits belong to the project that produced them. The queue
 * outlives the tab so a project close can await its last write or retry a failure. */
interface PendingEdit {
    asset: MaterialAsset;
    projectId: string;
    generation: number;
    report: (failure: unknown | null) => void;
}

const pending = new Map<string, PendingEdit>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let draining: Promise<void> | undefined;

const current = (edit: Pick<PendingEdit, 'projectId' | 'generation'>) =>
    edit.projectId === projectService.getStatus().projectId && edit.generation === materialLibrary.generation;

export const canSaveMaterialEditorEdit = (projectId: string | null, generation: number): boolean =>
    !!projectId && current({ projectId, generation }) && editorSession.captureReady()?.projectId === projectId;

async function drain(): Promise<void> {
    for (const [id, edit] of pending) {
        if (!current(edit)) {
            pending.delete(id);
            continue;
        }
        try {
            await projectService.applyChanges([{ domain: MATERIALS_DOMAIN, operation: 'upsert', id, value: materialAssetDocument(edit.asset) }]);
        } catch (error) {
            if (pending.get(id) !== edit) continue; // A later edit superseded this one.
            if (!current(edit)) { pending.delete(id); continue; }
            frontendDiagnostics.failure('material_save_failed', error);
            edit.report(error);
            throw error; // Retain for a retry while the same project is open.
        }
        if (pending.get(id) === edit) {
            pending.delete(id);
            if (current(edit)) edit.report(null);
        }
    }
}

export async function flushMaterialEditorWrites(): Promise<void> {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    while (pending.size || draining) {
        if (!draining) draining = drain().finally(() => { draining = undefined; });
        await draining;
    }
}

export function saveMaterialEditorEdit(
    asset: MaterialAsset, projectId: string | null, generation: number,
    immediately: boolean, report: PendingEdit['report'],
): Promise<boolean> {
    if (!projectId || !canSaveMaterialEditorEdit(projectId, generation)) {
        report(new Error('The project that owned this material edit is no longer open for editing.'));
        return Promise.resolve(false);
    }
    pending.set(asset.id, { asset, projectId, generation, report });
    clearTimeout(timers.get(asset.id));
    if (immediately) return flushMaterialEditorWrites().then(() => current({ projectId, generation }), () => false);
    timers.set(asset.id, setTimeout(() => { void flushMaterialEditorWrites().catch(() => undefined); }, 400));
    return Promise.resolve(true);
}

export function cancelMaterialEditorWrite(id: string, projectId: string | null, generation: number): void {
    const edit = pending.get(id);
    if (edit && edit.projectId === projectId && edit.generation === generation) {
        clearTimeout(timers.get(id));
        timers.delete(id);
        pending.delete(id);
    }
}
