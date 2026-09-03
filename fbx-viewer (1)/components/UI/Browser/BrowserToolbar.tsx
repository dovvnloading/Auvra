
import React, { useState } from 'react';
import { Search, Plus, Component, FileCode, User, Image, Swords, Film, Shield, Skull, Palette, Upload, Music } from 'lucide-react';
import { AssetCategory } from '../../../types';

interface BrowserToolbarProps {
    activeTab: 'models' | 'blueprints';
    onTabChange: (tab: 'models' | 'blueprints') => void;
    filter: AssetCategory | 'All';
    onFilterChange: (filter: AssetCategory | 'All') => void;
    searchQuery: string;
    onSearchChange: (query: string) => void;
    onImport: (files: File[], category: AssetCategory) => void;
    onImportTexture: (files: File[]) => void;
    onImportAudio: (files: File[]) => void;
    onAddBlueprint: (type: 'Player Character' | 'Enemy Controller') => void;
    isLoading: boolean;
    hasPlayerCharacter: boolean;
    isCreatingPlayerBlueprint: boolean;
    animationTargetName?: string;
}

export const BrowserToolbar: React.FC<BrowserToolbarProps> = ({
    activeTab,
    onTabChange,
    filter,
    onFilterChange,
    searchQuery,
    onSearchChange,
    onImport,
    onImportTexture,
    onImportAudio,
    onAddBlueprint,
    isLoading,
    hasPlayerCharacter,
    isCreatingPlayerBlueprint,
    animationTargetName
}) => {
    const [isImportOpen, setIsImportOpen] = useState(false);

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>, category: AssetCategory) => {
        if (e.target.files && e.target.files.length > 0) {
            const files = Array.from(e.target.files);
            if (category === 'Texture') {
                onImportTexture(files);
            } else if (category === 'Audio') {
                onImportAudio(files);
            } else {
                onImport(files, category);
            }
            setIsImportOpen(false);
        }
        e.target.value = '';
    };

    return (
        <div className="h-10 border-b border-white/10 flex items-center px-2 bg-gray-850/50 justify-between shrink-0">
            <div className="flex items-center gap-2 flex-1 min-w-0">
                {/* Tab Switcher */}
                <div className="flex bg-gray-900 rounded p-0.5 border border-gray-700 mr-2 shrink-0">
                    <button
                        onClick={() => onTabChange('models')}
                        className={`flex items-center gap-1 px-3 py-1 text-[10px] rounded font-bold transition-colors ${activeTab === 'models' ? 'bg-gray-700 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'}`}
                    >
                        <Component size={12} /> Library
                    </button>
                    <button
                        onClick={() => onTabChange('blueprints')}
                        className={`flex items-center gap-1 px-3 py-1 text-[10px] rounded font-bold transition-colors ${activeTab === 'blueprints' ? 'bg-gray-700 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'}`}
                    >
                        <FileCode size={12} /> Blueprints
                    </button>
                </div>

                <div className="w-px h-6 bg-gray-700 mx-1 shrink-0"></div>

                {/* Contextual Actions */}
                {activeTab === 'models' && (
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                        <div className="relative shrink-0">
                            <button
                                onClick={() => setIsImportOpen(!isImportOpen)}
                                disabled={isLoading}
                                className={`
                                    flex items-center gap-2 px-3 py-1.5 rounded text-xs font-bold transition-all
                                    ${isImportOpen ? 'bg-gray-700 text-white' : 'bg-white hover:bg-gray-200 text-black shadow-lg shadow-white/10'}
                                    ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}
                                `}
                            >
                                <Plus size={14} /> Import
                            </button>
                            
                            {isImportOpen && (
                                <>
                                    <div className="fixed inset-0 z-40" onClick={() => setIsImportOpen(false)} />
                                    <div className="absolute bottom-full left-0 mb-2 w-48 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 overflow-hidden py-1">
                                        <div className="px-3 py-2 text-[10px] uppercase text-gray-500 font-bold tracking-wider border-b border-gray-700/50 mb-1">Asset Type</div>
                                        {(['Character', 'Prop', 'Environment', 'Weapon', 'Animation', 'Texture', 'Audio'] as AssetCategory[]).map(cat => {
                                            const animationUnavailable = cat === 'Animation' && !animationTargetName;
                                            return (
                                                <label
                                                    key={cat}
                                                    title={animationUnavailable ? 'Select a skeletal model before importing animation clips.' : undefined}
                                                    className={`flex items-center gap-3 px-3 py-2 group transition-colors ${animationUnavailable ? 'opacity-45 cursor-not-allowed' : 'hover:bg-gray-700 hover:text-white cursor-pointer'}`}
                                                >
                                                {cat === 'Character' && <User size={14} className="text-gray-500 group-hover:text-white" />}
                                                {cat === 'Prop' && <Component size={14} className="text-gray-500 group-hover:text-white" />}
                                                {cat === 'Environment' && <Image size={14} className="text-gray-500 group-hover:text-white" />}
                                                {cat === 'Weapon' && <Swords size={14} className="text-gray-500 group-hover:text-white" />}
                                                {cat === 'Animation' && <Film size={14} className="text-gray-500 group-hover:text-white" />}
                                                {cat === 'Texture' && <Palette size={14} className="text-gray-500 group-hover:text-white" />}
                                                {cat === 'Audio' && <Music size={14} className="text-gray-500 group-hover:text-white" />}
                                                <span className="text-sm text-gray-300 group-hover:text-white flex-1">{cat}</span>
                                                {cat === 'Animation' && (
                                                    <span className="max-w-20 truncate text-[9px] text-gray-500">
                                                        {animationTargetName ? `→ ${animationTargetName}` : 'select target'}
                                                    </span>
                                                )}
                                                <input 
                                                    type="file" 
                                                    accept={cat === 'Texture' ? "image/*" : cat === 'Audio' ? "audio/*" : ".fbx"}
                                                    multiple 
                                                    className="hidden" 
                                                    onChange={(e) => handleFileSelect(e, cat)} 
                                                    disabled={isLoading || animationUnavailable}
                                                />
                                                </label>
                                            );
                                        })}
                                    </div>
                                </>
                            )}
                        </div>
                        
                        <div className="flex bg-gray-900 rounded p-0.5 border border-gray-700 overflow-x-auto custom-scrollbar">
                            {(['All', 'Character', 'Prop', 'Environment', 'Weapon', 'Animation', 'Texture', 'Audio'] as const).map(f => (
                                <button
                                    key={f}
                                    onClick={() => onFilterChange(f)}
                                    className={`px-3 py-1 text-[10px] rounded font-medium transition-colors whitespace-nowrap ${filter === f ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'}`}
                                >
                                    {f}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {activeTab === 'blueprints' && (
                    <div className="flex items-center gap-2">
                        {!hasPlayerCharacter && (
                            <button
                                onClick={() => onAddBlueprint('Player Character')}
                                disabled={isCreatingPlayerBlueprint}
                                className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-bold bg-blue-600 hover:bg-blue-500 text-white shadow transition-all"
                            >
                                <Shield size={14} /> New Character
                            </button>
                        )}
                        <button
                            onClick={() => onAddBlueprint('Enemy Controller')}
                            className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-bold bg-red-600 hover:bg-red-500 text-white shadow transition-all"
                        >
                            <Skull size={14} /> New Enemy
                        </button>
                    </div>
                )}
            </div>

            {/* Search Bar */}
            <div className="relative shrink-0 ml-4">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
                <input
                    type="text"
                    placeholder="Search..."
                    value={searchQuery}
                    onChange={(e) => onSearchChange(e.target.value)}
                    className="bg-gray-950/50 border border-gray-700 rounded-full py-1 pl-8 pr-4 text-xs text-gray-300 focus:outline-none focus:border-gray-500 w-48 transition-all focus:w-64"
                />
            </div>
        </div>
    );
};
