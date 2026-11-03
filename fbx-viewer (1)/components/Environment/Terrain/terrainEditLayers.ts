import { frontendDiagnostics } from '../../../diagnostics/runtime';
import type { TerrainData, TerrainEditLayer, TerrainHeightfieldReference } from '../../../types';
import {
  decodeTerrainHeightfield,
  encodeTerrainHeightfield,
  terrainSamplesPerSide,
  TERRAIN_HEIGHTFIELD_ENCODING,
  TERRAIN_HEIGHTFIELD_MIME,
} from '../../../utils/terrainHeightfieldCodec';

/**
 * TERRAIN EDIT LAYERS
 *
 * Sculpting that stays separate from what is under it. While a layer is chosen, what a stroke changes goes
 * into that layer as well as the terrain, so the whole of the layer's work can later be hidden, faded,
 * merged in or thrown away, however much else was done since. Layers add together in any order.
 *
 * The terrain's `heights` are always the finished result, so nothing else (drawing, physics, a built game)
 * has to know that layers exist. Only the editor reads them.
 */

export const MAX_TERRAIN_EDIT_LAYERS = 16;

/** The layer strokes go into, if any. */
export const activeEditLayer = (terrain: Pick<TerrainData, 'editLayers' | 'activeEditLayer'> | null | undefined): TerrainEditLayer | null =>
  terrain?.editLayers?.find(layer => layer.id === terrain.activeEditLayer) ?? null;

/** True while a layer's changes are stored in an asset that is not loaded yet. */
export const isEditLayerPending = (layer: TerrainEditLayer): boolean => Boolean(layer.heightfield && !layer.deltas);

export const hasPendingEditLayers = (terrain: Pick<TerrainData, 'editLayers'> | null | undefined): boolean =>
  Boolean(terrain?.editLayers?.some(isEditLayerPending));

/** Why a stroke cannot go into the chosen layer; null when it can. */
export const editLayerBlock = (terrain: Pick<TerrainData, 'editLayers' | 'activeEditLayer'> | null | undefined): string | null => {
  const layer = activeEditLayer(terrain);
  if (!layer) return null;
  if (isEditLayerPending(layer)) return 'This layer is still loading.';
  if (layer.locked) return 'This layer is locked.';
  if (!layer.visible) return 'This layer is hidden: show it to sculpt on it.';
  if (layer.opacity <= 0) return 'This layer is faded out: raise its strength to sculpt on it.';
  return null;
};

/**
 * The terrain after a stroke: its finished heights, and if a layer is chosen, what the stroke changed added
 * to that layer. Worked back through the layer's strength, so fading it later fades the stroke too.
 */
export const withStroke = (terrain: TerrainData, before: ArrayLike<number> | null, heights: number[]): TerrainData => {
  const layer = activeEditLayer(terrain);
  if (!layer || !before || before.length !== heights.length) return { ...terrain, heights };
  const previous = layer.deltas;
  const deltas = new Array<number>(heights.length);
  const scale = layer.opacity > 0 ? 1 / layer.opacity : 1;
  for (let index = 0; index < heights.length; index++) {
    deltas[index] = (previous && previous.length === heights.length ? previous[index] : 0) + (heights[index] - before[index]) * scale;
  }
  return {
    ...terrain,
    heights,
    editLayers: terrain.editLayers!.map((entry) => {
      if (entry.id !== layer.id) return entry;
      const { heightfield: _stored, ...rest } = entry;
      return { ...rest, deltas };
    }),
  };
};

const contribution = (layer: TerrainEditLayer): number => (layer.visible ? layer.opacity : 0);

/** Applies a change to how much of a layer shows, to the finished heights. */
const reweigh = (terrain: TerrainData, layer: TerrainEditLayer, next: TerrainEditLayer): TerrainData => {
  const change = contribution(next) - contribution(layer);
  const stored = terrain.heights;
  let heights = stored;
  if (change !== 0 && layer.deltas && stored && stored.length === layer.deltas.length) {
    heights = stored.map((value, index) => value + layer.deltas![index] * change);
  }
  return {
    ...terrain,
    heights,
    editLayers: terrain.editLayers!.map(entry => (entry.id === layer.id ? next : entry)),
  };
};

export const withEditLayerChange = (terrain: TerrainData, id: string, changes: Partial<Pick<TerrainEditLayer, 'name' | 'visible' | 'locked' | 'opacity'>>): TerrainData => {
  const layer = terrain.editLayers?.find(entry => entry.id === id);
  return layer ? reweigh(terrain, layer, { ...layer, ...changes }) : terrain;
};

/** The terrain without a layer, and without what the layer did. */
export const withoutEditLayer = (terrain: TerrainData, id: string): TerrainData => {
  const layer = terrain.editLayers?.find(entry => entry.id === id);
  if (!layer) return terrain;
  const hidden = reweigh(terrain, layer, { ...layer, visible: false });
  return dropLayer(hidden, id);
};

/** The terrain with a layer's work kept for good, as part of the ground under the layers. */
export const withEditLayerMerged = (terrain: TerrainData, id: string): TerrainData => dropLayer(terrain, id);

const dropLayer = (terrain: TerrainData, id: string): TerrainData => {
  const editLayers = (terrain.editLayers ?? []).filter(entry => entry.id !== id);
  const { editLayers: _layers, activeEditLayer: active, ...rest } = terrain;
  const next: TerrainData = { ...rest };
  if (editLayers.length) next.editLayers = editLayers;
  if (active && active !== id) next.activeEditLayer = active;
  return next;
};

export type EditLayerUploader = (file: File) => Promise<string>;
export type EditLayerLoader = (assetId: string) => Promise<ArrayBuffer>;

const knownDeltas = new WeakMap<readonly number[], TerrainHeightfieldReference>();

/** The stored form of a terrain's layers: each one's changes replaced by a heightfield asset's reference. */
export const externalizeEditLayers = async <T extends Pick<TerrainData, 'resolution' | 'editLayers'>>(
  terrain: T,
  upload: EditLayerUploader,
  stored: ReadonlySet<string>,
): Promise<T> => {
  if (!terrain.editLayers?.length) return terrain;
  const columns = terrainSamplesPerSide(terrain.resolution);
  const editLayers = await Promise.all(terrain.editLayers.map(async (layer): Promise<TerrainEditLayer> => {
    const { deltas, heightfield, ...rest } = layer;
    if (!deltas) return heightfield ? { ...rest, heightfield } : rest;
    if (deltas.length !== columns * columns) return rest;
    const known = knownDeltas.get(deltas);
    if (known && stored.has(known.assetId)) return { ...rest, heightfield: known };
    return frontendDiagnostics.runAsync('terrain_heightfield', 'upload', async () => {
      const bytes = encodeTerrainHeightfield(deltas, columns, columns);
      const assetId = await upload(new File([bytes], 'terrain-edit-layer.bin', { type: TERRAIN_HEIGHTFIELD_MIME }));
      const reference: TerrainHeightfieldReference = { assetId, encoding: TERRAIN_HEIGHTFIELD_ENCODING, columns, rows: columns };
      knownDeltas.set(deltas, reference);
      return { ...rest, heightfield: reference };
    });
  }));
  return { ...terrain, editLayers };
};

/** Loads and decodes one layer's changes. */
export const resolveEditLayer = (reference: TerrainHeightfieldReference, load: EditLayerLoader): Promise<number[]> =>
  frontendDiagnostics.runAsync('terrain_heightfield', 'resolve', async () => {
    const deltas = decodeTerrainHeightfield(await load(reference.assetId), reference);
    knownDeltas.set(deltas, reference);
    return deltas;
  });
