import React, { useEffect, useRef, useState } from 'react';
import { LinkIcon, SigmaIcon, UnlinkIcon, UploadIcon } from '../UI/Icons';
import { expressionError } from '../../texturing/graph/expressions';
import { MAX_RAMP_STOPS, readRamp } from '../../texturing/graph/nodeKit';
import { isParamLink, type GraphParameter, type GraphParameterKind, type RampStop, type TexParamDef } from '../../texturing/graph/types';
import { CodeField, RampEditor, ScrubLabel } from '../Materials/MaterialParamField';
import { Popover } from '../UI/kit';
import { Select } from '../UI/Select';
import { CurveEditor } from './CurveEditor';
import { ColourFieldRgb } from '../UI/ColourPicker';

/**
 * One node setting in the inspector, by its kind. A setting can instead follow one of the graph's
 * parameters, or a formula of them; the link button beside it sets that up, or exposes the setting
 * as a new parameter of the graph.
 */

const field = 'rounded border border-line bg-panel px-1.5 py-0.5 text-xs text-ink outline-none focus:border-accent';

/** The graph parameter kinds a setting can follow. */
const FOLLOWS: Partial<Record<TexParamDef['kind'], GraphParameterKind[]>> = {
    float: ['float', 'int'], int: ['int', 'float'], bool: ['bool'], color: ['color'], vec2: ['vec2'], select: ['select', 'int'],
};

/** The parameter kind a setting becomes when exposed. */
export const exposedKind = (param: TexParamDef): GraphParameterKind | null => {
    switch (param.kind) {
        case 'float': case 'int': case 'bool': case 'color': case 'vec2': case 'select': return param.kind;
        default: return null;
    }
};

/**
 * A setting's number kept inside its hard limits (a typed or scrubbed value past them stops at them),
 * whole for whole-number settings. Typing may still go past a slider's soft end, up to the hard limit.
 */
export const clampToParam = (param: Pick<TexParamDef, 'kind' | 'min' | 'max'>, value: number): number => {
    const whole = param.kind === 'int' ? Math.round(value) : value;
    return Math.min(param.max ?? Infinity, Math.max(param.min ?? -Infinity, whole));
};

/**
 * A number typed as text and applied on Enter or on leaving the box, so half-typed values ("-", "0.")
 * never reach the graph and nothing that is not a number is ever stored. An unchanged value is not
 * applied again, which would make an empty undo step.
 */
export const DraftNumber: React.FC<{ label: string; value: number; integer?: boolean; className?: string; limit?: (value: number) => number; onCommit: (value: number) => void }> = ({ label, value, integer, className, limit, onCommit }) => {
    const shown = String(Number((Number.isFinite(value) ? value : 0).toFixed(4)));
    const [draft, setDraft] = useState(shown);
    useEffect(() => setDraft(shown), [shown]);
    const commit = (text: string) => {
        const number = Number(text.trim());
        if (!text.trim() || !Number.isFinite(number)) { setDraft(shown); return; }
        const rounded = integer ? Math.round(number) : number;
        const next = limit ? limit(rounded) : rounded;
        if (next !== value) onCommit(next);
        setDraft(String(Number(next.toFixed(4))));
    };
    return (
        <input aria-label={label} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => {
                if (event.key === 'Enter') commit((event.target as HTMLInputElement).value);
                if (event.key === 'Escape') { setDraft(shown); (event.target as HTMLInputElement).blur(); }
            }}
            className={`text-right tabular-nums ${field} ${className ?? ''}`} />
    );
};

/**
 * Text typed freely and applied on Enter or on leaving the box, as one change (one undo step) rather
 * than one per key. Empty text goes back to what it was unless `allowEmpty`.
 */
export const DraftText: React.FC<{ label: string; value: string; maxLength?: number; allowEmpty?: boolean; placeholder?: string; className?: string; onCommit: (value: string) => void }> = ({ label, value, maxLength = 64, allowEmpty = false, placeholder, className, onCommit }) => {
    const [draft, setDraft] = useState(value);
    useEffect(() => setDraft(value), [value]);
    const commit = (text: string) => {
        const next = text.slice(0, maxLength);
        if (!next.trim() && !allowEmpty) { setDraft(value); return; }
        if (next !== value) onCommit(next);
    };
    return (
        <input aria-label={label} value={draft} maxLength={maxLength} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => {
                if (event.key === 'Enter') commit((event.target as HTMLInputElement).value);
                if (event.key === 'Escape') { setDraft(value); (event.target as HTMLInputElement).blur(); }
            }}
            className={`${field} ${className ?? ''}`} />
    );
};

