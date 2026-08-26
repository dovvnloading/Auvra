

import React, { useState, useEffect, useMemo } from 'react';
import { 
    Play, GitBranch, CheckSquare, Combine, Activity, Database, MessageSquare, Trash, 
    Plus, Minus, X, Divide, ChevronRight, ChevronLeft, Equal, Hash, Type as TypeIcon, ToggleLeft, ArrowRight,
    Skull, Shield, Clock, RefreshCcw
} from 'lucide-react';
import { LogicNode, LogicPin, PinDataType, LevelObject } from '../../types';

interface LogicNodeProps {
    node: LogicNode;
    isSelected: boolean;
    onPointerDown: (e: React.PointerEvent) => void;
    onPinMouseDown: (e: React.PointerEvent, pin: LogicPin) => void;
    onPinMouseUp: (e: React.PointerEvent, pin: LogicPin) => void;
    onNodeUpdate?: (id: string, data: any) => void;
    onRegisterLayout: (nodeId: string, width: number, height: number, pinOffsets: Record<string, { x: number, y: number }>) => void;
    levelObjects?: LevelObject[];
}

// --- CONSTANTS FOR DETERMINISTIC LAYOUT ---
const NODE_WIDTH = 200;
const NODE_WIDTH_COMPACT = 140;
const HEADER_HEIGHT = 32;
const PIN_ROW_HEIGHT = 28;
const BOTTOM_PADDING = 8;
const BORDER_WIDTH = 2; // Tailwind border-2 is 2px

export const PIN_COLORS: Record<PinDataType, string> = {
    'Exec': '#ffffff',
    'Boolean': '#ef4444',
    'Float': '#10b981',
    'Integer': '#06b6d4',
    'String': '#d946ef',
    'Object': '#3b82f6',
};

const NODE_STYLES: Record<string, { border: string, bg: string, icon: React.ReactNode }> = {
    'Event': { border: 'border-red-800', bg: 'bg-red-900/90', icon: <Activity size={14} className="text-red-400" /> },
    'Branch': { border: 'border-gray-600', bg: 'bg-gray-800', icon: <GitBranch size={14} className="text-gray-300" /> },
    'Check': { border: 'border-blue-800', bg: 'bg-blue-900/40', icon: <CheckSquare size={14} className="text-blue-400" /> },
    'VariableGet': { border: 'border-emerald-800', bg: 'bg-emerald-900/40', icon: <Database size={14} className="text-emerald-400" /> },
    'VariableSet': { border: 'border-emerald-800', bg: 'bg-emerald-900/40', icon: <Database size={14} className="text-emerald-400" /> },
    'PrintString': { border: 'border-pink-800', bg: 'bg-gray-800', icon: <MessageSquare size={14} className="text-pink-400" /> },
    'DestroyActor': { border: 'border-red-800', bg: 'bg-gray-800', icon: <Trash size={14} className="text-red-400" /> },
    'Add': { border: 'border-green-800', bg: 'bg-green-900/40', icon: <Plus size={14} className="text-green-400" /> },
    'Subtract': { border: 'border-green-800', bg: 'bg-green-900/40', icon: <Minus size={14} className="text-green-400" /> },
    'Multiply': { border: 'border-green-800', bg: 'bg-green-900/40', icon: <X size={14} className="text-green-400" /> },
    'Divide': { border: 'border-green-800', bg: 'bg-green-900/40', icon: <Divide size={14} className="text-green-400" /> },
    'Greater': { border: 'border-blue-800', bg: 'bg-blue-900/40', icon: <ChevronRight size={14} className="text-blue-400" /> },
    'Less': { border: 'border-blue-800', bg: 'bg-blue-900/40', icon: <ChevronLeft size={14} className="text-blue-400" /> },
    'Equal': { border: 'border-blue-800', bg: 'bg-blue-900/40', icon: <Equal size={14} className="text-blue-400" /> },
    'And': { border: 'border-blue-800', bg: 'bg-blue-900/40', icon: <Combine size={14} className="text-blue-400" /> },
    'Or': { border: 'border-blue-800', bg: 'bg-blue-900/40', icon: <Combine size={14} className="text-blue-400" /> },
    'LiteralFloat': { border: 'border-green-700', bg: 'bg-green-950/80', icon: <Hash size={14} className="text-green-400" /> },
    'LiteralInteger': { border: 'border-cyan-700', bg: 'bg-cyan-950/80', icon: <Hash size={14} className="text-cyan-400" /> },
    'LiteralString': { border: 'border-pink-700', bg: 'bg-pink-950/80', icon: <TypeIcon size={14} className="text-pink-400" /> },
    'LiteralBoolean': { border: 'border-red-700', bg: 'bg-red-950/80', icon: <ToggleLeft size={14} className="text-red-400" /> },
    'ToString': { border: 'border-pink-800', bg: 'bg-pink-900/40', icon: <ArrowRight size={14} className="text-pink-400" /> },
    'LevelAction': { border: 'border-indigo-800', bg: 'bg-indigo-900/80', icon: <RefreshCcw size={14} className="text-indigo-400" /> },
};

