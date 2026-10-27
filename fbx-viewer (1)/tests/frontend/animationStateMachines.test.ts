import { describe, expect, it } from 'vitest';
import { flattenStateMachines, graphLevel, levelActiveStateId, writeGraphLevel, authoredTransitionId } from '../../components/AnimationGraph/utils/stateMachines';
import { selectTransition } from '../../components/AnimationGraph/utils/transitions';
import type { AnimationGraphData, GraphState, GraphTransition } from '../../types';

const state = (id: string, extra: Partial<GraphState> = {}): GraphState => ({
  id, name: id, position: { x: 0, y: 0 }, loop: true, stateType: 'Single', clipName: id,
  blendSamples: [], blendParamX: '', blendParamY: '', ...extra,
});

const go = (id: string, from: string, to: string, extra: Partial<GraphTransition> = {}): GraphTransition => ({
  id, fromStateId: from, toStateId: to, duration: 0.2,
  conditions: [{ variableId: id, operator: '==', value: true }], ...extra,
});

/** Idle at the top, and a Locomotion machine holding Walk (its entry) and Run. */
const graph = (): AnimationGraphData => ({
  variables: [], inputs: [], activeStateId: null,
  states: [
    state('idle', { isRoot: true }),
    state('loco', {
      stateType: 'StateMachine', clipName: null,
      subGraph: {
        states: [state('walk', { isRoot: true }), state('run')],
        transitions: [go('toRun', 'walk', 'run'), go('toWalk', 'run', 'walk')],
      },
    }),
    state('dead', { loop: false }),
  ],
  transitions: [go('move', 'idle', 'loco'), go('stop', 'loco', 'idle'), go('die', 'idle', 'dead', { anyState: true })],
});

const take = (flat: AnimationGraphData, from: string, variable: string) =>
  selectTransition(flat.transitions, from, { [variable]: true }, null)?.toStateId ?? null;

describe('nested state machines', () => {
  it('leaves graphs without machines as they are', () => {
    const plain: AnimationGraphData = { ...graph(), states: [state('idle', { isRoot: true })], transitions: [] };
    expect(flattenStateMachines(plain)).toBe(plain);
  });

  it('plays a machine as its states: entering it starts its entry state', () => {
    const flat = flattenStateMachines(graph());
    expect(flat.states.map(s => s.id)).toEqual(['idle', 'loco/walk', 'loco/run', 'dead']);
    expect(flat.states.filter(s => s.isRoot).map(s => s.id)).toEqual(['idle']);
    expect(take(flat, 'idle', 'move')).toBe('loco/walk');
  });

  it('runs the machine\'s own transitions inside it and leaves it from any of its states', () => {
    const flat = flattenStateMachines(graph());
    expect(take(flat, 'loco/walk', 'toRun')).toBe('loco/run');
    expect(take(flat, 'loco/run', 'toWalk')).toBe('loco/walk');
    expect(take(flat, 'loco/walk', 'stop')).toBe('idle');
    expect(take(flat, 'loco/run', 'stop')).toBe('idle');
    // Leaving wins over a transition inside when both are ready.
    expect(selectTransition(flat.transitions, 'loco/walk', { stop: true, toRun: true }, null)?.toStateId).toBe('idle');
  });

  it('fires an any-state transition from every state, nested ones included, except its target', () => {
    const flat = flattenStateMachines(graph());
    for (const from of ['idle', 'loco/walk', 'loco/run']) expect(take(flat, from, 'die')).toBe('dead');
    expect(take(flat, 'dead', 'die')).toBeNull();
    const fired = flat.transitions.find(t => t.fromStateId === 'loco/run' && t.toStateId === 'dead')!;
    expect(authoredTransitionId(fired.id)).toBe('die');
  });

  it('starts in a machine\'s entry state when the graph does', () => {
    const nestedRoot = graph();
    nestedRoot.states[0].isRoot = false;
    nestedRoot.states[1].isRoot = true;
    const flat = flattenStateMachines(nestedRoot);
    expect(flat.states.filter(s => s.isRoot).map(s => s.id)).toEqual(['loco/walk']);
  });

  it('edits one level of the graph at a time', () => {
    const authored = graph();
    expect(graphLevel(authored, ['loco'])?.states.map(s => s.id)).toEqual(['walk', 'run']);
    expect(graphLevel(authored, ['idle'])).toBeNull();
    const update = writeGraphLevel(authored, ['loco'], { states: [state('walk', { isRoot: true })] });
    const loco = update.states!.find(s => s.id === 'loco')!;
    expect(loco.subGraph!.states.map(s => s.id)).toEqual(['walk']);
    expect(loco.subGraph!.transitions).toHaveLength(2);
    expect(update.transitions).toBeUndefined();
    expect(levelActiveStateId('loco/run', [])).toBe('loco');
    expect(levelActiveStateId('loco/run', ['loco'])).toBe('run');
    expect(levelActiveStateId('idle', ['loco'])).toBeNull();
  });
});
