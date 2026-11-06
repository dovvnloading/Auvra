import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildPartMesh } from '../../texturing/mesh/partMesh';
import { SELECTION_WIDTH, SurfaceSelector, changeTriangles, countTriangles, decodeTriangles, encodeTriangles, matchesId, selectionBytes } from '../../texturing/paint/selection';

/** A grid of 4 × 4 square cells (two triangles each) on a plane, and a second plane beside it as another mesh. */
const grids = () => {
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group();
    const first = new THREE.Mesh(new THREE.PlaneGeometry(4, 4, 4, 4), material);
    const second = new THREE.Mesh(new THREE.PlaneGeometry(4, 4, 4, 4), material);
    second.position.x = 10;
    root.add(first, second);
    return buildPartMesh(root, new Set([material]), { udim: false });
};

const centreOf = (part: ReturnType<typeof grids>, triangle: number): THREE.Vector3 => {
    const centre = new THREE.Vector3();
    for (let k = 0; k < 3; k++) {
        const v = part.indices[triangle * 3 + k];
        centre.add(new THREE.Vector3(part.positions[v * 3], part.positions[v * 3 + 1], part.positions[v * 3 + 2]));
    }
    return centre.divideScalar(3);
};

/** The triangle of the first grid whose middle is nearest a point. */
const triangleAt = (part: ReturnType<typeof grids>, x: number, y: number): number => {
    let best = -1;
    let distance = Infinity;
    for (let t = 0; t < part.indices.length / 3; t++) {
        const d = centreOf(part, t).distanceTo(new THREE.Vector3(x, y, 0));
        if (d < distance) { distance = d; best = t; }
    }
    return best;
};

describe('picked triangle sets', () => {
    it('keep as sorted runs and come back the same', () => {
        const runs = encodeTriangles([9, 3, 4, 5, 5, 12, 10, 11, -1, 2.5]);
        expect(runs).toEqual([3, 3, 9, 4]);
        expect(decodeTriangles(runs)).toEqual([3, 4, 5, 9, 10, 11, 12]);
        expect(countTriangles(runs)).toBe(7);
        expect(changeTriangles(runs, [6, 7, 8])).toEqual([3, 10]);
        expect(changeTriangles(runs, [4, 10, 11], true)).toEqual([3, 1, 5, 1, 9, 1, 12, 1]);
        expect(decodeTriangles([1, -2, 'x' as unknown as number, 3])).toEqual([]);
    });

    it('make a picture with a byte per triangle', () => {
        const { data, width, height } = selectionBytes([1, 2, SELECTION_WIDTH + 3, 1], SELECTION_WIDTH + 10);
        expect(width).toBe(SELECTION_WIDTH);
        expect(height).toBe(2);
        expect([...data].reduce((sum, value) => sum + (value ? 1 : 0), 0)).toBe(3);
        expect(data[1]).toBe(255);
        expect(data[2]).toBe(255);
        expect(data[SELECTION_WIDTH + 3]).toBe(255);
        expect(data[0]).toBe(0);
    });

    it('match ID colours within a tolerance in every channel', () => {
        expect(matchesId([0.5, 0.2, 0.1], [[0.51, 0.19, 0.1]], 0.02)).toBe(true);
        expect(matchesId([0.5, 0.2, 0.1], [[0.5, 0.25, 0.1]], 0.02)).toBe(false);
        expect(matchesId([0.5, 0.2, 0.1], [[0, 0, 0], [0.5, 0.2, 0.1]], 0)).toBe(true);
        expect(matchesId([0.5, 0.2, 0.1], [], 1)).toBe(false);
    });
});

describe('picking on the surface', () => {
    it('takes a triangle, its quad, its mesh part and its UV piece', () => {
        const part = grids();
        const selector = new SurfaceSelector(part);
        const t = triangleAt(part, -0.5, 0.5);
        const at: [number, number, number] = [-0.5, 0.5, 0];
        expect(selector.pick('triangle', t, at)).toEqual([t]);
        const quad = selector.pick('quad', t, at);
        expect(quad).toHaveLength(2);
        // Both halves of one square cell.
        const cell = (triangle: number) => { const c = centreOf(part, triangle); return `${Math.floor(c.x)},${Math.floor(c.y)}`; };
        expect(cell(quad[0])).toBe(cell(quad[1]));
        const mesh = selector.pick('mesh', t, at);
        expect(mesh).toHaveLength(32);
        expect(mesh.every((triangle) => centreOf(part, triangle).x < 5)).toBe(true);
        expect(selector.pick('island', t, at).every((triangle) => part.triangleIsland[triangle] === part.triangleIsland[t])).toBe(true);
        expect(selector.pick('mesh', -1, at)).toEqual([]);
    });

    it('runs an edge loop across the edge nearest the click, both ways, to the edges of the grid', () => {
        const part = grids();
        const selector = new SurfaceSelector(part);
        // Near the left edge of a cell in the second row: the loop runs left and right along the row.
        const row = selector.pick('loop', triangleAt(part, -0.5, 0.5), [-0.95, 0.5, 0]);
        expect(row).toHaveLength(8);
        expect(row.every((triangle) => Math.floor(centreOf(part, triangle).y) === 0)).toBe(true);
        // Near its top edge instead: the loop runs up and down the column.
        const column = selector.pick('loop', triangleAt(part, -0.5, 0.5), [-0.5, 0.95, 0]);
        expect(column).toHaveLength(8);
        expect(column.every((triangle) => Math.floor(centreOf(part, triangle).x) === -1)).toBe(true);
    });
});
