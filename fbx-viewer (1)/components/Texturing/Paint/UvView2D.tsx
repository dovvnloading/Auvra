import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { UvSession } from './uvSession';
import { Segmented } from '../../UI/kit';

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
    const background = useRef<Map<number, HTMLCanvasElement>>(new Map());
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

    // Each tile's current base colour behind the islands, read again (without holding up the GPU) a little
    // after the painting changes.
    const paintVersion = useSyncExternalStore(uv.paint.subscribe, uv.paint.getVersion);
    const [backgroundVersion, setBackgroundVersion] = useState(0);
    const [colourBy, setColourBy] = useState<'stretch' | 'density'>('stretch');
    const refresh = useRef<{ timer: ReturnType<typeof setTimeout> | null; reading: boolean; again: boolean; alive: boolean }>({ timer: null, reading: false, again: false, alive: true });
    const latestUv = useRef(uv);
    latestUv.current = uv;
    const readBackgrounds = useCallback(async (): Promise<void> => {
        const state = refresh.current;
        if (state.reading) { state.again = true; return; }
        state.reading = true;
        try {
            const reading = latestUv.current;
            const paint = reading.paint;
            const stack = paint.stack;
            const gpu = paint.gpu;
            if (!paint.usable) return;
            const side = Math.min(stack.size, 1024);
            const pictures = new Map<number, HTMLCanvasElement>();
            for (const tile of stack.tiles) {
                const image = stack.outputs.get(tile)?.baseColor;
                if (!image) continue;
                const small = gpu.image(side, side, 'color', 8);
                gpu.passNow(small, { fragment: 'void main() { outColor = vec4(texture(source, vUv).rgb, 1.0); }', inputs: { source: image } });
                const later = gpu.readRgba8Later(small);
                gpu.release(small);
                const pixels = await later;
                if (!pixels || !state.alive || latestUv.current !== reading) return;
                // Read bottom row first; a canvas starts at the top.
                const rows = new Uint8ClampedArray(pixels.length);
                const row = side * 4;
                for (let y = 0; y < side; y++) rows.set(pixels.subarray((side - 1 - y) * row, (side - y) * row), y * row);
                const picture = document.createElement('canvas');
                picture.width = picture.height = side;
                picture.getContext('2d')!.putImageData(new ImageData(rows, side, side), 0, 0);
                pictures.set(tile, picture);
            }
            background.current = pictures;
            setBackgroundVersion((value) => value + 1);
        } finally {
            state.reading = false;
            // Painting went on while this was read: read once more.
            if (state.again && state.alive) { state.again = false; void readBackgrounds(); }
        }
    }, []);
    // A new set starts without its old set's pictures behind it.
    useEffect(() => { background.current = new Map(); }, [uv]);
    useEffect(() => {
        const state = refresh.current;
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(() => { state.timer = null; void readBackgrounds(); }, background.current.size ? 300 : 0);
    }, [uv, paintVersion, readBackgrounds]);
    useEffect(() => {
        const state = refresh.current;
        state.alive = true;
        return () => {
            state.alive = false;
            if (state.timer) { clearTimeout(state.timer); state.timer = null; }
        };
    }, []);

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
                // The tile's own picture behind the current layout (a new layout's islands lie elsewhere).
                const picture = uv.proposal ? null : background.current.get(1001 + tx + ty * 10);
                if (picture) {
                    g.globalAlpha = 0.85;
                    g.drawImage(picture, x0, y0, x1 - x0, y1 - y0);
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
        // Texel density of each triangle against the layout's own (texture area over model area, square-rooted).
        let density: Float32Array | null = null;
        if (colourBy === 'density' && proposal) {
            density = new Float32Array(triangles);
            let uvTotal = 0, modelTotal = 0;
            for (let t = 0; t < triangles; t++) {
                const [a, b, c] = [corner(t, 0), corner(t, 1), corner(t, 2)];
                const uvArea = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
                const modelArea = uv.topology.areas[t] ?? 0;
                uvTotal += uvArea; modelTotal += modelArea;
                density[t] = modelArea > 0 ? Math.sqrt(uvArea / modelArea) : 0;
            }
            const mean = modelTotal > 0 ? Math.sqrt(uvTotal / modelTotal) : 1;
            for (let t = 0; t < triangles; t++) density[t] = mean > 0 ? density[t] / mean : 1;
        }
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
                const heat = density ? density[t] : 0;
                // Texel density: blue below the set's own, green at it, red above (twice as dense or half fully coloured).
                const shade = density ? (heat >= 1 ? `rgba(${Math.round(80 + 175 * Math.min(1, heat - 1))},${Math.round(200 - 140 * Math.min(1, heat - 1))},80,0.45)` : `rgba(70,${Math.round(200 - 100 * Math.min(1, (1 - heat) * 2))},${Math.round(90 + 165 * Math.min(1, (1 - heat) * 2))},0.45)`) : null;
                g.fillStyle = selectedFaces.has(t) ? 'rgba(56,189,248,0.55)' : shade ?? (stretch < 0 ? 'rgba(220,40,160,0.6)' : `rgba(${Math.round(60 + 190 * stretch)},${Math.round(200 - 140 * stretch)},90,0.35)`);
                g.fill();
                if (lockedFaces.has(t) && hatch.current) {
                    g.fillStyle = hatch.current;
                    g.fill();
                }
            }
            g.strokeStyle = selectedFaces.has(t) ? 'rgba(186,230,253,0.9)' : 'rgba(228,228,231,0.35)';
            g.stroke();
        }
        // Pins, for Relax.
        for (const [u, v] of uv.pinPlaces()) {
            const [x, y] = toScreen(u, v);
            g.beginPath();
            g.arc(x, y, 4, 0, Math.PI * 2);
            g.fillStyle = '#f4f4f5';
            g.fill();
            g.lineWidth = 1.5;
            g.strokeStyle = '#09090b';
            g.stroke();
        }
    }, [size, uv, version, view, backgroundVersion, colourBy]); // eslint-disable-line react-hooks/exhaustive-deps

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
                // Alt-click pins (or unpins) the point nearest the pointer, for Relax.
                if (event.altKey && uv.proposal) { uv.togglePinAt(u, v, 10 / scale); return; }
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
            {uv.proposal && (
                <div className="absolute right-3 top-3" onPointerDown={(event) => event.stopPropagation()}>
                    <Segmented value={colourBy} options={[{ value: 'stretch', label: 'Stretch' }, { value: 'density', label: 'Texel density' }]} onChange={setColourBy} label="Colour islands by" />
                </div>
            )}
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
