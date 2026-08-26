import React, { useRef } from 'react';
import { Search, Plus } from 'lucide-react';
import { AnimationGraphData } from '../../types';
import { GraphNode } from './GraphNode';
import { GraphConnection } from './GraphConnection';
import { useGraphViewport } from './hooks/useGraphViewport';
import { useGraphNodeDrag } from './hooks/useGraphNodeDrag';
import { useGraphConnections } from './hooks/useGraphConnections';
import { useGraphActions } from './hooks/useGraphActions';

interface GraphCanvasProps {
    graph: AnimationGraphData;
    modelId: string;
    updateGraph: (modelId: string, data: Partial<AnimationGraphData>) => void;
    selectedNodeId: string | null;
    onSelectNode: (id: string | null) => void;
    availableClips: { name: string; clip: any }[];
}

export const GraphCanvas: React.FC<GraphCanvasProps> = ({
    graph,
    modelId,
    updateGraph,
    selectedNodeId,
    onSelectNode,
    availableClips
}) => {
    const canvasRef = useRef<HTMLDivElement>(null);
    
    // --- Hook Composition ---
    
    // 1. Viewport Management (Pan/Zoom)
    const { 
        viewport, 
        isPanning, 
        handleWheel, 
        beginPan, 
        endPan, 
        updatePan, 
        resetViewport 
    } = useGraphViewport();

    // 2. Interaction Logic (Add States/Transitions)
    const { addState, addTransition } = useGraphActions({
        graph,
        modelId,
        updateGraph,
        viewport,
        selectedNodeId,
        onSelectNode,
        availableClips
    });

    // 3. Node Dragging Logic
    const { 
        draggingNodeId, 
        startDrag, 
        updateDrag, 
        endDrag 
    } = useGraphNodeDrag(graph, modelId, updateGraph, viewport, onSelectNode);

    // 4. Data Preparation (Calculations)
    const connectionGroups = useGraphConnections(graph);

    // --- Input Handlers ---

    const onPointerDown = (e: React.PointerEvent) => {
        if (e.button === 0 || e.button === 1) { 
            beginPan();
            (e.target as Element).setPointerCapture(e.pointerId);
            onSelectNode(null);
        }
    };

    const onPointerMove = (e: React.PointerEvent) => {
        if (isPanning) {
            updatePan(e.movementX, e.movementY);
        } else if (draggingNodeId) {
            updateDrag(e, canvasRef.current);
        }
    };

    const onPointerUp = (e: React.PointerEvent) => {
        endPan();
        endDrag(e);
        (e.target as Element).releasePointerCapture(e.pointerId);
    };

    return (
        <div 
             className="flex-1 relative overflow-hidden bg-[#0F0F0F] cursor-grab active:cursor-grabbing" 
             ref={canvasRef} 
             onWheel={(e) => handleWheel(e, canvasRef.current)}
             onPointerDown={onPointerDown}
             onPointerMove={onPointerMove}
             onPointerUp={onPointerUp}
             onPointerLeave={onPointerUp}
        >
            {/* Toolbar */}
            <div className="absolute top-4 right-4 z-30 flex gap-2">
                <button 
                    onClick={resetViewport}
                    className="flex items-center justify-center w-8 h-8 bg-gray-800 hover:bg-gray-700 text-white rounded-lg shadow-lg border border-gray-700"
                    title="Reset View"
                >
                    <Search size={14} />
                </button>
                <button 
                    onClick={() => addState(canvasRef.current)} 
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg shadow-lg text-xs font-bold transition-all border border-blue-400"
                >
                    <Plus size={14} /> Add State
                </button>
            </div>
            
            {/* World Container */}
            <div 
                className="absolute inset-0 w-full h-full origin-top-left"
                style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }}
            >
                {/* Background Grid */}
                <div 
                    className="absolute inset-[-200%] w-[500%] h-[500%] opacity-10 pointer-events-none" 
                    style={{ 
                        backgroundImage: 'radial-gradient(#ffffff 1px, transparent 1px)', 
                        backgroundSize: '24px 24px',
                        left: -1000, top: -1000 
                    }}>
                </div>
                
                {/* Connections Layer */}
                <svg className="absolute top-0 left-0 w-[5000px] h-[5000px] pointer-events-none z-0 overflow-visible">
                    <defs>
                        <marker id="arrow-end" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto" markerUnits="strokeWidth">
                            <path d="M0,0 L0,6 L5,3 z" fill="#64748b" />
                        </marker>
                        <marker id="arrow-end-selected" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto" markerUnits="strokeWidth">
                            <path d="M0,0 L0,6 L5,3 z" fill="#3b82f6" />
                        </marker>
                        <marker id="arrow-start" markerWidth="6" markerHeight="6" refX="0" refY="3" orient="auto" markerUnits="strokeWidth">
                            <path d="M5,0 L5,6 L0,3 z" fill="#64748b" />
                        </marker>
                         <marker id="arrow-start-selected" markerWidth="6" markerHeight="6" refX="0" refY="3" orient="auto" markerUnits="strokeWidth">
                            <path d="M5,0 L5,6 L0,3 z" fill="#3b82f6" />
                        </marker>
                    </defs>

                    {connectionGroups.map(group => (
                        <GraphConnection 
                            key={group.key}
                            nodeA={group.nodeA}
                            nodeB={group.nodeB}
                            transitions={group.transitions}
                            selectedNodeId={selectedNodeId}
                            onSelect={onSelectNode}
                        />
                    ))}
                </svg>

                {/* Nodes Layer */}
                {graph.states.map(state => (
                    <GraphNode 
                        key={state.id}
                        state={state}
                        isSelected={selectedNodeId === state.id}
                        isActive={state.id === graph.activeStateId}
                        onPointerDown={(e) => startDrag(e, state.id, state.position.x, state.position.y, canvasRef.current)}
                        onClick={(e) => {
                            e.stopPropagation();
                            if (e.shiftKey && selectedNodeId && selectedNodeId !== state.id) {
                                addTransition(selectedNodeId, state.id);
                            }
                            onSelectNode(state.id);
                        }}
                    />
                ))}
            </div>
            
            <div className="absolute bottom-4 left-4 z-20 text-[10px] text-gray-600 select-none pointer-events-none font-mono bg-black/50 p-2 rounded backdrop-blur-sm">
               Pan: Drag BG <br/> Zoom: Wheel <br/> Move Node: Drag Node <br/> Connect: Shift+Click
            </div>
        </div>
    );
};