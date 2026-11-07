/**
 * ASTC 4×4 (LDR), for phones and other graphics cards without BC.
 *
 * Every block is written in one of a few simple, always-valid layouts, one plane and a 4×4 weight grid, whose end points
 * take a whole number of bits each (so no trits or quints are needed):
 * - opaque blocks: one partition, colour end points at 8 bits (mode 8, "LDR RGB direct"), eight steps between them;
 * - blocks with varying alpha: one partition, colour and alpha end points at 8 bits (mode 12, "LDR RGBA direct"), four
 *   steps;
 * - opaque blocks of two colours one line cannot hold: two partitions (the block split one of the format's ways, found
 *   by a hash of the partition's number), either colour end points at 4 bits with eight steps (mode 8), or a colour at
 *   8 bits and how dark its other end is (mode 6, "LDR RGB base and scale") with four steps, whichever comes back
 *   closest.
 * End points come from each partition's main axis of colour, refined by least squares, and are ordered so the decoder
 * never applies blue contraction. The decoder here reads any block of these layouts from its fields (block mode,
 * partitions, colour endpoint mode, weights from the top), exactly as a graphics card decodes them, for the
 * compression preview and tests.
 */

/** Bytes in a block. */
export const ASTC_BLOCK_BYTES = 16;

const RGB_MODE = 8;
const RGBA_MODE = 12;
const RGB_SCALE_MODE = 6;

// Weight levels as the decoder expands them (0..64): plain 3-bit and 2-bit weights, bit-replicated, +1 above 32.
const expandWeight = (value: number, bits: number): number => {
    let six = 0;
    for (let filled = 0; filled < 6; filled += bits) six = (six << bits) | value;
    six >>= Math.max(0, Math.ceil(6 / bits) * bits - 6);
    return six > 32 ? six + 1 : six;
};
const WEIGHTS_3 = Array.from({ length: 8 }, (_, value) => expandWeight(value, 3));
const WEIGHTS_2 = Array.from({ length: 4 }, (_, value) => expandWeight(value, 2));

/** Block mode bits for a 4×4 weight grid, one plane, weights 0..7 (R = 111) or 0..3 (R = 100), H = 0. */
const blockMode = (range: 8 | 4): number => {
    const r = range === 8 ? 0b111 : 0b100;
    const r0 = r & 1, r1 = (r >> 1) & 1, r2 = (r >> 2) & 1;
    // Layout D H B B A A R0 0 0 R2 R1, width B + 4, height A + 2: A = 2, B = 0.
    const a = 2, b = 0;
    return r1 | (r2 << 1) | (r0 << 4) | ((a & 3) << 5) | ((b & 3) << 7);
};

const setBits = (block: Uint8Array, at: number, count: number, value: number): void => {
    for (let i = 0; i < count; i++) if ((value >> i) & 1) block[(at + i) >> 3] |= 1 << ((at + i) & 7);
};

const getBits = (block: Uint8Array, at: number, count: number): number => {
    let value = 0;
    for (let i = 0; i < count; i++) value |= ((block[(at + i) >> 3] >> ((at + i) & 7)) & 1) << i;
    return value;
};

/**
 * A decoded 16-bit value as a byte, as the format hands it on: a half float (the value over 65536, its mantissa cut to
 * ten bits; all ones is 1), then rounded to the nearest of 256 steps as an 8-bit picture keeps it.
 */
const toByte = (value: number): number => {
    if (value === 0xffff) return 255;
    const drop = Math.max(0, 31 - Math.clz32(value) - 10);
    return Math.round(((value >> drop) << drop) * 255 / 65536);
};

/** The colour the decoder gives between end points at weight `w` (0..64), in 8 bits as a graphics card reads it. */
const interpolate = (e0: number, e1: number, w: number): number => {
    const c0 = (e0 << 8) | e0;
    const c1 = (e1 << 8) | e1;
    return toByte(Math.floor((c0 * (64 - w) + c1 * w + 32) / 64));
};

const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

// --- Partitions --------------------------------------------------------------------------------------------------

/** The format's hash of a partition's number. */
const hash52 = (input: number): number => {
    let p = input >>> 0;
    p = (p ^ (p >>> 15)) >>> 0;
    p = (p - (p << 17)) >>> 0;
    p = (p + (p << 7)) >>> 0;
    p = (p + (p << 4)) >>> 0;
    p = (p ^ (p >>> 5)) >>> 0;
    p = (p + (p << 16)) >>> 0;
    p = (p ^ (p >>> 7)) >>> 0;
    p = (p ^ (p >>> 3)) >>> 0;
    p = (p ^ (p << 6)) >>> 0;
    p = (p ^ (p >>> 17)) >>> 0;
    return p;
};

