import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronDownIcon, ChevronRightIcon, CommentAddIcon, FlowIcon, GraphIcon, PlusIcon, TrashIcon, WarningIcon } from '../UI/Icons';
import { useAssets } from '../../context/AssetContext';
import { projectService } from '../../utils/projectService';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import {
    MAX_COMMENT_LENGTH,
    MAX_PARAMETER_NAME_LENGTH,
    OUTPUT_NODE_TYPE,
    PARAMETER_NODE_PARAMS,
    compileMaterialGraph,
    createMaterialGraph,
    getMaterialNodeDefinition,
    materialGraphLook,
    materialGraphSettings,
    materialGraphShape,
    readParam,
    type MaterialGraph,
    type MaterialGraphNode,
    type MaterialParamDef,
} from '../../runtime/materials/materialGraph';
import { MATERIALS_DOMAIN, materialAssetDocument, materialLibrary, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import { MaterialFromDescription } from './MaterialFromDescription';
import { STARTER_MATERIALS } from '../../runtime/materials/starterMaterials';
import { MaterialGraphCanvas } from './MaterialGraphCanvas';
import { MaterialPreview, clearMaterialShaderError, useMaterialShaderError } from './MaterialPreview';
import { ParamField } from './MaterialParamField';
import { GraphHistory, createComment, nodeRect, removeNodes, showsPreview, withComments } from './materialGraphEditing';
import { Popover } from '../UI/kit';
import { OPEN_MATERIAL_EVENT, takeOpenMaterialRequest } from '../Texturing/Paint/openMaterial';
import { isSmartMaterialAsset } from '../../texturing/paint/smartMaterials';
import { createFunctionGraph, createTextureGraph } from '../../texturing/graph/document';
import { TextureGraphWorkspace, newTextureGraphStored } from '../Texturing/TextureGraphWorkspace';

/**
 * MATERIAL GRAPH EDITOR (the Materials tab)
 *
 * The project's material assets: each a node graph wired into a Material Output, edited on a canvas
 * (MaterialGraphCanvas.tsx) where every node shows its value, and shown on a lit, shadowed preview
 * as it changes. With nothing selected the inspector shows the material's own settings (blend mode,
 * alpha clip, two-sided, unlit). Models' materials take an asset in Properties › Material Overrides;
 * every material using an asset follows edits to it straight away. Undo is kept for each material for
 * the session, so it survives switching tabs and switching material.
 *
 * A material can instead be made by a texture graph (components/Texturing): images drawn node by
 * node into the pictures the material draws with.
 */

// Edits made in quick succession (dragging a slider) are saved together.
const SAVE_DELAY_MS = 400;
const COMMENT_COLORS = ['#3b4252', '#1e3a5f', '#14532d', '#713f12', '#7f1d1d', '#4c1d95', '#134e4a', '#57534e'];
const PREVIEWS_KEY = 'auvra.materialNodePreviews';

/** The material assets, re-rendering when they change. */
const useMaterialAssets = (): MaterialAsset[] => {
    const version = useSyncExternalStore((listener) => materialLibrary.subscribe(listener), () => materialLibrary.version);
    return useMemo(() => materialLibrary.list(), [version]);
};

const readPreviewsSetting = (): boolean => {
    try { return localStorage.getItem(PREVIEWS_KEY) !== 'off'; } catch { return true; }
};

/**
 * Each material's undo history for the session, outliving the tab (which unmounts when left). Begun
 * afresh when another project opens.
 */
const sessionHistories = new Map<string, GraphHistory>();
let historiesGeneration = -1;

const historyOf = (id: string): GraphHistory => {
    if (historiesGeneration !== materialLibrary.generation) {
        sessionHistories.clear();
        historiesGeneration = materialLibrary.generation;
    }
    let found = sessionHistories.get(id);
    if (!found) sessionHistories.set(id, found = new GraphHistory());
    return found;
};

/** Groups of the Material Output open from the start; the rest open once they are used. */
const OPEN_GROUPS = new Set(['Base', 'Emission', 'Opacity']);

const NodeInspector: React.FC<{
    node: MaterialGraphNode;
    textures: { id: string; name: string }[];
    title?: string;
    /** Inputs of the node that are wired: their values come from the wire. */
    wired?: ReadonlySet<string>;
    onChangeNode: (node: MaterialGraphNode, coalesce?: string) => void;
}> = ({ node, textures, title, wired, onChangeNode }) => {
    const definition = getMaterialNodeDefinition(node.type)!;
    const [toggled, setToggled] = useState<Record<string, boolean>>({});
    const blendMode = node.type === OUTPUT_NODE_TYPE ? materialGraphSettings({ nodes: [node], links: [] }).blendMode : null;
    const field = (param: MaterialParamDef) => {
        // The clip only matters to a masked material.
        if (param.key === 'alphaClip' && blendMode !== 'masked') return null;
        if (wired?.has(param.key)) {
            return (
                <div key={param.key} className="flex items-center justify-between text-2xs">
                    <span className="text-gray-500">{param.label}</span>
                    <span className="text-gray-400">Set by its wire</span>
                </div>
            );
        }
        return (
            <ParamField
                key={param.key}
                param={param}
                value={node.params[param.key]}
                textures={textures}
                onChange={(value) => onChangeNode({ ...node, params: { ...node.params, [param.key]: value } }, `${node.id}:${param.key}`)}
            />
        );
    };
    // Settings first, then the values of each group under a header of its own.
    const loose = definition.params.filter(param => !param.group);
    const groups = [...new Set(definition.params.flatMap(param => (param.group ? [param.group] : [])))];
    const used = (group: string) => definition.params.some(param => param.group === group
        && (wired?.has(param.key) || JSON.stringify(readParam(param, node.params[param.key])) !== JSON.stringify(param.default)));
    return (
        <div className="space-y-2 rounded border border-gray-800 bg-gray-900/60 p-2">
            <div className="text-2xs font-bold text-gray-200">{title ?? definition.label}</div>
            <p className="text-2xs leading-snug text-gray-500">{definition.description}</p>
            {definition.params.length === 0 && <p className="text-2xs text-gray-500">No settings.</p>}
            {loose.map(field)}
            {groups.map((group) => {
                const open = toggled[group] ?? (OPEN_GROUPS.has(group) || used(group));
                return (
                    <div key={group} className="border-t border-gray-800 pt-1.5">
                        <button
                            type="button"
                            aria-expanded={open}
                            onClick={() => setToggled((current) => ({ ...current, [group]: !open }))}
                            className="flex w-full items-center gap-1 text-left text-2xs font-semibold text-gray-300 hover:text-white"
                        >
                            {open ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} />}
                            {group}
                            {!open && used(group) && <span className="ml-auto text-2xs font-normal text-gray-500">In use</span>}
                        </button>
                        {open && <div className="mt-1.5 space-y-2">{definition.params.filter(param => param.group === group).map(field)}</div>}
                    </div>
                );
            })}
            {PARAMETER_NODE_PARAMS[node.type] && (
                <label className="block space-y-1" title="Name this value to let each model material using the asset set its own">
                    <span className="text-2xs text-gray-500">Parameter name</span>
                    <input
                        aria-label="Parameter name"
                        value={node.parameter ?? ''}
                        placeholder="Not a parameter"
                        maxLength={MAX_PARAMETER_NAME_LENGTH}
                        onChange={(event) => {
                            const { parameter: _previous, ...rest } = node;
                            // Kept as typed (a trailing space included) and trimmed when read back.
                            onChangeNode(event.target.value ? { ...rest, parameter: event.target.value } : rest, `${node.id}:parameter`);
                        }}
                        className="w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-white"
                    />
                </label>
            )}
        </div>
    );
};

