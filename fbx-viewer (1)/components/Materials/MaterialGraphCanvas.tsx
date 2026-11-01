import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Maximize, MessageSquarePlus, Plus, Redo2, Trash2, Undo2 } from 'lucide-react';
import {
    OUTPUT_NODE_TYPE,
    REROUTE_NODE_TYPE,
    getMaterialNodeDefinition,
    readParam,
    resolveAutoTypes,
    resolvedPortType,
    type MaterialGraph,
    type MaterialGraphComment,
    type MaterialGraphLink,
    type MaterialGraphNode,
    type MaterialInputDef,
    type MaterialValueType,
} from '../../runtime/materials/materialGraph';
import { NODE_PREVIEW_SIZE, nodePreviewImages } from '../../runtime/materials/materialPreviews';
import { MaterialNodePalette } from './MaterialNodePalette';
import { toHex } from './MaterialParamField';
import {
    HEADER,
    NODE_WIDTH,
    REROUTE_SIZE,
    ROW,
    addNode,
    boundsOf,
    commentNodes,
    connect,
    copyNodes,
    createComment,
    insertReroute,
    moveNodes,
    nodeRect,
    nodesInRect,
    pasteNodes,
    pinPosition,
    previewTop,
    readClipboard,
    rectFrom,
    removeNodes,
    showsPreview,
    wirePath,
    withComments,
    type MaterialClipboard,
    type PendingWire,
    type Point,
    type Rect,
} from './materialGraphEditing';

/**
 * The material graph's canvas. Left-drag on empty space draws a selection box (Shift adds to the
 * selection); right- or middle-drag pans and the wheel zooms; right-click (or Space) opens the node
 * palette where the pointer is. Drag from a pin to wire it; dropping a wire on empty space offers
 * the nodes to end it on; dragging a wire off an input moves it. Alt-click a wire to cut it,
 * double-click it for a reroute. Ctrl+C/X/V/D copy, cut, paste and duplicate, Ctrl+Z/Y undo and
 * redo, C comments the selection, F frames it.
 */

const PIN_COLORS: Record<MaterialValueType, string> = { float: '#a3a3a3', vec2: '#4ade80', vec3: '#facc15', vec4: '#c084fc' };
const TYPE_NAMES: Record<MaterialValueType, string> = { float: 'number', vec2: 'vector 2', vec3: 'vector 3 / colour', vec4: 'vector 4' };
const MIN_SCALE = 0.15;
const MAX_SCALE = 2.5;
/** Pixels the pointer moves before a press becomes a drag. */
const DRAG_THRESHOLD = 4;
/** How a node that feeds nothing the material reads looks: dimmed, still opaque. */
const UNUSED_FILTER = 'grayscale(0.7) brightness(0.7)';

/** In-memory copy, for when the system clipboard cannot be reached. */
let lastClipboard: MaterialClipboard | null = null;

interface Viewport { x: number; y: number; scale: number }

type Gesture =
    | { kind: 'pan'; button: number; startX: number; startY: number; lastX: number; lastY: number; moved: boolean }
    | { kind: 'move'; start: Point; base: MaterialGraph; ids: Set<string>; moved: boolean }
    | { kind: 'marquee'; start: Point; additive: boolean }
    | { kind: 'wire'; wire: PendingWire }
    | { kind: 'comment'; id: string; start: Point; base: MaterialGraph; ids: Set<string>; resize: boolean };

export interface MaterialGraphCanvasProps {
    graph: MaterialGraph;
    selection: ReadonlySet<string>;
    selectedComment: string | null;
    previews: boolean;
    /** Nodes that feed nothing the material uses. */
    unused: ReadonlySet<string>;
    canUndo: boolean;
    canRedo: boolean;
    onSelect: (nodeIds: string[], comment?: string | null) => void;
    /** `commit` false: a step of a drag, recorded when the drag ends; `coalesce` merges quick edits of one value into one undo step. */
    onChange: (graph: MaterialGraph, commit: boolean, coalesce?: string) => void;
    onUndo: () => void;
    onRedo: () => void;
    onTogglePreviews: () => void;
}

