
import React, { useRef, useState, useCallback } from 'react';
import { HUDElement } from './types';
import { COMPONENT_REGISTRY } from './componentRegistry';

interface HUDCanvasProps {
    elements: HUDElement[];
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    onUpdate: (id: string, updates: Partial<HUDElement>) => void;
}

export const HUDCanvas: React.FC<HUDCanvasProps> = ({ elements, selectedId, onSelect, onUpdate }) => {
    const canvasRef = useRef<HTMLDivElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
    const [dragId, setDragId] = useState<string | null>(null);
    const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

    const handlePointerDown = (e: React.PointerEvent, element: HUDElement) => {
        if (element.isLocked) return;
        
        e.stopPropagation();
        e.preventDefault();
        
        onSelect(element.id);
        
        // Calculate offset from mouse to top-left of element
        setDragOffset({
            x: e.clientX - element.position.x,
            y: e.clientY - element.position.y
        });
        
        setDragId(element.id);
        setIsDragging(true);
        (e.target as Element).setPointerCapture(e.pointerId);
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if (!canvasRef.current) return;
        const rect = canvasRef.current.getBoundingClientRect();
        
        // Update overlay coordinates relative to canvas
        setMousePos({
            x: Math.round(e.clientX - rect.left),
            y: Math.round(e.clientY - rect.top)
        });

        if (!isDragging || !dragId) return;
        
        // Simple snapping to 10px grid
        const rawX = e.clientX - dragOffset.x;
        const rawY = e.clientY - dragOffset.y;
        
        const snapX = Math.round(rawX / 10) * 10;
        const snapY = Math.round(rawY / 10) * 10;

        onUpdate(dragId, { position: { x: snapX, y: snapY } });
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        if (isDragging) {
            setIsDragging(false);
            setDragId(null);
            (e.target as Element).releasePointerCapture(e.pointerId);
        }
    };

    const handleCanvasClick = (e: React.MouseEvent) => {
        // Deselect if clicked on empty canvas
        if (e.target === canvasRef.current) {
            onSelect(null);
        }
    };

    return (
        <div 
            ref={canvasRef}
            className="flex-1 bg-[#111111] relative overflow-hidden select-none"
            onClick={handleCanvasClick}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            style={{ 
                backgroundImage: 'radial-gradient(#333 1px, transparent 1px), radial-gradient(#222 1px, transparent 1px)',
                backgroundSize: '20px 20px, 100px 100px',
                backgroundPosition: '0 0, 0 0'
            }}
        >
            {/* Coordinates Overlay */}
            <div className="absolute top-4 right-4 bg-black/60 backdrop-blur px-2 py-1 rounded text-[10px] font-mono text-gray-400 border border-white/10 pointer-events-none z-[100]">
                X: {mousePos.x} Y: {mousePos.y}
            </div>

            {/* Viewport Overlay (1920x1080 Reference) */}
            <div className="absolute inset-0 pointer-events-none border-2 border-blue-500/20 m-8" />
            <div className="absolute top-9 left-9 text-[10px] text-blue-500/50 font-mono pointer-events-none">VIEWPORT SAFE ZONE</div>

            {elements
                .filter(el => el.isVisible)
                .sort((a, b) => a.zIndex - b.zIndex)
                .map(el => {
                    const Component = COMPONENT_REGISTRY[el.type];
                    if (!Component) return null;

                    const isSelected = selectedId === el.id;

                    return (
                        <div
                            key={el.id}
                            onPointerDown={(e) => handlePointerDown(e, el)}
                            style={{
                                position: 'absolute',
                                left: el.position.x,
                                top: el.position.y,
                                width: el.size.width,
                                height: el.size.height,
                                cursor: isDragging && dragId === el.id ? 'grabbing' : (el.isLocked ? 'default' : 'grab'),
                                zIndex: el.zIndex,
                                transform: 'translate(0, 0)' // GPU handling
                            }}
                            className={`
                                group transition-shadow duration-75
                                ${isSelected ? 'ring-2 ring-blue-500 z-50' : 'hover:ring-1 hover:ring-white/30'}
                            `}
                        >
                            {/* Resize Handles (Visual Only for now) */}
                            {isSelected && !el.isLocked && (
                                <>
                                    <div className="absolute -top-1 -left-1 w-2 h-2 bg-blue-500 rounded-sm" />
                                    <div className="absolute -top-1 -right-1 w-2 h-2 bg-blue-500 rounded-sm" />
                                    <div className="absolute -bottom-1 -left-1 w-2 h-2 bg-blue-500 rounded-sm" />
                                    <div className="absolute -bottom-1 -right-1 w-2 h-2 bg-blue-500 rounded-sm" />
                                </>
                            )}
                            
                            {/* Component Render */}
                            <div className="w-full h-full overflow-hidden">
                                <Component {...el.props} />
                            </div>
                            
                            {/* Label on Hover */}
                            <div className="absolute -top-5 left-0 bg-blue-600 text-white text-[9px] px-1 rounded opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity">
                                {el.name}
                            </div>
                        </div>
                    );
                })}
        </div>
    );
};
