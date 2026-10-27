import { describe, expect, it } from 'vitest';
import { statePlayRate, stateTargetWeights } from '../../components/AnimationGraph/hooks/useGraphAnimator';
import { createVariableResolver } from '../../components/AnimationGraph/hooks/useGraphRuntime';
import { bindingWrites, isEditableTarget } from '../../components/AnimationGraph/hooks/useInputHandler';
import { animNotifyMatches, timelineEventMatches } from '../../hooks/useLevelBlueprintRuntime';
import type { AnimationGraphData, GraphState, LogicNode } from '../../types';

const state = (overrides: Partial<GraphState>): GraphState => ({
  id: 's', name: 'S', position: { x: 0, y: 0 }, loop: true, stateType: 'Single', clipName: null,
  blendSamples: [], blendParamX: '', blendParamY: '', ...overrides,
});

const graph = (overrides: Partial<AnimationGraphData>): AnimationGraphData => ({
  variables: [], inputs: [], states: [], transitions: [], activeStateId: null, ...overrides,
});

describe('graph variable keys', () => {
  it('stores a variable by id whether it is set by id or by name', () => {
    const resolve = createVariableResolver([{ id: 'v1', name: 'Speed', type: 'Float', value: 0 }]);
    expect(resolve('v1')).toBe('v1');
    expect(resolve('Speed')).toBe('v1');
    expect(resolve('Stamina')).toBe('Stamina');
  });

  it('resolves an id that equals another variable name to the id', () => {
    const resolve = createVariableResolver([
      { id: 'a', name: 'b', type: 'Float', value: 0 },
      { id: 'b', name: 'Other', type: 'Float', value: 0 },
    ]);
    expect(resolve('b')).toBe('b');
  });
});

describe('graph input bindings', () => {
  const g = graph({
    variables: [{ id: 'v1', name: 'Speed', type: 'Float', value: 0 }, { id: 'v2', name: 'Crouch', type: 'Boolean', value: false }],
    inputs: [
      { id: 'p', key: 'KeyW', type: 'Press', targetVariableId: 'v1', targetValue: 1 },
      { id: 'r', key: 'KeyW', type: 'Release', targetVariableId: 'v1', targetValue: 0 },
      { id: 'h', key: 'KeyC', type: 'Hold', targetVariableId: 'v2', targetValue: true },
    ],
  });

  it('ignores auto-repeat for Press bindings', () => {
    expect(bindingWrites(g, 'KeyW', true, false)).toEqual([{ variableId: 'v1', value: 1 }]);
    expect(bindingWrites(g, 'KeyW', true, true)).toEqual([]);
    expect(bindingWrites(g, 'KeyW', false, false)).toEqual([{ variableId: 'v1', value: 0 }]);
  });

  it('puts a Hold variable back to its initial value on key up', () => {
    expect(bindingWrites(g, 'KeyC', true, false)).toEqual([{ variableId: 'v2', value: true }]);
    expect(bindingWrites(g, 'KeyC', false, false)).toEqual([{ variableId: 'v2', value: false }]);
  });

  it('treats text fields as editable targets', () => {
    expect(isEditableTarget(document.createElement('input'))).toBe(true);
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
    expect(isEditableTarget(document.createElement('div'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('state playback', () => {
  it('multiplies the play rate by its variable', () => {
    expect(statePlayRate(state({}), {})).toBe(1);
    expect(statePlayRate(state({ playRate: 1.5 }), {})).toBe(1.5);
    expect(statePlayRate(state({ playRate: 2, playRateParam: 'v' }), { v: -0.5 })).toBe(-1);
    expect(statePlayRate(state({ playRateParam: 'b' }), { b: false })).toBe(0);
    expect(statePlayRate(state({ playRate: Number.NaN }), {})).toBe(1);
  });

  it('weights a Single state, a Blend1D and a Blend2D', () => {
    const has = () => true;
    expect(stateTargetWeights(state({ clipName: 'Idle' }), {}, has)).toEqual({ Idle: 1 });
    expect(stateTargetWeights(state({ clipName: 'Idle' }), {}, () => false)).toEqual({});

    const blend1D = state({
      stateType: 'Blend1D', blendParamX: 'speed', blendSamples: [
        { id: 'a', clipName: 'Walk', position: [0, 0] },
        { id: 'b', clipName: 'Run', position: [1, 0] },
      ],
    });
    const w1 = stateTargetWeights(blend1D, { speed: 0.25 }, has);
    expect(w1.Walk).toBeCloseTo(0.75);
    expect(w1.Run).toBeCloseTo(0.25);

    const blend2D = state({
      stateType: 'Blend2D', blendParamX: 'x', blendParamY: 'y', blendSamples: [
        { id: 'a', clipName: 'A', position: [0, 0] },
        { id: 'b', clipName: 'B', position: [1, 0] },
        { id: 'c', clipName: 'C', position: [0, 1] },
      ],
    });
    const w2 = stateTargetWeights(blend2D, { x: 0, y: 0 }, has);
    expect(w2.A).toBeCloseTo(1);
    expect((w2.B ?? 0) + (w2.C ?? 0)).toBeCloseTo(0);
  });
});

describe('Animation Notify events', () => {
  const node = (data: Record<string, unknown>): LogicNode => ({
    id: 'n', type: 'Event', name: 'Event AnimNotify', position: { x: 0, y: 0 }, inputs: [], outputs: [], data,
  });

  it('matches by name and source', () => {
    const player = { objectId: 'player', stateName: 'Walk', name: 'Footstep' };
    const enemy = { objectId: 'enemy-1', stateName: 'Run', name: 'Footstep' };
    expect(animNotifyMatches(node({ notifyName: 'Footstep' }), player)).toBe(true);
    expect(animNotifyMatches(node({ notifyName: 'Hit' }), player)).toBe(false);
    expect(animNotifyMatches(node({ notifyName: '' }), player)).toBe(true);
    expect(animNotifyMatches(node({}), enemy)).toBe(false);
    expect(animNotifyMatches(node({ notifySource: 'enemies' }), enemy)).toBe(true);
    expect(animNotifyMatches(node({ notifySource: 'any' }), enemy)).toBe(true);
  });
});

describe('Timeline Event events', () => {
  it('matches by event name, empty taking any', () => {
    const node = (eventName: unknown): LogicNode => ({
      id: 'n', type: 'Event', name: 'Event TimelineEvent', position: { x: 0, y: 0 }, inputs: [], outputs: [], data: { eventName },
    });
    const event = { timelineObjectId: 't1', name: 'DoorOpened' };
    expect(timelineEventMatches(node('DoorOpened'), event)).toBe(true);
    expect(timelineEventMatches(node(' DoorOpened '), event)).toBe(true);
    expect(timelineEventMatches(node('Other'), event)).toBe(false);
    expect(timelineEventMatches(node(''), event)).toBe(true);
    expect(timelineEventMatches(node(undefined), event)).toBe(true);
  });
});
