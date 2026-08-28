import { useCallback, useEffect, useRef, useState } from 'react';
import { CameraState } from '../types';
import { ProjectStatus, projectService } from '../utils/projectService';
import { useNotification } from '../context/NotificationContext';
import { dbOperations } from '../utils/db';
import { OperationHandle, useOperationActions } from '../context/OperationContext';
import { frontendDiagnostics, type DiagnosticAttributes, type DiagnosticContext } from '../diagnostics/runtime';

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
  restoreSession: (onProgress?: HydrationProgress, signal?: AbortSignal, diagnostics?: DiagnosticContext) => Promise<void>;
  resetScene: () => Promise<void>;
}

export const useProjectManager = ({
  setIsLoading, cameraState, setCameraState, selectedModelId,
  selectedBlueprintId, selectModel, selectBlueprint, restoreSession, resetScene,
}: UseProjectManagerProps) => {
  const { addNotification } = useNotification();
  const { startOperation } = useOperationActions();
  const [projectStatus, setProjectStatus] = useState<ProjectStatus>(projectService.getStatus());
  const activeOperation = useRef<OperationHandle | null>(null);

  useEffect(() => {
    const unsubscribe = projectService.subscribe((status) => {
      setProjectStatus(status);
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
    operation: (handle: OperationHandle) => Promise<unknown>,
    success: string,
  ) => {
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
      await operation(handle);
      addNotification({ message: success, type: 'success' });
    } catch (error) {
      outcome = 'failure';
      failure = error;
      addNotification({ message: error instanceof Error ? error.message : 'Project operation failed.', type: 'error' });
      throw error;
    } finally {
      if (activeOperation.current?.id === handle.id) activeOperation.current = null;
      handle.finish(outcome, failure);
      setIsLoading(false);
    }
  }, [addNotification, setIsLoading, startOperation]);

  const contextFor = useCallback((handle: OperationHandle): DiagnosticContext => ({
    operationId: handle.id,
    traceId: handle.traceId,
  }), []);

  const hydrate = useCallback(async (handle: OperationHandle, base: number, span: number) => {
    handle.update({ phase: 'project_hydration', progress: base, detail: 'Loading project assets' });
    await restoreSession((progress, detail, phase, diagnostic) => handle.update({
      progress: base + progress * span,
      detail,
      ...(phase ? { phase } : {}),
      ...(diagnostic ? { diagnostic } : {}),
    }), handle.signal, contextFor(handle));
  }, [contextFor, restoreSession]);

  const saveProject = useCallback(async () => {
    await run('project.save', 'Saving project', (handle) => projectService.save(contextFor(handle)), 'Project saved.');
  }, [contextFor, run]);

  const saveProjectAs = useCallback(async () => {
    await run('project.save_as', 'Saving project as', (handle) => projectService.saveAs(undefined, contextFor(handle)), 'Project saved as a new project.');
  }, [contextFor, run]);

  const exportProject = useCallback(async () => {
    await run('project.export', 'Exporting project package', (handle) => projectService.exportPack(contextFor(handle)), 'Project package exported.');
  }, [contextFor, run]);

  const importProject = useCallback(async () => {
    await run('project.import', 'Importing project package', async (handle) => {
      await projectService.importPack(contextFor(handle));
      await hydrate(handle, 0.4, 0.58);
    }, 'Project package imported.');
  }, [contextFor, hydrate, run]);

  const importLegacyProject = useCallback(async () => {
    await run('project.import_legacy', 'Importing legacy project', async (handle) => {
      await projectService.importLegacy(contextFor(handle));
      await hydrate(handle, 0.4, 0.58);
    }, 'Legacy project imported.');
  }, [contextFor, hydrate, run]);

  const migrateLegacyBrowserProject = useCallback(async () => {
    let migrated = 0;
    await run('project.migrate_legacy', 'Migrating browser project', async (handle) => {
      migrated = await dbOperations.migrateLegacyDatabase();
      await hydrate(handle, 0.4, 0.58);
    }, 'Legacy browser project migrated.');
    return migrated;
  }, [hydrate, run]);

  const loadProject = useCallback(async () => {
    await run('project.open', 'Opening project', async (handle) => {
      const snapshot = await projectService.open(undefined, contextFor(handle));
      await hydrate(handle, 0.4, 0.58);
      const state = snapshot as Record<string, unknown> | null;
      if (state?.cameraState) setCameraState(state.cameraState as CameraState);
      selectModel(typeof state?.selectedModelId === 'string' ? state.selectedModelId : null);
      selectBlueprint(typeof state?.selectedBlueprintId === 'string' ? state.selectedBlueprintId : null);
    }, 'Project opened.');
  }, [contextFor, hydrate, run, selectBlueprint, selectModel, setCameraState]);

  const openRecentProject = useCallback(async (projectId: string) => {
    await run('project.open_recent', 'Opening recent project', async (handle) => {
      await projectService.openRecent(projectId, undefined, contextFor(handle));
      await hydrate(handle, 0.4, 0.58);
    }, 'Recent project opened.');
  }, [contextFor, hydrate, run]);

  const recoverProject = useCallback(async (recoveryId: string) => {
    await run('project.recover', 'Opening recovery point', async (handle) => {
      await projectService.recover(recoveryId, contextFor(handle));
      await hydrate(handle, 0.4, 0.58);
    }, 'Recovery point opened.');
  }, [contextFor, hydrate, run]);

  const createNewProject = useCallback(async () => {
    await run('project.create', 'Creating project', async (handle) => {
      await projectService.create('Untitled', contextFor(handle));
      await resetScene();
      await hydrate(handle, 0.65, 0.33);
    }, 'New project created.');
  }, [contextFor, hydrate, resetScene, run]);

  const closeProject = useCallback(async () => {
    await run('project.close', 'Closing project', async (handle) => {
      await projectService.close(contextFor(handle));
      await resetScene();
    }, 'Project closed.');
  }, [contextFor, resetScene, run]);

  return {
    saveProject, saveProjectAs, exportProject, importProject, importLegacyProject, migrateLegacyBrowserProject,
    loadProject, openRecentProject, recoverProject, createNewProject, closeProject, projectStatus,
  };
};
