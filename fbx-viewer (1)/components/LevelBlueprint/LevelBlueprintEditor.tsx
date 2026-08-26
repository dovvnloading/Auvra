
import React, { useState, useMemo } from 'react';
import { Play, GitBranch, CheckSquare, Database, Trash2, ArrowLeft, MessageSquare, Box, Shield, Skull, Calculator, Timer, Hash, Type, ToggleLeft, Activity, X, LayoutTemplate, RefreshCcw } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import { LogicCanvas } from './LogicCanvas';
import { LevelBlueprintInspector } from './LevelBlueprintInspector';
import { LogicNode, LogicConnection } from '../../types';

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
    const { activeLevelBlueprint, updateLevelBlueprint, blueprints, levelObjects } = useScene();
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

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
        updateLevelBlueprint({ nodes: [...activeLevelBlueprint.nodes, newNode] });
    };

    // --- 3. CONTEXTUAL ACTIONS ---

    const handleAddBeginOverlap = () => {
        let targetName = '';
        // If an object was selected in the environment before opening BP, pre-select it
        if (selectedObjectId) {
            const obj = levelObjects.find(o => o.id === selectedObjectId);
            if (obj) targetName = obj.name;
        }
        // Fallback to first available object
        if (!targetName && levelObjects.length > 0) {
            targetName = levelObjects[0].name;
        }

        addNode('Event', targetName ? `On Overlap (${targetName})` : 'On Overlap (Select Actor)', [], 
            [
                { name: 'Exec', dataType: 'Exec', direction: 'Output' },
                { name: 'Other Actor', dataType: 'Object', direction: 'Output' }
            ], 
            { targetActorName: targetName || '' }
        );
    };

    const handleAddEvent = (type: string, label: string) => {
        if (type === 'BeginPlay') {
            addNode('Event', 'Event BeginPlay', [], [{ name: 'Exec', dataType: 'Exec', direction: 'Output' }]);
        } else if (type === 'Tick') {
            addNode('Event', 'Event Tick', [], [
                { name: 'Exec', dataType: 'Exec', direction: 'Output' },
                { name: 'Delta Seconds', dataType: 'Float', direction: 'Output' }
            ]);
        }
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

    const handleAddLevelAction = (action: 'Restart' | 'EndGame', label: string) => {
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

    // --- TEMPLATES ---
    const handleAddRestartTemplate = () => {
        // Only require that a Player Blueprint exists.
        // We do NOT strictly check for 'IsDead' variable in the variable list
        // because it is often a virtual variable injected by the Sandbox Runtime.
        const hasPlayer = blueprints.some(bp => bp.type === 'Player Character');
        
        if (!hasPlayer) {
            // Warn if no player exists to target
            alert("No Player Character blueprint found.");
            return;
        }

        const nodes: LogicNode[] = [];
        const connections: LogicConnection[] = [];
        const startX = 200, startY = 200;

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

        updateLevelBlueprint({ nodes: [...activeLevelBlueprint.nodes, ...nodes], connections: [...activeLevelBlueprint.connections, ...connections] });
    };

    // --- 4. STATE MANAGEMENT ---

    const handleDelete = () => {
        if (selectedNodeId) {
            const newNodes = activeLevelBlueprint.nodes.filter(n => n.id !== selectedNodeId);
            // Cleanup connections attached to deleted node
            const newConns = activeLevelBlueprint.connections.filter(c => c.fromNodeId !== selectedNodeId && c.toNodeId !== selectedNodeId);
            updateLevelBlueprint({ nodes: newNodes, connections: newConns });
            setSelectedNodeId(null);
        }
    };

    const handleNodeUpdate = (id: string, updates: Partial<LogicNode>) => {
        const updatedNodes = activeLevelBlueprint.nodes.map(n => 
            n.id === id ? { ...n, ...updates } : n
        );
        updateLevelBlueprint({ nodes: updatedNodes });
    };

    const selectedNode = activeLevelBlueprint.nodes.find(n => n.id === selectedNodeId);

    return (
        <div className="flex h-full w-full bg-gray-950 text-white font-sans overflow-hidden absolute inset-0 z-50">
            
            {/* LEFT SIDEBAR: PALETTE */}
            <div className="w-64 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0">
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
                        {selectedNodeId && (
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
                />
            </div>

            {/* RIGHT SIDEBAR: INSPECTOR */}
            {selectedNode && (
                <LevelBlueprintInspector 
                    node={selectedNode}
                    onUpdate={(updates) => handleNodeUpdate(selectedNode.id, updates)}
                    levelObjects={levelObjects}
                    globalVariables={contextVariables}
                    onDelete={handleDelete}
                />
            )}
        </div>
    );
};
