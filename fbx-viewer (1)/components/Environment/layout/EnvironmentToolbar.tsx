
import { RenderPanel } from '../RenderPanel';
import React, { useRef, useState } from 'react';
import { Popover } from '../../UI/kit';
import { BrushIcon, ChevronDownIcon, CubeIcon, EraserIcon, GlobeIcon, GraphIcon, GridIcon, MagnetIcon, MountainIcon, MoveIcon, MuteIcon, PlayIcon, PointerIcon, RedoIcon, RotateIcon, RouteIcon, ScaleIcon, UndoIcon, VideoIcon, ViewQuadIcon, ViewSingleIcon, VolumeIcon, SlidersIcon } from '../../UI/Icons';
import { EditorState } from '../types';

interface EnvironmentToolbarProps {
    state: EditorState;
    actions: {
        setInteractionMode: (mode: any) => void;
        updateTransformSettings: (updates: any) => void;
        handlePlayStart: (fromCamera?: boolean) => void;
        setLayout: (layout: 'single' | 'quad') => void;
        setCameraSpeed: (speed: number) => void;
        toggleMute: () => void;
        toggleNavigation: () => void;
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
    const { interactionMode, transformSettings, layout, cameraSpeed, isMuted, showNavigation } = state;
    const { updateTransformSettings, setInteractionMode, setLayout, setCameraSpeed, toggleMute, toggleNavigation } = actions;
    const [showGridMenu, setShowGridMenu] = useState(false);
    const [showViewMenu, setShowViewMenu] = useState(false);
    const viewButton = useRef<HTMLButtonElement>(null);

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
        <div className="h-12 bg-gray-950 border-b border-gray-800 flex items-center justify-between gap-2 px-3 shrink-0 z-10 shadow-sm">
            
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
                        <UndoIcon size={14} />
                    </button>
                    <div className="w-px h-4 bg-gray-800 mx-0.5 my-auto"></div>
                    <button 
                        onClick={history.redo} 
                        disabled={!history.canRedo}
                        className="p-1.5 text-gray-400 hover:text-white disabled:opacity-30 transition-colors" 
                        title="Redo (Ctrl+Y)"
                    >
                        <RedoIcon size={14} />
                    </button>
                </div>

                {/* Modes */}
                <div className="flex bg-gray-900 p-1 rounded-lg border border-gray-800">
                    <button onClick={() => setInteractionMode('select')} title="Select and transform objects (Q)" className={`flex items-center gap-2 px-2 xl:px-3 py-1.5 rounded-md transition-all text-xs font-bold ${interactionMode === 'select' ? 'bg-blue-600 text-accent-ink shadow-sm' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'}`}><PointerIcon size={14} /><span className="hidden xl:inline">Select</span></button>
                    <button onClick={() => setInteractionMode('place')} title="Place individual objects (Click to spawn)" disabled={!hasActiveBrush} className={`flex items-center gap-2 px-2 xl:px-3 py-1.5 rounded-md transition-all text-xs font-bold ${interactionMode === 'place' ? 'bg-green-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800 disabled:opacity-30'}`}><CubeIcon size={14} /><span className="hidden xl:inline">Place</span></button>
                    <button onClick={() => setInteractionMode('paint')} title="Paint trees, grass, rocks and other foliage with a brush (B)" className={`flex items-center gap-2 px-2 xl:px-3 py-1.5 rounded-md transition-all text-xs font-bold ${interactionMode === 'paint' ? 'bg-emerald-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'}`}><BrushIcon size={14} /><span className="hidden xl:inline">Foliage</span></button>
                    <div className="w-px h-4 bg-gray-700 mx-1"></div>
                    <button onClick={() => setInteractionMode('sculpt')} title="Create and sculpt terrain (T)" className={`flex items-center gap-2 px-2 xl:px-3 py-1.5 rounded-md transition-all text-xs font-bold ${interactionMode === 'sculpt' ? 'bg-amber-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'}`}><MountainIcon size={14} /><span className="hidden xl:inline">Terrain</span></button>
                    <button onClick={() => setInteractionMode('mask')} title="Create texture masks on objects (M)" className={`flex items-center gap-2 px-2 xl:px-3 py-1.5 rounded-md transition-all text-xs font-bold ${interactionMode === 'mask' ? 'bg-purple-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'}`}><EraserIcon size={14} /><span className="hidden xl:inline">Mask</span></button>
                </div>

                {/* Transform Settings (Select Mode Only) */}
                {interactionMode === 'select' && (
                    <>
                        <div className="w-px h-5 bg-gray-800 mx-2"></div>
                        <div className="flex items-center gap-2">
                            <div className="flex bg-gray-900 p-0.5 rounded-lg border border-gray-800">
                                <button onClick={() => updateTransformSettings({ tool: 'translate' })} title="Translate Tool (W)" className={`p-1.5 rounded ${transformSettings.tool === 'translate' ? 'bg-gray-700 text-white' : 'text-gray-500'}`}><MoveIcon size={14}/></button>
                                <button onClick={() => updateTransformSettings({ tool: 'rotate' })} title="Rotate Tool (E)" className={`p-1.5 rounded ${transformSettings.tool === 'rotate' ? 'bg-gray-700 text-white' : 'text-gray-500'}`}><RotateIcon size={14}/></button>
                                <button onClick={() => updateTransformSettings({ tool: 'scale' })} title="Scale Tool (R)" className={`p-1.5 rounded ${transformSettings.tool === 'scale' ? 'bg-gray-700 text-white' : 'text-gray-500'}`}><ScaleIcon size={14}/></button>
                            </div>
                            <button onClick={() => updateTransformSettings({ space: transformSettings.space === 'world' ? 'local' : 'world' })} title="Toggle Global/Local Space (Z)" className="flex items-center gap-2 text-2xs font-bold text-gray-400 hover:text-white bg-gray-900 px-2 py-1.5 rounded border border-gray-800">{transformSettings.space === 'world' ? <GlobeIcon size={12} /> : <CubeIcon size={12} />} {transformSettings.space}</button>
                        </div>
                    </>
                )}
            </div>

            {/* Right Group: Snapping & Play (always in view: less-used view options sit in the View menu) */}
            <div className="flex shrink-0 items-center gap-2">
                {/* Level Blueprint Button - Compact */}
                <button 
                    onClick={() => setInteractionMode('blueprint')}
                    className={`p-1.5 rounded-lg border transition-all ${interactionMode === 'blueprint' ? 'bg-blue-900/50 text-blue-400 border-blue-500/50' : 'bg-gray-900 border-gray-800 text-gray-400 hover:text-white hover:bg-gray-800'}`}
                    title="Open Level Blueprint Logic"
                >
                    <GraphIcon size={14} />
                </button>

                <div className="w-px h-6 bg-gray-800"></div>

                <RenderPanel />

                {/* View options: sound, camera speed, navigation and the view layout, folded into one menu. */}
                <button
                    ref={viewButton}
                    onClick={() => setShowViewMenu(open => !open)}
                    aria-expanded={showViewMenu}
                    className={`flex items-center gap-1 p-1.5 rounded-lg border transition-all ${showViewMenu ? 'bg-gray-800 text-white border-gray-700' : 'bg-gray-900 border-gray-800 text-gray-400 hover:text-white hover:bg-gray-800'}`}
                    title="View options: sound, camera speed, navigation, one view or four"
                    aria-label="View options"
                >
                    <SlidersIcon size={14} />
                    {isMuted && <MuteIcon size={12} className="text-red-400" />}
                    {showNavigation && <RouteIcon size={12} className="text-emerald-300" />}
                </button>
                <Popover anchor={viewButton} open={showViewMenu} onClose={() => setShowViewMenu(false)} width={240} label="View options">
                    <div className="space-y-2 p-2 text-xs text-gray-300">
                        <button onClick={toggleMute} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-gray-800" aria-pressed={isMuted}>
                            {isMuted ? <MuteIcon size={14} className="text-red-400" /> : <VolumeIcon size={14} />} {isMuted ? 'Sound is off' : 'Sound is on'}
                        </button>
                        <button onClick={toggleNavigation} aria-label="Show navigation" aria-pressed={showNavigation} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-gray-800">
                            <RouteIcon size={14} className={showNavigation ? 'text-emerald-300' : ''} /> {showNavigation ? 'Hide where enemies can walk' : 'Show where enemies can walk'}
                        </button>
                        <div className="px-2">
                            <div className="mb-1 flex items-center gap-1.5 text-2xs text-gray-500"><VideoIcon size={12} /> Camera speed</div>
                            <div className="flex gap-1" role="radiogroup" aria-label="Camera speed">
                                {speedOptions.map(val => (
                                    <button key={val} role="radio" aria-checked={cameraSpeed === val} onClick={() => setCameraSpeed(val)}
                                        className={`h-6 flex-1 rounded text-2xs ${cameraSpeed === val ? 'bg-blue-900/40 font-bold text-blue-300' : 'bg-gray-900 text-gray-400 hover:text-white'}`}>{val}</button>
                                ))}
                            </div>
                        </div>
                        <div className="flex gap-1 px-2" role="radiogroup" aria-label="Views">
                            <button role="radio" aria-checked={layout === 'single'} onClick={() => setLayout('single')} title="Perspective View"
                                className={`flex flex-1 items-center justify-center gap-1.5 rounded py-1.5 ${layout === 'single' ? 'bg-gray-700 text-white' : 'bg-gray-900 text-gray-400 hover:text-white'}`}><ViewSingleIcon size={14} /> One view</button>
                            <button role="radio" aria-checked={layout === 'quad'} onClick={() => setLayout('quad')} title="Quad View (Left/Right/Top/Bottom)"
                                className={`flex flex-1 items-center justify-center gap-1.5 rounded py-1.5 ${layout === 'quad' ? 'bg-gray-700 text-white' : 'bg-gray-900 text-gray-400 hover:text-white'}`}><ViewQuadIcon size={14} /> Four views</button>
                        </div>
                    </div>
                </Popover>

                {interactionMode !== 'paint' && interactionMode !== 'mask' && interactionMode !== 'blueprint' && interactionMode !== 'sculpt' && (
                    <div className="flex items-center gap-2 border-r border-gray-800 pr-4 mr-2">
                        <button onClick={() => updateTransformSettings({ snapEnabled: !transformSettings.snapEnabled })} title="Toggle Grid Snapping (X)" className={`text-gray-400 hover:text-white ${transformSettings.snapEnabled ? 'text-blue-400' : ''}`}><MagnetIcon size={16} /></button>
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
                                        <ChevronDownIcon size={10} className="text-gray-600 group-hover:text-gray-400" />
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
                                                        className={`text-2xs py-1.5 px-3 text-left hover:bg-gray-800 transition-colors ${transformSettings.snapGrid === opt.value ? 'text-blue-400 font-bold bg-blue-900/10' : 'text-gray-300'}`}
                                                    >
                                                        {opt.label}
                                                    </button>
                                                ))}
                                            </div>
                                        </>
                                    )}
                                </div>

                                <div className="flex items-center gap-1 ml-2" title="Rotation Snap Angle"><RotateIcon size={12} className="text-gray-500" /><span className="text-xs text-gray-400">{transformSettings.snapAngle}°</span></div>
                            </>
                        )}
                    </div>
                )}
                
                <div className="flex items-center rounded shadow-lg shadow-blue-900/20">
                    <button
                        onClick={() => actions.handlePlayStart()}
                        className="flex items-center gap-2 whitespace-nowrap px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-accent-ink rounded-l font-bold text-xs transition-colors"
                        title="Play the level from its Player Start"
                    >
                        <PlayIcon size={14} fill="currentColor" /> <span>Play<span className="hidden xl:inline"> level</span></span>
                    </button>
                    <button
                        onClick={() => actions.handlePlayStart(true)}
                        className="flex items-center px-2 py-1.5 bg-blue-700 hover:bg-blue-500 text-white rounded-r border-l border-blue-900 transition-colors"
                        title="Play from here: start under the editor camera"
                        aria-label="Play from here"
                    >
                        <VideoIcon size={14} />
                    </button>
                </div>
            </div>
        </div>
    );
};
