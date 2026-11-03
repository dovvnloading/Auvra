import * as THREE from 'three';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LevelObject } from '../../types';
import {
  FLAT_GROUND_CLEARANCE,
  FLAT_GROUND_SHAPE,
  flatGroundHeight,
  terrainHeightfieldShape,
  terrainSurfaceHeight,
} from '../../runtime/terrainPhysics';
import { physicsUserData } from '../../runtime/physicsQueries';
import { createCharacterRig, resolveLocomotionSpeeds, stepCharacterPhysics } from '../../components/Sandbox/hooks/usePlayerPhysics';
import { loadRuntimeRapier } from './rapierRuntime';
import type { RuntimeRapier } from './rapierRuntime';

/*
 * Where things land off a terrain that reaches below y = 0: bodies and the player get the same flat
 * ground (LevelGroundColliders' heightfield, and the player's fallback floor without colliders), and
 * a terrain whose heights are missing holds the player at its own height.
 */

type World = InstanceType<RuntimeRapier['World']>;
type Vec3 = [number, number, number];

const FRAME = 1 / 60;
const CHARACTER_HEIGHT = 1.8;
const WALK = resolveLocomotionSpeeds(undefined).walk;
const STILL = { x: 0, z: 0 };
const FEET_TOLERANCE = 0.03;

let RAPIER: RuntimeRapier;
const toFree: { free(): void }[] = [];

beforeAll(async () => {
  RAPIER = await loadRuntimeRapier();
});

afterEach(() => {
  for (const resource of toFree.splice(0)) resource.free();
});

const createWorld = (): World => {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FRAME;
  toFree.push(world);
  return world;
};

const terrain = (id: string, position: Vec3, heights: number[], extra: Partial<LevelObject> = {}): LevelObject => ({
  id, levelId: 'level-1', modelId: '', name: id, type: 'terrain',
  position, rotation: [0, 0, 0], scale: [1, 1, 1],
  terrainData: { resolution: 2, width: 20, depth: 20, heights },
  ...extra,
} as LevelObject);

/** A 20 x 20 terrain at y = 0 with a pit 2 m deep in the middle: it spans x and z from -10 to 10. */
const basin = terrain('basin', [0, 0, 0], [0, 0, 0, 0, -2, 0, 0, 0, 0]);

/** LevelGroundColliders: the terrain's heightfield and the flat ground at flatGroundHeight. */
const addLevelGround = (world: World, terrains: readonly LevelObject[]) => {
  for (const object of terrains) {
    const shape = terrainHeightfieldShape(object)!;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(...object.position));
    body.userData = physicsUserData(object.id);
    world.createCollider(RAPIER.ColliderDesc.heightfield(shape.rows, shape.columns, shape.heights, { ...shape.scale }), body);
  }
  const ground = FLAT_GROUND_SHAPE;
  world.createCollider(
    RAPIER.ColliderDesc.heightfield(ground.rows, ground.columns, ground.heights, { ...ground.scale }),
    world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, flatGroundHeight(terrains), 0))
  );
  world.step();
};

/** The runtime's character standing at `feet`, stepped against the world for `frames` frames. */
const runPlayer = (world: World, feet: Vec3, frames: number, obstacles: readonly LevelObject[], playerTerrain: LevelObject | null) => {
  const model = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, CHARACTER_HEIGHT, 0.3));
  mesh.position.y = CHARACTER_HEIGHT / 2;
  model.add(mesh);
  model.position.set(...feet);
  const context = { world, rapier: RAPIER };
  const rig = createCharacterRig(context, model);
  for (let frame = 0; frame < frames; frame++) {
    stepCharacterPhysics(context, rig, { jumpPressed: false }, STILL, WALK, FRAME, obstacles, playerTerrain);
    world.step();
  }
  return { feet: model.position, grounded: rig.grounded };
};

