import { StrictMode } from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { LevelBlueprintEditor } from '../../components/LevelBlueprint/LevelBlueprintEditor';
import { LevelBlueprintInspector } from '../../components/LevelBlueprint/LevelBlueprintInspector';
import type { SandboxEntityHandle } from '../../components/Sandbox/SandboxEntity';
import { useLevelBlueprintRuntime, UseLevelBlueprintRuntimeProps } from '../../hooks/useLevelBlueprintRuntime';
import type { LevelBlueprintData, LevelObject, LogicNode, LogicPin, PinDataType, PinDirection } from '../../types';

const frame = vi.hoisted(() => ({ callback: null as ((state: unknown, delta: number) => void) | null }));
const scene = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@react-three/fiber', () => ({
  useFrame: (callback: (state: unknown, delta: number) => void) => { frame.callback = callback; },
}));

vi.mock('../../context/SceneContext', () => ({ useScene: () => scene.current }));

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

const overlapGraphFor = (name: string, data: Record<string, unknown>): LevelBlueprintData => ({
  ...overlapGraph,
  nodes: [{ ...overlapGraph.nodes[0], name, data }, overlapGraph.nodes[1]],
});

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

  it('fires an id-referenced overlap only for that actor among same-named placements', () => {
    const destroyActor = vi.fn();
    const player = { object: new THREE.Group() } as unknown as SandboxEntityHandle;
    renderHook(() => useLevelBlueprintRuntime(runtimeProps({
      blueprint: overlapGraphFor('On Overlap (Crate_Prop)', { targetActorId: 'crate-2' }),
      // Every placement of a model gets the same default name; the player overlaps all three.
      levelObjects: [
        levelObject('crate-1', 'Crate_Prop', [0, 0, 0]),
        levelObject('crate-2', 'Crate_Prop', [0.5, 0, 0]),
        levelObject('crate-3', 'Crate_Prop', [-0.5, 0, 0]),
      ],
      playerEntityRef: { current: player },
      destroyActor,
    })));

    runFrame();

    expect(destroyActor).toHaveBeenCalledTimes(1);
    expect(destroyActor).toHaveBeenCalledWith('crate-2');
  });

  it('keeps firing for an id-referenced actor after it is renamed', () => {
    const destroyActor = vi.fn();
    const player = { object: new THREE.Group() } as unknown as SandboxEntityHandle;
    renderHook(() => useLevelBlueprintRuntime(runtimeProps({
      // Authored while the actor was called 'Coin'.
      blueprint: overlapGraphFor('On Overlap (Coin)', { targetActorId: 'coin-1' }),
      levelObjects: [levelObject('coin-1', 'Gold Coin', [0, 0, 0])],
      playerEntityRef: { current: player },
      destroyActor,
    })));

    runFrame();

    expect(destroyActor).toHaveBeenCalledWith('coin-1');
  });

  it('keeps legacy name-only overlaps matching every actor with that name', () => {
    const destroyActor = vi.fn();
    const player = { object: new THREE.Group() } as unknown as SandboxEntityHandle;
    renderHook(() => useLevelBlueprintRuntime(runtimeProps({
      blueprint: overlapGraph,
      levelObjects: [levelObject('coin-1', 'Coin', [0, 0, 0]), levelObject('coin-2', 'Coin', [0.5, 0, 0])],
      playerEntityRef: { current: player },
      destroyActor,
    })));

    runFrame();

    expect(destroyActor.mock.calls).toEqual([['coin-1'], ['coin-2']]);
  });

  const levelActionOnTick = (data: Record<string, unknown>): LevelBlueprintData => ({
    nodes: [
      ...overlapGraph.nodes,
      node('tick', 'Event', 'Event Tick', [], [pin('tick-out', 'Out', 'Exec', 'Output')]),
      node('action', 'LevelAction', 'Level Action', [pin('action-in', 'In', 'Exec', 'Input')], [pin('action-out', 'Out', 'Exec', 'Output')], data),
      node('print', 'PrintString', 'Print String', [pin('print-in', 'In', 'Exec', 'Input')], [pin('print-out', 'Out', 'Exec', 'Output')], { printMessage: 'after' }),
    ],
    connections: [
      ...overlapGraph.connections,
      { id: 'c2', fromNodeId: 'tick', fromPinId: 'tick-out', toNodeId: 'action', toPinId: 'action-in' },
      { id: 'c3', fromNodeId: 'action', fromPinId: 'action-out', toNodeId: 'print', toPinId: 'print-in' },
    ],
    variables: [],
  });

  const levelHost = () => ({ openLevel: vi.fn(), saveGame: vi.fn(), loadGame: vi.fn() });

  it('opens a level once and stops acting later in the same frame', () => {
    const destroyActor = vi.fn();
    const addNotification = vi.fn();
    const host = levelHost();
    const player = { object: new THREE.Group() } as unknown as SandboxEntityHandle;
    renderHook(() => useLevelBlueprintRuntime(runtimeProps({
      blueprint: levelActionOnTick({ action: 'OpenLevel', levelId: 'level-2' }),
      levelObjects: [levelObject('coin-1', 'Coin', [0, 0, 0])],
      playerEntityRef: { current: player },
      destroyActor,
      addNotification,
      host,
    })));

    runFrame();
    runFrame();

    expect(host.openLevel).toHaveBeenCalledTimes(1);
    expect(host.openLevel).toHaveBeenCalledWith('level-2');
    expect(destroyActor).not.toHaveBeenCalled();
    expect(addNotification).not.toHaveBeenCalledWith(expect.objectContaining({ message: '[Output] after' }));
  });

  it('saves the game to the node slot and keeps executing', () => {
    const addNotification = vi.fn();
    const host = levelHost();
    renderHook(() => useLevelBlueprintRuntime(runtimeProps({
      blueprint: levelActionOnTick({ action: 'SaveGame', slot: ' slot-1 ' }),
      addNotification,
      host,
    })));

    runFrame();

    expect(host.saveGame).toHaveBeenCalledTimes(1);
    expect(host.saveGame).toHaveBeenCalledWith('slot-1');
    expect(host.loadGame).not.toHaveBeenCalled();
    expect(addNotification).toHaveBeenCalledWith(expect.objectContaining({ message: '[Output] after' }));
  });

  it('loads the default slot once and ends the session', () => {
    const host = levelHost();
    renderHook(() => useLevelBlueprintRuntime(runtimeProps({ blueprint: levelActionOnTick({ action: 'LoadGame' }), host })));

    runFrame();
    runFrame();

    expect(host.loadGame).toHaveBeenCalledTimes(1);
    expect(host.loadGame).toHaveBeenCalledWith(undefined);
  });
});

