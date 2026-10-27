/** Default crossfade when a transition has no usable duration. */
export const DEFAULT_BLEND_SECONDS = 0.2;

/** Frames longer than this are treated as this long, so a hitch does not snap blends. */
export const MAX_ANIMATION_DELTA = 0.1;

export const clampAnimationDelta = (delta: number) =>
    Number.isFinite(delta) && delta > 0 ? Math.min(delta, MAX_ANIMATION_DELTA) : 0;

export const blendSeconds = (duration: unknown) =>
    typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : DEFAULT_BLEND_SECONDS;

/**
 * Moves a weight linearly toward its target so a full 0->1 crossfade takes `duration` seconds,
 * independent of frame rate. A zero duration snaps.
 */
export const stepWeight = (current: number, target: number, delta: number, duration: number): number => {
    if (duration <= 0) return target;
    const step = delta / duration;
    return current < target ? Math.min(target, current + step) : Math.max(target, current - step);
};

/** A blend-space sample; a 1D blend reads only `position[0]`. */
export interface BlendSample2D {
    position: [number, number];
}

type Vec2 = [number, number];
type Triangle = [number, number, number];

/** Positions closer than this fraction of the blend space's extent count as the same position. */
const POSITION_EPSILON = 1e-6;
/** Samples whose spread off their common line is below this fraction of the extent blend as a line. */
const COLLINEAR_EPSILON = 1e-5;
/** Barycentric coordinates this far below zero still count as inside a triangle. */
const INSIDE_EPSILON = 1e-9;
/** Weights below this are rounding noise and are dropped before normalising. */
const WEIGHT_EPSILON = 1e-9;
/** Half-size of the Bowyer-Watson super-triangle, in blend-space extents. */
const SUPER_TRIANGLE_SIZE = 1e5;
/** Blend spaces kept triangulated; the oldest is dropped past this. */
const BLEND_SPACE_CACHE_LIMIT = 64;

const finiteOr = (value: unknown, fallback = 0) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/**
 * Weights along one axis: the nearest value on each side of `x` share the weight linearly,
 * `x` past either end gives that end the whole weight, and equal values split their share.
 */
const lineWeights = (values: number[], x: number): number[] => {
    if (!values.length) return [];
    let below = -Infinity;
    let above = Infinity;
    values.forEach(value => {
        if (value <= x && value > below) below = value;
        if (value >= x && value < above) above = value;
    });
    if (below === -Infinity) below = above;
    if (above === Infinity) above = below;
    const t = above === below ? 0 : (x - below) / (above - below);
    const belowCount = values.filter(value => value === below).length;
    const aboveCount = values.filter(value => value === above).length;
    return values.map(value => {
        if (value === below) return (1 - t) / belowCount;
        if (value === above) return t / aboveCount;
        return 0;
    });
};

/**
 * Weights for a 1D blend space over `position[0]`: linear between the two neighbouring samples,
 * clamped to the end samples, samples at the same position sharing their weight. Weights sum to 1;
 * no samples gives []. A non-finite `x` reads as 0.
 */
export const blendWeights1D = (samples: BlendSample2D[], x: number): number[] =>
    lineWeights(samples.map(sample => finiteOr(sample.position?.[0])), finiteOr(x));

interface DistinctPoints {
    /** Distinct positions, centred on the samples' bounding box and scaled so its longer side is 1. */
    points: Vec2[];
    /** Input indices at each distinct position. */
    groups: number[][];
    centre: Vec2;
    scale: number;
}

const distance = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Twice the signed area of (o, a, b); positive when counter-clockwise. */
const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

const distinctPoints = (positions: Vec2[]): DistinctPoints => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    positions.forEach(([x, y]) => {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    });
    const extent = Math.max(maxX - minX, maxY - minY);
    const scale = extent > 0 ? extent : 1;
    const centre: Vec2 = positions.length ? [(minX + maxX) / 2, (minY + maxY) / 2] : [0, 0];
    const points: Vec2[] = [];
    const groups: number[][] = [];
    positions.forEach(([x, y], index) => {
        const point: Vec2 = [(x - centre[0]) / scale, (y - centre[1]) / scale];
        const match = points.findIndex(other => distance(other, point) <= POSITION_EPSILON);
        if (match >= 0) {
            groups[match].push(index);
        } else {
            points.push(point);
            groups.push([index]);
        }
    });
    return { points, groups, centre, scale };
};

