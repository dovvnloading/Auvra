import { act, render } from '@testing-library/react';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { SCRIPT_COMPONENT, SCRIPT_COMPONENT_TYPE, readScriptSource } from '../../runtime/components/scriptComponent';
import { DEFAULT_INPUT_MAP, InputState } from '../../runtime/input';
import type { PhysicsRaycastHit } from '../../runtime/physicsQueries';
import { SCRIPT_LIMITS, type ScriptCommand, type ScriptHostMessage, type ScriptSnapshot } from '../../runtime/scripting/protocol';
import {
  applyScriptCommand,
  buildScriptSnapshot,
  collectScriptSources,
  createScriptCommandResults,
  fitScriptSnapshot,
  parseScriptCommand,
  parseScriptFrameMessage,
  readScriptInputActions,
  ScriptRuntime,
  type ScriptCommandServices,
  type ScriptRuntimeProps,
  type ScriptSnapshotSources,
} from '../../runtime/scripting/ScriptRuntime';
import { animationEvents } from '../../runtime/animationEvents';
import { createTriggerEvents, TriggerEventsProvider } from '../../runtime/triggers';
import type { LevelComponent, LevelObject } from '../../types';

const fiber = vi.hoisted(() => ({
  frame: null as ((state: unknown, delta: number) => void) | null,
  scene: null as unknown,
}));

vi.mock('@react-three/fiber', () => ({
  useFrame: (callback: (state: unknown, delta: number) => void) => { fiber.frame = callback; },
  useThree: (selector: (state: { scene: unknown }) => unknown) => selector({ scene: fiber.scene }),
}));

// The editor inspector is not under test; the runtime only needs the definition around it.
vi.mock('../../components/Scripting/ScriptInspector', () => ({ ScriptInspector: () => null }));

type Vec3 = [number, number, number];

const script = (id: string, source: string, enabled = true): LevelComponent => ({ id, type: SCRIPT_COMPONENT_TYPE, enabled, props: { source } });

const levelObject = (id: string, overrides: Partial<LevelObject> = {}): LevelObject => ({
  id, levelId: 'level-1', modelId: 'model-1', name: `Object ${id}`, type: 'prop',
  position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], ...overrides,
});

const snapshotSources = (overrides: Partial<ScriptSnapshotSources> = {}): ScriptSnapshotSources => ({
  frame: 4, time: 2, delta: 0.5, objects: [], liveIds: new Set(), getObject: () => null, hidden: new Set(),
  player: null, input: {}, variables: {}, events: [], raycasts: new Map(), ...overrides,
});

