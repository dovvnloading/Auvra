import * as THREE from 'three';
import { AUDIO_BUSES, type AudioBus } from '../../runtime/audioMixer';
import type { InputState } from '../../runtime/input';
import type { LevelVariablesStore } from '../../runtime/levelVariables';
import type { LevelObject } from '../../types';
import type { WorldSplineQuery } from '../../runtime/splineRegistry';
import type { FlowExecutionContext, FlowNode, FlowNodeDefinition, FlowPinDefinition } from './flow';

/**
 * WORLD NODES
 *
 * Executors for the Level Blueprint nodes that touch the running world: spawning prefabs,
 * reading and writing actor transforms, sound, impulses, raycasts, level variables, input,
 * random numbers, formatted printing, player animation and morph targets. They share the flow
 * nodes' executor contract and reach the world only through `ctx.services`, so play mode and
 * tests swap in their own services.
 *
 * Vectors travel as separate X/Y/Z Float pins (PinDataType has no vector type). Rotation pins
 * are degrees, matching the inspector; LevelObject stores radians. Transforms are the actor's
 * own (local to its parent, world space for root actors), the same space getObject returns and
 * setObjectTransform writes.
 *
 * Data outputs are latched in `nodeState.outputs` (read them with flowNodeOutputValue) and also
 * passed on `fire`. Pure nodes (definition.pure) have no exec pins: run the executor whenever
 * one of their outputs is read, then read the latched value.
 */

export type WorldNodeType =
    | 'SpawnPrefab'
    | 'GetActorTransform'
    | 'SetActorTransform'
    | 'PlaySound'
    | 'MakeNoise'
    | 'ApplyImpulse'
    | 'Raycast'
    | 'GetLevelVariable'
    | 'SetLevelVariable'
    | 'InputActionPressed'
    | 'RandomFloat'
    | 'RandomInt'
    | 'Print'
    | 'PlayPlayerAnimation'
    | 'SetMorphTarget'
    | 'DamagePlayer'
    | 'HealPlayer'
    | 'AddAmmo'
    | 'GiveWeapon'
    | 'GetPlayerHealth'
    | 'GetSplineLength'
    | 'GetSplinePoint'
    | 'FindClosestOnSpline';

export type Vec3 = [number, number, number];

export type WorldObjectTransform = Pick<LevelObject, 'id' | 'position' | 'rotation' | 'scale'>;

/** A live world-space pose, such as a simulated rigid body's; rotation is Euler XYZ radians. */
export interface WorldPose {
    position: Vec3;
    rotation: Vec3;
}

type ActorTransform = WorldObjectTransform & Partial<Pick<LevelObject, 'parentId'>>;

const composeMatrix = (position: Vec3, rotation: Vec3, scale: Vec3): THREE.Matrix4 => new THREE.Matrix4().compose(
    new THREE.Vector3(...position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),
    new THREE.Vector3(...scale),
);

/**
 * `object` with the position and rotation of a world-space `pose`, in the actor's own space: local
 * to its parent, unchanged for a root actor. Parents come from `getObject`; a missing parent or a
 * parent cycle ends the walk. The scale stays the object's own (a pose carries none).
 */
export const withWorldPose = <T extends ActorTransform>(object: T, pose: WorldPose, getObject: (id: string) => ActorTransform | null | undefined): T => {
    const parentWorld = new THREE.Matrix4();
    const seen = new Set([object.id]);
    for (let parent = object.parentId ? getObject(object.parentId) : null; parent && !seen.has(parent.id); parent = parent.parentId ? getObject(parent.parentId) : null) {
        seen.add(parent.id);
        parentWorld.premultiply(composeMatrix(parent.position, parent.rotation, parent.scale));
    }
    if (seen.size === 1) {
        return { ...object, position: [...pose.position] as Vec3, rotation: [...pose.rotation] as Vec3 };
    }
    const local = composeMatrix(pose.position, pose.rotation, [1, 1, 1]).premultiply(parentWorld.invert());
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    local.decompose(position, quaternion, new THREE.Vector3());
    const rotation = new THREE.Euler().setFromQuaternion(quaternion);
    return { ...object, position: position.toArray() as Vec3, rotation: [rotation.x, rotation.y, rotation.z] };
};

/** Mirrors usePhysicsQueries().raycast, so play mode can pass it straight through. */
export interface WorldRaycastHit {
    objectId: string | null;
    point: THREE.Vector3;
    normal: THREE.Vector3;
}

/** The id the player character goes by in Object pins, as in its trigger events and raycast hits. */
export const PLAYER_ACTOR_ID = 'player';

/** Play Player Animation's cross-fade into its clip when Blend In is blank, in seconds. */
export const DEFAULT_ANIMATION_BLEND_IN = 0.15;

