import React from 'react';
import * as THREE from 'three';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IKPoseGuard,
  applyLookAt,
  findBone,
  keepWorldRotation,
  limitDirection,
  offsetBoneWorld,
  solveTwoBoneIK,
} from '../../runtime/ik';
import {
  IK_COMPONENTS,
  IKPlayerTargetContext,
  createFootIKState,
  createLookAtIKState,
  footIKBones,
  readFootIKSettings,
  readLookAtIKSettings,
  resolveFootIKRig,
  updateFootIK,
  updateLookAtIK,
} from '../../runtime/components/ikComponents';
import type { FootIKOptions, FootIKRig } from '../../runtime/components/ikComponents';
import { ComponentHostContext } from '../../runtime/components/builtins';
import type { PhysicsQueries, PhysicsRaycastOptions } from '../../runtime/physics';
import type { LevelComponent, LevelObject } from '../../types';

/*
 * IK math on plain THREE.Bone chains, then the lookAtIK and footIK components rendered against a frame
 * loop the tests step by hand and a stand-in ground for physics raycasts.
 */

type FrameCallback = (state: { camera: THREE.Camera }, delta: number) => void;

const frameLoop = vi.hoisted(() => ({ callbacks: new Set<{ current: FrameCallback }>() }));
const physicsStub = vi.hoisted(() => ({
  raycast: null as null | ((...args: unknown[]) => unknown),
}));

vi.mock('@react-three/fiber', async (importOriginal) => {
  const R = await import('react');
  return {
    ...(await importOriginal<typeof import('@react-three/fiber')>()),
    useFrame: (callback: FrameCallback) => {
      const ref = R.useRef(callback);
      ref.current = callback;
      R.useEffect(() => {
        frameLoop.callbacks.add(ref);
        return () => { frameLoop.callbacks.delete(ref); };
      }, []);
    },
  };
});

vi.mock('../../runtime/physics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runtime/physics')>();
  return {
    ...actual,
    usePhysicsQueries: () => ({
      raycast: (...args: unknown[]) => physicsStub.raycast?.(...args) ?? null,
      applyImpulse: () => false,
      getBodyPose: () => null,
    }),
  };
});

afterEach(() => {
  physicsStub.raycast = null;
});

const FRAME = 1 / 60;

const world = (object: THREE.Object3D) => object.getWorldPosition(new THREE.Vector3());
const worldQuaternion = (object: THREE.Object3D) => object.getWorldQuaternion(new THREE.Quaternion());
/** Where `axis` (a local direction of `object`) points in world space. */
const worldAxis = (object: THREE.Object3D, axis: THREE.Vector3) => {
  object.updateWorldMatrix(true, false);
  return axis.clone().transformDirection(object.matrixWorld);
};

const Z = new THREE.Vector3(0, 0, 1);

// --- TWO-BONE IK ---

/** A two-bone chain hanging from `parent`'s origin: a 1 m upper and a 0.8 m lower bone, the knee bent towards -Z. */
const chain = (parent: THREE.Object3D = new THREE.Group()) => {
  const root = new THREE.Bone();
  const mid = new THREE.Bone();
  const end = new THREE.Bone();
  mid.position.set(0, -1, 0);
  end.position.set(0, -0.8, 0);
  root.rotation.x = 0.2;
  mid.rotation.x = -0.5;
  parent.add(root);
  root.add(mid);
  mid.add(end);
  parent.updateMatrixWorld(true);
  return { parent, root, mid, end };
};

const parentWith = (rotation: [number, number, number], scale: [number, number, number], position: [number, number, number] = [0, 0, 0]) => {
  const outer = new THREE.Group();
  outer.position.set(4, -2, 1);
  outer.rotation.set(-0.3, 0.8, 0.1);
  const parent = new THREE.Group();
  parent.position.set(...position);
  parent.rotation.set(...rotation);
  parent.scale.set(...scale);
  outer.add(parent);
  outer.updateMatrixWorld(true);
  return parent;
};

const PARENTS: [string, () => THREE.Object3D][] = [
  ['no parent transform', () => new THREE.Group()],
  ['a rotated, uniformly scaled parent', () => parentWith([0.4, -1.1, 0.7], [2.5, 2.5, 2.5], [1, 3, -2])],
  ['a rotated, mirrored parent', () => parentWith([-0.6, 0.3, 1.2], [-0.5, 0.5, 0.5], [0, 1, 0])],
];

