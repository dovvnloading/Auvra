import { PinCorrectionBudget, dot, segmentWeights, sub, triangleWeights, type Barycentric, type Point } from './contactGeometry';

export type FeatureTriangle = [Point, Point, Point];
type Segment = [Point, Point];
type Bounds = { lo: Point; hi: Point };
export type FeatureQuery = (lo: Point, hi: Point, visit: (face: number) => boolean) => boolean;
export type ContactFriction = (j: number, nx: number, ny: number, nz: number, correction: number,
    bx: number, by: number, bz: number) => void;

export interface SurfaceFeatureStats {
    testedEdges: number;
    testedBodyVertices: number;
    edgeCorrections: number;
    bodyVertexCorrections: number;
    /** Contact constraints blocked or truncated by prescribed pins, counted per projection attempt. */
    pinLimitedFeatures: number;
    featurePairsLimited: boolean;
    featureNodesLimited: boolean;
    featureNodeVisits: number;
}

const cross = (a: Point, b: Point): Point => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const point = (buffer: Float32Array, i: number): Point => [buffer[3 * i], buffer[3 * i + 1], buffer[3 * i + 2]];
const lerp = (a: Point, b: Point, t: number): Point => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
const negate = (p: Point): Point => [-p[0], -p[1], -p[2]];
const len = (p: Point) => Math.sqrt(dot(p, p));
function unit(p: Point): Point | null {
    const l = len(p);
    return l > 1e-12 ? [p[0] / l, p[1] / l, p[2] / l] : null;
}
function anchored(face: FeatureTriangle, weights: Barycentric): Point {
    return [0, 1, 2].map(j => weights[0] * face[0][j] + weights[1] * face[1][j] + weights[2] * face[2][j]) as Point;
}
function faceNormal(tri: FeatureTriangle): Point | null {
    return unit(cross(sub(tri[1], tri[0]), sub(tri[2], tri[0])));
}

/** Roots of the scalar triple product of three linearly varying differences.
 * The three vectors can describe either four moving edge endpoints or a vertex
 * relative to a moving triangle. Cubic extrema delimit monotonic intervals. */
function coplanarityRoots(r: Point, dr: Point, u: Point, du: Point, v: Point, dv: Point): number[] {
    const n0 = cross(u, v), n2 = cross(du, dv), l = cross(du, v), h = cross(u, dv);
    const n1: Point = [l[0] + h[0], l[1] + h[1], l[2] + h[2]];
    const a = dot(dr, n2), b = dot(dr, n1) + dot(r, n2), c = dot(dr, n0) + dot(r, n1), d = dot(r, n0);
    const magnitude = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
    if (magnitude === 0) return []; // Persistent coplanarity uses endpoint shell contact.
    const tolerance = magnitude * 1e-13, split = [0, 1], roots: number[] = [];
    const addSplit = (t: number) => { if (t > 0 && t < 1) split.push(t); };
    if (Math.abs(a) > tolerance) {
        const disc = b * b - 3 * a * c;
        if (disc > 0) { const sqrt = Math.sqrt(disc); addSplit((-b - sqrt) / (3 * a)); addSplit((-b + sqrt) / (3 * a)); }
    } else if (Math.abs(b) > tolerance) addSplit(-c / (2 * b));
    split.sort((x, y) => x - y);
    const evalAt = (t: number) => ((a * t + b) * t + c) * t + d;
    for (let i = 1; i < split.length; i++) {
        let low = split[i - 1], high = split[i], fLow = evalAt(low);
        const fHigh = evalAt(high);
        if (Math.abs(fLow) <= tolerance) roots.push(low);
        if (fLow * fHigh < 0) {
            for (let k = 0; k < 32; k++) {
                const mid = (low + high) / 2, f = evalAt(mid);
                if ((f < 0) === (fLow < 0)) { low = mid; fLow = f; } else high = mid;
            }
            roots.push((low + high) / 2);
        }
        if (i === split.length - 1 && Math.abs(fHigh) <= tolerance) roots.push(high);
    }
    return roots;
}

interface Hit { weights: number[]; normal: Point; delta: number; bodyMotion: Point }
const INSIDE = 1e-5;

/** Edge directions in a coplanar sweep have zero triple product throughout. In this
 * regime a finite overlap begins when an endpoint falls on the opposite finite edge.
 * Each component of this collinearity cross product is quadratic. The component with
 * largest variation also handles cases with more than one coplanar event in one tick. */
