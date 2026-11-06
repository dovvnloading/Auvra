import React, { useEffect, useMemo, useRef, useState } from 'react';
import { EyedropperIcon, RampIcon } from '../UI/Icons';
import { Button, IconButton } from '../UI/kit';
import { parseShaderErrors, tokenizeLine, type TokenKind } from './codeText';
import { startPicking, stopPicking, usePicking, type GradientStop, type Rgba } from './eyedropper';

/**
 * Small controls the settings fields of both graphs share: a dial for angles, a pad for positions,
 * eyedroppers that pick a colour (or a gradient) from the 2D or 3D view, and a code field that
 * colours GLSL and marks the lines the shader compiler stopped at.
 */

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** A dial for an angle in degrees: drag round it (0 points right, turning anticlockwise); arrow keys turn by a degree, Shift by 15. */
export const AngleDial: React.FC<{ label: string; value: number; min?: number; max?: number; onChange: (degrees: number) => void }> = ({ label, value, min = -360, max = 360, onChange }) => {
    const dial = useRef<HTMLDivElement>(null);
    const set = (degrees: number) => onChange(Math.round(Math.min(max, Math.max(min, degrees))));
    const fromPointer = (event: React.PointerEvent) => {
        const box = dial.current!.getBoundingClientRect();
        let degrees = (Math.atan2(box.top + box.height / 2 - event.clientY, event.clientX - (box.left + box.width / 2)) * 180) / Math.PI;
        if (min >= 0 && degrees < 0) degrees += 360;
        set(degrees);
    };
    return (
        <div
            ref={dial}
            role="slider"
            tabIndex={0}
            aria-label={`${label} dial`}
            aria-valuenow={value}
            aria-valuemin={min}
            aria-valuemax={max}
            title="Drag round to turn (0 points right); arrow keys turn by a degree, Shift by 15"
            className="relative h-6 w-6 shrink-0 cursor-pointer rounded-full border border-line bg-well outline-none focus-visible:ring-1 focus-visible:ring-accent"
            onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); fromPointer(event); }}
            onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) fromPointer(event); }}
            onKeyDown={(event) => {
                const step = event.shiftKey ? 15 : 1;
                if (event.key === 'ArrowUp' || event.key === 'ArrowRight') { event.preventDefault(); set(value + step); }
                if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') { event.preventDefault(); set(value - step); }
            }}
        >
            <span className="absolute left-1/2 top-1/2 h-0.5 w-[10px] origin-left -translate-y-1/2 rounded bg-accent" style={{ transform: `translateY(-50%) rotate(${-value}deg)` }} />
            <span className="absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-2" />
        </div>
    );
};

/** A pad for a 2D position: drag the dot (up is up); arrow keys nudge it, Shift ten times as far; double-click puts it back. */
export const PositionPad: React.FC<{ label: string; value: [number, number]; min: number; max: number; fallback: [number, number]; onChange: (value: [number, number]) => void }> = ({ label, value, min, max, fallback, onChange }) => {
    const pad = useRef<HTMLDivElement>(null);
    const span = Math.max(1e-6, max - min);
    const fromPointer = (event: React.PointerEvent) => {
        const box = pad.current!.getBoundingClientRect();
        onChange([round3(min + clamp01((event.clientX - box.left) / box.width) * span), round3(min + clamp01(1 - (event.clientY - box.top) / box.height) * span)]);
    };
    const nudge = (dx: number, dy: number) => onChange([round3(Math.min(max, Math.max(min, value[0] + dx))), round3(Math.min(max, Math.max(min, value[1] + dy)))]);
    const at = [clamp01((value[0] - min) / span), clamp01((value[1] - min) / span)];
    return (
        <div
            ref={pad}
            role="group"
            tabIndex={0}
            aria-label={`${label} pad`}
            title="Drag to place; arrow keys nudge (Shift: further); double-click to put it back"
            className="relative h-14 w-14 shrink-0 cursor-crosshair rounded border border-line bg-well outline-none focus-visible:ring-1 focus-visible:ring-accent"
            onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); fromPointer(event); }}
            onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) fromPointer(event); }}
            onDoubleClick={() => onChange(fallback)}
            onKeyDown={(event) => {
                const step = (event.shiftKey ? 0.1 : 0.01) * span;
                const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
                const move = moves[event.key];
                if (move) { event.preventDefault(); nudge(move[0], move[1]); }
            }}
        >
            <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-line" />
            <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-line" />
            <span className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-ground bg-accent" style={{ left: `${at[0] * 100}%`, top: `${(1 - at[1]) * 100}%` }} />
        </div>
    );
};

/** Picks a colour for a setting from the 2D view (a click) or the 3D view (a click on the model). */
export const EyedropperButton: React.FC<{ label: string; onPick: (colour: Rgba) => void }> = ({ label, onPick }) => {
    const picking = usePicking();
    const done = useRef<((colour: Rgba) => void) | null>(null);
    const active = Boolean(picking && picking.kind === 'colour' && picking.done === done.current);
    return (
        <IconButton
            label={active ? 'Picking: click the 2D view or the model in the 3D view (Esc to stop)' : `Pick ${label} from the 2D or 3D view`}
            active={active}
            onClick={() => {
                if (active) { stopPicking(); return; }
                const handler = (colour: Rgba) => onPick(colour);
                done.current = handler;
                startPicking({ kind: 'colour', label: label.toLowerCase(), done: handler });
            }}
        ><EyedropperIcon size={12} /></IconButton>
    );
};

