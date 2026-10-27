import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  chooseChunkLevel, chunkBounds, chunkEdge, chunkIndices, chunkLayout, CHUNK_CELLS, skirtGeometryData,
} from '../../components/Environment/Terrain/terrainChunks';

const triangles = (indices: ArrayLike<number>): Set<string> => {
  const set = new Set<string>();
  for (let i = 0; i < indices.length; i += 3) set.add([indices[i], indices[i + 1], indices[i + 2]].join(','));
  return set;
};

describe('terrain chunks', () => {
  it('covers the grid with chunks that share their edges', () => {
    const chunks = chunkLayout(100);
    expect(chunks).toHaveLength(16);
    expect(chunks[0]).toMatchObject({ x0: 0, y0: 0, x1: CHUNK_CELLS, y1: CHUNK_CELLS });
    expect(chunks[3]).toMatchObject({ x0: 96, x1: 100 });
    expect(chunkLayout(8)).toEqual([{ cx: 0, cy: 0, x0: 0, y0: 0, x1: 8, y1: 8 }]);
  });

  it('draws exactly the plane geometry\'s triangles at full detail', () => {
    const segments = 70;
    const plane = new THREE.PlaneGeometry(10, 10, segments, segments);
    const all = new Set<string>();
    for (const chunk of chunkLayout(segments)) triangles(chunkIndices(segments, chunk, 0)).forEach(t => all.add(t));
    expect(all).toEqual(triangles(plane.index!.array));
  });

  it('uses every 2^level-th vertex and always reaches the chunk edges', () => {
    const segments = 64;
    const [chunk] = chunkLayout(segments);
    expect(chunkIndices(segments, chunk, 0).length).toBe(32 * 32 * 6);
    expect(chunkIndices(segments, chunk, 2).length).toBe(8 * 8 * 6);
    const odd = { cx: 0, cy: 0, x0: 0, y0: 0, x1: 5, y1: 5 };
    const used = new Set(chunkIndices(5, odd, 2));
    // Steps of 4 from 0 to 5 still end on the last column and row: 0, 4, 5.
    for (const x of [0, 4, 5]) for (const y of [0, 4, 5]) expect(used.has(x + 6 * y)).toBe(true);
    expect(used.size).toBe(9);
  });

  it('walks the chunk edge once around, and hangs the skirt below it', () => {
    const segments = 4;
    const chunk = { cx: 0, cy: 0, x0: 0, y0: 0, x1: 4, y1: 4 };
    const edge = chunkEdge(segments, chunk, 1);
    expect(edge).toEqual([0, 2, 4, 14, 24, 22, 20, 10]);
    const plane = new THREE.PlaneGeometry(4, 4, segments, segments);
    const skirt = skirtGeometryData(plane.attributes.position.array, null, segments, chunk, 1, 2);
    expect(skirt.positions.length).toBe(edge.length * 2 * 3);
    // The lowered copy of the first edge vertex sits 2 below it (Z is the height before the plane is rotated).
    expect(skirt.positions[edge.length * 3 + 2]).toBeCloseTo(skirt.positions[2] - 2);
    expect(skirt.indices.length).toBe(edge.length * 6);
    expect(Math.max(...skirt.indices)).toBe(edge.length * 2 - 1);
  });

  it('coarsens with distance and does not flicker back at a boundary', () => {
    expect(chooseChunkLevel(10, 50, null)).toBe(0);
    expect(chooseChunkLevel(60, 50, null)).toBe(1);
    expect(chooseChunkLevel(150, 50, null)).toBe(2);
    expect(chooseChunkLevel(1e6, 50, null)).toBe(3);
    // At level 1 the switch back to 0 waits until 15% inside the boundary (50).
    expect(chooseChunkLevel(48, 50, 1)).toBe(1);
    expect(chooseChunkLevel(40, 50, 1)).toBe(0);
  });

  it('bounds a chunk by its vertices', () => {
    const plane = new THREE.PlaneGeometry(4, 4, 4, 4);
    const positions = plane.attributes.position.array as Float32Array;
    positions[2] = 7;
    const bounds = chunkBounds(positions, 4, { cx: 0, cy: 0, x0: 0, y0: 0, x1: 2, y1: 2 });
    expect(bounds.max[2]).toBe(7);
    expect(bounds.min[0]).toBeCloseTo(-2);
    expect(bounds.max[0]).toBeCloseTo(0);
  });
});
