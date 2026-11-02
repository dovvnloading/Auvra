import {
  MAX_TERRAIN_HEIGHTFIELD_SAMPLES_PER_SIDE,
  TerrainHeightfieldEncodingError,
  terrainSamplesPerSide,
} from '../../../utils/terrainHeightfieldCodec';

// Structural types keep this codec free of runtime/project imports (and so
// checkable under the strict test compiler); they match TerrainData,
// TerrainTextureLayer and TerrainSplatmapReference in types.ts.
export interface TerrainGrassVariety {
  modelId: string;
  density: number;
  scale: [number, number];
  fadeStart: number;
  fadeEnd: number;
  randomRotation?: boolean;
  alignToSurface?: boolean;
  castShadow?: boolean;
}

export interface TerrainTextureLayerSettings {
  name?: string;
  grass?: TerrainGrassVariety[];
  textureId?: string;
  normalTextureId?: string;
  roughnessTextureId?: string;
  heightTextureId?: string;
  tiling: number;
  tileSize?: number;
  rotation?: number;
  tint?: string;
  roughness?: number;
  normalStrength?: number;
  heightContrast?: number;
  cliffProjection?: boolean;
  variation?: number;
}

/** Holes are stored as a splat map asset: red is non-zero at a cell cut out, one sample per cell plus the grid's far edge. */
export const encodeTerrainHoles = (holes: ArrayLike<number>, resolution: number): Uint8Array<ArrayBuffer> => {
  const samples = terrainSamplesPerSide(resolution);
  const weights = new Uint8Array(samples * samples * TERRAIN_SPLAT_CHANNELS);
  for (let row = 0; row < resolution; row++) {
    for (let column = 0; column < resolution; column++) {
      if (holes[row * resolution + column]) weights[(row * samples + column) * TERRAIN_SPLAT_CHANNELS] = FULL_WEIGHT;
    }
  }
  return encodeTerrainSplat(weights, samples, samples);
};

export const decodeTerrainHoles = (source: ArrayBuffer | Uint8Array, expected: TerrainSplatGrid): number[] => {
  const weights = decodeTerrainSplat(source, expected);
  const resolution = expected.columns - 1;
  const holes = new Array<number>(resolution * resolution);
  for (let row = 0; row < resolution; row++) {
    for (let column = 0; column < resolution; column++) {
      holes[row * resolution + column] = weights[(row * expected.columns + column) * TERRAIN_SPLAT_CHANNELS] ? 1 : 0;
    }
  }
  return holes;
};

export interface TerrainSplatGrid {
  columns: number;
  rows: number;
}

export interface TerrainPaintState {
  resolution: number;
  textureLayers?: readonly TerrainTextureLayerSettings[];
  splat?: readonly number[];
  splatmap?: TerrainSplatGrid & { assetId: string; encoding: string };
  splat2?: readonly number[];
  splatmap2?: TerrainSplatGrid & { assetId: string; encoding: string };
  holes?: readonly number[];
  holemap?: TerrainSplatGrid & { assetId: string; encoding: string };
}

/**
 * Binary layout of a terrain splat map asset (all little-endian):
 *   bytes 0-7   ASCII "AUVRASP1"
 *   bytes 8-11  uint32 columns
 *   bytes 12-15 uint32 rows
 *   bytes 16-   columns * rows RGBA8 weights, row-major (PlaneGeometry order,
 *               the same sample order as the terrain heightfield)
 * Channel N (R, G, B, A) weights texture layer N; a sample's weights sum to 255.
 */
export const TERRAIN_SPLATMAP_MIME = 'application/vnd.auvra.splatmap';
export const TERRAIN_SPLATMAP_ENCODING = 'rgba8' as const;
export const TERRAIN_SPLATMAP_HEADER_BYTES = 16;
export const TERRAIN_SPLATMAP_FILE_NAME = 'terrain-splatmap.bin';
export const TERRAIN_SPLAT_CHANNELS = 4;
export const MAX_TERRAIN_LAYERS = TERRAIN_SPLAT_CHANNELS * 2;
export const DEFAULT_TERRAIN_LAYER_TILING = 16;
export const DEFAULT_TERRAIN_LAYER_TILE_SIZE = 8;
export const MAX_TERRAIN_LAYER_TILING = 10000;
const MAGIC = 'AUVRASP1';
const FULL_WEIGHT = 255;

