import { describe, expect, it } from 'vitest';
import { resultMapSize } from '../../components/Tools/Retexture/retextureSession';
import { packedViews, type PackedView } from '../../components/Tools/Retexture/viewSheet';

const WIDTH = 2046;
const HEIGHT = 1364;

/** The six sides of a box, as the sheet shows them. */
const sidesOf = (x: number, y: number, z: number) => [
  { across: z, high: y }, { across: z, high: y },
  { across: x, high: y }, { across: x, high: y },
  { across: x, high: z }, { across: x, high: z },
];

const overlap = (a: PackedView, b: PackedView) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const expectWithinAndApart = (placed: readonly PackedView[]) => {
  placed.forEach((view, index) => {
    expect(view.x).toBeGreaterThanOrEqual(0);
    expect(view.y).toBeGreaterThanOrEqual(0);
    expect(view.x + view.width).toBeLessThanOrEqual(WIDTH);
    expect(view.y + view.height).toBeLessThanOrEqual(HEIGHT);
    placed.slice(index + 1).forEach((other) => expect(overlap(view, other)).toBe(false));
  });
};

describe('laying out views on a sheet', () => {
  it('gives a cube three across and two down', () => {
    const { scale, placed } = packedViews(sidesOf(1, 1, 1), WIDTH, HEIGHT);
    expectWithinAndApart(placed);
    expect(scale).toBeGreaterThan(660);
    expect(scale).toBeLessThan(683);
    expect(new Set(placed.map((view) => view.y)).size).toBe(2);
  });

  it('lays a long object along the sheet, several times larger than a square cell would have it', () => {
    const { scale, placed } = packedViews(sidesOf(1, 0.25, 0.06), WIDTH, HEIGHT);
    expectWithinAndApart(placed);
    // In a square third of the sheet, its length would come to 682 pixels.
    expect(scale).toBeGreaterThan(682 * 2);
  });

  it('gives a tall object more than a square cell would', () => {
    const { scale, placed } = packedViews(sidesOf(0.6, 1.8, 0.4), WIDTH, HEIGHT);
    expectWithinAndApart(placed);
    expect(scale).toBeGreaterThan(682 / 1.8);
  });

  it('draws every view at the one scale, in its own shape', () => {
    const sizes = sidesOf(1, 0.5, 0.2);
    const { scale, placed } = packedViews(sizes, WIDTH, HEIGHT);
    placed.forEach((view, index) => {
      expect(view.width).toBe(Math.ceil(sizes[index].across * scale));
      expect(view.height).toBe(Math.ceil(sizes[index].high * scale));
    });
  });
});

describe('the size of a result\'s map', () => {
  it('grows a small map painted through views, laid out as it was', () => {
    expect(resultMapSize({ width: 1024, height: 1024 }, true)).toEqual({ width: 2048, height: 2048 });
    expect(resultMapSize({ width: 1024, height: 512 }, true)).toEqual({ width: 2048, height: 1024 });
  });

  it('leaves a large one as it is, and one that was not painted through views', () => {
    expect(resultMapSize({ width: 4096, height: 4096 }, true)).toEqual({ width: 4096, height: 4096 });
    expect(resultMapSize({ width: 1024, height: 1024 }, false)).toEqual({ width: 1024, height: 1024 });
  });

  it('makes one for a part with none', () => {
    expect(resultMapSize(undefined, true)).toEqual({ width: 2048, height: 2048 });
  });
});
