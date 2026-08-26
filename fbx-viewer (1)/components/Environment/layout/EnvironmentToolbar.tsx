
import React, { useState } from 'react';
import { 
    MousePointer2, Box, Brush, Eraser, Move, RotateCw, 
    Scaling, Globe, Magnet, Grid as GridIcon, Undo, Redo, Play, ChevronDown, LayoutTemplate, Square, Video, Network, Volume2, VolumeX, Mountain
} from 'lucide-react';
import { EditorState } from '../types';

interface EnvironmentToolbarProps {
    state: EditorState;
    actions: {
        setInteractionMode: (mode: any) => void;
        updateTransformSettings: (updates: any) => void;
        handlePlayStart: () => void;
        setLayout: (layout: 'single' | 'quad') => void;
        setCameraSpeed: (speed: number) => void;
        toggleMute: () => void;
    };
    history: {
        undo: () => void;
        redo: () => void;
        canUndo: boolean;
        canRedo: boolean;
    };
    hasActiveBrush: boolean;
}

export const EnvironmentToolbar: React.FC<EnvironmentToolbarProps> = ({ state, actions, history, hasActiveBrush }) => {
    const { interactionMode, transformSettings, layout, cameraSpeed, isMuted } = state;
    const { updateTransformSettings, setInteractionMode, setLayout, setCameraSpeed, toggleMute } = actions;
    const [showGridMenu, setShowGridMenu] = useState(false);
    const [showSpeedMenu, setShowSpeedMenu] = useState(false);

    // Normalized metric increments for precise layout
    const gridOptions = [
        { label: '0.1m', value: 0.1 },
        { label: '0.25m', value: 0.25 },
        { label: '0.5m', value: 0.5 },
        { label: '1m', value: 1.0 },
        { label: '2m', value: 2.0 },
        { label: '5m', value: 5.0 },
        { label: '10m', value: 10.0 },
    ];

    const speedOptions = [1, 2, 3, 4, 5, 6, 8];

    return (
        <div className="h-12 bg-gray-950 border-b border-gray-800 flex items-center justify-between px-4 shrink-0 z-10 shadow-sm">
            
            {/* Left Group: Tools & History */}
            <div className="flex items-center gap-2">
                
                {/* History Controls */}
                <div className="flex bg-gray-900 p-1 rounded-lg border border-gray-800 mr-2">
                    <button 
                        onClick={history.undo} 
                        disabled={!history.canUndo}
                        className="p-1.5 text-gray-400 hover:text-white disabled:opacity-30 transition-colors" 
                        title="Undo (Ctrl+Z)"
                    >
                        <Undo size={14} />
                    </button>
                    <div className="w-px h-4 bg-gray-800 mx-0.5 my-auto"></div>
                    <button 
                        onClick={history.redo} 
                        disabled={!history.canRedo}
                        className="p-1.5 text-gray-400 hover:text-white disabled:opacity-30 transition-colors" 
                        title="Redo (Ctrl+Y)"
                    >
                        <Redo size={14} />
                    </button>
                </div>

                {/* Modes */}
                <div className="flex bg-gray-900 p-1 rounded-lg border border-gray-800">
                    <button onClick={() => setInteractionMode('select')} title="Select and transform objects (Q)" className={`flex items-center gap-2 px-3 py-1.5 rounded-md transition-all text-xs font-bold ${interactionMode === 'select' ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'}`}><MousePointer2 size={14} /> Select</button>
                    <button onClick={() => setInteractionMode('place')} title="Place individual objects (Click to spawn)" disabled={!hasActiveBrush} className={`flex items-center gap-2 px-3 py-1.5 rounded-md transition-all text-xs font-bold ${interactionMode === 'place' ? 'bg-green-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800 disabled:opacity-30'}`}><Box size={14} /> Place</button>
                    <button onClick={() => setInteractionMode('paint')} title="Paint foliage or props with a brush (B)" disabled={!hasActiveBrush} className={`flex items-center gap-2 px-3 py-1.5 rounded-md transition-all text-xs font-bold ${interactionMode === 'paint' ? 'bg-emerald-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800 disabled:opacity-30'}`}><Brush size={14} /> Paint</button>
                    <div className="w-px h-4 bg-gray-700 mx-1"></div>
                    <button onClick={() => setInteractionMode('sculpt')} title="Create and sculpt terrain (T)" className={`flex items-center gap-2 px-3 py-1.5 rounded-md transition-all text-xs font-bold ${interactionMode === 'sculpt' ? 'bg-amber-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'}`}><Mountain size={14} /> Terrain</button>
                    <button onClick={() => setInteractionMode('mask')} title="Create texture masks on objects (M)" className={`flex items-center gap-2 px-3 py-1.5 rounded-md transition-all text-xs font-bold ${interactionMode === 'mask' ? 'bg-purple-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'}`}><Eraser size={14} /> Mask</button>
                </div>

                {/* Transform Settings (Select Mode Only) */}
                {interactionMode === 'select' && (
                    <>
                        <div className="w-px h-5 bg-gray-800 mx-2"></div>
                        <div className="flex items-center gap-2">
                            <div className="flex bg-gray-900 p-0.5 rounded-lg border border-gray-800">
                                <button onClick={() => updateTransformSettings({ tool: 'translate' })} title="Translate Tool (W)" className={`p-1.5 rounded ${transformSettings.tool === 'translate' ? 'bg-gray-700 text-white' : 'text-gray-500'}`}><Move size={14}/></button>
                                <button onClick={() => updateTransformSettings({ tool: 'rotate' })} title="Rotate Tool (E)" className={`p-1.5 rounded ${transformSettings.tool === 'rotate' ? 'bg-gray-700 text-white' : 'text-gray-500'}`}><RotateCw size={14}/></button>
                                <button onClick={() => updateTransformSettings({ tool: 'scale' })} title="Scale Tool (R)" className={`p-1.5 rounded ${transformSettings.tool === 'scale' ? 'bg-gray-700 text-white' : 'text-gray-500'}`}><Scaling size={14}/></button>
                            </div>
                            <button onClick={() => updateTransformSettings({ space: transformSettings.space === 'world' ? 'local' : 'world' })} title="Toggle Global/Local Space (Z)" className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-gray-400 hover:text-white bg-gray-900 px-2 py-1.5 rounded border border-gray-800">{transformSettings.space === 'world' ? <Globe size={12} /> : <Box size={12} />} {transformSettings.space}</button>
                        </div>
                    </>
                )}
            </div>

            {/* Right Group: Snapping & Play */}
            <div className="flex items-center gap-4">
                {/* Level Blueprint Button - Compact */}
                <button 
                    onClick={() => setInteractionMode('blueprint')}
                    className={`p-1.5 rounded-lg border transition-all ${interactionMode === 'blueprint' ? 'bg-blue-900/50 text-blue-400 border-blue-500/50' : 'bg-gray-900 border-gray-800 text-gray-400 hover:text-white hover:bg-gray-800'}`}
                    title="Open Level Blueprint Logic"
                >
                    <Network size={14} />
                </button>

                <div className="w-px h-6 bg-gray-800"></div>

                {/* Mute Toggle */}
                <button
                    onClick={toggleMute}
                    className={`p-1.5 rounded-lg border transition-all ${isMuted ? 'bg-red-900/50 text-red-400 border-red-500/50' : 'bg-gray-900 border-gray-800 text-gray-400 hover:text-white hover:bg-gray-800'}`}
                    title={isMuted ? "Unmute Audio" : "Mute Audio"}
                >
                    {isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                </button>

                {/* Camera Speed Control */}
                <div className="relative">
                    <button 
                        onClick={() => setShowSpeedMenu(!showSpeedMenu)}
                        className="flex items-center gap-2 bg-gray-900 hover:bg-gray-800 border border-gray-800 rounded-lg px-2 py-1.5 transition-colors group"
                        title="Camera Movement Speed"
                    >
                        <Video size={14} className="text-gray-500 group-hover:text-blue-400" />
                        <span className="text-xs font-bold text-gray-300 w-4 text-center">{cameraSpeed}</span>
                    </button>

                    {showSpeedMenu && (
                        <>
                            <div className="fixed inset-0 z-20" onClick={() => setShowSpeedMenu(false)} />
                            <div className="absolute top-full right-0 mt-1 bg-gray-900 border border-gray-700 rounded shadow-xl z-30 w-16 overflow-hidden flex flex-col py-1">
                                {speedOptions.map(val => (
                                    <button
                                        key={val}
                                        onClick={() => {
                                            setCameraSpeed(val);
                                            setShowSpeedMenu(false);
                                        }}
                                        className={`text-xs py-1.5 text-center hover:bg-gray-800 transition-colors ${cameraSpeed === val ? 'text-blue-400 font-bold bg-blue-900/10' : 'text-gray-300'}`}
                                    >
                                        {val}
                                    </button>
                                ))}
                            </div>
                        </>
                    )}
                </div>

                <div className="flex items-center gap-1 bg-gray-900 p-0.5 rounded-lg border border-gray-800 mr-2">
                    <button 
                        onClick={() => setLayout('single')} 
                        className={`p-1.5 rounded transition-all ${layout === 'single' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-white'}`}
                        title="Perspective View"
                    >
                        <Square size={14} />
                    </button>
                    <button 
                        onClick={() => setLayout('quad')} 
                        className={`p-1.5 rounded transition-all ${layout === 'quad' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-white'}`}
                        title="Quad View (Left/Right/Top/Bottom)"
                    >
                        <LayoutTemplate size={14} />
                    </button>
                </div>

                {interactionMode !== 'paint' && interactionMode !== 'mask' && interactionMode !== 'blueprint' && interactionMode !== 'sculpt' && (
                    <div className="flex items-center gap-2 border-r border-gray-800 pr-4 mr-2">
                        <button onClick={() => updateTransformSettings({ snapEnabled: !transformSettings.snapEnabled })} title="Toggle Grid Snapping (X)" className={`text-gray-400 hover:text-white ${transformSettings.snapEnabled ? 'text-blue-400' : ''}`}><Magnet size={16} /></button>
                        {transformSettings.snapEnabled && (
                            <>
                                {/* Snap Grid Selector */}
                                <div className="relative">
                                    <button 
                                        onClick={() => setShowGridMenu(!showGridMenu)}
                                        className="flex items-center gap-1 hover:bg-gray-800 rounded px-1.5 py-1 transition-colors group"
                                        title="Grid Snap Size"
                                    >
                                        <GridIcon size={12} className="text-gray-500 group-hover:text-gray-300" />
                                        <span className="text-xs text-gray-400 group-hover:text-white font-mono min-w-[20px] text-right">
                                            {transformSettings.snapGrid}m
                                        </span>
                                        <ChevronDown size={10} className="text-gray-600 group-hover:text-gray-400" />
                                    </button>
                                    
                                    {showGridMenu && (
                                        <>
                                            <div className="fixed inset-0 z-20" onClick={() => setShowGridMenu(false)} />
                                            <div className="absolute top-full right-0 mt-1 bg-gray-900 border border-gray-700 rounded shadow-xl z-30 w-24 overflow-hidden flex flex-col py-1">
                                                {gridOptions.map(opt => (
                                                    <button
                                                        key={opt.value}
                                                        onClick={() => {
                                                            updateTransformSettings({ snapGrid: opt.value });
                                                            setShowGridMenu(false);
                                                        }}
                                                        className={`text-[10px] py-1.5 px-3 text-left hover:bg-gray-800 transition-colors ${transformSettings.snapGrid === opt.value ? 'text-blue-400 font-bold bg-blue-900/10' : 'text-gray-300'}`}
                                                    >
                                                        {opt.label}
                                                    </button>
                                                ))}
                                            </div>
                                        </>
                                    )}
                                </div>

                                <div className="flex items-center gap-1 ml-2" title="Rotation Snap Angle"><RotateCw size={12} className="text-gray-500" /><span className="text-xs text-gray-400">{transformSettings.snapAngle}°</span></div>
                            </>
                        )}
                    </div>
                )}
                
                <button 
                    onClick={actions.handlePlayStart}
                    className="flex items-center gap-2 px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded font-bold text-xs shadow-lg shadow-blue-900/20 transition-all hover:scale-105"
                    title="Enter Game Mode to test level"
                >
                    <Play size={14} fill="currentColor" /> PLAY LEVEL
                </button>
            </div>
        </div>
    );
};