/** Fake session services that record every call. */
const fakeServices = (objects: LevelObject[] = []) => {
  const calls: unknown[][] = [];
  const record = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
  const hit: PhysicsRaycastHit = { objectId: 'wall', point: new THREE.Vector3(0, 1, 5), normal: new THREE.Vector3(0, 0, -1), distance: 5 };
  const services: ScriptCommandServices = {
    getObject: id => objects.find(object => object.id === id) ?? null,
    setObjectTransform: record('setObjectTransform'),
    setVisible: record('setVisible'),
    applyImpulse: record('applyImpulse'),
    destroyObject: record('destroyObject'),
    spawnPrefab: (prefabId, position) => { calls.push(['spawnPrefab', prefabId, position]); return prefabId === 'crate' ? ['crate-root', 'crate-lid'] : []; },
    setVariable: (name, value) => { calls.push(['setVariable', name, value]); return true; },
    playSound: record('playSound'),
    sendNetEvent: record('sendNetEvent'),
    setCamera: record('setCamera'),
    startDialogue: objectId => { calls.push(['startDialogue', objectId]); return true; },
    enterVehicle: objectId => { calls.push(['enterVehicle', objectId]); return true; },
    exitVehicle: () => { calls.push(['exitVehicle']); return true; },
    setVehicleInput: (objectId, controls) => { calls.push(['setVehicleInput', objectId, controls]); return true; },
    particles: (objectId, action) => { calls.push(['particles', objectId, action]); return true; },
    setTimeOfDay: hours => { calls.push(['setTimeOfDay', hours]); },
    setDayLength: minutes => { calls.push(['setDayLength', minutes]); },
    setWeather: (name, seconds) => { calls.push(['setWeather', name, seconds]); return true; },
    setSkyPreset: (name, seconds, withHour) => { calls.push(['setSkyPreset', name, seconds, withHour]); return true; },
    explode: (position, radius, damage, force) => { calls.push(['explode', position, radius, damage, force]); },
    breakObject: objectId => { calls.push(['breakObject', objectId]); return true; },
    damageObject: (objectId, amount) => { calls.push(['damageObject', objectId, amount]); return true; },
    useAbility: (actorId, abilityId, targetId) => { calls.push(['useAbility', actorId, abilityId, targetId]); return true; },
    applyEffect: (targetId, effectId, sourceId) => { calls.push(['applyEffect', targetId, effectId, sourceId]); return true; },
    removeEffect: (actorId, effectId) => { calls.push(['removeEffect', actorId, effectId]); return true; },
    changeAttribute: (actorId, attribute, amount, set) => { calls.push(['changeAttribute', actorId, attribute, amount, set]); return true; },
    setTag: (actorId, tag, on) => { calls.push(['setTag', actorId, tag, on]); return true; },
    raycast: (origin, direction, maxDistance, options) => {
      calls.push(['raycast', origin.toArray(), direction.toArray(), maxDistance, options]);
      return direction.z > 0 ? hit : null;
    },
    playPlayerAnimation: (clipName, maskBone) => { calls.push(['playPlayerAnimation', clipName, maskBone]); return true; },
    damagePlayer: amount => { calls.push(['damagePlayer', amount]); return true; },
    healPlayer: amount => { calls.push(['healPlayer', amount]); return true; },
    addAmmo: (rounds, weapon) => { calls.push(['addAmmo', rounds, weapon]); return true; },
    giveWeapon: weapon => { calls.push(['giveWeapon', weapon]); return true; },
    openLevel: record('openLevel'),
    log: record('log'),
  };
  return { services, calls };
};

describe('script component', () => {
  it('stores its source in props; the editor attaches its inspector', () => {
    expect(SCRIPT_COMPONENT.type).toBe('script');
    expect(SCRIPT_COMPONENT.props).toEqual([]);
    // Editor UI stays out of the runtime definition (and the player bundle); componentInspectors adds it.
    expect(SCRIPT_COMPONENT.Inspector).toBeUndefined();
    expect(readScriptSource(script('s', 'onUpdate() {}'))).toBe('onUpdate() {}');
    expect(readScriptSource({ props: { source: 42 } })).toBe('');
    expect(readScriptSource({ props: {} })).toBe('');
  });
});

describe('collectScriptSources', () => {
  it('takes enabled, non-blank script components and bounds their size', () => {
    const huge = 'x'.repeat(SCRIPT_LIMITS.maxSourceBytes + 1);
    const { scripts, skipped } = collectScriptSources([
      levelObject('a', { components: [script('s1', 'one'), script('s2', 'off', false), script('s3', '   '), { id: 'm', type: 'mover', enabled: true, props: {} }] }),
      levelObject('b', { name: 'Big', components: [script('s4', huge)] }),
      // A copied object can repeat a component id; it is made unique.
      levelObject('c', { components: [script('s1', 'two')] }),
    ]);
    expect(scripts).toEqual([
      { id: 's1', objectId: 'a', source: 'one' },
      { id: 's1@c', objectId: 'c', source: 'two' },
    ]);
    expect(skipped).toEqual([{ scriptId: 's4', objectId: 'b', objectName: 'Big', reason: expect.stringContaining('128 KB') }]);
  });

  it('keeps every source together within half a message', () => {
    const source = 'y'.repeat(SCRIPT_LIMITS.maxSourceBytes - 16);
    const objects = Array.from({ length: 12 }, (_, i) => levelObject(`o${i}`, { components: [script(`s${i}`, source)] }));
    const { scripts, skipped } = collectScriptSources(objects);
    expect(scripts.length).toBe(7);
    expect(skipped).toHaveLength(5);
    expect(JSON.stringify(scripts).length).toBeLessThanOrEqual(SCRIPT_LIMITS.maxMessageBytes / 2);
  });
});

