import * as THREE from 'three';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LevelComponent, LevelObject } from '../../types';
import { createComponent } from '../../runtime/components/registry';
import { capsuleHalfHeight, colliderMass, createTriggerOverlapTracker, planPhysicsBody } from '../../runtime/components/physicsComponents';
import type { TriggerOverlapTracker } from '../../runtime/components/physicsComponents';
import { createPhysicsQueries, objectIdFromRigidBody, physicsUserData, PLAYER_PHYSICS_ID } from '../../runtime/physicsQueries';
import { FLAT_GROUND_SHAPE, terrainHeightfieldShape } from '../../runtime/terrainPhysics';
import type { TriggerEvent } from '../../runtime/triggers';
import type { CharacterRig } from '../../components/Sandbox/hooks/usePlayerPhysics';
import {
  CHARACTER,
  createCharacterRig,
  resolveLocomotionSpeeds,
  stepCharacterPhysics,
} from '../../components/Sandbox/hooks/usePlayerPhysics';
import { loadRuntimeRapier } from './rapierRuntime';
import type { RuntimeRapier } from './rapierRuntime';

/*
 * Gameplay physics against the real Rapier engine (the build @react-three/rapier runs on), stepped at
 * 60 Hz without a canvas. Scenery is built the way the runtime builds it: TerrainCollider and
 * LevelGroundColliders for the ground (with a smaller slab, see 'the no-terrain ground'),
 * SimulatedBody for objects with physics components, createCharacterRig for the player.
 */

type World = InstanceType<RuntimeRapier['World']>;
type EventQueue = InstanceType<RuntimeRapier['EventQueue']>;
type Vec3 = [number, number, number];
type Direction = { x: number; z: number };

const FRAME = 1 / 60;
/** PhysicsWorld's gravity (runtime/physics.ts). */
const GRAVITY = { x: 0, y: -9.81, z: 0 };
const CHARACTER_HEIGHT = 1.8;
const WALK = resolveLocomotionSpeeds(undefined).walk;
const STILL: Direction = { x: 0, z: 0 };
const EAST: Direction = { x: 1, z: 0 };
/** How far the feet may sit from the ground they stand on (the controller keeps a small skin gap). */
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
  const world = new RAPIER.World(GRAVITY);
  world.timestep = FRAME;
  toFree.push(world);
  return world;
};

const createEventQueue = (): EventQueue => {
  const queue = new RAPIER.EventQueue(true);
  toFree.push(queue);
  return queue;
};

const quaternionOf = ([x, y, z]: Vec3) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));

// --- LEVEL OBJECTS ---

const levelObject = (id: string, type: LevelObject['type'], position: Vec3, extra: Partial<LevelObject> = {}): LevelObject => ({
  id,
  levelId: 'level-1',
  modelId: type === 'prop' ? `${id}-model` : '',
  name: id,
  type,
  position,
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  ...extra,
});

const physicsComponent = (type: 'collider' | 'rigidBody', props: Record<string, unknown> = {}): LevelComponent => {
  const component = createComponent(type);
  return { ...component, props: { ...component.props, ...props } };
};

interface TerrainGrid {
  width: number;
  depth: number;
  resolution: number;
  /** Height of the grid sample; row 0 is the far (-Z) edge and column 0 the -X edge, as rendered. */
  height: (column: number, row: number) => number;
}

const terrainObject = (id: string, position: Vec3, { width, depth, resolution, height }: TerrainGrid): LevelObject => {
  const samples = resolution + 1;
  const heights = Array.from({ length: samples * samples }, (_, index) => height(index % samples, Math.floor(index / samples)));
  return levelObject(id, 'terrain', position, { terrainData: { resolution, width, depth, heights } });
};

// --- RUNTIME SCENERY ---

/** TerrainCollider: an unscaled fixed body at the terrain, carrying its id, holding the heightfield. */
const addTerrain = (world: World, terrain: LevelObject) => {
  const shape = terrainHeightfieldShape(terrain);
  if (!shape) throw new Error(`${terrain.id} has no heights`);
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(...terrain.position).setRotation(quaternionOf(terrain.rotation))
  );
  body.userData = physicsUserData(terrain.id);
  world.createCollider(RAPIER.ColliderDesc.heightfield(shape.rows, shape.columns, shape.heights, { ...shape.scale }), body);
};

