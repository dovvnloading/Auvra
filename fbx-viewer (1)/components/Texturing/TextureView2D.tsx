import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { CompareIcon, CrossIcon, FrameIcon, PinIcon, PulseIcon, SunIcon, TilesIcon } from '../UI/Icons';
import type { GpuImage } from '../../texturing/gpu/textureGpu';
import { hash2 } from '../../texturing/graph/scatter';
import { isParamLink, type TexGraphNode } from '../../texturing/graph/types';
import { IconButton, Segmented } from '../UI/kit';
import { finishPicking, stopsFrom, usePicking, type Rgba } from './eyedropper';
import type { TextureGraphSession } from './textureGraphSession';
import {
    dragGradient, dragShape, dragTile, dragTransform, gradientFrame, rangeShare, shapeFrame, tileFrame, transformFrame, uvToView, viewToUv,
    type HandleFrame, type Histogram, type UV, type Vec2, type ViewPlacement,
} from './view2d';

/**
 * The 2D view: one node's image, zoomed and panned with the wheel and a drag, shown once or repeated
 * to check it tiles, as all channels or one at a time, brighter or darker by its exposure, or lit as
 * a normal map. The pixel under the pointer shows with its values; colour pins keep showing theirs.
 * The histogram picks out a range of values in the image; holding a node as A compares it with the
 * one shown, either side of a wipe. Transform, Tile sampler, Linear gradient and Shape nodes get
 * handles to drag on the image. A setting's eyedropper picks a colour here with a click, or a
 * gradient along a dragged line.
 */

type Channel = 'rgb' | 'r' | 'g' | 'b' | 'a';
const CHANNELS: ReadonlyArray<{ value: Channel; label: string }> = [
    { value: 'rgb', label: 'RGB' }, { value: 'r', label: 'R' }, { value: 'g', label: 'G' }, { value: 'b', label: 'B' }, { value: 'a', label: 'A' },
];
const MAX_PINS = 8;
const GRADIENT_SAMPLES = 8;

const FRAGMENT = `uniform vec2 uOffset;
uniform vec2 uPan;
uniform float uZoom;
uniform vec2 uImage;
uniform int uTile;
uniform int uChannel;
uniform int uGray;
uniform int uOtherGray;
uniform int uCompare;
uniform float uWipe;
uniform float uExposure;
uniform int uLit;
uniform vec3 uLight;
uniform int uRangeOn;
uniform vec2 uRange;
void main() {
    vec2 local = gl_FragCoord.xy - uOffset;
    vec2 uv = (local - uSize * 0.5 - uPan) / (uZoom * uImage) + 0.5;
    vec2 cell = floor(local / 10.0);
    vec3 back = mix(vec3(0.11), vec3(0.15), mod(cell.x + cell.y, 2.0));
    bool inside = uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0;
    if (uTile == 0 && !inside) { outColor = vec4(0.07, 0.07, 0.08, 1.0); return; }
    if (uTile == 1 && (uv.x < -1.0 || uv.y < -1.0 || uv.x > 2.0 || uv.y > 2.0)) { outColor = vec4(0.07, 0.07, 0.08, 1.0); return; }
    bool useOther = uCompare == 1 && local.x < uWipe * uSize.x;
    vec4 v = useOther ? texture(other, fract(uv)) : texture(source, fract(uv));
    if ((useOther ? uOtherGray : uGray) == 1) v = vec4(v.rrr, 1.0);
    vec3 c;
    if (uLit == 1) {
        // A normal map lit from the pointer's side.
        vec3 n = normalize(v.rgb * 2.0 - 1.0);
        float d = max(dot(n, normalize(uLight)), 0.0);
        c = vec3(0.08 + 0.86 * d);
    }
    else if (uChannel == 1) c = vec3(v.r);
    else if (uChannel == 2) c = vec3(v.g);
    else if (uChannel == 3) c = vec3(v.b);
    else if (uChannel == 4) c = vec3(v.a);
    else c = mix(back, v.rgb * exp2(uExposure), clamp(v.a, 0.0, 1.0));
    if (uChannel >= 1 && uChannel <= 3 && uLit == 0) c *= exp2(uExposure);
    if (uRangeOn == 1) {
        float value = uChannel == 1 ? v.r : uChannel == 2 ? v.g : uChannel == 3 ? v.b : uChannel == 4 ? v.a : luma(v.rgb);
        if (value < uRange.x || value > uRange.y) c = mix(c, vec3(0.03), 0.82);
    }
    // A faint line where the repeats meet.
    if (uTile == 1) {
        vec2 edge = abs(fract(uv + 0.5) - 0.5) * uZoom * uImage;
        if (min(edge.x, edge.y) < 0.5) c = mix(c, vec3(0.5, 0.7, 1.0), 0.25);
    }
    if (uCompare == 1 && abs(local.x - uWipe * uSize.x) < 1.0) c = vec3(0.94, 0.54, 0.24);
    outColor = vec4(c, 1.0);
}`;

