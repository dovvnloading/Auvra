import { describe, expect, it } from 'vitest';
import { BAKE_MEMORY_BUDGET, TABLE_WIDTH, autoCage, averagedNormals, bakeBytesPerTexel, baseName, bakeGroups, bandRanges, bandRows, blockAverage, planStrips, stripOffsets, materialColour, meshCage, supersampled, traceSteps, transferTables } from '../../texturing/bake/bakeSetup';

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
        expect(supersampled(11, 4, 16384)).toEqual({ size: 13, factor: 4, limited: false });
        expect(supersampled(12, 8, 8192)).toEqual({ size: 13, factor: 2, limited: true });
        expect(supersampled(13, 2, 8192)).toEqual({ size: 13, factor: 1, limited: true });
        expect(supersampled(10, 1, 8192)).toEqual({ size: 10, factor: 1, limited: false });
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

describe('banding heavy bake passes', () => {
    it('draws few enough rows at once that no draw does more than its share of the work', () => {
        const budget = 24_000_000;
        // A 4096 bake tracing 16 rays a texel through a model of 100 000 triangles.
        const cost = 16 * traceSteps(100_000);
        const rows = bandRows(4096, 4096, cost, budget);
        expect(4096 * rows * cost).toBeLessThanOrEqual(budget);
        expect(4096 * (rows + 1) * cost).toBeGreaterThan(budget);
        const bands = bandRanges(4096, rows);
        expect(bands[0]).toEqual([0, rows]);
        expect(bands[bands.length - 1][1]).toBe(4096);
        bands.slice(1).forEach(([start], i) => expect(start).toBe(bands[i][1]));
        // Twice the size, four times the work: four times the bands.
        expect(bandRanges(8192, bandRows(8192, 8192, cost, budget)).length).toBeGreaterThanOrEqual(bands.length * 4 - 4);
        // However heavy, a draw is at least one row; light passes are drawn whole.
        expect(bandRows(4096, 4096, 1e9, budget)).toBe(1);
        expect(bandRows(512, 512, 1, budget)).toBe(512);
        expect(traceSteps(1_000_000)).toBeGreaterThan(traceSteps(1_000));
    });

    it('keeps a supersampled bake within the graphics memory it may take', () => {
        const all = bakeBytesPerTexel(['normal', 'worldNormal', 'ambientOcclusion', 'curvature', 'position', 'thickness', 'id', 'height'], ['cavity', 'bentNormal'], false);
        // A 2048 set at 2x2 with every map would need 4096: more than is safe, so it stays at 2048.
        const capped = supersampled(11, 2, 16384, all);
        expect(capped).toEqual({ size: 11, factor: 1, limited: true });
        expect((2 ** 12) ** 2 * all).toBeGreaterThan(BAKE_MEMORY_BUDGET);
        // A 1024 set at 4x4 goes as far as fits.
        const smaller = supersampled(10, 4, 16384, all);
        expect(smaller.size).toBe(11);
        expect(smaller.limited).toBe(true);
        expect((2 ** smaller.size) ** 2 * all).toBeLessThanOrEqual(BAKE_MEMORY_BUDGET);
        // Fewer maps leave room for more.
        expect(bakeBytesPerTexel(['normal'], [], false)).toBeLessThan(all);
        expect(supersampled(10, 2, 16384, bakeBytesPerTexel(['normal'], [], false))).toEqual({ size: 11, factor: 2, limited: false });
    });
});

describe('bakes in strips', () => {
    it('cuts a bake into strips of whole blocks that fit the memory, covering every row once', () => {
        const strips = planStrips(4096, 2, 100, 400 * 1024 * 1024, 68);
        expect(strips.length).toBeGreaterThan(1);
        expect(strips[0].y0).toBe(0);
        expect(strips[strips.length - 1].y1).toBe(4096);
        strips.forEach((strip, i) => {
            if (i) expect(strip.y0).toBe(strips[i - 1].y1);
            expect((strip.y1 - strip.y0) % 2).toBe(0);
            expect(strip.keep0).toBe(strip.y0 / 2);
            expect(strip.from).toBe(Math.max(0, strip.y0 - 68));
            expect((strip.to - strip.from) * 4096 * 100).toBeLessThanOrEqual(400 * 1024 * 1024);
        });
        // A bake that fits is one strip, with no margins.
        expect(planStrips(1024, 2, 100, 400 * 1024 * 1024, 68)).toEqual([{ y0: 0, y1: 1024, from: 0, to: 1024, keep0: 0, keep1: 512 }]);
    });

    it('averages strips down to exactly what one pass would make', () => {
        const size = 64, factor = 4, kept = size / factor;
        const value = (x: number, y: number) => Math.sin(x * 0.37) + Math.cos(y * 0.21) + x * y * 0.001;
        const covered = (x: number, y: number) => ((x * 7 + y * 13) % 5 === 0 ? 0 : 1);
        const average = (read: (x: number, y: number) => [number, number], fx: number, fy: number, sourceRow: number, targetRow: number) => {
            const values: number[][] = [];
            const coverage: number[] = [];
            for (let y = 0; y < factor; y++) for (let x = 0; x < factor; x++) {
                const [v, c] = read(fx * factor + x, (fy - targetRow) * factor + sourceRow + y);
                values.push([v]);
                coverage.push(c);
            }
            return blockAverage(values, coverage).value[0];
        };
        const single = (fx: number, fy: number) => average((x, y) => [value(x, y), covered(x, y)], fx, fy, 0, 0);
        // Strips small enough that there are several, with margins either side.
        const strips = planStrips(size, factor, 1, size * 24, 3);
        expect(strips.length).toBeGreaterThan(2);
        let checked = 0;
        for (const strip of strips) {
            // What the strip's bake holds: its rows and margins, from its first baked row.
            const read = (x: number, y: number): [number, number] => {
                const row = strip.from + y;
                expect(row).toBeGreaterThanOrEqual(strip.from);
                expect(row).toBeLessThan(strip.to);
                return [value(x, row), covered(x, row)];
            };
            const { sourceRow, targetRow } = stripOffsets(strip);
            for (let fy = strip.keep0; fy < strip.keep1; fy++) for (let fx = 0; fx < kept; fx++) {
                expect(average(read, fx, fy, sourceRow, targetRow)).toBeCloseTo(single(fx, fy), 12);
                checked++;
            }
        }
        expect(checked).toBe(kept * kept);
    });
});