/** Half extent of a 4 km box, the shape LevelGroundColliders used before it switched to a flat heightfield. */
const LARGE_SLAB_HALF_EXTENT = 2000;
/** The ground these tests stand on: a slab small enough for exact character sweeps (see 'the no-terrain ground'). */
const TEST_GROUND_HALF_EXTENT = 20;

/** LevelGroundColliders' slab for a level without terrain, 1 m thick with its top at y = 0. */
const addGroundSlab = (world: World, halfExtent = TEST_GROUND_HALF_EXTENT) => {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.cuboid(halfExtent, 0.5, halfExtent).setTranslation(0, -0.5, 0), body);
};

/** SimulatedBody's sensor pairs: the defaults plus kinematic bodies (the player, movers) against fixed ones. */
const runtimeSensorCollisionTypes = () =>
  RAPIER.ActiveCollisionTypes.DEFAULT | RAPIER.ActiveCollisionTypes.KINEMATIC_FIXED | RAPIER.ActiveCollisionTypes.KINEMATIC_KINEMATIC;

/**
 * The body SimulatedBody mounts for the object: planPhysicsBody's body at the object's transform,
 * carrying its id, with one collider per collider component (triggers as sensors that report events,
 * as @react-three/rapier sets up a collider with intersection handlers). Box, sphere and capsule
 * shapes on unscaled objects only; the binding would fold an object's scale into its shapes.
 */
const addObjectBody = (world: World, object: LevelObject, sensorCollisionTypes = runtimeSensorCollisionTypes()) => {
  const plan = planPhysicsBody(object);
  if (!plan || plan.autoHull) throw new Error(`${object.id} needs explicit collider components`);
  if (object.scale.some(axis => axis !== 1)) throw new Error(`${object.id} must be unscaled`);
  const { type, gravityScale, lockRotation } = plan.body;
  const bodyDesc = type === 'dynamic'
    ? RAPIER.RigidBodyDesc.dynamic()
    : type === 'fixed' ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.kinematicPositionBased();
  bodyDesc.setTranslation(...object.position).setRotation(quaternionOf(object.rotation)).setGravityScale(gravityScale);
  if (lockRotation) bodyDesc.lockRotations();
  const body = world.createRigidBody(bodyDesc);
  body.userData = physicsUserData(object.id);
  const colliders = plan.colliders.map(({ settings }) => {
    const [sx, sy, sz] = settings.size;
    const desc = settings.shape === 'box' ? RAPIER.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2)
      : settings.shape === 'sphere' ? RAPIER.ColliderDesc.ball(settings.radius)
        : settings.shape === 'capsule' ? RAPIER.ColliderDesc.capsule(capsuleHalfHeight(settings), settings.radius)
          : null;
    if (!desc) throw new Error('mesh colliders are built from a model');
    desc.setTranslation(...settings.offset);
    const mass = colliderMass(plan, settings);
    if (mass !== undefined) desc.setMass(mass);
    if (settings.isTrigger) {
      desc.setSensor(true).setActiveCollisionTypes(sensorCollisionTypes).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    }
    return world.createCollider(desc, body);
  });
  return { body, colliders };
};

/**
 * @react-three/rapier's intersection dispatch: a started pair must be intersecting, and each sensor
 * side reports the other side's body. The trackers turn that into the runtime's trigger events.
 */
const dispatchIntersections = (world: World, queue: EventQueue, sensors: ReadonlyMap<number, TriggerOverlapTracker>) => {
  queue.drainCollisionEvents((handle1, handle2, started) => {
    const first = world.getCollider(handle1);
    const second = world.getCollider(handle2);
    if (!first || !second || (started && !world.intersectionPair(first, second))) return;
    for (const [self, other] of [[first, second], [second, first]] as const) {
      const tracker = sensors.get(self.handle);
      const otherId = objectIdFromRigidBody(other.parent());
      if (!tracker || !otherId) continue;
      if (started) tracker.enter(otherId);
      else tracker.exit(otherId);
    }
  });
};

// --- PLAYER ---

