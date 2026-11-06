/**
 * THE NODE GRAPH CANVAS: ITS GRAPH
 *
 * The canvas edits both the texture graph and the shader graph. Each is read into this one shape
 * (nodes with their place and how they are shown, wires between pins, frames) and written back by
 * its own adapter, so every edit here (moving, wiring, splicing, frames, bypass...) is written once.
 * A node keeps its graph's own object as `source`; the adapter writes the fields here back into it.
 */

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }

/** How a node is shown and run, kept with it: its own name and colour, folded to its header, passed by. */
export interface NodeLook {
    /** A name of the user's own, shown instead of the node's kind. */
    name?: string;
    /** The header's colour (#rrggbb), instead of its category's. */
    color?: string;
    /** Shown as its header only. */
    collapsed?: boolean;
    /** Passes its main input straight through instead of doing its work. */
    bypass?: boolean;
}

export interface EditableNode<S = unknown> extends NodeLook {
    id: string;
    type: string;
    x: number;
    y: number;
    source: S;
}

export interface EditableLink {
    from: string;
    fromPin: string;
    to: string;
    toPin: string;
}

/** A titled, coloured box behind nodes: the nodes whose middle lies in it go with it. */
export interface EditableFrame {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    title: string;
    /** #rrggbb */
    colour: string;
}

export interface EditableGraph<S = unknown> {
    nodes: readonly EditableNode<S>[];
    links: readonly EditableLink[];
    frames: readonly EditableFrame[];
}

export const linkKey = (link: EditableLink): string => `${link.from}:${link.fromPin}>${link.to}:${link.toPin}`;
export const sameLink = (a: EditableLink, b: EditableLink): boolean => a.from === b.from && a.fromPin === b.fromPin && a.to === b.to && a.toPin === b.toPin;

/** True when wiring `from` into `to` would make a loop (or join a node to itself). */
export const wouldCycle = (links: readonly EditableLink[], from: string, to: string): boolean => {
    if (from === to) return true;
    const downstream = new Map<string, string[]>();
    for (const link of links) {
        const list = downstream.get(link.from);
        if (list) list.push(link.to);
        else downstream.set(link.from, [link.to]);
    }
    const stack = [to];
    const seen = new Set<string>();
    while (stack.length) {
        const current = stack.pop()!;
        if (current === from) return true;
        if (seen.has(current)) continue;
        seen.add(current);
        for (const next of downstream.get(current) ?? []) stack.push(next);
    }
    return false;
};

/** The graph with `link` added, replacing what fed its input; null when it would make a loop. */
export const connect = <S>(graph: EditableGraph<S>, link: EditableLink): EditableGraph<S> | null => {
    if (wouldCycle(graph.links, link.from, link.to)) return null;
    const links = graph.links.filter((other) => !(other.to === link.to && other.toPin === link.toPin));
    return { ...graph, links: [...links, link] };
};

export const disconnect = <S>(graph: EditableGraph<S>, link: EditableLink): EditableGraph<S> => ({ ...graph, links: graph.links.filter((other) => !sameLink(other, link)) });

export const removeNodes = <S>(graph: EditableGraph<S>, ids: ReadonlySet<string>): EditableGraph<S> => ({
    ...graph,
    nodes: graph.nodes.filter((node) => !ids.has(node.id)),
    links: graph.links.filter((link) => !ids.has(link.from) && !ids.has(link.to)),
});

/** The graph with nodes moved to new places (top-left corners), rounded to whole units. */
export const placeNodes = <S>(graph: EditableGraph<S>, places: ReadonlyMap<string, Point>): EditableGraph<S> => ({
    ...graph,
    nodes: graph.nodes.map((node) => {
        const at = places.get(node.id);
        if (!at) return node;
        const x = Math.round(at.x);
        const y = Math.round(at.y);
        return x === node.x && y === node.y ? node : { ...node, x, y };
    }),
});

/** The graph with the look of `ids` changed (a field set to undefined is taken away). */
export const setLook = <S>(graph: EditableGraph<S>, ids: ReadonlySet<string>, look: NodeLook): EditableGraph<S> => ({
    ...graph,
    nodes: graph.nodes.map((node) => {
        if (!ids.has(node.id)) return node;
        const next: EditableNode<S> = { ...node, ...look };
        for (const key of Object.keys(look) as Array<keyof NodeLook>) if (look[key] === undefined || look[key] === false || look[key] === '') delete next[key];
        return next;
    }),
});

/** The pins of a node, with what each carries, for wiring a node that is new to the graph. */
export interface PinSet { inputs: ReadonlyArray<{ key: string; kind: string }>; outputs: ReadonlyArray<{ key: string; kind: string }> }

