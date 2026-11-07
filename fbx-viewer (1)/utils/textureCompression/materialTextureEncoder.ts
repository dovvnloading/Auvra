import { decodeBlocks, encodeBlocks } from './bcEncoder';
import { ASTC_BLOCK_BYTES, decodeAstcBlock, encodeAstcBlock, spreadStart } from './astcEncoder';
import { ETC2A_BLOCK_BYTES, ETC2_BLOCK_BYTES, decodeEtc2AlphaBlock, decodeEtc2Block, encodeEtc2AlphaBlock, encodeEtc2Block } from './etc2Encoder';

/**
 * MATERIAL TEXTURE COMPRESSION
 *
 * Material assets' textures compressed for the GPU, by what they hold:
 * - colour (and colour with alpha): BC7, one byte a pixel: its mode 6 (one subset, colour and alpha end points with
 *   a shared low bit, sixteen steps between), or for opaque blocks of two colours one line cannot hold, modes 1 and 3
 *   (the block split in two one of 64 ways, each half with end points of its own: eight steps, or four from finer
 *   end points), whichever comes back closest;
 * - normal maps: BC5, red and green only, a byte a pixel (the shader rebuilds blue);
 * - one channel of data (roughness, metalness, occlusion, height, masks): BC4, half a byte a pixel.
 *   three r164 cannot upload unsigned BC4 (its format table checks the wrong constant), so it is written
 *   as signed BC4 using only the non-negative half: values read back 0..1 as they should, with end points
 *   at 7 bits rather than 8.
 * Graphics cards without BC (phones, tablets) take ASTC 4×4 (astcEncoder.ts), else ETC2 (etc2Encoder.ts),
 * with EAC alpha where the texture has alpha: a byte a pixel, or half a byte for opaque ETC2.
 * Mip levels are made with a Kaiser-windowed filter rather than a box (sharper, with no ringing to speak
 * of): colour in linear light, normals as directions, made unit length again at each level.
 */

/** The BC formats, for desktop graphics cards (and what a texture's settings can pick). */
export type BcFormat = 'bc7' | 'bc5' | 'bc4';
/** Every compressed format a material texture is kept in: BC, and ASTC or ETC2 (opaque, or with alpha) for phones. */
export type MaterialTextureFormat = BcFormat | 'astc' | 'etc2' | 'etc2a';
export type MaterialTextureKind = 'colour' | 'data' | 'normal';

export interface EncodedLevel { data: Uint8Array; width: number; height: number }

/** Bytes a pixel each way of keeping a texture. */
export const BYTES_PER_PIXEL: Record<MaterialTextureFormat | 'rgba8' | 'half', number> = { bc7: 1, bc5: 1, bc4: 0.5, astc: 1, etc2: 0.5, etc2a: 1, rgba8: 4, half: 8 };

/** Bytes a texture takes on the GPU, with its mip levels when it has them. */
export const textureMemoryBytes = (width: number, height: number, format: MaterialTextureFormat | 'rgba8' | 'half', mips = true): number => {
    // Blocks of 4×4 for the compressed formats.
    const blocky = format !== 'rgba8' && format !== 'half';
    let total = 0;
    let w = width;
    let h = height;
    for (;;) {
        const pixels = blocky ? Math.ceil(w / 4) * 4 * Math.ceil(h / 4) * 4 : w * h;
        total += pixels * BYTES_PER_PIXEL[format];
        if (!mips || (w === 1 && h === 1)) break;
        w = Math.max(1, w >> 1);
        h = Math.max(1, h >> 1);
    }
    return Math.round(total);
};

// --- Mip levels ----------------------------------------------------------------------------------

const besselI0 = (x: number): number => {
    let sum = 1;
    let term = 1;
    for (let k = 1; k < 25; k++) {
        term *= (x / (2 * k)) * (x / (2 * k));
        sum += term;
    }
    return sum;
};

/** Weights of a 2:1 Kaiser-windowed sinc, for the six source pixels round each new one. */
const KAISER_TAPS = (() => {
    const beta = 4;
    const radius = 3;
    const taps = [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5].map((x) => {
        const t = x / 2;
        const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
        const window = besselI0(beta * Math.sqrt(Math.max(0, 1 - (x / radius) ** 2))) / besselI0(beta);
        return sinc * window;
    });
    const sum = taps.reduce((a, b) => a + b, 0);
    return taps.map(tap => tap / sum);
})();

const toLinear = (value: number): number => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
const toSrgb = (value: number): number => (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055);

