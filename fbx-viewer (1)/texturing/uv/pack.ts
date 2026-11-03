/**
 * PACKING ISLANDS
 *
 * Lays flattened islands out in the 0..1 square (or across several UDIM tiles):
 *   - each island is first turned so its bounding box is the smallest it can be (rotating calipers over
 *     its convex hull) and kept upright, so straight edges line up with the picture's;
 *   - every island keeps the same texel density, its size on the picture following its size on the model
 *     (or a density of its own when one is set);
 *   - boxes are placed largest first into free rectangles (maximal rectangles, best short-side fit),
 *     turned a quarter when that fits better, with padding all round so filtering never mixes islands;
 *   - then the islands' real outlines are nested on a grid: largest first, each set into the lowest
 *     place it fits in any of its four quarter turns, so small islands fill the gaps between large ones
 *     (about a quarter more of the picture used than boxes on hard-surface models);
 *   - the common scale is searched for: the largest at which everything fits.
 */

export interface Island {
    /** Two per corner, in model units (from flattening). */
    uv: Float64Array;
    /** Corners' indices into uv, three per triangle (for area and hull). */
    triangles: ArrayLike<number>;
    /** Area on the model. */
    area3d: number;
    /** A density multiplier of its own (1 keeps the common density). */
    densityScale?: number;
    /** Keep where it is: not moved by packing. */
    locked?: boolean;
}

export interface PackSettings {
    /** Gap between islands and around the edge, in pixels of a `resolution`-sized picture. */
    padding: number;
    resolution: number;
    /** Whether islands may be turned a quarter. */
    rotate: boolean;
    /** Number of UDIM tiles across and down to fill (1 × 1 for a single picture). */
    tilesX: number;
    tilesY: number;
}

export const DEFAULT_PACK: PackSettings = { padding: 8, resolution: 2048, rotate: true, tilesX: 1, tilesY: 1 };

export interface Placement {
    /** Final texture coordinates, two per corner. */
    uv: Float64Array;
    tile: number;
}

