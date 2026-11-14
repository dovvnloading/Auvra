import { evaluateCurve, particleCurveSegment, type Curve } from './particleEffect';

// Each span stores its normalized start, end, preceding area, and four integrated coefficients.
const SPAN_WORDS = 7;

/** Compile the area under the emitter's rate multiplier once per edit. A null table is the legacy flat rate. */
export function compileParticleRateCurve(curve?: Curve): Float64Array | null {
    const points = curve?.points;
    if (!points?.length || points.every(([, value]) => value === 1)) return null;
    const spans: number[] = [];
    let area = 0;
    function append(start: number, end: number, a: number, b = 0, c = 0, d = 0): void {
        if (end <= start) return;
        spans.push(start, end, area, a, b / 2, c / 3, d / 4);
        area += (end - start) * (a + b / 2 + c / 3 + d / 4);
    }
    const first = points[0];
    const last = points[points.length - 1];
    const interpolation = curve?.interpolation ?? 'linear';
    if (first[0] > 0) append(0, first[0], evaluateCurve(points, 0, interpolation));
    for (let i = 0; i + 1 < points.length; i++) {
        if (points[i + 1][0] <= points[i][0]) continue;
        append(points[i][0], points[i + 1][0], ...particleCurveSegment(points, i, interpolation));
    }
    append(last[0], 1, last[1]);
    return new Float64Array(spans);
}

function areaAt(table: Float64Array, time: number): number {
    // Authored curves have at most eight keys. Linear search also handles flat tails at either end.
    let i = 0;
    while (i + SPAN_WORDS < table.length && time > table[i + 1]) i += SPAN_WORDS;
    const width = table[i + 1] - table[i];
    const u = Math.max(0, Math.min(1, (time - table[i]) / width));
    const integral = u * (table[i + 3] + u * (table[i + 4] + u * (table[i + 5] + u * table[i + 6])));
    return table[i + 2] + width * integral;
}

/** Expected births between two times (seconds) within one cycle. The caller retains fractional births across steps. */
export function particleEmissionBetween(
    table: Float64Array | null, start: number, end: number, duration: number, rate: number,
): number {
    if (end <= start || rate <= 0) return 0;
    if (!table) return (end - start) * rate;
    const area = areaAt(table, end / duration) - areaAt(table, start / duration);
    return Math.max(0, area) * duration * rate;
}
