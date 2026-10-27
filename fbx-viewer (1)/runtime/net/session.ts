import { frontendDiagnostics } from '../../diagnostics/runtime';
import {
    NET_LIMITS, NET_NAME_PATTERN, NET_PROTOCOL_VERSION,
    type NetEntityState, type NetPayload, type NetPeer, type NetServerMessage, type NetSession, type NetStateFrame, type NetStatus,
    type NetworkSettings,
} from './protocol';

export interface NetSessionOptions {
    settings: NetworkSettings;
    gameId: string;
    /** The player's display name; letters, digits, space, dash, underscore, dot (others are dropped). */
    name: string;
    WebSocketImpl?: typeof WebSocket;
    now?: () => number;
}

const PING_INTERVAL_MS = 2000;
const CLOCK_SAMPLES = 5;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isVector = (value: unknown): boolean => Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const isPeer = (value: unknown): value is NetPeer => isRecord(value) && isId(value.id) && typeof value.name === 'string' && value.name.length <= NET_LIMITS.maxNameLength;
const isScalar = (value: unknown): boolean => typeof value === 'string' || typeof value === 'boolean' || isFiniteNumber(value);
export const isNetPayload = (value: unknown): value is NetPayload => value === null || isScalar(value)
    || (Array.isArray(value) && value.every(isScalar))
    || (isRecord(value) && Object.values(value).every(isScalar));

const isEntity = (value: unknown): value is NetEntityState => isRecord(value) && isId(value.id) && isVector(value.position) && isVector(value.rotation)
    && (value.velocity === undefined || isVector(value.velocity))
    && (value.vars === undefined || (isRecord(value.vars) && Object.keys(value.vars).length <= NET_LIMITS.maxVarsPerEntity
        && Object.values(value.vars).every(item => typeof item === 'boolean' || isFiniteNumber(item))));

/** A relay message, checked field by field; null for anything malformed. */
export const parseServerMessage = (raw: unknown): NetServerMessage | null => {
    if (typeof raw !== 'string' || raw.length > NET_LIMITS.maxMessageBytes) return null;
    let message: unknown;
    try {
        message = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!isRecord(message)) return null;
    switch (message.t) {
        case 'welcome':
            return message.v === NET_PROTOCOL_VERSION && isId(message.you) && isId(message.host) && Array.isArray(message.peers)
                && message.peers.every(isPeer) && isFiniteNumber(message.serverTime) ? message as NetServerMessage : null;
        case 'joined':
            return isPeer(message.peer) ? message as NetServerMessage : null;
        case 'left':
        case 'host':
            return isId(message.id) ? message as NetServerMessage : null;
        case 'state':
            return isId(message.from) && isFiniteNumber(message.seq) && isFiniteNumber(message.time) && Array.isArray(message.entities)
                && message.entities.length <= NET_LIMITS.maxEntitiesPerState && message.entities.every(isEntity) ? message as NetServerMessage : null;
        case 'event':
            return isId(message.from) && typeof message.name === 'string' && message.name.length <= NET_LIMITS.maxEventNameLength
                && isNetPayload(message.payload) ? message as NetServerMessage : null;
        case 'pong':
            return isFiniteNumber(message.id) && isFiniteNumber(message.time) && isFiniteNumber(message.serverTime) ? message as NetServerMessage : null;
        case 'error':
            return typeof message.code === 'string' && typeof message.message === 'string' ? message as NetServerMessage : null;
        default:
            return null;
    }
};

/** The player name as the relay accepts it: allowed characters only, trimmed to the limit, 'Player' when empty. */
export const relayName = (name: string): string => {
    const cleaned = [...name].filter(character => NET_NAME_PATTERN.test(character)).join('').trim().slice(0, NET_LIMITS.maxNameLength);
    return cleaned || 'Player';
};

const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};

/**
 * Opens a connection to the relay and keeps it: hello on open, peers and host from the relay, a ping
 * every 2 s for a relay clock estimate, state throttled to NET_LIMITS.stateRateHz (latest wins), and
 * reconnection with backoff (1 s doubling to 15 s) after an unexpected close. close() ends it.
 */
