import React from 'react';
import { Plus, Spline, X } from 'lucide-react';
import { AnimCurve, AnimCurveKey } from '../../../types';
import { Select } from '../../UI/Select';
import { ScrubbableInput } from '../../UI/Properties/ScrubbableInput';
import { sampleCurve } from '../utils/curves';

interface CurvesEditorProps {
    curves: AnimCurve[];
    onChange: (curves: AnimCurve[]) => void;
    /** The graph's variables a curve can drive, led by a None entry (value ''). */
    variableOptions: { label: string; value: string }[];
    /** Length of the state's clip in seconds, when it is loaded; the graph spans it. */
    clipDuration?: number;
}

const GRAPH_WIDTH = 240;
const GRAPH_HEIGHT = 40;
const GRAPH_STEPS = 48;

/** The curve drawn over the clip, with its keys marked. */
const CurveGraph: React.FC<{ keys: AnimCurveKey[]; duration: number }> = ({ keys, duration }) => {
    const values = keys.map(key => key.value);
    const low = Math.min(0, ...values);
    const high = Math.max(1, ...values);
    const x = (time: number) => (Math.min(Math.max(time, 0), duration) / duration) * GRAPH_WIDTH;
    const y = (value: number) => GRAPH_HEIGHT - 2 - ((value - low) / (high - low)) * (GRAPH_HEIGHT - 4);
    const line = Array.from({ length: GRAPH_STEPS + 1 }, (_, step) => {
        const time = (step / GRAPH_STEPS) * duration;
        return `${step === 0 ? 'M' : 'L'}${x(time).toFixed(1)},${y(sampleCurve(keys, time)).toFixed(1)}`;
    }).join(' ');
    return (
        <svg viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`} className="w-full h-10 bg-gray-950 rounded border border-gray-800" preserveAspectRatio="none" aria-hidden="true">
            <path d={line} fill="none" stroke="#a78bfa" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            {keys.map((key, index) => (
                <circle key={index} cx={x(key.time)} cy={y(key.value)} r={2.5} fill="#ddd6fe" />
            ))}
        </svg>
    );
};

/** Curves of a Single state: values keyed over its clip that set graph variables while it plays. */
export const CurvesEditor: React.FC<CurvesEditorProps> = ({ curves, onChange, variableOptions, clipDuration }) => {
    const updateCurve = (id: string, updates: Partial<AnimCurve>) => {
        onChange(curves.map(curve => (curve.id === id ? { ...curve, ...updates } : curve)));
    };
    const updateKey = (curve: AnimCurve, index: number, updates: Partial<AnimCurveKey>) => {
        updateCurve(curve.id, { keys: curve.keys.map((key, i) => (i === index ? { ...key, ...updates } : key)) });
    };

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between px-1">
                <label className="text-[10px] uppercase text-gray-500 font-bold tracking-wider flex items-center gap-1.5">
                    <Spline size={10} /> Curves
                </label>
                <button
                    onClick={() => onChange([...curves, {
                        id: crypto.randomUUID(),
                        variableId: '',
                        keys: [{ time: 0, value: 0 }, { time: clipDuration && clipDuration > 0 ? clipDuration : 1, value: 1 }],
                    }])}
                    aria-label="Add curve"
                    className="text-[10px] px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded border border-gray-700 text-gray-300 hover:text-white transition-colors flex items-center gap-1"
                >
                    <Plus size={10} /> Add
                </button>
            </div>

            <div className="space-y-2">
                {curves.map((curve) => {
                    const lastTime = curve.keys.reduce((latest, key) => Math.max(latest, key.time), 0);
                    const duration = clipDuration && clipDuration > 0 ? Math.max(clipDuration, lastTime) : Math.max(lastTime, 1);
                    return (
                        <div key={curve.id} className="bg-gray-800 rounded-lg border border-gray-700 p-2 space-y-2" data-curve-id={curve.id}>
                            <div className="flex items-center gap-2">
                                <div className="flex-1 min-w-0">
                                    <Select
                                        value={curve.variableId}
                                        onChange={(val) => updateCurve(curve.id, { variableId: val })}
                                        options={variableOptions}
                                        placeholder="Drives variable"
                                    />
                                </div>
                                <button
                                    onClick={() => onChange(curves.filter(item => item.id !== curve.id))}
                                    aria-label="Remove curve"
                                    className="text-gray-500 hover:text-red-400 p-1"
                                >
                                    <X size={12} />
                                </button>
                            </div>
                            <CurveGraph keys={curve.keys} duration={duration} />
                            {curve.keys.map((key, index) => (
                                <div key={index} className="flex items-center gap-1">
                                    <ScrubbableInput
                                        label="Time"
                                        labelWidth="w-9"
                                        step={0.01}
                                        value={Number.isFinite(key.time) ? key.time : 0}
                                        onChange={(val) => { if (Number.isFinite(val)) updateKey(curve, index, { time: Math.max(0, val) }); }}
                                    />
                                    <ScrubbableInput
                                        label="Value"
                                        labelWidth="w-9"
                                        step={0.05}
                                        value={Number.isFinite(key.value) ? key.value : 0}
                                        onChange={(val) => { if (Number.isFinite(val)) updateKey(curve, index, { value: val }); }}
                                    />
                                    <button
                                        onClick={() => updateCurve(curve.id, { keys: curve.keys.filter((_, i) => i !== index) })}
                                        aria-label="Remove key"
                                        disabled={curve.keys.length <= 1}
                                        className="text-gray-500 hover:text-red-400 disabled:opacity-30 p-1 shrink-0"
                                    >
                                        <X size={10} />
                                    </button>
                                </div>
                            ))}
                            <button
                                onClick={() => {
                                    const last = curve.keys[curve.keys.length - 1];
                                    const time = Math.min(duration, (last?.time ?? 0) + duration / 4);
                                    updateCurve(curve.id, { keys: [...curve.keys, { time, value: last?.value ?? 0 }] });
                                }}
                                className="w-full text-[10px] py-1 rounded border border-dashed border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition-colors"
                            >
                                Add key
                            </button>
                        </div>
                    );
                })}
                {curves.length === 0 && (
                    <div className="text-center py-4 border border-dashed border-gray-800 rounded bg-gray-900/50">
                        <p className="text-[10px] text-gray-600">No curves. A curve sets a variable from the clip&apos;s time while this state plays (a Boolean is on above 0.5), so transitions and other systems can follow it.</p>
                    </div>
                )}
            </div>
        </div>
    );
};
