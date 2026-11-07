import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildPartMesh } from '../../texturing/mesh/partMesh';
import { SurfacePicker } from '../../texturing/mesh/picker';
import { decalAt, decalCoordinates, decalTable, decalTriangles } from '../../texturing/paint/decals';
import { UvRaster } from '../../texturing/bake/uvRaster';
import type { TextureGpu } from '../../texturing/gpu/textureGpu';

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

    it('reach the shader by triangle, through the very geometry the UV raster draws, only where the decal lies', () => {
        // Several meshes in one set, split vertices and all, the decal on the sphere off to one side.
        const material = new THREE.MeshStandardMaterial();
        const root = new THREE.Group();
        const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(1, 0.3, 96, 12), material);
        const ball = new THREE.Mesh(new THREE.SphereGeometry(0.6, 24, 12), material);
        ball.position.set(3, 0, 0);
        const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1, 3, 3, 3), material);
        box.position.set(-3, 0, 0);
        root.add(knot, ball, box);
        root.updateMatrixWorld(true);
        const part = buildPartMesh(root, new Set([material]), { udim: false });
        const start = startAt(part, new THREE.Vector3(3, 0.1, 5), new THREE.Vector3(0, 0, -1));
        const width = 0.5;
        const coords = decalCoordinates(part, start, new THREE.Vector3(1, 0, 0), width);
        const triangles = decalTriangles(part, coords, width, width, 0);
        const lookup = decalTable(part, coords, triangles);
        // The raster's own geometry (it needs no GPU to be laid out).
        const raster = new UvRaster({} as TextureGpu, part);
        const tiles = (raster as unknown as { tiles: Map<number, { geometry: THREE.BufferGeometry }> }).tiles;
        let covered = 0;
        for (const { geometry } of tiles.values()) {
            const ids = geometry.getAttribute('ids'), position = geometry.getAttribute('position');
            const edge1 = geometry.getAttribute('edge1'), edge2 = geometry.getAttribute('edge2');
            for (let corner = 0; corner < position.count; corner += 3) {
                // The middle of each triangle as drawn, as a texel there would see it.
                const triangle = Math.round(ids.getZ(corner));
                const middle = [0, 1, 2].map((axis) => (position.getComponent(corner, axis) + position.getComponent(corner + 1, axis) + position.getComponent(corner + 2, axis)) / 3);
                const place = decalAt(lookup, triangle, middle, [edge1.getX(corner), edge1.getY(corner), edge1.getZ(corner)], [edge2.getX(corner), edge2.getY(corner), edge2.getZ(corner)]);
                if (!place) { expect(triangles).not.toContain(triangle); continue; }
                // The same as the triangle's own corners' places, averaged.
                const expected = [0, 1].map((c) => [0, 1, 2].reduce((sum, k) => sum + coords[part.indices[triangle * 3 + k] * 4 + c], 0) / 3);
                expect(place[0]).toBeCloseTo(expected[0], 4);
                expect(place[1]).toBeCloseTo(expected[1], 4);
                expect(place[2]).toBeCloseTo(1, 5);
                // Inside the decal: on the sphere, near where it was put.
                if (Math.abs(place[0]) <= width / 2 && Math.abs(place[1]) <= width / 2) {
                    covered++;
                    expect(new THREE.Vector3(...middle).distanceTo(start.point)).toBeLessThan(width);
                }
            }
        }
        expect(covered).toBeGreaterThan(10);
    });
});
