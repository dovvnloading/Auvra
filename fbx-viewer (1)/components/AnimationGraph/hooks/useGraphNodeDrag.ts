import React, { useState, useCallback } from 'react';
import { AnimationGraphData } from '../../../types';
import { getGraphCoordinates } from '../utils/graphMath';

interface DragState {
    nodeId: string | null;
    offset: { x: number; y: number };
}

export const useGraphNodeDrag = (
    graph: AnimationGraphData,
    modelId: string,
    updateGraph: (modelId: string, data: Partial<AnimationGraphData>) => void,
    viewport: { x: number; y: number; scale: number },
    onSelectNode: (id: string | null) => void
) => {
    const [dragState, setDragState] = useState<DragState>({ nodeId: null, offset: { x: 0, y: 0 } });

    const startDrag = useCallback((e: React.PointerEvent, nodeId: string, nodeX: number, nodeY: number, container: HTMLDivElement | null) => {
        e.stopPropagation();
        e.preventDefault();
        (e.target as Element).setPointerCapture(e.pointerId);
        
        onSelectNode(nodeId);
        
        const mousePos = getGraphCoordinates(e.clientX, e.clientY, viewport, container);
        setDragState({
            nodeId,
            offset: { x: mousePos.x - nodeX, y: mousePos.y - nodeY }
        });
    }, [onSelectNode, viewport]);

    const updateDrag = useCallback((e: React.PointerEvent, container: HTMLDivElement | null) => {
        if (!dragState.nodeId || !container) return;

        const mousePos = getGraphCoordinates(e.clientX, e.clientY, viewport, container);
        const newX = mousePos.x - dragState.offset.x;
        const newY = mousePos.y - dragState.offset.y;

        const updatedStates = graph.states.map(s => 
            s.id === dragState.nodeId ? { ...s, position: { x: newX, y: newY } } : s
        );
        
        updateGraph(modelId, { states: updatedStates });
    }, [dragState, graph.states, modelId, updateGraph, viewport]);

    const endDrag = useCallback((e: React.PointerEvent) => {
        if (dragState.nodeId) {
            setDragState({ nodeId: null, offset: { x: 0, y: 0 } });
            (e.target as Element).releasePointerCapture(e.pointerId);
        }
    }, [dragState.nodeId]);

    return {
        draggingNodeId: dragState.nodeId,
        startDrag,
        updateDrag,
        endDrag
    };
};