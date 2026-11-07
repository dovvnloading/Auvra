/**
 * ASTC 4×4 (LDR), for phones and other graphics cards without BC.
 *
 * Every block is written in one of two simple, always-valid layouts: one partition, one plane, a 4×4 weight
 * grid, and end points kept at full 8 bits (quantised to 256 levels, so no trits or quints are needed):
 * - opaque blocks: colour end points only (mode 8, "LDR RGB direct"), with eight steps between them;
 * - blocks with varying alpha: colour and alpha end points (mode 12, "LDR RGBA direct"), with four steps.
 * End points come from the block's main axis of colour, refined by least squares, and are ordered so the
 * decoder never applies blue contraction. The decoder here reads any block of these modes from its fields
 * (block mode, partitions, colour endpoint mode, weights from the top), for the compression preview and tests.
 */

/** Bytes in a block. */
export const ASTC_BLOCK_BYTES = 16;

const RGB_MODE = 8;
const RGBA_MODE = 12;

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

/** The colour the decoder gives between end points at weight `w` (0..64), in 8 bits. */
const interpolate = (e0: number, e1: number, w: number): number => {
    const c0 = (e0 << 8) | e0;
    const c1 = (e1 << 8) | e1;
    return Math.floor((c0 * (64 - w) + c1 * w + 32) / 64) >> 8;
};

const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

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

/** End points from the pixels' main axis (power iteration on their spread). */
const axisEndpoints = (pixels: number[][], channels: number): { e0: number[]; e1: number[] } => {
    const mean = new Array(channels).fill(0);
    for (const pixel of pixels) for (let c = 0; c < channels; c++) mean[c] += pixel[c] / pixels.length;
    const cov = Array.from({ length: channels }, () => new Array(channels).fill(0));
    for (const pixel of pixels) for (let i = 0; i < channels; i++) for (let j = 0; j < channels; j++) cov[i][j] += (pixel[i] - mean[i]) * (pixel[j] - mean[j]);
    let axis = new Array(channels).fill(1);
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

const fitBlock = (pixels: number[][], channels: number, levels: readonly number[]): Fit => {
    const start = axisEndpoints(pixels, channels);
    let best = assign(pixels, start.e0, start.e1, levels, channels);
    for (let round = 0; round < 2 && best.error > 0; round++) {
        const better = refine(pixels, best.weights, levels, channels);
        if (!better) break;
        const tried = assign(pixels, better.e0, better.e1, levels, channels);
        if (tried.error >= best.error) break;
        best = tried;
    }
    return best;
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
    const fit = fitBlock(pixels, channels, levels);
    let { e0, e1, weights } = fit;
    // Blue contraction applies when the second end point's colour sums lower: swapped, the weights turn round.
    if (e1[0] + e1[1] + e1[2] < e0[0] + e0[1] + e0[2]) {
        [e0, e1] = [e1, e0];
        weights = weights.map(weight => levels.length - 1 - weight);
    }
    setBits(out, 0, 11, blockMode(alphaVaries ? 4 : 8));
    setBits(out, 11, 2, 0);
    setBits(out, 13, 4, alphaVaries ? RGBA_MODE : RGB_MODE);
    // End points v0..: (r0, r1, g0, g1, b0, b1[, a0, a1]), 8 bits each from bit 17.
    for (let c = 0; c < channels; c++) {
        setBits(out, 17 + c * 16, 8, e0[c]);
        setBits(out, 17 + c * 16 + 8, 8, e1[c]);
    }
    // Weights fill the block from the top, their bits reversed.
    const bits = alphaVaries ? 2 : 3;
    weights.forEach((weight, i) => {
        for (let b = 0; b < bits; b++) if ((weight >> b) & 1) {
            const at = 127 - (i * bits + b);
            out[at >> 3] |= 1 << (at & 7);
        }
    });
    return out;
};

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

/** One ASTC 4×4 block back to 16 RGBA pixels, for the blocks this encoder writes; magenta for any other. */
export const decodeAstcBlock = (bytes: Uint8Array, out: Uint8Array): void => {
    const error = () => { for (let i = 0; i < 16; i++) out.set([255, 0, 255, 255], i * 4); };
    const mode = readBlockMode(getBits(bytes, 0, 11));
    const partitions = getBits(bytes, 11, 2) + 1;
    const colourMode = getBits(bytes, 13, 4);
    // Only plain power-of-two weight ranges, a 4×4 grid, one plane and one partition are read here.
    if (!mode || mode.dualPlane || partitions !== 1 || mode.width !== 4 || mode.height !== 4 || (mode.levels !== 8 && mode.levels !== 4)) return error();
    if (colourMode !== RGB_MODE && colourMode !== RGBA_MODE) return error();
    const bits = Math.log2(mode.levels);
    const values = colourMode === RGB_MODE ? 6 : 8;
    const weightBits = 16 * bits;
    // The end points must take 8 bits each: what is left over must hold them (the highest level that fits).
    if (128 - 17 - weightBits < values * 8) return error();
    const v = Array.from({ length: values }, (_, i) => getBits(bytes, 17 + i * 8, 8));
    let e0: number[], e1: number[];
    const s0 = v[0] + v[2] + v[4], s1 = v[1] + v[3] + v[5];
    const a0 = colourMode === RGBA_MODE ? v[6] : 255, a1 = colourMode === RGBA_MODE ? v[7] : 255;
    if (s1 >= s0) {
        e0 = [v[0], v[2], v[4], a0];
        e1 = [v[1], v[3], v[5], a1];
    } else {
        // Blue contraction (never written here, read for completeness).
        const contract = (r: number, g: number, b: number, alpha: number) => [(r + b) >> 1, (g + b) >> 1, b, alpha];
        e0 = contract(v[1], v[3], v[5], a1);
        e1 = contract(v[0], v[2], v[4], a0);
    }
    const levels = bits === 3 ? WEIGHTS_3 : WEIGHTS_2;
    for (let i = 0; i < 16; i++) {
        let q = 0;
        for (let b = 0; b < bits; b++) {
            const at = 127 - (i * bits + b);
            q |= ((bytes[at >> 3] >> (at & 7)) & 1) << b;
        }
        const w = levels[q];
        for (let c = 0; c < 4; c++) out[i * 4 + c] = interpolate(e0[c], e1[c], w);
    }
};