describe('buildScriptSnapshot', () => {
  it('reports session transforms, visibility and live reads of touched objects', () => {
    const parent = levelObject('parent', { position: [1, 2, 3] });
    const child = levelObject('child', { parentId: 'parent', position: [0, 1, 0] });
    const moved = levelObject('moved');
    const gone = levelObject('gone');
    const live: Record<string, LevelObject> = {
      moved: { ...moved, position: [5, 0, 0] },
      spawned: levelObject('spawned', { position: [9, 9, 9] }),
    };
    const snapshot = buildScriptSnapshot(snapshotSources({
      objects: [parent, child, moved, gone],
      liveIds: new Set(['moved', 'gone', 'spawned']),
      getObject: id => live[id] ?? null,
      hidden: new Set(['child']),
      player: { position: [1, 0, 1], rotation: [0, Math.PI, 0], health: 80, maxHealth: 100, weapon: 'Pistol', ammo: 9, reserve: 36 },
      input: { Jump: { down: true, pressed: true, released: false, value: 1 } },
      variables: { score: 3 },
      events: [{ type: 'triggerEnter', triggerId: 'door', otherId: 'player' }],
      raycasts: new Map([['__proto__', null], ['r1', { objectId: 'wall', point: [0, 0, 1] as Vec3, normal: [0, 0, -1] as Vec3, distance: 1 }]]),
    }));
    expect(snapshot.objects.map(object => [object.id, object.position, object.parentId, object.visible])).toEqual([
      ['parent', [1, 2, 3], null, true],
      ['child', [0, 1, 0], 'parent', false],
      ['moved', [5, 0, 0], null, true],
      ['spawned', [9, 9, 9], null, true],
    ]);
    expect(snapshot).toMatchObject({ frame: 4, time: 2, delta: 0.5, player: { position: [1, 0, 1] }, variables: { score: 3 } });
    expect(snapshot.input.Jump.pressed).toBe(true);
    expect(snapshot.events).toEqual([{ type: 'triggerEnter', triggerId: 'door', otherId: 'player' }]);
    expect(Object.keys(snapshot.raycasts)).toEqual(['__proto__', 'r1']);
    expect(Object.getPrototypeOf(snapshot.raycasts)).toBe(Object.prototype);
    // Copies: changing the session later does not change a built snapshot.
    parent.position[0] = 100;
    expect(snapshot.objects[0].position[0]).toBe(1);
  });

  it('reuses object states while an object and its visibility are unchanged', () => {
    const cache = new WeakMap();
    const still = levelObject('still');
    const first = buildScriptSnapshot(snapshotSources({ objects: [still], cache }));
    const second = buildScriptSnapshot(snapshotSources({ objects: [still], cache }));
    expect(second.objects[0]).toBe(first.objects[0]);
    const hidden = buildScriptSnapshot(snapshotSources({ objects: [still], cache, hidden: new Set(['still']) }));
    expect(hidden.objects[0]).not.toBe(first.objects[0]);
    expect(hidden.objects[0].visible).toBe(false);
    const moved = buildScriptSnapshot(snapshotSources({ objects: [{ ...still, position: [1, 0, 0] }], cache }));
    expect(moved.objects[0].position).toEqual([1, 0, 0]);
  });

  it('reads input actions with the edges collected since the previous snapshot', () => {
    const input = new InputState(DEFAULT_INPUT_MAP);
    input.keyDown('Space');
    input.keyDown('KeyW');
    const actions = readScriptInputActions(input, ['Jump', 'MoveForward', 'Unknown'], new Map([['Jump', { pressed: true, released: false }]]));
    expect(actions.Jump).toEqual({ down: true, pressed: true, released: false, value: 1 });
    expect(actions.MoveForward).toEqual({ down: true, pressed: false, released: false, value: 1 });
    expect(actions.Unknown).toBeUndefined();
  });
});

