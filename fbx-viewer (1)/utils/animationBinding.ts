import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { animatedSkeleton, humanoidRole, matchHumanoidBones, retargetHumanoidClip } from './retargeting';

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

const skinnedMesh = (root: THREE.Object3D): THREE.SkinnedMesh | null => {
  let result: THREE.SkinnedMesh | null = null;
  root.traverse((child) => {
    if (!result && (child as THREE.SkinnedMesh).isSkinnedMesh) {
      const candidate = child as THREE.SkinnedMesh;
      if (candidate.skeleton?.bones.length) result = candidate;
    }
  });
  return result;
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
  const targetClone = cloneSkeleton(targetRoot);
  const targetMesh = skinnedMesh(targetClone);
  if (!targetMesh) {
    throw new AnimationImportError('The target model does not contain a bound skeleton.');
  }
  targetClone.updateMatrixWorld(true);
  targetMesh.skeleton.pose();
  targetClone.updateMatrixWorld(true);

  // Animation-only files often keep their skeleton as plain nodes, posed at the rig's rest pose.
  const sourceBones = animatedSkeleton(sourceRoot, clips);
  if (!sourceBones.length) {
    throw new AnimationImportError('The animation FBX does not contain a skeleton.');
  }

  const targetBones = targetMesh.skeleton.bones;
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
