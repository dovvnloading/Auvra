import React, { useEffect, useRef, useState } from 'react';
import { Pipette } from 'lucide-react';
import { IconButton, Popover } from './kit';
import { cssColour, hsvToRgb, parseHex, recentColours, rememberColour, rgbToHsv, sameColour, toHexText, type Hsva, type Rgba } from './colourMath';

/**
 * THE COLOUR PICKER
 *
 * A swatch that opens a panel beside it: a square of saturation and brightness, a strip of hues (and one
 * of see-through when the colour has it), hex and red/green/blue boxes, the colour it had when opened
 * (click it to go back), colours picked lately, and an eyedropper. Changes arrive while dragging, as a
 * slider's do; every colour box in the editor is one of these.
 */

const CHECKER = 'repeating-conic-gradient(#3f3f46 0% 25%, #27272a 0% 50%) 0 0 / 8px 8px';
const HUES = 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)';
const FIELD = 'h-6 w-full rounded border border-line bg-well text-xs tabular-nums text-ink transition-colors duration-75 hover:border-gray-700 focus:border-accent/70 focus:outline-none';

type EyeDropperConstructor = new () => { open: () => Promise<{ sRGBHex: string }> };
const screenDropper = (): EyeDropperConstructor | null => (window as unknown as { EyeDropper?: EyeDropperConstructor }).EyeDropper ?? null;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Follows a press on an area: `onMove` gets where the pointer is within it, from 0 to 1 across and down. */
const dragOn = (onMove: (x: number, y: number) => void) => (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    element.focus();
    const box = element.getBoundingClientRect();
    const move = (clientX: number, clientY: number) => onMove(clamp01((clientX - box.left) / box.width), clamp01((clientY - box.top) / box.height));
    move(event.clientX, event.clientY);
    const onPointerMove = (moved: PointerEvent) => move(moved.clientX, moved.clientY);
    const stop = () => {
        element.removeEventListener('pointermove', onPointerMove);
        element.removeEventListener('pointerup', stop);
        element.removeEventListener('pointercancel', stop);
    };
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', stop);
    element.addEventListener('pointercancel', stop);
};

/** A number typed in, applied on Enter or on leaving the box. */
const NumberBox: React.FC<{ label: string; value: number; max: number; onCommit: (value: number) => void }> = ({ label, value, max, onCommit }) => {
    const [draft, setDraft] = useState(String(value));
    useEffect(() => setDraft(String(value)), [value]);
    const commit = () => {
        const number = Math.round(Number(draft));
        if (draft.trim() && Number.isFinite(number)) onCommit(Math.min(max, Math.max(0, number)));
        else setDraft(String(value));
    };
    return (
        <label className="flex min-w-0 flex-1 flex-col items-center gap-0.5 text-[10px] text-ink-3">
            <input aria-label={label} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit}
                onKeyDown={(event) => { if (event.key === 'Enter') commit(); }} className={`${FIELD} px-0.5 text-center`} />
            {label.slice(0, 1)}
        </label>
    );
};

