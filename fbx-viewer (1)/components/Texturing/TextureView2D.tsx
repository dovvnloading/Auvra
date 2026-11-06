import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { FrameIcon, TilesIcon } from '../UI/Icons';
import type { GpuImage } from '../../texturing/gpu/textureGpu';
import { IconButton, Segmented } from '../UI/kit';
import type { TextureGraphSession } from './textureGraphSession';

/**
 * The 2D view: one node's image, zoomed and panned with the wheel and a drag, shown once or
 * repeated to check it tiles, as all channels or one at a time. Pixel values show under the pointer.
 */

type Channel = 'rgb' | 'r' | 'g' | 'b' | 'a';
const CHANNELS: ReadonlyArray<{ value: Channel; label: string }> = [
    { value: 'rgb', label: 'RGB' }, { value: 'r', label: 'R' }, { value: 'g', label: 'G' }, { value: 'b', label: 'B' }, { value: 'a', label: 'A' },
];

const FRAGMENT = `uniform vec2 uOffset;
uniform vec2 uPan;
uniform float uZoom;
uniform vec2 uImage;
uniform int uTile;
uniform int uChannel;
uniform int uGray;
void main() {
    vec2 local = gl_FragCoord.xy - uOffset;
    vec2 uv = (local - uSize * 0.5 - uPan) / (uZoom * uImage) + 0.5;
    vec2 cell = floor(local / 10.0);
    vec3 back = mix(vec3(0.11), vec3(0.15), mod(cell.x + cell.y, 2.0));
    bool inside = uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0;
    if (uTile == 0 && !inside) { outColor = vec4(0.07, 0.07, 0.08, 1.0); return; }
    if (uTile == 1 && (uv.x < -1.0 || uv.y < -1.0 || uv.x > 2.0 || uv.y > 2.0)) { outColor = vec4(0.07, 0.07, 0.08, 1.0); return; }
    vec4 v = texture(source, fract(uv));
    if (uGray == 1) v = vec4(v.rrr, 1.0);
    vec3 c;
    if (uChannel == 1) c = vec3(v.r);
    else if (uChannel == 2) c = vec3(v.g);
    else if (uChannel == 3) c = vec3(v.b);
    else if (uChannel == 4) c = vec3(v.a);
    else c = mix(back, v.rgb, clamp(v.a, 0.0, 1.0));
    // A faint line where the repeats meet.
    if (uTile == 1) {
        vec2 edge = abs(fract(uv + 0.5) - 0.5) * uZoom * uImage;
        if (min(edge.x, edge.y) < 0.5) c = mix(c, vec3(0.5, 0.7, 1.0), 0.25);
    }
    outColor = vec4(c, 1.0);
}`;

