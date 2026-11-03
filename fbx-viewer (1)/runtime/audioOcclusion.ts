import { useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { usePhysicsQueries } from './physicsQueries';
import { lineOfSight } from './perception';

/**
 * AUDIO OCCLUSION
 *
 * A 3D sound the level hides from the listener is muffled: physics rays from the listener (the
 * same test enemies see by, runtime/perception.ts) to the sound and to points around it, as a
 * sound comes from an area rather than a point. The share of them something solid stops lowers
 * the sound's high frequencies and its volume, so a sound around a corner opens up gradually as
 * the listener steps out, and the change eases in rather than jumping.
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
    /** 0 (clear) to 1 (fully behind something). */
    amount: number;
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
        filters = { lowpass, gain, amount: 0 };
        attached.set(sound, filters);
    }
    return filters;
};

/** Changes of the amount smaller than this are not worth rescheduling the filters for. */
const AMOUNT_STEP = 0.02;

/** The low-pass cutoff for an occlusion amount: from open to occluded evenly in pitch (octaves), not in hertz. */
export const occlusionCutoff = (amount: number): number => OPEN_CUTOFF_HZ * (OCCLUDED_CUTOFF_HZ / OPEN_CUTOFF_HZ) ** amount;
export const occlusionGain = (amount: number): number => 1 - (1 - OCCLUDED_GAIN) * amount;

/** Eases a sound towards `amount` occluded: 0 clear, 1 fully behind something, partly in between. */
export const setOcclusion = (sound: OccludableSound, amount: number): void => {
    const filters = occlusionFilters(sound);
    const clamped = Math.min(1, Math.max(0, amount));
    if (Math.abs(filters.amount - clamped) < AMOUNT_STEP && (clamped === 0) === (filters.amount === 0)) return;
    filters.amount = clamped;
    const now = sound.context.currentTime;
    filters.lowpass.frequency.setTargetAtTime(occlusionCutoff(clamped), now, EASE_SECONDS);
    filters.gain.gain.setTargetAtTime(occlusionGain(clamped), now, EASE_SECONDS);
};

/** Eases a sound towards muffled (something is in the way) or clear. */
export const setOccluded = (sound: OccludableSound, occluded: boolean): void => setOcclusion(sound, occluded ? 1 : 0);

/** How occluded a sound is now, 0 to 1 (tests). */
export const occlusionAmount = (sound: OccludableSound): number => attached.get(sound)?.amount ?? 0;

/** Whether a sound is muffled at all now (tests). */
export const isOccluded = (sound: OccludableSound): boolean => occlusionAmount(sound) > 0;

/** How far around the sound the side rays aim, in world units. */
const SOURCE_SPREAD = 0.6;
/** The ray to the sound itself counts this much; the four around it share the rest. */
const CENTER_WEIGHT = 0.5;

const _direction = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3();
const _point = new THREE.Vector3();

/**
 * How much of a sound at `source` the level hides from `listener`, 0 to 1: the ray to the sound
 * counts half, rays to four points around it (across the line between them) an eighth each.
 */
export const measureOcclusion = (
    physics: Parameters<typeof lineOfSight>[0],
    listener: THREE.Vector3,
    source: THREE.Vector3,
    ignore: string | null = null,
): number => {
    let amount = lineOfSight(physics, listener, source, ignore) ? 0 : CENTER_WEIGHT;
    _direction.subVectors(source, listener);
    if (_direction.lengthSq() < 1e-8) return amount;
    _direction.normalize();
    _side.crossVectors(_direction, THREE.Object3D.DEFAULT_UP);
    if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0);
    _side.normalize();
    _up.crossVectors(_side, _direction).normalize();
    for (const [axis, sign] of [[_side, 1], [_side, -1], [_up, 1], [_up, -1]] as const) {
        _point.copy(source).addScaledVector(axis, sign * SOURCE_SPREAD);
        if (!lineOfSight(physics, listener, _point, ignore)) amount += (1 - CENTER_WEIGHT) / 4;
    }
    return amount;
};

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
            setOcclusion(sound, measureOcclusion(physics, _listener, _source, ignore));
        }
    });
};
