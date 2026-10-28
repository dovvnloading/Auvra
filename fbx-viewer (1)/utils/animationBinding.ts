import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { animatedSkeleton, humanoidRole, matchHumanoidBones, mirrorHumanoidClip, retargetHumanoidClip } from './retargeting';
import { originalBone } from './partCopies';

export class AnimationImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnimationImportError';
  }
}

export interface AnimationTargetCandidate {
  id: string;
  name: string;
  category?: string;
  object: THREE.Object3D;
}

export interface PreparedAnimationClips {
  clips: THREE.AnimationClip[];
  mode: 'direct' | 'retargeted';
  matchedBones: number;
  animatedBones: number;
}

/**
 * The skinned mesh whose skeleton has the most bones. A character split into parts (Mixamo's body,
 * shoes, hair) often gives each part a small skeleton of copied bones; only the body's is complete.
 */
const skinnedMesh = (root: THREE.Object3D): THREE.SkinnedMesh | null => {
  let result: THREE.SkinnedMesh | null = null;
  root.traverse((child) => {
    const candidate = child as THREE.SkinnedMesh;
    if (candidate.isSkinnedMesh && (candidate.skeleton?.bones.length ?? 0) > (result?.skeleton.bones.length ?? 0)) result = candidate;
  });
  return result;
};

/**
 * Puts every bone any part of `root` is bound to at its bind pose, parents before children, so a
 * part's copy of a bone sits on the original with no offset again whatever pose the model was in.
 */
const poseAtBind = (root: THREE.Object3D): void => {
  const bind = new Map<THREE.Object3D, THREE.Matrix4>();
  root.traverse((child) => {
    const mesh = child as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    mesh.skeleton.bones.forEach((bone, index) => {
      const inverse = mesh.skeleton.boneInverses[index];
      if (inverse && !bind.has(bone)) bind.set(bone, inverse.clone().invert());
    });
  });
  // Bind matrices are in the skeleton's own space, as Skeleton.pose() reads them: a bone under
  // another bone is offset from that bone's bind, and any other bone's bind is its own transform.
  // A bone no part binds keeps its offset and passes its parent's bind on to its children.
  root.updateMatrixWorld(true);
  const posed = new Map<THREE.Object3D, THREE.Matrix4>();
  root.traverse((node) => {
    const parentBind = node.parent && (node.parent as THREE.Bone).isBone ? posed.get(node.parent) ?? null : null;
    const own = bind.get(node);
    if (own) {
      node.matrix.copy(parentBind ? parentBind.clone().invert().multiply(own) : own);
      node.matrix.decompose(node.position, node.quaternion, node.scale);
      posed.set(node, own);
    } else if ((node as THREE.Bone).isBone) {
      posed.set(node, parentBind ? parentBind.clone().multiply(node.matrix) : node.matrix.clone());
    }
  });
  root.updateMatrixWorld(true);
};

/**
 * A copy of `object` at its bind pose and the bones clips are made for: the complete skeleton's,
 * each as the original bone rather than a part's copy of it, so a clip turns the original and every
 * part bound to a copy follows. Null without a bound skeleton.
 */
const bindPoseRig = (object: THREE.Object3D): { root: THREE.Object3D; bones: THREE.Bone[] } | null => {
  const root = cloneSkeleton(object);
  const mesh = skinnedMesh(root);
  if (!mesh) return null;
  poseAtBind(root);
  return { root, bones: [...new Set(mesh.skeleton.bones.map(originalBone))] };
};

const bones = (root: THREE.Object3D): THREE.Bone[] => {
  const mesh = skinnedMesh(root);
  if (mesh) return mesh.skeleton.bones;
  const result: THREE.Bone[] = [];
  root.traverse((child) => {
    if ((child as THREE.Bone).isBone) result.push(child as THREE.Bone);
  });
  return result;
};

export const isSkeletalModel = (model: AnimationTargetCandidate): boolean => bones(model.object).length > 0;

