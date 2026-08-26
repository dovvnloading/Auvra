
import * as THREE from 'three';
import { LoadedModelData } from '../../types';

/**
 * Clean up existing object URLs to prevent memory leaks.
 */
export const disposeModel = (model: LoadedModelData) => {
  if (model.url) {
    URL.revokeObjectURL(model.url);
  }
  if (model.object) {
    disposeObject(model.object);
  }
};

/**
 * Recursively disposes of geometries and materials within an object hierarchy.
 */
export const disposeObject = (object: THREE.Object3D) => {
  object.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      
      if (mesh.geometry) {
        mesh.geometry.dispose();
      }

      const material = mesh.material as THREE.Material | THREE.Material[];
      if (Array.isArray(material)) {
        material.forEach(m => disposeMaterial(m));
      } else {
        disposeMaterial(material);
      }
    }
  });
};

export const disposeMaterial = (material: THREE.Material) => {
  material.dispose();
  // Dispose of all textures associated with the material
  for (const key of Object.keys(material)) {
    const value = (material as any)[key];
    if (value && typeof value === 'object' && 'minFilter' in value && typeof value.dispose === 'function') {
      (value as THREE.Texture).dispose();
    }
  }
};
