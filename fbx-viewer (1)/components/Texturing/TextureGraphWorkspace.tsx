import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CheckCircleIcon, DiceIcon, DownloadIcon, ExternalLinkIcon, InfoIcon, RefreshIcon, TrashIcon, WarningIcon } from '../UI/Icons';
import { useAssets } from '../../context/AssetContext';
import { useScene } from '../../context/SceneContext';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { materialLibrary, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import { AbortedError, unknownNodeMessage, type TextureGraphEvaluator } from '../../texturing/graph/evaluator';
import { MAX_SIZE_LOG2, MIN_SIZE_LOG2, coerceParameter, readTextureGraph, unknownNodeTypes } from '../../texturing/graph/document';
import { OUTPUT_NODE_TYPE, SUBGRAPH_NODE_TYPE } from '../../texturing/graph/nodes/io';
import { textureNodeDefinition, type GraphEntry, type GraphResolver } from '../../texturing/graph/registry';
import { bakeSignature, readStoredGraph, type StoredTextureGraph } from '../../texturing/graph/stored';
import { OUTPUT_CHANNELS, OUTPUT_CHANNEL_LABELS, type GraphParameter, type GraphParameterKind, type OutputChannel, type TexGraphNode, type TexParamDef, type TextureGraph } from '../../texturing/graph/types';
import { DEEP_EXPORT, ROLE_LABELS, encodeChannels, materialGraphForTextures, type ChannelImages, type ChannelTextureIds, type MaterialChannel, type PictureLayout, materialReadsPicture } from '../../texturing/materialOutput';
import { download, makeZip } from '../../texturing/zip';
import { Button, Segmented, Spinner } from '../UI/kit';
import { Select } from '../UI/Select';
import { COMMENT_COLORS, COMMENT_COLOR_NAMES, MAX_COMMENT_TITLE, addSubgraphNode, changeComment, materialHistory, type Point } from './graphEditing';
import { usePreviewMeshMaps, type PreviewShape } from './previewMeshMaps';
import { TextureGraphCanvas } from './TextureGraphCanvas';
import { DraftNumber, DraftText, ParamControl, TextureParamField, exposedKind } from './TextureParamField';
import { TextureGraphSession } from './textureGraphSession';
import { TextureView2D } from './TextureView2D';
import { TextureView3D } from './TextureView3D';
import { useTextureStore } from './useTextureStore';

/**
 * THE TEXTURE GRAPH WORKSPACE (a texture graph material in the Materials tab)
 *
 * The graph's canvas, the 2D view of one node, the 3D view of the material, and an inspector for
 * the selected node or comment, the graph (its size, seed and exposed parameters) and the material
 * made from it. Every edit redraws at once; "Update material" makes the pictures the engine draws
 * with. Undo covers the graph, its parameter values and the picture settings, and is kept per
 * material while others are open and when the Materials tab is left.
 */

const sizeLabel = (log2: number): string => `${2 ** log2}`;
/** Fixed sizes a node or the graph can have, 16 to 8192, as the document allows. */
const FIXED_SIZES = Array.from({ length: MAX_SIZE_LOG2 - MIN_SIZE_LOG2 + 1 }, (_, i) => MIN_SIZE_LOG2 + i).map((log2) => ({ value: log2, label: sizeLabel(log2) }));
/** Sizes relative to the input or the graph: from 1/64 to 16 times. */
const RELATIVE_SIZES = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4].map((offset) => ({ value: offset, label: offset === 0 ? 'Same' : offset < 0 ? `1/${2 ** -offset}` : `× ${2 ** offset}` }));
/** Sizes of the material's pictures (their longest side). */
const PICTURE_SIZES = [8, 9, 10, 11, 12, 13].map((log2) => ({ value: log2, label: `${2 ** log2}` }));
const PARAMETER_KINDS: ReadonlyArray<{ value: GraphParameterKind; label: string }> = [
    { value: 'float', label: 'Number' }, { value: 'int', label: 'Whole number' }, { value: 'bool', label: 'Switch' },
    { value: 'color', label: 'Colour' }, { value: 'vec2', label: 'Pair of numbers' }, { value: 'select', label: 'Choice' },
];

type InspectorTab = 'node' | 'graph' | 'material';

/** What an undo step brings back: everything about the material's graph but the pictures last made from it. */
interface GraphSnapshot {
    graph: TextureGraph;
    values: Record<string, unknown>;
    bakeSize: number;
    layout: PictureLayout;
    library?: boolean;
}

const snapshotOf = (stored: StoredTextureGraph): GraphSnapshot => ({ graph: stored.graph, values: stored.values, bakeSize: stored.bakeSize, layout: stored.layout, library: stored.library });

const sameGraph = (a: TextureGraph, b: TextureGraph): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);
const sameSnapshot = (a: GraphSnapshot, b: GraphSnapshot): boolean =>
    sameGraph(a.graph, b.graph) && JSON.stringify(a.values) === JSON.stringify(b.values) && a.bakeSize === b.bakeSize && a.layout === b.layout && Boolean(a.library) === Boolean(b.library);