describe('solveTwoBoneIK', () => {
  it.each(PARENTS)('reaches a reachable target under %s without changing bone lengths', (_label, makeParent) => {
    const { parent, root, mid, end } = chain(makeParent());
    const upper = world(root).distanceTo(world(mid));
    const lower = world(mid).distanceTo(world(end));
    const target = parent.localToWorld(new THREE.Vector3(0.3, -1.2, 0.4));

    solveTwoBoneIK(root, mid, end, target, null, 1);

    expect(world(end).distanceTo(target)).toBeLessThan(1e-3);
    expect(world(root).distanceTo(world(mid))).toBeCloseTo(upper, 6);
    expect(world(mid).distanceTo(world(end))).toBeCloseTo(lower, 6);
    expect(mid.position.toArray()).toEqual([0, -1, 0]);
    expect(end.position.toArray()).toEqual([0, -0.8, 0]);
  });

  it('reaches a target under a parent with non-uniform scale', () => {
    const { parent, root, mid, end } = chain(parentWith([0.5, 0.2, -0.4], [1, 1.6, 0.7]));
    const target = parent.localToWorld(new THREE.Vector3(0.2, -1.1, 0.5));

    solveTwoBoneIK(root, mid, end, target, null, 1);

    expect(world(end).distanceTo(target)).toBeLessThan(1e-3);
  });

  it.each(PARENTS)('straightens towards an out-of-range target under %s', (_label, makeParent) => {
    const { parent, root, mid, end } = chain(makeParent());
    const reach = world(root).distanceTo(world(mid)) + world(mid).distanceTo(world(end));
    const target = parent.localToWorld(new THREE.Vector3(2, -3, 1));

    solveTwoBoneIK(root, mid, end, target, null, 1);

    const toEnd = world(end).sub(world(root));
    const toTarget = target.clone().sub(world(root));
    expect(toEnd.angleTo(toTarget)).toBeLessThan(1e-4);
    expect(toEnd.length()).toBeCloseTo(reach, 5);
  });

  it('bends towards the pole, or keeps the current bend side without one', () => {
    const below = new THREE.Vector3(0, -1.4, 0);
    const kneeZ = (pole: THREE.Vector3 | null) => {
      const { parent, root, mid, end } = chain(parentWith([0.3, 0.9, -0.2], [2, 2, 2]));
      const target = parent.localToWorld(below.clone());
      solveTwoBoneIK(root, mid, end, target, pole && parent.localToWorld(pole.clone()), 1);
      expect(world(end).distanceTo(target)).toBeLessThan(1e-3);
      return parent.worldToLocal(world(mid)).z;
    };

    expect(kneeZ(new THREE.Vector3(0, -0.7, 1))).toBeGreaterThan(0.1);
    expect(kneeZ(new THREE.Vector3(0, -0.7, -1))).toBeLessThan(-0.1);
    // The chain starts bent towards -Z.
    expect(kneeZ(null)).toBeLessThan(-0.1);
  });

  it('leaves the chain untouched at weight 0 and blends part of the way at weight 0.5', () => {
    const still = chain(parentWith([0.2, 0.4, 0], [1.5, 1.5, 1.5]));
    const rootBefore = still.root.quaternion.clone();
    const midBefore = still.mid.quaternion.clone();
    const endBefore = world(still.end);
    const target = still.parent.localToWorld(new THREE.Vector3(0.6, -0.9, 0.2));

    solveTwoBoneIK(still.root, still.mid, still.end, target, null, 0);

    expect(still.root.quaternion.toArray()).toEqual(rootBefore.toArray());
    expect(still.mid.quaternion.toArray()).toEqual(midBefore.toArray());
    expect(world(still.end).toArray()).toEqual(endBefore.toArray());

    const full = chain(parentWith([0.2, 0.4, 0], [1.5, 1.5, 1.5]));
    const half = chain(parentWith([0.2, 0.4, 0], [1.5, 1.5, 1.5]));
    solveTwoBoneIK(full.root, full.mid, full.end, target, null, 1);
    solveTwoBoneIK(half.root, half.mid, half.end, target, null, 0.5);
    expect(half.root.quaternion.angleTo(rootBefore)).toBeCloseTo(full.root.quaternion.angleTo(rootBefore) / 2, 6);
    expect(half.mid.quaternion.angleTo(midBefore)).toBeCloseTo(full.mid.quaternion.angleTo(midBefore) / 2, 6);
  });

  it('ignores a chain that is not a hierarchy and non-finite targets', () => {
    const { root, mid, end } = chain();
    const loose = new THREE.Bone();
    const before = root.quaternion.clone();
    solveTwoBoneIK(root, loose, end, new THREE.Vector3(0.5, -1, 0), null, 1);
    solveTwoBoneIK(root, mid, end, new THREE.Vector3(Number.NaN, -1, 0), null, 1);
    expect(root.quaternion.toArray()).toEqual(before.toArray());
  });

  it('updates the world matrices of the chain and the bones below it', () => {
    const { root, mid, end } = chain();
    const toe = new THREE.Bone();
    toe.position.set(0, 0, 0.2);
    end.add(toe);
    root.updateMatrixWorld(true);
    const target = new THREE.Vector3(0.5, -1.2, 0.3);

    solveTwoBoneIK(root, mid, end, target, null, 1);

    expect(new THREE.Vector3().setFromMatrixPosition(end.matrixWorld).distanceTo(target)).toBeLessThan(1e-3);
    const toeMatrix = toe.matrixWorld.clone();
    toe.updateWorldMatrix(true, false);
    expect(toe.matrixWorld.equals(toeMatrix)).toBe(true);
  });
});

