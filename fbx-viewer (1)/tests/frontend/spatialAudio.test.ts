import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  MAX_SPATIAL_RAMP, SPATIAL_SNAP_AFTER, SpatialAudioListener, SpatialParamWriter, SpatialPositionalAudio,
} from '../../runtime/spatialAudio';

type Call = [string, number, number?];

/** An AudioParam that records what is scheduled on it. */
const fakeParam = () => {
  const calls: Call[] = [];
  return {
    calls,
    setValueAtTime(value: number, time: number) { calls.push(['set', value, time]); },
    linearRampToValueAtTime(value: number, time: number) { calls.push(['ramp', value, time]); },
    cancelScheduledValues(time: number) { calls.push(['cancel', time]); },
  };
};
type FakeParam = ReturnType<typeof fakeParam>;

const fakeNode = (context: unknown) => ({ context, gain: fakeParam(), connect() {}, disconnect() {} });

/** Just enough of an AudioContext for the listener and positional sounds, its params recorded. */
const fakeContext = (state: AudioContextState) => {
  const listener = {
    positionX: fakeParam(), positionY: fakeParam(), positionZ: fakeParam(),
    forwardX: fakeParam(), forwardY: fakeParam(), forwardZ: fakeParam(),
    upX: fakeParam(), upY: fakeParam(), upZ: fakeParam(),
  };
  const fakePanner = () => ({
    positionX: fakeParam(), positionY: fakeParam(), positionZ: fakeParam(),
    orientationX: fakeParam(), orientationY: fakeParam(), orientationZ: fakeParam(),
    panningModel: 'equalpower', connect() {}, disconnect() {},
  });
  const panners: ReturnType<typeof fakePanner>[] = [];
  const context = {
    state,
    currentTime: 0,
    destination: {},
    listener,
    createGain() { return fakeNode(context); },
    createPanner() {
      const panner = fakePanner();
      panners.push(panner);
      return panner;
    },
  };
  THREE.AudioContext.setContext(context as unknown as AudioContext);
  return { context, listener, panners };
};

const scheduled = (params: Record<string, unknown>) =>
  Object.values(params).reduce<number>((sum, param) => sum + ((param as FakeParam).calls?.length ?? 0), 0);

afterEach(() => {
  THREE.AudioContext.setContext(undefined as unknown as AudioContext);
});

describe('spatial param writer', () => {
  const setup = () => {
    const params = [fakeParam(), fakeParam()];
    const context = { state: 'running' as AudioContextState, currentTime: 1 };
    return { params, context, writer: new SpatialParamWriter(params) };
  };

  it('schedules nothing while the context is not running', () => {
    const { params, context, writer } = setup();
    context.state = 'suspended';
    for (let i = 0; i < 1000; i++) expect(writer.write(context, [i, -i])).toBe(0);
    context.state = 'closed';
    expect(writer.write(context, [1, 2])).toBe(0);
    expect(params.every(param => param.calls.length === 0)).toBe(true);
  });

  it('snaps on its first write, then schedules only the params that changed', () => {
    const { params, context, writer } = setup();
    expect(writer.write(context, [3, 4])).toBe(2);
    expect(params[0].calls).toEqual([['cancel', 1], ['set', 3, 1]]);
    for (let i = 0; i < 50; i++) expect(writer.write(context, [3, 4])).toBe(0);
    context.currentTime = 1.016;
    expect(writer.write(context, [3, 5])).toBe(1);
    expect(params[0].calls).toHaveLength(2);
    // The snap ended at 1, so the glide holds 4 until now and then ramps over about a frame.
    expect(params[1].calls.slice(2)).toEqual([['set', 4, 1.016], ['ramp', 5, expect.closeTo(1.032, 6)]]);
  });

  it('glides on from a ramp still in flight without going back in time', () => {
    const { params, context, writer } = setup();
    writer.write(context, [0, 0]);
    context.currentTime = 1.05;
    writer.write(context, [1, 0]);
    const firstEnd = params[0].calls.at(-1)![2]!;
    expect(firstEnd).toBeCloseTo(1.05 + MAX_SPATIAL_RAMP, 6);
    context.currentTime = 1.051;
    writer.write(context, [2, 0]);
    const last = params[0].calls.at(-1)!;
    expect(last[0]).toBe('ramp');
    expect(last[2]).toBeGreaterThanOrEqual(firstEnd);
    expect(params[0].calls.filter(call => call[0] === 'set')).toHaveLength(2);
  });

  it('snaps again after the context resumes, dropping ramps left from before', () => {
    const { params, context, writer } = setup();
    writer.write(context, [0, 0]);
    context.currentTime = 1.02;
    writer.write(context, [1, 1]);
    context.state = 'suspended';
    writer.write(context, [5, 5]);
    context.state = 'running';
    // Even an unchanged pose is rewritten: a ramp from before the suspend may still be pending.
    expect(writer.write(context, [1, 1])).toBe(2);
    expect(params[0].calls.slice(-2)).toEqual([['cancel', 1.02], ['set', 1, 1.02]]);
  });

  it('snaps after a long still spell instead of gliding across it', () => {
    const { params, context, writer } = setup();
    writer.write(context, [0, 0]);
    context.currentTime = 1 + SPATIAL_SNAP_AFTER + 1;
    writer.write(context, [1, 0]);
    expect(params[0].calls.slice(-2)).toEqual([['cancel', context.currentTime], ['set', 1, context.currentTime]]);
  });
});

