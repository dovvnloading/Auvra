
import React, { useState } from 'react';
import { Layers, Plus, Eye, EyeOff, Lock, Unlock, Trash2, Search, Component, Layout } from 'lucide-react';
import { AVAILABLE_COMPONENTS } from './componentRegistry';
import { HUDElement } from './types';

interface HUDLibraryProps {
    elements: HUDElement[];
    onAdd: (type: string) => void;
    onSelect: (id: string) => void;
    selectedId: string | null;
    onToggleVisibility: (id: string) => void;
    onToggleLock: (id: string) => void;
    onDelete: (id: string) => void;
}

export const HUDLibrary: React.FC<HUDLibraryProps> = ({
    elements,
    onAdd,
    onSelect,
    selectedId,
    onToggleVisibility,
    onToggleLock,
    onDelete
}) => {
    const [activeTab, setActiveTab] = useState<'components' | 'layers'>('components');
    const [search, setSearch] = useState('');

    const filteredComponents = AVAILABLE_COMPONENTS.filter(c => 
        c.label.toLowerCase().includes(search.toLowerCase())
    );

    return (
        <div className="w-64 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0 z-20">
            {/* Tab Header */}
            <div className="flex border-b border-gray-800 bg-gray-950">
                <button 
                    onClick={() => setActiveTab('components')}
                    className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider flex items-center justify-center gap-2 border-b-2 transition-colors ${activeTab === 'components' ? 'border-blue-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                >
                    <Component size={12} /> Library
                </button>
                <button 
                    onClick={() => setActiveTab('layers')}
                    className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider flex items-center justify-center gap-2 border-b-2 transition-colors ${activeTab === 'layers' ? 'border-blue-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                >
                    <Layers size={12} /> Layers
                </button>
            </div>

            {/* Components List */}
            {activeTab === 'components' && (
                <div className="flex-1 flex flex-col p-2 space-y-2">
                    <div className="relative mb-2">
                        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
                        <input 
                            type="text" 
                            placeholder="Filter widgets..." 
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="w-full bg-gray-950 border border-gray-700 rounded-lg py-1.5 pl-8 pr-2 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
                        />
                    </div>
                    
                    <div className="grid grid-cols-2 gap-2 overflow-y-auto custom-scrollbar">
                        {filteredComponents.map(comp => (
                            <button
                                key={comp.type}
                                onClick={() => onAdd(comp.type)}
                                className="flex flex-col items-center justify-center gap-2 p-3 bg-gray-800 border border-gray-700 rounded-lg hover:bg-gray-700 hover:border-gray-500 transition-all group"
                            >
                                <div className="text-gray-400 group-hover:text-blue-400">
                                    {comp.icon || <Layout size={20} />}
                                </div>
                                <span className="text-[10px] font-medium text-gray-300 text-center leading-tight">
                                    {comp.label}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Layers List */}
            {activeTab === 'layers' && (
                <div className="flex-1 overflow-y-auto custom-scrollbar p-1 space-y-0.5">
                    {elements.length === 0 && (
                        <div className="text-center py-8 text-gray-500 text-xs italic">
                            Canvas is empty.
                        </div>
                    )}
                    {/* Reverse map to show highest Z-index on top */}
                    {[...elements].reverse().map(el => (
                        <div 
                            key={el.id}
                            onClick={() => onSelect(el.id)}
                            className={`
                                flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer group border border-transparent
                                ${selectedId === el.id ? 'bg-blue-900/30 border-blue-500/30' : 'hover:bg-gray-800'}
                            `}
                        >
                            <button 
                                onClick={(e) => { e.stopPropagation(); onToggleVisibility(el.id); }}
                                className="text-gray-500 hover:text-white"
                            >
                                {el.isVisible ? <Eye size={12} /> : <EyeOff size={12} />}
                            </button>
                            
                            <span className={`text-xs flex-1 truncate ${selectedId === el.id ? 'text-white font-medium' : 'text-gray-400'}`}>
                                {el.name}
                            </span>

                            <button 
                                onClick={(e) => { e.stopPropagation(); onToggleLock(el.id); }}
                                className={`text-gray-500 hover:text-white ${el.isLocked ? 'text-amber-500' : 'opacity-0 group-hover:opacity-100'}`}
                            >
                                {el.isLocked ? <Lock size={12} /> : <Unlock size={12} />}
                            </button>

                            <button 
                                onClick={(e) => { e.stopPropagation(); onDelete(el.id); }}
                                className="text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100"
                            >
                                <Trash2 size={12} />
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};
