import React, { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Brush, Copy, Eye, EyeOff, Folder, FolderInput, Layers, PaintBucket, Plus, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { BLEND_MODES, BLEND_MODE_LABELS } from '../../../texturing/gpu/glslLibrary';
import { OUTPUT_NODE_TYPE } from '../../../texturing/graph/nodes/io';
import { OUTPUT_CHANNEL_LABELS, type GraphParameter, type OutputChannel, type TexParamDef } from '../../../texturing/graph/types';
import type { GraphResolver } from '../../../texturing/graph/registry';
import {
    CHANNEL_IS_COLOR,
    CHANNEL_LABELS,
    allLayers,
    insertLayer,
    locateLayer,
    mapLayer,
    moveLayer,
    newFillLayer,
    newFolder,
    newPaintLayer,
    paintId,
    type FillSource,
    type MaskBlend,
    type MaskEffect,
    type PaintChannel,
    type PaintDocument,
    type PaintLayer,
} from '../../../texturing/paint/paintTypes';
import { SMART_MASKS, SMART_MATERIALS, graphMaterialLayer, generatorEffect } from '../../../texturing/paint/smartLibrary';
import { fromHex, toHex } from '../../Materials/MaterialParamField';
import { IconButton, Popover } from '../../UI/kit';
import { Select } from '../../UI/Select';
import { ParamControl } from '../TextureParamField';
import type { PaintSession } from './paintSession';

/** The layer stack of a painted texture set, and the selected layer's settings. */

export interface LayerSelection { layerId: string | null; effectId: string | null }

const field = 'rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-xs text-zinc-100 outline-none focus:border-sky-600';
const BLEND_OPTIONS = [...BLEND_MODES.map((mode) => ({ value: mode, label: BLEND_MODE_LABELS[mode] }))];
const MASK_BLENDS: ReadonlyArray<{ value: MaskBlend; label: string }> = [
    { value: 'replace', label: 'Replace' }, { value: 'multiply', label: 'Multiply' }, { value: 'add', label: 'Add' },
    { value: 'subtract', label: 'Subtract' }, { value: 'max', label: 'Lighten' }, { value: 'min', label: 'Darken' },
];
const MASK_KIND_LABELS: Record<MaskEffect['kind'], string> = { paint: 'Painted', fill: 'Fill', generator: 'Smart mask', levels: 'Levels', blur: 'Blur', invert: 'Invert' };

const Slider: React.FC<{ label: string; value: number; min?: number; max?: number; step?: number; onChange: (value: number) => void }> = ({ label, value, min = 0, max = 1, step = 0.01, onChange }) => (
    <label className="flex items-center gap-2 text-2xs text-zinc-400">
        <span className="w-20 shrink-0 truncate">{label}</span>
        <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} className="h-1 min-w-0 flex-1 accent-sky-500" aria-label={label} />
        <span className="w-8 text-right tabular-nums text-zinc-300">{Number(value.toFixed(2))}</span>
    </label>
);

const ValueField: React.FC<{ channel: PaintChannel; value: [number, number, number]; onChange: (value: [number, number, number]) => void }> = ({ channel, value, onChange }) => (
    CHANNEL_IS_COLOR[channel] && channel !== 'normal'
        ? (
            <label className="flex items-center gap-2 text-2xs text-zinc-400">
                <span className="w-20 shrink-0">Colour</span>
                <input type="color" value={toHex(value)} onChange={(event) => onChange(fromHex(event.target.value) as [number, number, number])} className="h-5 w-9 cursor-pointer rounded border border-zinc-700 bg-transparent" aria-label={`${CHANNEL_LABELS[channel]} colour`} />
                <span className="font-mono text-zinc-500">{toHex(value)}</span>
            </label>
        )
        : <Slider label="Value" value={value[0]} onChange={(v) => onChange([v, v, v])} />
);

