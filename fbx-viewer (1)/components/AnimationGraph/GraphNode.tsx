import React from 'react';
import { Crown, Play } from 'lucide-react';
import { GraphState } from '../../types';

interface GraphNodeProps {
    state: GraphState;
    isSelected: boolean;
    isActive: boolean;
    onPointerDown: (e: React.PointerEvent) => void;
    onClick: (e: React.MouseEvent) => void;
}

export const GraphNode: React.FC<GraphNodeProps> = ({
    state,
    isSelected,
    isActive,
    onPointerDown,
    onClick
}) => {
    return (
        <div 
            className={`
                absolute w-[160px] rounded-lg shadow-2xl cursor-default group
                border-2 transition-all duration-100 z-10
                ${isSelected ? 'border-blue-500 bg-gray-800 scale-105 shadow-blue-500/10' : (state.isRoot ? 'border-amber-600/50 bg-gray-900' : 'border-gray-700 bg-gray-900 hover:border-gray-600')}
            `}
            style={{ left: state.position.x, top: state.position.y }}
            onPointerDown={onPointerDown}
            onClick={onClick}
        >
            {/* Header */}
            <div className={`px-3 py-2 border-b flex items-center justify-between ${isSelected ? 'border-blue-900 bg-blue-900/20' : (state.isRoot ? 'border-amber-800 bg-amber-900/20' : 'border-gray-800 bg-gray-950/30')}`}>
                <div className="flex items-center gap-2">
                    {state.isRoot && <Crown size={12} className="text-amber-400" />}
                    <span className={`text-xs font-bold truncate ${state.isRoot ? 'text-amber-100' : 'text-gray-200'}`}>{state.name}</span>
                </div>
                {isActive && (
                    <span className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.8)] animate-pulse"></span>
                )}
            </div>
            
            {/* Body */}
            <div className="p-3 text-[10px] text-gray-400 space-y-2">
                {state.clipName ? (
                    <div className="flex items-center gap-1.5 text-blue-300 bg-blue-950/30 px-2 py-1 rounded border border-blue-900/30">
                        <Play size={8} /> 
                        <span className="truncate">{state.clipName}</span>
                    </div>
                ) : (
                    <span className="italic opacity-50 block text-center py-1">No animation</span>
                )}
                
                <div className="flex items-center justify-between pt-1 border-t border-gray-800/50">
                    <span className="text-gray-600">ID: {state.id.substring(0,4)}</span>
                    {state.loop && <span className="px-1.5 py-0.5 bg-gray-800 rounded text-gray-400 font-mono text-[8px]">LOOP</span>}
                </div>
            </div>
        </div>
    );
};