
import { useCallback } from 'react';
import { CameraState } from '../types';
import { projectSerializer } from '../utils/projectSerializer';
import { useNotification } from '../context/NotificationContext';

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
  setIsLoading,
  cameraState,
  setCameraState,
  selectedModelId,
  selectedBlueprintId,
  selectModel,
  selectBlueprint,
  restoreSession,
  resetScene
}: UseProjectManagerProps) => {
  const { addNotification, updateNotification, removeNotification } = useNotification();

  const saveProject = useCallback(async () => {
    setIsLoading(true);
    const notifyId = addNotification({ message: "Starting project export...", type: 'loading', progress: 0 });
    
    try {
        await new Promise(resolve => setTimeout(resolve, 100));

        await projectSerializer.saveProject(
            cameraState,
            selectedModelId,
            selectedBlueprintId,
            (msg, percent) => {
                updateNotification(notifyId, { message: msg, progress: percent });
            }
        );
        
        removeNotification(notifyId);
        addNotification({ message: "Project saved successfully.", type: 'success' });
    } catch (e) {
        console.error("Save failed", e);
        removeNotification(notifyId);
        addNotification({ message: "Failed to save project file.", type: 'error' });
    } finally {
        setIsLoading(false);
    }
  }, [cameraState, selectedModelId, selectedBlueprintId, addNotification, updateNotification, removeNotification, setIsLoading]);

  const loadProject = useCallback(async (file: File) => {
    if (!file.name.endsWith('.forge')) {
        addNotification({ message: "Invalid file type. Please upload a .forge file.", type: 'error' });
        return;
    }

    setIsLoading(true);
    const notifyId = addNotification({ message: "Loading project...", type: 'loading', progress: 0 });

    try {
        await new Promise(resolve => setTimeout(resolve, 50));

        const sceneState = await projectSerializer.loadProject(file, (msg, percent) => {
            updateNotification(notifyId, { message: msg, progress: percent });
        });
        
        updateNotification(notifyId, { message: "Rebuilding scene assets...", progress: 100 });

        await restoreSession();

        if (sceneState.cameraState) {
            setCameraState(sceneState.cameraState);
        }
        
        if (sceneState.selectedModelId) {
           selectModel(sceneState.selectedModelId);
        } else if (sceneState.selectedBlueprintId) {
           selectBlueprint(sceneState.selectedBlueprintId);
        } else {
           selectModel(null);
           selectBlueprint(null);
        }
        
        removeNotification(notifyId);
        addNotification({ message: "Project loaded successfully.", type: 'success' });

    } catch (e: any) {
        console.error("Load failed", e);
        removeNotification(notifyId);
        addNotification({ message: `Failed to load project: ${e.message || 'Unknown error'}`, type: 'error' });
    } finally {
        setIsLoading(false);
    }
  }, [restoreSession, setCameraState, selectModel, selectBlueprint, addNotification, updateNotification, removeNotification, setIsLoading]);

  const createNewProject = useCallback(async () => {
      console.log("%c[ProjectManager] createNewProject started...", "color: orange; font-weight: bold;");
      
      // Execute reset via Context (In-Memory cleanup + DB Truncate)
      // No page reload required.
      await resetScene();
      
  }, [resetScene]);

  return {
    saveProject,
    loadProject,
    createNewProject
  };
};
