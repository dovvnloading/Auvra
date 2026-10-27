import { act, renderHook } from '@testing-library/react';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { GraphRuntimeAPI } from '../../components/AnimationGraph/GraphRuntime';
import type { SandboxEntityHandle } from '../../components/Sandbox/SandboxEntity';
import { flowNodeOutputValue, FlowNode } from '../../hooks/levelBlueprintNodes/flow';
import {
  DEFAULT_ANIMATION_BLEND_IN,
  PLAYER_ACTOR_ID,
  WORLD_NODE_DEFINITIONS,
  WORLD_NODE_EXECUTORS,
  WorldNodeServices,
  WorldNodeType,
  findActorObject3D,
  setActorMorphTarget,
} from '../../hooks/levelBlueprintNodes/world';
import { useLevelBlueprintRuntime, UseLevelBlueprintRuntimeProps } from '../../hooks/useLevelBlueprintRuntime';
import { createLevelVariablesStore } from '../../runtime/levelVariables';
import type { LevelBlueprintData, LogicConnection, LogicNode, LogicPin } from '../../types';

/** Play Player Animation and Set Morph Target: executors on fake services, the live-object helpers, and play mode. */

const frame = vi.hoisted(() => ({ callback: null as ((state: unknown, delta: number) => void) | null }));

vi.mock('@react-three/fiber', () => ({
  useFrame: (callback: (state: unknown, delta: number) => void) => { frame.callback = callback; },
}));

const runFrame = (state: unknown = {}) => act(() => { frame.callback?.(state, 1 / 60); });

type Fired = { pin: string; data?: Record<string, unknown> };

/** World services with the animation services as given (or absent). */
const fakeServices = (animation: Pick<WorldNodeServices, 'playPlayerAnimation' | 'setMorphTarget'> = {}): WorldNodeServices => ({
  spawnPrefab: () => [],
  playSound: () => undefined,
  getObject: () => null,
  setObjectTransform: () => undefined,
  applyImpulse: () => undefined,
  raycast: () => null,
  input: { isDown: () => false },
  vars: createLevelVariablesStore(() => {}),
  print: () => undefined,
  ...animation,
});

/** Places a palette node and runs it the way the runtime would, recording what it fires. */
const harness = (type: WorldNodeType, inputs: Record<string, unknown>, services: WorldNodeServices) => {
  const definition = WORLD_NODE_DEFINITIONS.find(d => d.type === type)!;
  const node: FlowNode = {
    id: `${type}-1`,
    type,
    inputs: definition.inputs.map((pin, i) => ({ ...pin, id: `in-${i}` })),
    outputs: definition.outputs.map((pin, i) => ({ ...pin, id: `out-${i}` })),
    data: { ...definition.data },
  };
  const fired: Fired[] = [];
  const nodeState: Record<string, unknown> = {};
  const run = () => WORLD_NODE_EXECUTORS[type]!(node, {
    evaluate: pinName => {
      expect(node.inputs.some(p => p.name === pinName && p.dataType !== 'Exec')).toBe(true);
      return pinName in inputs ? inputs[pinName] : node.data?.[`default_${pinName}`] ?? null;
    },
    fire: (pin, data) => {
      expect(node.outputs.some(p => p.name === pin && p.dataType === 'Exec')).toBe(true);
      fired.push(data === undefined ? { pin } : { pin, data });
    },
    schedule: () => { throw new Error('animation nodes do not schedule'); },
    nodeState,
    services,
  });
  const out = (pin: string) => {
    expect(node.outputs.some(p => p.name === pin && p.dataType !== 'Exec')).toBe(true);
    return flowNodeOutputValue(nodeState, pin);
  };
  return { run, out, fired };
};

/** A mesh with the named morph targets, every influence starting at 0. */
const morphMesh = (morphs: string[], skinned = false): THREE.Mesh => {
  const mesh = skinned ? new THREE.SkinnedMesh() : new THREE.Mesh();
  mesh.morphTargetDictionary = Object.fromEntries(morphs.map((name, i) => [name, i]));
  mesh.morphTargetInfluences = morphs.map(() => 0);
  return mesh;
};

