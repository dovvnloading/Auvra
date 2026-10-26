import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { flowNodeOutputValue, FlowNode } from '../../hooks/levelBlueprintNodes/flow';
import {
  WORLD_NODE_DEFINITIONS,
  WORLD_NODE_EXECUTORS,
  WorldNodeServices,
  WorldNodeType,
  WorldObjectTransform,
  formatPrintMessage,
  isPureWorldNodeType,
  isWorldNodeType,
} from '../../hooks/levelBlueprintNodes/world';
import { createLevelVariablesStore } from '../../runtime/levelVariables';

type Fired = { pin: string; data?: Record<string, unknown> };

/** In-memory world: objects by id, every service call recorded. */
const fakeServices = (objects: WorldObjectTransform[] = []) => {
  const world = new Map(objects.map(object => [object.id, { ...object }]));
  const down = new Set<string>();
  const services = {
    spawnPrefab: vi.fn((prefabId: string) => [`${prefabId}-root`, `${prefabId}-child`]),
    playSound: vi.fn(),
    getObject: vi.fn((id: string) => world.get(id) ?? null),
    setObjectTransform: vi.fn(),
    applyImpulse: vi.fn(),
    raycast: vi.fn((): ReturnType<WorldNodeServices['raycast']> => null),
    input: { isDown: (name: string) => down.has(name) },
    vars: createLevelVariablesStore(() => {}),
    print: vi.fn(),
  } satisfies WorldNodeServices;
  return { services, down };
};

/** Places a palette node and runs it the way the runtime would, recording what it fires. */
const harness = (type: WorldNodeType, inputs: Record<string, unknown> = {}, services = fakeServices().services) => {
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
  const values = { ...inputs };
  const run = () => WORLD_NODE_EXECUTORS[type]!(node, {
    evaluate: pinName => {
      expect(node.inputs.some(p => p.name === pinName && p.dataType !== 'Exec')).toBe(true);
      return pinName in values ? values[pinName] : node.data?.[`default_${pinName}`] ?? null;
    },
    fire: (pin, data) => {
      expect(node.outputs.some(p => p.name === pin && p.dataType === 'Exec')).toBe(true);
      fired.push(data === undefined ? { pin } : { pin, data });
    },
    schedule: () => { throw new Error('world nodes do not schedule'); },
    nodeState,
    services,
  });
  const out = (pin: string) => {
    expect(node.outputs.some(p => p.name === pin && p.dataType !== 'Exec')).toBe(true);
    return flowNodeOutputValue(nodeState, pin);
  };
  const pins = () => fired.map(f => f.pin);
  return { run, out, pins, fired, values, nodeState, services };
};

