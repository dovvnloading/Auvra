import React from 'react';
import * as THREE from 'three';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioMixer } from '../../runtime/audioMixer';
import { GameContentProvider } from '../../runtime/GameContentContext';
import type { GameContent } from '../../runtime/types';
import { ComponentHostContext } from '../../runtime/components/builtins';
import {
  AUDIO_ZONE_COMPONENTS,
  INITIAL_MUSIC_QUEUE,
  MUSIC_PLAYER_DEFAULTS,
  REVERB_PRESETS,
  REVERB_ZONE_DEFAULTS,
  generateImpulseResponse,
  getImpulseResponse,
  musicPlayback,
  nextTrack,
  readMusicPlayerSettings,
  readReverbZoneSettings,
  readTracks,
  zoneWeight,
  type MusicQueueState,
  type ReverbZoneVolume,
} from '../../runtime/components/audioZones';
import type { AudioData, LevelComponent, LevelObject } from '../../types';

/*
 * Reverb zones and music: the pure zone depth and playlist order, the impulse responses, and both
 * components rendered in runtime mode on an AudioMixer over a fake AudioContext, with frames driven by
 * hand through a stand-in for useFrame and media elements whose play/pause/load are recorded.
 */

type FrameCallback = (state: { camera: THREE.Camera }, delta: number) => void;

const frame = vi.hoisted(() => ({ callbacks: new Set<{ current: FrameCallback }>() }));
const services = vi.hoisted(() => ({ mixer: null as AudioMixer | null }));

vi.mock('@react-three/fiber', async () => {
  const R = await import('react');
  return {
    useFrame: (callback: FrameCallback) => {
      const ref = R.useRef(callback);
      ref.current = callback;
      R.useEffect(() => {
        frame.callbacks.add(ref);
        return () => { frame.callbacks.delete(ref); };
      }, []);
    },
  };
});

vi.mock('../../runtime/RuntimeServicesContext', () => ({
  useRuntimeServices: () => ({ mixer: services.mixer }),
}));

// --- FAKE WEB AUDIO ---

type Automation = [kind: 'set' | 'ramp' | 'target' | 'cancel', value: number, time: number];

class FakeParam {
  events: Automation[] = [];
  constructor(public value: number) {}
  setValueAtTime(value: number, time: number) { this.events.push(['set', value, time]); this.value = value; }
  linearRampToValueAtTime(value: number, time: number) { this.events.push(['ramp', value, time]); this.value = value; }
  setTargetAtTime(value: number, time: number) { this.events.push(['target', value, time]); this.value = value; }
  cancelScheduledValues(time: number) { this.events.push(['cancel', 0, time]); }
}

class FakeNode {
  outputs: FakeNode[] = [];
  readonly gain = new FakeParam(1);
  buffer: unknown = null;
  constructor(readonly context: FakeAudioContext, readonly kind: string, readonly mediaElement?: HTMLMediaElement) {}
  connect(target: FakeNode) { this.outputs.push(target); return target; }
  disconnect(target?: FakeNode) {
    if (!target) {
      this.outputs = [];
      return;
    }
    // Like Web Audio, disconnecting from a node this one does not feed throws.
    if (!this.outputs.includes(target)) throw new DOMException('not connected', 'InvalidAccessError');
    this.outputs = this.outputs.filter(output => output !== target);
  }
}

interface FakeBuffer { numberOfChannels: number; length: number; sampleRate: number; getChannelData(channel: number): Float32Array }