/**
 * The weights cannot be stored as a splat map; writing the same data again
 * cannot succeed. It is a heightfield encoding error so the level manager
 * reverts the edit instead of retrying it.
 */
export class TerrainSplatEncodingError extends TerrainHeightfieldEncodingError {
  constructor(message: string) {
    super(message);
    this.name = 'TerrainSplatEncodingError';
  }
}

const assertDimension = (value: number, label: string, Failure: new (message: string) => Error = Error): void => {
  if (!Number.isInteger(value) || value < 2 || value > MAX_TERRAIN_HEIGHTFIELD_SAMPLES_PER_SIDE) {
    throw new Failure(`Terrain splat map ${label} is out of range`);
  }
};

/** The number of weights (RGBA per height sample) of a terrain of the given resolution. */
export function terrainSplatLength(resolution: number): number {
  const samples = terrainSamplesPerSide(resolution);
  return samples * samples * TERRAIN_SPLAT_CHANNELS;
}

/** True while a terrain's weights are stored in an asset that is not loaded yet. */
export function isTerrainSplatPending(terrain: Pick<TerrainPaintState, 'splat' | 'splatmap'> | null | undefined): boolean {
  return Boolean(terrain?.splatmap && !(terrain.splat && terrain.splat.length > 0));
}

/** True while the weights of a terrain's layers 5 to 8 are stored in an asset that is not loaded yet. */
export function isTerrainSplat2Pending(terrain: Pick<TerrainPaintState, 'splat2' | 'splatmap2'> | null | undefined): boolean {
  return Boolean(terrain?.splatmap2 && !(terrain.splat2 && terrain.splat2.length > 0));
}

/** True while a terrain's holes are stored in an asset that is not loaded yet. */
export function isTerrainHolesPending(terrain: Pick<TerrainPaintState, 'holes' | 'holemap'> | null | undefined): boolean {
  return Boolean(terrain?.holemap && !terrain.holes);
}

/** True when the terrain carries in-memory weights that describe its grid. */
export function hasTerrainSplat(terrain: TerrainPaintState | null | undefined): boolean {
  return Boolean(terrain?.splat && terrain.splat.length === terrainSplatLength(terrain.resolution));
}

/** Reset weights in place to the unpainted state: layer 0 covers every sample. */
export function fillDefaultTerrainSplat(weights: Uint8Array): Uint8Array {
  weights.fill(0);
  for (let index = 0; index < weights.length; index += TERRAIN_SPLAT_CHANNELS) weights[index] = FULL_WEIGHT;
  return weights;
}

/** Unpainted weights for a grid of the given size. */
export function createDefaultTerrainSplat(columns: number, rows: number): Uint8Array {
  return fillDefaultTerrainSplat(new Uint8Array(columns * rows * TERRAIN_SPLAT_CHANNELS));
}

export function encodeTerrainSplat(weights: ArrayLike<number>, columns: number, rows: number): Uint8Array<ArrayBuffer> {
  assertDimension(columns, 'columns', TerrainSplatEncodingError);
  assertDimension(rows, 'rows', TerrainSplatEncodingError);
  const count = columns * rows * TERRAIN_SPLAT_CHANNELS;
  if (weights.length !== count) throw new TerrainSplatEncodingError('Terrain splat weights do not match the terrain resolution');
  const bytes = new Uint8Array(TERRAIN_SPLATMAP_HEADER_BYTES + count);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MAGIC.length; index++) bytes[index] = MAGIC.charCodeAt(index);
  view.setUint32(8, columns, true);
  view.setUint32(12, rows, true);
  for (let index = 0; index < count; index++) {
    const value = weights[index];
    if (!Number.isInteger(value) || value < 0 || value > FULL_WEIGHT) {
      throw new TerrainSplatEncodingError('Terrain splat weights must be integers from 0 to 255');
    }
    bytes[TERRAIN_SPLATMAP_HEADER_BYTES + index] = value;
  }
  return bytes;
}