const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull of 2D points (monotone chain). */
export const convexHull = (points: number[][]): number[][] => {
    if (points.length < 3) return points.slice();
    const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const lower: number[][] = [];
    for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper: number[][] = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
        const p = sorted[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
};

/** The turn (radians) giving the smallest bounding box of a point set: one of its hull's edge directions. */
export const smallestBoxAngle = (points: number[][]): number => {
    const hull = convexHull(points);
    if (hull.length < 3) return 0;
    let best = 0;
    let bestArea = Infinity;
    for (let i = 0; i < hull.length; i++) {
        const a = hull[i];
        const b = hull[(i + 1) % hull.length];
        const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const c = Math.cos(-angle), s = Math.sin(-angle);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of hull) {
            const x = p[0] * c - p[1] * s;
            const y = p[0] * s + p[1] * c;
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
        const area = (maxX - minX) * (maxY - minY);
        if (area < bestArea - 1e-12) { bestArea = area; best = -angle; }
    }
    return best;
};

interface Rect { x: number; y: number; w: number; h: number }

/** Free-rectangle packing into one bin of `width` × `height`. */
class MaxRects {
    private free: Rect[];
    constructor(readonly width: number, readonly height: number) {
        this.free = [{ x: 0, y: 0, w: width, h: height }];
    }

    /** The best place for a w × h box (turned when allowed and better); null when none fits. */
    find(w: number, h: number, rotate: boolean): { x: number; y: number; turned: boolean } | null {
        let best: { x: number; y: number; turned: boolean; score: number; long: number } | null = null;
        for (const rect of this.free) {
            for (const turned of rotate ? [false, true] : [false]) {
                const bw = turned ? h : w;
                const bh = turned ? w : h;
                if (bw > rect.w + 1e-9 || bh > rect.h + 1e-9) continue;
                const short = Math.min(rect.w - bw, rect.h - bh);
                const long = Math.max(rect.w - bw, rect.h - bh);
                if (!best || short < best.score - 1e-12 || (Math.abs(short - best.score) < 1e-12 && long < best.long)) best = { x: rect.x, y: rect.y, turned, score: short, long };
            }
        }
        return best;
    }

    place(x: number, y: number, w: number, h: number): void {
        const used = { x, y, w, h };
        const kept: Rect[] = [];
        const pieces: Rect[] = [];
        for (const rect of this.free) {
            if (used.x >= rect.x + rect.w || used.x + used.w <= rect.x || used.y >= rect.y + rect.h || used.y + used.h <= rect.y) { kept.push(rect); continue; }
            if (used.x > rect.x) pieces.push({ x: rect.x, y: rect.y, w: used.x - rect.x, h: rect.h });
            if (used.x + used.w < rect.x + rect.w) pieces.push({ x: used.x + used.w, y: rect.y, w: rect.x + rect.w - used.x - used.w, h: rect.h });
            if (used.y > rect.y) pieces.push({ x: rect.x, y: rect.y, w: rect.w, h: used.y - rect.y });
            if (used.y + used.h < rect.y + rect.h) pieces.push({ x: rect.x, y: used.y + used.h, w: rect.w, h: rect.y + rect.h - used.y - used.h });
        }
        // New pieces inside other rectangles add nothing. Only the new pieces are checked (checking every
        // pair each time grows with the cube of the islands); an old rectangle left inside a newer one is
        // still free space, merely one more to look through.
        const inside = (a: Rect, b: Rect) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
        const fresh = pieces.filter((a, i) => !kept.some((b) => inside(a, b)) && !pieces.some((b, j) => j !== i && inside(a, b) && (j < i || a.w !== b.w || a.h !== b.h || a.x !== b.x || a.y !== b.y)));
        this.free = kept.concat(fresh);
    }
}

interface Prepared { island: Island; index: number; points: number[][]; width: number; height: number }

/** Islands turned to their smallest boxes and scaled to a common density (model units). */
const prepare = (islands: readonly Island[], rotate: boolean): Prepared[] => islands.map((island, index) => {
    const points: number[][] = [];
    for (let i = 0; i < island.uv.length; i += 2) points.push([island.uv[i], island.uv[i + 1]]);
    // Flattened islands are already in model units; scale only by the island's own density.
    const scale = island.densityScale ?? 1;
    let angle = rotate && !island.locked ? smallestBoxAngle(points) : 0;
    const c = Math.cos(angle), s = Math.sin(angle);
    let turned = points.map(([x, y]) => [(x * c - y * s) * scale, (x * s + y * c) * scale]);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of turned) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    // Upright: taller than wide becomes wide, so rows fill well.
    if (rotate && !island.locked && maxY - minY > maxX - minX) {
        turned = turned.map(([x, y]) => [-y, x]);
        [minX, maxX, minY, maxY] = [-maxY, -minY, minX, maxX];
        angle += Math.PI / 2;
    }
    return { island, index, points: turned.map(([x, y]) => [x - minX, y - minY]), width: maxX - minX, height: maxY - minY };
});

/** Tries to fit everything at `scale` (picture units per model unit); null when it does not. */
const tryPack = (items: Prepared[], scale: number, settings: PackSettings): Array<{ x: number; y: number; turned: boolean; tile: number }> | null => {
    const pad = settings.padding / settings.resolution;
    const bins = Array.from({ length: settings.tilesX * settings.tilesY }, () => new MaxRects(1 - pad, 1 - pad));
    const result: Array<{ x: number; y: number; turned: boolean; tile: number }> = new Array(items.length);
    const order = items.map((_, i) => i).sort((a, b) => Math.max(items[b].width, items[b].height) * (items[b].width + items[b].height) - Math.max(items[a].width, items[a].height) * (items[a].width + items[a].height));
    for (const i of order) {
        const w = items[i].width * scale + pad;
        const h = items[i].height * scale + pad;
        let placed = false;
        for (let b = 0; b < bins.length && !placed; b++) {
            const spot = bins[b].find(w, h, settings.rotate && !items[i].island.locked);
            if (!spot) continue;
            bins[b].place(spot.x, spot.y, spot.turned ? h : w, spot.turned ? w : h);
            result[i] = { ...spot, tile: b };
            placed = true;
        }
        if (!placed) return null;
    }
    return result;
};

// ---------------------------------------------------------------------------
// Nesting grid
// ---------------------------------------------------------------------------

const GRID = 512;

const turnPoint = (x: number, y: number, turn: number): [number, number] =>
    (turn === 0 ? [x, y] : turn === 1 ? [-y, x] : turn === 2 ? [-x, -y] : [y, -x]);

/**
 * Each island's share of the padding in grid cells: rounded up, and never under one cell, as islands in
 * neighbouring cells can otherwise touch once the grid is finer than the picture's texels.
 */
const gridPadding = (settings: PackSettings): number => Math.max(1, Math.ceil(((settings.padding / settings.resolution) * GRID) / 2));

