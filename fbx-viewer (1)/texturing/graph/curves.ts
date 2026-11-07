/**
 * CURVES AND PATHS
 *
 * The maths of the spline nodes: point lists made into smooth curves (a mix of straight spans and a
 * Catmull-Rom spline through the points), curves cut into segments with their length so far, the
 * nearest point of a set of segments to a place and which side it lies on, winding numbers for fills,
 * the copies of a picture a curve repeats when it crosses the picture's edges, points spaced evenly
 * along a curve, a quad between two curves found again (inverse bilinear), and the outlines of a
 * mask traced into closed paths (marching squares on a repeating grid) and simplified, and the path
 * tools' changes to curves on wires: moved to one side, corners rounded, cut to even spans. Places are
 * picture places: u across, v up, 0 to 1.
 */

export type Point = [number, number];

const finite = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** The most points a list keeps. */
export const MAX_POINTS = 256;

/** A setting's value as a list of points (pairs of numbers), or `fallback`. */
export const readPoints = (value: unknown, fallback: readonly Point[] = []): Point[] => {
    if (!Array.isArray(value)) return fallback.map((point) => [point[0], point[1]]);
    const points: Point[] = [];
    for (const item of value) {
        if (!Array.isArray(item)) continue;
        points.push([finite(item[0], 0.5), finite(item[1], 0.5)]);
        if (points.length >= MAX_POINTS) break;
    }
    return points;
};

/**
 * A polyline through `points`: `smoothness` 0 runs straight from point to point, 1 along a Catmull-Rom
 * spline through them, between mixes the two; `steps` pieces a span. Closed curves come back to their start.
 */
export const smoothPath = (points: readonly Point[], closed: boolean, smoothness: number, steps = 12): Point[] => {
    const n = points.length;
    if (n < 2) return points.map((point) => [point[0], point[1]]);
    const at = (i: number): Point => (closed ? points[((i % n) + n) % n] : points[Math.min(n - 1, Math.max(0, i))]);
    const spans = closed ? n : n - 1;
    const pieces = smoothness <= 0 ? 1 : steps;
    const out: Point[] = [];
    for (let i = 0; i < spans; i++) {
        const p0 = at(i - 1);
        const p1 = at(i);
        const p2 = at(i + 1);
        const p3 = at(i + 2);
        for (let k = 0; k < pieces; k++) {
            const t = k / pieces;
            const t2 = t * t;
            const t3 = t2 * t;
            const point: Point = [0, 0];
            for (let c = 0; c < 2; c++) {
                const spline = 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3);
                const straight = p1[c] + (p2[c] - p1[c]) * t;
                point[c] = straight + (spline - straight) * smoothness;
            }
            out.push(point);
        }
    }
    const last = closed ? points[0] : points[n - 1];
    out.push([last[0], last[1]]);
    return out;
};

/** A piece of a path: its ends, its path's length up to its start, its own length, which path, and that path's whole length. */
export interface Segment { a: Point; b: Point; start: number; length: number; path: number; pathLength: number }

/** The segments of polylines, each path's lengths counted from its own start. */
export const segmentsOf = (paths: readonly (readonly Point[])[]): Segment[] => {
    const segments: Segment[] = [];
    paths.forEach((path, index) => {
        const first = segments.length;
        let run = 0;
        for (let i = 0; i + 1 < path.length; i++) {
            const length = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
            segments.push({ a: path[i], b: path[i + 1], start: run, length, path: index, pathLength: 0 });
            run += length;
        }
        for (let i = first; i < segments.length; i++) segments[i].pathLength = run;
    });
    return segments;
};

/** The whole length of a polyline. */
export const pathLength = (path: readonly Point[]): number => {
    let total = 0;
    for (let i = 0; i + 1 < path.length; i++) total += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
    return total;
};

/**
 * The copies of a set of segments a repeating picture shows, as offsets of whole pictures (each way it
 * repeats) to add to a place to look at a copy: those copies some segment of, widened by `reach`, overlaps the picture.
 */
