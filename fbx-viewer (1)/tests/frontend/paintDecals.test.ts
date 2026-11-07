import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildPartMesh } from '../../texturing/mesh/partMesh';
import { SurfacePicker } from '../../texturing/mesh/picker';
import { decalCoordinates, decalTriangles } from '../../texturing/paint/decals';

const partOf = (geometry: THREE.BufferGeometry) => {
    const material = new THREE.MeshStandardMaterial();
    return buildPartMesh(new THREE.Mesh(geometry, material), new Set([material]), { udim: false });
};
/** The place on the decal of the vertex nearest `at`. */
const placeNear = (part: ReturnType<typeof partOf>, coords: Float32Array, at: THREE.Vector3): [number, number, number] => {
    let best = 0, bestDistance = Infinity;
    for (let v = 0; v < part.positions.length / 3; v++) {
        const distance = at.distanceTo(new THREE.Vector3(part.positions[v * 3], part.positions[v * 3 + 1], part.positions[v * 3 + 2]));
        if (distance < bestDistance) { bestDistance = distance; best = v; }
    }
    return [coords[best * 4], coords[best * 4 + 1], coords[best * 4 + 2]];
};
const startAt = (part: ReturnType<typeof partOf>, origin: THREE.Vector3, direction: THREE.Vector3) => {
    const hit = new SurfacePicker(part).cast(origin, direction)!;
    return { point: hit.point, normal: hit.normal, triangle: hit.triangle };
};

describe('decals wrapped onto the mesh', () => {
    it('lie flat on a flat surface, turned by the way across', () => {
        const part = partOf(new THREE.PlaneGeometry(4, 4, 8, 8));
        const coords = decalCoordinates(part, startAt(part, new THREE.Vector3(0.2, 0.1, 1), new THREE.Vector3(0, 0, -1)), new THREE.Vector3(0, 1, 0), 10);
        const [x, y, reached] = placeNear(part, coords, new THREE.Vector3(1.5, 1, 0));
        // Across runs up the plane here, and up runs to the left.
        expect(reached).toBe(1);
        expect(x).toBeCloseTo(0.9, 4);
        expect(y).toBeCloseTo(-1.3, 4);
    });

    it('wrap round a cylinder by the distance along it, across its seam', () => {
        const part = partOf(new THREE.CylinderGeometry(1, 1, 2, 96, 4, true));
        const coords = decalCoordinates(part, startAt(part, new THREE.Vector3(0, 0, 3), new THREE.Vector3(0, 0, -1)), new THREE.Vector3(1, 0, 0), 4);
        // A quarter turn either way is a quarter of the way round, not the straight line through.
        expect(placeNear(part, coords, new THREE.Vector3(1, 0, 0))[0]).toBeCloseTo(Math.PI / 2, 1);
        expect(placeNear(part, coords, new THREE.Vector3(-1, 0, 0))[0]).toBeCloseTo(-Math.PI / 2, 1);
        // Up the cylinder is straight up.
        expect(placeNear(part, coords, new THREE.Vector3(0, 1, 1))[1]).toBeCloseTo(1, 2);
        // Round the back, where the cylinder's UVs are cut: reached from both sides, about half way round.
        const back = placeNear(part, coords, new THREE.Vector3(0, 0, -1));
        expect(back[2]).toBe(1);
        expect(Math.abs(back[0])).toBeGreaterThan(2.9);
        // A decal reaching round to there leaves out the triangles where the two sides meet.
        const covered = decalTriangles(part, coords, 8, 3, 0);
        const spread = (t: number) => { const xs = [0, 1, 2].map((k) => coords[part.indices[t * 3 + k] * 4]); return Math.max(...xs) - Math.min(...xs); };
        expect(covered.length).toBeGreaterThan(100);
        expect(Math.max(...covered.map(spread))).toBeLessThan(0.5);
    });

    it('run over a box edge onto the next face, and only so far', () => {
        const part = partOf(new THREE.BoxGeometry(2, 2, 2, 2, 2, 2));
        const coords = decalCoordinates(part, startAt(part, new THREE.Vector3(0, 0, 3), new THREE.Vector3(0, 0, -1)), new THREE.Vector3(1, 0, 0), 2.5);
        // One along the front face to the edge, one down the side face.
        const side = placeNear(part, coords, new THREE.Vector3(1, 0, 0));
        expect(side[2]).toBe(1);
        expect(side[0]).toBeCloseTo(2, 0);
        expect(Math.abs(side[1])).toBeLessThan(0.2);
        // The back is past its reach.
        expect(placeNear(part, coords, new THREE.Vector3(0, 0, -1))[2]).toBe(0);
        // A decal one unit across covers the front face's middle triangles only.
        const covered = decalTriangles(part, coords, 1, 1, 0);
        expect(covered.length).toBeGreaterThan(0);
        expect(covered.every((t) => [0, 1, 2].every((k) => part.positions[part.indices[t * 3 + k] * 3 + 2] > 0.99))).toBe(true);
    });
});
