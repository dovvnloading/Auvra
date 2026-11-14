/** Allocation-light narrow-phase helpers for cloth triangles and analytic collision proxies. */
export type Point = [number, number, number];
export type Barycentric = [number, number, number];
export const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Limit only ill-conditioned pin contacts. Each free vertex has a shared displacement
 * budget per solve, so tessellating the opposite surface cannot multiply its travel.
 * A fast crossing increases the budget by the incoming normal sweep. */
export class PinCorrectionBudget {
    private readonly used: Float64Array;
    constructor(vertexCount: number) { this.used = new Float64Array(vertexCount); }
    reset(): void { this.used.fill(0); }
    limit(lambda: number, index: number, gradient: number, maxMove: number): number {
        return gradient > 0 ? Math.min(lambda, Math.max(0, maxMove - this.used[index]) / gradient) : lambda;
    }
    record(index: number, move: number): void { this.used[index] += Math.abs(move); }
}

/** Closest point on the closed triangle, expressed in barycentric coordinates. */
export function triangleWeights(p: Point, a: Point, b: Point, c: Point): Barycentric | null {
    const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
    const d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return [1, 0, 0];
    const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return [0, 1, 0];
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0 && d1 > d3) {
        const v = d1 / (d1 - d3);
        return [1 - v, v, 0];
    }
    const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return [0, 0, 1];
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0 && d2 > d6) {
        const w = d2 / (d2 - d6);
        return [1 - w, 0, w];
    }
    const va = d3 * d6 - d5 * d4;
    const e1 = d4 - d3, e2 = d5 - d6;
    if (va <= 0 && e1 >= 0 && e2 >= 0 && e1 + e2 > 0) {
        const w = e1 / (e1 + e2);
        return [0, 1 - w, w];
    }
    const sum = va + vb + vc;
    if (!(sum > 1e-24)) return null;
    return [va / sum, vb / sum, vc / sum];
}

/** Closest parameters on two closed segments, including parallel and short segments. */
export function segmentWeights(a: Point, b: Point, c: Point, d: Point): [number, number] {
    const u = sub(b, a), v = sub(d, c), r = sub(a, c);
    const uu = dot(u, u), vv = dot(v, v), uv = dot(u, v), ur = dot(u, r), vr = dot(v, r);
    if (uu < 1e-20) return [0, vv < 1e-20 ? 0 : clamp01(vr / vv)];
    if (vv < 1e-20) return [clamp01(-ur / uu), 0];
    const denom = uu * vv - uv * uv;
    let s = denom > 1e-14 * uu * vv ? clamp01((uv * vr - vv * ur) / denom) : 0;
    const t = (uv * s + vr) / vv;
    if (t < 0) { s = clamp01(-ur / uu); return [s, 0]; }
    if (t > 1) { s = clamp01((uv - ur) / uu); return [s, 1]; }
    return [s, t];
}


/** In normalized capsule coordinates the axis extends from (0,0,0) to (0,span,0).
 * A segment/triangle minimum occurs on a cap, a triangle edge, or an interior intersection. */
export function closestAxisTriangle(a: Point, b: Point, c: Point, span: number): Barycentric | null {
    const vertices = [a, b, c];
    const lower: Point = [0, 0, 0], upper: Point = [0, span, 0];
    let best = Infinity, weights: Barycentric | null = null;
    function consider(w: Barycentric) {
        const x = w[0] * a[0] + w[1] * b[0] + w[2] * c[0];
        const y = w[0] * a[1] + w[1] * b[1] + w[2] * c[1];
        const z = w[0] * a[2] + w[1] * b[2] + w[2] * c[2];
        const d = x * x + z * z + (y - Math.min(span, Math.max(0, y))) ** 2;
        if (d < best) { best = d; weights = w; }
    }
    const ab = sub(b, a), ac = sub(c, a);
    const normal: Point = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    if (Math.abs(normal[1]) > 1e-12) {
        const y = dot(normal, a) / normal[1];
        if (y >= 0 && y <= span) {
            const w = triangleWeights([0, y, 0], a, b, c);
            if (w) consider(w);
        }
    }
    for (const point of [lower, upper]) {
        const w = triangleWeights(point, a, b, c);
        if (w) consider(w);
    }
    for (let j = 0; j < 3; j++) {
        const next = (j + 1) % 3;
        const [u] = segmentWeights(vertices[j], vertices[next], lower, upper);
        const w: Barycentric = [0, 0, 0];
        w[j] = 1 - u; w[next] = u;
        consider(w);
    }
    return best < 1 ? weights : null;
}
