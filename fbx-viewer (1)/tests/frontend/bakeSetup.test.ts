import { describe, expect, it } from 'vitest';
import { TABLE_WIDTH, autoCage, averagedNormals, baseName, bakeGroups, blockAverage, materialColour, meshCage, supersampled, transferTables } from '../../texturing/bake/bakeSetup';

describe('cages', () => {
    it('averages normals across a hard edge, so both sides look the same way there', () => {
        // Two faces of a box meeting at a hard edge, each with its own copy of the edge's vertices.
        const positions = [
            0, 0, 0, 1, 0, 0, 0, 1, 0, // facing +z
            0, 0, 0, 0, 1, 0, 0, 0, -1, // facing -x
        ];
        const normals = averagedNormals(positions, [0, 1, 2, 3, 4, 5]);
        // The shared corner at the origin leans halfway between +z and -x on both copies.
        for (const v of [0, 3]) {
            expect(normals[v * 3]).toBeCloseTo(-Math.SQRT1_2, 5);
            expect(normals[v * 3 + 1]).toBeCloseTo(0, 5);
            expect(normals[v * 3 + 2]).toBeCloseTo(Math.SQRT1_2, 5);
        }
        // A corner only one face has keeps that face's normal.
        expect([normals[3], normals[4], normals[5]]).toEqual([0, 0, 1]);
    });

    it('looks from each vertex towards its cage-mesh vertex, as far as it lies', () => {
        const cage = meshCage([0, 0, 0, 1, 1, 1], [0, 0, 2, 1, 1, 1])!;
        expect(Array.from(cage)).toEqual([0, 0, 1, 2, 0, 0, 0, 0]);
        expect(meshCage([0, 0, 0], [0, 0, 0, 1, 1, 1])).toBeNull();
    });

    it('reaches past all but the furthest gaps on each side, with a margin', () => {
        const gaps = [...Array.from({ length: 19 }, (_, i) => (i + 1) * 0.01), 5, -0.02, -0.04];
        const { front, rear } = autoCage(gaps, 0.1);
        // The 5 is a ray that met another part: left out.
        expect(front).toBeCloseTo(0.19 * 1.25, 6);
        expect(rear).toBeCloseTo(0.02 * 1.25, 6);
        expect(autoCage([], 0.1)).toEqual({ front: 0.1, rear: 0.1 });
    });
});

describe('supersampling', () => {
    it('bakes larger by the factor, within what the GPU takes', () => {
        expect(supersampled(11, 4, 16384)).toEqual({ size: 13, factor: 4 });
        expect(supersampled(12, 8, 8192)).toEqual({ size: 13, factor: 2 });
        expect(supersampled(13, 2, 8192)).toEqual({ size: 13, factor: 1 });
        expect(supersampled(10, 1, 8192)).toEqual({ size: 10, factor: 1 });
    });

    it('averages a block weighting each texel by how much the surface covers it', () => {
        const even = blockAverage([[1, 0], [0, 1], [1, 1], [0, 0]], [1, 1, 1, 1]);
        expect(even.value).toEqual([0.5, 0.5]);
        expect(even.coverage).toBe(1);
        // Texels off the surface (an island's edge) add nothing, so the edge does not darken.
        const edge = blockAverage([[0.8], [0.6], [0], [0]], [1, 1, 0, 0]);
        expect(edge.value[0]).toBeCloseTo(0.7, 6);
        expect(edge.coverage).toBe(0.5);
        expect(blockAverage([[0.3], [0.9]], [0, 0]).value).toEqual([0.3]);
    });
});

describe('carrying over from the high-poly model', () => {
    it('looks each triangle\'s material up by its number', () => {
        const tables = transferTables([0, 1, 1, 5], [{ color: [1, 0, 0], opacity: 1 }, { color: [0, 0.5, 1], opacity: 0.25 }]);
        expect(tables.width).toBe(TABLE_WIDTH);
        expect(Array.from(tables.surface.slice(4, 8))).toEqual([0, 0.5, 1, 0.25]);
        // A triangle with no material known carries white, fully there.
        expect(Array.from(tables.surface.slice(12, 16))).toEqual([1, 1, 1, 1]);
        materialColour(1).forEach((value, i) => expect(tables.material[4 + i]).toBeCloseTo(value, 6));
        expect(materialColour(0)).not.toEqual(materialColour(1));
    });

    it('matches meshes by name, else by where they are', () => {
        expect(baseName('Helmet_low')).toBe('helmet');
        expect(baseName('helmet_HP')).toBe('helmet');
        expect(baseName('Visor.high.001')).toBe('visor');
        const box = (name: string, x: number) => ({ name, min: [x, 0, 0] as [number, number, number], max: [x + 1, 1, 1] as [number, number, number] });
        const low = [box('Helmet_low', 0), box('Strap_lo', 5), box('Buckle', 10)];
        const high = [box('Strap_high', 5), box('Helmet_high', 0), box('Detail', 10.2), box('Far', 50)];
        expect(bakeGroups(low, high, 0.1)).toEqual([[1], [0], [2]]);
        // Without names, by where they are; with nothing near, everything.
        expect(bakeGroups([box('A', 0)], high, 0.1, false)).toEqual([[1]]);
        expect(bakeGroups([box('A', 30)], high, 0.1)).toEqual([[0, 1, 2, 3]]);
    });
});
