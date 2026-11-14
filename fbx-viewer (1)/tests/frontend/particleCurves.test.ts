import { describe, expect, it } from 'vitest';
import {
    BAKE_SAMPLES, PARTICLE_CURVE_INTERPOLATIONS, bakeCurve, evaluateCurve, particleCurveSegment,
    resolveParticleEffect, sanitizeParticleEffect, type Curve,
} from '../../runtime/particleEffect';

describe('particle curve interpolation', () => {
    const rise: Curve['points'] = [[0, 0], [0.25, 1], [1, 2]];

    it('preserves legacy linear interpolation and holds a step until the following key', () => {
        expect(evaluateCurve(rise, 0.125)).toBe(0.5);
        expect(evaluateCurve(rise, 0.249999, 'step')).toBe(0);
        expect(evaluateCurve(rise, 0.25, 'step')).toBe(1);
        expect(evaluateCurve(rise, 0.999999, 'step')).toBe(1);
        expect(evaluateCurve(rise, 1, 'step')).toBe(2);
    });

    it('uses PCHIP tangents on uneven spans, with continuous slope through interior keys', () => {
        // Secants 4 and 4/3 give a left endpoint slope of 14/3 and weighted interior tangent 24/11.
        const expectedHalf = 0.5 + 0.125 * 0.25 * (14 / 3 - 24 / 11);
        expect(evaluateCurve(rise, 0.125, 'smooth')).toBeCloseTo(expectedHalf, 12);
        const e = 1e-6;
        const left = (1 - evaluateCurve(rise, 0.25 - e, 'smooth')) / e;
        const right = (evaluateCurve(rise, 0.25 + e, 'smooth') - 1) / e;
        expect(left).toBeCloseTo(24 / 11, 4);
        expect(right).toBeCloseTo(24 / 11, 4);
        expect(evaluateCurve([[0.1, 2], [0.7, 5]], 0.4, 'smooth')).toBeCloseTo(3.5, 12);
    });

    it('stays within adjacent values at extrema, narrow peaks, and plateaus', () => {
        const pulse: Curve['points'] = [[0, 0], [0.12, 4], [0.121, 0.25], [0.7, 0.25], [1, 3]];
        for (let i = 0; i < pulse.length - 1; i++) {
            const [start, a] = pulse[i], [end, b] = pulse[i + 1];
            for (let j = 0; j <= 50; j++) {
                const value = evaluateCurve(pulse, start + (end - start) * j / 50, 'smooth');
                expect(value).toBeGreaterThanOrEqual(Math.min(a, b) - 1e-10);
                expect(value).toBeLessThanOrEqual(Math.max(a, b) + 1e-10);
            }
        }
        expect(evaluateCurve(pulse, -1, 'smooth')).toBe(0);
        expect(evaluateCurve(pulse, 2, 'smooth')).toBe(3);
    });

    it('bakes each mode with the same polynomial used for sampling and integration', () => {
        const keys: Curve['points'] = [[0, 0], [0.3, 3], [0.3, 8], [0.9, 2], [1, 2]];
        for (const mode of PARTICLE_CURVE_INTERPOLATIONS) {
            const lut = bakeCurve({ points: keys, interpolation: mode });
            for (let i = 0; i < BAKE_SAMPLES; i++) {
                expect(lut[i]).toBe(Math.fround(evaluateCurve(keys, i / (BAKE_SAMPLES - 1), mode)));
            }
            for (let i = 0; i < keys.length - 1; i++) {
                if (keys[i][0] === keys[i + 1][0]) continue;
                const [a, b, c, d] = particleCurveSegment(keys, i, mode);
                for (const u of [0.125, 0.5, 0.9]) {
                    const t = keys[i][0] + u * (keys[i + 1][0] - keys[i][0]);
                    expect(a + u * (b + u * (c + u * d))).toBeCloseTo(evaluateCurve(keys, t, mode), 12);
                }
            }
        }
        expect(evaluateCurve(keys, 0.3)).toBe(3);
        expect(evaluateCurve(keys, 0.3, 'step')).toBe(8);
        expect(evaluateCurve(keys, 0.3, 'smooth')).toBe(8);
    });

    it('preserves saved mode and tuple keys, defaulting old and unknown modes to linear', () => {
        const authored = { sizeOverLife: { interpolation: 'smooth', points: rise }, speedOverLife: { interpolation: 'step', points: rise } };
        const effect = resolveParticleEffect({ effect: JSON.parse(JSON.stringify(authored)) });
        expect(effect.sizeOverLife).toEqual(authored.sizeOverLife);
        expect(effect.speedOverLife).toEqual(authored.speedOverLife);
        for (const interpolation of [undefined, 'future']) {
            expect(sanitizeParticleEffect({ sizeOverLife: { points: rise, interpolation } }, effect).sizeOverLife).toEqual({ points: rise });
        }
        expect(sanitizeParticleEffect({}, effect).sizeOverLife).toEqual(authored.sizeOverLife);
    });

    it('handles malformed, empty, unordered, duplicate and single-key curves without mutating input', () => {
        const unordered: Curve['points'] = [[1, 1], [NaN, 4], [0, 0], [0.5, Infinity]];
        for (const mode of PARTICLE_CURVE_INTERPOLATIONS) {
            expect(evaluateCurve([], NaN, mode)).toBe(1);
            expect(evaluateCurve([[0.4, 3]], 100, mode)).toBe(3);
            expect(evaluateCurve(unordered, NaN, mode)).toBe(0);
            expect(evaluateCurve(unordered, 0.5, mode)).toBe(mode === 'step' ? 0 : 0.5);
            const tiny: Curve['points'] = [[0, 0], [1e-320, 2], [0.5, 1]];
            expect(Number.isFinite(evaluateCurve(tiny, 2e-321, mode))).toBe(true);
            const malformed = sanitizeParticleEffect({ sizeOverLife: { interpolation: mode, points: [null, {}, [0]] } });
            expect([...bakeCurve(malformed.sizeOverLife)].every(value => value === 1)).toBe(true);
        }
        expect(unordered[0]).toEqual([1, 1]);
    });
});
