import { describe, expect, it } from 'vitest';
import { defaultNodeParams } from '../../texturing/graph/document';
import { blueNoiseTile } from '../../texturing/graph/noiseMath';
import { GRUNGE_LOOKS, NOISE_NODES, NOISE_REFERENCES } from '../../texturing/graph/nodes/noises';
import { PATTERN_NODES, PATTERN_REFERENCES, weaveCount } from '../../texturing/graph/nodes/patterns';
import { COLOUR_NODES, COLOUR_REFERENCES, colourFigures, equalizeTables, lookupStrip, quantizePalette } from '../../texturing/graph/nodes/colour';
import { tileSafeDirection } from '../../texturing/graph/safeTransform';
import { textureNodeDefinitionByType } from '../../texturing/graph/registry';

const SEED = 1234.5;
const SAMPLES = 24;

/** The largest difference between a picture's left and right edges and its top and bottom, and the spread of its values. */
const edges = (picture: (u: number, v: number) => number) => {
    let gap = 0;
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i <= SAMPLES; i++) {
        const t = (i + 0.37) / (SAMPLES + 1);
        gap = Math.max(gap, Math.abs(picture(0, t) - picture(1, t)), Math.abs(picture(t, 0) - picture(t, 1)));
        for (let j = 0; j <= 6; j++) {
            const value = picture(t, (j + 0.21) / 7);
            low = Math.min(low, value);
            high = Math.max(high, value);
        }
    }
    return { gap, low, high };
};

const withDefaults = (type: string, extra: Record<string, unknown> = {}) => ({ ...defaultNodeParams(textureNodeDefinitionByType(type)!), ...extra });

describe('noises and grunges', () => {
    it('every node tiles: its edges match when it repeats, and it draws something', () => {
        for (const definition of NOISE_NODES) {
            const reference = NOISE_REFERENCES[definition.type];
            expect(reference, `${definition.type} has a CPU twin`).toBeTruthy();
            const { gap, low, high } = edges((u, v) => reference(u, v, withDefaults(definition.type), SEED));
            expect(gap, `${definition.type} edges`).toBeLessThan(1e-6);
            expect(low, `${definition.type} low`).toBeGreaterThanOrEqual(0);
            expect(high, `${definition.type} high`).toBeLessThanOrEqual(1);
            expect(high - low, `${definition.type} varies`).toBeGreaterThan(0.02);
            expect(definition.description.length).toBeGreaterThan(30);
        }
    });

    it('every grunge look tiles, at odd directions and with disorder too', () => {
        for (const look of GRUNGE_LOOKS) {
            const { gap, high, low } = edges((u, v) => NOISE_REFERENCES.grunge(u, v, withDefaults('grunge', { look: look.key, disorder: 0.6 }), SEED));
            expect(gap, `grunge ${look.key}`).toBeLessThan(1e-6);
            expect(high - low, `grunge ${look.key} varies`).toBeGreaterThan(0.02);
        }
        for (const angle of [17, 33, 61, -48, 125]) {
            for (const type of ['directionalNoise', 'directionalScratches']) {
                expect(edges((u, v) => NOISE_REFERENCES[type](u, v, withDefaults(type, { angle, density: 0.9 }), SEED)).gap, `${type} at ${angle}`).toBeLessThan(1e-6);
            }
        }
        expect(edges((u, v) => NOISE_REFERENCES.clouds(u, v, withDefaults('clouds', { disorder: 1 }), SEED)).gap).toBeLessThan(1e-6);
    });

    it('offers each grunge look in the finder by name, and snaps directions so they tile', () => {
        const grunge = textureNodeDefinitionByType('grunge')!;
        expect(grunge.variants?.length).toBe(GRUNGE_LOOKS.length);
        expect(GRUNGE_LOOKS.length).toBeGreaterThanOrEqual(12);
        expect(tileSafeDirection(0)).toEqual({ step: [1, 0], degrees: 0 });
        expect(tileSafeDirection(45).step).toEqual([1, 1]);
        expect(tileSafeDirection(27).degrees).toBeCloseTo(26.57, 1);
    });

    it('blue noise holds every value once, spread evenly round its square', () => {
        const tile = blueNoiseTile(16, 3);
        const ranks = [...tile].map((value) => Math.round(value * 256 - 0.5)).sort((a, b) => a - b);
        expect(ranks).toEqual(Array.from({ length: 256 }, (_, i) => i));
        // The darkest tenth of its places lie apart: none touches another, round the edges too.
        const darkest = [...tile].map((value, at) => ({ value, at })).filter((cell) => cell.value < 0.1).map((cell) => [cell.at % 16, Math.floor(cell.at / 16)]);
        for (const [x, y] of darkest) {
            for (const [ox, oy] of darkest) {
                if (x === ox && y === oy) continue;
                const dx = Math.min(Math.abs(x - ox), 16 - Math.abs(x - ox));
                const dy = Math.min(Math.abs(y - oy), 16 - Math.abs(y - oy));
                expect(Math.max(dx, dy)).toBeGreaterThan(1);
            }
        }
    });
});

