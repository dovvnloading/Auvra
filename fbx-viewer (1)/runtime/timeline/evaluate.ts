import type { LevelComponent } from '../../types';
import {
    EMPTY_TIMELINE,
    type TimelineData,
    type TimelineInterpolation,
    type TimelineKey,
    type TimelineTrack,
    type TimelineTransformTrack,
    type TimelineVec3,
} from './types';

/**
 * TIMELINE EVALUATION
 *
 * Pure playback math for timeline components: sampling keyed tracks at a time, finding the event keys
 * playback crossed, stepping a playback clock, and cleaning stored timeline data. The runtime component
 * (runtime/components/timelineComponent) applies the results to the play session.
 *
 * Every sampler expects keys sorted by time, as normalizeTimeline leaves them. Before the first key a
 * track holds the first key's value and after the last key it holds the last.
 */

/** Component type of the timeline component, for code that finds timelines without importing the component. */
export const TIMELINE_COMPONENT_TYPE = 'timeline';

/** Shortest duration normalizeTimeline keeps, in seconds. */
export const MIN_TIMELINE_DURATION = 0.05;

const INTERPOLATIONS: readonly TimelineInterpolation[] = ['linear', 'step', 'smooth'];

const DEG_TO_RAD = Math.PI / 180;

export interface TimelineTransformSample {
    objectId: string;
    position?: TimelineVec3;
    /** Euler XYZ radians, like LevelObject.rotation. */
    rotation?: TimelineVec3;
    scale?: TimelineVec3;
}

export interface TimelineVisibilitySample {
    objectId: string;
    visible: boolean;
}

export interface TimelineVariableSample {
    name: string;
    value: number;
}

/** What a timeline sets at one time: at most one entry per object (or variable), later tracks winning per channel. */
export interface TimelineEvaluation {
    transforms: TimelineTransformSample[];
    visibility: TimelineVisibilitySample[];
    variables: TimelineVariableSample[];
}

// --- SAMPLING ---

/** Weight (0..1) of the next key's value at `progress` (0..1) through a span with `interpolation`. */
export const interpolationWeight = (interpolation: TimelineInterpolation | undefined, progress: number): number => {
    const u = Math.min(1, Math.max(0, progress));
    if (interpolation === 'step') return 0;
    if (interpolation === 'smooth') return u * u * (3 - 2 * u);
    return u;
};

