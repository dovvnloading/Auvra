import { overlappingPairs } from './overlap';
import { chartBoundaries, type Chart, type UvTopology } from './uvTopology';

/**
 * CONFORMAL UNWRAPPING (least squares conformal maps)
 *
 * Flattens a chart so every triangle keeps its angles as nearly as possible: for each triangle, the
 * map from its own plane to the texture plane should be a rotation and a uniform scale, which is two
 * linear conditions on its corners' coordinates. Pinning two corners far apart fixes the rest; the
 * whole is solved by least squares with conjugate gradients, started from the chart laid flat on its
 * best-fitting plane so few steps are needed.
 */

export interface Flattened {
    /** Two per chart corner. */
    uv: Float64Array;
    /** Triangles turned over (a sign the chart should be cut further). */
    flipped: number;
    /** Triangles lying over others of the chart: it wrapped round onto itself and should be cut further. */
    overlapping: number;
    /** Pairs of the chart's faces (by place in its list) lying on each other, where it should be cut apart. */
    folds?: Array<[number, number]>;
    /** Worst stretch of any triangle (1 is none): largest over smallest of its two stretch directions. */
    worstStretch: number;
    /** Mean stretch, weighted by area. */
    meanStretch: number;
}

const planeOf = (topology: UvTopology, chart: Chart): { origin: number[]; u: number[]; v: number[] } => {
    const p = topology.positions;
    const normal = [0, 0, 0];
    const centre = [0, 0, 0];
    let total = 0;
    for (const f of chart.faces) {
        const a = topology.areas[f];
        for (let axis = 0; axis < 3; axis++) normal[axis] += topology.normals[f * 3 + axis] * a;
        total += a;
    }
    for (const v of chart.vertexWeld) for (let axis = 0; axis < 3; axis++) centre[axis] += p[v * 3 + axis] / chart.vertexWeld.length;
    let length = Math.hypot(normal[0], normal[1], normal[2]);
    if (length < 1e-12 || total <= 0) { normal[0] = 0; normal[1] = 0; normal[2] = 1; length = 1; }
    const n = normal.map((x) => x / length);
    const helper = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = [helper[1] * n[2] - helper[2] * n[1], helper[2] * n[0] - helper[0] * n[2], helper[0] * n[1] - helper[1] * n[0]];
    const ul = Math.hypot(u[0], u[1], u[2]);
    const uu = u.map((x) => x / ul);
    const v = [n[1] * uu[2] - n[2] * uu[1], n[2] * uu[0] - n[0] * uu[2], n[0] * uu[1] - n[1] * uu[0]];
    return { origin: centre, u: uu, v };
};

/** Two corners of the chart's boundary (or of the chart) far apart: a double sweep for the widest pair. */
const pinPair = (topology: UvTopology, chart: Chart): [number, number] => {
    const loops = chartBoundaries(chart);
    const candidates = loops.length ? loops.flat() : chart.vertexWeld.map((_, i) => i);
    const p = topology.positions;
    const distance = (a: number, b: number) => {
        const x = chart.vertexWeld[a] * 3, y = chart.vertexWeld[b] * 3;
        return Math.hypot(p[x] - p[y], p[x + 1] - p[y + 1], p[x + 2] - p[y + 2]);
    };
    let a = candidates[0];
    let b = a;
    for (let pass = 0; pass < 3; pass++) {
        let best = -1;
        for (const c of candidates) {
            const d = distance(a, c);
            if (d > best) { best = d; b = c; }
        }
        [a, b] = [b, a];
    }
    if (a === b) b = candidates.find((c) => c !== a) ?? (a + 1) % chart.vertexWeld.length;
    return [a, b];
};

/** How a chart is laid flat: keeping each triangle's own angles as well as it can, or angles evened out first. */
export type FlattenMethod = 'conformal' | 'angleBased';

