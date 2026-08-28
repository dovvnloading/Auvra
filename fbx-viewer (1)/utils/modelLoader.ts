
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader';
import { LoadedModelData } from '../types';
import { optimizeModelMaterials } from './processing/ModelMaterials';
import { normalizeModel } from './processing/ModelTransforms';

// Re-export specific utilities for consumers (hooks) to maintain API compatibility
export { disposeModel, disposeObject } from './processing/ModelLifecycle';
export { stripGeometry } from './processing/ModelTransforms';

interface LoadOptions {
  normalize?: boolean;
  manualId?: string;
}

/**
 * Orchestrates the loading of an FBX file.
 * 1. Loads the file via FBXLoader.
 * 2. Cleanses animations.
 * 3. Optimizes materials (Phong -> Standard, PBR fixes).
 * 4. Normalizes scale and position (optional).
 */
export const loadFBXFile = async (file: File, options: LoadOptions = { normalize: true }): Promise<LoadedModelData> => {
  // Create object URL for the file
  const url = URL.createObjectURL(file);
  
  try {
    const manager = new THREE.LoadingManager();
    const loader = new FBXLoader(manager);
    
    // NOTE: Do NOT set setResourcePath(url) for blob URLs. 
    // It breaks relative path resolution for embedded textures in many browsers.
    // FBXLoader handles embedded blobs internally.

    const object = await new Promise<THREE.Group>((resolve, reject) => {
      loader.load(
        url,
        (obj) => resolve(obj),
        (progress) => {
           // Optional: Handle progress
        },
        (err) => reject(err)
      );
    });

    // --- FILTER ANIMATIONS ---
    // Reject only empty/invalid clips. Short authored clips are valid assets.
    if (object.animations) {
       object.animations = object.animations.filter(
         clip => Number.isFinite(clip.duration) && clip.duration > 0 && clip.tracks.length > 0,
       );
    }

    // --- OPTIMIZE MATERIALS ---
    optimizeModelMaterials(object);
    
    // --- RENAME ANIMATIONS ---
    if (object.animations && object.animations.length > 0) {
        const cleanName = file.name.replace(/\.(fbx|FBX)$/, '');
        
        if (object.animations.length === 1) {
             // If strictly one animation, assume it belongs to the file and rename it to file name
             object.animations[0].name = cleanName;
        } else {
             // If multiple, only rename known generic names
             object.animations.forEach((clip, index) => {
                if (clip.name === 'Take 001' || clip.name === 'mixamo.com') {
                    clip.name = `${cleanName} ${index + 1}`;
                }
             });
        }
    }
    
    let initialScale: [number, number, number] = [1, 1, 1];
    
    if (options.normalize) {
      initialScale = normalizeModel(object) as [number, number, number];
    } else {
      // For attachments, scale down only if massive (unit conversion artifact)
      const box = new THREE.Box3().setFromObject(object);
      const size = new THREE.Vector3();
      box.getSize(size);
      const maxAxis = Math.max(size.x, size.y, size.z);
      if (maxAxis > 50) { // If it's huge (cm vs m), scale down
         object.scale.setScalar(0.01);
         initialScale = object.scale.toArray() as [number, number, number];
      }
    }

    return {
      id: options.manualId || crypto.randomUUID(),
      name: file.name,
      url, // Keep URL to revoke later
      object,
      animations: object.animations || [],
      category: 'Prop',
      isPlacedInScene: false,
      initialScale
    };

  } catch (err) {
      // Clean up URL if loading fails
      URL.revokeObjectURL(url);
      throw err;
  }
};
