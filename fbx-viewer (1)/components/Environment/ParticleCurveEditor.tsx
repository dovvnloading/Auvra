import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { evaluateCurve, particleCurveSegment, PARTICLE_CURVE_INTERPOLATIONS, type Curve } from '../../runtime/particleEffect';

type Point = [number, number];
const LIMIT = 8;
const WIDTH = 220, HEIGHT = 104, PAD = 8;
const MIN_SPACING = 0.001;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Number(v.toFixed(4));
const button = 'rounded border border-gray-700 px-1.5 py-0.5 text-2xs text-gray-200 hover:bg-gray-800 focus-visible:outline-amber-400 disabled:opacity-35';
const input = 'w-full min-w-0 rounded border border-gray-700 bg-gray-950 px-1.5 py-0.5 text-2xs text-gray-200 focus:border-amber-500';
const labelText = 'text-2xs text-gray-400';
const xAt = (t: number) => PAD + t * (WIDTH - PAD * 2);
const yAt = (v: number, top: number) => HEIGHT - PAD - (v / top) * (HEIGHT - PAD * 2);

function plot(curve: Curve, top: number): string {
    const mode = curve.interpolation ?? 'linear';
    const keys = mode === 'linear' ? curve.points : curve.points.filter((p, i) => p[0] !== curve.points[i + 1]?.[0]);
    let line = `M ${xAt(0)} ${yAt(keys[0][1], top)} H ${xAt(keys[0][0])}`;
    for (let i = 1; i < keys.length; i++) {
        const [start, a] = keys[i - 1];
        const [end, b] = keys[i];
        if (mode === 'step') line += ` H ${xAt(end)} V ${yAt(b, top)}`;
        else if (mode === 'smooth') {
            // Cubic Hermite to Bézier, using the same coefficients as the simulation.
            const [, l, q, c] = particleCurveSegment(keys, i - 1, mode);
            const third = (end - start) / 3;
            line += ` C ${xAt(start + third)} ${yAt(a + l / 3, top)} ${xAt(end - third)} ${yAt(b - (l + 2 * q + 3 * c) / 3, top)} ${xAt(end)} ${yAt(b, top)}`;
        } else line += ` L ${xAt(end)} ${yAt(b, top)}`;
    }
    return line + ` H ${xAt(1)}`;
}

const CurveNumber: React.FC<{ label: string; value: number; step: number; max: number; commit: (n: number) => void }> =
    ({ label, value, step, max, commit }) => {
        const [text, setText] = useState(String(value));
        useEffect(() => setText(String(value)), [value]);
        return <label className={labelText}>{label}
            <input className={input} type="number" step={step} min={0} max={max} value={text}
                onChange={e => setText(e.target.value)}
                onBlur={() => {
                    setText(String(value));
                    if (text.trim() && Number.isFinite(Number(text))) commit(Number(text));
                }}
                onKeyDown={e => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') { e.stopPropagation(); setText(String(value)); }
                }} />
        </label>;
    };

interface Drag { index: number; pointer: number; original: Curve; top: number; points: Point[] }

