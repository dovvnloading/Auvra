import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { stepActionWeights } from '../../components/AnimationGraph/hooks/useGraphAnimator';
import { createNormalizedTimeReader } from '../../components/AnimationGraph/hooks/useGraphRuntime';
import { selectTransition } from '../../components/AnimationGraph/utils/transitions';
import type { GraphState, GraphTransition } from '../../types';

const sum = (weights: Record<string, number>) => Object.values(weights).reduce((a, b) => a + b, 0);

describe('animation graph weight stepping', () => {
  it('keeps the weights summing to one through an interrupted crossfade', () => {
    // Enemy graph: Idle->Chase (0.2 s) is interrupted 0.1 s in by Chase->Attack (0.1 s).
    const dt = 1 / 60;
    let weights: Record<string, number> = { Idle: 1, Run: 0, Attack: 0 };
    let minSum = Infinity;
    for (let i = 0; i < 6; i++) {
      weights = stepActionWeights(weights, { Run: 1 }, dt, 0.2);
      minSum = Math.min(minSum, sum(weights));
    }
    expect(weights.Idle).toBeGreaterThan(0.4);
    expect(weights.Run).toBeGreaterThan(0.4);

    let frames = 0;
    while (weights.Attack < 1 && frames < 60) {
      weights = stepActionWeights(weights, { Attack: 1 }, dt, 0.1);
      minSum = Math.min(minSum, sum(weights));
      frames++;
    }
    expect(minSum).toBeCloseTo(1, 6);
    expect(weights).toEqual({ Idle: 0, Run: 0, Attack: 1 });
    // The interrupted crossfade still completes within the new transition's duration.
    expect(frames * dt).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it('keeps a Blend2D moving from its centre to a corner at full weight', () => {
    let weights: Record<string, number> = { A: 0.25, B: 0.25, C: 0.25, D: 0.25 };
    for (let i = 0; i < 30; i++) {
      weights = stepActionWeights(weights, { A: 1, B: 0, C: 0, D: 0 }, 1 / 60, 0.2);
      expect(sum(weights)).toBeCloseTo(1, 6);
    }
    expect(weights.A).toBe(1);
  });

  it('still fades out to rest when the state has no clips', () => {
    const weights = stepActionWeights({ Idle: 1, Run: 0 }, {}, 0.05, 0.2);
    expect(weights.Idle).toBeCloseTo(0.75);
    expect(weights.Run).toBe(0);
  });
});

const singleState = (id: string, clipName: string, loop: boolean): GraphState => ({
  id, name: id, position: { x: 0, y: 0 }, loop, stateType: 'Single', clipName,
  blendSamples: [], blendParamX: '', blendParamY: '',
});

const makeAction = (name: string, loop: boolean) => {
  const mixer = new THREE.AnimationMixer(new THREE.Object3D());
  const clip = new THREE.AnimationClip(name, 1, [new THREE.NumberKeyframeTrack('.position[x]', [0, 1], [0, 1])]);
  const action = mixer.clipAction(clip);
  action.clampWhenFinished = true;
  action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
  action.play();
  return { mixer, action };
};

const backToIdle: GraphTransition = { id: 'back', fromStateId: 'walk', toStateId: 'idle', duration: 0.2, conditions: [], exitTime: 1 };

describe('animation graph normalized time', () => {
  it('fires an exit time of 1 at the end of a looping clip', () => {
    const { mixer, action } = makeAction('Walk', true);
    const read = createNormalizedTimeReader([singleState('walk', 'Walk', true)], { Walk: action });
    const dt = 1 / 60;
    let firedAt: number | null = null;
    let maxRaw = 0;
    for (let frame = 0; frame < 120 && firedAt === null; frame++) {
      maxRaw = Math.max(maxRaw, action.time / 1);
      if (selectTransition([backToIdle], 'walk', {}, read('walk'))) firedAt = frame * dt;
      mixer.update(dt);
    }
    // three wraps the time, so the raw fraction alone never reaches 1.
    expect(maxRaw).toBeLessThan(1);
    expect(firedAt).not.toBeNull();
    expect(firedAt!).toBeGreaterThan(0.95);
    expect(firedAt!).toBeLessThan(1.05);
  });

  it('fires each cycle with the largest frame step', () => {
    const { mixer, action } = makeAction('Walk', true);
    const read = createNormalizedTimeReader([singleState('walk', 'Walk', true)], { Walk: action });
    let fires = 0;
    for (let frame = 0; frame < 30; frame++) {
      if (selectTransition([backToIdle], 'walk', {}, read('walk'))) fires++;
      mixer.update(0.1);
    }
    expect(fires).toBe(2);
  });

  it('does not treat reversed playback as a loop wrap', () => {
    const { mixer, action } = makeAction('Walk', true);
    const read = createNormalizedTimeReader([singleState('walk', 'Walk', true)], { Walk: action });
    action.timeScale = -1;
    for (let frame = 0; frame < 180; frame++) {
      expect(read('walk')).toBeLessThan(1);
      mixer.update(1 / 60);
    }
  });

  it('does not treat a clip reset just after entering the state as a loop wrap', () => {
    const { mixer, action } = makeAction('Walk', true);
    const read = createNormalizedTimeReader([singleState('walk', 'Walk', true)], { Walk: action });
    for (let frame = 0; frame < 3; frame++) mixer.update(1 / 60);
    expect(read('walk')).toBeCloseTo(0.05);
    action.reset();
    expect(read('walk')).toBe(0);
  });

  it('starts over when a different state is read', () => {
    const walk = makeAction('Walk', true);
    const idle = makeAction('Idle', true);
    const read = createNormalizedTimeReader(
      [singleState('walk', 'Walk', true), singleState('idle', 'Idle', true)],
      { Walk: walk.action, Idle: idle.action },
    );
    walk.mixer.update(0.9);
    expect(read('walk')).toBeCloseTo(0.9);
    expect(read('idle')).toBe(0);
    walk.mixer.update(0.2);
    expect(read('walk')).toBeCloseTo(0.1);
  });

  it('keeps one-shot clips clamped at 1 and returns null without a single clip', () => {
    const { mixer, action } = makeAction('Attack', false);
    const read = createNormalizedTimeReader(
      [singleState('attack', 'Attack', false), { ...singleState('blend', '', true), stateType: 'Blend2D', clipName: null }],
      { Attack: action },
    );
    mixer.update(0.5);
    expect(read('attack')).toBeCloseTo(0.5);
    mixer.update(0.7);
    expect(read('attack')).toBe(1);
    expect(read('blend')).toBeNull();
  });
});
