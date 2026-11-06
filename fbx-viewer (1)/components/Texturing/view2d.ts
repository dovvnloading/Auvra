/**
 * THE 2D VIEW'S MATHS
 *
 * Where a point of the image (u right, v up, 0 to 1) falls in the view and back, the histogram of an
 * image and the share of its pixels in a range, and the on-screen handles: where each sits for a
 * node's settings, and the settings a dragged handle gives. Transform, Tile sampler, Linear gradient
 * and Shape nodes have handles.
 */

export interface ViewPlacement {
    /** The view's size, in device pixels. */
    width: number;
    height: number;
    /** Device pixels to a CSS pixel. */
    ratio: number;
    /** The image's middle from the view's middle, in device pixels (y up). */
    panX: number;
    panY: number;
    /** Device pixels to an image pixel. */
    zoom: number;
    imageWidth: number;
    imageHeight: number;
}

export interface UV { u: number; v: number }
export interface ScreenPoint { x: number; y: number }

/** A point of the image in the view's CSS pixels, from its top left. */
export const uvToView = (point: UV, placement: ViewPlacement): ScreenPoint => ({
    x: ((point.u - 0.5) * placement.zoom * placement.imageWidth + placement.width / 2 + placement.panX) / placement.ratio,
    y: (placement.height - ((point.v - 0.5) * placement.zoom * placement.imageHeight + placement.height / 2 + placement.panY)) / placement.ratio,
});

/** The point of the image under a point of the view (CSS pixels from its top left). */
export const viewToUv = (point: ScreenPoint, placement: ViewPlacement): UV => ({
    u: (point.x * placement.ratio - placement.width / 2 - placement.panX) / (placement.zoom * placement.imageWidth) + 0.5,
    v: (placement.height - point.y * placement.ratio - placement.height / 2 - placement.panY) / (placement.zoom * placement.imageHeight) + 0.5,
});

// ---- histogram ----

export interface Histogram {
    red: number[];
    green: number[];
    blue: number[];
    /** Brightness, as the editor measures it everywhere (0.2126 R + 0.7152 G + 0.0722 B). */
    luma: number[];
    total: number;
}

/** The histogram of 8-bit RGBA pixels, in `bins` steps from 0 to 1. */
export const histogramOf = (pixels: ArrayLike<number>, bins = 64): Histogram => {
    const make = () => new Array<number>(bins).fill(0);
    const result: Histogram = { red: make(), green: make(), blue: make(), luma: make(), total: 0 };
    const bin = (value: number) => Math.min(bins - 1, Math.max(0, Math.floor((value / 256) * bins)));
    for (let i = 0; i + 3 < pixels.length; i += 4) {
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        result.red[bin(r)]++;
        result.green[bin(g)]++;
        result.blue[bin(b)]++;
        result.luma[bin(0.2126 * r + 0.7152 * g + 0.0722 * b)]++;
        result.total++;
    }
    return result;
};

/** The share of pixels (0 to 1) whose value lies from `low` to `high` (0 to 1), counted by whole bins. */
export const rangeShare = (bins: readonly number[], low: number, high: number): number => {
    const total = bins.reduce((sum, count) => sum + count, 0);
    if (!total) return 0;
    const from = Math.min(low, high);
    const to = Math.max(low, high);
    let inside = 0;
    bins.forEach((count, index) => {
        const middle = (index + 0.5) / bins.length;
        if (middle >= from && middle <= to) inside += count;
    });
    return inside / total;
};

// ---- handles ----

export type Vec2 = [number, number];

