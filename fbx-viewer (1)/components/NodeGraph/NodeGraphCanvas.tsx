import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
    ChevronDownIcon, CommentAddIcon, CopyIcon, FlameIcon, FlowIcon, FrameIcon, GlobeIcon, LayersIcon, LayoutIcon, MagnetIcon, PaletteIcon, PencilIcon, PlusIcon,
    PowerIcon, RedoIcon, RouteIcon, ScissorsIcon, SearchIcon, TrashIcon, UndoIcon, WarningIcon,
} from '../UI/Icons';
import { IconButton } from '../UI/kit';
import { ALIGN_LABELS, GRID, alignRects, distributeRects, snapToGrid, type AlignEdge } from './arrange';
import { FRAME_COLOURS, FRAME_COLOUR_NAMES, FRAME_MIN, fitFrame, frameContents, frameMembers, refitFrames } from './frames';
import { fitsWire, type FinderEntry } from './finder';
import { FindBar, type FindTarget } from './FindBar';
import { HEADER, ROW, cardLayout, groupOpenByDefault, type CardLayout } from './layout';
import { Minimap } from './Minimap';
import {
    bestPin, boundsOf, connect, disconnect, freeSpot, insertReroute, linkKey, pasteNodes, placeNodes, rectFrom, rectsOverlap, removeNodes, setLook, spliceNode,
    type EditableFrame, type EditableGraph, type EditableLink, type EditableNode, type KindMatch, type NodeLook, type PinSet, type Point, type Rect,
} from './model';
import { NodeCard, type CardActions } from './NodeCard';
import { NodeFinder } from './NodeFinder';
import { NodeMenu, type MenuColours } from './NodeMenu';
import { tidyLayout } from './tidy';
import type { MenuItem, NodeView, PinKindStyle } from './types';
import { nearestWire, wireBounds, wireControls } from './wires';

/**
 * THE NODE GRAPH CANVAS
 *
 * One canvas for the texture graph and the shader graph, each giving it an adapter. It stays smooth
 * with a thousand nodes: only nodes in view are drawn (as plain blocks when zoomed far out), each
 * card is memoised and redraws alone, and every wire is drawn in one layer.
 *
 * Mouse: left-drag on empty space selects with a box (Shift adds); right- or middle-drag pans; the
 * wheel zooms. Right-click a node, wire or frame for its menu, or empty space to add a node there.
 * Drag from a pin to wire it; a wire dropped on empty space offers the nodes to end it on, and on a
 * node joins its best pin; dragging a wire off an input picks it up. Alt-click a wire to cut it,
 * double-click it for a reroute point. Drop a node with no wires onto a wire to splice it in.
 * Double-click a frame's title to rename it; drag it to move it with everything in it.
 *
 * Keys (with the pointer over the canvas or focus in it): Space adds a node (spliced into the wire
 * under the pointer, if any), Ctrl+F finds, F frames the selection (or everything), C puts a frame
 * round the selection, B bypasses, H folds, F2 renames, Delete removes, Ctrl+C/X/V/D copy, cut, paste
 * and duplicate, Ctrl+A selects all, arrows nudge (Shift: by the grid), Escape clears.
 */

export interface NodeGraphAdapter<S> {
    /** Which graph this is: names its kept favourites and recent nodes. */
    kind: string;
    /** What pins carry: colours and words. */
    kinds: Readonly<Record<string, PinKindStyle>>;
    match: KindMatch;
    /** Why a wire from a pin carrying `from` cannot go into one taking `to` (they do not match), in words. */
    refusal?: (from: string, to: string) => string;
    /** The nodes the finder offers. */
    entries: readonly FinderEntry[];
    /** A picture (or a mark) for an entry, `size` pixels across. */
    renderPicture?: (entry: FinderEntry, size: number) => React.ReactNode;
    /** Called as the finder opens (to start drawing its pictures). */
    onFinderOpen?: () => void;
    createNode: (entryId: string, at: Point) => EditableNode<S> | null;
    createReroute: (at: Point) => EditableNode<S> | null;
    /** The size of a node's card, one new to the graph included (for finding it free space). */
    sizeOf?: (node: EditableNode<S>) => { width: number; height: number };
    /** The pins of any node, one new to the graph included. */
    pins: (node: EditableNode<S>) => PinSet;
    newId: () => string;
    copy: (graph: EditableGraph<S>, ids: ReadonlySet<string>) => string;
    paste: (text: string) => { nodes: EditableNode<S>[]; links: EditableLink[] } | null;
    /** Whether nodes can be renamed, coloured and folded (their graph keeps those). */
    looks: boolean;
    /** The picture under a node's pins. */
    renderBody?: (nodeId: string, view: NodeView) => React.ReactNode;
    /** Items of the graph's own in a node's menu. */
    menuItems?: (nodeId: string) => MenuItem[];
    /** A node double-clicked. */
    onOpenNode?: (nodeId: string) => void;
    /** A graph used as a node, opened in place. */
    onOpenGraph?: (nodeId: string) => void;
    /** What a node costs to draw (larger is costlier) and that in words, for the cost map. */
    cost?: (nodeId: string) => { value: number; label: string } | null;
    /** What the cost map measures, in words (its button's tooltip). */
    costWords?: string;
    /** Pairs of nodes tied together without a wire (named links): a faint line joins them while one is selected. */
    ghostLinks?: ReadonlyArray<{ from: string; to: string }>;
}

export interface NodeGraphCanvasProps<S> {
    label: string;
    graph: EditableGraph<S>;
    views: ReadonlyMap<string, NodeView>;
    adapter: NodeGraphAdapter<S>;
    selection: ReadonlySet<string>;
    selectedFrame: string | null;
    /** A node shown in another view, marked with the accent. */
    highlighted?: string | null;
    canUndo: boolean;
    canRedo: boolean;
    onUndo: () => void;
    onRedo: () => void;
    /**
     * Where the undo and redo keys work: 'workspace' anywhere in the screen the canvas sits in (the
     * element marked data-workspace round it, else its parent), 'canvas' over the canvas only, 'none'
     * nowhere (its host takes them).
     */
    undoKeys?: 'workspace' | 'canvas' | 'none';
    onSelect: (ids: string[], frame?: string | null) => void;
    /** A changed graph, one undo step (`coalesce` merges quick edits of one thing into one step). */
    onEdit: (graph: EditableGraph<S>, coalesce?: string) => void;
    /** More toolbar buttons, after the canvas's own. */
    toolbarExtra?: React.ReactNode;
    /** Something to know about the graph, over the canvas's top right. */
    notice?: React.ReactNode;
    /** A line at the bottom left (what is drawing, how many nodes). */
    status?: React.ReactNode;
}

const MIN_SCALE = 0.08;
const MAX_SCALE = 2.5;
/** Below this zoom cards are drawn as plain blocks with their titles. */
const CHIP_SCALE = 0.4;
const DRAG_THRESHOLD = 4;
/** Screen pixels within which the pointer is on a wire. */
const WIRE_REACH = 6;

export const NODE_COLOURS = ['#7f1d1d', '#9a3412', '#854d0e', '#3f6212', '#166534', '#115e59', '#1e40af', '#3730a3', '#6b21a8', '#9d174d', '#3f3f46'];
export const NODE_COLOUR_NAMES: Record<string, string> = {
    '#7f1d1d': 'Red', '#9a3412': 'Orange', '#854d0e': 'Amber', '#3f6212': 'Olive', '#166534': 'Green', '#115e59': 'Teal', '#1e40af': 'Blue', '#3730a3': 'Indigo', '#6b21a8': 'Violet', '#9d174d': 'Pink', '#3f3f46': 'Grey',
};

const readSetting = (key: string, fallback: boolean): boolean => {
    try {
        const value = window.localStorage.getItem(`auvra.nodeGraph.${key}`);
        return value === null ? fallback : value === 'on';
    } catch {
        return fallback;
    }
};
const writeSetting = (key: string, value: boolean) => {
    try { window.localStorage.setItem(`auvra.nodeGraph.${key}`, value ? 'on' : 'off'); } catch { /* the choice is just not kept */ }
};

