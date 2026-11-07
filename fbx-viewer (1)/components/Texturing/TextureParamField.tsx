import React, { useEffect, useRef, useState } from 'react';
import { LinkIcon, VariableIcon, SigmaIcon, UnlinkIcon, UploadIcon } from '../UI/Icons';
import { expressionError } from '../../texturing/graph/expressions';
import { MAX_RAMP_STOPS, readRamp } from '../../texturing/graph/nodeKit';
import { isParamLink, type GraphParameter, type GraphParameterKind, type RampStop, type TexParamDef } from '../../texturing/graph/types';
import { RampEditor, ScrubLabel } from '../Materials/MaterialParamField';
import { Popover } from '../UI/kit';
import { Select } from '../UI/Select';
import { CurveEditor } from './CurveEditor';
import { AngleDial, CodeEditor, EyedropperButton, GradientPickButton, PositionPad } from './SettingWidgets';
import type { Histogram } from './view2d';
import { ColourFieldRgb } from '../UI/ColourPicker';
import { availableFonts } from '../../texturing/graph/nodes/text';

/**
 * One node setting in the inspector, by its kind. A setting can instead follow one of the graph's
 * parameters, or a formula of them; the link button beside it sets that up, or exposes the setting
 * as a new parameter of the graph.
 */

const field = 'rounded border border-line bg-panel px-1.5 py-0.5 text-xs text-ink outline-none focus:border-accent';

/** The graph parameter kinds a setting can follow. */
const FOLLOWS: Partial<Record<TexParamDef['kind'], GraphParameterKind[]>> = {
    float: ['float', 'int'], int: ['int', 'float'], bool: ['bool'], color: ['color'], vec2: ['vec2'], select: ['select', 'int'],
    ramp: ['ramp'], curve: ['curve'], texture: ['texture'], string: ['string'], font: ['font'],
};
/** Settings a formula can give a value to (numbers, switches, colours, pairs, choices). */
const FORMULA_KINDS: ReadonlySet<TexParamDef['kind']> = new Set(['float', 'int', 'bool', 'color', 'vec2', 'select']);

/** The parameter kind a setting becomes when exposed: every kind a parameter can hold. */
export const exposedKind = (param: TexParamDef): GraphParameterKind | null => {
    switch (param.kind) {
        case 'float': case 'int': case 'bool': case 'color': case 'vec2': case 'select':
        case 'ramp': case 'curve': case 'texture': case 'string': case 'font':
            return param.kind;
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

/** Text of many lines, applied on leaving the box, and read from a file with a button. */
const LongText: React.FC<{ label: string; value: string; accept: string; limit: number; onCommit: (value: string) => void }> = ({ label, value, accept, limit, onCommit }) => {
    const [draft, setDraft] = useState(value);
    const picker = useRef<HTMLInputElement>(null);
    useEffect(() => setDraft(value), [value]);
    const commit = (text: string) => { const next = text.slice(0, limit); if (next !== value) onCommit(next); };
    return (
        <div className="space-y-1">
            <textarea aria-label={label} value={draft} rows={4} spellCheck={false} onChange={(event) => setDraft(event.target.value)} onBlur={(event) => commit(event.target.value)}
                className={`${field} w-full resize-y font-mono text-2xs leading-snug`} />
            <div className="flex items-center justify-between gap-2 text-2xs text-ink-3">
                <span>{draft.length.toLocaleString()} characters</span>
                <button type="button" onClick={() => picker.current?.click()} className="text-ink-2 hover:text-ink">Read from a file…</button>
                <input ref={picker} type="file" accept={accept} className="hidden" aria-label={`${label} file`}
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = '';
                        if (file) void file.text().then((text) => { setDraft(text.slice(0, limit)); commit(text); });
                    }} />
            </div>
        </div>
    );
};

