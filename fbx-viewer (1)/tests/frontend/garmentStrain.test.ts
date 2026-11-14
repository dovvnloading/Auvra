import { describe, expect, it } from 'vitest';
import { cookGarment, createSleevelessTop, type CookedGarment } from '../../runtime/garments/pattern';
import { GarmentStrainMap } from '../../runtime/garments/strain';

function mesh(): CookedGarment {
    const materialUV = new Float32Array([0, 0, 1, 0, 0, 1, -2, 0]);
    return { materialUV, restUV: materialUV, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, -2, 0, 0]),
        indices: new Uint32Array([0, 1, 2, 0, 2, 3]), panelRanges: [], pins: [], seams: [], hinges: [] };
}
function transform(c: CookedGarment, fn: (u: number, v: number) => number[]): Float32Array {
    const p = c.positions.slice();
    for (let i = 0; i < p.length / 3; i++) p.set(fn(c.materialUV[2 * i], c.materialUV[2 * i + 1]), 3 * i);
    return p;
}
describe('live garment strain', () => {
    it('is zero after rigid placement and accounts for the panel grain frame', () => {
        const p = createSleevelessTop();
        p.panels[0].grain = [.6, .8];
        const c = cookGarment(p), overlay = new GarmentStrainMap(c);
        for (const view of ['warp', 'weft', 'shear'] as const) {
            overlay.update(c.positions, view);
            for (const x of overlay.values) expect(x).toBeCloseTo(0, view === 'shear' ? 2 : 4);
        }
        const rotated = transform(c, (u, v) => [8 + 1.125 * u, -4, 2 + .94 * v]);
        overlay.update(rotated, 'warp');
        for (const x of overlay.values) expect(x).toBeCloseTo(.125, 3);
        overlay.update(rotated, 'weft');
        for (const x of overlay.values) expect(x).toBeCloseTo(-.06, 3);
    });
    it('reports signed shear angle and keeps raw values after display saturates', () => {
        const c = mesh(), overlay = new GarmentStrainMap(c);
        function shear(theta: number) {
            const radians = theta * Math.PI / 180;
            overlay.update(transform(c, (u, v) => [u + v * Math.sin(radians), v * Math.cos(radians), 0]), 'shear');
            expect(overlay.values[0]).toBeCloseTo(theta, 4);
        }
        shear(-30);
        expect(overlay.colors[2]).toBeGreaterThan(overlay.colors[0]);
        shear(30);
        const red = overlay.colors.slice();
        shear(60);
        expect(overlay.colors).toEqual(red);
        expect(overlay.colors[0]).toBeGreaterThan(overlay.colors[2]);
    });
    it('uses rest area for vertex averaging and reuses its output buffers', () => {
        const c = mesh(), overlay = new GarmentStrainMap(c), colors = overlay.colors, values = overlay.values;
        const p = c.positions.slice();
        p[3] = 1.3;  // Smaller triangle: warp extension 30%. Larger triangle: unchanged.
        overlay.update(p, 'warp');
        expect(overlay.values[0]).toBeCloseTo(.1);
        expect(overlay.values[1]).toBeCloseTo(.3);
        expect(overlay.values[2]).toBeCloseTo(.1);
        expect(overlay.values[3]).toBeCloseTo(0);
        overlay.update(c.positions, 'weft');
        expect(overlay.values).toBe(values);
        expect(overlay.colors).toBe(colors);
        expect(overlay.values.every(v => v === 0)).toBe(true);
    });
    it('marks invalid measurements without spreading NaNs to adjoining valid triangles', () => {
        const c = mesh();
        c.materialUV[2] = 0;
        const overlay = new GarmentStrainMap(c);
        overlay.update(c.positions, 'shear');
        expect(Number.isNaN(overlay.values[1])).toBe(true);
        expect(overlay.colors.every(Number.isFinite)).toBe(true);
        expect(overlay.values[0]).toBeCloseTo(0);
        overlay.update(c.positions.map(() => 0), 'shear');
        expect(overlay.values.every(Number.isNaN)).toBe(true);
        expect(() => overlay.update(new Float32Array(3), 'warp')).toThrow(/do not match/);
    });
});
