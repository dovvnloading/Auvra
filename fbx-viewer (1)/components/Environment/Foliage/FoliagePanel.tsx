import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { BrushIcon, BucketIcon, CircleDashedIcon, ClickIcon, CopyIcon, EraserIcon, LassoIcon, PlusIcon, PointerIcon, RefreshIcon, TrashIcon, TreeIcon } from '../../UI/Icons';
import { useScene } from '../../../context/SceneContext';
import type { LevelObject, LoadedModelData } from '../../../types';
import { editorSession } from '../../../utils/editorSession';
import { MODEL_DRAG_TYPE } from '../../UI/Browser/browserFolders';
import { Button, Section } from '../../UI/kit';
import { Select } from '../../UI/Select';
import { ScrubbableInput } from '../../UI/Properties/ScrubbableInput';
import {
    DEFAULT_FOLIAGE_TYPE, foliageInstanceCount, isFoliageTypePending, MAX_FOLIAGE_TYPES, sanitizeFoliageType, writeFoliageMatrix,
    FOLIAGE_INSTANCE_FLOATS, type FoliageType,
} from '../../../runtime/foliage';
import { foliageDefaultsFor } from './foliagePlacement';
import { foliageToolStore, selectedInstanceCount, useFoliageToolState, type FoliageToolName, type FoliageToolSettings } from './foliageSettings';

interface FoliagePanelProps {
    settings: FoliageToolSettings;
    onSettingsChange: (settings: FoliageToolSettings) => void;
    /** A model clicked in the level's browser while this panel is up: added to the palette. */
    brushModelId: string | null;
    onBrushUsed: () => void;
}

const TOOLS: { tool: FoliageToolName; label: string; icon: React.ReactNode; hint: string }[] = [
    { tool: 'select', label: 'Select', icon: <PointerIcon size={14} />, hint: 'Click an instance to select it, Ctrl-click to add. Move it with the gizmo; Delete removes it.' },
    { tool: 'lasso', label: 'Lasso', icon: <LassoIcon size={14} />, hint: 'Drag the brush over instances to select them. Shift takes them off the selection.' },
    { tool: 'paint', label: 'Paint', icon: <BrushIcon size={14} />, hint: 'Hold to paint the ticked types, each at its own density. Shift erases.' },
    { tool: 'erase', label: 'Erase', icon: <EraserIcon size={14} />, hint: 'Hold to erase the ticked types, thinning them to Erase density.' },
    { tool: 'reapply', label: 'Reapply', icon: <RefreshIcon size={14} />, hint: 'Hold over painted instances to apply the types\' current rules to them: size, lean, offset, slope, height and spacing.' },
    { tool: 'single', label: 'Single', icon: <ClickIcon size={14} />, hint: 'Click to place one instance. With several types ticked, each click takes the next.' },
    { tool: 'fill', label: 'Fill', icon: <BucketIcon size={14} />, hint: 'Click a terrain or mesh to fill the whole of it with the ticked types.' },
];

const SCALE_MODES = [
    { label: 'Uniform', value: 'uniform' },
    { label: 'Same width', value: 'lockWidth' },
    { label: 'Free', value: 'free' },
];

