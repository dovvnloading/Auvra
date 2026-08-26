import React from 'react';
import { Activity, Plus, X } from 'lucide-react';
import { GraphState } from '../../../types';
import { Select } from '../../UI/Select';

interface BlendStateConfigProps {
    node: GraphState;
    updateState: (updates: Partial<GraphState>) => void;
    clipOptions: { label: string; value: string }[];
    blendParamOptions: { label: string; value: string }[];
}

export const BlendStateConfig: React.FC<BlendStateConfigProps> = ({ 
    node, 
    updateState, 
    clipOptions, 
    blendParamOptions 
}) => {
    return (
        <div className="space-y-4">
            {/* Parameters */}
            <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
                <div className="p-3 bg-gray-800 border-b border-gray-700">
                    <span className="text-xs font-medium text-gray-200 flex items-center gap-2">
                        <Activity size={12} className="text-gray-400" /> Parameters
                    </span>
                </div>
                <div className="p-3 grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                        <label className="text-[9px] uppercase text-gray-500 font-bold">X Axis</label>
                        <Select
                            value={node.blendParamX}
                            onChange={(val) => updateState({ blendParamX: val })}
                            options={blendParamOptions}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <label className="text-[9px] uppercase text-gray-500 font-bold">Y Axis</label>
                        <Select
                            value={node.blendParamY}
                            onChange={(val) => updateState({ blendParamY: val })}
                            options={blendParamOptions}
                        />
                    </div>
                </div>
            </div>

            {/* Samples List */}
            <div className="space-y-3">
                <div className="flex items-center justify-between px-1">
                    <label className="text-[10px] uppercase text-gray-500 font-bold tracking-wider">Motion Samples</label>
                    <button 
                        onClick={() => {
                            const newSample = { id: crypto.randomUUID(), clipName: '', position: [0, 0] as [number, number] };
                            updateState({ blendSamples: [...node.blendSamples, newSample] });
                        }}
                        className="text-[10px] px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded border border-gray-700 text-gray-300 hover:text-white transition-colors flex items-center gap-1"
                    >
                        <Plus size={10} /> Add
                    </button>
                </div>
                
                <div className="space-y-2">
                    {node.blendSamples.map((sample, idx) => (
                        <div key={sample.id} className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
                            <div className="flex items-center gap-2 p-2 border-b border-gray-700/50 bg-gray-800">
                                <div className="flex-1 min-w-0">
                                    <Select
                                        value={sample.clipName}
                                        onChange={(val) => {
                                            const updatedSamples = [...node.blendSamples];
                                            updatedSamples[idx].clipName = val;
                                            updateState({ blendSamples: updatedSamples });
                                        }}
                                        options={clipOptions}
                                        placeholder="-- Select Clip --"
                                    />
                                </div>
                                <button 
                                    onClick={() => {
                                        const updatedSamples = node.blendSamples.filter(s => s.id !== sample.id);
                                        updateState({ blendSamples: updatedSamples });
                                    }}
                                    className="text-gray-500 hover:text-red-400 p-1"
                                >
                                    <X size={12} />
                                </button>
                            </div>
                            <div className="p-2 flex gap-2 bg-gray-900/30">
                                <div className="flex items-center gap-2 flex-1">
                                    <span className="text-[9px] text-gray-500 font-bold font-mono">X</span>
                                    <input 
                                        type="number" step="0.1"
                                        value={sample.position[0]}
                                        onChange={(e) => {
                                            const updatedSamples = [...node.blendSamples];
                                            updatedSamples[idx].position[0] = parseFloat(e.target.value);
                                            updateState({ blendSamples: updatedSamples });
                                        }}
                                        className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-[10px] text-white focus:border-gray-500 focus:outline-none"
                                    />
                                </div>
                                <div className="flex items-center gap-2 flex-1">
                                    <span className="text-[9px] text-gray-500 font-bold font-mono">Y</span>
                                    <input 
                                        type="number" step="0.1"
                                        value={sample.position[1]}
                                        onChange={(e) => {
                                            const updatedSamples = [...node.blendSamples];
                                            updatedSamples[idx].position[1] = parseFloat(e.target.value);
                                            updateState({ blendSamples: updatedSamples });
                                        }}
                                        className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-[10px] text-white focus:border-gray-500 focus:outline-none"
                                    />
                                </div>
                            </div>
                        </div>
                    ))}
                    {node.blendSamples.length === 0 && (
                        <div className="text-center py-4 border border-dashed border-gray-800 rounded bg-gray-900/50">
                            <p className="text-[10px] text-gray-600">No motion samples added.</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};