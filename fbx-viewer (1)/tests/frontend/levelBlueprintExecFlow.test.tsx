import { act, renderHook } from '@testing-library/react';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { SandboxEntityHandle } from '../../components/Sandbox/SandboxEntity';
import { FLOW_NODE_DEFINITIONS, FlowNodeDefinition } from '../../hooks/levelBlueprintNodes/flow';
import { WORLD_NODE_DEFINITIONS, WorldNodeDefinition } from '../../hooks/levelBlueprintNodes/world';
import { useLevelBlueprintRuntime, UseLevelBlueprintRuntimeProps } from '../../hooks/useLevelBlueprintRuntime';
import type { LevelBlueprintData, LevelObject, LogicConnection, LogicNode, LogicPin } from '../../types';

/**
 * Exec wiring into the runtime: which input pin a wire enters, re-entry into multi-input
 * flow nodes, Delay loops, overlap Other Actor data, and unknown node types.
 */

const frame = vi.hoisted(() => ({ callback: null as ((state: unknown, delta: number) => void) | null }));

vi.mock('@react-three/fiber', () => ({
  useFrame: (callback: (state: unknown, delta: number) => void) => { frame.callback = callback; },
}));

const runFrames = (count: number) => {
  for (let i = 0; i < count; i += 1) act(() => { frame.callback?.({}, 1 / 60); });
};

const definitionOf = (type: string): FlowNodeDefinition | WorldNodeDefinition =>
  [...FLOW_NODE_DEFINITIONS, ...WORLD_NODE_DEFINITIONS].find(definition => definition.type === type)!;

/** Places a palette node the way the editor does: its pins get ids, its data starts from the defaults. */
const paletteNode = (id: string, type: string, data: Record<string, unknown> = {}): LogicNode => {
  const definition = definitionOf(type);
  return {
    id,
    type: definition.type,
    name: definition.title,
    position: { x: 0, y: 0 },
    inputs: definition.inputs.map(pin => ({ ...pin, id: `${id}:in:${pin.name}` })),
    outputs: definition.outputs.map(pin => ({ ...pin, id: `${id}:out:${pin.name}` })),
    data: { ...definition.data, ...data },
  };
};

const execPin = (id: string, name: string, direction: LogicPin['direction']): LogicPin => ({ id, name, dataType: 'Exec', direction });

const eventNode = (id: string, name: string, extraOutputs: LogicPin[] = [], data?: Record<string, unknown>): LogicNode => ({
  id, type: 'Event', name, position: { x: 0, y: 0 }, inputs: [], outputs: [execPin(`${id}:out:Out`, 'Out', 'Output'), ...extraOutputs], data,
});

const beginPlay = () => eventNode('begin', 'Event BeginPlay');
const tick = () => eventNode('tick', 'Event Tick', [{ id: 'tick:out:Delta Seconds', name: 'Delta Seconds', dataType: 'Float', direction: 'Output' }]);

const printString = (id: string, message: string, withStringPin = false): LogicNode => ({
  id, type: 'PrintString', name: 'Print String', position: { x: 0, y: 0 },
  inputs: [
    execPin(`${id}:in:In`, 'In', 'Input'),
    ...(withStringPin ? [{ id: `${id}:in:String`, name: 'String', dataType: 'String', direction: 'Input' } as LogicPin] : []),
  ],
  outputs: [execPin(`${id}:out:Out`, 'Out', 'Output')],
  data: { printMessage: message },
});

const branch = (id: string, condition?: boolean): LogicNode => ({
  id, type: 'Branch', name: 'Branch', position: { x: 0, y: 0 },
  inputs: [execPin(`${id}:in:In`, 'In', 'Input'), { id: `${id}:in:Condition`, name: 'Condition', dataType: 'Boolean', direction: 'Input' }],
  outputs: [execPin(`${id}:out:True`, 'True', 'Output'), execPin(`${id}:out:False`, 'False', 'Output')],
  data: condition === undefined ? undefined : { default_Condition: condition },
});

/** A node of a type no executor or built-in handles, with one exec input and output. */
const unknownNode = (id: string, type: string): LogicNode => ({
  id, type: type as LogicNode['type'], name: type, position: { x: 0, y: 0 },
  inputs: [execPin(`${id}:in:In`, 'In', 'Input')], outputs: [execPin(`${id}:out:Out`, 'Out', 'Output')],
});

