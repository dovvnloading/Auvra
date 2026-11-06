import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import {
    AxesIcon, BranchIcon, CodeIcon, CubeIcon, EyeIcon, EyeOffIcon, GearIcon, GridIcon, ImageIcon, MaterialIcon, PaletteIcon, SigmaIcon, SlidersIcon, SparklesIcon,
    type IconComponent,
} from '../UI/Icons';
import { IconButton } from '../UI/kit';
import type { FinderEntry } from '../NodeGraph/finder';
import type { EditableFrame, EditableGraph, EditableLink, EditableNode, NodeLook, PinSet } from '../NodeGraph/model';
import { NodeGraphCanvas, type NodeGraphAdapter } from '../NodeGraph/NodeGraphCanvas';
import type { NodeView } from '../NodeGraph/types';
import {
    MATERIAL_NODE_DEFINITIONS,
    OUTPUT_NODE_TYPE,
    REROUTE_NODE_TYPE,
    getMaterialNodeDefinition,
    resolveAutoTypes,
    type MaterialGraph,
    type MaterialGraphComment,
    type MaterialGraphLink,
    type MaterialGraphNode,
} from '../../runtime/materials/materialGraph';
import { NODE_PREVIEW_SIZE, nodePreviewImages } from '../../runtime/materials/materialPreviews';
import { copyNodes, createNode, newId, readClipboard } from './materialGraphEditing';
import { MATERIAL_CATEGORY_TINTS, MATERIAL_KINDS, MATERIAL_LOOKS_KEPT, materialMatch, materialNodeView } from './materialNodeViews';

/**
 * The material graph's canvas: the shared node graph canvas (components/NodeGraph) given shader
 * nodes. Pins sit in labelled rows (the Material Output's under group headings that close), an
 * unwired input shows the value it takes, and every node can show a preview of its value.
 */

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
    /** What went wrong compiling, by node id: those nodes are marked, with the message in their tooltip. */
    nodeErrors?: Readonly<Record<string, string>>;
}

const CATEGORY_MARKS: Record<string, IconComponent> = {
    Output: MaterialIcon, Input: SlidersIcon, Geometry: CubeIcon, UV: GridIcon, Texture: ImageIcon, Procedural: SparklesIcon,
    Color: PaletteIcon, Math: SigmaIcon, Vector: AxesIcon, Logic: BranchIcon, Custom: CodeIcon, Utility: GearIcon,
};

const LOOK_KEYS = ['name', 'color', 'collapsed', 'bypass'] as const;
type LookedNode = MaterialGraphNode & NodeLook;

// ---- the graph read into the canvas's shape, and back ----

const editableNodes = new WeakMap<MaterialGraphNode, EditableNode<MaterialGraphNode>>();
const editableLinks = new WeakMap<MaterialGraphLink, EditableLink>();
const linkSources = new WeakMap<EditableLink, MaterialGraphLink>();
const editableFrames = new WeakMap<MaterialGraphComment, EditableFrame>();
const frameSources = new WeakMap<EditableFrame, MaterialGraphComment>();

const lookOf = (node: NodeLook): NodeLook => ({
    ...(node.name ? { name: node.name } : {}),
    ...(node.color ? { color: node.color } : {}),
    ...(node.collapsed ? { collapsed: true } : {}),
    ...(node.bypass ? { bypass: true } : {}),
});

const toNode = (node: MaterialGraphNode): EditableNode<MaterialGraphNode> => {
    let found = editableNodes.get(node);
    if (!found) editableNodes.set(node, found = { id: node.id, type: node.type, x: node.x, y: node.y, ...lookOf(node as LookedNode), source: node });
    return found;
};
const toLink = (link: MaterialGraphLink): EditableLink => {
    let found = editableLinks.get(link);
    if (!found) {
        found = { from: link.fromNode, fromPin: link.fromOutput, to: link.toNode, toPin: link.toInput };
        editableLinks.set(link, found);
        linkSources.set(found, link);
    }
    return found;
};
const toFrame = (comment: MaterialGraphComment): EditableFrame => {
    let found = editableFrames.get(comment);
    if (!found) {
        found = { id: comment.id, x: comment.x, y: comment.y, width: comment.width, height: comment.height, title: comment.text, colour: comment.color };
        editableFrames.set(comment, found);
        frameSources.set(found, comment);
    }
    return found;
};

