import type { Point, Rect } from './model';

/**
 * Wires: the curve each is drawn along (leaving an output to the right, arriving at an input from the
 * left), and finding the wire nearest a point, for cutting, splicing and adding reroute points.
 */

/** The two control points of a wire's curve. */
export const wireControls = (from: Point, to: Point): [Point, Point] => {
    const reach = Math.max(40, Math.abs(to.x - from.x) * 0.5);
    return [{ x: from.x + reach, y: from.y }, { x: to.x - reach, y: to.y }];
};

/** The wire's curve as an SVG path. */
export const wirePath = (from: Point, to: Point): string => {
    const [a, b] = wireControls(from, to);
    return `M ${from.x} ${from.y} C ${a.x} ${a.y}, ${b.x} ${b.y}, ${to.x} ${to.y}`;
};

/** A point along the wire, `t` from 0 at its start to 1 at its end. */
export const wirePoint = (from: Point, to: Point, t: number): Point => {
    const [a, b] = wireControls(from, to);
    const u = 1 - t;
    const w0 = u * u * u;
    const w1 = 3 * u * u * t;
    const w2 = 3 * u * t * t;
    const w3 = t * t * t;
    return { x: w0 * from.x + w1 * a.x + w2 * b.x + w3 * to.x, y: w0 * from.y + w1 * a.y + w2 * b.y + w3 * to.y };
};

/** The box round a wire, control points included (so it holds the whole curve). */
export const wireBounds = (from: Point, to: Point): Rect => {
    const [a, b] = wireControls(from, to);
    const minX = Math.min(from.x, to.x, a.x, b.x);
    const minY = Math.min(from.y, to.y, a.y, b.y);
    return { x: minX, y: minY, width: Math.max(from.x, to.x, a.x, b.x) - minX, height: Math.max(from.y, to.y, a.y, b.y) - minY };
};

const SEGMENTS = 24;

const segmentDistance = (p: Point, a: Point, b: Point): number => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    const t = length > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
    return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
};

/** How far `p` lies from the wire (its curve taken as short straight pieces), and where along it. */
export const wireDistance = (p: Point, from: Point, to: Point): { distance: number; t: number } => {
    let best = Infinity;
    let bestT = 0;
    let previous = from;
    for (let i = 1; i <= SEGMENTS; i++) {
        const t = i / SEGMENTS;
        const next = wirePoint(from, to, t);
        const distance = segmentDistance(p, previous, next);
        if (distance < best) { best = distance; bestT = t - 0.5 / SEGMENTS; }
        previous = next;
    }
    return { distance: best, t: bestT };
};

/** The wire nearest `p` within `tolerance`, or null. Wires whose box (grown by the tolerance) misses `p` are skipped. */
export const nearestWire = <K>(p: Point, wires: Iterable<{ key: K; from: Point; to: Point }>, tolerance: number): K | null => {
    let found: K | null = null;
    let best = tolerance;
    for (const wire of wires) {
        const box = wireBounds(wire.from, wire.to);
        if (p.x < box.x - tolerance || p.x > box.x + box.width + tolerance || p.y < box.y - tolerance || p.y > box.y + box.height + tolerance) continue;
        const { distance } = wireDistance(p, wire.from, wire.to);
        if (distance <= best) { best = distance; found = wire.key; }
    }
    return found;
};
