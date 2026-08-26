import React from 'react';
import { Gamepad2, Plus, Keyboard, Trash2, ArrowRight } from 'lucide-react';
import { AnimationGraphData, InputBinding } from '../../../types';
import { KeyRecorder } from '../KeyRecorder';
import { Select } from '../../UI/Select';

interface BlackboardInputsProps {
    graph: AnimationGraphData;
    modelId: string;
    updateGraph: (modelId: string, data: Partial<AnimationGraphData>) => void;
}

export const BlackboardInputs: React.FC<BlackboardInputsProps> = ({ graph, modelId, updateGraph }) => {
    
    const addInput = () => {
        // Automatically create a variable if none exist
        if (graph.variables.length === 0) {
            alert("Create a variable first!");
            return;
        }

        const newInput: InputBinding = {
            id: crypto.randomUUID(),
            key: 'KeyW',
            type: 'Press',
            targetVariableId: graph.variables[0].id,
            targetValue: 1
        };
        updateGraph(modelId, { inputs: [...graph.inputs, newInput] });
    };

    const inputTypeOptions = [
        { label: 'On Press', value: 'Press' },
        { label: 'On Release', value: 'Release' },
        { label: 'While Held', value: 'Hold' }
    ];

    const variableOptions = graph.variables.map(v => ({ label: v.name, value: v.id }));

    return (
        <div>
            <div className="flex items-center justify-between mb-2 pb-1 border-b border-gray-800">
                <span className="text-xs font-bold text-gray-200 flex items-center gap-2">
                    <Gamepad2 size={12} className="text-gray-400" /> Input Mappings
                </span>
                <button 
                    onClick={addInput} 
                    className="px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded border border-gray-700 text-[10px] text-gray-400 hover:text-white transition-colors flex items-center gap-1"
                >
                    <Plus size={10} /> Add
                </button>
            </div>
            
            <div className="space-y-2">
                {graph.inputs.length === 0 && (
                        <div className="text-center py-4 border border-dashed border-gray-800 rounded bg-gray-900/50">
                            <Keyboard size={20} className="mx-auto text-gray-700 mb-1" />
                            <p className="text-[10px] text-gray-600">No input bindings defined.</p>
                        </div>
                )}

                {graph.inputs.map(inp => {
                    const targetVar = graph.variables.find(v => v.id === inp.targetVariableId);
                    return (
                        <div key={inp.id} className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden group">
                            {/* Header Row: Key & Type */}
                            <div className="p-2 flex items-center gap-2 border-b border-gray-700/50">
                                <KeyRecorder 
                                    value={inp.key}
                                    onChange={(code) => {
                                        const updated = graph.inputs.map(x => x.id === inp.id ? { ...x, key: code } : x);
                                        updateGraph(modelId, { inputs: updated });
                                    }}
                                />

                                <Select
                                    value={inp.type}
                                    onChange={(val) => {
                                        const updated = graph.inputs.map(x => x.id === inp.id ? { ...x, type: val as any } : x);
                                        updateGraph(modelId, { inputs: updated });
                                    }}
                                    options={inputTypeOptions}
                                    className="w-24"
                                />
                                
                                <button 
                                    onClick={() => updateGraph(modelId, { inputs: graph.inputs.filter(x => x.id !== inp.id) })} 
                                    className="ml-auto text-gray-600 hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-all"
                                >
                                    <Trash2 size={12} />
                                </button>
                            </div>

                            {/* Action Row: Set Variable */}
                            <div className="p-2 bg-gray-900/30 flex items-center gap-2">
                                    <ArrowRight size={10} className="text-gray-600 shrink-0" />
                                    
                                    <div className="flex items-center gap-2 flex-1 min-w-0">
                                        <span className="text-[10px] text-gray-500 font-medium">Set</span>
                                        <Select
                                            value={inp.targetVariableId}
                                            onChange={(val) => {
                                                    const updated = graph.inputs.map(x => x.id === inp.id ? { ...x, targetVariableId: val } : x);
                                                    updateGraph(modelId, { inputs: updated });
                                            }}
                                            options={variableOptions}
                                            className="w-28"
                                        />
                                        <span className="text-[10px] text-gray-500">=</span>
                                        <input 
                                            type={targetVar?.type === 'Boolean' ? 'checkbox' : 'number'}
                                            checked={inp.targetValue === true}
                                            value={inp.targetValue.toString()}
                                            onChange={(e) => {
                                                const val = targetVar?.type === 'Boolean' ? e.target.checked : parseFloat(e.target.value);
                                                const updated = graph.inputs.map(x => x.id === inp.id ? { ...x, targetValue: val } : x);
                                                updateGraph(modelId, { inputs: updated });
                                            }}
                                            className={targetVar?.type === 'Boolean' ? 'cursor-pointer' : "bg-gray-900 border border-gray-700 rounded w-12 px-1 text-right text-[10px] text-gray-200 focus:outline-none focus:border-gray-500"}
                                        />
                                    </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};