/** Connects the named output pin of `from` to the named input pin of `to`. */
const wire = (from: LogicNode, fromPin: string, to: LogicNode, toPin: string): LogicConnection => ({
  id: `${from.id}.${fromPin}->${to.id}.${toPin}`,
  fromNodeId: from.id,
  fromPinId: from.outputs.find(pin => pin.name === fromPin)!.id,
  toNodeId: to.id,
  toPinId: to.inputs.find(pin => pin.name === toPin)!.id,
});

const graph = (nodes: LogicNode[], connections: LogicConnection[]): LevelBlueprintData => ({ nodes, connections, variables: [] });

const runtimeProps = (
  blueprint: LevelBlueprintData,
  addNotification: (notification: unknown) => void,
  overrides: Partial<UseLevelBlueprintRuntimeProps> = {},
): UseLevelBlueprintRuntimeProps => ({
  blueprint,
  levelObjects: [],
  playerEntityRef: { current: null },
  playerApiRef: { current: undefined },
  enemyApiRef: { current: undefined },
  destroyActor: () => undefined,
  addNotification,
  ...overrides,
});

const printed = (addNotification: ReturnType<typeof vi.fn>) =>
  addNotification.mock.calls.map(([notification]) => (notification as { message: string }).message);

describe('level blueprint runtime: exec wiring', () => {
  it('delivers an event wire on the Gate pin it enters (BeginPlay -> Open on a closed gate)', () => {
    const begin = beginPlay();
    const ticker = tick();
    const gate = paletteNode('gate', 'Gate', { 'default_Start Closed': true });
    const exit = printString('exit', 'exit');
    const addNotification = vi.fn();

    renderHook(() => useLevelBlueprintRuntime(runtimeProps(graph(
      [begin, ticker, gate, exit],
      [wire(begin, 'Out', gate, 'Open'), wire(ticker, 'Out', gate, 'Enter'), wire(gate, 'Exit', exit, 'In')],
    ), addNotification)));

    runFrames(3);
    expect(printed(addNotification)).toEqual(['[Output] exit', '[Output] exit', '[Output] exit']);
  });

  it('re-arms a DoOnce through its Reset pin from a built-in node (Branch.True -> Reset)', () => {
    const ticker = tick();
    const sequence = paletteNode('sequence', 'Sequence');
    const once = paletteNode('once', 'DoOnce');
    const done = printString('done', 'done');
    const choose = branch('branch', true);
    const addNotification = vi.fn();

    renderHook(() => useLevelBlueprintRuntime(runtimeProps(graph(
      [ticker, sequence, once, done, choose],
      [
        wire(ticker, 'Out', sequence, 'Exec'),
        wire(sequence, 'Then 0', once, 'Exec'),
        wire(once, 'Completed', done, 'In'),
        wire(sequence, 'Then 1', choose, 'In'),
        wire(choose, 'True', once, 'Reset'),
      ],
    ), addNotification)));

    runFrames(3);
    expect(printed(addNotification)).toHaveLength(3);
  });

  it('lets one through, then closes the gate from its own Exit chain (Exit -> Print -> Close)', () => {
    const ticker = tick();
    const gate = paletteNode('gate', 'Gate');
    const exit = printString('exit', 'exit');
    const addNotification = vi.fn();

    renderHook(() => useLevelBlueprintRuntime(runtimeProps(graph(
      [ticker, gate, exit],
      [wire(ticker, 'Out', gate, 'Enter'), wire(gate, 'Exit', exit, 'In'), wire(exit, 'Out', gate, 'Close')],
    ), addNotification)));

    runFrames(5);
    expect(printed(addNotification)).toEqual(['[Output] exit']);
  });

  it('closes the gate from a Sequence on its Exit chain (Exit -> Sequence -> Then 1 -> Close)', () => {
    const ticker = tick();
    const gate = paletteNode('gate', 'Gate');
    const sequence = paletteNode('sequence', 'Sequence');
    const exit = printString('exit', 'exit');
    const addNotification = vi.fn();

    renderHook(() => useLevelBlueprintRuntime(runtimeProps(graph(
      [ticker, gate, sequence, exit],
      [
        wire(ticker, 'Out', gate, 'Enter'),
        wire(gate, 'Exit', sequence, 'Exec'),
        wire(sequence, 'Then 0', exit, 'In'),
        wire(sequence, 'Then 1', gate, 'Close'),
      ],
    ), addNotification)));

    runFrames(5);
    expect(printed(addNotification)).toEqual(['[Output] exit']);
  });

  it('still drops a synchronous loop back into the same pin', () => {
    const begin = beginPlay();
    const gate = paletteNode('gate', 'Gate');
    const exit = printString('exit', 'exit');
    const addNotification = vi.fn();

    renderHook(() => useLevelBlueprintRuntime(runtimeProps(graph(
      [begin, gate, exit],
      [wire(begin, 'Out', gate, 'Enter'), wire(gate, 'Exit', exit, 'In'), wire(exit, 'Out', gate, 'Enter')],
    ), addNotification)));

    expect(printed(addNotification)).toEqual(['[Output] exit']);
  });

  it('keeps looping a Delay whose chain wires back into it', () => {
    const begin = beginPlay();
    // 0.02s at 60 fps comes due every second frame.
    const delay = paletteNode('delay', 'Delay', { default_Duration: 0.02 });
    const beat = printString('beat', 'tick');
    const addNotification = vi.fn();

    renderHook(() => useLevelBlueprintRuntime(runtimeProps(graph(
      [begin, delay, beat],
      [wire(begin, 'Out', delay, 'Exec'), wire(delay, 'Out', beat, 'In'), wire(beat, 'Out', delay, 'Exec')],
    ), addNotification)));

    runFrames(30);
    expect(printed(addNotification).length).toBeGreaterThan(1);
    expect(printed(addNotification)).toEqual(Array(15).fill('[Output] tick'));
  });

  it("feeds an overlap event's Other Actor to the nodes on its chain", () => {
    const crate: LevelObject = {
      id: 'crate', levelId: 'level-1', modelId: 'model-1', name: 'Crate', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], type: 'prop',
    };
    const overlap = eventNode('overlap', 'On Overlap (Crate)', [
      { id: 'overlap:out:Other Actor', name: 'Other Actor', dataType: 'Object', direction: 'Output' },
    ], { targetActorId: 'crate' });
    const impulse = paletteNode('impulse', 'ApplyImpulse', { 'default_Impulse Y': 5 });
    const transform = paletteNode('transform', 'GetActorTransform');
    const found = branch('found');
    const report = printString('report', 'none', true);
    const applyImpulse = vi.fn();
    const addNotification = vi.fn();
    const player = { object: new THREE.Group() } as unknown as SandboxEntityHandle;

    renderHook(() => useLevelBlueprintRuntime(runtimeProps(graph(
      [overlap, impulse, transform, found, report],
      [
        wire(overlap, 'Out', impulse, 'Exec'),
        wire(overlap, 'Other Actor', impulse, 'Actor'),
        wire(impulse, 'Out', found, 'In'),
        wire(overlap, 'Other Actor', transform, 'Actor'),
        wire(transform, 'Found', found, 'Condition'),
        wire(found, 'True', report, 'In'),
        wire(overlap, 'Other Actor', report, 'String'),
      ],
    ), addNotification, {
      levelObjects: [crate],
      playerEntityRef: { current: player },
      getObject: id => (id === 'crate' ? crate : null),
      applyImpulse,
    })));

    runFrames(1);
    expect(applyImpulse).toHaveBeenCalledWith('crate', [0, 5, 0]);
    expect(printed(addNotification)).toEqual(['[Output] crate']);
  });

  it.each(['valueOf', '__proto__', 'toString', 'hasOwnProperty', 'constructor'])(
    'skips a node typed %s and continues the chain',
    type => {
      const begin = beginPlay();
      const odd = unknownNode('odd', type);
      const after = printString('after', 'after');
      const addNotification = vi.fn();

      expect(() => renderHook(() => useLevelBlueprintRuntime(runtimeProps(graph(
        [begin, odd, after],
        [wire(begin, 'Out', odd, 'In'), wire(odd, 'Out', after, 'In')],
      ), addNotification)))).not.toThrow();
      runFrames(1);
      expect(printed(addNotification)).toEqual(['[Output] after']);
    },
  );
});