// ---------------------------------------------------------------------------
// Nesting: islands set into the free space by their real outlines, gaps and holes included
// ---------------------------------------------------------------------------

/**
 * An island's cells as runs per row (inclusive first and last cell, in pairs), grown by the padding, with
 * each row's longest run (to pass over rows that cannot hold it at a glance).
 */
interface Mask { width: number; height: number; runs: Int32Array[]; widest: Int32Array; turn: number; cells: number }

/** An island's cells at `scale` (cells per model unit), turned `turn` quarters and grown by `pad` cells all round. */
const maskOf = (item: Prepared, scale: number, turn: number, pad: number): Mask => {
    const turned = item.points.map(([x, y]) => turnPoint(x * scale, y * scale, turn));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of turned) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const width = Math.max(1, Math.ceil(maxX - minX) + pad * 2 + 1);
    const height = Math.max(1, Math.ceil(maxY - minY) + pad * 2 + 1);
    const filled = new Uint8Array(width * height);
    const mark = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < width && y < height) filled[y * width + x] = 1; };
    const t = item.island.triangles;
    const at = (k: number): [number, number] => [turned[k][0] - minX + pad, turned[k][1] - minY + pad];
    const edge = (p: number[], q: number[], x: number, y: number) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
    for (let k = 0; k < t.length; k += 3) {
        const a = at(t[k]), b = at(t[k + 1]), c = at(t[k + 2]);
        for (const p of [a, b, c]) mark(Math.floor(p[0]), Math.floor(p[1]));
        const x0 = Math.floor(Math.min(a[0], b[0], c[0])), x1 = Math.ceil(Math.max(a[0], b[0], c[0]));
        const y0 = Math.floor(Math.min(a[1], b[1], c[1])), y1 = Math.ceil(Math.max(a[1], b[1], c[1]));
        const area = edge(a, b, c[0], c[1]);
        // Every cell the triangle touches: a cell's centre within three quarters of a cell of each edge's line
        // (half a cell's diagonal is 0.71), kept to the triangle's box so thin triangles' corners do not spread.
        const sign = area >= 0 ? 1 : -1;
        const s0 = Math.hypot(c[0] - b[0], c[1] - b[1]) * 0.75, s1 = Math.hypot(a[0] - c[0], a[1] - c[1]) * 0.75, s2 = Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.75;
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const cx = x + 0.5, cy = y + 0.5;
                if (edge(b, c, cx, cy) * sign >= -s0 && edge(c, a, cx, cy) * sign >= -s1 && edge(a, b, cx, cy) * sign >= -s2) mark(x, y);
            }
        }
    }
    // Grown by the padding: along rows, then along columns (a square all round each cell).
    let grown = filled;
    if (pad > 0) {
        const rows = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
            let last = -Infinity;
            for (let x = 0; x < width; x++) { if (filled[y * width + x]) last = x; if (x - last <= pad) rows[y * width + x] = 1; }
            last = Infinity;
            for (let x = width - 1; x >= 0; x--) { if (filled[y * width + x]) last = x; if (last - x <= pad) rows[y * width + x] = 1; }
        }
        grown = new Uint8Array(width * height);
        for (let x = 0; x < width; x++) {
            let last = -Infinity;
            for (let y = 0; y < height; y++) { if (rows[y * width + x]) last = y; if (y - last <= pad) grown[y * width + x] = 1; }
            last = Infinity;
            for (let y = height - 1; y >= 0; y--) { if (rows[y * width + x]) last = y; if (last - y <= pad) grown[y * width + x] = 1; }
        }
    }
    const runs: Int32Array[] = [];
    const widest = new Int32Array(height);
    let cells = 0;
    for (let y = 0; y < height; y++) {
        const row: number[] = [];
        for (let x = 0; x < width; x++) {
            if (!grown[y * width + x]) continue;
            const start = x;
            while (x + 1 < width && grown[y * width + x + 1]) x++;
            row.push(start, x);
            cells += x - start + 1;
            widest[y] = Math.max(widest[y], x - start + 1);
        }
        runs.push(Int32Array.from(row));
    }
    return { width, height, runs, widest, turn, cells };
};

/**
 * The cells of one tile taken so far, with, for every cell, the first taken cell at or after it in its row,
 * and every row's longest free run.
 */
class Occupancy {
    readonly taken = new Uint8Array(GRID * GRID);
    readonly next = new Int32Array(GRID * GRID).fill(GRID);
    readonly room = new Int32Array(GRID).fill(GRID);
    free = GRID * GRID;

