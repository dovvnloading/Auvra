/**
 * GAMEPLAY SCRIPT HOST
 *
 * The sandboxed side of gameplay scripting (see protocol.ts). A script component's source, TypeScript
 * or JavaScript, defines any of these callbacks as top-level functions:
 *
 *   function onStart(ctx) {}
 *   function onUpdate(ctx, dt) {}
 *   function onTriggerEnter(ctx, other, otherId) {}   // other is null for the player ('player')
 *   function onTriggerExit(ctx, other, otherId) {}
 *   function onAnimNotify(ctx, name, source) {}
 *   function onSpawned(ctx, requestId, objectIds) {}
 *
 * Every frame the host takes the runtime's snapshot as its world, runs onStart for scripts whose object
 * has just appeared, delivers the snapshot's events, then runs onUpdate, each in load order, and
 * returns the commands the callbacks issued. Nothing here touches the DOM: script-frame.ts supplies
 * the compiler, the execution guard and the message port.
 */
import {
    SCRIPT_LIMITS,
    type ScriptCommand,
    type ScriptEvent,
    type ScriptInputAction,
    type ScriptNetPayload,
    type ScriptObjectState,
    type ScriptRaycastHit,
    type ScriptSnapshot,
    type ScriptSource,
    type ScriptValue,
    type ScriptVec3,
} from './protocol';

type ScriptCompiler = Pick<typeof import('@babel/standalone'), 'transform'>;
type AnyCallback = (...args: unknown[]) => unknown;
type SetTransformCommand = Extract<ScriptCommand, { type: 'setTransform' }>;
type TransformField = 'position' | 'rotation' | 'scale';

/** A bus playSound accepts. */
export type ScriptSoundBus = NonNullable<Extract<ScriptCommand, { type: 'playSound' }>['bus']>;

/** Every callback a script may define. */
export const SCRIPT_CALLBACK_NAMES = ['onStart', 'onTriggerEnter', 'onTriggerExit', 'onAnimNotify', 'onTimelineEvent', 'onNetEvent', 'onSpawned', 'onUpdate'] as const;
export type ScriptCallbackName = typeof SCRIPT_CALLBACK_NAMES[number];

/** Compiled scripts call `__auvraScriptGuard.tick()` on every loop iteration and function entry. */
export const SCRIPT_GUARD_IDENTIFIER = '__auvraScriptGuard';

const SOUND_BUSES: readonly ScriptSoundBus[] = ['master', 'music', 'sfx', 'ui'];
const MAX_ID_CHARS = 256;
const MAX_VARIABLE_STRING_CHARS = 4096;
const MAX_LOG_CHARS = 1024;
const MAX_ERROR_CHARS = 1024;
const MAX_PENDING_ERRORS = 256;
const MAX_PENDING_SPAWNS = 4096;
// Mirrors NET_LIMITS.maxEventNameLength (runtime/net/protocol.ts); this file stays free of runtime imports.
const MAX_NET_EVENT_NAME = 64;
// Room a frame message keeps for its envelope around the command list.
const MESSAGE_ENVELOPE_BYTES = 1024;
const CALLBACK_EXPORTS = SCRIPT_CALLBACK_NAMES
    .map(name => `${name}: typeof ${name} === 'function' ? ${name} : undefined`)
    .join(', ');
// Captured when this module loads, before the sandbox frame removes the global Function constructor.
const NativeFunction = Function;
const encoder = new TextEncoder();

/** An error a script raised. A failing callback reports once and is then disabled. */
export interface ScriptError {
    scriptId: string;
    message: string;
}

/** A live view of one level object; reads reflect the current frame, including changes made in it. */
export interface ObjectHandle {
    readonly id: string;
    readonly name: string;
    /** False once the object has left the world or was destroyed this frame; setters then do nothing. */
    readonly exists: boolean;
    /** Copies, local to the parent like LevelObject; rotation is Euler XYZ radians. */
    readonly position: ScriptVec3;
    readonly rotation: ScriptVec3;
    readonly scale: ScriptVec3;
    readonly visible: boolean;
    /** Each setter takes a vector or three numbers. */
    setPosition(x: number | ScriptVec3, y?: number, z?: number): void;
    setRotation(x: number | ScriptVec3, y?: number, z?: number): void;
    setScale(x: number | ScriptVec3, y?: number, z?: number): void;
    translate(dx: number | ScriptVec3, dy?: number, dz?: number): void;
    setVisible(visible: boolean): void;
    /** Impulses issued in one frame add up. */
    applyImpulse(x: number | ScriptVec3, y?: number, z?: number): void;
    destroy(): void;
}

/** Input actions as of the current snapshot; unknown actions read as released. */
export interface ScriptInput {
    isDown(action: string): boolean;
    wasPressed(action: string): boolean;
    wasReleased(action: string): boolean;
    /** Axis value (-1..1) for axis actions, 1/0 for buttons. */
    value(action: string): number;
}

/** Level variables; a set is visible to every script for the rest of the frame. */
export interface ScriptVariables {
    get(name: string): ScriptValue | undefined;
    set(name: string, value: ScriptValue): void;
}

/** A raycast answer, with a handle for the object it hit (null when it is gone or was no object). */
export interface ScriptRaycastResult extends ScriptRaycastHit {
    object: ObjectHandle | null;
}

