
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clampHUDPosition, HUD_REFERENCE_SIZE, HUDLayout, HUDElement, normalizeHUDLayout } from './types';
import { COMPONENT_REGISTRY } from './componentRegistry';

interface HUDCanvasProps {
    elements: HUDElement[];
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    onUpdate: (id: string, updates: Partial<HUDElement>) => void;
    layout?: HUDLayout;
    onScaleChange?: (scale: number) => void;
}

export const HUDCanvas: React.FC<HUDCanvasProps> = ({ elements, selectedId, onSelect, onUpdate, layout, onScaleChange }) => {
    const canvasRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const normalizedLayout = useMemo(() => normalizeHUDLayout(layout || HUD_REFERENCE_SIZE), [layout]);
    const [viewport, setViewport] = useState({ width: 0, height: 0 });
    const [isDragging, setIsDragging] = useState(false);
    const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
    const [dragId, setDragId] = useState<string | null>(null);
    const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const updateViewport = () => {
            const rect = canvas.getBoundingClientRect();
            setViewport({ width: rect.width, height: rect.height });
        };
        updateViewport();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(updateViewport);
        observer.observe(canvas);
        return () => observer.disconnect();
    }, []);

    const scale = viewport.width > 0 && viewport.height > 0
        ? Math.min(viewport.width / normalizedLayout.width, viewport.height / normalizedLayout.height)
        : 1;
    const stageOffset = {
        x: Math.max(0, (viewport.width - normalizedLayout.width * scale) / 2),
        y: Math.max(0, (viewport.height - normalizedLayout.height * scale) / 2),
    };

    useEffect(() => {
        onScaleChange?.(scale);
    }, [onScaleChange, scale]);

    const toLogicalPoint = useCallback((e: React.PointerEvent) => {
        const rect = stageRef.current?.getBoundingClientRect();
        if (!rect || scale <= 0) return { x: 0, y: 0 };
        return {
            x: (e.clientX - rect.left) / scale,
            y: (e.clientY - rect.top) / scale,
        };
    }, [scale]);

    const renderedPosition = useCallback((element: HUDElement) => (
        clampHUDPosition(element.position, element.size, normalizedLayout)
    ), [normalizedLayout]);

    const handlePointerDown = (e: React.PointerEvent, element: HUDElement) => {
        if (element.isLocked) return;
        
        e.stopPropagation();
        e.preventDefault();
        
        onSelect(element.id);
        
        const point = toLogicalPoint(e);
        const position = renderedPosition(element);
        // Calculate the offset in logical document coordinates, not screen pixels.
        setDragOffset({
            x: point.x - position.x,
            y: point.y - position.y,
        });
        
        setDragId(element.id);
        setIsDragging(true);
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if (!canvasRef.current) return;
        const point = toLogicalPoint(e);
        // The overlay reports the same logical coordinates persisted in the HUD document.
        setMousePos({ x: Math.round(point.x), y: Math.round(point.y) });

        if (!isDragging || !dragId) return;

        const element = elements.find((candidate) => candidate.id === dragId);
        if (!element) return;

        // Snap and clamp in logical 1920x1080 document coordinates.
        const snapX = Math.round((point.x - dragOffset.x) / 10) * 10;
        const snapY = Math.round((point.y - dragOffset.y) / 10) * 10;
        const position = clampHUDPosition({ x: snapX, y: snapY }, element.size, normalizedLayout);

        onUpdate(dragId, { position });
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        if (isDragging) {
            setIsDragging(false);
            setDragId(null);
            const target = e.currentTarget as Element;
            if (target.hasPointerCapture?.(e.pointerId)) target.releasePointerCapture(e.pointerId);
        }
    };

    const handleCanvasClick = (e: React.MouseEvent) => {
        // Deselect if clicked on empty canvas
        if (e.target === e.currentTarget || e.target === canvasRef.current) {
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

            {/* The stage owns the logical document coordinate space.  It is
                fitted into the available pane, but its children keep their
                authored 1920x1080 coordinates. */}
            <div
                ref={stageRef}
                className="absolute bg-[#111111]"
                onClick={handleCanvasClick}
                style={{
                    left: stageOffset.x,
                    top: stageOffset.y,
                    width: normalizedLayout.width,
                    height: normalizedLayout.height,
                    transform: `scale(${scale})`,
                    transformOrigin: 'top left',
                }}
            >
                {/* Viewport safe zone in logical document coordinates. */}
                <div className="absolute inset-8 pointer-events-none border-2 border-blue-500/20" />
                <div className="absolute top-9 left-9 text-[10px] text-blue-500/50 font-mono pointer-events-none">VIEWPORT SAFE ZONE</div>

                {elements
                    .filter(el => el.isVisible)
                    .sort((a, b) => a.zIndex - b.zIndex)
                    .map(el => {
                        const Component = COMPONENT_REGISTRY[el.type];
                        if (!Component) return null;

                        const isSelected = selectedId === el.id;
                        const position = renderedPosition(el);

                        return (
                            <div
                                key={el.id}
                                onPointerDown={(e) => handlePointerDown(e, el)}
                                style={{
                                    position: 'absolute',
                                    left: position.x,
                                    top: position.y,
                                    width: el.size.width,
                                    height: el.size.height,
                                    cursor: isDragging && dragId === el.id ? 'grabbing' : (el.isLocked ? 'default' : 'grab'),
                                    zIndex: el.zIndex,
                                    transform: 'translate(0, 0)', // GPU handling
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
        </div>
    );
};
