import { describe, expect, it } from 'vitest';
import { normalsFromHeight } from '../../utils/fbxImport/imagePixels';

/** A height map from a function of each pixel, grey. */
const heights = (width: number, height: number, at: (x: number, y: number) => number) => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = Math.round(at(x, y) * 255);
      data.set([value, value, value, 255], (y * width + x) * 4);
    }
  }
  return { data, width, height };
};

const normalAt = (map: { data: Uint8Array | Uint8ClampedArray; width: number }, x: number, y: number): number[] => {
  const at = (y * map.width + x) * 4;
  return [map.data[at], map.data[at + 1], map.data[at + 2]].map((value) => value / 255 * 2 - 1);
};

describe('a normal map from a height map', () => {
  it('leaves a flat height map facing straight out', () => {
    const map = normalsFromHeight(heights(4, 4, () => 0.5));
    const [x, y, z] = normalAt(map, 2, 2);
    expect(Math.abs(x)).toBeLessThan(0.01);
    expect(Math.abs(y)).toBeLessThan(0.01);
    expect(z).toBeGreaterThan(0.98);
  });

  it('leans away from a slope rising to the right', () => {
    const map = normalsFromHeight(heights(16, 16, (x) => x / 32));
    const [x, y] = normalAt(map, 8, 8);
    expect(x).toBeLessThan(-0.05);
    expect(Math.abs(y)).toBeLessThan(0.01);
  });

  it('leans towards the top of the image from a slope rising to its bottom, as glTF expects', () => {
    const map = normalsFromHeight(heights(16, 16, (_, y) => y / 32));
    const [x, y] = normalAt(map, 8, 8);
    expect(Math.abs(x)).toBeLessThan(0.01);
    expect(y).toBeGreaterThan(0.05);
  });

  it('tiles: the edges read the far side, and every pixel is opaque', () => {
    const map = normalsFromHeight(heights(8, 8, (x) => (x === 0 ? 1 : 0)));
    expect(normalAt(map, 7, 3)[0]).toBeLessThan(-0.3);
    expect(normalAt(map, 1, 3)[0]).toBeGreaterThan(0.3);
    for (let at = 3; at < map.data.length; at += 4) expect(map.data[at]).toBe(255);
  });
});
