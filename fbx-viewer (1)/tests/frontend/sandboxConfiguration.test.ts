import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { sandboxEnemyModel } from '../../components/Sandbox/hooks/useSandboxConfiguration';
import type { LoadedModelData } from '../../types';

const model = (id: string): LoadedModelData => {
  const object = new THREE.Group();
  object.name = id;
  object.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  object.position.set(1, 2, 3);
  return { id, name: id, url: '', object, animations: [], category: 'Character', isPlacedInScene: false };
};

describe('sandbox enemy model', () => {
  it('gives an enemy of the player model its own copy of the object', () => {
    const shared = model('remy');
    const enemy = sandboxEnemyModel(shared, shared)!;
    expect(enemy).not.toBe(shared);
    expect(enemy.object).not.toBe(shared.object);
    expect(enemy.id).toBe('remy');
    expect(enemy.object.children).toHaveLength(1);
    expect(enemy.object.position.toArray()).toEqual([1, 2, 3]);
  });

  it('uses the enemy model as it is when it is not the player model', () => {
    const player = model('remy');
    const other = model('raider');
    expect(sandboxEnemyModel(player, other)).toBe(other);
    expect(sandboxEnemyModel(undefined, other)).toBe(other);
    expect(sandboxEnemyModel(player, undefined)).toBeUndefined();
  });
});
