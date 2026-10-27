import React, { useContext, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { ArrowDown, ArrowUp, Music, Trash2 } from 'lucide-react';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import type { LevelComponent } from '../../types';
import type { AudioMixer } from '../audioMixer';
import { useGameContent } from '../GameContentContext';
import { findAudioAsset, useRuntimeMixer } from './audioComponents';
import { ComponentHostContext } from './builtins';
import type { ComponentDefinition, ComponentInspectorProps, ComponentRenderProps } from './types';

/**
 * Audio zones and music. A Reverb Zone sends the sfx bus through a convolution reverb while the camera
 * (the AudioListener) is inside its box or sphere, fading in over the zone's edge; where zones overlap
 * only the strongest is heard. Music streams a playlist of audio assets onto the music bus, crossfading
 * from track to track; only the first Music component mounted in a session plays. Both run only in play
 * (on the runtime's mixer) and stop with the session.
 */

type Vec3 = [number, number, number];

const readNumber = (component: LevelComponent, key: string, fallback: number, min: number, max: number): number => {
    const value = component.props[key];
    return typeof value === 'number' && Number.isFinite(value) ? THREE.MathUtils.clamp(value, min, max) : fallback;
};

const readBoolean = (component: LevelComponent, key: string, fallback: boolean): boolean => {
    const value = component.props[key];
    return typeof value === 'boolean' ? value : fallback;
};

const readOption = <T extends string>(component: LevelComponent, key: string, options: readonly T[], fallback: T): T => {
    const value = component.props[key];
    return options.includes(value as T) ? value as T : fallback;
};

const isVec3 = (value: unknown): value is Vec3 =>
    Array.isArray(value) && value.length === 3 && value.every(v => typeof v === 'number' && Number.isFinite(v));

const ignoreRaycast: THREE.Object3D['raycast'] = () => undefined;

/** Small unlit marker so an audio object is visible (and clickable) in the editor. */
const AudioMarker: React.FC<{ color: string }> = ({ color }) => (
    <mesh>
        <octahedronGeometry args={[0.14, 0]} />
        <meshBasicMaterial color={color} wireframe toneMapped={false} />
    </mesh>
);

// --- REVERB ZONE SETTINGS ---

export type ReverbZoneShape = 'box' | 'sphere';
export type ReverbPreset = 'room' | 'hall' | 'cave' | 'outdoors';

export const REVERB_ZONE_SHAPES: readonly ReverbZoneShape[] = ['box', 'sphere'];
export const REVERB_PRESETS: readonly ReverbPreset[] = ['room', 'hall', 'cave', 'outdoors'];

/** A reverb zone's settings, every field defaulted and within range. */
export interface ReverbZoneSettings {
    shape: ReverbZoneShape;
    /** Box edge lengths in the owner's local space, so they scale with it. */
    size: Vec3;
    /** Sphere radius in the owner's local space, scaled by its largest axis. */
    radius: number;
    preset: ReverbPreset;
    /** Reverb send level with the listener fully inside, 0..1. */
    wet: number;
    /** Metres inside the edge over which the wet level rises from nothing to full. */
    fade: number;
}

export const REVERB_ZONE_DEFAULTS: ReverbZoneSettings = {
    shape: 'box', size: [10, 4, 10], radius: 6, preset: 'room', wet: 0.5, fade: 2
};

/** Smallest and largest zone extent the settings take (m). */
const MIN_ZONE_EXTENT = 0.01;
const MAX_ZONE_EXTENT = 10_000;
/** Longest edge fade the settings take (m). */
const MAX_ZONE_FADE = 1000;

/** A stored reverbZone component's settings, with missing or invalid values at their defaults. */
export const readReverbZoneSettings = (component: LevelComponent): ReverbZoneSettings => {
    const size = component.props.size;
    return {
        shape: readOption(component, 'shape', REVERB_ZONE_SHAPES, REVERB_ZONE_DEFAULTS.shape),
        size: isVec3(size)
            ? size.map(v => THREE.MathUtils.clamp(v, MIN_ZONE_EXTENT, MAX_ZONE_EXTENT)) as Vec3
            : [...REVERB_ZONE_DEFAULTS.size],
        radius: readNumber(component, 'radius', REVERB_ZONE_DEFAULTS.radius, MIN_ZONE_EXTENT, MAX_ZONE_EXTENT),
        preset: readOption(component, 'preset', REVERB_PRESETS, REVERB_ZONE_DEFAULTS.preset),
        wet: readNumber(component, 'wet', REVERB_ZONE_DEFAULTS.wet, 0, 1),
        fade: readNumber(component, 'fade', REVERB_ZONE_DEFAULTS.fade, 0, MAX_ZONE_FADE)
    };
};

// --- ZONE WEIGHT ---

/** A reverb zone placed in the world: its shape around `center`, a box turned by `rotation`. Sizes and fade in metres. */
export interface ReverbZoneVolume {
    shape: ReverbZoneShape;
    center: THREE.Vector3Like;
    /** Orientation of the box's axes (a unit quaternion); unturned when left out. A sphere ignores it. */
    rotation?: THREE.QuaternionLike;
    /** Box edge lengths. */
    size: Vec3;
    radius: number;
    fade: number;
}

const _local = new THREE.Vector3();
const _inverse = new THREE.Quaternion();

/**
 * How deep `listenerPosition` is inside `zone`, 0..1: 0 outside or on the edge, rising linearly to 1 at
 * the zone's fade distance inside the edge. The fade is capped at the zone's own depth (half its
 * smallest box edge, or its radius), so the centre of a zone is always at 1; a fade of 0 is a hard edge.
 */
export const zoneWeight = (listenerPosition: THREE.Vector3Like, zone: ReverbZoneVolume): number => {
    _local.set(listenerPosition.x - zone.center.x, listenerPosition.y - zone.center.y, listenerPosition.z - zone.center.z);
    let depth: number;
    let maxDepth: number;
    if (zone.shape === 'sphere') {
        maxDepth = Math.max(0, zone.radius);
        depth = maxDepth - _local.length();
    } else {
        const { rotation } = zone;
        if (rotation) _local.applyQuaternion(_inverse.set(rotation.x, rotation.y, rotation.z, rotation.w).invert());
        const halfX = Math.max(0, zone.size[0]) / 2;
        const halfY = Math.max(0, zone.size[1]) / 2;
        const halfZ = Math.max(0, zone.size[2]) / 2;
        maxDepth = Math.min(halfX, halfY, halfZ);
        depth = Math.min(halfX - Math.abs(_local.x), halfY - Math.abs(_local.y), halfZ - Math.abs(_local.z));
    }
    if (!(depth > 0)) return 0;
    const fade = Math.min(Number.isFinite(zone.fade) ? Math.max(0, zone.fade) : 0, maxDepth);
    return fade > 0 ? Math.min(1, depth / fade) : 1;
};

// --- IMPULSE RESPONSES ---

interface ReverbCharacter {
    /** Seconds for the tail to fall by 60 dB, which is also its length. */
    decay: number;
    /** Silence before the tail (s): the time the first reflections take to come back. */
    preDelay: number;
    /** 0..1: how fast the tail loses its highs; walls and air absorb them first. */
    damping: number;
    /** Discrete reflections [seconds after the pre-delay, gain] layered on the tail: slapback off far walls or terrain. */
    echoes: readonly (readonly [number, number])[];
}

const REVERB_CHARACTERS: Record<ReverbPreset, ReverbCharacter> = {
    room: { decay: 0.7, preDelay: 0.005, damping: 0.4, echoes: [] },
    hall: { decay: 2.4, preDelay: 0.025, damping: 0.3, echoes: [] },
    cave: { decay: 3.8, preDelay: 0.04, damping: 0.55, echoes: [[0.09, 0.5], [0.21, 0.35]] },
    outdoors: { decay: 0.9, preDelay: 0.06, damping: 0.75, echoes: [[0.18, 0.4], [0.42, 0.2]] }
};

/** Seconds the right channel's echoes trail the left's, so they sound wide rather than centred. */
const ECHO_SPREAD = 0.0007;

/** Deterministic pseudo-random numbers in [-1, 1) (mulberry32), so a preset's impulse is the same every time. */
const noise = (seed: number) => {
    let state = seed | 0;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
    };
};