describe('patterns', () => {
    it('every pattern tiles and draws something', () => {
        for (const definition of PATTERN_NODES) {
            const reference = PATTERN_REFERENCES[definition.type];
            expect(reference, `${definition.type} has a CPU twin`).toBeTruthy();
            const { gap, low, high } = edges((u, v) => reference(u, v, withDefaults(definition.type), SEED));
            expect(gap, `${definition.type} edges`).toBeLessThan(1e-6);
            expect(low, `${definition.type} low`).toBeGreaterThanOrEqual(0);
            expect(high, `${definition.type} high`).toBeLessThanOrEqual(1 + 1e-9);
            expect(high - low, `${definition.type} varies`).toBeGreaterThan(0.05);
            expect(definition.description.length).toBeGreaterThan(30);
        }
        expect(edges((u, v) => PATTERN_REFERENCES.weaveThreads(u, v, withDefaults('weaveGenerator'), SEED)).gap).toBeLessThan(1e-9);
    });

    it('tiles at odd angles, every weave and odd counts', () => {
        for (const angle of [13, 29, 47, 71, -100]) {
            expect(edges((u, v) => PATTERN_REFERENCES.stripes(u, v, withDefaults('stripes', { angle, wave: 0.6, waves: 3 }), SEED)).gap, `stripes at ${angle}`).toBeLessThan(1e-6);
            expect(edges((u, v) => PATTERN_REFERENCES.axialGradient(u, v, withDefaults('axialGradient', { angle, repeats: 3 }), SEED)).gap).toBeLessThan(1e-6);
        }
        for (const weave of ['plain', 'twill', 'satin', 'basket']) {
            for (const count of [7, 9, 13]) {
                expect(edges((u, v) => PATTERN_REFERENCES.weaveGenerator(u, v, withDefaults('weaveGenerator', { weave, count }), SEED)).gap, `${weave} ${count}`).toBeLessThan(1e-9);
            }
        }
        expect(weaveCount(7, 2)).toBe(10);
        expect(weaveCount(16, 1)).toBe(16);
        for (const rows of [3, 7]) {
            expect(edges((u, v) => PATTERN_REFERENCES.triangleGrid(u, v, withDefaults('triangleGrid', { rows, columns: 5 }), SEED)).gap, `triangles ${rows} rows`).toBeLessThan(1e-9);
            expect(edges((u, v) => PATTERN_REFERENCES.arcPavement(u, v, withDefaults('arcPavement', { rows, columns: 3 }), SEED)).gap, `fans ${rows} rows`).toBeLessThan(1e-9);
        }
    });

    it('shows only arcs between rows of fans, never a straight cut where rows meet', () => {
        // How often the stone changes crossing a horizontal line: on the lines where rows meet it is no
        // more than on lines between them (arcs and the stones' own joints cross both), never all along.
        const params = withDefaults('arcPavement', { gap: 0, rows: 8, columns: 4 });
        const rate = (offset: number) => {
            let changed = 0;
            let total = 0;
            for (let row = 1; row < 8; row++) {
                for (let i = 0; i < 300; i++) {
                    const u = (i + 0.5) / 300;
                    const y = (row + offset) / 8;
                    total++;
                    if (Math.abs(PATTERN_REFERENCES.arcPavement(u, y - 1e-4, params, SEED) - PATTERN_REFERENCES.arcPavement(u, y + 1e-4, params, SEED)) > 1e-6) changed++;
                }
            }
            return changed / total;
        };
        const between = (rate(0.25) + rate(0.5) + rate(0.75)) / 3;
        expect(rate(0)).toBeLessThan(0.35);
        expect(rate(0)).toBeLessThan(between * 1.5);
    });

    it('covers the ground with fans, leaving only the gaps between stones', () => {
        let empty = 0;
        let total = 0;
        for (let i = 0; i < 60; i++) for (let j = 0; j < 60; j++) {
            total++;
            if (PATTERN_REFERENCES.arcPavement((i + 0.5) / 60, (j + 0.5) / 60, withDefaults('arcPavement', { gap: 0 }), SEED) === 0) empty++;
        }
        expect(empty / total).toBeLessThan(0.02);
    });
});

