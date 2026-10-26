import { projectService } from '../../../utils/projectService';
import type { TerrainPaintState } from './terrainSplatCodec';
import {
  externalizeTerrainSplat as externalizeTerrainSplatWith,
  resolveTerrainSplatmap as resolveTerrainSplatmapWith,
  type ExternalizedTerrainSplat,
  type TerrainSplatLoader,
  type TerrainSplatmapReference,
  type TerrainSplatUploader,
} from './terrainSplat';

/**
 * Editor bindings for terrain splat maps: like heightfields (see
 * utils/terrainHeightfieldEditor.ts) they are uploaded to, and read from, the
 * open project. Diagnostics are recorded by the storage-agnostic functions in
 * terrainSplat.ts.
 */
const uploadSplatmap: TerrainSplatUploader = (file) => projectService.uploadAsset(file);

const loadSplatmap: TerrainSplatLoader = async (assetId) => {
  const url = await projectService.resolveAsset(assetId);
  const response = await fetch(url, { method: 'GET' });
  if (!response.ok) throw new Error(`Terrain splat map download failed (${response.status})`);
  return response.arrayBuffer();
};

/** externalizeTerrainSplat that uploads to the open project unless told otherwise. */
export function externalizeTerrainSplat<T extends TerrainPaintState>(
  terrain: T,
  { storedSplatmap, upload = uploadSplatmap }: {
    storedSplatmap?: () => Promise<TerrainSplatmapReference | undefined>;
    upload?: TerrainSplatUploader;
  } = {},
): Promise<{ terrainData: ExternalizedTerrainSplat<T>; remember?: () => void }> {
  return externalizeTerrainSplatWith(terrain, { storedSplatmap, upload });
}

/** resolveTerrainSplatmap that reads from the open project unless told otherwise. */
export function resolveTerrainSplatmap(
  reference: TerrainSplatmapReference,
  load: TerrainSplatLoader = loadSplatmap,
): Promise<number[]> {
  return resolveTerrainSplatmapWith(reference, load);
}
