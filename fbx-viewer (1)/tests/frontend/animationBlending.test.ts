import { createElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  blendSeconds,
  blendSpaceTriangles,
  blendWeights1D,
  blendWeights2D,
  clampAnimationDelta,
  DEFAULT_BLEND_SECONDS,
  stepWeight,
} from '../../components/AnimationGraph/utils/blending';
import { BlendStateConfig } from '../../components/AnimationGraph/Inspectors/BlendStateConfig';
import type { GraphState } from '../../types';

type Point = [number, number];

const at = (...positions: Point[]) => positions.map(position => ({ position }));
const sum = (weights: number[]) => weights.reduce((total, weight) => total + weight, 0);

/** Deterministic pseudo-random numbers in [0, 1). */
const random = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Area of the convex hull (monotone chain). */
const hullArea = (points: Point[]) => {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (list: Point[]) => {
    const chain: Point[] = [];
    list.forEach(point => {
      while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], point) <= 0) chain.pop();
      chain.push(point);
    });
    return chain.slice(0, -1);
  };
  const hull = [...half(sorted), ...half([...sorted].reverse())];
  return Math.abs(hull.reduce((area, point, index) => {
    const next = hull[(index + 1) % hull.length];
    return area + point[0] * next[1] - next[0] * point[1];
  }, 0)) / 2;
};

const triangleArea = (points: Point[], [a, b, c]: readonly [number, number, number]) => cross(points[a], points[b], points[c]) / 2;

describe('animation blending', () => {
  it('crossfades over the configured duration regardless of frame rate', () => {
    const run = (fps: number) => {
      let weight = 0;
      let time = 0;
      while (weight < 1) { weight = stepWeight(weight, 1, 1 / fps, 0.5); time += 1 / fps; }
      return time;
    };
    expect(run(30)).toBeCloseTo(0.5, 1);
    expect(run(144)).toBeCloseTo(0.5, 1);
    expect(stepWeight(0.3, 0, 0.1, 0)).toBe(0);
  });

  it('falls back to the default duration for missing or invalid values', () => {
    expect(blendSeconds(0.75)).toBe(0.75);
    expect(blendSeconds(undefined)).toBe(DEFAULT_BLEND_SECONDS);
    expect(blendSeconds(-1)).toBe(DEFAULT_BLEND_SECONDS);
  });

  it('clamps long frames', () => {
    expect(clampAnimationDelta(2)).toBe(0.1);
    expect(clampAnimationDelta(Number.NaN)).toBe(0);
  });
});

describe('1D blend space', () => {
  const samples = at([3, 0], [0, 0], [1, 0]);

  it('interpolates linearly between the two neighbouring samples', () => {
    const half = blendWeights1D(samples, 0.5);
    expect(half[0]).toBe(0);
    expect(half[1]).toBeCloseTo(0.5);
    expect(half[2]).toBeCloseTo(0.5);
    const quarter = blendWeights1D(samples, 1.5);
    expect(quarter[0]).toBeCloseTo(0.25);
    expect(quarter[1]).toBe(0);
    expect(quarter[2]).toBeCloseTo(0.75);
  });

  it('clamps to the end samples and is exact at sample positions', () => {
    expect(blendWeights1D(samples, -4)).toEqual([0, 1, 0]);
    expect(blendWeights1D(samples, 12)).toEqual([1, 0, 0]);
    expect(blendWeights1D(samples, 3)).toEqual([1, 0, 0]);
    expect(blendWeights1D(samples, 1)).toEqual([0, 0, 1]);
  });

  it('reads only the x position and lets duplicates share their weight', () => {
    const shared = at([0, 4], [1, -2], [1, 9]);
    expect(blendWeights1D(shared, 1)).toEqual([0, 0.5, 0.5]);
    const between = blendWeights1D(shared, 0.5);
    expect(between[0]).toBeCloseTo(0.5);
    expect(between[1]).toBeCloseTo(0.25);
    expect(between[2]).toBeCloseTo(0.25);
  });

  it('handles empty, single and non-finite input', () => {
    expect(blendWeights1D([], 1)).toEqual([]);
    expect(blendWeights1D(at([5, 0]), -1)).toEqual([1]);
    expect(blendWeights1D(at([-1, 0], [1, 0]), Number.NaN)).toEqual([0.5, 0.5]);
    expect(blendWeights1D(at([Number.NaN, 0], [2, 0]), 0)).toEqual([1, 0]);
  });

  it('sums to one across the whole range', () => {
    const spread = at([-2, 0], [0.5, 0], [0.5, 0], [3, 0], [7, 0]);
    for (let x = -4; x <= 9; x += 0.37) {
      const weights = blendWeights1D(spread, x);
      expect(sum(weights)).toBeCloseTo(1, 12);
      weights.forEach(weight => expect(weight).toBeGreaterThanOrEqual(0));
    }
  });
});