const fromNode = (node: EditableNode<MaterialGraphNode>): MaterialGraphNode => {
    const source = node.source;
    if (editableNodes.get(source) === node) return source;
    const next: LookedNode = { ...source, id: node.id, x: node.x, y: node.y };
    for (const key of LOOK_KEYS) delete next[key];
    Object.assign(next, lookOf(node));
    editableNodes.set(next, { ...node, source: next });
    return next;
};

/** The material graph with the canvas's edit written back; `base` when nothing changed. */
const fromEditable = (editable: EditableGraph<MaterialGraphNode>, base: MaterialGraph): MaterialGraph => {
    const nodes = editable.nodes.map(fromNode);
    const links = editable.links.map((link) => linkSources.get(link) ?? { fromNode: link.from, fromOutput: link.fromPin, toNode: link.to, toInput: link.toPin });
    const comments = editable.frames.map((frame) => frameSources.get(frame) ?? { id: frame.id, x: frame.x, y: frame.y, width: frame.width, height: frame.height, text: frame.title, color: frame.colour });
    const same = <T,>(a: readonly T[], b: readonly T[] | undefined) => a.length === (b?.length ?? 0) && a.every((item, index) => item === b![index]);
    if (same(nodes, base.nodes) && same(links, base.links) && same(comments, base.comments)) return base;
    return comments.length ? { nodes, links, comments } : { nodes, links };
};

// ---- the node finder's choices ----

const ENTRIES: readonly FinderEntry[] = (() => {
    const available = MATERIAL_NODE_DEFINITIONS.filter((definition) => definition.type !== OUTPUT_NODE_TYPE);
    // Each category together, in the order the categories first come.
    const order = [...new Set(available.map((definition) => definition.category))];
    return [...available]
        .sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category))
        .map((definition) => ({
            id: definition.type,
            label: definition.label,
            category: definition.category,
            description: definition.description,
            keywords: definition.keywords,
            inputs: definition.inputs.map((input) => input.type),
            outputs: definition.outputs.map((output) => output.type),
        }));
})();

/** A node's mark in the finder: its category's colour and sign (shader nodes have no picture of their own). */
const renderPicture = (entry: FinderEntry, size: number): React.ReactNode => {
    const Mark = CATEGORY_MARKS[entry.category] ?? GearIcon;
    return (
        <span className="flex items-center justify-center rounded-sm text-white/85" style={{ width: size, height: size, background: MATERIAL_CATEGORY_TINTS[entry.category] ?? MATERIAL_CATEGORY_TINTS.Utility }}>
            <Mark size={Math.round(size * 0.55)} />
        </span>
    );
};

/** A node's preview image, painted as the previewer publishes it (and only when its own image changed). */
const NodePreview = React.memo(({ nodeId }: { nodeId: string }) => {
    const canvas = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        let painted: ImageData | undefined;
        const paint = () => {
            const image = nodePreviewImages.get(nodeId);
            const context = canvas.current?.getContext('2d');
            if (!image || image === painted || !context) return;
            context.putImageData(image, 0, 0);
            painted = image;
        };
        paint();
        return nodePreviewImages.subscribe(paint);
    }, [nodeId]);
    return <canvas ref={canvas} width={NODE_PREVIEW_SIZE} height={NODE_PREVIEW_SIZE} className="rounded border border-line bg-well" style={{ width: NODE_PREVIEW_SIZE, height: NODE_PREVIEW_SIZE }} />;
});
NodePreview.displayName = 'NodePreview';

