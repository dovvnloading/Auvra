import React from 'react';
import { GraphTransition, GraphState } from '../../types';
import { calculateConnectionPath } from './utils/graphMath';

interface GraphConnectionProps {
    nodeA: GraphState; // "Left" Node (source of visual line)
    nodeB: GraphState; // "Right" Node (target of visual line)
    transitions: GraphTransition[];
    selectedNodeId: string | null;
    onSelect: (id: string) => void;
}

export const GraphConnection: React.FC<GraphConnectionProps> = ({
    nodeA,
    nodeB,
    transitions,
    selectedNodeId,
    onSelect
}) => {
    const path = calculateConnectionPath(nodeA, nodeB);
    
    // Determine Directionality & Selection
    const hasForward = transitions.some(t => t.fromStateId === nodeA.id && t.toStateId === nodeB.id);
    const hasBackward = transitions.some(t => t.fromStateId === nodeB.id && t.toStateId === nodeA.id);
    
    const isSelected = transitions.some(t => t.id === selectedNodeId);
    
    // Determine colors
    const strokeColor = isSelected ? "#3b82f6" : "#64748b";
    const strokeWidth = isSelected ? 4 : 2;
    const strokeOpacity = isSelected ? 1 : 0.5;

    // Markers
    const markerEnd = hasForward 
        ? (isSelected ? "url(#arrow-end-selected)" : "url(#arrow-end)") 
        : undefined;
        
    const markerStart = hasBackward
        ? (isSelected ? "url(#arrow-start-selected)" : "url(#arrow-start)")
        : undefined;

    const handleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        
        // Cycle selection through transitions in this group
        if (transitions.length === 0) return;
        
        const currentIndex = transitions.findIndex(t => t.id === selectedNodeId);
        let nextIndex = 0;
        if (currentIndex !== -1) {
            nextIndex = (currentIndex + 1) % transitions.length;
        }
        onSelect(transitions[nextIndex].id);
    };

    return (
        <g onClick={handleClick} className="group cursor-pointer">
            {/* Invisible wide stroke for easier clicking */}
            <path 
                d={path} 
                stroke="transparent" 
                strokeWidth="20" 
                fill="none" 
            />
            
            {/* Visible Line */}
            <path 
                d={path} 
                stroke={strokeColor} 
                strokeWidth={strokeWidth} 
                strokeOpacity={strokeOpacity}
                fill="none" 
                markerEnd={markerEnd}
                markerStart={markerStart}
                className="transition-colors duration-200"
            />

            {/* Selection/Hover Halo (Optional) */}
            {isSelected && (
                <path 
                    d={path} 
                    stroke="#3b82f6" 
                    strokeWidth="8" 
                    strokeOpacity="0.1" 
                    fill="none" 
                    className="pointer-events-none"
                />
            )}
        </g>
    );
};