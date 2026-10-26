import { describe, expect, it } from 'vitest';
import { blendSeconds, blendWeights2D, clampAnimationDelta, DEFAULT_BLEND_SECONDS, stepWeight } from '../../components/AnimationGraph/utils/blending';

describe('animation blending', () => {
  it('crossfades over the configured duration regardless of frame rate', () => {
    const run = (fps: number) => {
      let weight = 0;
      let time = 0;
      while (weight < 1) { weight = stepWeight(weight, 1, 1 / fps, 0.5); time += 1 / fps; }
      return time;
    };
    expect(run(30)).toBeCloseTo(0.5, 1);
    expect(run(144)).toBeCloseTo(0.5, 1);
    expect(stepWeight(0.3, 0, 0.1, 0)).toBe(0);
  });

  it('falls back to the default duration for missing or invalid values', () => {
    expect(blendSeconds(0.75)).toBe(0.75);
    expect(blendSeconds(undefined)).toBe(DEFAULT_BLEND_SECONDS);
    expect(blendSeconds(-1)).toBe(DEFAULT_BLEND_SECONDS);
  });

  it('clamps long frames', () => {
    expect(clampAnimationDelta(2)).toBe(0.1);
    expect(clampAnimationDelta(Number.NaN)).toBe(0);
  });

  it('gives a sample the whole weight at its position and sums to one elsewhere', () => {
    const samples = [{ position: [0, 0] as [number, number] }, { position: [1, 0] as [number, number] }, { position: [0, 1] as [number, number] }];
    expect(blendWeights2D(samples, 1, 0)).toEqual([0, 1, 0]);
    const mid = blendWeights2D(samples, 0.9, 0.05);
    expect(mid.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(mid[1]).toBeGreaterThan(0.95);
  });
});