class FakeAudioContext {
  currentTime = 0;
  readonly sampleRate = 8000;
  state: 'running' | 'suspended' = 'running';
  readonly nodes: FakeNode[] = [];
  readonly buffers: FakeBuffer[] = [];
  readonly destination: FakeNode = new FakeNode(this, 'destination');
  private readonly listeners = new Set<() => void>();
  createGain() { return this.add(new FakeNode(this, 'gain')); }
  createConvolver() { return this.add(new FakeNode(this, 'convolver')); }
  createMediaElementSource(element: HTMLMediaElement) { return this.add(new FakeNode(this, 'media', element)); }
  createBuffer(numberOfChannels: number, length: number, sampleRate: number) {
    const data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
    const buffer = {
      numberOfChannels, length, sampleRate,
      getChannelData: (channel: number) => data[channel],
      copyToChannel: (source: Float32Array, channel: number) => data[channel].set(source),
    };
    this.buffers.push(buffer);
    return buffer;
  }
  addEventListener(type: string, listener: () => void) { if (type === 'statechange') this.listeners.add(listener); }
  removeEventListener(type: string, listener: () => void) { if (type === 'statechange') this.listeners.delete(listener); }
  setState(state: 'running' | 'suspended') {
    this.state = state;
    this.listeners.forEach(listener => listener());
  }
  get stateListeners() { return this.listeners.size; }
  of(kind: string) { return this.nodes.filter(node => node.kind === kind); }
  private add(node: FakeNode) {
    this.nodes.push(node);
    return node;
  }
}

const fake = (node: AudioNode) => node as unknown as FakeNode;

const setupAudio = () => {
  const context = new FakeAudioContext();
  const mixer = new AudioMixer(context as unknown as AudioContext);
  services.mixer = mixer;
  return { context, mixer, sfx: fake(mixer.input('sfx')), music: fake(mixer.input('music')), master: fake(mixer.input('master')) };
};

/** Media elements the components played, by play/pause calls on the shared prototype. */
const playing = new Set<HTMLMediaElement>();

const setTiming = (element: HTMLMediaElement, duration: number, currentTime: number) => {
  Object.defineProperty(element, 'duration', { configurable: true, value: duration });
  Object.defineProperty(element, 'currentTime', { configurable: true, writable: true, value: currentTime });
};

// --- SCENE ---

const camera = new THREE.PerspectiveCamera();

/** Runs one frame with the camera at `position`. */
const runFrame = (position: [number, number, number] = [0, 0, 0]) => act(() => {
  camera.position.set(...position);
  for (const callback of [...frame.callbacks]) callback.current({ camera }, 1 / 60);
});

const definition = (type: string) => {
  const found = AUDIO_ZONE_COMPONENTS.find(entry => entry.type === type);
  if (!found) throw new Error(`no ${type} definition`);
  return found;
};

let componentIds = 0;
const component = (type: 'reverbZone' | 'musicPlayer', props: Record<string, unknown> = {}): LevelComponent => ({
  id: `${type}-${++componentIds}`,
  type,
  enabled: true,
  props: { ...Object.fromEntries(definition(type).props.map(prop => [prop.key, structuredClone(prop.default)])), ...props },
});

const OWNER: LevelObject = {
  id: 'owner', levelId: 'level-1', modelId: '', name: 'Owner', type: 'prop',
  position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
};

const ASSETS: AudioData[] = [
  { id: 'a', name: 'Overture', url: 'blob:overture', type: 'audio/ogg', duration: 10 },
  { id: 'b', name: 'Battle', url: 'blob:battle', type: 'audio/ogg', duration: 10 },
  { id: 'c', name: 'Calm', url: 'blob:calm', type: 'audio/ogg', duration: 10 },
];

const content = (audioAssets: AudioData[] = ASSETS): GameContent => ({
  models: [], blueprints: [], attachments: [], sockets: [], textures: [], audioAssets,
});

const Zone: React.FC<{ host: THREE.Object3D; zone: LevelComponent }> = ({ host, zone }) => {
  const hostRef = React.useMemo(() => ({ current: host }), [host]);
  const Render = definition('reverbZone').Render!;
  return (
    <ComponentHostContext.Provider value={hostRef}>
      <Render object={OWNER} component={zone} mode="runtime" />
    </ComponentHostContext.Provider>
  );
};