interface Player {
  rig: CharacterRig;
  /** The character's feet. */
  feet: THREE.Vector3;
  radius: number;
  /** One 60 Hz frame: the controller moves the character, then the world steps. */
  frame(direction?: Direction, jumpPressed?: boolean, events?: EventQueue): void;
  run(frames: number, direction?: Direction, afterFrame?: (frame: number) => void): void;
}

/** A character model standing at `feet`, CHARACTER_HEIGHT tall, with the runtime's capsule rig. */
const spawnPlayer = (world: World, feet: Vec3, obstacles: readonly LevelObject[] = [], terrain: LevelObject | null = null): Player => {
  const model = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, CHARACTER_HEIGHT, 0.3));
  mesh.position.y = CHARACTER_HEIGHT / 2;
  model.add(mesh);
  model.position.set(...feet);
  const context = { world, rapier: RAPIER };
  const rig = createCharacterRig(context, model);
  const frame = (direction = STILL, jumpPressed = false, events?: EventQueue) => {
    stepCharacterPhysics(context, rig, { jumpPressed }, direction, WALK, FRAME, obstacles, terrain);
    world.step(events);
  };
  return {
    rig,
    feet: model.position,
    radius: rig.height * CHARACTER.RADIUS_RATIO,
    frame,
    run(frames, direction = STILL, afterFrame) {
      for (let index = 0; index < frames; index++) {
        frame(direction);
        afterFrame?.(index);
      }
    },
  };
};

// --- TESTS ---

describe('player character on a terrain heightfield', () => {
  // A 60 x 20 terrain rising 0.5 per 5 m column towards +X (about 5.7 degrees), its base at y = 3.
  const slope = terrainObject('terrain-1', [0, 3, 0], { width: 60, depth: 20, resolution: 12, height: column => column * 0.5 });
  const surfaceY = (x: number) => 3 + (x + 30) * 0.1;

  const slopeWorld = () => {
    const world = createWorld();
    addTerrain(world, slope);
    world.step();
    return world;
  };

  it('lands on the terrain from above and stays on it', () => {
    // No legacy terrain: only the heightfield can hold the player up (the fallback floor would be y = 0).
    const player = spawnPlayer(slopeWorld(), [-10, surfaceY(-10) + 4, 0]);
    expect(player.rig.height).toBeCloseTo(CHARACTER_HEIGHT, 5);

    let landedAt = -1;
    player.run(90, STILL, frame => {
      if (landedAt < 0 && player.rig.grounded) landedAt = frame;
    });
    // A 4 m fall takes about 0.9 s.
    expect(landedAt).toBeGreaterThan(45);
    expect(landedAt).toBeLessThan(65);
    expect(Math.abs(player.feet.y - surfaceY(player.feet.x))).toBeLessThan(FEET_TOLERANCE);

    const restingX = player.feet.x;
    let worstGap = 0;
    let airborneFrames = 0;
    player.run(120, STILL, () => {
      worstGap = Math.max(worstGap, Math.abs(player.feet.y - surfaceY(player.feet.x)));
      if (!player.rig.grounded) airborneFrames++;
    });
    expect(worstGap).toBeLessThan(FEET_TOLERANCE);
    expect(airborneFrames).toBe(0);
    // The slope is far below the slide angle, so standing still does not creep downhill.
    expect(Math.abs(player.feet.x - restingX)).toBeLessThan(0.01);
  });

  it('walks up a gentle slope, keeping its feet on the surface', () => {
    const player = spawnPlayer(slopeWorld(), [-10, surfaceY(-10) + 0.05, 0]);
    player.run(30);
    expect(player.rig.grounded).toBe(true);

    const start = player.feet.clone();
    let worstGap = 0;
    let groundedFrames = 0;
    player.run(120, EAST, () => {
      worstGap = Math.max(worstGap, Math.abs(player.feet.y - surfaceY(player.feet.x)));
      if (player.rig.grounded) groundedFrames++;
    });

    // Two seconds at walking speed: nearly the full distance despite the climb.
    const travelled = player.feet.x - start.x;
    expect(travelled).toBeGreaterThan(WALK * 2 * 0.9);
    expect(travelled).toBeLessThan(WALK * 2 + 0.01);
    expect(Math.abs(player.feet.z - start.z)).toBeLessThan(0.01);
    expect(player.feet.y - start.y).toBeCloseTo(travelled * 0.1, 1);
    expect(worstGap).toBeLessThan(FEET_TOLERANCE);
    expect(groundedFrames).toBeGreaterThanOrEqual(114);
  });

  it('walks down the slope without leaving the ground', () => {
    const player = spawnPlayer(slopeWorld(), [10, surfaceY(10) + 0.05, 0]);
    player.run(30);

    let worstGap = 0;
    let groundedFrames = 0;
    player.run(120, { x: -1, z: 0 }, () => {
      worstGap = Math.max(worstGap, Math.abs(player.feet.y - surfaceY(player.feet.x)));
      if (player.rig.grounded) groundedFrames++;
    });
    // Snapped to the ground: walking downhill faster than gravity alone would pull the character down.
    expect(player.feet.x).toBeLessThan(10 - WALK * 2 * 0.9);
    expect(worstGap).toBeLessThan(FEET_TOLERANCE);
    expect(groundedFrames).toBe(120);
  });
});

