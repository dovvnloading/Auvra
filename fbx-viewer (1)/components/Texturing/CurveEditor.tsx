import React, { useRef, useState } from 'react';
import { readCurves, sampleCurve } from '../../texturing/graph/nodeKit';
import type { CurvePoint, CurveSet } from '../../texturing/graph/types';
import { Segmented } from '../UI/kit';
import type { Histogram } from './view2d';

/**
 * A tone curve per channel: drag points, click empty space to add one, double-click a point to take it
 * away. The master curve applies to every channel first. The histogram of the node's input shows
 * behind the curve, for the channel being edited.
 */

const SIZE = 220;
const CHANNELS: ReadonlyArray<{ value: keyof CurveSet; label: string; color: string }> = [
    { value: 'all', label: 'All', color: '#e4e4e7' },
    { value: 'r', label: 'R', color: '#f87171' },
    { value: 'g', label: 'G', color: '#4ade80' },
    { value: 'b', label: 'B', color: '#60a5fa' },
    { value: 'a', label: 'A', color: '#a1a1aa' },
];

export const CurveEditor: React.FC<{ value: unknown; onChange: (curves: CurveSet) => void; histogram?: Histogram | null }> = ({ value, onChange, histogram }) => {
    const curves = readCurves(value);
    const [channel, setChannel] = useState<keyof CurveSet>('all');
    const svg = useRef<SVGSVGElement>(null);
    const dragging = useRef<number | null>(null);
    const points = [...curves[channel]].sort((a, b) => a.x - b.x);
    const color = CHANNELS.find((item) => item.value === channel)!.color;

    const toPoint = (clientX: number, clientY: number): CurvePoint => {
        const box = svg.current!.getBoundingClientRect();
        return { x: Math.min(1, Math.max(0, (clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, 1 - (clientY - box.top) / box.height)) };
    };
    const set = (next: CurvePoint[]) => onChange({ ...curves, [channel]: next.map((p) => ({ x: Number(p.x.toFixed(4)), y: Number(p.y.toFixed(4)) })) });

    const bins = histogram ? (channel === 'r' ? histogram.red : channel === 'g' ? histogram.green : channel === 'b' ? histogram.blue : channel === 'all' ? histogram.luma : null) : null;
    const peak = bins ? Math.max(1, ...bins) : 1;
    const path = Array.from({ length: 65 }, (_, i) => {
        const x = i / 64;
        return `${i ? 'L' : 'M'} ${x * SIZE} ${(1 - sampleCurve(points, x)) * SIZE}`;
    }).join(' ');

    return (
        <div className="space-y-1.5">
            <Segmented value={channel} options={CHANNELS.map(({ value: v, label }) => ({ value: v, label }))} onChange={setChannel} label="Curve channel" />
            <svg
                ref={svg}
                viewBox={`0 0 ${SIZE} ${SIZE}`}
                className="block w-full touch-none rounded border border-line bg-panel"
                onPointerDown={(event) => {
                    const at = toPoint(event.clientX, event.clientY);
                    const hit = points.findIndex((p) => Math.hypot((p.x - at.x) * SIZE, (p.y - at.y) * SIZE) < 9);
                    (event.target as Element).setPointerCapture?.(event.pointerId);
                    if (hit >= 0) { dragging.current = hit; return; }
                    const next = [...points, at].sort((a, b) => a.x - b.x);
                    dragging.current = next.indexOf(at);
                    set(next);
                }}
                onPointerMove={(event) => {
                    if (dragging.current === null) return;
                    const at = toPoint(event.clientX, event.clientY);
                    const index = dragging.current;
                    const lo = index > 0 ? points[index - 1].x + 0.005 : 0;
                    const hi = index < points.length - 1 ? points[index + 1].x - 0.005 : 1;
                    set(points.map((p, i) => (i === index ? { x: Math.min(hi, Math.max(lo, at.x)), y: at.y } : p)));
                }}
                onPointerUp={() => { dragging.current = null; }}
                onDoubleClick={(event) => {
                    const at = toPoint(event.clientX, event.clientY);
                    const hit = points.findIndex((p) => Math.hypot((p.x - at.x) * SIZE, (p.y - at.y) * SIZE) < 9);
                    if (hit >= 0 && points.length > 2) set(points.filter((_, i) => i !== hit));
                }}
            >
                {bins && bins.map((count, index) => {
                    const height = Math.sqrt(count / peak) * SIZE * 0.9;
                    return <rect key={`bin:${index}`} x={(index / bins.length) * SIZE} y={SIZE - height} width={SIZE / bins.length + 0.4} height={height} fill={color} opacity={0.14} />;
                })}
                {[0.25, 0.5, 0.75].map((t) => (
                    <g key={t} stroke="#27272a">
                        <line x1={t * SIZE} y1={0} x2={t * SIZE} y2={SIZE} />
                        <line x1={0} y1={t * SIZE} x2={SIZE} y2={t * SIZE} />
                    </g>
                ))}
                <line x1={0} y1={SIZE} x2={SIZE} y2={0} stroke="#3f3f46" strokeDasharray="4 4" />
                <path d={path} stroke={color} strokeWidth={2} fill="none" />
                {points.map((p, i) => <circle key={i} cx={p.x * SIZE} cy={(1 - p.y) * SIZE} r={5} fill="#18181b" stroke={color} strokeWidth={2} />)}
            </svg>
            <div className="flex justify-between text-2xs text-ink-3">
                <span>Click to add a point, double-click to remove</span>
                <button className="hover:text-ink-2" onClick={() => set([{ x: 0, y: 0 }, { x: 1, y: 1 }])}>Reset</button>
            </div>
        </div>
    );
};
