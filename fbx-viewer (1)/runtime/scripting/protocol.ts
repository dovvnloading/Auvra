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
    /** A dialogue line or choice raised `name`; objectId holds the Dialogue component. */
    | { type: 'dialogueEvent'; objectId: string; name: string }
    /** A multiplayer event another player sent (ctx.net.send there). */
    | { type: 'netEvent'; from: string; name: string; payload: ScriptNetPayload }
    /** The player got into, or out of, the vehicle on object `objectId`. */
    | { type: 'vehicleEntered'; objectId: string }
    | { type: 'vehicleExited'; objectId: string }
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

/** The player as scripts see it: where they are, their health and the held weapon (weapon '' when none). */
export interface ScriptPlayerState {
    position: ScriptVec3;
    rotation: ScriptVec3;
    health: number;
    maxHealth: number;
    weapon: string;
    /** Rounds in the held weapon's magazine. */
    ammo: number;
    /** Rounds carried besides the magazine; -1 is unlimited. */
    reserve: number;
}

/**
 * A spline (an object's Spline component) as scripts see it: points along it in world space, at most
 * runtime/scripting/scriptSplines.ts SCRIPT_SPLINE_STEP apart, and the up at each point.
 */
export interface ScriptSplineState {
    closed: boolean;
    /** x, y, z of each point, in order along the spline. */
    points: number[];
    /** x, y, z of the up at each point. */
    ups: number[];
}

/** A vehicle (an object's Vehicle component) as scripts see it. */
export interface ScriptVehicleState {
    /** km/h, negative going backwards. */
    speed: number;
    /** 1-6, -1 in reverse. */
    gear: number;
    playerDriving: boolean;
}

/** The world as scripts see it for one frame. */
export interface ScriptSnapshot {
    frame: number;
    /** Seconds since the play session started, and since the previous snapshot. */
    time: number;
    delta: number;
    objects: ScriptObjectState[];
    player: ScriptPlayerState | null;
    input: Record<string, ScriptInputAction>;
    variables: Record<string, ScriptValue>;
    /** Events since the previous snapshot, oldest first. */
    events: ScriptEvent[];
    /** Answers to the previous frame's raycast commands, by request id (null: no hit). */
    raycasts: Record<string, ScriptRaycastHit | null>;
    net: ScriptNetState;
    /**
     * Splines, by the id of the object they belong to, that are new or changed since the previous
     * snapshot (null: gone). Absent when none changed; the sandbox keeps the ones it was sent.
     */
    splines?: Record<string, ScriptSplineState | null>;
    /** The session's vehicles, by the id of their object. Absent when the level has none. */
    vehicles?: Record<string, ScriptVehicleState>;
    /** The hour and the weather. */
    environment?: ScriptEnvironmentState;
}

/** The world's hour and weather as scripts see them. */
export interface ScriptEnvironmentState {
    /** 0-24. */
    hours: number;
    /** How light it is after the weather, 0-1, and whether the sun is down. */
    light: number;
    night: boolean;
    /** The weather preset it is heading for ('' for none or custom values) and its values. */
    weather: string;
    clouds: number;
    rain: number;
    snow: number;
    fog: number;
    /** m/s. */
    wind: number;
    /** How wet the ground is and how much snow lies on it, 0-1. */
    wetness: number;
    snowCover: number;
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
    /** Player health, rounds and weapons, as the Level Blueprint's Player nodes change them. */
    | { type: 'damagePlayer'; amount: number }
    | { type: 'healPlayer'; amount: number }
    | { type: 'addAmmo'; rounds: number; weapon?: string }
    | { type: 'giveWeapon'; weapon: string }
    | { type: 'openLevel'; levelId: string }
    /** Shows a level camera (objectId null: the gameplay camera), blending over `blend` seconds. */
    | { type: 'setCamera'; objectId: string | null; blend: number }
    /** Opens the conversation of the Dialogue component on object `objectId`. */
    | { type: 'startDialogue'; objectId: string }
    /** Puts the player in the vehicle on object `objectId`, or takes them out of theirs. */
    | { type: 'enterVehicle'; objectId: string }
    | { type: 'exitVehicle' }
    /** Drives a vehicle from the script until released; the player driving it overrides this. */
    | { type: 'setVehicleInput'; objectId: string; throttle: number; brake: number; steer: number; handbrake: boolean }
    | { type: 'releaseVehicleInput'; objectId: string }
    /** Starts, stops (`clear`: the particles alive go too) or bursts every Particles component on object `objectId`. */
    | { type: 'playParticles'; objectId: string }
    | { type: 'stopParticles'; objectId: string; clear: boolean }
    | { type: 'emitParticles'; objectId: string; count: number }
    /** Sets the hour (0-24), how many real minutes a day takes (0 stops the clock), or heads for a weather preset over `seconds`. */
    | { type: 'setTimeOfDay'; hours: number }
    | { type: 'setDayLength'; minutes: number }
    | { type: 'setWeather'; weather: string; seconds: number }
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
    /** Particles one emitParticles command bursts at most. */
    maxParticleBurst: 5000,
    /** Longest weather change a script may ask for, s. */
    maxWeatherSeconds: 3600,
};
