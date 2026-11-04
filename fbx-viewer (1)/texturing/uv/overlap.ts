/**
 * TRIANGLES LYING OVER EACH OTHER
 *
 * A layout must give every place on the surface texels of its own. A flattened piece can wrap round
 * onto itself with every triangle facing the right way (a ramp of two turns, a band curling back, a
 * slit opening onto its own sides), and islands can be laid on top of each other: then two places share
 * texels, and painting one paints the other. Found exactly here: two triangles overlap when no edge of
 * either separates them, so touching along an edge or at a corner does not count.
 */

/** How far apart two triangles must be found, as a share of the layout's size, to count as touching. */
const TOUCH = 1e-7;

/**
 * Calls `visit` with each pair of triangles lying over each other (each pair once) until it returns
 * true. `uv` holds two values per point; `corners` three points per triangle, `count` triangles.
 * `depth` is how deep an overlap must go to count (in the layout's units; a share of a texel, say), so
 * rounding is let be.
 */
const eachOverlap = (uv: ArrayLike<number>, corners: ArrayLike<number>, count: number, depth: number, visit: (s: number, t: number) => boolean): void => {
    let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
    for (let t = 0; t < count * 3; t++) {
        const u = uv[corners[t] * 2], v = uv[corners[t] * 2 + 1];
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
    }
    const extent = Math.max(maxU - minU, maxV - minV);
    if (!(extent > 0) || count < 2) return;
    const touch = Math.max(extent * TOUCH, depth);
    // Each triangle's box, and whether it covers anything (one with no area claims no texels).
    const box = new Float64Array(count * 4);
    const live = new Uint8Array(count);
    for (let t = 0; t < count; t++) {
        const a = corners[t * 3] * 2, b = corners[t * 3 + 1] * 2, c = corners[t * 3 + 2] * 2;
        box[t * 4] = Math.min(uv[a], uv[b], uv[c]);
        box[t * 4 + 1] = Math.min(uv[a + 1], uv[b + 1], uv[c + 1]);
        box[t * 4 + 2] = Math.max(uv[a], uv[b], uv[c]);
        box[t * 4 + 3] = Math.max(uv[a + 1], uv[b + 1], uv[c + 1]);
        const area = Math.abs((uv[b] - uv[a]) * (uv[c + 1] - uv[a + 1]) - (uv[c] - uv[a]) * (uv[b + 1] - uv[a + 1]));
        live[t] = area > extent * extent * TOUCH ? 1 : 0;
    }
    // A grid of about one triangle per cell.
    const cells = Math.max(1, Math.min(1024, Math.ceil(Math.sqrt(count))));
    const size = extent / cells;
    const cellOf = (value: number, origin: number) => Math.min(cells - 1, Math.max(0, Math.floor((value - origin) / size)));
    const grid: number[][] = new Array(cells * cells);
    for (let t = 0; t < count; t++) {
        if (!live[t]) continue;
        const x0 = cellOf(box[t * 4], minU), y0 = cellOf(box[t * 4 + 1], minV);
        const x1 = cellOf(box[t * 4 + 2], minU), y1 = cellOf(box[t * 4 + 3], minV);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) (grid[y * cells + x] ??= []).push(t);
    }
    for (let cell = 0; cell < grid.length; cell++) {
        const list = grid[cell];
        if (!list || list.length < 2) continue;
        const cx = cell % cells, cy = Math.floor(cell / cells);
        for (let i = 0; i < list.length; i++) {
            const s = list[i];
            for (let j = i + 1; j < list.length; j++) {
                const t = list[j];
                // Boxes apart: no overlap. Both in several cells: test the pair once, where their boxes' common corner lies.
                const ix = Math.max(box[s * 4], box[t * 4]), iy = Math.max(box[s * 4 + 1], box[t * 4 + 1]);
                if (ix >= Math.min(box[s * 4 + 2], box[t * 4 + 2]) - touch || iy >= Math.min(box[s * 4 + 3], box[t * 4 + 3]) - touch) continue;
                if (cellOf(ix, minU) !== cx || cellOf(iy, minV) !== cy) continue;
                if (separated(uv, corners, s, t, touch)) continue;
                if (visit(s, t)) return;
            }
        }
    }
};

/**
 * Triangles whose inside lies over another's. `uv` holds two values per point; `corners` three points
 * per triangle, `count` triangles. With `first`, stops at the first pair found. `depth` is how deep an
 * overlap must go to count (in the layout's units; a share of a texel, say).
 */
export const overlappingTriangles = (uv: ArrayLike<number>, corners: ArrayLike<number>, count: number, first = false, depth = 0): number[] => {
    const found = new Uint8Array(count);
    const out: number[] = [];
    const mark = (t: number) => { if (!found[t]) { found[t] = 1; out.push(t); } };
    eachOverlap(uv, corners, count, depth, (s, t) => {
        mark(s);
        mark(t);
        return first;
    });
    return out;
};

/** Up to `limit` pairs of triangles lying over each other (see overlappingTriangles). */
export const overlappingPairs = (uv: ArrayLike<number>, corners: ArrayLike<number>, count: number, depth = 0, limit = 256): Array<[number, number]> => {
    const pairs: Array<[number, number]> = [];
    eachOverlap(uv, corners, count, depth, (s, t) => {
        pairs.push([s, t]);
        return pairs.length >= limit;
    });
    return pairs;
};

/** Whether an edge of either triangle has the other wholly on its far side (or touching it). */
const separated = (uv: ArrayLike<number>, corners: ArrayLike<number>, s: number, t: number, touch: number): boolean => {
    const xs = [uv[corners[s * 3] * 2], uv[corners[s * 3 + 1] * 2], uv[corners[s * 3 + 2] * 2]];
    const ys = [uv[corners[s * 3] * 2 + 1], uv[corners[s * 3 + 1] * 2 + 1], uv[corners[s * 3 + 2] * 2 + 1]];
    const xt = [uv[corners[t * 3] * 2], uv[corners[t * 3 + 1] * 2], uv[corners[t * 3 + 2] * 2]];
    const yt = [uv[corners[t * 3] * 2 + 1], uv[corners[t * 3 + 1] * 2 + 1], uv[corners[t * 3 + 2] * 2 + 1]];
    for (let pass = 0; pass < 2; pass++) {
        const [px, py] = pass === 0 ? [xs, ys] : [xt, yt];
        for (let k = 0; k < 3; k++) {
            const ex = px[(k + 1) % 3] - px[k], ey = py[(k + 1) % 3] - py[k];
            const length = Math.hypot(ex, ey);
            if (length <= 0) continue;
            // The edge's normal, as a unit, so the gap is a distance.
            const nx = -ey / length, ny = ex / length;
            let minS = Infinity, maxS = -Infinity, minT = Infinity, maxT = -Infinity;
            for (let i = 0; i < 3; i++) {
                const a = xs[i] * nx + ys[i] * ny;
                const b = xt[i] * nx + yt[i] * ny;
                if (a < minS) minS = a;
                if (a > maxS) maxS = a;
                if (b < minT) minT = b;
                if (b > maxT) maxT = b;
            }
            if (maxS <= minT + touch || maxT <= minS + touch) return true;
        }
    }
    return false;
};