/** A node's preview image, painted as the previewer publishes it. */
const NodePreviewImage: React.FC<{ nodeId: string }> = ({ nodeId }) => {
    const canvas = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        const paint = () => {
            const image = nodePreviewImages.get(nodeId);
            const context = canvas.current?.getContext('2d');
            if (image && context) context.putImageData(image, 0, 0);
        };
        paint();
        return nodePreviewImages.subscribe(paint);
    }, [nodeId]);
    return <canvas ref={canvas} width={NODE_PREVIEW_SIZE} height={NODE_PREVIEW_SIZE} className="rounded border border-gray-800 bg-gray-950" style={{ width: NODE_PREVIEW_SIZE, height: NODE_PREVIEW_SIZE }} />;
};

/** The value an unwired input takes from its node's settings, shown beside it. */
const InlineValue: React.FC<{ node: MaterialGraphNode; input: MaterialInputDef }> = ({ node, input }) => {
    const fallback = input.fallback;
    if (typeof fallback !== 'object' || !('param' in fallback)) return null;
    const param = getMaterialNodeDefinition(node.type)?.params.find(candidate => candidate.key === fallback.param);
    if (!param) return null;
    const value = readParam(param, node.params[param.key]);
    if (param.kind === 'color') return <span className="ml-auto mr-2 h-2.5 w-4 rounded-sm border border-gray-700" style={{ background: toHex(value as number[]) }} />;
    if (param.kind === 'float') return <span className="ml-auto mr-2 font-mono text-2xs text-gray-500">{(value as number).toFixed(2)}</span>;
    if (Array.isArray(value)) return <span className="ml-auto mr-2 font-mono text-2xs text-gray-500">{(value as number[]).map(v => v.toFixed(1)).join(', ')}</span>;
    return null;
};