/** The graphs a fill or smart mask can draw from, with their outputs. */
const graphOutputs = (resolve: GraphResolver, graphId: string): Array<{ value: string; label: string }> => {
    const graph = resolve(graphId)?.graph;
    return (graph?.nodes ?? []).filter((node) => node.type === OUTPUT_NODE_TYPE).map((node) => {
        const channel = node.params.channel as OutputChannel;
        return { value: channel === 'custom' ? node.id : channel, label: channel === 'custom' ? String(node.params.name || 'Output') : OUTPUT_CHANNEL_LABELS[channel] };
    });
};

const parameterDef = (parameter: GraphParameter): TexParamDef => ({ key: parameter.name, label: parameter.label, kind: parameter.kind, default: parameter.default, min: parameter.min, max: parameter.max, step: parameter.step, options: parameter.options });

const GraphValues: React.FC<{ resolve: GraphResolver; graphId: string; values: Record<string, unknown>; textures: ReadonlyArray<{ id: string; name: string }>; onChange: (values: Record<string, unknown>) => void }> = ({ resolve, graphId, values, textures, onChange }) => {
    const parameters = resolve(graphId)?.graph.parameters ?? [];
    if (!parameters.length) return null;
    return (
        <div className="space-y-1.5">
            {parameters.map((parameter) => (
                <div key={parameter.name} className="flex items-center gap-2">
                    <span className="w-20 shrink-0 truncate text-2xs text-zinc-400">{parameter.label}</span>
                    <div className="min-w-0 flex-1">
                        <ParamControl param={parameterDef(parameter)} value={values[parameter.name] ?? parameter.default} textures={textures} onChange={(value) => onChange({ ...values, [parameter.name]: value })} />
                    </div>
                </div>
            ))}
        </div>
    );
};

