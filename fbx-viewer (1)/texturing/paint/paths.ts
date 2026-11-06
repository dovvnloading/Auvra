/**
 * PATHS ON THE SURFACE
 *
 * A path is a line of points clicked on the model, each with its own size (a radius in model units) and
 * opacity, open or closed. It is drawn as a smooth curve through its points, sampled at even steps along
 * its length for dabs, ribbons, stitches and letters; size and opacity change smoothly between points.
 */

export type Vec3 = [number, number, number];

export interface PathPoint { position: Vec3; normal: Vec3; size: number; opacity: number }

/** How a path is laid on: with the brush, as a flat ribbon, as stitches from a texture graph, or as letters. */
export type PathStyle = 'brush' | 'ribbon' | 'stitches' | 'text';

export interface SurfacePath {
    id: string;
    name: string;
    points: PathPoint[];
    closed: boolean;
    style: PathStyle;
    /** Text along the path, its font (any the browser has) and the gap between stitches or letters (a share of their size). */
    text?: string;
    font?: string;
    gap?: number;
    /** Stitches: the texture graph whose first output each stitch is. */
    graphId?: string;
}

export interface PathSample { position: Vec3; normal: Vec3; size: number; opacity: number; /** Along the path, unit length. */ tangent: Vec3; /** Distance from the start. */ distance: number }

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const normalised = (a: Vec3): Vec3 => { const l = length(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** A point of the smooth curve (Catmull-Rom) between p1 and p2, `t` of the way. */
const curve = (p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 => {
    const t2 = t * t, t3 = t2 * t;
    return [0, 1, 2].map((k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)) as Vec3;
};

/**
 * The path sampled every `step` along its length (from its start; a closed path back round to it), with
 * size, opacity and normal blended between points. A path of one point gives that point.
 */
type Traced = Array<{ position: Vec3; normal: Vec3; size: number; opacity: number; distance: number }>;

/** A fine line along the curve through two or more points, with what each of its points carries. */
const trace = (points: readonly PathPoint[], closed: boolean): Traced => {
    const count = points.length;
    const at = (i: number) => points[closed ? ((i % count) + count) % count : Math.max(0, Math.min(count - 1, i))];
    const segments = closed ? count : count - 1;
    const fine: Traced = [];
    const pieces = 24;
    let travelled = 0;
    for (let s = 0; s < segments; s++) {
        const p0 = at(s - 1), p1 = at(s), p2 = at(s + 1), p3 = at(s + 2);
        for (let k = s === 0 ? 0 : 1; k <= pieces; k++) {
            const t = k / pieces;
            const position = curve(p0.position, p1.position, p2.position, p3.position, t);
            if (fine.length) travelled += length(sub(position, fine[fine.length - 1].position));
            fine.push({
                position,
                normal: normalised([0, 1, 2].map((axis) => p1.normal[axis] * (1 - t) + p2.normal[axis] * t) as Vec3),
                size: p1.size * (1 - t) + p2.size * t,
                opacity: p1.opacity * (1 - t) + p2.opacity * t,
                distance: travelled,
            });
        }
    }
    return fine;
};

export const samplePath = (points: readonly PathPoint[], step: number, closed: boolean): PathSample[] => {
    if (!points.length) return [];
    if (points.length === 1) {
        const p = points[0];
        return [{ position: [...p.position], normal: normalised(p.normal), size: p.size, opacity: p.opacity, tangent: [1, 0, 0], distance: 0 }];
    }
    const fine = trace(points, closed);
    const total = fine[fine.length - 1].distance;
    const samples: PathSample[] = [];
    const spacing = Math.max(step, total / 100000, 1e-9);
    let j = 0;
    for (let distance = 0; distance <= total + 1e-9; distance += spacing) {
        while (j < fine.length - 2 && fine[j + 1].distance < distance) j++;
        const a = fine[j], b = fine[Math.min(j + 1, fine.length - 1)];
        const span = b.distance - a.distance;
        const t = span > 0 ? Math.min(1, Math.max(0, (distance - a.distance) / span)) : 0;
        const mix = (x: number, y: number) => x * (1 - t) + y * t;
        samples.push({
            position: [0, 1, 2].map((axis) => mix(a.position[axis], b.position[axis])) as Vec3,
            normal: normalised([0, 1, 2].map((axis) => mix(a.normal[axis], b.normal[axis])) as Vec3),
            size: mix(a.size, b.size),
            opacity: mix(a.opacity, b.opacity),
            tangent: normalised(sub(b.position, a.position)),
            distance,
        });
    }
    return samples;
};

/** The length of a path's curve. */
export const pathLength = (points: readonly PathPoint[], closed: boolean): number => (points.length > 1 ? trace(points, closed).slice(-1)[0].distance : 0);

/**
 * Where letters (or stitches) of the given widths go along a path: each centred on its own stretch, one
 * after another from the start with `gap` between, until the path runs out. Returns each one's middle
 * distance along the path, or null for those that do not fit.
 */
export const layoutAlong = (widths: readonly number[], total: number, gap: number): Array<number | null> => {
    let at = 0;
    return widths.map((width) => {
        const middle = at + width / 2;
        at += width + gap;
        return middle + width / 2 <= total + 1e-9 ? middle : null;
    });
};

/** The sample nearest a distance along a path (samples in order). */
export const sampleAt = (samples: readonly PathSample[], distance: number): PathSample | null => {
    if (!samples.length) return null;
    let best = samples[0];
    for (const sample of samples) if (Math.abs(sample.distance - distance) < Math.abs(best.distance - distance)) best = sample;
    return best;
};

const finite = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const vector = (value: unknown, fallback: Vec3): Vec3 => (Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' && Number.isFinite(v)) ? [value[0], value[1], value[2]] : fallback);
const STYLES: readonly PathStyle[] = ['brush', 'ribbon', 'stitches', 'text'];

/** Stored paths made safe to use (at most 64 paths of 2000 points). */
export const readPaths = (value: unknown): SurfacePath[] => {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 64).flatMap((item): SurfacePath[] => {
        const path = item as Partial<SurfacePath> | null;
        if (!path || typeof path.id !== 'string' || !Array.isArray(path.points)) return [];
        return [{
            id: path.id,
            name: typeof path.name === 'string' ? path.name.slice(0, 80) : 'Path',
            points: path.points.slice(0, 2000).map((point) => ({
                position: vector(point?.position, [0, 0, 0]),
                normal: vector(point?.normal, [0, 1, 0]),
                size: Math.max(1e-6, finite(point?.size, 0.01)),
                opacity: Math.min(1, Math.max(0, finite(point?.opacity, 1))),
            })),
            closed: path.closed === true,
            style: STYLES.includes(path.style as PathStyle) ? path.style as PathStyle : 'brush',
            ...(typeof path.text === 'string' ? { text: path.text.slice(0, 500) } : {}),
            ...(typeof path.font === 'string' ? { font: path.font.slice(0, 80) } : {}),
            ...(path.gap !== undefined ? { gap: Math.min(10, Math.max(0, finite(path.gap, 0.2))) } : {}),
            ...(typeof path.graphId === 'string' ? { graphId: path.graphId } : {}),
        }];
    });
};