/** How Play Player Animation plays a clip; a subset of the animation graph's montage options. */
export interface PlayAnimationOptions {
    /** Cross-fade into the clip, in seconds. */
    blendIn: number;
    /** Playback speed, above 0; 1 is the clip's own. */
    rate: number;
    /** Only this bone and its children play the clip; omitted plays it on the full body. */
    maskBone?: string;
    /** Add the clip's motion on top of the current pose instead of replacing it. */
    additive?: boolean;
}

/** What world nodes may do to the play session. Implementations must never write to the project. */
export interface WorldNodeServices {
    /** Instantiates a prefab in the session; returns the new object ids, root first. */
    spawnPrefab(prefabId: string, position: Vec3): string[];
    playSound(audioId: string, bus?: AudioBus): void;
    /** Makes a noise enemies within `radius` hear and come to look at. Absent: nobody hears it. */
    makeNoise?(position: Vec3, radius: number): void;
    getObject(id: string): WorldObjectTransform | null | undefined;
    setObjectTransform(id: string, partial: Partial<Pick<LevelObject, 'position' | 'rotation' | 'scale'>>): void;
    applyImpulse(id: string, impulse: Vec3): void;
    raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number): WorldRaycastHit | null;
    /** wasPressed (optional) reports a tap pressed and released between two runs, which isDown misses. */
    input: Pick<InputState, 'isDown'> & Partial<Pick<InputState, 'wasPressed'>>;
    vars: Pick<LevelVariablesStore, 'get' | 'set'>;
    /** Shows a Print node's message (play mode: a notification). */
    print(message: string): void;
    /** Plays a clip once over the player's animation graph; false when it cannot (unknown clip, no player). Absent: nothing plays. */
    playPlayerAnimation?(clipName: string, options: PlayAnimationOptions): boolean;
    /** Sets the weight of a named morph target on an actor's meshes; returns how many meshes have it. Absent: nothing changes. */
    setMorphTarget?(objectId: string, morph: string, weight: number): number;
    /** Hurts the player; false when there is no live player. Absent: nothing happens. */
    damagePlayer?(amount: number): boolean;
    /** Restores the player's health; false when full, dead or absent. */
    healPlayer?(amount: number): boolean;
    /** Adds rounds to a carried weapon's reserve (blank: the held one); false when it takes none. */
    addAmmo?(rounds: number, weapon: string): boolean;
    /** Gives the player a weapon by name or id (a magazine for one already carried); false when nothing changed. */
    giveWeapon?(weapon: string): boolean;
    /** The player's health and maximum; null without a player. */
    playerHealth?(): { health: number; max: number } | null;
    /** The spline of the object `objectId` (its Spline component), in world space; null when it has none. */
    spline?(objectId: string): WorldSplineQuery | null;
}

export interface WorldExecutionContext extends FlowExecutionContext {
    services: WorldNodeServices;
}

export type WorldNodeExecutor = (node: FlowNode, ctx: WorldExecutionContext) => void;

export interface WorldNodeDefinition extends Omit<FlowNodeDefinition, 'type'> {
    type: WorldNodeType;
    /** No exec pins: evaluated on demand when a connected node reads one of its outputs. */
    pure?: boolean;
    description?: string;
}

/** Positional format arguments a Print node offers: `{0}`, `{1}`, `{2}`. */
export const PRINT_FORMAT_ARGS = 3;

const exec = (name: string, direction: FlowPinDefinition['direction']): FlowPinDefinition =>
    ({ name, dataType: 'Exec', direction });

const input = (name: string, dataType: FlowPinDefinition['dataType']): FlowPinDefinition =>
    ({ name, dataType, direction: 'Input' });

const output = (name: string, dataType: FlowPinDefinition['dataType']): FlowPinDefinition =>
    ({ name, dataType, direction: 'Output' });

const AXES = ['X', 'Y', 'Z'] as const;

const vectorPins = (prefix: string, make: typeof input): FlowPinDefinition[] =>
    AXES.map(axis => make(`${prefix} ${axis}`, 'Float'));

const vectorDefaults = (prefix: string, value: Vec3): Record<string, number> =>
    Object.fromEntries(AXES.map((axis, i) => [`default_${prefix} ${axis}`, value[i]]));

const printArgName = (index: number) => `Arg ${index}`;

