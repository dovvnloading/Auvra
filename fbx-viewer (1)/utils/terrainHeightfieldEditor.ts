import type { TerrainData, TerrainHeightfieldReference } from '../types';
import { projectService } from './projectService';
import {
  externalizeTerrainData as externalizeTerrainDataWith,
  resolveTerrainHeightfield as resolveTerrainHeightfieldWith,
  type TerrainHeightfieldLoader,
  type TerrainHeightfieldUploader,
} from './terrainHeightfield';

/**
 * Editor bindings for terrain heightfields: by default they are uploaded to,
 * and read from, the open project. Diagnostics are recorded by the
 * storage-agnostic functions in terrainHeightfield.ts.
 */
const uploadHeightfield: TerrainHeightfieldUploader = (file) => projectService.uploadAsset(file);

const loadHeightfield: TerrainHeightfieldLoader = async (assetId) => {
  const url = await projectService.resolveAsset(assetId);
  const response = await fetch(url, { method: 'GET' });
  if (!response.ok) throw new Error(`Terrain heightfield download failed (${response.status})`);
  return response.arrayBuffer();
};

/** externalizeTerrainData that uploads to the open project unless told otherwise. */
export function externalizeTerrainData(
  terrain: TerrainData,
  { storedHeightfield, upload = uploadHeightfield }: {
    storedHeightfield?: () => Promise<TerrainHeightfieldReference | undefined>;
    upload?: TerrainHeightfieldUploader;
  } = {},
): Promise<{ terrainData: TerrainData; remember?: () => void }> {
  return externalizeTerrainDataWith(terrain, { storedHeightfield, upload });
}

/** resolveTerrainHeightfield that reads from the open project unless told otherwise. */
export function resolveTerrainHeightfield(
  reference: TerrainHeightfieldReference,
  load: TerrainHeightfieldLoader = loadHeightfield,
): Promise<number[]> {
  return resolveTerrainHeightfieldWith(reference, load);
}