// --- LOOK-AT ---

/** A head bone under `parent`, its local +Z its face. */
const headUnder = (parent: THREE.Object3D) => {
  const head = new THREE.Bone();
  head.position.set(0, 1.6, 0);
  head.rotation.set(0.1, -0.2, 0.05);
  parent.add(head);
  parent.updateMatrixWorld(true);
  return head;
};

/** A world point `angle` radians from where the head faces, turned about the head's world up. */
const pointAround = (head: THREE.Object3D, angle: number) => {
  const forward = worldAxis(head, Z);
  const up = worldAxis(head, new THREE.Vector3(0, 1, 0));
  return world(head).add(forward.applyAxisAngle(up, angle).multiplyScalar(3));
};

describe('applyLookAt', () => {
  it.each(PARENTS)('points the forward axis at a target within the limit under %s', (_label, makeParent) => {
    const head = headUnder(makeParent());
    const target = pointAround(head, THREE.MathUtils.degToRad(40));

    applyLookAt(head, target, Z, THREE.MathUtils.degToRad(70), 1);

    expect(worldAxis(head, Z).angleTo(target.clone().sub(world(head)))).toBeLessThan(1e-5);
  });

  it.each(PARENTS)('turns at most maxAngle towards a target beyond it under %s', (_label, makeParent) => {
    const head = headUnder(makeParent());
    const rest = worldAxis(head, Z);
    const target = pointAround(head, THREE.MathUtils.degToRad(120));
    const toTarget = target.clone().sub(world(head));

    applyLookAt(head, target, Z, THREE.MathUtils.degToRad(45), 1);

    const forward = worldAxis(head, Z);
    expect(forward.angleTo(rest)).toBeCloseTo(THREE.MathUtils.degToRad(45), 5);
    expect(forward.angleTo(toTarget)).toBeCloseTo(THREE.MathUtils.degToRad(75), 5);
  });

  it('is a no-op at weight 0 and turns half the clamped angle at weight 0.5', () => {
    const head = headUnder(parentWith([0.3, 0, 0.2], [2, 2, 2]));
    const before = head.quaternion.clone();
    const rest = worldAxis(head, Z);
    const target = pointAround(head, THREE.MathUtils.degToRad(90));

    applyLookAt(head, target, Z, THREE.MathUtils.degToRad(60), 0);
    expect(head.quaternion.toArray()).toEqual(before.toArray());

    applyLookAt(head, target, Z, THREE.MathUtils.degToRad(60), 0.5);
    expect(worldAxis(head, Z).angleTo(rest)).toBeCloseTo(THREE.MathUtils.degToRad(30), 5);
  });

  it('does not roll the bone around its forward axis', () => {
    const head = headUnder(new THREE.Group());
    const up = worldAxis(head, new THREE.Vector3(0, 1, 0));
    const target = pointAround(head, THREE.MathUtils.degToRad(50));

    applyLookAt(head, target, Z, Math.PI, 1);

    // A pure yaw about the head's own up axis keeps that axis where it was.
    expect(worldAxis(head, new THREE.Vector3(0, 1, 0)).angleTo(up)).toBeLessThan(1e-5);
  });
});