    /** Where `mask` first fits at row `y` from column `x` on: -1 when it fits there, else a column worth trying next. */
    blocked(mask: Mask, x: number, y: number): number {
        for (let r = 0; r < mask.height; r++) {
            const row = (y + r) * GRID;
            const runs = mask.runs[r];
            for (let k = 0; k < runs.length; k += 2) {
                const first = this.next[row + x + runs[k]];
                if (first <= x + runs[k + 1]) return first - runs[k] + 1;
            }
        }
        return -1;
    }

    /** The lowest, then leftmost place `mask` fits within the margin with its top below `ceiling`; null when none. */
    lowest(mask: Mask, margin: number, ceiling = GRID): { x: number; y: number } | null {
        rows: for (let y = margin; y + mask.height <= Math.min(GRID - margin, ceiling); y++) {
            for (let r = 0; r < mask.height; r++) if (this.room[y + r] < mask.widest[r]) continue rows;
            let x = margin;
            while (x + mask.width <= GRID - margin) {
                const skip = this.blocked(mask, x, y);
                if (skip < 0) return { x, y };
                x = Math.max(x + 1, skip);
            }
        }
        return null;
    }

    take(mask: Mask, x: number, y: number): void {
        for (let r = 0; r < mask.height; r++) {
            const row = (y + r) * GRID;
            const runs = mask.runs[r];
            if (!runs.length) continue;
            for (let k = 0; k < runs.length; k += 2) {
                this.taken.fill(1, row + x + runs[k], row + x + runs[k + 1] + 1);
                this.free -= runs[k + 1] - runs[k] + 1;
            }
            let first = GRID;
            let longest = 0;
            for (let c = GRID - 1; c >= 0; c--) {
                if (this.taken[row + c]) first = c;
                this.next[row + c] = first;
                if (!this.taken[row + c]) longest = Math.max(longest, first - c);
            }
            this.room[y + r] = longest;
        }
    }
}

/** Sets every island, largest first, into the lowest place it fits on per-tile grids at `scale`; null when they do not all fit. */
const tryNest = (items: Prepared[], scale: number, settings: PackSettings): Array<{ x: number; y: number; mask: Mask; tile: number }> | null => {
    const tiles = Array.from({ length: settings.tilesX * settings.tilesY }, () => new Occupancy());
    const pad = gridPadding(settings);
    const masks = items.map((item) => (settings.rotate && !item.island.locked ? [0, 1, 2, 3] : [0]).map((turn) => maskOf(item, scale * GRID, turn, pad)));
    const order = items.map((_, i) => i).sort((a, b) => masks[b][0].cells - masks[a][0].cells);
    const result: Array<{ x: number; y: number; mask: Mask; tile: number }> = new Array(items.length);
    let needed = 0;
    for (const i of order) needed += masks[i][0].cells;
    for (const i of order) {
        // More cells wanted than there are free: it cannot fit, wherever things go.
        if (needed > tiles.reduce((sum, tile) => sum + tile.free, 0)) return null;
        needed -= masks[i][0].cells;
        let best: { x: number; y: number; mask: Mask; tile: number } | null = null;
        for (let tile = 0; tile < tiles.length && !best; tile++) {
            for (const mask of masks[i]) {
                if (mask.width > GRID - 2 * pad || mask.height > GRID - 2 * pad) continue;
                // A turn can only win by ending lower than the best so far: the search stops there.
                const spot = tiles[tile].lowest(mask, pad, best ? best.y + best.mask.height : GRID);
                // Lowest top edge first, so the free space above stays as level as it can.
                if (spot && (!best || spot.y + mask.height < best.y + best.mask.height || (spot.y + mask.height === best.y + best.mask.height && spot.x < best.x))) best = { ...spot, mask, tile };
            }
        }
        if (!best) return null;
        tiles[best.tile].take(best.mask, best.x, best.y);
        result[i] = best;
    }
    return result;
};

