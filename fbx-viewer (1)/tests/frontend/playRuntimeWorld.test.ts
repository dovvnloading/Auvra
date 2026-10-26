import { act, renderHook } from '@testing-library/react';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { applyMeleeHit, DEFAULT_MELEE_DAMAGE, resolveBlueprintDamage } from '../../components/Sandbox/combat';
import { useRuntimeLevelWorld } from '../../hooks/useRuntimeLevelWorld';
import type { LevelObject } from '../../types';

const levelObject = (id: string, position: [number, number, number]): LevelObject => ({
  id, levelId: 'level-1', modelId: 'model-1', name: id, position, rotation: [0, 0, 0], scale: [1, 1, 1], type: 'prop',
});

describe('runtime level world', () => {
  it('destroys objects in the session copy without touching the authored level', () => {
    const authored = [levelObject('a', [0, 0, 0]), levelObject('b', [1, 0, 0])];
    const snapshot = structuredClone(authored);
    const { result } = renderHook(() => useRuntimeLevelWorld(authored));

    act(() => result.current.destroyObject('a'));
    expect(result.current.objects.map(obj => obj.id)).toEqual(['b']);

    result.current.objects[0].position[0] = 99;
    expect(authored).toEqual(snapshot);

    act(() => result.current.reset());
    expect(result.current.objects).toEqual(snapshot);
  });
});

describe('melee combat', () => {
  it('reads the blueprint Damage stat and falls back for missing or invalid values', () => {
    expect(resolveBlueprintDamage({ stats: [{ id: 's1', name: 'Damage', value: 25 }] })).toBe(25);
    expect(resolveBlueprintDamage({ stats: [{ id: 's1', name: 'Damage', value: Number.NaN }] })).toBe(DEFAULT_MELEE_DAMAGE);
    expect(resolveBlueprintDamage({ stats: [] })).toBe(DEFAULT_MELEE_DAMAGE);
    expect(resolveBlueprintDamage(undefined)).toBe(DEFAULT_MELEE_DAMAGE);
  });

  it('hits the target at torso height without moving it', () => {
    const object = new THREE.Group();
    object.position.set(2, 0, 3);
    const takeDamage = vi.fn();

    applyMeleeHit({ object, takeDamage }, 15);

    expect(takeDamage).toHaveBeenCalledTimes(1);
    const [amount, point] = takeDamage.mock.calls[0] as [number, THREE.Vector3];
    expect(amount).toBe(15);
    expect(point.toArray()).toEqual([2, 1.5, 3]);
    expect(object.position.toArray()).toEqual([2, 0, 3]);
  });
});
