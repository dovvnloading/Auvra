import * as THREE from 'three';
import type { PartMesh } from '../mesh/partMesh';

/**
 * DECALS WRAPPED ONTO THE MESH
 *
 * A decal is a picture laid on the surface round a point. Each vertex near the point gets a place on the
 * decal: how far from the point it lies along the surface, in two directions, worked out by walking out
 * over the mesh from the point (a discrete exponential map: each vertex reached is unfolded into the
 * plane from the vertices already placed round it, their frames carried along the surface as it bends).
 * So the picture wraps over curvature without stretching, and as the walk goes by where vertices sit (not
 * by their UVs), it runs on across UV seams. The GPU then reads the picture at each texel's place.
 */

interface Welded {
    /** For each vertex of the set, its welded vertex. */
    ids: Uint32Array;
    count: number;
    positions: Float64Array;
    normals: Float64Array;
    /** Neighbours of each welded vertex: `list` from `offsets[i]` to `offsets[i + 1]`. */
    offsets: Uint32Array;
    list: Uint32Array;
}

type WeldPart = Pick<PartMesh, 'positions' | 'normals' | 'indices'>;

const weldCache = new WeakMap<WeldPart, Welded>();

/** The set's vertices joined where they sit at the same place (split by UV seams or hard edges), with their neighbours. */
const weldOf = (part: WeldPart): Welded => {
    const cached = weldCache.get(part);
    if (cached) return cached;
    const { positions, normals, indices } = part;
    const vertexCount = positions.length / 3;
    const box = new THREE.Box3().setFromArray(positions);
    const eps = Math.max(1e-9, box.getSize(new THREE.Vector3()).length() * 1e-6);
    const keys = new Map<string, number>();
    const ids = new Uint32Array(vertexCount);
    const welded: number[] = [];
    for (let v = 0; v < vertexCount; v++) {
        const key = `${Math.round(positions[v * 3] / eps)},${Math.round(positions[v * 3 + 1] / eps)},${Math.round(positions[v * 3 + 2] / eps)}`;
        let id = keys.get(key);
        if (id === undefined) { id = welded.length; keys.set(key, id); welded.push(v); }
        ids[v] = id;
    }
    const count = welded.length;
    const weldedPositions = new Float64Array(count * 3);
    const weldedNormals = new Float64Array(count * 3);
    welded.forEach((v, id) => weldedPositions.set([positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]], id * 3));
    for (let v = 0; v < vertexCount; v++) for (let axis = 0; axis < 3; axis++) weldedNormals[ids[v] * 3 + axis] += normals[v * 3 + axis];
    for (let id = 0; id < count; id++) {
        const length = Math.hypot(weldedNormals[id * 3], weldedNormals[id * 3 + 1], weldedNormals[id * 3 + 2]) || 1;
        for (let axis = 0; axis < 3; axis++) weldedNormals[id * 3 + axis] /= length;
    }
    const sets: Array<Set<number>> = Array.from({ length: count }, () => new Set());
    for (let t = 0; t < indices.length / 3; t++) {
        const a = ids[indices[t * 3]], b = ids[indices[t * 3 + 1]], c = ids[indices[t * 3 + 2]];
        sets[a].add(b); sets[a].add(c); sets[b].add(a); sets[b].add(c); sets[c].add(a); sets[c].add(b);
    }
    const offsets = new Uint32Array(count + 1);
    for (let id = 0; id < count; id++) offsets[id + 1] = offsets[id] + sets[id].size - (sets[id].has(id) ? 1 : 0);
    const list = new Uint32Array(offsets[count]);
    sets.forEach((set, id) => { let at = offsets[id]; for (const other of set) if (other !== id) list[at++] = other; });
    const result = { ids, count, positions: weldedPositions, normals: weldedNormals, offsets, list };
    weldCache.set(part, result);
    return result;
};

