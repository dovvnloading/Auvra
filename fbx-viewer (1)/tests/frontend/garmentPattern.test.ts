import { describe, expect, it } from 'vitest';
import {
    cookGarment, createSleevelessTop, readGarmentPattern, splitGarmentEdge,
    type CookedGarment, type GarmentPattern,
} from '../../runtime/garments/pattern';

function rectangle(): GarmentPattern {
    return {
        version: 1, edgeLength: .075, seams: [],
        panels: [{
            id: 'swatch', name: 'Calibration rectangle', grain: [0, 1], pins: ['upper_left'],
            placement: { origin: [1, 2, 3], u: [0, 0, -1], v: [0, 1, 0] },
            boundary: [
                { id: 'lower_left', x: 0, y: 0 }, { id: 'lower_right', x: .4, y: 0 },
                { id: 'upper_right', x: .4, y: .3 }, { id: 'upper_left', x: 0, y: .3 },
            ],
        }],
    };
}

function directedTriangleArea(cook: CookedGarment, offset: number): number {
    const a = cook.indices[offset] * 2, b = cook.indices[offset + 1] * 2, c = cook.indices[offset + 2] * 2;
    const xy = cook.restUV;
    return ((xy[b] - xy[a]) * (xy[c + 1] - xy[a + 1]) - (xy[c] - xy[a]) * (xy[b + 1] - xy[a + 1])) / 2;
}

