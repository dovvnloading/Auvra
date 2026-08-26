import { GraphState } from '../../../types';

export const getGraphCoordinates = (
    clientX: number, 
    clientY: number, 
    viewport: { x: number; y: number; scale: number },
    container: HTMLDivElement | null
) => {
    if (!container) return { x: 0, y: 0 };
    const rect = container.getBoundingClientRect();
    return {
        x: (clientX - rect.left - viewport.x) / viewport.scale,
        y: (clientY - rect.top - viewport.y) / viewport.scale
    };
};

export const calculateConnectionPath = (nodeA: GraphState, nodeB: GraphState) => {
    const x1 = nodeA.position.x + 160; // Right edge of A
    const y1 = nodeA.position.y + 40;  // V-Center of A
    const x2 = nodeB.position.x;       // Left edge of B
    const y2 = nodeB.position.y + 40;  // V-Center of B

    const dist = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
    const controlOffset = Math.min(dist * 0.5, 150);
    
    return `M ${x1} ${y1} C ${x1 + controlOffset} ${y1}, ${x2 - controlOffset} ${y2}, ${x2} ${y2}`;
};