const crate: WorldObjectTransform = { id: 'crate', position: [1, 2, 3], rotation: [0, Math.PI / 2, 0], scale: [2, 2, 2] };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('level blueprint world nodes', () => {
  it('defines a palette entry for every executor; pure nodes have no exec pins', () => {
    expect(WORLD_NODE_DEFINITIONS.map(d => d.type).sort()).toEqual(Object.keys(WORLD_NODE_EXECUTORS).sort());
    for (const definition of WORLD_NODE_DEFINITIONS) {
      const names = [...definition.inputs, ...definition.outputs].map(p => p.name);
      expect(new Set(names).size).toBe(names.length);
      expect(definition.inputs.every(p => p.direction === 'Input')).toBe(true);
      expect(definition.outputs.every(p => p.direction === 'Output')).toBe(true);
      const execPins = [...definition.inputs, ...definition.outputs].filter(p => p.dataType === 'Exec');
      expect(execPins.length === 0).toBe(definition.pure === true);
    }
    expect(isWorldNodeType('Raycast')).toBe(true);
    expect(isWorldNodeType('Sequence')).toBe(false);
    expect(isPureWorldNodeType('RandomInt')).toBe(true);
    expect(isPureWorldNodeType('SpawnPrefab')).toBe(false);
    expect(WORLD_NODE_EXECUTORS.Branch).toBeUndefined();
  });

  it('spawns a prefab at the given position and outputs its root', () => {
    const node = harness('SpawnPrefab', { Prefab: ' crate ', 'Position X': 4, 'Position Y': '1.5' });
    node.run();
    expect(node.services.spawnPrefab).toHaveBeenCalledWith('crate', [4, 1.5, 0]);
    expect(node.fired).toEqual([{ pin: 'Out', data: { 'Spawned Actor': 'crate-root' } }]);
    expect(node.out('Spawned Actor')).toBe('crate-root');

    const blank = harness('SpawnPrefab');
    blank.run();
    expect(blank.services.spawnPrefab).not.toHaveBeenCalled();
    expect(blank.pins()).toEqual(['Out']);
    expect(blank.out('Spawned Actor')).toBeNull();
  });

  it('reads an actor transform with rotation in degrees', () => {
    const { services } = fakeServices([crate]);
    const node = harness('GetActorTransform', { Actor: { id: 'crate' } }, services);
    node.run();
    expect(node.pins()).toEqual([]);
    expect(node.out('Found')).toBe(true);
    expect([node.out('Position X'), node.out('Position Y'), node.out('Position Z')]).toEqual([1, 2, 3]);
    expect(node.out('Rotation Y')).toBeCloseTo(90);
    expect(node.out('Scale Z')).toBe(2);

    const missing = harness('GetActorTransform', { Actor: 'ghost' }, services);
    missing.run();
    expect(missing.out('Found')).toBe(false);
    expect(missing.out('Scale X')).toBe(1);
  });

  it('sets only the transform axes that are wired or filled in', () => {
    const { services } = fakeServices([crate]);
    const node = harness('SetActorTransform', { Actor: 'crate', 'Position Y': 5, 'Rotation X': 180 }, services);
    node.run();
    expect(services.setObjectTransform).toHaveBeenCalledTimes(1);
    const [id, partial] = services.setObjectTransform.mock.calls[0] as unknown as [string, Record<string, number[]>];
    expect(id).toBe('crate');
    expect(Object.keys(partial).sort()).toEqual(['position', 'rotation']);
    expect(partial.position).toEqual([1, 5, 3]);
    expect(partial.rotation[0]).toBeCloseTo(Math.PI);
    expect(partial.rotation[1]).toBe(Math.PI / 2);
    expect(node.pins()).toEqual(['Out']);

    const missing = harness('SetActorTransform', { Actor: 'ghost', 'Position X': 1 }, services);
    missing.run();
    expect(services.setObjectTransform).toHaveBeenCalledTimes(1);
    expect(missing.pins()).toEqual(['Out']);
  });

  it('plays sounds on a valid bus and applies impulses', () => {
    const sound = harness('PlaySound', { Sound: 'boom', Bus: 'Music' });
    sound.run();
    expect(sound.services.playSound).toHaveBeenCalledWith('boom', 'music');
    const badBus = harness('PlaySound', { Sound: 'boom', Bus: 'loud' });
    badBus.run();
    expect(badBus.services.playSound).toHaveBeenCalledWith('boom', undefined);
    const silent = harness('PlaySound');
    silent.run();
    expect(silent.services.playSound).not.toHaveBeenCalled();
    expect(silent.pins()).toEqual(['Out']);

    const push = harness('ApplyImpulse', { Actor: 'crate', 'Impulse Y': 10 });
    push.run();
    expect(push.services.applyImpulse).toHaveBeenCalledWith('crate', [0, 10, 0]);
    const zero = harness('ApplyImpulse', { Actor: 'crate' });
    zero.run();
    expect(zero.services.applyImpulse).not.toHaveBeenCalled();
  });

  it('raycasts along a normalized direction and reports the hit', () => {
    const { services } = fakeServices();
    services.raycast.mockImplementation(() => ({ objectId: 'floor', point: new THREE.Vector3(0, 0, 0), normal: new THREE.Vector3(0, 1, 0) }));
    const node = harness('Raycast', { 'Origin Y': 4, 'Direction Y': -8, 'Max Distance': 50 }, services);
    node.run();
    const [origin, direction, distance] = services.raycast.mock.calls[0] as unknown as [THREE.Vector3, THREE.Vector3, number];
    expect(origin.toArray()).toEqual([0, 4, 0]);
    expect(direction.toArray()).toEqual([0, -1, 0]);
    expect(distance).toBe(50);
    expect(node.pins()).toEqual(['Out']);
    expect(node.out('Hit')).toBe(true);
    expect(node.out('Hit Actor')).toBe('floor');
    expect(node.out('Hit Normal Y')).toBe(1);
    expect(node.out('Distance')).toBe(4);

    const zeroDirection = harness('Raycast', { 'Direction Y': 0 }, services);
    zeroDirection.run();
    expect(services.raycast).toHaveBeenCalledTimes(1);
    expect(zeroDirection.out('Hit')).toBe(false);
    expect(zeroDirection.out('Hit Position X')).toBeNull();
  });

  it('gets and sets level variables through the store', () => {
    const { services } = fakeServices();
    services.vars.reset([{ name: 'Score', type: 'Float', value: 2 }]);
    const set = harness('SetLevelVariable', { Name: 'Score', Value: '7' }, services);
    set.run();
    expect(set.fired).toEqual([{ pin: 'Out', data: { Success: true } }]);
    expect(services.vars.get('Score')).toBe(7);

    const reject = harness('SetLevelVariable', { Name: 'Score', Value: 'lots' }, services);
    reject.run();
    expect(reject.out('Success')).toBe(false);

    const get = harness('GetLevelVariable', { Name: 'Score' }, services);
    get.run();
    expect(get.out('Value')).toBe(7);
    expect(get.out('Is Set')).toBe(true);
    const unknown = harness('GetLevelVariable', { Name: 'Nope' }, services);
    unknown.run();
    expect(unknown.out('Value')).toBeNull();
    expect(unknown.out('Is Set')).toBe(false);
  });

  it('fires Pressed and Released once per input edge, then Out', () => {
    const { services, down } = fakeServices();
    const node = harness('InputActionPressed', { Action: 'Fire' }, services);
    const step = (held: boolean) => {
      if (held) down.add('Fire'); else down.delete('Fire');
      node.fired.length = 0;
      node.run();
      return node.pins();
    };
    expect(step(false)).toEqual(['Out']);
    expect(step(true)).toEqual(['Pressed', 'Out']);
    expect(node.out('Is Down')).toBe(true);
    expect(step(true)).toEqual(['Out']);
    expect(step(false)).toEqual(['Released', 'Out']);
    expect(node.out('Is Down')).toBe(false);
  });

  it('draws random numbers within the bounds, swapping reversed ones', () => {
    const random = vi.spyOn(Math, 'random');
    random.mockReturnValue(0.5);
    const float = harness('RandomFloat', { Min: 10, Max: 2 });
    float.run();
    expect(float.out('Value')).toBe(6);

    random.mockReturnValue(0.999999);
    const int = harness('RandomInt', { Min: 1, Max: 6 });
    int.run();
    expect(int.out('Value')).toBe(6);
    random.mockReturnValue(0);
    int.run();
    expect(int.out('Value')).toBe(1);
  });

  it('prints a formatted message', () => {
    const node = harness('Print', { Format: 'Score {0}/{1} at {2} {{ok}} {7}', 'Arg 0': 3, 'Arg 1': 10.12345, 'Arg 2': [1, 2.5, 0] });
    node.run();
    const message = 'Score 3/10.123 at 1, 2.5, 0 {ok} {7}';
    expect(node.services.print).toHaveBeenCalledWith(message);
    expect(node.fired).toEqual([{ pin: 'Out', data: { Message: message } }]);

    const defaults = harness('Print');
    defaults.run();
    expect(defaults.services.print).toHaveBeenCalledWith('Hello ');
    expect(formatPrintMessage('{0} {1}', [true, null])).toBe('true ');
  });
});