/** Index of the last key at or before `time` (the last of several at the same time); -1 before the first key. */
export const findKeyIndex = (keys: readonly TimelineKey<unknown>[], time: number): number => {
    let low = 0;
    let high = keys.length - 1;
    let found = -1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        if (keys[middle].time <= time) {
            found = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return found;
};

/**
 * The key span `time` falls in: the key before it, the key after it and the next key's weight. Holds
 * (before the first key, after the last) give the held key with weight 0. Undefined for no keys.
 */
const locate = <T>(keys: readonly TimelineKey<T>[], time: number): { from: TimelineKey<T>; to: TimelineKey<T>; weight: number } | undefined => {
    if (keys.length === 0) return undefined;
    const index = findKeyIndex(keys, time);
    if (index < 0) return { from: keys[0], to: keys[0], weight: 0 };
    if (index >= keys.length - 1) return { from: keys[index], to: keys[index], weight: 0 };
    const from = keys[index];
    const to = keys[index + 1];
    return { from, to, weight: interpolationWeight(from.interpolation, (time - from.time) / (to.time - from.time)) };
};

/** A number track's value at `time`; undefined when it has no keys. */
export const sampleNumberKeys = (keys: readonly TimelineKey<number>[], time: number): number | undefined => {
    const span = locate(keys, time);
    if (!span) return undefined;
    return span.weight === 0 ? span.from.value : span.from.value + (span.to.value - span.from.value) * span.weight;
};

/** A vector track's value at `time`, as a new tuple; undefined when it has no keys. */
export const sampleVec3Keys = (keys: readonly TimelineKey<TimelineVec3>[], time: number): TimelineVec3 | undefined => {
    const span = locate(keys, time);
    if (!span) return undefined;
    const { from, to, weight } = span;
    return [0, 1, 2].map(axis => from.value[axis] + (to.value[axis] - from.value[axis]) * weight) as TimelineVec3;
};

/** A stepped track's value at `time` (boolean and string keys never blend); undefined when it has no keys. */
export const sampleStepKeys = <T>(keys: readonly TimelineKey<T>[], time: number): T | undefined => {
    if (keys.length === 0) return undefined;
    return keys[Math.max(0, findKeyIndex(keys, time))].value;
};

/**
 * Everything the timeline's unmuted tracks set at `time` (seconds). Rotation keys are degrees and come
 * out as radians. Tracks without a target (blank object id or variable name) or without keys are skipped.
 */
export const evaluateTimeline = (data: TimelineData, time: number): TimelineEvaluation => {
    const at = Number.isFinite(time) ? time : 0;
    const transforms = new Map<string, TimelineTransformSample>();
    const visibility = new Map<string, boolean>();
    const variables = new Map<string, number>();
    for (const track of data.tracks) {
        if (track.muted) continue;
        if (track.kind === 'transform') {
            if (!track.objectId) continue;
            const position = track.position && sampleVec3Keys(track.position, at);
            const degrees = track.rotation && sampleVec3Keys(track.rotation, at);
            const scale = track.scale && sampleVec3Keys(track.scale, at);
            if (!position && !degrees && !scale) continue;
            const sample = transforms.get(track.objectId) ?? { objectId: track.objectId };
            if (position) sample.position = position;
            if (degrees) sample.rotation = degrees.map(value => value * DEG_TO_RAD) as TimelineVec3;
            if (scale) sample.scale = scale;
            transforms.set(track.objectId, sample);
        } else if (track.kind === 'visibility') {
            const visible = track.objectId ? sampleStepKeys(track.keys, at) : undefined;
            if (visible !== undefined) visibility.set(track.objectId, visible);
        } else if (track.kind === 'variable') {
            const name = track.name.trim();
            const value = name ? sampleNumberKeys(track.keys, at) : undefined;
            if (value !== undefined) variables.set(name, value);
        }
    }
    return {
        transforms: [...transforms.values()],
        visibility: [...visibility].map(([objectId, visible]) => ({ objectId, visible })),
        variables: [...variables].map(([name, value]) => ({ name, value })),
    };
};

/**
 * Names (trimmed) of the event keys playback passed moving from `previousTime` to `time`, in time order:
 * keys in (previousTime, time]. With `looped`, playback ran to the end and wrapped to the start, so the
 * keys in (previousTime, duration] come first, then those in [0, time]. Pass a negative previousTime for
 * the first step of a playback so keys at 0 are included. Muted tracks and blank names are skipped.
 */
export const crossedTimelineEvents = (data: TimelineData, previousTime: number, time: number, looped: boolean): string[] => {
    const keys = data.tracks
        .flatMap(track => (track.kind === 'event' && !track.muted ? track.keys : []))
        .filter(key => key.value.trim() !== '')
        .sort((a, b) => a.time - b.time);
    const crossed = looped
        ? [
            ...keys.filter(key => key.time > previousTime && key.time <= data.duration),
            ...keys.filter(key => key.time >= 0 && key.time <= time),
        ]
        : keys.filter(key => key.time > previousTime && key.time <= time);
    return crossed.map(key => key.value.trim());
};

// --- PLAYBACK ---

/** Where one timeline's playback is. */
export interface TimelinePlayback {
    /** Seconds from the start, within [0, duration]. */
    time: number;
    /** False until the first step; that step includes keys at the current time. */
    started: boolean;
    /** A non-looping timeline that reached its end; it no longer moves. */
    finished: boolean;
}

export const INITIAL_TIMELINE_PLAYBACK: Readonly<TimelinePlayback> = Object.freeze({ time: 0, started: false, finished: false });

export interface TimelineStep {
    playback: TimelinePlayback;
    /** Event names crossed during the step, in order. */
    events: string[];
    /** False when the step changed nothing (finished, or no advance after the first step): nothing needs applying. */
    moved: boolean;
}

/**
 * Advances playback by `advance` seconds of timeline time (frame delta times speed; negative counts as 0).
 * A looping timeline wraps at most once per step and raises each crossed event once; a non-looping one
 * stops at its end and is finished from then on.
 */
export const stepTimelinePlayback = (data: TimelineData, playback: Readonly<TimelinePlayback>, advance: number, loop: boolean): TimelineStep => {
    const amount = Number.isFinite(advance) && advance > 0 ? advance : 0;
    if (playback.finished || (playback.started && amount === 0)) return { playback, events: [], moved: false };
    const previous = playback.started ? playback.time : -1;
    const next = playback.time + amount;
    if (next < data.duration) {
        return { playback: { time: next, started: true, finished: false }, events: crossedTimelineEvents(data, previous, next, false), moved: true };
    }
    if (!loop) {
        return {
            playback: { time: data.duration, started: true, finished: true },
            events: crossedTimelineEvents(data, previous, data.duration, false),
            moved: true,
        };
    }
    const wrapped = next % data.duration;
    return { playback: { time: wrapped, started: true, finished: false }, events: crossedTimelineEvents(data, previous, wrapped, true), moved: true };
};

/**
 * True when a play variable's value means "play": true, a non-zero number, or text holding 'true' or a
 * non-zero number (String variables keep text). Missing variables and anything else mean "pause".
 */
export const isTimelinePlayValue = (value: unknown): boolean => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
    if (typeof value !== 'string') return false;
    const text = value.trim();
    if (text === 'true') return true;
    const number = Number(text);
    return text !== '' && Number.isFinite(number) && number !== 0;
};

// --- TARGETS ---

