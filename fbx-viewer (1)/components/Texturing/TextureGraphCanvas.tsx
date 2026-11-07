import React, { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
    CircleDashedIcon, CubeIcon, DropletsIcon, EyeIcon, GearIcon, GraphIcon, ImageIcon, MaterialIcon, MergeIcon, MountainIcon, MoveIcon, SelectBoxIcon,
    SlidersIcon, SparklesIcon, TilesIcon, WindIcon, type IconComponent,
} from '../UI/Icons';
import type { FinderEntry } from '../NodeGraph/finder';
import type { EditableFrame, EditableGraph, EditableLink, EditableNode, NodeLook, PinSet } from '../NodeGraph/model';
import { HEADER, ROW } from '../NodeGraph/layout';
import { NodeGraphCanvas, type NodeGraphAdapter } from '../NodeGraph/NodeGraphCanvas';
import type { MenuItem, NodeView, PinKindStyle } from '../NodeGraph/types';
import { createNode, newNodeId } from '../../texturing/graph/document';
import { mainInput, unknownNodeMessage } from '../../texturing/graph/evaluator';
import { wireFits } from '../../texturing/graph/material';
import { NAMED_RECEIVE_TYPE, NAMED_SEND_TYPE, linkName, namedLinks } from '../../texturing/graph/namedLinks';
import { INPUT_NODE_TYPE, MATERIAL_INPUT_NODE_TYPE, MATERIAL_OUTPUT_NODE_TYPE, MESH_MAPS, MESH_MAP_LABELS, MESH_MAP_NODE_TYPE, OUTPUT_NODE_TYPE, REROUTE_NODE_TYPE, SUBGRAPH_NODE_TYPE } from '../../texturing/graph/nodes/io';
import { NODE_CATEGORY_ORDER, TEXTURE_NODE_DEFINITIONS, placeholderDefinition, textureNodeDefinition, type GraphResolver } from '../../texturing/graph/registry';
import { OUTPUT_CHANNELS, OUTPUT_CHANNEL_LABELS, type OutputChannel, type PinKind, type TexGraphComment, type TexGraphLink, type TexGraphNode, type TexNodeDef, type TexPortDef, type TextureGraph } from '../../texturing/graph/types';
import { copyNodes, outputKinds, readClipboard, unusedNodes, type Point } from './graphEditing';
import { NODE_PICTURE_SIZE, requestNodePictures, useNodePicture, type PictureRequest } from './nodePictures';
import { THUMBNAIL_SIZE, type TextureGraphSession } from './textureGraphSession';

/**
 * The texture graph's canvas: the shared node graph canvas (components/NodeGraph) given texture
 * nodes. Every node shows its picture, pins spread down its sides. Double-click a node to look at it
 * in the 2D view; open a graph used as a node to edit it in place. A node of a type this build does
 * not have shows as a placeholder with its wires.
 */

const KINDS: Readonly<Record<string, PinKindStyle>> = {
    color: { colour: '#e9b949', words: 'colour' },
    gray: { colour: '#a3a3a3', words: 'grey' },
    any: { colour: '#f5f5f5', words: 'colour or grey' },
    material: { colour: '#5eead4', words: 'a whole material', wide: true },
    anyMaterial: { colour: '#f5f5f5', words: 'colour, grey or a whole material' },
};
/** The kind a pin shows on the canvas: an input that also takes a material wire (an Output's) is a kind of its own. */
const pinKind = (port: TexPortDef): string => (port.material ? 'anyMaterial' : port.kind);
const asPort = (kind: string): Pick<TexPortDef, 'kind' | 'material'> => (kind === 'anyMaterial' ? { kind: 'any', material: true } : { kind: kind as PinKind });
/**
 * Any image goes into any image input (grey reads as grey colour, colour as its brightness); a material
 * wire goes only into a material input or an Output (texturing/graph/material.ts says the rules).
 */
const match = (from: string, to: string): number => {
    if (!wireFits(from as PinKind, asPort(to))) return 0;
    return from === to || from === 'any' || to === 'any' || to === 'anyMaterial' ? 2 : 1;
};
const refusal = (from: string, to: string): string => (from === 'material'
    ? 'A material wire goes only into a material input or an Output. Split material gives its channels as images.'
    : to === 'material' ? 'A material input takes a material wire. Make material puts images on one.' : 'These two pins do not fit together.');