/**
 * The left and right channels of `preset`'s impulse response at `sampleRate`: silence for the
 * pre-delay, then noise (decorrelated between the channels) falling by 60 dB over the decay time and
 * darkening as it goes, plus the preset's discrete echoes. The same preset and rate give the same samples.
 */
export const generateImpulseResponse = (preset: ReverbPreset, sampleRate: number): [Float32Array, Float32Array] => {
    const { decay, preDelay, damping, echoes } = REVERB_CHARACTERS[preset];
    const rate = Math.max(1, Math.round(sampleRate));
    const offset = Math.round(preDelay * rate);
    const tail = Math.max(1, Math.round(decay * rate));
    const channels: [Float32Array, Float32Array] = [new Float32Array(offset + tail), new Float32Array(offset + tail)];
    const falloff = Math.pow(10, -3 / tail);
    channels.forEach((data, channel) => {
        const random = noise((REVERB_PRESETS.indexOf(preset) + 1) * 2 + channel);
        let envelope = 1;
        let filtered = 0;
        for (let i = 0; i < tail; i++) {
            // One-pole low-pass that closes over the tail.
            filtered += (1 - damping * (i / tail)) * (random() - filtered);
            data[offset + i] = filtered * envelope;
            envelope *= falloff;
        }
        for (const [time, gain] of echoes) {
            const at = Math.round((time + channel * ECHO_SPREAD) * rate);
            if (at < tail) data[offset + at] += gain * Math.pow(falloff, at);
        }
    });
    return channels;
};

const impulseCache = new WeakMap<BaseAudioContext, Map<ReverbPreset, AudioBuffer>>();

/** `preset`'s impulse response as an AudioBuffer on `context`, generated on first use and shared after that. */
export const getImpulseResponse = (context: BaseAudioContext, preset: ReverbPreset): AudioBuffer => {
    let buffers = impulseCache.get(context);
    if (!buffers) {
        buffers = new Map();
        impulseCache.set(context, buffers);
    }
    const cached = buffers.get(preset);
    if (cached) return cached;
    const channels = generateImpulseResponse(preset, context.sampleRate);
    const buffer = context.createBuffer(channels.length, channels[0].length, context.sampleRate);
    channels.forEach((data, channel) => buffer.copyToChannel(data, channel));
    buffers.set(preset, buffer);
    return buffer;
};

