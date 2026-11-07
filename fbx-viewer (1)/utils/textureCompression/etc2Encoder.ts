/**
 * ETC2 (RGB8, and RGBA8 with EAC alpha), for phones and other graphics cards without BC or ASTC.
 *
 * Colour blocks are written in ETC2's first two modes (which are ETC1's): two halves of the block, side by
 * side or one above the other, each a base colour moved lighter or darker by one of eight modifier tables.
 * The bases are kept either individually (4 bits a channel) or as one and a difference (5 bits and 3), and a
 * difference is only written where it stays in range, so a decoder never reads one of ETC2's other modes.
 * Alpha, where the texture has it, is an EAC block before each colour block: a base, a table of eight steps
 * and a multiplier. Blocks are big-endian; pixels are counted down each column.
 */

export const ETC2_BLOCK_BYTES = 8;
export const ETC2A_BLOCK_BYTES = 16;

const MODIFIERS = [
    [2, 8], [5, 17], [9, 29], [13, 42], [18, 60], [24, 80], [33, 106], [47, 183],
] as const;

/** A pixel's modifier from its 2-bit index: +a, +b, -a, -b. */
const modifier = (table: number, index: number): number => {
    const [a, b] = MODIFIERS[table];
    return [a, b, -a, -b][index];
};

const ALPHA_TABLES = [
    [-3, -6, -9, -15, 2, 5, 8, 14], [-3, -7, -10, -13, 2, 6, 9, 12], [-2, -5, -8, -13, 1, 4, 7, 12], [-2, -4, -6, -13, 1, 3, 5, 12],
    [-3, -6, -8, -12, 2, 5, 7, 11], [-3, -7, -9, -11, 2, 6, 8, 10], [-4, -7, -8, -11, 3, 6, 7, 10], [-3, -5, -8, -11, 2, 4, 7, 10],
    [-2, -6, -8, -10, 1, 5, 7, 9], [-2, -5, -8, -10, 1, 4, 7, 9], [-2, -4, -8, -10, 1, 3, 7, 9], [-2, -5, -7, -10, 1, 4, 6, 9],
    [-3, -4, -7, -10, 2, 3, 6, 9], [-1, -2, -3, -10, 0, 1, 2, 9], [-4, -6, -8, -9, 3, 5, 7, 8], [-3, -5, -7, -9, 2, 4, 6, 8],
] as const;

const clamp = (value: number): number => (value < 0 ? 0 : value > 255 ? 255 : value);
const expand4 = (value: number): number => (value << 4) | value;
const expand5 = (value: number): number => (value << 3) | (value >> 2);

/** Pixel `i` of a block read row by row, in ETC's order down each column. */
const columnOrder = (i: number): number => (i % 4) * 4 + Math.floor(i / 4);

/** The pixels of each half: side by side (flip 0) or one above the other (flip 1), as row-by-row indices. */
const halves = (flip: number): [number[], number[]] => {
    const first: number[] = [], second: number[] = [];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) ((flip ? y < 2 : x < 2) ? first : second).push(y * 4 + x);
    return [first, second];
};
const HALVES = [halves(0), halves(1)];

interface HalfFit { table: number; indices: number[]; error: number }

/** The best table and per-pixel modifiers for a half around its base colour. */
const fitHalf = (block: Uint8Array, pixels: readonly number[], base: readonly number[]): HalfFit => {
    let best: HalfFit = { table: 0, indices: [], error: Infinity };
    for (let table = 0; table < 8; table++) {
        const indices: number[] = [];
        let error = 0;
        for (const p of pixels) {
            let bestIndex = 0;
            let bestError = Infinity;
            for (let index = 0; index < 4; index++) {
                const m = modifier(table, index);
                let sum = 0;
                for (let c = 0; c < 3; c++) {
                    const d = clamp(base[c] + m) - block[p * 4 + c];
                    sum += d * d;
                }
                if (sum < bestError) { bestError = sum; bestIndex = index; }
            }
            indices.push(bestIndex);
            error += bestError;
            if (error >= best.error) break;
        }
        if (error < best.error) best = { table, indices, error };
    }
    return best;
};