export function decodeTerrainSplat(source: ArrayBuffer | Uint8Array, expected?: TerrainSplatGrid): number[] {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  if (bytes.byteLength < TERRAIN_SPLATMAP_HEADER_BYTES) throw new Error('Terrain splat map asset is truncated');
  for (let index = 0; index < MAGIC.length; index++) {
    if (bytes[index] !== MAGIC.charCodeAt(index)) throw new Error('Terrain splat map asset has an unknown format');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const columns = view.getUint32(8, true);
  const rows = view.getUint32(12, true);
  assertDimension(columns, 'columns');
  assertDimension(rows, 'rows');
  if (expected && (expected.columns !== columns || expected.rows !== rows)) {
    throw new Error('Terrain splat map asset does not match its reference');
  }
  const count = columns * rows * TERRAIN_SPLAT_CHANNELS;
  if (bytes.byteLength !== TERRAIN_SPLATMAP_HEADER_BYTES + count) throw new Error('Terrain splat map asset size is invalid');
  return Array.from(bytes.subarray(TERRAIN_SPLATMAP_HEADER_BYTES));
}

const normalizeTiling = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_TERRAIN_LAYER_TILING)
    : DEFAULT_TERRAIN_LAYER_TILING
);

const clampNumber = (value: unknown, fallback: number, low: number, high: number): number => (
  Math.min(high, Math.max(low, typeof value === 'number' && Number.isFinite(value) ? value : fallback))
);

export const MAX_TERRAIN_GRASS_VARIETIES = 8;
export const DEFAULT_TERRAIN_GRASS: Omit<TerrainGrassVariety, 'modelId'> = { density: 2, scale: [0.8, 1.2], fadeStart: 30, fadeEnd: 60 };

/** Each variety with a model, every field in range. */
export function normalizeGrass(value: unknown): TerrainGrassVariety[] {
  if (!Array.isArray(value)) return [];
  const out: TerrainGrassVariety[] = [];
  for (const entry of value.slice(0, MAX_TERRAIN_GRASS_VARIETIES)) {
    const grass = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    if (typeof grass.modelId !== 'string' || !grass.modelId) continue;
    const range = Array.isArray(grass.scale) ? grass.scale : DEFAULT_TERRAIN_GRASS.scale;
    const a = clampNumber(range[0], 1, 0.001, 1000);
    const b = clampNumber(range[1], 1, 0.001, 1000);
    const end = clampNumber(grass.fadeEnd, DEFAULT_TERRAIN_GRASS.fadeEnd, 1, 2000);
    const variety: TerrainGrassVariety = {
      modelId: grass.modelId,
      density: clampNumber(grass.density, DEFAULT_TERRAIN_GRASS.density, 0, 64),
      scale: a <= b ? [a, b] : [b, a],
      fadeStart: Math.min(end, clampNumber(grass.fadeStart, DEFAULT_TERRAIN_GRASS.fadeStart, 0, 2000)),
      fadeEnd: end,
    };
    if (grass.randomRotation === false) variety.randomRotation = false;
    if (grass.alignToSurface === false) variety.alignToSurface = false;
    if (grass.castShadow === true) variety.castShadow = true;
    out.push(variety);
  }
  return out;
}

/** The terrain without a deleted model in its layers' grass. Returns the same object when no layer grows it. */
export function withoutTerrainLayerModel<T extends { textureLayers?: readonly TerrainTextureLayerSettings[] }>(terrain: T, modelId: string): T {
  if (!terrain.textureLayers?.some(layer => layer.grass?.some(grass => grass.modelId === modelId))) return terrain;
  return {
    ...terrain,
    textureLayers: terrain.textureLayers.map(layer => (layer.grass ? { ...layer, grass: layer.grass.filter(grass => grass.modelId !== modelId) } : layer)),
  };
}

