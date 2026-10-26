import React from 'react';
import { act, renderHook } from '@testing-library/react';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { SandboxEntityHandle } from '../../components/Sandbox/SandboxEntity';
import { useLevelBlueprintRuntime, UseLevelBlueprintRuntimeProps } from '../../hooks/useLevelBlueprintRuntime';
import { createTriggerEvents, TriggerEvent, TriggerEvents, TriggerEventsProvider, useTriggerEvents } from '../../runtime/triggers';
import type { LevelBlueprintData, LevelObject, LogicNode, LogicPin, PinDataType, PinDirection } from '../../types';

const frame = vi.hoisted(() => ({ callback: null as ((state: unknown, delta: number) => void) | null }));

vi.mock('@react-three/fiber', () => ({
  useFrame: (callback: (state: unknown, delta: number) => void) => { frame.callback = callback; },
}));

const runFrame = () => act(() => { frame.callback?.({}, 1 / 60); });

const pin = (id: string, name: string, dataType: PinDataType, direction: PinDirection): LogicPin => ({ id, name, dataType, direction });

const node = (id: string, type: LogicNode['type'], name: string, inputs: LogicPin[], outputs: LogicPin[], data?: Record<string, unknown>): LogicNode => ({
  id, type, name, position: { x: 0, y: 0 }, inputs, outputs, data,
});

const collider = { id: 'col', type: 'collider', enabled: true, props: { shape: 'box', isTrigger: true } };

const levelObject = (id: string, name: string, withCollider: boolean): LevelObject => ({
  id, levelId: 'level-1', modelId: 'model-1', name, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], type: 'prop',
  ...(withCollider ? { components: [collider] } : {}),
});

const overlapGraph = (data: Record<string, unknown>, extraNodes: LogicNode[] = [], extraConnections: LevelBlueprintData['connections'] = []): LevelBlueprintData => ({
  nodes: [
    node('overlap', 'Event', 'On Overlap (Coin)', [], [pin('overlap-out', 'Out', 'Exec', 'Output')], data),
    node('destroy', 'DestroyActor', 'Destroy Actor', [pin('destroy-in', 'In', 'Exec', 'Input')], [pin('destroy-out', 'Out', 'Exec', 'Output')]),
    ...extraNodes,
  ],
  connections: [{ id: 'c1', fromNodeId: 'overlap', fromPinId: 'overlap-out', toNodeId: 'destroy', toPinId: 'destroy-in' }, ...extraConnections],
  variables: [],
});

const enter = (triggerObjectId: string, otherObjectId: string = 'player'): TriggerEvent => ({ kind: 'enter', triggerObjectId, otherObjectId });
const exit = (triggerObjectId: string): TriggerEvent => ({ kind: 'exit', triggerObjectId, otherObjectId: 'player' });

const renderRuntime = (events: TriggerEvents, overrides: Partial<UseLevelBlueprintRuntimeProps>) => {
  const props: UseLevelBlueprintRuntimeProps = {
    blueprint: overlapGraph({ targetActorId: 'coin-1' }),
    levelObjects: [],
    // The player stands on every test object, so the distance check would fire for any object it covers.
    playerEntityRef: { current: { object: new THREE.Group() } as unknown as SandboxEntityHandle },
    playerApiRef: { current: undefined },
    enemyApiRef: { current: undefined },
    destroyActor: () => undefined,
    addNotification: () => undefined,
    ...overrides,
  };
  const wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(TriggerEventsProvider, { events }, children);
  return renderHook(() => useLevelBlueprintRuntime(props), { wrapper });
};

describe('trigger events', () => {
  it('delivers emitted events to subscribers until they unsubscribe', () => {
    const events = createTriggerEvents();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = events.subscribe(first);
    events.subscribe(second);

    events.emit(enter('door'));
    unsubscribe();
    events.emit(exit('door'));

    expect(first.mock.calls).toEqual([[enter('door')]]);
    expect(second.mock.calls).toEqual([[enter('door')], [exit('door')]]);
  });

  it('shares one bus per provider and is inert outside one', () => {
    const { result: outside } = renderHook(() => useTriggerEvents());
    expect(() => outside.current.emit(enter('door'))).not.toThrow();

    const { result } = renderHook(() => [useTriggerEvents(), useTriggerEvents()], {
      wrapper: ({ children }: { children: React.ReactNode }) => React.createElement(TriggerEventsProvider, null, children),
    });
    const listener = vi.fn();
    result.current[0].subscribe(listener);
    result.current[1].emit(enter('door'));
    expect(listener).toHaveBeenCalledWith(enter('door'));
  });
});

describe('level blueprint overlaps from trigger events', () => {
  it('fires the overlap for the trigger actor on player entry only, once per entry', () => {
    const events = createTriggerEvents();
    const destroyActor = vi.fn();
    renderRuntime(events, { levelObjects: [levelObject('coin-1', 'Coin', true)], destroyActor });

    // Overlapping the collider object by distance alone fires nothing.
    runFrame();
    expect(destroyActor).not.toHaveBeenCalled();

    act(() => {
      events.emit(enter('coin-1', 'enemy-1'));
      events.emit(enter('rock-1'));
      events.emit(enter('coin-1'));
      events.emit(enter('coin-1'));
    });
    expect(destroyActor.mock.calls).toEqual([['coin-1']]);

    act(() => {
      events.emit(exit('coin-1'));
      events.emit(enter('coin-1'));
    });
    expect(destroyActor.mock.calls).toEqual([['coin-1'], ['coin-1']]);
  });

  it('keeps the distance fallback for objects without an enabled collider', () => {
    const events = createTriggerEvents();
    const destroyActor = vi.fn();
    const disabled = { ...levelObject('coin-2', 'Coin', false), components: [{ ...collider, enabled: false }] };
    renderRuntime(events, {
      blueprint: overlapGraph({ targetActorName: 'Coin' }),
      levelObjects: [levelObject('coin-1', 'Coin', false), disabled, levelObject('coin-3', 'Coin', true)],
      destroyActor,
    });

    runFrame();

    expect(destroyActor.mock.calls).toEqual([['coin-1'], ['coin-2']]);
  });

  it('ignores trigger entries once the session has ended', () => {
    const events = createTriggerEvents();
    const destroyActor = vi.fn();
    const onRestart = vi.fn();
    const restartOnTick = overlapGraph({ targetActorId: 'coin-1' }, [
      node('tick', 'Event', 'Event Tick', [], [pin('tick-out', 'Out', 'Exec', 'Output')]),
      node('restart', 'LevelAction', 'Restart Level', [pin('restart-in', 'In', 'Exec', 'Input')], [], { action: 'Restart' }),
    ], [{ id: 'c2', fromNodeId: 'tick', fromPinId: 'tick-out', toNodeId: 'restart', toPinId: 'restart-in' }]);
    renderRuntime(events, { blueprint: restartOnTick, levelObjects: [levelObject('coin-1', 'Coin', true)], destroyActor, onRestart });

    runFrame();
    act(() => { events.emit(enter('coin-1')); });

    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(destroyActor).not.toHaveBeenCalled();
  });

  it('stops listening when the runtime unmounts', () => {
    const events = createTriggerEvents();
    const destroyActor = vi.fn();
    const { unmount } = renderRuntime(events, { levelObjects: [levelObject('coin-1', 'Coin', true)], destroyActor });

    unmount();
    act(() => { events.emit(enter('coin-1')); });

    expect(destroyActor).not.toHaveBeenCalled();
  });
});
