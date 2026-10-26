import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { LevelObject } from '../../types';
import { createPrefabFromSubtree, findNonPrefabObject, getSelectionRoots, instantiatePrefab, pickPrefabRoot } from '../../utils/prefabs';

const object = (id: string, overrides: Partial<LevelObject> = {}): LevelObject => ({
  id,
  levelId: 'level-a',
  modelId: 'model-1',
  name: id,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  type: 'prop',
  ...overrides,
});

// group (parented under a rotated, scaled holder) -> arm -> hand; other is unrelated.
const level = (): LevelObject[] => [
  object('holder', { position: [10, 0, 0], rotation: [0, Math.PI / 2, 0], scale: [2, 2, 2] }),
  object('group', { parentId: 'holder', position: [1, 0, 0], prefabId: 'older-prefab' }),
  object('arm', { parentId: 'group', position: [0, 1, 0], components: [{ id: 'c1', type: 'rotator', enabled: true, props: { speed: 1 } }] }),
  object('hand', { parentId: 'arm', position: [0, 0, 2] }),
  object('other', { position: [5, 5, 5] }),
];

describe('createPrefabFromSubtree', () => {
  it('copies the subtree root first, with the root at the origin keeping its world rotation and scale', () => {
    const prefab = createPrefabFromSubtree(level(), 'group', '  Tree  ');

    expect(prefab.name).toBe('Tree');
    expect(prefab.rootId).toBe('group');
    expect(prefab.objects.map((item) => item.id)).toEqual(['group', 'arm', 'hand']);

    const [root, arm, hand] = prefab.objects;
    expect(root.parentId).toBeNull();
    expect(root.position).toEqual([0, 0, 0]);
    expect(root.rotation[1]).toBeCloseTo(Math.PI / 2);
    root.scale.forEach((value) => expect(value).toBeCloseTo(2));
    expect(arm).toMatchObject({ parentId: 'group', position: [0, 1, 0] });
    expect(hand).toMatchObject({ parentId: 'arm', position: [0, 0, 2] });

    // Level and prefab provenance are not stored; nested data is a detached copy.
    for (const item of prefab.objects) {
      expect(item).not.toHaveProperty('levelId');
      expect(item).not.toHaveProperty('prefabId');
    }
    const source = level();
    const copy = createPrefabFromSubtree(source, 'group', 'Tree');
    copy.objects[1].components![0].props.speed = 9;
    expect(source[2].components![0].props.speed).toBe(1);
  });

  it('falls back to the root name and rejects a missing root', () => {
    expect(createPrefabFromSubtree(level(), 'other', '').name).toBe('other');
    expect(() => createPrefabFromSubtree(level(), 'missing', 'x')).toThrow();
  });
});

describe('instantiatePrefab', () => {
  it('places a fresh copy with remapped parents, root offset by the placement point', () => {
    const prefab = createPrefabFromSubtree(level(), 'group', 'Tree');
    prefab.objects[0].position = [0, 1, 0];
    const placed = instantiatePrefab(prefab, 'level-b', [3, 0, -4]);

    expect(placed).toHaveLength(3);
    const ids = placed.map((item) => item.id);
    expect(new Set(ids).size).toBe(3);
    for (const id of ['group', 'arm', 'hand']) expect(ids).not.toContain(id);

    const [root, arm, hand] = placed;
    expect(root).toMatchObject({ levelId: 'level-b', parentId: null, position: [3, 1, -4], prefabId: prefab.id });
    expect(arm).toMatchObject({ parentId: root.id, position: [0, 1, 0], prefabId: prefab.id });
    expect(hand).toMatchObject({ parentId: arm.id, position: [0, 0, 2] });
    expect(arm.components).toHaveLength(1);
    expect(arm.components![0].id).not.toBe('c1');
    expect(arm.components![0]).toMatchObject({ type: 'rotator', props: { speed: 1 } });

    // Two placements never share object ids, and the prefab is not mutated.
    const again = instantiatePrefab(prefab, 'level-b', [0, 0, 0]);
    expect(again.some((item) => ids.includes(item.id))).toBe(false);
    expect(prefab.objects[0].position).toEqual([0, 1, 0]);
  });

  it('keeps the placed hierarchy world transform matching the source subtree', () => {
    const source = level();
    const prefab = createPrefabFromSubtree(source, 'group', 'Tree');
    const world = new THREE.Vector3();
    new THREE.Matrix4().compose(new THREE.Vector3(10, 0, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)), new THREE.Vector3(2, 2, 2))
      .multiply(new THREE.Matrix4().makeTranslation(1, 0, 0))
      .decompose(world, new THREE.Quaternion(), new THREE.Vector3());
    const placed = instantiatePrefab(prefab, 'level-a', world.toArray() as [number, number, number]);
    placed[0].position.forEach((value, index) => expect(value).toBeCloseTo(world.getComponent(index)));
    expect(placed[0].rotation[1]).toBeCloseTo(Math.PI / 2);
  });

  it('hangs members with a missing parent off the root and requires a root', () => {
    const prefab = createPrefabFromSubtree(level(), 'group', 'Tree');
    prefab.objects[2].parentId = 'gone';
    const placed = instantiatePrefab(prefab, 'level-a', [0, 0, 0]);
    expect(placed.map((item) => item.parentId)).toEqual([null, placed[0].id, placed[0].id]);
    expect(() => instantiatePrefab({ ...prefab, rootId: 'nope' }, 'level-a', [0, 0, 0])).toThrow();
  });
});

describe('prefab selection helpers', () => {
  it('uses the selection root holding the primary and reports the subtrees left out', () => {
    const objects = level();
    expect(getSelectionRoots(objects, ['hand', 'group', 'other']).map((item) => item.id)).toEqual(['group', 'other']);
    expect(pickPrefabRoot(objects, ['hand', 'group', 'other'], 'hand')).toEqual({ rootId: 'group', omitted: 1 });
    expect(pickPrefabRoot(objects, ['other', 'arm'], null)).toEqual({ rootId: 'other', omitted: 1 });
    expect(pickPrefabRoot(objects, [], null)).toEqual({ rootId: null, omitted: 0 });
  });

  it('flags level singletons inside the subtree', () => {
    const objects = [...level(), object('start', { type: 'player_start', parentId: 'arm', modelId: '' })];
    expect(findNonPrefabObject(objects, 'group')?.id).toBe('start');
    expect(findNonPrefabObject(objects, 'other')).toBeUndefined();
  });
});