/** Which of `count` partitions texel (x, y, z) of a small block (fewer than 31 texels) is in, for partition number `seed`. */
const partitionOf = (seedIn: number, xIn: number, yIn: number, zIn: number, count: number): number => {
    const x = xIn << 1, y = yIn << 1, z = zIn << 1;
    const seed = seedIn + (count - 1) * 1024;
    const rnum = hash52(seed);
    const nibble = (shift: number) => (rnum >>> shift) & 0xf;
    const seeds = [nibble(0), nibble(4), nibble(8), nibble(12), nibble(16), nibble(20), nibble(24), nibble(28), nibble(18), nibble(22), nibble(26), ((rnum >>> 30) | (rnum << 2)) & 0xf]
        .map(value => value * value);
    let sh1: number, sh2: number;
    if (seed & 1) {
        sh1 = seed & 2 ? 4 : 5;
        sh2 = count === 3 ? 6 : 5;
    } else {
        sh1 = count === 3 ? 6 : 5;
        sh2 = seed & 2 ? 4 : 5;
    }
    const sh3 = seed & 0x10 ? sh1 : sh2;
    const shifts = [sh1, sh2, sh1, sh2, sh1, sh2, sh1, sh2, sh3, sh3, sh3, sh3];
    const [s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12] = seeds.map((value, i) => value >> shifts[i]);
    const a = (s1 * x + s2 * y + s11 * z + (rnum >>> 14)) & 0x3f;
    const b = (s3 * x + s4 * y + s12 * z + (rnum >>> 10)) & 0x3f;
    const c = count < 3 ? 0 : (s5 * x + s6 * y + s9 * z + (rnum >>> 6)) & 0x3f;
    const d = count < 4 ? 0 : (s7 * x + s8 * y + s10 * z + (rnum >>> 2)) & 0x3f;
    if (a >= b && a >= c && a >= d) return 0;
    if (b >= c && b >= d) return 1;
    if (c >= d) return 2;
    return 3;
};

/** A 4×4 block's two-partition split for a partition number: one bit a texel (texel 0 lowest), set in the second. */
const splitMask = (seed: number): number => {
    let mask = 0;
    for (let i = 0; i < 16; i++) if (partitionOf(seed, i & 3, i >> 2, 0, 2) === 1) mask |= 1 << i;
    return mask;
};

/** Every distinct way the format splits a 4×4 block in two (with the first number giving it). */
const SPLITS: ReadonlyArray<{ seed: number; mask: number }> = (() => {
    const seen = new Set<number>();
    const splits: Array<{ seed: number; mask: number }> = [];
    for (let seed = 0; seed < 1024; seed++) {
        const mask = splitMask(seed);
        // A split leaving a partition empty is no split; one seen already (either way round) adds nothing.
        if (mask === 0 || mask === 0xffff || seen.has(mask) || seen.has(~mask & 0xffff)) continue;
        seen.add(mask);
        splits.push({ seed, mask });
    }
    return splits;
})();

/** Splits fitted in full for a block. */
const SPLITS_TRIED = 3;
/** A block one partition keeps this close (summed squared error over its pixels and channels) is not split. */
const CLOSE_ENOUGH = 96;

/** The block's pixels in two groups round two colours (two rounds of k-means from its main axis), as a split mask. */
const idealSplit = (pixels: number[][]): number => {
    const { e0, e1 } = axisEndpoints(pixels, 3);
    let centres = [e0.slice(), e1.slice()];
    let mask = 0;
    for (let round = 0; round < 3; round++) {
        mask = 0;
        const sums = [[0, 0, 0, 0], [0, 0, 0, 0]];
        pixels.forEach((pixel, i) => {
            const d = centres.map(centre => (pixel[0] - centre[0]) ** 2 + (pixel[1] - centre[1]) ** 2 + (pixel[2] - centre[2]) ** 2);
            const group = d[1] < d[0] ? 1 : 0;
            if (group) mask |= 1 << i;
            for (let c = 0; c < 3; c++) sums[group][c] += pixel[c];
            sums[group][3]++;
        });
        if (!sums[0][3] || !sums[1][3]) break;
        centres = sums.map(sum => [sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3]]);
    }
    return mask;
};

