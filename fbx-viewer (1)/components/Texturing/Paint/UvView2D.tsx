import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { UvSession } from './uvSession';

/**
 * The layout in 2D: islands of the proposed layout (or the current one), filled by their stretch,
 * over the set's base colour and the UDIM tiles. Click picks an island (Shift adds), drag moves the
 * picked ones, R turns them a quarter, + and − make them bigger or smaller (packing again keeps that),
 * L keeps them in place when packing again (shown hatched), the wheel zooms and the middle button pans.
 * Ctrl+Z and Ctrl+Y undo and redo UV edits while this view is shown.
 */

export const UvView2D: React.FC<{ uv: UvSession }> = ({ uv }) => {
    const version = useSyncExternalStore(uv.subscribe, uv.getVersion);
    const host = useRef<HTMLDivElement>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const [view, setView] = useState({ x: 40, y: 40, scale: 0 });
    const [size, setSize] = useState({ width: 0, height: 0 });
    const background = useRef<HTMLCanvasElement | null>(null);
    const drag = useRef<{ kind: 'move' | 'pan'; x: number; y: number; moved: boolean } | null>(null);
    const hatch = useRef<CanvasPattern | null>(null);

    useEffect(() => {
        const element = host.current;
        if (!element) return undefined;
        const observer = new ResizeObserver(() => {
            const box = element.getBoundingClientRect();
            setSize({ width: Math.floor(box.width), height: Math.floor(box.height) });
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    // The set's base colour behind the islands, read once per set.
    useEffect(() => {
        const stack = uv.paint.stack;
        const image = stack.outputs.get(stack.tiles[0])?.baseColor;
        if (!image) return;
        const pixels = uv.paint.gpu.readRgba8(image, 512, 512, 'raw', true);
        const picture = document.createElement('canvas');
        picture.width = picture.height = 512;
        picture.getContext('2d')!.putImageData(new ImageData(pixels, 512, 512), 0, 0);
        background.current = picture;
    }, [uv]);

    const scale = view.scale || Math.min(size.width, size.height) * 0.86;
    const toScreen = (u: number, v: number): [number, number] => [view.x + u * scale, view.y + (1 - v) * scale];
    const toUv = (x: number, y: number): [number, number] => [(x - view.x) / scale, 1 - (y - view.y) / scale];

    useEffect(() => {
        const element = canvas.current;
        if (!element || !size.width) return;
        const ratio = window.devicePixelRatio || 1;
        element.width = size.width * ratio;
        element.height = size.height * ratio;
        const g = element.getContext('2d')!;
        g.setTransform(ratio, 0, 0, ratio, 0, 0);
        g.fillStyle = '#141416';
        g.fillRect(0, 0, size.width, size.height);
        const tilesX = uv.packSettings.tilesX;
        const tilesY = uv.packSettings.tilesY;
        for (let ty = 0; ty < tilesY; ty++) {
            for (let tx = 0; tx < tilesX; tx++) {
                const [x0, y1] = toScreen(tx, ty);
                const [x1, y0] = toScreen(tx + 1, ty + 1);
                if (tx === 0 && ty === 0 && background.current && !uv.proposal) {
                    g.globalAlpha = 0.85;
                    g.drawImage(background.current, x0, y0, x1 - x0, y1 - y0);
                    g.globalAlpha = 1;
                } else {
                    g.fillStyle = '#1d1d21';
                    g.fillRect(x0, y0, x1 - x0, y1 - y0);
                }
                g.strokeStyle = '#3f3f46';
                g.strokeRect(x0, y0, x1 - x0, y1 - y0);
                g.fillStyle = '#52525b';
                g.font = '10px sans-serif';
                g.fillText(String(1001 + tx + ty * 10), x0 + 4, y0 + 12);
            }
        }
        const part = uv.paint.part;
        const proposal = uv.proposal;
        const triangles = part.indices.length / 3;
        const corner = (t: number, k: number): [number, number] => {
            if (proposal) return [proposal.cornerUv[(t * 3 + k) * 2], proposal.cornerUv[(t * 3 + k) * 2 + 1]];
            const v = part.indices[t * 3 + k];
            return [part.uvs[v * 2], part.uvs[v * 2 + 1]];
        };
        const selectedFaces = new Set<number>();
        const lockedFaces = new Set<number>();
        if (proposal) {
            for (const i of uv.selected) for (const f of proposal.charts[i].faces) selectedFaces.add(f);
            for (const i of uv.locked) for (const f of proposal.charts[i]?.faces ?? []) lockedFaces.add(f);
        }
        if (!hatch.current) {
            // Islands kept in place are hatched: fine white diagonals over their stretch colour.
            const tileCanvas = document.createElement('canvas');
            tileCanvas.width = tileCanvas.height = 8;
            const t = tileCanvas.getContext('2d')!;
            t.strokeStyle = 'rgba(255,255,255,0.45)';
            t.lineWidth = 1;
            t.beginPath();
            t.moveTo(0, 8);
            t.lineTo(8, 0);
            t.stroke();
            hatch.current = g.createPattern(tileCanvas, 'repeat');
        }
        g.lineWidth = 0.5;
        for (let t = 0; t < triangles; t++) {
            const [a, b, c] = [corner(t, 0), corner(t, 1), corner(t, 2)].map(([u, v]) => toScreen(u, v));
            g.beginPath();
            g.moveTo(a[0], a[1]);
            g.lineTo(b[0], b[1]);
            g.lineTo(c[0], c[1]);
            g.closePath();
            if (proposal) {
                const stretch = proposal.triangleStretch[t];
                g.fillStyle = selectedFaces.has(t) ? 'rgba(56,189,248,0.55)' : stretch < 0 ? 'rgba(220,40,160,0.6)' : `rgba(${Math.round(60 + 190 * stretch)},${Math.round(200 - 140 * stretch)},90,0.35)`;
                g.fill();
                if (lockedFaces.has(t) && hatch.current) {
                    g.fillStyle = hatch.current;
                    g.fill();
                }
            }
            g.strokeStyle = selectedFaces.has(t) ? 'rgba(186,230,253,0.9)' : 'rgba(228,228,231,0.35)';
            g.stroke();
        }
    }, [size, uv, version, view]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const element = host.current;
        if (!element) return undefined;
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            const box = element.getBoundingClientRect();
            const mx = event.clientX - box.left;
            const my = event.clientY - box.top;
            setView((current) => {
                const before = current.scale || Math.min(size.width, size.height) * 0.86;
                const after = Math.min(40000, Math.max(40, before * Math.exp(-event.deltaY * 0.0015)));
                return { scale: after, x: mx - (mx - current.x) * (after / before), y: my - (my - current.y) * (after / before) };
            });
        };
        element.addEventListener('wheel', onWheel, { passive: false });
        return () => element.removeEventListener('wheel', onWheel);
    }, [size]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const element = event.target as HTMLElement | null;
            if (element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA')) return;
            if (!host.current?.matches(':hover') || !uv.selected.size || event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.key.toLowerCase() === 'r') uv.transformSelected(Math.PI / 2, 1);
            else if (event.key === '+' || event.key === '=') uv.transformSelected(0, 1.05);
            else if (event.key === '-') uv.transformSelected(0, 1 / 1.05);
            else if (event.key.toLowerCase() === 'l') uv.toggleLockSelected();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [uv]);

    return (
        <div
            ref={host}
            className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
            onPointerDown={(event) => {
                (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
                const box = host.current!.getBoundingClientRect();
                const [u, v] = toUv(event.clientX - box.left, event.clientY - box.top);
                if (event.button === 1 || event.button === 2) { drag.current = { kind: 'pan', x: event.clientX, y: event.clientY, moved: false }; return; }
                const island = uv.islandAt(u, v);
                if (island >= 0) {
                    if (!event.shiftKey && !uv.selected.has(island)) uv.selected.clear();
                    uv.selected.add(island);
                } else if (!event.shiftKey) uv.selected.clear();
                uv.emit();
                drag.current = island >= 0 ? { kind: 'move', x: event.clientX, y: event.clientY, moved: false } : null;
            }}
            onPointerMove={(event) => {
                const current = drag.current;
                if (!current) return;
                const dx = event.clientX - current.x;
                const dy = event.clientY - current.y;
                current.x = event.clientX;
                current.y = event.clientY;
                if (current.kind === 'pan') setView((value) => ({ scale: value.scale || scale, x: value.x + dx, y: value.y + dy }));
                else {
                    // One undo step per drag, remembered as the islands first move.
                    if (!current.moved && (dx || dy)) uv.remember('Move islands');
                    current.moved ||= Boolean(dx || dy);
                    uv.moveSelected(dx / scale, -dy / scale);
                }
            }}
            onPointerUp={() => { drag.current = null; }}
            onContextMenu={(event) => event.preventDefault()}
        >
            <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
            {!uv.proposal && <div className="pointer-events-none absolute bottom-3 left-3 rounded bg-zinc-900/90 px-2 py-1 text-2xs text-zinc-400">The current layout. Unwrap or pack in the UVs panel to edit a new one.</div>}
            {uv.proposal && (
                <div className="pointer-events-none absolute bottom-3 left-3 rounded bg-zinc-900/90 px-2 py-1 text-2xs text-zinc-400">
                    {uv.selected.size
                        ? `${uv.selected.size} island${uv.selected.size === 1 ? '' : 's'} picked: drag to move, R turns, + and − resize, L ${uv.selectionLocked ? 'lets packing move them again' : 'keeps them in place when packing'}. Ctrl+Z undoes.`
                        : 'Click an island to pick it (Shift adds more). Hatched islands stay where they are when packing again. Ctrl+Z undoes.'}
                </div>
            )}
        </div>
    );
};
