import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PLAYER_GRAPH } from '../../data/blueprints/player';
import { selectTransition } from '../../components/AnimationGraph/utils/transitions';
import { createNormalizedTimeReader } from '../../components/AnimationGraph/hooks/useGraphRuntime';
import { CHARACTER, isFalling } from '../../components/Sandbox/hooks/usePlayerPhysics';

const stateId = (name: string) => PLAYER_GRAPH.states.find(state => state.name === name)!.id;
const varId = (name: string) => PLAYER_GRAPH.variables.find(variable => variable.name === name)!.id;

/** Variables as play sets them, keyed by id the way the runtime stores them. */
const vars = (values: Record<string, number | boolean>) => {
  const base: Record<string, number | boolean> = {
    Speed: 0, IsJumping: false, IsSprinting: false, IsAiming: false, InputY: 0,
    IsGrounded: true, IsFalling: false, VerticalSpeed: 0,
  };
  return Object.fromEntries(Object.entries({ ...base, ...values }).map(([name, value]) => [varId(name), value]));
};

const next = (from: string, values: Record<string, number | boolean>, normalizedTime: number | null = 0) =>
  PLAYER_GRAPH.states.find(state => state.id === selectTransition(PLAYER_GRAPH.transitions, stateId(from), vars(values), normalizedTime)?.toStateId)?.name ?? null;

describe('player jump, fall and land states', () => {
  it('jumps, falls past the top, lands and returns to Idle', () => {
    const airborne = { IsJumping: true, IsGrounded: false, IsFalling: true };
    expect(next('Idle', { ...airborne, VerticalSpeed: 5 })).toBe('Jump');
    expect(next('Jump', { ...airborne, VerticalSpeed: 2 })).toBeNull();
    expect(next('Jump', { ...airborne, VerticalSpeed: -0.5 })).toBe('Falling');
    expect(next('Falling', { ...airborne, VerticalSpeed: -6 })).toBeNull();
    expect(next('Falling', {})).toBe('Land');
    expect(next('Land', {}, 0.5)).toBeNull();
    expect(next('Land', {}, 0.85)).toBe('Idle');
  });

  it('cuts the landing short when moving, and lands from a jump that never fell', () => {
    expect(next('Land', { Speed: 1 })).toBe('Walk');
    expect(next('Jump', {})).toBe('Land');
  });

  it('does not fall for a bump, but does off a ledge', () => {
    expect(next('Run', { Speed: 1, IsSprinting: true, InputY: 1, IsJumping: true, IsGrounded: false, VerticalSpeed: -1 })).toBeNull();
    expect(next('Run', { Speed: 1, IsSprinting: true, InputY: 1, IsJumping: true, IsGrounded: false, IsFalling: true, VerticalSpeed: -3 })).toBe('Falling');
  });

  it('counts a fall only after a jump or a moment in the air', () => {
    expect(isFalling({ grounded: false, jumped: false, airborneTime: CHARACTER.FALL_DELAY / 2 })).toBe(false);
    expect(isFalling({ grounded: false, jumped: false, airborneTime: CHARACTER.FALL_DELAY * 2 })).toBe(true);
    expect(isFalling({ grounded: false, jumped: true, airborneTime: 0 })).toBe(true);
    expect(isFalling({ grounded: true, jumped: true, airborneTime: 1 })).toBe(false);
  });
});

describe('normalized time of a state without a clip', () => {
  it('reads as finished for a single state, so exit-time transitions leave it', () => {
    const states = PLAYER_GRAPH.states.map(state => ({ ...state, clipName: null }));
    const read = createNormalizedTimeReader(states, {});
    expect(read(stateId('Land'))).toBe(1);
    expect(next('Land', {}, read(stateId('Land')))).toBe('Idle');
  });

  it('stays unknown for a blend state, and real for a single state that has its clip', () => {
    const mixer = new THREE.AnimationMixer(new THREE.Object3D());
    const action = mixer.clipAction(new THREE.AnimationClip('Land', 2, []));
    action.play();
    mixer.update(0.5);
    const states = PLAYER_GRAPH.states.map(state => (state.name === 'Land' ? { ...state, clipName: 'Land' } : state));
    const read = createNormalizedTimeReader(states, { Land: action });
    expect(read(stateId('Strafe (Combat)'))).toBeNull();
    expect(read(stateId('Land'))).toBeCloseTo(0.25, 5);
  });
});
