import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowDownIcon, ArrowUpIcon, BrushIcon, BucketIcon, CopyIcon, EyeIcon, EyeOffIcon, FilterIcon, FolderIcon, FolderMoveIcon, GraphIcon, LayersIcon, PackagePlusIcon, PlusIcon, RetextureIcon, TrashIcon, WandIcon } from '../../UI/Icons';
import { materialLibrary } from '../../../runtime/materials/materialLibrary';
import { retextureLayer, retextureResults } from './retextureLayers';
import { BLEND_MODES, BLEND_MODE_LABELS, type BlendMode } from '../../../texturing/gpu/glslLibrary';
import { PICK_LABELS, PICK_MODES, countTriangles, type PickMode } from '../../../texturing/paint/selection';
import { PROJECTION_LABELS, type ProjectionAxis, type ProjectionMode } from '../../../texturing/paint/projections';
import { OUTPUT_NODE_TYPE } from '../../../texturing/graph/nodes/io';
import { OUTPUT_CHANNEL_LABELS, type OutputChannel } from '../../../texturing/graph/types';
import { applyPreset } from '../../../texturing/graph/parameters';
import type { GraphResolver } from '../../../texturing/graph/registry';
import {
    CHANNEL_IS_COLOR,
    CHANNEL_LABELS,
    DEFAULT_FILTER,
    FILTER_LABELS,
    allLayers,
    filterChannels,
    insertLayer,
    locateLayer,
    mapLayer,
    moveLayer,
    newFillLayer,
    newFilterLayer,
    newFolder,
    newPaintLayer,
    paintId,
    type FillProjection,
    type FillSource,
    type FilterKind,
    type FilterSettings,
    type MaskBlend,
    type MaskEffect,
    type PaintChannel,
    type PaintDocument,
    type PaintLayer,
} from '../../../texturing/paint/paintTypes';
import { SMART_MASKS, generatorEffect } from '../../../texturing/paint/smartLibrary';
import { saveSmartMaterial, smartMaskGraph, type LeftOut } from '../../../texturing/paint/smartMaterials';
import type { PreviewHost } from '../../../texturing/paint/previews';
import { Button, IconButton, Popover, Segmented } from '../../UI/kit';
import { Select } from '../../UI/Select';
import { GraphParameterPanel, PresetBar, type PlacedPreset } from '../GraphParameterPanel';
import { sharedPresets } from '../projectPresets';
import type { PaintSession } from './paintSession';
import { ColourFieldRgb } from '../../UI/ColourPicker';
import { SliderRow } from './PaintFields';
import { MaterialPicker, MaterialSections, openGraphCopy, smartMaterialStore, useMaterialSections, type MaterialChoice } from './MaterialPicker';

/** The layer stack of a painted texture set, and the selected layer's settings. */

export interface LayerSelection { layerId: string | null; effectId: string | null }

