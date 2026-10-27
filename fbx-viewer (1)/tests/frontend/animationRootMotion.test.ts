import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { extractRootMotion, findRootMotionTrack, rootMotionDelta, type RootMotion } from '../../components/AnimationGraph/utils/rootMotion';

// Hips travel x = 1 + 2t and z = 3 - t over one second while bobbing in y.
const hipsTrack = (name = 'mixamorigHips.position') =>
  new THREE.VectorKeyframeTrack(name, [0, 0.5, 1], [1, 0.9, 3, 2, 1.0, 2.5, 3, 0.9, 2]);

const walkClip = (rootTrack = hipsTrack()) => new THREE.AnimationClip('Walk', 1, [
  rootTrack,
  new THREE.QuaternionKeyframeTrack('mixamorigSpine.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
  new THREE.VectorKeyframeTrack('mixamorigLeftUpLeg.position', [0, 1], [0.1, 0, 0, 0.1, 0, 0]),
]);

const positionTrack = (name: string) => new THREE.VectorKeyframeTrack(`${name}.position`, [0, 1], [0, 0, 0, 1, 0, 1]);

const axis = (values: ArrayLike<number>, index: number, stride = 3, offset = 0) =>
  Array.from({ length: values.length / stride }, (_, key) => values[key * stride + offset + index]);

const expectVector = (value: THREE.Vector3, x: number, y: number, z: number) => {
  expect(value.x).toBeCloseTo(x, 5);
  expect(value.y).toBeCloseTo(y, 5);
  expect(value.z).toBeCloseTo(z, 5);
};

const motionOf = (clip: THREE.AnimationClip): RootMotion => {
  const motion = extractRootMotion(clip);
  if (!motion) throw new Error('expected root motion');
  return motion;
};

describe('root motion track detection', () => {
  it('finds the hips or root position track through rig prefixes, paths and case', () => {
    for (const name of [
      'mixamorigHips', 'mixamorig1Hips', 'Armature|mixamorig:Hips', '.bones[mixamorigHips]', 'Hips', 'HIPS',
      'pelvis', 'root', 'Bip01 Pelvis', 'CC_Base_Hip', 'DEF-hips',
    ]) {
      const track = name.startsWith('.') ? new THREE.VectorKeyframeTrack(`${name}.position`, [0], [0, 0, 0]) : positionTrack(name);
      const clip = new THREE.AnimationClip('Clip', 1, [positionTrack('mixamorigSpine'), track]);
      expect(findRootMotionTrack(clip), name).toBe(track);
    }
  });

  it('ignores limb joints and other properties of the hips', () => {
    const clip = new THREE.AnimationClip('Clip', 1, [
      positionTrack('mixamorigLeftHip'),
      positionTrack('Hip_L'),
      positionTrack('R_Hip'),
      positionTrack('mixamorigLeftUpLeg'),
      new THREE.VectorKeyframeTrack('mixamorigHips.scale', [0, 1], [1, 1, 1, 1, 1, 1]),
      new THREE.QuaternionKeyframeTrack('mixamorigHips.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    ]);
    expect(findRootMotionTrack(clip)).toBeNull();
  });

  it('prefers a root bone over the pelvis it parents', () => {
    const pelvis = positionTrack('pelvis');
    const root = positionTrack('root');
    expect(findRootMotionTrack(new THREE.AnimationClip('Clip', 1, [pelvis, root]))).toBe(root);
    const bipedPelvis = positionTrack('Bip01 Pelvis');
    const biped = positionTrack('Bip01');
    expect(findRootMotionTrack(new THREE.AnimationClip('Clip', 1, [bipedPelvis, biped]))).toBe(biped);
  });

  it('picks the match highest in the model hierarchy when one is given', () => {
    const model = new THREE.Group();
    const hip = new THREE.Bone();
    hip.name = 'CC_Base_Hip';
    const pelvisBone = new THREE.Bone();
    pelvisBone.name = 'CC_Base_Pelvis';
    model.add(hip);
    hip.add(pelvisBone);
    const pelvis = positionTrack('CC_Base_Pelvis');
    const hipTrack = positionTrack('CC_Base_Hip');
    const clip = new THREE.AnimationClip('Clip', 1, [pelvis, hipTrack]);
    expect(findRootMotionTrack(clip)).toBe(pelvis);
    expect(findRootMotionTrack(clip, model)).toBe(hipTrack);
    expect(extractRootMotion(clip, { root: model })?.track).toBe(hipTrack);
  });
});

describe('root motion extraction', () => {
  it('pins the horizontal root position to the first key and keeps the vertical bob', () => {
    const clip = walkClip();
    const source = clip.tracks[0];
    const motion = motionOf(clip);
    expect(motion.track).toBe(source);
    expect(motion.duration).toBe(1);
    expect(motion.clip).not.toBe(clip);
    expect(motion.clip.name).toBe('Walk');
    expect(motion.clip.tracks.map(track => track.name)).toEqual(clip.tracks.map(track => track.name));
    expect(motion.clip.tracks[1]).toBe(clip.tracks[1]);

    const pinned = motion.clip.tracks[0];
    expect(pinned).not.toBe(source);
    expect(axis(pinned.values, 0)).toEqual([1, 1, 1]);
    expect(axis(pinned.values, 2)).toEqual([3, 3, 3]);
    expect(axis(pinned.values, 1)).toEqual(axis(source.values, 1));
    expect(axis(source.values, 0)).toEqual([1, 2, 3]);
  });

  it('pins the vertical position too when keepVertical is false', () => {
    const motion = extractRootMotion(walkClip(), { keepVertical: false });
    const pinned = motion?.clip.tracks[0];
    expect(pinned && axis(pinned.values, 1)).toEqual([0.9, 0.9, 0.9].map(Math.fround));
    expect(pinned && axis(pinned.values, 0)).toEqual([1, 1, 1]);
  });

  it('plays in place on a mixer while the source travel stays sampleable', () => {
    const model = new THREE.Group();
    const [hips, spine, leg] = ['mixamorigHips', 'mixamorigSpine', 'mixamorigLeftUpLeg'].map(name => {
      const bone = new THREE.Bone();
      bone.name = name;
      return bone;
    });
    model.add(hips);
    hips.add(spine, leg);
    const motion = motionOf(walkClip());
    const mixer = new THREE.AnimationMixer(model);
    mixer.clipAction(motion.clip).play();
    mixer.update(0.5);
    expectVector(hips.position, 1, 1, 3);
    expectVector(rootMotionDelta(motion, 0, 0.5, true), 1, 0, -0.5);
  });

  it('caches per clip and options', () => {
    const clip = walkClip();
    const motion = extractRootMotion(clip);
    expect(extractRootMotion(clip)).toBe(motion);
    expect(extractRootMotion(clip, { keepVertical: true })).toBe(motion);
    const flat = extractRootMotion(clip, { keepVertical: false });
    expect(flat).not.toBe(motion);
    expect(extractRootMotion(clip, { keepVertical: false })).toBe(flat);
  });

  it('returns null without a root track or a duration', () => {
    expect(extractRootMotion(new THREE.AnimationClip('Wave', 1, [positionTrack('mixamorigLeftHand')]))).toBeNull();
    expect(extractRootMotion(new THREE.AnimationClip('Pose', 0, [hipsTrack()]))).toBeNull();
  });

  it('pins glTF cubic spline keys and flattens their horizontal tangents', () => {
    // Per key: in-tangent, value, out-tangent.
    const track = new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [
      1, 1, 1, 0, 1, 0, 1, 1, 1,
      1, 1, 1, 2, 1, 4, 1, 1, 1,
    ]);
    // Stands in for GLTFLoader's factory: samples the values linearly and carries its marker.
    const factory = function (this: THREE.KeyframeTrack, result?: Float32Array) {
      return new THREE.LinearInterpolant(this.times, this.values.filter((_, index) => index % 9 >= 3 && index % 9 < 6), 3, result);
    };
    Object.assign(track, { createInterpolant: Object.assign(factory, { isInterpolantFactoryMethodGLTFCubicSpline: true }) });

    const motion = motionOf(new THREE.AnimationClip('Walk', 1, [track]));
    const pinned = motion.clip.tracks[0];
    expect(axis(pinned.values, 0, 9, 3)).toEqual([0, 0]);
    expect(axis(pinned.values, 2, 9, 3)).toEqual([0, 0]);
    expect(axis(pinned.values, 1, 9, 3)).toEqual([1, 1]);
    expect([...axis(pinned.values, 0, 9, 0), ...axis(pinned.values, 2, 9, 6)]).toEqual([0, 0, 0, 0]);
    expect([...axis(pinned.values, 1, 9, 0), ...axis(pinned.values, 1, 9, 6)]).toEqual([1, 1, 1, 1]);
    expectVector(rootMotionDelta(motion, 0, 0.5, false), 1, 0, 2);
  });
});

describe('root motion delta', () => {
  const motion = motionOf(walkClip());

  it('measures horizontal travel over a span', () => {
    expectVector(rootMotionDelta(motion, 0.25, 0.75, false), 1, 0, -0.5);
    expectVector(rootMotionDelta(motion, 0.25, 0.75, true), 1, 0, -0.5);
  });

  it('adds the rest of the cycle and the start of the next when a loop wraps', () => {
    expectVector(rootMotionDelta(motion, 0.9, 0.1, true), 0.4, 0, -0.2);
  });

  it('runs backwards for reverse playback, including across the loop seam', () => {
    expectVector(rootMotionDelta(motion, 0.6, 0.4, true), -0.4, 0, 0.2);
    expectVector(rootMotionDelta(motion, 0.1, 0.9, true), -0.4, 0, 0.2);
    expectVector(rootMotionDelta(motion, 0.9, 0.1, false), -1.6, 0, 0.8);
  });

  it('counts whole cycles for unwrapped times', () => {
    expectVector(rootMotionDelta(motion, 0.5, 2.5, true), 4, 0, -2);
    expectVector(rootMotionDelta(motion, 0.9, 1.1, true), 0.4, 0, -0.2);
    expectVector(rootMotionDelta(motion, 1.1, -0.1, true), -2.4, 0, 1.2);
  });

  it('clamps unlooped times to the clip', () => {
    expectVector(rootMotionDelta(motion, 0.8, 1.5, false), 0.4, 0, -0.2);
    expectVector(rootMotionDelta(motion, -1, 0.5, false), 1, 0, -0.5);
  });

  it('writes into the given vector and returns zero for unusable times', () => {
    const out = new THREE.Vector3(9, 9, 9);
    expect(rootMotionDelta(motion, 0, 0.5, true, out)).toBe(out);
    expectVector(out, 1, 0, -0.5);
    expectVector(rootMotionDelta(motion, Number.NaN, 0.5, true, out), 0, 0, 0);
    expectVector(rootMotionDelta({ ...motion, duration: 0 }, 0, 0.5, true), 0, 0, 0);
  });
});