/** One level's floats (four a pixel) halved with the Kaiser filter, wrapping round its edges as tiling textures do. */
const halveKaiser = (source: Float32Array, width: number, height: number): { data: Float32Array; width: number; height: number } => {
    const outW = Math.max(1, width >> 1);
    const outH = Math.max(1, height >> 1);
    const across = new Float32Array(outW * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < outW; x++) {
            for (let c = 0; c < 4; c++) {
                let sum = 0;
                for (let t = 0; t < 6; t++) {
                    const sx = ((x * 2 + t - 2) % width + width) % width;
                    sum += source[(y * width + sx) * 4 + c] * KAISER_TAPS[t];
                }
                across[(y * outW + x) * 4 + c] = sum;
            }
        }
    }
    const out = new Float32Array(outW * outH * 4);
    for (let y = 0; y < outH; y++) {
        for (let x = 0; x < outW; x++) {
            for (let c = 0; c < 4; c++) {
                let sum = 0;
                for (let t = 0; t < 6; t++) {
                    const sy = ((y * 2 + t - 2) % height + height) % height;
                    sum += across[(sy * outW + x) * 4 + c] * KAISER_TAPS[t];
                }
                out[(y * outW + x) * 4 + c] = sum;
            }
        }
    }
    return { data: out, width: outW, height: outH };
};

/** The level as floats to filter: colour in linear light, normals as directions -1..1, data as it is. */
const toFloats = (rgba: Uint8Array, kind: MaterialTextureKind): Float32Array => {
    const out = new Float32Array(rgba.length);
    for (let i = 0; i < rgba.length; i++) {
        const value = rgba[i] / 255;
        out[i] = kind === 'colour' && i % 4 !== 3 ? toLinear(value) : kind === 'normal' && i % 4 !== 3 ? value * 2 - 1 : value;
    }
    return out;
};

const toBytes = (floats: Float32Array, kind: MaterialTextureKind): Uint8Array => {
    const out = new Uint8Array(floats.length);
    for (let p = 0; p < floats.length; p += 4) {
        if (kind === 'normal') {
            // Directions averaged come out short: made unit length again.
            const x = floats[p], y = floats[p + 1], z = floats[p + 2];
            const length = Math.hypot(x, y, z) || 1;
            out[p] = Math.round(Math.min(1, Math.max(0, (x / length) * 0.5 + 0.5)) * 255);
            out[p + 1] = Math.round(Math.min(1, Math.max(0, (y / length) * 0.5 + 0.5)) * 255);
            out[p + 2] = Math.round(Math.min(1, Math.max(0, (z / length) * 0.5 + 0.5)) * 255);
        } else {
            for (let c = 0; c < 3; c++) {
                const value = kind === 'colour' ? toSrgb(Math.max(0, floats[p + c])) : floats[p + c];
                out[p + c] = Math.round(Math.min(1, Math.max(0, value)) * 255);
            }
        }
        out[p + 3] = Math.round(Math.min(1, Math.max(0, floats[p + 3])) * 255);
    }
    return out;
};

/** The picture's mip levels (itself first, down to one pixel), each 8-bit RGBA. */
export const kaiserMipLevels = (rgba: Uint8Array, width: number, height: number, kind: MaterialTextureKind): EncodedLevel[] => {
    const levels: EncodedLevel[] = [{ data: rgba, width, height }];
    let floats = toFloats(rgba, kind);
    let w = width;
    let h = height;
    while (w > 1 || h > 1) {
        const next = halveKaiser(floats, w, h);
        floats = next.data;
        w = next.width;
        h = next.height;
        levels.push({ data: toBytes(floats, kind), width: w, height: h });
        // Each level is filtered from the last one's floats, not its rounded bytes.
        if (kind === 'normal') floats = toFloats(levels[levels.length - 1].data, kind);
    }
    return levels;
};

// --- BC7: mode 6, and modes 1 and 3 for opaque blocks of two colours -----------------------------

const BC7_WEIGHTS = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];
const BC7_WEIGHTS_3 = [0, 9, 18, 27, 37, 46, 55, 64];
const BC7_WEIGHTS_2 = [0, 21, 43, 64];

/**
 * BC7's 64 ways of splitting a block in two, as the format defines them: one bit a pixel (pixel 0 lowest, row by row),
 * set where the pixel is in the second subset.
 */
