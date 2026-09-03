import { useCallback, useEffect, useRef, useState } from 'react';
import { CameraState } from '../types';
import { ProjectStatus, projectService } from '../utils/projectService';
import { useNotification } from '../context/NotificationContext';
import { dbOperations } from '../utils/db';
import { OperationHandle, useOperationActions } from '../context/OperationContext';
import { frontendDiagnostics, type DiagnosticAttributes, type DiagnosticContext } from '../diagnostics/runtime';
import { editorSession, type EditorSessionTransition } from '../utils/editorSession';

type HydrationProgress = (
  progress: number,
  detail: string,
  phase?: string,
  diagnostic?: DiagnosticAttributes,
) => void;

interface UseProjectManagerProps {
  setIsLoading: (loading: boolean) => void;
  cameraState: CameraState;
  setCameraState: (state: CameraState) => void;
  selectedModelId: string | null;
  selectedBlueprintId: string | null;
  selectModel: (id: string | null) => void;
  selectBlueprint: (id: string | null) => void;
  restoreSession: (onProgress?: HydrationProgress, signal?: AbortSignal, diagnostics?: DiagnosticContext, transition?: EditorSessionTransition) => Promise<void>;
  resetScene: () => Promise<void>;
  getCurrentLevelId: () => string | null;
}