export const WORLD_NODE_DEFINITIONS: readonly WorldNodeDefinition[] = [
    {
        type: 'SpawnPrefab',
        title: 'Spawn Prefab',
        description: 'Places a prefab in the play session. Spawned Actor is its root object.',
        inputs: [exec('Exec', 'Input'), input('Prefab', 'String'), ...vectorPins('Position', input)],
        outputs: [exec('Out', 'Output'), output('Spawned Actor', 'Object')],
        data: { default_Prefab: '', ...vectorDefaults('Position', [0, 0, 0]) },
    },
    {
        type: 'GetActorTransform',
        title: 'Get Actor Transform',
        description: 'Position, rotation (degrees) and scale of an actor. Found is false for a missing actor.',
        pure: true,
        inputs: [input('Actor', 'Object')],
        outputs: [
            output('Found', 'Boolean'),
            ...vectorPins('Position', output),
            ...vectorPins('Rotation', output),
            ...vectorPins('Scale', output),
        ],
        data: { default_Actor: '' },
    },
    {
        type: 'SetActorTransform',
        title: 'Set Actor Transform',
        description: 'Moves an actor. Unconnected, blank axes keep their current value; rotation is in degrees.',
        inputs: [
            exec('Exec', 'Input'),
            input('Actor', 'Object'),
            ...vectorPins('Position', input),
            ...vectorPins('Rotation', input),
            ...vectorPins('Scale', input),
        ],
        outputs: [exec('Out', 'Output')],
        data: { default_Actor: '' },
    },
    {
        type: 'PlaySound',
        title: 'Play Sound',
        description: 'Plays an audio asset on a mixer bus (master, music, sfx or ui).',
        inputs: [exec('Exec', 'Input'), input('Sound', 'String'), input('Bus', 'String')],
        outputs: [exec('Out', 'Output')],
        data: { default_Sound: '', default_Bus: 'sfx' },
    },
    {
        type: 'MakeNoise',
        title: 'Make Noise',
        description: 'Makes a noise at a point: enemies within its radius hear it and come to look (an alarm, a thrown bottle, a door slamming). It plays no sound; add a Play Sound for that.',
        inputs: [exec('Exec', 'Input'), ...vectorPins('Position', input), input('Radius', 'Float')],
        outputs: [exec('Out', 'Output')],
        data: { ...vectorDefaults('Position', [0, 0, 0]), default_Radius: 20 },
    },
    {
        type: 'ApplyImpulse',
        title: 'Apply Impulse',
        description: "Pushes an actor's dynamic rigid body.",
        inputs: [exec('Exec', 'Input'), input('Actor', 'Object'), ...vectorPins('Impulse', input)],
        outputs: [exec('Out', 'Output')],
        data: { default_Actor: '', ...vectorDefaults('Impulse', [0, 0, 0]) },
    },
    {
        type: 'Raycast',
        title: 'Raycast',
        description: 'Casts a physics ray. Hit Actor is empty when the ray hits nothing or an untracked collider.',
        inputs: [
            exec('Exec', 'Input'),
            ...vectorPins('Origin', input),
            ...vectorPins('Direction', input),
            input('Max Distance', 'Float'),
        ],
        outputs: [
            exec('Out', 'Output'),
            output('Hit', 'Boolean'),
            output('Hit Actor', 'Object'),
            ...vectorPins('Hit Position', output),
            ...vectorPins('Hit Normal', output),
            output('Distance', 'Float'),
        ],
        data: { ...vectorDefaults('Origin', [0, 0, 0]), ...vectorDefaults('Direction', [0, -1, 0]), 'default_Max Distance': 100 },
    },
    {
        type: 'GetLevelVariable',
        title: 'Get Level Variable',
        description: 'Reads a level variable (number, boolean or text). Is Set is false for a variable that does not exist.',
        pure: true,
        inputs: [input('Name', 'String')],
        outputs: [output('Value', 'String'), output('Is Set', 'Boolean')],
        data: { default_Name: '' },
    },
    {
        type: 'SetLevelVariable',
        title: 'Set Level Variable',
        description: 'Writes a level variable (HUD bindings read it as vars.<name>). Success is false when the value does not fit the variable type.',
        inputs: [exec('Exec', 'Input'), input('Name', 'String'), input('Value', 'String')],
        outputs: [exec('Out', 'Output'), output('Success', 'Boolean')],
        data: { default_Name: '', default_Value: '' },
    },
    {
        type: 'InputActionPressed',
        title: 'Input Action',
        description: 'Run it every frame (e.g. from Event Tick): fires Pressed or Released when the action changed since its last run, then Out.',
        inputs: [exec('Exec', 'Input'), input('Action', 'String')],
        outputs: [exec('Pressed', 'Output'), exec('Released', 'Output'), exec('Out', 'Output'), output('Is Down', 'Boolean')],
        data: { default_Action: 'Jump' },
    },
    {
        type: 'RandomFloat',
        title: 'Random Float',
        description: 'A new random number in [Min, Max) every time it is read.',
        pure: true,
        inputs: [input('Min', 'Float'), input('Max', 'Float')],
        outputs: [output('Value', 'Float')],
        data: { default_Min: 0, default_Max: 1 },
    },
    {
        type: 'RandomInt',
        title: 'Random Integer',
        description: 'A new random integer from Min to Max (both included) every time it is read.',
        pure: true,
        inputs: [input('Min', 'Integer'), input('Max', 'Integer')],
        outputs: [output('Value', 'Integer')],
        data: { default_Min: 0, default_Max: 10 },
    },
    {
        type: 'Print',
        title: 'Print (Format)',
        description: 'Prints Format with {0}, {1} and {2} replaced by the matching Arg pins.',
        inputs: [
            exec('Exec', 'Input'),
            input('Format', 'String'),
            ...Array.from({ length: PRINT_FORMAT_ARGS }, (_, i) => input(printArgName(i), 'String')),
        ],
        outputs: [exec('Out', 'Output'), output('Message', 'String')],
        data: { default_Format: 'Hello {0}' },
    },
    {
        type: 'PlayPlayerAnimation',
        title: 'Play Player Animation',
        description: "Plays a clip once over the player's animation graph, then blends back. Mask Bone limits it to that bone and its children (e.g. Spine); empty plays it on the full body. Additive adds the clip's motion to the pose instead of replacing it (a flinch while running). Played is false when the clip cannot play.",
        inputs: [exec('Exec', 'Input'), input('Clip', 'String'), input('Mask Bone', 'String'), input('Blend In', 'Float'), input('Rate', 'Float'), input('Additive', 'Boolean')],
        outputs: [exec('Out', 'Output'), output('Played', 'Boolean')],
        data: { default_Clip: '', 'default_Mask Bone': '', 'default_Blend In': DEFAULT_ANIMATION_BLEND_IN, default_Rate: 1, default_Additive: false },
    },
    {
        type: 'DamagePlayer',
        title: 'Damage Player',
        description: 'Hurts the player by Amount, as a hit would: the hit reaction plays, and at 0 health the game is over. Damaged is false without a live player.',
        inputs: [exec('Exec', 'Input'), input('Amount', 'Float')],
        outputs: [exec('Out', 'Output'), output('Damaged', 'Boolean')],
        data: { default_Amount: 10 },
    },
    {
        type: 'HealPlayer',
        title: 'Heal Player',
        description: "Restores up to Amount of the player's health, never past the maximum. Healed is false when the player is already at full health or dead.",
        inputs: [exec('Exec', 'Input'), input('Amount', 'Float')],
        outputs: [exec('Out', 'Output'), output('Healed', 'Boolean')],
        data: { default_Amount: 25 },
    },
    {
        type: 'AddAmmo',
        title: 'Add Ammo',
        description: "Adds Rounds to the reserve of a weapon the player carries, by name; blank is the held weapon. Added is false for a weapon the player does not carry or that never runs out.",
        inputs: [exec('Exec', 'Input'), input('Rounds', 'Integer'), input('Weapon', 'String')],
        outputs: [exec('Out', 'Output'), output('Added', 'Boolean')],
        data: { default_Rounds: 30, default_Weapon: '' },
    },
    {
        type: 'GiveWeapon',
        title: 'Give Weapon',
        description: "Gives the player one of their blueprint's weapons, by name, and puts it in their hands. A weapon they already carry gets a magazine of rounds instead. Given is false when nothing changed.",
        inputs: [exec('Exec', 'Input'), input('Weapon', 'String')],
        outputs: [exec('Out', 'Output'), output('Given', 'Boolean')],
        data: { default_Weapon: '' },
    },
    {
        type: 'GetPlayerHealth',
        title: 'Get Player Health',
        description: "The player's health and its maximum, and Health / Max from 0 to 1. All are 0 without a player.",
        pure: true,
        inputs: [],
        outputs: [output('Health', 'Float'), output('Max', 'Float'), output('Fraction', 'Float')],
        data: {},
    },
    {
        type: 'GetSplineLength',
        title: 'Get Spline Length',
        description: "The length in metres of an actor's spline (its Spline component), and whether it is a closed loop. Found is false for an actor without one.",
        pure: true,
        inputs: [input('Spline', 'Object')],
        outputs: [output('Found', 'Boolean'), output('Length', 'Float'), output('Closed', 'Boolean')],
        data: { default_Spline: '' },
    },
    {
        type: 'GetSplinePoint',
        title: 'Get Spline Point',
        description: "Where an actor's spline is Distance metres along it, the way it runs there and its up: for placing, aiming or moving things along a path. Distances wrap round a closed spline and stop at the ends of an open one.",
        pure: true,
        inputs: [input('Spline', 'Object'), input('Distance', 'Float')],
        outputs: [output('Found', 'Boolean'), ...vectorPins('Position', output), ...vectorPins('Direction', output), ...vectorPins('Up', output)],
        data: { default_Spline: '', default_Distance: 0 },
    },
    {
        type: 'FindClosestOnSpline',
        title: 'Find Closest On Spline',
        description: "The point on an actor's spline nearest Position, and how many metres along the spline it is: how far the player has come along a race track, or where to rejoin a path.",
        pure: true,
        inputs: [input('Spline', 'Object'), ...vectorPins('Position', input)],
        outputs: [output('Found', 'Boolean'), output('Distance', 'Float'), ...vectorPins('Closest', output)],
        data: { default_Spline: '', ...vectorDefaults('Position', [0, 0, 0]) },
    },
    {
        type: 'SetMorphTarget',
        title: 'Set Morph Target',
        description: 'Sets a morph target (blend shape) to a weight from 0 to 1 on every mesh of the actor that has one by that name. Meshes Changed is 0 when none has it.',
        inputs: [exec('Exec', 'Input'), input('Actor', 'Object'), input('Morph', 'String'), input('Weight', 'Float')],
        outputs: [exec('Out', 'Output'), output('Meshes Changed', 'Integer')],
        data: { default_Actor: '', default_Morph: '', default_Weight: 1 },
    },
];