/**
 * Angle-based flattening's first step: each corner's angle, from the model, nudged until the angles round
 * every inner vertex of the chart add up to a full turn (as they must on a flat sheet) and each triangle's
 * add up to a half turn, so the curvature is spread over every angle instead of left to the solver. Three
 * angles per chart face, in the face's corner order; `inner` says which chart vertices are not on its edge.
 */
export const flatAngles = (angles: Float64Array, corners: ArrayLike<number>, inner: ReadonlySet<number>, rounds = 60): Float64Array => {
    const out = Float64Array.from(angles);
    const vertexCount = corners.length ? Math.max(...Array.from(corners)) + 1 : 0;
    const sums = new Float64Array(vertexCount);
    for (let round = 0; round < rounds; round++) {
        sums.fill(0);
        for (let i = 0; i < corners.length; i++) sums[corners[i]] += out[i];
        for (let i = 0; i < corners.length; i++) if (inner.has(corners[i]) && sums[corners[i]] > 0) out[i] *= (2 * Math.PI) / sums[corners[i]];
        for (let f = 0; f + 2 < corners.length; f += 3) {
            const spare = (Math.PI - (out[f] + out[f + 1] + out[f + 2])) / 3;
            for (let k = 0; k < 3; k++) out[f + k] = Math.min(Math.PI - 1e-4, Math.max(1e-4, out[f + k] + spare));
        }
    }
    return out;
};

/** A chart's corner angles on the model, three per face in corner order. */
const modelAngles = (topology: UvTopology, chart: Chart): Float64Array => {
    const p = topology.positions;
    const out = new Float64Array(chart.faces.length * 3);
    chart.faces.forEach((f, t) => {
        const w = [0, 1, 2].map((k) => topology.faces[f * 3 + k] * 3);
        for (let k = 0; k < 3; k++) {
            const a = w[k], b = w[(k + 1) % 3], c = w[(k + 2) % 3];
            const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
            const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
            const dot = ux * vx + uy * vy + uz * vz;
            const cross = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
            out[t * 3 + k] = Math.atan2(cross, dot);
        }
    });
    return out;
};

/** The chart vertices not on its edge (an edge used by only one of its faces). */
const innerVertices = (chart: Chart): Set<number> => {
    const uses = new Map<string, number>();
    for (let t = 0; t < chart.faces.length; t++) {
        for (let k = 0; k < 3; k++) {
            const a = chart.corners[t * 3 + k], b = chart.corners[t * 3 + ((k + 1) % 3)];
            const key = a < b ? `${a},${b}` : `${b},${a}`;
            uses.set(key, (uses.get(key) ?? 0) + 1);
        }
    }
    const edge = new Set<number>();
    for (const [key, count] of uses) if (count === 1) for (const v of key.split(',')) edge.add(Number(v));
    const inner = new Set<number>();
    for (let v = 0; v < chart.vertexWeld.length; v++) if (!edge.has(v)) inner.add(v);
    return inner;
};

