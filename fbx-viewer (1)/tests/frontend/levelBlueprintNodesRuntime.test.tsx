import { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_NODE_DEFINITIONS, FlowNodeDefinition } from '../../hooks/levelBlueprintNodes/flow';
import { WORLD_NODE_DEFINITIONS, WorldNodeDefinition } from '../../hooks/levelBlueprintNodes/world';
import { useLevelBlueprintRuntime, UseLevelBlueprintRuntimeProps } from '../../hooks/useLevelBlueprintRuntime';
import { levelVariables } from '../../runtime/levelVariables';
import type { LevelBlueprintData, LogicConnection, LogicNode, LogicPin } from '../../types';

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

const beginPlay = (): LogicNode => ({
  id: 'begin', type: 'Event', name: 'Event BeginPlay', position: { x: 0, y: 0 }, inputs: [], outputs: [execPin('begin:out:Out', 'Out', 'Output')],
});

const printString = (id: string, message: string): LogicNode => ({
  id, type: 'PrintString', name: 'Print String', position: { x: 0, y: 0 },
  inputs: [execPin(`${id}:in:In`, 'In', 'Input')], outputs: [execPin(`${id}:out:Out`, 'Out', 'Output')], data: { printMessage: message },
});

const branch = (id: string): LogicNode => ({
  id, type: 'Branch', name: 'Branch', position: { x: 0, y: 0 },
  inputs: [execPin(`${id}:in:In`, 'In', 'Input'), { id: `${id}:in:Condition`, name: 'Condition', dataType: 'Boolean', direction: 'Input' }],
  outputs: [execPin(`${id}:out:True`, 'True', 'Output'), execPin(`${id}:out:False`, 'False', 'Output')],
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

const runtimeProps = (blueprint: LevelBlueprintData, addNotification: (notification: unknown) => void): UseLevelBlueprintRuntimeProps => ({
  blueprint,
  levelObjects: [],
  playerEntityRef: { current: null },
  playerApiRef: { current: undefined },
  enemyApiRef: { current: undefined },
  destroyActor: () => undefined,
  addNotification,
});

const printed = (addNotification: ReturnType<typeof vi.fn>) =>
  addNotification.mock.calls.map(([notification]) => (notification as { message: string }).message);

describe('level blueprint runtime: flow and world nodes', () => {
  beforeEach(() => {
    levelVariables.reset();
  });

  it('fires every Sequence output in pin order', () => {
    const begin = beginPlay();
    const sequence = paletteNode('sequence', 'Sequence');
    const first = printString('first', 'first');
    const second = printString('second', 'second');
    const addNotification = vi.fn();

    renderHook(() => useLevelBlueprintRuntime(runtimeProps(graph(
      [begin, sequence, second, first],
      [wire(begin, 'Out', sequence, 'Exec'), wire(sequence, 'Then 1', second, 'In'), wire(sequence, 'Then 0', first, 'In')],
    ), addNotification)));

    expect(printed(addNotification)).toEqual(['[Output] first', '[Output] second']);
  });

  it('continues a Delay once its scheduled frames have passed, and drops it on unmount', async () => {
    const begin = beginPlay();
    // 0.04s at 60 fps comes due on the third frame.
    const delay = paletteNode('delay', 'Delay', { default_Duration: 0.04 });
    const done = printString('done', 'done');
    const blueprint = graph([begin, delay, done], [wire(begin, 'Out', delay, 'Exec'), wire(delay, 'Out', done, 'In')]);

    // StrictMode's simulated unmount must not drop the delay BeginPlay scheduled.
    const addNotification = vi.fn();
    renderHook(() => useLevelBlueprintRuntime(runtimeProps(blueprint, addNotification)), { wrapper: StrictMode });
    await act(async () => { await Promise.resolve(); });

    runFrames(2);
    expect(addNotification).not.toHaveBeenCalled();
    runFrames(1);
    expect(printed(addNotification)).toEqual(['[Output] done']);
    runFrames(10);
    expect(addNotification).toHaveBeenCalledTimes(1);

    // A session that ends while the delay is pending never continues it.
    const ended = vi.fn();
    const { unmount } = renderHook(() => useLevelBlueprintRuntime(runtimeProps(blueprint, ended)));
    unmount();
    await act(async () => { await Promise.resolve(); });
    runFrames(10);
    expect(ended).not.toHaveBeenCalled();
  });

  it.each([
    [true, '[Output] open'],
    [false, '[Output] closed'],
  ])('branches on a level variable set earlier in the chain (%s)', (value, expected) => {
    const begin = beginPlay();
    const set = paletteNode('set', 'SetLevelVariable', { default_Name: 'DoorOpen', default_Value: value });
    const get = paletteNode('get', 'GetLevelVariable', { default_Name: 'DoorOpen' });
    const choose = branch('branch');
    const open = printString('open', 'open');
    const closed = printString('closed', 'closed');
    const addNotification = vi.fn();

    renderHook(() => useLevelBlueprintRuntime(runtimeProps(graph(
      [begin, set, get, choose, open, closed],
      [
        wire(begin, 'Out', set, 'Exec'),
        wire(set, 'Out', choose, 'In'),
        wire(get, 'Value', choose, 'Condition'),
        wire(choose, 'True', open, 'In'),
        wire(choose, 'False', closed, 'In'),
      ],
    ), addNotification)));

    expect(levelVariables.get('DoorOpen')).toBe(value);
    expect(printed(addNotification)).toEqual([expected]);
  });
});
