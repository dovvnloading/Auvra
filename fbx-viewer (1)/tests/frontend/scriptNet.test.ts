import { describe, expect, it, vi } from 'vitest';
import type { NetSession } from '../../runtime/net/protocol';
import type { ScriptCommand, ScriptObjectState, ScriptSnapshot, ScriptSource } from '../../runtime/scripting/protocol';
import { createScriptHost, isScriptSnapshot } from '../../runtime/scripting/scriptApi';
import { applyScriptCommand, createScriptCommandResults, parseScriptCommand, scriptNetState, type ScriptCommandServices } from '../../runtime/scripting/ScriptRuntime';

vi.mock('../../components/Scripting/ScriptInspector', () => ({ ScriptInspector: () => null }));

const object = (id: string): ScriptObjectState => ({ id, name: id, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], parentId: null, visible: true });

const snapshot = (overrides: Partial<ScriptSnapshot> = {}): ScriptSnapshot => ({
  frame: 1, time: 0, delta: 0.1, objects: [object('door')], player: null, input: {}, variables: {}, events: [], raycasts: {},
  net: { connected: true, isHost: false, selfId: 'me', peers: [{ id: 'bob', name: 'Bob' }] },
  ...overrides,
});

const script = (source: string): ScriptSource => ({ id: 's', objectId: 'door', source });

describe('ctx.net', () => {
  it('reports who is connected and sends events', () => {
    const host = createScriptHost();
    host.load([script([
      'function onUpdate(ctx) {',
      "  ctx.log(ctx.net.connected(), ctx.net.isHost(), ctx.net.selfId(), ctx.net.peers().map(p => p.name).join());",
      "  ctx.net.send('door', { open: true });",
      "  ctx.net.send('hello', 'hi', 'bob');",
      '}',
    ].join('\n'))], source => source, snapshot({ frame: 0 }));
    const commands = host.frame(snapshot());
    expect(commands).toContainEqual({ type: 'log', scriptId: 's', level: 'info', message: 'true false me Bob' });
    expect(commands).toContainEqual({ type: 'netSend', name: 'door', payload: { open: true } });
    expect(commands).toContainEqual({ type: 'netSend', name: 'hello', payload: 'hi', to: 'bob' });
    expect(host.errors()).toEqual([]);
  });

  it('rejects payloads that are not plain values, reporting the error', () => {
    const host = createScriptHost();
    host.load([script("function onUpdate(ctx) { ctx.net.send('bad', { nested: { a: 1 } }); }")], source => source, snapshot({ frame: 0 }));
    expect(host.frame(snapshot()).some(command => command.type === 'netSend')).toBe(false);
    expect(host.errors()[0].message).toMatch(/payload/);
  });

  it('delivers other players\' events to onNetEvent', () => {
    const host = createScriptHost();
    host.load([script("function onNetEvent(ctx, name, payload, from) { ctx.log(name, JSON.stringify(payload), from); }")], source => source, snapshot({ frame: 0 }));
    const commands = host.frame(snapshot({ events: [{ type: 'netEvent', from: 'bob', name: 'score', payload: [1, 2] }] }));
    expect(commands).toContainEqual({ type: 'log', scriptId: 's', level: 'info', message: 'score [1,2] bob' });
  });

  it('requires the net state in snapshots', () => {
    expect(isScriptSnapshot(snapshot())).toBe(true);
    const { net: _net, ...withoutNet } = snapshot();
    expect(isScriptSnapshot(withoutNet)).toBe(false);
  });
});

describe('script runtime networking', () => {
  it('validates netSend commands from the frame', () => {
    expect(parseScriptCommand({ type: 'netSend', name: 'door', payload: { open: true } })).toEqual({ type: 'netSend', name: 'door', payload: { open: true } });
    expect(parseScriptCommand({ type: 'netSend', name: 'door', payload: null, to: 'bob' })).toEqual({ type: 'netSend', name: 'door', payload: null, to: 'bob' });
    expect(parseScriptCommand({ type: 'netSend', name: 'x'.repeat(65), payload: 1 })).toBeNull();
    expect(parseScriptCommand({ type: 'netSend', name: 'door', payload: { a: { b: 1 } } })).toBeNull();
    expect(parseScriptCommand({ type: 'netSend', name: 'door', payload: 1, extra: true })).toBeNull();
  });

  it('hands netSend to the session', () => {
    const sendNetEvent = vi.fn();
    const services = { sendNetEvent } as unknown as ScriptCommandServices;
    applyScriptCommand({ type: 'netSend', name: 'door', payload: 1, to: 'bob' } as ScriptCommand, services, createScriptCommandResults());
    expect(sendNetEvent).toHaveBeenCalledWith('door', 1, 'bob');
  });

  it('describes the session to scripts, offline when there is none or it is not connected', () => {
    expect(scriptNetState(null)).toEqual({ connected: false, isHost: true, selfId: null, peers: [] });
    const session = {
      status: () => 'connected', isHost: () => true, selfId: () => 'me', peers: () => [{ id: 'bob', name: 'Bob' }],
    } as unknown as NetSession;
    expect(scriptNetState(session)).toEqual({ connected: true, isHost: true, selfId: 'me', peers: [{ id: 'bob', name: 'Bob' }] });
    expect(scriptNetState({ ...session, status: () => 'connecting' } as NetSession).connected).toBe(false);
  });
});
