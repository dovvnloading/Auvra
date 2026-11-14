import { describe, expect, it } from 'vitest';
import { GarmentAvatarContact } from '../../runtime/garments/avatarContact';

const ids = new Uint32Array([0, 1, 2]);
const buffer = (xyz: number[][]) => new Float32Array(xyz.flat());
const face = (z: number) => buffer([[-.2, -.2, z], [.2, -.2, z], [0, .2, z]]);
const tiny = (z: number) => buffer([[-.015, 0, z], [.015, 0, z], [0, .02, z]]);
const copy = (a: Float32Array) => a.slice();
const ignore = () => { };
const region = (a: Float32Array, b: Float32Array) => ({ indices: ids, previousPositions: a, positions: b });
const whole = (mass: Float64Array) => new GarmentAvatarContact(mass, undefined, undefined, ids);

describe('swept avatar feature contact for coarse cloth', () => {
    it('catches a small proxy vertex crossing an interior while the three cloth vertices miss', () => {
        const a = face(0), x = copy(a), body0 = tiny(-.1), body1 = tiny(.1);
        const s = whole(new Float64Array([0, 1, 1]));
        s.prepare(region(body0, body1));
        s.solve(a, x, .002, ignore);
        expect(s.stats.corrections).toBe(0);
        expect(s.stats.bodyVertexCorrections).toBeGreaterThan(0);
        expect(x.slice(0, 3)).toEqual(a.slice(0, 3));
        expect(x[5] + x[8]).toBeGreaterThan(.15);
        expect(s.stats.limited).toBe(false);
    });

    it('separates crossing interior edges with all endpoint projections outside the opposite triangle', () => {
        const cloth = buffer([[-1, 0, 0], [1, 0, 0], [0, -.1, 0]]);
        const body = (z: number) => buffer([[0, -1, z], [0, 1, z], [.1, 1, z]]);
        const x = copy(cloth), s = whole(new Float64Array([0, 1, 1]));
        s.prepare(region(body(-.11), body(.09)));
        s.solve(cloth, x, .002, ignore);
        expect(s.stats.corrections).toBe(0);
        expect(s.stats.edgeCorrections).toBeGreaterThan(0);
        expect(x[2]).toBe(0);
        expect((x[2] + x[5]) / 2).toBeGreaterThanOrEqual(.09199);
    });

    it('resolves the moving intersection of two shearing edges using their material weights', () => {
        const cloth = buffer([[-1, 0, 0], [1, 0, 0], [0, -.12, 0]]);
        const moved = copy(cloth);
        moved[1] = -.025;
        moved[4] = .035;
        const before = buffer([[.03, -1, -.15], [.03, 1, -.08], [.09, 1, -.07]]);
        const after = buffer([[.06, -1, .09], [-.04, 1, .13], [.02, 1, .14]]);
        const tracker = whole(new Float64Array([1, 1, 0]));
        tracker.prepare(region(before, after));
        tracker.solve(cloth, moved, .002, ignore);
        expect(tracker.stats.edgeCorrections).toBeGreaterThan(0);
        expect(tracker.stats.corrections).toBe(0);
        expect((moved[2] + moved[5]) / 2).toBeGreaterThan(.105);
        expect(moved.subarray(6)).toEqual(cloth.subarray(6));
    });

    it('detects a coplanar edge which enters and leaves an initially disjoint panel within one tick', () => {
        const cloth = buffer([[0, -.3, 0], [0, .3, 0], [-.01, .3, 0]]), p = copy(cloth), s = whole(new Float64Array([1, 1, 0]));
        const offset = (x: number) => buffer([[x - .1, 0, 0], [x + .1, 0, 0], [x + .1, .01, 0]]);
        s.prepare(region(offset(-.25), offset(.25)));
        s.solve(cloth, p, .001, ignore);
        expect(s.stats.edgeCorrections).toBeGreaterThan(0);
        expect(.5 * (p[0] + p[3])).toBeGreaterThan(.15);
        expect(p[6]).toBe(cloth[6]);
    });

    it('ignores zero-area animated proxy faces in every contact direction', () => {
        const a = face(0), p = copy(a), tracker = whole(new Float64Array([1, 1, 1]));
        // These three distinct indices collapse to one point for the whole sweep.
        const collapsed = (z: number) => buffer([[0, 0, z], [0, 0, z], [0, 0, z]]);
        tracker.prepare(region(collapsed(-.1), collapsed(.1)));
        tracker.solve(a, p, .002, ignore);
        expect(p).toEqual(a);
        expect(tracker.stats.bodyVertexCorrections + tracker.stats.edgeCorrections + tracker.stats.corrections).toBe(0);
    });

    it('uses finite segments and finite cloth faces when the infinite plane has a crossing', () => {
        const a = face(0), p = copy(a), s = whole(new Float64Array([1, 1, 1]));
        const outside = (z: number) => buffer([[.15, .15, z], [.21, .15, z], [.21, .21, z]]);
        s.prepare(region(outside(-.05), outside(.05)));
        s.solve(a, p, .002, ignore);
        expect(s.stats.testedBodyVertices).toBeGreaterThan(0);
        expect(s.stats.bodyVertexCorrections + s.stats.edgeCorrections + s.stats.corrections).toBe(0);
        expect(p).toEqual(a);
    });

    it('projects stationary overlapping shells by inverse mass and exposes the avatar anchor motion for friction', () => {
        const a = face(0), p = copy(a), s = whole(new Float64Array([1, 2, 0]));
        const src = tiny(-.0004), dst = copy(src);
        for (let i = 0; i < 3; i++)dst[3 * i] += .003;
        const motions: number[] = [];
        s.prepare(region(src, dst));
        s.solve(a, p, .002, (_j, _nx, _ny, _nz, _d, bx) => motions.push(bx));
        expect(s.stats.bodyVertexCorrections).toBeGreaterThan(0);
        expect(p[2]).toBeGreaterThan(0);
        expect(p[5]).toBeGreaterThan(p[2]);
        expect(p[8]).toBe(0);
        expect(motions.every(x => Math.abs(x - .003) < 1e-6)).toBe(true);
    });

    it('bounds pin leverage across both contact passes and reports a blocked shell', () => {
        const a = buffer([[-.1, 0, 0], [.1, 0, 0], [0, .2, 0]]), p = copy(a);
        const proxy = buffer([[-.04, .0004, -.001], [.04, .0004, -.001], [0, .0009, -.001]]);
        const tracker = whole(new Float64Array([0, 0, 1]));
        tracker.prepare(region(proxy, proxy));
        tracker.solve(a, p, .004, ignore);
        tracker.solve(a, p, .004, ignore);
        expect(p.slice(0, 6)).toEqual(a.slice(0, 6));
        const correction = Math.hypot(p[6]-a[6], p[7]-a[7], p[8]-a[8]);
        expect(correction).toBeGreaterThan(0);
        expect(correction).toBeLessThanOrEqual(.01601);
        expect(tracker.stats.pinLimitedFeatures).toBeGreaterThan(0);
    });

    it('reports independently bounded supplemental candidate and BVH work', () => {
        const a = face(0), body = tiny(-.001), mass = new Float64Array([1, 1, 1]);
        const featureLimited = new GarmentAvatarContact(mass, undefined, undefined, ids, 0);
        const nodeLimited = new GarmentAvatarContact(mass, undefined, undefined, ids, undefined, 0);
        for (const s of [featureLimited, nodeLimited]) {
            s.prepare(region(body, body)); s.solve(a, copy(a), .002, ignore);
            expect(s.stats.limited).toBe(true); expect(s.stats.vertexPhaseLimited).toBe(false);
        }
        expect(featureLimited.stats.featurePairsLimited).toBe(true);
        expect(nodeLimited.stats.featureNodesLimited).toBe(true);
    });
});
