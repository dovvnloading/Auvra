
// ... existing imports ...
import React, { useState } from 'react';
import { Search, Trees, Box, Image, MousePointer2, Layers, Trash2, Eye, Plus, ChevronDown, Skull, Music, Sun } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import { LoadedModelData } from '../../types';
import { editorSession } from '../../utils/editorSession';

interface EnvironmentSidebarProps {
    selectedModelId: string | null;
    onSelectModel: (id: string | null) => void;
    selectedObjectId: string | null;
    onSelectObject: (id: string | null) => void;
}

export const EnvironmentSidebar: React.FC<EnvironmentSidebarProps> = ({ 
    selectedModelId, 
    onSelectModel,
    selectedObjectId,
    onSelectObject
}) => {
    const { models, levelObjects, removeLevelObject, levels, currentLevelId, createLevel, loadLevel, deleteLevel, addLevelObject } = useScene();
    const [activeTab, setActiveTab] = useState<'assets' | 'outliner'>('assets');
    const [search, setSearch] = useState('');
    const [showLevelMenu, setShowLevelMenu] = useState(false);

    // Filter models suitable for environment placement
    const filteredModels = models.filter(m => 
        (m.category === 'Prop' || m.category === 'Environment') &&
        m.name.toLowerCase().includes(search.toLowerCase())
    );

    // Filter level objects for outliner
    const filteredObjects = levelObjects.filter(obj => 
        obj.name.toLowerCase().includes(search.toLowerCase())
    );

    const currentLevel = levels.find(l => l.id === currentLevelId);
    const canEdit = () => editorSession.captureReady() !== null;

    const handleCreateLevel = async () => {
        if (!canEdit()) return;
        const name = prompt("Enter new level name:");
        if (name) {
            await createLevel(name);
        }
    };

    const handleAddSpawner = async () => {
        if (!canEdit()) return;
        // Add a spawn point at origin
        const newId = await addLevelObject(
            '', // No model ID
            [0, 1, 0], 
            [0, 0, 0], 
            [1, 1, 1], 
            'spawn_point'
        );
        
        if (newId) {
            onSelectObject(newId);
        }
    };

    const handleAddAudioEmitter = async () => {
        if (!canEdit()) return;
        const newId = await addLevelObject(
            '',
            [0, 1, 0],
            [0, 0, 0],
            [1, 1, 1], 
            'audio_emitter'
        );
        if (newId) onSelectObject(newId);
    };

    const handleAddSkySphere = async () => {
        if (!canEdit()) return;
        // Check if one already exists
        const existing = levelObjects.find(o => o.type === 'sky_sphere');
        if (existing) {
            alert("A Sky Sphere already exists in this level.");
            onSelectObject(existing.id);
            return;
        }

        const newId = await addLevelObject(
            '',
            [0, 5, 0], // Put it up in the air so icon is visible
            [0, 0, 0],
            [1, 1, 1],
            'sky_sphere',
            { // Default Sky Config
                timeOfDay: 14,
                sunIntensity: 1.5,
                ambienceIntensity: 0.5,
                sunColor: '#ffffff',
                fogColor: '#8caebf', // Light blueish fog
                fogDensity: 0.02,
                turbidity: 8,
                rayleigh: 1,
                mieCoefficient: 0.005,
                mieDirectionalG: 0.7,
                inclination: 0.49,
                azimuth: 0.25
            }
        );
        if (newId) onSelectObject(newId);
    };

    return (
        <div className="w-64 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0 z-20 shadow-xl">
            {/* Header / Level Selector */}
            <div className="p-3 border-b border-gray-800 shrink-0 bg-gray-950">
                <div className="flex items-center justify-between mb-2">
                    <h1 className="text-sm font-bold text-gray-200 tracking-wide flex items-center gap-2">
                        <Trees size={14} className="text-green-400" /> WORLD EDITOR
                    </h1>
                </div>
                
                {/* Level Dropdown */}
                <div className="relative">
                    <button 
                        onClick={() => setShowLevelMenu(!showLevelMenu)}
                        className="w-full flex items-center justify-between bg-gray-900 border border-gray-700 hover:border-gray-600 px-3 py-1.5 rounded text-xs text-white transition-colors"
                        title="Switch Level"
                    >
                        <span className="truncate font-medium">{currentLevel ? currentLevel.name : 'Select Level'}</span>
                        <ChevronDown size={12} className="text-gray-500" />
                    </button>

                    {showLevelMenu && (
                        <>
                            <div className="fixed inset-0 z-30" onClick={() => setShowLevelMenu(false)} />
                            <div className="absolute top-full left-0 right-0 mt-1 bg-gray-800 border border-gray-700 rounded-md shadow-xl z-40 overflow-hidden">
                                <div className="max-h-48 overflow-y-auto custom-scrollbar p-1">
                                    {levels.map(lvl => (
                                        <div 
                                            key={lvl.id}
                                            onClick={() => { if (!canEdit()) return; void loadLevel(lvl.id); setShowLevelMenu(false); }}
                                            className={`flex items-center justify-between px-2 py-1.5 rounded cursor-pointer group ${currentLevelId === lvl.id ? 'bg-blue-900/30 text-blue-400' : 'hover:bg-gray-700 text-gray-300'}`}
                                            title={`Load level: ${lvl.name}`}
                                        >
                                            <span className="text-xs truncate">{lvl.name}</span>
                                            {levels.length > 1 && (
                                                <button 
                                                    onClick={(e) => { e.stopPropagation(); if(canEdit() && confirm('Delete level?')) void deleteLevel(lvl.id); }}
                                                    className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-400"
                                                    title="Delete Level"
                                                >
                                                    <Trash2 size={10} />
                                                </button>
                                            )}
                                        </div>
                                    ))}
                                </div>
                                <div className="border-t border-gray-700 p-1">
                                    <button 
                                        onClick={handleCreateLevel}
                                        className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
                                        title="Create a new empty level"
                                    >
                                        <Plus size={12} /> New Level
                                    </button>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-gray-800 bg-gray-900">
                <button 
                    onClick={() => setActiveTab('assets')}
                    className={`flex-1 py-2 text-[10px] font-bold uppercase tracking-wider transition-colors border-b-2 ${activeTab === 'assets' ? 'border-green-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                    title="Browse models to place"
                >
                    Browser
                </button>
                <button 
                    onClick={() => setActiveTab('outliner')}
                    className={`flex-1 py-2 text-[10px] font-bold uppercase tracking-wider transition-colors border-b-2 ${activeTab === 'outliner' ? 'border-green-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                    title="View hierarchy of placed objects"
                >
                    Outliner
                </button>
            </div>

            {/* Search Toolbar */}
            <div className="p-2 border-b border-gray-800 bg-gray-900">
                <div className="relative">
                    <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
                    <input 
                        type="text" 
                        placeholder={activeTab === 'assets' ? "Filter assets..." : "Search hierarchy..."} 
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="w-full bg-gray-900 border border-gray-700 rounded-md py-1.5 pl-8 pr-4 text-xs text-gray-300 focus:outline-none focus:border-green-500 transition-colors placeholder-gray-600"
                    />
                </div>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
                
                {/* --- ASSETS TAB --- */}
                {activeTab === 'assets' && (
                    <>
                        {/* Selection Tool Option */}
                        <div 
                            onClick={() => onSelectModel(null)}
                            className={`
                                flex items-center gap-3 px-3 py-2.5 rounded-md cursor-pointer transition-all border
                                ${selectedModelId === null
                                    ? 'bg-blue-900/20 border-blue-500/30 text-white' 
                                    : 'hover:bg-gray-800 border-transparent text-gray-400'
                                }
                            `}
                            title="Selection Mode (Q)"
                        >
                            <MousePointer2 size={16} />
                            <div className="text-xs font-bold">Select / Edit Mode</div>
                        </div>

                        {/* Special Actors */}
                        <div className="mt-2">
                            <div className="text-[9px] text-gray-500 font-bold uppercase px-1 mb-1">Logic Actors</div>
                            <div 
                                onClick={handleAddSpawner}
                                className="flex items-center gap-3 px-3 py-2.5 rounded-md cursor-pointer transition-all border border-transparent hover:bg-gray-800 hover:text-white text-gray-400 group"
                                title="Add Enemy Spawn Point"
                            >
                                <div className="w-8 h-8 rounded bg-gray-800 border border-gray-700 flex items-center justify-center shrink-0 text-red-500 group-hover:bg-red-900/20 group-hover:border-red-500/50">
                                    <Skull size={16} />
                                </div>
                                <div className="text-xs font-bold">Enemy Spawner</div>
                            </div>
                            <div 
                                onClick={handleAddAudioEmitter}
                                className="flex items-center gap-3 px-3 py-2.5 rounded-md cursor-pointer transition-all border border-transparent hover:bg-gray-800 hover:text-white text-gray-400 group"
                                title="Add Audio Emitter"
                            >
                                <div className="w-8 h-8 rounded bg-gray-800 border border-gray-700 flex items-center justify-center shrink-0 text-amber-500 group-hover:bg-amber-900/20 group-hover:border-amber-500/50">
                                    <Music size={16} />
                                </div>
                                <div className="text-xs font-bold">Audio Emitter</div>
                            </div>
                            <div 
                                onClick={handleAddSkySphere}
                                className="flex items-center gap-3 px-3 py-2.5 rounded-md cursor-pointer transition-all border border-transparent hover:bg-gray-800 hover:text-white text-gray-400 group"
                                title="Add Sky Atmosphere System"
                            >
                                <div className="w-8 h-8 rounded bg-gray-800 border border-gray-700 flex items-center justify-center shrink-0 text-cyan-500 group-hover:bg-cyan-900/20 group-hover:border-cyan-500/50">
                                    <Sun size={16} />
                                </div>
                                <div className="text-xs font-bold">Sky Sphere</div>
                            </div>
                        </div>

                        <div className="h-px bg-gray-800 my-2 mx-1" />

                        {filteredModels.length === 0 && (
                            <div className="text-center py-8 text-gray-600 text-xs italic px-4">
                                No environment assets found. Import 'Prop' or 'Environment' types.
                            </div>
                        )}

                        {filteredModels.map(m => (
                            <div 
                                key={m.id}
                                onClick={() => onSelectModel(m.id)}
                                className={`
                                    flex items-center gap-3 px-2 py-2 rounded-md cursor-pointer transition-all border
                                    ${selectedModelId === m.id 
                                        ? 'bg-green-900/20 border-green-500/30' 
                                        : 'hover:bg-gray-800 border-transparent'
                                    }
                                `}
                                title={`Select ${m.name} to place`}
                            >
                                <div className="w-10 h-10 rounded bg-gray-800 overflow-hidden border border-gray-700 flex items-center justify-center shrink-0">
                                    {m.thumbnail ? (
                                        <img src={m.thumbnail} className="w-full h-full object-cover opacity-80" />
                                    ) : (
                                        m.category === 'Environment' ? <Image size={16} className="text-gray-600" /> : <Box size={16} className="text-gray-600" />
                                    )}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className={`text-xs font-bold truncate ${selectedModelId === m.id ? 'text-white' : 'text-gray-400'}`}>{m.name}</div>
                                    <div className="text-[9px] text-gray-600 uppercase">{m.category}</div>
                                </div>
                            </div>
                        ))}
                    </>
                )}

                {/* --- OUTLINER TAB --- */}
                {activeTab === 'outliner' && (
                    <>
                        <div className="flex items-center gap-2 px-2 py-1 text-[10px] font-bold text-gray-500 uppercase tracking-wider">
                            <Layers size={10} />
                            <span>{filteredObjects.length} Objects</span>
                        </div>

                        {filteredObjects.length === 0 && (
                            <div className="text-center py-8 text-gray-600 text-xs italic px-4">
                                Level is empty. Switch to Browser to paint assets.
                            </div>
                        )}

                        {filteredObjects.map(obj => {
                            const isSelected = selectedObjectId === obj.id;
                            const isSpawner = obj.type === 'spawn_point';
                            const isAudio = obj.type === 'audio_emitter';
                            const isSky = obj.type === 'sky_sphere';
                            
                            return (
                                <div 
                                    key={obj.id}
                                    onClick={() => onSelectObject(obj.id)}
                                    className={`
                                        group flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-all border border-transparent
                                        ${isSelected 
                                            ? 'bg-blue-900/30 border-blue-500/30 text-white' 
                                            : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                                        }
                                    `}
                                >
                                    {isSpawner ? <Skull size={14} className="text-red-400" /> : 
                                     isAudio ? <Music size={14} className="text-amber-400" /> :
                                     isSky ? <Sun size={14} className="text-cyan-400" /> :
                                     <Box size={14} className={isSelected ? "text-blue-400" : "text-gray-600"} />}
                                    
                                    <span className="text-xs truncate flex-1 font-medium">
                                        {obj.name || (isSpawner ? "Enemy Spawner" : (isAudio ? "Audio Emitter" : (isSky ? "Sky Sphere" : "Object")))}
                                    </span>

                                    <button 
                                        onClick={(e) => { e.stopPropagation(); onSelectObject(obj.id); }} // Focus
                                        className={`p-1 rounded hover:text-white ${isSelected ? 'text-blue-300' : 'text-gray-600 opacity-0 group-hover:opacity-100'}`}
                                        title="Focus Object"
                                    >
                                        <Eye size={12} />
                                    </button>

                                    <button 
                                        onClick={(e) => { 
                                            e.stopPropagation(); 
                                            if(window.confirm('Delete object?')) removeLevelObject(obj.id); 
                                        }}
                                        className="p-1 rounded text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                                        title="Delete Object"
                                    >
                                        <Trash2 size={12} />
                                    </button>
                                </div>
                            );
                        })}
                    </>
                )}
            </div>
        </div>
    );
};
