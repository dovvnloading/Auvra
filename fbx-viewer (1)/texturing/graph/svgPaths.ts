/**
 * SVG SHAPES INTO PATHS
 *
 * The outlines of an SVG drawing as polylines: path data (every command, curves cut into short
 * straight pieces, arcs worked out from their end points as the SVG format describes them), polygons,
 * polylines, rectangles (rounded too), circles, ellipses and lines, with the transforms of each element
 * and the groups round it. Pasting just a path's "d" text works as well as a whole file. The result is
 * fitted into the picture, which has v going up where SVG's y goes down.
 */

export type Point = [number, number];
export interface SvgPath { points: Point[]; closed: boolean }

/** An affine transform [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (m: Matrix, n: Matrix): Matrix => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, [x, y]: Point): Point => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Numbers in SVG's compact way of writing them ("1.5-2", ".5.5", "1e-3"). */
const numbersIn = (text: string): number[] => (text.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);

/** A transform attribute as one matrix. */
export const parseTransform = (text: string | null | undefined): Matrix => {
    if (!text) return IDENTITY;
    let result: Matrix = IDENTITY;
    for (const [, name, args] of text.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
        const v = numbersIn(args);
        let m: Matrix = IDENTITY;
        switch (name) {
            case 'matrix': if (v.length >= 6) m = [v[0], v[1], v[2], v[3], v[4], v[5]]; break;
            case 'translate': m = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0]; break;
            case 'scale': m = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0]; break;
            case 'rotate': {
                const a = ((v[0] ?? 0) * Math.PI) / 180;
                const turn: Matrix = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
                m = v.length >= 3 ? multiply(multiply([1, 0, 0, 1, v[1], v[2]], turn), [1, 0, 0, 1, -v[1], -v[2]]) : turn;
                break;
            }
            case 'skewX': m = [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0]; break;
            case 'skewY': m = [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
            default: break;
        }
        result = multiply(result, m);
    }
    return result;
};

const CURVE_STEPS = 16;

/**
 * An elliptical arc from `from` to `to` as points (not including `from`), worked out from its end
 * points: radii scaled up if they cannot reach, then its centre and angles found.
 */
