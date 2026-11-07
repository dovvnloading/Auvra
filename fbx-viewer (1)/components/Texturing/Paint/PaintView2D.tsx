import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import type { GpuImage } from '../../../texturing/gpu/textureGpu';
import { builtInAlphaTexture } from '../../../texturing/paint/brushLibrary';
import type { PaintChannel } from '../../../texturing/paint/paintTypes';
import { pictureAspect, stencilPlace, Stroke, type BrushSettings, type StrokeTarget } from '../../../texturing/paint/strokes';
import { Select } from '../../UI/Select';
import type { PaintSession } from './paintSession';
import { StencilOverlay, type PaintTool } from './PaintViewport';

/**
 * PAINTING ON THE UV LAYOUT
 *
 * A tile's picture (a channel, or the selected layer's mask) laid flat, with every island's edge drawn over
 * it, to paint on directly with the same brushes, layers and masks as the 3D view. Dabs are laid in UV
 * space on the texels the surface covers, so a stroke running off an island stops at its edge and the
 * padding past it is filled as it is after any stroke. Drag with the middle or right button to pan, and
 * use the wheel to zoom.
 */

const tileOfTriangle = (part: PaintSession['part'], triangle: number): number => part.triangleTile[triangle];

/** A tile's picture over the view, panned and zoomed (uView: left, top, pixels per UV unit), dark round it. */
const SHOW = /* glsl */ `
uniform vec4 uView;
uniform vec2 uPixels;
uniform int uGray;
void main() {
    vec2 px = vUv * uPixels;
    vec2 uv = vec2((px.x - uView.x) / uView.z, 1.0 - ((uPixels.y - px.y) - uView.y) / uView.z);
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { outColor = vec4(0.078, 0.078, 0.086, 1.0); return; }
    vec4 c = texture(source, uv);
    outColor = vec4(uGray == 1 ? vec3(c.r) : c.rgb, 1.0);
}`;

/**
 * Edges on each tile as line ends in tile UVs: island borders (and so the seams) only, an edge no other
 * triangle shares (the same two places on the layout and on the model), or every edge for the wireframe.
 * Edges are matched by place, as a surface's corners are often apart in the mesh; matching the model too
 * keeps the borders of islands stacked on one another (mirrored halves) apart.
 */
const layoutEdges = (part: PaintSession['part'], everyEdge: boolean): Map<number, Float32Array> => {
    const at = (vertex: number, triangle: number) => `${tileOfTriangle(part, triangle)}:${Math.round((part.uvs[vertex * 2] - part.triangleShift[triangle * 2]) * 1e6)},${Math.round((part.uvs[vertex * 2 + 1] - part.triangleShift[triangle * 2 + 1]) * 1e6)}@${Math.round(part.positions[vertex * 3] * 1e5)},${Math.round(part.positions[vertex * 3 + 1] * 1e5)},${Math.round(part.positions[vertex * 3 + 2] * 1e5)}`;
    const uses = new Map<string, { count: number; triangle: number; a: number; b: number }>();
    for (let t = 0; t < part.indices.length / 3; t++) {
        for (let k = 0; k < 3; k++) {
            const a = part.indices[t * 3 + k], b = part.indices[t * 3 + ((k + 1) % 3)];
            const ka = at(a, t), kb = at(b, t);
            if (ka === kb) continue;
            const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
            const known = uses.get(key);
            if (known) known.count++;
            else uses.set(key, { count: 1, triangle: t, a, b });
        }
    }
    const lines = new Map<number, number[]>();
    for (const edge of uses.values()) {
        if (!everyEdge && edge.count !== 1) continue;
        const tile = part.triangleTile[edge.triangle];
        const su = part.triangleShift[edge.triangle * 2], sv = part.triangleShift[edge.triangle * 2 + 1];
        let list = lines.get(tile);
        if (!list) lines.set(tile, list = []);
        list.push(part.uvs[edge.a * 2] - su, part.uvs[edge.a * 2 + 1] - sv, part.uvs[edge.b * 2] - su, part.uvs[edge.b * 2 + 1] - sv);
    }
    return new Map([...lines].map(([tile, list]) => [tile, new Float32Array(list)]));
};