export const wrapOffsets = (segments: readonly Segment[], reach: number, tiling: readonly [boolean, boolean]): Point[] => {
    if (!segments.length) return [[0, 0]];
    let low: Point = [Infinity, Infinity];
    let high: Point = [-Infinity, -Infinity];
    for (const segment of segments) {
        for (const point of [segment.a, segment.b]) {
            low = [Math.min(low[0], point[0]), Math.min(low[1], point[1])];
            high = [Math.max(high[0], point[0]), Math.max(high[1], point[1])];
        }
    }
    const offsets: Point[] = [];
    const span = (axis: 0 | 1): number[] => {
        if (!tiling[axis]) return [0];
        const result: number[] = [];
        // Shifts k with [low + k - reach, high + k + reach] overlapping [0, 1].
        for (let k = Math.floor(-high[axis] - reach); k <= Math.ceil(1 - low[axis] + reach); k++) {
            if (low[axis] + k - reach <= 1 && high[axis] + k + reach >= 0) result.push(k);
        }
        return result.length ? result : [0];
    };
    // Returned as what to add to a place to read the copy there (the copy moved by k is read at p - k).
    for (const dy of span(1)) for (const dx of span(0)) offsets.push([dx === 0 ? 0 : -dx, dy === 0 ? 0 : -dy]);
    return offsets;
};

export interface NearestHit {
    distance: number;
    /** Length along its path to the nearest point. */
    along: number;
    /** +1 left of the path's direction, -1 right. */
    side: number;
    path: number;
    pathLength: number;
}

/** The nearest point of `segments` (and their copies at `offsets`) to `p`. */
export const nearestOn = (p: Point, segments: readonly Segment[], offsets: readonly Point[] = [[0, 0]]): NearestHit => {
    const hit: NearestHit = { distance: Infinity, along: 0, side: 1, path: 0, pathLength: 0 };
    for (const offset of offsets) {
        const qx = p[0] + offset[0];
        const qy = p[1] + offset[1];
        for (const segment of segments) {
            const ex = segment.b[0] - segment.a[0];
            const ey = segment.b[1] - segment.a[1];
            const t = Math.min(1, Math.max(0, ((qx - segment.a[0]) * ex + (qy - segment.a[1]) * ey) / Math.max(ex * ex + ey * ey, 1e-12)));
            const dx = qx - (segment.a[0] + ex * t);
            const dy = qy - (segment.a[1] + ey * t);
            const distance = Math.hypot(dx, dy);
            if (distance < hit.distance) {
                hit.distance = distance;
                hit.along = segment.start + t * segment.length;
                hit.side = ex * dy - ey * dx >= 0 ? 1 : -1;
                hit.path = segment.path;
                hit.pathLength = segment.pathLength;
            }
        }
    }
    return hit;
};

/** How many times the segments (closed paths) wind round `p`, their copies at `offsets` added in. */
export const windingAt = (p: Point, segments: readonly Segment[], offsets: readonly Point[] = [[0, 0]]): number => {
    let winding = 0;
    for (const offset of offsets) {
        const qx = p[0] + offset[0];
        const qy = p[1] + offset[1];
        for (const { a, b } of segments) {
            const cross = (b[0] - a[0]) * (qy - a[1]) - (b[1] - a[1]) * (qx - a[0]);
            if (a[1] <= qy) { if (b[1] > qy && cross > 0) winding++; }
            else if (b[1] <= qy && cross < 0) winding--;
        }
    }
    return winding;
};

/** `count` points spaced evenly along a polyline by length (both ends included). */
export const resample = (path: readonly Point[], count: number): Point[] => {
    const total = pathLength(path);
    if (path.length < 2 || total <= 0) return Array.from({ length: count }, () => (path[0] ? [path[0][0], path[0][1]] as Point : [0.5, 0.5] as Point));
    const out: Point[] = [];
    let segment = 0;
    let run = 0;
    for (let k = 0; k < count; k++) {
        const target = (total * k) / Math.max(1, count - 1);
        while (segment < path.length - 2 && run + Math.hypot(path[segment + 1][0] - path[segment][0], path[segment + 1][1] - path[segment][1]) < target) {
            run += Math.hypot(path[segment + 1][0] - path[segment][0], path[segment + 1][1] - path[segment][1]);
            segment++;
        }
        const length = Math.hypot(path[segment + 1][0] - path[segment][0], path[segment + 1][1] - path[segment][1]);
        const t = length > 0 ? Math.min(1, Math.max(0, (target - run) / length)) : 0;
        out.push([path[segment][0] + (path[segment + 1][0] - path[segment][0]) * t, path[segment][1] + (path[segment + 1][1] - path[segment][1]) * t]);
    }
    return out;
};

/** A copy placed along a curve: where, which way it faces (radians), and how far along. */
export interface Placement { at: Point; angle: number; along: number }

