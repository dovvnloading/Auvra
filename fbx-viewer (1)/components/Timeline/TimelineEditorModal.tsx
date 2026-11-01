import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Captions, Crosshair, Eye, Film, Hash, Move3d, Music, PersonStanding, Plus, SunDim, Trash2, Video, Volume2, VolumeX, X, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { LevelObject } from '../../types';
import {
    TIMELINE_PLAYER_TARGET,
    type TimelineClipValue,
    type TimelineData,
    type TimelineInterpolation,
    type TimelineKey,
    type TimelineLineValue,
    type TimelineSoundValue,
    type TimelineTrack,
    type TimelineVec3,
} from '../../runtime/timeline/types';

/**
 * TIMELINE EDITOR
 *
 * A dope sheet over a copy of one timeline: a ruler with a draggable playhead, one row per track with
 * its keys drawn as diamonds (clips, sounds and subtitle lines as bars as long as they last), and a
 * panel for the selected key. Nothing reaches the level until Save, which hands the edited
 * TimelineData back in one piece; Cancel throws the copy away.
 */

export interface TimelineEditorModalProps {
    /** The timeline to edit, as normalizeTimeline returns it; the editor works on a copy until Save. */
    timeline: TimelineData;
    /** Level objects that transform and visibility tracks can target. */
    objects: LevelObject[];
    /** Declared level variable names, offered to variable tracks. */
    variableNames?: string[];
    /** New transform and visibility tracks target this object (the timeline's owner) when it is in `objects`. */
    ownerId?: string;
    /** Shown under the title, e.g. the owning object's name. */
    subtitle?: string;
    /** Clip names an animation track's target can play (a level object id, or TIMELINE_PLAYER_TARGET). */
    clipsFor?: (objectId: string) => string[];
    /** Audio assets sound keys can play. */
    sounds?: { id: string; label: string }[];
    /** Called with the timeline being edited and the playhead whenever either changes, for a preview in the viewport. */
    onPreview?: (timeline: TimelineData, time: number) => void;
    /** Receives the edited timeline when Save is pressed with changes; onClose follows. */
    onSave: (timeline: TimelineData) => void;
    /** Closes the editor; unsaved changes are confirmed in the editor first. */
    onClose: () => void;
}

type TrackKind = TimelineTrack['kind'];
type TransformChannel = 'position' | 'rotation' | 'scale';
/** A key list of a track: one of the transform channels, or `keys` for the other kinds. */
type Channel = TransformChannel | 'keys';
type KeyValue = TimelineVec3 | boolean | number | string | TimelineClipValue | TimelineSoundValue | TimelineLineValue;
type AnyKey = TimelineKey<KeyValue>;

/** A key's place in the draft. The index follows the key when its list is re-sorted by time. */
interface KeyRef {
    trackId: string;
    channel: Channel;
    index: number;
}

interface Lane {
    channel: Channel;
    label: string;
}

interface KeyDrag {
    pointerId: number;
    startX: number;
    startTime: number;
    ref: KeyRef;
    moved: boolean;
}

type KeyInput = Pick<KeyboardEvent, 'key' | 'target' | 'preventDefault'>;

const SNAP_STEP = 0.05;
/** Matches MIN_TIMELINE_DURATION in runtime/timeline/evaluate. */
const MIN_DURATION = 0.05;
const MAX_DURATION = 600;
const MIN_ZOOM = 20;
const MAX_ZOOM = 400;
const HEADER_WIDTH = 256;
/** Room before time 0, so a key there is not under the track headers. */
const LANE_INSET = 10;
/** Room after the end of the lanes, where keys past the duration are drawn. */
const LANE_TAIL = 24;
const LANE_HEIGHT = 30;
const MIN_ROW_HEIGHT = 60;
const DRAG_THRESHOLD = 3;
const TIME_EPSILON = 1e-4;
const TICK_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
const TRACK_KINDS: TrackKind[] = ['transform', 'visibility', 'variable', 'event', 'camera', 'animation', 'audio', 'subtitle', 'fade'];
const TRANSFORM_CHANNELS: TransformChannel[] = ['position', 'rotation', 'scale'];
const CHANNEL_LABELS: Record<TransformChannel, string> = { position: 'Position', rotation: 'Rotation', scale: 'Scale' };
const AXES = ['X', 'Y', 'Z'] as const;
const INTERPOLATIONS: { value: TimelineInterpolation; label: string }[] = [
    { value: 'linear', label: 'Linear' },
    { value: 'step', label: 'Step' },
    { value: 'smooth', label: 'Smooth' },
];

const KIND_INFO: Record<TrackKind, { label: string; icon: LucideIcon; text: string; fill: string }> = {
    transform: { label: 'Transform', icon: Move3d, text: 'text-blue-400', fill: 'bg-blue-400' },
    visibility: { label: 'Visibility', icon: Eye, text: 'text-emerald-400', fill: 'bg-emerald-400' },
    variable: { label: 'Variable', icon: Hash, text: 'text-violet-400', fill: 'bg-violet-400' },
    event: { label: 'Event', icon: Zap, text: 'text-amber-400', fill: 'bg-amber-400' },
    camera: { label: 'Camera', icon: Video, text: 'text-pink-400', fill: 'bg-pink-400' },
    animation: { label: 'Animation', icon: PersonStanding, text: 'text-orange-400', fill: 'bg-orange-400' },
    audio: { label: 'Audio', icon: Music, text: 'text-cyan-400', fill: 'bg-cyan-400' },
    subtitle: { label: 'Subtitles', icon: Captions, text: 'text-lime-300', fill: 'bg-lime-300' },
    fade: { label: 'Fade', icon: SunDim, text: 'text-slate-300', fill: 'bg-slate-300' },
};

/** A clip, sound or subtitle key lasts a length and is drawn as a bar; other keys are instants. */
const spanOf = (value: KeyValue): number | null =>
    (typeof value === 'object' && !Array.isArray(value) && 'length' in value ? value.length : null);

/** What a bar shows: the clip, the sound or the line. */
const spanLabel = (value: KeyValue, sounds: readonly { id: string; label: string }[]): string => {
    if (typeof value !== 'object' || Array.isArray(value)) return '';
    if ('clip' in value) return value.clip || 'No clip';
    if ('sound' in value) return sounds.find(sound => sound.id === value.sound)?.label ?? (value.sound || 'No sound');
    return value.speaker ? `${value.speaker}: ${value.text}` : value.text;
};

/** Objects that can play clips: those with a model. */
export const animatedObjects = (objects: readonly LevelObject[]): LevelObject[] => objects.filter(object => !!object.modelId);

/** Objects that carry a Camera component, which camera keys can cut to. */
export const cameraObjects = (objects: readonly LevelObject[]): LevelObject[] =>
    objects.filter(object => object.components?.some(component => component.type === 'camera' && component.enabled !== false));

const SECTION_TITLE = 'text-2xs font-bold text-gray-500 ';
const FIELD_CLASS = 'bg-gray-950 border border-gray-800 rounded px-1.5 h-6 text-2xs text-white focus:outline-none focus:border-blue-500';

// --- PURE HELPERS ---

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round3 = (value: number) => Math.round(value * 1000) / 1000;
/** Snaps to the 0.05 s grid unless `free`; whole milliseconds either way. */
const snapTime = (time: number, free: boolean) => round3(free ? time : Math.round(time / SNAP_STEP) * SNAP_STEP);
const formatNumber = (value: number) => String(round3(value));
const formatTime = (time: number) => `${time.toFixed(2)} s`;
const sortKeys = (keys: AnyKey[]) => [...keys].sort((a, b) => a.time - b.time);
const sameTime = (a: number, b: number) => Math.abs(a - b) < TIME_EPSILON;

