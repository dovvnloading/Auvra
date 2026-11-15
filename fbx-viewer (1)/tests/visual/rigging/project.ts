import type { SceneContextType } from '../../../types';

// Only the project boundary is replaced. Applying a rig returns its file to the test for independent decoding.
type TestProject = Pick<SceneContextType, 'readModelSource' | 'readModelSourceImages' | 'reimportModel' | 'placeInScene'>;
let services: TestProject;
export const useScene = () => ({ ...services, projectStatus: { readOnly: false } });
export const setTestProject = (value: TestProject) => { services = value; };