describe('polygonal garment patterns', () => {
    it('cooks an oriented triangle disk with positive area, controlled maximum edge and manifold hinge adjacency', () => {
        const input = rectangle(), cooked = cookGarment(input);
        let area = 0;
        const edgeCounts = new Map<string, number>();
        for (let t = 0; t < cooked.indices.length; t += 3) {
            const triArea = directedTriangleArea(cooked, t);
            expect(triArea).toBeGreaterThan(0);
            area += triArea;
            for (let k = 0; k < 3; k++) {
                const a = cooked.indices[t + k], b = cooked.indices[t + (k + 1) % 3];
                const key = [Math.min(a, b), Math.max(a, b)].join('/');
                edgeCounts.set(key, 1 + (edgeCounts.get(key) ?? 0));
                expect(Math.hypot(cooked.restUV[a * 2] - cooked.restUV[b * 2], cooked.restUV[a * 2 + 1] - cooked.restUV[b * 2 + 1])).toBeLessThanOrEqual(input.edgeLength + 1e-7);
            }
        }
        expect(area).toBeCloseTo(.4 * .3, 7);
        expect([...edgeCounts.values()].every(n => n === 1 || n === 2)).toBe(true);
        expect(cooked.positions.length / 3 - edgeCounts.size + cooked.indices.length / 3).toBe(1);
        expect(cooked.hinges).toHaveLength([...edgeCounts.values()].filter(n => n === 2).length);
        for (const h of cooked.hinges) {
            expect(new Set([h.a, h.b, h.c, h.d]).size).toBe(4);
            expect(edgeCounts.get([Math.min(h.a, h.b), Math.max(h.a, h.b)].join('/'))).toBe(2);
        }
    });

    it('keeps SI material directions separate from placement and preserves pinned source points', () => {
        const cooked = cookGarment(rectangle());
        const pinned = cooked.pins[0];
        expect(Array.from(cooked.positions.slice(3 * pinned, 3 * pinned + 3))).toEqual([1, Math.fround(2.3), 3]);
        for (let i = 0; i < cooked.positions.length / 3; i++) {
            const x = cooked.restUV[i * 2], y = cooked.restUV[i * 2 + 1];
            expect(cooked.materialUV[i * 2]).toBeCloseTo(y);
            expect(cooked.materialUV[i * 2 + 1]).toBeCloseTo(-x);
            expect(cooked.positions[i * 3]).toBe(1);
            expect(cooked.positions[i * 3 + 1]).toBeCloseTo(2 + y);
            expect(cooked.positions[i * 3 + 2]).toBeCloseTo(3 - x);
        }
    });

    it('repeated cooks of serialized patterns return identical buffers and aligned, outward-facing top seams', () => {
        const input = createSleevelessTop(), mesh = cookGarment(input);
        const other = cookGarment(JSON.parse(JSON.stringify(input)));
        expect(mesh).toEqual(other);
        expect(mesh.panelRanges.map(p => p.id)).toEqual(['front', 'back']);
        expect(mesh.pins).toHaveLength(2);
        expect(mesh.pins.every(i => i < mesh.panelRanges[1].vertexStart)).toBe(true);
        expect(mesh.seams.every(s => !(mesh.pins.includes(s.a) && mesh.pins.includes(s.b)))).toBe(true);
        for (const s of mesh.seams) {
            for (const axis of [0, 1]) expect(mesh.positions[s.a * 3 + axis]).toBeCloseTo(mesh.positions[s.b * 3 + axis], 7);
            expect(mesh.positions[s.a * 3 + 2]).toBeGreaterThan(0);
            expect(mesh.positions[s.b * 3 + 2]).toBeLessThan(0);
            expect(s.weight).toBeGreaterThan(0);
        }
        expect(mesh.seams.reduce((sum, s) => sum + s.weight, 0)).toBeCloseTo(2 * (.36 + Math.hypot(.095, .03)), 10);
    });

    it('keeps unequal sewn boundaries aligned at equal normalized arc positions without changing panel lengths', () => {
        const input = createSleevelessTop();
        input.panels[1].boundary.find(p => p.id === 'right_underarm')!.y = .23;
        const cook = cookGarment(input);
        const rightSide = cook.seams.filter(s => s.seamId === 'right_side');
        expect(rightSide.length).toBeGreaterThan(2);
        for (const s of rightSide) expect(cook.restUV[s.a * 2 + 1] / .36).toBeCloseTo(cook.restUV[s.b * 2 + 1] / .23, 6);
        expect(rightSide.reduce((sum, s) => sum + s.weight, 0)).toBeCloseTo((.36 + .23) / 2, 10);
    });

    it('splits sewn spans in reverse selection order as a single immutable edit', () => {
        const original = createSleevelessTop();
        const split = splitGarmentEdge(original, 'back', 'right_underarm', 'hem_right', .25);
        const source = original.seams.find(s => s.id === 'right_side')!;
        const first = split.seams.find(s => s.id === 'right_side')!;
        const second = split.seams.find(s => s.id === 'right_side-1')!;
        expect(source.a.to).toBe('right_underarm');
        expect(split.seams).toHaveLength(5);
        for (const side of ['a', 'b'] as const) {
            expect(first[side].to).toBe(second[side].from);
            const p = split.panels.find(p => p.id === first[side].panelId)!;
            expect(p.boundary.find(v => v.id === first[side].to)?.y).toBeCloseTo(.27);
        }
        const cook = cookGarment(split);
        expect(cook.seams.filter(s => s.seamId.startsWith('right_side')).reduce((n, s) => n + s.weight, 0)).toBeCloseTo(.36);
    });

    it('preserves the boundary of a concave panel, including a new collinear point', () => {
        const input = rectangle();
        input.panels[0].boundary.splice(2, 0, { id: 'notch', x: .16, y: .15 });
        const split = splitGarmentEdge(input, 'swatch', 'upper_right', 'upper_left', .2);
        const cook = cookGarment(split);
        let area = 0;
        for (let i = 0; i < cook.indices.length; i += 3) {
            const a = directedTriangleArea(cook, i);
            expect(a).toBeGreaterThan(0);
            area += a;
        }
        expect(area).toBeCloseTo(.12 - .24 * .3 / 2, 7);
        expect(cook.restUV.some((val, i) => i % 2 === 0 && Math.abs(val - .32) < 1e-7 && Math.abs(cook.restUV[i + 1] - .3) < 1e-7)).toBe(true);
    });

    it('rejects crossing, duplicate and invalidly directed input and bounds mesh work', () => {
        const repeated = rectangle();
        repeated.panels[0].boundary[1].id = 'upper_left';
        expect(() => readGarmentPattern(repeated)).toThrow(/Duplicate boundary point ID/);
        const crossing = rectangle();
        [crossing.panels[0].boundary[1], crossing.panels[0].boundary[2]] = [crossing.panels[0].boundary[2], crossing.panels[0].boundary[1]];
        expect(() => cookGarment(crossing)).toThrow(/crosses itself/);
        const top = createSleevelessTop();
        [top.seams[0].a.from, top.seams[0].a.to] = [top.seams[0].a.to, top.seams[0].a.from];
        expect(() => cookGarment(top)).toThrow(/opposite directions/);
        const huge = rectangle();
        huge.panels[0].boundary.forEach(p => { p.x *= 100; p.y *= 100; });
        expect(() => cookGarment(huge)).toThrow(/budget exceeded/);
        expect(() => readGarmentPattern(null)).toThrow(/must be an object/);
        expect(() => splitGarmentEdge(rectangle(), 'swatch', 'lower_left', 'upper_right')).toThrow(/complete boundary edge/);
    });
});