/** Barycentric coordinates of `p` in a counter-clockwise triangle, or null for a degenerate one. */
const barycentric = (points: Vec2[], [a, b, c]: Triangle, p: Vec2): [number, number, number] | null => {
    const area = cross(points[a], points[b], points[c]);
    if (!(area > 0)) return null;
    return [cross(p, points[b], points[c]) / area, cross(points[a], p, points[c]) / area, cross(points[a], points[b], p) / area];
};

interface WorkingTriangle {
    vertices: Triangle;
    centreX: number;
    centreY: number;
    /** Squared circumradius; -1 for a degenerate triangle, so no point falls inside its circle. */
    radiusSquared: number;
}

const makeTriangle = (points: Vec2[], a: number, b: number, c: number): WorkingTriangle => {
    const vertices: Triangle = cross(points[a], points[b], points[c]) < 0 ? [a, c, b] : [a, b, c];
    const [ax, ay] = points[vertices[0]];
    const bx = points[vertices[1]][0] - ax;
    const by = points[vertices[1]][1] - ay;
    const cx = points[vertices[2]][0] - ax;
    const cy = points[vertices[2]][1] - ay;
    const d = 2 * (bx * cy - by * cx);
    if (d === 0) return { vertices, centreX: ax, centreY: ay, radiusSquared: -1 };
    const b2 = bx * bx + by * by;
    const c2 = cx * cx + cy * cy;
    const ux = (cy * b2 - by * c2) / d;
    const uy = (bx * c2 - cx * b2) / d;
    return { vertices, centreX: ax + ux, centreY: ay + uy, radiusSquared: ux * ux + uy * uy };
};

const inCircumcircle = (triangle: WorkingTriangle, p: Vec2) =>
    (p[0] - triangle.centreX) ** 2 + (p[1] - triangle.centreY) ** 2 < triangle.radiusSquared;

const hasEdge = (triangle: WorkingTriangle, u: number, v: number) =>
    triangle.vertices.includes(u) && triangle.vertices.includes(v);

const edgesOf = ([a, b, c]: Triangle): [number, number][] => [[a, b], [b, c], [c, a]];

/**
 * Bowyer-Watson Delaunay triangulation of distinct points inside the unit box around the origin.
 * Each insertion removes the cavity of triangles whose circumcircle holds the new point and fans
 * the cavity's outline to it. The cavity grows only across edges from the triangle that contains
 * the point, so near-cocircular samples (a ring of directions) cannot split it into pieces.
 * Returns counter-clockwise triangles; collinear input gives none.
 */
const bowyerWatson = (points: Vec2[]): Triangle[] => {
    const count = points.length;
    if (count < 3) return [];
    const s = SUPER_TRIANGLE_SIZE;
    const all: Vec2[] = [...points, [-s, -s], [s, -s], [0, s]];
    let triangles: WorkingTriangle[] = [makeTriangle(all, count, count + 1, count + 2)];
    for (let index = 0; index < count; index++) {
        const point = all[index];
        let seed = -1;
        let seedDepth = -Infinity;
        triangles.forEach((triangle, triangleIndex) => {
            const weights = barycentric(all, triangle.vertices, point);
            const depth = weights ? Math.min(...weights) : -Infinity;
            if (depth > seedDepth) {
                seedDepth = depth;
                seed = triangleIndex;
            }
        });
        if (seed < 0) continue;
        const cavity = new Set<number>([seed]);
        const pending = [seed];
        for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
            edgesOf(triangles[current].vertices).forEach(([u, v]) => {
                const neighbour = triangles.findIndex((triangle, k) => k !== current && hasEdge(triangle, u, v));
                if (neighbour >= 0 && !cavity.has(neighbour) && inCircumcircle(triangles[neighbour], point)) {
                    cavity.add(neighbour);
                    pending.push(neighbour);
                }
            });
        }
        const outline: [number, number][] = [];
        cavity.forEach(k => {
            edgesOf(triangles[k].vertices).forEach(([u, v]) => {
                const shared = [...cavity].some(j => j !== k && hasEdge(triangles[j], u, v));
                if (!shared) outline.push([u, v]);
            });
        });
        triangles = triangles.filter((_, k) => !cavity.has(k));
        outline.forEach(([u, v]) => triangles.push(makeTriangle(all, u, v, index)));
    }
    return triangles
        .map(triangle => triangle.vertices)
        .filter(vertices => vertices.every(vertex => vertex < count) && cross(all[vertices[0]], all[vertices[1]], all[vertices[2]]) > 1e-12);
};

