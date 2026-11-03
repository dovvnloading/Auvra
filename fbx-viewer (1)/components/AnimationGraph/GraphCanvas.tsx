import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Plus, Undo2, Redo2 } from 'lucide-react';
import { AnimationGraphData } from '../../types';
import { GraphNode } from './GraphNode';
import { GraphConnection } from './GraphConnection';
import { calculateConnectionPath } from './utils/graphMath';
import { useGraphViewport } from './hooks/useGraphViewport';
import { useGraphNodeDrag } from './hooks/useGraphNodeDrag';
import { anyStateTransitionsByTarget, useGraphConnections } from './hooks/useGraphConnections';
import { useGraphActions } from './hooks/useGraphActions';

interface GraphCanvasProps {
    graph: AnimationGraphData;
    modelId: string;
    updateGraph: (modelId: string, data: Partial<AnimationGraphData>) => void;
    selectedNodeId: string | null;
    onSelectNode: (id: string | null) => void;
    availableClips: { name: string; clip: any }[];
    /** Applies node-drag moves without recording each step; defaults to updateGraph. */
    updateGraphLive?: (modelId: string, data: Partial<AnimationGraphData>) => void;
    /** Records the pre-drag graph once a node move ends. */
    onMoveEnd?: (before: AnimationGraphData) => void;
    onUndo?: () => void;
    onRedo?: () => void;
    canUndo?: boolean;
    canRedo?: boolean;
    /** The state the preview runtime is in; highlighted on the canvas. Null when nothing runs. */
    activeStateId?: string | null;
    /** The transition the preview runtime took last; highlighted briefly each time it fires. */
    firedTransition?: FiredTransition | null;
    /** Opens a State Machine state (double-click) to edit the states inside it. */
    onOpenStateMachine?: (id: string) => void;
}

/** A transition the preview runtime just took; `seq` grows with every firing, so a repeat flashes again. */
export interface FiredTransition {
    id: string;
    seq: number;
}

/** How long a fired transition stays highlighted on the canvas. */
export const FIRED_TRANSITION_HIGHLIGHT_MS = 1200;

const stopCanvasPointer = (e: React.PointerEvent) => e.stopPropagation();

