import * as THREE from 'three';

/** The name a loader made unique for a repeated name ("mixamorigHead_2"), without the number. */
const unnumbered = (name: string): string => name.replace(/_\d+$/, '');

const COPY_EPSILON = 1e-5;

/**
 * Whether `bone` is a part's copy of its parent. A character split into parts (Mixamo's body, eyes,
 * hair) can give each part its own copy of a bone they share, parented under the original with no
 * offset and named after it with a number: "mixamorigHead_2" under "mixamorigHead_1" under
 * "mixamorigHead". A copy only follows its parent; a clip that turned it would move that one part.
 */
export const isPartCopy = (bone: THREE.Object3D): boolean => {
  const parent = bone.parent;
  if (!parent || !(parent as THREE.Bone).isBone) return false;
  const numbered = /^(.*)_\d+$/.exec(bone.name);
  if (!numbered || numbered[1] !== unnumbered(parent.name)) return false;
  return bone.position.lengthSq() <= COPY_EPSILON * COPY_EPSILON
    && 1 - Math.abs(bone.quaternion.w) <= COPY_EPSILON
    && Math.abs(bone.scale.x - 1) <= COPY_EPSILON && Math.abs(bone.scale.y - 1) <= COPY_EPSILON && Math.abs(bone.scale.z - 1) <= COPY_EPSILON;
};

/** The bone a part's copy stands for (see isPartCopy); any other bone itself. */
export const originalBone = <T extends THREE.Object3D>(bone: T): T => {
  let current: THREE.Object3D = bone;
  while (isPartCopy(current)) current = current.parent as THREE.Object3D;
  return current as T;
};
