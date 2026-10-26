import * as THREE from 'three';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createComponent } from '../../runtime/components/registry';
import {
  collectHostGeometry,
  colliderMass,
  findCompoundOwner,
  foldColliders,
  followHostState,
  planPhysicsBody,
  resolveColliderSettings,
  roundColliderArgs,
  roundShapeSize,
  teleportBodyToHost,
} from '../../runtime/components/physicsComponents';
import type { CompoundBodyRegistry } from '../../runtime/components/physicsComponents';
import { createPhysicsQueries, physicsUserData, usePhysicsQueries } from '../../runtime/physics';
import type { LevelComponent, LevelObject } from '../../types';
import { loadRuntimeRapier } from './rapierRuntime';
import type { RuntimeRapier } from './rapierRuntime';

type World = InstanceType<RuntimeRapier['World']>;

let RAPIER: RuntimeRapier;
const toFree: { free(): void }[] = [];

beforeAll(async () => {
  RAPIER = await loadRuntimeRapier();
});

afterEach(() => {
  for (const resource of toFree.splice(0)) resource.free();
});

const FRAME = 1 / 60;

const createWorld = (): World => {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FRAME;
  toFree.push(world);
  return world;
};

/** A ground slab with its top at y = 0. */
const addGround = (world: World) => {
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.5, 50).setTranslation(0, -0.5, 0), ground);
};

const physicsComponent = (type: 'collider' | 'rigidBody', props: Record<string, unknown> = {}): LevelComponent => {
  const component = createComponent(type);
  return { ...component, props: { ...component.props, ...props } };
};

const objectWith = (id: string, components: LevelComponent[]): LevelObject => ({ id, components } as unknown as LevelObject);

const levelGroup = (id: string): THREE.Group => {
  const group = new THREE.Group();
  group.userData = { levelObjectId: id };
  return group;
};

const registry = (rigidBody: boolean, type: CompoundBodyRegistry['type']): CompoundBodyRegistry => ({ rigidBody, type, set: vi.fn() });

/** A body anchor as ObjectBody draws it under its object's transform group. */
const addBodyAnchor = (host: THREE.Object3D, bodyRegistry: CompoundBodyRegistry) => {
  const anchor = new THREE.Group();
  anchor.userData = { auvraPhysicsAnchor: true, auvraCompoundBody: bodyRegistry };
  host.add(anchor);
};

describe('scripted transforms of dynamic bodies', () => {
  const restingCrate = (world: World) => {
    addGround(world);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.5, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5), body);
    for (let frame = 0; frame < 600 && !body.isSleeping(); frame++) world.step();
    return body;
  };

  it('moves a sleeping body to its host, wakes it and keeps it there', () => {
    const world = createWorld();
    const body = restingCrate(world);
    expect(body.isSleeping()).toBe(true);

    // Set Actor Transform on a crate under a parent object: the host moves, the body has to follow.
    const parent = new THREE.Group();
    parent.position.set(1, 0, 0);
    const host = new THREE.Group();
    host.position.set(4, 3, -2);
    host.rotation.set(0, 0.5, 0);
    parent.add(host);
    expect(teleportBodyToHost(body, host)).toBe(true);

    expect(body.isSleeping()).toBe(false);
    const t = body.translation();
    expect([t.x, t.y, t.z]).toEqual([5, 3, -2]);
    const r = body.rotation();
    const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.5, 0));
    expect(Math.abs(new THREE.Quaternion(r.x, r.y, r.z, r.w).dot(expected))).toBeCloseTo(1, 5);
    // Its collider went with it: a ray straight down at the new spot hits the crate's top.
    world.step();
    const hit = world.castRay(new RAPIER.Ray({ x: 5, y: 10, z: -2 }, { x: 0, y: -1, z: 0 }), 20, true);
    expect(hit?.collider.parent()?.handle).toBe(body.handle);
  });

  it('stops a moving body where it was put, and leaves it alone when the write echoes its own pose', () => {
    const world = createWorld();
    const body = restingCrate(world);
    body.setLinvel({ x: 4, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 2, z: 0 }, true);
    const host = new THREE.Group();
    host.position.set(-3, 0.5, 0);
    expect(teleportBodyToHost(body, host)).toBe(true);
    expect(body.linvel()).toEqual({ x: 0, y: 0, z: 0 });
    expect(body.angvel()).toEqual({ x: 0, y: 0, z: 0 });
    for (let frame = 0; frame < 30; frame++) world.step();
    expect(body.translation().x).toBeCloseTo(-3, 2);

    body.setLinvel({ x: 1, y: 0, z: 0 }, true);
    const now = body.translation();
    const rotation = body.rotation();
    host.position.set(now.x, now.y, now.z);
    host.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    expect(teleportBodyToHost(body, host)).toBe(false);
    expect(body.linvel().x).toBeCloseTo(1, 6);
  });

  it('reads the live pose of an object\'s dynamic body', () => {
    const world = createWorld();
    const crate = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(1, 2, 3)
      .setRotation(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0.2, 0.3))));
    crate.userData = physicsUserData('crate');
    const wall = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(5, 0, 0));
    wall.userData = physicsUserData('wall');
    const queries = createPhysicsQueries(world, RAPIER);

    const pose = queries.getBodyPose('crate')!;
    expect(pose.position).toEqual([1, 2, 3]);
    pose.rotation.forEach((angle, axis) => expect(angle).toBeCloseTo([0.1, 0.2, 0.3][axis], 5));
    expect(queries.getBodyPose('wall')).toBeNull();
    expect(queries.getBodyPose('missing')).toBeNull();

    crate.setTranslation({ x: -4, y: 6, z: 0.5 }, true);
    expect(queries.getBodyPose('crate')!.position).toEqual([-4, 6, 0.5]);
    // Outside a physics world there is no body to read.
    expect(renderHook(() => usePhysicsQueries()).result.current.getBodyPose('crate')).toBeNull();
  });

  it('keeps a scale set during play when a dynamic body syncs its host', () => {
    const host = new THREE.Group();
    const state = { object: new THREE.Object3D(), scale: new THREE.Vector3(1, 1, 1) } as unknown as Parameters<typeof followHostState>[0];
    const followed = followHostState(state, host, true);
    host.scale.set(3, 1, 2);
    expect(followed.scale.toArray()).toEqual([3, 1, 2]);
  });
});

