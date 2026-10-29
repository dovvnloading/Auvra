import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  OCCLUDED_CUTOFF_HZ,
  OCCLUDED_GAIN,
  OPEN_CUTOFF_HZ,
  isOccluded,
  measureOcclusion,
  occlusionAmount,
  occlusionFilters,
  setOccluded,
  setOcclusion,
  type OccludableSound,
} from '../../runtime/audioOcclusion';

/** An AudioParam that records where it was told to go. */
const param = (value: number) => ({ value, setTargetAtTime: vi.fn(function (this: { value: number }, target: number) { this.value = target; }) });

/** A sound on a fake AudioContext, with three's filter chain. */
const fakeSound = () => {
  let filters: AudioNode[] = [];
  const context = {
    currentTime: 3,
    createBiquadFilter: () => ({ type: '', frequency: param(350) }),
    createGain: () => ({ gain: param(1) }),
  };
  const sound = {
    context,
    getFilters: () => filters,
    setFilters: vi.fn((next: AudioNode[]) => { filters = next; return sound; }),
  };
  return { sound: sound as unknown as OccludableSound, filters: () => filters, setFilters: sound.setFilters };
};

describe('audio occlusion', () => {
  it('adds a clear low-pass and gain to the end of the filter chain, once', () => {
    const { sound, filters, setFilters } = fakeSound();
    const { lowpass, gain } = occlusionFilters(sound);
    expect(lowpass.type).toBe('lowpass');
    expect(lowpass.frequency.value).toBe(OPEN_CUTOFF_HZ);
    expect(gain.gain.value).toBe(1);
    expect(filters()).toEqual([lowpass, gain]);
    occlusionFilters(sound);
    expect(setFilters).toHaveBeenCalledTimes(1);
  });

  it('eases to muffled behind a wall and back when the way opens, only on a change', () => {
    const { sound } = fakeSound();
    const { lowpass, gain } = occlusionFilters(sound);
    setOccluded(sound, true);
    expect(isOccluded(sound)).toBe(true);
    expect(lowpass.frequency.setTargetAtTime).toHaveBeenLastCalledWith(OCCLUDED_CUTOFF_HZ, 3, expect.any(Number));
    expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(OCCLUDED_GAIN, 3, expect.any(Number));
    setOccluded(sound, true);
    expect(lowpass.frequency.setTargetAtTime).toHaveBeenCalledTimes(1);
    setOccluded(sound, false);
    expect(isOccluded(sound)).toBe(false);
    expect(lowpass.frequency.setTargetAtTime).toHaveBeenLastCalledWith(OPEN_CUTOFF_HZ, 3, expect.any(Number));
    expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 3, expect.any(Number));
  });

  it('muffles by the share of rays a wall stops, so a sound opens up past a corner', () => {
    // A wall across x = 1 from z = -5 up to its edge; the listener at the origin, the sound behind it at x = 2.
    const wall = (edge: number) => ({
      raycast: (eye: THREE.Vector3, direction: THREE.Vector3, distance: number) => {
        const t = (1 - eye.x) / direction.x;
        if (!(t > 0 && t < 1)) return null;
        const z = eye.z + direction.z * t;
        return z >= -5 && z <= edge ? { objectId: 'wall', distance: t * distance, point: new THREE.Vector3(), normal: new THREE.Vector3() } : null;
      },
    });
    const listener = new THREE.Vector3(0, 0, 0);
    const source = new THREE.Vector3(2, 0, 0);
    const measure = (edge: number) => measureOcclusion(wall(edge) as unknown as Parameters<typeof measureOcclusion>[0], listener, source);
    expect(measure(5)).toBe(1);
    expect(measure(0.2)).toBeCloseTo(0.875, 5);
    expect(measure(-0.2)).toBeCloseTo(0.125, 5);
    expect(measure(-1)).toBe(0);
  });

  it('eases a partly hidden sound to a cutoff and volume between clear and muffled', () => {
    const { sound } = fakeSound();
    const { lowpass, gain } = occlusionFilters(sound);
    setOcclusion(sound, 0.5);
    expect(occlusionAmount(sound)).toBe(0.5);
    // Halfway in pitch: the geometric mean of the two cutoffs.
    expect(lowpass.frequency.setTargetAtTime).toHaveBeenLastCalledWith(expect.closeTo(Math.sqrt(OPEN_CUTOFF_HZ * OCCLUDED_CUTOFF_HZ), 3), 3, expect.any(Number));
    expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(expect.closeTo((1 + OCCLUDED_GAIN) / 2, 5), 3, expect.any(Number));
    // A change too small to hear is not scheduled.
    setOcclusion(sound, 0.51);
    expect(lowpass.frequency.setTargetAtTime).toHaveBeenCalledTimes(1);
  });
});
