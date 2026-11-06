import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildPartMesh } from '../../texturing/mesh/partMesh';
import { coverage, packIslands, smallestBoxAngle, type Island } from '../../texturing/uv/pack';
import { newTriangleTiles } from '../../texturing/uv/transfer';
import { flattenChart } from '../../texturing/uv/lscm';
import { overlappingTriangles } from '../../texturing/uv/overlap';
import { DEFAULT_UNWRAP, unwrap } from '../../texturing/uv/unwrap';
import { applyLayout, buildLayout, decodeLayout, encodeLayout } from '../../texturing/uv/uvLayout';
import { buildCharts, buildTopology, chartCoordinates, existingSeams } from '../../texturing/uv/uvTopology';

/** A gently rising ramp of two turns round a post: every turn nearly flat, so flattened whole it lies on itself. */
const ramp = (): THREE.BufferGeometry => {
    const turns = 2, around = 96 * turns, across = 6;
    const positions: number[] = [];
    const index: number[] = [];
    for (let i = 0; i <= around; i++) {
        const angle = (i / around) * turns * Math.PI * 2;
        for (let j = 0; j <= across; j++) {
            const radius = 1 + j / across;
            positions.push(Math.cos(angle) * radius, (i / around) * turns * 0.25, Math.sin(angle) * radius);
        }
    }
    for (let i = 0; i < around; i++) {
        for (let j = 0; j < across; j++) {
            const a = i * (across + 1) + j, b = a + 1, c = a + across + 1, d = c + 1;
            index.push(a, c, b, b, c, d);
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Array((positions.length / 3) * 2).fill(0), 2));
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    return geometry;
};

const meshOf = (geometry: THREE.BufferGeometry) => {
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, material));
    return { root, material, part: buildPartMesh(root, new Set([material]), { udim: false }) };
};

/** Islands from an unwrap, ready to pack. */
const islandsOf = (result: ReturnType<typeof unwrap>): Island[] => result.charts.map((chart, i) => ({
    uv: result.flat[i].uv,
    triangles: chart.corners,
    area3d: 0,
}));

/** True when two islands cover the same texel of a 512 grid (texel centres inside triangles). */
const overlaps = (placements: ReturnType<typeof packIslands>, islands: Island[]): boolean => {
    const size = 512;
    const owner = new Int32Array(size * size).fill(-1);
    for (let i = 0; i < placements.length; i++) {
        const uv = placements[i].uv;
        const t = islands[i].triangles;
        for (let k = 0; k < t.length; k += 3) {
            const p = [t[k], t[k + 1], t[k + 2]].map((c) => [(uv[c * 2] % 1) * size, (uv[c * 2 + 1] % 1) * size]);
            const x0 = Math.max(0, Math.floor(Math.min(p[0][0], p[1][0], p[2][0]))), x1 = Math.min(size - 1, Math.ceil(Math.max(p[0][0], p[1][0], p[2][0])));
            const y0 = Math.max(0, Math.floor(Math.min(p[0][1], p[1][1], p[2][1]))), y1 = Math.min(size - 1, Math.ceil(Math.max(p[0][1], p[1][1], p[2][1])));
            const edge = (a: number[], b: number[], x: number, y: number) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
            const area = edge(p[0], p[1], p[2][0], p[2][1]);
            if (area === 0) continue;
            for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                const cx = x + 0.5, cy = y + 0.5;
                const w = [edge(p[1], p[2], cx, cy), edge(p[2], p[0], cx, cy), edge(p[0], p[1], cx, cy)];
                if (!(area > 0 ? w.every((v) => v > 0) : w.every((v) => v < 0))) continue;
                const at = y * size + x;
                if (owner[at] >= 0 && owner[at] !== i) return true;
                owner[at] = i;
            }
        }
    }
    return false;
};

