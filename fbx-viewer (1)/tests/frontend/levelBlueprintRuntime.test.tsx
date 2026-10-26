import { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { SandboxEntityHandle } from '../../components/Sandbox/SandboxEntity';
import { useLevelBlueprintRuntime, UseLevelBlueprintRuntimeProps } from '../../hooks/useLevelBlueprintRuntime';
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

const levelObject = (id: string, name: string, position: [number, number, number]): LevelObject => ({
  id, levelId: 'level-1', modelId: 'model-1', name, position, rotation: [0, 0, 0], scale: [1, 1, 1], type: 'prop',
});

const beginPlayGraph: LevelBlueprintData = {
  nodes: [
    node('begin', 'Event', 'Event BeginPlay', [], [pin('begin-out', 'Out', 'Exec', 'Output')]),
    node('print', 'PrintString', 'Print String', [pin('print-in', 'In', 'Exec', 'Input')], [pin('print-out', 'Out', 'Exec', 'Output')], { printMessage: 'started' }),
  ],
  connections: [{ id: 'c1', fromNodeId: 'begin', fromPinId: 'begin-out', toNodeId: 'print', toPinId: 'print-in' }],
  variables: [],
};

const overlapGraph: LevelBlueprintData = {
  nodes: [
    node('overlap', 'Event', 'On Overlap (Coin)', [], [pin('overlap-out', 'Out', 'Exec', 'Output')], { targetActorName: 'Coin' }),
    node('destroy', 'DestroyActor', 'Destroy Actor', [pin('destroy-in', 'In', 'Exec', 'Input')], [pin('destroy-out', 'Out', 'Exec', 'Output')]),
  ],
  connections: [{ id: 'c1', fromNodeId: 'overlap', fromPinId: 'overlap-out', toNodeId: 'destroy', toPinId: 'destroy-in' }],
  variables: [],
};

// Mirrors how LevelGameLoop used to render: fresh refs and callbacks on every render.
const runtimeProps = (overrides: Partial<UseLevelBlueprintRuntimeProps>): UseLevelBlueprintRuntimeProps => ({
  blueprint: beginPlayGraph,
  levelObjects: [],
  playerEntityRef: { current: null },
  playerApiRef: { current: undefined },
  enemyApiRef: { current: undefined },
  destroyActor: () => undefined,
  addNotification: () => undefined,
  onRestart: () => undefined,
  onEndLevel: () => undefined,
  ...overrides,
});

describe('level blueprint runtime', () => {
  it('fires BeginPlay once per session while props churn every frame', () => {
    const addNotification = vi.fn();
    const { rerender, unmount } = renderHook(
      (props: UseLevelBlueprintRuntimeProps) => useLevelBlueprintRuntime(props),
      { initialProps: runtimeProps({ addNotification }), wrapper: StrictMode },
    );

    for (let i = 0; i < 300; i += 1) {
      rerender(runtimeProps({ addNotification }));
      runFrame();
    }

    expect(addNotification).toHaveBeenCalledTimes(1);
    expect(addNotification).toHaveBeenCalledWith(expect.objectContaining({ message: '[Output] started' }));

    // A restart remounts the runtime, which is a new session.
    unmount();
    renderHook((props: UseLevelBlueprintRuntimeProps) => useLevelBlueprintRuntime(props), { initialProps: runtimeProps({ addNotification }) });
    expect(addNotification).toHaveBeenCalledTimes(2);
  });

  it('routes Destroy Actor to the runtime callback once per overlap entry', () => {
    const destroyActor = vi.fn();
    const player = { object: new THREE.Group() } as unknown as SandboxEntityHandle;
    renderHook(() => useLevelBlueprintRuntime(runtimeProps({
      blueprint: overlapGraph,
      levelObjects: [levelObject('coin-1', 'Coin', [0, 0, 0]), levelObject('rock-1', 'Rock', [20, 0, 0])],
      playerEntityRef: { current: player },
      destroyActor,
    })));

    runFrame();
    runFrame();

    expect(destroyActor).toHaveBeenCalledTimes(1);
    expect(destroyActor).toHaveBeenCalledWith('coin-1');
  });

  it('stops acting once Restart fires, even later in the same frame', () => {
    const destroyActor = vi.fn();
    const onRestart = vi.fn();
    const restartOnTick: LevelBlueprintData = {
      nodes: [
        ...overlapGraph.nodes,
        node('tick', 'Event', 'Event Tick', [], [pin('tick-out', 'Out', 'Exec', 'Output')]),
        node('restart', 'LevelAction', 'Restart Level', [pin('restart-in', 'In', 'Exec', 'Input')], [], { action: 'Restart' }),
      ],
      connections: [
        ...overlapGraph.connections,
        { id: 'c2', fromNodeId: 'tick', fromPinId: 'tick-out', toNodeId: 'restart', toPinId: 'restart-in' },
      ],
      variables: [],
    };
    const player = { object: new THREE.Group() } as unknown as SandboxEntityHandle;
    renderHook(() => useLevelBlueprintRuntime(runtimeProps({
      blueprint: restartOnTick,
      levelObjects: [levelObject('coin-1', 'Coin', [0, 0, 0])],
      playerEntityRef: { current: player },
      destroyActor,
      onRestart,
    })));

    runFrame();
    runFrame();

    // Tick (Restart) runs before overlaps in a frame; the ending session must not destroy the coin.
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(destroyActor).not.toHaveBeenCalled();
  });
});
