import * as THREE from 'three';
import type { BodyKind } from './rigBody';
import type { RigJoint } from './bodySkeleton';
import type { PartWeights, SkinnedPart } from './skinWeights';

export type RigPose = 'rest' | 'flex' | 'stride' | 'twist' | 'joint' | 'ik';

export interface RigReviewStats {
  joints: number;
  vertices: number;
  primitives: number;
  maxInfluences: number;
  boneNames: string[];
}

/** Checks the worker output before it becomes a skinned glTF or reaches the GPU. */
export const inspectRig = (
  joints: readonly RigJoint[], parts: readonly SkinnedPart[], weights: readonly PartWeights[], limit: number,
): RigReviewStats => {
  if (!joints.length || joints.length > 65536 || !parts.length || weights.length !== parts.length) {
    throw new Error('The bind did not produce a complete skeleton and skin.');
  }
  for (const [index, joint] of joints.entries()) {
    if (!Number.isInteger(joint.parent) || (index === 0 ? joint.parent !== -1 : joint.parent < 0 || joint.parent >= index)) {
      throw new Error(`The joint hierarchy is incomplete at ${joint.name}.`);
    }
    const length = Math.hypot(...joint.rotation);
    if (!joint.position.every(Number.isFinite) || !Number.isFinite(length) || Math.abs(length - 1) > 0.001) {
      throw new Error(`The bind transform of ${joint.name} is invalid. Check its guides and bind again.`);
    }
  }

  let vertices = 0;
  let maxInfluences = 0;
  for (const [partIndex, part] of parts.entries()) {
    const count = part.positions.length / 3;
    const skin = weights[partIndex];
    if (!Number.isInteger(count) || !count || skin.joints.length !== count * 4 || skin.weights.length !== count * 4) {
      throw new Error(`Mesh part ${partIndex + 1} has incomplete skin data.`);
    }
    for (let vertex = 0; vertex < count; vertex += 1) {
      let sum = 0;
      let influences = 0;
      for (let slot = vertex * 4; slot < vertex * 4 + 4; slot += 1) {
        const weight = skin.weights[slot];
        if (!Number.isFinite(weight) || weight < 0 || skin.joints[slot] >= joints.length) {
          throw new Error(`Mesh part ${partIndex + 1} has an invalid skin weight at vertex ${vertex + 1}.`);
        }
        if (weight > 0) influences += 1;
        sum += weight;
      }
      if (Math.abs(sum - 1) > 0.0001 || influences > limit) {
        throw new Error(`Skin weights at vertex ${vertex + 1} of part ${partIndex + 1} exceed the binding limits or do not add up to one.`);
      }
      maxInfluences = Math.max(maxInfluences, influences);
    }
    vertices += count;
  }
  return { joints: joints.length, primitives: parts.length, vertices, maxInfluences, boneNames: joints.map(joint => joint.name) };
};

export interface ReviewBone {
  bindPosition: RigJoint['position'];
  bone: THREE.Bone;
  name: string;
  rest: THREE.Quaternion;
}

/** The loaded GLB orders its skin joints as written even if a colliding node name was renamed on load. */
export const reviewBones = (root: THREE.Object3D, joints: readonly RigJoint[]): ReviewBone[] => {
  const result = new Map<THREE.Bone, ReviewBone>();
  root.traverse(node => {
    const mesh = node as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    if (mesh.skeleton.bones.length !== joints.length) throw new Error('The exported skin is missing joints.');
    mesh.frustumCulled = false; // The rest bounding sphere may exclude a posed extremity.
    mesh.skeleton.bones.forEach((bone, index) => {
      if (!result.has(bone)) result.set(bone, { bone, name: joints[index].name, bindPosition: joints[index].position, rest: bone.quaternion.clone() });
    });
  });
  if (!result.size) throw new Error('The exported model contains no bound mesh.');
  return [...result.values()];
};

type Axes = readonly [number, number, number];
type PoseAngles = Readonly<Record<string, Axes>>;
const PERSON_FLEX: PoseAngles = {
  LeftArm: [28, 0, 0], RightArm: [28, 0, 0], LeftForeArm: [0, 0, 75], RightForeArm: [0, 0, -75],
  LeftUpLeg: [20, 0, 0], RightUpLeg: [20, 0, 0], LeftLeg: [-35, 0, 0], RightLeg: [-35, 0, 0],
};
const ANIMAL_FLEX: PoseAngles = {
  LeftArm: [30, 0, 0], RightArm: [30, 0, 0], LeftForeArm: [-55, 0, 0], RightForeArm: [-55, 0, 0],
  LeftUpLeg: [30, 0, 0], RightUpLeg: [30, 0, 0], LeftLeg: [-50, 0, 0], RightLeg: [-50, 0, 0],
};
const PERSON_STRIDE: PoseAngles = {
  LeftArm: [45, 0, -22], RightArm: [45, 0, -22], LeftForeArm: [0, 0, 25], RightForeArm: [0, 0, -55],
  LeftUpLeg: [38, 0, 0], RightUpLeg: [-25, 0, 0], LeftLeg: [-20, 0, 0], RightLeg: [-46, 0, 0],
};
const ANIMAL_STRIDE: PoseAngles = {
  LeftArm: [38, 0, 0], RightArm: [-24, 0, 0], LeftForeArm: [-18, 0, 0], RightForeArm: [-40, 0, 0],
  RightUpLeg: [38, 0, 0], LeftUpLeg: [-24, 0, 0], RightLeg: [-18, 0, 0], LeftLeg: [-40, 0, 0],
};
const TWIST: PoseAngles = {
  Spine: [0, 10, 0], Spine1: [0, 14, 0], Spine2: [0, 14, 0], Neck: [0, -12, 0], Head: [0, -15, 0],
  Tail: [0, 0, 12], Tail1: [0, 0, 18], Tail2: [0, 0, 18],
};

/** Always starts from bind rotations, including when scrubbing backwards or jumping between poses. */
export const poseRigReview = (
  bones: readonly ReviewBone[], kind: BodyKind, pose: RigPose, strength: number,
  joint?: { name: string; axis: 'x' | 'y' | 'z'; angle: number },
): void => {
  const angles: PoseAngles = pose === 'rest' || pose === 'joint' || pose === 'ik' ? {} : pose === 'twist' ? TWIST : pose === 'flex'
    ? (kind === 'person' ? PERSON_FLEX : ANIMAL_FLEX)
    : (kind === 'person' ? PERSON_STRIDE : ANIMAL_STRIDE);
  const radians = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(strength, 0, 1));
  const rotation = new THREE.Euler();
  const offset = new THREE.Quaternion();
  for (const { bone, name, rest } of bones) {
    bone.quaternion.copy(rest);
    if (pose === 'joint' && joint?.name === name) {
      rotation.set(0, 0, 0);
      rotation[joint.axis] = joint.angle * radians;
      bone.quaternion.multiply(offset.setFromEuler(rotation));
      continue;
    }
    const bend = angles[name];
    if (bend) bone.quaternion.multiply(offset.setFromEuler(rotation.set(bend[0] * radians, bend[1] * radians, bend[2] * radians)));
  }
};