const field = 'rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-xs text-zinc-100 outline-none focus:border-sky-600';
const BLEND_OPTIONS = [...BLEND_MODES.map((mode) => ({ value: mode, label: BLEND_MODE_LABELS[mode] }))];
const MASK_BLENDS: ReadonlyArray<{ value: MaskBlend; label: string }> = [
    { value: 'replace', label: 'Replace' }, { value: 'multiply', label: 'Multiply' }, { value: 'add', label: 'Add' },
    { value: 'subtract', label: 'Subtract' }, { value: 'max', label: 'Lighten' }, { value: 'min', label: 'Darken' },
];
const MASK_KIND_LABELS: Record<MaskEffect['kind'], string> = { paint: 'Painted', fill: 'Fill', generator: 'Smart mask', levels: 'Levels', blur: 'Blur', invert: 'Invert', below: 'From the layers below', polygon: 'Picked parts', id: 'ID colours' };
/** Masks by parts of the model, picked by clicking it. */
const PART_MASKS: ReadonlyArray<{ label: string; hint: string; pick: PickMode }> = [
    { label: 'Mesh parts', hint: 'Whole parts of the model, as it was made.', pick: 'mesh' },
    { label: 'UV pieces', hint: 'Whole pieces of the UV layout.', pick: 'island' },
    { label: 'Polygons', hint: 'Triangles, quads or edge loops you click.', pick: 'quad' },
];
const css = ([r, g, b]: readonly number[]): string => `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
const FILTER_KINDS = Object.keys(FILTER_LABELS) as FilterKind[];
/** Short names for the Add menu's buttons. */
const FILTER_BUTTONS: Record<FilterKind, string> = { blur: 'Blur', sharpen: 'Sharpen', hsl: 'Hue and saturation', levels: 'Levels', warp: 'Warp', invert: 'Invert' };
const sectionTitle = 'px-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500';

/** A setting from `min` to `max` (0 to 1 unless given), dragged or typed. */
const Slider: React.FC<{ label: string; value: number; min?: number; max?: number; step?: number; limits?: [number, number]; hint?: string; onChange: (value: number) => void }> = ({ min = 0, max = 1, ...rest }) => (
    <SliderRow min={min} max={max} {...rest} />
);

const ValueField: React.FC<{ channel: PaintChannel; value: [number, number, number]; onChange: (value: [number, number, number]) => void }> = ({ channel, value, onChange }) => (
    CHANNEL_IS_COLOR[channel] && channel !== 'normal'
        ? (
            <label className="flex items-center gap-2 text-2xs text-zinc-400">
                <span className="w-20 shrink-0">Colour</span>
                <ColourFieldRgb value={value} onChange={(next) => onChange(next as [number, number, number])} label={/colour/i.test(CHANNEL_LABELS[channel]) ? CHANNEL_LABELS[channel] : `${CHANNEL_LABELS[channel]} colour`} className="h-5 w-9" showHex />
            </label>
        )
        : <Slider label="Value" value={value[0]} onChange={(v) => onChange([v, v, v])} />
);

/** How a fill's picture is laid on: along the UVs or from three sides, its repeats, turn and side blending. */
const ProjectionFields: React.FC<{ value: FillProjection; onChange: (value: FillProjection) => void }> = ({ value, onChange }) => (
    <>
        <Select value={value.projection} options={(Object.keys(PROJECTION_LABELS) as ProjectionMode[]).map((mode) => ({ value: mode, label: PROJECTION_LABELS[mode] }))}
            onChange={(projection) => onChange({ ...value, projection: projection as ProjectionMode, scale: projection === 'uv' ? 1 : 4 })} className="w-full" />
        {(value.projection === 'planar' || value.projection === 'spherical' || value.projection === 'cylindrical') && (
            <div className="flex items-center gap-2 text-2xs text-zinc-400">
                <span className="w-20 shrink-0">{value.projection === 'planar' ? 'Laid along' : 'Round the axis'}</span>
                <Segmented value={value.axis ?? 'y'} options={[{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }, { value: 'z', label: 'Z' }]} onChange={(axis) => onChange({ ...value, axis: axis as ProjectionAxis })} label="Projection axis" />
            </div>
        )}
        <Slider label={value.projection === 'uv' ? 'Scale' : 'Repeats'} value={value.scale} min={0.1} max={40} step={0.1} limits={[0.01, 400]} onChange={(scale) => onChange({ ...value, scale })} />
        <Slider label="Turn" value={value.rotation} min={-180} max={180} step={1} onChange={(rotation) => onChange({ ...value, rotation })} />
        {value.projection === 'triplanar' && <Slider label="Sharpness" value={value.sharpness} min={1} max={16} step={0.5} limits={[1, 64]} onChange={(sharpness) => onChange({ ...value, sharpness })} />}
        {value.projection !== 'uv' && (
            <div className="flex items-center gap-2 text-2xs text-zinc-400">
                <span className="w-20 shrink-0">Mirrored</span>
                <Segmented value={value.mirror ?? 'none'} options={[{ value: 'none', label: 'No' }, { value: 'x', label: 'X' }, { value: 'y', label: 'Y' }, { value: 'z', label: 'Z' }]}
                    onChange={(mirror) => onChange({ ...value, mirror: mirror === 'none' ? undefined : mirror as ProjectionAxis })} label="Mirror the fill across" />
            </div>
        )}
    </>
);

/** The graphs a fill or smart mask can draw from, with their outputs. */
const graphOutputs = (resolve: GraphResolver, graphId: string): Array<{ value: string; label: string }> => {
    const graph = resolve(graphId)?.graph;
    return (graph?.nodes ?? []).filter((node) => node.type === OUTPUT_NODE_TYPE).map((node) => {
        const channel = node.params.channel as OutputChannel;
        return { value: channel === 'custom' ? node.id : channel, label: channel === 'custom' ? String(node.params.name || 'Output') : OUTPUT_CHANNEL_LABELS[channel] };
    });
};

/**
 * A fill's or smart mask's graph settings as the graph lays them out: its groups, parameters shown only
 * while their conditions hold, their descriptions, a way back to each default, and the graph's presets
 * (its own and those shared in the project) to apply.
 */
const GraphValues: React.FC<{ resolve: GraphResolver; graphId: string; values: Record<string, unknown>; textures: ReadonlyArray<{ id: string; name: string }>; onChange: (values: Record<string, unknown>) => void }> = ({ resolve, graphId, values, textures, onChange }) => {
    useEffect(() => { sharedPresets.load(); }, []);
    const sharedVersion = useSyncExternalStore(sharedPresets.subscribe, sharedPresets.getVersion);
    const graph = resolve(graphId)?.graph;
    const presets = useMemo<PlacedPreset[]>(() => {
        void sharedVersion;
        return [...(graph?.presets ?? []).map((preset) => ({ preset, place: 'graph' as const })), ...sharedPresets.of(graphId).map((preset) => ({ preset, place: 'project' as const }))];
    }, [graph, graphId, sharedVersion]);
    if (!graph?.parameters.length) return null;
    return (
        <div className="space-y-1.5">
            {presets.length > 0 && <PresetBar presets={presets} parameters={graph.parameters} values={values} onApply={(preset) => onChange(applyPreset(preset, graph.parameters, values))} />}
            <GraphParameterPanel parameters={graph.parameters} groups={graph.groups} values={values} textures={textures} onChange={(next) => onChange(next)} />
        </div>
    );
};

/** What a saved smart material left out, in plain words, or '' when nothing was. */
const leftOutNote = (leftOut: LeftOut): string => {
    const parts = [
        leftOut.paintLayers ? `${leftOut.paintLayers} paint layer${leftOut.paintLayers === 1 ? '' : 's'}` : '',
        leftOut.paintedMasks ? `${leftOut.paintedMasks} painted mask${leftOut.paintedMasks === 1 ? '' : 's'}` : '',
        leftOut.pickedMasks ? `${leftOut.pickedMasks} mask${leftOut.pickedMasks === 1 ? '' : 's'} of picked parts or ID colours` : '',
        leftOut.ownPictures ? `${leftOut.ownPictures} "what it wore before" fill${leftOut.ownPictures === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    return parts.length ? ` Left out, as they belong to this texture set: ${parts.join(', ')}.` : '';
};

/** A copy of a smart mask's graph in the project, opened in the texture graph editor; returns the copy's id and what to tell the user. */
const copyMask = async (resolve: GraphResolver, graphId: string, values: Record<string, unknown>, name: string): Promise<{ id: string; message: string } | null> => {
    const entry = resolve(graphId);
    return entry ? openGraphCopy(`${name} (graph)`, smartMaskGraph(entry.graph, values)) : null;
};

