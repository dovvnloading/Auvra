import React, { useEffect, useRef } from 'react';
import { boundsOf, type Point, type Rect } from './model';

/**
 * The overview map: every node and frame of the graph in small, with the part in view outlined.
 * Click or drag on it to move the view there.
 */

const WIDTH = 200;
const HEIGHT = 128;
const PAD = 6;

export const Minimap: React.FC<{
    nodes: ReadonlyArray<{ rect: Rect; colour: string; selected: boolean }>;
    frames: ReadonlyArray<{ rect: Rect; colour: string }>;
    /** The part of the graph in view, in graph units. */
    view: Rect;
    /** Moves the view so its middle is here (graph units). */
    onMove: (centre: Point) => void;
}> = ({ nodes, frames, view, onMove }) => {
    const canvas = useRef<HTMLCanvasElement>(null);
    const dragging = useRef(false);
    // The box everything is fitted into: the graph and the view together.
    const world = boundsOf([...nodes.map((node) => node.rect), ...frames.map((frame) => frame.rect), view]) ?? view;
    const scale = Math.min((WIDTH - PAD * 2) / Math.max(1, world.width), (HEIGHT - PAD * 2) / Math.max(1, world.height));
    const offsetX = PAD + (WIDTH - PAD * 2 - world.width * scale) / 2;
    const offsetY = PAD + (HEIGHT - PAD * 2 - world.height * scale) / 2;

    useEffect(() => {
        const element = canvas.current;
        const context = element?.getContext('2d');
        if (!element || !context) return;
        const ratio = window.devicePixelRatio || 1;
        element.width = WIDTH * ratio;
        element.height = HEIGHT * ratio;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, WIDTH, HEIGHT);
        const toMap = (rect: Rect) => [offsetX + (rect.x - world.x) * scale, offsetY + (rect.y - world.y) * scale, Math.max(1, rect.width * scale), Math.max(1, rect.height * scale)] as const;
        for (const frame of frames) {
            context.fillStyle = `${frame.colour}55`;
            context.fillRect(...toMap(frame.rect));
        }
        for (const node of nodes) {
            context.fillStyle = node.selected ? 'rgb(240 138 60)' : node.colour;
            context.fillRect(...toMap(node.rect));
        }
        const [x, y, w, h] = toMap(view);
        context.strokeStyle = 'rgba(226, 227, 229, 0.85)';
        context.lineWidth = 1;
        context.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
        context.fillStyle = 'rgba(226, 227, 229, 0.06)';
        context.fillRect(x, y, w, h);
    }, [frames, nodes, offsetX, offsetY, scale, view, world.x, world.y]);

    const moveTo = (event: React.PointerEvent) => {
        const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
        onMove({ x: world.x + (event.clientX - box.left - offsetX) / scale, y: world.y + (event.clientY - box.top - offsetY) / scale });
    };

    return (
        <div
            data-overlay
            role="img"
            aria-label="Overview map of the graph: click or drag to move the view"
            title="Click or drag to move the view"
            className="absolute bottom-2 right-2 z-20 cursor-pointer overflow-hidden rounded-md border border-line bg-ground/90 shadow"
            style={{ width: WIDTH, height: HEIGHT }}
            onPointerDown={(event) => {
                event.stopPropagation();
                (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
                dragging.current = true;
                moveTo(event);
            }}
            onPointerMove={(event) => { if (dragging.current) moveTo(event); }}
            onPointerUp={() => { dragging.current = false; }}
            onDoubleClick={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <canvas ref={canvas} style={{ width: WIDTH, height: HEIGHT }} />
        </div>
    );
};
