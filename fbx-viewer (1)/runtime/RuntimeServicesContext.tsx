import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { addAfterEffect, useFrame, useThree } from '@react-three/fiber';
import { frontendDiagnostics } from '../diagnostics/runtime';
import { AUDIO_BUSES, AudioMixer, type AudioBus, type AudioBusVolumes } from './audioMixer';
import { useGameContent } from './GameContentContext';
import { SpatialAudioListener } from './spatialAudio';
import { applyBindingOverrides, DEFAULT_INPUT_MAP, InputState, useInputActions } from './input';
import { defaultPlayerOptions, type PlayerOptions, type PlayerOptionsStore } from './playerOptions';
import { DEFAULT_GAME_SETTINGS, type GameSettings } from './types';

/** Where a prefab is placed: a tuple, or anything with x/y/z such as a THREE.Vector3. */
export type SpawnPosition = readonly [number, number, number] | { x: number; y: number; z: number };

/** Engine services gameplay code (components, blueprint nodes, controllers) reaches during play. */
export interface RuntimeServices {
    /** Live gameplay input with the player's rebinds applied. Edges (wasPressed/wasReleased) advance once per frame, after every frame callback. */
    input: InputState;
    /** Bus mixer on the camera AudioListener's context; null before it mounts or where Web Audio is unavailable. */
    mixer: AudioMixer | null;
    options: PlayerOptions;
    /** Places a copy of a prefab in the running session (never the project). Returns the new object ids, root first; [] when nothing was placed. */
    spawnPrefab(prefabId: string, position: SpawnPosition): string[];
    /** Plays an audio asset once, non-positional, on a mixer bus (default 'sfx'). In a play session it stops when the session ends. */
    playSound(audioId: string, bus?: AudioBus): void;
    /** Removes an object (and its children) from the running session, never the project; a save remembers it is gone. */
    destroyObject(objectId: string): void;
}

/** Outside a level runtime nothing is fed or played; reading input and calling services is harmless. */
const INERT_SERVICES: RuntimeServices = {
    input: new InputState(DEFAULT_INPUT_MAP),
    mixer: null,
    options: defaultPlayerOptions(DEFAULT_GAME_SETTINGS),
    spawnPrefab: () => [],
    playSound: () => undefined,
    destroyObject: () => undefined,
};

const RuntimeServicesContext = createContext<RuntimeServices | null>(null);

export const useRuntimeServices = (): RuntimeServices => useContext(RuntimeServicesContext) ?? INERT_SERVICES;

/** True inside a level runtime; editor and Sandbox renders get the inert services instead. */
export const useRuntimeServicesAvailable = (): boolean => useContext(RuntimeServicesContext) !== null;

/** World position for a spawn; non-finite coordinates fall back to 0. */
export const toSpawnPoint = (position: SpawnPosition): [number, number, number] => {
    const [x, y, z] = 'x' in position ? [position.x, position.y, position.z] : position;
    const finite = (value: number) => (Number.isFinite(value) ? value : 0);
    return [finite(x), finite(y), finite(z)];
};

const spawnOutsideSession = (): string[] => {
    frontendDiagnostics.warning('runtime_prefab_spawn_outside_session');
    return [];
};

const subscribeNothing = () => () => undefined;

/** The Play Sound voices one play session started. Once it ends they stop, and sounds it asked for never start. */
interface VoiceScope {
    ended: boolean;
    voices: Set<AudioBufferSourceNode>;
}

const newVoiceScope = (): VoiceScope => ({ ended: false, voices: new Set() });

const stopVoices = (voices: Set<AudioBufferSourceNode>) => {
    voices.forEach(source => {
        try { source.stop(); } catch { /* already ended */ }
        source.disconnect();
    });
    voices.clear();
};

/** Plays a sound for a session scope (null: the runtime itself); supplied by RuntimeServicesProvider. */
type ScopedPlaySound = (audioId: string, bus: AudioBus | undefined, scope: VoiceScope | null) => void;

const ScopedPlaySoundContext = createContext<ScopedPlaySound | null>(null);