/** A small binary heap of welded vertices by distance. */
class Heap {
    private readonly items: Array<[number, number]> = [];
    get size(): number { return this.items.length; }
    push(id: number, key: number): void {
        const items = this.items;
        items.push([key, id]);
        let i = items.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (items[parent][0] <= items[i][0]) break;
            [items[parent], items[i]] = [items[i], items[parent]];
            i = parent;
        }
    }
    pop(): [number, number] {
        const items = this.items;
        const top = items[0];
        const last = items.pop()!;
        if (items.length) {
            items[0] = last;
            let i = 0;
            for (;;) {
                const left = i * 2 + 1, right = left + 1;
                let smallest = i;
                if (left < items.length && items[left][0] < items[smallest][0]) smallest = left;
                if (right < items.length && items[right][0] < items[smallest][0]) smallest = right;
                if (smallest === i) break;
                [items[smallest], items[i]] = [items[i], items[smallest]];
                i = smallest;
            }
        }
        return top;
    }
}

export interface DecalStart {
    point: THREE.Vector3;
    normal: THREE.Vector3;
    /** The triangle the point lies on. */
    triangle: number;
}

/**
 * Each vertex's place on a decal laid at `start`: four numbers per vertex of the set, its distance along
 * the surface across (x, along `hint` laid on the surface) and up (y), 1 when it was reached, and 0.
 * Vertices further than `reach` along the surface are left unreached.
 */
export const decalCoordinates = (part: WeldPart, start: DecalStart, hint: THREE.Vector3, reach: number): Float32Array => {
    const weld = weldOf(part);
    const { count, positions, normals, offsets, list } = weld;
    const coords = new Float64Array(count * 2);
    const distance = new Float64Array(count).fill(Infinity);
    const frames = new Float64Array(count * 6);
    const done = new Uint8Array(count);
    const heap = new Heap();
    const candidates: Array<[number, number, number]> = [];
    const n0 = start.normal.clone().normalize();
    const t0 = hint.clone().addScaledVector(n0, -hint.dot(n0));
    // A hint along the normal says nothing: any way across will do.
    if (t0.lengthSq() < 1e-12) t0.crossVectors(n0, Math.abs(n0.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0));
    t0.normalize();
    const b0 = new THREE.Vector3().crossVectors(n0, t0);
    const normalOf = (id: number, out: THREE.Vector3) => out.set(normals[id * 3], normals[id * 3 + 1], normals[id * 3 + 2]);
    const positionOf = (id: number, out: THREE.Vector3) => out.set(positions[id * 3], positions[id * 3 + 1], positions[id * 3 + 2]);
    const turn = new THREE.Quaternion();
    const t = new THREE.Vector3(), b = new THREE.Vector3(), n = new THREE.Vector3(), from = new THREE.Vector3(), to = new THREE.Vector3(), d = new THREE.Vector3();
    /** A frame carried from normal `fromNormal` onto vertex `id` (turned the least way), kept for it. */
    const carry = (id: number, tangent: THREE.Vector3, fromNormal: THREE.Vector3) => {
        normalOf(id, n);
        turn.setFromUnitVectors(fromNormal, n);
        t.copy(tangent).applyQuaternion(turn);
        t.addScaledVector(n, -t.dot(n));
        if (t.lengthSq() < 1e-16) t.set(1, 0, 0).addScaledVector(n, -n.x);
        t.normalize();
        b.crossVectors(n, t);
        frames.set([t.x, t.y, t.z, b.x, b.y, b.z], id * 6);
    };
    // The corners of the triangle under the point start the walk, unfolded straight into its plane.
    for (let k = 0; k < 3; k++) {
        const id = weld.ids[part.indices[start.triangle * 3 + k]];
        positionOf(id, d).sub(start.point);
        coords[id * 2] = d.dot(t0);
        coords[id * 2 + 1] = d.dot(b0);
        distance[id] = Math.hypot(coords[id * 2], coords[id * 2 + 1]);
        carry(id, t0, n0);
        heap.push(id, distance[id]);
    }
    while (heap.size) {
        const [key, id] = heap.pop();
        if (done[id] || key > distance[id]) continue;
        done[id] = 1;
        if (distance[id] > reach) continue;
        for (let at = offsets[id]; at < offsets[id + 1]; at++) {
            const v = list[at];
            if (done[v]) continue;
            // Unfolded from every neighbour already placed, weighted by how near it is; where two fronts of the
            // walk meet (round the far side of a cylinder) only those agreeing with the nearest count.
            positionOf(v, to);
            candidates.length = 0;
            let nearest = -1, nearestLength = Infinity;
            for (let k = offsets[v]; k < offsets[v + 1]; k++) {
                const u = list[k];
                if (!done[u]) continue;
                positionOf(u, from);
                d.subVectors(to, from);
                const length = d.length();
                if (length < 1e-12) continue;
                candidates.push([
                    coords[u * 2] + d.x * frames[u * 6] + d.y * frames[u * 6 + 1] + d.z * frames[u * 6 + 2],
                    coords[u * 2 + 1] + d.x * frames[u * 6 + 3] + d.y * frames[u * 6 + 4] + d.z * frames[u * 6 + 5],
                    length,
                ]);
                if (length < nearestLength) { nearestLength = length; nearest = u; }
            }
            if (nearest < 0) continue;
            const reference = candidates.find((candidate) => candidate[2] === nearestLength)!;
            let x = 0, y = 0, weights = 0;
            for (const [cx, cy, length] of candidates) {
                if (Math.hypot(cx - reference[0], cy - reference[1]) > 1.5 * Math.max(length, nearestLength)) continue;
                x += cx / length;
                y += cy / length;
                weights += 1 / length;
            }
            x /= weights;
            y /= weights;
            const away = Math.hypot(x, y);
            if (away >= distance[v]) continue;
            coords[v * 2] = x;
            coords[v * 2 + 1] = y;
            distance[v] = away;
            // Its frame: the nearest placed neighbour's, carried over the bend between them.
            normalOf(nearest, from);
            carry(v, t.set(frames[nearest * 6], frames[nearest * 6 + 1], frames[nearest * 6 + 2]), from.clone());
            heap.push(v, away);
        }
    }
    const out = new Float32Array(weld.ids.length * 4);
    for (let vertex = 0; vertex < weld.ids.length; vertex++) {
        const id = weld.ids[vertex];
        if (!done[id] || distance[id] > reach) continue;
        out[vertex * 4] = coords[id * 2];
        out[vertex * 4 + 1] = coords[id * 2 + 1];
        out[vertex * 4 + 2] = 1;
    }
    return out;
};

