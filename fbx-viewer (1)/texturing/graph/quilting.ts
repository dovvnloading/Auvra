import type { Picture } from './seamCut';

/**
 * GROWING A TEXTURE FROM AN EXAMPLE
 *
 * A larger picture made of patches of a small example, laid in rows on a repeating grid (the last
 * column and row overlap the first, so the result tiles). Each patch is the place in the example whose
 * overlap with what is already laid matches it best, picked at random among the near-best for variety,
 * and joined along the cheapest cut through each overlap, so the joins hide in the example's own
 * features and nothing shows twice. The result is a map: for each pixel, how far the example is
 * moved to give it (patches are moved copies), so the GPU can draw it at any size from the example at
 * its own detail.
 */

export interface GrowSettings {
    /** The result's size, in pixels of the map. */
    width: number;
    height: number;
    /** A patch's side, in pixels of the example (as given). */
    patch: number;
    /** How much of each patch overlaps the ones before it (0 to 0.5). */
    overlap: number;
    /** 0 picks the best match every time; 1 picks among all fairly good ones. */
    randomness: number;
    seed: number;
    /** The most places in the example tried for each patch. */
    candidates?: number;
}

export interface GrowMap {
    width: number;
    height: number;
    /** For each pixel (bottom row first), where in the example it comes from minus where it is: x, y. */
    offset: Float32Array;
    /** Patches laid. */
    patches: number;
}