/** An actor's transform group as play mode draws it: tagged with the actor's id. */
const actorGroup = (id: string, ...children: THREE.Object3D[]): THREE.Group => {
  const group = new THREE.Group();
  group.userData = { levelObjectId: id };
  if (children.length > 0) group.add(...children);
  return group;
};

const influence = (mesh: THREE.Mesh, morph: string) => mesh.morphTargetInfluences![mesh.morphTargetDictionary![morph]];

describe('Play Player Animation node', () => {
  it('declares its pins and defaults', () => {
    const definition = WORLD_NODE_DEFINITIONS.find(d => d.type === 'PlayPlayerAnimation')!;
    expect(definition.inputs.map(p => `${p.name}:${p.dataType}`)).toEqual(['Exec:Exec', 'Clip:String', 'Mask Bone:String', 'Blend In:Float', 'Rate:Float']);
    expect(definition.outputs.map(p => `${p.name}:${p.dataType}`)).toEqual(['Out:Exec', 'Played:Boolean']);
    expect(definition.data).toEqual({ default_Clip: '', 'default_Mask Bone': '', 'default_Blend In': DEFAULT_ANIMATION_BLEND_IN, default_Rate: 1 });
    expect(DEFAULT_ANIMATION_BLEND_IN).toBe(0.15);
  });

  it('plays the clip on the full body with the default blend and rate', () => {
    const playPlayerAnimation = vi.fn(() => true);
    const node = harness('PlayPlayerAnimation', { Clip: ' Wave ' }, fakeServices({ playPlayerAnimation }));
    node.run();
    expect(playPlayerAnimation).toHaveBeenCalledWith('Wave', { blendIn: 0.15, rate: 1 });
    expect(node.fired).toEqual([{ pin: 'Out', data: { Played: true } }]);
    expect(node.out('Played')).toBe(true);
  });

  it('passes the mask bone, blend and rate, and reports a clip the player cannot play', () => {
    const playPlayerAnimation = vi.fn(() => false);
    const node = harness('PlayPlayerAnimation', { Clip: 'Punch', 'Mask Bone': ' Spine ', 'Blend In': '0.3', Rate: 2 }, fakeServices({ playPlayerAnimation }));
    node.run();
    expect(playPlayerAnimation).toHaveBeenCalledWith('Punch', { blendIn: 0.3, rate: 2, maskBone: 'Spine' });
    expect(node.fired).toEqual([{ pin: 'Out', data: { Played: false } }]);
  });

  it('continues with Played false when there is no animation service', () => {
    const node = harness('PlayPlayerAnimation', { Clip: 'Wave' }, fakeServices());
    node.run();
    expect(node.fired).toEqual([{ pin: 'Out', data: { Played: false } }]);
  });

  it('plays nothing without a clip or with a rate that is not above 0', () => {
    const playPlayerAnimation = vi.fn(() => true);
    const services = fakeServices({ playPlayerAnimation });
    for (const inputs of [{}, { Clip: '   ' }, { Clip: { name: 'Wave' } }, { Clip: 'Wave', Rate: 0 }, { Clip: 'Wave', Rate: -1 }]) {
      const node = harness('PlayPlayerAnimation', inputs, services);
      node.run();
      expect(node.fired).toEqual([{ pin: 'Out', data: { Played: false } }]);
    }
    expect(playPlayerAnimation).not.toHaveBeenCalled();
  });

  it('falls back on bad numbers: a non-numeric blend or rate takes the default, a negative blend snaps', () => {
    const playPlayerAnimation = vi.fn(() => true);
    const services = fakeServices({ playPlayerAnimation });
    harness('PlayPlayerAnimation', { Clip: 'Wave', 'Blend In': 'slow', Rate: 'fast' }, services).run();
    harness('PlayPlayerAnimation', { Clip: 'Wave', 'Blend In': -2, Rate: null, 'Mask Bone': 42 }, services).run();
    expect(playPlayerAnimation.mock.calls).toEqual([
      ['Wave', { blendIn: 0.15, rate: 1 }],
      ['Wave', { blendIn: 0, rate: 1, maskBone: '42' }],
    ]);
  });

  it('only counts a service result of true as played', () => {
    const playPlayerAnimation = vi.fn(() => 1 as unknown as boolean);
    const node = harness('PlayPlayerAnimation', { Clip: 'Wave' }, fakeServices({ playPlayerAnimation }));
    node.run();
    expect(node.out('Played')).toBe(false);
  });
});