// --- REVERB SENDS ---

/** Time constant (s) the wet level follows a zone with, so walking through an edge or a zone switch never clicks. */
const REVERB_SMOOTHING = 0.08;
/** Smallest wet level change worth scheduling. */
const REVERB_LEVEL_EPSILON = 0.001;

/** One preset's return: the sfx bus convolved with the preset's impulse, into the master bus at a level the zones set. */
interface ReverbReturn {
    convolver: ConvolverNode;
    gain: GainNode;
    /** The level last scheduled on `gain`. */
    level: number;
}

/** What a mounted zone asks for: its preset, and the level (depth x wet) it measured on its last frame. */
interface ReverbZoneClaim {
    preset: ReverbPreset;
    level: number;
}

/**
 * The reverb sends one mixer's zones share: a convolver for each preset a zone uses, fed from the sfx
 * bus output (after its fader, so the sfx volume turns the reverb down too) and returned into the master
 * bus. Only the strongest zone is heard: its preset's return plays at its level, every other at silence.
 * The AudioMixer has no send API, so the returns connect to mixer.input('sfx') and mixer.input('master').
 */
class ReverbSends {
    private readonly zones = new Set<ReverbZoneClaim>();
    private readonly returns = new Map<ReverbPreset, ReverbReturn>();

    constructor(private readonly mixer: AudioMixer) {}

    get empty(): boolean { return this.zones.size === 0; }

    add(zone: ReverbZoneClaim): void {
        this.zones.add(zone);
        try {
            this.sync();
        } catch (error) {
            this.zones.delete(zone);
            throw error;
        }
    }

    remove(zone: ReverbZoneClaim): void {
        this.zones.delete(zone);
        this.sync();
    }

    /** Opens returns for the presets zones use now, closes the rest, and levels them. */
    sync(): void {
        const used = new Set([...this.zones].map(zone => zone.preset));
        for (const [preset, open] of this.returns) {
            if (used.has(preset)) continue;
            this.close(open);
            this.returns.delete(preset);
        }
        for (const preset of used) {
            if (!this.returns.has(preset)) this.returns.set(preset, this.open(preset));
        }
        this.apply();
    }

    /** Levels every return for the strongest zone; the first mounted wins a tie. */
    apply(): void {
        let strongest: ReverbZoneClaim | null = null;
        for (const zone of this.zones) {
            if (!strongest || zone.level > strongest.level) strongest = zone;
        }
        const now = this.mixer.input('sfx').context.currentTime;
        for (const [preset, open] of this.returns) {
            const level = strongest && strongest.preset === preset ? strongest.level : 0;
            if (level === open.level || (level !== 0 && Math.abs(level - open.level) < REVERB_LEVEL_EPSILON)) continue;
            open.level = level;
            open.gain.gain.setTargetAtTime(level, now, REVERB_SMOOTHING);
        }
    }

    private open(preset: ReverbPreset): ReverbReturn {
        const sfx = this.mixer.input('sfx');
        const context = sfx.context;
        const convolver = context.createConvolver();
        convolver.buffer = getImpulseResponse(context, preset);
        const gain = context.createGain();
        gain.gain.value = 0;
        sfx.connect(convolver);
        convolver.connect(gain);
        gain.connect(this.mixer.input('master'));
        return { convolver, gain, level: 0 };
    }

    private close(open: ReverbReturn): void {
        try {
            this.mixer.input('sfx').disconnect(open.convolver);
        } catch {
            // The mixer was disposed first (the runtime ended), which already cut every bus output.
        }
        open.convolver.disconnect();
        open.gain.disconnect();
    }
}

const reverbSends = new WeakMap<AudioMixer, ReverbSends>();

interface ReverbMembership {
    /** Reports the zone's preset and level for this frame. */
    set(preset: ReverbPreset, level: number): void;
    leave(): void;
}

/** Adds a zone to `mixer`'s reverb sends, creating them for the first zone; the last zone to leave closes them. */
const joinReverbSends = (mixer: AudioMixer, preset: ReverbPreset): ReverbMembership => {
    const sends = reverbSends.get(mixer) ?? new ReverbSends(mixer);
    const claim: ReverbZoneClaim = { preset, level: 0 };
    sends.add(claim);
    reverbSends.set(mixer, sends);
    let joined = true;
    return {
        set(nextPreset, level) {
            if (!joined) return;
            claim.level = level;
            if (claim.preset === nextPreset) {
                sends.apply();
                return;
            }
            claim.preset = nextPreset;
            try {
                sends.sync();
            } catch (error) {
                // The zone stays silent rather than stopping the frame loop.
                frontendDiagnostics.failure('runtime_reverb_zone_failed', error);
            }
        },
        leave() {
            if (!joined) return;
            joined = false;
            sends.remove(claim);
            if (sends.empty && reverbSends.get(mixer) === sends) reverbSends.delete(mixer);
        }
    };
};

// --- REVERB ZONE COMPONENT ---

