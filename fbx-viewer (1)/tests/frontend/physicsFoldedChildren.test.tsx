import React from 'react';
import * as THREE from 'three';
import { act, render } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createComponent, getComponentDefinition } from '../../runtime/components/registry';
import { ComponentHostContext } from '../../runtime/components/builtins';
import {
  foldedPlacementMoved,
  placeFoldedColliders,
  planPhysicsBody,
  tagColliderObject,
} from '../../runtime/components/physicsComponents';
import type { CompoundBodyRegistry } from '../../runtime/components/physicsComponents';
import { objectIdFromRigidBody, objectIdFromUserData, physicsUserData } from '../../runtime/physicsQueries';
import type { LevelComponent, LevelObject } from '../../types';
import { loadRuntimeRapier } from './rapierRuntime';
import type { RuntimeRapier } from './rapierRuntime';

/*
 * Collider-only children folded into a moving parent's body: a Mover or Rotator on the child moves
 * its colliders in the body, and those colliders carry the child's id for raycast hits. Rendered
 * against a stand-in for @react-three/rapier (colliders record the props they get and hand a fake
 * collider to their ref when built), with the real engine for the userData round trip.
 */

type FakeCollider = { shape: string; userData?: unknown };

const rapier = vi.hoisted(() => ({
  builds: [] as { shape: string; userData?: unknown }[],
  /** The latest position and rotation props per built collider. */
  poses: new Map<object, { position?: number[]; rotation?: number[] }>(),
  bodies: [] as { wakeUp: ReturnType<typeof vi.fn> }[],
  beforeStep: new Set<{ current: () => void }>(),
  /** Every compound body registry an ObjectBody created (captured from its useState). */
  registries: new Set<object>(),
}));

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  const isRegistry = (value: unknown): boolean =>
    !!value && typeof value === 'object' && 'rigidBody' in value && 'set' in value && 'type' in value;
  const useState = ((initial: unknown) => {
    const result = actual.useState(initial);
    if (isRegistry(result[0])) rapier.registries.add(result[0] as object);
    return result;
  }) as typeof actual.useState;
  return { ...actual, default: { ...actual, useState }, useState };
});

vi.mock('@react-three/rapier', async () => {
  const R = await import('react');
  const collider = (shape: string) => R.forwardRef((props: { position?: number[]; rotation?: number[] }, ref) => {
    const [instance] = R.useState<FakeCollider>(() => ({ shape }));
    rapier.poses.set(instance, { position: props.position, rotation: props.rotation });
    R.useEffect(() => {
      rapier.builds.push(instance);
      if (typeof ref === 'function') ref(instance as never);
    }, []);
    return null;
  });
  return {
    RigidBody: R.forwardRef(({ children }: { children?: React.ReactNode }, ref) => {
      const [body] = R.useState(() => {
        const created = {
          wakeUp: vi.fn(),
          translation: () => ({ x: 0, y: 0, z: 0 }),
          rotation: () => ({ x: 0, y: 0, z: 0, w: 1 }),
          setTranslation: vi.fn(),
          setRotation: vi.fn(),
          setLinvel: vi.fn(),
          setAngvel: vi.fn(),
          setNextKinematicTranslation: vi.fn(),
          setNextKinematicRotation: vi.fn(),
        };
        rapier.bodies.push(created);
        return created;
      });
      R.useImperativeHandle(ref, () => body, [body]);
      return R.createElement(R.Fragment, null, children);
    }),
    CuboidCollider: collider('cuboid'),
    BallCollider: collider('ball'),
    CapsuleCollider: collider('capsule'),
    ConvexHullCollider: collider('convexHull'),
    TrimeshCollider: collider('trimesh'),
    useBeforePhysicsStep: (callback: () => void) => {
      const ref = R.useRef(callback);
      ref.current = callback;
      R.useEffect(() => {
        rapier.beforeStep.add(ref);
        return () => { rapier.beforeStep.delete(ref); };
      }, []);
    },
    useRapier: () => ({ rapier: { ActiveCollisionTypes: { DEFAULT: 1, KINEMATIC_FIXED: 2, KINEMATIC_KINEMATIC: 4 } } }),
  };
});

vi.mock('../../runtime/physics', async importOriginal => ({
  ...(await importOriginal<typeof import('../../runtime/physics')>()),
  usePhysicsAvailable: () => true,
}));

