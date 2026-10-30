import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createCinematics } from '../../runtime/cinematics';
import { clipWeight, crossedTimelineSounds, evaluateTimeline, normalizeTimeline, timelineTargetIds } from '../../runtime/timeline/evaluate';
import { ClipPoser, clipTime, findTimelineClip, poseLayers } from '../../runtime/timeline/poser';
import { TIMELINE_PLAYER_TARGET, type TimelineClipValue } from '../../runtime/timeline/types';

/*
 * Cinematic timelines: clip, sound, subtitle and fade tracks (cleaning, sampling, sounds started as
 * playback passes them), the clip poser that lays clips over a character's own pose, and the store the
 * overlay reads.
 */

const clipKey = (time: number, value: Partial<TimelineClipValue>) => ({
  time, value: { clip: 'Walk', length: 2, offset: 0, speed: 1, loop: true, blendIn: 0, blendOut: 0, ...value },
});

describe('cinematic tracks', () => {
  it('are cleaned: values defaulted and clamped, malformed keys dropped', () => {
    const data = normalizeTimeline({
      duration: 10,
      tracks: [
        { id: 'a', kind: 'animation', objectId: 'hero', keys: [{ time: 1, value: { clip: 'Walk', length: -3, speed: 99 } }, { time: 2, value: { length: 4 } }] },
        { id: 's', kind: 'audio', objectId: 3, bus: 'radio', keys: [{ time: 0, value: { sound: 'theme', volume: 9 } }] },
        { id: 'l', kind: 'subtitle', keys: [{ time: 1, value: { text: 'Hello', length: 2 } }, { time: 2, value: { speaker: 'X' } }] },
        { id: 'f', kind: 'fade', color: 'red', keys: [{ time: 0, value: 4 }, { time: 1, value: -1 }] },
      ],
    });
    const [animation, audio, subtitle, fade] = data.tracks;
    expect(animation).toMatchObject({ kind: 'animation', objectId: 'hero' });
    expect(animation.kind === 'animation' && animation.keys).toEqual([
      { time: 1, value: { clip: 'Walk', length: 0.05, offset: 0, speed: 10, loop: true, blendIn: 0.25, blendOut: 0.25 } },
    ]);
    expect(audio).toMatchObject({ kind: 'audio', objectId: '', bus: 'sfx' });
    expect(audio.kind === 'audio' && audio.keys[0].value).toEqual({ sound: 'theme', length: 5, volume: 2 });
    expect(subtitle.kind === 'subtitle' && subtitle.keys).toEqual([{ time: 1, value: { speaker: '', text: 'Hello', length: 2 } }]);
    expect(fade).toMatchObject({ kind: 'fade', color: '#000000' });
    expect(fade.kind === 'fade' && fade.keys.map(key => key.value)).toEqual([1, 0]);
  });

  it('weigh a clip in and out over its blends, smoothly', () => {
    const value: TimelineClipValue = { clip: 'Walk', length: 4, offset: 0, speed: 1, loop: true, blendIn: 1, blendOut: 2 };
    expect(clipWeight(value, -0.1)).toBe(0);
    expect(clipWeight(value, 0)).toBe(0);
    expect(clipWeight(value, 0.5)).toBeCloseTo(0.5, 6);
    expect(clipWeight(value, 1.5)).toBe(1);
    expect(clipWeight(value, 3)).toBeCloseTo(0.5, 6);
    expect(clipWeight(value, 4)).toBe(0);
    expect(clipWeight(value, 4.1)).toBe(0);
    expect(clipWeight({ ...value, blendIn: 0, blendOut: 0 }, 0)).toBe(1);
  });

  it("sample each character's clips together, crossfading where they overlap", () => {
    const data = normalizeTimeline({
      duration: 10,
      tracks: [
        { id: 'a', kind: 'animation', objectId: 'hero', keys: [clipKey(0, { clip: 'Walk', length: 3, blendOut: 1 }), clipKey(2, { clip: 'Idle', length: 3, blendIn: 1, offset: 0.5, speed: 2 })] },
        { id: 'b', kind: 'animation', objectId: 'hero', keys: [clipKey(2.5, { clip: 'Wave', length: 1 })] },
        { id: 'c', kind: 'animation', objectId: '', keys: [clipKey(0, { clip: 'Idle' })] },
      ],
    });
    const { animations } = evaluateTimeline(data, 2.5);
    expect(animations).toHaveLength(1);
    expect(animations[0].objectId).toBe('hero');
    expect(animations[0].clips).toEqual([
      { clip: 'Walk', time: 2.5, weight: 0.5, loop: true },
      { clip: 'Idle', time: 0.5 + 0.5 * 2, weight: 0.5, loop: true },
      { clip: 'Wave', time: 0, weight: 1, loop: true },
    ]);
    expect(evaluateTimeline(data, 6).animations).toEqual([]);
  });

  it('show the subtitle that started last and the fade of the last fade track', () => {
    const data = normalizeTimeline({
      duration: 10,
      tracks: [
        { id: 'l', kind: 'subtitle', keys: [{ time: 1, value: { speaker: ' Hero ', text: ' Stop. ', length: 3 } }, { time: 2, value: { speaker: '', text: 'Run!', length: 1 } }] },
        { id: 'f', kind: 'fade', color: '#ffffff', keys: [{ time: 0, value: 1 }, { time: 2, value: 0 }] },
      ],
    });
    expect(evaluateTimeline(data, 1.5).subtitle).toEqual({ speaker: 'Hero', text: 'Stop.', trackId: 'l', at: 1000 });
    expect(evaluateTimeline(data, 2.5).subtitle).toEqual({ speaker: '', text: 'Run!', trackId: 'l', at: 2000 });
    // The second line is over; the first, still on, shows again.
    expect(evaluateTimeline(data, 3.5).subtitle?.text).toBe('Stop.');
    expect(evaluateTimeline(data, 4.5).subtitle).toBeUndefined();
    expect(evaluateTimeline(data, 1).fade).toEqual({ amount: 0.5, color: '#ffffff' });
  });

  it('start sounds as playback passes them, late ones part-way through, and drop those already over', () => {
    const data = normalizeTimeline({
      duration: 10,
      tracks: [{ id: 's', kind: 'audio', objectId: 'radio', bus: 'music', keys: [
        { time: 1, value: { sound: 'theme', length: 4, volume: 0.5 } },
        { time: 9.5, value: { sound: 'sting', length: 2, volume: 1 } },
        { time: 2, value: { sound: '  ', length: 1, volume: 1 } },
      ] }],
    });
    expect(crossedTimelineSounds(data, -1, 0, false)).toEqual([]);
    expect(crossedTimelineSounds(data, 0.9, 1.2, false)).toEqual([
      { trackId: 's', objectId: 'radio', bus: 'music', sound: 'theme', volume: 0.5, from: expect.closeTo(0.2, 6), until: 5 },
    ]);
    // Wrapping round a loop: the sting started before the loop point, so it comes first.
    const wrapped = crossedTimelineSounds(data, 9.4, 1.1, true);
    expect(wrapped.map(start => start.sound)).toEqual(['sting', 'theme']);
    expect(wrapped[0].from).toBeCloseTo(1.6, 6);
    expect(wrapped[0].until).toBeCloseTo(1.5, 6);
    // A start passed so long ago that the sound is over is left out.
    expect(crossedTimelineSounds(data, 0, 6, false)).toEqual([]);
  });

  it('name the objects they drive, not the player', () => {
    const data = normalizeTimeline({
      duration: 5,
      tracks: [
        { id: 'a', kind: 'animation', objectId: 'hero', keys: [] },
        { id: 'b', kind: 'animation', objectId: TIMELINE_PLAYER_TARGET, keys: [] },
        { id: 'c', kind: 'audio', objectId: 'radio', bus: 'sfx', keys: [] },
        { id: 'd', kind: 'audio', objectId: '', bus: 'sfx', keys: [] },
        { id: 'e', kind: 'animation', objectId: 'muted', muted: true, keys: [] },
      ],
    });
    expect(timelineTargetIds(data)).toEqual(['hero', 'radio']);
  });
});

