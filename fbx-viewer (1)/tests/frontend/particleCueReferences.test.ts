import { describe, expect, it } from 'vitest';
import type { LevelComponent, LevelObject } from '../../types';
import { copyLevelObjects, pasteLevelObjects } from '../../utils/levelClipboard';
import { createPrefabFromSubtree, instantiatePrefab } from '../../utils/prefabs';
import { overriddenFields, prefabFromInstance, syncInstance } from '../../utils/prefabSync';

const emitter = (id: string): LevelComponent => ({ id, type: 'particles', enabled: true, props: {} });
const object = (id: string, components: LevelComponent[], parentId?: string): LevelObject => ({
    id, components, parentId, levelId: 'level', modelId: '', type: 'prop', name: id, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
});
const cue = (objectId: string, componentId: string, id: string) => ({
    kind: 'particle', objectId, componentId, id, keys: [{ time: 0, value: { action: 'burst', count: 2 } }],
});
const tracks = (components: LevelComponent[]) =>
    (components.find(c => c.type === 'timeline')!.props.timeline as { tracks: ReturnType<typeof cue>[] }).tracks;

function scene() {
    const timeline = { id: 'director', type: 'timeline', enabled: true, props: { timeline: { duration: 2, tracks: [
        cue('child', 'emitter', 'child-cue'), cue('root', 'emitter', 'own-cue'), cue('elsewhere', 'emitter', 'external-cue'),
        cue('child', 'missing', 'unresolved-cue'),
    ] } } };
    return [object('root', [timeline, emitter('emitter')]), object('child', [emitter('emitter')], 'root')];
}

function checkCopy(copy: LevelObject[]) {
    const [root, child] = copy;
    const refs = tracks(root.components!);
    expect(refs[0]).toMatchObject(cue(child.id, child.components![0].id, 'child-cue'));
    expect(refs[1]).toMatchObject(cue(root.id, root.components![1].id, 'own-cue'));
    expect(refs[2]).toEqual(cue('elsewhere', 'emitter', 'external-cue'));
    expect(refs[3]).toEqual(cue(child.id, 'missing', 'unresolved-cue'));
}

describe('timeline particle bindings after object and component IDs change', () => {
    it('remaps internal bindings on duplication and repeated prefab placement, scoped to the target object', () => {
        const objects = scene();
        const payload = copyLevelObjects(objects, ['root'])!;
        checkCopy(pasteLevelObjects(payload, { levelObjects: objects, levelId: 'level' }).objects);
        const prefab = createPrefabFromSubtree(objects, 'root', 'Show');
        const a = instantiatePrefab(prefab, 'level', [0, 0, 0]);
        const b = instantiatePrefab(prefab, 'level', [2, 0, 0]);
        checkCopy(a);
        checkCopy(b);
        expect(tracks(a[0].components!)[0].objectId).not.toEqual(tracks(b[0].components!)[0].objectId);
        expect(overriddenFields(a[0], prefab, a)).toEqual([]);
        expect(syncInstance(a, a[0], prefab, prefab).updates).toEqual([]);
    });

    it('synchronizes forward references to new objects and keeps emitter IDs stable across a prefab insertion', () => {
        const objects = scene();
        const prefab = createPrefabFromSubtree(objects, 'root', 'Show');
        const instance = instantiatePrefab(prefab, 'level', [0, 0, 0]);
        const edit = structuredClone(prefab);
        edit.objects.push({ ...edit.objects[1], id: 'new-child', components: [emitter('joined')] });
        edit.objects[1].components!.unshift(emitter('inserted'));
        tracks(edit.objects[0].components!).push(cue('new-child', 'joined', 'added'));
        const plan = syncInstance(instance, instance[0], prefab, edit);
        const director = plan.updates.find(change => change.id === instance[0].id)!.changes.components!;
        const updatedChild = plan.updates.find(change => change.id === instance[1].id)!.changes.components!;
        expect(updatedChild[1].id).toBe(instance[1].components![0].id);
        expect(updatedChild[0].id).not.toBe(updatedChild[1].id);
        expect(tracks(director)[0]).toEqual(cue(instance[1].id, updatedChild[1].id, 'child-cue'));
        expect(tracks(director).at(-1)).toEqual(cue(plan.additions[0].id, plan.additions[0].components![0].id, 'added'));
    });

    it('maps IDs back into the prefab on Apply, supports Revert, and preserves an instance-only cue override', () => {
        const prefab = createPrefabFromSubtree(scene(), 'root', 'Show');
        const instance = instantiatePrefab(prefab, 'level', [0, 0, 0]);
        tracks(instance[0].components!)[0] = cue(instance[0].id, instance[0].components![1].id, 'child-cue');
        expect(overriddenFields(instance[0], prefab, instance)).toContain('components');
        expect(syncInstance(instance, instance[0], prefab, prefab).updates).toHaveLength(0);
        const revert = syncInstance(instance, instance[0], null, prefab, { revert: true });
        expect(tracks(revert.updates[0].changes.components!)[0]).toEqual(cue(instance[1].id, instance[1].components![0].id, 'child-cue'));
        const rebuilt = prefabFromInstance(instance, instance[0], prefab).prefab;
        expect(tracks(rebuilt.objects[0].components!)[0]).toEqual(cue('root', 'emitter', 'child-cue'));
        const [placed] = instantiatePrefab(rebuilt, 'other', [0, 0, 0]);
        expect(tracks(placed.components!)[0]).toEqual(cue(placed.id, placed.components![1].id, 'child-cue'));
    });
});
