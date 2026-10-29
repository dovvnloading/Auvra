import {
    MATERIAL_NODE_DEFINITIONS,
    OUTPUT_NODE_TYPE,
    REROUTE_NODE_TYPE,
    defaultParams,
    getMaterialNodeDefinition,
    normalizeMaterialGraph,
    wouldCreateCycle,
    type MaterialGraph,
    type MaterialGraphComment,
    type MaterialGraphLink,
    type MaterialGraphNode,
    type MaterialNodeDef,
    type MaterialValueType,
} from '../../runtime/materials/materialGraph';
import { NODE_PREVIEW_SIZE } from '../../runtime/materials/materialPreviews';

/**
 * What the material graph editor (MaterialGraphEditor.tsx) does to a graph, apart from drawing it:
 * where nodes and pins sit, selecting, copying and pasting, wiring, searching for nodes, and undo.
 */

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export const NODE_WIDTH = 200;
export const HEADER = 28;
export const ROW = 22;
/** A reroute is a dot this wide. */
export const REROUTE_SIZE = 18;
const PREVIEW_MARGIN = 8;

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }

/** True for nodes that show their value as an image. */
export const showsPreview = (node: MaterialGraphNode): boolean => node.type !== OUTPUT_NODE_TYPE && node.type !== REROUTE_NODE_TYPE;

export const nodeRect = (node: MaterialGraphNode, previews: boolean): Rect => {
    if (node.type === REROUTE_NODE_TYPE) return { x: node.x, y: node.y, width: REROUTE_SIZE, height: REROUTE_SIZE };
    const definition = getMaterialNodeDefinition(node.type)!;
    const rows = definition.outputs.length + definition.inputs.length;
    const preview = previews && showsPreview(node) ? NODE_PREVIEW_SIZE + PREVIEW_MARGIN : 0;
    return { x: node.x, y: node.y, width: NODE_WIDTH, height: HEADER + rows * ROW + 6 + preview };
};

/** Top of the node's preview image, from the node's top. */
export const previewTop = (node: MaterialGraphNode): number => {
    const definition = getMaterialNodeDefinition(node.type)!;
    return HEADER + (definition.outputs.length + definition.inputs.length) * ROW + 4;
};

/** Where a pin sits: outputs on the right, one row each, then inputs on the left. */
export const pinPosition = (node: MaterialGraphNode, kind: 'in' | 'out', key: string): Point => {
    if (node.type === REROUTE_NODE_TYPE) return { x: node.x + (kind === 'out' ? REROUTE_SIZE : 0), y: node.y + REROUTE_SIZE / 2 };
    const definition = getMaterialNodeDefinition(node.type)!;
    const index = kind === 'out'
        ? definition.outputs.findIndex(port => port.key === key)
        : definition.outputs.length + definition.inputs.findIndex(port => port.key === key);
    return { x: node.x + (kind === 'out' ? NODE_WIDTH : 0), y: node.y + HEADER + index * ROW + ROW / 2 };
};

export const wirePath = (from: Point, to: Point): string => {
    const bend = Math.max(40, Math.abs(to.x - from.x) / 2);
    return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
};

export const rectsOverlap = (a: Rect, b: Rect): boolean =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const rectContains = (outer: Rect, inner: Rect): boolean =>
    inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

/** A rectangle from two corners in any order. */
export const rectFrom = (a: Point, b: Point): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });

/** The nodes a selection box touches. */
export const nodesInRect = (graph: MaterialGraph, rect: Rect, previews: boolean): string[] =>
    graph.nodes.filter(node => rectsOverlap(rect, nodeRect(node, previews))).map(node => node.id);