export const isWorldNodeType = (type: string): type is WorldNodeType =>
    WORLD_NODE_DEFINITIONS.some(definition => definition.type === type);

/** True for world nodes without exec pins, which the runtime evaluates on demand. */
export const isPureWorldNodeType = (type: string): boolean =>
    WORLD_NODE_DEFINITIONS.some(definition => definition.type === type && definition.pure === true);

// --- Value coercion -------------------------------------------------------------------------

/** Finite number from a pin value; blank, missing or non-numeric values give `fallback`. */
const toNumber = <T extends number | null>(value: unknown, fallback: T): number | T => {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
};

const toInteger = (value: unknown, fallback: number): number => Math.trunc(toNumber(value, fallback));

const toText = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';

/** Actor id from an Object pin: an id string, or an object/handle carrying `id` or `objectId`. */
export const toActorId = (value: unknown): string | null => {
    if (typeof value === 'string') return value.trim() || null;
    if (value && typeof value === 'object') {
        const record = value as { id?: unknown; objectId?: unknown };
        const id = typeof record.id === 'string' ? record.id : typeof record.objectId === 'string' ? record.objectId : '';
        return id.trim() || null;
    }
    return null;
};

/** Reads `<prefix> X/Y/Z`; each blank axis takes the matching `fallback` axis. */
const readVector = (ctx: WorldExecutionContext, prefix: string, fallback: Vec3): Vec3 =>
    AXES.map((axis, i) => toNumber(ctx.evaluate(`${prefix} ${axis}`), fallback[i])) as Vec3;

