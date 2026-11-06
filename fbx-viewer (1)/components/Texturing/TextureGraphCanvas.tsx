import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CommentAddIcon, FrameIcon, PlusIcon, RedoIcon, UndoIcon, WarningIcon } from '../UI/Icons';
import { OUTPUT_NODE_TYPE } from '../../texturing/graph/nodes/io';
import { textureNodeDefinition, type GraphResolver } from '../../texturing/graph/registry';
import { OUTPUT_CHANNEL_LABELS, type OutputChannel, type PortKind, type TexGraphNode, type TexNodeDef, type TextureGraph } from '../../texturing/graph/types';
import { IconButton } from '../UI/kit';
import {
    HEADER,
    NODE_WIDTH,
    THUMB,
    boundsOf,
    bodyHeight,
    connect,
    copyNodes,
    createComment,
    moveNodes,
    nodeRect,
    overlaps,
    pasteNodes,
    pinPosition,
    portKind,
    readClipboard,
    rectFrom,
    removeNodes,
    unusedNodes,
    wirePath,
    type GraphClipboard,
    type Point,
} from './graphEditing';
import { NodePalette, type PaletteChoice } from './NodePalette';
import type { TextureGraphSession } from './textureGraphSession';

/**
 * The texture graph's canvas. Every node shows its picture. Left-drag empty space to select with a
 * box (Shift adds), middle- or right-drag to pan, wheel to zoom. Space, right-click or double-click
 * empty space opens the node list where the pointer is. Drag from a pin to wire it; a wire dropped
 * on empty space offers the nodes to end it on. Alt-click a wire to cut it. Double-click a node to
 * look at it in the 2D view. Delete removes, Ctrl+C/X/V/D copy, cut, paste and duplicate,
 * Ctrl+Z/Y undo and redo, C comments the selection, F frames it (or everything).
 */

const KIND_COLORS: Record<PortKind | 'any', string> = { color: '#e9b949', gray: '#a3a3a3', any: '#f5f5f5' };
const KIND_WORDS: Record<PortKind | 'any', string> = { color: 'colour', gray: 'grey', any: 'colour or grey' };
const CATEGORY_TINTS: Record<string, string> = {
    'Inputs and outputs': '#2563eb', 'Mesh maps': '#0891b2', Noises: '#7c3aed', Patterns: '#9333ea', Shapes: '#a855f7',
    Adjustments: '#059669', Blending: '#0d9488', Transforms: '#ca8a04', Warps: '#d97706', 'Blurs and sharpening': '#65a30d',
    'Edges and distance': '#db2777', 'Height and normals': '#4f46e5', Utility: '#52525b',
};
const MIN_SCALE = 0.12;
const MAX_SCALE = 2.5;
const DRAG_THRESHOLD = 4;

let memoryClipboard: GraphClipboard | null = null;

interface Viewport { x: number; y: number; scale: number }

type PendingWire = { side: 'in' | 'out'; nodeId: string; key: string; kind: PortKind | 'any'; to: Point };
type Gesture =
    | { kind: 'pan'; startX: number; startY: number; lastX: number; lastY: number; moved: boolean; button: number }
    | { kind: 'move'; start: Point; base: TextureGraph; ids: Set<string>; moved: boolean }
    | { kind: 'marquee'; start: Point; additive: boolean }
    | { kind: 'wire'; wire: PendingWire }
    | { kind: 'comment'; id: string; start: Point; base: TextureGraph; ids: Set<string>; resize: boolean };

export interface TextureGraphCanvasProps {
    graph: TextureGraph;
    session: TextureGraphSession;
    resolve: GraphResolver;
    /** Graphs the node list offers as sub-graph nodes. */
    graphs: ReadonlyArray<{ id: string; name: string }>;
    selection: ReadonlySet<string>;
    selectedComment: string | null;
    viewed: string | null;
    canUndo: boolean;
    canRedo: boolean;
    onSelect: (ids: string[], comment?: string | null) => void;
    onView: (nodeId: string) => void;
    /** `commit` false: a step of a drag, recorded when it ends; `coalesce` merges quick edits. */
    onChange: (graph: TextureGraph, commit: boolean, coalesce?: string) => void;
    onAddSubgraph: (graphId: string, at: Point) => TexGraphNode | null;
    onUndo: () => void;
    onRedo: () => void;
}

