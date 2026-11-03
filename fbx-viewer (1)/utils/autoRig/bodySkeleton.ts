import { Matrix4, Quaternion, Vector3 } from 'three';
import type { BodyExtents, BodyMarkers, Point } from './bodyMarkers';
import type { FourLegExtents, FourLegMarkers } from './fourLegReading';
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
 * A line from `from` to `to`: as it was read if it was, bent to meet the two wherever they have been
 * moved to, and straight between them if it was not. A line of a few points is enough, and keeps the
 * small steps of the reading from showing.
 */
const lineBetween = (from: Point, to: Point, read?: readonly Point[]): Line => {
  if (!read || read.length < 2) return lineThrough([from, to]);
  const line = lineThrough(read);
  const first = read[0];
  const last = read[read.length - 1];
  const points: Point[] = [];
  const steps = 8;
  for (let step = 0; step <= steps; step += 1) {
    const share = step / steps;
    const point = line.at(line.length * share);
    points.push([
      point[0] + (from[0] - first[0]) * (1 - share) + (to[0] - last[0]) * share,
      point[1] + (from[1] - first[1]) * (1 - share) + (to[1] - last[1]) * share,
      point[2] + (from[2] - first[2]) * (1 - share) + (to[2] - last[2]) * share,
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
  const back = lineBetween(chin, groin, extents.spine);
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

/** Shares of the way along an animal's back and tail its joints are at. */
const FOUR_LEG_SHARES = {
  spine: [0.3, 0.6, 0.88],
  tail: [0.25, 0.5, 0.75],
  /** The shoulder blade's top: how much of the way from the shoulder joint to the back it reaches, how far out it stays, and how far behind the joint it lies, in the upper arm's length. */
  bladeUp: 0.72,
  bladeOut: 0.55,
  bladeBack: 0.45,
} as const;

/**
 * Joints, parents before children, for an animal with these markers, its head towards +Z and its left
 * at +X. Its back, neck and head are named as a person's, its hind legs as a person's legs and its front
 * legs as a person's arms down to the paw, so clips made on rigs like it, or on a rig that says which
 * of its legs are which, find their way to it. The tail is a chain of its own.
 */
export const fourLegSkeleton = (markers: FourLegMarkers, extents: FourLegExtents, withTail = true): RigJoint[] => {
  const joints: RigJoint[] = [];
  const add = (name: string, parent: number, position: Point, skins = true): number => {
    joints.push({ name, parent, position, rotation: [0, 0, 0, 1], skins });
    return joints.length - 1;
  };
  const backLineThrough = lineBetween(markers.hips, markers.neck, extents.back);
  const backAt = (share: number): Point => backLineThrough.at(backLineThrough.length * share);
  const hips = add('Hips', -1, markers.hips);
  const spine = add('Spine', hips, backAt(FOUR_LEG_SHARES.spine[0]));
  const spine1 = add('Spine1', spine, backAt(FOUR_LEG_SHARES.spine[1]));
  const spine2 = add('Spine2', spine1, backAt(FOUR_LEG_SHARES.spine[2]));
  const neckLine = lineBetween(markers.head, markers.neck, extents.neckLine);
  const neck = add('Neck', spine2, markers.neck);
  const neck1 = add('Neck1', neck, neckLine.at(neckLine.length / 2));
  const head = add('Head', neck1, markers.head);
  add('HeadTop_End', head, markers.nose, false);

  const frontLeg = (side: 'Left' | 'Right', shoulder: Point, elbow: Point, wrist: Point, paw: Point, toe: Point): void => {
    const upperArm = gapOf(shoulder, elbow);
    const blade: Point = [
      markers.hips[0] + (shoulder[0] - markers.hips[0]) * FOUR_LEG_SHARES.bladeOut,
      shoulder[1] + (joints[spine2].position[1] - shoulder[1]) * FOUR_LEG_SHARES.bladeUp,
      shoulder[2] - upperArm * FOUR_LEG_SHARES.bladeBack,
    ];
    const collar = add(`${side}Shoulder`, spine2, blade);
    const upper = add(`${side}Arm`, collar, shoulder);
    const lower = add(`${side}ForeArm`, upper, elbow);
    const hand = add(`${side}Hand`, lower, wrist);
    const toes = add(`${side}HandMiddle1`, hand, paw);
    add(`${side}HandTip_End`, toes, toe, false);
  };
  frontLeg('Left', markers.leftShoulder, markers.leftElbow, markers.leftWrist, markers.leftFrontPaw, extents.leftFrontToe);
  frontLeg('Right', markers.rightShoulder, markers.rightElbow, markers.rightWrist, markers.rightFrontPaw, extents.rightFrontToe);

  const hindLeg = (side: 'Left' | 'Right', hip: Point, knee: Point, hock: Point, paw: Point, toe: Point): void => {
    const upper = add(`${side}UpLeg`, hips, hip);
    const lower = add(`${side}Leg`, upper, knee);
    const foot = add(`${side}Foot`, lower, hock);
    const toes = add(`${side}ToeBase`, foot, paw);
    add(`${side}Toe_End`, toes, toe, false);
  };
  hindLeg('Left', markers.leftHip, markers.leftKnee, markers.leftHock, markers.leftHindPaw, extents.leftHindToe);
  hindLeg('Right', markers.rightHip, markers.rightKnee, markers.rightHock, markers.rightHindPaw, extents.rightHindToe);

  if (withTail && markers.tailBase && markers.tailTip) {
    const tailLine = lineBetween(markers.tailBase, markers.tailTip, extents.tailLine);
    let parent = add('Tail', hips, markers.tailBase);
    FOUR_LEG_SHARES.tail.forEach((share, at) => {
      parent = add(`Tail${at + 1}`, parent, tailLine.at(tailLine.length * share));
    });
    add('Tail_End', parent, markers.tailTip, false);
  }

  turnSideOnBones(joints);
  return joints;
};

const _y = new Vector3();
const _z = new Vector3();
const _x = new Vector3();
const _basis = new Matrix4();
const _turn = new Quaternion();

/**
 * Turns for a body side on, whose bones mostly lie in the plane down its middle: each joint's Y along
 * the bone to its first child, as a person's are, and its X across the body, which that plane leaves
 * free of any twist. A leg's X is the other way across, so its Z leans forward as a person's leg's does.
 */
const turnSideOnBones = (joints: RigJoint[]): void => {
  joints.forEach((joint, index) => {
    const child = joints.find((other, at) => at > index && other.parent === index);
    if (!child) {
      if (joint.parent >= 0) joint.rotation = [...joints[joint.parent].rotation];
      return;
    }
    _y.set(child.position[0] - joint.position[0], child.position[1] - joint.position[1], child.position[2] - joint.position[2]);
    if (_y.lengthSq() < 1e-12) _y.set(0, 1, 0);
    _y.normalize();
    const leg = /Arm|Hand|Leg|Foot|Toe/.test(joint.name);
    _x.set(leg ? -1 : 1, 0, 0).addScaledVector(_y, leg ? _y.x : -_y.x);
    // A bone running right across, as a sprawled leg's can, takes the way along the body instead.
    if (_x.lengthSq() < 0.01) _x.set(0, 0, 1).addScaledVector(_y, -_y.z);
    _x.normalize();
    _z.crossVectors(_x, _y);
    _turn.setFromRotationMatrix(_basis.makeBasis(_x, _y, _z));
    joint.rotation = [_turn.x, _turn.y, _turn.z, _turn.w];
  });
};

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
