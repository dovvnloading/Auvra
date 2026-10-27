/**
 * TIMELINE DATA
 *
 * A timeline component (runtime/components/timelineComponent.tsx) stores one TimelineData in its
 * props under `timeline`. Tracks animate level objects and level variables over time and raise
 * named events; the runtime evaluates them each frame and the Timeline editor authors them.
 * Times are seconds from the start; rotations are degrees, like the inspector.
 */

export type TimelineVec3 = [number, number, number];

/** How a key's value moves toward the next key: straight line, hold until the next key, or ease in/out. */
export type TimelineInterpolation = 'linear' | 'step' | 'smooth';

export interface TimelineKey<T> {
    time: number;
    value: T;
    /** Default 'linear' (boolean and string keys always step). */
    interpolation?: TimelineInterpolation;
}

interface TrackBase {
    id: string;
    /** Shown in the editor; empty uses the target's name. */
    label?: string;
    muted?: boolean;
}

/** Position/rotation/scale of one object, local to its parent; a missing channel is left alone. */
export interface TimelineTransformTrack extends TrackBase {
    kind: 'transform';
    objectId: string;
    position?: TimelineKey<TimelineVec3>[];
    rotation?: TimelineKey<TimelineVec3>[];
    scale?: TimelineKey<TimelineVec3>[];
}

export interface TimelineVisibilityTrack extends TrackBase {
    kind: 'visibility';
    objectId: string;
    keys: TimelineKey<boolean>[];
}

/** Writes a level variable (runtime/levelVariables) while the timeline plays. */
export interface TimelineVariableTrack extends TrackBase {
    kind: 'variable';
    name: string;
    keys: TimelineKey<number>[];
}

/** Raises each key's value as a named event when playback crosses its time. */
export interface TimelineEventTrack extends TrackBase {
    kind: 'event';
    keys: TimelineKey<string>[];
}

/** Cuts the view to a camera component's object at each key (the value; '' is the gameplay camera). */
export interface TimelineCameraTrack extends TrackBase {
    kind: 'camera';
    keys: TimelineKey<string>[];
    /** Seconds each cut blends over; 0 cuts at once. */
    blend?: number;
}

export type TimelineTrack = TimelineTransformTrack | TimelineVisibilityTrack | TimelineVariableTrack | TimelineEventTrack | TimelineCameraTrack;

export interface TimelineData {
    /** Seconds; playback ends (or loops) here. */
    duration: number;
    tracks: TimelineTrack[];
}

export const EMPTY_TIMELINE: TimelineData = { duration: 5, tracks: [] };