const BC7_PARTITIONS = [
    0xcccc, 0x8888, 0xeeee, 0xecc8, 0xc880, 0xfeec, 0xfec8, 0xec80, 0xc800, 0xffec, 0xfe80, 0xe800, 0xffe8, 0xff00, 0xfff0, 0xf000,
    0xf710, 0x008e, 0x7100, 0x08ce, 0x008c, 0x7310, 0x3100, 0x8cce, 0x088c, 0x3110, 0x6666, 0x366c, 0x17e8, 0x0ff0, 0x718e, 0x399c,
    0xaaaa, 0xf0f0, 0x5a5a, 0x33cc, 0x3c3c, 0x55aa, 0x9696, 0xa55a, 0x73ce, 0x13c8, 0x324c, 0x3bdc, 0x6996, 0xc33c, 0x9966, 0x0660,
    0x0272, 0x04e4, 0x4e40, 0x2720, 0xc936, 0x936c, 0x39c6, 0x639c, 0x9336, 0x9cc6, 0x817e, 0xe718, 0xccf0, 0x0fcc, 0x7744, 0xee22,
];

/** For each split, the pixel of the second subset whose index drops its top bit (the first subset's is pixel 0). */
const BC7_ANCHORS = [
    15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15,
    15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2,
    15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6,
    6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15,
];

/** Splits tried in full for a block (the ones whose halves each lie nearest a line of colour). */
const BC7_SPLITS_TRIED = 2;
/** A block mode 6 keeps this close (summed squared error over its pixels and channels) is not split. */
const BC7_CLOSE_ENOUGH = 96;

/** The 4×4 block at (bx, by), clamped at the picture's edges: sixteen RGBA pixels. */
const readBlock = (rgba: Uint8Array, width: number, height: number, bx: number, by: number, block: Uint8Array): void => {
    for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
            const sx = Math.min(width - 1, bx * 4 + x);
            const sy = Math.min(height - 1, by * 4 + y);
            block.set(rgba.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (y * 4 + x) * 4);
        }
    }
};


/**
 * A 7-bit end point and its low bit, the pair nearest a colour and alpha. In an opaque block the alpha comes first, so
 * the block stays exactly opaque.
 */
const quantizeEndpoint = (colour: number[], opaque: boolean): { q: number[]; p: number } => {
    let best = { q: [0, 0, 0, 0], p: 0 };
    let bestError = Infinity;
    for (let p = 0; p < 2; p++) {
        const q = colour.map(value => Math.min(127, Math.max(0, Math.round((value - p) / 2))));
        const error = q.reduce((sum, value, c) => sum + ((value << 1 | p) - colour[c]) ** 2 * (opaque && c === 3 ? 64 : 1), 0);
        if (error < bestError) { bestError = error; best = { q, p }; }
    }
    return best;
};

class BitWriter {
    readonly bytes = new Uint8Array(16);
    private at = 0;
    write(value: number, bits: number): void {
        for (let i = 0; i < bits; i++, this.at++) if ((value >> i) & 1) this.bytes[this.at >> 3] |= 1 << (this.at & 7);
    }
}

/** Mode 6: one subset, colour and alpha end points of 7 bits with a low bit each, sixteen steps between. */
const encodeBc7Mode6 = (block: Uint8Array, opaque: boolean): Uint8Array => {
    // The main axis through the block's colours and alphas; its two ends become the end points.
    const mean = [0, 0, 0, 0];
    for (let i = 0; i < 16; i++) for (let c = 0; c < 4; c++) mean[c] += block[i * 4 + c] / 16;
    let axis = spreadStart(Array.from({ length: 16 }, (_, i) => Array.from(block.subarray(i * 4, i * 4 + 4))), mean);
    for (let iteration = 0; iteration < 6; iteration++) {
        const next = [0, 0, 0, 0];
        for (let i = 0; i < 16; i++) {
            const d = [0, 1, 2, 3].map(c => block[i * 4 + c] - mean[c]);
            const dot = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2] + d[3] * axis[3];
            for (let c = 0; c < 4; c++) next[c] += d[c] * dot;
        }
        const length = Math.hypot(...next);
        if (length < 1e-6) break;
        axis = next.map(value => value / length);
    }
    let low = Infinity, high = -Infinity;
    for (let i = 0; i < 16; i++) {
        const t = [0, 1, 2, 3].reduce((sum, c) => sum + (block[i * 4 + c] - mean[c]) * axis[c], 0);
        low = Math.min(low, t);
        high = Math.max(high, t);
    }
    const end = (t: number) => mean.map((value, c) => Math.min(255, Math.max(0, value + axis[c] * t)));
    let first = quantizeEndpoint(end(low), opaque);
    let second = quantizeEndpoint(end(high), opaque);
    const palette = () => {
        const a = first.q.map(value => value << 1 | first.p);
        const b = second.q.map(value => value << 1 | second.p);
        return BC7_WEIGHTS.map(weight => a.map((value, c) => ((64 - weight) * value + weight * b[c] + 32) >> 6));
    };
    const colours = palette();
    let indices = Array.from({ length: 16 }, (_, i) => {
        let best = 0, bestError = Infinity;
        for (let k = 0; k < 16; k++) {
            let error = 0;
            for (let c = 0; c < 4; c++) error += (colours[k][c] - block[i * 4 + c]) ** 2;
            if (error < bestError) { bestError = error; best = k; }
        }
        return best;
    });
    // The first pixel's index has no top bit: when it would need one, the end points swap.
    if (indices[0] >= 8) {
        [first, second] = [second, first];
        indices = indices.map(index => 15 - index);
    }
    const out = new BitWriter();
    out.write(1 << 6, 7);
    for (let c = 0; c < 4; c++) { out.write(first.q[c], 7); out.write(second.q[c], 7); }
    out.write(first.p, 1);
    out.write(second.p, 1);
    out.write(indices[0], 3);
    for (let i = 1; i < 16; i++) out.write(indices[i], 4);
    return out.bytes;
};

