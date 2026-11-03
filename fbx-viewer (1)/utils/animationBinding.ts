import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { animatedSkeleton, CORE_ROLES, humanoidRoles, matchHumanoidBones, mirrorHumanoidClip, retargetHumanoidClip, type StoredBoneRole } from './retargeting';

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

/** The skinned mesh whose skeleton has the most bones: a split character's body, over its shoes and hair. */
const skinnedMesh = (root: THREE.Object3D): THREE.SkinnedMesh | null => {
  let result: THREE.SkinnedMesh | null = null;
  root.traverse((child) => {
    const candidate = child as THREE.SkinnedMesh;
    if (candidate.isSkinnedMesh && (candidate.skeleton?.bones.length ?? 0) > (result?.skeleton.bones.length ?? 0)) result = candidate;
  });
  return result;
};

/**
 * Puts every bone any part of `root` is bound to at its bind pose, parents before children. A bind
 * matrix says where a bone was against the mesh bound to it, so the mesh's place gives the bone's.
 * A bone no part binds keeps its offset from its parent.
 */
const poseAtBind = (root: THREE.Object3D): void => {
  root.updateMatrixWorld(true);
  const bind = new Map<THREE.Object3D, THREE.Matrix4>();
  root.traverse((child) => {
    const mesh = child as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    mesh.skeleton.bones.forEach((bone, index) => {
      const inverse = mesh.skeleton.boneInverses[index];
      if (inverse && !bind.has(bone)) bind.set(bone, mesh.matrixWorld.clone().multiply(inverse.clone().invert()));
    });
  });
  const inverseParent = new THREE.Matrix4();
  root.traverse((node) => {
    const own = bind.get(node);
    if (own && node.parent) {
      node.parent.updateWorldMatrix(false, false);
      node.matrix.copy(inverseParent.copy(node.parent.matrixWorld).invert()).multiply(own);
      node.matrix.decompose(node.position, node.quaternion, node.scale);
    }
    node.updateMatrixWorld(true);
  });
};

/**
 * A copy of `object` at its bind pose and the bones clips are made for: those of every part, as a
 * character split into parts (body, hair, eyes) can bind each to bones the others do not use. Null
 * without a bound skeleton.
 */
export const bindPoseRig = (object: THREE.Object3D): { root: THREE.Object3D; bones: THREE.Bone[] } | null => {
  const root = cloneSkeleton(object);
  const bones = new Set<THREE.Bone>();
  root.traverse((child) => {
    const mesh = child as THREE.SkinnedMesh;
    if (mesh.isSkinnedMesh) mesh.skeleton.bones.forEach((bone) => bones.add(bone));
  });
  if (!bones.size) return null;
  poseAtBind(root);
  return { root, bones: [...bones] };
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

/** How far a bone may differ from the one a clip was made on, as a share of its offset, and in its turn. */
const REST_PLACE_TOLERANCE = 0.05;
const REST_TURN_TOLERANCE = THREE.MathUtils.degToRad(15);

/**
 * Whether a clip's values hold on `root` as they are: the bones it places rest where they rest on
 * the rig it was made on, and those it turns rest turned alike. Same names do not make that so: a
 * hip height from another character's proportions, or in another unit, puts the feet off the floor.
 */
const clipFitsRest = (root: THREE.Object3D, sourceRoot: THREE.Object3D, clip: THREE.AnimationClip): boolean => clip.tracks.every((track) => {
  const nodeName = trackNodeName(track);
  if (!nodeName) return true;
  const target = THREE.PropertyBinding.findNode(root, nodeName) as THREE.Object3D | null;
  const source = THREE.PropertyBinding.findNode(sourceRoot, nodeName) as THREE.Object3D | null;
  if (!target?.position || !source?.position) return true;
  if (track.name.endsWith('.position')) {
    return target.position.distanceTo(source.position) <= REST_PLACE_TOLERANCE * Math.max(target.position.length(), source.position.length());
  }
  if (track.name.endsWith('.quaternion')) return target.quaternion.angleTo(source.quaternion) <= REST_TURN_TOLERANCE;
  return true;
});

/** Most of a humanoid's arms, legs, spine and head must pair to retarget. */
const REQUIRED_CORE_SHARE = 0.8;

const retargetAnimations = (
  targetRoot: THREE.Object3D,
  sourceRoot: THREE.Object3D,
  clips: THREE.AnimationClip[],
  storedRoles?: readonly StoredBoneRole[],
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

  const roleOf = humanoidRoles(targetBones, targetClone, storedRoles);
  const pairs = matchHumanoidBones(targetBones, sourceBones, targetClone, sourceRoot, roleOf);
  const core = targetBones.filter((bone) => (CORE_ROLES as readonly string[]).includes(roleOf.get(bone) ?? ''));
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
    const result = retargetHumanoidClip({ root: targetClone, bones: targetBones }, { root: sourceRoot, bones: sourceBones }, clip, pairs, hip, { roles: roleOf });
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

/** A rig at its bind pose, if it has one to go to. */
const restOf = (root: THREE.Object3D): THREE.Object3D => bindPoseRig(root)?.root ?? root;

export const prepareAnimationClips = (
  targetRoot: THREE.Object3D,
  sourceRoot: THREE.Object3D,
  clips: THREE.AnimationClip[],
  /** The target model's own say in what its bones are. */
  storedRoles?: readonly StoredBoneRole[],
): PreparedAnimationClips => {
  const usable = clips.filter((clip) => clip.duration > 0 && clip.tracks.length > 0);
  if (!usable.length) throw new AnimationImportError('The FBX contains no usable animation clips.');

  if (usable.every((clip) => clipBindsDirectly(targetRoot, clip) && clipFitsRest(restOf(targetRoot), sourceRoot, clip))) {
    return {
      clips: usable.map((clip) => clip.clone()),
      mode: 'direct',
      matchedBones: 0,
      animatedBones: 0,
    };
  }
  return retargetAnimations(targetRoot, sourceRoot, usable, storedRoles);
};