function planarEndpointTimes(p0: Point, p1: Point, a0: Point, a1: Point, b0: Point, b1: Point): number[] | null {
    const e = sub(b0, a0), de = sub(sub(b1, a1), e), r = sub(p0, a0), dr = sub(sub(p1, a1), r);
    const c = cross(e, r), a = cross(de, dr), u = cross(de, r), v = cross(e, dr);
    const b: Point = [u[0] + v[0], u[1] + v[1], u[2] + v[2]];
    let axis = 0;
    for (let j = 1; j < 3; j++) if (Math.abs(a[j]) + Math.abs(b[j]) + Math.abs(c[j]) >
        Math.abs(a[axis]) + Math.abs(b[axis]) + Math.abs(c[axis])) axis = j;
    const A = a[axis], B = b[axis], C = c[axis], scale = Math.max(Math.abs(A), Math.abs(B), Math.abs(C));
    if (scale < 1e-16) return null;
    if (Math.abs(A) < scale * 1e-13) return Math.abs(B) > scale * 1e-13 ? [-C / B] : [];
    const discriminant = B * B - 4 * A * C;
    if (discriminant < 0) return [];
    const sqrt = Math.sqrt(discriminant);
    return [(-B - sqrt) / (2 * A), (-B + sqrt) / (2 * A)];
}

function edgeContact(a0: Segment, a1: Segment, b0: Segment, b1: Segment, gap: number): Hit | null {
    const u = sub(a0[1], a0[0]), u1 = sub(a1[1], a1[0]), v = sub(b0[1], b0[0]), v1 = sub(b1[1], b1[0]);
    const r = sub(a0[0], b0[0]), dr = sub(sub(a1[0], b1[0]), r);
    function evaluate(s: number, t: number, n: Point): Hit | null {
        if (s <= INSIDE || s >= 1 - INSIDE || t <= INSIDE || t >= 1 - INSIDE) return null;
        const b = lerp(b1[0], b1[1], t), sep = sub(lerp(a1[0], a1[1], s), b);
        const depth = gap - dot(sep, n);
        if (depth <= 1e-8) return null;
        return { weights: [1 - s, s], normal: n, delta: depth, bodyMotion: sub(b, lerp(b0[0], b0[1], t)) };
    }
    for (const time of coplanarityRoots(r, dr, u, sub(u1, u), v, sub(v1, v))) {
        const a: Segment = [lerp(a0[0], a1[0], time), lerp(a0[1], a1[1], time)];
        const b: Segment = [lerp(b0[0], b1[0], time), lerp(b0[1], b1[1], time)];
        const [s, t] = segmentWeights(...a, ...b);
        if (len(sub(lerp(a[0], a[1], s), lerp(b[0], b[1], t))) > 1e-6) continue;
        let n = unit(cross(sub(a[1], a[0]), sub(b[1], b[0])));
        if (!n) continue;
        const old = sub(lerp(a0[0], a0[1], s), lerp(b0[0], b0[1], t));
        if (dot(old, n) < 0) n = negate(n);
        const initialSide = dot(old, n);
        if (Math.abs(initialSide) < 1e-12 && time < 1e-10) continue;
        const hit = evaluate(s, t, n);
        if (hit) return hit;
    }
    // Parallel-in-plane crossing may begin and finish entirely between two samples.
    // Preserve the approach-side in the plane when no transverse 3D root exists.
    const midA: Segment = [lerp(a0[0], a1[0], .5), lerp(a0[1], a1[1], .5)];
    const midB: Segment = [lerp(b0[0], b1[0], .5), lerp(b0[1], b1[1], .5)];
    const coplanar = (a: Segment, b: Segment) => {
        const n = cross(sub(a[1], a[0]), sub(b[1], b[0])), l = len(n);
        return l > 1e-12 && Math.abs(dot(sub(a[0], b[0]), n)) < 1e-10 * l;
    };
    if (coplanar(a0, b0) && coplanar(midA, midB) && coplanar(a1, b1)) {
        const events: number[] = [];
        for (let i = 0; i < 2; i++) {
            events.push(...(planarEndpointTimes(a0[i], a1[i], b0[0], b1[0], b0[1], b1[1]) ?? []));
            events.push(...(planarEndpointTimes(b0[i], b1[i], a0[0], a1[0], a0[1], a1[1]) ?? []));
        }
        events.sort((a, b) => a - b);
        for (const time of events) {
            if (time < 1e-10 || time > 1) continue;
            const a: Segment = [lerp(a0[0], a1[0], time), lerp(a0[1], a1[1], time)];
            const b: Segment = [lerp(b0[0], b1[0], time), lerp(b0[1], b1[1], time)];
            const [s, t] = segmentWeights(...a, ...b);
            if (len(sub(lerp(a[0], a[1], s), lerp(b[0], b[1], t))) > 1e-7) continue;
            const before = Math.max(0, time - 1e-4);
            const ca: Segment = [lerp(a0[0], a1[0], before), lerp(a0[1], a1[1], before)];
            const cb: Segment = [lerp(b0[0], b1[0], before), lerp(b0[1], b1[1], before)];
            const [su, tv] = segmentWeights(...ca, ...cb);
            const n = unit(sub(lerp(ca[0], ca[1], su), lerp(cb[0], cb[1], tv)));
            if (!n) continue;
            const body = lerp(b1[0], b1[1], t);
            const depth = gap - dot(sub(lerp(a1[0], a1[1], s), body), n);
            if (depth > 1e-8) return { weights: [1 - s, s], normal: n, delta: depth, bodyMotion: sub(body, lerp(b0[0], b0[1], t)) };
        }
    }
    const [s, t] = segmentWeights(...a1, ...b1);
    if (s <= INSIDE || s >= 1 - INSIDE || t <= INSIDE || t >= 1 - INSIDE) return null;
    const sep = sub(lerp(a1[0], a1[1], s), lerp(b1[0], b1[1], t));
    if (dot(sep, sep) >= gap * gap) return null;
    const n = unit(sep) ?? unit(sub(lerp(a0[0], a0[1], s), lerp(b0[0], b0[1], t)));
    return n ? evaluate(s, t, n) : null;
}