const MusicPlayers: React.FC<{ players: LevelComponent[] }> = ({ players }) => {
  const Render = definition('musicPlayer').Render!;
  return (
    <GameContentProvider value={content()}>
      {players.map(player => <Render key={player.id} object={OWNER} component={player} mode="runtime" />)}
    </GameContentProvider>
  );
};

beforeEach(() => {
  frame.callbacks.clear();
  playing.clear();
  services.mixer = null;
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    playing.add(this);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    playing.delete(this);
  });
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});

// --- SETTINGS ---

describe('audio zone settings', () => {
  it('declares props whose defaults the readers accept', () => {
    const defaults = (type: string) => Object.fromEntries(definition(type).props.map(prop => [prop.key, prop.default]));
    expect(readReverbZoneSettings({ id: 'z', type: 'reverbZone', enabled: true, props: defaults('reverbZone') })).toEqual(REVERB_ZONE_DEFAULTS);
    expect(readMusicPlayerSettings({ id: 'm', type: 'musicPlayer', enabled: true, props: defaults('musicPlayer') }))
      .toEqual({ ...MUSIC_PLAYER_DEFAULTS, tracks: [] });
    expect(definition('reverbZone').label).toBe('Reverb Zone');
    expect(definition('musicPlayer').label).toBe('Music');
    expect(typeof definition('musicPlayer').Inspector).toBe('function');
    // The inspector owns the track list, so the schema leaves it out.
    expect(definition('musicPlayer').props.map(prop => prop.key)).not.toContain('tracks');
  });

  it('falls back to defaults and clamps out-of-range values', () => {
    expect(readReverbZoneSettings({
      id: 'z', type: 'reverbZone', enabled: true,
      props: { shape: 'cone', size: [0, 5, -1], radius: 'big', preset: 'space', wet: 3, fade: -1 },
    })).toEqual({ ...REVERB_ZONE_DEFAULTS, size: [0.01, 5, 0.01], wet: 1, fade: 0 });
    expect(readMusicPlayerSettings({
      id: 'm', type: 'musicPlayer', enabled: true,
      props: { tracks: 'a', crossfade: 99, volume: -1, loop: 'no' },
    })).toEqual({ ...MUSIC_PLAYER_DEFAULTS, tracks: [], crossfade: 30, volume: 0 });
    expect(readTracks([' a ', '', 3, 'b', 'a'])).toEqual(['a', 'b', 'a']);
  });
});

// --- ZONE WEIGHT ---

describe('zoneWeight', () => {
  const origin = { x: 0, y: 0, z: 0 };
  const box: ReverbZoneVolume = { shape: 'box', center: origin, size: [10, 4, 10], radius: 0, fade: 2 };

  it('rises from 0 at a box edge to 1 at the fade distance inside it', () => {
    expect(zoneWeight(origin, box)).toBe(1);
    expect(zoneWeight({ x: 3, y: 0, z: 0 }, box)).toBe(1);
    expect(zoneWeight({ x: 4, y: 0, z: 0 }, box)).toBeCloseTo(0.5);
    expect(zoneWeight({ x: 0, y: 1.5, z: -2 }, box)).toBeCloseTo(0.25);
    expect(zoneWeight({ x: 5, y: 0, z: 0 }, box)).toBe(0);
    expect(zoneWeight({ x: 6, y: 0, z: 0 }, box)).toBe(0);
    expect(zoneWeight({ x: 0, y: 0, z: Number.NaN }, box)).toBe(0);
  });

  it('keeps the centre at full strength whatever the fade, and a fade of 0 is a hard edge', () => {
    expect(zoneWeight(origin, { ...box, fade: 50 })).toBe(1);
    expect(zoneWeight({ x: 0, y: 1, z: 0 }, { ...box, fade: 50 })).toBeCloseTo(0.5);
    expect(zoneWeight({ x: 4.9, y: 0, z: 0 }, { ...box, fade: 0 })).toBe(1);
  });

  it('measures a box along its own turned axes', () => {
    const turned: ReverbZoneVolume = {
      ...box, size: [20, 4, 2], fade: 0, center: { x: 10, y: 0, z: 0 },
      rotation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2),
    };
    // Turned a quarter around Y, the long local X axis runs along world Z.
    expect(zoneWeight({ x: 10, y: 0, z: 8 }, turned)).toBe(1);
    expect(zoneWeight({ x: 18, y: 0, z: 0 }, turned)).toBe(0);
  });

  it('measures a sphere from its centre', () => {
    const sphere: ReverbZoneVolume = { shape: 'sphere', center: { x: 0, y: 10, z: 0 }, size: [1, 1, 1], radius: 5, fade: 1 };
    expect(zoneWeight({ x: 0, y: 10, z: 0 }, sphere)).toBe(1);
    expect(zoneWeight({ x: 0, y: 14.5, z: 0 }, sphere)).toBeCloseTo(0.5);
    expect(zoneWeight({ x: 3, y: 14, z: 0 }, sphere)).toBe(0);
  });
});

