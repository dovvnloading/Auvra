import { useCallback, useState } from 'react';
import { LevelObject } from '../types';

/**
 * Session-local copy of the authored level for play mode.
 *
 * Gameplay (Destroy Actor, overlaps, collision, spawners, audio) reads and changes only this copy,
 * so a play session can never write to the project or the editor's undo history.
 * reset() restores the authored state, e.g. when the level restarts.
 */
export const useRuntimeLevelWorld = (authoredObjects: LevelObject[]) => {
    const [objects, setObjects] = useState<LevelObject[]>(() => structuredClone(authoredObjects));

    const destroyObject = useCallback((id: string) => {
        setObjects(prev => prev.filter(obj => obj.id !== id));
    }, []);

    // Transform writes from level scripts (Set Actor Transform) land on the session copy only.
    const setObjectTransform = useCallback((id: string, partial: Partial<Pick<LevelObject, 'position' | 'rotation' | 'scale'>>) => {
        setObjects(prev => (prev.some(obj => obj.id === id)
            ? prev.map(obj => (obj.id === id ? { ...obj, ...partial } : obj))
            : prev));
    }, []);

    const reset = useCallback(() => {
        setObjects(structuredClone(authoredObjects));
    }, [authoredObjects]);

    return { objects, destroyObject, setObjectTransform, reset };
};
