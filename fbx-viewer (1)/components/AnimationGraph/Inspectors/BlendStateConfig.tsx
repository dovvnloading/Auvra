import React, { useEffect, useState } from 'react';
import { Activity, Plus, X } from 'lucide-react';
import { BlendSample, GraphState } from '../../../types';
import { Select } from '../../UI/Select';
import { blendSpaceTriangles } from '../utils/blending';

interface BlendStateConfigProps {
    node: GraphState;
    updateState: (updates: Partial<GraphState>) => void;
    clipOptions: { label: string; value: string }[];
    blendParamOptions: { label: string; value: string }[];
}

const finiteOrZero = (value: number) => (Number.isFinite(value) ? value : 0);

/** Parses typed text as a number, or null when it is not a finite number. */
const parseFinite = (text: string): number | null => {
    if (text.trim() === '') return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
};

const displayNumber = (value: number) => (Number.isFinite(value) ? String(value) : '');

const formatAxis = (value: number) => String(Number(value.toFixed(2)));

/** Range of one axis over the samples, widened so no samples or a single value still spans something. */
const axisRange = (values: number[]): [number, number] => {
    if (!values.length) return [-1, 1];
    const min = Math.min(...values);
    const max = Math.max(...values);
    return min === max ? [min - 1, max + 1] : [min, max];
};

interface PositionInputProps {
    label: string;
    ariaLabel: string;
    value: number;
    onChange: (value: number) => void;
}

/** Number field that keeps partial text such as "-" or "1." while typing and only commits finite numbers. */
const PositionInput: React.FC<PositionInputProps> = ({ label, ariaLabel, value, onChange }) => {
    const [text, setText] = useState(() => displayNumber(value));

    useEffect(() => {
        setText(current => (parseFinite(current) === value ? current : displayNumber(value)));
    }, [value]);

    return (
        <div className="flex items-center gap-2 flex-1">
            <span className="text-[9px] text-gray-500 font-bold font-mono">{label}</span>
            <input
                type="number" step="0.1"
                aria-label={ariaLabel}
                value={text}
                onChange={(e) => {
                    setText(e.target.value);
                    const parsed = parseFinite(e.target.value);
                    if (parsed !== null && parsed !== value) onChange(parsed);
                }}
                onBlur={() => setText(displayNumber(value))}
                className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-[10px] text-white focus:border-gray-500 focus:outline-none"
            />
        </div>
    );
};

const PLOT_WIDTH = 240;
/** Keeps samples at the ends of a range off the plot frame. */
const PLOT_INSET = 8;

interface BlendSpacePlotProps {
    samples: BlendSample[];
    is1D: boolean;
    xLabel: string;
    yLabel: string;
}

/** The sample positions of a blend space, its triangulation (2D) and the range of each axis. */
const BlendSpacePlot: React.FC<BlendSpacePlotProps> = ({ samples, is1D, xLabel, yLabel }) => {
    const height = is1D ? 50 : 150;
    const left = is1D ? 10 : 34;
    const right = PLOT_WIDTH - 10;
    const top = 8;
    const bottom = height - 18;
    const points = samples.map((sample): [number, number] => [finiteOrZero(sample.position[0]), finiteOrZero(sample.position[1])]);
    const [xMin, xMax] = axisRange(points.map(point => point[0]));
    const [yMin, yMax] = axisRange(points.map(point => point[1]));
    const toX = (value: number) => left + PLOT_INSET + ((value - xMin) / (xMax - xMin)) * (right - left - 2 * PLOT_INSET);
    const toY = (value: number) => (is1D
        ? (top + bottom) / 2
        : top + PLOT_INSET + ((yMax - value) / (yMax - yMin)) * (bottom - top - 2 * PLOT_INSET));
    const triangles = is1D ? [] : blendSpaceTriangles(samples);
    const ranges = `${xLabel} ${formatAxis(xMin)} to ${formatAxis(xMax)}` + (is1D ? '' : `, ${yLabel} ${formatAxis(yMin)} to ${formatAxis(yMax)}`);

    return (
        <svg
            viewBox={`0 0 ${PLOT_WIDTH} ${height}`}
            className="w-full h-auto block"
            role="img"
            aria-label={`Blend space sample positions, ${ranges}`}
        >
            <rect x={left} y={top} width={right - left} height={bottom - top} fill="none" stroke="currentColor" className="text-gray-700" />
            <g stroke="currentColor" strokeDasharray="2 2" className="text-gray-700">
                {xMin < 0 && xMax > 0 && <line x1={toX(0)} y1={top} x2={toX(0)} y2={bottom} />}
                {!is1D && yMin < 0 && yMax > 0 && <line x1={left} y1={toY(0)} x2={right} y2={toY(0)} />}
            </g>
            {is1D && <line x1={left} y1={toY(0)} x2={right} y2={toY(0)} stroke="currentColor" className="text-gray-600" />}
            <g fill="none" stroke="currentColor" strokeWidth={0.75} className="text-gray-600">
                {triangles.map(triangle => (
                    <polygon key={triangle.join('-')} points={triangle.map(index => `${toX(points[index][0])},${toY(points[index][1])}`).join(' ')} />
                ))}
            </g>
            {points.map((point, index) => (
                <g key={samples[index].id}>
                    <circle
                        cx={toX(point[0])}
                        cy={toY(point[1])}
                        r={3.5}
                        fill={samples[index].clipName ? 'currentColor' : 'none'}
                        stroke="currentColor"
                        className={samples[index].clipName ? 'text-gray-200' : 'text-gray-500'}
                    />
                    <text x={toX(point[0]) + 5} y={toY(point[1]) - 5} fontSize={7} fill="currentColor" className="text-gray-400 font-mono">
                        {index + 1}
                    </text>
                </g>
            ))}
            <g fontSize={7} fill="currentColor" className="text-gray-500 font-mono">
                <text x={toX(xMin)} y={bottom + 10} textAnchor="middle">{formatAxis(xMin)}</text>
                <text x={toX(xMax)} y={bottom + 10} textAnchor="middle">{formatAxis(xMax)}</text>
                <text x={(left + right) / 2} y={bottom + 10} textAnchor="middle" className="text-gray-400">{xLabel}</text>
                {!is1D && (
                    <>
                        <text x={left - 3} y={toY(yMax) + 2.5} textAnchor="end">{formatAxis(yMax)}</text>
                        <text x={left - 3} y={toY(yMin) + 2.5} textAnchor="end">{formatAxis(yMin)}</text>
                        <text x={7} y={(top + bottom) / 2} textAnchor="middle" transform={`rotate(-90 7 ${(top + bottom) / 2})`} className="text-gray-400">
                            {yLabel}
                        </text>
                    </>
                )}
            </g>
        </svg>
    );
};

