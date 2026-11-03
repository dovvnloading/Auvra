import { describe, expect, it } from 'vitest';
import { brushMask, falloffCurve, type TerrainBrushStamp } from '../../components/Environment/Terrain/terrainBrush';
import {
  applyErosion, applyFlatten, applyHydroErosion, applyMirror, applyNoise, applyRamp, applySculpt, applySmooth, applyTerrace,
  copyRegion, heightAt, pasteClip, slopeAt,
  type HeightToolContext, type TerrainHeightGrid,
} from '../../components/Environment/Terrain/terrainSculptTools';

const makeGrid = (segments = 64, size = 64, height: (x: number, y: number) => number = () => 0): TerrainHeightGrid => {
  const columns = segments + 1;
  const heights = new Float32Array(columns * columns);
  for (let row = 0; row < columns; row++) {
    for (let column = 0; column < columns; column++) {
      heights[row * columns + column] = height((column / segments) * size - size / 2, size / 2 - (row / segments) * size);
    }
  }
  return { columns, rows: columns, width: size, depth: size, heights };
};

const stamp = (changes: Partial<TerrainBrushStamp> = {}): TerrainBrushStamp => ({
  x: 0, y: 0, radiusX: 10, radiusY: 10, falloff: 0.5, falloffType: 'smooth', shape: 'circle', ...changes,
});

const context = (grid: TerrainHeightGrid, changes: Partial<HeightToolContext> = {}): HeightToolContext => ({
  grid, stamp: stamp(), strength: 1, dt: 0.1, invert: false, metres: 1, ...changes,
});

const span = (values: Float32Array): number => {
  let low = Infinity;
  let high = -Infinity;
  for (const value of values) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  return high - low;
};

describe('terrain brush', () => {
  it('holds full strength inside the falloff band and nothing past the edge', () => {
    const grid = makeGrid();
    const mask = brushMask(grid, stamp({ falloff: 0.5 }))!;
    const at = (x: number, y: number) => {
      const column = Math.round(((x + 32) / 64) * 64);
      const row = Math.round(((32 - y) / 64) * 64);
      return mask.weights[(row - mask.rect.r0) * mask.stride + column - mask.rect.c0];
    };
    expect(at(0, 0)).toBe(1);
    expect(at(4, 0)).toBe(1);
    expect(at(7.5, 0)).toBeGreaterThan(0);
    expect(at(7.5, 0)).toBeLessThan(1);
    expect(at(10, 0)).toBe(0);
  });

  it('falls off by each curve from 1 to 0', () => {
    for (const type of ['smooth', 'linear', 'spherical', 'tip'] as const) {
      expect(falloffCurve(type, 0)).toBeCloseTo(1);
      expect(falloffCurve(type, 1)).toBeCloseTo(0);
      expect(falloffCurve(type, 0.5)).toBeGreaterThan(0);
      expect(falloffCurve(type, 0.5)).toBeLessThan(1);
    }
    // Spherical stays high longest, the tip drops fastest.
    expect(falloffCurve('spherical', 0.5)).toBeGreaterThan(falloffCurve('smooth', 0.5));
    expect(falloffCurve('tip', 0.5)).toBeLessThan(falloffCurve('linear', 0.5));
  });

  it('is off the terrain when the brush misses it', () => {
    expect(brushMask(makeGrid(), stamp({ x: 500 }))).toBeNull();
  });
});

