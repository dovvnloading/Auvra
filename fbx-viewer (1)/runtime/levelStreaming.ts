import { createContext, useContext } from 'react';
import type { LevelComponent, LevelObject, LevelObjectType } from '../types';
import { TIMELINE_PLAYER_TARGET } from './timeline/types';

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Rewrite one object reference on the session copy. Some readers trim handwritten IDs. */
function remapField(fields: Record<string, unknown>, key: string, ids: ReadonlyMap<string, string>, trim = false): void {
    const value = fields[key];
    if (typeof value !== 'string' || !value) return;
    const mapped = ids.get(trim ? value.trim() : value);
    if (mapped !== undefined) fields[key] = mapped;
}

function remapTimeline(timeline: unknown, ids: ReadonlyMap<string, string>, ownerId: string): void {
    if (!isRecord(timeline) || !Array.isArray(timeline.tracks)) return;
    for (const track of timeline.tracks) {
        if (!isRecord(track)) continue;
        switch (track.kind) {
            case 'animation':
                if (track.objectId !== TIMELINE_PLAYER_TARGET) remapField(track, 'objectId', ids);
                break;
            case 'audio':
            case 'visibility':
            case 'transform':
                // These tracks resolve their own host before the gameplay player.
                if (track.objectId === ownerId || track.objectId !== TIMELINE_PLAYER_TARGET) remapField(track, 'objectId', ids);
                break;
            case 'particle':
                remapField(track, 'objectId', ids);
                break;
            case 'camera':
                if (Array.isArray(track.keys)) {
                    for (const key of track.keys) if (isRecord(key)) remapField(key, 'value', ids, true);
                }
                break;
        }
    }
}

function remapComponent({ type, props }: LevelComponent, ids: ReadonlyMap<string, string>, ownerId: string): void {
    if (!isRecord(props)) return;
    switch (type) {
        case 'followSpline':
            remapField(props, 'spline', ids);
            break;
        case 'vehicle':
            remapField(props, 'aiPath', ids);
            break;
        case 'joint':
            remapField(props, 'connectedObjectId', ids, true);
            break;
        case 'twoBoneIK':
            if (typeof props.target === 'string' && props.target.trim() !== 'player') remapField(props, 'target', ids, true);
            break;
        case 'proceduralRig':
            if (!Array.isArray(props.constraints)) break;
            for (const constraint of props.constraints) {
                if (isRecord(constraint) && isRecord(constraint.target) && constraint.target.kind === 'object') {
                    remapField(constraint.target, 'id', ids);
                }
            }
            break;
        case 'timeline':
            remapTimeline(props.timeline, ids, ownerId);
            break;
    }
}

/**
 * Copies of one level's objects for the session, with internal references bound to the copies.
 * Singletons stay out of the stream and an object whose parent stays behind becomes a root.
 */
export const streamedObjects = (levelId: string, objects: readonly LevelObject[], sessionLevelId: string): LevelObject[] => {
    const kept = objects.filter(object => !NOT_STREAMED.has(object.type));
    const ids = new Map(kept.map(object => [object.id, streamedObjectId(levelId, object.id)]));
    return kept.map(object => {
        const copy = structuredClone(object);
        copy.id = ids.get(object.id)!;
        copy.levelId = sessionLevelId;
        copy.parentId = object.parentId ? ids.get(object.parentId) ?? null : null;
        if (copy.spawnConfig?.patrolPath) {
            copy.spawnConfig.patrolPath = ids.get(copy.spawnConfig.patrolPath) ?? copy.spawnConfig.patrolPath;
        }
        for (const component of copy.components ?? []) remapComponent(component, ids, object.id);
        return copy;
    });
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