const randomId = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `track-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

/** A new track id that no id in `taken` uses. */
const createTrackId = (taken: Set<string>) => {
    let id = randomId();
    while (taken.has(id)) id = randomId();
    return id;
};

const createTrack = (kind: TrackKind, id: string, objectId: string): TimelineTrack => {
    switch (kind) {
        case 'transform': return { id, kind, objectId, position: [], rotation: [], scale: [] };
        case 'visibility': return { id, kind, objectId, keys: [] };
        case 'variable': return { id, kind, name: '', keys: [] };
        case 'event': return { id, kind, keys: [] };
        case 'camera': return { id, kind, keys: [], blend: 0 };
        case 'animation': return { id, kind, objectId, keys: [] };
        case 'audio': return { id, kind, objectId: '', bus: 'sfx', keys: [] };
        case 'subtitle': return { id, kind, keys: [] };
        case 'fade': return { id, kind, color: '#000000', keys: [] };
    }
};

const lanesOf = (track: TimelineTrack): Lane[] => {
    switch (track.kind) {
        case 'transform': return TRANSFORM_CHANNELS.map(channel => ({ channel, label: CHANNEL_LABELS[channel] }));
        case 'visibility': return [{ channel: 'keys', label: 'Visible' }];
        case 'variable': return [{ channel: 'keys', label: 'Value' }];
        case 'event': return [{ channel: 'keys', label: 'Events' }];
        case 'camera': return [{ channel: 'keys', label: 'Shots' }];
        case 'animation': return [{ channel: 'keys', label: 'Clips' }];
        case 'audio': return [{ channel: 'keys', label: 'Sounds' }];
        case 'subtitle': return [{ channel: 'keys', label: 'Lines' }];
        case 'fade': return [{ channel: 'keys', label: 'Cover' }];
    }
};

/** Only transform, variable and fade keys blend; the others step (clips blend by their own fades). */
const blends = (track: TimelineTrack) => track.kind === 'transform' || track.kind === 'variable' || track.kind === 'fade';

const getKeys = (track: TimelineTrack, channel: Channel): AnyKey[] => {
    if (track.kind === 'transform') return channel === 'keys' ? [] : track[channel] ?? [];
    return channel === 'keys' ? track.keys : [];
};

/** Replaces one key list; callers keep each list's values of the track's type. */
const setKeys = (track: TimelineTrack, channel: Channel, keys: AnyKey[]): TimelineTrack => {
    switch (track.kind) {
        case 'transform': {
            const vectors = keys as TimelineKey<TimelineVec3>[];
            if (channel === 'position') return { ...track, position: vectors };
            if (channel === 'rotation') return { ...track, rotation: vectors };
            if (channel === 'scale') return { ...track, scale: vectors };
            return track;
        }
        case 'visibility': return { ...track, keys: keys as TimelineKey<boolean>[] };
        case 'variable': return { ...track, keys: keys as TimelineKey<number>[] };
        case 'event': return { ...track, keys: keys as TimelineKey<string>[] };
        case 'camera': return { ...track, keys: keys as TimelineKey<string>[] };
        case 'animation': return { ...track, keys: keys as TimelineKey<TimelineClipValue>[] };
        case 'audio': return { ...track, keys: keys as TimelineKey<TimelineSoundValue>[] };
        case 'subtitle': return { ...track, keys: keys as TimelineKey<TimelineLineValue>[] };
        case 'fade': return { ...track, keys: keys as TimelineKey<number>[] };
    }
};

const mapTrack = (data: TimelineData, trackId: string, change: (track: TimelineTrack) => TimelineTrack): TimelineData => ({
    ...data,
    tracks: data.tracks.map(track => (track.id === trackId ? change(track) : track)),
});

const findKey = (data: TimelineData, ref: KeyRef | null): { track: TimelineTrack; key: AnyKey } | null => {
    if (!ref) return null;
    const track = data.tracks.find(candidate => candidate.id === ref.trackId);
    const key = track ? getKeys(track, ref.channel)[ref.index] : undefined;
    return track && key ? { track, key } : null;
};

/** Swaps the referenced key for `next`, re-sorts its list and says where it ended up. */
const replaceKey = (data: TimelineData, ref: KeyRef, next: AnyKey): { data: TimelineData; ref: KeyRef } | null => {
    const found = findKey(data, ref);
    if (!found) return null;
    const keys = sortKeys(getKeys(found.track, ref.channel).map((key, index) => (index === ref.index ? next : key)));
    return { data: mapTrack(data, ref.trackId, track => setKeys(track, ref.channel, keys)), ref: { ...ref, index: keys.indexOf(next) } };
};

/** Puts `key` on a list, replacing any key at the same time, and keeps the list in time order. */
const upsertKey = (track: TimelineTrack, channel: Channel, key: AnyKey): { track: TimelineTrack; index: number } => {
    const keys = sortKeys([...getKeys(track, channel).filter(existing => !sameTime(existing.time, key.time)), key]);
    return { track: setKeys(track, channel, keys), index: keys.indexOf(key) };
};

const copyValue = (value: KeyValue): KeyValue => {
    if (typeof value === 'object' && !Array.isArray(value)) return { ...value };
    if (!Array.isArray(value)) return value;
    const vector: TimelineVec3 = [value[0], value[1], value[2]];
    return vector;
};

/** An object's local transform channel as a key value; rotation in degrees, like the inspector. */
const objectChannelValue = (object: LevelObject, channel: TransformChannel): TimelineVec3 => {
    const source = object[channel];
    const scale = channel === 'rotation' ? 180 / Math.PI : 1;
    return [round3(source[0] * scale), round3(source[1] * scale), round3(source[2] * scale)];
};

/**
 * The key double-clicking a lane adds at `time`: transform keys copy the neighbouring key (or the target
 * object's current transform), visibility keys flip the key before them, other keys copy their neighbour.
 */
const createKey = (
    track: TimelineTrack,
    channel: Channel,
    time: number,
    objects: LevelObject[],
    sources: { clipsFor?: (objectId: string) => string[]; sounds?: readonly { id: string }[] } = {},
): AnyKey => {
    const keys = getKeys(track, channel);
    const previous = [...keys].reverse().find(key => key.time <= time);
    const neighbour = previous ?? keys.find(key => key.time > time);
    let value: KeyValue;
    switch (track.kind) {
        case 'transform': {
            const object = objects.find(candidate => candidate.id === track.objectId);
            if (neighbour) value = copyValue(neighbour.value);
            else if (object && channel !== 'keys') value = objectChannelValue(object, channel);
            else value = channel === 'scale' ? [1, 1, 1] : [0, 0, 0];
            break;
        }
        case 'visibility': value = previous ? !previous.value : true; break;
        case 'variable': value = neighbour?.value ?? 0; break;
        case 'event': value = neighbour?.value ?? 'Event'; break;
        case 'camera': value = neighbour?.value ?? cameraObjects(objects)[0]?.id ?? ''; break;
        case 'animation': value = neighbour ? copyValue(neighbour.value) : {
            clip: sources.clipsFor?.(track.objectId)[0] ?? '', length: 2, offset: 0, speed: 1, loop: true, blendIn: 0.25, blendOut: 0.25,
        }; break;
        case 'audio': value = neighbour ? copyValue(neighbour.value) : { sound: sources.sounds?.[0]?.id ?? '', length: 3, volume: 1 }; break;
        case 'subtitle': {
            const speaker = neighbour && typeof neighbour.value === 'object' && 'speaker' in neighbour.value ? neighbour.value.speaker : '';
            value = { speaker, text: 'Line', length: 3 };
            break;
        }
        case 'fade': value = neighbour?.value ?? 1; break;
    }
    const key: AnyKey = { time, value };
    if (blends(track) && previous?.interpolation) key.interpolation = previous.interpolation;
    return key;
};

/** The timeline as it is saved: labels trimmed (blank ones dropped), unmuted flags and transform channels without keys left out. */
const cleanTimeline = (data: TimelineData): TimelineData => ({
    duration: data.duration,
    tracks: data.tracks.map(track => {
        const next = { ...track };
        const label = next.label?.trim();
        if (label) next.label = label;
        else delete next.label;
        if (!next.muted) delete next.muted;
        if (next.kind === 'transform') {
            for (const channel of TRANSFORM_CHANNELS) if (!next[channel]?.length) delete next[channel];
        }
        if (next.kind === 'variable') next.name = next.name.trim();
        return next;
    }),
});

const describeValue = (value: KeyValue) => {
    if (Array.isArray(value)) return `(${value.map(formatNumber).join(', ')})`;
    if (typeof value === 'object') {
        if ('clip' in value) return `${value.clip || 'No clip'}, ${formatNumber(value.length)} s`;
        if ('sound' in value) return `${value.sound || 'No sound'}, ${formatNumber(value.length)} s`;
        return `"${value.text}", ${formatNumber(value.length)} s`;
    }
    if (typeof value === 'boolean') return value ? 'Visible' : 'Hidden';
    if (typeof value === 'number') return formatNumber(value);
    return `"${value}"`;
};

const isTextEntry = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
    return target.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button'].includes((target as HTMLInputElement).type);
};

// --- FIELDS ---

/** A number box that keeps what is typed while focused and passes on each valid number. */
const NumberField: React.FC<{
    label: string;
    ariaLabel?: string;
    value: number;
    onChange: (value: number) => void;
    min?: number;
    max?: number;
    suffix?: string;
    labelClass?: string;
}> = ({ label, ariaLabel, value, onChange, min = -Infinity, max = Infinity, suffix, labelClass = 'text-gray-400' }) => {
    const [text, setText] = useState<string | null>(null);
    return (
        <label className="flex items-center gap-1.5 text-2xs">
            <span className={labelClass}>{label}</span>
            <input
                type="text"
                inputMode="decimal"
                aria-label={ariaLabel ?? label}
                value={text ?? formatNumber(value)}
                onChange={(event) => {
                    const raw = event.target.value;
                    setText(raw);
                    const parsed = raw.trim() === '' ? NaN : Number(raw);
                    if (Number.isFinite(parsed)) onChange(clamp(parsed, min, max));
                }}
                onBlur={() => setText(null)}
                onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                className={`w-16 font-mono ${FIELD_CLASS}`}
            />
            {suffix && <span className="text-gray-500">{suffix}</span>}
        </label>
    );
};

const KeyDetails: React.FC<{
    track: TimelineTrack;
    channel: Channel;
    trackName: string;
    timelineKey: AnyKey;
    duration: number;
    onChange: (next: AnyKey) => void;
    onDelete: () => void;
    /** Camera objects a camera key can cut to. */
    cameras?: { id: string; label: string }[];
    /** Clips the track's target has, and the sounds there are. */
    clips?: string[];
    sounds?: { id: string; label: string }[];
}> = ({ track, channel, trackName, timelineKey, duration, onChange, onDelete, cameras = [], clips = [], sounds = [] }) => {
    const laneLabel = lanesOf(track).find(lane => lane.channel === channel)?.label ?? '';
    const { value } = timelineKey;

    let editor: React.ReactNode = null;
    if (typeof value === 'object' && !Array.isArray(value) && 'clip' in value) {
        const set = (change: Partial<TimelineClipValue>) => onChange({ ...timelineKey, value: { ...value, ...change } });
        editor = (
            <div className="space-y-1.5">
                <select aria-label="Clip" value={value.clip} onChange={(event) => set({ clip: event.target.value })} className={`w-full ${FIELD_CLASS}`}>
                    {!value.clip && <option value="">Pick a clip</option>}
                    {value.clip && !clips.includes(value.clip) && <option value={value.clip}>{value.clip} (not on this model)</option>}
                    {clips.map(clip => <option key={clip} value={clip}>{clip}</option>)}
                </select>
                <NumberField label="Length" ariaLabel="Clip length" value={value.length} min={MIN_DURATION} max={MAX_DURATION} suffix="s" onChange={(length) => set({ length: round3(length) })} />
                <NumberField label="Start at" ariaLabel="Clip start" value={value.offset} min={0} max={MAX_DURATION} suffix="s" onChange={(offset) => set({ offset: round3(offset) })} />
                <NumberField label="Speed" ariaLabel="Clip speed" value={value.speed} min={-10} max={10} onChange={(speed) => set({ speed })} />
                <NumberField label="Blend in" ariaLabel="Clip blend in" value={value.blendIn} min={0} max={MAX_DURATION} suffix="s" onChange={(blendIn) => set({ blendIn: round3(blendIn) })} />
                <NumberField label="Blend out" ariaLabel="Clip blend out" value={value.blendOut} min={0} max={MAX_DURATION} suffix="s" onChange={(blendOut) => set({ blendOut: round3(blendOut) })} />
                <label className="flex items-center gap-2 text-2xs text-gray-300">
                    <input type="checkbox" checked={value.loop} onChange={(event) => set({ loop: event.target.checked })} className="rounded bg-gray-800 border-gray-600 text-blue-500 focus:ring-0" />
                    Loop the clip
                </label>
                <p className="text-2xs leading-snug text-gray-500">Overlapping clips crossfade; where no clip plays, the character's own animation shows. The blends ease to and from it.</p>
            </div>
        );
    } else if (typeof value === 'object' && !Array.isArray(value) && 'sound' in value) {
        const set = (change: Partial<TimelineSoundValue>) => onChange({ ...timelineKey, value: { ...value, ...change } });
        editor = (
            <div className="space-y-1.5">
                <select aria-label="Sound" value={value.sound} onChange={(event) => set({ sound: event.target.value })} className={`w-full ${FIELD_CLASS}`}>
                    {!value.sound && <option value="">Pick a sound</option>}
                    {value.sound && !sounds.some(sound => sound.id === value.sound) && <option value={value.sound}>Missing sound</option>}
                    {sounds.map(sound => <option key={sound.id} value={sound.id}>{sound.label}</option>)}
                </select>
                <NumberField label="Plays for" ariaLabel="Sound length" value={value.length} min={MIN_DURATION} max={MAX_DURATION} suffix="s" onChange={(length) => set({ length: round3(length) })} />
                <NumberField label="Volume" ariaLabel="Sound volume" value={value.volume} min={0} max={2} onChange={(volume) => set({ volume })} />
            </div>
        );
    } else if (typeof value === 'object' && !Array.isArray(value)) {
        const set = (change: Partial<TimelineLineValue>) => onChange({ ...timelineKey, value: { ...value, ...change } });
        editor = (
            <div className="space-y-1.5">
                <label className="block text-2xs text-gray-400">
                    Speaker
                    <input type="text" aria-label="Speaker" value={value.speaker} onChange={(event) => set({ speaker: event.target.value })} className={`mt-1 w-full ${FIELD_CLASS}`} />
                </label>
                <label className="block text-2xs text-gray-400">
                    Line
                    <textarea aria-label="Line" value={value.text} rows={3} onChange={(event) => set({ text: event.target.value })} className={`mt-1 w-full resize-y py-1 ${FIELD_CLASS} h-auto`} />
                </label>
                <NumberField label="On screen" ariaLabel="Line length" value={value.length} min={MIN_DURATION} max={MAX_DURATION} suffix="s" onChange={(length) => set({ length: round3(length) })} />
            </div>
        );
    } else if (Array.isArray(value)) {
        editor = (
            <div className="space-y-1.5">
                {AXES.map((axis, index) => (
                    <NumberField
                        key={axis}
                        label={axis}
                        ariaLabel={`${laneLabel} ${axis}`}
                        labelClass={['text-red-400', 'text-green-400', 'text-blue-400'][index]}
                        value={value[index]}
                        suffix={channel === 'rotation' ? 'deg' : undefined}
                        onChange={(next) => {
                            const vector: TimelineVec3 = [value[0], value[1], value[2]];
                            vector[index] = next;
                            onChange({ ...timelineKey, value: vector });
                        }}
                    />
                ))}
            </div>
        );
    } else if (typeof value === 'boolean') {
        editor = (
            <label className="flex items-center gap-2 text-2xs text-gray-300">
                <input
                    type="checkbox"
                    checked={value}
                    onChange={(event) => onChange({ ...timelineKey, value: event.target.checked })}
                    className="rounded bg-gray-800 border-gray-600 text-blue-500 focus:ring-0"
                />
                Visible
            </label>
        );
    } else if (typeof value === 'number') {
        editor = track.kind === 'fade'
            ? <NumberField label="Cover" ariaLabel="Fade cover" value={value} min={0} max={1} onChange={(next) => onChange({ ...timelineKey, value: next })} />
            : <NumberField label="Value" value={value} onChange={(next) => onChange({ ...timelineKey, value: next })} />;
    } else if (track.kind === 'camera') {
        editor = (
            <select
                aria-label="Camera"
                value={value}
                onChange={(event) => onChange({ ...timelineKey, value: event.target.value })}
                className={`w-full ${FIELD_CLASS}`}
            >
                <option value="">Gameplay camera</option>
                {value && !cameras.some(camera => camera.id === value) && <option value={value}>Missing camera</option>}
                {cameras.map(camera => <option key={camera.id} value={camera.id}>{camera.label}</option>)}
            </select>
        );
    } else {
        editor = (
            <label className="block text-2xs text-gray-400">
                Event name
                <input
                    type="text"
                    value={value}
                    onChange={(event) => onChange({ ...timelineKey, value: event.target.value })}
                    className={`mt-1 w-full ${FIELD_CLASS}`}
                />
            </label>
        );
    }

    return (
        <div className="space-y-3">
            <div>
                <div className={SECTION_TITLE}>Selected key</div>
                <div className="mt-0.5 text-xs text-gray-200 truncate" title={`${trackName} · ${laneLabel}`}>{trackName} · {laneLabel}</div>
            </div>
            <NumberField
                label="Time"
                ariaLabel="Key time"
                value={timelineKey.time}
                min={0}
                max={duration}
                suffix="s"
                onChange={(time) => onChange({ ...timelineKey, time: round3(time) })}
            />
            <div className="space-y-1.5">
                <div className={SECTION_TITLE}>Value</div>
                {editor}
            </div>
            <div className="space-y-1.5">
                <div className={SECTION_TITLE}>Interpolation</div>
                {blends(track) ? (
                    <select
                        aria-label="Interpolation"
                        value={timelineKey.interpolation ?? 'linear'}
                        onChange={(event) => {
                            const interpolation = INTERPOLATIONS.find(option => option.value === event.target.value)?.value;
                            if (interpolation) onChange({ ...timelineKey, interpolation });
                        }}
                        className={`w-full ${FIELD_CLASS}`}
                    >
                        {INTERPOLATIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                ) : (
                    <p className="text-2xs text-gray-500">{
                        track.kind === 'animation' ? 'Clips blend by their own blend in and out.'
                            : track.kind === 'audio' || track.kind === 'subtitle' ? 'It starts at its key and lasts its length.'
                                : `${track.kind === 'event' ? 'Event' : track.kind === 'camera' ? 'Camera' : 'Visibility'} keys always step: the value holds until the next key.`
                    }</p>
                )}
                {blends(track) && (
                    <p className="text-2xs text-gray-500 leading-snug">How the value moves from this key to the next: a straight line, a hold, or an ease in and out.</p>
                )}
            </div>
            <button
                type="button"
                onClick={onDelete}
                className="w-full py-1.5 text-xs bg-gray-800 hover:bg-red-900/40 border border-gray-700 hover:border-red-800 rounded text-gray-300 hover:text-red-300 flex items-center justify-center gap-2 transition-colors"
            >
                <Trash2 size={12} /> Delete Key
            </button>
        </div>
    );
};

// --- EDITOR ---

/** Full-screen dope-sheet editor for one timeline; see TimelineEditorModalProps. */
export const TimelineEditorModal: React.FC<TimelineEditorModalProps> = ({
    timeline, objects, variableNames = [], ownerId, subtitle, clipsFor, sounds = [], onPreview, onSave, onClose,
}) => {
    const [baseline] = useState(() => JSON.stringify(cleanTimeline(timeline)));
    const [draft, setDraft] = useState(timeline);
    const draftRef = useRef(draft);
    const [selected, setSelected] = useState<KeyRef | null>(null);
    const [playhead, setPlayhead] = useState(0);
    const [zoom, setZoom] = useState(() => clamp(Math.round(800 / Math.max(timeline.duration, MIN_DURATION)), MIN_ZOOM, MAX_ZOOM));
    const [confirmDiscard, setConfirmDiscard] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const rulerRef = useRef<HTMLDivElement>(null);
    const scrubRef = useRef<number | null>(null);
    const dragRef = useRef<KeyDrag | null>(null);
    const variableListId = useId();

    const { duration } = draft;
    const dirty = useMemo(() => JSON.stringify(cleanTimeline(draft)) !== baseline, [draft, baseline]);
    const objectsById = useMemo(() => new Map(objects.map(object => [object.id, object])), [objects]);
    const objectOptions = useMemo(() => {
        const counts = new Map<string, number>();
        objects.forEach(object => counts.set(object.name || object.type, (counts.get(object.name || object.type) ?? 0) + 1));
        return objects.map(object => {
            const name = object.name || object.type;
            return { id: object.id, label: (counts.get(name) ?? 0) > 1 ? `${name} (${object.id.slice(0, 4)})` : name };
        });
    }, [objects]);
    const cameraOptions = useMemo(() => {
        const ids = new Set(cameraObjects(objects).map(object => object.id));
        return objectOptions.filter(option => ids.has(option.id));
    }, [objects, objectOptions]);
    const characterOptions = useMemo(() => {
        const ids = new Set(animatedObjects(objects).map(object => object.id));
        return objectOptions.filter(option => ids.has(option.id));
    }, [objects, objectOptions]);
    const sources = { clipsFor, sounds };

    // The viewport follows the draft and the playhead.
    useEffect(() => { onPreview?.(draft, playhead); }, [draft, playhead, onPreview]);
    const lateKeys = useMemo(() => draft.tracks.reduce((count, track) => count + lanesOf(track).reduce(
        (laneCount, lane) => laneCount + getKeys(track, lane.channel).filter(key => key.time > draft.duration + TIME_EPSILON).length, 0,
    ), 0), [draft]);

    const tickStep = TICK_STEPS.find(step => step * zoom >= 64) ?? TICK_STEPS[TICK_STEPS.length - 1];
    const tickDecimals = tickStep >= 1 ? 0 : (tickStep * 10) % 1 === 0 ? 1 : 2;
    const ticks = useMemo(() => {
        const list: number[] = [];
        for (let index = 0; index * tickStep <= duration + TIME_EPSILON; index += 1) list.push(round3(index * tickStep));
        return list;
    }, [tickStep, duration]);
    const laneWidth = duration * zoom;
    const laneSpan = LANE_INSET + laneWidth + LANE_TAIL;
    const contentWidth = HEADER_WIDTH + laneSpan;
    /** Horizontal position of `time` inside a lane (and the ruler). */
    const xAt = (time: number) => LANE_INSET + time * zoom;

    const commit = (next: TimelineData) => {
        draftRef.current = next;
        setDraft(next);
    };

    const trackName = (track: TimelineTrack) => {
        const label = track.label?.trim();
        if (label) return label;
        switch (track.kind) {
            case 'transform':
            case 'visibility': {
                const object = objectsById.get(track.objectId);
                return object ? object.name || object.type : `${KIND_INFO[track.kind].label} (no target)`;
            }
            case 'variable': return track.name.trim() || 'Variable';
            case 'event': return 'Events';
            case 'camera': return 'Camera cuts';
            case 'animation': {
                if (track.objectId === TIMELINE_PLAYER_TARGET) return 'The player';
                const object = objectsById.get(track.objectId);
                return object ? object.name || object.type : 'Animation (no character)';
            }
            case 'audio': {
                if (track.objectId === TIMELINE_PLAYER_TARGET) return 'Sounds from the player';
                const object = objectsById.get(track.objectId);
                return object ? `Sounds from ${object.name || object.type}` : 'Sounds';
            }
            case 'subtitle': return 'Subtitles';
            case 'fade': return 'Fade';
        }
    };

    // --- Tracks ---

    const addTrack = (kind: TrackKind) => {
        const data = draftRef.current;
        const characters = animatedObjects(objects);
        const target = kind === 'animation'
            ? (ownerId && characters.some(object => object.id === ownerId) ? ownerId : characters[0]?.id ?? TIMELINE_PLAYER_TARGET)
            : ownerId && objectsById.has(ownerId) ? ownerId : objects[0]?.id ?? '';
        const track = createTrack(kind, createTrackId(new Set(data.tracks.map(existing => existing.id))), target);
        commit({ ...data, tracks: [...data.tracks, track] });
    };

    const changeTrack = (trackId: string, change: (track: TimelineTrack) => TimelineTrack) => commit(mapTrack(draftRef.current, trackId, change));

    const deleteTrack = (trackId: string) => {
        const data = draftRef.current;
        commit({ ...data, tracks: data.tracks.filter(track => track.id !== trackId) });
        if (selected?.trackId === trackId) setSelected(null);
        rootRef.current?.focus({ preventScroll: true });
    };

    // --- Keys ---

    const addKeyAtPlayhead = (trackId: string, channel: Channel) => {
        const data = draftRef.current;
        const track = data.tracks.find(candidate => candidate.id === trackId);
        if (!track) return;
        const time = clamp(playhead, 0, data.duration);
        const existing = getKeys(track, channel).findIndex(key => sameTime(key.time, time));
        if (existing >= 0) {
            setSelected({ trackId, channel, index: existing });
            return;
        }
        const result = upsertKey(track, channel, createKey(track, channel, time, objects, sources));
        commit(mapTrack(data, trackId, () => result.track));
        setSelected({ trackId, channel, index: result.index });
    };

    /** Keys the target's current position, rotation and scale at the playhead, replacing keys already there. */
    const recordFromObject = (trackId: string) => {
        const data = draftRef.current;
        const track = data.tracks.find(candidate => candidate.id === trackId);
        const object = track?.kind === 'transform' ? objectsById.get(track.objectId) : undefined;
        if (!track || !object) return;
        const time = clamp(playhead, 0, data.duration);
        let next: TimelineTrack = track;
        let positionIndex = 0;
        for (const channel of TRANSFORM_CHANNELS) {
            // A key already at the playhead keeps its interpolation; a new one takes the previous key's.
            const base = getKeys(next, channel).find(key => sameTime(key.time, time)) ?? createKey(next, channel, time, objects);
            const result = upsertKey(next, channel, { ...base, value: objectChannelValue(object, channel) });
            next = result.track;
            if (channel === 'position') positionIndex = result.index;
        }
        commit(mapTrack(data, trackId, () => next));
        setSelected({ trackId, channel: 'position', index: positionIndex });
    };

    const changeSelectedKey = (next: AnyKey) => {
        if (!selected) return;
        const result = replaceKey(draftRef.current, selected, next);
        if (!result) return;
        commit(result.data);
        setSelected(result.ref);
    };

    const deleteSelectedKey = () => {
        const data = draftRef.current;
        const found = findKey(data, selected);
        if (!found || !selected) return;
        const keys = getKeys(found.track, selected.channel).filter((_key, index) => index !== selected.index);
        commit(mapTrack(data, selected.trackId, track => setKeys(track, selected.channel, keys)));
        setSelected(null);
        rootRef.current?.focus({ preventScroll: true });
    };

    const startKeyDrag = (event: React.PointerEvent<HTMLButtonElement>, ref: KeyRef, time: number) => {
        event.stopPropagation();
        if (event.button !== 0) return;
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startTime: time, ref, moved: false };
        setSelected(ref);
    };

    const moveKeyDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const offset = event.clientX - drag.startX;
        if (!drag.moved && Math.abs(offset) < DRAG_THRESHOLD) return;
        drag.moved = true;
        const data = draftRef.current;
        const found = findKey(data, drag.ref);
        if (!found) return;
        const time = clamp(snapTime(drag.startTime + offset / zoom, event.shiftKey), 0, data.duration);
        if (found.key.time === time) return;
        const result = replaceKey(data, drag.ref, { ...found.key, time });
        if (!result) return;
        drag.ref = result.ref;
        commit(result.data);
        setSelected(result.ref);
    };

    const endKeyDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        dragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    };

    // --- Playhead ---

    const movePlayhead = (time: number) => setPlayhead(clamp(time, 0, draftRef.current.duration));

    const scrubTo = (event: React.PointerEvent<HTMLDivElement>) => {
        const left = rulerRef.current?.getBoundingClientRect().left ?? 0;
        movePlayhead(snapTime((event.clientX - left - LANE_INSET) / zoom, event.shiftKey));
    };

    const changeDuration = (value: number) => {
        const next = clamp(round3(value), MIN_DURATION, MAX_DURATION);
        commit({ ...draftRef.current, duration: next });
        setPlayhead(current => Math.min(current, next));
    };

    // --- Closing and keys ---

    const requestClose = () => {
        if (dirty) setConfirmDiscard(true);
        else onClose();
    };

    const save = () => {
        if (dirty) onSave(cleanTimeline(draftRef.current));
        onClose();
    };

    const keepEditing = () => {
        setConfirmDiscard(false);
        rootRef.current?.focus({ preventScroll: true });
    };

    const handleKey = (event: KeyInput) => {
        if (confirmDiscard) {
            if (event.key === 'Escape') {
                event.preventDefault();
                keepEditing();
            }
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            requestClose();
        } else if ((event.key === 'Delete' || event.key === 'Backspace') && selected && !isTextEntry(event.target)) {
            event.preventDefault();
            deleteSelectedKey();
        }
    };
    const handleKeyRef = useRef(handleKey);
    handleKeyRef.current = handleKey;

    useEffect(() => {
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        rootRef.current?.focus({ preventScroll: true });
        // Keys whose target fell outside the editor (a focused control was removed) stay away from the
        // world editor's hotkeys, which would otherwise delete or undo level objects behind the modal.
        const guard = (event: KeyboardEvent) => {
            const root = rootRef.current;
            if (!root || (event.target instanceof Node && root.contains(event.target))) return;
            event.stopPropagation();
            root.focus({ preventScroll: true });
            handleKeyRef.current(event);
        };
        window.addEventListener('keydown', guard, true);
        return () => {
            window.removeEventListener('keydown', guard, true);
            previous?.focus({ preventScroll: true });
        };
    }, []);

    const stop = (event: React.SyntheticEvent) => event.stopPropagation();
    const selection = findKey(draft, selected);

    return createPortal(
        <div
            ref={rootRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="Timeline editor"
            // Docked along the bottom, so the viewport above shows the timeline at the playhead.
            className="fixed inset-x-0 bottom-0 z-[100] flex justify-center p-2 outline-none"
            onKeyDown={(event) => {
                event.stopPropagation();
                handleKey(event);
            }}
            onPointerDown={stop}
            onClick={stop}
            onDoubleClick={stop}
            onContextMenu={stop}
        >
            <div className="relative flex w-full h-[50vh] min-h-[320px] flex-col overflow-hidden rounded-xl border border-gray-700 bg-gray-900 shadow-2xl">
                <div className="flex items-center justify-between border-b border-gray-800 bg-gray-950 px-5 py-3">
                    <div className="flex items-center gap-3 min-w-0">
                        <Film size={18} className="text-blue-400 shrink-0" />
                        <div className="min-w-0">
                            <h2 className="text-sm font-bold text-white">Timeline</h2>
                            <p className="text-2xs text-gray-500 truncate">
                                {subtitle ? `${subtitle} · ` : ''}The viewport shows the playhead · double-click a row to key there · drag keys to move (Shift: free timing) · Delete removes
                            </p>
                        </div>
                    </div>
                    <button type="button" onClick={requestClose} className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-white" aria-label="Close timeline editor"><X size={16} /></button>
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-gray-800 bg-gray-950/60 px-4 py-2">
                    <NumberField label="Duration" value={duration} min={MIN_DURATION} max={MAX_DURATION} suffix="s" onChange={changeDuration} />
                    <NumberField label="Playhead" ariaLabel="Playhead time" value={playhead} min={0} max={duration} suffix="s" onChange={(time) => movePlayhead(round3(time))} />
                    <div className="h-5 w-px bg-gray-800" />
                    <div className="flex flex-wrap items-center gap-1.5">
                        {TRACK_KINDS.map(kind => {
                            const { label, icon: Icon, text } = KIND_INFO[kind];
                            return (
                                <button
                                    key={kind}
                                    type="button"
                                    onClick={() => addTrack(kind)}
                                    aria-label={`Add ${label} track`}
                                    className="flex items-center gap-1 rounded border border-gray-700 bg-gray-800 px-2 h-6 text-2xs text-gray-300 hover:bg-gray-700 transition-colors"
                                >
                                    <Plus size={11} /><Icon size={11} className={text} /> {label}
                                </button>
                            );
                        })}
                    </div>
                    <label className="ml-auto flex items-center gap-2 text-2xs text-gray-400">
                        Zoom
                        <input type="range" aria-label="Zoom" min={MIN_ZOOM} max={MAX_ZOOM} step={1} value={zoom} onChange={(event) => setZoom(clamp(Number(event.target.value), MIN_ZOOM, MAX_ZOOM))} className="w-28" />
                    </label>
                </div>

                <div className="flex min-h-0 flex-1">
                    <div className="min-w-0 flex-1 overflow-auto custom-scrollbar">
                        <div className="relative min-h-full" style={{ width: contentWidth }}>
                            <div className="sticky top-0 z-30 flex h-7 border-b border-gray-800 bg-gray-950" style={{ width: contentWidth }}>
                                <div className="sticky left-0 z-40 flex shrink-0 items-center border-r border-gray-800 bg-gray-950 px-3 text-2xs font-bold text-gray-500" style={{ width: HEADER_WIDTH }}>
                                    Tracks
                                </div>
                                <div
                                    ref={rulerRef}
                                    role="slider"
                                    tabIndex={0}
                                    aria-label="Playhead"
                                    aria-valuemin={0}
                                    aria-valuemax={duration}
                                    aria-valuenow={playhead}
                                    aria-valuetext={formatTime(playhead)}
                                    className="relative shrink-0 cursor-pointer select-none outline-none focus-visible:bg-gray-900"
                                    style={{ width: laneSpan }}
                                    onPointerDown={(event) => {
                                        if (event.button !== 0) return;
                                        event.currentTarget.setPointerCapture(event.pointerId);
                                        scrubRef.current = event.pointerId;
                                        scrubTo(event);
                                    }}
                                    onPointerMove={(event) => { if (scrubRef.current === event.pointerId) scrubTo(event); }}
                                    onPointerUp={(event) => {
                                        if (scrubRef.current !== event.pointerId) return;
                                        scrubRef.current = null;
                                        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                                    }}
                                    onPointerCancel={() => { scrubRef.current = null; }}
                                    onKeyDown={(event) => {
                                        const step = event.shiftKey ? 1 : SNAP_STEP;
                                        if (event.key === 'ArrowLeft') movePlayhead(round3(playhead - step));
                                        else if (event.key === 'ArrowRight') movePlayhead(round3(playhead + step));
                                        else if (event.key === 'Home') movePlayhead(0);
                                        else if (event.key === 'End') movePlayhead(duration);
                                        else return;
                                        event.preventDefault();
                                    }}
                                >
                                    <div className="absolute inset-y-0 right-0 bg-black/40" style={{ width: LANE_TAIL }} />
                                    {ticks.map(tick => (
                                        <div key={tick} className="absolute bottom-0 h-full border-l border-gray-700/80 pointer-events-none" style={{ left: xAt(tick) }}>
                                            <span className="absolute top-0.5 left-1 text-2xs font-mono text-gray-500">{tick.toFixed(tickDecimals)}</span>
                                        </div>
                                    ))}
                                    <div className="absolute bottom-0 -ml-1.5 h-0 w-0 border-x-[6px] border-t-[8px] border-x-transparent border-t-amber-400 pointer-events-none" style={{ left: xAt(playhead) }} />
                                </div>
                            </div>

                            {draft.tracks.length === 0 && (
                                <div className="sticky left-0 px-4 py-10 text-center text-xs text-gray-500" style={{ width: HEADER_WIDTH + Math.min(laneWidth, 640) }}>
                                    No tracks yet. Add a track above: Transform, Visibility, Variable, Event and Camera tracks key objects, values and shots;
                                    Animation, Audio, Subtitles and Fade tracks play clips on characters, sounds, lines and fades for cinematics.
                                </div>
                            )}

                            {draft.tracks.map(track => {
                                const lanes = lanesOf(track);
                                const info = KIND_INFO[track.kind];
                                const Icon = info.icon;
                                const name = trackName(track);
                                const rowHeight = Math.max(lanes.length * LANE_HEIGHT, MIN_ROW_HEIGHT);
                                const target = track.kind === 'transform' || track.kind === 'visibility' ? track.objectId : null;
                                return (
                                    <div
                                        key={track.id}
                                        role="group"
                                        aria-label={`${name} track`}
                                        className={`flex border-b border-gray-800 ${track.muted ? 'opacity-50' : ''}`}
                                        style={{ width: contentWidth, height: rowHeight }}
                                    >
                                        <div className="sticky left-0 z-20 flex shrink-0 border-r border-gray-800 bg-gray-900" style={{ width: HEADER_WIDTH }}>
                                            <div className="min-w-0 flex-1 space-y-1 p-1.5">
                                                <div className="flex items-center gap-1">
                                                    <Icon size={12} className={`${info.text} shrink-0`} />
                                                    <input
                                                        type="text"
                                                        aria-label="Track name"
                                                        value={track.label ?? ''}
                                                        placeholder={name}
                                                        onChange={(event) => { const label = event.target.value; changeTrack(track.id, current => ({ ...current, label })); }}
                                                        className="h-5 min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 text-2xs text-gray-100 placeholder-gray-400 hover:border-gray-700 focus:border-blue-500 focus:outline-none"
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={() => changeTrack(track.id, current => ({ ...current, muted: !current.muted }))}
                                                        aria-label={track.muted ? 'Unmute track' : 'Mute track'}
                                                        aria-pressed={!!track.muted}
                                                        title={track.muted ? 'Muted: playback skips this track' : 'Mute track'}
                                                        className={`rounded p-0.5 transition-colors ${track.muted ? 'text-amber-400' : 'text-gray-500 hover:text-gray-200'}`}
                                                    >
                                                        {track.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => deleteTrack(track.id)}
                                                        aria-label="Delete track"
                                                        title="Delete track"
                                                        className="rounded p-0.5 text-gray-500 hover:text-red-400 transition-colors"
                                                    >
                                                        <Trash2 size={12} />
                                                    </button>
                                                </div>
                                                {target !== null && (
                                                    <select
                                                        aria-label="Target object"
                                                        value={target}
                                                        onChange={(event) => {
                                                            const objectId = event.target.value;
                                                            changeTrack(track.id, current => (current.kind === 'transform' || current.kind === 'visibility' ? { ...current, objectId } : current));
                                                        }}
                                                        className={`w-full ${FIELD_CLASS}`}
                                                    >
                                                        {!target && <option value="">Pick an object</option>}
                                                        {target && !objectsById.has(target) && <option value={target}>Missing object</option>}
                                                        {objectOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                                                    </select>
                                                )}
                                                {track.kind === 'animation' && (
                                                    <select
                                                        aria-label="Character"
                                                        value={track.objectId}
                                                        onChange={(event) => {
                                                            const objectId = event.target.value;
                                                            changeTrack(track.id, current => (current.kind === 'animation' ? { ...current, objectId } : current));
                                                        }}
                                                        className={`w-full ${FIELD_CLASS}`}
                                                    >
                                                        <option value={TIMELINE_PLAYER_TARGET}>The player</option>
                                                        {track.objectId && track.objectId !== TIMELINE_PLAYER_TARGET && !objectsById.has(track.objectId) && <option value={track.objectId}>Missing object</option>}
                                                        {characterOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                                                    </select>
                                                )}
                                                {track.kind === 'audio' && (
                                                    <div className="flex gap-1">
                                                        <select
                                                            aria-label="Sound source"
                                                            value={track.objectId}
                                                            onChange={(event) => {
                                                                const objectId = event.target.value;
                                                                changeTrack(track.id, current => (current.kind === 'audio' ? { ...current, objectId } : current));
                                                            }}
                                                            className={`min-w-0 flex-1 ${FIELD_CLASS}`}
                                                        >
                                                            <option value="">Everywhere (2D)</option>
                                                            <option value={TIMELINE_PLAYER_TARGET}>The player</option>
                                                            {track.objectId && track.objectId !== TIMELINE_PLAYER_TARGET && !objectsById.has(track.objectId) && <option value={track.objectId}>Missing object</option>}
                                                            {objectOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                                                        </select>
                                                        <select
                                                            aria-label="Mixer bus"
                                                            value={track.bus}
                                                            onChange={(event) => {
                                                                const bus = event.target.value;
                                                                changeTrack(track.id, current => (current.kind === 'audio' ? { ...current, bus } : current));
                                                            }}
                                                            className={`w-16 ${FIELD_CLASS}`}
                                                        >
                                                            <option value="sfx">SFX</option>
                                                            <option value="music">Music</option>
                                                            <option value="ui">UI</option>
                                                            <option value="master">Master</option>
                                                        </select>
                                                    </div>
                                                )}
                                                {track.kind === 'fade' && (
                                                    <label className="flex items-center gap-1 px-1 text-2xs text-gray-400">
                                                        Colour
                                                        <input
                                                            type="color"
                                                            aria-label="Fade colour"
                                                            value={track.color}
                                                            onChange={(event) => {
                                                                const color = event.target.value;
                                                                changeTrack(track.id, current => (current.kind === 'fade' ? { ...current, color } : current));
                                                            }}
                                                            className="h-5 w-8 cursor-pointer rounded border border-gray-700 bg-transparent"
                                                        />
                                                    </label>
                                                )}
                                                {track.kind === 'subtitle' && (
                                                    <div className="px-1 text-2xs leading-snug text-gray-500">Shows each line for its length; translate them as timeline.&lt;object&gt;.&lt;track&gt;.&lt;ms&gt;.</div>
                                                )}
                                                {track.kind === 'variable' && (
                                                    <input
                                                        type="text"
                                                        aria-label="Variable name"
                                                        placeholder="Level variable name"
                                                        list={variableListId}
                                                        value={track.name}
                                                        onChange={(event) => {
                                                            const variable = event.target.value;
                                                            changeTrack(track.id, current => (current.kind === 'variable' ? { ...current, name: variable } : current));
                                                        }}
                                                        className={`w-full ${FIELD_CLASS}`}
                                                    />
                                                )}
                                                {track.kind === 'event' && (
                                                    <div className="px-1 text-2xs leading-snug text-gray-500">Raises each key's name as an event when playback passes it.</div>
                                                )}
                                                {track.kind === 'camera' && (
                                                    <label className="flex items-center gap-1 px-1 text-2xs text-gray-400">
                                                        Blend
                                                        <input
                                                            type="number"
                                                            aria-label="Camera blend seconds"
                                                            min={0}
                                                            max={30}
                                                            step={0.1}
                                                            value={track.blend ?? 0}
                                                            onChange={(event) => {
                                                                const blend = Number(event.target.value);
                                                                if (Number.isFinite(blend)) changeTrack(track.id, current => (current.kind === 'camera' ? { ...current, blend: Math.min(30, Math.max(0, blend)) } : current));
                                                            }}
                                                            className={`w-14 ${FIELD_CLASS}`}
                                                        />
                                                        s
                                                    </label>
                                                )}
                                                {track.kind === 'camera' && cameraOptions.length === 0 && (
                                                    <div className="px-1 text-2xs leading-snug text-amber-400">Add a Camera component to an object to cut to it.</div>
                                                )}
                                                {track.kind === 'transform' && (
                                                    <button
                                                        type="button"
                                                        onClick={() => recordFromObject(track.id)}
                                                        disabled={!objectsById.has(track.objectId)}
                                                        title="Key the target's current position, rotation and scale at the playhead"
                                                        className="flex h-5 w-full items-center justify-center gap-1 rounded border border-gray-700 bg-gray-800 text-2xs text-gray-300 hover:bg-gray-700 disabled:opacity-40 transition-colors"
                                                    >
                                                        <Crosshair size={10} /> Add key from object
                                                    </button>
                                                )}
                                            </div>
                                            <div className="flex w-16 shrink-0 flex-col border-l border-gray-800/60">
                                                {lanes.map(lane => (
                                                    <div key={lane.channel} className="flex flex-1 items-center justify-end border-b border-gray-800/40 px-1.5 text-2xs text-gray-500 last:border-b-0">
                                                        {lane.label}
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                        <div className="flex shrink-0 select-none flex-col" style={{ width: laneSpan }}>
                                            {lanes.map(lane => (
                                                <div
                                                    key={lane.channel}
                                                    role="group"
                                                    aria-label={`${name} ${lane.label} keys`}
                                                    className="relative flex-1 border-b border-gray-800/40 last:border-b-0"
                                                    style={{
                                                        backgroundImage: 'linear-gradient(to right, rgba(255,255,255,0.04) 1px, transparent 1px)',
                                                        backgroundSize: `${tickStep * zoom}px 100%`,
                                                        backgroundPosition: `${LANE_INSET}px 0`,
                                                    }}
                                                    onPointerDown={() => setSelected(null)}
                                                    onDoubleClick={() => addKeyAtPlayhead(track.id, lane.channel)}
                                                >
                                                    <div className="absolute inset-y-0 right-0 bg-black/40 pointer-events-none" style={{ width: LANE_TAIL }} />
                                                    {getKeys(track, lane.channel).map((key, index) => {
                                                        const ref: KeyRef = { trackId: track.id, channel: lane.channel, index };
                                                        const isSelected = selected?.trackId === track.id && selected.channel === lane.channel && selected.index === index;
                                                        const late = key.time > duration + TIME_EPSILON;
                                                        const span = spanOf(key.value);
                                                        if (span !== null && !late) {
                                                            const label = spanLabel(key.value, sounds);
                                                            return (
                                                                <button
                                                                    key={index}
                                                                    type="button"
                                                                    aria-label={`${name} ${lane.label} ${label} at ${formatTime(key.time)}`}
                                                                    aria-pressed={isSelected}
                                                                    title={`${formatTime(key.time)} · ${describeValue(key.value)}`}
                                                                    className={`absolute top-1 bottom-1 overflow-hidden rounded border px-1.5 text-left text-2xs leading-[18px] text-gray-950 cursor-ew-resize focus:outline-none ${isSelected ? 'z-10 border-amber-300 ring-2 ring-amber-400/60' : 'border-black/40 hover:brightness-110'} ${info.fill} bg-opacity-80`}
                                                                    style={{ left: xAt(key.time), width: Math.max(8, span * zoom) }}
                                                                    onPointerDown={(event) => startKeyDrag(event, ref, key.time)}
                                                                    onPointerMove={moveKeyDrag}
                                                                    onPointerUp={endKeyDrag}
                                                                    onPointerCancel={endKeyDrag}
                                                                    onClick={(event) => { if (event.detail === 0) setSelected(ref); }}
                                                                    onDoubleClick={(event) => event.stopPropagation()}
                                                                >
                                                                    <span className="block truncate font-medium">{label}</span>
                                                                </button>
                                                            );
                                                        }
                                                        return (
                                                            <button
                                                                key={index}
                                                                type="button"
                                                                aria-label={`${name} ${lane.label} key at ${formatTime(key.time)}`}
                                                                aria-pressed={isSelected}
                                                                title={`${formatTime(key.time)} · ${describeValue(key.value)}${late ? ' · past the end' : ''}`}
                                                                className={`absolute top-1/2 -ml-1.5 -mt-1.5 h-3 w-3 rotate-45 rounded-[2px] border cursor-ew-resize focus:outline-none ${isSelected ? 'z-10 bg-white border-amber-400 ring-2 ring-amber-400/60' : `${info.fill} border-black/50 hover:brightness-125`} ${late ? 'opacity-40' : ''}`}
                                                                style={{ left: late ? LANE_INSET + laneWidth + LANE_TAIL / 2 : xAt(key.time) }}
                                                                onPointerDown={(event) => startKeyDrag(event, ref, key.time)}
                                                                onPointerMove={moveKeyDrag}
                                                                onPointerUp={endKeyDrag}
                                                                onPointerCancel={endKeyDrag}
                                                                // Pointer presses select in onPointerDown; this click is keyboard activation (detail 0).
                                                                // A drag's trailing click can land on a button that now shows another key.
                                                                onClick={(event) => { if (event.detail === 0) setSelected(ref); }}
                                                                onDoubleClick={(event) => event.stopPropagation()}
                                                            />
                                                        );
                                                    })}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}

                            <div className="pointer-events-none absolute inset-y-0 z-10 w-px bg-amber-400/80" style={{ left: HEADER_WIDTH + xAt(playhead) }} />
                        </div>
                    </div>

                    <div className="w-64 shrink-0 overflow-y-auto border-l border-gray-800 bg-gray-950/40 p-3 custom-scrollbar">
                        {selection && selected ? (
                            <KeyDetails
                                track={selection.track}
                                channel={selected.channel}
                                trackName={trackName(selection.track)}
                                timelineKey={selection.key}
                                duration={duration}
                                onChange={changeSelectedKey}
                                onDelete={deleteSelectedKey}
                                cameras={cameraOptions}
                                clips={selection.track.kind === 'animation' ? clipsFor?.(selection.track.objectId) ?? [] : []}
                                sounds={sounds}
                            />
                        ) : (
                            <div className="space-y-2 text-2xs leading-snug text-gray-500">
                                <div className={SECTION_TITLE}>No key selected</div>
                                <p>Click a key to edit its time, value and interpolation.</p>
                                <p>Double-click a row to add a key at the playhead. Drag keys to move them; they snap to {SNAP_STEP} s unless Shift is held.</p>
                                <p>Transform rotations are in degrees.</p>
                            </div>
                        )}
                    </div>
                </div>

                <div className="flex items-center justify-between gap-3 border-t border-gray-800 bg-gray-950 px-5 py-3">
                    <div className="flex min-w-0 items-center gap-3 text-2xs">
                        <span className={dirty ? 'text-amber-400' : 'text-gray-500'}>{dirty ? 'Unsaved changes' : 'No changes'}</span>
                        {lateKeys > 0 && (
                            <span className="flex items-center gap-1 text-amber-300 truncate">
                                <AlertTriangle size={12} /> {lateKeys === 1 ? '1 key is' : `${lateKeys} keys are`} past the end of the timeline.
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        <button type="button" onClick={requestClose} className="rounded px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-white">Cancel</button>
                        <button type="button" onClick={save} className="rounded bg-blue-600 px-3 py-1.5 text-xs font-bold text-accent-ink hover:bg-blue-500">Save</button>
                    </div>
                </div>

                {confirmDiscard && (
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
                        <div role="alertdialog" aria-modal="true" aria-label="Discard changes" className="w-80 space-y-3 rounded-lg border border-gray-700 bg-gray-900 p-4 shadow-2xl">
                            <div className="flex items-center gap-2 text-sm font-bold text-white"><AlertTriangle size={14} className="text-amber-400" /> Discard changes?</div>
                            <p className="text-2xs text-gray-400">The edits made to this timeline have not been saved.</p>
                            <div className="flex justify-end gap-2">
                                <button type="button" autoFocus onClick={keepEditing} className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800">Keep Editing</button>
                                <button type="button" onClick={onClose} className="rounded bg-red-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-500">Discard</button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
            <datalist id={variableListId}>
                {variableNames.map(variable => <option key={variable} value={variable} />)}
            </datalist>
        </div>,
        document.body,
    );
};
