import { useCallback } from 'react';
import { AnimationGraphData, GraphState, GraphTransition } from '../../../types';

interface UseGraphActionsProps {
    graph: AnimationGraphData;
    modelId: string;
    updateGraph: (modelId: string, data: Partial<AnimationGraphData>) => void;
    viewport: { x: number; y: number; scale: number };
    selectedNodeId: string | null;
    onSelectNode: (id: string) => void;
    availableClips: { name: string; clip: any }[];
}

export const useGraphActions = ({
    graph,
    modelId,
    updateGraph,
    viewport,
    selectedNodeId,
    onSelectNode,
    availableClips
}: UseGraphActionsProps) => {

    const addState = useCallback((canvasContainer: HTMLDivElement | null) => {
        let parentState = graph.states.find(s => s.id === selectedNodeId);
        if (!parentState) {
            parentState = graph.states.find(s => s.isRoot);
        }

        let newPosition = { x: 0, y: 0 };
        
        // Auto-layout logic
        if (parentState) {
            // Place to the right of parent
            newPosition = { x: parentState.position.x + 300, y: parentState.position.y };
            
            // Collision detection / offset
            let offset = 0;
            const checkCollision = (pos: {x: number, y: number}) => {
                return graph.states.some(s => 
                    Math.abs(s.position.x - pos.x) < 50 && 
                    Math.abs(s.position.y - (pos.y + offset)) < 50
                );
            };

            while (checkCollision(newPosition)) {
                offset += 120;
            }
            newPosition.y += offset;
        } else {
            // Center of Viewport if no parent
            const containerWidth = canvasContainer?.clientWidth || 800;
            const containerHeight = canvasContainer?.clientHeight || 600;
            const centerX = (containerWidth / 2 - viewport.x) / viewport.scale;
            const centerY = (containerHeight / 2 - viewport.y) / viewport.scale;
            newPosition = { x: centerX - 80, y: centerY - 40 };
        }

        const newStateId = crypto.randomUUID();
        const newState: GraphState = {
            id: newStateId,
            name: 'New State',
            clipName: availableClips.length > 0 ? availableClips[0].name : null,
            position: newPosition,
            loop: true,
            isRoot: graph.states.length === 0,
            stateType: 'Single',
            blendSamples: [],
            blendParamX: '',
            blendParamY: ''
        };

        const newTransitions = [...graph.transitions];
        if (parentState) {
            newTransitions.push({
                id: crypto.randomUUID(),
                fromStateId: parentState.id,
                toStateId: newStateId,
                duration: 0.2,
                conditions: []
            });
        }

        updateGraph(modelId, { states: [...graph.states, newState], transitions: newTransitions });
        onSelectNode(newStateId);
    }, [graph, modelId, selectedNodeId, viewport, availableClips, updateGraph, onSelectNode]);

    const addTransition = useCallback((fromId: string, toId: string) => {
        if (fromId === toId) return; 
        
        // Prevent duplicates
        const exists = graph.transitions.find(t => t.fromStateId === fromId && t.toStateId === toId);
        if (exists) return;

        const newTrans: GraphTransition = {
            id: crypto.randomUUID(),
            fromStateId: fromId,
            toStateId: toId,
            duration: 0.2,
            conditions: []
        };
        updateGraph(modelId, { transitions: [...graph.transitions, newTrans] });
    }, [graph.transitions, modelId, updateGraph]);

    return { addState, addTransition };
};