/** The box around `nodes` (and comments), or null when there are none. */
export const boundsOf = (rects: Rect[]): Rect | null => {
    if (!rects.length) return null;
    const minX = Math.min(...rects.map(rect => rect.x));
    const minY = Math.min(...rects.map(rect => rect.y));
    const maxX = Math.max(...rects.map(rect => rect.x + rect.width));
    const maxY = Math.max(...rects.map(rect => rect.y + rect.height));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

/** Nodes lying wholly inside a comment, which move with it. */
export const commentNodes = (graph: MaterialGraph, comment: MaterialGraphComment, previews: boolean): string[] =>
    graph.nodes.filter(node => rectContains(comment, nodeRect(node, previews))).map(node => node.id);

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

export const newId = (): string => crypto.randomUUID();

export const createNode = (type: string, at: Point): MaterialGraphNode => ({ id: newId(), type, x: Math.round(at.x), y: Math.round(at.y), params: defaultParams(type) });

/** The graph without `nodeIds` (the Material Output stays) and their wires. */
export const removeNodes = (graph: MaterialGraph, nodeIds: Iterable<string>): MaterialGraph => {
    const gone = new Set(nodeIds);
    for (const node of graph.nodes) if (node.type === OUTPUT_NODE_TYPE) gone.delete(node.id);
    if (!gone.size) return graph;
    return {
        ...graph,
        nodes: graph.nodes.filter(node => !gone.has(node.id)),
        links: graph.links.filter(link => !gone.has(link.fromNode) && !gone.has(link.toNode)),
    };
};

/** The graph with `nodeIds` moved by `delta` from where they were in `from`. */
export const moveNodes = (graph: MaterialGraph, from: MaterialGraph, nodeIds: ReadonlySet<string>, delta: Point): MaterialGraph => {
    const start = new Map(from.nodes.map(node => [node.id, node]));
    return {
        ...graph,
        nodes: graph.nodes.map((node) => {
            const origin = start.get(node.id);
            return nodeIds.has(node.id) && origin ? { ...node, x: Math.round(origin.x + delta.x), y: Math.round(origin.y + delta.y) } : node;
        }),
    };
};

/**
 * Wires output `fromOutput` of `fromNode` into input `toInput` of `toNode`, replacing what fed that
 * input; null when the wire would close a loop.
 */
export const connect = (graph: MaterialGraph, link: MaterialGraphLink): MaterialGraph | null => {
    if (wouldCreateCycle(graph, link.fromNode, link.toNode)) return null;
    const links = graph.links.filter(other => !(other.toNode === link.toNode && other.toInput === link.toInput));
    return { ...graph, links: [...links, link] };
};

/** A pin being dragged out to make a wire. */
export interface PendingWire {
    /** 'out': dragged from an output, to be dropped on an input; 'in' the other way. */
    from: 'out' | 'in';
    nodeId: string;
    key: string;
    type: MaterialValueType;
}

/** The port of a new node a dragged wire should join: the first of the same type, else an auto one, else the first. */
export const matchingPort = (definition: MaterialNodeDef, wire: PendingWire): string | undefined => {
    const ports = wire.from === 'out' ? definition.inputs : definition.outputs;
    return (ports.find(port => port.type === wire.type) ?? ports.find(port => port.type === 'auto') ?? ports[0])?.key;
};

/** Adds a node of `type` at `at`, wired to `wire` when a wire was dragged out to make it. */
export const addNode = (graph: MaterialGraph, type: string, at: Point, wire?: PendingWire | null): { graph: MaterialGraph; node: MaterialGraphNode } => {
    const node = createNode(type, at);
    let next: MaterialGraph = { ...graph, nodes: [...graph.nodes, node] };
    const definition = getMaterialNodeDefinition(type);
    const port = wire && definition ? matchingPort(definition, wire) : undefined;
    if (wire && port) {
        const link = wire.from === 'out'
            ? { fromNode: wire.nodeId, fromOutput: wire.key, toNode: node.id, toInput: port }
            : { fromNode: node.id, fromOutput: port, toNode: wire.nodeId, toInput: wire.key };
        next = connect(next, link) ?? next;
    }
    return { graph: next, node };
};

/** Puts a reroute halfway along wire `link`, the wire running through it. */
export const insertReroute = (graph: MaterialGraph, link: MaterialGraphLink, at: Point): MaterialGraph => {
    const reroute = createNode(REROUTE_NODE_TYPE, { x: at.x - REROUTE_SIZE / 2, y: at.y - REROUTE_SIZE / 2 });
    const links = graph.links.filter(other => other !== link);
    return {
        ...graph,
        nodes: [...graph.nodes, reroute],
        links: [
            ...links,
            { fromNode: link.fromNode, fromOutput: link.fromOutput, toNode: reroute.id, toInput: 'in' },
            { fromNode: reroute.id, fromOutput: 'out', toNode: link.toNode, toInput: link.toInput },
        ],
    };
};

/** A comment around `rects` (with a margin), or a default-sized one at `at`. */
export const createComment = (rects: Rect[], at: Point): MaterialGraphComment => {
    const bounds = boundsOf(rects);
    const margin = 24;
    return bounds
        ? { id: newId(), x: bounds.x - margin, y: bounds.y - margin - 28, width: bounds.width + margin * 2, height: bounds.height + margin * 2 + 28, text: 'Comment', color: '#3b4252' }
        : { id: newId(), x: at.x, y: at.y, width: 360, height: 220, text: 'Comment', color: '#3b4252' };
};

export const withComments = (graph: MaterialGraph, comments: MaterialGraphComment[]): MaterialGraph => {
    const { comments: _old, ...rest } = graph;
    return comments.length ? { ...rest, comments } : rest;
};

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

const CLIPBOARD_KIND = 'auvra-material-nodes';

/** Nodes copied from a graph, with the wires between them, as text the system clipboard can carry. */
export interface MaterialClipboard {
    kind: typeof CLIPBOARD_KIND;
    version: 1;
    nodes: MaterialGraphNode[];
    links: MaterialGraphLink[];
}

/** The nodes `nodeIds` (not the Material Output) and the wires among them; null when there are none. */
export const copyNodes = (graph: MaterialGraph, nodeIds: Iterable<string>): MaterialClipboard | null => {
    const ids = new Set(nodeIds);
    const nodes = graph.nodes.filter(node => ids.has(node.id) && node.type !== OUTPUT_NODE_TYPE);
    if (!nodes.length) return null;
    const kept = new Set(nodes.map(node => node.id));
    return {
        kind: CLIPBOARD_KIND,
        version: 1,
        nodes: structuredClone(nodes),
        links: graph.links.filter(link => kept.has(link.fromNode) && kept.has(link.toNode)).map(link => ({ ...link })),
    };
};

/** Clipboard text read back, or null when it is not copied material nodes. */
export const readClipboard = (text: string): MaterialClipboard | null => {
    try {
        const value = JSON.parse(text) as Partial<MaterialClipboard>;
        if (value?.kind !== CLIPBOARD_KIND || !Array.isArray(value.nodes) || !Array.isArray(value.links)) return null;
        // Through the graph's own checks: known nodes, valid params, real ports.
        const graph = normalizeMaterialGraph({ nodes: value.nodes, links: value.links });
        const nodes = graph.nodes.filter(node => node.type !== OUTPUT_NODE_TYPE && value.nodes!.some(candidate => candidate?.id === node.id));
        const kept = new Set(nodes.map(node => node.id));
        return nodes.length ? { kind: CLIPBOARD_KIND, version: 1, nodes, links: graph.links.filter(link => kept.has(link.fromNode) && kept.has(link.toNode)) } : null;
    } catch {
        return null;
    }
};

/** Adds copies of the clipboard's nodes (new ids, wired as they were) with their top-left at `at`. */
export const pasteNodes = (graph: MaterialGraph, clipboard: MaterialClipboard, at: Point): { graph: MaterialGraph; nodeIds: string[] } => {
    const ids = new Map(clipboard.nodes.map(node => [node.id, newId()]));
    const minX = Math.min(...clipboard.nodes.map(node => node.x));
    const minY = Math.min(...clipboard.nodes.map(node => node.y));
    const nodes = clipboard.nodes.map(node => ({
        ...structuredClone(node),
        id: ids.get(node.id)!,
        x: Math.round(node.x - minX + at.x),
        y: Math.round(node.y - minY + at.y),
    }));
    const links = clipboard.links.map(link => ({ ...link, fromNode: ids.get(link.fromNode)!, toNode: ids.get(link.toNode)! }));
    return { graph: { ...graph, nodes: [...graph.nodes, ...nodes], links: [...graph.links, ...links] }, nodeIds: nodes.map(node => node.id) };
};

// ---------------------------------------------------------------------------
// Finding nodes
// ---------------------------------------------------------------------------

/** Node types the palette offers (all but the Material Output), best match first; by category when `query` is empty. */
export const searchNodes = (query: string): MaterialNodeDef[] => {
    const available = MATERIAL_NODE_DEFINITIONS.filter(definition => definition.type !== OUTPUT_NODE_TYPE);
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) {
        // Each category together, in the order the categories first come.
        const order = [...new Set(available.map(definition => definition.category))];
        return [...available].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
    }
    const scored = available.map((definition) => {
        const label = definition.label.toLowerCase();
        const keywords = (definition.keywords ?? []).map(keyword => keyword.toLowerCase());
        const category = definition.category.toLowerCase();
        const description = definition.description.toLowerCase();
        let score = 0;
        for (const word of words) {
            if (label === word) score += 100;
            else if (label.startsWith(word)) score += 60;
            else if (label.split(/\s+/).some(part => part.startsWith(word))) score += 45;
            else if (label.includes(word)) score += 30;
            else if (keywords.some(keyword => keyword.startsWith(word))) score += 25;
            else if (keywords.some(keyword => keyword.includes(word))) score += 15;
            else if (category.startsWith(word)) score += 10;
            else if (description.includes(word)) score += 4;
            else return { definition, score: 0 };
        }
        return { definition, score };
    });
    return scored.filter(entry => entry.score > 0).sort((a, b) => b.score - a.score || a.definition.label.localeCompare(b.definition.label)).map(entry => entry.definition);
};

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

