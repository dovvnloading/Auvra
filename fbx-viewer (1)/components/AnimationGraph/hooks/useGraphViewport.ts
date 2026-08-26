import React, { useState, useCallback } from 'react';

interface ViewportState {
    x: number;
    y: number;
    scale: number;
}

export const useGraphViewport = () => {
    const [viewport, setViewport] = useState<ViewportState>({ x: 0, y: 0, scale: 1 });
    const [isPanning, setIsPanning] = useState(false);

    const handleWheel = useCallback((e: React.WheelEvent, container: HTMLDivElement | null) => {
        if (!container) return;
        
        const ZOOM_SPEED = 0.001;
        const minScale = 0.2;
        const maxScale = 3;
        const delta = -e.deltaY * ZOOM_SPEED;
        const newScale = Math.min(Math.max(viewport.scale + delta, minScale), maxScale);
        
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const graphMouseX = (mouseX - viewport.x) / viewport.scale;
        const graphMouseY = (mouseY - viewport.y) / viewport.scale;
        const newX = mouseX - graphMouseX * newScale;
        const newY = mouseY - graphMouseY * newScale;

        setViewport({ x: newX, y: newY, scale: newScale });
    }, [viewport]);

    const beginPan = useCallback(() => setIsPanning(true), []);
    const endPan = useCallback(() => setIsPanning(false), []);
    
    const updatePan = useCallback((movementX: number, movementY: number) => {
        if (!isPanning) return;
        setViewport(prev => ({ ...prev, x: prev.x + movementX, y: prev.y + movementY }));
    }, [isPanning]);

    const resetViewport = useCallback(() => setViewport({ x: 0, y: 0, scale: 1 }), []);

    return {
        viewport,
        isPanning,
        handleWheel,
        beginPan,
        endPan,
        updatePan,
        resetViewport
    };
};