// --- IMPULSE RESPONSES ---

describe('impulse responses', () => {
  const energy = (data: Float32Array, from: number, to: number) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += data[i] * data[i];
    return sum;
  };

  it('generates a decaying, decorrelated stereo tail that is the same every time', () => {
    for (const preset of REVERB_PRESETS) {
      const [left, right] = generateImpulseResponse(preset, 8000);
      expect(right.length).toBe(left.length);
      const tenth = Math.floor(left.length / 10);
      expect(energy(left, 0, tenth)).toBeGreaterThan(100 * energy(left, left.length - tenth, left.length));
      expect(right).not.toEqual(left);
      expect(generateImpulseResponse(preset, 8000)).toEqual([left, right]);
    }
    expect(generateImpulseResponse('outdoors', 8000)[0][0]).toBe(0);
    expect(generateImpulseResponse('cave', 8000)[0].length).toBeGreaterThan(generateImpulseResponse('room', 8000)[0].length);
  });

  it('builds each preset buffer once per context', () => {
    const context = new FakeAudioContext() as unknown as BaseAudioContext;
    const hall = getImpulseResponse(context, 'hall');
    expect(getImpulseResponse(context, 'hall')).toBe(hall);
    expect(getImpulseResponse(context, 'cave')).not.toBe(hall);
    expect((context as unknown as FakeAudioContext).buffers).toHaveLength(2);
    expect(hall.numberOfChannels).toBe(2);
    expect(hall.getChannelData(1)).toEqual(generateImpulseResponse('hall', 8000)[1]);
  });
});

// --- REVERB ZONE ---