describe('Set Morph Target node', () => {
  it('declares its pins and defaults', () => {
    const definition = WORLD_NODE_DEFINITIONS.find(d => d.type === 'SetMorphTarget')!;
    expect(definition.inputs.map(p => `${p.name}:${p.dataType}`)).toEqual(['Exec:Exec', 'Actor:Object', 'Morph:String', 'Weight:Float']);
    expect(definition.outputs.map(p => `${p.name}:${p.dataType}`)).toEqual(['Out:Exec', 'Meshes Changed:Integer']);
    expect(definition.data).toEqual({ default_Actor: '', default_Morph: '', default_Weight: 1 });
  });

  it('sets the weight on the actor and reports how many meshes changed', () => {
    const setMorphTarget = vi.fn(() => 2);
    const node = harness('SetMorphTarget', { Actor: { id: 'face' }, Morph: ' Smile ', Weight: '0.5' }, fakeServices({ setMorphTarget }));
    node.run();
    expect(setMorphTarget).toHaveBeenCalledWith('face', 'Smile', 0.5);
    expect(node.fired).toEqual([{ pin: 'Out', data: { 'Meshes Changed': 2 } }]);
    expect(node.out('Meshes Changed')).toBe(2);
  });

  it('uses the default weight of 1 and clamps weights to [0, 1]', () => {
    const setMorphTarget = vi.fn(() => 1);
    const services = fakeServices({ setMorphTarget });
    harness('SetMorphTarget', { Actor: 'face', Morph: 'Smile' }, services).run();
    harness('SetMorphTarget', { Actor: 'face', Morph: 'Smile', Weight: 3 }, services).run();
    harness('SetMorphTarget', { Actor: 'face', Morph: 'Smile', Weight: -0.5 }, services).run();
    expect(setMorphTarget.mock.calls).toEqual([['face', 'Smile', 1], ['face', 'Smile', 1], ['face', 'Smile', 0]]);
  });

  it('changes nothing without an actor, a morph name or a numeric weight', () => {
    const setMorphTarget = vi.fn(() => 1);
    const services = fakeServices({ setMorphTarget });
    for (const inputs of [
      { Morph: 'Smile' },
      { Actor: '  ', Morph: 'Smile' },
      { Actor: 7, Morph: 'Smile' },
      { Actor: 'face' },
      { Actor: 'face', Morph: { name: 'Smile' } },
      { Actor: 'face', Morph: 'Smile', Weight: 'heavy' },
      { Actor: 'face', Morph: 'Smile', Weight: null },
      { Actor: 'face', Morph: 'Smile', Weight: Number.NaN },
    ]) {
      const node = harness('SetMorphTarget', inputs, services);
      node.run();
      expect(node.fired).toEqual([{ pin: 'Out', data: { 'Meshes Changed': 0 } }]);
    }
    expect(setMorphTarget).not.toHaveBeenCalled();
  });

  it('continues with no meshes changed when there is no morph service', () => {
    const node = harness('SetMorphTarget', { Actor: 'face', Morph: 'Smile', Weight: 1 }, fakeServices());
    node.run();
    expect(node.fired).toEqual([{ pin: 'Out', data: { 'Meshes Changed': 0 } }]);
  });
});

