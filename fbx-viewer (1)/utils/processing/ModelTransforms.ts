
import * as THREE from 'three';
import { disposeMaterial } from './ModelLifecycle'; // Reuse internal helper if needed, or duplicate strictly local logic

const TARGET_MODEL_SIZE = 5;

/**
 * Normalizes the scale and position of the model to fit within the scene.
 */
export const normalizeModel = (group: THREE.Group) => {
  // 1. Reset Root Transform to Identity before measurement
  // This ensures we measure the true local bounds of the children content
  group.position.set(0, 0, 0);
  group.rotation.set(0, 0, 0);
  group.scale.set(1, 1, 1);
  group.updateMatrix();
  group.updateMatrixWorld(true); 

  const box = new THREE.Box3().setFromObject(group);
  
  // Handle empty or invalid bounds
  if (box.isEmpty()) {
      return [1, 1, 1];
  }

  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  
  box.getSize(size);
  box.getCenter(center);

  // 2. Calculate Scale to fit target size
  const maxAxis = Math.max(size.x, size.y, size.z);
  const scaleFactor = maxAxis > 0 ? TARGET_MODEL_SIZE / maxAxis : 1;
  group.scale.setScalar(scaleFactor);

  // 3. Center logic
  // We need to move the group such that the center of the content ends up at (0,0,0)
  // The content center is at 'center' (unscaled).
  // When scaled, the content center moves to 'center * scaleFactor'.
  // So we shift the group by '-center * scaleFactor'.
  
  group.position.x = -center.x * scaleFactor;
  group.position.z = -center.z * scaleFactor;
  // Sit on floor:
  // The bottom of the box is box.min.y. 
  // When scaled, it is box.min.y * scaleFactor.
  group.position.y = -box.min.y * scaleFactor;

  group.updateMatrix();

  return group.scale.toArray() as [number, number, number];
};

/**
 * Removes all Mesh and SkinnedMesh objects from the hierarchy, leaving only structure (Bones/Groups).
 * Useful for Animation-only assets.
 */
export const stripGeometry = (object: THREE.Object3D) => {
  const meshes: THREE.Mesh[] = [];
  object.traverse((child) => {
    if ((child as any).isMesh) {
      meshes.push(child as THREE.Mesh);
    }
  });

  meshes.forEach((mesh) => {
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) {
        if (Array.isArray(mesh.material)) {
            mesh.material.forEach(m => disposeMaterial(m));
        } else {
            disposeMaterial(mesh.material as THREE.Material);
        }
    }
    if (mesh.parent) mesh.parent.remove(mesh);
  });
};
