import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    Activity, Box, ClipboardCopy, Download, Droplets, FlipHorizontal2, Hammer, Layers, Minus, Mountain, Plus, Rows3, Trash2, TrendingUp, Upload, Waves, Wind, CircleDashed, Scaling,
} from 'lucide-react';
import { useScene } from '../../../context/SceneContext';
import { useNotification } from '../../../context/NotificationContext';
import { LevelObject, TerrainData } from '../../../types';
import { editorSession } from '../../../utils/editorSession';
import { Button, Section } from '../../UI/kit';
import { Select } from '../../UI/Select';
import { ScrubbableInput } from '../../UI/Properties/ScrubbableInput';
import { TerrainLayerPanel } from './TerrainLayerPanel';
import {
    decodeHeightmapFile, downloadBytes, encodeHeightmapPng, encodeHeightmapRaw, heightRangeFromName, resampleGrid,
} from './terrainHeightmapFile';
import {
    SCULPT_TOOL_LABELS, terrainToolStore, useTerrainToolState,
    type SculptToolName, type TerrainTab, type TerrainToolSettings,
} from './terrainTool';
import type { TerrainBrushFalloff, TerrainBrushShape } from './terrainBrush';
import { terrainSamplesPerSide } from '../../../utils/terrainHeightfieldCodec';

interface TerrainPanelProps {
    settings: TerrainToolSettings;
    onSettingsChange: (settings: TerrainToolSettings) => void;
    selectedObjectId: string | null;
    onSelectTerrain: (id: string | null) => void;
}

const RESOLUTIONS = [64, 128, 256, 512, 1024];

const SCULPT_TOOLS: { tool: SculptToolName; icon: React.ReactNode; hint: string }[] = [
    { tool: 'sculpt', icon: <Mountain size={14} />, hint: 'Hold the left button to raise the ground. Hold Shift to lower it.' },
    { tool: 'smooth', icon: <Waves size={14} />, hint: 'Hold to even out bumps. Larger Reach smooths broader shapes.' },
    { tool: 'flatten', icon: <Minus size={14} />, hint: 'Levels to the height under the first click. Ctrl-click sets a fixed height.' },
    { tool: 'ramp', icon: <TrendingUp size={14} />, hint: 'Click the bottom and the top of the ramp, then build it.' },
    { tool: 'erosion', icon: <Wind size={14} />, hint: 'Hold to let steep ground slump, as weathering does.' },
    { tool: 'hydro', icon: <Droplets size={14} />, hint: 'Hold to rain on the ground: water cuts channels and drops silt.' },
    { tool: 'noise', icon: <Activity size={14} />, hint: 'Hold to roughen the ground. Shift works the other way.' },
    { tool: 'terrace', icon: <Rows3 size={14} />, hint: 'Hold to cut the ground into steps.' },
    { tool: 'holes', icon: <CircleDashed size={14} />, hint: 'Hold to cut holes in the ground for caves and tunnels. Shift fills them.' },
    { tool: 'mirror', icon: <FlipHorizontal2 size={14} />, hint: 'Copies one half of the terrain onto the other, for symmetric maps.' },
    { tool: 'copy', icon: <ClipboardCopy size={14} />, hint: 'Drag a box on the ground to copy it, then click to paste it anywhere.' },
];

const FALLOFFS: { label: string; value: TerrainBrushFalloff }[] = [
    { label: 'Smooth', value: 'smooth' },
    { label: 'Linear', value: 'linear' },
    { label: 'Spherical', value: 'spherical' },
    { label: 'Tip', value: 'tip' },
];

const SHAPES: { label: string; value: TerrainBrushShape; hint: string }[] = [
    { label: 'Circle', value: 'circle', hint: 'A round brush' },
    { label: 'Stamp', value: 'stamp', hint: 'A picture stretched across the brush' },
    { label: 'Pattern', value: 'pattern', hint: 'A picture tiled over the ground, seen through the brush' },
];