/**
 * Like readVector, but null when every axis is blank (nothing to change). Given axes go through
 * `convert`; blank ones keep the matching `current` axis exactly.
 */
const readOptionalVector = (ctx: WorldExecutionContext, prefix: string, current: Vec3, convert = (value: number) => value): Vec3 | null => {
    const axes = AXES.map(axis => toNumber(ctx.evaluate(`${prefix} ${axis}`), null));
    if (axes.every(axis => axis === null)) return null;
    return axes.map((axis, i) => axis === null ? current[i] : convert(axis)) as Vec3;
};

const vectorOutputs = (prefix: string, value: Vec3 | null): Record<string, number | null> =>
    Object.fromEntries(AXES.map((axis, i) => [`${prefix} ${axis}`, value ? value[i] : null]));

const toDegrees = (radians: Vec3): Vec3 => radians.map(r => THREE.MathUtils.radToDeg(r)) as Vec3;

const toBus = (value: unknown): AudioBus | undefined => {
    const bus = toText(value).toLowerCase();
    return (AUDIO_BUSES as string[]).includes(bus) ? bus as AudioBus : undefined;
};

/** Print-friendly text: floats rounded to 3 decimals, vectors comma-joined, nothing for null. */
export const formatPrintValue = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return Number.isInteger(value) || !Number.isFinite(value) ? String(value) : String(Math.round(value * 1000) / 1000);
    if (Array.isArray(value)) return value.map(formatPrintValue).join(', ');
    if (value instanceof THREE.Vector3) return formatPrintValue(value.toArray());
    if (typeof value === 'object') {
        const id = toActorId(value);
        if (id) return id;
        try { return JSON.stringify(value); } catch { return String(value); }
    }
    return String(value);
};

/** Replaces `{0}`, `{1}`, ... with `args`; `{{` and `}}` are literal braces, unknown indices stay as written. */
export const formatPrintMessage = (format: string, args: readonly unknown[]): string =>
    format.replace(/\{\{|\}\}|\{(\d+)\}/g, (match, index: string | undefined) => {
        if (match === '{{') return '{';
        if (match === '}}') return '}';
        const i = Number(index);
        return i < args.length ? formatPrintValue(args[i]) : match;
    });

