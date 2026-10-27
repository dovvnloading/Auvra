import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { syncBlendActions, syncedTimeScales, syncLeader } from '../../components/AnimationGraph/utils/syncGroups';
import { statePhase } from '../../components/AnimationGraph/hooks/useGraphAnimator';
import type { GraphState } from '../../types';

const action = (mixer: THREE.AnimationMixer, name: string, duration: number) => {
  const clip = new THREE.AnimationClip(name, duration, [new THREE.NumberKeyframeTrack('.opacity', [0, duration], [0, 1])]);
  const result = mixer.clipAction(clip);
  result.play();
  return result;
};

describe('sync groups', () => {
  it('runs blend samples of different lengths on one shared cycle', () => {
    const scales = syncedTimeScales({ Walk: 1, Run: 0.6 }, { Walk: 0.5, Run: 0.5 }, 1);
    // The blend's cycle is 0.8 s: the walk runs faster and the run slower to meet it.
    expect(scales.Walk).toBeCloseTo(1.25, 6);
    expect(scales.Run).toBeCloseTo(0.75, 6);
    expect(syncLeader({ Walk: 0.3, Run: 0.7 })).toBe('Run');
  });

  it('keeps every sample at the leading sample\'s phase as the blend plays', () => {
    const mixer = new THREE.AnimationMixer(new THREE.Object3D());
    const actions = { Walk: action(mixer, 'Walk', 1), Run: action(mixer, 'Run', 0.6) };
    const weights = { Walk: 0.25, Run: 0.75 };
    for (let frame = 0; frame < 40; frame += 1) {
      syncBlendActions(actions, weights, 1);
      mixer.update(1 / 30);
    }
    expect(actions.Walk.time / 1).toBeCloseTo(actions.Run.time / 0.6, 6);
  });

  it('reads a state\'s phase from its clip or its heaviest sample', () => {
    const mixer = new THREE.AnimationMixer(new THREE.Object3D());
    const actions = { Walk: action(mixer, 'Walk', 1), Run: action(mixer, 'Run', 0.6) };
    actions.Walk.time = 0.25;
    actions.Run.time = 0.3;
    const walk = { id: 'w', stateType: 'Single', clipName: 'Walk' } as GraphState;
    const locomotion = {
      id: 'l', stateType: 'Blend1D', clipName: null, blendParamX: 'speed', blendParamY: '',
      blendSamples: [{ id: 'a', clipName: 'Walk', position: [0, 0] }, { id: 'b', clipName: 'Run', position: [1, 0] }],
    } as unknown as GraphState;
    expect(statePhase(walk, {}, actions)).toBeCloseTo(0.25, 6);
    expect(statePhase(locomotion, { speed: 0.9 }, actions)).toBeCloseTo(0.5, 6);
  });
});