const Panel: React.FC<{
    value: Rgba;
    original: Rgba;
    alpha: boolean;
    onChange: (value: Rgba) => void;
    onPick?: () => void;
}> = ({ value, original, alpha, onChange, onPick }) => {
    const [hsv, setHsv] = useState<Hsva>(() => rgbToHsv(value));
    const sent = useRef<Rgba>(value);
    // A change from outside (undo, another view) is followed; the hue survives greys.
    useEffect(() => {
        if (!sameColour(value, sent.current)) setHsv((current) => rgbToHsv(value, current.h));
        sent.current = value;
    }, [value]);
    const set = (next: Hsva) => {
        setHsv(next);
        const colour = hsvToRgb(next);
        sent.current = colour;
        onChange(colour);
    };
    const setColour = (colour: Rgba) => set(rgbToHsv({ ...colour, a: alpha ? colour.a : 1 }, hsv.h));
    const current = hsvToRgb(hsv);
    const [hexDraft, setHexDraft] = useState(toHexText(current, alpha));
    const hexText = toHexText(current, alpha);
    useEffect(() => setHexDraft(hexText), [hexText]);
    const commitHex = () => {
        const parsed = parseHex(hexDraft);
        if (parsed) setColour(parsed);
        else setHexDraft(hexText);
    };
    const step = (event: React.KeyboardEvent, apply: (amount: number, key: string) => Hsva | null) => {
        const amount = event.shiftKey ? 0.1 : 0.01;
        const next = apply(amount, event.key);
        if (!next) return;
        event.preventDefault();
        set(next);
    };
    const dropper = onPick ? null : screenDropper();
    const pickFromScreen = async () => {
        if (!dropper) return;
        try {
            const picked = parseHex((await new dropper().open()).sRGBHex);
            if (picked) setColour(picked);
        } catch {
            // Escape leaves the colour as it was.
        }
    };
    const hue = cssColour(hsvToRgb({ h: hsv.h, s: 1, v: 1, a: 1 }));
    const recent = recentColours();

    return (
        <div className="space-y-2 p-2.5">
            <div
                role="slider"
                tabIndex={0}
                aria-label="Saturation and brightness"
                aria-valuetext={`saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
                className="relative h-32 w-full cursor-crosshair touch-none rounded outline-none focus-visible:ring-1 focus-visible:ring-accent"
                style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hue})` }}
                onPointerDown={dragOn((x, y) => set({ ...hsv, s: x, v: 1 - y }))}
                onKeyDown={(event) => step(event, (amount, key) => (key === 'ArrowLeft' ? { ...hsv, s: clamp01(hsv.s - amount) }
                    : key === 'ArrowRight' ? { ...hsv, s: clamp01(hsv.s + amount) }
                        : key === 'ArrowDown' ? { ...hsv, v: clamp01(hsv.v - amount) }
                            : key === 'ArrowUp' ? { ...hsv, v: clamp01(hsv.v + amount) } : null))}
            >
                <span className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.6)]"
                    style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: cssColour({ ...current, a: 1 }) }} />
            </div>
            <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1 space-y-1.5">
                    <div
                        role="slider"
                        tabIndex={0}
                        aria-label="Hue"
                        aria-valuemin={0}
                        aria-valuemax={360}
                        aria-valuenow={Math.round(hsv.h * 360)}
                        className="relative h-3 cursor-pointer touch-none rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-accent"
                        style={{ background: HUES }}
                        onPointerDown={dragOn((x) => set({ ...hsv, h: Math.min(x, 0.9999) }))}
                        onKeyDown={(event) => step(event, (amount, key) => (key === 'ArrowLeft' ? { ...hsv, h: (hsv.h - amount + 1) % 1 } : key === 'ArrowRight' ? { ...hsv, h: (hsv.h + amount) % 1 } : null))}
                    >
                        <span className="pointer-events-none absolute top-1/2 h-3.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-white shadow-[0_0_0_1px_rgb(0_0_0/0.6)]"
                            style={{ left: `${hsv.h * 100}%`, background: hue }} />
                    </div>
                    {alpha && (
                        <div
                            role="slider"
                            tabIndex={0}
                            aria-label="See-through"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.round(hsv.a * 100)}
                            className="relative h-3 cursor-pointer touch-none rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-accent"
                            style={{ background: `linear-gradient(to right, transparent, ${cssColour({ ...current, a: 1 })}), ${CHECKER}` }}
                            onPointerDown={dragOn((x) => set({ ...hsv, a: x }))}
                            onKeyDown={(event) => step(event, (amount, key) => (key === 'ArrowLeft' ? { ...hsv, a: clamp01(hsv.a - amount) } : key === 'ArrowRight' ? { ...hsv, a: clamp01(hsv.a + amount) } : null))}
                        >
                            <span className="pointer-events-none absolute top-1/2 h-3.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-white shadow-[0_0_0_1px_rgb(0_0_0/0.6)]"
                                style={{ left: `${hsv.a * 100}%` }} />
                        </div>
                    )}
                </div>
                {/* What it was when opened (click to go back) and what it is now. */}
                <div className="flex h-7 w-12 shrink-0 overflow-hidden rounded border border-line" style={{ background: CHECKER }}>
                    <button type="button" aria-label="Back to the colour it had" title="Back to the colour it had" onClick={() => setColour(original)}
                        className="h-full flex-1" style={{ background: cssColour(original) }} />
                    <span className="h-full flex-1" style={{ background: cssColour(current) }} />
                </div>
            </div>
            <div className="flex items-end gap-1">
                <label className="flex w-[74px] shrink-0 flex-col items-center gap-0.5 text-[10px] text-ink-3">
                    <input aria-label="Hex" value={hexDraft} spellCheck={false} onChange={(event) => setHexDraft(event.target.value)} onBlur={commitHex}
                        onKeyDown={(event) => { if (event.key === 'Enter') commitHex(); }} className={`${FIELD} px-1.5 font-mono`} />
                    Hex
                </label>
                <NumberBox label="Red" value={Math.round(current.r * 255)} max={255} onCommit={(red) => setColour({ ...current, r: red / 255 })} />
                <NumberBox label="Green" value={Math.round(current.g * 255)} max={255} onCommit={(green) => setColour({ ...current, g: green / 255 })} />
                <NumberBox label="Blue" value={Math.round(current.b * 255)} max={255} onCommit={(blue) => setColour({ ...current, b: blue / 255 })} />
                {alpha && <NumberBox label="Alpha %" value={Math.round(current.a * 100)} max={100} onCommit={(percent) => setColour({ ...current, a: percent / 100 })} />}
                {(onPick || dropper) && (
                    <IconButton label={onPick ? 'Pick a colour from the model' : 'Pick a colour from the screen'} onClick={() => (onPick ? onPick() : void pickFromScreen())} className="mb-[15px]">
                        <Pipette size={13} />
                    </IconButton>
                )}
            </div>
            {recent.length > 0 && (
                <div className="flex flex-wrap gap-1 border-t border-line pt-2" aria-label="Colours picked lately">
                    {recent.map((colour) => (
                        <button key={toHexText(colour, true)} type="button" aria-label={`Use ${toHexText(colour, true)}`} title={toHexText(colour, true)} onClick={() => setColour(colour)}
                            className="h-4 w-4 overflow-hidden rounded-sm border border-line" style={{ background: `linear-gradient(${cssColour(colour)}, ${cssColour(colour)}), ${CHECKER}` }} />
                    ))}
                </div>
            )}
        </div>
    );
};