const REVERB_ZONE_COLOR = '#22d3ee';

const _center = new THREE.Vector3();
const _rotation = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _listener = new THREE.Vector3();

/** The zone in world space from its host's world transform: sizes scale with the object, the fade stays in metres. */
const placeZone = (host: THREE.Object3D, settings: ReverbZoneSettings): ReverbZoneVolume => {
    host.updateWorldMatrix(true, false);
    host.matrixWorld.decompose(_center, _rotation, _scale);
    const sx = Math.abs(_scale.x);
    const sy = Math.abs(_scale.y);
    const sz = Math.abs(_scale.z);
    return {
        shape: settings.shape,
        center: _center,
        rotation: _rotation,
        size: [settings.size[0] * sx, settings.size[1] * sy, settings.size[2] * sz],
        radius: settings.radius * Math.max(sx, sy, sz),
        fade: settings.fade
    };
};

/** Feeds the zone's level, from the camera's depth inside it, to the mixer's reverb sends every frame. */
const ReverbZonePlayback: React.FC<ComponentRenderProps> = ({ component }) => {
    const host = useContext(ComponentHostContext);
    const mixer = useRuntimeMixer();
    const settings = readReverbZoneSettings(component);
    const presetRef = useRef(settings.preset);
    presetRef.current = settings.preset;
    const membership = useRef<ReverbMembership | null>(null);

    useEffect(() => {
        if (!mixer) return undefined;
        let joined: ReverbMembership;
        try {
            joined = joinReverbSends(mixer, presetRef.current);
        } catch (error) {
            frontendDiagnostics.failure('runtime_reverb_zone_failed', error);
            return undefined;
        }
        membership.current = joined;
        return () => {
            if (membership.current === joined) membership.current = null;
            joined.leave();
        };
    }, [mixer]);

    useFrame(({ camera }) => {
        const joined = membership.current;
        if (!joined) return;
        const node = host?.current;
        const weight = node ? zoneWeight(camera.getWorldPosition(_listener), placeZone(node, settings)) : 0;
        joined.set(settings.preset, weight * settings.wet);
    });

    return null;
};

/** The zone's volume as a faint wireframe that clicks pass through, and a marker at its centre. */
const ReverbZonePreview: React.FC<{ settings: ReverbZoneSettings }> = ({ settings }) => (
    <>
        <mesh key={settings.shape} raycast={ignoreRaycast}>
            {settings.shape === 'sphere'
                ? <sphereGeometry args={[settings.radius, 24, 16]} />
                : <boxGeometry args={settings.size} />}
            <meshBasicMaterial color={REVERB_ZONE_COLOR} wireframe transparent opacity={0.35} depthWrite={false} toneMapped={false} />
        </mesh>
        <AudioMarker color={REVERB_ZONE_COLOR} />
    </>
);

const ReverbZoneRender: React.FC<ComponentRenderProps> = (props) => (
    props.mode === 'runtime'
        ? <ReverbZonePlayback {...props} />
        : <ReverbZonePreview settings={readReverbZoneSettings(props.component)} />
);

// --- MUSIC SETTINGS ---

/** A Music component's settings, every field defaulted and within range. */
export interface MusicPlayerSettings {
    /** Audio asset ids (or names) in play order; a reference no asset matches is skipped. */
    tracks: string[];
    shuffle: boolean;
    loop: boolean;
    /** Seconds each track fades into the next; 0 cuts from one to the next. */
    crossfade: number;
    volume: number;
    playOnStart: boolean;
}

export const MUSIC_PLAYER_DEFAULTS = { shuffle: false, loop: true, crossfade: 2, volume: 1, playOnStart: true };

/** Longest crossfade the settings take (s). */
const MAX_CROSSFADE = 30;

/** A stored track list: its non-empty string entries, trimmed, in order (a track may repeat). */
export const readTracks = (value: unknown): string[] => (
    Array.isArray(value)
        ? value.filter((track): track is string => typeof track === 'string').map(track => track.trim()).filter(track => track.length > 0)
        : []
);

/** A stored musicPlayer component's settings, with missing or invalid values at their defaults. */
export const readMusicPlayerSettings = (component: LevelComponent): MusicPlayerSettings => ({
    tracks: readTracks(component.props.tracks),
    shuffle: readBoolean(component, 'shuffle', MUSIC_PLAYER_DEFAULTS.shuffle),
    loop: readBoolean(component, 'loop', MUSIC_PLAYER_DEFAULTS.loop),
    crossfade: readNumber(component, 'crossfade', MUSIC_PLAYER_DEFAULTS.crossfade, 0, MAX_CROSSFADE),
    volume: readNumber(component, 'volume', MUSIC_PLAYER_DEFAULTS.volume, 0, 2),
    playOnStart: readBoolean(component, 'playOnStart', MUSIC_PLAYER_DEFAULTS.playOnStart)
});

// --- PLAYLIST ORDER ---

/** Where a playlist is: the track playing and, when shuffled, the rest of the current pass. */
export interface MusicQueueState {
    /** Index into the track list of the track playing; -1 before the first. */
    current: number;
    /** Shuffle only: the indices this pass still has to play, next first. */
    upcoming: readonly number[];
}

