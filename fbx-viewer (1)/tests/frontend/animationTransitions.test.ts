import { describe, expect, it } from 'vitest';
import { selectTransition } from '../../components/AnimationGraph/utils/transitions';
import type { GraphTransition } from '../../types';

const t = (id: string, from: string, extra: Partial<GraphTransition> = {}): GraphTransition => ({
  id, fromStateId: from, toStateId: `${id}-to`, duration: 0.2, conditions: [], ...extra,
});

describe('animation transitions', () => {
  it('fires a conditioned transition only when all conditions hold', () => {
    const run = t('run', 'idle', { conditions: [{ variableId: 'speed', operator: '>', value: 0.5 }] });
    expect(selectTransition([run], 'idle', { speed: 0 }, null)).toBeNull();
    expect(selectTransition([run], 'idle', { speed: 1 }, null)).toBe(run);
    expect(selectTransition([run], 'walk', { speed: 1 }, null)).toBeNull();
  });

  it('returns from a one-shot state at its exit time without a variable', () => {
    const back = t('back', 'attack', { exitTime: 0.9 });
    expect(selectTransition([back], 'attack', {}, 0.5)).toBeNull();
    expect(selectTransition([back], 'attack', {}, 0.95)).toBe(back);
    expect(selectTransition([back], 'attack', {}, null)).toBeNull();
  });

  it('ignores unconditional transitions without an exit time', () => {
    expect(selectTransition([t('loop', 'idle')], 'idle', {}, 0.5)).toBeNull();
  });

  it('combines exit time with conditions', () => {
    const combo = t('combo', 'attack', { exitTime: 0.5, conditions: [{ variableId: 'fire', operator: '==', value: true }] });
    expect(selectTransition([combo], 'attack', { fire: true }, 0.4)).toBeNull();
    expect(selectTransition([combo], 'attack', { fire: false }, 0.6)).toBeNull();
    expect(selectTransition([combo], 'attack', { fire: true }, 0.6)).toBe(combo);
  });
});
