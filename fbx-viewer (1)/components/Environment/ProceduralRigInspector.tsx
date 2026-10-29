import React, { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useScene } from '../../context/SceneContext';
import type { ComponentInspectorProps } from '../../runtime/components/types';
import {
    DEFAULT_RIG_CONSTRAINT,
    RIG_AXES,
    RIG_CONSTRAINT_KINDS,
    readRigConstraints,
    type RigConstraint,
    type RigConstraintKind,
    type RigTarget,
} from '../../runtime/proceduralRig';

const FIELD = 'w-full bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200 focus:outline-none focus:border-amber-500';
const BUTTON = 'flex items-center justify-center gap-1 px-2 py-0.5 rounded border border-gray-700 bg-gray-800 hover:bg-gray-700 text-[10px] text-gray-200';
const LABEL = 'text-[10px] text-gray-400';

const KIND_LABELS: Record<RigConstraintKind, string> = {
    aim: 'Aim at', copyRotation: 'Copy rotation', offset: 'Offset', limit: 'Limit', lag: 'Lag behind', twist: 'Twist from',
};

const TextInput: React.FC<{ label: string; value: string; placeholder?: string; onCommit: (value: string) => void }> = ({ label, value, placeholder, onCommit }) => {
    const [text, setText] = useState(value);
    useEffect(() => setText(value), [value]);
    return (
        <input aria-label={label} value={text} placeholder={placeholder} onChange={(event) => setText(event.target.value)}
            onBlur={() => { if (text !== value) onCommit(text.trim()); }}
            onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }} className={FIELD} />
    );
};

const NumberInput: React.FC<{ label: string; value: number; step?: number; onCommit: (value: number) => void }> = ({ label, value, step = 1, onCommit }) => {
    const shown = String(Math.round(value * 1000) / 1000);
    const [text, setText] = useState(shown);
    useEffect(() => setText(shown), [shown]);
    const take = () => {
        const parsed = Number(text);
        if (Number.isFinite(parsed) && parsed !== value) onCommit(parsed);
        else setText(shown);
    };
    return (
        <input aria-label={label} type="number" step={step} value={text} onChange={(event) => setText(event.target.value)} onBlur={take}
            onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }} className={FIELD} />
    );
};

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <label className="grid grid-cols-[76px_1fr] items-center gap-2"><span className={LABEL}>{label}</span>{children}</label>
);

const Angles: React.FC<{ label: string; value: [number, number, number]; onCommit: (value: [number, number, number]) => void }> = ({ label, value, onCommit }) => (
    <Row label={label}>
        <div className="grid grid-cols-3 gap-1">
            {(['X', 'Y', 'Z'] as const).map((axis, i) => (
                <NumberInput key={axis} label={`${label} ${axis}`} value={value[i]} step={5} onCommit={(next) => onCommit(value.map((v, j) => (j === i ? next : v)) as [number, number, number])} />
            ))}
        </div>
    </Row>
);