const popcount = (value: number): number => {
    let count = 0;
    for (let v = value; v; v &= v - 1) count++;
    return count;
};

/** The format's splits nearest the block's own two groups of colour (fewest texels apart, either way round). */
const nearestSplits = (pixels: number[][]): Array<{ seed: number; mask: number }> => {
    const ideal = idealSplit(pixels);
    const kept: Array<{ split: { seed: number; mask: number }; apart: number }> = [];
    for (const split of SPLITS) {
        const apart = Math.min(popcount(split.mask ^ ideal), popcount(split.mask ^ ~ideal & 0xffff));
        if (kept.length < SPLITS_TRIED || apart < kept[kept.length - 1].apart) {
            kept.push({ split, apart });
            kept.sort((a, b) => a.apart - b.apart);
            if (kept.length > SPLITS_TRIED) kept.pop();
        }
    }
    return kept.map(entry => entry.split);
};

// --- Fitting end points ------------------------------------------------------------------------------------------

interface Fit { e0: number[]; e1: number[]; weights: number[]; error: number }

/** The nearest weight for each pixel between two end points, and the error left. */
const assign = (pixels: number[][], e0: number[], e1: number[], levels: readonly number[], channels: number): Fit => {
    const weights: number[] = [];
    let error = 0;
    for (const pixel of pixels) {
        let best = 0;
        let bestError = Infinity;
        for (let q = 0; q < levels.length; q++) {
            let sum = 0;
            for (let c = 0; c < channels; c++) {
                const d = interpolate(e0[c], e1[c], levels[q]) - pixel[c];
                sum += d * d;
            }
            if (sum < bestError) { bestError = sum; best = q; }
        }
        weights.push(best);
        error += bestError;
    }
    return { e0, e1, weights, error };
};

/**
 * Where the search for the pixels' main axis starts: toward the pixel furthest from their mean. A fixed start (grey)
 * finds nothing when the colours differ by as much up as down, as a red and a blue of the same brightness do.
 */
export const spreadStart = (pixels: readonly number[][], mean: readonly number[]): number[] => {
    let furthest = 0;
    let start = mean.map(() => 1);
    for (const pixel of pixels) {
        const d = pixel.map((value, c) => value - mean[c]);
        const distance = d.reduce((sum, value) => sum + value * value, 0);
        if (distance > furthest) { furthest = distance; start = d; }
    }
    return start;
};

/** End points from the pixels' main axis (power iteration on their spread). */
const axisEndpoints = (pixels: number[][], channels: number): { e0: number[]; e1: number[] } => {
    const mean = new Array(channels).fill(0);
    for (const pixel of pixels) for (let c = 0; c < channels; c++) mean[c] += pixel[c] / pixels.length;
    const cov = Array.from({ length: channels }, () => new Array(channels).fill(0));
    for (const pixel of pixels) for (let i = 0; i < channels; i++) for (let j = 0; j < channels; j++) cov[i][j] += (pixel[i] - mean[i]) * (pixel[j] - mean[j]);
    let axis = spreadStart(pixels.map(pixel => pixel.slice(0, channels)), mean);
    for (let step = 0; step < 8; step++) {
        const next = cov.map(row => row.reduce((sum, value, j) => sum + value * axis[j], 0));
        const length = Math.hypot(...next);
        if (length < 1e-9) break;
        axis = next.map(value => value / length);
    }
    let low = Infinity, high = -Infinity;
    for (const pixel of pixels) {
        let t = 0;
        for (let c = 0; c < channels; c++) t += (pixel[c] - mean[c]) * axis[c];
        low = Math.min(low, t);
        high = Math.max(high, t);
    }
    if (!Number.isFinite(low)) low = high = 0;
    return { e0: mean.map((m, c) => clamp(m + axis[c] * low)), e1: mean.map((m, c) => clamp(m + axis[c] * high)) };
};