/** A pixel's sums for a line fit: count, red, green, blue, and their products (rr, rg, rb, gg, gb, bb). */
const SUMS = 10;
const pixelSums = new Float64Array(16 * SUMS);
const blockSums = new Float64Array(SUMS);
const halfSums = new Float64Array(SUMS);

/** What is left of a group of pixels' spread off its main axis (its sums given): how far it lies from a line of colour. */
const offLine = (s: Float64Array): number => {
    const n = s[0];
    if (n < 2) return 0;
    const xx = s[4] - s[1] * s[1] / n, xy = s[5] - s[1] * s[2] / n, xz = s[6] - s[1] * s[3] / n;
    const yy = s[7] - s[2] * s[2] / n, yz = s[8] - s[2] * s[3] / n, zz = s[9] - s[3] * s[3] / n;
    // The largest spread along one axis, by power iteration from the widest channel.
    let x = xx >= yy && xx >= zz ? 1 : 0.1, y = yy > xx && yy >= zz ? 1 : 0.1, z = zz > xx && zz > yy ? 1 : 0.1;
    let along = 0;
    for (let step = 0; step < 5; step++) {
        const nx = xx * x + xy * y + xz * z, ny = xy * x + yy * y + yz * z, nz = xz * x + yz * y + zz * z;
        const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (length < 1e-9) break;
        along = length / Math.sqrt(x * x + y * y + z * z);
        x = nx / length; y = ny / length; z = nz / length;
    }
    return Math.max(0, xx + yy + zz - along);
};

/**
 * BC7's splits of a block, best first, as many as are tried: those whose two halves each lie nearest a line of colour.
 * The second half's sums are summed from its pixels; the first's are what is left of the block's.
 */
const bestSplits = (block: Uint8Array): number[] => {
    blockSums.fill(0);
    for (let i = 0; i < 16; i++) {
        const r = block[i * 4], g = block[i * 4 + 1], b = block[i * 4 + 2];
        const at = i * SUMS;
        pixelSums[at] = 1; pixelSums[at + 1] = r; pixelSums[at + 2] = g; pixelSums[at + 3] = b;
        pixelSums[at + 4] = r * r; pixelSums[at + 5] = r * g; pixelSums[at + 6] = r * b;
        pixelSums[at + 7] = g * g; pixelSums[at + 8] = g * b; pixelSums[at + 9] = b * b;
        for (let k = 0; k < SUMS; k++) blockSums[k] += pixelSums[at + k];
    }
    const kept: Array<{ split: number; cost: number }> = [];
    for (let split = 0; split < BC7_PARTITIONS.length; split++) {
        const mask = BC7_PARTITIONS[split];
        halfSums.fill(0);
        for (let i = 0; i < 16; i++) if ((mask >> i) & 1) for (let k = 0; k < SUMS; k++) halfSums[k] += pixelSums[i * SUMS + k];
        let cost = offLine(halfSums);
        for (let k = 0; k < SUMS; k++) halfSums[k] = blockSums[k] - halfSums[k];
        cost += offLine(halfSums);
        if (kept.length < BC7_SPLITS_TRIED || cost < kept[kept.length - 1].cost) {
            kept.push({ split, cost });
            kept.sort((a, b) => a.cost - b.cost);
            if (kept.length > BC7_SPLITS_TRIED) kept.pop();
        }
    }
    return kept.map(entry => entry.split);
};

interface SubsetFit {
    /** End points as the block stores them, and their low bits (shared in mode 1). */
    raw: [number[], number[]];
    p: [number, number];
    /** End points as the decoder makes them. */
    colour: [number[], number[]];
    /** Each pixel's index (only the subset's pixels are set). */
    indices: number[];
    error: number;
}

