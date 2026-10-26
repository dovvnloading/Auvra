import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import type { LevelObject } from '../../types';
import { terrainHeightfieldShape } from '../../runtime/terrainPhysics';

const terrain = (heights: number[], resolution: number, extra: Partial<LevelObject> = {}): LevelObject => ({
  id: 'terrain-1', levelId: 'level-1', modelId: '', name: 'Terrain', type: 'terrain',
  position: [5, 2, -3], rotation: [0, 0, 0], scale: [1, 1, 1],
  terrainData: { resolution, width: 40, depth: 20, heights },
  ...extra,
} as LevelObject);

describe('terrain physics', () => {
  beforeAll(async () => { await RAPIER.init(); });

  it('matches the rendered terrain at every grid vertex', () => {
    // Asymmetric heights so a swapped or flipped axis lands on the wrong value.
    const resolution = 4;
    const samples = resolution + 1;
    const heights = Array.from({ length: samples * samples }, (_, index) => Math.floor(index / samples) + 10 * (index % samples));
    const object = terrain(heights, resolution);
    const shape = terrainHeightfieldShape(object)!;

    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(5, 2, -3));
    world.createCollider(RAPIER.ColliderDesc.heightfield(shape.rows, shape.columns, shape.heights, shape.scale), body);
    world.step();

    const { width, depth } = object.terrainData!;
    for (let row = 0; row < samples; row++) {
      for (let column = 0; column < samples; column++) {
        // The rendered plane: row 0 at the far (-Z) edge, column 0 at -X.
        const x = 5 - width / 2 + (column * width) / resolution;
        const z = -3 - depth / 2 + (row * depth) / resolution;
        const ray = new RAPIER.Ray({ x: x * 0.999 + 5 * 0.001, y: 500, z: z * 0.999 - 3 * 0.001 }, { x: 0, y: -1, z: 0 });
        const hit = world.castRay(ray, 1000, true);
        expect(hit).not.toBeNull();
        // The field was renamed between Rapier releases; the heightfield layout is the same in both.
        const { toi, timeOfImpact } = hit as unknown as { toi?: number; timeOfImpact?: number };
        const groundY = 500 - (timeOfImpact ?? toi ?? Number.NaN);
        expect(groundY).toBeCloseTo(2 + heights[row * samples + column], 0);
      }
    }
    world.free();
  });

  it('waits for heights and rejects malformed grids', () => {
    expect(terrainHeightfieldShape(terrain([], 4))).toBeNull();
    expect(terrainHeightfieldShape(terrain([0, 0, 0], 4))).toBeNull();
    const pending = terrain([], 2, {
      terrainData: { resolution: 2, width: 10, depth: 10, heights: [], heightfield: { assetId: 'a'.repeat(64), encoding: 'float32le', columns: 3, rows: 3 } },
    } as Partial<LevelObject>);
    expect(terrainHeightfieldShape(pending)).toBeNull();
  });

  it('folds the terrain scale into the heightfield extent', () => {
    const shape = terrainHeightfieldShape(terrain(new Array(9).fill(1), 2, { scale: [2, 3, 0.5] }))!;
    expect(shape.scale).toEqual({ x: 80, y: 3, z: 10 });
    expect(shape.rows).toBe(2);
    expect(shape.heights).toHaveLength(9);
  });
});