/** End points that best fit the weights given (least squares), per channel. */
const refine = (pixels: number[][], weights: number[], levels: readonly number[], channels: number): { e0: number[]; e1: number[] } | null => {
    let aa = 0, ab = 0, bb = 0;
    const ax = new Array(channels).fill(0), bx = new Array(channels).fill(0);
    pixels.forEach((pixel, i) => {
        const t = levels[weights[i]] / 64;
        const a = 1 - t;
        aa += a * a; ab += a * t; bb += t * t;
        for (let c = 0; c < channels; c++) { ax[c] += a * pixel[c]; bx[c] += t * pixel[c]; }
    });
    const det = aa * bb - ab * ab;
    if (Math.abs(det) < 1e-9) return null;
    return {
        e0: ax.map((value, c) => clamp((value * bb - bx[c] * ab) / det)),
        e1: bx.map((value, c) => clamp((value * aa - ax[c] * ab) / det)),
    };
};

/** End points rounded to what `bits` a channel keep, as the decoder widens them back to 8 bits (bit replication). */
const keptAt = (bits: number) => (value: number): number => {
    if (bits >= 8) return clamp(value);
    const steps = (1 << bits) - 1;
    const kept = Math.round(clamp(value) * steps / 255);
    return replicate(kept, bits);
};

const fitBlock = (pixels: number[][], channels: number, levels: readonly number[], keep: (value: number) => number = clamp): Fit => {
    const start = axisEndpoints(pixels, channels);
    let best = assign(pixels, start.e0.map(keep), start.e1.map(keep), levels, channels);
    for (let round = 0; round < 2 && best.error > 0; round++) {
        const better = refine(pixels, best.weights, levels, channels);
        if (!better) break;
        const tried = assign(pixels, better.e0.map(keep), better.e1.map(keep), levels, channels);
        if (tried.error >= best.error) break;
        best = tried;
    }
    return best;
};

/** A colour and how dark the partition's other end is (mode 6): along the line through black to the partition's colour. */
const fitScale = (pixels: number[][]): Fit & { scale: number } => {
    const mean = [0, 0, 0];
    for (const pixel of pixels) for (let c = 0; c < 3; c++) mean[c] += pixel[c] / pixels.length;
    const length = Math.hypot(mean[0], mean[1], mean[2]);
    const direction = length > 1e-6 ? mean.map(value => value / length) : [0.57735, 0.57735, 0.57735];
    let low = Infinity, high = 0;
    for (const pixel of pixels) {
        const t = pixel[0] * direction[0] + pixel[1] * direction[1] + pixel[2] * direction[2];
        low = Math.min(low, t);
        high = Math.max(high, t);
    }
    const e1 = direction.map(value => clamp(value * high));
    const scale = high > 1e-6 ? Math.max(0, Math.min(255, Math.round(low / high * 256))) : 255;
    const e0 = e1.map(value => (value * scale) >> 8);
    return { ...assign(pixels, e0, e1, WEIGHTS_2, 3), scale };
};

/** A value of `bits` widened to 8 bits by repeating it, as the decoder does for a range that is a power of two. */
const replicate = (value: number, bits: number): number => {
    let out = 0;
    let filled = 0;
    while (filled < 8) { out = (out << bits) | value; filled += bits; }
    return out >> (filled - 8);
};

/** Mode 8 end points ordered so the decoder never contracts blue: the second must not sum lower. */
const ordered = (fit: Fit, levels: readonly number[]): Fit => {
    if (fit.e1[0] + fit.e1[1] + fit.e1[2] >= fit.e0[0] + fit.e0[1] + fit.e0[2]) return fit;
    return { ...fit, e0: fit.e1, e1: fit.e0, weights: fit.weights.map(weight => levels.length - 1 - weight) };
};

/** Writes the weights from the top of the block, their bits reversed. */
const writeWeights = (out: Uint8Array, weights: readonly number[], bits: number): void => {
    weights.forEach((weight, i) => {
        for (let b = 0; b < bits; b++) if ((weight >> b) & 1) {
            const at = 127 - (i * bits + b);
            out[at >> 3] |= 1 << (at & 7);
        }
    });
};