describe('limitDirection', () => {
  it('returns directions within the limit unchanged and clamps the rest', () => {
    const from = new THREE.Vector3(0, 0, 1);
    const near = new THREE.Vector3(1, 0, 1).normalize();
    expect(limitDirection(from, near, Math.PI / 2, new THREE.Vector3()).toArray()).toEqual(near.toArray());

    const behind = new THREE.Vector3(1, 0, -1).normalize();
    const limited = limitDirection(from, behind, Math.PI / 4, new THREE.Vector3());
    expect(limited.angleTo(from)).toBeCloseTo(Math.PI / 4, 6);
    expect(limited.x).toBeGreaterThan(0);
  });
});

// --- POSE HELPERS ---

describe('keepWorldRotation', () => {
  it.each(PARENTS)('restores the end bone\'s world rotation after a leg solve under %s', (_label, makeParent) => {
    const { parent, root, mid, end } = chain(makeParent());
    end.rotation.set(0.3, 0.2, -0.1);
    parent.updateMatrixWorld(true);
    const before = worldQuaternion(end);
    const midBefore = mid.matrixWorld.clone();

    solveTwoBoneIK(root, mid, end, parent.localToWorld(new THREE.Vector3(0.4, -1, 0.3)), null, 1);
    expect(worldQuaternion(end).angleTo(before)).toBeGreaterThan(0.05);

    keepWorldRotation(end, midBefore, null, 1);
    expect(worldQuaternion(end).angleTo(before)).toBeLessThan(1e-5);

    const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.3);
    const midNow = mid.matrixWorld.clone();
    keepWorldRotation(end, midNow, tilt, 1);
    expect(worldQuaternion(end).angleTo(tilt.clone().multiply(before))).toBeLessThan(1e-5);
  });
});

describe('offsetBoneWorld', () => {
  it('moves a bone by a world-space offset under a rotated, scaled parent', () => {
    const parent = parentWith([0.7, -0.4, 0.2], [3, 3, 3]);
    const bone = new THREE.Bone();
    bone.position.set(0.2, 0.5, -0.1);
    parent.add(bone);
    parent.updateMatrixWorld(true);
    const before = world(bone);

    offsetBoneWorld(bone, new THREE.Vector3(0, -0.3, 0.1));

    expect(world(bone).sub(before).distanceTo(new THREE.Vector3(0, -0.3, 0.1))).toBeLessThan(1e-9);
  });
});

describe('IKPoseGuard', () => {
  it('keeps IK on a bone nothing animates from building on its own output', () => {
    const head = headUnder(new THREE.Group());
    const rest = head.quaternion.clone();
    const restForward = worldAxis(head, Z);
    const target = pointAround(head, THREE.MathUtils.degToRad(90));
    const guard = new IKPoseGuard();

    for (let frame = 0; frame < 10; frame++) {
      guard.begin([head]);
      applyLookAt(head, target, Z, THREE.MathUtils.degToRad(30), 1);
      guard.commit();
    }

    expect(worldAxis(head, Z).angleTo(restForward)).toBeCloseTo(THREE.MathUtils.degToRad(30), 5);
    guard.release();
    expect(head.quaternion.toArray()).toEqual(rest.toArray());
  });

  it('keeps a pose something else wrote since the last IK pass', () => {
    const bone = new THREE.Bone();
    const guard = new IKPoseGuard();
    guard.begin([bone]);
    bone.rotation.y = 0.4;
    guard.commit();

    const animated = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.25);
    bone.quaternion.copy(animated);
    guard.begin([bone]);
    expect(bone.quaternion.toArray()).toEqual(animated.toArray());

    // A bone IK no longer moves gets its pre-IK pose back.
    bone.rotation.z = 1;
    guard.commit();
    guard.begin([]);
    expect(bone.quaternion.toArray()).toEqual(animated.toArray());
  });
});

// --- BONE LOOKUP ---

