import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { handGripPoint, reachWithHand, supportGripPoint } from '../../runtime/ik';
import { resolveWeapon } from '../../runtime/weapons';

/** A straight arm along +X from the origin: shoulder, elbow at 1, wrist at 2, palm bone at 2.2. */
const arm = () => {
  const root = new THREE.Group();
  const upper = new THREE.Bone();
  const fore = new THREE.Bone();
  const hand = new THREE.Bone();
  const middle = new THREE.Bone();
  middle.name = 'mixamorigLeftHandMiddle1';
  fore.position.set(1, 0, 0);
  hand.position.set(1, 0, 0);
  middle.position.set(0.2, 0, 0);
  // A slight bend at the elbow, down: the way the animation bends it.
  fore.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.2);
  root.add(upper); upper.add(fore); fore.add(hand); hand.add(middle);
  root.updateMatrixWorld(true);
  return { upper, fore, hand, middle };
};

describe('the support hand on a held weapon', () => {
  it('finds the support point on a weapon from its attachment on the gripping hand', () => {
    const hand = new THREE.Bone();
    hand.position.set(0, 1, 0);
    hand.updateMatrixWorld(true);
    const point = supportGripPoint(hand, { position: [1, 0, 0], rotation: [0, 0, 90], scale: [2, 2, 2], point: [1, 0, 0] }, new THREE.Vector3());
    // Mounted 1 along X, turned a quarter about Z and doubled: the weapon's +X runs along world +Y.
    expect(point.x).toBeCloseTo(1);
    expect(point.y).toBeCloseTo(3);
    expect(point.z).toBeCloseTo(0);
  });

  it('puts the palm on the point and keeps the hand turned as the animation had it', () => {
    const { upper, fore, hand, middle } = arm();
    const rotation = hand.getWorldQuaternion(new THREE.Quaternion());
    const target = new THREE.Vector3(1.2, 0.6, 0.3);
    reachWithHand(upper, fore, hand, target);
    const wrist = hand.getWorldPosition(new THREE.Vector3());
    const palm = wrist.clone().lerp(middle.getWorldPosition(new THREE.Vector3()), 0.5);
    expect(palm.distanceTo(target)).toBeLessThan(1e-3);
    expect(hand.getWorldQuaternion(new THREE.Quaternion()).angleTo(rotation)).toBeLessThan(1e-4);
  });

  it('turns the hand to the rotation it holds the weapon with, its grip still on the point', () => {
    const { upper, fore, hand } = arm();
    const target = new THREE.Vector3(1.2, 0.6, 0.3);
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 0.2, -0.6));
    reachWithHand(upper, fore, hand, target, 1, rotation);
    expect(hand.getWorldQuaternion(new THREE.Quaternion()).angleTo(rotation)).toBeLessThan(1e-4);
    expect(handGripPoint(hand, new THREE.Vector3()).distanceTo(target)).toBeLessThan(1e-3);
  });

  it('leaves the arm alone at no weight', () => {
    const { upper, fore, hand } = arm();
    const before = hand.getWorldPosition(new THREE.Vector3());
    reachWithHand(upper, fore, hand, new THREE.Vector3(0.5, 1, 0), 0);
    expect(hand.getWorldPosition(new THREE.Vector3()).distanceTo(before)).toBeLessThan(1e-9);
  });

  it('holds a grip in the hollow its curled fingers close around', () => {
    // A hand at the origin; each finger's joints lie on a circle of radius 0.03 round (0.1, -0.03, z).
    const hand = new THREE.Bone();
    hand.name = 'mixamorigRightHand';
    const centre = (z: number) => new THREE.Vector3(0.1, -0.03, z);
    ['Middle', 'Ring', 'Pinky'].forEach((finger, index) => {
      const z = (index - 1) * 0.02;
      const angles = [Math.PI / 2, 0, -Math.PI / 2];
      let parent: THREE.Object3D = hand;
      let at = new THREE.Vector3();
      angles.forEach((angle, joint) => {
        const point = centre(z).add(new THREE.Vector3(Math.sin(angle) * 0.03 * 0 + Math.cos(angle) * 0.03, Math.sin(angle) * 0.03, 0));
        const bone = new THREE.Bone();
        bone.name = `mixamorigRightHand${finger}${joint + 1}`;
        bone.position.copy(point.clone().sub(at));
        parent.add(bone);
        parent = bone;
        at = point;
      });
    });
    hand.updateMatrixWorld(true);
    const grip = handGripPoint(hand, new THREE.Vector3());
    expect(grip.distanceTo(new THREE.Vector3(0.1, -0.03, 0))).toBeLessThan(1e-6);
  });

  it('holds at the palm when the fingers are straight', () => {
    const { hand } = arm();
    const grip = handGripPoint(hand, new THREE.Vector3());
    const wrist = hand.getWorldPosition(new THREE.Vector3());
    expect(grip.distanceTo(wrist)).toBeGreaterThan(0.05);
    expect(grip.distanceTo(wrist)).toBeLessThan(0.15);
  });

  it('keeps a support point only with three finite numbers', () => {
    expect(resolveWeapon({ id: 'r', name: 'Rifle', supportGrip: [-0.26, -0.06, 0.07] }).supportGrip).toEqual([-0.26, -0.06, 0.07]);
    expect(resolveWeapon({ id: 'r', name: 'Rifle', supportGrip: [1, Number.NaN, 0] as [number, number, number] }).supportGrip).toBeNull();
    expect(resolveWeapon({ id: 'r', name: 'Rifle' }).supportGrip).toBeNull();
  });
});
