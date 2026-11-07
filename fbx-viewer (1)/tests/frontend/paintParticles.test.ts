import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildPartMesh } from '../../texturing/mesh/partMesh';
import { SurfacePicker, closestOnTriangle } from '../../texturing/mesh/picker';
import { BUILT_IN_BRUSHES, applyPreset, presetFrom, readPresets } from '../../texturing/paint/brushLibrary';
import { DEFAULT_BRUSH } from '../../texturing/paint/strokes';
import { ParticleRun, PARTICLE_PRESETS, readParticles, throwParticles, type ParticleSettings } from '../../texturing/paint/particles';

/** A wall (facing +Z, 2 × 2) above a floor (facing up, 4 × 4, at y = -1). */
const scene = () => {
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2, 8, 8), material));
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(4, 4, 8, 8), material);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -1, 1.9);
    root.add(floor);
    root.updateMatrixWorld(true);
    return new SurfacePicker(buildPartMesh(root, new Set([material]), { udim: false }));
};
const preset = (id: string): ParticleSettings => PARTICLE_PRESETS.find((each) => each.id === id)!.settings;
const from = (point: THREE.Vector3, normal: THREE.Vector3) => ({ point, normal, worldRadius: 0.1, flow: 1 });

describe('particle brushes', () => {
    it('find the nearest point of a triangle and of the surface', () => {
        expect(closestOnTriangle(0.2, 0.2, 5, 0, 0, 0, 1, 0, 0, 0, 1, 0)).toMatchObject({ x: expect.closeTo(0.2, 9), y: expect.closeTo(0.2, 9), z: 0 });
        expect(closestOnTriangle(2, 2, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0)).toMatchObject({ x: 0.5, y: 0.5, w: [0, 0.5, 0.5] });
        const near = scene().nearest(new THREE.Vector3(0.3, 0.2, 0.05), 0.2)!;
        expect(near.point.z).toBeCloseTo(0);
        expect(near.normal.z).toBeCloseTo(1);
        expect(scene().nearest(new THREE.Vector3(0, 0, 3), 0.5)).toBeNull();
    });

    it('drip down a wall, on its surface, leaving a trail', () => {
        const dabs = throwParticles(from(new THREE.Vector3(0, 0.5, 0), new THREE.Vector3(0, 0, 1)), preset('drips'), scene(), 2, 7);
        expect(dabs.length).toBeGreaterThan(10);
        expect(dabs.every((dab) => Math.abs(dab.point.z) < 1e-4)).toBe(true);
        // They run down: the trail reaches well below where they started.
        expect(Math.min(...dabs.map((dab) => dab.point.y))).toBeLessThan(0.1);
        // Smaller as they go.
        expect(dabs[dabs.length - 1].worldRadius).toBeLessThan(dabs[0].worldRadius);
    });

    it('fall as dust onto what lies below, and bounce as splashes', () => {
        const picker = scene();
        // Thrown off the floor upward, they come back down onto it.
        const dust = throwParticles(from(new THREE.Vector3(0, -1, 1.5), new THREE.Vector3(0, 1, 0)), preset('dust'), picker, 2, 3);
        expect(dust.length).toBeGreaterThan(5);
        expect(dust.every((dab) => Math.abs(dab.point.y + 1) < 1e-3 || Math.abs(dab.point.z) < 1e-3)).toBe(true);
        expect(dust.length).toBeLessThanOrEqual(preset('dust').count);
        const splashes = throwParticles(from(new THREE.Vector3(0, -1, 1.5), new THREE.Vector3(0, 1, 0)), preset('splashes'), picker, 2, 3);
        // Several marks for each particle that bounces.
        expect(splashes.length).toBeGreaterThan(preset('splashes').count);
    });

    it('are the same for the same seed, and read back safely', () => {
        const a = throwParticles(from(new THREE.Vector3(0, 0.5, 0), new THREE.Vector3(0, 0, 1)), preset('leaks'), scene(), 2, 11);
        const b = throwParticles(from(new THREE.Vector3(0, 0.5, 0), new THREE.Vector3(0, 0, 1)), preset('leaks'), scene(), 2, 11);
        expect(a.map((dab) => dab.point.toArray())).toEqual(b.map((dab) => dab.point.toArray()));
        expect(readParticles({ enabled: true, motion: 'swirl', count: 900, life: -1 })).toMatchObject({ enabled: true, motion: 'flow', count: 40, life: 0.05 });
    });

    it('come with brush presets, and a plain preset turns them off', () => {
        const drips = applyPreset(DEFAULT_BRUSH, BUILT_IN_BRUSHES.find((each) => each.id === 'builtin:drips')!);
        expect(drips.particles).toMatchObject({ enabled: true, motion: 'flow' });
        const soft = applyPreset(drips, BUILT_IN_BRUSHES.find((each) => each.id === 'builtin:soft')!);
        expect(soft.particles?.enabled).toBe(false);
        // Saved and read back with the rest of the brush.
        const back = readPresets(JSON.parse(JSON.stringify([presetFrom(drips, 'Mine')])))[0];
        expect(back.settings.particles).toEqual(drips.particles);
    });

    it('fall along the way gravity is set to pull', () => {
        // On the floor, pulled along +X: the drips run that way over it.
        const dabs = throwParticles(from(new THREE.Vector3(0, -1, 1.5), new THREE.Vector3(0, 1, 0)), { ...preset('drips'), gravityDirection: [1, 0, 0] }, scene(), 2, 5);
        expect(dabs.length).toBeGreaterThan(10);
        expect(Math.max(...dabs.map((dab) => dab.point.x))).toBeGreaterThan(0.3);
        expect(dabs.every((dab) => Math.abs(dab.point.y + 1) < 1e-3)).toBe(true);
        expect(readParticles({ gravityDirection: [0, 0, 2] }).gravityDirection).toEqual([0, 0, 2]);
        expect(readParticles({ gravityDirection: [0, 0, 0] }).gravityDirection).toBeUndefined();
    });

    it('run over time as the stroke is drawn, painting along their paths a moment at a time', () => {
        const run = new ParticleRun(preset('drips'), scene(), 2, 9);
        run.spawn(from(new THREE.Vector3(0, 0.5, 0), new THREE.Vector3(0, 0, 1)));
        expect(run.alive).toBe(preset('drips').count);
        // A tenth of a second in: the drips have only just set off.
        const early = run.advance(0.1);
        expect(early.length).toBeGreaterThan(0);
        const lowest = (dabs: readonly { point: THREE.Vector3 }[]) => Math.min(...dabs.map((dab) => dab.point.y));
        // Another second: further down the wall.
        const later = run.advance(1);
        expect(lowest(later)).toBeLessThan(lowest(early));
        // Thrown again mid-way, new particles join those on their way; finishing runs them all out.
        run.spawn(from(new THREE.Vector3(0.4, 0.5, 0), new THREE.Vector3(0, 0, 1)));
        const rest = run.finish();
        expect(rest.length).toBeGreaterThan(0);
        expect(run.alive).toBe(0);
        expect(run.advance(1)).toEqual([]);
    });
});
