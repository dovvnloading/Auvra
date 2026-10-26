import { frontendDiagnostics } from '../../../diagnostics/runtime';
import { terrainSamplesPerSide } from '../../../utils/terrainHeightfieldCodec';
import {
  decodeTerrainSplat,
  encodeTerrainSplat,
  normalizeTerrainLayers,
  TERRAIN_SPLATMAP_ENCODING,
  TERRAIN_SPLATMAP_FILE_NAME,
  TERRAIN_SPLATMAP_MIME,
  type TerrainPaintState,
} from './terrainSplatCodec';

/**
 * Terrain splat maps (the per-sample weights of up to four texture layers)
 * are binary, content-addressed project assets stored next to the terrain
 * heightfield. A level object document carries only a small reference.
 *
 * This module is storage-agnostic so the standalone player can resolve splat
 * maps from a game pack; the editor binds it to the open project in
 * terrainSplatEditor.ts.
 */
export interface TerrainSplatmapReference {
  assetId: string;
  encoding: typeof TERRAIN_SPLATMAP_ENCODING;
  columns: number;
  rows: number;
}

/** Persisted terrain data: inline weights replaced by their splat map reference. */
export type ExternalizedTerrainSplat<T extends TerrainPaintState> = Omit<T, 'splat'> & { splatmap?: TerrainSplatmapReference };

export type TerrainSplatUploader = (file: File) => Promise<string>;
export type TerrainSplatLoader = (assetId: string) => Promise<ArrayBuffer>;

// Arrays decoded from, or committed as, a known asset. Lets an unchanged
// terrain be rewritten (e.g. a move or a layer change) without another upload.
const knownSplats = new WeakMap<readonly number[], TerrainSplatmapReference>();
const pendingResolutions = new Map<string, Promise<number[]>>();

const sameSplatmap = (a: TerrainSplatmapReference, b: TerrainSplatmapReference | undefined): boolean =>
  Boolean(b && a.assetId === b.assetId && a.encoding === b.encoding && a.columns === b.columns && a.rows === b.rows);

/**
 * Convert in-memory terrain data into its persisted form: inline weights
 * (from a paint stroke) are uploaded as a splat map asset and replaced by its
 * reference, an unresolved reference is kept as is, and texture layers are
 * normalised. `storedSplatmap` reads the splat map of the document being
 * replaced, if any. `remember` must be called only after the document
 * referencing the asset has been committed.
 */
export async function externalizeTerrainSplat<T extends TerrainPaintState>(
  terrain: T,
  { storedSplatmap, upload }: {
    storedSplatmap?: () => Promise<TerrainSplatmapReference | undefined>;
    upload: TerrainSplatUploader;
  },
): Promise<{ terrainData: ExternalizedTerrainSplat<T>; remember?: () => void }> {
  type Result = ExternalizedTerrainSplat<T>;
  const { splat, splatmap, textureLayers, ...rest } = terrain;
  const layers = textureLayers === undefined ? undefined : normalizeTerrainLayers(textureLayers);
  const base = layers && layers.length > 0 ? { ...rest, textureLayers: layers } : rest;
  if (!splat || splat.length === 0) {
    return { terrainData: (splatmap ? { ...base, splatmap } : base) as unknown as Result };
  }
  const columns = terrainSamplesPerSide(terrain.resolution);
  const rows = columns;
  const known = knownSplats.get(splat);
  // Skip the upload only for the asset the replaced document still references;
  // any other remembered asset may have been discarded since.
  if (known && known.columns === columns && known.rows === rows
      && storedSplatmap && sameSplatmap(known, await storedSplatmap())) {
    return { terrainData: { ...base, splatmap: known } as unknown as Result };
  }
  return frontendDiagnostics.runAsync('terrain_splatmap', 'upload', async () => {
    const bytes = encodeTerrainSplat(splat, columns, rows);
    const assetId = await upload(new File([bytes], TERRAIN_SPLATMAP_FILE_NAME, { type: TERRAIN_SPLATMAP_MIME }));
    const reference: TerrainSplatmapReference = { assetId, encoding: TERRAIN_SPLATMAP_ENCODING, columns, rows };
    return {
      terrainData: { ...base, splatmap: reference } as unknown as Result,
      remember: () => { knownSplats.set(splat, reference); },
    };
  });
}

/** Load and decode a referenced splat map. Concurrent requests share one read. */
export function resolveTerrainSplatmap(
  reference: TerrainSplatmapReference,
  load: TerrainSplatLoader,
): Promise<number[]> {
  const key = `${reference.assetId}:${reference.columns}x${reference.rows}`;
  const pending = pendingResolutions.get(key);
  if (pending) return pending;
  const resolution = frontendDiagnostics.runAsync('terrain_splatmap', 'resolve', async () => {
    if (reference.encoding !== TERRAIN_SPLATMAP_ENCODING) throw new Error('Terrain splat map encoding is not supported');
    const splat = decodeTerrainSplat(await load(reference.assetId), reference);
    knownSplats.set(splat, reference);
    return splat;
  }).finally(() => { pendingResolutions.delete(key); });
  pendingResolutions.set(key, resolution);
  return resolution;
}
