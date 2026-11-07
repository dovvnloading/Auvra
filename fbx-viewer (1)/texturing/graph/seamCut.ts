/**
 * MAKING A PICTURE TILE BY CUTTING ALONG ITS LEAST VISIBLE JOINS
 *
 * A picture that does not tile is shifted by half each way, so its own edges meet in a cross through
 * the middle and its new edges (its old middle) run on round. Each arm of the cross is then covered by
 * a band of the picture taken from where it has no seam, joined on each side along the path where the
 * two pictures differ least: a cut, never a cross-fade, so nothing shows twice. The cuts are found by
 * dynamic programming, each a path one step a row (or column) that closes up with itself top to
 * bottom, so the result tiles. Last, the result is shifted back, so the picture's middle is its own.
 *
 *   O(p)  = I(p + (1/2, 1/2))               the shifted picture: tiles, seams on x = 1/2 and y = 1/2
 *   Sv(p) = I(p + (0, 1/2))                 no seam down x = 1/2: covers the upright arm
 *   R1    = O, with Sv between the two upright cuts
 *   Sh(p) = R1(p + (0, 1/2))                no seam along y = 1/2: covers the level arm
 *   R2    = R1, with Sh between the two level cuts
 *   F(p)  = R2(p - (1/2, 1/2))
 *
 * Pictures here are rows of pixels, bottom row first, `channels` values a pixel.
 */

export interface Picture { data: Float32Array; width: number; height: number; channels: number }

const wrapIndex = (i: number, n: number): number => ((i % n) + n) % n;

/** One pixel's channels into `out`, read with wrapping. */
const readAt = (picture: Picture, x: number, y: number, out: Float32Array, offset = 0): void => {
    const { data, width, height, channels } = picture;
    const at = (wrapIndex(y, height) * width + wrapIndex(x, width)) * channels;
    for (let c = 0; c < channels; c++) out[offset + c] = data[at + c];
};

/**
 * The cheapest path down a band of columns (one column a row, moving at most one a row), from row 0
 * to the last, that ends next to where it starts, so it closes up when the picture repeats down.
 * `cost(x, y)` is what crossing a pixel costs. Returns the column of each row.
 */
export const closedCut = (cost: (x: number, y: number) => number, from: number, to: number, height: number): Int32Array => {
    const width = Math.max(1, to - from);
    const total = new Float64Array(width * height);
    const step = new Int8Array(width * height);
    const run = (start: number | null) => {
        for (let x = 0; x < width; x++) total[x] = start === null || x === start ? cost(from + x, 0) : Infinity;
        for (let y = 1; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let best = total[(y - 1) * width + x];
                let move = 0;
                if (x > 0 && total[(y - 1) * width + x - 1] < best) { best = total[(y - 1) * width + x - 1]; move = -1; }
                if (x < width - 1 && total[(y - 1) * width + x + 1] < best) { best = total[(y - 1) * width + x + 1]; move = 1; }
                total[y * width + x] = best + cost(from + x, y);
                step[y * width + x] = move;
            }
        }
    };
    const trace = (finish: number): Int32Array => {
        const path = new Int32Array(height);
        let x = finish;
        for (let y = height - 1; y >= 0; y--) {
            path[y] = from + x;
            x += step[y * width + x];
        }
        return path;
    };
    // Once free, to find where the best path wants to start and end; then held to start at each of
    // those places in turn, ending beside where it started, and the cheapest of those kept.
    run(null);
    let end = 0;
    for (let x = 1; x < width; x++) if (total[(height - 1) * width + x] < total[(height - 1) * width + end]) end = x;
    const freeStart = trace(end)[0] - from;
    let best: Int32Array | null = null;
    let bestCost = Infinity;
    for (const start of new Set([freeStart, end - 1, end, end + 1])) {
        if (start < 0 || start >= width) continue;
        run(start);
        let finish = -1;
        for (const x of [start - 1, start, start + 1]) {
            if (x >= 0 && x < width && (finish < 0 || total[(height - 1) * width + x] < total[(height - 1) * width + finish])) finish = x;
        }
        const cost = total[(height - 1) * width + finish];
        if (cost < bestCost) { bestCost = cost; best = trace(finish); }
    }
    return best ?? trace(end);
};

/** Squared difference of two pictures' pixels, read with wrapping. */
const differenceOf = (a: (x: number, y: number, out: Float32Array) => void, b: (x: number, y: number, out: Float32Array) => void, channels: number) => {
    const pa = new Float32Array(channels);
    const pb = new Float32Array(channels);
    return (x: number, y: number): number => {
        a(x, y, pa);
        b(x, y, pb);
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += (pa[c] - pb[c]) ** 2;
        return sum;
    };
};

export interface SeamMasks {
    /** 1 where the upright band's picture (Sv) is used, by pixel (bottom row first). */
    upright: Float32Array;
    /** 1 where the level band's picture (Sh) is used. */
    level: Float32Array;
    /** The cuts' cost a pixel along them: how visible the joins are (0 for a perfect join). */
    cost: number;
}

