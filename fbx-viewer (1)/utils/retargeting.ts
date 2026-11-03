import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { inferHumanoidRoles } from './humanoidShape';

/**
 * Retargeting animation between humanoid skeletons that differ in bone names, bone axes, rest pose
 * (T or A) and units.
 *
 * Bones are matched by role (hips, spine chain, neck, head, clavicles, arms, hands, fingers, legs,
 * feet, toes) across the common naming schemes: Mixamo (mixamorig:LeftUpLeg), Unreal (thigh_l),
 * Blender Rigify (thigh.L, DEF-thigh.L), 3ds Max Biped (Bip01 L Thigh) and plain names (LeftThigh).
 * A rig whose names say nothing is read from its shape (see humanoidShape.ts), and a model can say
 * what any of its bones is. Each frame, the rotation a source bone has turned away from its rest
 * pose is applied to the matching target bone's rest pose, so rigs whose bones point along different
 * axes still move the same way. The hips' travel is scaled by the ratio of the rigs' hip heights.
 * Then each leg bends to put its foot where the source's foot is, scaled the same way, so feet stay
 * planted on a rig with other proportions. Keys are sampled at the clip's own rate, then those that
 * change nothing are dropped.
 */

type Side = 'Left' | 'Right' | '';

const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'] as const;

