import { describe, expect, it } from 'vitest';
import { GARMENT_LAYER_LIMITS } from '../../runtime/garments/layerContact';
import { cookGarment, type GarmentPattern, type GarmentPanel, type CookedGarment } from '../../runtime/garments/pattern';
import { GarmentSelfContact } from '../../runtime/garments/selfContact';
import { GARMENT_STEP, GarmentSimulation } from '../../runtime/garments/solver';

const clearance = .004;
const triangle = [[-.20, -.10], [.20, -.10], [0, .18]];

function panel(id: string, layer: number, z: number, pinned = false, points = triangle): GarmentPanel {
    return {
        id, name: id, layer, boundary: points.map(([x, y], i) => ({ id: 'v' + i, x, y })),
        placement: { origin: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0] },
        grain: [1, 0], pins: pinned ? points.map((_, i) => 'v' + i) : [],
    };
}
const cook = (...panels: GarmentPanel[]) =>
    cookGarment({ version: 1, edgeLength: .5, panels, seams: [] } as GarmentPattern);
const masses = (mesh: CookedGarment) => Float64Array.from({ length: mesh.positions.length / 3 }, (_, i) => mesh.pins.includes(i) ? 0 : 1);
const minGap = (p: Float32Array, lo: number, hi: number) =>
    Math.min(...[0, 1, 2].map(i => p[3*(hi+i)+2] - p[3*(lo+i)+2]));
const point = (p: Float32Array, i: number) => p.slice(3*i, 3*i+3);

