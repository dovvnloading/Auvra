
import React, { useRef, useState, useMemo, useCallback } from 'react';
import { Search } from 'lucide-react';
import { LogicConnection, LogicPin, LevelBlueprintData, LevelObject, PinDataType } from '../../types';
import { LogicNodeComponent, PIN_COLORS } from './LogicNode';
import { LogicConnection as LogicConnectionComponent } from './LogicConnection';
import { useGraphViewport } from '../AnimationGraph/hooks/useGraphViewport';

interface LogicCanvasProps {
    blueprint: LevelBlueprintData;
    updateBlueprint: (data: Partial<LevelBlueprintData>) => void;
    onSelectNode: (id: string | null) => void;
    selectedNodeId: string | null;
    levelObjects: LevelObject[];
}

export const LogicCanvas: React.FC<LogicCanvasProps> = ({
    blueprint,
    updateBlueprint,
    onSelectNode,
    selectedNodeId,
    levelObjects
}) => {
    const canvasRef = useRef<HTMLDivElement>(null);
    const { viewport, isPanning, handleWheel, beginPan, endPan, updatePan, resetViewport } = useGraphViewport();
    
    const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
    const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

    const [connectingPin, setConnectingPin] = useState<{ nodeId: string, pin: LogicPin, x: number, y: number } | null>(null);
    const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

    // Store calculated pin offsets. Note: These are now sent immediately by the node on mount via effect.
    // Because they are deterministic math, they are stable.
    const pinLayouts = useRef<Record<string, { x: number, y: number }>>({});
    const [tick, setTick] = useState(0); 

    const handleRegisterLayout = useCallback((nodeId: string, width: number, height: number, pinOffsets: Record<string, { x: number, y: number }>) => {
        let hasChanges = false;
        
        Object.entries(pinOffsets).forEach(([pinId, offset]) => {
            const current = pinLayouts.current[pinId];
            if (!current || current.x !== offset.x || current.y !== offset.y) {
                pinLayouts.current[pinId] = offset;
                hasChanges = true;
            }
        });

        if (hasChanges) {
            setTick(t => t + 1);
        }
    }, []);

    const getCanvasCoords = (clientX: number, clientY: number) => {
        if (!canvasRef.current) return { x: 0, y: 0 };
        const rect = canvasRef.current.getBoundingClientRect();
        return {
            x: (clientX - rect.left - viewport.x) / viewport.scale,
            y: (clientY - rect.top - viewport.y) / viewport.scale
        };
    };

    const handleCanvasDown = (e: React.PointerEvent) => {
        if (e.button === 0 || e.button === 1) { 
            beginPan();
            (e.target as Element).setPointerCapture(e.pointerId);
            onSelectNode(null); 
        }
    };

    const handleNodeDragStart = (e: React.PointerEvent, nodeId: string, nodeX: number, nodeY: number) => {
        e.stopPropagation();
        e.preventDefault();
        onSelectNode(nodeId);
        
        const coords = getCanvasCoords(e.clientX, e.clientY);
        setDraggingNodeId(nodeId);
        setDragOffset({ x: coords.x - nodeX, y: coords.y - nodeY });
        (e.target as Element).setPointerCapture(e.pointerId);
    };

    const handlePinDown = (e: React.PointerEvent, nodeId: string, pin: LogicPin) => {
        e.stopPropagation();
        e.preventDefault();
        
        // Calculate Absolute Pin Position immediately
        const node = blueprint.nodes.find(n => n.id === nodeId);
        const pinOffset = pinLayouts.current[pin.id];
        
        if (node && pinOffset) {
            const absX = node.position.x + pinOffset.x;
            const absY = node.position.y + pinOffset.y;
            
            setConnectingPin({ nodeId, pin, x: absX, y: absY });
            setMousePos({ x: absX, y: absY });
        }
    };

    const areTypesCompatible = (t1: PinDataType, t2: PinDataType) => {
        if (t1 === t2) return true;
        if ((t1 === 'Float' && t2 === 'Integer') || (t1 === 'Integer' && t2 === 'Float')) return true;
        if (t1 === 'String' || t2 === 'String') return true;
        // Objects can connect to each other generally (runtime check)
        if (t1 === 'Object' || t2 === 'Object') return true; 
        return false;
    };

    const handlePinUp = (e: React.PointerEvent, targetNodeId: string, targetPin: LogicPin) => {
        e.stopPropagation();
        if (connectingPin) {
            /**
             * ---------------------------------------------------------------------------
             * CRITICAL: CONNECTION CREATION LOGIC
             * ---------------------------------------------------------------------------
             * Validates and creates a new LogicConnection object when a user releases
             * a drag on a target pin.
             * 
             * RULES:
             * 1. Cannot connect to self (Node A -> Node A).
             * 2. Cannot connect Input to Input or Output to Output.
             * 3. Types must be compatible (areTypesCompatible).
             * 
             * ---------------------------------------------------------------------------
             * WARNING: DO NOT CHANGE THIS LOGIC. EVER.
             * ---------------------------------------------------------------------------
             * Relaxing these constraints will corrupt the execution graph and crash the runtime.
             * 
             * ZERO CHANGES ARE PERMITTED TO THIS VALIDATION FLOW.
             * ---------------------------------------------------------------------------
             */
            // Validate Connection
            if (connectingPin.nodeId !== targetNodeId && // Different nodes
                connectingPin.pin.direction !== targetPin.direction && // Input to Output
                areTypesCompatible(connectingPin.pin.dataType, targetPin.dataType)) 
            {
                // Disconnect existing input connection (inputs only accept 1 wire)
                let newConnections = [...blueprint.connections];
                const inputPinId = connectingPin.pin.direction === 'Input' ? connectingPin.pin.id : targetPin.id;
                newConnections = newConnections.filter(c => c.toPinId !== inputPinId);

                // Create LogicConnection
                const sourceIsFrom = connectingPin.pin.direction === 'Output';
                const newConn: LogicConnection = {
                    id: crypto.randomUUID(),
                    fromNodeId: sourceIsFrom ? connectingPin.nodeId : targetNodeId,
                    fromPinId: sourceIsFrom ? connectingPin.pin.id : targetPin.id,
                    toNodeId: sourceIsFrom ? targetNodeId : connectingPin.nodeId,
                    toPinId: sourceIsFrom ? targetPin.id : connectingPin.pin.id
                };
                
                updateBlueprint({ connections: [...newConnections, newConn] });
            }
            setConnectingPin(null);
        }
    };

    const handleNodeUpdate = (id: string, data: any) => {
        const updatedNodes = blueprint.nodes.map(n => {
            if (n.id === id) {
                const { name, ...restData } = data;
                return { 
                    ...n, 
                    name: name || n.name,
                    data: { ...(n.data || {}), ...restData } 
                };
            }
            return n;
        });
        updateBlueprint({ nodes: updatedNodes });
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        const coords = getCanvasCoords(e.clientX, e.clientY);
        setMousePos(coords);

        if (isPanning) {
            updatePan(e.movementX, e.movementY);
        } else if (draggingNodeId) {
            const rawX = coords.x - dragOffset.x;
            const rawY = coords.y - dragOffset.y;
            // Snap to 20px grid
            const newX = Math.round(rawX / 20) * 20;
            const newY = Math.round(rawY / 20) * 20;
            
            const updatedNodes = blueprint.nodes.map(n => 
                n.id === draggingNodeId ? { ...n, position: { x: newX, y: newY } } : n
            );
            updateBlueprint({ nodes: updatedNodes });
        }
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        endPan();
        setDraggingNodeId(null);
        setConnectingPin(null);
        (e.target as Element).releasePointerCapture(e.pointerId);
    };

    // --- CONNECTION RENDERING ---
    const connectionData = useMemo(() => {
        /**
         * ---------------------------------------------------------------------------
         * CRITICAL: CONNECTION RENDERING LOGIC
         * ---------------------------------------------------------------------------
         * This memoized calculation determines the start (x1, y1) and end (x2, y2) 
         * points for every wire in the blueprint.
         * 
         * HOW IT WORKS:
         * 1. Iterates over `blueprint.connections`.
         * 2. Lookups source (From) and target (To) Nodes.
         * 3. Retrieves the precise pin offsets calculated in LogicNode.tsx (`pinLayouts.current`).
         * 4. Combines Node Position + Pin Offset to get absolute canvas coordinates.
         * 
         * ---------------------------------------------------------------------------
         * WARNING: DO NOT CHANGE THIS LOGIC. EVER.
         * ---------------------------------------------------------------------------
         * Any modification to how these coordinates are derived will cause wires to 
         * detach visually from nodes, rendering the graph unusable. The stability of 
         * this system depends on the exact correlation with LogicNode.tsx.
         * 
         * ZERO CHANGES ARE PERMITTED TO THE MATH BELOW.
         * THIS IS EXTREMELY VITAL FOR VISUAL CONSISTENCY.
         * ---------------------------------------------------------------------------
         */
        return blueprint.connections.map(conn => {
            const fromNode = blueprint.nodes.find(n => n.id === conn.fromNodeId);
            const toNode = blueprint.nodes.find(n => n.id === conn.toNodeId);
            const fromOffset = pinLayouts.current[conn.fromPinId];
            const toOffset = pinLayouts.current[conn.toPinId];

            if (!fromNode || !toNode || !fromOffset || !toOffset) return null;

            // Determine color from pin type
            const pin = fromNode.outputs.find(p => p.id === conn.fromPinId);
            const isExec = pin?.dataType === 'Exec';
            const color = pin ? PIN_COLORS[pin.dataType] : '#fff';

            return {
                id: conn.id,
                x1: fromNode.position.x + fromOffset.x,
                y1: fromNode.position.y + fromOffset.y,
                x2: toNode.position.x + toOffset.x,
                y2: toNode.position.y + toOffset.y,
                color,
                isExec
            };
        }).filter(Boolean);
    }, [blueprint.connections, blueprint.nodes, tick]);

    return (
        <div 
            className="flex-1 relative overflow-hidden bg-[#111111] cursor-grab active:cursor-grabbing"
            ref={canvasRef}
            onWheel={(e) => handleWheel(e, canvasRef.current)}
            onPointerDown={handleCanvasDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
        >
            <div className="absolute top-4 right-4 z-30">
                <button onClick={resetViewport} className="p-2 bg-gray-800 hover:bg-gray-700 text-white rounded border border-gray-700 shadow-md">
                    <Search size={14} />
                </button>
            </div>

            <div 
                className="absolute inset-0 w-full h-full origin-top-left"
                style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }}
            >
                {/* Grid Background */}
                <div 
                    className="absolute inset-[-200%] w-[500%] h-[500%] opacity-20 pointer-events-none" 
                    style={{ 
                        backgroundImage: 'linear-gradient(#333 1px, transparent 1px), linear-gradient(90deg, #333 1px, transparent 1px)', 
                        backgroundSize: '20px 20px',
                        left: -1000, top: -1000 
                    }}
                />
                <div 
                    className="absolute inset-[-200%] w-[500%] h-[500%] opacity-20 pointer-events-none" 
                    style={{ 
                        backgroundImage: 'linear-gradient(#444 1px, transparent 1px), linear-gradient(90deg, #444 1px, transparent 1px)', 
                        backgroundSize: '100px 100px',
                        left: -1000, top: -1000 
                    }}
                />

                {/* Nodes Layer */}
                {blueprint.nodes.map(node => (
                    <LogicNodeComponent 
                        key={node.id}
                        node={node}
                        isSelected={selectedNodeId === node.id}
                        onPointerDown={(e) => handleNodeDragStart(e, node.id, node.position.x, node.position.y)}
                        onPinMouseDown={(e, pin) => handlePinDown(e, node.id, pin)}
                        onPinMouseUp={(e, pin) => handlePinUp(e, node.id, pin)}
                        levelObjects={levelObjects}
                        onNodeUpdate={handleNodeUpdate}
                        onRegisterLayout={handleRegisterLayout}
                    />
                ))}

                {/* Connections Layer (Direct SVG) */}
                <svg className="absolute top-0 left-0 w-[50000px] h-[50000px] pointer-events-none z-0 overflow-visible">
                    {connectionData.map(conn => conn && (
                        <LogicConnectionComponent 
                            key={conn.id} 
                            x1={conn.x1}
                            y1={conn.y1}
                            x2={conn.x2}
                            y2={conn.y2}
                            color={conn.color}
                            thickness={conn.isExec ? 3 : 2}
                        />
                    ))}
                    
                    {connectingPin && (
                        <LogicConnectionComponent
                            x1={connectingPin.x}
                            y1={connectingPin.y}
                            x2={mousePos.x}
                            y2={mousePos.y}
                            color={connectingPin.pin.dataType === 'Exec' ? '#ffffff' : '#ef4444'} // Default red or white while dragging
                            isTemporary={true}
                        />
                    )}
                </svg>
            </div>
        </div>
    );
};
