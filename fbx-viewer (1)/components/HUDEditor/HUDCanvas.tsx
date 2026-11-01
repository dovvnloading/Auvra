import React, { useCallback, useMemo, useRef, useState } from 'react';
import { clampHUDPosition, HUD_REFERENCE_SIZE, HUDLayout, HUDElement, normalizeHUDLayout } from './types';
import { HUDRenderer } from './HUDRenderer';
import type { HUDDocumentData } from '../../runtime/types';

interface HUDCanvasProps {
    elements: HUDElement[];
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    onUpdate: (id: string, updates: Partial<HUDElement>) => void;
    layout?: HUDLayout;
    onScaleChange?: (scale: number) => void;
    /** Fired once when an element drag begins, before any `onUpdate` from that drag. */
    onDragStart?: (id: string) => void;
    /** Fired once when an element drag ends (pointer released). */
    onDragEnd?: (id: string) => void;
    /** Elements a proposal under review would change or remove: shown as such, and not to be dragged. */
    proposed?: { changed: ReadonlySet<string>; removed: ReadonlySet<string> } | null;
}

export const HUDCanvas: React.FC<HUDCanvasProps> = ({ elements, selectedId, onSelect, onUpdate, layout, onScaleChange, onDragStart, onDragEnd, proposed }) => {
    const canvasRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const normalizedLayout = useMemo(() => normalizeHUDLayout(layout || HUD_REFERENCE_SIZE), [layout]);
    const hudDocument = useMemo<HUDDocumentData>(() => ({ id: 'hud-editor', elements, layout: normalizedLayout }), [elements, normalizedLayout]);
    const [scale, setScale] = useState(1);
    const [isDragging, setIsDragging] = useState(false);
    const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
    const [dragId, setDragId] = useState<string | null>(null);
    const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

    // HUDRenderer owns the letterboxed stage layout; the editor only needs its scale.
    const handleScaleChange = useCallback((next: number) => {
        setScale(next);
        onScaleChange?.(next);
    }, [onScaleChange]);

    const toLogicalPoint = useCallback((e: React.PointerEvent) => {
        const rect = stageRef.current?.getBoundingClientRect();
        if (!rect || scale <= 0) return { x: 0, y: 0 };
        return {
            x: (e.clientX - rect.left) / scale,
            y: (e.clientY - rect.top) / scale,
        };
    }, [scale]);

    const handlePointerDown = (e: React.PointerEvent, element: HUDElement, position: HUDElement['position']) => {
        if (element.isLocked || proposed?.changed.has(element.id) || proposed?.removed.has(element.id)) return;
        
        e.stopPropagation();
        e.preventDefault();
        
        onSelect(element.id);
        
        const point = toLogicalPoint(e);
        // Calculate the offset in logical document coordinates, not screen pixels.
        setDragOffset({
            x: point.x - position.x,
            y: point.y - position.y,
        });
        
        setDragId(element.id);
        setIsDragging(true);
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        onDragStart?.(element.id);
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
            const endedId = dragId;
            setIsDragging(false);
            setDragId(null);
            const target = e.currentTarget as Element;
            if (target.hasPointerCapture?.(e.pointerId)) target.releasePointerCapture(e.pointerId);
            if (endedId) onDragEnd?.(endedId);
        }
    };

    const handleCanvasClick = (e: React.MouseEvent) => {
        // Deselect if clicked on empty canvas or stage, never on an element.
        if (!(e.target as Element).closest?.('[data-hud-element]')) {
            onSelect(null);
        }
    };

    const markScale = Math.max(scale, 0.05);

    const renderElement = (el: HUDElement, position: HUDElement['position'], content: React.ReactNode) => {
        const isSelected = selectedId === el.id;
        const proposedChange = proposed?.changed.has(el.id);
        const proposedRemoval = proposed?.removed.has(el.id);
        return (
            <div
                data-hud-element={el.id}
                onPointerDown={(e) => handlePointerDown(e, el, position)}
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
                <div className={`w-full h-full overflow-hidden ${proposedRemoval ? 'opacity-40' : ''}`}>
                    {content}
                </div>

                {(proposedChange || proposedRemoval) && (
                    <>
                        <div
                            className={`pointer-events-none absolute border-dashed ${proposedRemoval ? 'border-bad' : 'border-accent'}`}
                            style={{ inset: -3 / markScale, borderWidth: 1.5 / markScale }}
                        />
                        <div
                            className={`pointer-events-none absolute left-0 whitespace-nowrap rounded-sm ${proposedRemoval ? 'bg-bad text-ground' : 'bg-accent text-accent-ink'}`}
                            style={{ top: -22 / markScale, fontSize: 11 / markScale, lineHeight: `${16 / markScale}px`, paddingInline: 4 / markScale }}
                        >
                            {proposedRemoval ? 'To remove' : 'Proposed'}: {el.name}
                        </div>
                    </>
                )}

                {/* Label on Hover */}
                <div className="absolute -top-5 left-0 bg-blue-600 text-accent-ink text-[9px] px-1 rounded opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity">
                    {el.name}
                </div>
            </div>
        );
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

            <HUDRenderer
                document={hudDocument}
                stageRef={stageRef}
                stageClassName="bg-[#111111]"
                onScaleChange={handleScaleChange}
                renderElement={renderElement}
                stageChildren={<>
                    {/* Viewport safe zone in logical document coordinates. */}
                    <div className="absolute inset-8 pointer-events-none border-2 border-blue-500/20" />
                    <div className="absolute top-9 left-9 text-[10px] text-blue-500/50 font-mono pointer-events-none">VIEWPORT SAFE ZONE</div>
                </>}
            />
        </div>
    );
};
