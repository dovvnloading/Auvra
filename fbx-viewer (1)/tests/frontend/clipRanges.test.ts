import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  carriedClipNames,
  clipLoops,
  clipRange,
  clipTake,
  cutAttachedClips,
  cutClip,
  cutModelTakes,
  frameOfTime,
  importerOptions,
  noteClipTake,
  resolveClipRanges,
  rootTravel,
  timeOfFrame,
  wholeClips,
  withoutClipRanges,
} from '../../utils/clipRanges';
import { applyStoredClipNames } from '../../utils/animationBinding';
import { nameAnimations } from '../../utils/modelLoader';
import { convertOptionsFor, resolveImportSettings } from '../../utils/processing/ModelTransforms';
import type { ClipRange } from '../../types';

const take = (name = 'Take 001', seconds = 4): THREE.AnimationClip => {
  // The arm turns evenly about Y, and the hips walk a metre a second along Z at a height of 1.
  const times: number[] = [];
  const turn: number[] = [];
  const walk: number[] = [];
  const quaternion = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (let key = 0; key <= seconds * 2; key += 1) {
    const time = key / 2;
    times.push(time);
    turn.push(...quaternion.setFromAxisAngle(up, time * 0.5).toArray());
    walk.push(0, 1, time);
  }
  const clip = new THREE.AnimationClip(name, -1, [
    new THREE.QuaternionKeyframeTrack('Arm.quaternion', times, turn),
    new THREE.VectorKeyframeTrack('Hips.position', times, walk),
    // Held the whole way: one key.
    new THREE.VectorKeyframeTrack('Head.scale', [0], [2, 2, 2]),
    new THREE.NumberKeyframeTrack('Face.morphTargetInfluences', [0, seconds], [0, 1, 1, 0]),
  ]);
  noteClipTake(clip, name, 0, 30);
  return clip;
};

const range = (values: Partial<ClipRange> = {}): ClipRange => ({ take: 'Take 001', name: 'Part', start: 1.25, end: 2.75, loop: true, ...values });

const rig = (): THREE.Group => {
  const root = new THREE.Group();
  const hips = new THREE.Bone();
  hips.name = 'Hips';
  root.add(hips);
  return root;
};

const trackOf = (clip: THREE.AnimationClip, name: string): THREE.KeyframeTrack => clip.tracks.find((track) => track.name === name)!;

