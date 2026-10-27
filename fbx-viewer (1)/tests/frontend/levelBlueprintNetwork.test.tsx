import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { networkEventMatches, networkPayload, useLevelBlueprintRuntime, type UseLevelBlueprintRuntimeProps } from '../../hooks/useLevelBlueprintRuntime';
import { NetSessionContext } from '../../runtime/net/NetSessionContext';
import type { NetPayload, NetSession } from '../../runtime/net/protocol';
import type { LevelBlueprintData, LogicConnection, LogicNode, LogicPin } from '../../types';

vi.mock('@react-three/fiber', () => ({ useFrame: () => undefined }));

const pin = (node: string, name: string, dataType: LogicPin['dataType'], direction: LogicPin['direction']): LogicPin =>
  ({ id: `${node}:${direction}:${name}`, name, dataType, direction });

const node = (id: string, type: LogicNode['type'], name: string, inputs: LogicPin[], outputs: LogicPin[], data?: Record<string, unknown>): LogicNode =>
  ({ id, type, name, position: { x: 0, y: 0 }, inputs, outputs, data });

const begin = node('begin', 'Event', 'Event BeginPlay', [], [pin('begin', 'Out', 'Exec', 'Output')]);
const print = (id: string, message: string) => node(id, 'PrintString', 'Print String',
  [pin(id, 'In', 'Exec', 'Input'), pin(id, 'String', 'String', 'Input')], [pin(id, 'Out', 'Exec', 'Output')], { printMessage: message });

const wire = (from: LogicNode, fromPin: string, to: LogicNode, toPin: string): LogicConnection => ({
  id: `${from.id}.${fromPin}->${to.id}.${toPin}`,
  fromNodeId: from.id, fromPinId: from.outputs.find(item => item.name === fromPin)!.id,
  toNodeId: to.id, toPinId: to.inputs.find(item => item.name === toPin)!.id,
});

const props = (blueprint: LevelBlueprintData, addNotification: (notification: unknown) => void): UseLevelBlueprintRuntimeProps => ({
  blueprint, levelObjects: [], playerEntityRef: { current: null }, playerApiRef: { current: undefined }, enemyApiRef: { current: undefined },
  destroyActor: () => undefined, addNotification,
});

const fakeSession = (isHost: boolean) => {
  const listeners = new Set<(from: string, name: string, payload: NetPayload) => void>();
  const session = {
    isHost: () => isHost,
    sendEvent: vi.fn(),
    onEvent: (listener: (from: string, name: string, payload: NetPayload) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  } as unknown as NetSession & { sendEvent: ReturnType<typeof vi.fn> };
  return { session, emit: (from: string, name: string, payload: NetPayload) => listeners.forEach(listener => listener(from, name, payload)) };
};

const render = (blueprint: LevelBlueprintData, session: NetSession | null) => {
  const addNotification = vi.fn();
  const wrapper = ({ children }: { children: React.ReactNode }) => <NetSessionContext.Provider value={session}>{children}</NetSessionContext.Provider>;
  renderHook(() => useLevelBlueprintRuntime(props(blueprint, addNotification)), { wrapper });
  return () => addNotification.mock.calls.map(([notification]) => (notification as { message: string }).message);
};

describe('multiplayer blueprint nodes', () => {
  it('Send Network Event sends its name and value', () => {
    const send = node('send', 'SendNetworkEvent', 'Send Network Event',
      [pin('send', 'Exec', 'Exec', 'Input'), pin('send', 'Name', 'String', 'Input'), pin('send', 'Value', 'String', 'Input')],
      [pin('send', 'Out', 'Exec', 'Output')], { default_Name: 'door', default_Value: 'open' });
    const { session } = fakeSession(true);
    render({ nodes: [begin, send], connections: [wire(begin, 'Out', send, 'Exec')], variables: [] }, session);
    expect(session.sendEvent).toHaveBeenCalledWith('door', 'open');
  });

  it('Is Network Host follows the session, and is true in single-player games', () => {
    const host = node('host', 'IsNetworkHost', 'Is Network Host', [], [pin('host', 'Is Host', 'Boolean', 'Output')]);
    const branch = node('branch', 'Branch', 'Branch',
      [pin('branch', 'In', 'Exec', 'Input'), pin('branch', 'Condition', 'Boolean', 'Input')],
      [pin('branch', 'True', 'Exec', 'Output'), pin('branch', 'False', 'Exec', 'Output')]);
    const yes = print('yes', 'host');
    const no = print('no', 'client');
    const blueprint: LevelBlueprintData = {
      nodes: [begin, host, branch, yes, no],
      connections: [wire(begin, 'Out', branch, 'In'), wire(host, 'Is Host', branch, 'Condition'), wire(branch, 'True', yes, 'In'), wire(branch, 'False', no, 'In')],
      variables: [],
    };
    expect(render(blueprint, fakeSession(false).session)()).toEqual(['[Output] client']);
    expect(render(blueprint, fakeSession(true).session)()).toEqual(['[Output] host']);
    expect(render(blueprint, null)()).toEqual(['[Output] host']);
  });

  it('Network Event runs for matching events with their value and sender', () => {
    const event = node('net', 'Event', 'Event NetworkEvent', [],
      [pin('net', 'Exec', 'Exec', 'Output'), pin('net', 'Value', 'String', 'Output'), pin('net', 'From', 'String', 'Output')], { eventName: 'door' });
    const shown = print('shown', 'x');
    const { session, emit } = fakeSession(false);
    const printed = render({ nodes: [begin, event, shown], connections: [wire(event, 'Exec', shown, 'In'), wire(event, 'Value', shown, 'String')], variables: [] }, session);
    act(() => emit('bob', 'door', 'open'));
    act(() => emit('bob', 'score', 3));
    expect(printed()).toEqual(['[Output] open']);
  });
});

describe('multiplayer blueprint helpers', () => {
  it('matches events by name, empty taking any', () => {
    const event = (eventName: unknown) => node('n', 'Event', 'Event NetworkEvent', [], [], { eventName });
    expect(networkEventMatches(event('door'), 'door')).toBe(true);
    expect(networkEventMatches(event('door'), 'other')).toBe(false);
    expect(networkEventMatches(event(''), 'other')).toBe(true);
  });

  it('turns blueprint values into payloads', () => {
    expect(networkPayload(3)).toBe(3);
    expect(networkPayload(Number.NaN)).toBeNull();
    expect(networkPayload(true)).toBe(true);
    expect(networkPayload('x')).toBe('x');
    expect(networkPayload(undefined)).toBeNull();
    expect(networkPayload({ a: 1 })).toBe('[object Object]');
  });
});
