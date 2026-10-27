import { describe, expect, it } from 'vitest';
import { selectTransition, throughConduits } from '../../components/AnimationGraph/utils/transitions';
import type { GraphTransition } from '../../types';

const go = (id: string, from: string, to: string, variable: string, extra: Partial<GraphTransition> = {}): GraphTransition => ({
  id, fromStateId: from, toStateId: to, duration: 0.2, conditions: [{ variableId: variable, operator: '==', value: true }], ...extra,
});

// Walk and Run both enter the "Airborne" conduit when off the ground; it sends on to Jump or Fall.
const transitions = [
  go('walk-air', 'walk', 'air', 'offGround'),
  go('run-air', 'run', 'air', 'offGround'),
  go('air-jump', 'air', 'jump', 'rising', { duration: 0.1 }),
  go('air-fall', 'air', 'fall', 'falling', { duration: 0.3 }),
  go('walk-idle', 'walk', 'idle', 'stopped', { priority: -1 }),
];
const isConduit = (id: string) => id === 'air';

const route = (from: string, variables: Record<string, boolean>) => {
  const arrivals = new Map<GraphTransition, GraphTransition>();
  const chosen = selectTransition(transitions, from, variables, null, (candidate) => {
    const arrived = throughConduits(candidate, transitions, isConduit, variables);
    if (arrived) arrivals.set(candidate, arrived);
    return arrived !== null;
  });
  return chosen ? arrivals.get(chosen) ?? chosen : null;
};

describe('conduits', () => {
  it('pass straight through to the state their ready transition leads to, with its crossfade', () => {
    expect(route('walk', { offGround: true, rising: true })).toMatchObject({ toStateId: 'jump', duration: 0.1 });
    expect(route('run', { offGround: true, falling: true })).toMatchObject({ toStateId: 'fall', duration: 0.3 });
  });

  it('are not entered without a way on, so other transitions still fire', () => {
    expect(route('run', { offGround: true })).toBeNull();
    expect(route('walk', { offGround: true, stopped: true })?.toStateId).toBe('idle');
  });

  it('leave transitions that do not touch a conduit alone', () => {
    const plain = go('a-b', 'a', 'b', 'x');
    expect(throughConduits(plain, transitions, isConduit, {})).toBe(plain);
  });
});
