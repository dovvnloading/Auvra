import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  decodeFoliageInstances, DEFAULT_FOLIAGE_TYPE, editFoliageInstances, encodeFoliageInstances, externalizeFoliageData, FOLIAGE_INSTANCE_FLOATS,
  foliageInstanceCount, foliageInstanceMatrix, followTerrainEdit, isFoliageTypePending, resolveFoliageInstances, sanitizeFoliageType, writeFoliageMatrix,
  type FoliageType,
} from '../../runtime/foliage';
import {
  FoliageHash, foliageDefaultsFor, foliageFits, foliageHashOf, foliageRotation, foliageScale, instancesWanted, placeFoliageInstance, type FoliageGround,
} from '../../components/Environment/Foliage/foliagePlacement';

const type = (changes: Partial<FoliageType> = {}): FoliageType => ({ ...DEFAULT_FOLIAGE_TYPE, id: 't', modelId: 'm', ...changes });

const ground = (slope = 0, y = 0, layers: Record<string, number> | null = null): FoliageGround => {
  const angle = (slope * Math.PI) / 180;
  return {
    point: new THREE.Vector3(1, y, 2),
    normal: new THREE.Vector3(Math.sin(angle), Math.cos(angle), 0),
    layerWeight: layers ? (name) => layers[name] ?? null : undefined,
  };
};

const fixedRandom = (value: number) => () => value;

describe('foliage types', () => {
  it('fills in and clamps a stored type', () => {
    const clean = sanitizeFoliageType({ id: 'a', modelId: 'b', density: -4, scaleX: [2, 1], slope: [0, 500], scaleMode: 'nonsense', collision: 'trunk' });
    expect(clean.density).toBe(0);
    expect(clean.scaleX).toEqual([1, 2]);
    expect(clean.slope).toEqual([0, 90]);
    expect(clean.scaleMode).toBe('uniform');
    expect(clean.collision).toBe('trunk');
    expect(clean.castShadow).toBe(true);
  });

  it('counts instances before and after they load', () => {
    const reference = { assetId: 'x', encoding: 'float32le-10' as const, count: 7 };
    expect(foliageInstanceCount({ instancemap: reference })).toBe(7);
    expect(isFoliageTypePending({ instancemap: reference })).toBe(true);
    expect(foliageInstanceCount({ instancemap: reference, instances: new Float32Array(FOLIAGE_INSTANCE_FLOATS * 3) })).toBe(3);
    expect(isFoliageTypePending({ instancemap: reference, instances: new Float32Array(0) })).toBe(false);
  });
});