export const LogicNodeComponent: React.FC<LogicNodeProps> = ({
    node,
    isSelected,
    onPointerDown,
    onPinMouseDown,
    onPinMouseUp,
    onNodeUpdate,
    onRegisterLayout,
    levelObjects = []
}) => {
    
    // --- 1. DETERMINE DIMENSIONS ---
    const isCompact = node.type.startsWith('Literal');
    const width = isCompact ? NODE_WIDTH_COMPACT : NODE_WIDTH;
    const maxPins = Math.max(node.inputs.length, node.outputs.length);
    const contentHeight = maxPins * PIN_ROW_HEIGHT;
    
    // Extra space for custom controls (dropdowns, inputs) inside the node body
    let customContentHeight = 0;
    if (isCompact) customContentHeight = 28; // Input field
    if (node.type === 'Event' && node.name.includes('Overlap')) customContentHeight = 32; // Dropdown
    if (node.data?.printMessage) customContentHeight = 20; // Message text

    const totalHeight = HEADER_HEIGHT + contentHeight + customContentHeight + BOTTOM_PADDING;

    // --- 2. CALCULATE PIN OFFSETS (MATH, NOT DOM) ---
    // This runs immediately during render phase, ensuring zero-latency sync with lines
    useEffect(() => {
        /**
         * ---------------------------------------------------------------------------
         * CRITICAL: NODE CONNECTION LAYOUT LOGIC
         * ---------------------------------------------------------------------------
         * This section calculates the exact pixel coordinates of input and output pins
         * relative to the node's position. This data is vital for drawing connection lines.
         * 
         * HOW IT WORKS:
         * 1. Iterate through inputs/outputs arrays.
         * 2. Calculate Y position based on fixed row heights (HEADER_HEIGHT, PIN_ROW_HEIGHT).
         * 3. Set X position to 0 (Left) for Inputs and 'width' (Right) for Outputs.
         * 4. Register these offsets with the parent Canvas via onRegisterLayout.
         * 
         * ---------------------------------------------------------------------------
         * WARNING: DO NOT CHANGE THIS LOGIC. EVER.
         * ---------------------------------------------------------------------------
         * modifying how offsets are calculated here will break the visual alignment 
         * of every wire in the graph. The connection system relies on strict determinism
         * between the Node's visual rendering and the Canvas's line drawing.
         * 
         * ZERO CHANGES ARE PERMITTED TO THE MATH BELOW.
         * THIS IS EXTREMELY VITAL FOR GRAPH INTEGRITY.
         * ---------------------------------------------------------------------------
         */
        const offsets: Record<string, { x: number, y: number }> = {};

        // Inputs are always on the left (x=0)
        node.inputs.forEach((pin, index) => {
            offsets[pin.id] = {
                x: 0,
                y: BORDER_WIDTH + HEADER_HEIGHT + (index * PIN_ROW_HEIGHT) + (PIN_ROW_HEIGHT / 2)
            };
        });

        // Outputs are always on the right (x=width)
        node.outputs.forEach((pin, index) => {
            offsets[pin.id] = {
                x: width,
                y: BORDER_WIDTH + HEADER_HEIGHT + (index * PIN_ROW_HEIGHT) + (PIN_ROW_HEIGHT / 2)
            };
        });

        onRegisterLayout(node.id, width, totalHeight, offsets);
    }, [node.inputs, node.outputs, width, totalHeight, node.id, onRegisterLayout]);

    // --- RENDER ---
    const style = NODE_STYLES[node.type] || { border: 'border-gray-700', bg: 'bg-gray-900', icon: <Activity size={14} /> };
    const borderClass = isSelected ? 'ring-2 ring-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.4)]' : '';
    
    return (
        <div 
            className={`
                absolute rounded-lg shadow-xl cursor-default group
                border-2 select-none overflow-hidden
                ${style.bg} ${style.border} ${borderClass}
            `}
            style={{ 
                left: node.position.x, 
                top: node.position.y,
                width: width,
                height: totalHeight
            }}
            onPointerDown={onPointerDown}
        >
            {/* --- HEADER --- */}
            <div 
                className="flex items-center justify-between px-2 bg-black/20"
                style={{ height: HEADER_HEIGHT }}
            >
                <div className="flex items-center gap-2 overflow-hidden">
                    {style.icon}
                    <span className="text-xs font-bold text-gray-100 truncate">{node.name}</span>
                </div>
                {/* Optional Status Icon */}
                {node.data?.targetBlueprintType && (
                    node.data.targetBlueprintType === 'Enemy' 
                        ? <Skull size={12} className="text-red-400" /> 
                        : <Shield size={12} className="text-blue-400" />
                )}
            </div>

            {/* --- BODY (PINS) --- */}
            <div className="relative w-full">
                
                {/* INPUT PINS (Left Side) */}
                <div className="absolute top-0 left-0 w-1/2 flex flex-col">
                    {node.inputs.map((pin, i) => (
                        <div 
                            key={pin.id} 
                            className="flex items-center justify-start pl-3 relative"
                            style={{ height: PIN_ROW_HEIGHT }}
                        >
                            {/* Pin Graphic - Absolute Positioned to match Math. Centered vertically using top-1/2 -translate-y-1/2 */}
                            <div 
                                className="absolute left-[-10px] top-1/2 -translate-y-1/2 flex items-center justify-center w-4 h-4 hover:scale-125 transition-transform cursor-crosshair z-20"
                                onPointerDown={(e) => { e.stopPropagation(); onPinMouseDown(e, pin); }}
                                onPointerUp={(e) => { e.stopPropagation(); onPinMouseUp(e, pin); }}
                            >
                                {pin.dataType === 'Exec' ? (
                                    <Play size={14} fill="white" className="text-white drop-shadow-md" />
                                ) : (
                                    <div 
                                        className="w-3 h-3 rounded-full border border-black/50 shadow-sm"
                                        style={{ backgroundColor: PIN_COLORS[pin.dataType] }}
                                    />
                                )}
                            </div>
                            {/* Label */}
                            <span className="text-[10px] text-gray-300 font-mono ml-2 truncate">{pin.name}</span>
                        </div>
                    ))}
                </div>

                {/* OUTPUT PINS (Right Side) */}
                <div className="absolute top-0 right-0 w-1/2 flex flex-col">
                    {node.outputs.map((pin, i) => (
                        <div 
                            key={pin.id} 
                            className="flex items-center justify-end pr-3 relative"
                            style={{ height: PIN_ROW_HEIGHT }}
                        >
                            {/* Label */}
                            {!isCompact && <span className="text-[10px] text-gray-300 font-mono mr-2 truncate">{pin.name}</span>}
                            
                            {/* Pin Graphic */}
                            <div 
                                className="absolute right-[-10px] top-1/2 -translate-y-1/2 flex items-center justify-center w-4 h-4 hover:scale-125 transition-transform cursor-crosshair z-20"
                                onPointerDown={(e) => { e.stopPropagation(); onPinMouseDown(e, pin); }}
                                onPointerUp={(e) => { e.stopPropagation(); onPinMouseUp(e, pin); }}
                            >
                                {pin.dataType === 'Exec' ? (
                                    <Play size={14} fill="white" className="text-white drop-shadow-md" />
                                ) : (
                                    <div 
                                        className="w-3 h-3 rounded-full border border-black/50 shadow-sm"
                                        style={{ backgroundColor: PIN_COLORS[pin.dataType] }}
                                    />
                                )}
                            </div>
                        </div>
                    ))}
                </div>

                {/* --- CUSTOM CONTROLS (Pushed down by max pins) --- */}
                <div 
                    className="absolute w-full px-2"
                    style={{ top: contentHeight }}
                >
                    {isCompact && onNodeUpdate && (
                        <div className="flex justify-center pt-1">
                            {node.type === 'LiteralBoolean' ? (
                                <div 
                                    className="flex items-center gap-2 bg-black/40 border border-gray-600 rounded px-2 py-1 cursor-pointer"
                                    onPointerDown={(e) => e.stopPropagation()}
                                >
                                    <span className={`text-[10px] font-bold ${node.data?.value ? 'text-green-400' : 'text-red-400'}`}>
                                        {node.data?.value ? 'TRUE' : 'FALSE'}
                                    </span>
                                    <input 
                                        type="checkbox" 
                                        checked={!!node.data?.value} 
                                        onChange={(e) => onNodeUpdate(node.id, { value: e.target.checked })} 
                                    />
                                </div>
                            ) : (
                                <input 
                                    type={node.type === 'LiteralString' ? 'text' : 'number'}
                                    value={node.data?.value ?? ''}
                                    onChange={(e) => onNodeUpdate(node.id, { value: node.type === 'LiteralString' ? e.target.value : parseFloat(e.target.value) })}
                                    onPointerDown={(e) => e.stopPropagation()}
                                    className="w-full bg-black/40 border border-gray-600 rounded px-1 py-0.5 text-[10px] text-center text-white focus:outline-none focus:border-white font-mono"
                                />
                            )}
                        </div>
                    )}

                    {node.type === 'Event' && node.name.includes('Overlap') && onNodeUpdate && (
                        <select
                            className="w-full bg-black/40 border border-gray-700 text-[9px] text-gray-300 rounded px-1 py-1 mt-1 focus:outline-none focus:border-red-500"
                            value={node.data?.targetActorName || ''}
                            onChange={(e) => onNodeUpdate(node.id, { targetActorName: e.target.value, name: `On Overlap (${e.target.value})` })}
                            onPointerDown={(e) => e.stopPropagation()} 
                        >
                            <option value="" disabled>Select Actor</option>
                            {levelObjects.map(obj => <option key={obj.id} value={obj.name}>{obj.name}</option>)}
                        </select>
                    )}

                    {node.data?.printMessage && (
                        <div className="pt-1 text-[9px] text-pink-300 font-mono text-center italic truncate opacity-80">
                            "{node.data.printMessage}"
                        </div>
                    )}
                </div>

            </div>
        </div>
    );
};