/** Lays a chart flat: conformally, or with its angles evened out first (angle-based). */
export const flattenChart = (topology: UvTopology, chart: Chart, method: FlattenMethod = 'conformal'): Flattened => {
    const count = chart.vertexWeld.length;
    const uv = new Float64Array(count * 2);
    const p = topology.positions;
    const plane = planeOf(topology, chart);
    for (let i = 0; i < count; i++) {
        const v = chart.vertexWeld[i] * 3;
        const d = [p[v] - plane.origin[0], p[v + 1] - plane.origin[1], p[v + 2] - plane.origin[2]];
        uv[i * 2] = d[0] * plane.u[0] + d[1] * plane.u[1] + d[2] * plane.u[2];
        uv[i * 2 + 1] = d[0] * plane.v[0] + d[1] * plane.v[1] + d[2] * plane.v[2];
    }
    if (count < 3 || chart.faces.length === 0) return measure(topology, chart, uv);

    // Rows: two per triangle, over the 2·count unknowns (u0, v0, u1, v1, ...), each with three corners' terms.
    const faceCount = chart.faces.length;
    // Angle-based: each triangle is laid out with its evened-out angles (and its own area) instead of its shape on the model.
    const targets = method === 'angleBased' ? flatAngles(modelAngles(topology, chart), chart.corners, innerVertices(chart)) : null;
    const rowCols = new Int32Array(faceCount * 2 * 6);
    const rowVals = new Float64Array(faceCount * 2 * 6);
    for (let t = 0; t < faceCount; t++) {
        const f = chart.faces[t];
        const ids = [chart.corners[t * 3], chart.corners[t * 3 + 1], chart.corners[t * 3 + 2]];
        const w = [0, 1, 2].map((k) => topology.faces[f * 3 + k] * 3);
        // The triangle in its own plane: first corner at the origin, second along x.
        const e1 = [p[w[1]] - p[w[0]], p[w[1] + 1] - p[w[0] + 1], p[w[1] + 2] - p[w[0] + 2]];
        const e2 = [p[w[2]] - p[w[0]], p[w[2] + 1] - p[w[0] + 1], p[w[2] + 2] - p[w[0] + 2]];
        const l1 = Math.hypot(e1[0], e1[1], e1[2]);
        const x2 = l1;
        const x3 = l1 > 0 ? (e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2]) / l1 : 0;
        const y3 = Math.sqrt(Math.max(0, e2[0] * e2[0] + e2[1] * e2[1] + e2[2] * e2[2] - x3 * x3));
        let xs = [0, x2, x3];
        let ys = [0, 0, y3];
        if (targets) {
            const [a0, a1, a2] = [targets[t * 3], targets[t * 3 + 1], targets[t * 3 + 2]];
            // Sides by the sine rule (the side from corner 0 to 1 faces corner 2), scaled to the triangle's own area.
            const s01 = Math.sin(a2), s02 = Math.sin(a1);
            const area = Math.max(x2 * y3 / 2, 1e-20);
            const shapeArea = Math.max(0.5 * s01 * s02 * Math.sin(a0), 1e-20);
            const k = Math.sqrt(area / shapeArea);
            xs = [0, s01 * k, s02 * k * Math.cos(a0)];
            ys = [0, 0, s02 * k * Math.sin(a0)];
        }
        const doubleArea = Math.max(xs[1] * ys[2], 1e-20);
        const scale = 1 / Math.sqrt(doubleArea);
        for (let k = 0; k < 3; k++) {
            // W_k = (x_{k+2} - x_{k+1}) + i (y_{k+2} - y_{k+1})
            const wr = (xs[(k + 2) % 3] - xs[(k + 1) % 3]) * scale;
            const wi = (ys[(k + 2) % 3] - ys[(k + 1) % 3]) * scale;
            const at = t * 12;
            // Real part: wr·u - wi·v ; imaginary part: wi·u + wr·v
            rowCols[at + k * 2] = ids[k] * 2; rowVals[at + k * 2] = wr;
            rowCols[at + k * 2 + 1] = ids[k] * 2 + 1; rowVals[at + k * 2 + 1] = -wi;
            rowCols[at + 6 + k * 2] = ids[k] * 2; rowVals[at + 6 + k * 2] = wi;
            rowCols[at + 6 + k * 2 + 1] = ids[k] * 2 + 1; rowVals[at + 6 + k * 2 + 1] = wr;
        }
    }
    const rows = faceCount * 2;
    const [pinA, pinB] = pinPair(topology, chart);
    const pinned = new Uint8Array(count * 2);
    pinned[pinA * 2] = pinned[pinA * 2 + 1] = pinned[pinB * 2] = pinned[pinB * 2 + 1] = 1;

    // Least squares over the free unknowns: minimise |A x - b| with the pins' terms moved into b. Columns are
    // scaled to unit length first (x = D⁻¹ y), which evens out triangles of very different sizes and lets
    // conjugate gradients settle in far fewer steps.
    const columnScale = new Float64Array(count * 2);
    for (let r = 0; r < rows * 6; r++) columnScale[rowCols[r]] += rowVals[r] * rowVals[r];
    for (let c = 0; c < columnScale.length; c++) columnScale[c] = columnScale[c] > 0 ? 1 / Math.sqrt(columnScale[c]) : 1;
    const x = new Float64Array(uv);
    const y = new Float64Array(x.length);
    for (let c = 0; c < x.length; c++) y[c] = x[c] / columnScale[c];
    const residual = new Float64Array(rows);
    // A·D over the free columns (scaled), or A over all of them (unscaled, for the starting residual).
    const applyScaled = (vector: Float64Array, out: Float64Array) => {
        for (let r = 0; r < rows; r++) {
            let sum = 0;
            for (let k = 0; k < 6; k++) {
                const c = rowCols[r * 6 + k];
                if (pinned[c]) continue;
                sum += rowVals[r * 6 + k] * columnScale[c] * vector[c];
            }
            out[r] = sum;
        }
    };
    const applyScaledT = (vector: Float64Array, out: Float64Array) => {
        out.fill(0);
        for (let r = 0; r < rows; r++) {
            const value = vector[r];
            if (value === 0) continue;
            for (let k = 0; k < 6; k++) {
                const c = rowCols[r * 6 + k];
                if (!pinned[c]) out[c] += rowVals[r * 6 + k] * columnScale[c] * value;
            }
        }
    };
    // r = b - A x = -A x over every unknown (the pins included).
    for (let r = 0; r < rows; r++) {
        let sum = 0;
        for (let k = 0; k < 6; k++) sum += rowVals[r * 6 + k] * x[rowCols[r * 6 + k]];
        residual[r] = -sum;
    }
    const gradient = new Float64Array(count * 2);
    applyScaledT(residual, gradient);
    const direction = new Float64Array(gradient);
    const projected = new Float64Array(rows);
    let gamma = 0;
    for (let i = 0; i < gradient.length; i++) gamma += gradient[i] * gradient[i];
    const start = gamma;
    const limit = Math.min(4000, 60 + count * 2);
    for (let step = 0; step < limit && gamma > start * 1e-14 && gamma > 1e-30; step++) {
        applyScaled(direction, projected);
        let denominator = 0;
        for (let r = 0; r < rows; r++) denominator += projected[r] * projected[r];
        if (denominator <= 0) break;
        const alpha = gamma / denominator;
        for (let i = 0; i < y.length; i++) if (!pinned[i]) y[i] += alpha * direction[i];
        for (let r = 0; r < rows; r++) residual[r] -= alpha * projected[r];
        applyScaledT(residual, gradient);
        let next = 0;
        for (let i = 0; i < gradient.length; i++) next += gradient[i] * gradient[i];
        const beta = next / gamma;
        gamma = next;
        for (let i = 0; i < direction.length; i++) direction[i] = pinned[i] ? 0 : gradient[i] + beta * direction[i];
    }
    for (let c = 0; c < x.length; c++) if (!pinned[c]) x[c] = y[c] * columnScale[c];
    return measure(topology, chart, x);
};