const renderBody = (nodeId: string, view: NodeView): React.ReactNode => (view.body ? <NodePreview nodeId={nodeId} /> : null);

const pins = (node: EditableNode<MaterialGraphNode>): PinSet => {
    const definition = getMaterialNodeDefinition(node.type);
    return {
        inputs: (definition?.inputs ?? []).map((input) => ({ key: input.key, kind: input.type })),
        outputs: (definition?.outputs ?? []).map((output) => ({ key: output.key, kind: output.type })),
    };
};

export const MaterialGraphCanvas: React.FC<MaterialGraphCanvasProps> = (props) => {
    const { graph, selection, selectedComment, previews, unused, canUndo, canRedo, onUndo, onRedo, onTogglePreviews, nodeErrors } = props;
    const latest = useRef(props);
    latest.current = props;

    const editable = useMemo<EditableGraph<MaterialGraphNode>>(() => ({
        nodes: graph.nodes.map(toNode),
        links: graph.links.map(toLink),
        frames: (graph.comments ?? []).map(toFrame),
    }), [graph.comments, graph.links, graph.nodes]);

    const autoTypes = useMemo(() => resolveAutoTypes(graph), [graph]);
    // Each node's view, the same object while it shows the same (so only changed cards redraw).
    const viewCache = useRef(new Map<string, { key: string; view: NodeView }>());
    const views = useMemo(() => {
        const result = new Map<string, NodeView>();
        for (const node of graph.nodes) {
            const error = nodeErrors?.[node.id];
            const shown = materialNodeView(node, { autoTypes, previews, unused: unused.has(node.id) });
            const view = error ? { ...shown, error } : shown;
            const key = JSON.stringify(view);
            const cached = viewCache.current.get(node.id);
            if (cached?.key === key) result.set(node.id, cached.view);
            else { viewCache.current.set(node.id, { key, view }); result.set(node.id, view); }
        }
        return result;
    }, [autoTypes, graph.nodes, nodeErrors, previews, unused]);

    const adapter = useMemo<NodeGraphAdapter<MaterialGraphNode>>(() => ({
        kind: 'material',
        kinds: MATERIAL_KINDS,
        match: materialMatch,
        entries: ENTRIES,
        renderPicture,
        createNode: (type, at) => (getMaterialNodeDefinition(type) ? toNode(createNode(type, at)) : null),
        createReroute: (at) => toNode(createNode(REROUTE_NODE_TYPE, at)),
        pins,
        newId,
        copy: (current, ids) => {
            const clipboard = copyNodes(fromEditable(current, latest.current.graph), ids);
            return clipboard ? JSON.stringify(clipboard) : '';
        },
        paste: (text) => {
            const clipboard = readClipboard(text);
            if (!clipboard) return null;
            return { nodes: clipboard.nodes.map((node) => toNode(structuredClone(node))), links: clipboard.links.map((link) => toLink({ ...link })) };
        },
        looks: MATERIAL_LOOKS_KEPT,
        renderBody,
    }), []);

    const onEdit = useCallback((next: EditableGraph<MaterialGraphNode>, coalesce?: string) => {
        const current = latest.current.graph;
        const written = fromEditable(next, current);
        if (written !== current) latest.current.onChange(written, true, coalesce);
    }, []);
    const onSelect = useCallback((ids: string[], frame?: string | null) => latest.current.onSelect(ids, frame ?? null), []);

    return (
        <NodeGraphCanvas
            label="Material graph"
            graph={editable}
            views={views}
            adapter={adapter}
            selection={selection}
            selectedFrame={selectedComment}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={onUndo}
            onRedo={onRedo}
            undoKeys="workspace"
            onSelect={onSelect}
            onEdit={onEdit}
            toolbarExtra={(
                <IconButton label={previews ? 'Hide node previews' : 'Show node previews'} active={previews} onClick={onTogglePreviews}>
                    {previews ? <EyeIcon size={14} /> : <EyeOffIcon size={14} />}
                </IconButton>
            )}
        />
    );
};