/** ctx.net. In a single-player game connected() is false, isHost() true and send() does nothing. */
export interface ScriptNet {
    connected(): boolean;
    /** The host runs the authoritative game logic; the others follow it. */
    isHost(): boolean;
    selfId(): string | null;
    peers(): { id: string; name: string }[];
    /** Sends an event to every other player, or only to `toPeerId`; they get it in onNetEvent. */
    send(name: string, payload?: ScriptNetPayload, toPeerId?: string): void;
}

/** What every callback receives first. One context per script, kept for its lifetime. */
export interface ScriptContext {
    /** The object the script component is attached to. */
    readonly self: ObjectHandle;
    /** The first existing object with this name. */
    find(name: string): ObjectHandle | null;
    get(id: string): ObjectHandle | null;
    all(): ObjectHandle[];
    readonly player: { position: ScriptVec3; rotation: ScriptVec3 } | null;
    readonly input: ScriptInput;
    readonly vars: ScriptVariables;
    /** Seconds since the play session started, and since the previous frame. */
    readonly time: number;
    readonly delta: number;
    readonly frame: number;
    /** Returns the request id that onSpawned receives once the prefab is placed. */
    spawn(prefabId: string, position: ScriptVec3): string;
    /** Returns the request id; the answer is readable with raycastResult during the next frame. The script's own object is ignored. */
    raycast(origin: ScriptVec3, direction: ScriptVec3, maxDistance: number): string;
    /** null: the ray hit nothing; undefined: no answer for this request in the current frame. */
    raycastResult(requestId: string): ScriptRaycastResult | null | undefined;
    playSound(audioId: string, bus?: ScriptSoundBus): void;
    playPlayerAnimation(clipName: string, maskBone?: string): void;
    openLevel(levelId: string): void;
    /** Multiplayer: who is here, who hosts, and events to the other players. */
    readonly net: ScriptNet;
    log(...values: unknown[]): void;
    warn(...values: unknown[]): void;
    error(...values: unknown[]): void;
    /** The script's own storage, kept across frames until the script is reloaded. */
    readonly state: Record<string, unknown>;
}

/** The callbacks a script may define as top-level functions; every one is optional. */
export interface ScriptCallbacks {
    onStart?(ctx: ScriptContext): void;
    onUpdate?(ctx: ScriptContext, dt: number): void;
    /** Fires for scripts on the trigger's object; other is null when it is not a level object ('player'). */
    onTriggerEnter?(ctx: ScriptContext, other: ObjectHandle | null, otherId: string): void;
    onTriggerExit?(ctx: ScriptContext, other: ObjectHandle | null, otherId: string): void;
    /** Fires for scripts on the animated object; a notify from anything that is not a level object (the player, enemies) reaches every script. */
    onAnimNotify?(ctx: ScriptContext, name: string, source: string | null): void;
    /** Fires for every script when a timeline's event track crosses a key. */
    onTimelineEvent?(ctx: ScriptContext, name: string, timelineObjectId: string): void;
    /** Fires for every script when another player's ctx.net.send arrives. */
    onNetEvent?(ctx: ScriptContext, name: string, payload: ScriptNetPayload, fromPeerId: string): void;
    /** Fires for the script that requested the spawn. */
    onSpawned?(ctx: ScriptContext, requestId: string, objectIds: string[]): void;
}

export interface ScriptHostOptions {
    /** Bindings every compiled script sees, such as the execution guard; script source may not name them. */
    scope?: Readonly<Record<string, unknown>>;
    /** Runs one callback call or one script's top-level code, e.g. to give each its own execution budget. */
    invoke?: (call: () => void) => void;
}

export interface ScriptHost {
    /**
     * Makes `scripts` the running set against `snapshot`. A script already loaded with the same id,
     * object and source keeps running with its state; every other one is compiled, evaluated and,
     * when its object is in the snapshot, started. Returns the errors raised while loading.
     */
    load(scripts: ScriptSource[], compile: (source: string) => string, snapshot: ScriptSnapshot): ScriptError[];
    /** Runs one frame against `snapshot` and returns the commands issued since the last frame or flush. */
    frame(snapshot: ScriptSnapshot): ScriptCommand[];
    /** Returns the commands issued outside a frame (by onStart during load, or by script timers). */
    flush(): ScriptCommand[];
    /** Returns and forgets the errors raised since the last call, other than those load returned. */
    errors(): ScriptError[];
    /** Stops every script and forgets all state. */
    unload(): void;
}

interface ObjectView {
    id: string;
    name: string;
    parentId: string | null;
    position: ScriptVec3;
    rotation: ScriptVec3;
    scale: ScriptVec3;
    visible: boolean;
    destroyed: boolean;
}

interface World {
    snapshot: ScriptSnapshot;
    views: Map<string, ObjectView>;
    byName: Map<string, ObjectView[]> | null;
    variables: Map<string, ScriptValue>;
}

interface ScriptRecord {
    id: string;
    objectId: string;
    source: string;
    callbacks: Partial<Record<ScriptCallbackName, AnyCallback>>;
    disabled: Set<ScriptCallbackName>;
    started: boolean;
    /** False once the script was unloaded or replaced; its context and handles then do nothing. */
    live: boolean;
    limitReported: boolean;
    handles: Map<string, ObjectHandle>;
}

