import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import type { AudioConfig, AudioData, LevelComponent } from '../../types';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { AUDIO_BUSES, type AudioBus, type AudioMixer } from '../audioMixer';
import { useGameContent } from '../GameContentContext';
import { useRuntimeServices } from '../RuntimeServicesContext';
import type { ComponentDefinition, ComponentRenderProps } from './types';
import { useAudioOcclusion } from '../audioOcclusion';
import { SpatialAudioListener, SpatialPositionalAudio } from '../spatialAudio';

// --- SHARED AUDIO PLUMBING (level emitters, weapon sounds and the audioSource component) ---

/** A plain (2D) THREE.Audio or a PositionalAudio; both end in the same `gain` output node. */
export type Sound = THREE.Audio<AudioNode>;

export const isAudioBus = (value: unknown): value is AudioBus =>
    typeof value === 'string' && (AUDIO_BUSES as string[]).includes(value);

/** A level emitter's bus: its own `bus` when set, else 'music' for a global (2D) loop and 'sfx' for everything else. */
export const resolveEmitterBus = (config: Pick<AudioConfig, 'loop' | 'isSpatial'> & { bus?: unknown }): AudioBus =>
    isAudioBus(config.bus) ? config.bus : (config.loop && !config.isSpatial ? 'music' : 'sfx');

/**
 * The runtime's audio mixer, or null when sounds go straight to the listener (the editor preview and the
 * sandbox have no runtime services, and play has none until the mixer mounts).
 */
export const useRuntimeMixer = (): AudioMixer | null => useRuntimeServices().mixer;

const soundRoutes = new WeakMap<Sound, AudioNode>();

/**
 * Connects a sound's final output (its gain node, after any panner) to `bus` on the mixer, or to its
 * listener when there is no mixer or the mixer runs on another AudioContext. Re-wires only on change.
 */
export const routeSoundToBus = (sound: Sound, mixer: AudioMixer | null, bus: AudioBus): void => {
    const busInput = mixer?.input(bus);
    const listenerInput = sound.listener.getInput();
    const destination = busInput && busInput.context === sound.context ? busInput : listenerInput;
    // THREE wires every new sound to its listener, so that is the starting route.
    if ((soundRoutes.get(sound) ?? listenerInput) !== destination) {
        sound.gain.disconnect();
        sound.gain.connect(destination);
    }
    soundRoutes.set(sound, destination);
};

/** Stops a sound and detaches it from the audio graph, so a discarded source leaves no node on a bus. */
export const releaseSound = (sound: Sound): void => {
    if (sound.isPlaying) sound.stop();
    sound.gain.disconnect();
    soundRoutes.delete(sound);
};

interface ListenerLease {
    listener: THREE.AudioListener;
    holders: number;
}

const listenerLeases = new WeakMap<THREE.Object3D, ListenerLease>();

/**
 * The camera's AudioListener, shared by every source that hears through it. The first holder adds one
 * when the camera has none and the last release removes it; a listener someone else put on the camera
 * is used as-is and left alone.
 */
export const acquireAudioListener = (camera: THREE.Object3D): { listener: THREE.AudioListener; release: () => void } => {
    let lease = listenerLeases.get(camera);
    if (lease && lease.listener.parent !== camera) {
        listenerLeases.delete(camera);
        lease = undefined;
    }
    if (!lease) {
        const existing = camera.children.find(child => child.type === 'AudioListener');
        if (existing) return { listener: existing as THREE.AudioListener, release: () => undefined };
        const listener = new SpatialAudioListener();
        camera.add(listener);
        lease = { listener, holders: 0 };
        listenerLeases.set(camera, lease);
    }
    const held = lease;
    held.holders++;
    let released = false;
    return {
        listener: held.listener,
        release: () => {
            if (released) return;
            released = true;
            held.holders--;
            if (held.holders > 0) return;
            if (listenerLeases.get(camera) === held) listenerLeases.delete(camera);
            camera.remove(held.listener);
        }
    };
};

/** An audio asset by id, or by name so a hand-typed reference in a string field still resolves. */
export const findAudioAsset = (assets: AudioData[], reference: string): AudioData | undefined =>
    reference ? assets.find(asset => asset.id === reference) ?? assets.find(asset => asset.name === reference) : undefined;

// --- AUDIO SOURCE COMPONENT ---

export const AUDIO_SOURCE_DEFAULTS = {
    audioId: '', volume: 1, loop: true, spatial: true, autoplay: true, bus: 'sfx' as AudioBus, refDistance: 1
};

