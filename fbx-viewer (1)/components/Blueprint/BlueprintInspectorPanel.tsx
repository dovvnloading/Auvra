
import React, { useState, useMemo, useRef } from 'react';
import { FileText, Database, Tag, Plus, Trash2, Zap, Scaling, Camera, Crosshair, Palette, Check, Box, Music, Play } from 'lucide-react';
import { Blueprint } from '../../types';
import { ScrubbableInput } from '../UI/Properties/ScrubbableInput';
import { TransformInputGroup } from '../UI/Properties/TransformInputGroup';
import { useScene } from '../../context/SceneContext';

interface BlueprintInspectorPanelProps {
    blueprint: Blueprint;
    onUpdate: (id: string, updates: Partial<Blueprint>) => void;
}

export const BlueprintInspectorPanel: React.FC<BlueprintInspectorPanelProps> = ({
    blueprint,
    onUpdate
}) => {
    const { textures, audioAssets } = useScene();
    const [activeTab, setActiveTab] = useState<'details' | 'stats' | 'tags' | 'materials' | 'audio'>('details');
    const previewAudioRef = useRef<HTMLAudioElement | null>(null);

    // Helpers
    const addStat = () => {
        const newStat = { id: crypto.randomUUID(), name: 'New Stat', value: 0 };
        onUpdate(blueprint.id, { stats: [...blueprint.stats, newStat] });
    };

    const removeStat = (statId: string) => {
        onUpdate(blueprint.id, { stats: blueprint.stats.filter(s => s.id !== statId) });
    };

    const updateStat = (statId: string, updates: any) => {
        onUpdate(blueprint.id, { 
            stats: blueprint.stats.map(s => s.id === statId ? { ...s, ...updates } : s)
        });
    };

    const addWeaponSound = (audioId: string) => {
        const current = blueprint.weaponSounds || [];
        // Allow duplicates for probability weighting
        onUpdate(blueprint.id, { weaponSounds: [...current, audioId] });
    };

    const removeWeaponSound = (index: number) => {
        const current = blueprint.weaponSounds || [];
        const newSounds = [...current];
        newSounds.splice(index, 1);
        onUpdate(blueprint.id, { weaponSounds: newSounds });
    };

    const previewSound = (audioId: string) => {
        const asset = audioAssets.find(a => a.id === audioId);
        if (asset) {
            if (previewAudioRef.current) previewAudioRef.current.pause();
            previewAudioRef.current = new Audio(asset.url);
            previewAudioRef.current.volume = (blueprint.weaponVolume ?? 1.0) * 0.7; // Preview at configured volume (dampened)
            previewAudioRef.current.play();
        }
    };

    const aimOffset = blueprint.aimOffset || [0.5, 4.5, 1.0];

    const activeTexture = useMemo(() => 
        textures.find(t => t.id === blueprint.textureId), 
    [textures, blueprint.textureId]);

    const weaponSounds = useMemo(() => {
        return (blueprint.weaponSounds || []).map(id => audioAssets.find(a => a.id === id)).filter(Boolean);
    }, [blueprint.weaponSounds, audioAssets]);

    return (
        <div className="w-80 bg-gray-900 border-l border-gray-800 flex flex-col shrink-0">
            {/* Tabs */}
            <div className="flex border-b border-gray-800 bg-gray-950 overflow-x-auto custom-scrollbar">
                <button 
                    onClick={() => setActiveTab('details')} 
                    className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider transition-colors border-b-2 flex items-center justify-center gap-1.5 min-w-[70px] ${activeTab === 'details' ? 'border-blue-500 text-white bg-gray-900' : 'border-transparent text-gray-500 hover:text-gray-300 hover:bg-gray-900'}`}
                >
                    <FileText size={12} /> Details
                </button>
                <button 
                    onClick={() => setActiveTab('materials')} 
                    className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider transition-colors border-b-2 flex items-center justify-center gap-1.5 min-w-[70px] ${activeTab === 'materials' ? 'border-blue-500 text-white bg-gray-900' : 'border-transparent text-gray-500 hover:text-gray-300 hover:bg-gray-900'}`}
                >
                    <Palette size={12} /> Skins
                </button>
                <button 
                    onClick={() => setActiveTab('stats')} 
                    className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider transition-colors border-b-2 flex items-center justify-center gap-1.5 min-w-[70px] ${activeTab === 'stats' ? 'border-blue-500 text-white bg-gray-900' : 'border-transparent text-gray-500 hover:text-gray-300 hover:bg-gray-900'}`}
                >
                    <Database size={12} /> Stats
                </button>
                {blueprint.type === 'Player Character' && (
                    <button 
                        onClick={() => setActiveTab('audio')} 
                        className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider transition-colors border-b-2 flex items-center justify-center gap-1.5 min-w-[70px] ${activeTab === 'audio' ? 'border-blue-500 text-white bg-gray-900' : 'border-transparent text-gray-500 hover:text-gray-300 hover:bg-gray-900'}`}
                    >
                        <Music size={12} /> Audio
                    </button>
                )}
                <button 
                    onClick={() => setActiveTab('tags')} 
                    className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider transition-colors border-b-2 flex items-center justify-center gap-1.5 min-w-[70px] ${activeTab === 'tags' ? 'border-blue-500 text-white bg-gray-900' : 'border-transparent text-gray-500 hover:text-gray-300 hover:bg-gray-900'}`}
                >
                    <Tag size={12} /> Tags
                </button>
            </div>
            
            {/* Content */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
                <div className="space-y-6 animate-in fade-in duration-200">
                    {activeTab === 'details' && (
                        <>
                            <div className="space-y-2">
                                <label className="text-[10px] uppercase font-bold text-gray-500">Description</label>
                                <textarea 
                                    value={blueprint.description}
                                    onChange={(e) => onUpdate(blueprint.id, { description: e.target.value })}
                                    className="w-full bg-gray-950 border border-gray-700 rounded p-3 text-xs text-gray-300 resize-none h-24 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20"
                                    placeholder="Enter blueprint description..."
                                />
                            </div>

                            <div className="space-y-2">
                                <label className="text-[10px] uppercase font-bold text-gray-500 flex items-center gap-2">
                                    <Scaling size={12} /> Mesh Configuration
                                </label>
                                <div className="bg-gray-800/50 rounded p-3 border border-gray-800 space-y-3">
                                    <div className="flex items-center justify-between gap-4">
                                        <span className="text-xs text-gray-400 shrink-0">Mesh Scale</span>
                                        <div className="w-28">
                                            <ScrubbableInput 
                                                label="Scale"
                                                value={blueprint.meshScale || 1.0}
                                                onChange={(val) => onUpdate(blueprint.id, { meshScale: Math.max(0.1, val) })}
                                                step={0.1}
                                                labelColor="text-blue-400"
                                                labelWidth="w-10"
                                            />
                                        </div>
                                    </div>
                                    <p className="text-[9px] text-gray-500 leading-tight">
                                        Multiplies the base import scale of the linked model. Adjust this if hitbox collision fails or the model looks too small/large.
                                    </p>
                                </div>
                            </div>

                            {blueprint.type === 'Player Character' && (
                                <div className="space-y-2">
                                    <label className="text-[10px] uppercase font-bold text-gray-500 flex items-center gap-2">
                                        <Camera size={12} /> Camera Settings
                                    </label>
                                    <div className="bg-gray-800/50 rounded p-3 border border-gray-800 space-y-3">
                                        <div className="flex flex-col gap-2">
                                            <span className="text-[10px] text-gray-400 flex items-center gap-1.5 font-bold">
                                                <Crosshair size={10} /> Scope Offset (Aiming)
                                            </span>
                                            <TransformInputGroup 
                                                label="Offset (X/Y/Z)"
                                                values={aimOffset}
                                                onChange={(val) => onUpdate(blueprint.id, { aimOffset: val })}
                                                step={0.1}
                                            />
                                        </div>
                                        <p className="text-[9px] text-gray-500 leading-tight mt-1">
                                            Adjust the camera position when aiming down sights (Holding F). Coordinates are relative to the character root.
                                        </p>
                                    </div>
                                </div>
                            )}

                            <div className="space-y-2">
                                <label className="text-[10px] uppercase font-bold text-gray-500">System Info</label>
                                <div className="bg-gray-800/50 rounded p-3 border border-gray-800 space-y-2">
                                    <div className="flex justify-between text-[10px]">
                                        <span className="text-gray-500">ID</span>
                                        <span className="font-mono text-gray-300">{blueprint.id.split('-')[0]}...</span>
                                    </div>
                                    <div className="flex justify-between text-[10px]">
                                        <span className="text-gray-500">Type</span>
                                        <span className="text-blue-400">{blueprint.type}</span>
                                    </div>
                                    <div className="flex justify-between text-[10px]">
                                        <span className="text-gray-500">Nodes</span>
                                        <span className="text-gray-300">{blueprint.animationGraph.states.length} states</span>
                                    </div>
                                </div>
                            </div>
                        </>
                    )}

                    {activeTab === 'materials' && (
                        <div className="space-y-4">
                            <div className="bg-gray-800/50 rounded p-3 border border-gray-800 space-y-2">
                                <div className="text-xs font-bold text-gray-300 flex items-center gap-2">
                                    <Palette size={14} className="text-purple-400" /> Active Skin
                                </div>
                                <div className="flex gap-3">
                                    <div className="w-12 h-12 rounded border border-gray-700 bg-black overflow-hidden shrink-0">
                                        {activeTexture ? (
                                            <img src={activeTexture.url} className="w-full h-full object-cover" />
                                        ) : (
                                            <div className="w-full h-full bg-gray-800 flex items-center justify-center text-gray-600 text-[9px] text-center p-1">
                                                <Box size={24} />
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex-1 min-w-0 flex flex-col justify-center">
                                        <div className="text-xs font-mono text-white truncate">
                                            {activeTexture ? activeTexture.name : 'Original Mesh'}
                                        </div>
                                        {activeTexture && (
                                            <div className="text-[9px] text-gray-500">
                                                {activeTexture.dimensions.width}x{activeTexture.dimensions.height}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <label className="text-[10px] uppercase font-bold text-gray-500">Texture Library</label>
                                <div className="grid grid-cols-3 gap-2">
                                    {/* Default Card */}
                                    <div 
                                        onClick={() => onUpdate(blueprint.id, { textureId: null })}
                                        className={`
                                            group relative aspect-square rounded border cursor-pointer overflow-hidden
                                            ${!blueprint.textureId 
                                                ? 'border-purple-500 ring-1 ring-purple-500/50' 
                                                : 'border-gray-700 hover:border-gray-500'
                                            }
                                        `}
                                    >
                                        <div className="w-full h-full bg-gray-800 flex items-center justify-center text-gray-500">
                                            <Box size={24} />
                                        </div>
                                        <div className="absolute bottom-0 left-0 right-0 bg-black/60 p-1 truncate text-[8px] text-gray-300 text-center">
                                            Original
                                        </div>
                                        {!blueprint.textureId && (
                                            <div className="absolute inset-0 bg-purple-500/20 flex items-center justify-center">
                                                <Check size={16} className="text-white drop-shadow-md" />
                                            </div>
                                        )}
                                    </div>

                                    {/* Library Cards */}
                                    {textures.map(tex => (
                                        <div 
                                            key={tex.id}
                                            onClick={() => onUpdate(blueprint.id, { textureId: tex.id })}
                                            className={`
                                                group relative aspect-square rounded border cursor-pointer overflow-hidden
                                                ${blueprint.textureId === tex.id 
                                                    ? 'border-purple-500 ring-1 ring-purple-500/50' 
                                                    : 'border-gray-700 hover:border-gray-500'
                                                }
                                            `}
                                        >
                                            <img src={tex.url} className="w-full h-full object-cover" />
                                            
                                            {blueprint.textureId === tex.id && (
                                                <div className="absolute inset-0 bg-purple-500/20 flex items-center justify-center">
                                                    <Check size={16} className="text-white drop-shadow-md" />
                                                </div>
                                            )}
                                            
                                            <div className="absolute bottom-0 left-0 right-0 bg-black/60 p-1 truncate text-[8px] text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity">
                                                {tex.name}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                {textures.length === 0 && (
                                    <div className="text-center py-4">
                                        <p className="text-[9px] text-gray-600 italic">No saved skins. Use Retexture tool to create some.</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {activeTab === 'audio' && (
                        <div className="space-y-4">
                            <div className="space-y-2">
                                <label className="text-[10px] uppercase font-bold text-gray-500 flex items-center gap-2">
                                    <Zap size={12} /> Weapon Fire Sounds
                                </label>
                                <div className="bg-gray-800/50 rounded p-3 border border-gray-800 space-y-3">
                                    
                                    <div className="flex items-center justify-between">
                                        <span className="text-[10px] font-medium text-gray-400">Master Volume</span>
                                        <div className="w-20">
                                            <ScrubbableInput 
                                                label=""
                                                value={blueprint.weaponVolume ?? 1.0}
                                                onChange={(v) => onUpdate(blueprint.id, { weaponVolume: Math.max(0, Math.min(2, v)) })}
                                                step={0.1}
                                                labelWidth="w-0"
                                            />
                                        </div>
                                    </div>

                                    <div className="space-y-2 pt-2 border-t border-gray-800/50">
                                        <label className="text-[9px] font-bold text-gray-500 uppercase">Assigned Sounds</label>
                                        {weaponSounds.length === 0 && (
                                            <div className="text-center py-2 text-gray-600 text-[9px] italic">No sounds assigned.</div>
                                        )}
                                        <div className="space-y-1">
                                            {weaponSounds.map((sound, idx) => (
                                                <div key={`${sound!.id}-${idx}`} className="flex items-center justify-between bg-gray-900 p-2 rounded border border-gray-700 group hover:border-gray-600">
                                                    <div className="flex items-center gap-2 overflow-hidden">
                                                        <button 
                                                            onClick={() => previewSound(sound!.id)} 
                                                            className="text-gray-400 hover:text-white transition-colors"
                                                            title="Preview Sound"
                                                        >
                                                            <Play size={10} fill="currentColor" />
                                                        </button>
                                                        <span className="text-xs text-gray-300 truncate cursor-default" title={sound!.name}>{sound!.name}</span>
                                                    </div>
                                                    <button 
                                                        onClick={() => removeWeaponSound(idx)} 
                                                        className="text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                                                        title="Remove Sound"
                                                    >
                                                        <Trash2 size={10} />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Add Sound Control */}
                                    <div className="pt-2">
                                        <select 
                                            className="w-full bg-gray-900 border border-gray-700 rounded text-xs text-white p-2 focus:outline-none focus:border-blue-500 cursor-pointer hover:bg-gray-800 transition-colors"
                                            onChange={(e) => {
                                                if(e.target.value) {
                                                    addWeaponSound(e.target.value);
                                                    e.target.value = "";
                                                }
                                            }}
                                            value=""
                                        >
                                            <option value="" disabled>+ Add Audio Asset...</option>
                                            {audioAssets.map(a => (
                                                <option key={a.id} value={a.id}>{a.name} ({a.duration.toFixed(1)}s)</option>
                                            ))}
                                        </select>
                                        {audioAssets.length === 0 && (
                                            <p className="text-[9px] text-gray-500 mt-1 italic">Import audio files in the Library to use them here.</p>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'tags' && (
                        <div className="space-y-2">
                            <label className="text-[10px] uppercase font-bold text-gray-500">Gameplay Tags</label>
                            <div className="flex flex-wrap gap-2">
                                {blueprint.traits.map(tag => (
                                    <div key={tag} className="px-2 py-1 bg-gray-800 rounded border border-gray-700 text-xs text-gray-300 flex items-center gap-2">
                                        {tag}
                                        <button 
                                            onClick={() => onUpdate(blueprint.id, { traits: blueprint.traits.filter(t => t !== tag) })}
                                            className="text-gray-500 hover:text-white"
                                        >
                                            <Trash2 size={10} />
                                        </button>
                                    </div>
                                ))}
                                <button 
                                    onClick={() => {
                                        const t = prompt("Enter new tag:");
                                        if (t) onUpdate(blueprint.id, { traits: [...blueprint.traits, t] });
                                    }}
                                    className="px-2 py-1 bg-gray-800 rounded border border-dashed border-gray-600 text-xs text-gray-500 hover:text-white hover:border-gray-400 flex items-center gap-1"
                                >
                                    <Plus size={10} /> Add Tag
                                </button>
                            </div>
                        </div>
                    )}

                    {activeTab === 'stats' && (
                        <div className="space-y-4">
                            <div className="flex justify-between items-center">
                                <label className="text-[10px] uppercase font-bold text-gray-500">Attributes</label>
                                <button onClick={addStat} className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
                                    <Plus size={12} /> Add
                                </button>
                            </div>
                            <div className="space-y-2">
                                {blueprint.stats.map(stat => (
                                    <div key={stat.id} className="bg-gray-800 rounded p-2 border border-gray-700">
                                        <div className="flex items-center justify-between mb-2">
                                            <input 
                                                value={stat.name}
                                                onChange={(e) => updateStat(stat.id, { name: e.target.value })}
                                                className="bg-transparent text-xs font-bold text-gray-300 focus:outline-none border-b border-transparent focus:border-gray-500 w-24"
                                            />
                                            <button onClick={() => removeStat(stat.id)} className="text-gray-500 hover:text-red-400">
                                                <Trash2 size={12} />
                                            </button>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] text-gray-500 font-mono">VAL</span>
                                            <div className="flex-1">
                                                <ScrubbableInput 
                                                    label=""
                                                    value={stat.value}
                                                    onChange={(v) => updateStat(stat.id, { value: v })}
                                                    step={1}
                                                    labelWidth="w-0"
                                                />
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
