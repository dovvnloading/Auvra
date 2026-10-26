import { act, renderHook } from '@testing-library/react';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { FlowNode } from '../../hooks/levelBlueprintNodes/flow';
import {
  WORLD_NODE_DEFINITIONS,
  WORLD_NODE_EXECUTORS,
  WorldNodeDefinition,
  WorldNodeServices,
  withWorldPose,
} from '../../hooks/levelBlueprintNodes/world';
import { useLevelBlueprintRuntime } from '../../hooks/useLevelBlueprintRuntime';
import { useRuntimeLevelWorld } from '../../hooks/useRuntimeLevelWorld';
import { createLevelVariablesStore } from '../../runtime/levelVariables';
import type { LevelBlueprintData, LevelObject, LogicConnection, LogicNode, LogicPin, PrefabData } from '../../types';
import { instantiatePrefab } from '../../utils/prefabs';

const spawner = vi.hoisted(() => ({ spawn: (_prefabId: string, _position: unknown): string[] => [] }));

vi.mock('@react-three/fiber', () => ({ useFrame: () => undefined }));

// The session's spawnPrefab (LevelSession) instantiates the prefab into the runtime world; the test wires the same.
vi.mock('../../runtime/RuntimeServicesContext', () => ({
  useRuntimeServices: () => ({
    input: { isDown: () => false, wasPressed: () => false },
    mixer: null,
    options: {},
    spawnPrefab: (prefabId: string, position: unknown) => spawner.spawn(prefabId, position),
    playSound: () => undefined,
  }),
}));

type Vec3 = [number, number, number];

const levelObject = (id: string, position: Vec3, parentId: string | null = null, extra: Partial<LevelObject> = {}): LevelObject => ({
  id, levelId: 'level-1', modelId: 'model-1', name: id, position, rotation: [0, 0, 0], scale: [1, 1, 1], type: 'prop', parentId, ...extra,
});

const coinPrefab: PrefabData = {
  id: 'coin',
  name: 'Coin',
  rootId: 'coin-root',
  objects: [
    { id: 'coin-root', modelId: 'model-1', name: 'Coin', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], type: 'prop', parentId: null },
    { id: 'coin-mesh', modelId: 'model-1', name: 'CoinMesh', position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1], type: 'prop', parentId: 'coin-root' },
  ],
};

const ids = (objects: readonly LevelObject[]) => objects.map(obj => obj.id);

const expectVec = (actual: readonly number[], expected: readonly number[]) => {
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, 6));
};

describe('runtime level world: one synchronous chain', () => {
  it('sees spawns and transform writes made earlier in the same chain, before React re-renders', () => {
    const { result } = renderHook(() => useRuntimeLevelWorld([levelObject('cube', [1, 2, 3])]));

    act(() => {
      const world = result.current;
      const spawned = instantiatePrefab(coinPrefab, 'level-1', [20, 0, 20]);
      world.spawnObjects(spawned);
      expect(world.getObject(spawned[0].id)?.position).toEqual([20, 0, 20]);

      // Two Set Actor Transform writes, each filling its blank axes from a fresh read.
      const [, y0, z0] = world.getObject('cube')!.position;
      world.setObjectTransform('cube', { position: [5, y0, z0] });
      const [x1, , z1] = world.getObject('cube')!.position;
      world.setObjectTransform('cube', { position: [x1, 3, z1] });
      expect(world.getObject('cube')?.position).toEqual([5, 3, 3]);

      world.destroyObject(spawned[0].id);
      expect(world.getObject(spawned[0].id)).toBeNull();
      expect(world.getObject(spawned[1].id)).toBeNull();
    });

    expect(ids(result.current.objects)).toEqual(['cube']);
    expect(result.current.objects[0].position).toEqual([5, 3, 3]);
    expect(result.current.getObject('cube')?.position).toEqual([5, 3, 3]);
  });

  it('destroys an actor together with its descendants, authored or spawned', () => {
    const authored = [
      levelObject('parent', [0, 0, 0]),
      levelObject('child', [1, 0, 0], 'parent'),
      levelObject('grandchild', [0, 1, 0], 'child'),
      levelObject('other', [5, 0, 0]),
    ];
    const { result } = renderHook(() => useRuntimeLevelWorld(authored));

    act(() => result.current.destroyObject('parent'));
    expect(ids(result.current.objects)).toEqual(['other']);

    const coin = instantiatePrefab(coinPrefab, 'level-1', [20, 0, 20]);
    act(() => result.current.spawnObjects(coin));
    expect(ids(result.current.objects)).toEqual(['other', ...ids(coin)]);
    act(() => result.current.destroyObject(coin[0].id));
    expect(ids(result.current.objects)).toEqual(['other']);

    // An unknown id changes nothing.
    const before = result.current.objects;
    act(() => result.current.destroyObject('missing'));
    expect(result.current.objects).toBe(before);
    expect(ids(authored)).toEqual(['parent', 'child', 'grandchild', 'other']);
  });
});

// --- Through the blueprint runtime -------------------------------------------------------------

const definitionOf = (type: string): WorldNodeDefinition => WORLD_NODE_DEFINITIONS.find(definition => definition.type === type)!;

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

const wire = (from: LogicNode, fromPin: string, to: LogicNode, toPin: string): LogicConnection => ({
  id: `${from.id}.${fromPin}->${to.id}.${toPin}`,
  fromNodeId: from.id,
  fromPinId: from.outputs.find(pin => pin.name === fromPin)!.id,
  toNodeId: to.id,
  toPinId: to.inputs.find(pin => pin.name === toPin)!.id,
});

