
import React, { useRef, useCallback, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { LevelBlueprintData, LevelObject, LogicNode, LogicPin } from '../types';
import { SandboxEntityHandle } from '../components/Sandbox/SandboxEntity';
import { GraphRuntimeAPI } from '../components/AnimationGraph/GraphRuntime';
import { isOverlapEvent, overlapEventTargets } from '../components/LevelBlueprint/overlapTargets';
import { frontendDiagnostics } from '../diagnostics/runtime';
import { TriggerEvent, useTriggerEvents } from '../runtime/triggers';
import { animationEvents, type AnimationEvent } from '../runtime/animationEvents';
import { timelineEvents, type TimelineEvent } from '../runtime/timeline/events';
import { dialogueSpeakers, dialogueStore, startDialogue, type DialogueEvent } from '../runtime/dialogue';
import { useNetSession } from '../runtime/net/NetSessionContext';
import { cameraDirector } from '../runtime/cameraDirector';
import type { NetPayload } from '../runtime/net/protocol';
import type { RuntimeHost } from '../runtime/types';
import { levelVariables } from '../runtime/levelVariables';
import { gameState } from '../runtime/gameState';
import { playerActions } from '../runtime/playerActions';
import { RuntimeServices, useRuntimeServices } from '../runtime/RuntimeServicesContext';
import { useNoiseBus } from '../runtime/perception';
import { FLOW_NODE_EXECUTORS, flowNodeOutputValue } from './levelBlueprintNodes/flow';
import { findActorObject3D, isPureWorldNodeType, PLAYER_ACTOR_ID, setActorMorphTarget, WORLD_NODE_EXECUTORS, WorldExecutionContext, WorldNodeServices } from './levelBlueprintNodes/world';
import { getLiveSpline, liveSplineQuery } from '../runtime/splineRegistry';
import { KMH, vehicleSession, type VehicleSessionEvent } from '../runtime/vehicles';
import { particleEmitters } from '../runtime/particleEmitters';

const MAX_BLUEPRINT_EVALUATION_DEPTH = 128;
const MAX_BLUEPRINT_EXECUTION_DEPTH = 256;

/** Remaining time below this counts as due, so float drift cannot hold a timer back a frame. */
const TIMER_EPSILON = 1e-9;

/** Objects with an enabled collider get their overlaps from physics trigger events, not the distance check. */
const hasCollider = (obj: LevelObject): boolean =>
    (obj.components ?? []).some(component => component.type === 'collider' && component.enabled);

/** The table's own entry only, so a type named after an Object.prototype member ('valueOf', '__proto__') misses. */
const ownExecutor = <T>(table: Readonly<Record<string, T | undefined>>, type: string): T | undefined =>
    Object.hasOwn(table, type) ? table[type] : undefined;

/** A flow or world node's executor (pure world nodes included); undefined for the built-in node types. */
const nodeExecutor = (type: string) => ownExecutor(FLOW_NODE_EXECUTORS, type) ?? ownExecutor(WORLD_NODE_EXECUTORS, type);

/** An executor's evaluate(pinName): the named data input via `read`, or its `default_<pin>` when the pin is missing. */
const readNamedInput = (node: LogicNode, pinName: string, read: (pinId: string) => any): any => {
    const pin = node.inputs.find(p => p.name === pinName && p.dataType !== 'Exec');
    return pin ? read(pin.id) : node.data?.[`default_${pinName}`] ?? null;
};

/** The topmost ancestor of `object`: the scene, for an object that is drawn. */
const rootOf = (object: THREE.Object3D | null): THREE.Object3D | null => {
    let root = object;
    while (root?.parent) root = root.parent;
    return root;
};

/** Per-node state for the play session, created empty on first use. */
const nodeStateOf = (states: Map<string, Record<string, unknown>>, nodeId: string): Record<string, unknown> => {
    let state = states.get(nodeId);
    if (!state) {
        state = {};
        states.set(nodeId, state);
    }
    return state;
};

interface ScheduledRun {
    remaining: number;
    run: () => void;
}

/**
 * Whether an Event AnimNotify node handles a notify: its name matches (an empty name takes any)
 * and it was raised by the node's source ('player' by default, 'enemies' or 'any').
 */
export const animNotifyMatches = (node: LogicNode, event: AnimationEvent): boolean => {
    const name = typeof node.data?.notifyName === 'string' ? node.data.notifyName.trim() : '';
    if (name && name !== event.name) return false;
    const source = node.data?.notifySource;
    if (source === 'any') return true;
    if (source === 'enemies') return event.objectId !== 'player';
    return event.objectId === 'player';
};

/** Whether an Event NetworkEvent node handles an event called `name`: its event name matches, or it is empty and takes any. */
export const networkEventMatches = (node: LogicNode, name: string): boolean => {
    const wanted = typeof node.data?.eventName === 'string' ? node.data.eventName.trim() : '';
    return !wanted || wanted === name;
};

/** A blueprint value as a network payload: numbers, booleans and text as they are, anything else as text. */
export const networkPayload = (value: unknown): NetPayload => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'boolean' || typeof value === 'string') return value;
    return String(value);
};