describe('unwrapping', () => {
    it('cuts a closed sphere into flat pieces with nothing turned over and little stretch', () => {
        const { part } = meshOf(new THREE.SphereGeometry(1, 32, 16));
        const topology = buildTopology(part.positions, part.indices);
        const result = unwrap(topology);
        expect(result.charts.length).toBeGreaterThan(1);
        for (const flat of result.flat) {
            expect(flat.flipped).toBe(0);
            expect(flat.overlapping).toBe(0);
            expect(flat.meanStretch).toBeLessThan(DEFAULT_UNWRAP.stretchLimit);
        }
    });

    it('cuts a torus (which has a hole through it) until every piece lies flat', () => {
        const { part } = meshOf(new THREE.TorusGeometry(1, 0.35, 24, 48));
        const result = unwrap(buildTopology(part.positions, part.indices));
        for (const flat of result.flat) expect(flat.flipped + flat.overlapping).toBe(0);
        const faces = result.charts.reduce((sum, chart) => sum + chart.faces.length, 0);
        expect(faces).toBe(part.indices.length / 3);
    });

    it('puts seams on a cube\'s hard edges and keeps its faces unstretched', () => {
        const geometry = new THREE.BoxGeometry(1, 1, 1, 3, 3, 3);
        const { part } = meshOf(geometry);
        const topology = buildTopology(part.positions, part.indices);
        const result = unwrap(topology);
        for (const flat of result.flat) expect(flat.worstStretch).toBeLessThan(1.05);
    });

    it('finds triangles lying over each other, but not ones that only touch', () => {
        // Two triangles sharing an edge, one touching them at a corner, and one laid over the first.
        const uv = [0, 0, 1, 0, 0, 1, 1, 1, 2, 1, 1, 2, 0.1, 0.1, 0.6, 0.1, 0.1, 0.6];
        const corners = [0, 1, 2, 1, 3, 2, 3, 4, 5, 6, 7, 8];
        expect(overlappingTriangles(uv, corners, 3)).toEqual([]);
        expect(overlappingTriangles(uv, corners, 4).sort()).toEqual([0, 3]);
        expect(overlappingTriangles(uv, corners, 4, true)).toHaveLength(2);
    });

    it('cuts a piece that wraps round onto itself until none lies on itself', () => {
        const { part } = meshOf(ramp());
        const topology = buildTopology(part.positions, part.indices);
        // Flattened whole, the ramp's two turns lie on each other, though no triangle turns over.
        const [whole] = buildCharts(topology, new Set());
        const flat = flattenChart(topology, whole);
        expect(flat.flipped).toBe(0);
        expect(flat.overlapping).toBeGreaterThan(0);
        const result = unwrap(topology);
        expect(result.charts.length).toBeGreaterThan(1);
        result.charts.forEach((chart, i) => {
            expect(result.flat[i].overlapping).toBe(0);
            expect(overlappingTriangles(result.flat[i].uv, chart.corners, chart.faces.length)).toEqual([]);
        });
    });

    it('reads the seams a mesh already has from its texture coordinates', () => {
        const { part } = meshOf(new THREE.BoxGeometry(1, 1, 1));
        const topology = buildTopology(part.positions, part.indices);
        // A box's faces each have their own 0..1 square, so every hard edge is already a seam.
        expect(existingSeams(topology, part.indices, part.uvs).size).toBe(12);
    });
});