/** Splits a bone name into lower-case words, without rig prefixes or namespaces. */
const nameWords = (name: string): string[] => {
  const leaf = name.split(/[|:]/).pop() || name;
  return leaf
    .replace(/^(mixamorig\d*|armature|skeleton|def[-_]|org[-_]|mch[-_]|cc_base_|bip\d*|biped\d*)/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
};

const sideOf = (words: string[], name: string): Side => {
  if (words.includes('left') || words.includes('l') || /\.l(\.|$)|_l(_|$)|^l_/i.test(name)) return 'Left';
  if (words.includes('right') || words.includes('r') || /\.r(\.|$)|_r(_|$)|^r_/i.test(name)) return 'Right';
  if (words.some((word) => /^l(?=[a-z]{3,})/.test(word) && !word.startsWith('leg') && !word.startsWith('low'))) return 'Left';
  if (words.some((word) => /^r(?=[a-z]{3,})/.test(word) && !word.startsWith('ring'))) return 'Right';
  return '';
};

/** Limb names run together with a side at either end ("upperarml", "LUpperLeg", "FootL"), which word splitting cannot part. */
const GLUED_LIMB_ROLES: Record<string, string> = {
  upperarm: 'UpperArm', uparm: 'UpperArm', arm: 'UpperArm', lowerarm: 'LowerArm', forearm: 'LowerArm', loarm: 'LowerArm',
  hand: 'Hand', wrist: 'Hand', fist: 'Hand', palm: 'Hand', shoulder: 'Shoulder', clavicle: 'Shoulder', collar: 'Shoulder',
  upperleg: 'UpperLeg', upleg: 'UpperLeg', thigh: 'UpperLeg', lowerleg: 'LowerLeg', loleg: 'LowerLeg', calf: 'LowerLeg', shin: 'LowerLeg', leg: 'LowerLeg',
  foot: 'Foot', ankle: 'Foot', toe: 'Toes', toes: 'Toes', toebase: 'Toes', ball: 'Toes',
};
const GLUED_LIMBS = new RegExp(`^(left|right|l|r)?(${Object.keys(GLUED_LIMB_ROLES).sort((a, b) => b.length - a.length).join('|')})(left|right|l|r)?$`);

/** The parts of a leg as four-legged rigs name them, top to bottom, and what each is in a front leg and in a hind one. */
const ANIMAL_LEG_PARTS: readonly { part: RegExp; front: string; hind: string }[] = [
  { part: /^(upper|up|thigh|hip|humerus|femur)/, front: 'UpperArm', hind: 'UpperLeg' },
  { part: /^(lower|shin|calf|knee|elbow|radius|tibia|gaskin)/, front: 'LowerArm', hind: 'LowerLeg' },
  { part: /^(toe|digit|phalan|pastern|hoof)/, front: 'Middle1', hind: 'Toes' },
  { part: /^(foot|paw|hock|ankle|wrist|carpus|tarsus|cannon|hand)/, front: 'Hand', hind: 'Foot' },
];

/**
 * The role of a bone in a four-legged rig that says which end of the body a leg is at: front legs stand
 * where a person's arms do, and hind legs where a person's legs do. Null for any other bone.
 */
const animalLegRole = (words: readonly string[], side: Side): string | null => {
  if (!side) return null;
  // "FrontLeg" and "HindLegUpper" run the end and the limb together.
  const parts = words.flatMap((word) => word.match(/^(front|fore|hind|rear|back)(.+)$/)?.slice(1) ?? [word]);
  const front = parts.includes('front') || parts.includes('fore');
  const hind = parts.includes('hind') || parts.includes('rear') || parts.includes('back');
  // A person's forearm also starts with "fore", and it is an arm.
  if (front === hind || parts.includes('arm')) return null;
  const limb = ANIMAL_LEG_PARTS.find(({ part }) => parts.some((word) => part.test(word)));
  if (limb) return `${side}${front ? limb.front : limb.hind}`;
  return parts.some((word) => word.startsWith('leg')) ? `${side}${front ? 'UpperArm' : 'UpperLeg'}` : null;
};

/**
 * The humanoid role of a bone ('Hips', 'Spine', 'LeftUpperArm', 'RightIndex2', ...), or null for
 * bones with none (end bones, twist and helper bones, props).
 */
export const humanoidRole = (name: string): string | null => {
  const words = nameWords(name);
  const text = words.join(' ');
  if (!text || /\b(end|nub|twist|roll|helper|ik|pole|target|weapon|prop)\b|top_end|headtop/.test(text) || /end$/.test(words[words.length - 1] ?? '')) return null;
  const animalLeg = animalLegRole(words, sideOf(words, name));
  if (animalLeg) return animalLeg;
  const glued = GLUED_LIMBS.exec(words.join(''));
  if (glued) {
    const limb = GLUED_LIMB_ROLES[glued[2]];
    const gluedSide = glued[1] || glued[3];
    if (limb && gluedSide) return `${gluedSide.startsWith('l') ? 'Left' : 'Right'}${limb}`;
  }
  const side = sideOf(words, name);
  const finger = FINGERS.find((part) => words.some((word) => word.startsWith(part)));
  if (finger) {
    const digit = text.match(/(\d)(?!.*\d)/)?.[1];
    // A fourth joint is only the finger's tip, as Mixamo's are.
    if (digit && Number(digit) > 3) return null;
    const joint = digit ? Math.max(1, Number(digit)) : 1;
    return side ? `${side}${finger[0].toUpperCase()}${finger.slice(1)}${joint}` : null;
  }
  const has = (...parts: string[]) => parts.some((part) => words.some((word) => word === part || word.startsWith(part)));
  if (has('hips', 'hip', 'pelvis')) return side ? null : 'Hips';
  if (has('neck')) return 'Neck';
  if (has('head')) return 'Head';
  if (has('spine', 'chest', 'torso', 'back', 'abdomen', 'belly', 'waist')) return side ? null : 'Spine';
  if (!side) return null;
  if (has('clavicle', 'shoulder', 'collar')) return `${side}Shoulder`;
  // Mixamo's ForeArm and UpLeg split into two words ("fore arm", "up leg").
  if (has('forearm', 'lowerarm', 'elbow') || /\bfore arm\b/.test(text) || (has('lower') && has('arm'))) return `${side}LowerArm`;
  if (has('upperarm') || (has('upper') && has('arm')) || words.includes('arm')) return `${side}UpperArm`;
  if (has('hand', 'wrist', 'fist', 'palm')) return `${side}Hand`;
  if (has('upleg', 'thigh', 'upperleg') || /\bup leg\b/.test(text) || (has('upper') && has('leg'))) return `${side}UpperLeg`;
  if (has('calf', 'shin', 'lowerleg', 'knee') || (has('lower') && has('leg')) || words.includes('leg')) return `${side}LowerLeg`;
  if (has('foot', 'ankle')) return `${side}Foot`;
  if (has('toe', 'ball')) return `${side}Toes`;
  return null;
};

/** Roles a humanoid's arms, legs, spine and head fill: what it takes to read a rig as one. */
export const CORE_ROLES = [
  'Hips', 'Spine', 'Head', 'LeftUpperArm', 'LeftLowerArm', 'RightUpperArm', 'RightLowerArm',
  'LeftUpperLeg', 'LeftLowerLeg', 'RightUpperLeg', 'RightLowerLeg',
] as const;

/** A model's own say in what one of its bones is; an empty role says it is none. */
export interface StoredBoneRole {
  role: string;
  bone: string;
}

export type HumanoidRoles = ReadonlyMap<THREE.Object3D, string>;

/**
 * What each bone is for: from its name, then from the skeleton's shape for whatever the names leave
 * out of a humanoid, then as the model says. A role goes to one bone only, but for the spine's.
 */
export const humanoidRoles = (bones: readonly THREE.Object3D[], root: THREE.Object3D, stored?: readonly StoredBoneRole[]): Map<THREE.Object3D, string> => {
  const roles = new Map<THREE.Object3D, string>();
  for (const bone of bones) {
    const role = humanoidRole(bone.name);
    if (role) roles.set(bone, role);
  }
  const taken = new Set(roles.values());
  if (!CORE_ROLES.every((role) => taken.has(role))) {
    for (const [bone, role] of inferHumanoidRoles(bones, root)) {
      if (roles.has(bone) || (role !== 'Spine' && taken.has(role))) continue;
      roles.set(bone, role);
      taken.add(role);
    }
  }
  for (const { role, bone: name } of stored ?? []) {
    const bone = bones.find((candidate) => candidate.name === name);
    if (!bone) continue;
    if (role !== 'Spine') for (const [other, otherRole] of roles) if (otherRole === role) roles.delete(other);
    if (role) roles.set(bone, role);
    else roles.delete(bone);
  }
  return roles;
};

const depthOf = (node: THREE.Object3D, root: THREE.Object3D): number => {
  let depth = 0;
  for (let parent = node.parent; parent && parent !== root; parent = parent.parent) depth += 1;
  return depth;
};

/**
 * Pairs each target bone with the source bone in the same role. Bones with the same name (ignoring
 * rig prefixes and case) pair first. Spine chains of different lengths pair end to end, the middle
 * spread proportionally. Roles that are not unique in a skeleton are left unpaired.
 */
export const matchHumanoidBones = (
  targetBones: readonly THREE.Object3D[],
  sourceBones: readonly THREE.Object3D[],
  targetRoot: THREE.Object3D,
  sourceRoot: THREE.Object3D,
  targetBoneRoles: HumanoidRoles = humanoidRoles(targetBones, targetRoot),
  sourceBoneRoles: HumanoidRoles = humanoidRoles(sourceBones, sourceRoot),
): Map<THREE.Object3D, THREE.Object3D> => {
  const pairs = new Map<THREE.Object3D, THREE.Object3D>();
  const key = (name: string) => nameWords(name).join('');
  const sourceByKey = new Map<string, THREE.Object3D | null>();
  for (const bone of sourceBones) {
    const k = key(bone.name);
    sourceByKey.set(k, sourceByKey.has(k) ? null : bone);
  }
  const byRole = (bones: readonly THREE.Object3D[], boneRoles: HumanoidRoles) => {
    const map = new Map<string, THREE.Object3D[]>();
    for (const bone of bones) {
      const role = boneRoles.get(bone);
      if (role) map.set(role, [...(map.get(role) ?? []), bone]);
    }
    return map;
  };
  const targetRoles = byRole(targetBones, targetBoneRoles);
  const sourceRoles = byRole(sourceBones, sourceBoneRoles);
  const used = new Set<THREE.Object3D>();
  const pair = (target: THREE.Object3D, source: THREE.Object3D | undefined | null) => {
    if (!source || used.has(source) || pairs.has(target)) return;
    pairs.set(target, source);
    used.add(source);
  };

  // Same names pair first, unless the rig says the two are different things.
  for (const bone of targetBones) {
    const source = sourceByKey.get(key(bone.name));
    if (!source) continue;
    const role = targetBoneRoles.get(bone);
    const sourceRole = sourceBoneRoles.get(source);
    if (!role || !sourceRole || role === sourceRole) pair(bone, source);
  }

  const targetSpine = (targetRoles.get('Spine') ?? []).sort((a, b) => depthOf(a, targetRoot) - depthOf(b, targetRoot));
  const sourceSpine = (sourceRoles.get('Spine') ?? []).sort((a, b) => depthOf(a, sourceRoot) - depthOf(b, sourceRoot));
  targetSpine.forEach((bone, index) => {
    if (!sourceSpine.length) return;
    const at = targetSpine.length === 1 ? 0 : Math.round((index * (sourceSpine.length - 1)) / (targetSpine.length - 1));
    pair(bone, sourceSpine[at]);
  });
  for (const [role, targets] of targetRoles) {
    if (role === 'Spine' || targets.length !== 1) continue;
    const sources = sourceRoles.get(role);
    if (sources?.length === 1) pair(targets[0], sources[0]);
  }
  return pairs;
};

/** The nodes a clip animates in `root`, and their ancestors up to the root: the source skeleton. */
export const animatedSkeleton = (root: THREE.Object3D, clips: readonly THREE.AnimationClip[]): THREE.Object3D[] => {
  const found = new Set<THREE.Object3D>();
  root.traverse((node) => { if ((node as THREE.Bone).isBone) found.add(node); });
  for (const clip of clips) {
    for (const track of clip.tracks) {
      let nodeName: string;
      try {
        const parsed = THREE.PropertyBinding.parseTrackName(track.name);
        nodeName = parsed.objectName === 'bones' && parsed.objectIndex ? String(parsed.objectIndex) : parsed.nodeName;
      } catch {
        continue;
      }
      const node = (nodeName ? THREE.PropertyBinding.findNode(root, nodeName) : null) as THREE.Object3D | null;
      for (let at: THREE.Object3D | null = node; at && at !== root; at = at.parent) found.add(at);
    }
  }
  return [...found];
};

export interface RetargetRig {
  /** The model root; rotations and positions are measured relative to it. */
  root: THREE.Object3D;
  /** The bones that get tracks, posed at rest (the skinned mesh's bind pose for a target). */
  bones: readonly THREE.Object3D[];
}

const _q = new THREE.Quaternion();
const _rootQ = new THREE.Quaternion();
const _v = new THREE.Vector3();

const rootRelativeQuaternion = (node: THREE.Object3D, root: THREE.Object3D, out: THREE.Quaternion) => {
  root.getWorldQuaternion(_rootQ).invert();
  return node.getWorldQuaternion(out).premultiply(_rootQ);
};

const rootRelativePosition = (node: THREE.Object3D, root: THREE.Object3D, out: THREE.Vector3) =>
  root.worldToLocal(node.getWorldPosition(out));

/** Keys per second a clip is sampled at: its own rate, within these. */
const MIN_SAMPLE_RATE = 30;
const MAX_SAMPLE_RATE = 60;
/** Largest change to a quaternion component or a position, per unit of hip height, a dropped key may make. */
const KEY_TOLERANCE = 5e-5;

/** The rate a clip's keys run at: its densest track's. */
const clipSampleRate = (clip: THREE.AnimationClip): number => {
  let rate = 0;
  for (const track of clip.tracks) {
    if (track.times.length > 1) rate = Math.max(rate, (track.times.length - 1) / Math.max(1e-6, track.times[track.times.length - 1] - track.times[0]));
  }
  return Math.min(MAX_SAMPLE_RATE, Math.max(MIN_SAMPLE_RATE, Math.round(rate)));
};

/**
 * Drops keys a straight line between its neighbours stays within `tolerance` of: for each run of
 * keys, the longest stretch that holds is taken, from the last key kept. Both ends stay.
 */
export const reduceKeys = (times: Float32Array, values: Float32Array, size: number, tolerance: number): { times: Float32Array; values: Float32Array } => {
  const count = times.length;
  if (count <= 2) return { times, values };
  const kept = [0];
  let from = 0;
  while (from < count - 1) {
    let reach = from + 1;
    for (let to = from + 2; to < count; to += 1) {
      let holds = true;
      const span = times[to] - times[from];
      for (let at = from + 1; at < to && holds; at += 1) {
        const blend = span > 0 ? (times[at] - times[from]) / span : 0;
        for (let c = 0; c < size; c += 1) {
          const line = values[from * size + c] + (values[to * size + c] - values[from * size + c]) * blend;
          if (Math.abs(line - values[at * size + c]) > tolerance) {
            holds = false;
            break;
          }
        }
      }
      if (!holds) break;
      reach = to;
    }
    kept.push(reach);
    from = reach;
  }
  if (kept.length === count) return { times, values };
  const outTimes = new Float32Array(kept.length);
  const outValues = new Float32Array(kept.length * size);
  kept.forEach((key, index) => {
    outTimes[index] = times[key];
    for (let c = 0; c < size; c += 1) outValues[index * size + c] = values[key * size + c];
  });
  return { times: outTimes, values: outValues };
};

const _reflected = new THREE.Vector3();

/** `v` reflected in the plane through the origin with unit normal `n`. */
const reflectVector = (v: THREE.Vector3, n: THREE.Vector3): THREE.Vector3 => v.addScaledVector(n, -2 * v.dot(n));

/** The rotation `q` makes, seen in a mirror with unit normal `n`: about the reflected axis, the other way round. */
const reflectRotation = (q: THREE.Quaternion, n: THREE.Vector3): THREE.Quaternion => {
  reflectVector(_reflected.set(q.x, q.y, q.z), n);
  return q.set(-_reflected.x, -_reflected.y, -_reflected.z, q.w);
};

export interface RetargetOptions {
  /**
   * Unit normal, in the source root's space, of a mirror the source's motion is seen in: a left
   * arm's swing becomes a right arm's (see mirrorHumanoidClip).
   */
  reflect?: THREE.Vector3;
  /** What each bone of the target is for; read from its names and shape if left out. */
  roles?: HumanoidRoles;
}

/** Child roles followed first when a bone has several children (the hips: the spine before the legs). */
const CHAIN_ROLES = ['Spine', 'Neck', 'Head', 'LeftMiddle1', 'RightMiddle1'];

/** The nearest paired nodes below `node`, looking past unpaired ones (twist and helper bones). */
const pairedDescendants = (node: THREE.Object3D, pairs: Map<THREE.Object3D, THREE.Object3D>): THREE.Object3D[] =>
  node.children.flatMap((child) => (pairs.has(child) ? [child] : pairedDescendants(child, pairs)));

/**
 * The world turn that points `bone` where its source bone points at rest: from the direction to a
 * paired child to the source's direction to that child's partner. Identity for a bone with no
 * paired child (an end bone), whose rest is kept as it is.
 */
const restAlignment = (
  bone: THREE.Object3D,
  target: RetargetRig,
  source: RetargetRig,
  pairs: Map<THREE.Object3D, THREE.Object3D>,
  roles: HumanoidRoles,
  reflect?: THREE.Vector3,
): THREE.Quaternion => {
  const sourceBone = pairs.get(bone);
  const children = pairedDescendants(bone, pairs);
  if (!sourceBone || !children.length) return new THREE.Quaternion();
  const child = children.find((candidate) => CHAIN_ROLES.includes(roles.get(candidate) ?? '')) ?? children[0];
  const targetDirection = rootRelativePosition(child, target.root, new THREE.Vector3())
    .sub(rootRelativePosition(bone, target.root, new THREE.Vector3()));
  const sourceDirection = rootRelativePosition(pairs.get(child)!, source.root, new THREE.Vector3())
    .sub(rootRelativePosition(sourceBone, source.root, new THREE.Vector3()));
  if (reflect) reflectVector(sourceDirection, reflect);
  if (targetDirection.lengthSq() < 1e-12 || sourceDirection.lengthSq() < 1e-12) return new THREE.Quaternion();
  return new THREE.Quaternion().setFromUnitVectors(targetDirection.normalize(), sourceDirection.normalize());
};

/** Whether `node` hangs anywhere below `above`. */
const isBelow = (node: THREE.Object3D, above: THREE.Object3D): boolean => {
  for (let up = node.parent; up; up = up.parent) if (up === above) return true;
  return false;
};

/** Units of a bone's parent space per unit of the root's. */
const positionScale = (bone: THREE.Object3D | null, root: THREE.Object3D): number => {
  if (!bone?.parent) return 1;
  const rootScale = root.getWorldScale(new THREE.Vector3()).x || 1;
  const parentScale = bone.parent.getWorldScale(new THREE.Vector3()).x || 1;
  return rootScale / parentScale;
};

const _toKnee = new THREE.Vector3();
const _toGoal = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _newKnee = new THREE.Vector3();
const _turn = new THREE.Quaternion();
const _shin = new THREE.Vector3();

/**
 * Turns a leg so its ankle reaches `goal`, keeping the knee on the side it bends to now. Rotations
 * are the leg's upper and lower bones in the root's space; everything is in the same space.
 */
const bendLeg = (hip: THREE.Vector3, knee: THREE.Vector3, ankle: THREE.Vector3, goal: THREE.Vector3, upper: THREE.Quaternion, lower: THREE.Quaternion): void => {
  const thigh = hip.distanceTo(knee);
  const calf = knee.distanceTo(ankle);
  _toGoal.copy(goal).sub(hip);
  const reach = _toGoal.length();
  if (thigh < 1e-6 || calf < 1e-6 || reach < 1e-6 || ankle.distanceToSquared(goal) < 1e-12) return;
  const distance = Math.min(thigh + calf - 1e-5, Math.max(Math.abs(thigh - calf) + 1e-5, reach));
  _toGoal.multiplyScalar(1 / reach);
  // The knee stays on the side of the line from hip to goal it is on now.
  _toKnee.copy(knee).sub(hip);
  _pole.copy(_toKnee).addScaledVector(_toGoal, -_toKnee.dot(_toGoal));
  if (_pole.lengthSq() < 1e-10) _pole.set(0, 0, 1).addScaledVector(_toGoal, -_toGoal.z);
  _pole.normalize();
  const along = (thigh * thigh - calf * calf + distance * distance) / (2 * distance);
  const out = Math.sqrt(Math.max(0, thigh * thigh - along * along));
  _newKnee.copy(hip).addScaledVector(_toGoal, along).addScaledVector(_pole, out);
  // The thigh swings to the new knee, carrying the shin; then the shin swings to the goal.
  _turn.setFromUnitVectors(_toKnee.normalize(), _newKnee.clone().sub(hip).normalize());
  upper.premultiply(_turn);
  lower.premultiply(_turn);
  _shin.copy(ankle).sub(knee).applyQuaternion(_turn).normalize();
  const reached = hip.clone().addScaledVector(_toGoal, distance).sub(_newKnee).normalize();
  _turn.setFromUnitVectors(_shin, reached);
  lower.premultiply(_turn);
};

/**
 * Bakes `clip`, which animates `source`, onto `target`. Both rigs must be at rest when this is
 * called; `source` is posed by the clip while sampling. `pairs` maps target bones to source bones
 * (matchHumanoidBones); `hip` is the target's hips, whose travel follows the paired source bone's.
 */
export const retargetHumanoidClip = (
  target: RetargetRig,
  source: RetargetRig,
  clip: THREE.AnimationClip,
  pairs: Map<THREE.Object3D, THREE.Object3D>,
  hip: THREE.Object3D | null,
  options: RetargetOptions = {},
): THREE.AnimationClip => {
  const { reflect } = options;
  const roles = options.roles ?? humanoidRoles(target.bones, target.root);
  const bones = [...target.bones].sort((a, b) => depthOf(a, target.root) - depthOf(b, target.root));
  target.root.updateMatrixWorld(true);
  source.root.updateMatrixWorld(true);

  // Rest pose of both rigs, relative to their roots.
  const restLocal = bones.map((bone) => bone.quaternion.clone());
  const restWorld = bones.map((bone) => rootRelativeQuaternion(bone, target.root, new THREE.Quaternion()));
  const restPosition = bones.map((bone) => rootRelativePosition(bone, target.root, new THREE.Vector3()));
  // What sits above each bone at rest: its parent bone's rotation, or for a top bone the fixed nodes above it.
  const parentIndex = bones.map((bone) => {
    for (let up = bone.parent; up && up !== target.root; up = up.parent) {
      const at = bones.indexOf(up);
      if (at >= 0) return at;
    }
    return -1;
  });
  // Bones between a bone and its nearest listed parent are not moved, so their turn stays in its rest offset.
  const fixedParent = bones.map((_, index) => restWorld[index].clone().multiply(restLocal[index].clone().invert()));
  const parentRest = bones.map((_, index) => {
    const parent = parentIndex[index];
    if (parent < 0) return new THREE.Quaternion();
    return restWorld[parent].clone().invert().multiply(fixedParent[index]);
  });
  // Where each bone sits in its parent's frame at rest, in the root's units.
  const restOffset = bones.map((_, index) => {
    const parent = parentIndex[index];
    return parent < 0 ? new THREE.Vector3() : restPosition[index].clone().sub(restPosition[parent]).applyQuaternion(restWorld[parent].clone().invert());
  });
  const sourceRest = new Map<THREE.Object3D, THREE.Quaternion>();
  for (const sourceBone of pairs.values()) sourceRest.set(sourceBone, rootRelativeQuaternion(sourceBone, source.root, new THREE.Quaternion()));
  // Rigs rest in different poses (a T-pose source, an A-pose target): each target bone is first
  // turned to point where its source bone points at rest, so the source's poses come out the same.
  const restAlign = bones.map((bone) => restAlignment(bone, target, source, pairs, roles, reflect));

  const sourceHip = hip ? pairs.get(hip) ?? null : null;
  const targetHipRest = hip ? rootRelativePosition(hip, target.root, new THREE.Vector3()) : null;
  const sourceHipRest = sourceHip ? rootRelativePosition(sourceHip, source.root, new THREE.Vector3()) : null;
  const hipScale = targetHipRest && sourceHipRest && Math.abs(sourceHipRest.y) > 1e-6 && targetHipRest.y > 0
    ? targetHipRest.y / sourceHipRest.y : 1;
  const hipIndex = hip ? bones.indexOf(hip) : -1;

  // The legs that can be bent to put a foot where the source's is. A mirror keeps the rig's own proportions.
  const roleIndex = (role: string): number => bones.findIndex((bone) => roles.get(bone) === role);
  const legs = reflect || !sourceHip ? [] : (['Left', 'Right'] as const).flatMap((side) => {
    const upper = roleIndex(`${side}UpperLeg`);
    const lower = roleIndex(`${side}LowerLeg`);
    const foot = roleIndex(`${side}Foot`);
    const sourceFoot = foot >= 0 ? pairs.get(bones[foot]) : undefined;
    if (upper < 0 || lower < 0 || foot < 0 || !sourceFoot) return [];
    if (!pairs.has(bones[upper]) || !pairs.has(bones[lower])) return [];
    const footRest = restPosition[foot].clone();
    return [{
      upper,
      lower,
      foot,
      sourceFoot,
      // Where the foot rests against where the source's would when scaled: the stance a rig keeps.
      restGap: footRest.clone().sub(rootRelativePosition(sourceFoot, source.root, new THREE.Vector3()).multiplyScalar(hipScale)),
      // Where the foot sits from the lower leg at rest, whether or not it is parented there (a free IK foot is not).
      footInLower: footRest.clone().sub(restPosition[lower]).applyQuaternion(restWorld[lower].clone().invert()),
      // A foot under the leg moves with it; a free one is told where to go.
      free: parentIndex[foot] !== lower && !isBelow(bones[foot], bones[lower]),
      positions: new Float32Array(0),
    }];
  });

  const rate = clipSampleRate(clip);
  const frames = Math.max(2, Math.round(clip.duration * rate) + 1);
  const times = new Float32Array(frames);
  const rotations = bones.map(() => new Float32Array(frames * 4));
  const hipPositions = new Float32Array(frames * 3);
  for (const leg of legs) if (leg.free) leg.positions = new Float32Array(frames * 3);
  const mixer = new THREE.AnimationMixer(source.root);
  const action = mixer.clipAction(clip);
  // Once and held at the end: a looping action sampled at its last time wraps back to the first.
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();

  const world = bones.map(() => new THREE.Quaternion());
  const place = bones.map(() => new THREE.Vector3());
  const local = new THREE.Quaternion();
  const delta = new THREE.Quaternion();
  const parentWorld = new THREE.Quaternion();
  const hipPlace = new THREE.Vector3();
  const parentOf = (index: number, out: THREE.Quaternion): THREE.Quaternion => (parentIndex[index] >= 0
    ? out.copy(world[parentIndex[index]]).multiply(parentRest[index])
    : out.copy(fixedParent[index]));
  const placeOf = (index: number): THREE.Vector3 => {
    if (index === hipIndex) return place[index].copy(hipPlace);
    const parent = parentIndex[index];
    if (parent < 0) return place[index].copy(restPosition[index]);
    return place[index].copy(restOffset[index]).applyQuaternion(world[parent]).add(place[parent]);
  };
  const goal = new THREE.Vector3();
  const knee = new THREE.Vector3();
  const ankle = new THREE.Vector3();
  try {
    for (let frame = 0; frame < frames; frame += 1) {
      const time = (frame / (frames - 1)) * clip.duration;
      times[frame] = time;
      mixer.setTime(time);
      source.root.updateMatrixWorld(true);
      // The source's pose.
      bones.forEach((bone, index) => {
        const sourceBone = pairs.get(bone);
        if (sourceBone) {
          // The turn the source bone made away from its rest pose, applied to this bone's rest pose.
          rootRelativeQuaternion(sourceBone, source.root, delta).multiply(_q.copy(sourceRest.get(sourceBone)!).invert());
          if (reflect) reflectRotation(delta, reflect);
          world[index].copy(delta).multiply(restAlign[index]).multiply(restWorld[index]);
        } else {
          parentOf(index, world[index]).multiply(restLocal[index]);
        }
      });
      if (hip && sourceHip && targetHipRest && sourceHipRest) {
        rootRelativePosition(sourceHip, source.root, _v).sub(sourceHipRest);
        if (reflect) reflectVector(_v, reflect);
        hipPlace.copy(_v).multiplyScalar(hipScale).add(targetHipRest);
      }
      // Each leg bends to bring its foot where the source's is.
      if (legs.length) {
        for (let index = 0; index < bones.length; index += 1) placeOf(index);
        for (const leg of legs) {
          const hipJoint = place[leg.upper];
          knee.copy(place[leg.lower]);
          ankle.copy(leg.footInLower).applyQuaternion(world[leg.lower]).add(knee);
          rootRelativePosition(leg.sourceFoot, source.root, goal).multiplyScalar(hipScale).add(leg.restGap);
          bendLeg(hipJoint, knee, ankle, goal, world[leg.upper], world[leg.lower]);
          if (leg.free) goal.toArray(leg.positions, frame * 3);
        }
      }
      // Local rotations, parents first: a bone without a partner follows its parent.
      bones.forEach((bone, index) => {
        parentOf(index, parentWorld);
        if (!pairs.has(bone)) world[index].copy(parentWorld).multiply(restLocal[index]);
        local.copy(parentWorld).invert().multiply(world[index]);
        const values = rotations[index];
        // Keep each key in the same hemisphere as the last, so interpolation never takes the long way round.
        if (frame > 0) {
          const dot = values[frame * 4 - 4] * local.x + values[frame * 4 - 3] * local.y + values[frame * 4 - 2] * local.z + values[frame * 4 - 1] * local.w;
          if (dot < 0) local.set(-local.x, -local.y, -local.z, -local.w);
        }
        local.toArray(values, frame * 4);
      });
      if (hip && sourceHip && targetHipRest && sourceHipRest) {
        // Into the hips' parent space, which stays at rest above the hips.
        _v.copy(hipPlace);
        target.root.localToWorld(_v);
        hip.parent?.worldToLocal(_v);
        _v.toArray(hipPositions, frame * 3);
      }
    }
  } finally {
    action.stop();
    mixer.uncacheRoot(source.root);
  }

  const tracks: THREE.KeyframeTrack[] = [];
  // A bone that only ever holds its rest pose needs no track.
  bones.forEach((bone, index) => {
    const values = rotations[index];
    const rest = restLocal[index];
    let moves = false;
    for (let frame = 0; frame < frames && !moves; frame += 1) {
      const dot = values[frame * 4] * rest.x + values[frame * 4 + 1] * rest.y + values[frame * 4 + 2] * rest.z + values[frame * 4 + 3] * rest.w;
      if (Math.abs(dot) < 1 - 1e-8) moves = true;
    }
    if (!moves && bone !== hip) return;
    const reduced = reduceKeys(times, values, 4, KEY_TOLERANCE);
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, reduced.times, reduced.values));
  });
  // Positions in the root's units, whatever the bones' parents scale them by.
  const positionTolerance = KEY_TOLERANCE * Math.max(1e-6, targetHipRest ? targetHipRest.y : 1) * positionScale(hip, target.root);
  if (hip && sourceHip) {
    const reduced = reduceKeys(times, hipPositions, 3, positionTolerance);
    tracks.push(new THREE.VectorKeyframeTrack(`${hip.name}.position`, reduced.times, reduced.values));
  }
  for (const leg of legs) {
    if (!leg.free) continue;
    const foot = bones[leg.foot];
    // Into the foot's parent space, which stays at rest above a free foot.
    for (let frame = 0; frame < frames; frame += 1) {
      _v.fromArray(leg.positions, frame * 3);
      target.root.localToWorld(_v);
      foot.parent?.worldToLocal(_v);
      _v.toArray(leg.positions, frame * 3);
    }
    const reduced = reduceKeys(times, leg.positions, 3, positionTolerance);
    tracks.push(new THREE.VectorKeyframeTrack(`${foot.name}.position`, reduced.times, reduced.values));
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
};

