import { describe, expect, it } from 'vitest';
import { spawnPositionAround } from '../../runtime/spawning';

describe('spawner placement', () => {
  it('puts the first spawn on the spawner and later ones apart from it and each other', () => {
    const base: [number, number, number] = [0, 2, -24];
    expect(spawnPositionAround(base, 0)).toEqual([0, 2, -24]);
    const placed = [0, 1, 2, 3, 4].map(index => spawnPositionAround(base, index));
    for (const [x, y] of placed) expect(y).toBe(2);
    for (let a = 0; a < placed.length; a += 1) {
      for (let b = a + 1; b < placed.length; b += 1) {
        expect(Math.hypot(placed[a][0] - placed[b][0], placed[a][2] - placed[b][2])).toBeGreaterThan(1);
      }
    }
    expect(Math.hypot(placed[1][0], placed[1][2] + 24)).toBeCloseTo(1.5);
  });
});