/** A small seeded random number source (0 to 1). */
const randomSource = (seed: number) => {
    let state = (Math.floor(seed * 9973) ^ 0x9e3779b9) >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const wrap = (i: number, n: number): number => ((i % n) + n) % n;

/** Where patches start along one side of a repeating picture: evenly, each step at most `step`. */
const starts = (size: number, step: number): number[] => {
    const count = Math.max(1, Math.ceil(size / step));
    return Array.from({ length: count }, (_, i) => Math.round((i * size) / count));
};

/**
 * The map of a picture grown from `example`: patches laid in rows on a repeating grid, each the best
 * (or a near-best) match for the overlap with what is laid, joined along the cheapest cuts.
 */
export const growFromExample = (example: Picture, settings: GrowSettings): GrowMap => {
    const { width, height } = settings;
    const channels = example.channels;
    const patch = Math.max(4, Math.min(Math.round(settings.patch), example.width, example.height, width, height));
    const overlap = Math.max(1, Math.min(Math.floor(patch / 2), Math.round(patch * Math.min(0.5, Math.max(0.05, settings.overlap)))));
    const step = Math.max(1, patch - overlap);
    const xs = starts(width, step);
    const ys = starts(height, step);
    const random = randomSource(settings.seed);
    // The map (source minus destination), what is laid so far (its colour) and which pixels are laid.
    const offset = new Float32Array(width * height * 2);
    const laid = new Uint8Array(width * height);
    const colour = new Float32Array(width * height * channels);
    const exampleAt = (x: number, y: number, c: number) => example.data[(y * example.width + x) * channels + c];
    const spanX = example.width - patch + 1;
    const spanY = example.height - patch + 1;
    const total = spanX * spanY;
    const tries = Math.min(total, settings.candidates ?? 600);
    let patches = 0;
    for (let row = 0; row < ys.length; row++) {
        for (let column = 0; column < xs.length; column++) {
            const x0 = xs[column];
            const y0 = ys[row];
            // How well a place in the example matches what is laid under the patch (overlaps only).
            const cost = (sx: number, sy: number): number => {
                let sum = 0;
                for (let py = 0; py < patch; py++) {
                    const y = wrap(y0 + py, height);
                    for (let px = 0; px < patch; px++) {
                        const x = wrap(x0 + px, width);
                        if (!laid[y * width + x]) continue;
                        for (let c = 0; c < channels; c++) {
                            const d = colour[(y * width + x) * channels + c] - exampleAt(sx + px, sy + py, c);
                            sum += d * d;
                        }
                    }
                }
                return sum;
            };
            // Places tried: all when few, else a seeded sample.
            const tried: Array<[number, number, number]> = [];
            for (let k = 0; k < tries; k++) {
                const index = tries === total ? k : Math.floor(random() * total);
                const sx = index % spanX;
                const sy = Math.floor(index / spanX);
                tried.push([sx, sy, patches === 0 ? 0 : cost(sx, sy)]);
            }
            const best = Math.min(...tried.map((entry) => entry[2]));
            const tolerance = best * (1 + settings.randomness * 0.6) + 1e-9 + settings.randomness * 1e-6;
            const near = tried.filter((entry) => entry[2] <= tolerance);
            const [sx, sy] = near[Math.floor(random() * near.length)];
            // Which patch pixels it takes: those past the cheapest cut through each overlap with what is laid.
            const error = (px: number, py: number): number => {
                const x = wrap(x0 + px, width);
                const y = wrap(y0 + py, height);
                if (!laid[y * width + x]) return 0;
                let sum = 0;
                for (let c = 0; c < channels; c++) {
                    const d = colour[(y * width + x) * channels + c] - exampleAt(sx + px, sy + py, c);
                    sum += d * d;
                }
                return sum;
            };
            const keep = new Uint8Array(patch * patch).fill(1);
            const cutAlong = (vertical: boolean, from: number, to: number, keepAfter: boolean) => {
                // A cut down (or across) the band [from, to) of the patch: the patch keeps the side after (or before) it.
                const band = to - from;
                if (band <= 0) return;
                const totalCost = new Float64Array(band * patch);
                const back = new Int8Array(band * patch);
                const at = (i: number, j: number) => (vertical ? error(from + i, j) : error(j, from + i));
                for (let i = 0; i < band; i++) totalCost[i] = at(i, 0);
                for (let j = 1; j < patch; j++) {
                    for (let i = 0; i < band; i++) {
                        let bestPrev = totalCost[(j - 1) * band + i];
                        let move = 0;
                        if (i > 0 && totalCost[(j - 1) * band + i - 1] < bestPrev) { bestPrev = totalCost[(j - 1) * band + i - 1]; move = -1; }
                        if (i < band - 1 && totalCost[(j - 1) * band + i + 1] < bestPrev) { bestPrev = totalCost[(j - 1) * band + i + 1]; move = 1; }
                        totalCost[j * band + i] = bestPrev + at(i, j);
                        back[j * band + i] = move;
                    }
                }
                let i = 0;
                for (let k = 1; k < band; k++) if (totalCost[(patch - 1) * band + k] < totalCost[(patch - 1) * band + i]) i = k;
                for (let j = patch - 1; j >= 0; j--) {
                    for (let k = 0; k < band; k++) {
                        const taken = keepAfter ? k >= i : k <= i;
                        if (!taken) keep[vertical ? j * patch + from + k : (from + k) * patch + j] = 0;
                    }
                    i += back[j * band + i];
                }
            };
            if (patches > 0) {
                // Overlaps with what is laid: left and below as rows are laid, and right and above where the grid comes round.
                const laidAt = (px: number, py: number) => laid[wrap(y0 + py, height) * width + wrap(x0 + px, width)] === 1;
                const columnLaid = (px: number) => { for (let py = 0; py < patch; py++) if (laidAt(px, py)) return true; return false; };
                const rowLaid = (py: number) => { for (let px = 0; px < patch; px++) if (laidAt(px, py)) return true; return false; };
                if (columnLaid(0)) cutAlong(true, 0, overlap, true);
                if (columnLaid(patch - 1)) cutAlong(true, patch - overlap, patch, false);
                if (rowLaid(0)) cutAlong(false, 0, overlap, true);
                if (rowLaid(patch - 1)) cutAlong(false, patch - overlap, patch, false);
            }
            for (let py = 0; py < patch; py++) {
                for (let px = 0; px < patch; px++) {
                    const x = wrap(x0 + px, width);
                    const y = wrap(y0 + py, height);
                    const at = y * width + x;
                    // Past a cut, what is laid stays; nothing is ever left empty.
                    if (!keep[py * patch + px] && laid[at]) continue;
                    laid[at] = 1;
                    // Where it comes from in the example, less where it lies on the repeating picture.
                    offset[at * 2] = sx + px - x;
                    offset[at * 2 + 1] = sy + py - y;
                    for (let c = 0; c < channels; c++) colour[at * channels + c] = exampleAt(sx + px, sy + py, c);
                }
            }
            patches++;
        }
    }
    return { width, height, offset, patches };
};

/**
 * Where the map says a place of the result comes from in the example (both in the map's pixels), for
 * a place `x`, `y` (continuous, wrapping): the pixel's own move, as the GPU reads it.
 */
export const grownSource = (map: GrowMap, x: number, y: number): [number, number] => {
    const px = wrap(Math.floor(x), map.width);
    const py = wrap(Math.floor(y), map.height);
    const at = py * map.width + px;
    // The place within its own patch: the pixel's position as it lies on the repeating grid.
    return [px + (x - Math.floor(x)) + map.offset[at * 2], py + (y - Math.floor(y)) + map.offset[at * 2 + 1]];
};

/** The grown picture itself at the map's size (each pixel the example's pixel the map gives), for checking. */
export const grownPicture = (example: Picture, map: GrowMap): Picture => {
    const data = new Float32Array(map.width * map.height * example.channels);
    for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
            const [sx, sy] = grownSource(map, x, y);
            const ex = Math.min(example.width - 1, Math.max(0, Math.round(sx)));
            const ey = Math.min(example.height - 1, Math.max(0, Math.round(sy)));
            for (let c = 0; c < example.channels; c++) data[(y * map.width + x) * example.channels + c] = example.data[(ey * example.width + ex) * example.channels + c];
        }
    }
    return { data, width: map.width, height: map.height, channels: example.channels };
};
