import { describe, expect, it } from 'vitest';
import { GarmentAvatarContact, type GarmentAvatarSurface } from '../../runtime/garments/avatarContact';
import type { CookedGarment } from '../../runtime/garments/pattern';
import { GarmentSimulation, GARMENT_STEP } from '../../runtime/garments/solver';

const zPlane = (z: number, x = 0) => new Float32Array([-1 + x, -1, z, 1 + x, -1, z, 0 + x, 1, z]);
const indices = new Uint16Array([0, 1, 2]);
function proxy(a: Float32Array, b: Float32Array): GarmentAvatarSurface { return { previousPositions: a, positions: b, indices }; }
function coupon(): CookedGarment {
    const uv = new Float32Array([0, 0, .05, 0, 0, .05]);
    return {
positions: new Float32Array([0, 0, 0, .05, 0, 0, 0, .05, 0]), restUV: uv, materialUV: uv,
        indices: new Uint32Array([0, 1, 2]), pins: [0], seams: [], hinges: [], panelRanges: []
};
}
const noLoads = { gravity: 0, wind: 0, warp: 0, weft: 0, shear: 0, bend: 0 };
const noFriction = () => { };
describe('live cloth contact against an animated oriented triangle proxy', () => {
    it('carries free cloth vertices to the swept outward side and leaves prescribed pins fixed', () => {
        const sim = new GarmentSimulation(coupon(), noLoads);
        sim.step(GARMENT_STEP, undefined, null, [], null, undefined, proxy(zPlane(-.25), zPlane(.25)));
        expect(Array.from(sim.positions.slice(0, 3))).toEqual([0, 0, 0]);
        expect(sim.positions[5]).toBeCloseTo(.252, 6);
        expect(sim.positions[8]).toBeCloseTo(.252, 6);
        expect(sim.avatarContactStats?.corrections).toBeGreaterThan(0);
        expect(sim.avatarContactStats?.limited).toBe(false);
    });

    it('retains the very first swept endpoint when several render calls precede the first fixed tick', () => {
        const full = new GarmentSimulation(coupon(), noLoads), split = new GarmentSimulation(coupon(), noLoads);
        const start = zPlane(-.2), halfway = zPlane(.1), end = zPlane(.4);
        full.step(GARMENT_STEP, undefined, null, [], null, undefined, proxy(start, end));
        expect(split.step(GARMENT_STEP / 2, undefined, null, [], null, undefined, proxy(start, halfway))).toBe(0);
        // The direct API allows callers to reuse their frame buffers.
        start.fill(7);
        split.step(GARMENT_STEP / 2, undefined, null, [], null, undefined, proxy(halfway, end));
        expect(split.positions[5]).toBeCloseTo(.402, 6);
        expect(split.positions).toEqual(full.positions);
    });

    it('rejects an invalid proxy atomically and resumes at the next valid tick', () => {
        const motion = { ...noLoads, gravity:9.81 };
        const sim = new GarmentSimulation(coupon(), motion), expected = new GarmentSimulation(coupon(), motion);
        const a = zPlane(-1), bad = a.slice();
        bad[8] = NaN;
        const initial = sim.positions.slice();
        expect(sim.step(GARMENT_STEP * 3, undefined, null, [], null, undefined, proxy(a, bad))).toBe(0);
        expect(sim.positions).toEqual(initial);
        expect(sim.time).toBe(0);
        expect(sim.avatarContactStats?.invalid).toBe(true);
        sim.step(GARMENT_STEP, undefined, null, [], null, undefined, proxy(a, a));
        expected.step(GARMENT_STEP, undefined, null, [], null, undefined, proxy(a, a));
        expect(sim.positions).toEqual(expected.positions);
    });

    it('solves a deforming face with different vertex displacements and matches a fixed-tick partition', () => {
        const source = zPlane(-.2), target = zPlane(.3);
        target[2] = .21; target[5] = .45; target[8] = .17;
        const half = source.map((x, i) => (x + target[i]) / 2);
        const a = new GarmentSimulation(coupon(), noLoads), b = new GarmentSimulation(coupon(), noLoads);
        a.step(2 * GARMENT_STEP, undefined, null, [], null, undefined, proxy(source, target));
        b.step(GARMENT_STEP, undefined, null, [], null, undefined, proxy(source, half));
        b.step(GARMENT_STEP, undefined, null, [], null, undefined, proxy(half, target));
        expect(a.positions).toEqual(b.positions);
        expect(b.positions[5]).toBeGreaterThan(.2);
    });

    it('resolves a grazing endpoint near a finite edge, ignores distant backside approaches and degenerate triangles', () => {
        const face = zPlane(0), query = new GarmentAvatarContact(new Float64Array([1]));
        const start = new Float32Array([0, -1.0005, .0005]);
        let p = start.slice();
        query.prepare(proxy(face, face)); query.solve(start, p, .002, noFriction);
        expect(Math.hypot(p[1] + 1, p[2])).toBeCloseTo(.002, 6);
        query.prepare(proxy(zPlane(.3), zPlane(-.3)));
        p = new Float32Array([0, 0, 0]);
        query.solve(p.slice(), p, .002, noFriction);
        expect(Array.from(p)).toEqual([0, 0, 0]); // crossed out of the surface
        const zero = new Float32Array(9);
        query.prepare(proxy(zero, zero));
        query.solve(p.slice(), p, .002, noFriction);
        expect(query.stats.corrections).toBe(0);
    });

    it('does not push from the infinite plane when a point crosses beyond a tilted face boundary', () => {
        // Both swept boxes overlap. Projected into the triangle's plane, the vertex is outside.
        const a = new Float32Array([0, 0, -.2, 1, 0, -.2, 0, 1, -.2]);
        const b = new Float32Array([0, 0, .1, 1, 0, .3, 0, 1, .4]);
        const p = new Float32Array([.8, .8, 0]), start = p.slice();
        const tracker = new GarmentAvatarContact(new Float64Array([1]));
        tracker.prepare(proxy(a, b)); tracker.solve(start, p, .002, noFriction);
        expect(p).toEqual(start);
        expect(tracker.stats.testedFeatures).toBeGreaterThan(0);
        expect(tracker.stats.corrections).toBe(0);
    });

    it('reports BVH capacity, rejects invalid geometry, and rebuilds for a replaced index buffer', () => {
        const q = new GarmentAvatarContact(new Float64Array([1]), 0);
        const p = new Float32Array([0, 0, 0]), a = zPlane(-.2), b = zPlane(.2);
        q.prepare(proxy(a, b)); q.solve(p.slice(), p, .002, noFriction);
        expect(q.stats.limited).toBe(true);
        expect(q.stats.testedFeatures).toBe(0);
        const broken = { ...proxy(a, b), indices: new Uint32Array([0, 1, 99]) };
        expect(q.prepare(broken)).toBe(false);
        expect(q.stats.invalid).toBe(true);
        expect(q.prepare({ ...proxy(a, b), indices: new Uint16Array([2, 1, 0]) })).toBe(true);
        expect(q.stats.invalid).toBe(false);
    });

    it('computes friction from the animated contact anchor and preserves the original no-avatar path', () => {
        const face = zPlane(0), moving = zPlane(.003, .01);
        const q = new GarmentAvatarContact(new Float64Array([1]));
        const p = new Float32Array([0, 0, .002]);
        let shift = NaN;
        q.prepare(proxy(face, moving));
        q.solve(p.slice(), p, .002, (_i, _nx, _ny, _nz, _depth, bx) => { shift = bx; });
        expect(shift).toBeCloseTo(.01, 6);
        const a = new GarmentSimulation(coupon()), b = new GarmentSimulation(coupon());
        for (let i = 0; i < 20; i++) {
            a.step(GARMENT_STEP);
            b.step(GARMENT_STEP, undefined, null, [], null, undefined, null);
        }
        expect(a.positions).toEqual(b.positions);
        expect(a.avatarContactStats).toBeNull();
    });
});