export const useProjectManager = ({
  setIsLoading, cameraState, setCameraState, selectedModelId,
  selectedBlueprintId, selectModel, selectBlueprint, restoreSession, resetScene,
  getCurrentLevelId,
}: UseProjectManagerProps) => {
  const { addNotification } = useNotification();
  const { startOperation } = useOperationActions();
  const [projectStatus, setProjectStatus] = useState<ProjectStatus>(projectService.getStatus());
  const activeOperation = useRef<OperationHandle | null>(null);

  useEffect(() => {
    const unsubscribe = projectService.subscribe((status) => {
      setProjectStatus(status);
      const session = editorSession.getSnapshot();
      if (session.phase === 'ready' && status.projectId !== session.projectId) {
        const invalidated = editorSession.beginTransition();
        editorSession.close(invalidated);
      } else {
        editorSession.advanceRevision(status.projectId, status.revision);
      }
      if (activeOperation.current && typeof status.progress === 'number') {
        activeOperation.current.update({ progress: status.progress * 0.38, detail: 'Preparing project repository' });
      }
    });
    projectService.refreshStatus().catch((error) => frontendDiagnostics.failure('project_status_unavailable', error));
    return unsubscribe;
  }, []);

  const run = useCallback(async (
    kind: string,
    label: string,
    operation: (handle: OperationHandle, transition: EditorSessionTransition | null) => Promise<unknown>,
    success: string,
    transitionKind?: 'replace' | 'close',
  ) => {
    // This is deliberately before the first host operation. It synchronously
    // invalidates every old World Editor lease, including delayed writes.
    const transition: EditorSessionTransition | null = transitionKind ? editorSession.beginTransition() : null;
    const handle = startOperation({
      kind,
      phase: 'host_request',
      label,
      detail: 'Starting…',
      progress: null,
      cancellable: false,
    });
    activeOperation.current = handle;
    let outcome: 'success' | 'failure' = 'success';
    let failure: unknown;
    setIsLoading(true);
    try {
      await operation(handle, transition);
      if (transition) {
        const status = projectService.getStatus();
        if (transitionKind === 'close') {
          if (status.projectId) throw new Error('Project close did not clear the authoritative project status.');
          if (!editorSession.close(transition)) throw new Error('Project close transition was superseded.');
        } else if (status.projectId) {
          if (!editorSession.complete(transition, status.projectId, getCurrentLevelId(), status.revision)) {
            throw new Error('Project transition was superseded.');
          }
        } else {
          throw new Error('Project transition did not produce a ready project.');
        }
      }
      addNotification({ message: success, type: 'success' });
    } catch (error) {
      outcome = 'failure';
      failure = error;
      if (transition) editorSession.fail(transition);
      addNotification({ message: error instanceof Error ? error.message : 'Project operation failed.', type: 'error' });
      throw error;
    } finally {
      const ownsLoadingState = activeOperation.current?.id === handle.id;
      if (ownsLoadingState) activeOperation.current = null;
      handle.finish(outcome, failure);
      if (ownsLoadingState) setIsLoading(false);
    }
  }, [addNotification, getCurrentLevelId, setIsLoading, startOperation]);

  const contextFor = useCallback((handle: OperationHandle): DiagnosticContext => ({
    operationId: handle.id,
    traceId: handle.traceId,
    spanId: handle.spanId,
  }), []);

  const hydrate = useCallback(async (handle: OperationHandle, base: number, span: number, transition: EditorSessionTransition | null) => {
    handle.update({ phase: 'project_hydration', progress: base, detail: 'Loading project assets' });
    await restoreSession((progress, detail, phase, diagnostic) => handle.update({
      progress: base + progress * span,
      detail,
      ...(phase ? { phase } : {}),
      ...(diagnostic ? { diagnostic } : {}),
    }), handle.signal, contextFor(handle), transition || undefined);
  }, [contextFor, restoreSession]);

  const saveProject = useCallback(async () => {
    await run('project.save', 'Saving project', (handle) => projectService.save(contextFor(handle)), 'Project saved.');
  }, [contextFor, run]);

  const saveProjectAs = useCallback(async () => {
    await run('project.save_as', 'Saving project as', async (handle, transition) => {
      await projectService.saveAs(undefined, contextFor(handle));
      if (transition && !editorSession.isTransitionCurrent(transition)) {
        throw new DOMException('Project save as was superseded.', 'AbortError');
      }
      await hydrate(handle, 0.4, 0.58, transition);
    }, 'Project saved as a new project.', 'replace');
  }, [contextFor, hydrate, run]);

  const exportProject = useCallback(async () => {
    await run('project.export', 'Exporting project package', (handle) => projectService.exportPack(contextFor(handle)), 'Project package exported.');
  }, [contextFor, run]);

  const importProject = useCallback(async () => {
    await run('project.import', 'Importing project package', async (handle, transition) => {
      await projectService.importPack(contextFor(handle));
      if (transition && !editorSession.isTransitionCurrent(transition)) throw new DOMException('Project import was superseded.', 'AbortError');
      await hydrate(handle, 0.4, 0.58, transition);
    }, 'Project package imported.', 'replace');
  }, [contextFor, hydrate, run]);

  const importLegacyProject = useCallback(async () => {
    await run('project.import_legacy', 'Importing legacy project', async (handle, transition) => {
      await projectService.importLegacy(contextFor(handle));
      if (transition && !editorSession.isTransitionCurrent(transition)) throw new DOMException('Project import was superseded.', 'AbortError');
      await hydrate(handle, 0.4, 0.58, transition);
    }, 'Legacy project imported.', 'replace');
  }, [contextFor, hydrate, run]);

  const migrateLegacyBrowserProject = useCallback(async () => {
    let migrated = 0;
    await run('project.migrate_legacy', 'Migrating browser project', async (handle, transition) => {
      migrated = await dbOperations.migrateLegacyDatabase();
      if (transition && !editorSession.isTransitionCurrent(transition)) throw new DOMException('Project migration was superseded.', 'AbortError');
      await hydrate(handle, 0.4, 0.58, transition);
    }, 'Legacy browser project migrated.', 'replace');
    return migrated;
  }, [hydrate, run]);

  const loadProject = useCallback(async () => {
    await run('project.open', 'Opening project', async (handle, transition) => {
      const snapshot = await projectService.open(undefined, contextFor(handle));
      if (transition && !editorSession.isTransitionCurrent(transition)) throw new DOMException('Project open was superseded.', 'AbortError');
      await hydrate(handle, 0.4, 0.58, transition);
      const state = snapshot as Record<string, unknown> | null;
      if (state?.cameraState) setCameraState(state.cameraState as CameraState);
      selectModel(typeof state?.selectedModelId === 'string' ? state.selectedModelId : null);
      selectBlueprint(typeof state?.selectedBlueprintId === 'string' ? state.selectedBlueprintId : null);
    }, 'Project opened.', 'replace');
  }, [contextFor, hydrate, run, selectBlueprint, selectModel, setCameraState]);

  const openRecentProject = useCallback(async (projectId: string) => {
    await run('project.open_recent', 'Opening recent project', async (handle, transition) => {
      await projectService.openRecent(projectId, undefined, contextFor(handle));
      if (transition && !editorSession.isTransitionCurrent(transition)) throw new DOMException('Project open was superseded.', 'AbortError');
      await hydrate(handle, 0.4, 0.58, transition);
    }, 'Recent project opened.', 'replace');
  }, [contextFor, hydrate, run]);

  const recoverProject = useCallback(async (recoveryId: string) => {
    await run('project.recover', 'Opening recovery point', async (handle, transition) => {
      await projectService.recover(recoveryId, contextFor(handle));
      if (transition && !editorSession.isTransitionCurrent(transition)) throw new DOMException('Project recovery was superseded.', 'AbortError');
      await hydrate(handle, 0.4, 0.58, transition);
    }, 'Recovery point opened.', 'replace');
  }, [contextFor, hydrate, run]);

  const createNewProject = useCallback(async () => {
    await run('project.create', 'Creating project', async (handle, transition) => {
      await projectService.create('Untitled', contextFor(handle));
      if (transition && !editorSession.isTransitionCurrent(transition)) throw new DOMException('Project creation was superseded.', 'AbortError');
      await hydrate(handle, 0.65, 0.33, transition);
    }, 'New project created.', 'replace');
  }, [contextFor, hydrate, run]);

  const closeProject = useCallback(async () => {
    await run('project.close', 'Closing project', async (handle) => {
      await projectService.close(contextFor(handle));
      await resetScene();
    }, 'Project closed.', 'close');
  }, [contextFor, resetScene, run]);

  return frontendDiagnostics.traceActions('project_manager', {
    saveProject, saveProjectAs, exportProject, importProject, importLegacyProject, migrateLegacyBrowserProject,
    loadProject, openRecentProject, recoverProject, createNewProject, closeProject, projectStatus,
  });
};
