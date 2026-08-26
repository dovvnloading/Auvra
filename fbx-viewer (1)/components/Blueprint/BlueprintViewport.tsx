
import React, { useState, useMemo } from 'react';
import * as THREE from 'three';
import { Shield, Skull, Box, Trash2, Eye, ChevronUp, Search, Check } from 'lucide-react';
import { Blueprint, LoadedModelData } from '../../types';
import { GraphPreview } from '../AnimationGraph/GraphPreview';
import { useScene } from '../../context/SceneContext';

interface BlueprintViewportProps {
    blueprint: Blueprint;
    linkedModel: LoadedModelData | undefined;
    models: LoadedModelData[];
    allClips: THREE.AnimationClip[];
    onUpdate: (id: string, updates: Partial<Blueprint>) => void;
    onRemove: (id: string) => void;
    visible: boolean;
}

export const BlueprintViewport: React.FC<BlueprintViewportProps> = ({
    blueprint,
    linkedModel,
    models,
    allClips,
    onUpdate,
    onRemove,
    visible
}) => {
    const { textures } = useScene();
    const [isMeshSelectorOpen, setIsMeshSelectorOpen] = useState(false);
    const [meshSearch, setMeshSearch] = useState('');

    const filteredModels = useMemo(() => {
        return models.filter(m => m.name.toLowerCase().includes(meshSearch.toLowerCase()));
    }, [models, meshSearch]);

    // Resolve texture URL
    const textureUrl = useMemo(() => {
        const tex = textures.find(t => t.id === blueprint.textureId);
        return tex ? tex.url : null;
    }, [blueprint.textureId, textures]);

    return (
        <div className="flex-1 flex flex-col min-w-0 bg-gray-900 relative">
            {/* Blueprint Toolbar */}
            <div className="h-12 border-b border-gray-800 bg-gray-900 shrink-0 flex items-center justify-between px-4 z-20">
                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                        {blueprint.type === 'Player Character' ? <Shield size={18} className="text-blue-400" /> : <Skull size={18} className="text-red-400" />}
                        <input 
                            value={blueprint.name}
                            onChange={(e) => onUpdate(blueprint.id, { name: e.target.value })}
                            className="bg-transparent text-sm font-bold text-white focus:outline-none focus:border-b border-gray-600 w-48"
                        />
                    </div>
                    <div className="h-6 w-px bg-gray-800"></div>
                    <div className="flex items-center gap-2 text-xs text-gray-500">
                        <Box size={12} />
                        <span>Setup Mode</span>
                    </div>
                </div>
                
                <button 
                    type="button"
                    onClick={(e) => { 
                        e.preventDefault();
                        e.stopPropagation();
                        onRemove(blueprint.id); 
                    }}
                    className="flex items-center gap-2 text-xs font-bold bg-red-900/20 hover:bg-red-900/50 text-red-400 hover:text-red-200 px-3 py-1.5 rounded border border-red-900/50 transition-colors"
                >
                    <Trash2 size={12} /> Delete Blueprint
                </button>
            </div>

            {/* 3D Viewport with Overlays */}
            <div className="flex-1 bg-black relative border-r border-gray-800 overflow-hidden">
                <div className="absolute top-4 left-4 z-10 bg-black/50 backdrop-blur px-3 py-1 rounded-full text-[10px] text-gray-400 border border-white/10 flex items-center gap-2">
                    <Eye size={10} /> Mesh Preview
                </div>
                
                {/* 3D Canvas */}
                {visible && (
                    <GraphPreview 
                        graph={blueprint.animationGraph}
                        allClips={allClips}
                        model={linkedModel || undefined}
                        scale={blueprint.meshScale}
                        textureUrl={textureUrl}
                    />
                )}
                
                {/* Mesh Selector Overlay */}
                <div className="absolute bottom-4 left-4 right-4 bg-gray-900/95 backdrop-blur p-0 rounded-xl border border-gray-700 shadow-2xl max-w-lg mx-auto overflow-visible">
                    <div className="p-4 border-b border-gray-800 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <Box size={16} className="text-gray-400" />
                            <span className="text-xs font-bold text-gray-200">LINKED MESH</span>
                        </div>
                    </div>

                    <div className="p-4">
                        <div className="relative">
                            <button 
                                onClick={() => setIsMeshSelectorOpen(!isMeshSelectorOpen)}
                                className="w-full bg-gray-950 hover:bg-gray-800 border border-gray-700 rounded-lg p-3 text-sm text-white focus:outline-none focus:border-blue-500 flex items-center justify-between transition-colors"
                            >
                                {linkedModel ? (
                                    <div className="flex items-center gap-3">
                                        <div className="w-8 h-8 rounded bg-gray-800 overflow-hidden border border-gray-600">
                                            {linkedModel.thumbnail ? <img src={linkedModel.thumbnail} className="w-full h-full object-cover" /> : <Box size={16} className="m-auto mt-2 opacity-50"/>}
                                        </div>
                                        <div className="text-left">
                                            <div className="font-bold text-xs">{linkedModel.name}</div>
                                            <div className="text-[9px] text-gray-400 uppercase">{linkedModel.category}</div>
                                        </div>
                                    </div>
                                ) : (
                                    <span className="text-gray-500 italic">-- Select a Mesh --</span>
                                )}
                                <ChevronUp size={14} className={`text-gray-500 transition-transform ${isMeshSelectorOpen ? 'rotate-180' : ''}`} />
                            </button>

                            {isMeshSelectorOpen && (
                                <div className="absolute bottom-full left-0 right-0 mb-2 bg-gray-900 border border-gray-700 rounded-lg shadow-xl max-h-80 flex flex-col z-50 overflow-hidden">
                                    <div className="p-2 border-b border-gray-800 bg-gray-950">
                                        <div className="relative">
                                            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
                                            <input 
                                                type="text" 
                                                placeholder="Search models..." 
                                                value={meshSearch}
                                                onChange={(e) => setMeshSearch(e.target.value)}
                                                autoFocus
                                                className="w-full bg-gray-900 border border-gray-700 rounded-full py-1.5 pl-8 pr-4 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
                                            />
                                        </div>
                                    </div>
                                    <div className="flex-1 overflow-y-auto custom-scrollbar">
                                        {filteredModels.length === 0 && (
                                            <div className="p-6 text-center text-gray-500 text-xs">
                                                {models.length === 0 ? "No models imported." : "No matching models found."}
                                            </div>
                                        )}
                                        {filteredModels.map(m => (
                                            <div 
                                                key={m.id}
                                                onClick={() => {
                                                    onUpdate(blueprint.id, { linkedModelId: m.id });
                                                    setIsMeshSelectorOpen(false);
                                                }}
                                                className={`flex items-center gap-3 p-2 hover:bg-gray-800 cursor-pointer border-b border-gray-800 last:border-0 ${linkedModel?.id === m.id ? 'bg-blue-900/20' : ''}`}
                                            >
                                                    <div className="w-8 h-8 rounded bg-gray-800 overflow-hidden border border-gray-700 shrink-0 relative">
                                                    {m.thumbnail ? <img src={m.thumbnail} className="w-full h-full object-cover" /> : <Box size={14} className="m-auto mt-2 opacity-30"/>}
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <div className={`text-xs font-bold truncate ${linkedModel?.id === m.id ? 'text-blue-400' : 'text-gray-300'}`}>{m.name}</div>
                                                    <div className="text-[9px] text-gray-500 uppercase">{m.category}</div>
                                                </div>
                                                {linkedModel?.id === m.id && <Check size={14} className="text-blue-500" />}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>

                        <p className="text-[10px] text-gray-500 mt-3 leading-relaxed">
                            Select the skeletal mesh (FBX) that this blueprint controls. 
                            <br/>Animations will be previewed on this mesh.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};
