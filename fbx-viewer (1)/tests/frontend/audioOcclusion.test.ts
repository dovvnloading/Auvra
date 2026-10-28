import { describe, expect, it, vi } from 'vitest';
import { OCCLUDED_CUTOFF_HZ, OCCLUDED_GAIN, OPEN_CUTOFF_HZ, isOccluded, occlusionFilters, setOccluded, type OccludableSound } from '../../runtime/audioOcclusion';

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
});
