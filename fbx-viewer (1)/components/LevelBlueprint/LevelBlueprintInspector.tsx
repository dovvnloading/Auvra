
import React from 'react';
import { Settings2, MessageSquare, Box, Database, Trash2, Shield, Skull, Hash, Type, ToggleLeft } from 'lucide-react';
import { LogicNode, LevelObject } from '../../types';

interface LevelBlueprintInspectorProps {
    node: LogicNode;
    onUpdate: (updates: Partial<LogicNode>) => void;
    levelObjects: LevelObject[];
    globalVariables: { blueprintName: string, name: string, type: string, blueprintType: string }[];
    onDelete: () => void;
}

export const LevelBlueprintInspector: React.FC<LevelBlueprintInspectorProps> = ({
    node,
    onUpdate,
    levelObjects,
    globalVariables,
    onDelete
}) => {
    
    // Helper to shallow merge into the 'data' object of the node
    const updateData = (key: string, value: any) => {
        onUpdate({
            data: {
                ...(node.data || {}),
                [key]: value
            }
        });
    };

    return (
        <div className="w-80 bg-gray-900 border-l border-gray-800 flex flex-col shrink-0 shadow-xl z-20 animate-in slide-in-from-right-10 duration-200 h-full">
            {/* Header */}
            <div className="p-4 border-b border-gray-800 bg-gray-950 flex items-center gap-3">
                <div className="w-8 h-8 rounded bg-gray-800 border border-gray-700 flex items-center justify-center text-gray-400">
                    <Settings2 size={16} />
                </div>
                <div>
                    <h2 className="text-xs font-bold text-gray-200 uppercase tracking-wider">Node Details</h2>
                    <div className="text-[10px] text-gray-500">{node.type}</div>
                </div>
            </div>

            {/* Properties List */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-6">
                
                {/* Common: Node Name */}
                <div className="space-y-2">
                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Node Name</label>
                    <input 
                        value={node.name}
                        onChange={(e) => onUpdate({ name: e.target.value })}
                        className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs text-white focus:outline-none focus:border-blue-500 transition-colors"
                    />
                </div>

                <div className="h-px bg-gray-800 w-full" />

                {/* Specific: Literal Values (Float, Int, String, Bool) */}
                {node.type.startsWith('Literal') && (
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 text-green-400 text-xs font-bold">
                             {node.type === 'LiteralString' ? <Type size={14} /> : 
                              node.type === 'LiteralBoolean' ? <ToggleLeft size={14} /> : 
                              <Hash size={14} />} 
                             <span>Constant Value</span>
                        </div>
                        <div className="space-y-1">
                            <label className="text-[10px] text-gray-400">
                                {node.type.replace('Literal', '')} Value
                            </label>
                            {node.type === 'LiteralBoolean' ? (
                                <select
                                    value={node.data?.value ? 'true' : 'false'}
                                    onChange={(e) => updateData('value', e.target.value === 'true')}
                                    className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs text-white focus:outline-none focus:border-green-500"
                                >
                                    <option value="true">True</option>
                                    <option value="false">False</option>
                                </select>
                            ) : (
                                <input
                                    type={node.type === 'LiteralString' ? 'text' : 'number'}
                                    step={node.type === 'LiteralFloat' ? '0.1' : '1'}
                                    value={node.data?.value ?? ''}
                                    onChange={(e) => {
                                        let val: any = e.target.value;
                                        if (node.type !== 'LiteralString') {
                                            const parsed = parseFloat(val);
                                            // Allow empty string or partial number inputs while typing
                                            val = isNaN(parsed) ? val : parsed; 
                                        }
                                        updateData('value', val);
                                    }}
                                    className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs text-white focus:outline-none focus:border-green-500"
                                />
                            )}
                        </div>
                    </div>
                )}

                {/* Specific: Print String */}
                {node.type === 'PrintString' && (
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 text-pink-400 text-xs font-bold">
                            <MessageSquare size={14} /> Message Configuration
                        </div>
                        <div className="space-y-1">
                            <label className="text-[10px] text-gray-400">Text to Print</label>
                            <textarea 
                                value={node.data?.printMessage || ''}
                                onChange={(e) => {
                                    // Update both printMessage (legacy/visual) and default_String (pin default)
                                    onUpdate({
                                        data: {
                                            ...(node.data || {}),
                                            printMessage: e.target.value,
                                            default_String: e.target.value
                                        }
                                    });
                                }}
                                className="w-full h-24 bg-gray-950 border border-gray-700 rounded p-2 text-xs text-pink-300 focus:outline-none focus:border-pink-500 resize-none font-mono"
                                placeholder="Enter message..."
                            />
                        </div>
                    </div>
                )}

                {/* Specific: Event (Overlap) */}
                {node.type === 'Event' && node.name.includes('Overlap') && (
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 text-red-400 text-xs font-bold">
                            <Box size={14} /> Trigger Settings
                        </div>
                        <div className="space-y-1">
                            <label className="text-[10px] text-gray-400">Target Actor</label>
                            <select
                                value={node.data?.targetActorName || ''}
                                onChange={(e) => {
                                    updateData('targetActorName', e.target.value);
                                    onUpdate({ name: `On Overlap (${e.target.value})` });
                                }}
                                className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs text-white focus:outline-none focus:border-red-500"
                            >
                                <option value="" disabled>-- Select Actor --</option>
                                {levelObjects.map(obj => (
                                    <option key={obj.id} value={obj.name}>{obj.name}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                )}

                {/* Specific: Variable Get/Set */}
                {(node.type === 'VariableGet' || node.type === 'VariableSet') && (
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 text-emerald-400 text-xs font-bold">
                            <Database size={14} /> Target Variable
                        </div>
                        
                        {/* Target Scope Switcher */}
                        <div className="space-y-1">
                            <label className="text-[10px] text-gray-400">Target Entity</label>
                            <div className="flex bg-gray-800 p-1 rounded border border-gray-700">
                                <button
                                    onClick={() => updateData('targetBlueprintType', 'Player')}
                                    className={`flex-1 flex items-center justify-center gap-2 py-1.5 rounded text-[10px] transition-all ${node.data?.targetBlueprintType !== 'Enemy' ? 'bg-blue-900 text-blue-200 font-bold' : 'text-gray-500 hover:text-white'}`}
                                >
                                    <Shield size={10} /> Player
                                </button>
                                <button
                                    onClick={() => updateData('targetBlueprintType', 'Enemy')}
                                    className={`flex-1 flex items-center justify-center gap-2 py-1.5 rounded text-[10px] transition-all ${node.data?.targetBlueprintType === 'Enemy' ? 'bg-red-900 text-red-200 font-bold' : 'text-gray-500 hover:text-white'}`}
                                >
                                    <Skull size={10} /> Enemy
                                </button>
                            </div>
                        </div>

                        {/* Variable Select */}
                        <div className="space-y-1">
                            <label className="text-[10px] text-gray-400">Variable</label>
                            <select
                                value={node.data?.variableName || ''}
                                onChange={(e) => {
                                    updateData('variableName', e.target.value);
                                    const prefix = node.type === 'VariableGet' ? 'Get' : 'Set';
                                    onUpdate({ name: `${prefix} ${e.target.value}` });
                                }}
                                className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs text-white focus:outline-none focus:border-emerald-500"
                            >
                                <option value="" disabled>-- Select --</option>
                                {globalVariables
                                    .filter(v => v.blueprintType === (node.data?.targetBlueprintType || 'Player'))
                                    .map((v, i) => (
                                    <option key={i} value={v.name}>{v.name} ({v.type})</option>
                                ))}
                            </select>
                        </div>
                    </div>
                )}

            </div>

            {/* Footer */}
            <div className="p-4 border-t border-gray-800 bg-gray-900">
                <button 
                    onClick={onDelete}
                    className="w-full flex items-center justify-center gap-2 py-2 rounded-md bg-red-950/30 border border-red-900/50 hover:bg-red-900/50 hover:border-red-500 text-red-400 hover:text-white transition-all text-xs font-bold"
                >
                    <Trash2 size={14} /> Delete Node
                </button>
            </div>
        </div>
    );
};