/** Nesting at the largest scale from `floor` up at which everything fits; null when it does no better than `floor`. */
const packNested = (islands: readonly Island[], settings: PackSettings, floor: number): { placements: Placement[]; scale: number } | null => {
    const items = prepare(islands, settings.rotate);
    let area = 0;
    for (const item of items) {
        const t = item.island.triangles;
        const p = item.points;
        for (let k = 0; k < t.length; k += 3) area += Math.abs(cross(p[t[k]], p[t[k + 1]], p[t[k + 2]])) / 2;
    }
    if (area <= 0) return null;
    const tiles = settings.tilesX * settings.tilesY;
    // Everything fits by `floor` already; nothing can be larger than the islands filling the tiles whole.
    let low = floor;
    let high = Math.max(floor, Math.min(Math.sqrt(tiles / area), floor * 1.6));
    let best: ReturnType<typeof tryNest> = null;
    let bestScale = 0;
    for (let step = 0; step < 10 && high - low > low * 0.005; step++) {
        const middle = (low + high) / 2;
        const attempt = tryNest(items, middle, settings);
        if (attempt) { best = attempt; bestScale = middle; low = middle; } else high = middle;
    }
    if (!best) return null;
    const pad = gridPadding(settings);
    const placements = items.map((item, i) => {
        const spot = best![i];
        const s = bestScale * GRID;
        const turned = item.points.map(([x, y]) => turnPoint(x * s, y * s, spot.mask.turn));
        let minX = Infinity, minY = Infinity;
        for (const [x, y] of turned) { minX = Math.min(minX, x); minY = Math.min(minY, y); }
        const tx = spot.tile % settings.tilesX;
        const ty = Math.floor(spot.tile / settings.tilesX);
        const uv = new Float64Array(turned.length * 2);
        turned.forEach(([x, y], k) => {
            uv[k * 2] = tx + (spot.x + pad + x - minX) / GRID;
            uv[k * 2 + 1] = ty + (spot.y + pad + y - minY) / GRID;
        });
        return { uv, tile: 1001 + tx + ty * 10 };
    });
    return { placements, scale: bestScale };
};

/** Packs islands; returns each island's final coordinates (in its UDIM tile's place) and tile. */
export const packIslands = (islands: readonly Island[], settings: PackSettings = DEFAULT_PACK): Placement[] => {
    const boxes = packBoxes(islands, settings);
    // Nesting starts from what boxes reach, and is kept when it lets the islands be larger.
    const nested = packNested(islands, settings, boxes.scale);
    return nested && nested.scale > boxes.scale ? nested.placements : boxes.placements;
};

/** Box packing (maximal rectangles): islands as their tightest boxes. */
const packBoxes = (islands: readonly Island[], settings: PackSettings): { placements: Placement[]; scale: number } => {
    const items = prepare(islands, settings.rotate);
    let total = 0;
    for (const item of items) total += item.width * item.height;
    const tiles = settings.tilesX * settings.tilesY;
    // Start from the scale at which the boxes' area fills the tiles, then search.
    let high = total > 0 ? Math.sqrt(tiles / total) : 1;
    let low = 0;
    let best: ReturnType<typeof tryPack> = null;
    let bestScale = 0;
    while (tryPack(items, high, settings) && high < 1e9) { low = high; high *= 1.5; }
    for (let step = 0; step < 24; step++) {
        const middle = (low + high) / 2;
        const attempt = tryPack(items, middle, settings);
        if (attempt) { best = attempt; bestScale = middle; low = middle; } else high = middle;
    }
    if (!best) { best = tryPack(items, low || high * 0.01, settings) ?? items.map(() => ({ x: 0, y: 0, turned: false, tile: 0 })); bestScale = low || high * 0.01; }
    const pad = settings.padding / settings.resolution;
    const placements = items.map((item, i) => {
        const spot = best![i];
        const uv = new Float64Array(item.points.length * 2);
        const tx = spot.tile % settings.tilesX;
        const ty = Math.floor(spot.tile / settings.tilesX);
        item.points.forEach(([x, y], k) => {
            let px = x * bestScale;
            let py = y * bestScale;
            if (spot.turned) [px, py] = [item.height * bestScale - py, px];
            uv[k * 2] = tx + pad + spot.x + px;
            uv[k * 2 + 1] = ty + pad + spot.y + py;
        });
        return { uv, tile: 1001 + tx + ty * 10 };
    });
    return { placements, scale: bestScale };
};

/** How much of the picture the islands cover (0..1). */
export const coverage = (placements: readonly Placement[], islands: readonly Island[]): number => {
    let area = 0;
    placements.forEach((placement, i) => {
        const t = islands[i].triangles;
        const uv = placement.uv;
        for (let k = 0; k < t.length; k += 3) {
            const a = t[k], b = t[k + 1], c = t[k + 2];
            area += Math.abs((uv[b * 2] - uv[a * 2]) * (uv[c * 2 + 1] - uv[a * 2 + 1]) - (uv[c * 2] - uv[a * 2]) * (uv[b * 2 + 1] - uv[a * 2 + 1])) / 2;
        }
    });
    return area;
};