/**
 * The masks of the two bands for `picture`: `band` is each band's half width and `margin` how near
 * the seam a cut may come, both in pixels.
 */
export const seamMasks = (picture: Picture, band: number, margin = 2): SeamMasks => {
    const { width, height, channels } = picture;
    const halfW = width >> 1;
    const halfH = height >> 1;
    const b = Math.max(margin + 1, Math.min(Math.floor(band), halfW - 1, halfH - 1));
    const m = Math.min(margin, b - 1);
    const shifted = (x: number, y: number, out: Float32Array) => readAt(picture, x + halfW, y + halfH, out);
    const upright = (x: number, y: number, out: Float32Array) => readAt(picture, x, y + halfH, out);
    const uprightMask = new Float32Array(width * height);
    let spent = 0;
    // The upright arm: a cut each side of x = width / 2.
    const crossUpright = differenceOf(shifted, upright, channels);
    const left = closedCut(crossUpright, halfW - b, halfW - m, height);
    const right = closedCut(crossUpright, halfW + m + 1, halfW + b + 1, height);
    for (let y = 0; y < height; y++) {
        spent += crossUpright(left[y], y) + crossUpright(right[y], y);
        for (let x = left[y]; x < right[y]; x++) uprightMask[y * width + x] = 1;
    }
    // R1, then the level arm against R1 moved down by half.
    const r1 = new Float32Array(width * height * channels);
    const pa = new Float32Array(channels);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const inside = uprightMask[y * width + x] > 0.5;
            if (inside) upright(x, y, pa); else shifted(x, y, pa);
            r1.set(pa, (y * width + x) * channels);
        }
    }
    const r1Picture: Picture = { data: r1, width, height, channels };
    const fromR1 = (x: number, y: number, out: Float32Array) => readAt(r1Picture, x, y, out);
    const below = (x: number, y: number, out: Float32Array) => readAt(r1Picture, x, y + halfH, out);
    // Level cuts run along columns: the same search with x and y swapped.
    const crossLevel = differenceOf((y, x, out) => fromR1(x, y, out), (y, x, out) => below(x, y, out), channels);
    const bottom = closedCut(crossLevel, halfH - b, halfH - m, width);
    const top = closedCut(crossLevel, halfH + m + 1, halfH + b + 1, width);
    const levelMask = new Float32Array(width * height);
    for (let x = 0; x < width; x++) {
        spent += crossLevel(bottom[x], x) + crossLevel(top[x], x);
        for (let y = bottom[x]; y < top[x]; y++) levelMask[y * width + x] = 1;
    }
    return { upright: uprightMask, level: levelMask, cost: spent / (2 * (width + height)) };
};

/** A mask blurred by a box `radius` pixels each way, wrapping round (for a soft edge to the cuts). */
export const softenMask = (mask: Float32Array, width: number, height: number, radius: number): Float32Array => {
    const r = Math.floor(radius);
    if (r < 1) return mask;
    const across = new Float32Array(mask.length);
    const out = new Float32Array(mask.length);
    const n = 2 * r + 1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let sum = 0;
            for (let k = -r; k <= r; k++) sum += mask[y * width + wrapIndex(x + k, width)];
            across[y * width + x] = sum / n;
        }
    }
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let sum = 0;
            for (let k = -r; k <= r; k++) sum += across[wrapIndex(y + k, height) * width + x];
            out[y * width + x] = sum / n;
        }
    }
    return out;
};

/**
 * The tiling picture itself, worked out on the CPU (the node does the same on the GPU at full size,
 * with the masks found on a smaller copy). Masks soft or hard, as given.
 */
export const seamTile = (picture: Picture, masks: Pick<SeamMasks, 'upright' | 'level'>): Picture => {
    const { width, height, channels } = picture;
    const halfW = width >> 1;
    const halfH = height >> 1;
    const out = new Float32Array(width * height * channels);
    const o = new Float32Array(channels);
    const sv = new Float32Array(channels);
    const r1 = (x: number, y: number, result: Float32Array) => {
        readAt(picture, x + halfW, y + halfH, o);
        readAt(picture, x, y + halfH, sv);
        const m = masks.upright[wrapIndex(y, height) * width + wrapIndex(x, width)];
        for (let c = 0; c < channels; c++) result[c] = o[c] * (1 - m) + sv[c] * m;
    };
    const a = new Float32Array(channels);
    const b = new Float32Array(channels);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            // F(p) = R2(p - half); R2 = mix(R1(q), R1(q + (0, half)), level(q)).
            const qx = x - halfW;
            const qy = y - halfH;
            r1(qx, qy, a);
            r1(qx, qy + halfH, b);
            const m = masks.level[wrapIndex(qy, height) * width + wrapIndex(qx, width)];
            for (let c = 0; c < channels; c++) out[(y * width + x) * channels + c] = a[c] * (1 - m) + b[c] * m;
        }
    }
    return { data: out, width, height, channels };
};
