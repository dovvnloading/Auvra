import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GRASS_CELL_SIZE, grassCellMatrices, grassDrawnShare, type GrassSource } from '../../components/Environment/Terrain/terrainGrass';
import { normalizeTerrainLayers, withoutTerrainLayerModel, type TerrainGrassVariety } from '../../components/Environment/Terrain/terrainSplatCodec';

const makeSource = (paint: (column: number, row: number) => number = () => 255, height = 2): GrassSource => {
  const columns = 65;
  const heights = new Float32Array(columns * columns).fill(height);
  const weights = new Uint8Array(columns * columns * 4);
  for (let row = 0; row < columns; row++) {
    for (let column = 0; column < columns; column++) {
      const value = paint(column, row);
      weights[(row * columns + column) * 4 + 1] = value;
      weights[(row * columns + column) * 4] = 255 - value;
    }
  }
  return {
    live: { columns, rows: columns, width: 64, depth: 64, heights } as unknown as GrassSource['live'],
    weights,
    weights2: null,
    holes: null,
  };
};

const variety = (changes: Partial<TerrainGrassVariety> = {}): TerrainGrassVariety => ({
  modelId: 'grass', density: 2, scale: [1, 1], fadeStart: 30, fadeEnd: 60, ...changes,
});

describe('terrain grass', () => {
  it('grows at its density where the layer is painted', () => {
    const copies = grassCellMatrices(makeSource(), variety(), 1, -1, -1, 5);
    expect(copies.length).toBe(2 * GRASS_CELL_SIZE * GRASS_CELL_SIZE);
    const position = new THREE.Vector3().setFromMatrixPosition(copies[0]);
    expect(position.y).toBeCloseTo(2);
    expect(position.x).toBeLessThanOrEqual(0);
    expect(position.x).toBeGreaterThanOrEqual(-GRASS_CELL_SIZE);
  });

  it('does not grow where the layer is not painted', () => {
    expect(grassCellMatrices(makeSource(() => 0), variety(), 1, -1, -1, 5)).toHaveLength(0);
  });

  it('thins with the layer\'s weight', () => {
    const half = grassCellMatrices(makeSource(() => 128), variety(), 1, -1, -1, 5).length;
    const full = 2 * GRASS_CELL_SIZE * GRASS_CELL_SIZE;
    expect(half).toBeGreaterThan(full * 0.35);
    expect(half).toBeLessThan(full * 0.65);
  });

  it('comes back the same each time, and differs from cell to cell', () => {
    const source = makeSource();
    const a = grassCellMatrices(source, variety(), 1, 0, 0, 5);
    const b = grassCellMatrices(source, variety(), 1, 0, 0, 5);
    expect(a[10].equals(b[10])).toBe(true);
    const other = grassCellMatrices(source, variety(), 1, -1, 0, 5);
    expect(a[10].equals(other[10])).toBe(false);
  });

  it('stops at the terrain\'s edge', () => {
    // The terrain reaches 32 metres each way: this cell lies wholly past it.
    expect(grassCellMatrices(makeSource(), variety(), 1, 3, 0, 5)).toHaveLength(0);
  });

  it('does not grow over a hole', () => {
    const source = makeSource();
    source.holes = new Uint8Array(64 * 64).fill(1);
    expect(grassCellMatrices(source, variety(), 1, 0, 0, 5)).toHaveLength(0);
  });

  it('keeps most of a cell in place when paint changes in one spot of it', () => {
    const before = grassCellMatrices(makeSource(), variety({ alignToSurface: false }), 1, 0, 0, 5);
    const after = grassCellMatrices(makeSource((column) => (column === 32 ? 0 : 255)), variety({ alignToSurface: false }), 1, 0, 0, 5);
    const places = new Set(before.map(matrix => matrix.elements.join()));
    const unchanged = after.filter(matrix => places.has(matrix.elements.join())).length;
    expect(unchanged).toBeGreaterThan(after.length * 0.9);
  });

  it('thins with distance, all the way out', () => {
    expect(grassDrawnShare(10, 30, 60)).toBe(1);
    expect(grassDrawnShare(45, 30, 60)).toBeCloseTo(0.25);
    expect(grassDrawnShare(60, 30, 60)).toBe(0);
    expect(grassDrawnShare(90, 30, 60)).toBe(0);
  });
});

describe('terrain grass settings', () => {
  it('keeps a layer\'s grass with its fields in range, and drops any without a model', () => {
    const [layer] = normalizeTerrainLayers([{
      tiling: 1,
      grass: [
        { modelId: 'a', density: 2, scale: [2, 1], fadeStart: 80, fadeEnd: 40 },
        { density: 2 },
        { modelId: 'b', density: -3, castShadow: true },
      ],
    }]);
    expect(layer.grass).toHaveLength(2);
    expect(layer.grass?.[0].scale).toEqual([1, 2]);
    expect(layer.grass?.[0].fadeStart).toBeLessThanOrEqual(layer.grass?.[0].fadeEnd ?? 0);
    expect(layer.grass?.[1].density).toBe(0);
    expect(layer.grass?.[1].castShadow).toBe(true);
  });

  it('forgets a deleted model', () => {
    const terrain = { textureLayers: [{ tiling: 1, grass: [variety({ modelId: 'gone' }), variety({ modelId: 'kept' })] }] };
    expect(withoutTerrainLayerModel(terrain, 'gone').textureLayers?.[0].grass?.map(entry => entry.modelId)).toEqual(['kept']);
    expect(withoutTerrainLayerModel(terrain, 'other')).toBe(terrain);
  });
});
