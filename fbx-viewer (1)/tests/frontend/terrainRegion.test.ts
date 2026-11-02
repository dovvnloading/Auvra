import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { brushMask, type TerrainBrushStamp, type TerrainEditGrid } from '../../components/Environment/Terrain/terrainBrush';
import { TerrainLiveEdit } from '../../components/Environment/Terrain/terrainLiveEdit';

// Five samples a side, four metres across: a wide flat brush reaches them all at full strength.
const grid: TerrainEditGrid = { columns: 5, rows: 5, width: 4, depth: 4 };
const stamp = (region: TerrainBrushStamp['region']): TerrainBrushStamp => ({
  x: 0, y: 0, radiusX: 10, radiusY: 10, falloff: 0, falloffType: 'smooth', shape: 'circle', region,
});

// The first column chosen fully, the second half way.
const columns = () => {
  const data = new Uint8Array(25);
  for (let row = 0; row < 5; row++) {
    data[row * 5] = 255;
    data[row * 5 + 1] = 128;
  }
  return data;
};

describe('a region limiting the brushes', () => {
  it('leaves a brush alone with no region', () => {
    expect(Array.from(brushMask(grid, stamp(null))!.weights.slice(0, 5))).toEqual([1, 1, 1, 1, 1]);
  });

  it('lets a brush work as far as the ground is chosen', () => {
    const weights = Array.from(brushMask(grid, stamp({ data: columns(), invert: false }))!.weights.slice(0, 5));
    expect(weights[0]).toBe(1);
    expect(weights[1]).toBeCloseTo(0.5, 1);
    expect(weights.slice(2)).toEqual([0, 0, 0]);
  });

  it('works outside it when inverted', () => {
    const weights = Array.from(brushMask(grid, stamp({ data: columns(), invert: true }))!.weights.slice(0, 5));
    expect(weights[0]).toBe(0);
    expect(weights[1]).toBeCloseTo(0.5, 1);
    expect(weights.slice(2)).toEqual([1, 1, 1]);
  });

  it('counts a terrain with none of it chosen as all outside', () => {
    expect(brushMask(grid, stamp({ data: null, invert: false }))).toBeNull();
    expect(Array.from(brushMask(grid, stamp({ data: null, invert: true }))!.weights.slice(0, 2))).toEqual([1, 1]);
  });

  it('says nothing is left when the brush is wholly outside', () => {
    const away = { ...stamp({ data: columns(), invert: false }), x: 2, radiusX: 0.5, radiusY: 0.5 };
    expect(brushMask(grid, away)).toBeNull();
  });
});

describe('choosing a region', () => {
  const live = () => new TerrainLiveEdit(new THREE.PlaneGeometry(4, 4, 4, 4), 4, 4, 4);
  const everywhere = () => brushMask(grid, stamp(null))!;

  it('builds up with the brush and comes off again', () => {
    const edit = live();
    edit.markRegion(everywhere(), 0.5, false);
    expect(edit.regionData?.[0]).toBe(128);
    expect(edit.regionTexture).not.toBeNull();
    edit.markRegion(everywhere(), 1, false);
    expect(edit.regionData?.[0]).toBe(255);
    edit.markRegion(everywhere(), 0.5, true);
    expect(edit.regionData?.[0]).toBe(128);
  });

  it('is gone once nothing is left in it, or when cleared', () => {
    const edit = live();
    edit.markRegion(everywhere(), 1, false);
    edit.markRegion(everywhere(), 1, true);
    edit.settleRegion();
    expect(edit.regionData).toBeNull();
    expect(edit.regionTexture).toBeNull();
    edit.markRegion(everywhere(), 1, false);
    edit.clearRegion();
    expect(edit.regionData).toBeNull();
  });

  it('starts nothing when taking from no region', () => {
    const edit = live();
    edit.markRegion(everywhere(), 1, true);
    expect(edit.regionData).toBeNull();
  });
});