describe('findBone', () => {
  const bone = (name: string, parent: THREE.Object3D) => {
    const created = new THREE.Bone();
    created.name = name;
    parent.add(created);
    return created;
  };

  it('matches mixamorig prefixes, namespaces, separators and case', () => {
    for (const name of ['mixamorig:LeftFoot', 'mixamorigLeftFoot', 'mixamorig1_LeftFoot', 'Armature|leftfoot', 'LEFT_FOOT']) {
      const root = new THREE.Group();
      const foot = bone(name, bone('Hips', root));
      expect(findBone(root, 'LeftFoot')).toBe(foot);
      expect(findBone(root, 'mixamorig:leftFoot')).toBe(foot);
    }
    expect(findBone(new THREE.Group(), 'LeftFoot')).toBeNull();
    expect(findBone(new THREE.Group(), '')).toBeNull();
  });

  it('prefers bones over other objects and exact names over loose ones', () => {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh();
    mesh.name = 'Head';
    root.add(mesh);
    const loose = bone('mixamorig:Head', root);
    expect(findBone(root, 'Head')).toBe(loose);
    const exact = bone('Head', root);
    expect(findBone(root, 'Head')).toBe(exact);
    expect(findBone(root, 'HeadTop_End')).toBeNull();
  });

  it('leaves out subtrees the skip filter rejects', () => {
    const root = new THREE.Group();
    const nested = new THREE.Group();
    root.add(nested);
    bone('Head', nested);
    const own = bone('mixamorig:Head', root);
    expect(findBone(root, 'Head', node => node === nested)).toBe(own);
  });
});

// --- FOOT IK ---

/**
 * A Mixamo-style biped under `host`: hips 1 m above the host, legs of two 0.45 m bones with the knees
 * bent slightly forward, ankles 0.1 m above the floor and toes pointing +Z.
 */
const biped = (host: THREE.Object3D) => {
  const bone = (name: string, parent: THREE.Object3D, x: number, y: number, z: number) => {
    const created = new THREE.Bone();
    created.name = `mixamorig:${name}`;
    created.position.set(x, y, z);
    parent.add(created);
    return created;
  };
  const model = new THREE.Group();
  host.add(model);
  const hips = bone('Hips', model, 0, 1, 0);
  const leg = (side: 'Left' | 'Right', x: number) => {
    const thigh = bone(`${side}UpLeg`, hips, x, 0, 0);
    const calf = bone(`${side}Leg`, thigh, 0, -0.45, 0.03);
    const foot = bone(`${side}Foot`, calf, 0, -0.45, -0.03);
    const toe = bone(`${side}ToeBase`, foot, 0, -0.08, 0.12);
    return { thigh, calf, foot, toe };
  };
  const left = leg('Left', 0.1);
  const right = leg('Right', -0.1);
  const head = bone('Head', hips, 0, 0.7, 0);
  host.updateMatrixWorld(true);
  return { model, hips, left, right, head };
};

interface RayCall {
  origin: THREE.Vector3;
  maxDistance: number;
  options?: PhysicsRaycastOptions;
}

/** Ground at `heightAt(x)` (null for none) under a downward ray, recording each cast. */
const ground = (heightAt: (x: number) => number | null, calls: RayCall[] = [], normal = new THREE.Vector3(0, 1, 0)): PhysicsQueries['raycast'] =>
  (origin, direction, maxDistance, options) => {
    calls.push({ origin: origin.clone(), maxDistance, options });
    const height = heightAt(origin.x);
    if (height === null || direction.y >= 0) return null;
    const distance = origin.y - height;
    if (distance < 0 || distance > maxDistance) return null;
    return { objectId: 'ground', point: new THREE.Vector3(origin.x, height, origin.z), normal: normal.clone(), distance };
  };

/** Steps foot IK the way the component does: the guard undoes last frame's IK, as an animation would overwrite it. */
const runFootIK = (host: THREE.Object3D, rig: FootIKRig, raycast: PhysicsQueries['raycast'], options: FootIKOptions, frames = 90) => {
  const guard = new IKPoseGuard();
  const state = createFootIKState();
  for (let frame = 0; frame < frames; frame++) {
    guard.begin(footIKBones(rig));
    updateFootIK(host, rig, raycast, options, state, FRAME);
    guard.commit();
  }
  return state;
};

const placedHost = () => {
  const host = new THREE.Group();
  host.position.set(3, 2, -1);
  host.rotation.y = 0.3;
  host.updateMatrixWorld(true);
  return host;
};

