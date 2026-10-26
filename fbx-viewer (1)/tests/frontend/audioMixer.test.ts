import { describe, expect, it } from 'vitest';
import { AudioMixer, normalizeBusVolumes } from '../../runtime/audioMixer';

const fakeContext = () => {
  const gains: { gain: { value: number; setTargetAtTime: (v: number) => void }; connected: unknown[]; connect: (n: unknown) => void; disconnect: () => void }[] = [];
  const context = {
    currentTime: 0,
    destination: { name: 'destination' },
    createGain() {
      const node = {
        gain: { value: 1, setTargetAtTime(v: number) { node.gain.value = v; } },
        connected: [] as unknown[],
        connect(target: unknown) { node.connected.push(target); },
        disconnect() { node.connected = []; },
      };
      gains.push(node);
      return node;
    },
  };
  return { context: context as unknown as BaseAudioContext, gains };
};

describe('audio mixer', () => {
  it('routes buses through master and applies volumes', () => {
    const { context, gains } = fakeContext();
    const mixer = new AudioMixer(context, context.destination, { master: 0.5, music: 0.4, sfx: 1, ui: 0.2 });
    const [master] = gains;
    expect(master.connected).toContain(context.destination);
    expect((mixer.input('music') as unknown as { connected: unknown[] }).connected).toContain(master);
    expect(master.gain.value).toBe(0.5);
    expect(mixer.effectiveGain('music')).toBeCloseTo(0.2);
    mixer.setVolumes({ music: 2 });
    expect(mixer.getVolumes().music).toBe(1);
  });

  it('normalizes stored volumes', () => {
    expect(normalizeBusVolumes({ master: -1, music: 'loud' })).toEqual({ master: 0, music: 0.8, sfx: 1, ui: 1 });
  });
});