describe('player character against colliders', () => {
  const flatWorld = (...objects: LevelObject[]) => {
    const world = createWorld();
    addGroundSlab(world);
    for (const object of objects) addObjectBody(world, object);
    world.step();
    return world;
  };

  const box = (id: string, position: Vec3, size: Vec3) =>
    levelObject(id, 'prop', position, { components: [physicsComponent('collider', { shape: 'box', size })] });

  it('is stopped by a fixed box collider', () => {
    // 1 m thick, 2 m tall: its near face is at x = 2.5.
    const wall = box('wall', [3, 1, 0], [1, 2, 6]);
    const player = spawnPlayer(flatWorld(wall), [0, 0, 0], [wall]);
    player.run(90, EAST);

    expect(player.feet.x).toBeLessThan(2.5 - player.radius + 0.01);
    // Stopped by the collider itself: a footprint push-out (props without colliders) would stop it at x = 2.
    expect(player.feet.x).toBeGreaterThan(2.5 - player.radius - 0.05);
    expect(Math.abs(player.feet.z)).toBeLessThan(0.01);
    expect(Math.abs(player.feet.y)).toBeLessThan(FEET_TOLERANCE);
    expect(player.rig.grounded).toBe(true);
  });

  it('climbs a step lower than the autostep height, but not a taller ledge', () => {
    const stepHeight = CHARACTER_HEIGHT * CHARACTER.STEP_RATIO;
    // Both start at x = 2 and run 6 m.
    const kerb = box('kerb', [5, 0.075, 0], [6, 0.15, 6]);
    const ledge = box('ledge', [5, 0.2, 0], [6, 0.4, 6]);
    expect(0.15).toBeLessThan(stepHeight);
    expect(0.4).toBeGreaterThan(stepHeight);

    const climber = spawnPlayer(flatWorld(kerb), [0, 0, 0], [kerb]);
    expect(climber.rig.controller.autostepMaxHeight()).toBeCloseTo(stepHeight, 5);
    climber.run(75, EAST);
    expect(climber.feet.x).toBeGreaterThan(4.5);
    expect(Math.abs(climber.feet.y - 0.15)).toBeLessThan(FEET_TOLERANCE);
    expect(climber.rig.grounded).toBe(true);

    const blocked = spawnPlayer(flatWorld(ledge), [0, 0, 0], [ledge]);
    blocked.run(75, EAST);
    expect(blocked.feet.x).toBeLessThan(2 - blocked.radius + 0.01);
    expect(Math.abs(blocked.feet.y)).toBeLessThan(FEET_TOLERANCE);
  });

  it('jumps, rises to the jump apex and lands again', () => {
    const player = spawnPlayer(flatWorld(), [0, 0, 0]);
    player.run(5);
    expect(player.rig.grounded).toBe(true);

    player.frame(STILL, true);
    expect(player.rig.verticalSpeed).toBeGreaterThan(0);
    let apex = player.feet.y;
    let airborneFrames = 0;
    let landedOnFrame = -1;
    for (let frame = 1; frame <= 90; frame++) {
      player.frame();
      apex = Math.max(apex, player.feet.y);
      if (!player.rig.grounded) airborneFrames++;
      else if (airborneFrames > 0 && landedOnFrame < 0) landedOnFrame = frame;
    }

    const expectedApex = player.rig.height * CHARACTER.JUMP_RATIO;
    expect(apex).toBeGreaterThan(expectedApex * 0.9);
    expect(apex).toBeLessThan(expectedApex + 0.01);
    // Flight time of a jump to that apex: 2 * sqrt(2h / g), about 0.66 s.
    const flightFrames = 2 * Math.sqrt((2 * expectedApex) / -GRAVITY.y) / FRAME;
    expect(landedOnFrame).toBeGreaterThan(flightFrames - 6);
    expect(landedOnFrame).toBeLessThan(flightFrames + 6);
    expect(player.rig.grounded).toBe(true);
    expect(Math.abs(player.feet.y)).toBeLessThan(FEET_TOLERANCE);

    // Back on the ground it jumps again; pressing jump in the air does not.
    player.frame(STILL, true);
    player.run(5);
    const rising = player.rig.verticalSpeed;
    expect(rising).toBeGreaterThan(0);
    expect(player.rig.grounded).toBe(false);
    player.frame(STILL, true);
    expect(player.rig.verticalSpeed).toBeLessThan(rising);
  });

  it('is held off a prop without physics components by its footprint', () => {
    // Levels authored before colliders: the prop has a model but no collider, so it is not in the world.
    const rock = levelObject('rock', 'prop', [3, 0, 0], { scale: [2, 1, 2] });
    expect(planPhysicsBody(rock)).toBeNull();
    const player = spawnPlayer(flatWorld(), [0, 0, 0], [rock]);
    // Footprint radius max(2, 2) / 2 plus the player's 0.5.
    const footprint = 1 + 0.5;
    let nearest = Infinity;
    player.run(90, EAST, () => {
      nearest = Math.min(nearest, Math.hypot(player.feet.x - 3, player.feet.z));
    });

    // Walking straight into the circle presses against it (sliding round it a little), never into it.
    expect(nearest).toBeGreaterThan(footprint - 1e-4);
    expect(nearest).toBeLessThan(footprint + 0.01);
    expect(player.feet.x).toBeLessThan(3 - footprint * 0.95);
    expect(Math.abs(player.feet.y)).toBeLessThan(FEET_TOLERANCE);

    // Without a model (an empty marker) the same prop does not block.
    const marker = { ...rock, modelId: '' };
    const walker = spawnPlayer(flatWorld(), [0, 0, 0], [marker]);
    walker.run(90, EAST);
    expect(walker.feet.x).toBeGreaterThan(5);
  });
});