/** A colour box: a swatch opening the picker. */
export const ColourSwatch: React.FC<{
    value: Rgba;
    onChange: (value: Rgba) => void;
    /** What the colour is for: the box's name and the picker's title. */
    label: string;
    /** Whether the colour has a see-through part to edit. */
    alpha?: boolean;
    disabled?: boolean;
    /** Size of the swatch (Tailwind classes); 40 × 24 to begin with. */
    className?: string;
    /** An eyedropper of the host's own (picking off a model, say) in place of picking from the screen. */
    onPick?: () => void;
    /** For a label elsewhere that points at the box. */
    id?: string;
}> = ({ value, onChange, label, alpha = false, disabled = false, className = 'h-6 w-10', onPick, id }) => {
    const anchor = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const [original, setOriginal] = useState<Rgba>(value);
    const close = () => {
        setOpen(false);
        if (!sameColour(original, value)) rememberColour(value);
    };
    return (
        <>
            <button
                ref={anchor}
                id={id}
                type="button"
                aria-label={label}
                aria-haspopup="dialog"
                aria-expanded={open}
                title={`${label}: ${toHexText(value, alpha)}`}
                disabled={disabled}
                onClick={() => { if (open) close(); else { setOriginal(value); setOpen(true); } }}
                className={`relative shrink-0 overflow-hidden rounded border transition-colors duration-75 disabled:cursor-not-allowed disabled:opacity-40 ${open ? 'border-accent' : 'border-line hover:border-gray-600'} ${className}`}
                style={{ background: `linear-gradient(${cssColour(value)}, ${cssColour(value)}), ${CHECKER}` }}
            />
            <Popover anchor={anchor} open={open} onClose={close} width={272} label={label}>
                <Panel value={value} original={original} alpha={alpha} onChange={onChange} onPick={onPick ? () => { close(); onPick(); } : undefined} />
            </Popover>
        </>
    );
};

/** A colour box for a value kept as hex text (#rrggbb, or #rrggbbaa with `alpha`). */
export const ColourField: React.FC<{
    value: string;
    onChange: (value: string) => void;
    label: string;
    alpha?: boolean;
    disabled?: boolean;
    className?: string;
    /** Shows the hex beside the swatch. */
    showHex?: boolean;
    onPick?: () => void;
    id?: string;
}> = ({ value, onChange, label, alpha = false, disabled, className, showHex = false, onPick, id }) => {
    const colour = parseHex(value) ?? { r: 0, g: 0, b: 0, a: 1 };
    const swatch = <ColourSwatch id={id} value={colour} onChange={(next) => onChange(toHexText(next, alpha))} label={label} alpha={alpha} disabled={disabled} className={className} onPick={onPick} />;
    if (!showHex) return swatch;
    return (
        <span className="inline-flex items-center gap-1.5">
            {swatch}
            <span className="font-mono text-2xs text-ink-3">{toHexText(colour, alpha)}</span>
        </span>
    );
};

/** A colour box for a value kept as red, green, blue (and alpha) from 0 to 1, sRGB: the length given comes back. */
export const ColourFieldRgb: React.FC<{
    value: readonly number[];
    onChange: (value: number[]) => void;
    label: string;
    alpha?: boolean;
    disabled?: boolean;
    className?: string;
    showHex?: boolean;
    onPick?: () => void;
}> = ({ value, onChange, label, alpha = false, disabled, className, showHex = false, onPick }) => {
    const colour: Rgba = { r: value[0] ?? 0, g: value[1] ?? 0, b: value[2] ?? 0, a: value.length > 3 ? value[3] : 1 };
    const swatch = (
        <ColourSwatch value={colour} label={label} alpha={alpha && value.length > 3} disabled={disabled} className={className} onPick={onPick}
            onChange={(next) => onChange(value.length > 3 ? [next.r, next.g, next.b, alpha ? next.a : value[3]] : [next.r, next.g, next.b])} />
    );
    if (!showHex) return swatch;
    return (
        <span className="inline-flex items-center gap-1.5">
            {swatch}
            <span className="font-mono text-2xs text-ink-3">{toHexText(colour)}</span>
        </span>
    );
};
