import { Matrix4, Quaternion, Vector3 } from 'three';
import type { BodyExtents, BodyMarkers, Point } from './bodyMarkers';
import type { FingerReading } from './handReading';

/**
 * The skeleton a rigged body gets, fitted to its markers. Its bones are named as most character rigs
 * name them, so clips from other rigs find their way to it, placed where rigs made by people and by
 * rigging tools place them, and turned as they turn them: each bone's Y runs along it to the next,
 * so things hung on a bone and turns made to it mean the same as on those rigs.
 */

export interface RigJoint {
  name: string;
  /** Index in the list of the joint above it, or -1. */
  parent: number;
  position: Point;
  /** The joint's turn in the same space as its position, as x, y, z, w. */
  rotation: [number, number, number, number];
  /** Whether the mesh moves with it: the last joint of a chain only marks where its parent ends. */
  skins: boolean;
  /** For a finger's joint, the hand it belongs to: the hand's weights are shared out among them on a finer grid. */
  handOf?: number;
}

/** Shares of the body's height. */
const PROPORTION = {
  /** The hips above the crotch, and the top of the thighs. */
  hipsAboveGroin: 0.09,
  thighAboveGroin: 0.05,
  /** How much of the way from the middle of the body to a knee the top of the thigh is. */
  thighAcross: 0.75,
  /** How far the spine's three joints are from the hips to the neck. */
  spineAlongBack: [0.19, 0.41, 0.66],
  /** The neck below the chin, and the head above it. */
  neckBelowChin: 0.04,
  headAboveChin: 0.01,
  /** The collarbone starts this far from the middle of the body. */
  collarAcross: 0.025,
  /** The ball of the foot: its height, and how far from ankle to toe tip it is. */
  ballHeight: 0.012,
  ballAlongFoot: 0.62,
} as const;

/** Which way a bone's Z leans, by how it hangs from the body: arms down, feet up, the rest forward. */
const DOWN = new Vector3(0, -1, 0);
const UP = new Vector3(0, 1, 0);
const FORWARD = new Vector3(0, 0, 1);
const zHint = (name: string): Vector3 => {
  if (/Shoulder|Arm|Hand/.test(name)) return DOWN;
  if (/Foot|Toe/.test(name)) return UP;
  return FORWARD;
};

const along = (a: Point, b: Point, share: number): Point => [a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share, a[2] + (b[2] - a[2]) * share];

const gapOf = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** A line through some points: the place a distance along it, carrying on the way it goes past either end. */
export interface Line {
  length: number;
  at: (distance: number) => Point;
}

export const lineThrough = (points: readonly Point[]): Line => {
  const lengths = [0];
  for (let i = 1; i < points.length; i += 1) lengths.push(lengths[i - 1] + gapOf(points[i], points[i - 1]));
  const length = lengths[lengths.length - 1];
  return {
    length,
    at: (distance) => {
      for (let i = 1; i < points.length; i += 1) {
        if (distance <= lengths[i] || i === points.length - 1) {
          const span = lengths[i] - lengths[i - 1];
          return along(points[i - 1], points[i], span > 0 ? (distance - lengths[i - 1]) / span : 0);
        }
      }
      return points[0];
    },
  };
};

/**
 * The middle of the back from `chin` down to `groin`: as it was read if it was, bent to meet the two
 * wherever they have been moved to, and straight between them if it was not. A line of a few points
 * is enough, and keeps the small steps of the reading from showing.
 */
const backLine = (chin: Point, groin: Point, read?: readonly Point[]): Line => {
  if (!read || read.length < 2) return lineThrough([chin, groin]);
  const line = lineThrough(read);
  const first = read[0];
  const last = read[read.length - 1];
  const points: Point[] = [];
  const steps = 8;
  for (let step = 0; step <= steps; step += 1) {
    const share = step / steps;
    const point = line.at(line.length * share);
    points.push([
      point[0] + (chin[0] - first[0]) * (1 - share) + (groin[0] - last[0]) * share,
      point[1] + (chin[1] - first[1]) * (1 - share) + (groin[1] - last[1]) * share,
      point[2] + (chin[2] - first[2]) * (1 - share) + (groin[2] - last[2]) * share,
    ]);
  }
  return lineThrough(points);
};

/**
 * Joints, parents before children, for a body with these markers, standing facing +Z with its left
 * at +X. A chain's first child is the next bone along it. Hands without `fingers` are one bone.
 */