describe('packing', () => {
    it('turns a slanted rectangle to sit square', () => {
        const angle = 0.4;
        const points = [[0, 0], [2, 0], [2, 1], [0, 1]].map(([x, y]) => [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)]);
        const turn = smallestBoxAngle(points);
        expect(Math.abs(Math.sin(turn + angle) * Math.cos(turn + angle))).toBeLessThan(1e-6);
    });

    it('lays islands out without overlaps, inside the square, with their padding', () => {
        const { part } = meshOf(new THREE.SphereGeometry(1, 32, 16));
        const result = unwrap(buildTopology(part.positions, part.indices));
        const islands = islandsOf(result);
        const placements = packIslands(islands, { padding: 8, resolution: 1024, rotate: true, tilesX: 1, tilesY: 1 });
        expect(overlaps(placements, islands)).toBe(false);
        for (const placement of placements) for (const value of placement.uv) { expect(value).toBeGreaterThanOrEqual(8 / 1024 - 1e-9); expect(value).toBeLessThanOrEqual(1); }
        expect(coverage(placements, islands)).toBeGreaterThan(0.35);
    });

    it('sets small islands into the holes of others', () => {
        // Square frames with holes that four small squares fit into: boxes and rows of islands can never use the holes.
        const ring = (): Island => {
            const uv = new Float64Array([0, 0, 1, 0, 1, 1, 0, 1, 0.2, 0.2, 0.8, 0.2, 0.8, 0.8, 0.2, 0.8]);
            const triangles: number[] = [];
            for (let k = 0; k < 4; k++) { const n = (k + 1) % 4; triangles.push(k, n, 4 + n, k, 4 + n, 4 + k); }
            return { uv, triangles, area3d: 0.64 };
        };
        const square = (): Island => ({ uv: new Float64Array([0, 0, 0.24, 0, 0.24, 0.24, 0, 0.24]), triangles: [0, 1, 2, 0, 2, 3], area3d: 0.0576 });
        const islands = [...Array.from({ length: 16 }, ring), ...Array.from({ length: 64 }, square)];
        const placements = packIslands(islands, { padding: 8, resolution: 2048, rotate: true, tilesX: 1, tilesY: 1 });
        expect(overlaps(placements, islands)).toBe(false);
        // Packed as boxes or along a skyline this reaches about 0.64.
        expect(coverage(placements, islands)).toBeGreaterThan(0.75);
    });

    it('spreads islands over several UDIM tiles when asked', () => {
        const { part } = meshOf(new THREE.TorusGeometry(1, 0.35, 24, 48));
        const islands = islandsOf(unwrap(buildTopology(part.positions, part.indices)));
        const placements = packIslands(islands, { padding: 4, resolution: 1024, rotate: true, tilesX: 2, tilesY: 1 });
        expect(new Set(placements.map((placement) => placement.tile)).size).toBeGreaterThan(1);
        for (const placement of placements) {
            const u = placement.uv[0];
            expect(Math.floor(u)).toBe(placement.tile - 1001);
        }
    });

    it('leaves islands kept in place exactly where they are and fits the rest round them', () => {
        const { part } = meshOf(new THREE.SphereGeometry(1, 32, 16));
        const islands = islandsOf(unwrap(buildTopology(part.positions, part.indices)));
        const settings = { padding: 8, resolution: 1024, rotate: true, tilesX: 1, tilesY: 1 };
        const first = packIslands(islands, settings);
        // One island moved by hand into the middle of the picture, over others, and one left where it was.
        const box = (uv: Float64Array) => {
            let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
            for (let k = 0; k < uv.length; k += 2) { minU = Math.min(minU, uv[k]); maxU = Math.max(maxU, uv[k]); minV = Math.min(minV, uv[k + 1]); maxV = Math.max(maxV, uv[k + 1]); }
            return { minU, minV, maxU, maxV };
        };
        const b = box(first[0].uv);
        const middle = first[0].uv.map((value, k) => value + (k % 2 === 0 ? 0.5 - (b.minU + b.maxU) / 2 : 0.5 - (b.minV + b.maxV) / 2));
        const keep = new Map<number, Float64Array>([[0, middle]]);
        // Another kept where packing first put it, when it clears the moved one (kept islands are never moved apart).
        const m = box(middle);
        const clear = first.findIndex((placement, i) => {
            const o = box(placement.uv);
            return i > 0 && (o.maxU < m.minU || o.minU > m.maxU || o.maxV < m.minV || o.minV > m.maxV);
        });
        if (clear > 0) keep.set(clear, first[clear].uv);
        const again = packIslands(islands.map((island, i) => (keep.has(i) ? { ...island, keepAt: keep.get(i) } : island)), settings);
        for (const [i, uv] of keep) {
            expect(Array.from(again[i].uv)).toEqual(Array.from(uv));
            expect(again[i].tile).toBe(1001);
        }
        expect(overlaps(again, islands)).toBe(false);
        for (const placement of again) for (const value of placement.uv) { expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThanOrEqual(1); }
    });

    it('packs a surface\'s current islands as they are: same shapes, same sizes against each other, no new seams', () => {
        // Two separate quads whose coordinates are not their shapes on the model: a 2:1 strip and a 1:3 one.
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 2, 1, 0, 2, 1, 1, 2, 0, 1, 2], 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0.5, 0, 0.5, 0.25, 0, 0.25, 0.6, 0.6, 0.7, 0.6, 0.7, 0.9, 0.6, 0.9], 2));
        geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
        geometry.computeVertexNormals();
        const { part } = meshOf(geometry);
        const topology = buildTopology(part.positions, part.indices);
        const charts = buildCharts(topology, existingSeams(topology, part.indices, part.uvs));
        expect(charts).toHaveLength(2);
        const before = chartCoordinates(charts, part.indices, part.uvs);
        const islands: Island[] = charts.map((chart, i) => ({ uv: before[i], triangles: chart.corners, area3d: 0 }));
        const placements = packIslands(islands, { padding: 8, resolution: 1024, rotate: true, tilesX: 1, tilesY: 1 });
        expect(overlaps(placements, islands)).toBe(false);
        // Every distance between corners grows by one common factor: shapes and relative sizes are kept.
        const distance = (uv: ArrayLike<number>, a: number, b: number) => Math.hypot(uv[a * 2] - uv[b * 2], uv[a * 2 + 1] - uv[b * 2 + 1]);
        const factor = distance(placements[0].uv, 0, 1) / distance(before[0], 0, 1);
        expect(factor).toBeGreaterThan(1);
        islands.forEach((island, i) => {
            const corners = island.uv.length / 2;
            for (let a = 0; a < corners; a++) for (let c = a + 1; c < corners; c++) expect(distance(placements[i].uv, a, c)).toBeCloseTo(distance(before[i], a, c) * factor, 6);
        });
    });

    it('finds the UDIM tile each triangle of a layout lands in, by its middle', () => {
        const corner = new Float32Array([
            0.1, 0.1, 0.4, 0.1, 0.1, 0.4,
            1.2, 0.3, 1.6, 0.3, 1.2, 0.7,
            0.2, 1.1, 0.5, 1.1, 0.2, 1.5,
            // Touching the next tile's edge, but lying in the first.
            0.7, 0.2, 1.0, 0.2, 0.7, 0.5,
        ]);
        expect([...newTriangleTiles(corner)]).toEqual([1001, 1002, 1011, 1001]);
    });
});

