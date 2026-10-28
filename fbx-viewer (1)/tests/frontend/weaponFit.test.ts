import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { handGripPoint } from '../../runtime/ik';
import { fitWeaponToHands } from '../../runtime/weaponFit';

/** A hand bone with middle, ring and little fingers curled round a hollow 3 cm in front of its palm. */
const curledHand = (name: string, parent: THREE.Object3D, position: THREE.Vector3) => {
  const hand = new THREE.Bone();
  hand.name = name;
  hand.position.copy(position);
  parent.add(hand);
  ['Middle', 'Ring', 'Pinky'].forEach((finger, index) => {
    const z = (index - 1) * 0.02;
    let previous: THREE.Object3D = hand;
    let at = new THREE.Vector3();
    [Math.PI / 2, 0, -Math.PI / 2].forEach((angle, joint) => {
      const point = new THREE.Vector3(0.08 + Math.cos(angle) * 0.03, -0.03 + Math.sin(angle) * 0.03, z);
      const bone = new THREE.Bone();
      bone.name = `${name}${finger}${joint + 1}`;
      bone.position.copy(point.clone().sub(at));
      previous.add(bone);
      previous = bone;
      at = point;
    });
  });
  return hand;
};

const rig = () => {
  const root = new THREE.Group();
  const hips = new THREE.Bone();
  hips.name = 'mixamorigHips';
  hips.position.set(0, 1, 0);
  root.add(hips);
  const right = curledHand('mixamorigRightHand', hips, new THREE.Vector3(-0.1, 0.2, 0.3));
  const left = curledHand('mixamorigLeftHand', hips, new THREE.Vector3(0.1, 0.25, 0.6));
  root.updateMatrixWorld(true);
  const clip = new THREE.AnimationClip('Hold', 1, [new THREE.VectorKeyframeTrack('mixamorigHips.position', [0, 1], [0, 1, 0, 0, 1, 0])]);
  return { root, right, left, clip };
};

describe('fitting a weapon to the hands', () => {
  it('puts its grip in the gripping hand\'s grip and runs it through the other hand\'s', () => {
    const { root, right, left, clip } = rig();
    const points = { grip: [0.4, -0.1, 0] as [number, number, number], support: [-0.2, 0, 0] as [number, number, number] };
    const fit = fitWeaponToHands(root, clip, 'mixamorigRightHand', [1, 1, 1], points)!;
    expect(fit).not.toBeNull();
    // Mount a stand-in weapon as fitted and read its points back in the world.
    const weapon = new THREE.Object3D();
    weapon.position.set(...fit.position);
    weapon.rotation.set(...(fit.rotation.map(THREE.MathUtils.degToRad) as [number, number, number]));
    right.add(weapon);
    root.updateMatrixWorld(true);
    const grip = weapon.localToWorld(new THREE.Vector3(...points.grip));
    const support = weapon.localToWorld(new THREE.Vector3(...points.support));
    const rightGrip = handGripPoint(right, new THREE.Vector3());
    const leftGrip = handGripPoint(left, new THREE.Vector3());
    expect(grip.distanceTo(rightGrip)).toBeLessThan(1e-3);
    // The barrel line from the grip through the support point heads straight at the other hand.
    const barrel = support.clone().sub(grip).normalize();
    expect(barrel.angleTo(leftGrip.clone().sub(rightGrip))).toBeLessThan(1e-3);
    // Upright: the weapon's up stays as near world up as the barrel allows.
    const up = new THREE.Vector3(0, 1, 0).transformDirection(weapon.matrixWorld);
    expect(up.y).toBeGreaterThan(0.9);
  });

  it('points a one-handed weapon\'s muzzle the way the character faces', () => {
    const { root, right, clip } = rig();
    const points = { grip: [0, -0.1, 0] as [number, number, number], muzzle: [0, 0, 0.3] as [number, number, number] };
    const fit = fitWeaponToHands(root, clip, 'mixamorigRightHand', [1, 1, 1], points)!;
    const weapon = new THREE.Object3D();
    weapon.position.set(...fit.position);
    weapon.rotation.set(...(fit.rotation.map(THREE.MathUtils.degToRad) as [number, number, number]));
    right.add(weapon);
    root.updateMatrixWorld(true);
    const barrel = weapon.localToWorld(new THREE.Vector3(...points.muzzle)).sub(weapon.localToWorld(new THREE.Vector3(...points.grip)));
    expect(barrel.normalize().angleTo(new THREE.Vector3(0, 0, 1))).toBeLessThan(1e-3);
  });

  it('gives nothing without a hand or a barrel line', () => {
    const { root, clip } = rig();
    expect(fitWeaponToHands(root, clip, 'mixamorigTail', [1, 1, 1], { grip: [0, 0, 0], muzzle: [0, 0, 1] })).toBeNull();
    expect(fitWeaponToHands(root, clip, 'mixamorigRightHand', [1, 1, 1], { grip: [0, 0, 0] })).toBeNull();
  });
});