describe('bodies and queries on a terrain heightfield', () => {
  // A flat 40 x 40 terrain whose surface is at y = 3.25.
  const ground = terrainObject('ground', [0, 2, 0], { width: 40, depth: 40, resolution: 8, height: () => 1.25 });
  const SURFACE = 3.25;
  const crate = levelObject('crate', 'prop', [-5, 8, 2], {
    components: [
      physicsComponent('rigidBody', { type: 'dynamic', mass: 2 }),
      physicsComponent('collider', { shape: 'box', size: [1, 1, 1] }),
    ],
  });

  const terrainWorld = () => {
    const world = createWorld();
    addTerrain(world, ground);
    world.step();
    return world;
  };

  it('drops a dynamic body onto the terrain, where it comes to rest and takes impulses', () => {
    const world = terrainWorld();
    const { body } = addObjectBody(world, crate);
    expect(body.mass()).toBeCloseTo(2, 5);
    for (let frame = 0; frame < 180; frame++) world.step();

    const rest = body.translation();
    expect(rest.y).toBeCloseTo(SURFACE + 0.5, 1);
    expect(Math.abs(rest.y - (SURFACE + 0.5))).toBeLessThan(0.02);
    expect(Math.hypot(rest.x + 5, rest.z - 2)).toBeLessThan(0.01);
    const settled = body.linvel();
    expect(Math.hypot(settled.x, settled.y, settled.z)).toBeLessThan(0.05);

    const queries = createPhysicsQueries(world, RAPIER);
    expect(queries.applyImpulse('crate', { x: 6, y: 0, z: 0 })).toBe(true);
    // 6 N s on 2 kg.
    expect(body.linvel().x).toBeCloseTo(3, 3);
    for (let frame = 0; frame < 30; frame++) world.step();
    expect(body.translation().x).toBeGreaterThan(rest.x + 0.5);
    expect(body.translation().y).toBeGreaterThan(SURFACE + 0.4);

    expect(queries.applyImpulse('ground', { x: 0, y: 10, z: 0 })).toBe(false);
    expect(queries.applyImpulse('missing', { x: 0, y: 10, z: 0 })).toBe(false);
  });

  it('raycasts hit the terrain, bodies on it and the player, reporting their object ids', () => {
    const world = terrainWorld();
    addObjectBody(world, crate);
    for (let frame = 0; frame < 180; frame++) world.step();
    const player = spawnPlayer(world, [6, SURFACE, -4], [ground, crate], ground);
    player.run(10);
    const queries = createPhysicsQueries(world, RAPIER);
    const down = new THREE.Vector3(0, -1, 0);

    const terrainHit = queries.raycast(new THREE.Vector3(10, 20, 10), down, 100);
    expect(terrainHit?.objectId).toBe('ground');
    expect(terrainHit!.point.y).toBeCloseTo(SURFACE, 3);
    expect(terrainHit!.distance).toBeCloseTo(20 - SURFACE, 3);
    expect(terrainHit!.normal.y).toBeCloseTo(1, 3);
    expect(queries.raycast(new THREE.Vector3(10, 20, 10), down, 10)).toBeNull();

    const crateHit = queries.raycast(new THREE.Vector3(-5, 20, 2), down, 100);
    expect(crateHit?.objectId).toBe('crate');
    expect(crateHit!.point.y).toBeCloseTo(SURFACE + 1, 1);
    expect(queries.raycast(new THREE.Vector3(-5, 20, 2), down, 100, { excludeObjectId: 'crate' })?.objectId).toBe('ground');

    // A horizontal ray at chest height finds the player's capsule.
    const chest = new THREE.Vector3(0, SURFACE + 1, -4);
    const playerHit = queries.raycast(chest, new THREE.Vector3(1, 0, 0), 50);
    expect(playerHit?.objectId).toBe(PLAYER_PHYSICS_ID);
    expect(playerHit!.distance).toBeCloseTo(6 - player.radius, 1);
    expect(queries.raycast(chest, new THREE.Vector3(1, 0, 0), 50, { excludeObjectId: PLAYER_PHYSICS_ID })).toBeNull();
  });
});

