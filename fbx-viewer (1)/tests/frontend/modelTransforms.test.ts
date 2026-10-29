import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_IMPORT_SETTINGS, type LoadedModelData } from '../../types';
import {
  applyModelImportSettings,
  isDefaultImportSettings,
  normalizeModel,
  resolveImportSettings,
  SOURCE_METRES_PER_UNIT,
} from '../../utils/processing/ModelTransforms';
import { fbxMetresPerUnit, fbxUnitScaleFactor } from '../../utils/processing/fbxUnits';

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

  it("keeps the authored size in metres when the source says it is authored in another unit", () => {
    const group = authoredModel();
    group.userData[SOURCE_METRES_PER_UNIT] = 0.01;
    normalizeModel(group);
    expect(normalizeModel(group, { normalize: false, targetSize: 5 })).toEqual([0.01, 0.01, 0.01]);
    const box = worldBounds(group);
    expect(box.getSize(new THREE.Vector3()).y).toBeCloseTo(0.04, 9);
    expect(box.min.x).toBeCloseTo(0.1, 9);
    // Normalizing still fits the target size whatever the unit.
    expect(normalizeModel(group, { normalize: true, targetSize: 5 })).toEqual([1.25, 1.25, 1.25]);
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

describe('FBX units', () => {
  /** A binary FBX fragment: the magic, then property records as an FBX writes them. */
  const binary = (records: [string, string | number][][]) => {
    const parts: number[] = [...Array.from('Kaydara FBX Binary  \0', c => c.charCodeAt(0)), 0x1a, 0, 0xe8, 0x1c, 0, 0];
    for (const record of records) {
      for (const [type, value] of record) {
        parts.push(type.charCodeAt(0));
        if (type === 'S') {
          const text = String(value);
          parts.push(text.length & 0xff, (text.length >> 8) & 0xff, 0, 0, ...Array.from(text, c => c.charCodeAt(0)));
        } else {
          const bytes = new Uint8Array(8);
          new DataView(bytes.buffer).setFloat64(0, Number(value), true);
          parts.push(...bytes);
        }
      }
    }
    return new Uint8Array(parts).buffer;
  };
  const property = (name: string, value: number): [string, string | number][] =>
    [['S', name], ['S', 'double'], ['S', 'Number'], ['S', ''], ['D', value]];

  it('reads the unit a binary FBX is authored in, not its original unit', () => {
    const file = binary([property('OriginalUnitScaleFactor', 100), property('UnitScaleFactor', 1)]);
    expect(fbxUnitScaleFactor(file)).toBe(1);
    expect(fbxMetresPerUnit(file)).toBe(0.01);
    expect(fbxMetresPerUnit(binary([property('UnitScaleFactor', 100)]))).toBe(1);
  });

  it('reads an ASCII FBX, and says nothing for a file without the setting or with a bad one', () => {
    const ascii = new TextEncoder().encode('GlobalSettings:  {\n  P: "UnitScaleFactor", "double", "Number", "",2.54\n}').buffer;
    expect(fbxUnitScaleFactor(ascii)).toBe(2.54);
    expect(fbxMetresPerUnit(binary([property('OriginalUnitScaleFactor', 100)]))).toBeNull();
    expect(fbxMetresPerUnit(binary([property('UnitScaleFactor', 0)]))).toBeNull();
    expect(fbxMetresPerUnit(new TextEncoder().encode('; FBX 7.4.0 project file').buffer)).toBeNull();
  });
});
