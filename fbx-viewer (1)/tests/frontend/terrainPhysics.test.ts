import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import type { LevelObject } from '../../types';
import { FLAT_GROUND_CLEARANCE, flatGroundHeight, terrainHeightfieldShape, terrainLowestSurface } from '../../runtime/terrainPhysics';

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

  it('gives never-sculpted, pending and malformed terrains a flat field, and rejects invalid grids', () => {
    const flat = (resolution: number) => ({
      rows: resolution, columns: resolution, heights: new Float32Array((resolution + 1) ** 2), scale: { x: 40, y: 1, z: 20 },
    });
    // A new terrain has heights: [], and a saved never-sculpted one has none at all.
    expect(terrainHeightfieldShape(terrain([], 4))).toEqual(flat(4));
    expect(terrainHeightfieldShape(terrain(undefined as unknown as number[], 4))).toEqual(flat(4));
    expect(terrainHeightfieldShape(terrain([0, 0, 0], 4))).toEqual(flat(4));
    // TerrainObject draws a terrain whose heights are still loading flat too.
    const pending = terrain([], 2, {
      terrainData: { resolution: 2, width: 40, depth: 20, heights: [], heightfield: { assetId: 'a'.repeat(64), encoding: 'float32le', columns: 3, rows: 3 } },
    } as Partial<LevelObject>);
    expect(terrainHeightfieldShape(pending)).toEqual(flat(2));

    expect(terrainHeightfieldShape(terrain([], 0))).toBeNull();
    expect(terrainHeightfieldShape(terrain([], 4, { terrainData: { resolution: 4, width: 0, depth: 20, heights: [] } }))).toBeNull();
    expect(terrainHeightfieldShape(terrain([], 4, { terrainData: undefined }))).toBeNull();
  });

  it('holds bodies on an unsculpted terrain at its own height', () => {
    const shape = terrainHeightfieldShape(terrain([], 4))!;
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(5, 2, -3));
    world.createCollider(RAPIER.ColliderDesc.heightfield(shape.rows, shape.columns, shape.heights, shape.scale), body);
    world.step();
    const hit = world.castRay(new RAPIER.Ray({ x: 8, y: 50, z: -1 }, { x: 0, y: -1, z: 0 }), 100, true);
    expect(hit).not.toBeNull();
    const { toi, timeOfImpact } = hit as unknown as { toi?: number; timeOfImpact?: number };
    expect(50 - (timeOfImpact ?? toi ?? Number.NaN)).toBeCloseTo(2, 3);
    world.free();
  });

  it('keeps the flat ground at y = 0 unless a terrain reaches below it, then just under that terrain', () => {
    expect(flatGroundHeight([])).toBe(0);
    // Flat at y = 2 (here unsculpted), or hills above y = 0: bodies knocked off the edge land at y = 0, like the player.
    expect(terrainLowestSurface(terrain([], 4))).toBeCloseTo(2, 6);
    expect(flatGroundHeight([terrain([], 4)])).toBe(0);
    expect(flatGroundHeight([terrain(new Array(25).fill(3), 4, { position: [0, 0, 0] })])).toBe(0);
    // A valley below y = 0: the flat ground drops under it rather than covering it, or going away.
    const valley = terrain([...new Array(24).fill(0), -1.5], 4, { position: [0, 0.5, 0] });
    expect(terrainLowestSurface(valley)).toBeCloseTo(-1, 6);
    expect(flatGroundHeight([terrain([], 4), valley])).toBeCloseTo(-1 - FLAT_GROUND_CLEARANCE, 6);
    // A tilted terrain dips below its origin.
    const tilted = terrain([], 4, { position: [0, 0, 0], rotation: [0.2, 0, 0] });
    expect(terrainLowestSurface(tilted)!).toBeLessThan(-1);
    expect(flatGroundHeight([tilted])).toBeCloseTo(terrainLowestSurface(tilted)! - FLAT_GROUND_CLEARANCE, 6);
    // A terrain with no heightfield (invalid grid) neither gets one nor moves the flat ground.
    expect(terrainLowestSurface(terrain([], 0))).toBeNull();
    expect(flatGroundHeight([terrain([], 0, { position: [0, -10, 0] })])).toBe(0);
  });

  it('folds the terrain scale into the heightfield extent', () => {
    const shape = terrainHeightfieldShape(terrain(new Array(9).fill(1), 2, { scale: [2, 3, 0.5] }))!;
    expect(shape.scale).toEqual({ x: 80, y: 3, z: 10 });
    expect(shape.rows).toBe(2);
    expect(shape.heights).toHaveLength(9);
  });
});