describe('spatial audio listener', () => {
  it('schedules nothing on a suspended context however often the camera updates (the overnight leak)', () => {
    const { listener } = fakeContext('suspended');
    const camera = new THREE.PerspectiveCamera();
    camera.add(new SpatialAudioListener());
    for (let frame = 0; frame < 2000; frame++) {
      camera.position.set(Math.sin(frame), 1, frame * 0.01);
      camera.rotation.y = frame * 0.01;
      // three updates a camera's matrices several times a frame.
      camera.updateMatrixWorld();
      camera.updateMatrixWorld();
    }
    expect(scheduled(listener)).toBe(0);
  });

  it('writes the pose once for a still camera, then only what moves', () => {
    const { context, listener } = fakeContext('running');
    const camera = new THREE.PerspectiveCamera();
    camera.add(new SpatialAudioListener());
    camera.position.set(1, 2, 3);
    for (let i = 0; i < 100; i++) camera.updateMatrixWorld();
    expect(listener.positionX.calls).toEqual([['cancel', 0], ['set', 1, 0]]);
    expect(scheduled(listener)).toBe(18);
    context.currentTime = 0.02;
    camera.position.x = 2;
    camera.updateMatrixWorld();
    expect(listener.positionX.calls.at(-1)).toEqual(['ramp', 2, expect.any(Number)]);
    expect(listener.positionY.calls).toHaveLength(2);
    expect(listener.forwardX.calls).toHaveLength(2);
  });

  it('faces the way the camera looks, its up turning with the camera', () => {
    const { listener } = fakeContext('running');
    const camera = new THREE.PerspectiveCamera();
    camera.add(new SpatialAudioListener());
    camera.rotation.set(0, Math.PI / 2, Math.PI / 2, 'YXZ');
    camera.updateMatrixWorld();
    const last = (param: FakeParam) => param.calls.at(-1)![1];
    const forward = new THREE.Vector3(0, 0, -1).applyEuler(camera.rotation);
    const up = new THREE.Vector3(0, 1, 0).applyEuler(camera.rotation);
    expect([last(listener.forwardX), last(listener.forwardY), last(listener.forwardZ)].map(v => +v.toFixed(5))).toEqual(forward.toArray().map(v => +v.toFixed(5)));
    expect([last(listener.upX), last(listener.upY), last(listener.upZ)].map(v => +v.toFixed(5))).toEqual(up.toArray().map(v => +v.toFixed(5)));
    expect(Math.abs(last(listener.upY))).toBeLessThan(1e-6);
  });
});

describe('spatial positional audio', () => {
  it('places a playing sound only while the context runs, and only when it moves', () => {
    const { context, panners } = fakeContext('suspended');
    const sound = new SpatialPositionalAudio(new SpatialAudioListener());
    const panner = panners[0];
    (sound as { isPlaying: boolean }).isPlaying = true;
    sound.position.set(4, 0, 0);
    for (let i = 0; i < 500; i++) sound.updateMatrixWorld();
    expect(scheduled(panner)).toBe(0);
    context.state = 'running';
    sound.updateMatrixWorld();
    sound.updateMatrixWorld();
    expect(panner.positionX.calls).toEqual([['cancel', 0], ['set', 4, 0]]);
    expect(scheduled(panner)).toBe(12);
  });

  it('leaves a stopped sound alone', () => {
    const { panners } = fakeContext('running');
    const sound = new SpatialPositionalAudio(new SpatialAudioListener());
    sound.position.set(1, 1, 1);
    sound.updateMatrixWorld();
    expect(scheduled(panners[0])).toBe(0);
  });
});

describe('engine audio sources', () => {
  it('make their listeners and positional sounds from the engine classes, never three’s own', () => {
    const root = path.resolve(__dirname, '../..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!['node_modules', 'tests', 'dist', 'editor-dist', '.auvra-launcher'].includes(entry.name) && !entry.name.startsWith('.')) walk(path.join(dir, entry.name));
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          const file = path.join(dir, entry.name);
          if (/new\s+THREE\.(AudioListener|PositionalAudio)\s*\(/.test(readFileSync(file, 'utf8'))) offenders.push(path.relative(root, file));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