describe('reverbZone component', () => {
  it('sends the sfx bus through a convolver into the master bus at the listener depth', () => {
    const { context, mixer, sfx, master } = setupAudio();
    const room = new THREE.Group();
    const hall = new THREE.Group();
    hall.position.set(100, 0, 0);
    const { unmount } = render(
      <>
        <Zone host={room} zone={component('reverbZone', { preset: 'room', wet: 0.5, fade: 2 })} />
        <Zone host={hall} zone={component('reverbZone', { shape: 'sphere', radius: 20, preset: 'hall', wet: 0.8, fade: 5 })} />
      </>,
    );

    const [roomReverb, hallReverb] = context.of('convolver');
    expect(sfx.outputs).toEqual([master, roomReverb, hallReverb]);
    expect(roomReverb.buffer).toBe(getImpulseResponse(context as unknown as BaseAudioContext, 'room'));
    expect(hallReverb.buffer).toBe(getImpulseResponse(context as unknown as BaseAudioContext, 'hall'));
    const [roomReturn] = roomReverb.outputs;
    const [hallReturn] = hallReverb.outputs;
    expect(roomReturn.outputs).toEqual([master]);
    expect(hallReturn.outputs).toEqual([master]);
    expect([roomReturn.gain.value, hallReturn.gain.value]).toEqual([0, 0]);

    runFrame([0, 0, 0]);
    expect([roomReturn.gain.value, hallReturn.gain.value]).toEqual([0.5, 0]);
    runFrame([4, 0, 0]);
    expect(roomReturn.gain.value).toBeCloseTo(0.25);
    runFrame([6, 0, 0]);
    expect([roomReturn.gain.value, hallReturn.gain.value]).toEqual([0, 0]);
    runFrame([100, 0, 0]);
    expect([roomReturn.gain.value, hallReturn.gain.value]).toEqual([0, 0.8]);
    runFrame([117.5, 0, 0]);
    expect(hallReturn.gain.value).toBeCloseTo(0.4);
    expect(roomReturn.gain.events.every(([kind]) => kind === 'target')).toBe(true);

    unmount();
    expect(sfx.outputs).toEqual([master]);
    expect([roomReverb.outputs, hallReverb.outputs, roomReturn.outputs, hallReturn.outputs]).toEqual([[], [], [], []]);
    mixer.dispose();
  });

  it('plays only the strongest of overlapping zones and follows a preset change', () => {
    const { context, sfx, master } = setupAudio();
    const host = new THREE.Group();
    const small = component('reverbZone', { preset: 'room', wet: 0.3 });
    const big = component('reverbZone', { shape: 'sphere', radius: 50, preset: 'cave', wet: 0.6 });
    const { rerender } = render(<><Zone host={host} zone={small} /><Zone host={host} zone={big} /></>);
    const [roomReverb, caveReverb] = context.of('convolver');

    runFrame();
    expect([roomReverb.outputs[0].gain.value, caveReverb.outputs[0].gain.value]).toEqual([0, 0.6]);

    // Both zones on one preset share its return; the room's is closed.
    rerender(<><Zone host={host} zone={{ ...small, props: { ...small.props, preset: 'cave' } }} /><Zone host={host} zone={big} /></>);
    runFrame();
    expect(sfx.outputs).toEqual([master, caveReverb]);
    expect(roomReverb.outputs).toEqual([]);
    expect(caveReverb.outputs[0].gain.value).toBe(0.6);
    expect(context.of('convolver')).toHaveLength(2);
  });

  it('closes quietly after the mixer was disposed first, and does nothing without a mixer', () => {
    const { context, mixer } = setupAudio();
    const { unmount } = render(<Zone host={new THREE.Group()} zone={component('reverbZone')} />);
    mixer.dispose();
    expect(() => unmount()).not.toThrow();
    expect(context.of('convolver')[0].outputs).toEqual([]);

    services.mixer = null;
    render(<Zone host={new THREE.Group()} zone={component('reverbZone')} />);
    runFrame();
    expect(context.of('convolver')).toHaveLength(1);
  });
});

// --- PLAYLIST ORDER ---

