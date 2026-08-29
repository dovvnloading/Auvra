
import React, { useState } from 'react';
import { Box, Move, RotateCw, Scaling, Trash2, X, RotateCcw, Skull, Timer, Users, UserPlus, Hash, Music, Volume2, Radio, Ear, Repeat, VolumeX, Mountain, Layers, Plus, CircleDashed, Hammer, ArrowUp, ArrowDown, Minus, Activity, Wind, AlertTriangle, Grid, Sun, CloudFog } from 'lucide-react';
import { EditorState } from '../types';
import { LevelObject } from '../../../types';
import { EnvironmentBrushPanel } from '../EnvironmentBrushPanel';
import { EnvironmentMaskTool } from '../EnvironmentMaskTool';
import { ScrubbableInput } from '../../UI/Properties/ScrubbableInput';
import { useScene } from '../../../context/SceneContext';
import { WaveformEditor } from '../assets/WaveformEditor';
import { DEFAULT_SKY_CONFIG } from '../SkySystem';

interface EnvironmentInspectorProps {
    state: EditorState;
    selectedObject: LevelObject | undefined;
    actions: {
        setPaintMode: (mode: any) => void;
        setPaintSettings: (settings: any) => void;
        setSelectedObjectId: (id: string | null) => void;
        updateLevelObject: (id: string, updates: any) => void;
        removeLevelObject: (id: string) => void;
        setSculptSettings: (settings: any) => void;
    };
}

