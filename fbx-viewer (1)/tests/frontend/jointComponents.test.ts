import React from 'react';
import * as THREE from 'three';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JOINT_COMPONENTS,
  connectJoint,
  createJointBreakMonitor,
  createRapierJoint,
  estimateJointLoads,
  findObjectBody,
  jointDataParams,
  jointIntact,
  releaseJoint,
  resolveJointSettings,
} from '../../runtime/components/jointComponents';
import type { JointBreakMonitor, JointLink, JointSettings } from '../../runtime/components/jointComponents';
import { physicsUserData } from '../../runtime/physics';
import type { LevelComponent, LevelObject } from '../../types';
import { loadRuntimeRapier } from './rapierRuntime';
import type { RuntimeRapier } from './rapierRuntime';

type World = InstanceType<RuntimeRapier['World']>;
type Body = ReturnType<World['createRigidBody']>;
type StepCallback = { current: (world: World) => void };

/*
 * The runtime part (RuntimeJoint) is rendered against a stand-in for @react-three/rapier's hooks that
 * hands out a real Rapier world and runs the step callbacks around world.step(), as <Physics> does.
 */
const runtime = vi.hoisted(() => ({
  context: null as { world: unknown; rapier: unknown } | null,
  scene: null as unknown,
  beforeStep: new Set<{ current: (world: never) => void }>(),
  afterStep: new Set<{ current: (world: never) => void }>(),
}));

vi.mock('@react-three/rapier', async importOriginal => {
  const actual = await importOriginal<typeof import('@react-three/rapier')>();
  const R = await import('react');
  const stepHook = (callbacks: Set<{ current: (world: never) => void }>) => (callback: (world: never) => void) => {
    const ref = R.useRef(callback);
    ref.current = callback;
    R.useEffect(() => {
      callbacks.add(ref);
      return () => { callbacks.delete(ref); };
    }, []);
  };
  return {
    ...actual,
    useRapier: () => runtime.context,
    useBeforePhysicsStep: stepHook(runtime.beforeStep),
    useAfterPhysicsStep: stepHook(runtime.afterStep),
  };
});

vi.mock('@react-three/fiber', async importOriginal => ({
  ...(await importOriginal<typeof import('@react-three/fiber')>()),
  useThree: (selector: (state: { scene: unknown }) => unknown) => selector({ scene: runtime.scene }),
}));

vi.mock('../../runtime/physics', async importOriginal => ({
  ...(await importOriginal<typeof import('../../runtime/physics')>()),
  usePhysicsAvailable: () => true,
}));

let RAPIER: RuntimeRapier;
const toFree: { free(): void }[] = [];

beforeAll(async () => {
  RAPIER = await loadRuntimeRapier();
});

afterEach(() => {
  // Unmounted first: a joint component removes its joint from the world as it unmounts.
  cleanup();
  for (const resource of toFree.splice(0)) resource.free();
});

const FRAME = 1 / 60;
const GRAVITY = 9.81;
const DEFINITION = JOINT_COMPONENTS[0];

const createWorld = (): World => {
  const world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
  world.timestep = FRAME;
  toFree.push(world);
  return world;
};

const jointComponent = (props: Record<string, unknown> = {}): LevelComponent => ({
  id: 'joint-1',
  type: 'joint',
  enabled: true,
  props: { ...Object.fromEntries(DEFINITION.props.map(prop => [prop.key, structuredClone(prop.default)])), ...props },
});

const settingsWith = (props: Record<string, unknown> = {}): JointSettings => resolveJointSettings(jointComponent(props));

/** A dynamic ball of `mass` kg tagged as level object `id`. */
const addBall = (world: World, id: string | null, [x, y, z]: number[], mass = 1, radius = 0.2): Body => {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z));
  if (id) body.userData = physicsUserData(id);
  world.createCollider(RAPIER.ColliderDesc.ball(radius).setMass(mass), body);
  return body;
};

const addFixed = (world: World, id: string | null, [x, y, z]: number[]): Body => {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
  if (id) body.userData = physicsUserData(id);
  return body;
};

