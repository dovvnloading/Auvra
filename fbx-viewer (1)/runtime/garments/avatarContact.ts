import { AvatarSurfaceFeatures, type SurfaceFeatureStats } from './avatarFeatureContact';
import { dot, sub, triangleWeights, type Barycentric, type Point } from './contactGeometry';

/** An oriented proxy in the cloth simulation frame. Both buffers describe the same
 * vertex ordering; the indices for a topology are immutable. Faces point outward. */
export interface GarmentAvatarSurface {
    positions: Float32Array;
    previousPositions: Float32Array;
    indices: Uint32Array | Uint16Array;
}

export const AVATAR_CONTACT_LIMITS = Object.freeze({
    vertices: 4096, triangles: 8192, nodeVisits: 240000, featurePairs: 40000,
    surfaceNodeVisits: 360000, surfaceFeaturePairs: 60000,
});

export interface AvatarContactStats extends SurfaceFeatureStats {
    vertexPhaseLimited: boolean;
    nodeVisits: number;
    testedFeatures: number;
    /** Primary cloth-vertex corrections. Edge and reciprocal counters are reported separately. */
    corrections: number;
    limited: boolean;
    invalid: boolean;
}

type Triangle = [Point, Point, Point];
type Friction = (j: number, nx: number, ny: number, nz: number, correction: number,
    bodyX: number, bodyY: number, bodyZ: number) => void;
interface Node { lo: Point; hi: Point; left: number; right: number; face: number }

const cross = (a: Point, b: Point): Point => [
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
const interpolate = (a: Point, b: Point, t: number): Point => [
    a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2]),
];
function normal(face: Triangle): Point | null {
    const n = cross(sub(face[1], face[0]), sub(face[2], face[0]));
    const len = Math.sqrt(dot(n, n));
    return len > 1e-12 ? [n[0] / len, n[1] / len, n[2] / len] : null;
}
function anchor(f: Triangle, w: Barycentric): Point {
    return [w[0] * f[0][0] + w[1] * f[1][0] + w[2] * f[2][0],
    w[0] * f[0][1] + w[1] * f[1][1] + w[2] * f[2][1],
    w[0] * f[0][2] + w[1] * f[1][2] + w[2] * f[2][2]];
}

interface Contact { weights: Barycentric; normal: Point; correction: number }

/** With linearly moving vertices, oriented point/triangle volume is cubic in time.
 * Split at its derivative's roots and isolate front-to-back crossings on monotonic
 * intervals. At a crossing, the closest point must lie on the moving finite face. */
