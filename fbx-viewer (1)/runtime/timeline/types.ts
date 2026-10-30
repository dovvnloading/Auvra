/**
 * TIMELINE DATA
 *
 * A timeline component (runtime/components/timelineComponent.tsx) stores one TimelineData in its
 * props under `timeline`. Tracks animate level objects and level variables over time, raise named
 * events, cut cameras, and for cinematics play characters' clips, sounds, subtitles and fades; the
 * runtime evaluates them each frame and the Timeline editor authors them. Times are seconds from the
 * start; rotations are degrees, like the inspector. Clip, sound and subtitle keys last a length:
 * the editor draws them as bars.
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

/** Animation and audio tracks aimed at the player use this in place of an object id. */
export const TIMELINE_PLAYER_TARGET = 'player';

/** One clip played on a character: from the key's time for `length` seconds. */
export interface TimelineClipValue {
    /** The character model's clip, by name. */
    clip: string;
    length: number;
    /** Seconds into the clip it starts at. */
    offset: number;
    /** Playback rate (1 normal). */
    speed: number;
    /** Plays round again past the clip's end; otherwise it holds the last frame. */
    loop: boolean;
    /** Seconds it fades in from the pose underneath (or from the clip before), and out again at its end. */
    blendIn: number;
    blendOut: number;
}

/**
 * Plays clips on a character (a level object's model, or the player), over the pose its own animation
 * gives it: overlapping clips crossfade, and where no clip plays the character's own animation shows.
 */
export interface TimelineAnimationTrack extends TrackBase {
    kind: 'animation';
    /** A level object with a model, or TIMELINE_PLAYER_TARGET. */
    objectId: string;
    keys: TimelineKey<TimelineClipValue>[];
}

/** One sound: an audio asset (id or name) played from the key's time for at most `length` seconds. */
export interface TimelineSoundValue {
    sound: string;
    length: number;
    volume: number;
}

/** Plays sounds: from an object in 3D, or everywhere alike (no object). */
export interface TimelineAudioTrack extends TrackBase {
    kind: 'audio';
    /** A level object (or the player) the sounds come from; '' plays them in 2D. */
    objectId: string;
    /** The mixer bus: 'sfx', 'music', 'ui' or 'master'. */
    bus: string;
    keys: TimelineKey<TimelineSoundValue>[];
}

/** One line on screen: who says it and what, from the key's time for `length` seconds. */
export interface TimelineLineValue {
    speaker: string;
    text: string;
    length: number;
}

export interface TimelineSubtitleTrack extends TrackBase {
    kind: 'subtitle';
    keys: TimelineKey<TimelineLineValue>[];
}

/** Covers the screen with a colour: 0 clear, 1 fully covered; keys blend like variable keys. */
export interface TimelineFadeTrack extends TrackBase {
    kind: 'fade';
    /** '#rrggbb'. */
    color: string;
    keys: TimelineKey<number>[];
}

export type TimelineTrack = TimelineTransformTrack | TimelineVisibilityTrack | TimelineVariableTrack | TimelineEventTrack | TimelineCameraTrack
    | TimelineAnimationTrack | TimelineAudioTrack | TimelineSubtitleTrack | TimelineFadeTrack;

export interface TimelineData {
    /** Seconds; playback ends (or loops) here. */
    duration: number;
    tracks: TimelineTrack[];
}

export const EMPTY_TIMELINE: TimelineData = { duration: 5, tracks: [] };
