import { createNode, newNodeId, wouldCycle } from '../../texturing/graph/document';
import { OUTPUT_NODE_TYPE, SUBGRAPH_NODE_TYPE } from '../../texturing/graph/nodes/io';
import { textureNodeDefinition, type GraphResolver } from '../../texturing/graph/registry';
import type { PortKind, TexGraphComment, TexGraphLink, TexGraphNode, TexNodeDef, TextureGraph } from '../../texturing/graph/types';

/** Layout and edits of a texture graph on its canvas. */

export const NODE_WIDTH = 132;
export const HEADER = 22;
export const THUMB = 96;
export const PORT_ROW = 18;

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }

export const bodyHeight = (definition: TexNodeDef | null): number => {
    const ports = Math.max(definition?.inputs.length ?? 0, definition?.outputs.length ?? 0);
    return Math.max(THUMB + 10, ports * PORT_ROW + 10);
};

export const nodeRect = (node: TexGraphNode, definition: TexNodeDef | null): Rect => ({ x: node.x, y: node.y, width: NODE_WIDTH, height: HEADER + bodyHeight(definition) });

/** Where a pin sits: inputs down the left edge, outputs down the right, spread over the body. */
export const pinPosition = (node: TexGraphNode, definition: TexNodeDef | null, side: 'in' | 'out', key: string): Point => {
    const ports = side === 'in' ? definition?.inputs ?? [] : definition?.outputs ?? [];
    let index = ports.findIndex((port) => port.key === key);
    // An Output node draws its result as though it had one output, for its own picture only.
    if (index < 0) index = 0;
    const body = bodyHeight(definition);
    const span = ports.length * PORT_ROW;
    const top = node.y + HEADER + (body - span) / 2 + PORT_ROW / 2;
    return { x: node.x + (side === 'in' ? 0 : NODE_WIDTH), y: top + index * PORT_ROW };
};

export const wirePath = (from: Point, to: Point): string => {
    const reach = Math.max(40, Math.abs(to.x - from.x) * 0.5);
    return `M ${from.x} ${from.y} C ${from.x + reach} ${from.y}, ${to.x - reach} ${to.y}, ${to.x} ${to.y}`;
};

export const rectFrom = (a: Point, b: Point): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });
export const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

export const boundsOf = (rects: readonly Rect[]): Rect | null => {
    if (!rects.length) return null;
    const x = Math.min(...rects.map((r) => r.x));
    const y = Math.min(...rects.map((r) => r.y));
    return { x, y, width: Math.max(...rects.map((r) => r.x + r.width)) - x, height: Math.max(...rects.map((r) => r.y + r.height)) - y };
};

/** The kind a wire carries: what the output it leaves from resolves to. */
export const portKind = (graph: TextureGraph, nodeId: string, side: 'in' | 'out', key: string, resolve: GraphResolver): PortKind | 'any' => {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    const definition = node ? textureNodeDefinition(node, resolve) : null;
    const port = (side === 'in' ? definition?.inputs : definition?.outputs)?.find((candidate) => candidate.key === key);
    if (!port) return 'any';
    if (port.kind !== 'any') return port.kind;
    if (side === 'in') return 'any';
    if (definition?.kindOf) return definition.kindOf(node!.params);
    const follows = definition?.kindFrom ? (Array.isArray(definition.kindFrom) ? definition.kindFrom : [definition.kindFrom]) as string[] : [];
    const kinds = follows.map((input) => {
        const link = graph.links.find((candidate) => candidate.to === nodeId && candidate.toInput === input);
        return link ? portKind(graph, link.from, 'out', link.fromOutput, resolve) : null;
    }).filter((kind): kind is PortKind => kind === 'color' || kind === 'gray');
    return kinds.length ? (kinds.includes('color') ? 'color' : 'gray') : definition?.anyDefault ?? 'gray';
};

/** The graph with `to.input` wired from `from.output` (replacing what was wired there); the same graph if that would loop. */
export const connect = (graph: TextureGraph, link: TexGraphLink): TextureGraph => {
    if (wouldCycle(graph, link.from, link.to)) return graph;
    const links = graph.links.filter((candidate) => !(candidate.to === link.to && candidate.toInput === link.toInput));
    links.push(link);
    return { ...graph, links };
};

export const removeNodes = (graph: TextureGraph, ids: ReadonlySet<string>): TextureGraph => ({
    ...graph,
    nodes: graph.nodes.filter((node) => !ids.has(node.id)),
    links: graph.links.filter((link) => !ids.has(link.from) && !ids.has(link.to)),
});

export const moveNodes = (graph: TextureGraph, ids: ReadonlySet<string>, dx: number, dy: number): TextureGraph => ({
    ...graph,
    nodes: graph.nodes.map((node) => (ids.has(node.id) ? { ...node, x: Math.round(node.x + dx), y: Math.round(node.y + dy) } : node)),
});

export const addNodeOfType = (graph: TextureGraph, type: string, at: Point, params: Record<string, unknown> = {}): { graph: TextureGraph; node: TexGraphNode } => {
    const node = createNode(type, Math.round(at.x), Math.round(at.y), params);
    return { graph: { ...graph, nodes: [...graph.nodes, node] }, node };
};