export const INITIAL_MUSIC_QUEUE: MusicQueueState = { current: -1, upcoming: [] };

export interface MusicQueueOptions {
    /** Tracks in the playlist. */
    count: number;
    shuffle: boolean;
    loop: boolean;
    /** Random numbers in [0, 1) for the shuffle; Math.random when left out. */
    random?: () => number;
}

const randomIndex = (random: () => number, length: number) => Math.min(length - 1, Math.floor(random() * length));

/**
 * The playlist's state once it moves on from `state`, or null when it has nothing left to play: it is
 * empty, or it does not loop and has played its last track. In order it steps through the tracks, back
 * to the first when it loops. Shuffled it plays every track once per pass in a random order, and a new
 * pass never opens with the track the last one ended on, so no track plays twice in a row unless it is
 * the only one.
 */
export const nextTrack = (state: MusicQueueState, options: MusicQueueOptions): MusicQueueState | null => {
    const count = Number.isFinite(options.count) ? Math.max(0, Math.floor(options.count)) : 0;
    if (count === 0) return null;
    if (!options.shuffle) {
        const next = Math.max(0, state.current + 1);
        if (next < count) return { current: next, upcoming: [] };
        return options.loop ? { current: 0, upcoming: [] } : null;
    }
    let upcoming = state.upcoming.filter(index => Number.isInteger(index) && index >= 0 && index < count);
    if (upcoming.length === 0) {
        if (state.current >= 0 && !options.loop) return null;
        const random = options.random ?? Math.random;
        upcoming = Array.from({ length: count }, (_, index) => index);
        for (let i = count - 1; i > 0; i--) {
            const j = randomIndex(random, i + 1);
            [upcoming[i], upcoming[j]] = [upcoming[j], upcoming[i]];
        }
        if (count > 1 && upcoming[0] === state.current) {
            const swap = 1 + randomIndex(random, count - 1);
            [upcoming[0], upcoming[swap]] = [upcoming[swap], upcoming[0]];
        }
    }
    const [current, ...rest] = upcoming;
    return { current, upcoming: rest };
};

// --- MUSIC DECK ---

/** Time constant (s) the Music volume follows the setting with. */
const MUSIC_VOLUME_SMOOTHING = 0.05;

/** One track playing: its element streamed into the graph through its own fade gain. */
interface MusicVoice {
    element: HTMLAudioElement;
    source: MediaElementAudioSourceNode;
    gain: GainNode;
    /** True once the deck moved on from it: its crossfade started, or the playlist ends with it. */
    handedOff: boolean;
    /** Audio-clock time its fade-out ends; null while it is the current track. */
    fadeEnd: number | null;
    /** Removes the deck's element listeners. */
    detach: () => void;
}

interface MusicSource {
    settings(): MusicPlayerSettings;
    /** The URL of a track reference, or undefined when no audio asset matches it. */
    resolve(track: string): string | undefined;
}

const canStreamMedia = (context: BaseAudioContext): context is AudioContext =>
    typeof (context as Partial<AudioContext>).createMediaElementSource === 'function';

/**
 * Streams one Music component's playlist into its destination: each track an HTMLAudioElement through
 * a MediaElementAudioSourceNode and its own gain, so two tracks overlap while one fades into the next.
 * Fades run on the audio clock, and elements pause while the context is suspended (the game is paused),
 * so a pause freezes the music where it is. dispose() stops and releases everything at once.
 */
class MusicDeck {
    private readonly output: GainNode;
    private current: MusicVoice | null = null;
    private fading: MusicVoice[] = [];
    private queue: MusicQueueState = INITIAL_MUSIC_QUEUE;
    private playing = false;
    private suspended: boolean;
    /** Tracks that failed to load in a row; once every track has, playback stops instead of cycling. */
    private failures = 0;
    private readonly reportedMissing = new Set<string>();
    private readonly onStateChange = () => this.followContextState();

    constructor(private readonly context: AudioContext, destination: AudioNode, private readonly source: MusicSource) {
        this.output = context.createGain();
        this.output.gain.value = source.settings().volume;
        this.output.connect(destination);
        this.suspended = context.state !== 'running';
        context.addEventListener('statechange', this.onStateChange);
    }

    get isPlaying(): boolean { return this.playing; }

    /** Starts the playlist, or carries on from the last track after stop(); a playlist that ended starts over. */
    play(): void {
        if (this.playing) return;
        this.playing = true;
        this.failures = 0;
        if (this.advance(0)) return;
        this.queue = INITIAL_MUSIC_QUEUE;
        if (!this.advance(0)) this.playing = false;
    }

    /** Fades the current track out over the crossfade time. */
    stop(): void {
        if (!this.playing) return;
        this.playing = false;
        const voice = this.current;
        this.current = null;
        if (voice) this.fadeOut(voice, this.source.settings().crossfade);
    }

    /** Crossfades to the playlist's next track now; starts playback when stopped. */
    next(): void {
        if (!this.playing) this.play();
        else this.advance(this.source.settings().crossfade);
    }

    setVolume(volume: number): void {
        this.output.gain.setTargetAtTime(volume, this.context.currentTime, MUSIC_VOLUME_SMOOTHING);
    }

