import React from 'react';
import { DraftNumber } from '../TextureParamField';

/**
 * A number setting of the Paint panels: a slider and, beside it, the shared number box, so a value can be
 * dragged or typed. Typed values may go past the slider's ends, up to `limits` (the slider's ends when
 * none are given).
 */
export const SliderRow: React.FC<{
    label: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    suffix?: string;
    /** Hard limits for typed values. */
    limits?: [number, number];
    /** Width class of the label column. */
    labelWidth?: string;
    /** The label names the controls without being shown (a row that already says what it is). */
    hideLabel?: boolean;
    hint?: string;
    disabled?: boolean;
    onChange: (value: number) => void;
}> = ({ label, value, min, max, step = 0.01, suffix, limits, labelWidth = 'w-20', hideLabel = false, hint, disabled = false, onChange }) => {
    const [low, high] = limits ?? [min, max];
    // A figure not worked out yet (a layout still being measured) shows as the slider's start, never NaN.
    const shown = Number.isFinite(value) ? value : min;
    return (
        <div className={`flex min-w-0 flex-1 items-center gap-2 text-2xs text-zinc-400 ${disabled ? 'pointer-events-none opacity-40' : ''}`} title={hint}>
            {!hideLabel && <span className={`${labelWidth} shrink-0 truncate`}>{label}</span>}
            <input type="range" min={min} max={max} step={step} value={Math.min(max, Math.max(min, shown))} disabled={disabled}
                onChange={(event) => onChange(Number(event.target.value))} className="h-1 min-w-0 flex-1 accent-sky-500" aria-label={`${label} slider`} />
            <DraftNumber label={label} value={shown} integer={step >= 1} className="w-12 shrink-0" limit={(next) => Math.min(high, Math.max(low, next))} onCommit={onChange} />
            {suffix && <span className="w-3 shrink-0 text-zinc-500">{suffix}</span>}
        </div>
    );
};