describe('fitScriptSnapshot', () => {
  const big = (count: number): ScriptSnapshot => buildScriptSnapshot(snapshotSources({
    objects: Array.from({ length: count }, (_, i) => levelObject(`object-${i}`, { name: 'n'.repeat(200) })),
  }));

  it('passes a snapshot that fits unchanged', () => {
    const snapshot = big(3);
    expect(fitScriptSnapshot(snapshot, SCRIPT_LIMITS.maxMessageBytes, new Set())).toEqual({ snapshot, omittedObjects: 0 });
  });

  it('leaves out objects without scripts, last first, until it fits', () => {
    const snapshot = big(40);
    const limit = 4000;
    const fitted = fitScriptSnapshot(snapshot, limit, new Set(['object-39']))!;
    expect(fitted.omittedObjects).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(fitted.snapshot)).byteLength).toBeLessThanOrEqual(limit);
    expect(fitted.snapshot.objects.map(object => object.id)).toContain('object-39');
    expect(fitted.snapshot.objects[0].id).toBe('object-0');
  });

  it('gives up when the scripts own objects alone do not fit', () => {
    const snapshot = big(10);
    expect(fitScriptSnapshot(snapshot, 1000, new Set(snapshot.objects.map(object => object.id)))).toBeNull();
  });
});

describe('script message validation', () => {
  it('accepts each well-formed command as a copy', () => {
    const commands: ScriptCommand[] = [
      { type: 'setTransform', objectId: 'a', position: [1, 2, 3] },
      { type: 'setVisible', objectId: 'a', visible: false },
      { type: 'applyImpulse', objectId: 'a', impulse: [0, 5, 0] },
      { type: 'destroy', objectId: 'a' },
      { type: 'spawnPrefab', requestId: 'r', prefabId: 'crate', position: [0, 0, 0] },
      { type: 'setVariable', name: 'score', value: 'high' },
      { type: 'playSound', audioId: 'ding', bus: 'ui' },
      { type: 'raycast', requestId: 'ray', origin: [0, 0, 0], direction: [0, 0, 1], maxDistance: 10, excludeObjectId: 'a' },
      { type: 'playPlayerAnimation', clipName: 'Wave', maskBone: 'Spine' },
      { type: 'openLevel', levelId: 'level-2' },
      { type: 'log', scriptId: 's1', level: 'warn', message: 'hello' },
    ];
    for (const command of commands) {
      const parsed = parseScriptCommand(command);
      expect(parsed).toEqual(command);
      expect(parsed).not.toBe(command);
    }
  });

  it('rejects malformed commands', () => {
    const bad: unknown[] = [
      null, [], 'destroy', { type: 'explode', objectId: 'a' },
      { type: 'destroy' },
      { type: 'destroy', objectId: '' },
      { type: 'destroy', objectId: 'a'.repeat(257) },
      { type: 'destroy', objectId: 'a', extra: 1 },
      { type: 'setTransform', objectId: 'a', position: [1, 2] },
      { type: 'setTransform', objectId: 'a', position: [1, Number.NaN, 3] },
      { type: 'applyImpulse', objectId: 'a', impulse: [0, Infinity, 0] },
      { type: 'setVisible', objectId: 'a', visible: 'no' },
      { type: 'setVariable', name: 'x', value: { nested: true } },
      { type: 'setVariable', name: 'x', value: 'v'.repeat(4097) },
      { type: 'playSound', audioId: 'ding', bus: 'voice' },
      { type: 'raycast', requestId: 'r', origin: [0, 0, 0], direction: [0, 0, 1], maxDistance: 0 },
      { type: 'log', scriptId: 's', level: 'debug', message: 'x' },
      new (class Command { type = 'destroy'; objectId = 'a'; })(),
    ];
    for (const value of bad) expect(parseScriptCommand(value)).toBeNull();
  });

  it('validates the frame message envelope and size', () => {
    expect(parseScriptFrameMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseScriptFrameMessage({ type: 'ready', nonce: 'x' })).toBeNull();
    expect(parseScriptFrameMessage({ type: 'error', scriptId: 's1', message: 'boom' })).toEqual({ type: 'error', scriptId: 's1', message: 'boom' });
    expect(parseScriptFrameMessage({ type: 'commands', frame: 2, commands: [{ type: 'destroy', objectId: 'a' }, { type: 'destroy' }] }))
      .toEqual({ type: 'commands', frame: 2, commands: [{ type: 'destroy', objectId: 'a' }], rejected: 1 });
    expect(parseScriptFrameMessage({ type: 'commands', frame: -1, commands: [] })).toBeNull();
    expect(parseScriptFrameMessage({ type: 'commands', frame: 1.5, commands: [] })).toBeNull();
    expect(parseScriptFrameMessage({ type: 'commands', frame: 1, commands: 'all' })).toBeNull();
    const tooMany = Array.from({ length: SCRIPT_LIMITS.maxCommandsPerFrame + 1 }, () => ({ type: 'destroy', objectId: 'a' }));
    expect(parseScriptFrameMessage({ type: 'commands', frame: 1, commands: tooMany })).toBeNull();
    const logs = (count: number) => Array.from({ length: count }, () => ({ type: 'log', scriptId: 's1', level: 'info', message: 'm'.repeat(4000) }));
    expect(parseScriptFrameMessage({ type: 'commands', frame: 1, commands: logs(100) })).toMatchObject({ rejected: 0 });
    expect(parseScriptFrameMessage({ type: 'commands', frame: 1, commands: logs(600) })).toBeNull();
    const cyclic: Record<string, unknown> = { type: 'commands', frame: 1 };
    cyclic.commands = [cyclic];
    expect(parseScriptFrameMessage(cyclic)).toBeNull();
    expect(parseScriptFrameMessage({ type: 'load' })).toBeNull();
  });
});