/**
 * Places spaced `spacing` apart along a polyline: from half a space in on an open path, evenly round a
 * closed one (the spacing stretched a little so they meet up).
 */
export const placementsAlong = (path: readonly Point[], spacing: number, closed: boolean, limit = 1024): Placement[] => {
    const total = pathLength(path);
    if (path.length < 2 || total <= 0 || spacing <= 0) return [];
    const count = Math.min(limit, closed ? Math.max(1, Math.round(total / spacing)) : Math.max(1, Math.floor(total / spacing)));
    const step = closed ? total / count : spacing;
    const first = closed ? 0 : (total - step * (count - 1)) / 2;
    const out: Placement[] = [];
    let segment = 0;
    let run = 0;
    for (let k = 0; k < count; k++) {
        const target = first + step * k;
        while (segment < path.length - 2 && run + Math.hypot(path[segment + 1][0] - path[segment][0], path[segment + 1][1] - path[segment][1]) < target) {
            run += Math.hypot(path[segment + 1][0] - path[segment][0], path[segment + 1][1] - path[segment][1]);
            segment++;
        }
        const ex = path[segment + 1][0] - path[segment][0];
        const ey = path[segment + 1][1] - path[segment][1];
        const length = Math.hypot(ex, ey);
        const t = length > 0 ? Math.min(1, Math.max(0, (target - run) / length)) : 0;
        out.push({ at: [path[segment][0] + ex * t, path[segment][1] + ey * t], angle: Math.atan2(ey, ex), along: target });
    }
    return out;
};

/**
 * Where `p` lies in the quad a (0, 0), b (1, 0), c (0, 1), d (1, 1): the (s, t) that bilinear
 * blending maps there. Null when no such place lies within the quad (give or take `slack`).
 */
export const quadPlace = (p: Point, a: Point, b: Point, c: Point, d: Point, slack = 1e-6): Point | null => {
    const cross = (x: Point, y: Point) => x[0] * y[1] - x[1] * y[0];
    const e: Point = [b[0] - a[0], b[1] - a[1]];
    const f: Point = [c[0] - a[0], c[1] - a[1]];
    const g: Point = [a[0] - b[0] - c[0] + d[0], a[1] - b[1] - c[1] + d[1]];
    const h: Point = [p[0] - a[0], p[1] - a[1]];
    const k2 = cross(g, f);
    const k1 = cross(e, f) + cross(h, g);
    const k0 = cross(h, e);
    const roots: number[] = [];
    if (Math.abs(k2) < 1e-10) {
        if (Math.abs(k1) > 1e-12) roots.push(-k0 / k1);
    } else {
        const disc = k1 * k1 - 4 * k2 * k0;
        if (disc >= 0) {
            const r = Math.sqrt(disc);
            roots.push((-k1 - r) / (2 * k2), (-k1 + r) / (2 * k2));
        }
    }
    for (const t of roots) {
        if (t < -slack || t > 1 + slack) continue;
        const across: Point = [e[0] + g[0] * t, e[1] + g[1] * t];
        const s = ((h[0] - f[0] * t) * across[0] + (h[1] - f[1] * t) * across[1]) / Math.max(across[0] ** 2 + across[1] ** 2, 1e-12);
        if (s >= -slack && s <= 1 + slack) return [s, t];
    }
    return null;
};

/**
 * Closed outlines of where a repeating grid of values (`width` x `height`, bottom row first, read at
 * pixel middles) crosses `level`, by marching squares. A path running over an edge carries on past it
 * (places below 0 or above 1), so each path is one unbroken line.
 */