describe('trigger colliders', () => {
  const gateObject = () => levelObject('gate', 'prop', [4, 1, 0], {
    modelId: '',
    components: [physicsComponent('collider', { shape: 'box', size: [2, 2, 2], isTrigger: true })],
  });

  const sensorTypes = {
    runtime: () => runtimeSensorCollisionTypes(),
    default: () => RAPIER.ActiveCollisionTypes.DEFAULT,
  };

  // The player's capsule enables kinematic-fixed pairs itself, so it is reported even by a sensor without them.
  it.each(['runtime', 'default'] as const)('report the player walking through (%s sensor flags)', flags => {
    const gate = gateObject();
    const world = createWorld();
    addGroundSlab(world);
    const { colliders: [sensor] } = addObjectBody(world, gate, sensorTypes[flags]());
    world.step();

    const events: TriggerEvent[] = [];
    const sensors = new Map([[sensor.handle, createTriggerOverlapTracker(gate.id, event => events.push(event))]]);
    const queue = createEventQueue();
    const player = spawnPlayer(world, [0, 0, 0], [gate]);
    const positions: number[] = [];
    let overlappedInside = false;
    for (let frame = 0; frame < 150; frame++) {
      const before = events.length;
      player.frame(EAST, false, queue);
      dispatchIntersections(world, queue, sensors);
      if (events.length > before) positions.push(player.feet.x);
      if (Math.abs(player.feet.x - 4) < 0.1) overlappedInside = world.intersectionPair(sensor, player.rig.collider);
    }

    expect(events).toEqual([
      { kind: 'enter', triggerObjectId: 'gate', otherObjectId: PLAYER_PHYSICS_ID },
      { kind: 'exit', triggerObjectId: 'gate', otherObjectId: PLAYER_PHYSICS_ID },
    ]);
    expect(overlappedInside).toBe(true);
    // Entered as the capsule reached the near face (x = 3) and left once it cleared the far one (x = 5).
    expect(Math.abs(positions[0] - (3 - player.radius))).toBeLessThan(0.15);
    expect(Math.abs(positions[1] - (5 + player.radius))).toBeLessThan(0.15);
    // A trigger never blocks.
    expect(player.feet.x).toBeGreaterThan(9.5);
  });

  it('report kinematic movers only with the runtime sensor flags', () => {
    const world = createWorld();
    const queue = createEventQueue();
    const events: TriggerEvent[] = [];
    const sensors = new Map<number, TriggerOverlapTracker>();
    const movers = (['runtime', 'default'] as const).map((flags, lane) => {
      const gate = { ...gateObject(), id: `gate-${flags}`, position: [4, 1, lane * 10] as Vec3 };
      const { colliders: [sensor] } = addObjectBody(world, gate, sensorTypes[flags]());
      sensors.set(sensor.handle, createTriggerOverlapTracker(gate.id, event => events.push(event)));
      const mover = levelObject(`mover-${flags}`, 'prop', [0, 1, lane * 10], {
        components: [
          physicsComponent('rigidBody', { type: 'kinematicPosition' }),
          physicsComponent('collider', { shape: 'box', size: [1, 1, 1] }),
        ],
      });
      return { mover, body: addObjectBody(world, mover).body };
    });
    world.step();

    // SimulatedBody moves kinematic bodies to their object before each step.
    for (let frame = 1; frame <= 120; frame++) {
      for (const { mover, body } of movers) {
        body.setNextKinematicTranslation({ x: mover.position[0] + frame * 0.1, y: mover.position[1], z: mover.position[2] });
      }
      world.step(queue);
      dispatchIntersections(world, queue, sensors);
    }

    expect(events).toEqual([
      { kind: 'enter', triggerObjectId: 'gate-runtime', otherObjectId: 'mover-runtime' },
      { kind: 'exit', triggerObjectId: 'gate-runtime', otherObjectId: 'mover-runtime' },
    ]);
  });
});

