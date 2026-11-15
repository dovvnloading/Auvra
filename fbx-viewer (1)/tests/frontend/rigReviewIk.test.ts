import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bodySkeleton, fourLegSkeleton, type RigJoint } from '../../utils/autoRig/bodySkeleton';
import type { Point } from '../../utils/autoRig/bodyMarkers';
import { standardFourLegReading, standardReading, type BodyKind } from '../../utils/autoRig/rigBody';
import { poseRigReview, type ReviewBone } from '../../utils/autoRig/rigReview';
import { rigIkOptions, rigIkRestGoal, solveRigReviewIk } from '../../utils/autoRig/reviewIk';

const bounds = new Float32Array([-1, 0, -0.5, 1, 0, 0.5, 0, 2, 0]);

const rig = (kind: BodyKind) => {
  const model = new THREE.Group();
  const reading = kind === 'person' ? standardReading(bounds)! : standardFourLegReading(bounds, [0, 1])!;
  const joints: RigJoint[] = reading.kind === 'person' ? bodySkeleton(reading.markers, reading.extents) : fourLegSkeleton(reading.markers, reading.extents);
  const bones: ReviewBone[] = [];
  for (const joint of joints) {
    const bone = new THREE.Bone();
    bone.name = joint.name;
    bone.position.fromArray(joint.position);
    bone.quaternion.fromArray(joint.rotation);
    if (joint.parent >= 0) {
      const parent = joints[joint.parent];
      const inverse = new THREE.Quaternion(...parent.rotation).invert();
      bone.position.sub(new THREE.Vector3(...parent.position)).applyQuaternion(inverse);
      bone.quaternion.premultiply(inverse);
      bones[joint.parent].bone.add(bone);
    } else model.add(bone);
    bones.push({ name: joint.name, bone, rest: bone.quaternion.clone(), bindPosition: joint.position });
  }
  model.updateMatrixWorld(true);
  const place = (name: string) => model.getObjectByName(name)!.getWorldPosition(new THREE.Vector3());
  const axes = (name: string) => model.getObjectByName(name)!.getWorldQuaternion(new THREE.Quaternion());
  const local = (p: Point) => model.localToWorld(new THREE.Vector3(...p));
  return { model, bones, place, axes, local, facing: reading.facing };
};

describe('rig review limb goals', () => {
  it('plants two independent targets on a translated, rotated, scaled biped', () => {
    const { model, bones, place, axes, local, facing } = rig('person');
    model.position.set(11, -2, 4);
    model.rotation.set(0.2, 1.1, -0.1);
    model.scale.setScalar(1.7);
    model.updateMatrixWorld(true);
    const hand = rigIkRestGoal(bones, 'person', 'leftHand')!;
    const foot = rigIkRestGoal(bones, 'person', 'rightFoot')!;
    const handGoal: Point = [hand[0] - 0.13, hand[1] - 0.09, hand[2] + 0.055];
    const footGoal: Point = [foot[0], foot[1] + 0.15, foot[2] + 0.055];
    const handRotation = axes('LeftHand');
    const footRotation = axes('RightFoot');
    const other = place('RightHand');
    solveRigReviewIk(model, bones, 'person', facing, { leftHand: handGoal, rightFoot: footGoal }, 1);
    expect(place('LeftHand').distanceTo(local(handGoal))).toBeLessThan(1e-6);
    expect(place('RightFoot').distanceTo(local(footGoal))).toBeLessThan(1e-6);
    expect(axes('LeftHand').angleTo(handRotation)).toBeLessThan(1e-6);
    expect(axes('RightFoot').angleTo(footRotation)).toBeLessThan(1e-6);
    expect(place('RightHand').distanceTo(other)).toBeLessThan(1e-7);
  });

  it('extends to its reach limit and restores bind rotations exactly on Rest', () => {
    const { model, bones, place, facing } = rig('person');
    const shoulder = place('LeftArm');
    const elbow = place('LeftForeArm');
    const length = shoulder.distanceTo(elbow) + elbow.distanceTo(place('LeftHand'));
    const goal = shoulder.clone().add(new THREE.Vector3(0, 0, 100)).toArray() as Point;
    const before = bones.map(({ bone }) => bone.position.clone());
    solveRigReviewIk(model, bones, 'person', facing, { leftHand: goal }, 1);
    expect(place('LeftHand').distanceTo(shoulder)).toBeCloseTo(length, 6);
    expect(place('LeftHand').sub(shoulder).normalize().z).toBeCloseTo(1, 6);
    expect(bones.every(({ bone }, i) => bone.position.equals(before[i]))).toBe(true);
    poseRigReview(bones, 'person', 'rest', 1);
    expect(bones.every(({ bone, rest }) => bone.quaternion.equals(rest))).toBe(true);
    solveRigReviewIk(model, bones, 'person', facing, { leftHand: goal }, 0);
    expect(bones.every(({ bone, rest }) => bone.quaternion.equals(rest))).toBe(true);
  });

  it('targets the paw beyond a quadruped wrist or hock and preserves its contact orientation', () => {
    const { model, bones, place, axes, local, facing } = rig('fourLegs');
    model.scale.set(1.5, 0.8, 1.2);
    model.rotation.y = -0.55;
    model.updateMatrixWorld(true);
    const front = rigIkRestGoal(bones, 'fourLegs', 'rightHand')!;
    const hind = rigIkRestGoal(bones, 'fourLegs', 'leftFoot')!;
    const rightGoal: Point = [front[0], front[1] + 0.12, front[2] + 0.04];
    const leftGoal: Point = [hind[0], hind[1] + 0.1, hind[2] + 0.06];
    const frontTurn = axes('RightHandMiddle1');
    solveRigReviewIk(model, bones, 'fourLegs', facing, { rightHand: rightGoal, leftFoot: leftGoal }, 1);
    expect(place('RightHandMiddle1').distanceTo(local(rightGoal))).toBeLessThan(1e-5);
    expect(place('LeftToeBase').distanceTo(local(leftGoal))).toBeLessThan(1e-5);
    expect(Math.abs(axes('RightHandMiddle1').dot(frontTurn) - frontTurn.lengthSq())).toBeLessThan(1e-5);
    expect(rigIkOptions('fourLegs')).toContainEqual({ value: 'rightHand', label: 'Right front paw' });
  });

  it('ignores absent limbs and non-finite goals without changing the review', () => {
    const { model, bones, facing } = rig('person');
    solveRigReviewIk(model, bones, 'person', facing, { leftHand: [0, Infinity, 0] }, 1);
    solveRigReviewIk(model, [], 'person', facing, { leftHand: [1, 2, 3] }, 1);
    expect(rigIkRestGoal([], 'person', 'leftHand')).toBeNull();
    expect(bones.every(({ bone, rest }) => bone.quaternion.equals(rest))).toBe(true);
  });
});