export const traceOutlines = (values: Float32Array, width: number, height: number, level = 0.5): Point[][] => {
    const value = (x: number, y: number) => values[(((y % height) + height) % height) * width + (((x % width) + width) % width)];
    // Where the level crosses each grid edge: 'h' edges run from (x, y) to (x + 1, y), 'v' from (x, y) to (x, y + 1).
    const place = (key: string): Point => {
        const [kind, xs, ys] = key.split(':');
        const x = Number(xs);
        const y = Number(ys);
        const v0 = value(x, y);
        const v1 = kind === 'h' ? value(x + 1, y) : value(x, y + 1);
        const t = Math.abs(v1 - v0) < 1e-9 ? 0.5 : Math.min(1, Math.max(0, (level - v0) / (v1 - v0)));
        return kind === 'h' ? [(x + 0.5 + t) / width, (y + 0.5) / height] : [(x + 0.5) / width, (y + 0.5 + t) / height];
    };
    const links = new Map<string, string[]>();
    const join = (from: string, to: string) => {
        links.set(from, [...(links.get(from) ?? []), to]);
        links.set(to, [...(links.get(to) ?? []), from]);
    };
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const x1 = (x + 1) % width;
            const y1 = (y + 1) % height;
            const bl = value(x, y) >= level ? 1 : 0;
            const br = value(x1, y) >= level ? 2 : 0;
            const tr = value(x1, y1) >= level ? 4 : 0;
            const tl = value(x, y1) >= level ? 8 : 0;
            const index = bl | br | tr | tl;
            if (index === 0 || index === 15) continue;
            const bottom = `h:${x}:${y}`;
            const top = `h:${x}:${y1}`;
            const left = `v:${x}:${y}`;
            const right = `v:${x1}:${y}`;
            const centre = (value(x, y) + value(x1, y) + value(x1, y1) + value(x, y1)) / 4 >= level;
            switch (index) {
                case 1: case 14: join(left, bottom); break;
                case 2: case 13: join(bottom, right); break;
                case 3: case 12: join(left, right); break;
                case 4: case 11: join(right, top); break;
                case 6: case 9: join(bottom, top); break;
                case 7: case 8: join(left, top); break;
                case 5: if (centre) { join(left, top); join(bottom, right); } else { join(left, bottom); join(right, top); } break;
                case 10: if (centre) { join(left, bottom); join(right, top); } else { join(left, top); join(bottom, right); } break;
                default: break;
            }
        }
    }
    const seen = new Set<string>();
    const outlines: Point[][] = [];
    for (const start of links.keys()) {
        if (seen.has(start)) continue;
        const path: Point[] = [];
        let previous: string | null = null;
        let current: string | null = start;
        while (current && !seen.has(current)) {
            seen.add(current);
            const point = place(current);
            // Carry on past an edge rather than jumping back across the picture.
            if (path.length) {
                const last = path[path.length - 1];
                point[0] += Math.round(last[0] - point[0]);
                point[1] += Math.round(last[1] - point[1]);
            }
            path.push(point);
            const next: string | undefined = (links.get(current) ?? []).find((candidate) => candidate !== previous && !seen.has(candidate));
            previous = current;
            current = next ?? null;
        }
        if (path.length >= 3) {
            const first = path[0];
            const last = path[path.length - 1];
            path.push([first[0] + Math.round(last[0] - first[0]), first[1] + Math.round(last[1] - first[1])]);
            outlines.push(path);
        }
    }
    return outlines;
};

/** A polyline with points dropped while it stays within `tolerance` of the original (Ramer-Douglas-Peucker). */
export const simplify = (path: readonly Point[], tolerance: number): Point[] => {
    if (path.length < 3 || tolerance <= 0) return path.map((point) => [point[0], point[1]]);
    const keep = new Uint8Array(path.length);
    keep[0] = 1;
    keep[path.length - 1] = 1;
    const stack: Array<[number, number]> = [[0, path.length - 1]];
    while (stack.length) {
        const [from, to] = stack.pop()!;
        const a = path[from];
        const b = path[to];
        const ex = b[0] - a[0];
        const ey = b[1] - a[1];
        const length = Math.hypot(ex, ey);
        let worst = -1;
        let at = -1;
        for (let i = from + 1; i < to; i++) {
            const p = path[i];
            const distance = length > 1e-12 ? Math.abs(ex * (p[1] - a[1]) - ey * (p[0] - a[0])) / length : Math.hypot(p[0] - a[0], p[1] - a[1]);
            if (distance > worst) { worst = distance; at = i; }
        }
        if (worst > tolerance && at > 0) {
            keep[at] = 1;
            stack.push([from, at], [at, to]);
        }
    }
    return path.filter((_, index) => keep[index]).map((point) => [point[0], point[1]]);
};

// ---- path tools: curves on wires, changed ----

const samePlace = (a: Point, b: Point): boolean => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

/** Whether a polyline comes back to where it starts (a closed loop). */
export const isLoop = (path: readonly Point[]): boolean => path.length > 2 && samePlace(path[0], path[path.length - 1]);