interface LoadedScript extends ScriptRecord {
    context: ScriptContext;
}

const EMPTY_SNAPSHOT: ScriptSnapshot = {
    frame: 0, time: 0, delta: 0, objects: [], player: null, input: {}, variables: {}, events: [], raycasts: {},
    net: { connected: false, isHost: true, selfId: null, peers: [] },
};

const isNetPeer = (value: unknown): boolean => isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string';
const isNetState = (value: unknown): boolean => isRecord(value) && typeof value.connected === 'boolean' && typeof value.isHost === 'boolean'
    && (value.selfId === null || typeof value.selfId === 'string') && Array.isArray(value.peers) && value.peers.every(isNetPeer);
const isNetScalar = (value: unknown): boolean => typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
/** A ctx.net payload: a value, a list of values, a flat object of values, or null. */
export const isScriptNetPayload = (value: unknown): value is ScriptNetPayload => value === null || isNetScalar(value)
    || (Array.isArray(value) && value.every(isNetScalar))
    || (isRecord(value) && Object.values(value).every(isNetScalar));

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const copy = (vector: ScriptVec3): ScriptVec3 => [vector[0], vector[1], vector[2]];
const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

const createWorld = (snapshot: ScriptSnapshot): World => ({
    snapshot,
    views: new Map(snapshot.objects.map(object => [object.id, {
        id: object.id,
        name: object.name,
        parentId: object.parentId,
        position: copy(object.position),
        rotation: copy(object.rotation),
        scale: copy(object.scale),
        visible: object.visible,
        destroyed: false,
    }])),
    byName: null,
    variables: new Map(Object.entries(snapshot.variables)),
});

const missingView = (id: string): ObjectView => ({
    id, name: '', parentId: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], visible: false, destroyed: true,
});

const readVec3 = (label: string, x: unknown, y?: unknown, z?: unknown): ScriptVec3 => {
    const values: unknown[] = Array.isArray(x) ? x : [x, y, z];
    if (values.length !== 3 || !values.every(isFiniteNumber)) throw new TypeError(`${label} expects three finite numbers`);
    return [values[0] as number, values[1] as number, values[2] as number];
};

const readId = (label: string, value: unknown): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_CHARS) {
        throw new TypeError(`${label} expects a name of 1 to ${MAX_ID_CHARS} characters`);
    }
    return value;
};

const readValue = (value: unknown): ScriptValue => {
    if (isFiniteNumber(value) || typeof value === 'boolean') return value;
    if (typeof value === 'string' && value.length <= MAX_VARIABLE_STRING_CHARS) return value;
    throw new TypeError(`vars.set expects a finite number, a boolean or a string of at most ${MAX_VARIABLE_STRING_CHARS} characters`);
};

// An error's getters are script code; when one throws, the error is described generically.
const describeError = (error: unknown): string => {
    try {
        if (error instanceof Error) {
            const message = typeof error.message === 'string' ? error.message : '';
            const name = typeof error.name === 'string' && error.name !== 'Error' ? error.name : '';
            return truncate(name && message ? `${name}: ${message}` : name || message || 'unknown error', MAX_ERROR_CHARS);
        }
        if (typeof error === 'string') return truncate(error, MAX_ERROR_CHARS);
        if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint' || error == null) return String(error);
    } catch {
        // Falls through: the error's own getters threw.
    }
    return 'unknown error';
};

// The line of the innermost frame in evaluated code: V8 writes "<anonymous>:L:C", Gecko "> Function:L:C".
const stackLine = (error: unknown): number | null => {
    try {
        const stack = error instanceof Error ? error.stack : undefined;
        const match = typeof stack === 'string' ? /(?:<anonymous>|> Function):(\d+):\d+/.exec(stack) : null;
        return match ? Number(match[1]) : null;
    } catch {
        return null;
    }
};

const formatValue = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return describeError(value);
    if (typeof value === 'function') return '[function]';
    if (value === null || typeof value !== 'object') return String(value);
    try {
        return JSON.stringify(value) ?? Object.prototype.toString.call(value);
    } catch {
        return Object.prototype.toString.call(value);
    }
};

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isVec3 = (value: unknown): value is ScriptVec3 => Array.isArray(value) && value.length === 3 && value.every(item => typeof item === 'number');
const everyValue = (value: unknown, check: (item: unknown) => boolean): boolean => isRecord(value) && Object.values(value).every(check);

const isObjectState = (value: unknown): value is ScriptObjectState => isRecord(value)
    && typeof value.id === 'string' && typeof value.name === 'string'
    && isVec3(value.position) && isVec3(value.rotation) && isVec3(value.scale)
    && (value.parentId === null || typeof value.parentId === 'string') && typeof value.visible === 'boolean';

const isInputAction = (value: unknown): value is ScriptInputAction => isRecord(value)
    && typeof value.down === 'boolean' && typeof value.pressed === 'boolean'
    && typeof value.released === 'boolean' && typeof value.value === 'number';

const isScriptValue = (value: unknown): value is ScriptValue => typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string';