const CATEGORY_TINTS: Record<string, string> = {
    'Inputs and outputs': '#3f4a5c', 'Mesh maps': '#2f5560', Noises: '#4b3f6b', Patterns: '#523d66', Shapes: '#5a4170',
    Adjustments: '#2f5a48', Blending: '#2d5653', Transforms: '#5f5230', Warps: '#634a2c', 'Blurs and sharpening': '#45562e',
    'Edges and distance': '#5f3448', 'Height and normals': '#3d4370', Utility: '#46474d', 'Graphs in this project': '#3b4a63', Materials: '#2c5a55',
};
const CATEGORY_MARKS: Record<string, IconComponent> = {
    'Inputs and outputs': ImageIcon, 'Mesh maps': CubeIcon, Noises: SparklesIcon, Patterns: TilesIcon, Shapes: CircleDashedIcon,
    Adjustments: SlidersIcon, Blending: MergeIcon, Transforms: MoveIcon, Warps: WindIcon, 'Blurs and sharpening': DropletsIcon,
    'Edges and distance': SelectBoxIcon, 'Height and normals': MountainIcon, Utility: GearIcon, 'Graphs in this project': GraphIcon, Materials: MaterialIcon,
};
const OUTPUT_TINT = '#2b4a6b';
const MISSING_TINT = '#5a4317';
const NODE_WIDTH = 140;
const GRAPHS_CATEGORY = 'Graphs in this project';

const LOOK_KEYS = ['name', 'color', 'collapsed', 'bypass'] as const;

// ---- the graph read into the canvas's shape, and back ----

const editableNodes = new WeakMap<TexGraphNode, EditableNode<TexGraphNode>>();
const editableLinks = new WeakMap<TexGraphLink, EditableLink>();
const linkSources = new WeakMap<EditableLink, TexGraphLink>();
const editableFrames = new WeakMap<TexGraphComment, EditableFrame>();
const frameSources = new WeakMap<EditableFrame, TexGraphComment>();

/** The fields of a node's look that are set (a texture node and an editable node both carry them). */
const lookOf = (node: NodeLook): NodeLook => ({
    ...(node.name ? { name: node.name } : {}),
    ...(node.color ? { color: node.color } : {}),
    ...(node.collapsed ? { collapsed: true } : {}),
    ...(node.bypass ? { bypass: true } : {}),
});

const toNode = (node: TexGraphNode): EditableNode<TexGraphNode> => {
    let found = editableNodes.get(node);
    if (!found) editableNodes.set(node, found = { id: node.id, type: node.type, x: node.x, y: node.y, ...lookOf(node), source: node });
    return found;
};
const toLink = (link: TexGraphLink): EditableLink => {
    let found = editableLinks.get(link);
    if (!found) {
        found = { from: link.from, fromPin: link.fromOutput, to: link.to, toPin: link.toInput };
        editableLinks.set(link, found);
        linkSources.set(found, link);
    }
    return found;
};
const toFrame = (comment: TexGraphComment): EditableFrame => {
    let found = editableFrames.get(comment);
    if (!found) {
        found = { id: comment.id, x: comment.x, y: comment.y, width: comment.width, height: comment.height, title: comment.text, colour: comment.color };
        editableFrames.set(comment, found);
        frameSources.set(found, comment);
    }
    return found;
};

const fromNode = (node: EditableNode<TexGraphNode>): TexGraphNode => {
    const source = node.source;
    if (editableNodes.get(source) === node) return source;
    const next: TexGraphNode = { ...source, id: node.id, x: node.x, y: node.y };
    for (const key of LOOK_KEYS) delete next[key];
    Object.assign(next, lookOf(node));
    editableNodes.set(next, { ...node, source: next });
    return next;
};

