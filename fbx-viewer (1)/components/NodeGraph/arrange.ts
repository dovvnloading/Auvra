import type { Point, Rect } from './model';

/**
 * Lining nodes up: aligning their edges or middles, spacing them evenly, and snapping places to the
 * canvas grid.
 */

/** The canvas grid, in graph units: the dots drawn behind the nodes, and what snapping rounds to. */
export const GRID = 20;

export const snapToGrid = (value: number, grid = GRID): number => Math.round(value / grid) * grid;

export const snapPoint = (point: Point, grid = GRID): Point => ({ x: snapToGrid(point.x, grid), y: snapToGrid(point.y, grid) });

export type AlignEdge = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom';

export const ALIGN_LABELS: Record<AlignEdge, string> = {
    left: 'Left edges', centre: 'Centres', right: 'Right edges', top: 'Top edges', middle: 'Middles', bottom: 'Bottom edges',
};

type Placed = Rect & { id: string };

/**
 * New top-left places that line the rects up on `edge`: their left or right edges with the leftmost or
 * rightmost, their top or bottom edges with the highest or lowest, centres and middles on the middle
 * of the box round them all.
 */
export const alignRects = (rects: readonly Placed[], edge: AlignEdge): Map<string, Point> => {
    const places = new Map<string, Point>();
    if (rects.length < 2) return places;
    const left = Math.min(...rects.map((rect) => rect.x));
    const right = Math.max(...rects.map((rect) => rect.x + rect.width));
    const top = Math.min(...rects.map((rect) => rect.y));
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
    const centre = (left + right) / 2;
    const middle = (top + bottom) / 2;
    for (const rect of rects) {
        let { x, y } = rect;
        if (edge === 'left') x = left;
        else if (edge === 'right') x = right - rect.width;
        else if (edge === 'centre') x = centre - rect.width / 2;
        else if (edge === 'top') y = top;
        else if (edge === 'bottom') y = bottom - rect.height;
        else y = middle - rect.height / 2;
        places.set(rect.id, { x, y });
    }
    return places;
};

/**
 * New top-left places that space the rects evenly along an axis: the first and last stay where they
 * are, and the ones between move so the gaps between neighbours are all the same.
 */
export const distributeRects = (rects: readonly Placed[], axis: 'horizontal' | 'vertical'): Map<string, Point> => {
    const places = new Map<string, Point>();
    if (rects.length < 3) return places;
    const start = (rect: Placed) => (axis === 'horizontal' ? rect.x : rect.y);
    const size = (rect: Placed) => (axis === 'horizontal' ? rect.width : rect.height);
    const sorted = [...rects].sort((a, b) => start(a) - start(b) || a.id.localeCompare(b.id));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const span = start(last) + size(last) - start(first);
    const total = sorted.reduce((sum, rect) => sum + size(rect), 0);
    const gap = (span - total) / (sorted.length - 1);
    let at = start(first);
    for (const rect of sorted) {
        places.set(rect.id, axis === 'horizontal' ? { x: at, y: rect.y } : { x: rect.x, y: at });
        at += size(rect) + gap;
    }
    return places;
};