const step = () => act(() => { for (const callback of rapier.beforeStep) callback.current(); });

const physicsComponent = (type: 'collider' | 'rigidBody', props: Record<string, unknown> = {}): LevelComponent => {
  const component = createComponent(type);
  return { ...component, props: { ...component.props, ...props } };
};

const levelObject = (id: string, components: LevelComponent[], extra: Partial<LevelObject> = {}): LevelObject => ({
  id, levelId: 'level-1', modelId: '', name: id, type: 'prop',
  position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], components, ...extra,
} as LevelObject);

const levelGroup = (id: string): THREE.Group => {
  const group = new THREE.Group();
  group.userData = { levelObjectId: id };
  return group;
};

/** The object's body-owning component rendered in play mode, in its transform group `host`. */
const PlayObject: React.FC<{ object: LevelObject; host: THREE.Object3D }> = ({ object, host }) => {
  const hostRef = React.useMemo(() => ({ current: host }), [host]);
  const owner = object.components!.find(component => component.type === 'rigidBody') ?? object.components![0];
  const Render = getComponentDefinition(owner.type)!.Render!;
  return (
    <ComponentHostContext.Provider value={hostRef}>
      <Render object={object} component={owner} mode="runtime" />
    </ComponentHostContext.Provider>
  );
};

const close = (actual: number[] | undefined, expected: number[]) => {
  expect(actual).toHaveLength(expected.length);
  actual!.forEach((value, axis) => expect(value).toBeCloseTo(expected[axis], 6));
};

beforeEach(() => {
  rapier.builds.length = 0;
  rapier.poses.clear();
  rapier.bodies.length = 0;
  rapier.beforeStep.clear();
  rapier.registries.clear();
  // react-dom does not know R3F's <group>; its warnings are not what these tests look at.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('a collider-only child of a dynamic body', () => {
  const cart = levelObject('cart', [physicsComponent('rigidBody'), physicsComponent('collider', { size: [2, 1, 1] })]);
  const wheel = levelObject('wheel', [physicsComponent('collider', { shape: 'sphere', radius: 0.4 })], { position: [1, -0.25, 0] });

  /** The cart's body and the wheel folded into it, the wheel's transform group under the cart's. */
  const mountCart = () => {
    const cartHost = levelGroup('cart');
    render(<PlayObject object={cart} host={cartHost} />);
    const registry = [...rapier.registries].find(entry => (entry as CompoundBodyRegistry).rigidBody) as CompoundBodyRegistry;
    expect(registry).toBeDefined();
    // What the cart's ObjectBody draws under R3F: an anchor group in its transform group, holding its registry.
    const anchor = new THREE.Group();
    anchor.userData = { auvraPhysicsAnchor: true, auvraCompoundBody: registry };
    cartHost.add(anchor);
    const wheelHost = levelGroup('wheel');
    wheelHost.position.set(...wheel.position);
    cartHost.add(wheelHost);
    render(<PlayObject object={wheel} host={wheelHost} />);

    expect(rapier.bodies).toHaveLength(1);
    const ball = rapier.builds.find(entry => entry.shape === 'ball');
    expect(ball).toBeDefined();
    return { cartHost, wheelHost, body: rapier.bodies[0], ball: ball! };
  };

  it('tags its collider in the parent body with its own id, leaving the parent\'s colliders to the body', () => {
    const { ball } = mountCart();
    expect(objectIdFromUserData(ball.userData)).toBe('wheel');
    const chassis = rapier.builds.find(entry => entry.shape === 'cuboid')!;
    expect(chassis.userData).toBeUndefined();
  });

  it('moves its collider in the body when a Rotator or Mover moves the child, without rebuilding it', () => {
    const { cartHost, wheelHost, body, ball } = mountCart();
    close(rapier.poses.get(ball)!.position, [1, -0.25, 0]);
    const builds = rapier.builds.length;
    body.wakeUp.mockClear();

    // A Rotator turns the wheel's transform group each frame; the session object never changes.
    wheelHost.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.5);
    step();
    close(rapier.poses.get(ball)!.rotation, [0, 0.5, 0]);
    expect(body.wakeUp).toHaveBeenCalled();

    // A Mover slides it along X.
    wheelHost.position.x = 2;
    step();
    close(rapier.poses.get(ball)!.position, [2, -0.25, 0]);

    // Turning keeps the collider: only its pose changes.
    for (let frame = 1; frame <= 10; frame++) {
      wheelHost.quaternion.setFromAxisAngle(new THREE.Vector3(1, 1, 0).normalize(), frame * 0.37);
      step();
    }
    expect(rapier.builds).toHaveLength(builds);

    // The cart carrying the wheel along is not the wheel moving.
    body.wakeUp.mockClear();
    const pose = rapier.poses.get(ball);
    cartHost.position.set(5, 1, 0);
    cartHost.rotation.set(0, 1, 0);
    step();
    expect(body.wakeUp).not.toHaveBeenCalled();
    expect(rapier.poses.get(ball)).toBe(pose);
  });
});

