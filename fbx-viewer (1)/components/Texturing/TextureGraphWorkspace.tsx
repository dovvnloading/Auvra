import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CompressionBadge } from '../Materials/CompressionBadge';
import { ArrowLeftIcon, CheckCircleIcon, ChevronRightIcon, DiceIcon, ExternalLinkIcon, FlowIcon, InfoIcon, LayersIcon, RefreshIcon, WarningIcon } from '../UI/Icons';
import { useAssets } from '../../context/AssetContext';
import { useScene } from '../../context/SceneContext';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { projectService } from '../../utils/projectService';
import { planTextureParameterRename, requiresProjectWideParameterRename } from '../../texturing/graph/renameProjectParameter';
import { ParameterRenamePreview, projectRenamePreview, type ProjectRenamePreview } from './ParameterRenamePreview';
import { readTextureRenameInventory } from '../../texturing/graph/renameSnapshot';
import { materialLibrary, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import { AbortedError, unknownNodeMessage, type ExternalImage, type TextureGraphEvaluator } from '../../texturing/graph/evaluator';
import { MAX_SIZE_LOG2, MIN_SIZE_LOG2, coerceParameter, formulaScope, mixSeeds, parameterValues, readTextureGraph, resolveNodeParams, subgraphRunSeed, unknownNodeTypes } from '../../texturing/graph/document';
import { ITERATE_NODE_TYPE, OUTPUT_NODE_TYPE, SUBGRAPH_NODE_TYPE, SUBGRAPH_SEED_KEY, SUBGRAPH_VARY_KEY } from '../../texturing/graph/nodes/io';
import { feedbackPairs, passCount } from '../../texturing/graph/iterate';
import { describeMatrix, tileSafeDirection, tileSafeMatrix, transformMatrix } from '../../texturing/graph/safeTransform';
import { PROCESSOR_PICTURES, PROCESSOR_TYPES, defaultFunctionFor, processorUse, readNamedSettings, settingDefault } from '../../texturing/graph/nodes/processors';
import { compileFunction, readFunctionGraph, type FunctionGraph, type NamedSetting } from '../../texturing/graph/functionGraph';
import { PARAMETER_KINDS, PARAMETER_KIND_LABELS, applyPreset, availableParameterName, hasPinCondition, presetFrom, putPreset, removePreset, renameParameter, renamePreset } from '../../texturing/graph/parameters';
import { VALUE_SETTING_KINDS, valuePinKey } from '../../texturing/graph/nodeKit';
import { graphAnimates, textureNodeDefinition, type GraphEntry, type GraphResolver } from '../../texturing/graph/registry';
import { DEFAULT_ANIMATION, FLIPBOOK_FRAMES, flipbookEdge, flipbookFrameSize, flipbookGrid, frameTime, packFlipbook, readAnimation, type GraphAnimation } from '../../texturing/graph/animation';
import { bakeSignature, readStoredGraph, withParameterPictures, type StoredTextureGraph } from '../../texturing/graph/stored';
import { MATERIAL_CHANNELS, MATERIAL_CHANNEL_LABELS, materialKey, materialOf } from '../../texturing/graph/material';
import { TILING_MODES } from '../../texturing/graph/inherit';
import { OUTPUT_CHANNELS, OUTPUT_CHANNEL_LABELS, isParamLink, type GraphParameter, type GraphParameterKind, type GraphPreset, type OutputChannel, type TexGraphNode, type TexNodeDef, type TexParamDef, type TextureGraph, type TilingMode } from '../../texturing/graph/types';
import { ROLE_LABELS, encodeChannels, rewriteMaterialPictures, type ChannelImages, type ChannelTextureIds, type MaterialChannel, type PictureLayout, materialReadsPicture } from '../../texturing/materialOutput';
import { downloadChannelPictures } from '../../texturing/paint/channelDownload';
import { openStacksVersion, paintStackEntries, subscribeOpenStacks } from '../../texturing/paint/stackNode';
import type { PictureFormat } from '../../texturing/paint/pictureFiles';
import { DownloadPicturesButton } from './Paint/DownloadPicturesButton';
import { Button, IconButton, Segmented, Spinner } from '../UI/kit';
import { Select } from '../UI/Select';
import { COMMENT_COLORS, COMMENT_COLOR_NAMES, MAX_COMMENT_TITLE, addSubgraphNode, changeComment, materialHistory, type Point } from './graphEditing';
import { FunctionGraphCanvas, FunctionNodeInspector, NamedSettingsEditor } from './FunctionGraphEditor';
import { deepPictures } from './deepPictures';
import { FunctionPreviews } from './functionPreviews';
import { GraphParameterPanel, PresetBar, type PlacedPreset, type PresetPlace } from './GraphParameterPanel';
import { ConditionEditor, ParameterEditor } from './ParameterEditor';
import { sharedPresets } from './projectPresets';
import { VariationSheet } from './VariationSheet';
import { usePreviewMeshMaps, type PreviewShape } from './previewMeshMaps';
import { TextureGraphCanvas } from './TextureGraphCanvas';
import { DraftNumber, DraftText, TextureParamField, exposedKind } from './TextureParamField';
import { TextureGraphSession, type GraphContext } from './textureGraphSession';
import { TextureView2D } from './TextureView2D';
import type { Histogram } from './view2d';
import { TextureView3D } from './TextureView3D';
import { useTextureStore } from './useTextureStore';
import { RefineWithAi } from './Paint/RefineWithAi';
import type { GpuImage } from '../../texturing/gpu/textureGpu';

/**
 * THE TEXTURE GRAPH WORKSPACE (a texture graph material in the Materials tab)
 *
 * The graph's canvas, the 2D view of one node, the 3D view of the material, and an inspector for
 * the selected node or frame, the graph (its size, seed and exposed parameters) and the material
 * made from it. Every edit redraws at once; "Update material" makes the pictures the engine draws
 * with. Undo covers the graph, its parameter values and the picture settings, works wherever the
 * pointer is in the workspace, and is kept per material while others are open and when the Materials
 * tab is left. A graph used as a node opens in place, drawn as it is where it is used, with a path
 * back out.
 */

const sizeLabel = (log2: number): string => `${2 ** log2}`;
/** Fixed sizes a node or the graph can have, 16 to 8192, as the document allows. */
const FIXED_SIZES = Array.from({ length: MAX_SIZE_LOG2 - MIN_SIZE_LOG2 + 1 }, (_, i) => MIN_SIZE_LOG2 + i).map((log2) => ({ value: log2, label: sizeLabel(log2) }));
/** Sizes relative to the input or the graph: from 1/64 to 16 times. */
const RELATIVE_SIZES = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4].map((offset) => ({ value: offset, label: offset === 0 ? 'Same' : offset < 0 ? `1/${2 ** -offset}` : `× ${2 ** offset}` }));
/** Sizes of the material's pictures (their longest side). */
const PICTURE_SIZES = [8, 9, 10, 11, 12, 13].map((log2) => ({ value: log2, label: `${2 ** log2}` }));
type InspectorTab = 'node' | 'graph' | 'material';

/** Nodes running one way, whose direction is snapped so they still tile (the inspector says to what). */
const RUNS_ONE_WAY: ReadonlySet<string> = new Set(['directionalNoise', 'directionalScratches', 'stripes']);

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

/** A graph open in the workspace: the material's own, or one opened in place from a node using it. */
interface Level {
    asset: MaterialAsset;
    /** The node (in the level before) it was opened from. */
    via: string | null;
    key: string;
}

