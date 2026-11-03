import { describe, expect, it } from 'vitest';
import type { TerrainBrushStamp } from '../../components/Environment/Terrain/terrainBrush';
import {
  applyFlattenLayer, applyNoiseLayer, applyPaintLayer, applySmoothLayer, clearLayer, fillLayer, layerCoverage, layerValues, layerWeightAt,
  paintLayerByRule, removeLayerWeights, setLayerFromValues, swapLayerWeights, type TerrainWeightGrid, type WeightToolContext,
} from '../../components/Environment/Terrain/terrainWeightTools';
import { createDefaultTerrainSplat, normalizeTerrainLayers, terrainLayersReferenceTexture, terrainLayerTileSize, withoutTerrainLayerTexture } from '../../components/Environment/Terrain/terrainSplatCodec';

const SIDE = 33;
const middle = (SIDE * SIDE - 1) / 2;

const makeGrid = (layerCount = 8): TerrainWeightGrid => ({
  columns: SIDE,
  rows: SIDE,
  width: 32,
  depth: 32,
  weights: createDefaultTerrainSplat(SIDE, SIDE),
  weights2: layerCount > 4 ? new Uint8Array(SIDE * SIDE * 4) : null,
  layerCount,
});

const stamp = (): TerrainBrushStamp => ({ x: 0, y: 0, radiusX: 8, radiusY: 8, falloff: 0, falloffType: 'smooth', shape: 'circle' });

const context = (grid: TerrainWeightGrid, layer: number, changes: Partial<WeightToolContext> = {}): WeightToolContext => ({
  grid, stamp: stamp(), layer, strength: 1, dt: 0.1, invert: false, ...changes,
});

/** Every sample's weights must add up to 255. */
const expectWhole = (grid: TerrainWeightGrid) => {
  for (let sample = 0; sample < SIDE * SIDE; sample++) {
    let sum = 0;
    for (let channel = 0; channel < 4; channel++) {
      sum += grid.weights[sample * 4 + channel] + (grid.weights2 ? grid.weights2[sample * 4 + channel] : 0);
    }
    expect(sum).toBe(255);
  }
};

