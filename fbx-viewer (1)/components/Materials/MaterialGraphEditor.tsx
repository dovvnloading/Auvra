import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, MessageSquarePlus, Plus, Trash2 } from 'lucide-react';
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
    materialGraphSettings,
    type MaterialGraph,
    type MaterialGraphNode,
} from '../../runtime/materials/materialGraph';
import { MATERIALS_DOMAIN, materialAssetDocument, materialLibrary, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import { MaterialGraphCanvas } from './MaterialGraphCanvas';
import { MaterialPreview, clearMaterialShaderError, useMaterialShaderError } from './MaterialPreview';
import { ParamField } from './MaterialParamField';
import { GraphHistory, createComment, nodeRect, removeNodes, showsPreview, withComments } from './materialGraphEditing';

/**
 * MATERIAL GRAPH EDITOR (the Materials tab)
 *
 * The project's material assets: each a node graph wired into a Material Output, edited on a canvas
 * (MaterialGraphCanvas.tsx) where every node shows its value, and shown on a lit, shadowed preview
 * as it changes. With nothing selected the inspector shows the material's own settings (blend mode,
 * alpha clip, two-sided, unlit). Models' materials take an asset in the Material Editor (Retexture
 * tab); every material using an asset follows edits to it straight away.
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

/** The graph's identity apart from where its nodes sit, so moving nodes does not redraw previews. */
const shadingSignature = (graph: MaterialGraph): string =>
    JSON.stringify([graph.nodes.map(({ x: _x, y: _y, ...rest }) => rest), graph.links]);

const NodeInspector: React.FC<{
    node: MaterialGraphNode;
    textures: { id: string; name: string }[];
    title?: string;
    onChangeNode: (node: MaterialGraphNode, coalesce?: string) => void;
}> = ({ node, textures, title, onChangeNode }) => {
    const definition = getMaterialNodeDefinition(node.type)!;
    // The Material Output's settings come first, then the values its unwired inputs take.
    const params = node.type === OUTPUT_NODE_TYPE
        ? [...definition.params.filter(param => ['blendMode', 'alphaClip', 'twoSided', 'shading'].includes(param.key)), ...definition.params.filter(param => !['blendMode', 'alphaClip', 'twoSided', 'shading'].includes(param.key))]
        : definition.params;
    const blendMode = node.type === OUTPUT_NODE_TYPE ? materialGraphSettings({ nodes: [node], links: [] }).blendMode : null;
    return (
        <div className="space-y-2 rounded border border-gray-800 bg-gray-900/60 p-2">
            <div className="text-2xs font-bold text-gray-200">{title ?? definition.label}</div>
            <p className="text-2xs leading-snug text-gray-500">{definition.description}</p>
            {params.length === 0 && <p className="text-2xs text-gray-500">No settings.</p>}
            {params.map(param => {
                // The clip only matters to a masked material.
                if (param.key === 'alphaClip' && blendMode !== 'masked') return null;
                return (
                    <ParamField
                        key={param.key}
                        param={param}
                        value={node.params[param.key]}
                        textures={textures}
                        onChange={(value) => onChangeNode({ ...node, params: { ...node.params, [param.key]: value } }, `${node.id}:${param.key}`)}
                    />
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
    const assets = useMaterialAssets();
    const { textures, removeMaterialAsset } = useAssets();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [selection, setSelection] = useState<string[]>([]);
    const [selectedComment, setSelectedComment] = useState<string | null>(null);
    const [previews, setPreviews] = useState(readPreviewsSetting);
    const [error, setError] = useState<string | null>(null);
    const [, setHistoryVersion] = useState(0);
    const shaderError = useMaterialShaderError();
    const asset = assets.find(candidate => candidate.id === selectedId) ?? assets[0] ?? null;
    const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    const histories = useRef(new Map<string, GraphHistory>());
    /** The graph before a drag began, recorded for undo when the drag ends. */
    const dragBase = useRef(new Map<string, MaterialGraph>());

    const history = useCallback((id: string) => {
        let found = histories.current.get(id);
        if (!found) histories.current.set(id, found = new GraphHistory());
        return found;
    }, []);

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
        histories.current.delete(asset.id);
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
    const signature = useMemo(() => (graph ? shadingSignature(graph) : ''), [graph]);
    const shading = useRef<{ signature: string; graph: MaterialGraph | null }>({ signature: '', graph: null });
    if (shading.current.signature !== signature || (graph && !shading.current.graph)) shading.current = { signature, graph };
    const shadingGraph = shading.current.graph;

    const analysis = useMemo(() => {
        if (!shadingGraph) return null;
        const fragment = compileMaterialGraph(shadingGraph);
        const vertex = compileMaterialGraph(shadingGraph, { stage: 'vertex' });
        const vertexUnused = new Set(vertex.unused);
        return {
            key: `${fragment.key}#${vertex.key}`,
            unused: new Set(fragment.unused.filter(id => vertexUnused.has(id))),
            statements: fragment.statements.length + (fragment.connected.has('worldPositionOffset') ? vertex.statements.length : 0),
        };
    }, [shadingGraph]);
    // A change to the shader's shape compiles it afresh: forget the last error.
    useEffect(() => { clearMaterialShaderError(); }, [analysis?.key]);

    const previewIdsKey = shadingGraph && previews ? shadingGraph.nodes.filter(showsPreview).map(node => node.id).join(',') : '';
    const previewNodeIds = useMemo(() => (previewIdsKey ? previewIdsKey.split(',') : []), [previewIdsKey]);

    const nodeIds = new Set(graph?.nodes.map(node => node.id) ?? []);
    const selected = new Set(selection.filter(id => nodeIds.has(id)));
    const comment = graph?.comments?.find(candidate => candidate.id === selectedComment) ?? null;
    const single = selected.size === 1 ? graph!.nodes.find(node => selected.has(node.id)) ?? null : null;
    const outputNode = graph?.nodes.find(node => node.type === OUTPUT_NODE_TYPE) ?? null;
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
                <div className="flex items-center justify-between border-b border-gray-800 px-3 py-2">
                    <span className="text-xs font-bold text-gray-400">Materials</span>
                    <button onClick={create} aria-label="New material" className="flex items-center gap-1 rounded bg-gray-800 px-2 py-1 text-2xs text-gray-200 hover:bg-gray-700"><Plus size={12} /> New</button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                    {assets.length === 0 && <p className="px-1 text-2xs text-gray-500">No materials yet. A material is a node graph; give one to a model's material in the Retexture tab.</p>}
                    {assets.map(candidate => (
                        <button
                            key={candidate.id}
                            onClick={() => { setSelectedId(candidate.id); select([]); }}
                            className={`mb-1 w-full truncate rounded px-2 py-1.5 text-left text-xs ${candidate.id === asset?.id ? 'bg-blue-900/40 text-white' : 'text-gray-300 hover:bg-gray-800'}`}
                        >
                            {candidate.name}
                        </button>
                    ))}
                </div>
            </aside>

            {asset && graph ? (
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
                            <button onClick={remove} aria-label="Delete material" className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-red-400"><Trash2 size={14} /></button>
                        </div>
                        <MaterialPreview assetId={asset.id} graph={shadingGraph ?? graph} previewNodeIds={previewNodeIds} />
                        {shaderError && (
                            <div role="alert" className="rounded border border-red-900 bg-red-950/60 p-2">
                                <div className="mb-1 flex items-center gap-1 text-2xs font-bold text-red-300"><AlertTriangle size={12} /> The shader does not compile</div>
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
                            <NodeInspector key={single.id} node={single} textures={textures} onChangeNode={changeNode} />
                        ) : selected.size > 1 ? (
                            <div className="space-y-2 rounded border border-gray-800 bg-gray-900/60 p-2">
                                <div className="text-2xs font-bold text-gray-200">{selected.size} nodes selected</div>
                                <div className="flex gap-2">
                                    <button onClick={() => { update(removeNodes(graph, selected), true); select([]); }} className="flex items-center gap-1 rounded bg-gray-800 px-2 py-1 text-2xs text-gray-200 hover:bg-red-900"><Trash2 size={12} /> Delete</button>
                                    <button
                                        onClick={() => {
                                            const created = createComment(graph.nodes.filter(node => selected.has(node.id)).map(node => nodeRect(node, previews)), { x: 0, y: 0 });
                                            update(withComments(graph, [...(graph.comments ?? []), created]), true);
                                            select([], created.id);
                                        }}
                                        className="flex items-center gap-1 rounded bg-gray-800 px-2 py-1 text-2xs text-gray-200 hover:bg-gray-700"
                                    >
                                        <MessageSquarePlus size={12} /> Comment
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
                            <NodeInspector key={outputNode.id} node={outputNode} textures={textures} title="Material" onChangeNode={changeNode} />
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