/** Mode 1's end points: 6 bits and a low bit shared by the subset's two, widened to 8 by repeating the top bit. */
const quantizeMode1 = (a: number[], b: number[]): Pick<SubsetFit, 'raw' | 'p' | 'colour'> => {
    let best: Pick<SubsetFit, 'raw' | 'p' | 'colour'> | null = null;
    let bestError = Infinity;
    for (let p = 0; p < 2; p++) {
        let error = 0;
        const raw: [number[], number[]] = [[], []];
        const colour: [number[], number[]] = [[], []];
        [a, b].forEach((target, end) => {
            for (let c = 0; c < 3; c++) {
                const guess = Math.round((target[c] * 127 / 255 - p) / 2);
                let chosen = 0, chosenError = Infinity, chosenValue = 0;
                for (let q = Math.max(0, guess - 1); q <= Math.min(63, guess + 1); q++) {
                    const seven = (q << 1) | p;
                    const value = (seven << 1) | (seven >> 6);
                    const off = (value - target[c]) ** 2;
                    if (off < chosenError) { chosenError = off; chosen = q; chosenValue = value; }
                }
                raw[end].push(chosen);
                colour[end].push(chosenValue);
                error += chosenError;
            }
        });
        if (error < bestError) { bestError = error; best = { raw, p: [p, p], colour }; }
    }
    return best!;
};

/** Mode 3's end points: 7 bits each and a low bit for each end point's three channels. */
const quantizeMode3 = (a: number[], b: number[]): Pick<SubsetFit, 'raw' | 'p' | 'colour'> => {
    const raw: [number[], number[]] = [[], []];
    const p: [number, number] = [0, 0];
    const colour: [number[], number[]] = [[], []];
    [a, b].forEach((target, end) => {
        let bestError = Infinity;
        for (let bit = 0; bit < 2; bit++) {
            const q = target.map(value => Math.min(127, Math.max(0, Math.round((value - bit) / 2))));
            const error = q.reduce((sum, value, c) => sum + ((value << 1 | bit) - target[c]) ** 2, 0);
            if (error < bestError) { bestError = error; raw[end] = q; p[end] = bit; colour[end] = q.map(value => value << 1 | bit); }
        }
    });
    return { raw, p, colour };
};

const splitPalette = new Int32Array(8 * 3);

/** One subset's end points and indices: from its main axis, refined twice by least squares on the indices it gets. */
const fitSubset = (block: Uint8Array, members: number[], weights: readonly number[], quantize: (a: number[], b: number[]) => Pick<SubsetFit, 'raw' | 'p' | 'colour'>): SubsetFit => {
    const mean = [0, 0, 0];
    for (const i of members) for (let c = 0; c < 3; c++) mean[c] += block[i * 4 + c] / members.length;
    let axis = spreadStart(members.map(i => Array.from(block.subarray(i * 4, i * 4 + 3))), mean);
    for (let step = 0; step < 6; step++) {
        const next = [0, 0, 0];
        for (const i of members) {
            const d0 = block[i * 4] - mean[0], d1 = block[i * 4 + 1] - mean[1], d2 = block[i * 4 + 2] - mean[2];
            const dot = d0 * axis[0] + d1 * axis[1] + d2 * axis[2];
            next[0] += d0 * dot; next[1] += d1 * dot; next[2] += d2 * dot;
        }
        const length = Math.hypot(next[0], next[1], next[2]);
        if (length < 1e-6) break;
        axis = next.map(value => value / length);
    }
    let low = Infinity, high = -Infinity;
    for (const i of members) {
        const t = (block[i * 4] - mean[0]) * axis[0] + (block[i * 4 + 1] - mean[1]) * axis[1] + (block[i * 4 + 2] - mean[2]) * axis[2];
        low = Math.min(low, t);
        high = Math.max(high, t);
    }
    let a = mean.map((value, c) => Math.min(255, Math.max(0, value + axis[c] * low)));
    let b = mean.map((value, c) => Math.min(255, Math.max(0, value + axis[c] * high)));
    let best: SubsetFit | null = null;
    for (let round = 0; round < 3; round++) {
        const quantized = quantize(a, b);
        const [ea, eb] = quantized.colour;
        for (let k = 0; k < weights.length; k++) {
            for (let c = 0; c < 3; c++) splitPalette[k * 3 + c] = ((64 - weights[k]) * ea[c] + weights[k] * eb[c] + 32) >> 6;
        }
        const indices = new Array<number>(16).fill(0);
        let error = 0;
        for (const i of members) {
            const r = block[i * 4], g = block[i * 4 + 1], bl = block[i * 4 + 2];
            let chosen = 0, chosenError = Infinity;
            for (let k = 0; k < weights.length; k++) {
                const dr = splitPalette[k * 3] - r, dg = splitPalette[k * 3 + 1] - g, db = splitPalette[k * 3 + 2] - bl;
                const off = dr * dr + dg * dg + db * db;
                if (off < chosenError) { chosenError = off; chosen = k; }
            }
            indices[i] = chosen;
            error += chosenError;
        }
        if (!best || error < best.error) best = { ...quantized, indices, error };
        if (error === 0) break;
        // End points that best fit the indices given.
        let aa = 0, ab = 0, bb = 0;
        const ax = [0, 0, 0], bx = [0, 0, 0];
        for (const i of members) {
            const t = weights[indices[i]] / 64;
            const s = 1 - t;
            aa += s * s; ab += s * t; bb += t * t;
            for (let c = 0; c < 3; c++) { ax[c] += s * block[i * 4 + c]; bx[c] += t * block[i * 4 + c]; }
        }
        const det = aa * bb - ab * ab;
        if (Math.abs(det) < 1e-9) break;
        a = ax.map((value, c) => Math.min(255, Math.max(0, (value * bb - bx[c] * ab) / det)));
        b = bx.map((value, c) => Math.min(255, Math.max(0, (value * aa - ax[c] * ab) / det)));
    }
    return best!;
};

