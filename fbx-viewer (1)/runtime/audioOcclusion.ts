import { useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { usePhysicsQueries } from './physics';
import { lineOfSight } from './perception';

/**
 * AUDIO OCCLUSION
 *
 * A 3D sound the level hides from the listener is muffled: a physics ray from the listener to the
 * sound (the same test enemies see by, runtime/perception.ts) that something solid stops lowers
 * the sound's high frequencies and its volume, easing in and out as the way opens and closes.
 */

/** Low-pass cutoff with nothing in the way (above hearing: no change) and behind a wall. */
export const OPEN_CUTOFF_HZ = 20000;
export const OCCLUDED_CUTOFF_HZ = 800;
/** Volume behind a wall, as a share of the open volume. */
export const OCCLUDED_GAIN = 0.5;
/** Seconds between rays per sound. */
const CHECK_INTERVAL = 0.25;
/** Time constant (seconds) of the ease between open and occluded. */
const EASE_SECONDS = 0.12;
/** Sounds further than this from the listener are not checked (they are too faint to matter). */
const MAX_CHECK_DISTANCE = 200;

/** The part of a sound occlusion needs: three's filter chain on its AudioContext. */
export type OccludableSound = Pick<THREE.PositionalAudio, 'context' | 'getFilters' | 'setFilters'>;

interface OcclusionFilters {
    lowpass: BiquadFilterNode;
    gain: GainNode;
    occluded: boolean;
}

const attached = new WeakMap<OccludableSound, OcclusionFilters>();

/** The occlusion filters of a sound, put at the end of its filter chain the first time. */
export const occlusionFilters = (sound: OccludableSound): OcclusionFilters => {
    let filters = attached.get(sound);
    if (!filters) {
        const lowpass = sound.context.createBiquadFilter();
        lowpass.type = 'lowpass';
        lowpass.frequency.value = OPEN_CUTOFF_HZ;
        const gain = sound.context.createGain();
        gain.gain.value = 1;
        sound.setFilters([...sound.getFilters(), lowpass, gain]);
        filters = { lowpass, gain, occluded: false };
        attached.set(sound, filters);
    }
    return filters;
};

/** Eases a sound towards muffled (something is in the way) or clear. */
export const setOccluded = (sound: OccludableSound, occluded: boolean): void => {
    const filters = occlusionFilters(sound);
    if (filters.occluded === occluded) return;
    filters.occluded = occluded;
    const now = sound.context.currentTime;
    filters.lowpass.frequency.setTargetAtTime(occluded ? OCCLUDED_CUTOFF_HZ : OPEN_CUTOFF_HZ, now, EASE_SECONDS);
    filters.gain.gain.setTargetAtTime(occluded ? OCCLUDED_GAIN : 1, now, EASE_SECONDS);
};

/** Whether a sound is muffled now (tests). */
export const isOccluded = (sound: OccludableSound): boolean => attached.get(sound)?.occluded ?? false;

const _listener = new THREE.Vector3();
const _source = new THREE.Vector3();

/**
 * Muffles the playing 3D sounds `sounds()` lists while the level hides them from the camera's
 * listener. `ignore` names an object a sound's ray passes through (the one it plays from).
 */
export const useAudioOcclusion = (sounds: () => Iterable<THREE.PositionalAudio>, ignore: string | null = null): void => {
    const camera = useThree(state => state.camera);
    const physics = usePhysicsQueries();
    const clock = useRef({ time: 0, next: 0 });
    useFrame((_state, delta) => {
        const timer = clock.current;
        timer.time += delta;
        if (timer.time < timer.next) return;
        timer.next = timer.time + CHECK_INTERVAL;
        camera.getWorldPosition(_listener);
        for (const sound of sounds()) {
            if (!sound.isPlaying) continue;
            sound.getWorldPosition(_source);
            if (_listener.distanceTo(_source) > MAX_CHECK_DISTANCE) continue;
            setOccluded(sound, !lineOfSight(physics, _listener, _source, ignore));
        }
    });
};