const levelGroup = (id: string, position: number[], rotation: number[] = [0, 0, 0], scale: number[] = [1, 1, 1]): THREE.Group => {
  const group = new THREE.Group();
  group.userData = { levelObjectId: id };
  group.position.fromArray(position);
  group.rotation.fromArray(rotation as [number, number, number]);
  group.scale.fromArray(scale);
  return group;
};

const distance = (body: Body, [x, y, z]: number[]): number => {
  const t = body.translation();
  return Math.hypot(t.x - x, t.y - y, t.z - z);
};

const close = (actual: { x: number; y: number; z: number }, expected: number[], digits = 5) => {
  [actual.x, actual.y, actual.z].forEach((value, axis) => expect(value).toBeCloseTo(expected[axis], digits));
};

const stepWorld = (world: World, steps: number, monitor?: JointBreakMonitor) => {
  for (let i = 0; i < steps; i++) {
    monitor?.beforeStep(world);
    world.step();
    monitor?.afterStep(world);
  }
};

describe('the joint component definition', () => {
  it('is a runtime-only Physics Joint with documented defaults', () => {
    expect(DEFINITION.type).toBe('joint');
    expect(DEFINITION.label).toBe('Physics Joint');
    expect(typeof DEFINITION.Render).toBe('function');
    expect(jointComponent().props).toEqual({
      kind: 'spherical', connectedObjectId: '', anchor: [0, 0, 0], connectedAnchor: [0, 0, 0], axis: [0, 1, 0],
      limitsEnabled: false, limitMin: -45, limitMax: 45, breakForce: 0,
    });
    expect(DEFINITION.props.find(prop => prop.key === 'kind')?.options?.map(option => option.value))
      .toEqual(['fixed', 'spherical', 'revolute', 'prismatic']);
  });
});

describe('resolveJointSettings', () => {
  it('reads valid props', () => {
    expect(settingsWith({
      kind: 'revolute', connectedObjectId: '  frame  ', anchor: [1, 2, 3], connectedAnchor: [-1, 0, 0.5], axis: [0, 0, 2],
      limitsEnabled: true, limitMin: -10, limitMax: 80, breakForce: 250,
    })).toEqual({
      kind: 'revolute', connectedObjectId: 'frame', anchor: [1, 2, 3], connectedAnchor: [-1, 0, 0.5], axis: [0, 0, 2],
      limitsEnabled: true, limitMin: -10, limitMax: 80, breakForce: 250,
    });
  });

  it('puts missing or invalid values at their defaults, orders the limits and keeps the break force at or above 0', () => {
    const settings = resolveJointSettings({
      id: 'j', type: 'joint', enabled: true,
      props: { kind: 'rope', connectedObjectId: 7, anchor: [1, 'x', 0], axis: [0, 1], limitsEnabled: 'yes', limitMin: 30, limitMax: -30, breakForce: -5 },
    });
    expect(settings).toEqual({
      kind: 'spherical', connectedObjectId: '', anchor: [0, 0, 0], connectedAnchor: [0, 0, 0], axis: [0, 1, 0],
      limitsEnabled: false, limitMin: -30, limitMax: 30, breakForce: 0,
    });
    expect(resolveJointSettings({ id: 'j', type: 'joint', enabled: true, props: { limitMin: Number.NaN } }).limitMin).toBe(-45);
  });
});

