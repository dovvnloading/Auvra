import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createLevelVariablesStore, levelVariables, useLevelVariable } from '../../runtime/levelVariables';
import { gameState, readGameStateBinding } from '../../runtime/gameState';
import type { GraphVariable } from '../../types';

const blueprintVariables: GraphVariable[] = [
  { id: 'v1', name: 'Score', type: 'Float', value: 5 },
  { id: 'v2', name: 'DoorOpen', type: 'Boolean', value: false },
];

afterEach(() => {
  levelVariables.reset();
  gameState.reset();
});

describe('level variables', () => {
  it('seeds from the blueprint and mirrors into gameState vars', () => {
    levelVariables.reset(blueprintVariables);
    expect(levelVariables.all()).toEqual({ Score: 5, DoorOpen: false });
    expect(readGameStateBinding(gameState.get(), 'vars.Score')).toBe(5);

    expect(levelVariables.set('Score', 12)).toBe(true);
    expect(levelVariables.set('DoorOpen', true)).toBe(true);
    expect(levelVariables.get('Score')).toBe(12);
    expect(readGameStateBinding(gameState.get(), 'vars.Score')).toBe(12);
    expect(readGameStateBinding(gameState.get(), 'vars.DoorOpen')).toBe(true);
  });

  it('keeps declared types and rejects values that do not fit', () => {
    const store = createLevelVariablesStore(() => {});
    store.reset([...blueprintVariables, { name: 'Broken', type: 'Float', value: Number.NaN }]);
    expect(store.get('Broken')).toBe(0);
    expect(store.set('Score', '7.5')).toBe(true);
    expect(store.get('Score')).toBe(7.5);
    expect(store.set('Score', 'lots')).toBe(false);
    expect(store.set('DoorOpen', 1)).toBe(true);
    expect(store.get('DoorOpen')).toBe(true);
    expect(store.set('DoorOpen', { open: true })).toBe(false);
    expect(store.set('  ', 1)).toBe(false);
    expect(store.get('Score')).toBe(7.5);
  });

  it('creates undeclared variables on first write and reset drops them', () => {
    const store = createLevelVariablesStore(() => {});
    store.reset(blueprintVariables);
    expect(store.set('Message', 'Find the key')).toBe(true);
    expect(store.set('Message', 3)).toBe(true);
    expect(store.get('Message')).toBe('3');
    store.reset(blueprintVariables);
    expect(store.get('Message')).toBeUndefined();
    expect(store.get('Score')).toBe(5);
  });

  it('notifies only on change and stops after unsubscribe', () => {
    const sync = vi.fn();
    const store = createLevelVariablesStore(sync);
    store.reset(blueprintVariables);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const before = store.all();
    store.set('Score', 5);
    expect(listener).not.toHaveBeenCalled();
    expect(store.all()).toBe(before);
    store.set('Score', 6);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenLastCalledWith({ Score: 6 });
    expect(store.all()).not.toBe(before);
    unsubscribe();
    store.set('Score', 7);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('drives React readers through useLevelVariable', () => {
    levelVariables.reset(blueprintVariables);
    const { result } = renderHook(() => useLevelVariable('Score'));
    expect(result.current).toBe(5);
    act(() => { levelVariables.set('Score', 9); });
    expect(result.current).toBe(9);
  });
});