describe('the no-terrain ground', () => {
  /** Lowest feet height while grounded, and where the feet end, over a walk with a jump every 80 frames. */
  const jumpAround = (player: Player) => {
    let lowest = Infinity;
    for (let frame = 0; frame < 400; frame++) {
      player.frame(frame > 200 ? EAST : STILL, frame > 60 && frame % 80 === 0);
      if (frame > 40 && player.rig.grounded) lowest = Math.min(lowest, player.feet.y);
    }
    return { lowest, final: player.feet.y };
  };

  // Why the runtime does not use a box: the character controller's shape casts lose precision against
  // a 4 km cuboid, so the player sinks into it and, after a few jumps, falls through the world.
  it.fails('a 4 km box would let the player sink and fall through', () => {
    const world = createWorld();
    addGroundSlab(world, LARGE_SLAB_HALF_EXTENT);
    world.step();
    const { lowest, final } = jumpAround(spawnPlayer(world, [0, 0.5, 0]));
    expect(lowest).toBeGreaterThan(-FEET_TOLERANCE);
    expect(final).toBeGreaterThan(-FEET_TOLERANCE);
  });

  it("holds the player on the runtime's flat ground through repeated jumps", () => {
    const world = createWorld();
    const ground = FLAT_GROUND_SHAPE;
    world.createCollider(
      RAPIER.ColliderDesc.heightfield(ground.rows, ground.columns, ground.heights, { ...ground.scale }),
      world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    );
    world.step();
    const { lowest, final } = jumpAround(spawnPlayer(world, [0, 0.5, 0]));
    expect(lowest).toBeGreaterThan(-FEET_TOLERANCE);
    expect(Math.abs(final)).toBeLessThan(FEET_TOLERANCE);
  });
});