describe('level blueprint runtime on the session world', () => {
  it('runs Spawn Prefab -> Set Actor Transform and Set -> Set on one actor in a single BeginPlay chain', () => {
    const begin = beginPlay();
    const spawn = paletteNode('spawn', 'SpawnPrefab', { default_Prefab: 'coin', 'default_Position X': 20, 'default_Position Z': 20 });
    const turn = paletteNode('turn', 'SetActorTransform', { 'default_Rotation Y': 90 });
    const moveX = paletteNode('moveX', 'SetActorTransform', { default_Actor: 'cube', 'default_Position X': 5 });
    const moveY = paletteNode('moveY', 'SetActorTransform', { default_Actor: 'cube', 'default_Position Y': 3 });
    const blueprint: LevelBlueprintData = {
      nodes: [begin, spawn, turn, moveX, moveY],
      connections: [
        wire(begin, 'Out', spawn, 'Exec'),
        wire(spawn, 'Out', turn, 'Exec'),
        wire(spawn, 'Spawned Actor', turn, 'Actor'),
        wire(turn, 'Out', moveX, 'Exec'),
        wire(moveX, 'Out', moveY, 'Exec'),
      ],
      variables: [],
    };
    const authored = [levelObject('cube', [1, 2, 3])];

    const { result } = renderHook(() => {
      const world = useRuntimeLevelWorld(authored);
      spawner.spawn = (prefabId, position) => {
        if (prefabId !== coinPrefab.id) return [];
        const objects = instantiatePrefab(coinPrefab, 'level-1', position as Vec3);
        world.spawnObjects(objects);
        return objects.map(obj => obj.id);
      };
      useLevelBlueprintRuntime({
        blueprint,
        levelObjects: world.objects,
        playerEntityRef: { current: null },
        playerApiRef: { current: undefined },
        enemyApiRef: { current: undefined },
        destroyActor: world.destroyObject,
        getObject: world.getObject,
        setObjectTransform: world.setObjectTransform,
        addNotification: () => undefined,
      });
      return world;
    });

    const objects = result.current.objects;
    expect(objects).toHaveLength(3);
    const root = objects.find(obj => obj.prefabId === 'coin' && !obj.parentId)!;
    expect(root.position).toEqual([20, 0, 20]);
    expectVec(root.rotation, [0, Math.PI / 2, 0]);
    expect(objects.find(obj => obj.id === 'cube')!.position).toEqual([5, 3, 3]);
  });
});

// --- Dynamic bodies and taps -------------------------------------------------------------------

describe('world nodes: live poses and input taps', () => {
  it('turns a world-space body pose into the actor transform, local to its parent', () => {
    const parent = levelObject('parent', [10, 0, 0], null, { rotation: [0, Math.PI / 2, 0], scale: [2, 2, 2] });
    const child = levelObject('child', [1, 0, 0], 'parent', { scale: [3, 3, 3] });
    const index = new Map([parent, child].map(obj => [obj.id, obj]));
    const pose = { position: [10, -4, -2] as Vec3, rotation: [0, Math.PI, 0] as Vec3 };

    const root = withWorldPose(parent, pose, id => index.get(id));
    expect(root.position).toEqual([10, -4, -2]);
    expect(root.rotation).toEqual([0, Math.PI, 0]);
    expect(root.scale).toEqual([2, 2, 2]);

    const local = withWorldPose(child, pose, id => index.get(id));
    expect(local.parentId).toBe('parent');
    expect(local.scale).toEqual([3, 3, 3]);
    // Composing it back under the parent gives the body's world pose.
    const world = new THREE.Matrix4().compose(
      new THREE.Vector3(10, 0, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)), new THREE.Vector3(2, 2, 2),
    ).multiply(new THREE.Matrix4().compose(
      new THREE.Vector3(...local.position), new THREE.Quaternion().setFromEuler(new THREE.Euler(...local.rotation)), new THREE.Vector3(1, 1, 1),
    ));
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    world.decompose(position, quaternion, new THREE.Vector3());
    expectVec(position.toArray(), pose.position);
    expect(quaternion.angleTo(new THREE.Quaternion().setFromEuler(new THREE.Euler(...pose.rotation)))).toBeCloseTo(0, 6);
  });

  it('fires Input Action Pressed for a tap released before the run, then Released', () => {
    const tapped = new Set<string>();
    const services: WorldNodeServices = {
      spawnPrefab: () => [],
      playSound: () => undefined,
      getObject: () => null,
      setObjectTransform: () => undefined,
      applyImpulse: () => undefined,
      raycast: () => null,
      input: { isDown: () => false, wasPressed: name => tapped.has(name) },
      vars: createLevelVariablesStore(() => {}),
      print: () => undefined,
    };
    const definition = definitionOf('InputActionPressed');
    const node: FlowNode = {
      id: 'input',
      type: 'InputActionPressed',
      inputs: definition.inputs.map((pin, i) => ({ ...pin, id: `in-${i}` })),
      outputs: definition.outputs.map((pin, i) => ({ ...pin, id: `out-${i}` })),
      data: { ...definition.data, default_Action: 'Fire' },
    };
    const nodeState: Record<string, unknown> = {};
    const run = () => {
      const fired: string[] = [];
      WORLD_NODE_EXECUTORS.InputActionPressed!(node, {
        evaluate: pinName => node.data?.[`default_${pinName}`] ?? null,
        fire: pin => { fired.push(pin); },
        schedule: () => undefined,
        nodeState,
        services,
      });
      return fired;
    };

    expect(run()).toEqual(['Out']);
    // Pressed and released between two frames: isDown never saw it, the frame's tap buffer did.
    tapped.add('Fire');
    expect(run()).toEqual(['Pressed', 'Out']);
    expect(run()).toEqual(['Out']);
    tapped.delete('Fire');
    expect(run()).toEqual(['Released', 'Out']);
  });
});
