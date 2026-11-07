import * as THREE from 'three';
import type { PartMesh } from '../mesh/partMesh';
import { closestOnTriangle, type SurfacePicker } from '../mesh/picker';

/**
 * Where a point of a UV tile lies on the model: the triangle under it, the surface point and normal, the
 * way the tile's U and V run over the surface there, and how many model units one UV unit spans. The 2D
 * painting view uses it to send its dabs' mirrored and turned copies to the places on the model the 3D
 * view would.
 */

export interface UvSurfacePoint {
    triangle: number;
    point: THREE.Vector3;
    normal: THREE.Vector3;
    /** How the surface moves as U grows, and as V grows (model units per UV unit). */
    alongU: THREE.Vector3;
    alongV: THREE.Vector3;
    /** Model units one UV unit spans on this triangle (the square root of their areas' ratio). */
    scale: number;
}

type UvSurfacePart = Pick<PartMesh, 'positions' | 'normals' | 'uvs' | 'indices' | 'triangleTile' | 'triangleShift'>;

const GRID = 64;

/** The triangles of one tile, filed in a grid over the tile by the boxes their UVs cover. */
export class UvSurfaceLookup {
    private readonly cells: number[][] = Array.from({ length: GRID * GRID }, () => []);

    constructor(private readonly part: UvSurfacePart, readonly tile: number) {
        const { indices, uvs, triangleTile, triangleShift } = part;
        const cell = (value: number) => Math.min(GRID - 1, Math.max(0, Math.floor(value * GRID)));
        for (let t = 0; t < indices.length / 3; t++) {
            if (triangleTile[t] !== tile) continue;
            let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
            for (let k = 0; k < 3; k++) {
                const vertex = indices[t * 3 + k];
                const u = uvs[vertex * 2] - triangleShift[t * 2];
                const v = uvs[vertex * 2 + 1] - triangleShift[t * 2 + 1];
                u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
            }
            for (let y = cell(v0); y <= cell(v1); y++) for (let x = cell(u0); x <= cell(u1); x++) this.cells[y * GRID + x].push(t);
        }
    }

    /** The surface under a point of the tile (its own UVs, 0 to 1), or null where no triangle lies. */
    at(u: number, v: number): UvSurfacePoint | null {
        if (u < 0 || u > 1 || v < 0 || v > 1) return null;
        const { positions, normals, indices, uvs, triangleShift } = this.part;
        const list = this.cells[Math.min(GRID - 1, Math.floor(v * GRID)) * GRID + Math.min(GRID - 1, Math.floor(u * GRID))];
        for (const t of list) {
            const [a, b, c] = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
            const su = triangleShift[t * 2], sv = triangleShift[t * 2 + 1];
            const ax = uvs[a * 2] - su, ay = uvs[a * 2 + 1] - sv;
            const bx = uvs[b * 2] - su, by = uvs[b * 2 + 1] - sv;
            const cx = uvs[c * 2] - su, cy = uvs[c * 2 + 1] - sv;
            const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
            if (Math.abs(d) < 1e-14) continue;
            const l1 = ((by - cy) * (u - cx) + (cx - bx) * (v - cy)) / d;
            const l2 = ((cy - ay) * (u - cx) + (ax - cx) * (v - cy)) / d;
            const l3 = 1 - l1 - l2;
            if (l1 < -1e-7 || l2 < -1e-7 || l3 < -1e-7) continue;
            const corner = (source: Float32Array, vertex: number) => new THREE.Vector3(source[vertex * 3], source[vertex * 3 + 1], source[vertex * 3 + 2]);
            const pa = corner(positions, a), pb = corner(positions, b), pc = corner(positions, c);
            const point = pa.clone().multiplyScalar(l1).addScaledVector(pb, l2).addScaledVector(pc, l3);
            const normal = corner(normals, a).multiplyScalar(l1).addScaledVector(corner(normals, b), l2).addScaledVector(corner(normals, c), l3).normalize();
            // How position changes with U and V over the triangle.
            const e1 = pb.clone().sub(pa), e2 = pc.clone().sub(pa);
            const du1 = bx - ax, dv1 = by - ay, du2 = cx - ax, dv2 = cy - ay;
            const r = 1 / (du1 * dv2 - du2 * dv1);
            const alongU = e1.clone().multiplyScalar(dv2).addScaledVector(e2, -dv1).multiplyScalar(r);
            const alongV = e2.clone().multiplyScalar(du1).addScaledVector(e1, -du2).multiplyScalar(r);
            const areaModel = e1.clone().cross(e2).length();
            const scale = Math.sqrt(areaModel / Math.abs(du1 * dv2 - du2 * dv1));
            return { triangle: t, point, normal, alongU, alongV, scale };
        }
        return null;
    }
}

/**
 * Where a point on (or near) the surface lies on the UV layout: its tile, its place in the tile, and the
 * UV island it is on; null when no triangle comes within `reach` of it.
 */
export const layoutPlaceOf = (part: Pick<PartMesh, 'positions' | 'uvs' | 'indices' | 'triangleTile' | 'triangleShift' | 'triangleIsland'>, picker: SurfacePicker, point: THREE.Vector3, reach: number): { tile: number; u: number; v: number; island: number } | null => {
    const near = picker.nearest(point, reach);
    if (!near) return null;
    const t = near.triangle;
    const corner = (k: number) => part.indices[t * 3 + k];
    const p = (v: number, axis: number) => part.positions[v * 3 + axis];
    const [a, b, c] = [corner(0), corner(1), corner(2)];
    const { w } = closestOnTriangle(near.point.x, near.point.y, near.point.z, p(a, 0), p(a, 1), p(a, 2), p(b, 0), p(b, 1), p(b, 2), p(c, 0), p(c, 1), p(c, 2));
    const u = w[0] * part.uvs[a * 2] + w[1] * part.uvs[b * 2] + w[2] * part.uvs[c * 2] - part.triangleShift[t * 2];
    const v = w[0] * part.uvs[a * 2 + 1] + w[1] * part.uvs[b * 2 + 1] + w[2] * part.uvs[c * 2 + 1] - part.triangleShift[t * 2 + 1];
    return { tile: part.triangleTile[t], u, v, island: part.triangleIsland[t] };
};
