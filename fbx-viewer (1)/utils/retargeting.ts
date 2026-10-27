import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';

/**
 * Retargeting animation between humanoid skeletons that differ in bone names, bone axes, rest pose
 * (T or A) and units.
 *
 * Bones are matched by role (hips, spine chain, neck, head, clavicles, arms, hands, fingers, legs,
 * feet, toes) across the common naming schemes: Mixamo (mixamorig:LeftUpLeg), Unreal (thigh_l),
 * Blender Rigify (thigh.L, DEF-thigh.L), 3ds Max Biped (Bip01 L Thigh) and plain names (LeftThigh).
 * Each frame, the rotation a source bone has turned away from its rest pose is applied to the
 * matching target bone's rest pose, so rigs whose bones point along different axes still move the
 * same way. The hips' travel is scaled by the ratio of the rigs' hip heights.
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

/**
 * The humanoid role of a bone ('Hips', 'Spine', 'LeftUpperArm', 'RightIndex2', ...), or null for
 * bones with none (end bones, twist and helper bones, props).
 */
export const humanoidRole = (name: string): string | null => {
  const words = nameWords(name);
  const text = words.join(' ');
  if (!text || /\b(end|nub|twist|roll|helper|ik|pole|target|weapon|prop)\b|top_end|headtop/.test(text) || /end$/.test(words[words.length - 1] ?? '')) return null;
  const side = sideOf(words, name);
  const finger = FINGERS.find((part) => words.some((word) => word.startsWith(part)));
  if (finger) {
    const digit = text.match(/(\d)(?!.*\d)/)?.[1];
    const joint = digit ? Math.min(3, Math.max(1, Number(digit) === 0 ? 1 : Number(digit))) : 1;
    return side ? `${side}${finger[0].toUpperCase()}${finger.slice(1)}${joint}` : null;
  }
  const has = (...parts: string[]) => parts.some((part) => words.some((word) => word === part || word.startsWith(part)));
  if (has('hips', 'hip', 'pelvis')) return side ? null : 'Hips';
  if (has('neck')) return 'Neck';
  if (has('head')) return 'Head';
  if (has('spine', 'chest', 'torso', 'back')) return side ? null : 'Spine';
  if (!side) return null;
  if (has('clavicle', 'shoulder', 'collar')) return `${side}Shoulder`;
  // Mixamo's ForeArm and UpLeg split into two words ("fore arm", "up leg").
  if (has('forearm', 'lowerarm', 'elbow') || /\bfore arm\b/.test(text) || (has('lower') && has('arm'))) return `${side}LowerArm`;
  if (has('upperarm') || (has('upper') && has('arm')) || words.includes('arm')) return `${side}UpperArm`;
  if (has('hand', 'wrist')) return `${side}Hand`;
  if (has('upleg', 'thigh', 'upperleg') || /\bup leg\b/.test(text) || (has('upper') && has('leg'))) return `${side}UpperLeg`;
  if (has('calf', 'shin', 'lowerleg', 'knee') || (has('lower') && has('leg')) || words.includes('leg')) return `${side}LowerLeg`;
  if (has('foot', 'ankle')) return `${side}Foot`;
  if (has('toe', 'ball')) return `${side}Toes`;
  return null;
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
): Map<THREE.Object3D, THREE.Object3D> => {
  const pairs = new Map<THREE.Object3D, THREE.Object3D>();
  const key = (name: string) => nameWords(name).join('');
  const sourceByKey = new Map<string, THREE.Object3D | null>();
  for (const bone of sourceBones) {
    const k = key(bone.name);
    sourceByKey.set(k, sourceByKey.has(k) ? null : bone);
  }
  const byRole = (bones: readonly THREE.Object3D[]) => {
    const map = new Map<string, THREE.Object3D[]>();
    for (const bone of bones) {
      const role = humanoidRole(bone.name);
      if (role) map.set(role, [...(map.get(role) ?? []), bone]);
    }
    return map;
  };
  const targetRoles = byRole(targetBones);
  const sourceRoles = byRole(sourceBones);
  const used = new Set<THREE.Object3D>();
  const pair = (target: THREE.Object3D, source: THREE.Object3D | undefined | null) => {
    if (!source || used.has(source) || pairs.has(target)) return;
    pairs.set(target, source);
    used.add(source);
  };

  for (const bone of targetBones) pair(bone, sourceByKey.get(key(bone.name)));

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

const SAMPLE_RATE = 30;

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
  reflect?: THREE.Vector3,
): THREE.Quaternion => {
  const sourceBone = pairs.get(bone);
  const children = pairedDescendants(bone, pairs);
  if (!sourceBone || !children.length) return new THREE.Quaternion();
  const child = children.find((candidate) => CHAIN_ROLES.includes(humanoidRole(candidate.name) ?? '')) ?? children[0];
  const targetDirection = rootRelativePosition(child, target.root, new THREE.Vector3())
    .sub(rootRelativePosition(bone, target.root, new THREE.Vector3()));
  const sourceDirection = rootRelativePosition(pairs.get(child)!, source.root, new THREE.Vector3())
    .sub(rootRelativePosition(sourceBone, source.root, new THREE.Vector3()));
  if (reflect) reflectVector(sourceDirection, reflect);
  if (targetDirection.lengthSq() < 1e-12 || sourceDirection.lengthSq() < 1e-12) return new THREE.Quaternion();
  return new THREE.Quaternion().setFromUnitVectors(targetDirection.normalize(), sourceDirection.normalize());
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
  const bones = [...target.bones].sort((a, b) => depthOf(a, target.root) - depthOf(b, target.root));
  target.root.updateMatrixWorld(true);
  source.root.updateMatrixWorld(true);

  // Rest pose of both rigs, relative to their roots.
  const restLocal = bones.map((bone) => bone.quaternion.clone());
  const restWorld = bones.map((bone) => rootRelativeQuaternion(bone, target.root, new THREE.Quaternion()));
  // What sits above each bone at rest: its parent bone's rotation, or for a top bone the fixed nodes above it.
  const parentIndex = bones.map((bone) => bones.indexOf(bone.parent as THREE.Object3D));
  const fixedParent = bones.map((_, index) => restWorld[index].clone().multiply(restLocal[index].clone().invert()));
  const sourceRest = new Map<THREE.Object3D, THREE.Quaternion>();
  for (const sourceBone of pairs.values()) sourceRest.set(sourceBone, rootRelativeQuaternion(sourceBone, source.root, new THREE.Quaternion()));
  // Rigs rest in different poses (a T-pose source, an A-pose target): each target bone is first
  // turned to point where its source bone points at rest, so the source's poses come out the same.
  const restAlign = bones.map((bone) => restAlignment(bone, target, source, pairs, reflect));

  const sourceHip = hip ? pairs.get(hip) ?? null : null;
  const targetHipRest = hip ? rootRelativePosition(hip, target.root, new THREE.Vector3()) : null;
  const sourceHipRest = sourceHip ? rootRelativePosition(sourceHip, source.root, new THREE.Vector3()) : null;
  const hipScale = targetHipRest && sourceHipRest && Math.abs(sourceHipRest.y) > 1e-6 && targetHipRest.y > 0
    ? targetHipRest.y / sourceHipRest.y : 1;

  const frames = Math.max(2, Math.round(clip.duration * SAMPLE_RATE) + 1);
  const times = new Float32Array(frames);
  const rotations = bones.map(() => new Float32Array(frames * 4));
  const hipPositions = new Float32Array(frames * 3);
  const mixer = new THREE.AnimationMixer(source.root);
  const action = mixer.clipAction(clip);
  // Once and held at the end: a looping action sampled at its last time wraps back to the first.
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();

  const world = bones.map(() => new THREE.Quaternion());
  const local = new THREE.Quaternion();
  const delta = new THREE.Quaternion();
  const parentWorld = new THREE.Quaternion();
  try {
    for (let frame = 0; frame < frames; frame += 1) {
      const time = (frame / (frames - 1)) * clip.duration;
      times[frame] = time;
      mixer.setTime(time);
      source.root.updateMatrixWorld(true);
      bones.forEach((bone, index) => {
        parentWorld.copy(parentIndex[index] >= 0 ? world[parentIndex[index]] : fixedParent[index]);
        const sourceBone = pairs.get(bone);
        if (sourceBone) {
          // The turn the source bone made away from its rest pose, applied to this bone's rest pose.
          rootRelativeQuaternion(sourceBone, source.root, delta).multiply(_q.copy(sourceRest.get(sourceBone)!).invert());
          if (reflect) reflectRotation(delta, reflect);
          world[index].copy(delta).multiply(restAlign[index]).multiply(restWorld[index]);
        } else {
          world[index].copy(parentWorld).multiply(restLocal[index]);
        }
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
        rootRelativePosition(sourceHip, source.root, _v).sub(sourceHipRest);
        if (reflect) reflectVector(_v, reflect);
        _v.multiplyScalar(hipScale).add(targetHipRest);
        // Into the hips' parent space, which stays at rest above the hips.
        target.root.localToWorld(_v);
        hip.parent?.worldToLocal(_v);
        _v.toArray(hipPositions, frame * 3);
      }
    }
  } finally {
    action.stop();
    mixer.uncacheRoot(source.root);
  }

  const tracks: THREE.KeyframeTrack[] = bones.map((bone, index) =>
    new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, rotations[index]));
  if (hip && sourceHip) tracks.push(new THREE.VectorKeyframeTrack(`${hip.name}.position`, times, hipPositions));
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
