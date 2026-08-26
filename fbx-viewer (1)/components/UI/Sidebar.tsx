import React, { useState } from 'react';
import * as THREE from 'three';
import { Component, Layers, Paperclip, ChevronDown, Trash2, Crosshair, User, Image, Swords } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import { AnimationControls } from './AnimationControls';
import { AttachmentPanel } from './AttachmentPanel';

interface SidebarProps {
    activeClip: THREE.AnimationClip | null;
    isPlaying: boolean;
    timeScale: number;
    onAnimationSelect: (clip: THREE.AnimationClip | null) => void;
    onPlayPause: () => void;
    onSpeedChange: (speed: number) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
    activeClip,
    isPlaying,
    timeScale,
    onAnimationSelect,
    onPlayPause,
    onSpeedChange
}) => {
  const { models, attachments, selectedModelId, selectModel, removeModel, removeAttachment } = useScene();
  const [activeTab, setActiveTab] = useState<'hierarchy' | 'properties'>('hierarchy');
  
  const selectedModel = models.find(m => m.id === selectedModelId) || null;

  return (
    <div className="w-80 bg-gray-900/95 backdrop-blur-md border-r border-gray-800 flex flex-col h-full shadow-xl z-20">
      <div className="p-4 border-b border-gray-800 shrink-0">
        <h1 className="text-sm font-bold text-gray-200 tracking-wide">
          SCENE HIERARCHY
        </h1>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-800 shrink-0 bg-gray-900">
          <button 
            onClick={() => setActiveTab('hierarchy')}
            className={`flex-1 py-2 text-[10px] font-bold uppercase tracking-wider transition-colors border-b-2 ${activeTab === 'hierarchy' ? 'border-white text-white' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
          >
            Hierarchy
          </button>
          <button 
            onClick={() => setActiveTab('properties')}
            className={`flex-1 py-2 text-[10px] font-bold uppercase tracking-wider transition-colors border-b-2 ${activeTab === 'properties' ? 'border-white text-white' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
          >
            Properties
          </button>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar flex flex-col">
        
        {activeTab === 'hierarchy' && (
            <div className="p-2 space-y-1">
                 {/* Scene Root */}
                 <div className="flex items-center gap-1 text-xs text-gray-500 font-mono px-2 py-1">
                    <Layers size={12} />
                    <span>Scene Root</span>
                 </div>

                 {models.length === 0 && (
                     <div className="text-center py-10 opacity-50">
                         <p className="text-xs text-gray-500">Scene is empty.</p>
                     </div>
                 )}

                 {models.map(model => {
                     const isSelected = selectedModelId === model.id;
                     const modelAttachments = attachments.filter(a => a.parentModelId === model.id);
                     const hasAttachments = modelAttachments.length > 0;

                     return (
                         <div key={model.id} className="select-none">
                             {/* Model Row */}
                             <div 
                                onClick={() => selectModel(model.id)}
                                className={`
                                    flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors group
                                    ${isSelected ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'}
                                `}
                             >
                                 {hasAttachments ? <ChevronDown size={12} /> : <div className="w-3" />}
                                 
                                 {model.category === 'Character' ? <User size={14} className="text-gray-500" /> :
                                  model.category === 'Prop' ? <Component size={14} className="text-gray-500" /> :
                                  model.category === 'Environment' ? <Image size={14} className="text-gray-500" /> :
                                  <Component size={14} className="text-gray-500" />}
                                 
                                 <span className="text-xs truncate flex-1">{model.name}</span>
                                 
                                 <button 
                                    onClick={(e) => { e.stopPropagation(); removeModel(model.id); }}
                                    className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-white p-1"
                                 >
                                     <Trash2 size={12} />
                                 </button>
                             </div>

                             {/* Attachments (Children) */}
                             {hasAttachments && (
                                 <div className="pl-6 border-l border-gray-800 ml-3 mt-1 space-y-0.5">
                                     {modelAttachments.map(att => (
                                         <div key={att.id} className="flex items-center gap-2 px-2 py-1 text-gray-500 hover:text-gray-300 rounded hover:bg-gray-800/50 cursor-default group">
                                             <Paperclip size={10} className="-scale-y-100" />
                                             <span className="text-[11px] truncate flex-1">{att.name}</span>
                                             <span className="text-[9px] text-gray-600 bg-gray-900 px-1 rounded">{att.boneName}</span>
                                             <button 
                                                onClick={() => removeAttachment(att.id)}
                                                className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-white p-1"
                                            >
                                                <Trash2 size={10} />
                                            </button>
                                         </div>
                                     ))}
                                 </div>
                             )}
                         </div>
                     );
                 })}
            </div>
        )}

        {activeTab === 'properties' && (
            <div className="flex flex-col min-h-0">
                {selectedModel ? (
                    <>
                        {/* Context Header */}
                        <div className="p-4 border-b border-gray-800 bg-gray-800/30">
                            <div className="flex items-start gap-3">
                                <div className="w-12 h-12 rounded bg-gray-900 border border-gray-700 overflow-hidden shrink-0">
                                    {selectedModel.thumbnail ? (
                                        <img src={selectedModel.thumbnail} alt="" className="w-full h-full object-cover grayscale" />
                                    ) : (
                                        <Component className="w-full h-full p-3 text-gray-600" />
                                    )}
                                </div>
                                <div>
                                    <h3 className="text-sm font-bold text-white truncate max-w-[150px]">{selectedModel.name}</h3>
                                    <span className="text-[10px] text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">
                                        {selectedModel.category}
                                    </span>
                                </div>
                            </div>
                        </div>

                        {/* Animation Panel */}
                        <AnimationControls 
                            model={selectedModel}
                            activeClip={activeClip}
                            isPlaying={isPlaying}
                            timeScale={timeScale}
                            onAnimationSelect={onAnimationSelect}
                            onPlayPause={onPlayPause}
                            onSpeedChange={onSpeedChange}
                        />

                        {/* Attachments Panel */}
                        <div className="flex-1 overflow-hidden flex flex-col mt-2">
                             <div className="px-4 pb-2 text-xs font-semibold text-gray-400 flex items-center gap-2">
                                <Paperclip size={12} /> Attachments
                             </div>
                             <AttachmentPanel selectedModel={selectedModel} />
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-gray-500 p-8 text-center">
                        <Crosshair size={24} className="mb-2 opacity-20" />
                        <p className="text-xs">Select an object from the Hierarchy to view properties.</p>
                    </div>
                )}
            </div>
        )}
      </div>
    </div>
  );
};