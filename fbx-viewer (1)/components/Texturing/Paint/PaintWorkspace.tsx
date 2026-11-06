import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BrushIcon, BucketIcon, EraserIcon, EyedropperIcon, FrameIcon, RedoIcon, ScissorsIcon, UndoIcon, WarningIcon } from '../../UI/Icons';
import { useAssets } from '../../../context/AssetContext';
import { useScene } from '../../../context/SceneContext';
import { frontendDiagnostics } from '../../../diagnostics/runtime';
import { materialLibrary } from '../../../runtime/materials/materialLibrary';
import { overrideTextureFlipY } from '../../../utils/materialOverrides';
import { MESH_MAP_LABELS, MESH_MAPS } from '../../../texturing/graph/nodes/io';
import { readStoredGraph } from '../../../texturing/graph/stored';
import { CHANNEL_LABELS, allLayers, readPaintDocument } from '../../../texturing/paint/paintTypes';
import { DEFAULT_BRUSH, type BrushSettings, type StrokeTarget } from '../../../texturing/paint/strokes';
import { listModelParts, type ModelPart } from '../../Tools/Retexture/parts';
import { IconButton, Segmented, Spinner } from '../../UI/kit';
import { Select } from '../../UI/Select';
import { useTextureStore } from '../useTextureStore';
import { BrushPanel } from './BrushPanel';
import { LayerPanel, type LayerSelection } from './LayerPanel';
import { PaintSession, findPaintAsset, paintGraphResolver, type PaintTarget } from './paintSession';
import { PaintViewport, type PaintTool, type ViewMode } from './PaintViewport';
import { SetPanel } from './SetPanel';
import { UvPanel } from './UvPanel';
import { UvSession } from './uvSession';
import { UvView2D } from './UvView2D';

/**
 * THE PAINT TAB
 *
 * Painting a model's surfaces in layers, Painter-style: pick a model and one of its texture sets
 * (the materials sharing pictures), bake its mesh maps, then build it up from paint layers, fill
 * layers, smart materials and smart masks, and put the result on the model. Painting begins from
 * what the surface wears now (its own pictures, or a Retexture result saved on it).
 */

let rememberedModel: string | null = null;

/** What a texture set is known by while it is open: its material names (its pictures change). */
const partKeyOf = (part: ModelPart): string => (part.materialNames.length ? part.materialNames.join('|') : part.rawName || part.id);
let rememberedBrush: BrushSettings = DEFAULT_BRUSH;

