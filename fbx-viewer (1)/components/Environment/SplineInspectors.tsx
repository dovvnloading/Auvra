import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, Box, Mountain, Paintbrush, Plus, Route, Trash2, Waypoints } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import type { ComponentInspectorProps } from '../../runtime/components/types';
import { findSplineComponent } from '../../runtime/splineRegistry';
import {
    appendSplinePoint,
    buildSpline,
    insertSplinePointAt,
    readSplineData,
    removeSplinePoint,
    reverseSpline,
    updateSplinePoint,
    writeSplineData,
    type SplineData,
    type SplinePointMode,
    type SplineVec3,
} from '../../runtime/splines';
import { terrainSurfaceHeight } from '../../runtime/terrainPhysics';
import { getWorldMatrix } from '../../utils/sceneGraph';
import { splineEditing, useSplineSelection } from './splineEditing';
import { DEFAULT_SPLINE_TERRAIN_BRUSH, flattenTerrainAlongSpline, paintTerrainAlongSpline, pointHeightsOnTerrain, type SplineTerrainBrush } from './splineTerrain';

/**
 * Inspectors for the spline components (runtime/components/splineComponents.tsx): the Spline's
 * points and terrain tools, the model a Spline Mesh or Spline Scatter lays down, and the spline a
 * Follow Spline follows.
 */

const FIELD = 'w-full bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-2xs text-gray-200 focus:outline-none focus:border-fuchsia-500';
const BUTTON = 'flex items-center justify-center gap-1 px-2 py-1 rounded border border-gray-700 bg-gray-800 hover:bg-gray-700 text-2xs text-gray-200 disabled:opacity-40 disabled:hover:bg-gray-800 transition-colors';
const LABEL = 'text-2xs text-gray-400';

const MODE_LABELS: Record<SplinePointMode, string> = { auto: 'Smooth', linear: 'Corner', custom: 'Custom tangent' };

/** A number typed in and taken on Enter or when the field is left. */
const NumberField: React.FC<{ label: string; value: number; onCommit: (value: number) => void; step?: number }> = ({ label, value, onCommit, step = 0.1 }) => {
    const shown = String(Math.round(value * 1000) / 1000);
    const [text, setText] = useState(shown);
    useEffect(() => setText(shown), [shown]);
    const take = () => {
        const parsed = Number(text);
        if (Number.isFinite(parsed) && parsed !== value) onCommit(parsed);
        else setText(shown);
    };
    return (
        <label className="flex items-center gap-1 min-w-0">
            <span className="text-2xs text-gray-500 shrink-0">{label}</span>
            <input
                aria-label={label}
                type="number"
                step={step}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onBlur={take}
                onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }}
                className={FIELD}
            />
        </label>
    );
};

const VectorFields: React.FC<{ label: string; value: SplineVec3; onCommit: (value: SplineVec3) => void }> = ({ label, value, onCommit }) => (
    <div className="space-y-0.5">
        <div className={LABEL}>{label}</div>
        <div className="grid grid-cols-3 gap-1">
            {(['X', 'Y', 'Z'] as const).map((axis, i) => (
                <NumberField
                    key={axis}
                    label={axis}
                    value={value[i]}
                    onCommit={(next) => {
                        const vector = [...value] as SplineVec3;
                        vector[i] = next;
                        onCommit(vector);
                    }}
                />
            ))}
        </div>
    </div>
);

const format = (value: number) => (Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1));

// --- SPLINE ---

