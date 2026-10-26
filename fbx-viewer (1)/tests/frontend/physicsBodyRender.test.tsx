import React from 'react';
import * as THREE from 'three';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createComponent, getComponentDefinition } from '../../runtime/components/registry';
import { ComponentHostContext } from '../../runtime/components/builtins';
import type { CompoundBodyRegistry, FoldedCollider } from '../../runtime/components/physicsComponents';
import type { LevelComponent, LevelObject } from '../../types';

/*
 * The runtime physics components rendered against a stand-in for @react-three/rapier: bodies record
 * the poses they are given, colliders record when they are built and with which args, and the
 * before-step callbacks run when a test steps the world.
 */

type Pose = { x: number; y: number; z: number };

const rapier = vi.hoisted(() => {
  const createBody = () => {
    const state = { translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
    return {
      state,
      translation: () => ({ ...state.translation }),
      rotation: () => ({ ...state.rotation }),
      setTranslation: vi.fn((t: Pose) => { state.translation = { x: t.x, y: t.y, z: t.z }; }),
      setRotation: vi.fn((r: Pose & { w: number }) => { state.rotation = { x: r.x, y: r.y, z: r.z, w: r.w }; }),
      setLinvel: vi.fn(),
      setAngvel: vi.fn(),
      setNextKinematicTranslation: vi.fn(),
      setNextKinematicRotation: vi.fn(),
    };
  };
  return {
    createBody,
    bodies: [] as ReturnType<typeof createBody>[],
    builds: [] as { shape: string; args: number[] }[],
    removals: 0,
    beforeStep: new Set<{ current: () => void }>(),
  };
});

vi.mock('@react-three/rapier', async () => {
  const R = await import('react');
  const collider = (shape: string) => ({ args }: { args: number[] }) => {
    R.useEffect(() => {
      rapier.builds.push({ shape, args });
      return () => { rapier.removals += 1; };
    }, []);
    return null;
  };
  return {
    RigidBody: R.forwardRef(({ children }: { children?: React.ReactNode }, ref) => {
      const [body] = R.useState(() => {
        const created = rapier.createBody();
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

beforeEach(() => {
  rapier.bodies.length = 0;
  rapier.builds.length = 0;
  rapier.removals = 0;
  rapier.beforeStep.clear();
  // react-dom does not know R3F's <group>; its warnings are not what these tests look at.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('dynamic bodies and transform writes', () => {
  const crate = levelObject('crate', [physicsComponent('rigidBody'), physicsComponent('collider')]);

  it('teleport the body to a transform the level script sets, stopping it there', () => {
    const host = levelGroup('crate');
    const view = render(<PlayObject object={crate} host={host} />);
    const [body] = rapier.bodies;
    expect(body.setTranslation).not.toHaveBeenCalled();

    // Set Actor Transform (Position only) on the session copy.
    const moved = { ...crate, position: [3, 4, 5] as [number, number, number] };
    view.rerender(<PlayObject object={moved} host={host} />);
    expect(host.position.toArray()).toEqual([3, 4, 5]);
    expect(body.state.translation).toEqual({ x: 3, y: 4, z: 5 });
    expect(body.setLinvel).toHaveBeenCalledWith({ x: 0, y: 0, z: 0 }, true);
    expect(body.setAngvel).toHaveBeenCalledWith({ x: 0, y: 0, z: 0 }, true);

    // Other session changes keep the transform arrays, and leave the body alone.
    view.rerender(<PlayObject object={{ ...moved, name: 'renamed' }} host={host} />);
    expect(body.setTranslation).toHaveBeenCalledTimes(1);

    // The same position again, after the simulation moved the crate away from it: R3F would not
    // re-apply an equal prop, so the host is set here, and the crate goes back.
    body.state.translation = { x: 9, y: 0, z: 0 };
    host.position.set(9, 0, 0);
    view.rerender(<PlayObject object={{ ...moved, position: [3, 4, 5] }} host={host} />);
    expect(body.state.translation).toEqual({ x: 3, y: 4, z: 5 });

    // A write echoing the body's own pose does not stop it.
    view.rerender(<PlayObject object={{ ...moved, position: [3, 4, 5] }} host={host} />);
    expect(body.setTranslation).toHaveBeenCalledTimes(2);

    view.rerender(<PlayObject object={{ ...moved, rotation: [0, Math.PI / 2, 0] }} host={host} />);
    const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0));
    const r = body.state.rotation;
    expect(Math.abs(new THREE.Quaternion(r.x, r.y, r.z, r.w).dot(expected))).toBeCloseTo(1, 6);
  });

  it('leave fixed bodies to follow their host on the physics step', () => {
    const wall = levelObject('wall', [physicsComponent('collider')]);
    const host = levelGroup('wall');
    const view = render(<PlayObject object={wall} host={host} />);
    view.rerender(<PlayObject object={{ ...wall, position: [1, 2, 3] }} host={host} />);
    const [body] = rapier.bodies;
    expect(body.setLinvel).not.toHaveBeenCalled();
    host.position.set(1, 2, 3);
    step();
    expect(body.state.translation).toEqual({ x: 1, y: 2, z: 3 });
  });
});

describe('collider shapes during play', () => {
  it('rebuild when the object\'s world scale changes, keeping the body', () => {
    const pad = levelObject('pad', [physicsComponent('collider', { isTrigger: true })]);
    const host = levelGroup('pad');
    render(<PlayObject object={pad} host={host} />);
    step();
    expect(rapier.builds).toHaveLength(1);

    // Set Actor Transform grows the trigger zone.
    host.scale.set(5, 5, 5);
    step();
    expect(rapier.builds).toHaveLength(2);
    expect(rapier.removals).toBe(1);
    expect(rapier.bodies).toHaveLength(1);
    step();
    expect(rapier.builds).toHaveLength(2);
  });

  it('fit capsules to the object\'s scale the way the editor draws them', () => {
    const pillar = levelObject('pillar', [physicsComponent('collider', { shape: 'capsule', radius: 0.5, height: 2 })]);
    const host = levelGroup('pillar');
    host.scale.set(1, 2, 1);
    render(<PlayObject object={pillar} host={host} />);
    // The binding scales these by [x, y]: a capsule with half height 1.5 and radius 0.5, 4 m tall.
    expect(rapier.builds).toEqual([{ shape: 'capsule', args: [1.5, 0.25] }]);

    host.scale.set(2, 1, 2);
    step();
    expect(rapier.builds[1]).toEqual({ shape: 'capsule', args: [0, 1] });
  });
});

describe('collider-only children of a moving rigid body', () => {
  const wheel = levelObject('wheel', [physicsComponent('collider', { shape: 'sphere', radius: 0.4 })], { position: [1, -0.25, 0.5] });

  const cartWith = (type: CompoundBodyRegistry['type']) => {
    const cart = levelGroup('cart');
    const registry: CompoundBodyRegistry = { rigidBody: true, type, set: vi.fn() };
    const anchor = new THREE.Group();
    anchor.userData = { auvraPhysicsAnchor: true, auvraCompoundBody: registry };
    cart.add(anchor);
    const host = levelGroup('wheel');
    host.position.set(...wheel.position);
    cart.add(host);
    return { registry, host };
  };

  it('add their colliders to the parent body instead of mounting a fixed body of their own', () => {
    const { registry, host } = cartWith('dynamic');
    const view = render(<PlayObject object={wheel} host={host} />);
    expect(rapier.bodies).toHaveLength(0);
    expect(rapier.builds).toHaveLength(0);
    expect(registry.set).toHaveBeenLastCalledWith('wheel', [expect.objectContaining({ objectId: 'wheel', position: [1, -0.25, 0.5] })]);

    // Moving the wheel relative to the cart re-places its collider.
    host.position.set(2, 0, 0);
    view.rerender(<PlayObject object={{ ...wheel, position: [2, 0, 0] }} host={host} />);
    const [, colliders] = vi.mocked(registry.set).mock.lastCall!;
    expect((colliders as FoldedCollider[])[0].position).toEqual([2, 0, 0]);

    view.unmount();
    expect(registry.set).toHaveBeenLastCalledWith('wheel', null);
  });

  it('keep their own body under a fixed one', () => {
    const { registry, host } = cartWith('fixed');
    render(<PlayObject object={wheel} host={host} />);
    expect(registry.set).not.toHaveBeenCalled();
    expect(rapier.bodies).toHaveLength(1);
    expect(rapier.builds).toEqual([{ shape: 'ball', args: [0.4] }]);
  });
});
