import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type * as THREE from 'three';
import { AlertTriangle, CheckCircle2, Dices, Download, ExternalLink, RefreshCw, Trash2 } from 'lucide-react';
import { useAssets } from '../../context/AssetContext';
import { useScene } from '../../context/SceneContext';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import { materialLibrary, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import { AbortedError, TextureGraphEvaluator } from '../../texturing/graph/evaluator';
import { coerceParameter } from '../../texturing/graph/document';
import { OUTPUT_NODE_TYPE, SUBGRAPH_NODE_TYPE } from '../../texturing/graph/nodes/io';
import { textureNodeDefinition, type GraphEntry, type GraphResolver } from '../../texturing/graph/registry';
import { bakeSignature, readStoredGraph, type StoredTextureGraph } from '../../texturing/graph/stored';
import { OUTPUT_CHANNELS, OUTPUT_CHANNEL_LABELS, type GraphParameter, type GraphParameterKind, type OutputChannel, type TexGraphNode, type TexParamDef, type TextureGraph } from '../../texturing/graph/types';
import { ROLE_LABELS, encodeChannels, materialGraphForTextures, type ChannelImages, type ChannelTextureIds, type MaterialChannel } from '../../texturing/materialOutput';
import { download, makeZip } from '../../texturing/zip';
import { Button, Segmented, Spinner } from '../UI/kit';
import { Select } from '../UI/Select';
import { GraphHistory, addSubgraphNode, type Point } from './graphEditing';
import { TextureGraphCanvas } from './TextureGraphCanvas';
import { ParamControl, TextureParamField, exposedKind } from './TextureParamField';
import { TextureGraphSession } from './textureGraphSession';
import { TextureView2D } from './TextureView2D';
import { TextureView3D } from './TextureView3D';
import { useTextureStore } from './useTextureStore';

/**
 * THE TEXTURE GRAPH WORKSPACE (a texture graph material in the Materials tab)
 *
 * The graph's canvas, the 2D view of one node, the 3D view of the material, and an inspector for
 * the selected node, the graph (its size, seed and exposed parameters) and the material made from
 * it. Every edit redraws at once; "Update material" makes the pictures the engine draws with.
 */

const SIZE_OPTIONS = [8, 9, 10, 11, 12, 13].map((log2) => ({ value: log2, label: `${2 ** log2} × ${2 ** log2}` }));
const RELATIVE_OPTIONS = [-3, -2, -1, 0, 1, 2].map((offset) => ({ value: offset, label: offset === 0 ? 'Same' : offset < 0 ? `1/${2 ** -offset}` : `× ${2 ** offset}` }));
const PARAMETER_KINDS: ReadonlyArray<{ value: GraphParameterKind; label: string }> = [
    { value: 'float', label: 'Number' }, { value: 'int', label: 'Whole number' }, { value: 'bool', label: 'Switch' },
    { value: 'color', label: 'Colour' }, { value: 'vec2', label: 'Pair of numbers' }, { value: 'select', label: 'Choice' },
];

type InspectorTab = 'node' | 'graph' | 'material';

const field = 'rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-xs text-zinc-100 outline-none focus:border-sky-600';

const sameGraph = (a: TextureGraph, b: TextureGraph): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** A graph parameter's value control, by its kind. */
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
    return <Workspace asset={asset} assets={assets} onSave={onSave} onOpenAsset={onOpenAsset} session={session} stored={stored} entries={entries} resolve={resolve} lookup={lookup} />;
};