/** An opaque block split in two the way `split` says, in mode 8 at 4 bits or mode 6 at 8 bits; with its error. */
const encodeSplit = (pixels: number[][], split: { seed: number; mask: number }, mode: typeof RGB_MODE | typeof RGB_SCALE_MODE): { bytes: Uint8Array; error: number } => {
    const groups = [0, 1].map(part => pixels.map((_, i) => i).filter(i => ((split.mask >> i) & 1) === part));
    const weights = new Array<number>(16).fill(0);
    const values: number[] = [];
    let error = 0;
    for (const members of groups) {
        const own = members.map(i => pixels[i]);
        if (mode === RGB_MODE) {
            const fit = ordered(fitBlock(own, 3, WEIGHTS_3, keptAt(4)), WEIGHTS_3);
            for (let c = 0; c < 3; c++) values.push(Math.round(fit.e0[c] / 17), Math.round(fit.e1[c] / 17));
            members.forEach((i, k) => { weights[i] = fit.weights[k]; });
            error += fit.error;
        } else {
            const fit = fitScale(own);
            values.push(fit.e1[0], fit.e1[1], fit.e1[2], fit.scale);
            members.forEach((i, k) => { weights[i] = fit.weights[k]; });
            error += fit.error;
        }
    }
    const out = new Uint8Array(ASTC_BLOCK_BYTES);
    const weightBits = mode === RGB_MODE ? 3 : 2;
    setBits(out, 0, 11, blockMode(mode === RGB_MODE ? 8 : 4));
    setBits(out, 11, 2, 1);
    setBits(out, 13, 10, split.seed);
    // Both partitions take the same colour endpoint mode (the field's low two bits 0).
    setBits(out, 23, 6, mode << 2);
    const valueBits = mode === RGB_MODE ? 4 : 8;
    values.forEach((value, k) => setBits(out, 29 + k * valueBits, valueBits, value));
    writeWeights(out, weights, weightBits);
    return { bytes: out, error };
};

/** One block of 16 RGBA pixels (row by row) as an ASTC 4×4 block. */
export const encodeAstcBlock = (block: Uint8Array): Uint8Array => {
    const out = new Uint8Array(ASTC_BLOCK_BYTES);
    const pixels: number[][] = [];
    let alphaVaries = false;
    for (let i = 0; i < 16; i++) {
        pixels.push([block[i * 4], block[i * 4 + 1], block[i * 4 + 2], block[i * 4 + 3]]);
        if (block[i * 4 + 3] !== 255) alphaVaries = true;
    }
    const channels = alphaVaries ? 4 : 3;
    const levels = alphaVaries ? WEIGHTS_2 : WEIGHTS_3;
    const { e0, e1, weights, error } = ordered(fitBlock(pixels, channels, levels), levels);
    setBits(out, 0, 11, blockMode(alphaVaries ? 4 : 8));
    setBits(out, 11, 2, 0);
    setBits(out, 13, 4, alphaVaries ? RGBA_MODE : RGB_MODE);
    // End points v0..: (r0, r1, g0, g1, b0, b1[, a0, a1]), 8 bits each from bit 17.
    for (let c = 0; c < channels; c++) {
        setBits(out, 17 + c * 16, 8, e0[c]);
        setBits(out, 17 + c * 16 + 8, 8, e1[c]);
    }
    writeWeights(out, weights, alphaVaries ? 2 : 3);
    if (alphaVaries || error <= CLOSE_ENOUGH) return out;
    // Two colours one line cannot hold: the format's splits nearest the block's own, in each layout.
    let best = out;
    let bestError = error;
    for (const split of nearestSplits(pixels)) {
        for (const mode of [RGB_MODE, RGB_SCALE_MODE] as const) {
            const tried = encodeSplit(pixels, split, mode);
            if (tried.error < bestError) { best = tried.bytes; bestError = tried.error; }
        }
    }
    return best;
};

// --- Decoding ----------------------------------------------------------------------------------------------------

/** What a block's mode says: the weight grid and the weights' range; null for anything else. */
const readBlockMode = (mode: number): { width: number; height: number; levels: number; dualPlane: boolean } | null => {
    if ((mode & 3) === 0) return null;
    const r = ((mode >> 4) & 1) | ((mode & 3) << 1);
    const h = (mode >> 9) & 1;
    const a = (mode >> 5) & 3;
    const b = (mode >> 7) & 3;
    let width: number, height: number;
    switch ((mode >> 2) & 3) {
        case 0: width = b + 4; height = a + 2; break;
        case 1: width = b + 8; height = a + 2; break;
        case 2: width = a + 2; height = b + 8; break;
        default:
            if ((mode >> 8) & 1) { width = (b & 1) + 2; height = a + 2; } else { width = a + 2; height = (b & 1) + 6; }
    }
    const ranges = h ? [0, 0, 10, 12, 16, 20, 24, 32] : [0, 0, 2, 3, 4, 5, 6, 8];
    return { width, height, levels: ranges[r], dualPlane: ((mode >> 10) & 1) === 1 };
};