const average = (block: Uint8Array, pixels: readonly number[]): number[] => [0, 1, 2].map(c => pixels.reduce((sum, p) => sum + block[p * 4 + c], 0) / pixels.length);

interface BlockFit { flip: number; differential: boolean; bases: [number[], number[]]; fits: [HalfFit, HalfFit]; error: number }

/** One block of 16 RGBA pixels (row by row) as an ETC2 RGB block; alpha is not kept. */
export const encodeEtc2Block = (block: Uint8Array): Uint8Array => {
    let best: BlockFit | null = null;
    for (let flip = 0; flip < 2; flip++) {
        const [first, second] = HALVES[flip];
        const means = [average(block, first), average(block, second)];
        const tries: Array<{ differential: boolean; codes: [number[], number[]] }> = [];
        // Individually, 4 bits a channel.
        tries.push({ differential: false, codes: [means[0].map(v => Math.round(v * 15 / 255)), means[1].map(v => Math.round(v * 15 / 255))] });
        // As one and a difference, 5 bits and 3, only where the difference fits.
        const five = means.map(mean => mean.map(v => Math.round(v * 31 / 255)));
        if (five[1].every((value, c) => value - five[0][c] >= -4 && value - five[0][c] <= 3)) tries.push({ differential: true, codes: [five[0], five[1]] });
        for (const attempt of tries) {
            const bases = attempt.codes.map(code => code.map(attempt.differential ? expand5 : expand4)) as [number[], number[]];
            const fits: [HalfFit, HalfFit] = [fitHalf(block, first, bases[0]), fitHalf(block, second, bases[1])];
            const error = fits[0].error + fits[1].error;
            if (!best || error < best.error) best = { flip, differential: attempt.differential, bases: attempt.codes as [number[], number[]], fits, error };
        }
    }
    const fit = best!;
    let high = 0;
    let low = 0;
    const [r1, g1, b1] = fit.bases[0];
    const [r2, g2, b2] = fit.bases[1];
    if (fit.differential) {
        const d = (value: number) => value & 7;
        high = ((r1 << 27) | (d(r2 - r1) << 24) | (g1 << 19) | (d(g2 - g1) << 16) | (b1 << 11) | (d(b2 - b1) << 8)) >>> 0;
    } else {
        high = ((r1 << 28) | (r2 << 24) | (g1 << 20) | (g2 << 16) | (b1 << 12) | (b2 << 8)) >>> 0;
    }
    high = (high | (fit.fits[0].table << 5) | (fit.fits[1].table << 2) | ((fit.differential ? 1 : 0) << 1) | fit.flip) >>> 0;
    const [first, second] = HALVES[fit.flip];
    const place = (pixels: readonly number[], indices: readonly number[]) => pixels.forEach((p, k) => {
        const at = columnOrder(p);
        const index = indices[k];
        low = (low | ((index & 1) << at) | (((index >> 1) & 1) << (16 + at))) >>> 0;
    });
    place(first, fit.fits[0].indices);
    place(second, fit.fits[1].indices);
    const out = new Uint8Array(ETC2_BLOCK_BYTES);
    const view = new DataView(out.buffer);
    view.setUint32(0, high);
    view.setUint32(4, low);
    return out;
};

/** One ETC2 RGB block (of the first two modes) back to 16 opaque RGBA pixels, row by row. */
export const decodeEtc2Block = (bytes: Uint8Array, out: Uint8Array): void => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
    const high = view.getUint32(0);
    const low = view.getUint32(4);
    const differential = (high >> 1) & 1;
    const flip = high & 1;
    const tables = [(high >> 5) & 7, (high >> 2) & 7];
    let bases: number[][];
    if (differential) {
        const signed = (value: number) => (value & 4 ? value - 8 : value);
        const one = [(high >>> 27) & 31, (high >>> 19) & 31, (high >>> 11) & 31];
        const two = [one[0] + signed((high >>> 24) & 7), one[1] + signed((high >>> 16) & 7), one[2] + signed((high >>> 8) & 7)];
        bases = [one.map(expand5), two.map(expand5)];
    } else {
        bases = [[(high >>> 28) & 15, (high >>> 20) & 15, (high >>> 12) & 15].map(expand4), [(high >>> 24) & 15, (high >>> 16) & 15, (high >>> 8) & 15].map(expand4)];
    }
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        const half = (flip ? y < 2 : x < 2) ? 0 : 1;
        const at = x * 4 + y;
        const index = ((low >>> at) & 1) | (((low >>> (16 + at)) & 1) << 1);
        const m = modifier(tables[half], index);
        const i = (y * 4 + x) * 4;
        for (let c = 0; c < 3; c++) out[i + c] = clamp(bases[half][c] + m);
        out[i + 3] = 255;
    }
};