function crossing(p: Point, q: Point, start: Triangle, end: Triangle, gap: number): Contact | null {
    const r0 = sub(p, start[0]), dr = sub(sub(q, end[0]), r0);
    const u0 = sub(start[1], start[0]), du = sub(sub(end[1], end[0]), u0);
    const v0 = sub(start[2], start[0]), dv = sub(sub(end[2], end[0]), v0);
    const n0 = cross(u0, v0), n2 = cross(du, dv), left = cross(du, v0), right = cross(u0, dv);
    const n1: Point = [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
    const c0 = dot(r0, n0), c1 = dot(dr, n0) + dot(r0, n1);
    const c2 = dot(dr, n1) + dot(r0, n2), c3 = dot(dr, n2);
    const value = (t: number) => ((c3 * t + c2) * t + c1) * t + c0;
    const splits = [0, 1];
    const insert = (t: number) => { if (t > 0 && t < 1) splits.push(t); };
    if (Math.abs(c3) > 1e-18) {
        const disc = c2 * c2 - 3 * c3 * c1;
        if (disc > 0) {
            const root = Math.sqrt(disc);
            insert((-c2 - root) / (3 * c3)); insert((-c2 + root) / (3 * c3));
        }
    } else if (Math.abs(c2) > 1e-18) insert(-c1 / (2 * c2));
    splits.sort((a, b) => a - b);
    for (let i = 1; i < splits.length; i++) {
        let lo = splits[i - 1], hi = splits[i];
        if (value(lo) < 0 || value(hi) >= 0) continue;
        for (let it = 0; it < 32; it++) {
            const mid = (lo + hi) / 2;
            if (value(mid) >= 0) lo = mid; else hi = mid;
        }
        const hit = interpolate(p, q, hi);
        const face: Triangle = [interpolate(start[0], end[0], hi), interpolate(start[1], end[1], hi), interpolate(start[2], end[2], hi)];
        if (!normal(face)) continue;
        const w = triangleWeights(hit, ...face);
        if (!w) continue;
        const diff = sub(hit, anchor(face, w));
        if (dot(diff, diff) > 1e-12) continue;
        const n = normal(end);
        if (!n) continue;
        const correction = gap - dot(sub(q, anchor(end, w)), n);
        if (correction > 0) return { weights: w, normal: n, correction };
    }
    return null;
}

/** Closest-feature shell at the endpoint. A shallow inside point can recover on
 * the adjacent outward face. A distant back-face point does not attract the cloth. */
function shell(q: Point, f: Triangle, gap: number): Contact | null {
    const w = triangleWeights(q, ...f);
    if (!w) return null;
    const diff = sub(q, anchor(f, w)), dist2 = dot(diff, diff);
    if (dist2 >= gap * gap) return null;
    const faceNormal = normal(f);
    if (!faceNormal) return null;
    const distance = Math.sqrt(dist2), signed = dot(diff, faceNormal);
    if (signed > 0 && distance > 1e-12) {
        return { weights: w, normal: [diff[0] / distance, diff[1] / distance, diff[2] / distance], correction: gap - distance };
    }
    return { weights: w, normal: faceNormal, correction: gap - signed };
}

/** Kinematic collision against a bounded, animated triangle proxy. With cooked cloth topology,
 * oriented vertex/face tests are complemented by two-sided reciprocal vertex/face and
 * interior edge/edge constraints. The feature counters expose any exhausted budget.
 * Coplanar nonparallel segments use endpoint entry events. Parallel/coincident edges,
 * degenerate faces and deep initial intersections need suitable starting clearance. */
export class GarmentAvatarContact {
    readonly stats: AvatarContactStats = {
        nodeVisits: 0, testedFeatures: 0, corrections: 0, limited: false, invalid: false, vertexPhaseLimited: false,
        testedEdges: 0, testedBodyVertices: 0, edgeCorrections: 0, bodyVertexCorrections: 0,
        featurePairsLimited: false, featureNodesLimited: false, featureNodeVisits: 0,
    };
    private readonly surface: AvatarSurfaceFeatures | null;
    private sourceIndices?: GarmentAvatarSurface['indices'];
    private readonly nodes: Node[] = [];
    private readonly stack: number[] = [];
    private start = new Float32Array();
    private end = new Float32Array();
    private valid = false;
    constructor(private readonly inverseMass: Float64Array,
        private readonly maxFeatures: number = AVATAR_CONTACT_LIMITS.featurePairs,
        private readonly maxVisits: number = AVATAR_CONTACT_LIMITS.nodeVisits,
        clothIndices?: Uint32Array,
        private readonly maxSurfacePairs: number = AVATAR_CONTACT_LIMITS.surfaceFeaturePairs,
        private readonly maxSurfaceVisits: number = AVATAR_CONTACT_LIMITS.surfaceNodeVisits) {
        this.surface = clothIndices ? new AvatarSurfaceFeatures(clothIndices, inverseMass) : null;
    }

    prepare(surface: GarmentAvatarSurface, from = 0, to = 1, continuePrevious = false): boolean {
        const wasValid = this.valid;
        const { positions, previousPositions, indices } = surface;
        Object.assign(this.stats, {
            nodeVisits: 0, testedFeatures: 0, corrections: 0, limited: false, invalid: false,
            vertexPhaseLimited: false, testedEdges: 0, testedBodyVertices: 0, edgeCorrections: 0, bodyVertexCorrections: 0,
            featurePairsLimited: false, featureNodesLimited: false, featureNodeVisits: 0
        });
        this.valid = false;
        if (positions.length > AVATAR_CONTACT_LIMITS.vertices * 3 || indices.length > AVATAR_CONTACT_LIMITS.triangles * 3) {
            this.stats.limited = true;
            return false;
        }
        if (positions.length !== previousPositions.length || !positions.length || positions.length % 3 || indices.length % 3 || !indices.length) {
            this.stats.invalid = true;
            return false;
        }
        if (this.start.length !== positions.length) {
            this.start = new Float32Array(positions.length);
            this.end = new Float32Array(positions.length);
            this.sourceIndices = undefined;
        }
        const continueTick = continuePrevious && wasValid && indices === this.sourceIndices;
        for (let i = 0; i < positions.length; i++) {
            const a = previousPositions[i], b = positions[i];
            if (!Number.isFinite(a) || !Number.isFinite(b)) { this.stats.invalid = true; return false; }
            this.start[i] = continueTick ? this.end[i] : a + from * (b - a);
            this.end[i] = a + to * (b - a);
        }
        if (indices !== this.sourceIndices) {
            if (indices.some(i => i >= positions.length / 3)) { this.stats.invalid = true; return false; }
            this.build(indices);
            this.sourceIndices = indices;
        }
        this.refit(indices);
        this.valid = true;
        return true;
    }

    private build(indices: GarmentAvatarSurface['indices']): void {
        this.nodes.length = 0;
        const centers: Point[] = Array.from({ length: indices.length / 3 }, (_, t) => {
            const a = 3 * indices[3 * t], b = 3 * indices[3 * t + 1], c = 3 * indices[3 * t + 2], p = this.end;
            return [(p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3];
        });
        const split = (faces: number[]): number => {
            const slot = this.nodes.length;
            const node: Node = { lo: [0, 0, 0], hi: [0, 0, 0], left: -1, right: -1, face: -1 };
            this.nodes.push(node);
            if (faces.length === 1) { node.face = faces[0]; return slot; }
            const lo: Point = [Infinity, Infinity, Infinity], hi: Point = [-Infinity, -Infinity, -Infinity];
            for (const face of faces) for (let j = 0; j < 3; j++) {
                lo[j] = Math.min(lo[j], centers[face][j]); hi[j] = Math.max(hi[j], centers[face][j]);
            }
            const extent = sub(hi, lo);
            const axis = extent[0] >= extent[1] && extent[0] >= extent[2] ? 0 : extent[1] >= extent[2] ? 1 : 2;
            faces.sort((a, b) => centers[a][axis] - centers[b][axis] || a - b);
            const mid = faces.length >> 1;
            node.left = split(faces.slice(0, mid));
            node.right = split(faces.slice(mid));
            return slot;
        };
        split(centers.map((_, i) => i));
    }

    private refit(indices: GarmentAvatarSurface['indices']): void {
        for (let i = this.nodes.length - 1; i >= 0; i--) {
            const n = this.nodes[i];
            if (n.face < 0) {
                const a = this.nodes[n.left], b = this.nodes[n.right];
                for (let j = 0; j < 3; j++) { n.lo[j] = Math.min(a.lo[j], b.lo[j]); n.hi[j] = Math.max(a.hi[j], b.hi[j]); }
            } else {
                const f = n.face * 3, a = 3 * indices[f], b = 3 * indices[f + 1], c = 3 * indices[f + 2];
                for (let j = 0; j < 3; j++) {
                    n.lo[j] = Math.min(this.start[a + j], this.start[b + j], this.start[c + j], this.end[a + j], this.end[b + j], this.end[c + j]);
                    n.hi[j] = Math.max(this.start[a + j], this.start[b + j], this.start[c + j], this.end[a + j], this.end[b + j], this.end[c + j]);
                }
            }
        }
    }

    private triangle(buffer: Float32Array, face: number): Triangle {
        const ids = this.sourceIndices!, k = 3 * face;
        const get = (i: number): Point => [buffer[3 * i], buffer[3 * i + 1], buffer[3 * i + 2]];
        return [get(ids[k]), get(ids[k + 1]), get(ids[k + 2])];
    }

    /** Traverses the refitted swept avatar BVH; the supplemental contact budget is
     * independent from primary particle contacts so a crowded layer can degrade visibly. */
    private querySurface(lo: Point, hi: Point, visit: (face: number) => boolean): boolean {
        this.stack.length = 0;
        this.stack.push(0);
        while (this.stack.length) {
            if (this.stats.featureNodeVisits >= this.maxSurfaceVisits) {
                this.stats.featureNodesLimited = true;
                return false;
            }
            this.stats.featureNodeVisits++;
            const n = this.nodes[this.stack.pop()!];
            if (n.lo[0] > hi[0] || n.hi[0] < lo[0] || n.lo[1] > hi[1] || n.hi[1] < lo[1] || n.lo[2] > hi[2] || n.hi[2] < lo[2]) continue;
            if (n.face < 0) this.stack.push(n.right, n.left);
            else if (!visit(n.face)) return false;
        }
        return true;
    }

    solve(start: Float32Array, end: Float32Array, gap: number, friction: Friction): void {
        if (!this.valid) return;
        if (!this.stats.vertexPhaseLimited) this.projectVertices(start, end, gap, friction);
        if (this.surface && !this.stats.featurePairsLimited && !this.stats.featureNodesLimited) {
            this.surface.project(start, end, gap, this.start, this.end, this.sourceIndices!,
                (lo, hi, visit) => this.querySurface(lo, hi, visit), friction, this.stats, this.maxSurfacePairs);
        }
        this.stats.limited = this.stats.vertexPhaseLimited || this.stats.featurePairsLimited || this.stats.featureNodesLimited;
    }

    private projectVertices(start: Float32Array, end: Float32Array, gap: number, friction: Friction): void {
        for (let i = 0; i < this.inverseMass.length; i++) {
            if (this.inverseMass[i] === 0) continue;
            const k = 3 * i;
            const p: Point = [start[k], start[k + 1], start[k + 2]], q: Point = [end[k], end[k + 1], end[k + 2]];
            const lo: Point = [0, 0, 0], hi: Point = [0, 0, 0];
            for (let j = 0; j < 3; j++) { lo[j] = Math.min(p[j], q[j]) - gap; hi[j] = Math.max(p[j], q[j]) + gap; }
            this.stack.length = 0;
            this.stack.push(0);
            while (this.stack.length) {
                if (this.stats.nodeVisits >= this.maxVisits) { this.stats.vertexPhaseLimited = true; return; }
                this.stats.nodeVisits++;
                const n = this.nodes[this.stack.pop()!];
                if (n.lo[0] > hi[0] || n.hi[0] < lo[0] || n.lo[1] > hi[1] || n.hi[1] < lo[1] || n.lo[2] > hi[2] || n.hi[2] < lo[2]) continue;
                if (n.face < 0) { this.stack.push(n.right, n.left); continue; }
                if (this.stats.testedFeatures >= this.maxFeatures) { this.stats.vertexPhaseLimited = true; return; }
                this.stats.testedFeatures++;
                const a = this.triangle(this.start, n.face), b = this.triangle(this.end, n.face);
                const hit = crossing(p, q, a, b, gap) ?? shell(q, b, gap);
                if (!hit) continue;
                const [nx, ny, nz] = hit.normal;
                q[0] += hit.correction * nx; q[1] += hit.correction * ny; q[2] += hit.correction * nz;
                end[k] = q[0]; end[k + 1] = q[1]; end[k + 2] = q[2];
                const bodyMotion = sub(anchor(b, hit.weights), anchor(a, hit.weights));
                friction(k, nx, ny, nz, hit.correction, ...bodyMotion);
                this.stats.corrections++;
            }
        }
    }
}