/** What `track` says at `time`, by how the mixer reads it. */
const valueAt = (track: THREE.KeyframeTrack, time: number): number[] =>
  Array.from((track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant().evaluate(time) as ArrayLike<number>);

describe('cutting a clip from a take', () => {
  it('lasts as long as its range, whatever keys fall inside it', () => {
    const clip = cutClip(take(), range())!;
    expect(clip.name).toBe('Part');
    expect(clip.duration).toBeCloseTo(1.5, 6);
    expect(trackOf(clip, 'Arm.quaternion').times[0]).toBe(0);
    expect(trackOf(clip, 'Arm.quaternion').times.at(-1)).toBeCloseTo(1.5, 6);
  });

  it('holds at every moment the pose the take has there, between keys as well as on them', () => {
    const whole = take();
    const clip = cutClip(whole, range({ recentre: false }))!;
    for (const time of [0, 0.1, 0.25, 0.7, 1.33, 1.5]) {
      for (const name of ['Arm.quaternion', 'Hips.position', 'Face.morphTargetInfluences']) {
        const expected = valueAt(trackOf(whole, name), 1.25 + time);
        valueAt(trackOf(clip, name), time).forEach((value, index) => expect(value).toBeCloseTo(expected[index], 4));
      }
    }
  });

  it('keeps a held track, and a key on the range ends adds none beside it', () => {
    const clip = cutClip(take(), range({ start: 1, end: 3 }))!;
    expect(Array.from(trackOf(clip, 'Head.scale').values)).toEqual([2, 2, 2]);
    expect(Array.from(trackOf(clip, 'Arm.quaternion').times)).toEqual([0, 0.5, 1, 1.5, 2]);
  });

  it('stops at the end of the take', () => {
    expect(cutClip(take('Take 001', 4), range({ start: 3, end: 9 }))!.duration).toBeCloseTo(1, 6);
    expect(cutClip(take('Take 001', 4), range({ start: 5, end: 9 }))).toBeNull();
  });

  it('keeps a track that steps, stepping', () => {
    const steps = new THREE.AnimationClip('Steps', -1, [new THREE.NumberKeyframeTrack('Light.intensity', [0, 1, 2], [1, 5, 9], THREE.InterpolateDiscrete)]);
    const clip = cutClip(steps, range({ start: 0.5, end: 1.5 }))!;
    const track = trackOf(clip, 'Light.intensity');
    expect(track.getInterpolation()).toBe(THREE.InterpolateDiscrete);
    expect(Array.from(track.values)).toEqual([1, 5, 5]);
  });

  it('follows a smooth glTF curve with plain keys', () => {
    // As GLTFLoader makes one: in-tangent, value, out-tangent per key.
    const times = [0, 1, 2];
    const values = [0, 0, 0, 0, 0, 0, 2, 2, 2, 0, 0, 0, 2, 2, 2, 0, 0, 0, 4, 4, 4, 0, 0, 0, 0, 0, 0];
    const curve = new THREE.VectorKeyframeTrack('Hand.position', times, values);
    // Reads the middle of each key's three, which is all this test needs of a curve.
    const middles = new Float32Array([0, 0, 0, 2, 2, 2, 4, 4, 4]);
    const factory = (result?: Float32Array) => new THREE.LinearInterpolant(new Float32Array(times), middles, 3, result);
    (curve as unknown as { createInterpolant: unknown }).createInterpolant = Object.assign(factory, { isInterpolantFactoryMethodGLTFCubicSpline: true });
    const clip = cutClip(new THREE.AnimationClip('Curve', -1, [curve]), range({ start: 0.5, end: 1.5 }))!;
    const track = trackOf(clip, 'Hand.position');
    expect(track.getValueSize()).toBe(3);
    expect(track.times.length).toBeGreaterThan(10);
    valueAt(track, 0.5).forEach((value) => expect(value).toBeCloseTo(2, 4));
  });

  it('says it loops as its range says, and where it came from', () => {
    const looping = cutClip(take(), range())!;
    const once = cutClip(take(), range({ name: 'Once', loop: false }))!;
    expect(clipLoops(looping)).toBe(true);
    expect(clipLoops(once)).toBe(false);
    expect(clipRange(looping)?.name).toBe('Part');
    expect(clipTake(looping)).toBe('Take 001');
    expect(clipLoops(take())).toBeUndefined();
  });
});

describe('a clip whose character has walked off', () => {
  it('starts where the take starts once the root has gone far', () => {
    const clip = cutClip(take(), range({ start: 2, end: 3 }), rig())!;
    const hips = trackOf(clip, 'Hips.position');
    expect(valueAt(hips, 0)).toEqual([0, 1, 0]);
    // Its own travel stays, and so does its height.
    valueAt(hips, 1).forEach((value, index) => expect(value).toBeCloseTo([0, 1, 1][index], 5));
  });

  it('keeps its place while the root has not gone far', () => {
    const clip = cutClip(take(), range({ start: 0.25, end: 3 }), rig())!;
    expect(valueAt(trackOf(clip, 'Hips.position'), 0)[2]).toBeCloseTo(0.25, 5);
  });

  it('does as it is told when told', () => {
    expect(valueAt(trackOf(cutClip(take(), range({ start: 2, end: 3, recentre: false }), rig())!, 'Hips.position'), 0)[2]).toBeCloseTo(2, 5);
    expect(valueAt(trackOf(cutClip(take(), range({ start: 0.25, end: 3, recentre: true }), rig())!, 'Hips.position'), 0)[2]).toBeCloseTo(0, 5);
  });

  it('finds the floor when the track\'s space is on its side', () => {
    // A Z-up file stood up by a parent turned about X: along the floor is the track's X and Y, its height its Z.
    const root = new THREE.Group();
    const parent = new THREE.Group();
    parent.rotation.x = -Math.PI / 2;
    const hips = new THREE.Bone();
    hips.name = 'Hips';
    parent.add(hips);
    root.add(parent);
    const clip = new THREE.AnimationClip('Z up', -1, [
      new THREE.VectorKeyframeTrack('Hips.position', [0, 1, 2], [0, 0, 1, 0, 2, 1.25, 0, 4, 1.5]),
    ]);
    const travel = rootTravel(clip, 1, root)!;
    expect(travel.far).toBe(true);
    expect(travel.shift.y).toBeCloseTo(2, 5);
    expect(travel.shift.z).toBeCloseTo(0, 5);
  });
});

describe('a model\'s takes as it should have them', () => {
  it('replaces a take left out with the clips cut from it, in the order they were listed', () => {
    const clips = cutModelTakes([take('Long'), take('Idle')], { clipRanges: [range({ take: 'Long', name: 'B' }), range({ take: 'Long', name: 'A' })], excludedClips: ['Long'] });
    expect(clips.map((clip) => clip.name)).toEqual(['Idle', 'B', 'A']);
  });

  it('keeps a take as well when it is not left out', () => {
    expect(cutModelTakes([take('Long')], { clipRanges: [range({ take: 'Long', name: 'A' })] }).map((clip) => clip.name)).toEqual(['Long', 'A']);
  });

  it('leaves out a take with no ranges', () => {
    expect(cutModelTakes([take('Walk'), take('Run')], { excludedClips: ['Run'] }).map((clip) => clip.name)).toEqual(['Walk']);
  });

  it('cuts nothing from a take the file does not have, unless it has only one', () => {
    expect(cutModelTakes([take('Walk'), take('Run')], { clipRanges: [range({ take: 'Gone' })] }).map((clip) => clip.name)).toEqual(['Walk', 'Run']);
    const renamed = cutModelTakes([take('New name')], { clipRanges: [range({ take: 'Old name' })], excludedClips: ['Old name'] });
    expect(renamed.map((clip) => clip.name)).toEqual(['Part']);
  });

  it('leaves a clip imported onto the model to its own file', () => {
    const attached = range({ take: 'Mocap', name: 'Wave', attached: true });
    expect(cutModelTakes([take('Only')], { clipRanges: [attached] }).map((clip) => clip.name)).toEqual(['Only']);
    const mocap = take('Mocap');
    expect(cutAttachedClips([mocap], { clipRanges: [attached], excludedClips: ['Mocap'] }).map((clip) => clip.name)).toEqual(['Wave']);
    expect(cutAttachedClips([mocap], { clipRanges: [range({ take: 'Only' })] }).map((clip) => clip.name)).toEqual(['Mocap']);
  });

  it('tells the importer to read a take that is cut', () => {
    const read = convertOptionsFor({ normalize: false, targetSize: 2, excludedClips: ['Long', 'Run'], clipRanges: [range({ take: 'Long' })] });
    expect(read?.clipRanges).toHaveLength(1);
    expect(importerOptions(read)).toEqual({ excludedClips: ['Run'] });
    expect(importerOptions({ excludedClips: ['Run'] })).toEqual({ excludedClips: ['Run'] });
  });

  it('gives a clip cut from a take no stored name for a whole take', () => {
    const whole = take('Walk');
    const clips = [whole, cutClip(take('Long'), range({ take: 'Long', name: 'Kept' }))!];
    expect(wholeClips(clips)).toEqual([whole]);
    applyStoredClipNames(clips, ['Stored']);
    expect(clips.map((clip) => clip.name)).toEqual(['Stored', 'Kept']);
  });
});

describe('clip names staying the same when a model is read again', () => {
  const named = (name: string, file: string): THREE.AnimationClip => {
    const clip = take(file);
    clip.name = name;
    return clip;
  };

  it('keeps each take\'s name when one is ticked and another unticked', () => {
    // Idle, Walk and Run with Run left out are stored as Idle and Walk; then Run comes in and Idle goes.
    const before = [named('Idle', 'Idle'), named('Walk', 'Walk')];
    const after = [named('Walk', 'Walk'), named('Run', 'Run')];
    const names = carriedClipNames(after, before, undefined, new Set());
    expect(names).toEqual(['Walk', 'Run']);
    // What is stored then, read back by position when the project opens.
    const reopened = [named('Walk', 'Walk'), named('Run', 'Run')];
    applyStoredClipNames(reopened, names);
    expect(reopened.map((clip) => clip.name)).toEqual(['Walk', 'Run']);
  });

  it('does not hand one take\'s name to another when the only one kept changes', () => {
    expect(carriedClipNames([named('Run', 'Run')], [named('Idle', 'Idle')], undefined, new Set())).toEqual(['Run']);
  });

  it('keeps names that were given to a take, when other takes come and go', () => {
    const before = [named('Stored walk', 'Walk'), named('Stored run', 'Run')];
    expect(carriedClipNames([named('Run', 'Run')], before, undefined, new Set())).toEqual(['Stored run']);
    expect(carriedClipNames([named('Run', 'Run'), named('Jump', 'Jump')], before, undefined, new Set())).toEqual(['Stored run', 'Jump']);
  });

  it('gives a new file\'s takes the stored names in order when there are as many and none is known', () => {
    const before = [named('Idle', 'Old idle'), named('Walk', 'Old walk')];
    expect(carriedClipNames([named('New 1', 'New 1'), named('New 2', 'New 2')], before, ['Idle', 'Walk'], new Set())).toEqual(['Idle', 'Walk']);
    expect(carriedClipNames([named('New 1', 'New 1')], before, ['Idle', 'Walk'], new Set())).toEqual(['New 1']);
    expect(carriedClipNames([named('Old walk', 'Old walk'), named('New 2', 'New 2')], before, ['Idle', 'Walk'], new Set())).toEqual(['Walk', 'New 2']);
  });

  it('makes way for a clip cut from a take', () => {
    expect(carriedClipNames([named('Walk', 'Take')], [], undefined, new Set(['Walk']))).toEqual(['Walk 2']);
  });
});

describe('what a clip is called when it first comes in', () => {
  const names = (clips: string[], fileName: string, format: 'fbx' | 'glb', fileTakes?: string[]) => {
    const list = clips.map((name) => ({ name }));
    nameAnimations(list, fileName, format, fileTakes);
    return list.map((clip) => clip.name);
  };

  it('goes by the file when the file holds one take', () => {
    expect(names(['Take 001'], 'Hero.fbx', 'fbx', ['Take 001'])).toEqual(['Hero']);
    expect(names(['mixamo.com'], 'Hero.fbx', 'fbx')).toEqual(['Hero']);
  });

  it('keeps the take\'s name when it is the one left of several', () => {
    expect(names(['Run'], 'Hero.fbx', 'fbx', ['Idle', 'Walk', 'Run'])).toEqual(['Run']);
    expect(names(['Run'], 'Hero.glb', 'glb', ['Idle', 'Walk', 'Run'])).toEqual(['Run']);
  });

  it('numbers a generic take by its place in the file, whichever others are kept', () => {
    const file = ['Idle', 'mixamo.com', 'Take 001'];
    expect(names(file, 'Hero.fbx', 'fbx', file)).toEqual(['Idle', 'Hero 2', 'Hero 3']);
    expect(names(['Take 001'], 'Hero.fbx', 'fbx', file)).toEqual(['Hero 3']);
    expect(names(['mixamo.com', 'mixamo.com'], 'Hero.fbx', 'fbx', ['Idle', 'mixamo.com', 'mixamo.com'])).toEqual(['Hero 2', 'Hero 3']);
  });

  it('fills in only what a glTF leaves generic', () => {
    expect(names(['Take 001'], 'Hero.glb', 'glb')).toEqual(['Hero']);
    expect(names(['Walk', 'Take 001'], 'Hero.glb', 'glb')).toEqual(['Walk', 'Hero 2']);
  });
});

describe('stored ranges', () => {
  it('keeps the valid ones, and of one name the first', () => {
    const good = { take: 'T', name: 'A', start: 0, end: 1, loop: false };
    expect(resolveClipRanges([good, { ...good }, { ...good, name: 'B', loop: true, recentre: false, attached: true }])).toEqual([good, { ...good, name: 'B', loop: true, recentre: false, attached: true }]);
    for (const bad of [null, 3, {}, { ...good, take: '' }, { ...good, name: ' ' }, { ...good, start: -1 }, { ...good, end: 0 }, { ...good, start: '0' }, { ...good, end: Number.NaN }, { ...good, name: 'x'.repeat(257) }]) {
      expect(resolveClipRanges([bad])).toEqual([]);
    }
    expect(resolveClipRanges('nope')).toEqual([]);
  });

  it('go on the settings only when there are some', () => {
    expect(resolveImportSettings({ normalize: false, targetSize: 2, clipRanges: [] })).toEqual({ normalize: false, targetSize: 2 });
    expect(resolveImportSettings({ normalize: false, targetSize: 2, clipRanges: [range()] }).clipRanges).toEqual([range()]);
  });

  it('stay with their file in a batch', () => {
    const settings = { normalize: false, targetSize: 2, excludedClips: ['Long', 'Run'], clipRanges: [range({ take: 'Long' })] };
    expect(withoutClipRanges(settings)).toEqual({ normalize: false, targetSize: 2, excludedClips: ['Run'] });
    expect(withoutClipRanges({ normalize: false, targetSize: 2 })).toEqual({ normalize: false, targetSize: 2 });
  });
});

describe('frames', () => {
  it('count on the file\'s timeline', () => {
    expect(frameOfTime(0, 100 / 30, 30)).toBe(100);
    expect(frameOfTime(1, 100 / 30, 30)).toBe(130);
    expect(timeOfFrame(130, 100 / 30, 30)).toBeCloseTo(1, 6);
    expect(frameOfTime(timeOfFrame(7, 0, 24), 0, 24)).toBe(7);
  });
});
