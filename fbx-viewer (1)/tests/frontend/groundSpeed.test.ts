import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { clipGroundSpeed, groundSpeedRate, MAX_GROUND_SPEED_RATE, MIN_GROUND_SPEED_RATE } from '../../components/AnimationGraph/utils/groundSpeed';

/** Hips with two feet hanging under them, in a model root. */
const rig = () => {
  const model = new THREE.Group();
  const bone = (name: string, parent: THREE.Object3D) => {
    const created = new THREE.Bone();
    created.name = name;
    parent.add(created);
    return created;
  };
  const hips = bone('mixamorigHips', model);
  hips.position.y = 1;
  bone('mixamorigLeftToeBase', hips).position.set(0.2, -1, 0);
  bone('mixamorigRightToeBase', hips).position.set(-0.2, -1, 0);
  return model;
};

/**
 * A one-second stride cycle: each foot slides back 1 unit along the ground under the body over half
 * a second (planted), then swings forward in the air; the feet take turns. `travel` moves the hips
 * forward that far over the cycle as well (root motion).
 */
const stride = (travel = 0) => {
  const times = [0, 0.25, 0.5, 0.75, 1];
  const foot = (x: number, offset: number) => {
    const at = (t: number) => {
      const phase = (t + offset) % 1;
      // Planted: from z +0.5 back to -0.5 over the first half; swinging forward up in the air over the second.
      return phase < 0.5 ? [x, -1, 0.5 - 2 * phase] : [x, -1 + 0.3 * Math.sin((phase - 0.5) * 2 * Math.PI), -0.5 + 2 * (phase - 0.5)];
    };
    const samples = Array.from({ length: 41 }, (_, i) => i / 40);
    return { times: samples, values: samples.flatMap(at) };
  };
  const left = foot(0.2, 0);
  const right = foot(-0.2, 0.5);
  const tracks: THREE.KeyframeTrack[] = [
    new THREE.VectorKeyframeTrack('mixamorigLeftToeBase.position', left.times, left.values),
    new THREE.VectorKeyframeTrack('mixamorigRightToeBase.position', right.times, right.values),
  ];
  if (travel) tracks.push(new THREE.VectorKeyframeTrack('mixamorigHips.position', times, times.flatMap(t => [0, 1, travel * t])));
  return new THREE.AnimationClip(travel ? 'Walk Forward' : 'Walk In Place', 1, tracks);
};

describe('clip ground speed', () => {
  it('reads an in-place walk by how fast the planted foot slides back under the body', () => {
    expect(clipGroundSpeed(rig(), stride())).toBeCloseTo(2, 1);
  });

  it('reads a travelling walk by how fast the body passes over the planted foot', () => {
    // The hips cover 2 units over the cycle; the planted foot stays put in the world.
    expect(clipGroundSpeed(rig(), stride(2))).toBeCloseTo(2, 1);
  });

  it('measures in the model\'s units, its rig scaled as the model scales it', () => {
    const model = rig();
    const armature = new THREE.Group();
    armature.scale.setScalar(0.01);
    const hips = model.children[0];
    model.remove(hips);
    armature.add(hips);
    model.add(armature);
    expect(clipGroundSpeed(model, stride())).toBeCloseTo(0.02, 3);
  });

  it('is 0 without feet or without movement', () => {
    const still = new THREE.AnimationClip('Idle', 1, [new THREE.VectorKeyframeTrack('mixamorigHips.position', [0, 1], [0, 1, 0, 0, 1, 0])]);
    expect(clipGroundSpeed(rig(), still)).toBeCloseTo(0, 5);
    expect(clipGroundSpeed(new THREE.Group(), stride())).toBe(0);
  });
});

describe('ground speed play rate', () => {
  const speeds: Record<string, number> = { Walk: 2, Run: 6, Idle: 0 };
  const speedOf = (name: string) => speeds[name] ?? 0;

  it('plays a clip at the rate that carries the character at its real speed', () => {
    expect(groundSpeedRate(3, { Walk: 1 }, speedOf)).toBeCloseTo(1.5, 6);
    // A blend takes its clips' weighted speed.
    expect(groundSpeedRate(4, { Walk: 0.5, Run: 0.5 }, speedOf)).toBeCloseTo(1, 6);
    expect(groundSpeedRate(0.5, { Idle: 0.5, Walk: 0.5 }, speedOf)).toBeCloseTo(0.5, 6);
  });

  it('stays within its limits, and leaves clips that do not move alone', () => {
    expect(groundSpeedRate(100, { Walk: 1 }, speedOf)).toBe(MAX_GROUND_SPEED_RATE);
    expect(groundSpeedRate(0, { Walk: 1 }, speedOf)).toBe(MIN_GROUND_SPEED_RATE);
    expect(groundSpeedRate(3, { Idle: 1 }, speedOf)).toBe(1);
    expect(groundSpeedRate(3, {}, speedOf)).toBe(1);
  });
});