    /** Per frame: starts the crossfade as the current track nears its end, and releases tracks that faded out. */
    update(): void {
        const now = this.context.currentTime;
        this.fading = this.fading.filter(voice => {
            if (voice.fadeEnd !== null && now < voice.fadeEnd) return true;
            this.release(voice);
            return false;
        });
        const voice = this.current;
        if (!voice || voice.handedOff || !this.playing || this.suspended) return;
        const { duration, currentTime } = voice.element;
        if (!Number.isFinite(duration) || duration <= 0) return;
        // A track shorter than two crossfades fades for half its length.
        const fade = Math.min(this.source.settings().crossfade, duration / 2);
        if (fade <= 0 || duration - currentTime > fade) return;
        voice.handedOff = true;
        this.advance(fade);
    }

    dispose(): void {
        this.context.removeEventListener('statechange', this.onStateChange);
        this.playing = false;
        if (this.current) this.release(this.current);
        this.current = null;
        this.fading.forEach(voice => this.release(voice));
        this.fading = [];
        this.output.disconnect();
    }

    /**
     * Starts the playlist's next playable track, fading it in over `fade` seconds while the current one
     * fades out. False when the playlist has nothing left; the current track then plays on to its end.
     */
    private advance(fade: number): boolean {
        const { tracks, shuffle, loop } = this.source.settings();
        let state = this.queue;
        for (let attempt = 0; attempt < tracks.length; attempt++) {
            const next = nextTrack(state, { count: tracks.length, shuffle, loop });
            if (!next) break;
            state = next;
            const track = tracks[next.current];
            const url = this.source.resolve(track);
            if (!url) {
                this.reportMissing(track);
                continue;
            }
            this.queue = state;
            const previous = this.current;
            this.current = this.startVoice(url, fade);
            if (previous) this.fadeOut(previous, fade);
            return true;
        }
        this.queue = state;
        if (this.current) this.current.handedOff = true;
        return false;
    }

    private startVoice(url: string, fade: number): MusicVoice {
        const element = document.createElement('audio');
        element.preload = 'auto';
        element.src = url;
        const source = this.context.createMediaElementSource(element);
        const gain = this.context.createGain();
        const now = this.context.currentTime;
        if (fade > 0) {
            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(1, now + fade);
        } else {
            gain.gain.setValueAtTime(1, now);
        }
        source.connect(gain);
        gain.connect(this.output);
        const voice: MusicVoice = { element, source, gain, handedOff: false, fadeEnd: null, detach: () => undefined };
        const onEnded = () => this.handleEnded(voice);
        const onError = () => this.handleError(voice);
        const onPlaying = () => { this.failures = 0; };
        element.addEventListener('ended', onEnded);
        element.addEventListener('error', onError);
        element.addEventListener('playing', onPlaying);
        voice.detach = () => {
            element.removeEventListener('ended', onEnded);
            element.removeEventListener('error', onError);
            element.removeEventListener('playing', onPlaying);
        };
        if (!this.suspended) this.playElement(element);
        return voice;
    }

    private fadeOut(voice: MusicVoice, fade: number): void {
        voice.handedOff = true;
        if (fade <= 0) {
            this.release(voice);
            return;
        }
        const now = this.context.currentTime;
        const level = voice.gain.gain;
        level.cancelScheduledValues(now);
        level.setValueAtTime(level.value, now);
        level.linearRampToValueAtTime(0, now + fade);
        voice.fadeEnd = now + fade;
        this.fading.push(voice);
    }

    private handleEnded(voice: MusicVoice): void {
        if (voice === this.current) {
            this.current = null;
            // Reached the end without a crossfade (a cut, or frames were not running): the next track starts now.
            if (this.playing && !voice.handedOff) this.advance(0);
            this.release(voice);
            if (!this.current) this.playing = false;
            return;
        }
        const index = this.fading.indexOf(voice);
        if (index < 0) return;
        this.fading.splice(index, 1);
        this.release(voice);
    }

    private handleError(voice: MusicVoice): void {
        frontendDiagnostics.failure('runtime_music_track_failed', voice.element.error);
        this.failures++;
        if (this.failures >= this.source.settings().tracks.length) voice.handedOff = true;
        this.handleEnded(voice);
    }

    private playElement(element: HTMLAudioElement): void {
        let started: Promise<void> | undefined;
        try {
            started = element.play();
        } catch (error) {
            frontendDiagnostics.failure('runtime_music_play_failed', error);
            return;
        }
        started?.catch(error => {
            // pause() before playback began (a quick skip, the session ending) rejects with AbortError.
            if (error instanceof DOMException && error.name === 'AbortError') return;
            frontendDiagnostics.failure('runtime_music_play_failed', error);
        });
    }

    private followContextState(): void {
        const suspended = this.context.state !== 'running';
        if (suspended === this.suspended) return;
        this.suspended = suspended;
        const voices = this.current ? [this.current, ...this.fading] : this.fading;
        for (const voice of voices) {
            if (suspended) voice.element.pause();
            else this.playElement(voice.element);
        }
    }

    private reportMissing(track: string): void {
        if (this.reportedMissing.has(track)) return;
        this.reportedMissing.add(track);
        frontendDiagnostics.warning('runtime_music_track_missing');
    }