export const TextureGraphWorkspace: React.FC<{
    asset: MaterialAsset;
    assets: readonly MaterialAsset[];
    onSave: (next: MaterialAsset, immediately?: boolean) => void | Promise<boolean>;
    onOpenAsset: (id: string) => void;
}> = ({ asset, assets, onSave, onOpenAsset }) => {
    // Other graph materials, usable as nodes; paint stacks too, again as a set open in Paint changes.
    const openStacks = useSyncExternalStore(subscribeOpenStacks, openStacksVersion);
    const entries = useMemo(() => {
        void openStacks;
        const map = new Map<string, GraphEntry>();
        for (const candidate of assets) if (candidate.textureGraph) map.set(candidate.id, { id: candidate.id, name: candidate.name, graph: readStoredGraph(candidate.textureGraph).graph });
        for (const entry of paintStackEntries(assets)) map.set(entry.id, entry);
        return map;
    }, [assets, openStacks]);
    const resolve: GraphResolver = useCallback((id) => entries.get(id), [entries]);
    const textureLookup = useMemo(() => materialLibrary.textureLookup(false), []);
    // Pictures at their own depth (16-bit, floating point) once read; the project's textures meanwhile.
    const lookup = useMemo(() => deepPictures.lookup((id: string) => textureLookup(id, 'map')), [textureLookup]);
    // A picture finishing loading (or being read at its depth), or a used graph changing, redraws what depends on it.
    const materialsVersion = useSyncExternalStore((listener) => materialLibrary.subscribe(listener), () => materialLibrary.version);
    const deepVersion = useSyncExternalStore(deepPictures.subscribe, deepPictures.getVersion);
    const libraryVersion = materialsVersion + deepVersion;

    // Graphs opened in place, outermost first, each with the node it was opened from. A step whose node
    // is gone (or uses another graph now) closes it and those inside it.
    const [trail, setTrail] = useState<ReadonlyArray<{ assetId: string; nodeId: string }>>([]);
    const levels = useMemo(() => {
        const list: Level[] = [{ asset, via: null, key: `0:${asset.id}` }];
        for (const step of trail) {
            const outer = readStoredGraph(list[list.length - 1].asset.textureGraph).graph;
            const node = outer.nodes.find((candidate) => candidate.id === step.nodeId);
            const inner = assets.find((candidate) => candidate.id === step.assetId && candidate.textureGraph);
            if (!node || (node.type !== SUBGRAPH_NODE_TYPE && node.type !== ITERATE_NODE_TYPE) || node.params.graph !== step.assetId || !inner || list.some((level) => level.asset.id === inner.id)) break;
            list.push({ asset: inner, via: step.nodeId, key: `${list.length}:${inner.id}:${step.nodeId}` });
        }
        return list;
    }, [asset, assets, trail]);
    const levelKeys = levels.map((level) => level.key).join('|');

    // One session per open graph, made as it opens and let go as it closes; the ones outside the graph
    // being edited are held, keeping the pictures it is drawn with.
    const latest = useRef({ levels, resolve, lookup });
    latest.current = { levels, resolve, lookup };
    const made = useRef(new Map<string, TextureGraphSession>());
    const [sessions, setSessions] = useState<ReadonlyMap<string, TextureGraphSession>>(new Map());
    useEffect(() => {
        const next = new Map<string, TextureGraphSession>();
        for (const level of latest.current.levels) {
            const session = made.current.get(level.key)
                ?? new TextureGraphSession(readStoredGraph(level.asset.textureGraph).graph, (id) => latest.current.resolve(id), (id) => latest.current.lookup(id));
            next.set(level.key, session);
        }
        for (const [key, session] of made.current) if (!next.has(key)) session.dispose();
        made.current = next;
        setSessions(next);
    }, [levelKeys]);
    useEffect(() => () => {
        const gpu = made.current.values().next().value?.gpu;
        for (const session of made.current.values()) session.dispose();
        made.current = new Map();
        // Spare pictures kept for reuse are given back to the GPU once the graph is closed.
        gpu?.trimPool(0);
    }, []);
    useEffect(() => {
        levels.forEach((level, depth) => sessions.get(level.key)?.setPaused(depth < levels.length - 1));
    }, [levels, sessions]);

    const close = useCallback((depth: number) => setTrail((current) => current.slice(0, depth)), []);
    return (
        <div data-workspace className="flex min-h-0 min-w-0 flex-1">
            {levels.map((level, depth) => {
                const session = sessions.get(level.key);
                const shown = depth === levels.length - 1;
                if (!session) return shown ? <div key={level.key} className="flex-1 bg-ground" /> : null;
                const outer = depth ? levels[depth - 1] : null;
                const outerSession = outer ? sessions.get(outer.key) : undefined;
                return (
                    <Workspace
                        key={level.key}
                        hidden={!shown}
                        asset={level.asset}
                        onSave={onSave}
                        onOpenAsset={onOpenAsset}
                        session={session}
                        entries={entries}
                        resolve={resolve}
                        libraryVersion={libraryVersion}
                        path={levels.slice(0, depth + 1).map((item) => item.asset.name)}
                        onClose={close}
                        outer={outer && outerSession && level.via ? { asset: outer.asset, session: outerSession, via: level.via } : undefined}
                        onOpenGraph={(graphId, nodeId) => setTrail((current) => [...current.slice(0, depth), { assetId: graphId, nodeId }])}
                    />
                );
            })}
        </div>
    );
};

/**
 * What a graph opened from a node is drawn with: the images wired into the node, its settings for the
 * graph's parameters, and the seed and size the node runs it at.
 */
const contextOf = (outerSession: TextureGraphSession, outer: StoredTextureGraph, via: string, inner: TextureGraph, resolve: GraphResolver): GraphContext | null => {
    const node = outer.graph.nodes.find((candidate) => candidate.id === via);
    const definition = node && textureNodeDefinition(node, resolve);
    if (!node || !definition) return null;
    const inputs: Record<string, ExternalImage | null> = {};
    const version: string[] = [];
    for (const link of outer.graph.links) {
        if (link.to !== via) continue;
        // A material wire goes in as an image per channel, as the node gives it when it draws.
        const material = materialOf(outerSession.state(link.from)?.outputs ?? {}, link.fromOutput);
        if (material) for (const channel of MATERIAL_CHANNELS) inputs[materialKey(link.toInput, channel)] = material[channel] ?? null;
        else inputs[link.toInput] = outerSession.imageOf(link.from, link.fromOutput);
        version.push(`${link.toInput}=${outerSession.state(link.from)?.signature ?? ''}`);
    }
    const state = outerSession.state(via);
    const width = state?.width ?? 2 ** outer.graph.size.w;
    const height = state?.height ?? 2 ** outer.graph.size.h;
    const values = parameterValues(outer.graph, outer.values);
    const params = resolveNodeParams(definition, node, values, formulaScope(outer.graph, values, width, height));
    const parameters = Object.fromEntries(inner.parameters.map((parameter) => [parameter.name, params[parameter.name]]));
    const runSeed = subgraphRunSeed(outer.graph.seed, via, Math.round(Number(params[SUBGRAPH_SEED_KEY]) || 0), params[SUBGRAPH_VARY_KEY] !== false, inner.seed);
    // A graph an Iterate node runs is shown at its first pass: the images wired in, pass 1 of its count, the first pass's seed.
    const iterating = node.type === ITERATE_NODE_TYPE;
    const seed = iterating && params.newSeed !== false ? mixSeeds(runSeed, 1) : runSeed;
    const iteration = iterating ? { index: 0, count: passCount(params.passes) } : undefined;
    const size = { w: Math.round(Math.log2(width)), h: Math.round(Math.log2(height)) };
    return { inputs, parameters, seed, size, ...(iteration ? { iteration } : {}), version: JSON.stringify([version, parameters, seed, size, iteration ?? null]) };
};

/** What the 2D view can show of a node: each image it gives, each channel of a material it gives (a curve is no picture). */
const shownOptions = (definition: TexNodeDef): Array<{ value: string; label: string }> => definition.outputs.flatMap((port) => (port.kind === 'material'
    ? MATERIAL_CHANNELS.map((channel) => ({ value: materialKey(port.key, channel), label: `${port.label}: ${MATERIAL_CHANNEL_LABELS[channel]}` }))
    : port.kind === 'curve' ? [] : [{ value: port.key, label: port.label }]));

/** The names a node's code can use: its inputs (c_, g_, w_), its settings (p_), the pixel's place and what it writes. */
const codeNames = (definition: TexNodeDef): string[] => [
    'uv', 'vUv', 'outColor', 'uSeed', 'uSize',
    ...definition.inputs.filter((port) => port.kind !== 'material' && port.kind !== 'curve').flatMap((port) => [`c_${port.key}`, `g_${port.key}`, `w_${port.key}`]),
    ...definition.params.map((param) => `p_${param.key}`),
];

const noSubscribe = () => () => undefined;
const noVersion = () => 0;

