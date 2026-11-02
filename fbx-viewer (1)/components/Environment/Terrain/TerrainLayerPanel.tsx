import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Download, Eraser, ImageOff, PaintBucket, Plus, Trash2, Upload, Wand2 } from 'lucide-react';
import { LevelObject, TerrainData, TerrainGrassVariety, TerrainTextureLayer } from '../../../types';
import { useScene } from '../../../context/SceneContext';
import { useNotification } from '../../../context/NotificationContext';
import { editorSession } from '../../../utils/editorSession';
import { terrainSamplesPerSide } from '../../../utils/terrainHeightfieldCodec';
import { Button, Section, Segmented } from '../../UI/kit';
import { Select } from '../../UI/Select';
import { ScrubbableInput } from '../../UI/Properties/ScrubbableInput';
import { decodeHeightmapFile, downloadBytes, encodeWeightmapPng, resampleGrid } from './terrainHeightmapFile';
import {
    createDefaultTerrainSplat,
    DEFAULT_TERRAIN_GRASS,
    DEFAULT_TERRAIN_LAYER_TILE_SIZE,
    MAX_TERRAIN_GRASS_VARIETIES,
    isTerrainSplatPending,
    MAX_TERRAIN_LAYERS,
    normalizeTerrainLayers,
    terrainLayerTileSize,
    type TerrainPaintState,
} from './terrainSplatCodec';
import {
    clearLayer, fillLayer, layerCoverage, layerValues, paintLayerByRule, removeLayerWeights, setLayerFromValues, swapLayerWeights,
    type TerrainWeightGrid,
} from './terrainWeightTools';
import type { PaintToolName, TerrainToolSettings } from './terrainTool';

interface TerrainLayerPanelProps {
    terrain: LevelObject;
    settings: TerrainToolSettings;
    onSettingsChange: (settings: TerrainToolSettings) => void;
    /** The brush settings, between the tool's and the layers' in the panel. */
    brush: React.ReactNode;
}

const PAINT_TOOLS: readonly { value: PaintToolName; label: string; hint: string }[] = [
    { value: 'paint', label: 'Paint', hint: 'Paint the layer on. Shift takes it away.' },
    { value: 'smooth', label: 'Smooth', hint: 'Soften where the layer meets the others.' },
    { value: 'flatten', label: 'Flatten', hint: 'Bring the layer to the amount under the first click.' },
    { value: 'noise', label: 'Noise', hint: 'Break the edges of the layer up in patches. Shift works the other way.' },
];

const Row: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
    <div className="flex min-h-[26px] items-center justify-between gap-2" title={hint}>
        <span className="truncate text-xs text-ink-2">{label}</span>
        <div className="w-[120px] shrink-0">{children}</div>
    </div>
);

const NumberRow: React.FC<{ label: string; unit: string; value: number; onChange: (value: number) => void; step?: number; min?: number; max?: number; hint?: string }> = ({
    label, unit, value, onChange, step = 1, min = -Infinity, max = Infinity, hint,
}) => (
    <Row label={label} hint={hint}>
        <ScrubbableInput label={unit} value={value} step={step} labelWidth="w-7" onChange={(next) => { if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next))); }} />
    </Row>
);

const NOT_CHOSEN = '';

/**
 * The Terrain tool's Paint tab: the paint tools, the terrain's texture layers, and the settings of the
 * layer being painted. Up to eight layers, each with its own maps.
 */
