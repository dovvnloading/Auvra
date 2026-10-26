// Structural types keep this codec free of runtime/project imports (and so
// checkable under the strict test compiler); they match TerrainData and
// TerrainHeightfieldReference in types.ts.
interface HeightfieldGrid {
  columns: number;
  rows: number;
}

interface TerrainHeightsState {
  heights?: readonly number[];
  heightfield?: HeightfieldGrid;
}

/**
 * Binary layout of a terrain heightfield asset (all little-endian):
 *   bytes 0-7   ASCII "AUVRAHF1"
 *   bytes 8-11  uint32 columns
 *   bytes 12-15 uint32 rows
 *   bytes 16-   columns * rows Float32 samples, row-major (PlaneGeometry order)
 * The host validates the same layout (Auvra/project/assets.py).
 */
export const TERRAIN_HEIGHTFIELD_MIME = 'application/vnd.auvra.heightfield';
export const TERRAIN_HEIGHTFIELD_ENCODING = 'float32le' as const;
export const TERRAIN_HEIGHTFIELD_HEADER_BYTES = 16;
/** Matches the host validator; the editor itself creates at most 513 samples per side. */
export const MAX_TERRAIN_HEIGHTFIELD_SAMPLES_PER_SIDE = 4097;
const MAGIC = 'AUVRAHF1';

/** The heights cannot be stored as a heightfield; writing the same data again cannot succeed. */
export class TerrainHeightfieldEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerrainHeightfieldEncodingError';
  }
}

const assertDimension = (value: number, label: string, Failure: new (message: string) => Error = Error): void => {
  if (!Number.isInteger(value) || value < 2 || value > MAX_TERRAIN_HEIGHTFIELD_SAMPLES_PER_SIDE) {
    throw new Failure(`Terrain heightfield ${label} is out of range`);
  }
};

/** The number of height samples per side of a terrain of the given resolution. */
export function terrainSamplesPerSide(resolution: number): number {
  return resolution + 1;
}

/** True while a terrain's heights are stored in an asset that is not loaded yet. */
export function isTerrainHeightfieldPending(terrain: TerrainHeightsState | null | undefined): boolean {
  return Boolean(terrain?.heightfield && !(terrain.heights && terrain.heights.length > 0));
}

export function encodeTerrainHeightfield(heights: ArrayLike<number>, columns: number, rows: number): Uint8Array<ArrayBuffer> {
  assertDimension(columns, 'columns', TerrainHeightfieldEncodingError);
  assertDimension(rows, 'rows', TerrainHeightfieldEncodingError);
  const count = columns * rows;
  if (heights.length !== count) throw new TerrainHeightfieldEncodingError('Terrain heights do not match the terrain resolution');
  const bytes = new Uint8Array(TERRAIN_HEIGHTFIELD_HEADER_BYTES + count * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MAGIC.length; index++) bytes[index] = MAGIC.charCodeAt(index);
  view.setUint32(8, columns, true);
  view.setUint32(12, rows, true);
  for (let index = 0; index < count; index++) {
    const value = Math.fround(heights[index]);
    if (!Number.isFinite(value)) throw new TerrainHeightfieldEncodingError('Terrain heights must be finite Float32 values');
    view.setFloat32(TERRAIN_HEIGHTFIELD_HEADER_BYTES + index * 4, value, true);
  }
  return bytes;
}

export function decodeTerrainHeightfield(
  source: ArrayBuffer | Uint8Array,
  expected?: HeightfieldGrid,
): number[] {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  if (bytes.byteLength < TERRAIN_HEIGHTFIELD_HEADER_BYTES) throw new Error('Terrain heightfield asset is truncated');
  for (let index = 0; index < MAGIC.length; index++) {
    if (bytes[index] !== MAGIC.charCodeAt(index)) throw new Error('Terrain heightfield asset has an unknown format');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const columns = view.getUint32(8, true);
  const rows = view.getUint32(12, true);
  assertDimension(columns, 'columns');
  assertDimension(rows, 'rows');
  if (expected && (expected.columns !== columns || expected.rows !== rows)) {
    throw new Error('Terrain heightfield asset does not match its reference');
  }
  const count = columns * rows;
  if (bytes.byteLength !== TERRAIN_HEIGHTFIELD_HEADER_BYTES + count * 4) throw new Error('Terrain heightfield asset size is invalid');
  const heights = new Array<number>(count);
  for (let index = 0; index < count; index++) {
    const value = view.getFloat32(TERRAIN_HEIGHTFIELD_HEADER_BYTES + index * 4, true);
    if (!Number.isFinite(value)) throw new Error('Terrain heightfield asset contains non-finite samples');
    heights[index] = value;
  }
  return heights;
}
