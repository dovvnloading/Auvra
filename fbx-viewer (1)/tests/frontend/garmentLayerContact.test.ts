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

    it('sweeps a fast sliding contact that is clear of the support footprint at both ends of a tick', () => {
        const lower = panel('inner', 0, 0, true, [[-.1,-.1], [.1,-.1], [0,.1]]);
        const upper = panel('outer', 1, .04, false, [[-.01,-.01], [.01,-.01], [0,.01]]);
        upper.placement.origin[0] = -.45;
        const mesh = cook(lower, upper);
        const end = mesh.positions.slice(), contact = new GarmentSelfContact(mesh, masses(mesh));
        for (let i = 3; i < 6; i++) {
            end[3*i] += .9;
            end[3*i+2] = -.04;
        }
        contact.solve(mesh.positions, end, clearance);
        expect(contact.stats.layerFallbackPairs).toBe(1);
        expect(contact.stats.vertexFace + contact.stats.edgeEdge).toBeGreaterThan(0);
        expect(contact.stats.advancementLimited).toBe(0);
        for (let i = 3; i < 6; i++) expect(end[3*i+2]).toBeGreaterThan(.00399);
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
