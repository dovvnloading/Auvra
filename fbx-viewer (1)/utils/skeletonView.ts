import { useSyncExternalStore } from 'react';
import * as THREE from 'three';

/**
 * What the Skeleton panel shows in the viewport: shared between the panel in the sidebar and the
 * overlay drawn with the model, which sit in different React roots.
 */

export type SkinBrushMode = 'off' | 'add' | 'remove' | 'smooth';

export interface SkeletonViewState {
  showSkeleton: boolean;
  showWeights: boolean;
  /** Name of the bone picked in the panel. */
  selectedBone: string | null;
  /** What dragging on the model does to the picked bone's weights. */
  brush: SkinBrushMode;
  /** Across the brush, as a percentage of the model's longest side. */
  brushSize: number;
  /** How far one touch moves a vertex, as a percentage of the way. */
  brushStrength: number;
}

let state: SkeletonViewState = { showSkeleton: false, showWeights: false, selectedBone: null, brush: 'off', brushSize: 12, brushStrength: 50 };
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

/**
 * Where the clip in the view has got to, in seconds, which changes too often to be state: the view
 * writes `time`, and the panel sets `wanted` to send it somewhere.
 */
export const clipPlace: { time: number; wanted: number | null } = { time: 0, wanted: null };

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

/**
 * A stand-in for each skinned mesh under `root`, to draw over it: it shares the mesh's geometry, skeleton and
 * place in the world, but belongs to no model. The model is left as it is, as others read and dispose its
 * materials, and copies of it carry whatever it holds. A second mesh over the same surface gets none.
 */
export const skinnedStandIns = (root: THREE.Object3D, materialFor: (mesh: THREE.SkinnedMesh) => THREE.Material): { mesh: THREE.SkinnedMesh; standIn: THREE.SkinnedMesh }[] => {
  const list: { mesh: THREE.SkinnedMesh; standIn: THREE.SkinnedMesh }[] = [];
  const drawn = new Map<THREE.BufferGeometry, THREE.Skeleton>();
  root.traverse((node) => {
    const mesh = node as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || drawn.get(mesh.geometry) === mesh.skeleton) return;
    drawn.set(mesh.geometry, mesh.skeleton);
    const standIn = new THREE.SkinnedMesh(mesh.geometry, materialFor(mesh));
    standIn.skeleton = mesh.skeleton;
    standIn.bindMatrix = mesh.bindMatrix;
    standIn.bindMatrixInverse = mesh.bindMatrixInverse;
    standIn.bindMode = mesh.bindMode;
    standIn.morphTargetInfluences = mesh.morphTargetInfluences;
    standIn.morphTargetDictionary = mesh.morphTargetDictionary;
    standIn.matrixWorld = mesh.matrixWorld;
    // Its place is the mesh's, and it must never write it: a parent's update would, whatever its flags say.
    standIn.updateMatrixWorld = () => undefined;
    standIn.frustumCulled = false;
    list.push({ mesh, standIn });
  });
  return list;
};

/** How far from a joint a click still picks it, in pixels. */
const PICK_REACH = 14;

const _onScreen = new THREE.Vector3();

/**
 * The bone whose joint is nearest a place in the view, within reach of it. `x` and `y` are in pixels
 * from the view's top left. A joint behind the camera cannot be picked. Where joints crowd, the nearest
 * on the screen wins, then the nearest to the camera.
 */
export const boneAtScreen = (bones: readonly SkeletonBone[], camera: THREE.Camera, x: number, y: number, width: number, height: number, reach = PICK_REACH): SkeletonBone | null => {
  let best: SkeletonBone | null = null;
  let bestGap = reach;
  let bestDepth = Infinity;
  for (const entry of bones) {
    entry.bone.getWorldPosition(_onScreen).project(camera);
    if (_onScreen.z > 1 || _onScreen.z < -1) continue;
    const gap = Math.hypot(((_onScreen.x + 1) / 2) * width - x, ((1 - _onScreen.y) / 2) * height - y);
    if (gap > reach) continue;
    if (gap < bestGap - 0.5 || (gap <= bestGap + 0.5 && _onScreen.z < bestDepth)) {
      best = entry;
      bestGap = gap;
      bestDepth = _onScreen.z;
    }
  }
  return best;
};

/** How many vertices each bone moves at all, by bone name. */
export const boneInfluences = (root: THREE.Object3D): Map<string, number> => {
  const counts = new Map<string, number>();
  root.traverse((node) => {
    const mesh = node as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const joints = mesh.geometry.getAttribute('skinIndex');
    const weights = mesh.geometry.getAttribute('skinWeight');
    if (!joints || !weights) return;
    for (let vertex = 0; vertex < joints.count; vertex += 1) {
      for (let k = 0; k < 4; k += 1) {
        if (weights.getComponent(vertex, k) <= 0) continue;
        const bone = mesh.skeleton.bones[joints.getComponent(vertex, k)];
        if (bone) counts.set(bone.name, (counts.get(bone.name) ?? 0) + 1);
      }
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