describe('authored layer ordering within one cooked garment', () => {
    it('splits and stacks three exactly coincident outward panels while their inner base stays pinned', () => {
        const mesh = cook(panel('inner', 0, 0, true), panel('middle', 2, 0), panel('outer', 15, 0));
        const p = mesh.positions.slice(), contact = new GarmentSelfContact(mesh, masses(mesh));
        contact.solve(mesh.positions, p, clearance);
        expect(contact.stats.layeredPairs).toBe(3);
        expect(contact.stats.layerContacts).toBeGreaterThan(0);
        expect(contact.stats.limited).toBe(false);
        expect(contact.stats.maxLayerDeficit).toBeLessThan(.0003);
        expect(Array.from(p.slice(0, 9))).toEqual(Array.from(mesh.positions.slice(0, 9)));
        expect(minGap(p, 0, 3)).toBeGreaterThan(.0037);
        expect(minGap(p, 3, 6)).toBeGreaterThan(.0037);
        for (let i = 0; i < 3; i++) expect(point(p, 6+i)[2]).toBeLessThan(.009);
    });

    it('repairs a wrong-side near layer and rejects a 160 mm crossing from the correct side', () => {
        const mesh = cook(panel('inner', 0, 0, true), panel('outer', 1, -.006));
        const p = mesh.positions.slice(), contact = new GarmentSelfContact(mesh, masses(mesh));
        contact.solve(mesh.positions, p, clearance);
        expect(minGap(p, 0, 3)).toBeCloseTo(clearance, 6);
        const start = mesh.positions.slice();
        for (let i = 3; i < 6; i++) {
            start[3*i+2] = .08;
            p[3*i+2] = -.08;
        }
        contact.solve(start, p, clearance);
        expect(minGap(p, 0, 3)).toBeCloseTo(clearance, 6);
        const distant = mesh.positions.slice();
        for (let i = 3; i < 6; i++) distant[3*i+2] = -.10;
        const unchanged = distant.slice();
        contact.solve(unchanged, distant, clearance);
        expect(distant).toEqual(unchanged);
    });

    it('builds an edge-intersection manifold even with all projected vertices outside the opposite triangle', () => {
        const mesh = cook(panel('lower', 0, 0, true, [[-.20, -.03],[.20, -.03],[0,.03]]),
            panel('upper', 1, 0, false, [[-.03,-.2],[.03,-.2],[0,.2]]));
        const p = mesh.positions.slice(), contact = new GarmentSelfContact(mesh, masses(mesh));
        contact.solve(mesh.positions, p, clearance);
        expect(contact.stats.layerContacts).toBeGreaterThanOrEqual(4);
        expect(contact.stats.maxLayerDeficit).toBeLessThan(1e-6);
        // The two edges intersect at the origin in the projected interior of both triangles.
        expect((p[11]+p[14]+2*p[17])/4).toBeGreaterThan(.00399);
    });

    it('preserves inverse-mass balance, reports unmovable pins and honours the shared feature budget', () => {
        const mesh = cook(panel('lower', 0, 0), panel('upper', 1, 0));
        const p = mesh.positions.slice();
        new GarmentSelfContact(mesh, new Float64Array([1,1,1,3,3,3])).solve(mesh.positions, p, clearance);
        for (let i = 0; i < 3; i++) {
            expect(p[3*i+2]).toBeCloseTo(-.001, 6);
            expect(p[3*(i+3)+2]).toBeCloseTo(.003, 6);
        }
        const blocked = new GarmentSelfContact(mesh, new Float64Array(6));
        const unchanged = mesh.positions.slice();
        blocked.solve(mesh.positions, unchanged, clearance);
        expect(unchanged).toEqual(mesh.positions);
        expect(blocked.stats.layerBlocked).toBe(3);
        expect(blocked.stats.maxLayerDeficit).toBeCloseTo(clearance);
        const bounded = new GarmentSelfContact(mesh, masses(mesh), 1);
        bounded.solve(mesh.positions, unchanged, clearance);
        expect(bounded.stats.limited).toBe(true);
        expect(bounded.stats.testedFeatures).toBe(1);
        expect(bounded.stats.layerProjections).toBe(1);
        expect(bounded.stats.layerProjections).toBeLessThanOrEqual(GARMENT_LAYER_LIMITS.passes);
    });

    it('limits leverage near a pinned edge and exposes the unresolvable thickness instead of launching a free corner', () => {
        const lower = panel('pad', 0, 0, true, [[-.04,.0004],[.04,.0004],[0,.0009]]);
        const top = panel('top', 1, 0, false, [[-.1,0],[.1,0],[0,.2]]);
        top.pins = ['v0', 'v1'];
        const mesh = cook(lower, top), end = mesh.positions.slice();
        const contact = new GarmentSelfContact(mesh, masses(mesh));
        contact.solve(mesh.positions, end, clearance);
        expect(end.slice(0, 15)).toEqual(mesh.positions.slice(0, 15));
        // Exact recovery at the closest witness requires 2 m movement of a 20 cm panel.
        expect(end[17]).toBeGreaterThan(0);
        expect(end[17]).toBeCloseTo(.016, 6);
        expect(contact.stats.layerBlocked).toBeGreaterThan(0);
        expect(contact.stats.maxLayerDeficit).toBeGreaterThan(.003);
    });

    it('defers a back-facing fold to its approached side, and never ranks equal layer IDs', () => {
        const inner = panel('inner', 3, 0, true), outer = panel('outer', 4, -.002);
        outer.placement.u = [-1,0,0];
        const mesh = cook(inner, outer);
        const p = mesh.positions.slice(), contact = new GarmentSelfContact(mesh, masses(mesh));
        contact.solve(mesh.positions, p, clearance);
        expect(contact.stats.layerContacts).toBe(0);
        expect(contact.stats.layerFallbackPairs).toBe(1);
        expect(p[11]).toBeLessThan(-.00399);
        outer.layer = 3;
        const same = cook(inner, outer);
        expect(new GarmentSimulation(same).selfContactStats).toBeNull();
        const generic = new GarmentSelfContact(same, masses(same));
        generic.solve(same.positions, same.positions.slice(), clearance);
        expect(generic.stats.layeredPairs).toBe(0);
        expect(generic.stats.vertexFace).toBeGreaterThan(0);
    });

    it.each([0, 1])('uses a zero physical gap on a full crossing and remembers the approach side at rest (order %s)', layer => {
        for (const sign of layer ? [1] : [1, -1]) {
            const lower = panel('support', 0, 0, true);
            const upper = panel('cloth', layer, .025*sign, false, [[-.05,-.035],[.05,-.035],[0,.04]]);
            const mesh = cook(lower, upper);
            const contact = new GarmentSelfContact(mesh, masses(mesh));
            let accepted = mesh.positions.slice();
            for (let tick = 0; tick < 121; tick++) {
                const predicted = accepted.slice();
                for (let i = 3; i < 6; i++) predicted[3*i+2] -= sign * (tick === 0 ? .06 : .00075);
                contact.solve(accepted, predicted, 0);
                for (let i = 3; i < 6; i++) expect(Math.abs(predicted[3*i+2])).toBeLessThan(1e-7);
                expect(predicted.slice(0, 9)).toEqual(mesh.positions.slice(0, 9));
                expect(contact.stats.limited).toBe(false);
                accepted = predicted;
            }
            const departing = accepted.slice();
            for (let i = 3; i < 6; i++) departing[3*i+2] += sign*.01;
            const expected = departing.slice();
            contact.solve(accepted, departing, 0);
            expect(departing).toEqual(expected);
        }
    });

    it.each([0, 1])('supports repeated gravitational contact with the authored zero-offset material (order %s)', layer => {
        const mesh = cook(panel('support', 0, 0, true), panel('cloth', layer, .0001, false, [[-.05,-.035],[.05,-.035],[0,.04]]));
        const sim = new GarmentSimulation(mesh, { thickness: 0, selfCollision: layer === 0 });
        const down = { x: 0, y: 0, z: -1 };
        for (let i = 0; i < 120; i++) {
            sim.step(GARMENT_STEP, undefined, null, [], null, down);
            for (let v = 3; v < 6; v++) expect(Math.abs(sim.positions[3*v+2])).toBeLessThan(1e-7);
            expect(sim.selfContactStats?.limited).toBe(false);
        }
    });

    it.each([0, 1])('allows coincident resting sheets without inventing thickness at zero clearance (order %s)', layer => {
        const mesh = cook(panel('support', 0, 0, true), panel('cloth', layer, 0));
        const contact = new GarmentSelfContact(mesh, masses(mesh)), resting = mesh.positions.slice();
        for (let i = 0; i < 3; i++) contact.solve(mesh.positions, resting, 0);
        expect(resting).toEqual(mesh.positions);
        expect(contact.stats.facePairs).toBe(1);
        expect(contact.stats.layerProjections + contact.stats.vertexFace + contact.stats.edgeEdge).toBe(0);
        for (const invalid of [-.001, NaN, Infinity]) {
            contact.solve(mesh.positions, resting, invalid);
            expect(contact.stats.facePairs).toBe(0);
            expect(resting).toEqual(mesh.positions);
        }
    });

    it.each([{ gap: .004, layer: 1 }, { gap: 0, layer: 1 }, { gap: 0, layer: 0 }])(
        'sweeps an interior crossing during tangential motion, including zero clearance ($gap, order $layer)', ({ gap, layer }) => {
        const lower = panel('inner', 0, 0, true, [[-.1,-.1], [.1,-.1], [0,.1]]);
        const upper = panel('outer', layer, .04, false, [[-.01,-.01], [.01,-.01], [0,.01]]);
        upper.placement.origin[0] = -.45;
        const mesh = cook(lower, upper);
        const end = mesh.positions.slice(), contact = new GarmentSelfContact(mesh, masses(mesh));
        for (let i = 3; i < 6; i++) {
            end[3*i] += .9;
            end[3*i+2] = -.04;
        }
        contact.solve(mesh.positions, end, gap);
        expect(contact.stats.layerFallbackPairs).toBe(layer === 1 ? 1 : 0);
        expect(contact.stats.vertexFace + contact.stats.edgeEdge).toBeGreaterThan(0);
        expect(contact.stats.advancementLimited).toBe(0);
        for (let i = 3; i < 6; i++) expect(end[3*i+2]).toBeGreaterThanOrEqual(gap - 1e-7);
    });

    it('carries a compressed outer panel on a moving pinned inner panel for two seconds with collision switch off', () => {
        const input = [panel('support', 0, 0, true), panel('cloth', 1, .0005)];
        const ranked = new GarmentSimulation(cook(...input));
        const plain = new GarmentSimulation(cook(...input.map(p => ({ ...p, layer: 0 }))));
        const down = { x: 0, y: 0, z: -1 };
        const matrix = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
        let worst = Infinity, hits = 0;
        for (let i = 0; i < 240; i++) {
            matrix[14] = .035 * Math.sin(i * GARMENT_STEP * 4.0);
            for (const sim of [ranked, plain]) sim.step(GARMENT_STEP, matrix, null, [], null, down);
            hits += ranked.selfContactStats!.layerProjections;
            worst = Math.min(worst, minGap(ranked.positions, 0, 3));
        }
        expect(worst).toBeGreaterThan(.00399);
        expect(hits).toBeGreaterThan(300);
        expect(plain.selfContactStats).toBeNull();
        expect(minGap(plain.positions, 0, 3)).toBeLessThan(-1);
    });
});