/** A spine bone under a root, and clips turning it about Y. */
const rig = () => {
  const root = new THREE.Group();
  const spine = new THREE.Bone();
  spine.name = 'mixamorigSpine';
  root.add(spine);
  const turn = (name: string, degrees: number, length = 2) => new THREE.AnimationClip(name, length, [
    new THREE.QuaternionKeyframeTrack('mixamorigSpine.quaternion', [0, length],
      [...new THREE.Quaternion().toArray(), ...new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(degrees)).toArray()]),
    new THREE.VectorKeyframeTrack('mixamorigSpine.position', [0, length], [0, 0, 0, 0, length, 0]),
    new THREE.VectorKeyframeTrack('missingBone.position', [0], [1, 1, 1]),
  ]);
  return { root, spine, turn };
};

const yawOf = (bone: THREE.Object3D) => THREE.MathUtils.radToDeg(new THREE.Euler().setFromQuaternion(bone.quaternion, 'YXZ').y);

describe('clip poser', () => {
  it("poses from a clip at any time, over the bone's own pose by the clip's weight", () => {
    const { root, spine, turn } = rig();
    const poser = new ClipPoser(root);
    const clip = turn('Turn', 90);
    expect(poser.nodes([{ clip, time: 0, weight: 1, loop: false }])).toEqual([spine]);

    expect(poser.apply([{ clip, time: 2, weight: 1, loop: false }])).toBe(1);
    expect(yawOf(spine)).toBeCloseTo(90, 4);
    expect(spine.position.y).toBeCloseTo(2, 6);
    // Scrubbing back is the same as playing there.
    spine.quaternion.identity();
    spine.position.set(0, 0, 0);
    poser.apply([{ clip, time: 1, weight: 1, loop: false }]);
    expect(yawOf(spine)).toBeCloseTo(45, 4);
    // Half weight: halfway from the pose the bone has.
    spine.quaternion.identity();
    expect(poser.apply([{ clip, time: 2, weight: 0.5, loop: false }])).toBe(0.5);
    expect(yawOf(spine)).toBeCloseTo(45, 4);
    // No weight changes nothing.
    spine.quaternion.identity();
    expect(poser.apply([{ clip, time: 2, weight: 0, loop: false }])).toBe(0);
    expect(yawOf(spine)).toBeCloseTo(0, 6);
  });

  it('averages clips that crossfade by their weights', () => {
    const { root, spine, turn } = rig();
    const poser = new ClipPoser(root);
    const left = turn('Left', 90);
    const right = turn('Right', -30);
    poser.apply([{ clip: left, time: 2, weight: 0.25, loop: false }, { clip: right, time: 2, weight: 0.75, loop: false }]);
    expect(yawOf(spine)).toBeCloseTo(0, 3);
  });

  it('wraps a looping clip and holds one that does not, and finds clips by their short names', () => {
    const { turn } = rig();
    const clip = turn('Armature|Walk', 0);
    expect(clipTime(clip, 5, true)).toBeCloseTo(1, 6);
    expect(clipTime(clip, -0.5, true)).toBeCloseTo(1.5, 6);
    expect(clipTime(clip, 5, false)).toBe(2);
    expect(findTimelineClip([clip], 'walk')).toBe(clip);
    expect(poseLayers([clip], [{ clip: 'Walk', time: 1, weight: 1, loop: true }, { clip: 'Run', time: 1, weight: 1, loop: true }]))
      .toEqual([{ clip, time: 1, weight: 1, loop: true }]);
  });
});