export const PaintView2D: React.FC<{
    session: PaintSession;
    tool: PaintTool;
    brush: BrushSettings;
    target: StrokeTarget | null;
    /** What the picture shows: a channel, or the selected layer's mask. */
    show: PaintChannel | 'mask';
    maskImage: (tile: number) => GpuImage | null;
    onMessage: (message: string | null) => void;
}> = ({ session, tool, brush, target, show, maskImage, onMessage }) => {
    const version = useSyncExternalStore(session.subscribe, session.getVersion);
    const host = useRef<HTMLDivElement>(null);
    const picture = useRef<HTMLCanvasElement>(null);
    const overlay = useRef<HTMLCanvasElement>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [view, setView] = useState({ x: 40, y: 40, scale: 0 });
    const [tile, setTile] = useState(() => session.part.tiles[0] ?? 1001);
    const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
    const gesture = useRef<{ kind: 'pan'; x: number; y: number } | { kind: 'stroke'; stroke: Stroke } | null>(null);
    const cloneFrom = useRef<{ tile: number; u: number; v: number } | null>(null);
    const [wireframe, setWireframe] = useState(false);
    const edges = useMemo(() => layoutEdges(session.part, false), [session.part]);
    const wires = useMemo(() => (wireframe ? layoutEdges(session.part, true) : null), [session.part, wireframe]);
    const gpu = session.gpu;

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
    useEffect(() => { if (!session.part.tiles.includes(tile)) setTile(session.part.tiles[0] ?? 1001); }, [session, tile]);

    const scale = view.scale || Math.min(size.width, size.height) * 0.86;
    const toUv = useCallback((x: number, y: number): [number, number] => [(x - view.x) / scale, 1 - (y - view.y) / scale], [scale, view.x, view.y]);

    const draw = useCallback(() => {
        const element = picture.current;
        const lines = overlay.current;
        if (!element || !lines || !size.width) return;
        const ratio = window.devicePixelRatio || 1;
        element.width = lines.width = Math.round(size.width * ratio);
        element.height = lines.height = Math.round(size.height * ratio);
        const image = show === 'mask' ? maskImage(tile) : session.stack.outputs.get(tile)?.[show] ?? null;
        gpu.present(element, (width, height) => {
            gpu.drawToScreen({
                fragment: SHOW,
                inputs: { source: image ?? gpu.constant('mid') },
                uniforms: { uView: new THREE.Vector4(view.x * ratio, view.y * ratio, scale * ratio, 0), uPixels: new THREE.Vector2(width, height), uGray: image?.kind === 'gray' ? 1 : 0 },
            });
        });
        const g = lines.getContext('2d')!;
        g.setTransform(ratio, 0, 0, ratio, 0, 0);
        g.clearRect(0, 0, size.width, size.height);
        // The tile's square and its islands' edges (seams included).
        g.strokeStyle = '#3f3f46';
        g.lineWidth = 1;
        g.strokeRect(view.x, view.y, scale, scale);
        // A faint wireframe, when asked for, under the island borders.
        const wire = wires?.get(tile);
        if (wire) {
            g.strokeStyle = 'rgba(228, 228, 231, 0.18)';
            g.lineWidth = 0.5;
            g.beginPath();
            for (let i = 0; i < wire.length; i += 4) {
                g.moveTo(view.x + wire[i] * scale, view.y + (1 - wire[i + 1]) * scale);
                g.lineTo(view.x + wire[i + 2] * scale, view.y + (1 - wire[i + 3]) * scale);
            }
            g.stroke();
            g.lineWidth = 1;
        }
        const list = edges.get(tile);
        if (list) {
            g.strokeStyle = 'rgba(56, 189, 248, 0.85)';
            g.beginPath();
            for (let i = 0; i < list.length; i += 4) {
                g.moveTo(view.x + list[i] * scale, view.y + (1 - list[i + 1]) * scale);
                g.lineTo(view.x + list[i + 2] * scale, view.y + (1 - list[i + 3]) * scale);
            }
            g.stroke();
        }
        if (cursor && (tool === 'paint' || tool === 'erase')) {
            g.strokeStyle = 'rgba(255, 255, 255, 0.85)';
            g.beginPath();
            g.arc(cursor.x, cursor.y, Math.max(1, brush.size), 0, Math.PI * 2);
            g.stroke();
        }
    }, [brush.size, cursor, edges, gpu, maskImage, scale, session, show, size, tile, tool, view, wires]);

    useEffect(() => { draw(); }, [draw, version]);

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

    const local = (event: { clientX: number; clientY: number }) => {
        const box = host.current!.getBoundingClientRect();
        return { x: event.clientX - box.left, y: event.clientY - box.top };
    };

    /** The triangle of the shown tile under a place on its UVs, or -1. */
    const triangleAt = (u: number, v: number): number => {
        const part = session.part;
        for (let t = 0; t < part.indices.length / 3; t++) {
            if (part.triangleTile[t] !== tile) continue;
            const su = part.triangleShift[t * 2], sv = part.triangleShift[t * 2 + 1];
            const [a, b, c] = [0, 1, 2].map((k) => part.indices[t * 3 + k]);
            const ax = part.uvs[a * 2] - su, ay = part.uvs[a * 2 + 1] - sv;
            const bx = part.uvs[b * 2] - su, by = part.uvs[b * 2 + 1] - sv;
            const cx = part.uvs[c * 2] - su, cy = part.uvs[c * 2 + 1] - sv;
            const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
            if (Math.abs(d) < 1e-14) continue;
            const l1 = ((by - cy) * (u - cx) + (cx - bx) * (v - cy)) / d;
            const l2 = ((cy - ay) * (u - cx) + (ax - cx) * (v - cy)) / d;
            if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) return t;
        }
        return -1;
    };

    const startStroke = (x: number, y: number, pressure: number) => {
        if (!session.usable) { onMessage('The graphics card was reset: painting waits until the set has opened again from its saved pictures.'); return; }
        if (session.locked) { onMessage(session.locked); return; }
        if (!target) { onMessage('Pick a paint layer, or a painted mask effect, to paint on.'); return; }
        if (brush.mode === 'clone' && !cloneFrom.current && tool !== 'island') { onMessage('Ctrl-click where to copy from first, then paint where the copy goes.'); return; }
        onMessage(null);
        const alpha = brush.shape === 'picture' && brush.alphaTexture ? builtInAlphaTexture(brush.alphaTexture) ?? session.host.texture(brush.alphaTexture) : null;
        // The stencil lies over this view as it does over the 3D one.
        const stencil = brush.stencil.enabled && brush.stencil.textureId ? session.host.texture(brush.stencil.textureId) : null;
        const stroke = new Stroke(session.stack, target, tool === 'erase' ? 'erase' : 'paint', brush, {
            viewProjection: new THREE.Matrix4(),
            cameraPosition: new THREE.Vector3(),
            width: size.width,
            height: size.height,
            depth: null,
            perspective: 1,
            uvView: { tile, toUv, pixelsPerUv: scale },
        }, alpha, stencil);
        if (tool === 'island') {
            const triangle = triangleAt(...toUv(x, y));
            if (triangle >= 0) stroke.fillIsland(session.part.triangleIsland[triangle]);
            const entry = stroke.finish('Fill island');
            if (triangle >= 0) session.record(entry);
            return;
        }
        if (brush.mode === 'clone' && cloneFrom.current) stroke.cloneSourceAt(cloneFrom.current.tile, cloneFrom.current.u, cloneFrom.current.v);
        gesture.current = { kind: 'stroke', stroke };
        stroke.moveTo(x, y, pressure, () => null);
    };

    const stencilTexture = brush.stencil.enabled && brush.stencil.textureId && (tool === 'paint' || tool === 'erase') ? session.host.texture(brush.stencil.textureId) : null;

    return (
        <div ref={host} className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
            style={{ cursor: tool === 'paint' || tool === 'erase' ? 'none' : 'crosshair' }}
            onPointerDown={(event) => {
                try { host.current?.setPointerCapture(event.pointerId); } catch { /* a pointer the page did not see start */ }
                const { x, y } = local(event);
                if (event.button === 1 || event.button === 2) { gesture.current = { kind: 'pan', x: event.clientX, y: event.clientY }; return; }
                if (event.button !== 0) return;
                if (brush.mode === 'clone' && (event.ctrlKey || event.metaKey)) {
                    const [u, v] = toUv(x, y);
                    cloneFrom.current = { tile, u, v };
                    onMessage('Copying from there: paint where the copy goes.');
                    return;
                }
                if (tool === 'paint' || tool === 'erase' || tool === 'island') startStroke(x, y, event.pointerType === 'pen' ? event.pressure : 1);
                else onMessage('Paint, erase or fill an island here; the other tools work in the 3D view.');
            }}
            onPointerMove={(event) => {
                const point = local(event);
                setCursor(point);
                const current = gesture.current;
                if (!current) return;
                if (current.kind === 'pan') {
                    const dx = event.clientX - current.x, dy = event.clientY - current.y;
                    current.x = event.clientX;
                    current.y = event.clientY;
                    setView((value) => ({ scale: value.scale || scale, x: value.x + dx, y: value.y + dy }));
                    return;
                }
                const coalesced = (event.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [];
                for (const each of coalesced.length ? coalesced : [event.nativeEvent]) {
                    const at = local(each);
                    current.stroke.moveTo(at.x, at.y, each.pointerType === 'pen' ? each.pressure : 1, () => null);
                }
            }}
            onPointerUp={() => {
                const current = gesture.current;
                gesture.current = null;
                if (current?.kind === 'stroke') session.record(current.stroke.finish(tool === 'erase' ? 'Erase' : 'Paint'));
            }}
            onPointerLeave={() => setCursor(null)}
            onContextMenu={(event) => event.preventDefault()}
        >
            <canvas ref={picture} className="absolute inset-0 h-full w-full" />
            <canvas ref={overlay} className="pointer-events-none absolute inset-0 h-full w-full" />
            {stencilTexture && <StencilOverlay texture={stencilTexture} place={stencilPlace(brush.stencil, pictureAspect(stencilTexture), size.width, size.height)} />}
            <div className="absolute right-3 top-3 flex items-center gap-2" onPointerDown={(event) => event.stopPropagation()}>
                <label className="flex items-center gap-1.5 rounded bg-zinc-900/90 px-2 py-1 text-2xs text-zinc-300">
                    <input type="checkbox" className="accent-sky-500" checked={wireframe} onChange={(event) => setWireframe(event.target.checked)} />
                    Wireframe
                </label>
                {session.part.tiles.length > 1 && (
                    <div className="w-28">
                        <Select value={tile} options={session.part.tiles.map((each) => ({ value: each, label: `Tile ${each}` }))} onChange={(value) => setTile(Number(value))} className="w-full" />
                    </div>
                )}
            </div>
            <div className="pointer-events-none absolute bottom-3 left-3 rounded bg-zinc-900/90 px-2 py-1 text-2xs text-zinc-400">
                Painting on the UV layout: strokes stay on the islands (edges in blue), and symmetry copies land where they would on the model. Middle or right drag pans; the wheel zooms.
            </div>
        </div>
    );
};
