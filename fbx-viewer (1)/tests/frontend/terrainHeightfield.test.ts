import { describe, expect, it } from 'vitest';
import {
  decodeTerrainHeightfield,
  encodeTerrainHeightfield,
  isTerrainHeightfieldPending,
  TERRAIN_HEIGHTFIELD_HEADER_BYTES,
} from '../../utils/terrainHeightfieldCodec';

// Shared with tests/project/test_terrain_heightfield.py: the editor and the
// host must agree on this exact byte layout.
const GOLDEN_HEIGHTFIELD = '41555652414846310200000002000000000000000000c03f000000c000005040';
const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

describe('terrain heightfield codec', () => {
  it('encodes the shared little-endian Float32 layout', () => {
    const bytes = encodeTerrainHeightfield([0, 1.5, -2, 3.25], 2, 2);
    expect(toHex(bytes)).toBe(GOLDEN_HEIGHTFIELD);
    expect(decodeTerrainHeightfield(bytes)).toEqual([0, 1.5, -2, 3.25]);
  });

  it('round trips a 513x513 terrain as Float32 values', () => {
    const samples = 513;
    const heights = Array.from({ length: samples * samples }, (_, index) => Math.sin(index / 97) * 40 + index / 1e5);
    const bytes = encodeTerrainHeightfield(heights, samples, samples);
    expect(bytes.byteLength).toBe(TERRAIN_HEIGHTFIELD_HEADER_BYTES + heights.length * 4);
    const decoded = decodeTerrainHeightfield(bytes.buffer, { columns: samples, rows: samples });
    expect(decoded).toHaveLength(heights.length);
    expect(decoded).toEqual(heights.map((value) => Math.fround(value)));
  });

  it('rejects data that does not describe the referenced grid', () => {
    const bytes = encodeTerrainHeightfield([0, 1, 2, 3], 2, 2);
    expect(() => encodeTerrainHeightfield([0, 1, 2], 2, 2)).toThrow(/resolution/);
    expect(() => encodeTerrainHeightfield([0, Number.NaN, 2, 3], 2, 2)).toThrow(/finite/);
    expect(() => encodeTerrainHeightfield([0, 1e39, 2, 3], 2, 2)).toThrow(/finite/);
    expect(() => decodeTerrainHeightfield(bytes.slice(0, bytes.byteLength - 1))).toThrow(/size/);
    expect(() => decodeTerrainHeightfield(bytes, { columns: 3, rows: 3 })).toThrow(/reference/);
    const unknown = bytes.slice();
    unknown[7] = 0x32;
    expect(() => decodeTerrainHeightfield(unknown)).toThrow(/format/);
  });

  it('reports a referenced terrain as pending until its heights are loaded', () => {
    const terrain = {
      resolution: 1, width: 10, depth: 10,
      heightfield: { assetId: 'a'.repeat(64), encoding: 'float32le' as const, columns: 2, rows: 2 },
    };
    expect(isTerrainHeightfieldPending(terrain)).toBe(true);
    expect(isTerrainHeightfieldPending({ ...terrain, heights: [0, 0, 0, 0] })).toBe(false);
    const neverSculpted = { resolution: 1, width: 10, depth: 10, heights: [] };
    expect(isTerrainHeightfieldPending(neverSculpted)).toBe(false);
    expect(isTerrainHeightfieldPending(undefined)).toBe(false);
  });
});