const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const pair = (value: unknown, fallback: Vec2): Vec2 => (Array.isArray(value) ? [num(value[0], fallback[0]), num(value[1], fallback[1])] : fallback);

interface Handles {
    frame: HandleFrame;
    /** The settings a handle dragged to `to` gives (`uniform`: keep proportions). */
    drag: (key: string, to: Vec2, uniform: boolean) => Record<string, unknown>;
    /** True for a handle whose setting follows a graph parameter (it cannot be dragged). */
    locked: (key: string) => boolean;
}

/** The handles a node gets on the image, from its settings (and the seed it drew with, for a Tile sampler's random shifts). */
const handlesFor = (node: TexGraphNode | null | undefined, seed: number | undefined): Handles | null => {
    if (!node || node.bypass) return null;
    const p = node.params;
    const locked = (key: string) => isParamLink(p[key]);
    switch (node.type) {
        case 'transform': {
            const settings = { offset: pair(p.offset, [0, 0]), rotation: num(p.rotation, 0), scale: pair(p.scale, [1, 1]) };
            return { frame: transformFrame(settings), drag: (key, to, uniform) => ({ ...dragTransform(settings, key, to, uniform) }), locked };
        }
        case 'shape': {
            const settings = { centre: pair(p.centre, [0.5, 0.5]), size: num(p.size, 0.8), stretch: pair(p.stretch, [1, 1]), rotation: num(p.rotation, 0), tiling: num(p.tiling, 1) };
            return { frame: shapeFrame(settings), drag: (key, to) => ({ ...dragShape(settings, key, to) }), locked };
        }
        case 'gradient':
            return { frame: gradientFrame(num(p.angle, 0)), drag: (key, to) => ({ ...dragGradient(key, to) }), locked: () => isParamLink(p.angle) };
        case 'tileSampler': {
            const randomness = num(p.positionRandom, 0.3);
            // Each copy's random shift, as the node's shader works it out: hash2(cell, seed + 1) a cell.
            const jitterAt = seed === undefined || isParamLink(p.positionRandom) ? undefined : (cell: Vec2): Vec2 => {
                const random = hash2(cell[0], cell[1], Math.fround(seed + 1));
                return [(random[0] - 0.5) * randomness, (random[1] - 0.5) * randomness];
            };
            const settings = { columns: num(p.columns, 8), rows: num(p.rows, 8), size: num(p.size, 0.8), stretch: pair(p.stretch, [1, 1]), rotation: num(p.rotation, 0), offset: num(p.offset, 0), jitterAt };
            return { frame: tileFrame(settings), drag: (key, to) => ({ ...dragTile(settings, key, to) }), locked };
        }
        default:
            return null;
    }
};

const HANDLE_WORDS: Record<string, string> = {
    offset: 'Drag to move', centre: 'Drag to move', rotation: 'Drag to turn', scale: 'Drag to scale (Shift keeps proportions)', size: 'Drag to size',
    start: 'Drag to turn the gradient (black end)', end: 'Drag to turn the gradient (white end)',
};

interface ColourPin { id: number; u: number; v: number }

const formatValues = (values: readonly number[] | null | undefined): string => {
    if (!values) return '…';
    if (values.length === 1) return values[0].toFixed(3);
    return `${values[0].toFixed(2)} ${values[1].toFixed(2)} ${values[2].toFixed(2)}${values[3] < 0.999 ? ` α${values[3].toFixed(2)}` : ''}`;
};
const swatchOf = (values: readonly number[]): string => {
    const byte = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255);
    return values.length === 1 ? `rgb(${byte(values[0])}, ${byte(values[0])}, ${byte(values[0])})` : `rgb(${byte(values[0])}, ${byte(values[1])}, ${byte(values[2])})`;
};