describe('2D blend space', () => {
  const diamond = at([0, 0], [0, 1], [0, -1], [-1, 0], [1, 0]);

  it('uses barycentric weights inside a triangle', () => {
    const weights = blendWeights2D(at([0, 0], [2, 0], [0, 2]), 0.5, 0.5);
    expect(weights[0]).toBeCloseTo(0.5);
    expect(weights[1]).toBeCloseTo(0.25);
    expect(weights[2]).toBeCloseTo(0.25);

    const inDiamond = blendWeights2D(diamond, 0.2, 0.3);
    expect(inDiamond[0]).toBeCloseTo(0.5);
    expect(inDiamond[1]).toBeCloseTo(0.3);
    expect(inDiamond[4]).toBeCloseTo(0.2);
    expect(inDiamond[2]).toBe(0);
    expect(inDiamond[3]).toBe(0);
  });

  it('gives a sample exactly the whole weight at its own position', () => {
    const grid: Point[] = [];
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) grid.push([x, y]);
    const ring: Point[] = [[0, 0], ...Array.from({ length: 8 }, (_, i): Point => [Math.cos(i * Math.PI / 4), Math.sin(i * Math.PI / 4)])];
    [diamond.map(sample => sample.position), grid, ring].forEach(layout => {
      layout.forEach((position, index) => {
        expect(blendWeights2D(at(...layout), position[0], position[1])).toEqual(layout.map((_, i) => (i === index ? 1 : 0)));
      });
    });
  });

  it('projects points outside the hull onto the nearest hull edge', () => {
    const triangle = at([0, 0], [1, 0], [0, 1]);
    const below = blendWeights2D(triangle, 0.25, -3);
    expect(below[0]).toBeCloseTo(0.75);
    expect(below[1]).toBeCloseTo(0.25);
    expect(below[2]).toBe(0);
    const beyondHypotenuse = blendWeights2D(triangle, 1, 1);
    expect(beyondHypotenuse[0]).toBe(0);
    expect(beyondHypotenuse[1]).toBeCloseTo(0.5);
    expect(beyondHypotenuse[2]).toBeCloseTo(0.5);
    expect(blendWeights2D(triangle, -2, -1)).toEqual([1, 0, 0]);

    const corner = blendWeights2D(diamond, 2, 2);
    expect(corner[1]).toBeCloseTo(0.5);
    expect(corner[4]).toBeCloseTo(0.5);
    expect(corner[0]).toBe(0);
  });

  it('changes continuously across triangle and hull edges', () => {
    let previous = blendWeights2D(diamond, -1.5, 0.37);
    for (let x = -1.5; x <= 1.5; x += 0.01) {
      const weights = blendWeights2D(diamond, x, 0.37);
      weights.forEach((weight, index) => expect(Math.abs(weight - previous[index])).toBeLessThan(0.05));
      previous = weights;
    }
  });

  it('falls back to a 1D blend along the line for two or collinear samples', () => {
    const diagonal = at([0, 0], [2, 2], [1, 1]);
    expect(blendSpaceTriangles(diagonal)).toEqual([]);
    const between = blendWeights2D(diagonal, 0.5, 0.5);
    expect(between[0]).toBeCloseTo(0.5);
    expect(between[2]).toBeCloseTo(0.5);
    expect(between[1]).toBe(0);
    const offLine = blendWeights2D(diagonal, 2, 1);
    expect(offLine[1]).toBeCloseTo(0.5);
    expect(offLine[2]).toBeCloseTo(0.5);
    expect(blendWeights2D(diagonal, 9, 9)).toEqual([0, 1, 0]);
    expect(blendWeights2D(diagonal, -9, -9)).toEqual([1, 0, 0]);

    const pair = blendWeights2D(at([0, 0], [4, 0]), 1, 3);
    expect(pair[0]).toBeCloseTo(0.75);
    expect(pair[1]).toBeCloseTo(0.25);
  });

  it('handles empty, single and duplicate samples', () => {
    expect(blendWeights2D([], 0, 0)).toEqual([]);
    expect(blendWeights2D(at([3, 3]), -5, 8)).toEqual([1]);
    expect(blendWeights2D(at([0, 0], [1, 0], [1, 0], [0, 1]), 1, 0)).toEqual([0, 0.5, 0.5, 0]);
    expect(blendWeights2D(at([2, 2], [2, 2]), 0, 0)).toEqual([0.5, 0.5]);
  });

  it('sums to one with weights in [0, 1] and at most three samples active', () => {
    const next = random(7);
    for (let layout = 0; layout < 20; layout++) {
      const samples = at(...Array.from({ length: 3 + (layout % 9) }, (): Point => [next() * 4 - 2, next() * 4 - 2]));
      for (let query = 0; query < 40; query++) {
        const weights = blendWeights2D(samples, next() * 8 - 4, next() * 8 - 4);
        expect(sum(weights)).toBeCloseTo(1, 9);
        weights.forEach(weight => {
          expect(weight).toBeGreaterThanOrEqual(0);
          expect(weight).toBeLessThanOrEqual(1);
        });
        expect(weights.filter(weight => weight > 0).length).toBeLessThanOrEqual(3);
      }
    }
  });

  it('triangulates grids and rings of samples without gaps or overlaps', () => {
    const grid: Point[] = [];
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) grid.push([x, y]);
    const ring: Point[] = [[0, 0], ...Array.from({ length: 8 }, (_, i): Point => [Math.cos(i * Math.PI / 4), Math.sin(i * Math.PI / 4)])];
    [grid, ring].forEach(points => {
      const triangles = blendSpaceTriangles(at(...points));
      expect(triangles).toHaveLength(8);
      triangles.forEach(triangle => expect(triangleArea(points, triangle)).toBeGreaterThan(0));
      expect(triangles.reduce((area, triangle) => area + triangleArea(points, triangle), 0)).toBeCloseTo(hullArea(points), 9);
    });
  });

  it('builds a Delaunay triangulation covering the hull of scattered samples', () => {
    const next = random(42);
    for (let layout = 0; layout < 10; layout++) {
      const points = Array.from({ length: 6 + layout * 3 }, (): Point => [next() * 10 - 5, next() * 6 - 3]);
      const triangles = blendSpaceTriangles(at(...points));
      expect(triangles.reduce((area, triangle) => area + triangleArea(points, triangle), 0)).toBeCloseTo(hullArea(points), 6);
      triangles.forEach(([a, b, c]) => {
        const [ax, ay] = points[a];
        const [bx, by] = points[b];
        const [cx, cy] = points[c];
        points.forEach(([px, py], index) => {
          if (index === a || index === b || index === c) return;
          const det = (ax - px) * ((by - py) * ((cx - px) ** 2 + (cy - py) ** 2) - (cy - py) * ((bx - px) ** 2 + (by - py) ** 2))
            - (ay - py) * ((bx - px) * ((cx - px) ** 2 + (cy - py) ** 2) - (cx - px) * ((bx - px) ** 2 + (by - py) ** 2))
            + ((ax - px) ** 2 + (ay - py) ** 2) * ((bx - px) * (cy - py) - (cx - px) * (by - py));
          expect(det).toBeLessThan(1e-6);
        });
      });
    }
  });

  it('reuses the triangulation for the same sample positions', () => {
    const first = blendSpaceTriangles(at([0, 0], [1, 0], [0, 1], [1, 1]));
    expect(blendSpaceTriangles(at([0, 0], [1, 0], [0, 1], [1, 1]))).toBe(first);
    expect(blendSpaceTriangles(at([0, 0], [1, 0], [0, 1], [2, 2]))).not.toBe(first);
  });
});

