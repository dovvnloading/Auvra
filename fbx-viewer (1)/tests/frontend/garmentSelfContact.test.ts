import { describe, expect, it } from 'vitest';
import type { CookedGarment, GarmentStitch } from '../../runtime/garments/pattern';
import { GarmentSelfContact } from '../../runtime/garments/selfContact';
import { GarmentSimulation } from '../../runtime/garments/solver';

function fixture(vertices: number[][], indices: number[], seams: GarmentStitch[] = []): CookedGarment {
    const uv = new Float32Array(vertices.flatMap(([x, y]) => [x, y]));
    return { positions: new Float32Array(vertices.flat()), restUV: uv, materialUV: uv, indices: new Uint32Array(indices), pins: [], hinges: [], seams, panelRanges: [] };
}
const floor = [[-1, -1, 0], [1, -1, 0], [0, 1, 0]];
const upper = [[-.1, -.1, .2], [.1, -.1, .2], [0, .1, .2]];

describe('bounded garment self contact', () => {
    it('preserves the approach side of a smaller free patch passing through a pinned panel between samples', () => {
        const mesh = fixture([...floor, ...upper], [0, 1, 2, 3, 4, 5]), p = mesh.positions.slice();
        const contact = new GarmentSelfContact(mesh, new Float64Array([0, 0, 0, 1, 1, 1]));
        for (let i = 3; i < 6; i++) p[3 * i + 2] = -.2;
        contact.solve(mesh.positions, p, .004);
        expect(contact.stats.vertexFace).toBeGreaterThan(0);
        for (let i = 3; i < 6; i++) expect(p[3 * i + 2]).toBeGreaterThan(.00399);
        expect(Array.from(p.slice(0, 9))).toEqual(Array.from(mesh.positions.slice(0, 9)));
        expect(contact.stats.limited).toBe(false);
        expect(new GarmentSimulation(mesh).selfContactStats).toBeNull();
        expect(new GarmentSimulation(mesh, { selfCollision: true }).selfContactStats).toBeDefined();
    });

    it('detects an interior edge crossing with all vertices outside the opposite face', () => {
        const mesh = fixture([[-1, 0, 0], [1, 0, 0], [0, -.1, 0], [0, -1, .2], [0, 1, .2], [.1, 1, .2]], [0, 1, 2, 3, 4, 5]);
        const p = mesh.positions.slice();
        for (let i = 3; i < 6; i++) p[3 * i + 2] = -.2;
        const contact = new GarmentSelfContact(mesh, new Float64Array([0, 0, 0, 1, 1, 1]));
        contact.solve(mesh.positions, p, .004);
        expect(contact.stats.edgeEdge).toBeGreaterThan(0);
        expect((p[11] + p[14]) / 2).toBeGreaterThan(.00399);
    });

    it('keeps incidence local to a fold and reconstructs sewn adjacency', () => {
        const mesh = fixture([...floor, [0, 0, .01], ...upper], [0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 4, 5, 6]);
        const p = mesh.positions.slice();
        for (let i = 4; i < 7; i++) p[3 * i + 2] = -.2;
        const contact = new GarmentSelfContact(mesh, new Float64Array([0, 0, 0, 0, 1, 1, 1]));
        contact.solve(mesh.positions, p, .004);
        expect(contact.stats.vertexFace + contact.stats.edgeEdge).toBeGreaterThan(0);
        expect(p[20]).toBeGreaterThan(.00399);
        const joined = fixture([...floor, ...upper], [0, 1, 2, 3, 4, 5], [{ a: 0, b: 3, weight: 1, seamId: 'join' }]);
        const sewn = new GarmentSelfContact(joined, new Float64Array(6).fill(1));
        const end = joined.positions.slice();
        for (let i = 3; i < 6; i++) end[3 * i + 2] = -.2;
        sewn.solve(joined.positions, end, .004);
        expect(sewn.stats.testedFeatures).toBe(0);
    });

    it('advances to a grazing mid-tick crossing during fast tangential slip on equal-rank panels', () => {
        const mesh = fixture([[-.1,-.1,0],[.1,-.1,0],[0,.1,0],
            [-.46,-.01,.04],[-.44,-.01,.04],[-.45,.01,.04]], [0,1,2,3,4,5]);
        const end = mesh.positions.slice(), contact = new GarmentSelfContact(mesh, new Float64Array([0,0,0,1,1,1]));
        for (let i = 3; i < 6; i++) {
            end[3*i] += .9;
            end[3*i+2] = -.04;
        }
        contact.solve(mesh.positions, end, .004);
        expect(contact.stats.advancementLimited).toBe(0);
        expect(contact.stats.vertexFace + contact.stats.edgeEdge).toBeGreaterThan(0);
        for (let i = 3; i < 6; i++) expect(end[3*i+2]).toBeGreaterThan(.00399);
    });

    it('bounds the response at a nearly fixed barycentric witness on an unranked panel', () => {
        const mesh = fixture([[-.04,.0004,0],[.04,.0004,0],[0,.0009,0],[-.1,0,.001],[.1,0,.001],[0,.2,.001]], [0,1,2,3,4,5]);
        const end = mesh.positions.slice(), contact = new GarmentSelfContact(mesh, new Float64Array([0,0,0,0,0,1]));
        contact.solve(mesh.positions, end, .004);
        expect(end.slice(0, 15)).toEqual(mesh.positions.slice(0, 15));
        expect(end[17]).toBeGreaterThan(.001);
        expect(end[17]).toBeCloseTo(.017, 6);
        expect(contact.stats.pinLimited).toBeGreaterThan(0);
    });

    it('finds the last overlapping patch on an axis-aligned strip without spending the whole broad-phase budget on disjoint triangles', () => {
        const vertices: number[][] = [], indices: number[] = [];
        const faces = 540;
        for (let i = 0; i <= faces; i++) {
            const y = .03 * Math.min(i, faces - 1);
            const z = i === faces ? .001 : 0;
            vertices.push([0,y,z], [.005,y,z], [0,y+.005,z]);
            indices.push(3*i, 3*i+1, 3*i+2);
        }
        for (const rotate of [false, true]) {
            const mesh = fixture(rotate ? vertices.map(([x,y,z]) => [x, z, y]) : vertices, indices);
            const normalAxis = rotate ? 1 : 2;
            const mass = new Float64Array(vertices.length);
            mass.fill(1, 3*faces);
            const contact = new GarmentSelfContact(mesh, mass), end = mesh.positions.slice();
            contact.solve(mesh.positions, end, .004);
            expect(contact.stats.broadPhaseLimited).toBe(false);
            expect(contact.stats.facePairs).toBe(1);
            for (let i = 3*faces; i < vertices.length; i++) expect(end[3*i + normalAxis]).toBeGreaterThan(.00399);
        }
    });

    it('reports feature capacity exhaustion on a crowded frame', () => {
        const mesh = fixture([...floor, ...upper], [0, 1, 2, 3, 4, 5]);
        const p = mesh.positions.slice();
        for (let i = 3; i < 6; i++) p[3 * i + 2] = -.2;
        const contact = new GarmentSelfContact(mesh, new Float64Array(6).fill(1), 1);
        contact.solve(mesh.positions, p, .004);
        expect(contact.stats.limited).toBe(true);
        expect(contact.stats.testedFeatures).toBe(1);
    });
});