const LAYER_TEXTURE_FIELDS = ['textureId', 'normalTextureId', 'roughnessTextureId', 'heightTextureId'] as const;
const LAYER_NUMBER_FIELDS = ['tileSize', 'rotation', 'roughness', 'normalStrength', 'heightContrast', 'variation'] as const;

/** At most eight layers, each with a positive tiling and only the settings it really has. */
export function normalizeTerrainLayers(layers: unknown): TerrainTextureLayerSettings[] {
  if (!Array.isArray(layers)) return [];
  return layers.slice(0, MAX_TERRAIN_LAYERS).map((layer): TerrainTextureLayerSettings => {
    const value = (layer && typeof layer === 'object' ? layer : {}) as Record<string, unknown>;
    const normalized: TerrainTextureLayerSettings = { tiling: normalizeTiling(value.tiling) };
    for (const field of LAYER_TEXTURE_FIELDS) {
      const id = value[field];
      if (typeof id === 'string' && id) normalized[field] = id;
    }
    for (const field of LAYER_NUMBER_FIELDS) {
      const number = value[field];
      if (typeof number === 'number' && Number.isFinite(number)) normalized[field] = number;
    }
    if (typeof value.name === 'string' && value.name) normalized.name = value.name;
    if (typeof value.tint === 'string' && value.tint) normalized.tint = value.tint;
    if (value.cliffProjection === true) normalized.cliffProjection = true;
    const grass = normalizeGrass(value.grass);
    if (grass.length) normalized.grass = grass;
    return normalized;
  });
}

/** World metres one tile of a layer covers on a terrain this many world metres wide. */
export function terrainLayerTileSize(layer: TerrainTextureLayerSettings, worldWidth: number): number {
  if (layer.tileSize && layer.tileSize > 0) return layer.tileSize;
  return worldWidth > 0 ? worldWidth / layer.tiling : DEFAULT_TERRAIN_LAYER_TILE_SIZE;
}

/** True when any layer of the terrain samples the texture. */
export function terrainLayersReferenceTexture(
  terrain: { textureLayers?: readonly TerrainTextureLayerSettings[] } | null | undefined,
  textureId: string,
): boolean {
  return Boolean(terrain?.textureLayers?.some((layer) => LAYER_TEXTURE_FIELDS.some((field) => layer[field] === textureId)));
}

/**
 * Drop a deleted texture from the terrain's layers. The layers themselves stay
 * so splat channel N keeps weighting layer N; an emptied layer renders grey.
 * Returns the same object when nothing referenced the texture.
 */
export function withoutTerrainLayerTexture<T extends { textureLayers?: readonly TerrainTextureLayerSettings[] }>(
  terrain: T,
  textureId: string,
): T {
  if (!terrainLayersReferenceTexture(terrain, textureId)) return terrain;
  const textureLayers = (terrain.textureLayers ?? []).map((layer) => {
    const kept = { ...layer };
    for (const field of LAYER_TEXTURE_FIELDS) {
      if (kept[field] === textureId) delete kept[field];
    }
    return kept;
  });
  return { ...terrain, textureLayers };
}

/**
 * Weights after a layer is removed: its channel is folded into layer 0 so
 * every sample still sums to 255 and re-adding the layer starts unpainted.
 */
export function withoutTerrainSplatChannel(splat: readonly number[], channel: number): number[] {
  const next = splat.slice();
  if (channel <= 0 || channel >= TERRAIN_SPLAT_CHANNELS) return next;
  for (let index = 0; index < next.length; index += TERRAIN_SPLAT_CHANNELS) {
    next[index] = Math.min(FULL_WEIGHT, next[index] + next[index + channel]);
    next[index + channel] = 0;
  }
  return next;
}