describe('collider-only children of a rigid body', () => {
  const wheelOf = (owner: THREE.Object3D) => {
    const wheel = levelGroup('wheel');
    wheel.position.set(1, -0.25, 0.5);
    wheel.rotation.set(0, Math.PI / 2, 0);
    wheel.scale.setScalar(0.5);
    owner.add(wheel);
    return wheel;
  };

  it('marks plans set by a Rigid Body component', () => {
    expect(planPhysicsBody(objectWith('cart', [physicsComponent('rigidBody')]))!.rigidBody).toBe(true);
    expect(planPhysicsBody(objectWith('wheel', [physicsComponent('collider')]))!.rigidBody).toBe(false);
  });

  it('join the nearest ancestor with a moving rigid body, skipping collider-only objects in between', () => {
    const scene = new THREE.Scene();
    const cart = levelGroup('cart');
    scene.add(cart);
    const cartBody = registry(true, 'dynamic');
    addBodyAnchor(cart, cartBody);
    const axle = levelGroup('axle');
    addBodyAnchor(axle, registry(false, 'fixed'));
    cart.add(axle);
    const wheel = wheelOf(axle);

    expect(findCompoundOwner(wheel, 'wheel')).toEqual({ host: cart, registry: cartBody });
    expect(findCompoundOwner(axle, 'axle')).toEqual({ host: cart, registry: cartBody });
    cartBody.type = 'kinematicPosition';
    expect(findCompoundOwner(wheel, 'wheel')?.host).toBe(cart);
    // Under a fixed rigid body, or no body at all, the child keeps its own.
    cartBody.type = 'fixed';
    expect(findCompoundOwner(wheel, 'wheel')).toBeNull();
    expect(findCompoundOwner(cart, 'cart')).toBeNull();
  });

  it('place their colliders in the owner\'s space', () => {
    const cart = levelGroup('cart');
    cart.position.set(0, 1, 0);
    cart.scale.setScalar(2);
    const wheel = wheelOf(cart);
    const sphere = physicsComponent('collider', { shape: 'sphere', radius: 0.4, offset: [0.2, 0, 0] });
    const [folded] = foldColliders(cart, wheel, 'wheel', planPhysicsBody(objectWith('wheel', [sphere]))!.colliders, null);
    expect(folded.key).toBe(`wheel/${sphere.id}`);
    expect(folded.objectId).toBe('wheel');
    // The offset is scaled and turned by the wheel's own transform: (0.2, 0, 0) * 0.5, turned 90 degrees about Y.
    folded.position.forEach((value, axis) => expect(value).toBeCloseTo([1, -0.25, 0.4][axis], 6));
    folded.rotation.forEach((value, axis) => expect(value).toBeCloseTo([0, Math.PI / 2, 0][axis], 6));
    folded.scale.forEach(value => expect(value).toBeCloseTo(0.5, 6));
  });

  it('hold their parent up and rest with it instead of pushing it around', () => {
    // A cart chassis on four wheel objects that only have Colliders, overlapping its underside.
    const cartObject = objectWith('cart', [physicsComponent('rigidBody', { mass: 4 }), physicsComponent('collider', { size: [2, 1, 1] })]);
    const plan = planPhysicsBody(cartObject)!;
    const cartHost = levelGroup('cart');
    cartHost.position.set(0, 1, 0);
    const folded = [[0.7, 0.3], [0.7, -0.3], [-0.7, 0.3], [-0.7, -0.3]].flatMap(([x, z], index) => {
      const wheelHost = levelGroup(`wheel-${index}`);
      wheelHost.position.set(x, -0.4, z);
      cartHost.add(wheelHost);
      const wheel = objectWith(`wheel-${index}`, [physicsComponent('collider', { shape: 'sphere', radius: 0.45 })]);
      return foldColliders(cartHost, wheelHost, wheel.id, planPhysicsBody(wheel)!.colliders, null);
    });
    const foldedShapes = folded.map(entry => entry.settings);

    // SimulatedBody's compound: the cart's own collider and the folded wheels on one body.
    const world = createWorld();
    addGround(world);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0));
    const [chassis] = plan.colliders;
    world.createCollider(RAPIER.ColliderDesc.cuboid(1, 0.5, 0.5).setMass(colliderMass(plan, chassis.settings, foldedShapes)!), body);
    for (const wheel of folded) {
      world.createCollider(RAPIER.ColliderDesc.ball(wheel.settings.radius).setTranslation(...wheel.position)
        .setMass(colliderMass(plan, wheel.settings, foldedShapes)!), body);
    }
    expect(body.mass()).toBeCloseTo(4, 5);

    for (let frame = 0; frame < 300; frame++) world.step();
    const at = body.translation();
    // The wheels' bottoms are on the ground: 0.4 below the cart's centre plus their radius.
    expect(at.y).toBeCloseTo(0.85, 1);
    expect(Math.hypot(at.x, at.z)).toBeLessThan(0.01);
    const v = body.linvel();
    expect(Math.hypot(v.x, v.y, v.z)).toBeLessThan(0.01);
  });

  it('share a dynamic body\'s mass with its own shapes, the automatic hull included', () => {
    const solid = resolveColliderSettings(physicsComponent('collider'));
    const trigger = resolveColliderSettings(physicsComponent('collider', { isTrigger: true }));
    const hullOnly = planPhysicsBody(objectWith('cart', [physicsComponent('rigidBody', { mass: 6 })]))!;
    expect(colliderMass(hullOnly, solid)).toBe(6);
    expect(colliderMass(hullOnly, solid, [solid, trigger])).toBe(3);
    expect(colliderMass(hullOnly, trigger, [solid, trigger])).toBe(0);
  });
});

