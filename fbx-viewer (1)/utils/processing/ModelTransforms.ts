import * as THREE from 'three';
import { DEFAULT_MODEL_IMPORT_SETTINGS, type LoadedModelData, type ModelImportSettings } from '../../types';
import { disposeMaterial } from './ModelLifecycle'; // Reuse internal helper if needed, or duplicate strictly local logic

/** Upper bound accepted by the project models schema for importSettings.targetSize. */
export const MAX_MODEL_TARGET_SIZE = 1000000;

/**
 * Coerces stored or user-entered import settings into a valid value. Missing or
 * malformed fields fall back to DEFAULT_MODEL_IMPORT_SETTINGS (the old behaviour).
 */
export const resolveImportSettings = (settings?: Partial<ModelImportSettings> | null): ModelImportSettings => {
  const normalize = typeof settings?.normalize === 'boolean' ? settings.normalize : DEFAULT_MODEL_IMPORT_SETTINGS.normalize;
  const size = Number(settings?.targetSize);
  const targetSize = Number.isFinite(size) && size > 0
    ? Math.min(MAX_MODEL_TARGET_SIZE, size)
    : DEFAULT_MODEL_IMPORT_SETTINGS.targetSize;
  return { normalize, targetSize };
};

/** True when the settings produce the same result as the default import. */
export const isDefaultImportSettings = (settings?: Partial<ModelImportSettings> | null): boolean => {
  const resolved = resolveImportSettings(settings);
  return resolved.normalize === DEFAULT_MODEL_IMPORT_SETTINGS.normalize
    && resolved.targetSize === DEFAULT_MODEL_IMPORT_SETTINGS.targetSize;
};

/**
 * Applies import settings to the model root and returns the root scale.
 * - normalize: scale so the largest dimension equals targetSize, centre on X/Z
 *   and sit the bounds on the floor (y = 0).
 * - otherwise: keep the authored scale and pivot (identity root transform).
 * The root transform is reset first, so re-applying different settings to an
 * already-normalized model is safe.
 */
export const normalizeModel = (
  group: THREE.Group,
  settings: ModelImportSettings = DEFAULT_MODEL_IMPORT_SETTINGS,
): [number, number, number] => {
  const { normalize, targetSize } = resolveImportSettings(settings);
  // 1. Reset Root Transform to Identity before measurement
  // This ensures we measure the true local bounds of the children content
  group.position.set(0, 0, 0);
  group.rotation.set(0, 0, 0);
  group.scale.set(1, 1, 1);
  group.updateMatrix();
  group.updateMatrixWorld(true); 

  if (!normalize) {
      return [1, 1, 1];
  }

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
  const scaleFactor = maxAxis > 0 ? targetSize / maxAxis : 1;
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
 * Applies a model's stored import settings after loading and records them on
 * the model. The loader already applied the default normalization, so only
 * non-default settings re-run it. Animation assets keep the loader transform.
 */
export const applyModelImportSettings = (
  model: LoadedModelData,
  settings?: Partial<ModelImportSettings> | null,
): ModelImportSettings => {
  const resolved = resolveImportSettings(settings);
  if (model.category !== 'Animation' && !isDefaultImportSettings(resolved)) {
    model.initialScale = normalizeModel(model.object, resolved);
  }
  model.importSettings = resolved;
  return resolved;
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