/**
 * How well a wire carrying `from` suits a pin taking `to`: 2 for the same kind, 1 for kinds that
 * convert (or a pin taking anything), 0 for none.
 */
export type KindMatch = (from: string, to: string) => number;

/** The pin of `pins` that suits `kind` best (the first of the best), or undefined. */
export const bestPin = (pins: ReadonlyArray<{ key: string; kind: string }>, kind: string, match: KindMatch, side: 'input' | 'output'): string | undefined => {
    let best: string | undefined;
    let bestScore = 0;
    for (const pin of pins) {
        const score = side === 'input' ? match(kind, pin.kind) : match(pin.kind, kind);
        if (score > bestScore) { best = pin.key; bestScore = score; }
    }
    return best;
};

/**
 * Splices `node` into `link`: the wire's start feeds the node's best input and the node's best output
 * feeds the wire's end. `pins` are the node's pins; `kinds` give what the wire carries and what its end
 * takes. When the node cannot take or give what the wire carries, the node is added unwired.
 */
export const spliceNode = <S>(
    graph: EditableGraph<S>,
    link: EditableLink,
    node: EditableNode<S>,
    pins: PinSet,
    kinds: { carried: string; taken: string },
    match: KindMatch,
): EditableGraph<S> => {
    const withNode: EditableGraph<S> = graph.nodes.some((candidate) => candidate.id === node.id) ? graph : { ...graph, nodes: [...graph.nodes, node] };
    const input = bestPin(pins.inputs, kinds.carried, match, 'input');
    const output = bestPin(pins.outputs, kinds.taken, match, 'output');
    if (!input || !output || node.id === link.from || node.id === link.to) return withNode;
    const without = disconnect(withNode, link);
    // The node's own wires go: it now sits on this wire alone.
    const cleared: EditableGraph<S> = { ...without, links: without.links.filter((other) => !(other.to === node.id && other.toPin === input)) };
    const first = connect(cleared, { from: link.from, fromPin: link.fromPin, to: node.id, toPin: input });
    if (!first) return withNode;
    return connect(first, { from: node.id, fromPin: output, to: link.to, toPin: link.toPin }) ?? withNode;
};

/** Puts a point (a reroute node, with pins 'in' and 'out') on `link`, the wire running through it. */
export const insertReroute = <S>(graph: EditableGraph<S>, link: EditableLink, reroute: EditableNode<S>): EditableGraph<S> => {
    const links = graph.links.filter((other) => !sameLink(other, link));
    return {
        ...graph,
        nodes: [...graph.nodes, reroute],
        links: [...links, { from: link.from, fromPin: link.fromPin, to: reroute.id, toPin: 'in' }, { from: reroute.id, fromPin: 'out', to: link.to, toPin: link.toPin }],
    };
};

/**
 * Adds copies of `nodes` (and the wires among them) with new ids from `newId`, their top-left at `at`.
 * Returns the new ids in the order given.
 */
export const pasteNodes = <S>(graph: EditableGraph<S>, nodes: readonly EditableNode<S>[], links: readonly EditableLink[], at: Point, newId: () => string): { graph: EditableGraph<S>; ids: string[] } => {
    if (!nodes.length) return { graph, ids: [] };
    const left = Math.min(...nodes.map((node) => node.x));
    const top = Math.min(...nodes.map((node) => node.y));
    const renamed = new Map<string, string>();
    const copies = nodes.map((node) => {
        const id = newId();
        renamed.set(node.id, id);
        return { ...node, id, x: Math.round(at.x + node.x - left), y: Math.round(at.y + node.y - top) };
    });
    const wires = links
        .filter((link) => renamed.has(link.from) && renamed.has(link.to))
        .map((link) => ({ ...link, from: renamed.get(link.from)!, to: renamed.get(link.to)! }));
    return { graph: { ...graph, nodes: [...graph.nodes, ...copies], links: [...graph.links, ...wires] }, ids: copies.map((node) => node.id) };
};

export const rectsOverlap = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

export const rectFrom = (a: Point, b: Point): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });

/** The box round `rects`, or null when there are none. */
export const boundsOf = (rects: readonly Rect[]): Rect | null => {
    if (!rects.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const rect of rects) {
        if (rect.x < minX) minX = rect.x;
        if (rect.y < minY) minY = rect.y;
        if (rect.x + rect.width > maxX) maxX = rect.x + rect.width;
        if (rect.y + rect.height > maxY) maxY = rect.y + rect.height;
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};
