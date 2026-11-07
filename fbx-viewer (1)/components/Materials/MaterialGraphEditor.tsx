import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BookIcon, ChipIcon, CommentAddIcon, CrossIcon, ExternalLinkIcon, FlowIcon, GraphIcon, ImageIcon, PlusIcon, TrashIcon, WarningIcon } from '../UI/Icons';
import { useAssets } from '../../context/AssetContext';
import { projectService } from '../../utils/projectService';
import { frontendDiagnostics } from '../../diagnostics/runtime';
import {
    MAX_COMMENT_LENGTH,
    OUTPUT_NODE_TYPE,
    compileMaterialGraph,
    createMaterialGraph,
    getMaterialNodeDefinition,
    materialGraphLook,
    materialGraphShape,
    type MaterialGraph,
    type MaterialGraphNode,
} from '../../runtime/materials/materialGraph';
import { MATERIALS_DOMAIN, materialAssetDocument, materialAssetUse, materialLibrary, type MaterialAsset } from '../../runtime/materials/materialLibrary';
import { LIBRARY_DRAG_TYPE, MyLibraryPanel, useAddToLibrary, useBringIn, useUserLibrary } from './MyLibrary';
import { MaterialXExportButton, MaterialXImport, type MaterialXImportHandle } from './MaterialXFiles';
import { ProjectBall } from './ProjectBalls';
import { CompressionBadge } from './CompressionBadge';
import { MaterialFromDescription } from './MaterialFromDescription';
import { STARTER_MATERIALS } from '../../runtime/materials/starterMaterials';
import { MaterialGraphCanvas } from './MaterialGraphCanvas';
import { MaterialPreview, clearMaterialShaderError, useMaterialNodeErrors, useMaterialShaderError } from './MaterialPreview';
import { NodeInspector } from './MaterialNodeInspector';
import { TextureMemoryDialog } from './TextureMemoryDialog';
import { deleteMaterialQuestion, materialUses, type MaterialUses } from './materialDeletion';
import { appConfirm } from '../../utils/appDialogs';
import { useScene } from '../../context/SceneContext';
import { GraphHistory, createComment, nodeRect, removeNodes, showsPreview, withComments } from './materialGraphEditing';
import { IconButton, Popover } from '../UI/kit';
import { FRAME_COLOURS, FRAME_COLOUR_NAMES } from '../NodeGraph/frames';
import { OPEN_MATERIAL_EVENT, takeOpenMaterialRequest } from '../Texturing/Paint/openMaterial';
import { isSmartMaterialAsset } from '../../texturing/paint/smartMaterials';
import { isExportTemplatesAsset } from '../../texturing/paint/exportTemplates';
import { createFunctionGraph, createTextureGraph } from '../../texturing/graph/document';
import { TextureGraphWorkspace, newTextureGraphStored } from '../Texturing/TextureGraphWorkspace';
import { PhotoMaterialPicker, type PhotoMaterialPickerHandle } from '../Texturing/Paint/PhotoMaterialPicker';

/**
 * MATERIAL GRAPH EDITOR (the Materials tab)
 *
 * The project's material assets: each a node graph wired into a Material Output, edited on a canvas
 * (MaterialGraphCanvas.tsx) where every node shows its value, and shown on a lit, shadowed preview
 * as it changes. With nothing selected the inspector shows the material's own settings (alpha mode,
 * alpha clip, two-sided, shading) and its values by group (MaterialNodeInspector.tsx). Models'
 * materials take an asset in Properties › Material Overrides; every material using an asset follows
 * edits to it straight away. Undo is kept for each material for the session, so it survives switching
 * tabs and switching material.
 *
 * A material can instead be made by a texture graph (components/Texturing): images drawn node by
 * node into the pictures the material draws with.
 */

// Edits made in quick succession (dragging a slider) are saved together.
const SAVE_DELAY_MS = 400;
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

