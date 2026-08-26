
import React from 'react';
import { Trash2, Database } from 'lucide-react';
import { AnimationGraphData, GraphVariable } from '../../../types';

interface BlackboardVariablesProps {
    graph: AnimationGraphData;
    modelId: string;
    updateGraph: (modelId: string, data: Partial<AnimationGraphData>) => void;
}

export const BlackboardVariables: React.FC<BlackboardVariablesProps> = ({ graph, modelId, updateGraph }) => {

    const addVariable = (type: 'Float' | 'Boolean') => {
        const newVar: GraphVariable = {
            id: crypto.randomUUID(),
            name: `New${type}`,
            type,
            value: type === 'Float' ? 0 : false
        };
        updateGraph(modelId, { variables: [...graph.variables, newVar] });
    };

    return (
        <div>
            <div className="flex items-center justify-between mb-2 pb-1 border-b border-gray-800">
                <span className="text-xs font-bold text-gray-200 flex items-center gap-2">
                    <Database size={12} className="text-gray-400" /> Graph Variables
                </span>
                <div className="flex gap-1">
                    <button onClick={() => addVariable('Float')} className="px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded border border-gray-700 text-[9px] text-gray-400 hover:text-white transition-colors">
                    + Float
                    </button>
                    <button onClick={() => addVariable('Boolean')} className="px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded border border-gray-700 text-[9px] text-gray-400 hover:text-white transition-colors">
                    + Bool
                    </button>
                </div>
            </div>
            <div className="space-y-2">
                {graph.variables.length === 0 && (
                    <div className="text-center py-4 border border-dashed border-gray-800 rounded bg-gray-900/50">
                        <p className="text-[10px] text-gray-600">No variables defined.</p>
                    </div>
                )}
                {graph.variables.map(v => (
                <div key={v.id} className="bg-gray-800 px-2 py-2 rounded border border-gray-700 flex flex-col gap-1 hover:border-gray-600 transition-colors">
                    <div className="flex justify-between items-center">
                        <input 
                            value={v.name} 
                            onChange={(e) => {
                                const updated = graph.variables.map(x => x.id === v.id ? { ...x, name: e.target.value } : x);
                                updateGraph(modelId, { variables: updated });
                            }}
                            className="bg-transparent text-xs font-mono text-gray-200 w-24 focus:outline-none focus:border-b border-gray-600 placeholder-gray-600"
                        />
                        <span className="text-[9px] text-gray-500 uppercase font-bold tracking-wider">{v.type}</span>
                        <button onClick={() => updateGraph(modelId, { variables: graph.variables.filter(x => x.id !== v.id) })} className="text-gray-600 hover:text-gray-400">
                            <Trash2 size={10} />
                        </button>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-gray-500 bg-gray-900 px-2 py-1 rounded border border-gray-800">
                        <span>Initial Value</span>
                        {v.type === 'Boolean' ? (
                            <input 
                                type="checkbox"
                                checked={v.value as boolean}
                                onChange={(e) => {
                                    const updated = graph.variables.map(x => x.id === v.id ? { ...x, value: e.target.checked } : x);
                                    updateGraph(modelId, { variables: updated });
                                }}
                                className="cursor-pointer"
                            />
                        ) : (
                            <input 
                                type="number"
                                step="0.1"
                                value={v.value as number}
                                onChange={(e) => {
                                    const val = parseFloat(e.target.value);
                                    if (!isNaN(val)) {
                                        const updated = graph.variables.map(x => x.id === v.id ? { ...x, value: val } : x);
                                        updateGraph(modelId, { variables: updated });
                                    }
                                }}
                                className="bg-transparent text-right font-mono text-gray-300 w-16 focus:outline-none focus:text-white focus:border-b border-gray-600"
                            />
                        )}
                    </div>
                </div>
                ))}
            </div>
        </div>
    );
};
