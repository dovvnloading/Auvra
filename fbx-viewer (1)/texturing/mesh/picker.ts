import * as THREE from 'three';
import { BOUNDS_FLOATS, NODE_FLOATS, buildBvh, closestPrimitive, type Bvh } from '../../runtime/raytracing/bvh';
import type { PartMesh } from './partMesh';

/**
 * Finding the point of a texture set's surface under the pointer, on the CPU, and the triangles a brush
 * dab can reach (so only their part of the pictures is drawn again).
 */

/**
 * A copy of the surface a brush paints with: mirrored across the model's middle on some axes (a sign per
 * axis, 1 keeps, -1 mirrors, and the middle), or moved by any `matrix` (16 numbers, column by column),
 * which then takes the place of the signs.
 */
export interface Mirror { signs: readonly [number, number, number]; centre: readonly [number, number, number]; matrix?: readonly number[] }

/** A point moved by a 4 × 4 matrix (16 numbers, column by column). */
const moved = (m: readonly number[], x: number, y: number, z: number): [number, number, number] => [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
];

export const NO_MIRROR: Mirror = { signs: [1, 1, 1], centre: [0, 0, 0] };

/** Screen place of a model-space point (pixels from the top left), or null behind the eye. */
const toScreen = (m: ArrayLike<number>, x: number, y: number, z: number, width: number, height: number): [number, number] | null => {
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w <= 1e-6) return null;
    const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    const cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    return [(cx * 0.5 + 0.5) * width, (0.5 - cy * 0.5) * height];
};

