
import React, { useCallback, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Box, Move, RotateCw, Scaling, Trash2, X, RotateCcw, Skull, Timer, Users, UserPlus, Hash, Music, Volume2, Radio, Ear, Repeat, VolumeX, Mountain, Layers, Plus, CircleDashed, Hammer, ArrowUp, ArrowDown, Minus, Activity, Wind, AlertTriangle, Grid, Sun, CloudFog, PersonStanding, Puzzle, GitBranch, Boxes, Brush, Route } from 'lucide-react';
import { EditorState } from '../types';
import { PrefabInstanceSection } from '../PrefabInstanceSection';
import { LevelComponent, LevelObject, SpawnConfig } from '../../../types';
import { EnvironmentBrushPanel } from '../EnvironmentBrushPanel';
import { EnvironmentMaskTool } from '../EnvironmentMaskTool';
import { TerrainLayerPanel } from '../Terrain/TerrainLayerPanel';
import { ScrubbableInput } from '../../UI/Properties/ScrubbableInput';
import { useScene } from '../../../context/SceneContext';
import { WaveformEditor } from '../assets/WaveformEditor';
import { DEFAULT_SKY_CONFIG } from '../SkySystem';
import { DEFAULT_SHADOW_DISTANCE } from '../../../runtime/lighting/distanceShadows';
import { SkyWeatherSection } from '../SkyWeatherSection';
import { isTerrainHeightfieldPending } from '../../../utils/terrainHeightfieldCodec';
import { editorSession } from '../../../utils/editorSession';
import { appConfirm } from '../../../utils/appDialogs';
import { collectSubtree, getWorldMatrix, reparentPreservingWorld, sortByHierarchy, toLocalTransform, wouldCreateCycle } from '../../../utils/sceneGraph';
import { COMPONENT_DEFINITIONS, createComponent, getComponentDefinition } from '../../../runtime/components/registry';
import type { ComponentPropSchema } from '../../../runtime/components/types';
import { findSplineComponent } from '../../../runtime/splineRegistry';

interface EnvironmentInspectorProps {
    /** selectedObjectIds is the multi-selection (primary stays selectedObjectId). */
    state: EditorState & { selectedObjectIds?: string[] };
    selectedObject: LevelObject | undefined;
    actions: {
        setPaintMode: (mode: any) => void;
        setPaintSettings: (settings: any) => void;
        setSelectedObjectId: (id: string | null) => void;
        updateLevelObject: (id: string, updates: any) => void;
        removeLevelObject: (id: string) => void;
        setSculptSettings: (settings: any) => void;
    };
}

type Vec3 = [number, number, number];
type ObjectUpdate = Partial<LevelObject>;

const AXES = ['X', 'Y', 'Z'] as const;
const AXIS_COLORS = ['text-red-400', 'text-green-400', 'text-blue-400'];
const SECTION_TITLE = 'text-[10px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5';
const MIN_ABS_SCALE = 0.001;
const MULTI_SELECTION_NAME_LIMIT = 8;
/** What a new Enemy Spawner starts with: no enemy chosen yet, one every 5 s, no limit. */
const DEFAULT_SPAWN_CONFIG: SpawnConfig = { blueprintId: '', interval: 5, maxSpawns: 0, team: 'Enemy' };
/** A shorter interval would spawn an enemy almost every frame. */
const MIN_SPAWN_INTERVAL = 0.5;

/** LevelObject.rotation is Euler XYZ in radians; the inspector shows degrees to one decimal. */
const toDisplayDegrees = (radians: number) => Math.round(THREE.MathUtils.radToDeg(radians) * 10) / 10;
/** A zero scale collapses the object's matrix and breaks parenting maths, so keep it just off zero. */
const safeScale = (value: number) => (Math.abs(value) < MIN_ABS_SCALE ? (value < 0 ? -MIN_ABS_SCALE : MIN_ABS_SCALE) : value);

const isTextEntry = (target: EventTarget | null) => {
    const element = target as HTMLElement | null;
    if (!element) return false;
    if (element.tagName === 'TEXTAREA' || element.isContentEditable) return true;
    return element.tagName === 'INPUT' && ['text', 'number', 'search'].includes((element as HTMLInputElement).type);
};

/**
 * Undo snapshots for inspector edits. A discrete edit (toggle, dropdown, button) is always its own
 * undo step. A continuous edit (scrub drag, typing, colour picking) records one snapshot for the
 * whole gesture: the panel re-arms on every pointer press, focus change, or non-typing key press,
 * and the first change after arming snapshots the level before it is applied.
 */
const useInspectorEdits = () => {
    const { snapshotHistory } = useScene();
    const armedRef = useRef(true);
    const arm = useCallback(() => { armedRef.current = true; }, []);
    const armForKey = useCallback((event: React.KeyboardEvent) => {
        if (!isTextEntry(event.target)) armedRef.current = true;
    }, []);
    const canEdit = () => editorSession.captureReady() !== null;

    const commit = (apply: () => void) => {
        if (!canEdit()) return;
        snapshotHistory();
        armedRef.current = false;
        apply();
    };

    const scrub = (apply: () => void) => {
        if (!canEdit()) return;
        if (armedRef.current) {
            snapshotHistory();
            armedRef.current = false;
        }
        apply();
    };

    return {
        commit,
        scrub,
        panelHandlers: { onPointerDownCapture: arm, onFocusCapture: arm, onKeyDownCapture: armForKey },
    };
};

type InspectorEdits = ReturnType<typeof useInspectorEdits>;

