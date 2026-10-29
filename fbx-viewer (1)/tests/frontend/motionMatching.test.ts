import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MATCHER_OPTIONS, FEATURE_SIZE, MotionDatabase, MotionMatcher, SAMPLE_RATE, TRAJECTORY_TIMES, buildQuery, frameFeatures, predictTrajectory,
  type MotionClipSamples, type MotionSample,
} from '../../runtime/motionMatching';
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { motionDatabaseFor, smoothSeries, travelFromFeet } from '../../runtime/motionDatabase';

/*
 * Motion matching on synthetic locomotion: clips whose root moves at a known velocity (and turns),
 * with feet stepping in time. The features, the trajectory prediction, the search and the matcher's
 * choice to keep playing or to jump.
 */

/** A clip of `seconds` moving at (vx, vz) m/s in its own facing, turning `turn` rad/s, feet stepping `cadence` times a second. */
const locomotion = (name: string, vx: number, vz: number, turn = 0, seconds = 2, cadence = 2, loop = true): MotionClipSamples => {
  const samples: MotionSample[] = [];
  let x = 0, z = 0, facing = 0;
  const n = Math.round(seconds * SAMPLE_RATE);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const phase = Math.sin(t * cadence * Math.PI * 2);
    const side = { x: Math.cos(facing), z: -Math.sin(facing) };
    const forward = { x: Math.sin(facing), z: Math.cos(facing) };
    const stride = Math.hypot(vx, vz) > 0 ? 0.3 : 0;
    const foot = (sign: number) => ({
      x: x + side.x * 0.15 * sign + forward.x * stride * phase * sign,
      y: Math.max(0, phase * sign) * 0.1 * (stride > 0 ? 1 : 0),
      z: z + side.z * 0.15 * sign + forward.z * stride * phase * sign,
    });
    samples.push({ root: { x, y: 0, z }, facing, hips: { x, y: 1, z }, leftFoot: foot(-1), rightFoot: foot(1) });
    // Velocity in the clip's own facing, turned into the world.
    x += (vx * Math.cos(facing) + vz * Math.sin(facing)) / SAMPLE_RATE;
    z += (-vx * Math.sin(facing) + vz * Math.cos(facing)) / SAMPLE_RATE;
    facing += turn / SAMPLE_RATE;
  }
  return { name, loop, samples };
};

const library = () => [
  locomotion('idle', 0, 0),
  locomotion('walk', 0, 1.5),
  locomotion('run', 0, 4.5, 0, 1.2, 3),
  locomotion('strafe right', 1.5, 0),
  locomotion('turn left', 0, 1.2, 1.5),
];

describe('features', () => {
  it("describe a clip's future path and facing in the character's own space", () => {
    const walk = locomotion('walk', 0, 1.5);
    const features = frameFeatures(walk, 10);
    expect(features).toHaveLength(FEATURE_SIZE);
    TRAJECTORY_TIMES.forEach((time, i) => {
      const steps = Math.round(time * SAMPLE_RATE) / SAMPLE_RATE;
      expect(features[i * 2]).toBeCloseTo(0, 4);
      expect(features[i * 2 + 1]).toBeCloseTo(1.5 * steps, 4);
      // Still facing ahead.
      expect(features[TRAJECTORY_TIMES.length * 2 + i * 2]).toBeCloseTo(0, 4);
      expect(features[TRAJECTORY_TIMES.length * 2 + i * 2 + 1]).toBeCloseTo(1, 4);
    });
    // Turning clips face round to the left.
    const turning = frameFeatures(locomotion('turn', 0, 1, 1.5), 5);
    expect(turning[TRAJECTORY_TIMES.length * 2 + (TRAJECTORY_TIMES.length - 1) * 2]).toBeGreaterThan(0.5);
  });

  it('carry a looping clip on across its loop point', () => {
    const walk = locomotion('walk', 0, 1.5, 0, 1);
    const end = frameFeatures(walk, walk.samples.length - 2);
    const start = frameFeatures(walk, 2);
    for (let k = 0; k < TRAJECTORY_TIMES.length * 2; k++) expect(end[k]).toBeCloseTo(start[k], 3);
  });
});

describe('trajectory', () => {
  it('keeps a steady velocity, and eases from rest toward a new one', () => {
    const steady = predictTrajectory({ x: 0, z: 2 }, { x: 0, z: 2 }, 0);
    TRAJECTORY_TIMES.forEach((time, i) => expect(steady.positions[i].z).toBeCloseTo(2 * time, 5));
    const starting = predictTrajectory({ x: 0, z: 0 }, { x: 0, z: 3 }, 0);
    starting.positions.forEach((position, i) => {
      expect(position.z).toBeGreaterThan(0);
      expect(position.z).toBeLessThan(3 * TRAJECTORY_TIMES[i]);
      if (i > 0) expect(position.z).toBeGreaterThan(starting.positions[i - 1].z);
    });
    const turning = predictTrajectory({ x: 0, z: 1 }, { x: 0, z: 1 }, 1);
    expect(turning.facings[0]).toBeGreaterThan(0);
    expect(turning.facings[2]).toBeGreaterThan(turning.facings[0]);
    expect(turning.facings[2]).toBeLessThanOrEqual(1);
  });
});