/** The pictures' size: `bakeSize` on the longest side, the other side keeping the graph's proportions. */
const pictureSize = (graph: TextureGraph, bakeSize: number): { w: number; h: number } => {
    const longest = Math.max(graph.size.w, graph.size.h);
    const side = (own: number) => Math.min(MAX_SIZE_LOG2, Math.max(MIN_SIZE_LOG2, bakeSize - (longest - own)));
    return { w: side(graph.size.w), h: side(graph.size.h) };
};

/** A graph parameter's value control, by its kind; its range is the one set for it. */
const parameterDef = (parameter: GraphParameter): TexParamDef => ({
    key: parameter.name,
    label: parameter.label,
    kind: parameter.kind,
    default: parameter.default,
    min: parameter.min,
    max: parameter.max,
    step: parameter.step,
    options: parameter.options,
});

export const TextureGraphWorkspace: React.FC<{
    asset: MaterialAsset;
    assets: readonly MaterialAsset[];
    onSave: (next: MaterialAsset, immediately?: boolean) => void;
    onOpenAsset: (id: string) => void;
}> = ({ asset, assets, onSave, onOpenAsset }) => {
    const stored = useMemo(() => readStoredGraph(asset.textureGraph), [asset.textureGraph]);
    const graph = stored.graph;

    // Other graph materials, usable as nodes.
    const entries = useMemo(() => {
        const map = new Map<string, GraphEntry>();
        for (const candidate of assets) if (candidate.textureGraph) map.set(candidate.id, { id: candidate.id, name: candidate.name, graph: readStoredGraph(candidate.textureGraph).graph });
        return map;
    }, [assets]);
    const resolve: GraphResolver = useCallback((id) => entries.get(id), [entries]);
    const textureLookup = useMemo(() => materialLibrary.textureLookup(false), []);
    const lookup = useCallback((id: string) => textureLookup(id, 'map'), [textureLookup]);

    // One session per material, made and let go with the workspace; edits reach it through setGraph.
    const [session, setSession] = useState<TextureGraphSession | null>(null);
    const latest = useRef({ graph, resolve, lookup });
    latest.current = { graph, resolve, lookup };
    useEffect(() => {
        const made = new TextureGraphSession(latest.current.graph, (id) => latest.current.resolve(id), (id) => latest.current.lookup(id));
        setSession(made);
        return () => {
            made.dispose();
            // Spare pictures kept for reuse are given back to the GPU once the graph is closed.
            made.gpu.trimPool(0);
        };
    }, [asset.id]);
    useEffect(() => { session?.setGraph(graph, stored.values); }, [graph, session, stored.values]);
    // A picture finishing loading, or a used graph changing, redraws what depends on it.
    const libraryVersion = useSyncExternalStore((listener) => materialLibrary.subscribe(listener), () => materialLibrary.version);
    useEffect(() => { session?.refresh(); }, [libraryVersion, entries, session]);
    if (!session) return <div className="flex-1 bg-[#121214]" />;
    return <Workspace asset={asset} onSave={onSave} onOpenAsset={onOpenAsset} session={session} stored={stored} entries={entries} resolve={resolve} libraryVersion={libraryVersion} />;
};