interface AttachedMixer {
    mixer: AudioMixer;
    context: AudioContext;
    detach(): void;
}

/**
 * Puts a bus mixer between the camera's AudioListener and the speakers, creating the listener when the
 * camera has none. Sounds still connected to the listener (emitters, weapons) play through the master
 * bus; sounds that pick a bus connect to mixer.input(bus). detach() restores the listener's own routing.
 */
const attachMixer = (camera: THREE.Camera, volumes: AudioBusVolumes): AttachedMixer => {
    const existing = camera.children.find(child => child.type === 'AudioListener') as THREE.AudioListener | undefined;
    const listener = existing ?? new SpatialAudioListener();
    const context = listener.context;
    const mixer = new AudioMixer(context, context.destination, volumes);
    const output = listener.getInput();
    output.disconnect();
    output.connect(mixer.input('master'));
    if (!existing) camera.add(listener);
    return {
        mixer,
        context,
        detach() {
            output.disconnect();
            output.connect(context.destination);
            if (!existing) camera.remove(listener);
            mixer.dispose();
        },
    };
};

interface RuntimeServicesProviderProps {
    settings: GameSettings;
    /** The player's saved options; without a store the game settings' defaults apply. */
    playerOptions?: PlayerOptionsStore;
    /** False while paused: held input is released and new input is ignored. */
    inputEnabled: boolean;
    /** Receives the runtime's input (null on unmount), for overlays outside the canvas such as touch controls. */
    onInput?: (input: InputState | null) => void;
    children?: React.ReactNode;
}

/**
 * Runtime-lifetime services for the level runtime. Renders inside the runtime canvas; each play session
 * adds its prefab spawner with RuntimeSpawnerProvider.
 */