describe('search', () => {
  const pick = (database: MotionDatabase, desired: { x: number; z: number }, from = 'idle', facing = 0) => {
    const playing = database.frameOf(database.clips.findIndex(clip => clip.name === from), 0.5);
    const query = buildQuery(database, playing, predictTrajectory(desired, desired, facing));
    return database.clips[database.frames[database.search(query).frame].clip].name;
  };

  it('finds the clip that moves as asked', () => {
    const database = new MotionDatabase(library());
    expect(pick(database, { x: 0, z: 0 })).toBe('idle');
    expect(pick(database, { x: 0, z: 1.5 })).toBe('walk');
    expect(pick(database, { x: 0, z: 4.5 }, 'walk')).toBe('run');
    expect(pick(database, { x: 1.5, z: 0 })).toBe('strafe right');
    expect(pick(database, { x: 0, z: 1.2 }, 'walk', 1)).toBe('turn left');
  });

  it('does not blow up a feature that hardly varies, such as the facing when every clip goes straight', () => {
    const walk = locomotion('walk', 0, 1.5);
    // The hips' heading wobbles a hair, as a sampled clip's does.
    walk.samples.forEach((sample, i) => { sample.facing = 1e-4 * Math.sin(i); });
    const database = new MotionDatabase([locomotion('idle', 0, 0), walk]);
    const playing = database.frameOf(1, 0.5);
    const cost = (query: Float32Array) => {
      let sum = 0;
      for (let k = 0; k < FEATURE_SIZE; k++) sum += (database.features[playing * FEATURE_SIZE + k] - query[k]) ** 2;
      return sum;
    };
    const walking = { x: 0, z: 1.5 };
    const straight = cost(buildQuery(database, playing, predictTrajectory(walking, walking, 0)));
    const turned = cost(buildQuery(database, playing, predictTrajectory(walking, walking, 0.1)));
    expect(turned - straight).toBeGreaterThan(0.5);
    expect(turned - straight).toBeLessThan(3);
  });

  it('knows how fast each clip travels, a standing one not at all', () => {
    const database = new MotionDatabase(library());
    expect(database.clipSpeed('walk')).toBeCloseTo(1.5, 4);
    expect(database.clipSpeed('run')).toBeCloseTo(4.5, 4);
    expect(database.clipSpeed('idle')).toBe(0);
    expect(database.clipSpeed('swim')).toBe(0);
  });

  it("leaves out a non-looping clip's last frames, which cannot see ahead", () => {
    const once = locomotion('stop', 0, 1, 0, 1, 2, false);
    const database = new MotionDatabase([once]);
    expect(database.frames.length).toBe(once.samples.length - Math.round(TRAJECTORY_TIMES[TRAJECTORY_TIMES.length - 1] * SAMPLE_RATE));
    expect(database.frameOf(0, 100)).toBe(database.frames.length - 1);
    expect(database.frameOf(5, 0)).toBe(-1);
  });
});

describe('matcher', () => {
  it('keeps playing while the motion fits, and jumps when another clip continues it better', () => {
    const matcher = new MotionMatcher(new MotionDatabase(library()));
    const walk = { x: 0, z: 1.5 };
    // From rest it may start in place; within a moment it is walking.
    let choice = matcher.step(1 / 60, { x: 0, z: 0 }, walk, 0);
    for (let i = 0; i < 30; i++) choice = matcher.step(1 / 60, walk, walk, 0);
    expect(matcher.database.clips[choice.clip].name).toBe('walk');
    let jumps = 0;
    let time = choice.time;
    for (let i = 0; i < 120; i++) {
      choice = matcher.step(1 / 60, walk, walk, 0);
      if (choice.jumped) jumps++;
    }
    // Two seconds of walking: it plays on through the clip (looping), no jumps.
    expect(jumps).toBe(0);
    expect(matcher.database.clips[choice.clip].name).toBe('walk');
    expect(choice.time).not.toBe(time);
    time = choice.time;

    // Asked to run, the character speeds up (as its controller would), and the matcher follows.
    const run = { x: 0, z: 4.5 };
    const velocity = { ...walk };
    let switched = false;
    for (let i = 0; i < 90 && !switched; i++) {
      velocity.z += (run.z - velocity.z) * (1 - Math.exp(-4 / 60));
      switched = matcher.step(1 / 60, velocity, run, 0).jumped;
    }
    expect(switched).toBe(true);
    expect(matcher.database.clips[matcher.clip].name).toBe('run');
  });

  it('does not trade places between frames nearly as good, such as a character standing still', () => {
    // An idle that turns a little to and fro: some of its frames suit standing still slightly better than others.
    const idle = locomotion('idle', 0, 0, 0, 4);
    idle.samples.forEach((sample, i) => { sample.facing = 0.06 * Math.sin((i / idle.samples.length) * Math.PI * 2); });
    const database = new MotionDatabase([idle, locomotion('walk', 0, 1.5)]);
    const still = { x: 0, z: 0 };
    const jumps = (options: typeof DEFAULT_MATCHER_OPTIONS) => {
      const matcher = new MotionMatcher(database, options);
      matcher.clip = 0;
      matcher.time = 0;
      let count = 0;
      for (let i = 0; i < 240; i++) if (matcher.step(1 / 60, still, still, 0).jumped) count++;
      return count;
    };
    expect(jumps({ ...DEFAULT_MATCHER_OPTIONS, switchCost: 0 })).toBeGreaterThan(0);
    expect(jumps(DEFAULT_MATCHER_OPTIONS)).toBe(0);
  });
});