// --- Live objects ---------------------------------------------------------------------------

/**
 * The live object a play session draws an actor as: the first object under `root`, depth first, whose
 * `userData.levelObjectId` is `id`. Null when there is none (e.g. a static prop drawn through instancing).
 */
export const findActorObject3D = (root: THREE.Object3D, id: string): THREE.Object3D | null => {
    const stack = [root];
    while (stack.length > 0) {
        const node = stack.pop()!;
        if (node.userData?.levelObjectId === id) return node;
        for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    }
    return null;
};

/**
 * Sets the morph target named `morph` to `weight` on every mesh under `object` that has one (by its
 * morphTargetDictionary). Meshes of nested actors, tagged with another `levelObjectId`, are left alone.
 * Returns how many meshes were set.
 */
export const setActorMorphTarget = (object: THREE.Object3D, morph: string, weight: number): number => {
    const ownId = object.userData?.levelObjectId;
    let changed = 0;
    const stack = [object];
    while (stack.length > 0) {
        const node = stack.pop()!;
        const nodeId = node.userData?.levelObjectId;
        if (node !== object && typeof nodeId === 'string' && nodeId !== ownId) continue;
        const mesh = node as THREE.Mesh;
        const index = mesh.isMesh && mesh.morphTargetDictionary ? mesh.morphTargetDictionary[morph] : undefined;
        const influences = mesh.morphTargetInfluences;
        if (index !== undefined && influences && index < influences.length) {
            influences[index] = weight;
            changed += 1;
        }
        stack.push(...node.children);
    }
    return changed;
};

/** Latches data outputs so reads after the fired chain still see them (same shape as flow nodes). */
const publish = (ctx: WorldExecutionContext, outputs: Record<string, unknown>) => {
    ctx.nodeState.outputs = { ...(ctx.nodeState.outputs as Record<string, unknown> | undefined), ...outputs };
};

/** Publishes outputs, then continues the chain from `Out` with them. */
const finish = (ctx: WorldExecutionContext, outputs?: Record<string, unknown>) => {
    if (outputs) publish(ctx, outputs);
    ctx.fire('Out', outputs);
};

// --- Executors ------------------------------------------------------------------------------

const runSpawnPrefab: WorldNodeExecutor = (_node, ctx) => {
    const prefabId = toText(ctx.evaluate('Prefab'));
    const ids = prefabId ? ctx.services.spawnPrefab(prefabId, readVector(ctx, 'Position', [0, 0, 0])) : [];
    finish(ctx, { 'Spawned Actor': ids[0] ?? null });
};

const runGetActorTransform: WorldNodeExecutor = (_node, ctx) => {
    const id = toActorId(ctx.evaluate('Actor'));
    const object = id ? ctx.services.getObject(id) : null;
    publish(ctx, {
        Found: !!object,
        ...vectorOutputs('Position', object ? object.position : [0, 0, 0]),
        ...vectorOutputs('Rotation', object ? toDegrees(object.rotation) : [0, 0, 0]),
        ...vectorOutputs('Scale', object ? object.scale : [1, 1, 1]),
    });
};

const runSetActorTransform: WorldNodeExecutor = (_node, ctx) => {
    const id = toActorId(ctx.evaluate('Actor'));
    const object = id ? ctx.services.getObject(id) : null;
    if (id && object) {
        const position = readOptionalVector(ctx, 'Position', object.position);
        const rotation = readOptionalVector(ctx, 'Rotation', object.rotation, THREE.MathUtils.degToRad);
        const scale = readOptionalVector(ctx, 'Scale', object.scale);
        const partial: Partial<Pick<LevelObject, 'position' | 'rotation' | 'scale'>> = {};
        if (position) partial.position = position;
        if (rotation) partial.rotation = rotation;
        if (scale) partial.scale = scale;
        if (Object.keys(partial).length > 0) ctx.services.setObjectTransform(id, partial);
    }
    finish(ctx);
};

const runPlaySound: WorldNodeExecutor = (_node, ctx) => {
    const audioId = toText(ctx.evaluate('Sound'));
    if (audioId) ctx.services.playSound(audioId, toBus(ctx.evaluate('Bus')));
    finish(ctx);
};

const runMakeNoise: WorldNodeExecutor = (_node, ctx) => {
    const radius = toNumber(ctx.evaluate('Radius'), 0);
    if (radius > 0) ctx.services.makeNoise?.(readVector(ctx, 'Position', [0, 0, 0]), radius);
    finish(ctx);
};

