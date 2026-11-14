import { describe, expect, it } from 'vitest';
import {
    cookGarment, createSleevelessTop, duplicateGarmentPanel, readGarmentPattern, removeGarmentPanel, removeGarmentPoint, rotateGarmentPanel, splitGarmentEdge,
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


describe('garment placement and removal', () => {
    it('cooks layer ranks without changing base-layer source, topology or geometry', () => {
        const source = rectangle(), base = cookGarment(source);
        const explicit = structuredClone(source);
        explicit.panels[0].layer = 0;
        expect(JSON.stringify(readGarmentPattern(explicit))).toBe(JSON.stringify(readGarmentPattern(source)));
        expect(cookGarment(explicit)).toEqual(base);
        expect(base.panelRanges[0]).not.toHaveProperty('layer');
        explicit.panels[0].layer = 12;
        const raised = cookGarment(JSON.parse(JSON.stringify(explicit)));
        expect(raised).toEqual({ ...base, panelRanges: [{ ...base.panelRanges[0], layer: 12 }] });
        for (const bad of [-1, 1.5, 16, '1', NaN, Infinity, null]) {
            expect(() => readGarmentPattern({ ...source, panels: [{ ...source.panels[0], layer: bad }] })).toThrow(/layer must be an integer/);
        }
    });

    it('duplicates on the next layer, translating along the current normal and retaining independent pins and landmarks', () => {
        const source = rotateGarmentPanel(createSleevelessTop(), 'front', 'v', 90);
        const initial = JSON.stringify(source);
        const once = duplicateGarmentPanel(source, 'front'), copy = once.panels[2];
        expect(copy.id).toBe('front-1');
        expect(copy.name).toBe('Front (1)');
        expect(copy.layer).toBe(1);
        expect(copy.pins).toEqual(source.panels[0].pins);
        expect(copy.boundary).toEqual(source.panels[0].boundary);
        expect(copy.boundary[0]).not.toBe(once.panels[0].boundary[0]);
        expect(copy.placement.origin[0]).toBeCloseTo(.008, 12);
        expect(copy.placement.origin[2]).toBeCloseTo(source.panels[0].placement.origin[2], 12);
        expect(once.seams).toEqual(source.seams);
        expect(cookGarment(once).pins).toHaveLength(4);
        const twice = duplicateGarmentPanel(once, 'front');
        expect(twice.panels[3].id).toBe('front-2');
        expect(twice.panels[3].placement.origin[0]).toBeCloseTo(.016, 12);
        expect(twice.panels[3].layer).toBe(2);
        expect(JSON.stringify(source)).toBe(initial);
        copy.layer = 15;
        expect(duplicateGarmentPanel(once, copy.id).panels[3].layer).toBe(15);
    });

    it('rotates each panel-local axis independently and preserves all source dimensions and cook topology', () => {
        const source = createSleevelessTop(), original = cookGarment(source), saved = JSON.stringify(source);
        for (const [axis, wantedU, wantedV] of [
            ['u', [1, 0, 0], [0, 0, 1]], ['v', [0, 0, -1], [0, 1, 0]], ['normal', [0, 1, 0], [-1, 0, 0]],
        ] as const) {
            const rotated = rotateGarmentPanel(source, 'front', axis, 90);
            const { u, v, origin } = rotated.panels[0].placement;
            for (let i = 0; i < 3; i++) {
                expect(u[i]).toBeCloseTo(wantedU[i], 10);
                expect(v[i]).toBeCloseTo(wantedV[i], 10);
            }
            expect(origin).toEqual(source.panels[0].placement.origin);
            expect(rotated.panels[1]).toEqual(source.panels[1]);
            const cooked = cookGarment(rotated);
            expect(cooked.positions).not.toEqual(original.positions);
            expect(cooked.restUV).toEqual(original.restUV);
            expect(cooked.materialUV).toEqual(original.materialUV);
            expect(cooked.indices).toEqual(original.indices);
            expect(cooked.seams).toEqual(original.seams);
        }
        expect(JSON.stringify(source)).toBe(saved);
    });

    it('uses the current panel-local frame, composes reversibly, and keeps repeated rotations orthonormal', () => {
        const initial = createSleevelessTop();
        let rotated = initial;
        for (let i = 0; i < 60; i++) {
            rotated = rotateGarmentPanel(rotated, 'back', 'u', 21.75);
            rotated = rotateGarmentPanel(rotated, 'back', 'normal', -67.125);
        }
        const { u, v } = rotated.panels[1].placement;
        expect(Math.hypot(...u)).toBeCloseTo(1, 12);
        expect(Math.hypot(...v)).toBeCloseTo(1, 12);
        expect(u.reduce((s, x, i) => s + x * v[i], 0)).toBeCloseTo(0, 12);
        for (let i = 0; i < 60; i++) {
            rotated = rotateGarmentPanel(rotated, 'back', 'normal', 67.125);
            rotated = rotateGarmentPanel(rotated, 'back', 'u', -21.75);
        }
        const orig = initial.panels[1].placement;
        for (let i = 0; i < 3; i++) {
            expect(rotated.panels[1].placement.u[i]).toBeCloseTo(orig.u[i], 11);
            expect(rotated.panels[1].placement.v[i]).toBeCloseTo(orig.v[i], 11);
        }
        expect(() => rotateGarmentPanel(initial, 'front', 'u', NaN)).toThrow(/degrees/);
    });

    it('removes exactly the pins and seams that refer to a deleted vertex or panel', () => {
        const p = createSleevelessTop();
        const point = removeGarmentPoint(p, 'front', 'left_shoulder_outer');
        expect(point.panels[0].pins).toEqual(['right_shoulder_outer']);
        expect(point.panels[1]).toEqual(p.panels[1]);
        expect(point.seams).toEqual(p.seams.filter(s => s.id !== 'left_shoulder'));
        expect(cookGarment(point).pins).toHaveLength(1);
        expect(p.panels[0].boundary).toHaveLength(15);
        const third = rectangle().panels[0];
        const assembled = { ...p, panels: [...p.panels, third] };
        const deletion = removeGarmentPanel(assembled, third.id);
        expect(deletion).toEqual(p);
        const back = removeGarmentPanel(p, 'front');
        expect(back.panels.map(p => p.id)).toEqual(['back']);
        expect(back.seams).toEqual([]);
        expect(() => removeGarmentPanel(back, 'back')).toThrow(/at least one/);
    });

    it('refuses to create a degenerate or self-crossing polygon on point removal', () => {
        const p = rectangle();
        const tri = removeGarmentPoint(p, 'swatch', 'upper_right');
        expect(() => removeGarmentPoint(tri, 'swatch', 'upper_left')).toThrow(/three boundary/);
        // Removing the bottom-right corner connects the two opposite corners across the inward notch.
        const outline = [[0,0],[3,0],[3,3],[1.5,1],[0,3]];
        p.panels[0].pins = [];
        p.panels[0].boundary = outline.map(([x, y], i) => ({ id: 'pt' + i, x, y }));
        expect(() => readGarmentPattern(p)).not.toThrow();
        expect(() => removeGarmentPoint(p, 'swatch', 'pt1')).toThrow(/crosses itself|doubles back/);
        expect(p.panels[0].boundary).toHaveLength(5);
    });
});
