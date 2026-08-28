import { useCallback, useEffect, useRef, useState } from 'react';
import { CameraState } from '../types';
import { ProjectStatus, projectService } from '../utils/projectService';
import { useNotification } from '../context/NotificationContext';
import { dbOperations } from '../utils/db';
import { OperationHandle, useOperationActions } from '../context/OperationContext';

interface UseProjectManagerProps {
  setIsLoading: (loading: boolean) => void;
  cameraState: CameraState;
  setCameraState: (state: CameraState) => void;
  selectedModelId: string | null;
  selectedBlueprintId: string | null;
  selectModel: (id: string | null) => void;
  selectBlueprint: (id: string | null) => void;
  restoreSession: (onProgress?: (progress: number, detail: string) => void, signal?: AbortSignal) => Promise<void>;
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
    projectService.refreshStatus().catch((error) => console.warn('[ProjectManager] Initial host status unavailable', error));
    return unsubscribe;
  }, []);

  const run = useCallback(async (
    label: string,
    operation: (handle: OperationHandle) => Promise<unknown>,
    success: string,
  ) => {
    const handle = startOperation({ label, detail: 'Starting…', progress: null, cancellable: false });
    activeOperation.current = handle;
    setIsLoading(true);
    try {
      await operation(handle);
      addNotification({ message: success, type: 'success' });
    } catch (error) {
      console.error('[ProjectManager] host operation failed', error);
      addNotification({ message: error instanceof Error ? error.message : 'Project operation failed.', type: 'error' });
      throw error;
    } finally {
      if (activeOperation.current?.id === handle.id) activeOperation.current = null;
      handle.finish();
      setIsLoading(false);
    }
  }, [addNotification, setIsLoading, startOperation]);

  const saveProject = useCallback(async () => {
    await run('Saving project', () => projectService.save(), 'Project saved.');
  }, [run]);

  const saveProjectAs = useCallback(async () => {
    await run('Saving project as', () => projectService.saveAs(), 'Project saved as a new project.');
  }, [run]);

  const exportProject = useCallback(async () => {
    await run('Exporting project package', () => projectService.exportPack(), 'Project package exported.');
  }, [run]);

  const importProject = useCallback(async () => {
    await run('Importing project package', async (handle) => {
      await projectService.importPack();
      handle.update({ progress: 0.4, detail: 'Loading imported assets' });
      await restoreSession((progress, detail) => handle.update({ progress: 0.4 + progress * 0.58, detail }));
    }, 'Project package imported.');
  }, [restoreSession, run]);

  const importLegacyProject = useCallback(async () => {
    await run('Importing legacy project', async (handle) => {
      await projectService.importLegacy();
      handle.update({ progress: 0.4, detail: 'Loading migrated assets' });
      await restoreSession((progress, detail) => handle.update({ progress: 0.4 + progress * 0.58, detail }));
    }, 'Legacy project imported.');
  }, [restoreSession, run]);

  const migrateLegacyBrowserProject = useCallback(async () => {
    let migrated = 0;
    await run('Migrating browser project', async (handle) => {
      migrated = await dbOperations.migrateLegacyDatabase();
      handle.update({ progress: 0.4, detail: 'Loading migrated assets' });
      await restoreSession((progress, detail) => handle.update({ progress: 0.4 + progress * 0.58, detail }));
    }, 'Legacy browser project migrated.');
    return migrated;
  }, [restoreSession, run]);

  const loadProject = useCallback(async () => {
    await run('Opening project', async (handle) => {
      const snapshot = await projectService.open();
      handle.update({ progress: 0.4, detail: 'Loading project assets' });
      await restoreSession((progress, detail) => handle.update({ progress: 0.4 + progress * 0.58, detail }));
      const state = snapshot as Record<string, unknown> | null;
      if (state?.cameraState) setCameraState(state.cameraState as CameraState);
      selectModel(typeof state?.selectedModelId === 'string' ? state.selectedModelId : null);
      selectBlueprint(typeof state?.selectedBlueprintId === 'string' ? state.selectedBlueprintId : null);
    }, 'Project opened.');
  }, [restoreSession, run, selectBlueprint, selectModel, setCameraState]);

  const openRecentProject = useCallback(async (projectId: string) => {
    await run('Opening recent project', async (handle) => {
      await projectService.openRecent(projectId);
      handle.update({ progress: 0.4, detail: 'Loading project assets' });
      await restoreSession((progress, detail) => handle.update({ progress: 0.4 + progress * 0.58, detail }));
    }, 'Recent project opened.');
  }, [restoreSession, run]);

  const recoverProject = useCallback(async (recoveryId: string) => {
    await run('Opening recovery point', async (handle) => {
      await projectService.recover(recoveryId);
      handle.update({ progress: 0.4, detail: 'Loading recovered assets' });
      await restoreSession((progress, detail) => handle.update({ progress: 0.4 + progress * 0.58, detail }));
    }, 'Recovery point opened.');
  }, [restoreSession, run]);

  const createNewProject = useCallback(async () => {
    await run('Creating project', async (handle) => {
      await projectService.create();
      await resetScene();
      handle.update({ progress: 0.65, detail: 'Initializing project' });
      await restoreSession((progress, detail) => handle.update({ progress: 0.65 + progress * 0.33, detail }));
    }, 'New project created.');
  }, [resetScene, restoreSession, run]);

  const closeProject = useCallback(async () => {
    await run('Closing project', async () => {
      await projectService.close();
      await resetScene();
    }, 'Project closed.');
  }, [resetScene, run]);

  return {
    saveProject, saveProjectAs, exportProject, importProject, importLegacyProject, migrateLegacyBrowserProject,
    loadProject, openRecentProject, recoverProject, createNewProject, closeProject, projectStatus,
  };
};