export const LayerPanel: React.FC<{
    session: PaintSession;
    selection: LayerSelection;
    onSelect: (selection: LayerSelection) => void;
    resolve: GraphResolver;
    graphs: ReadonlyArray<{ id: string; name: string }>;
    textures: ReadonlyArray<{ id: string; name: string; url?: string }>;
    /** Sets a material up to be painted on (a fill layer under a black painted mask), ready for strokes. */
    onPaintWith: (choice: MaterialChoice) => void;
    onMessage: (message: string) => void;
}> = ({ session, selection, onSelect, resolve, graphs, textures, onPaintWith, onMessage }) => {
    const document = session.document;
    const addButton = useRef<HTMLButtonElement>(null);
    const maskButton = useRef<HTMLButtonElement>(null);
    const saveButton = useRef<HTMLSpanElement>(null);
    const [addMenu, setAddMenu] = useState(false);
    const [addView, setAddView] = useState<'layers' | 'paint'>('layers');
    const [maskMenu, setMaskMenu] = useState(false);
    const [saveMenu, setSaveMenu] = useState(false);
    const [saveName, setSaveName] = useState('');
    const [saving, setSaving] = useState(false);
    const [dragging, setDragging] = useState<string | null>(null);
    const layer = allLayers(document.layers).find((candidate) => candidate.id === selection.layerId) ?? null;
    const sections = useMaterialSections({ resolve, graphs, textures });
    const host: PreviewHost = useMemo(() => ({ resolveGraph: resolve, texture: (id: string) => (session.stack.host.graphTexture ?? session.stack.host.texture)(id) }), [resolve, session]);

    const change = (layers: PaintLayer[], label: string, extra: Partial<PaintDocument> = {}, coalesce?: string) => session.change({ ...document, ...extra, layers }, label, coalesce);
    // Dragged and typed changes of one layer make one undo step; switches stay a step each.
    const changeLayer = (id: string, update: (layer: PaintLayer) => PaintLayer | null, label: string) =>
        change(mapLayer(document.layers, id, update), label, {}, label.startsWith('Change') || label === 'Rename layer' ? `${id}:${label}` : undefined);

    const closeAdd = () => { setAddMenu(false); setAddView('layers'); };

    const add = (created: PaintLayer, label: string) => {
        change(insertLayer(document.layers, created, selection.layerId), label);
        onSelect({ layerId: created.id, effectId: null });
        closeAdd();
    };

    const addMask = (effects: MaskEffect[], label: string) => {
        if (!layer) return;
        for (const effect of effects) if (effect.kind === 'paint') session.stack.startMaskPicture(effect.id, effect.value === 1);
        changeLayer(layer.id, (current) => ({ ...current, mask: [...(current.mask ?? []), ...effects] }), label);
        // A mask painted or picked on the model is selected, ready for it.
        const paintable = effects.find((effect) => effect.kind === 'paint' || effect.kind === 'polygon' || effect.kind === 'id');
        onSelect({ layerId: layer.id, effectId: paintable?.id ?? null });
        setMaskMenu(false);
    };

    const nudge = (id: string, direction: 1 | -1) => {
        const where = locateLayer(document.layers, id);
        if (!where) return;
        const list = where.parent ? where.parent.layers! : document.layers;
        const to = where.index + direction;
        if (to < 0 || to >= list.length) return;
        const reordered = [...list];
        [reordered[where.index], reordered[to]] = [reordered[to], reordered[where.index]];
        change(where.parent ? mapLayer(document.layers, where.parent.id, (folder) => ({ ...folder, layers: reordered })) : reordered, 'Move layer');
    };

    const duplicate = (source: PaintLayer) => {
        const copy = (item: PaintLayer): PaintLayer => {
            const id = paintId('l');
            for (const channel of Object.keys(item.channels) as PaintChannel[]) session.stack.copyPictures(`${item.id}:${channel}`, `${id}:${channel}`);
            const mask = item.mask?.map((effect) => {
                const effectId = paintId('m');
                if (effect.kind === 'paint') session.stack.copyPictures(effect.id, effectId);
                return { ...effect, id: effectId, pictures: {} };
            });
            return { ...structuredClone({ ...item, pictures: {} }), id, name: `${item.name} copy`, ...(mask ? { mask } : {}), ...(item.layers ? { layers: item.layers.map(copy) } : {}) };
        };
        add(copy(source), 'Duplicate layer');
    };

    const save = async () => {
        if (!layer || saving) return;
        setSaving(true);
        try {
            const { asset, leftOut } = await saveSmartMaterial(layer, saveName || layer.name, smartMaterialStore);
            onMessage(`Saved "${asset.name}" as a smart material: it is in the Add menu of every texture set in this project.${leftOutNote(leftOut)}`);
            setSaveMenu(false);
        } catch (error) {
            onMessage(error instanceof Error ? error.message : 'The smart material could not be saved: is a project open?');
        } finally {
            setSaving(false);
        }
    };

    const rows: React.ReactNode[] = [];
    const list = (layers: readonly PaintLayer[], depth: number) => {
        for (const item of [...layers].reverse()) {
            const selected = item.id === selection.layerId;
            const KindIcon = item.kind === 'folder' ? FolderIcon : item.kind === 'fill' ? BucketIcon : item.kind === 'filter' ? FilterIcon : BrushIcon;
            rows.push(
                <div
                    key={item.id}
                    draggable
                    onDragStart={() => setDragging(item.id)}
                    onDragEnd={() => setDragging(null)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                        event.preventDefault();
                        if (dragging && dragging !== item.id) change(moveLayer(document.layers, dragging, item.id, item.kind === 'folder' && event.shiftKey), 'Move layer');
                        setDragging(null);
                    }}
                    onClick={() => onSelect({ layerId: item.id, effectId: null })}
                    className={`group flex cursor-pointer items-center gap-1.5 border-b border-zinc-900 py-1 pr-1 text-xs ${selected ? 'bg-sky-900/40 text-white' : 'text-zinc-300 hover:bg-zinc-900'} ${dragging === item.id ? 'opacity-40' : ''}`}
                    style={{ paddingLeft: 6 + depth * 14 }}
                >
                    <button aria-label={item.visible ? `Hide ${item.name}` : `Show ${item.name}`} onClick={(event) => { event.stopPropagation(); changeLayer(item.id, (current) => ({ ...current, visible: !current.visible }), 'Show or hide layer'); }}
                        className="rounded p-0.5 text-zinc-500 hover:text-zinc-200">{item.visible ? <EyeIcon size={12} /> : <EyeOffIcon size={12} />}</button>
                    <KindIcon size={12} className={item.kind === 'fill' ? 'text-amber-400/80' : item.kind === 'paint' ? 'text-sky-400/80' : 'text-zinc-400'} />
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    {(item.opacity ?? 1) < 1 && <span className="shrink-0 text-[10px] tabular-nums text-zinc-500">{Math.round((item.opacity ?? 1) * 100)}%</span>}
                    {item.mask?.length ? (
                        <button title="Its mask" onClick={(event) => { event.stopPropagation(); onSelect({ layerId: item.id, effectId: item.mask!.find((effect) => effect.kind === 'paint')?.id ?? item.mask![0].id }); }}
                            className={`h-4 w-4 rounded-sm border ${selected && selection.effectId ? 'border-sky-400' : 'border-zinc-600'} bg-gradient-to-br from-white to-black`} />
                    ) : null}
                </div>,
            );
            if (item.kind === 'folder') list(item.layers ?? [], depth + 1);
        }
    };
    list(document.layers, 0);

    // What Retexture made for this set, to bring in as a layer (read from the model's overrides and the texture library).
    const retextured = addMenu ? retextureResults(session.target, session.host.materialOverrides(session.target.modelId), (id) => materialLibrary.get(id), textures) : [];
    const addMenuBody = addView === 'paint' ? (
        <MaterialPicker sections={sections} host={host} onPick={(choice) => { onPaintWith(choice); closeAdd(); }} onBack={() => setAddView('layers')} onMessage={onMessage} />
    ) : (
        <div className="max-h-[480px] space-y-2 overflow-y-auto p-2">
            <button onClick={() => setAddView('paint')} className="flex w-full items-center gap-2 rounded border border-sky-800/70 bg-sky-950/40 px-2 py-1.5 text-left hover:bg-sky-900/40">
                <BrushIcon size={14} className="shrink-0 text-sky-400" />
                <span><span className="block text-xs text-zinc-100">Paint with a material</span><span className="block text-2xs leading-snug text-zinc-400">Pick a material, then paint it on: every channel at once.</span></span>
            </button>
            <div className="grid grid-cols-3 gap-1">
                <button onClick={() => add(newPaintLayer(document), 'Add paint layer')} className="flex flex-col items-center gap-1 rounded border border-zinc-800 p-2 text-2xs text-zinc-200 hover:bg-zinc-800"><BrushIcon size={14} /> Paint</button>
                <button onClick={() => add(newFillLayer(document), 'Add fill layer')} className="flex flex-col items-center gap-1 rounded border border-zinc-800 p-2 text-2xs text-zinc-200 hover:bg-zinc-800"><BucketIcon size={14} /> Fill</button>
                <button onClick={() => add(newFolder(), 'Add folder')} className="flex flex-col items-center gap-1 rounded border border-zinc-800 p-2 text-2xs text-zinc-200 hover:bg-zinc-800"><FolderIcon size={14} /> Folder</button>
            </div>
            <div className={sectionTitle}>Filters: change the layers below</div>
            <div className="grid grid-cols-3 gap-1">
                {FILTER_KINDS.map((kind) => (
                    <button key={kind} title={FILTER_LABELS[kind]} onClick={() => add(newFilterLayer(document, kind), `Add ${FILTER_LABELS[kind].toLowerCase()} filter`)}
                        className="flex items-center gap-1 rounded border border-zinc-800 px-1.5 py-1 text-left text-2xs text-zinc-200 hover:bg-zinc-800"><FilterIcon size={11} className="shrink-0 text-zinc-500" /><span className="leading-tight">{FILTER_BUTTONS[kind]}</span></button>
                ))}
            </div>
            {retextured.length > 0 && (
                <>
                    <div className={sectionTitle}>From Retexture: a fill of its picture, to mask and paint over</div>
                    <div className="space-y-1">
                        {retextured.map((result) => (
                            <button key={result.key} onClick={() => add(retextureLayer(document, result), 'Add Retexture result')}
                                className="flex w-full items-center gap-2 rounded border border-zinc-800 px-2 py-1 text-left text-2xs text-zinc-200 hover:bg-zinc-800">
                                <RetextureIcon size={12} className="shrink-0 text-zinc-400" />
                                <span className="min-w-0 flex-1 truncate">{result.name}</span>
                                <span className="shrink-0 text-zinc-500">{Object.keys(result.textures).length > 1 ? `${Object.keys(result.textures).length} maps` : 'colour'}</span>
                            </button>
                        ))}
                    </div>
                </>
            )}
            <div className="px-1 pt-1 text-2xs leading-snug text-zinc-500">Or cover the whole surface with one of these:</div>
            <MaterialSections sections={sections} host={host} onPick={(choice) => add(choice.make(document), `Add ${choice.name}`)} onMessage={onMessage} />
        </div>
    );

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-1 border-b border-zinc-800 px-2 py-1.5">
                <LayersIcon size={13} className="text-zinc-500" />
                <span className="flex-1 text-xs font-semibold text-zinc-300">Layers</span>
                <button ref={addButton} onClick={() => setAddMenu(true)} className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-0.5 text-2xs text-zinc-200 hover:bg-zinc-700"><PlusIcon size={11} /> Add</button>
                <Popover anchor={addButton} open={addMenu} onClose={closeAdd} width={340} label="Add a layer">{addMenuBody}</Popover>
            </div>
            <div className="max-h-[38%] min-h-[80px] overflow-y-auto">{rows}</div>
            {layer && (
                <div className="flex items-center gap-0.5 border-y border-zinc-800 px-1 py-0.5">
                    <IconButton label="Move up" onClick={() => nudge(layer.id, 1)}><ArrowUpIcon size={12} /></IconButton>
                    <IconButton label="Move down" onClick={() => nudge(layer.id, -1)}><ArrowDownIcon size={12} /></IconButton>
                    <IconButton label="Duplicate" onClick={() => duplicate(layer)}><CopyIcon size={12} /></IconButton>
                    <IconButton label="Put into a new folder" onClick={() => {
                        const folder = newFolder(`${layer.name} folder`, [layer]);
                        change(mapLayer(document.layers, layer.id, () => folder), 'Put into folder');
                        onSelect({ layerId: folder.id, effectId: null });
                    }}><FolderMoveIcon size={12} /></IconButton>
                    <span ref={saveButton} className="inline-flex">
                        <IconButton label="Save as a smart material" onClick={() => { setSaveName(layer.name); setSaveMenu(true); }}><PackagePlusIcon size={12} /></IconButton>
                    </span>
                    <Popover anchor={saveButton} open={saveMenu} onClose={() => setSaveMenu(false)} width={280} label="Save as a smart material">
                        <form className="space-y-2 p-2.5" onSubmit={(event) => { event.preventDefault(); void save(); }}>
                            <div className="text-xs font-semibold text-zinc-200">Save as a smart material</div>
                            <p className="text-2xs leading-snug text-zinc-500">Kept in this project, to add or paint on any texture set. Fill layers, filters and smart masks are kept; paint layers and painted masks stay with this set.</p>
                            <input aria-label="Smart material name" value={saveName} maxLength={80} onChange={(event) => setSaveName(event.target.value)} className={`w-full ${field}`} autoFocus />
                            <div className="flex justify-end gap-1.5">
                                <Button size="sm" variant="ghost" onClick={() => setSaveMenu(false)}>Cancel</Button>
                                <Button size="sm" variant="primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
                            </div>
                        </form>
                    </Popover>
                    <span className="flex-1" />
                    <button ref={maskButton} onClick={() => setMaskMenu(true)} className="rounded px-1.5 py-0.5 text-2xs text-zinc-300 hover:bg-zinc-800"><WandIcon size={11} className="mr-1 inline" />Mask</button>
                    <Popover anchor={maskButton} open={maskMenu} onClose={() => setMaskMenu(false)} width={280} label="Add to the mask">
                        <div className="max-h-[480px] space-y-1 overflow-y-auto p-2 text-xs">
                            <button onClick={() => addMask([{ id: paintId('m'), kind: 'paint', enabled: true, blend: 'replace', opacity: 1, value: 0 }], 'Add black mask')} className="block w-full rounded px-2 py-1 text-left text-zinc-100 hover:bg-zinc-800">Black mask: paint to show the layer</button>
                            <button onClick={() => addMask([{ id: paintId('m'), kind: 'paint', enabled: true, blend: 'replace', opacity: 1, value: 1 }], 'Add white mask')} className="block w-full rounded px-2 py-1 text-left text-zinc-100 hover:bg-zinc-800">White mask: paint to hide it</button>
                            <div className={`${sectionTitle} px-2 pt-1`}>Smart masks</div>
                            {SMART_MASKS.map((mask) => (
                                <div key={mask.id} className="group flex items-start rounded hover:bg-zinc-800">
                                    <button onClick={() => addMask(generatorEffect(mask.id), `Add ${mask.name}`)} className="min-w-0 flex-1 px-2 py-1 text-left">
                                        <span className="block text-zinc-100">{mask.name}</span><span className="block text-2xs text-zinc-500">{mask.description}</span>
                                    </button>
                                    <button aria-label={`Edit a copy of ${mask.name} as a texture graph`} title="Edit a copy as a texture graph"
                                        onClick={() => { setMaskMenu(false); void copyMask(resolve, mask.id, {}, mask.name).then((made) => made && onMessage(made.message), (error: unknown) => onMessage(error instanceof Error ? error.message : 'The copy could not be made: is a project open?')); }}
                                        className="invisible m-1 rounded p-0.5 text-zinc-500 hover:text-white group-hover:visible"><GraphIcon size={11} /></button>
                                </div>
                            ))}
                            <div className={`${sectionTitle} px-2 pt-1`}>From the layers below</div>
                            <button onClick={() => addMask([{ id: paintId('m'), kind: 'below', enabled: true, blend: 'replace', opacity: 1, channel: document.channels.includes('height') ? 'height' : document.channels[0], edges: false, low: 0, high: 1 }], 'Add mask from the layers below')}
                                className="block w-full rounded px-2 py-1 text-left hover:bg-zinc-800"><span className="block text-zinc-100">A channel below</span><span className="block text-2xs text-zinc-500">How bright a channel of the layers below is, here.</span></button>
                            {document.channels.includes('height') && (
                                <button onClick={() => addMask([{ id: paintId('m'), kind: 'below', enabled: true, blend: 'replace', opacity: 1, channel: 'height', edges: true, low: 0.02, high: 0.35 }], 'Add edges of the height below')}
                                    className="block w-full rounded px-2 py-1 text-left hover:bg-zinc-800"><span className="block text-zinc-100">Edges of the height below</span><span className="block text-2xs text-zinc-500">Where painted height rises or falls: wear along painted edges.</span></button>
                            )}
                            <div className={`${sectionTitle} px-2 pt-1`}>Parts of the model</div>
                            {PART_MASKS.map(({ label, hint, pick }) => (
                                <button key={pick} onClick={() => {
                                    addMask([{ id: paintId('m'), kind: 'polygon', enabled: true, blend: 'multiply', opacity: 1, triangles: [], pick }], `Add mask by ${label.toLowerCase()}`);
                                    onMessage(`Click the model to add ${label.toLowerCase()} to the mask; Shift-click takes them away.`);
                                }} className="block w-full rounded px-2 py-1 text-left hover:bg-zinc-800"><span className="block text-zinc-100">{label}</span><span className="block text-2xs text-zinc-500">{hint}</span></button>
                            ))}
                            <button onClick={() => {
                                addMask([{ id: paintId('m'), kind: 'id', enabled: true, blend: 'multiply', opacity: 1, colors: [], tolerance: 0.02 }], 'Add mask by ID colours');
                                onMessage(document.bake?.maps?.id ? 'Click the model to pick colours from the baked ID map; Shift-click takes one away.' : 'Bake the mesh maps in the Texture set panel first: the ID map they make is what this mask picks colours from.');
                            }} className="block w-full rounded px-2 py-1 text-left hover:bg-zinc-800"><span className="block text-zinc-100">ID colours</span><span className="block text-2xs text-zinc-500">Colours you click on the baked ID map.</span></button>
                            <div className={`${sectionTitle} px-2 pt-1`}>Effects</div>
                            {(['fill', 'levels', 'blur', 'invert'] as const).map((kind) => (
                                <button key={kind} onClick={() => addMask([{ id: paintId('m'), kind, enabled: true, blend: kind === 'fill' ? 'multiply' : 'replace', opacity: 1, value: 0.5, low: 0, high: 1, mid: 0.5, radius: 0.004 }], `Add ${MASK_KIND_LABELS[kind]}`)}
                                    className="block w-full rounded px-2 py-1 text-left text-zinc-100 hover:bg-zinc-800">{MASK_KIND_LABELS[kind]}</button>
                            ))}
                        </div>
                    </Popover>
                    <IconButton label="Delete layer" onClick={() => { changeLayer(layer.id, () => null, 'Delete layer'); onSelect({ layerId: null, effectId: null }); }}><TrashIcon size={12} /></IconButton>
                </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
                {layer ? <LayerSettings session={session} layer={layer} selection={selection} onSelect={onSelect} resolve={resolve} graphs={graphs} textures={textures} changeLayer={changeLayer} onMessage={onMessage} />
                    : <p className="text-2xs leading-snug text-zinc-500">Select a layer to change it. Paint layers take brush strokes; fill layers cover the whole surface with a value, a picture or a texture graph, usually shaped by a mask; filter layers change what the layers below them make.</p>}
            </div>
        </div>
    );
};