describe('nextTrack', () => {
  const ordered = (count: number, loop: boolean) => ({ count, shuffle: false, loop });

  /** Small deterministic generator, so a shuffle test is repeatable. */
  const seeded = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  const playAll = (count: number, loop: boolean, plays: number, random: () => number) => {
    const played: number[] = [];
    let state: MusicQueueState | null = INITIAL_MUSIC_QUEUE;
    for (let i = 0; i < plays; i++) {
      state = nextTrack(state, { count, shuffle: true, loop, random });
      if (!state) break;
      played.push(state.current);
    }
    return played;
  };

  it('steps through the tracks in order, back to the first when looping', () => {
    let state = nextTrack(INITIAL_MUSIC_QUEUE, ordered(3, false))!;
    expect(state.current).toBe(0);
    state = nextTrack(state, ordered(3, false))!;
    state = nextTrack(state, ordered(3, false))!;
    expect(state.current).toBe(2);
    expect(nextTrack(state, ordered(3, false))).toBeNull();
    expect(nextTrack(state, ordered(3, true))).toEqual({ current: 0, upcoming: [] });
    expect(nextTrack({ current: 5, upcoming: [] }, ordered(2, true))).toEqual({ current: 0, upcoming: [] });
    expect(nextTrack(INITIAL_MUSIC_QUEUE, ordered(0, true))).toBeNull();
  });

  it('shuffles every track once per pass and never repeats one across passes', () => {
    const played = playAll(4, true, 40, seeded(7));
    expect(played).toHaveLength(40);
    for (let pass = 0; pass < 10; pass++) {
      expect(played.slice(pass * 4, pass * 4 + 4).sort()).toEqual([0, 1, 2, 3]);
    }
    expect(played.every((track, i) => i === 0 || track !== played[i - 1])).toBe(true);
    expect(playAll(3, false, 10, seeded(3)).sort()).toEqual([0, 1, 2]);
  });

  it('moves a repeat away from the start of a new pass, unless it is the only track', () => {
    const high = () => 0.999;
    expect(nextTrack({ current: 0, upcoming: [] }, { count: 4, shuffle: true, loop: true, random: high }))
      .toEqual({ current: 3, upcoming: [1, 2, 0] });
    expect(nextTrack({ current: 0, upcoming: [] }, { count: 1, shuffle: true, loop: true, random: high }))
      .toEqual({ current: 0, upcoming: [] });
    expect(nextTrack({ current: 1, upcoming: [7, 2] }, { count: 3, shuffle: true, loop: false })).toEqual({ current: 2, upcoming: [] });
  });
});

// --- MUSIC ---