/** The Procedural Rig component's constraints, applied top to bottom after the animation. */
export const ProceduralRigInspector: React.FC<ComponentInspectorProps> = ({ component, onChangeProps }) => {
    const { levelObjects } = useScene();
    const constraints = readRigConstraints(component.props);
    const commit = (next: RigConstraint[]) => onChangeProps({ constraints: next });
    const update = (index: number, change: Partial<RigConstraint>) => commit(constraints.map((c, i) => (i === index ? { ...c, ...change } : c)));
    const move = (index: number, by: number) => {
        const next = [...constraints];
        const [item] = next.splice(index, 1);
        next.splice(Math.max(0, Math.min(next.length, index + by)), 0, item);
        commit(next);
    };
    const targetValue = (target: RigTarget) => (target.kind === 'object' ? `object:${target.id}` : target.kind);
    const readTarget = (value: string, current: RigTarget): RigTarget => {
        if (value === 'camera' || value === 'player') return { kind: value };
        if (value === 'point') return { kind: 'point', point: current.kind === 'point' ? current.point : [0, 1.5, 5] };
        return { kind: 'object', id: value.slice('object:'.length) };
    };

    return (
        <div className="space-y-2">
            {constraints.map((c, index) => (
                <div key={index} className="space-y-1 rounded border border-gray-800 bg-gray-900/60 p-1.5">
                    <div className="grid grid-cols-[1fr_14px_14px_14px] items-center gap-1">
                        <select aria-label={`Constraint ${index + 1} kind`} value={c.kind} onChange={(event) => update(index, { kind: event.target.value as RigConstraintKind })} className={FIELD}>
                            {RIG_CONSTRAINT_KINDS.map(kind => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}
                        </select>
                        <button type="button" aria-label={`Move constraint ${index + 1} up`} onClick={() => move(index, -1)} className="text-gray-500 hover:text-gray-200"><ArrowUp size={11} /></button>
                        <button type="button" aria-label={`Move constraint ${index + 1} down`} onClick={() => move(index, 1)} className="text-gray-500 hover:text-gray-200"><ArrowDown size={11} /></button>
                        <button type="button" aria-label={`Remove constraint ${index + 1}`} onClick={() => commit(constraints.filter((_, i) => i !== index))} className="text-gray-500 hover:text-red-400"><Trash2 size={11} /></button>
                    </div>
                    <Row label="Bone"><TextInput label={`Constraint ${index + 1} bone`} value={c.bone} placeholder="Head" onCommit={(bone) => update(index, { bone })} /></Row>
                    <Row label="Weight"><NumberInput label={`Constraint ${index + 1} weight`} value={c.weight} step={0.05} onCommit={(weight) => update(index, { weight })} /></Row>
                    {c.kind === 'aim' && (
                        <>
                            <Row label="At">
                                <select aria-label={`Constraint ${index + 1} target`} value={targetValue(c.target)} onChange={(event) => update(index, { target: readTarget(event.target.value, c.target) })} className={FIELD}>
                                    <option value="camera">The camera</option>
                                    <option value="player">The player</option>
                                    <option value="point">A point</option>
                                    {levelObjects.map(entry => <option key={entry.id} value={`object:${entry.id}`}>{entry.name}</option>)}
                                </select>
                            </Row>
                            {c.target.kind === 'point' && <Angles label="Point (m)" value={c.target.point} onCommit={(point) => update(index, { target: { kind: 'point', point } })} />}
                            <Row label="Axis">
                                <select aria-label={`Constraint ${index + 1} axis`} value={c.axis} onChange={(event) => update(index, { axis: event.target.value as RigConstraint['axis'] })} className={FIELD}>
                                    {RIG_AXES.map(axis => <option key={axis} value={axis}>{axis}</option>)}
                                </select>
                            </Row>
                            <Row label="Up to (°)"><NumberInput label={`Constraint ${index + 1} max angle`} value={c.maxAngle} step={5} onCommit={(maxAngle) => update(index, { maxAngle })} /></Row>
                        </>
                    )}
                    {(c.kind === 'copyRotation' || c.kind === 'twist') && (
                        <Row label="From bone"><TextInput label={`Constraint ${index + 1} source bone`} value={c.source} placeholder="Spine2" onCommit={(source) => update(index, { source })} /></Row>
                    )}
                    {c.kind === 'copyRotation' && (
                        <Row label="Axes">
                            <div className="flex items-center gap-2 text-[10px] text-gray-300">
                                {(['X', 'Y', 'Z'] as const).map((axis, i) => (
                                    <label key={axis} className="flex items-center gap-1">
                                        <input type="checkbox" aria-label={`Constraint ${index + 1} copies ${axis}`} checked={c.axes[i]}
                                            onChange={(event) => update(index, { axes: c.axes.map((on, j) => (j === i ? event.target.checked : on)) as [boolean, boolean, boolean] })} />{axis}
                                    </label>
                                ))}
                                <label className="flex items-center gap-1">
                                    <input type="checkbox" aria-label={`Constraint ${index + 1} adds`} checked={c.additive} onChange={(event) => update(index, { additive: event.target.checked })} />Add
                                </label>
                            </div>
                        </Row>
                    )}
                    {c.kind === 'twist' && (
                        <Row label="About">
                            <select aria-label={`Constraint ${index + 1} twist axis`} value={c.axis} onChange={(event) => update(index, { axis: event.target.value as RigConstraint['axis'] })} className={FIELD}>
                                {RIG_AXES.map(axis => <option key={axis} value={axis}>{axis}</option>)}
                            </select>
                        </Row>
                    )}
                    {c.kind === 'offset' && <Angles label="Turn (°)" value={c.angles} onCommit={(angles) => update(index, { angles })} />}
                    {c.kind === 'limit' && (
                        <>
                            <Angles label="Lowest (°)" value={c.angles} onCommit={(angles) => update(index, { angles })} />
                            <Angles label="Highest (°)" value={c.max} onCommit={(max) => update(index, { max })} />
                        </>
                    )}
                    {c.kind === 'lag' && (
                        <>
                            <Row label="Stiffness"><NumberInput label={`Constraint ${index + 1} stiffness`} value={c.stiffness} step={0.5} onCommit={(stiffness) => update(index, { stiffness })} /></Row>
                            <Row label="Bounce"><NumberInput label={`Constraint ${index + 1} bounce`} value={c.bounce} step={0.05} onCommit={(bounce) => update(index, { bounce })} /></Row>
                        </>
                    )}
                </div>
            ))}
            {constraints.length < 32 && (
                <button type="button" className={BUTTON} onClick={() => commit([...constraints, { ...DEFAULT_RIG_CONSTRAINT, bone: 'Head' }])}><Plus size={10} /> Constraint</button>
            )}
            <p className="text-[10px] text-gray-500">Bones are found by name ('Head' finds 'mixamorig:Head'). Constraints apply top to bottom, after the animation and before the IK components that follow.</p>
        </div>
    );
};