describe('round collider shapes on scaled objects', () => {
  const capsule = resolveColliderSettings(physicsComponent('collider', { shape: 'capsule', radius: 0.5, height: 2 }));
  const sphere = resolveColliderSettings(physicsComponent('collider', { shape: 'sphere', radius: 0.5 }));
  /** What @react-three/rapier builds from the args: each positional arg times [scale.x, scale.y]. */
  const built = (args: number[], [sx, sy]: number[]) => args.map((arg, index) => arg * [sx, sy][index]);

  it('fit a capsule to the scaled preview: full height along Y, radius by the wider of X and Z', () => {
    // 1 m wide and 4 m tall, as the editor draws it on a [1, 2, 1] object.
    expect(roundShapeSize(capsule, [1, 2, 1])).toEqual({ radius: 0.5, halfHeight: 1.5 });
    expect(built(roundColliderArgs(capsule, [1, 2, 1]), [1, 2])).toEqual([1.5, 0.5]);
    // 2 m wide and 2 m tall on a [2, 1, 2] object: all rounded ends.
    expect(roundShapeSize(capsule, [2, 1, 2])).toEqual({ radius: 1, halfHeight: 0 });
    expect(built(roundColliderArgs(capsule, [2, 1, 2]), [2, 1])).toEqual([0, 1]);
    expect(roundShapeSize(capsule, [1, 1, 1])).toEqual({ radius: 0.5, halfHeight: 0.5 });
  });

  it('give a sphere the largest scale axis', () => {
    expect(roundShapeSize(sphere, [1, 3, 2])).toEqual({ radius: 1.5, halfHeight: 0 });
    expect(built(roundColliderArgs(sphere, [1, 3, 2]), [1, 3])).toEqual([1.5]);
  });
});

describe('automatic shapes', () => {
  it('are built from the object\'s own model, not from nested child objects', () => {
    const host = levelGroup('cart');
    const model = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    model.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    host.add(model);
    // A wheel prop with no physics of its own, as LevelRuntime nests it in the cart's group.
    const wheel = levelGroup('wheel');
    wheel.position.set(5, 0, 0);
    wheel.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    host.add(wheel);

    const geometry = collectHostGeometry(host, 'cart')!;
    expect(Array.from(geometry.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });
});
