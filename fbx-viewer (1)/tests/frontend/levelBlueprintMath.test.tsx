import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORLD_NODE_DEFINITIONS } from '../../hooks/levelBlueprintNodes/world';
import { useLevelBlueprintRuntime } from '../../hooks/useLevelBlueprintRuntime';
import { levelVariables } from '../../runtime/levelVariables';
import type { LevelBlueprintData, LogicConnection, LogicNode, LogicPin } from '../../types';

vi.mock('@react-three/fiber', () => ({ useFrame: () => undefined }));

const pin = (id: string, name: string, dataType: LogicPin['dataType'], direction: LogicPin['direction']): LogicPin => ({ id, name, dataType, direction });

const beginPlay: LogicNode = {
  id: 'begin', type: 'Event', name: 'Event BeginPlay', position: { x: 0, y: 0 }, inputs: [], outputs: [pin('begin:out', 'Out', 'Exec', 'Output')],
};

const literal = (id: string, value: number): LogicNode => ({
  id, type: 'LiteralFloat', name: 'Float', position: { x: 0, y: 0 }, inputs: [], outputs: [pin(`${id}:out`, 'Value', 'Float', 'Output')], data: { value },
});

/** A math node exactly as the editor palette builds it: an Exec pin before A and B, Out before Result. */
const mathNode = (id: string, type: LogicNode['type'], dataType: 'Float' | 'Integer' = 'Float'): LogicNode => ({
  id, type, name: type, position: { x: 0, y: 0 },
  inputs: [pin(`${id}:exec`, 'Exec', 'Exec', 'Input'), pin(`${id}:a`, 'A', dataType, 'Input'), pin(`${id}:b`, 'B', dataType, 'Input')],
  outputs: [pin(`${id}:out`, 'Out', 'Exec', 'Output'), pin(`${id}:result`, 'Result', dataType, 'Output')],
});

const toStringNode: LogicNode = {
  id: 'str', type: 'ToString', name: 'To String', position: { x: 0, y: 0 },
  inputs: [pin('str:exec', 'Exec', 'Exec', 'Input'), pin('str:value', 'Value', 'Float', 'Input')],
  outputs: [pin('str:out', 'Out', 'Exec', 'Output'), pin('str:string', 'String', 'String', 'Output')],
};

const setVariable = (id: string, name: string): LogicNode => {
  const definition = WORLD_NODE_DEFINITIONS.find(item => item.type === 'SetLevelVariable')!;
  return {
    id, type: 'SetLevelVariable', name: definition.title, position: { x: 0, y: 0 },
    inputs: definition.inputs.map(item => ({ ...item, id: `${id}:in:${item.name}` })),
    outputs: definition.outputs.map(item => ({ ...item, id: `${id}:out:${item.name}` })),
    data: { ...definition.data, default_Name: name },
  };
};

const link = (from: string, fromPinId: string, to: string, toPinId: string): LogicConnection =>
  ({ id: `${fromPinId}->${toPinId}`, fromNodeId: from, fromPinId, toNodeId: to, toPinId });

/** BeginPlay -> Set Level Variable `name`, whose Value is fed by `valueNode`'s `valuePinId`. */
const run = (nodes: LogicNode[], connections: LogicConnection[], name: string, valueNode: string, valuePinId: string) => {
  const set = setVariable(`set-${name}`, name);
  const blueprint: LevelBlueprintData = {
    nodes: [beginPlay, ...nodes, set],
    connections: [
      ...connections,
      link('begin', 'begin:out', set.id, `${set.id}:in:Exec`),
      link(valueNode, valuePinId, set.id, `${set.id}:in:Value`),
    ],
    variables: [],
  };
  renderHook(() => useLevelBlueprintRuntime({
    blueprint, levelObjects: [], playerEntityRef: { current: null }, playerApiRef: { current: undefined },
    enemyApiRef: { current: undefined }, destroyActor: () => undefined, addNotification: () => undefined,
  }));
  return levelVariables.get(name);
};

describe('level blueprint math on editor-made nodes', () => {
  beforeEach(() => { levelVariables.reset(); });

  it.each([
    ['Add', 5], ['Subtract', -1], ['Multiply', 6], ['Divide', 2 / 3],
  ])('%s reads A and B by name, not by position', (type, expected) => {
    const node = mathNode('math', type as LogicNode['type']);
    const value = run(
      [literal('two', 2), literal('three', 3), node],
      [link('two', 'two:out', 'math', 'math:a'), link('three', 'three:out', 'math', 'math:b')],
      'result', 'math', 'math:result',
    );
    expect(value).toBeCloseTo(expected as number);
  });

  it('rounds an Integer result down and guards division by zero', () => {
    const add = mathNode('add', 'Add', 'Integer');
    expect(run([literal('a', 2.5), literal('b', 1), add], [link('a', 'a:out', 'add', 'add:a'), link('b', 'b:out', 'add', 'add:b')], 'sum', 'add', 'add:result')).toBe(3);
    levelVariables.reset();
    const divide = mathNode('div', 'Divide');
    expect(run([literal('a', 4), literal('z', 0), divide], [link('a', 'a:out', 'div', 'div:a'), link('z', 'z:out', 'div', 'div:b')], 'quotient', 'div', 'div:result')).toBe(0);
  });

  it('converts its Value pin to text', () => {
    expect(run([literal('seven', 7), toStringNode], [link('seven', 'seven:out', 'str', 'str:value')], 'label', 'str', 'str:string')).toBe('7');
  });
});