/** Whether an Event TimelineEvent node handles an event: its event name matches, or it is empty and takes any. */
export const timelineEventMatches = (node: LogicNode, event: TimelineEvent): boolean => {
    const name = typeof node.data?.eventName === 'string' ? node.data.eventName.trim() : '';
    return !name || name === event.name;
};

/** Whether an Event DialogueEvent node handles an event: its event name matches, or it is empty and takes any. */
export const dialogueEventMatches = (node: LogicNode, event: DialogueEvent): boolean => {
    const name = typeof node.data?.eventName === 'string' ? node.data.eventName.trim() : '';
    return !name || name === event.name;
};

/** Whether an Event VehicleEntered/VehicleExited node handles a vehicle: its vehicle matches, or it names none and takes any. */
export const vehicleEventMatches = (node: LogicNode, vehicleId: string): boolean => {
    const wanted = typeof node.data?.vehicleId === 'string' ? node.data.vehicleId.trim() : '';
    return !wanted || wanted === vehicleId;
};

/**
 * Interface for the Level Blueprint Runtime.
 */

export interface UseLevelBlueprintRuntimeProps {
    blueprint: LevelBlueprintData;
    levelObjects: LevelObject[];
    playerEntityRef: React.RefObject<SandboxEntityHandle | null>;
    playerApiRef: React.MutableRefObject<GraphRuntimeAPI | undefined>;
    enemyApiRef: React.MutableRefObject<GraphRuntimeAPI | undefined>;
    /** Removes an actor from the play session's runtime world. Must never write to the project. */
    destroyActor: (id: string) => void;
    addNotification: (notification: any) => void;
    onRestart?: () => void;
    onEndLevel?: () => void;
    /** Level travel and save/load for OpenLevel, SaveGame and LoadGame actions. Absent means those actions do nothing. */
    host?: Pick<RuntimeHost, 'openLevel' | 'saveGame' | 'loadGame'>;
    /** Actor transform in the session copy, for Get/Set Actor Transform. Absent means no actor is found. */
    getObject?: WorldNodeServices['getObject'];
    /** Moves an actor in the session copy (never the project). Absent means Set Actor Transform does nothing. */
    setObjectTransform?: WorldNodeServices['setObjectTransform'];
    /** Pushes an actor's dynamic rigid body. Absent means Apply Impulse does nothing. */
    applyImpulse?: WorldNodeServices['applyImpulse'];
    /** Physics ray query for the Raycast node, e.g. usePhysicsQueries().raycast. Absent means nothing is hit. */
    raycast?: WorldNodeServices['raycast'];
}

/** Optional save slot from a SaveGame/LoadGame node; blank means the host's default slot. */
const saveSlot = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * THE LEVEL BLUEPRINT RUNTIME ENGINE
 * 
 * This hook is responsible for executing the visual logic graph defined in the Level Blueprint.
 * It handles:
 * 1. Event Triggers (BeginPlay, Tick, Overlap). Overlap comes from physics trigger events for
 *    objects with a collider component, and from a player distance check for objects without one.
 * 2. Forward Execution Flow (executing nodes in sequence). Flow-control and world nodes run through
 *    their executors (levelBlueprintNodes/flow.ts and world.ts), which fire their own exec outputs.
 * 3. Backward Data Evaluation (recursively calculating input values).
 *
 * @param props Dependencies required to interact with the game world.
 */
