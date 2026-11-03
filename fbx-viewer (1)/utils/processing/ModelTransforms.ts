import * as THREE from 'three';
import { DEFAULT_MODEL_IMPORT_SETTINGS, type LoadedModelData, type ModelImportSettings } from '../../types';
import { disposeMaterial } from './ModelLifecycle'; // Reuse internal helper if needed, or duplicate strictly local logic
import { humanoidRole } from '../retargeting';
import type { ModelFileReport } from '../fbxImport/nativeImporter';
import { resolveClipRanges, type ModelReadOptions } from '../clipRanges';

/** userData key on a loaded model's root: metres per unit its source file says it is authored in. */
export const SOURCE_METRES_PER_UNIT = 'sourceMetresPerUnit';

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
  const resolved: ModelImportSettings = { normalize, targetSize };
  // What the rest says only goes on the model when it says something, as older models have none of it.
  for (const key of ['animation', 'morphTargets', 'looseMeshes', 'recomputeNormals', 'tangents'] as const) {
    if (typeof settings?.[key] === 'boolean') resolved[key] = settings[key];
  }
  if (Array.isArray(settings?.excludedClips) && settings.excludedClips.length) {
    resolved.excludedClips = settings.excludedClips.filter((name) => typeof name === 'string' && name.length > 0).slice(0, 1024);
  }
  const clipRanges = resolveClipRanges(settings?.clipRanges);
  if (clipRanges.length) resolved.clipRanges = clipRanges;
  const threshold = Number(settings?.keyThreshold);
  if (settings?.keyThreshold !== undefined && Number.isFinite(threshold) && threshold >= 0 && threshold <= 1) resolved.keyThreshold = threshold;
  const angle = Number(settings?.smoothingAngle);
  if (settings?.smoothingAngle !== undefined && Number.isFinite(angle) && angle > 0 && angle <= 180) resolved.smoothingAngle = angle;
  return resolved;
};

/** How a model file is read for these settings; an option the settings do not mention keeps its default. */
export const convertOptionsFor = (settings?: Partial<ModelImportSettings> | null): ModelReadOptions | undefined => {
  if (!settings) return undefined;
  const { animation, morphTargets, looseMeshes, recomputeNormals, tangents, excludedClips, clipRanges, keyThreshold, smoothingAngle } = resolveImportSettings(settings);
  const options: ModelReadOptions = {
    ...(animation !== undefined ? { animation } : {}),
    ...(morphTargets !== undefined ? { morphTargets } : {}),
    ...(looseMeshes !== undefined ? { looseMeshes } : {}),
    ...(recomputeNormals !== undefined ? { recomputeNormals } : {}),
    ...(tangents !== undefined ? { tangents } : {}),
    ...(excludedClips ? { excludedClips } : {}),
    ...(clipRanges ? { clipRanges } : {}),
    ...(keyThreshold !== undefined ? { keyThreshold } : {}),
    ...(smoothingAngle !== undefined ? { smoothingAngle } : {}),
  };
  return Object.keys(options).length ? options : undefined;
};

/** The height a person-shaped model is made when its file says something no person is, in metres. */
export const PERSON_HEIGHT = 1.8;
const MIN_PERSON_HEIGHT = 1;
const MAX_PERSON_HEIGHT = 2.6;
/** Outside these the file's unit cannot be meant: a model is fitted to a size rather than kept at it. */
const MIN_PLAUSIBLE_SIZE = 0.02;
const MAX_PLAUSIBLE_SIZE = 500;
/** A rigged file's loose meshes are left out unless they are this big a share of its triangles. */
const LOOSE_MESH_SHARE = 0.1;

/** A file's size at its own unit in metres, width by height by depth; null without geometry. */
export const reportSize = (report: ModelFileReport, keepLoose = true): [number, number, number] | null => {
  const min = keepLoose ? report.boundsMin : report.boundsWithoutLooseMin ?? report.boundsMin;
  const max = keepLoose ? report.boundsMax : report.boundsWithoutLooseMax ?? report.boundsMax;
  if (!min || !max) return null;
  const unit = report.metresPerUnit > 0 ? report.metresPerUnit : 1;
  return [(max[0] - min[0]) * unit, (max[1] - min[1]) * unit, (max[2] - min[2]) * unit];
};

/** Whether a skeleton's names make it person-shaped: a spine with a head, two arms and two legs. */
const isPersonShaped = (boneNames: readonly string[]): boolean => {
  const roles = new Set(boneNames.map(humanoidRole));
  return ['Hips', 'Head', 'LeftUpperArm', 'RightUpperArm', 'LeftUpperLeg', 'RightUpperLeg'].every((role) => roles.has(role));
};

export interface SuggestedImport {
  settings: ModelImportSettings;
  /** Why the settings differ from keeping the file as it is, for the dialog to say. */
  note?: string;
}

/**
 * The import a file should start with: the size it says it is, without the loose meshes a rigged
 * file should not have. A person whose file makes them a giant or a child, as some Mixamo exports
 * do, comes in at a person's height instead, and so does a model whose unit cannot be right.
 */
export const suggestedImportSettings = (report: ModelFileReport | null): SuggestedImport => {
  const looseTriangles = report?.looseMeshes?.reduce((sum, mesh) => sum + mesh.triangles, 0) ?? 0;
  const dropLoose = !!report?.looseMeshes?.length && looseTriangles <= (report.triangles || 0) * LOOSE_MESH_SHARE;
  const base: ModelImportSettings = { normalize: false, targetSize: DEFAULT_MODEL_IMPORT_SETTINGS.targetSize, ...(report?.looseMeshes?.length ? { looseMeshes: !dropLoose } : {}) };
  const size = report ? reportSize(report, !dropLoose) : null;
  if (!size) return { settings: base };
  const largest = Math.max(...size);
  const rounded = Number(largest.toPrecision(3));
  if (largest > 0 && (largest < MIN_PLAUSIBLE_SIZE || largest > MAX_PLAUSIBLE_SIZE)) {
    return {
      settings: { ...base, normalize: true, targetSize: 2 },
      note: `The file makes this model ${rounded} m across, so it is set to fit 2 m.`,
    };
  }
  base.targetSize = largest > 0 ? rounded : base.targetSize;
  const height = size[1];
  if (report && isPersonShaped(report.boneNames ?? []) && (height < MIN_PERSON_HEIGHT || height > MAX_PERSON_HEIGHT)) {
    // Fitting works on the largest side: this is the size that makes the height a person's.
    const fitted = Number((largest * PERSON_HEIGHT / height).toPrecision(4));
    return {
      settings: { ...base, normalize: true, targetSize: fitted },
      note: `The file makes this character ${Number(height.toPrecision(3))} m tall, so it is set to ${PERSON_HEIGHT} m.`,
    };
  }
  return { settings: base };
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
 * - otherwise: keep the authored size and pivot: unit scale, or the source's own unit in metres
 *   when its file says (an FBX authored in centimetres comes in at a hundredth).
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
      const unit = group.userData[SOURCE_METRES_PER_UNIT];
      if (typeof unit === 'number' && Number.isFinite(unit) && unit > 0 && unit !== 1) {
          group.scale.setScalar(unit);
          group.updateMatrix();
          return [unit, unit, unit];
      }
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