const runApplyImpulse: WorldNodeExecutor = (_node, ctx) => {
    const id = toActorId(ctx.evaluate('Actor'));
    const impulse = readVector(ctx, 'Impulse', [0, 0, 0]);
    if (id && impulse.some(axis => axis !== 0)) ctx.services.applyImpulse(id, impulse);
    finish(ctx);
};

const runRaycast: WorldNodeExecutor = (_node, ctx) => {
    const origin = new THREE.Vector3(...readVector(ctx, 'Origin', [0, 0, 0]));
    const direction = new THREE.Vector3(...readVector(ctx, 'Direction', [0, 0, 0]));
    const maxDistance = toNumber(ctx.evaluate('Max Distance'), 0);
    const hit = direction.lengthSq() > 0 && maxDistance > 0
        ? ctx.services.raycast(origin, direction.normalize(), maxDistance)
        : null;
    finish(ctx, {
        Hit: !!hit,
        'Hit Actor': hit?.objectId ?? null,
        ...vectorOutputs('Hit Position', hit ? hit.point.toArray() : null),
        ...vectorOutputs('Hit Normal', hit ? hit.normal.toArray() : null),
        Distance: hit ? hit.point.distanceTo(origin) : null,
    });
};

const runGetLevelVariable: WorldNodeExecutor = (_node, ctx) => {
    const name = toText(ctx.evaluate('Name'));
    const value = name ? ctx.services.vars.get(name) : undefined;
    publish(ctx, { Value: value ?? null, 'Is Set': value !== undefined });
};

const runSetLevelVariable: WorldNodeExecutor = (_node, ctx) => {
    const name = toText(ctx.evaluate('Name'));
    finish(ctx, { Success: name ? ctx.services.vars.set(name, ctx.evaluate('Value')) : false });
};

// Edges are measured against this node's previous run, not the input frame, so the node works
// however often its chain runs and never fires twice for one press. A tap released before the
// next run still counts as down for the frame that reports it (wasPressed), so it is not lost.
const runInputActionPressed: WorldNodeExecutor = (_node, ctx) => {
    const action = toText(ctx.evaluate('Action'));
    const down = action ? ctx.services.input.isDown(action) || ctx.services.input.wasPressed?.(action) === true : false;
    const wasDown = ctx.nodeState.wasDown === true;
    ctx.nodeState.wasDown = down;
    const outputs = { 'Is Down': down };
    publish(ctx, outputs);
    if (down && !wasDown) ctx.fire('Pressed', outputs);
    if (!down && wasDown) ctx.fire('Released', outputs);
    ctx.fire('Out', outputs);
};

const runRandomFloat: WorldNodeExecutor = (_node, ctx) => {
    const a = toNumber(ctx.evaluate('Min'), 0);
    const b = toNumber(ctx.evaluate('Max'), 1);
    const [min, max] = a <= b ? [a, b] : [b, a];
    publish(ctx, { Value: min + Math.random() * (max - min) });
};

const runRandomInt: WorldNodeExecutor = (_node, ctx) => {
    const a = toInteger(ctx.evaluate('Min'), 0);
    const b = toInteger(ctx.evaluate('Max'), 10);
    const [min, max] = a <= b ? [a, b] : [b, a];
    // min(.., max) guards Math.random() values that round up to 1 for huge ranges.
    publish(ctx, { Value: Math.min(max, min + Math.floor(Math.random() * (max - min + 1))) });
};

const runPrint: WorldNodeExecutor = (_node, ctx) => {
    const format = ctx.evaluate('Format');
    const args = Array.from({ length: PRINT_FORMAT_ARGS }, (_, i) => ctx.evaluate(printArgName(i)));
    const message = formatPrintMessage(typeof format === 'string' ? format : formatPrintValue(format), args);
    ctx.services.print(message);
    finish(ctx, { Message: message });
};

// Without a clip or a usable rate (blank means 1) nothing plays; a negative Blend In snaps.
const runPlayPlayerAnimation: WorldNodeExecutor = (_node, ctx) => {
    const clip = toText(ctx.evaluate('Clip'));
    const maskBone = toText(ctx.evaluate('Mask Bone'));
    const blendIn = Math.max(0, toNumber(ctx.evaluate('Blend In'), DEFAULT_ANIMATION_BLEND_IN));
    const rate = toNumber(ctx.evaluate('Rate'), 1);
    const options: PlayAnimationOptions = maskBone ? { blendIn, rate, maskBone } : { blendIn, rate };
    if (ctx.evaluate('Additive') === true) options.additive = true;
    const played = clip !== '' && rate > 0 && ctx.services.playPlayerAnimation?.(clip, options) === true;
    finish(ctx, { Played: played });
};