const NumberRow: React.FC<{ param: TexParamDef; value: number; onChange: (value: number) => void }> = ({ param, value, onChange }) => {
    const step = param.step ?? (param.kind === 'int' ? 1 : 0.01);
    // The slider spans the soft range; typing goes on to the hard limits.
    const min = param.softMin ?? param.min;
    const max = param.softMax ?? param.max;
    return (
        <div className="flex items-center gap-2">
            {min !== undefined && max !== undefined && (
                <input type="range" aria-label={`${param.label} slider`} min={min} max={max} step={step} value={Math.max(min, Math.min(max, value))}
                    onChange={(event) => onChange(Number(event.target.value))} className="h-1 min-w-0 flex-1 accent-accent" />
            )}
            <DraftNumber label={param.label} value={value} integer={param.kind === 'int'} className="w-16" limit={(next) => clampToParam(param, next)} onCommit={onChange} />
        </div>
    );
};

/** What a few settings show besides their value: a code setting its compile errors and the names it can use, a curve the histogram of its input. */
export interface ParamExtras {
    error?: string | null;
    names?: readonly string[];
    histogram?: Histogram | null;
}

/** True for a setting in degrees: it gets a dial. */
const isAngle = (param: TexParamDef) => param.kind === 'float' && (/degree/i.test(param.label) || param.key === 'rotation' || param.key === 'angle');
/** True for a pair whose range is small enough to place on a pad (an offset, a centre). */
const hasPad = (param: TexParamDef) => param.kind === 'vec2' && param.min !== undefined && param.max !== undefined && param.max - param.min <= 2;