const Workspace: React.FC<{
    asset: MaterialAsset;
    onSave: (next: MaterialAsset, immediately?: boolean) => void;
    onOpenAsset: (id: string) => void;
    session: TextureGraphSession;
    stored: StoredTextureGraph;
    entries: Map<string, GraphEntry>;
    resolve: GraphResolver;
    libraryVersion: number;
}> = ({ asset, onSave, onOpenAsset, session, stored, entries, resolve, libraryVersion }) => {
    const { textures } = useAssets();
    const { models } = useScene();
    const textureStore = useTextureStore();
    const graph = stored.graph;
    const sessionVersion = useSyncExternalStore(session.subscribe, session.getVersion);

    const [selection, setSelection] = useState<string[]>([]);
    const [selectedComment, setSelectedComment] = useState<string | null>(null);
    const [viewed, setViewed] = useState<string | null>(null);
    const [viewedOutput, setViewedOutput] = useState<string | undefined>(undefined);
    const [tab, setTab] = useState<InspectorTab>('material');
    const [baking, setBaking] = useState<string | null>(null);
    const [message, setMessage] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
    const [shape, setShape] = useState<PreviewShape>('sphere');
    const [surfaceId, setSurfaceId] = useState<string | null>(null);
    // What could not be opened, read once as the graph opens: the first change saves it without it.
    const [problems, setProblems] = useState(() => readTextureGraph((asset.textureGraph as { graph?: unknown } | undefined)?.graph ?? null).problems);
    const dragBase = useRef<GraphSnapshot | null>(null);
    const [, setHistoryVersion] = useState(0);
    // Kept outside this screen, so it survives switching material and leaving the tab.
    const history = useMemo(() => materialHistory<GraphSnapshot>(asset.id), [asset.id]);
    const meshMaps = usePreviewMeshMaps(session, graph, resolve, shape, surfaceId, libraryVersion);

    // The first output is in the 2D view to begin with.
    useEffect(() => {
        if (viewed && graph.nodes.some((node) => node.id === viewed)) return;
        setViewed(graph.nodes.find((node) => node.type === OUTPUT_NODE_TYPE)?.id ?? graph.nodes[0]?.id ?? null);
    }, [graph.nodes, viewed]);

    /** What the material's document holds now (edits may have landed since this screen last drew). */
    const currentStored = useCallback(() => readStoredGraph((materialLibrary.get(asset.id) ?? asset).textureGraph), [asset]);

    const commitStored = useCallback((next: StoredTextureGraph, immediately = false) => {
        const current = materialLibrary.get(asset.id) ?? asset;
        const updated: MaterialAsset = { ...current, textureGraph: next as unknown as Record<string, unknown> };
        materialLibrary.upsert(updated);
        onSave(updated, immediately);
        setProblems((list) => (list.length ? [] : list));
    }, [asset, onSave]);

    /**
     * Changes the graph. `commit` false is a step of a drag, recorded as one undo step when it ends;
     * `coalesce` merges quick edits of one value into one step.
     */
    const update = useCallback((nextGraph: TextureGraph, commit: boolean, coalesce?: string) => {
        const current = currentStored();
        if (!commit) {
            if (!dragBase.current) dragBase.current = snapshotOf(current);
            const updated: MaterialAsset = { ...(materialLibrary.get(asset.id) ?? asset), textureGraph: { ...current, graph: nextGraph } as unknown as Record<string, unknown> };
            materialLibrary.upsert(updated);
            return;
        }
        const base = dragBase.current ?? snapshotOf(current);
        dragBase.current = null;
        if (sameGraph(base.graph, nextGraph)) {
            // Nothing really changed (a box confirmed its old value, a node was dropped where it started):
            // no undo step, and no save unless a drag left the stored graph elsewhere.
            if (!sameGraph(current.graph, nextGraph)) commitStored({ ...current, graph: nextGraph });
            return;
        }
        history.record(base, coalesce);
        setHistoryVersion((value) => value + 1);
        commitStored({ ...current, graph: nextGraph });
    }, [asset, commitStored, currentStored, history]);

    /** Changes parameter values or the picture settings (and the graph with them), as one undo step. */
    const change = useCallback((patch: Partial<GraphSnapshot>, coalesce?: string) => {
        const current = currentStored();
        const before = snapshotOf(current);
        const after: GraphSnapshot = { ...before, ...patch };
        if (sameSnapshot(before, after)) return;
        history.record(before, coalesce);
        setHistoryVersion((value) => value + 1);
        commitStored({ ...current, ...after, library: after.library || undefined });
    }, [commitStored, currentStored, history]);

    const travel = (direction: 'undo' | 'redo') => {
        const current = currentStored();
        dragBase.current = null;
        const target = direction === 'undo' ? history.undo(snapshotOf(current)) : history.redo(snapshotOf(current));
        if (!target) return;
        // The pictures last made stay as they are: they are what models show until the material is updated.
        commitStored({ ...current, ...target, library: target.library || undefined });
        setHistoryVersion((value) => value + 1);
    };

    const select = useCallback((ids: string[], comment: string | null = null) => {
        setSelection(ids);
        setSelectedComment(comment);
        if (ids.length === 1 || comment) setTab('node');
    }, []);

    const view = useCallback((nodeId: string) => {
        setViewed(nodeId);
        setViewedOutput(undefined);
    }, []);

    const addSubgraph = useCallback((graphId: string, at: Point): TexGraphNode | null => {
        if (graphId === asset.id) {
            setMessage({ text: 'A graph cannot use itself.', tone: 'error' });
            return null;
        }
        const used = entries.get(graphId);
        if (!used) return null;
        return addSubgraphNode(graph, graphId, used.graph, at).node;
    }, [asset.id, entries, graph]);

    // ---- nodes this build does not have, and what could not be opened ----
    const unknownTypes = useMemo(() => unknownNodeTypes(graph), [graph]);
    const notice = problems.length || unknownTypes.length ? (
        <div className="space-y-1">
            {problems.length > 0 && <p>Some of this graph could not be opened: {problems.join(' ')} The next change saves it without them.</p>}
            {unknownTypes.length > 0 && <p>This graph uses node{unknownTypes.length === 1 ? '' : 's'} this version of the editor does not have ({unknownTypes.join(', ')}). {unknownTypes.length === 1 ? 'It is' : 'They are'} kept with settings and wires, and draw{unknownTypes.length === 1 ? 's' : ''} nothing here.</p>}
        </div>
    ) : null;

    // ---- making the material's pictures ----
    const signature = useMemo(() => bakeSignature(stored, resolve), [resolve, stored]);
    const upToDate = stored.baked?.signature === signature;
    const hasOutputs = graph.nodes.some((node) => node.type === OUTPUT_NODE_TYPE && node.params.channel !== 'custom');
    const outSize = pictureSize(graph, stored.bakeSize);
    const madeSize = pictureSize(graph, stored.baked?.size ?? stored.bakeSize);

    /**
     * Each channel's image at the pictures' size, held until `done` is called. The editing results are
     * used as they are when the size is the editing size and nothing has changed since they were drawn;
     * other sizes are drawn by an evaluator the session keeps, which keeps only the outputs afterwards,
     * so making the pictures again at that size with nothing changed draws nothing new.
     */
    const renderChannels = async (size: { w: number; h: number }): Promise<{ images: ChannelImages; done: () => void }> => {
        const outputs = graph.nodes.filter((node) => node.type === OUTPUT_NODE_TYPE);
        const request = { graph, parameters: stored.values, targets: outputs.map((node) => node.id) };
        // The material's pictures never use the 3D view's mesh maps: they are drawn with stand-ins for them.
        const editingSize = size.w === graph.size.w && size.h === graph.size.h;
        const reuse = editingSize && !session.busy && !Object.keys(session.external).length && session.evaluator.upToDate(request);
        const evaluator: TextureGraphEvaluator = reuse ? session.evaluator : session.outputEvaluator();
        // Only the outputs are kept by the evaluator drawing at another size, done or failed.
        const trim = () => { if (!reuse) evaluator.retainOnly(new Set(outputs.map((node) => node.id))); };
        const images: ChannelImages = {};
        try {
            const states = await evaluator.evaluate(reuse ? request : { ...request, size });
            for (const node of outputs) {
                const channel = node.params.channel as OutputChannel;
                if (channel === 'custom' || images[channel as MaterialChannel]) continue;
                const state = states.get(node.id);
                if (state?.error) throw new Error(`${OUTPUT_CHANNEL_LABELS[channel]}: ${state.error}`);
                if (state?.outputs.out) images[channel as MaterialChannel] = state.outputs.out;
            }
        } catch (error) {
            trim();
            throw error;
        }
        // Held while they are written out: an edit drawing meanwhile must not hand them back to the pool.
        const held = Object.values(images).map((image) => session.gpu.retain(image));
        return {
            images,
            done: () => {
                for (const image of held) session.gpu.release(image);
                trim();
            },
        };
    };

    const updateMaterial = async () => {
        if (baking) return;
        setBaking('Drawing at full size…');
        setMessage(null);
        let done = () => undefined as void;
        const size = pictureSize(graph, stored.bakeSize);
        const width = 2 ** size.w;
        const height = 2 ** size.h;
        try {
            const rendered = await renderChannels(size);
            done = rendered.done;
            setBaking('Saving pictures…');
            const pictures = await encodeChannels(session.gpu, rendered.images, width, height, stored.layout, true);
            const ids: ChannelTextureIds = {};
            for (const picture of pictures) {
                ids[picture.role] = await textureStore.store(picture.blob, `${asset.name} ${ROLE_LABELS[picture.role]}`, { width: picture.width, height: picture.height }, `Texture graphs/${asset.name}`);
            }
            const current = materialLibrary.get(asset.id) ?? asset;
            const latestStored = readStoredGraph(current.textureGraph);
            const previous = Object.values(latestStored.baked?.textures ?? {}).filter((id): id is string => Boolean(id));
            const next: MaterialAsset = {
                ...current,
                graph: materialGraphForTextures(ids, { opacityMode: rendered.images.opacity ? 'masked' : undefined }),
                textureGraph: { ...latestStored, baked: { textures: ids, signature: bakeSignature(latestStored, resolve), size: latestStored.bakeSize, at: Date.now() } } as unknown as Record<string, unknown>,
            };
            materialLibrary.upsert(next);
            onSave(next, true);
            void textureStore.discard(previous);
            const drawn = pictures.filter((picture) => materialReadsPicture(picture.role)).length;
            setMessage({ text: `The material now draws with ${drawn} new picture${drawn === 1 ? '' : 's'} at ${width} × ${height}.`, tone: 'info' });
        } catch (error) {
            if (!(error instanceof AbortedError)) {
                frontendDiagnostics.failure('texture_graph_bake_failed', error);
                setMessage({ text: error instanceof Error ? error.message : 'The pictures could not be made.', tone: 'error' });
            }
        } finally {
            done();
            setBaking(null);
        }
    };

    const downloadPictures = async () => {
        if (baking) return;
        setBaking('Drawing pictures to download…');
        let done = () => undefined as void;
        const size = pictureSize(graph, stored.bakeSize);
        const width = 2 ** size.w;
        const height = 2 ** size.h;
        try {
            const rendered = await renderChannels(size);
            done = rendered.done;
            const pictures = await encodeChannels(session.gpu, rendered.images, width, height, 'separate', true, DEEP_EXPORT);
            const base = asset.name.replace(/[^\w-]+/g, '_') || 'material';
            const zip = await makeZip(pictures.map((picture) => ({ name: `${base}_${picture.role}.png`, data: picture.blob })));
            download(zip, `${base}_${width === height ? width : `${width}x${height}`}.zip`);
        } catch (error) {
            if (!(error instanceof AbortedError)) setMessage({ text: error instanceof Error ? error.message : 'The pictures could not be made.', tone: 'error' });
        } finally {
            done();
            setBaking(null);
        }
    };

    // ---- inspector parts ----
    const nodes = new Set(graph.nodes.map((node) => node.id));
    const selected = selection.filter((id) => nodes.has(id));
    const single = selected.length === 1 ? graph.nodes.find((node) => node.id === selected[0]) ?? null : null;
    const comment = !selected.length && selectedComment ? graph.comments?.find((candidate) => candidate.id === selectedComment) ?? null : null;
    void sessionVersion;

    const changeNode = (node: TexGraphNode, coalesce?: string) => update({ ...graph, nodes: graph.nodes.map((candidate) => (candidate.id === node.id ? node : candidate)) }, true, coalesce);

    const changeParameter = (index: number, patch: Partial<GraphParameter>, coalesce?: string) =>
        change({ graph: { ...graph, parameters: graph.parameters.map((parameter, at) => (at === index ? { ...parameter, ...patch } : parameter)) } }, coalesce);

    const expose = (node: TexGraphNode, param: TexParamDef) => {
        const kind = exposedKind(param);
        if (!kind) return;
        const base = param.key.replace(/[^A-Za-z0-9_]/g, '') || 'value';
        let name = base;
        for (let n = 2; graph.parameters.some((parameter) => parameter.name === name); n++) name = `${base}${n}`;
        const parameter: GraphParameter = {
            name,
            label: param.label.replace(/\s*\(.*\)$/, ''),
            kind,
            default: coerceParameter(kind, node.params[param.key] ?? param.default, param.options),
            ...(param.min !== undefined ? { min: param.min } : {}),
            ...(param.softMax ?? param.max) !== undefined ? { max: param.softMax ?? param.max } : {},
            ...(param.step !== undefined ? { step: param.step } : {}),
            ...(param.options ? { options: param.options.map((option) => ({ ...option })) } : {}),
        };
        const nextGraph: TextureGraph = {
            ...graph,
            parameters: [...graph.parameters, parameter],
            nodes: graph.nodes.map((candidate) => (candidate.id === node.id ? { ...candidate, params: { ...candidate.params, [param.key]: { $bind: name } } } : candidate)),
        };
        update(nextGraph, true);
        setMessage({ text: `"${parameter.label}" is now a parameter of the graph: set it in Graph.`, tone: 'info' });
    };

    const commentInspector = (current: NonNullable<typeof comment>) => (
        <div className="space-y-3">
            <div className="text-xs font-semibold text-zinc-100">Comment</div>
            <label className="block space-y-1">
                <span className="text-2xs text-zinc-400">Title</span>
                <DraftText label="Comment title" value={current.text} maxLength={MAX_COMMENT_TITLE} allowEmpty placeholder="Comment" className="w-full"
                    onCommit={(text) => update(changeComment(graph, current.id, { text }), true)} />
            </label>
            <div className="space-y-1">
                <span className="text-2xs text-zinc-400">Colour</span>
                <div role="radiogroup" aria-label="Comment colour" className="flex flex-wrap gap-1.5">
                    {COMMENT_COLORS.map((color) => (
                        <button key={color} type="button" role="radio" aria-checked={current.color === color} aria-label={COMMENT_COLOR_NAMES[color] ?? color} title={COMMENT_COLOR_NAMES[color] ?? color}
                            onClick={() => update(changeComment(graph, current.id, { color }), true)}
                            className={`h-5 w-5 rounded border ${current.color === color ? 'border-white ring-1 ring-white/60' : 'border-zinc-700 hover:border-zinc-500'}`} style={{ background: color }} />
                    ))}
                </div>
            </div>
            <p className="text-2xs leading-snug text-zinc-500">Double-click a comment's title on the canvas to rename it there. Dragging its title moves the nodes inside with it.</p>
        </div>
    );

    const nodeInspector = () => {
        if (comment) return commentInspector(comment);
        if (!single) {
            return <p className="text-2xs leading-snug text-zinc-500">{selected.length > 1 ? `${selected.length} nodes selected. Delete removes them, C puts a comment round them.` : 'Select a node or a comment to change its settings. Double-click a node to look at it in the 2D view.'}</p>;
        }
        const definition = textureNodeDefinition(single, resolve);
        if (!definition) {
            return (
                <div className="space-y-2">
                    <div className="text-xs font-semibold text-zinc-100">Not available: {single.type}</div>
                    <div className="flex gap-1.5 rounded border border-amber-900 bg-amber-950/40 p-1.5 text-2xs text-amber-200"><WarningIcon size={12} className="mt-px shrink-0" /><span>{unknownNodeMessage(single.type)}</span></div>
                    <p className="text-2xs leading-snug text-zinc-500">It draws nothing here, and nodes it feeds read their input as unwired. Delete it to take it out of the graph.</p>
                </div>
            );
        }
        const state = session.state(single.id);
        const isOutput = single.type === OUTPUT_NODE_TYPE;
        const sizeMode = single.size?.mode ?? definition.sizeFrom;
        const fixed = sizeMode === 'absolute';
        const sizeW = single.size?.w ?? (fixed ? graph.size.w : 0);
        const sizeH = single.size?.h ?? (fixed ? graph.size.h : 0);
        return (
            <div className="space-y-3">
                <div>
                    <div className="text-xs font-semibold text-zinc-100">{definition.label}</div>
                    <p className="mt-0.5 text-2xs leading-snug text-zinc-500">{definition.description}</p>
                </div>
                {state?.error && <div className="flex gap-1.5 rounded border border-red-900 bg-red-950/50 p-1.5 text-2xs text-red-200"><WarningIcon size={12} className="mt-px shrink-0" /><span className="whitespace-pre-wrap font-mono">{state.error}</span></div>}
                {single.type === SUBGRAPH_NODE_TYPE && typeof single.params.graph === 'string' && entries.has(single.params.graph) && (
                    <Button size="sm" icon={<ExternalLinkIcon size={12} />} onClick={() => onOpenAsset(single.params.graph as string)}>Open {entries.get(single.params.graph)!.name}</Button>
                )}
                {isOutput && (
                    <div className="space-y-1">
                        <span className="text-2xs text-zinc-400">Channel</span>
                        <Select value={String(single.params.channel)} options={OUTPUT_CHANNELS.map((channel) => ({ value: channel, label: OUTPUT_CHANNEL_LABELS[channel] }))}
                            onChange={(value) => changeNode({ ...single, params: { ...single.params, channel: value } })} className="w-full" />
                    </div>
                )}
                {definition.params.filter((param) => !(isOutput && param.key === 'channel') && param.kind !== 'graph' && (!param.showIf || param.showIf(single.params))).map((param) => (
                    <TextureParamField
                        key={param.key}
                        param={param}
                        value={single.params[param.key]}
                        parameters={graph.parameters}
                        textures={textures}
                        problem={state?.warnings?.find((warning) => warning.includes(`"${param.label}"`))}
                        onChange={(value) => changeNode({ ...single, params: { ...single.params, [param.key]: value } }, `${single.id}:${param.key}`)}
                        onExpose={() => expose(single, param)}
                    />
                ))}
                {!isOutput && (
                    <div className="space-y-1.5 border-t border-zinc-800 pt-2">
                        <div className="text-2xs font-semibold text-zinc-400">Size and precision</div>
                        <Select value={sizeMode} options={[{ value: 'input', label: 'Follow its input' }, { value: 'graph', label: 'Follow the graph' }, { value: 'absolute', label: 'Fixed size' }]}
                            onChange={(mode) => changeNode({ ...single, size: { mode, w: mode === 'absolute' ? graph.size.w : 0, h: mode === 'absolute' ? graph.size.h : 0 } })} className="w-full" />
                        <div className="grid grid-cols-[auto_1fr_auto_1fr] items-center gap-1.5">
                            <span className="text-2xs text-zinc-500">Width</span>
                            <Select value={sizeW} options={fixed ? FIXED_SIZES : RELATIVE_SIZES} placeholder="Width" onChange={(value) => changeNode({ ...single, size: { mode: sizeMode, w: Number(value), h: sizeH } })} />
                            <span className="text-2xs text-zinc-500">Height</span>
                            <Select value={sizeH} options={fixed ? FIXED_SIZES : RELATIVE_SIZES} placeholder="Height" onChange={(value) => changeNode({ ...single, size: { mode: sizeMode, w: sizeW, h: Number(value) } })} />
                        </div>
                        <Segmented value={String(single.precision ?? 'auto')} options={[{ value: 'auto', label: 'Auto', hint: 'As its inputs keep it' }, { value: '8', label: '8-bit', hint: 'Steps of 1/255, as a picture keeps them' }, { value: '16', label: 'Half float', hint: '16-bit floating point: fine steps for heights and masks' }, { value: '32', label: 'Full float', hint: '32-bit floating point: exact, and four times the memory of 8-bit' }]}
                            onChange={(value) => changeNode({ ...single, precision: value === 'auto' ? undefined : Number(value) as 8 | 16 | 32 })} label="Precision" />
                        {state && <p className="text-2xs text-zinc-500">{state.width} × {state.height}, drawn in {state.milliseconds < 1 ? 'under 1' : Math.round(state.milliseconds)} ms</p>}
                    </div>
                )}
                {definition.outputs.length > 1 && (
                    <div className="space-y-1">
                        <span className="text-2xs text-zinc-400">Shown in 2D</span>
                        <Select value={viewedOutput ?? definition.outputs[0].key} options={definition.outputs.map((port) => ({ value: port.key, label: port.label }))}
                            onChange={(value) => { setViewed(single.id); setViewedOutput(String(value)); }} className="w-full" />
                    </div>
                )}
            </div>
        );
    };

    const graphInspector = () => (
        <div className="space-y-3">
            <div className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1.5">
                <span className="text-2xs text-zinc-400">Size while editing</span>
                <div className="flex items-center gap-1">
                    <Select value={graph.size.w} options={FIXED_SIZES} placeholder="Width" onChange={(value) => update({ ...graph, size: { w: Number(value), h: graph.size.h } }, true)} className="w-[68px]" />
                    <span className="text-2xs text-zinc-500">×</span>
                    <Select value={graph.size.h} options={FIXED_SIZES} placeholder="Height" onChange={(value) => update({ ...graph, size: { w: graph.size.w, h: Number(value) } }, true)} className="w-[68px]" />
                </div>
                <span className="text-2xs text-zinc-400">Random seed</span>
                <div className="flex items-center gap-1">
                    <DraftNumber label="Graph random seed" value={graph.seed} integer limit={(seed) => Math.max(0, Math.min(999, seed))} onCommit={(seed) => update({ ...graph, seed }, true)} className="w-16" />
                    <button aria-label="Another seed" title="Another seed" onClick={() => update({ ...graph, seed: Math.floor(Math.random() * 1000) }, true)} className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white"><DiceIcon size={13} /></button>
                </div>
            </div>
            {Math.max(graph.size.w, graph.size.h) >= 12 && <p className="text-2xs leading-snug text-zinc-500">Large editing sizes redraw slowly; the material's pictures can be larger than the editing size.</p>}
            <div className="space-y-2 border-t border-zinc-800 pt-2">
                <div className="flex items-center">
                    <span className="flex-1 text-2xs font-semibold text-zinc-300">Parameters</span>
                    <Select value="" placeholder="Add…" options={[...PARAMETER_KINDS]} onChange={(kind) => {
                        let name = 'value';
                        for (let n = 2; graph.parameters.some((parameter) => parameter.name === name); n++) name = `value${n}`;
                        const parameter: GraphParameter = { name, label: name, kind, default: coerceParameter(kind, kind === 'select' ? 'a' : kind === 'float' ? 0.5 : undefined, kind === 'select' ? [{ value: 'a' }] : undefined), ...(kind === 'float' ? { min: 0, max: 1 } : kind === 'int' ? { min: 0, max: 10 } : {}), ...(kind === 'select' ? { options: [{ value: 'a', label: 'First' }, { value: 'b', label: 'Second' }] } : {}) };
                        change({ graph: { ...graph, parameters: [...graph.parameters, parameter] } });
                    }} className="w-24" />
                </div>
                {graph.parameters.length === 0 && <p className="text-2xs leading-snug text-zinc-500">None yet. Use the link button beside any node setting to expose it here; materials using this graph set them.</p>}
                {graph.parameters.map((parameter, index) => (
                    <div key={parameter.name} className="space-y-1.5 rounded border border-zinc-800 bg-zinc-900/60 p-2">
                        <div className="flex items-center gap-1">
                            <DraftText label="Parameter label" value={parameter.label} className="min-w-0 flex-1" onCommit={(label) => changeParameter(index, { label: label.trim().slice(0, 64) || parameter.name })} />
                            <button aria-label={`Remove ${parameter.label}`} onClick={() => {
                                // Settings that followed it keep the value it had.
                                const value = stored.values[parameter.name] ?? parameter.default;
                                const nextGraph = { ...graph, parameters: graph.parameters.filter((_, i) => i !== index), nodes: graph.nodes.map((node) => ({ ...node, params: Object.fromEntries(Object.entries(node.params).map(([key, v]) => [key, v && typeof v === 'object' && (v as { $bind?: string }).$bind === parameter.name ? structuredClone(value) : v])) })) };
                                update(nextGraph, true);
                            }} className="rounded p-1 text-zinc-500 hover:text-red-400"><TrashIcon size={12} /></button>
                        </div>
                        <div className="flex items-center gap-1 text-2xs text-zinc-500">
                            <span>Name in formulas</span>
                            <span className="font-mono text-zinc-300">{parameter.name}</span>
                            <span className="flex-1" />
                            <span>{PARAMETER_KINDS.find((kind) => kind.value === parameter.kind)?.label}</span>
                        </div>
                        {(parameter.kind === 'float' || parameter.kind === 'int') && (
                            <div className="flex items-center gap-1 text-2xs text-zinc-500">
                                <span>From</span>
                                {/* Typed, then kept on Enter or on leaving the box: one undo step, never a half-typed number. */}
                                <DraftNumber label="Lowest" value={parameter.min ?? 0} integer={parameter.kind === 'int'} className="w-14"
                                    onCommit={(min) => changeParameter(index, { min, max: Math.max(min, parameter.max ?? 1) })} />
                                <span>to</span>
                                <DraftNumber label="Highest" value={parameter.max ?? 1} integer={parameter.kind === 'int'} className="w-14"
                                    onCommit={(max) => changeParameter(index, { max, min: Math.min(max, parameter.min ?? 0) })} />
                            </div>
                        )}
                        <div className="flex items-center gap-2">
                            <span className="text-2xs text-zinc-400">Value</span>
                            <div className="min-w-0 flex-1">
                                <ParamControl param={parameterDef(parameter)} value={stored.values[parameter.name] ?? parameter.default} textures={textures}
                                    onChange={(value) => change({ values: { ...currentStored().values, [parameter.name]: coerceParameter(parameter.kind, value, parameter.options) } }, `value:${parameter.name}`)} />
                            </div>
                        </div>
                    </div>
                ))}
            </div>
            <div className="space-y-1 border-t border-zinc-800 pt-2">
                <label className="flex items-center gap-2 text-2xs text-zinc-400">
                    <input type="checkbox" checked={Boolean(stored.library)} onChange={(event) => change({ library: event.target.checked || undefined })} className="accent-sky-500" />
                    Mainly for use inside other graphs
                </label>
            </div>
        </div>
    );

    const materialInspector = () => (
        <div className="space-y-3">
            <div className={`flex items-start gap-1.5 rounded border p-2 text-2xs ${upToDate ? 'border-emerald-900 bg-emerald-950/40 text-emerald-200' : 'border-amber-900 bg-amber-950/40 text-amber-200'}`}>
                {upToDate ? <CheckCircleIcon size={13} className="mt-px shrink-0" /> : <RefreshIcon size={13} className="mt-px shrink-0" />}
                <span>{upToDate
                    ? `Models with this material show the graph as it is now (${2 ** madeSize.w} × ${2 ** madeSize.h} pixels).`
                    : stored.baked ? 'The graph has changed since the material was last updated. Models still show the earlier pictures.' : 'Models with this material show nothing of the graph until the material is updated.'}</span>
            </div>
            <Button variant="primary" className="w-full justify-center" disabled={Boolean(baking) || !hasOutputs} onClick={() => void updateMaterial()} icon={baking ? <Spinner /> : <RefreshIcon size={13} />}>
                {baking ?? 'Update material'}
            </Button>
            {!hasOutputs && <p className="text-2xs text-zinc-500">Add an Output node for a channel (base colour, normal...) to make a material.</p>}
            <div className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1.5">
                <span className="text-2xs text-zinc-400">{graph.size.w === graph.size.h ? 'Picture size' : 'Picture size (longest side)'}</span>
                <Select value={stored.bakeSize} options={PICTURE_SIZES} onChange={(value) => change({ bakeSize: Number(value) })} className="w-32" />
                <span className="text-2xs text-zinc-400">Pictures</span>
                <Select value={stored.layout} options={[{ value: 'engine', label: 'Packed (fewer)' }, { value: 'separate', label: 'One per channel' }]} onChange={(value) => change({ layout: value === 'separate' ? 'separate' : 'engine' })} className="w-32" />
            </div>
            {graph.size.w !== graph.size.h && <p className="text-2xs text-zinc-500">The pictures keep the graph's proportions: {2 ** outSize.w} × {2 ** outSize.h}.</p>}
            <p className="text-2xs leading-snug text-zinc-500">Packed keeps occlusion, roughness and metallic in one picture's red, green and blue, which the engine reads in one go.</p>
            {meshMaps.reads && (
                <div className="flex gap-1.5 rounded border border-zinc-800 bg-zinc-900/60 p-2 text-2xs leading-snug text-zinc-400">
                    <InfoIcon size={12} className="mt-px shrink-0 text-zinc-500" />
                    <span>This graph reads mesh maps. The material's pictures are made with stand-ins for them, since the material can go on any model; the maps in the 3D view are for looking only. To draw it with a model's own maps, use the graph as a fill or a smart mask in the Paint tab.</span>
                </div>
            )}
            <Button size="sm" className="w-full justify-center" disabled={Boolean(baking) || !hasOutputs} onClick={() => void downloadPictures()} icon={<DownloadIcon size={12} />}>Download pictures</Button>
            {stored.baked && (
                <div className="space-y-1 border-t border-zinc-800 pt-2">
                    <div className="text-2xs font-semibold text-zinc-400">Pictures the material draws with</div>
                    {Object.entries(stored.baked.textures).map(([role, id]) => (
                        <div key={role} className="flex justify-between text-2xs text-zinc-500"><span>{ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role}</span><span className="truncate pl-2 text-zinc-400">{textures.find((texture) => texture.id === id)?.name ?? 'missing'}</span></div>
                    ))}
                </div>
            )}
        </div>
    );

    return (
        <div className="flex min-h-0 min-w-0 flex-1">
            <TextureGraphCanvas
                key={asset.id}
                graph={graph}
                session={session}
                resolve={resolve}
                graphs={[...entries.values()].filter((entry) => entry.id !== asset.id).map((entry) => ({ id: entry.id, name: entry.name }))}
                selection={new Set(selected)}
                selectedComment={selectedComment}
                viewed={viewed}
                canUndo={history.canUndo}
                canRedo={history.canRedo}
                notice={notice}
                onSelect={select}
                onView={view}
                onChange={update}
                onAddSubgraph={addSubgraph}
                onUndo={() => travel('undo')}
                onRedo={() => travel('redo')}
            />
            <div className="flex w-[360px] shrink-0 flex-col border-l border-zinc-800 bg-zinc-950">
                <div className="flex min-h-0 flex-1 flex-col border-b border-zinc-800">
                    <TextureView2D session={session} nodeId={viewed} output={viewedOutput} label={(() => {
                        const node = graph.nodes.find((candidate) => candidate.id === viewed);
                        if (!node) return '2D';
                        const definition = textureNodeDefinition(node, resolve);
                        return node.type === OUTPUT_NODE_TYPE ? `Output: ${OUTPUT_CHANNEL_LABELS[node.params.channel as OutputChannel] ?? ''}` : definition?.label ?? '2D';
                    })()} />
                </div>
                <div className="flex min-h-0 flex-1 flex-col">
                    <TextureView3D gpu={session.gpu} preview={session.preview} version={session.preview.version} models={models.filter((model) => model.category !== 'Animation')}
                        shape={shape} onShapeChange={setShape} meshMaps={meshMaps} onSurfaceChange={setSurfaceId} />
                </div>
            </div>
            <aside className="flex w-[300px] shrink-0 flex-col border-l border-zinc-800 bg-zinc-950">
                <div className="border-b border-zinc-800 p-2">
                    <Segmented value={tab} options={[{ value: 'node', label: 'Node' }, { value: 'graph', label: 'Graph' }, { value: 'material', label: 'Material' }]} onChange={setTab} label="Inspector" />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                    {message && <p className={`mb-2 text-2xs ${message.tone === 'error' ? 'text-red-400' : 'text-sky-300'}`}>{message.text}</p>}
                    {tab === 'node' ? nodeInspector() : tab === 'graph' ? graphInspector() : materialInspector()}
                </div>
            </aside>
        </div>
    );
};

/** A new texture graph material, ready to edit. */
export const newTextureGraphStored = (graph: TextureGraph): Record<string, unknown> => ({ graph, values: {}, bakeSize: 11, layout: 'engine' });
