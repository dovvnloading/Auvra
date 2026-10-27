import { beforeAll, describe, expect, it } from 'vitest';
import { createExecutionGuard } from '../../components/HUDEditor/hudExecutionGuard';
import { SCRIPT_LIMITS, type ScriptCommand, type ScriptObjectState, type ScriptSnapshot, type ScriptSource } from '../../runtime/scripting/protocol';
import { SCRIPT_GUARD_IDENTIFIER, compileScriptSource, createScriptHost, isScriptSnapshot } from '../../runtime/scripting/scriptApi';

type Compiler = Parameters<typeof compileScriptSource>[1];

const object = (id: string, overrides: Partial<ScriptObjectState> = {}): ScriptObjectState => ({
  id, name: id, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], parentId: null, visible: true, ...overrides,
});

const snapshot = (overrides: Partial<ScriptSnapshot> = {}): ScriptSnapshot => ({
  frame: 1,
  time: 0,
  delta: 0.5,
  objects: [object('door'), object('crate', { name: 'Crate' })],
  player: null,
  input: {},
  variables: {},
  events: [],
  raycasts: {},
  ...overrides,
});

const script = (id: string, objectId: string, source: string): ScriptSource => ({ id, objectId, source });
const plain = (source: string) => source;
const logs = (commands: ScriptCommand[]) => commands.flatMap((command) => (command.type === 'log' ? [command.message] : []));