/** Reciprocal vertex/face response treats the cloth as two-sided. Its previous
 * side determines the admissible shell even when the avatar vertex passes through. */
function bodyVertexContact(p: Point, q: Point, a: FeatureTriangle, b: FeatureTriangle, gap: number): Hit | null {
    const u = sub(a[1], a[0]), v = sub(a[2], a[0]), r = sub(p, a[0]), dr = sub(sub(q, b[0]), r);
    const du = sub(sub(b[1], b[0]), u), dv = sub(sub(b[2], b[0]), v);
    const nEnd = faceNormal(b);
    if (!nEnd) return null;
    function evaluate(w: Barycentric, n: Point): Hit | null {
        if (Math.min(...w) <= INSIDE) return null;
        const depth = gap - dot(sub(anchored(b, w), q), n);
        return depth > 1e-8 ? { weights: w, normal: n, delta: depth, bodyMotion: sub(q, p) } : null;
    }
    for (const time of coplanarityRoots(r, dr, u, du, v, dv)) {
        const hit = lerp(p, q, time), face: FeatureTriangle = [lerp(a[0], b[0], time), lerp(a[1], b[1], time), lerp(a[2], b[2], time)];
        const w = triangleWeights(hit, ...face);
        if (!w || Math.min(...w) <= INSIDE || len(sub(anchored(face, w), hit)) > 1e-6) continue;
        const n = faceNormal(face);
        if (!n) continue;
        const previous = sub(anchored(a, w), p);
        const side = dot(previous, n);
        if (Math.abs(side) < 1e-12 && time < 1e-10) continue;
        const sign = side < 0 ? -1 : 1;
        // Transport the orientation of the cloth's continuous winding to the endpoint.
        const response = evaluate(w, sign === 1 ? nEnd : negate(nEnd));
        if (response) return response;
    }
    const w = triangleWeights(q, ...b);
    if (!w || Math.min(...w) <= INSIDE) return null;
    const sep = sub(anchored(b, w), q);
    if (dot(sep, sep) >= gap * gap) return null;
    const n = unit(sep) ?? unit(sub(anchored(a, w), p));
    return n ? evaluate(w, n) : null;
}

function readFace(ids: number[], p: Float32Array): FeatureTriangle {
    return [point(p, ids[0]), point(p, ids[1]), point(p, ids[2])];
}
function bounds(ids: number[], a: Float32Array, b: Float32Array, padding: number): Bounds {
    const lo: Point = [Infinity, Infinity, Infinity], hi: Point = [-Infinity, -Infinity, -Infinity];
    for (const vertex of ids) for (let j = 0; j < 3; j++) {
        const k = 3 * vertex + j;
        lo[j] = Math.min(lo[j], a[k] - padding, b[k] - padding);
        hi[j] = Math.max(hi[j], a[k] + padding, b[k] + padding);
    }
    return { lo, hi };
}
function overlaps(a: Bounds, b: Bounds): boolean {
    for (let j = 0; j < 3; j++)if (a.lo[j] > b.hi[j] || a.hi[j] < b.lo[j]) return false;
    return true;
}

export class AvatarSurfaceFeatures {
    private readonly faces: number[][] = [];
    private readonly edges: number[][] = [];
    private readonly seen = new Set<number>();
    private readonly pinBudget: PinCorrectionBudget;
    constructor(indices: Uint32Array, private readonly inverseMass: Float64Array) {
        this.pinBudget = new PinCorrectionBudget(inverseMass.length);
        const known = new Set<number>(), v = inverseMass.length;
        for (let t = 0; t < indices.length; t += 3) {
            const face = [indices[t], indices[t + 1], indices[t + 2]];
            this.faces.push(face);
            for (let j = 0; j < 3; j++) {
                const a = face[j], b = face[(j + 1) % 3], key = Math.min(a, b) * v + Math.max(a, b);
                if (!known.has(key)) { known.add(key); this.edges.push([a, b]); }
            }
        }
    }

