import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BrushIcon, BucketIcon, CompareIcon, EraserIcon, EyedropperIcon, FrameIcon, RedoIcon, ScissorsIcon, SelectBoxIcon, SplineIcon, UndoIcon, WarningIcon } from '../../UI/Icons';
import { PaintView2D } from './PaintView2D';
import { useAssets } from '../../../context/AssetContext';
import { useScene } from '../../../context/SceneContext';
import { frontendDiagnostics } from '../../../diagnostics/runtime';
import { materialLibrary } from '../../../runtime/materials/materialLibrary';
import { overrideTextureFlipY } from '../../../utils/materialOverrides';
import { MESH_MAP_LABELS, MESH_MAPS } from '../../../texturing/graph/nodes/io';
import { EXTRA_MAPS, EXTRA_MAP_LABELS, type BakeSettings } from '../../../texturing/bake/meshBaker';
import { readStoredGraph } from '../../../texturing/graph/stored';
import { CHANNEL_LABELS, allLayers, mapLayer, paintId, readPaintDocument, type MaskEffect, type PaintChannel } from '../../../texturing/paint/paintTypes';
import type { SurfacePath } from '../../../texturing/paint/paths';
import { PathPanel } from './PathPanel';
import { MAX_ID_COLOURS } from '../../../texturing/paint/paintStack';
import { PICK_LABELS, PICK_MODES, changeTriangles, matchesId, type PickMode } from '../../../texturing/paint/selection';
import { DEFAULT_BRUSH, MAX_BRUSH_SIZE, type BrushSettings, type StrokeTarget } from '../../../texturing/paint/strokes';
import { paintWithMaterial } from '../../../texturing/paint/materialPresets';
import type { PreviewHost } from '../../../texturing/paint/previews';
import { listModelParts, type ModelPart } from '../../Tools/Retexture/parts';
import { buildPartMesh } from '../../../texturing/mesh/partMesh';
import { meshTexelDensity } from '../../../texturing/uv/relax';
import { IconButton, PanelEdge, Segmented, Spinner, usePanelWidth } from '../../UI/kit';
import { Select } from '../../UI/Select';
import { useTextureStore } from '../useTextureStore';
import { BrushPanel } from './BrushPanel';
import { LayerPanel, type LayerSelection } from './LayerPanel';
import { useMaterialSections, type MaterialChoice } from './MaterialPicker';
import { SliderRow } from './PaintFields';
import { PaintSession, findPaintAsset, paintGraphResolver, type PaintTarget } from './paintSession';
import { PaintViewport, type PaintTool, type PathEdit, type SurfaceHit, type ViewMode, type ViewportCommands } from './PaintViewport';
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
        let madeUv: UvSession | null = null;
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
            madeUv = new UvSession(opened, {
                saveLayout: (id, bytes, meshes) => latest.current.saveModelUvLayout(id, bytes, meshes),
                layoutReference: () => latest.current.models.find((item) => item.id === model.id)?.uvLayout,
            });
            setUv(madeUv);
        }, (error: unknown) => {
            frontendDiagnostics.failure('paint_open_failed', error);
            if (!disposed) setMessage(error instanceof Error ? error.message : 'This surface could not be opened for painting.');
        }).finally(() => { if (!disposed) setOpening(false); });
        return () => {
            disposed = true;
            stopRestored?.();
            madeUv?.dispose();
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
    const [pickMode, setPickMode] = useState<PickMode>('quad');
    const [raySettings, setRaySettings] = useState<BakeSettings | null>(null);
    // The model's other texture sets, and how dense each one's texels are on its own pictures, for matching.
    const otherSets = useMemo(() => parts.filter((item) => !part || partKeyOf(item) !== partKeyOf(part)).map((item) => ({ key: partKeyOf(item), name: item.name })), [parts, part]);
    const densityOf = useCallback((key: string): number => {
        const other = parts.find((item) => partKeyOf(item) === key);
        if (!model || !other) return 0;
        const mesh = buildPartMesh(model.object, new Set(other.materials), { udim: 'auto' });
        const painted = findPaintAsset({ modelId: model.id, materialNames: other.materialNames });
        const kept = painted?.paint ? readPaintDocument(painted.paint) : null;
        return meshTexelDensity(mesh.positions, mesh.uvs, mesh.indices, 2 ** (kept?.size ?? session?.document.size ?? 11));
    }, [model, parts, session]);
    const [brush, setBrushState] = useState<BrushSettings>(rememberedBrush);
    const setBrush = useCallback((next: BrushSettings) => { rememberedBrush = next; setBrushState(next); }, []);
    const [selection, setSelection] = useState<LayerSelection>({ layerId: null, effectId: null });
    const [panel, setPanel] = useState<'layers' | 'brush' | 'set' | 'uvs'>('layers');
    const [view, setView] = useState<ViewMode | 'uv2d' | 'paint2d'>('material');
    // Painting on the UV layout beside the 3D view.
    const [beside, setBeside] = useState(false);
    const [frameSignal, setFrameSignal] = useState(0);
    const sets = usePanelWidth('paint.sets', 224, 180, 360);
    const side = usePanelWidth('paint.panel', 320, 280, 560);

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

    // Painting with a whole material: a fill layer of it under a black painted mask, which strokes paint white.
    const brushSections = useMaterialSections({ resolve, graphs, textures, brush });
    const previewHost: PreviewHost | null = useMemo(() => (session ? { resolveGraph: resolve, texture: (id: string) => session.stack.host.texture(id) } : null), [resolve, session]);
    const paintWith = useCallback((choice: MaterialChoice) => {
        if (!session) return;
        if (session.locked) { setMessage(session.locked); return; }
        const made = paintWithMaterial(session.document, choice.make(session.document), selection.layerId);
        session.stack.startMaskPicture(made.effectId, false);
        session.change(made.document, `Paint with ${choice.name}`);
        setSelection({ layerId: made.layerId, effectId: made.effectId });
        setTool('paint');
        setBrush({ ...brush, maskValue: 1 });
        setMessage(`Painting with ${choice.name}: strokes lay it on in every channel it has. Erase (E) takes it off again.`);
    }, [brush, selection.layerId, session, setBrush]);

    // Clicks on the model while a part or ID colour mask is selected pick for it (Shift takes away), with its own mode.
    const pickingParts = effect?.kind === 'polygon' || effect?.kind === 'id';
    const onSurfacePick = useCallback((hit: SurfaceHit, remove: boolean): boolean => {
        if (!session || !layer || !effect || (effect.kind !== 'polygon' && effect.kind !== 'id')) return false;
        if (session.locked) { setMessage(session.locked); return true; }
        const update = (patch: Partial<MaskEffect>, label: string) => session.change({
            ...session.document,
            layers: mapLayer(session.document.layers, layer.id, (current) => ({ ...current, mask: (current.mask ?? []).map((candidate) => (candidate.id === effect.id ? { ...candidate, ...patch } : candidate)) })),
        }, label);
        if (effect.kind === 'polygon') {
            const mode = effect.pick ?? 'mesh';
            const triangles = session.selector.pick(mode, hit.triangle, [hit.point.x, hit.point.y, hit.point.z]);
            update({ triangles: changeTriangles(effect.triangles, triangles, remove) }, `${remove ? 'Take away' : 'Pick'} ${PICK_LABELS[mode].toLowerCase()}`);
            return true;
        }
        const colour = session.idColourAt(hit.triangle, hit.uv);
        if (!colour) { setMessage('There is no baked ID map to pick from: bake the mesh maps in the Texture set panel first.'); return true; }
        const colours = effect.colors ?? [];
        const near = colours.findIndex((each) => matchesId(colour, [each], Math.max(effect.tolerance ?? 0.02, 1 / 255)));
        if (remove) {
            if (near >= 0) update({ colors: colours.filter((_, i) => i !== near) }, 'Take away an ID colour');
        } else if (near < 0) {
            if (colours.length >= MAX_ID_COLOURS) setMessage(`An ID colour mask takes up to ${MAX_ID_COLOURS} colours.`);
            else update({ colors: [...colours, colour.map((value) => Math.round(value * 255) / 255) as [number, number, number]] }, 'Pick an ID colour');
        }
        return true;
    }, [effect, layer, session]);

    // Paths: kept in the set's document; the path tool adds, picks and drags their points.
    const viewportCommands = useRef<ViewportCommands | null>(null);
    const [pathId, setPathId] = useState<string | null>(null);
    const [pathPoint, setPathPoint] = useState<number | null>(null);
    const paths = useMemo(() => document?.paths ?? [], [document]);
    const activePath = paths.find((each) => each.id === pathId) ?? null;
    const extent = useMemo(() => { const box = session?.part.bounds; return box ? Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z, 1e-6) : 1; }, [session]);
    const changePaths = useCallback((next: SurfacePath[], label: string, coalesce?: string) => {
        if (session) session.change({ ...session.document, paths: next }, label, coalesce);
    }, [session]);
    const pathEdit: PathEdit = useMemo(() => ({
        path: activePath,
        point: pathPoint,
        onAdd: (position, normal, size) => {
            if (!session) return;
            const point = { position, normal, size, opacity: 1 };
            if (!activePath) {
                const created: SurfacePath = { id: paintId('p'), name: `Path ${paths.length + 1}`, points: [point], closed: false, style: 'brush', gap: 0.2, font: 'sans-serif' };
                changePaths([...paths, created], 'Start a path');
                setPathId(created.id);
                setPathPoint(0);
                return;
            }
            const at = pathPoint === null ? activePath.points.length : pathPoint + 1;
            changePaths(paths.map((each) => (each.id === activePath.id ? { ...each, points: [...each.points.slice(0, at), point, ...each.points.slice(at)] } : each)), 'Add a path point');
            setPathPoint(at);
        },
        onSelect: setPathPoint,
        onMove: (index, position, normal) => {
            if (!activePath) return;
            changePaths(paths.map((each) => (each.id === activePath.id ? { ...each, points: each.points.map((point, i) => (i === index ? { ...point, position, normal } : point)) } : each)), 'Move a path point', `${activePath.id}:move:${index}`);
        },
    }), [activePath, changePaths, pathPoint, paths, session]);

    const maskImage = useCallback((tile: number) => (session && layer ? session.stack.cachedMask(layer.id, tile) : null), [layer, session]);
    // The mask view's layer has its mask kept whole while it is shown.
    const layerId = layer?.id ?? null;
    useEffect(() => { session?.stack.watchMask(view === 'mask' ? layerId : null); }, [session, view, layerId]);

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
            else if (key === 'q') setTool('polygon');
            else if (key === 'l') setTool('path');
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
        ...EXTRA_MAPS.filter((name) => document?.bake?.extras?.[name]).map((name) => ({ value: `extra:${name}`, label: `Baked: ${EXTRA_MAP_LABELS[name]}` })),
        ...(layer?.mask?.length ? [{ value: 'mask', label: 'Selected layer\'s mask' }] : []),
        { value: 'uvChecker', label: 'UV checker' },
        { value: 'uvStretch', label: 'UV stretch' },
        { value: 'uv2d', label: 'UV layout (2D)' },
        { value: 'paint2d', label: 'Paint in 2D (UV layout)' },
    ], [document, layer]);

    return (
        <div className="flex h-full min-h-0 w-full bg-zinc-950 text-white">
            <aside className="flex shrink-0 flex-col border-r border-zinc-800" style={{ width: sets.width }}>
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
            <PanelEdge side="left" width={sets.width} onResize={sets.setWidth} onDone={sets.save} label="Resize the texture sets panel" />

            <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center gap-1 border-b border-zinc-800 px-2 py-1">
                    <IconButton label="Paint" shortcut="B" active={tool === 'paint'} onClick={() => setTool('paint')}><BrushIcon size={14} /></IconButton>
                    <IconButton label="Erase" shortcut="E" active={tool === 'erase'} onClick={() => setTool('erase')}><EraserIcon size={14} /></IconButton>
                    <IconButton label="Fill a UV island" shortcut="G" active={tool === 'island'} onClick={() => setTool('island')}><BucketIcon size={14} /></IconButton>
                    <IconButton label="Fill polygons: a triangle, a quad, a mesh part, a UV piece or an edge loop" shortcut="Q" active={tool === 'polygon'} onClick={() => setTool('polygon')}><SelectBoxIcon size={14} /></IconButton>
                    {tool === 'polygon' && !pickingParts && <Select value={pickMode} options={PICK_MODES.map((mode) => ({ value: mode, label: PICK_LABELS[mode] }))} onChange={(mode) => setPickMode(mode as PickMode)} className="w-28" />}
                    <IconButton label="Draw a path on the surface: paint along it, fill it, ribbons, stitches and text" shortcut="L" active={tool === 'path'} onClick={() => { setTool('path'); setPanel('brush'); }}><SplineIcon size={14} /></IconButton>
                    <IconButton label="Pick a colour" shortcut="P" active={tool === 'pick'} onClick={() => setTool('pick')}><EyedropperIcon size={14} /></IconButton>
                    <IconButton label="Mark or clear seams (Shift clears)" shortcut="S" active={tool === 'seam'} onClick={() => setTool('seam')}><ScissorsIcon size={14} /></IconButton>
                    <span className="mx-1 h-4 w-px bg-zinc-800" />
                    <IconButton label={history?.undoLabel ? `Undo ${history.undoLabel.toLowerCase()}` : 'Undo'} shortcut="Ctrl+Z" disabled={!history?.canUndo} onClick={() => history?.undo()}><UndoIcon size={14} /></IconButton>
                    <IconButton label={history?.redoLabel ? `Redo ${history.redoLabel.toLowerCase()}` : 'Redo'} shortcut="Ctrl+Y" disabled={!history?.canRedo} onClick={() => history?.redo()}><RedoIcon size={14} /></IconButton>
                    <IconButton label="Frame the model" shortcut="F" onClick={() => setFrameSignal((value) => value + 1)}><FrameIcon size={14} /></IconButton>
                    <span className="mx-1 h-4 w-px bg-zinc-800" />
                    <span className="text-2xs text-zinc-500">Size</span>
                    <div className="flex w-40"><SliderRow label="Brush size" hideLabel value={brush.size} min={1} max={MAX_BRUSH_SIZE} step={1} onChange={(size) => setBrush({ ...brush, size })} /></div>
                    <Segmented value={brush.projection} options={[{ value: 'screen', label: 'Screen' }, { value: 'surface', label: 'Surface' }]} onChange={(projection) => setBrush({ ...brush, projection })} label="Brush projection" />
                    <span className="flex-1" />
                    <span className="text-2xs text-zinc-500">Show</span>
                    <Select value={view} options={viewOptions} onChange={(value) => setView(value as ViewMode)} className="w-48" />
                    <IconButton label="Paint on the UV layout beside the 3D view" active={beside} onClick={() => setBeside((value) => !value)}><CompareIcon size={14} /></IconButton>
                </div>
                <div className="relative flex min-h-0 flex-1">
                    {session && view === 'uv2d' && uv ? (
                        <UvView2D uv={uv} />
                    ) : session ? (
                        <>
                        {view !== 'paint2d' && <PaintViewport session={session} tool={tool} brush={brush} target={target} view={view === 'uv2d' ? 'material' : view} maskImage={maskImage}
                            onBrushSize={(size) => setBrush({ ...brush, size })}
                            onPick={(color) => { setBrush({ ...brush, values: { ...brush.values, baseColor: color } }); setTool('paint'); }}
                            onMessage={setMessage} frameSignal={frameSignal} uv={uv} pickMode={pickMode} onSurfacePick={onSurfacePick} picking={pickingParts} bakeRays={raySettings}
                            pathEdit={tool === 'path' ? pathEdit : null} commands={viewportCommands} />}
                        {(view === 'paint2d' || beside) && (
                            <div className={`flex min-h-0 min-w-0 flex-1 ${view !== 'paint2d' ? 'border-l border-zinc-800' : ''}`}>
                                <PaintView2D session={session} tool={tool} brush={brush} target={target} maskImage={maskImage} onMessage={setMessage}
                                    show={view === 'mask' ? 'mask' : (session.document.channels as readonly string[]).includes(view) ? view as PaintChannel : 'baseColor'} />
                            </div>
                        )}
                        </>
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

            <PanelEdge side="right" width={side.width} onResize={side.setWidth} onDone={side.save} label="Resize the layers panel" />
            <aside className="flex shrink-0 flex-col border-l border-zinc-800" style={{ width: side.width }}>
                <div className="border-b border-zinc-800 p-2">
                    <Segmented value={panel} options={[{ value: 'layers', label: 'Layers' }, { value: 'brush', label: 'Brush' }, { value: 'set', label: 'Texture set' }, { value: 'uvs', label: 'UVs' }]} onChange={setPanel} label="Panel" />
                </div>
                {session ? (
                    panel === 'layers' ? <LayerPanel session={session} selection={selection} onSelect={setSelection} resolve={resolve} graphs={graphs} textures={textures} onPaintWith={paintWith} onMessage={setMessage} />
                        : panel === 'brush' ? <div className="min-h-0 flex-1 overflow-y-auto">{tool === 'path' && (
                            <PathPanel paths={paths} path={activePath} point={pathPoint} extent={extent} graphs={graphs} onPick={(id) => { setPathId(id); setPathPoint(null); }}
                                onNew={() => { setPathId(null); setPathPoint(null); setMessage('Click the model to start the new path.'); }}
                                onChange={(next, label, coalesce) => changePaths(paths.map((each) => (each.id === next.id ? next : each)), label, coalesce)}
                                onDelete={(id) => { changePaths(paths.filter((each) => each.id !== id), 'Delete path'); setPathId(null); setPathPoint(null); }}
                                onSelectPoint={setPathPoint}
                                onPaint={(how) => { if (activePath) void viewportCommands.current?.paintPath(activePath, how); }} />
                        )}<BrushPanel brush={brush} onChange={setBrush} channels={session.document.channels} paintingMask={target?.kind === 'mask'} textures={textures} onPick={() => setTool('pick')}
                            paintWith={previewHost ? { sections: brushSections, host: previewHost, onPick: paintWith, onMessage: setMessage } : undefined} onMessage={setMessage} /></div>
                            : panel === 'uvs' && uv ? <div className="min-h-0 flex-1 overflow-y-auto"><UvPanel uv={uv} otherSets={otherSets} densityOf={densityOf} onSeamTool={() => setTool('seam')} onApplied={() => { if (!uv.proposal) { putOnAfterOpen.current = uv.putOnWhenOpen; setReopen((value) => value + 1); } }} /></div>
                                : <div className="min-h-0 flex-1 overflow-y-auto"><SetPanel session={session} models={paintable} onReopen={() => setReopen((value) => value + 1)} onShowRays={setRaySettings} showingRays={Boolean(raySettings)} /></div>
                ) : (
                    <p className="p-3 text-2xs text-zinc-500">Pick a texture set to see its layers.</p>
                )}
            </aside>
        </div>
    );
};