describe('jointDataParams', () => {
  it('turns revolute limits into radians and normalises the axis', () => {
    const params = jointDataParams(settingsWith({ kind: 'revolute', axis: [0, 0, 3], limitsEnabled: true, limitMin: -90, limitMax: 45 }));
    expect(params.kind).toBe('revolute');
    expect(params.axis).toEqual({ x: 0, y: 0, z: 1 });
    expect(params.limits![0]).toBeCloseTo(-Math.PI / 2, 10);
    expect(params.limits![1]).toBeCloseTo(Math.PI / 4, 10);
    // A hinge turns at most half a turn each way.
    expect(jointDataParams(settingsWith({ kind: 'revolute', limitsEnabled: true, limitMin: -400, limitMax: 400 })).limits)
      .toEqual([-Math.PI, Math.PI]);
  });

  it('keeps prismatic limits in metres and leaves them off where they do not apply', () => {
    expect(jointDataParams(settingsWith({ kind: 'prismatic', axis: [3, 4, 0], limitsEnabled: true, limitMin: -0.5, limitMax: 2 })))
      .toMatchObject({ axis: { x: 0.6, y: 0.8, z: 0 }, limits: [-0.5, 2] });
    expect(jointDataParams(settingsWith({ kind: 'prismatic', limitsEnabled: false })).limits).toBeNull();
    expect(jointDataParams(settingsWith({ kind: 'spherical', limitsEnabled: true })).limits).toBeNull();
    expect(jointDataParams(settingsWith({ kind: 'fixed', limitsEnabled: true })).limits).toBeNull();
  });

  it('falls back to the up axis for an axis with no length', () => {
    expect(jointDataParams(settingsWith({ kind: 'revolute', axis: [0, 0, 0] })).axis).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('puts the connected body first: its anchor, or the world anchor body\'s origin', () => {
    const joined = jointDataParams(settingsWith({ connectedObjectId: 'frame', anchor: [1, 0, 0], connectedAnchor: [0, 2, 0] }));
    expect(joined.anchor1).toEqual({ x: 0, y: 2, z: 0 });
    expect(joined.anchor2).toEqual({ x: 1, y: 0, z: 0 });
    const pinned = jointDataParams(settingsWith({ anchor: [1, 0, 0], connectedAnchor: [0, 2, 0] }));
    expect(pinned.anchor1).toEqual({ x: 0, y: 0, z: 0 });
    expect(pinned.anchor2).toEqual({ x: 1, y: 0, z: 0 });
  });

  it('frames a fixed joint with this body\'s rotation relative to the connected one', () => {
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.5);
    const params = jointDataParams(settingsWith({ kind: 'fixed', connectedObjectId: 'frame' }), {
      connectedAnchor: [0, 0, 0], anchor: [0, 0, 0], axis: [0, 1, 0],
      relativeRotation: [turn.x * 2, turn.y * 2, turn.z * 2, turn.w * 2],
    });
    expect(params.frame1.y).toBeCloseTo(turn.y, 10);
    expect(params.frame1.w).toBeCloseTo(turn.w, 10);
    expect(params.frame2).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });
});

describe('estimateJointLoads', () => {
  /** Bodies 100 and up are held (fixed); the rest have the residuals given, or none. */
  const residuals = (values: Record<number, [number, number, number]>) => (body: number): [number, number, number] | null =>
    (body >= 100 ? null : values[body] ?? [0, 0, 0]);

  it('gives a joint holding a free part that part\'s whole residual', () => {
    // A two-link chain hanging from an anchor (100): each link's joints hold up one unit of weight.
    const loads = estimateJointLoads(
      [{ body1: 100, body2: 1 }, { body1: 1, body2: 2 }],
      residuals({ 1: [0, 1, 0], 2: [0, 1, 0] }),
    );
    expect(loads).toEqual([2, 1]);
    // Two free bodies pulling on each other.
    expect(estimateJointLoads([{ body1: 1, body2: 2 }], residuals({ 1: [3, 0, 4], 2: [-3, 0, -4] }))).toEqual([5]);
  });

  it('splits a load held from two sides', () => {
    // A plank (1) held at both ends by anchors 100 and 101, with a weight (2) hanging under it.
    const loads = estimateJointLoads(
      [{ body1: 100, body2: 1 }, { body1: 1, body2: 101 }, { body1: 1, body2: 2 }],
      residuals({ 1: [0, 1, 0], 2: [0, 2, 0] }),
    );
    expect(loads[2]).toBeCloseTo(2, 10);
    // The plank's own weight plus the pull of the weight below, shared by its two end joints.
    expect(loads[0]).toBeCloseTo(1.5, 10);
    expect(loads[1]).toBeCloseTo(1.5, 10);
  });

  it('carries nothing between two held bodies or within one body', () => {
    expect(estimateJointLoads([{ body1: 100, body2: 101 }, { body1: 3, body2: 3 }], residuals({ 3: [0, 5, 0] }))).toEqual([0, 0]);
  });
});

describe('joints in a Rapier world', () => {
  it('keep a dynamic body at its anchor distance from a fixed one with a spherical joint', () => {
    const world = createWorld();
    const pivot = addFixed(world, null, [0, 5, 0]);
    // Held out sideways 2 m from the pivot, so it swings down and round.
    const bob = addBall(world, null, [2, 5, 0]);
    const params = jointDataParams(settingsWith({ kind: 'spherical' }), {
      connectedAnchor: [0, 0, 0], anchor: [-2, 0, 0], axis: [0, 1, 0], relativeRotation: [0, 0, 0, 1],
    });
    createRapierJoint(world, RAPIER, params, pivot, bob);
    let lowest = Infinity;
    for (let frame = 0; frame < 180; frame++) {
      world.step();
      lowest = Math.min(lowest, bob.translation().y);
      expect(distance(bob, [0, 5, 0])).toBeCloseTo(2, 1);
    }
    expect(lowest).toBeLessThan(3.1);
    expect(distance(bob, [0, 5, 0])).toBeCloseTo(2, 2);
  });

  it('stop a hinge at its limits, measured as this object turns about the axis', () => {
    const world = createWorld();
    // A bob 1 m out along +X from a hinge about +Z falls clockwise: towards the lower limit.
    addBall(world, 'bob', [1, 0, 0]);
    const connection = connectJoint(world, RAPIER, 'bob', settingsWith({
      kind: 'revolute', anchor: [-1, 0, 0], axis: [0, 0, 1], limitsEnabled: true, limitMin: -20, limitMax: 10,
    }), null);
    expect(connection.status).toBe('connected');
    stepWorld(world, 240);
    const t = findObjectBody(world, 'bob')!.translation();
    expect(THREE.MathUtils.radToDeg(Math.atan2(t.y, t.x))).toBeCloseTo(-20, 0);
  });

  it('stop a slider at its limits along the axis', () => {
    const world = createWorld();
    const bob = addBall(world, 'bob', [0, 0, 0]);
    connectJoint(world, RAPIER, 'bob', settingsWith({
      kind: 'prismatic', axis: [0, 1, 0], limitsEnabled: true, limitMin: -0.5, limitMax: 0.25,
    }), null);
    stepWorld(world, 240);
    close(bob.translation(), [0, -0.5, 0], 2);
    bob.applyImpulse({ x: 0, y: 20, z: 0 }, true);
    stepWorld(world, 30);
    expect(bob.translation().y).toBeLessThan(0.26);
    expect(Math.hypot(bob.translation().x, bob.translation().z)).toBeLessThan(1e-3);
  });

  it('keep a fixed joint\'s bodies posed as they were, turned ones included', () => {
    const world = createWorld();
    const base = addBall(world, 'base', [0, 10, 0]);
    const arm = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(1, 10, 0)
      .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.6)));
    arm.userData = physicsUserData('arm');
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.3, 0.1, 0.1), arm);
    const root = new THREE.Scene();
    root.add(levelGroup('base', [0, 10, 0]), levelGroup('arm', [1, 10, 0], [0, 0.6, 0]));
    const connection = connectJoint(world, RAPIER, 'arm', settingsWith({ kind: 'fixed', connectedObjectId: 'base', connectedAnchor: [1, 0, 0] }), root);
    expect(connection.status).toBe('connected');
    base.applyTorqueImpulse({ x: 0.02, y: 0.05, z: 0 }, true);
    stepWorld(world, 90);
    const relative = (() => {
      const b = base.rotation();
      const a = arm.rotation();
      return new THREE.Quaternion(b.x, b.y, b.z, b.w).invert().multiply(new THREE.Quaternion(a.x, a.y, a.z, a.w));
    })();
    const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.6);
    expect(Math.abs(relative.dot(expected))).toBeCloseTo(1, 3);
    // The arm's centre stays where it was on the base: the joint sits at the arm's origin, 1 m out along the base's X.
    const offset = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion(base.rotation().x, base.rotation().y, base.rotation().z, base.rotation().w));
    const t = base.translation();
    expect(distance(arm, [t.x + offset.x, t.y + offset.y, t.z + offset.z])).toBeLessThan(0.01);
  });
});