const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);
/** True when keys pressed in `target` are typing (where undo belongs to the box). */
const typesText = (target: EventTarget | null): boolean => {
    const element = target as HTMLElement | null;
    if (!element?.tagName) return false;
    if (element.isContentEditable || element.tagName === 'TEXTAREA') return true;
    return element.tagName === 'INPUT' && TEXT_INPUTS.has((element as HTMLInputElement).type);
};
const inField = (target: EventTarget | null): boolean => {
    const element = target as HTMLElement | null;
    return Boolean(element?.tagName && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT' || element.isContentEditable));
};

type PendingWire = { side: 'in' | 'out'; nodeId: string; key: string; kind: string; to: Point };
type Target = { node?: string; frame?: string; wire?: EditableLink };
type Gesture =
    | { kind: 'pan'; button: number; startX: number; startY: number; lastX: number; lastY: number; moved: boolean; target: Target }
    | { kind: 'move'; start: Point; ids: Set<string>; anchor: Point; moved: boolean; offset: Point; spliceable: string | null; splice: string | null; narrowTo: string | null }
    | { kind: 'marquee'; start: Point; additive: boolean; box: Rect }
    | { kind: 'wire'; wire: PendingWire }
    | { kind: 'frame'; id: string; start: Point; nodes: Set<string>; frames: Set<string>; resize: boolean; moved: boolean; offset: Point };

type FinderState = { at: Point; screen: Point; wire?: PendingWire; splice?: { link: EditableLink; carried: string; taken: string }; context?: string };
type MenuState = { x: number; y: number; title?: string; items: MenuItem[]; colours?: MenuColours };
type FrameDrag = { id: string; dx: number; dy: number; resize: boolean; nodes: Set<string>; frames: Set<string> };

let memoryClipboard = '';

export function NodeGraphCanvas<S>(props: NodeGraphCanvasProps<S>): React.ReactElement {
    const { label, graph, views, adapter, selection, selectedFrame, highlighted, canUndo, canRedo, onUndo, onRedo, undoKeys = 'canvas', toolbarExtra, notice, status } = props;
    const root = useRef<HTMLDivElement>(null);
    const wireCanvas = useRef<HTMLCanvasElement>(null);
    const alignButton = useRef<HTMLButtonElement>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [viewport, setViewport] = useState({ x: 40, y: 40, scale: 0.85 });
    const view = useRef(viewport);
    view.current = viewport;
    const gesture = useRef<Gesture | null>(null);
    const [drag, setDrag] = useState<{ ids: Set<string>; dx: number; dy: number } | null>(null);
    const [frameDrag, setFrameDrag] = useState<FrameDrag | null>(null);
    const [marquee, setMarquee] = useState<Rect | null>(null);
    const [pending, setPending] = useState<PendingWire | null>(null);
    const [panning, setPanning] = useState(false);
    const [hoverWire, setHoverWire] = useState<string | null>(null);
    const [spliceKey, setSpliceKey] = useState<string | null>(null);
    const [finder, setFinder] = useState<FinderState | null>(null);
    const [menu, setMenu] = useState<MenuState | null>(null);
    const [findOpen, setFindOpen] = useState(false);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [frameTitle, setFrameTitle] = useState<string | null>(null);
    const [openGroups, setOpenGroups] = useState<ReadonlyMap<string, ReadonlyMap<string, boolean>>>(new Map());
    const [refused, setRefused] = useState<string | null>(null);
    const refusedTimer = useRef<number | undefined>(undefined);
    const [heatOn, setHeatOn] = useState(() => readSetting('heat', false));
    const [snap, setSnap] = useState(() => readSetting('snap', false));
    const [showMap, setShowMap] = useState(() => readSetting('minimap', true));
    const pointer = useRef<Point>({ x: 0, y: 0 });
    const latest = useRef(props);
    latest.current = props;

    // ---- the graph as the canvas lays it out ----
    const nodesById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
    const linksByKey = useMemo(() => new Map(graph.links.map((link) => [linkKey(link), link])), [graph.links]);
    // Each node's wired pins, the same set object while they stay the same (cards compare it).
    const wiredCache = useRef(new Map<string, { key: string; set: ReadonlySet<string> }>());
    const wired = useMemo(() => {
        const lists = new Map<string, string[]>();
        const add = (id: string, value: string) => { const list = lists.get(id); if (list) list.push(value); else lists.set(id, [value]); };
        for (const link of graph.links) { add(link.from, `out:${link.fromPin}`); add(link.to, `in:${link.toPin}`); }
        const result = new Map<string, ReadonlySet<string>>();
        const empty: ReadonlySet<string> = new Set();
        for (const node of graph.nodes) {
            const list = lists.get(node.id);
            if (!list) { result.set(node.id, empty); continue; }
            const key = [...new Set(list)].sort().join(',');
            const cached = wiredCache.current.get(node.id);
            if (cached?.key === key) { result.set(node.id, cached.set); continue; }
            const set = new Set(list);
            wiredCache.current.set(node.id, { key, set });
            result.set(node.id, set);
        }
        return result;
    }, [graph.links, graph.nodes]);
    const layoutCache = useRef(new Map<string, { view: NodeView; collapsed: boolean; wired: ReadonlySet<string>; groups: ReadonlyMap<string, boolean> | undefined; layout: CardLayout }>());
    const layouts = useMemo(() => {
        const result = new Map<string, CardLayout>();
        for (const node of graph.nodes) {
            const nodeView = views.get(node.id);
            if (!nodeView) continue;
            const nodeWired = wired.get(node.id)!;
            const groups = openGroups.get(node.id);
            const cached = layoutCache.current.get(node.id);
            if (cached && cached.view === nodeView && cached.collapsed === Boolean(node.collapsed) && cached.wired === nodeWired && cached.groups === groups) {
                result.set(node.id, cached.layout);
                continue;
            }
            const layout = cardLayout(nodeView, node, nodeWired, groups);
            layoutCache.current.set(node.id, { view: nodeView, collapsed: Boolean(node.collapsed), wired: nodeWired, groups, layout });
            result.set(node.id, layout);
        }
        return result;
    }, [graph.nodes, openGroups, views, wired]);

    const offsetOf = useCallback((id: string): Point => {
        if (drag?.ids.has(id)) return { x: drag.dx, y: drag.dy };
        if (frameDrag && !frameDrag.resize && frameDrag.nodes.has(id)) return { x: frameDrag.dx, y: frameDrag.dy };
        return { x: 0, y: 0 };
    }, [drag, frameDrag]);

    const rectOf = useCallback((node: EditableNode<S>, moved = true): Rect | null => {
        const layout = layouts.get(node.id);
        if (!layout) return null;
        const offset = moved ? offsetOf(node.id) : { x: 0, y: 0 };
        return { x: node.x + offset.x, y: node.y + offset.y, width: layout.width, height: layout.height };
    }, [layouts, offsetOf]);

    const pinAt = useCallback((nodeId: string, side: 'in' | 'out', key: string): Point | null => {
        const node = nodesById.get(nodeId);
        const layout = layouts.get(nodeId);
        const at = side === 'in' ? layout?.inputs.get(key) : layout?.outputs.get(key);
        if (!node || !at) return null;
        const offset = offsetOf(nodeId);
        return { x: node.x + offset.x + at.x, y: node.y + offset.y + at.y };
    }, [layouts, nodesById, offsetOf]);

    const frameRect = useCallback((frame: EditableFrame): Rect => {
        if (!frameDrag) return frame;
        if (frameDrag.id === frame.id && frameDrag.resize) {
            return { x: frame.x, y: frame.y, width: Math.max(FRAME_MIN.width, frame.width + frameDrag.dx), height: Math.max(FRAME_MIN.height, frame.height + frameDrag.dy) };
        }
        if (!frameDrag.resize && (frameDrag.id === frame.id || frameDrag.frames.has(frame.id))) return { x: frame.x + frameDrag.dx, y: frame.y + frameDrag.dy, width: frame.width, height: frame.height };
        return frame;
    }, [frameDrag]);

    /** Every node's rect where it stands (not where a drag has it). */
    const nodeRects = useCallback((): Map<string, Rect> => {
        const rects = new Map<string, Rect>();
        for (const node of latest.current.graph.nodes) { const rect = rectOf(node, false); if (rect) rects.set(node.id, rect); }
        return rects;
    }, [rectOf]);

    /** The wires with both ends drawn, for finding the one under a point. */
    const wireEnds = useCallback((): Array<{ key: string; from: Point; to: Point }> => {
        const ends: Array<{ key: string; from: Point; to: Point }> = [];
        for (const link of latest.current.graph.links) {
            const from = pinAt(link.from, 'out', link.fromPin);
            const to = pinAt(link.to, 'in', link.toPin);
            if (from && to) ends.push({ key: linkKey(link), from, to });
        }
        return ends;
    }, [pinAt]);

    // ---- view ----
    useLayoutEffect(() => {
        const element = root.current;
        if (!element) return undefined;
        const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight }));
        observer.observe(element);
        setSize({ width: element.clientWidth, height: element.clientHeight });
        return () => observer.disconnect();
    }, []);

    const toGraph = useCallback((clientX: number, clientY: number): Point => {
        const box = root.current?.getBoundingClientRect();
        const v = view.current;
        return { x: (clientX - (box?.left ?? 0) - v.x) / v.scale, y: (clientY - (box?.top ?? 0) - v.y) / v.scale };
    }, []);

    const frameView = useCallback((rects: readonly Rect[]) => {
        const element = root.current;
        const bounds = boundsOf(rects);
        if (!element || !bounds) return;
        const width = element.clientWidth;
        const height = element.clientHeight;
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min((width - 120) / Math.max(1, bounds.width), (height - 120) / Math.max(1, bounds.height), 1.2)));
        setViewport({ scale, x: width / 2 - (bounds.x + bounds.width / 2) * scale, y: height / 2 - (bounds.y + bounds.height / 2) * scale });
    }, []);

    /** Frames the view on `ids`, or on the selected frame, or on everything. */
    const frameAll = useCallback((ids?: ReadonlySet<string>) => {
        const { graph: current, selectedFrame: frameId } = latest.current;
        const rects: Rect[] = [];
        if (ids?.size) {
            for (const node of current.nodes) if (ids.has(node.id)) { const rect = rectOf(node, false); if (rect) rects.push(rect); }
        } else {
            const frame = frameId ? current.frames.find((candidate) => candidate.id === frameId) : undefined;
            if (frame) rects.push(frame);
            else {
                for (const node of current.nodes) { const rect = rectOf(node, false); if (rect) rects.push(rect); }
                rects.push(...current.frames);
            }
        }
        frameView(rects);
    }, [frameView, rectOf]);

    // The graph is framed the first time it is shown; one whose nodes sit on top of one another (a
    // graph made elsewhere, crammed in a column) is offered a tidy.
    const framed = useRef(false);
    const [crowded, setCrowded] = useState(false);
    useLayoutEffect(() => {
        if (framed.current || !size.width || !layouts.size) return;
        framed.current = true;
        frameAll();
        const rects = [...nodeRects().values()];
        if (rects.length < 4 || rects.length > 400) return;
        let overlapping = 0;
        for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++) if (rectsOverlap(rects[i], rects[j])) { overlapping++; break; }
        }
        if (overlapping >= Math.max(2, rects.length * 0.3)) setCrowded(true);
    }, [frameAll, layouts.size, nodeRects, size.width]);

    const centreOn = useCallback((rect: Rect) => {
        const element = root.current;
        if (!element) return;
        setViewport((current) => {
            const scale = Math.max(current.scale, 0.7);
            return { scale, x: element.clientWidth / 2 - (rect.x + rect.width / 2) * scale, y: element.clientHeight / 2 - (rect.y + rect.height / 2) * scale };
        });
    }, []);

    useEffect(() => {
        const element = root.current;
        if (!element) return undefined;
        const onWheel = (event: WheelEvent) => {
            // The finder, find bar and overview map scroll (or ignore the wheel) themselves.
            if ((event.target as HTMLElement | null)?.closest?.('[data-overlay]')) return;
            event.preventDefault();
            const box = element.getBoundingClientRect();
            const mx = event.clientX - box.left;
            const my = event.clientY - box.top;
            setViewport((current) => {
                const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * Math.exp(-event.deltaY * 0.0015)));
                return { scale, x: mx - (mx - current.x) * (scale / current.scale), y: my - (my - current.y) * (scale / current.scale) };
            });
        };
        element.addEventListener('wheel', onWheel, { passive: false });
        return () => element.removeEventListener('wheel', onWheel);
    }, []);

    /** The part of the graph in view, in graph units. */
    const visible: Rect = { x: -viewport.x / viewport.scale, y: -viewport.y / viewport.scale, width: size.width / viewport.scale, height: size.height / viewport.scale };

    // ---- edits ----
    const commit = useCallback((next: EditableGraph<S>, coalesce?: string) => latest.current.onEdit(next, coalesce), []);
    const select = useCallback((ids: string[], frame: string | null = null) => latest.current.onSelect(ids, frame), []);

    const linkKind = useCallback((link: EditableLink): string => latest.current.views.get(link.from)?.outputs.find((pin) => pin.key === link.fromPin)?.kind ?? 'any', []);
    const takenKind = useCallback((link: EditableLink): string => latest.current.views.get(link.to)?.inputs.find((pin) => pin.key === link.toPin)?.kind ?? 'any', []);

    const wireAt = useCallback((point: Point): EditableLink | null => {
        const key = nearestWire(point, wireEnds(), WIRE_REACH / view.current.scale);
        return key ? linksByKey.get(key) ?? null : null;
    }, [linksByKey, wireEnds]);

    const changeLook = useCallback((ids: ReadonlySet<string>, look: NodeLook) => {
        if (ids.size) commit(setLook(latest.current.graph, ids, look));
    }, [commit]);

    /** The nodes an action on `nodeId` applies to: the selection when the node is in it, else the node alone. */
    const targetIds = useCallback((nodeId?: string): Set<string> => {
        const current = latest.current.selection;
        if (nodeId && !current.has(nodeId)) return new Set([nodeId]);
        return new Set(current);
    }, []);

    const removeSelection = useCallback(() => {
        const { graph: current, selection: selected, selectedFrame: frame, views: shown } = latest.current;
        const ids = new Set([...selected].filter((id) => shown.get(id)?.canDelete !== false));
        let next = ids.size ? removeNodes(current, ids) : current;
        if (frame) next = { ...next, frames: next.frames.filter((candidate) => candidate.id !== frame) };
        if (next !== current) { commit(next); select([]); }
    }, [commit, select]);

    const copySelection = useCallback((cut: boolean) => {
        const { graph: current, selection: selected, adapter: own, views: shown } = latest.current;
        if (!selected.size) return;
        const text = own.copy(current, selected);
        if (!text) return;
        memoryClipboard = text;
        void navigator.clipboard?.writeText(text).catch(() => undefined);
        if (cut) {
            const ids = new Set([...selected].filter((id) => shown.get(id)?.canDelete !== false));
            commit(removeNodes(current, ids));
            select([]);
        }
    }, [commit, select]);

    const pasteText = useCallback((text: string, at: Point) => {
        const { graph: current, adapter: own } = latest.current;
        const parsed = own.paste(text) ?? (text !== memoryClipboard ? own.paste(memoryClipboard) : null);
        if (!parsed?.nodes.length) return;
        const result = pasteNodes(current, parsed.nodes, parsed.links, at, own.newId);
        commit(result.graph);
        select(result.ids);
    }, [commit, select]);

    const paste = useCallback(() => {
        const at = { ...pointer.current };
        if (navigator.clipboard?.readText) void navigator.clipboard.readText().then((text) => pasteText(text || memoryClipboard, at), () => pasteText(memoryClipboard, at));
        else pasteText(memoryClipboard, at);
    }, [pasteText]);

    const duplicate = useCallback(() => {
        const { graph: current, selection: selected, adapter: own } = latest.current;
        if (!selected.size) return;
        const parsed = own.paste(own.copy(current, selected));
        if (!parsed?.nodes.length) return;
        const left = Math.min(...parsed.nodes.map((node) => node.x));
        const top = Math.min(...parsed.nodes.map((node) => node.y));
        const result = pasteNodes(current, parsed.nodes, parsed.links, { x: left + 40, y: top + 40 }, own.newId);
        commit(result.graph);
        select(result.ids);
    }, [commit, select]);

    const addFrame = useCallback(() => {
        const { graph: current, selection: selected, adapter: own } = latest.current;
        const rects: Rect[] = [];
        for (const id of selected) { const node = nodesById.get(id); const rect = node && rectOf(node, false); if (rect) rects.push(rect); }
        const blank: EditableFrame = { id: own.newId(), x: Math.round(pointer.current.x), y: Math.round(pointer.current.y), width: 360, height: 220, title: 'Frame', colour: FRAME_COLOURS[0] };
        const frame = rects.length ? fitFrame(blank, rects) : blank;
        commit({ ...current, frames: [...current.frames, frame] });
        select([], frame.id);
        setFrameTitle(frame.id);
    }, [commit, nodesById, rectOf, select]);

    const arrange = useCallback((how: AlignEdge | 'horizontal' | 'vertical') => {
        const { graph: current, selection: selected } = latest.current;
        const placed: Array<Rect & { id: string }> = [];
        for (const id of selected) { const node = nodesById.get(id); const rect = node && rectOf(node, false); if (rect) placed.push({ id, ...rect }); }
        const places = how === 'horizontal' || how === 'vertical' ? distributeRects(placed, how) : alignRects(placed, how);
        if (!places.size) return;
        const before = nodeRects();
        const next = placeNodes(current, places);
        const after = new Map(before);
        for (const [id, at] of places) { const rect = before.get(id); if (rect) after.set(id, { ...rect, x: Math.round(at.x), y: Math.round(at.y) }); }
        commit({ ...next, frames: refitFrames(next.frames, before, after, new Set(places.keys())) });
    }, [commit, nodeRects, nodesById, rectOf]);

    /** Lays out the selection (two nodes or more), or else the whole graph, in columns by depth. */
    const tidy = useCallback(() => {
        const { graph: current, selection: selected } = latest.current;
        const ids = selected.size > 1 ? selected : new Set(current.nodes.map((node) => node.id));
        const placed: Array<Rect & { id: string }> = [];
        for (const id of ids) { const node = nodesById.get(id); const rect = node && rectOf(node, false); if (rect) placed.push({ id, ...rect }); }
        const places = tidyLayout(placed, current.links.map((link) => ({ from: link.from, to: link.to })));
        if (!places.size) return;
        const before = nodeRects();
        const next = placeNodes(current, places);
        const after = new Map(before);
        for (const [id, at] of places) { const rect = before.get(id); if (rect) after.set(id, { ...rect, x: at.x, y: at.y }); }
        commit({ ...next, frames: refitFrames(next.frames, before, after, new Set(places.keys())) });
    }, [commit, nodeRects, nodesById, rectOf]);

    const toggleBypass = useCallback((ids: ReadonlySet<string>) => {
        const shown = latest.current.views;
        const allowed = new Set([...ids].filter((id) => shown.get(id)?.canBypass));
        if (!allowed.size) return;
        const on = [...allowed].some((id) => !nodesById.get(id)?.bypass);
        changeLook(allowed, { bypass: on || undefined });
    }, [changeLook, nodesById]);

    const toggleCollapsed = useCallback((ids: ReadonlySet<string>) => {
        const { views: shown, adapter: own } = latest.current;
        if (!own.looks) return;
        const allowed = new Set([...ids].filter((id) => shown.get(id) && shown.get(id)!.layout !== 'dot'));
        if (!allowed.size) return;
        const fold = [...allowed].some((id) => !nodesById.get(id)?.collapsed);
        changeLook(allowed, { collapsed: fold || undefined });
    }, [changeLook, nodesById]);

    // ---- the finder ----
    const openFinder = useCallback((clientX: number, clientY: number, extra: Partial<FinderState> = {}) => {
        const box = root.current!.getBoundingClientRect();
        setMenu(null);
        latest.current.adapter.onFinderOpen?.();
        setFinder({ at: toGraph(clientX, clientY), screen: { x: clientX - box.left, y: clientY - box.top }, ...extra });
    }, [toGraph]);

    /** The finder opened to splice a node into `link` at `at` (graph units; `clientX`/`clientY` place it). */
    const openSplice = useCallback((link: EditableLink, at: Point, clientX: number, clientY: number) => {
        const box = root.current!.getBoundingClientRect();
        setMenu(null);
        latest.current.adapter.onFinderOpen?.();
        setFinder({ at, screen: { x: clientX - box.left, y: clientY - box.top }, splice: { link, carried: linkKind(link), taken: takenKind(link) }, context: 'Splice a node into this wire' });
    }, [linkKind, takenKind]);

    const finderFilter = useMemo(() => {
        if (!finder) return undefined;
        const { wire, splice } = finder;
        if (splice) return (entry: FinderEntry) => Boolean(entry.inputs?.length && entry.outputs?.length) && fitsWire(entry, { side: 'out', kind: splice.carried }, adapter.match) && fitsWire(entry, { side: 'in', kind: splice.taken }, adapter.match);
        if (wire) return (entry: FinderEntry) => fitsWire(entry, { side: wire.side, kind: wire.kind }, adapter.match);
        return undefined;
    }, [adapter.match, finder]);

    const chooseEntry = useCallback((entry: FinderEntry) => {
        const state = finder;
        setFinder(null);
        root.current?.focus({ preventScroll: true });
        if (!state) return;
        const { graph: current, adapter: own } = latest.current;
        const asked = state.splice ? { x: state.at.x - 70, y: state.at.y - 40 } : state.wire?.side === 'in' ? { x: state.at.x - 180, y: state.at.y - 12 } : { x: state.at.x, y: state.at.y - 12 };
        const place = snap ? { x: snapToGrid(asked.x), y: snapToGrid(asked.y) } : asked;
        const made = own.createNode(entry.id, place);
        if (!made) return;
        // Into free space near where it was asked for, never on top of another node.
        const size = own.sizeOf?.(made) ?? (() => {
            const pins = own.pins(made);
            return { width: 180, height: HEADER + Math.max(pins.inputs.length, pins.outputs.length, 1) * ROW + 8 };
        })();
        const spot = freeSpot(place, size, [...nodeRects().values()], { step: snap ? GRID : 10 });
        const created: EditableNode<S> = spot.x === made.x && spot.y === made.y ? made : { ...made, x: Math.round(spot.x), y: Math.round(spot.y) };
        let next: EditableGraph<S> = { ...current, nodes: [...current.nodes, created] };
        const pins = own.pins(created);
        if (state.splice) next = spliceNode(next, state.splice.link, created, pins, { carried: state.splice.carried, taken: state.splice.taken }, own.match);
        else if (state.wire) {
            const wire = state.wire;
            if (wire.side === 'out') {
                const input = bestPin(pins.inputs, wire.kind, own.match, 'input');
                if (input) next = connect(next, { from: wire.nodeId, fromPin: wire.key, to: created.id, toPin: input }) ?? next;
            } else {
                const output = bestPin(pins.outputs, wire.kind, own.match, 'output');
                if (output) next = connect(next, { from: created.id, fromPin: output, to: wire.nodeId, toPin: wire.key }) ?? next;
            }
        }
        commit(next);
        select([created.id]);
    }, [commit, finder, nodeRects, select, snap]);

    // ---- menus ----
    const nodeMenu = useCallback((nodeId: string, x: number, y: number) => {
        const { views: shown, adapter: own, selection: selected } = latest.current;
        const node = nodesById.get(nodeId);
        const nodeView = shown.get(nodeId);
        if (!node || !nodeView) return;
        if (!selected.has(nodeId)) select([nodeId]);
        const ids = targetIds(nodeId);
        const many = ids.size > 1;
        const card = nodeView.layout !== 'dot';
        const items: MenuItem[] = [];
        if (!many && card && own.looks) items.push({ label: 'Rename', icon: <PencilIcon size={12} />, shortcut: 'F2', section: 'look', onSelect: () => setRenaming(nodeId) });
        if (card && own.looks) items.push({ label: node.collapsed ? 'Unfold' : 'Fold to its header', icon: <ChevronDownIcon size={12} />, shortcut: 'H', section: 'look', onSelect: () => toggleCollapsed(ids) });
        if (nodeView.canBypass) items.push({ label: node.bypass ? 'Stop bypassing' : 'Bypass: pass its main input through', icon: <PowerIcon size={12} />, shortcut: 'B', section: 'look', onSelect: () => toggleBypass(ids) });
        if (!many && nodeView.canOpen && own.onOpenGraph) items.push({ label: nodeView.openLabel ?? 'Open the graph inside', icon: <LayersIcon size={12} />, section: 'open', onSelect: () => own.onOpenGraph?.(nodeId) });
        if (!many) for (const item of own.menuItems?.(nodeId) ?? []) items.push({ ...item, section: item.section ?? 'open' });
        const copyable = [...ids].some((id) => shown.get(id)?.canDelete !== false);
        items.push({ label: many ? `Duplicate ${ids.size} nodes` : 'Duplicate', icon: <CopyIcon size={12} />, shortcut: 'Ctrl+D', section: 'edit', disabled: !copyable, hint: 'The output cannot be copied.', onSelect: duplicate });
        items.push({ label: 'Frame round the selection', icon: <CommentAddIcon size={12} />, shortcut: 'C', section: 'edit', onSelect: addFrame });
        if (many) items.push({ label: `Tidy ${ids.size} nodes into columns`, icon: <FlowIcon size={12} />, section: 'edit', onSelect: tidy });
        items.push({ label: many ? `Delete ${ids.size} nodes` : 'Delete', icon: <TrashIcon size={12} />, shortcut: 'Del', section: 'delete', danger: true, disabled: !copyable, hint: 'The output cannot be deleted.', onSelect: removeSelection });
        setMenu({
            x, y, title: many ? `${ids.size} nodes` : nodeView.title, items,
            colours: card && own.looks ? { label: 'Header colour', colours: NODE_COLOURS, names: NODE_COLOUR_NAMES, current: many ? undefined : node.color, onPick: (colour) => changeLook(ids, { color: colour }) } : undefined,
        });
    }, [addFrame, changeLook, duplicate, nodesById, removeSelection, select, targetIds, tidy, toggleBypass, toggleCollapsed]);

    const wireMenu = useCallback((link: EditableLink, at: Point, x: number, y: number) => {
        const items: MenuItem[] = [
            { label: 'Insert a node here…', icon: <PlusIcon size={12} />, section: 'add', onSelect: () => openSplice(link, at, x, y) },
            {
                label: 'Add a reroute point', icon: <RouteIcon size={12} />, shortcut: 'Double-click', section: 'add',
                onSelect: () => { const reroute = latest.current.adapter.createReroute({ x: at.x - 8, y: at.y - 8 }); if (reroute) commit(insertReroute(latest.current.graph, link, reroute)); },
            },
            { label: 'Cut this wire', icon: <ScissorsIcon size={12} />, shortcut: 'Alt+click', section: 'cut', danger: true, onSelect: () => commit(disconnect(latest.current.graph, link)) },
        ];
        setMenu({ x, y, title: 'Wire', items });
    }, [commit, openSplice]);

    const frameMenu = useCallback((frameId: string, x: number, y: number) => {
        const frame = latest.current.graph.frames.find((candidate) => candidate.id === frameId);
        if (!frame) return;
        select([], frameId);
        const update = (change: (candidate: EditableFrame) => EditableFrame) => {
            const current = latest.current.graph;
            commit({ ...current, frames: current.frames.map((candidate) => (candidate.id === frameId ? change(candidate) : candidate)) });
        };
        const items: MenuItem[] = [
            { label: 'Rename', icon: <PencilIcon size={12} />, shortcut: 'F2', section: 'look', onSelect: () => setFrameTitle(frameId) },
            {
                label: 'Fit round its nodes', icon: <FrameIcon size={12} />, section: 'look',
                onSelect: () => {
                    const rects = nodeRects();
                    const members = frameMembers(frame, rects, latest.current.graph.frames).map((id) => rects.get(id)!);
                    update((candidate) => fitFrame(candidate, members));
                },
            },
            { label: 'Select its nodes', icon: <LayoutIcon size={12} />, section: 'look', onSelect: () => select(frameContents(frame, nodeRects(), latest.current.graph.frames).nodes) },
            { label: 'Delete the frame (keeps its nodes)', icon: <TrashIcon size={12} />, shortcut: 'Del', section: 'delete', danger: true, onSelect: () => { commit({ ...latest.current.graph, frames: latest.current.graph.frames.filter((candidate) => candidate.id !== frameId) }); select([]); } },
        ];
        setMenu({
            x, y, title: frame.title || 'Frame', items,
            colours: { label: 'Colour', colours: FRAME_COLOURS, names: FRAME_COLOUR_NAMES, current: frame.colour, onPick: (colour) => update((candidate) => ({ ...candidate, colour: colour ?? FRAME_COLOURS[0] })) },
        });
    }, [commit, nodeRects, select]);

    const alignMenu = useCallback(() => {
        const button = alignButton.current?.getBoundingClientRect();
        const count = latest.current.selection.size;
        const items: MenuItem[] = (['left', 'centre', 'right', 'top', 'middle', 'bottom'] as AlignEdge[]).map((edge, index) => ({
            label: `Line up ${ALIGN_LABELS[edge].toLowerCase()}`, section: index < 3 ? 'across' : 'down', disabled: count < 2, hint: 'Select two nodes or more.', onSelect: () => arrange(edge),
        }));
        items.push({ label: 'Space evenly across', section: 'spread', disabled: count < 3, hint: 'Select three nodes or more.', onSelect: () => arrange('horizontal') });
        items.push({ label: 'Space evenly down', section: 'spread', disabled: count < 3, hint: 'Select three nodes or more.', onSelect: () => arrange('vertical') });
        setMenu({ x: button?.left ?? 0, y: (button?.bottom ?? 0) + 4, title: count < 2 ? 'Select nodes to line them up' : `Line up ${count} nodes`, items });
    }, [arrange]);

    const colourMenu = useCallback((anchor: DOMRect) => {
        const ids = new Set(latest.current.selection);
        setMenu({ x: anchor.left, y: anchor.bottom + 4, title: ids.size === 1 ? 'Colour the selected node' : `Colour ${ids.size} nodes`, items: [], colours: { label: 'Header colour', colours: NODE_COLOURS, names: NODE_COLOUR_NAMES, onPick: (colour) => changeLook(ids, { color: colour }) } });
    }, [changeLook]);

    /** Says for a while, in the line at the bottom, why something was not done. */
    const refuse = useCallback((message: string) => {
        setRefused(message);
        window.clearTimeout(refusedTimer.current);
        refusedTimer.current = window.setTimeout(() => setRefused(null), 4000);
    }, []);
    useEffect(() => () => window.clearTimeout(refusedTimer.current), []);

    // ---- pointer ----
    const finishWire = (wire: PendingWire, target: HTMLElement | null, clientX: number, clientY: number) => {
        const { graph: current, views: shown, adapter: own } = latest.current;
        const pin = target?.closest('[data-pin]') as HTMLElement | null;
        if (pin && pin.dataset.pin !== wire.side && pin.dataset.node !== wire.nodeId) {
            const other = pin.dataset.pin === 'in' ? shown.get(pin.dataset.node!)?.inputs : shown.get(pin.dataset.node!)?.outputs;
            const otherKind = other?.find((candidate) => candidate.key === pin.dataset.key)?.kind ?? 'any';
            const from = wire.side === 'out' ? wire.kind : otherKind;
            const to = wire.side === 'out' ? otherKind : wire.kind;
            if (own.match(from, to) === 0) {
                refuse(own.refusal?.(from, to) ?? 'These two pins do not fit together.');
                return;
            }
            const link = wire.side === 'out'
                ? { from: wire.nodeId, fromPin: wire.key, to: pin.dataset.node!, toPin: pin.dataset.key! }
                : { from: pin.dataset.node!, fromPin: pin.dataset.key!, to: wire.nodeId, toPin: wire.key };
            const next = connect(current, link);
            if (next) commit(next);
            return;
        }
        const nodeElement = target?.closest('[data-node]') as HTMLElement | null;
        if (nodeElement && nodeElement.dataset.node !== wire.nodeId) {
            // Dropped on a node: its pin that suits the wire best.
            const other = shown.get(nodeElement.dataset.node!);
            const key = other && (wire.side === 'out' ? bestPin(other.inputs, wire.kind, own.match, 'input') : bestPin(other.outputs, wire.kind, own.match, 'output'));
            if (key) {
                const link = wire.side === 'out' ? { from: wire.nodeId, fromPin: wire.key, to: nodeElement.dataset.node!, toPin: key } : { from: nodeElement.dataset.node!, fromPin: key, to: wire.nodeId, toPin: wire.key };
                const next = connect(current, link);
                if (next) commit(next);
            } else refuse(`${other?.title ?? 'That node'} has no pin this wire fits.`);
            return;
        }
        if (!target || !root.current?.contains(target) || target.closest('[data-overlay]')) return;
        const source = shown.get(wire.nodeId);
        const pinLabel = (wire.side === 'out' ? source?.outputs : source?.inputs)?.find((candidate) => candidate.key === wire.key)?.label;
        openFinder(clientX, clientY, { wire, context: `${wire.side === 'out' ? 'Wired from' : 'Wired into'} ${source?.title ?? 'a node'}${pinLabel ? ` · ${pinLabel}` : ''}` });
    };

    const onPointerDown = (event: React.PointerEvent) => {
        const target = event.target as HTMLElement;
        if (target.closest('[data-node-action], [data-overlay]') || inField(target)) return;
        setMenu(null);
        setFinder(null);
        root.current?.focus({ preventScroll: true });
        const at = toGraph(event.clientX, event.clientY);
        pointer.current = at;
        const nodeElement = target.closest('[data-node]') as HTMLElement | null;
        const frameTitleElement = target.closest('[data-frame-title]') as HTMLElement | null;
        const frameResize = target.closest('[data-frame-resize]') as HTMLElement | null;
        if (event.button === 1 || event.button === 2) {
            root.current?.setPointerCapture(event.pointerId);
            const wire = nodeElement || frameTitleElement ? null : wireAt(at);
            gesture.current = {
                kind: 'pan', button: event.button, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false,
                target: { node: nodeElement?.dataset.node, frame: frameTitleElement?.dataset.frameTitle, wire: wire ?? undefined },
            };
            return;
        }
        if (event.button !== 0) return;
        root.current?.setPointerCapture(event.pointerId);
        const { graph: current, views: shown, selection: selected, selectedFrame: frameSelected } = latest.current;
        const pin = target.closest('[data-pin]') as HTMLElement | null;
        if (pin) {
            const nodeId = pin.dataset.node!;
            const side = pin.dataset.pin as 'in' | 'out';
            const key = pin.dataset.key!;
            if (side === 'in') {
                const existing = current.links.find((link) => link.to === nodeId && link.toPin === key);
                if (existing) {
                    // Dragging a wire off an input picks it up from its other end.
                    commit(disconnect(current, existing));
                    const wire: PendingWire = { side: 'out', nodeId: existing.from, key: existing.fromPin, kind: linkKind(existing), to: at };
                    gesture.current = { kind: 'wire', wire };
                    setPending(wire);
                    return;
                }
            }
            const pinView = (side === 'in' ? shown.get(nodeId)?.inputs : shown.get(nodeId)?.outputs)?.find((candidate) => candidate.key === key);
            const wire: PendingWire = { side, nodeId, key, kind: pinView?.kind ?? 'any', to: at };
            gesture.current = { kind: 'wire', wire };
            setPending(wire);
            return;
        }
        if (frameResize || frameTitleElement) {
            const id = (frameResize?.dataset.frameResize ?? frameTitleElement?.dataset.frameTitle)!;
            const frame = current.frames.find((candidate) => candidate.id === id);
            if (!frame) return;
            if (frameSelected !== id || selected.size) select([], id);
            const contents: { nodes: string[]; frames: string[] } = frameResize ? { nodes: [], frames: [] } : frameContents(frame, nodeRects(), current.frames);
            gesture.current = { kind: 'frame', id, start: at, nodes: new Set(contents.nodes), frames: new Set(contents.frames), resize: Boolean(frameResize), moved: false, offset: { x: 0, y: 0 } };
            return;
        }
        if (nodeElement) {
            const id = nodeElement.dataset.node!;
            const modifier = event.shiftKey || event.ctrlKey || event.metaKey;
            let ids: Set<string>;
            if (modifier) {
                ids = new Set(selected);
                if (ids.has(id)) ids.delete(id); else ids.add(id);
                select([...ids]);
                if (!ids.has(id)) return;
            } else if (selected.has(id)) {
                ids = new Set(selected);
                if (frameSelected) select([...ids]);
            } else {
                ids = new Set([id]);
                select([id]);
            }
            const node = nodesById.get(id)!;
            // A lone node with no wires can be dropped onto a wire to splice it in.
            const lonely = ids.size === 1 && !current.links.some((link) => link.from === id || link.to === id) && shown.get(id)?.layout !== 'dot';
            gesture.current = {
                kind: 'move', start: at, ids, anchor: { x: node.x, y: node.y }, moved: false, offset: { x: 0, y: 0 }, spliceable: lonely ? id : null, splice: null,
                // A click (no drag) on one node of a selection selects it alone.
                narrowTo: !modifier && selected.size > 1 && selected.has(id) ? id : null,
            };
            return;
        }
        const wire = wireAt(at);
        if (wire && event.altKey) {
            commit(disconnect(current, wire));
            return;
        }
        const box = { x: at.x, y: at.y, width: 0, height: 0 };
        gesture.current = { kind: 'marquee', start: at, additive: event.shiftKey || event.ctrlKey || event.metaKey, box };
        setMarquee(box);
    };

    const onPointerMove = (event: React.PointerEvent) => {
        const at = toGraph(event.clientX, event.clientY);
        pointer.current = at;
        const current = gesture.current;
        if (!current) {
            if (event.buttons === 0 && !finder && !menu) {
                const target = event.target as HTMLElement;
                const over = target.closest('[data-node], [data-frame-title], [data-overlay]') ? null : wireAt(at);
                const key = over ? linkKey(over) : null;
                if (key !== hoverWire) setHoverWire(key);
            }
            return;
        }
        if (current.kind === 'pan') {
            const dx = event.clientX - current.lastX;
            const dy = event.clientY - current.lastY;
            current.lastX = event.clientX;
            current.lastY = event.clientY;
            if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > DRAG_THRESHOLD) {
                current.moved = true;
                setPanning(true);
            }
            if (current.moved) setViewport((value) => ({ ...value, x: value.x + dx, y: value.y + dy }));
        } else if (current.kind === 'move') {
            let dx = at.x - current.start.x;
            let dy = at.y - current.start.y;
            if (!current.moved && Math.hypot(dx, dy) * view.current.scale < DRAG_THRESHOLD) return;
            current.moved = true;
            if (snap) {
                dx = snapToGrid(current.anchor.x + dx) - current.anchor.x;
                dy = snapToGrid(current.anchor.y + dy) - current.anchor.y;
            }
            current.offset = { x: dx, y: dy };
            setDrag({ ids: current.ids, dx, dy });
            if (current.spliceable) {
                const node = nodesById.get(current.spliceable);
                const layout = layouts.get(current.spliceable);
                if (node && layout) {
                    const centre = { x: node.x + dx + layout.width / 2, y: node.y + dy + layout.height / 2 };
                    const key = nearestWire(centre, wireEnds(), Math.max(16, layout.height / 2));
                    current.splice = key;
                    if (key !== spliceKey) setSpliceKey(key);
                }
            }
        } else if (current.kind === 'marquee') {
            current.box = rectFrom(current.start, at);
            setMarquee(current.box);
        } else if (current.kind === 'wire') {
            const wire = { ...current.wire, to: at };
            current.wire = wire;
            setPending(wire);
        } else if (current.kind === 'frame') {
            let dx = at.x - current.start.x;
            let dy = at.y - current.start.y;
            if (!current.moved && Math.hypot(dx, dy) * view.current.scale < DRAG_THRESHOLD) return;
            current.moved = true;
            if (snap && !current.resize) { dx = snapToGrid(dx); dy = snapToGrid(dy); }
            current.offset = { x: dx, y: dy };
            setFrameDrag({ id: current.id, dx, dy, resize: current.resize, nodes: current.nodes, frames: current.frames });
        }
    };

    const endGesture = () => {
        gesture.current = null;
        setDrag(null);
        setFrameDrag(null);
        setMarquee(null);
        setPending(null);
        setSpliceKey(null);
        setPanning(false);
    };

    const onPointerUp = (event: React.PointerEvent) => {
        if (root.current?.hasPointerCapture(event.pointerId)) root.current.releasePointerCapture(event.pointerId);
        const current = gesture.current;
        endGesture();
        if (!current) return;
        const { graph: now, adapter: own } = latest.current;
        if (current.kind === 'pan') {
            if (current.moved || current.button !== 2) return;
            const { target } = current;
            if (target.node) nodeMenu(target.node, event.clientX, event.clientY);
            else if (target.frame) frameMenu(target.frame, event.clientX, event.clientY);
            else if (target.wire) wireMenu(target.wire, toGraph(event.clientX, event.clientY), event.clientX, event.clientY);
            else openFinder(event.clientX, event.clientY);
        } else if (current.kind === 'move') {
            if (!current.moved) {
                if (current.narrowTo) select([current.narrowTo]);
                return;
            }
            const { x: dx, y: dy } = current.offset;
            const before = nodeRects();
            const places = new Map<string, Point>();
            for (const id of current.ids) { const node = nodesById.get(id); if (node) places.set(id, { x: node.x + dx, y: node.y + dy }); }
            let next = placeNodes(now, places);
            const after = new Map(before);
            for (const [id, at] of places) { const rect = before.get(id); if (rect) after.set(id, { ...rect, x: Math.round(at.x), y: Math.round(at.y) }); }
            next = { ...next, frames: refitFrames(next.frames, before, after, current.ids) };
            const link = current.splice ? linksByKey.get(current.splice) : undefined;
            const moved = current.spliceable ? next.nodes.find((node) => node.id === current.spliceable) : undefined;
            if (link && moved) next = spliceNode(next, link, moved, own.pins(moved), { carried: linkKind(link), taken: takenKind(link) }, own.match);
            commit(next);
        } else if (current.kind === 'marquee') {
            const box = current.box;
            if (box.width * view.current.scale < 3 && box.height * view.current.scale < 3) {
                if (!current.additive) select([]);
                return;
            }
            const inside = now.nodes.filter((node) => { const rect = rectOf(node, false); return rect ? rectsOverlap(rect, box) : false; }).map((node) => node.id);
            select(current.additive ? [...new Set([...latest.current.selection, ...inside])] : inside);
        } else if (current.kind === 'wire') {
            finishWire(current.wire, document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null, event.clientX, event.clientY);
        } else if (current.kind === 'frame') {
            if (!current.moved) return;
            const { x: dx, y: dy } = current.offset;
            const frames = now.frames.map((frame) => {
                if (current.resize) {
                    return frame.id === current.id ? { ...frame, width: Math.round(Math.max(FRAME_MIN.width, frame.width + dx)), height: Math.round(Math.max(FRAME_MIN.height, frame.height + dy)) } : frame;
                }
                return frame.id === current.id || current.frames.has(frame.id) ? { ...frame, x: Math.round(frame.x + dx), y: Math.round(frame.y + dy) } : frame;
            });
            const places = new Map<string, Point>();
            if (!current.resize) for (const id of current.nodes) { const node = nodesById.get(id); if (node) places.set(id, { x: node.x + dx, y: node.y + dy }); }
            commit({ ...placeNodes(now, places), frames });
        }
    };

    const onDoubleClick = (event: React.MouseEvent) => {
        // The canvas holds the pointer while a button is down, so the event lands on the canvas itself:
        // what is really under the pointer is looked up.
        const target = (document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null) ?? (event.target as HTMLElement);
        if (!root.current?.contains(target) || target.closest('[data-node-action], [data-overlay]') || inField(target)) return;
        const nodeElement = target.closest('[data-node]') as HTMLElement | null;
        if (nodeElement) { latest.current.adapter.onOpenNode?.(nodeElement.dataset.node!); return; }
        const title = target.closest('[data-frame-title]') as HTMLElement | null;
        if (title) { setFrameTitle(title.dataset.frameTitle!); return; }
        const at = toGraph(event.clientX, event.clientY);
        const wire = wireAt(at);
        if (wire) {
            const reroute = latest.current.adapter.createReroute({ x: at.x - 8, y: at.y - 8 });
            if (reroute) commit(insertReroute(latest.current.graph, wire, reroute));
            return;
        }
        openFinder(event.clientX, event.clientY);
    };

    // ---- keys ----
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (inField(event.target)) return;
            const host = root.current;
            if (!host || (!host.matches(':hover') && !host.contains(document.activeElement))) return;
            const mod = event.ctrlKey || event.metaKey;
            const key = event.key.toLowerCase();
            const { selection: selected, selectedFrame: frameSelected, graph: current, adapter: own } = latest.current;
            if (mod && key === 'f') { event.preventDefault(); setFindOpen(true); return; }
            if (undoKeys === 'canvas' && mod && (key === 'z' || key === 'y')) {
                event.preventDefault();
                if (key === 'y' || event.shiftKey) latest.current.onRedo(); else latest.current.onUndo();
                return;
            }
            if (mod && key === 'a') { event.preventDefault(); select(current.nodes.map((node) => node.id)); return; }
            if (mod && (key === 'c' || key === 'x')) { if (selected.size) { event.preventDefault(); copySelection(key === 'x'); } return; }
            if (mod && key === 'v') { event.preventDefault(); paste(); return; }
            if (mod && key === 'd') { if (selected.size) { event.preventDefault(); duplicate(); } return; }
            if (key === 'contextmenu' || (event.shiftKey && key === 'f10')) {
                // The menu of the selected node (or frame), from the keyboard.
                event.preventDefault();
                const box = host.getBoundingClientRect();
                const v = view.current;
                const id = [...selected][0];
                const node = id ? nodesById.get(id) : undefined;
                const frame = frameSelected ? current.frames.find((candidate) => candidate.id === frameSelected) : undefined;
                if (node) nodeMenu(node.id, box.left + (node.x + 16) * v.scale + v.x, box.top + (node.y + 16) * v.scale + v.y);
                else if (frame) frameMenu(frame.id, box.left + (frame.x + 16) * v.scale + v.x, box.top + (frame.y + 13) * v.scale + v.y);
                return;
            }
            if (mod || event.altKey) return;
            if (key === 'delete' || key === 'backspace') { if (selected.size || frameSelected) { event.preventDefault(); removeSelection(); } return; }
            if (key === 'escape') { setMenu(null); setFinder(null); setFindOpen(false); select([]); return; }
            if (key === 'f2') {
                event.preventDefault();
                if (selected.size === 1 && own.looks) setRenaming([...selected][0]);
                else if (!selected.size && frameSelected) setFrameTitle(frameSelected);
                return;
            }
            if (key === 'f') { event.preventDefault(); frameAll(selected.size ? selected : undefined); return; }
            if (key === 'c') { event.preventDefault(); addFrame(); return; }
            if (key === 'b') { event.preventDefault(); toggleBypass(selected); return; }
            if (key === 'h') { event.preventDefault(); toggleCollapsed(selected); return; }
            if (key === ' ') {
                event.preventDefault();
                const box = host.getBoundingClientRect();
                const v = view.current;
                const at = pointer.current;
                const clientX = box.left + at.x * v.scale + v.x;
                const clientY = box.top + at.y * v.scale + v.y;
                const wire = host.matches(':hover') ? wireAt(at) : null;
                if (wire) openSplice(wire, at, clientX, clientY);
                else openFinder(clientX, clientY);
                return;
            }
            if (key.startsWith('arrow') && selected.size) {
                event.preventDefault();
                const step = event.shiftKey || snap ? 20 : 1;
                const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0;
                const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0;
                const places = new Map<string, Point>();
                for (const node of current.nodes) if (selected.has(node.id)) places.set(node.id, { x: node.x + dx, y: node.y + dy });
                commit(placeNodes(current, places), `nudge:${[...selected].join(',')}`);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [addFrame, commit, copySelection, duplicate, frameAll, frameMenu, nodeMenu, nodesById, openFinder, openSplice, paste, removeSelection, select, snap, toggleBypass, toggleCollapsed, undoKeys, wireAt]);

    // Undo and redo anywhere in the screen the canvas sits in, but not while typing in a box.
    useEffect(() => {
        if (undoKeys !== 'workspace') return undefined;
        const onKey = (event: KeyboardEvent) => {
            const mod = event.ctrlKey || event.metaKey;
            const key = event.key.toLowerCase();
            if (!mod || event.altKey || (key !== 'z' && key !== 'y') || typesText(event.target)) return;
            const host = root.current;
            // A canvas not shown (a graph opened inside it is) leaves the keys to the one shown.
            if (!host || host.offsetParent === null) return;
            const scope = (host.parentElement?.closest('[data-workspace]') as HTMLElement | null) ?? host.parentElement;
            if (!scope || (!scope.matches(':hover') && !scope.contains(document.activeElement))) return;
            event.preventDefault();
            if (key === 'y' || event.shiftKey) latest.current.onRedo(); else latest.current.onUndo();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [undoKeys]);

    // ---- wires, all in one layer ----
    useEffect(() => {
        const element = wireCanvas.current;
        const context = element?.getContext('2d');
        if (!element || !context || !size.width) return;
        const ratio = window.devicePixelRatio || 1;
        if (element.width !== Math.round(size.width * ratio) || element.height !== Math.round(size.height * ratio)) {
            element.width = Math.round(size.width * ratio);
            element.height = Math.round(size.height * ratio);
        }
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, size.width, size.height);
        context.setTransform(ratio * viewport.scale, 0, 0, ratio * viewport.scale, ratio * viewport.x, ratio * viewport.y);
        const reach = 80 / viewport.scale;
        const area = { x: -viewport.x / viewport.scale - reach, y: -viewport.y / viewport.scale - reach, width: size.width / viewport.scale + reach * 2, height: size.height / viewport.scale + reach * 2 };
        const line = (from: Point, to: Point) => {
            const [a, b] = wireControls(from, to);
            context.beginPath();
            context.moveTo(from.x, from.y);
            context.bezierCurveTo(a.x, a.y, b.x, b.y, to.x, to.y);
            context.stroke();
        };
        context.lineCap = 'round';
        for (const link of graph.links) {
            const from = pinAt(link.from, 'out', link.fromPin);
            const to = pinAt(link.to, 'in', link.toPin);
            if (!from || !to || !rectsOverlap(wireBounds(from, to), area)) continue;
            const key = linkKey(link);
            const near = selection.has(link.from) || selection.has(link.to);
            const hot = key === hoverWire || key === spliceKey;
            const style = adapter.kinds[linkKind(link)];
            context.globalAlpha = views.get(link.to)?.unused && !near && !hot ? 0.4 : near || hot ? 1 : 0.78;
            context.strokeStyle = key === spliceKey ? 'rgb(240 138 60)' : style?.colour ?? '#a3a3a3';
            context.lineWidth = ((hot ? 3.2 : near ? 2.4 : 1.7) * (style?.wide ? 1.7 : 1)) / viewport.scale;
            if (key === spliceKey) context.setLineDash([8 / viewport.scale, 5 / viewport.scale]);
            line(from, to);
            context.setLineDash([]);
        }
        // Named links: a faint line between the two ends while one of them is selected.
        for (const ghost of adapter.ghostLinks ?? []) {
            if (!selection.has(ghost.from) && !selection.has(ghost.to)) continue;
            const a = nodesById.get(ghost.from);
            const b = nodesById.get(ghost.to);
            const la = layouts.get(ghost.from);
            const lb = layouts.get(ghost.to);
            if (!a || !b || !la || !lb) continue;
            const oa = offsetOf(ghost.from);
            const ob = offsetOf(ghost.to);
            context.globalAlpha = 0.7;
            context.strokeStyle = 'rgb(240 138 60)';
            context.lineWidth = 1.5 / viewport.scale;
            context.setLineDash([3 / viewport.scale, 5 / viewport.scale]);
            line({ x: a.x + oa.x + la.width, y: a.y + oa.y + la.height / 2 }, { x: b.x + ob.x, y: b.y + ob.y + lb.height / 2 });
            context.setLineDash([]);
        }
        if (pending) {
            const pin = pinAt(pending.nodeId, pending.side, pending.key);
            if (pin) {
                context.globalAlpha = 1;
                context.strokeStyle = adapter.kinds[pending.kind]?.colour ?? '#e2e3e5';
                context.lineWidth = 2 / viewport.scale;
                context.setLineDash([6 / viewport.scale, 4 / viewport.scale]);
                if (pending.side === 'out') line(pin, pending.to); else line(pending.to, pin);
                context.setLineDash([]);
            }
        }
        context.globalAlpha = 1;
    }, [adapter.ghostLinks, adapter.kinds, graph.links, hoverWire, layouts, linkKind, nodesById, offsetOf, pending, pinAt, selection, size, spliceKey, viewport, views]);

    // ---- the cost map ----
    const heats = useMemo(() => {
        if (!heatOn || !adapter.cost) return null;
        void views;
        const costs = new Map<string, { value: number; label: string }>();
        let most = 0;
        for (const node of graph.nodes) {
            const found = adapter.cost(node.id);
            if (!found) continue;
            costs.set(node.id, found);
            most = Math.max(most, found.value);
        }
        const result = new Map<string, { heat: number; label: string }>();
        for (const [id, found] of costs) result.set(id, { heat: most > 0 ? Math.round(Math.sqrt(found.value / most) * 100) / 100 : 0, label: found.label });
        return result;
    }, [adapter, graph.nodes, heatOn, views]);

    // ---- what is drawn ----
    const actions = useMemo<CardActions>(() => ({
        rename: (nodeId, name) => {
            setRenaming(null);
            if (name === null) return;
            const current = latest.current.graph;
            const node = current.nodes.find((candidate) => candidate.id === nodeId);
            const trimmed = name.trim().slice(0, 64);
            if (node && (node.name ?? '') !== trimmed) commit(setLook(current, new Set([nodeId]), { name: trimmed || undefined }));
        },
        toggleGroup: (nodeId, group) => setOpenGroups((current) => {
            const nodeView = latest.current.views.get(nodeId);
            const groups = new Map<string, boolean>(current.get(nodeId) ?? []);
            const open = groups.get(group) ?? (nodeView ? groupOpenByDefault(nodeView, group) : false);
            groups.set(group, !open);
            return new Map(current).set(nodeId, groups);
        }),
        toggleCollapsed: (nodeId) => toggleCollapsed(new Set([nodeId])),
        openGraph: (nodeId) => latest.current.adapter.onOpenGraph?.(nodeId),
    }), [commit, toggleCollapsed]);

    const detail: 'full' | 'chip' = viewport.scale < CHIP_SCALE ? 'chip' : 'full';
    const margin = 120 / viewport.scale;
    const inView = { x: visible.x - margin, y: visible.y - margin, width: visible.width + margin * 2, height: visible.height + margin * 2 };
    const shownNodes = graph.nodes.filter((node) => {
        if (node.id === renaming || drag?.ids.has(node.id)) return true;
        const rect = rectOf(node);
        return rect ? rectsOverlap(rect, inView) : false;
    });
    const shownFrames = graph.frames.filter((frame) => frame.id === frameTitle || rectsOverlap(frameRect(frame), inView));

    const findTargets = useMemo<FindTarget[]>(() => {
        if (!findOpen) return [];
        const targets: FindTarget[] = [];
        for (const node of graph.nodes) {
            const nodeView = views.get(node.id);
            if (!nodeView || nodeView.layout === 'dot') continue;
            targets.push({ id: node.id, kind: 'node', title: nodeView.title, detail: nodeView.searchText ?? '', words: [node.name ?? '', node.type, nodeView.searchText ?? ''].filter(Boolean) });
        }
        for (const frame of graph.frames) targets.push({ id: frame.id, kind: 'frame', title: frame.title || 'Frame', detail: 'Frame', words: ['frame', 'comment'] });
        return targets;
    }, [findOpen, graph.frames, graph.nodes, views]);

    const goTo = useCallback((target: FindTarget) => {
        if (target.kind === 'frame') {
            const frame = latest.current.graph.frames.find((candidate) => candidate.id === target.id);
            if (frame) { centreOn(frame); select([], frame.id); }
            return;
        }
        const node = nodesById.get(target.id);
        const rect = node ? rectOf(node, false) : null;
        if (rect) { centreOn(rect); select([target.id]); }
    }, [centreOn, nodesById, rectOf, select]);

    const mapNodes = useMemo(() => {
        if (!showMap) return [];
        const items: Array<{ rect: Rect; colour: string; selected: boolean }> = [];
        for (const node of graph.nodes) {
            const layout = layouts.get(node.id);
            if (layout) items.push({ rect: { x: node.x, y: node.y, width: layout.width, height: layout.height }, colour: node.color ?? views.get(node.id)?.tint ?? '#52525b', selected: selection.has(node.id) });
        }
        return items;
    }, [graph.nodes, layouts, selection, showMap, views]);
    const mapFrames = useMemo(() => (showMap ? graph.frames.map((frame) => ({ rect: frame as Rect, colour: frame.colour })) : []), [graph.frames, showMap]);

    const stopOverlay = { onPointerDown: (event: React.PointerEvent) => event.stopPropagation(), onDoubleClick: (event: React.MouseEvent) => event.stopPropagation() };

    return (
        <div
            ref={root}
            tabIndex={0}
            role="application"
            aria-label={label}
            className="relative min-h-0 min-w-0 flex-1 select-none overflow-hidden bg-ground outline-none"
            style={{
                backgroundImage: 'radial-gradient(circle, rgb(46 47 52) 1px, transparent 1px)',
                backgroundSize: `${20 * viewport.scale}px ${20 * viewport.scale}px`,
                backgroundPosition: `${viewport.x}px ${viewport.y}px`,
                cursor: panning ? 'grabbing' : hoverWire ? 'pointer' : 'default',
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => endGesture()}
            onPointerLeave={() => { if (!gesture.current && hoverWire) setHoverWire(null); }}
            onDoubleClick={onDoubleClick}
            onContextMenu={(event) => event.preventDefault()}
        >
            <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }}>
                {shownFrames.map((frame) => {
                    const rect = frameRect(frame);
                    const selected = selectedFrame === frame.id;
                    return (
                        <div key={frame.id} data-frame={frame.id} className={`absolute rounded-lg border ${selected ? 'border-accent' : 'border-white/10'}`}
                            style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, background: `${frame.colour}40` }}>
                            <div data-frame-title={frame.id} title="Drag to move it with everything in it · double-click to rename · right-click for more"
                                className="flex h-[26px] cursor-move items-center rounded-t-lg px-2 text-xs font-semibold text-ink" style={{ background: `${frame.colour}d8` }}>
                                {frameTitle === frame.id ? (
                                    <FrameTitle value={frame.title} onDone={(text) => {
                                        setFrameTitle(null);
                                        const current = latest.current.graph;
                                        if (text === null || text === frame.title) return;
                                        commit({ ...current, frames: current.frames.map((candidate) => (candidate.id === frame.id ? { ...candidate, title: text.slice(0, 500) } : candidate)) });
                                    }} />
                                ) : <span className="truncate">{frame.title || 'Frame'}</span>}
                            </div>
                            <div data-frame-resize={frame.id} title="Drag to resize" className="absolute bottom-0 right-0 h-3 w-3 cursor-nwse-resize" style={{ background: `linear-gradient(135deg, transparent 50%, ${frame.colour} 50%)` }} />
                        </div>
                    );
                })}
            </div>
            <canvas ref={wireCanvas} className="pointer-events-none absolute inset-0 h-full w-full" />
            <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }}>
                {shownNodes.map((node) => {
                    const nodeView = views.get(node.id);
                    const layout = layouts.get(node.id);
                    if (!nodeView || !layout) return null;
                    const offset = offsetOf(node.id);
                    return (
                        <NodeCard
                            key={node.id}
                            node={node}
                            view={nodeView}
                            layout={layout}
                            wired={wired.get(node.id)!}
                            selected={selection.has(node.id)}
                            highlighted={highlighted === node.id}
                            dx={offset.x}
                            dy={offset.y}
                            detail={detail}
                            renaming={renaming === node.id}
                            folds={adapter.looks}
                            kinds={adapter.kinds}
                            actions={actions}
                            renderBody={adapter.renderBody}
                            heat={heats?.get(node.id)?.heat}
                            heatLabel={heats?.get(node.id)?.label}
                        />
                    );
                })}
                {marquee && <div className="pointer-events-none absolute border border-accent bg-accent/10" style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }} />}
            </div>

            <div data-overlay className="absolute left-2 top-2 z-20 flex items-center gap-0.5 rounded-md border border-line bg-panel/95 p-0.5 shadow" {...stopOverlay}>
                <IconButton label="Add a node" shortcut="Space" onClick={() => {
                    // The finder opens under the toolbar; the node goes in the middle of the view.
                    const box = root.current!.getBoundingClientRect();
                    openFinder(box.left + 8, box.top + 40, { at: toGraph(box.left + box.width / 2, box.top + box.height / 2) });
                }}><PlusIcon size={14} /></IconButton>
                <IconButton label="Undo" shortcut="Ctrl+Z" disabled={!canUndo} onClick={onUndo}><UndoIcon size={14} /></IconButton>
                <IconButton label="Redo" shortcut="Ctrl+Y" disabled={!canRedo} onClick={onRedo}><RedoIcon size={14} /></IconButton>
                <span className="mx-0.5 h-4 w-px bg-line" />
                <IconButton label="Frame the view on the selection, or everything" shortcut="F" onClick={() => frameAll(selection.size ? selection : undefined)}><FrameIcon size={14} /></IconButton>
                <IconButton label="Put a frame round the selection" shortcut="C" onClick={addFrame}><CommentAddIcon size={14} /></IconButton>
                <IconButton ref={alignButton} label="Line up or space out the selected nodes" onClick={alignMenu}><LayoutIcon size={14} /></IconButton>
                {adapter.looks && <IconButton label="Colour the selected nodes" disabled={!selection.size} onClick={(event) => colourMenu((event.currentTarget as HTMLElement).getBoundingClientRect())}><PaletteIcon size={14} /></IconButton>}
                <IconButton label={selection.size > 1 ? 'Tidy the selected nodes into columns' : 'Tidy the whole graph into columns'} onClick={tidy}><FlowIcon size={14} /></IconButton>
                {adapter.cost && <IconButton label={heatOn ? 'Hide the cost map' : `Show the cost map: ${adapter.costWords ?? 'what each node costs'}`} active={heatOn} onClick={() => setHeatOn((value) => { writeSetting('heat', !value); return !value; })}><FlameIcon size={14} /></IconButton>}
                <IconButton label={snap ? 'Snapping to the grid: on' : 'Snapping to the grid: off'} active={snap} onClick={() => setSnap((value) => { writeSetting('snap', !value); return !value; })}><MagnetIcon size={14} /></IconButton>
                <IconButton label="Find in graph" shortcut="Ctrl+F" active={findOpen} onClick={() => setFindOpen((value) => !value)}><SearchIcon size={14} /></IconButton>
                <IconButton label={showMap ? 'Hide the overview map' : 'Show the overview map'} active={showMap} onClick={() => setShowMap((value) => { writeSetting('minimap', !value); return !value; })}><GlobeIcon size={14} /></IconButton>
                {toolbarExtra && <span className="mx-0.5 h-4 w-px bg-line" />}
                {toolbarExtra}
            </div>
            {notice && (
                <div data-overlay role="status" className="absolute right-2 top-2 z-20 flex max-w-[min(420px,calc(100%-400px))] gap-1.5 rounded-md border border-warn/40 bg-panel/95 px-2 py-1.5 text-2xs leading-snug text-warn shadow" {...stopOverlay}>
                    <WarningIcon size={12} className="mt-px shrink-0" />
                    <div className="min-w-0">{notice}</div>
                </div>
            )}
            {findOpen && <FindBar targets={findTargets} onGo={goTo} onClose={() => { setFindOpen(false); root.current?.focus({ preventScroll: true }); }} />}
            {crowded && (
                <div data-overlay role="status" className="absolute bottom-2 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-md border border-line bg-panel/95 px-2 py-1 text-2xs text-ink-2 shadow" {...stopOverlay}>
                    <span>Many nodes sit on top of one another.</span>
                    <button type="button" onClick={() => { setCrowded(false); latest.current.onSelect([], null); requestAnimationFrame(() => { tidy(); requestAnimationFrame(() => frameAll()); }); }}
                        className="rounded bg-accent px-2 py-0.5 font-semibold text-accent-ink hover:bg-accent-hover">Tidy them</button>
                    <button type="button" aria-label="Leave them" title="Leave them" onClick={() => setCrowded(false)} className="text-ink-3 hover:text-ink">Leave</button>
                </div>
            )}
            {(refused || hoverWire || status) && (
                <div role={refused ? 'alert' : undefined} className={`pointer-events-none absolute bottom-2 left-2 z-10 rounded bg-panel/90 px-2 py-1 text-2xs ${refused ? 'text-warn' : 'text-ink-3'}`}>
                    {refused ?? (hoverWire ? 'Wire: right-click for more · double-click for a reroute point · Alt+click to cut' : status)}
                </div>
            )}
            {showMap && size.width > 0 && graph.nodes.length > 0 && (
                <Minimap nodes={mapNodes} frames={mapFrames} view={visible}
                    onMove={(centre) => setViewport((value) => ({ ...value, x: size.width / 2 - centre.x * value.scale, y: size.height / 2 - centre.y * value.scale }))} />
            )}
            {finder && (
                <NodeFinder
                    at={finder.screen}
                    bounds={size}
                    entries={adapter.entries}
                    memoryKey={adapter.kind}
                    context={finder.context}
                    filter={finderFilter}
                    renderPicture={adapter.renderPicture}
                    onChoose={chooseEntry}
                    onClose={() => { setFinder(null); root.current?.focus({ preventScroll: true }); }}
                />
            )}
            {menu && <NodeMenu x={menu.x} y={menu.y} title={menu.title} items={menu.items} colours={menu.colours} onClose={() => setMenu(null)} />}
        </div>
    );
}

/** A frame's title typed in place: kept on Enter or on leaving the box, given up on Escape. */
const FrameTitle: React.FC<{ value: string; onDone: (value: string | null) => void }> = ({ value, onDone }) => {
    const [draft, setDraft] = useState(value);
    const finished = useRef(false);
    const finish = (result: string | null) => {
        if (finished.current) return;
        finished.current = true;
        onDone(result);
    };
    return (
        <input
            autoFocus
            aria-label="Frame title"
            value={draft}
            maxLength={500}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={(event) => event.target.select()}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onBlur={() => finish(draft)}
            onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') finish(draft);
                if (event.key === 'Escape') finish(null);
            }}
            className="w-full rounded-sm bg-black/40 px-1 text-xs font-semibold text-ink outline-none ring-1 ring-accent/70"
        />
    );
};
