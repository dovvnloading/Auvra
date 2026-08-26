
import React, { useState } from 'react';
import * as THREE from 'three';
import { Component, Crosshair, Paperclip, RotateCcw, Palette, Shield, Skull, FileCode, Target } from 'lucide-react';
import { useScene } from '../../../context/SceneContext';
import { AnimationControls } from '../Properties/AnimationControls';
import { AttachmentPanel } from '../Properties/AttachmentPanel';
import { SocketPanel } from '../Properties/SocketPanel';
import { ThumbnailTooltip } from '../ThumbnailTooltip';
import { LoadedModelData } from '../../../types';

interface PropertiesPanelProps {
    activeClip: THREE.AnimationClip | null;
    isPlaying: boolean;
    timeScale: number;
    onAnimationSelect: (clip: THREE.AnimationClip | null) => void;
    onPlayPause: () => void;
    onSpeedChange: (speed: number) => void;
}

export const PropertiesPanel: React.FC<PropertiesPanelProps> = ({
    activeClip,
    isPlaying,
    timeScale,
    onAnimationSelect,
    onPlayPause,
    onSpeedChange
}) => {
    const { models, selectedModelId, resetModelTexture, isLoading, blueprints } = useScene();
    const selectedModel = models.find(m => m.id === selectedModelId) || null;

    // Tooltip logic for header icon
    const [hoveredModel, setHoveredModel] = useState<LoadedModelData | null>(null);
    const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 });

    // Check if controlled by blueprint
    const controllingBlueprint = selectedModel ? blueprints.find(bp => bp.linkedModelId === selectedModel.id) : null;

    return (
        <div className="flex flex-col min-h-0 h-full">
            {selectedModel ? (
                <>
                    {/* Context Header */}
                    <div className="p-4 border-b border-gray-800 bg-gray-800/30">
                        <div className="flex items-start gap-3">
                            <div 
                                className="w-12 h-12 rounded bg-gray-900 border border-gray-700 overflow-hidden shrink-0 flex items-center justify-center cursor-help"
                                onMouseEnter={(e) => {
                                    setHoveredModel(selectedModel);
                                    setCursorPos({ x: e.clientX, y: e.clientY });
                                }}
                                onMouseMove={(e) => setCursorPos({ x: e.clientX, y: e.clientY })}
                                onMouseLeave={() => setHoveredModel(null)}
                            >
                                <Component className="text-gray-500" />
                            </div>
                            <div>
                                <h3 className="text-sm font-bold text-white truncate max-w-[150px]">{selectedModel.name}</h3>
                                <span className="text-[10px] text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">
                                    {selectedModel.category}
                                </span>
                            </div>
                        </div>
                        
                        {/* Blueprint Indicator */}
                        {controllingBlueprint && (
                            <div className="mt-3 p-2 bg-blue-900/20 border border-blue-800 rounded flex items-center gap-2">
                                {controllingBlueprint.type === 'Player Character' ? <Shield size={14} className="text-blue-400" /> : <Skull size={14} className="text-red-400" />}
                                <div className="flex-1 min-w-0">
                                    <div className="text-[10px] text-gray-400 font-bold uppercase tracking-wide">Controlled By</div>
                                    <div className="text-xs text-white truncate font-medium">{controllingBlueprint.name}</div>
                                </div>
                            </div>
                        )}
                        
                        {/* Material / Texture Quick Actions */}
                        <div className="mt-3 pt-3 border-t border-gray-700/50 flex items-center justify-between">
                             <div className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider flex items-center gap-1.5">
                                 <Palette size={12} />
                                 Materials
                             </div>
                             <button
                                onClick={() => resetModelTexture(selectedModel.id)}
                                disabled={isLoading}
                                className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 px-2 py-1 rounded transition-colors border border-gray-700"
                                title="Reset to original FBX textures"
                             >
                                 <RotateCcw size={10} className={isLoading ? 'animate-spin' : ''} />
                                 Reset Textures
                             </button>
                        </div>
                    </div>

                    {/* Animation Panel */}
                    {controllingBlueprint ? (
                         <div className="p-4 border-b border-gray-800 text-center">
                             <FileCode size={24} className="mx-auto text-gray-600 mb-2" />
                             <p className="text-xs text-gray-400">Animation driven by Blueprint Graph.</p>
                             <p className="text-[10px] text-gray-600 mt-1">Manual clip control is disabled.</p>
                         </div>
                    ) : (
                        <AnimationControls 
                            model={selectedModel}
                            activeClip={activeClip}
                            isPlaying={isPlaying}
                            timeScale={timeScale}
                            onAnimationSelect={onAnimationSelect}
                            onPlayPause={onPlayPause}
                            onSpeedChange={onSpeedChange}
                        />
                    )}
                    
                    {/* Socket/Muzzle Panel */}
                    <div className="flex-1 overflow-y-auto custom-scrollbar flex flex-col">
                        <div className="mt-2">
                            <div className="px-4 pb-2 pt-2 text-xs font-semibold text-gray-400 flex items-center gap-2 border-t border-gray-800">
                                <Target size={12} /> Muzzle & Sockets
                            </div>
                            <SocketPanel 
                                selectedModel={selectedModel}
                                onPreviewAnimation={onAnimationSelect} 
                            />
                        </div>

                        {/* Attachments Panel */}
                        <div className="mt-2 pb-4">
                             <div className="px-4 pb-2 pt-2 text-xs font-semibold text-gray-400 flex items-center gap-2 border-t border-gray-800">
                                <Paperclip size={12} /> Attachments
                             </div>
                             <AttachmentPanel selectedModel={selectedModel} />
                        </div>
                    </div>
                </>
            ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-gray-500 p-8 text-center">
                    <Crosshair size={24} className="mb-2 opacity-20" />
                    <p className="text-xs">Select an object from the Hierarchy to view properties.</p>
                </div>
            )}
            
            {hoveredModel && <ThumbnailTooltip model={hoveredModel} position={cursorPos} />}
        </div>
    );
};