describe('connectJoint', () => {
  it('waits for both bodies, then joins them at anchors placed through the objects\' transform groups', () => {
    const world = createWorld();
    const root = new THREE.Scene();
    // A door scaled 2x, hinged where its left edge meets the frame's right edge, at (1, 1, 0).
    root.add(levelGroup('door', [2, 1, 0], [0, 0, 0], [2, 2, 2]), levelGroup('frame', [0, 1, 0]));
    const settings = settingsWith({ kind: 'revolute', connectedObjectId: 'frame', anchor: [-0.5, 0, 0], connectedAnchor: [1, 0, 0] });
    expect(connectJoint(world, RAPIER, 'door', settings, root).status).toBe('waiting');
    const door = addBall(world, 'door', [2, 1, 0]);
    expect(connectJoint(world, RAPIER, 'door', settings, root).status).toBe('waiting');
    const frame = addFixed(world, 'frame', [0, 1, 0]);
    const connection = connectJoint(world, RAPIER, 'door', settings, root);
    if (connection.status !== 'connected') throw new Error(`not connected: ${connection.status}`);
    const { link } = connection;
    expect(link.body).toBe(door);
    expect(link.connectedBody).toBe(frame);
    expect(link.anchorBody).toBeNull();
    close(link.joint.anchor1(), [1, 0, 0]);
    close(link.joint.anchor2(), [-1, 0, 0]);
    // A hinge about Y holds the door up and level.
    stepWorld(world, 60);
    expect(distance(door, [1, 1, 0])).toBeCloseTo(1, 2);
    expect(door.translation().y).toBeCloseTo(1, 2);
    expect(jointIntact(world, link)).toBe(true);
  });

  it('pins an object to the world at its anchor with a fixed body made there, removed again on release', () => {
    const world = createWorld();
    const root = new THREE.Scene();
    root.add(levelGroup('lamp', [0, 3, 0], [0, 0, Math.PI / 2]));
    const lamp = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 3, 0)
      .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)));
    lamp.userData = physicsUserData('lamp');
    world.createCollider(RAPIER.ColliderDesc.ball(0.2), lamp);
    const connection = connectJoint(world, RAPIER, 'lamp', settingsWith({ anchor: [0, 1, 0] }), root);
    if (connection.status !== 'connected') throw new Error(`not connected: ${connection.status}`);
    const { link } = connection;
    const anchorBody = link.anchorBody!;
    expect(anchorBody.isFixed()).toBe(true);
    expect(link.connectedBody).toBe(anchorBody);
    // The anchor, 1 m up the lamp turned a quarter turn about Z, is 1 m along -X from it.
    close(anchorBody.translation(), [-1, 3, 0]);
    link.pivot!.position.forEach((value, axis) => expect(value).toBeCloseTo([-1, 3, 0][axis], 5));
    close(link.joint.anchor2(), [0, 1, 0]);
    close(link.joint.anchor1(), [0, 0, 0]);
    stepWorld(world, 120);
    expect(distance(lamp, [-1, 3, 0])).toBeCloseTo(1, 2);

    releaseJoint(world, link);
    expect(world.getRigidBody(anchorBody.handle)).toBeNull();
    expect(world.getImpulseJoint(link.joint.handle)).toBeNull();
    expect(world.impulseJoints.len()).toBe(0);
    // Releasing twice is harmless.
    releaseJoint(world, link);
  });

  it('pins a joint formed again to the same spot', () => {
    const world = createWorld();
    addBall(world, 'lamp', [5, 0, 0]);
    const connection = connectJoint(world, RAPIER, 'lamp', settingsWith(), null, { position: [5, 2, 0], rotation: [0, 0, 0, 1] });
    if (connection.status !== 'connected') throw new Error(`not connected: ${connection.status}`);
    close(connection.link.anchorBody!.translation(), [5, 2, 0]);
    expect(connection.link.pivot).toEqual({ position: [5, 2, 0], rotation: [0, 0, 0, 1] });
  });

  it('joins a collider-only child through the body its colliders were folded into', () => {
    const world = createWorld();
    const root = new THREE.Scene();
    const cartGroup = levelGroup('cart', [0, 2, 0]);
    cartGroup.add(levelGroup('handle', [1, 0, 0]));
    root.add(cartGroup);
    const cart = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 2, 0));
    cart.userData = physicsUserData('cart');
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.2, 0.5), cart);
    const handleCollider = world.createCollider(RAPIER.ColliderDesc.ball(0.1).setTranslation(1, 0, 0), cart);
    (handleCollider as unknown as { userData: unknown }).userData = physicsUserData('handle');

    expect(findObjectBody(world, 'handle')).toBe(cart);
    const connection = connectJoint(world, RAPIER, 'handle', settingsWith(), root);
    if (connection.status !== 'connected') throw new Error(`not connected: ${connection.status}`);
    expect(connection.link.body).toBe(cart);
    close(connection.link.joint.anchor2(), [1, 0, 0]);
    close(connection.link.anchorBody!.translation(), [1, 2, 0]);
    // A child joined to the parent it is folded into, or an object to itself, has nothing to join.
    expect(connectJoint(world, RAPIER, 'handle', settingsWith({ connectedObjectId: 'cart' }), root).status).toBe('sameBody');
    expect(connectJoint(world, RAPIER, 'cart', settingsWith({ connectedObjectId: 'cart' }), root).status).toBe('sameBody');
  });
});

