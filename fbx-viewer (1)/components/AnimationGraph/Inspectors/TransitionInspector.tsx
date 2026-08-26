
import React from 'react';
import { GitCommit, ArrowRight, ToggleLeft, Plus, Trash2 } from 'lucide-react';
import { GraphTransition, GraphState, AnimationGraphData, ConditionOperator } from '../../../types';
import { Select } from '../../UI/Select';

const OPERATORS: ConditionOperator[] = ['>', '<', '==', '!=', '>=', '<='];

interface TransitionInspectorProps {
    transition: GraphTransition;
    graph: AnimationGraphData;
    updateTransition: (updates: Partial<GraphTransition>) => void;
    onDelete: (id: string) => void;
}

export const TransitionInspector: React.FC<TransitionInspectorProps> = ({
    transition,
    graph,
    updateTransition,
    onDelete
}) => {
    const fromState = graph.states.find(s => s.id === transition.fromStateId);
    const toState = graph.states.find(s => s.id === transition.toStateId);
    
    const variableOptions = graph.variables.map(v => ({ label: v.name, value: v.id }));
    const operatorOptions = OPERATORS.map(op => ({ label: op, value: op }));

    return (
        <div className="flex flex-col h-full bg-gray-900">
            {/* Context Header */}
            <div className="p-4 border-b border-gray-800 bg-gray-800/30 shrink-0">
                <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded bg-gray-900 border border-gray-700 flex items-center justify-center shrink-0">
                         <GitCommit size={20} className="text-gray-400" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-bold text-white truncate">Transition</h3>
                        <div className="flex items-center gap-2 mt-1 text-[10px] text-gray-400">
                            <span className="truncate max-w-[60px]">{fromState?.name}</span>
                            <ArrowRight size={10} />
                            <span className="truncate max-w-[60px]">{toState?.name}</span>
                        </div>
                    </div>
                </div>
            </div>

            <div className="p-4 space-y-6 overflow-y-auto custom-scrollbar flex-1">
                 <div className="space-y-1.5">
                    <label className="text-[10px] uppercase text-gray-500 font-bold tracking-wider flex items-center gap-1.5">
                        <ToggleLeft size={10} /> Blend Duration (s)
                    </label>
                    <input 
                        type="number" step="0.1" min="0"
                        value={transition.duration}
                        onChange={(e) => updateTransition({ duration: parseFloat(e.target.value) })}
                        className="w-full bg-gray-900 border border-gray-700 rounded text-xs text-gray-200 p-2 focus:outline-none focus:border-gray-500"
                    />
                </div>

                <div className="space-y-3">
                     <div className="flex items-center justify-between px-1">
                        <label className="text-[10px] uppercase text-gray-500 font-bold tracking-wider">Conditions</label>
                        <button 
                            onClick={() => {
                                if (graph.variables.length === 0) return;
                                const newCond = { variableId: graph.variables[0].id, operator: '==' as const, value: 1 };
                                updateTransition({ conditions: [...transition.conditions, newCond] });
                            }}
                            className="text-[10px] px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded border border-gray-700 text-gray-300 hover:text-white transition-colors flex items-center gap-1"
                        >
                            <Plus size={10} /> Add
                        </button>
                     </div>
                     
                     <div className="space-y-2">
                         {transition.conditions.map((cond, idx) => {
                             const variable = graph.variables.find(v => v.id === cond.variableId);
                             return (
                                 <div key={idx} className="bg-gray-800 rounded-lg border border-gray-700 p-2 flex items-center gap-2">
                                     {/* Variable Select */}
                                     <Select
                                        value={cond.variableId}
                                        onChange={(val) => {
                                            const newConds = [...transition.conditions];
                                            newConds[idx].variableId = val;
                                            updateTransition({ conditions: newConds });
                                        }}
                                        options={variableOptions}
                                        className="w-24"
                                    />

                                     {/* Operator */}
                                     <Select
                                        value={cond.operator}
                                        onChange={(val) => {
                                            const newConds = [...transition.conditions];
                                            newConds[idx].operator = val as any;
                                            updateTransition({ conditions: newConds });
                                        }}
                                        options={operatorOptions}
                                        className="w-16"
                                     />

                                     {/* Value */}
                                     <input 
                                        type={variable?.type === 'Boolean' ? 'checkbox' : 'number'}
                                        checked={cond.value === true}
                                        value={cond.value.toString()}
                                        onChange={(e) => {
                                            const val = variable?.type === 'Boolean' ? e.target.checked : parseFloat(e.target.value);
                                            const newConds = [...transition.conditions];
                                            newConds[idx].value = val;
                                            updateTransition({ conditions: newConds });
                                        }}
                                        className={variable?.type === 'Boolean' ? "cursor-pointer ml-2" : "bg-gray-900 border border-gray-600 rounded text-[10px] text-gray-200 w-16 px-1.5 py-1 focus:outline-none"}
                                     />

                                     <button 
                                        onClick={() => {
                                            const newConds = transition.conditions.filter((_, i) => i !== idx);
                                            updateTransition({ conditions: newConds });
                                        }}
                                        className="ml-auto text-gray-500 hover:text-red-400 p-1"
                                    >
                                        <Trash2 size={12} />
                                    </button>
                                 </div>
                             );
                         })}
                         {transition.conditions.length === 0 && (
                            <div className="text-center py-4 border border-dashed border-gray-800 rounded bg-gray-900/50">
                                <p className="text-[10px] text-gray-600 italic">No conditions (Transition occurs immediately)</p>
                            </div>
                         )}
                     </div>
                </div>

                <div className="pt-4 border-t border-gray-800 mt-auto">
                    <button 
                        onClick={() => onDelete(transition.id)}
                        className="w-full py-2.5 rounded text-xs font-bold border border-gray-700 hover:border-red-900/50 bg-gray-900 hover:bg-red-950/50 text-gray-400 hover:text-red-400 transition-all flex items-center justify-center gap-2"
                    >
                        <Trash2 size={14} /> Delete Transition
                    </button>
                </div>
            </div>
        </div>
    );
};
