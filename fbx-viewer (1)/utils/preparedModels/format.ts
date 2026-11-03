/**
 * PREPARED MODELS
 *
 * A game that loads its source files parses FBX again on every launch, sends its textures through
 * PNG and back, compresses them on the first launch and builds detail levels on a mesh's first
 * drawn frame. So what never changes is done once, when the game is built, and kept beside the
 * source as one GLB per model. An FBX or OBJ is read as its model reads it, with the import settings
 * and the images beside it that reading takes, so geometry comes indexed and welded. Power-of-two
 * textures of 64 or more in the compressed slots carry their BC mip chains (AUVRA_texture_bc); every
 * other texture keeps its image. Each primitive carries its detail levels as index buffers
 * (AUVRA_mesh_lod). Clips are ordinary glTF animations, and an animation asset keeps only its nodes,
 * skins and clips. The root records what the source was and what reading it found (AUVRA_prepared),
 * since clips are named and cut from takes by them. Overrides, clip names and ranges, alpha cards,
 * retargeting and mirroring stay at load, because a project can change them after the fact.
 */

import type { ModelFileReport } from '../fbxImport/nativeImporter';
import type { ModelFormat } from '../modelLoader';

/** Changing what a prepared model holds changes this, so models prepared before are made again. */
export const PREPARED_MODEL_VERSION = 2;
/** Root extension of a prepared model. */
export const PREPARED_EXTENSION = 'AUVRA_prepared';
/** Extension of a texture holding its BC mip chain: { format, levels: [{ bufferView, width, height }] }. */
export const TEXTURE_BC_EXTENSION = 'AUVRA_texture_bc';
/** Extension of a primitive holding its detail levels, full level left out: { levels: [{ indices, error }] }. */
export const MESH_LOD_EXTENSION = 'AUVRA_mesh_lod';

/** A model keeps what it is drawn with; an animation asset only its nodes, skins and clips. */
export type PreparedKind = 'model' | 'animation';

export interface PreparedMetadata {
  version: number;
  sourceFormat: ModelFormat;
  /** Metres per unit the source says it is authored in, when it says. */
  metresPerUnit: number | null;
  /** Textures the source names but does not contain. */
  missingTextures: number;
  /** What reading an FBX or OBJ found in it, as loading it would. */
  report?: ModelFileReport;
}

/** What Build Game sends the host about the prepared models to put in the game, and the manifest then holds. */
export interface PreparedModels {
  version: number;
  textures: 'bc' | 'none';
  models: { source: string; asset: string }[];
}