describe('folded placements', () => {
  const sphere = physicsComponent('collider', { shape: 'sphere', radius: 0.4 });
  const colliders = planPhysicsBody(levelObject('wheel', [sphere]))!.colliders;

  it('notice the child moving under its owner, and only that', () => {
    const owner = levelGroup('cart');
    const between = new THREE.Group();
    owner.add(between);
    const child = levelGroup('wheel');
    child.position.set(1, 0, 0);
    between.add(child);

    const placed = placeFoldedColliders(owner, child, 'wheel', colliders, null);
    close(placed.colliders[0].position, [1, 0, 0]);
    expect(foldedPlacementMoved(placed, owner, child)).toBe(false);

    owner.position.set(3, 2, 1);
    owner.rotation.set(0.3, 0.2, 0.1);
    owner.scale.setScalar(2);
    expect(foldedPlacementMoved(placed, owner, child)).toBe(false);

    // An animated object between the owner and the child moves the child too.
    between.position.y = 0.5;
    expect(foldedPlacementMoved(placed, owner, child)).toBe(true);
    const moved = placeFoldedColliders(owner, child, 'wheel', colliders, null, placed);
    close(moved.colliders[0].position, [1, 0.5, 0]);
    expect(foldedPlacementMoved(moved, owner, child)).toBe(false);
  });

  it('keep a scale that only changed by rounding, so a turning child keeps its round colliders', () => {
    const owner = levelGroup('cart');
    const child = levelGroup('wheel');
    child.scale.set(1.5, 1.5, 1.5);
    owner.add(child);
    const placed = placeFoldedColliders(owner, child, 'wheel', colliders, null);

    child.quaternion.setFromAxisAngle(new THREE.Vector3(1, 2, 3).normalize(), 1.234);
    const turned = placeFoldedColliders(owner, child, 'wheel', colliders, null, placed);
    expect(turned.colliders[0].scale).toBe(placed.colliders[0].scale);

    child.scale.set(2, 1.5, 1.5);
    const grown = placeFoldedColliders(owner, child, 'wheel', colliders, null, turned);
    close(grown.colliders[0].scale, [2, 1.5, 1.5]);
  });
});

describe('folded collider tags in the engine', () => {
  let RAPIER: RuntimeRapier;
  beforeAll(async () => { RAPIER = await loadRuntimeRapier(); });

  it('come back on the collider a raycast hits, while the body keeps the owner\'s id', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    try {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0));
      body.userData = physicsUserData('cart');
      world.createCollider(RAPIER.ColliderDesc.cuboid(1, 0.5, 0.5), body);
      const wheel = world.createCollider(RAPIER.ColliderDesc.ball(0.4).setTranslation(3, 0, 0), body);
      tagColliderObject(wheel, 'wheel');
      world.step();

      const down = { x: 0, y: -1, z: 0 };
      const wheelHit = world.castRayAndGetNormal(new RAPIER.Ray({ x: 3, y: 10, z: 0 }, down), 100, true)!;
      expect(objectIdFromUserData((wheelHit.collider as { userData?: unknown }).userData)).toBe('wheel');
      expect(objectIdFromRigidBody(wheelHit.collider.parent())).toBe('cart');
      const chassisHit = world.castRayAndGetNormal(new RAPIER.Ray({ x: 0, y: 10, z: 0 }, down), 100, true)!;
      expect(objectIdFromUserData((chassisHit.collider as { userData?: unknown }).userData)).toBeNull();
    } finally {
      world.free();
    }
  });
});
