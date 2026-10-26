import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { LevelObject } from '../../types';
import {
  collectSubtree,
  getChildren,
  getWorldMatrix,
  reparentPreservingWorld,
  sortByHierarchy,
  toLocalTransform,
  wouldCreateCycle,
} from '../../utils/sceneGraph';

const obj = (id: string, overrides: Partial<LevelObject> = {}): LevelObject => ({
  id,
  levelId: 'level-1',
  modelId: '',
  name: id,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  type: 'prop',
  ...overrides,
});

const worldPosition = (objects: LevelObject[], id: string) =>
  new THREE.Vector3().setFromMatrixPosition(getWorldMatrix(objects, id));

const expectVectorClose = (actual: THREE.Vector3, expected: [number, number, number]) => {
  expect(actual.x).toBeCloseTo(expected[0], 6);
  expect(actual.y).toBeCloseTo(expected[1], 6);
  expect(actual.z).toBeCloseTo(expected[2], 6);
};

const ids = (objects: LevelObject[]) => objects.map((object) => object.id);

describe('scene graph', () => {
  // root (translated, rotated 90deg about Y, scaled x2) -> mid (translated) -> leaf (translated)
  const chain = (): LevelObject[] => [
    obj('root', { position: [10, 0, 0], rotation: [0, Math.PI / 2, 0], scale: [2, 2, 2] }),
    obj('mid', { parentId: 'root', position: [1, 0, 0] }),
    obj('leaf', { parentId: 'mid', position: [0, 1, 0] }),
  ];

  it('composes world matrices down a 3-level chain', () => {
    const objects = chain();
    // Rotating +X by 90deg about Y yields -Z; the root scale doubles child offsets.
    expectVectorClose(worldPosition(objects, 'root'), [10, 0, 0]);
    expectVectorClose(worldPosition(objects, 'mid'), [10, 0, -2]);
    expectVectorClose(worldPosition(objects, 'leaf'), [10, 2, -2]);

    // Matches Three.js' own Object3D hierarchy with the same XYZ radian rotations.
    const nodes = objects.map((object) => {
      const node = new THREE.Object3D();
      node.position.fromArray(object.position);
      node.rotation.set(object.rotation[0], object.rotation[1], object.rotation[2], 'XYZ');
      node.scale.fromArray(object.scale);
      return node;
    });
    nodes[0].add(nodes[1]);
    nodes[1].add(nodes[2]);
    nodes[0].updateMatrixWorld(true);
    expect(getWorldMatrix(objects, 'leaf').equals(nodes[2].matrixWorld)).toBe(true);
  });

  it('treats objects with missing parents as roots', () => {
    const objects = [obj('orphan', { parentId: 'gone', position: [3, 4, 5] }), obj('root')];
    expectVectorClose(worldPosition(objects, 'orphan'), [3, 4, 5]);
    expect(ids(getChildren(objects, null))).toEqual(['orphan', 'root']);
    expect(getWorldMatrix(objects, 'nope').equals(new THREE.Matrix4())).toBe(true);
  });

  it('reparents while preserving the world transform', () => {
    const objects = [...chain(), obj('other', { position: [-5, 3, 1], rotation: [0.3, -0.7, 1.1], scale: [1.5, 1.5, 1.5] })];
    const before = getWorldMatrix(objects, 'leaf');

    const moved = reparentPreservingWorld(objects, 'leaf', 'other');
    expect(moved.parentId).toBe('other');
    const after = objects.map((object) => (object.id === 'leaf' ? moved : object));
    const afterMatrix = getWorldMatrix(after, 'leaf');
    afterMatrix.elements.forEach((value, i) => expect(value).toBeCloseTo(before.elements[i], 6));

    const unparented = reparentPreservingWorld(objects, 'leaf', null);
    expect(unparented.parentId).toBeNull();
    expect(unparented.position[0]).toBeCloseTo(10, 6);
    expect(unparented.position[1]).toBeCloseTo(2, 6);
    expect(unparented.position[2]).toBeCloseTo(-2, 6);
    expect(unparented.scale[0]).toBeCloseTo(2, 6);
  });

  it('round-trips a world matrix through toLocalTransform', () => {
    const objects = chain();
    const world = getWorldMatrix(objects, 'leaf');
    const local = toLocalTransform(objects, 'leaf', world, 'mid');
    expect(local.position[0]).toBeCloseTo(0, 6);
    expect(local.position[1]).toBeCloseTo(1, 6);
    expect(local.position[2]).toBeCloseTo(0, 6);
    local.rotation.forEach((angle) => expect(angle).toBeCloseTo(0, 6));
    local.scale.forEach((factor) => expect(factor).toBeCloseTo(1, 6));
  });

  it('detects cycles', () => {
    const objects = chain();
    expect(wouldCreateCycle(objects, 'root', 'leaf')).toBe(true);
    expect(wouldCreateCycle(objects, 'mid', 'mid')).toBe(true);
    expect(wouldCreateCycle(objects, 'leaf', 'root')).toBe(false);
    expect(wouldCreateCycle(objects, 'root', null)).toBe(false);
    // A cyclic reparent is refused and leaves the object untouched.
    expect(reparentPreservingWorld(objects, 'root', 'leaf')).toBe(objects[0]);
  });

  it('collects a subtree root first', () => {
    const objects = [
      obj('a'),
      obj('b', { parentId: 'a' }),
      obj('c', { parentId: 'b' }),
      obj('d', { parentId: 'a' }),
      obj('e'),
    ];
    expect(ids(collectSubtree(objects, 'a'))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(collectSubtree(objects, 'b'))).toEqual(['b', 'c']);
    expect(collectSubtree(objects, 'missing')).toEqual([]);
    expect(ids(getChildren(objects, 'a'))).toEqual(['b', 'd']);
  });

  it('sorts parents before children', () => {
    const objects = [
      obj('grandchild', { parentId: 'child' }),
      obj('child', { parentId: 'root' }),
      obj('loose'),
      obj('root'),
      obj('orphan', { parentId: 'gone' }),
    ];
    const sorted = ids(sortByHierarchy(objects));
    expect(sorted).toEqual(['loose', 'root', 'child', 'grandchild', 'orphan']);
    expect(sorted).toHaveLength(objects.length);

    // Corrupt cycles still yield every object exactly once.
    const cyclic = [obj('x', { parentId: 'y' }), obj('y', { parentId: 'x' }), obj('z')];
    expect(ids(sortByHierarchy(cyclic)).sort()).toEqual(['x', 'y', 'z']);
  });
});
