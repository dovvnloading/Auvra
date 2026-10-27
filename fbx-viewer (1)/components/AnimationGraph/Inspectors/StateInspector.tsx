import React from 'react';
import { Layers, Settings, Activity, Crown, Trash2, Link2 } from 'lucide-react';
import { GraphState, AnimationGraphData, StateType } from '../../../types';
import { SingleStateConfig } from './SingleStateConfig';
import { BlendStateConfig } from './BlendStateConfig';

/** State kinds offered by the type switch, in display order. */
const STATE_TYPES: { type: StateType; label: string }[] = [
    { type: 'Single', label: 'Single Clip' },
    { type: 'Blend1D', label: 'Blend 1D' },
    { type: 'Blend2D', label: 'Blend 2D' },
];

interface StateInspectorProps {
    node: GraphState;
    graph: AnimationGraphData;
    updateState: (updates: Partial<GraphState>) => void;
    onDelete: (id: string) => void;
    clipOptions: { label: string; value: string }[];
    blendParamOptions: { label: string; value: string }[];
}

export const StateInspector: React.FC<StateInspectorProps> = ({
    node,
    updateState,
    onDelete,
    clipOptions,
    blendParamOptions
}) => {
    return (
        <div className="flex flex-col h-full bg-gray-900">
             {/* Context Header */}
             <div className="p-4 border-b border-gray-800 bg-gray-800/30 shrink-0">
                <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded bg-gray-900 border border-gray-700 flex items-center justify-center shrink-0">
                         {node.isRoot ? <Crown size={20} className="text-gray-200" /> : <Layers size={20} className="text-gray-400" />}
                    </div>
                    <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-bold text-white truncate">{node.name}</h3>
                        <div className="flex items-center gap-2 mt-1">
                            <span className="text-[10px] text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700 uppercase tracking-wider">
                                State
                            </span>
                            {node.isRoot && (
                                <span className="text-[10px] text-gray-200 bg-gray-700 px-1.5 py-0.5 rounded border border-gray-600 uppercase tracking-wider">
                                    Entry
                                </span>
                            )}
                        </div>
                    </div>
                </div>
             </div>

             <div className="p-4 space-y-6 overflow-y-auto custom-scrollbar flex-1">
                {/* Basic Info */}
                <div className="space-y-3">
                    <div className="space-y-1.5">
                        <label className="text-[10px] uppercase text-gray-500 font-bold tracking-wider flex items-center gap-1.5">
                            <Settings size={10} /> Name
                        </label>
                        <input 
                            value={node.name}
                            onChange={(e) => updateState({ name: e.target.value })}
                            className="w-full bg-gray-900 border border-gray-700 rounded text-xs text-gray-300 p-2 focus:outline-none focus:border-gray-500 transition-colors"
                        />
                    </div>
                </div>

                {/* State Type Selector */}
                <div className="space-y-1.5">
                    <label className="text-[10px] uppercase text-gray-500 font-bold tracking-wider flex items-center gap-1.5">
                        <Activity size={10} /> Type
                    </label>
                    <div className="flex bg-gray-900 p-0.5 rounded border border-gray-700">
                        {STATE_TYPES.map(({ type, label }) => (
                            <button
                                key={type}
                                onClick={() => updateState({ stateType: type })}
                                aria-pressed={node.stateType === type}
                                className={`flex-1 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded transition-all ${node.stateType === type ? 'bg-gray-700 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Sync Group */}
                <div className="space-y-1.5">
                    <label className="text-[10px] uppercase text-gray-500 font-bold tracking-wider flex items-center gap-1.5">
                        <Link2 size={10} /> Sync Group
                    </label>
                    <input
                        value={node.syncGroup ?? ''}
                        onChange={(e) => updateState({ syncGroup: e.target.value.trim() === '' ? undefined : e.target.value })}
                        placeholder="None"
                        aria-label="Sync group"
                        className="w-full bg-gray-900 border border-gray-700 rounded text-xs text-gray-300 p-2 focus:outline-none focus:border-gray-500 transition-colors"
                    />
                    <p className="text-[10px] text-gray-600">States in one group carry their phase across transitions, so a run picks up the walk's stride.</p>
                </div>

                {/* Configuration based on Type */}
                {node.stateType === 'Single' ? (
                    <SingleStateConfig 
                        node={node} 
                        updateState={updateState} 
                        clipOptions={clipOptions} 
                        playRateParamOptions={blendParamOptions}
                    />
                ) : (
                    <BlendStateConfig 
                        node={node}
                        updateState={updateState}
                        clipOptions={clipOptions}
                        blendParamOptions={blendParamOptions}
                    />
                )}

                {/* Delete */}
                <div className="pt-4 border-t border-gray-800">
                    <button 
                        onClick={() => onDelete(node.id)}
                        disabled={node.isRoot}
                        className={`
                            w-full py-2.5 rounded text-xs font-bold border transition-all flex items-center justify-center gap-2
                            ${node.isRoot 
                                ? 'bg-gray-800 text-gray-500 border-gray-700 cursor-not-allowed' 
                                : 'bg-gray-900 hover:bg-red-950/50 text-gray-400 hover:text-red-400 border-gray-700 hover:border-red-900/50'
                            }
                        `}
                    >
                        <Trash2 size={14} /> 
                        <span>Delete State</span>
                    </button>
                </div>
             </div>
        </div>
    );
};