    beginTick(): void { this.pinBudget.reset(); }

    project(old: Float32Array, end: Float32Array, gap: number, avatar0: Float32Array, avatar1: Float32Array,
        index: Uint16Array | Uint32Array, query: FeatureQuery, friction: ContactFriction, stats: SurfaceFeatureStats,
        maxPairs: number): void {
        const v = avatar1.length / 3;
        const budget = () => {
            if (stats.testedEdges + stats.testedBodyVertices < maxPairs) return true;
            stats.featurePairsLimited = true;
            return false;
        };
        const resolve = (ids: number[], hit: Hit) => {
            let denominator = 0, largestGradient = 0, touchesPin = false;
            for (let k = 0; k < ids.length; k++) {
                const w = hit.weights[k], mass = this.inverseMass[ids[k]];
                denominator += w * w * mass;
                largestGradient = Math.max(largestGradient, Math.abs(w) * mass);
                if (!mass && Math.abs(w) > 1e-8) touchesPin = true;
            }
            if (denominator <= 1e-14) {
                if (touchesPin) stats.pinLimitedFeatures++;
                return false;
            }
            let lambda = hit.delta / denominator;
            const guard = touchesPin && largestGradient > 4 * denominator;
            if (guard) {
                // Near a pinned corner a tiny contact weight on the only movable vertex
                // can require a metre-scale shift to close a millimetre-scale gap.
                const unrestricted = lambda, maxMove = 4 * Math.max(gap, hit.delta);
                for (let k = 0; k < ids.length; k++) {
                    lambda = this.pinBudget.limit(lambda, ids[k], Math.abs(hit.weights[k]) * this.inverseMass[ids[k]], maxMove);
                }
                if (lambda < unrestricted) stats.pinLimitedFeatures++;
            }
            if (!lambda) return false;
            for (let k = 0; k < ids.length; k++) {
                const i = ids[k], shift = lambda * hit.weights[k] * this.inverseMass[i];
                if (!shift) continue;
                if (guard) this.pinBudget.record(i, shift);
                for (let j = 0; j < 3; j++) end[3 * i + j] += hit.normal[j] * shift;
                friction(3 * i, ...hit.normal, shift, ...hit.bodyMotion);
            }
            return true;
        };
        // Query reciprocal points first: broad triangles can easily cover a small proxy,
        // leaving no cloth vertices or edges inside the avatar faces.
        for (const ids of this.faces) {
            if (ids.every(i => this.inverseMass[i] === 0)) continue;
            const box = bounds(ids, old, end, gap), a = readFace(ids, old);
            this.seen.clear();
            const complete = query(box.lo, box.hi, face => {
                for (let j = 0; j < 3; j++) {
                    const i = index[3 * face + j];
                    if (this.seen.has(i)) continue;
                    this.seen.add(i);
                    if (!overlaps(box, bounds([i], avatar0, avatar1, 0))) continue;
                    if (!budget()) return false;
                    stats.testedBodyVertices++;
                    const hit = bodyVertexContact(point(avatar0, i), point(avatar1, i), a, readFace(ids, end), gap);
                    if (hit && resolve(ids, hit)) stats.bodyVertexCorrections++;
                }
                return true;
            });
            if (!complete) return;
        }
        for (const ids of this.edges) {
            if (ids.every(i => this.inverseMass[i] === 0)) continue;
            const box = bounds(ids, old, end, gap);
            const a: Segment = [point(old, ids[0]), point(old, ids[1])];
            this.seen.clear();
            const complete = query(box.lo, box.hi, face => {
                for (let j = 0; j < 3; j++) {
                    const i = index[3 * face + j], k = index[3 * face + (j + 1) % 3], key = Math.min(i, k) * v + Math.max(i, k);
                    if (this.seen.has(key)) continue;
                    this.seen.add(key);
                    if (!overlaps(box, bounds([i, k], avatar0, avatar1, 0))) continue;
                    if (!budget()) return false;
                    stats.testedEdges++;
                    const hit = edgeContact(a, [point(end, ids[0]), point(end, ids[1])], [point(avatar0, i), point(avatar0, k)],
                        [point(avatar1, i), point(avatar1, k)], gap);
                    if (hit && resolve(ids, hit)) stats.edgeCorrections++;
                }
                return true;
            });
            if (!complete) return;
        }
    }
}