export const BlendStateConfig: React.FC<BlendStateConfigProps> = ({
    node,
    updateState,
    clipOptions,
    blendParamOptions
}) => {
    const is1D = node.stateType === 'Blend1D';
    const paramLabel = (id: string, fallback: string) => blendParamOptions.find(option => option.value === id)?.label || fallback;
    const setSamplePosition = (index: number, axis: 0 | 1, value: number) => {
        const updatedSamples = node.blendSamples.map((s, i) => {
            if (i !== index) return s;
            const position: [number, number] = [s.position[0], s.position[1]];
            position[axis] = value;
            return { ...s, position };
        });
        updateState({ blendSamples: updatedSamples });
    };

    return (
        <div className="space-y-4">
            {/* Parameters */}
            <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
                <div className="p-3 bg-gray-800 border-b border-gray-700">
                    <span className="text-xs font-medium text-gray-200 flex items-center gap-2">
                        <Activity size={12} className="text-gray-400" /> Parameters
                    </span>
                </div>
                <div className={`p-3 grid gap-3 ${is1D ? 'grid-cols-1' : 'grid-cols-2'}`}>
                    <div className="space-y-1.5">
                        <label className="text-[9px] uppercase text-gray-500 font-bold">X Axis</label>
                        <Select
                            value={node.blendParamX}
                            onChange={(val) => updateState({ blendParamX: val })}
                            options={blendParamOptions}
                        />
                    </div>
                    {!is1D && (
                        <div className="space-y-1.5">
                            <label className="text-[9px] uppercase text-gray-500 font-bold">Y Axis</label>
                            <Select
                                value={node.blendParamY}
                                onChange={(val) => updateState({ blendParamY: val })}
                                options={blendParamOptions}
                            />
                        </div>
                    )}
                </div>
            </div>

            {/* Samples List */}
            <div className="space-y-3">
                <div className="flex items-center justify-between px-1">
                    <label className="text-[10px] uppercase text-gray-500 font-bold tracking-wider">Motion Samples</label>
                    <button
                        onClick={() => {
                            const newSample = { id: crypto.randomUUID(), clipName: '', position: [0, 0] as [number, number] };
                            updateState({ blendSamples: [...node.blendSamples, newSample] });
                        }}
                        className="text-[10px] px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded border border-gray-700 text-gray-300 hover:text-white transition-colors flex items-center gap-1"
                    >
                        <Plus size={10} /> Add
                    </button>
                </div>

                <div className="bg-gray-900/50 rounded-lg border border-gray-800 p-2">
                    <BlendSpacePlot
                        samples={node.blendSamples}
                        is1D={is1D}
                        xLabel={paramLabel(node.blendParamX, 'X')}
                        yLabel={paramLabel(node.blendParamY, 'Y')}
                    />
                </div>

                <div className="space-y-2">
                    {node.blendSamples.map((sample, idx) => (
                        <div key={sample.id} className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
                            <div className="flex items-center gap-2 p-2 border-b border-gray-700/50 bg-gray-800">
                                <span className="text-[9px] text-gray-500 font-bold font-mono w-3 text-center">{idx + 1}</span>
                                <div className="flex-1 min-w-0">
                                    <Select
                                        value={sample.clipName}
                                        onChange={(val) => {
                                            const updatedSamples = node.blendSamples.map((s, i) => i === idx ? { ...s, clipName: val } : s);
                                            updateState({ blendSamples: updatedSamples });
                                        }}
                                        options={clipOptions}
                                        placeholder="-- Select Clip --"
                                    />
                                </div>
                                <button
                                    onClick={() => {
                                        const updatedSamples = node.blendSamples.filter(s => s.id !== sample.id);
                                        updateState({ blendSamples: updatedSamples });
                                    }}
                                    aria-label={`Remove sample ${idx + 1}`}
                                    className="text-gray-500 hover:text-red-400 p-1"
                                >
                                    <X size={12} />
                                </button>
                            </div>
                            <div className="p-2 flex gap-2 bg-gray-900/30">
                                <PositionInput
                                    label="X"
                                    ariaLabel={`Sample ${idx + 1} X position`}
                                    value={sample.position[0]}
                                    onChange={(value) => setSamplePosition(idx, 0, value)}
                                />
                                {!is1D && (
                                    <PositionInput
                                        label="Y"
                                        ariaLabel={`Sample ${idx + 1} Y position`}
                                        value={sample.position[1]}
                                        onChange={(value) => setSamplePosition(idx, 1, value)}
                                    />
                                )}
                            </div>
                        </div>
                    ))}
                    {node.blendSamples.length === 0 && (
                        <div className="text-center py-4 border border-dashed border-gray-800 rounded bg-gray-900/50">
                            <p className="text-[10px] text-gray-600">No motion samples added.</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};