    private release(voice: MusicVoice): void {
        voice.detach();
        voice.element.pause();
        // Dropping the source and reloading frees the stream and whatever it buffered.
        voice.element.removeAttribute('src');
        voice.element.load();
        voice.source.disconnect();
        voice.gain.disconnect();
    }
}

// --- MUSIC SLOT ---

/** A Music component in line for the one music slot. */
interface MusicClaim {
    /** When the component first rendered; earlier claims come first. */
    order: number;
    setActive: (active: boolean) => void;
}

/** Mounted Music components by first render, so the earliest holds the slot (and StrictMode's effect re-run keeps it). */
const musicClaims: MusicClaim[] = [];
let musicClaimOrder = 0;
let activeDeck: MusicDeck | null = null;

const settleMusicClaims = () => musicClaims.forEach((claim, index) => claim.setActive(index === 0));

/** Puts a Music component in line for the music slot; the first in line is active. Returns the release. */
const claimMusic = (claim: MusicClaim): (() => void) => {
    const at = musicClaims.findIndex(other => other.order > claim.order);
    musicClaims.splice(at < 0 ? musicClaims.length : at, 0, claim);
    settleMusicClaims();
    return () => {
        const index = musicClaims.indexOf(claim);
        if (index < 0) return;
        musicClaims.splice(index, 1);
        claim.setActive(false);
        settleMusicClaims();
    };
};

/**
 * Controls for the session's music, the Music component that holds the music slot (the first mounted).
 * play starts its playlist (when Play on Start is off, or after stop), stop fades the track out, next
 * crossfades to the following track. Each returns false when no Music component is playing in a session.
 */
export const musicPlayback = {
    play(): boolean {
        activeDeck?.play();
        return activeDeck !== null;
    },
    stop(): boolean {
        activeDeck?.stop();
        return activeDeck !== null;
    },
    next(): boolean {
        activeDeck?.next();
        return activeDeck !== null;
    },
    /** True while the session's music is playing a playlist. */
    isPlaying(): boolean {
        return activeDeck?.isPlaying ?? false;
    }
};

// --- MUSIC COMPONENT ---

const MUSIC_COLOR = '#f472b6';

/** Plays the playlist on the runtime mixer's music bus while this component holds the music slot. */
const MusicPlayback: React.FC<ComponentRenderProps> = ({ component }) => {
    const mixer = useRuntimeMixer();
    const { audioAssets } = useGameContent();
    const settings = readMusicPlayerSettings(component);
    const latest = useRef({ settings, audioAssets });
    latest.current = { settings, audioAssets };
    const [order] = useState(() => ++musicClaimOrder);
    const [active, setActive] = useState(false);
    const deckRef = useRef<MusicDeck | null>(null);

    useEffect(() => claimMusic({ order, setActive }), [order]);

    useEffect(() => {
        if (!active || !mixer) return undefined;
        const bus = mixer.input('music');
        const context = bus.context;
        if (!canStreamMedia(context)) {
            frontendDiagnostics.warning('runtime_music_unavailable');
            return undefined;
        }
        let created: MusicDeck | null = null;
        try {
            created = new MusicDeck(context, bus, {
                settings: () => latest.current.settings,
                resolve: track => findAudioAsset(latest.current.audioAssets, track)?.url
            });
            if (latest.current.settings.playOnStart) created.play();
        } catch (error) {
            created?.dispose();
            frontendDiagnostics.failure('runtime_music_failed', error);
            return undefined;
        }
        const deck = created;
        deckRef.current = deck;
        activeDeck = deck;
        return () => {
            if (activeDeck === deck) activeDeck = null;
            if (deckRef.current === deck) deckRef.current = null;
            deck.dispose();
        };
    }, [active, mixer]);

    useEffect(() => {
        deckRef.current?.setVolume(settings.volume);
    }, [settings.volume]);

    useFrame(() => {
        deckRef.current?.update();
    });

    return null;
};

const MusicRender: React.FC<ComponentRenderProps> = (props) => (
    props.mode === 'runtime' ? <MusicPlayback {...props} /> : <AudioMarker color={MUSIC_COLOR} />
);

const ICON_BUTTON = 'p-0.5 text-gray-500 hover:text-gray-200 disabled:opacity-30 disabled:hover:text-gray-500 transition-colors';

/**
 * Inspector section of the Music component: the playlist (props.tracks) as an ordered list of the
 * project's audio assets, each movable up or down or removable, and a picker that appends a track. A
 * track whose asset is gone shows its stored reference so it can be removed.
 */
