import * as THREE from 'three';
import { BOUNDS_FLOATS, buildBvh, closestPrimitive, type Bvh } from '../../runtime/raytracing/bvh';
import type { PartMesh } from './partMesh';

/** Finding the point of a texture set's surface under the pointer, on the CPU. */

export interface SurfaceHit {
    point: THREE.Vector3;
    /** The surface's smooth normal there. */
    normal: THREE.Vector3;
    triangle: number;
    uv: THREE.Vector2;
    distance: number;
}

export class SurfacePicker {
    private readonly bvh: Bvh;

    constructor(private readonly part: PartMesh) {
        const count = part.indices.length / 3;
        const bounds = new Float32Array(count * BOUNDS_FLOATS);
        for (let t = 0; t < count; t++) {
            const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
            for (let k = 0; k < 3; k++) {
                const v = part.indices[t * 3 + k] * 3;
                for (let axis = 0; axis < 3; axis++) {
                    box[axis] = Math.min(box[axis], part.positions[v + axis]);
                    box[axis + 3] = Math.max(box[axis + 3], part.positions[v + axis]);
                }
            }
            bounds.set(box, t * BOUNDS_FLOATS);
        }
        this.bvh = buildBvh(bounds, count);
    }

    /** The nearest point of the surface along a ray in the model's space. */
    cast(origin: THREE.Vector3, rayDirection: THREE.Vector3): SurfaceHit | null {
        const { positions, indices } = this.part;
        // A ray exactly along an axis would meet a box face as zero times infinity: lean it a hair.
        const direction = new THREE.Vector3(rayDirection.x || 1e-12, rayDirection.y || 1e-12, rayDirection.z || 1e-12);
        let bestU = 0;
        let bestV = 0;
        const result = closestPrimitive(this.bvh, [origin.x, origin.y, origin.z], [direction.x, direction.y, direction.z], (triangle, limit) => {
            const a = indices[triangle * 3] * 3;
            const b = indices[triangle * 3 + 1] * 3;
            const c = indices[triangle * 3 + 2] * 3;
            const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2];
            const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2];
            const px = direction.y * e2z - direction.z * e2y;
            const py = direction.z * e2x - direction.x * e2z;
            const pz = direction.x * e2y - direction.y * e2x;
            const det = e1x * px + e1y * py + e1z * pz;
            if (Math.abs(det) < 1e-14) return Infinity;
            const inv = 1 / det;
            const sx = origin.x - positions[a], sy = origin.y - positions[a + 1], sz = origin.z - positions[a + 2];
            const u = (sx * px + sy * py + sz * pz) * inv;
            if (u < 0 || u > 1) return Infinity;
            const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
            const v = (direction.x * qx + direction.y * qy + direction.z * qz) * inv;
            if (v < 0 || u + v > 1) return Infinity;
            const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
            if (t <= 1e-9 || t >= limit) return Infinity;
            bestU = u;
            bestV = v;
            return t;
        });
        if (result.primitive < 0) return null;
        const triangle = result.primitive;
        // Barycentrics of the closest: work them out again for it (the last tested may not be it).
        this.barycentric(triangle, origin, direction, result.distance, (u, v) => { bestU = u; bestV = v; });
        const w = 1 - bestU - bestV;
        const corners = [0, 1, 2].map((k) => indices[triangle * 3 + k]);
        const point = origin.clone().addScaledVector(direction, result.distance);
        const normal = new THREE.Vector3();
        const uv = new THREE.Vector2();
        [w, bestU, bestV].forEach((weight, k) => {
            normal.x += this.part.normals[corners[k] * 3] * weight;
            normal.y += this.part.normals[corners[k] * 3 + 1] * weight;
            normal.z += this.part.normals[corners[k] * 3 + 2] * weight;
            uv.x += this.part.uvs[corners[k] * 2] * weight;
            uv.y += this.part.uvs[corners[k] * 2 + 1] * weight;
        });
        return { point, normal: normal.normalize(), triangle, uv, distance: result.distance };
    }

    private barycentric(triangle: number, origin: THREE.Vector3, direction: THREE.Vector3, distance: number, done: (u: number, v: number) => void): void {
        const { positions, indices } = this.part;
        const p = origin.clone().addScaledVector(direction, distance);
        const a = new THREE.Vector3().fromArray(positions, indices[triangle * 3] * 3);
        const b = new THREE.Vector3().fromArray(positions, indices[triangle * 3 + 1] * 3);
        const c = new THREE.Vector3().fromArray(positions, indices[triangle * 3 + 2] * 3);
        const out = new THREE.Vector3();
        THREE.Triangle.getBarycoord(p, a, b, c, out);
        done(out.y, out.z);
    }
}