const arcPoints = (from: Point, rxIn: number, ryIn: number, rotation: number, large: boolean, sweep: boolean, to: Point): Point[] => {
    let rx = Math.abs(rxIn);
    let ry = Math.abs(ryIn);
    if (rx < 1e-12 || ry < 1e-12 || (from[0] === to[0] && from[1] === to[1])) return [to];
    const phi = (rotation * Math.PI) / 180;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    // The midpoint between the ends, in the ellipse's own frame.
    const dx = (from[0] - to[0]) / 2;
    const dy = (from[1] - to[1]) / 2;
    const x1 = cos * dx + sin * dy;
    const y1 = -sin * dx + cos * dy;
    const reach = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (reach > 1) { rx *= Math.sqrt(reach); ry *= Math.sqrt(reach); }
    const top = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const bottom = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let k = Math.sqrt(Math.max(0, top / Math.max(bottom, 1e-300)));
    if (large === sweep) k = -k;
    const cx1 = (k * rx * y1) / ry;
    const cy1 = (-k * ry * x1) / rx;
    const cx = cos * cx1 - sin * cy1 + (from[0] + to[0]) / 2;
    const cy = sin * cx1 + cos * cy1 + (from[1] + to[1]) / 2;
    const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const start = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
    let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
    if (!sweep && delta > 0) delta -= 2 * Math.PI;
    else if (sweep && delta < 0) delta += 2 * Math.PI;
    const steps = Math.max(4, Math.ceil((Math.abs(delta) / (Math.PI / 2)) * CURVE_STEPS / 2));
    const points: Point[] = [];
    for (let i = 1; i <= steps; i++) {
        const t = start + (delta * i) / steps;
        const ex = rx * Math.cos(t);
        const ey = ry * Math.sin(t);
        points.push(i === steps ? [to[0], to[1]] : [cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
    }
    return points;
};

/** Path data ("M 10 10 L 20 20 ...") as polylines, each marked closed if it ended with Z. */
export const parsePathData = (data: string): SvgPath[] => {
    const tokens = data.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
    const paths: SvgPath[] = [];
    // Set by begin() too, so typed wide from the start (not narrowed to null).
    let current = null as SvgPath | null;
    let at: Point = [0, 0];
    let start: Point = [0, 0];
    let lastControl: Point | null = null;
    let lastKind = '';
    let i = 0;
    let command = '';
    const number = (): number => Number(tokens[i++]);
    const hasNumber = () => i < tokens.length && !/^[A-Za-z]$/.test(tokens[i]);
    const begin = (point: Point) => {
        if (current && current.points.length > 1) paths.push(current);
        current = { points: [point], closed: false };
    };
    const lineTo = (point: Point) => { if (!current) begin(at); current!.points.push(point); };
    while (i < tokens.length) {
        if (/^[A-Za-z]$/.test(tokens[i])) command = tokens[i++];
        else if (!command) { i++; continue; }
        const relative = command === command.toLowerCase();
        const base: Point = relative ? at : [0, 0];
        const kind = command.toUpperCase();
        if (kind === 'Z') {
            if (current) { current.closed = true; if (current.points.length > 1) paths.push(current); current = null; }
            at = start;
            lastControl = null;
            lastKind = 'Z';
            command = '';
            continue;
        }
        if (!hasNumber()) { i++; continue; }
        switch (kind) {
            case 'M': {
                const point: Point = [base[0] + number(), base[1] + number()];
                begin(point);
                at = point;
                start = point;
                // Further pairs after a move are lines.
                command = relative ? 'l' : 'L';
                lastControl = null;
                break;
            }
            case 'L': { const point: Point = [base[0] + number(), base[1] + number()]; lineTo(point); at = point; lastControl = null; break; }
            case 'H': { const point: Point = [relative ? at[0] + number() : number(), at[1]]; lineTo(point); at = point; lastControl = null; break; }
            case 'V': { const point: Point = [at[0], relative ? at[1] + number() : number()]; lineTo(point); at = point; lastControl = null; break; }
            case 'C': case 'S': {
                const c1: Point = kind === 'C' ? [base[0] + number(), base[1] + number()]
                    : lastControl && (lastKind === 'C' || lastKind === 'S') ? [2 * at[0] - lastControl[0], 2 * at[1] - lastControl[1]] : at;
                const c2: Point = [base[0] + number(), base[1] + number()];
                const end: Point = [base[0] + number(), base[1] + number()];
                for (let s = 1; s <= CURVE_STEPS; s++) {
                    const t = s / CURVE_STEPS;
                    const u = 1 - t;
                    lineTo([u * u * u * at[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * end[0], u * u * u * at[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * end[1]]);
                }
                lastControl = c2;
                at = end;
                break;
            }
            case 'Q': case 'T': {
                const c: Point = kind === 'Q' ? [base[0] + number(), base[1] + number()]
                    : lastControl && (lastKind === 'Q' || lastKind === 'T') ? [2 * at[0] - lastControl[0], 2 * at[1] - lastControl[1]] : at;
                const end: Point = [base[0] + number(), base[1] + number()];
                for (let s = 1; s <= CURVE_STEPS; s++) {
                    const t = s / CURVE_STEPS;
                    const u = 1 - t;
                    lineTo([u * u * at[0] + 2 * u * t * c[0] + t * t * end[0], u * u * at[1] + 2 * u * t * c[1] + t * t * end[1]]);
                }
                lastControl = c;
                at = end;
                break;
            }
            case 'A': {
                const rx = number();
                const ry = number();
                const rotation = number();
                const large = number() !== 0;
                const sweep = number() !== 0;
                const end: Point = [base[0] + number(), base[1] + number()];
                for (const point of arcPoints(at, rx, ry, rotation, large, sweep, end)) lineTo(point);
                at = end;
                lastControl = null;
                break;
            }
            default: i++; break;
        }
        lastKind = kind;
    }
    const last = current as SvgPath | null;
    if (last && last.points.length > 1) paths.push(last);
    return paths;
};

const attribute = (element: Element, name: string, fallback = 0): number => {
    const value = Number.parseFloat(element.getAttribute(name) ?? '');
    return Number.isFinite(value) ? value : fallback;
};

/** An ellipse as a closed polyline. */
const ellipsePoints = (cx: number, cy: number, rx: number, ry: number, steps = 64): Point[] =>
    Array.from({ length: steps }, (_, i): Point => [cx + rx * Math.cos((i / steps) * Math.PI * 2), cy + ry * Math.sin((i / steps) * Math.PI * 2)]);

/** One element's outlines (in its own coordinates). */
const elementPaths = (element: Element): SvgPath[] => {
    switch (element.tagName.toLowerCase()) {
        case 'path': return parsePathData(element.getAttribute('d') ?? '');
        case 'polygon': case 'polyline': {
            const v = numbersIn(element.getAttribute('points') ?? '');
            const points: Point[] = [];
            for (let k = 0; k + 1 < v.length; k += 2) points.push([v[k], v[k + 1]]);
            return points.length > 1 ? [{ points, closed: element.tagName.toLowerCase() === 'polygon' }] : [];
        }
        case 'rect': {
            const x = attribute(element, 'x');
            const y = attribute(element, 'y');
            const w = attribute(element, 'width');
            const h = attribute(element, 'height');
            if (w <= 0 || h <= 0) return [];
            let rx = attribute(element, 'rx', Number.NaN);
            let ry = attribute(element, 'ry', Number.NaN);
            if (Number.isNaN(rx)) rx = Number.isNaN(ry) ? 0 : ry;
            if (Number.isNaN(ry)) ry = rx;
            rx = Math.min(rx, w / 2);
            ry = Math.min(ry, h / 2);
            if (rx <= 0 || ry <= 0) return [{ points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true }];
            // Corners as quarter ellipses.
            const corner = (cx: number, cy: number, from: number): Point[] => Array.from({ length: 9 }, (_, i): Point => [cx + rx * Math.cos(from + (i / 8) * (Math.PI / 2)), cy + ry * Math.sin(from + (i / 8) * (Math.PI / 2))]);
            return [{ points: [...corner(x + w - rx, y + ry, -Math.PI / 2), ...corner(x + w - rx, y + h - ry, 0), ...corner(x + rx, y + h - ry, Math.PI / 2), ...corner(x + rx, y + ry, Math.PI)], closed: true }];
        }
        case 'circle': {
            const r = attribute(element, 'r');
            return r > 0 ? [{ points: ellipsePoints(attribute(element, 'cx'), attribute(element, 'cy'), r, r), closed: true }] : [];
        }
        case 'ellipse': {
            const rx = attribute(element, 'rx');
            const ry = attribute(element, 'ry');
            return rx > 0 && ry > 0 ? [{ points: ellipsePoints(attribute(element, 'cx'), attribute(element, 'cy'), rx, ry), closed: true }] : [];
        }
        case 'line':
            return [{ points: [[attribute(element, 'x1'), attribute(element, 'y1')], [attribute(element, 'x2'), attribute(element, 'y2')]], closed: false }];
        default:
            return [];
    }
};

/**
 * The outlines of an SVG drawing (or of bare path data), in its own coordinates (y down), each
 * element's transforms and its groups' applied. Elements inside <defs> are skipped.
 */
export const parseSvg = (text: string): SvgPath[] => {
    const trimmed = text.trim();
    if (!trimmed) return [];
    if (!trimmed.includes('<')) return parsePathData(trimmed);
    if (typeof DOMParser === 'undefined') {
        // No XML reader here: every path's data, untransformed.
        return [...trimmed.matchAll(/\sd\s*=\s*"([^"]*)"/g)].flatMap((match) => parsePathData(match[1]));
    }
    const doc = new DOMParser().parseFromString(trimmed, 'image/svg+xml');
    const root = doc.documentElement;
    if (!root || root.getElementsByTagName('parsererror').length) return [...trimmed.matchAll(/\sd\s*=\s*"([^"]*)"/g)].flatMap((match) => parsePathData(match[1]));
    const out: SvgPath[] = [];
    const walk = (element: Element, matrix: Matrix) => {
        const tag = element.tagName.toLowerCase();
        if (tag === 'defs' || tag === 'clippath' || tag === 'mask' || tag === 'symbol') return;
        const own = multiply(matrix, parseTransform(element.getAttribute('transform')));
        for (const path of elementPaths(element)) out.push({ points: path.points.map((point) => apply(own, point)), closed: path.closed });
        for (const child of Array.from(element.children)) walk(child, own);
    };
    walk(root, IDENTITY);
    return out;
};

/**
 * Paths fitted into the picture: their box scaled (keeping its shape) to fill it inside `margin`,
 * centred, and turned the right way up (SVG's y runs down, a picture's v up).
 */
export const fitToPicture = (paths: readonly SvgPath[], margin: number): SvgPath[] => {
    let low: Point = [Infinity, Infinity];
    let high: Point = [-Infinity, -Infinity];
    for (const path of paths) for (const [x, y] of path.points) { low = [Math.min(low[0], x), Math.min(low[1], y)]; high = [Math.max(high[0], x), Math.max(high[1], y)]; }
    if (!Number.isFinite(low[0])) return [];
    const span = Math.max(high[0] - low[0], high[1] - low[1], 1e-9);
    const scale = (1 - 2 * margin) / span;
    const centre: Point = [(low[0] + high[0]) / 2, (low[1] + high[1]) / 2];
    return paths.map((path) => ({ closed: path.closed, points: path.points.map(([x, y]): Point => [0.5 + (x - centre[0]) * scale, 0.5 - (y - centre[1]) * scale]) }));
};
