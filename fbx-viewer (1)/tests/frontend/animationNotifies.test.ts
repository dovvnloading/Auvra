import { createElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { crossedNotifies } from '../../components/AnimationGraph/utils/notifies';
import { SingleStateConfig } from '../../components/AnimationGraph/Inspectors/SingleStateConfig';
import { animationEvents, createAnimationEvents, type AnimationEvent } from '../../runtime/animationEvents';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import type { AnimNotify, GraphState } from '../../types';

const n = (id: string, time: number): AnimNotify => ({ id, name: id, time });
const ids = (notifies: AnimNotify[]) => notifies.map(notify => notify.id);

// A 1 s clip with notifies on both edges and inside.
const NOTIFIES = [n('mid', 0.5), n('end', 1), n('start', 0), n('late', 0.95), n('early', 0.05)];

describe('crossedNotifies', () => {
  it('fires the notifies a forward step passed, in time order, owning its start and not its end', () => {
    const notifies = [n('c', 0.75), n('a', 0.25), n('b', 0.5)];
    expect(ids(crossedNotifies(notifies, 0.2, 0.5, 1, true, 1))).toEqual(['a']);
    expect(ids(crossedNotifies(notifies, 0.5, 0.8, 1, true, 1))).toEqual(['b', 'c']);
    expect(crossedNotifies(notifies, 0.8, 0.9, 1, true, 1)).toEqual([]);
  });

  it('fires a notify at the start on the first frame after entering the state', () => {
    expect(ids(crossedNotifies(NOTIFIES, 0, 0.1, 1, true, 1))).toEqual(['start', 'early']);
    expect(ids(crossedNotifies(NOTIFIES, 1, 0.9, 1, true, -1))).toEqual(['end', 'late']);
  });

  it('fires nothing for a step that does not advance', () => {
    expect(crossedNotifies(NOTIFIES, 0, 0, 1, true, 1)).toEqual([]);
    expect(crossedNotifies(NOTIFIES, 0.5, 0.5, 1, false, 1)).toEqual([]);
    expect(crossedNotifies(NOTIFIES, 0.2, 0.6, 1, true, 0)).toEqual([]);
  });

  it('fires both sides of the loop point when a forward loop wraps', () => {
    expect(ids(crossedNotifies(NOTIFIES, 0.9, 0.1, 1, true, 1))).toEqual(['late', 'end', 'start', 'early']);
  });

  it('fires both sides of the loop point when a reverse loop wraps', () => {
    expect(ids(crossedNotifies(NOTIFIES, 0.1, 0.9, 1, true, -1))).toEqual(['early', 'start', 'end', 'late']);
  });

  it('plays reverse steps in descending time, owning the start and not the end', () => {
    const notifies = [n('a', 0.25), n('b', 0.5), n('c', 0.75)];
    expect(ids(crossedNotifies(notifies, 0.8, 0.5, 1, true, -1))).toEqual(['c']);
    expect(ids(crossedNotifies(notifies, 0.5, 0.2, 1, true, -2))).toEqual(['b', 'a']);
  });

  it('fires a one-shot clip\'s end notify once when it clamps there', () => {
    expect(ids(crossedNotifies(NOTIFIES, 0.9, 1, 1, false, 1))).toEqual(['late', 'end']);
    expect(crossedNotifies(NOTIFIES, 1, 1, 1, false, 1)).toEqual([]);
    expect(ids(crossedNotifies(NOTIFIES, 0.1, 0, 1, false, -1))).toEqual(['early', 'start']);
    expect(crossedNotifies(NOTIFIES, 0, 0, 1, false, -1)).toEqual([]);
  });

  it('fires every notify of a one-shot clip that ends within its first frame', () => {
    expect(ids(crossedNotifies(NOTIFIES, 0, 1, 1, false, 1))).toEqual(['start', 'early', 'mid', 'late', 'end']);
  });

  it('does not treat a one-shot clip moving backwards as a wrap', () => {
    expect(crossedNotifies(NOTIFIES, 0.9, 0.1, 1, false, 1)).toEqual([]);
    expect(crossedNotifies(NOTIFIES, 0.1, 0.9, 1, false, -1)).toEqual([]);
  });

  it('never fires the same notify twice in one step', () => {
    const notify = n('dup', 0.5);
    expect(crossedNotifies([notify, notify], 0.4, 0.6, 1, true, 1)).toEqual([notify]);
    // A wrap covers [0.6, 1] and [0, 0.55); the duplicate entry still fires once.
    expect(crossedNotifies([notify, notify], 0.6, 0.55, 1, true, 1)).toEqual([notify]);
  });

  it('keeps list order between notifies at the same time', () => {
    expect(ids(crossedNotifies([n('x', 0.5), n('y', 0.5)], 0.4, 0.6, 1, true, 1))).toEqual(['x', 'y']);
    expect(ids(crossedNotifies([n('x', 0.5), n('y', 0.5)], 0.6, 0.4, 1, true, -1))).toEqual(['x', 'y']);
  });

  it('clamps notify times onto the clip and skips non-finite ones', () => {
    const notifies = [n('past', 3), n('before', -1), n('broken', Number.NaN)];
    expect(ids(crossedNotifies(notifies, 0.9, 1, 1, false, 1))).toEqual(['past']);
    expect(ids(crossedNotifies(notifies, 0, 0.1, 1, true, 1))).toEqual(['before']);
  });

  it('fires nothing without notifies, a clip duration, or finite times', () => {
    expect(crossedNotifies(undefined, 0, 0.5, 1, true, 1)).toEqual([]);
    expect(crossedNotifies([], 0, 0.5, 1, true, 1)).toEqual([]);
    expect(crossedNotifies(NOTIFIES, 0, 0.5, 0, true, 1)).toEqual([]);
    expect(crossedNotifies(NOTIFIES, Number.NaN, 0.5, 1, true, 1)).toEqual([]);
    expect(crossedNotifies(NOTIFIES, 0, Number.POSITIVE_INFINITY, 1, true, 1)).toEqual([]);
    expect(crossedNotifies(NOTIFIES, 0, 0.5, 1, true, Number.NaN)).toEqual([]);
  });

  it.each([1, -1])('fires each notify once per pass over several loops (time scale %d)', (timeScale) => {
    const duration = 1;
    const delta = 0.13;
    const fired = new Map<string, number>();
    let time = timeScale > 0 ? 0 : duration;
    let previous = time;
    let passes = 0;
    for (let frame = 0; frame < 77; frame += 1) {
      time = ((time + delta * timeScale) % duration + duration) % duration;
      if (timeScale > 0 ? time < previous : time > previous) passes += 1;
      crossedNotifies(NOTIFIES, previous, time, duration, true, timeScale)
        .forEach(notify => fired.set(notify.id, (fired.get(notify.id) ?? 0) + 1));
      previous = time;
    }
    // 77 frames of 0.13 s travel 10.01 s: ten wraps, and every notify is passed once per loop. The
    // notify at the start also fires on entry, so it is passed once more than the rest.
    expect(passes).toBe(10);
    const first = timeScale > 0 ? 'start' : 'end';
    NOTIFIES.forEach(notify => expect(fired.get(notify.id)).toBe(notify.id === first ? passes + 1 : passes));
  });
});

describe('animation events', () => {
  const event: AnimationEvent = { objectId: 'hero', stateName: 'Run', name: 'Footstep' };

  it('delivers to every listener in subscription order until unsubscribed', () => {
    const events = createAnimationEvents();
    const calls: string[] = [];
    const offA = events.subscribe(e => calls.push(`a:${e.name}`));
    events.subscribe(e => calls.push(`b:${e.stateName}`));
    events.emit(event);
    offA();
    events.emit(event);
    expect(calls).toEqual(['a:Footstep', 'b:Run', 'b:Run']);
  });

  it('keeps delivering when a listener throws', () => {
    const events = createAnimationEvents();
    const error = vi.spyOn(frontendDiagnostics, 'failure').mockImplementation(() => undefined);
    const after = vi.fn();
    events.subscribe(() => { throw new Error('boom'); });
    events.subscribe(after);
    events.emit(event);
    expect(after).toHaveBeenCalledWith(event);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('does not skip a listener when an earlier one unsubscribes mid-delivery', () => {
    const events = createAnimationEvents();
    const second = vi.fn();
    const offFirst = events.subscribe(() => offFirst());
    events.subscribe(second);
    events.emit(event);
    events.emit(event);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('keeps separate buses apart and offers a shared one', () => {
    const one = createAnimationEvents();
    const listener = vi.fn();
    one.subscribe(listener);
    createAnimationEvents().emit(event);
    expect(listener).not.toHaveBeenCalled();

    const shared = vi.fn();
    const off = animationEvents.subscribe(shared);
    animationEvents.emit({ ...event, objectId: null });
    off();
    expect(shared).toHaveBeenCalledWith({ objectId: null, stateName: 'Run', name: 'Footstep' });
  });
});

describe('SingleStateConfig playback settings', () => {
  const state = (extra: Partial<GraphState> = {}): GraphState => ({
    id: 's', name: 'Run', position: { x: 0, y: 0 }, loop: true, stateType: 'Single', clipName: 'run',
    blendSamples: [], blendParamX: '', blendParamY: '', ...extra,
  });
  const floatOptions = [{ label: '-- None --', value: '' }, { label: 'Speed', value: 'speed' }];
  const renderConfig = (node: GraphState) => {
    const updateState = vi.fn();
    render(createElement(SingleStateConfig, {
      node, updateState, clipOptions: [{ label: 'run', value: 'run' }], playRateParamOptions: floatOptions,
    }));
    return updateState;
  };
  const commit = (editLabel: string, value: string, index = 0) => {
    fireEvent.click(screen.getAllByRole('button', { name: editLabel })[index]);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
  };

  it('shows a default play rate of 1 and commits only finite rates', () => {
    const updateState = renderConfig(state());
    expect(screen.getByRole('button', { name: 'Edit Rate' })).toHaveTextContent('1.00');
    commit('Edit Rate', '');
    commit('Edit Rate', '1e999');
    expect(updateState).not.toHaveBeenCalled();
    commit('Edit Rate', '-0.5');
    expect(updateState).toHaveBeenCalledWith({ playRate: -0.5 });
  });

  it('picks a Float variable for the play rate and clears it with None', () => {
    const updateState = renderConfig(state({ playRateParam: 'speed' }));
    const trigger = screen.getByRole('combobox', { name: 'Play Rate Variable' });
    expect(trigger).toHaveTextContent('Speed');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: '-- None --' }));
    expect(updateState).toHaveBeenCalledWith({ playRateParam: undefined });
  });

  it('toggles root motion', () => {
    const updateState = renderConfig(state());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Root Motion' }));
    expect(updateState).toHaveBeenCalledWith({ rootMotion: true });
  });

  it('adds, renames, retimes and removes notifies', () => {
    const existing = [n('a', 0.2), n('b', 0.4)];
    const updateState = renderConfig(state({ notifies: existing }));

    fireEvent.click(screen.getByRole('button', { name: 'Add notify' }));
    const added = updateState.mock.calls[0][0].notifies as AnimNotify[];
    expect(added).toHaveLength(3);
    expect(added[2]).toMatchObject({ name: 'Notify 3', time: 0 });
    expect(typeof added[2].id).toBe('string');

    fireEvent.change(screen.getAllByRole('textbox', { name: 'Notify name' })[1], { target: { value: 'Footstep' } });
    expect(updateState).toHaveBeenLastCalledWith({ notifies: [existing[0], { ...existing[1], name: 'Footstep' }] });

    commit('Edit Time', 'abc', 0);
    expect(updateState).toHaveBeenCalledTimes(2);
    commit('Edit Time', '-3', 0);
    expect(updateState).toHaveBeenLastCalledWith({ notifies: [{ ...existing[0], time: 0 }, existing[1]] });
    commit('Edit Time', '0.35', 0);
    expect(updateState).toHaveBeenLastCalledWith({ notifies: [{ ...existing[0], time: 0.35 }, existing[1]] });

    fireEvent.click(screen.getByRole('button', { name: 'Remove notify a' }));
    expect(updateState).toHaveBeenLastCalledWith({ notifies: [existing[1]] });
  });
});