describe('foliage storage', () => {
  it('round trips instances through their asset', () => {
    const instances = new Float32Array([1, 2, 3, 0, 0, 0, 1, 2, 2, 2, 4, 5, 6, 0, 1, 0, 0, 1, 1, 1]);
    const decoded = decodeFoliageInstances(encodeFoliageInstances(instances));
    expect([...decoded]).toEqual([...instances]);
  });

  it('refuses a damaged asset', () => {
    const bytes = encodeFoliageInstances(new Float32Array(FOLIAGE_INSTANCE_FLOATS));
    expect(() => decodeFoliageInstances(bytes.subarray(0, 20))).toThrow();
    const wrong = bytes.slice();
    wrong[0] = 0;
    expect(() => decodeFoliageInstances(wrong)).toThrow();
    expect(() => encodeFoliageInstances(new Float32Array(FOLIAGE_INSTANCE_FLOATS).fill(Number.NaN))).toThrow();
  });

  it('replaces in-memory instances with a reference, and never writes them out', async () => {
    const upload = vi.fn(async () => 'a'.repeat(64));
    const instances = new Float32Array(FOLIAGE_INSTANCE_FLOATS * 2);
    const { types } = await externalizeFoliageData({ types: [type({ instances })] }, upload);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(types[0].instances).toBeUndefined();
    expect(types[0].instancemap).toEqual({ assetId: 'a'.repeat(64), encoding: 'float32le-10', count: 2 });
  });

  it('uploads again unless the document being replaced still names the asset, as undo needs', async () => {
    const upload = vi.fn(async () => 'b'.repeat(64));
    const instances = new Float32Array(FOLIAGE_INSTANCE_FLOATS);
    await externalizeFoliageData({ types: [type({ instances })] }, upload);
    await externalizeFoliageData({ types: [type({ instances })] }, upload, new Set(['b'.repeat(64)]));
    expect(upload).toHaveBeenCalledTimes(1);
    await externalizeFoliageData({ types: [type({ instances })] }, upload, new Set(['someone else']));
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('keeps a reference it has not loaded, and drops one for a type emptied', async () => {
    const upload = vi.fn(async () => 'c');
    const reference = { assetId: 'd'.repeat(64), encoding: 'float32le-10' as const, count: 3 };
    const kept = await externalizeFoliageData({ types: [type({ instancemap: reference })] }, upload);
    expect(kept.types[0].instancemap).toEqual(reference);
    const emptied = await externalizeFoliageData({ types: [type({ instancemap: reference, instances: new Float32Array(0) })] }, upload);
    expect(emptied.types[0].instancemap).toBeUndefined();
    expect(upload).not.toHaveBeenCalled();
  });

  it('refuses an encoding it does not know', async () => {
    await expect(resolveFoliageInstances({ assetId: 'x', encoding: 'other' as 'float32le-10', count: 1 }, async () => new ArrayBuffer(0))).rejects.toThrow();
  });
});

describe('foliage instances', () => {
  it('round trips a matrix', () => {
    const instances = new Float32Array(FOLIAGE_INSTANCE_FLOATS);
    const position = new THREE.Vector3(1, 2, 3);
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.4, 0.1));
    const scale = new THREE.Vector3(2, 3, 4);
    writeFoliageMatrix(instances, 0, new THREE.Matrix4().compose(position, rotation, scale));
    const read = foliageInstanceMatrix(instances, 0, new THREE.Matrix4());
    const backPosition = new THREE.Vector3();
    const backScale = new THREE.Vector3();
    read.decompose(backPosition, new THREE.Quaternion(), backScale);
    expect(backPosition.distanceTo(position)).toBeLessThan(1e-5);
    expect(backScale.distanceTo(scale)).toBeLessThan(1e-5);
  });

  it('adds and removes without touching the array it was given', () => {
    const instances = new Float32Array(FOLIAGE_INSTANCE_FLOATS * 3).map((_, index) => index);
    const added = new Array<number>(FOLIAGE_INSTANCE_FLOATS).fill(99);
    const next = editFoliageInstances(instances, new Set([1]), added);
    expect(next.length).toBe(FOLIAGE_INSTANCE_FLOATS * 3);
    expect(next[0]).toBe(0);
    expect(next[FOLIAGE_INSTANCE_FLOATS]).toBe(20);
    expect(next[FOLIAGE_INSTANCE_FLOATS * 2]).toBe(99);
    expect(instances[FOLIAGE_INSTANCE_FLOATS]).toBe(10);
  });

  it('follows the terrain where it stands on it, and only there', () => {
    const at = (x: number, y: number, z: number) => [x, y, z, 0, 0, 0, 1, 1, 1, 1];
    const instances = new Float32Array([...at(0, 10, 0), ...at(50, 10, 0), ...at(0, 30, 0), ...at(999, 10, 0)]);
    const before = (x: number) => (x > 500 ? null : 10);
    const after = (x: number) => (x > 500 ? null : x < 10 ? 14 : 10);
    const moved = followTerrainEdit(instances, before, after)!;
    expect(moved[1]).toBe(14);
    // The ground did not move there.
    expect(moved[FOLIAGE_INSTANCE_FLOATS + 1]).toBe(10);
    // It stands 20 metres above the terrain, on something else.
    expect(moved[FOLIAGE_INSTANCE_FLOATS * 2 + 1]).toBe(30);
    // Off the terrain.
    expect(moved[FOLIAGE_INSTANCE_FLOATS * 3 + 1]).toBe(10);
    expect(instances[1]).toBe(10);
    expect(followTerrainEdit(instances, before, before)).toBeNull();
  });
});