/** A small rig (hips over two feet, skinned) and a clip that walks its hips forward. */
const walker = () => {
  const hips = new THREE.Bone();
  hips.name = 'mixamorigHips';
  hips.position.set(0, 1, 0);
  const feet = ['Left', 'Right'].map((side, i) => {
    const foot = new THREE.Bone();
    foot.name = `mixamorig${side}Foot`;
    foot.position.set(i ? 0.15 : -0.15, -0.95, 0);
    hips.add(foot);
    return foot;
  });
  const geometry = new THREE.BoxGeometry(0.4, 2, 0.4, 1, 1, 1);
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(count * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  const model = new THREE.Group();
  model.add(hips, mesh);
  mesh.bind(new THREE.Skeleton([hips, ...feet]));
  const clip = new THREE.AnimationClip('Walk', 1, [new THREE.VectorKeyframeTrack('mixamorigHips.position', [0, 1], [0, 1, 0, 0, 1, 1.5])]);
  return { model, clip };
};

describe('databases', () => {
  it('are shared by characters made from one model, and kept apart for another size', () => {
    const { model, clip } = walker();
    const a = cloneSkinned(model);
    const b = cloneSkinned(model);
    // Each mixer plays its own copy of the clip; the model's own clip names them.
    const first = motionDatabaseFor(a, [clip.clone()], [clip.uuid]);
    expect(first).not.toBeNull();
    expect(first!.clipSpeed('Walk')).toBeGreaterThan(1);
    expect(motionDatabaseFor(b, [clip.clone()], [clip.uuid])).toBe(first);
    const giant = cloneSkinned(model);
    giant.scale.setScalar(2);
    const big = motionDatabaseFor(giant, [clip.clone()], [clip.uuid]);
    expect(big).not.toBe(first);
    expect(big!.clipSpeed('Walk')).toBeCloseTo(first!.clipSpeed('Walk') * 2, 1);
  });
});

describe('sampled clips', () => {
  it('even out a course over about a stride, carrying a loop on past its ends', () => {
    const n = 30;
    const swaying = Array.from({ length: n }, (_, i) => i * 0.1 + 0.05 * Math.sin((i / 10) * Math.PI * 2));
    const smooth = smoothSeries(swaying, true, 5);
    smooth.forEach((value, i) => expect(Math.abs(value - i * 0.1)).toBeLessThan(0.025));
    expect(smoothSeries([2, 2, 2, 2], false, 3)).toEqual([2, 2, 2, 2]);
  });

  it("give an in-place clip the travel its standing foot shows, leaving out the strides in the air", () => {
    // A run in place: ten frames on one foot (sliding back 0.1 a frame), five with both feet up.
    const samples: MotionSample[] = Array.from({ length: 30 }, (_, i) => {
      const phase = i % 15;
      const foot = (stands: boolean) => (stands ? { x: 0, y: 0, z: 0.45 - 0.1 * phase } : { x: 0, y: 0.3, z: -0.5 + 0.1 * phase });
      return {
        root: { x: 0, y: 0, z: 0 }, facing: 0, hips: { x: 0, y: 1, z: 0 },
        leftFoot: foot(phase < 10 && i < 15), rightFoot: foot(phase < 10 && i >= 15),
      };
    });
    travelFromFeet(samples);
    expect(samples[0].root.z).toBe(0);
    expect(samples[29].root.z).toBeCloseTo(2.9, 5);
    // The body keeps its place over the root.
    expect(samples[29].hips.z).toBeCloseTo(2.9, 5);
  });
});