const NumberRow: React.FC<{ param: TexParamDef; value: number; onChange: (value: number) => void }> = ({ param, value, onChange }) => {
    const step = param.step ?? (param.kind === 'int' ? 1 : 0.01);
    const max = param.softMax ?? param.max;
    return (
        <div className="flex items-center gap-2">
            {param.min !== undefined && max !== undefined && (
                <input type="range" aria-label={`${param.label} slider`} min={param.min} max={max} step={step} value={Math.min(max, value)}
                    onChange={(event) => onChange(Number(event.target.value))} className="h-1 min-w-0 flex-1 accent-accent" />
            )}
            <DraftNumber label={param.label} value={value} integer={param.kind === 'int'} className="w-16" limit={(next) => clampToParam(param, next)} onCommit={onChange} />
        </div>
    );
};

export const ParamControl: React.FC<{
    param: TexParamDef;
    value: unknown;
    textures: ReadonlyArray<{ id: string; name: string }>;
    onChange: (value: unknown) => void;
}> = ({ param, value, textures, onChange }) => {
    switch (param.kind) {
        case 'float':
        case 'int':
            return <NumberRow param={param} value={Number(value ?? param.default) || 0} onChange={onChange} />;
        case 'bool':
            return (
                <button role="switch" aria-checked={Boolean(value)} aria-label={param.label} onClick={() => onChange(!value)}
                    className={`relative h-4 w-7 rounded-full transition-colors ${value ? 'bg-accent' : 'bg-gray-700'}`}>
                    <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${value ? 'left-3.5' : 'left-0.5'}`} />
                </button>
            );
        case 'color': {
            const c = (Array.isArray(value) ? value : param.default) as number[];
            return (
                <div className="flex items-center gap-2">
                    <ColourFieldRgb label={param.label} value={[c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 1]} alpha onChange={onChange} className="h-5 w-9" showHex />
                </div>
            );
        }
        case 'vec2': {
            const v = (Array.isArray(value) ? value : param.default) as number[];
            return (
                <div className="flex gap-1">
                    {[0, 1].map((index) => (
                        <DraftNumber key={index} label={`${param.label} ${'XY'[index]}`} value={Number(v[index]) || 0} className="w-full min-w-0" limit={(next) => clampToParam(param, next)}
                            onCommit={(next) => onChange([0, 1].map((at) => (at === index ? next : Number(v[at]) || 0)))} />
                    ))}
                </div>
            );
        }
        case 'select':
            return <Select value={String(value ?? param.default)} options={(param.options ?? []).map((option) => ({ value: option.value, label: option.label }))} onChange={(next) => onChange(next)} className="w-full" />;
        case 'ramp': {
            // Stops keep their alpha: a gradient map can fade to see-through.
            const stops = readRamp(value, (param.default as { stops: RampStop[] }).stops);
            return <RampEditor label={param.label} alpha maxStops={MAX_RAMP_STOPS} ramp={{ stops: stops.map((stop) => ({ position: stop.position, color: [...stop.color] })) }}
                onChange={(ramp) => onChange({ stops: ramp.stops.map((stop) => ({ position: stop.position, color: [stop.color[0] ?? 0, stop.color[1] ?? 0, stop.color[2] ?? 0, stop.color[3] ?? 1] })) })} />;
        }
        case 'curve':
            return <CurveEditor value={value} onChange={onChange} />;
        case 'texture':
            return <Select value={String(value ?? '')} options={[{ value: '', label: 'No picture' }, ...textures.map((texture) => ({ value: texture.id, label: texture.name }))]} onChange={(next) => onChange(next)} className="w-full" />;
        case 'code':
            return <CodeField label={param.label} code={String(value ?? '')} onChange={onChange} />;
        case 'string':
            return <DraftText label={param.label} value={String(value ?? '')} allowEmpty onCommit={onChange} className="w-full" />;
        default:
            return null;
    }
};

/** Whether a setting is laid out on one line (label and control side by side). */
const inline = (param: TexParamDef) => param.kind === 'bool' || param.kind === 'color';

export const TextureParamField: React.FC<{
    param: TexParamDef;
    value: unknown;
    parameters: readonly GraphParameter[];
    textures: ReadonlyArray<{ id: string; name: string }>;
    problem?: string;
    onChange: (value: unknown) => void;
    onExpose: () => void;
}> = ({ param, value, parameters, textures, problem, onChange, onExpose }) => {
    const anchor = useRef<HTMLButtonElement>(null);
    const [menu, setMenu] = useState(false);
    const [formula, setFormula] = useState('');
    const linked = isParamLink(value) ? value : null;
    const follows = FOLLOWS[param.kind];
    const canLink = Boolean(follows);
    const choices = parameters.filter((parameter) => follows?.includes(parameter.kind));
    const names = parameters.map((parameter) => parameter.name);
    const formulaProblem = linked && '$expr' in linked ? expressionError(linked.$expr, names) : null;

    const label = param.kind === 'float' || param.kind === 'int'
        ? <ScrubLabel label={param.label} value={Number(linked ? param.default : value ?? param.default) || 0} step={param.step ?? 0.01} onChange={(next) => !linked && onChange(clampToParam(param, next))} />
        : <span className="text-2xs text-ink-2">{param.label}</span>;

    const linkButton = canLink && (
        <button ref={anchor} aria-label={`Link ${param.label} to a parameter`} title="Follow a parameter or formula, or expose as a parameter"
            onClick={() => { setFormula(linked && '$expr' in linked ? linked.$expr : ''); setMenu(true); }}
            className={`rounded p-0.5 ${linked ? 'text-accent hover:text-accent-hover' : 'text-ink-3 hover:text-ink-2'}`}>
            {linked && '$expr' in linked ? <SigmaIcon size={12} /> : <LinkIcon size={12} />}
        </button>
    );

    return (
        <div className="space-y-1" title={param.hint}>
            <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {inline(param) && !linked && <ParamControl param={param} value={value} textures={textures} onChange={onChange} />}
                {linkButton}
            </div>
            {linked ? (
                <div className="flex items-center gap-1.5 rounded border border-accent/40 bg-accent/10 px-1.5 py-1 text-2xs text-accent">
                    {'$bind' in linked ? <span className="flex-1 truncate">Follows <b>{parameters.find((p) => p.name === linked.$bind)?.label ?? linked.$bind}</b></span>
                        : <span className="flex-1 truncate font-mono">{linked.$expr}</span>}
                    <button aria-label="Stop following" title="Stop following" onClick={() => onChange(structuredClone(param.default))} className="text-accent hover:text-ink"><UnlinkIcon size={12} /></button>
                </div>
            ) : !inline(param) && <ParamControl param={param} value={value} textures={textures} onChange={onChange} />}
            {(problem || formulaProblem) && <p className="text-2xs text-warn">{formulaProblem ?? problem}</p>}
            <Popover anchor={anchor} open={menu} onClose={() => setMenu(false)} width={260} label={`Link ${param.label}`}>
                <div className="space-y-2 p-2 text-xs">
                    <button onClick={() => { onExpose(); setMenu(false); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-ink hover:bg-white/5">
                        <UploadIcon size={12} /> Expose as a new parameter
                    </button>
                    {choices.length > 0 && (
                        <div>
                            <div className="px-2 pb-1 text-2xs text-ink-3">Follow a parameter</div>
                            {choices.map((parameter) => (
                                <button key={parameter.name} onClick={() => { onChange({ $bind: parameter.name }); setMenu(false); }}
                                    className="block w-full truncate rounded px-2 py-1 text-left text-ink hover:bg-white/5">{parameter.label}</button>
                            ))}
                        </div>
                    )}
                    <div className="space-y-1 border-t border-line pt-2">
                        <div className="px-2 text-2xs text-ink-3">Or a formula of parameters ({names.length ? names.join(', ') : 'none yet'}, $size, $seed)</div>
                        <input aria-label="Formula" value={formula} placeholder="wear * 0.5 + 0.1" onChange={(event) => setFormula(event.target.value)}
                            onKeyDown={(event) => { if (event.key === 'Enter' && formula.trim() && !expressionError(formula, names)) { onChange({ $expr: formula.trim() }); setMenu(false); } }}
                            className={`w-full font-mono ${field}`} />
                        {formula.trim() && expressionError(formula, names) && <p className="px-1 text-2xs text-warn">{expressionError(formula, names)}</p>}
                        <div className="flex justify-end">
                            <button disabled={!formula.trim() || Boolean(expressionError(formula, names))} onClick={() => { onChange({ $expr: formula.trim() }); setMenu(false); }}
                                className="rounded bg-accent px-2 py-0.5 text-2xs font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-40">Use formula</button>
                        </div>
                    </div>
                </div>
            </Popover>
        </div>
    );
};
