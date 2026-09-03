
import React, { useRef, useCallback, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { LevelBlueprintData, LevelObject } from '../types';
import { SandboxEntityHandle } from '../components/Sandbox/SandboxEntity';
import { GraphRuntimeAPI } from '../components/AnimationGraph/GraphRuntime';
import { frontendDiagnostics } from '../diagnostics/runtime';

const MAX_BLUEPRINT_EVALUATION_DEPTH = 128;
const MAX_BLUEPRINT_EXECUTION_DEPTH = 256;

/**
 * Interface for the Level Blueprint Runtime.
 */
interface UseLevelBlueprintRuntimeProps {
    blueprint: LevelBlueprintData;
    levelObjects: LevelObject[];
    playerEntityRef: React.RefObject<SandboxEntityHandle>;
    playerApiRef: React.MutableRefObject<GraphRuntimeAPI | undefined>;
    enemyApiRef: React.MutableRefObject<GraphRuntimeAPI | undefined>;
    removeLevelObject: (id: string) => void;
    addNotification: (notification: any) => void;
    onRestart?: () => void;
    onEndLevel?: () => void;
}

/**
 * THE LEVEL BLUEPRINT RUNTIME ENGINE
 * 
 * This hook is responsible for executing the visual logic graph defined in the Level Blueprint.
 * It handles:
 * 1. Event Triggers (BeginPlay, Tick, Overlap).
 * 2. Forward Execution Flow (executing nodes in sequence).
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
    removeLevelObject,
    addNotification,
    onRestart,
    onEndLevel
}: UseLevelBlueprintRuntimeProps) => {
    
    // Tracks objects currently overlapping the player to prevent spamming 'OnOverlap' events every frame.
    const overlappingIds = useRef<Set<string>>(new Set());
    
    // Stores the current frame's delta time for the 'Event Tick' node.
    const currentDelta = useRef<number>(0);
    
    // -------------------------------------------------------------------------
    // 1. DATA EVALUATION (Recursive Backwards Trace)
    // -------------------------------------------------------------------------

    /**
     * Calculates the value of a specific input pin on a node by tracing backwards
     * through the graph connections.
     * 
     * @param nodeId The ID of the node requesting the value.
     * @param inputPinId The ID of the input pin on that node.
     * @returns The evaluated value (number, boolean, string, etc.) or null.
     */
    const evaluateInput = useCallback((nodeId: string, inputPinId: string): any => {
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
                // Special case: Event nodes providing data (like Tick -> Delta Seconds)
                if (sourceNode.name === 'Event Tick') {
                    const pin = sourceNode.outputs.find(p => p.id === connection.fromPinId);
                    if (pin?.name === 'Delta Seconds') return currentDelta.current;
                }
                return null;
            }

            // --- LITERALS ---
            case 'LiteralFloat':
            case 'LiteralInteger':
            case 'LiteralString':
            case 'LiteralBoolean': {
                return sourceNode.data?.value;
            }

            case 'ToString': {
                const val = evaluate(sourceNode.id, sourceNode.inputs[0].id, nextPath, depth + 1);
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
            case 'Add': {
                const a = Number(evaluate(sourceNode.id, sourceNode.inputs[0].id, nextPath, depth + 1) ?? 0);
                const b = Number(evaluate(sourceNode.id, sourceNode.inputs[1].id, nextPath, depth + 1) ?? 0);
                // Check if outputs expect Int to determine rounding, or rely on JS floats
                const isInt = sourceNode.outputs[0].dataType === 'Integer';
                const result = a + b;
                return isInt ? Math.floor(result) : result;
            }
            case 'Subtract': {
                const a = Number(evaluate(sourceNode.id, sourceNode.inputs[0].id, nextPath, depth + 1) ?? 0);
                const b = Number(evaluate(sourceNode.id, sourceNode.inputs[1].id, nextPath, depth + 1) ?? 0);
                const isInt = sourceNode.outputs[0].dataType === 'Integer';
                const result = a - b;
                return isInt ? Math.floor(result) : result;
            }
            case 'Multiply': {
                const a = Number(evaluate(sourceNode.id, sourceNode.inputs[0].id, nextPath, depth + 1) ?? 0);
                const b = Number(evaluate(sourceNode.id, sourceNode.inputs[1].id, nextPath, depth + 1) ?? 0);
                const isInt = sourceNode.outputs[0].dataType === 'Integer';
                const result = a * b;
                return isInt ? Math.floor(result) : result;
            }
            case 'Divide': {
                const a = Number(evaluate(sourceNode.id, sourceNode.inputs[0].id, nextPath, depth + 1) ?? 0);
                const b = Number(evaluate(sourceNode.id, sourceNode.inputs[1].id, nextPath, depth + 1) ?? 0);
                const isInt = sourceNode.outputs[0].dataType === 'Integer';
                const result = b !== 0 ? a / b : 0;
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

            default:
                return null;
        }
        };
        return evaluate(nodeId, inputPinId, new Set(), 0);
    }, [blueprint, playerApiRef, enemyApiRef]);

    // -------------------------------------------------------------------------
    // 2. EXECUTION FLOW (Forward Trace)
    // -------------------------------------------------------------------------

    /**
     * Executes the logic for a specific node and then triggers the next node in the chain.
     * 
     * @param nodeId The ID of the node to execute.
     * @param context Contextual data passed from the event trigger (e.g. Other Actor ID).
     */
    const executeNode = useCallback((nodeId: string, context: any, path: Set<string> = new Set(), depth = 0) => {
        if (depth >= MAX_BLUEPRINT_EXECUTION_DEPTH || path.has(nodeId)) return;
        const nextPath = new Set(path);
        nextPath.add(nodeId);
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
                const val = evaluateInput(node.id, stringPin.id);
                if (val !== null && val !== undefined) {
                    msg = String(val);
                }
            }
            
            // Use blue/info type for BP logs to distinguish them
            addNotification({ message: `[Output] ${msg}`, type: 'info', duration: 3000 });
        } 
        else if (node.type === 'DestroyActor') {
            // Context usually comes from Overlap event
            if (context.otherActorId) {
                removeLevelObject(context.otherActorId);
                addNotification({ message: `Actor destroyed`, type: 'success' });
            }
        }
        else if (node.type === 'LevelAction') {
            const action = node.data?.action;
            if (action === 'Restart' && onRestart) {
                addNotification({ message: "Restarting Level...", type: 'info' });
                onRestart();
                return; // Stop execution
            }
            if (action === 'EndGame' && onEndLevel) {
                addNotification({ message: "Level Ended.", type: 'info' });
                onEndLevel();
                return; // Stop execution
            }
        }
        else if (node.type === 'Branch') {
            // Evaluate Condition Input
            const condPin = node.inputs.find(p => p.name === 'Condition');
            const condition = condPin ? evaluateInput(node.id, condPin.id) : false;
            
            // Route flow based on result
            nextExecPinName = condition ? 'True' : 'False';
        }
        else if (node.type === 'VariableSet') {
            const target = node.data?.targetBlueprintType || 'Player';
            const varName = node.data?.variableName;
            const valPin = node.inputs.find(p => p.name === 'Value');
            const value = valPin ? evaluateInput(node.id, valPin.id) : null;

            const api = target === 'Enemy' ? enemyApiRef.current : playerApiRef.current;
            if (api && varName && value !== null) {
                api.setVariable(varName, value);
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
                // Recursively call next node
                executeNode(connection.toNodeId, context, nextPath, depth + 1);
            }
        }
    }, [blueprint, evaluateInput, removeLevelObject, addNotification, playerApiRef, enemyApiRef, onRestart, onEndLevel]);

    // -------------------------------------------------------------------------
    // 3. LIFECYCLE HOOKS
    // -------------------------------------------------------------------------
    
    // --- Event: BeginPlay ---
    useEffect(() => {
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

    // --- Event: Tick & Overlap Physics ---
    useFrame((state, delta) => {
        currentDelta.current = delta;

        // 1. Tick Event
        const tickNodes = blueprint.nodes.filter(n => n.name === 'Event Tick');
        tickNodes.forEach(node => executeNode(node.id, {}));

        // 2. Physics/Overlap Events
        if (!playerEntityRef.current) return;

        // Get Player World Position
        const playerPos = new THREE.Vector3();
        if (playerEntityRef.current.object) {
            playerEntityRef.current.object.getWorldPosition(playerPos);
        } else {
            return;
        }

        const currentOverlaps = new Set<string>();

        // Check distance against all level objects (Simple Circle Collision)
        if (levelObjects) {
            levelObjects.forEach(obj => {
                const objPos = new THREE.Vector3(...obj.position);
                const radius = Math.max(obj.scale[0], obj.scale[2]) * 1.0; 
                const playerRadius = 0.5;
                const dist = playerPos.distanceTo(objPos);

                if (dist < (radius + playerRadius)) {
                    currentOverlaps.add(obj.id);
                    
                    // Trigger 'Begin Overlap' only on entry
                    if (!overlappingIds.current.has(obj.id)) {
                        // Find matching event nodes
                        const eventNodes = blueprint.nodes.filter(n => 
                            n.type === 'Event' && 
                            n.name.includes('Overlap') &&
                            n.data?.targetActorName === obj.name 
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