describe('foot IK', () => {
  it('resolves the legs and the shared hips under the host', () => {
    const host = new THREE.Group();
    const { hips, left, right } = biped(host);
    const rig = resolveFootIKRig(host, ['LeftFoot', 'RightFoot'])!;
    expect(rig.hips).toBe(hips);
    expect(rig.legs).toEqual([
      { thigh: left.thigh, calf: left.calf, foot: left.foot, toe: left.toe },
      { thigh: right.thigh, calf: right.calf, foot: right.foot, toe: right.toe },
    ]);
    expect(footIKBones(rig)).toEqual([hips, left.thigh, left.calf, left.foot, right.thigh, right.calf, right.foot]);
    expect(resolveFootIKRig(host, ['NoSuchFoot'])).toBeNull();
  });

  it('raises a foot onto higher ground with the knee bending forward', () => {
    const host = placedHost();
    const { hips, left, right } = biped(host);
    const rig = resolveFootIKRig(host, ['LeftFoot', 'RightFoot'])!;
    const leftFoot = world(left.foot);
    const rightFoot = world(right.foot);
    const hipsBefore = world(hips);
    const kneeBefore = host.worldToLocal(world(left.calf));
    const floor = host.position.y;

    runFootIK(host, rig, ground(x => (Math.abs(x - leftFoot.x) < 0.05 ? floor + 0.2 : floor)), { maxStep: 0.5, weight: 1 });

    expect(world(left.foot).distanceTo(leftFoot.clone().setY(leftFoot.y + 0.2))).toBeLessThan(1e-3);
    expect(world(right.foot).distanceTo(rightFoot)).toBeLessThan(1e-3);
    expect(world(hips).distanceTo(hipsBefore)).toBeLessThan(1e-6);
    expect(host.worldToLocal(world(left.calf)).z).toBeGreaterThan(kneeBefore.z + 0.05);
  });

  it('drops the pelvis so a foot reaches lower ground', () => {
    const host = placedHost();
    const { hips, left, right } = biped(host);
    const rig = resolveFootIKRig(host, ['LeftFoot', 'RightFoot'])!;
    const leftFoot = world(left.foot);
    const rightFoot = world(right.foot);
    const hipsBefore = world(hips);
    const floor = host.position.y;

    runFootIK(host, rig, ground(x => (Math.abs(x - leftFoot.x) < 0.05 ? floor - 0.2 : floor)), { maxStep: 0.5, weight: 1 });

    expect(world(hips).y).toBeCloseTo(hipsBefore.y - 0.2, 3);
    expect(world(left.foot).distanceTo(leftFoot.clone().setY(leftFoot.y - 0.2))).toBeLessThan(1e-3);
    expect(world(right.foot).distanceTo(rightFoot)).toBeLessThan(1e-3);
  });

  it('keeps each foot\'s animated orientation on flat steps and tilts it to sloped ground', () => {
    const flatHost = placedHost();
    const flat = biped(flatHost);
    const flatRig = resolveFootIKRig(flatHost, ['LeftFoot', 'RightFoot'])!;
    const flatBefore = worldQuaternion(flat.left.foot);
    const floor = flatHost.position.y;
    runFootIK(flatHost, flatRig, ground(() => floor + 0.15), { maxStep: 0.5, weight: 1 });
    expect(worldQuaternion(flat.left.foot).angleTo(flatBefore)).toBeLessThan(1e-5);

    const slopeHost = placedHost();
    const slope = biped(slopeHost);
    const slopeRig = resolveFootIKRig(slopeHost, ['LeftFoot', 'RightFoot'])!;
    const slopeBefore = worldQuaternion(slope.left.foot);
    const normal = new THREE.Vector3(0, 1, 0).applyAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(20));
    runFootIK(slopeHost, slopeRig, ground(() => floor, [], normal), { maxStep: 0.5, weight: 1 });
    expect(worldQuaternion(slope.left.foot).angleTo(slopeBefore)).toBeCloseTo(THREE.MathUtils.degToRad(20), 3);
  });

  it('leaves the legs alone when the ground is out of step range, and excludes the host\'s own body', () => {
    const host = placedHost();
    const { left, right } = biped(host);
    const rig = resolveFootIKRig(host, ['LeftFoot', 'RightFoot'])!;
    const poses = [left.thigh, left.calf, left.foot, right.thigh, right.calf, right.foot].map(bone => bone.quaternion.toArray());
    const calls: RayCall[] = [];
    const floor = host.position.y;

    runFootIK(host, rig, ground(() => floor + 0.7, calls), { maxStep: 0.5, weight: 1, excludeObjectId: 'npc' });

    expect([left.thigh, left.calf, left.foot, right.thigh, right.calf, right.foot].map(bone => bone.quaternion.toArray())).toEqual(poses);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.options?.excludeObjectId).toBe('npc');
      // From maxStep above the foot down to maxStep below the floor.
      expect(call.origin.y - call.maxDistance).toBeCloseTo(floor - 0.5, 6);
    }
  });

  it('does nothing at weight 0', () => {
    const host = placedHost();
    const { left } = biped(host);
    const rig = resolveFootIKRig(host, ['LeftFoot', 'RightFoot'])!;
    const before = world(left.foot);
    const calls: RayCall[] = [];

    runFootIK(host, rig, ground(() => host.position.y + 0.2, calls), { maxStep: 0.5, weight: 0 });

    expect(calls).toHaveLength(0);
    expect(world(left.foot).toArray()).toEqual(before.toArray());
  });
});