export const TextureView2D: React.FC<{ session: TextureGraphSession; nodeId: string | null; output?: string; label: string }> = ({ session, nodeId, output, label }) => {
    const host = useRef<HTMLDivElement>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const version = useSyncExternalStore(session.subscribe, session.getVersion);
    const [channel, setChannel] = useState<Channel>('rgb');
    const [tile, setTile] = useState(false);
    const [view, setView] = useState({ panX: 0, panY: 0, zoom: 0 });
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [probe, setProbe] = useState<string | null>(null);
    const drag = useRef<{ x: number; y: number } | null>(null);

    const image: GpuImage | null = nodeId ? session.imageOf(nodeId, output) : null;
    const state = nodeId ? session.state(nodeId) : undefined;

    useEffect(() => {
        const element = host.current;
        if (!element) return undefined;
        const observer = new ResizeObserver(() => {
            const box = element.getBoundingClientRect();
            const ratio = window.devicePixelRatio || 1;
            setSize({ width: Math.max(1, Math.floor(box.width * ratio)), height: Math.max(1, Math.floor(box.height * ratio)) });
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    /** Zoom that fits the image (0 in state means fit). */
    const zoom = useCallback(() => {
        if (view.zoom > 0) return view.zoom;
        if (!image || !size.width) return 1;
        const repeats = tile ? 3 : 1;
        return Math.min(size.width / (image.width * repeats), size.height / (image.height * repeats)) * 0.94;
    }, [image, size, tile, view.zoom]);

    useEffect(() => {
        const element = canvas.current;
        if (!element || !size.width) return;
        element.width = size.width;
        element.height = size.height;
        const gpu = session.gpu;
        gpu.present(element, (width, height) => {
            if (!image) return;
            gpu.drawToScreen({
                fragment: FRAGMENT,
                inputs: { source: image },
                uniforms: {
                    uOffset: new THREE.Vector2(0, gpu.canvas.height - height),
                    uPan: new THREE.Vector2(view.panX, view.panY),
                    uZoom: zoom(),
                    uImage: new THREE.Vector2(image.width, image.height),
                    uTile: tile ? 1 : 0,
                    uChannel: CHANNELS.findIndex((item) => item.value === channel),
                    uGray: image.kind === 'gray' ? 1 : 0,
                },
            });
            void width;
        });
    }, [channel, image, session, size, tile, version, view, zoom]);

    useEffect(() => {
        const element = host.current;
        if (!element) return undefined;
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            const box = element.getBoundingClientRect();
            const ratio = window.devicePixelRatio || 1;
            const mx = (event.clientX - box.left) * ratio - size.width / 2;
            const my = (box.bottom - event.clientY) * ratio - size.height / 2;
            setView((current) => {
                const before = current.zoom > 0 ? current.zoom : zoom();
                const after = Math.min(64, Math.max(0.02, before * Math.exp(-event.deltaY * 0.0015)));
                return { zoom: after, panX: mx - (mx - current.panX) * (after / before), panY: my - (my - current.panY) * (after / before) };
            });
        };
        element.addEventListener('wheel', onWheel, { passive: false });
        return () => element.removeEventListener('wheel', onWheel);
    }, [size, zoom]);

    const readPixel = (clientX: number, clientY: number) => {
        const element = host.current;
        if (!element || !image) { setProbe(null); return; }
        const box = element.getBoundingClientRect();
        const ratio = window.devicePixelRatio || 1;
        const lx = (clientX - box.left) * ratio;
        const ly = (box.bottom - clientY) * ratio;
        const u = (lx - size.width / 2 - view.panX) / (zoom() * image.width) + 0.5;
        const v = (ly - size.height / 2 - view.panY) / (zoom() * image.height) + 0.5;
        const px = Math.floor((((u % 1) + 1) % 1) * image.width);
        const py = Math.floor((((v % 1) + 1) % 1) * image.height);
        if (!tile && (u < 0 || v < 0 || u > 1 || v > 1)) { setProbe(null); return; }
        setProbe(`${px}, ${image.height - 1 - py}`);
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-1 border-b border-zinc-800 px-2 py-1">
                <span className="min-w-0 flex-1 truncate text-2xs font-semibold text-zinc-300">{label}</span>
                <Segmented value={channel} options={CHANNELS} onChange={setChannel} label="Channel shown" />
                <IconButton label={tile ? 'Show once' : 'Show repeated, to check it tiles'} active={tile} onClick={() => setTile((value) => !value)}><TilesIcon size={13} /></IconButton>
                <IconButton label="Fit" onClick={() => setView({ panX: 0, panY: 0, zoom: 0 })}><FrameIcon size={13} /></IconButton>
            </div>
            <div
                ref={host}
                className="relative min-h-0 flex-1 cursor-grab"
                onPointerDown={(event) => { drag.current = { x: event.clientX, y: event.clientY }; (event.target as HTMLElement).setPointerCapture(event.pointerId); }}
                onPointerMove={(event) => {
                    readPixel(event.clientX, event.clientY);
                    if (!drag.current) return;
                    const ratio = window.devicePixelRatio || 1;
                    const dx = (event.clientX - drag.current.x) * ratio;
                    const dy = (event.clientY - drag.current.y) * ratio;
                    drag.current = { x: event.clientX, y: event.clientY };
                    setView((current) => ({ zoom: current.zoom > 0 ? current.zoom : zoom(), panX: current.panX + dx, panY: current.panY - dy }));
                }}
                onPointerUp={() => { drag.current = null; }}
                onPointerLeave={() => setProbe(null)}
            >
                <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
                {!image && <div className="absolute inset-0 flex items-center justify-center text-2xs text-zinc-500">{nodeId ? (state?.error ?? 'Drawing…') : 'Double-click a node to look at it here.'}</div>}
            </div>
            <div className="flex items-center gap-3 border-t border-zinc-800 px-2 py-1 text-2xs text-zinc-500">
                {image ? <span>{image.width} × {image.height} · {image.kind === 'color' ? 'colour' : 'grey'} · {image.precision}-bit</span> : <span>—</span>}
                {state && <span>{state.milliseconds < 1 ? '<1' : Math.round(state.milliseconds)} ms</span>}
                <span className="flex-1" />
                {probe && <span className="font-mono">{probe}</span>}
            </div>
        </div>
    );
};