const MusicTracksInspector: React.FC<ComponentInspectorProps> = ({ component, onChangeProps }) => {
    const { audioAssets } = useGameContent();
    const tracks = readTracks(component.props.tracks);
    const setTracks = (next: string[]) => onChangeProps({ tracks: next });
    const move = (index: number, offset: number) => {
        const next = [...tracks];
        const [track] = next.splice(index, 1);
        next.splice(index + offset, 0, track);
        setTracks(next);
    };

    return (
        <div className="space-y-2 rounded border border-gray-700/60 bg-gray-950/40 p-2">
            <div className="flex items-center justify-between text-[10px]">
                <span className="text-gray-400 flex items-center gap-1"><Music size={10} /> Playlist</span>
                <span className="text-gray-200">{tracks.length} {tracks.length === 1 ? 'track' : 'tracks'}</span>
            </div>
            {tracks.length === 0 ? (
                <div className="text-[10px] text-gray-500 italic">No tracks. Add audio assets below; they play in this order.</div>
            ) : (
                <ol className="space-y-1">
                    {tracks.map((track, index) => {
                        const asset = findAudioAsset(audioAssets, track);
                        const name = asset?.name ?? track;
                        return (
                            <li key={`${index}:${track}`} className="flex items-center gap-1 rounded bg-gray-900/60 px-1.5 py-1 text-[11px]">
                                <span className="w-4 shrink-0 text-right font-mono text-[10px] text-gray-500">{index + 1}</span>
                                <span className={`flex-1 truncate ${asset ? 'text-gray-200' : 'text-amber-400'}`} title={asset ? asset.name : `No audio asset "${track}"`}>
                                    {asset ? asset.name : `Missing: ${track}`}
                                </span>
                                <button type="button" onClick={() => move(index, -1)} disabled={index === 0} className={ICON_BUTTON} title="Move up" aria-label={`Move ${name} up`}>
                                    <ArrowUp size={11} />
                                </button>
                                <button type="button" onClick={() => move(index, 1)} disabled={index === tracks.length - 1} className={ICON_BUTTON} title="Move down" aria-label={`Move ${name} down`}>
                                    <ArrowDown size={11} />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setTracks(tracks.filter((_, i) => i !== index))}
                                    className="p-0.5 text-gray-500 hover:text-red-400 transition-colors"
                                    title="Remove track"
                                    aria-label={`Remove ${name}`}
                                >
                                    <Trash2 size={11} />
                                </button>
                            </li>
                        );
                    })}
                </ol>
            )}
            <select
                value=""
                onChange={(e) => { if (e.target.value) setTracks([...tracks, e.target.value]); }}
                disabled={audioAssets.length === 0}
                className="w-full bg-gray-950 border border-gray-800 rounded px-1 h-7 text-[11px] text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
                aria-label="Add track"
            >
                <option value="">{audioAssets.length > 0 ? 'Add track...' : 'No audio assets in the project'}</option>
                {audioAssets.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
            </select>
        </div>
    );
};

// --- DEFINITIONS ---

export const AUDIO_ZONE_COMPONENTS: ComponentDefinition[] = [
    {
        type: 'reverbZone',
        label: 'Reverb Zone',
        description: 'Adds reverb to sound effects (the SFX bus) while the camera is inside a box or sphere around the object, fading in over the edge. Where zones overlap, the strongest is heard.',
        props: [
            {
                key: 'shape', label: 'Shape', type: 'select', default: REVERB_ZONE_DEFAULTS.shape,
                options: [{ label: 'Box', value: 'box' }, { label: 'Sphere', value: 'sphere' }]
            },
            { key: 'size', label: 'Size (box)', type: 'vector3', default: REVERB_ZONE_DEFAULTS.size, min: MIN_ZONE_EXTENT, max: MAX_ZONE_EXTENT, step: 0.1 },
            { key: 'radius', label: 'Radius (sphere)', type: 'number', default: REVERB_ZONE_DEFAULTS.radius, min: MIN_ZONE_EXTENT, max: MAX_ZONE_EXTENT, step: 0.1 },
            {
                key: 'preset', label: 'Preset', type: 'select', default: REVERB_ZONE_DEFAULTS.preset,
                options: [
                    { label: 'Room', value: 'room' }, { label: 'Hall', value: 'hall' },
                    { label: 'Cave', value: 'cave' }, { label: 'Outdoors', value: 'outdoors' }
                ]
            },
            { key: 'wet', label: 'Wet Level', type: 'number', default: REVERB_ZONE_DEFAULTS.wet, min: 0, max: 1, step: 0.05 },
            { key: 'fade', label: 'Edge Fade (m)', type: 'number', default: REVERB_ZONE_DEFAULTS.fade, min: 0, max: MAX_ZONE_FADE, step: 0.1 }
        ],
        Render: ReverbZoneRender
    },
    {
        type: 'musicPlayer',
        label: 'Music',
        description: 'Plays a playlist of audio assets on the music bus during play, crossfading from track to track. Only the first Music component in a session plays.',
        props: [
            { key: 'shuffle', label: 'Shuffle', type: 'boolean', default: MUSIC_PLAYER_DEFAULTS.shuffle },
            { key: 'loop', label: 'Loop Playlist', type: 'boolean', default: MUSIC_PLAYER_DEFAULTS.loop },
            { key: 'crossfade', label: 'Crossfade (s)', type: 'number', default: MUSIC_PLAYER_DEFAULTS.crossfade, min: 0, max: MAX_CROSSFADE, step: 0.1 },
            { key: 'volume', label: 'Volume', type: 'number', default: MUSIC_PLAYER_DEFAULTS.volume, min: 0, max: 2, step: 0.05 },
            { key: 'playOnStart', label: 'Play on Start', type: 'boolean', default: MUSIC_PLAYER_DEFAULTS.playOnStart }
        ],
        Render: MusicRender,
        Inspector: MusicTracksInspector
    }
];