describe('look-at IK', () => {
  it('eases to the clamped direction and swings back through the front when the target passes behind', () => {
    const host = new THREE.Group();
    const { head } = biped(host);
    const rest = worldAxis(head, Z);
    const settings = { forward: Z, maxAngle: THREE.MathUtils.degToRad(70), weight: 1 };
    const guard = new IKPoseGuard();
    const state = createLookAtIKState();
    const step = (target: THREE.Vector3) => {
      guard.begin([head]);
      updateLookAtIK(head, target, settings, state, FRAME);
      guard.commit();
      return worldAxis(head, Z);
    };

    // Behind the left shoulder: the head turns to the 70 degree limit on that side.
    const behindLeft = world(head).add(new THREE.Vector3(3, 0, -1));
    for (let frame = 0; frame < 200; frame++) step(behindLeft);
    expect(worldAxis(head, Z).angleTo(rest)).toBeCloseTo(THREE.MathUtils.degToRad(70), 3);
    expect(worldAxis(head, Z).x).toBeGreaterThan(0);

    // The target crosses to behind the right shoulder: no frame jumps, and the head passes the front.
    const behindRight = world(head).add(new THREE.Vector3(-3, 0, -1));
    let previous = worldAxis(head, Z);
    let closest = Math.PI;
    for (let frame = 0; frame < 200; frame++) {
      const forward = step(behindRight);
      expect(forward.angleTo(previous)).toBeLessThan(THREE.MathUtils.degToRad(10));
      closest = Math.min(closest, forward.angleTo(rest));
      previous = forward;
    }
    expect(closest).toBeLessThan(THREE.MathUtils.degToRad(5));
    expect(worldAxis(head, Z).x).toBeLessThan(0);
  });
});

// --- COMPONENTS ---

const definition = (type: string) => IK_COMPONENTS.find(entry => entry.type === type)!;

const componentOf = (type: string, props: Record<string, unknown> = {}): LevelComponent => ({
  id: `${type}-1`,
  type,
  enabled: true,
  props: { ...Object.fromEntries(definition(type).props.map(prop => [prop.key, prop.default])), ...props },
});

const levelObject = (id: string): LevelObject => ({ id } as unknown as LevelObject);

const stepFrames = (count: number, camera: THREE.Camera = new THREE.PerspectiveCamera()) => {
  act(() => {
    for (let frame = 0; frame < count; frame++) frameLoop.callbacks.forEach(callback => callback.current({ camera }, FRAME));
  });
};

const mount = (type: string, host: THREE.Object3D, props: Record<string, unknown> = {}, mode: 'editor' | 'runtime' = 'runtime', player?: THREE.Object3D) => {
  const Render = definition(type).Render!;
  const hostRef = { current: host };
  const playerRef = { current: player ?? null };
  return render(
    React.createElement(
      IKPlayerTargetContext.Provider,
      { value: playerRef },
      React.createElement(
        ComponentHostContext.Provider,
        { value: hostRef },
        React.createElement(Render, { object: levelObject('npc'), component: componentOf(type, props), mode })
      )
    )
  );
};