describe('breaking joints', () => {
  /** A chain of 1 kg links hanging 1 m apart below a world anchor at y = 10; returns its joints top first. */
  const hangChain = (world: World, links: number) => {
    const anchor = addFixed(world, null, [0, 10, 0]);
    const joints: ReturnType<typeof createRapierJoint>[] = [];
    let above: Body = anchor;
    for (let i = 1; i <= links; i++) {
      const link = addBall(world, `link-${i}`, [0, 10 - i, 0]);
      const params = jointDataParams(settingsWith(), {
        connectedAnchor: above === anchor ? [0, 0, 0] : [0, -0.5, 0], anchor: [0, above === anchor ? 1 : 0.5, 0],
        axis: [0, 1, 0], relativeRotation: [0, 0, 0, 1],
      });
      joints.push(createRapierJoint(world, RAPIER, params, above, link));
      above = link;
    }
    return joints;
  };

  it('breaks the joint carrying more than its break force and keeps the ones below it', () => {
    const world = createWorld();
    const monitor = createJointBreakMonitor();
    const [top, bottom] = hangChain(world, 2);
    const broke: string[] = [];
    // The top joint holds both links (19.6 N), the bottom one only the last (9.8 N).
    monitor.watch(top, 15, () => broke.push('top'));
    monitor.watch(bottom, 15, () => broke.push('bottom'));
    stepWorld(world, 120, monitor);
    expect(broke).toEqual(['top']);
    expect(world.getImpulseJoint(top.handle)).toBeNull();
    expect(world.getImpulseJoint(bottom.handle)).toBe(bottom);
    // The rest of the chain falls together.
    expect(findObjectBody(world, 'link-1')!.translation().y).toBeLessThan(8);
    expect(findObjectBody(world, 'link-2')!.translation().y - findObjectBody(world, 'link-1')!.translation().y).toBeCloseTo(-1, 1);
  });

  it('holds a load under its break force until a push takes it over', () => {
    const world = createWorld();
    const monitor = createJointBreakMonitor();
    const [top, bottom] = hangChain(world, 2);
    const onBreak = vi.fn();
    monitor.watch(top, 25, onBreak);
    monitor.watch(bottom, 15, onBreak);
    stepWorld(world, 180, monitor);
    expect(onBreak).not.toHaveBeenCalled();
    // A yank down on the bottom link (as a hit from a weapon would give it) is more than either joint can take in a step.
    findObjectBody(world, 'link-2')!.applyImpulse({ x: 0, y: -3, z: 0 }, true);
    stepWorld(world, 1, monitor);
    expect(onBreak).toHaveBeenCalledTimes(2);
    expect(world.impulseJoints.len()).toBe(0);
  });

  it('stops watching a joint once unwatched', () => {
    const world = createWorld();
    const monitor = createJointBreakMonitor();
    const [top] = hangChain(world, 1);
    const onBreak = vi.fn();
    const unwatch = monitor.watch(top, 1, onBreak);
    unwatch();
    stepWorld(world, 30, monitor);
    expect(onBreak).not.toHaveBeenCalled();
    expect(world.getImpulseJoint(top.handle)).toBe(top);
  });

  it('feels what other bodies put on it through contacts: a weight resting on it, and a hit', () => {
    /** A 1 kg plank welded to the world at its centre with a 4 kg box resting on top: 49 N in all. */
    const loadedPlank = (breakForce: number) => {
      const world = createWorld();
      const monitor = createJointBreakMonitor();
      const plank = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 2, 0));
      world.createCollider(RAPIER.ColliderDesc.cuboid(1, 0.1, 1).setMass(1), plank);
      const anchor = addFixed(world, null, [0, 2, 0]);
      const joint = createRapierJoint(world, RAPIER, jointDataParams(settingsWith({ kind: 'fixed' })), anchor, plank);
      const box = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 2.6, 0));
      world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setMass(4), box);
      const onBreak = vi.fn();
      monitor.watch(joint, breakForce, onBreak);
      stepWorld(world, 180, monitor);
      return onBreak;
    };
    expect(loadedPlank(55)).not.toHaveBeenCalled();
    expect(loadedPlank(45)).toHaveBeenCalledTimes(1);

    // A 1 kg bob hanging 1 m under the world, struck from above by a 4 kg ball dropped 1.5 m onto it.
    const world = createWorld();
    const monitor = createJointBreakMonitor();
    const [joint] = hangChain(world, 1);
    const onBreak = vi.fn();
    monitor.watch(joint, 40, onBreak);
    stepWorld(world, 60, monitor);
    expect(onBreak).not.toHaveBeenCalled();
    addBall(world, null, [0, 10.9, 0], 4, 0.3);
    stepWorld(world, 120, monitor);
    expect(onBreak).toHaveBeenCalledTimes(1);
  });
});

