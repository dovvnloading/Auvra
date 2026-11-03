import React, { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { MAX_RAMP_STOPS, readParam, type MaterialParamDef, type MaterialRamp } from '../../runtime/materials/materialGraph';

/**
 * The inspector's field for one node param, by its kind: a number (slider, or drag the label to
 * scrub), a colour, a vector, a texture, a choice, a switch, a colour ramp or GLSL code.
 */

export const toHex = (rgb: number[]): string => `#${rgb.map(value => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0')).join('')}`;
export const fromHex = (hex: string): number[] => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255);

const inputClass = 'rounded border border-gray-700 bg-gray-950 px-1 py-0.5 text-xs text-white';

/** A label that changes a number when dragged sideways, by `step` a pixel. */
const ScrubLabel: React.FC<{ label: string; value: number; step: number; onChange: (value: number) => void }> = ({ label, value, step, onChange }) => {
    const start = useRef<{ x: number; value: number } | null>(null);
    useEffect(() => {
        const move = (event: MouseEvent) => {
            if (!start.current) return;
            const delta = (event.clientX - start.current.x) * step * (event.shiftKey ? 0.1 : 1);
            onChange(Number((start.current.value + delta).toFixed(4)));
        };
        const up = () => { start.current = null; document.body.style.cursor = ''; };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    }, [onChange, step]);
    return (
        <span
            className="cursor-ew-resize select-none text-2xs text-gray-500 hover:text-gray-300"
            title="Drag sideways to change (Shift: finer)"
            onMouseDown={(event) => {
                event.preventDefault();
                start.current = { x: event.clientX, value };
                document.body.style.cursor = 'ew-resize';
            }}
        >
            {label}
        </span>
    );
};

/** Ramp stops edited on a gradient bar: click a stop to pick it, drag it along, double-click the bar to add one. */
const RampEditor: React.FC<{ label: string; ramp: MaterialRamp; onChange: (ramp: MaterialRamp) => void }> = ({ label, ramp, onChange }) => {
    const bar = useRef<HTMLDivElement>(null);
    const [selected, setSelected] = useState(0);
    const dragging = useRef<number | null>(null);
    const stops = ramp.stops;
    const index = Math.min(selected, stops.length - 1);

    useEffect(() => {
        const move = (event: MouseEvent) => {
            if (dragging.current === null || !bar.current) return;
            const rect = bar.current.getBoundingClientRect();
            const position = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
            const moved = stops.map((stop, at) => (at === dragging.current ? { ...stop, position: Number(position.toFixed(4)) } : stop));
            const order = moved.map((stop, at) => ({ stop, at })).sort((a, b) => a.stop.position - b.stop.position);
            // The dragged stop keeps the selection as the stops reorder.
            const newIndex = order.findIndex(entry => entry.at === dragging.current);
            dragging.current = newIndex;
            setSelected(newIndex);
            onChange({ stops: order.map(entry => entry.stop) });
        };
        const up = () => { dragging.current = null; };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    }, [onChange, stops]);

    const gradient = stops.length === 1
        ? toHex(stops[0].color)
        : `linear-gradient(to right, ${stops.map(stop => `${toHex(stop.color)} ${(stop.position * 100).toFixed(2)}%`).join(', ')})`;

    const colorAt = (position: number): number[] => {
        const after = stops.findIndex(stop => stop.position >= position);
        if (after <= 0) return [...stops[after === -1 ? stops.length - 1 : 0].color];
        const a = stops[after - 1];
        const b = stops[after];
        const t = (position - a.position) / Math.max(1e-5, b.position - a.position);
        return a.color.map((c, at) => c + (b.color[at] - c) * t);
    };

    const stop = stops[index];
    return (
        <div className="space-y-1">
            <span className="text-2xs text-gray-500">{label}</span>
            <div
                ref={bar}
                role="slider"
                aria-label={`${label} ramp`}
                aria-valuenow={stop.position}
                className="relative h-5 cursor-copy rounded border border-gray-700"
                style={{ background: gradient }}
                title="Double-click to add a stop"
                onDoubleClick={(event) => {
                    if (stops.length >= MAX_RAMP_STOPS) return;
                    const rect = event.currentTarget.getBoundingClientRect();
                    const position = Number(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)).toFixed(4));
                    const next = [...stops, { position, color: colorAt(position) }].sort((a, b) => a.position - b.position);
                    setSelected(next.findIndex(candidate => candidate.position === position));
                    onChange({ stops: next });
                }}
            />
            <div className="relative h-3">
                {stops.map((candidate, at) => (
                    <button
                        key={at}
                        aria-label={`${label} stop ${at + 1}`}
                        className={`absolute top-0 h-3 w-3 -translate-x-1/2 rotate-45 border ${at === index ? 'border-white' : 'border-gray-500'}`}
                        style={{ left: `${candidate.position * 100}%`, background: toHex(candidate.color) }}
                        onMouseDown={(event) => { event.preventDefault(); setSelected(at); dragging.current = at; }}
                    />
                ))}
            </div>
            <div className="flex items-center gap-2">
                <input type="color" aria-label={`${label} stop colour`} value={toHex(stop.color)} className="h-6 w-10 rounded border border-gray-700 bg-transparent"
                    onChange={(event) => onChange({ stops: stops.map((candidate, at) => (at === index ? { ...candidate, color: fromHex(event.target.value) } : candidate)) })} />
                <input type="number" aria-label={`${label} stop position`} min={0} max={1} step={0.01} value={stop.position} className={`w-16 ${inputClass}`}
                    onChange={(event) => {
                        const position = Math.min(1, Math.max(0, Number(event.target.value) || 0));
                        const next = stops.map((candidate, at) => (at === index ? { ...candidate, position } : candidate));
                        const order = next.map((candidate, at) => ({ candidate, at })).sort((a, b) => a.candidate.position - b.candidate.position);
                        setSelected(order.findIndex(entry => entry.at === index));
                        onChange({ stops: order.map(entry => entry.candidate) });
                    }} />
                <span className="flex-1 text-2xs text-gray-500">{stops.length}/{MAX_RAMP_STOPS} stops</span>
                <button aria-label={`Remove ${label} stop`} disabled={stops.length <= 1} className="rounded p-1 text-gray-500 hover:text-red-400 disabled:opacity-30"
                    onClick={() => { onChange({ stops: stops.filter((_, at) => at !== index) }); setSelected(Math.max(0, index - 1)); }}>
                    <Trash2 size={12} />
                </button>
            </div>
        </div>
    );
};