const Workspace: React.FC<{
    /** Shown only while it is the graph being edited (one opened inside it is not). */
    hidden: boolean;
    asset: MaterialAsset;
    onSave: (next: MaterialAsset, immediately?: boolean) => void | Promise<boolean>;
    onOpenAsset: (id: string) => void;
    session: TextureGraphSession;
    entries: Map<string, GraphEntry>;
    resolve: GraphResolver;
    libraryVersion: number;
    /** The names of the graphs open, the material's own first, this one last. */
    path: readonly string[];
    /** Closes the graphs opened inside the one at `depth` (0: the material's own). */
    onClose: (depth: number) => void;
    /** For a graph opened from a node: the graph it was opened from, that graph's session and the node. */
    outer?: { asset: MaterialAsset; session: TextureGraphSession; via: string };
    onOpenGraph: (graphId: string, nodeId: string) => void;
}> = ({ hidden, asset, onSave, onOpenAsset, session, entries, resolve, libraryVersion, path, onClose, outer, onOpenGraph }) => {
    const { textures } = useAssets();
    const { models, projectStatus } = useScene();
    const textureStore = useTextureStore();
    const pictureLookup = useMemo(() => materialLibrary.textureLookup(false), []);
    const lookup = useMemo(() => deepPictures.lookup((id: string) => pictureLookup(id, 'map')), [pictureLookup]);
    const stored = useMemo(() => readStoredGraph(asset.textureGraph), [asset.textureGraph]);
    const graph = stored.graph;
    const sessionVersion = useSyncExternalStore(session.subscribe, session.getVersion);
    // Edits reach the session at once; a picture loading or a used graph changing redraws what depends on it.
    useEffect(() => { session.setGraph(graph, stored.values); }, [graph, session, stored.values]);
    useEffect(() => { session.refresh(); }, [libraryVersion, entries, session]);

    // A graph opened from a node is drawn as it is there.
    const outerDocument = outer?.asset.textureGraph;
    const outerSession = outer?.session;
    const via = outer?.via;
    const outerStored = useMemo(() => (outerDocument ? readStoredGraph(outerDocument) : null), [outerDocument]);
    const outerVersion = useSyncExternalStore(outerSession?.subscribe ?? noSubscribe, outerSession?.getVersion ?? noVersion);
    const context = useMemo(() => {
        void outerVersion;
        return outerSession && outerStored && via ? contextOf(outerSession, outerStored, via, graph, resolve) : null;
    }, [graph, outerSession, outerStored, outerVersion, resolve, via]);
    useEffect(() => { session.setContext(context); }, [context, session]);

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
    const renamingParameter = useRef(false);
    const [renamePreview, setRenamePreview] = useState<ProjectRenamePreview | null>(null);
    const [, setHistoryVersion] = useState(0);
    // Kept outside this screen, so it survives switching material and leaving the tab.
    const generation = materialLibrary.generation;
    const history = useMemo(() => materialHistory<GraphSnapshot>(asset.id, generation), [asset.id, generation]);
    const meshMaps = usePreviewMeshMaps(session, graph, resolve, shape, surfaceId, libraryVersion);

    // A processor's function graph, opened in place of the graph's canvas.
    const [functionOf, setFunctionOf] = useState<string | null>(null);
    const [functionSelection, setFunctionSelection] = useState<string[]>([]);
    const functionSelectionSet = useMemo(() => new Set(functionSelection), [functionSelection]);
    const functionPreviews = useMemo(() => new FunctionPreviews(session, resolve), [resolve, session]);
    useEffect(() => () => functionPreviews.dispose(), [functionPreviews]);
    const previewVersion = useSyncExternalStore(functionPreviews.subscribe, functionPreviews.getVersion);
    const editedProcessor = functionOf ? graph.nodes.find((node) => node.id === functionOf && PROCESSOR_TYPES.has(node.type) && node.params.mode !== 'code') ?? null : null;
    useEffect(() => { if (functionOf && !editedProcessor) setFunctionOf(null); }, [editedProcessor, functionOf]);
    const editedType = editedProcessor?.type ?? '';
    const editedFunctionSource = editedProcessor?.params.function;
    const editedSettingsSource = editedProcessor?.params.settings;
    const editedFn = useMemo(() => (editedType ? readFunctionGraph(editedFunctionSource, defaultFunctionFor(editedType)) : null), [editedFunctionSource, editedType]);
    const editedSettings = useMemo<NamedSetting[]>(() => (editedType ? readNamedSettings(editedSettingsSource) : []), [editedSettingsSource, editedType]);
    const editedPictures = PROCESSOR_PICTURES[editedType] ?? [];
    const editedCompiled = useMemo(() => (editedFn ? compileFunction(editedFn, { use: processorUse(editedType), settings: editedSettings, pictures: editedPictures }) : null), [editedFn, editedPictures, editedSettings, editedType]);
    useEffect(() => {
        if (editedProcessor) functionPreviews.update(graph, stored.values, editedProcessor.id);
    }, [editedProcessor, functionPreviews, graph, sessionVersion, stored.values]);

    // The graph's parameters: shown as a finished panel, or edited; and its presets.
    const [parameterView, setParameterView] = useState<'panel' | 'edit'>('panel');
    const [variations, setVariations] = useState(false);
    useEffect(() => { void sharedPresets.load(); }, [generation]);
    const sharedVersion = useSyncExternalStore(sharedPresets.subscribe, sharedPresets.getVersion);
    const placedPresets = useMemo<PlacedPreset[]>(() => {
        void sharedVersion;
        return [...(graph.presets ?? []).map((preset) => ({ preset, place: 'graph' as const })), ...sharedPresets.of(asset.id).map((preset) => ({ preset, place: 'project' as const }))];
    }, [asset.id, graph.presets, sharedVersion]);
    // Choice parameters a node select follows: their options are the node's, so their keys stay.
    const boundChoices = useMemo(() => new Set(graph.nodes.flatMap((node) => {
        const definition = textureNodeDefinition(node, resolve);
        return Object.entries(node.params).filter(([key, value]) => isParamLink(value) && '$bind' in value && definition?.params.find((param) => param.key === key)?.kind === 'select').map(([, value]) => (value as { $bind: string }).$bind);
    })), [graph.nodes, resolve]);

    // The first output is in the 2D view to begin with.
    useEffect(() => {
        if (viewed && graph.nodes.some((node) => node.id === viewed)) return;
        setViewed(graph.nodes.find((node) => node.type === OUTPUT_NODE_TYPE)?.id ?? graph.nodes[0]?.id ?? null);
    }, [graph.nodes, viewed]);

    /** What the material's document holds now (edits may have landed since this screen last drew). */
    const currentStored = useCallback(() => readStoredGraph((materialLibrary.get(asset.id) ?? asset).textureGraph), [asset]);

    const commitStored = useCallback((next: StoredTextureGraph, immediately = false) => {
        const current = materialLibrary.get(asset.id) ?? asset;
        const updated: MaterialAsset = { ...current, textureGraph: withParameterPictures(next) as unknown as Record<string, unknown> };
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

    /** A node's settings changed by dragging its handles in the 2D view: one undo step a drag. */
    const setParams = useCallback((nodeId: string, patch: Record<string, unknown>, key: string) => {
        const node = graph.nodes.find((candidate) => candidate.id === nodeId);
        if (node) update({ ...graph, nodes: graph.nodes.map((candidate) => (candidate.id === nodeId ? { ...node, params: { ...node.params, ...patch } } : candidate)) }, true, `${nodeId}:handle:${key}`);
    }, [graph, update]);

    /** A Bitmap cropped to a picked square, the graph's size in the world following it, as one undo step. */
    const cropPhoto = useCallback((nodeId: string, patch: Record<string, unknown>, scale: number) => {
        const node = graph.nodes.find((candidate) => candidate.id === nodeId);
        if (!node) return;
        const size = { w: Math.max(0.001, Math.min(10000, (graph.physicalSize?.w ?? 1) * scale)), h: Math.max(0.001, Math.min(10000, (graph.physicalSize?.h ?? 1) * scale)) };
        update({ ...graph, physicalSize: size, nodes: graph.nodes.map((candidate) => (candidate.id === nodeId ? { ...node, params: { ...node.params, ...patch } } : candidate)) }, true);
    }, [graph, update]);

    /** Opens the graph a sub-graph node uses, or a processor's function graph, in place of this one. */
    const openGraph = useCallback((nodeId: string) => {
        const node = graph.nodes.find((candidate) => candidate.id === nodeId);
        if (node && PROCESSOR_TYPES.has(node.type)) {
            setFunctionOf(nodeId);
            setFunctionSelection([]);
            setTab('node');
            return;
        }
        const graphId = node?.type === SUBGRAPH_NODE_TYPE || node?.type === ITERATE_NODE_TYPE ? node.params.graph : undefined;
        if (typeof graphId === 'string' && graphId !== asset.id && entries.has(graphId)) onOpenGraph(graphId, nodeId);
    }, [asset.id, entries, graph.nodes, onOpenGraph]);

    const graphs = useMemo(() => [...entries.values()].filter((entry) => entry.id !== asset.id).map((entry) => ({ id: entry.id, name: entry.name })), [asset.id, entries]);

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
    const renderChannels = async (size: { w: number; h: number }, time = 0): Promise<{ images: ChannelImages; done: () => void }> => {
        const outputs = graph.nodes.filter((node) => node.type === OUTPUT_NODE_TYPE);
        const request = { graph, parameters: stored.values, targets: outputs.map((node) => node.id), time };
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
        let width = 2 ** size.w;
        let height = 2 ** size.h;
        // An animated graph played as a flipbook: its frames round the loop, laid out on each picture.
        const animation = readAnimation(graph.animation);
        const frameSize = flipbookFrameSize(size, animation.frames);
        // Each frame sits inside an edge of its own pixels in its cell, which the Flipbook Frames node reads it inside of.
        const flipbook = animation.play === 'flipbook' && graphAnimates(graph, resolve)
            ? { frames: animation.frames, ...flipbookGrid(animation.frames), loop: animation.loop, edge: flipbookEdge(2 ** frameSize.w, 2 ** frameSize.h) }
            : null;
        const packed: GpuImage[] = [];
        try {
            let images: ChannelImages;
            if (flipbook) {
                const frames: ChannelImages[] = [];
                const dones: Array<() => void> = [];
                done = () => { for (const release of dones) release(); };
                for (let index = 0; index < flipbook.frames; index++) {
                    setBaking(`Drawing frame ${index + 1} of ${flipbook.frames}…`);
                    const rendered = await renderChannels(frameSize, frameTime(index, flipbook.frames, flipbook.loop));
                    dones.push(rendered.done);
                    frames.push(rendered.images);
                }
                images = {};
                for (const channel of Object.keys(frames[0]) as MaterialChannel[]) {
                    const atlas = packFlipbook(session.gpu, frames.map((frame) => frame[channel]!), flipbook.columns, flipbook.rows, flipbook.edge);
                    packed.push(atlas);
                    images[channel] = atlas;
                }
                const first = packed[0];
                if (first) { width = first.width; height = first.height; }
            } else {
                const rendered = await renderChannels(size);
                done = rendered.done;
                images = rendered.images;
            }
            setBaking('Saving pictures…');
            const rendered = { images };
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
                // Only the material's pictures change; a surface graph edited by hand keeps its edits.
                ...rewriteMaterialPictures(current, ids, { opacityMode: rendered.images.opacity ? 'masked' : undefined, flipbook }),
                textureGraph: { ...latestStored, baked: { textures: ids, signature: bakeSignature(latestStored, resolve), size: latestStored.bakeSize, at: Date.now() } } as unknown as Record<string, unknown>,
            };
            materialLibrary.upsert(next);
            // The old pictures go once the project has the material without them, or their removal
            // reads the material as it was and clashes with its save. Not saved, it still draws with them.
            const saved = await onSave(next, true);
            if (saved !== false) void textureStore.discard(previous);
            const drawn = pictures.filter((picture) => materialReadsPicture(picture.role)).length;
            setMessage({
                text: flipbook
                    ? `The material now plays a flipbook of ${flipbook.frames} frames round ${Number(flipbook.loop.toFixed(2))} seconds, on ${drawn} new picture${drawn === 1 ? '' : 's'} at ${width} × ${height}.`
                    : `The material now draws with ${drawn} new picture${drawn === 1 ? '' : 's'} at ${width} × ${height}.`,
                tone: 'info',
            });
        } catch (error) {
            if (!(error instanceof AbortedError)) {
                frontendDiagnostics.failure('texture_graph_bake_failed', error);
                setMessage({ text: error instanceof Error ? error.message : 'The pictures could not be made.', tone: 'error' });
            }
        } finally {
            done();
            for (const atlas of packed) session.gpu.release(atlas);
            setBaking(null);
        }
    };

    const downloadPictures = async (format: PictureFormat = 'png8') => {
        if (baking) return;
        setBaking('Drawing pictures to download…');
        let done = () => undefined as void;
        const size = pictureSize(graph, stored.bakeSize);
        const width = 2 ** size.w;
        const height = 2 ** size.h;
        try {
            const rendered = await renderChannels(size);
            done = rendered.done;
            const base = asset.name.replace(/[^\w-]+/g, '_') || 'material';
            await downloadChannelPictures(session.gpu, rendered.images, width, height, base, format);
        } catch (error) {
            if (!(error instanceof AbortedError)) setMessage({ text: error instanceof Error ? error.message : 'The pictures could not be made.', tone: 'error' });
        } finally {
            done();
            setBaking(null);
        }
    };

    // ---- inspector parts ----
    const selected = useMemo(() => {
        const nodes = new Set(graph.nodes.map((node) => node.id));
        return selection.filter((id) => nodes.has(id));
    }, [graph.nodes, selection]);
    const selectedSet = useMemo(() => new Set(selected), [selected]);
    const single = selected.length === 1 ? graph.nodes.find((node) => node.id === selected[0]) ?? null : null;
    const singleDefinition = single ? textureNodeDefinition(single, resolve) : null;
    // A curve setting shows the histogram of what comes into the node, read again as that changes.
    const curveInput = single && singleDefinition?.params.some((param) => param.kind === 'curve') ? graph.links.find((link) => link.to === single.id && link.toInput === 'in') : undefined;
    const curveSignature = curveInput ? JSON.stringify([curveInput.from, curveInput.fromOutput, session.state(curveInput.from)?.signature ?? '']) : '';
    const [curveHistogram, setCurveHistogram] = useState<Histogram | null>(null);
    useEffect(() => {
        const [from, fromOutput] = curveSignature ? JSON.parse(curveSignature) as [string, string] : ['', ''];
        const image = from ? session.imageOf(from, fromOutput) : null;
        if (!image) { setCurveHistogram(null); return undefined; }
        let cancelled = false;
        void session.histogram(image).then((made) => { if (!cancelled) setCurveHistogram(made); });
        return () => { cancelled = true; };
    }, [curveSignature, session]);
    const comment = !selected.length && selectedComment ? graph.comments?.find((candidate) => candidate.id === selectedComment) ?? null : null;
    void sessionVersion;

    const changeNode = (node: TexGraphNode, coalesce?: string) => update({ ...graph, nodes: graph.nodes.map((candidate) => (candidate.id === node.id ? node : candidate)) }, true, coalesce);

    /** The processor open in the function editor with its function changed. */
    const changeFunction = (fn: FunctionGraph, coalesce?: string) => {
        if (editedProcessor) changeNode({ ...editedProcessor, params: { ...editedProcessor.params, function: fn } }, coalesce);
    };

    /** A node with one of its settings shown as a pin or not (taking away the pin takes away its wire). */
    const togglePin = (node: TexGraphNode, key: string) => {
        const pins = node.valuePins ?? [];
        const shown = pins.includes(key);
        const { valuePins: _old, ...rest } = node;
        const nextPins = shown ? pins.filter((pin) => pin !== key) : [...pins, key];
        const changed: TexGraphNode = nextPins.length ? { ...rest, valuePins: nextPins } : rest;
        update({
            ...graph,
            nodes: graph.nodes.map((candidate) => (candidate.id === node.id ? changed : candidate)),
            links: shown ? graph.links.filter((link) => !(link.to === node.id && link.toInput === valuePinKey(key))) : graph.links,
        }, true);
    };

    /** A processor's named settings changed: its values follow, and a setting taken away takes its pin and wire with it. */
    const changeSettings = (node: TexGraphNode, settings: NamedSetting[], removed?: string) => {
        const params: Record<string, unknown> = { ...node.params, settings };
        for (const setting of settings) {
            const old = readNamedSettings(node.params.settings).find((candidate) => candidate.key === setting.key);
            if (!old) params[setting.key] = setting.default;
            else if (old.kind !== setting.kind) params[setting.key] = settingDefault(setting.kind, node.params[setting.key]);
        }
        let changed: TexGraphNode = { ...node, params };
        if (removed) {
            delete params[removed];
            const { valuePins: pins, ...rest } = changed;
            const kept = (pins ?? []).filter((pin) => pin !== removed);
            changed = kept.length ? { ...rest, valuePins: kept } : rest;
        }
        update({
            ...graph,
            nodes: graph.nodes.map((candidate) => (candidate.id === node.id ? changed : candidate)),
            links: removed ? graph.links.filter((link) => !(link.to === node.id && link.toInput === valuePinKey(removed))) : graph.links,
        }, true);
    };

    const expose = (node: TexGraphNode, param: TexParamDef) => {
        const kind = exposedKind(param);
        if (!kind) return;
        const name = availableParameterName(param.key, graph.parameters);
        const parameter: GraphParameter = {
            name,
            label: param.label.replace(/\s*\(.*\)$/, ''),
            kind,
            default: coerceParameter(kind, node.params[param.key] ?? param.default, param.options),
            ...(param.min !== undefined ? { min: param.min } : {}),
            ...(param.max !== undefined ? { max: param.max } : {}),
            ...(param.softMin !== undefined ? { softMin: param.softMin } : {}),
            ...(param.softMax !== undefined ? { softMax: param.softMax } : {}),
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

    /** A preset applied: its values (and its seed, when it keeps one), as one undo step. */
    const applyGraphPreset = (preset: GraphPreset) => {
        const values = applyPreset(preset, graph.parameters, currentStored().values);
        change(preset.seed !== undefined ? { values, graph: { ...graph, seed: preset.seed } } : { values });
        setMessage({ text: `Preset "${preset.name}" applied.`, tone: 'info' });
    };
    const saveGraphPreset = (name: string, place: PresetPlace, withSeed: boolean) => {
        const preset = presetFrom(name, graph.parameters, currentStored().values, withSeed ? graph.seed : undefined);
        if (place === 'graph') update({ ...graph, presets: putPreset(graph.presets ?? [], preset) }, true);
        else void sharedPresets.put(asset.id, preset).then((done) => setMessage(done ? { text: `"${preset.name}" is kept in the project for this graph.`, tone: 'info' } : { text: 'The preset could not be kept in the project.', tone: 'error' }));
    };
    const renameGraphPreset = (item: PlacedPreset, name: string) => {
        if (item.place === 'graph') update({ ...graph, presets: renamePreset(graph.presets ?? [], item.preset.id, name) }, true);
        else void sharedPresets.rename(item.preset.id, name);
    };
    const deleteGraphPreset = (item: PlacedPreset) => {
        if (item.place === 'graph') {
            const presets = removePreset(graph.presets ?? [], item.preset.id);
            const { presets: _old, ...rest } = graph;
            update(presets.length ? { ...rest, presets } : rest, true);
        } else void sharedPresets.remove(item.preset.id);
    };

    const commentInspector = (current: NonNullable<typeof comment>) => (
        <div className="space-y-3">
            <div className="text-xs font-semibold text-ink">Frame</div>
            <label className="block space-y-1">
                <span className="text-2xs text-ink-2">Title</span>
                <DraftText label="Frame title" value={current.text} maxLength={MAX_COMMENT_TITLE} allowEmpty placeholder="Frame" className="w-full"
                    onCommit={(text) => update(changeComment(graph, current.id, { text }), true)} />
            </label>
            <div className="space-y-1">
                <span className="text-2xs text-ink-2">Colour</span>
                <div role="radiogroup" aria-label="Frame colour" className="flex flex-wrap gap-1.5">
                    {COMMENT_COLORS.map((color) => (
                        <button key={color} type="button" role="radio" aria-checked={current.color === color} aria-label={COMMENT_COLOR_NAMES[color] ?? color} title={COMMENT_COLOR_NAMES[color] ?? color}
                            onClick={() => update(changeComment(graph, current.id, { color }), true)}
                            className={`h-5 w-5 rounded border ${current.color === color ? 'border-ink ring-1 ring-ink/50' : 'border-line hover:border-gray-600'}`} style={{ background: color }} />
                    ))}
                </div>
            </div>
            <p className="text-2xs leading-snug text-ink-3">Double-click a frame's title on the canvas to rename it there. Dragging its title moves everything inside with it; nodes dragged in or out make it fit round them.</p>
        </div>
    );

    const selectedSingle = single;
    const nodeInspector = () => {
        if (editedProcessor && editedFn) {
            void previewVersion;
            const fnNode = functionSelection.length === 1 ? editedFn.nodes.find((node) => node.id === functionSelection[0]) : undefined;
            if (fnNode) {
                return (
                    <FunctionNodeInspector node={fnNode} use={processorUse(editedProcessor.type)} settings={editedSettings} pictures={editedPictures}
                        error={editedCompiled?.errors.get(fnNode.id)} preview={functionPreviews.get(fnNode.id)}
                        onChange={(next, coalesce) => changeFunction({ ...editedFn, nodes: editedFn.nodes.map((node) => (node.id === next.id ? next : node)) }, coalesce)} />
                );
            }
        }
        // While a function graph is open, its processor (until one of its nodes is selected).
        const single = editedProcessor ?? selectedSingle;
        if (comment && !editedProcessor) return commentInspector(comment);
        if (!single) {
            return <p className="text-2xs leading-snug text-ink-3">{selected.length > 1 ? `${selected.length} nodes selected. Delete removes them, C puts a frame round them, and the line-up button on the canvas aligns or spaces them.` : 'Select a node or a frame to change its settings. Double-click a node to look at it in the 2D view; right-click it for more.'}</p>;
        }
        const definition = textureNodeDefinition(single, resolve);
        if (!definition) {
            return (
                <div className="space-y-2">
                    <div className="text-xs font-semibold text-ink">Not available: {single.type}</div>
                    <div className="flex gap-1.5 rounded border border-warn/40 bg-warn/10 p-1.5 text-2xs text-warn"><WarningIcon size={12} className="mt-px shrink-0" /><span>{unknownNodeMessage(single.type)}</span></div>
                    <p className="text-2xs leading-snug text-ink-3">It draws nothing here, and nodes it feeds read their input as unwired. Delete it to take it out of the graph.</p>
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
                    <div className="text-xs font-semibold text-ink">{single.name || definition.label}</div>
                    {single.name && <div className="text-2xs text-ink-2">{definition.label}</div>}
                    <p className="mt-0.5 text-2xs leading-snug text-ink-3">{definition.description}</p>
                </div>
                <label className="flex items-center gap-2">
                    <span className="w-12 shrink-0 text-2xs text-ink-2">Name</span>
                    <DraftText label="Node name" value={single.name ?? ''} maxLength={64} allowEmpty placeholder={definition.label} className="min-w-0 flex-1"
                        onCommit={(text) => {
                            const name = text.trim().slice(0, 64);
                            const { name: _old, ...rest } = single;
                            changeNode(name ? { ...rest, name } : rest);
                        }} />
                </label>
                {single.bypass && (
                    <div className="flex items-center gap-1.5 rounded border border-warn/40 bg-warn/10 p-1.5 text-2xs text-warn">
                        <span className="flex-1">Bypassed: its main input passes straight through.</span>
                        <Button size="sm" variant="ghost" onClick={() => { const { bypass: _bypass, ...rest } = single; changeNode(rest); }}>Stop bypassing</Button>
                    </div>
                )}
                {state?.error && <div className="flex gap-1.5 rounded border border-bad/40 bg-bad/10 p-1.5 text-2xs text-bad"><WarningIcon size={12} className="mt-px shrink-0" /><span className="whitespace-pre-wrap font-mono">{state.error}</span></div>}
                {single.type === SUBGRAPH_NODE_TYPE && typeof single.params.graph === 'string' && entries.has(single.params.graph) && (() => {
                    const used = entries.get(single.params.graph as string)!;
                    const presets: PlacedPreset[] = [...(used.graph.presets ?? []).map((preset) => ({ preset, place: 'graph' as const })), ...sharedPresets.of(used.id).map((preset) => ({ preset, place: 'project' as const }))];
                    return (
                        <>
                            <div className="flex flex-wrap gap-1.5">
                                <Button size="sm" icon={<LayersIcon size={12} />} onClick={() => openGraph(single.id)}>Open the graph inside</Button>
                                <Button size="sm" variant="ghost" icon={<ExternalLinkIcon size={12} />} onClick={() => onOpenAsset(used.id)}>Go to {used.name}</Button>
                            </div>
                            {presets.length > 0 && (
                                <PresetBar presets={presets} parameters={used.graph.parameters} values={single.params}
                                    onApply={(preset) => changeNode({ ...single, params: { ...applyPreset(preset, used.graph.parameters, single.params), ...(preset.seed !== undefined ? { [SUBGRAPH_SEED_KEY]: preset.seed } : {}) } })} />
                            )}
                        </>
                    );
                })()}
                {single.type === ITERATE_NODE_TYPE && (() => {
                    const ran = typeof single.params.graph === 'string' ? entries.get(single.params.graph) : undefined;
                    const pairs = ran ? feedbackPairs(ran.graph) : [];
                    const outputName = (id: string) => definition.outputs.find((port) => port.key === id)?.label ?? 'Output';
                    return (
                        <div className="space-y-1.5">
                            <span className="text-2xs text-ink-2">Graph it runs</span>
                            <Select value={String(single.params.graph ?? '')} placeholder="Choose a graph" options={graphs.map((entry) => ({ value: entry.id, label: entry.name }))}
                                onChange={(value) => changeNode({ ...single, params: { ...single.params, graph: value } })} className="w-full" />
                            {ran && (pairs.length
                                ? <p className="text-2xs leading-snug text-ink-3">Fed back each pass: {pairs.map((pair) => `${outputName(pair.output)} into ${pair.input}`).join(', ')}. Formulas read the pass as $iteration; function graphs with Pass number.</p>
                                : <div className="flex gap-1.5 rounded border border-warn/40 bg-warn/10 p-1.5 text-2xs text-warn"><WarningIcon size={12} className="mt-px shrink-0" /><span>Nothing feeds back: give one of its Outputs the name of one of its Inputs, and that Output feeds that Input on the next pass.</span></div>)}
                            {ran && <Button size="sm" variant="ghost" icon={<ExternalLinkIcon size={12} />} onClick={() => onOpenAsset(ran.id)}>Go to {ran.name}</Button>}
                        </div>
                    );
                })()}
                {isOutput && (
                    <div className="space-y-1">
                        <span className="text-2xs text-ink-2">Channel</span>
                        <Select value={String(single.params.channel)} options={OUTPUT_CHANNELS.map((channel) => ({ value: channel, label: OUTPUT_CHANNEL_LABELS[channel] }))}
                            onChange={(value) => changeNode({ ...single, params: { ...single.params, channel: value } })} className="w-full" />
                    </div>
                )}
                {definition.params.filter((param) => !(isOutput && param.key === 'channel') && param.kind !== 'graph' && (!param.showIf || param.showIf(single.params))).map((param) => {
                    if (param.kind === 'function') {
                        const fn = readFunctionGraph(single.params.function, defaultFunctionFor(single.type));
                        const open = editedProcessor?.id === single.id;
                        return (
                            <div key={param.key} className="space-y-1.5 rounded border border-line bg-well p-2">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-2xs text-ink-2">Function graph: {fn.nodes.length} node{fn.nodes.length === 1 ? '' : 's'}</span>
                                    {open
                                        ? <Button size="sm" variant="ghost" icon={<ArrowLeftIcon size={12} />} onClick={() => setFunctionOf(null)}>Back to the graph</Button>
                                        : <Button size="sm" icon={<FlowIcon size={12} />} onClick={() => openGraph(single.id)}>Edit the function graph</Button>}
                                </div>
                                {!open && <p className="text-2xs leading-snug text-ink-3">Opens in place of the canvas: every node in it shows its value as you build it.</p>}
                            </div>
                        );
                    }
                    if (param.kind === 'settings') {
                        const settings = readNamedSettings(single.params.settings);
                        return (
                            <NamedSettingsEditor key={param.key} settings={settings}
                                onAdd={(setting) => changeSettings(single, [...settings, setting])}
                                onChange={(index, setting) => changeSettings(single, settings.map((candidate, at) => (at === index ? setting : candidate)))}
                                onRemove={(index) => changeSettings(single, settings.filter((_, at) => at !== index), settings[index].key)} />
                        );
                    }
                    if (param.key === 'visibleIf' && param.kind === 'string' && hasPinCondition(single.type)) {
                        return (
                            <div key={param.key} className="space-y-1" title={param.hint}>
                                <span className="text-2xs text-ink-2">Pin shown on nodes using this graph</span>
                                <ConditionEditor value={String(single.params.visibleIf ?? '')} parameters={graph.parameters}
                                    onChange={(condition) => changeNode({ ...single, params: { ...single.params, visibleIf: condition } })} />
                            </div>
                        );
                    }
                    const pinnable = VALUE_SETTING_KINDS.has(param.kind) && !isOutput;
                    // A heading where a new group of settings starts (a used graph's parameter groups).
                    const shownParams = definition.params.filter((other) => other.kind !== 'graph' && (!other.showIf || other.showIf(single.params)));
                    const before = shownParams[shownParams.indexOf(param) - 1];
                    const heading = param.group && param.group !== before?.group ? <div className="border-t border-line pt-2 text-2xs font-semibold text-ink-2">{param.group}</div> : null;
                    return (
                        <React.Fragment key={param.key}>
                        {heading}
                        <TextureParamField
                            key={param.key}
                            param={param}
                            value={single.params[param.key]}
                            parameters={graph.parameters}
                            textures={textures}
                            problem={state?.warnings?.find((warning) => warning.includes(`"${param.label}"`))}
                            onChange={(value) => changeNode({ ...single, params: { ...single.params, [param.key]: value } }, `${single.id}:${param.key}`)}
                            onExpose={() => expose(single, param)}
                            extras={param.kind === 'code' ? { error: state?.error, names: codeNames(definition) } : param.kind === 'curve' ? { histogram: curveHistogram } : undefined}
                            pin={pinnable ? {
                                shown: Boolean(single.valuePins?.includes(param.key)),
                                wired: graph.links.some((link) => link.to === single.id && link.toInput === valuePinKey(param.key)),
                                onToggle: () => togglePin(single, param.key),
                            } : undefined}
                        />
                        </React.Fragment>
                    );
                })}
                {((single.type === 'transform' && single.params.safe === true) || (single.type === 'safeTransform' && single.params.mode !== 'blend'))
                    && typeof single.params.rotation === 'number' && Array.isArray(single.params.scale) && (() => {
                    const seamless = describeMatrix(tileSafeMatrix(transformMatrix(single.params.rotation as number, single.params.scale as number[])));
                    const size = (value: number) => String(Number(value.toFixed(3)));
                    return (
                        <p className="rounded border border-line bg-well px-1.5 py-1 text-2xs leading-snug text-ink-2">
                            Seamless as: turned {seamless.rotation}°, scaled {size(seamless.scale[0])} × {size(seamless.scale[1])}{seamless.slant ? ', slanted a little' : ''}.
                        </p>
                    );
                })()}
                {RUNS_ONE_WAY.has(single.type) && typeof single.params.angle === 'number' && (
                    <p className="rounded border border-line bg-well px-1.5 py-1 text-2xs leading-snug text-ink-2">
                        Runs at {tileSafeDirection(single.params.angle as number).degrees}°, the nearest direction it stays seamless along.
                    </p>
                )}
                {!isOutput && (
                    <div className="space-y-1.5 border-t border-line pt-2">
                        <div className="text-2xs font-semibold text-ink-2">Size, bit depth, tiling and seed</div>
                        <Select value={sizeMode} options={[{ value: 'input', label: 'Follow its input' }, { value: 'graph', label: 'Follow the graph' }, { value: 'absolute', label: 'Fixed size' }]}
                            onChange={(mode) => changeNode({ ...single, size: { mode, w: mode === 'absolute' ? graph.size.w : 0, h: mode === 'absolute' ? graph.size.h : 0 } })} className="w-full" />
                        <div className="grid grid-cols-[auto_1fr_auto_1fr] items-center gap-1.5">
                            <span className="text-2xs text-ink-3">Width</span>
                            <Select value={sizeW} options={fixed ? FIXED_SIZES : RELATIVE_SIZES} placeholder="Width" onChange={(value) => changeNode({ ...single, size: { mode: sizeMode, w: Number(value), h: sizeH } })} />
                            <span className="text-2xs text-ink-3">Height</span>
                            <Select value={sizeH} options={fixed ? FIXED_SIZES : RELATIVE_SIZES} placeholder="Height" onChange={(value) => changeNode({ ...single, size: { mode: sizeMode, w: sizeW, h: Number(value) } })} />
                        </div>
                        <Segmented value={String(single.precision ?? 'auto')} options={[{ value: 'auto', label: 'Input', hint: 'As its inputs keep it' }, { value: 'graph', label: 'Graph', hint: 'The graph\'s bit depth' }, { value: '8', label: '8-bit', hint: 'Steps of 1/255, as a picture keeps them' }, { value: '16', label: 'Half', hint: '16-bit floating point: fine steps for heights and masks' }, { value: '32', label: 'Full', hint: '32-bit floating point: exact, and four times the memory of 8-bit' }]}
                            onChange={(value) => changeNode({ ...single, precision: value === 'auto' ? undefined : value === 'graph' ? 'graph' : Number(value) as 8 | 16 | 32 })} label="Bit depth" />
                        <Select value={single.tiling ?? (definition.inputs.length ? 'input' : 'graph')}
                            options={[
                                ...(definition.inputs.length ? [{ value: 'input', label: 'Tiles as its input does' }] : []),
                                { value: 'graph', label: 'Tiles as the graph does' },
                                ...TILING_MODES.map(([mode, label]) => ({ value: mode, label: mode === 'none' ? 'Does not tile' : `Tiles ${label.toLowerCase()}` })),
                            ]}
                            onChange={(value) => { const { tiling: _old, ...rest } = single; changeNode(value === (definition.inputs.length ? 'input' : 'graph') ? rest : { ...rest, tiling: value as NonNullable<TexGraphNode['tiling']> }); }} className="w-full" />
                        {definition.params.some((param) => param.key === 'seed') && (
                            <Select value={single.seedFrom ?? 'graph'} options={[{ value: 'graph', label: 'Its seed mixed with the graph\'s' }, { value: 'input', label: 'Its seed mixed with its input\'s' }, { value: 'fixed', label: 'Its own seed alone' }]}
                                onChange={(value) => { const { seedFrom: _old, ...rest } = single; changeNode(value === 'graph' ? rest : { ...rest, seedFrom: value as 'input' | 'fixed' }); }} className="w-full" />
                        )}
                        {state && <p className="text-2xs text-ink-3">{state.width} × {state.height}{state.tiling ? `, ${state.tiling === 'none' ? 'not tiling' : `tiling ${TILING_MODES.find(([mode]) => mode === state.tiling)?.[1].toLowerCase()}`}` : ''}, drawn in {state.milliseconds < 1 ? 'under 1' : Math.round(state.milliseconds)} ms</p>}
                    </div>
                )}
                {shownOptions(definition).length > 1 && (
                    <div className="space-y-1">
                        <span className="text-2xs text-ink-2">Shown in 2D</span>
                        <Select value={viewedOutput ?? shownOptions(definition)[0].value} options={shownOptions(definition)}
                            onChange={(value) => { setViewed(single.id); setViewedOutput(String(value)); }} className="w-full" />
                    </div>
                )}
            </div>
        );
    };

    const checkParameterRename = (from: string, to: string, previewOnly = false) => {
        if (renamingParameter.current) return;
        renamingParameter.current = true;
        setRenamePreview(null);
        setMessage({ text: 'Checking this parameter’s references across the project…', tone: 'info' });
        void (async () => {
            const status = projectService.getStatus();
            if (!status.projectId) throw new Error('Open a project to check its parameter references.');
            const before = currentStored();
            // Graph-local undo cannot restore dependent materials/models/objects.
            // Check the COMPLETE host snapshot, not only loaded scene objects.
            const snapshot = await projectService.getSnapshotAll();
            const inventory = readTextureRenameInventory(snapshot, materialLibrary.list(), {
                projectId: status.projectId, revision: status.revision,
            });
            const plan = planTextureParameterRename({
                sourceMaterialId: asset.id, from, to, ...inventory,
            });
            const sharedInMemory = sharedPresets.of(asset.id).filter(preset => Object.hasOwn(preset.values, from) || Object.hasOwn(preset.values, to)).length;
            const currentStatus = projectService.getStatus();
            const latest = currentStored();
            if (currentStatus.projectId !== status.projectId || currentStatus.revision !== status.revision
                || JSON.stringify(latest.graph) !== JSON.stringify(before.graph)
                || JSON.stringify(latest.values) !== JSON.stringify(before.values)) {
                throw new Error('The project changed while references were being checked. Nothing was renamed; try again.');
            }
            if (sharedInMemory !== plan.impact.sharedPresets) {
                throw new Error('The shared presets in the editor differ from the saved project. Finish saving or reload before renaming.');
            }
            if (previewOnly || currentStatus.readOnly || requiresProjectWideParameterRename(plan.impact)) {
                setRenamePreview(projectRenamePreview(plan, status.projectId, status.revision, materialLibrary.version, sharedPresets.getVersion()));
                setMessage(null);
                return;
            }
            // No external references: the existing graph-local history is valid.
            const renamed = renameParameter(before.graph, before.values, from, to);
            change({ graph: renamed.graph, values: renamed.values });
            setMessage({ text: `Parameter "${from}" renamed to "${to}" inside this graph.`, tone: 'info' });
        })().catch((error: unknown) => {
            setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Parameter rename could not be verified; no changes were made.' });
        }).finally(() => { renamingParameter.current = false; });
    };

    const graphInspector = () => (
        <div className="space-y-3">
            <div className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1.5">
                <span className="text-2xs text-ink-2">Size while editing</span>
                <div className="flex items-center gap-1">
                    <Select value={graph.size.w} options={FIXED_SIZES} placeholder="Width" onChange={(value) => update({ ...graph, size: { w: Number(value), h: graph.size.h } }, true)} className="w-[68px]" />
                    <span className="text-2xs text-ink-3">×</span>
                    <Select value={graph.size.h} options={FIXED_SIZES} placeholder="Height" onChange={(value) => update({ ...graph, size: { w: graph.size.w, h: Number(value) } }, true)} className="w-[68px]" />
                </div>
                <span className="text-2xs text-ink-2">Random seed</span>
                <div className="flex items-center gap-1">
                    <DraftNumber label="Graph random seed" value={graph.seed} integer limit={(seed) => Math.max(0, Math.min(999, seed))} onCommit={(seed) => update({ ...graph, seed }, true)} className="w-16" />
                    <button aria-label="Another seed" title="Another seed" onClick={() => update({ ...graph, seed: Math.floor(Math.random() * 1000) }, true)} className="rounded p-1 text-ink-2 hover:bg-white/5 hover:text-ink"><DiceIcon size={13} /></button>
                </div>
                <span className="text-2xs text-ink-2">Tiling</span>
                <Select value={graph.tiling ?? 'both'} options={TILING_MODES.map(([value, label]) => ({ value, label }))}
                    onChange={(value) => { const { tiling: _old, ...rest } = graph; update(value === 'both' ? rest : { ...rest, tiling: value as TilingMode }, true); }} className="w-[140px]" />
                <span className="text-2xs text-ink-2">Bit depth (nodes set to the graph's)</span>
                <Select value={graph.precision ?? 0} options={[{ value: 0, label: 'By kind' }, { value: 8, label: '8-bit' }, { value: 16, label: 'Half float' }, { value: 32, label: 'Full float' }]}
                    onChange={(value) => { const { precision: _old, ...rest } = graph; update(value ? { ...rest, precision: Number(value) as 8 | 16 | 32 } : rest, true); }} className="w-[140px]" />
                <span className="text-2xs text-ink-2" title="The size the picture stands for in the world. Normal from height, Height from normal, Curvature, Ambient occlusion from height and Emboss measure slopes per metre of it, so the same heights make the same bumps at any picture size.">Size in the world (metres)</span>
                <div className="flex items-center gap-1">
                    <DraftNumber label="Width in metres" value={graph.physicalSize?.w ?? 1} limit={(value) => Math.max(0.001, Math.min(10000, value))}
                        onCommit={(w) => update({ ...graph, physicalSize: { w, h: graph.physicalSize?.h ?? 1 } }, true)} className="w-14" />
                    <span className="text-2xs text-ink-3">×</span>
                    <DraftNumber label="Height in metres" value={graph.physicalSize?.h ?? 1} limit={(value) => Math.max(0.001, Math.min(10000, value))}
                        onCommit={(h) => update({ ...graph, physicalSize: { w: graph.physicalSize?.w ?? 1, h } }, true)} className="w-14" />
                </div>
            </div>
            {Math.max(graph.size.w, graph.size.h) >= 12 && <p className="text-2xs leading-snug text-ink-3">Large editing sizes redraw slowly; the material's pictures can be larger than the editing size.</p>}
            {(() => {
                const animation = readAnimation(graph.animation);
                const animates = graphAnimates(graph, resolve);
                const change = (patch: Partial<GraphAnimation>) => update({ ...graph, animation: { ...(graph.animation ?? DEFAULT_ANIMATION), ...patch } }, true);
                return (
                    <div className="space-y-1.5 border-t border-line pt-2">
                        <div className="text-2xs font-semibold text-ink-2">Animation</div>
                        {!animates && <p className="text-2xs leading-snug text-ink-3">Nothing in this graph reads the time yet. Add a Time node (or a Time node in a function graph) and wire it into a setting shown as a pin to animate it.</p>}
                        <div className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1.5">
                            <span className="text-2xs text-ink-2" title="Its time comes round after this long, so the animation meets up with itself: it tiles in time.">Loop (seconds)</span>
                            <DraftNumber label="Loop length in seconds" value={animation.loop} limit={(value) => Math.max(0.1, Math.min(600, value))} onCommit={(loop) => change({ loop })} className="w-16" />
                            <span className="text-2xs text-ink-2">In the game</span>
                            <Select value={animation.play} options={[{ value: 'flipbook', label: 'Plays a flipbook' }, { value: 'cook', label: 'Cooked as it plays' }]}
                                onChange={(play) => change({ play: play as GraphAnimation['play'] })} className="w-[140px]" />
                            {animation.play === 'flipbook' ? (
                                <>
                                    <span className="text-2xs text-ink-2" title="Update material draws this many frames round the loop and lays them out on each picture, the whole at the pictures' size.">Frames</span>
                                    <Select value={animation.frames} options={FLIPBOOK_FRAMES.map((frames) => ({ value: frames, label: `${frames} (${flipbookGrid(frames).columns} × ${flipbookGrid(frames).rows})` }))}
                                        onChange={(frames) => change({ frames: Number(frames) })} className="w-[140px]" />
                                </>
                            ) : (
                                <>
                                    <span className="text-2xs text-ink-2" title="A game that cooks texture graphs draws this one again this many times a second, at the time it is then; one that does not shows its first frame.">Cooks a second</span>
                                    <DraftNumber label="Cooks a second" value={animation.rate} limit={(value) => Math.max(0.25, Math.min(60, value))} onCommit={(rate) => change({ rate })} className="w-16" />
                                </>
                            )}
                        </div>
                    </div>
                );
            })()}
            <RefineWithAi session={session} graph={graph} name={asset.name} onGraph={(next) => update(next, true)} />
            <div className="space-y-2 border-t border-line pt-2">
                <div className="flex items-center gap-1.5">
                    <span className="flex-1 text-2xs font-semibold text-ink-2">Parameters</span>
                    {graph.parameters.length > 0 && (
                        <Segmented value={parameterView} label="Parameters shown" onChange={setParameterView} options={[
                            { value: 'panel', label: 'Panel', hint: 'As whatever uses the graph sees them' },
                            { value: 'edit', label: 'Edit', hint: 'Groups, words, conditions, ranges and options' },
                        ]} />
                    )}
                    <Select value="" placeholder="Add…" options={PARAMETER_KINDS.map((kind) => ({ value: kind, label: PARAMETER_KIND_LABELS[kind] }))} onChange={(kind: GraphParameterKind) => {
                        const name = availableParameterName('value', graph.parameters);
                        const choice = [{ value: 'first', label: 'First' }, { value: 'second', label: 'Second' }];
                        const parameter: GraphParameter = {
                            name, label: PARAMETER_KIND_LABELS[kind], kind,
                            default: coerceParameter(kind, kind === 'float' ? 0.5 : kind === 'select' ? 'first' : undefined, kind === 'select' ? choice : undefined),
                            ...(kind === 'float' ? { min: 0, max: 1 } : kind === 'int' ? { min: 0, max: 10 } : kind === 'vec2' ? { min: -1, max: 1 } : {}),
                            ...(kind === 'select' ? { options: choice } : {}),
                        };
                        change({ graph: { ...graph, parameters: [...graph.parameters, parameter] } });
                        setParameterView('edit');
                    }} className="w-24" />
                </div>
                {graph.parameters.length === 0 && <p className="text-2xs leading-snug text-ink-3">None yet. Use the link button beside any node setting to expose it here (any kind: numbers, colours, choices, gradients, curves, pictures, text, fonts); materials and nodes using this graph set them.</p>}
                {graph.parameters.length > 0 && parameterView === 'panel' && (
                    <>
                        <PresetBar presets={placedPresets} parameters={graph.parameters} values={stored.values}
                            onApply={applyGraphPreset} onSave={saveGraphPreset} onRename={renameGraphPreset} onDelete={deleteGraphPreset}
                            onVariations={() => setVariations(true)} />
                        <GraphParameterPanel parameters={graph.parameters} groups={graph.groups} values={stored.values} textures={textures}
                            onChange={(values, coalesce) => change({ values }, coalesce)} />
                    </>
                )}
                {graph.parameters.length > 0 && parameterView === 'edit' && (
                    <ParameterEditor parameters={graph.parameters} groups={graph.groups ?? []} textures={textures} boundChoices={boundChoices}
                        onParameters={(parameters, coalesce) => update({ ...graph, parameters }, true, coalesce)}
                        onGroups={(groups, renamed) => {
                            const parameters = renamed ? graph.parameters.map((parameter) => (parameter.group === renamed.from ? { ...parameter, group: renamed.to } : parameter)) : graph.parameters;
                            const { groups: _old, ...rest } = graph;
                            update(groups.length ? { ...rest, parameters, groups } : { ...rest, parameters }, true);
                        }}
                        onRename={(from, to) => checkParameterRename(from, to)}
                        onRemove={(index) => {
                            const parameter = graph.parameters[index];
                            // Settings that followed it keep the value it had.
                            const value = stored.values[parameter.name] ?? parameter.default;
                            const nextGraph = { ...graph, parameters: graph.parameters.filter((_, i) => i !== index), nodes: graph.nodes.map((node) => ({ ...node, params: Object.fromEntries(Object.entries(node.params).map(([key, v]) => [key, v && typeof v === 'object' && (v as { $bind?: string }).$bind === parameter.name ? structuredClone(value) : v])) })) };
                            update(nextGraph, true);
                        }} />
                )}
            </div>
            <div className="space-y-1 border-t border-line pt-2">
                <label className="flex items-center gap-2 text-2xs text-ink-2">
                    <input type="checkbox" checked={Boolean(stored.library)} onChange={(event) => change({ library: event.target.checked || undefined })} className="accent-accent" />
                    Mainly for use inside other graphs
                </label>
            </div>
        </div>
    );

    const materialInspector = () => (
        <div className="space-y-3">
            <div className={`flex items-start gap-1.5 rounded border p-2 text-2xs ${upToDate ? 'border-ok/40 bg-ok/10 text-ok' : 'border-warn/40 bg-warn/10 text-warn'}`}>
                {upToDate ? <CheckCircleIcon size={13} className="mt-px shrink-0" /> : <RefreshIcon size={13} className="mt-px shrink-0" />}
                <span>{upToDate
                    ? `Models with this material show the graph as it is now (${2 ** madeSize.w} × ${2 ** madeSize.h} pixels).`
                    : stored.baked ? 'The graph has changed since the material was last updated. Models still show the earlier pictures.' : 'Models with this material show nothing of the graph until the material is updated.'}</span>
            </div>
            <Button variant="primary" className="w-full justify-center" disabled={Boolean(baking) || !hasOutputs} onClick={() => void updateMaterial()} icon={baking ? <Spinner /> : <RefreshIcon size={13} />}>
                {baking ?? 'Update material'}
            </Button>
            {!hasOutputs && <p className="text-2xs text-ink-3">Add an Output node for a channel (base colour, normal...) to make a material.</p>}
            {/* What its pictures cost as the game keeps them, and where compression hurts (components/Materials/CompressionBadge.tsx). */}
            {stored.baked && <CompressionBadge asset={materialLibrary.get(asset.id) ?? asset} />}
            <div className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1.5">
                <span className="text-2xs text-ink-2">{graph.size.w === graph.size.h ? 'Picture size' : 'Picture size (longest side)'}</span>
                <Select value={stored.bakeSize} options={PICTURE_SIZES} onChange={(value) => change({ bakeSize: Number(value) })} className="w-32" />
                <span className="text-2xs text-ink-2">Pictures</span>
                <Select value={stored.layout} options={[{ value: 'engine', label: 'Packed (fewer)' }, { value: 'separate', label: 'One per channel' }]} onChange={(value) => change({ layout: value === 'separate' ? 'separate' : 'engine' })} className="w-32" />
            </div>
            {graph.size.w !== graph.size.h && <p className="text-2xs text-ink-3">The pictures keep the graph's proportions: {2 ** outSize.w} × {2 ** outSize.h}.</p>}
            <p className="text-2xs leading-snug text-ink-3">Packed keeps occlusion, roughness and metallic in one picture's red, green and blue, which the engine reads in one go.</p>
            {meshMaps.reads && (
                <div className="flex gap-1.5 rounded border border-line bg-well p-2 text-2xs leading-snug text-ink-2">
                    <InfoIcon size={12} className="mt-px shrink-0 text-ink-3" />
                    <span>This graph reads mesh maps. The material's pictures are made with stand-ins for them, since the material can go on any model; the maps in the 3D view are for looking only. To draw it with a model's own maps, use the graph as a fill or a smart mask in the Paint tab.</span>
                </div>
            )}
            <DownloadPicturesButton disabled={Boolean(baking) || !hasOutputs} onDownload={(format) => void downloadPictures(format)} />
            {stored.baked && (
                <div className="space-y-1 border-t border-line pt-2">
                    <div className="text-2xs font-semibold text-ink-2">Pictures the material draws with</div>
                    {Object.entries(stored.baked.textures).map(([role, id]) => (
                        <div key={role} className="flex justify-between text-2xs text-ink-3"><span>{ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role}</span><span className="truncate pl-2 text-ink-2">{textures.find((texture) => texture.id === id)?.name ?? 'missing'}</span></div>
                    ))}
                </div>
            )}
        </div>
    );

    const depth = path.length - 1;
    return (
        <div className={`min-h-0 min-w-0 flex-1 ${hidden ? 'hidden' : 'flex'}`}>
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                {variations && (() => {
                    const shownNode = graph.nodes.find((node) => node.id === viewed) ?? graph.nodes.find((node) => node.type === OUTPUT_NODE_TYPE);
                    if (!shownNode) return null;
                    const label = shownNode.name || (shownNode.type === OUTPUT_NODE_TYPE ? `Output: ${OUTPUT_CHANNEL_LABELS[shownNode.params.channel as OutputChannel] ?? ''}` : textureNodeDefinition(shownNode, resolve)?.label ?? 'the node');
                    return (
                        <VariationSheet session={session} graph={graph} values={stored.values} nodeId={shownNode.id} nodeLabel={label} resolve={resolve} texture={lookup}
                            onClose={() => setVariations(false)}
                            onKeep={(cell) => {
                                if ('seed' in cell.keep) update({ ...graph, seed: cell.keep.seed }, true);
                                else change({ values: { ...currentStored().values, [cell.keep.name]: cell.keep.value } });
                                setMessage({ text: `Kept ${cell.label}.`, tone: 'info' });
                                setVariations(false);
                            }} />
                    );
                })()}
                {depth > 0 && (
                    <nav aria-label="Graphs open" className="flex h-8 shrink-0 items-center gap-1 border-b border-line bg-panel px-1.5 text-2xs">
                        <IconButton label={`Back out to ${path[depth - 1]}`} onClick={() => onClose(depth - 1)}><ArrowLeftIcon size={13} /></IconButton>
                        {path.map((name, index) => (
                            <React.Fragment key={`${index}:${name}`}>
                                {index > 0 && <ChevronRightIcon size={11} className="shrink-0 text-ink-3" />}
                                {index < depth
                                    ? <button type="button" onClick={() => onClose(index)} className="max-w-[160px] truncate rounded px-1 py-0.5 text-ink-2 hover:bg-white/5 hover:text-ink">{name}</button>
                                    : <span className="max-w-[200px] truncate px-1 font-semibold text-ink">{name}</span>}
                            </React.Fragment>
                        ))}
                        <span className="ml-2 min-w-0 truncate text-ink-3" title={`Drawn with the images, settings and seed its node in ${path[depth - 1]} gives it. Edits change ${path[depth]} wherever it is used.`}>
                            Drawn as it is inside {path[depth - 1]}. Edits change it wherever it is used.
                        </span>
                    </nav>
                )}
                {editedProcessor && editedFn && (
                    <>
                        <nav aria-label="Function graph open" className="flex h-8 shrink-0 items-center gap-1 border-b border-line bg-panel px-1.5 text-2xs">
                            <IconButton label="Back to the graph" onClick={() => setFunctionOf(null)}><ArrowLeftIcon size={13} /></IconButton>
                            <button type="button" onClick={() => setFunctionOf(null)} className="max-w-[160px] truncate rounded px-1 py-0.5 text-ink-2 hover:bg-white/5 hover:text-ink">{path[depth]}</button>
                            <ChevronRightIcon size={11} className="shrink-0 text-ink-3" />
                            <span className="max-w-[240px] truncate px-1 font-semibold text-ink">{editedProcessor.name || textureNodeDefinition(editedProcessor, resolve)?.label}: function graph</span>
                            <span className="ml-2 min-w-0 truncate text-ink-3">
                                {processorUse(editedProcessor.type) === 'pixel'
                                    ? 'Worked out for every pixel: each node shows its value over the picture, with the processor\'s pictures and settings.'
                                    : 'Worked out once, on the GPU: each node shows its value.'}
                            </span>
                        </nav>
                        <FunctionGraphCanvas
                            key={editedProcessor.id}
                            fn={editedFn}
                            use={processorUse(editedProcessor.type)}
                            settings={editedSettings}
                            pictures={editedPictures}
                            previews={functionPreviews}
                            selection={functionSelectionSet}
                            canUndo={history.canUndo}
                            canRedo={history.canRedo}
                            onUndo={() => travel('undo')}
                            onRedo={() => travel('redo')}
                            onSelect={(ids) => { setFunctionSelection(ids); if (ids.length === 1) setTab('node'); }}
                            onChange={changeFunction}
                        />
                    </>
                )}
                <TextureGraphCanvas
                    key={asset.id}
                    hidden={Boolean(editedProcessor)}
                    graph={graph}
                    session={session}
                    resolve={resolve}
                    graphs={graphs}
                    selection={selectedSet}
                    selectedComment={selectedComment}
                    viewed={viewed}
                    canUndo={history.canUndo}
                    canRedo={history.canRedo}
                    notice={notice}
                    onSelect={select}
                    onView={view}
                    onChange={update}
                    onAddSubgraph={addSubgraph}
                    onOpenGraph={openGraph}
                    onUndo={() => travel('undo')}
                    onRedo={() => travel('redo')}
                />
            </div>
            <div className="flex w-[360px] shrink-0 flex-col border-l border-line bg-panel">
                <div className="flex min-h-0 flex-1 flex-col border-b border-line">
                    <TextureView2D session={session} nodeId={viewed} output={viewedOutput} node={graph.nodes.find((candidate) => candidate.id === viewed) ?? null} onParams={setParams}
                        worldWidth={graph.physicalSize?.w ?? 1} onPhotoCrop={cropPhoto} label={(() => {
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
            <aside className="flex w-[300px] shrink-0 flex-col border-l border-line bg-panel">
                <div className="border-b border-line p-2">
                    <Segmented value={tab} options={[{ value: 'node', label: 'Node' }, { value: 'graph', label: 'Graph' }, { value: 'material', label: 'Material' }]} onChange={setTab} label="Inspector" />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                    {tab === 'graph' && renamePreview && renamePreview.projectId === projectStatus.projectId &&
                        <ParameterRenamePreview preview={renamePreview}
                            stale={renamePreview.revision !== projectStatus.revision || renamePreview.libraryVersion !== materialLibrary.version || renamePreview.presetsVersion !== sharedVersion}
                            onRefresh={() => checkParameterRename(renamePreview.impact.from, renamePreview.impact.to, true)}
                            onDismiss={() => setRenamePreview(null)} />}
                    {message && <p className={`mb-2 text-2xs ${message.tone === 'error' ? 'text-bad' : 'text-accent'}`}>{message.text}</p>}
                    {tab === 'node' ? nodeInspector() : tab === 'graph' ? graphInspector() : materialInspector()}
                </div>
            </aside>
        </div>
    );
};

/** A new texture graph material, ready to edit. */
export const newTextureGraphStored = (graph: TextureGraph): Record<string, unknown> => ({ graph, values: {}, bakeSize: 11, layout: 'engine' });
