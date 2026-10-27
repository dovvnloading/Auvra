import { describe, expect, it } from 'vitest';
import type { LevelObject, PrefabData } from '../../types';
import { instantiatePrefab } from '../../utils/prefabs';
import { findInstanceRoot, instanceMembers, instanceRoots, overriddenFields, prefabFromInstance, syncInstance } from '../../utils/prefabSync';

const prefab = (objects: PrefabData['objects'], overrides: Partial<PrefabData> = {}): PrefabData => ({
  id: 'pf', name: 'Lamp', rootId: 'p-root', objects, createdAt: 0, ...overrides,
});

const object = (id: string, fields: Partial<PrefabData['objects'][number]> = {}): PrefabData['objects'][number] => ({
  id, modelId: 'm', name: id, type: 'prop', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], parentId: null, ...fields,
});

const lamp = prefab([
  object('p-root', { name: 'Lamp' }),
  object('p-bulb', { name: 'Bulb', parentId: 'p-root', position: [0, 2, 0], components: [{ id: 'c1', type: 'pointLight', enabled: true, props: { intensity: 20 } }] }),
]);

const place = (at: [number, number, number] = [5, 0, 5]): LevelObject[] => instantiatePrefab(lamp, 'level-1', at);

const apply = (objects: LevelObject[], sync: ReturnType<typeof syncInstance>): LevelObject[] => {
  const removed = new Set(sync.removals);
  const updated = objects
    .filter(item => !removed.has(item.id))
    .map(item => {
      const update = sync.updates.find(entry => entry.id === item.id);
      return update ? { ...item, ...update.changes } : item;
    });
  return [...updated, ...sync.additions];
};

describe('prefab instances', () => {
  it('records the prefab object each placed object came from, and finds the instance from any member', () => {
    const placed = place();
    expect(placed.map(item => item.prefabObjectId)).toEqual(['p-root', 'p-bulb']);
    expect(instanceRoots(placed, lamp).map(item => item.id)).toEqual([placed[0].id]);
    expect(findInstanceRoot(placed, placed[1], lamp)?.id).toBe(placed[0].id);
    expect(instanceMembers(placed, placed[0]).map(item => item.id)).toEqual(placed.map(item => item.id));
  });

  it('carries prefab changes into an instance but keeps its overrides and the root placement', () => {
    let placed = place();
    // The instance moves its bulb (an override) and keeps the light untouched.
    placed = placed.map(item => (item.prefabObjectId === 'p-bulb' ? { ...item, position: [0, 3, 0] as [number, number, number] } : item));
    const next = prefab([
      object('p-root', { name: 'Street Lamp', position: [0, 0, 0] }),
      object('p-bulb', { name: 'Bulb', parentId: 'p-root', position: [0, 2.5, 0], components: [{ id: 'c1', type: 'pointLight', enabled: true, props: { intensity: 60 } }] }),
    ]);
    const result = apply(placed, syncInstance(placed, placed[0], lamp, next));
    const root = result.find(item => item.prefabObjectId === 'p-root')!;
    const bulb = result.find(item => item.prefabObjectId === 'p-bulb')!;
    expect(root.name).toBe('Street Lamp');
    expect(root.position).toEqual([5, 0, 5]);
    expect(bulb.position).toEqual([0, 3, 0]);
    expect(bulb.components?.[0].props.intensity).toBe(60);
    // The instance's own component id survives the update.
    expect(bulb.components?.[0].id).toBe(placed[1].components?.[0].id);
  });

  it('adds prefab objects an instance lacks and removes ones the prefab dropped, keeping hand-added children', () => {
    const placed = [...place(), {
      ...object('extra', { name: 'Sign', parentId: undefined }), levelId: 'level-1', parentId: '' as string | null,
    } as LevelObject];
    placed[2] = { ...placed[2], parentId: placed[0].id };
    const next = prefab([
      object('p-root', { name: 'Lamp' }),
      object('p-base', { name: 'Base', parentId: 'p-root' }),
    ]);
    const sync = syncInstance(placed, placed[0], lamp, next);
    expect(sync.removals).toEqual([placed[1].id]);
    expect(sync.additions).toHaveLength(1);
    expect(sync.additions[0]).toMatchObject({ name: 'Base', parentId: placed[0].id, prefabId: 'pf', prefabObjectId: 'p-base', levelId: 'level-1' });
    const result = apply(placed, sync);
    expect(result.some(item => item.name === 'Sign')).toBe(true);
  });

  it('reverts every override except the placement', () => {
    let placed = place();
    placed = placed.map(item => (item.prefabObjectId === 'p-bulb' ? { ...item, name: 'Renamed', position: [1, 1, 1] as [number, number, number] } : item));
    expect(overriddenFields(placed[1], lamp)).toEqual(['name', 'position']);
    expect(overriddenFields(placed[0], lamp)).toEqual([]);
    const result = apply(placed, syncInstance(placed, placed[0], null, lamp, { revert: true }));
    const bulb = result.find(item => item.prefabObjectId === 'p-bulb')!;
    expect(bulb.name).toBe('Bulb');
    expect(bulb.position).toEqual([0, 2, 0]);
    expect(result.find(item => item.prefabObjectId === 'p-root')!.position).toEqual([5, 0, 5]);
  });

  it('treats every difference as an override when the previous prefab is unknown', () => {
    let placed = place();
    placed = placed.map(item => (item.prefabObjectId === 'p-bulb' ? { ...item, name: 'Mine' } : item));
    const next = prefab([object('p-root', { name: 'Lamp' }), object('p-bulb', { name: 'Bulb 2', parentId: 'p-root', position: [0, 2, 0] })]);
    const result = apply(placed, syncInstance(placed, placed[0], null, next));
    expect(result.find(item => item.prefabObjectId === 'p-bulb')!.name).toBe('Mine');
  });

  it('rebuilds the prefab from an instance, adopting hand-added children under new prefab object ids', () => {
    const placed = place();
    const sign = { ...placed[1], id: 'sign', name: 'Sign', prefabId: undefined, prefabObjectId: undefined, parentId: placed[0].id, components: undefined };
    const objects = [...placed, sign];
    const { prefab: rebuilt, adopted } = prefabFromInstance(objects, placed[0], lamp);
    expect(rebuilt.id).toBe('pf');
    expect(rebuilt.rootId).toBe('p-root');
    const root = rebuilt.objects.find(item => item.id === 'p-root')!;
    expect(root.position).toEqual([0, 0, 0]);
    expect(root.parentId).toBeNull();
    expect(rebuilt.objects.find(item => item.id === 'p-bulb')!.parentId).toBe('p-root');
    const signId = adopted.get('sign')!;
    expect(rebuilt.objects.find(item => item.id === signId)).toMatchObject({ name: 'Sign', parentId: 'p-root' });
    expect(rebuilt.objects.every(item => !('prefabObjectId' in item) && !('levelId' in item))).toBe(true);
  });
});