/** Flips, overlaps and stretch of a flattened chart, with uv scaled so its area matches the surface's. */
export const measure = (topology: UvTopology, chart: Chart, uv: Float64Array): Flattened => {
    let surface = 0;
    let flat = 0;
    let signed = 0;
    const flatAreas = new Float64Array(chart.faces.length);
    chart.faces.forEach((f, t) => {
        const [a, b, c] = [chart.corners[t * 3], chart.corners[t * 3 + 1], chart.corners[t * 3 + 2]];
        const area = ((uv[b * 2] - uv[a * 2]) * (uv[c * 2 + 1] - uv[a * 2 + 1]) - (uv[c * 2] - uv[a * 2]) * (uv[b * 2 + 1] - uv[a * 2 + 1])) / 2;
        flatAreas[t] = area;
        signed += area;
        flat += Math.abs(area);
        surface += topology.areas[f];
    });
    // Mirror a chart that came out turned over as a whole.
    if (signed < 0) {
        for (let i = 0; i < uv.length; i += 2) uv[i] = -uv[i];
        for (let t = 0; t < flatAreas.length; t++) flatAreas[t] = -flatAreas[t];
    }
    const scale = flat > 0 ? Math.sqrt(surface / flat) : 1;
    for (let i = 0; i < uv.length; i++) uv[i] *= scale;
    let flipped = 0;
    let worst = 1;
    let weighted = 0;
    const p = topology.positions;
    chart.faces.forEach((f, t) => {
        // A sliver with no area on the model has no shape to keep: it neither folds nor stretches.
        if (topology.areas[f] <= surface * 1e-9) return;
        if (flatAreas[t] <= 0) { flipped++; return; }
        const stretch = triangleStretch(p, topology.faces, f, uv, chart.corners[t * 3], chart.corners[t * 3 + 1], chart.corners[t * 3 + 2]);
        worst = Math.max(worst, stretch.ratio);
        weighted += stretch.ratio * topology.areas[f];
    });
    // Overlaps shallower than a quarter of a fine texel (the whole surface on one 4096 picture) are rounding.
    const depth = (Math.sqrt(surfaceOf(topology)) / 4096) * 0.25;
    const folds = overlappingPairs(uv, chart.corners, chart.faces.length, depth);
    const overlapping = new Set(folds.flat()).size;
    return { uv, flipped, overlapping, ...(folds.length ? { folds } : {}), worstStretch: worst, meanStretch: surface > 0 ? weighted / surface : 1 };
};