/** The other side's name: Left/Right, left/right, L/R between separators (Bip01 L Thigh) and _l/_r, .L/.R endings. */
export const mirrorBoneName = (name: string): string | null => {
  const swapped = name
    .replace(/Left|Right|left|right|LEFT|RIGHT/g, (side) => ({ Left: 'Right', Right: 'Left', left: 'right', right: 'left', LEFT: 'RIGHT', RIGHT: 'LEFT' })[side]!)
    .replace(/(^|[\s_.:-])([LlRr])(?=$|[\s_.:-])/g, (_, separator: string, side: string) =>
      separator + ({ L: 'R', R: 'L', l: 'r', r: 'l' } as Record<string, string>)[side]);
  return swapped === name ? null : swapped;
};

/**
 * `clip` reflected left to right on the rig it animates: every bone plays its partner's motion
 * (left arm and right arm, matched by role or by name), seen in a mirror across the character's
 * middle, so a step with the left foot becomes one with the right. Bones without a partner (the
 * spine, the head) mirror their own motion. Expects a rig that is symmetric at rest; `rig` must be
 * at rest and is not changed.
 */
export const mirrorHumanoidClip = (rig: RetargetRig, clip: THREE.AnimationClip, name = clip.name): THREE.AnimationClip => {
  rig.root.updateMatrixWorld(true);
  const copy = cloneSkeleton(rig.root);
  copy.updateMatrixWorld(true);
  const byName = new Map(rig.bones.map((bone) => [bone.name, bone]));
  const byRole = new Map<string, THREE.Object3D>();
  for (const bone of rig.bones) {
    const role = humanoidRole(bone.name);
    if (role && !byRole.has(role)) byRole.set(role, bone);
  }
  const partnerOf = (bone: THREE.Object3D): THREE.Object3D => {
    const role = humanoidRole(bone.name);
    const sided = role && /^(Left|Right)/.test(role) ? byRole.get(role.startsWith('Left') ? `Right${role.slice(4)}` : `Left${role.slice(5)}`) : undefined;
    const named = mirrorBoneName(bone.name);
    return sided ?? (named ? byName.get(named) : undefined) ?? bone;
  };
  const pairs = new Map<THREE.Object3D, THREE.Object3D>();
  for (const bone of rig.bones) {
    const partner = copy.getObjectByName(partnerOf(bone).name);
    if (partner) pairs.set(bone, partner);
  }

  // The mirror runs through the middle of the body: its normal points from the right side to the left.
  const across = new THREE.Vector3();
  for (const part of ['UpperLeg', 'UpperArm', 'Shoulder', 'Foot']) {
    const left = byRole.get(`Left${part}`);
    const right = byRole.get(`Right${part}`);
    if (left && right) across.add(rootRelativePosition(left, rig.root, new THREE.Vector3()).sub(rootRelativePosition(right, rig.root, new THREE.Vector3())));
  }
  if (across.lengthSq() < 1e-12) across.set(1, 0, 0);
  across.normalize();

  const hip = byRole.get('Hips') ?? [...rig.bones].sort((a, b) => depthOf(a, rig.root) - depthOf(b, rig.root))[0] ?? null;
  const source = { root: copy, bones: [...pairs.values()] };
  const mirrored = retargetHumanoidClip(rig, source, clip, pairs, hip, { reflect: across });
  mirrored.name = name;
  return mirrored;
};
