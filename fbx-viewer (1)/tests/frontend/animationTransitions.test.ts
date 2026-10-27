import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TransitionInspector } from '../../components/AnimationGraph/Inspectors/TransitionInspector';
import {
  CONDITION_EPSILON,
  conditionMet,
  conditionsMet,
  selectTransition,
  transitionAppliesTo,
} from '../../components/AnimationGraph/utils/transitions';
import type { AnimationGraphData, ConditionOperator, GraphCondition, GraphTransition } from '../../types';

const t = (id: string, from: string, extra: Partial<GraphTransition> = {}): GraphTransition => ({
  id, fromStateId: from, toStateId: `${id}-to`, duration: 0.2, conditions: [], ...extra,
});

const cond = (variableId: string, operator: ConditionOperator, value: number | boolean): GraphCondition => ({
  variableId, operator, value,
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

describe('any-state transitions', () => {
  const die = t('die', 'idle', { toStateId: 'dead', anyState: true, conditions: [cond('hp', '<=', 0)] });

  it('is checked from every active state, ignoring fromStateId', () => {
    for (const active of ['idle', 'run', 'jump', 'not-in-graph']) {
      expect(selectTransition([die], active, { hp: 0 }, null)).toBe(die);
      expect(selectTransition([die], active, { hp: 10 }, null)).toBeNull();
    }
  });

  it('is never checked from its own target state', () => {
    expect(selectTransition([die], 'dead', { hp: 0 }, null)).toBeNull();
  });

  it('applies to a state only by source unless it is an any-state transition', () => {
    const normal = t('run', 'idle', { toStateId: 'run' });
    expect(transitionAppliesTo(normal, 'idle')).toBe(true);
    expect(transitionAppliesTo(normal, 'jump')).toBe(false);
    expect(transitionAppliesTo(die, 'idle')).toBe(true);
    expect(transitionAppliesTo(die, 'jump')).toBe(true);
    expect(transitionAppliesTo(die, 'dead')).toBe(false);
    expect(transitionAppliesTo({ ...die, anyState: false }, 'jump')).toBe(false);
  });

  it('still waits for its exit time against the active state clip', () => {
    const hit = t('hit', 'idle', { toStateId: 'flinch', anyState: true, exitTime: 0.5 });
    expect(selectTransition([hit], 'run', {}, 0.25)).toBeNull();
    expect(selectTransition([hit], 'run', {}, 0.75)).toBe(hit);
    expect(selectTransition([hit], 'run', {}, null)).toBeNull();
  });

  it('needs conditions or an exit time like any other transition', () => {
    expect(selectTransition([t('free', 'idle', { anyState: true })], 'run', {}, 1)).toBeNull();
  });
});

describe('condition match mode', () => {
  const conditions = [cond('jump', '==', true), cond('speed', '>', 5)];

  it("'all' (the default) needs every condition", () => {
    const all = t('all', 'idle', { conditions });
    expect(selectTransition([all], 'idle', { jump: true, speed: 1 }, null)).toBeNull();
    expect(selectTransition([all], 'idle', { jump: true, speed: 6 }, null)).toBe(all);
    expect(conditionsMet({ ...all, conditionMode: 'all' }, { jump: false, speed: 6 })).toBe(false);
  });

  it("'any' passes when at least one condition holds", () => {
    const any = t('any', 'idle', { conditions, conditionMode: 'any' });
    expect(selectTransition([any], 'idle', { jump: false, speed: 1 }, null)).toBeNull();
    expect(selectTransition([any], 'idle', { jump: true, speed: 1 }, null)).toBe(any);
    expect(selectTransition([any], 'idle', { jump: false, speed: 6 }, null)).toBe(any);
    expect(selectTransition([any], 'idle', { jump: true, speed: 6 }, null)).toBe(any);
    expect(selectTransition([any], 'idle', {}, null)).toBeNull();
  });

  it("'any' with no conditions still needs an exit time", () => {
    const none = t('none', 'idle', { conditionMode: 'any' });
    expect(conditionsMet(none, {})).toBe(true);
    expect(selectTransition([none], 'idle', {}, 0.5)).toBeNull();
    const timed = t('timed', 'idle', { conditionMode: 'any', exitTime: 0.8 });
    expect(selectTransition([timed], 'idle', {}, 0.5)).toBeNull();
    expect(selectTransition([timed], 'idle', {}, 0.9)).toBe(timed);
  });

  it("'any' combines with an exit time", () => {
    const any = t('any', 'attack', { conditions, conditionMode: 'any', exitTime: 0.5 });
    expect(selectTransition([any], 'attack', { jump: true, speed: 0 }, 0.4)).toBeNull();
    expect(selectTransition([any], 'attack', { jump: false, speed: 0 }, 0.6)).toBeNull();
    expect(selectTransition([any], 'attack', { jump: false, speed: 9 }, 0.6)).toBe(any);
  });
});

describe('transition priority', () => {
  const ready = [cond('go', '==', true)];

  it('picks the highest priority among ready transitions regardless of order', () => {
    const low = t('low', 'idle', { conditions: ready, priority: 1 });
    const high = t('high', 'idle', { conditions: ready, priority: 5 });
    const mid = t('mid', 'idle', { conditions: ready, priority: 3 });
    expect(selectTransition([low, high, mid], 'idle', { go: true }, null)).toBe(high);
    expect(selectTransition([mid, low, high], 'idle', { go: true }, null)).toBe(high);
  });

  it('keeps array order on ties, with a missing priority counting as 0', () => {
    const first = t('first', 'idle', { conditions: ready });
    const second = t('second', 'idle', { conditions: ready, priority: 0 });
    expect(selectTransition([first, second], 'idle', { go: true }, null)).toBe(first);
    expect(selectTransition([second, first], 'idle', { go: true }, null)).toBe(second);
    const a = t('a', 'idle', { conditions: ready, priority: 2 });
    const b = t('b', 'idle', { conditions: ready, priority: 2 });
    expect(selectTransition([a, b], 'idle', { go: true }, null)).toBe(a);
  });

  it('skips a higher priority transition that is not ready', () => {
    const blocked = t('blocked', 'idle', { conditions: [cond('go', '==', false)], priority: 10 });
    const waiting = t('waiting', 'idle', { exitTime: 0.9, priority: 10 });
    const open = t('open', 'idle', { conditions: ready });
    expect(selectTransition([blocked, waiting, open], 'idle', { go: true }, 0.5)).toBe(open);
    expect(selectTransition([blocked, waiting, open], 'idle', { go: true }, 0.95)).toBe(waiting);
  });

  it('ignores transitions from other states even with a higher priority', () => {
    const elsewhere = t('elsewhere', 'run', { conditions: ready, priority: 10 });
    const here = t('here', 'idle', { conditions: ready });
    expect(selectTransition([elsewhere, here], 'idle', { go: true }, null)).toBe(here);
  });

  it('lets negative priorities lose and treats non-finite priorities as 0', () => {
    const negative = t('negative', 'idle', { conditions: ready, priority: -1 });
    const plain = t('plain', 'idle', { conditions: ready });
    const broken = t('broken', 'idle', { conditions: ready, priority: Number.NaN });
    expect(selectTransition([negative, plain], 'idle', { go: true }, null)).toBe(plain);
    expect(selectTransition([negative], 'idle', { go: true }, null)).toBe(negative);
    expect(selectTransition([broken, plain], 'idle', { go: true }, null)).toBe(broken);
    expect(selectTransition([negative, broken], 'idle', { go: true }, null)).toBe(broken);
  });

  it('orders any-state transitions with the rest by priority', () => {
    const local = t('local', 'idle', { conditions: ready, priority: 1 });
    const global = t('global', 'idle', { toStateId: 'stun', anyState: true, conditions: ready, priority: 2 });
    expect(selectTransition([local, global], 'idle', { go: true }, null)).toBe(global);
    expect(selectTransition([local, { ...global, priority: 1 }], 'idle', { go: true }, null)).toBe(local);
  });
});

describe('condition operators', () => {
  it('compares numbers for equality within an epsilon of 1e-4', () => {
    expect(CONDITION_EPSILON).toBe(1e-4);
    expect(conditionMet(cond('x', '==', 0.3), { x: 0.1 + 0.2 })).toBe(true);
    expect(conditionMet(cond('x', '==', 1), { x: 1.00005 })).toBe(true);
    expect(conditionMet(cond('x', '==', 1), { x: 0.99995 })).toBe(true);
    expect(conditionMet(cond('x', '==', 1), { x: 1.001 })).toBe(false);
    expect(conditionMet(cond('x', '!=', 0.3), { x: 0.1 + 0.2 })).toBe(false);
    expect(conditionMet(cond('x', '!=', 1), { x: 1.00005 })).toBe(false);
    expect(conditionMet(cond('x', '!=', 1), { x: 1.001 })).toBe(true);
  });

  it('keeps boolean equality strict', () => {
    expect(conditionMet(cond('b', '==', true), { b: true })).toBe(true);
    expect(conditionMet(cond('b', '==', true), { b: false })).toBe(false);
    expect(conditionMet(cond('b', '!=', true), { b: false })).toBe(true);
    expect(conditionMet(cond('b', '==', 1), { b: true })).toBe(false);
    expect(conditionMet(cond('b', '!=', 1), { b: true })).toBe(true);
  });

  it('returns false for ordered comparisons against a boolean variable', () => {
    for (const operator of ['>', '<', '>=', '<='] as const) {
      for (const value of [true, false]) {
        expect(conditionMet(cond('b', operator, 0), { b: value })).toBe(false);
        expect(conditionMet(cond('b', operator, 1), { b: value })).toBe(false);
        expect(conditionMet(cond('b', operator, value), { b: value })).toBe(false);
      }
      expect(conditionMet(cond('n', operator, true), { n: 1 })).toBe(false);
    }
  });

  it('keeps ordered numeric comparisons exact', () => {
    expect(conditionMet(cond('x', '>', 1), { x: 1.00005 })).toBe(true);
    expect(conditionMet(cond('x', '>', 1), { x: 1 })).toBe(false);
    expect(conditionMet(cond('x', '<', 1), { x: 0.5 })).toBe(true);
    expect(conditionMet(cond('x', '>=', 1), { x: 1 })).toBe(true);
    expect(conditionMet(cond('x', '<=', 1), { x: 1 })).toBe(true);
    expect(conditionMet(cond('x', '<=', 1), { x: 1.5 })).toBe(false);
  });

  it('never matches a missing variable', () => {
    for (const operator of ['>', '<', '>=', '<=', '==', '!='] as const) {
      expect(conditionMet(cond('missing', operator, 0), {})).toBe(false);
    }
  });
});

const graph: AnimationGraphData = {
  variables: [
    { id: 'speed', name: 'Speed', type: 'Float', value: 0 },
    { id: 'grounded', name: 'Grounded', type: 'Boolean', value: true },
  ],
  inputs: [],
  states: [
    { id: 'idle', name: 'Idle', position: { x: 0, y: 0 }, loop: true, stateType: 'Single', clipName: null, blendSamples: [], blendParamX: '', blendParamY: '' },
    { id: 'run', name: 'Run', position: { x: 200, y: 0 }, loop: true, stateType: 'Single', clipName: null, blendSamples: [], blendParamX: '', blendParamY: '' },
  ],
  transitions: [],
  activeStateId: 'idle',
};

/** Renders the inspector with its transition held in state, and records every update it writes. */
const renderInspector = (initial: Partial<GraphTransition> = {}) => {
  const updates: Partial<GraphTransition>[] = [];
  let latest: GraphTransition = { id: 'tr', fromStateId: 'idle', toStateId: 'run', duration: 0.2, conditions: [], ...initial };
  const Harness = () => {
    const [transition, setTransition] = React.useState(latest);
    return React.createElement(TransitionInspector, {
      transition,
      graph,
      onDelete: () => undefined,
      updateTransition: (patch: Partial<GraphTransition>) => {
        updates.push(patch);
        setTransition(previous => {
          latest = { ...previous, ...patch };
          return latest;
        });
      },
    });
  };
  render(React.createElement(Harness));
  return { updates, current: () => latest };
};

const hasNaN = (updates: Partial<GraphTransition>[]) =>
  updates.some(update => Object.values(update).some(value => typeof value === 'number' && Number.isNaN(value)));

describe('TransitionInspector', () => {
  it('toggles "From any state" and shows Any State as the source', () => {
    const { updates, current } = renderInspector();
    const toggle = screen.getByLabelText('From any state');
    expect(toggle).not.toBeChecked();
    expect(screen.getByText('Idle')).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(updates.at(-1)).toEqual({ anyState: true });
    expect(screen.getByLabelText('From any state')).toBeChecked();
    expect(screen.getByText('Any State')).toBeInTheDocument();
    expect(screen.queryByText('Idle')).toBeNull();

    fireEvent.click(screen.getByLabelText('From any state'));
    expect(updates.at(-1)).toEqual({ anyState: undefined });
    expect(current().anyState).toBeUndefined();
  });

  it('switches the condition match between All and Any', () => {
    const { updates, current } = renderInspector();
    const match = screen.getByRole('combobox', { name: 'Match' });
    expect(match).toHaveTextContent('All');

    fireEvent.click(match);
    fireEvent.click(screen.getByRole('option', { name: 'Any' }));
    expect(updates.at(-1)).toEqual({ conditionMode: 'any' });
    expect(screen.getByRole('combobox', { name: 'Match' })).toHaveTextContent('Any');

    fireEvent.click(screen.getByRole('combobox', { name: 'Match' }));
    fireEvent.click(screen.getByRole('option', { name: 'All' }));
    expect(updates.at(-1)).toEqual({ conditionMode: undefined });
    expect(current().conditionMode).toBeUndefined();
  });

  it('edits the priority and never writes NaN', () => {
    const { updates, current } = renderInspector();
    const priority = screen.getByLabelText('Priority') as HTMLInputElement;
    expect(priority.value).toBe('0');

    fireEvent.change(priority, { target: { value: '3' } });
    expect(current().priority).toBe(3);
    fireEvent.change(priority, { target: { value: '-2' } });
    expect(current().priority).toBe(-2);

    const before = updates.length;
    fireEvent.change(priority, { target: { value: '' } });
    expect(updates.length).toBe(before);
    expect(current().priority).toBe(-2);
    fireEvent.blur(priority);
    expect(priority.value).toBe('-2');

    fireEvent.change(priority, { target: { value: '0' } });
    expect(updates.at(-1)).toEqual({ priority: undefined });
    expect(hasNaN(updates)).toBe(false);
  });

  it('keeps the old duration when the field is emptied', () => {
    const { updates, current } = renderInspector({ duration: 0.4 });
    const duration = screen.getByLabelText('Blend Duration (s)') as HTMLInputElement;
    expect(duration.value).toBe('0.4');

    fireEvent.change(duration, { target: { value: '0.75' } });
    expect(current().duration).toBe(0.75);

    const before = updates.length;
    fireEvent.change(duration, { target: { value: '' } });
    expect(updates.length).toBe(before);
    expect(duration.value).toBe('');
    fireEvent.blur(duration);
    expect(duration.value).toBe('0.75');

    fireEvent.change(duration, { target: { value: '-1' } });
    expect(current().duration).toBe(0);
    expect(hasNaN(updates)).toBe(false);
  });

  it('clears the exit time when emptied and clamps it to 0..1', () => {
    const { updates, current } = renderInspector({ exitTime: 0.5 });
    const exitTime = screen.getByLabelText('Exit Time (0-1, empty = none)') as HTMLInputElement;
    expect(exitTime.value).toBe('0.5');

    fireEvent.change(exitTime, { target: { value: '0.9' } });
    expect(current().exitTime).toBe(0.9);
    fireEvent.change(exitTime, { target: { value: '2' } });
    expect(current().exitTime).toBe(1);
    fireEvent.change(exitTime, { target: { value: '-0.5' } });
    expect(current().exitTime).toBe(0);

    fireEvent.change(exitTime, { target: { value: '' } });
    expect(updates.at(-1)).toEqual({ exitTime: undefined });
    expect(current().exitTime).toBeUndefined();
    fireEvent.blur(exitTime);
    expect(exitTime.value).toBe('');
    expect(hasNaN(updates)).toBe(false);
  });

  it('keeps a numeric condition value when its field is emptied', () => {
    const { updates, current } = renderInspector({ conditions: [cond('speed', '>', 0.5)] });
    const value = screen.getByLabelText('Condition value') as HTMLInputElement;
    fireEvent.change(value, { target: { value: '2' } });
    expect(current().conditions[0].value).toBe(2);

    const before = updates.length;
    fireEvent.change(value, { target: { value: '' } });
    expect(updates.length).toBe(before);
    expect(current().conditions[0].value).toBe(2);
    expect(updates.some(update => update.conditions?.some(c => typeof c.value === 'number' && Number.isNaN(c.value)))).toBe(false);
  });

  it('adds a boolean condition with a boolean value and offers only equality for it', () => {
    const boolFirst: AnimationGraphData = { ...graph, variables: [graph.variables[1], graph.variables[0]] };
    const updates: Partial<GraphTransition>[] = [];
    const transition: GraphTransition = { id: 'tr', fromStateId: 'idle', toStateId: 'run', duration: 0.2, conditions: [] };
    const { rerender } = render(React.createElement(TransitionInspector, {
      transition, graph: boolFirst, onDelete: () => undefined, updateTransition: patch => { updates.push(patch); },
    }));
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    expect(updates.at(-1)).toEqual({ conditions: [{ variableId: 'grounded', operator: '==', value: true }] });

    rerender(React.createElement(TransitionInspector, {
      transition: { ...transition, conditions: [cond('grounded', '==', true)] },
      graph: boolFirst, onDelete: () => undefined, updateTransition: patch => { updates.push(patch); },
    }));
    expect(screen.getByLabelText('Condition value')).toBeChecked();
    const [, operator] = screen.getAllByRole('combobox', { name: 'Select...' });
    fireEvent.click(operator);
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['==', '!=']);
  });

  it('resets operator and value when a condition switches between number and boolean variables', () => {
    const { current } = renderInspector({ conditions: [cond('speed', '>', 0.5)] });
    const [variable] = screen.getAllByRole('combobox', { name: 'Select...' });
    fireEvent.click(variable);
    fireEvent.click(screen.getByRole('option', { name: 'Grounded' }));
    expect(current().conditions[0]).toEqual({ variableId: 'grounded', operator: '==', value: true });

    fireEvent.click(screen.getAllByRole('combobox', { name: 'Select...' })[0]);
    fireEvent.click(screen.getByRole('option', { name: 'Speed' }));
    expect(current().conditions[0]).toEqual({ variableId: 'speed', operator: '==', value: 1 });
  });
});
