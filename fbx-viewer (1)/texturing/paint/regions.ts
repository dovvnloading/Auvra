/**
 * AREAS OF A PICTURE THAT CHANGED
 *
 * A brush stroke changes a small part of a texture set's pictures, so only that part is put together
 * again. Areas are rectangles of texels, x0 and y0 included and x1 and y1 not, counted from the
 * bottom left as the GPU counts them. A picture's changed area is kept as a few rectangles: one that
 * overlaps another, or that a little extra area would join to it, is merged with it, so far-apart
 * changes (two sides of a UV seam, say) stay apart while neighbouring ones become one.
 */

export interface Rect { x0: number; y0: number; x1: number; y1: number }

export const rect = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x0, y0, x1, y1 });

export const rectArea = (r: Rect): number => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);

export const isEmptyRect = (r: Rect): boolean => r.x1 <= r.x0 || r.y1 <= r.y0;

export const unionRect = (a: Rect, b: Rect): Rect => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });

export const intersectRect = (a: Rect, b: Rect): Rect => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });

/** Whether two rectangles share any texel. */
export const rectsOverlap = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** Grown by `by` texels on every side (what an operation reading neighbours needs around an area). */
export const expandRect = (r: Rect, by: number): Rect => ({ x0: r.x0 - by, y0: r.y0 - by, x1: r.x1 + by, y1: r.y1 + by });

/** Kept within a square picture of `size` texels, on whole texels. */
export const clampRect = (r: Rect, size: number): Rect => ({
    x0: Math.max(0, Math.min(size, Math.floor(r.x0))),
    y0: Math.max(0, Math.min(size, Math.floor(r.y0))),
    x1: Math.max(0, Math.min(size, Math.ceil(r.x1))),
    y1: Math.max(0, Math.min(size, Math.ceil(r.y1))),
});

export const fullRect = (size: number): Rect => ({ x0: 0, y0: 0, x1: size, y1: size });

/** The texels a box of texture coordinates (within one picture, 0..1) covers, with `margin` texels round it. */
export const rectOfUvBox = (minU: number, minV: number, maxU: number, maxV: number, size: number, margin: number): Rect =>
    clampRect({ x0: minU * size - margin, y0: minV * size - margin, x1: maxU * size + margin, y1: maxV * size + margin }, size);

/** A rectangle as a scissor box: where it starts and how big it is. */
export const scissorOf = (r: Rect): { x: number; y: number; width: number; height: number } => ({ x: r.x0, y: r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0 });

/**
 * A rectangle grown to whole steps of `quantum` texels on each side, kept within the picture (moved back
 * inside where it would stick out), so work pictures of a few sizes are made once and reused.
 */
export const alignRect = (r: Rect, size: number, quantum = 64): Rect => {
    const width = Math.min(size, Math.max(quantum, Math.ceil((r.x1 - r.x0) / quantum) * quantum));
    const height = Math.min(size, Math.max(quantum, Math.ceil((r.y1 - r.y0) / quantum) * quantum));
    const x0 = Math.max(0, Math.min(r.x0, size - width));
    const y0 = Math.max(0, Math.min(r.y0, size - height));
    return { x0, y0, x1: x0 + width, y1: y0 + height };
};

/** Merging two rectangles is worth it when their union is at most this much bigger than the two apart. */
const MERGE_SLACK = 1.3;

/**
 * The changed area of one picture: a handful of rectangles, or the whole picture. Merging keeps the count
 * low (each rectangle is one round of drawing) without growing the area much.
 */
export class DirtyRegion {
    private list: Rect[] = [];
    private whole = false;

    constructor(readonly size: number, readonly limit = 8) {}

    get full(): boolean {
        return this.whole;
    }

    get empty(): boolean {
        return !this.whole && this.list.length === 0;
    }

    /** The rectangles to draw again (the whole picture when it all changed). */
    get rects(): readonly Rect[] {
        return this.whole ? [fullRect(this.size)] : this.list;
    }

    /** The texels of all its rectangles together. */
    get area(): number {
        return this.whole ? this.size * this.size : this.list.reduce((sum, r) => sum + rectArea(r), 0);
    }

    markFull(): void {
        this.whole = true;
        this.list = [];
    }

    add(input: Rect): void {
        if (this.whole) return;
        let next = clampRect(input, this.size);
        if (isEmptyRect(next)) return;
        // Join every rectangle it overlaps or that it joins cheaply, until none is left to join.
        for (let joined = true; joined;) {
            joined = false;
            for (let i = 0; i < this.list.length; i++) {
                const other = this.list[i];
                const union = unionRect(next, other);
                if (rectsOverlap(next, other) || rectArea(union) <= (rectArea(next) + rectArea(other)) * MERGE_SLACK) {
                    next = union;
                    this.list.splice(i, 1);
                    joined = true;
                    break;
                }
            }
        }
        this.list.push(next);
        // Too many: the pair whose union grows the least is joined.
        while (this.list.length > this.limit) {
            let best = [0, 1];
            let growth = Infinity;
            for (let i = 0; i < this.list.length; i++) {
                for (let j = i + 1; j < this.list.length; j++) {
                    const extra = rectArea(unionRect(this.list[i], this.list[j])) - rectArea(this.list[i]) - rectArea(this.list[j]);
                    if (extra < growth) { growth = extra; best = [i, j]; }
                }
            }
            const union = unionRect(this.list[best[0]], this.list[best[1]]);
            this.list.splice(best[1], 1);
            this.list.splice(best[0], 1);
            this.add(union);
        }
        // Most of the picture: one round over all of it costs less than many.
        if (this.area >= this.size * this.size * 0.6) this.markFull();
    }

    /** Adds another region's rectangles (all of it when it is whole). */
    merge(other: DirtyRegion): void {
        if (other.full) this.markFull();
        else for (const r of other.rects) this.add(r);
    }

    /** Hands over its rectangles and starts empty again. */
    take(): Rect[] {
        const rects = [...this.rects];
        this.list = [];
        this.whole = false;
        return rects;
    }
}