/** The texture graph with the canvas's edit written back; `base` when nothing changed. */
const fromEditable = (editable: EditableGraph<TexGraphNode>, base: TextureGraph): TextureGraph => {
    const nodes = editable.nodes.map(fromNode);
    const links = editable.links.map((link) => linkSources.get(link) ?? { from: link.from, fromOutput: link.fromPin, to: link.to, toInput: link.toPin });
    const comments = editable.frames.map((frame) => frameSources.get(frame) ?? { id: frame.id, x: frame.x, y: frame.y, width: frame.width, height: frame.height, text: frame.title, color: frame.colour });
    const same = <T,>(a: readonly T[], b: readonly T[] | undefined) => a.length === (b?.length ?? 0) && a.every((item, index) => item === b![index]);
    if (same(nodes, base.nodes) && same(links, base.links) && same(comments, base.comments)) return base;
    const { comments: _old, ...rest } = base;
    return comments.length ? { ...rest, nodes, links, comments } : { ...rest, nodes, links };
};

// ---- the node finder's choices ----

const typeEntry = (definition: TexNodeDef): FinderEntry => ({
    id: definition.type,
    label: definition.label,
    category: definition.category,
    description: definition.description,
    keywords: definition.keywords,
    inputs: definition.inputs.filter((port) => !port.hidden).map(pinKind),
    outputs: definition.outputs.filter((port) => !port.hidden).map((port) => port.kind),
});

const NODE_ENTRIES: readonly FinderEntry[] = (() => {
    const entries: FinderEntry[] = [];
    for (const definition of TEXTURE_NODE_DEFINITIONS) {
        if (definition.type === OUTPUT_NODE_TYPE || definition.type === MESH_MAP_NODE_TYPE || definition.type === SUBGRAPH_NODE_TYPE) continue;
        entries.push(typeEntry(definition));
    }
    // One entry per output channel and per mesh map, so they come ready set.
    for (const channel of OUTPUT_CHANNELS) {
        entries.push({
            id: `output:${channel}`,
            label: `Output: ${OUTPUT_CHANNEL_LABELS[channel]}`,
            category: 'Inputs and outputs',
            description: channel === 'custom' ? 'A named image the graph gives, for using it inside other graphs.' : `The material's ${OUTPUT_CHANNEL_LABELS[channel].toLowerCase()}.`,
            keywords: ['output', 'result', 'channel', channel, ...(channel === 'custom' ? ['named', 'other graphs', 'mask'] : [])],
            inputs: ['anyMaterial'],
            outputs: [],
        });
    }
    for (const map of MESH_MAPS) {
        entries.push({
            id: `mesh:${map}`,
            label: `Mesh map: ${MESH_MAP_LABELS[map]}`,
            category: 'Mesh maps',
            description: `The ${MESH_MAP_LABELS[map].toLowerCase()} map baked from the model the graph is used on.`,
            keywords: ['mesh map', 'baked', map],
            inputs: [],
            outputs: ['any'],
        });
    }
    const order = (entry: FinderEntry) => NODE_CATEGORY_ORDER.indexOf(entry.category as typeof NODE_CATEGORY_ORDER[number]);
    return entries.map((entry, index) => ({ entry, index })).sort((a, b) => order(a.entry) - order(b.entry) || a.index - b.index).map((item) => item.entry);
})();

/** Pictures the finder draws: every node that makes an image on its own (not outputs, inputs, pictures or reroute points). */
const PICTURE_REQUESTS: readonly PictureRequest[] = NODE_ENTRIES.flatMap((entry): PictureRequest[] => {
    if (entry.id.startsWith('mesh:')) return [{ key: entry.id, type: MESH_MAP_NODE_TYPE, params: { map: entry.id.slice(5) } }];
    if (entry.id.includes(':') || [INPUT_NODE_TYPE, REROUTE_NODE_TYPE, NAMED_SEND_TYPE, NAMED_RECEIVE_TYPE, MATERIAL_INPUT_NODE_TYPE, MATERIAL_OUTPUT_NODE_TYPE, 'bitmap'].includes(entry.id)) return [];
    return [{ key: entry.id, type: entry.id }];
});

const CategoryMark: React.FC<{ category: string; size: number }> = ({ category, size }) => {
    const Mark = CATEGORY_MARKS[category] ?? GearIcon;
    return (
        <span className="flex items-center justify-center rounded-sm text-white/85" style={{ width: size, height: size, background: CATEGORY_TINTS[category] ?? CATEGORY_TINTS.Utility }}>
            <Mark size={Math.round(size * 0.55)} />
        </span>
    );
};

