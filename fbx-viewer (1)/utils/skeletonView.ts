import { useSyncExternalStore } from 'react';
import * as THREE from 'three';

/**
 * What the Skeleton panel shows in the viewport: shared between the panel in the sidebar and the
 * overlay drawn with the model, which sit in different React roots.
 */

export interface SkeletonViewState {
  showSkeleton: boolean;
  showWeights: boolean;
  /** Name of the bone picked in the panel. */
  selectedBone: string | null;
}

let state: SkeletonViewState = { showSkeleton: false, showWeights: false, selectedBone: null };
const listeners = new Set<() => void>();

export const setSkeletonView = (next: Partial<SkeletonViewState>): void => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};

export const useSkeletonView = (): SkeletonViewState => useSyncExternalStore(
  (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  () => state,
);

export interface SkeletonBone {
  name: string;
  bone: THREE.Object3D;
  /** Index in the list of the nearest bone above it, or -1. */
  parent: number;
  depth: number;
  /** Bones directly under it. */
  children: number;
}

/** A model's bones, parents before children: those its meshes are bound to and those its file marks as bones (end bones are often neither bound nor animated). */
export const skeletonBones = (root: THREE.Object3D): SkeletonBone[] => {
  const bound = new Set<THREE.Object3D>();
  root.traverse((node) => {
    const mesh = node as THREE.SkinnedMesh;
    if (mesh.isSkinnedMesh) for (const bone of mesh.skeleton.bones) bound.add(bone);
  });
  const list: SkeletonBone[] = [];
  const indexOf = new Map<THREE.Object3D, number>();
  root.traverse((node) => {
    if (!bound.has(node) && !(node as THREE.Bone).isBone && node.userData?.bone !== true) return;
    let parent = -1;
    for (let up = node.parent; up; up = up.parent) {
      const at = indexOf.get(up);
      if (at !== undefined) {
        parent = at;
        break;
      }
    }
    indexOf.set(node, list.length);
    if (parent >= 0) list[parent].children += 1;
    list.push({ name: node.name, bone: node, parent, depth: parent >= 0 ? list[parent].depth + 1 : 0, children: 0 });
  });
  return list;
};

/** How many vertices each bone is the strongest influence on, by bone name. */
export const boneInfluences = (root: THREE.Object3D): Map<string, number> => {
  const counts = new Map<string, number>();
  root.traverse((node) => {
    const mesh = node as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const joints = mesh.geometry.getAttribute('skinIndex');
    const weights = mesh.geometry.getAttribute('skinWeight');
    if (!joints || !weights) return;
    for (let vertex = 0; vertex < joints.count; vertex += 1) {
      let strongest = 0;
      for (let k = 1; k < 4; k += 1) if (weights.getComponent(vertex, k) > weights.getComponent(vertex, strongest)) strongest = k;
      const bone = mesh.skeleton.bones[joints.getComponent(vertex, strongest)];
      if (bone) counts.set(bone.name, (counts.get(bone.name) ?? 0) + 1);
    }
  });
  return counts;
};

/** A role's name in words: 'LeftUpperArm' reads 'Left upper arm', 'RightIndex2' reads 'Right index 2'. */
export const roleLabel = (role: string): string => {
  const words = role.replace(/([a-z])([A-Z0-9])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const SIDED = ['Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot', 'Toes'];
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];

/** Every role a bone can have, in the order a skeleton reads from the hips out. */
export const ALL_BONE_ROLES: readonly string[] = [
  'Hips', 'Spine', 'Neck', 'Head',
  ...['Left', 'Right'].flatMap((side) => SIDED.map((part) => `${side}${part}`)),
  ...['Left', 'Right'].flatMap((side) => FINGERS.flatMap((finger) => [1, 2, 3].map((joint) => `${side}${finger}${joint}`))),
];