describe('IK component definitions', () => {
  it('registers lookAtIK, footIK and Reach IK with their documented defaults', () => {
    expect(IK_COMPONENTS.map(entry => entry.type)).toEqual(['lookAtIK', 'footIK', 'twoBoneIK']);
    expect(componentOf('lookAtIK').props).toEqual({ boneName: 'Head', target: 'camera', maxAngle: 70, weight: 1, forwardAxis: '+z' });
    expect(componentOf('footIK').props).toEqual({ leftFoot: 'LeftFoot', rightFoot: 'RightFoot', maxStep: 0.5, weight: 1 });
    expect(definition('lookAtIK').props.find(prop => prop.key === 'target')?.options?.map(option => option.value)).toEqual(['camera', 'player']);
  });

  it('reads settings with defaults and clamped ranges', () => {
    expect(readLookAtIKSettings(componentOf('lookAtIK', { boneName: ' ', target: 'enemy', maxAngle: 500, weight: -1, forwardAxis: 'sideways' })))
      .toEqual({ boneName: 'Head', target: 'camera', maxAngle: Math.PI, weight: 0, forward: new THREE.Vector3(0, 0, 1) });
    expect(readLookAtIKSettings(componentOf('lookAtIK', { target: 'player', maxAngle: 30, forwardAxis: '-y' })))
      .toMatchObject({ target: 'player', maxAngle: THREE.MathUtils.degToRad(30), forward: new THREE.Vector3(0, -1, 0) });
    expect(readFootIKSettings(componentOf('footIK', { leftFoot: 'L_Foot', maxStep: 9, weight: 2 })))
      .toEqual({ leftFoot: 'L_Foot', rightFoot: 'RightFoot', maxStep: 2, weight: 1 });
  });

  it('does nothing in the editor', () => {
    const host = new THREE.Group();
    biped(host);
    mount('lookAtIK', host, {}, 'editor');
    mount('footIK', host, {}, 'editor');
    expect(frameLoop.callbacks.size).toBe(0);
  });

  it('lookAtIK turns the host\'s own head towards the camera and lets go on unmount', () => {
    const host = new THREE.Group();
    host.userData = { levelObjectId: 'npc' };
    // A nested object's head comes first in the hierarchy but belongs to that object.
    const nested = new THREE.Group();
    nested.userData = { levelObjectId: 'hat' };
    const nestedHead = new THREE.Bone();
    nestedHead.name = 'Head';
    nested.add(nestedHead);
    host.add(nested);
    const { head } = biped(host);
    const camera = new THREE.PerspectiveCamera();
    camera.position.copy(world(head)).add(new THREE.Vector3(5, 0, 0));

    const view = mount('lookAtIK', host, { maxAngle: 60 });
    stepFrames(200, camera);

    expect(worldAxis(head, Z).angleTo(Z)).toBeCloseTo(THREE.MathUtils.degToRad(60), 3);
    expect(worldAxis(head, Z).x).toBeGreaterThan(0);
    expect(nestedHead.quaternion.toArray()).toEqual([0, 0, 0, 1]);

    view.unmount();
    expect(head.quaternion.toArray()).toEqual([0, 0, 0, 1]);
  });

  it('lookAtIK follows the player\'s head when a player is provided', () => {
    const host = new THREE.Group();
    const { head } = biped(host);
    const player = new THREE.Group();
    const playerHead = new THREE.Bone();
    playerHead.name = 'mixamorig:Head';
    playerHead.position.set(-4, 1.7, 2);
    player.add(playerHead);

    mount('lookAtIK', host, { target: 'player', maxAngle: 180 }, 'runtime', player);
    stepFrames(300);

    const toPlayer = world(playerHead).sub(world(head));
    expect(worldAxis(head, Z).angleTo(toPlayer)).toBeLessThan(1e-3);
  });

  it('footIK plants a foot on the ground physics reports, excluding the host\'s own colliders', () => {
    const host = placedHost();
    host.userData = { levelObjectId: 'npc' };
    const { left } = biped(host);
    const leftFoot = world(left.foot);
    const calls: RayCall[] = [];
    const floor = host.position.y;
    const raycast = ground(x => (Math.abs(x - leftFoot.x) < 0.05 ? floor + 0.25 : floor), calls);
    physicsStub.raycast = (...args: unknown[]) => raycast(...(args as Parameters<PhysicsQueries['raycast']>));

    mount('footIK', host);
    stepFrames(90);

    expect(world(left.foot).distanceTo(leftFoot.clone().setY(leftFoot.y + 0.25))).toBeLessThan(1e-3);
    expect(calls.every(call => call.options?.excludeObjectId === 'npc')).toBe(true);
  });
});