/** Picks a gradient for a setting: a line dragged across the 2D view's image gives the colours along it. */
export const GradientPickButton: React.FC<{ label: string; onPick: (stops: GradientStop[]) => void }> = ({ label, onPick }) => {
    const picking = usePicking();
    const done = useRef<((stops: GradientStop[]) => void) | null>(null);
    const active = Boolean(picking && picking.kind === 'gradient' && picking.done === done.current);
    return (
        <IconButton
            label={active ? 'Picking: drag a line across the 2D view\'s image (Esc to stop)' : `Pick ${label} along a line drawn on the 2D view's image`}
            active={active}
            onClick={() => {
                if (active) { stopPicking(); return; }
                const handler = (stops: GradientStop[]) => onPick(stops);
                done.current = handler;
                startPicking({ kind: 'gradient', label: label.toLowerCase(), done: handler });
            }}
        ><RampIcon size={12} /></IconButton>
    );
};

const TOKEN_COLOURS: Record<TokenKind, string> = {
    plain: 'text-ink', keyword: 'text-accent', type: 'text-[#c4b5fd]', function: 'text-[#93c5fd]', number: 'text-[#fcd34d]', comment: 'italic text-ink-3', name: 'text-[#5eead4]',
};

/**
 * GLSL typed as a draft (coloured as it is typed) and applied with Ctrl+Enter or Apply, so a half-typed
 * line never reaches the shader. Lines the compiler stopped at are marked, with its words below.
 */
export const CodeEditor: React.FC<{
    label: string;
    code: string;
    onChange: (code: string) => void;
    /** The compile log of the code as applied, if it did not compile. */
    error?: string | null;
    /** Names the code can use (the node's inputs and settings), coloured as such. */
    names?: readonly string[];
}> = ({ label, code, onChange, error, names }) => {
    const [draft, setDraft] = useState(code);
    useEffect(() => setDraft(code), [code]);
    const area = useRef<HTMLTextAreaElement>(null);
    const shade = useRef<HTMLDivElement>(null);
    const gutter = useRef<HTMLDivElement>(null);
    const dirty = draft !== code;
    const errors = useMemo(() => parseShaderErrors(error), [error]);
    const bad = useMemo(() => new Set(errors.map((item) => item.line).filter((line): line is number => line !== null)), [errors]);
    const known = useMemo(() => new Set(names ?? []), [names]);
    const lines = draft.split('\n');
    const sync = () => {
        const element = area.current;
        if (!element) return;
        if (shade.current) { shade.current.scrollTop = element.scrollTop; shade.current.scrollLeft = element.scrollLeft; }
        if (gutter.current) gutter.current.scrollTop = element.scrollTop;
    };
    const text = 'font-mono text-2xs leading-4 whitespace-pre';
    return (
        <div className="space-y-1">
            <span className="text-2xs text-ink-2">{label}</span>
            <div className={`flex h-40 overflow-hidden rounded border bg-well ${errors.length && !dirty ? 'border-bad/60' : 'border-line'} focus-within:border-accent`}>
                <div ref={gutter} aria-hidden className={`w-7 shrink-0 select-none overflow-hidden border-r border-line py-1.5 pr-1 text-right text-ink-3 ${text}`}>
                    {lines.map((_, index) => <div key={index} className={bad.has(index + 1) && !dirty ? 'text-bad' : ''}>{index + 1}</div>)}
                </div>
                <div className="relative min-w-0 flex-1">
                    <div ref={shade} aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden p-1.5 ${text}`}>
                        {lines.map((line, index) => (
                            <div key={index} className={bad.has(index + 1) && !dirty ? 'bg-bad/15' : ''}>
                                {line ? tokenizeLine(line, known).map((token, at) => <span key={at} className={TOKEN_COLOURS[token.kind]}>{token.text}</span>) : '​'}
                            </div>
                        ))}
                    </div>
                    <textarea
                        ref={area}
                        aria-label={label}
                        value={draft}
                        spellCheck={false}
                        wrap="off"
                        onChange={(event) => setDraft(event.target.value)}
                        onScroll={sync}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); onChange(draft); }
                            if (event.key === 'Tab') {
                                event.preventDefault();
                                const target = event.currentTarget;
                                const start = target.selectionStart;
                                setDraft(`${draft.slice(0, start)}    ${draft.slice(target.selectionEnd)}`);
                                requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = start + 4; });
                            }
                        }}
                        className={`absolute inset-0 h-full w-full resize-none overflow-auto bg-transparent p-1.5 text-transparent caret-ink outline-none ${text}`}
                    />
                </div>
            </div>
            {errors.length > 0 && !dirty && (
                <ul role="alert" className="space-y-0.5 text-2xs leading-snug text-bad">
                    {errors.slice(0, 4).map((item, index) => <li key={index}>{item.line ? `Line ${item.line}: ` : ''}{item.message}</li>)}
                </ul>
            )}
            <div className="flex items-center justify-between">
                <span className="text-2xs text-ink-3">{dirty ? 'Not applied yet (Ctrl+Enter)' : errors.length ? 'Applied, with errors' : 'Applied'}</span>
                <Button size="sm" variant="primary" disabled={!dirty} onClick={() => onChange(draft)}>Apply</Button>
            </div>
        </div>
    );
};
