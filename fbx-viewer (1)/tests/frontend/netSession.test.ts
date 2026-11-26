import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NETWORK_SETTINGS, NET_LIMITS, NET_PROTOCOL_VERSION, normalizeNetworkSettings, type NetworkSettings } from '../../runtime/net/protocol';
import { createNetSession, hostTokenTransportAllowed, parseServerMessage, relayName } from '../../runtime/net/session';
import { frontendDiagnostics } from '../../diagnostics/runtime';

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  send(text: string) {
    this.sent.push(JSON.parse(text));
    this.bufferedAmount += new TextEncoder().encode(text).byteLength;
  }
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
  socket.receive({ t: 'welcome', v: NET_PROTOCOL_VERSION, you: 'me', host: 'me', peers: [{ id: 'bob', name: 'Bob' }], serverTime: 5000, ...extra });
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
    expect(socket.sent[0]).toEqual({ t: 'hello', v: NET_PROTOCOL_VERSION, game: 'demo', room: 'main', name: 'Ann' });
    const changes = vi.fn();
    session.onChange(changes);
    socket.receive({ t: 'welcome', v: NET_PROTOCOL_VERSION, you: 'me', host: 'bob', peers: [{ id: 'bob', name: 'Bob' }], serverTime: 5000 });
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

  it('keeps credentials out of guest hello, reconnects with them only on a trusted transport, and clears them explicitly', () => {
    const { session, socket } = connect({ serverUrl: 'wss://relay.example/game' });
    socket.open();
    expect(socket.sent[0]).not.toHaveProperty('hostToken');
    const credential = 'A'.repeat(43);
    expect(session.setHostToken(credential)).toBeNull();
    expect(socket.readyState).toBe(3);
    const hostSocket = FakeSocket.instances.at(-1)!;
    hostSocket.open();
    expect(hostSocket.sent[0]).toEqual({
      t: 'hello', v: NET_PROTOCOL_VERSION, game: 'demo', room: 'main', name: 'Ann', hostToken: credential,
    });
    expect(hostSocket.url).not.toContain(credential);
    hostSocket.drop();
    vi.advanceTimersByTime(1000);
    const reconnected = FakeSocket.instances.at(-1)!;
    reconnected.open();
    expect(reconnected.sent[0]).toHaveProperty('hostToken', credential);
    expect(session.setHostToken('')).toBeNull();
    const guest = FakeSocket.instances.at(-1)!;
    guest.open();
    expect(guest.sent[0]).not.toHaveProperty('hostToken');
    session.close();
  });

  it('refuses unsafe credential transports and malformed tokens without sending or reconnecting', () => {
    const { session, socket } = connect({ serverUrl: 'ws://relay.example/game' });
    expect(session.setHostToken('A'.repeat(43))).toMatch(/wss:/);
    expect(session.setHostToken('short')).toMatch(/valid host credential/);
    expect(session.setHostToken('A'.repeat(43) + '\n')).toMatch(/valid host credential/);
    expect(FakeSocket.instances).toHaveLength(1);
    socket.open();
    expect(socket.sent[0]).not.toHaveProperty('hostToken');
    expect(hostTokenTransportAllowed('ws://127.0.0.1:7777')).toBe(true);
    expect(hostTokenTransportAllowed('ws://[::1]:7777')).toBe(true);
    expect(hostTokenTransportAllowed('wss://relay.example')).toBe(true);
    expect(hostTokenTransportAllowed('ws://localhost.evil.example')).toBe(false);
    expect(hostTokenTransportAllowed('wss://user@relay.example')).toBe(false);
    expect(hostTokenTransportAllowed('not a URL')).toBe(false);
    session.close();
  });

  it('retries while waiting for a host, but a rejected credential needs an explicit correction', () => {
    const { session, socket } = connect();
    socket.open();
    socket.receive({ t: 'error', code: 'host_required', message: 'Waiting for an authenticated host' });
    socket.drop();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(session.setHostToken('A'.repeat(43))).toBeNull();
    const attempted = FakeSocket.instances.at(-1)!;
    attempted.open();
    attempted.receive({ t: 'error', code: 'host_auth', message: 'host credential rejected' });
    attempted.drop();
    const count = FakeSocket.instances.length;
    vi.advanceTimersByTime(16000);
    expect(FakeSocket.instances).toHaveLength(count);
    expect(session.setHostToken('B'.repeat(43))).toBeNull();
    const corrected = FakeSocket.instances.at(-1)!;
    corrected.open();
    expect(corrected.sent[0]).toHaveProperty('hostToken', 'B'.repeat(43));
    session.close();
  });

  it('rejects a legacy welcome rather than trusting an old unauthenticated relay', () => {
    expect(parseServerMessage(JSON.stringify({
      t: 'welcome', v: 1, you: 'me', host: 'me', peers: [], serverTime: 5000,
    }))).toBeNull();
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

  it('drops bursts locally without delaying events or starving state and clock pings', () => {
    const warning = vi.spyOn(frontendDiagnostics, 'warning').mockImplementation(() => undefined);
    try {
      const { session, socket } = connect();
      welcome(socket);
      for (let i = 0; i < 300; i++) session.sendEvent('hit', i);
      const sentEvents = () => socket.sent.filter((message: any) => message.t === 'event') as Array<{ payload: number | string }>;
      const firstBurst = sentEvents();
      expect(firstBurst.length).toBeGreaterThan(0);
      expect(firstBurst.length).toBeLessThan(NET_LIMITS.maxMessagesPerSecond - NET_LIMITS.stateRateHz);
      expect(firstBurst.map(message => message.payload)).toEqual(
        Array.from({ length: firstBurst.length }, (_, i) => i),
      );
      expect(warning).toHaveBeenCalledWith('net_event_rate_limited');

      // The entire event allowance is spent, yet state and pings have headroom.
      session.sendState([{ id: 'player:me', position: [1, 0, 0], rotation: [0, 0, 0] }]);
      vi.advanceTimersByTime(2000);
      expect(socket.sent.filter((message: any) => message.t === 'state')).toHaveLength(1);
      expect(socket.sent.filter((message: any) => message.t === 'ping')).toHaveLength(1);
      expect(socket.sent.length).toBeLessThan(NET_LIMITS.maxMessagesPerSecond);

      // The rolling budget does not release events early; it resumes on expiry.
      clock += 990;
      session.sendEvent('hit', -1);
      expect(sentEvents()).toHaveLength(firstBurst.length);
      clock += 11;
      session.sendEvent('hit', 'fresh');
      expect(sentEvents().at(-1)?.payload).toBe('fresh');
      expect(sentEvents()).toHaveLength(firstBurst.length + 1);
      expect(session.status()).toBe('connected');
    } finally {
      warning.mockRestore();
    }
  });

  it('enforces exact UTF-8 frame limits for ASCII and emoji payloads', () => {
    const { session, socket } = connect();
    welcome(socket);
    const overhead = new TextEncoder().encode(JSON.stringify({ t: 'event', name: 'chat', payload: '' })).byteLength;
    const asciiCount = NET_LIMITS.maxMessageBytes - overhead;
    session.sendEvent('chat', 'x'.repeat(asciiCount));
    session.sendEvent('chat', 'x'.repeat(asciiCount + 1));
    const emojiCount = Math.floor((NET_LIMITS.maxMessageBytes - overhead) / 4);
    session.sendEvent('chat', '😀'.repeat(emojiCount));
    session.sendEvent('chat', '😀'.repeat(emojiCount + 1));
    const sent = socket.sent.filter((message: any) => message.t === 'event') as Array<{ payload: string }>;
    expect(sent.map(message => message.payload.length)).toEqual([asciiCount, emojiCount * 2]);
    expect(session.status()).toBe('connected');
  });

  it('rejects incoming oversized UTF-8 JSON before parsing', () => {
    const raw = JSON.stringify({ t: 'event', from: 'bob', name: 'chat', payload: '😀'.repeat(18000) });
    expect(raw.length).toBeLessThan(NET_LIMITS.maxMessageBytes);
    expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(NET_LIMITS.maxMessageBytes);
    expect(parseServerMessage(raw)).toBeNull();
  });

  it('bounds outstanding bytes when a connected WebSocket never drains', () => {
    const { session, socket } = connect();
    welcome(socket);
    for (let i = 0; i < 500; i++) session.sendEvent('chat', 'x'.repeat(2048));
    const events = socket.sent.filter((message: any) => message.t === 'event');
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThan(500);
    expect(socket.bufferedAmount).toBeLessThanOrEqual(4 * NET_LIMITS.maxMessageBytes);
    expect(session.status()).toBe('connected');
  });

  it('drops state, events and pings under backpressure and resumes on drain', () => {
    const { session, socket } = connect();
    welcome(socket);
    const entity = (x: number) => ({
      id: 'player:me',
      position: [x, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
    });
    socket.bufferedAmount = 4 * NET_LIMITS.maxMessageBytes;
    const sentBefore = socket.sent.length;
    session.sendState([entity(1)]);
    session.sendEvent('door', { open: true });
    vi.advanceTimersByTime(4000);
    expect(socket.sent).toHaveLength(sentBefore);
    expect(socket.bufferedAmount).toBe(4 * NET_LIMITS.maxMessageBytes);
    socket.bufferedAmount = 0;
    clock += 100;
    session.sendState([entity(2)]);
    session.sendEvent('door', { open: false });
    vi.advanceTimersByTime(2000);
    const states = socket.sent.filter((message: any) => message.t === 'state') as any[];
    const events = socket.sent.filter((message: any) => message.t === 'event') as any[];
    const pings = socket.sent.filter((message: any) => message.t === 'ping');
    expect(states).toHaveLength(1);
    expect(states[0].entities[0].position[0]).toBe(2);
    expect(events).toEqual([{ t: 'event', name: 'door', payload: { open: false } }]);
    expect(pings).toHaveLength(1);
    expect(session.status()).toBe('connected');
  });

  it('ignores queued messages from a superseded socket or after close', () => {
    const { session, socket: oldSocket } = connect();
    welcome(oldSocket);
    const states = vi.fn();
    const events = vi.fn();
    const changes = vi.fn();
    session.onState(states);
    session.onEvent(events);
    session.onChange(changes);

    oldSocket.drop();
    vi.advanceTimersByTime(1000);
    const nextSocket = FakeSocket.instances[1];
    nextSocket.open();
    nextSocket.receive({ t: 'welcome', v: NET_PROTOCOL_VERSION, you: 'fresh', host: 'fresh', peers: [{ id: 'friend', name: 'Friend' }], serverTime: 6000 });
    expect(session.status()).toBe('connected');
    const changeCount = changes.mock.calls.length;

    // Already-queued callbacks from A must not mutate the live B session.
    oldSocket.receive({ t: 'welcome', v: NET_PROTOCOL_VERSION, you: 'stale', host: 'bob', peers: [], serverTime: 100 });
    oldSocket.receive({ t: 'host', id: 'bob' });
    oldSocket.receive({ t: 'state', from: 'bob', seq: 1, time: 1, entities: [] });
    oldSocket.receive({ t: 'event', from: 'bob', name: 'stale', payload: 1 });
    expect(session.selfId()).toBe('fresh');
    expect(session.hostId()).toBe('fresh');
    expect(session.peers().map(peer => peer.id)).toEqual(['friend']);
    expect(states).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    expect(changes).toHaveBeenCalledTimes(changeCount);

    session.close();
    const closedChanges = changes.mock.calls.length;
    nextSocket.receive({ t: 'welcome', v: NET_PROTOCOL_VERSION, you: 'late', host: 'late', peers: [], serverTime: 100 });
    expect(session.status()).toBe('closed');
    expect(session.selfId()).toBe('fresh');
    expect(changes).toHaveBeenCalledTimes(closedChanges);
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

  it('normalizes authored player caps consistently with the game builder', () => {
    for (const [value, expected] of [
      [undefined, 8], [null, 8], [true, 8], [false, 8], ['2', 8], [{}, 8],
      [0, 1], [-100, 1], [1, 1], [2, 2], [8, 8], [16, 16], [17, 16],
      [2.49, 2], [2.5, 3], [15.5, 16], [NaN, 8], [Infinity, 8], [-Infinity, 8],
    ] as const) {
      expect(normalizeNetworkSettings({ maxPlayers: value }).maxPlayers).toBe(expected);
    }
  });

  it('parses only well-formed relay messages', () => {
    expect(parseServerMessage(JSON.stringify({ t: 'left', id: 'x' }))).toEqual({ t: 'left', id: 'x' });
    expect(parseServerMessage(JSON.stringify({ t: 'left', id: '' }))).toBeNull();
    expect(parseServerMessage(42)).toBeNull();
  });
});