/** Ids of the objects the timeline's unmuted transform and visibility tracks drive, once each. */
export const timelineTargetIds = (data: TimelineData): string[] => {
    const ids = new Set<string>();
    for (const track of data.tracks) {
        if (!track.muted && (track.kind === 'transform' || track.kind === 'visibility') && track.objectId) ids.add(track.objectId);
    }
    return [...ids];
};

/**
 * Ids of every object an enabled timeline component on `objects` drives. A play session gives these
 * objects their own transform groups, since an instanced static prop cannot be moved or hidden alone.
 */
export const collectTimelineTargets = (objects: readonly { components?: readonly LevelComponent[] }[]): Set<string> => {
    const ids = new Set<string>();
    for (const object of objects) {
        for (const component of object.components ?? []) {
            if (component.type !== TIMELINE_COMPONENT_TYPE || component.enabled === false) continue;
            timelineTargetIds(normalizeTimeline(component.props.timeline)).forEach(id => ids.add(id));
        }
    }
    return ids;
};

// --- NORMALIZATION ---

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const readVec3 = (value: unknown): TimelineVec3 | undefined =>
    Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber) ? [value[0], value[1], value[2]] : undefined;

const readNumber = (value: unknown): number | undefined => (isFiniteNumber(value) ? value : undefined);

const readBoolean = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);

const readText = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/**
 * Valid keys of a stored key list, sorted by time (stable for equal times); null when it is not a list.
 * A key needs a finite time >= 0 and a value `readValue` accepts. `blends` keeps a valid interpolation.
 */
const normalizeKeys = <T>(value: unknown, readValue: (raw: unknown) => T | undefined, blends: boolean): TimelineKey<T>[] | null => {
    if (!Array.isArray(value)) return null;
    const keys: TimelineKey<T>[] = [];
    for (const raw of value) {
        if (!isRecord(raw) || !isFiniteNumber(raw.time) || raw.time < 0) continue;
        const keyValue = readValue(raw.value);
        if (keyValue === undefined) continue;
        const key: TimelineKey<T> = { time: raw.time, value: keyValue };
        const interpolation = INTERPOLATIONS.find(mode => mode === raw.interpolation);
        if (blends && interpolation) key.interpolation = interpolation;
        keys.push(key);
    }
    return keys.sort((a, b) => a.time - b.time);
};

/** A clean copy of one stored track, or null when it is malformed (unknown kind, no id, wrong field types). */
const normalizeTrack = (value: unknown): TimelineTrack | null => {
    if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') return null;
    const base = {
        id: value.id,
        ...(typeof value.label === 'string' ? { label: value.label } : {}),
        ...(typeof value.muted === 'boolean' ? { muted: value.muted } : {}),
    };
    switch (value.kind) {
        case 'transform': {
            if (typeof value.objectId !== 'string') return null;
            const track: TimelineTransformTrack = { ...base, kind: 'transform', objectId: value.objectId };
            const position = normalizeKeys(value.position, readVec3, true);
            const rotation = normalizeKeys(value.rotation, readVec3, true);
            const scale = normalizeKeys(value.scale, readVec3, true);
            if (position) track.position = position;
            if (rotation) track.rotation = rotation;
            if (scale) track.scale = scale;
            return track;
        }
        case 'visibility': {
            const keys = normalizeKeys(value.keys, readBoolean, false);
            return typeof value.objectId === 'string' && keys ? { ...base, kind: 'visibility', objectId: value.objectId, keys } : null;
        }
        case 'variable': {
            const keys = normalizeKeys(value.keys, readNumber, true);
            return typeof value.name === 'string' && keys ? { ...base, kind: 'variable', name: value.name, keys } : null;
        }
        case 'event': {
            const keys = normalizeKeys(value.keys, readText, false);
            return keys ? { ...base, kind: 'event', keys } : null;
        }
        default:
            return null;
    }
};

/**
 * A clean, independent copy of stored timeline data (component.props.timeline). Malformed tracks and
 * keys are dropped, as are tracks repeating an earlier track's id; keys are sorted by time; a duration
 * that is not a number takes the default and one below MIN_TIMELINE_DURATION is raised to it. Blank
 * object ids, variable names and event names are kept (the editor holds them while they are typed) and
 * skipped by playback.
 */
export const normalizeTimeline = (value: unknown): TimelineData => {
    if (!isRecord(value)) return { duration: EMPTY_TIMELINE.duration, tracks: [] };
    const duration = isFiniteNumber(value.duration) ? Math.max(MIN_TIMELINE_DURATION, value.duration) : EMPTY_TIMELINE.duration;
    const tracks: TimelineTrack[] = [];
    const ids = new Set<string>();
    for (const raw of Array.isArray(value.tracks) ? value.tracks : []) {
        const track = normalizeTrack(raw);
        if (!track || ids.has(track.id)) continue;
        ids.add(track.id);
        tracks.push(track);
    }
    return { duration, tracks };
};
