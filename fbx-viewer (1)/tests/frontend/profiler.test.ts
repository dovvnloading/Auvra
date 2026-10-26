import { describe, expect, it } from 'vitest';
import { FrameSampler } from '../../runtime/ProfilerOverlay';

describe('frame sampler', () => {
  it('averages frame time and reports the worst frame', () => {
    const sampler = new FrameSampler(4);
    [1 / 60, 1 / 60, 1 / 30, 1 / 60].forEach(delta => sampler.add(delta));
    const summary = sampler.summary();
    expect(summary.worstFrameMs).toBeCloseTo(33.33, 1);
    expect(summary.frameMs).toBeCloseTo((16.667 * 3 + 33.333) / 4, 1);
    expect(summary.fps).toBeCloseTo(1000 / summary.frameMs, 5);
  });

  it('keeps a bounded window and ignores invalid deltas', () => {
    const sampler = new FrameSampler(2);
    sampler.add(1);
    sampler.add(0.5);
    sampler.add(0.25);
    sampler.add(Number.NaN);
    sampler.add(-1);
    expect(sampler.summary().worstFrameMs).toBe(500);
    expect(new FrameSampler().summary()).toEqual({ fps: 0, frameMs: 0, worstFrameMs: 0 });
  });
});