describe('applyScriptCommand', () => {
  it('drives the session services and collects spawn and raycast answers', () => {
    const { services, calls } = fakeServices([levelObject('box'), levelObject('door')]);
    const results = createScriptCommandResults();
    const run = (command: ScriptCommand) => applyScriptCommand(command, services, results);

    run({ type: 'setTransform', objectId: 'box', position: [1, 2, 3], scale: [2, 2, 2] });
    run({ type: 'setTransform', objectId: 'missing', position: [1, 2, 3] });
    run({ type: 'setVisible', objectId: 'door', visible: false });
    run({ type: 'applyImpulse', objectId: 'box', impulse: [0, 0, 0] });
    run({ type: 'applyImpulse', objectId: 'box', impulse: [0, 4, 0] });
    run({ type: 'destroy', objectId: 'door' });
    run({ type: 'spawnPrefab', requestId: 'req-1', prefabId: 'crate', position: [4, 0, 4] });
    run({ type: 'spawnPrefab', requestId: 'req-2', prefabId: 'nothing', position: [0, 0, 0] });
    run({ type: 'setVariable', name: 'score', value: 10 });
    run({ type: 'playSound', audioId: 'ding', bus: 'sfx' });
    run({ type: 'raycast', requestId: 'hit', origin: [0, 1, 0], direction: [0, 0, 1], maxDistance: 1e9, excludeObjectId: 'box' });
    run({ type: 'raycast', requestId: 'miss', origin: [0, 1, 0], direction: [0, 0, -1], maxDistance: 5 });
    run({ type: 'playPlayerAnimation', clipName: 'Wave' });
    run({ type: 'log', scriptId: 's1', level: 'info', message: 'hi' });

    expect(calls).toEqual([
      ['setObjectTransform', 'box', { position: [1, 2, 3], scale: [2, 2, 2] }],
      ['setVisible', 'door', false],
      ['applyImpulse', 'box', [0, 4, 0]],
      ['destroyObject', 'door'],
      ['spawnPrefab', 'crate', [4, 0, 4]],
      ['spawnPrefab', 'nothing', [0, 0, 0]],
      ['setVariable', 'score', 10],
      ['playSound', 'ding', 'sfx'],
      ['raycast', [0, 1, 0], [0, 0, 1], 1e6, { excludeObjectId: 'box' }],
      ['raycast', [0, 1, 0], [0, 0, -1], 5, undefined],
      ['playPlayerAnimation', 'Wave', undefined],
      ['log', 's1', 'info', 'hi'],
    ]);
    expect(results.events).toEqual([
      { type: 'spawned', requestId: 'req-1', objectIds: ['crate-root', 'crate-lid'] },
      { type: 'spawned', requestId: 'req-2', objectIds: [] },
    ]);
    expect(Object.fromEntries(results.raycasts)).toEqual({
      hit: { objectId: 'wall', point: [0, 1, 5], normal: [0, 0, -1], distance: 5 },
      miss: null,
    });
    expect([...results.touched]).toEqual(['box', 'door', 'crate-root', 'crate-lid']);
    expect(results.ended).toBe(false);
  });

  it('stops applying commands once one opens a level', () => {
    const { services, calls } = fakeServices([levelObject('box')]);
    const results = createScriptCommandResults();
    applyScriptCommand({ type: 'openLevel', levelId: 'level-2' }, services, results);
    applyScriptCommand({ type: 'destroy', objectId: 'box' }, services, results);
    expect(calls).toEqual([['openLevel', 'level-2']]);
    expect(results.ended).toBe(true);
  });
});

