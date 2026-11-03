import { describe, expect, it } from 'vitest';
import { hsvToRgb, parseHex, recentColours, rememberColour, rgbToHsv, sameColour, toHexText } from '../../components/UI/colourMath';

describe('colour picker maths', () => {
    it('reads hex in its four forms, with or without the #', () => {
        expect(parseHex('#fff')).toEqual({ r: 1, g: 1, b: 1, a: 1 });
        expect(parseHex('0f08')).toEqual({ r: 0, g: 1, b: 0, a: 0x88 / 255 });
        expect(parseHex('#336699')).toEqual({ r: 0x33 / 255, g: 0x66 / 255, b: 0x99 / 255, a: 1 });
        expect(parseHex(' #33669980 ')).toEqual({ r: 0x33 / 255, g: 0x66 / 255, b: 0x99 / 255, a: 0x80 / 255 });
        for (const bad of ['', '#12', '#12345', '#gggggg', 'red']) expect(parseHex(bad)).toBeNull();
    });

    it('writes hex, adding alpha only when asked and see-through', () => {
        expect(toHexText({ r: 1, g: 0.5, b: 0, a: 1 })).toBe('#ff8000');
        expect(toHexText({ r: 1, g: 0.5, b: 0, a: 0.5 })).toBe('#ff8000');
        expect(toHexText({ r: 1, g: 0.5, b: 0, a: 0.5 }, true)).toBe('#ff800080');
        expect(toHexText({ r: 1, g: 0.5, b: 0, a: 1 }, true)).toBe('#ff8000');
    });

    it('goes to hue, saturation and value and back without loss', () => {
        for (const hex of ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#9e998c', '#e9b226', '#123456', '#fedcba']) {
            const colour = parseHex(hex)!;
            expect(toHexText(hsvToRgb(rgbToHsv(colour)))).toBe(hex);
        }
    });

    it('keeps the hue of a grey, so dragging through grey does not lose it', () => {
        const grey = { r: 0.5, g: 0.5, b: 0.5, a: 1 };
        expect(rgbToHsv(grey, 0.62).h).toBeCloseTo(0.62);
        expect(rgbToHsv(grey, 0.62).s).toBe(0);
        expect(rgbToHsv({ r: 1, g: 0, b: 0, a: 1 }, 0.62).h).toBe(0);
    });

    it('keeps the latest colours, newest first and once each', () => {
        for (let i = 0; i < 20; i++) rememberColour({ r: i / 20, g: 0, b: 0, a: 1 });
        rememberColour({ r: 5 / 20, g: 0, b: 0, a: 1 });
        const kept = recentColours();
        expect(kept.length).toBe(12);
        expect(sameColour(kept[0], { r: 5 / 20, g: 0, b: 0, a: 1 })).toBe(true);
        expect(new Set(kept.map((colour) => toHexText(colour, true))).size).toBe(kept.length);
    });
});
