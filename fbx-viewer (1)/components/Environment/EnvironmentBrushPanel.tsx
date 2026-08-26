
import React from 'react';
import { Brush, Eraser, RefreshCw, ArrowUpFromLine, Scaling, CircleDashed, Grip } from 'lucide-react';
import { ScrubbableInput } from '../UI/Properties/ScrubbableInput';

export interface PaintSettings {
    radius: number;
    density: number;
    scaleMin: number;
    scaleMax: number;
    rotationVariation: number;
    alignToNormal: boolean;
}

interface EnvironmentBrushPanelProps {
    mode: 'add' | 'erase';
    setMode: (mode: 'add' | 'erase') => void;
    settings: PaintSettings;
    setSettings: React.Dispatch<React.SetStateAction<PaintSettings>>;
}

export const EnvironmentBrushPanel: React.FC<EnvironmentBrushPanelProps> = ({
    mode,
    setMode,
    settings,
    setSettings
}) => {
    return (
        <div className="w-72 bg-gray-900 border-l border-gray-800 flex flex-col shrink-0 z-20 shadow-xl animate-in slide-in-from-right-10 duration-200 h-full">
            {/* Header */}
            <div className="flex border-b border-gray-800 bg-gray-950 justify-between items-center p-3 shrink-0">
                <span className="text-xs font-bold text-gray-300 flex items-center gap-2">
                    <Brush size={14} className="text-emerald-400"/> Foliage Brush
                </span>
            </div>

            <div className="p-4 space-y-6 overflow-y-auto custom-scrollbar flex-1">
                
                {/* Mode Switcher */}
                <div className="bg-gray-800 p-1 rounded-lg flex border border-gray-700">
                    <button
                        onClick={() => setMode('add')}
                        className={`flex-1 flex items-center justify-center gap-2 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all ${mode === 'add' ? 'bg-emerald-600 text-white shadow-sm' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
                        title="Add objects"
                    >
                        <Brush size={12} /> Paint
                    </button>
                    <button
                        onClick={() => setMode('erase')}
                        className={`flex-1 flex items-center justify-center gap-2 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all ${mode === 'erase' ? 'bg-red-600 text-white shadow-sm' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
                        title="Remove objects"
                    >
                        <Eraser size={12} /> Erase
                    </button>
                </div>

                {/* Brush Settings */}
                <div className="space-y-3">
                    <div className="flex items-center gap-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider border-b border-gray-800 pb-1">
                        <CircleDashed size={12} /> Brush Properties
                    </div>
                    
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <span className="text-xs text-gray-400" title="Brush size in meters">Radius</span>
                            <div className="w-24">
                                <ScrubbableInput 
                                    label="m"
                                    value={settings.radius}
                                    onChange={(v) => setSettings(s => ({...s, radius: Math.max(0.1, v)}))}
                                    step={0.1}
                                    labelWidth="w-6"
                                />
                            </div>
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-xs text-gray-400" title="Probability of spawning an object per attempt">Density</span>
                            <div className="w-24">
                                <ScrubbableInput 
                                    label="%"
                                    value={settings.density}
                                    onChange={(v) => setSettings(s => ({...s, density: Math.max(0.1, Math.min(1.0, v))}))}
                                    step={0.05}
                                    labelWidth="w-6"
                                />
                            </div>
                        </div>
                    </div>
                </div>

                {/* Variation Settings (Add Mode Only) */}
                {mode === 'add' && (
                    <div className="space-y-3 pt-2">
                        <div className="flex items-center gap-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider border-b border-gray-800 pb-1">
                            <Grip size={12} /> Instance Variation
                        </div>

                        <div className="space-y-4">
                            {/* Scale */}
                            <div className="space-y-2">
                                <label className="text-xs text-gray-400 flex items-center gap-1.5">
                                    <Scaling size={12} /> Scale Range
                                </label>
                                <div className="grid grid-cols-2 gap-2">
                                    <ScrubbableInput 
                                        label="Min"
                                        value={settings.scaleMin}
                                        onChange={(v) => setSettings(s => ({...s, scaleMin: Math.max(0.1, v)}))}
                                        step={0.1}
                                        labelColor="text-blue-400"
                                    />
                                    <ScrubbableInput 
                                        label="Max"
                                        value={settings.scaleMax}
                                        onChange={(v) => setSettings(s => ({...s, scaleMax: Math.max(0.1, v)}))}
                                        step={0.1}
                                        labelColor="text-blue-400"
                                    />
                                </div>
                            </div>

                            {/* Rotation & Alignment */}
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <label className="text-xs text-gray-400 flex items-center gap-1.5" title="Random rotation range in degrees">
                                        <RefreshCw size={12} /> Random Rotation
                                    </label>
                                    <div className="w-24">
                                        <ScrubbableInput 
                                            label="deg"
                                            value={settings.rotationVariation}
                                            onChange={(v) => setSettings(s => ({...s, rotationVariation: Math.max(0, Math.min(360, v))}))}
                                            step={15}
                                            labelWidth="w-8"
                                        />
                                    </div>
                                </div>

                                <label className="flex items-center justify-between group cursor-pointer p-2 bg-gray-800/50 rounded border border-gray-800 hover:border-gray-600 transition-colors" title="Align objects to surface normal (e.g. walls)">
                                    <span className="text-xs text-gray-300 flex items-center gap-2">
                                        <ArrowUpFromLine size={12} className="text-gray-500" /> Align to Normal
                                    </span>
                                    <div className={`w-8 h-4 rounded-full relative transition-colors ${settings.alignToNormal ? 'bg-emerald-600' : 'bg-gray-700'}`}>
                                        <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${settings.alignToNormal ? 'left-4.5' : 'left-0.5'}`} style={{ left: settings.alignToNormal ? 'calc(100% - 14px)' : '2px' }}></div>
                                    </div>
                                    <input 
                                        type="checkbox" 
                                        checked={settings.alignToNormal}
                                        onChange={(e) => setSettings(s => ({...s, alignToNormal: e.target.checked}))}
                                        className="hidden"
                                    />
                                </label>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