export const MaterialGraphEditor: React.FC = () => {
    const allAssets = useMaterialAssets();
    // Saved smart materials are painting presets, not materials to edit or give to models.
    // Painted copies belong to their models (Material Overrides), not to the material list.
    const assets = useMemo(() => allAssets.filter((candidate) => !isSmartMaterialAsset(candidate) && !isExportTemplatesAsset(candidate) && !candidate.owner), [allAssets]);
    const { textures, removeMaterialAsset, updateModelMaterialOverrides } = useAssets();
    const { models, levelObjects, projectStatus } = useScene();
    // The last material deleted, and what used it, until it is undone or another goes.
    const [deleted, setDeleted] = useState<{ asset: MaterialAsset; uses: MaterialUses } | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [selection, setSelection] = useState<string[]>([]);
    const [selectedComment, setSelectedComment] = useState<string | null>(null);
    const [previews, setPreviews] = useState(readPreviewsSetting);
    const [error, setError] = useState<string | null>(null);
    const [, setHistoryVersion] = useState(0);
    const shaderError = useMaterialShaderError();
    // The nodes a failed compile was traced back to, marked on the canvas with what is wrong.
    const nodeErrors = useMaterialNodeErrors();
    // The canvas takes node errors as a plain record (node id -> message).
    const canvasMarks = useMemo(() => ({ nodeErrors: Object.fromEntries(nodeErrors) as Record<string, string> }), [nodeErrors]);
    const asset = assets.find(candidate => candidate.id === selectedId) ?? assets[0] ?? null;
    // My library: open in place of the editor, beside the project's list, which takes balls dropped on it.
    const [libraryOpen, setLibraryOpen] = useState(false);
    const [dropping, setDropping] = useState(false);
    // Followed so the button below says whether this material is in the library already.
    const { library: myLibrary } = useUserLibrary();
    const bringIn = useBringIn();
    const addToMyLibrary = useAddToLibrary();
    const [adding, setAdding] = useState(false);
    const inMyLibrary = asset && projectStatus.projectId ? myLibrary.addedFrom(projectStatus.projectId, asset.id) : undefined;
    const bringInAndSelect = useCallback(async (entryId: string) => {
        const brought = await bringIn(entryId);
        if (brought) setSelectedId(brought.id);
        return brought;
    }, [bringIn]);
    const addAsset = async () => {
        if (!asset) return;
        setAdding(true);
        await addToMyLibrary(materialLibrary.get(asset.id) ?? asset);
        setAdding(false);
    };
    const materialXImport = useRef<MaterialXImportHandle>(null);
    const libraryButton = asset && materialAssetUse(asset) !== 'forOtherGraphs' ? (<>
        <MaterialXExportButton asset={asset} />
        <IconButton label={adding ? 'Adding it to your library…' : inMyLibrary ? 'Update in my library: the copy kept for every project' : 'Add to my library: keep a copy for every project'} disabled={adding} onClick={() => void addAsset()}>
            <BookIcon size={14} />
        </IconButton>
    </>) : null;
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

    /** Saves the material, at once or shortly; saved at once, it settles when the project has it (true) or refused it (false). */
    const save = useCallback((next: MaterialAsset, immediately = false): Promise<boolean> => {
        const timers = pending.current;
        clearTimeout(timers.get(next.id));
        const write = () => {
            timers.delete(next.id);
            return projectService.applyChanges([{ domain: MATERIALS_DOMAIN, operation: 'upsert', id: next.id, value: materialAssetDocument(next) }])
                .then(() => { setError(null); return true; }, (failure: unknown) => {
                    frontendDiagnostics.failure('material_save_failed', failure);
                    setError('The material could not be saved: is a project open?');
                    return false;
                });
        };
        if (immediately) return write();
        timers.set(next.id, setTimeout(() => { void write(); }, SAVE_DELAY_MS));
        return Promise.resolve(true);
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
    const photoPicker = useRef<PhotoMaterialPickerHandle>(null);
    const [newMenu, setNewMenu] = useState(false);
    const [memoryOpen, setMemoryOpen] = useState(false);

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

    const remove = async () => {
        if (!asset) return;
        // Asked first, naming what uses it: those go back to their own materials.
        const uses = materialUses(asset.id, models, levelObjects);
        const question = deleteMaterialQuestion(asset.name, uses);
        if (!await appConfirm(question.title, { message: question.message, acceptLabel: 'Delete', danger: true })) return;
        const kept = materialLibrary.get(asset.id) ?? asset;
        // A save still waiting would bring it back.
        clearTimeout(pending.current.get(asset.id));
        pending.current.delete(asset.id);
        sessionHistories.delete(asset.id);
        removeMaterialAsset(asset.id).then(() => {
            setError(null);
            setSelectedId(null);
            select([]);
            setDeleted({ asset: kept, uses });
        }, (failure: unknown) => {
            frontendDiagnostics.failure('material_remove_failed', failure);
            setError('The material could not be deleted.');
        });
    };

    /** Puts the last deleted material back, with the models' overrides that named it. */
    const undoDelete = async () => {
        if (!deleted) return;
        const { asset: restored, uses } = deleted;
        setDeleted(null);
        materialLibrary.upsert(restored);
        save(restored, true);
        try {
            for (const model of uses.models) await updateModelMaterialOverrides(model.id, model.overrides);
            setSelectedId(restored.id);
        } catch (failure) {
            frontendDiagnostics.failure('material_undo_delete_failed', failure);
            setError('The material is back, but some models could not take it again.');
        }
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
                {/* Icons with tooltips, so the row fits the sidebar however narrow the window. */}
                <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-gray-800 pl-3 pr-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-bold text-gray-400">Materials</span>
                    <IconButton label="My library: your materials for every project" active={libraryOpen} onClick={() => setLibraryOpen(open => !open)}><BookIcon size={14} /></IconButton>
                    <MaterialFromDescription onCreated={createFromDescription} />
                    <IconButton label="Texture memory: what textures take on the graphics card, per level and per material" onClick={() => setMemoryOpen(true)}><ChipIcon size={14} /></IconButton>
                    {memoryOpen && <TextureMemoryDialog onClose={() => setMemoryOpen(false)} />}
                    <MaterialXImport ref={materialXImport} onImported={(imported) => { setSelectedId(imported.id); select([]); setLibraryOpen(false); }} />
                    <IconButton ref={newButton} label="New material" active={newMenu} onClick={() => setNewMenu(true)}><PlusIcon size={14} /></IconButton>
                    <Popover anchor={newButton} open={newMenu} onClose={() => setNewMenu(false)} width={280} label="New material">
                        <div className="p-1">
                            {[
                                { key: 'texture', icon: <GraphIcon size={14} />, title: 'Texture graph', text: 'Noises, patterns, blurs and filters drawn into the material\'s pictures: base colour, normal, roughness and the rest.', run: () => createTextureGraph_(false) },
                                { key: 'shader', icon: <FlowIcon size={14} />, title: 'Shader graph', text: 'Maths worked out for every pixel as the model draws: moving, glowing and view-dependent looks.', run: create },
                                { key: 'function', icon: <GraphIcon size={14} />, title: 'Graph for other graphs', text: 'A texture graph with an input, made to be used as one node inside others (a smart mask, a filter).', run: () => createTextureGraph_(true) },
                                { key: 'photo', icon: <ImageIcon size={14} />, title: 'From a photo', text: 'A photo of a surface made into a texture graph: tiled, lighting taken out, with height, normal and roughness worked out. Or drop a photo on the list.', run: () => photoPicker.current?.pick() },
                                { key: 'materialx', icon: <ExternalLinkIcon size={14} />, title: 'From a MaterialX file', text: 'Pick a .mtlx file together with its pictures: its surface becomes a shader graph.', run: () => materialXImport.current?.pick() },
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
                {deleted && (
                    <div className="flex items-center gap-2 border-b border-gray-800 px-3 py-1.5 text-2xs text-gray-300" role="status">
                        <span className="min-w-0 flex-1 truncate">Deleted "{deleted.asset.name}"</span>
                        <button onClick={() => void undoDelete()} className="rounded bg-gray-800 px-2 py-0.5 text-gray-100 hover:bg-gray-700">Undo</button>
                        <button onClick={() => setDeleted(null)} aria-label="Dismiss" className="text-gray-500 hover:text-gray-300"><CrossIcon size={11} /></button>
                    </div>
                )}
                <div
                    className={`flex-1 overflow-y-auto p-2 ${dropping ? 'bg-accent/10 ring-1 ring-inset ring-accent/60' : ''}`}
                    onDragOver={(event) => { if (!event.dataTransfer.types.includes(LIBRARY_DRAG_TYPE) && !event.dataTransfer.types.includes('Files')) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropping(true); }}
                    onDragLeave={() => setDropping(false)}
                    onDrop={(event) => {
                        setDropping(false);
                        // A photo dropped on the list becomes a material.
                        if (event.dataTransfer.files.length && photoPicker.current?.take(event.dataTransfer.files)) { event.preventDefault(); return; }
                        const entryId = event.dataTransfer.getData(LIBRARY_DRAG_TYPE);
                        if (!entryId) return;
                        event.preventDefault();
                        void bringInAndSelect(entryId);
                    }}
                >
                    <PhotoMaterialPicker ref={photoPicker} className="mb-1 px-1" onMade={(made) => { setSelectedId(made.id); select([]); }} />
                    {dropping && <p className="mb-1 px-1 text-2xs text-accent">Drop to bring it into this project</p>}
                    {assets.length === 0 && <p className="px-1 text-2xs text-gray-500">No materials yet. A material is a node graph; give one to a model's material in Properties › Material Overrides.</p>}
                    {assets.map(candidate => (
                        <button
                            key={candidate.id}
                            onClick={() => { setSelectedId(candidate.id); select([]); setLibraryOpen(false); }}
                            title={candidate.textureGraph ? 'Texture graph' : 'Shader graph'}
                            className={`mb-0.5 w-full rounded px-1.5 py-1 text-left text-xs ${candidate.id === asset?.id ? 'bg-blue-900/40 text-white' : 'text-gray-300 hover:bg-gray-800'}`}
                        >
                            {/* Its ball, drawn as My library's are, then its name and what kind of graph it is. */}
                            <span className="flex items-center gap-2">
                                <ProjectBall asset={candidate} />
                                <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
                                {candidate.textureGraph ? <GraphIcon size={11} className="shrink-0 text-amber-400/60" /> : <FlowIcon size={11} className="shrink-0 text-sky-400/60" />}
                            </span>
                        </button>
                    ))}
                </div>
            </aside>

            {libraryOpen ? (
                <MyLibraryPanel onBringIn={bringInAndSelect} />
            ) : asset && asset.textureGraph ? (
                <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex items-center gap-2 border-b border-gray-800 px-3 py-1.5">
                        <GraphIcon size={13} className="text-amber-400/80" />
                        <input aria-label="Material name" value={asset.name} onChange={(event) => rename(event.target.value)} className="w-64 rounded border border-gray-700 bg-gray-950 px-2 py-0.5 text-xs text-white" />
                        <span className="text-2xs text-gray-500">Texture graph</span>
                        <span className="flex-1" />
                        {error && <span className="text-2xs text-amber-400">{error}</span>}
                        {libraryButton}
                        <button onClick={() => void remove()} aria-label="Delete material" className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-red-400"><TrashIcon size={14} /></button>
                    </div>
                    <TextureGraphWorkspace key={asset.id} asset={asset} assets={assets} onSave={save} onOpenAsset={(id) => { setSelectedId(id); select([]); }} />
                </div>
            ) : asset && graph ? (
                <>
                    <MaterialGraphCanvas
                        {...canvasMarks}
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
                            {libraryButton}
                            <button onClick={() => void remove()} aria-label="Delete material" className="rounded p-1 text-gray-500 hover:bg-gray-800 hover:text-red-400"><TrashIcon size={14} /></button>
                        </div>
                        <MaterialPreview assetId={asset.id} graph={shadingGraph ?? graph} previewNodeIds={previewNodeIds} />
                        <CompressionBadge asset={asset} />
                        {shaderError && (
                            <div role="alert" className="space-y-1 rounded border border-red-900 bg-red-950/60 p-2">
                                <div className="flex items-center gap-1 text-2xs font-bold text-red-300"><WarningIcon size={12} /> The shader does not compile</div>
                                {/* What is wrong in plain words, on the nodes it was traced to; the compiler's own lines behind Details. */}
                                {[...nodeErrors].map(([id, message]) => {
                                    const failing = graph.nodes.find(candidate => candidate.id === id);
                                    const label = failing ? failing.name ?? getMaterialNodeDefinition(failing.type)?.label ?? failing.type : 'A node';
                                    return <p key={id} className="text-2xs leading-snug text-red-100"><span className="font-semibold">{label}:</span> {message}</p>;
                                })}
                                {nodeErrors.size === 0 && <p className="text-2xs leading-snug text-red-100">Something in the graph made code the graphics card cannot build.</p>}
                                <details className="text-2xs text-red-300/80">
                                    <summary className="cursor-pointer select-none">Details</summary>
                                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono leading-4 text-red-200">{shaderError}</pre>
                                </details>
                            </div>
                        )}
                        {error && <p className="text-2xs text-amber-400">{error}</p>}
                        {analysis && (
                            <p className="text-2xs text-gray-500">
                                {graph.nodes.length === 1 ? '1 node' : `${graph.nodes.length} nodes`}
                                {analysis.unused.size > 0 && (
                                    <span title="Nodes that feed nothing the material reads: dimmed on the canvas">
                                        {' · '}{analysis.unused.size} not used
                                    </span>
                                )}
                            </p>
                        )}

                        {single ? (
                            <NodeInspector key={single.id} node={single} textures={textures} wired={single.id === outputNode?.id ? outputWired : undefined} error={nodeErrors.get(single.id)} onChangeNode={changeNode} />
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
                                        title="Put a frame round the selected nodes"
                                        className="flex items-center gap-1 rounded bg-gray-800 px-2 py-1 text-2xs text-gray-200 hover:bg-gray-700"
                                    >
                                        <CommentAddIcon size={12} /> Frame
                                    </button>
                                </div>
                            </div>
                        ) : comment ? (
                            <div className="space-y-2 rounded border border-gray-800 bg-gray-900/60 p-2">
                                <div className="text-2xs font-bold text-gray-200">Frame</div>
                                <label className="block space-y-1">
                                    <span className="text-2xs text-gray-500">Title</span>
                                    <input aria-label="Frame title" value={comment.text} maxLength={MAX_COMMENT_LENGTH} onChange={(event) => changeComment({ text: event.target.value })} className="w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-white" />
                                </label>
                                <div className="flex flex-wrap gap-1">
                                    {FRAME_COLOURS.map(color => (
                                        <button key={color} aria-label={`Frame colour: ${FRAME_COLOUR_NAMES[color] ?? 'Other'}`} title={FRAME_COLOUR_NAMES[color]} aria-pressed={comment.color === color} onClick={() => changeComment({ color })}
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