/** A path's own points: repeats in a row dropped, and a closed one's repeated end too (`loop` says whether it was one). */
const ownPoints = (path: readonly Point[], closed: boolean): { points: Point[]; loop: boolean } => {
    const points: Point[] = [];
    for (const point of path) if (!points.length || !samePlace(points[points.length - 1], point)) points.push([point[0], point[1]]);
    const loop = closed && points.length > 2 && samePlace(points[0], points[points.length - 1]);
    if (loop) points.pop();
    return { points, loop: closed && points.length > 2 };
};

/** Back to a polyline: a loop ends where it starts. */
const closedAgain = (points: Point[], loop: boolean): Point[] => (loop && points.length ? [...points, [points[0][0], points[0][1]]] : points);

/**
 * A polyline moved `distance` to its left (negative: to its right), each corner mitred (at most four times
 * the distance out). Loops stay loops; a large distance on a tight bend can cross itself.
 */
export const offsetPath = (path: readonly Point[], closed: boolean, distance: number): Point[] => {
    const { points, loop } = ownPoints(path, closed);
    const n = points.length;
    if (n < 2 || distance === 0) return closedAgain(points, loop);
    const normalOf = (a: Point, b: Point): Point => {
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        return [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
    };
    const out: Point[] = [];
    for (let i = 0; i < n; i++) {
        const before = i > 0 ? points[i - 1] : loop ? points[n - 1] : null;
        const after = i < n - 1 ? points[i + 1] : loop ? points[0] : null;
        const n1 = before ? normalOf(before, points[i]) : null;
        const n2 = after ? normalOf(points[i], after) : null;
        let normal: Point = (n1 ?? n2)!;
        let reach = 1;
        if (n1 && n2) {
            const sum: Point = [n1[0] + n2[0], n1[1] + n2[1]];
            const length = Math.hypot(sum[0], sum[1]);
            if (length > 1e-9) {
                normal = [sum[0] / length, sum[1] / length];
                reach = Math.min(4, 1 / Math.max(0.25, normal[0] * n1[0] + normal[1] * n1[1]));
            }
        }
        out.push([points[i][0] + normal[0] * distance * reach, points[i][1] + normal[1] * distance * reach]);
    }
    return closedAgain(out, loop);
};

/**
 * A polyline with its corners cut round `passes` times (each cut `amount` of the way, 0 to 1): a smoother path
 * along the same course. An open path keeps its ends; the points stop doubling at `limit`.
 */
export const roundCorners = (path: readonly Point[], closed: boolean, passes: number, amount = 1, limit = 4096): Point[] => {
    const own = ownPoints(path, closed);
    const loop = own.loop;
    let points = own.points;
    const cut = 0.25 * Math.min(1, Math.max(0, amount));
    for (let pass = 0; pass < passes && points.length >= 3 && cut > 0 && points.length * 2 <= limit; pass++) {
        const n = points.length;
        const next: Point[] = loop ? [] : [points[0]];
        for (let i = 0; i < (loop ? n : n - 1); i++) {
            const a = points[i];
            const b = points[(i + 1) % n];
            next.push([a[0] + (b[0] - a[0]) * cut, a[1] + (b[1] - a[1]) * cut], [a[0] + (b[0] - a[0]) * (1 - cut), a[1] + (b[1] - a[1]) * (1 - cut)]);
        }
        if (!loop) next.push(points[n - 1]);
        points = next;
    }
    return closedAgain(points, loop);
};

/** A polyline as `count` spans of even length (a loop stays a loop). */
export const evenSpans = (path: readonly Point[], count: number): Point[] => resample(path, Math.max(1, Math.round(count)) + 1);

/**
 * Paths made to fit `limit` segments between them: simplified harder until they do, then (if they still do
 * not) cut to even spans shared out by length.
 */
export const fitSegments = (paths: readonly (readonly Point[])[], limit: number): Point[][] => {
    const count = (list: readonly (readonly Point[])[]) => list.reduce((sum, path) => sum + Math.max(0, path.length - 1), 0);
    if (count(paths) <= limit) return paths.map((path) => path.map((point): Point => [point[0], point[1]]));
    let tolerance = 1e-4;
    for (let tries = 0; tries < 10; tries++, tolerance *= 2) {
        const simplified = paths.map((path) => simplify(path, tolerance));
        if (count(simplified) <= limit) return simplified;
    }
    const lengths = paths.map(pathLength);
    const total = lengths.reduce((sum, length) => sum + length, 0) || 1;
    return paths.map((path, i) => evenSpans(path, Math.max(1, Math.floor((limit - paths.length) * lengths[i] / total))));
};