const THREE_WAY = [
    { label: 'Both', value: 'both' },
    { label: 'Raise', value: 'raise' },
    { label: 'Lower', value: 'lower' },
] as const;

const Row: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
    <div className="flex min-h-[26px] items-center justify-between gap-2" title={hint}>
        <span className="truncate text-xs text-ink-2">{label}</span>
        <div className="w-[104px] shrink-0">{children}</div>
    </div>
);

const NumberRow: React.FC<{ label: string; unit: string; value: number; onChange: (value: number) => void; step?: number; min?: number; max?: number; hint?: string }> = ({
    label, unit, value, onChange, step = 1, min = -Infinity, max = Infinity, hint,
}) => (
    <Row label={label} hint={hint}>
        <ScrubbableInput label={unit} value={value} step={step} labelWidth="w-7" onChange={(next) => { if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next))); }} />
    </Row>
);

const Toggle: React.FC<{ label: string; checked: boolean; onChange: (checked: boolean) => void; hint?: string }> = ({ label, checked, onChange, hint }) => (
    <label className="flex min-h-[26px] cursor-pointer items-center justify-between gap-2" title={hint}>
        <span className="truncate text-xs text-ink-2">{label}</span>
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-3.5 w-3.5 accent-[var(--accent,#e8842c)]" />
    </label>
);

/** Size, falloff and shape: the brush every tool here shares. */
const BrushSection: React.FC<{ settings: TerrainToolSettings; change: (changes: Partial<TerrainToolSettings>) => void }> = ({ settings, change }) => {
    const { textures } = useScene();
    const pictures = useMemo(() => [...textures].sort((a, b) => a.name.localeCompare(b.name)).map(texture => ({ label: texture.name, value: texture.id })), [textures]);
    return (
        <Section title="Brush">
            <div className="space-y-1">
                <NumberRow label="Size" unit="m" value={settings.radius * 2} step={1} min={0.5} max={4000} hint="Across the brush, in metres. Keys: [ and ]" onChange={(value) => change({ radius: value / 2 })} />
                <NumberRow label="Falloff" unit="%" value={Math.round(settings.falloff * 100)} step={1} min={0} max={100} hint="How much of the brush fades towards its edge. Keys: Shift+[ and Shift+]" onChange={(value) => change({ falloff: value / 100 })} />
                <Row label="Falloff shape">
                    <Select value={settings.falloffType} options={FALLOFFS} onChange={(value: TerrainBrushFalloff) => change({ falloffType: value })} />
                </Row>
                <Row label="Shape">
                    <Select value={settings.shape} options={SHAPES} onChange={(value: TerrainBrushShape) => change({ shape: value })} />
                </Row>
                {settings.shape !== 'circle' && (
                    <>
                        <Row label="Picture" hint="Its brightness sets the brush's strength">
                            <Select value={settings.pictureTextureId ?? ''} options={[{ label: 'Choose...', value: '' }, ...pictures]} onChange={(value: string) => change({ pictureTextureId: value || undefined })} />
                        </Row>
                        <NumberRow label="Turn" unit="°" value={settings.pictureRotation} step={5} onChange={(value) => change({ pictureRotation: value })} />
                        {settings.shape === 'pattern' && (
                            <NumberRow label="Tile size" unit="m" value={settings.patternSize} step={1} min={0.5} max={4000} onChange={(value) => change({ patternSize: value })} />
                        )}
                    </>
                )}
            </div>
        </Section>
    );
};

const ToolOptions: React.FC<{ settings: TerrainToolSettings; change: (changes: Partial<TerrainToolSettings>) => void; terrain: LevelObject | undefined }> = ({ settings, change, terrain }) => {
    const toolState = useTerrainToolState();
    const strength = (
        <NumberRow label="Strength" unit="%" value={Math.round(settings.strength * 100)} step={1} min={1} max={100} hint="How fast the tool works. Keys: , and ." onChange={(value) => change({ strength: value / 100 })} />
    );
    switch (settings.tool) {
        case 'sculpt':
        case 'holes':
            return settings.tool === 'sculpt' ? strength : null;
        case 'smooth':
            return (
                <>
                    {strength}
                    <NumberRow label="Reach" unit="cells" value={settings.smoothKernel} min={1} max={32} hint="How many grid cells each way it averages over" onChange={(value) => change({ smoothKernel: Math.round(value) })} />
                </>
            );
        case 'flatten':
            return (
                <>
                    {strength}
                    <Row label="Direction" hint="Both levels to the height; Raise only fills up to it; Lower only cuts down to it">
                        <Select value={settings.flattenMode} options={[...THREE_WAY]} onChange={(value: TerrainToolSettings['flattenMode']) => change({ flattenMode: value })} />
                    </Row>
                    <Toggle label="Fixed height" checked={settings.flattenUseHeight} hint="Level to a height you set instead of the height under the first click" onChange={(flattenUseHeight) => change({ flattenUseHeight })} />
                    {settings.flattenUseHeight && (
                        <NumberRow label="Height" unit="m" value={settings.flattenHeight} step={0.5} hint="Ctrl-click the ground to take its height" onChange={(flattenHeight) => change({ flattenHeight })} />
                    )}
                    <Toggle label="Follow the slope" checked={settings.flattenAlongSlope} hint="Level along the slope under the first click, for roads and ramps on a hillside" onChange={(flattenAlongSlope) => change({ flattenAlongSlope })} />
                    {!settings.flattenUseHeight && (
                        <Toggle label="Keep sampling" checked={settings.flattenEachMoment} hint="Take the height under the brush again all through the stroke" onChange={(flattenEachMoment) => change({ flattenEachMoment })} />
                    )}
                </>
            );
        case 'ramp':
            return (
                <>
                    <NumberRow label="Width" unit="m" value={settings.rampWidth} step={0.5} min={0.1} onChange={(rampWidth) => change({ rampWidth })} />
                    <NumberRow label="Side blend" unit="%" value={Math.round(settings.rampSideFalloff * 100)} min={0} max={100} hint="How far the sides blend back into the ground" onChange={(value) => change({ rampSideFalloff: value / 100 })} />
                    <div className="flex gap-1.5 pt-1">
                        <Button variant="primary" size="md" className="flex-1" disabled={!toolState.rampStart || !toolState.rampEnd} onClick={() => terrainToolStore.command({ kind: 'ramp' })}>Build Ramp</Button>
                        <Button size="md" disabled={!toolState.rampStart} onClick={() => terrainToolStore.set({ rampStart: null, rampEnd: null })}>Reset</Button>
                    </div>
                    <p className="pt-1 text-2xs text-ink-3">{!toolState.rampStart ? 'Click where it starts.' : !toolState.rampEnd ? 'Click where it ends.' : 'Ready to build.'}</p>
                </>
            );
        case 'erosion':
            return (
                <>
                    {strength}
                    <NumberRow label="Steepest" unit="m" value={settings.erosionThreshold} step={0.01} min={0} hint="How much higher than its neighbour a point can stand before it slumps" onChange={(erosionThreshold) => change({ erosionThreshold })} />
                    <NumberRow label="Moves up to" unit="m" value={settings.erosionThickness} step={0.01} min={0.001} hint="How much can slump in one pass" onChange={(erosionThickness) => change({ erosionThickness })} />
                    <NumberRow label="Passes" unit="" value={settings.erosionIterations} min={1} max={32} hint="More passes wear it faster and cost more" onChange={(value) => change({ erosionIterations: Math.round(value) })} />
                </>
            );
        case 'hydro':
            return (
                <>
                    {strength}
                    <NumberRow label="Rain" unit="" value={settings.hydroRain} step={0.1} min={0.01} max={20} onChange={(hydroRain) => change({ hydroRain })} />
                    <NumberRow label="Silt carried" unit="" value={settings.hydroSediment} step={0.05} min={0.01} max={8} hint="How much the water can carry: more cuts deeper" onChange={(hydroSediment) => change({ hydroSediment })} />
                    <NumberRow label="Passes" unit="" value={settings.hydroIterations} min={1} max={64} onChange={(value) => change({ hydroIterations: Math.round(value) })} />
                </>
            );
        case 'noise':
            return (
                <>
                    {strength}
                    <NumberRow label="Scale" unit="m" value={settings.noiseScale} step={0.5} min={0.1} hint="How broad the bumps are" onChange={(noiseScale) => change({ noiseScale })} />
                    <Row label="Direction">
                        <Select value={settings.noiseMode} options={[...THREE_WAY]} onChange={(value: TerrainToolSettings['noiseMode']) => change({ noiseMode: value })} />
                    </Row>
                </>
            );
        case 'terrace':
            return (
                <>
                    {strength}
                    <NumberRow label="Step height" unit="m" value={settings.terraceHeight} step={0.5} min={0.1} onChange={(terraceHeight) => change({ terraceHeight })} />
                    <NumberRow label="Sharpness" unit="%" value={Math.round(settings.terraceSharpness * 100)} min={0} max={100} onChange={(value) => change({ terraceSharpness: value / 100 })} />
                </>
            );
        case 'mirror':
            return (
                <>
                    <Row label="Copy">
                        <Select
                            value={settings.mirrorOperation}
                            options={[
                                { label: '-X onto +X', value: 'x-to-plus' },
                                { label: '+X onto -X', value: 'x-to-minus' },
                                { label: '-Z onto +Z', value: 'y-to-plus' },
                                { label: '+Z onto -Z', value: 'y-to-minus' },
                                { label: 'Turned, along X', value: 'x-turn' },
                                { label: 'Turned, along Z', value: 'y-turn' },
                            ]}
                            onChange={(value: TerrainToolSettings['mirrorOperation']) => change({ mirrorOperation: value })}
                        />
                    </Row>
                    <NumberRow label="Mirror line" unit="m" value={settings.mirrorOffset} step={1} hint="How far the line is from the terrain's middle" onChange={(mirrorOffset) => change({ mirrorOffset })} />
                    <NumberRow label="Blend" unit="m" value={settings.mirrorBlend} step={0.5} min={0} hint="How far either side of the line the two halves ease into each other" onChange={(mirrorBlend) => change({ mirrorBlend })} />
                    <div className="pt-1">
                        <Button variant="primary" size="md" className="w-full" disabled={!terrain} onClick={() => { if (terrain) terrainToolStore.command({ kind: 'mirror', terrainId: terrain.id }); }}>Mirror Terrain</Button>
                    </div>
                </>
            );
        case 'copy':
            return (
                <>
                    <Row label="Paste">
                        <Select value={settings.pasteMode} options={[...THREE_WAY]} onChange={(value: TerrainToolSettings['pasteMode']) => change({ pasteMode: value })} />
                    </Row>
                    <NumberRow label="Turn" unit="°" value={settings.pasteRotation} step={5} onChange={(pasteRotation) => change({ pasteRotation })} />
                    <NumberRow label="Edge blend" unit="%" value={Math.round(settings.pasteEdge * 100)} min={0} max={50} onChange={(value) => change({ pasteEdge: value / 100 })} />
                    <Toggle label="Keep its height" checked={settings.pasteKeepHeight} hint="Off: its lowest point sits on the ground under the click" onChange={(pasteKeepHeight) => change({ pasteKeepHeight })} />
                    <div className="flex gap-1.5 pt-1">
                        <Button size="md" className="flex-1" variant={toolState.pasting ? 'primary' : 'default'} disabled={!toolState.clip} onClick={() => terrainToolStore.set({ pasting: !toolState.pasting })}>
                            {toolState.pasting ? 'Pasting: click the ground' : 'Paste'}
                        </Button>
                    </div>
                    <p className="pt-1 text-2xs text-ink-3">
                        {toolState.clip ? `Copied ${Math.round((toolState.clip.columns - 1) * toolState.clip.cellX)} by ${Math.round((toolState.clip.rows - 1) * toolState.clip.cellY)} m.` : 'Nothing copied yet: drag a box on the ground.'}
                    </p>
                </>
            );
        default:
            return null;
    }
};

const SculptTab: React.FC<{ settings: TerrainToolSettings; change: (changes: Partial<TerrainToolSettings>) => void; terrain: LevelObject | undefined }> = ({ settings, change, terrain }) => {
    const current = SCULPT_TOOLS.find(entry => entry.tool === settings.tool) ?? SCULPT_TOOLS[0];
    const options = <ToolOptions settings={settings} change={change} terrain={terrain} />;
    const usesBrush = settings.tool !== 'ramp' && settings.tool !== 'mirror' && !(settings.tool === 'copy');
    return (
        <>
            <Section title="Tool">
                <div className="grid grid-cols-4 gap-1">
                    {SCULPT_TOOLS.map(({ tool, icon }) => (
                        <button
                            key={tool}
                            type="button"
                            title={SCULPT_TOOL_LABELS[tool]}
                            aria-pressed={settings.tool === tool}
                            onClick={() => change({ tool })}
                            className={`flex h-[46px] flex-col items-center justify-center gap-1 rounded border px-0.5 transition-colors duration-75 ${settings.tool === tool ? 'border-accent/70 bg-accent/15 text-ink' : 'border-line bg-gray-800/60 text-ink-2 hover:bg-gray-750 hover:text-ink'}`}
                        >
                            {icon}
                            <span className="w-full truncate text-center text-[10px] leading-none">{SCULPT_TOOL_LABELS[tool].replace(' Erosion', '').replace(' / Paste', '')}</span>
                        </button>
                    ))}
                </div>
                <p className="mt-2 text-2xs leading-relaxed text-ink-3">{current.hint}</p>
            </Section>
            {settings.tool !== 'holes' && (
                <Section title={`${SCULPT_TOOL_LABELS[settings.tool]} Settings`}>
                    <div className="space-y-1">{options}</div>
                </Section>
            )}
            {usesBrush && <BrushSection settings={settings} change={change} />}
        </>
    );
};

/** A terrain's size and heights: what it is, and resizing and exchanging it with other tools. */
const ManageTab: React.FC<{
    terrains: LevelObject[];
    terrain: LevelObject | undefined;
    onSelect: (id: string) => void;
    onCreated: (id: string) => void;
}> = ({ terrains, terrain, onSelect, onCreated }) => {
    const { addLevelObject, updateLevelObject, removeLevelObject, snapshotHistory } = useScene();
    const { addNotification } = useNotification();
    const [width, setWidth] = useState(256);
    const [depth, setDepth] = useState(256);
    const [resolution, setResolution] = useState(256);
    const [positionX, setPositionX] = useState(0);
    const [positionZ, setPositionZ] = useState(0);
    const [low, setLow] = useState(-50);
    const [high, setHigh] = useState(50);
    const [resize, setResize] = useState<number | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const fileTarget = useRef<'new' | 'existing'>('existing');

    // A new terrain goes beside the last one, so their edges meet.
    useEffect(() => {
        if (terrains.length === 0) {
            setPositionX(0);
            setPositionZ(0);
            return;
        }
        const last = terrains[terrains.length - 1];
        setPositionX(last.position[0] + ((last.terrainData?.width ?? 0) * last.scale[0] + width) / 2);
        setPositionZ(last.position[2]);
    }, [terrains.length, width]);

    const data = terrain?.terrainData;
    const samples = data ? terrainSamplesPerSide(data.resolution) : 0;
    const cell = data ? data.width / data.resolution : 0;
    const canEdit = () => editorSession.captureReady() !== null;

    const createFrom = async (heights: number[] | undefined) => {
        if (!canEdit()) return;
        const id = await addLevelObject('', [positionX, 0, positionZ], [0, 0, 0], [1, 1, 1], 'terrain', {
            resolution, width, depth, heights: heights ?? [],
        });
        if (id) onCreated(id);
    };

    const handleFile = async (file: File) => {
        try {
            const image = await decodeHeightmapFile(file);
            const named = heightRangeFromName(file.name);
            const rangeLow = named?.low ?? low;
            const rangeHigh = named?.high ?? high;
            if (named) {
                setLow(named.low);
                setHigh(named.high);
            }
            const target = fileTarget.current === 'existing' ? terrain : undefined;
            const grid = target?.terrainData ? target.terrainData.resolution : resolution;
            const columns = terrainSamplesPerSide(grid);
            const resampled = resampleGrid(image.values, image.width, image.height, columns, columns);
            const heights = Array.from(resampled, value => rangeLow + value * (rangeHigh - rangeLow));
            if (target?.terrainData) {
                if (!canEdit()) return;
                snapshotHistory();
                updateLevelObject(target.id, { terrainData: { ...target.terrainData, heights } });
            } else {
                await createFrom(heights);
            }
            addNotification({ message: `Heightmap read: ${image.width} by ${image.height}, ${rangeLow} to ${rangeHigh} m.`, type: 'success' });
        } catch (error) {
            addNotification({ message: `The heightmap could not be read (${error instanceof Error ? error.message : 'unknown error'}).`, type: 'error' });
        }
    };

    const exportHeights = async (raw: boolean) => {
        const heights = data?.heights;
        if (!terrain || !data || !heights || heights.length !== samples * samples) {
            addNotification({ message: 'This terrain has no sculpted heights to export yet.', type: 'info' });
            return;
        }
        let lowest = Infinity;
        let highest = -Infinity;
        for (const value of heights) {
            if (value < lowest) lowest = value;
            if (value > highest) highest = value;
        }
        const span = Math.max(1e-6, highest - lowest);
        const values = Float32Array.from(heights, value => (value - lowest) / span);
        const image = { width: samples, height: samples, values };
        // The name records the range, so importing the file restores the same heights.
        const base = `${terrain.name.replace(/[^\w-]+/g, '_')}_${samples}x${samples}_h${lowest.toFixed(3)}_${highest.toFixed(3)}`;
        if (raw) downloadBytes(encodeHeightmapRaw(image), `${base}.r16`, 'application/octet-stream');
        else downloadBytes(await encodeHeightmapPng(image), `${base}.png`, 'image/png');
    };

    const applyResize = () => {
        if (!terrain || !data || resize === null || resize === data.resolution || !canEdit()) return;
        const from = terrainSamplesPerSide(data.resolution);
        const to = terrainSamplesPerSide(resize);
        snapshotHistory();
        const next: TerrainData = { ...data, resolution: resize };
        delete next.heightfield;
        delete next.splatmap;
        delete next.splatmap2;
        delete next.holemap;
        next.heights = data.heights?.length === from * from ? Array.from(resampleGrid(data.heights, from, from, to, to)) : [];
        if (data.splat?.length === from * from * 4) {
            const weights = resampleGrid(data.splat, from, from, to, to, 4);
            const splat = new Array<number>(weights.length);
            for (let index = 0; index < weights.length; index += 4) {
                // Rounded back to bytes that still add up to 255.
                const a = Math.round(weights[index + 1]);
                const b = Math.round(weights[index + 2]);
                const c = Math.round(weights[index + 3]);
                splat[index] = Math.max(0, 255 - a - b - c);
                splat[index + 1] = a;
                splat[index + 2] = b;
                splat[index + 3] = c;
            }
            next.splat = splat;
        } else {
            delete next.splat;
        }
        if (data.splat2?.length === from * from * 4) {
            next.splat2 = Array.from(resampleGrid(data.splat2, from, from, to, to, 4), value => Math.round(value));
        } else {
            delete next.splat2;
        }
        delete next.holes;
        updateLevelObject(terrain.id, { terrainData: next });
        setResize(null);
    };

    return (
        <>
            {terrains.length > 0 && (
                <Section title="Terrains in this level">
                    <div className="space-y-1">
                        {terrains.map(entry => (
                            <button
                                key={entry.id}
                                type="button"
                                onClick={() => onSelect(entry.id)}
                                aria-pressed={entry.id === terrain?.id}
                                className={`flex w-full items-center gap-2 rounded border px-2 py-1 text-left text-xs transition-colors duration-75 ${entry.id === terrain?.id ? 'border-accent/70 bg-accent/15 text-ink' : 'border-line text-ink-2 hover:bg-gray-750'}`}
                            >
                                <Mountain size={12} className="shrink-0" />
                                <span className="flex-1 truncate">{entry.name}</span>
                                <span className="shrink-0 text-2xs text-ink-3">{entry.terrainData?.width} × {entry.terrainData?.depth} m</span>
                            </button>
                        ))}
                    </div>
                </Section>
            )}

            {terrain && data && (
                <Section title={terrain.name}>
                    <div className="space-y-1">
                        <Row label="Size"><div className="text-right text-xs text-ink">{data.width} × {data.depth} m</div></Row>
                        <Row label="Grid"><div className="text-right text-xs text-ink">{samples} × {samples}</div></Row>
                        <Row label="Vertex spacing"><div className="text-right text-xs text-ink">{cell.toFixed(2)} m</div></Row>
                        <Row label="Resolution" hint="Changing it keeps the terrain's shape and paint, resampled to the new grid">
                            <Select value={resize ?? data.resolution} options={RESOLUTIONS.map(value => ({ label: `${value} cells`, value }))} onChange={(value: number) => setResize(value)} />
                        </Row>
                        {resize !== null && resize !== data.resolution && (
                            <Button variant="primary" size="md" className="w-full" onClick={applyResize}><Scaling size={12} /> Resample to {resize} cells</Button>
                        )}
                    </div>
                    <div className="mt-2 space-y-1">
                        <Row label="Height range" hint="The heights the darkest and brightest values of an imported file stand for, in metres. A file exported from here carries its own range.">
                            <div className="grid grid-cols-2 gap-1">
                                <ScrubbableInput label="" labelWidth="w-0" value={low} step={1} onChange={setLow} />
                                <ScrubbableInput label="" labelWidth="w-0" value={high} step={1} onChange={setHigh} />
                            </div>
                        </Row>
                        <div className="grid grid-cols-2 gap-1 pt-1">
                            <Button size="md" onClick={() => { fileTarget.current = 'existing'; fileInput.current?.click(); }} title="Replace this terrain's heights from a 16-bit PNG or RAW file"><Upload size={12} /> Import</Button>
                            <Button size="md" onClick={() => void exportHeights(false)} title="Save the heights as a 16-bit PNG"><Download size={12} /> Export PNG</Button>
                            <Button size="md" onClick={() => void exportHeights(true)} title="Save the heights as 16-bit RAW (.r16)"><Download size={12} /> Export RAW</Button>
                            <Button size="md" variant="danger" onClick={() => void removeLevelObject(terrain.id)}><Trash2 size={12} /> Delete</Button>
                        </div>
                    </div>
                </Section>
            )}

            <Section title="New Terrain">
                <div className="space-y-1">
                    <NumberRow label="Width" unit="m" value={width} step={8} min={1} max={32000} onChange={setWidth} />
                    <NumberRow label="Depth" unit="m" value={depth} step={8} min={1} max={32000} onChange={setDepth} />
                    <Row label="Resolution" hint="Cells along each side. More follows finer shapes and costs more memory">
                        <Select value={resolution} options={RESOLUTIONS.map(value => ({ label: `${value} cells`, value }))} onChange={(value: number) => setResolution(value)} />
                    </Row>
                    <Row label="Centre (X, Z)">
                        <div className="grid grid-cols-2 gap-1">
                            <ScrubbableInput label="" labelWidth="w-0" value={positionX} step={1} onChange={setPositionX} />
                            <ScrubbableInput label="" labelWidth="w-0" value={positionZ} step={1} onChange={setPositionZ} />
                        </div>
                    </Row>
                    <p className="text-2xs text-ink-3">{(width / resolution).toFixed(2)} m between vertices.</p>
                    <div className="flex gap-1.5 pt-1">
                        <Button variant="primary" size="md" className="flex-1" onClick={() => void createFrom(undefined)}><Plus size={12} /> Create</Button>
                        <Button size="md" title="Create it from a 16-bit PNG or RAW heightmap" onClick={() => { fileTarget.current = 'new'; fileInput.current?.click(); }}><Upload size={12} /> From File</Button>
                    </div>
                </div>
            </Section>

            <input
                ref={fileInput}
                type="file"
                accept=".png,.r16,.raw"
                className="hidden"
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) void handleFile(file);
                }}
            />
        </>
    );
};