/**
 * Mode 1 (6-bit end points, eight steps) or mode 3 (8-bit end points, four steps): two subsets of an opaque block split
 * the way `split` says, each with end points of its own. Returns the block and its error.
 */
const encodeBc7Split = (block: Uint8Array, split: number, mode: 1 | 3): { bytes: Uint8Array; error: number } => {
    const mask = BC7_PARTITIONS[split];
    const weights = mode === 1 ? BC7_WEIGHTS_3 : BC7_WEIGHTS_2;
    const quantize = mode === 1 ? quantizeMode1 : quantizeMode3;
    const anchors = [0, BC7_ANCHORS[split]];
    const fits = [0, 1].map((subset) => {
        const members = Array.from({ length: 16 }, (_, i) => i).filter(i => ((mask >> i) & 1) === subset);
        const fit = fitSubset(block, members, weights, quantize);
        // A subset's first pixel (its anchor) has no top bit in its index: when it would need one, the end points swap.
        if (fit.indices[anchors[subset]] >= weights.length / 2) {
            fit.raw = [fit.raw[1], fit.raw[0]];
            fit.p = [fit.p[1], fit.p[0]];
            fit.colour = [fit.colour[1], fit.colour[0]];
            for (const i of members) fit.indices[i] = weights.length - 1 - fit.indices[i];
        }
        return fit;
    });
    const out = new BitWriter();
    out.write(1 << mode, mode + 1);
    out.write(split, 6);
    const bits = mode === 1 ? 6 : 7;
    for (let c = 0; c < 3; c++) for (const fit of fits) { out.write(fit.raw[0][c], bits); out.write(fit.raw[1][c], bits); }
    if (mode === 1) { out.write(fits[0].p[0], 1); out.write(fits[1].p[0], 1); } else for (const fit of fits) { out.write(fit.p[0], 1); out.write(fit.p[1], 1); }
    const indexBits = mode === 1 ? 3 : 2;
    for (let i = 0; i < 16; i++) out.write(fits[(mask >> i) & 1].indices[i], indexBits - (i === 0 || i === anchors[1] ? 1 : 0));
    return { bytes: out.bytes, error: fits[0].error + fits[1].error };
};

const blockError = (block: Uint8Array, decoded: Uint8Array): number => {
    let error = 0;
    for (let i = 0; i < 64; i++) error += (decoded[i] - block[i]) ** 2;
    return error;
};

const decodedScratch = new Uint8Array(64);

/**
 * A block in BC7: mode 6 (one line of colour and alpha), or for an opaque block of two colours that one line cannot
 * hold, mode 1 or 3 split the best of BC7's ways, whichever comes back closest.
 */
const encodeBc7Block = (block: Uint8Array): Uint8Array => {
    let opaque = true;
    for (let i = 3; i < 64; i += 4) if (block[i] !== 255) { opaque = false; break; }
    let best = encodeBc7Mode6(block, opaque);
    if (!opaque) return best;
    decodeBc7Block(best, decodedScratch);
    let bestError = blockError(block, decodedScratch);
    if (bestError <= BC7_CLOSE_ENOUGH) return best;
    for (const split of bestSplits(block)) {
        for (const mode of [1, 3] as const) {
            const tried = encodeBc7Split(block, split, mode);
            if (tried.error < bestError) { best = tried.bytes; bestError = tried.error; }
        }
        // A split that keeps the block close enough ends the search.
        if (bestError <= BC7_CLOSE_ENOUGH) break;
    }
    return best;
};