const COLLISIONS = [
    { label: 'None', value: 'none' },
    { label: 'A trunk', value: 'trunk' },
    { label: 'Its box', value: 'box' },
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

const RangeRow: React.FC<{ label: string; value: [number, number]; onChange: (value: [number, number]) => void; step?: number; min?: number; max?: number; hint?: string }> = ({
    label, value, onChange, step = 0.1, min = -Infinity, max = Infinity, hint,
}) => {
    const clamp = (next: number) => Math.min(max, Math.max(min, next));
    return (
        <Row label={label} hint={hint}>
            <div className="grid grid-cols-2 gap-1">
                <ScrubbableInput label="" labelWidth="w-0" value={value[0]} step={step} onChange={(next) => { if (Number.isFinite(next)) onChange([clamp(next), Math.max(clamp(next), value[1])]); }} />
                <ScrubbableInput label="" labelWidth="w-0" value={value[1]} step={step} onChange={(next) => { if (Number.isFinite(next)) onChange([Math.min(clamp(next), value[0]), clamp(next)]); }} />
            </div>
        </Row>
    );
};

const Toggle: React.FC<{ label: string; checked: boolean; onChange: (checked: boolean) => void; hint?: string }> = ({ label, checked, onChange, hint }) => (
    <label className="flex min-h-[26px] cursor-pointer items-center justify-between gap-2" title={hint}>
        <span className="truncate text-xs text-ink-2">{label}</span>
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-3.5 w-3.5" />
    </label>
);

/** Model-space width of a model, for a density and spacing that suit it. */
const footprintOf = (model: LoadedModelData): number => {
    const size = new THREE.Box3().setFromObject(model.object).getSize(new THREE.Vector3());
    return Math.max(size.x, size.z);
};

const newFoliageType = (model: LoadedModelData): FoliageType => {
    const { density, radius } = foliageDefaultsFor(footprintOf(model));
    return { ...DEFAULT_FOLIAGE_TYPE, id: crypto.randomUUID(), modelId: model.id, density, radius };
};

const isModelDrag = (event: React.DragEvent): boolean => Array.from(event.dataTransfer.types).includes(MODEL_DRAG_TYPE);

const legacyCopies = (objects: readonly LevelObject[]): LevelObject[] => objects.filter(object => object.type === 'foliage');

/** The Foliage tool's panel: the tools, the brush, and the palette of what it paints and by what rules. */
export const FoliagePanel: React.FC<FoliagePanelProps> = ({ settings, onSettingsChange, brushModelId, onBrushUsed }) => {
    const { levelObjects, models, updateLevelObject, addLevelObjects, removeLevelObjects, snapshotHistory } = useScene();
    const { selection, focusedTypeId } = useFoliageToolState();
    const change = (changes: Partial<FoliageToolSettings>) => onSettingsChange({ ...settings, ...changes });

    const set = useMemo(() => levelObjects.find(object => object.type === 'foliage_set') ?? null, [levelObjects]);
    const types = useMemo(() => (set?.foliageData?.types ?? []).map(sanitizeFoliageType), [set?.foliageData?.types]);
    const focused = types.find(type => type.id === focusedTypeId) ?? types[0];
    const modelById = useMemo(() => new Map(models.map(model => [model.id, model])), [models]);
    const canEdit = () => editorSession.captureReady() !== null;

    const layerNames = useMemo(() => {
        const found = new Set<string>();
        for (const object of levelObjects) {
            if (object.type !== 'terrain') continue;
            object.terrainData?.textureLayers?.forEach((layer, index) => found.add(layer.name || `Layer ${index + 1}`));
        }
        return [...found];
    }, [levelObjects]);

    const creating = useRef(false);

    const writeTypes = useCallback((next: FoliageType[], snapshot = true) => {
        if (!set?.foliageData || !canEdit()) return;
        if (snapshot) snapshotHistory();
        updateLevelObject(set.id, { foliageData: { types: next } });
    }, [set, snapshotHistory, updateLevelObject]);

    const addType = useCallback(async (model: LoadedModelData | undefined) => {
        if (!model || !canEdit()) return;
        if (types.some(type => type.modelId === model.id)) {
            foliageToolStore.set({ focusedTypeId: types.find(type => type.modelId === model.id)!.id });
            return;
        }
        if (types.length >= MAX_FOLIAGE_TYPES) return;
        const type = newFoliageType(model);
        foliageToolStore.set({ focusedTypeId: type.id });
        if (set) {
            writeTypes([...types, type]);
            return;
        }
        if (creating.current) return;
        creating.current = true;
        try {
            // A level's foliage set exists from its first type on.
            await addLevelObjects([{
                id: crypto.randomUUID(), levelId: '', modelId: '', name: 'Foliage', type: 'foliage_set',
                position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], foliageData: { types: [type] },
            }]);
        } finally {
            creating.current = false;
        }
    }, [addLevelObjects, set, types, writeTypes]);

    // A model clicked in the level's browser joins the palette.
    useEffect(() => {
        if (!brushModelId) return;
        void addType(modelById.get(brushModelId));
        onBrushUsed();
    }, [brushModelId]);

    // One undo step per drag of a setting.
    const armed = useRef(true);
    const arm = () => { armed.current = true; };
    const updateFocused = (changes: Partial<FoliageType>) => {
        if (!focused) return;
        const snapshot = armed.current;
        armed.current = false;
        writeTypes(types.map(type => (type.id === focused.id ? { ...type, ...changes } : type)), snapshot);
    };

    const removeType = (id: string) => writeTypes(types.filter(type => type.id !== id));

    const toggleActive = (id: string) => {
        if (!canEdit()) return;
        writeTypes(types.map(type => (type.id === id ? { ...type, active: !type.active } : type)), false);
    };

    const duplicateType = (type: FoliageType) => {
        const { instances: _instances, instancemap: _reference, ...rest } = type;
        writeTypes([...types, { ...rest, id: crypto.randomUUID() }]);
    };

    const removeAllInstances = (type: FoliageType) => {
        const { instancemap: _reference, ...rest } = type;
        writeTypes(types.map(entry => (entry.id === type.id ? { ...rest, instances: new Float32Array(0) } : entry)));
    };

    const [dropping, setDropping] = useState(false);

    const legacy = useMemo(() => legacyCopies(levelObjects), [levelObjects]);

    /** Turns copies painted as separate objects into instances of the palette, as one undo step. */
    const convertLegacy = async () => {
        if (!canEdit() || legacy.length === 0) return;
        const byModel = new Map<string, LevelObject[]>();
        for (const object of legacy) {
            const list = byModel.get(object.modelId);
            if (list) list.push(object);
            else byModel.set(object.modelId, [object]);
        }
        const matrix = new THREE.Matrix4();
        const quaternion = new THREE.Quaternion();
        const position = new THREE.Vector3();
        const scale = new THREE.Vector3();
        const next = [...types];
        for (const [modelId, objects] of byModel) {
            const floats = new Float32Array(objects.length * FOLIAGE_INSTANCE_FLOATS);
            objects.forEach((object, index) => {
                position.fromArray(object.position);
                quaternion.setFromEuler(new THREE.Euler(...object.rotation));
                scale.fromArray(object.scale);
                writeFoliageMatrix(floats, index, matrix.compose(position, quaternion, scale));
            });
            const existing = next.findIndex(type => type.modelId === modelId);
            const model = modelById.get(modelId);
            if (existing >= 0) {
                const merged = new Float32Array((next[existing].instances?.length ?? 0) + floats.length);
                merged.set(next[existing].instances ?? new Float32Array(0));
                merged.set(floats, next[existing].instances?.length ?? 0);
                next[existing] = { ...next[existing], instances: merged };
            } else if (model) {
                next.push({ ...newFoliageType(model), instances: floats });
            }
        }
        if (set) {
            snapshotHistory();
            updateLevelObject(set.id, { foliageData: { types: next } });
        } else {
            await addLevelObjects([{
                id: crypto.randomUUID(), levelId: '', modelId: '', name: 'Foliage', type: 'foliage_set',
                position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], foliageData: { types: next },
            }]);
        }
        await removeLevelObjects(legacy.map(object => object.id));
    };

    const current = TOOLS.find(entry => entry.tool === settings.tool) ?? TOOLS[0];
    const selectedCount = selectedInstanceCount(selection);
    const totalInstances = types.reduce((sum, type) => sum + foliageInstanceCount(type), 0);
    const modelOptions = useMemo(() => [...models].sort((a, b) => a.name.localeCompare(b.name)).map(model => ({ label: model.name, value: model.id })), [models]);

    return (
        <div className="absolute right-0 top-12 bottom-0 z-20 pointer-events-auto flex" onPointerDownCapture={arm} onFocusCapture={arm}>
            <div className="flex h-full w-72 shrink-0 flex-col border-l border-line bg-gray-900">
                <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-gray-950 px-3">
                    <TreeIcon size={13} className="text-ink-2" />
                    <h2 className="flex-1 truncate text-xs font-semibold text-ink">Foliage</h2>
                    <span className="text-2xs text-ink-3">{totalInstances.toLocaleString()} placed</span>
                </div>
                <div className="flex-1 overflow-y-auto custom-scrollbar">
                    <Section title="Tool">
                        <div className="grid grid-cols-4 gap-1">
                            {TOOLS.map(({ tool, label, icon }) => (
                                <button
                                    key={tool}
                                    type="button"
                                    title={label}
                                    aria-pressed={settings.tool === tool}
                                    onClick={() => change({ tool })}
                                    className={`flex h-[46px] flex-col items-center justify-center gap-1 rounded border px-0.5 transition-colors duration-75 ${settings.tool === tool ? 'border-accent/70 bg-accent/15 text-ink' : 'border-line bg-gray-800/60 text-ink-2 hover:bg-gray-750 hover:text-ink'}`}
                                >
                                    {icon}
                                    <span className="w-full truncate text-center text-[10px] leading-none">{label}</span>
                                </button>
                            ))}
                        </div>
                        <p className="mt-2 text-2xs leading-relaxed text-ink-3">{current.hint}</p>
                        {(settings.tool === 'select' || settings.tool === 'lasso') && (
                            <>
                                <div className="mt-2 grid grid-cols-3 gap-1">
                                    <Button size="sm" onClick={() => foliageToolStore.command({ kind: 'select-all' })} title="Select every instance of the ticked types">All</Button>
                                    <Button size="sm" onClick={() => foliageToolStore.command({ kind: 'deselect' })} disabled={selectedCount === 0}>None</Button>
                                    <Button size="sm" onClick={() => foliageToolStore.command({ kind: 'select-invalid' })} title="Select instances with nothing under them">Floating</Button>
                                </div>
                                <div className="mt-1.5 flex items-center justify-between gap-2">
                                    <span className="text-2xs text-ink-3">{selectedCount.toLocaleString()} selected</span>
                                    <Button size="sm" variant="danger" disabled={selectedCount === 0} onClick={() => foliageToolStore.command({ kind: 'remove-selected' })}><TrashIcon size={11} /> Remove</Button>
                                </div>
                            </>
                        )}
                    </Section>

                    <Section title="Brush">
                        <div className="space-y-1">
                            <NumberRow label="Size" unit="m" value={settings.radius * 2} min={0.5} max={4000} hint="Across the brush, in metres. Keys: [ and ]" onChange={(value) => change({ radius: value / 2 })} />
                            <NumberRow label="Paint density" unit="%" value={Math.round(settings.paintDensity * 100)} min={1} max={500} step={5} hint="Multiplies every type's own density while painting" onChange={(value) => change({ paintDensity: value / 100 })} />
                            <NumberRow label="Erase density" unit="%" value={Math.round(settings.eraseDensity * 100)} min={0} max={100} step={5} hint="The share of each type's density erasing leaves behind: 0 removes everything" onChange={(value) => change({ eraseDensity: value / 100 })} />
                        </div>
                        <div className="mt-1.5 grid grid-cols-2 gap-x-3">
                            <Toggle label="On terrain" checked={settings.onTerrain} onChange={(onTerrain) => change({ onTerrain })} />
                            <Toggle label="On meshes" checked={settings.onMeshes} onChange={(onMeshes) => change({ onMeshes })} />
                            <Toggle label="On foliage" checked={settings.onFoliage} onChange={(onFoliage) => change({ onFoliage })} />
                            <Toggle label="Translucent" hint="On surfaces you can see through" checked={settings.onTranslucent} onChange={(onTranslucent) => change({ onTranslucent })} />
                        </div>
                    </Section>

                    <Section title={`Palette (${types.length})`}>
                        <div
                            onDragOver={(event) => {
                                if (!isModelDrag(event)) return;
                                event.preventDefault();
                                event.dataTransfer.dropEffect = 'copy';
                                setDropping(true);
                            }}
                            onDragLeave={() => setDropping(false)}
                            onDrop={(event) => {
                                if (!isModelDrag(event)) return;
                                event.preventDefault();
                                setDropping(false);
                                void addType(modelById.get(event.dataTransfer.getData(MODEL_DRAG_TYPE)));
                            }}
                            className={`space-y-1 rounded ${dropping ? 'ring-1 ring-accent' : ''}`}
                        >
                            {types.length === 0 && (
                                <p className="py-1 text-2xs leading-relaxed text-ink-3">Click a model in the browser or drag one here to paint with it.</p>
                            )}
                            {types.map((type) => {
                                const model = modelById.get(type.modelId);
                                const isFocused = focused?.id === type.id;
                                return (
                                    <div
                                        key={type.id}
                                        className={`flex items-center gap-1.5 rounded border p-1 transition-colors duration-75 ${isFocused ? 'border-accent/70 bg-accent/15' : 'border-line hover:bg-gray-750'}`}
                                    >
                                        <input type="checkbox" aria-label={`Paint ${model?.name ?? 'this type'}`} checked={type.active} onChange={() => toggleActive(type.id)} className="ml-0.5 h-3.5 w-3.5 shrink-0" />
                                        <button type="button" onClick={() => foliageToolStore.set({ focusedTypeId: type.id })} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                                            <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded bg-gray-700">
                                                {model?.thumbnail ? <img src={model.thumbnail} alt="" className="h-full w-full object-cover" draggable={false} /> : <CircleDashedIcon size={13} className="text-ink-3" />}
                                            </span>
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate text-xs text-ink">{model?.name ?? 'Missing model'}</span>
                                                <span className="block truncate text-[10px] text-ink-3">{isFoliageTypePending(type) ? 'Loading...' : `${foliageInstanceCount(type).toLocaleString()} placed`}</span>
                                            </span>
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                        <div className="mt-1.5">
                            <Select value="" placeholder="Add a model..." options={modelOptions} onChange={(value: string) => void addType(modelById.get(value))} />
                        </div>
                        {legacy.length > 0 && (
                            <div className="mt-2 rounded border border-line p-2">
                                <p className="text-2xs leading-relaxed text-ink-3">{legacy.length.toLocaleString()} copies here were painted as separate objects, so they fill the Outliner and slow saving.</p>
                                <Button size="sm" className="mt-1.5 w-full" onClick={() => void convertLegacy()}><PlusIcon size={11} /> Turn into palette instances</Button>
                            </div>
                        )}
                    </Section>

                    {focused && (
                        <>
                            <Section
                                title={`${modelById.get(focused.modelId)?.name ?? 'Type'}: Placement`}
                                actions={(
                                    <div className="flex gap-0.5">
                                        <Button size="sm" variant="ghost" title="Add another type with these rules" onClick={() => duplicateType(focused)}><CopyIcon size={11} /></Button>
                                        <Button size="sm" variant="danger" title="Take this type and its instances out of the level" onClick={() => removeType(focused.id)}><TrashIcon size={11} /></Button>
                                    </div>
                                )}
                            >
                                <div className="space-y-1">
                                    <NumberRow label="Per 100 m²" unit="" value={focused.density} step={focused.density < 2 ? 0.1 : 1} min={0.01} max={100000} hint="How many per 100 square metres" onChange={(density) => updateFocused({ density })} />
                                    <NumberRow label="Spacing" unit="m" value={focused.radius} step={0.1} min={0} max={1000} hint="Metres kept clear around each one, from others of this type" onChange={(radius) => updateFocused({ radius })} />
                                    <Row label="Scaling"><Select value={focused.scaleMode} options={SCALE_MODES} onChange={(scaleMode: FoliageType['scaleMode']) => updateFocused({ scaleMode })} /></Row>
                                    <RangeRow label={focused.scaleMode === 'uniform' ? 'Scale' : focused.scaleMode === 'lockWidth' ? 'Width' : 'Scale X'} value={focused.scaleX} min={0.001} max={1000} onChange={(scaleX) => updateFocused({ scaleX })} />
                                    {focused.scaleMode !== 'uniform' && (
                                        <RangeRow label={focused.scaleMode === 'lockWidth' ? 'Height' : 'Scale Y'} value={focused.scaleY} min={0.001} max={1000} onChange={(scaleY) => updateFocused({ scaleY })} />
                                    )}
                                    {focused.scaleMode === 'free' && <RangeRow label="Scale Z" value={focused.scaleZ} min={0.001} max={1000} onChange={(scaleZ) => updateFocused({ scaleZ })} />}
                                    <RangeRow label="Offset up" value={focused.zOffset} hint="Metres moved along its up axis: negative sinks it in" onChange={(zOffset) => updateFocused({ zOffset })} />
                                </div>
                            </Section>
                            <Section title="Rotation">
                                <div className="space-y-1">
                                    <Toggle label="Lean with the ground" checked={focused.alignToNormal} hint="Tilt with the surface, as rocks and grass do. Trees stand upright with this off" onChange={(alignToNormal) => updateFocused({ alignToNormal })} />
                                    {focused.alignToNormal && <NumberRow label="At most" unit="°" value={focused.alignMaxAngle} min={0} max={90} hint="How far it may lean from upright" onChange={(alignMaxAngle) => updateFocused({ alignMaxAngle })} />}
                                    <Toggle label="Random turn" checked={focused.randomYaw} onChange={(randomYaw) => updateFocused({ randomYaw })} />
                                    <NumberRow label="Random lean" unit="°" value={focused.randomPitch} min={0} max={180} onChange={(randomPitch) => updateFocused({ randomPitch })} />
                                </div>
                            </Section>
                            <Section title="Where It Grows">
                                <div className="space-y-1">
                                    <Toggle label="Keep clear of objects" checked={focused.avoidWorld} hint="Skip places where the model's box would overlap an object in the level, such as a rock or a wall" onChange={(avoidWorld) => updateFocused({ avoidWorld })} />
                                    <RangeRow label="Slope" value={focused.slope} step={1} min={0} max={90} hint="Degrees of ground slope" onChange={(slope) => updateFocused({ slope })} />
                                    <RangeRow label="Height" value={focused.height} step={1} hint="World heights, in metres" onChange={(height) => updateFocused({ height })} />
                                </div>
                                {layerNames.length > 0 && (
                                    <div className="mt-1.5 space-y-0.5">
                                        <div className="grid grid-cols-[1fr_44px_44px] items-center gap-1 text-[10px] text-ink-3">
                                            <span>Terrain layer</span><span className="text-center">Only</span><span className="text-center">Never</span>
                                        </div>
                                        {layerNames.map((name) => (
                                            <div key={name} className="grid grid-cols-[1fr_44px_44px] items-center gap-1">
                                                <span className="truncate text-xs text-ink-2">{name}</span>
                                                <input
                                                    type="checkbox" className="mx-auto h-3.5 w-3.5" aria-label={`Only on ${name}`} checked={focused.includeLayers.includes(name)}
                                                    onChange={(event) => updateFocused({ includeLayers: event.target.checked ? [...focused.includeLayers, name] : focused.includeLayers.filter(entry => entry !== name) })}
                                                />
                                                <input
                                                    type="checkbox" className="mx-auto h-3.5 w-3.5" aria-label={`Never on ${name}`} checked={focused.excludeLayers.includes(name)}
                                                    onChange={(event) => updateFocused({ excludeLayers: event.target.checked ? [...focused.excludeLayers, name] : focused.excludeLayers.filter(entry => entry !== name) })}
                                                />
                                            </div>
                                        ))}
                                        <NumberRow label="Counts from" unit="%" value={Math.round(focused.minLayerWeight * 100)} min={1} max={100} hint="How much of a layer must be there to count as being on it" onChange={(value) => updateFocused({ minLayerWeight: value / 100 })} />
                                    </div>
                                )}
                            </Section>
                            <Section title="Drawing and Play">
                                <div className="space-y-1">
                                    <Toggle label="Cast shadows" checked={focused.castShadow} onChange={(castShadow) => updateFocused({ castShadow })} />
                                    <NumberRow label="Pictures beyond" unit="m" value={focused.impostorDistance} step={5} min={0} hint="Beyond this they draw as flat pictures of the model. 0: never" onChange={(impostorDistance) => updateFocused({ impostorDistance })} />
                                    <NumberRow label="Hidden beyond" unit="m" value={focused.cullDistance} step={5} min={0} hint="Beyond this they are not drawn. 0: never" onChange={(cullDistance) => updateFocused({ cullDistance })} />
                                    <Row label="Collision" hint="What the player and vehicles hit in play"><Select value={focused.collision} options={COLLISIONS} onChange={(collision: FoliageType['collision']) => updateFocused({ collision })} /></Row>
                                </div>
                                <Button size="sm" variant="danger" className="mt-2 w-full" disabled={foliageInstanceCount(focused) === 0} onClick={() => removeAllInstances(focused)}><TrashIcon size={11} /> Remove All {foliageInstanceCount(focused).toLocaleString()} Instances</Button>
                            </Section>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};