export const MaterialGraphEditor: React.FC = () => {
    const allAssets = useMaterialAssets();
    // Saved smart materials are painting presets, not materials to edit or give to models.
    const assets = useMemo(() => allAssets.filter((candidate) => !isSmartMaterialAsset(candidate)), [allAssets]);
    const { textures, removeMaterialAsset } = useAssets();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [selection, setSelection] = useState<string[]>([]);
    const [selectedComment, setSelectedComment] = useState<string | null>(null);
    const [previews, setPreviews] = useState(readPreviewsSetting);
    const [error, setError] = useState<string | null>(null);
    const [, setHistoryVersion] = useState(0);
    const shaderError = useMaterialShaderError();
    const asset = assets.find(candidate => candidate.id === selectedId) ?? assets[0] ?? null;
    // A material another tab asked to open (Paint's "edit a copy"): taken when this tab opens, and while it is open.
    useEffect(() => {
        const takeRequest = () => {
            const id = takeOpenMaterialRequest();
            if (id) { setSelectedId(id); setSelection([]); }
        };
        takeRequest();
        window.addEventListener(OPEN_MATERIAL_EVENT, takeRequest);
        return () => window.removeEventListener(OPEN_MATERIAL_EVENT, takeRequest);
    }, []);
    const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    /** The graph before a drag began, recorded for undo when the drag ends. */
    const dragBase = useRef(new Map<string, MaterialGraph>());

    const history = useCallback((id: string) => historyOf(id), []);

    const save = useCallback((next: MaterialAsset, immediately = false) => {
        const timers = pending.current;
        clearTimeout(timers.get(next.id));
        const write = () => {
            timers.delete(next.id);
            projectService.applyChanges([{ domain: MATERIALS_DOMAIN, operation: 'upsert', id: next.id, value: materialAssetDocument(next) }])
                .then(() => setError(null), (failure: unknown) => {
                    frontendDiagnostics.failure('material_save_failed', failure);
                    setError('The material could not be saved: is a project open?');
                });
        };
        if (immediately) write();
        else timers.set(next.id, setTimeout(write, SAVE_DELAY_MS));
    }, []);
    useEffect(() => () => {
        // Leaving the tab saves what is waiting.
        for (const [id, timer] of pending.current) {
            clearTimeout(timer);
            const waiting = materialLibrary.get(id);
            if (waiting) void projectService.applyChanges([{ domain: MATERIALS_DOMAIN, operation: 'upsert', id, value: materialAssetDocument(waiting) }]).catch(() => undefined);
        }
    }, []);

    const update = useCallback((graph: MaterialGraph, commit: boolean, coalesce?: string) => {
        if (!asset) return;
        const current = materialLibrary.get(asset.id) ?? asset;
        if (graph !== current.graph) materialLibrary.upsert({ ...current, graph });
        if (!commit) {
            if (!dragBase.current.has(asset.id)) dragBase.current.set(asset.id, current.graph);
            return;
        }
        const base = dragBase.current.get(asset.id) ?? current.graph;
        dragBase.current.delete(asset.id);
        if (base === graph) return;
        history(asset.id).record(base, coalesce);
        setHistoryVersion(version => version + 1);
        save({ ...current, graph });
    }, [asset, history, save]);

    const travel = (direction: 'undo' | 'redo') => {
        if (!asset) return;
        const current = materialLibrary.get(asset.id) ?? asset;
        const steps = history(asset.id);
        const graph = direction === 'undo' ? steps.undo(current.graph) : steps.redo(current.graph);
        if (!graph) return;
        dragBase.current.delete(asset.id);
        const next = { ...current, graph };
        materialLibrary.upsert(next);
        save(next);
        setHistoryVersion(version => version + 1);
    };

    const select = useCallback((nodeIds: string[], comment: string | null = null) => {
        setSelection(nodeIds);
        setSelectedComment(comment);
    }, []);

    const create = () => {
        const next: MaterialAsset = { id: crypto.randomUUID(), name: `Material ${assets.length + 1}`, graph: createMaterialGraph() };
        materialLibrary.upsert(next);
        save(next, true);
        setSelectedId(next.id);
        select([]);
    };

    const createTextureGraph_ = (forOtherGraphs: boolean) => {
        const stored = newTextureGraphStored(forOtherGraphs ? createFunctionGraph() : createTextureGraph());
        if (forOtherGraphs) stored.library = true;
        const next: MaterialAsset = { id: crypto.randomUUID(), name: forOtherGraphs ? `Graph ${assets.length + 1}` : `Texture ${assets.length + 1}`, graph: createMaterialGraph(), textureGraph: stored };
        materialLibrary.upsert(next);
        save(next, true);
        setSelectedId(next.id);
        select([]);
    };
    const newButton = useRef<HTMLButtonElement>(null);
    const [newMenu, setNewMenu] = useState(false);

    /** A new shader graph from a starter: its own copy, named after it. */
    const createFromStarter = (name: string, starter: MaterialGraph) => {
        const taken = new Set(assets.map(candidate => candidate.name));
        let unique = name;
        for (let n = 2; taken.has(unique); n++) unique = `${name} ${n}`;
        const next: MaterialAsset = { id: crypto.randomUUID(), name: unique, graph: starter };
        materialLibrary.upsert(next);
        save(next, true);
        setSelectedId(next.id);
        select([]);
    };

    const createFromDescription = (name: string, painted: MaterialGraph) => {
        const next: MaterialAsset = { id: crypto.randomUUID(), name: name.slice(0, 128) || 'Material', graph: painted };
        materialLibrary.upsert(next);
        save(next, true);
        setSelectedId(next.id);
        select([]);
    };

    const rename = (name: string) => {
        if (!asset) return;
        const next = { ...asset, name: name.slice(0, 128) || 'Material' };
        materialLibrary.upsert(next);
        save(next);
    };

    const remove = () => {
        if (!asset) return;
        // A save still waiting would bring it back.
        clearTimeout(pending.current.get(asset.id));
        pending.current.delete(asset.id);
        sessionHistories.delete(asset.id);
        removeMaterialAsset(asset.id).then(() => {
            setError(null);
            setSelectedId(null);
            select([]);
        }, (failure: unknown) => {
            frontendDiagnostics.failure('material_remove_failed', failure);
            setError('The material could not be deleted.');
        });
    };

    const togglePreviews = () => {
        setPreviews((value) => {
            try { localStorage.setItem(PREVIEWS_KEY, value ? 'off' : 'on'); } catch { /* the choice just is not remembered */ }
            return !value;
        });
    };

    const graph = asset?.graph ?? null;

    // Only a change to what the graph computes (not to where nodes sit) reaches the previews.
    const signature = useMemo(() => (graph ? materialGraphLook(graph) : ''), [graph]);
    const shading = useRef<{ signature: string; graph: MaterialGraph | null }>({ signature: '', graph: null });
    if (shading.current.signature !== signature || (graph && !shading.current.graph)) shading.current = { signature, graph };
    const shadingGraph = shading.current.graph;

    // Unused nodes and the shader's size change only with its shape, not with values dragged on a slider.
    const shape = useMemo(() => (shadingGraph ? materialGraphShape(shadingGraph) : ''), [shadingGraph]);
    const shapeGraph = useRef<MaterialGraph | null>(null);
    shapeGraph.current = shadingGraph;
    const analysis = useMemo(() => {
        const current = shapeGraph.current;
        if (!current) return null;
        const fragment = compileMaterialGraph(current);
        const vertex = compileMaterialGraph(current, { stage: 'vertex' });
        const vertexUnused = new Set(vertex.unused);
        return {
            key: `${fragment.key}#${vertex.key}`,
            unused: new Set(fragment.unused.filter(id => vertexUnused.has(id))),
            statements: fragment.statements.length + (fragment.connected.has('worldPositionOffset') ? vertex.statements.length : 0),
        };
    }, [shape]);
    // A change to the shader's shape compiles it afresh: forget the last error.
    useEffect(() => { clearMaterialShaderError(); }, [analysis?.key]);

    const previewIdsKey = shadingGraph && previews ? shadingGraph.nodes.filter(showsPreview).map(node => node.id).join(',') : '';
    const previewNodeIds = useMemo(() => (previewIdsKey ? previewIdsKey.split(',') : []), [previewIdsKey]);

    const nodeIds = new Set(graph?.nodes.map(node => node.id) ?? []);
    const selected = new Set(selection.filter(id => nodeIds.has(id)));
    const comment = graph?.comments?.find(candidate => candidate.id === selectedComment) ?? null;
    const single = selected.size === 1 ? graph!.nodes.find(node => selected.has(node.id)) ?? null : null;
    const outputNode = graph?.nodes.find(node => node.type === OUTPUT_NODE_TYPE) ?? null;
    const outputWired = new Set(graph && outputNode ? graph.links.filter(link => link.toNode === outputNode.id).map(link => link.toInput) : []);
    const steps = asset ? history(asset.id) : null;

    const changeNode = (node: MaterialGraphNode, coalesce?: string) => {
        if (!graph) return;
        update({ ...graph, nodes: graph.nodes.map(candidate => (candidate.id === node.id ? node : candidate)) }, true, coalesce);
    };

    const changeComment = (changes: Partial<{ text: string; color: string }>) => {
        if (!graph || !comment) return;
        update(withComments(graph, (graph.comments ?? []).map(candidate => (candidate.id === comment.id ? { ...candidate, ...changes } : candidate))), true, `${comment.id}:${Object.keys(changes).join()}`);
    };

    return (
        <div className="flex h-full min-h-0 w-full bg-gray-950 text-white">
            <aside className="flex w-56 shrink-0 flex-col border-r border-gray-800">
                <div className="flex items-center gap-1.5 border-b border-gray-800 px-3 py-2">
                    <span className="text-xs font-bold text-gray-400">Materials</span>
                    <span className="flex-1" />
                    <MaterialFromDescription onCreated={createFromDescription} />
                    <button ref={newButton} onClick={() => setNewMenu(true)} aria-label="New material" className="flex items-center gap-1 rounded bg-gray-800 px-2 py-1 text-2xs text-gray-200 hover:bg-gray-700"><PlusIcon size={12} /> New</button>
                    <Popover anchor={newButton} open={newMenu} onClose={() => setNewMenu(false)} width={280} label="New material">
                        <div className="p-1">
                            {[
                                { key: 'texture', icon: <GraphIcon size={14} />, title: 'Texture graph', text: 'Noises, patterns, blurs and filters drawn into the material\'s pictures: base colour, normal, roughness and the rest.', run: () => createTextureGraph_(false) },
                                { key: 'shader', icon: <FlowIcon size={14} />, title: 'Shader graph', text: 'Maths worked out for every pixel as the model draws: moving, glowing and view-dependent looks.', run: create },
                                { key: 'function', icon: <GraphIcon size={14} />, title: 'Graph for other graphs', text: 'A texture graph with an input, made to be used as one node inside others (a smart mask, a filter).', run: () => createTextureGraph_(true) },
                            ].map((item) => (
                                <button key={item.key} onClick={() => { setNewMenu(false); item.run(); }} className="flex w-full gap-2 rounded px-2 py-1.5 text-left hover:bg-gray-800">
                                    <span className="mt-0.5 text-gray-400">{item.icon}</span>
                                    <span><span className="block text-xs text-gray-100">{item.title}</span><span className="block text-2xs leading-snug text-gray-500">{item.text}</span></span>
                                </button>
                            ))}
                            <div className="mx-2 mb-1 mt-2 border-t border-gray-800 pt-2 text-2xs font-semibold text-gray-400">Start from a shader graph</div>
                            {STARTER_MATERIALS.map((starter) => (
                                <button key={starter.key} onClick={() => { setNewMenu(false); createFromStarter(starter.name, starter.graph()); }} className="flex w-full gap-2 rounded px-2 py-1 text-left hover:bg-gray-800">
                                    <span className="mt-0.5 text-gray-400"><FlowIcon size={14} /></span>
                                    <span><span className="block text-xs text-gray-100">{starter.name}</span><span className="block text-2xs leading-snug text-gray-500">{starter.description}</span></span>
                                </button>
                            ))}
                        </div>
                    </Popover>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                    {assets.length === 0 && <p className="px-1 text-2xs text-gray-500">No materials yet. A material is a node graph; give one to a model's material in Properties › Material Overrides.</p>}
                    {assets.map(candidate => (
                        <button
                            key={candidate.id}
                            onClick={() => { setSelectedId(candidate.id); select([]); }}
                            className={`mb-1 w-full truncate rounded px-2 py-1.5 text-left text-xs ${candidate.id === asset?.id ? 'bg-blue-900/40 text-white' : 'text-gray-300 hover:bg-gray-800'}`}
                        >
                            <span className="flex items-center gap-1.5">{candidate.textureGraph ? <GraphIcon size={11} className="shrink-0 text-amber-400/80" /> : <FlowIcon size={11} className="shrink-0 text-sky-400/80" />}<span className="truncate">{candidate.name}</span></span>
                        </button>
                    ))}
                </div>
            </aside>

            {asset && asset.textureGraph ? (
                <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex items-center gap-2 border-b border-gray-800 px-3 py-1.5">
                        <GraphIcon size={13} className="text-amber-400/80" />
                        <input aria-label="Material name" value={asset.name} onChange={(event) => rename(event.target.value)} className="w-64 rounded border border-gray-700 bg-gray-950 px-2 py-0.5 text-xs text-white" />
                        <span className="text-2xs text-gray-500">Texture graph</span>
                        <span className="flex-1" />
                        {error && <span className="text-2xs text-amber-400">{error}</span>}
                        <button onClick={remove} aria-label="Delete material" className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-red-400"><TrashIcon size={14} /></button>
                    </div>
                    <TextureGraphWorkspace key={asset.id} asset={asset} assets={assets} onSave={save} onOpenAsset={(id) => { setSelectedId(id); select([]); }} />
                </div>
            ) : asset && graph ? (
                <>
                    <MaterialGraphCanvas
                        key={asset.id}
                        graph={graph}
                        selection={selected}
                        selectedComment={comment?.id ?? null}
                        previews={previews}
                        unused={analysis?.unused ?? new Set()}
                        canUndo={!!steps?.canUndo}
                        canRedo={!!steps?.canRedo}
                        onSelect={select}
                        onChange={update}
                        onUndo={() => travel('undo')}
                        onRedo={() => travel('redo')}
                        onTogglePreviews={togglePreviews}
                    />
                    <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-gray-800 p-3">
                        <div className="flex items-center gap-2">
                            <input aria-label="Material name" value={asset.name} onChange={(event) => rename(event.target.value)} className="min-w-0 flex-1 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-white" />
                            <button onClick={remove} aria-label="Delete material" className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-red-400"><TrashIcon size={14} /></button>
                        </div>
                        <MaterialPreview assetId={asset.id} graph={shadingGraph ?? graph} previewNodeIds={previewNodeIds} />
                        {shaderError && (
                            <div role="alert" className="rounded border border-red-900 bg-red-950/60 p-2">
                                <div className="mb-1 flex items-center gap-1 text-2xs font-bold text-red-300"><WarningIcon size={12} /> The shader does not compile</div>
                                <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-2xs leading-4 text-red-200">{shaderError}</pre>
                            </div>
                        )}
                        {error && <p className="text-2xs text-amber-400">{error}</p>}
                        {analysis && (
                            <p className="text-2xs text-gray-500">
                                {graph.nodes.length} nodes · {analysis.statements} shader statements{analysis.unused.size ? ` · ${analysis.unused.size} unused` : ''}
                            </p>
                        )}

                        {single ? (
                            <NodeInspector key={single.id} node={single} textures={textures} wired={single.id === outputNode?.id ? outputWired : undefined} onChangeNode={changeNode} />
                        ) : selected.size > 1 ? (
                            <div className="space-y-2 rounded border border-gray-800 bg-gray-900/60 p-2">
                                <div className="text-2xs font-bold text-gray-200">{selected.size} nodes selected</div>
                                <div className="flex gap-2">
                                    <button onClick={() => { update(removeNodes(graph, selected), true); select([]); }} className="flex items-center gap-1 rounded bg-gray-800 px-2 py-1 text-2xs text-gray-200 hover:bg-red-900"><TrashIcon size={12} /> Delete</button>
                                    <button
                                        onClick={() => {
                                            const created = createComment(graph.nodes.filter(node => selected.has(node.id)).map(node => nodeRect(node, previews)), { x: 0, y: 0 });
                                            update(withComments(graph, [...(graph.comments ?? []), created]), true);
                                            select([], created.id);
                                        }}
                                        className="flex items-center gap-1 rounded bg-gray-800 px-2 py-1 text-2xs text-gray-200 hover:bg-gray-700"
                                    >
                                        <CommentAddIcon size={12} /> Comment
                                    </button>
                                </div>
                            </div>
                        ) : comment ? (
                            <div className="space-y-2 rounded border border-gray-800 bg-gray-900/60 p-2">
                                <div className="text-2xs font-bold text-gray-200">Comment</div>
                                <textarea aria-label="Comment text" value={comment.text} maxLength={MAX_COMMENT_LENGTH} rows={2} onChange={(event) => changeComment({ text: event.target.value })} className="w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-white" />
                                <div className="flex flex-wrap gap-1">
                                    {COMMENT_COLORS.map(color => (
                                        <button key={color} aria-label={`Comment colour ${color}`} aria-pressed={comment.color === color} onClick={() => changeComment({ color })}
                                            className={`h-5 w-5 rounded border ${comment.color === color ? 'border-white' : 'border-gray-700'}`} style={{ background: color }} />
                                    ))}
                                </div>
                            </div>
                        ) : outputNode ? (
                            <NodeInspector key={outputNode.id} node={outputNode} textures={textures} title="Material" wired={outputWired} onChangeNode={changeNode} />
                        ) : null}
                        <p className="text-2xs leading-snug text-gray-600">
                            Right-click the canvas (or press Space) to add a node where the pointer is. Drag from a pin to wire it, or drop a wire on empty space to pick a node for it. Select nothing to set the material itself.
                        </p>
                    </aside>
                </>
            ) : (
                <div className="flex flex-1 items-center justify-center text-xs text-gray-500">Create a material to start.</div>
            )}
        </div>
    );
};