const turn = (vector: Vec2, degrees: number): Vec2 => {
    const a = (degrees * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [vector[0] * c - vector[1] * s, vector[0] * s + vector[1] * c];
};
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const angleOf = (vector: Vec2): number => (Math.atan2(vector[1], vector[0]) * 180) / Math.PI;
/** An angle brought into -180 to 180 degrees, to a tenth. */
export const wrapAngle = (degrees: number): number => {
    const wrapped = ((((degrees + 180) % 360) + 360) % 360) - 180;
    return Math.round(wrapped * 10) / 10;
};
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const keepSign = (value: number, minimum: number): number => (Math.abs(value) < minimum ? (value < 0 ? -minimum : minimum) : value);

/** Where a node's handles sit (image points), and what they look like. */
export interface HandleFrame {
    /** The outline of what the handles move (a quad), or none. */
    outline: Vec2[];
    /** The draggable points: `key` names what dragging it changes. */
    points: Array<{ key: string; at: Vec2; look: 'move' | 'turn' | 'size' | 'end' }>;
    /** A line drawn between two points (a gradient's ends), or none. */
    line?: [Vec2, Vec2];
}

// Transform: an output point samples the input at R(turn) * (uv - 0.5 - offset) / scale + 0.5.
export interface TransformSettings { offset: Vec2; rotation: number; scale: Vec2 }

export const transformFrame = ({ offset, rotation, scale }: TransformSettings): HandleFrame => {
    const centre: Vec2 = [0.5 + offset[0], 0.5 + offset[1]];
    const corner = (sx: number, sy: number) => add(centre, turn([sx * 0.5 * scale[0], sy * 0.5 * scale[1]], -rotation));
    return {
        outline: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
        points: [
            { key: 'offset', at: centre, look: 'move' },
            { key: 'rotation', at: add(centre, turn([0, 0.5 * Math.abs(scale[1]) + 0.08], -rotation)), look: 'turn' },
            { key: 'scale', at: corner(1, 1), look: 'size' },
        ],
    };
};

/** A Transform's settings with one handle dragged to `to`. */
export const dragTransform = (settings: TransformSettings, key: string, to: Vec2, uniform = false): Partial<TransformSettings> => {
    const centre: Vec2 = [0.5 + settings.offset[0], 0.5 + settings.offset[1]];
    if (key === 'offset') return { offset: [clamp(to[0] - 0.5, -1, 1), clamp(to[1] - 0.5, -1, 1)] };
    if (key === 'rotation') return { rotation: wrapAngle(90 - angleOf([to[0] - centre[0], to[1] - centre[1]])) };
    const local = turn([to[0] - centre[0], to[1] - centre[1]], settings.rotation);
    let sx = keepSign(local[0] * 2, 0.01);
    let sy = keepSign(local[1] * 2, 0.01);
    if (uniform) {
        const size = Math.max(Math.abs(sx), Math.abs(sy));
        sx = Math.sign(sx) * size;
        sy = Math.sign(sy) * size;
    }
    return { scale: [Math.round(sx * 1000) / 1000, Math.round(sy * 1000) / 1000] };
};

// Shape: in a tile, p = R(-turn) * ((fract((uv - centre + 0.5) * repeat) - 0.5) * 2) / (size * stretch); its edge is at 1.
export interface ShapeSettings { centre: Vec2; size: number; stretch: Vec2; rotation: number; tiling: number }

export const shapeFrame = ({ centre, size, stretch, rotation, tiling }: ShapeSettings): HandleFrame => {
    const n = Math.max(1, tiling);
    const corner = (sx: number, sy: number) => add(centre, turn([(sx * size * stretch[0]) / (2 * n), (sy * size * stretch[1]) / (2 * n)], rotation));
    return {
        outline: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
        points: [
            { key: 'centre', at: centre, look: 'move' },
            { key: 'rotation', at: add(centre, turn([0, (size * stretch[1]) / (2 * n) + 0.06], rotation)), look: 'turn' },
            { key: 'size', at: corner(1, 1), look: 'size' },
        ],
    };
};

export const dragShape = (settings: ShapeSettings, key: string, to: Vec2): Partial<ShapeSettings> => {
    const n = Math.max(1, settings.tiling);
    if (key === 'centre') return { centre: [Math.round(clamp(to[0], 0, 1) * 1000) / 1000, Math.round(clamp(to[1], 0, 1) * 1000) / 1000] };
    const offset: Vec2 = [to[0] - settings.centre[0], to[1] - settings.centre[1]];
    if (key === 'rotation') return { rotation: wrapAngle(angleOf(offset) - 90) };
    const local = turn([offset[0] * 2 * n, offset[1] * 2 * n], -settings.rotation);
    const size = Math.max(Math.abs(local[0]) / Math.max(settings.stretch[0], 1e-4), Math.abs(local[1]) / Math.max(settings.stretch[1], 1e-4));
    return { size: Math.round(clamp(size, 0, 2) * 1000) / 1000 };
};

// Linear gradient: t = dot(uv - 0.5, (cos a, sin a)) / (|cos a| + |sin a|) + 0.5.
export const gradientFrame = (angle: number): HandleFrame => {
    const a = (angle * Math.PI) / 180;
    const half = (Math.abs(Math.cos(a)) + Math.abs(Math.sin(a))) / 2;
    const start: Vec2 = [0.5 - Math.cos(a) * half, 0.5 - Math.sin(a) * half];
    const end: Vec2 = [0.5 + Math.cos(a) * half, 0.5 + Math.sin(a) * half];
    return { outline: [], line: [start, end], points: [{ key: 'start', at: start, look: 'end' }, { key: 'end', at: end, look: 'end' }] };
};

/** A gradient's angle with its black end (`start`) or white end (`end`) dragged to `to`. */
export const dragGradient = (key: string, to: Vec2): { angle: number } => {
    const from: Vec2 = key === 'start' ? [0.5 - to[0], 0.5 - to[1]] : [to[0] - 0.5, to[1] - 0.5];
    return { angle: wrapAngle(angleOf(from)) };
};

// Tile sampler: on a grid of columns by rows, a copy round its cell's middle reaches size * stretch / 2
// cells each way, turned by its turn; every other row shifts by the row offset.
export interface TileSettings {
    columns: number;
    rows: number;
    size: number;
    stretch: Vec2;
    rotation: number;
    offset: number;
    /** A cell's random shift (in cells), as the node gives it, so the handles sit on the copies where they are drawn. */
    jitterAt?: (cell: Vec2) => Vec2;
}

/** The cell the handles sit on (near the middle) and the odd row the row offset shifts. */
const tileCells = ({ columns, rows }: TileSettings) => {
    const cx = Math.floor(Math.max(1, columns) / 2);
    const cy = Math.floor(Math.max(1, rows) / 2);
    return { cx, cy, odd: cy % 2 === 1 ? cy : cy + 1 };
};

const jitter = (settings: TileSettings, cell: Vec2): Vec2 => settings.jitterAt?.(cell) ?? [0, 0];

export const tileFrame = (settings: TileSettings): HandleFrame => {
    const grid: Vec2 = [Math.max(1, settings.columns), Math.max(1, settings.rows)];
    const { cx, cy, odd } = tileCells(settings);
    const toUv = (point: Vec2): Vec2 => [point[0] / grid[0], point[1] / grid[1]];
    const shift = jitter(settings, [cx, cy]);
    const oddShift = jitter(settings, [cx, odd]);
    const middle: Vec2 = [cx + 0.5 + (cy % 2 === 1 ? settings.offset : 0) + shift[0], cy + 0.5 + shift[1]];
    const reach: Vec2 = [settings.size * settings.stretch[0] * 0.5, settings.size * settings.stretch[1] * 0.5];
    const corner = (sx: number, sy: number) => toUv(add(middle, turn([sx * reach[0], sy * reach[1]], settings.rotation)));
    return {
        outline: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
        points: [
            { key: 'offset', at: toUv([cx + 0.5 + settings.offset + oddShift[0], odd + 0.5 + oddShift[1]]), look: 'move' },
            { key: 'rotation', at: toUv(add(middle, turn([0, reach[1] + 0.3], settings.rotation))), look: 'turn' },
            { key: 'size', at: corner(1, 1), look: 'size' },
        ],
    };
};

export const dragTile = (settings: TileSettings, key: string, to: Vec2): Partial<TileSettings> => {
    const grid: Vec2 = [Math.max(1, settings.columns), Math.max(1, settings.rows)];
    const { cx, cy } = tileCells(settings);
    const at: Vec2 = [to[0] * grid[0], to[1] * grid[1]];
    const { odd } = tileCells(settings);
    if (key === 'offset') return { offset: Math.round(clamp(at[0] - (cx + 0.5) - jitter(settings, [cx, odd])[0], 0, 1) * 1000) / 1000 };
    const shift = jitter(settings, [cx, cy]);
    const middle: Vec2 = [cx + 0.5 + (cy % 2 === 1 ? settings.offset : 0) + shift[0], cy + 0.5 + shift[1]];
    const offset: Vec2 = [at[0] - middle[0], at[1] - middle[1]];
    if (key === 'rotation') return { rotation: wrapAngle(angleOf(offset) - 90) };
    const local = turn(offset, -settings.rotation);
    const size = Math.max(Math.abs(local[0]) / Math.max(settings.stretch[0] * 0.5, 1e-4), Math.abs(local[1]) / Math.max(settings.stretch[1] * 0.5, 1e-4));
    return { size: Math.round(clamp(size, 0, 3) * 1000) / 1000 };
};