export const SplineInspector: React.FC<ComponentInspectorProps> = ({ object, component, onChangeProps }) => {
    const { levelObjects, updateLevelObject, snapshotHistory } = useScene();
    const selection = useSplineSelection();
    const data = useMemo(() => readSplineData(component.props), [component.props]);
    const spline = useMemo(() => buildSpline(data), [data]);
    const selected = selection?.componentId === component.id && selection.index < data.points.length ? selection.index : null;
    const point = selected !== null ? data.points[selected] : null;
    const [brush, setBrush] = useState<SplineTerrainBrush>(DEFAULT_SPLINE_TERRAIN_BRUSH);
    const [layer, setLayer] = useState(1);
    const [notice, setNotice] = useState<string | null>(null);
    const otherSpline = findSplineComponent(object)?.id !== component.id;

    const write = (next: SplineData) => onChangeProps(writeSplineData(next));
    const choose = (index: number) => splineEditing.set({ objectId: object.id, componentId: component.id, index, handle: 'point' });
    const editPoint = (patch: Parameters<typeof updateSplinePoint>[2]) => {
        if (selected === null) return;
        write(updateSplinePoint(data, selected, patch));
    };

    const terrains = levelObjects.filter(candidate => candidate.type === 'terrain' && candidate.levelId === object.levelId);
    const matrix = () => getWorldMatrix(levelObjects, object.id);

    const shapeTerrain = (kind: 'flatten' | 'paint') => {
        const world = matrix();
        const changes = terrains.flatMap((terrain) => {
            const result = kind === 'flatten'
                ? flattenTerrainAlongSpline(terrain, spline, world, brush)
                : paintTerrainAlongSpline(terrain, spline, world, brush, layer - 1);
            return result ? [{ terrain, result }] : [];
        });
        if (changes.length === 0) {
            setNotice(terrains.length === 0 ? 'This level has no terrain.' : 'The spline does not cross a terrain (or its heights are still loading).');
            return;
        }
        snapshotHistory();
        for (const { terrain, result } of changes) {
            updateLevelObject(terrain.id, { terrainData: { ...terrain.terrainData!, ...(kind === 'flatten' ? { heights: result } : { splat: result }) } });
        }
        setNotice(kind === 'flatten' ? `Flattened ${changes.length === 1 ? 'the terrain' : `${changes.length} terrains`} under the spline.` : `Painted layer ${layer} under the spline.`);
    };

    const snapToTerrain = () => {
        const surface = (x: number, z: number) => {
            let best: number | null = null;
            for (const terrain of terrains) {
                const height = terrainSurfaceHeight(x, z, terrain);
                if (height !== null && (best === null || height > best)) best = height;
            }
            return best;
        };
        const heights = pointHeightsOnTerrain(data.points.map(entry => entry.position), matrix(), surface);
        if (heights.every(entry => entry === null)) {
            setNotice('No point is over a terrain.');
            return;
        }
        write({ ...data, points: data.points.map((entry, i) => (heights[i] ? { ...entry, position: heights[i]! } : entry)) });
        setNotice(null);
    };

    return (
        <div className="space-y-2">
            {otherSpline && <p className="text-2xs text-amber-400">Spline Mesh, Scatter and Follow Spline use the object's first Spline; this one is drawn but not used.</p>}
            <div className="flex items-center justify-between text-2xs text-gray-400">
                <span className="flex items-center gap-1"><Route size={10} /> {format(spline.length)} m</span>
                <span>{data.points.length} points{data.closed ? ', closed' : ''}</span>
            </div>

            <div className="max-h-36 overflow-y-auto custom-scrollbar rounded border border-gray-800 divide-y divide-gray-800/60" role="listbox" aria-label="Spline points">
                {data.points.map((entry, index) => (
                    <button
                        key={index}
                        type="button"
                        role="option"
                        aria-selected={selected === index}
                        onClick={() => choose(index)}
                        className={`w-full flex items-center gap-2 px-2 py-0.5 text-left text-2xs font-mono ${selected === index ? 'bg-fuchsia-900/30 text-white' : 'text-gray-400 hover:bg-gray-800'}`}
                    >
                        <span className={`w-5 ${index === 0 ? 'text-green-400' : ''}`}>{index + 1}</span>
                        <span className="flex-1 truncate">{entry.position.map(format).join(', ')}</span>
                        <span className="text-gray-500">{entry.mode === 'auto' ? '' : entry.mode === 'linear' ? 'corner' : 'custom'}</span>
                    </button>
                ))}
            </div>

            <div className="grid grid-cols-2 gap-1">
                <button type="button" className={BUTTON} onClick={() => { const added = appendSplinePoint(data); write(added.data); choose(added.index); }}>
                    <Plus size={10} /> Add at end
                </button>
                <button
                    type="button"
                    className={BUTTON}
                    disabled={selected === null || (!data.closed && selected >= data.points.length - 1)}
                    onClick={() => {
                        if (selected === null) return;
                        const from = spline.distanceAtPoint(selected);
                        const to = selected + 1 < data.points.length ? spline.distanceAtPoint(selected + 1) : spline.length;
                        const inserted = insertSplinePointAt(data, (from + to) / 2);
                        if (inserted.index < 0) return;
                        write(inserted.data);
                        choose(inserted.index);
                    }}
                >
                    <Waypoints size={10} /> Insert after
                </button>
                <button
                    type="button"
                    className={BUTTON}
                    disabled={selected === null || data.points.length <= 2}
                    onClick={() => {
                        if (selected === null) return;
                        write(removeSplinePoint(data, selected));
                        choose(Math.min(selected, data.points.length - 2));
                    }}
                >
                    <Trash2 size={10} /> Delete point
                </button>
                <button type="button" className={BUTTON} onClick={() => { write(reverseSpline(data)); if (selected !== null) choose(data.points.length - 1 - selected); }}>
                    <ArrowLeftRight size={10} /> Reverse
                </button>
            </div>

            {point && selected !== null ? (
                <div className="space-y-1.5 rounded border border-fuchsia-900/50 bg-fuchsia-950/10 p-2">
                    <div className="text-2xs font-bold text-fuchsia-200">Point {selected + 1}</div>
                    <VectorFields label="Position" value={point.position} onCommit={(position) => editPoint({ position })} />
                    <label className="flex items-center justify-between gap-2">
                        <span className={LABEL}>Type</span>
                        <select
                            aria-label="Point type"
                            value={point.mode}
                            onChange={(event) => {
                                const mode = event.target.value as SplinePointMode;
                                // A point turned custom starts from the tangent it had.
                                const tangent = mode === 'custom' && point.mode !== 'custom' ? spline.pointTangent(selected).toArray() as SplineVec3 : point.tangent;
                                editPoint({ mode, tangent });
                            }}
                            className={`${FIELD} w-36`}
                        >
                            {(Object.keys(MODE_LABELS) as SplinePointMode[]).map(mode => <option key={mode} value={mode}>{MODE_LABELS[mode]}</option>)}
                        </select>
                    </label>
                    {point.mode === 'custom' && <VectorFields label="Tangent" value={point.tangent} onCommit={(tangent) => editPoint({ tangent })} />}
                    <div className="grid grid-cols-3 gap-1">
                        <NumberField label="Roll°" value={point.roll} step={1} onCommit={(roll) => editPoint({ roll })} />
                        <NumberField label="W" value={point.scale[0]} step={0.05} onCommit={(width) => editPoint({ scale: [Math.max(0.001, width), point.scale[1]] })} />
                        <NumberField label="H" value={point.scale[1]} step={0.05} onCommit={(height) => editPoint({ scale: [point.scale[0], Math.max(0.001, height)] })} />
                    </div>
                </div>
            ) : (
                <p className="text-2xs text-gray-500 leading-snug">
                    Click a point in the viewport or the list to move, turn (tangent and roll) or scale it with the gizmo.
                    Alt-drag a point to add one; Ctrl-click the curve to add one there; Delete removes the selected point.
                </p>
            )}

            <div className="space-y-1.5 pt-1 border-t border-gray-800/60">
                <div className="flex items-center gap-1 text-2xs font-bold text-gray-300"><Mountain size={10} /> Terrain</div>
                <div className="grid grid-cols-3 gap-1">
                    <NumberField label="Width" value={brush.width} onCommit={(width) => setBrush({ ...brush, width: Math.max(0.1, width) })} />
                    <NumberField label="Falloff" value={brush.falloff} onCommit={(falloff) => setBrush({ ...brush, falloff: Math.max(0, falloff) })} />
                    <NumberField label="Depth" value={brush.depth} onCommit={(depth) => setBrush({ ...brush, depth })} />
                </div>
                <div className="grid grid-cols-2 gap-1">
                    <button type="button" className={BUTTON} onClick={() => shapeTerrain('flatten')}><Mountain size={10} /> Flatten under</button>
                    <button type="button" className={BUTTON} onClick={snapToTerrain}><Waypoints size={10} /> Snap points</button>
                </div>
                <div className="flex items-center gap-1">
                    <select aria-label="Terrain layer" value={layer} onChange={(event) => setLayer(Number(event.target.value))} className={`${FIELD} w-20`}>
                        {[1, 2, 3, 4].map(entry => <option key={entry} value={entry}>Layer {entry}</option>)}
                    </select>
                    <button type="button" className={`${BUTTON} flex-1`} onClick={() => shapeTerrain('paint')}><Paintbrush size={10} /> Paint under</button>
                </div>
                {notice && <p className="text-2xs text-gray-400">{notice}</p>}
            </div>
        </div>
    );
};

// --- SPLINE MESH / SCATTER ---

/** Picks the model a Spline Mesh or Spline Scatter lays along the spline. */
export const SplineModelInspector: React.FC<ComponentInspectorProps> = ({ object, component, onChangeProps }) => {
    const { models } = useScene();
    const modelId = typeof component.props.modelId === 'string' ? component.props.modelId : '';
    const choices = models.filter(model => model.category !== 'Animation' && model.category !== 'Character');
    const known = !modelId || models.some(model => model.id === modelId);
    const hasSpline = findSplineComponent(object) !== null;
    return (
        <div className="space-y-1">
            <label className="flex items-center gap-1 text-2xs text-gray-400"><Box size={10} /> Model</label>
            <select
                aria-label="Model"
                value={modelId}
                onChange={(event) => onChangeProps({ modelId: event.target.value })}
                className={FIELD}
            >
                <option value="">None</option>
                {!known && <option value={modelId}>Missing model</option>}
                {choices.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
            {!modelId && <p className="text-2xs text-amber-400">Pick the model to lay along the spline.</p>}
            {!hasSpline && <p className="text-2xs text-amber-400">Add a Spline component to this object: this lays its model along it.</p>}
        </div>
    );
};

// --- FOLLOW SPLINE ---

/** Picks the object whose spline a Follow Spline follows. */
export const FollowSplineInspector: React.FC<ComponentInspectorProps> = ({ object, component, onChangeProps }) => {
    const { levelObjects } = useScene();
    const target = typeof component.props.spline === 'string' ? component.props.spline : '';
    const choices = levelObjects.filter(candidate => candidate.id !== object.id && findSplineComponent(candidate) !== null);
    const known = !target || choices.some(candidate => candidate.id === target);
    return (
        <div className="space-y-1">
            <label className="flex items-center gap-1 text-2xs text-gray-400"><Route size={10} /> Spline to follow</label>
            <select aria-label="Spline to follow" value={target} onChange={(event) => onChangeProps({ spline: event.target.value })} className={FIELD}>
                <option value="">None</option>
                {!known && <option value={target}>Missing spline</option>}
                {choices.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </select>
            {choices.length === 0 && <p className="text-2xs text-amber-400">No other object in the level has a Spline component.</p>}
            {choices.length > 0 && !target && <p className="text-2xs text-amber-400">Pick the object whose spline this one moves along.</p>}
        </div>
    );
};
