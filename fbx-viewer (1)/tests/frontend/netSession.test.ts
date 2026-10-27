import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NETWORK_SETTINGS, normalizeNetworkSettings, type NetworkSettings } from '../../runtime/net/protocol';
import { createNetSession, parseServerMessage, relayName } from '../../runtime/net/session';

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  drop() { this.readyState = 3; this.onclose?.(); }
}

const settings: NetworkSettings = { ...DEFAULT_NETWORK_SETTINGS, enabled: true };
let clock = 0;

const connect = (overrides: Partial<NetworkSettings> = {}) => {
  const session = createNetSession({
    settings: { ...settings, ...overrides }, gameId: 'demo', name: 'Ann!', WebSocketImpl: FakeSocket as unknown as typeof WebSocket, now: () => clock,
  });
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  return { session, socket };
};

const welcome = (socket: FakeSocket, extra: Record<string, unknown> = {}) => {
  socket.open();
  socket.receive({ t: 'welcome', v: 1, you: 'me', host: 'me', peers: [{ id: 'bob', name: 'Bob' }], serverTime: 5000, ...extra });
};

beforeEach(() => {
  FakeSocket.instances = [];
  clock = 1000;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('net session', () => {
  it('says hello on open and keeps peers and host from the relay', () => {
    const { session, socket } = connect();
    expect(session.status()).toBe('connecting');
    socket.open();
    expect(socket.sent[0]).toEqual({ t: 'hello', v: 1, game: 'demo', room: 'main', name: 'Ann' });
    const changes = vi.fn();
    session.onChange(changes);
    socket.receive({ t: 'welcome', v: 1, you: 'me', host: 'bob', peers: [{ id: 'bob', name: 'Bob' }], serverTime: 5000 });
    expect(session.status()).toBe('connected');
    expect(session.selfId()).toBe('me');
    expect(session.isHost()).toBe(false);
    socket.receive({ t: 'joined', peer: { id: 'cat', name: 'Cat' } });
    expect(session.peers().map(peer => peer.id)).toEqual(['bob', 'cat']);
    socket.receive({ t: 'left', id: 'bob' });
    socket.receive({ t: 'host', id: 'me' });
    expect(session.isHost()).toBe(true);
    expect(session.peers().map(peer => peer.id)).toEqual(['cat']);
    expect(changes).toHaveBeenCalledTimes(4);
  });

  it('counts as host while not connected, so single-player logic keeps running', () => {
    const { session } = connect();
    expect(session.isHost()).toBe(true);
  });

  it('drops malformed messages', () => {
    const { session, socket } = connect();
    welcome(socket);
    const states = vi.fn();
    session.onState(states);
    socket.receive({ t: 'state', from: 'bob', seq: 1, time: 1, entities: [{ id: 'x', position: [0, 0], rotation: [0, 0, 0] }] });
    socket.receive({ t: 'mystery' });
    socket.onmessage?.({ data: 'not json' });
    expect(states).not.toHaveBeenCalled();
    socket.receive({ t: 'state', from: 'bob', seq: 1, time: 1, entities: [{ id: 'x', position: [0, 0, 0], rotation: [0, 0, 0] }] });
    expect(states).toHaveBeenCalledWith('bob', { seq: 1, time: 1, entities: [{ id: 'x', position: [0, 0, 0], rotation: [0, 0, 0] }] });
  });

  it('throttles state to 20 per second with the latest state winning', () => {
    const { session, socket } = connect();
    welcome(socket);
    const states = () => socket.sent.filter((message: any) => message.t === 'state') as any[];
    const entity = (x: number) => ({ id: 'player:me', position: [x, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] });
    session.sendState([entity(1)]);
    session.sendState([entity(2)]);
    session.sendState([entity(3)]);
    expect(states()).toHaveLength(1);
    clock += 50;
    vi.advanceTimersByTime(50);
    expect(states()).toHaveLength(2);
    expect(states()[1].entities[0].position[0]).toBe(3);
    expect(states()[1].seq).toBe(1);
    // State time is on the relay clock: 5000 at welcome (local 1000), 50 ms later.
    expect(states()[1].time).toBe(5050);
  });

  it('estimates the relay clock from pongs', () => {
    const { session, socket } = connect();
    welcome(socket);
    clock = 3000;
    socket.receive({ t: 'pong', id: 0, time: 2900, serverTime: 10000 });
    // Sent at 2900, back at 3000: the relay clock read 10000 at about 2950.
    expect(session.serverTime()).toBeCloseTo(10050);
  });

  it('pings every two seconds', () => {
    const { socket } = connect();
    welcome(socket);
    vi.advanceTimersByTime(4000);
    expect(socket.sent.filter((message: any) => message.t === 'ping')).toHaveLength(2);
  });

  it('sends events, and validates their name and payload', () => {
    const { session, socket } = connect();
    welcome(socket);
    session.sendEvent('door', { open: true }, 'bob');
    session.sendEvent('', 1);
    session.sendEvent('bad', { nested: { no: 1 } } as never);
    expect(socket.sent.filter((message: any) => message.t === 'event')).toEqual([{ t: 'event', name: 'door', payload: { open: true }, to: 'bob' }]);
    const events = vi.fn();
    session.onEvent(events);
    socket.receive({ t: 'event', from: 'bob', name: 'score', payload: 3 });
    expect(events).toHaveBeenCalledWith('bob', 'score', 3);
  });

  it('reconnects with backoff after an unexpected close, and stops after close()', () => {
    const { session, socket } = connect();
    welcome(socket);
    socket.drop();
    expect(session.status()).toBe('closed');
    expect(session.peers()).toEqual([]);
    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1].drop();
    vi.advanceTimersByTime(1999);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);
    session.close();
    FakeSocket.instances[2].drop();
    vi.advanceTimersByTime(60000);
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it('keeps the relay\'s refusal and does not retry a game or version mismatch', () => {
    const { session, socket } = connect();
    socket.open();
    socket.receive({ t: 'error', code: 'game_mismatch', message: 'this room is playing a different game' });
    socket.drop();
    expect(session.status()).toBe('error');
    expect(session.statusMessage()).toBe('this room is playing a different game');
    vi.advanceTimersByTime(60000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('refuses addresses that are not WebSocket URLs', () => {
    const session = createNetSession({ settings: { ...settings, serverUrl: 'http://example.com' }, gameId: 'demo', name: 'Ann', WebSocketImpl: FakeSocket as unknown as typeof WebSocket });
    expect(session.status()).toBe('error');
    expect(FakeSocket.instances).toHaveLength(0);
  });
});

describe('net helpers', () => {
  it('cleans player names for the relay', () => {
    expect(relayName('Ann!')).toBe('Ann');
    expect(relayName('***')).toBe('Player');
    expect(relayName('x'.repeat(40))).toHaveLength(32);
  });

  it('normalizes stored network settings', () => {
    expect(normalizeNetworkSettings(undefined)).toEqual(DEFAULT_NETWORK_SETTINGS);
    expect(normalizeNetworkSettings({ enabled: true, serverUrl: 'wss://relay.example:443/game', room: 'lobby 1', maxPlayers: 99 }))
      .toEqual({ enabled: true, serverUrl: 'wss://relay.example:443/game', room: 'lobby 1', maxPlayers: 16 });
    expect(normalizeNetworkSettings({ serverUrl: 'ftp://x', room: 'a/b', maxPlayers: 0 }))
      .toEqual({ ...DEFAULT_NETWORK_SETTINGS, maxPlayers: 1 });
  });

  it('parses only well-formed relay messages', () => {
    expect(parseServerMessage(JSON.stringify({ t: 'left', id: 'x' }))).toEqual({ t: 'left', id: 'x' });
    expect(parseServerMessage(JSON.stringify({ t: 'left', id: '' }))).toBeNull();
    expect(parseServerMessage(42)).toBeNull();
  });
});