describe('adjustments and colour', () => {
    /** A colourful picture that tiles (read at the same pixel at both edges, as a tiling picture is), to feed the pixel maths. */
    const input = (u0: number, v0: number): [number, number, number, number] => {
        const u = u0 - Math.floor(u0);
        const v = v0 - Math.floor(v0);
        return [0.5 + 0.5 * Math.sin(2 * Math.PI * u), 0.5 + 0.5 * Math.cos(2 * Math.PI * (u + v)), 0.5 + 0.4 * Math.sin(4 * Math.PI * v), 1];
    };
    const scalar = (value: number | readonly number[]) => (typeof value === 'number' ? value : value[0] + value[1] * 3 + value[2] * 7);

    it('works pixel by pixel, so what tiles going in tiles coming out', () => {
        const params: Record<string, Record<string, unknown>> = {
            histogramSelect: withDefaults('histogramSelect'), histogramShift: withDefaults('histogramShift'), channelMixer: withDefaults('channelMixer', { rg: 0.4, bc: 0.1 }),
            levelsPerChannel: withDefaults('levelsPerChannel', { gMid: 0.3, bOutHigh: 0.7 }), idToMask: withDefaults('idToMask', { mode: 'random' }),
        };
        for (const [type, settings] of Object.entries(params)) {
            const reference = COLOUR_REFERENCES[type as keyof typeof params & keyof typeof COLOUR_REFERENCES] as (c: readonly number[], p: Record<string, unknown>, s: number) => number | number[];
            expect(edges((u, v) => scalar(reference(input(u, v), settings, SEED))).gap, type).toBeLessThan(1e-9);
        }
        for (const definition of COLOUR_NODES) expect(definition.description.length).toBeGreaterThan(30);
    });

    it('selects, shifts, mixes and levels as set', () => {
        expect(COLOUR_REFERENCES.histogramSelect([0.5, 0.5, 0.5, 1], withDefaults('histogramSelect'))).toBe(1);
        expect(COLOUR_REFERENCES.histogramSelect([0.95, 0.95, 0.95, 1], withDefaults('histogramSelect'))).toBe(0);
        // Past white comes round from black; white itself with no shift stays white.
        expect(COLOUR_REFERENCES.histogramShift([0.9, 0.2, 1, 1], { shift: 0.25 }).map((x) => Number(x.toFixed(6)))).toEqual([0.15, 0.45, 0.25, 1]);
        expect(COLOUR_REFERENCES.histogramShift([1, 1, 1, 1], { shift: 0 })).toEqual([1, 1, 1, 1]);
        // The mixer starts as it is, and swaps channels when set to.
        expect(COLOUR_REFERENCES.channelMixer([0.2, 0.4, 0.6, 1], withDefaults('channelMixer'))).toEqual([0.2, 0.4, 0.6, 1]);
        expect(COLOUR_REFERENCES.channelMixer([0.2, 0.4, 0.6, 1], withDefaults('channelMixer', { rr: 0, rb: 1, br: 1, bb: 0 }))).toEqual([0.6, 0.4, 0.2, 1]);
        const levelled = COLOUR_REFERENCES.levelsPerChannel([0.5, 0.5, 0.5, 1], withDefaults('levelsPerChannel', { rInLow: 0.5, gOutHigh: 0.5 }));
        expect(levelled[0]).toBe(0);
        expect(levelled[1]).toBeCloseTo(0.25, 6);
        expect(levelled[2]).toBeCloseTo(0.5, 6);
        expect(textureNodeDefinitionByType('levelsPerChannel')!.params.filter((param) => param.group === 'Green')).toHaveLength(5);
    });

    it('picks ID colours, or keeps IDs at random by a share', () => {
        const picked = withDefaults('idToMask', { count: 2, colour1: [1, 0, 0, 1], colour2: [0, 1, 0, 1] });
        expect(COLOUR_REFERENCES.idToMask([1, 0, 0, 1], picked, SEED)).toBe(1);
        expect(COLOUR_REFERENCES.idToMask([0, 1, 0, 1], picked, SEED)).toBe(1);
        expect(COLOUR_REFERENCES.idToMask([0, 0, 1, 1], picked, SEED)).toBe(0);
        let kept = 0;
        for (let i = 1; i <= 400; i++) kept += COLOUR_REFERENCES.idToMask([(i % 20) / 20, Math.floor(i / 20) / 20, 0.5, 1], withDefaults('idToMask', { mode: 'random', fraction: 0.3 }), SEED);
        expect(kept / 400).toBeGreaterThan(0.2);
        expect(kept / 400).toBeLessThan(0.4);
        expect(COLOUR_REFERENCES.idToMask([0, 0, 0, 1], withDefaults('idToMask', { mode: 'random', fraction: 1 }), SEED)).toBe(0);
    });

    it('equalizes, matches colours and quantizes from figures of the picture', () => {
        // A picture all in the darker half: equalized, its values spread to fill black to white.
        const pixels = new Uint8Array(4 * 256);
        for (let i = 0; i < 256; i++) pixels.set([i >> 1, i >> 1, i >> 1, 255], i * 4);
        const tables = equalizeTables(pixels);
        expect(tables[0][0]).toBe(0);
        expect(tables[0][127]).toBeCloseTo(1, 5);
        expect(COLOUR_REFERENCES.equalize([64 / 255, 64 / 255, 64 / 255], tables, 'channels')[0]).toBeGreaterThan(0.45);
        // Matching moves the average colour onto the reference's.
        const from = colourFigures(new Uint8Array([51, 51, 51, 255, 102, 102, 102, 255]));
        const to = colourFigures(new Uint8Array([153, 102, 51, 255, 153, 102, 51, 255]));
        const matched = COLOUR_REFERENCES.colourMatch([0.3, 0.3, 0.3], from, to, false);
        expect(matched.map((x) => Number(x.toFixed(3)))).toEqual([0.6, 0.4, 0.2]);
        // Quantizing two clear colour groups finds one colour for each.
        const groups = new Uint8Array(4 * 100);
        for (let i = 0; i < 100; i++) groups.set(i < 50 ? [250, 10, 10, 255] : [10, 10, 250, 255], i * 4);
        const palette = quantizePalette(groups, 2, SEED).map((colour) => colour.map((x) => Math.round(x * 255)));
        expect(palette.sort((a, b) => a[0] - b[0])).toEqual([[10, 10, 250], [250, 10, 10]]);
        expect(COLOUR_REFERENCES.palette([0.9, 0.1, 0.1], [[0, 0, 1], [1, 0, 0]])).toEqual([1, 0, 0]);
    });

    it('looks colours up in a strip picture, a neutral strip giving them back', () => {
        const n = 8;
        const neutral = (x: number, y: number) => [(x % n) / (n - 1), y / (n - 1), Math.floor(x / n) / (n - 1)];
        for (const colour of [[0.2, 0.7, 0.4], [1, 0, 0.5], [0.33, 0.33, 0.9]]) {
            lookupStrip(colour, n, neutral).forEach((value, k) => expect(value).toBeCloseTo(colour[k], 6));
        }
        const flippedNeutral = (x: number, y: number) => [(x % n) / (n - 1), 1 - y / (n - 1), Math.floor(x / n) / (n - 1)];
        expect(lookupStrip([0.2, 0.7, 0.4], n, flippedNeutral, true)[1]).toBeCloseTo(0.7, 6);
    });
});