/** A node's picture, painted whenever the session draws it anew. */
const Thumbnail: React.FC<{ session: TextureGraphSession; nodeId: string }> = ({ session, nodeId }) => {
    const canvas = useRef<HTMLCanvasElement>(null);
    const version = useSyncExternalStore(session.subscribe, session.getVersion);
    const painted = useRef('');
    useEffect(() => {
        const thumbnail = session.thumbnails.get(nodeId);
        const context = canvas.current?.getContext('2d');
        if (!context) return;
        if (!thumbnail) {
            context.fillStyle = '#18181b';
            context.fillRect(0, 0, THUMB, THUMB);
            painted.current = '';
            return;
        }
        if (painted.current === thumbnail.signature) return;
        painted.current = thumbnail.signature;
        context.putImageData(thumbnail.image, 0, 0);
    }, [nodeId, session, version]);
    return <canvas ref={canvas} width={THUMB} height={THUMB} className="pointer-events-none rounded-sm" style={{ width: THUMB, height: THUMB, imageRendering: 'auto' }} />;
};

export const TextureGraphCanvas: React.FC<TextureGraphCanvasProps> = ({
    graph, session, resolve, graphs, selection, selectedComment, viewed, canUndo, canRedo, onSelect, onView, onChange, onAddSubgraph, onUndo, onRedo,
}) => {
    const root = useRef<HTMLDivElement>(null);
    const [viewport, setViewport] = useState<Viewport>({ x: 40, y: 40, scale: 0.85 });
    const [gesture, setGesture] = useState<Gesture | null>(null);
    const [pointer, setPointer] = useState<Point>({ x: 0, y: 0 });
    const [marqueeEnd, setMarqueeEnd] = useState<Point | null>(null);
    const [palette, setPalette] = useState<{ at: Point; screen: Point; wire?: PendingWire } | null>(null);
    const sessionVersion = useSyncExternalStore(session.subscribe, session.getVersion);

    const definitions = useMemo(() => new Map(graph.nodes.map((node) => [node.id, textureNodeDefinition(node, resolve)])), [graph.nodes, resolve]);
    const definition = useCallback((node: TexGraphNode): TexNodeDef | null => definitions.get(node.id) ?? null, [definitions]);
    const unused = useMemo(() => unusedNodes(graph), [graph]);

    const toGraph = useCallback((clientX: number, clientY: number): Point => {
        const box = root.current?.getBoundingClientRect();
        return { x: (clientX - (box?.left ?? 0) - viewport.x) / viewport.scale, y: (clientY - (box?.top ?? 0) - viewport.y) / viewport.scale };
    }, [viewport]);

    const frame = useCallback((ids?: ReadonlySet<string>) => {
        const box = root.current?.getBoundingClientRect();
        const nodes = graph.nodes.filter((node) => !ids?.size || ids.has(node.id));
        const bounds = boundsOf(nodes.map((node) => nodeRect(node, definition(node))));
        if (!box || !bounds) return;
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min((box.width - 80) / bounds.width, (box.height - 80) / bounds.height, 1.2)));
        setViewport({ scale, x: box.width / 2 - (bounds.x + bounds.width / 2) * scale, y: box.height / 2 - (bounds.y + bounds.height / 2) * scale });
    }, [definition, graph.nodes]);

    // Frame the graph the first time it is shown.
    const framed = useRef(false);
    useLayoutEffect(() => {
        if (framed.current || !graph.nodes.length) return;
        framed.current = true;
        frame();
    }, [frame, graph.nodes.length]);

    const onWheel = useCallback((event: WheelEvent) => {
        event.preventDefault();
        const box = root.current!.getBoundingClientRect();
        const mx = event.clientX - box.left;
        const my = event.clientY - box.top;
        setViewport((current) => {
            const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * Math.exp(-event.deltaY * 0.0015)));
            return { scale, x: mx - (mx - current.x) * (scale / current.scale), y: my - (my - current.y) * (scale / current.scale) };
        });
    }, []);
    useEffect(() => {
        const element = root.current;
        element?.addEventListener('wheel', onWheel, { passive: false });
        return () => element?.removeEventListener('wheel', onWheel);
    }, [onWheel]);

    const openPalette = useCallback((clientX: number, clientY: number, wire?: PendingWire) => {
        const box = root.current!.getBoundingClientRect();
        setPalette({ at: toGraph(clientX, clientY), screen: { x: clientX - box.left, y: clientY - box.top }, wire });
    }, [toGraph]);

    const pinKind = (nodeId: string, side: 'in' | 'out', key: string) => portKind(graph, nodeId, side, key, resolve);

    // ---- pointer handling ----
    const onPointerDown = (event: React.PointerEvent) => {
        if (palette) setPalette(null);
        const target = event.target as HTMLElement;
        root.current?.setPointerCapture(event.pointerId);
        const at = toGraph(event.clientX, event.clientY);
        if (event.button === 1 || event.button === 2) {
            setGesture({ kind: 'pan', startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false, button: event.button });
            return;
        }
        const pin = target.closest('[data-pin]') as HTMLElement | null;
        if (pin) {
            const nodeId = pin.dataset.node!;
            const side = pin.dataset.pin as 'in' | 'out';
            const key = pin.dataset.key!;
            if (side === 'in') {
                // Dragging a wire off an input picks it up from its other end.
                const existing = graph.links.find((link) => link.to === nodeId && link.toInput === key);
                if (existing) {
                    onChange({ ...graph, links: graph.links.filter((link) => link !== existing) }, true);
                    setGesture({ kind: 'wire', wire: { side: 'out', nodeId: existing.from, key: existing.fromOutput, kind: pinKind(existing.from, 'out', existing.fromOutput), to: at } });
                    return;
                }
            }
            setGesture({ kind: 'wire', wire: { side, nodeId, key, kind: pinKind(nodeId, side, key), to: at } });
            return;
        }
        const commentElement = target.closest('[data-comment]') as HTMLElement | null;
        if (commentElement && !target.closest('[data-node]')) {
            const id = commentElement.dataset.comment!;
            const comment = graph.comments?.find((candidate) => candidate.id === id);
            if (comment) {
                const inside = new Set(graph.nodes.filter((node) => overlaps(nodeRect(node, definition(node)), comment) && node.x >= comment.x && node.y >= comment.y).map((node) => node.id));
                onSelect([], id);
                setGesture({ kind: 'comment', id, start: at, base: graph, ids: inside, resize: Boolean(target.closest('[data-resize]')) });
                return;
            }
        }
        const nodeElement = target.closest('[data-node]') as HTMLElement | null;
        if (nodeElement) {
            const id = nodeElement.dataset.node!;
            let ids = new Set(selection);
            if (event.shiftKey) {
                if (ids.has(id)) ids.delete(id); else ids.add(id);
            } else if (!ids.has(id)) ids = new Set([id]);
            onSelect([...ids]);
            setGesture({ kind: 'move', start: at, base: graph, ids, moved: false });
            return;
        }
        setGesture({ kind: 'marquee', start: at, additive: event.shiftKey });
        setMarqueeEnd(at);
    };

    const onPointerMove = (event: React.PointerEvent) => {
        const at = toGraph(event.clientX, event.clientY);
        setPointer(at);
        if (!gesture) return;
        if (gesture.kind === 'pan') {
            const moved = gesture.moved || Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > DRAG_THRESHOLD;
            setViewport((current) => ({ ...current, x: current.x + event.clientX - gesture.lastX, y: current.y + event.clientY - gesture.lastY }));
            setGesture({ ...gesture, lastX: event.clientX, lastY: event.clientY, moved });
        } else if (gesture.kind === 'move') {
            const dx = at.x - gesture.start.x;
            const dy = at.y - gesture.start.y;
            if (!gesture.moved && Math.hypot(dx, dy) * viewport.scale < DRAG_THRESHOLD) return;
            setGesture({ ...gesture, moved: true });
            onChange(moveNodes(gesture.base, gesture.ids, dx, dy), false);
        } else if (gesture.kind === 'marquee') {
            setMarqueeEnd(at);
        } else if (gesture.kind === 'wire') {
            setGesture({ kind: 'wire', wire: { ...gesture.wire, to: at } });
        } else if (gesture.kind === 'comment') {
            const dx = at.x - gesture.start.x;
            const dy = at.y - gesture.start.y;
            const comments = (gesture.base.comments ?? []).map((comment) => (comment.id !== gesture.id ? comment : gesture.resize
                ? { ...comment, width: Math.max(80, Math.round(comment.width + dx)), height: Math.max(60, Math.round(comment.height + dy)) }
                : { ...comment, x: Math.round(comment.x + dx), y: Math.round(comment.y + dy) }));
            const moved = gesture.resize ? gesture.base : moveNodes(gesture.base, gesture.ids, dx, dy);
            onChange({ ...moved, comments }, false);
        }
    };

    const endWire = (wire: PendingWire, target: HTMLElement | null, clientX: number, clientY: number) => {
        const pin = target?.closest('[data-pin]') as HTMLElement | null;
        if (pin && pin.dataset.pin !== wire.side && pin.dataset.node !== wire.nodeId) {
            const other = { nodeId: pin.dataset.node!, key: pin.dataset.key! };
            const link = wire.side === 'out'
                ? { from: wire.nodeId, fromOutput: wire.key, to: other.nodeId, toInput: other.key }
                : { from: other.nodeId, fromOutput: other.key, to: wire.nodeId, toInput: wire.key };
            onChange(connect(graph, link), true);
            return;
        }
        if (!pin) openPalette(clientX, clientY, wire);
    };

    const onPointerUp = (event: React.PointerEvent) => {
        root.current?.releasePointerCapture(event.pointerId);
        const current = gesture;
        setGesture(null);
        if (!current) return;
        if (current.kind === 'pan') {
            if (!current.moved && current.button === 2) openPalette(event.clientX, event.clientY);
        } else if (current.kind === 'move') {
            if (current.moved) onChange(moveNodes(current.base, current.ids, toGraph(event.clientX, event.clientY).x - current.start.x, toGraph(event.clientX, event.clientY).y - current.start.y), true);
        } else if (current.kind === 'comment') {
            onChange(graph, true);
        } else if (current.kind === 'marquee') {
            const end = marqueeEnd ?? current.start;
            setMarqueeEnd(null);
            const box = rectFrom(current.start, end);
            if (box.width < 3 && box.height < 3) {
                if (!current.additive) onSelect([]);
                return;
            }
            const inside = graph.nodes.filter((node) => overlaps(nodeRect(node, definition(node)), box)).map((node) => node.id);
            onSelect(current.additive ? [...new Set([...selection, ...inside])] : inside);
        } else if (current.kind === 'wire') {
            endWire(current.wire, document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null, event.clientX, event.clientY);
        }
    };

    const onDoubleClick = (event: React.MouseEvent) => {
        // The canvas holds the pointer while a button is down, so the event arrives on the canvas itself:
        // look up what is really under the pointer.
        const target = (document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null) ?? (event.target as HTMLElement);
        const nodeElement = target.closest('[data-node]') as HTMLElement | null;
        if (nodeElement) {
            onView(nodeElement.dataset.node!);
            return;
        }
        if (!target.closest('[data-comment]')) openPalette(event.clientX, event.clientY);
    };

    const choose = (choice: PaletteChoice) => {
        if (!palette) return;
        let next = graph;
        let created: TexGraphNode | null = null;
        if (choice.kind === 'graph') {
            created = onAddSubgraph(choice.graphId, palette.at);
            if (!created) { setPalette(null); return; }
            next = { ...graph, nodes: [...graph.nodes, created] };
        } else {
            const { createNodeAt } = choice;
            created = createNodeAt(palette.at);
            next = { ...graph, nodes: [...graph.nodes, created] };
        }
        const wire = palette.wire;
        if (wire && created) {
            const definition = textureNodeDefinition(created, resolve);
            if (wire.side === 'out') {
                const input = definition?.inputs.find((port) => port.kind === 'any' || wire.kind === 'any' || port.kind === wire.kind) ?? definition?.inputs[0];
                if (input) next = connect(next, { from: wire.nodeId, fromOutput: wire.key, to: created.id, toInput: input.key });
            } else {
                const output = definition?.outputs.find((port) => port.kind === 'any' || wire.kind === 'any' || port.kind === wire.kind) ?? definition?.outputs[0];
                if (output) next = connect(next, { from: created.id, fromOutput: output.key, to: wire.nodeId, toInput: wire.key });
            }
        }
        onChange(next, true);
        if (created) onSelect([created.id]);
        setPalette(null);
    };

    // ---- keys ----
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const element = event.target as HTMLElement | null;
            if (element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable)) return;
            if (!root.current?.matches(':hover') && !root.current?.contains(document.activeElement)) return;
            const mod = event.ctrlKey || event.metaKey;
            const key = event.key.toLowerCase();
            if (mod && key === 'z') { event.preventDefault(); if (event.shiftKey) onRedo(); else onUndo(); return; }
            if (mod && key === 'y') { event.preventDefault(); onRedo(); return; }
            if ((key === 'delete' || key === 'backspace') && (selection.size || selectedComment)) {
                event.preventDefault();
                let next = removeNodes(graph, selection);
                if (selectedComment) next = { ...next, comments: (next.comments ?? []).filter((comment) => comment.id !== selectedComment) };
                onChange(next, true);
                onSelect([]);
                return;
            }
            if (mod && (key === 'c' || key === 'x') && selection.size) {
                event.preventDefault();
                memoryClipboard = copyNodes(graph, selection);
                void navigator.clipboard?.writeText(JSON.stringify(memoryClipboard)).catch(() => undefined);
                if (key === 'x') { onChange(removeNodes(graph, selection), true); onSelect([]); }
                return;
            }
            if (mod && key === 'v') {
                event.preventDefault();
                const paste = (clipboard: GraphClipboard | null) => {
                    if (!clipboard?.nodes.length) return;
                    const result = pasteNodes(graph, clipboard, pointer);
                    onChange(result.graph, true);
                    onSelect(result.ids);
                };
                if (navigator.clipboard?.readText) void navigator.clipboard.readText().then((text) => paste(readClipboard(text) ?? memoryClipboard), () => paste(memoryClipboard));
                else paste(memoryClipboard);
                return;
            }
            if (mod && key === 'd' && selection.size) {
                event.preventDefault();
                const copied = copyNodes(graph, selection);
                const bounds = boundsOf(copied.nodes.map((node) => nodeRect(node, definition(node))))!;
                const result = pasteNodes(graph, copied, { x: bounds.x + 30, y: bounds.y + 30 });
                onChange(result.graph, true);
                onSelect(result.ids);
                return;
            }
            if (mod) return;
            if (key === 'f') { event.preventDefault(); frame(selection.size ? selection : undefined); return; }
            if (key === ' ') {
                event.preventDefault();
                const box = root.current!.getBoundingClientRect();
                openPalette(box.left + pointer.x * viewport.scale + viewport.x, box.top + pointer.y * viewport.scale + viewport.y);
                return;
            }
            if (key === 'c' && selection.size) {
                const comment = createComment(graph.nodes.filter((node) => selection.has(node.id)).map((node) => nodeRect(node, definition(node))), pointer);
                onChange({ ...graph, comments: [...(graph.comments ?? []), comment] }, true);
                onSelect([], comment.id);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [definition, frame, graph, onChange, onRedo, onSelect, onUndo, openPalette, pointer, selectedComment, selection, viewport]);

    // ---- drawing ----
    const linkPaths = graph.links.map((link) => {
        const from = graph.nodes.find((node) => node.id === link.from);
        const to = graph.nodes.find((node) => node.id === link.to);
        if (!from || !to) return null;
        const a = pinPosition(from, definition(from), 'out', link.fromOutput);
        const b = pinPosition(to, definition(to), 'in', link.toInput);
        const kind = pinKind(link.from, 'out', link.fromOutput);
        const selected = selection.has(link.from) || selection.has(link.to);
        return (
            <g key={`${link.from}:${link.fromOutput}>${link.to}:${link.toInput}`}>
                <path d={wirePath(a, b)} stroke="transparent" strokeWidth={12} fill="none" style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                    onPointerDown={(event) => {
                        if (!event.altKey) return;
                        event.stopPropagation();
                        onChange({ ...graph, links: graph.links.filter((candidate) => candidate !== link) }, true);
                    }}>
                    <title>Alt-click to cut this wire</title>
                </path>
                <path d={wirePath(a, b)} stroke={KIND_COLORS[kind]} strokeOpacity={selected ? 1 : 0.7} strokeWidth={selected ? 2.4 : 1.6} fill="none" pointerEvents="none" />
            </g>
        );
    });

    let pendingPath: React.ReactNode = null;
    if (gesture?.kind === 'wire') {
        const node = graph.nodes.find((candidate) => candidate.id === gesture.wire.nodeId);
        if (node) {
            const pin = pinPosition(node, definition(node), gesture.wire.side, gesture.wire.key);
            const path = gesture.wire.side === 'out' ? wirePath(pin, gesture.wire.to) : wirePath(gesture.wire.to, pin);
            pendingPath = <path d={path} stroke={KIND_COLORS[gesture.wire.kind]} strokeWidth={2} strokeDasharray="6 4" fill="none" />;
        }
    }

    const marquee = gesture?.kind === 'marquee' && marqueeEnd ? rectFrom(gesture.start, marqueeEnd) : null;
    void sessionVersion;

    const renderNode = (node: TexGraphNode) => {
        const def = definition(node);
        const state = session.state(node.id);
        const selected = selection.has(node.id);
        const isViewed = viewed === node.id;
        const isOutput = node.type === OUTPUT_NODE_TYPE;
        const label = isOutput ? (String(node.params.name || '') || OUTPUT_CHANNEL_LABELS[node.params.channel as OutputChannel] || 'Output') : def?.label ?? node.type;
        const tint = isOutput ? '#1d4ed8' : CATEGORY_TINTS[def?.category ?? 'Utility'] ?? '#52525b';
        const body = bodyHeight(def);
        const error = state?.error ?? (!def ? `This build has no "${node.type}" node.` : null);
        return (
            <div
                key={node.id}
                data-node={node.id}
                className={`absolute select-none rounded-md border shadow-lg ${selected ? 'border-white' : error ? 'border-red-500' : isViewed ? 'border-sky-400' : 'border-zinc-700'}`}
                style={{ left: node.x, top: node.y, width: NODE_WIDTH, background: '#1c1c1f', opacity: unused.has(node.id) && !selected ? 0.55 : 1 }}
                title={error ?? def?.description}
            >
                <div className="flex items-center gap-1 rounded-t-md px-1.5 text-2xs font-semibold text-white" style={{ height: HEADER, background: tint }}>
                    <span className="truncate">{label}</span>
                    <span className="flex-1" />
                    {error && <WarningIcon size={11} className="shrink-0 text-red-200" />}
                    {state && !error && state.milliseconds >= 20 && <span className="shrink-0 font-mono text-[9px] font-normal text-white/70">{Math.round(state.milliseconds)}ms</span>}
                </div>
                <div className="relative flex items-center justify-center" style={{ height: body }}>
                    <Thumbnail session={session} nodeId={node.id} />
                </div>
                {def?.inputs.map((port) => {
                    const at = pinPosition(node, def, 'in', port.key);
                    const kind = port.kind;
                    const wired = graph.links.some((link) => link.to === node.id && link.toInput === port.key);
                    return (
                        <div key={`in:${port.key}`} className="group absolute" style={{ left: -6, top: at.y - node.y - 6 }}>
                            <div data-pin="in" data-node={node.id} data-key={port.key} title={`${port.label} (${KIND_WORDS[kind]})`}
                                className="h-3 w-3 cursor-crosshair rounded-full border-2" style={{ borderColor: KIND_COLORS[kind], background: wired ? KIND_COLORS[kind] : '#111' }} />
                            <span className="pointer-events-none absolute right-4 top-[-2px] hidden whitespace-nowrap rounded bg-black/80 px-1 text-[10px] text-zinc-200 group-hover:block">{port.label}</span>
                        </div>
                    );
                })}
                {def?.outputs.map((port) => {
                    const at = pinPosition(node, def, 'out', port.key);
                    const kind = pinKind(node.id, 'out', port.key);
                    return (
                        <div key={`out:${port.key}`} className="group absolute" style={{ left: NODE_WIDTH - 6, top: at.y - node.y - 6 }}>
                            <div data-pin="out" data-node={node.id} data-key={port.key} title={`${port.label} (${KIND_WORDS[kind]})`}
                                className="h-3 w-3 cursor-crosshair rounded-full border-2" style={{ borderColor: KIND_COLORS[kind], background: KIND_COLORS[kind] }} />
                            {def.outputs.length > 1 && <span className="pointer-events-none absolute left-4 top-[-2px] whitespace-nowrap text-[10px] text-zinc-400">{port.label}</span>}
                        </div>
                    );
                })}
            </div>
        );
    };

    return (
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-[#121214]" onContextMenu={(event) => event.preventDefault()}>
            <div
                ref={root}
                tabIndex={0}
                aria-label="Texture graph canvas"
                className="absolute inset-0 outline-none"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onDoubleClick={onDoubleClick}
                style={{
                    cursor: gesture?.kind === 'pan' ? 'grabbing' : 'default',
                    backgroundImage: 'radial-gradient(circle, #2a2a2e 1px, transparent 1px)',
                    backgroundSize: `${24 * viewport.scale}px ${24 * viewport.scale}px`,
                    backgroundPosition: `${viewport.x}px ${viewport.y}px`,
                }}
            >
                <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }}>
                    {(graph.comments ?? []).map((comment) => (
                        <div key={comment.id} data-comment={comment.id}
                            className={`absolute rounded-md border ${selectedComment === comment.id ? 'border-white/70' : 'border-white/10'}`}
                            style={{ left: comment.x, top: comment.y, width: comment.width, height: comment.height, background: `${comment.color}55` }}>
                            <div className="truncate rounded-t-md px-2 py-1 text-xs font-semibold text-zinc-100" style={{ background: `${comment.color}cc` }}>{comment.text}</div>
                            <div data-resize className="absolute bottom-0 right-0 h-3 w-3 cursor-se-resize" />
                        </div>
                    ))}
                    <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1}>
                        <g style={{ pointerEvents: 'auto' }}>{linkPaths}</g>
                        {pendingPath}
                    </svg>
                    {graph.nodes.map(renderNode)}
                    {marquee && <div className="pointer-events-none absolute border border-sky-400 bg-sky-400/10" style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }} />}
                </div>
            </div>
            <div className="absolute left-2 top-2 flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900/90 p-1 shadow">
                <IconButton label="Add a node" shortcut="Space" onClick={() => { const box = root.current!.getBoundingClientRect(); openPalette(box.left + box.width / 2, box.top + box.height / 2); }}><PlusIcon size={14} /></IconButton>
                <IconButton label="Undo" shortcut="Ctrl+Z" disabled={!canUndo} onClick={onUndo}><UndoIcon size={14} /></IconButton>
                <IconButton label="Redo" shortcut="Ctrl+Y" disabled={!canRedo} onClick={onRedo}><RedoIcon size={14} /></IconButton>
                <IconButton label="Frame" shortcut="F" onClick={() => frame(selection.size ? selection : undefined)}><FrameIcon size={14} /></IconButton>
                <IconButton label="Comment the selection" shortcut="C" disabled={!selection.size} onClick={() => {
                    const comment = createComment(graph.nodes.filter((node) => selection.has(node.id)).map((node) => nodeRect(node, definition(node))), pointer);
                    onChange({ ...graph, comments: [...(graph.comments ?? []), comment] }, true);
                    onSelect([], comment.id);
                }}><CommentAddIcon size={14} /></IconButton>
            </div>
            <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-zinc-900/80 px-2 py-1 text-2xs text-zinc-400">
                {session.busy ? 'Drawing…' : `${graph.nodes.length} nodes · drew ${session.lastRun.nodes} in ${Math.round(session.lastRun.milliseconds)} ms`}
            </div>
            {palette && (
                <NodePalette
                    at={palette.screen}
                    graphs={graphs}
                    wireKind={palette.wire ? { side: palette.wire.side, kind: palette.wire.kind } : null}
                    onChoose={choose}
                    onClose={() => setPalette(null)}
                />
            )}
        </div>
    );
};