describe('script host', () => {
  it('runs onStart at load, then events and onUpdate each frame, in load order', () => {
    const host = createScriptHost();
    const source = [
      "function onStart(ctx) { ctx.log('start', ctx.self.id); }",
      "function onTriggerEnter(ctx) { ctx.log('enter', ctx.self.id); }",
      "function onAnimNotify(ctx, name) { ctx.log('notify', ctx.self.id, name); }",
      "function onUpdate(ctx, dt) { ctx.log('update', ctx.self.id, dt, ctx.time, ctx.frame); }",
    ].join('\n');

    expect(host.load([script('a', 'door', source), script('b', 'crate', source)], plain, snapshot({ frame: 0 }))).toEqual([]);
    expect(logs(host.flush())).toEqual(['start door', 'start crate']);

    const events: ScriptSnapshot['events'] = [
      { type: 'animNotify', source: null, name: 'step' },
      { type: 'triggerEnter', triggerId: 'crate', otherId: 'player' },
    ];
    expect(logs(host.frame(snapshot({ frame: 1, time: 2, events })))).toEqual([
      'notify door step', 'notify crate step', 'enter crate', 'update door 0.5 2 1', 'update crate 0.5 2 1',
    ]);
    expect(logs(host.frame(snapshot({ frame: 2, delta: 0.25 })))).toEqual(['update door 0.25 0 2', 'update crate 0.25 0 2']);
    expect(host.errors()).toEqual([]);
  });

  it('starts a script once its object appears and keeps unchanged scripts across loads', () => {
    const host = createScriptHost();
    const counter = [
      "function onStart(ctx) { ctx.state.count = 0; ctx.log('start', ctx.self.id); }",
      'function onUpdate(ctx) { ctx.state.count += 1; ctx.log(ctx.self.id, ctx.state.count); }',
    ].join('\n');
    const both = snapshot({ objects: [object('door'), object('spawned')] });

    host.load([script('a', 'door', counter), script('late', 'spawned', counter)], plain, snapshot());
    expect(logs(host.flush())).toEqual(['start door']);
    expect(logs(host.frame(snapshot()))).toEqual(['door 1']);
    expect(logs(host.frame(both))).toEqual(['start spawned', 'door 2', 'spawned 1']);

    expect(host.load([script('a', 'door', counter), script('late', 'spawned', `${counter}\n`)], plain, both)).toEqual([]);
    expect(logs(host.flush())).toEqual(['start spawned']);
    expect(logs(host.frame(both))).toEqual(['door 3', 'spawned 1']);

    expect(host.load([script('late', 'spawned', `${counter}\n`)], plain, both)).toEqual([]);
    expect(logs(host.frame(both))).toEqual(['spawned 2']);
  });

  it('gives handles copies, applies setters to the frame and merges commands per object', () => {
    const host = createScriptHost();
    const source = `function onUpdate(ctx) {
      const self = ctx.self;
      self.setPosition(1, 2, 3);
      const position = self.position;
      position[0] = 99;
      self.translate([1, 0, 0]);
      self.setRotation([0, 1.5, 0]);
      ctx.log(self.position, position);
      const crate = ctx.find('Crate');
      crate.setVisible(true);
      crate.setVisible(false);
      crate.applyImpulse(0, 1, 0);
      crate.applyImpulse([0, 2, 0]);
      ctx.log(crate.visible, ctx.get('missing'), ctx.all().length);
      crate.destroy();
      crate.setPosition(5, 5, 5);
      ctx.log(crate.exists, ctx.find('Crate'), ctx.get('crate'), ctx.all().map(handle => handle.id));
      ctx.state.request = ctx.spawn('barrel', [0, 1, 0]);
      ctx.playSound('boom', 'sfx');
      ctx.playSound('music-theme');
      ctx.playPlayerAnimation('Wave', 'spine');
      ctx.openLevel('level-2');
      ctx.warn('careful', { a: 1 });
    }`;
    const reader = "function onUpdate(ctx) { ctx.log('reader', ctx.get('door').position, ctx.player.position); }";
    host.load([script('a', 'door', source), script('b', 'door', reader)], plain, snapshot());

    const commands = host.frame(snapshot({ player: { position: [4, 0, 4], rotation: [0, 0, 0] } }));

    expect(commands).toEqual([
      { type: 'setTransform', objectId: 'door', position: [2, 2, 3], rotation: [0, 1.5, 0] },
      { type: 'log', scriptId: 'a', level: 'info', message: '[2,2,3] [99,2,3]' },
      { type: 'setVisible', objectId: 'crate', visible: false },
      { type: 'applyImpulse', objectId: 'crate', impulse: [0, 3, 0] },
      { type: 'log', scriptId: 'a', level: 'info', message: 'false null 2' },
      { type: 'destroy', objectId: 'crate' },
      { type: 'log', scriptId: 'a', level: 'info', message: 'false null null ["door"]' },
      { type: 'spawnPrefab', requestId: expect.any(String), prefabId: 'barrel', position: [0, 1, 0] },
      { type: 'playSound', audioId: 'boom', bus: 'sfx' },
      { type: 'playSound', audioId: 'music-theme' },
      { type: 'playPlayerAnimation', clipName: 'Wave', maskBone: 'spine' },
      { type: 'openLevel', levelId: 'level-2' },
      { type: 'log', scriptId: 'a', level: 'warn', message: 'careful {"a":1}' },
      { type: 'log', scriptId: 'b', level: 'info', message: 'reader [2,2,3] [4,0,4]' },
    ]);
    expect(host.errors()).toEqual([]);
  });

  it('takes each new snapshot as the world, dropping the previous frame\'s view', () => {
    const host = createScriptHost();
    const mover = "function onUpdate(ctx) { ctx.log(ctx.self.position, ctx.find('Crate') !== null); ctx.self.translate(1, 0, 0); ctx.find('Crate').destroy(); }";
    host.load([script('mover', 'door', mover)], plain, snapshot());

    expect(logs(host.frame(snapshot()))).toEqual(['[0,0,0] true']);
    expect(logs(host.frame(snapshot({ objects: [object('door', { position: [5, 0, 0] }), object('crate', { name: 'Crate' })] })))).toEqual(['[5,0,0] true']);
  });

  it('reads level variables and merges sets made in one frame', () => {
    const host = createScriptHost();
    const writer = `function onUpdate(ctx) {
      ctx.log(ctx.vars.get('score'), ctx.vars.get('missing'), ctx.vars.get('toString'));
      ctx.vars.set('score', ctx.vars.get('score') + 1);
      ctx.vars.set('score', ctx.vars.get('score') + 1);
      ctx.vars.set('door', 'open');
      ctx.log(ctx.vars.get('score'));
    }`;
    const reader = "function onUpdate(ctx) { ctx.log('reader', ctx.vars.get('score'), ctx.vars.get('door')); }";
    const invalid = "function onUpdate(ctx) { ctx.vars.set('score', { value: 1 }); }";
    host.load([script('writer', 'door', writer), script('reader', 'crate', reader), script('invalid', 'crate', invalid)], plain, snapshot());

    const commands = host.frame(snapshot({ variables: { score: 5 } }));

    expect(commands).toEqual([
      { type: 'log', scriptId: 'writer', level: 'info', message: '5 undefined undefined' },
      { type: 'setVariable', name: 'score', value: 7 },
      { type: 'setVariable', name: 'door', value: 'open' },
      { type: 'log', scriptId: 'writer', level: 'info', message: '7' },
      { type: 'log', scriptId: 'reader', level: 'info', message: 'reader 7 open' },
    ]);
    const errors = host.errors();
    expect(errors).toHaveLength(1);
    expect(errors[0].scriptId).toBe('invalid');
    expect(errors[0].message).toMatch(/^onUpdate failed and is disabled: TypeError: vars\.set expects/);
    expect(logs(host.frame(snapshot({ variables: { score: 7 } })))).toEqual(['7 undefined undefined', '9', 'reader 9 open']);
  });

  it('reports input as down, pressed and released edges and axis values', () => {
    const host = createScriptHost();
    const source = `function onUpdate(ctx) {
      const input = ctx.input;
      ctx.log(input.isDown('jump'), input.wasPressed('jump'), input.wasReleased('jump'), input.value('move'),
        input.isDown('unknown'), input.value('unknown'), input.isDown('constructor'));
    }`;
    host.load([script('a', 'door', source)], plain, snapshot());

    expect(logs(host.frame(snapshot({
      input: {
        jump: { down: true, pressed: true, released: false, value: 1 },
        move: { down: true, pressed: false, released: false, value: -0.5 },
      },
    })))).toEqual(['true true false -0.5 false 0 false']);
    expect(logs(host.frame(snapshot({
      input: { jump: { down: false, pressed: false, released: true, value: 0 } },
    })))).toEqual(['false false true 0 false 0 false']);
  });

  it('delivers trigger events to the scripts on the trigger object only', () => {
    const host = createScriptHost();
    const source = [
      "function onTriggerEnter(ctx, other, otherId) { ctx.log('enter', ctx.self.id, other ? other.name : other, otherId); }",
      "function onTriggerExit(ctx, other, otherId) { ctx.log('exit', ctx.self.id, other, otherId); }",
    ].join('\n');
    host.load([script('a', 'door', source), script('b', 'crate', source), script('c', 'door', source)], plain, snapshot());

    const commands = host.frame(snapshot({
      events: [
        { type: 'triggerEnter', triggerId: 'door', otherId: 'crate' },
        { type: 'triggerEnter', triggerId: 'crate', otherId: 'player' },
        { type: 'triggerExit', triggerId: 'door', otherId: 'gone' },
        { type: 'triggerEnter', triggerId: 'elsewhere', otherId: 'door' },
      ],
    }));

    expect(commands.map((command) => command.type === 'log' && [command.scriptId, command.message])).toEqual([
      ['a', 'enter door Crate crate'],
      ['c', 'enter door Crate crate'],
      ['b', 'enter crate null player'],
      ['a', 'exit door null gone'],
      ['c', 'exit door null gone'],
    ]);
  });

  it('round-trips raycasts and spawns to the script that asked', () => {
    const host = createScriptHost();
    const caster = `function onUpdate(ctx) {
      if (ctx.state.ray) {
        const hit = ctx.raycastResult(ctx.state.ray);
        ctx.log(hit && { id: hit.objectId, name: hit.object && hit.object.name, point: hit.point, distance: hit.distance }, ctx.raycastResult('ray-0'));
      }
      ctx.state.ray = ctx.raycast([0, 1, 0], [0, 0, -1], 50);
    }`;
    const spawner = [
      "function onStart(ctx) { ctx.state.request = ctx.spawn('barrel', [1, 2, 3]); }",
      "function onSpawned(ctx, requestId, objectIds) { ctx.log('spawned', requestId === ctx.state.request, objectIds.join(',')); }",
    ].join('\n');
    const bystander = "function onSpawned(ctx) { ctx.log('bystander'); }";
    host.load([script('caster', 'door', caster), script('spawner', 'crate', spawner), script('bystander', 'crate', bystander)], plain, snapshot());
    const [spawn] = host.flush();
    expect(spawn).toEqual({ type: 'spawnPrefab', requestId: expect.any(String), prefabId: 'barrel', position: [1, 2, 3] });
    const spawnRequest = spawn.type === 'spawnPrefab' ? spawn.requestId : '';

    const [firstRay] = host.frame(snapshot());
    expect(firstRay).toEqual({
      type: 'raycast', requestId: expect.any(String), origin: [0, 1, 0], direction: [0, 0, -1], maxDistance: 50, excludeObjectId: 'door',
    });
    const firstId = firstRay.type === 'raycast' ? firstRay.requestId : '';

    const second = host.frame(snapshot({
      raycasts: { [firstId]: { objectId: 'crate', point: [0, 1, -4], normal: [0, 0, 1], distance: 4 } },
      events: [{ type: 'spawned', requestId: spawnRequest, objectIds: ['barrel-1'] }],
    }));
    expect(logs(second)).toEqual(['spawned true barrel-1', '{"id":"crate","name":"Crate","point":[0,1,-4],"distance":4} undefined']);
    const secondRay = second.find((command) => command.type === 'raycast');
    const secondId = secondRay?.type === 'raycast' ? secondRay.requestId : '';
    expect(secondId).not.toBe(firstId);

    expect(logs(host.frame(snapshot({
      raycasts: { [secondId]: null },
      events: [{ type: 'spawned', requestId: spawnRequest, objectIds: ['barrel-2'] }],
    })))).toEqual(['null undefined']);
  });

  it('disables only the callback that threw and reports it once', async () => {
    const host = createScriptHost();
    const broken = [
      "function onUpdate(ctx) { ctx.log('before'); missingFunction(); }",
      "function onTriggerEnter(ctx) { ctx.log('still listening'); }",
    ].join('\n');
    const badArguments = [
      '// line one',
      "function onUpdate(ctx) { ctx.self.setPosition('x'); }",
    ].join('\n');
    const later = "async function onUpdate(ctx) { ctx.log('async'); await null; throw new Error('later'); }";
    const healthy = "function onUpdate(ctx) { ctx.log('healthy'); }";

    const loadErrors = host.load([
      script('broken', 'door', broken),
      script('syntax', 'door', 'function onUpdate( {'),
      script('top', 'door', "const ready = true;\nthrow new Error('boom');"),
      script('empty', 'door', 'const nothing = 1;'),
      script('bad-arguments', 'crate', badArguments),
      script('later', 'crate', later),
      script('healthy', 'crate', healthy),
    ], plain, snapshot());
    expect(loadErrors.map((error) => error.scriptId)).toEqual(['syntax', 'top', 'empty']);
    expect(loadErrors[0].message).toMatch(/^Script failed to load: SyntaxError/);
    expect(loadErrors[1].message).toBe('Script failed to load: boom (line 2)');
    expect(loadErrors[2].message).toMatch(/^Script defines none of onStart/);

    expect(logs(host.frame(snapshot()))).toEqual(['before', 'async', 'healthy']);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(host.errors()).toEqual([
      { scriptId: 'broken', message: 'onUpdate failed and is disabled: ReferenceError: missingFunction is not defined (line 1)' },
      { scriptId: 'bad-arguments', message: 'onUpdate failed and is disabled: TypeError: setPosition expects three finite numbers (line 2)' },
      { scriptId: 'later', message: 'onUpdate failed and is disabled: later (line 1)' },
    ]);

    const next = host.frame(snapshot({ events: [{ type: 'triggerEnter', triggerId: 'door', otherId: 'player' }] }));
    expect(logs(next)).toEqual(['still listening', 'healthy']);
    expect(host.errors()).toEqual([]);
  });

  it('caps the commands of one frame and says so once per script', () => {
    const host = createScriptHost();
    const max = SCRIPT_LIMITS.maxCommandsPerFrame;
    const flood = `function onUpdate(ctx) { for (let i = 0; i < ${max + 10}; i += 1) ctx.log(i); }`;
    const quiet = "function onUpdate(ctx) { ctx.log('quiet'); }";
    host.load([script('flood', 'door', flood), script('quiet', 'crate', quiet)], plain, snapshot());

    const first = host.frame(snapshot());
    expect(first).toHaveLength(max);
    expect(first[max - 1]).toEqual({ type: 'log', scriptId: 'flood', level: 'info', message: String(max - 1) });
    expect(host.errors().map((error) => error.scriptId)).toEqual(['flood', 'quiet']);

    expect(host.frame(snapshot())).toHaveLength(max);
    expect(host.errors()).toEqual([]);
  });

  it('keeps one frame of commands within the message size limit', () => {
    const host = createScriptHost();
    const chatty = "function onUpdate(ctx) { const text = 'x'.repeat(1000); for (let i = 0; i < 3000; i += 1) ctx.log(text); }";
    host.load([script('chatty', 'door', chatty)], plain, snapshot());

    const commands = host.frame(snapshot());

    expect(commands.length).toBeGreaterThan(1000);
    expect(commands.length).toBeLessThan(3000);
    expect(new TextEncoder().encode(JSON.stringify({ type: 'commands', frame: 1, commands })).byteLength).toBeLessThanOrEqual(SCRIPT_LIMITS.maxMessageBytes);
    expect(host.errors()).toEqual([{ scriptId: 'chatty', message: expect.stringMatching(/bytes of commands in one frame/) }]);
  });

  it('stops scripts on unload, including contexts they kept', () => {
    const host = createScriptHost();
    const keeper = "function onStart(ctx) { globalThis.keptScriptContext = ctx; }\nfunction onUpdate(ctx) { ctx.log('tick'); }";
    host.load([script('keeper', 'door', keeper)], plain, snapshot());
    const kept = (globalThis as { keptScriptContext?: { log: (...values: unknown[]) => void; self: { setPosition: (x: number, y: number, z: number) => void } } }).keptScriptContext;
    delete (globalThis as { keptScriptContext?: unknown }).keptScriptContext;

    host.unload();
    kept?.log('late');
    kept?.self.setPosition(1, 1, 1);

    expect(kept).toBeDefined();
    expect(host.flush()).toEqual([]);
    expect(host.frame(snapshot())).toEqual([]);
  });

  it('validates the snapshot shape', () => {
    expect(isScriptSnapshot(snapshot())).toBe(true);
    expect(isScriptSnapshot({ ...snapshot(), objects: [{ id: 'door' }] })).toBe(false);
    expect(isScriptSnapshot({ ...snapshot(), events: [{ type: 'explode' }] })).toBe(false);
    expect(isScriptSnapshot({ ...snapshot(), raycasts: { ray: { objectId: 1 } } })).toBe(false);
    expect(isScriptSnapshot({ ...snapshot(), input: { jump: true } })).toBe(false);
    expect(isScriptSnapshot({ ...snapshot(), player: { position: [0, 0] } })).toBe(false);
    expect(isScriptSnapshot(null)).toBe(false);
  });
});