const TABS: { value: TerrainTab; label: string; icon: React.ReactNode }[] = [
    { value: 'manage', label: 'Manage', icon: <Box size={12} /> },
    { value: 'sculpt', label: 'Sculpt', icon: <Hammer size={12} /> },
    { value: 'paint', label: 'Paint', icon: <Layers size={12} /> },
];

/** The Terrain tool's panel: make and exchange terrains, shape them, and paint them. */
export const TerrainPanel: React.FC<TerrainPanelProps> = ({ settings, onSettingsChange, selectedObjectId, onSelectTerrain }) => {
    const { levelObjects } = useScene();
    const terrains = useMemo(() => levelObjects.filter(object => object.type === 'terrain'), [levelObjects]);
    const terrain = terrains.find(object => object.id === selectedObjectId) ?? terrains[0];
    const change = (changes: Partial<TerrainToolSettings>) => onSettingsChange({ ...settings, ...changes });

    // The tool works on a terrain from the start: nothing to pick first, and nothing to do without one.
    const hasTerrain = terrains.length > 0;
    useEffect(() => {
        if (terrain && selectedObjectId !== terrain.id) onSelectTerrain(terrain.id);
    }, [terrain?.id, selectedObjectId]);
    useEffect(() => {
        if (!hasTerrain && settings.tab !== 'manage') change({ tab: 'manage' });
    }, [hasTerrain, settings.tab]);

    return (
        <div className="absolute right-0 top-12 bottom-0 z-20 pointer-events-auto flex">
            <div className="flex h-full w-72 shrink-0 flex-col border-l border-line bg-gray-900">
                <div className="flex shrink-0 border-b border-line bg-gray-950">
                    {TABS.map(({ value, label, icon }) => (
                        <button
                            key={value}
                            type="button"
                            onClick={() => change({ tab: value })}
                            disabled={value !== 'manage' && !hasTerrain}
                            className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 py-2.5 text-2xs font-semibold transition-colors duration-75 disabled:cursor-not-allowed disabled:opacity-30 ${settings.tab === value ? 'border-accent text-ink' : 'border-transparent text-ink-3 hover:text-ink-2'}`}
                        >
                            {icon} {label}
                        </button>
                    ))}
                </div>
                <div className="flex-1 overflow-y-auto custom-scrollbar">
                    {settings.tab === 'manage' && (
                        <ManageTab
                            terrains={terrains}
                            terrain={terrain}
                            onSelect={onSelectTerrain}
                            onCreated={(id) => {
                                onSelectTerrain(id);
                                change({ tab: 'sculpt' });
                            }}
                        />
                    )}
                    {settings.tab === 'sculpt' && <SculptTab settings={settings} change={change} terrain={terrain} />}
                    {settings.tab === 'paint' && terrain && (
                        <TerrainLayerPanel terrain={terrain} settings={settings} onSettingsChange={onSettingsChange} brush={<BrushSection settings={settings} change={change} />} />
                    )}
                </div>
            </div>
        </div>
    );
};

