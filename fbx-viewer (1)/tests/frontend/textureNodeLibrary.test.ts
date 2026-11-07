import { describe, expect, it } from 'vitest';
import { defaultNodeParams } from '../../texturing/graph/document';
import { blueNoiseTile } from '../../texturing/graph/noiseMath';
import { GRUNGE_LOOKS, NOISE_NODES, NOISE_REFERENCES } from '../../texturing/graph/nodes/noises';
import { PATTERN_NODES, PATTERN_REFERENCES, weaveCount } from '../../texturing/graph/nodes/patterns';
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
