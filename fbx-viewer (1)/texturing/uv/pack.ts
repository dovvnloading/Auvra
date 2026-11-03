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
// Shape packing: islands dropped onto a skyline by their real outlines
// ---------------------------------------------------------------------------

const GRID = 512;

interface Profile { width: number; height: number; bottom: Int32Array; top: Int32Array; turn: number }

const turnPoint = (x: number, y: number, turn: number): [number, number] =>
    (turn === 0 ? [x, y] : turn === 1 ? [-y, x] : turn === 2 ? [-x, -y] : [y, -x]);

/** An island's lowest and highest filled cell in each column at `scale` (cells per model unit), padded. */
const profileOf = (item: Prepared, scale: number, turn: number, pad: number): Profile => {
    const turned = item.points.map(([x, y]) => turnPoint(x * scale, y * scale, turn));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of turned) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const width = Math.max(1, Math.ceil(maxX - minX) + pad * 2 + 1);
    const height = Math.max(1, Math.ceil(maxY - minY) + pad * 2 + 1);
    const bottom = new Int32Array(width).fill(1 << 30);
    const top = new Int32Array(width).fill(-1);
    const mark = (cx: number, cy: number) => {
        for (let dx = -pad; dx <= pad; dx++) {
            const x = cx + dx;
            if (x < 0 || x >= width) continue;
            bottom[x] = Math.min(bottom[x], Math.max(0, cy - pad));
            top[x] = Math.max(top[x], Math.min(height - 1, cy + pad));
        }
    };
    const t = item.island.triangles;
    const at = (k: number): [number, number] => [turned[k][0] - minX + pad, turned[k][1] - minY + pad];
    const edge = (p: number[], q: number[], x: number, y: number) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
    for (let k = 0; k < t.length; k += 3) {
        const a = at(t[k]), b = at(t[k + 1]), c = at(t[k + 2]);
        const x0 = Math.floor(Math.min(a[0], b[0], c[0])), x1 = Math.ceil(Math.max(a[0], b[0], c[0]));
        const y0 = Math.floor(Math.min(a[1], b[1], c[1])), y1 = Math.ceil(Math.max(a[1], b[1], c[1]));
        for (const p of [a, b, c]) mark(Math.floor(p[0]), Math.floor(p[1]));
        const area = edge(a, b, c[0], c[1]);
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const cx = x + 0.5, cy = y + 0.5;
                const w0 = edge(b, c, cx, cy), w1 = edge(c, a, cx, cy), w2 = edge(a, b, cx, cy);
                if (area >= 0 ? w0 >= -1 && w1 >= -1 && w2 >= -1 : w0 <= 1 && w1 <= 1 && w2 <= 1) mark(x, y);
            }
        }
    }
    return { width, height, bottom, top, turn };
};

/**
 * Each island's share of the padding in grid cells: rounded up, and never under one cell, as islands in
 * neighbouring cells can otherwise touch once the grid is finer than the picture's texels.
 */
const gridPadding = (settings: PackSettings): number => Math.max(1, Math.ceil(((settings.padding / settings.resolution) * GRID) / 2));

/** Drops every island onto per-tile skylines at `scale`; null when they do not all fit. */
const tryShapes = (items: Prepared[], scale: number, settings: PackSettings): Array<{ x: number; y: number; profile: Profile; tile: number }> | null => {
    const tiles = settings.tilesX * settings.tilesY;
    const pad = gridPadding(settings);
    const skies = Array.from({ length: tiles }, () => new Int32Array(GRID).fill(pad));
    const order = items.map((_, i) => i).sort((a, b) => items[b].width * items[b].height - items[a].width * items[a].height);
    const result: Array<{ x: number; y: number; profile: Profile; tile: number }> = new Array(items.length);
    for (const i of order) {
        let best: { x: number; y: number; profile: Profile; tile: number; score: number } | null = null;
        const turns = settings.rotate && !items[i].island.locked ? [0, 1, 2, 3] : [0];
        for (let tile = 0; tile < tiles && !best; tile++) {
            const sky = skies[tile];
            for (const turn of turns) {
                const profile = profileOf(items[i], scale * GRID, turn, pad);
                if (profile.width > GRID - 2 * pad || profile.height > GRID - 2 * pad) continue;
                for (let x = pad; x + profile.width <= GRID - pad; x++) {
                    let y = 0;
                    for (let c = 0; c < profile.width; c++) if (profile.top[c] >= 0) y = Math.max(y, sky[x + c] - profile.bottom[c]);
                    if (y + profile.height > GRID - pad) continue;
                    // The space left empty under the island is lost for good: least of it first, then lowest.
                    let waste = 0;
                    for (let c = 0; c < profile.width; c++) if (profile.top[c] >= 0) waste += y + profile.bottom[c] - sky[x + c];
                    const score = waste * 4 + (y + profile.height) * profile.width;
                    if (!best || score < best.score) best = { x, y, profile, tile, score };
                }
            }
        }
        if (!best) return null;
        const sky = skies[best.tile];
        for (let c = 0; c < best.profile.width; c++) if (best.profile.top[c] >= 0) sky[best.x + c] = Math.max(sky[best.x + c], best.y + best.profile.top[c] + 1);
        result[i] = best;
    }
    return result;
};

const packShapes = (islands: readonly Island[], settings: PackSettings): { placements: Placement[]; scale: number } | null => {
    const items = prepare(islands, false);
    let total = 0;
    for (const item of items) total += item.width * item.height;
    if (total <= 0) return null;
    const tiles = settings.tilesX * settings.tilesY;
    let low = 0;
    let high = Math.sqrt(tiles / total) * 1.6;
    let best: ReturnType<typeof tryShapes> = null;
    let bestScale = 0;
    for (let step = 0; step < 14; step++) {
        const middle = (low + high) / 2;
        const attempt = tryShapes(items, middle, settings);
        if (attempt) { best = attempt; bestScale = middle; low = middle; } else high = middle;
    }
    if (!best) return null;
    const pad = gridPadding(settings);
    const placements = items.map((item, i) => {
        const spot = best![i];
        const s = bestScale * GRID;
        const turned = item.points.map(([x, y]) => turnPoint(x * s, y * s, spot.profile.turn));
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
    const shapes = packShapes(islands, settings);
    // The packing that lets the islands be larger uses the picture better.
    return shapes && shapes.scale > boxes.scale ? shapes.placements : boxes.placements;
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