const isScriptEvent = (value: unknown): value is ScriptEvent => {
    if (!isRecord(value)) return false;
    switch (value.type) {
        case 'triggerEnter':
        case 'triggerExit':
            return typeof value.triggerId === 'string' && typeof value.otherId === 'string';
        case 'animNotify':
            return typeof value.name === 'string' && (value.source === null || typeof value.source === 'string');
        case 'timelineEvent':
            return typeof value.name === 'string' && typeof value.timelineObjectId === 'string';
        case 'netEvent':
            return typeof value.name === 'string' && typeof value.from === 'string' && isScriptNetPayload(value.payload);
        case 'spawned':
            return typeof value.requestId === 'string' && Array.isArray(value.objectIds) && value.objectIds.every(id => typeof id === 'string');
        default:
            return false;
    }
};

const isRaycastHit = (value: unknown): value is ScriptRaycastHit | null => value === null || (isRecord(value)
    && (value.objectId === null || typeof value.objectId === 'string')
    && isVec3(value.point) && isVec3(value.normal) && typeof value.distance === 'number');

/** Whether a message's snapshot has the shape the host reads; values are not range checked. */
export const isScriptSnapshot = (value: unknown): value is ScriptSnapshot => isRecord(value)
    && typeof value.frame === 'number' && typeof value.time === 'number' && typeof value.delta === 'number'
    && Array.isArray(value.objects) && value.objects.every(isObjectState)
    && (value.player === null || (isRecord(value.player) && isVec3(value.player.position) && isVec3(value.player.rotation)))
    && everyValue(value.input, isInputAction) && everyValue(value.variables, isScriptValue)
    && Array.isArray(value.events) && value.events.every(isScriptEvent)
    && everyValue(value.raycasts, isRaycastHit)
    && isNetState(value.net);

/** Whether a message's script entry is exactly { id, objectId, source } with non-empty ids. */
export const isScriptSource = (value: unknown): value is ScriptSource => isRecord(value)
    && Object.keys(value).length === 3
    && typeof value.id === 'string' && value.id.length > 0
    && typeof value.objectId === 'string' && value.objectId.length > 0
    && typeof value.source === 'string';

// Scripts are self-contained: callbacks are found by name, so `export` on a declaration is dropped and
// anything that would load another module is a compile error.
const moduleSyntaxPlugin = () => ({
    name: 'auvra-script-module-syntax',
    visitor: {
        Program(path: any) {
            for (const statement of path.get('body')) {
                if (statement.isImportDeclaration()) {
                    if (statement.node.importKind !== 'type') throw statement.buildCodeFrameError('Scripts cannot import modules');
                    statement.remove();
                } else if (statement.isExportNamedDeclaration()) {
                    const { declaration, specifiers, source } = statement.node;
                    if (declaration) {
                        statement.replaceWith(declaration);
                    } else if (!source && specifiers.every((specifier: any) => specifier.type === 'ExportSpecifier' && specifier.exported.name === specifier.local.name)) {
                        statement.remove();
                    } else {
                        throw statement.buildCodeFrameError('Scripts cannot re-export or rename bindings');
                    }
                } else if (statement.isExportDefaultDeclaration() || statement.isExportAllDeclaration() || statement.isTSExportAssignment()) {
                    throw statement.buildCodeFrameError('Scripts define callbacks by name and cannot have a default or module export');
                } else if (statement.isTSImportEqualsDeclaration() && statement.node.moduleReference.type === 'TSExternalModuleReference') {
                    throw statement.buildCodeFrameError('Scripts cannot import modules');
                }
            }
        },
        CallExpression(path: any) {
            if (path.get('callee').isImport()) throw path.buildCodeFrameError('Scripts cannot import modules');
        },
        MetaProperty(path: any) {
            if (path.node.meta.name === 'import') throw path.buildCodeFrameError('Scripts cannot use import.meta');
        },
    },
});

// As for HUD code: every loop and function body receives a guard tick, so the sandbox can stop
// infinite loops and runaway recursion. Object and class methods are bodies too.
const boundedExecutionPlugin = ({ types: t }: any) => {
    const tick = () => t.expressionStatement(
        t.callExpression(
            t.memberExpression(t.identifier(SCRIPT_GUARD_IDENTIFIER), t.identifier('tick')),
            [],
        ),
    );
    const guardBody = (node: any): any => {
        if (t.isBlockStatement(node)) {
            node.body.unshift(tick());
            return node;
        }
        // A concise arrow body is an expression, the arrow's return value.
        if (t.isExpression(node)) return t.blockStatement([tick(), t.returnStatement(node)]);
        return t.blockStatement([tick(), node]);
    };
    const guard = (path: any) => {
        path.node.body = guardBody(path.node.body);
        if (path.isArrowFunctionExpression()) path.node.expression = false;
    };
    return {
        name: 'auvra-script-execution-budget',
        visitor: {
            'ForStatement|ForInStatement|ForOfStatement|WhileStatement|DoWhileStatement': guard,
            'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ObjectMethod|ClassMethod|ClassPrivateMethod': guard,
        },
    };
};

/**
 * Compiles one script's TypeScript or JavaScript source to plain JavaScript whose loops and
 * functions tick `__auvraScriptGuard`. Lines are kept, so runtime errors name the source line.
 * Throws an Error carrying Babel's message and code frame when the source does not compile.
 */