export const useLevelBlueprintRuntime = ({
    blueprint,
    levelObjects,
    playerEntityRef,
    playerApiRef,
    enemyApiRef,
    destroyActor,
    addNotification,
    onRestart,
    onEndLevel,
    host,
    getObject,
    setObjectTransform,
    applyImpulse,
    raycast
}: UseLevelBlueprintRuntimeProps) => {

    // Tracks objects currently overlapping the player to prevent spamming 'OnOverlap' events every frame.
    const overlappingIds = useRef<Set<string>>(new Set());

    // Trigger colliders the player is inside, per physics enter/exit events (several player colliders may report one entry).
    const triggerOverlapIds = useRef<Set<string>>(new Set());
    const triggerEvents = useTriggerEvents();

    // BeginPlay fires once per play session. A restart remounts the runtime, which starts a new session.
    const hasBegunPlay = useRef(false);

    // Set once Restart, EndGame, OpenLevel or LoadGame fires, so the ending session cannot act on the next one
    // (e.g. a later overlap in the same frame destroying an actor in the freshly reset world).
    const sessionEnded = useRef(false);
    
    // Stores the current frame's delta time for the 'Event Tick' node.
    const currentDelta = useRef<number>(0);

    // Flow/world node state for this session (DoOnce/Gate open, FlipFlop side, latched data outputs).
    const nodeStates = useRef(new Map<string, Record<string, unknown>>());

    // Timed continuations (Delay) on the play clock: advanced in the frame loop, dropped when the session ends.
    const timers = useRef<ScheduledRun[]>([]);
    const mounted = useRef(false);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            // StrictMode's simulated unmount remounts synchronously (and BeginPlay, which may have scheduled,
            // does not run again), so only a real unmount drops the pending timers.
            queueMicrotask(() => {
                if (!mounted.current) timers.current = [];
            });
        };
    }, []);

    // World node services. Stable, reading the latest props, so the graph callbacks do not churn with them.
    const runtimeServices: RuntimeServices | undefined = useRuntimeServices();
    const noises = useNoiseBus();
    const world = useRef({ runtimeServices, noises, getObject, setObjectTransform, applyImpulse, raycast, addNotification, playerApiRef, playerEntityRef });
    world.current = { runtimeServices, noises, getObject, setObjectTransform, applyImpulse, raycast, addNotification, playerApiRef, playerEntityRef };

    // Live THREE objects of the session, for nodes that change what is drawn (Set Morph Target): the player's
    // model, or an actor's transform group (tagged with its id) in the scene. The scene comes from the frame
    // loop; before the first frame (BeginPlay) it is the root above the player's model. A found actor is
    // remembered while it stays in that scene, so a node run every frame does not search the scene each time.
    const sceneRoot = useRef<THREE.Object3D | null>(null);
    const actorObjects = useRef(new Map<string, THREE.Object3D>());
    const sessionObject3D = useCallback((id: string): THREE.Object3D | null => {
        const player = world.current.playerEntityRef.current?.object ?? null;
        if (id === PLAYER_ACTOR_ID) return player;
        const root = rootOf(sceneRoot.current ?? player);
        if (!root) return null;
        const cached = actorObjects.current.get(id);
        if (cached && cached.userData?.levelObjectId === id && rootOf(cached) === root) return cached;
        const found = findActorObject3D(root, id);
        if (found) actorObjects.current.set(id, found);
        else actorObjects.current.delete(id);
        return found;
    }, []);

    const services = useMemo<WorldNodeServices>(() => ({
        spawnPrefab: (prefabId, position) => world.current.runtimeServices?.spawnPrefab(prefabId, position) ?? [],
        playSound: (audioId, bus) => world.current.runtimeServices?.playSound(audioId, bus),
        makeNoise: (position, radius) => world.current.noises?.report(position, radius, null),
        getObject: id => world.current.getObject?.(id) ?? null,
        setObjectTransform: (id, partial) => world.current.setObjectTransform?.(id, partial),
        applyImpulse: (id, impulse) => world.current.applyImpulse?.(id, impulse),
        raycast: (origin, direction, maxDistance) => world.current.raycast?.(origin, direction, maxDistance) ?? null,
        input: {
            isDown: action => world.current.runtimeServices?.input.isDown(action) ?? false,
            wasPressed: action => world.current.runtimeServices?.input.wasPressed(action) ?? false,
        },
        vars: levelVariables,
        print: message => world.current.addNotification({ message: `[Output] ${message}`, type: 'info', duration: 3000 }),
        playPlayerAnimation: (clipName, options) => world.current.playerApiRef.current?.playMontage?.(clipName, options) ?? false,
        setMorphTarget: (objectId, morph, weight) => {
            const object = sessionObject3D(objectId);
            return object ? setActorMorphTarget(object, morph, weight) : 0;
        },
        damagePlayer: amount => playerActions.damage(amount),
        healPlayer: amount => playerActions.heal(amount),
        addAmmo: (rounds, weapon) => playerActions.addAmmo(rounds, weapon),
        giveWeapon: weapon => playerActions.giveWeapon(weapon),
        playerHealth: () => {
            if (!world.current.playerEntityRef.current) return null;
            const { health, maxHealth } = gameState.get().player;
            return { health, max: maxHealth };
        },
        spline: (objectId) => {
            const entry = getLiveSpline(objectId, 'runtime');
            return entry ? liveSplineQuery(entry) : null;
        },
        vehicle: (objectId) => {
            const handle = vehicleSession.get(objectId);
            if (!handle) return null;
            const speed = handle.speed();
            return { speed: speed / KMH, gear: handle.gear(), playerDriving: vehicleSession.state().driving === objectId };
        },
        playerVehicle: () => vehicleSession.state().driving,
        enterVehicle: (objectId) => vehicleSession.enter(objectId),
        exitVehicle: () => vehicleSession.exit(),
        setVehicleInput: (objectId, controls) => {
            const handle = vehicleSession.get(objectId);
            if (!handle) return false;
            handle.setScriptControls(controls);
            return true;
        },
        playParticles: (objectId) => {
            const emitters = particleEmitters.forObject('runtime', objectId);
            for (const emitter of emitters) emitter.play();
            return emitters.length;
        },
        stopParticles: (objectId, clear) => {
            const emitters = particleEmitters.forObject('runtime', objectId);
            for (const emitter of emitters) emitter.stop(clear);
            return emitters.length;
        },
        emitParticles: (objectId, count) => {
            const emitters = particleEmitters.forObject('runtime', objectId);
            for (const emitter of emitters) emitter.emit(count);
            return emitters.length;
        },
        particles: (objectId) => {
            const emitters = particleEmitters.forObject('runtime', objectId);
            return {
                playing: emitters.some(emitter => emitter.isPlaying()),
                alive: emitters.reduce((sum, emitter) => sum + emitter.alive(), 0),
                emitters: emitters.length,
            };
        },
    }), [sessionObject3D]);

    // -------------------------------------------------------------------------
    // 1. DATA EVALUATION (Recursive Backwards Trace)
    // -------------------------------------------------------------------------

    /**
     * Calculates the value of a specific input pin on a node by tracing backwards
     * through the graph connections.
     * 
     * @param nodeId The ID of the node requesting the value.
     * @param inputPinId The ID of the input pin on that node.
     * @param context The running event's context; an overlap event's Other Actor output reads its otherActorId.
     * @returns The evaluated value (number, boolean, string, etc.) or null.
     */
    const evaluateInput = useCallback((nodeId: string, inputPinId: string, context?: { otherActorId?: string; networkValue?: string; networkFrom?: string; vehicleId?: string }): any => {
        // Editor-made nodes start with an Exec pin, so data pins are found by name, then by data-pin order.
        const dataPin = (pins: LogicPin[], name: string, index: number): LogicPin | undefined =>
            pins.find(p => p.name === name) ?? pins.filter(p => p.dataType !== 'Exec')[index];
        const evaluate = (currentNodeId: string, currentInputPinId: string, path: Set<string>, depth: number): any => {
        if (depth >= MAX_BLUEPRINT_EVALUATION_DEPTH) return null;
        const pathKey = `${currentNodeId}:${currentInputPinId}`;
        if (path.has(pathKey)) return null;
        const nextPath = new Set(path);
        nextPath.add(pathKey);

        // Find the connection feeding into this pin
        const connection = blueprint.connections.find(c => c.toNodeId === currentNodeId && c.toPinId === currentInputPinId);
        
        // If no connection, return default value (stored in node.data)
        if (!connection) {
            const node = blueprint.nodes.find(n => n.id === currentNodeId);
            const pin = node?.inputs.find(p => p.id === currentInputPinId);
            if (node && pin) {
                return node.data?.[`default_${pin.name}`] ?? null;
            }
            return null;
        }

        // Trace back to the source node
        const sourceNode = blueprint.nodes.find(n => n.id === connection.fromNodeId);
        if (!sourceNode) return null;

        // --- Evaluate Source Node based on Type ---
        switch (sourceNode.type) {
            case 'Event': {
                // Special case: Event nodes providing data (Tick -> Delta Seconds, Overlap -> Other Actor)
                const pin = sourceNode.outputs.find(p => p.id === connection.fromPinId);
                if (sourceNode.name === 'Event Tick' && pin?.name === 'Delta Seconds') return currentDelta.current;
                if (pin?.name === 'Other Actor') return context?.otherActorId ?? null;
                if (sourceNode.name === 'Event NetworkEvent' && pin?.name === 'Value') return context?.networkValue ?? '';
                if (sourceNode.name === 'Event NetworkEvent' && pin?.name === 'From') return context?.networkFrom ?? '';
                if (pin?.name === 'Vehicle' && (sourceNode.name === 'Event VehicleEntered' || sourceNode.name === 'Event VehicleExited')) return context?.vehicleId ?? null;
                return null;
            }

            // --- MULTIPLAYER ---
            case 'IsNetworkHost':
                // A single-player game is its own host.
                return !netSessionRef.current || netSessionRef.current.isHost();

            // --- LITERALS ---
            case 'LiteralFloat':
            case 'LiteralInteger':
            case 'LiteralString':
            case 'LiteralBoolean': {
                return sourceNode.data?.value;
            }

            case 'ToString': {
                const pin = dataPin(sourceNode.inputs, 'Value', 0);
                const val = pin ? evaluate(sourceNode.id, pin.id, nextPath, depth + 1) : undefined;
                return val !== null && val !== undefined ? String(val) : '';
            }

            case 'VariableGet': {
                // Determine Target (Player vs Enemy)
                const target = sourceNode.data?.targetBlueprintType || 'Player'; // Default to player
                const varName = sourceNode.data?.variableName;
                const api = target === 'Enemy' ? enemyApiRef.current : playerApiRef.current;
                
                if (api && varName) {
                    return api.getVariable(varName);
                }
                return null;
            }

            // --- MATH OPERATIONS ---
            case 'Add':
            case 'Subtract':
            case 'Multiply':
            case 'Divide': {
                const pinA = dataPin(sourceNode.inputs, 'A', 0);
                const pinB = dataPin(sourceNode.inputs, 'B', 1);
                const a = Number((pinA ? evaluate(sourceNode.id, pinA.id, nextPath, depth + 1) : 0) ?? 0);
                const b = Number((pinB ? evaluate(sourceNode.id, pinB.id, nextPath, depth + 1) : 0) ?? 0);
                // An Integer result pin rounds down; Float keeps JS floats.
                const isInt = dataPin(sourceNode.outputs, 'Result', 0)?.dataType === 'Integer';
                let result: number;
                if (sourceNode.type === 'Add') result = a + b;
                else if (sourceNode.type === 'Subtract') result = a - b;
                else if (sourceNode.type === 'Multiply') result = a * b;
                else result = b !== 0 ? a / b : 0;
                return isInt ? Math.floor(result) : result;
            }

            // --- LOGIC OPERATIONS ---
            case 'Check': // Legacy 'Compare'
            case 'Greater':
            case 'Less': 
            case 'Equal': { 
                const pinA = sourceNode.inputs.find(p => p.name === 'A');
                const pinB = sourceNode.inputs.find(p => p.name === 'B');
                const valA = pinA ? evaluate(sourceNode.id, pinA.id, nextPath, depth + 1) : 0;
                const valB = pinB ? evaluate(sourceNode.id, pinB.id, nextPath, depth + 1) : 0;

                // Explicit Logic Nodes
                if (sourceNode.type === 'Greater') return valA > valB;
                if (sourceNode.type === 'Less') return valA < valB;
                if (sourceNode.type === 'Equal') return valA == valB;

                // Legacy 'Check' Node with multiple outputs
                const outPin = sourceNode.outputs.find(p => p.id === connection.fromPinId);
                if (outPin?.name === 'A > B') return (valA as number) > (valB as number);
                if (outPin?.name === 'A == B') return valA === valB;
                return false;
            }

            case 'And': {
                const pinA = sourceNode.inputs.find(p => p.name === 'A');
                const pinB = sourceNode.inputs.find(p => p.name === 'B');
                return (pinA ? evaluate(sourceNode.id, pinA.id, nextPath, depth + 1) : false) &&
                       (pinB ? evaluate(sourceNode.id, pinB.id, nextPath, depth + 1) : false);
            }

            case 'Or': {
                const pinA = sourceNode.inputs.find(p => p.name === 'A');
                const pinB = sourceNode.inputs.find(p => p.name === 'B');
                return (pinA ? evaluate(sourceNode.id, pinA.id, nextPath, depth + 1) : false) ||
                       (pinB ? evaluate(sourceNode.id, pinB.id, nextPath, depth + 1) : false);
            }

            // --- FLOW & WORLD NODES ---
            // Data outputs are latched in node state. Pure world nodes (no exec pins) run on every read.
            default: {
                const executor = nodeExecutor(sourceNode.type);
                const outPin = sourceNode.outputs.find(p => p.id === connection.fromPinId);
                if (!executor || !outPin) return null;
                const state = nodeStateOf(nodeStates.current, sourceNode.id);
                if (isPureWorldNodeType(sourceNode.type)) {
                    executor(sourceNode, {
                        evaluate: pinName => readNamedInput(sourceNode, pinName, pinId => evaluate(sourceNode.id, pinId, nextPath, depth + 1)),
                        fire: () => undefined,
                        schedule: () => undefined,
                        nodeState: state,
                        services,
                    });
                }
                return flowNodeOutputValue(state, outPin.name);
            }
        }
        };
        return evaluate(nodeId, inputPinId, new Set(), 0);
    }, [blueprint, playerApiRef, enemyApiRef, services]);

    // -------------------------------------------------------------------------
    // 2. EXECUTION FLOW (Forward Trace)
    // -------------------------------------------------------------------------

    /**
     * Executes the logic for a specific node and then triggers the next node in the chain.
     * 
     * @param nodeId The ID of the node to execute.
     * @param context Contextual data passed from the event trigger (e.g. Other Actor ID).
     * @param entryPinId The input exec pin the flow arrived on; omitted for event nodes.
     */
    const executeNode = useCallback((nodeId: string, context: any, path: Set<string> = new Set(), depth = 0, entryPinId?: string) => {
        // The cycle guard keys on node and entry pin: re-entering the same pin is a loop, but entering
        // another one (Gate Open/Close/Toggle, DoOnce Reset, which fire nothing) only changes its state.
        const execKey = `${nodeId}:${entryPinId ?? ''}`;
        if (sessionEnded.current || depth >= MAX_BLUEPRINT_EXECUTION_DEPTH || path.has(execKey)) return;
        const nextPath = new Set(path);
        nextPath.add(execKey);
        const node = blueprint.nodes.find(n => n.id === nodeId);
        if (!node) return;

        let nextExecPinName = 'Out'; // Default output execution pin name

        // --- Execute Specific Node Logic ---
        if (node.type === 'PrintString') {
            // New: Support string input pin from connection OR default
            const stringPin = node.inputs.find(p => p.name === 'String');
            let msg = node.data?.printMessage || "None";
            
            if (stringPin) {
                // If connected, evaluates connection. If not, evaluates default_String.
                const val = evaluateInput(node.id, stringPin.id, context);
                if (val !== null && val !== undefined) {
                    msg = String(val);
                }
            }
            
            // Use blue/info type for BP logs to distinguish them
            addNotification({ message: `[Output] ${msg}`, type: 'info', duration: 3000 });
        } 
        else if (node.type === 'SetActiveCamera') {
            const blendPin = node.inputs.find(p => p.name === 'Blend');
            const blend = Number(blendPin ? evaluateInput(node.id, blendPin.id, context) : 0);
            const cameraId = typeof node.data?.cameraId === 'string' ? node.data.cameraId : '';
            cameraDirector.setActive(cameraId || null, Number.isFinite(blend) ? blend : 0);
        }
        else if (node.type === 'StartDialogue') {
            const objectId = typeof node.data?.targetObjectId === 'string' ? node.data.targetObjectId : '';
            if (!objectId || !dialogueSpeakers.has(objectId)) {
                addNotification({ message: 'Start Dialogue: the chosen object has no Dialogue component in this session.', type: 'warning' });
            } else {
                startDialogue(objectId);
            }
        }
        else if (node.type === 'SendNetworkEvent') {
            const namePin = node.inputs.find(p => p.name === 'Name');
            const valuePin = node.inputs.find(p => p.name === 'Value');
            const name = String((namePin ? evaluateInput(node.id, namePin.id, context) : null) ?? '').trim();
            const value = valuePin ? evaluateInput(node.id, valuePin.id, context) : null;
            if (name) netSessionRef.current?.sendEvent(name, networkPayload(value));
        }
        else if (node.type === 'DestroyActor') {
            // Context usually comes from Overlap event
            if (context.otherActorId) {
                destroyActor(context.otherActorId);
                addNotification({ message: `Actor destroyed`, type: 'success' });
            }
        }
        else if (node.type === 'LevelAction') {
            const action = node.data?.action;
            if (action === 'Restart' && onRestart) {
                sessionEnded.current = true;
                addNotification({ message: "Restarting Level...", type: 'info' });
                onRestart();
                return; // Stop execution
            }
            if (action === 'EndGame' && onEndLevel) {
                sessionEnded.current = true;
                addNotification({ message: "Level Ended.", type: 'info' });
                onEndLevel();
                return; // Stop execution
            }
            if (action === 'OpenLevel' && host) {
                const levelId = typeof node.data?.levelId === 'string' ? node.data.levelId : '';
                if (!levelId) {
                    addNotification({ message: "Open Level has no level selected.", type: 'warning' });
                } else {
                    sessionEnded.current = true;
                    addNotification({ message: "Opening Level...", type: 'info' });
                    host.openLevel(levelId);
                    return; // Stop execution
                }
            }
            if (action === 'SaveGame' && host) {
                host.saveGame(saveSlot(node.data?.slot));
            }
            if (action === 'LoadGame' && host) {
                sessionEnded.current = true;
                addNotification({ message: "Loading Game...", type: 'info' });
                host.loadGame(saveSlot(node.data?.slot));
                return; // Stop execution
            }
        }
        else if (node.type === 'Branch') {
            // Evaluate Condition Input
            const condPin = node.inputs.find(p => p.name === 'Condition');
            const condition = condPin ? evaluateInput(node.id, condPin.id, context) : false;
            
            // Route flow based on result
            nextExecPinName = condition ? 'True' : 'False';
        }
        else if (node.type === 'VariableSet') {
            const target = node.data?.targetBlueprintType || 'Player';
            const varName = node.data?.variableName;
            const valPin = node.inputs.find(p => p.name === 'Value');
            const value = valPin ? evaluateInput(node.id, valPin.id, context) : null;

            const api = target === 'Enemy' ? enemyApiRef.current : playerApiRef.current;
            if (api && varName && value !== null) {
                api.setVariable(varName, value);
            }
        }
        else {
            const executor = nodeExecutor(node.type);
            if (executor) {
                // A scheduled continuation is a new call stack: it resumes at depth 0 with an empty cycle
                // guard, so a chain can loop back into this Delay (which only schedules again).
                let chainPath = nextPath;
                let chainDepth = depth;
                const state = nodeStateOf(nodeStates.current, node.id);
                const ctx: WorldExecutionContext = {
                    evaluate: pinName => readNamedInput(node, pinName, pinId => evaluateInput(node.id, pinId, context)),
                    fire: (pinName, data) => {
                        if (data) state.outputs = { ...(state.outputs as Record<string, unknown> | undefined), ...data };
                        const pin = node.outputs.find(p => p.dataType === 'Exec' && p.name === pinName);
                        const connection = pin && blueprint.connections.find(c => c.fromNodeId === node.id && c.fromPinId === pin.id);
                        if (connection) executeNode(connection.toNodeId, context, chainPath, chainDepth + 1, connection.toPinId);
                    },
                    schedule: (seconds, fn) => {
                        if (sessionEnded.current) return;
                        timers.current.push({
                            remaining: Number.isFinite(seconds) ? Math.max(0, seconds) : 0,
                            run: () => {
                                chainPath = new Set<string>();
                                chainDepth = 0;
                                fn();
                            },
                        });
                    },
                    nodeState: state,
                    entryPin: entryPinId === undefined ? undefined : node.inputs.find(p => p.id === entryPinId)?.name,
                    services,
                };
                executor(node, ctx);
                return; // Executors fire their own exec outputs.
            }
        }

        // --- Determine Next Node ---
        // Some nodes have multiple Exec outputs (Branch, FlipFlop). 
        // We filter for Exec type pins.
        const outputPins = node.outputs.filter(p => p.dataType === 'Exec');
        
        // Find the specific pin to fire (e.g. True vs False, or just Out)
        const activePin = outputPins.find(p => p.name === nextExecPinName) || outputPins[0];
        
        if (activePin) {
            // Find wire connected to this output
            const connection = blueprint.connections.find(c => c.fromPinId === activePin.id);
            if (connection) {
                // Recursively call next node, on the pin the wire enters (Gate Open, DoOnce Reset, ...)
                executeNode(connection.toNodeId, context, nextPath, depth + 1, connection.toPinId);
            }
        }
    }, [blueprint, evaluateInput, destroyActor, addNotification, playerApiRef, enemyApiRef, onRestart, onEndLevel, host, services]);

    // -------------------------------------------------------------------------
    // 3. LIFECYCLE HOOKS
    // -------------------------------------------------------------------------
    
    // --- Event: BeginPlay ---
    // executeNode changes identity whenever any runtime prop does, so the guard (not the
    // dependency list) is what keeps this to one run per session, including under StrictMode.
    useEffect(() => {
        if (hasBegunPlay.current) return;
        hasBegunPlay.current = true;
        const beginNodes = blueprint.nodes.filter(n => n.name === 'Event BeginPlay');
        const span = frontendDiagnostics.startSpan('level_blueprint_runtime', 'begin_play', {
            category: 'runtime_event',
        });
        try {
            span.phase('execute', { count: beginNodes.length });
            beginNodes.forEach(node => executeNode(node.id, {}));
            span.finish('success');
        } catch (error) {
            span.fail(error);
            span.finish('failure');
            throw error;
        }
    }, [blueprint.nodes, executeNode]); 

    // --- Event: Overlap (physics trigger colliders) ---
    // Props churn every render, so the listener reads the latest graph and objects through a ref
    // and subscribes once per session's event bus.
    const handleTriggerEvent = useRef<(event: TriggerEvent) => void>(() => undefined);
    handleTriggerEvent.current = (event: TriggerEvent) => {
        if (event.otherObjectId !== 'player') return;
        const triggerId = event.triggerObjectId;
        if (event.kind === 'exit') {
            triggerOverlapIds.current.delete(triggerId);
            return;
        }
        if (!hasBegunPlay.current || sessionEnded.current || triggerOverlapIds.current.has(triggerId)) return;
        triggerOverlapIds.current.add(triggerId);
        // By actor id; legacy name-only events by name while the actor is still in the session.
        const actor = levelObjects?.find(obj => obj.id === triggerId);
        const eventNodes = blueprint.nodes.filter(n =>
            isOverlapEvent(n) && (actor ? overlapEventTargets(n, actor) : n.data?.targetActorId === triggerId)
        );
        eventNodes.forEach(node => executeNode(node.id, { otherActorId: triggerId }));
    };
    useEffect(() => triggerEvents.subscribe(event => handleTriggerEvent.current(event)), [triggerEvents]);

    // --- Event: Animation notify (a character's clip crossed a named notify) ---
    const handleAnimationEvent = useRef<(event: AnimationEvent) => void>(() => undefined);
    handleAnimationEvent.current = (event: AnimationEvent) => {
        if (!hasBegunPlay.current || sessionEnded.current) return;
        blueprint.nodes
            .filter(n => n.type === 'Event' && n.name === 'Event AnimNotify' && animNotifyMatches(n, event))
            .forEach(node => executeNode(node.id, {}));
    };
    useEffect(() => animationEvents.subscribe(event => handleAnimationEvent.current(event)), []);

    // --- Event: Network event (another player's Send Network Event or ctx.net.send) ---
    const handleNetworkEvent = useRef<(from: string, name: string, payload: NetPayload) => void>(() => undefined);
    handleNetworkEvent.current = (from: string, name: string, payload: NetPayload) => {
        if (!hasBegunPlay.current || sessionEnded.current) return;
        const value = payload === null ? '' : typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
        blueprint.nodes
            .filter(n => n.type === 'Event' && n.name === 'Event NetworkEvent' && networkEventMatches(n, name))
            .forEach(node => executeNode(node.id, { networkValue: value, networkFrom: from }));
    };
    const netSession = useNetSession();
    const netSessionRef = useRef(netSession);
    netSessionRef.current = netSession;
    useEffect(() => netSession?.onEvent((from, name, payload) => handleNetworkEvent.current(from, name, payload)), [netSession]);

    // --- Event: Timeline event (a playing timeline crossed an event key) ---
    const handleTimelineEvent = useRef<(event: TimelineEvent) => void>(() => undefined);
    handleTimelineEvent.current = (event: TimelineEvent) => {
        if (!hasBegunPlay.current || sessionEnded.current) return;
        blueprint.nodes
            .filter(n => n.type === 'Event' && n.name === 'Event TimelineEvent' && timelineEventMatches(n, event))
            .forEach(node => executeNode(node.id, {}));
    };
    useEffect(() => timelineEvents.subscribe(event => handleTimelineEvent.current(event)), []);

    // --- Event: Dialogue event (a dialogue line or choice raised it) ---
    const handleDialogueEvent = useRef<(event: DialogueEvent) => void>(() => undefined);
    handleDialogueEvent.current = (event: DialogueEvent) => {
        if (!hasBegunPlay.current || sessionEnded.current) return;
        blueprint.nodes
            .filter(n => n.type === 'Event' && n.name === 'Event DialogueEvent' && dialogueEventMatches(n, event))
            .forEach(node => executeNode(node.id, {}));
    };
    useEffect(() => dialogueStore.onEvent(event => handleDialogueEvent.current(event)), []);

    // --- Event: Vehicle entered / exited (the player got into or out of a vehicle) ---
    const handleVehicleEvent = useRef<(event: VehicleSessionEvent) => void>(() => undefined);
    handleVehicleEvent.current = (event: VehicleSessionEvent) => {
        if (!hasBegunPlay.current || sessionEnded.current) return;
        const name = event.type === 'entered' ? 'Event VehicleEntered' : 'Event VehicleExited';
        blueprint.nodes
            .filter(n => n.type === 'Event' && n.name === name && vehicleEventMatches(n, event.objectId))
            .forEach(node => executeNode(node.id, { vehicleId: event.objectId }));
    };
    useEffect(() => vehicleSession.onEvent(event => handleVehicleEvent.current(event)), []);

    // --- Event: Tick & Overlap Physics ---
    useFrame((state, delta) => {
        // The scene Set Morph Target finds actors in.
        if (state.scene) sceneRoot.current = state.scene;
        if (sessionEnded.current) {
            timers.current = [];
            return;
        }
        currentDelta.current = delta;

        // 1. Timed continuations that came due this frame, in the order they were scheduled.
        // Ones scheduled while these run wait for the next frame.
        if (timers.current.length > 0) {
            const due: ScheduledRun[] = [];
            timers.current = timers.current.filter(timer => {
                timer.remaining -= delta;
                if (timer.remaining > TIMER_EPSILON) return true;
                due.push(timer);
                return false;
            });
            due.forEach(timer => {
                if (!sessionEnded.current) timer.run();
            });
            if (sessionEnded.current) return;
        }

        // 2. Tick Event
        const tickNodes = blueprint.nodes.filter(n => n.name === 'Event Tick');
        tickNodes.forEach(node => executeNode(node.id, {}));

        // 3. Physics/Overlap Events
        if (!playerEntityRef.current) return;

        // Get Player World Position
        const playerPos = new THREE.Vector3();
        if (playerEntityRef.current.object) {
            playerEntityRef.current.object.getWorldPosition(playerPos);
        } else {
            return;
        }

        const currentOverlaps = new Set<string>();

        // Check distance against level objects without colliders (Simple Circle Collision)
        if (levelObjects) {
            levelObjects.forEach(obj => {
                if (hasCollider(obj)) return;
                const objPos = new THREE.Vector3(...obj.position);
                const radius = Math.max(obj.scale[0], obj.scale[2]) * 1.0; 
                const playerRadius = 0.5;
                const dist = playerPos.distanceTo(objPos);

                if (dist < (radius + playerRadius)) {
                    currentOverlaps.add(obj.id);
                    
                    // Trigger 'Begin Overlap' only on entry
                    if (!overlappingIds.current.has(obj.id)) {
                        // Find matching event nodes (by actor id; legacy name-only events by name)
                        const eventNodes = blueprint.nodes.filter(n =>
                            isOverlapEvent(n) && overlapEventTargets(n, obj)
                        );

                        eventNodes.forEach(node => {
                            executeNode(node.id, { otherActorId: obj.id });
                        });
                    }
                }
            });
        }
        
        overlappingIds.current = currentOverlaps;
    });
};