describe('foliage rules', () => {
  it('keeps to its slope and height', () => {
    const rule = type({ slope: [10, 40], height: [0, 100] });
    expect(foliageFits(rule, ground(20, 50))).toBe(true);
    expect(foliageFits(rule, ground(5, 50))).toBe(false);
    expect(foliageFits(rule, ground(60, 50))).toBe(false);
    expect(foliageFits(rule, ground(20, 200))).toBe(false);
  });

  it('keeps to the terrain layers it is told to', () => {
    const only = type({ includeLayers: ['Grass'], minLayerWeight: 0.5 });
    expect(foliageFits(only, ground(0, 0, { Grass: 0.8 }))).toBe(true);
    expect(foliageFits(only, ground(0, 0, { Grass: 0.2 }))).toBe(false);
    // Off the terrain there is no grass to grow on.
    expect(foliageFits(only, ground())).toBe(false);
    const never = type({ excludeLayers: ['Road'], minLayerWeight: 0.5 });
    expect(foliageFits(never, ground(0, 0, { Road: 0.9 }))).toBe(false);
    expect(foliageFits(never, ground(0, 0, { Road: 0.1 }))).toBe(true);
    expect(foliageFits(never, ground())).toBe(true);
  });

  it('sizes by its scaling mode', () => {
    const ranges = { scaleX: [2, 2] as [number, number], scaleY: [3, 3] as [number, number], scaleZ: [4, 4] as [number, number] };
    expect(foliageScale(type({ ...ranges, scaleMode: 'uniform' }), Math.random)).toEqual([2, 2, 2]);
    expect(foliageScale(type({ ...ranges, scaleMode: 'lockWidth' }), Math.random)).toEqual([2, 3, 2]);
    expect(foliageScale(type({ ...ranges, scaleMode: 'free' }), Math.random)).toEqual([2, 3, 4]);
  });

  it('stands upright unless told to lean, and leans no further than allowed', () => {
    const up = new THREE.Vector3(0, 1, 0);
    const slope = ground(60).normal;
    const result = new THREE.Quaternion();
    const tilt = () => new THREE.Vector3(0, 1, 0).applyQuaternion(result).angleTo(up) * (180 / Math.PI);
    foliageRotation(type({ alignToNormal: false, randomYaw: false }), slope, fixedRandom(0.5), result);
    expect(tilt()).toBeCloseTo(0, 3);
    foliageRotation(type({ alignToNormal: true, alignMaxAngle: 90, randomYaw: false }), slope, fixedRandom(0.5), result);
    expect(tilt()).toBeCloseTo(60, 3);
    foliageRotation(type({ alignToNormal: true, alignMaxAngle: 25, randomYaw: false }), slope, fixedRandom(0.5), result);
    expect(tilt()).toBeCloseTo(25, 3);
  });

  it('places an instance offset along its up', () => {
    const out: number[] = [];
    const position = placeFoliageInstance(type({ zOffset: [2, 2], randomYaw: false }), ground(0, 10), fixedRandom(0.5), out);
    expect(position.y).toBeCloseTo(12);
    expect(out).toHaveLength(FOLIAGE_INSTANCE_FLOATS);
    expect(out[1]).toBeCloseTo(12);
  });

  it('wants instances for its density, leaving the fraction to chance', () => {
    // 5 per 100 m², over 100 m².
    expect(instancesWanted(5, 100, 1, fixedRandom(0.9))).toBe(5);
    expect(instancesWanted(5, 100, 0.5, fixedRandom(0.9))).toBe(2);
    expect(instancesWanted(5, 100, 0.5, fixedRandom(0.1))).toBe(3);
  });

  it('suggests a sparser density and wider spacing for bigger models', () => {
    const small = foliageDefaultsFor(0.5);
    const large = foliageDefaultsFor(8);
    expect(large.density).toBeLessThan(small.density);
    expect(large.radius).toBeGreaterThan(small.radius);
  });
});

describe('foliage hash', () => {
  it('finds what is near and forgets what is removed', () => {
    const hash = new FoliageHash(2);
    hash.add(0, 0, 0, 0);
    hash.add(1, 5, 0, 0);
    hash.add(2, -30, 0, 30);
    expect(hash.count(0, 0, 6)).toBe(2);
    expect(hash.occupied(0.5, 0, 1)).toBe(true);
    expect(hash.occupied(2.5, 0, 1)).toBe(false);
    hash.remove(0);
    expect(hash.count(0, 0, 6)).toBe(1);
  });

  it('builds from stored instances', () => {
    const instances = new Float32Array(FOLIAGE_INSTANCE_FLOATS * 2);
    instances[0] = 3;
    instances[FOLIAGE_INSTANCE_FLOATS] = 100;
    const hash = foliageHashOf(instances, 1);
    expect(hash.count(3, 0, 1)).toBe(1);
    expect(hash.count(100, 0, 1)).toBe(1);
    expect(foliageHashOf(undefined, 1).count(0, 0, 100)).toBe(0);
  });
});
