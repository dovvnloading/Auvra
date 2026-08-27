import { CameraState } from '../types';
import { projectService, ProjectSnapshot } from './projectService';

/** @deprecated Project persistence is owned by the native host. */
export interface SceneState {
  cameraState?: CameraState;
  selectedModelId?: string | null;
  selectedBlueprintId?: string | null;
}

export type ProgressCallback = (message: string, percent: number) => void;

/** Compatibility facade. Archive and browser download logic now lives in the host. */
export class ProjectSerializer {
  async saveProject(_camera?: CameraState, _selectedModelId?: string | null, _selectedBlueprintId?: string | null, onProgress?: ProgressCallback): Promise<void> {
    onProgress?.('Saving project…', 10);
    await projectService.save();
    onProgress?.('Project saved.', 100);
  }

  async loadProject(_file?: unknown, onProgress?: ProgressCallback): Promise<SceneState> {
    onProgress?.('Opening project…', 10);
    const snapshot = await projectService.open();
    onProgress?.('Project opened.', 100);
    return snapshotToSceneState(snapshot);
  }
}

function snapshotToSceneState(snapshot: ProjectSnapshot | null): SceneState {
  if (!snapshot) return {};
  const candidate = snapshot as Record<string, unknown>;
  return {
    cameraState: candidate.cameraState as CameraState | undefined,
    selectedModelId: typeof candidate.selectedModelId === 'string' ? candidate.selectedModelId : null,
    selectedBlueprintId: typeof candidate.selectedBlueprintId === 'string' ? candidate.selectedBlueprintId : null,
  };
}

export const projectSerializer = new ProjectSerializer();