// Internal Terrain Config Component
const TerrainInspector: React.FC<{ 
    actions: EnvironmentInspectorProps['actions'], 
    sculptSettings: any 
}> = ({ actions, sculptSettings }) => {
    const { addLevelObject, levelObjects } = useScene();
    const [activeTab, setActiveTab] = useState<'create' | 'sculpt'>('create');
    
    // Creation Settings
    const [createSize, setCreateSize] = useState(100);
    const [createRes, setCreateRes] = useState(128);

    // Check if terrain exists
    const existingTerrain = levelObjects.find(obj => obj.type === 'terrain');

    const handleCreateTerrain = async () => {
        if (existingTerrain) return;

        const id = await addLevelObject(
            '', 
            [0, 0, 0], 
            [0, 0, 0], 
            [1, 1, 1], 
            'terrain',
            { resolution: createRes, width: createSize, depth: createSize, heights: [] }
        );
        
        if (id) {
            actions.setSelectedObjectId(id);
            setActiveTab('sculpt');
        }
    };

    return (
        <div className="absolute right-0 top-12 bottom-0 z-20 pointer-events-auto flex">
            <div className="w-72 bg-gray-900 border-l border-gray-800 flex flex-col shrink-0 z-20 shadow-xl animate-in slide-in-from-right-10 duration-200 h-full">
                <div className="flex border-b border-gray-800 bg-gray-950">
                    <button 
                        onClick={() => setActiveTab('create')}
                        className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider flex items-center justify-center gap-2 border-b-2 transition-colors ${activeTab === 'create' ? 'border-amber-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                    >
                        <Layers size={12} /> Manage
                    </button>
                    <button 
                        onClick={() => setActiveTab('sculpt')}
                        disabled={!existingTerrain}
                        className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider flex items-center justify-center gap-2 border-b-2 transition-colors ${activeTab === 'sculpt' ? 'border-amber-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed'}`}
                    >
                        <Hammer size={12} /> Sculpt
                    </button>
                </div>

                <div className="p-4 space-y-6 overflow-y-auto custom-scrollbar flex-1">
                    
                    {activeTab === 'create' && (
                        <div className="space-y-4">
                            <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                                <Mountain size={12} /> Terrain Generation
                            </div>

                            {existingTerrain ? (
                                <div className="bg-gray-800/50 border border-gray-700 rounded p-4 flex flex-col items-center text-center gap-3">
                                    <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center text-amber-500">
                                        <AlertTriangle size={24} />
                                    </div>
                                    <div className="space-y-1">
                                        <h4 className="text-xs font-bold text-white">Terrain Active</h4>
                                        <p className="text-[10px] text-gray-400 leading-relaxed">
                                            Only one terrain object is allowed per scene. Select the existing terrain to sculpt it, or delete it to create a new one.
                                        </p>
                                    </div>
                                    <button 
                                        onClick={() => actions.setSelectedObjectId(existingTerrain.id)}
                                        className="w-full py-2 bg-gray-800 hover:bg-gray-700 text-white text-xs font-bold rounded border border-gray-600 transition-colors"
                                    >
                                        Select Current Terrain
                                    </button>
                                </div>
                            ) : (
                                <div className="space-y-6 animate-in fade-in duration-300">
                                    {/* Settings */}
                                    <div className="space-y-4">
                                        <div className="space-y-2">
                                            <div className="flex justify-between items-center">
                                                <span className="text-xs text-gray-300 font-bold flex items-center gap-2">
                                                    <Scaling size={12} className="text-gray-500" /> Size (Meters)
                                                </span>
                                            </div>
                                            <div className="bg-gray-800 rounded p-2 border border-gray-700">
                                                <div className="flex items-center gap-2">
                                                    <input 
                                                        type="range" min="50" max="1000" step="50"
                                                        value={createSize}
                                                        onChange={(e) => setCreateSize(parseInt(e.target.value))}
                                                        className="flex-1 h-1.5 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-amber-500"
                                                    />
                                                    <span className="text-xs font-mono text-white w-10 text-right">{createSize}m</span>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="space-y-2">
                                            <div className="flex justify-between items-center">
                                                <span className="text-xs text-gray-300 font-bold flex items-center gap-2">
                                                    <Grid size={12} className="text-gray-500" /> Resolution (Polygons)
                                                </span>
                                            </div>
                                            <div className="bg-gray-800 rounded p-2 border border-gray-700 space-y-2">
                                                <div className="flex items-center gap-2">
                                                    <input 
                                                        type="range" min="32" max="512" step="32"
                                                        value={createRes}
                                                        onChange={(e) => setCreateRes(parseInt(e.target.value))}
                                                        className="flex-1 h-1.5 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-amber-500"
                                                    />
                                                    <span className="text-xs font-mono text-white w-10 text-right">{createRes}</span>
                                                </div>
                                                <div className="text-[9px] text-gray-500 flex justify-between">
                                                    <span>Low Poly</span>
                                                    <span>High Detail (Heavy)</span>
                                                </div>
                                            </div>
                                            <p className="text-[9px] text-gray-500 leading-tight pl-1">
                                                Higher resolution allows for smoother sculpting but may impact performance.
                                            </p>
                                        </div>
                                    </div>

                                    <button 
                                        onClick={handleCreateTerrain}
                                        className="w-full py-3 bg-amber-600 hover:bg-amber-500 text-white rounded font-bold text-xs shadow-lg shadow-amber-900/20 transition-all flex items-center justify-center gap-2"
                                    >
                                        <Plus size={14} /> Create Terrain Surface
                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                    {activeTab === 'sculpt' && (
                        <div className="space-y-6">
                            {existingTerrain ? (
                                <>
                                    {/* Brush Settings */}
                                    <div className="space-y-3">
                                        <div className="flex items-center gap-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider border-b border-gray-800 pb-1">
                                            <CircleDashed size={12} /> Brush Settings
                                        </div>
                                        <div className="space-y-2">
                                            <div className="flex items-center justify-between">
                                                <span className="text-xs text-gray-400">Radius</span>
                                                <div className="w-24">
                                                    <ScrubbableInput label="m" value={sculptSettings.radius} onChange={(v) => actions.setSculptSettings({ ...sculptSettings, radius: Math.max(0.5, v) })} step={0.5} labelWidth="w-6" />
                                                </div>
                                            </div>
                                            <div className="flex items-center justify-between">
                                                <span className="text-xs text-gray-400">Strength</span>
                                                <div className="w-24">
                                                    <ScrubbableInput label="%" value={sculptSettings.strength} onChange={(v) => actions.setSculptSettings({ ...sculptSettings, strength: Math.max(0.01, Math.min(1, v)) })} step={0.05} labelWidth="w-6" />
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Tools */}
                                    <div className="space-y-3">
                                        <div className="flex items-center gap-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider border-b border-gray-800 pb-1">
                                            <Hammer size={12} /> Tools
                                        </div>
                                        <div className="grid grid-cols-2 gap-2">
                                            <button 
                                                onClick={() => actions.setSculptSettings({ ...sculptSettings, tool: 'raise' })}
                                                className={`p-2 rounded border flex flex-col items-center gap-1 transition-all ${sculptSettings.tool === 'raise' ? 'bg-amber-600/20 border-amber-500 text-amber-400' : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'}`}
                                            >
                                                <ArrowUp size={16} /> <span className="text-[10px] font-bold uppercase">Raise</span>
                                            </button>
                                            <button 
                                                onClick={() => actions.setSculptSettings({ ...sculptSettings, tool: 'lower' })}
                                                className={`p-2 rounded border flex flex-col items-center gap-1 transition-all ${sculptSettings.tool === 'lower' ? 'bg-red-600/20 border-red-500 text-red-400' : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'}`}
                                            >
                                                <ArrowDown size={16} /> <span className="text-[10px] font-bold uppercase">Lower</span>
                                            </button>
                                            <button 
                                                onClick={() => actions.setSculptSettings({ ...sculptSettings, tool: 'flatten' })}
                                                className={`p-2 rounded border flex flex-col items-center gap-1 transition-all ${sculptSettings.tool === 'flatten' ? 'bg-blue-600/20 border-blue-500 text-blue-400' : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'}`}
                                            >
                                                <Minus size={16} /> <span className="text-[10px] font-bold uppercase">Flatten</span>
                                            </button>
                                            <button 
                                                onClick={() => actions.setSculptSettings({ ...sculptSettings, tool: 'smooth' })}
                                                className={`p-2 rounded border flex flex-col items-center gap-1 transition-all ${sculptSettings.tool === 'smooth' ? 'bg-green-600/20 border-green-500 text-green-400' : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'}`}
                                            >
                                                <Wind size={16} /> <span className="text-[10px] font-bold uppercase">Smooth</span>
                                            </button>
                                        </div>

                                        {sculptSettings.tool === 'flatten' && (
                                            <div className="flex items-center justify-between pt-2">
                                                <span className="text-xs text-gray-400">Target Height</span>
                                                <div className="w-24">
                                                    <ScrubbableInput label="Y" value={sculptSettings.flattenHeight} onChange={(v) => actions.setSculptSettings({ ...sculptSettings, flattenHeight: v })} step={0.5} labelWidth="w-6" />
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </>
                            ) : (
                                <div className="text-center py-10 text-gray-500 text-xs">
                                    No terrain found.<br/>Go to the Manage tab to create one.
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export const EnvironmentInspector: React.FC<EnvironmentInspectorProps> = ({ state, selectedObject, actions }) => {
    const { blueprints, audioAssets } = useScene();
    const { interactionMode, paintMode, paintSettings, selectedBrushId, sculptSettings } = state;

    if (interactionMode === 'sculpt') {
        return <TerrainInspector actions={actions} sculptSettings={sculptSettings} />;
    }

    if (interactionMode === 'mask') {
        return (
            <div className="absolute right-0 top-12 bottom-0 z-20 pointer-events-auto flex">
                <EnvironmentMaskTool modelId={selectedBrushId} />
            </div>
        );
    }

    if (interactionMode === 'paint') {
        return (
            <div className="absolute right-0 top-12 bottom-0 z-20 pointer-events-auto flex">
                <EnvironmentBrushPanel 
                    mode={paintMode}
                    setMode={actions.setPaintMode}
                    settings={paintSettings}
                    setSettings={actions.setPaintSettings}
                />
            </div>
        );
    }

    if (selectedObject) {
        const isSpawner = selectedObject.type === 'spawn_point';
        const isAudio = selectedObject.type === 'audio_emitter';
        const isTerrain = selectedObject.type === 'terrain';
        const isSky = selectedObject.type === 'sky_sphere';

        return (
            <div className="absolute right-0 top-12 bottom-0 z-20 pointer-events-auto flex">
                <div className="w-72 bg-gray-900 border-l border-gray-800 flex flex-col shrink-0 z-20 shadow-xl animate-in slide-in-from-right-10 duration-200 h-full">
                    
                    {/* Header */}
                    <div className="flex border-b border-gray-800 bg-gray-950 justify-between items-center p-3 shrink-0">
                        <span className="text-xs font-bold text-gray-300 flex items-center gap-2">
                            {isSpawner ? <Skull size={14} className="text-red-400"/> : 
                             isAudio ? <Music size={14} className="text-amber-400"/> :
                             isTerrain ? <Mountain size={14} className="text-amber-500" /> :
                             isSky ? <Sun size={14} className="text-cyan-400" /> :
                             <Box size={14} className="text-blue-400"/>} 
                            {isSpawner ? 'Spawner Config' : (isAudio ? 'Audio Config' : (isTerrain ? 'Terrain Props' : (isSky ? 'Sky Atmosphere' : 'Object Inspector')))}
                        </span>
                        <button onClick={() => actions.setSelectedObjectId(null)} className="text-gray-500 hover:text-white transition-colors" title="Deselect Object">
                            <X size={14} />
                        </button>
                    </div>
                    
                    {/* Properties */}
                    <div className="p-4 space-y-6 overflow-y-auto custom-scrollbar flex-1">
                        <div className="space-y-2">
                            <label className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Object Name</label>
                            <input 
                                value={selectedObject.name} 
                                onChange={(e) => actions.updateLevelObject(selectedObject.id, { name: e.target.value })}
                                className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs text-white focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/20 transition-all"
                                title="Rename Object"
                            />
                        </div>

                        {isTerrain && (
                            <div className="space-y-2 text-xs text-gray-400 bg-gray-800 p-2 rounded">
                                <div>Resolution: {selectedObject.terrainData?.resolution}</div>
                                <div>Size: {selectedObject.terrainData?.width}m x {selectedObject.terrainData?.depth}m</div>
                                <div className="pt-2 text-[10px] italic">Switch to Terrain Mode to sculpt geometry.</div>
                            </div>
                        )}

                        {/* --- SKY CONFIGURATION --- */}
                        {isSky && selectedObject.skyConfig && (
                            <div className="space-y-4 pt-2 border-t border-gray-800/50">
                                {/* Time of Day */}
                                <div className="space-y-2">
                                    <div className="flex justify-between items-center">
                                        <span className="text-[10px] font-bold text-cyan-400 uppercase flex items-center gap-1.5">
                                            <Timer size={12} /> Time of Day
                                        </span>
                                        <span className="text-[10px] font-mono text-white">
                                            {Math.floor(selectedObject.skyConfig.timeOfDay)}:{Math.floor((selectedObject.skyConfig.timeOfDay % 1) * 60).toString().padStart(2, '0')}
                                        </span>
                                    </div>
                                    <div className="bg-gray-800 p-2 rounded border border-gray-700">
                                        <input 
                                            type="range" min="0" max="24" step="0.1"
                                            value={selectedObject.skyConfig.timeOfDay}
                                            onChange={(e) => actions.updateLevelObject(selectedObject.id, { skyConfig: { ...selectedObject.skyConfig, timeOfDay: parseFloat(e.target.value) } })}
                                            className="w-full h-1.5 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-cyan-400"
                                        />
                                        <div className="flex justify-between text-[8px] text-gray-500 mt-1">
                                            <span>6 AM</span><span>NOON</span><span>6 PM</span><span>MIDNIGHT</span>
                                        </div>
                                    </div>
                                </div>

                                {/* Atmosphere */}
                                <div className="space-y-2">
                                    <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                                        <Wind size={12} /> Atmosphere
                                    </div>
                                    <div className="grid grid-cols-2 gap-2">
                                        <ScrubbableInput 
                                            label="Turbidity" 
                                            value={selectedObject.skyConfig.turbidity} 
                                            onChange={(v) => actions.updateLevelObject(selectedObject.id, { skyConfig: { ...selectedObject.skyConfig, turbidity: Math.max(0, v) } })} 
                                            step={0.1} labelWidth="w-16" 
                                        />
                                        <ScrubbableInput 
                                            label="Rayleigh" 
                                            value={selectedObject.skyConfig.rayleigh} 
                                            onChange={(v) => actions.updateLevelObject(selectedObject.id, { skyConfig: { ...selectedObject.skyConfig, rayleigh: Math.max(0, v) } })} 
                                            step={0.1} labelWidth="w-16" 
                                        />
                                        <ScrubbableInput 
                                            label="Mie Coeff" 
                                            value={selectedObject.skyConfig.mieCoefficient} 
                                            onChange={(v) => actions.updateLevelObject(selectedObject.id, { skyConfig: { ...selectedObject.skyConfig, mieCoefficient: Math.max(0, v) } })} 
                                            step={0.001} labelWidth="w-16" 
                                        />
                                        <ScrubbableInput 
                                            label="Mie Dir" 
                                            value={selectedObject.skyConfig.mieDirectionalG} 
                                            onChange={(v) => actions.updateLevelObject(selectedObject.id, { skyConfig: { ...selectedObject.skyConfig, mieDirectionalG: Math.max(0, v) } })} 
                                            step={0.01} labelWidth="w-16" 
                                        />
                                    </div>
                                </div>

                                {/* Lighting & Fog */}
                                <div className="space-y-2">
                                    <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                                        <Sun size={12} /> Light & Fog
                                    </div>
                                    <div className="space-y-2 bg-gray-800 p-2 rounded border border-gray-700">
                                        <div className="flex items-center justify-between">
                                            <span className="text-[10px] text-gray-400">Sun Intensity</span>
                                            <div className="w-16">
                                                <ScrubbableInput label="" value={selectedObject.skyConfig.sunIntensity} onChange={(v) => actions.updateLevelObject(selectedObject.id, { skyConfig: { ...selectedObject.skyConfig, sunIntensity: Math.max(0, v) } })} step={0.1} labelWidth="w-0" />
                                            </div>
                                        </div>
                                        <div className="flex items-center justify-between">
                                            <span className="text-[10px] text-gray-400">Ambience</span>
                                            <div className="w-16">
                                                <ScrubbableInput label="" value={selectedObject.skyConfig.ambienceIntensity} onChange={(v) => actions.updateLevelObject(selectedObject.id, { skyConfig: { ...selectedObject.skyConfig, ambienceIntensity: Math.max(0, v) } })} step={0.1} labelWidth="w-0" />
                                            </div>
                                        </div>
                                        
                                        <div className="h-px bg-gray-700 my-1" />
                                        
                                        <div className="flex items-center justify-between">
                                            <span className="text-[10px] text-gray-400 flex items-center gap-1"><CloudFog size={10}/> Fog Density</span>
                                            <div className="w-16">
                                                <ScrubbableInput label="" value={selectedObject.skyConfig.fogDensity} onChange={(v) => actions.updateLevelObject(selectedObject.id, { skyConfig: { ...selectedObject.skyConfig, fogDensity: Math.max(0, v) } })} step={0.001} labelWidth="w-0" />
                                            </div>
                                        </div>
                                        <div className="flex items-center justify-between">
                                            <span className="text-[10px] text-gray-400">Fog Color</span>
                                            <input 
                                                type="color" 
                                                value={selectedObject.skyConfig.fogColor}
                                                onChange={(e) => actions.updateLevelObject(selectedObject.id, { skyConfig: { ...selectedObject.skyConfig, fogColor: e.target.value } })}
                                                className="w-6 h-4 bg-transparent border-none p-0 cursor-pointer"
                                            />
                                        </div>
                                    </div>
                                </div>

                                {/* Reset to Default */}
                                <button 
                                    onClick={() => actions.updateLevelObject(selectedObject.id, { skyConfig: DEFAULT_SKY_CONFIG })}
                                    className="w-full py-2 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-400 flex items-center justify-center gap-2 transition-colors"
                                >
                                    <RotateCcw size={12} /> Reset to Default
                                </button>
                            </div>
                        )}

                        {/* --- AUDIO CONFIGURATION --- */}
                        {isAudio && (
                            <div className="space-y-4 pt-2 border-t border-gray-800/50">
                                <div className="space-y-3 bg-amber-950/20 p-3 rounded border border-amber-900/30">
                                    <div className="flex items-center gap-2 text-xs font-bold text-amber-400 uppercase tracking-wide">
                                        <Volume2 size={12} /> Sound Properties
                                    </div>

                                    {/* Audio File Selector */}
                                    <div className="space-y-1">
                                        <label className="text-[10px] font-medium text-gray-400 flex items-center gap-1.5">
                                            <Music size={10} /> Source File
                                        </label>
                                        <select 
                                            value={selectedObject.audioConfig?.audioId || ''}
                                            onChange={(e) => actions.updateLevelObject(selectedObject.id, {
                                                audioConfig: {
                                                    volume: 1.0,
                                                    loop: true,
                                                    autoplay: true,
                                                    muted: false,
                                                    isSpatial: true,
                                                    refDistance: 1,
                                                    maxDistance: 10,
                                                    rolloffFactor: 1,
                                                    loopStart: 0,
                                                    ...selectedObject.audioConfig,
                                                    audioId: e.target.value
                                                }
                                            })}
                                            className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-xs text-white focus:outline-none focus:border-amber-500"
                                        >
                                            <option value="" disabled>-- Select Audio --</option>
                                            {audioAssets.map(a => (
                                                <option key={a.id} value={a.id}>{a.name}</option>
                                            ))}
                                        </select>
                                    </div>

                                    {/* Waveform Editor (Only if audio is selected) */}
                                    {selectedObject.audioConfig?.audioId && (
                                        <WaveformEditor 
                                            audioUrl={audioAssets.find(a => a.id === selectedObject.audioConfig?.audioId)?.url || ''}
                                            loopStart={selectedObject.audioConfig?.loopStart}
                                            loopEnd={selectedObject.audioConfig?.loopEnd}
                                            onChangeLoopStart={(val) => actions.updateLevelObject(selectedObject.id, {
                                                audioConfig: { ...selectedObject.audioConfig!, loopStart: val }
                                            })}
                                            onChangeLoopEnd={(val) => actions.updateLevelObject(selectedObject.id, {
                                                audioConfig: { ...selectedObject.audioConfig!, loopEnd: val }
                                            })}
                                        />
                                    )}

                                    {/* Mute Toggle */}
                                    <div className="flex items-center justify-between bg-gray-900 p-2 rounded border border-gray-800">
                                        <span className="text-[10px] text-gray-400 font-bold uppercase flex items-center gap-1.5">
                                            <VolumeX size={10} /> Mute
                                        </span>
                                        <input 
                                            type="checkbox"
                                            checked={selectedObject.audioConfig?.muted ?? false}
                                            onChange={(e) => actions.updateLevelObject(selectedObject.id, {
                                                audioConfig: { ...selectedObject.audioConfig!, muted: e.target.checked }
                                            })}
                                            className="rounded bg-gray-800 border-gray-600 text-red-500 focus:ring-0"
                                        />
                                    </div>

                                    {/* Spatial Toggle */}
                                    <div className="flex items-center justify-between bg-gray-900 p-2 rounded border border-gray-800">
                                        <span className="text-[10px] text-gray-400 font-bold uppercase flex items-center gap-1.5">
                                            <Radio size={10} /> 3D Spatial
                                        </span>
                                        <input 
                                            type="checkbox"
                                            checked={selectedObject.audioConfig?.isSpatial ?? true}
                                            onChange={(e) => actions.updateLevelObject(selectedObject.id, {
                                                audioConfig: { ...selectedObject.audioConfig!, isSpatial: e.target.checked }
                                            })}
                                            className="rounded bg-gray-800 border-gray-600 text-amber-500 focus:ring-0"
                                        />
                                    </div>

                                    {/* Loop Toggle */}
                                    <div className="flex items-center justify-between bg-gray-900 p-2 rounded border border-gray-800">
                                        <span className="text-[10px] text-gray-400 font-bold uppercase flex items-center gap-1.5">
                                            <Repeat size={10} /> Loop
                                        </span>
                                        <input 
                                            type="checkbox"
                                            checked={selectedObject.audioConfig?.loop ?? true}
                                            onChange={(e) => actions.updateLevelObject(selectedObject.id, {
                                                audioConfig: { ...selectedObject.audioConfig!, loop: e.target.checked }
                                            })}
                                            className="rounded bg-gray-800 border-gray-600 text-amber-500 focus:ring-0"
                                        />
                                    </div>
                                </div>
                            </div>
                        )}
                        
                        {/* Generic Delete Button */}
                        <div className="pt-4 border-t border-gray-800 mt-auto">
                            <button 
                                onClick={() => {
                                    if(confirm('Delete object?')) actions.removeLevelObject(selectedObject.id);
                                    actions.setSelectedObjectId(null);
                                }}
                                className="w-full py-2 bg-red-900/20 hover:bg-red-900/40 text-red-400 border border-red-900/50 rounded text-xs font-bold transition-colors flex items-center justify-center gap-2"
                            >
                                <Trash2 size={14} /> Delete Object
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return null;
};