const sceneWith = (blueprint: LevelBlueprintData, levelObjects: LevelObject[]) => {
  const updateLevelBlueprint = vi.fn();
  scene.current = { activeLevelBlueprint: blueprint, updateLevelBlueprint, blueprints: [], levelObjects };
  return updateLevelBlueprint;
};

const renderInspector = (overlapNode: LogicNode, levelObjects: LevelObject[], onUpdate = vi.fn()) => {
  render(<LevelBlueprintInspector node={overlapNode} onUpdate={onUpdate} levelObjects={levelObjects} globalVariables={[]} onDelete={() => undefined} />);
  return onUpdate;
};

describe('level blueprint overlap actor references', () => {
  it('migrates a legacy name that identifies exactly one actor to its id', () => {
    const updateLevelBlueprint = sceneWith(overlapGraph, [levelObject('coin-1', 'Coin', [0, 0, 0]), levelObject('rock-1', 'Rock', [5, 0, 0])]);

    render(<StrictMode><LevelBlueprintEditor onClose={() => undefined} /></StrictMode>);

    expect(updateLevelBlueprint).toHaveBeenCalledTimes(1);
    const { nodes } = updateLevelBlueprint.mock.calls[0][0] as LevelBlueprintData;
    expect(nodes.find(n => n.id === 'overlap')?.data).toEqual({ targetActorId: 'coin-1' });
    expect(nodes.find(n => n.id === 'destroy')).toBe(overlapGraph.nodes[1]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps an ambiguous legacy name and warns on the node and in the inspector', () => {
    const coins = [levelObject('coin-1', 'Coin', [0, 0, 0]), levelObject('coin-2', 'Coin', [5, 0, 0])];
    const updateLevelBlueprint = sceneWith(overlapGraph, coins);

    render(<LevelBlueprintEditor onClose={() => undefined} />);

    expect(updateLevelBlueprint).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('"Coin" matches 2 actors');

    renderInspector(overlapGraph.nodes[0], coins);
    expect(screen.getAllByRole('alert')[1]).toHaveTextContent('"Coin" matches 2 actors');
  });

  it('warns about a deleted actor', () => {
    renderInspector(overlapGraphFor('On Overlap (Coin)', { targetActorId: 'coin-1' }).nodes[0], [levelObject('rock-1', 'Rock', [0, 0, 0])]);

    expect(screen.getByRole('alert')).toHaveTextContent('Missing actor');
  });

  it('picks the actor by id and stores the reference and node name in one update', () => {
    const crates = [levelObject('crate-1', 'Crate_Prop', [0, 0, 0]), levelObject('crate-2', 'Crate_Prop', [5, 0, 0])];
    const onUpdate = renderInspector(overlapGraphFor('On Overlap (Select Actor)', {}).nodes[0], crates);

    expect(screen.getByRole('option', { name: 'Crate_Prop · prop · crate-1' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'crate-2' } });

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith({ name: 'On Overlap (Crate_Prop)', data: { targetActorId: 'crate-2' } });
  });
});

describe('level blueprint level actions inspector', () => {
  const actionNode = (data: Record<string, unknown>) => node('action', 'LevelAction', 'Level Action', [pin('action-in', 'In', 'Exec', 'Input')], [pin('action-out', 'Out', 'Exec', 'Output')], data);

  it('picks the Open Level target and names the node in one update', () => {
    const onUpdate = vi.fn();
    render(<LevelBlueprintInspector node={actionNode({ action: 'OpenLevel' })} onUpdate={onUpdate} levelObjects={[]} levels={[{ id: 'level-1', name: 'Intro' }, { id: 'level-2', name: 'Caves' }]} globalVariables={[]} onDelete={() => undefined} />);

    expect(screen.getByRole('alert')).toHaveTextContent('No level selected');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'level-2' } });

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith({ name: 'Open Level (Caves)', data: { action: 'OpenLevel', levelId: 'level-2' } });
  });

  it('edits the save slot', () => {
    const onUpdate = vi.fn();
    render(<LevelBlueprintInspector node={actionNode({ action: 'SaveGame' })} onUpdate={onUpdate} levelObjects={[]} globalVariables={[]} onDelete={() => undefined} />);

    fireEvent.change(screen.getByLabelText('Slot (blank for default)'), { target: { value: 'slot-2' } });

    expect(onUpdate).toHaveBeenCalledWith({ data: { action: 'SaveGame', slot: 'slot-2' } });
  });
});