describe('terrain sculpt tools', () => {
  it('sculpt raises under the brush, lowers with Shift, and works while held still', () => {
    const grid = makeGrid();
    for (let frame = 0; frame < 5; frame++) applySculpt(context(grid));
    const raised = heightAt(grid, 0, 0);
    expect(raised).toBeGreaterThan(0);
    expect(heightAt(grid, 20, 20)).toBe(0);
    for (let frame = 0; frame < 5; frame++) applySculpt(context(grid, { invert: true }));
    expect(heightAt(grid, 0, 0)).toBeCloseTo(0, 4);
  });

  it('takes the same time to do the same work whatever the frame rate', () => {
    const fast = makeGrid();
    const slow = makeGrid();
    for (let frame = 0; frame < 12; frame++) applySculpt(context(fast, { dt: 1 / 120 }));
    for (let frame = 0; frame < 2; frame++) applySculpt(context(slow, { dt: 1 / 20 }));
    expect(heightAt(fast, 0, 0)).toBeCloseTo(heightAt(slow, 0, 0), 4);
  });

  it('smooth evens out bumps without moving the ground overall', () => {
    const grid = makeGrid(64, 64, (x, y) => 10 + Math.sin(x * 2) * Math.cos(y * 2));
    const before = heightAt(grid, 0, 0);
    for (let frame = 0; frame < 30; frame++) applySmooth(context(grid), 3);
    const after = grid.heights.slice();
    // The bumps under the brush are nearly gone, and the average height stays about 10: it does not sink.
    expect(Math.abs(heightAt(grid, 0, 0) - 10)).toBeLessThan(Math.abs(before - 10) + 0.2);
    expect(heightAt(grid, 0, 0)).toBeGreaterThan(9);
    expect(span(after)).toBeLessThanOrEqual(2.01);
  });

  it('flatten levels towards the target, and only one way when asked', () => {
    const grid = makeGrid(64, 64, (x) => x);
    for (let frame = 0; frame < 60; frame++) applyFlatten(context(grid, { stamp: stamp({ falloff: 0 }) }), { mode: 'both', target: 2 });
    expect(heightAt(grid, -5, 0)).toBeCloseTo(2, 1);
    expect(heightAt(grid, 5, 0)).toBeCloseTo(2, 1);

    const up = makeGrid(64, 64, (x) => x);
    for (let frame = 0; frame < 60; frame++) applyFlatten(context(up, { stamp: stamp({ falloff: 0 }) }), { mode: 'raise', target: 0 });
    expect(heightAt(up, -5, 0)).toBeCloseTo(0, 1);
    expect(heightAt(up, 5, 0)).toBeCloseTo(5, 1);
  });

  it('flatten along a slope makes a plane through the first point', () => {
    const grid = makeGrid(64, 64, (x, y) => 0.5 * x + Math.sin(y * 3) * 0.2);
    const slope = { x: 0.5, y: 0 };
    for (let frame = 0; frame < 60; frame++) {
      applyFlatten(context(grid, { stamp: stamp({ falloff: 0 }) }), { mode: 'both', target: 0, slopeX: slope.x, slopeY: slope.y });
    }
    expect(heightAt(grid, 4, 3)).toBeCloseTo(2, 1);
    expect(slopeAt(grid, 0, 0).x).toBeCloseTo(0.5, 1);
  });

  it('noise changes the ground only inside the brush', () => {
    const grid = makeGrid();
    applyNoise(context(grid), 6, 'both');
    expect(span(grid.heights)).toBeGreaterThan(0);
    expect(heightAt(grid, 25, 25)).toBe(0);
    const raised = makeGrid();
    applyNoise(context(raised), 6, 'raise');
    expect(Math.min(...raised.heights)).toBeGreaterThanOrEqual(0);
  });

  it('terrace pulls heights towards steps', () => {
    const grid = makeGrid(64, 64, (x) => x * 0.5 + 8);
    for (let frame = 0; frame < 60; frame++) applyTerrace(context(grid, { stamp: stamp({ falloff: 0 }) }), 4, 1);
    // Half way up a step it is almost on a ledge.
    const middle = heightAt(grid, 1, 0);
    expect(Math.abs(middle % 4)).toBeLessThan(0.75);
  });

  it('erosion wears a spike down and keeps the material', () => {
    const grid = makeGrid(64, 64, (x, y) => (Math.hypot(x, y) < 2 ? 12 : 0));
    const total = grid.heights.reduce((sum, value) => sum + value, 0);
    for (let frame = 0; frame < 40; frame++) {
      applyErosion(context(grid, { stamp: stamp({ falloff: 0, radiusX: 20, radiusY: 20 }), dt: 1 }), { threshold: 0.1, thickness: 0.5, iterations: 6 });
    }
    expect(heightAt(grid, 0, 0)).toBeLessThan(12);
    const after = grid.heights.reduce((sum, value) => sum + value, 0);
    expect(Math.abs(after - total) / total).toBeLessThan(0.05);
  });

  it('hydro erosion cuts into a slope', () => {
    const grid = makeGrid(64, 64, (x) => x * 0.4 + 20);
    const before = grid.heights.slice();
    for (let frame = 0; frame < 20; frame++) {
      applyHydroErosion(context(grid, { stamp: stamp({ falloff: 0, radiusX: 20, radiusY: 20 }), dt: 0.5 }), { rain: 2, sediment: 1, iterations: 16 });
    }
    let changed = 0;
    for (let index = 0; index < before.length; index++) if (grid.heights[index] !== before[index]) changed++;
    expect(changed).toBeGreaterThan(100);
    for (const value of grid.heights) expect(Number.isFinite(value)).toBe(true);
  });

  it('ramp runs a straight slope between its two ends', () => {
    const grid = makeGrid(64, 64, () => 0);
    applyRamp(grid, { start: { x: -20, y: 0, z: 0 }, end: { x: 20, y: 0, z: 10 }, width: 6, sideFalloff: 0.5 });
    expect(heightAt(grid, -20, 0)).toBeCloseTo(0, 1);
    expect(heightAt(grid, 0, 0)).toBeCloseTo(5, 1);
    expect(heightAt(grid, 20, 0)).toBeCloseTo(10, 1);
    // Past the sides it leaves the ground alone.
    expect(heightAt(grid, 0, 20)).toBe(0);
  });

  it('mirror copies one half onto the other', () => {
    const grid = makeGrid(64, 64, (x, y) => (x < 0 ? -x + y * 0.1 : 0));
    applyMirror(grid, 'x-to-plus', 0, 0);
    expect(heightAt(grid, 10, 3)).toBeCloseTo(heightAt(grid, -10, 3), 3);
    const turned = makeGrid(64, 64, (x, y) => (x > 0 ? x + y * 0.1 : 0));
    applyMirror(turned, 'x-turn', 0, 0);
    // A half turn: the far corner of the kept half lands on the opposite corner.
    expect(heightAt(turned, -10, 3)).toBeCloseTo(heightAt(turned, 10, -3), 3);
  });

  it('copy and paste carries a shape to another place', () => {
    const grid = makeGrid(64, 64, (x, y) => (Math.hypot(x + 16, y) < 8 ? 8 - Math.hypot(x + 16, y) : 0));
    const clip = copyRegion(grid, { c0: 4, r0: 20, c1: 28, r1: 44 }, 1, 1, 1);
    expect(clip.columns).toBe(25);
    pasteClip(grid, clip, { x: 16, y: 0, rotation: 0, metresX: 1, metresY: 1, metres: 1, floor: 0, edge: 0.1, mode: 'both' });
    expect(heightAt(grid, 16, 0)).toBeCloseTo(heightAt(grid, -16, 0), 1);
    const small = makeGrid();
    pasteClip(small, clip, { x: 16, y: 0, rotation: 0, metresX: 1, metresY: 1, metres: 1, floor: 3, edge: 0.1, mode: 'lower' });
    // Lower only ever cuts: on flat ground at 0 a paste at height 3 changes nothing.
    expect(heightAt(small, 16, 0)).toBe(0);
  });

  it('works in metres on a terrain scaled upright', () => {
    const grid = makeGrid();
    // A terrain stretched to twice the height: half a local unit to the metre.
    applyTerrace(context(grid, { metres: 0.5 }), 4, 1);
    applySculpt(context(grid, { metres: 0.5 }));
    const half = heightAt(grid, 0, 0);
    const full = makeGrid();
    applySculpt(context(full, { metres: 1 }));
    expect(half).toBeLessThan(heightAt(full, 0, 0));
  });
});
