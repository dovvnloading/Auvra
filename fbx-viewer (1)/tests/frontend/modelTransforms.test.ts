import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_IMPORT_SETTINGS, type LoadedModelData } from '../../types';
import {
  applyModelImportSettings,
  isDefaultImportSettings,
  normalizeModel,
  resolveImportSettings,
} from '../../utils/processing/ModelTransforms';

/** A 2 x 4 x 1 box whose bounds start at (10, -3, 0): off-centre and below the floor. */
const authoredModel = () => {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 1));
  mesh.position.set(11, -1, 0.5);
  group.add(mesh);
  return group;
};

const worldBounds = (group: THREE.Group) => {
  group.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(group);
};

describe('normalizeModel', () => {
  it('fits the largest dimension to the target size, centred on X/Z and resting on the floor', () => {
    const group = authoredModel();
    const scale = normalizeModel(group, { normalize: true, targetSize: 8 });
    expect(scale).toEqual([2, 2, 2]);
    const box = worldBounds(group);
    const size = box.getSize(new THREE.Vector3());
    expect(Math.max(size.x, size.y, size.z)).toBeCloseTo(8);
    expect(box.min.y).toBeCloseTo(0);
    const center = box.getCenter(new THREE.Vector3());
    expect(center.x).toBeCloseTo(0);
    expect(center.z).toBeCloseTo(0);
  });

  it('defaults to the old behaviour (target size 5)', () => {
    const group = authoredModel();
    expect(normalizeModel(group)).toEqual([1.25, 1.25, 1.25]);
    expect(worldBounds(group).getSize(new THREE.Vector3()).y).toBeCloseTo(5);
  });

  it('keeps the authored scale and pivot when normalization is off', () => {
    const group = authoredModel();
    normalizeModel(group);
    // Re-applying is safe: the root transform from an earlier normalization is reset.
    expect(normalizeModel(group, { normalize: false, targetSize: 5 })).toEqual([1, 1, 1]);
    expect(group.position.toArray()).toEqual([0, 0, 0]);
    const box = worldBounds(group);
    expect(box.min.toArray()).toEqual([10, -3, 0]);
    expect(box.max.toArray()).toEqual([12, 1, 1]);
  });

  it('leaves empty models at unit scale', () => {
    expect(normalizeModel(new THREE.Group(), { normalize: true, targetSize: 3 })).toEqual([1, 1, 1]);
  });
});

describe('import settings', () => {
  it('falls back to defaults for missing or invalid values', () => {
    expect(resolveImportSettings(undefined)).toEqual(DEFAULT_MODEL_IMPORT_SETTINGS);
    expect(resolveImportSettings({ normalize: false, targetSize: -1 })).toEqual({ normalize: false, targetSize: 5 });
    expect(resolveImportSettings({ targetSize: Number.NaN })).toEqual(DEFAULT_MODEL_IMPORT_SETTINGS);
    expect(resolveImportSettings({ normalize: true, targetSize: 1e9 }).targetSize).toBe(1000000);
    expect(isDefaultImportSettings(null)).toBe(true);
    expect(isDefaultImportSettings({ normalize: true, targetSize: 2 })).toBe(false);
  });

  it('applies stored settings to a loaded model and records them', () => {
    const object = authoredModel();
    normalizeModel(object);
    const model = { id: 'm', name: 'm.fbx', url: '', object, animations: [], category: 'Prop', isPlacedInScene: false, initialScale: [1.25, 1.25, 1.25] } as LoadedModelData;
    expect(applyModelImportSettings(model, { normalize: false, targetSize: 5 })).toEqual({ normalize: false, targetSize: 5 });
    expect(model.initialScale).toEqual([1, 1, 1]);
    expect(model.importSettings).toEqual({ normalize: false, targetSize: 5 });

    const animation = { ...model, category: 'Animation', initialScale: [0.01, 0.01, 0.01] } as LoadedModelData;
    applyModelImportSettings(animation, { normalize: true, targetSize: 2 });
    expect(animation.initialScale).toEqual([0.01, 0.01, 0.01]);
  });
});