describe('ground off a terrain that reaches below y = 0', () => {
  const ground = flatGroundHeight([basin]);

  it('sits just under the lowest terrain point', () => {
    expect(ground).toBeCloseTo(-2 - FLAT_GROUND_CLEARANCE, 6);
  });

  it('lands a body knocked off the terrain on the flat ground instead of letting it fall forever', () => {
    const world = createWorld();
    addLevelGround(world, [basin]);
    const ball = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(30, 2, 0));
    world.createCollider(RAPIER.ColliderDesc.ball(0.5), ball);
    for (let frame = 0; frame < 240; frame++) world.step();
    expect(ball.translation().y).toBeCloseTo(ground + 0.5, 1);
    expect(Math.abs(ball.linvel().y)).toBeLessThan(0.05);
  });

  it('drops the player who walks off the terrain onto the same ground as bodies, not a floor at y = 0', () => {
    const world = createWorld();
    addLevelGround(world, [basin]);
    const player = runPlayer(world, [30, 0.5, 0], 120, [basin], basin);
    expect(player.grounded).toBe(true);
    expect(Math.abs(player.feet.y - ground)).toBeLessThan(FEET_TOLERANCE);
  });

  it('puts the fallback floor there too when no collider lies below the player', () => {
    // A world without colliders: only the player's legacy floor can hold it up.
    const player = runPlayer(createWorld(), [30, 0.5, 0], 120, [basin], basin);
    expect(player.grounded).toBe(true);
    expect(Math.abs(player.feet.y - ground)).toBeLessThan(FEET_TOLERANCE);
  });

  it('keeps the ground at y = 0 off a terrain that stays above it', () => {
    const mesa = terrain('mesa', [0, 3, 0], new Array(9).fill(1));
    expect(flatGroundHeight([mesa])).toBe(0);
    const player = runPlayer(createWorld(), [30, 0.5, 0], 60, [mesa], mesa);
    expect(Math.abs(player.feet.y)).toBeLessThan(FEET_TOLERANCE);
  });
});

describe('the player on a terrain whose heights are missing', () => {
  it('stands at the terrain\'s own height, where its flat heightfield is, rather than at y = 0', () => {
    // Heights still loading (or never sculpted): the collider is flat at the terrain's position.
    const pending = terrain('pending', [0, 3, 0], []);
    const player = runPlayer(createWorld(), [2, 3.5, -1], 90, [pending], pending);
    expect(player.grounded).toBe(true);
    expect(Math.abs(player.feet.y - 3)).toBeLessThan(FEET_TOLERANCE);
  });
});

describe('terrainSurfaceHeight', () => {
  it('matches the heightfield: flat at the terrain\'s height without usable heights, null off the footprint', () => {
    expect(terrainSurfaceHeight(2, -1, terrain('pending', [0, 3, 0], []))).toBe(3);
    expect(terrainSurfaceHeight(2, -1, terrain('unsaved', [0, 3, 0], undefined as unknown as number[]))).toBe(3);
    expect(terrainSurfaceHeight(2, -1, terrain('malformed', [0, 3, 0], [1, 2, 3]))).toBe(3);
    expect(terrainSurfaceHeight(10.5, 0, terrain('pending', [0, 3, 0], []))).toBeNull();
    expect(terrainSurfaceHeight(0, 0, terrain('invalid', [0, 3, 0], [], { terrainData: { resolution: 0, width: 20, depth: 20, heights: [] } }))).toBeNull();
  });

  it('samples between grid points, with row 0 at the far (-Z) edge and the terrain\'s scale applied', () => {
    expect(terrainSurfaceHeight(0, 0, basin)).toBeCloseTo(-2, 6);
    expect(terrainSurfaceHeight(5, 0, basin)).toBeCloseTo(-1, 6);
    expect(terrainSurfaceHeight(10, 10, basin)).toBeCloseTo(0, 6);

    // Rising towards +Z: rows 0, 1 and 2 at heights 0, 1 and 2.
    const ramp = terrain('ramp', [0, 1, 0], [0, 0, 0, 1, 1, 1, 2, 2, 2], { scale: [2, 3, 1] });
    expect(terrainSurfaceHeight(0, -10, ramp)).toBeCloseTo(1, 6);
    expect(terrainSurfaceHeight(0, 5, ramp)).toBeCloseTo(1 + 1.5 * 3, 6);
    // Twice as wide along X.
    expect(terrainSurfaceHeight(15, 0, ramp)).toBeCloseTo(1 + 3, 6);
    expect(terrainSurfaceHeight(25, 0, ramp)).toBeNull();
  });
});