export const compileScriptSource = (source: string, compiler: ScriptCompiler): string => {
    let code: string | null | undefined;
    try {
        code = compiler.transform(source, {
            filename: 'x.ts',
            sourceType: 'module',
            presets: ['typescript'],
            plugins: [moduleSyntaxPlugin, boundedExecutionPlugin],
            retainLines: true,
            comments: false,
        }).code;
    } catch (error) {
        const message = error instanceof Error ? error.message.replace(/^\/?x\.ts: /, '') : 'the source could not be compiled';
        throw new Error(message);
    }
    if (typeof code !== 'string') throw new Error('the source compiled to nothing');
    return code;
};

/** Creates the host that runs one play session's scripts. See ScriptHost. */
export const createScriptHost = (options: ScriptHostOptions = {}): ScriptHost => {
    const scope = options.scope ?? {};
    const scopeNames = Object.keys(scope);
    const scopeValues = scopeNames.map(name => scope[name]);
    const invoke = options.invoke ?? ((call: () => void) => { call(); });

    let world = createWorld(EMPTY_SNAPSHOT);
    let scripts: LoadedScript[] = [];
    let outbox: ScriptCommand[] = [];
    let owners: ScriptRecord[] = [];
    let merged = new Map<string, ScriptCommand>();
    let pendingErrors: ScriptError[] = [];
    let loadErrors: ScriptError[] | null = null;
    let requestCount = 0;
    let lineOffset: number | null | undefined;
    const pendingSpawns = new Map<string, ScriptRecord>();

    // Script code is the body of a strict function that returns its callbacks; the scope bindings
    // are that function's parameters.
    const evaluate = (code: string): unknown => {
        const body = `'use strict';\nreturn (function () {\n${code}\n;return { ${CALLBACK_EXPORTS} };\n});`;
        return new NativeFunction(...scopeNames, body)(...scopeValues);
    };

    // Maps an error's stack line in evaluated code back to the script line, calibrated once with a
    // probe because engines number the lines of a Function body differently.
    const scriptLine = (error: unknown): number | null => {
        if (lineOffset === undefined) {
            lineOffset = null;
            try {
                (evaluate('throw new Error();') as () => void)();
            } catch (probe) {
                const probeLine = stackLine(probe);
                lineOffset = probeLine === null ? null : probeLine - 1;
            }
        }
        const line = stackLine(error);
        return lineOffset === null || line === null || line <= lineOffset ? null : line - lineOffset;
    };

    const report = (scriptId: string, message: string): void => {
        const target = loadErrors ?? pendingErrors;
        if (target.length < MAX_PENDING_ERRORS) target.push({ scriptId, message: truncate(message, MAX_ERROR_CHARS) });
    };

    const reportLimit = (record: ScriptRecord, message: string): void => {
        if (record.limitReported) return;
        record.limitReported = true;
        report(record.id, message);
    };

    const failureMessage = (error: unknown): string => {
        const line = scriptLine(error);
        return `${describeError(error)}${line === null ? '' : ` (line ${line})`}`;
    };

    const fail = (record: ScriptRecord, name: ScriptCallbackName, error: unknown): void => {
        if (!record.live || record.disabled.has(name)) return;
        record.disabled.add(name);
        report(record.id, `${name} failed and is disabled: ${failureMessage(error)}`);
    };

    const queue = (record: ScriptRecord, command: ScriptCommand, key?: string): boolean => {
        if (!record.live) return false;
        if (outbox.length >= SCRIPT_LIMITS.maxCommandsPerFrame) {
            reportLimit(record, `Scripts issued more than ${SCRIPT_LIMITS.maxCommandsPerFrame} commands in one frame; the rest were dropped`);
            return false;
        }
        outbox.push(command);
        owners.push(record);
        if (key) merged.set(key, command);
        return true;
    };

    // One setTransform per object per frame carries the latest value of every field set.
    const queueTransform = (record: ScriptRecord, objectId: string, field: TransformField, value: ScriptVec3): void => {
        const pending = merged.get(`transform:${objectId}`);
        if (pending?.type === 'setTransform') {
            pending[field] = copy(value);
            return;
        }
        const command: SetTransformCommand = { type: 'setTransform', objectId };
        command[field] = copy(value);
        queue(record, command, `transform:${objectId}`);
    };

    // Returns the commands so far, within the message size limit, and starts a new batch.
    const takeOutbox = (): ScriptCommand[] => {
        let commands = outbox;
        const commandOwners = owners;
        outbox = [];
        owners = [];
        merged = new Map();
        const budget = SCRIPT_LIMITS.maxMessageBytes - MESSAGE_ENVELOPE_BYTES;
        // UTF-8 needs at most three bytes per UTF-16 unit, so most batches skip the exact count.
        if (JSON.stringify(commands).length * 3 <= budget) return commands;
        let used = 2;
        let kept = 0;
        for (; kept < commands.length; kept += 1) {
            const size = encoder.encode(JSON.stringify(commands[kept])).byteLength + 1;
            if (used + size > budget) break;
            used += size;
        }
        if (kept < commands.length) {
            reportLimit(commandOwners[kept], `Scripts issued more than ${SCRIPT_LIMITS.maxMessageBytes} bytes of commands in one frame; the rest were dropped`);
            commands = commands.slice(0, kept);
        }
        return commands;
    };

    const objectExists = (id: string): boolean => {
        const view = world.views.get(id);
        return !!view && !view.destroyed;
    };

    const createHandle = (record: ScriptRecord, id: string): ObjectHandle => {
        let last = world.views.get(id) ?? missingView(id);
        const view = (): ObjectView => {
            const current = world.views.get(id);
            if (current) last = current;
            return last;
        };
        const writable = (): ObjectView | null => {
            const current = world.views.get(id);
            return current && !current.destroyed && record.live ? current : null;
        };
        const setField = (field: TransformField, value: ScriptVec3): void => {
            const current = writable();
            if (!current) return;
            current[field] = value;
            queueTransform(record, id, field, value);
        };
        return Object.freeze({
            id,
            get name() { return view().name; },
            get exists() { return objectExists(id); },
            get position() { return copy(view().position); },
            get rotation() { return copy(view().rotation); },
            get scale() { return copy(view().scale); },
            get visible() { return view().visible; },
            setPosition: (x: number | ScriptVec3, y?: number, z?: number) => setField('position', readVec3('setPosition', x, y, z)),
            setRotation: (x: number | ScriptVec3, y?: number, z?: number) => setField('rotation', readVec3('setRotation', x, y, z)),
            setScale: (x: number | ScriptVec3, y?: number, z?: number) => setField('scale', readVec3('setScale', x, y, z)),
            translate: (dx: number | ScriptVec3, dy?: number, dz?: number) => {
                const offset = readVec3('translate', dx, dy, dz);
                const current = writable();
                if (!current) return;
                setField('position', [current.position[0] + offset[0], current.position[1] + offset[1], current.position[2] + offset[2]]);
            },
            setVisible: (visible: boolean) => {
                if (typeof visible !== 'boolean') throw new TypeError('setVisible expects true or false');
                const current = writable();
                if (!current) return;
                current.visible = visible;
                const pending = merged.get(`visible:${id}`);
                if (pending?.type === 'setVisible') pending.visible = visible;
                else queue(record, { type: 'setVisible', objectId: id, visible }, `visible:${id}`);
            },
            applyImpulse: (x: number | ScriptVec3, y?: number, z?: number) => {
                const impulse = readVec3('applyImpulse', x, y, z);
                if (!writable()) return;
                const pending = merged.get(`impulse:${id}`);
                if (pending?.type === 'applyImpulse') {
                    pending.impulse = [pending.impulse[0] + impulse[0], pending.impulse[1] + impulse[1], pending.impulse[2] + impulse[2]];
                } else {
                    queue(record, { type: 'applyImpulse', objectId: id, impulse }, `impulse:${id}`);
                }
            },
            destroy: () => {
                const current = writable();
                if (!current) return;
                current.destroyed = true;
                queue(record, { type: 'destroy', objectId: id });
            },
        });
    };

    const handleFor = (record: ScriptRecord, id: string): ObjectHandle => {
        let handle = record.handles.get(id);
        if (handle) return handle;
        // Handles of objects that left the world are dropped from the cache once it outgrows the
        // world; a script that kept one still holds a working handle.
        if (record.handles.size > 2 * world.views.size + 64) {
            for (const known of record.handles.keys()) if (!world.views.has(known)) record.handles.delete(known);
        }
        handle = createHandle(record, id);
        record.handles.set(id, handle);
        return handle;
    };

    const liveHandle = (record: ScriptRecord, id: string): ObjectHandle | null => (objectExists(id) ? handleFor(record, id) : null);

    const log = (record: ScriptRecord, level: 'info' | 'warn' | 'error', values: unknown[]): void => {
        if (!record.live) return;
        let message = '';
        for (const value of values) {
            message += `${message ? ' ' : ''}${formatValue(value)}`;
            if (message.length > MAX_LOG_CHARS) break;
        }
        queue(record, { type: 'log', scriptId: record.id, level, message: truncate(message, MAX_LOG_CHARS) });
    };

    const nextRequestId = (kind: string): string => {
        requestCount += 1;
        return `${kind}-${requestCount}`;
    };

    const inputAction = (action: string): ScriptInputAction | undefined => {
        const actions = world.snapshot.input;
        return typeof action === 'string' && Object.hasOwn(actions, action) ? actions[action] : undefined;
    };

    const input: ScriptInput = Object.freeze({
        isDown: (action: string) => inputAction(action)?.down === true,
        wasPressed: (action: string) => inputAction(action)?.pressed === true,
        wasReleased: (action: string) => inputAction(action)?.released === true,
        value: (action: string) => inputAction(action)?.value ?? 0,
    });

    const createContext = (record: ScriptRecord): ScriptContext => {
        const vars: ScriptVariables = Object.freeze({
            get: (name: string) => (typeof name === 'string' ? world.variables.get(name) : undefined),
            set: (name: string, value: ScriptValue) => {
                const key = readId('vars.set', name);
                const checked = readValue(value);
                if (!record.live) return;
                world.variables.set(key, checked);
                const pending = merged.get(`variable:${key}`);
                if (pending?.type === 'setVariable') pending.value = checked;
                else queue(record, { type: 'setVariable', name: key, value: checked }, `variable:${key}`);
            },
        });
        return Object.freeze({
            get self() { return handleFor(record, record.objectId); },
            find: (name: string) => {
                if (typeof name !== 'string') return null;
                if (!world.byName) {
                    const byName = new Map<string, ObjectView[]>();
                    for (const view of world.views.values()) {
                        const named = byName.get(view.name);
                        if (named) named.push(view);
                        else byName.set(view.name, [view]);
                    }
                    world.byName = byName;
                }
                const match = world.byName.get(name)?.find(view => !view.destroyed);
                return match ? handleFor(record, match.id) : null;
            },
            get: (id: string) => (typeof id === 'string' ? liveHandle(record, id) : null),
            all: () => [...world.views.values()].filter(view => !view.destroyed).map(view => handleFor(record, view.id)),
            get player() {
                const player = world.snapshot.player;
                return player ? { position: copy(player.position), rotation: copy(player.rotation) } : null;
            },
            input,
            vars,
            get time() { return world.snapshot.time; },
            get delta() { return world.snapshot.delta; },
            get frame() { return world.snapshot.frame; },
            spawn: (prefabId: string, position: ScriptVec3) => {
                const prefab = readId('spawn', prefabId);
                const at = readVec3('spawn', position);
                const requestId = nextRequestId('spawn');
                if (queue(record, { type: 'spawnPrefab', requestId, prefabId: prefab, position: at })) {
                    pendingSpawns.set(requestId, record);
                    if (pendingSpawns.size > MAX_PENDING_SPAWNS) {
                        const oldest = pendingSpawns.keys().next().value;
                        if (oldest !== undefined) pendingSpawns.delete(oldest);
                    }
                }
                return requestId;
            },
            raycast: (origin: ScriptVec3, direction: ScriptVec3, maxDistance: number) => {
                const from = readVec3('raycast origin', origin);
                const toward = readVec3('raycast direction', direction);
                if (toward[0] === 0 && toward[1] === 0 && toward[2] === 0) throw new TypeError('raycast direction must not be zero');
                if (!isFiniteNumber(maxDistance) || maxDistance <= 0) throw new TypeError('raycast maxDistance must be a positive number');
                const requestId = nextRequestId('ray');
                queue(record, { type: 'raycast', requestId, origin: from, direction: toward, maxDistance, excludeObjectId: record.objectId });
                return requestId;
            },
            raycastResult: (requestId: string) => {
                const raycasts = world.snapshot.raycasts;
                if (typeof requestId !== 'string' || !Object.hasOwn(raycasts, requestId)) return undefined;
                const hit = raycasts[requestId];
                if (!hit) return null;
                return {
                    objectId: hit.objectId,
                    object: hit.objectId === null ? null : liveHandle(record, hit.objectId),
                    point: copy(hit.point),
                    normal: copy(hit.normal),
                    distance: hit.distance,
                };
            },
            playSound: (audioId: string, bus?: ScriptSoundBus) => {
                const audio = readId('playSound', audioId);
                if (bus !== undefined && !SOUND_BUSES.includes(bus)) throw new TypeError(`playSound bus must be one of ${SOUND_BUSES.join(', ')}`);
                queue(record, bus === undefined ? { type: 'playSound', audioId: audio } : { type: 'playSound', audioId: audio, bus });
            },
            playPlayerAnimation: (clipName: string, maskBone?: string) => {
                const clip = readId('playPlayerAnimation', clipName);
                if (maskBone === undefined) queue(record, { type: 'playPlayerAnimation', clipName: clip });
                else queue(record, { type: 'playPlayerAnimation', clipName: clip, maskBone: readId('playPlayerAnimation mask bone', maskBone) });
            },
            openLevel: (levelId: string) => {
                queue(record, { type: 'openLevel', levelId: readId('openLevel', levelId) });
            },
            net: {
                connected: () => world.snapshot.net.connected,
                isHost: () => world.snapshot.net.isHost,
                selfId: () => world.snapshot.net.selfId,
                peers: () => world.snapshot.net.peers.map(peer => ({ ...peer })),
                send: (name: string, payload: ScriptNetPayload = null, toPeerId?: string) => {
                    const event = readId('net.send', name);
                    if (event.length > MAX_NET_EVENT_NAME) throw new TypeError(`net.send names are at most ${MAX_NET_EVENT_NAME} characters`);
                    if (!isScriptNetPayload(payload)) throw new TypeError('net.send payload must be a value, a list of values or a flat object of values');
                    const command: ScriptCommand = toPeerId === undefined
                        ? { type: 'netSend', name: event, payload: JSON.parse(JSON.stringify(payload)) as ScriptNetPayload }
                        : { type: 'netSend', name: event, payload: JSON.parse(JSON.stringify(payload)) as ScriptNetPayload, to: readId('net.send peer', toPeerId) };
                    queue(record, command);
                },
            },
            log: (...values: unknown[]) => log(record, 'info', values),
            warn: (...values: unknown[]) => log(record, 'warn', values),
            error: (...values: unknown[]) => log(record, 'error', values),
            state: {},
        });
    };

    // Runs one callback unless it is missing or disabled, or the script's object is gone. A throw, or
    // the rejection of the promise an async callback returns, disables that callback alone.
    const run = (record: LoadedScript, name: ScriptCallbackName, ...args: unknown[]): void => {
        const callback = record.callbacks[name];
        if (!callback || !record.live || record.disabled.has(name) || !objectExists(record.objectId)) return;
        try {
            invoke(() => {
                const result = callback(record.context, ...args);
                if (result instanceof Promise) result.catch((error: unknown) => fail(record, name, error));
            });
        } catch (error) {
            fail(record, name, error);
        }
    };

    const startScripts = (): void => {
        for (const record of scripts) {
            if (record.started || !objectExists(record.objectId)) continue;
            record.started = true;
            run(record, 'onStart');
        }
    };

    const dispatch = (event: ScriptEvent): void => {
        if (event.type === 'animNotify') {
            for (const record of scripts) {
                const reaches = event.source === null || !objectExists(event.source) || record.objectId === event.source;
                if (record.started && reaches) run(record, 'onAnimNotify', event.name, event.source);
            }
        } else if (event.type === 'timelineEvent') {
            for (const record of scripts) {
                if (record.started) run(record, 'onTimelineEvent', event.name, event.timelineObjectId);
            }
        } else if (event.type === 'netEvent') {
            for (const record of scripts) {
                if (record.started) run(record, 'onNetEvent', event.name, event.payload, event.from);
            }
        } else if (event.type === 'spawned') {
            const record = pendingSpawns.get(event.requestId);
            if (!record) return;
            pendingSpawns.delete(event.requestId);
            const loaded = scripts.find(script => script === record);
            if (loaded?.started) run(loaded, 'onSpawned', event.requestId, [...event.objectIds]);
        } else {
            const name = event.type === 'triggerEnter' ? 'onTriggerEnter' : 'onTriggerExit';
            for (const record of scripts) {
                if (record.started && record.objectId === event.triggerId) run(record, name, liveHandle(record, event.otherId), event.otherId);
            }
        }
    };

    const instantiate = (source: ScriptSource, compile: (source: string) => string): LoadedScript | null => {
        if (encoder.encode(source.source).byteLength > SCRIPT_LIMITS.maxSourceBytes) {
            report(source.id, `Script source is larger than ${SCRIPT_LIMITS.maxSourceBytes / 1024} KB`);
            return null;
        }
        const reserved = scopeNames.find(name => source.source.includes(name));
        if (reserved) {
            report(source.id, `Script source uses the reserved name ${reserved}`);
            return null;
        }
        let code: string;
        try {
            code = compile(source.source);
        } catch (error) {
            report(source.id, `Compile error: ${describeError(error)}`);
            return null;
        }
        let exported: unknown;
        try {
            const factory = evaluate(code) as () => unknown;
            invoke(() => { exported = factory(); });
        } catch (error) {
            report(source.id, `Script failed to load: ${failureMessage(error)}`);
            return null;
        }
        if (!isRecord(exported)) {
            report(source.id, 'Script failed to load: it did not finish evaluating');
            return null;
        }
        const callbacks: Partial<Record<ScriptCallbackName, AnyCallback>> = {};
        for (const name of SCRIPT_CALLBACK_NAMES) {
            const callback = exported[name];
            if (typeof callback === 'function') callbacks[name] = callback as AnyCallback;
        }
        if (Object.keys(callbacks).length === 0) report(source.id, `Script defines none of ${SCRIPT_CALLBACK_NAMES.join(', ')}`);
        const record: ScriptRecord = {
            id: source.id,
            objectId: source.objectId,
            source: source.source,
            callbacks,
            disabled: new Set(),
            started: false,
            live: true,
            limitReported: false,
            handles: new Map(),
        };
        return Object.assign(record, { context: createContext(record) });
    };

    return {
        load(sources, compile, snapshot) {
            const errors: ScriptError[] = [];
            loadErrors = errors;
            try {
                world = createWorld(snapshot);
                const previous = new Map(scripts.map(record => [record.id, record]));
                const next: LoadedScript[] = [];
                const seen = new Set<string>();
                for (const source of sources) {
                    if (seen.has(source.id)) {
                        report(source.id, 'Another script component has the same id');
                        continue;
                    }
                    seen.add(source.id);
                    if (next.length >= SCRIPT_LIMITS.maxScripts) {
                        report(source.id, `Only ${SCRIPT_LIMITS.maxScripts} scripts can run at once`);
                        continue;
                    }
                    const kept = previous.get(source.id);
                    if (kept && kept.objectId === source.objectId && kept.source === source.source) {
                        previous.delete(source.id);
                        next.push(kept);
                        continue;
                    }
                    const record = instantiate(source, compile);
                    if (record) next.push(record);
                }
                for (const dropped of previous.values()) dropped.live = false;
                scripts = next;
                startScripts();
            } finally {
                loadErrors = null;
            }
            return errors;
        },
        frame(snapshot) {
            world = createWorld(snapshot);
            startScripts();
            for (const event of snapshot.events) dispatch(event);
            for (const record of scripts) {
                if (record.started) run(record, 'onUpdate', snapshot.delta);
            }
            return takeOutbox();
        },
        flush: takeOutbox,
        errors() {
            const drained = pendingErrors;
            pendingErrors = [];
            return drained;
        },
        unload() {
            for (const record of scripts) record.live = false;
            scripts = [];
            pendingSpawns.clear();
            outbox = [];
            owners = [];
            merged = new Map();
            pendingErrors = [];
            world = createWorld(EMPTY_SNAPSHOT);
        },
    };
};