/** A sub-graph node using graph `graphId`, its settings the graph's parameter defaults. */
export const addSubgraphNode = (graph: TextureGraph, graphId: string, used: TextureGraph, at: Point): { graph: TextureGraph; node: TexGraphNode } => {
    const params: Record<string, unknown> = { graph: graphId };
    for (const parameter of used.parameters) params[parameter.name] = structuredClone(parameter.default);
    const node: TexGraphNode = { id: newNodeId(), type: SUBGRAPH_NODE_TYPE, x: Math.round(at.x), y: Math.round(at.y), params };
    return { graph: { ...graph, nodes: [...graph.nodes, node] }, node };
};

export interface GraphClipboard { kind: 'auvra-texture-graph'; nodes: TexGraphNode[]; links: TexGraphLink[] }

export const copyNodes = (graph: TextureGraph, ids: ReadonlySet<string>): GraphClipboard => ({
    kind: 'auvra-texture-graph',
    nodes: graph.nodes.filter((node) => ids.has(node.id)).map((node) => structuredClone(node)),
    links: graph.links.filter((link) => ids.has(link.from) && ids.has(link.to)).map((link) => ({ ...link })),
});

export const readClipboard = (text: string): GraphClipboard | null => {
    try {
        const value = JSON.parse(text) as Partial<GraphClipboard>;
        return value?.kind === 'auvra-texture-graph' && Array.isArray(value.nodes) && Array.isArray(value.links) ? value as GraphClipboard : null;
    } catch {
        return null;
    }
};

/** Pastes copied nodes with new ids, their top-left at `at`; returns the new ids. */
export const pasteNodes = (graph: TextureGraph, clipboard: GraphClipboard, at: Point): { graph: TextureGraph; ids: string[] } => {
    const left = Math.min(...clipboard.nodes.map((node) => node.x));
    const top = Math.min(...clipboard.nodes.map((node) => node.y));
    const renamed = new Map<string, string>();
    const nodes = clipboard.nodes.map((node) => {
        const id = newNodeId();
        renamed.set(node.id, id);
        return { ...structuredClone(node), id, x: Math.round(at.x + node.x - left), y: Math.round(at.y + node.y - top) };
    });
    const links = clipboard.links
        .filter((link) => renamed.has(link.from) && renamed.has(link.to))
        .map((link) => ({ ...link, from: renamed.get(link.from)!, to: renamed.get(link.to)! }));
    return { graph: { ...graph, nodes: [...graph.nodes, ...nodes], links: [...graph.links, ...links] }, ids: nodes.map((node) => node.id) };
};

export const COMMENT_COLORS = ['#3b4252', '#1e3a5f', '#14532d', '#713f12', '#7f1d1d', '#4c1d95', '#134e4a', '#57534e'];

export const createComment = (around: readonly Rect[], fallback: Point): TexGraphComment => {
    const bounds = boundsOf(around);
    const pad = 24;
    return {
        id: newNodeId('c'),
        x: Math.round((bounds?.x ?? fallback.x) - pad),
        y: Math.round((bounds?.y ?? fallback.y) - pad - 20),
        width: Math.round((bounds?.width ?? 280) + pad * 2),
        height: Math.round((bounds?.height ?? 160) + pad * 2 + 20),
        text: 'Comment',
        color: COMMENT_COLORS[0],
    };
};

/** Nodes nothing reaches an Output from: drawn dimmed. */
export const unusedNodes = (graph: TextureGraph): Set<string> => {
    const used = new Set<string>();
    const stack = graph.nodes.filter((node) => node.type === OUTPUT_NODE_TYPE).map((node) => node.id);
    while (stack.length) {
        const id = stack.pop()!;
        if (used.has(id)) continue;
        used.add(id);
        for (const link of graph.links) if (link.to === id) stack.push(link.from);
    }
    return new Set(graph.nodes.filter((node) => !used.has(node.id)).map((node) => node.id));
};

/** An undo history of whole graphs; quick edits of one value merge into one step. */
export class GraphHistory {
    private past: TextureGraph[] = [];
    private future: TextureGraph[] = [];
    private lastKey: string | undefined;
    private lastTime = 0;

    record(before: TextureGraph, coalesce?: string): void {
        const now = performance.now();
        if (coalesce && coalesce === this.lastKey && now - this.lastTime < 1200) {
            this.lastTime = now;
            return;
        }
        this.past.push(before);
        if (this.past.length > 200) this.past.shift();
        this.future = [];
        this.lastKey = coalesce;
        this.lastTime = now;
    }

    undo(current: TextureGraph): TextureGraph | null {
        const previous = this.past.pop();
        if (!previous) return null;
        this.future.push(current);
        this.lastKey = undefined;
        return previous;
    }

    redo(current: TextureGraph): TextureGraph | null {
        const next = this.future.pop();
        if (!next) return null;
        this.past.push(current);
        this.lastKey = undefined;
        return next;
    }

    get canUndo(): boolean { return this.past.length > 0; }
    get canRedo(): boolean { return this.future.length > 0; }
}