const Workspace: React.FC<{
    asset: MaterialAsset;
    assets: readonly MaterialAsset[];
    onSave: (next: MaterialAsset, immediately?: boolean) => void;
    onOpenAsset: (id: string) => void;
    session: TextureGraphSession;
    stored: StoredTextureGraph;
    entries: Map<string, GraphEntry>;
    resolve: GraphResolver;
    lookup: (id: string) => THREE.Texture | null;
}> = ({ asset, onSave, onOpenAsset, session, stored, entries, resolve, lookup }) => {
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
    const histories = useRef(new Map<string, GraphHistory>());
    const dragBase = useRef<TextureGraph | null>(null);
    const [, setHistoryVersion] = useState(0);
    const history = useMemo(() => {
        let found = histories.current.get(asset.id);
        if (!found) histories.current.set(asset.id, found = new GraphHistory());
        return found;
    }, [asset.id]);

    // The first output is in the 2D view to begin with.
    useEffect(() => {
        if (viewed && graph.nodes.some((node) => node.id === viewed)) return;
        setViewed(graph.nodes.find((node) => node.type === OUTPUT_NODE_TYPE)?.id ?? graph.nodes[0]?.id ?? null);
    }, [graph.nodes, viewed]);

    const commitStored = useCallback((next: StoredTextureGraph, immediately = false) => {
        const current = materialLibrary.get(asset.id) ?? asset;
        const updated: MaterialAsset = { ...current, textureGraph: next as unknown as Record<string, unknown> };
        materialLibrary.upsert(updated);
        onSave(updated, immediately);
    }, [asset, onSave]);

    const update = useCallback((nextGraph: TextureGraph, commit: boolean, coalesce?: string) => {
        const current = readStoredGraph((materialLibrary.get(asset.id) ?? asset).textureGraph);
        if (!commit) {
            if (!dragBase.current) dragBase.current = current.graph;
            const updated: MaterialAsset = { ...(materialLibrary.get(asset.id) ?? asset), textureGraph: { ...current, graph: nextGraph } as unknown as Record<string, unknown> };
            materialLibrary.upsert(updated);
            return;
        }
        const base = dragBase.current ?? current.graph;
        dragBase.current = null;
        if (sameGraph(base, nextGraph)) {
            // Nothing really changed (a box confirmed its old value, a node was dropped where it started):
            // no undo step, and no save unless a drag left the stored graph elsewhere.
            if (!sameGraph(current.graph, nextGraph)) commitStored({ ...current, graph: nextGraph });
            return;
        }
        history.record(base, coalesce);
        setHistoryVersion((value) => value + 1);
        commitStored({ ...current, graph: nextGraph });
    }, [asset, commitStored, history]);

    const travel = (direction: 'undo' | 'redo') => {
        const current = readStoredGraph((materialLibrary.get(asset.id) ?? asset).textureGraph);
        const target = direction === 'undo' ? history.undo(current.graph) : history.redo(current.graph);
        if (!target) return;
        commitStored({ ...current, graph: target });
        setHistoryVersion((value) => value + 1);
    };

    const select = useCallback((ids: string[], comment: string | null = null) => {
        setSelection(ids);
        setSelectedComment(comment);
        if (ids.length === 1) setTab('node');
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

    // ---- making the material's pictures ----
    const signature = useMemo(() => bakeSignature(stored, resolve), [resolve, stored]);
    const upToDate = stored.baked?.signature === signature;
    const hasOutputs = graph.nodes.some((node) => node.type === OUTPUT_NODE_TYPE && node.params.channel !== 'custom');

    const renderChannels = async (evaluator: TextureGraphEvaluator, size: number): Promise<ChannelImages> => {
        const outputs = graph.nodes.filter((node) => node.type === OUTPUT_NODE_TYPE);
        const states = await evaluator.evaluate({ graph, parameters: stored.values, targets: outputs.map((node) => node.id), size: { w: size, h: size } });
        const images: ChannelImages = {};
        for (const node of outputs) {
            const channel = node.params.channel as OutputChannel;
            if (channel === 'custom' || images[channel as MaterialChannel]) continue;
            const state = states.get(node.id);
            if (state?.error) throw new Error(`${OUTPUT_CHANNEL_LABELS[channel]}: ${state.error}`);
            if (state?.outputs.out) images[channel as MaterialChannel] = state.outputs.out;
        }
        return images;
    };

    const updateMaterial = async () => {
        if (baking) return;
        setBaking('Drawing at full size…');
        setMessage(null);
        const evaluator = new TextureGraphEvaluator(session.gpu, resolve, lookup);
        const size = 2 ** stored.bakeSize;
        try {
            const images = await renderChannels(evaluator, stored.bakeSize);
            setBaking('Saving pictures…');
            const pictures = await encodeChannels(session.gpu, images, size, size, stored.layout, true);
            const ids: ChannelTextureIds = {};
            for (const picture of pictures) {
                ids[picture.role] = await textureStore.store(picture.blob, `${asset.name} ${ROLE_LABELS[picture.role]}`, { width: picture.width, height: picture.height }, `Texture graphs/${asset.name}`);
            }
            const current = materialLibrary.get(asset.id) ?? asset;
            const currentStored = readStoredGraph(current.textureGraph);
            const previous = Object.values(currentStored.baked?.textures ?? {}).filter((id): id is string => Boolean(id));
            const next: MaterialAsset = {
                ...current,
                graph: materialGraphForTextures(ids, { opacityMode: images.opacity ? 'masked' : undefined }),
                textureGraph: { ...currentStored, baked: { textures: ids, signature: bakeSignature(currentStored, resolve), size: currentStored.bakeSize, at: Date.now() } } as unknown as Record<string, unknown>,
            };
            materialLibrary.upsert(next);
            onSave(next, true);
            void textureStore.discard(previous);
            setMessage({ text: `The material now draws with ${pictures.length} new picture${pictures.length === 1 ? '' : 's'} at ${size} × ${size}.`, tone: 'info' });
        } catch (error) {
            if (!(error instanceof AbortedError)) {
                frontendDiagnostics.failure('texture_graph_bake_failed', error);
                setMessage({ text: error instanceof Error ? error.message : 'The pictures could not be made.', tone: 'error' });
            }
        } finally {
            evaluator.dispose();
            setBaking(null);
        }
    };

    const downloadPictures = async () => {
        if (baking) return;
        setBaking('Drawing pictures to download…');
        const evaluator = new TextureGraphEvaluator(session.gpu, resolve, lookup);
        const size = 2 ** stored.bakeSize;
        try {
            const images = await renderChannels(evaluator, stored.bakeSize);
            const pictures = await encodeChannels(session.gpu, images, size, size, 'separate', true);
            const base = asset.name.replace(/[^\w-]+/g, '_') || 'material';
            const zip = await makeZip(pictures.map((picture) => ({ name: `${base}_${picture.role}.png`, data: picture.blob })));
            download(zip, `${base}_${size}.zip`);
        } catch (error) {
            setMessage({ text: error instanceof Error ? error.message : 'The pictures could not be made.', tone: 'error' });
        } finally {
            evaluator.dispose();
            setBaking(null);
        }
    };

    // ---- inspector parts ----
    const nodes = new Set(graph.nodes.map((node) => node.id));
    const selected = selection.filter((id) => nodes.has(id));
    const single = selected.length === 1 ? graph.nodes.find((node) => node.id === selected[0]) ?? null : null;
    void sessionVersion;

    const changeNode = (node: TexGraphNode, coalesce?: string) => update({ ...graph, nodes: graph.nodes.map((candidate) => (candidate.id === node.id ? node : candidate)) }, true, coalesce);

    const changeParameters = (parameters: GraphParameter[], values = stored.values) => {
        const current = readStoredGraph((materialLibrary.get(asset.id) ?? asset).textureGraph);
        history.record(current.graph);
        setHistoryVersion((value) => value + 1);
        commitStored({ ...current, graph: { ...current.graph, parameters }, values });
    };

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

    const nodeInspector = () => {
        if (!single) {
            return <p className="text-2xs leading-snug text-zinc-500">{selected.length > 1 ? `${selected.length} nodes selected. Delete removes them, C puts a comment round them.` : 'Select a node to change its settings. Double-click one to look at it in the 2D view.'}</p>;
        }
        const definition = textureNodeDefinition(single, resolve);
        if (!definition) return <p className="text-2xs text-red-400">This build does not know this node.</p>;
        const state = session.state(single.id);
        const isOutput = single.type === OUTPUT_NODE_TYPE;
        const sizeMode = single.size?.mode ?? definition.sizeFrom;
        return (
            <div className="space-y-3">
                <div>
                    <div className="text-xs font-semibold text-zinc-100">{definition.label}</div>
                    <p className="mt-0.5 text-2xs leading-snug text-zinc-500">{definition.description}</p>
                </div>
                {state?.error && <div className="flex gap-1.5 rounded border border-red-900 bg-red-950/50 p-1.5 text-2xs text-red-200"><AlertTriangle size={12} className="mt-px shrink-0" /><span className="whitespace-pre-wrap font-mono">{state.error}</span></div>}
                {single.type === SUBGRAPH_NODE_TYPE && typeof single.params.graph === 'string' && entries.has(single.params.graph) && (
                    <Button size="sm" icon={<ExternalLink size={12} />} onClick={() => onOpenAsset(single.params.graph as string)}>Open {entries.get(single.params.graph)!.name}</Button>
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
                        <div className="grid grid-cols-2 gap-1.5">
                            <Select value={sizeMode} options={[{ value: 'input', label: 'Follow input' }, { value: 'graph', label: 'Follow graph' }, { value: 'absolute', label: 'Fixed' }]}
                                onChange={(mode) => changeNode({ ...single, size: { mode, w: mode === 'absolute' ? graph.size.w : 0, h: mode === 'absolute' ? graph.size.h : 0 } })} />
                            {sizeMode === 'absolute'
                                ? <Select value={single.size?.w ?? 10} options={SIZE_OPTIONS} onChange={(value) => changeNode({ ...single, size: { mode: 'absolute', w: Number(value), h: Number(value) } })} />
                                : <Select value={single.size?.w ?? 0} options={RELATIVE_OPTIONS} onChange={(value) => changeNode({ ...single, size: { mode: sizeMode, w: Number(value), h: Number(value) } })} />}
                        </div>
                        <Segmented value={String(single.precision ?? 'auto')} options={[{ value: 'auto', label: 'Auto' }, { value: '8', label: '8-bit' }, { value: '16', label: '16-bit' }, { value: '32', label: '32-bit' }]}
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
                <Select value={graph.size.w} options={SIZE_OPTIONS.slice(0, 5)} onChange={(value) => update({ ...graph, size: { w: Number(value), h: Number(value) } }, true)} className="w-32" />
                <span className="text-2xs text-zinc-400">Random seed</span>
                <div className="flex items-center gap-1">
                    <input aria-label="Graph random seed" type="number" min={0} max={999} value={graph.seed} onChange={(event) => update({ ...graph, seed: Math.max(0, Math.min(999, Math.round(Number(event.target.value) || 0))) }, true, 'seed')} className={`w-16 ${field}`} />
                    <button aria-label="Another seed" title="Another seed" onClick={() => update({ ...graph, seed: Math.floor(Math.random() * 1000) }, true)} className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white"><Dices size={13} /></button>
                </div>
            </div>
            <div className="space-y-2 border-t border-zinc-800 pt-2">
                <div className="flex items-center">
                    <span className="flex-1 text-2xs font-semibold text-zinc-300">Parameters</span>
                    <Select value="" placeholder="Add…" options={[...PARAMETER_KINDS]} onChange={(kind) => {
                        let name = 'value';
                        for (let n = 2; graph.parameters.some((parameter) => parameter.name === name); n++) name = `value${n}`;
                        const parameter: GraphParameter = { name, label: name, kind, default: coerceParameter(kind, kind === 'select' ? 'a' : kind === 'float' ? 0.5 : undefined, kind === 'select' ? [{ value: 'a' }] : undefined), ...(kind === 'float' ? { min: 0, max: 1 } : kind === 'int' ? { min: 0, max: 10 } : {}), ...(kind === 'select' ? { options: [{ value: 'a', label: 'First' }, { value: 'b', label: 'Second' }] } : {}) };
                        changeParameters([...graph.parameters, parameter]);
                    }} className="w-24" />
                </div>
                {graph.parameters.length === 0 && <p className="text-2xs leading-snug text-zinc-500">None yet. Use the link button beside any node setting to expose it here; materials using this graph set them.</p>}
                {graph.parameters.map((parameter, index) => (
                    <div key={parameter.name} className="space-y-1.5 rounded border border-zinc-800 bg-zinc-900/60 p-2">
                        <div className="flex items-center gap-1">
                            <input aria-label="Parameter label" value={parameter.label} onChange={(event) => changeParameters(graph.parameters.map((p, i) => (i === index ? { ...p, label: event.target.value.slice(0, 64) || p.name } : p)))} className={`min-w-0 flex-1 ${field}`} />
                            <button aria-label={`Remove ${parameter.label}`} onClick={() => {
                                // Settings that followed it keep the value it had.
                                const value = stored.values[parameter.name] ?? parameter.default;
                                const nextGraph = { ...graph, parameters: graph.parameters.filter((_, i) => i !== index), nodes: graph.nodes.map((node) => ({ ...node, params: Object.fromEntries(Object.entries(node.params).map(([key, v]) => [key, v && typeof v === 'object' && (v as { $bind?: string }).$bind === parameter.name ? structuredClone(value) : v])) })) };
                                update(nextGraph, true);
                            }} className="rounded p-1 text-zinc-500 hover:text-red-400"><Trash2 size={12} /></button>
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
                                <input aria-label="Lowest" type="number" value={parameter.min ?? 0} onChange={(event) => changeParameters(graph.parameters.map((p, i) => (i === index ? { ...p, min: Number(event.target.value) } : p)))} className={`w-14 ${field}`} />
                                <span>to</span>
                                <input aria-label="Highest" type="number" value={parameter.max ?? 1} onChange={(event) => changeParameters(graph.parameters.map((p, i) => (i === index ? { ...p, max: Number(event.target.value) } : p)))} className={`w-14 ${field}`} />
                            </div>
                        )}
                        <div className="flex items-center gap-2">
                            <span className="text-2xs text-zinc-400">Value</span>
                            <div className="min-w-0 flex-1">
                                <ParamControl param={parameterDef(parameter)} value={stored.values[parameter.name] ?? parameter.default} textures={textures}
                                    onChange={(value) => {
                                        const current = readStoredGraph((materialLibrary.get(asset.id) ?? asset).textureGraph);
                                        commitStored({ ...current, values: { ...current.values, [parameter.name]: coerceParameter(parameter.kind, value, parameter.options) } });
                                    }} />
                            </div>
                        </div>
                    </div>
                ))}
            </div>
            <div className="space-y-1 border-t border-zinc-800 pt-2">
                <label className="flex items-center gap-2 text-2xs text-zinc-400">
                    <input type="checkbox" checked={Boolean(stored.library)} onChange={(event) => commitStored({ ...stored, library: event.target.checked || undefined })} className="accent-sky-500" />
                    Mainly for use inside other graphs
                </label>
            </div>
        </div>
    );

    const materialInspector = () => (
        <div className="space-y-3">
            <div className={`flex items-start gap-1.5 rounded border p-2 text-2xs ${upToDate ? 'border-emerald-900 bg-emerald-950/40 text-emerald-200' : 'border-amber-900 bg-amber-950/40 text-amber-200'}`}>
                {upToDate ? <CheckCircle2 size={13} className="mt-px shrink-0" /> : <RefreshCw size={13} className="mt-px shrink-0" />}
                <span>{upToDate
                    ? `Models with this material show the graph as it is now (${2 ** (stored.baked?.size ?? stored.bakeSize)} pixels).`
                    : stored.baked ? 'The graph has changed since the material was last updated. Models still show the earlier pictures.' : 'Models with this material show nothing of the graph until the material is updated.'}</span>
            </div>
            <Button variant="primary" className="w-full justify-center" disabled={Boolean(baking) || !hasOutputs} onClick={() => void updateMaterial()} icon={baking ? <Spinner /> : <RefreshCw size={13} />}>
                {baking ?? 'Update material'}
            </Button>
            {!hasOutputs && <p className="text-2xs text-zinc-500">Add an Output node for a channel (base colour, normal...) to make a material.</p>}
            <div className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1.5">
                <span className="text-2xs text-zinc-400">Picture size</span>
                <Select value={stored.bakeSize} options={SIZE_OPTIONS.slice(1)} onChange={(value) => commitStored({ ...stored, bakeSize: Number(value) })} className="w-32" />
                <span className="text-2xs text-zinc-400">Pictures</span>
                <Select value={stored.layout} options={[{ value: 'engine', label: 'Packed (fewer)' }, { value: 'separate', label: 'One per channel' }]} onChange={(value) => commitStored({ ...stored, layout: value === 'separate' ? 'separate' : 'engine' })} className="w-32" />
            </div>
            <p className="text-2xs leading-snug text-zinc-500">Packed keeps occlusion, roughness and metallic in one picture's red, green and blue, which the engine reads in one go.</p>
            <Button size="sm" className="w-full justify-center" disabled={Boolean(baking) || !hasOutputs} onClick={() => void downloadPictures()} icon={<Download size={12} />}>Download pictures</Button>
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
                    <TextureView3D gpu={session.gpu} preview={session.preview} version={session.preview.version} models={models.filter((model) => model.category !== 'Animation')} />
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