describe('musicPlayer component', () => {
  const media = (context: FakeAudioContext) => context.of('media');
  const element = (node: FakeNode) => node.mediaElement!;

  it('streams the first track on the music bus and crossfades into the next near its end', () => {
    const { context, music } = setupAudio();
    render(<MusicPlayers players={[component('musicPlayer', { tracks: ['a', 'b'], crossfade: 2 })]} />);

    const [first] = media(context);
    expect(media(context)).toHaveLength(1);
    expect(element(first).getAttribute('src')).toBe('blob:overture');
    expect(playing.has(element(first))).toBe(true);
    const [firstGain] = first.outputs;
    const [output] = firstGain.outputs;
    expect(output.outputs).toEqual([music]);
    expect(firstGain.gain.events).toEqual([['set', 1, 0]]);

    setTiming(element(first), 10, 5);
    runFrame();
    expect(media(context)).toHaveLength(1);

    context.currentTime = 3;
    setTiming(element(first), 10, 8.5);
    runFrame();
    const second = media(context)[1];
    expect(element(second).getAttribute('src')).toBe('blob:battle');
    expect(playing.has(element(second))).toBe(true);
    const [secondGain] = second.outputs;
    expect(secondGain.outputs).toEqual([output]);
    expect(secondGain.gain.events).toEqual([['set', 0, 3], ['ramp', 1, 5]]);
    expect(firstGain.gain.events.slice(1)).toEqual([['cancel', 0, 3], ['set', 1, 3], ['ramp', 0, 5]]);

    context.currentTime = 4.9;
    runFrame();
    expect(playing.has(element(first))).toBe(true);
    context.currentTime = 5;
    runFrame();
    expect(playing.has(element(first))).toBe(false);
    expect(element(first).hasAttribute('src')).toBe(false);
    expect([first.outputs, firstGain.outputs]).toEqual([[], []]);
    expect(playing.has(element(second))).toBe(true);
    expect(media(context)).toHaveLength(2);
  });

  it('stops every track and frees the graph when the session ends mid-crossfade', () => {
    const { context, music, master } = setupAudio();
    const { unmount } = render(<MusicPlayers players={[component('musicPlayer', { tracks: ['a', 'b'], crossfade: 2 })]} />);
    const [first] = media(context);
    const output = first.outputs[0].outputs[0];
    setTiming(element(first), 10, 9);
    runFrame();
    const voices = media(context);
    const gains = voices.map(voice => voice.outputs[0]);
    expect(voices).toHaveLength(2);
    expect(gains.map(gain => gain.outputs)).toEqual([[output], [output]]);
    expect(context.stateListeners).toBe(1);

    unmount();
    for (const voice of voices) {
      expect(playing.has(element(voice))).toBe(false);
      expect(element(voice).hasAttribute('src')).toBe(false);
      expect(voice.outputs).toEqual([]);
    }
    expect(gains.map(gain => gain.outputs)).toEqual([[], []]);
    expect(output.outputs).toEqual([]);
    expect(music.outputs).toEqual([master]);
    expect(context.stateListeners).toBe(0);
    expect(musicPlayback.isPlaying()).toBe(false);
    expect(musicPlayback.play()).toBe(false);

    act(() => { element(voices[1]).dispatchEvent(new Event('ended')); });
    expect(media(context)).toHaveLength(2);
  });

  it('plays only the first mounted Music component and hands the music over when it leaves', () => {
    const { context } = setupAudio();
    const first = component('musicPlayer', { tracks: ['a'] });
    const second = component('musicPlayer', { tracks: ['b'] });
    const { rerender } = render(<MusicPlayers players={[first, second]} />);
    expect(media(context).map(node => element(node).getAttribute('src'))).toEqual(['blob:overture']);
    expect(musicPlayback.isPlaying()).toBe(true);

    rerender(<MusicPlayers players={[second]} />);
    const [old, current] = media(context);
    expect(playing.has(element(old))).toBe(false);
    expect(element(current).getAttribute('src')).toBe('blob:battle');
    expect(playing.has(element(current))).toBe(true);
  });

  it('cuts to the next track when one ends without a crossfade, and stops after the last unless looping', () => {
    const { context } = setupAudio();
    render(<MusicPlayers players={[component('musicPlayer', { tracks: ['a', 'b'], crossfade: 0, loop: false })]} />);
    const [first] = media(context);
    setTiming(element(first), 10, 9.99);
    runFrame();
    expect(media(context)).toHaveLength(1);

    context.currentTime = 10;
    act(() => { element(first).dispatchEvent(new Event('ended')); });
    const second = media(context)[1];
    expect(element(second).getAttribute('src')).toBe('blob:battle');
    expect(second.outputs[0].gain.events).toEqual([['set', 1, 10]]);
    expect(first.outputs).toEqual([]);

    act(() => { element(second).dispatchEvent(new Event('ended')); });
    expect(media(context)).toHaveLength(2);
    expect(musicPlayback.isPlaying()).toBe(false);

    // Played again after the end, the playlist starts over.
    act(() => { expect(musicPlayback.play()).toBe(true); });
    expect(element(media(context)[2]).getAttribute('src')).toBe('blob:overture');
    expect(musicPlayback.isPlaying()).toBe(true);
  });

  it('pauses with the audio context and resumes with it', () => {
    const { context } = setupAudio();
    render(<MusicPlayers players={[component('musicPlayer', { tracks: ['a', 'b'] })]} />);
    const [first] = media(context);

    act(() => context.setState('suspended'));
    expect(playing.has(element(first))).toBe(false);
    setTiming(element(first), 10, 9.5);
    runFrame();
    expect(media(context)).toHaveLength(1);

    act(() => context.setState('running'));
    expect(playing.has(element(first))).toBe(true);
    runFrame();
    expect(media(context)).toHaveLength(2);
  });

  it('waits for musicPlayback when Play on Start is off, then plays, skips and stops', () => {
    const { context } = setupAudio();
    render(<MusicPlayers players={[component('musicPlayer', { tracks: ['a', 'b', 'c'], playOnStart: false, crossfade: 1 })]} />);
    expect(media(context)).toHaveLength(0);
    expect(musicPlayback.isPlaying()).toBe(false);

    act(() => { expect(musicPlayback.play()).toBe(true); });
    const [first] = media(context);
    expect(element(first).getAttribute('src')).toBe('blob:overture');

    context.currentTime = 2;
    act(() => { musicPlayback.next(); });
    const second = media(context)[1];
    expect(element(second).getAttribute('src')).toBe('blob:battle');
    expect(first.outputs[0].gain.events.at(-1)).toEqual(['ramp', 0, 3]);

    act(() => { musicPlayback.stop(); });
    expect(musicPlayback.isPlaying()).toBe(false);
    expect(second.outputs[0].gain.events.at(-1)).toEqual(['ramp', 0, 3]);

    context.currentTime = 3;
    runFrame();
    expect([playing.has(element(first)), playing.has(element(second))]).toEqual([false, false]);
    expect(media(context)).toHaveLength(2);
  });

  it('skips tracks no asset matches, follows the volume, and gives up once every track has failed', () => {
    const { context, music } = setupAudio();
    const player = component('musicPlayer', { tracks: ['gone', 'Battle'] });
    const { rerender } = render(<MusicPlayers players={[player]} />);
    const [first] = media(context);
    expect(element(first).getAttribute('src')).toBe('blob:battle');
    const output = first.outputs[0].outputs[0];
    expect(output.outputs).toEqual([music]);
    expect(output.gain.value).toBe(1);

    rerender(<MusicPlayers players={[{ ...player, props: { ...player.props, volume: 0.5 } }]} />);
    expect(output.gain.events.at(-1)).toEqual(['target', 0.5, 0]);

    act(() => { element(first).dispatchEvent(new Event('error')); });
    const retry = media(context)[1];
    expect(element(retry).getAttribute('src')).toBe('blob:battle');
    act(() => { element(retry).dispatchEvent(new Event('error')); });
    expect(media(context)).toHaveLength(2);
    expect(musicPlayback.isPlaying()).toBe(false);
  });
});