interface BlendSpace2D {
    distinct: DistinctPoints;
    /** Counter-clockwise triangles over the distinct points. */
    triangles: Triangle[];
    /** Edges on the outline of the triangulated area, for points outside it. */
    outline: [number, number][];
    /** For collinear samples, the line they lie on and each distinct point's offset along it. */
    line: { origin: Vec2; direction: Vec2; offsets: number[] } | null;
    /** The triangles as sample indices (the first sample at each position). */
    sampleTriangles: Triangle[];
}

const buildBlendSpace = (positions: Vec2[]): BlendSpace2D => {
    const distinct = distinctPoints(positions);
    const { points, groups } = distinct;
    let triangles: Triangle[] = [];
    let line: BlendSpace2D['line'] = null;
    if (points.length >= 2) {
        const farthestFrom = (from: Vec2) =>
            points.reduce((best, point) => (distance(point, from) > distance(best, from) ? point : best), from);
        const origin = farthestFrom(points[0]);
        const end = farthestFrom(origin);
        const length = distance(origin, end);
        const direction: Vec2 = [(end[0] - origin[0]) / length, (end[1] - origin[1]) / length];
        const spread = Math.max(...points.map(point =>
            Math.abs((point[0] - origin[0]) * direction[1] - (point[1] - origin[1]) * direction[0])));
        if (spread > COLLINEAR_EPSILON) triangles = bowyerWatson(points);
        if (!triangles.length) {
            line = {
                origin,
                direction,
                offsets: points.map(point => (point[0] - origin[0]) * direction[0] + (point[1] - origin[1]) * direction[1]),
            };
        }
    }
    const edgeUses = new Map<string, number>();
    const edgeKey = (u: number, v: number) => (u < v ? `${u}:${v}` : `${v}:${u}`);
    triangles.forEach(triangle => edgesOf(triangle).forEach(([u, v]) => {
        edgeUses.set(edgeKey(u, v), (edgeUses.get(edgeKey(u, v)) ?? 0) + 1);
    }));
    const outline = triangles.flatMap(triangle => edgesOf(triangle).filter(([u, v]) => edgeUses.get(edgeKey(u, v)) === 1));
    const sampleTriangles = triangles.map(([a, b, c]): Triangle => [groups[a][0], groups[b][0], groups[c][0]]);
    return { distinct, triangles, outline, line, sampleTriangles };
};

const blendSpaceCache = new Map<string, BlendSpace2D>();

/** The triangulated blend space for these sample positions, built once per distinct layout. */
const blendSpaceFor = (samples: BlendSample2D[]): BlendSpace2D => {
    const positions = samples.map((sample): Vec2 => [finiteOr(sample.position?.[0]), finiteOr(sample.position?.[1])]);
    const key = positions.map(([x, y]) => `${x},${y}`).join(';');
    const cached = blendSpaceCache.get(key);
    if (cached) return cached;
    const space = buildBlendSpace(positions);
    blendSpaceCache.set(key, space);
    if (blendSpaceCache.size > BLEND_SPACE_CACHE_LIMIT) {
        const oldest = blendSpaceCache.keys().next().value;
        if (oldest !== undefined) blendSpaceCache.delete(oldest);
    }
    return space;
};

