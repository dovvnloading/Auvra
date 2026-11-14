import { describe, expect, it } from 'vitest';
import { createParticleForceField, MAX_PARTICLE_FORCE_FIELDS, resolveParticleEffect, sanitizeParticleEffect, type ParticleForceField } from '../../runtime/particleEffect';
import { PARTICLE_FORCE_FIELD_FLOATS, prepareParticleForceFields } from '../../runtime/particleForceFields';
import { ParticleSimulation } from '../../runtime/particleSimulation';

const field = (kind: ParticleForceField['kind'], overrides: Partial<ParticleForceField> = {}): ParticleForceField =>
    ({ ...createParticleForceField(kind), ...overrides });

// Scale by (2, 3, 4), rotate +90° about Z, then translate to (10, 20, 30).
const transform = [0, 2, 0, 0, -3, 0, 0, 0, 0, 0, 4, 0, 10, 20, 30, 1];

const effectWith = (forceFields: ParticleForceField[], space: 'local' | 'world' = 'world') => sanitizeParticleEffect({
    forceFields, space, shape: { kind: 'point' }, rate: 0, speed: [0, 0], lifetime: [10, 10],
    gravity: 0, wind: [0, 0, 0], drag: 0, turbulence: 0,
});

const velocity = (fields: ParticleForceField[], position: [number, number, number], space: 'local' | 'world' = 'world', matrix: number[] | null = null) => {
    const simulation = new ParticleSimulation(effectWith(fields, space), 1);
    simulation.emitAt(1, 0, 0, 0);
    simulation.positions.set(position);
    simulation.step(0.1, matrix);
    return [...simulation.velocities];
};

describe('authorable particle force fields', () => {
    it('keeps older effects field-free, preserves authored stacks, and bounds malformed data', () => {
        expect(resolveParticleEffect({ preset: 'fire' }).forceFields).toEqual([]);
        const authored = [field('directional', { enabled: false }), field('radial', { strength: -6 }), field('vortex')];
        expect(resolveParticleEffect(JSON.parse(JSON.stringify({ effect: { forceFields: authored } }))).forceFields).toEqual(authored);
        const damaged = { kind: 'vortex', center: [Infinity, -20000, 3], axis: [2, 0, -2], strength: NaN, radius: -5, falloff: 80 };
        const repaired = sanitizeParticleEffect({ forceFields: [null, { kind: 'future' }, damaged, {}, ...authored] });
        expect(repaired.forceFields).toEqual([field('vortex', { center: [0, -10000, 3], axis: [1, 0, -1], radius: 0, falloff: 8 })]);
        expect(sanitizeParticleEffect({ forceFields: [...authored, ...authored] }).forceFields).toHaveLength(MAX_PARTICLE_FORCE_FIELDS);
    });

    it('packs only active fields, transforms points and directions, and preserves the simulation radius', () => {
        const fields = [
            field('radial', { enabled: false }), field('radial', { strength: 0 }), field('vortex', { radius: 0 }),
            field('directional', { center: [1, 2, 3], axis: [0, 0, 0], strength: -8, radius: 7, falloff: 2 }),
        ];
        const packed = new Float32Array(MAX_PARTICLE_FORCE_FIELDS * PARTICLE_FORCE_FIELD_FLOATS);
        expect(prepareParticleForceFields(fields, transform, packed)).toBe(1);
        expect(Array.from(packed.subarray(0, 12))).toEqual([4, 22, 42, 7, -1, 0, 0, -8, 2, 2, 0, 0]);
        expect(prepareParticleForceFields(fields, null, packed)).toBe(1);
        expect(Array.from(packed.subarray(0, 12))).toEqual([1, 2, 3, 7, 0, 1, 0, -8, 2, 2, 0, 0]);
    });

    it('attracts or repels with signed strength and radial falloff, only inside the sphere', () => {
        const inward = field('radial', { radius: 4, falloff: 2, strength: 40 });
        expect(velocity([inward], [2, 0, 0])).toEqual([-1, 0, 0]);
        expect(velocity([{ ...inward, strength: -40 }], [2, 0, 0])).toEqual([1, 0, 0]);
        for (const x of [0, 4, 5]) expect(velocity([{ ...inward, falloff: 0 }], [x, 0, 0])).toEqual([0, 0, 0]);
    });

    it('adds signed tangential and directional acceleration, with zero swirl on the axis', () => {
        const swirl = field('vortex', { radius: 5, falloff: 0 });
        const wind = field('directional', { strength: 20, falloff: 0 });
        expect(velocity([swirl, wind], [1, 1, 0])).toEqual([0, 2, -1]);
        expect(velocity([{ ...swirl, strength: -10 }], [1, 1, 0])).toEqual([0, 0, 1]);
        expect(velocity([swirl], [0, 1, 0])).toEqual([0, 0, 0]);
        expect(velocity([swirl, wind], [0, 0, 0])).toEqual([0, 2, 0]);
    });

    it('evaluates fields in the particle space and follows a moving world emitter without carrying particles', () => {
        const jet = field('directional', { center: [0, 1, 0], radius: 1, falloff: 0 });
        expect(velocity([jet], [0, 1, 0], 'local', transform)).toEqual([0, 1, 0]);
        expect(velocity([jet], [7, 20, 30], 'world', transform)).toEqual([-1, 0, 0]);
        expect(velocity([jet], [7, 21.5, 30], 'world', transform)).toEqual([0, 0, 0]);
        const simulation = new ParticleSimulation(effectWith([jet]), 1);
        simulation.emitAt(1, 0, 1, 0);
        simulation.step(0.1, null);
        simulation.step(0.1, transform);
        expect([...simulation.velocities]).toEqual([0, 1, 0]);
        simulation.setEffect(effectWith([]));
        simulation.step(0.1, null);
        expect([...simulation.velocities]).toEqual([0, 1, 0]);
    });
});