const readNumber = (component: LevelComponent, key: string, fallback: number): number => {
    const value = component.props[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const readBoolean = (component: LevelComponent, key: string, fallback: boolean): boolean => {
    const value = component.props[key];
    return typeof value === 'boolean' ? value : fallback;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A stored audioSource component's settings, with missing or invalid values at their defaults. */
export const readAudioSourceSettings = (component: LevelComponent): typeof AUDIO_SOURCE_DEFAULTS => {
    const audioId = component.props.audioId;
    const bus = component.props.bus;
    return {
        audioId: typeof audioId === 'string' ? audioId.trim() : AUDIO_SOURCE_DEFAULTS.audioId,
        volume: clamp(readNumber(component, 'volume', AUDIO_SOURCE_DEFAULTS.volume), 0, 2),
        loop: readBoolean(component, 'loop', AUDIO_SOURCE_DEFAULTS.loop),
        spatial: readBoolean(component, 'spatial', AUDIO_SOURCE_DEFAULTS.spatial),
        autoplay: readBoolean(component, 'autoplay', AUDIO_SOURCE_DEFAULTS.autoplay),
        bus: isAudioBus(bus) ? bus : AUDIO_SOURCE_DEFAULTS.bus,
        refDistance: clamp(readNumber(component, 'refDistance', AUDIO_SOURCE_DEFAULTS.refDistance), 0.01, 1000)
    };
};

/** Plays the asset from the owner's origin; mounted in the owner's group, so a 3D source follows it. */
const AudioSourcePlayback: React.FC<ComponentRenderProps> = ({ component, object }) => {
    const camera = useThree(state => state.camera);
    const { audioAssets } = useGameContent();
    const mixer = useRuntimeMixer();
    const { audioId, volume, loop, spatial, autoplay, bus, refDistance } = readAudioSourceSettings(component);
    const url = findAudioAsset(audioAssets, audioId)?.url;
    const [sound, setSound] = useState<Sound | null>(null);
    const autoplayRef = useRef(autoplay);
    autoplayRef.current = autoplay;
    // A 3D sound the level hides from the listener is muffled; its own object does not hide it.
    useAudioOcclusion(() => (sound instanceof THREE.PositionalAudio ? [sound] : []), object.id);

    useEffect(() => {
        const { listener, release } = acquireAudioListener(camera);
        const created: Sound = spatial ? new SpatialPositionalAudio(listener) : new THREE.Audio(listener);
        setSound(created);
        return () => {
            releaseSound(created);
            release();
        };
    }, [camera, spatial]);

    useEffect(() => {
        if (!sound || !url) return;
        let current = true;
        new THREE.AudioLoader().load(url, buffer => {
            if (!current) return;
            sound.setBuffer(buffer);
            if (autoplayRef.current && !sound.isPlaying) sound.play();
        }, undefined, error => {
            if (current) frontendDiagnostics.failure('audio_source_load_failed', error);
        });
        return () => {
            current = false;
            if (sound.isPlaying) sound.stop();
        };
    }, [sound, url]);

    useEffect(() => {
        if (!sound) return;
        sound.setVolume(volume);
        sound.setLoop(loop);
        if (sound instanceof THREE.PositionalAudio) sound.setRefDistance(refDistance);
        routeSoundToBus(sound, mixer, bus);
    }, [sound, mixer, volume, loop, refDistance, bus]);

    return sound ? <primitive object={sound} /> : null;
};

/** Small unlit marker so a sound source is visible (and clickable) in the editor. */
const AudioSourceMarker: React.FC = () => (
    <mesh>
        <octahedronGeometry args={[0.14, 0]} />
        <meshBasicMaterial color="#a855f7" wireframe toneMapped={false} />
    </mesh>
);

const AudioSourceRender: React.FC<ComponentRenderProps> = (props) => (
    props.mode === 'runtime' ? <AudioSourcePlayback {...props} /> : <AudioSourceMarker />
);

export const AUDIO_COMPONENTS: ComponentDefinition[] = [
    {
        type: 'audioSource',
        label: 'Audio Source',
        description: 'Plays an audio asset from the object during play, in 3D (fading with distance) or 2D, through a mixer bus.',
        props: [
            { key: 'audioId', label: 'Audio (id or name)', type: 'string', default: AUDIO_SOURCE_DEFAULTS.audioId },
            { key: 'volume', label: 'Volume', type: 'number', default: AUDIO_SOURCE_DEFAULTS.volume, min: 0, max: 2, step: 0.05 },
            { key: 'loop', label: 'Loop', type: 'boolean', default: AUDIO_SOURCE_DEFAULTS.loop },
            { key: 'spatial', label: '3D (Spatial)', type: 'boolean', default: AUDIO_SOURCE_DEFAULTS.spatial },
            { key: 'autoplay', label: 'Play on Start', type: 'boolean', default: AUDIO_SOURCE_DEFAULTS.autoplay },
            {
                key: 'bus', label: 'Mixer Bus', type: 'select', default: AUDIO_SOURCE_DEFAULTS.bus,
                options: [
                    { label: 'SFX', value: 'sfx' }, { label: 'Music', value: 'music' },
                    { label: 'UI', value: 'ui' }, { label: 'Master', value: 'master' }
                ]
            },
            { key: 'refDistance', label: 'Full-Volume Distance', type: 'number', default: AUDIO_SOURCE_DEFAULTS.refDistance, min: 0.01, max: 1000, step: 0.1 }
        ],
        Render: AudioSourceRender
    }
];