// A blank or non-numeric Weight changes nothing; other weights are clamped to [0, 1].
const runSetMorphTarget: WorldNodeExecutor = (_node, ctx) => {
    const id = toActorId(ctx.evaluate('Actor'));
    const morph = toText(ctx.evaluate('Morph'));
    const weight = toNumber(ctx.evaluate('Weight'), null);
    const changed = id && morph && weight !== null && ctx.services.setMorphTarget
        ? ctx.services.setMorphTarget(id, morph, THREE.MathUtils.clamp(weight, 0, 1))
        : 0;
    finish(ctx, { 'Meshes Changed': changed });
};

// Player actions: a blank or non-positive amount does nothing.
const runDamagePlayer: WorldNodeExecutor = (_node, ctx) => {
    const amount = toNumber(ctx.evaluate('Amount'), 0);
    finish(ctx, { Damaged: amount > 0 && ctx.services.damagePlayer?.(amount) === true });
};

const runHealPlayer: WorldNodeExecutor = (_node, ctx) => {
    const amount = toNumber(ctx.evaluate('Amount'), 0);
    finish(ctx, { Healed: amount > 0 && ctx.services.healPlayer?.(amount) === true });
};

const runAddAmmo: WorldNodeExecutor = (_node, ctx) => {
    const rounds = toInteger(ctx.evaluate('Rounds'), 0);
    finish(ctx, { Added: rounds > 0 && ctx.services.addAmmo?.(rounds, toText(ctx.evaluate('Weapon'))) === true });
};

const runGiveWeapon: WorldNodeExecutor = (_node, ctx) => {
    const weapon = toText(ctx.evaluate('Weapon'));
    finish(ctx, { Given: weapon !== '' && ctx.services.giveWeapon?.(weapon) === true });
};

const runGetPlayerHealth: WorldNodeExecutor = (_node, ctx) => {
    const health = ctx.services.playerHealth?.() ?? null;
    const max = health && health.max > 0 ? health.max : 0;
    publish(ctx, { Health: health?.health ?? 0, Max: max, Fraction: max > 0 ? (health?.health ?? 0) / max : 0 });
};

const splineOf = (ctx: WorldExecutionContext): WorldSplineQuery | null => {
    const id = toActorId(ctx.evaluate('Spline'));
    return id ? ctx.services.spline?.(id) ?? null : null;
};

const runGetSplineLength: WorldNodeExecutor = (_node, ctx) => {
    const spline = splineOf(ctx);
    publish(ctx, { Found: spline !== null, Length: spline?.length ?? 0, Closed: spline?.closed ?? false });
};

const runGetSplinePoint: WorldNodeExecutor = (_node, ctx) => {
    const spline = splineOf(ctx);
    const sample = spline ? spline.sample(toNumber(ctx.evaluate('Distance'), 0)) : null;
    publish(ctx, {
        Found: sample !== null,
        ...vectorOutputs('Position', sample?.position ?? [0, 0, 0]),
        ...vectorOutputs('Direction', sample?.direction ?? [0, 0, 0]),
        ...vectorOutputs('Up', sample?.up ?? [0, 0, 0]),
    });
};

const runFindClosestOnSpline: WorldNodeExecutor = (_node, ctx) => {
    const spline = splineOf(ctx);
    const closest = spline ? spline.closest(readVector(ctx, 'Position', [0, 0, 0])) : null;
    publish(ctx, {
        Found: closest !== null,
        Distance: closest?.distance ?? 0,
        ...vectorOutputs('Closest', closest?.position ?? [0, 0, 0]),
    });
};

const executors = {
    SpawnPrefab: runSpawnPrefab,
    GetActorTransform: runGetActorTransform,
    SetActorTransform: runSetActorTransform,
    PlaySound: runPlaySound,
    MakeNoise: runMakeNoise,
    ApplyImpulse: runApplyImpulse,
    Raycast: runRaycast,
    GetLevelVariable: runGetLevelVariable,
    SetLevelVariable: runSetLevelVariable,
    InputActionPressed: runInputActionPressed,
    RandomFloat: runRandomFloat,
    RandomInt: runRandomInt,
    Print: runPrint,
    PlayPlayerAnimation: runPlayPlayerAnimation,
    SetMorphTarget: runSetMorphTarget,
    DamagePlayer: runDamagePlayer,
    HealPlayer: runHealPlayer,
    AddAmmo: runAddAmmo,
    GiveWeapon: runGiveWeapon,
    GetPlayerHealth: runGetPlayerHealth,
    GetSplineLength: runGetSplineLength,
    GetSplinePoint: runGetSplinePoint,
    FindClosestOnSpline: runFindClosestOnSpline,
} satisfies Record<WorldNodeType, WorldNodeExecutor>;

/** Executor per world node type; look up by `node.type` and treat a miss as "not a world node". */
export const WORLD_NODE_EXECUTORS: Readonly<Record<string, WorldNodeExecutor | undefined>> = executors;