class BitReader {
    private at = 0;
    constructor(private readonly bytes: Uint8Array) {}
    read(bits: number): number {
        let value = 0;
        for (let i = 0; i < bits; i++, this.at++) value |= ((this.bytes[this.at >> 3] >> (this.at & 7)) & 1) << i;
        return value;
    }
}

/** BC7 blocks of the modes written here (6, 1 and 3) back to RGBA, exactly as a graphics card decodes them. */
const decodeBc7Block = (bytes: Uint8Array, out: Uint8Array): void => {
    const bits = new BitReader(bytes);
    let mode = 0;
    while (mode < 8 && bits.read(1) === 0) mode++;
    if (mode === 6) {
        const q = [[0, 0, 0, 0], [0, 0, 0, 0]];
        for (let c = 0; c < 4; c++) { q[0][c] = bits.read(7); q[1][c] = bits.read(7); }
        const p = [bits.read(1), bits.read(1)];
        const a = q[0].map(value => value << 1 | p[0]);
        const b = q[1].map(value => value << 1 | p[1]);
        for (let i = 0; i < 16; i++) {
            const weight = BC7_WEIGHTS[bits.read(i === 0 ? 3 : 4)];
            for (let c = 0; c < 4; c++) out[i * 4 + c] = ((64 - weight) * a[c] + weight * b[c] + 32) >> 6;
        }
        return;
    }
    if (mode !== 1 && mode !== 3) { out.fill(0); return; }
    const split = bits.read(6);
    const endpointBits = mode === 1 ? 6 : 7;
    const raw = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let c = 0; c < 3; c++) for (let end = 0; end < 4; end++) raw[end][c] = bits.read(endpointBits);
    let p: number[];
    if (mode === 1) {
        const shared = [bits.read(1), bits.read(1)];
        p = [shared[0], shared[0], shared[1], shared[1]];
    } else {
        p = [bits.read(1), bits.read(1), bits.read(1), bits.read(1)];
    }
    const colour = raw.map((end, k) => end.map((value) => {
        const full = value << 1 | p[k];
        return mode === 1 ? (full << 1) | (full >> 6) : full;
    }));
    const mask = BC7_PARTITIONS[split];
    const anchor = BC7_ANCHORS[split];
    const weights = mode === 1 ? BC7_WEIGHTS_3 : BC7_WEIGHTS_2;
    const indexBits = mode === 1 ? 3 : 2;
    for (let i = 0; i < 16; i++) {
        const subset = (mask >> i) & 1;
        const weight = weights[bits.read(indexBits - (i === 0 || i === anchor ? 1 : 0))];
        const a = colour[subset * 2], b = colour[subset * 2 + 1];
        for (let c = 0; c < 3; c++) out[i * 4 + c] = ((64 - weight) * a[c] + weight * b[c] + 32) >> 6;
        out[i * 4 + 3] = 255;
    }
};

// --- BC4, signed, the non-negative half ---------------------------------------------------------

const encodeBc4Block = (block: Uint8Array): Uint8Array => {
    // Red only, as 0..127 so the signed format reads it back 0..1.
    const values = Array.from({ length: 16 }, (_, i) => Math.round(block[i * 4] * 127 / 255));
    const high = Math.max(...values);
    const low = Math.min(...values);
    const out = new Uint8Array(8);
    out[0] = high;
    out[1] = low;
    const levels = [high, low, ...[1, 2, 3, 4, 5, 6].map(step => ((7 - step) * high + step * low) / 7)];
    let bits = 0n;
    for (let i = 0; i < 16; i++) {
        let best = 0, bestError = Infinity;
        for (let k = 0; k < 8; k++) {
            const error = Math.abs(levels[k] - values[i]);
            if (error < bestError) { bestError = error; best = k; }
        }
        bits |= BigInt(high === low ? 0 : best) << BigInt(i * 3);
    }
    for (let i = 0; i < 6; i++) out[2 + i] = Number((bits >> BigInt(i * 8)) & 255n);
    return out;
};

