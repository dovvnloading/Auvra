import { useCallback, useEffect, useState } from 'react';
import { CameraState } from '../types';
import { ProjectStatus, projectService } from '../utils/projectService';
import { useNotification } from '../context/NotificationContext';
import { dbOperations } from '../utils/db';

interface UseProjectManagerProps {
  setIsLoading: (loading: boolean) => void;
  cameraState: CameraState;
  setCameraState: (state: CameraState) => void;
  selectedModelId: string | null;
  selectedBlueprintId: string | null;
  selectModel: (id: string | null) => void;
  selectBlueprint: (id: string | null) => void;
  restoreSession: () => Promise<void>;
  resetScene: () => Promise<void>;
}

export const useProjectManager = ({
  setIsLoading, cameraState, setCameraState, selectedModelId,
  selectedBlueprintId, selectModel, selectBlueprint, restoreSession, resetScene,
}: UseProjectManagerProps) => {
  const { addNotification } = useNotification();
  const [projectStatus, setProjectStatus] = useState<ProjectStatus>(projectService.getStatus());

  useEffect(() => {
    const unsubscribe = projectService.subscribe(setProjectStatus);
    projectService.refreshStatus().catch((error) => console.warn('[ProjectManager] Initial host status unavailable', error));
    return unsubscribe;
  }, []);

  const run = useCallback(async (operation: () => Promise<unknown>, success: string) => {
    setIsLoading(true);
    try {
      await operation();
      addNotification({ message: success, type: 'success' });
    } catch (error) {
      console.error('[ProjectManager] host operation failed', error);
      addNotification({ message: error instanceof Error ? error.message : 'Project operation failed.', type: 'error' });
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [addNotification, setIsLoading]);

  const saveProject = useCallback(async () => {
    await run(() => projectService.save(), 'Project saved.');
  }, [run]);

  const saveProjectAs = useCallback(async () => {
    await run(() => projectService.saveAs(), 'Project saved as a new project.');
  }, [run]);

  const exportProject = useCallback(async () => {
    await run(() => projectService.exportPack(), 'Project package exported.');
  }, [run]);

  const importProject = useCallback(async () => {
    await run(async () => {
      await projectService.importPack();
      await restoreSession();
    }, 'Project package imported.');
  }, [restoreSession, run]);

  const importLegacyProject = useCallback(async () => {
    await run(async () => {
      await projectService.importLegacy();
      await restoreSession();
    }, 'Legacy project imported.');
  }, [restoreSession, run]);

  const migrateLegacyBrowserProject = useCallback(async () => {
    let migrated = 0;
    await run(async () => {
      migrated = await dbOperations.migrateLegacyDatabase();
      await restoreSession();
    }, 'Legacy browser project migrated.');
    return migrated;
  }, [restoreSession, run]);

  const loadProject = useCallback(async () => {
    await run(async () => {
      const snapshot = await projectService.open();
      await restoreSession();
      const state = snapshot as Record<string, unknown> | null;
      if (state?.cameraState) setCameraState(state.cameraState as CameraState);
      selectModel(typeof state?.selectedModelId === 'string' ? state.selectedModelId : null);
      selectBlueprint(typeof state?.selectedBlueprintId === 'string' ? state.selectedBlueprintId : null);
    }, 'Project opened.');
  }, [restoreSession, run, selectBlueprint, selectModel, setCameraState]);

  const openRecentProject = useCallback(async (projectId: string) => {
    await run(async () => {
      await projectService.openRecent(projectId);
      await restoreSession();
    }, 'Recent project opened.');
  }, [restoreSession, run]);

  const recoverProject = useCallback(async (recoveryId: string) => {
    await run(async () => {
      await projectService.recover(recoveryId);
      await restoreSession();
    }, 'Recovery point opened.');
  }, [restoreSession, run]);

  const createNewProject = useCallback(async () => {
    await run(async () => {
      await projectService.create();
      await resetScene();
      await restoreSession();
    }, 'New project created.');
  }, [resetScene, restoreSession, run]);

  const closeProject = useCallback(async () => {
    await run(async () => {
      await projectService.close();
      await resetScene();
    }, 'Project closed.');
  }, [resetScene, run]);

  return {
    saveProject, saveProjectAs, exportProject, importProject, importLegacyProject, migrateLegacyBrowserProject,
    loadProject, openRecentProject, recoverProject, createNewProject, closeProject, projectStatus,
  };
};