// --- MUSIC INSPECTOR ---

describe('Music inspector', () => {
  const renderInspector = (tracks: string[], audioAssets: AudioData[] = ASSETS) => {
    const onChangeProps = vi.fn();
    const Inspector = definition('musicPlayer').Inspector!;
    render(
      <GameContentProvider value={content(audioAssets)}>
        <Inspector object={OWNER} component={component('musicPlayer', { tracks })} onChangeProps={onChangeProps} />
      </GameContentProvider>,
    );
    return onChangeProps;
  };

  it('lists the playlist in order and reorders, removes and appends tracks', () => {
    const onChangeProps = renderInspector(['b', 'gone', 'a']);
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual(['1Battle', '2Missing: gone', '3Overture']);
    expect(screen.getByRole('button', { name: 'Move Battle up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Overture down' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Move Battle down' }));
    expect(onChangeProps).toHaveBeenLastCalledWith({ tracks: ['gone', 'b', 'a'] });
    fireEvent.click(screen.getByRole('button', { name: 'Move Overture up' }));
    expect(onChangeProps).toHaveBeenLastCalledWith({ tracks: ['b', 'a', 'gone'] });
    fireEvent.click(screen.getByRole('button', { name: 'Remove gone' }));
    expect(onChangeProps).toHaveBeenLastCalledWith({ tracks: ['b', 'a'] });
    fireEvent.change(screen.getByRole('combobox', { name: 'Add track' }), { target: { value: 'c' } });
    expect(onChangeProps).toHaveBeenLastCalledWith({ tracks: ['b', 'gone', 'a', 'c'] });
    expect(onChangeProps).toHaveBeenCalledTimes(4);
  });

  it('explains an empty playlist and a project without audio', () => {
    renderInspector([], []);
    expect(screen.getByText(/No tracks/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Add track' })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'No audio assets in the project' })).toBeInTheDocument();
  });
});