export const PaintWorkspace: React.FC = () => {
    const { models, updateModelMaterialOverrides, selectedModelId, saveModelUvLayout } = useScene();
    const { textures } = useAssets();
    const textureStore = useTextureStore();
    const paintable = useMemo(() => models.filter((model) => model.category !== 'Animation'), [models]);
    const [modelId, setModelId] = useState<string | null>(() => rememberedModel ?? selectedModelId ?? null);
    const model = paintable.find((item) => item.id === modelId) ?? paintable[0] ?? null;
    useEffect(() => { rememberedModel = model?.id ?? null; }, [model?.id]);
    const parts = useMemo(() => (model ? listModelParts(model.object) : []), [model]);
    // A set is known by its material names: its pictures (and their ids) change as it is painted,
    // laid out again or put on the model, and the set must stay open through all of that.
    const [partKey, setPartKey] = useState<string | null>(null);
    const part = parts.find((item) => partKeyOf(item) === partKey) ?? null;
    // A model with one texture set opens straight onto it.
    useEffect(() => { setPartKey(parts.length === 1 ? partKeyOf(parts[0]) : null); }, [model?.id]); // eslint-disable-line react-hooks/exhaustive-deps

    const libraryVersion = useSyncExternalStore((listener) => materialLibrary.subscribe(listener), () => materialLibrary.version);
    const graphs = useMemo(() => materialLibrary.list().filter((asset) => asset.textureGraph && !readStoredGraph(asset.textureGraph).library).map((asset) => ({ id: asset.id, name: asset.name })), [libraryVersion]); // eslint-disable-line react-hooks/exhaustive-deps
    const resolve = useMemo(() => paintGraphResolver(), []);

    const [session, setSession] = useState<PaintSession | null>(null);
    const [uv, setUv] = useState<UvSession | null>(null);
    const [reopen, setReopen] = useState(0);
    // A new layout is put on the model once the set reopens on it.
    const putOnAfterOpen = useRef(false);
    // Why the set was opened again after the GPU context came back, shown once it has.
    const restoredNote = useRef<string | null>(null);
    const [opening, setOpening] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const latest = useRef({ models, updateModelMaterialOverrides, textureStore, saveModelUvLayout, model, part, textures });
    latest.current = { models, updateModelMaterialOverrides, textureStore, saveModelUvLayout, model, part, textures };

    // Opened when the model or set picked changes (or is asked to open again), not whenever the model's
    // entry is renewed (its materials changing as the painting is put on it).
    const partFound = Boolean(part);
    useEffect(() => {
        const { model, part } = latest.current;
        if (!model || !part) { setSession(null); setOpening(false); return undefined; }
        let disposed = false;
        let made: PaintSession | null = null;
        let stopRestored: (() => void) | null = null;
        setOpening(true);
        setMessage(null);
        const target: PaintTarget = { modelId: model.id, modelName: model.name, object: model.object, partName: part.name, materials: part.materials, materialNames: part.materialNames.length ? part.materialNames : [part.rawName || part.name] };
        const lookup = materialLibrary.textureLookup(overrideTextureFlipY(model.object));
        PaintSession.open(target, {
            storeTexture: (blob, name, size, folder) => latest.current.textureStore.store(blob, name, size, folder),
            discardTextures: (ids) => latest.current.textureStore.discard(ids),
            texture: (id) => lookup(id, 'map'),
            textureEntry: (id) => {
                const entry = latest.current.textures.find((item) => item.id === id);
                return entry ? { name: entry.name, folder: entry.folder ?? '' } : null;
            },
            setMaterialOverrides: (id, overrides) => latest.current.updateModelMaterialOverrides(id, overrides),
            materialOverrides: (id) => latest.current.models.find((item) => item.id === id)?.materialOverrides,
        }).then((opened) => {
            if (disposed) { opened.dispose(); return; }
            made = opened;
            setSession(opened);
            // The GPU context lost and back: the set opens again from its kept pictures, saying why.
            stopRestored = opened.whenRestored(() => {
                restoredNote.current = opened.status;
                setReopen((value) => value + 1);
            });
            if (restoredNote.current) {
                opened.status = restoredNote.current;
                restoredNote.current = null;
                opened.emit();
            }
            if (putOnAfterOpen.current) {
                putOnAfterOpen.current = false;
                void opened.apply();
            }
            setUv(new UvSession(opened, {
                saveLayout: (id, bytes, meshes) => latest.current.saveModelUvLayout(id, bytes, meshes),
                layoutReference: () => latest.current.models.find((item) => item.id === model.id)?.uvLayout,
            }));
        }, (error: unknown) => {
            frontendDiagnostics.failure('paint_open_failed', error);
            if (!disposed) setMessage(error instanceof Error ? error.message : 'This surface could not be opened for painting.');
        }).finally(() => { if (!disposed) setOpening(false); });
        return () => {
            disposed = true;
            stopRestored?.();
            made?.dispose();
            // Spare pictures kept for reuse are given back to the GPU once the set is closed.
            made?.gpu.trimPool(0);
            setSession(null);
            setUv(null);
        };
    }, [model?.id, model?.object, partKey, partFound, reopen]); // eslint-disable-line react-hooks/exhaustive-deps

    // A picture finishing loading reaches fills that use it.
    useEffect(() => { session?.stack.invalidate(); }, [libraryVersion, session]);

    const sessionVersion = useSyncExternalStore(session?.subscribe ?? (() => () => undefined), session?.getVersion ?? (() => 0));
    void sessionVersion;

    const [tool, setTool] = useState<PaintTool>('paint');
    const [brush, setBrushState] = useState<BrushSettings>(rememberedBrush);
    const setBrush = useCallback((next: BrushSettings) => { rememberedBrush = next; setBrushState(next); }, []);
    const [selection, setSelection] = useState<LayerSelection>({ layerId: null, effectId: null });
    const [panel, setPanel] = useState<'layers' | 'brush' | 'set' | 'uvs'>('layers');
    const [view, setView] = useState<ViewMode | 'uv2d'>('material');
    const [frameSignal, setFrameSignal] = useState(0);

    // Select the top layer when a set opens.
    useEffect(() => {
        if (!session) return;
        const top = session.document.layers[session.document.layers.length - 1];
        setSelection({ layerId: top?.id ?? null, effectId: null });
    }, [session]);

    const document = session?.document ?? null;
    const layer = document ? allLayers(document.layers).find((candidate) => candidate.id === selection.layerId) ?? null : null;
    const effect = layer?.mask?.find((candidate) => candidate.id === selection.effectId) ?? null;
    const target: StrokeTarget | null = useMemo(() => {
        if (!layer || !document) return null;
        if (effect) return effect.kind === 'paint' ? { kind: 'mask', effectId: effect.id } : null;
        if (layer.kind !== 'paint') return null;
        const channels = brush.channels.filter((channel) => layer.channels[channel] && document.channels.includes(channel));
        return channels.length ? { kind: 'layer', layerId: layer.id, channels } : null;
    }, [brush.channels, document, effect, layer]);

    const maskImage = useCallback((tile: number) => (session && layer ? session.stack.cachedMask(layer.id, tile) : null), [layer, session]);

    // UV edits have a history of their own: undo and redo reach it while the 2D UV view or the seam tool is in use.
    const uvVersion = useSyncExternalStore(uv?.subscribe ?? (() => () => undefined), uv?.getVersion ?? (() => 0));
    void uvVersion;
    const history = uv && (view === 'uv2d' || tool === 'seam')
        ? { undo: () => uv.undo(), redo: () => uv.redo(), canUndo: uv.canUndo, canRedo: uv.canRedo, undoLabel: uv.undoLabel, redoLabel: uv.redoLabel }
        : session
            ? { undo: () => session.undo(), redo: () => session.redo(), canUndo: session.canUndo, canRedo: session.canRedo, undoLabel: session.undoLabel, redoLabel: session.redoLabel }
            : null;
    const latestHistory = useRef(history);
    latestHistory.current = history;

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const element = event.target as HTMLElement | null;
            if (element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable)) return;
            if (!session) return;
            const key = event.key.toLowerCase();
            const steps = latestHistory.current;
            if ((event.ctrlKey || event.metaKey) && key === 'z') { event.preventDefault(); if (event.shiftKey) steps?.redo(); else steps?.undo(); return; }
            if ((event.ctrlKey || event.metaKey) && key === 'y') { event.preventDefault(); steps?.redo(); return; }
            if ((event.ctrlKey || event.metaKey) && key === 's') { event.preventDefault(); void session.save(); return; }
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            if (key === 'b') setTool('paint');
            else if (key === 'e') setTool('erase');
            else if (key === 'g') setTool('island');
            else if (key === 'p') setTool('pick');
            else if (key === 's') setTool('seam');
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [session]);

    const viewOptions = useMemo(() => [
        { value: 'material', label: 'Material' },
        ...(document?.channels ?? []).map((channel) => ({ value: channel, label: CHANNEL_LABELS[channel] })),
        { value: 'ambientOcclusion', label: 'Ambient occlusion' },
        ...(document?.bake ? MESH_MAPS.map((name) => ({ value: `mesh:${name}`, label: `Mesh map: ${MESH_MAP_LABELS[name]}` })) : []),
        ...(layer?.mask?.length ? [{ value: 'mask', label: 'Selected layer\'s mask' }] : []),
        { value: 'uvChecker', label: 'UV checker' },
        { value: 'uvStretch', label: 'UV stretch' },
        { value: 'uv2d', label: 'UV layout (2D)' },
    ], [document, layer]);

    return (
        <div className="flex h-full min-h-0 w-full bg-zinc-950 text-white">
            <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-800">
                <div className="space-y-1.5 border-b border-zinc-800 p-2">
                    <div className="text-xs font-semibold text-zinc-300">Model</div>
                    <Select value={model?.id ?? ''} placeholder="No models yet" options={paintable.map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => setModelId(String(value))} className="w-full" />
                </div>
                <div className="px-2 pb-1 pt-2 text-2xs font-semibold text-zinc-400">Texture sets</div>
                <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
                    {!model && <p className="px-1 text-2xs text-zinc-500">Import a model to paint it.</p>}
                    {parts.map((item) => {
                        const painted = model ? findPaintAsset({ modelId: model.id, materialNames: item.materialNames }) : undefined;
                        const doc = painted?.paint ? readPaintDocument(painted.paint) : null;
                        return (
                            <button key={item.id} onClick={() => setPartKey(partKeyOf(item))}
                                className={`mb-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${part && partKeyOf(item) === partKeyOf(part) ? 'bg-sky-900/40 text-white' : 'text-zinc-300 hover:bg-zinc-900'}`}>
                                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                                {doc && <span className="shrink-0 rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">{doc.layers.length} layer{doc.layers.length === 1 ? '' : 's'}</span>}
                            </button>
                        );
                    })}
                </div>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center gap-1 border-b border-zinc-800 px-2 py-1">
                    <IconButton label="Paint" shortcut="B" active={tool === 'paint'} onClick={() => setTool('paint')}><BrushIcon size={14} /></IconButton>
                    <IconButton label="Erase" shortcut="E" active={tool === 'erase'} onClick={() => setTool('erase')}><EraserIcon size={14} /></IconButton>
                    <IconButton label="Fill a UV island" shortcut="G" active={tool === 'island'} onClick={() => setTool('island')}><BucketIcon size={14} /></IconButton>
                    <IconButton label="Pick a colour" shortcut="P" active={tool === 'pick'} onClick={() => setTool('pick')}><EyedropperIcon size={14} /></IconButton>
                    <IconButton label="Mark or clear seams (Shift clears)" shortcut="S" active={tool === 'seam'} onClick={() => setTool('seam')}><ScissorsIcon size={14} /></IconButton>
                    <span className="mx-1 h-4 w-px bg-zinc-800" />
                    <IconButton label={history?.undoLabel ? `Undo ${history.undoLabel.toLowerCase()}` : 'Undo'} shortcut="Ctrl+Z" disabled={!history?.canUndo} onClick={() => history?.undo()}><UndoIcon size={14} /></IconButton>
                    <IconButton label={history?.redoLabel ? `Redo ${history.redoLabel.toLowerCase()}` : 'Redo'} shortcut="Ctrl+Y" disabled={!history?.canRedo} onClick={() => history?.redo()}><RedoIcon size={14} /></IconButton>
                    <IconButton label="Frame the model" shortcut="F" onClick={() => setFrameSignal((value) => value + 1)}><FrameIcon size={14} /></IconButton>
                    <span className="mx-1 h-4 w-px bg-zinc-800" />
                    <span className="text-2xs text-zinc-500">Size</span>
                    <input type="range" min={1} max={400} value={brush.size} onChange={(event) => setBrush({ ...brush, size: Number(event.target.value) })} className="h-1 w-24 accent-sky-500" aria-label="Brush size" />
                    <span className="w-8 text-2xs tabular-nums text-zinc-400">{brush.size}</span>
                    <Segmented value={brush.projection} options={[{ value: 'screen', label: 'Screen' }, { value: 'surface', label: 'Surface' }]} onChange={(projection) => setBrush({ ...brush, projection })} label="Brush projection" />
                    <span className="flex-1" />
                    <span className="text-2xs text-zinc-500">Show</span>
                    <Select value={view} options={viewOptions} onChange={(value) => setView(value as ViewMode)} className="w-48" />
                </div>
                <div className="relative flex min-h-0 flex-1">
                    {session && view === 'uv2d' && uv ? (
                        <UvView2D uv={uv} />
                    ) : session ? (
                        <PaintViewport session={session} tool={tool} brush={brush} target={target} view={view === 'uv2d' ? 'material' : view} maskImage={maskImage}
                            onBrushSize={(size) => setBrush({ ...brush, size })}
                            onPick={(color) => { setBrush({ ...brush, values: { ...brush.values, baseColor: color } }); setTool('paint'); }}
                            onMessage={setMessage} frameSignal={frameSignal} uv={uv} />
                    ) : (
                        <div className="flex flex-1 items-center justify-center text-xs text-zinc-500">
                            {opening ? <span className="flex items-center gap-2"><Spinner /> Laying out the surface…</span> : message ?? (part ? '' : 'Pick a texture set on the left to paint it.')}
                        </div>
                    )}
                    {session && (message || session.status) && (
                        <div className="pointer-events-auto absolute bottom-3 left-1/2 max-w-[70%] -translate-x-1/2 rounded border border-zinc-700 bg-zinc-900/95 px-3 py-1.5 text-2xs text-zinc-200 shadow-lg">
                            {message ?? session.status}
                            <button className="ml-3 text-zinc-500 hover:text-white" onClick={() => { setMessage(null); session.status = null; session.emit(); }}>Close</button>
                        </div>
                    )}
                    {session?.stack.problem && (
                        <div className="pointer-events-none absolute left-3 top-3 flex max-w-[60%] items-start gap-2 rounded border border-amber-800 bg-amber-950/90 px-2 py-1 text-2xs text-amber-200">
                            <WarningIcon size={12} className="mt-px shrink-0" /> {session.stack.problem}
                        </div>
                    )}
                    {session?.busy && !session.progress && (
                        <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-2 rounded bg-zinc-900/90 px-2 py-1 text-2xs text-zinc-300"><Spinner /> {session.busy}</div>
                    )}
                </div>
            </div>

            <aside className="flex w-[320px] shrink-0 flex-col border-l border-zinc-800">
                <div className="border-b border-zinc-800 p-2">
                    <Segmented value={panel} options={[{ value: 'layers', label: 'Layers' }, { value: 'brush', label: 'Brush' }, { value: 'set', label: 'Texture set' }, { value: 'uvs', label: 'UVs' }]} onChange={setPanel} label="Panel" />
                </div>
                {session ? (
                    panel === 'layers' ? <LayerPanel session={session} selection={selection} onSelect={setSelection} resolve={resolve} graphs={graphs} textures={textures} />
                        : panel === 'brush' ? <div className="min-h-0 flex-1 overflow-y-auto"><BrushPanel brush={brush} onChange={setBrush} channels={session.document.channels} paintingMask={target?.kind === 'mask'} textures={textures} onPick={() => setTool('pick')} /></div>
                            : panel === 'uvs' && uv ? <div className="min-h-0 flex-1 overflow-y-auto"><UvPanel uv={uv} onSeamTool={() => setTool('seam')} onApplied={() => { if (!uv.proposal) { putOnAfterOpen.current = uv.putOnWhenOpen; setReopen((value) => value + 1); } }} /></div>
                                : <div className="min-h-0 flex-1 overflow-y-auto"><SetPanel session={session} models={paintable} onReopen={() => setReopen((value) => value + 1)} /></div>
                ) : (
                    <p className="p-3 text-2xs text-zinc-500">Pick a texture set to see its layers.</p>
                )}
            </aside>
        </div>
    );
};