const HISTORY_LIMIT = 200;
/** Changes of one value in quick succession (a slider dragged, a number typed) undo together. */
const COALESCE_MS = 1000;

/** Undo and redo for one graph: each entry is a graph as it was before a change. */
export class GraphHistory {
    private readonly undoStack: MaterialGraph[] = [];
    private readonly redoStack: MaterialGraph[] = [];
    private lastKey: string | null = null;
    private lastTime = 0;

    /** Records that the graph changed from `before`; `coalesce` names a value whose quick edits merge into one step. */
    record(before: MaterialGraph, coalesce?: string, now = Date.now()): void {
        const merge = coalesce !== undefined && coalesce === this.lastKey && now - this.lastTime < COALESCE_MS;
        this.lastKey = coalesce ?? null;
        this.lastTime = now;
        this.redoStack.length = 0;
        if (merge) return;
        this.undoStack.push(before);
        if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    }

    get canUndo(): boolean { return this.undoStack.length > 0; }
    get canRedo(): boolean { return this.redoStack.length > 0; }

    /** The graph to go back to from `current`, or null. */
    undo(current: MaterialGraph): MaterialGraph | null {
        const previous = this.undoStack.pop();
        if (!previous) return null;
        this.redoStack.push(current);
        this.lastKey = null;
        return previous;
    }

    redo(current: MaterialGraph): MaterialGraph | null {
        const next = this.redoStack.pop();
        if (!next) return null;
        this.undoStack.push(current);
        this.lastKey = null;
        return next;
    }
}