export const createNetSession = (options: NetSessionOptions): NetSession => {
    const { settings, gameId } = options;
    const name = relayName(options.name);
    const SocketImpl = options.WebSocketImpl ?? (typeof WebSocket !== 'undefined' ? WebSocket : undefined);
    const now = options.now ?? (() => performance.now());

    let status: NetStatus = 'connecting';
    let statusMessage = '';
    let selfId: string | null = null;
    let hostId: string | null = null;
    const peers = new Map<string, NetPeer>();
    const clockSamples: number[] = [];
    let clockOffset = 0;
    let socket: WebSocket | null = null;
    let closed = false;
    let reconnectDelay = RECONNECT_MIN_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let stateTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingState: NetEntityState[] | null = null;
    let lastStateSent = -Infinity;
    let seq = 0;
    let pingId = 0;
    // A relay that rejects this build for good (other protocol version or game) is not retried.
    let rejected = false;

    const stateListeners = new Set<(from: string, frame: NetStateFrame) => void>();
    const eventListeners = new Set<(from: string, name: string, payload: NetPayload) => void>();
    const changeListeners = new Set<() => void>();

    const notify = <T extends unknown[]>(listeners: Set<(...args: T) => void>, ...args: T) => {
        for (const listener of [...listeners]) {
            try {
                listener(...args);
            } catch (error) {
                frontendDiagnostics.failure('net_listener_failed', error);
            }
        }
    };
    const changed = () => notify(changeListeners);
    const setStatus = (next: NetStatus, message = '') => {
        status = next;
        statusMessage = message;
        changed();
    };

    const send = (message: unknown): boolean => {
        if (!socket || status !== 'connected' || socket.readyState !== 1) return false;
        const text = JSON.stringify(message);
        if (text.length > NET_LIMITS.maxMessageBytes) {
            frontendDiagnostics.warning('net_message_too_large');
            return false;
        }
        socket.send(text);
        return true;
    };

    const serverTime = () => now() + clockOffset;

    const flushState = () => {
        stateTimer = null;
        if (!pendingState) return;
        const entities = pendingState;
        pendingState = null;
        if (send({ t: 'state', seq: seq++, time: serverTime(), entities })) lastStateSent = now();
    };

    const stopTimers = () => {
        if (pingTimer) clearInterval(pingTimer);
        if (stateTimer) clearTimeout(stateTimer);
        pingTimer = null;
        stateTimer = null;
    };

    const handle = (message: NetServerMessage) => {
        switch (message.t) {
            case 'welcome':
                selfId = message.you;
                hostId = message.host;
                peers.clear();
                message.peers.forEach(peer => peers.set(peer.id, peer));
                clockOffset = message.serverTime - now();
                clockSamples.length = 0;
                reconnectDelay = RECONNECT_MIN_MS;
                pingTimer = setInterval(() => send({ t: 'ping', id: pingId++, time: now() }), PING_INTERVAL_MS);
                setStatus('connected');
                break;
            case 'joined':
                peers.set(message.peer.id, message.peer);
                changed();
                break;
            case 'left':
                peers.delete(message.id);
                changed();
                break;
            case 'host':
                hostId = message.id;
                changed();
                break;
            case 'pong': {
                const received = now();
                const roundTrip = received - message.time;
                if (roundTrip < 0) break;
                clockSamples.push(message.serverTime + roundTrip / 2 - received);
                if (clockSamples.length > CLOCK_SAMPLES) clockSamples.shift();
                clockOffset = median(clockSamples);
                break;
            }
            case 'state':
                notify(stateListeners, message.from, { seq: message.seq, time: message.time, entities: message.entities });
                break;
            case 'event':
                notify(eventListeners, message.from, message.name, message.payload);
                break;
            case 'error':
                if (message.code === 'version' || message.code === 'game_mismatch') rejected = true;
                setStatus('error', message.message);
                break;
        }
    };

    const connect = () => {
        reconnectTimer = null;
        if (closed) return;
        if (!SocketImpl) {
            setStatus('error', 'WebSockets are not available here.');
            return;
        }
        if (!/^wss?:\/\//i.test(settings.serverUrl)) {
            setStatus('error', 'The multiplayer server address must start with ws:// or wss://.');
            return;
        }
        setStatus('connecting');
        let current: WebSocket;
        try {
            current = new SocketImpl(settings.serverUrl);
        } catch (error) {
            frontendDiagnostics.failure('net_connect_failed', error);
            setStatus('error', 'Could not open a connection to the multiplayer server.');
            return;
        }
        socket = current;
        current.onopen = () => {
            current.send(JSON.stringify({ t: 'hello', v: NET_PROTOCOL_VERSION, game: gameId.slice(0, NET_LIMITS.maxGameLength), room: settings.room, name }));
        };
        current.onmessage = (event: MessageEvent) => {
            const message = parseServerMessage(event.data);
            if (message) handle(message);
            else frontendDiagnostics.warning('net_message_rejected');
        };
        current.onclose = () => {
            if (socket !== current) return;
            socket = null;
            stopTimers();
            selfId = null;
            hostId = null;
            peers.clear();
            if (closed) return;
            // A relay that refused us (full room, other game, old version) says so before closing; keep that message.
            const refused = status === 'error';
            if (!refused) setStatus('closed', 'Disconnected from the multiplayer server; reconnecting...');
            else changed();
            if (rejected) return;
            reconnectTimer = setTimeout(connect, reconnectDelay);
            reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay * 2);
        };
        current.onerror = () => {
            frontendDiagnostics.warning('net_socket_error');
        };
    };

    connect();

    return {
        status: () => status,
        statusMessage: () => statusMessage,
        selfId: () => selfId,
        hostId: () => hostId,
        isHost: () => status !== 'connected' || selfId === hostId,
        peers: () => [...peers.values()],
        serverTime,
        sendState(entities) {
            if (status !== 'connected') return;
            pendingState = entities.slice(0, NET_LIMITS.maxEntitiesPerState);
            const wait = 1000 / NET_LIMITS.stateRateHz - (now() - lastStateSent);
            if (wait <= 0) flushState();
            else if (!stateTimer) stateTimer = setTimeout(flushState, wait);
        },
        sendEvent(eventName, payload, to) {
            if (!eventName || eventName.length > NET_LIMITS.maxEventNameLength || !isNetPayload(payload)) return;
            send(to ? { t: 'event', name: eventName, payload, to } : { t: 'event', name: eventName, payload });
        },
        onState(listener) {
            stateListeners.add(listener);
            return () => { stateListeners.delete(listener); };
        },
        onEvent(listener) {
            eventListeners.add(listener);
            return () => { eventListeners.delete(listener); };
        },
        onChange(listener) {
            changeListeners.add(listener);
            return () => { changeListeners.delete(listener); };
        },
        close() {
            if (closed) return;
            closed = true;
            stopTimers();
            if (reconnectTimer) clearTimeout(reconnectTimer);
            const current = socket;
            socket = null;
            current?.close();
            status = 'closed';
            statusMessage = '';
            changed();
        },
    };
};