/** A filter layer's own settings, for its kind. */
const FilterFields: React.FC<{ filter: FilterSettings; onChange: (patch: Partial<FilterSettings>) => void }> = ({ filter, onChange }) => {
    switch (filter.kind) {
        case 'blur':
            return <Slider label="Radius" value={filter.radius} max={0.05} step={0.0005} limits={[0, 0.1]} hint="How far it spreads, as a share of the picture's width." onChange={(radius) => onChange({ radius })} />;
        case 'sharpen':
            return (
                <>
                    <Slider label="Radius" value={filter.radius} max={0.02} step={0.0005} limits={[0, 0.1]} hint="The size of the detail it brings out, as a share of the picture's width." onChange={(radius) => onChange({ radius })} />
                    <Slider label="Strength" value={filter.amount} max={4} limits={[0, 64]} onChange={(amount) => onChange({ amount })} />
                </>
            );
        case 'hsl':
            return (
                <>
                    <Slider label="Hue turn" value={filter.hue} min={-0.5} max={0.5} hint="Round the colour wheel: 0.5 is halfway round." onChange={(hue) => onChange({ hue })} />
                    <Slider label="Saturation" value={filter.saturation} min={-1} max={1} onChange={(saturation) => onChange({ saturation })} />
                    <Slider label="Lightness" value={filter.lightness} min={-1} max={1} hint="Grey channels (roughness, height...) take this alone." onChange={(lightness) => onChange({ lightness })} />
                </>
            );
        case 'levels':
            return (
                <>
                    <Slider label="Black at" value={filter.low} onChange={(low) => onChange({ low })} />
                    <Slider label="White at" value={filter.high} onChange={(high) => onChange({ high })} />
                    <Slider label="Midtones" value={filter.mid} min={0.01} max={0.99} onChange={(mid) => onChange({ mid })} />
                </>
            );
        case 'warp':
            return (
                <>
                    <Slider label="Distance" value={filter.radius} max={0.05} step={0.0005} limits={[0, 0.1]} hint="How far it pushes, as a share of the picture's width." onChange={(radius) => onChange({ radius })} />
                    <Slider label="Swirls across" value={filter.amount} min={1} max={32} step={1} limits={[1, 64]} onChange={(amount) => onChange({ amount })} />
                </>
            );
        case 'invert':
            return <p className="text-2xs leading-snug text-zinc-500">Turns each channel it works on over: dark becomes light.</p>;
    }
};