/** The triangles a decal `width` × `height` across (turned by `angle`) can cover: every corner reached, and the triangle reaching into it. */
export const decalTriangles = (part: Pick<PartMesh, 'indices' | 'positions'>, coords: Float32Array, width: number, height: number, angle: number): number[] => {
    const triangles: number[] = [];
    const { positions } = part;
    /** A triangle whose places on the decal lie far further apart than its corners do (where two fronts met). */
    const torn = (tri: number): boolean => {
        for (let k = 0; k < 3; k++) {
            const a = part.indices[tri * 3 + k], b = part.indices[tri * 3 + ((k + 1) % 3)];
            const apart = Math.hypot(positions[a * 3] - positions[b * 3], positions[a * 3 + 1] - positions[b * 3 + 1], positions[a * 3 + 2] - positions[b * 3 + 2]);
            if (Math.hypot(coords[a * 4] - coords[b * 4], coords[a * 4 + 1] - coords[b * 4 + 1]) > 3 * apart + 1e-9) return true;
        }
        return false;
    };
    const cos = Math.cos(-angle), sin = Math.sin(-angle);
    for (let tri = 0; tri < part.indices.length / 3; tri++) {
        let reached = true;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let k = 0; k < 3; k++) {
            const v = part.indices[tri * 3 + k];
            if (coords[v * 4 + 2] < 0.5) { reached = false; break; }
            const x = coords[v * 4], y = coords[v * 4 + 1];
            const lx = (x * cos - y * sin) / width, ly = (x * sin + y * cos) / height;
            x0 = Math.min(x0, lx); x1 = Math.max(x1, lx); y0 = Math.min(y0, ly); y1 = Math.max(y1, ly);
        }
        if (reached && x1 >= -0.5 && x0 <= 0.5 && y1 >= -0.5 && y0 <= 0.5 && !torn(tri)) triangles.push(tri);
    }
    return triangles;
};