export interface TerrainSplatPaintGrid extends TerrainSplatGrid {
  /** Extent of the terrain plane in its local units (PlaneGeometry width/height). */
  width: number;
  depth: number;
}

export interface TerrainSplatBrush {
  /** Brush centre in PlaneGeometry local units: x to the right, y towards row 0. */
  x: number;
  y: number;
  radius: number;
  /** Fraction (0-1) of the way each sample at the centre moves towards the layer. */
  strength: number;
  layer: number;
}

/**
 * Blend `brush.layer` into the weights under a soft round brush. Every
 * touched sample is renormalised so its four weights sum to 255. Returns true
 * when any weight changed.
 */
export function paintTerrainSplat(weights: Uint8Array, grid: TerrainSplatPaintGrid, brush: TerrainSplatBrush): boolean {
  const { columns, rows, width, depth } = grid;
  const { x, y, radius, layer } = brush;
  const strength = Math.min(1, Math.max(0, brush.strength));
  if (columns < 2 || rows < 2 || !(radius > 0) || strength === 0 || width <= 0 || depth <= 0) return false;
  if (!Number.isInteger(layer) || layer < 0 || layer >= TERRAIN_SPLAT_CHANNELS) return false;
  if (weights.length !== columns * rows * TERRAIN_SPLAT_CHANNELS) return false;

  const cellX = width / (columns - 1);
  const cellY = depth / (rows - 1);
  // Sample (column, row) sits at x = column * cellX - width / 2, y = depth / 2 - row * cellY.
  const firstColumn = Math.max(0, Math.ceil((x - radius + width / 2) / cellX));
  const lastColumn = Math.min(columns - 1, Math.floor((x + radius + width / 2) / cellX));
  const firstRow = Math.max(0, Math.ceil((depth / 2 - y - radius) / cellY));
  const lastRow = Math.min(rows - 1, Math.floor((depth / 2 - y + radius) / cellY));
  const radiusSq = radius * radius;
  const blended = [0, 0, 0, 0];
  const quantized = [0, 0, 0, 0];
  let modified = false;

  for (let row = firstRow; row <= lastRow; row++) {
    const dy = depth / 2 - row * cellY - y;
    for (let column = firstColumn; column <= lastColumn; column++) {
      const dx = column * cellX - width / 2 - x;
      const distSq = dx * dx + dy * dy;
      if (distSq >= radiusSq) continue;
      const falloff = 1 - Math.sqrt(distSq) / radius;
      const amount = falloff * falloff * strength;
      const base = (row * columns + column) * TERRAIN_SPLAT_CHANNELS;

      let total = 0;
      for (let channel = 0; channel < TERRAIN_SPLAT_CHANNELS; channel++) total += weights[base + channel];
      for (let channel = 0; channel < TERRAIN_SPLAT_CHANNELS; channel++) {
        const current = total > 0 ? weights[base + channel] / total : (channel === 0 ? 1 : 0);
        blended[channel] = current * (1 - amount) + (channel === layer ? amount : 0);
      }

      let sum = 0;
      let largest = 0;
      for (let channel = 0; channel < TERRAIN_SPLAT_CHANNELS; channel++) {
        quantized[channel] = Math.round(blended[channel] * FULL_WEIGHT);
        sum += quantized[channel];
        if (quantized[channel] > quantized[largest]) largest = channel;
      }
      // Rounding can leave the sample a unit off 255: settle it on the painted
      // layer unless that would leave the byte range.
      const remainder = FULL_WEIGHT - sum;
      if (remainder !== 0) {
        const target = quantized[layer] + remainder >= 0 && quantized[layer] + remainder <= FULL_WEIGHT ? layer : largest;
        quantized[target] += remainder;
      }

      for (let channel = 0; channel < TERRAIN_SPLAT_CHANNELS; channel++) {
        if (weights[base + channel] !== quantized[channel]) {
          weights[base + channel] = quantized[channel];
          modified = true;
        }
      }
    }
  }
  return modified;
}