/** The alpha of 16 pixels (row by row) as an EAC block. */
export const encodeEacAlphaBlock = (block: Uint8Array): Uint8Array => {
    const alphas = Array.from({ length: 16 }, (_, i) => block[i * 4 + 3]);
    const low = Math.min(...alphas), high = Math.max(...alphas);
    let best = { base: low, multiplier: 1, table: 13, indices: new Array(16).fill(4), error: Infinity };
    if (low === high) {
        // One alpha: table 13 has a step of 0.
        best = { base: low, multiplier: 1, table: 13, indices: new Array(16).fill(4), error: 0 };
    } else {
        for (let table = 0; table < 16; table++) {
            const steps = ALPHA_TABLES[table];
            const spread = steps[7] - steps[3];
            const ideal = (high - low) / spread;
            for (let multiplier = Math.max(1, Math.floor(ideal) - 1); multiplier <= Math.min(15, Math.ceil(ideal) + 1); multiplier++) {
                const centre = Math.round((low + high) / 2 - ((steps[7] + steps[3]) / 2) * multiplier);
                for (let base = Math.max(0, centre - 1); base <= Math.min(255, centre + 1); base++) {
                    const indices: number[] = [];
                    let error = 0;
                    for (const alpha of alphas) {
                        let bestIndex = 0, bestError = Infinity;
                        for (let index = 0; index < 8; index++) {
                            const d = clamp(base + steps[index] * multiplier) - alpha;
                            if (d * d < bestError) { bestError = d * d; bestIndex = index; }
                        }
                        indices.push(bestIndex);
                        error += bestError;
                    }
                    if (error < best.error) best = { base, multiplier, table, indices, error };
                }
            }
        }
    }
    const out = new Uint8Array(8);
    out[0] = best.base;
    out[1] = (best.multiplier << 4) | best.table;
    let bits = 0n;
    for (let i = 0; i < 16; i++) {
        // Indices from the top, in ETC's order down each column.
        const at = columnOrder(i);
        bits |= BigInt(best.indices[i]) << BigInt(45 - at * 3);
    }
    for (let i = 0; i < 6; i++) out[2 + i] = Number((bits >> BigInt((5 - i) * 8)) & 0xffn);
    return out;
};

/** An EAC alpha block back into the alpha of 16 pixels, row by row. */
export const decodeEacAlphaBlock = (bytes: Uint8Array, out: Uint8Array): void => {
    const base = bytes[0];
    const multiplier = bytes[1] >> 4;
    const steps = ALPHA_TABLES[bytes[1] & 15];
    let bits = 0n;
    for (let i = 0; i < 6; i++) bits = (bits << 8n) | BigInt(bytes[2 + i]);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        const at = x * 4 + y;
        const index = Number((bits >> BigInt(45 - at * 3)) & 7n);
        out[(y * 4 + x) * 4 + 3] = clamp(base + steps[index] * multiplier);
    }
};

/** One block of 16 RGBA pixels as ETC2 RGBA8: EAC alpha, then the colour. */
export const encodeEtc2AlphaBlock = (block: Uint8Array): Uint8Array => {
    const out = new Uint8Array(ETC2A_BLOCK_BYTES);
    out.set(encodeEacAlphaBlock(block), 0);
    out.set(encodeEtc2Block(block), 8);
    return out;
};

export const decodeEtc2AlphaBlock = (bytes: Uint8Array, out: Uint8Array): void => {
    decodeEtc2Block(bytes.subarray(8, 16), out);
    decodeEacAlphaBlock(bytes.subarray(0, 8), out);
};