// --- The runtime against a fake sandbox ------------------------------------------------------------

const runtimeProps = (objects: LevelObject[], overrides: Partial<ScriptRuntimeProps> = {}): ScriptRuntimeProps => {
  const world = new Map(objects.map(object => [object.id, object]));
  return {
    objects,
    getObject: id => world.get(id) ?? null,
    setObjectTransform: vi.fn((id: string, partial: Partial<Pick<LevelObject, 'position' | 'rotation' | 'scale'>>) => {
      const object = world.get(id);
      if (object) world.set(id, { ...object, ...partial });
    }),
    destroyObject: vi.fn(),
    applyImpulse: vi.fn(),
    raycast: () => null,
    playerEntityRef: { current: { object: new THREE.Object3D() } },
    playerApiRef: { current: undefined },
    openLevel: vi.fn(),
    print: vi.fn(),
    ...overrides,
  };
};

const runFrame = () => act(() => { fiber.frame?.({}, 1 / 60); });

/** Mounts the runtime, loads its frame and plays the sandbox's side of the bootstrap. */
const startSandbox = async (props: ScriptRuntimeProps, events = createTriggerEvents()) => {
  fiber.scene = new THREE.Scene();
  const view = render(<TriggerEventsProvider events={events}><ScriptRuntime {...props} /></TriggerEventsProvider>);
  const iframe = document.querySelector('iframe')!;
  const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined);
  iframe.dispatchEvent(new Event('load'));
  const [bootstrap, targetOrigin, transfer] = postMessage.mock.calls.at(-1)! as unknown as [ScriptHostMessage, string, MessagePort[]];
  const port = transfer[0];
  const received: ScriptHostMessage[] = [];
  port.onmessage = (event: MessageEvent) => { received.push(event.data as ScriptHostMessage); };
  port.start();
  return { view, iframe, bootstrap, targetOrigin, port, received };
};

const until = (condition: () => boolean) => vi.waitFor(() => { if (!condition()) throw new Error('not yet'); }, { timeout: 2000, interval: 5 });