export const TextureView2D: React.FC<{
    session: TextureGraphSession;
    nodeId: string | null;
    output?: string;
    label: string;
    /** The node shown, for its handles. */
    node?: TexGraphNode | null;
    /** Changes the shown node's settings (its handles dragged); `key` names the handle, for one undo step a drag. */
    onParams?: (nodeId: string, patch: Record<string, unknown>, key: string) => void;
}> = ({ session, nodeId, output, label, node, onParams }) => {
    const host = useRef<HTMLDivElement>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const histogramCanvas = useRef<HTMLCanvasElement>(null);
    const version = useSyncExternalStore(session.subscribe, session.getVersion);
    const picking = usePicking();
    const [channel, setChannel] = useState<Channel>('rgb');
    const [tile, setTile] = useState(false);
    const [view, setView] = useState({ panX: 0, panY: 0, zoom: 0 });
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [exposure, setExposure] = useState(0);
    const [lit, setLit] = useState(false);
    const [light, setLight] = useState<[number, number]>([-0.45, 0.55]);
    const [showHistogram, setShowHistogram] = useState(false);
    const [histogram, setHistogram] = useState<Histogram | null>(null);
    const [range, setRange] = useState<[number, number] | null>(null);
    const [pinning, setPinning] = useState(false);
    const [pins, setPins] = useState<ColourPin[]>([]);
    const [pinValues, setPinValues] = useState<ReadonlyMap<number, number[] | null>>(new Map());
    const [compare, setCompare] = useState<{ nodeId: string; output?: string; label: string } | null>(null);
    const [wipe, setWipe] = useState(0.5);
    const [line, setLine] = useState<{ from: UV; to: UV } | null>(null);
    /** The pixel under the pointer (counted from the top left) and its values once read. */
    const [probe, setProbe] = useState<{ x: number; y: number; values: number[] | null } | null>(null);
    const drag = useRef<{ x: number; y: number; startX: number; startY: number; moved: boolean; line: boolean } | null>(null);
    const handleDrag = useRef<string | null>(null);
    /** The pixel to read (from the bottom left, as the GPU counts) and whether a read is on its way. */
    const wanted = useRef<{ image: GpuImage; x: number; y: number } | null>(null);
    const reading = useRef(false);
    const nextPin = useRef(1);

    const image: GpuImage | null = nodeId ? session.imageOf(nodeId, output) : null;
    const state = nodeId ? session.state(nodeId) : undefined;
    const other: GpuImage | null = compare && compare.nodeId !== nodeId ? session.imageOf(compare.nodeId, compare.output) : null;
    const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;

    // One read at a time: when it lands, the pointer's newest pixel is read next if it moved meanwhile.
    const readNext = useCallback(() => {
        const want = wanted.current;
        if (reading.current || !want) return;
        reading.current = true;
        const { image: source, x, y } = want;
        void session.gpu.readPixelLater(source, x, y).then((values) => {
            reading.current = false;
            const now = wanted.current;
            if (!now) return;
            if (now.image === source && now.x === x && now.y === y) {
                if (values) setProbe({ x, y: source.height - 1 - y, values: source.kind === 'gray' ? [values[0]] : [...values] });
            } else readNext();
        });
    }, [session]);

    // The image drawn again (an edit) under a still pointer: its values are read again.
    useEffect(() => {
        if (!wanted.current) return;
        if (!image) { wanted.current = null; setProbe(null); return; }
        wanted.current = { ...wanted.current, image };
        readNext();
    }, [image, readNext, version]);

    useEffect(() => {
        const element = host.current;
        if (!element) return undefined;
        const observer = new ResizeObserver(() => {
            const box = element.getBoundingClientRect();
            setSize({ width: Math.max(1, Math.floor(box.width * ratio)), height: Math.max(1, Math.floor(box.height * ratio)) });
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, [ratio]);

    /** Zoom that fits the image (0 in state means fit). */
    const zoom = useCallback(() => {
        if (view.zoom > 0) return view.zoom;
        if (!image || !size.width) return 1;
        const repeats = tile ? 3 : 1;
        return Math.min(size.width / (image.width * repeats), size.height / (image.height * repeats)) * 0.94;
    }, [image, size, tile, view.zoom]);

    const placement = useMemo<ViewPlacement | null>(() => (image && size.width
        ? { width: size.width, height: size.height, ratio, panX: view.panX, panY: view.panY, zoom: zoom(), imageWidth: image.width, imageHeight: image.height }
        : null), [image, ratio, size, view, zoom]);

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
                inputs: { source: image, other: other ?? image },
                uniforms: {
                    uOffset: new THREE.Vector2(0, gpu.canvas.height - height),
                    uPan: new THREE.Vector2(view.panX, view.panY),
                    uZoom: zoom(),
                    uImage: new THREE.Vector2(image.width, image.height),
                    uTile: tile ? 1 : 0,
                    uChannel: CHANNELS.findIndex((item) => item.value === channel),
                    uGray: image.kind === 'gray' ? 1 : 0,
                    uOtherGray: other?.kind === 'gray' ? 1 : 0,
                    uCompare: other ? 1 : 0,
                    uWipe: wipe,
                    uExposure: exposure,
                    uLit: lit && image.kind === 'color' ? 1 : 0,
                    uLight: new THREE.Vector3(light[0], light[1], 0.75),
                    uRangeOn: range ? 1 : 0,
                    uRange: new THREE.Vector2(range ? Math.min(...range) : 0, range ? Math.max(...range) : 1),
                },
            });
            void width;
        });
    }, [channel, exposure, image, light, lit, other, range, session, size, tile, version, view, wipe, zoom]);

    useEffect(() => {
        const element = host.current;
        if (!element) return undefined;
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            const box = element.getBoundingClientRect();
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
    }, [ratio, size, zoom]);

    // ---- histogram ----
    useEffect(() => {
        if (!showHistogram || !image) { setHistogram(null); return undefined; }
        let cancelled = false;
        void session.histogram(image).then((made) => { if (!cancelled && made) setHistogram(made); });
        return () => { cancelled = true; };
    }, [image, session, showHistogram, version]);

    const bins = histogram ? (channel === 'r' ? histogram.red : channel === 'g' ? histogram.green : channel === 'b' ? histogram.blue : histogram.luma) : null;

    useEffect(() => {
        const element = histogramCanvas.current;
        const context = element?.getContext('2d');
        if (!element || !context) return;
        const width = element.clientWidth * ratio;
        const height = element.clientHeight * ratio;
        element.width = width;
        element.height = height;
        context.clearRect(0, 0, width, height);
        if (!histogram || !bins) return;
        const peak = Math.max(1, ...bins);
        const draw = (values: readonly number[], colour: string) => {
            context.fillStyle = colour;
            values.forEach((count, index) => {
                const barHeight = (Math.sqrt(count / peak) * (height - 2));
                context.fillRect((index / values.length) * width, height - barHeight, width / values.length + 0.5, barHeight);
            });
        };
        if (channel === 'rgb' && image?.kind === 'color') {
            draw(histogram.red, 'rgba(239, 68, 68, 0.35)');
            draw(histogram.green, 'rgba(34, 197, 94, 0.35)');
            draw(histogram.blue, 'rgba(59, 130, 246, 0.35)');
        }
        draw(bins, 'rgba(226, 227, 229, 0.75)');
        if (range) {
            const from = Math.min(...range) * width;
            const to = Math.max(...range) * width;
            context.fillStyle = 'rgba(240, 138, 60, 0.22)';
            context.fillRect(from, 0, Math.max(1, to - from), height);
            context.fillStyle = 'rgba(240, 138, 60, 0.9)';
            context.fillRect(from, 0, 1, height);
            context.fillRect(to - 1, 0, 1, height);
        }
    }, [bins, channel, histogram, image, range, ratio]);

    const rangeDrag = useRef<number | null>(null);
    const rangeAt = (clientX: number): number => {
        const box = histogramCanvas.current!.getBoundingClientRect();
        return Math.min(1, Math.max(0, (clientX - box.left) / Math.max(1, box.width)));
    };

    // ---- colour pins: each keeps showing the value of its pixel, read again when the image changes ----
    const pinsKey = pins.map((pin) => `${pin.id}:${pin.u}:${pin.v}`).join('|');
    useEffect(() => {
        if (!image || !pins.length) return undefined;
        let cancelled = false;
        void (async () => {
            const values = new Map<number, number[] | null>();
            for (const pin of pins) {
                const x = Math.min(image.width - 1, Math.max(0, Math.floor(pin.u * image.width)));
                const y = Math.min(image.height - 1, Math.max(0, Math.floor(pin.v * image.height)));
                const read = await session.gpu.readPixelLater(image, x, y);
                if (cancelled) return;
                values.set(pin.id, read ? (image.kind === 'gray' ? [read[0]] : [...read]) : null);
            }
            setPinValues(values);
        })();
        return () => { cancelled = true; };
        // The pins' places (pinsKey) and the image say what to read; the pins array itself is read inside.
    }, [image, pinsKey, session, version]);

    // ---- pointer ----
    const uvAt = (clientX: number, clientY: number): UV | null => {
        const element = host.current;
        if (!element || !placement) return null;
        const box = element.getBoundingClientRect();
        return viewToUv({ x: clientX - box.left, y: clientY - box.top }, placement);
    };

    const readPixel = (clientX: number, clientY: number) => {
        const leave = () => { wanted.current = null; setProbe(null); };
        const uv = uvAt(clientX, clientY);
        if (!uv || !image) { leave(); return; }
        const { u, v } = uv;
        if (!tile && (u < 0 || v < 0 || u > 1 || v > 1)) { leave(); return; }
        if (tile && (u < -1 || v < -1 || u > 2 || v > 2)) { leave(); return; }
        const px = Math.min(image.width - 1, Math.floor((((u % 1) + 1) % 1) * image.width));
        const py = Math.min(image.height - 1, Math.floor((((v % 1) + 1) % 1) * image.height));
        const before = wanted.current;
        if (before && before.image === image && before.x === px && before.y === py) return;
        wanted.current = { image, x: px, y: py };
        // The place shows at once; its values follow when the read lands (a frame or so).
        setProbe((current) => ({ x: px, y: image.height - 1 - py, values: current?.values ?? null }));
        readNext();
    };

    /** Reads the colour at an image point, as RGBA (a grey image's value in every colour). */
    const colourAt = async (uv: UV): Promise<Rgba | null> => {
        if (!image) return null;
        const x = Math.min(image.width - 1, Math.max(0, Math.floor((((uv.u % 1) + 1) % 1) * image.width)));
        const y = Math.min(image.height - 1, Math.max(0, Math.floor((((uv.v % 1) + 1) % 1) * image.height)));
        const read = await session.gpu.readPixelLater(image, x, y);
        if (!read) return null;
        return image.kind === 'gray' ? [read[0], read[0], read[0], 1] : [read[0], read[1], read[2], read[3]];
    };

    const sampleLine = async (from: UV, to: UV) => {
        const colours: Rgba[] = [];
        for (let i = 0; i < GRADIENT_SAMPLES; i++) {
            const t = i / (GRADIENT_SAMPLES - 1);
            const colour = await colourAt({ u: from.u + (to.u - from.u) * t, v: from.v + (to.v - from.v) * t });
            if (colour) colours.push(colour);
        }
        if (colours.length) finishPicking(stopsFrom(colours));
    };

    const onPointerDown = (event: React.PointerEvent) => {
        if (event.button !== 0 && event.button !== 1) return;
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        const gradientPick = picking?.kind === 'gradient' && event.button === 0;
        drag.current = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false, line: gradientPick };
        if (gradientPick) {
            const uv = uvAt(event.clientX, event.clientY);
            if (uv) setLine({ from: uv, to: uv });
        }
    };

    const onPointerMove = (event: React.PointerEvent) => {
        readPixel(event.clientX, event.clientY);
        if (lit && host.current) {
            const box = host.current.getBoundingClientRect();
            setLight([((event.clientX - box.left) / box.width) * 2 - 1, 1 - ((event.clientY - box.top) / box.height) * 2]);
        }
        const current = drag.current;
        if (!current) return;
        if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 3) current.moved = true;
        if (current.line) {
            const uv = uvAt(event.clientX, event.clientY);
            if (uv) setLine((value) => (value ? { ...value, to: uv } : value));
            return;
        }
        const dx = (event.clientX - current.x) * ratio;
        const dy = (event.clientY - current.y) * ratio;
        current.x = event.clientX;
        current.y = event.clientY;
        setView((value) => ({ zoom: value.zoom > 0 ? value.zoom : zoom(), panX: value.panX + dx, panY: value.panY - dy }));
    };

    const onPointerUp = (event: React.PointerEvent) => {
        const current = drag.current;
        drag.current = null;
        if (!current) return;
        if (current.line) {
            const from = line?.from;
            const to = uvAt(event.clientX, event.clientY);
            setLine(null);
            if (from && to && current.moved) void sampleLine(from, to);
            return;
        }
        if (current.moved) return;
        const uv = uvAt(event.clientX, event.clientY);
        if (!uv || !image) return;
        if (picking?.kind === 'colour') {
            void colourAt(uv).then((colour) => { if (colour) finishPicking(colour); });
            return;
        }
        if (pinning && uv.u >= 0 && uv.v >= 0 && uv.u <= 1 && uv.v <= 1) {
            setPins((list) => [...list, { id: nextPin.current++, u: uv.u, v: uv.v }].slice(-MAX_PINS));
        }
    };

    const probeText = (() => {
        if (!probe) return null;
        const values = probe.values;
        const place = `${probe.x}, ${probe.y}`;
        if (!values) return place;
        if (values.length === 1) return `${place}   ${values[0].toFixed(3)}`;
        return `${place}   R ${values[0].toFixed(3)}  G ${values[1].toFixed(3)}  B ${values[2].toFixed(3)}  A ${values[3].toFixed(3)}`;
    })();

    const handles = onParams ? handlesFor(node, node ? session.state(node.id)?.seed : undefined) : null;
    const toView = (point: Vec2) => (placement ? uvToView({ u: point[0], v: point[1] }, placement) : { x: 0, y: 0 });
    const onHandleDown = (event: React.PointerEvent, key: string) => {
        event.stopPropagation();
        (event.currentTarget as Element).setPointerCapture(event.pointerId);
        handleDrag.current = key;
    };
    const onHandleMove = (event: React.PointerEvent) => {
        const key = handleDrag.current;
        if (!key || !handles || !node || !onParams) return;
        event.stopPropagation();
        const uv = uvAt(event.clientX, event.clientY);
        if (uv) onParams(node.id, handles.drag(key, [uv.u, uv.v], event.shiftKey), key);
    };

    const share = bins && range ? rangeShare(bins, range[0], range[1]) : null;
    const cursor = picking ? 'cursor-crosshair' : pinning ? 'cursor-copy' : 'cursor-grab';

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-1 border-b border-line px-2 py-1">
                <span className="min-w-0 flex-1 truncate text-2xs font-semibold text-ink-2">{label}</span>
                <Segmented value={channel} options={CHANNELS} onChange={setChannel} label="Channel shown" />
            </div>
            <div className="flex items-center gap-0.5 border-b border-line px-1.5 py-0.5">
                <IconButton label={tile ? 'Show once' : 'Show repeated, to check it tiles'} active={tile} onClick={() => setTile((value) => !value)}><TilesIcon size={13} /></IconButton>
                <IconButton label="Fit" onClick={() => setView({ panX: 0, panY: 0, zoom: 0 })}><FrameIcon size={13} /></IconButton>
                <span className="mx-0.5 h-4 w-px bg-line" />
                <IconButton label={showHistogram ? 'Hide the histogram' : 'Show the histogram (drag across it to pick out a range of values)'} active={showHistogram} onClick={() => { setShowHistogram((value) => !value); setRange(null); }}><PulseIcon size={13} /></IconButton>
                <IconButton label={pinning ? 'Stop dropping colour pins' : 'Drop colour pins: click the image to keep a pixel\'s value in view'} active={pinning} onClick={() => setPinning((value) => !value)}><PinIcon size={13} /></IconButton>
                <IconButton
                    label={compare ? `Stop comparing with ${compare.label}` : 'Hold this node as A, to compare the next one with it'}
                    active={Boolean(compare)}
                    disabled={!compare && !nodeId}
                    onClick={() => setCompare((value) => (value || !nodeId ? null : { nodeId, output, label }))}
                ><CompareIcon size={13} /></IconButton>
                <IconButton label={lit ? 'Show the normal map as it is' : 'Light it as a normal map (the light follows the pointer)'} active={lit} disabled={image?.kind === 'gray'} onClick={() => setLit((value) => !value)}><SunIcon size={13} /></IconButton>
                <span className="flex-1" />
                <label className="flex items-center gap-1 text-2xs text-ink-3" title="Exposure in stops: brighter or darker, for looking only. Double-click to reset.">
                    <span>EV</span>
                    <input type="range" min={-6} max={6} step={0.1} value={exposure} aria-label="Exposure"
                        onChange={(event) => setExposure(Number(event.target.value))} onDoubleClick={() => setExposure(0)} className="w-16 accent-accent" />
                    <span className="w-7 text-right font-mono text-ink-2">{exposure > 0 ? '+' : ''}{exposure.toFixed(1)}</span>
                </label>
            </div>
            <div
                ref={host}
                className={`relative min-h-0 flex-1 ${cursor}`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={() => { wanted.current = null; setProbe(null); }}
            >
                <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
                {!image && <div className="absolute inset-0 flex items-center justify-center text-2xs text-ink-3">{nodeId ? (state?.error ?? 'Drawing…') : 'Double-click a node to look at it here.'}</div>}
                {placement && (
                    <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
                        {handles && handles.frame.outline.length > 0 && (
                            <polygon points={handles.frame.outline.map((point) => { const at = toView(point); return `${at.x},${at.y}`; }).join(' ')} fill="none" stroke="rgb(240 138 60 / 0.8)" strokeWidth={1} strokeDasharray="4 3" />
                        )}
                        {handles?.frame.line && (() => { const a = toView(handles.frame.line[0]); const b = toView(handles.frame.line[1]); return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="rgb(240 138 60 / 0.8)" strokeWidth={1} strokeDasharray="4 3" />; })()}
                        {handles?.frame.points.map((point) => {
                            const at = toView(point.at);
                            const off = handles.locked(point.key);
                            const fill = point.look === 'end' ? (point.key === 'start' ? '#111214' : '#f5f5f5') : point.look === 'turn' ? 'rgb(30 31 34)' : 'rgb(240 138 60)';
                            return (
                                <g key={point.key} className={off ? '' : 'pointer-events-auto cursor-pointer'} opacity={off ? 0.35 : 1}
                                    onPointerDown={off ? undefined : (event) => onHandleDown(event, point.key)}
                                    onPointerMove={off ? undefined : onHandleMove}
                                    onPointerUp={() => { handleDrag.current = null; }}>
                                    <title>{off ? 'This setting follows a graph parameter' : HANDLE_WORDS[point.key] ?? 'Drag'}</title>
                                    {point.look === 'size'
                                        ? <rect x={at.x - 5} y={at.y - 5} width={10} height={10} fill={fill} stroke="#111214" strokeWidth={1.5} />
                                        : <circle cx={at.x} cy={at.y} r={point.look === 'move' ? 6 : 5} fill={fill} stroke={point.look === 'turn' ? 'rgb(240 138 60)' : '#111214'} strokeWidth={point.look === 'turn' ? 2 : 1.5} />}
                                </g>
                            );
                        })}
                        {pins.map((pin) => { const at = toView([pin.u, pin.v]); return <circle key={pin.id} cx={at.x} cy={at.y} r={4} fill="none" stroke="#f5f5f5" strokeWidth={1.5} />; })}
                        {line && (() => { const a = uvToView(line.from, placement); const b = uvToView(line.to, placement); return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="rgb(240 138 60)" strokeWidth={2} />; })()}
                    </svg>
                )}
                {placement && pins.map((pin) => {
                    const at = toView([pin.u, pin.v]);
                    const values = pinValues.get(pin.id);
                    return (
                        <div key={pin.id} className="absolute flex items-center gap-1 rounded bg-panel/90 px-1 py-px font-mono text-[10px] text-ink-2 shadow" style={{ left: at.x + 7, top: at.y - 9 }}
                            onPointerDown={(event) => event.stopPropagation()}>
                            {values && <span className="h-2.5 w-2.5 rounded-sm border border-line" style={{ background: swatchOf(values) }} />}
                            <span>{formatValues(values)}</span>
                            <button type="button" aria-label="Remove this pin" title="Remove this pin" onClick={() => setPins((list) => list.filter((item) => item.id !== pin.id))} className="text-ink-3 hover:text-ink"><CrossIcon size={9} /></button>
                        </div>
                    );
                })}
                {other && compare && (
                    <>
                        <div className="pointer-events-none absolute left-2 top-2 rounded bg-panel/90 px-1.5 py-0.5 text-2xs text-ink-2">A · {compare.label}</div>
                        <div className="pointer-events-none absolute right-2 top-2 rounded bg-panel/90 px-1.5 py-0.5 text-2xs text-ink-2">B · {label}</div>
                        <div
                            role="slider"
                            aria-label="Compare wipe"
                            aria-valuenow={Math.round(wipe * 100)}
                            title="Drag to move the wipe"
                            className="absolute top-1/2 h-8 w-3 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-sm border border-accent bg-panel"
                            style={{ left: `${wipe * 100}%` }}
                            onPointerDown={(event) => { event.stopPropagation(); (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); }}
                            onPointerMove={(event) => {
                                if (!(event.currentTarget as HTMLElement).hasPointerCapture(event.pointerId) || !host.current) return;
                                event.stopPropagation();
                                const box = host.current.getBoundingClientRect();
                                setWipe(Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)));
                            }}
                        />
                    </>
                )}
                {compare && !other && <div className="pointer-events-none absolute left-2 top-2 rounded bg-panel/90 px-1.5 py-0.5 text-2xs text-ink-3">Holding {compare.label} as A: look at another node to compare.</div>}
                {picking && (
                    <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-panel/95 px-2 py-1 text-2xs text-accent shadow">
                        {picking.kind === 'colour' ? `Click to pick ${picking.label}` : `Drag a line across the image to pick ${picking.label}`} · Esc to stop
                    </div>
                )}
            </div>
            {showHistogram && (
                <div className="border-t border-line px-2 pb-1 pt-1">
                    <canvas
                        ref={histogramCanvas}
                        aria-label="Histogram: drag across it to pick out a range of values"
                        className="block h-12 w-full cursor-col-resize rounded-sm bg-well"
                        onPointerDown={(event) => { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); rangeDrag.current = rangeAt(event.clientX); setRange(null); }}
                        onPointerMove={(event) => { if (rangeDrag.current !== null) setRange([rangeDrag.current, rangeAt(event.clientX)]); }}
                        onPointerUp={(event) => {
                            const start = rangeDrag.current;
                            rangeDrag.current = null;
                            if (start === null) return;
                            const end = rangeAt(event.clientX);
                            setRange(Math.abs(end - start) < 0.01 ? null : [start, end]);
                        }}
                    />
                    <div className="mt-0.5 flex justify-between text-[10px] text-ink-3">
                        <span>{histogram ? `${channel === 'rgb' ? 'Brightness' : channel.toUpperCase()} from 0 to 1` : 'Reading…'}</span>
                        <span>{range && share !== null ? `${(share * 100).toFixed(1)}% of pixels from ${Math.min(...range).toFixed(2)} to ${Math.max(...range).toFixed(2)}` : 'Drag across to pick a range'}</span>
                    </div>
                </div>
            )}
            <div className="flex flex-wrap items-center gap-x-3 border-t border-line px-2 py-1 text-2xs text-ink-3">
                {image ? <span className="shrink-0">{image.width} × {image.height} · {image.kind === 'color' ? 'colour' : 'grey'} · {image.precision === 8 ? '8-bit' : image.precision === 16 ? 'half float' : 'full float'}</span> : <span>—</span>}
                {state && <span className="shrink-0">{state.milliseconds < 1 ? '<1' : Math.round(state.milliseconds)} ms</span>}
                {pins.length > 0 && <button type="button" onClick={() => setPins([])} className="shrink-0 text-ink-3 hover:text-ink">Clear pins</button>}
                {probeText && <span className="ml-auto whitespace-nowrap font-mono text-ink-2" title="The pixel under the pointer, counted from the top left, and its values">{probeText}</span>}
            </div>
        </div>
    );
};