describe('the joint component during play', () => {
  type Joined = { world: World; scene: THREE.Scene };
  const stepCallbacks = runtime as unknown as { beforeStep: Set<StepCallback>; afterStep: Set<StepCallback> };

  const play = (): Joined => {
    const world = createWorld();
    const scene = new THREE.Scene();
    runtime.context = { world, rapier: RAPIER };
    runtime.scene = scene;
    return { world, scene };
  };

  /** One physics step as <Physics> runs it. */
  const physicsStep = (world: World, steps = 1) => {
    for (let i = 0; i < steps; i++) {
      for (const callback of stepCallbacks.beforeStep) callback.current(world);
      world.step();
      for (const callback of stepCallbacks.afterStep) callback.current(world);
    }
  };

  const lampObject = { id: 'lamp' } as LevelObject;
  const Render = DEFINITION.Render!;
  const mount = (component: LevelComponent) => render(React.createElement(Render, { object: lampObject, component, mode: 'runtime' }));

  beforeEach(() => {
    runtime.beforeStep.clear();
    runtime.afterStep.clear();
  });

  const onlyJoint = (world: World): JointLink['joint'] => {
    const joints = world.impulseJoints.getAll();
    expect(joints).toHaveLength(1);
    return joints[0];
  };

  it('renders nothing in the editor', () => {
    play();
    render(React.createElement(Render, { object: lampObject, component: jointComponent(), mode: 'editor' }));
    expect(runtime.beforeStep.size).toBe(0);
  });

  it('forms once its body exists, follows prop changes and removes everything on unmount', () => {
    const { world, scene } = play();
    scene.add(levelGroup('lamp', [0, 4, 0]));
    const view = mount(jointComponent({ anchor: [0, 1, 0] }));
    physicsStep(world, 3);
    expect(world.impulseJoints.len()).toBe(0);

    const lamp = addBall(world, 'lamp', [0, 4, 0]);
    physicsStep(world);
    const first = onlyJoint(world);
    const firstAnchor = first.body1();
    expect(first.body2()).toBe(lamp);
    // The world anchor body sits where the lamp's anchor was.
    close(firstAnchor.translation(), [0, 5, 0]);
    physicsStep(world, 60);
    expect(distance(lamp, [0, 5, 0])).toBeCloseTo(1, 2);

    // Equal props keep the joint; changed ones rebuild it.
    view.rerender(React.createElement(Render, { object: lampObject, component: jointComponent({ anchor: [0, 1, 0] }), mode: 'runtime' }));
    physicsStep(world);
    expect(onlyJoint(world)).toBe(first);
    view.rerender(React.createElement(Render, { object: lampObject, component: jointComponent({ anchor: [0, 1, 0], kind: 'fixed' }), mode: 'runtime' }));
    physicsStep(world);
    const second = onlyJoint(world);
    expect(second).not.toBe(first);
    // The first anchor body went with its joint; the new one may take over its slot (and handle).
    expect(world.getRigidBody(firstAnchor.handle)).not.toBe(firstAnchor);
    expect(world.bodies.len()).toBe(2);

    const bodiesBefore = world.bodies.len();
    view.unmount();
    expect(world.impulseJoints.len()).toBe(0);
    expect(world.bodies.len()).toBe(bodiesBefore - 1);
  });

  it('forms again with a rebuilt body, pinned to the same spot', () => {
    const { world, scene } = play();
    scene.add(levelGroup('lamp', [0, 4, 0]));
    mount(jointComponent({ anchor: [0, 1, 0] }));
    const lamp = addBall(world, 'lamp', [0, 4, 0]);
    physicsStep(world, 30);
    world.removeRigidBody(lamp);
    const rebuilt = addBall(world, 'lamp', [0.5, 4, 0]);
    physicsStep(world);
    const joint = onlyJoint(world);
    expect(joint.body2()).toBe(rebuilt);
    close(joint.body1().translation(), [0, 5, 0]);
    // Only the new anchor body is left beside the lamp.
    expect(world.bodies.len()).toBe(2);
  });

  it('stays broken once its load passed the break force', () => {
    const { world, scene } = play();
    scene.add(levelGroup('lamp', [0, 4, 0]));
    mount(jointComponent({ anchor: [0, 1, 0], breakForce: 5 }));
    const lamp = addBall(world, 'lamp', [0, 4, 0]);
    // The 1 kg lamp weighs 9.8 N.
    physicsStep(world, 5);
    expect(world.impulseJoints.len()).toBe(0);
    expect(world.bodies.len()).toBe(1);
    physicsStep(world, 30);
    expect(world.impulseJoints.len()).toBe(0);
    expect(lamp.translation().y).toBeLessThan(3.5);
  });

  it('waits for a connected object that does not exist yet', () => {
    const { world, scene } = play();
    scene.add(levelGroup('lamp', [0, 4, 0]), levelGroup('hook', [0, 5, 0]));
    mount(jointComponent({ connectedObjectId: 'hook', anchor: [0, 0.5, 0], connectedAnchor: [0, -0.5, 0] }));
    const lamp = addBall(world, 'lamp', [0, 4, 0]);
    physicsStep(world, 2);
    expect(world.impulseJoints.len()).toBe(0);
    const hook = addFixed(world, 'hook', [0, 5, 0]);
    physicsStep(world);
    const joint = onlyJoint(world);
    expect(joint.body1()).toBe(hook);
    expect(joint.body2()).toBe(lamp);
  });
});