/** `names` made unique among themselves and against `taken` ("Idle", then "Idle 2"); `taken` gains them. */
export const uniqueClipNames = (names: readonly string[], taken: Set<string>): string[] =>
  names.map((name) => {
    let candidate = name;
    for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${name} ${suffix}`;
    taken.add(candidate);
    return candidate;
  });

/**
 * Gives `clips` the names stored with their document. A clip is named after its file when it is
 * loaded, so without this a model renamed in the library would rename its clips too, and every
 * state that plays them would lose them. Ignored unless there is one stored name per clip.
 */
/** The name a mirrored copy of a clip gets. */
export const mirroredClipName = (name: string): string => `${name} (Mirrored)`;

/**
 * Mirrored copies (left and right swapped) of the clips in `clips` named in `names`, made on a copy
 * of `object`'s skeleton at its bind pose. Names it has no clip for, or whose copy it already has,
 * are skipped.
 */
export const mirrorModelClips = (
  object: THREE.Object3D,
  clips: readonly THREE.AnimationClip[],
  names: readonly string[],
): THREE.AnimationClip[] => {
  const wanted = names.filter((name) => clips.some((clip) => clip.name === name) && !clips.some((clip) => clip.name === mirroredClipName(name)));
  if (!wanted.length) return [];
  const rig = bindPoseRig(object);
  if (!rig) throw new AnimationImportError('The model has no skeleton to mirror its clips on.');
  return wanted.map((name) => mirrorHumanoidClip(rig, clips.find((clip) => clip.name === name)!, mirroredClipName(name)));
};

export const applyStoredClipNames = (clips: readonly THREE.AnimationClip[], stored: unknown): void => {
  if (!Array.isArray(stored) || stored.length !== clips.length) return;
  if (!stored.every((name) => typeof name === 'string' && name.length > 0)) return;
  clips.forEach((clip, index) => { clip.name = stored[index] as string; });
};

/**
 * `own` followed by the rest of `all`. Where models have clips of the same name ("Idle"), an
 * animation graph plays the first one listed, so a model's own clips must come before the others.
 */
export const ownClipsFirst = <T>(own: readonly T[] | undefined, all: readonly T[]): T[] => {
  if (!own?.length) return [...all];
  const mine = new Set(own);
  return [...own, ...all.filter((item) => !mine.has(item))];
};

export const selectAnimationTarget = <T extends AnimationTargetCandidate>(
  models: T[],
  selectedModelId: string | null,
): T => {
  const selected = selectedModelId ? models.find((model) => model.id === selectedModelId) : undefined;
  if (selected) {
    if (selected.category === 'Animation' || !isSkeletalModel(selected)) {
      throw new AnimationImportError(`"${selected.name}" is not a skeletal animation target.`);
    }
    return selected;
  }

  const candidates = models.filter((model) => model.category !== 'Animation' && isSkeletalModel(model));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new AnimationImportError('Import a skeletal model before importing animation clips.');
  }
  throw new AnimationImportError('Select the skeletal model that should own these animation clips.');
};

const trackNodeName = (track: THREE.KeyframeTrack): string | null => {
  try {
    const parsed = THREE.PropertyBinding.parseTrackName(track.name);
    if (parsed.objectName === 'bones' && parsed.objectIndex) return String(parsed.objectIndex);
    return parsed.nodeName || '';
  } catch {
    return null;
  }
};

const clipBindsDirectly = (root: THREE.Object3D, clip: THREE.AnimationClip): boolean => (
  clip.tracks.length > 0 && clip.tracks.every((track) => {
    const nodeName = trackNodeName(track);
    return nodeName !== null && (!nodeName || THREE.PropertyBinding.findNode(root, nodeName) !== null);
  })
);

/** Roles a humanoid's arms, legs, spine and head fill; most of the target's must pair to retarget. */
const CORE_ROLES = [
  'Hips', 'Spine', 'Head', 'LeftUpperArm', 'LeftLowerArm', 'RightUpperArm', 'RightLowerArm',
  'LeftUpperLeg', 'LeftLowerLeg', 'RightUpperLeg', 'RightLowerLeg',
];
const REQUIRED_CORE_SHARE = 0.8;

const retargetAnimations = (
  targetRoot: THREE.Object3D,
  sourceRoot: THREE.Object3D,
  clips: THREE.AnimationClip[],
): PreparedAnimationClips => {
  // A copy at its bind pose, whatever pose the library model is in now.
  const rig = bindPoseRig(targetRoot);
  if (!rig) {
    throw new AnimationImportError('The target model does not contain a bound skeleton.');
  }
  const { root: targetClone, bones: targetBones } = rig;

  // Animation-only files often keep their skeleton as plain nodes, posed at the rig's rest pose.
  const sourceBones = animatedSkeleton(sourceRoot, clips);
  if (!sourceBones.length) {
    throw new AnimationImportError('The animation FBX does not contain a skeleton.');
  }

  const pairs = matchHumanoidBones(targetBones, sourceBones, targetClone, sourceRoot);
  const roleOf = new Map(targetBones.map((bone) => [bone, humanoidRole(bone.name)]));
  const core = targetBones.filter((bone) => CORE_ROLES.includes(roleOf.get(bone) ?? ''));
  // A humanoid target needs most of its limbs paired; any other rig most of its bones.
  const judged = core.length >= 5 ? core : targetBones;
  const paired = judged.filter((bone) => pairs.has(bone)).length;
  if (!paired || paired < Math.ceil(judged.length * REQUIRED_CORE_SHARE)) {
    throw new AnimationImportError(
      `The animation skeleton is incompatible with the target (${paired}/${judged.length} ${judged === core ? 'limb and spine' : ''} bones matched).`.replace('  ', ' '),
    );
  }

  const hip = targetBones.find((bone) => roleOf.get(bone) === 'Hips' && pairs.has(bone))
    ?? [...pairs.keys()].sort((a, b) => depth(a) - depth(b))[0]
    ?? null;
  const prepared = clips.map((clip) => {
    const result = retargetHumanoidClip({ root: targetClone, bones: targetBones }, { root: sourceRoot, bones: sourceBones }, clip, pairs, hip);
    if (!result.tracks.length) {
      throw new AnimationImportError(`Animation "${clip.name}" produced no tracks for the target skeleton.`);
    }
    return result;
  });

  return {
    clips: prepared,
    mode: 'retargeted',
    matchedBones: pairs.size,
    animatedBones: sourceBones.length,
  };
};

const depth = (node: THREE.Object3D): number => {
  let count = 0;
  for (let parent = node.parent; parent; parent = parent.parent) count += 1;
  return count;
};

export const prepareAnimationClips = (
  targetRoot: THREE.Object3D,
  sourceRoot: THREE.Object3D,
  clips: THREE.AnimationClip[],
): PreparedAnimationClips => {
  const usable = clips.filter((clip) => clip.duration > 0 && clip.tracks.length > 0);
  if (!usable.length) throw new AnimationImportError('The FBX contains no usable animation clips.');

  if (usable.every((clip) => clipBindsDirectly(targetRoot, clip))) {
    return {
      clips: usable.map((clip) => clip.clone()),
      mode: 'direct',
      matchedBones: 0,
      animatedBones: 0,
    };
  }
  return retargetAnimations(targetRoot, sourceRoot, usable);
};
