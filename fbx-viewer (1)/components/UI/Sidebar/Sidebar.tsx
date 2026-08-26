import React, { useState } from 'react';
import * as THREE from 'three';
import { HierarchyPanel } from './HierarchyPanel';
import { PropertiesPanel } from './PropertiesPanel';

interface SidebarProps {
    activeClip: THREE.AnimationClip | null;
    isPlaying: boolean;
    timeScale: number;
    onAnimationSelect: (clip: THREE.AnimationClip | null) => void;
    onPlayPause: () => void;
    onSpeedChange: (speed: number) => void;
}

export const Sidebar: React.FC<SidebarProps> = (props) => {
  const [activeTab, setActiveTab] = useState<'hierarchy' | 'properties'>('hierarchy');
  
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

      <div className={`flex-1 flex flex-col min-h-0 ${activeTab === 'hierarchy' ? 'overflow-y-auto custom-scrollbar' : 'overflow-hidden'}`}>
        {activeTab === 'hierarchy' ? (
            <HierarchyPanel />
        ) : (
            <PropertiesPanel {...props} />
        )}
      </div>
    </div>
  );
};