describe('cinematics store', () => {
  const entry = (change: Partial<Parameters<ReturnType<typeof createCinematics>['set']>[1] & object> = {}) => ({
    cinematic: false, skippable: false, fade: null, subtitle: null, ...change,
  });

  it("puts every timeline's part together", () => {
    const store = createCinematics();
    let changes = 0;
    store.subscribe(() => changes++);
    store.set('a', entry({ cinematic: true, fade: { amount: 0.2, color: '#000000' }, subtitle: { speaker: '', text: 'One', key: 'k1' } }));
    store.set('b', entry({ fade: { amount: 0.7, color: '#ffffff' } }));
    expect(store.state()).toEqual({ active: true, skippable: false, fade: { amount: 0.7, color: '#ffffff' }, subtitle: { speaker: '', text: 'One', key: 'k1' } });
    // The newest line shows; the same values again change nothing.
    store.set('b', entry({ fade: { amount: 0.7, color: '#ffffff' }, subtitle: { speaker: 'B', text: 'Two', key: 'k2' } }));
    expect(store.state().subtitle?.text).toBe('Two');
    const before = changes;
    store.set('b', entry({ fade: { amount: 0.7, color: '#ffffff' }, subtitle: { speaker: 'B', text: 'Two', key: 'k2' } }));
    expect(changes).toBe(before);
    store.set('b', null);
    store.set('a', entry({ cinematic: true, skippable: true }));
    expect(store.state()).toEqual({ active: true, skippable: true, fade: null, subtitle: null });
    store.clear();
    expect(store.state().active).toBe(false);
  });

  it('counts skips for cinematics to compare against', () => {
    const store = createCinematics();
    expect(store.skipCount()).toBe(0);
    store.skip();
    store.skip();
    expect(store.skipCount()).toBe(2);
  });
});
