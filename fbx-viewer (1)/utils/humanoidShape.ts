import * as THREE from 'three';

/**
 * Finding the parts of a humanoid skeleton from its shape alone, for rigs whose bone names say
 * nothing ("Bone.012"). A skeleton at rest is read like a stick figure: the two lowest leaf bones far
 * apart are the feet, the highest is the head, the two furthest out to the sides are the hands, and
 * the places their paths from the root meet are the hips and chest. Works for T and A poses, in the
 * model's own units, facing either way along Z.
 */

interface Joint {
  bone: THREE.Object3D;
  parent: Joint | null;
  children: Joint[];
  position: THREE.Vector3;
}

/** Share of a figure's height a leaf must be within of the ground, to be a foot. */
const FOOT_ZONE = 0.3;
/** How far from the middle a leaf must reach, as a share of height, to be a hand. */
const HAND_REACH = 0.1;
/** Share of a figure's height an ankle is within of the ground. */
const ANKLE_ZONE = 0.14;
/** How close to the longest pair of bones along a limb another pair must be, to count as just as long. */
const NEAR_EQUAL = 0.8;
/** Past this share of a figure's height, the bone above a neck's place is the head itself, with its top above it: a neck is shorter. */
const LONGEST_NECK = 0.08;

const positionsOf = (bones: readonly THREE.Object3D[], root: THREE.Object3D): Joint[] => {
  root.updateMatrixWorld(true);
  const joints = new Map<THREE.Object3D, Joint>();
  for (const bone of bones) {
    joints.set(bone, { bone, parent: null, children: [], position: root.worldToLocal(bone.getWorldPosition(new THREE.Vector3())) });
  }
  for (const joint of joints.values()) {
    for (let up = joint.bone.parent; up; up = up.parent) {
      const parent = joints.get(up);
      if (parent) {
        joint.parent = parent;
        parent.children.push(joint);
        break;
      }
    }
  }
  return [...joints.values()];
};

const pathFromRoot = (joint: Joint): Joint[] => {
  const path: Joint[] = [];
  for (let at: Joint | null = joint; at; at = at.parent) path.unshift(at);
  return path;
};

/** The last joint two paths from the root share. */
const lastShared = (a: readonly Joint[], b: readonly Joint[]): Joint | null => {
  let shared: Joint | null = null;
  for (let i = 0; i < a.length && i < b.length && a[i] === b[i]; i += 1) shared = a[i];
  return shared;
};

const below = (path: readonly Joint[], joint: Joint): Joint[] => path.slice(path.indexOf(joint) + 1);

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'] as const;

/**
 * The humanoid role of each bone it can place, named as humanoidRole names them. Empty when the
 * skeleton does not read as a figure with a head, two arms and two legs.
 */
