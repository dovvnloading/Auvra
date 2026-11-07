/**
 * TRANSFORMS THAT KEEP TILING
 *
 * A Transform reads its input at L·(place − middle − offset) + middle, where L turns and scales. A
 * picture that repeats every 1 across and down still repeats after that exactly when L takes a step of
 * one picture to a whole number of pictures: when L's numbers are whole. So a turn and size keep tiling
 * when snapped to the nearest whole-numbered L (a turn of atan(1/2) at a size of 1/√5, say). Or the
 * transform is kept exactly and the seams blended: the result mixes, near its far edges, with itself a
 * picture back, so its edges meet whatever the turn and size.
 */

/** A 2 × 2 matrix by rows: [a, b, c, d] is (a b / c d). */
export type Mat2 = [number, number, number, number];

/** The Transform's matrix from the result to the input (about the middle), as its shader works it. */
export const transformMatrix = (rotationDegrees: number, scale: readonly number[]): Mat2 => {
    const turn = rotationDegrees * Math.PI / 180;
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    const size = (value: number) => Math.max(Math.abs(value), 1e-4) * (value + 1e-9 < 0 ? -1 : 1);
    const sx = size(Number(scale[0]) || 0);
    const sy = size(Number(scale[1]) || 0);
    return [c / sx, -s / sx, s / sy, c / sy];
};

const determinant = (m: Mat2): number => m[0] * m[3] - m[1] * m[2];

/**
 * The nearest matrix with whole numbers that keeps a picture whole (not flat): each number rounded,
 * else the nearest of the roundings up and down of every number that is not flat.
 */
export const tileSafeMatrix = (m: Mat2): Mat2 => {
    const rounded = m.map((value) => Math.round(value)) as Mat2;
    if (determinant(rounded) !== 0) return rounded;
    let best: Mat2 = [1, 0, 0, 1];
    let distance = Infinity;
    for (let mask = 0; mask < 16; mask++) {
        const candidate = m.map((value, index) => Math.floor(value) + ((mask >> index) & 1)) as Mat2;
        if (determinant(candidate) === 0) continue;
        const d = candidate.reduce((sum, value, index) => sum + (value - m[index]) ** 2, 0);
        if (d < distance) { distance = d; best = candidate; }
    }
    return best;
};

/** A matrix read back as a turn (degrees) and size each way, and whether it also slants. */
export const describeMatrix = (m: Mat2): { rotation: number; scale: [number, number]; slant: boolean } => {
    const across = Math.hypot(m[0], m[1]);
    const down = Math.hypot(m[2], m[3]);
    const first = Math.atan2(-m[1], m[0]) * 180 / Math.PI;
    const second = Math.atan2(m[2], m[3]) * 180 / Math.PI;
    const gap = Math.abs(((first - second + 540) % 360) - 180);
    return { rotation: Number(first.toFixed(2)), scale: [across ? 1 / across : 0, down ? 1 / down : 0], slant: gap > 0.5 };
};

/** Where the result reads its input, for a matrix and an offset. */
export const transformPlace = (m: Mat2, offset: readonly number[], u: number, v: number): [number, number] => {
    const x = u - 0.5 - (Number(offset[0]) || 0);
    const y = v - 0.5 - (Number(offset[1]) || 0);
    return [m[0] * x + m[1] * y + 0.5, m[2] * x + m[3] * y + 0.5];
};

const smoothstep = (low: number, high: number, x: number): number => {
    const t = Math.min(1, Math.max(0, (x - low) / (high - low)));
    return t * t * (3 - 2 * t);
};

/**
 * The seam-blended result at a place, as its shader works it: the transformed input mixed, over the
 * last `blend` of the picture each way, with itself a picture back, so its edges meet.
 */
export const blendedSample = (read: (u: number, v: number) => number, u: number, v: number, blend: number): number => {
    const wx = smoothstep(1 - blend, 1, u);
    const wy = smoothstep(1 - blend, 1, v);
    return (1 - wx) * (1 - wy) * read(u, v) + wx * (1 - wy) * read(u - 1, v) + (1 - wx) * wy * read(u, v - 1) + wx * wy * read(u - 1, v - 1);
};

/** GLSL reading the input through the matrix `uMatrix` (rows) and the offset `p_offset`. */
export const TRANSFORM_READ = `uniform vec4 uMatrix;
vec2 transformed(vec2 uv) { vec2 q = uv - 0.5 - p_offset; return vec2(dot(uMatrix.xy, q), dot(uMatrix.zw, q)) + 0.5; }`;

/** GLSL for the seam blend: the result at a place from transformedColour(uv) and uBlend. */
export const SEAM_BLEND = `uniform float uBlend;
vec4 blended(vec2 uv) {
    vec2 w = smoothstep(vec2(1.0 - uBlend), vec2(1.0), uv);
    return (1.0 - w.x) * (1.0 - w.y) * transformedColour(uv) + w.x * (1.0 - w.y) * transformedColour(uv - vec2(1.0, 0.0))
        + (1.0 - w.x) * w.y * transformedColour(uv - vec2(0.0, 1.0)) + w.x * w.y * transformedColour(uv - vec2(1.0));
}`;

const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));

/**
 * The nearest direction to `degrees` a repeating picture stays seamless along: a step of whole numbers
 * (a, b) across and down, at most `limit` each, with no common factor. Along it, a pattern repeating a
 * whole number of times meets itself at the picture's edges.
 */
export const tileSafeDirection = (degrees: number, limit = 6): { step: [number, number]; degrees: number } => {
    const wanted = degrees * Math.PI / 180;
    let best: [number, number] = [1, 0];
    let gap = Infinity;
    for (let a = -limit; a <= limit; a++) {
        for (let b = -limit; b <= limit; b++) {
            if ((a === 0 && b === 0) || gcd(a, b) !== 1) continue;
            const angle = Math.atan2(b, a);
            const off = Math.abs(Math.atan2(Math.sin(angle - wanted), Math.cos(angle - wanted)));
            // Of two as near, the shorter step (broader pattern).
            if (off < gap - 1e-9 || (Math.abs(off - gap) < 1e-9 && Math.hypot(a, b) < Math.hypot(...best))) { gap = off; best = [a, b]; }
        }
    }
    return { step: best, degrees: Number((Math.atan2(best[1], best[0]) * 180 / Math.PI).toFixed(2)) };
};
