import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildPartMesh } from '../../texturing/mesh/partMesh';
import { reachesSeam, seamFlaps } from '../../texturing/paint/seams';

const partOf = (geometry: THREE.BufferGeometry) => {
    const material = new THREE.MeshStandardMaterial();
    return buildPartMesh(new THREE.Mesh(geometry, material), new Set([material]), { udim: false });
};

describe('filters across UV seams', () => {
    it('find no seam where the layout is joined', () => {
        expect(seamFlaps(partOf(new THREE.PlaneGeometry(1, 1, 4, 4)), 1001).count).toBe(0);
    });

    it('unfold the neighbour across a cylinder\'s seam into the gap beyond each side, read from the other side', () => {
        const segments = 32;
        const part = partOf(new THREE.CylinderGeometry(1, 1, 2, segments, 1, true));
        const flaps = seamFlaps(part, 1001);
        // One seam down the cylinder (a quad, two triangles a side): a flap on each side of each edge.
        expect(flaps.count).toBe(2);
        const step = 1 / segments;
        for (let i = 0; i < flaps.count; i++) {
            const t = flaps.target.subarray(i * 6, i * 6 + 6), s = flaps.source.subarray(i * 6, i * 6 + 6);
            const onLeft = t[0] < 0.5;
            // Drawn from the island's edge out into the gap: one column wide, past u = 0 or u = 1.
            expect(t[0]).toBeCloseTo(onLeft ? 0 : 1, 5);
            expect(t[4]).toBeCloseTo(onLeft ? -step : 1 + step, 5);
            // Read from the column on the far side of the seam.
            expect(s[0]).toBeCloseTo(onLeft ? 1 : 0, 5);
            expect(s[4]).toBeCloseTo(onLeft ? 1 - step : step, 5);
        }
        // Rectangles by the seam reach it; one in the middle of the picture does not.
        expect(reachesSeam(flaps, { x0: 0, y0: 100, x1: 4, y1: 120 }, 1024, 2)).toBe(true);
        expect(reachesSeam(flaps, { x0: 500, y0: 100, x1: 520, y1: 120 }, 1024, 8)).toBe(false);
    });

    it('cross the seams between a box\'s faces', () => {
        const part = partOf(new THREE.BoxGeometry(1, 1, 1));
        const flaps = seamFlaps(part, 1001);
        // Twelve edges, every one a seam (each face is its own island): a flap each side.
        expect(flaps.count).toBe(24);
    });
});