/** GLSL edited as a draft and applied on demand (Ctrl+Enter or Apply), so a half-typed line never reaches the shader. */
const CodeField: React.FC<{ label: string; code: string; onChange: (code: string) => void }> = ({ label, code, onChange }) => {
    const [draft, setDraft] = useState(code);
    useEffect(() => setDraft(code), [code]);
    const dirty = draft !== code;
    return (
        <label className="block space-y-1">
            <span className="text-2xs text-gray-500">{label}</span>
            <textarea
                aria-label={label}
                value={draft}
                spellCheck={false}
                rows={7}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); onChange(draft); }
                    if (event.key === 'Tab') {
                        event.preventDefault();
                        const target = event.currentTarget;
                        const at = target.selectionStart;
                        setDraft(`${draft.slice(0, at)}    ${draft.slice(target.selectionEnd)}`);
                        requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = at + 4; });
                    }
                }}
                className="w-full resize-y rounded border border-gray-700 bg-gray-950 p-1.5 font-mono text-2xs leading-4 text-emerald-200 outline-none focus:border-blue-600"
            />
            <div className="flex items-center justify-between">
                <span className="text-2xs text-gray-500">{dirty ? 'Not applied yet (Ctrl+Enter)' : 'Applied'}</span>
                <button disabled={!dirty} onClick={() => onChange(draft)} className="rounded bg-blue-600 px-2 py-0.5 text-2xs font-bold text-accent-ink hover:bg-blue-500 disabled:opacity-40">Apply</button>
            </div>
        </label>
    );
};

export const ParamField: React.FC<{
    param: MaterialParamDef;
    value: unknown;
    textures: { id: string; name: string }[];
    onChange: (value: unknown) => void;
}> = ({ param, value, textures, onChange }) => {
    const current = readParam(param, value);
    const label = <span className="text-2xs text-gray-500">{param.label}</span>;
    switch (param.kind) {
        case 'texture':
            return (
                <label className="block space-y-1">{label}
                    <select aria-label={param.label} value={current as string} onChange={(event) => onChange(event.target.value)} className={`w-full px-2 py-1 ${inputClass}`}>
                        <option value="">(none)</option>
                        {textures.map(texture => <option key={texture.id} value={texture.id}>{texture.name}</option>)}
                    </select>
                </label>
            );
        case 'select':
            return (
                <label className="block space-y-1">{label}
                    <select aria-label={param.label} value={current as string} onChange={(event) => onChange(event.target.value)} className={`w-full px-2 py-1 ${inputClass}`}>
                        {param.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                </label>
            );
        case 'boolean':
            return (
                <label className="flex items-center justify-between gap-2">{label}
                    <input type="checkbox" aria-label={param.label} checked={current as boolean} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 accent-blue-500" />
                </label>
            );
        case 'color':
            return (
                <label className="flex items-center justify-between gap-2">{label}
                    <input type="color" aria-label={param.label} value={toHex(current as number[])} onChange={(event) => onChange(fromHex(event.target.value))} className="h-6 w-12 rounded border border-gray-700 bg-transparent" />
                </label>
            );
        case 'ramp':
            return <RampEditor label={param.label} ramp={current as MaterialRamp} onChange={onChange} />;
        case 'code':
            return <CodeField label={param.label} code={current as string} onChange={onChange} />;
        case 'float': {
            const number = current as number;
            const step = param.step ?? 0.01;
            return (
                <div className="space-y-1">
                    <ScrubLabel label={param.label} value={number} step={step} onChange={onChange} />
                    <div className="flex items-center gap-2">
                        {param.min !== undefined && param.max !== undefined && (
                            <input type="range" aria-label={`${param.label} slider`} min={param.min} max={param.max} step={step} value={number} onChange={(event) => onChange(Number(event.target.value))} className="flex-1" />
                        )}
                        <input type="number" aria-label={param.label} step={step} value={number} onChange={(event) => onChange(Number(event.target.value))} className={`w-20 ${inputClass}`} />
                    </div>
                </div>
            );
        }
        default: {
            const components = current as number[];
            return (
                <label className="block space-y-1">{label}
                    <div className="flex gap-1">
                        {components.map((component, index) => (
                            <input key={index} type="number" aria-label={`${param.label} ${'XYZ'[index]}`} step={0.05} value={component} onChange={(event) => onChange(components.map((old, at) => (at === index ? Number(event.target.value) : old)))} className={`w-full ${inputClass}`} />
                        ))}
                    </div>
                </label>
            );
        }
    }
};
