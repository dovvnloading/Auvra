import * as THREE from 'three';
import { clone as cloneSkeleton, retargetClip } from 'three/examples/jsm/utils/SkeletonUtils.js';

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

const canonicalBoneName = (name: string): string => {
  const leaf = name.split(/[|:]/).pop() || name;
  return leaf
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^(mixamorig|armature|skeleton)/, '');
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

const uniqueBonesByCanonicalName = (values: THREE.Bone[]): Map<string, THREE.Bone> => {
  const result = new Map<string, THREE.Bone>();
  const ambiguous = new Set<string>();
  for (const bone of values) {
    const key = canonicalBoneName(bone.name);
    if (!key) continue;
    if (result.has(key)) {
      result.delete(key);
      ambiguous.add(key);
    } else if (!ambiguous.has(key)) {
      result.set(key, bone);
    }
  }
  return result;
};

const retargetAnimations = (
  targetRoot: THREE.Object3D,
  sourceRoot: THREE.Object3D,
  clips: THREE.AnimationClip[],
): PreparedAnimationClips => {
  const targetClone = cloneSkeleton(targetRoot);
  const targetMesh = skinnedMesh(targetClone);
  if (!targetMesh) {
    throw new AnimationImportError('The target model does not contain a bound skeleton.');
  }

  const sourceMesh = skinnedMesh(sourceRoot);
  const sourceBones = bones(sourceRoot);
  if (!sourceBones.length) {
    throw new AnimationImportError('The animation FBX does not contain a skeleton.');
  }

  const sourceByName = uniqueBonesByCanonicalName(sourceBones);
  const targetBones = targetMesh.skeleton.bones;
  const names: Record<string, string> = {};
  for (const targetBone of targetBones) {
    const sourceBone = sourceByName.get(canonicalBoneName(targetBone.name));
    if (sourceBone) names[targetBone.name] = sourceBone.name;
  }

  const animatedBoneKeys = new Set(
    clips.flatMap((clip) => clip.tracks.map(trackNodeName))
      .filter((name): name is string => name !== null)
      .map(canonicalBoneName)
      .filter((name) => sourceByName.has(name)),
  );
  const matchedAnimatedBones = [...animatedBoneKeys]
    .filter((name) => targetBones.some((bone) => canonicalBoneName(bone.name) === name));
  const requiredMatches = Math.max(1, Math.ceil(animatedBoneKeys.size * 0.8));
  if (!animatedBoneKeys.size || matchedAnimatedBones.length < requiredMatches) {
    throw new AnimationImportError(
      `The animation skeleton is incompatible with the target (${matchedAnimatedBones.length}/${animatedBoneKeys.size} animated bones matched).`,
    );
  }

  const hipTarget = targetBones.find((bone) => /^(hips?|pelvis|root)$/.test(canonicalBoneName(bone.name)));
  const hip = hipTarget ? names[hipTarget.name] : undefined;
  const sourceSkeleton = sourceMesh?.skeleton || new THREE.Skeleton(sourceBones);
  const prepared = clips.map((clip) => {
    const result = retargetClip(targetMesh, sourceSkeleton, clip, {
      names,
      hip,
      preserveHipPosition: false,
      useFirstFramePosition: false,
    });
    result.name = clip.name;
    if (!result.tracks.length) {
      throw new AnimationImportError(`Animation "${clip.name}" produced no tracks for the target skeleton.`);
    }
    return result;
  });

  return {
    clips: prepared,
    mode: 'retargeted',
    matchedBones: Object.keys(names).length,
    animatedBones: animatedBoneKeys.size,
  };
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