// Internal Terrain Config Component
const TerrainInspector: React.FC<{ 
    actions: EnvironmentInspectorProps['actions'], 
    sculptSettings: any 
}> = ({ actions, sculptSettings }) => {
    const { addLevelObject, levelObjects } = useScene();
    const [activeTab, setActiveTab] = useState<'create' | 'sculpt'>('create');
    
    // Creation Settings
    const [createSize, setCreateSize] = useState(100);
    const [createRes, setCreateRes] = useState(128);

    // Check if terrain exists
    const existingTerrain = levelObjects.find(obj => obj.type === 'terrain');

    const handleCreateTerrain = async () => {
        if (existingTerrain) return;

        const id = await addLevelObject(
            '', 
            [0, 0, 0], 
            [0, 0, 0], 
            [1, 1, 1], 
            'terrain',
            { resolution: createRes, width: createSize, depth: createSize, heights: [] }
        );
        
        if (id) {
            actions.setSelectedObjectId(id);
            setActiveTab('sculpt');
        }
    };

    return (
        <div className="absolute right-0 top-12 bottom-0 z-20 pointer-events-auto flex">
            <div className="w-72 bg-gray-900 border-l border-gray-800 flex flex-col shrink-0 z-20 shadow-xl animate-in slide-in-from-right-10 duration-200 h-full">
                <div className="flex border-b border-gray-800 bg-gray-950">
                    <button 
                        onClick={() => setActiveTab('create')}
                        className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider flex items-center justify-center gap-2 border-b-2 transition-colors ${activeTab === 'create' ? 'border-amber-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                    >
                        <Layers size={12} /> Manage
                    </button>
                    <button 
                        onClick={() => setActiveTab('sculpt')}
                        disabled={!existingTerrain}
                        className={`flex-1 py-3 text-[10px] font-bold uppercase tracking-wider flex items-center justify-center gap-2 border-b-2 transition-colors ${activeTab === 'sculpt' ? 'border-amber-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed'}`}
                    >
                        <Hammer size={12} /> Sculpt
                    </button>
                </div>

                <div className="p-4 space-y-6 overflow-y-auto custom-scrollbar flex-1">
                    
                    {activeTab === 'create' && (
                        <div className="space-y-4">
                            <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                                <Mountain size={12} /> Terrain Generation
                            </div>

                            {existingTerrain ? (
                                <div className="bg-gray-800/50 border border-gray-700 rounded p-4 flex flex-col items-center text-center gap-3">
                                    <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center text-amber-500">
                                        <AlertTriangle size={24} />
                                    </div>
                                    <div className="space-y-1">
                                        <h4 className="text-xs font-bold text-white">Terrain Active</h4>
                                        <p className="text-[10px] text-gray-400 leading-relaxed">
                                            Only one terrain object is allowed per scene. Select the existing terrain to sculpt it, or delete it to create a new one.
                                        </p>
                                    </div>
                                    <button 
                                        onClick={() => actions.setSelectedObjectId(existingTerrain.id)}
                                        className="w-full py-2 bg-gray-800 hover:bg-gray-700 text-white text-xs font-bold rounded border border-gray-600 transition-colors"
                                    >
                                        Select Current Terrain
                                    </button>
                                </div>
                            ) : (
                                <div className="space-y-6 animate-in fade-in duration-300">
                                    {/* Settings */}
                                    <div className="space-y-4">
                                        <div className="space-y-2">
                                            <div className="flex justify-between items-center">
                                                <span className="text-xs text-gray-300 font-bold flex items-center gap-2">
                                                    <Scaling size={12} className="text-gray-500" /> Size (Meters)
                                                </span>
                                            </div>
                                            <div className="bg-gray-800 rounded p-2 border border-gray-700">
                                                <div className="flex items-center gap-2">
                                                    <input 
                                                        type="range" min="50" max="1000" step="50"
                                                        value={createSize}
                                                        onChange={(e) => setCreateSize(parseInt(e.target.value))}
                                                        className="flex-1 h-1.5 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-amber-500"
                                                    />
                                                    <span className="text-xs font-mono text-white w-10 text-right">{createSize}m</span>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="space-y-2">
                                            <div className="flex justify-between items-center">
                                                <span className="text-xs text-gray-300 font-bold flex items-center gap-2">
                                                    <Grid size={12} className="text-gray-500" /> Resolution (Polygons)
                                                </span>
                                            </div>
                                            <div className="bg-gray-800 rounded p-2 border border-gray-700 space-y-2">
                                                <div className="flex items-center gap-2">
                                                    <input 
                                                        type="range" min="32" max="512" step="32"
                                                        value={createRes}
                                                        onChange={(e) => setCreateRes(parseInt(e.target.value))}
                                                        className="flex-1 h-1.5 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-amber-500"
                                                    />
                                                    <span className="text-xs font-mono text-white w-10 text-right">{createRes}</span>
                                                </div>
                                                <div className="text-[9px] text-gray-500 flex justify-between">
                                                    <span>Low Poly</span>
                                                    <span>High Detail (Heavy)</span>
                                                </div>
                                            </div>
                                            <p className="text-[9px] text-gray-500 leading-tight pl-1">
                                                Higher resolution allows for smoother sculpting but may impact performance.
                                            </p>
                                        </div>
                                    </div>

                                    <button 
                                        onClick={handleCreateTerrain}
                                        className="w-full py-3 bg-amber-600 hover:bg-amber-500 text-white rounded font-bold text-xs shadow-lg shadow-amber-900/20 transition-all flex items-center justify-center gap-2"
                                    >
                                        <Plus size={14} /> Create Terrain Surface
                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                    {activeTab === 'sculpt' && (
                        <div className="space-y-6">
                            {existingTerrain ? (
                                <>
                                    {/* Brush Settings */}
                                    <div className="space-y-3">
                                        <div className="flex items-center gap-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider border-b border-gray-800 pb-1">
                                            <CircleDashed size={12} /> Brush Settings
                                        </div>
                                        <div className="space-y-2">
                                            <div className="flex items-center justify-between">
                                                <span className="text-xs text-gray-400">Radius</span>
                                                <div className="w-24">
                                                    <ScrubbableInput label="m" value={sculptSettings.radius} onChange={(v) => actions.setSculptSettings({ ...sculptSettings, radius: Math.max(0.5, v) })} step={0.5} labelWidth="w-6" />
                                                </div>
                                            </div>
                                            <div className="flex items-center justify-between">
                                                <span className="text-xs text-gray-400">Strength</span>
                                                <div className="w-24">
                                                    <ScrubbableInput label="%" value={sculptSettings.strength} onChange={(v) => actions.setSculptSettings({ ...sculptSettings, strength: Math.max(0.01, Math.min(1, v)) })} step={0.05} labelWidth="w-6" />
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Tools */}
                                    <div className="space-y-3">
                                        <div className="flex items-center gap-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider border-b border-gray-800 pb-1">
                                            <Hammer size={12} /> Tools
                                        </div>
                                        <div className="grid grid-cols-2 gap-2">
                                            <button 
                                                onClick={() => actions.setSculptSettings({ ...sculptSettings, tool: 'raise' })}
                                                className={`p-2 rounded border flex flex-col items-center gap-1 transition-all ${sculptSettings.tool === 'raise' ? 'bg-amber-600/20 border-amber-500 text-amber-400' : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'}`}
                                            >
                                                <ArrowUp size={16} /> <span className="text-[10px] font-bold uppercase">Raise</span>
                                            </button>
                                            <button 
                                                onClick={() => actions.setSculptSettings({ ...sculptSettings, tool: 'lower' })}
                                                className={`p-2 rounded border flex flex-col items-center gap-1 transition-all ${sculptSettings.tool === 'lower' ? 'bg-red-600/20 border-red-500 text-red-400' : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'}`}
                                            >
                                                <ArrowDown size={16} /> <span className="text-[10px] font-bold uppercase">Lower</span>
                                            </button>
                                            <button 
                                                onClick={() => actions.setSculptSettings({ ...sculptSettings, tool: 'flatten' })}
                                                className={`p-2 rounded border flex flex-col items-center gap-1 transition-all ${sculptSettings.tool === 'flatten' ? 'bg-blue-600/20 border-blue-500 text-blue-400' : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'}`}
                                            >
                                                <Minus size={16} /> <span className="text-[10px] font-bold uppercase">Flatten</span>
                                            </button>
                                            <button 
                                                onClick={() => actions.setSculptSettings({ ...sculptSettings, tool: 'smooth' })}
                                                className={`p-2 rounded border flex flex-col items-center gap-1 transition-all ${sculptSettings.tool === 'smooth' ? 'bg-green-600/20 border-green-500 text-green-400' : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'}`}
                                            >
                                                <Wind size={16} /> <span className="text-[10px] font-bold uppercase">Smooth</span>
                                            </button>
                                            <button
                                                onClick={() => actions.setSculptSettings({ ...sculptSettings, tool: 'paint' })}
                                                className={`col-span-2 p-2 rounded border flex flex-col items-center gap-1 transition-all ${sculptSettings.tool === 'paint' ? 'bg-purple-600/20 border-purple-500 text-purple-400' : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'}`}
                                            >
                                                <Brush size={16} /> <span className="text-[10px] font-bold uppercase">Paint</span>
                                            </button>
                                        </div>

                                        {sculptSettings.tool === 'flatten' && (
                                            <div className="flex items-center justify-between pt-2">
                                                <span className="text-xs text-gray-400">Target Height</span>
                                                <div className="w-24">
                                                    <ScrubbableInput label="Y" value={sculptSettings.flattenHeight} onChange={(v) => actions.setSculptSettings({ ...sculptSettings, flattenHeight: v })} step={0.5} labelWidth="w-6" />
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    <TerrainLayerPanel
                                        terrain={existingTerrain}
                                        sculptSettings={sculptSettings}
                                        onSculptSettingsChange={actions.setSculptSettings}
                                    />
                                </>
                            ) : (
                                <div className="text-center py-10 text-gray-500 text-xs">
                                    No terrain found.<br/>Go to the Manage tab to create one.
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

// --- Object transform ---

const TransformFields: React.FC<{
    object: LevelObject;
    showScale: boolean;
    onScrub: (updates: ObjectUpdate) => void;
}> = ({ object, showScale, onScrub }) => {
    const setAxis = (field: 'position' | 'rotation' | 'scale', axis: number, value: number) => {
        if (!Number.isFinite(value) || object[field][axis] === value) return;
        const next = [...object[field]] as Vec3;
        next[axis] = value;
        onScrub({ [field]: next });
    };

    return (
        <div className="space-y-3 pt-2 border-t border-gray-800/50">
            <div className="flex items-center justify-between">
                <div className={SECTION_TITLE}><Move size={12} /> Transform</div>
                {object.parentId && <span className="text-[9px] text-gray-500">Local to parent</span>}
            </div>
            <div className="space-y-1">
                <div className="text-[10px] text-gray-400">Position</div>
                <div className="grid grid-cols-3 gap-1">
                    {AXES.map((axis, i) => (
                        <ScrubbableInput
                            key={axis}
                            label={axis}
                            labelColor={AXIS_COLORS[i]}
                            value={object.position[i]}
                            onChange={(v) => setAxis('position', i, v)}
                            step={0.1}
                        />
                    ))}
                </div>
            </div>
            <div className="space-y-1">
                <div className="text-[10px] text-gray-400 flex items-center gap-1"><RotateCw size={10} /> Rotation (Degrees)</div>
                {/* LevelObject.rotation is stored in radians; degrees are presentation only. */}
                <div className="grid grid-cols-3 gap-1">
                    {AXES.map((axis, i) => (
                        <ScrubbableInput
                            key={axis}
                            label={axis}
                            labelColor={AXIS_COLORS[i]}
                            value={toDisplayDegrees(object.rotation[i])}
                            onChange={(v) => {
                                if (v === toDisplayDegrees(object.rotation[i])) return;
                                setAxis('rotation', i, THREE.MathUtils.degToRad(v));
                            }}
                            step={1}
                        />
                    ))}
                </div>
            </div>
            {showScale && (
                <div className="space-y-1">
                    <div className="text-[10px] text-gray-400 flex items-center gap-1"><Scaling size={10} /> Scale</div>
                    <div className="grid grid-cols-3 gap-1">
                        {AXES.map((axis, i) => (
                            <ScrubbableInput
                                key={axis}
                                label={axis}
                                labelColor={AXIS_COLORS[i]}
                                value={object.scale[i]}
                                onChange={(v) => setAxis('scale', i, safeScale(v))}
                                step={0.1}
                            />
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

// --- Parent ---

const ParentField: React.FC<{
    object: LevelObject;
    objects: LevelObject[];
    onReparent: (parentId: string | null) => void;
}> = ({ object, objects, onReparent }) => {
    const options = useMemo(() => {
        // The object's own subtree are exactly the parents that would create a cycle
        // (what wouldCreateCycle checks per candidate), collected in one pass.
        const excluded = new Set(collectSubtree(objects, object.id).map(o => o.id));
        excluded.add(object.id);
        const depth = new Map<string, number>();
        const result: { id: string; label: string }[] = [];
        for (const candidate of sortByHierarchy(objects)) {
            const level = candidate.parentId && depth.has(candidate.parentId) ? depth.get(candidate.parentId)! + 1 : 0;
            depth.set(candidate.id, level);
            if (excluded.has(candidate.id)) continue;
            result.push({ id: candidate.id, label: `${'\u00A0\u00A0'.repeat(level)}${candidate.name || candidate.type}` });
        }
        return result;
    }, [objects, object.id]);

    const current = object.parentId && objects.some(o => o.id === object.parentId) ? object.parentId : '';

    return (
        <div className="space-y-1">
            <label className={SECTION_TITLE}><GitBranch size={12} /> Parent</label>
            <select
                value={current}
                onChange={(e) => onReparent(e.target.value || null)}
                className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs text-white focus:outline-none focus:border-blue-500"
                aria-label="Parent object"
                title="Reparent (keeps the world position)"
            >
                <option value="">(None - level root)</option>
                {options.map(option => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                ))}
            </select>
        </div>
    );
};

// --- Components ---

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const isVec3 = (value: unknown): value is Vec3 =>
    Array.isArray(value) && value.length === 3 && value.every(n => typeof n === 'number' && Number.isFinite(n));
const readNumber = (value: unknown, fallback: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : (typeof fallback === 'number' ? fallback : 0);
const readVector = (value: unknown, fallback: unknown): Vec3 =>
    isVec3(value) ? value : (isVec3(fallback) ? fallback : [0, 0, 0]);
const readColor = (value: unknown, fallback: unknown) =>
    typeof value === 'string' && HEX_COLOR.test(value) ? value : (typeof fallback === 'string' && HEX_COLOR.test(fallback) ? fallback : '#ffffff');
const readString = (value: unknown, fallback: unknown) =>
    typeof value === 'string' ? value : (fallback === undefined || fallback === null ? '' : String(fallback));
const clampToSchema = (value: number, schema: ComponentPropSchema) =>
    Math.min(schema.max ?? Infinity, Math.max(schema.min ?? -Infinity, value));

const PropRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-gray-400 truncate" title={label}>{label}</span>
        {children}
    </div>
);

/** One generated field for a ComponentPropSchema; `continuous` marks scrub/typing edits. */
const ComponentPropField: React.FC<{
    schema: ComponentPropSchema;
    value: unknown;
    onChange: (value: unknown, continuous: boolean) => void;
}> = ({ schema, value, onChange }) => {
    switch (schema.type) {
        case 'number': {
            const current = readNumber(value, schema.default);
            return (
                <PropRow label={schema.label}>
                    <div className="w-24 shrink-0">
                        <ScrubbableInput
                            label="#"
                            value={current}
                            step={schema.step ?? 0.1}
                            labelWidth="w-5"
                            onChange={(v) => {
                                if (!Number.isFinite(v)) return;
                                const next = clampToSchema(v, schema);
                                if (next !== current) onChange(next, true);
                            }}
                        />
                    </div>
                </PropRow>
            );
        }
        case 'boolean':
            return (
                <PropRow label={schema.label}>
                    <input
                        type="checkbox"
                        checked={typeof value === 'boolean' ? value : Boolean(schema.default)}
                        onChange={(e) => onChange(e.target.checked, false)}
                        className="rounded bg-gray-800 border-gray-600 text-blue-500 focus:ring-0"
                        aria-label={schema.label}
                    />
                </PropRow>
            );
        case 'string':
            return (
                <PropRow label={schema.label}>
                    <input
                        value={readString(value, schema.default)}
                        onChange={(e) => onChange(e.target.value, true)}
                        className="w-32 bg-gray-950 border border-gray-800 rounded px-2 h-7 text-[11px] text-white focus:border-blue-500 focus:outline-none"
                        aria-label={schema.label}
                    />
                </PropRow>
            );
        case 'color':
            return (
                <PropRow label={schema.label}>
                    <input
                        type="color"
                        value={readColor(value, schema.default)}
                        onChange={(e) => onChange(e.target.value, true)}
                        className="w-8 h-5 bg-transparent border-none p-0 cursor-pointer"
                        aria-label={schema.label}
                    />
                </PropRow>
            );
        case 'vector3': {
            const current = readVector(value, schema.default);
            return (
                <div className="space-y-1">
                    <span className="text-[10px] text-gray-400">{schema.label}</span>
                    <div className="grid grid-cols-3 gap-1">
                        {AXES.map((axis, i) => (
                            <ScrubbableInput
                                key={axis}
                                label={axis}
                                labelColor={AXIS_COLORS[i]}
                                value={current[i]}
                                step={schema.step ?? 0.1}
                                onChange={(v) => {
                                    if (!Number.isFinite(v)) return;
                                    const next = clampToSchema(v, schema);
                                    if (next === current[i]) return;
                                    const vector = [...current] as Vec3;
                                    vector[i] = next;
                                    onChange(vector, true);
                                }}
                            />
                        ))}
                    </div>
                </div>
            );
        }
        case 'select':
            return (
                <PropRow label={schema.label}>
                    <select
                        value={readString(value, schema.default)}
                        onChange={(e) => onChange(e.target.value, false)}
                        className="w-32 bg-gray-950 border border-gray-800 rounded px-1 h-7 text-[11px] text-white focus:outline-none focus:border-blue-500"
                        aria-label={schema.label}
                    >
                        {(schema.options ?? []).map(option => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                    </select>
                </PropRow>
            );
        default:
            return null;
    }
};

const ComponentsSection: React.FC<{
    object: LevelObject;
    onCommit: (components: LevelComponent[]) => void;
    onScrub: (components: LevelComponent[]) => void;
}> = ({ object, onCommit, onScrub }) => {
    const [menuOpen, setMenuOpen] = useState(false);
    const components = object.components ?? [];

    const patch = (componentId: string, changes: Partial<LevelComponent>) =>
        components.map(component => component.id === componentId ? { ...component, ...changes } : component);

    return (
        <div className="space-y-3 pt-2 border-t border-gray-800/50">
            <div className={SECTION_TITLE}><Puzzle size={12} /> Components</div>

            {components.length === 0 && (
                <div className="text-[10px] text-gray-500 italic">No components. Add one to give this object lights or behaviour.</div>
            )}

            {components.map(component => {
                const definition = getComponentDefinition(component.type);
                return (
                    <div key={component.id} className={`rounded border border-gray-700 bg-gray-800/40 ${component.enabled ? '' : 'opacity-60'}`}>
                        <div className="flex items-center gap-2 px-2 py-1.5 border-b border-gray-700/60">
                            <input
                                type="checkbox"
                                checked={component.enabled}
                                onChange={(e) => onCommit(patch(component.id, { enabled: e.target.checked }))}
                                className="rounded bg-gray-800 border-gray-600 text-blue-500 focus:ring-0"
                                aria-label={`Enable ${definition?.label ?? component.type}`}
                                title={component.enabled ? 'Disable component' : 'Enable component'}
                            />
                            <span className="flex-1 text-xs font-bold text-gray-200 truncate">{definition?.label ?? component.type}</span>
                            <button
                                type="button"
                                onClick={() => onCommit(components.filter(c => c.id !== component.id))}
                                className="text-gray-500 hover:text-red-400 transition-colors"
                                title="Remove component"
                                aria-label={`Remove ${definition?.label ?? component.type}`}
                            >
                                <Trash2 size={12} />
                            </button>
                        </div>
                        <div className="p-2 space-y-2">
                            {definition ? (
                                definition.props.length > 0 ? definition.props.map(schema => (
                                    <ComponentPropField
                                        key={schema.key}
                                        schema={schema}
                                        value={component.props[schema.key]}
                                        onChange={(value, continuous) => {
                                            const next = patch(component.id, { props: { ...component.props, [schema.key]: value } });
                                            if (continuous) onScrub(next);
                                            else onCommit(next);
                                        }}
                                    />
                                )) : (
                                    <div className="text-[10px] text-gray-500">{definition.description}</div>
                                )
                            ) : (
                                <div className="text-[10px] text-amber-400">Unknown component type "{component.type}". Its settings are kept but it has no effect.</div>
                            )}
                            {definition?.Inspector && (
                                <definition.Inspector
                                    object={object}
                                    component={component}
                                    onChangeProps={(changes) => onCommit(patch(component.id, { props: { ...component.props, ...changes } }))}
                                />
                            )}
                        </div>
                    </div>
                );
            })}

            <div className="relative" onKeyDown={(e) => { if (e.key === 'Escape') setMenuOpen(false); }}>
                <button
                    type="button"
                    onClick={() => setMenuOpen(open => !open)}
                    className="w-full py-2 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-300 flex items-center justify-center gap-2 transition-colors"
                    aria-expanded={menuOpen}
                    aria-haspopup="menu"
                >
                    <Plus size={12} /> Add Component
                </button>
                {menuOpen && (
                    <div role="menu" className="mt-1 rounded border border-gray-700 bg-gray-950 shadow-xl overflow-hidden">
                        {COMPONENT_DEFINITIONS.map(definition => (
                            <button
                                key={definition.type}
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                    setMenuOpen(false);
                                    onCommit([...components, createComponent(definition.type)]);
                                }}
                                className="w-full text-left px-3 py-2 hover:bg-gray-800 transition-colors"
                            >
                                <div className="text-xs font-bold text-gray-200">{definition.label}</div>
                                <div className="text-[10px] text-gray-500 leading-snug">{definition.description}</div>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

// --- Multi-selection ---

const MultiSelectionInspector: React.FC<{
    selection: LevelObject[];
    objects: LevelObject[];
    primaryId: string | null;
    edits: InspectorEdits;
    updateLevelObject: (id: string, updates: ObjectUpdate) => void;
    onClear: () => void;
    onDelete: (ids: string[]) => void;
}> = ({ selection, objects, primaryId, edits, updateLevelObject, onClear, onDelete }) => {
    const [move, setMove] = useState<Vec3>([0, 0, 0]);
    const [rotate, setRotate] = useState<Vec3>([0, 0, 0]);
    const [scaleBy, setScaleBy] = useState(1);

    // A selected object whose ancestor is also selected already follows that ancestor;
    // applying the delta to it as well would move it twice.
    const roots = useMemo(() => {
        const selectedIds = new Set(selection.map(o => o.id));
        const byId = new Map(objects.map(o => [o.id, o] as const));
        return selection.filter(object => {
            const visited = new Set<string>([object.id]);
            let parentId = object.parentId ?? null;
            while (parentId && !visited.has(parentId)) {
                if (selectedIds.has(parentId)) return false;
                visited.add(parentId);
                parentId = byId.get(parentId)?.parentId ?? null;
            }
            return true;
        });
    }, [selection, objects]);

    const isZero = (v: Vec3) => v.every(n => n === 0);

    const applyMove = () => edits.commit(() => {
        // Offset in world space, then convert back into each object's parent space.
        const translation = new THREE.Matrix4().makeTranslation(move[0], move[1], move[2]);
        for (const object of roots) {
            const world = translation.clone().multiply(getWorldMatrix(objects, object.id));
            const local = toLocalTransform(objects, object.id, world, object.parentId ?? null);
            updateLevelObject(object.id, { position: local.position });
        }
        setMove([0, 0, 0]);
    });

    const applyRotate = () => edits.commit(() => {
        for (const object of roots) {
            const rotation = object.rotation.map((r, i) => r + THREE.MathUtils.degToRad(rotate[i])) as Vec3;
            updateLevelObject(object.id, { rotation });
        }
        setRotate([0, 0, 0]);
    });

    const applyScale = () => edits.commit(() => {
        for (const object of roots) {
            const scale = object.scale.map(s => safeScale(s * scaleBy)) as Vec3;
            updateLevelObject(object.id, { scale });
        }
        setScaleBy(1);
    });

    const setDelta = (setter: React.Dispatch<React.SetStateAction<Vec3>>, axis: number, value: number) => {
        if (!Number.isFinite(value)) return;
        setter(prev => {
            const next = [...prev] as Vec3;
            next[axis] = value;
            return next;
        });
    };

    const applyButton = 'shrink-0 px-2 h-7 rounded text-[10px] font-bold uppercase bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors';
    const shown = selection.slice(0, MULTI_SELECTION_NAME_LIMIT);

    return (
        <div className="absolute right-0 top-12 bottom-0 z-20 pointer-events-auto flex">
            <div className="w-72 bg-gray-900 border-l border-gray-800 flex flex-col shrink-0 z-20 shadow-xl animate-in slide-in-from-right-10 duration-200 h-full" {...edits.panelHandlers}>
                <div className="flex border-b border-gray-800 bg-gray-950 justify-between items-center p-3 shrink-0">
                    <span className="text-xs font-bold text-gray-300 flex items-center gap-2">
                        <Boxes size={14} className="text-blue-400" /> {selection.length} Objects Selected
                    </span>
                    <button onClick={onClear} className="text-gray-500 hover:text-white transition-colors" title="Clear Selection">
                        <X size={14} />
                    </button>
                </div>

                <div className="p-4 space-y-6 overflow-y-auto custom-scrollbar flex-1">
                    <div className="space-y-1">
                        <div className={SECTION_TITLE}><Layers size={12} /> Selection</div>
                        <ul className="space-y-0.5">
                            {shown.map(object => (
                                <li key={object.id} className="flex items-center justify-between text-[11px] text-gray-300 bg-gray-800/40 rounded px-2 py-1">
                                    <span className="truncate">{object.name || object.type}</span>
                                    {object.id === primaryId && <span className="text-[9px] text-blue-400 uppercase font-bold">Primary</span>}
                                </li>
                            ))}
                        </ul>
                        {selection.length > shown.length && (
                            <div className="text-[10px] text-gray-500">+{selection.length - shown.length} more</div>
                        )}
                        {roots.length < selection.length && (
                            <div className="text-[10px] text-gray-500 leading-relaxed">
                                {selection.length - roots.length} selected object(s) follow a selected parent and are not offset separately.
                            </div>
                        )}
                    </div>

                    <div className="space-y-3 pt-2 border-t border-gray-800/50">
                        <div className={SECTION_TITLE}><Move size={12} /> Shared Transform</div>
                        <div className="space-y-1">
                            <div className="text-[10px] text-gray-400">Move By (World)</div>
                            <div className="flex gap-1">
                                <div className="grid grid-cols-3 gap-1 flex-1">
                                    {AXES.map((axis, i) => (
                                        <ScrubbableInput key={axis} label={axis} labelColor={AXIS_COLORS[i]} value={move[i]} onChange={(v) => setDelta(setMove, i, v)} step={0.1} />
                                    ))}
                                </div>
                                <button type="button" className={applyButton} disabled={isZero(move)} onClick={applyMove}>Apply</button>
                            </div>
                        </div>
                        <div className="space-y-1">
                            <div className="text-[10px] text-gray-400">Rotate By (Degrees, Local)</div>
                            <div className="flex gap-1">
                                <div className="grid grid-cols-3 gap-1 flex-1">
                                    {AXES.map((axis, i) => (
                                        <ScrubbableInput key={axis} label={axis} labelColor={AXIS_COLORS[i]} value={rotate[i]} onChange={(v) => setDelta(setRotate, i, v)} step={1} />
                                    ))}
                                </div>
                                <button type="button" className={applyButton} disabled={isZero(rotate)} onClick={applyRotate}>Apply</button>
                            </div>
                        </div>
                        <div className="space-y-1">
                            <div className="text-[10px] text-gray-400">Scale By (Factor)</div>
                            <div className="flex gap-1">
                                <div className="flex-1">
                                    <ScrubbableInput label="x" value={scaleBy} onChange={(v) => { if (Number.isFinite(v)) setScaleBy(v); }} step={0.1} />
                                </div>
                                <button type="button" className={applyButton} disabled={scaleBy === 1 || scaleBy === 0} onClick={applyScale}>Apply</button>
                            </div>
                        </div>
                    </div>

                    <div className="pt-4 border-t border-gray-800 mt-auto">
                        <button
                            onClick={() => onDelete(selection.map(o => o.id))}
                            className="w-full py-2 bg-red-900/20 hover:bg-red-900/40 text-red-400 border border-red-900/50 rounded text-xs font-bold transition-colors flex items-center justify-center gap-2"
                        >
                            <Trash2 size={14} /> Delete {selection.length} Objects
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export const EnvironmentInspector: React.FC<EnvironmentInspectorProps> = ({ state, selectedObject, actions }) => {
    const { blueprints, audioAssets, levelObjects, removeLevelObjects } = useScene();
    const edits = useInspectorEdits();
    const { interactionMode, paintMode, paintSettings, selectedBrushId, sculptSettings } = state;

    if (interactionMode === 'sculpt') {
        return <TerrainInspector actions={actions} sculptSettings={sculptSettings} />;
    }

    if (interactionMode === 'mask') {
        return (
            <div className="absolute right-0 top-12 bottom-0 z-20 pointer-events-auto flex">
                <EnvironmentMaskTool modelId={selectedBrushId} />
            </div>
        );
    }

    if (interactionMode === 'paint') {
        return (
            <div className="absolute right-0 top-12 bottom-0 z-20 pointer-events-auto flex">
                <EnvironmentBrushPanel
                    mode={paintMode}
                    setMode={actions.setPaintMode}
                    settings={paintSettings}
                    setSettings={actions.setPaintSettings}
                />
            </div>
        );
    }

    const selectedIds = state.selectedObjectIds ?? [];
    if (selectedIds.length > 1) {
        const byId = new Map(levelObjects.map(o => [o.id, o] as const));
        const selection = selectedIds.map(id => byId.get(id)).filter((o): o is LevelObject => !!o);
        if (selection.length > 1) {
            return (
                <MultiSelectionInspector
                    selection={selection}
                    objects={levelObjects}
                    primaryId={state.selectedObjectId}
                    edits={edits}
                    updateLevelObject={actions.updateLevelObject}
                    onClear={() => actions.setSelectedObjectId(null)}
                    onDelete={async (ids) => {
                        if (!await appConfirm(`Delete ${ids.length} objects?`, { acceptLabel: 'Delete', danger: true })) return;
                        if (editorSession.captureReady() !== null) removeLevelObjects(ids);
                        actions.setSelectedObjectId(null);
                    }}
                />
            );
        }
    }

    if (selectedObject) {
        const isSpawner = selectedObject.type === 'spawn_point';
        const isAudio = selectedObject.type === 'audio_emitter';
        const isTerrain = selectedObject.type === 'terrain';
        const isSky = selectedObject.type === 'sky_sphere';
        const isPlayerStart = selectedObject.type === 'player_start';
        const objectId = selectedObject.id;
        // Continuous edits (scrubs, typing, sliders) share one undo step per gesture; discrete ones get their own.
        const scrubUpdate = (updates: ObjectUpdate) => edits.scrub(() => actions.updateLevelObject(objectId, updates));
        const commitUpdate = (updates: ObjectUpdate) => edits.commit(() => actions.updateLevelObject(objectId, updates));
        const reparent = (parentId: string | null) => {
            if ((selectedObject.parentId ?? null) === parentId) return;
            if (wouldCreateCycle(levelObjects, objectId, parentId)) return;
            const moved = reparentPreservingWorld(levelObjects, objectId, parentId);
            commitUpdate({ parentId: moved.parentId ?? null, position: moved.position, rotation: moved.rotation, scale: moved.scale });
        };

        return (
            <div className="absolute right-0 top-12 bottom-0 z-20 pointer-events-auto flex">
                <div className="w-72 bg-gray-900 border-l border-gray-800 flex flex-col shrink-0 z-20 shadow-xl animate-in slide-in-from-right-10 duration-200 h-full" {...edits.panelHandlers}>

                    {/* Header */}
                    <div className="flex border-b border-gray-800 bg-gray-950 justify-between items-center p-3 shrink-0">
                        <span className="text-xs font-bold text-gray-300 flex items-center gap-2">
                            {isSpawner ? <Skull size={14} className="text-red-400"/> :
                             isAudio ? <Music size={14} className="text-amber-400"/> :
                             isTerrain ? <Mountain size={14} className="text-amber-500" /> :
                             isSky ? <Sun size={14} className="text-cyan-400" /> :
                             isPlayerStart ? <PersonStanding size={14} className="text-green-400" /> :
                             <Box size={14} className="text-blue-400"/>}
                            {isSpawner ? 'Spawner Config' : (isAudio ? 'Audio Config' : (isTerrain ? 'Terrain Props' : (isSky ? 'Sky Atmosphere' : (isPlayerStart ? 'Player Start' : 'Object Inspector'))))}
                        </span>
                        <button onClick={() => actions.setSelectedObjectId(null)} className="text-gray-500 hover:text-white transition-colors" title="Deselect Object">
                            <X size={14} />
                        </button>
                    </div>

                    {/* Properties */}
                    <div className="p-4 space-y-6 overflow-y-auto custom-scrollbar flex-1">
                        <div className="space-y-2">
                            <label className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Object Name</label>
                            <input
                                value={selectedObject.name}
                                onChange={(e) => scrubUpdate({ name: e.target.value })}
                                className="w-full bg-gray-800 border border-gray-700 rounded p-2 text-xs text-white focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/20 transition-all"
                                title="Rename Object"
                            />
                            <PrefabInstanceSection object={selectedObject} />
                        </div>

                        <ParentField object={selectedObject} objects={levelObjects} onReparent={reparent} />

                        {!isSky && (
                            <TransformFields object={selectedObject} showScale={!isPlayerStart} onScrub={scrubUpdate} />
                        )}

                        {isPlayerStart && (
                            <p className="text-[10px] text-gray-500 leading-relaxed">
                                The player spawns here when the level starts, facing the green arrow. Only one Player Start is used per level.
                            </p>
                        )}

                        {isTerrain && (
                            <div className="space-y-2 text-xs text-gray-400 bg-gray-800 p-2 rounded">
                                <div>Resolution: {selectedObject.terrainData?.resolution}</div>
                                <div>Size: {selectedObject.terrainData?.width}m x {selectedObject.terrainData?.depth}m</div>
                                {isTerrainHeightfieldPending(selectedObject.terrainData) ? (
                                    <div className="pt-2 text-[10px] italic text-amber-400">Loading terrain heights; sculpting is unavailable until they load.</div>
                                ) : (
                                    <div className="pt-2 text-[10px] italic">Switch to Terrain Mode to sculpt geometry.</div>
                                )}
                            </div>
                        )}

                        {/* --- SKY CONFIGURATION --- */}
                        {isSky && selectedObject.skyConfig && (
                            <div className="space-y-4 pt-2 border-t border-gray-800/50">
                                {/* Time of Day */}
                                <div className="space-y-2">
                                    <div className="flex justify-between items-center">
                                        <span className="text-[10px] font-bold text-cyan-400 uppercase flex items-center gap-1.5">
                                            <Timer size={12} /> Time of Day
                                        </span>
                                        <span className="text-[10px] font-mono text-white">
                                            {Math.floor(selectedObject.skyConfig.timeOfDay)}:{Math.floor((selectedObject.skyConfig.timeOfDay % 1) * 60).toString().padStart(2, '0')}
                                        </span>
                                    </div>
                                    <div className="bg-gray-800 p-2 rounded border border-gray-700">
                                        <input
                                            type="range" min="0" max="24" step="0.1"
                                            value={selectedObject.skyConfig.timeOfDay}
                                            onChange={(e) => scrubUpdate({ skyConfig: { ...selectedObject.skyConfig!, timeOfDay: parseFloat(e.target.value) } })}
                                            className="w-full h-1.5 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-cyan-400"
                                        />
                                        <div className="flex justify-between text-[8px] text-gray-500 mt-1">
                                            <span>6 AM</span><span>NOON</span><span>6 PM</span><span>MIDNIGHT</span>
                                        </div>
                                    </div>
                                </div>

                                {/* Day-night cycle and weather */}
                                <SkyWeatherSection
                                    config={selectedObject.skyConfig}
                                    onScrub={(config) => scrubUpdate({ skyConfig: config })}
                                    onCommit={(config) => commitUpdate({ skyConfig: config })}
                                />

                                {/* Atmosphere */}
                                <div className="space-y-2">
                                    <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                                        <Wind size={12} /> Atmosphere
                                    </div>
                                    <div className="grid grid-cols-2 gap-2">
                                        <ScrubbableInput
                                            label="Turbidity"
                                            value={selectedObject.skyConfig.turbidity}
                                            onChange={(v) => scrubUpdate({ skyConfig: { ...selectedObject.skyConfig!, turbidity: Math.max(0, v) } })}
                                            step={0.1} labelWidth="w-16"
                                        />
                                        <ScrubbableInput
                                            label="Rayleigh"
                                            value={selectedObject.skyConfig.rayleigh}
                                            onChange={(v) => scrubUpdate({ skyConfig: { ...selectedObject.skyConfig!, rayleigh: Math.max(0, v) } })}
                                            step={0.1} labelWidth="w-16"
                                        />
                                        <ScrubbableInput
                                            label="Mie Coeff"
                                            value={selectedObject.skyConfig.mieCoefficient}
                                            onChange={(v) => scrubUpdate({ skyConfig: { ...selectedObject.skyConfig!, mieCoefficient: Math.max(0, v) } })}
                                            step={0.001} labelWidth="w-16"
                                        />
                                        <ScrubbableInput
                                            label="Mie Dir"
                                            value={selectedObject.skyConfig.mieDirectionalG}
                                            onChange={(v) => scrubUpdate({ skyConfig: { ...selectedObject.skyConfig!, mieDirectionalG: Math.max(0, v) } })}
                                            step={0.01} labelWidth="w-16"
                                        />
                                    </div>
                                </div>

                                {/* Lighting & Fog */}
                                <div className="space-y-2">
                                    <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                                        <Sun size={12} /> Light & Fog
                                    </div>
                                    <div className="space-y-2 bg-gray-800 p-2 rounded border border-gray-700">
                                        <div className="flex items-center justify-between">
                                            <span className="text-[10px] text-gray-400">Sun Intensity</span>
                                            <div className="w-16">
                                                <ScrubbableInput label="" value={selectedObject.skyConfig.sunIntensity} onChange={(v) => scrubUpdate({ skyConfig: { ...selectedObject.skyConfig!, sunIntensity: Math.max(0, v) } })} step={0.1} labelWidth="w-0" />
                                            </div>
                                        </div>
                                        <div className="flex items-center justify-between">
                                            <span className="text-[10px] text-gray-400">Ambience</span>
                                            <div className="w-16">
                                                <ScrubbableInput label="" value={selectedObject.skyConfig.ambienceIntensity} onChange={(v) => scrubUpdate({ skyConfig: { ...selectedObject.skyConfig!, ambienceIntensity: Math.max(0, v) } })} step={0.1} labelWidth="w-0" />
                                            </div>
                                        </div>

                                        <div className="flex items-center justify-between" title="How far from the camera the sun casts shadows. 0 keeps them near what the camera looks at.">
                                            <span className="text-[10px] text-gray-400">Shadow Distance</span>
                                            <div className="w-16">
                                                <ScrubbableInput label="" value={selectedObject.skyConfig.shadowDistance ?? DEFAULT_SHADOW_DISTANCE} onChange={(v) => scrubUpdate({ skyConfig: { ...selectedObject.skyConfig!, shadowDistance: Math.min(2000, Math.max(0, Math.round(v))) } })} step={10} labelWidth="w-0" />
                                            </div>
                                        </div>

                                        <div className="h-px bg-gray-700 my-1" />

                                        <div className="flex items-center justify-between">
                                            <span className="text-[10px] text-gray-400 flex items-center gap-1"><CloudFog size={10}/> Fog Density</span>
                                            <div className="w-16">
                                                <ScrubbableInput label="" value={selectedObject.skyConfig.fogDensity} onChange={(v) => scrubUpdate({ skyConfig: { ...selectedObject.skyConfig!, fogDensity: Math.max(0, v) } })} step={0.001} labelWidth="w-0" />
                                            </div>
                                        </div>
                                        <div className="flex items-center justify-between">
                                            <span className="text-[10px] text-gray-400">Fog Color</span>
                                            <input
                                                type="color"
                                                value={selectedObject.skyConfig.fogColor}
                                                onChange={(e) => scrubUpdate({ skyConfig: { ...selectedObject.skyConfig!, fogColor: e.target.value } })}
                                                className="w-6 h-4 bg-transparent border-none p-0 cursor-pointer"
                                            />
                                        </div>
                                    </div>
                                </div>

                                {/* Reset to Default */}
                                <button
                                    onClick={() => commitUpdate({ skyConfig: DEFAULT_SKY_CONFIG })}
                                    className="w-full py-2 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-400 flex items-center justify-center gap-2 transition-colors"
                                >
                                    <RotateCcw size={12} /> Reset to Default
                                </button>
                            </div>
                        )}

                        {/* --- SPAWNER CONFIGURATION --- */}
                        {isSpawner && (() => {
                            const spawn = selectedObject.spawnConfig ?? DEFAULT_SPAWN_CONFIG;
                            const splinePaths = levelObjects.filter(candidate => candidate.levelId === selectedObject.levelId && findSplineComponent(candidate) !== null);
                            const enemies = blueprints.filter(blueprint => blueprint.type === 'Enemy Controller');
                            const missing = !!spawn.blueprintId && !enemies.some(blueprint => blueprint.id === spawn.blueprintId);
                            return (
                                <div className="space-y-4 pt-2 border-t border-gray-800/50">
                                    <div className="space-y-3 bg-red-950/20 p-3 rounded border border-red-900/30">
                                        <div className="flex items-center gap-2 text-xs font-bold text-red-400 uppercase tracking-wide">
                                            <Users size={12} /> Spawning
                                        </div>
                                        <div className="space-y-1">
                                            <label className="text-[10px] font-medium text-gray-400 flex items-center gap-1.5">
                                                <UserPlus size={10} /> Enemy
                                            </label>
                                            <select
                                                value={missing ? '' : spawn.blueprintId}
                                                onChange={(e) => commitUpdate({ spawnConfig: { ...spawn, blueprintId: e.target.value } })}
                                                className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-xs text-white focus:outline-none focus:border-red-500"
                                                title="The enemy blueprint this spawner creates"
                                            >
                                                <option value="">-- Select Enemy --</option>
                                                {enemies.map(blueprint => (
                                                    <option key={blueprint.id} value={blueprint.id}>{blueprint.name}</option>
                                                ))}
                                            </select>
                                            {!spawn.blueprintId || missing ? (
                                                <p className="text-[10px] text-amber-400 flex items-start gap-1.5 pt-1">
                                                    <AlertTriangle size={10} className="shrink-0 mt-0.5" />
                                                    {enemies.length
                                                        ? 'Choose an enemy. The spawner creates nothing until one is set.'
                                                        : 'Create an Enemy blueprint in the Blueprints tab, then choose it here.'}
                                                </p>
                                            ) : null}
                                        </div>
                                        <div className="grid grid-cols-2 gap-2">
                                            <ScrubbableInput
                                                label="Every (s)"
                                                value={spawn.interval}
                                                onChange={(v) => scrubUpdate({ spawnConfig: { ...spawn, interval: Math.max(MIN_SPAWN_INTERVAL, v) } })}
                                                step={0.5} labelWidth="w-16"
                                            />
                                            <ScrubbableInput
                                                label="Max"
                                                value={spawn.maxSpawns}
                                                onChange={(v) => scrubUpdate({ spawnConfig: { ...spawn, maxSpawns: Math.max(0, Math.round(v)) } })}
                                                step={1} labelWidth="w-10"
                                            />
                                        </div>
                                        <div className="space-y-1">
                                            <label className="text-[10px] font-medium text-gray-400 flex items-center gap-1.5">
                                                <Route size={10} /> Patrol Path
                                            </label>
                                            <select
                                                aria-label="Patrol Path"
                                                value={spawn.patrolPath ?? ''}
                                                onChange={(e) => commitUpdate({ spawnConfig: { ...spawn, patrolPath: e.target.value || undefined } })}
                                                className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-xs text-white focus:outline-none focus:border-red-500"
                                                title="An object with a Spline component the enemies patrol along, instead of wandering around where they spawned"
                                            >
                                                <option value="">None (wander)</option>
                                                {spawn.patrolPath && !splinePaths.some(path => path.id === spawn.patrolPath) && <option value={spawn.patrolPath}>Missing path</option>}
                                                {splinePaths.map(path => <option key={path.id} value={path.id}>{path.name}</option>)}
                                            </select>
                                        </div>
                                        <p className="text-[10px] text-gray-500 leading-relaxed flex items-start gap-1.5">
                                            <Hash size={10} className="shrink-0 mt-0.5" />
                                            {spawn.maxSpawns > 0
                                                ? `Spawns one enemy every ${spawn.interval} s around this point, ${spawn.maxSpawns} in all.`
                                                : `Spawns one enemy every ${spawn.interval} s around this point, with no limit (Max 0).`}
                                        </p>
                                    </div>
                                </div>
                            );
                        })()}

                        {/* --- AUDIO CONFIGURATION --- */}
                        {isAudio && (
                            <div className="space-y-4 pt-2 border-t border-gray-800/50">
                                <div className="space-y-3 bg-amber-950/20 p-3 rounded border border-amber-900/30">
                                    <div className="flex items-center gap-2 text-xs font-bold text-amber-400 uppercase tracking-wide">
                                        <Volume2 size={12} /> Sound Properties
                                    </div>

                                    {/* Audio File Selector */}
                                    <div className="space-y-1">
                                        <label className="text-[10px] font-medium text-gray-400 flex items-center gap-1.5">
                                            <Music size={10} /> Source File
                                        </label>
                                        <select
                                            value={selectedObject.audioConfig?.audioId || ''}
                                            onChange={(e) => commitUpdate({
                                                audioConfig: {
                                                    volume: 1.0,
                                                    loop: true,
                                                    autoplay: true,
                                                    muted: false,
                                                    isSpatial: true,
                                                    refDistance: 1,
                                                    maxDistance: 10,
                                                    rolloffFactor: 1,
                                                    loopStart: 0,
                                                    ...selectedObject.audioConfig,
                                                    audioId: e.target.value
                                                }
                                            })}
                                            className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-xs text-white focus:outline-none focus:border-amber-500"
                                        >
                                            <option value="" disabled>-- Select Audio --</option>
                                            {audioAssets.map(a => (
                                                <option key={a.id} value={a.id}>{a.name}</option>
                                            ))}
                                        </select>
                                    </div>

                                    {/* Waveform Editor (Only if audio is selected) */}
                                    {selectedObject.audioConfig?.audioId && (
                                        <WaveformEditor
                                            audioUrl={audioAssets.find(a => a.id === selectedObject.audioConfig?.audioId)?.url || ''}
                                            loopStart={selectedObject.audioConfig?.loopStart}
                                            loopEnd={selectedObject.audioConfig?.loopEnd}
                                            onChangeLoopStart={(val) => scrubUpdate({
                                                audioConfig: { ...selectedObject.audioConfig!, loopStart: val }
                                            })}
                                            onChangeLoopEnd={(val) => scrubUpdate({
                                                audioConfig: { ...selectedObject.audioConfig!, loopEnd: val }
                                            })}
                                        />
                                    )}

                                    {/* Mute Toggle */}
                                    <div className="flex items-center justify-between bg-gray-900 p-2 rounded border border-gray-800">
                                        <span className="text-[10px] text-gray-400 font-bold uppercase flex items-center gap-1.5">
                                            <VolumeX size={10} /> Mute
                                        </span>
                                        <input
                                            type="checkbox"
                                            checked={selectedObject.audioConfig?.muted ?? false}
                                            onChange={(e) => commitUpdate({
                                                audioConfig: { ...selectedObject.audioConfig!, muted: e.target.checked }
                                            })}
                                            className="rounded bg-gray-800 border-gray-600 text-red-500 focus:ring-0"
                                        />
                                    </div>

                                    {/* Spatial Toggle */}
                                    <div className="flex items-center justify-between bg-gray-900 p-2 rounded border border-gray-800">
                                        <span className="text-[10px] text-gray-400 font-bold uppercase flex items-center gap-1.5">
                                            <Radio size={10} /> 3D Spatial
                                        </span>
                                        <input
                                            type="checkbox"
                                            checked={selectedObject.audioConfig?.isSpatial ?? true}
                                            onChange={(e) => commitUpdate({
                                                audioConfig: { ...selectedObject.audioConfig!, isSpatial: e.target.checked }
                                            })}
                                            className="rounded bg-gray-800 border-gray-600 text-amber-500 focus:ring-0"
                                        />
                                    </div>

                                    {/* Loop Toggle */}
                                    <div className="flex items-center justify-between bg-gray-900 p-2 rounded border border-gray-800">
                                        <span className="text-[10px] text-gray-400 font-bold uppercase flex items-center gap-1.5">
                                            <Repeat size={10} /> Loop
                                        </span>
                                        <input
                                            type="checkbox"
                                            checked={selectedObject.audioConfig?.loop ?? true}
                                            onChange={(e) => commitUpdate({
                                                audioConfig: { ...selectedObject.audioConfig!, loop: e.target.checked }
                                            })}
                                            className="rounded bg-gray-800 border-gray-600 text-amber-500 focus:ring-0"
                                        />
                                    </div>
                                </div>
                            </div>
                        )}

                        <ComponentsSection
                            key={objectId}
                            object={selectedObject}
                            onCommit={(components) => commitUpdate({ components })}
                            onScrub={(components) => scrubUpdate({ components })}
                        />

                        {/* Generic Delete Button */}
                        <div className="pt-4 border-t border-gray-800 mt-auto">
                            <button
                                onClick={async () => {
                                    if (!await appConfirm(`Delete "${selectedObject.name}"?`, { acceptLabel: 'Delete', danger: true })) return;
                                    actions.removeLevelObject(selectedObject.id);
                                    actions.setSelectedObjectId(null);
                                }}
                                className="w-full py-2 bg-red-900/20 hover:bg-red-900/40 text-red-400 border border-red-900/50 rounded text-xs font-bold transition-colors flex items-center justify-center gap-2"
                            >
                                <Trash2 size={14} /> Delete Object
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return null;
};
