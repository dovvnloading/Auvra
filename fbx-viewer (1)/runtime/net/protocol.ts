/**
 * MULTIPLAYER PROTOCOL
 *
 * Games talk to a relay server (Auvra/net/relay.py, shipped with builds as server/relay.py) over one
 * WebSocket each, as JSON text frames. The relay groups clients into rooms, forwards state and events
 * to the other members of a room, and names one member the host: the first to join, then the oldest
 * remaining member when the host leaves. The relay holds no game logic.
 *
 * Ownership: every peer owns its own player avatar, entity id `player:<peerId>`; the host owns every
 * level object with an enabled netSync component (entity id = the level object id). A peer sends
 * state only for entities it owns and applies received state only to entities it does not own.
 */

export const NET_PROTOCOL_VERSION = 1;

/** The same limits the relay enforces (Auvra/net/relay.py). */
export const NET_LIMITS = {
    maxMessageBytes: 64 * 1024,
    maxPeersPerRoom: 16,
    maxRoomLength: 64,
    maxNameLength: 32,
    maxGameLength: 128,
    maxEventNameLength: 64,
    maxEntitiesPerState: 256,
    maxVarsPerEntity: 32,
    /** A client sends state at most this often. */
    stateRateHz: 20,
    /** The relay drops a client that sends more than this many messages in one second. */
    maxMessagesPerSecond: 120,
} as const;

/** Rooms and player names: letters, digits, space, dash, underscore and dot. */
export const NET_NAME_PATTERN = /^[A-Za-z0-9 _.-]+$/;

export type NetVec3 = [number, number, number];
export type NetValue = number | boolean | string;
export type NetPayload = NetValue | NetValue[] | Record<string, NetValue> | null;

export interface NetPeer {
    id: string;
    name: string;
}

/** One owned entity's state at the sender's time. Rotation is Euler XYZ radians. */
export interface NetEntityState {
    id: string;
    position: NetVec3;
    rotation: NetVec3;
    velocity?: NetVec3;
    /** Animation graph inputs of a player avatar (Speed, InputX, InputY, IsJumping, ...). */
    vars?: Record<string, number | boolean>;
}

/** Client -> relay. `hello` must be the first message. */
export type NetClientMessage =
    | { t: 'hello'; v: typeof NET_PROTOCOL_VERSION; game: string; room: string; name: string }
    | { t: 'state'; seq: number; time: number; entities: NetEntityState[] }
    /** To every other room member, or only to peer `to`. */
    | { t: 'event'; name: string; payload: NetPayload; to?: string }
    | { t: 'ping'; id: number; time: number };

/** Relay -> client. */
export type NetServerMessage =
    | { t: 'welcome'; v: typeof NET_PROTOCOL_VERSION; you: string; host: string; peers: NetPeer[]; serverTime: number }
    | { t: 'joined'; peer: NetPeer }
    | { t: 'left'; id: string }
    | { t: 'host'; id: string }
    | { t: 'state'; from: string; seq: number; time: number; entities: NetEntityState[] }
    | { t: 'event'; from: string; name: string; payload: NetPayload }
    | { t: 'pong'; id: number; time: number; serverTime: number }
    | { t: 'error'; code: 'version' | 'full' | 'bad_message' | 'rate_limited' | 'game_mismatch'; message: string };

/** A game's multiplayer settings (GameSettings.network). */
export interface NetworkSettings {
    enabled: boolean;
    /** ws:// or wss:// URL of the relay; built games' CSP allows exactly this origin. */
    serverUrl: string;
    /** Room every player of this build joins. */
    room: string;
    maxPlayers: number;
}

export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
    enabled: false,
    serverUrl: 'ws://127.0.0.1:7777',
    room: 'main',
    maxPlayers: 8,
};

/** Entity id of a peer's player avatar. */
export const playerEntityId = (peerId: string): string => `player:${peerId}`;

export type NetStatus = 'connecting' | 'connected' | 'closed' | 'error';

export interface NetStateFrame {
    seq: number;
    /** When the sender took the state, on the relay's clock (ms). */
    time: number;
    entities: NetEntityState[];
}

/** A connection to the relay for one play session (createNetSession in runtime/net/session.ts). */
export interface NetSession {
    status(): NetStatus;
    /** Readable reason for 'error' or 'closed'. */
    statusMessage(): string;
    selfId(): string | null;
    hostId(): string | null;
    /** True for the host, and while not connected (so single-player logic keeps running). */
    isHost(): boolean;
    peers(): NetPeer[];
    /** Estimated relay clock in ms (from ping round trips). */
    serverTime(): number;
    /** Sends this peer's owned entity states; throttled to NET_LIMITS.stateRateHz, the latest call winning. */
    sendState(entities: NetEntityState[]): void;
    sendEvent(name: string, payload: NetPayload, to?: string): void;
    onState(listener: (from: string, frame: NetStateFrame) => void): () => void;
    onEvent(listener: (from: string, name: string, payload: NetPayload) => void): () => void;
    /** Status, peer list or host changed. */
    onChange(listener: () => void): () => void;
    close(): void;
}

/** Normalizes stored settings: a ws/wss URL, a valid room name, 1..16 players. */
export const normalizeNetworkSettings = (value: unknown): NetworkSettings => {
    const stored = (value && typeof value === 'object' ? value : {}) as Partial<NetworkSettings>;
    const url = typeof stored.serverUrl === 'string' && /^wss?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/i.test(stored.serverUrl.trim())
        ? stored.serverUrl.trim() : DEFAULT_NETWORK_SETTINGS.serverUrl;
    const room = typeof stored.room === 'string' && stored.room.length <= NET_LIMITS.maxRoomLength && NET_NAME_PATTERN.test(stored.room)
        ? stored.room : DEFAULT_NETWORK_SETTINGS.room;
    const maxPlayers = typeof stored.maxPlayers === 'number' && Number.isFinite(stored.maxPlayers)
        ? Math.min(NET_LIMITS.maxPeersPerRoom, Math.max(1, Math.round(stored.maxPlayers))) : DEFAULT_NETWORK_SETTINGS.maxPlayers;
    return { enabled: stored.enabled === true, serverUrl: url, room, maxPlayers };
};