export const inferHumanoidRoles = (bones: readonly THREE.Object3D[], root: THREE.Object3D): Map<THREE.Object3D, string> => {
  const roles = new Map<THREE.Object3D, string>();
  const joints = positionsOf(bones, root);
  if (joints.length < 8) return roles;
  let bottom = Infinity;
  let top = -Infinity;
  for (const joint of joints) {
    bottom = Math.min(bottom, joint.position.y);
    top = Math.max(top, joint.position.y);
  }
  const height = top - bottom;
  if (!(height > 1e-6)) return roles;
  const leaves = joints.filter((joint) => joint.children.length === 0);

  // The feet: the leaves nearest the ground on each side, with the longest paths (a toe over a heel).
  const footOnSide = (sign: number): Joint | null => {
    let best: Joint | null = null;
    for (const leaf of leaves) {
      if (leaf.position.y > bottom + height * FOOT_ZONE || leaf.position.x * sign <= height * 0.01) continue;
      if (!best || pathFromRoot(leaf).length > pathFromRoot(best).length || (pathFromRoot(leaf).length === pathFromRoot(best).length && leaf.position.y < best.position.y)) best = leaf;
    }
    return best;
  };
  const footA = footOnSide(1);
  const footB = footOnSide(-1);
  if (!footA || !footB) return roles;

  // The head: the highest leaf near the middle.
  let headLeaf: Joint | null = null;
  for (const leaf of leaves) {
    if (Math.abs(leaf.position.x) > height * 0.08) continue;
    if (!headLeaf || leaf.position.y > headLeaf.position.y) headLeaf = leaf;
  }
  if (!headLeaf || headLeaf.position.y < bottom + height * 0.6) return roles;

  // The hands: the leaves furthest out on each side, above the feet.
  const handOnSide = (sign: number): Joint | null => {
    let best: Joint | null = null;
    for (const leaf of leaves) {
      if (leaf === footA || leaf === footB || leaf.position.y < bottom + height * FOOT_ZONE) continue;
      if (leaf.position.x * sign < height * HAND_REACH) continue;
      if (!best || leaf.position.x * sign > best.position.x * sign) best = leaf;
    }
    return best;
  };
  const handA = handOnSide(1);
  const handB = handOnSide(-1);
  if (!handA || !handB) return roles;

  const pathFootA = pathFromRoot(footA);
  const pathFootB = pathFromRoot(footB);
  const pathHead = pathFromRoot(headLeaf);
  const pathHandA = pathFromRoot(handA);
  const pathHandB = pathFromRoot(handB);
  const legsMeet = lastShared(pathFootA, pathFootB);
  if (!legsMeet) return roles;
  const hips = lastShared(pathHead, pathFromRoot(legsMeet));
  const chest = lastShared(pathHandA, pathHandB);
  if (!hips || !chest || !pathFromRoot(chest).includes(hips) || chest === hips) return roles;

  roles.set(hips.bone, 'Hips');
  for (const joint of below(pathFromRoot(chest), hips)) roles.set(joint.bone, 'Spine');

  // Neck and head, above the chest.
  const aboveChest = below(pathHead, chest);
  if (aboveChest.length === 1) {
    roles.set(aboveChest[0].bone, 'Head');
  } else if (aboveChest.length === 2) {
    // Chest, neck, head, or chest, head, the head's top.
    if (aboveChest[0].position.distanceTo(aboveChest[1].position) > height * LONGEST_NECK) {
      roles.set(aboveChest[0].bone, 'Head');
    } else {
      roles.set(aboveChest[0].bone, 'Neck');
      roles.set(aboveChest[1].bone, 'Head');
    }
  } else if (aboveChest.length > 2) {
    // The last bone is the head's top: the one before it is the head.
    roles.set(aboveChest[0].bone, 'Neck');
    roles.set(aboveChest[aboveChest.length - 2].bone, 'Head');
  }

  // Which way the figure faces, from where the toes point: its left is +X when it faces +Z.
  const toeReach = (path: readonly Joint[]): number => {
    const leg = below(path, hips);
    const ankleAt = leg.findIndex((joint) => joint.position.y <= bottom + height * ANKLE_ZONE);
    return ankleAt >= 0 ? leg[leg.length - 1].position.z - leg[ankleAt].position.z : 0;
  };
  const leftSign = toeReach(pathFootA) + toeReach(pathFootB) < -height * 0.005 ? -1 : 1;
  const sideOf = (joint: Joint): 'Left' | 'Right' => (joint.position.x * leftSign > 0 ? 'Left' : 'Right');

  /**
   * A limb's two long bones are the two longest in a row along it: they give its upper and lower
   * segments and the joint after them, whatever short bones (shoulders, twist bones, tips) surround them.
   */
  const longBones = (limb: readonly Joint[]): number => {
    const pairs: number[] = [];
    for (let at = 0; at + 2 < limb.length; at += 1) {
      // The shorter of the two decides: a long hand tip after a forearm is not a second long bone.
      pairs.push(Math.min(limb[at].position.distanceTo(limb[at + 1].position), limb[at + 1].position.distanceTo(limb[at + 2].position)));
    }
    const longest = Math.max(0, ...pairs);
    if (longest <= 0) return -1;
    // Among near equals the pair nearest the body wins: an end bone is often as long as its parent.
    return pairs.findIndex((length) => length >= longest * NEAR_EQUAL);
  };

  for (const path of [pathFootA, pathFootB]) {
    const side = sideOf(path[path.length - 1]);
    const leg = below(path, hips);
    const at = longBones(leg);
    if (at < 0) continue;
    roles.set(leg[at].bone, `${side}UpperLeg`);
    roles.set(leg[at + 1].bone, `${side}LowerLeg`);
    roles.set(leg[at + 2].bone, `${side}Foot`);
    // A toe bone, when there is more past the foot than its tip.
    const toe = leg[at + 3];
    if (toe && (toe.children.length || leg.length > at + 4)) roles.set(toe.bone, `${side}Toes`);
  }

  for (const path of [pathHandA, pathHandB]) {
    const side = sideOf(path[path.length - 1]);
    const arm = below(path, chest);
    const at = longBones(arm);
    if (at < 0) continue;
    const hand = arm[at + 2];
    roles.set(arm[at].bone, `${side}UpperArm`);
    roles.set(arm[at + 1].bone, `${side}LowerArm`);
    roles.set(hand.bone, `${side}Hand`);
    if (at > 0) roles.set(arm[at - 1].bone, `${side}Shoulder`);

    // Fingers, thumb first: at rest the thumb is furthest forward and the little finger furthest back.
    const forward = leftSign;
    const fingers = hand.children.filter((child) => child.children.length > 0).sort((a, b) => (b.position.z - a.position.z) * forward);
    fingers.slice(0, FINGERS.length).forEach((finger, index) => {
      let joint: Joint | undefined = finger;
      for (let segment = 1; segment <= 3 && joint; segment += 1) {
        // The fourth bone of a three-joint finger is only its tip.
        if (segment === 3 && !joint.children.length && roles.has(joint.parent!.bone) && finger.children[0]?.children.length) break;
        roles.set(joint.bone, `${side}${FINGERS[index]}${segment}`);
        joint = joint.children[0];
      }
    });
  }
  return roles;
};