export const LayerPanel: React.FC<{
    session: PaintSession;
    selection: LayerSelection;
    onSelect: (selection: LayerSelection) => void;
    resolve: GraphResolver;
    graphs: ReadonlyArray<{ id: string; name: string }>;
    textures: ReadonlyArray<{ id: string; name: string }>;
}> = ({ session, selection, onSelect, resolve, graphs, textures }) => {
    const document = session.document;
    const addButton = useRef<HTMLButtonElement>(null);
    const maskButton = useRef<HTMLButtonElement>(null);
    const [addMenu, setAddMenu] = useState(false);
    const [maskMenu, setMaskMenu] = useState(false);
    const [dragging, setDragging] = useState<string | null>(null);
    const layer = allLayers(document.layers).find((candidate) => candidate.id === selection.layerId) ?? null;

    const change = (layers: PaintLayer[], label: string, extra: Partial<PaintDocument> = {}) => session.change({ ...document, ...extra, layers }, label);
    const changeLayer = (id: string, update: (layer: PaintLayer) => PaintLayer | null, label: string) => change(mapLayer(document.layers, id, update), label);

    const add = (created: PaintLayer, label: string) => {
        change(insertLayer(document.layers, created, selection.layerId), label);
        onSelect({ layerId: created.id, effectId: null });
        setAddMenu(false);
    };

    const addMask = (effects: MaskEffect[], label: string) => {
        if (!layer) return;
        for (const effect of effects) if (effect.kind === 'paint') session.stack.startMaskPicture(effect.id, effect.value === 1);
        changeLayer(layer.id, (current) => ({ ...current, mask: [...(current.mask ?? []), ...effects] }), label);
        const paintable = effects.find((effect) => effect.kind === 'paint');
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
            for (const channel of Object.keys(item.channels) as PaintChannel[]) {
                for (const tile of session.stack.tiles) {
                    const from = `${item.id}:${channel}`;
                    if (!session.stack.hasPicture(from, tile)) continue;
                    session.gpu.copy(session.stack.picture(from, tile), session.stack.picture(`${id}:${channel}`, tile));
                    session.stack.touch(`${id}:${channel}`, tile);
                }
            }
            const mask = item.mask?.map((effect) => {
                const effectId = paintId('m');
                if (effect.kind === 'paint') for (const tile of session.stack.tiles) {
                    if (!session.stack.hasPicture(effect.id, tile)) continue;
                    session.gpu.copy(session.stack.picture(effect.id, tile), session.stack.picture(effectId, tile));
                    session.stack.touch(effectId, tile);
                }
                return { ...effect, id: effectId, pictures: {} };
            });
            return { ...structuredClone({ ...item, pictures: {} }), id, name: `${item.name} copy`, ...(mask ? { mask } : {}), ...(item.layers ? { layers: item.layers.map(copy) } : {}) };
        };
        add(copy(source), 'Duplicate layer');
    };

    const rows: React.ReactNode[] = [];
    const list = (layers: readonly PaintLayer[], depth: number) => {
        for (const item of [...layers].reverse()) {
            const selected = item.id === selection.layerId;
            const KindIcon = item.kind === 'folder' ? Folder : item.kind === 'fill' ? PaintBucket : Brush;
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
                        className="rounded p-0.5 text-zinc-500 hover:text-zinc-200">{item.visible ? <Eye size={12} /> : <EyeOff size={12} />}</button>
                    <KindIcon size={12} className={item.kind === 'fill' ? 'text-amber-400/80' : item.kind === 'folder' ? 'text-zinc-400' : 'text-sky-400/80'} />
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
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

    const smartMenu = (
        <div className="max-h-[420px] space-y-2 overflow-y-auto p-2">
            <div className="grid grid-cols-3 gap-1">
                <button onClick={() => add(newPaintLayer(document), 'Add paint layer')} className="flex flex-col items-center gap-1 rounded border border-zinc-800 p-2 text-2xs text-zinc-200 hover:bg-zinc-800"><Brush size={14} /> Paint</button>
                <button onClick={() => add(newFillLayer(document), 'Add fill layer')} className="flex flex-col items-center gap-1 rounded border border-zinc-800 p-2 text-2xs text-zinc-200 hover:bg-zinc-800"><PaintBucket size={14} /> Fill</button>
                <button onClick={() => add(newFolder(), 'Add folder')} className="flex flex-col items-center gap-1 rounded border border-zinc-800 p-2 text-2xs text-zinc-200 hover:bg-zinc-800"><Folder size={14} /> Folder</button>
            </div>
            <div className="px-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Smart materials</div>
            {SMART_MATERIALS.map((material) => (
                <button key={material.id} onClick={() => add({ ...material.build(document), from: material.name }, `Add ${material.name}`)} className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-zinc-800">
                    <span className="mt-0.5 h-4 w-4 shrink-0 rounded-sm border border-zinc-700" style={{ background: material.swatch }} />
                    <span><span className="block text-xs text-zinc-100">{material.name}</span><span className="block text-2xs leading-snug text-zinc-500">{material.description}</span></span>
                </button>
            ))}
            {graphs.length > 0 && <div className="px-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Texture graphs in this project</div>}
            {graphs.map((graph) => (
                <button key={graph.id} onClick={() => { const entry = resolve(graph.id); if (entry) add(graphMaterialLayer(document, graph.id, graph.name, entry.graph), `Add ${graph.name}`); }}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-100 hover:bg-zinc-800"><Sparkles size={12} className="text-amber-400/80" /> {graph.name}</button>
            ))}
        </div>
    );

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-1 border-b border-zinc-800 px-2 py-1.5">
                <Layers size={13} className="text-zinc-500" />
                <span className="flex-1 text-xs font-semibold text-zinc-300">Layers</span>
                <button ref={addButton} onClick={() => setAddMenu(true)} className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-0.5 text-2xs text-zinc-200 hover:bg-zinc-700"><Plus size={11} /> Add</button>
                <Popover anchor={addButton} open={addMenu} onClose={() => setAddMenu(false)} width={300} label="Add a layer">{smartMenu}</Popover>
            </div>
            <div className="max-h-[38%] min-h-[80px] overflow-y-auto">{rows}</div>
            {layer && (
                <div className="flex items-center gap-0.5 border-y border-zinc-800 px-1 py-0.5">
                    <IconButton label="Move up" onClick={() => nudge(layer.id, 1)}><ArrowUp size={12} /></IconButton>
                    <IconButton label="Move down" onClick={() => nudge(layer.id, -1)}><ArrowDown size={12} /></IconButton>
                    <IconButton label="Duplicate" onClick={() => duplicate(layer)}><Copy size={12} /></IconButton>
                    <IconButton label="Put into a new folder" onClick={() => {
                        const folder = newFolder(`${layer.name} folder`, [layer]);
                        change(mapLayer(document.layers, layer.id, () => folder), 'Put into folder');
                        onSelect({ layerId: folder.id, effectId: null });
                    }}><FolderInput size={12} /></IconButton>
                    <span className="flex-1" />
                    <button ref={maskButton} onClick={() => setMaskMenu(true)} className="rounded px-1.5 py-0.5 text-2xs text-zinc-300 hover:bg-zinc-800"><Wand2 size={11} className="mr-1 inline" />Mask</button>
                    <Popover anchor={maskButton} open={maskMenu} onClose={() => setMaskMenu(false)} width={280} label="Add to the mask">
                        <div className="space-y-1 p-2 text-xs">
                            <button onClick={() => addMask([{ id: paintId('m'), kind: 'paint', enabled: true, blend: 'replace', opacity: 1, value: 0 }], 'Add black mask')} className="block w-full rounded px-2 py-1 text-left text-zinc-100 hover:bg-zinc-800">Black mask: paint to show the layer</button>
                            <button onClick={() => addMask([{ id: paintId('m'), kind: 'paint', enabled: true, blend: 'replace', opacity: 1, value: 1 }], 'Add white mask')} className="block w-full rounded px-2 py-1 text-left text-zinc-100 hover:bg-zinc-800">White mask: paint to hide it</button>
                            <div className="px-2 pt-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Smart masks</div>
                            {SMART_MASKS.map((mask) => (
                                <button key={mask.id} onClick={() => addMask(generatorEffect(mask.id), `Add ${mask.name}`)} className="block w-full rounded px-2 py-1 text-left hover:bg-zinc-800">
                                    <span className="block text-zinc-100">{mask.name}</span><span className="block text-2xs text-zinc-500">{mask.description}</span>
                                </button>
                            ))}
                            <div className="px-2 pt-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Effects</div>
                            {(['fill', 'levels', 'blur', 'invert'] as const).map((kind) => (
                                <button key={kind} onClick={() => addMask([{ id: paintId('m'), kind, enabled: true, blend: kind === 'fill' ? 'multiply' : 'replace', opacity: 1, value: 0.5, low: 0, high: 1, mid: 0.5, radius: 0.004 }], `Add ${MASK_KIND_LABELS[kind]}`)}
                                    className="block w-full rounded px-2 py-1 text-left text-zinc-100 hover:bg-zinc-800">{MASK_KIND_LABELS[kind]}</button>
                            ))}
                        </div>
                    </Popover>
                    <IconButton label="Delete layer" onClick={() => { changeLayer(layer.id, () => null, 'Delete layer'); onSelect({ layerId: null, effectId: null }); }}><Trash2 size={12} /></IconButton>
                </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
                {layer ? <LayerSettings session={session} layer={layer} selection={selection} onSelect={onSelect} resolve={resolve} graphs={graphs} textures={textures} changeLayer={changeLayer} />
                    : <p className="text-2xs leading-snug text-zinc-500">Select a layer to change it. Paint layers take brush strokes; fill layers cover the whole surface with a value, a picture or a texture graph, usually shaped by a mask.</p>}
            </div>
        </div>
    );
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
}> = ({ session, layer, selection, onSelect, resolve, graphs, textures, changeLayer }) => {
    const document = session.document;
    const update = (patch: Partial<PaintLayer>, label: string) => changeLayer(layer.id, (current) => ({ ...current, ...patch }), label);
    const graphChoices = [...SMART_MASKS.map((mask) => ({ value: mask.id, label: mask.name })), { value: 'builtin:leatherGrain', label: 'Leather grain' }, ...graphs.map((graph) => ({ value: graph.id, label: graph.name }))];

    const fillEditor = (channel: PaintChannel, source: FillSource) => {
        const set = (next: FillSource) => update({ fill: { ...(layer.fill ?? {}), [channel]: next } }, `Change ${CHANNEL_LABELS[channel].toLowerCase()} fill`);
        return (
            <div className="space-y-1.5">
                <Select value={source.kind} options={[{ value: 'value', label: 'A value' }, { value: 'texture', label: 'A picture' }, { value: 'graph', label: 'A texture graph' }, { value: 'current', label: 'What it wore before' }]}
                    onChange={(kind) => set(kind === 'value' ? { kind, value: CHANNEL_IS_COLOR[channel] ? [0.5, 0.5, 0.5] : [0.5, 0.5, 0.5] } : kind === 'texture' ? { kind, textureId: textures[0]?.id ?? '', projection: 'triplanar', scale: 4, rotation: 0, sharpness: 4 } : kind === 'graph' ? { kind, graphId: graphChoices[0]?.value ?? '', output: 'custom', values: {} } : { kind: 'current' })}
                    className="w-full" />
                {source.kind === 'value' && <ValueField channel={channel} value={source.value} onChange={(value) => set({ ...source, value })} />}
                {source.kind === 'texture' && (
                    <>
                        <Select value={source.textureId} options={textures.map((texture) => ({ value: texture.id, label: texture.name }))} placeholder="Pick a picture" onChange={(textureId) => set({ ...source, textureId: String(textureId) })} className="w-full" />
                        <Select value={source.projection} options={[{ value: 'triplanar', label: 'From three sides (no seams)' }, { value: 'uv', label: 'Along the UVs' }]} onChange={(projection) => set({ ...source, projection: projection as 'uv' | 'triplanar' })} className="w-full" />
                        <Slider label="Scale" value={source.scale} min={0.1} max={40} step={0.1} onChange={(scale) => set({ ...source, scale })} />
                        <Slider label="Turn" value={source.rotation} min={-180} max={180} step={1} onChange={(rotation) => set({ ...source, rotation })} />
                    </>
                )}
                {source.kind === 'graph' && (
                    <>
                        <Select value={source.graphId} options={graphChoices} onChange={(graphId) => set({ ...source, graphId: String(graphId), output: graphOutputs(resolve, String(graphId))[0]?.value ?? 'custom', values: {} })} className="w-full" />
                        <Select value={source.output} options={graphOutputs(resolve, source.graphId)} onChange={(output) => set({ ...source, output: String(output) })} className="w-full" />
                        <GraphValues resolve={resolve} graphId={source.graphId} values={source.values} textures={textures} onChange={(values) => set({ ...source, values })} />
                    </>
                )}
            </div>
        );
    };

    const maskEditor = (effect: MaskEffect, index: number) => {
        const setEffect = (patch: Partial<MaskEffect>, label: string) => update({ mask: (layer.mask ?? []).map((candidate, i) => (i === index ? { ...candidate, ...patch } : candidate)) }, label);
        const active = selection.effectId === effect.id;
        return (
            <div key={effect.id} onClick={() => onSelect({ layerId: layer.id, effectId: effect.id })}
                className={`space-y-1.5 rounded border p-2 ${active ? 'border-sky-600 bg-sky-950/30' : 'border-zinc-800 bg-zinc-900/60'}`}>
                <div className="flex items-center gap-1.5">
                    <input type="checkbox" checked={effect.enabled} onChange={(event) => setEffect({ enabled: event.target.checked }, 'Turn mask effect on or off')} className="accent-sky-500" aria-label="On" />
                    <span className="flex-1 text-2xs font-semibold text-zinc-200">{effect.kind === 'generator' ? (resolve(effect.graphId ?? '')?.name ?? 'Smart mask') : MASK_KIND_LABELS[effect.kind]}</span>
                    {effect.kind === 'paint' && <span className={`text-[10px] ${active ? 'text-sky-300' : 'text-zinc-500'}`}>{active ? 'Painting here' : 'Click to paint'}</span>}
                    <button aria-label="Remove effect" onClick={(event) => { event.stopPropagation(); update({ mask: (layer.mask ?? []).filter((_, i) => i !== index) }, 'Remove mask effect'); }} className="rounded p-0.5 text-zinc-500 hover:text-red-400"><Trash2 size={11} /></button>
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
                {effect.kind === 'blur' && <Slider label="Radius" value={effect.radius ?? 0.004} min={0} max={0.05} step={0.0005} onChange={(radius) => setEffect({ radius }, 'Change mask blur')} />}
                {effect.kind === 'generator' && effect.graphId && (
                    <GraphValues resolve={resolve} graphId={effect.graphId} values={effect.values ?? {}} textures={textures} onChange={(values) => setEffect({ values }, 'Change smart mask')} />
                )}
            </div>
        );
    };

    return (
        <div className="space-y-3">
            <input aria-label="Layer name" value={layer.name} onChange={(event) => update({ name: event.target.value.slice(0, 80) }, 'Rename layer')} className={`w-full ${field}`} />
            {layer.kind === 'folder' ? (
                <Slider label="Opacity" value={layer.opacity ?? 1} onChange={(opacity) => update({ opacity }, 'Change folder opacity')} />
            ) : (
                <div className="space-y-2">
                    <div className="text-2xs font-semibold text-zinc-400">Channels</div>
                    {document.channels.map((channel) => {
                        const blend = layer.channels[channel];
                        return (
                            <div key={channel} className="space-y-1.5 rounded border border-zinc-800 bg-zinc-900/40 p-1.5">
                                <label className="flex items-center gap-1.5 text-xs text-zinc-200">
                                    <input type="checkbox" checked={Boolean(blend)} className="accent-sky-500" onChange={(event) => {
                                        const channels = { ...layer.channels };
                                        if (event.target.checked) channels[channel] = { mode: channel === 'normal' ? 'normalCombine' : 'normal', opacity: 1 };
                                        else delete channels[channel];
                                        const fill = layer.kind === 'fill' && event.target.checked && !layer.fill?.[channel] ? { ...(layer.fill ?? {}), [channel]: { kind: 'value', value: [0.5, 0.5, channel === 'normal' ? 1 : 0.5] } as FillSource } : layer.fill;
                                        update({ channels, ...(fill ? { fill } : {}) }, `Change ${CHANNEL_LABELS[channel].toLowerCase()}`);
                                    }} />
                                    {CHANNEL_LABELS[channel]}
                                </label>
                                {blend && (
                                    <>
                                        {channel !== 'normal' && <Select value={blend.mode} options={BLEND_OPTIONS} onChange={(mode) => update({ channels: { ...layer.channels, [channel]: { ...blend, mode } } }, 'Change blend mode')} className="w-full" />}
                                        <Slider label="Opacity" value={blend.opacity} onChange={(opacity) => update({ channels: { ...layer.channels, [channel]: { ...blend, opacity } } }, 'Change channel opacity')} />
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
                    <div className="text-2xs font-semibold text-zinc-400">Mask (worked out top to bottom)</div>
                    {(layer.mask ?? []).map(maskEditor)}
                </div>
            )}
        </div>
    );
};
