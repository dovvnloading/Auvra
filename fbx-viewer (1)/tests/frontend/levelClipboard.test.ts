import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LevelObject } from '../../types';
import { getWorldMatrix } from '../../utils/sceneGraph';
import {
  copyLevelObjects,
  parseLevelClipboard,
  pasteLevelObjects,
  readLevelClipboard,
  resetLevelClipboardMemory,
  writeLevelClipboard,
} from '../../utils/levelClipboard';

const obj = (id: string, overrides: Partial<LevelObject> = {}): LevelObject => ({
  id,
  levelId: 'level-1',
  modelId: 'model-1',
  name: id,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  type: 'prop',
  ...overrides,
});

const sequentialIds = () => {
  let next = 0;
  return () => `new-${++next}`;
};

const worldPosition = (objects: LevelObject[], id: string) =>
  new THREE.Vector3().setFromMatrixPosition(getWorldMatrix(objects, id)).toArray();

// parent (at x=10, scaled 2) -> child (local x=1) -> grandchild (local y=1); `other` is unrelated.
const level = (): LevelObject[] => [
  obj('parent', { position: [10, 0, 0], scale: [2, 2, 2] }),
  obj('child', { parentId: 'parent', position: [1, 0, 0], components: [{ id: 'c1', type: 'rotator', enabled: true, props: { speed: 1 } }] }),
  obj('grandchild', { parentId: 'child', position: [0, 1, 0] }),
  obj('other', { position: [-5, 0, 0] }),
  obj('terrain', { type: 'terrain', modelId: '' }),
];

describe('levelClipboard', () => {
  beforeEach(() => {
    resetLevelClipboardMemory();
    localStorage.clear();
  });

  it('copies whole subtrees once, parents first, without levelId or singletons', () => {
    const payload = copyLevelObjects(level(), ['child', 'parent', 'terrain'])!;
    expect(payload.objects.map((object) => object.id)).toEqual(['parent', 'child', 'grandchild']);
    expect(payload.objects.every((object) => !('levelId' in object))).toBe(true);
    expect(copyLevelObjects(level(), ['terrain'])).toBeNull();
    expect(copyLevelObjects(level(), ['missing'])).toBeNull();
  });

  it('duplicates with fresh ids, remapped links, new component ids and a root offset', () => {
    const objects = level();
    const payload = copyLevelObjects(objects, ['parent'])!;
    const pasted = pasteLevelObjects(payload, { levelId: 'level-1', levelObjects: objects, offset: [1, 0, 1], createId: sequentialIds() });

    expect(pasted.objects.map((object) => object.id)).toEqual(['new-1', 'new-2', 'new-3']);
    expect(pasted.rootIds).toEqual(['new-1']);
    const [root, child, grandchild] = pasted.objects;
    expect(root.parentId).toBeUndefined();
    expect(root.position).toEqual([11, 0, 1]);
    expect(child.parentId).toBe('new-1');
    expect(child.position).toEqual([1, 0, 0]);
    expect(grandchild.parentId).toBe('new-2');
    expect(child.components?.[0]).toEqual({ id: 'new-4', type: 'rotator', enabled: true, props: { speed: 1 } });
    expect(pasted.objects.every((object) => object.levelId === 'level-1')).toBe(true);
    // The source documents are untouched.
    expect(objects[1].components?.[0].id).toBe('c1');
  });

  it('numbers a copy whose name the level already uses', () => {
    const objects = [
      { ...level()[0], id: 'a', name: 'Crate 1', parentId: null },
      { ...level()[0], id: 'b', name: 'Crate 8', parentId: null },
      { ...level()[0], id: 'c', name: 'Rock', parentId: null },
    ];
    const payload = copyLevelObjects(objects, ['a', 'c'])!;
    const pasted = pasteLevelObjects(payload, { levelId: 'level-1', levelObjects: objects, createId: sequentialIds() });
    expect(pasted.objects.map((object) => object.name).sort()).toEqual(['Crate 9', 'Rock 2']);
    // Another level that has neither name keeps them.
    const elsewhere = pasteLevelObjects(payload, { levelId: 'level-2', levelObjects: [], createId: sequentialIds() });
    expect(elsewhere.objects.map((object) => object.name).sort()).toEqual(['Crate 1', 'Rock']);
  });

  it('keeps a link to a parent that exists in the target level', () => {
    const objects = level();
    const payload = copyLevelObjects(objects, ['child'])!;
    const pasted = pasteLevelObjects(payload, { levelId: 'level-1', levelObjects: objects, createId: sequentialIds() });
    expect(pasted.objects[0].parentId).toBe('parent');
    expect(pasted.objects[0].position).toEqual([1, 0, 0]);
    expect(pasted.objects[1].parentId).toBe('new-1');
  });

  it('pastes into another level in world space when the parent is absent', () => {
    const objects = level();
    const payload = copyLevelObjects(objects, ['child'])!;
    const pasted = pasteLevelObjects(payload, { levelId: 'level-2', levelObjects: [], createId: sequentialIds() });
    const [child, grandchild] = pasted.objects;
    expect(child.levelId).toBe('level-2');
    expect(child.parentId).toBeUndefined();
    expect(child.position[0]).toBeCloseTo(12);
    expect(child.scale[0]).toBeCloseTo(2);
    // Same world placement as the original grandchild.
    const original = worldPosition(objects, 'grandchild');
    worldPosition(pasted.objects, grandchild.id).forEach((value, axis) => expect(value).toBeCloseTo(original[axis]));
  });

  it('leaves out unplaceable objects and places their children in world space', () => {
    const objects = level();
    const payload = copyLevelObjects(objects, ['parent'])!;
    const pasted = pasteLevelObjects(payload, {
      levelId: 'level-1',
      levelObjects: objects,
      canPlace: (object) => object.id !== 'child',
      createId: sequentialIds(),
    });
    expect(pasted.objects).toHaveLength(2);
    expect(pasted.rootIds).toEqual(['new-1', 'new-2']);
    const grandchild = pasted.objects[1];
    expect(grandchild.parentId).toBeUndefined();
    expect(grandchild.position[0]).toBeCloseTo(12);
    expect(grandchild.position[1]).toBeCloseTo(2);
  });

  it('round-trips through memory and localStorage and rejects foreign data', () => {
    const payload = copyLevelObjects(level(), ['other'])!;
    expect(readLevelClipboard()).toBeNull();
    writeLevelClipboard(payload);
    expect(readLevelClipboard()).toBe(payload);
    resetLevelClipboardMemory();
    expect(readLevelClipboard()).toEqual(payload);

    expect(parseLevelClipboard('not json')).toBeNull();
    expect(parseLevelClipboard({ format: 'other', objects: [], world: {} })).toBeNull();
    expect(parseLevelClipboard({ ...payload, objects: [{ ...payload.objects[0], position: [0, 'x', 0] }] })).toBeNull();
  });
});
