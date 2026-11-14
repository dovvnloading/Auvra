import { describe, expect, it } from 'vitest';
import { createParticleForceField, sanitizeParticleEffect, type ParticleForceField, type Vec3 } from '../../runtime/particleEffect';
import { applyParticleForceFields, PARTICLE_FORCE_FIELD_FLOATS, prepareParticleForceFields } from '../../runtime/particleForceFields';
import { ParticleSimulation } from '../../runtime/particleSimulation';

const curl = (extra: Partial<ParticleForceField> = {}) => ({
    ...createParticleForceField('curl'), strength: 35, radius: 3, ...extra,
});

function packed(field: ParticleForceField, time = 0, matrix: number[] | null = null) {
    const data = new Float32Array(PARTICLE_FORCE_FIELD_FLOATS);
    expect(prepareParticleForceFields([field], matrix, data, time)).toBe(1);
    return data;
}

function force(data: Float32Array, position: Vec3): number[] {
    const v = new Float32Array(3);
    applyParticleForceFields(data, 1, 1, 1, new Float32Array(position), v, new Float32Array(1), new Float32Array([5]));
    return [...v];
}

describe('spherical curl-noise field', () => {
    it('defaults and bounds the persisted curl properties without adding them to older kinds', () => {
        const defaults = createParticleForceField('curl');
        expect(defaults).toMatchObject({ scale: 2, seed: 0, evolution: 0.6 });
        const read = (field: unknown) => sanitizeParticleEffect({ forceFields: [field] }).forceFields[0];
        expect(read({ kind: 'curl' })).toEqual(defaults);
        expect(read({ ...defaults, scale: -2, evolution: 99, seed: 999999 })).toMatchObject({ scale: 0.05, evolution: 10, seed: 65535 });
        expect(read({ ...defaults, seed: 2.8 }).seed).toBe(3);
        const radial = createParticleForceField('radial');
        expect(read({ ...radial, scale: 2, evolution: 0.2, seed: 15 })).toEqual(radial);
        const authored = curl({ evolution: -3, scale: 5, seed: 42 });
        expect(read(JSON.parse(JSON.stringify(authored)))).toEqual(authored);
    });

    it('is repeatable, seedable, spatially scalable, signed, and bounded by strength', () => {
        const sample: Vec3 = [0.4, 0.6, -0.7];
        const f = curl({ seed: 73 });
        const ref = force(packed(f, 2), sample);
        expect(force(packed(f, 2), sample)).toEqual(ref);
        expect(force(packed({ ...f, seed: 74 }, 2), sample)).not.toEqual(ref);
        expect(force(packed({ ...f, scale: 1 }, 2), sample)).not.toEqual(ref);
        expect(force(packed(f, 3), sample)).not.toEqual(ref);
        expect(force(packed({ ...f, evolution: 0 }, 90), sample)).toEqual(force(packed(f, 0), sample));
        expect(force(packed({ ...f, strength: -f.strength }, 2), sample)).toEqual(ref.map(a => -a));
        for (const falloff of [0, 0.5, 1, 8]) {
            const data = packed({ ...f, falloff });
            for (let i = 0; i < 30; i++) {
                const p: Vec3 = [2.1 * Math.sin(i), 1.7 * Math.cos(2 * i), 0.8 * Math.sin(0.9 * i)];
                expect(Math.hypot(...force(data, p))).toBeLessThanOrEqual(f.strength);
            }
            expect(force(data, [3, 0, 0])).toEqual([0, 0, 0]);
            expect(force(data, [5, 3, 1])).toEqual([0, 0, 0]);
            expect(Math.hypot(...force(data, [2.999999, 0, 0]))).toBeLessThan(0.0001);
        }
    });

    it('has negligible numerical divergence through the falloff, including near the boundary', () => {
        const h = 0.002;
        for (const falloff of [0, 0.5, 2]) {
            const data = packed(curl({ seed: 392, scale: 0.8, falloff }), 7.75);
            for (const p of [[0.2, 0.7, 0.3], [-0.5, 1.2, -1.3], [2.4, -0.5, 0.3], [2.97, 0.16, 0.02]] as Vec3[]) {
                let divergence = 0;
                for (let axis = 0; axis < 3; axis++) {
                    const left: Vec3 = [...p], right: Vec3 = [...p];
                    left[axis] -= h;
                    right[axis] += h;
                    divergence += (force(data, right)[axis] - force(data, left)[axis]) / (2 * h);
                }
                expect(Math.abs(divergence)).toBeLessThan(0.001);
            }
        }
    });

    it('translates the sampling domain with the emitter without scaling its world-space radius', () => {
        const f = curl({ center: [0, 1, 0] });
        const transform = [0, 2, 0, 0, -3, 0, 0, 0, 0, 0, 4, 0, 10, 20, 30, 1];
        const local = packed(f), world = packed(f, 0, transform);
        expect([...world.subarray(0, 4)]).toEqual([7, 20, 30, 3]);
        expect(force(local, [0.5, 1.25, -0.75])).toEqual(force(world, [7.5, 20.25, 29.25]));
    });

    it('continues evolving after emission stops, consumes simulation time only, and resets on restart', () => {
        const field = curl({ evolution: 9 });
        const effect = sanitizeParticleEffect({
            rate: 0, speed: [0, 0], lifetime: [8, 8], drag: 0, wind: [0, 0, 0],
            gravity: 0, orbit: 0, turbulence: 0, shape: { kind: 'point' }, forceFields: [field],
        });
        const sim = new ParticleSimulation(effect, 1);
        const point: Vec3 = [0.25, 0.25, -0.75];
        const stepAt = (time: number) => {
            sim.positions.set(point);
            sim.velocities.fill(0);
            sim.step(0.1, null);
            const expected = force(packed(field, time), point);
            for (let i = 0; i < 3; i++) expect(sim.velocities[i]).toBeCloseTo(expected[i] * 0.1, 6);
        };
        sim.stop();
        sim.emitAt(1, ...point);
        stepAt(0);
        sim.step(0, null);
        stepAt(0.1);
        sim.play();
        stepAt(0.2);
        sim.restart();
        sim.emitAt(1, ...point);
        stepAt(0);
    });
});