describe('BlendStateConfig', () => {
  const state = (stateType: GraphState['stateType']): GraphState => ({
    id: 's1',
    name: 'Locomotion',
    position: { x: 0, y: 0 },
    loop: true,
    stateType,
    clipName: null,
    blendSamples: [
      { id: 'a', clipName: 'Idle', position: [0, 0] },
      { id: 'b', clipName: 'Run', position: [2, 1] },
    ],
    blendParamX: 'speed',
    blendParamY: 'turn',
  });
  const renderConfig = (node: GraphState) => {
    const updateState = vi.fn();
    render(createElement(BlendStateConfig, {
      node,
      updateState,
      clipOptions: [{ label: 'Idle', value: 'Idle' }, { label: 'Run', value: 'Run' }],
      blendParamOptions: [{ label: 'Speed', value: 'speed' }, { label: 'Turn', value: 'turn' }],
    }));
    return updateState;
  };

  it('shows only the X parameter and X positions for a 1D blend', () => {
    renderConfig(state('Blend1D'));
    expect(screen.getByText('X Axis')).toBeInTheDocument();
    expect(screen.queryByText('Y Axis')).not.toBeInTheDocument();
    expect(screen.getAllByLabelText(/X position/)).toHaveLength(2);
    expect(screen.queryAllByLabelText(/Y position/)).toHaveLength(0);
    expect(screen.getByRole('img', { name: /blend space/i })).toBeInTheDocument();
  });

  it('shows X and Y for a 2D blend and plots the axis ranges', () => {
    renderConfig(state('Blend2D'));
    expect(screen.getByText('Y Axis')).toBeInTheDocument();
    expect(screen.getAllByLabelText(/Y position/)).toHaveLength(2);
    const plot = screen.getByRole('img', { name: /blend space/i });
    expect(plot.querySelectorAll('circle')).toHaveLength(2);
    expect(plot.getAttribute('aria-label')).toContain('Speed 0 to 2, Turn 0 to 1');
  });

  it('never writes a non-finite position', () => {
    const updateState = renderConfig(state('Blend2D'));
    const x = screen.getByLabelText('Sample 2 X position');
    fireEvent.change(x, { target: { value: '' } });
    fireEvent.change(x, { target: { value: '-' } });
    fireEvent.change(x, { target: { value: '1e999' } });
    expect(updateState).not.toHaveBeenCalled();
    fireEvent.change(x, { target: { value: '-0.5' } });
    expect(updateState).toHaveBeenCalledTimes(1);
    const samples = updateState.mock.calls[0][0].blendSamples;
    expect(samples[1].position).toEqual([-0.5, 1]);
    expect(samples[0].position).toEqual([0, 0]);
  });
});
