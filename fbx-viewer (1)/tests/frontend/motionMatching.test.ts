import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MATCHER_OPTIONS, END_MARGIN, FEATURE_SIZE, HISTORY_TIMES, MotionDatabase, MotionMatcher, SAMPLE_RATE, TRAJECTORY_TIMES, buildQuery, frameFeatures, predictTrajectory,
  restFrom, steadyTrajectory, STEER_TURN, type MotionClipSamples, type MotionSample,
} from '../../runtime/motionMatching';
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { footContacts, looksLooping, motionDatabaseFor, smoothSeries, travelFromFeet } from '../../runtime/motionDatabase';

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

/**
 * A clip that plays once, going straight ahead at `speedAt(t)` m/s and turning `turnAt(t)` rad/s: a start,
 * a stop, a turn round. Its feet step while it moves and stand still beside each other when it does not.
 */
const shaped = (name: string, seconds: number, speedAt: (t: number) => number, turnAt: (t: number) => number = () => 0): MotionClipSamples => {
  const samples: MotionSample[] = [];
  let x = 0, z = 0, facing = 0, step = 0;
  const n = Math.round(seconds * SAMPLE_RATE);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const speed = speedAt(t);
    const side = { x: Math.cos(facing), z: -Math.sin(facing) };
    const forward = { x: Math.sin(facing), z: Math.cos(facing) };
    const stride = Math.min(0.3, speed * 0.2);
    const phase = Math.sin(step);
    const foot = (sign: number) => ({
      x: x + side.x * 0.15 * sign + forward.x * stride * phase * sign,
      y: Math.max(0, phase * sign) * stride / 3,
      z: z + side.z * 0.15 * sign + forward.z * stride * phase * sign,
    });
    samples.push({ root: { x, y: 0, z }, facing, hips: { x, y: 1, z }, leftFoot: foot(-1), rightFoot: foot(1) });
    x += (speed * Math.sin(facing)) / SAMPLE_RATE;
    z += (speed * Math.cos(facing)) / SAMPLE_RATE;
    facing += turnAt(t) / SAMPLE_RATE;
    if (speed > 0.05) step += (4 * Math.PI) / SAMPLE_RATE;
  }
  return { name, loop: false, samples };
};

/** Walking at 1.5 m/s and coming to a stop at 0.6 s, then standing to the end at 1.2 s. */
const stopping = () => shaped('stop', 1.2, t => Math.max(0, 1.5 - 2.5 * t));

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

  it("leaves out a non-looping clip's last moments, and sees past its end as carrying on", () => {
    const once = locomotion('stop', 0, 1, 0, 1, 2, false);
    const database = new MotionDatabase([once]);
    expect(database.frames.length).toBe(once.samples.length - Math.round(END_MARGIN * SAMPLE_RATE));
    // Near its end, a clip still moving at 1 m/s is seen going on at that speed, not stopping dead.
    const late = frameFeatures(once, once.samples.length - 7);
    expect(late[(TRAJECTORY_TIMES.length - 1) * 2 + 1]).toBeCloseTo(TRAJECTORY_TIMES[TRAJECTORY_TIMES.length - 1], 1);
    // And just after its start, it is seen to have come from behind at that speed.
    const early = frameFeatures(once, 2);
    expect(early[TRAJECTORY_TIMES.length * 4 + (HISTORY_TIMES.length - 1) * 2 + 1]).toBeCloseTo(-HISTORY_TIMES[HISTORY_TIMES.length - 1], 1);
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
  it('answers a sharp change in what is asked for at once, not at the next search', () => {
    const matcher = new MotionMatcher(new MotionDatabase(library()), { ...DEFAULT_MATCHER_OPTIONS, searchInterval: 10 });
    const ahead = (speed: number) => ({ positions: TRAJECTORY_TIMES.map(time => ({ x: 0, z: speed * time })), facings: TRAJECTORY_TIMES.map(() => 0) });
    const still = { x: 0, z: 0 };
    matcher.step(1 / 60, still, still, 0, ahead(0));
    const standing = matcher.database.clips[matcher.clip].name;
    expect(standing).toBe('idle');
    // Long between searches: a small change waits...
    matcher.step(1 / 60, still, still, 0, ahead(0.05));
    expect(matcher.database.clips[matcher.clip].name).toBe('idle');
    // ...but setting off at a run does not.
    const choice = matcher.step(1 / 60, still, still, 0, ahead(4.5));
    expect(choice.jumped).toBe(true);
    expect(matcher.database.clips[matcher.clip].name).not.toBe('idle');
  });
});

