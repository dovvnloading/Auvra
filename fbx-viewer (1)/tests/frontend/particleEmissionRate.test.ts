import { describe, expect, it } from 'vitest';
import { compileParticleRateCurve, particleEmissionBetween } from '../../runtime/particleEmissionRate';
import { estimateParticles, sanitizeParticleEffect, type Curve } from '../../runtime/particleEffect';
import { ParticleSimulation } from '../../runtime/particleSimulation';

describe('rate over the emission cycle', () => {
    it('keeps the unit-rate fast path for old effects and supports a single constant key', () => {
        expect(compileParticleRateCurve()).toBeNull();
        expect(compileParticleRateCurve(sanitizeParticleEffect({}).rateOverCycle)).toBeNull();
        expect(particleEmissionBetween(null, 0.25, 0.75, 3, 10)).toBe(5);
        for (const multiplier of [0, 2, 10]) {
            const table = compileParticleRateCurve({ points: [[0.35, multiplier]] });
            expect(particleEmissionBetween(table, 0, 1.5, 2, 8)).toBeCloseTo(12 * multiplier, 12);
        }
    });

    it('integrates a linear ramp in seconds and holds its unkeyed tails', () => {
        const ramp = compileParticleRateCurve({ points: [[0, 0], [1, 2]] });
        expect(particleEmissionBetween(ramp, 0, 1, 2, 100)).toBe(50);
        expect(particleEmissionBetween(ramp, 1, 2, 2, 100)).toBe(150);
        const clipped = compileParticleRateCurve({ points: [[0.25, 2], [0.75, 4]] });
        expect(particleEmissionBetween(clipped, 0, 1, 1, 10)).toBe(30);
    });

    it('integrates a smooth arch across arbitrary frame partitions', () => {
        const table = compileParticleRateCurve({ points: [[0, 0], [0.5, 2], [1, 0]], interpolation: 'smooth' });
        // The interpolating arch is 8t(1−t) on [0,1]. Its integral over one second is 4/3.
        const integral = (t: number) => 4 * t ** 2 - (8 / 3) * t ** 3;
        const times = [0, 0.004, 0.19, 0.4999, 0.53, 0.98, 1];
        for (let i = 1; i < times.length; i++) {
            const start = times[i - 1], end = times[i];
            expect(particleEmissionBetween(table, start, end, 1, 30)).toBeCloseTo(30 * (integral(end) - integral(start)), 11);
        }
        expect(particleEmissionBetween(table, 0, 1, 1, 30)).toBeCloseTo(40, 11);
    });

    it('uses the authored duplicate-key convention before the first key', () => {
        const points: Curve['points'] = [[0.25, 2], [0.25, 4], [0.75, 4]];
        for (const interpolation of ['linear', 'step', 'smooth'] as const) {
            const table = compileParticleRateCurve({ points, interpolation });
            expect(particleEmissionBetween(table, 0, 1, 1, 1)).toBeCloseTo(interpolation === 'linear' ? 3.5 : 4, 12);
        }
    });

    it('catches an eight-millisecond pulse between frames on the CPU, including across a loop and delay', () => {
        const rateOverCycle: Curve = { interpolation: 'step', points: [[0, 0], [0.431, 4], [0.439, 0]] };
        const effect = sanitizeParticleEffect({ rate: 625, duration: 1, rateOverCycle, delay: 0.1, lifetime: [5, 5] });
        for (const fps of [10, 60, 120]) {
            const simulation = new ParticleSimulation(effect, 100, () => 0.5);
            for (let i = 0; i < 2 * fps; i++) simulation.step(1 / fps, null);
            expect(simulation.count).toBe(40);
        }
        expect(estimateParticles(effect)).toBe(625 * 4 * 5);
    });

    it('keeps trying younger births when some within a long frame already expired', () => {
        const effect = sanitizeParticleEffect({ rate: 2000, duration: 1, lifetime: [0.05, 0.05], rateOverCycle: { points: [[0, 2]] } });
        const simulation = new ParticleSimulation(effect, 10, () => 0.5);
        simulation.step(0.1, null);
        expect(simulation.count).toBe(10);
    });
});