const decodeBc4Block = (bytes: Uint8Array, out: Uint8Array): void => {
    const signed = (value: number) => Math.max(-127, (value << 24) >> 24);
    const high = signed(bytes[0]);
    const low = signed(bytes[1]);
    const levels = high > low
        ? [high, low, ...[1, 2, 3, 4, 5, 6].map(step => ((7 - step) * high + step * low) / 7)]
        : [high, low, ...[1, 2, 3, 4].map(step => ((5 - step) * high + step * low) / 5), -127, 127];
    let bits = 0n;
    for (let i = 0; i < 6; i++) bits |= BigInt(bytes[2 + i]) << BigInt(i * 8);
    for (let i = 0; i < 16; i++) {
        const value = Math.max(0, levels[Number((bits >> BigInt(i * 3)) & 7n)] / 127);
        const byte = Math.round(value * 255);
        out[i * 4] = byte; out[i * 4 + 1] = byte; out[i * 4 + 2] = byte; out[i * 4 + 3] = 255;
    }
};

// --- Whole textures ------------------------------------------------------------------------------

const BLOCK_SIZE: Record<MaterialTextureFormat, number> = { bc7: 16, bc5: 16, bc4: 8, astc: ASTC_BLOCK_BYTES, etc2: ETC2_BLOCK_BYTES, etc2a: ETC2A_BLOCK_BYTES };

const ENCODE_BLOCK: Record<Exclude<MaterialTextureFormat, 'bc5'>, (block: Uint8Array) => Uint8Array> = {
    bc7: (block) => encodeBc7Block(block),
    bc4: (block) => encodeBc4Block(block),
    astc: encodeAstcBlock,
    etc2: encodeEtc2Block,
    etc2a: encodeEtc2AlphaBlock,
};

const DECODE_BLOCK: Record<Exclude<MaterialTextureFormat, 'bc5'>, (bytes: Uint8Array, out: Uint8Array) => void> = {
    bc7: (bytes, out) => decodeBc7Block(bytes, out),
    bc4: (bytes, out) => decodeBc4Block(bytes, out),
    astc: decodeAstcBlock,
    etc2: decodeEtc2Block,
    etc2a: decodeEtc2AlphaBlock,
};

/** One level's blocks in the format. */
export const encodeLevel = (rgba: Uint8Array, width: number, height: number, format: MaterialTextureFormat): Uint8Array => {
    if (format === 'bc5') return encodeBlocks(rgba, width, height, 'bc5');
    const columns = Math.ceil(width / 4);
    const rows = Math.ceil(height / 4);
    const size = BLOCK_SIZE[format];
    const out = new Uint8Array(columns * rows * size);
    const block = new Uint8Array(64);
    for (let by = 0; by < rows; by++) {
        for (let bx = 0; bx < columns; bx++) {
            readBlock(rgba, width, height, bx, by, block);
            out.set(ENCODE_BLOCK[format](block), (by * columns + bx) * size);
        }
    }
    return out;
};

/** One level's blocks back to RGBA (the compression preview). */
export const decodeLevel = (data: Uint8Array, width: number, height: number, format: MaterialTextureFormat): Uint8Array => {
    if (format === 'bc5') {
        // BC5 keeps a normal's X and Y; its Z is rebuilt from them, as the shader does, and it is opaque.
        const rg = decodeBlocks(data, width, height, 'bc5');
        for (let i = 0; i < rg.length; i += 4) {
            const x = rg[i] / 127.5 - 1;
            const y = rg[i + 1] / 127.5 - 1;
            rg[i + 2] = Math.round((Math.sqrt(Math.max(0, 1 - x * x - y * y)) * 0.5 + 0.5) * 255);
            rg[i + 3] = 255;
        }
        return rg;
    }
    const columns = Math.ceil(width / 4);
    const out = new Uint8Array(width * height * 4);
    const block = new Uint8Array(64);
    const size = BLOCK_SIZE[format];
    for (let by = 0; by < Math.ceil(height / 4); by++) {
        for (let bx = 0; bx < columns; bx++) {
            const bytes = data.subarray((by * columns + bx) * size, (by * columns + bx + 1) * size);
            DECODE_BLOCK[format](bytes, block);
            for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
                const px = bx * 4 + x, py = by * 4 + y;
                if (px < width && py < height) out.set(block.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4), (py * width + px) * 4);
            }
        }
    }
    return out;
};

/** A texture compressed with its mip levels (or the one level), ready for the GPU. */
export const encodeMaterialTexture = (
    rgba: Uint8Array, width: number, height: number, format: MaterialTextureFormat, kind: MaterialTextureKind, mips = true,
): EncodedLevel[] => {
    const levels = mips ? kaiserMipLevels(rgba, width, height, kind) : [{ data: rgba, width, height }];
    return levels.map(level => ({ data: encodeLevel(level.data, level.width, level.height, format), width: level.width, height: level.height }));
};
