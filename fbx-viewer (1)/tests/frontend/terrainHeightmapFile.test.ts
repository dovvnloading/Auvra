import { describe, expect, it } from 'vitest';
import {
  decodeHeightmapPng, decodeHeightmapRaw, encodeHeightmapPng, encodeHeightmapRaw, encodeWeightmapPng, heightRangeFromName, resampleGrid,
} from '../../components/Environment/Terrain/terrainHeightmapFile';
import { decodeTerrainHoles, encodeTerrainHoles } from '../../components/Environment/Terrain/terrainSplatCodec';
import { chunkIndices, terrainIndices } from '../../components/Environment/Terrain/terrainChunks';
import { terrainShapeTriangles } from '../../runtime/terrainPhysics';

const ramp = (width: number, height: number): Float32Array => {
  const values = new Float32Array(width * height);
  for (let index = 0; index < values.length; index++) values[index] = index / (values.length - 1);
  return values;
};

describe('terrain heightmap files', () => {
  it('keeps all 16 bits through a PNG', async () => {
    const image = { width: 300, height: 200, values: ramp(300, 200) };
    const decoded = await decodeHeightmapPng(await encodeHeightmapPng(image));
    expect(decoded.width).toBe(300);
    expect(decoded.height).toBe(200);
    for (let index = 0; index < image.values.length; index += 997) {
      expect(Math.abs(decoded.values[index] - image.values[index])).toBeLessThan(1 / 65535 + 1e-6);
    }
  });

  it('reads 8-bit PNGs too', async () => {
    const image = { width: 16, height: 16, values: ramp(16, 16) };
    const decoded = await decodeHeightmapPng(await encodeWeightmapPng(image));
    expect(Math.abs(decoded.values[100] - image.values[100])).toBeLessThan(1 / 255 + 1e-6);
  });

  it('keeps 16 bits through RAW, which must be square', () => {
    const image = { width: 33, height: 33, values: ramp(33, 33) };
    const decoded = decodeHeightmapRaw(encodeHeightmapRaw(image));
    expect(decoded.width).toBe(33);
    expect(Math.abs(decoded.values[500] - image.values[500])).toBeLessThan(1 / 65535 + 1e-6);
    expect(() => decodeHeightmapRaw(new Uint8Array(1234 * 2 + 1))).toThrow();
  });

  it('refuses files that are not PNGs', async () => {
    await expect(decodeHeightmapPng(new Uint8Array(32))).rejects.toThrow();
  });

  it('resamples without moving the corners', () => {
    const source = [0, 1, 2, 3];
    const out = resampleGrid(source, 2, 2, 3, 3);
    expect(out[0]).toBe(0);
    expect(out[2]).toBe(1);
    expect(out[6]).toBe(2);
    expect(out[8]).toBe(3);
    expect(out[4]).toBeCloseTo(1.5);
  });

  it('reads the height range an exported name records', () => {
    expect(heightRangeFromName('Terrain_513x513_h-12.500_88.250.png')).toEqual({ low: -12.5, high: 88.25 });
    expect(heightRangeFromName('mountain.png')).toBeNull();
  });
});

describe('terrain holes', () => {
  it('survive being stored', () => {
    const resolution = 16;
    const holes = new Array<number>(resolution * resolution).fill(0);
    holes[5 * resolution + 7] = 1;
    holes[15 * resolution + 15] = 1;
    const decoded = decodeTerrainHoles(encodeTerrainHoles(holes, resolution), { columns: 17, rows: 17 });
    expect(decoded).toEqual(holes);
  });

  it('take their cells out of the triangles', () => {
    const holes = new Array<number>(16 * 16).fill(0);
    holes[2 * 16 + 3] = 1;
    expect(terrainIndices(16).length).toBe(16 * 16 * 6);
    expect(terrainIndices(16, holes).length).toBe((16 * 16 - 1) * 6);
    // A coarse quad over that cell stays: only part of it is cut.
    const chunk = { cx: 0, cy: 0, x0: 0, y0: 0, x1: 16, y1: 16 };
    expect(chunkIndices(16, chunk, 1, holes).length).toBe(8 * 8 * 6);
  });

  it('leave a collider without those cells', () => {
    const holes = new Array<number>(4 * 4).fill(0);
    holes[0] = 1;
    const heights = new Float32Array(25);
    const { indices } = terrainShapeTriangles({ rows: 4, columns: 4, heights, scale: { x: 10, y: 1, z: 10 } }, holes);
    expect(indices.length).toBe(15 * 6);
  });
});