export const TerrainLayerPanel: React.FC<TerrainLayerPanelProps> = ({ terrain, settings, onSettingsChange, brush }) => {
    const { textures, models, updateLevelObject, snapshotHistory } = useScene();
    const { addNotification } = useNotification();
    const terrainData = terrain.terrainData;
    const paintState: TerrainPaintState | undefined = terrainData;
    const layers = useMemo(() => normalizeTerrainLayers(paintState?.textureLayers), [paintState?.textureLayers]);
    const splatPending = isTerrainSplatPending(paintState);
    const selected = Math.min(Math.max(0, settings.paintLayer), Math.max(0, layers.length - 1));
    const layer = layers[selected];
    const samples = terrainData ? terrainSamplesPerSide(terrainData.resolution) : 0;
    const change = (changes: Partial<TerrainToolSettings>) => onSettingsChange({ ...settings, ...changes });

    const textureOptions = useMemo(
        () => [{ label: 'None', value: NOT_CHOSEN }, ...[...textures].sort((a, b) => a.name.localeCompare(b.name)).map(texture => ({ label: texture.name, value: texture.id }))],
        [textures],
    );
    const textureById = useMemo(() => new Map(textures.map(texture => [texture.id, texture])), [textures]);
    const coverage = useMemo(
        () => layerCoverage(terrainData?.splat, terrainData?.splat2, samples * samples, layers.length),
        [terrainData?.splat, terrainData?.splat2, samples, layers.length],
    );

    // One undo snapshot per discrete edit, and one per scrub or typing gesture.
    const armedRef = useRef(true);
    const arm = useCallback(() => { armedRef.current = true; }, []);
    const canEdit = () => Boolean(terrainData) && editorSession.captureReady() !== null;

    const writeTerrain = (changes: Partial<TerrainData>) => {
        if (!terrainData) return;
        updateLevelObject(terrain.id, { terrainData: { ...terrainData, ...changes } as TerrainData });
    };

    const commitLayers = (next: TerrainTextureLayer[], extra: Partial<TerrainData> = {}) => {
        if (!canEdit()) return;
        snapshotHistory();
        armedRef.current = false;
        writeTerrain({ textureLayers: next, ...extra });
    };

    const scrubLayer = (changes: Partial<TerrainTextureLayer>) => {
        if (!canEdit() || !layer) return;
        if (armedRef.current) {
            snapshotHistory();
            armedRef.current = false;
        }
        writeTerrain({ textureLayers: layers.map((current, index) => (index === selected ? { ...current, ...changes } : current)) });
    };

    /** Works on a copy of the weights, then stores the result as one undo step. */
    const editWeights = (edit: (grid: TerrainWeightGrid) => void, count = layers.length, nextLayers?: TerrainTextureLayer[]) => {
        if (!terrainData || !canEdit() || splatPending) return;
        const length = samples * samples * 4;
        const weights = terrainData.splat?.length === length ? Uint8Array.from(terrainData.splat) : createDefaultTerrainSplat(samples, samples);
        const needsSecond = Math.max(count, layers.length) > 4 || terrainData.splat2?.length === length;
        const weights2 = needsSecond ? (terrainData.splat2?.length === length ? Uint8Array.from(terrainData.splat2) : new Uint8Array(length)) : null;
        edit({ columns: samples, rows: samples, width: terrainData.width, depth: terrainData.depth, weights, weights2, layerCount: count });
        snapshotHistory();
        const secondHasWeight = weights2?.some(value => value > 0);
        const next: TerrainData = { ...terrainData, splat: Array.from(weights) };
        if (secondHasWeight && weights2) next.splat2 = Array.from(weights2);
        else {
            delete next.splat2;
            delete next.splatmap2;
        }
        if (nextLayers) next.textureLayers = nextLayers;
        updateLevelObject(terrain.id, { terrainData: next });
    };

    const addLayer = () => {
        if (layers.length >= MAX_TERRAIN_LAYERS) return;
        commitLayers([...layers, {
            name: `Layer ${layers.length + 1}`,
            tiling: terrainData && terrainData.width > 0 ? terrainData.width / DEFAULT_TERRAIN_LAYER_TILE_SIZE : 16,
            tileSize: DEFAULT_TERRAIN_LAYER_TILE_SIZE,
            variation: 0.3,
        }]);
        change({ paintLayer: layers.length });
    };

    const removeLayer = () => {
        if (!layer || splatPending) return;
        const next = layers.filter((_, index) => index !== selected);
        if (layers.length <= 1 || !terrainData?.splat) {
            commitLayers(next);
        } else {
            editWeights(grid => removeLayerWeights(grid, selected), layers.length, next);
        }
        change({ paintLayer: Math.max(0, Math.min(selected, next.length - 1)) });
    };

    const moveLayer = (direction: -1 | 1) => {
        const other = selected + direction;
        if (!layer || other < 0 || other >= layers.length || splatPending) return;
        const next = layers.slice();
        next[selected] = layers[other];
        next[other] = layers[selected];
        editWeights(grid => swapLayerWeights(grid, selected, other), layers.length, next);
        change({ paintLayer: other });
    };

    const importFile = useRef<HTMLInputElement>(null);

    const importWeights = async (file: File) => {
        try {
            const image = await decodeHeightmapFile(file);
            const values = resampleGrid(image.values, image.width, image.height, samples, samples);
            editWeights(grid => setLayerFromValues(grid, selected, values));
        } catch (error) {
            addNotification({ message: `The weight map could not be read (${error instanceof Error ? error.message : 'unknown error'}).`, type: 'error' });
        }
    };

    const exportWeights = async () => {
        if (!terrainData || !layer) return;
        const length = samples * samples * 4;
        const weights = terrainData.splat?.length === length ? Uint8Array.from(terrainData.splat) : createDefaultTerrainSplat(samples, samples);
        const weights2 = terrainData.splat2?.length === length ? Uint8Array.from(terrainData.splat2) : null;
        const values = layerValues({ columns: samples, rows: samples, width: terrainData.width, depth: terrainData.depth, weights, weights2, layerCount: layers.length }, selected);
        const bytes = await encodeWeightmapPng({ width: samples, height: samples, values });
        downloadBytes(bytes, `${terrain.name.replace(/[^\w-]+/g, '_')}_${(layer.name ?? `layer_${selected + 1}`).replace(/[^\w-]+/g, '_')}.png`, 'image/png');
    };

    const [rule, setRule] = useState({ slopeMin: 30, slopeMax: 90, heightMin: -10000, heightMax: 10000, softness: 6 });
    const paintByRule = () => {
        const heights = terrainData?.heights;
        if (!heights || heights.length !== samples * samples) {
            addNotification({ message: 'Sculpt the terrain first: it has no slopes to paint by yet.', type: 'info' });
            return;
        }
        editWeights(grid => paintLayerByRule(grid, heights, selected, {
            ...rule,
            scaleX: terrain.scale[0], scaleY: terrain.scale[2], scaleZ: terrain.scale[1], originY: terrain.position[1],
        }));
    };

    const toolHint = PAINT_TOOLS.find(tool => tool.value === settings.paintTool)?.hint;

    return (
        <div onPointerDownCapture={arm} onFocusCapture={arm}>
            <Section title="Tool">
                <Segmented value={settings.paintTool} options={PAINT_TOOLS} label="Paint tool" onChange={(paintTool) => change({ paintTool })} className="w-full" />
                <p className="mt-2 text-2xs leading-relaxed text-ink-3">{toolHint}</p>
                <div className="mt-1 space-y-1">
                    <NumberRow label="Strength" unit="%" value={Math.round(settings.strength * 100)} min={1} max={100} hint="How fast the tool works. Keys: , and ." onChange={(value) => change({ strength: value / 100 })} />
                    {settings.paintTool === 'paint' && (
                        <NumberRow label="Up to" unit="%" value={Math.round(settings.paintTarget * 100)} min={1} max={100} hint="How much of this layer painting builds up to" onChange={(value) => change({ paintTarget: value / 100 })} />
                    )}
                    {settings.paintTool === 'smooth' && (
                        <NumberRow label="Reach" unit="cells" value={settings.smoothKernel} min={1} max={16} onChange={(value) => change({ smoothKernel: Math.round(value) })} />
                    )}
                    {settings.paintTool === 'noise' && (
                        <NumberRow label="Patch size" unit="m" value={settings.paintNoiseScale} step={0.5} min={0.1} onChange={(paintNoiseScale) => change({ paintNoiseScale })} />
                    )}
                </div>
            </Section>

            {brush}

            <Section
                title={`Layers (${layers.length} of ${MAX_TERRAIN_LAYERS})`}
                actions={(
                    <Button size="sm" disabled={layers.length >= MAX_TERRAIN_LAYERS || !terrainData} onClick={addLayer} title="Add a layer"><Plus size={11} /> Add</Button>
                )}
            >
                {layers.length === 0 && (
                    <p className="text-2xs leading-relaxed text-ink-3">
                        No layers: the terrain shades itself as grass, earth and rock by slope. Add a layer to texture it, then more to paint over it.
                    </p>
                )}
                {splatPending && layers.length > 0 && (
                    <p className="pb-1.5 text-2xs leading-relaxed text-amber-400/90">Painted weights are loading; painting is unavailable until they arrive.</p>
                )}
                <div className="space-y-1">
                    {layers.map((entry, index) => {
                        const texture = entry.textureId ? textureById.get(entry.textureId) : undefined;
                        const active = selected === index;
                        return (
                            <button
                                key={index}
                                type="button"
                                aria-pressed={active}
                                onClick={() => change({ paintLayer: index })}
                                className={`flex w-full items-center gap-2 rounded border p-1 text-left transition-colors duration-75 ${active ? 'border-accent/70 bg-accent/15' : 'border-line hover:bg-gray-750'}`}
                            >
                                <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded bg-gray-700">
                                    {texture
                                        ? <img src={texture.url} alt="" className="h-full w-full object-cover" draggable={false} />
                                        : <ImageOff size={13} className="text-ink-3" />}
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-xs text-ink">{entry.name || texture?.name || `Layer ${index + 1}`}</span>
                                    <span className="block truncate text-[10px] text-ink-3">{index === 0 ? 'Base, ' : ''}{Math.round((coverage[index] ?? 0) * 100)}% of the ground</span>
                                </span>
                            </button>
                        );
                    })}
                </div>
            </Section>

            {layer && (
                <Section
                    title={layer.name || `Layer ${selected + 1}`}
                    actions={(
                        <div className="flex gap-0.5">
                            <Button size="sm" variant="ghost" disabled={selected === 0 || splatPending} title="Move up" onClick={() => moveLayer(-1)}><ArrowUp size={11} /></Button>
                            <Button size="sm" variant="ghost" disabled={selected === layers.length - 1 || splatPending} title="Move down" onClick={() => moveLayer(1)}><ArrowDown size={11} /></Button>
                            <Button size="sm" variant="danger" disabled={splatPending} title="Remove this layer: its paint goes to the base layer" onClick={removeLayer}><Trash2 size={11} /></Button>
                        </div>
                    )}
                >
                    <div className="space-y-1">
                        <Row label="Name">
                            <input
                                value={layer.name ?? ''}
                                placeholder={`Layer ${selected + 1}`}
                                onChange={(event) => scrubLayer({ name: event.target.value.slice(0, 64) })}
                                className="h-6 w-full rounded border border-line bg-well px-2 text-xs text-ink focus:border-accent/70 focus:outline-none"
                            />
                        </Row>
                        <Row label="Colour" hint="Its colour texture">
                            <Select value={layer.textureId ?? NOT_CHOSEN} options={textureOptions} onChange={(value: string) => commitLayers(layers.map((current, index) => {
                                if (index !== selected) return current;
                                const { textureId: _gone, ...rest } = current;
                                return value ? { ...rest, textureId: value } : rest;
                            }))} />
                        </Row>
                        <Row label="Normal" hint="Its normal map: the bumps light catches">
                            <Select value={layer.normalTextureId ?? NOT_CHOSEN} options={textureOptions} onChange={(value: string) => commitLayers(layers.map((current, index) => {
                                if (index !== selected) return current;
                                const { normalTextureId: _gone, ...rest } = current;
                                return value ? { ...rest, normalTextureId: value } : rest;
                            }))} />
                        </Row>
                        <Row label="Roughness" hint="Its roughness map">
                            <Select value={layer.roughnessTextureId ?? NOT_CHOSEN} options={textureOptions} onChange={(value: string) => commitLayers(layers.map((current, index) => {
                                if (index !== selected) return current;
                                const { roughnessTextureId: _gone, ...rest } = current;
                                return value ? { ...rest, roughnessTextureId: value } : rest;
                            }))} />
                        </Row>
                        <Row label="Height" hint="Its height map: with Height blend, the taller of two layers shows first where they meet">
                            <Select value={layer.heightTextureId ?? NOT_CHOSEN} options={textureOptions} onChange={(value: string) => commitLayers(layers.map((current, index) => {
                                if (index !== selected) return current;
                                const { heightTextureId: _gone, ...rest } = current;
                                return value ? { ...rest, heightTextureId: value } : rest;
                            }))} />
                        </Row>
                        <NumberRow
                            label="Tile size" unit="m" step={0.5} min={0.1} max={10000}
                            value={terrainLayerTileSize(layer, (terrainData?.width ?? 0) * terrain.scale[0])}
                            hint="How many metres one repeat of its textures covers"
                            onChange={(tileSize) => scrubLayer({ tileSize })}
                        />
                        <NumberRow label="Turn" unit="°" step={5} value={layer.rotation ?? 0} onChange={(rotation) => scrubLayer({ rotation })} />
                        <Row label="Tint">
                            <input
                                type="color"
                                value={layer.tint ?? '#ffffff'}
                                onChange={(event) => scrubLayer({ tint: event.target.value })}
                                className="h-6 w-full cursor-pointer rounded border border-line bg-well"
                            />
                        </Row>
                        <NumberRow label="Roughness" unit="%" min={0} max={100} value={Math.round((layer.roughness ?? 0.9) * 100)} hint="How dull it is; with a roughness map, how far that map goes" onChange={(value) => scrubLayer({ roughness: value / 100 })} />
                        <NumberRow label="Normal strength" unit="%" min={0} max={300} step={5} value={Math.round((layer.normalStrength ?? 1) * 100)} onChange={(value) => scrubLayer({ normalStrength: value / 100 })} />
                        <NumberRow label="Height blend" unit="%" min={0} max={300} step={5} value={Math.round((layer.heightContrast ?? 0) * 100)} hint="0 blends layers evenly. Higher lets its height map decide where it shows, so stones show through sand before the sand covers them" onChange={(value) => scrubLayer({ heightContrast: value / 100 })} />
                        <NumberRow label="Variation" unit="%" min={0} max={100} value={Math.round((layer.variation ?? 0) * 100)} hint="Broad, soft changes of colour that hide the repeat of the texture" onChange={(value) => scrubLayer({ variation: value / 100 })} />
                        <label className="flex min-h-[26px] cursor-pointer items-center justify-between gap-2" title="Also project its textures from the sides on steep ground, so they do not stretch down cliffs. Costs more where the ground is steep">
                            <span className="truncate text-xs text-ink-2">Project onto cliffs</span>
                            <input type="checkbox" checked={Boolean(layer.cliffProjection)} onChange={(event) => commitLayers(layers.map((current, index) => (index === selected ? { ...current, cliffProjection: event.target.checked } : current)))} className="h-3.5 w-3.5" />
                        </label>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-1">
                        <Button size="md" disabled={splatPending} onClick={() => editWeights(grid => fillLayer(grid, selected))} title="Paint this layer over the whole terrain"><PaintBucket size={12} /> Fill</Button>
                        <Button size="md" disabled={splatPending} onClick={() => editWeights(grid => clearLayer(grid, selected))} title="Take this layer off the whole terrain"><Eraser size={12} /> Clear</Button>
                        <Button size="md" disabled={splatPending} onClick={() => importFile.current?.click()} title="Set this layer from an 8 or 16 bit grey PNG"><Upload size={12} /> Import</Button>
                        <Button size="md" onClick={() => void exportWeights()} title="Save this layer's weights as a grey PNG"><Download size={12} /> Export</Button>
                    </div>
                    <input
                        ref={importFile}
                        type="file"
                        accept=".png,.r16,.raw"
                        data-terrain-weights="true"
                        className="hidden"
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = '';
                            if (file) void importWeights(file);
                        }}
                    />
                </Section>
            )}

            {layer && (
                <Section title="Grass on This Layer">
                    <p className="pb-1.5 text-2xs leading-relaxed text-ink-3">Grows by itself wherever this layer is painted, around the camera. Nothing is stored: repaint the layer and the grass follows.</p>
                    <div className="space-y-2">
                        {(layer.grass ?? []).map((grass, index) => {
                            const write = (changes: Partial<TerrainGrassVariety>) => scrubLayer({ grass: (layer.grass ?? []).map((entry, at) => (at === index ? { ...entry, ...changes } : entry)) });
                            return (
                                <div key={index} className="rounded border border-line p-1.5">
                                    <div className="flex items-center gap-1.5 pb-1">
                                        <span className="flex-1 truncate text-xs text-ink">{models.find(model => model.id === grass.modelId)?.name ?? 'Missing model'}</span>
                                        <Button size="sm" variant="ghost" title="Stop growing this" onClick={() => commitLayers(layers.map((current, at) => (at === selected ? { ...current, grass: (current.grass ?? []).filter((_, kept) => kept !== index) } : current)))}><Trash2 size={11} /></Button>
                                    </div>
                                    <div className="space-y-1">
                                        <NumberRow label="Density" unit="/m²" step={0.5} min={0} max={64} value={grass.density} hint="Copies per square metre" onChange={(density) => write({ density })} />
                                        <Row label="Scale">
                                            <div className="grid grid-cols-2 gap-1">
                                                <ScrubbableInput label="" labelWidth="w-0" value={grass.scale[0]} step={0.05} onChange={(value) => { if (Number.isFinite(value) && value > 0) write({ scale: [value, Math.max(value, grass.scale[1])] }); }} />
                                                <ScrubbableInput label="" labelWidth="w-0" value={grass.scale[1]} step={0.05} onChange={(value) => { if (Number.isFinite(value) && value > 0) write({ scale: [Math.min(value, grass.scale[0]), value] }); }} />
                                            </div>
                                        </Row>
                                        <NumberRow label="Thins from" unit="m" step={5} min={0} max={2000} value={grass.fadeStart} hint="Distance from the camera where it starts to thin out" onChange={(fadeStart) => write({ fadeStart: Math.min(fadeStart, grass.fadeEnd) })} />
                                        <NumberRow label="Gone at" unit="m" step={5} min={1} max={2000} value={grass.fadeEnd} hint="Distance where none is left. Further costs a lot more" onChange={(fadeEnd) => write({ fadeEnd, fadeStart: Math.min(grass.fadeStart, fadeEnd) })} />
                                        <label className="flex min-h-[26px] cursor-pointer items-center justify-between gap-2"><span className="truncate text-xs text-ink-2">Lean with the ground</span><input type="checkbox" checked={grass.alignToSurface !== false} onChange={(event) => write({ alignToSurface: event.target.checked ? undefined : false })} className="h-3.5 w-3.5" /></label>
                                        <label className="flex min-h-[26px] cursor-pointer items-center justify-between gap-2"><span className="truncate text-xs text-ink-2">Random turn</span><input type="checkbox" checked={grass.randomRotation !== false} onChange={(event) => write({ randomRotation: event.target.checked ? undefined : false })} className="h-3.5 w-3.5" /></label>
                                        <label className="flex min-h-[26px] cursor-pointer items-center justify-between gap-2" title="Costs a lot for small plants"><span className="truncate text-xs text-ink-2">Cast shadows</span><input type="checkbox" checked={grass.castShadow === true} onChange={(event) => write({ castShadow: event.target.checked ? true : undefined })} className="h-3.5 w-3.5" /></label>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    {(layer.grass?.length ?? 0) < MAX_TERRAIN_GRASS_VARIETIES && (
                        <div className="mt-1.5">
                            <Select
                                value=""
                                placeholder="Grow a model..."
                                options={[...models].sort((a, b) => a.name.localeCompare(b.name)).map(model => ({ label: model.name, value: model.id }))}
                                onChange={(modelId: string) => { if (modelId) commitLayers(layers.map((current, index) => (index === selected ? { ...current, grass: [...(current.grass ?? []), { ...DEFAULT_TERRAIN_GRASS, modelId }] } : current))); }}
                            />
                        </div>
                    )}
                </Section>
            )}

            {layer && (
                <Section title="Paint by Slope and Height">
                    <div className="space-y-1">
                        <Row label="Slope" hint="Degrees of slope the layer goes on">
                            <div className="grid grid-cols-2 gap-1">
                                <ScrubbableInput label="" labelWidth="w-0" value={rule.slopeMin} step={1} onChange={(slopeMin) => setRule(current => ({ ...current, slopeMin }))} />
                                <ScrubbableInput label="" labelWidth="w-0" value={rule.slopeMax} step={1} onChange={(slopeMax) => setRule(current => ({ ...current, slopeMax }))} />
                            </div>
                        </Row>
                        <Row label="Height" hint="World heights the layer goes between">
                            <div className="grid grid-cols-2 gap-1">
                                <ScrubbableInput label="" labelWidth="w-0" value={rule.heightMin} step={1} onChange={(heightMin) => setRule(current => ({ ...current, heightMin }))} />
                                <ScrubbableInput label="" labelWidth="w-0" value={rule.heightMax} step={1} onChange={(heightMax) => setRule(current => ({ ...current, heightMax }))} />
                            </div>
                        </Row>
                        <NumberRow label="Soft edge" unit="" min={0} max={45} value={rule.softness} hint="How gradually it starts and stops" onChange={(softness) => setRule(current => ({ ...current, softness }))} />
                        <Button size="md" className="mt-1 w-full" disabled={splatPending} onClick={paintByRule}><Wand2 size={12} /> Paint This Layer</Button>
                    </div>
                </Section>
            )}
        </div>
    );
};
