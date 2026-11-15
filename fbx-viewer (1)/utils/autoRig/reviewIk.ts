import * as THREE from 'three';
import { solveTwoBoneIK } from '../../runtime/ik';
import type { Point } from './bodyMarkers';
import type { BodyKind } from './rigBody';
import type { ReviewBone } from './rigReview';

export type RigIkLimb = 'leftHand' | 'rightHand' | 'leftFoot' | 'rightFoot';
export type RigIkGoals = Partial<Record<RigIkLimb, Point>>;

export const rigIkOptions = (kind: BodyKind): { value: RigIkLimb; label: string }[] => [
  { value: 'leftHand', label: kind === 'person' ? 'Left hand' : 'Left front paw' },
  { value: 'rightHand', label: kind === 'person' ? 'Right hand' : 'Right front paw' },
  { value: 'leftFoot', label: kind === 'person' ? 'Left foot' : 'Left hind paw' },
  { value: 'rightFoot', label: kind === 'person' ? 'Right foot' : 'Right hind paw' },
];

interface IkChain {
  upper: ReviewBone;
  middle: ReviewBone;
  end: ReviewBone;
  contact: ReviewBone;
}

const findChain = (bones: readonly ReviewBone[], kind: BodyKind, limb: RigIkLimb): IkChain | null => {
  const side = limb.startsWith('left') ? 'Left' : 'Right';
  const arm = limb.endsWith('Hand');
  const find = (suffix: string) => bones.find(({ name }) => name === side + suffix);
  const upper = find(arm ? 'Arm' : 'UpLeg');
  const middle = find(arm ? 'ForeArm' : 'Leg');
  const end = find(arm ? 'Hand' : 'Foot');
  const contact = kind === 'person' ? end : find(arm ? 'HandMiddle1' : 'ToeBase');
  return upper && middle && end && contact ? { upper, middle, end, contact } : null;
};

export const rigIkRestGoal = (bones: readonly ReviewBone[], kind: BodyKind, limb: RigIkLimb): Point | null =>
  findChain(bones, kind, limb)?.contact.bindPosition ?? null;

/** Goals are expressed in model space, so they follow viewport placement and unit conversions.
 * Call on the bind pose. Only the two limb joints and the planted hand or foot rotate.
 */
export const solveRigReviewIk = (
  model: THREE.Object3D, bones: readonly ReviewBone[], kind: BodyKind, facing: [number, number],
  goals: RigIkGoals, strength: number,
): void => {
  if (!(strength > 0)) return;
  for (const { value: limb } of rigIkOptions(kind)) {
    const point = goals[limb];
    if (!point?.every(Number.isFinite)) continue;
    const chain = findChain(bones, kind, limb);
    if (!chain) continue;
    const { upper, middle, end, contact } = chain;
    const target = model.localToWorld(new THREE.Vector3(...point));
    const planted = contact.bone.getWorldPosition(new THREE.Vector3());
    if (planted.distanceToSquared(target) === 0) continue;

    // A paw extends beyond the wrist/hock. Keep that last segment's bind orientation
    // and solve for the ankle/wrist that puts the actual paw at the requested point.
    target.add(end.bone.getWorldPosition(new THREE.Vector3()).sub(planted));
    // Preserve the distal bone's orientation relative to the model. Composing local rotations
    // avoids the shear produced by decomposing a nonuniformly scaled preview root.
    const restTurn = rotationInModel(end.bone, model);

    const a = new THREE.Vector3(...upper.bindPosition);
    const b = new THREE.Vector3(...middle.bindPosition);
    const c = new THREE.Vector3(...end.bindPosition);
    const line = c.clone().sub(a).normalize();
    const bend = b.clone().sub(a);
    bend.addScaledVector(line, -bend.dot(line));
    const length = a.distanceTo(b) + b.distanceTo(c);
    if (bend.length() < 0.015 * length) {
      // Near-straight rest poses leave the bend plane ambiguous.
      const forward = limb.endsWith('Hand') ? -1 : 1;
      bend.set(forward * facing[0], 0, forward * facing[1]);
      bend.addScaledVector(line, -bend.dot(line));
      if (bend.lengthSq() < 1e-6) {
        bend.set(0, -1, 0);
        bend.addScaledVector(line, -bend.dot(line));
      }
    }
    const pole = model.localToWorld(b.add(bend.normalize().multiplyScalar(length)));
    solveTwoBoneIK(upper.bone, middle.bone, end.bone, target, pole, strength);
    const parentTurn = rotationInModel(end.bone.parent, model);
    end.bone.quaternion.copy(parentTurn.invert().multiply(restTurn)).normalize();
    end.bone.updateMatrixWorld(true);
  }
};

const rotationInModel = (bone: THREE.Object3D | null, model: THREE.Object3D): THREE.Quaternion => {
  const rotation = new THREE.Quaternion();
  for (let node = bone; node && node !== model; node = node.parent) rotation.premultiply(node.quaternion);
  return rotation;
};
