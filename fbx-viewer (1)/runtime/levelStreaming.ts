import { createContext, useContext } from 'react';
import type { LevelObject, LevelObjectType } from '../types';

/**
 * LEVEL STREAMING
 *
 * A Level Streaming volume loads another level's objects into the running play session while the
 * player is inside it and unloads them again after the player has been out for a moment. Streamed
 * objects join the session copy like spawned prefabs (never the project), under ids prefixed with
 * the level they came from, so two levels that reuse an id never collide.
 */

/** Level singletons that belong to the level being played, never to a streamed one. */
const NOT_STREAMED: ReadonlySet<LevelObjectType> = new Set<LevelObjectType>(['player_start', 'sky_sphere']);

/** The session id of object `id` streamed in from level `levelId`. */
export const streamedObjectId = (levelId: string, id: string): string => `stream:${levelId}:${id}`;

/**
 * Copies of `objects` (one level's) for the session of level `sessionLevelId`: ids prefixed, parent
 * links remapped (a parent that is not streamed makes the object a root), singletons left out.
 */
export const streamedObjects = (levelId: string, objects: readonly LevelObject[], sessionLevelId: string): LevelObject[] => {
    const kept = objects.filter(object => !NOT_STREAMED.has(object.type));
    const ids = new Set(kept.map(object => object.id));
    return kept.map(object => ({
        ...structuredClone(object),
        id: streamedObjectId(levelId, object.id),
        levelId: sessionLevelId,
        parentId: object.parentId && ids.has(object.parentId) ? streamedObjectId(levelId, object.parentId) : null,
    }));
};

/** The objects among `objects` whose parent is not among them: removing these removes them all. */
export const streamedRoots = (objects: readonly LevelObject[]): string[] => {
    const ids = new Set(objects.map(object => object.id));
    return objects.filter(object => !object.parentId || !ids.has(object.parentId)).map(object => object.id);
};

/** What a play session offers Level Streaming volumes. */
export interface LevelStreaming {
    /** Loads a level's objects into the session; false when the level is unknown or empty. Loading twice does nothing. */
    load(levelId: string): boolean;
    unload(levelId: string): void;
    isLoaded(levelId: string): boolean;
}

export const LevelStreamingContext = createContext<LevelStreaming | null>(null);

/** The play session's streaming, or null outside one (the editor preview). */
export const useLevelStreaming = (): LevelStreaming | null => useContext(LevelStreamingContext);

/** Every level's objects by level id, for streaming. */
export const objectsByLevel = (objects: readonly LevelObject[]): Record<string, LevelObject[]> => {
    const byLevel: Record<string, LevelObject[]> = {};
    for (const object of objects) (byLevel[object.levelId] ??= []).push(object);
    return byLevel;
};
