import type { TerrainData, TerrainHeightfieldReference } from '../types';
import { projectService } from './projectService';
import { frontendDiagnostics } from '../diagnostics/runtime';
import {
  decodeTerrainHeightfield,
  encodeTerrainHeightfield,
  terrainSamplesPerSide,
  TERRAIN_HEIGHTFIELD_ENCODING,
  TERRAIN_HEIGHTFIELD_MIME,
} from './terrainHeightfieldCodec';

/**
 * Terrain heightfields are binary, content-addressed project assets. A level
 * object document carries only a small reference, so a sculpted 512x512
 * terrain neither exceeds the host message limit nor inflates the paged
 * objects snapshot that every level read depends on.
 */
export const TERRAIN_HEIGHTFIELD_FILE_NAME = 'terrain-heightfield.bin';

export type TerrainHeightfieldUploader = (file: File) => Promise<string>;
export type TerrainHeightfieldLoader = (assetId: string) => Promise<ArrayBuffer>;

// Arrays decoded from, or committed as, a known asset. Lets an unchanged
// terrain be rewritten (e.g. a texture change) without another upload.
const knownHeightfields = new WeakMap<readonly number[], TerrainHeightfieldReference>();
const pendingResolutions = new Map<string, Promise<number[]>>();

const uploadHeightfield: TerrainHeightfieldUploader = (file) => projectService.uploadAsset(file);

const loadHeightfield: TerrainHeightfieldLoader = async (assetId) => {
  const url = await projectService.resolveAsset(assetId);
  const response = await fetch(url, { method: 'GET' });
  if (!response.ok) throw new Error(`Terrain heightfield download failed (${response.status})`);
  return response.arrayBuffer();
};

/**
 * Convert in-memory terrain data into its persisted reference form. Inline
 * heights (from a sculpt stroke or a legacy document) are uploaded as a
 * heightfield asset; an unresolved reference is kept as is. `remember` must be
 * called only after the document referencing the asset has been committed.
 */
export async function externalizeTerrainData(
  terrain: TerrainData,
  upload: TerrainHeightfieldUploader = uploadHeightfield,
): Promise<{ terrainData: TerrainData; remember?: () => void }> {
  const { heights, heightfield, ...rest } = terrain;
  if (!heights || heights.length === 0) {
    return { terrainData: heightfield ? { ...rest, heightfield } : rest };
  }
  const columns = terrainSamplesPerSide(terrain.resolution);
  const rows = columns;
  const known = knownHeightfields.get(heights);
  if (known && known.columns === columns && known.rows === rows) {
    return { terrainData: { ...rest, heightfield: known } };
  }
  return frontendDiagnostics.runAsync('terrain_heightfield', 'upload', async () => {
    const bytes = encodeTerrainHeightfield(heights, columns, rows);
    const assetId = await upload(new File([bytes], TERRAIN_HEIGHTFIELD_FILE_NAME, { type: TERRAIN_HEIGHTFIELD_MIME }));
    const reference: TerrainHeightfieldReference = { assetId, encoding: TERRAIN_HEIGHTFIELD_ENCODING, columns, rows };
    return {
      terrainData: { ...rest, heightfield: reference },
      remember: () => { knownHeightfields.set(heights, reference); },
    };
  });
}

/** Load and decode a referenced heightfield. Concurrent requests share one read. */
export function resolveTerrainHeightfield(
  reference: TerrainHeightfieldReference,
  load: TerrainHeightfieldLoader = loadHeightfield,
): Promise<number[]> {
  const key = `${reference.assetId}:${reference.columns}x${reference.rows}`;
  const pending = pendingResolutions.get(key);
  if (pending) return pending;
  const resolution = frontendDiagnostics.runAsync('terrain_heightfield', 'resolve', async () => {
    if (reference.encoding !== TERRAIN_HEIGHTFIELD_ENCODING) throw new Error('Terrain heightfield encoding is not supported');
    const heights = decodeTerrainHeightfield(await load(reference.assetId), reference);
    knownHeightfields.set(heights, reference);
    return heights;
  }).finally(() => { pendingResolutions.delete(key); });
  pendingResolutions.set(key, resolution);
  return resolution;
}