describe('live actor objects', () => {
  it('finds the outermost group tagged with an actor id', () => {
    const inner = actorGroup('face');
    const face = actorGroup('face', inner);
    const hat = actorGroup('hat');
    const scene = new THREE.Scene();
    scene.add(new THREE.Group().add(face), hat);
    expect(findActorObject3D(scene, 'face')).toBe(face);
    expect(findActorObject3D(scene, 'hat')).toBe(hat);
    expect(findActorObject3D(scene, 'ghost')).toBeNull();
  });

  it('sets a morph on every mesh of the actor that has it, leaving nested actors alone', () => {
    const head = morphMesh(['Blink', 'Smile']);
    const teeth = morphMesh(['Smile'], true);
    const plain = new THREE.Mesh();
    const other = morphMesh(['Frown']);
    const body = actorGroup('face', morphMesh(['Smile']));
    const hatMesh = morphMesh(['Smile']);
    const face = actorGroup('face', new THREE.Group().add(head, teeth), plain, other, body, actorGroup('hat', hatMesh));

    expect(setActorMorphTarget(face, 'Smile', 0.7)).toBe(3);
    expect(influence(head, 'Smile')).toBe(0.7);
    expect(influence(head, 'Blink')).toBe(0);
    expect(influence(teeth, 'Smile')).toBe(0.7);
    expect(influence(hatMesh, 'Smile')).toBe(0);
    expect(influence(other, 'Frown')).toBe(0);
    expect(setActorMorphTarget(face, 'Pout', 1)).toBe(0);
  });

  it('skips a mesh whose dictionary points past its influences', () => {
    const broken = morphMesh(['Smile']);
    broken.morphTargetInfluences = [];
    expect(setActorMorphTarget(actorGroup('face', broken), 'Smile', 1)).toBe(0);
    expect(broken.morphTargetInfluences).toEqual([]);
  });
});

// --- Play mode ----------------------------------------------------------------------------------

const execPin = (id: string, name: string, direction: LogicPin['direction']): LogicPin => ({ id, name, dataType: 'Exec', direction });