export const ParticleCurveEditor: React.FC<{
    label: string; domain: 'Lifetime' | 'Cycle'; maximum: number; value: Curve; onCommit: (curve: Curve) => void;
}> = ({ label, domain, maximum, value, onCommit }) => {
    const [selection, select] = useState(0);
    const [draft, setDraft] = useState<Point[] | null>(null);
    const drag = useRef<Drag | null>(null);
    const svg = useRef<SVGSVGElement>(null);
    const hint = useId();
    const points = draft ?? value.points;
    const selected = Math.min(selection, points.length - 1);
    const [time, amount] = points[selected];
    // Freeze the vertical scale until release so a dragged key stays under the pointer.
    const top = drag.current?.top ?? Math.min(maximum, Math.max(2, Math.ceil(Math.max(...points.map(p => p[1])) * 1.25)));
    // resolveParticleEffect can return fresh but equivalent data. Only a content change supersedes a drag.
    const signature = JSON.stringify(value);
    const cancel = () => { drag.current = null; setDraft(null); };
    useLayoutEffect(() => { cancel(); }, [signature]);
    const keyButtons = () => svg.current?.querySelectorAll<SVGCircleElement>('[data-curve-key]');
    const focusKey = (index: number) => {
        select(index);
        requestAnimationFrame(() => keyButtons()?.[index]?.focus());
    };
    const editPoint = (source: Point[], index: number, t: number, v: number): Point[] => {
        // Keep the key's identity and order. Older curves may already have coincident keys.
        const before = index ? Math.min(source[index][0], source[index - 1][0] + MIN_SPACING) : 0;
        const after = index + 1 < source.length ? Math.max(source[index][0], source[index + 1][0] - MIN_SPACING) : 1;
        const next: Point = [clamp(t, before, after), clamp(v, 0, maximum)];
        return next[0] === source[index][0] && next[1] === source[index][1]
            ? source : source.map((point, i) => i === index ? next : point);
    };
    const commit = (next: Point[]) => { if (next !== value.points) onCommit({ ...value, points: next }); };
    const add = (t?: number, v?: number) => {
        if (points.length >= LIMIT) return;
        if (t === undefined) {
            const times = [0, ...points.map(p => p[0]), 1];
            let widest = 0;
            t = 0.5;
            for (let i = 1; i < times.length; i++) {
                const width = times[i] - times[i - 1];
                if (width > widest) { widest = width; t = (times[i] + times[i - 1]) / 2; }
            }
        }
        if (points.some(p => Math.abs(p[0] - t!) < MIN_SPACING)) return;
        const key: Point = [t, v ?? evaluateCurve(points, t, value.interpolation)];
        const next = [...points, key].sort((a, b) => a[0] - b[0]);
        commit(next);
        focusKey(next.indexOf(key));
    };
    const remove = (index: number) => {
        if (points.length < 2) return;
        commit(points.filter((_, i) => i !== index));
        focusKey(Math.min(index, points.length - 2));
    };
    const position = (e: React.PointerEvent | React.MouseEvent): Point | null => {
        const box = svg.current?.getBoundingClientRect();
        if (!box?.width || !box.height) return null;
        const x = (e.clientX - box.left) / box.width * WIDTH;
        const y = (e.clientY - box.top) / box.height * HEIGHT;
        return [round(clamp((x - PAD) / (WIDTH - 2 * PAD), 0, 1)), round(clamp((HEIGHT - PAD - y) / (HEIGHT - 2 * PAD), 0, 1) * top)];
    };
    const modes = { linear: 'Linear', step: 'Step', smooth: 'Smooth' };
    return (
        <fieldset className="min-w-0 space-y-1 rounded border border-gray-800 p-1.5">
            <legend className="px-1 text-2xs font-semibold text-gray-300">{label}</legend>
            <label className="flex items-center justify-between gap-2 text-2xs text-gray-400">Interpolation
                <select className={button + ' bg-gray-950'} value={value.interpolation ?? 'linear'}
                    onChange={e => onCommit({ ...value, interpolation: e.target.value as Curve['interpolation'] })}>
                    {PARTICLE_CURVE_INTERPOLATIONS.map(mode => <option key={mode} value={mode}>{modes[mode]}</option>)}
                </select>
            </label>
            <div className="flex justify-between text-2xs text-gray-500"><span>Multiplier</span><span>{top}×</span></div>
            <svg ref={svg} role="group" aria-label={`${label} plot`} aria-describedby={hint} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none"
                className="block h-24 w-full touch-none rounded border border-gray-800 bg-gray-950"
                onDoubleClick={e => {
                    if ((e.target as Element).hasAttribute('data-curve-key')) return;
                    const p = position(e);
                    if (p) add(...p);
                }}
                onPointerMove={e => {
                    const d = drag.current;
                    const p = position(e);
                    if (!d || d.pointer !== e.pointerId || !p) return;
                    d.points = editPoint(d.original.points, d.index, ...p);
                    setDraft(d.points);
                }}
                onPointerUp={e => {
                    const d = drag.current;
                    if (!d || d.pointer !== e.pointerId) return;
                    cancel();
                    if (d.points !== d.original.points) onCommit({ ...value, points: d.points });
                }}
                onPointerCancel={e => { if (drag.current?.pointer === e.pointerId) cancel(); }}
                onLostPointerCapture={e => { if (drag.current?.pointer === e.pointerId) cancel(); }}>
                <path d={`M ${PAD} ${yAt(1, top)} H ${WIDTH - PAD}`} stroke="#4b5563" strokeDasharray="3 3" />
                <path d={plot({ ...value, points }, top)} stroke="#f59e0b" strokeWidth="1.6" fill="none" pointerEvents="none" />
                {points.map(([t, v], index) => (
                    <circle key={index} data-curve-key={index} role="button" tabIndex={0}
                        aria-label={`${label} key ${index + 1}, ${round(t * 100)}%, ${round(v)} times`} aria-pressed={selected === index}
                        cx={xAt(t)} cy={yAt(v, top)} r={selected === index ? 5 : 4}
                        fill={selected === index ? '#fbbf24' : '#1f2937'} stroke="#fde68a"
                        className="cursor-grab focus:outline-white active:cursor-grabbing"
                        onFocus={() => select(index)}
                        onPointerDown={e => {
                            if (e.button !== 0 || drag.current) return;
                            e.preventDefault();
                            e.currentTarget.focus();
                            select(index);
                            drag.current = { pointer: e.pointerId, index, original: value, top, points: value.points };
                            svg.current?.setPointerCapture(e.pointerId);
                        }}
                        onKeyDown={e => {
                            const step = e.shiftKey ? 10 : 1;
                            if (e.key === 'Escape') cancel();
                            else if (drag.current) return;
                            else if (e.key === 'Delete' || e.key === 'Backspace') remove(index);
                            else if (e.key === 'Enter' || e.key === ' ') select(index);
                            else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
                                commit(editPoint(points, index, round(t + (e.key === 'ArrowLeft' ? -1 : 1) * 0.01 * step), v));
                            else if (e.key === 'ArrowUp' || e.key === 'ArrowDown')
                                commit(editPoint(points, index, t, round(v + (e.key === 'ArrowUp' ? 1 : -1) * 0.1 * step)));
                            else return;
                            e.preventDefault();
                            e.stopPropagation();
                        }} />
                ))}
            </svg>
            <div className="flex justify-between text-2xs text-gray-500"><span>0%</span><span>{domain}</span><span>100%</span></div>
            <div className="flex items-center justify-between gap-1">
                <span className={labelText}>Key {selected + 1} / {points.length}</span>
                <button type="button" className={button} disabled={points.length >= LIMIT} onClick={() => add()}>Add key</button>
                <button type="button" className={button} disabled={points.length < 2} onClick={() => remove(selected)}>Delete key</button>
            </div>
            <div key={selected} className="grid grid-cols-2 gap-2">
                <CurveNumber label="Time (%)" step={1} max={100} value={Number((time * 100).toPrecision(12))}
                    commit={n => commit(editPoint(points, selected, n / 100, amount))} />
                <CurveNumber label="Value (×)" step={0.1} max={maximum} value={amount}
                    commit={n => commit(editPoint(points, selected, time, n))} />
            </div>
            <p id={hint} className={labelText}>Drag a key or use the arrow keys. Double-click the plot to add a key.</p>
        </fieldset>
    );
};