/** A box worked on in place while walking the tree (so a query makes no garbage per node). */
const PaintPickerBoxes = {
    min: [0, 0, 0] as [number, number, number],
    max: [0, 0, 0] as [number, number, number],
    copy(min: readonly number[], max: readonly number[]): void {
        this.min[0] = min[0]; this.min[1] = min[1]; this.min[2] = min[2];
        this.max[0] = max[0]; this.max[1] = max[1]; this.max[2] = max[2];
    },
};

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

    /**
     * Visits every triangle whose box passes `boxTest` (given a box's lowest and highest corner), walking the
     * tree so whole branches that fail are skipped.
     */
    private visitBoxes(boxTest: (min: [number, number, number], max: [number, number, number]) => boolean, visit: (triangle: number) => void): void {
        const { nodes, order } = this.bvh;
        const min: [number, number, number] = [0, 0, 0];
        const max: [number, number, number] = [0, 0, 0];
        const stack = [0];
        while (stack.length) {
            const node = stack.pop()!;
            const offset = node * NODE_FLOATS;
            min[0] = nodes[offset]; min[1] = nodes[offset + 1]; min[2] = nodes[offset + 2];
            max[0] = nodes[offset + 4]; max[1] = nodes[offset + 5]; max[2] = nodes[offset + 6];
            if (!boxTest(min, max)) continue;
            const count = nodes[offset + 7];
            if (count !== 0) {
                const first = nodes[offset + 3];
                for (let at = first; at < first + count; at++) visit(order[at]);
                continue;
            }
            const left = nodes[offset + 3];
            stack.push(left, left + 1);
        }
    }

    /** A box mirrored: its corners reflected across the middle on the mirrored axes. */
    private static mirrorBox(min: [number, number, number], max: [number, number, number], mirror: Mirror): void {
        if (mirror.matrix) {
            // The box round the moved corners.
            const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => moved(mirror.matrix!, k & 1 ? max[0] : min[0], k & 2 ? max[1] : min[1], k & 4 ? max[2] : min[2]));
            for (let axis = 0; axis < 3; axis++) {
                min[axis] = Math.min(...corners.map((corner) => corner[axis]));
                max[axis] = Math.max(...corners.map((corner) => corner[axis]));
            }
            return;
        }
        for (let axis = 0; axis < 3; axis++) {
            if (mirror.signs[axis] > 0) continue;
            const low = 2 * mirror.centre[axis] - max[axis];
            const high = 2 * mirror.centre[axis] - min[axis];
            min[axis] = low;
            max[axis] = high;
        }
    }

    /** Every triangle that may come within `radius` of `point` once mirrored by `mirror` (its box does). */
    trianglesNear(point: THREE.Vector3, radius: number, mirror: Mirror, visit: (triangle: number) => void): void {
        const { positions, indices } = this.part;
        const near = (min: [number, number, number], max: [number, number, number]) => {
            PaintPickerBoxes.copy(min, max);
            SurfacePicker.mirrorBox(PaintPickerBoxes.min, PaintPickerBoxes.max, mirror);
            const dx = Math.max(PaintPickerBoxes.min[0] - point.x, 0, point.x - PaintPickerBoxes.max[0]);
            const dy = Math.max(PaintPickerBoxes.min[1] - point.y, 0, point.y - PaintPickerBoxes.max[1]);
            const dz = Math.max(PaintPickerBoxes.min[2] - point.z, 0, point.z - PaintPickerBoxes.max[2]);
            return dx * dx + dy * dy + dz * dz <= radius * radius;
        };
        this.visitBoxes(near, (triangle) => {
            const min: [number, number, number] = [Infinity, Infinity, Infinity];
            const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
            for (let k = 0; k < 3; k++) {
                const v = indices[triangle * 3 + k] * 3;
                for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], positions[v + axis]); max[axis] = Math.max(max[axis], positions[v + axis]); }
            }
            if (near(min, max)) visit(triangle);
        });
    }

    /**
     * Every triangle that may fall within a box on the screen (pixels from the top left) once mirrored by
     * `mirror`, seen through `viewProjection` on a view of `width` × `height`. Boxes reaching behind the eye
     * count as reaching it (they may).
     */
    trianglesOnScreen(viewProjection: THREE.Matrix4, width: number, height: number, area: { x0: number; y0: number; x1: number; y1: number }, mirror: Mirror, visit: (triangle: number) => void): void {
        const m = viewProjection.elements;
        const { positions, indices } = this.part;
        const reaches = (corners: Array<[number, number, number]>) => {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const [x, y, z] of corners) {
                const at = toScreen(m, x, y, z, width, height);
                if (!at) return true;
                minX = Math.min(minX, at[0]); maxX = Math.max(maxX, at[0]);
                minY = Math.min(minY, at[1]); maxY = Math.max(maxY, at[1]);
            }
            return maxX >= area.x0 && minX <= area.x1 && maxY >= area.y0 && minY <= area.y1;
        };
        const boxCorners = (min: [number, number, number], max: [number, number, number]): Array<[number, number, number]> => {
            PaintPickerBoxes.copy(min, max);
            SurfacePicker.mirrorBox(PaintPickerBoxes.min, PaintPickerBoxes.max, mirror);
            const [a, b] = [PaintPickerBoxes.min, PaintPickerBoxes.max];
            return [[a[0], a[1], a[2]], [b[0], a[1], a[2]], [a[0], b[1], a[2]], [b[0], b[1], a[2]], [a[0], a[1], b[2]], [b[0], a[1], b[2]], [a[0], b[1], b[2]], [b[0], b[1], b[2]]];
        };
        this.visitBoxes((min, max) => reaches(boxCorners(min, max)), (triangle) => {
            const corners: Array<[number, number, number]> = [0, 1, 2].map((k) => {
                const v = indices[triangle * 3 + k] * 3;
                if (mirror.matrix) return moved(mirror.matrix, positions[v], positions[v + 1], positions[v + 2]);
                return [0, 1, 2].map((axis) => (mirror.signs[axis] > 0 ? positions[v + axis] : 2 * mirror.centre[axis] - positions[v + axis])) as [number, number, number];
            });
            if (reaches(corners)) visit(triangle);
        });
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