/** The model's whole surface area, worked out once per topology. */
const surfaces = new WeakMap<UvTopology, number>();
const surfaceOf = (topology: UvTopology): number => {
    let total = surfaces.get(topology);
    if (total === undefined) {
        total = 0;
        for (let f = 0; f < topology.faceCount; f++) total += topology.areas[f];
        surfaces.set(topology, total);
    }
    return total;
};

/**
 * How a triangle is stretched from the model to its texture coordinates: the two singular values of the
 * map (how much the longest and shortest directions grow), and their ratio (1: shapes kept).
 */
export const triangleStretch = (p: ArrayLike<number>, faces: ArrayLike<number>, f: number, uv: ArrayLike<number>, a: number, b: number, c: number): { large: number; small: number; ratio: number } => {
    const w = [faces[f * 3] * 3, faces[f * 3 + 1] * 3, faces[f * 3 + 2] * 3];
    const e1 = [p[w[1]] - p[w[0]], p[w[1] + 1] - p[w[0] + 1], p[w[1] + 2] - p[w[0] + 2]];
    const e2 = [p[w[2]] - p[w[0]], p[w[2] + 1] - p[w[0] + 1], p[w[2] + 2] - p[w[0] + 2]];
    const l1 = Math.hypot(e1[0], e1[1], e1[2]);
    const x3 = l1 > 0 ? (e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2]) / l1 : 0;
    const y3 = Math.sqrt(Math.max(0, e2[0] ** 2 + e2[1] ** 2 + e2[2] ** 2 - x3 * x3));
    const area = (l1 * y3) / 2;
    if (area <= 1e-20) return { large: 1, small: 1, ratio: 1 };
    const s = [uv[a * 2], uv[b * 2], uv[c * 2]];
    const t = [uv[a * 2 + 1], uv[b * 2 + 1], uv[c * 2 + 1]];
    // Partial derivatives of (s, t) along the triangle's own x and y.
    const sx = (s[1] - s[0]) / l1;
    const tx = (t[1] - t[0]) / l1;
    const sy = (s[2] - s[0] - sx * x3) / y3;
    const ty = (t[2] - t[0] - tx * x3) / y3;
    const aa = sx * sx + tx * tx;
    const cc = sy * sy + ty * ty;
    const bb = sx * sy + tx * ty;
    const root = Math.sqrt(Math.max(0, (aa - cc) ** 2 + 4 * bb * bb));
    const large = Math.sqrt(Math.max(0, (aa + cc + root) / 2));
    const small = Math.sqrt(Math.max(0, (aa + cc - root) / 2));
    return { large, small, ratio: small > 1e-12 ? large / small : 1e6 };
};