describe('ScriptRuntime', () => {
  it('mounts nothing without script components', () => {
    fiber.frame = null;
    const props = runtimeProps([levelObject('a', { components: [script('s', 'off', false)] })]);
    render(<ScriptRuntime {...props} />);
    expect(document.querySelector('iframe')).toBeNull();
    expect(fiber.frame).toBeNull();
  });

  it('runs scripts in a sandboxed frame, one frame in flight at a time', async () => {
    const box = levelObject('box', { components: [script('s1', 'export default {}')] });
    const props = runtimeProps([box, levelObject('wall')]);
    const events = createTriggerEvents();
    const { view, iframe, bootstrap, targetOrigin, port, received } = await startSandbox(props, events);

    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.getAttribute('src')).toBe('/script-frame.html');
    expect(bootstrap).toEqual({ type: 'auvra-script-bootstrap', nonce: expect.stringMatching(/^[0-9a-f]{48}$/), version: 1 });
    expect(targetOrigin).toBe('*');
    const nonce = (bootstrap as { nonce: string }).nonce;

    // Nothing is sent before the sandbox is ready.
    runFrame();
    port.postMessage({ type: 'ready' });
    await until(() => { runFrame(); return received.length > 0; });
    const load = received[0];
    expect(load).toMatchObject({ type: 'load', nonce, scripts: [{ id: 's1', objectId: 'box', source: 'export default {}' }] });
    expect(load.type === 'load' && load.snapshot.objects.map(object => object.id)).toEqual(['box', 'wall']);
    expect(load.type === 'load' && load.snapshot.input.Jump).toEqual({ down: false, pressed: false, released: false, value: 0 });

    // While the load answer is pending, frames post nothing.
    runFrame();
    runFrame();
    expect(received).toHaveLength(1);

    events.emit({ kind: 'enter', triggerObjectId: 'wall', otherObjectId: 'player' });
    animationEvents.emit({ objectId: 'player', stateName: 'Run', name: 'Footstep' });
    port.postMessage({ type: 'commands', frame: 0, commands: [
      { type: 'setTransform', objectId: 'box', position: [3, 0, 0] },
      { type: 'log', scriptId: 's1', level: 'info', message: 'started' },
    ] });
    await until(() => { runFrame(); return received.length > 1; });

    expect(props.setObjectTransform).toHaveBeenCalledWith('box', { position: [3, 0, 0] });
    expect(props.print).toHaveBeenCalledWith(`[Script: ${box.name}] started`, 'info');
    const frame = received[1];
    expect(frame.type).toBe('frame');
    if (frame.type !== 'frame') return;
    expect(frame.nonce).toBe(nonce);
    expect(frame.snapshot.frame).toBe(1);
    // The moved box is read live, before the session copy re-renders.
    expect(frame.snapshot.objects.find(object => object.id === 'box')?.position).toEqual([3, 0, 0]);
    expect(frame.snapshot.events).toEqual([
      { type: 'triggerEnter', triggerId: 'wall', otherId: 'player' },
      { type: 'animNotify', source: 'player', name: 'Footstep' },
    ]);

    // A sandbox error is reported once; an answer for a frame it was not sent stops scripts.
    port.postMessage({ type: 'error', scriptId: 's1', message: 'ReferenceError: x is not defined' });
    port.postMessage({ type: 'error', scriptId: 's1', message: 'ReferenceError: x is not defined' });
    port.postMessage({ type: 'commands', frame: 7, commands: [] });
    await until(() => received.at(-1)?.type === 'unload');
    expect(received.at(-1)).toEqual({ type: 'unload', nonce });
    expect(props.print).toHaveBeenCalledWith('Scripts stopped: the script sandbox answered a frame it was not sent.', 'error');
    expect(vi.mocked(props.print).mock.calls.filter(([message]) => String(message).includes('ReferenceError'))).toEqual([
      [`[Script: ${box.name}] ReferenceError: x is not defined`, 'error'],
    ]);
    const sent = received.length;
    runFrame();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(received).toHaveLength(sent);

    view.unmount();
    expect(document.querySelector('iframe')).toBeNull();
    port.close();
  });

  it('hides objects in the scene and tears the frame down on unmount', async () => {
    const lamp = levelObject('lamp', { components: [script('s1', 'code')] });
    const props = runtimeProps([lamp]);
    const { view, port, received } = await startSandbox(props);
    const group = new THREE.Group();
    group.userData = { levelObjectId: 'lamp' };
    (fiber.scene as THREE.Scene).add(group);

    port.postMessage({ type: 'ready' });
    await until(() => { runFrame(); return received.length > 0; });
    port.postMessage({ type: 'commands', frame: 0, commands: [{ type: 'setVisible', objectId: 'lamp', visible: false }, { type: 'bogus' }] });
    await until(() => { runFrame(); return received.length > 1; });

    expect(group.visible).toBe(false);
    const frame = received[1];
    expect(frame.type === 'frame' && frame.snapshot.objects[0].visible).toBe(false);
    expect(props.print).toHaveBeenCalledWith('Some script commands were malformed and were ignored.', 'warning');

    view.unmount();
    await until(() => received.at(-1)?.type === 'unload');
    expect(document.querySelector('iframe')).toBeNull();
    port.close();
  });
});
