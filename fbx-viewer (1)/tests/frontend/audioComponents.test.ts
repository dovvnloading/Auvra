import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { AudioMixer } from '../../runtime/audioMixer';
import {
  AUDIO_COMPONENTS, AUDIO_SOURCE_DEFAULTS, acquireAudioListener, findAudioAsset, readAudioSourceSettings,
  releaseSound, resolveEmitterBus, routeSoundToBus,
} from '../../runtime/components/audioComponents';
import type { AudioData, LevelComponent } from '../../types';

interface FakeNode { context: unknown; connected: unknown[]; connect(target: unknown): void; disconnect(): void }

/** Just enough of an AudioContext for THREE.AudioListener, THREE.Audio and AudioMixer. */
const fakeContext = () => {
  const context = {
    currentTime: 0,
    destination: { name: 'destination' },
    createGain() {
      const node = {
        context,
        gain: { value: 1, setTargetAtTime(value: number) { node.gain.value = value; } },
        connected: [] as unknown[],
        connect(target: unknown) { node.connected.push(target); },
        disconnect() { node.connected = []; },
      };
      return node;
    },
  };
  return context as unknown as AudioContext;
};

const useFakeAudioContext = () => {
  const context = fakeContext();
  THREE.AudioContext.setContext(context);
  return context;
};

const output = (sound: THREE.Audio) => sound.gain as unknown as FakeNode;

afterEach(() => {
  THREE.AudioContext.setContext(undefined as unknown as AudioContext);
});

describe('emitter bus routing', () => {
  it('uses the configured bus, else music for global loops and sfx for the rest', () => {
    expect(resolveEmitterBus({ loop: true, isSpatial: false, bus: 'ui' })).toBe('ui');
    expect(resolveEmitterBus({ loop: true, isSpatial: false })).toBe('music');
    expect(resolveEmitterBus({ loop: true, isSpatial: true })).toBe('sfx');
    expect(resolveEmitterBus({ loop: false, isSpatial: false })).toBe('sfx');
    expect(resolveEmitterBus({ loop: true, isSpatial: false, bus: 'loud' })).toBe('music');
  });

  it('wires a sound into its mixer bus, back to the listener without a mixer, and detaches on release', () => {
    const context = useFakeAudioContext();
    const listener = new THREE.AudioListener();
    const mixer = new AudioMixer(context);
    const sound = new THREE.Audio(listener);
    expect(output(sound).connected).toEqual([listener.getInput()]);

    routeSoundToBus(sound, mixer, 'sfx');
    expect(output(sound).connected).toEqual([mixer.input('sfx')]);
    routeSoundToBus(sound, mixer, 'sfx');
    expect(output(sound).connected).toEqual([mixer.input('sfx')]);

    routeSoundToBus(sound, mixer, 'music');
    expect(output(sound).connected).toEqual([mixer.input('music')]);

    routeSoundToBus(sound, null, 'music');
    expect(output(sound).connected).toEqual([listener.getInput()]);

    releaseSound(sound);
    expect(output(sound).connected).toEqual([]);
  });

  it('keeps the listener route when the mixer runs on another context', () => {
    useFakeAudioContext();
    const listener = new THREE.AudioListener();
    const foreignMixer = new AudioMixer(fakeContext());
    const sound = new THREE.Audio(listener);
    routeSoundToBus(sound, foreignMixer, 'sfx');
    expect(output(sound).connected).toEqual([listener.getInput()]);
  });
});

describe('shared audio listener', () => {
  it('adds one listener for every holder and removes it after the last release', () => {
    useFakeAudioContext();
    const camera = new THREE.Object3D();
    const first = acquireAudioListener(camera);
    const second = acquireAudioListener(camera);
    expect(second.listener).toBe(first.listener);
    expect(camera.children).toEqual([first.listener]);

    first.release();
    first.release();
    expect(camera.children).toEqual([first.listener]);
    second.release();
    expect(camera.children).toEqual([]);
  });

  it('borrows a listener someone else put on the camera and leaves it there', () => {
    useFakeAudioContext();
    const camera = new THREE.Object3D();
    const foreign = new THREE.AudioListener();
    camera.add(foreign);
    const lease = acquireAudioListener(camera);
    expect(lease.listener).toBe(foreign);
    lease.release();
    expect(camera.children).toEqual([foreign]);
  });
});

describe('audioSource component', () => {
  const component = (props: Record<string, unknown>): LevelComponent => ({ id: 'c', type: 'audioSource', enabled: true, props });

  it('declares its props with defaults the reader accepts', () => {
    const [definition] = AUDIO_COMPONENTS;
    expect(definition.type).toBe('audioSource');
    expect(typeof definition.Render).toBe('function');
    const defaults = Object.fromEntries(definition.props.map(prop => [prop.key, prop.default]));
    expect(defaults).toEqual(AUDIO_SOURCE_DEFAULTS);
    expect(readAudioSourceSettings(component(defaults))).toEqual(AUDIO_SOURCE_DEFAULTS);
    const bus = definition.props.find(prop => prop.key === 'bus');
    expect(bus?.options?.map(option => option.value)).toContain(AUDIO_SOURCE_DEFAULTS.bus);
  });

  it('falls back to defaults and clamps out-of-range values', () => {
    expect(readAudioSourceSettings(component({ volume: 9, refDistance: -1, bus: 'loud', loop: 'yes', audioId: ' a1 ' }))).toEqual({
      ...AUDIO_SOURCE_DEFAULTS, audioId: 'a1', volume: 2, refDistance: 0.01,
    });
  });

  it('finds an asset by id, then by name', () => {
    const assets = [
      { id: 'a1', name: 'Wind', url: 'blob:1', type: 'audio/ogg', duration: 1 },
      { id: 'a2', name: 'a1', url: 'blob:2', type: 'audio/ogg', duration: 1 },
    ] satisfies AudioData[];
    expect(findAudioAsset(assets, 'a1')?.url).toBe('blob:1');
    expect(findAudioAsset(assets, 'Wind')?.url).toBe('blob:1');
    expect(findAudioAsset(assets, '')).toBeUndefined();
    expect(findAudioAsset(assets, 'missing')).toBeUndefined();
  });
});
