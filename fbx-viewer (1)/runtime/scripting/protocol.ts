/**
 * GAMEPLAY SCRIPT PROTOCOL
 *
 * Gameplay scripts run in a sandboxed, opaque-origin frame (script-frame.html), because the player
 * page's CSP forbids eval. The play runtime and the frame talk over a MessagePort handed over in a
 * bootstrap message, as the HUD sandbox does. Each rendered frame the runtime posts a snapshot of
 * the world; the frame runs every script's callbacks against it and answers with the commands the
 * scripts issued, which the runtime applies on its next frame. Scripts therefore see the world one
 * frame late and change it one frame later, never synchronously.
 */

export const SCRIPT_PROTOCOL_VERSION = 1;

export type ScriptVec3 = [number, number, number];
export type ScriptValue = number | boolean | string;

/** One script component: its source (TypeScript or JavaScript) and the object it is attached to. */
export interface ScriptSource {
    /** The script component's id; errors and logs name it. */
    id: string;
    objectId: string;
    source: string;
}

export interface ScriptObjectState {
    id: string;
    name: string;
    /** Local to the parent (world space for root objects), like LevelObject; rotation is Euler XYZ radians. */
    position: ScriptVec3;
    rotation: ScriptVec3;
    scale: ScriptVec3;
    parentId: string | null;
    visible: boolean;
}

export interface ScriptInputAction {
    down: boolean;
    /** Went down since the previous snapshot. */
    pressed: boolean;
    released: boolean;
    /** Axis value (-1..1) for axis actions, 1/0 for buttons. */
    value: number;
}

export interface ScriptRaycastHit {
    objectId: string | null;
    point: ScriptVec3;
    normal: ScriptVec3;
    distance: number;
}

export type ScriptEvent =
    | { type: 'triggerEnter' | 'triggerExit'; triggerId: string; otherId: string }
    | { type: 'animNotify'; source: string | null; name: string }
    | { type: 'timelineEvent'; timelineObjectId: string; name: string }
    /** A multiplayer event another player sent (ctx.net.send there). */
    | { type: 'netEvent'; from: string; name: string; payload: ScriptNetPayload }
    | { type: 'spawned'; requestId: string; objectIds: string[] };

/** A multiplayer event's payload: a value, a list of values, or a flat object of values. */
export type ScriptNetPayload = ScriptValue | ScriptValue[] | Record<string, ScriptValue> | null;

/** Multiplayer as scripts see it; a single-player game is never connected and always the host. */
export interface ScriptNetState {
    connected: boolean;
    isHost: boolean;
    selfId: string | null;
    peers: { id: string; name: string }[];
}

/** The world as scripts see it for one frame. */
export interface ScriptSnapshot {
    frame: number;
    /** Seconds since the play session started, and since the previous snapshot. */
    time: number;
    delta: number;
    objects: ScriptObjectState[];
    player: { position: ScriptVec3; rotation: ScriptVec3 } | null;
    input: Record<string, ScriptInputAction>;
    variables: Record<string, ScriptValue>;
    /** Events since the previous snapshot, oldest first. */
    events: ScriptEvent[];
    /** Answers to the previous frame's raycast commands, by request id (null: no hit). */
    raycasts: Record<string, ScriptRaycastHit | null>;
    net: ScriptNetState;
}

export type ScriptCommand =
    | { type: 'setTransform'; objectId: string; position?: ScriptVec3; rotation?: ScriptVec3; scale?: ScriptVec3 }
    | { type: 'setVisible'; objectId: string; visible: boolean }
    | { type: 'applyImpulse'; objectId: string; impulse: ScriptVec3 }
    | { type: 'destroy'; objectId: string }
    | { type: 'spawnPrefab'; requestId: string; prefabId: string; position: ScriptVec3 }
    | { type: 'setVariable'; name: string; value: ScriptValue }
    | { type: 'playSound'; audioId: string; bus?: 'master' | 'music' | 'sfx' | 'ui' }
    | { type: 'raycast'; requestId: string; origin: ScriptVec3; direction: ScriptVec3; maxDistance: number; excludeObjectId?: string }
    | { type: 'playPlayerAnimation'; clipName: string; maskBone?: string }
    | { type: 'openLevel'; levelId: string }
    /** A multiplayer event to every other player, or to one (`to`). */
    | { type: 'netSend'; name: string; payload: ScriptNetPayload; to?: string }
    | { type: 'log'; scriptId: string; level: 'info' | 'warn' | 'error'; message: string };

/** Runtime -> frame. The first message on the window is the bootstrap; the rest go over the port. */
export type ScriptHostMessage =
    | { type: 'auvra-script-bootstrap'; nonce: string; version: typeof SCRIPT_PROTOCOL_VERSION }
    | { type: 'load'; nonce: string; scripts: ScriptSource[]; snapshot: ScriptSnapshot }
    | { type: 'frame'; nonce: string; snapshot: ScriptSnapshot }
    | { type: 'unload'; nonce: string };

/** Frame -> runtime, over the port. */
export type ScriptFrameMessage =
    | { type: 'ready' }
    | { type: 'commands'; frame: number; commands: ScriptCommand[] }
    | { type: 'error'; scriptId: string; message: string };

/** Size limits both sides enforce. */
export const SCRIPT_LIMITS = {
    maxScripts: 256,
    maxSourceBytes: 128 * 1024,
    maxMessageBytes: 2 * 1024 * 1024,
    maxCommandsPerFrame: 4096,
    /** Execution budget per callback, as for HUD code. */
    maxStepsPerCallback: 200_000,
    maxMsPerCallback: 8,
};