describe('layouts on models', () => {
    it('splits vertices along new seams, keeps every corner where it was, and survives saving', () => {
        const { root, part } = meshOf(new THREE.SphereGeometry(1, 24, 12));
        const mesh = root.children[0] as THREE.Mesh;
        const before = mesh.geometry;
        const topology = buildTopology(part.positions, part.indices);
        const result = unwrap(topology);
        const placements = packIslands(islandsOf(result));
        const cornerUv = new Float32Array(part.indices.length * 2);
        const cornerKey = new Uint32Array(part.indices.length);
        result.charts.forEach((chart, c) => chart.faces.forEach((face, i) => {
            for (let k = 0; k < 3; k++) {
                const corner = chart.corners[i * 3 + k];
                cornerUv[(face * 3 + k) * 2] = placements[c].uv[corner * 2];
                cornerUv[(face * 3 + k) * 2 + 1] = placements[c].uv[corner * 2 + 1];
                cornerKey[face * 3 + k] = c * 1_000_000 + corner;
            }
        }));
        const layout = decodeLayout(encodeLayout(buildLayout(root, part, cornerUv, cornerKey, null)).buffer as ArrayBuffer);
        expect(applyLayout(root, layout)).toBe(1);
        const after = mesh.geometry;
        expect(after).not.toBe(before);
        expect(after.index!.count).toBe(before.index!.count);
        // Each corner of each triangle sits where it did.
        for (let i = 0; i < after.index!.count; i++) {
            const a = after.index!.getX(i);
            const b = before.index!.getX(i);
            expect(after.attributes.position.getX(a)).toBeCloseTo(before.attributes.position.getX(b));
            expect(after.attributes.position.getY(a)).toBeCloseTo(before.attributes.position.getY(b));
        }
        // Laid out again from the file's own vertices, not from the first layout's.
        expect(applyLayout(root, layout)).toBe(1);
        expect(mesh.geometry.attributes.position.count).toBe(after.attributes.position.count);
    });

    it('keeps packed vertex data exactly and leaves the old tangents behind', () => {
        const geometry = new THREE.SphereGeometry(1, 16, 8);
        const count = geometry.attributes.position.count;
        // Colours stored as bytes read as 0..1, as glTF keeps them; and tangents for the old coordinates.
        const bytes = new Uint8Array(count * 4).map((_, i) => (i * 37) % 256);
        geometry.setAttribute('color', new THREE.BufferAttribute(bytes, 4, true));
        geometry.setAttribute('tangent', new THREE.BufferAttribute(new Float32Array(count * 4).fill(1), 4));
        const { root, part } = meshOf(geometry);
        const mesh = root.children[0] as THREE.Mesh;
        const result = unwrap(buildTopology(part.positions, part.indices));
        const placements = packIslands(islandsOf(result));
        const cornerUv = new Float32Array(part.indices.length * 2);
        const cornerKey = new Uint32Array(part.indices.length);
        result.charts.forEach((chart, c) => chart.faces.forEach((face, i) => {
            for (let k = 0; k < 3; k++) {
                const corner = chart.corners[i * 3 + k];
                cornerUv.set([placements[c].uv[corner * 2], placements[c].uv[corner * 2 + 1]], (face * 3 + k) * 2);
                cornerKey[face * 3 + k] = c * 1_000_000 + corner;
            }
        }));
        const layout = decodeLayout(encodeLayout(buildLayout(root, part, cornerUv, cornerKey, null)).buffer as ArrayBuffer);
        expect(applyLayout(root, layout)).toBe(1);
        const after = mesh.geometry;
        expect(after.attributes.tangent).toBeUndefined();
        const color = after.attributes.color as THREE.BufferAttribute;
        expect(color.normalized).toBe(true);
        expect(color.array).toBeInstanceOf(Uint8Array);
        const source = layout.meshes[0].sourceOf;
        for (let i = 0; i < source.length; i++) {
            for (let c = 0; c < 4; c++) expect(color.array[i * 4 + c]).toBe(bytes[source[i] * 4 + c]);
        }
    });
});
