import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import type { LevelObject } from '../../types';
import { animationEvents } from '../animationEvents';
import { timelineEvents } from '../timeline/events';
import { dialogueSpeakers, dialogueStore, startDialogue } from '../dialogue';
import { AUDIO_BUSES, type AudioBus } from '../audioMixer';
import { readScriptSource, SCRIPT_COMPONENT_TYPE } from '../components/scriptComponent';
import { DEFAULT_INPUT_MAP, type InputState } from '../input';
import { levelVariables } from '../levelVariables';
import type { PhysicsRaycastHit, PhysicsRaycastOptions } from '../physics';
import { useRuntimeServices, type RuntimeServices } from '../RuntimeServicesContext';
import { useTriggerEvents } from '../triggers';
import {
    SCRIPT_LIMITS,
    SCRIPT_PROTOCOL_VERSION,
    type ScriptCommand,
    type ScriptEvent,
    type ScriptHostMessage,
    type ScriptInputAction,
    type ScriptNetPayload,
    type ScriptNetState,
    type ScriptObjectState,
    type ScriptRaycastHit,
    type ScriptSnapshot,
    type ScriptSource,
    type ScriptValue,
    type ScriptVec3,
} from './protocol';
import { isScriptNetPayload } from './scriptApi';
import { useNetSession } from '../net/NetSessionContext';
import { NET_LIMITS, type NetSession } from '../net/protocol';
import { cameraDirector } from '../cameraDirector';

const OFFLINE_NET: ScriptNetState = { connected: false, isHost: true, selfId: null, peers: [] };

/** Multiplayer as scripts see it this frame. */
export const scriptNetState = (session: NetSession | null): ScriptNetState => {
    if (!session || session.status() !== 'connected') return OFFLINE_NET;
    return { connected: true, isHost: session.isHost(), selfId: session.selfId(), peers: session.peers().map(peer => ({ id: peer.id, name: peer.name })) };
};

/**
 * SCRIPT RUNTIME
 *
 * The play session's side of gameplay scripting. It loads the session's script components into a hidden,
 * sandboxed script frame (scripting/protocol.ts), posts it a snapshot of the world every rendered frame
 * and applies the commands the scripts answer with on the next one, through the same session services
 * level blueprint nodes use. Nothing a script does reaches the project.
 */

// Relative to Vite's base so the sandbox page resolves wherever the editor or player is served from.
const SCRIPT_FRAME_SRC = `${(import.meta as ImportMeta & { env: { BASE_URL: string } }).env.BASE_URL}script-frame.html`;

/** Longest name a message may carry: object, prefab, sound, clip, bone, level, variable, request and script ids. */
const MAX_NAME_LENGTH = 256;
/** Longest text a message may carry: a string variable value, a log line or an error. */
const MAX_TEXT_LENGTH = 4096;
/** Longest script log line or error shown in the play output. */
const MAX_PRINTED_LENGTH = 1000;
/** Log lines shown per frame; the rest of that frame's lines are counted in one note. */
const MAX_LOGS_PER_FRAME = 32;
/** Distinct script errors shown per session, so a script failing every frame cannot flood the output. */
const MAX_PRINTED_ERRORS = 50;
/** Events kept for one snapshot; later ones are dropped until it is posted. */
const MAX_PENDING_EVENTS = SCRIPT_LIMITS.maxCommandsPerFrame;
/** All sources together stay within half a message, so the load message keeps room for its snapshot. */
const MAX_LOAD_SCRIPT_BYTES = SCRIPT_LIMITS.maxMessageBytes / 2;
/** Room kept in each host message for its envelope (type, nonce). */
const ENVELOPE_BYTES = 256;
/** The sandbox is stopped when it has not started, or not answered, for this many rendered frames and this long. */
const RESPONSE_TIMEOUT_FRAMES = 300;
const RESPONSE_TIMEOUT_MS = 20_000;
/** Sandbox document loads bootstrapped per session; a frame that keeps reloading is stopped. */
const MAX_BOOTSTRAPS = 3;
/** Snapshots an object a command moved, spawned or destroyed is read live for, until the rendered session copy has caught up. */
const LIVE_READ_SNAPSHOTS = 3;
/** Rays are clamped to this length, like physics raycasts. */
const MAX_RAY_DISTANCE = 1e6;
/** Nesting deeper than any protocol message counts as oversized. */
const MAX_JSON_DEPTH = 16;
/** Longest JSON text of one number (e.g. -1.2345678901234567e-308). */
const MAX_NUMBER_JSON_BYTES = 26;

const LOG_LEVELS = ['info', 'warn', 'error'] as const;

type Vec3 = [number, number, number];
type TransformPartial = Partial<Pick<LevelObject, 'position' | 'rotation' | 'scale'>>;
type CommandOf<T extends ScriptCommand['type']> = Extract<ScriptCommand, { type: T }>;
type PrintType = 'info' | 'warning' | 'error';

// --- Message sizes --------------------------------------------------------------------------------------

/** UTF-8 size of `value` as JSON; Infinity when it cannot be encoded. */
const jsonByteLength = (value: unknown): number => {
    try {
        const encoded = JSON.stringify(value);
        return typeof encoded === 'string' ? new TextEncoder().encode(encoded).byteLength : Infinity;
    } catch {
        return Infinity;
    }
};

/**
 * Cheap lower and upper bounds of `value`'s UTF-8 JSON size, without encoding it. Strings count 1 to 6
 * bytes per UTF-16 unit (escapes included) and numbers 1 to 26 bytes. The walk stops once the lower bound
 * passes `limit`, so an oversized or cyclic value costs at most about `limit` steps.
 */