describe('search', () => {
  it('finds the same frame as looking at every frame, while passing over blocks that cannot win', () => {
    const database = new MotionDatabase(library());
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let trial = 0; trial < 40; trial++) {
      const query = new Float32Array(FEATURE_SIZE).map(() => random() * 2);
      let best = -1, bestCost = Infinity;
      for (let f = 0; f < database.frames.length; f++) {
        let cost = 0;
        for (let k = 0; k < FEATURE_SIZE; k++) cost += (database.features[f * FEATURE_SIZE + k] - query[k]) ** 2;
        if (cost < bestCost) { bestCost = cost; best = f; }
      }
      const found = database.search(query);
      expect(found.frame).toBe(best);
      expect(found.cost).toBeCloseTo(bestCost, 4);
    }
  });

  it("describes where a frame came from, so a start reads differently from a loop", () => {
    // A clip that stands for a second and then walks off: early in the walk it has come from standing.
    const start = locomotion('start', 0, 1.5, 0, 2, 2, false);
    start.samples.forEach((sample, i) => {
      const z = Math.max(0, i - SAMPLE_RATE) * 1.5 / SAMPLE_RATE;
      sample.root = { x: 0, y: 0, z };
      sample.hips = { x: 0, y: 1, z };
    });
    const loop = locomotion('walk', 0, 1.5);
    const startFeatures = frameFeatures(start, SAMPLE_RATE + 3);
    const loopFeatures = frameFeatures(loop, 30);
    // Both head the same way, but the loop has walked to here and the start has barely moved.
    expect(startFeatures[TRAJECTORY_TIMES.length * 4 + 1]).toBeGreaterThan(loopFeatures[TRAJECTORY_TIMES.length * 4 + 1] + 0.15);
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

describe('clip motion', () => {
  it("reads which way a clip travels and faces at a time, in the clip's own facing", () => {
    const database = new MotionDatabase([locomotion('strafe right', 1.5, 0), locomotion('turn left', 0, 0, 1.5, 2)]);
    const strafe = database.travelAt(0, 0.5);
    expect(Math.hypot(strafe.x, strafe.z)).toBeCloseTo(1.5, 1);
    expect(Math.abs(strafe.x)).toBeGreaterThan(Math.abs(strafe.z) * 10);
    // Turning on the spot at 1.5 radians a second.
    expect(database.facingAt(1, 1) - database.facingAt(1, 0.5)).toBeCloseTo(0.75, 2);
    const still = database.travelAt(1, 1);
    expect(Math.hypot(still.x, still.z)).toBeLessThan(0.01);
  });
});

describe('clips that play once', () => {
  it('are told from loops: a start, a stop and a turn round each play once', () => {
    expect(looksLooping(locomotion('walk', 0, 1.5).samples)).toBe(true);
    expect(looksLooping(locomotion('idle', 0, 0).samples)).toBe(true);
    expect(looksLooping(shaped('start', 1.2, t => Math.min(1.5, 2 * t)).samples)).toBe(false);
    expect(looksLooping(stopping().samples)).toBe(false);
    expect(looksLooping(shaped('turn round', 1.2, () => 1.2, () => Math.PI / 1.2).samples)).toBe(false);
  });

  it("know where a stop has come to rest, and leave its standing end out of the search", () => {
    const stop = stopping();
    const rest = restFrom(stop, 1);
    expect(rest / SAMPLE_RATE).toBeGreaterThan(0.5);
    expect(rest / SAMPLE_RATE).toBeLessThan(0.7);
    // A clip still moving at its end has no rest.
    expect(restFrom(locomotion('walk', 0, 1.5, 0, 2, 2, false), 1)).toBe(Math.round(2 * SAMPLE_RATE));
    // Standing still is for the looping idle: no search lands on the stop once it stands.
    const database = new MotionDatabase([locomotion('idle', 0, 0), stop]);
    const stopTimes = database.frames.filter(frame => frame.clip === 1).map(frame => frame.time);
    expect(stopTimes.length).toBeGreaterThan(0);
    expect(Math.max(...stopTimes)).toBeLessThan(rest / SAMPLE_RATE);
  });

  it('hand over to the best match elsewhere once played to the end, never going back into the end', () => {
    const database = new MotionDatabase([locomotion('idle', 0, 0), locomotion('walk', 0, 1.5), stopping()]);
    const matcher = new MotionMatcher(database);
    // The stop is playing its last moments, standing.
    matcher.clip = 2;
    matcher.time = 1.1;
    const still = { x: 0, z: 0 };
    const played: string[] = [];
    for (let i = 0; i < 120; i++) played.push(database.clips[matcher.step(1 / 60, still, still, 0).clip].name);
    expect(played[played.length - 1]).toBe('idle');
    // Once it has ended, the stop is not started again.
    const ended = played.findIndex(name => name !== 'stop');
    expect(ended).toBeGreaterThanOrEqual(0);
    expect(played.slice(ended)).not.toContain('stop');
  });
});

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
  it('mark a foot planted while it is down and still, voting away a lone stray sample', () => {
    // The left foot is down for frames 0-11 (still, apart from one stray lift at 5), then swings
    // forward through the air; the right foot does the opposite.
    const samples: MotionSample[] = Array.from({ length: 24 }, (_, i) => {
      const down = i < 12;
      const left = down ? { x: 0, y: i === 5 ? 0.2 : 0.1, z: 0 } : { x: 0, y: 0.3, z: 0.05 * (i - 12) };
      const right = down ? { x: 0.2, y: 0.3, z: 0.05 * i } : { x: 0.2, y: 0.1, z: 0.6 };
      return { root: { x: 0, y: 0, z: 0 }, facing: 0, hips: { x: 0.1, y: 1, z: 0 }, leftFoot: left, rightFoot: right };
    });
    footContacts(samples, false);
    expect(samples.slice(1, 11).every(sample => sample.contacts![0])).toBe(true);
    expect(samples.slice(14, 23).some(sample => sample.contacts![0])).toBe(false);
    expect(samples.slice(14, 23).every(sample => sample.contacts![1])).toBe(true);
    expect(samples.slice(1, 11).some(sample => sample.contacts![1])).toBe(false);
  });
});

describe('steering', () => {
  /** An arc at `speed` m/s turning `turn` radians a second, as the movement would ask for it. */
  const arc = (speed: number, turn: number) => ({
    positions: TRAJECTORY_TIMES.map(t => ({ x: (speed / turn) * (1 - Math.cos(turn * t)), z: (speed / turn) * Math.sin(turn * t) })),
    facings: TRAJECTORY_TIMES.map(t => turn * t),
  });
  /** Slows to a stop while turning, then walks off the other way: a turn of 180 degrees. */
  const turnRound = () => shaped('turn round', 1.2, t => 1.5 * Math.abs(1 - t / 0.6), () => Math.PI / 1.2);

  it('takes the bend out of a path, keeping its pace and which way it goes relative to the facing', () => {
    // Walking round a quarter circle in a second becomes walking straight on, nearly as far.
    const bent = steadyTrajectory(arc(1.5, Math.PI / 2));
    bent.positions.forEach(position => expect(Math.abs(position.x)).toBeLessThan(1e-6));
    expect(bent.positions[bent.positions.length - 1].z).toBeGreaterThan(1.4);
    expect(bent.positions[bent.positions.length - 1].z).toBeLessThan(1.5);
    bent.facings.forEach(facing => expect(Math.abs(facing)).toBeLessThan(1e-9));
    // A sideways path with the facing held (aiming) stays sideways.
    const sideways = steadyTrajectory({ positions: TRAJECTORY_TIMES.map(t => ({ x: 1.5 * t, z: 0 })), facings: TRAJECTORY_TIMES.map(() => 0) });
    sideways.positions.forEach((position, i) => {
      expect(position.x).toBeCloseTo(1.5 * TRAJECTORY_TIMES[i], 6);
      expect(position.z).toBeCloseTo(0, 6);
    });
    // Turning further than the movement steers keeps the rest of the turn.
    const round = steadyTrajectory({ positions: TRAJECTORY_TIMES.map(() => ({ x: 0, z: 0 })), facings: [0, 0, (160 * Math.PI) / 180] });
    expect(round.facings[2]).toBeCloseTo((160 * Math.PI) / 180 - STEER_TURN, 6);
  });

  it('steers clips that travel and keep to their line, not ones that stand or turn round', () => {
    const database = new MotionDatabase([
      locomotion('idle', 0, 0), locomotion('walk', 0, 1.5), shaped('start', 1.2, t => Math.min(1.5, 2 * t)), turnRound(),
    ]);
    expect(database.clips.map((clip, c) => [clip.name, database.steered[c]])).toEqual([
      ['idle', false], ['walk', true], ['start', true], ['turn round', false],
    ]);
  });

  it('walks round a bend instead of turning round, and still turns round when asked to', () => {
    const turn = turnRound();
    const database = new MotionDatabase([locomotion('idle', 0, 0), locomotion('walk', 0, 1.5), turn]);
    const walking = { x: 0, z: 1.5 };
    // Walking, and asked to bend round by 80 degrees over the next second: it walks on, steered.
    const steering = new MotionMatcher(database);
    steering.clip = 1;
    steering.time = 0.5;
    steering.step(1 / 60, walking, walking, 0, arc(1.5, (80 * Math.PI) / 180));
    expect(database.clips[steering.clip].name).toBe('walk');
    // Asked to turn round (the path the turn itself takes): it turns round.
    const at = (t: number) => turn.samples[Math.round(t * SAMPLE_RATE)];
    const reversing = new MotionMatcher(database);
    reversing.clip = 1;
    reversing.time = 0.5;
    reversing.step(1 / 60, walking, walking, 0, {
      positions: TRAJECTORY_TIMES.map(t => ({ x: at(t).root.x, z: at(t).root.z })),
      facings: TRAJECTORY_TIMES.map(t => at(t).facing),
    });
    expect(database.clips[reversing.clip].name).toBe('turn round');
  });
});
