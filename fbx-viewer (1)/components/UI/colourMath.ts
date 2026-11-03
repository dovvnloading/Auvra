/**
 * Colours as the editor's colour picker handles them: hex text, red/green/blue/alpha from 0 to 1 as they
 * are stored (sRGB), and hue/saturation/value for the picker's square and strips.
 */

export interface Rgba { r: number; g: number; b: number; a: number }
/** Hue from 0 to 1 round the wheel; saturation, value and alpha from 0 to 1. */
export interface Hsva { h: number; s: number; v: number; a: number }

const clamp01 = (value: number): number => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

/** Reads #rgb, #rgba, #rrggbb or #rrggbbaa (the # may be left off); null for anything else. */
export const parseHex = (text: string): Rgba | null => {
    const digits = text.trim().replace(/^#/, '');
    if (!/^[0-9a-f]+$/i.test(digits) || ![3, 4, 6, 8].includes(digits.length)) return null;
    const full = digits.length <= 4 ? digits.split('').map((digit) => digit + digit).join('') : digits;
    const channel = (at: number) => parseInt(full.slice(at, at + 2), 16) / 255;
    return { r: channel(0), g: channel(2), b: channel(4), a: full.length === 8 ? channel(6) : 1 };
};

/** As #rrggbb, or #rrggbbaa when `alpha` is wanted and the colour is see-through. */
export const toHexText = (colour: Rgba, alpha = false): string => {
    const two = (value: number) => Math.round(clamp01(value) * 255).toString(16).padStart(2, '0');
    return `#${two(colour.r)}${two(colour.g)}${two(colour.b)}${alpha && colour.a < 1 ? two(colour.a) : ''}`;
};

/** Hue, saturation and value of a colour. A grey has no hue of its own: it keeps `hue`. */
export const rgbToHsv = (colour: Rgba, hue = 0): Hsva => {
    const r = clamp01(colour.r), g = clamp01(colour.g), b = clamp01(colour.b);
    const max = Math.max(r, g, b);
    const range = max - Math.min(r, g, b);
    let h = hue;
    if (range > 1e-9) {
        if (max === r) h = ((g - b) / range + 6) % 6;
        else if (max === g) h = (b - r) / range + 2;
        else h = (r - g) / range + 4;
        h /= 6;
    }
    return { h, s: max > 1e-9 ? range / max : 0, v: max, a: clamp01(colour.a) };
};

export const hsvToRgb = (colour: Hsva): Rgba => {
    const h = (((colour.h % 1) + 1) % 1) * 6;
    const s = clamp01(colour.s);
    const v = clamp01(colour.v);
    const sector = Math.floor(h) % 6;
    const f = h - Math.floor(h);
    const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
    const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][sector];
    return { r, g, b, a: clamp01(colour.a) };
};

/** A CSS colour for drawing. */
export const cssColour = (colour: Rgba): string =>
    `rgba(${Math.round(clamp01(colour.r) * 255)}, ${Math.round(clamp01(colour.g) * 255)}, ${Math.round(clamp01(colour.b) * 255)}, ${clamp01(colour.a)})`;

/** Whether two colours read the same at 8 bits a channel. */
export const sameColour = (a: Rgba, b: Rgba): boolean => toHexText(a, true) === toHexText(b, true);

// Colours picked lately, newest first: shared by every picker while the editor is open.
const RECENT_LIMIT = 12;
let recent: Rgba[] = [];

export const recentColours = (): readonly Rgba[] => recent;

export const rememberColour = (colour: Rgba): void => {
    recent = [colour, ...recent.filter((other) => !sameColour(other, colour))].slice(0, RECENT_LIMIT);
};