const jsonSizeBounds = (value: unknown, limit: number): { lower: number; upper: number } => {
    let lower = 0;
    let upper = 0;
    const visit = (item: unknown, depth: number): void => {
        if (lower > limit) return;
        if (depth > MAX_JSON_DEPTH) {
            lower = Infinity;
            upper = Infinity;
            return;
        }
        if (typeof item === 'string') {
            lower += item.length + 2;
            upper += item.length * 6 + 2;
        } else if (typeof item === 'number') {
            lower += 1;
            upper += MAX_NUMBER_JSON_BYTES;
        } else if (typeof item === 'boolean') {
            lower += 4;
            upper += 5;
        } else if (Array.isArray(item)) {
            lower += 2 + Math.max(0, item.length - 1);
            upper += 2 + item.length;
            for (let i = 0; i < item.length && lower <= limit; i++) visit(item[i], depth + 1);
        } else if (item && typeof item === 'object') {
            lower += 2;
            upper += 2;
            for (const key in item) {
                if (!Object.hasOwn(item, key)) continue;
                const entry = (item as Record<string, unknown>)[key];
                if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') continue;
                lower += key.length + 3;
                upper += key.length * 6 + 4;
                visit(entry, depth + 1);
                if (lower > limit) return;
            }
        } else {
            // null, and undefined array entries, encode as null.
            lower += 4;
            upper += 4;
        }
    };
    visit(value, 0);
    return { lower, upper };
};

/** True when `value` encodes as JSON in at most `limit` UTF-8 bytes; it is only encoded when the cheap bounds cannot tell. */
const fitsJsonBytes = (value: unknown, limit: number): boolean => {
    const { lower, upper } = jsonSizeBounds(value, limit);
    if (lower > limit) return false;
    return upper <= limit || jsonByteLength(value) <= limit;
};

/** Upper bound of one object state's JSON size: its strings at 6 bytes per unit, nine numbers and the fixed keys. */
const objectStateUpperBound = (state: ScriptObjectState): number =>
    6 * (state.id.length + state.name.length + (state.parentId?.length ?? 0)) + 9 * MAX_NUMBER_JSON_BYTES + 160;

/** A snapshot fitted into a message, and how many objects had to be left out of it. */
export interface FittedScriptSnapshot {
    snapshot: ScriptSnapshot;
    omittedObjects: number;
}

/**
 * Fits a snapshot into `limit` JSON bytes. When it is too large, objects no script is attached to
 * (`keepIds` are) are left out, last first. Null when even that cannot make it fit.
 */
export const fitScriptSnapshot = (snapshot: ScriptSnapshot, limit: number, keepIds: ReadonlySet<string>): FittedScriptSnapshot | null => {
    const rest: ScriptSnapshot = { ...snapshot, objects: [] };
    const restBounds = jsonSizeBounds(rest, limit);
    if (restBounds.lower > limit) return null;
    let objectsUpper = snapshot.objects.length;
    for (const state of snapshot.objects) objectsUpper += objectStateUpperBound(state);
    if (restBounds.upper + objectsUpper <= limit) return { snapshot, omittedObjects: 0 };

    const restBytes = jsonByteLength(rest);
    if (restBytes > limit) return null;
    // One separator per object; the empty array's brackets are already in restBytes.
    const sizes = snapshot.objects.map(state => jsonByteLength(state) + 1);
    let total = sizes.reduce((sum, size) => sum + size, restBytes);
    if (total <= limit) return { snapshot, omittedObjects: 0 };
    const omitted = new Set<number>();
    for (let i = snapshot.objects.length - 1; i >= 0 && total > limit; i--) {
        if (keepIds.has(snapshot.objects[i].id)) continue;
        omitted.add(i);
        total -= sizes[i];
    }
    if (total > limit) return null;
    return { snapshot: { ...snapshot, objects: snapshot.objects.filter((_, i) => !omitted.has(i)) }, omittedObjects: omitted.size };
};

// --- Message validation ---------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
};