export const ParamControl: React.FC<{
    param: TexParamDef;
    value: unknown;
    textures: ReadonlyArray<{ id: string; name: string }>;
    onChange: (value: unknown) => void;
    extras?: ParamExtras;
}> = ({ param, value, textures, onChange, extras }) => {
    switch (param.kind) {
        case 'float':
        case 'int': {
            const number = Number(value ?? param.default) || 0;
            if (!isAngle(param)) return <NumberRow param={param} value={number} onChange={onChange} />;
            return (
                <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1"><NumberRow param={param} value={number} onChange={onChange} /></div>
                    <AngleDial label={param.label} value={number} min={param.min} max={param.max} onChange={onChange} />
                </div>
            );
        }
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
                <div className="flex items-center gap-1">
                    <ColourFieldRgb label={param.label} value={[c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 1]} alpha onChange={onChange} className="h-5 w-9" showHex />
                    <EyedropperButton label={param.label} onPick={(colour) => onChange([colour[0], colour[1], colour[2], c[3] ?? colour[3]])} />
                </div>
            );
        }
        case 'vec2': {
            const v = (Array.isArray(value) ? value : param.default) as number[];
            const numbers = (
                <div className="flex min-w-0 flex-1 gap-1">
                    {[0, 1].map((index) => (
                        <DraftNumber key={index} label={`${param.label} ${'XY'[index]}`} value={Number(v[index]) || 0} className="w-full min-w-0" limit={(next) => clampToParam(param, next)}
                            onCommit={(next) => onChange([0, 1].map((at) => (at === index ? next : Number(v[at]) || 0)))} />
                    ))}
                </div>
            );
            if (!hasPad(param)) return numbers;
            const fallback = param.default as [number, number];
            return (
                <div className="flex items-center gap-2">
                    {numbers}
                    <PositionPad label={param.label} value={[Number(v[0]) || 0, Number(v[1]) || 0]} min={param.min!} max={param.max!} fallback={[fallback[0], fallback[1]]} onChange={onChange} />
                </div>
            );
        }
        case 'select':
            return <Select value={String(value ?? param.default)} options={(param.options ?? []).map((option) => ({ value: option.value, label: option.label }))} onChange={(next) => onChange(next)} className="w-full" />;
        case 'ramp': {
            // Stops keep their alpha: a gradient map can fade to see-through.
            const stops = readRamp(value, (param.default as { stops: RampStop[] }).stops);
            return (
                <div className="space-y-1">
                    <RampEditor label={param.label} alpha maxStops={MAX_RAMP_STOPS} ramp={{ stops: stops.map((stop) => ({ position: stop.position, color: [...stop.color] })) }}
                        onChange={(ramp) => onChange({ stops: ramp.stops.map((stop) => ({ position: stop.position, color: [stop.color[0] ?? 0, stop.color[1] ?? 0, stop.color[2] ?? 0, stop.color[3] ?? 1] })) })} />
                    <div className="flex items-center justify-end gap-1 text-2xs text-ink-3">
                        <span>Pick from an image</span>
                        <GradientPickButton label={param.label} onPick={(picked) => onChange({ stops: picked.slice(0, MAX_RAMP_STOPS).map((stop) => ({ position: stop.position, color: [...stop.color] })) })} />
                    </div>
                </div>
            );
        }
        case 'curve':
            return <CurveEditor value={value} onChange={onChange} histogram={extras?.histogram} />;
        case 'texture':
            return <Select value={String(value ?? '')} options={[{ value: '', label: 'No picture' }, ...textures.map((texture) => ({ value: texture.id, label: texture.name }))]} onChange={(next) => onChange(next)} className="w-full" />;
        case 'code':
            return <CodeEditor label={param.label} code={String(value ?? '')} onChange={onChange} error={extras?.error} names={extras?.names} />;
        case 'string':
            if (param.multiline) return <LongText label={param.label} value={String(value ?? '')} accept={param.multiline.accept} limit={param.multiline.limit} onCommit={onChange} />;
            return <DraftText label={param.label} value={String(value ?? '')} maxLength={2000} allowEmpty onCommit={onChange} className="w-full" />;
        case 'points': {
            const count = Array.isArray(value) ? value.length : 0;
            return (
                <div className="flex items-start gap-2 rounded border border-line bg-well px-1.5 py-1">
                    <p className="min-w-0 flex-1 text-2xs leading-snug text-ink-2">
                        {count} point{count === 1 ? '' : 's'}. In the 2D view: click to add one, drag one to move it, Alt-click one to take it away.
                    </p>
                    <button type="button" onClick={() => onChange(structuredClone(param.default))} className="shrink-0 text-2xs text-ink-3 hover:text-ink" title="Put the points back as they started">Start again</button>
                </div>
            );
        }
        case 'font': {
            const current = String(value ?? param.default ?? '');
            const fonts = availableFonts();
            return <Select value={current} options={[...(fonts.includes(current) || !current ? [] : [{ value: current, label: `${current} (not on this computer)` }]), ...fonts.map((font) => ({ value: font, label: font }))]} onChange={(next) => onChange(next)} className="w-full" />;
        }
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
    extras?: ParamExtras;
    /** A setting that can be shown as a pin on its node, to follow a value wired in (a Value processor's). */
    pin?: { shown: boolean; wired: boolean; onToggle: () => void };
}> = ({ param, value, parameters, textures, problem, onChange, onExpose, extras, pin }) => {
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

    const following = Boolean(pin?.wired);
    const linkButton = canLink && (
        <button ref={anchor} aria-label={`Link ${param.label} to a parameter`} title={pin ? 'Follow a parameter, a formula or a value wired into a pin, or expose as a parameter' : 'Follow a parameter or formula, or expose as a parameter'}
            onClick={() => { setFormula(linked && '$expr' in linked ? linked.$expr : ''); setMenu(true); }}
            className={`rounded p-0.5 ${linked || pin?.shown ? 'text-accent hover:text-accent-hover' : 'text-ink-3 hover:text-ink-2'}`}>
            {pin?.shown ? <VariableIcon size={12} /> : linked && '$expr' in linked ? <SigmaIcon size={12} /> : <LinkIcon size={12} />}
        </button>
    );

    return (
        <div className="space-y-1" title={param.hint}>
            <div className="flex items-center gap-1.5">
                {/* A long label is cut to fit; it shows in full (with what the setting does) on hover. */}
                <span className="min-w-0 flex-1 truncate" title={param.hint ? `${param.label}: ${param.hint}` : param.label}>{label}</span>
                {inline(param) && !linked && !following && <ParamControl param={param} value={value} textures={textures} onChange={onChange} extras={extras} />}
                {linkButton}
            </div>
            {following ? (
                <div className="flex items-center gap-1.5 rounded border border-accent/40 bg-accent/10 px-1.5 py-1 text-2xs text-accent">
                    <span className="flex-1 truncate">Follows the value wired into its pin</span>
                </div>
            ) : linked ? (
                <div className="flex items-center gap-1.5 rounded border border-accent/40 bg-accent/10 px-1.5 py-1 text-2xs text-accent">
                    {'$bind' in linked ? <span className="flex-1 truncate">Follows <b>{parameters.find((p) => p.name === linked.$bind)?.label ?? linked.$bind}</b></span>
                        : <span className="flex-1 truncate font-mono">{linked.$expr}</span>}
                    <button aria-label="Stop following" title="Stop following" onClick={() => onChange(structuredClone(param.default))} className="text-accent hover:text-ink"><UnlinkIcon size={12} /></button>
                </div>
            ) : !inline(param) && <ParamControl param={param} value={value} textures={textures} onChange={onChange} extras={extras} />}
            {(problem || formulaProblem) && <p className="text-2xs text-warn">{formulaProblem ?? problem}</p>}
            <Popover anchor={anchor} open={menu} onClose={() => setMenu(false)} width={260} label={`Link ${param.label}`}>
                <div className="space-y-2 p-2 text-xs">
                    <button onClick={() => { onExpose(); setMenu(false); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-ink hover:bg-white/5">
                        <UploadIcon size={12} /> Expose as a new parameter
                    </button>
                    {pin && (
                        <button onClick={() => { pin.onToggle(); setMenu(false); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-ink hover:bg-white/5"
                            title={pin.shown ? 'Takes the pin off the node, and any wire into it' : 'A pin on the node for a value (a Value processor\'s), which this setting then follows on the GPU'}>
                            <VariableIcon size={12} /> {pin.shown ? 'Take its pin off the node' : 'Show as a pin, to follow a value'}
                        </button>
                    )}
                    {choices.length > 0 && (
                        <div>
                            <div className="px-2 pb-1 text-2xs text-ink-3">Follow a parameter</div>
                            {choices.map((parameter) => (
                                <button key={parameter.name} onClick={() => { onChange({ $bind: parameter.name }); setMenu(false); }}
                                    className="block w-full truncate rounded px-2 py-1 text-left text-ink hover:bg-white/5">{parameter.label}</button>
                            ))}
                        </div>
                    )}
                    {FORMULA_KINDS.has(param.kind) && <div className="space-y-1 border-t border-line pt-2">
                        <div className="px-2 text-2xs text-ink-3">Or a formula of parameters ({names.length ? names.join(', ') : 'none yet'}, $size, $seed, $iteration)</div>
                        <input aria-label="Formula" value={formula} placeholder="wear * 0.5 + 0.1" onChange={(event) => setFormula(event.target.value)}
                            onKeyDown={(event) => { if (event.key === 'Enter' && formula.trim() && !expressionError(formula, names)) { onChange({ $expr: formula.trim() }); setMenu(false); } }}
                            className={`w-full font-mono ${field}`} />
                        {formula.trim() && expressionError(formula, names) && <p className="px-1 text-2xs text-warn">{expressionError(formula, names)}</p>}
                        <div className="flex justify-end">
                            <button disabled={!formula.trim() || Boolean(expressionError(formula, names))} onClick={() => { onChange({ $expr: formula.trim() }); setMenu(false); }}
                                className="rounded bg-accent px-2 py-0.5 text-2xs font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-40">Use formula</button>
                        </div>
                    </div>}
                </div>
            </Popover>
        </div>
    );
};
