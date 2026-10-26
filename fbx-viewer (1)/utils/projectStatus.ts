/** Host project status, shared by the editor without importing the host transport. */
export interface ProjectStatus {
  projectId: string | null;
  name: string | null;
  revision: number;
  dirty: boolean;
  readOnly: boolean;
  busy: boolean;
  progress: number | null;
  recoveryAvailable: boolean;
  recoveryPoints: Array<{ recoveryId: string; kind: 'manual' | 'autosave'; size?: number }>;
  recentProjects: Array<{ projectId: string; name: string }>;
}
