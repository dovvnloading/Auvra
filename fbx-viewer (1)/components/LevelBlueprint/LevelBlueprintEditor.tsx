
import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { Send, Crown, Video, Play, GitBranch, CheckSquare, Database, Trash2, ArrowLeft, MessageSquare, Box, Shield, Skull, Calculator, Timer, Hash, Type, ToggleLeft, Activity, X, LayoutTemplate, RefreshCcw, DoorOpen, Save, FolderOpen, Undo2, Redo2, Car, Bomb, Zap } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import { LogicCanvas, LogicGraphSnapshot } from './LogicCanvas';
import { LevelBlueprintInspector } from './LevelBlueprintInspector';
import { LogicNodeDefinition, logicNodeIcon } from './LogicNode';
import { LevelVariablesPanel, LevelVariableEdit, LevelVariableEntry, LevelVariableNodeType, levelVariableTypeOf, renameLevelVariableReferences } from './LevelVariablesPanel';
import { LogicNode, LogicConnection, PrefabData, LevelBlueprintData } from '../../types';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { useEditorHistory } from '../../utils/history';
import { projectService } from '../../utils/projectService';
import { appAlert } from '../../utils/appDialogs';
import { migrateLegacyOverlapTargets, overlapEventName, overlapTargetData } from './overlapTargets';
import { FLOW_NODE_DEFINITIONS } from '../../hooks/levelBlueprintNodes/flow';
import { PLAYER_ACTOR_ID, WORLD_NODE_DEFINITIONS, WorldNodeType } from '../../hooks/levelBlueprintNodes/world';

// Repeated edits to the same field within this window (typing) merge into a single undo step.
const HISTORY_COALESCE_MS = 1000;

/** Palette sections for the registry-driven nodes, in display order. */
const WORLD_PALETTE_GROUPS: { label: string, types: WorldNodeType[] }[] = [
    { label: 'Actors', types: ['SpawnPrefab', 'GetActorTransform', 'SetActorTransform', 'ApplyImpulse', 'Raycast'] },
    { label: 'Audio & Input', types: ['PlaySound', 'MakeNoise', 'InputActionPressed'] },
    { label: 'Animation', types: ['PlayPlayerAnimation', 'SetMorphTarget'] },
    { label: 'Player', types: ['DamagePlayer', 'HealPlayer', 'GetPlayerHealth', 'AddAmmo', 'GiveWeapon'] },
    { label: 'Splines', types: ['GetSplineLength', 'GetSplinePoint', 'FindClosestOnSpline'] },
    { label: 'Vehicles', types: ['EnterVehicle', 'ExitVehicle', 'GetVehicleState', 'GetPlayerVehicle', 'SetVehicleInput', 'ReleaseVehicleInput'] },
    { label: 'Particles', types: ['PlayParticles', 'StopParticles', 'EmitParticles', 'GetParticles'] },
    { label: 'Time & Weather', types: ['SetTimeOfDay', 'GetTimeOfDay', 'SetDayLength', 'SetWeather', 'GetWeather'] },
    { label: 'Destruction', types: ['Explode', 'BreakObject', 'DamageObject', 'GetObjectHealth'] },
    { label: 'Abilities', types: ['UseAbility', 'ApplyEffect', 'RemoveEffect', 'GetAttribute', 'ChangeAttribute', 'HasTag', 'AddTag', 'RemoveTag', 'GetAbilityCooldown'] },
    { label: 'Level Variables', types: ['GetLevelVariable', 'SetLevelVariable'] },
    { label: 'Utilities', types: ['RandomFloat', 'RandomInt', 'Print'] },
];

const REGISTRY_PALETTE: { label: string, definitions: LogicNodeDefinition[] }[] = (() => {
    const groups: { label: string, definitions: LogicNodeDefinition[] }[] = [
        { label: 'Flow Control', definitions: [...FLOW_NODE_DEFINITIONS] },
        ...WORLD_PALETTE_GROUPS.map(group => ({
            label: group.label,
            definitions: group.types
                .map(type => WORLD_NODE_DEFINITIONS.find(definition => definition.type === type))
                .filter((definition): definition is (typeof WORLD_NODE_DEFINITIONS)[number] => !!definition),
        })),
    ];
    // World nodes added to the registry later still reach the palette before they get a section.
    const grouped = new Set<string>(WORLD_PALETTE_GROUPS.flatMap(group => group.types));
    const ungrouped = WORLD_NODE_DEFINITIONS.filter(definition => !grouped.has(definition.type));
    if (ungrouped.length > 0) groups.push({ label: 'World', definitions: [...ungrouped] });
    return groups.filter(group => group.definitions.length > 0);
})();

/** Sorted, distinct names of the bones or morph targets under some models, for the Animation nodes' suggestions. */
const modelPartNames = (objects: THREE.Object3D[], part: 'bones' | 'morphs'): string[] => {
    const names = new Set<string>();
    objects.forEach(object => object.traverse(child => {
        if (part === 'bones' && (child as THREE.Bone).isBone && child.name) names.add(child.name);
        const dictionary = part === 'morphs' && (child as THREE.Mesh).isMesh ? (child as THREE.Mesh).morphTargetDictionary : undefined;
        if (dictionary) Object.keys(dictionary).forEach(name => names.add(name));
    }));
    return [...names].sort((a, b) => a.localeCompare(b));
};

/** Ids of every pin on a node, used to drop wires to pins an edit removed. */
const pinIdsOf = (node: Pick<LogicNode, 'inputs' | 'outputs'>) => new Set([...node.inputs, ...node.outputs].map(pin => pin.id));