/** Every `required` key, and no key outside `required` and `optional`. */
const hasKeys = (record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean =>
    required.every(key => Object.hasOwn(record, key))
    && Object.keys(record).every(key => required.includes(key) || optional.includes(key));

const isName = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME_LENGTH;

const isText = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_TEXT_LENGTH;

const isVec3 = (value: unknown): value is ScriptVec3 =>
    Array.isArray(value) && value.length === 3 && value.every(axis => typeof axis === 'number' && Number.isFinite(axis));

const isScriptValue = (value: unknown): value is ScriptValue =>
    (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean' || isText(value);

const copyVec3 = (value: readonly number[]): Vec3 => [value[0], value[1], value[2]];

/** `value` when absent (undefined) or valid; `false` marks an invalid optional field. */
const optional = <T,>(value: unknown, valid: (item: unknown) => item is T): T | undefined | false =>
    value === undefined ? undefined : valid(value) ? value : false;

/**
 * A validated copy of one script command, or null when it is malformed: an unknown type, a missing or
 * extra field, a non-finite or wrong-length vector, a name or text over its length limit.
 */
export const parseScriptCommand = (value: unknown): ScriptCommand | null => {
    if (!isRecord(value)) return null;
    const v = value;
    switch (v.type) {
        case 'setTransform': {
            if (!hasKeys(v, ['type', 'objectId'], ['position', 'rotation', 'scale']) || !isName(v.objectId)) return null;
            const command: CommandOf<'setTransform'> = { type: 'setTransform', objectId: v.objectId };
            for (const key of ['position', 'rotation', 'scale'] as const) {
                const axes = optional(v[key], isVec3);
                if (axes === false) return null;
                if (axes) command[key] = copyVec3(axes);
            }
            return command;
        }
        case 'setVisible':
            return hasKeys(v, ['type', 'objectId', 'visible']) && isName(v.objectId) && typeof v.visible === 'boolean'
                ? { type: 'setVisible', objectId: v.objectId, visible: v.visible }
                : null;
        case 'applyImpulse':
            return hasKeys(v, ['type', 'objectId', 'impulse']) && isName(v.objectId) && isVec3(v.impulse)
                ? { type: 'applyImpulse', objectId: v.objectId, impulse: copyVec3(v.impulse) }
                : null;
        case 'destroy':
            return hasKeys(v, ['type', 'objectId']) && isName(v.objectId) ? { type: 'destroy', objectId: v.objectId } : null;
        case 'spawnPrefab':
            return hasKeys(v, ['type', 'requestId', 'prefabId', 'position']) && isName(v.requestId) && isName(v.prefabId) && isVec3(v.position)
                ? { type: 'spawnPrefab', requestId: v.requestId, prefabId: v.prefabId, position: copyVec3(v.position) }
                : null;
        case 'setVariable':
            return hasKeys(v, ['type', 'name', 'value']) && isName(v.name) && isScriptValue(v.value)
                ? { type: 'setVariable', name: v.name, value: v.value }
                : null;
        case 'playSound': {
            const bus = optional(v.bus, (item): item is AudioBus => typeof item === 'string' && (AUDIO_BUSES as string[]).includes(item));
            if (!hasKeys(v, ['type', 'audioId'], ['bus']) || !isName(v.audioId) || bus === false) return null;
            return bus ? { type: 'playSound', audioId: v.audioId, bus } : { type: 'playSound', audioId: v.audioId };
        }
        case 'raycast': {
            const exclude = optional(v.excludeObjectId, isName);
            if (!hasKeys(v, ['type', 'requestId', 'origin', 'direction', 'maxDistance'], ['excludeObjectId'])
                || !isName(v.requestId) || !isVec3(v.origin) || !isVec3(v.direction) || exclude === false
                || typeof v.maxDistance !== 'number' || !Number.isFinite(v.maxDistance) || v.maxDistance <= 0) return null;
            const command: CommandOf<'raycast'> = {
                type: 'raycast', requestId: v.requestId, origin: copyVec3(v.origin), direction: copyVec3(v.direction), maxDistance: v.maxDistance,
            };
            if (exclude) command.excludeObjectId = exclude;
            return command;
        }
        case 'playPlayerAnimation': {
            const maskBone = optional(v.maskBone, isName);
            if (!hasKeys(v, ['type', 'clipName'], ['maskBone']) || !isName(v.clipName) || maskBone === false) return null;
            return maskBone ? { type: 'playPlayerAnimation', clipName: v.clipName, maskBone } : { type: 'playPlayerAnimation', clipName: v.clipName };
        }
        case 'openLevel':
            return hasKeys(v, ['type', 'levelId']) && isName(v.levelId) ? { type: 'openLevel', levelId: v.levelId } : null;
        case 'setCamera':
            return hasKeys(v, ['type', 'objectId', 'blend']) && (v.objectId === null || isName(v.objectId))
                && typeof v.blend === 'number' && Number.isFinite(v.blend) && v.blend >= 0 && v.blend <= 30
                ? { type: 'setCamera', objectId: v.objectId as string | null, blend: v.blend }
                : null;
        case 'startDialogue':
            return hasKeys(v, ['type', 'objectId']) && isName(v.objectId) ? { type: 'startDialogue', objectId: v.objectId } : null;
        case 'netSend': {
            const to = optional(v.to, isName);
            if (!hasKeys(v, ['type', 'name', 'payload'], ['to']) || !isName(v.name) || v.name.length > NET_LIMITS.maxEventNameLength
                || !isScriptNetPayload(v.payload) || to === false) return null;
            return to ? { type: 'netSend', name: v.name, payload: v.payload, to } : { type: 'netSend', name: v.name, payload: v.payload };
        }
        case 'log':
            return hasKeys(v, ['type', 'scriptId', 'level', 'message']) && isName(v.scriptId)
                && (LOG_LEVELS as readonly unknown[]).includes(v.level) && isText(v.message)
                ? { type: 'log', scriptId: v.scriptId, level: v.level as CommandOf<'log'>['level'], message: v.message }
                : null;
        default:
            return null;
    }
};

/** A validated frame -> runtime message. A commands message keeps its valid commands and counts the rejected ones. */
export type ParsedScriptFrameMessage =
    | { type: 'ready' }
    | { type: 'commands'; frame: number; commands: ScriptCommand[]; rejected: number }
    | { type: 'error'; scriptId: string; message: string };

/**
 * Validates a message from the script frame: at most SCRIPT_LIMITS.maxMessageBytes as JSON, a plain
 * object of exactly one ScriptFrameMessage shape, at most SCRIPT_LIMITS.maxCommandsPerFrame commands.
 * Null for anything else, which the runtime treats as a broken sandbox. A malformed command inside an
 * otherwise valid commands message is dropped and counted instead.
 */
export const parseScriptFrameMessage = (value: unknown): ParsedScriptFrameMessage | null => {
    if (!isRecord(value) || !fitsJsonBytes(value, SCRIPT_LIMITS.maxMessageBytes)) return null;
    switch (value.type) {
        case 'ready':
            return hasKeys(value, ['type']) ? { type: 'ready' } : null;
        case 'commands': {
            const { frame, commands } = value;
            if (!hasKeys(value, ['type', 'frame', 'commands']) || typeof frame !== 'number' || !Number.isSafeInteger(frame) || frame < 0
                || !Array.isArray(commands) || commands.length > SCRIPT_LIMITS.maxCommandsPerFrame) return null;
            const parsed: ScriptCommand[] = [];
            for (const item of commands) {
                const command = parseScriptCommand(item);
                if (command) parsed.push(command);
            }
            return { type: 'commands', frame, commands: parsed, rejected: commands.length - parsed.length };
        }
        case 'error':
            return hasKeys(value, ['type', 'scriptId', 'message']) && typeof value.scriptId === 'string'
                && value.scriptId.length <= MAX_NAME_LENGTH && isText(value.message)
                ? { type: 'error', scriptId: value.scriptId, message: value.message }
                : null;
        default:
            return null;
    }
};

// --- Scripts --------------------------------------------------------------------------------------------

/** A script component left out of the session, with the reason shown in the play output. */
export interface SkippedScript {
    scriptId: string;
    objectId: string;
    objectName: string;
    reason: string;
}

export interface CollectedScripts {
    scripts: ScriptSource[];
    skipped: SkippedScript[];
}

const utf8Length = (text: string): number => new TextEncoder().encode(text).byteLength;

/**
 * The enabled script components of `objects` with a non-blank source, in object order, bounded by
 * SCRIPT_LIMITS (count, source size) and by half a message for all sources together. A component id
 * that repeats on another object is made unique with that object's id.
 */
export const collectScriptSources = (objects: readonly LevelObject[]): CollectedScripts => {
    const scripts: ScriptSource[] = [];
    const skipped: SkippedScript[] = [];
    const ids = new Set<string>();
    let totalBytes = 0;
    for (const object of objects) {
        for (const component of object.components ?? []) {
            if (component.type !== SCRIPT_COMPONENT_TYPE || !component.enabled) continue;
            const source = readScriptSource(component);
            if (!source.trim()) continue;
            const baseId = typeof component.id === 'string' && component.id ? component.id : object.id;
            const id = ids.has(baseId) ? `${baseId}@${object.id}` : baseId;
            const skip = (reason: string) => skipped.push({ scriptId: id, objectId: object.id, objectName: object.name, reason });
            if (scripts.length >= SCRIPT_LIMITS.maxScripts) {
                skip(`a level runs at most ${SCRIPT_LIMITS.maxScripts} scripts`);
                continue;
            }
            if (utf8Length(source) > SCRIPT_LIMITS.maxSourceBytes) {
                skip(`its source is over ${SCRIPT_LIMITS.maxSourceBytes / 1024} KB`);
                continue;
            }
            const entry: ScriptSource = { id, objectId: object.id, source };
            const bytes = jsonByteLength(entry);
            if (totalBytes + bytes > MAX_LOAD_SCRIPT_BYTES) {
                skip(`the level's scripts together are over ${MAX_LOAD_SCRIPT_BYTES / 1024} KB`);
                continue;
            }
            ids.add(id);
            totalBytes += bytes;
            scripts.push(entry);
        }
    }
    return { scripts, skipped };
};

// --- Snapshots ------------------------------------------------------------------------------------------

const finite = (value: number): number => (Number.isFinite(value) ? value : 0);

const toScriptVec3 = (value: readonly number[]): ScriptVec3 => [finite(value[0]), finite(value[1]), finite(value[2])];

const toObjectState = (object: LevelObject, visible: boolean): ScriptObjectState => ({
    id: object.id,
    name: object.name,
    position: toScriptVec3(object.position),
    rotation: toScriptVec3(object.rotation),
    scale: toScriptVec3(object.scale),
    parentId: object.parentId || null,
    visible,
});

/** What one snapshot is built from. */
export interface ScriptSnapshotSources {
    frame: number;
    time: number;
    delta: number;
    /** The session objects as last rendered: transforms local to the parent, in session order. */
    objects: readonly LevelObject[];
    /**
     * Objects read through getObject instead: ones commands just moved, spawned or destroyed, and
     * simulated bodies. A live read of nothing leaves the object out; one not in `objects` is appended.
     */
    liveIds: ReadonlySet<string>;
    getObject: (id: string) => LevelObject | null | undefined;
    /** Objects a script hid. */
    hidden: ReadonlySet<string>;
    /**
     * Object states reused across snapshots while an object (session copies are replaced, never changed
     * in place) and its visibility stay the same, so an unchanged world builds without allocating.
     */
    cache?: WeakMap<LevelObject, ScriptObjectState>;
    player: ScriptSnapshot['player'];
    input: ScriptSnapshot['input'];
    variables: ScriptSnapshot['variables'];
    events: readonly ScriptEvent[];
    /** Multiplayer state; offline (connected false, host true) when omitted. */
    net?: ScriptNetState;
    raycasts: ReadonlyMap<string, ScriptRaycastHit | null>;
}

/** The world as scripts see it for one frame. Copies every value, so later session changes never alter a built snapshot. */
export const buildScriptSnapshot = (sources: ScriptSnapshotSources): ScriptSnapshot => {
    const objects: ScriptObjectState[] = [];
    const { cache } = sources;
    const add = (object: LevelObject) => {
        const visible = !sources.hidden.has(object.id);
        const cached = cache?.get(object);
        if (cached && cached.visible === visible) {
            objects.push(cached);
            return;
        }
        const state = toObjectState(object, visible);
        cache?.set(object, state);
        objects.push(state);
    };
    const listed = new Set<string>();
    for (const object of sources.objects) {
        if (!sources.liveIds.has(object.id)) {
            add(object);
            continue;
        }
        listed.add(object.id);
        const live = sources.getObject(object.id);
        if (live) add(live);
    }
    for (const id of sources.liveIds) {
        if (listed.has(id)) continue;
        const live = sources.getObject(id);
        if (live) add(live);
    }
    return {
        frame: sources.frame,
        time: finite(sources.time),
        delta: finite(sources.delta),
        objects,
        player: sources.player ? { position: toScriptVec3(sources.player.position), rotation: toScriptVec3(sources.player.rotation) } : null,
        input: { ...sources.input },
        variables: { ...sources.variables },
        events: [...sources.events],
        // fromEntries defines own properties, so a request id such as '__proto__' stays an ordinary key.
        raycasts: Object.fromEntries(sources.raycasts),
        net: sources.net ?? OFFLINE_NET,
    };
};

/** Presses and releases of one action seen since the previous snapshot. */
export interface ScriptInputEdges {
    pressed: boolean;
    released: boolean;
}

/** The mapped actions among `names`, read from the runtime input, with the edges collected since the previous snapshot. */
export const readScriptInputActions = (
    input: Pick<InputState, 'hasAction' | 'isDown' | 'value'>,
    names: readonly string[],
    edges: ReadonlyMap<string, ScriptInputEdges>,
): Record<string, ScriptInputAction> => {
    const actions: Record<string, ScriptInputAction> = {};
    for (const name of names) {
        if (!input.hasAction(name)) continue;
        const edge = edges.get(name);
        actions[name] = {
            down: input.isDown(name),
            pressed: edge?.pressed ?? false,
            released: edge?.released ?? false,
            value: Math.min(1, Math.max(-1, finite(input.value(name)))),
        };
    }
    return actions;
};

const posePosition = new THREE.Vector3();
const poseQuaternion = new THREE.Quaternion();
const poseScale = new THREE.Vector3();
const poseEuler = new THREE.Euler();

/** World-space pose of the player character's model; rotation is Euler XYZ radians. */
const readPlayerPose = (object: THREE.Object3D | null | undefined): ScriptSnapshot['player'] => {
    if (!object) return null;
    object.updateWorldMatrix(true, false);
    object.matrixWorld.decompose(posePosition, poseQuaternion, poseScale);
    poseEuler.setFromQuaternion(poseQuaternion, 'XYZ');
    return { position: [posePosition.x, posePosition.y, posePosition.z], rotation: [poseEuler.x, poseEuler.y, poseEuler.z] };
};

// --- Commands -------------------------------------------------------------------------------------------

/** What script commands may do to the play session: the services level blueprint nodes use. Must never write to the project. */
export interface ScriptCommandServices {
    getObject(id: string): LevelObject | null | undefined;
    setObjectTransform(id: string, partial: TransformPartial): void;
    setVisible(id: string, visible: boolean): void;
    applyImpulse(id: string, impulse: Vec3): void;
    destroyObject(id: string): void;
    /** Places a prefab in the session; returns the new object ids, root first. */
    spawnPrefab(prefabId: string, position: Vec3): string[];
    /** False when the value does not fit the variable's type. */
    setVariable(name: string, value: ScriptValue): boolean;
    playSound(audioId: string, bus?: AudioBus): void;
    raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number, options?: PhysicsRaycastOptions): PhysicsRaycastHit | null;
    /** False when the player character has no such clip. */
    playPlayerAnimation(clipName: string, maskBone?: string): boolean;
    openLevel(levelId: string): void;
    log(scriptId: string, level: CommandOf<'log'>['level'], message: string): void;
    /** Sends a multiplayer event; does nothing in a single-player game. */
    sendNetEvent(name: string, payload: ScriptNetPayload, to?: string): void;
    /** Shows a level camera, or the gameplay camera for null. */
    setCamera(objectId: string | null, blend: number): void;
    /** False when the object has no Dialogue component in the session, or another conversation is open. */
    startDialogue(objectId: string): boolean;
}

/** What applying one frame's commands produced for the next snapshot. */
export interface ScriptCommandResults {
    events: ScriptEvent[];
    raycasts: Map<string, ScriptRaycastHit | null>;
    /** Objects the commands moved, spawned or destroyed; the next snapshots read them live. */
    touched: Set<string>;
    /** An Open Level command ran: the session is ending, so later commands are not applied. */
    ended: boolean;
}

/** Empty results to collect one frame's commands into. */
export const createScriptCommandResults = (): ScriptCommandResults => ({ events: [], raycasts: new Map(), touched: new Set(), ended: false });

/**
 * Applies one validated command through `services`, collecting what the next snapshot reports (spawned
 * objects, raycast answers) into `results`. Commands on objects that are not in the session do nothing.
 */
export const applyScriptCommand = (command: ScriptCommand, services: ScriptCommandServices, results: ScriptCommandResults): void => {
    if (results.ended) return;
    switch (command.type) {
        case 'setTransform': {
            if (!services.getObject(command.objectId)) return;
            const partial: TransformPartial = {};
            if (command.position) partial.position = copyVec3(command.position);
            if (command.rotation) partial.rotation = copyVec3(command.rotation);
            if (command.scale) partial.scale = copyVec3(command.scale);
            if (Object.keys(partial).length === 0) return;
            services.setObjectTransform(command.objectId, partial);
            results.touched.add(command.objectId);
            return;
        }
        case 'setVisible':
            if (services.getObject(command.objectId)) services.setVisible(command.objectId, command.visible);
            return;
        case 'applyImpulse':
            if (command.impulse.some(axis => axis !== 0)) services.applyImpulse(command.objectId, copyVec3(command.impulse));
            return;
        case 'destroy':
            if (!services.getObject(command.objectId)) return;
            services.destroyObject(command.objectId);
            results.touched.add(command.objectId);
            return;
        case 'spawnPrefab': {
            const objectIds = [...services.spawnPrefab(command.prefabId, copyVec3(command.position))];
            objectIds.forEach(id => results.touched.add(id));
            results.events.push({ type: 'spawned', requestId: command.requestId, objectIds });
            return;
        }
        case 'setVariable':
            services.setVariable(command.name, command.value);
            return;
        case 'playSound':
            services.playSound(command.audioId, command.bus);
            return;
        case 'raycast': {
            const options = command.excludeObjectId === undefined ? undefined : { excludeObjectId: command.excludeObjectId };
            const hit = services.raycast(
                new THREE.Vector3(...command.origin),
                new THREE.Vector3(...command.direction),
                Math.min(command.maxDistance, MAX_RAY_DISTANCE),
                options,
            );
            results.raycasts.set(command.requestId, hit ? {
                objectId: hit.objectId,
                point: toScriptVec3(hit.point.toArray()),
                normal: toScriptVec3(hit.normal.toArray()),
                distance: finite(hit.distance),
            } : null);
            return;
        }
        case 'playPlayerAnimation':
            services.playPlayerAnimation(command.clipName, command.maskBone);
            return;
        case 'openLevel':
            results.ended = true;
            services.openLevel(command.levelId);
            return;
        case 'netSend':
            services.sendNetEvent(command.name, command.payload, command.to);
            return;
        case 'setCamera':
            services.setCamera(command.objectId, command.blend);
            return;
        case 'startDialogue':
            services.startDialogue(command.objectId);
            return;
        case 'log':
            services.log(command.scriptId, command.level, command.message);
            return;
    }
};

// --- Runtime --------------------------------------------------------------------------------------------

export interface ScriptRuntimeProps {
    /** The session copy of the level as last rendered (local transforms, parent links, components); scripts come from its script components. */
    objects: readonly LevelObject[];
    /** The live session object: this frame's writes and simulated body poses included, as blueprint nodes read it. */
    getObject: (id: string) => LevelObject | null;
    /** Moves an object in the session copy (never the project). */
    setObjectTransform: (id: string, partial: TransformPartial) => void;
    /** Removes an object and its children from the session copy. */
    destroyObject: (id: string) => void;
    /** Pushes an object's dynamic rigid body. */
    applyImpulse: (id: string, impulse: Vec3) => void;
    /** Physics ray query, e.g. usePhysicsQueries().raycast. */
    raycast: (origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number, options?: PhysicsRaycastOptions) => PhysicsRaycastHit | null;
    /** The player character's model, for the snapshot's player pose. */
    playerEntityRef: React.RefObject<{ object: THREE.Object3D } | null>;
    /** The player character's animation graph, for Play Player Animation. */
    playerApiRef: React.RefObject<{ playMontage?: (clipName: string, options?: { maskBone?: string }) => boolean } | undefined>;
    openLevel: (levelId: string) => void;
    /** The play session's output (blueprint Print String goes there too). */
    print: (message: string, type: 'info' | 'warning' | 'error') => void;
}

type HostPhase = 'connecting' | 'ready' | 'running' | 'stopped';

/** One sandbox connection's state. A new one is made per mount, so StrictMode's remount starts clean. */
interface HostState {
    phase: HostPhase;
    port: MessagePort | null;
    nonce: string | null;
    bootstraps: number;
    /** Rendered frames and wall time spent waiting for the sandbox to start or to answer. */
    waitFrames: number;
    waitStart: number;
    /** The snapshot frame whose answer is pending. */
    inFlight: number | null;
    /** The answer to apply on the next frame. */
    answer: { commands: ScriptCommand[]; rejected: number } | null;
    nextFrame: number;
    time: number;
    sinceSnapshot: number;
    events: ScriptEvent[];
    raycasts: Map<string, ScriptRaycastHit | null>;
    edges: Map<string, ScriptInputEdges>;
    /** Object id -> the snapshot frame a command touched it in. */
    touched: Map<string, number>;
    hidden: Set<string>;
    objectStates: WeakMap<LevelObject, ScriptObjectState>;
    printedErrors: Set<string>;
    noted: Set<string>;
}

const newHostState = (): HostState => ({
    phase: 'connecting',
    port: null,
    nonce: null,
    bootstraps: 0,
    waitFrames: 0,
    waitStart: performance.now(),
    inFlight: null,
    answer: null,
    nextFrame: 0,
    time: 0,
    sinceSnapshot: 0,
    events: [],
    raycasts: new Map(),
    edges: new Map(),
    touched: new Map(),
    hidden: new Set(),
    objectStates: new WeakMap(),
    printedErrors: new Set(),
    noted: new Set(),
});

function createNonce(): string {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const clip = (text: string): string => (text.length > MAX_PRINTED_LENGTH ? `${text.slice(0, MAX_PRINTED_LENGTH)}...` : text);

const hasEnabledBody = (object: LevelObject): boolean =>
    (object.components ?? []).some(component => component.type === 'rigidBody' && component.enabled);

const INPUT_ACTION_NAMES = DEFAULT_INPUT_MAP.map(action => action.name);

const LOG_PRINT_TYPES: Record<CommandOf<'log'>['level'], PrintType> = { info: 'info', warn: 'warning', error: 'error' };

const ScriptHost: React.FC<ScriptRuntimeProps & { scripts: ScriptSource[] }> = ({ scripts, ...props }) => {
    // Gameplay callbacks churn every render; the sandbox loop reads the latest through refs.
    const latest = useRef(props);
    latest.current = props;
    const runtimeServices: RuntimeServices = useRuntimeServices();
    const services = useRef(runtimeServices);
    services.current = runtimeServices;
    const scene = useThree(state => state.scene);
    const sceneRef = useRef(scene);
    sceneRef.current = scene;
    const triggerEvents = useTriggerEvents();
    const netSession = useNetSession();
    const netRef = useRef(netSession);
    netRef.current = netSession;
    const [initialState] = useState(newHostState);
    const host = useRef<HostState>(initialState);

    const labels = useMemo(() => {
        const names = new Map(props.objects.map(object => [object.id, object.name]));
        return new Map(scripts.map(script => [script.id, names.get(script.objectId) || script.objectId]));
    // Scripts are fixed for the session, and so are the objects they were collected from.
    }, [scripts]);
    const ownerIds = useMemo(() => new Set(scripts.map(script => script.objectId)), [scripts]);
    const bodyIds = useMemo(() => props.objects.filter(hasEnabledBody).map(object => object.id), [props.objects]);

    const print = (message: string, type: PrintType) => latest.current.print(message, type);
    const label = (scriptId: string) => labels.get(scriptId) ?? 'Script';

    /** Prints a note once per session. */
    const noteOnce = (state: HostState, key: string, message: string) => {
        if (state.noted.has(key)) return;
        state.noted.add(key);
        print(message, 'warning');
    };

    const closePort = (state: HostState, unload: boolean) => {
        const port = state.port;
        if (!port) return;
        if (unload && state.nonce) {
            const message: ScriptHostMessage = { type: 'unload', nonce: state.nonce };
            try { port.postMessage(message); } catch { /* the sandbox is already gone */ }
        }
        port.onmessage = null;
        port.close();
        state.port = null;
        state.nonce = null;
    };

    const stop = (state: HostState, code: string, message: string, error?: unknown) => {
        if (state.phase === 'stopped') return;
        state.phase = 'stopped';
        frontendDiagnostics.failure(code, error);
        closePort(state, true);
        print(message, 'error');
    };

    const resetWait = (state: HostState) => {
        state.waitFrames = 0;
        state.waitStart = performance.now();
    };

    const pushEvent = (state: HostState, event: ScriptEvent) => {
        if (state.phase === 'stopped') return;
        if (state.events.length >= MAX_PENDING_EVENTS) {
            frontendDiagnostics.warning('script_events_dropped');
            return;
        }
        state.events.push(event);
    };

    const reportScriptError = (state: HostState, scriptId: string, message: string) => {
        const key = `${scriptId}\n${message}`;
        if (state.printedErrors.has(key)) return;
        if (state.printedErrors.size >= MAX_PRINTED_ERRORS) {
            noteOnce(state, 'errors_suppressed', 'Further script errors are not shown.');
            return;
        }
        state.printedErrors.add(key);
        frontendDiagnostics.failure('script_runtime_error');
        print(`[Script: ${label(scriptId)}] ${clip(message)}`, 'error');
    };

    const receive = (state: HostState, port: MessagePort, event: MessageEvent<unknown>) => {
        // A late message on a channel that was replaced or closed is not this sandbox's.
        if (state.port !== port || state.phase === 'stopped') return;
        const message = event.ports.length === 0 ? parseScriptFrameMessage(event.data) : null;
        if (!message) {
            stop(state, 'script_protocol_violation', 'Scripts stopped: the script sandbox sent an invalid message.');
            return;
        }
        if (message.type === 'error') {
            reportScriptError(state, message.scriptId, message.message);
            return;
        }
        if (message.type === 'ready') {
            if (state.phase !== 'connecting') {
                stop(state, 'script_protocol_violation', 'Scripts stopped: the script sandbox sent an invalid message.');
                return;
            }
            state.phase = 'ready';
            resetWait(state);
            return;
        }
        if (state.phase !== 'running' || state.inFlight !== message.frame) {
            stop(state, 'script_protocol_violation', 'Scripts stopped: the script sandbox answered a frame it was not sent.');
            return;
        }
        state.inFlight = null;
        state.answer = { commands: message.commands, rejected: message.rejected };
    };

    const bootstrap = (state: HostState, iframe: HTMLIFrameElement) => {
        if (state.phase === 'stopped') return;
        // A new document in the frame (first load or a reload) gets a new channel and loads the scripts again.
        closePort(state, false);
        if (state.bootstraps >= MAX_BOOTSTRAPS) {
            stop(state, 'script_frame_reloaded', 'Scripts stopped: the script sandbox kept reloading.');
            return;
        }
        const target = iframe.contentWindow;
        if (!target) return;
        state.bootstraps += 1;
        state.phase = 'connecting';
        state.inFlight = null;
        state.answer = null;
        resetWait(state);
        const channel = new MessageChannel();
        const nonce = createNonce();
        const port = channel.port1;
        state.port = port;
        state.nonce = nonce;
        port.onmessage = (event: MessageEvent<unknown>) => receive(state, port, event);
        port.start();
        const message: ScriptHostMessage = { type: 'auvra-script-bootstrap', nonce, version: SCRIPT_PROTOCOL_VERSION };
        try {
            // The sandbox has an opaque origin because allow-same-origin is omitted, so the single bootstrap
            // must target '*'. Everything after it travels over the transferred port only.
            target.postMessage(message, '*', [channel.port2]);
        } catch (error) {
            stop(state, 'script_transport_failed', 'Scripts stopped: the script sandbox could not be reached.', error);
        }
    };

    /** Shows or hides the drawn groups of `changes`' objects (their own transform groups, terrain included). */
    const applyVisibility = (changes: ReadonlyMap<string, boolean>) => {
        if (changes.size === 0) return;
        sceneRef.current.traverse(node => {
            const id = (node.userData as { levelObjectId?: unknown } | undefined)?.levelObjectId;
            if (typeof id !== 'string') return;
            const visible = changes.get(id);
            if (visible !== undefined) node.visible = visible;
        });
    };

    /** Applies one answer's commands; false when they ended the session's scripts (Open Level). */
    const applyAnswer = (state: HostState, answer: NonNullable<HostState['answer']>): boolean => {
        if (answer.rejected > 0) {
            frontendDiagnostics.warning('script_command_rejected', answer.rejected);
            noteOnce(state, 'commands_rejected', 'Some script commands were malformed and were ignored.');
        }
        const results = createScriptCommandResults();
        const visibility = new Map<string, boolean>();
        let logs = 0;
        let droppedLogs = 0;
        const commandServices: ScriptCommandServices = {
            getObject: id => latest.current.getObject(id),
            setObjectTransform: (id, partial) => latest.current.setObjectTransform(id, partial),
            setVisible: (id, visible) => {
                if (visible) state.hidden.delete(id);
                else state.hidden.add(id);
                visibility.set(id, visible);
            },
            applyImpulse: (id, impulse) => latest.current.applyImpulse(id, impulse),
            destroyObject: id => latest.current.destroyObject(id),
            spawnPrefab: (prefabId, position) => services.current.spawnPrefab(prefabId, position),
            setVariable: (name, value) => levelVariables.set(name, value),
            playSound: (audioId, bus) => services.current.playSound(audioId, bus),
            raycast: (origin, direction, maxDistance, options) => latest.current.raycast(origin, direction, maxDistance, options),
            playPlayerAnimation: (clipName, maskBone) => {
                const played = latest.current.playerApiRef.current?.playMontage?.(clipName, maskBone ? { maskBone } : undefined) ?? false;
                if (!played) noteOnce(state, `clip:${clipName}`, `Play Player Animation: the player character has no clip "${clipName}".`);
                return played;
            },
            openLevel: levelId => latest.current.openLevel(levelId),
            sendNetEvent: (name, payload, to) => netRef.current?.sendEvent(name, payload, to),
            setCamera: (objectId, blend) => cameraDirector.setActive(objectId, blend),
            startDialogue: objectId => {
                if (!dialogueSpeakers.has(objectId)) {
                    noteOnce(state, `dialogue:${objectId}`, `startDialogue: object "${objectId}" has no Dialogue component.`);
                    return false;
                }
                return startDialogue(objectId);
            },
            log: (scriptId, level, message) => {
                if (logs >= MAX_LOGS_PER_FRAME) {
                    droppedLogs += 1;
                    return;
                }
                logs += 1;
                print(`[Script: ${label(scriptId)}] ${clip(message)}`, LOG_PRINT_TYPES[level]);
            },
        };
        for (const command of answer.commands) {
            try {
                applyScriptCommand(command, commandServices, results);
            } catch (error) {
                frontendDiagnostics.failure('script_command_failed', error);
            }
            if (results.ended) break;
        }
        if (droppedLogs > 0) print(`[Script] ${droppedLogs} more log lines this frame were not shown.`, 'info');
        results.events.forEach(event => pushEvent(state, event));
        results.raycasts.forEach((hit, requestId) => state.raycasts.set(requestId, hit));
        results.touched.forEach(id => state.touched.set(id, state.nextFrame));
        applyVisibility(visibility);
        if (!results.ended) return true;
        // The level is changing; this session's scripts are done.
        state.phase = 'stopped';
        closePort(state, true);
        return false;
    };

    const collectEdges = (state: HostState) => {
        const input = services.current.input;
        for (const name of INPUT_ACTION_NAMES) {
            const pressed = input.wasPressed(name);
            const released = input.wasReleased(name);
            if (!pressed && !released) continue;
            const edge = state.edges.get(name) ?? { pressed: false, released: false };
            edge.pressed ||= pressed;
            edge.released ||= released;
            state.edges.set(name, edge);
        }
    };

    const buildSnapshot = (state: HostState, frame: number): ScriptSnapshot => {
        const liveIds = new Set(bodyIds);
        state.touched.forEach((touchedAt, id) => {
            if (frame - touchedAt < LIVE_READ_SNAPSHOTS) liveIds.add(id);
            else state.touched.delete(id);
        });
        return buildScriptSnapshot({
            frame,
            time: state.time,
            delta: state.sinceSnapshot,
            objects: latest.current.objects,
            liveIds,
            getObject: id => latest.current.getObject(id),
            hidden: state.hidden,
            cache: state.objectStates,
            player: readPlayerPose(latest.current.playerEntityRef.current?.object),
            input: readScriptInputActions(services.current.input, INPUT_ACTION_NAMES, state.edges),
            variables: levelVariables.all(),
            events: state.events,
            raycasts: state.raycasts,
            net: scriptNetState(netRef.current),
        });
    };

    const post = (state: HostState) => {
        const port = state.port;
        const nonce = state.nonce;
        if (!port || !nonce) return;
        const loading = state.phase === 'ready';
        const frame = state.nextFrame;
        const budget = SCRIPT_LIMITS.maxMessageBytes - ENVELOPE_BYTES - (loading ? jsonByteLength(scripts) : 0);
        const fitted = fitScriptSnapshot(buildSnapshot(state, frame), budget, ownerIds);
        if (!fitted) {
            stop(state, 'script_snapshot_too_large', 'Scripts stopped: the world is too large for the script message limit.');
            return;
        }
        if (fitted.omittedObjects > 0) {
            frontendDiagnostics.warning('script_snapshot_trimmed', fitted.omittedObjects);
            noteOnce(state, 'snapshot_trimmed', 'This level has too many objects for one script snapshot; scripts see their own objects and as many others as fit.');
        }
        const message: ScriptHostMessage = loading
            ? { type: 'load', nonce, scripts, snapshot: fitted.snapshot }
            : { type: 'frame', nonce, snapshot: fitted.snapshot };
        try {
            port.postMessage(message);
        } catch (error) {
            stop(state, 'script_transport_failed', 'Scripts stopped: the world snapshot could not be sent to the script sandbox.', error);
            return;
        }
        state.phase = 'running';
        state.inFlight = frame;
        state.nextFrame = frame + 1;
        state.sinceSnapshot = 0;
        state.events = [];
        state.raycasts = new Map();
        state.edges.clear();
        resetWait(state);
    };

    useFrame((_frameState, delta) => {
        const state = host.current;
        if (state.phase === 'stopped') return;
        const step = Number.isFinite(delta) && delta > 0 ? delta : 0;
        state.time += step;
        state.sinceSnapshot += step;
        collectEdges(state);
        const answer = state.answer;
        if (answer) {
            state.answer = null;
            if (!applyAnswer(state, answer)) return;
        }
        if (state.phase === 'connecting' || state.inFlight !== null) {
            state.waitFrames += 1;
            if (state.waitFrames > RESPONSE_TIMEOUT_FRAMES && performance.now() - state.waitStart > RESPONSE_TIMEOUT_MS) {
                stop(state, 'script_frame_timeout', state.phase === 'connecting'
                    ? 'Scripts stopped: the script sandbox did not start.'
                    : 'Scripts stopped: the script sandbox stopped answering.');
            }
            return;
        }
        post(state);
    });

    // Trigger overlaps and animation notifies are queued for the next snapshot.
    useEffect(() => triggerEvents.subscribe(event => pushEvent(host.current, {
        type: event.kind === 'enter' ? 'triggerEnter' : 'triggerExit',
        triggerId: event.triggerObjectId,
        otherId: event.otherObjectId,
    })), [triggerEvents]);
    useEffect(() => animationEvents.subscribe(event => pushEvent(host.current, {
        type: 'animNotify',
        source: event.objectId,
        name: event.name,
    })), []);
    useEffect(() => timelineEvents.subscribe(event => pushEvent(host.current, {
        type: 'timelineEvent',
        timelineObjectId: event.timelineObjectId,
        name: event.name,
    })), []);
    useEffect(() => dialogueStore.onEvent(event => pushEvent(host.current, {
        type: 'dialogueEvent',
        objectId: event.objectId,
        name: event.name,
    })), []);
    useEffect(() => netSession?.onEvent((from, name, payload) => pushEvent(host.current, {
        type: 'netEvent', from, name, payload: payload as ScriptNetPayload,
    })), [netSession]);

    // A re-render can mount new groups (a spawned object, a changed render plan); hidden objects stay hidden.
    useEffect(() => {
        const hidden = host.current.hidden;
        if (hidden.size) applyVisibility(new Map([...hidden].map(id => [id, false])));
    }, [props.objects, scene]);

    // The sandbox: a hidden frame for this mount, torn down with it.
    useEffect(() => {
        // StrictMode remounts on the same refs: the second mount starts from a fresh state.
        if (host.current.phase === 'stopped') host.current = newHostState();
        const state = host.current;
        const iframe = document.createElement('iframe');
        // Scripts run in an opaque origin; no same-origin or other permission is granted.
        iframe.setAttribute('sandbox', 'allow-scripts');
        iframe.setAttribute('aria-hidden', 'true');
        iframe.setAttribute('inert', '');
        iframe.tabIndex = -1;
        iframe.title = 'Gameplay Script Sandbox';
        iframe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;border:0;opacity:0;pointer-events:none;';
        const handleLoad = () => bootstrap(state, iframe);
        iframe.addEventListener('load', handleLoad);
        iframe.src = SCRIPT_FRAME_SRC;
        document.body.appendChild(iframe);
        return () => {
            iframe.removeEventListener('load', handleLoad);
            if (state.phase !== 'stopped') {
                state.phase = 'stopped';
                closePort(state, true);
            }
            iframe.remove();
        };
    // The connection lives for the session; everything it reads goes through refs.
    }, []);

    return null;
};

/**
 * Runs the play session's gameplay scripts. Mount it inside the session's R3F tree, under its trigger
 * events, runtime services and spawner. The scripts are the session objects' enabled script components
 * when it mounts; with none it renders and starts nothing.
 */
export const ScriptRuntime: React.FC<ScriptRuntimeProps> = (props) => {
    // Scripts load once per play session; objects spawned later bring no scripts.
    const [collected] = useState(() => collectScriptSources(props.objects));
    const print = useRef(props.print);
    print.current = props.print;
    const reported = useRef(false);
    useEffect(() => {
        if (reported.current) return;
        reported.current = true;
        collected.skipped.forEach(skipped => print.current(`[Script: ${skipped.objectName || skipped.objectId}] Not loaded: ${skipped.reason}.`, 'warning'));
    }, [collected]);
    return collected.scripts.length > 0 ? <ScriptHost {...props} scripts={collected.scripts} /> : null;
};
