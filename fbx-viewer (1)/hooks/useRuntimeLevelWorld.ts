import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { LevelObject } from '../types';
import { collectSubtree } from '../utils/sceneGraph';

type TransformPartial = Partial<Pick<LevelObject, 'position' | 'rotation' | 'scale'>>;

const withTransform = (objects: LevelObject[], id: string, partial: TransformPartial): LevelObject[] =>
    objects.some(obj => obj.id === id) ? objects.map(obj => (obj.id === id ? { ...obj, ...partial } : obj)) : objects;

/** Without `id` and its descendants: like the editor's delete, an actor never leaves orphans behind. */
const withoutSubtree = (objects: LevelObject[], id: string): LevelObject[] => {
    const doomed = new Set(collectSubtree(objects, id).map(obj => obj.id));
    return doomed.size ? objects.filter(obj => !doomed.has(obj.id)) : objects;
};

/**
 * Session-local copy of the authored level for play mode.
 *
 * Gameplay (Destroy Actor, overlaps, collision, spawners, audio) reads and changes only this copy,
 * so a play session can never write to the project or the editor's undo history. Prefabs spawned
 * during play join it too. reset() restores the authored state, e.g. when the level restarts.
 *
 * A level script runs a whole exec chain inside one frame, before React re-renders, so every write
 * also lands on a live mirror that getObject reads: later nodes in the chain see an earlier spawn,
 * move or destroy instead of the last rendered copy.
 */
export const useRuntimeLevelWorld = (authoredObjects: LevelObject[]) => {
    const [objects, setObjects] = useState<LevelObject[]>(() => structuredClone(authoredObjects));
    const live = useRef(objects);
    // A commit has applied every queued write, so the committed copy takes over the mirror.
    useLayoutEffect(() => {
        live.current = objects;
    }, [objects]);

    const getObject = useCallback((id: string): LevelObject | null => live.current.find(obj => obj.id === id) ?? null, []);

    const destroyObject = useCallback((id: string) => {
        live.current = withoutSubtree(live.current, id);
        setObjects(prev => withoutSubtree(prev, id));
    }, []);

    // Transform writes from level scripts (Set Actor Transform) land on the session copy only.
    const setObjectTransform = useCallback((id: string, partial: TransformPartial) => {
        live.current = withTransform(live.current, id, partial);
        setObjects(prev => withTransform(prev, id, partial));
    }, []);

    const spawnObjects = useCallback((spawned: LevelObject[]) => {
        if (!spawned.length) return;
        live.current = [...live.current, ...spawned];
        setObjects(prev => [...prev, ...spawned]);
    }, []);

    const reset = useCallback(() => {
        const fresh = structuredClone(authoredObjects);
        live.current = fresh;
        setObjects(fresh);
    }, [authoredObjects]);

    return { objects, getObject, destroyObject, setObjectTransform, spawnObjects, reset };
};