const paletteNode = (id: string, type: WorldNodeType, data: Record<string, unknown> = {}): LogicNode => {
  const definition = WORLD_NODE_DEFINITIONS.find(d => d.type === type)!;
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

const eventNode = (id: string, name: string): LogicNode => ({
  id, type: 'Event', name, position: { x: 0, y: 0 }, inputs: [], outputs: [execPin(`${id}:out:Out`, 'Out', 'Output')],
});

/** Print String showing a data output it is wired to. */
const printValue = (id: string): LogicNode => ({
  id, type: 'PrintString', name: 'Print String', position: { x: 0, y: 0 },
  inputs: [execPin(`${id}:in:In`, 'In', 'Input'), { id: `${id}:in:String`, name: 'String', dataType: 'String', direction: 'Input' }],
  outputs: [execPin(`${id}:out:Out`, 'Out', 'Output')],
  data: { printMessage: 'unset' },
});

const wire = (from: LogicNode, fromPin: string, to: LogicNode, toPin: string): LogicConnection => ({
  id: `${from.id}.${fromPin}->${to.id}.${toPin}`,
  fromNodeId: from.id,
  fromPinId: from.outputs.find(pin => pin.name === fromPin)!.id,
  toNodeId: to.id,
  toPinId: to.inputs.find(pin => pin.name === toPin)!.id,
});

/** `event` -> `node` -> Print String of the node's `output`. */
const chain = (event: LogicNode, node: LogicNode, output: string): LevelBlueprintData => {
  const print = printValue('print');
  return {
    nodes: [event, node, print],
    connections: [wire(event, 'Out', node, 'Exec'), wire(node, 'Out', print, 'In'), wire(node, output, print, 'String')],
    variables: [],
  };
};

const runtimeProps = (blueprint: LevelBlueprintData, overrides: Partial<UseLevelBlueprintRuntimeProps> = {}): UseLevelBlueprintRuntimeProps => ({
  blueprint,
  levelObjects: [],
  playerEntityRef: { current: null },
  playerApiRef: { current: undefined },
  enemyApiRef: { current: undefined },
  destroyActor: () => undefined,
  addNotification: () => undefined,
  ...overrides,
});

const printedBy = (addNotification: ReturnType<typeof vi.fn>) =>
  addNotification.mock.calls.map(([notification]) => (notification as { message: string }).message);

const playerApi = (playMontage?: GraphRuntimeAPI['playMontage']): GraphRuntimeAPI => ({
  setVariable: () => undefined,
  getVariable: () => undefined,
  getVariables: () => ({}),
  playMontage,
});

const playerEntity = (object: THREE.Group) => ({ current: { object } as unknown as SandboxEntityHandle });

describe('animation nodes in play mode', () => {
  it("plays a clip through the player's montage API", () => {
    const playMontage = vi.fn(() => true);
    const addNotification = vi.fn();
    const node = paletteNode('anim', 'PlayPlayerAnimation', { default_Clip: 'Wave', 'default_Mask Bone': 'Spine' });
    renderHook(() => useLevelBlueprintRuntime(runtimeProps(chain(eventNode('begin', 'Event BeginPlay'), node, 'Played'), {
      playerApiRef: { current: playerApi(playMontage) },
      addNotification,
    })));
    expect(playMontage).toHaveBeenCalledWith('Wave', { blendIn: 0.15, rate: 1, maskBone: 'Spine' });
    expect(printedBy(addNotification)).toEqual(['[Output] true']);
  });

  it('reports Played false before the player animation API exists or without montage support', () => {
    const addNotification = vi.fn();
    const blueprint = chain(eventNode('begin', 'Event BeginPlay'), paletteNode('anim', 'PlayPlayerAnimation', { default_Clip: 'Wave' }), 'Played');
    renderHook(() => useLevelBlueprintRuntime(runtimeProps(blueprint, { addNotification })));
    renderHook(() => useLevelBlueprintRuntime(runtimeProps(blueprint, { playerApiRef: { current: playerApi() }, addNotification })));
    expect(printedBy(addNotification)).toEqual(['[Output] false', '[Output] false']);
  });

  it("sets a level actor's morph at BeginPlay, finding the scene above the player's model", () => {
    const smile = morphMesh(['Smile']);
    const player = new THREE.Group();
    const scene = new THREE.Scene();
    scene.add(player, new THREE.Group().add(actorGroup('statue', smile)));
    const addNotification = vi.fn();
    const node = paletteNode('morph', 'SetMorphTarget', { default_Actor: 'statue', default_Morph: 'Smile', default_Weight: 0.25 });
    renderHook(() => useLevelBlueprintRuntime(runtimeProps(chain(eventNode('begin', 'Event BeginPlay'), node, 'Meshes Changed'), {
      playerEntityRef: playerEntity(player),
      addNotification,
    })));
    expect(influence(smile, 'Smile')).toBe(0.25);
    expect(printedBy(addNotification)).toEqual(['[Output] 1']);
  });

  it("sets the player character's morph by the player actor id", () => {
    const face = morphMesh(['Blink']);
    const player = new THREE.Group().add(face);
    const node = paletteNode('morph', 'SetMorphTarget', { default_Actor: PLAYER_ACTOR_ID, default_Morph: 'Blink' });
    renderHook(() => useLevelBlueprintRuntime(runtimeProps(chain(eventNode('begin', 'Event BeginPlay'), node, 'Meshes Changed'), {
      playerEntityRef: playerEntity(player),
    })));
    expect(influence(face, 'Blink')).toBe(1);
  });

  it('finds actors in the frame loop scene, and again after the actor is redrawn', () => {
    const addNotification = vi.fn();
    const node = paletteNode('morph', 'SetMorphTarget', { default_Actor: 'statue', default_Morph: 'Smile', default_Weight: 0.5 });
    renderHook(() => useLevelBlueprintRuntime(runtimeProps(chain(eventNode('tick', 'Event Tick'), node, 'Meshes Changed'), { addNotification })));

    // There is no player model to search from: the frame loop hands over the scene.
    const first = morphMesh(['Smile']);
    const firstGroup = actorGroup('statue', first);
    const scene = new THREE.Scene().add(firstGroup);
    runFrame({ scene });
    expect(influence(first, 'Smile')).toBe(0.5);

    // The session redraws the actor as a new group; the remembered one is no longer in the scene.
    scene.remove(firstGroup);
    const second = morphMesh(['Smile']);
    scene.add(actorGroup('statue', second));
    runFrame({ scene });
    expect(influence(second, 'Smile')).toBe(0.5);

    scene.clear();
    runFrame({ scene });
    expect(printedBy(addNotification)).toEqual(['[Output] 1', '[Output] 1', '[Output] 0']);
  });
});