/** Colour end point ranges, smallest first, and the bits `count` values of each take (trits and quints packed). */
const COLOUR_RANGES: ReadonlyArray<{ levels: number; bits: (count: number) => number }> = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128, 160, 192, 256].map((levels) => {
    const trits = levels % 3 === 0, quints = levels % 5 === 0;
    const plain = Math.log2(levels / (trits ? 3 : quints ? 5 : 1));
    return { levels, bits: (count: number) => count * plain + (trits ? Math.floor((8 * count + 4) / 5) : quints ? Math.floor((7 * count + 2) / 3) : 0) };
});

/** The bits of each end point value the decoder reads, for `count` values in `available` bits: null unless whole bits. */
const valueBits = (count: number, available: number): number | null => {
    let chosen: number | null = null;
    for (const range of COLOUR_RANGES) if (range.bits(count) <= available) chosen = range.levels;
    return chosen !== null && (chosen & (chosen - 1)) === 0 ? Math.log2(chosen) : null;
};

/** End points (RGBA, 8 bits) a colour endpoint mode makes of its values. */
const endpoints = (mode: number, v: number[]): [number[], number[]] => {
    if (mode === RGB_SCALE_MODE) return [[(v[0] * v[3]) >> 8, (v[1] * v[3]) >> 8, (v[2] * v[3]) >> 8, 255], [v[0], v[1], v[2], 255]];
    const a0 = mode === RGBA_MODE ? v[6] : 255, a1 = mode === RGBA_MODE ? v[7] : 255;
    if (v[1] + v[3] + v[5] >= v[0] + v[2] + v[4]) return [[v[0], v[2], v[4], a0], [v[1], v[3], v[5], a1]];
    // Blue contraction (never written here, read for completeness).
    const contract = (r: number, g: number, b: number, alpha: number) => [(r + b) >> 1, (g + b) >> 1, b, alpha];
    return [contract(v[1], v[3], v[5], a1), contract(v[0], v[2], v[4], a0)];
};

const VALUES: Record<number, number> = { [RGB_MODE]: 6, [RGBA_MODE]: 8, [RGB_SCALE_MODE]: 4 };

/** One ASTC 4×4 block back to 16 RGBA pixels, for the layouts this encoder writes; magenta for any other. */
export const decodeAstcBlock = (bytes: Uint8Array, out: Uint8Array): void => {
    const error = () => { for (let i = 0; i < 16; i++) out.set([255, 0, 255, 255], i * 4); };
    const mode = readBlockMode(getBits(bytes, 0, 11));
    const partitions = getBits(bytes, 11, 2) + 1;
    // Only plain power-of-two weight ranges, a 4×4 grid, one plane and one or two partitions are read here.
    if (!mode || mode.dualPlane || partitions > 2 || mode.width !== 4 || mode.height !== 4 || (mode.levels !== 8 && mode.levels !== 4)) return error();
    let colourMode: number;
    let seed = 0;
    let at: number;
    if (partitions === 1) {
        colourMode = getBits(bytes, 13, 4);
        at = 17;
    } else {
        seed = getBits(bytes, 13, 10);
        const field = getBits(bytes, 23, 6);
        // Partitions of differing modes are not written here.
        if ((field & 3) !== 0) return error();
        colourMode = field >> 2;
        at = 29;
    }
    const count = VALUES[colourMode];
    if (!count || (partitions === 1 && colourMode === RGB_SCALE_MODE)) return error();
    const bits = Math.log2(mode.levels);
    const each = valueBits(count * partitions, 128 - at - 16 * bits);
    if (each === null) return error();
    const ends = Array.from({ length: partitions }, (_, part) => endpoints(colourMode, Array.from({ length: count }, (_, k) => replicate(getBits(bytes, at + (part * count + k) * each, each), each))));
    const levels = bits === 3 ? WEIGHTS_3 : WEIGHTS_2;
    for (let i = 0; i < 16; i++) {
        let q = 0;
        for (let b = 0; b < bits; b++) {
            const bit = 127 - (i * bits + b);
            q |= ((bytes[bit >> 3] >> (bit & 7)) & 1) << b;
        }
        const w = levels[q];
        const [e0, e1] = ends[partitions === 1 ? 0 : partitionOf(seed, i & 3, i >> 2, 0, 2)];
        for (let c = 0; c < 4; c++) out[i * 4 + c] = interpolate(e0[c], e1[c], w);
    }
};