describe('compiled scripts', () => {
  let compiler: Compiler;
  beforeAll(async () => {
    const loaded = await import('@babel/standalone');
    compiler = typeof loaded.transform === 'function' ? loaded : (loaded as unknown as { default: Compiler }).default;
  });

  const compile = (source: string) => compileScriptSource(source, compiler);
  const guardedHost = (budget = { maxSteps: 1_000, maxMs: 1_000 }) => {
    let active = createExecutionGuard(budget);
    return createScriptHost({
      scope: { [SCRIPT_GUARD_IDENTIFIER]: { tick: () => active.tick() } },
      invoke: (call) => {
        active = createExecutionGuard(budget);
        call();
      },
    });
  };

  it('compiles TypeScript and exported callbacks', () => {
    const host = guardedHost();
    const source = [
      'interface Door { open: boolean }',
      'enum Mode { Idle, Busy }',
      'export function onStart(ctx: { state: Record<string, unknown> }): void { ctx.state.mode = Mode.Busy; }',
      "export const onUpdate = (ctx: any, dt: number) => ctx.log('mode', ctx.state.mode, dt, ({ open: true } as Door).open);",
      'export type { Door };',
      'export {};',
    ].join('\n');

    expect(host.load([script('ts', 'door', source)], compile, snapshot())).toEqual([]);
    expect(logs(host.frame(snapshot()))).toEqual(['mode 1 0.5 true']);
  });

  it('rejects module syntax and reserved names', () => {
    const host = guardedHost();
    const errors = host.load([
      script('imports', 'door', "import { helper } from './helper';\nexport function onUpdate() { helper(); }"),
      script('default', 'door', 'export default function onUpdate() {}'),
      script('dynamic', 'door', "function onStart() { import('./other'); }"),
      script('reserved', 'door', `function onUpdate() { ${SCRIPT_GUARD_IDENTIFIER}.tick = () => undefined; }`),
      script('typed', 'door', 'function onUpdate(ctx: { log: (value: string) => void }) { const value: number = "text"; }'),
    ], compile, snapshot());

    expect(errors.map((error) => error.scriptId)).toEqual(['imports', 'default', 'dynamic', 'reserved']);
    expect(errors[0].message).toMatch(/^Compile error: Scripts cannot import modules/);
    expect(errors[1].message).toMatch(/cannot have a default or module export/);
    expect(errors[2].message).toMatch(/Scripts cannot import modules/);
    expect(errors[3].message).toBe(`Script source uses the reserved name ${SCRIPT_GUARD_IDENTIFIER}`);
  });

  it('budgets each callback call and stops runaway loops and recursion', () => {
    const host = guardedHost();
    const steady = [
      "function onStart(ctx) { let sum = 0; for (let i = 0; i < 800; i += 1) sum += i; ctx.log('start', sum); }",
      "function onUpdate(ctx) { let sum = 0; for (let i = 0; i < 800; i += 1) sum += i; ctx.log('update', sum); }",
    ].join('\n');
    const spin = "function onUpdate(ctx) {\n  ctx.log('spin');\n  while (true) {}\n}";
    const recursive = [
      'function onTriggerEnter(ctx) { const fib = (n: number): number => (n < 2 ? n : fib(n - 1) + fib(n - 2)); ctx.log(fib(40)); }',
      "function onUpdate(ctx) { ctx.log('alive'); }",
    ].join('\n');
    host.load([script('steady', 'door', steady), script('spin', 'door', spin), script('recursive', 'crate', recursive)], compile, snapshot());
    expect(logs(host.flush())).toEqual(['start 319600']);

    const commands = host.frame(snapshot({ events: [{ type: 'triggerEnter', triggerId: 'crate', otherId: 'player' }] }));

    expect(logs(commands)).toEqual(['update 319600', 'spin', 'alive']);
    expect(host.errors()).toEqual([
      { scriptId: 'recursive', message: expect.stringMatching(/^onTriggerEnter failed and is disabled: HUD execution exceeded the sandbox budget/) },
      { scriptId: 'spin', message: 'onUpdate failed and is disabled: HUD execution exceeded the sandbox budget (line 3)' },
    ]);
    expect(logs(host.frame(snapshot()))).toEqual(['update 319600', 'alive']);
  });
});