export const GraphCanvas: React.FC<GraphCanvasProps> = ({
    graph,
    modelId,
    updateGraph,
    selectedNodeId,
    onSelectNode,
    availableClips,
    updateGraphLive,
    onMoveEnd,
    onUndo,
    onRedo,
    canUndo = false,
    canRedo = false,
    activeStateId = null,
    firedTransition = null,
    onOpenStateMachine
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
    } = useGraphNodeDrag(graph, modelId, updateGraphLive ?? updateGraph, viewport, onSelectNode, onMoveEnd);

    // 4. Data Preparation (Calculations)
    const connectionGroups = useGraphConnections(graph);
    const anyStateTransitions = useMemo(() => anyStateTransitionsByTarget(graph), [graph]);

    // 5. Live debug: the last fired transition glows for a moment.
    const [flash, setFlash] = useState<FiredTransition | null>(null);
    useEffect(() => {
        setFlash(firedTransition);
        if (!firedTransition) return;
        const timer = window.setTimeout(() => setFlash(null), FIRED_TRANSITION_HIGHLIGHT_MS);
        return () => window.clearTimeout(timer);
    }, [firedTransition]);
    const flashGroup = flash ? connectionGroups.find(group => group.transitions.some(t => t.id === flash.id)) : undefined;

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
             className="flex-1 relative overflow-hidden bg-well cursor-grab active:cursor-grabbing" 
             ref={canvasRef} 
             onWheel={(e) => handleWheel(e, canvasRef.current)}
             onPointerDown={onPointerDown}
             onPointerMove={onPointerMove}
             onPointerUp={onPointerUp}
             onPointerLeave={onPointerUp}
        >
            {/* Toolbar */}
            <div className="absolute top-4 right-4 z-30 flex gap-2">
                {onUndo && onRedo && (
                    <>
                        <button
                            onPointerDown={stopCanvasPointer}
                            onClick={onUndo}
                            disabled={!canUndo}
                            className="flex items-center justify-center w-8 h-8 bg-gray-800 hover:bg-gray-700 text-white rounded-lg shadow-lg border border-gray-700 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-gray-800"
                            title="Undo (Ctrl+Z)"
                            aria-label="Undo"
                        >
                            <Undo2 size={14} />
                        </button>
                        <button
                            onPointerDown={stopCanvasPointer}
                            onClick={onRedo}
                            disabled={!canRedo}
                            className="flex items-center justify-center w-8 h-8 bg-gray-800 hover:bg-gray-700 text-white rounded-lg shadow-lg border border-gray-700 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-gray-800"
                            title="Redo (Ctrl+Y)"
                            aria-label="Redo"
                        >
                            <Redo2 size={14} />
                        </button>
                    </>
                )}
                <button
                    onClick={resetViewport}
                    className="flex items-center justify-center w-8 h-8 bg-gray-800 hover:bg-gray-700 text-white rounded-lg shadow-lg border border-gray-700"
                    title="Reset View"
                >
                    <Search size={14} />
                </button>
                <button 
                    onClick={() => addState(canvasRef.current)} 
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-accent-ink rounded-lg shadow-lg text-xs font-bold transition-all border border-blue-400"
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

                    {flash && flashGroup && (
                        <path
                            key={flash.seq}
                            d={calculateConnectionPath(flashGroup.nodeA, flashGroup.nodeB)}
                            stroke="#22c55e"
                            strokeWidth={6}
                            strokeLinecap="round"
                            fill="none"
                            className="pointer-events-none"
                            style={{ filter: 'drop-shadow(0 0 6px rgba(34,197,94,0.8))' }}
                            data-fired-transition={flash.id}
                        >
                            <animate attributeName="stroke-opacity" from="1" to="0" dur={`${FIRED_TRANSITION_HIGHLIGHT_MS}ms`} fill="freeze" />
                        </path>
                    )}
                </svg>

                {/* Any-state transitions: a tag above each target, one button per transition */}
                {graph.states.filter(state => anyStateTransitions.has(state.id)).map(state => (
                    <div
                        key={`any-${state.id}`}
                        className="absolute flex gap-1 z-10"
                        style={{ left: state.position.x, top: state.position.y - 22 }}
                    >
                        {anyStateTransitions.get(state.id)!.map(transition => (
                            <button
                                key={transition.id}
                                type="button"
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={(e) => { e.stopPropagation(); onSelectNode(transition.id); }}
                                className={`px-1.5 py-0.5 rounded text-2xs font-bold border transition-colors ${selectedNodeId === transition.id ? 'bg-blue-600 border-blue-400 text-accent-ink' : flash?.id === transition.id ? 'bg-green-700 border-green-400 text-accent-ink' : 'bg-gray-800 border-gray-600 text-gray-300 hover:border-blue-500'}`}
                                title="Any State transition: fires from every other state"
                            >
                                Any &rarr;
                            </button>
                        ))}
                    </div>
                ))}

                {/* Nodes Layer */}
                {graph.states.map(state => (
                    <GraphNode 
                        key={state.id}
                        state={state}
                        isSelected={selectedNodeId === state.id}
                        isActive={state.id === activeStateId}
                        onPointerDown={(e) => startDrag(e, state.id, state.position.x, state.position.y, canvasRef.current)}
                        onClick={(e) => {
                            e.stopPropagation();
                            if (e.shiftKey && selectedNodeId && selectedNodeId !== state.id) {
                                addTransition(selectedNodeId, state.id);
                            }
                            onSelectNode(state.id);
                        }}
                        onDoubleClick={state.stateType === 'StateMachine' && onOpenStateMachine ? (e) => {
                            e.stopPropagation();
                            onOpenStateMachine(state.id);
                        } : undefined}
                    />
                ))}
            </div>
            
            <div className="absolute bottom-4 left-4 z-20 text-2xs text-gray-600 select-none pointer-events-none font-mono bg-black/50 p-2 rounded">
               Pan: Drag BG <br/> Zoom: Wheel <br/> Move Node: Drag Node <br/> Connect: Shift+Click{onUndo && <><br/> Undo: Ctrl+Z / Redo: Ctrl+Y</>}
            </div>
        </div>
    );
};