/** An entry's picture, drawn once for the session; its category's mark until then (or when it has none). */
const EntryPicture: React.FC<{ entry: FinderEntry; size: number }> = ({ entry, size }) => {
    const picture = useNodePicture(entry.id);
    const canvas = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        if (picture && picture !== 'failed') canvas.current?.getContext('2d')?.putImageData(picture, 0, 0);
    }, [picture]);
    if (!picture || picture === 'failed') return <CategoryMark category={entry.category} size={size} />;
    return <canvas ref={canvas} width={NODE_PICTURE_SIZE} height={NODE_PICTURE_SIZE} className="rounded-sm" style={{ width: size, height: size }} />;
};

const renderPicture = (entry: FinderEntry, size: number): React.ReactNode => <EntryPicture entry={entry} size={size} />;
const startPictures = () => requestNodePictures(PICTURE_REQUESTS);

/** A node's picture, painted when the session makes this node's thumbnail anew (and only then). */
const Thumbnail = React.memo(({ session, nodeId }: { session: TextureGraphSession; nodeId: string }) => {
    const canvas = useRef<HTMLCanvasElement>(null);
    const subscribe = useCallback((listener: () => void) => session.subscribeThumbnail(nodeId, listener), [nodeId, session]);
    const signature = useSyncExternalStore(subscribe, () => session.thumbnails.get(nodeId)?.signature ?? '');
    useEffect(() => {
        const thumbnail = session.thumbnails.get(nodeId);
        const context = canvas.current?.getContext('2d');
        if (!context) return;
        if (!thumbnail) {
            context.fillStyle = '#18181b';
            context.fillRect(0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
            return;
        }
        context.putImageData(thumbnail.image, 0, 0);
    }, [nodeId, session, signature]);
    return <canvas ref={canvas} width={THUMBNAIL_SIZE} height={THUMBNAIL_SIZE} className="rounded-sm" style={{ width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE }} />;
});
Thumbnail.displayName = 'Thumbnail';

export interface TextureGraphCanvasProps {
    graph: TextureGraph;
    session: TextureGraphSession;
    resolve: GraphResolver;
    /** Graphs the node finder offers as sub-graph nodes. */
    graphs: ReadonlyArray<{ id: string; name: string }>;
    selection: ReadonlySet<string>;
    selectedComment: string | null;
    viewed: string | null;
    canUndo: boolean;
    canRedo: boolean;
    /** Something the user should know about the graph (parts that could not be opened), shown over the canvas. */
    notice?: React.ReactNode;
    onSelect: (ids: string[], comment?: string | null) => void;
    onView: (nodeId: string) => void;
    /** `commit` false: a step of a drag, recorded when it ends; `coalesce` merges quick edits. */
    onChange: (graph: TextureGraph, commit: boolean, coalesce?: string) => void;
    onAddSubgraph: (graphId: string, at: Point) => TexGraphNode | null;
    /** Opens the graph a sub-graph node uses, in place. */
    onOpenGraph?: (nodeId: string) => void;
    onUndo: () => void;
    onRedo: () => void;
}

export const TextureGraphCanvas: React.FC<TextureGraphCanvasProps> = (props) => {
    const { graph, session, resolve, graphs, selection, selectedComment, viewed, canUndo, canRedo, notice, onUndo, onRedo } = props;
    const latest = useRef(props);
    latest.current = props;
    const sessionVersion = useSyncExternalStore(session.subscribe, session.getVersion);
    const opens = Boolean(props.onOpenGraph);

    const editable = useMemo<EditableGraph<TexGraphNode>>(() => ({
        nodes: graph.nodes.map(toNode),
        links: graph.links.map(toLink),
        frames: (graph.comments ?? []).map(toFrame),
    }), [graph.comments, graph.links, graph.nodes]);

    // Each node's definition (a placeholder for types this build does not have, so their wires show),
    // the kind of every output, and the nodes nothing reaches an output from: worked out once per graph.
    const known = useMemo(() => new Map(graph.nodes.map((node) => [node.id, textureNodeDefinition(node, resolve)])), [graph.nodes, resolve]);
    const placeholders = useMemo(() => new Map(graph.nodes.filter((node) => !known.get(node.id)).map((node) => [node.id, placeholderDefinition(node, graph.links)])), [graph.links, graph.nodes, known]);
    const definition = useCallback((node: TexGraphNode): TexNodeDef | null => known.get(node.id) ?? placeholders.get(node.id) ?? null, [known, placeholders]);
    const kindOf = useMemo(() => outputKinds(graph, definition), [definition, graph]);
    const unused = useMemo(() => unusedNodes(graph), [graph]);

    // Each node's view, the same object while it shows the same (so only changed cards redraw).
    const viewCache = useRef(new Map<string, { key: string; view: NodeView }>());
    const views = useMemo(() => {
        void sessionVersion;
        const result = new Map<string, NodeView>();
        for (const node of graph.nodes) {
            const def = definition(node);
            const missing = placeholders.has(node.id);
            const state = session.state(node.id);
            const isOutput = node.type === OUTPUT_NODE_TYPE;
            const error = missing ? unknownNodeMessage(node.type) : state?.error;
            const named = node.type === NAMED_SEND_TYPE ? `Send: ${linkName(node) || 'no name'}` : node.type === NAMED_RECEIVE_TYPE ? `Receive: ${linkName(node) || 'no name'}` : null;
            const kindTitle = isOutput ? (String(node.params.name || '') || OUTPUT_CHANNEL_LABELS[node.params.channel as OutputChannel] || 'Output') : named ?? def?.label ?? node.type;
            const view: NodeView = {
                title: node.name || kindTitle,
                tint: missing ? MISSING_TINT : isOutput ? OUTPUT_TINT : CATEGORY_TINTS[def?.category ?? 'Utility'] ?? CATEGORY_TINTS.Utility,
                layout: node.type === REROUTE_NODE_TYPE ? 'dot' : 'edges',
                width: NODE_WIDTH,
                body: missing ? 48 : THUMBNAIL_SIZE,
                inputs: (def?.inputs ?? []).filter((port) => !port.hidden).map((port) => ({ key: port.key, label: port.label, kind: pinKind(port), ...(port.group ? { group: port.group } : {}) })),
                outputs: (def?.outputs ?? []).filter((port) => !port.hidden).map((port) => ({ key: port.key, label: port.label, kind: kindOf(node.id, port.key) })),
                ...(unused.has(node.id) ? { unused: true } : {}),
                ...(error ? { error } : {}),
                ...(missing ? { missing: true } : {}),
                ...(state && !error && state.milliseconds >= 20 ? { badge: `${Math.round(state.milliseconds)} ms` } : {}),
                description: node.name ? `${kindTitle}: ${def?.description ?? ''}` : def?.description,
                canBypass: Boolean(!missing && def && mainInput(def)),
                canDelete: true,
                ...(isOutput ? { output: true } : {}),
                ...(opens && node.type === SUBGRAPH_NODE_TYPE && typeof node.params.graph === 'string' && resolve(node.params.graph) ? { canOpen: true } : {}),
                searchText: `${kindTitle} ${def?.category ?? ''}`,
            };
            const key = JSON.stringify(view);
            const cached = viewCache.current.get(node.id);
            if (cached?.key === key) result.set(node.id, cached.view);
            else { viewCache.current.set(node.id, { key, view }); result.set(node.id, view); }
        }
        return result;
    }, [definition, graph.nodes, kindOf, opens, placeholders, resolve, session, sessionVersion, unused]);

    const entries = useMemo<readonly FinderEntry[]>(() => [
        ...NODE_ENTRIES,
        ...graphs.map((entry) => {
            const used = resolve(entry.id)?.graph;
            return {
                id: `graph:${entry.id}`,
                label: entry.name,
                category: GRAPHS_CATEGORY,
                description: 'This graph used as one node: its exposed parameters are its settings.',
                keywords: ['graph', 'sub-graph', 'subgraph', 'group'],
                inputs: (used?.nodes ?? []).filter((node) => node.type === INPUT_NODE_TYPE).map((node) => (node.params.kind === 'gray' ? 'gray' : 'color')),
                outputs: (used?.nodes ?? []).filter((node) => node.type === OUTPUT_NODE_TYPE).map(() => 'any'),
            };
        }),
    ], [graphs, resolve]);

    const renderBody = useCallback((nodeId: string, view: NodeView) => (view.missing ? null : <Thumbnail session={session} nodeId={nodeId} />), [session]);
    const ghostLinks = useMemo(() => namedLinks(graph).map((link) => ({ from: link.from, to: link.to })), [graph]);

    const adapter = useMemo<NodeGraphAdapter<TexGraphNode>>(() => {
        const pins = (node: EditableNode<TexGraphNode>): PinSet => {
            const def = textureNodeDefinition(node.source, latest.current.resolve);
            return {
                inputs: (def?.inputs ?? []).filter((port) => !port.hidden).map((port) => ({ key: port.key, kind: pinKind(port) })),
                outputs: (def?.outputs ?? []).filter((port) => !port.hidden).map((port) => ({ key: port.key, kind: port.kind === 'any' ? def?.kindOf?.(node.source.params) ?? 'any' : port.kind })),
            };
        };
        const create = (entryId: string, at: Point): EditableNode<TexGraphNode> | null => {
            const x = Math.round(at.x);
            const y = Math.round(at.y);
            if (entryId.startsWith('graph:')) {
                const made = latest.current.onAddSubgraph(entryId.slice(6), { x, y });
                return made ? toNode(made) : null;
            }
            if (entryId.startsWith('output:')) return toNode(createNode(OUTPUT_NODE_TYPE, x, y, { channel: entryId.slice(7), name: '' }));
            if (entryId.startsWith('mesh:')) return toNode(createNode(MESH_MAP_NODE_TYPE, x, y, { map: entryId.slice(5) }));
            return toNode(createNode(entryId, x, y));
        };
        const menuItems = (nodeId: string): MenuItem[] => [
            { label: 'Show in the 2D view', icon: <EyeIcon size={12} />, shortcut: 'Double-click', onSelect: () => latest.current.onView(nodeId) },
        ];
        return {
            kind: 'texture',
            kinds: KINDS,
            match,
            refusal,
            entries,
            renderPicture,
            onFinderOpen: startPictures,
            createNode: create,
            createReroute: (at) => toNode(createNode(REROUTE_NODE_TYPE, Math.round(at.x), Math.round(at.y))),
            pins,
            sizeOf: (node) => {
                // As the card lays out: pins down the sides of the thumbnail.
                const shown = pins(node);
                const span = Math.max(shown.inputs.length, shown.outputs.length) * ROW;
                return { width: NODE_WIDTH, height: HEADER + Math.max(THUMBNAIL_SIZE + 8, span + 8) };
            },
            newId: () => newNodeId(),
            copy: (current, ids) => JSON.stringify(copyNodes(fromEditable(current, latest.current.graph), ids)),
            paste: (text) => {
                const clipboard = readClipboard(text);
                if (!clipboard?.nodes.length) return null;
                // Fresh objects, so the pasted copies never share settings with what they were copied from.
                return { nodes: clipboard.nodes.map((node) => toNode(structuredClone(node))), links: clipboard.links.map((link) => toLink({ ...link })) };
            },
            looks: true,
            renderBody,
            cost: (nodeId) => {
                const state = latest.current.session.state(nodeId);
                return state && !state.error ? { value: state.milliseconds, label: state.milliseconds < 1 ? '<1 ms' : `${Math.round(state.milliseconds)} ms` } : null;
            },
            costWords: 'each node tinted by how long it took to draw',
            ghostLinks,
            menuItems,
            onOpenNode: (nodeId) => latest.current.onView(nodeId),
            onOpenGraph: (nodeId) => latest.current.onOpenGraph?.(nodeId),
        };
    }, [entries, ghostLinks, renderBody]);

    const onEdit = useCallback((next: EditableGraph<TexGraphNode>, coalesce?: string) => {
        const current = latest.current.graph;
        const written = fromEditable(next, current);
        if (written !== current) latest.current.onChange(written, true, coalesce);
    }, []);
    const onSelect = useCallback((ids: string[], frame?: string | null) => latest.current.onSelect(ids, frame ?? null), []);

    return (
        <NodeGraphCanvas
            label="Texture graph"
            graph={editable}
            views={views}
            adapter={adapter}
            selection={selection}
            selectedFrame={selectedComment}
            highlighted={viewed}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={onUndo}
            onRedo={onRedo}
            undoKeys="workspace"
            onSelect={onSelect}
            onEdit={onEdit}
            notice={notice}
            status={session.busy ? 'Drawing…' : `${graph.nodes.length} nodes · drew ${session.lastRun.nodes} in ${Math.round(session.lastRun.milliseconds)} ms`}
        />
    );
};