/** Clamps tiny negatives and rounding noise to zero and rescales so the weights sum to 1. */
const normalised = (weights: number[]) => {
    const cleaned = weights.map(weight => (weight < WEIGHT_EPSILON ? 0 : Math.min(weight, 1)));
    const total = cleaned.reduce((sum, weight) => sum + weight, 0);
    return total > 0 ? cleaned.map(weight => weight / total) : cleaned;
};

/** Weights per distinct point for a query in the space's normalised coordinates. */
const distinctWeights = (space: BlendSpace2D, query: Vec2): number[] => {
    const { points } = space.distinct;
    const oneHot = (index: number) => points.map((_, i) => (i === index ? 1 : 0));
    let nearest = 0;
    points.forEach((point, index) => {
        if (distance(point, query) < distance(points[nearest], query)) nearest = index;
    });
    if (points.length === 1 || distance(points[nearest], query) <= POSITION_EPSILON) return oneHot(nearest);

    if (space.line) {
        const { origin, direction, offsets } = space.line;
        const offset = (query[0] - origin[0]) * direction[0] + (query[1] - origin[1]) * direction[1];
        return normalised(lineWeights(offsets, offset));
    }

    const result = points.map(() => 0);
    let containing: { triangle: Triangle; weights: [number, number, number] } | null = null;
    let depth = -Infinity;
    for (const triangle of space.triangles) {
        const weights = barycentric(points, triangle, query);
        const triangleDepth = weights ? Math.min(...weights) : -Infinity;
        if (weights && triangleDepth > depth) {
            depth = triangleDepth;
            containing = { triangle, weights };
        }
    }
    if (containing && depth >= -INSIDE_EPSILON) {
        const { triangle, weights } = containing;
        triangle.forEach((vertex, corner) => { result[vertex] = weights[corner]; });
        return normalised(result);
    }

    // Outside the hull: project onto the nearest outline edge and blend its two samples linearly.
    let nearestEdge: { u: number; v: number; t: number; gap: number } | null = null;
    for (const [u, v] of space.outline) {
        const a = points[u];
        const b = points[v];
        const ex = b[0] - a[0];
        const ey = b[1] - a[1];
        const t = Math.min(1, Math.max(0, ((query[0] - a[0]) * ex + (query[1] - a[1]) * ey) / (ex * ex + ey * ey)));
        const gap = Math.hypot(query[0] - (a[0] + ex * t), query[1] - (a[1] + ey * t));
        if (!nearestEdge || gap < nearestEdge.gap) nearestEdge = { u, v, t, gap };
    }
    if (!nearestEdge) return oneHot(nearest);
    result[nearestEdge.u] += 1 - nearestEdge.t;
    result[nearestEdge.v] += nearestEdge.t;
    return normalised(result);
};

/**
 * Weights for a 2D blend space. The sample positions are Delaunay-triangulated (cached per layout);
 * inside a triangle the three corner samples get barycentric weights, and outside the hull the
 * point is projected onto the nearest hull edge and that edge's two samples blend linearly.
 * One sample takes all the weight, and two or collinear samples blend in 1D along their line.
 * Samples at the same position share their weight; a sample's own position gives it exactly 1.
 * Weights sum to 1; no samples gives []. Non-finite coordinates read as 0.
 */
export const blendWeights2D = (samples: BlendSample2D[], x: number, y: number): number[] => {
    if (!samples.length) return [];
    const space = blendSpaceFor(samples);
    const { centre, scale, groups } = space.distinct;
    const query: Vec2 = [(finiteOr(x) - centre[0]) / scale, (finiteOr(y) - centre[1]) / scale];
    const weights = samples.map(() => 0);
    distinctWeights(space, query).forEach((weight, index) => {
        groups[index].forEach(sample => { weights[sample] = weight / groups[index].length; });
    });
    return weights;
};

/**
 * The Delaunay triangles of a 2D blend space as sample-index triples, counter-clockwise, from the
 * same cache the weights use. Samples sharing a position appear once (the first of them); one or
 * two samples, or collinear samples, give no triangles. Do not mutate the result.
 */
export const blendSpaceTriangles = (samples: BlendSample2D[]): ReadonlyArray<readonly [number, number, number]> =>
    blendSpaceFor(samples).sampleTriangles;