/** Identifies which fields of a node an inspector edit changes, so keystrokes in one field coalesce. */
const nodeEditKey = (node: LogicNode, updates: Partial<LogicNode>) => {
    const fields = Object.keys(updates).filter(key => key !== 'data');
    if (updates.data) {
        const before = node.data || {};
        Object.keys(updates.data).forEach(key => {
            if (updates.data[key] !== before[key]) fields.push(`data.${key}`);
        });
    }
    return `inspector:${node.id}:${fields.sort().join(',')}`;
};

interface LevelBlueprintEditorProps {
    onClose: () => void;
    selectedObjectId?: string | null;
}

/**
 * THE LEVEL BLUEPRINT EDITOR
 * 
 * Acts as the "Controller" for the blueprint editing session.
 * - Manages the sidebar of available actions.
 * - Aggregates context variables (from Player/Enemy blueprints) to expose to the graph.
 * - Handles adding new nodes to the active graph.
 */
export const LevelBlueprintEditor: React.FC<LevelBlueprintEditorProps> = ({ onClose, selectedObjectId }) => {
    const { activeLevelBlueprint, updateLevelBlueprint, blueprints, levelObjects, levels, currentLevelId, audioAssets, models } = useScene();
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

    // Prefabs live in their own project domain (not scene state); Spawn Prefab nodes pick from them.
    // Without an open project there are none, and the db layer (IndexedDB-backed) is never loaded.
    const [prefabs, setPrefabs] = useState<PrefabData[]>([]);
    useEffect(() => {
        if (!projectService.getStatus().projectId) return;
        let cancelled = false;
        import('../../utils/db')
            .then(({ dbOperations }) => dbOperations.getAllPrefabs())
            .then(loaded => {
                if (!cancelled && loaded.length > 0) setPrefabs([...loaded].sort((a, b) => a.name.localeCompare(b.name)));
            })
            .catch(error => {
                if (!cancelled) frontendDiagnostics.failure('level_blueprint_prefab_list_failed', error);
            });
        return () => { cancelled = true; };
    }, []);

    // --- 0. UNDO / REDO ---

    const graph = useMemo<LogicGraphSnapshot>(
        () => ({ nodes: activeLevelBlueprint.nodes, connections: activeLevelBlueprint.connections, variables: activeLevelBlueprint.variables }),
        [activeLevelBlueprint.nodes, activeLevelBlueprint.connections, activeLevelBlueprint.variables]
    );
    const lastEdit = useRef<{ key: string; at: number } | null>(null);
    const applyGraph = useCallback((restored: LogicGraphSnapshot) => {
        lastEdit.current = null;
        try {
            updateLevelBlueprint({ nodes: restored.nodes, connections: restored.connections, variables: restored.variables });
        } catch (error) {
            frontendDiagnostics.failure('level_blueprint_history_apply_failed', error);
        }
    }, [updateLevelBlueprint]);
    // The editor is only mounted while it is the visible overlay, so its shortcuts are always live.
    const history = useEditorHistory<LogicGraphSnapshot>({
        value: graph,
        apply: applyGraph,
        active: true,
        resetKey: currentLevelId,
    });
    const { record } = history;
    const recordHistory = useCallback((before?: LogicGraphSnapshot, coalesceKey?: string) => {
        const now = Date.now();
        const previous = lastEdit.current;
        lastEdit.current = coalesceKey ? { key: coalesceKey, at: now } : null;
        if (coalesceKey && previous?.key === coalesceKey && now - previous.at < HISTORY_COALESCE_MS) return;
        record(before);
    }, [record]);

    // --- 1. DATA AGGREGATION ---
    
    // Collect all variables from Player and Enemy blueprints to allow the Level Logic to read/write them.
    // This connects the Level Logic to the Entity Logic.
    const contextVariables = useMemo(() => {
        const vars: { blueprintId: string, blueprintType: string, blueprintName: string, name: string, type: string, id: string }[] = [];
        
        if (blueprints) {
            blueprints.forEach(bp => {
                if (bp.type === 'Player Character' || bp.type === 'Enemy Controller') {
                    const typeLabel = bp.type === 'Player Character' ? 'Player' : 'Enemy';
                    
                    // 1. Graph Variables (Explicit Logic)
                    if (bp.variables) {
                        bp.variables.forEach(v => {
                            vars.push({ 
                                blueprintId: bp.id,
                                blueprintType: typeLabel,
                                blueprintName: bp.name, 
                                name: v.name, 
                                type: v.type,
                                id: v.id
                            });
                        });
                    }

                    // 2. Blueprint Stats (Health, Stamina, etc.)
                    if (bp.stats) {
                        bp.stats.forEach(s => {
                            // Prevent duplicates if a variable and stat share a name (rare but possible)
                            if (!vars.some(existing => existing.blueprintId === bp.id && existing.name === s.name)) {
                                vars.push({
                                    blueprintId: bp.id,
                                    blueprintType: typeLabel,
                                    blueprintName: bp.name,
                                    name: s.name,
                                    type: 'Float', // Stats are always numbers
                                    id: s.id
                                });
                            }
                        });
                    }
                }
            });
        }
        return vars;
    }, [blueprints]);

    // --- 2. NODE CREATION FACTORY ---

    const addNode = (type: string, name: string, inputs: any[], outputs: any[], data?: any) => {
        const newNode: LogicNode = {
            id: crypto.randomUUID(),
            type: type as any,
            name,
            position: { x: 300, y: 300 }, // Default spawn location
            inputs: inputs.map((p, i) => ({ id: crypto.randomUUID(), ...p })),
            outputs: outputs.map((p, i) => ({ id: crypto.randomUUID(), ...p })),
            data
        };
        recordHistory();
        updateLevelBlueprint({ nodes: [...activeLevelBlueprint.nodes, newNode] });
    };

    // --- 3. CONTEXTUAL ACTIONS ---

    const handleAddBeginOverlap = () => {
        // If an object was selected in the environment before opening BP, pre-select it,
        // otherwise fall back to the first available object.
        const target = (selectedObjectId && levelObjects.find(o => o.id === selectedObjectId)) || levelObjects[0];

        addNode('Event', target ? overlapEventName(target) : 'On Overlap (Select Actor)', [],
            [
                { name: 'Exec', dataType: 'Exec', direction: 'Output' },
                { name: 'Other Actor', dataType: 'Object', direction: 'Output' }
            ],
            target ? overlapTargetData(undefined, target) : {}
        );
    };

    // Legacy overlap events referenced their actor by name. Once a name identifies exactly one
    // actor, persist the stable id instead; ambiguous or missing names stay as they are and are
    // flagged on the node and in the inspector. The ref keeps a StrictMode re-run, or a failed
    // write rolling back to the same nodes, from persisting the migration again.
    const migratedNodes = useRef<LogicNode[] | null>(null);
    useEffect(() => {
        if (migratedNodes.current === activeLevelBlueprint.nodes) return;
        const migrated = migrateLegacyOverlapTargets(activeLevelBlueprint.nodes, levelObjects);
        if (!migrated) return;
        try {
            updateLevelBlueprint({ nodes: migrated });
            migratedNodes.current = activeLevelBlueprint.nodes;
        } catch (error) {
            frontendDiagnostics.failure('level_blueprint_target_migration_failed', error);
        }
    }, [activeLevelBlueprint.nodes, levelObjects, updateLevelBlueprint]);

    const handleAddEvent = (type: string, label: string) => {
        if (type === 'BeginPlay') {
            addNode('Event', 'Event BeginPlay', [], [{ name: 'Exec', dataType: 'Exec', direction: 'Output' }]);
        } else if (type === 'NetworkEvent') {
            addNode('Event', 'Event NetworkEvent', [], [
                { name: 'Exec', dataType: 'Exec', direction: 'Output' },
                { name: 'Value', dataType: 'String', direction: 'Output' },
                { name: 'From', dataType: 'String', direction: 'Output' }
            ], { eventName: '' });
        } else if (type === 'TimelineEvent') {
            addNode('Event', 'Event TimelineEvent', [], [{ name: 'Exec', dataType: 'Exec', direction: 'Output' }], { eventName: '' });
        } else if (type === 'DialogueEvent') {
            addNode('Event', 'Event DialogueEvent', [], [{ name: 'Exec', dataType: 'Exec', direction: 'Output' }], { eventName: '' });
        } else if (type === 'VehicleEntered' || type === 'VehicleExited') {
            addNode('Event', `Event ${type}`, [], [
                { name: 'Exec', dataType: 'Exec', direction: 'Output' },
                { name: 'Vehicle', dataType: 'Object', direction: 'Output' }
            ], { vehicleId: '' });
        } else if (type === 'ObjectBroken') {
            addNode('Event', 'Event ObjectBroken', [], [
                { name: 'Exec', dataType: 'Exec', direction: 'Output' },
                { name: 'Actor', dataType: 'Object', direction: 'Output' }
            ], { actorId: '' });
        } else if (type === 'AbilityUsed') {
            addNode('Event', 'Event AbilityUsed', [], [
                { name: 'Exec', dataType: 'Exec', direction: 'Output' },
                { name: 'Actor', dataType: 'Object', direction: 'Output' },
                { name: 'Ability', dataType: 'String', direction: 'Output' },
                { name: 'Target', dataType: 'Object', direction: 'Output' }
            ], { actorId: '', abilityId: '' });
        } else if (type === 'ActorDied') {
            addNode('Event', 'Event ActorDied', [], [
                { name: 'Exec', dataType: 'Exec', direction: 'Output' },
                { name: 'Actor', dataType: 'Object', direction: 'Output' }
            ], { actorId: '' });
        } else if (type === 'AnimNotify') {
            addNode('Event', 'Event AnimNotify', [], [{ name: 'Exec', dataType: 'Exec', direction: 'Output' }], { notifyName: '', notifySource: 'player' });
        } else if (type === 'Tick') {
            addNode('Event', 'Event Tick', [], [
                { name: 'Exec', dataType: 'Exec', direction: 'Output' },
                { name: 'Delta Seconds', dataType: 'Float', direction: 'Output' }
            ]);
        }
    };

    const handleAddSendNetworkEvent = () => {
        addNode('SendNetworkEvent', 'Send Network Event',
            [
                { name: 'Exec', dataType: 'Exec', direction: 'Input' },
                { name: 'Name', dataType: 'String', direction: 'Input' },
                { name: 'Value', dataType: 'String', direction: 'Input' }
            ],
            [{ name: 'Out', dataType: 'Exec', direction: 'Output' }],
            { default_Name: 'event', default_Value: '' }
        );
    };

    const handleAddSetActiveCamera = () => {
        addNode('SetActiveCamera', 'Set Active Camera',
            [{ name: 'Exec', dataType: 'Exec', direction: 'Input' }, { name: 'Blend', dataType: 'Float', direction: 'Input' }],
            [{ name: 'Out', dataType: 'Exec', direction: 'Output' }],
            { cameraId: '', default_Blend: 0 }
        );
    };

    const handleAddStartDialogue = () => {
        addNode('StartDialogue', 'Start Dialogue',
            [{ name: 'Exec', dataType: 'Exec', direction: 'Input' }],
            [{ name: 'Out', dataType: 'Exec', direction: 'Output' }],
            { targetObjectId: '' }
        );
    };

    const handleAddIsNetworkHost = () => {
        addNode('IsNetworkHost', 'Is Network Host', [], [{ name: 'Is Host', dataType: 'Boolean', direction: 'Output' }]);
    };

    const handleAddPrintString = () => {
        addNode('PrintString', 'Print String', 
            [
                { name: 'Exec', dataType: 'Exec', direction: 'Input' },
                { name: 'String', dataType: 'String', direction: 'Input' }
            ], 
            [
                { name: 'Out', dataType: 'Exec', direction: 'Output' }
            ],
            { printMessage: "Hello World", default_String: "Hello World" }
        );
    };

    const handleAddDestroyActor = () => {
        addNode('DestroyActor', 'Destroy Actor', 
            [
                { name: 'Exec', dataType: 'Exec', direction: 'Input' }
            ],
            [
                { name: 'Out', dataType: 'Exec', direction: 'Output' }
            ]
        );
    };

    const handleAddLevelAction = (action: 'Restart' | 'EndGame' | 'OpenLevel' | 'SaveGame' | 'LoadGame', label: string) => {
        addNode('LevelAction', label, 
            [
                { name: 'Exec', dataType: 'Exec', direction: 'Input' }
            ],
            [
                { name: 'Out', dataType: 'Exec', direction: 'Output' }
            ],
            { action }
        );
    };

    const handleAddBranch = () => {
        addNode('Branch', 'Branch (If)', 
            [
                { name: 'Exec', dataType: 'Exec', direction: 'Input' },
                { name: 'Condition', dataType: 'Boolean', direction: 'Input' }
            ],
            [
                { name: 'True', dataType: 'Exec', direction: 'Output' },
                { name: 'False', dataType: 'Exec', direction: 'Output' }
            ]
        );
    };

    const handleAddMath = (type: string, label: string, dataType: 'Float' | 'Integer' = 'Float') => {
        addNode(type, label, 
            [
                { name: 'Exec', dataType: 'Exec', direction: 'Input' },
                { name: 'A', dataType: dataType, direction: 'Input' },
                { name: 'B', dataType: dataType, direction: 'Input' }
            ], 
            [
                { name: 'Out', dataType: 'Exec', direction: 'Output' },
                { name: 'Result', dataType: dataType, direction: 'Output' }
            ]
        );
    };

    const handleAddCompare = (type: string, label: string) => {
        addNode(type, label, 
            [
                { name: 'Exec', dataType: 'Exec', direction: 'Input' },
                { name: 'A', dataType: 'Float', direction: 'Input' },
                { name: 'B', dataType: 'Float', direction: 'Input' }
            ], 
            [
                { name: 'Out', dataType: 'Exec', direction: 'Output' },
                { name: 'Result', dataType: 'Boolean', direction: 'Output' }
            ]
        );
    };

    const handleAddToString = () => {
        addNode('ToString', 'To String', 
            [
                { name: 'Exec', dataType: 'Exec', direction: 'Input' },
                { name: 'Value', dataType: 'Float', direction: 'Input' }
            ], 
            [
                { name: 'Out', dataType: 'Exec', direction: 'Output' },
                { name: 'String', dataType: 'String', direction: 'Output' }
            ]
        );
    };

    const handleAddLiteral = (type: 'Float' | 'Integer' | 'String' | 'Boolean') => {
        const defaults: Record<string, any> = { 'Float': 0.0, 'Integer': 0, 'String': "Text", 'Boolean': false };
        addNode(`Literal${type}`, `# ${type}`, 
            [], 
            [{ name: 'Value', dataType: type as any, direction: 'Output' }],
            { value: defaults[type] }
        );
    };

    const handleAddVariableGet = (v: typeof contextVariables[0]) => {
        addNode('VariableGet', `Get ${v.name}`, 
            [], 
            [{ name: 'Value', dataType: v.type as any, direction: 'Output' }], 
            { variableName: v.name, targetBlueprintType: v.blueprintType }
        );
    };

    const handleAddVariableSet = (v: typeof contextVariables[0]) => {
        addNode('VariableSet', `Set ${v.name}`, 
            [
                { name: 'Exec', dataType: 'Exec', direction: 'Input' },
                { name: 'Value', dataType: v.type as any, direction: 'Input' }
            ], 
            [
                { name: 'Out', dataType: 'Exec', direction: 'Output' }
            ], 
            { variableName: v.name, targetBlueprintType: v.blueprintType }
        );
    };

    /** Places a flow or world registry node with its declared pins and default data. */
    const handleAddDefinitionNode = (definition: LogicNodeDefinition) => {
        const data: Record<string, unknown> = { ...(definition.data || {}) };
        let name = definition.title;
        // Like Actor Begin Overlap: an actor selected in the environment becomes the node's target.
        const takesActor = definition.inputs.some(pin => pin.name === 'Actor' && pin.dataType === 'Object');
        const actor = takesActor && selectedObjectId ? levelObjects.find(o => o.id === selectedObjectId) : undefined;
        if (actor) {
            data.default_Actor = actor.id;
            name = `${definition.title} (${actor.name})`;
        }
        addNode(definition.type, name, definition.inputs, definition.outputs, Object.keys(data).length > 0 ? data : undefined);
    };

    /** Get/Set Level Variable node already naming a declared variable (the panel's GET / SET buttons). */
    const handleAddLevelVariableNode = (type: LevelVariableNodeType, variableName: string) => {
        const definition = WORLD_NODE_DEFINITIONS.find(d => d.type === type);
        if (!definition) return;
        addNode(type, `${definition.title} (${variableName})`, definition.inputs, definition.outputs, { ...(definition.data || {}), default_Name: variableName });
    };

    // --- LEVEL VARIABLES ---

    const handleVariablesChange = (variables: LevelVariableEntry[], edit: LevelVariableEdit) => {
        // Typing a default merges into one undo step like inspector fields; every other edit is its own step.
        recordHistory(undefined, edit.kind === 'value' ? `variables:${edit.index}:value` : undefined);
        // Entries written by the panel always carry an id; older stored ones may not.
        const updates: Partial<LevelBlueprintData> = { variables: variables as LevelBlueprintData['variables'] };
        if (edit.kind === 'rename') {
            // Nodes that used the old name follow the rename in the same write (and undo step).
            const nodes = renameLevelVariableReferences(activeLevelBlueprint.nodes, edit.from, edit.to);
            if (nodes !== activeLevelBlueprint.nodes) updates.nodes = nodes;
        }
        updateLevelBlueprint(updates);
    };

    // --- TEMPLATES ---
    const handleAddRestartTemplate = () => {
        // Only require that a Player Blueprint exists.
        // We do NOT strictly check for 'IsDead' variable in the variable list
        // because it is often a virtual variable injected by the Sandbox Runtime.
        const hasPlayer = blueprints.some(bp => bp.type === 'Player Character');
        
        if (!hasPlayer) {
            // Warn if no player exists to target
            void appAlert('No Player Character blueprint found.', 'Create a blueprint of type Player Character first.');
            return;
        }

        const nodes: LogicNode[] = [];
        const connections: LogicConnection[] = [];
        // Below the graph's existing nodes, so the template never lands on top of them.
        const existing = activeLevelBlueprint.nodes;
        const startX = existing.length ? Math.min(...existing.map(node => node.position.x)) : 200;
        const startY = existing.length ? Math.max(...existing.map(node => node.position.y)) + 300 : 200;

        // 1. Tick
        const tickId = crypto.randomUUID();
        const tickExecOut = crypto.randomUUID();
        nodes.push({
            id: tickId, type: 'Event', name: 'Event Tick', position: { x: startX, y: startY },
            inputs: [], outputs: [{ id: tickExecOut, name: 'Exec', dataType: 'Exec', direction: 'Output' }, { id: crypto.randomUUID(), name: 'Delta Seconds', dataType: 'Float', direction: 'Output' }]
        });

        // 2. Get IsDead
        const getId = crypto.randomUUID();
        const getValOut = crypto.randomUUID();
        nodes.push({
            id: getId, type: 'VariableGet', name: 'Get IsDead', position: { x: startX, y: startY + 150 },
            inputs: [], outputs: [{ id: getValOut, name: 'Value', dataType: 'Boolean', direction: 'Output' }],
            data: { variableName: 'IsDead', targetBlueprintType: 'Player' }
        });

        // 3. Branch
        const branchId = crypto.randomUUID();
        const branchExecIn = crypto.randomUUID();
        const branchCondIn = crypto.randomUUID();
        const branchTrueOut = crypto.randomUUID();
        nodes.push({
            id: branchId, type: 'Branch', name: 'Branch (If)', position: { x: startX + 300, y: startY },
            inputs: [{ id: branchExecIn, name: 'Exec', dataType: 'Exec', direction: 'Input' }, { id: branchCondIn, name: 'Condition', dataType: 'Boolean', direction: 'Input' }],
            outputs: [{ id: branchTrueOut, name: 'True', dataType: 'Exec', direction: 'Output' }, { id: crypto.randomUUID(), name: 'False', dataType: 'Exec', direction: 'Output' }]
        });

        // 4. Restart
        const restartId = crypto.randomUUID();
        const restartExecIn = crypto.randomUUID();
        nodes.push({
            id: restartId, type: 'LevelAction', name: 'Restart Level', position: { x: startX + 600, y: startY },
            inputs: [{ id: restartExecIn, name: 'Exec', dataType: 'Exec', direction: 'Input' }],
            outputs: [{ id: crypto.randomUUID(), name: 'Out', dataType: 'Exec', direction: 'Output' }],
            data: { action: 'Restart' }
        });

        // Connections
        connections.push({ id: crypto.randomUUID(), fromNodeId: tickId, fromPinId: tickExecOut, toNodeId: branchId, toPinId: branchExecIn });
        connections.push({ id: crypto.randomUUID(), fromNodeId: getId, fromPinId: getValOut, toNodeId: branchId, toPinId: branchCondIn });
        connections.push({ id: crypto.randomUUID(), fromNodeId: branchId, fromPinId: branchTrueOut, toNodeId: restartId, toPinId: restartExecIn });

        recordHistory();
        updateLevelBlueprint({ nodes: [...activeLevelBlueprint.nodes, ...nodes], connections: [...activeLevelBlueprint.connections, ...connections] });
    };

    // --- 4. STATE MANAGEMENT ---

    const handleDelete = () => {
        if (selectedNodeId && activeLevelBlueprint.nodes.some(n => n.id === selectedNodeId)) {
            recordHistory();
            const newNodes = activeLevelBlueprint.nodes.filter(n => n.id !== selectedNodeId);
            // Cleanup connections attached to deleted node
            const newConns = activeLevelBlueprint.connections.filter(c => c.fromNodeId !== selectedNodeId && c.toNodeId !== selectedNodeId);
            updateLevelBlueprint({ nodes: newNodes, connections: newConns });
            setSelectedNodeId(null);
        }
    };

    const handleNodeUpdate = (id: string, updates: Partial<LogicNode>) => {
        const node = activeLevelBlueprint.nodes.find(n => n.id === id);
        const changesPins = !!(updates.inputs || updates.outputs);
        // Pin edits (e.g. Sequence add/remove) are structural: each one is its own undo step.
        if (node) recordHistory(undefined, changesPins ? undefined : nodeEditKey(node, updates));
        const updatedNodes = activeLevelBlueprint.nodes.map(n => 
            n.id === id ? { ...n, ...updates } : n
        );
        if (node && changesPins) {
            // Drop wires to pins the edit removed, in the same write as the node.
            const pins = pinIdsOf({ inputs: updates.inputs ?? node.inputs, outputs: updates.outputs ?? node.outputs });
            const connections = activeLevelBlueprint.connections.filter(c =>
                (c.fromNodeId !== id || pins.has(c.fromPinId)) && (c.toNodeId !== id || pins.has(c.toPinId))
            );
            if (connections.length !== activeLevelBlueprint.connections.length) {
                updateLevelBlueprint({ nodes: updatedNodes, connections });
                return;
            }
        }
        updateLevelBlueprint({ nodes: updatedNodes });
    };

    const selectedNode = activeLevelBlueprint.nodes.find(n => n.id === selectedNodeId);

    // Inputs fed by a wire ignore their default value, so the inspector shows them as connected.
    const connectedPinIds = useMemo(
        () => new Set(activeLevelBlueprint.connections.flatMap(c => [c.fromPinId, c.toPinId])),
        [activeLevelBlueprint.connections]
    );
    const levelVariables = useMemo(
        () => ((activeLevelBlueprint.variables ?? []) as LevelVariableEntry[])
            .filter(v => typeof v.name === 'string' && v.name.trim() !== '')
            .map(v => ({ name: v.name.trim(), type: levelVariableTypeOf(v) })),
        [activeLevelBlueprint.variables]
    );

    // Suggestions for the Animation nodes. Play mode gives the player every model's clips; its character
    // is a Player Character blueprint's model.
    const animationClips = useMemo(
        () => [...new Set((models ?? []).flatMap(model => (model.animations ?? []).map(clip => clip.name)).filter(name => name !== ''))]
            .sort((a, b) => a.localeCompare(b)),
        [models]
    );
    const playerModels = useMemo(() => {
        const modelIds = new Set((blueprints ?? []).filter(bp => bp.type === 'Player Character').map(bp => bp.linkedModelId));
        return (models ?? []).filter(model => modelIds.has(model.id));
    }, [blueprints, models]);
    const playerBones = useMemo(() => modelPartNames(playerModels.map(model => model.object), 'bones'), [playerModels]);
    const morphTargetsOf = useCallback((actorId: string): string[] => {
        if (actorId === PLAYER_ACTOR_ID) return modelPartNames(playerModels.map(model => model.object), 'morphs');
        const modelId = levelObjects.find(obj => obj.id === actorId)?.modelId;
        const model = modelId ? (models ?? []).find(m => m.id === modelId) : undefined;
        return model ? modelPartNames([model.object], 'morphs') : [];
    }, [levelObjects, models, playerModels]);

    return (
        <div className="flex h-full w-full bg-gray-950 text-white font-sans overflow-hidden absolute inset-0 z-50">
            
            {/* LEFT SIDEBAR: PALETTE */}
            <div className="w-64 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0">
                <LevelVariablesPanel
                    variables={activeLevelBlueprint.variables}
                    onChange={handleVariablesChange}
                    onAddNode={handleAddLevelVariableNode}
                />
                <div className="p-4 border-b border-gray-800 bg-gray-950 flex items-center justify-between">
                    <span className="text-xs font-bold text-gray-200 tracking-wider">LOGIC PALETTE</span>
                </div>
                
                <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-4">
                    
                    {/* Templates */}
                    <div className="space-y-1">
                        <div className="px-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1">
                            <LayoutTemplate size={10} /> Templates
                        </div>
                        <button onClick={handleAddRestartTemplate} className="w-full text-left px-3 py-2 bg-blue-900/20 hover:bg-blue-900/40 border border-blue-900/50 rounded text-xs text-blue-300 flex items-center gap-2 group transition-colors">
                            <RefreshCcw size={12} /> Restart on Death
                        </button>
                    </div>

                    <div className="h-px bg-gray-800 w-full" />

                    {/* Events */}
                    <div className="space-y-1">
                        <div className="px-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Events</div>
                        <button onClick={() => handleAddEvent('BeginPlay', '')} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2 group">
                            <Activity size={12} className="text-red-400 group-hover:text-red-300" /> Event BeginPlay
                        </button>
                        <button onClick={() => handleAddEvent('Tick', '')} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2 group">
                            <Timer size={12} className="text-red-400 group-hover:text-red-300" /> Event Tick
                        </button>
                        <button onClick={handleAddBeginOverlap} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2 group">
                            <Box size={12} className="text-red-400 group-hover:text-red-300" /> Actor Begin Overlap
                        </button>
                        <button onClick={() => handleAddEvent('NetworkEvent', '')} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2 group">
                            <Activity size={12} className="text-red-400 group-hover:text-red-300" /> Network Event
                        </button>
                        <button onClick={() => handleAddEvent('TimelineEvent', '')} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2 group">
                            <Timer size={12} className="text-red-400 group-hover:text-red-300" /> Timeline Event
                        </button>
                        <button onClick={() => handleAddEvent('DialogueEvent', '')} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2 group">
                            <MessageSquare size={12} className="text-red-400 group-hover:text-red-300" /> Dialogue Event
                        </button>
                        <button onClick={() => handleAddEvent('VehicleEntered', '')} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2 group">
                            <Car size={12} className="text-red-400 group-hover:text-red-300" /> Vehicle Entered
                        </button>
                        <button onClick={() => handleAddEvent('VehicleExited', '')} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2 group">
                            <Car size={12} className="text-red-400 group-hover:text-red-300" /> Vehicle Exited
                        </button>
                        <button onClick={() => handleAddEvent('ObjectBroken', '')} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2 group">
                            <Bomb size={12} className="text-red-400 group-hover:text-red-300" /> Object Broken
                        </button>
                        <button onClick={() => handleAddEvent('AbilityUsed', '')} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2 group">
                            <Zap size={12} className="text-red-400 group-hover:text-red-300" /> Ability Used
                        </button>
                        <button onClick={() => handleAddEvent('ActorDied', '')} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2 group">
                            <Skull size={12} className="text-red-400 group-hover:text-red-300" /> Actor Died
                        </button>
                        <button onClick={() => handleAddEvent('AnimNotify', '')} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2 group">
                            <Activity size={12} className="text-red-400 group-hover:text-red-300" /> Animation Notify
                        </button>
                    </div>

                    {/* Cameras */}
                    <div className="space-y-1">
                        <div className="px-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Cameras</div>
                        <button onClick={handleAddSetActiveCamera} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2 group">
                            <Video size={12} className="text-pink-400 group-hover:text-pink-300" /> Set Active Camera
                        </button>
                    </div>

                    {/* Dialogue */}
                    <div className="space-y-1">
                        <div className="px-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Dialogue</div>
                        <button onClick={handleAddStartDialogue} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2 group">
                            <MessageSquare size={12} className="text-sky-400 group-hover:text-sky-300" /> Start Dialogue
                        </button>
                    </div>

                    {/* Multiplayer */}
                    <div className="space-y-1">
                        <div className="px-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Multiplayer</div>
                        <button onClick={handleAddSendNetworkEvent} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2 group">
                            <Send size={12} className="text-teal-400 group-hover:text-teal-300" /> Send Network Event
                        </button>
                        <button onClick={handleAddIsNetworkHost} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2 group">
                            <Crown size={12} className="text-teal-400 group-hover:text-teal-300" /> Is Network Host
                        </button>
                    </div>

                    {/* Values */}
                    <div className="space-y-1">
                        <div className="px-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Values</div>
                        <div className="grid grid-cols-2 gap-1 px-1">
                            <button onClick={() => handleAddLiteral('Float')} className="px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded text-[10px] text-green-400 border border-green-900/30 flex items-center justify-center gap-1"><Hash size={10} /> Float</button>
                            <button onClick={() => handleAddLiteral('Integer')} className="px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded text-[10px] text-cyan-400 border border-cyan-900/30 flex items-center justify-center gap-1"><Hash size={10} /> Int</button>
                            <button onClick={() => handleAddLiteral('String')} className="px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded text-[10px] text-pink-400 border border-pink-900/30 flex items-center justify-center gap-1"><Type size={10} /> String</button>
                            <button onClick={() => handleAddLiteral('Boolean')} className="px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded text-[10px] text-red-400 border border-red-900/30 flex items-center justify-center gap-1"><ToggleLeft size={10} /> Bool</button>
                        </div>
                    </div>

                    {/* Math */}
                    <div className="space-y-1">
                        <div className="px-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Math</div>
                        <div className="grid grid-cols-2 gap-1 px-1">
                            <button onClick={() => handleAddMath('Add', 'Add', 'Float')} className="px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded text-[10px] text-gray-300 flex items-center gap-2"><Calculator size={10} /> Add</button>
                            <button onClick={() => handleAddMath('Subtract', 'Sub', 'Float')} className="px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded text-[10px] text-gray-300 flex items-center gap-2"><Calculator size={10} /> Sub</button>
                            <button onClick={() => handleAddMath('Add', 'Add (Int)', 'Integer')} className="px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded text-[10px] text-gray-300 flex items-center gap-2"><Calculator size={10} /> Add (Int)</button>
                            <button onClick={() => handleAddToString()} className="px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded text-[10px] text-gray-300 flex items-center gap-2"><Type size={10} /> To Str</button>
                        </div>
                    </div>

                    {/* Actions */}
                    <div className="space-y-1">
                        <div className="px-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Actions</div>
                        <button onClick={handleAddPrintString} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2">
                            <MessageSquare size={12} className="text-pink-400" /> Print String
                        </button>
                        <button onClick={handleAddDestroyActor} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2">
                            <Trash2 size={12} className="text-red-400" /> Destroy Actor
                        </button>
                        <button onClick={() => handleAddLevelAction('Restart', 'Restart Level')} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2">
                            <RefreshCcw size={12} className="text-indigo-400" /> Restart Level
                        </button>
                        <button onClick={() => handleAddLevelAction('EndGame', 'End Game')} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2">
                            <X size={12} className="text-indigo-400" /> End Game
                        </button>
                        <button onClick={() => handleAddLevelAction('OpenLevel', 'Open Level')} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2">
                            <DoorOpen size={12} className="text-indigo-400" /> Open Level
                        </button>
                        <button onClick={() => handleAddLevelAction('SaveGame', 'Save Game')} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2">
                            <Save size={12} className="text-indigo-400" /> Save Game
                        </button>
                        <button onClick={() => handleAddLevelAction('LoadGame', 'Load Game')} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2">
                            <FolderOpen size={12} className="text-indigo-400" /> Load Game
                        </button>
                    </div>

                    {/* Logic */}
                    <div className="space-y-1">
                        <div className="px-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Logic</div>
                        <button onClick={handleAddBranch} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2">
                            <GitBranch size={12} className="text-gray-200" /> Branch (If)
                        </button>
                        <button onClick={() => handleAddCompare('Greater', 'Greater (>)' )} className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2">
                            <CheckSquare size={12} className="text-blue-400" /> Compare
                        </button>
                    </div>

                    {/* Flow control and world nodes (hooks/levelBlueprintNodes) */}
                    {REGISTRY_PALETTE.map(group => (
                        <div key={group.label} className="space-y-1">
                            <div className="px-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">{group.label}</div>
                            {group.definitions.map(definition => (
                                <button
                                    key={definition.type}
                                    onClick={() => handleAddDefinitionNode(definition)}
                                    title={definition.description}
                                    className="w-full text-left px-3 py-1.5 rounded hover:bg-gray-800 text-xs text-gray-300 flex items-center gap-2 [&>svg]:w-3 [&>svg]:h-3"
                                >
                                    {logicNodeIcon(definition.type)} {definition.title}
                                </button>
                            ))}
                        </div>
                    ))}

                    {/* Entity Variables */}
                    {contextVariables.length > 0 && (
                        <div className="space-y-1 pt-2 border-t border-gray-800">
                            <div className="px-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Entity Variables</div>
                            {contextVariables.map((v, i) => (
                                <div key={i} className="flex bg-gray-800 rounded mx-1 mb-1 border border-gray-700 overflow-hidden">
                                    <div className="px-2 py-1 bg-gray-900 flex items-center justify-center border-r border-gray-700">
                                        {v.blueprintType === 'Player' ? <Shield size={10} className="text-blue-400" /> : <Skull size={10} className="text-red-400" />}
                                    </div>
                                    <div className="flex-1 flex flex-col justify-center px-2 py-0.5 min-w-0">
                                        <div className="text-[10px] font-bold text-gray-300 truncate">{v.name}</div>
                                        <div className="text-[8px] text-gray-500 uppercase">{v.type}</div>
                                    </div>
                                    <div className="flex flex-col border-l border-gray-700">
                                        <button onClick={() => handleAddVariableGet(v)} className="flex-1 px-1.5 hover:bg-gray-700 text-[8px] text-gray-400 hover:text-white uppercase font-bold transition-colors">GET</button>
                                        <div className="h-px bg-gray-700"></div>
                                        <button onClick={() => handleAddVariableSet(v)} className="flex-1 px-1.5 hover:bg-gray-700 text-[8px] text-gray-400 hover:text-white uppercase font-bold transition-colors">SET</button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* CENTER: CANVAS */}
            <div className="flex-1 relative flex flex-col min-w-0">
                <div className="h-12 bg-gray-900 border-b border-gray-800 flex items-center justify-between px-4 shrink-0 z-10 shadow-sm">
                    <div className="flex items-center gap-3">
                        <button onClick={onClose} className="p-1.5 rounded-full hover:bg-gray-800 text-gray-400 hover:text-white transition-colors">
                            <ArrowLeft size={16} />
                        </button>
                        <div>
                            <h1 className="text-sm font-bold text-gray-200">LEVEL BLUEPRINT</h1>
                            <div className="text-[10px] text-gray-500">Event Graph</div>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={history.undo}
                            disabled={!history.canUndo}
                            title="Undo (Ctrl+Z)"
                            aria-label="Undo"
                            className="p-1.5 rounded hover:bg-gray-800 text-gray-400 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400 transition-colors"
                        >
                            <Undo2 size={14} />
                        </button>
                        <button
                            onClick={history.redo}
                            disabled={!history.canRedo}
                            title="Redo (Ctrl+Y)"
                            aria-label="Redo"
                            className="p-1.5 rounded hover:bg-gray-800 text-gray-400 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400 transition-colors"
                        >
                            <Redo2 size={14} />
                        </button>
                        {selectedNode && (
                            <button 
                                onClick={handleDelete}
                                className="flex items-center gap-2 px-3 py-1.5 bg-red-900/20 hover:bg-red-900/40 text-red-400 border border-red-900/50 rounded text-xs font-bold transition-colors"
                            >
                                <Trash2 size={12} /> Delete Node
                            </button>
                        )}
                    </div>
                </div>

                <LogicCanvas 
                    blueprint={activeLevelBlueprint}
                    updateBlueprint={updateLevelBlueprint}
                    onSelectNode={setSelectedNodeId}
                    selectedNodeId={selectedNodeId}
                    levelObjects={levelObjects}
                    recordHistory={recordHistory}
                />
            </div>

            {/* RIGHT SIDEBAR: INSPECTOR */}
            {selectedNode && (
                <LevelBlueprintInspector 
                    node={selectedNode}
                    onUpdate={(updates) => handleNodeUpdate(selectedNode.id, updates)}
                    levelObjects={levelObjects}
                    levels={levels}
                    globalVariables={contextVariables}
                    prefabs={prefabs}
                    audioAssets={audioAssets}
                    levelVariables={levelVariables}
                    animationClips={animationClips}
                    playerBones={playerBones}
                    morphTargetsOf={morphTargetsOf}
                    connectedPinIds={connectedPinIds}
                    onDelete={handleDelete}
                />
            )}
        </div>
    );
};