export const MaterialGraphCanvas: React.FC<MaterialGraphCanvasProps> = (props) => {
    const { graph, selection, selectedComment, previews, unused, canUndo, canRedo, onSelect, onChange, onUndo, onRedo, onTogglePreviews } = props;
    const container = useRef<HTMLDivElement>(null);
    const [viewport, setViewport] = useState<Viewport>({ x: 40, y: 40, scale: 1 });
    const gesture = useRef<Gesture | null>(null);
    const [marquee, setMarquee] = useState<Rect | null>(null);
    const [wireEnd, setWireEnd] = useState<Point | null>(null);
    const [palette, setPalette] = useState<{ screen: Point; at: Point; wire: PendingWire | null } | null>(null);
    const [editingComment, setEditingComment] = useState<string | null>(null);
    const pointer = useRef<Point | null>(null);
    // Handlers on the window read the latest props and view through these.
    const latest = useRef({ props, viewport });
    latest.current = { props, viewport };

    const nodes = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph.nodes]);
    const autoTypes = useMemo(() => resolveAutoTypes(graph), [graph]);
    const wired = useMemo(() => new Set(graph.links.map(link => `${link.toNode}:${link.toInput}`)), [graph.links]);
    const comments = graph.comments ?? [];

    const toGraph = useCallback((clientX: number, clientY: number): Point => {
        const rect = container.current!.getBoundingClientRect();
        const view = latest.current.viewport;
        return { x: (clientX - rect.left - view.x) / view.scale, y: (clientY - rect.top - view.y) / view.scale };
    }, []);

    const toScreen = (point: Point): Point => ({ x: point.x * viewport.scale + viewport.x, y: point.y * viewport.scale + viewport.y });

    const portType = (node: MaterialGraphNode, kind: 'in' | 'out', key: string): MaterialValueType => {
        const definition = getMaterialNodeDefinition(node.type)!;
        const port = (kind === 'in' ? definition.inputs : definition.outputs).find(candidate => candidate.key === key);
        return resolvedPortType(port?.type ?? 'float', node.id, autoTypes);
    };

    /** Fits `rect` (graph space) in view. */
    const frame = useCallback((rect: Rect | null) => {
        const element = container.current;
        if (!rect || !element) return;
        const padding = 60;
        const width = element.clientWidth;
        const height = element.clientHeight;
        const scale = Math.min(1.2, Math.max(MIN_SCALE, Math.min((width - padding * 2) / Math.max(rect.width, 1), (height - padding * 2) / Math.max(rect.height, 1))));
        setViewport({ scale, x: width / 2 - (rect.x + rect.width / 2) * scale, y: height / 2 - (rect.y + rect.height / 2) * scale });
    }, []);

    const allRects = useCallback((only?: ReadonlySet<string>) => {
        const { graph: current, previews: showing } = latest.current.props;
        const rects = current.nodes.filter(node => !only || only.has(node.id)).map(node => nodeRect(node, showing));
        return only ? rects : [...rects, ...(current.comments ?? [])];
    }, []);

    // Each material opens framed.
    useLayoutEffect(() => { frame(boundsOf(allRects())); }, [frame, allRects]);

    // ------------------------------------------------------------------ gestures

    const openPalette = useCallback((clientX: number, clientY: number, wire: PendingWire | null) => {
        const rect = container.current!.getBoundingClientRect();
        const left = Math.min(Math.max(8, clientX - rect.left), rect.width - 300);
        const top = Math.min(Math.max(8, clientY - rect.top), rect.height - 420);
        setPalette({ screen: { x: Math.max(8, left), y: Math.max(8, top) }, at: toGraph(clientX, clientY), wire });
    }, [toGraph]);

    useEffect(() => {
        const move = (event: MouseEvent) => {
            const current = gesture.current;
            if (!current) return;
            const { props: latestProps } = latest.current;
            const point = toGraph(event.clientX, event.clientY);
            if (current.kind === 'pan') {
                const dx = event.clientX - current.lastX;
                const dy = event.clientY - current.lastY;
                current.lastX = event.clientX;
                current.lastY = event.clientY;
                if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > DRAG_THRESHOLD) current.moved = true;
                setViewport(view => ({ ...view, x: view.x + dx, y: view.y + dy }));
            } else if (current.kind === 'move') {
                const delta = { x: point.x - current.start.x, y: point.y - current.start.y };
                if (!current.moved && Math.hypot(delta.x, delta.y) * latest.current.viewport.scale < DRAG_THRESHOLD) return;
                current.moved = true;
                latestProps.onChange(moveNodes(latestProps.graph, current.base, current.ids, delta), false);
            } else if (current.kind === 'marquee') {
                setMarquee(rectFrom(current.start, point));
            } else if (current.kind === 'wire') {
                setWireEnd(point);
            } else if (current.kind === 'comment') {
                const delta = { x: point.x - current.start.x, y: point.y - current.start.y };
                const base = current.base.comments?.find(comment => comment.id === current.id);
                if (!base) return;
                const changed = current.resize
                    ? { ...base, width: Math.max(80, Math.round(base.width + delta.x)), height: Math.max(48, Math.round(base.height + delta.y)) }
                    : { ...base, x: Math.round(base.x + delta.x), y: Math.round(base.y + delta.y) };
                const moved = current.resize ? current.base : moveNodes(current.base, current.base, current.ids, delta);
                latestProps.onChange(withComments(moved, (current.base.comments ?? []).map(comment => (comment.id === current.id ? changed : comment))), false);
            }
        };
        const up = (event: MouseEvent) => {
            const current = gesture.current;
            if (!current) return;
            gesture.current = null;
            const { props: latestProps } = latest.current;
            if (current.kind === 'pan') {
                // A right-click that did not drag opens the palette.
                if (current.button === 2 && !current.moved) openPalette(event.clientX, event.clientY, null);
            } else if (current.kind === 'move') {
                if (current.moved) latestProps.onChange(latestProps.graph, true);
            } else if (current.kind === 'marquee') {
                const rect = rectFrom(current.start, toGraph(event.clientX, event.clientY));
                const hit = nodesInRect(latestProps.graph, rect, latestProps.previews);
                if (rect.width * latest.current.viewport.scale < DRAG_THRESHOLD && rect.height * latest.current.viewport.scale < DRAG_THRESHOLD) {
                    if (!current.additive) latestProps.onSelect([], null);
                } else {
                    latestProps.onSelect(current.additive ? [...new Set([...latestProps.selection, ...hit])] : hit, null);
                }
                setMarquee(null);
            } else if (current.kind === 'wire') {
                setWireEnd(null);
                // Dropped on empty space: offer the nodes the wire could end on.
                const target = event.target as HTMLElement | null;
                if (!target?.closest('[data-pin]') && container.current?.contains(target)) openPalette(event.clientX, event.clientY, current.wire);
            } else if (current.kind === 'comment') {
                latestProps.onChange(latestProps.graph, true);
            }
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    }, [openPalette, toGraph]);

    const onWheel = (event: React.WheelEvent) => {
        const rect = container.current!.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        setViewport((view) => {
            const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * Math.exp(-event.deltaY * 0.0015)));
            const graphX = (mouseX - view.x) / view.scale;
            const graphY = (mouseY - view.y) / view.scale;
            return { scale, x: mouseX - graphX * scale, y: mouseY - graphY * scale };
        });
    };

    const startPan = (event: React.MouseEvent) => {
        gesture.current = { kind: 'pan', button: event.button, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false };
    };

    const onBackgroundDown = (event: React.MouseEvent) => {
        container.current?.focus();
        setPalette(null);
        if (event.button === 1 || event.button === 2) { startPan(event); return; }
        if (event.button !== 0) return;
        const start = toGraph(event.clientX, event.clientY);
        gesture.current = { kind: 'marquee', start, additive: event.shiftKey || event.ctrlKey || event.metaKey };
    };

    const onNodeDown = (event: React.MouseEvent, node: MaterialGraphNode) => {
        event.stopPropagation();
        container.current?.focus();
        setPalette(null);
        if (event.button === 1 || event.button === 2) { startPan(event); return; }
        if (event.button !== 0) return;
        let ids: Set<string>;
        if (event.shiftKey || event.ctrlKey || event.metaKey) {
            ids = new Set(selection);
            if (ids.has(node.id)) ids.delete(node.id); else ids.add(node.id);
            onSelect([...ids], null);
            if (!ids.has(node.id)) return;
        } else if (selection.has(node.id)) {
            ids = new Set(selection);
        } else {
            ids = new Set([node.id]);
            onSelect([node.id], null);
        }
        gesture.current = { kind: 'move', start: toGraph(event.clientX, event.clientY), base: graph, ids, moved: false };
    };

    const startWire = (event: React.MouseEvent, node: MaterialGraphNode, kind: 'in' | 'out', key: string) => {
        event.stopPropagation();
        if (event.button !== 0) return;
        container.current?.focus();
        setPalette(null);
        if (kind === 'in') {
            const existing = graph.links.find(link => link.toNode === node.id && link.toInput === key);
            if (existing) {
                // Pick the wire up off the input: it follows the pointer from its source.
                const source = nodes.get(existing.fromNode)!;
                onChange({ ...graph, links: graph.links.filter(link => link !== existing) }, true);
                gesture.current = { kind: 'wire', wire: { from: 'out', nodeId: source.id, key: existing.fromOutput, type: portType(source, 'out', existing.fromOutput) } };
                setWireEnd(toGraph(event.clientX, event.clientY));
                return;
            }
        }
        gesture.current = { kind: 'wire', wire: { from: kind, nodeId: node.id, key, type: portType(node, kind, key) } };
        setWireEnd(toGraph(event.clientX, event.clientY));
    };

    const finishWire = (event: React.MouseEvent, node: MaterialGraphNode, kind: 'in' | 'out', key: string) => {
        const current = gesture.current;
        if (current?.kind !== 'wire' || current.wire.from === kind || current.wire.nodeId === node.id) return;
        event.stopPropagation();
        gesture.current = null;
        setWireEnd(null);
        const link: MaterialGraphLink = current.wire.from === 'out'
            ? { fromNode: current.wire.nodeId, fromOutput: current.wire.key, toNode: node.id, toInput: key }
            : { fromNode: node.id, fromOutput: key, toNode: current.wire.nodeId, toInput: current.wire.key };
        const next = connect(graph, link);
        if (next) onChange(next, true);
    };

    // ------------------------------------------------------------------ commands

    const deleteSelection = useCallback(() => {
        const { graph: current, selection: selected, selectedComment: comment } = latest.current.props;
        let next = removeNodes(current, selected);
        if (comment) next = withComments(next, (next.comments ?? []).filter(candidate => candidate.id !== comment));
        if (next !== current) {
            onChange(next, true);
            onSelect([], null);
        }
    }, [onChange, onSelect]);

    const pasteAt = useCallback((clipboard: MaterialClipboard) => {
        const { graph: current } = latest.current.props;
        const origin = pointer.current ?? { x: Math.min(...clipboard.nodes.map(node => node.x)) + 40, y: Math.min(...clipboard.nodes.map(node => node.y)) + 40 };
        const pasted = pasteNodes(current, clipboard, origin);
        onChange(pasted.graph, true);
        onSelect(pasted.nodeIds, null);
    }, [onChange, onSelect]);

    const duplicate = useCallback(() => {
        const { graph: current, selection: selected } = latest.current.props;
        const clipboard = copyNodes(current, selected);
        if (!clipboard) return;
        const pasted = pasteNodes(current, clipboard, { x: Math.min(...clipboard.nodes.map(node => node.x)) + 40, y: Math.min(...clipboard.nodes.map(node => node.y)) + 40 });
        onChange(pasted.graph, true);
        onSelect(pasted.nodeIds, null);
    }, [onChange, onSelect]);

    const addComment = useCallback(() => {
        const { graph: current, selection: selected, previews: showing } = latest.current.props;
        const rects = current.nodes.filter(node => selected.has(node.id)).map(node => nodeRect(node, showing));
        const comment = createComment(rects, pointer.current ?? { x: 0, y: 0 });
        onChange(withComments(current, [...(current.comments ?? []), comment]), true);
        onSelect([], comment.id);
    }, [onChange, onSelect]);

    const onKeyDown = (event: React.KeyboardEvent) => {
        const target = event.target as HTMLElement;
        if (target.closest('input, textarea, select')) return;
        const mod = event.ctrlKey || event.metaKey;
        const key = event.key.toLowerCase();
        if (key === 'delete' || key === 'backspace') { event.preventDefault(); deleteSelection(); }
        else if (mod && key === 'z' && !event.shiftKey) { event.preventDefault(); onUndo(); }
        else if (mod && (key === 'y' || (key === 'z' && event.shiftKey))) { event.preventDefault(); onRedo(); }
        else if (mod && key === 'a') { event.preventDefault(); onSelect(graph.nodes.map(node => node.id), null); }
        else if (mod && key === 'd') { event.preventDefault(); duplicate(); }
        else if (!mod && key === 'f') { event.preventDefault(); frame(boundsOf(allRects(selection.size ? selection : undefined))); }
        else if (!mod && key === 'c') { event.preventDefault(); addComment(); }
        else if (!mod && (key === ' ' || key === 'tab')) {
            event.preventDefault();
            const rect = container.current!.getBoundingClientRect();
            const at = pointer.current ? { x: pointer.current.x * viewport.scale + viewport.x + rect.left, y: pointer.current.y * viewport.scale + viewport.y + rect.top } : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            openPalette(at.x, at.y, null);
        } else if (key === 'escape') { setPalette(null); onSelect([], null); }
    };

    const onCopy = (event: React.ClipboardEvent, cut: boolean) => {
        if ((event.target as HTMLElement).closest('input, textarea, select')) return;
        const clipboard = copyNodes(graph, selection);
        if (!clipboard) return;
        event.preventDefault();
        lastClipboard = clipboard;
        event.clipboardData.setData('text/plain', JSON.stringify(clipboard));
        if (cut) deleteSelection();
    };

    const onPaste = (event: React.ClipboardEvent) => {
        if ((event.target as HTMLElement).closest('input, textarea, select')) return;
        const clipboard = readClipboard(event.clipboardData.getData('text/plain')) ?? lastClipboard;
        if (!clipboard) return;
        event.preventDefault();
        pasteAt(clipboard);
    };

    const pick = (type: string) => {
        if (!palette) return;
        // A node made from a dragged wire sits so that the joining pin is near where the wire was dropped.
        const offset = palette.wire?.from === 'in' ? { x: -NODE_WIDTH, y: -HEADER } : { x: 0, y: -HEADER };
        const at = type === REROUTE_NODE_TYPE ? { x: palette.at.x - REROUTE_SIZE / 2, y: palette.at.y - REROUTE_SIZE / 2 } : { x: palette.at.x + offset.x, y: palette.at.y + offset.y };
        const added = addNode(graph, type, at, palette.wire);
        onChange(added.graph, true);
        onSelect([added.node.id], null);
        setPalette(null);
        container.current?.focus();
    };

    // ------------------------------------------------------------------ drawing

    const wireColor = (link: MaterialGraphLink) => {
        const from = nodes.get(link.fromNode);
        return from ? PIN_COLORS[portType(from, 'out', link.fromOutput)] : '#888';
    };

    const pendingWire = (() => {
        const current = gesture.current;
        if (current?.kind !== 'wire' || !wireEnd) return null;
        const node = nodes.get(current.wire.nodeId);
        if (!node) return null;
        const pin = pinPosition(node, current.wire.from, current.wire.key);
        const path = current.wire.from === 'out' ? wirePath(pin, wireEnd) : wirePath(wireEnd, pin);
        return <path d={path} stroke={PIN_COLORS[current.wire.type]} strokeWidth={2} strokeDasharray="6 4" fill="none" />;
    })();

    const paletteContext = (() => {
        const wire = palette?.wire;
        const node = wire && nodes.get(wire.nodeId);
        if (!wire || !node) return undefined;
        const definition = getMaterialNodeDefinition(node.type)!;
        const port = (wire.from === 'out' ? definition.outputs : definition.inputs).find(candidate => candidate.key === wire.key);
        return `${wire.from === 'out' ? 'From' : 'Into'} ${definition.label}${port?.label ? ` · ${port.label}` : ''}`;
    })();

    const renderComment = (comment: MaterialGraphComment) => {
        const selected = comment.id === selectedComment;
        return (
            <div
                key={comment.id}
                className={`absolute rounded-md border ${selected ? 'border-blue-500' : 'border-transparent'}`}
                style={{ left: comment.x, top: comment.y, width: comment.width, height: comment.height, background: `${comment.color}55` }}
            >
                <div
                    className="flex h-7 cursor-move items-center rounded-t-md px-2 text-[12px] font-bold text-gray-100"
                    style={{ background: `${comment.color}cc` }}
                    onMouseDown={(event) => {
                        event.stopPropagation();
                        container.current?.focus();
                        if (event.button !== 0) { startPan(event); return; }
                        onSelect([], comment.id);
                        gesture.current = { kind: 'comment', id: comment.id, start: toGraph(event.clientX, event.clientY), base: graph, ids: new Set(commentNodes(graph, comment, previews)), resize: false };
                    }}
                    onDoubleClick={() => setEditingComment(comment.id)}
                >
                    {editingComment === comment.id ? (
                        <input
                            autoFocus
                            aria-label="Comment text"
                            defaultValue={comment.text}
                            onMouseDown={(event) => event.stopPropagation()}
                            onBlur={(event) => {
                                setEditingComment(null);
                                onChange(withComments(graph, comments.map(candidate => (candidate.id === comment.id ? { ...candidate, text: event.target.value.slice(0, 500) } : candidate))), true);
                            }}
                            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === 'Escape') (event.target as HTMLInputElement).blur(); }}
                            className="w-full rounded bg-gray-950/70 px-1 text-[12px] text-white outline-none"
                        />
                    ) : <span className="truncate">{comment.text || 'Comment'}</span>}
                </div>
                <div
                    aria-label="Resize comment"
                    className="absolute bottom-0 right-0 h-3 w-3 cursor-nwse-resize"
                    style={{ background: `linear-gradient(135deg, transparent 50%, ${comment.color} 50%)` }}
                    onMouseDown={(event) => {
                        event.stopPropagation();
                        if (event.button !== 0) return;
                        onSelect([], comment.id);
                        gesture.current = { kind: 'comment', id: comment.id, start: toGraph(event.clientX, event.clientY), base: graph, ids: new Set(), resize: true };
                    }}
                />
            </div>
        );
    };

    const renderPin = (node: MaterialGraphNode, kind: 'in' | 'out', key: string, label: string, className: string) => {
        const type = portType(node, kind, key);
        const isWired = kind === 'out' || wired.has(`${node.id}:${key}`);
        const definition = getMaterialNodeDefinition(node.type)!;
        return (
            <span
                role="button"
                data-pin={kind}
                aria-label={`${definition.label} ${label || (kind === 'in' ? 'In' : 'Out')} ${kind === 'in' ? 'input' : 'output'}`}
                title={`${label || definition.label} (${TYPE_NAMES[type]})`}
                className={`absolute h-3 w-3 cursor-crosshair rounded-full border-2 ${className}`}
                style={{ borderColor: PIN_COLORS[type], background: isWired ? PIN_COLORS[type] : '#111827' }}
                onMouseDown={(event) => startWire(event, node, kind, key)}
                onMouseUp={(event) => finishWire(event, node, kind, key)}
            />
        );
    };

    const renderNode = (node: MaterialGraphNode) => {
        const definition = getMaterialNodeDefinition(node.type)!;
        const selected = selection.has(node.id);
        const faded = unused.has(node.id);
        if (node.type === REROUTE_NODE_TYPE) {
            const type = portType(node, 'out', 'out');
            return (
                <div
                    key={node.id}
                    data-node-id={node.id}
                    className={`absolute rounded-full border-2 ${selected ? 'border-blue-400' : 'border-gray-900'}`}
                    style={{ left: node.x, top: node.y, width: REROUTE_SIZE, height: REROUTE_SIZE, background: PIN_COLORS[type], filter: faded ? UNUSED_FILTER : undefined }}
                    title="Reroute"
                    onMouseDown={(event) => onNodeDown(event, node)}
                >
                    {renderPin(node, 'in', 'in', '', '-left-[7px] top-[1px] scale-75')}
                    {renderPin(node, 'out', 'out', '', '-right-[7px] top-[1px] scale-75')}
                </div>
            );
        }
        const rect = nodeRect(node, previews);
        const isOutput = node.type === OUTPUT_NODE_TYPE;
        return (
            <div
                key={node.id}
                data-node-id={node.id}
                className={`absolute rounded-md border bg-gray-900 shadow-lg ${selected ? 'border-blue-500 ring-1 ring-blue-500/60' : isOutput ? 'border-emerald-700' : faded ? 'border-dashed border-gray-600' : 'border-gray-700'}`}
                style={{ left: node.x, top: node.y, width: rect.width, height: rect.height, filter: faded ? UNUSED_FILTER : undefined }}
                onMouseDown={(event) => onNodeDown(event, node)}
                title={faded ? 'Not used: it feeds nothing the material reads' : undefined}
            >
                <div className={`flex items-center justify-between rounded-t-md px-2 text-2xs font-bold ${isOutput ? 'bg-emerald-900/60 text-emerald-200' : 'bg-gray-800 text-gray-200'}`} style={{ height: HEADER }} title={definition.description}>
                    <span className="truncate">
                        {definition.label}
                        {node.parameter && <span className="ml-1 font-normal text-amber-300" title="Material parameter">· {node.parameter}</span>}
                    </span>
                    {!isOutput && (
                        <button aria-label={`Remove ${definition.label}`} onMouseDown={(event) => event.stopPropagation()} onClick={() => { onChange(removeNodes(graph, [node.id]), true); onSelect([], null); }} className="text-gray-500 hover:text-red-400"><Trash2 size={11} /></button>
                    )}
                </div>
                {definition.outputs.map(output => (
                    <div key={output.key} className="relative flex items-center justify-end pr-3 text-2xs text-gray-300" style={{ height: ROW }}>
                        {output.label}
                        {renderPin(node, 'out', output.key, output.label, '-right-[7px]')}
                    </div>
                ))}
                {definition.inputs.map(input => (
                    <div key={input.key} className="relative flex items-center pl-3 text-2xs text-gray-300" style={{ height: ROW }}>
                        {renderPin(node, 'in', input.key, input.label, '-left-[7px]')}
                        <span className="truncate">{input.label}</span>
                        {!wired.has(`${node.id}:${input.key}`) && <InlineValue node={node} input={input} />}
                    </div>
                ))}
                {previews && showsPreview(node) && (
                    <div className="absolute left-0 right-0 flex justify-center" style={{ top: previewTop(node) }}>
                        <NodePreviewImage nodeId={node.id} />
                    </div>
                )}
            </div>
        );
    };

    const toolbarButton = 'flex items-center gap-1 rounded bg-gray-800/90 px-2 py-1 text-2xs text-gray-200 hover:bg-gray-700 disabled:opacity-40';

    return (
        <div
            ref={container}
            tabIndex={0}
            aria-label="Material graph"
            className="relative flex-1 select-none overflow-hidden bg-well outline-none"
            style={{ backgroundImage: 'radial-gradient(#1f2937 1px, transparent 1px)', backgroundSize: `${20 * viewport.scale}px ${20 * viewport.scale}px`, backgroundPosition: `${viewport.x}px ${viewport.y}px` }}
            onWheel={onWheel}
            onMouseDown={onBackgroundDown}
            onMouseMove={(event) => { pointer.current = toGraph(event.clientX, event.clientY); }}
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={onKeyDown}
            onCopy={(event) => onCopy(event, false)}
            onCut={(event) => onCopy(event, true)}
            onPaste={onPaste}
        >
            <div className="absolute left-0 top-0" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`, transformOrigin: '0 0' }}>
                {comments.map(renderComment)}
                <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1}>
                    {graph.links.map((link) => {
                        const from = nodes.get(link.fromNode);
                        const to = nodes.get(link.toNode);
                        if (!from || !to) return null;
                        const start = pinPosition(from, 'out', link.fromOutput);
                        const end = pinPosition(to, 'in', link.toInput);
                        const d = wirePath(start, end);
                        const color = wireColor(link);
                        const faded = unused.has(link.toNode);
                        return (
                            <g key={`${link.toNode}:${link.toInput}`} className="group">
                                <path d={d} stroke={color} strokeWidth={2.5} fill="none" opacity={faded ? 0.4 : 0.95} />
                                <path
                                    d={d}
                                    stroke="transparent"
                                    strokeWidth={12}
                                    fill="none"
                                    className="pointer-events-auto cursor-pointer"
                                    onMouseDown={(event) => {
                                        event.stopPropagation();
                                        if (event.button === 2 || event.altKey) onChange({ ...graph, links: graph.links.filter(other => other !== link) }, true);
                                    }}
                                    onDoubleClick={(event) => {
                                        event.stopPropagation();
                                        onChange(insertReroute(graph, link, toGraph(event.clientX, event.clientY)), true);
                                    }}
                                >
                                    <title>Alt+click or right-click to cut · double-click to add a reroute</title>
                                </path>
                            </g>
                        );
                    })}
                    {pendingWire}
                </svg>
                {/* Selected nodes on top; one keyed list, so a node changing place is moved, not remounted. */}
                {[...graph.nodes].sort((a, b) => Number(selection.has(a.id)) - Number(selection.has(b.id))).map(renderNode)}
            </div>

            {marquee && (() => {
                const a = toScreen({ x: marquee.x, y: marquee.y });
                return <div className="pointer-events-none absolute border border-blue-400 bg-blue-500/10" style={{ left: a.x, top: a.y, width: marquee.width * viewport.scale, height: marquee.height * viewport.scale }} />;
            })()}

            <div className="absolute left-3 top-3 z-20 flex flex-wrap gap-1" onMouseDown={(event) => event.stopPropagation()}>
                <button className={`${toolbarButton} bg-blue-600 font-bold text-accent-ink hover:bg-blue-500`} aria-label="Add node" onClick={(event) => openPalette(event.clientX, event.clientY + 24, null)}>
                    <Plus size={12} /> Add node
                </button>
                <button className={toolbarButton} aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={onUndo}><Undo2 size={12} /></button>
                <button className={toolbarButton} aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!canRedo} onClick={onRedo}><Redo2 size={12} /></button>
                <button className={toolbarButton} aria-label="Add comment" title="Comment the selection (C)" onClick={addComment}><MessageSquarePlus size={12} /></button>
                <button className={toolbarButton} aria-label="Frame" title="Frame the selection, or everything (F)" onClick={() => frame(boundsOf(allRects(selection.size ? selection : undefined)))}><Maximize size={12} /></button>
                <button className={toolbarButton} aria-label={previews ? 'Hide node previews' : 'Show node previews'} title="Node previews" aria-pressed={previews} onClick={onTogglePreviews}>
                    {previews ? <Eye size={12} /> : <EyeOff size={12} />}
                </button>
            </div>
            <div className="pointer-events-none absolute bottom-2 left-3 text-2xs text-gray-600">
                Right-click or Space: add · drag pins to wire · Alt+click a wire to cut · Ctrl+C/V/D · Ctrl+Z/Y · C comment · F frame
            </div>

            {palette && (
                <MaterialNodePalette
                    left={palette.screen.x}
                    top={palette.screen.y}
                    context={paletteContext}
                    onPick={pick}
                    onClose={() => { setPalette(null); container.current?.focus(); }}
                />
            )}
        </div>
    );
};