const LayerSettings: React.FC<{
    session: PaintSession;
    layer: PaintLayer;
    selection: LayerSelection;
    onSelect: (selection: LayerSelection) => void;
    resolve: GraphResolver;
    graphs: ReadonlyArray<{ id: string; name: string }>;
    textures: ReadonlyArray<{ id: string; name: string }>;
    changeLayer: (id: string, update: (layer: PaintLayer) => PaintLayer | null, label: string) => void;
    onMessage: (message: string) => void;
}> = ({ session, layer, selection, onSelect, resolve, graphs, textures, changeLayer, onMessage }) => {
    const document = session.document;
    const update = (patch: Partial<PaintLayer>, label: string) => changeLayer(layer.id, (current) => ({ ...current, ...patch }), label);
    const graphChoices = [...SMART_MASKS.map((mask) => ({ value: mask.id, label: mask.name })), { value: 'builtin:leatherGrain', label: 'Leather grain' }, ...graphs.map((graph) => ({ value: graph.id, label: graph.name }))];
    const channelChoices = document.channels.map((channel) => ({ value: channel, label: CHANNEL_LABELS[channel] }));

    // A fill drawing two or more channels from one graph is a material: its settings and how it is laid
    // on are shown once, above the channels.
    const graphSources = layer.kind === 'fill' ? Object.entries(layer.fill ?? {}).filter(([channel]) => layer.channels[channel as PaintChannel]).map(([, source]) => source) : [];
    const materialSource = graphSources.length >= 2 && graphSources.every((source) => source?.kind === 'graph' && source.graphId === (graphSources[0] as { graphId?: string }).graphId)
        ? graphSources[0] as Extract<FillSource, { kind: 'graph' }> : null;
    const materialGraph = materialSource?.graphId ?? null;

    /** Changes every channel of this layer drawn from `graphId` at once. */
    const setSameGraph = (graphId: string, patch: Partial<Extract<FillSource, { kind: 'graph' }>>, label: string) => update({
        fill: Object.fromEntries(Object.entries(layer.fill ?? {}).map(([key, other]) => [key, other?.kind === 'graph' && other.graphId === graphId ? { ...other, ...patch } : other])),
    }, label);

    const fillEditor = (channel: PaintChannel, source: FillSource) => {
        const set = (next: FillSource) => update({ fill: { ...(layer.fill ?? {}), [channel]: next } }, `Change ${CHANNEL_LABELS[channel].toLowerCase()} fill`);
        // Read from below: by default a grey channel reads the height (painted height driving roughness, say).
        const readsFirst: PaintChannel = !CHANNEL_IS_COLOR[channel] && channel !== 'height' && document.channels.includes('height') ? 'height' : channel;
        return (
            <div className="space-y-1.5">
                <Select value={source.kind} options={[{ value: 'value', label: 'A value' }, { value: 'texture', label: 'A picture' }, { value: 'graph', label: 'A texture graph' }, { value: 'below', label: 'The layers below' }, { value: 'current', label: 'What it wore before' }]}
                    onChange={(kind) => set(kind === 'value' ? { kind, value: [0.5, 0.5, 0.5] } : kind === 'texture' ? { kind, textureId: textures[0]?.id ?? '', projection: 'triplanar', scale: 4, rotation: 0, sharpness: 4 } : kind === 'graph' ? { kind, graphId: graphChoices[0]?.value ?? '', output: 'custom', values: {} } : kind === 'below' ? { kind, channel: readsFirst } : { kind: 'current' })}
                    className="w-full" />
                {source.kind === 'value' && <ValueField channel={channel} value={source.value} onChange={(value) => set({ ...source, value })} />}
                {source.kind === 'below' && (
                    <>
                        <Select value={source.channel} options={channelChoices} onChange={(below) => set({ kind: 'below', channel: below as PaintChannel })} className="w-full" />
                        <p className="text-2xs leading-snug text-zinc-500">What the layers below make of that channel, here{CHANNEL_IS_COLOR[source.channel] && !CHANNEL_IS_COLOR[channel] ? ' (its brightness)' : ''}. Blend modes and masks work on it as on any fill.</p>
                    </>
                )}
                {source.kind === 'texture' && (
                    <>
                        <Select value={source.textureId} options={textures.map((texture) => ({ value: texture.id, label: texture.name }))} placeholder="Pick a picture" onChange={(textureId) => set({ ...source, textureId: String(textureId) })} className="w-full" />
                        <ProjectionFields value={source} onChange={(projection) => set({ ...source, ...projection })} />
                    </>
                )}
                {source.kind === 'graph' && source.graphId === materialGraph && (
                    <Select value={source.output} options={graphOutputs(resolve, source.graphId)} onChange={(output) => set({ ...source, output: String(output) })} className="w-full" />
                )}
                {source.kind === 'graph' && source.graphId !== materialGraph && (
                    <>
                        <Select value={source.graphId} options={graphChoices} onChange={(graphId) => set({ ...source, graphId: String(graphId), output: graphOutputs(resolve, String(graphId))[0]?.value ?? 'custom', values: {} })} className="w-full" />
                        <Select value={source.output} options={graphOutputs(resolve, source.graphId)} onChange={(output) => set({ ...source, output: String(output) })} className="w-full" />
                        {/* A material's channels move together: its settings and how it is laid on change every channel drawn from the same graph. */}
                        <GraphValues resolve={resolve} graphId={source.graphId} values={source.values} textures={textures} onChange={(values) => setSameGraph(source.graphId, { values }, 'Change graph settings')} />
                        <ProjectionFields value={{ projection: source.projection ?? 'uv', scale: source.scale ?? 1, rotation: source.rotation ?? 0, sharpness: source.sharpness ?? 4, axis: source.axis, mirror: source.mirror }}
                            onChange={(projection) => setSameGraph(source.graphId, projection, 'Change how the graph is laid on')} />
                    </>
                )}
            </div>
        );
    };

    /** Moves a mask effect one place up (worked out sooner) or down (later). */
    const moveEffect = (index: number, direction: -1 | 1) => {
        const list = [...(layer.mask ?? [])];
        const to = index + direction;
        if (to < 0 || to >= list.length) return;
        [list[index], list[to]] = [list[to], list[index]];
        update({ mask: list }, 'Move mask effect');
    };

    const maskEditor = (effect: MaskEffect, index: number) => {
        const setEffect = (patch: Partial<MaskEffect>, label: string) => update({ mask: (layer.mask ?? []).map((candidate, i) => (i === index ? { ...candidate, ...patch } : candidate)) }, label);
        const active = selection.effectId === effect.id;
        const count = layer.mask?.length ?? 0;
        const graphName = effect.kind === 'generator' ? (resolve(effect.graphId ?? '')?.name ?? 'Smart mask') : '';
        /** The effect's smart mask as a texture graph copy in the project, which the effect then uses (so changes to it show here). */
        const editCopy = () => {
            if (!effect.graphId) return;
            void copyMask(resolve, effect.graphId, effect.values ?? {}, graphName).then((made) => {
                if (!made) return;
                // The copy starts from this effect's settings, so the effect keeps its look.
                changeLayer(layer.id, (current) => ({ ...current, mask: (current.mask ?? []).map((candidate) => (candidate.id === effect.id ? { ...candidate, graphId: made.id, values: {} } : candidate)) }), 'Use the smart mask copy');
                onMessage(`${made.message} This mask now uses it.`);
            }, (error: unknown) => onMessage(error instanceof Error ? error.message : 'The copy could not be made: is a project open?'));
        };
        return (
            <div key={effect.id} onClick={() => onSelect({ layerId: layer.id, effectId: effect.id })}
                className={`space-y-1.5 rounded border p-2 ${active ? 'border-sky-600 bg-sky-950/30' : 'border-zinc-800 bg-zinc-900/60'}`}>
                <div className="flex items-center gap-1.5">
                    <input type="checkbox" checked={effect.enabled} onChange={(event) => setEffect({ enabled: event.target.checked }, 'Turn mask effect on or off')} className="accent-sky-500" aria-label="On" />
                    <span className="min-w-0 flex-1 truncate text-2xs font-semibold text-zinc-200">{effect.kind === 'generator' ? graphName : MASK_KIND_LABELS[effect.kind]}</span>
                    {effect.kind === 'paint' && <span className={`text-[10px] ${active ? 'text-sky-300' : 'text-zinc-500'}`}>{active ? 'Painting here' : 'Click to paint'}</span>}
                    {effect.kind === 'generator' && effect.graphId && <IconButton label="Edit a copy as a texture graph" onClick={(event) => { event.stopPropagation(); editCopy(); }}><GraphIcon size={11} /></IconButton>}
                    {count > 1 && (
                        <>
                            <IconButton label="Apply earlier" disabled={index === 0} onClick={(event) => { event.stopPropagation(); moveEffect(index, -1); }}><ArrowUpIcon size={11} /></IconButton>
                            <IconButton label="Apply later" disabled={index === count - 1} onClick={(event) => { event.stopPropagation(); moveEffect(index, 1); }}><ArrowDownIcon size={11} /></IconButton>
                        </>
                    )}
                    <button aria-label="Remove effect" onClick={(event) => { event.stopPropagation(); update({ mask: (layer.mask ?? []).filter((_, i) => i !== index) }, 'Remove mask effect'); }} className="rounded p-0.5 text-zinc-500 hover:text-red-400"><TrashIcon size={11} /></button>
                </div>
                {effect.kind !== 'levels' && effect.kind !== 'invert' && effect.kind !== 'blur' && (
                    <Select value={effect.blend} options={[...MASK_BLENDS]} onChange={(blend) => setEffect({ blend: blend as MaskBlend }, 'Change mask blend')} className="w-full" />
                )}
                <Slider label="Strength" value={effect.opacity} onChange={(opacity) => setEffect({ opacity }, 'Change mask strength')} />
                {effect.kind === 'fill' && <Slider label="Value" value={effect.value ?? 0.5} onChange={(value) => setEffect({ value }, 'Change mask fill')} />}
                {effect.kind === 'levels' && (
                    <>
                        <Slider label="Black at" value={effect.low ?? 0} onChange={(low) => setEffect({ low }, 'Change mask levels')} />
                        <Slider label="White at" value={effect.high ?? 1} onChange={(high) => setEffect({ high }, 'Change mask levels')} />
                        <Slider label="Midtones" value={effect.mid ?? 0.5} min={0.01} max={0.99} onChange={(mid) => setEffect({ mid }, 'Change mask levels')} />
                    </>
                )}
                {effect.kind === 'blur' && <Slider label="Radius" value={effect.radius ?? 0.004} max={0.05} step={0.0005} limits={[0, 0.1]} onChange={(radius) => setEffect({ radius }, 'Change mask blur')} />}
                {effect.kind === 'below' && (
                    <>
                        <Select value={effect.channel ?? document.channels[0]} options={channelChoices} onChange={(channel) => setEffect({ channel: channel as PaintChannel }, 'Change mask source')} className="w-full" />
                        <Segmented value={effect.edges ? 'edges' : 'value'} options={[{ value: 'value', label: 'How bright it is' }, { value: 'edges', label: 'Where it changes' }]}
                            onChange={(read) => setEffect({ edges: read === 'edges' }, 'Change mask source')} label="Read" />
                        <Slider label="Black at" value={effect.low ?? 0} onChange={(low) => setEffect({ low }, 'Change mask levels')} />
                        <Slider label="White at" value={effect.high ?? 1} onChange={(high) => setEffect({ high }, 'Change mask levels')} />
                    </>
                )}
                {effect.kind === 'polygon' && (
                    <>
                        <label className="flex items-center gap-2 text-2xs text-zinc-400"><span className="w-20 shrink-0">A click picks</span><Select value={effect.pick ?? 'mesh'} options={PICK_MODES.map((mode) => ({ value: mode, label: PICK_LABELS[mode] }))} onChange={(pick) => setEffect({ pick: pick as PickMode }, 'Change how parts are picked')} className="min-w-0 flex-1" /></label>
                        <div className="flex items-center gap-2 text-2xs text-zinc-400">
                            <span className="flex-1">{countTriangles(effect.triangles)} triangle{countTriangles(effect.triangles) === 1 ? '' : 's'} picked</span>
                            {countTriangles(effect.triangles) > 0 && <Button size="sm" variant="ghost" onClick={(event) => { event.stopPropagation(); setEffect({ triangles: [] }, 'Clear picked parts'); }}>Clear</Button>}
                        </div>
                        <p className="text-2xs leading-snug text-zinc-500">{active ? `While this effect is selected, clicking the model adds the ${PICK_LABELS[effect.pick ?? 'mesh'].toLowerCase()} under the pointer; Shift-click takes it away.` : 'Click this effect, then click the model to pick.'}</p>
                    </>
                )}
                {effect.kind === 'id' && (
                    <>
                        {!document.bake?.maps?.id && <p className="text-2xs leading-snug text-amber-300">Bake the mesh maps in the Texture set panel: this mask picks colours from the ID map they make.</p>}
                        <div className="flex flex-wrap items-center gap-1">
                            {(effect.colors ?? []).map((colour, i) => (
                                <button key={i} aria-label="Take this colour away" title="Take this colour away" onClick={(event) => { event.stopPropagation(); setEffect({ colors: (effect.colors ?? []).filter((_, j) => j !== i) }, 'Take away an ID colour'); }}
                                    className="h-5 w-5 rounded-sm border border-zinc-600 hover:border-red-400" style={{ background: css(colour) }} />
                            ))}
                            {!effect.colors?.length && <span className="text-2xs text-zinc-500">No colours picked yet.</span>}
                        </div>
                        <Slider label="Tolerance" value={effect.tolerance ?? 0.02} max={0.25} step={0.005} hint="How near a colour of the ID map must be to a picked one to count." onChange={(tolerance) => setEffect({ tolerance }, 'Change ID colour tolerance')} />
                        <p className="text-2xs leading-snug text-zinc-500">{active ? 'While this effect is selected, clicking the model takes the ID map\'s colour there; Shift-click takes one away.' : 'Click this effect, then click the model to pick colours.'}</p>
                    </>
                )}
                {effect.kind === 'generator' && (
                    <Select value={effect.graphId ?? ''} options={graphChoices} onChange={(graphId) => setEffect({ graphId: String(graphId), output: graphOutputs(resolve, String(graphId))[0]?.value ?? 'custom', values: {} }, 'Change smart mask')} className="w-full" />
                )}
                {effect.kind === 'generator' && effect.graphId && (
                    <GraphValues resolve={resolve} graphId={effect.graphId} values={effect.values ?? {}} textures={textures} onChange={(values) => setEffect({ values }, 'Change smart mask')} />
                )}
            </div>
        );
    };

    const channelToggle = (channel: PaintChannel, on: boolean) => {
        const channels = { ...layer.channels };
        if (on) channels[channel] = { mode: channel === 'normal' && layer.kind !== 'filter' ? 'normalCombine' : 'normal', opacity: 1 };
        else delete channels[channel];
        const fill = layer.kind === 'fill' && on && !layer.fill?.[channel] ? { ...(layer.fill ?? {}), [channel]: { kind: 'value', value: [0.5, 0.5, channel === 'normal' ? 1 : 0.5] } as FillSource } : layer.fill;
        update({ channels, ...(fill ? { fill } : {}) }, `Change ${CHANNEL_LABELS[channel].toLowerCase()}`);
    };

    const opacity = (
        <Slider label="Opacity" value={layer.opacity ?? 1} hint="How strongly the whole layer shows, on top of each channel's own opacity." onChange={(value) => update({ opacity: value }, layer.kind === 'folder' ? 'Change folder opacity' : 'Change layer opacity')} />
    );

    return (
        <div className="space-y-3">
            <input aria-label="Layer name" value={layer.name} onChange={(event) => update({ name: event.target.value.slice(0, 80) }, 'Rename layer')} className={`w-full ${field}`} />
            {layer.kind === 'folder' ? (
                <div className="space-y-1.5">
                    {opacity}
                    <label className="flex items-center gap-2 text-2xs text-zinc-400">
                        <span className="w-20 shrink-0">Blend</span>
                        <Select value={layer.blend ?? 'normal'} options={BLEND_OPTIONS} onChange={(mode) => update({ blend: mode === 'normal' ? undefined : mode as BlendMode }, 'Change folder blend')} className="min-w-0 flex-1" />
                    </label>
                    <p className="text-2xs leading-snug text-zinc-500">How what the folder makes is laid over the layers below it, in every channel but the normal.</p>
                </div>
            ) : layer.kind === 'filter' ? (
                <div className="space-y-2">
                    {opacity}
                    <div className="text-2xs font-semibold text-zinc-400">{FILTER_LABELS[layer.filter?.kind ?? 'blur']}</div>
                    <FilterFields filter={layer.filter ?? DEFAULT_FILTER.blur} onChange={(patch) => update({ filter: { ...(layer.filter ?? DEFAULT_FILTER.blur), ...patch } }, 'Change filter')} />
                    <div className="text-2xs font-semibold text-zinc-400">Channels it changes</div>
                    {document.channels.filter((channel) => filterChannels(layer.filter?.kind ?? 'blur', [channel]).length > 0).map((channel) => {
                        const blend = layer.channels[channel];
                        return (
                            <div key={channel} className="space-y-1 rounded border border-zinc-800 bg-zinc-900/40 p-1.5">
                                <label className="flex items-center gap-1.5 text-xs text-zinc-200">
                                    <input type="checkbox" checked={Boolean(blend)} className="accent-sky-500" onChange={(event) => channelToggle(channel, event.target.checked)} />
                                    {CHANNEL_LABELS[channel]}
                                </label>
                                {blend && <Slider label="Strength" value={blend.opacity} onChange={(value) => update({ channels: { ...layer.channels, [channel]: { ...blend, opacity: value } } }, 'Change channel opacity')} />}
                            </div>
                        );
                    })}
                </div>
            ) : (
                <div className="space-y-2">
                    {opacity}
                    {materialSource && (
                        <div className="space-y-1.5 rounded border border-zinc-800 bg-zinc-900/40 p-1.5">
                            <div className="truncate text-xs text-zinc-200">Material: <span className="font-semibold">{resolve(materialSource.graphId)?.name ?? 'A texture graph'}</span></div>
                            <GraphValues resolve={resolve} graphId={materialSource.graphId} values={materialSource.values} textures={textures} onChange={(values) => setSameGraph(materialSource.graphId, { values }, 'Change graph settings')} />
                            <ProjectionFields value={{ projection: materialSource.projection ?? 'uv', scale: materialSource.scale ?? 1, rotation: materialSource.rotation ?? 0, sharpness: materialSource.sharpness ?? 4, axis: materialSource.axis, mirror: materialSource.mirror }}
                                onChange={(projection) => setSameGraph(materialSource.graphId, projection, 'Change how the graph is laid on')} />
                        </div>
                    )}
                    <div className="text-2xs font-semibold text-zinc-400">Channels</div>
                    {document.channels.map((channel) => {
                        const blend = layer.channels[channel];
                        return (
                            <div key={channel} className="space-y-1.5 rounded border border-zinc-800 bg-zinc-900/40 p-1.5">
                                <label className="flex items-center gap-1.5 text-xs text-zinc-200">
                                    <input type="checkbox" checked={Boolean(blend)} className="accent-sky-500" onChange={(event) => channelToggle(channel, event.target.checked)} />
                                    {CHANNEL_LABELS[channel]}
                                </label>
                                {blend && (
                                    <>
                                        {channel !== 'normal' && <Select value={blend.mode} options={BLEND_OPTIONS} onChange={(mode) => update({ channels: { ...layer.channels, [channel]: { ...blend, mode } } }, 'Change blend mode')} className="w-full" />}
                                        <Slider label="Opacity" value={blend.opacity} onChange={(value) => update({ channels: { ...layer.channels, [channel]: { ...blend, opacity: value } } }, 'Change channel opacity')} />
                                        {layer.kind === 'fill' && layer.fill?.[channel] && fillEditor(channel, layer.fill[channel]!)}
                                    </>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
            {(layer.mask?.length ?? 0) > 0 && (
                <div className="space-y-1.5">
                    <div className="text-2xs font-semibold text-zinc-400">Mask effects, applied top to bottom</div>
                    {(layer.mask ?? []).map(maskEditor)}
                </div>
            )}
        </div>
    );
};
