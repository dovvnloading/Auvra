import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { handGripPoint, supportGripPoint } from '../../runtime/ik';
import { supportRotationFromClip, fitWeaponToHands } from '../../runtime/weaponFit';

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

  it('gives a weapon never fitted the turn of the other hand Fit would record, from its clip', () => {
    const { root, left, clip } = rig();
    left.quaternion.setFromEuler(new THREE.Euler(0.3, -0.5, 0.8));
    root.updateMatrixWorld(true);
    const points = { grip: [0.4, -0.1, 0] as [number, number, number], support: [-0.2, 0, 0] as [number, number, number] };
    const fit = fitWeaponToHands(root, clip, 'mixamorigRightHand', [1, 1, 1], points)!;
    const derived = supportRotationFromClip(root, clip, 'mixamorigRightHand', fit.rotation)!;
    const asQuaternion = (degrees: readonly number[]) => new THREE.Quaternion().setFromEuler(new THREE.Euler(...degrees.map(value => THREE.MathUtils.degToRad(value)) as [number, number, number]));
    expect(asQuaternion(derived).angleTo(asQuaternion(fit.supportRotation!))).toBeLessThan(1e-3);
    expect(supportRotationFromClip(root, clip, 'mixamorigNoSuchHand', fit.rotation)).toBeNull();
  });

  it('records how the other hand is turned on the weapon, to hold it that way in any clip', () => {
    const { root, right, left, clip } = rig();
    left.quaternion.setFromEuler(new THREE.Euler(0.3, -0.5, 0.8));
    root.updateMatrixWorld(true);
    const points = { grip: [0.4, -0.1, 0] as [number, number, number], support: [-0.2, 0, 0] as [number, number, number] };
    const fit = fitWeaponToHands(root, clip, 'mixamorigRightHand', [1, 1, 1], points)!;
    expect(fit.supportRotation).not.toBeNull();
    // Mounted as fitted, the recorded turn gives back the other hand's rotation in this pose.
    const rotation = new THREE.Quaternion();
    supportGripPoint(right, { position: fit.position, rotation: fit.rotation, scale: [1, 1, 1], point: points.support, handRotation: fit.supportRotation }, new THREE.Vector3(), rotation);
    expect(rotation.angleTo(left.getWorldQuaternion(new THREE.Quaternion()))).toBeLessThan(1e-3);
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

describe('seating a carried weapon on the body', () => {
  it('slides the weapon out from the bone until it rests just off the body under it', async () => {
    const { seatCarryOnBody } = await import('../../runtime/weaponFit');
    // A thigh: a bone pointing down, skinned to a cylinder of radius 0.1 round it, 0.8 long.
    const root = new THREE.Group();
    const thigh = new THREE.Bone();
    thigh.name = 'mixamorigRightUpLeg';
    thigh.position.set(0, 1, 0);
    const knee = new THREE.Bone();
    knee.name = 'mixamorigRightLeg';
    knee.position.set(0, -0.8, 0);
    // A part's copy of the thigh bone, first among its children, as Mixamo characters have.
    const copy = new THREE.Bone();
    copy.name = 'mixamorigRightUpLeg_1';
    thigh.add(copy);
    thigh.add(knee);
    root.add(thigh);
    const geometry = new THREE.CylinderGeometry(0.1, 0.1, 0.8, 24, 4, true);
    geometry.translate(0, 0.6, 0);
    const count = geometry.attributes.position.count;
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(count * 4).fill(0), 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Array(count).fill([1, 0, 0, 0]).flat(), 4));
    const body = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    root.add(body);
    root.updateMatrixWorld(true);
    body.bind(new THREE.Skeleton([thigh, knee]));
    // An arm hanging beside the thigh, outside it: under the weapon, but not part of the thigh.
    const arm = new THREE.Bone();
    arm.name = 'mixamorigRightArm';
    arm.position.set(0.25, 1.2, 0);
    root.add(arm);
    const armGeometry = new THREE.CylinderGeometry(0.03, 0.03, 0.6, 12, 2, true);
    armGeometry.translate(0.25, 0.8, 0);
    const armCount = armGeometry.attributes.position.count;
    armGeometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(armCount * 4).fill(0), 4));
    armGeometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Array(armCount).fill([1, 0, 0, 0]).flat(), 4));
    const armMesh = new THREE.SkinnedMesh(armGeometry, new THREE.MeshBasicMaterial());
    root.add(armMesh);
    root.updateMatrixWorld(true);
    armMesh.bind(new THREE.Skeleton([arm]));
    // A weapon: a 0.04-thick box, carried 0.3 out to the side (+X) of the thigh, halfway down.
    const weapon = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.2, 0.1), new THREE.MeshBasicMaterial());
    const seated = seatCarryOnBody(root, null, weapon, [1, 1, 1], { boneName: 'mixamorigRightUpLeg', position: [0.3, -0.4, 0], rotation: [0, 0, 0] })!;
    expect(seated).not.toBeNull();
    // Its inner side (x - 0.02) rests on the surface at 0.1, plus a gap well under a centimetre.
    const inner = seated[0] - 0.02;
    expect(inner).toBeGreaterThan(0.1);
    expect(inner).toBeLessThan(0.1 + 0.01);
    expect(seated[1]).toBeCloseTo(-0.4, 6);
    expect(seated[2]).toBeCloseTo(0, 6);
  });
});
