import { describe, expect, it } from 'vitest';
import type { CookedGarment } from '../../runtime/garments/pattern';
import { createSleevelessTop, cookGarment } from '../../runtime/garments/pattern';
import { GARMENT_STEP as h, GarmentSimulation, type GarmentMaterial } from '../../runtime/garments/solver';

function coupon(): CookedGarment {
    const uv = new Float32Array([0, 0, .2, 0, 0, .2]);
    return {
        positions: new Float32Array([0, 0, 0, .2, 0, 0, 0, .2, 0]), restUV: uv, materialUV: uv,
        indices: new Uint32Array([0, 1, 2]), pins: [], seams: [], hinges: [], panelRanges: [],
    };
}
const passive: Partial<GarmentMaterial> = { gravity: 0, damping: 0, wind: 0, friction: 0 };
const unit = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translation = (x: number, y: number, z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

describe('garment fixed-step preview', () => {
    it('integrates area-weighted mass, preserves its rest pose, and follows the same fixed clock under partitioning', () => {
        const mesh = coupon();
        const still = new GarmentSimulation(mesh, { ...passive, arealDensity: .4 });
        expect(still.mass).toBeCloseTo(.2 * .2 * .4 / 2, 8);
        for (let i = 0; i < 90; i++) still.step(h);
        expect(still.positions).toEqual(mesh.positions);
        const a = new GarmentSimulation(mesh), b = new GarmentSimulation(mesh);
        for (let i = 0; i < 30; i++) a.step(h * 2);
        for (let i = 0; i < 120; i++) b.step(h / 2);
        expect(a.positions).toEqual(b.positions);
        expect(a.time).toBeCloseTo(.5);
        expect(a.positions[1]).toBeLessThan(-.9);
        a.reset(); expect(a.positions).toEqual(mesh.positions);
        expect(a.step(1)).toBe(8);
        expect(a.droppedTime).toBeCloseTo(1 - 8 * h);
    });

    it('changes the mechanical response when the physical grain turns', () => {
        const mesh = coupon();
        mesh.pins = [0, 2];
        const rotated = { ...mesh, materialUV: new Float32Array([0, 0, 0, -.2, .2, 0]) };
        const m = { ...passive, gravity: 9.81, warp: 1000, weft: 1, damping: 4 };
        const a = new GarmentSimulation(mesh, m), b = new GarmentSimulation(rotated, m);
        for (let i = 0; i < 120; i++) {
            a.step(h, unit, null, [], null, { x: 1, y: 0, z: 0 });
            b.step(h, unit, null, [], null, { x: 1, y: 0, z: 0 });
        }
        expect(b.positions[3] - a.positions[3]).toBeGreaterThan(.01);
        expect(Array.from(a.positions.slice(0, 3))).toEqual([0, 0, 0]);
        expect(a.positions[7]).toEqual(mesh.positions[7]);
    });

    it('carries hard pins along the animated matrix and responds to per-triangle wind', () => {
        const mesh = coupon(); mesh.pins = [0];
        const a = new GarmentSimulation(mesh, { ...passive, wind: 1 });
        a.reset();
        const wind = (_x: number, _y: number, _z: number, out: { x: number; y: number; z: number }) => Object.assign(out, { x: 0, y: 0, z: 5 });
        for (let i = 0; i < 30; i++) a.step(h, translation(.05 * i / 29, 0, 0), wind);
        expect(a.positions[0]).toBeCloseTo(.05, 7);
        expect(a.positions[2]).toBe(0);
        expect(a.positions[5]).toBeGreaterThan(.01);
    });

    it('bends a folded hinge toward its flat rest chart with a fixed support', () => {
        const uv = new Float32Array([0, 0, .2, 0, 0, .2, 0, -.2]);
        const mesh: CookedGarment = {            
...coupon(), positions: new Float32Array([0, 0, 0, .2, 0, 0, 0, .2, 0, 0, -.13, .15]),
            materialUV: uv, restUV: uv, indices: new Uint32Array([0, 1, 2, 1, 0, 3]), pins: [0, 1, 2], hinges: [{ a: 0, b: 1, c: 2, d: 3 }]        
};
        const a = new GarmentSimulation(mesh, { ...passive, warp: 0, weft: 0, shear: 0, bend: .05, damping: 4 });
        const b = new GarmentSimulation(mesh, { ...passive, warp: 0, weft: 0, shear: 0, bend: 0, damping: 4 });
        for (let i = 0; i < 30; i++) { a.step(h); b.step(h); }
        const fold = (p: Float32Array) => Math.abs(Math.atan2(p[11], -p[10]));
        expect(fold(a.positions)).toBeLessThan(.5 * fold(b.positions));
    });

    it('closes stitches in physical time, with a bounded gap after settling', () => {
        const mesh = coupon();
        mesh.pins = [0];
        mesh.seams = [{ seamId: 'dart', a: 0, b: 1, weight: .04 }];
        const a = new GarmentSimulation(mesh, { ...passive, warp: 0, weft: 0, shear: 0, bend: 0, sewTime: .25 });
        a.step(h);
        expect(a.positions[3]).toBeGreaterThan(.18);
        for (let i = 0; i < 119; i++) a.step(h);
        expect(Math.abs(a.positions[3])).toBeLessThan(1e-4);
    });

    it('catches a translating elliptical capsule passing fully through a stationary coupon between ticks', () => {
        const a = new GarmentSimulation(coupon(), { ...passive, warp: 0, weft: 0, shear: 0, thickness: 0 });
        const body = { id: 'torso', x: 0, y: -.3, z: -.5, height: .6, radius: .08, radiusX: .14 };
        a.step(h, unit, null, [body]); // first observation at the starting pose
        a.step(h, unit, null, [{ ...body, z: .5 }]);
        expect(a.positions[2]).toBeGreaterThanOrEqual(.57999);
        expect(a.positions[5]).toBeLessThan(.05); // vertex outside swept x extent only moves with its face
    });

    it('sweeps from the last simulated pose through frames that accumulated no fixed tick', () => {
        const a = new GarmentSimulation(coupon(), { ...passive, warp: 0, weft: 0, shear: 0, thickness: 0 });
        const body = { id: 'torso', x: 0, y: -.3, z: -.5, height: .6, radius: .08 };
        a.step(h, unit, null, [body]);
        expect(a.step(h / 2, unit, null, [{ ...body, z: .2 }])).toBe(0);
        expect(a.step(h / 2, unit, null, [{ ...body, z: .5 }])).toBe(1);
        expect(a.positions[2]).toBeGreaterThan(.57999);
    });

    it('supports a face interior beside a capsule even when all three vertices have clearance', () => {
        const mesh = coupon();
        mesh.positions = new Float32Array([-.2, -.2, .035, .2, -.2, .035, 0, .2, .035]);
        mesh.materialUV = new Float32Array([-.2, -.2, .2, -.2, 0, .2]);
        const sim = new GarmentSimulation(mesh, { ...passive, warp: 0, weft: 0, shear: 0, thickness: 0 });
        const sphere = { x: 0, y: -.1, z: 0, height: .2, radius: .1 };
        for (let i = 0; i < 8; i++) sim.step(h, unit, null, [sphere]);
        const p = sim.positions;
        const at = (weights: number[], j: number) => weights.reduce((s, w, i) => s + w * p[3 * i + j], 0);
        let min = Infinity;
        for (let i = 0; i <= 40; i++) for (let j = 0; j <= 40 - i; j++) {
            const w = [i / 40, j / 40, 1 - (i + j) / 40];
            min = Math.min(min, Math.hypot(at(w, 0), at(w, 1), at(w, 2)));
        }
        expect(min).toBeGreaterThan(.09999);
    });

    it('enforces plane clearance and friction reduces motion relative to the ground', () => {
        const slow = new GarmentSimulation(coupon(), { friction: 1, wind: 0, damping: 0 });
        const slick = new GarmentSimulation(coupon(), { friction: 0, wind: 0, damping: 0 });
        const down = { x: .25, y: -Math.sqrt(1 - .25 ** 2), z: 0 };
        for (let i = 0; i < 90; i++) {
            slow.step(h, unit, null, [], 0, down);
            slick.step(h, unit, null, [], 0, down);
        }
        expect(slow.positions[1]).toBeGreaterThanOrEqual(.00199);
        expect(slow.positions[0]).toBeLessThan(.6 * slick.positions[0]);
    });

    it('drapes the authored top against the specified torso with finite stitches and pinned shoulders', () => {
        const mesh = cookGarment(createSleevelessTop()), a = new GarmentSimulation(mesh);
        const torso = { id: 'torso', x: 0, y: 1.05, z: 0, height: .51, radius: .100, radiusX: .145 };
        for (let i = 0; i < 90; i++) a.step(h, unit, null, [torso], 0);
        expect([...a.positions].every(Number.isFinite)).toBe(true);
        for (const i of mesh.pins) expect(a.positions.slice(i * 3, i * 3 + 3)).toEqual(mesh.positions.slice(i * 3, i * 3 + 3));
        let worst = 0;
        for (const { a: i, b: j } of mesh.seams) {
            const p = a.positions;
            worst = Math.max(worst, Math.hypot(p[3 * i] - p[3 * j], p[3 * i + 1] - p[3 * j + 1], p[3 * i + 2] - p[3 * j + 2]));
        }
        expect(worst).toBeLessThan(.022);
        expect(a.time).toBeCloseTo(.75);
    });
});