export const bodySkeleton = (markers: BodyMarkers, extents: BodyExtents, fingers: { left?: readonly FingerReading[] | null; right?: readonly FingerReading[] | null } = {}): RigJoint[] => {
  const height = extents.headTop[1] - extents.floor;
  const joints: RigJoint[] = [];
  const add = (name: string, parent: number, position: Point, skins = true): number => {
    joints.push({ name, parent, position, rotation: [0, 0, 0, 1], skins });
    return joints.length - 1;
  };
  const { groin, chin } = markers;
  // From the neck down the back to the hips.
  const back = backLine(chin, groin, extents.spine);
  const neckFrom = height * PROPORTION.neckBelowChin;
  const hipsFrom = back.length - height * PROPORTION.hipsAboveGroin;
  const neckAt = back.at(neckFrom);
  const hipsAt = back.at(hipsFrom);
  const backAt = (share: number): Point => back.at(hipsFrom + (neckFrom - hipsFrom) * share);

  const hips = add('Hips', -1, hipsAt);
  const spine = add('Spine', hips, backAt(PROPORTION.spineAlongBack[0]));
  const spine1 = add('Spine1', spine, backAt(PROPORTION.spineAlongBack[1]));
  const spine2 = add('Spine2', spine1, backAt(PROPORTION.spineAlongBack[2]));
  const neck = add('Neck', spine2, neckAt);
  const head = add('Head', neck, along(chin, extents.headTop, height * PROPORTION.headAboveChin / Math.max(1e-6, gapOf(chin, extents.headTop))));
  add('HeadTop_End', head, [chin[0], extents.headTop[1], extents.headTop[2]], false);

  const arm = (side: 'Left' | 'Right', shoulder: Point, elbow: Point, wrist: Point, tip: Point, sideFingers?: readonly FingerReading[] | null): void => {
    const sign = side === 'Left' ? 1 : -1;
    const collar = add(`${side}Shoulder`, spine2, [chin[0] + sign * height * PROPORTION.collarAcross, shoulder[1], (shoulder[2] + neckAt[2]) / 2]);
    const upper = add(`${side}Arm`, collar, shoulder);
    const lower = add(`${side}ForeArm`, upper, elbow);
    const hand = add(`${side}Hand`, lower, wrist);
    add(`${side}HandTip_End`, hand, tip, false);
    for (const finger of sideFingers ?? []) {
      let parent = hand;
      finger.joints.forEach((place, joint) => {
        parent = add(`${side}Hand${finger.name}${joint + 1}`, parent, place, joint < 3);
        joints[parent].handOf = hand;
      });
    }
  };
  arm('Left', markers.leftShoulder, markers.leftElbow, markers.leftWrist, extents.leftHandTip, fingers.left);
  arm('Right', markers.rightShoulder, markers.rightElbow, markers.rightWrist, extents.rightHandTip, fingers.right);

  const leg = (side: 'Left' | 'Right', knee: Point, ankle: Point, toe: Point): void => {
    const thigh: Point = [groin[0] + (knee[0] - groin[0]) * PROPORTION.thighAcross, groin[1] + height * PROPORTION.thighAboveGroin, groin[2]];
    const upper = add(`${side}UpLeg`, hips, thigh);
    const lower = add(`${side}Leg`, upper, knee);
    const foot = add(`${side}Foot`, lower, ankle);
    const ball = along(ankle, toe, PROPORTION.ballAlongFoot);
    const toes = add(`${side}ToeBase`, foot, [ball[0], extents.floor + height * PROPORTION.ballHeight, ball[2]]);
    add(`${side}Toe_End`, toes, [toe[0], extents.floor + height * PROPORTION.ballHeight, toe[2]], false);
  };
  leg('Left', markers.leftKnee, markers.leftAnkle, extents.leftToe);
  leg('Right', markers.rightKnee, markers.rightAnkle, extents.rightToe);

  turnBones(joints);
  return joints;
};

const _y = new Vector3();
const _z = new Vector3();
const _x = new Vector3();
const _basis = new Matrix4();
const _turn = new Quaternion();

/** Gives each joint its turn: Y along the bone to its first child, Z leaning its bone's way. An end joint turns as its parent does. */
const turnBones = (joints: RigJoint[]): void => {
  joints.forEach((joint, index) => {
    const child = joints.find((other, at) => at > index && other.parent === index);
    if (!child) {
      if (joint.parent >= 0) joint.rotation = [...joints[joint.parent].rotation];
      return;
    }
    _y.set(child.position[0] - joint.position[0], child.position[1] - joint.position[1], child.position[2] - joint.position[2]);
    if (_y.lengthSq() < 1e-12) _y.set(0, 1, 0);
    _y.normalize();
    _z.copy(zHint(joint.name)).addScaledVector(_y, -zHint(joint.name).dot(_y));
    // A bone running the way its Z leans takes the next best lean.
    if (_z.lengthSq() < 1e-6) _z.copy(FORWARD).addScaledVector(_y, -_y.z);
    if (_z.lengthSq() < 1e-6) _z.copy(UP).addScaledVector(_y, -_y.y);
    _z.normalize();
    _x.crossVectors(_y, _z);
    _turn.setFromRotationMatrix(_basis.makeBasis(_x, _y, _z));
    joint.rotation = [_turn.x, _turn.y, _turn.z, _turn.w];
  });
};

/** The same joints in another space, turned about Y by the angle with this sine and cosine. */
export const turnJointsAboutY = (joints: readonly RigJoint[], sin: number, cos: number): RigJoint[] => {
  // The half angle's quaternion, from the whole angle's sine and cosine.
  const halfCos = Math.sqrt(Math.max(0, (1 + cos) / 2));
  const halfSin = sin >= 0 ? Math.sqrt(Math.max(0, (1 - cos) / 2)) : -Math.sqrt(Math.max(0, (1 - cos) / 2));
  const turn = new Quaternion(0, halfSin, 0, halfCos);
  return joints.map((joint) => {
    const [x, y, z] = joint.position;
    const rotation = new Quaternion(...joint.rotation).premultiply(turn);
    return {
      ...joint,
      position: [x * cos + z * sin, y, z * cos - x * sin] as Point,
      rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
    };
  });
};