export const RuntimeServicesProvider: React.FC<RuntimeServicesProviderProps> = ({ settings, playerOptions, inputEnabled, onInput, children }) => {
    const { audioAssets } = useGameContent();
    const camera = useThree(state => state.camera);

    // --- OPTIONS ---
    const fallbackOptions = useMemo(() => defaultPlayerOptions(settings), [settings]);
    const getOptions = useCallback(() => (playerOptions ? playerOptions.get() : fallbackOptions), [playerOptions, fallbackOptions]);
    const options = useSyncExternalStore(playerOptions ? playerOptions.subscribe : subscribeNothing, getOptions, getOptions);

    // --- INPUT ---
    const inputMap = useMemo(() => applyBindingOverrides(DEFAULT_INPUT_MAP, options.bindings), [options.bindings]);
    const input = useInputActions(inputMap, inputEnabled);
    useEffect(() => {
        if (!onInput) return;
        onInput(input);
        return () => onInput(null);
    }, [input, onInput]);

    // Edges advance at the very end of each rendered frame (after every useFrame, whatever its priority, and the
    // render), so every reader in a frame sees the same presses. A positive useFrame priority would take over rendering.
    const frameRendered = useRef(false);
    useFrame(() => {
        frameRendered.current = true;
    });
    useEffect(() => addAfterEffect(() => {
        if (!frameRendered.current) return;
        frameRendered.current = false;
        input.endFrame();
    }), [input]);

    // --- AUDIO ---
    const volumesRef = useRef(options.volumes);
    const audioAssetsRef = useRef(audioAssets);
    useLayoutEffect(() => {
        volumesRef.current = options.volumes;
        audioAssetsRef.current = audioAssets;
    }, [options.volumes, audioAssets]);

    const audioRef = useRef<AttachedMixer | null>(null);
    const voices = useRef(new Set<AudioBufferSourceNode>());
    const buffers = useRef(new Map<string, Promise<AudioBuffer>>());
    const [mixer, setMixer] = useState<AudioMixer | null>(null);

    // Layout effect: the listener exists before any child's passive effect looks for one, so children never own it.
    useLayoutEffect(() => {
        let attached: AttachedMixer;
        try {
            attached = attachMixer(camera, volumesRef.current);
        } catch (error) {
            frontendDiagnostics.failure('runtime_audio_mixer_failed', error);
            return undefined;
        }
        audioRef.current = attached;
        setMixer(attached.mixer);
        const playing = voices.current;
        return () => {
            stopVoices(playing);
            if (audioRef.current === attached) audioRef.current = null;
            attached.detach();
            setMixer(null);
        };
    }, [camera]);

    useEffect(() => {
        mixer?.setVolumes(options.volumes);
    }, [mixer, options.volumes]);

    const playScopedSound = useCallback<ScopedPlaySound>((audioId, bus = 'sfx', scope) => {
        // A late call from a session that already ended (a timer, a decode callback) plays nothing.
        if (scope?.ended) return;
        const asset = audioAssetsRef.current.find(item => item.id === audioId);
        const audio = audioRef.current;
        if (!asset) {
            frontendDiagnostics.warning('runtime_sound_missing');
            return;
        }
        if (!audio) {
            frontendDiagnostics.warning('runtime_sound_unavailable');
            return;
        }
        const target = AUDIO_BUSES.includes(bus) ? bus : 'sfx';
        let buffer = buffers.current.get(asset.url);
        if (!buffer) {
            buffer = new THREE.AudioLoader().loadAsync(asset.url);
            buffers.current.set(asset.url, buffer);
        }
        buffer.then(decoded => {
            // The mixer went away (runtime ended), or the session that asked ended (restart, retry), while the sound loaded.
            if (audioRef.current !== audio || scope?.ended) return;
            const source = audio.context.createBufferSource();
            source.buffer = decoded;
            source.connect(audio.mixer.input(target));
            source.onended = () => {
                source.disconnect();
                voices.current.delete(source);
                scope?.voices.delete(source);
            };
            source.start();
            voices.current.add(source);
            scope?.voices.add(source);
        }).catch(error => {
            buffers.current.delete(asset.url);
            frontendDiagnostics.failure('runtime_sound_failed', error);
        });
    }, []);

    const playSound = useCallback((audioId: string, bus?: AudioBus) => playScopedSound(audioId, bus, null), [playScopedSound]);

    const services = useMemo<RuntimeServices>(() => ({
        input,
        mixer,
        options,
        spawnPrefab: spawnOutsideSession,
        playSound,
        destroyObject: () => undefined,
    }), [input, mixer, options, playSound]);

    return (
        <RuntimeServicesContext.Provider value={services}>
            <ScopedPlaySoundContext.Provider value={playScopedSound}>{children}</ScopedPlaySoundContext.Provider>
        </RuntimeServicesContext.Provider>
    );
};

/**
 * Supplies spawnPrefab for one play session, which owns the runtime world spawned objects join. Play Sound
 * voices belong to the session too: a restart or retry remounts it, which stops every sound the old session
 * started and drops any it asked for that is still loading.
 */
export const RuntimeSpawnerProvider: React.FC<{
    spawnPrefab: RuntimeServices['spawnPrefab'];
    destroyObject?: RuntimeServices['destroyObject'];
    children?: React.ReactNode;
}> = ({ spawnPrefab, destroyObject, children }) => {
    const services = useRuntimeServices();
    const playScopedSound = useContext(ScopedPlaySoundContext);
    const scope = useRef<VoiceScope>(newVoiceScope());
    // Layout effect: the old session's voices stop in the same commit that mounts the new session.
    useLayoutEffect(() => {
        if (scope.current.ended) scope.current = newVoiceScope(); // StrictMode re-runs effects on the same instance.
        const own = scope.current;
        return () => {
            own.ended = true;
            stopVoices(own.voices);
        };
    }, []);
    const playSound = useMemo<RuntimeServices['playSound']>(() => (
        playScopedSound ? (audioId, bus) => playScopedSound(audioId, bus, scope.current) : services.playSound
    ), [playScopedSound, services.playSound]);
    const value = useMemo<RuntimeServices>(
        () => ({ ...services, spawnPrefab, playSound, destroyObject: destroyObject ?? services.destroyObject }),
        [services, spawnPrefab, playSound, destroyObject],
    );
    return <RuntimeServicesContext.Provider value={value}>{children}</RuntimeServicesContext.Provider>;
};