describe('terrain paint tools', () => {
  it('paints any of the eight layers in, keeping every sample whole', () => {
    for (const layer of [1, 3, 4, 7]) {
      const grid = makeGrid();
      for (let frame = 0; frame < 30; frame++) applyPaintLayer(context(grid, layer), 1);
      expect(layerWeightAt(grid, middle, layer)).toBeGreaterThan(0.95);
      expect(layerWeightAt(grid, middle, 0)).toBeLessThan(0.05);
      expect(layerWeightAt(grid, 0, layer)).toBe(0);
      expectWhole(grid);
    }
  });

  it('takes a layer away with Shift, its share going to what else is there', () => {
    const grid = makeGrid();
    for (let frame = 0; frame < 30; frame++) applyPaintLayer(context(grid, 2), 1);
    for (let frame = 0; frame < 30; frame++) applyPaintLayer(context(grid, 2, { invert: true }), 1);
    expect(layerWeightAt(grid, middle, 2)).toBeLessThan(0.02);
    expect(layerWeightAt(grid, middle, 0)).toBeGreaterThan(0.95);
    expectWhole(grid);
  });

  it('stops at the amount asked for', () => {
    const grid = makeGrid();
    for (let frame = 0; frame < 60; frame++) applyPaintLayer(context(grid, 1), 0.5);
    expect(layerWeightAt(grid, middle, 1)).toBeCloseTo(0.5, 1);
  });

  it('a slow stroke still gets there, though each moment is under one byte', () => {
    const grid = makeGrid();
    for (let frame = 0; frame < 400; frame++) applyPaintLayer(context(grid, 1, { strength: 0.01, dt: 1 / 60 }), 1);
    expect(layerWeightAt(grid, middle, 1)).toBeGreaterThan(0.5);
  });

  it('flatten brings it to the amount under the first click', () => {
    const grid = makeGrid();
    setLayerFromValues(grid, 1, new Float32Array(SIDE * SIDE).map((_, sample) => (sample % SIDE) / (SIDE - 1)));
    for (let frame = 0; frame < 60; frame++) applyFlattenLayer(context(grid, 1), 0.5);
    expect(layerWeightAt(grid, middle - 3, 1)).toBeCloseTo(0.5, 1);
    expect(layerWeightAt(grid, middle + 3, 1)).toBeCloseTo(0.5, 1);
  });

  it('smooth softens a hard edge', () => {
    const grid = makeGrid();
    setLayerFromValues(grid, 1, new Float32Array(SIDE * SIDE).map((_, sample) => (sample % SIDE < 16 ? 1 : 0)));
    const before = layerWeightAt(grid, middle - 1, 1);
    for (let frame = 0; frame < 10; frame++) applySmoothLayer(context(grid, 1), 2);
    expect(layerWeightAt(grid, middle - 1, 1)).toBeLessThan(before);
    expect(layerWeightAt(grid, middle + 1, 1)).toBeGreaterThan(0);
    expectWhole(grid);
  });

  it('noise breaks it up in patches', () => {
    const grid = makeGrid();
    setLayerFromValues(grid, 1, new Float32Array(SIDE * SIDE).fill(0.5));
    applyNoiseLayer(context(grid, 1), 4);
    const values = new Set<number>();
    for (let sample = 0; sample < SIDE * SIDE; sample++) values.add(layerWeightAt(grid, sample, 1));
    expect(values.size).toBeGreaterThan(3);
    expectWhole(grid);
  });

  it('fills and clears a layer over the whole terrain', () => {
    const grid = makeGrid();
    fillLayer(grid, 5);
    expect(layerWeightAt(grid, 0, 5)).toBe(1);
    expectWhole(grid);
    clearLayer(grid, 5);
    expect(layerWeightAt(grid, 0, 5)).toBe(0);
    expect(layerWeightAt(grid, 0, 0)).toBe(1);
    expectWhole(grid);
  });

  it('removing a layer moves later layers down and gives its paint to the base', () => {
    const grid = makeGrid();
    setLayerFromValues(grid, 2, new Float32Array(SIDE * SIDE).fill(0.5));
    setLayerFromValues(grid, 5, new Float32Array(SIDE * SIDE).fill(0.25));
    const third = layerWeightAt(grid, 0, 2);
    const sixth = layerWeightAt(grid, 0, 5);
    const base = layerWeightAt(grid, 0, 0);
    removeLayerWeights(grid, 2);
    expect(layerWeightAt(grid, 0, 4)).toBeCloseTo(sixth, 2);
    expect(layerWeightAt(grid, 0, 5)).toBe(0);
    expect(layerWeightAt(grid, 0, 0)).toBeCloseTo(base + third, 2);
    expectWhole(grid);
  });

  it('swaps layers across the two maps', () => {
    const grid = makeGrid();
    setLayerFromValues(grid, 1, new Float32Array(SIDE * SIDE).fill(1));
    swapLayerWeights(grid, 1, 6);
    expect(layerWeightAt(grid, 0, 6)).toBe(1);
    expect(layerWeightAt(grid, 0, 1)).toBe(0);
    expectWhole(grid);
  });

  it('paints by slope and height', () => {
    const grid = makeGrid();
    // Flat at the left, a 45 degree slope on the right.
    const heights = new Float32Array(SIDE * SIDE).map((_, sample) => Math.max(0, sample % SIDE - 16));
    paintLayerByRule(grid, heights, 3, { slopeMin: 30, slopeMax: 90, heightMin: -100, heightMax: 100, softness: 2, scaleX: 1, scaleY: 1, scaleZ: 1, originY: 0 });
    expect(layerWeightAt(grid, 25 * SIDE + 26, 3)).toBeGreaterThan(0.9);
    expect(layerWeightAt(grid, 25 * SIDE + 4, 3)).toBe(0);
    expectWhole(grid);
  });

  it('reads and writes a whole layer as values', () => {
    const grid = makeGrid();
    const values = new Float32Array(SIDE * SIDE).fill(0.25);
    setLayerFromValues(grid, 6, values);
    expect(layerValues(grid, 6)[100]).toBeCloseTo(0.25, 1);
  });

  it('reports how much of the ground each layer covers', () => {
    const grid = makeGrid();
    setLayerFromValues(grid, 1, new Float32Array(SIDE * SIDE).fill(0.5));
    const coverage = layerCoverage(grid.weights, grid.weights2 ?? undefined, SIDE * SIDE, 3);
    expect(coverage[0]).toBeCloseTo(0.5, 1);
    expect(coverage[1]).toBeCloseTo(0.5, 1);
    expect(coverage[2]).toBe(0);
    expect(layerCoverage(undefined, undefined, SIDE * SIDE, 2)).toEqual([1, 0]);
  });
});

describe('terrain layer settings', () => {
  it('keeps eight layers and what each really has', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ tiling: index + 1 }));
    expect(normalizeTerrainLayers(many)).toHaveLength(8);
    const [layer] = normalizeTerrainLayers([{ tiling: 4, name: 'Rock', normalTextureId: 'n', heightContrast: 1, cliffProjection: true, rotation: 'no', tint: '#ff0000' }]);
    expect(layer).toEqual({ tiling: 4, name: 'Rock', normalTextureId: 'n', heightContrast: 1, cliffProjection: true, tint: '#ff0000' });
  });

  it('prefers a tile size in metres over repeats across the width', () => {
    expect(terrainLayerTileSize({ tiling: 16, tileSize: 5 }, 100)).toBe(5);
    expect(terrainLayerTileSize({ tiling: 20 }, 100)).toBe(5);
  });

  it('forgets a deleted texture in any of a layer\'s maps, keeping the layer', () => {
    const terrain = { textureLayers: [{ tiling: 1, textureId: 'a', normalTextureId: 'gone', heightTextureId: 'gone' }] };
    expect(terrainLayersReferenceTexture(terrain, 'gone')).toBe(true);
    expect(withoutTerrainLayerTexture(terrain, 'gone').textureLayers).toEqual([{ tiling: 1, textureId: 'a' }]);
    expect(terrainLayersReferenceTexture(terrain, 'other')).toBe(false);
  });
});
