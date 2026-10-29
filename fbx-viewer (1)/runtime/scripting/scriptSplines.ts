import type { ScriptSplineState, ScriptVec3 } from './protocol';

/**
 * SPLINES FOR SCRIPTS
 *
 * The runtime sends each spline to the script sandbox as points along it in world space (with the
 * up at each), once and again whenever it changes; ctx.spline(id) answers from them, in metres, so
 * scripts can place, aim and move things along paths without a round trip.
 */

/** ctx.spline(objectId): the spline of an object's Spline component, in world space and metres. */
export interface ScriptSpline {
    readonly length: number;
    readonly closed: boolean;
    /** Position, direction of travel and up `distance` metres along it: wrapped round a closed spline, stopped at the ends of an open one. */
    pointAt(distance: number): { position: ScriptVec3; direction: ScriptVec3; up: ScriptVec3 };
    /** The point on it nearest `point`, and how many metres along it that is. */
    closest(point: ScriptVec3): { distance: number; position: ScriptVec3 };
}

/** Most points one spline is sent as; longer splines are sampled more coarsely. */
export const MAX_SCRIPT_SPLINE_POINTS = 512;
/** Metres between the points a spline is sent as, at most. */
export const SCRIPT_SPLINE_STEP = 0.5;

const normalize = (x: number, y: number, z: number, fallback: ScriptVec3): ScriptVec3 => {
    const length = Math.hypot(x, y, z);
    return length > 1e-9 ? [x / length, y / length, z / length] : [...fallback];
};

export const createScriptSpline = (state: ScriptSplineState): ScriptSpline => {
    const { points, ups, closed } = state;
    const count = Math.floor(points.length / 3);
    const at = (i: number): ScriptVec3 => [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]];
    const upAt = (i: number): ScriptVec3 => (ups.length >= (i + 1) * 3 ? [ups[i * 3], ups[i * 3 + 1], ups[i * 3 + 2]] : [0, 1, 0]);
    // Cumulative distance at each point; a closed spline's last segment runs back to the first point.
    const segments = closed && count > 2 ? count : count - 1;
    const cumulative = new Float64Array(Math.max(1, segments + 1));
    for (let s = 0; s < segments; s++) {
        const a = at(s);
        const b = at((s + 1) % count);
        cumulative[s + 1] = cumulative[s] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
    const length = segments > 0 ? cumulative[segments] : 0;

    const wrap = (distance: number): number => {
        if (!(length > 1e-9) || !Number.isFinite(distance)) return 0;
        return closed && count > 2 ? ((distance % length) + length) % length : Math.min(length, Math.max(0, distance));
    };
    const segmentAt = (distance: number): number => {
        let low = 0;
        let high = segments;
        while (high - low > 1) {
            const middle = (low + high) >> 1;
            if (cumulative[middle] <= distance) low = middle;
            else high = middle;
        }
        return Math.min(low, Math.max(0, segments - 1));
    };

    return {
        length,
        closed: closed && count > 2,
        pointAt(distance) {
            if (count === 0) return { position: [0, 0, 0], direction: [0, 0, 1], up: [0, 1, 0] };
            if (segments <= 0) return { position: at(0), direction: [0, 0, 1], up: upAt(0) };
            const d = wrap(distance);
            const s = segmentAt(d);
            const a = at(s);
            const b = at((s + 1) % count);
            const span = cumulative[s + 1] - cumulative[s];
            const t = span > 1e-9 ? (d - cumulative[s]) / span : 0;
            const ua = upAt(s);
            const ub = upAt((s + 1) % count);
            return {
                position: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
                direction: normalize(b[0] - a[0], b[1] - a[1], b[2] - a[2], [0, 0, 1]),
                up: normalize(ua[0] + (ub[0] - ua[0]) * t, ua[1] + (ub[1] - ua[1]) * t, ua[2] + (ub[2] - ua[2]) * t, [0, 1, 0]),
            };
        },
        closest(point) {
            if (count === 0) return { distance: 0, position: [0, 0, 0] };
            let best = { distance: 0, position: at(0), squared: Infinity };
            for (let s = 0; s < Math.max(1, segments); s++) {
                const a = at(s);
                const b = segments > 0 ? at((s + 1) % count) : a;
                const ab: ScriptVec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
                const lengthSq = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
                const t = lengthSq > 1e-12
                    ? Math.min(1, Math.max(0, ((point[0] - a[0]) * ab[0] + (point[1] - a[1]) * ab[1] + (point[2] - a[2]) * ab[2]) / lengthSq))
                    : 0;
                const p: ScriptVec3 = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
                const squared = (p[0] - point[0]) ** 2 + (p[1] - point[1]) ** 2 + (p[2] - point[2]) ** 2;
                if (squared < best.squared) best = { distance: cumulative[s] + Math.sqrt(lengthSq) * t, position: p, squared };
            }
            return { distance: wrap(best.distance), position: best.position };
        },
    };
};
