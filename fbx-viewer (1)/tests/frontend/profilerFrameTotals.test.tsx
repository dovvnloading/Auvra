import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProfilerPanel, ProfilerProbe } from '../../runtime/ProfilerOverlay';

/** Mirrors three's WebGLInfo: each render call resets the counters first unless autoReset is off. */
const fakeInfo = () => ({
  autoReset: true,
  render: { calls: 0, triangles: 0 },
  memory: { geometries: 4, textures: 2 },
  reset() { this.render.calls = 0; this.render.triangles = 0; },
});

const { gl, frame } = vi.hoisted(() => ({
  gl: { info: null as unknown as ReturnType<typeof fakeInfo> },
  frame: { callback: null as ((state: unknown, delta: number) => void) | null },
}));

vi.mock('@react-three/fiber', () => ({
  useThree: (selector: (state: { gl: typeof gl }) => unknown) => selector({ gl }),
  useFrame: (callback: (state: unknown, delta: number) => void) => { frame.callback = callback; },
}));

const renderCall = (calls: number, triangles: number) => {
  if (gl.info.autoReset) gl.info.reset();
  gl.info.render.calls += calls;
  gl.info.render.triangles += triangles;
};

/** One post-processed frame: the scene pass, then two full-screen effect passes. */
const postProcessedFrame = () => {
  renderCall(120, 50_000);
  renderCall(1, 1);
  renderCall(1, 1);
};

const row = (label: string) => screen.getByText(label).nextElementSibling?.textContent;

describe('profiler draw-call totals', () => {
  it('reports the whole frame, not the last post-processing pass, and restores autoReset', () => {
    gl.info = fakeInfo();
    const { rerender } = render(<><ProfilerProbe enabled /><ProfilerPanel visible /></>);
    expect(gl.info.autoReset).toBe(false);

    for (let i = 0; i < 3; i += 1) {
      act(() => { frame.callback?.({}, 0.1); });
      postProcessedFrame();
    }
    act(() => { frame.callback?.({}, 0.1); });
    expect(row('Draw calls')).toBe('122');
    expect(row('Triangles')).toBe((50_002).toLocaleString());
    // Read and reset once per frame, so frames never pile up.
    expect(gl.info.render.calls).toBe(0);

    rerender(<><ProfilerProbe enabled={false} /><ProfilerPanel visible /></>);
    expect(gl.info.autoReset).toBe(true);
  });
});
