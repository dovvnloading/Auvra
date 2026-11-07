import { decodeBlocks, encodeBlocks } from './bcEncoder';
import { ASTC_BLOCK_BYTES, decodeAstcBlock, encodeAstcBlock } from './astcEncoder';
import { ETC2A_BLOCK_BYTES, ETC2_BLOCK_BYTES, decodeEtc2AlphaBlock, decodeEtc2Block, encodeEtc2AlphaBlock, encodeEtc2Block } from './etc2Encoder';

/**
 * MATERIAL TEXTURE COMPRESSION
 *
 * Material assets' textures compressed for the GPU, by what they hold:
 * - colour (and colour with alpha): BC7, one byte a pixel, here its mode 6 (one subset, colour and alpha
 *   end points with a shared low bit, sixteen steps between);
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

// --- BC7, mode 6 ---------------------------------------------------------------------------------

const BC7_WEIGHTS = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];

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

/** A 7-bit end point and its low bit for each of two colours, the pair nearest them. */
const quantizeEndpoint = (colour: number[]): { q: number[]; p: number } => {
    let best = { q: [0, 0, 0, 0], p: 0 };
    let bestError = Infinity;
    for (let p = 0; p < 2; p++) {
        const q = colour.map(value => Math.min(127, Math.max(0, Math.round((value - p) / 2))));
        const error = q.reduce((sum, value, c) => sum + ((value << 1 | p) - colour[c]) ** 2, 0);
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

const encodeBc7Block = (block: Uint8Array): Uint8Array => {
    // The main axis through the block's colours and alphas; its two ends become the end points.
    const mean = [0, 0, 0, 0];
    for (let i = 0; i < 16; i++) for (let c = 0; c < 4; c++) mean[c] += block[i * 4 + c] / 16;
    let axis = [1, 1, 1, 1];
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
    let first = quantizeEndpoint(end(low));
    let second = quantizeEndpoint(end(high));
    const palette = () => {
        const a = first.q.map(value => value << 1 | first.p);
        const b = second.q.map(value => value << 1 | second.p);
        return BC7_WEIGHTS.map(weight => a.map((value, c) => ((64 - weight) * value + weight * b[c] + 32) >> 6));
    };
    let colours = palette();
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
        colours = palette();
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

class BitReader {
    private at = 0;
    constructor(private readonly bytes: Uint8Array) {}
    read(bits: number): number {
        let value = 0;
        for (let i = 0; i < bits; i++, this.at++) value |= ((this.bytes[this.at >> 3] >> (this.at & 7)) & 1) << i;
        return value;
    }
}

/** Mode 6 BC7 blocks back to RGBA, for the compression preview (the only mode written here). */
const decodeBc7Block = (bytes: Uint8Array, out: Uint8Array): void => {
    const bits = new BitReader(bytes);
    if (bits.read(7) !== 1 << 6) { out.fill(0); return; }
    const q = [[0, 0, 0, 0], [0, 0, 0, 0]];
    for (let c = 0; c < 4; c++) { q[0][c] = bits.read(7); q[1][c] = bits.read(7); }
    const p = [bits.read(1), bits.read(1)];
    const a = q[0].map(value => value << 1 | p[0]);
    const b = q[1].map(value => value << 1 | p[1]);
    for (let i = 0; i < 16; i++) {
        const index = bits.read(i === 0 ? 3 : 4);
        const weight = BC7_WEIGHTS[index];
        for (let c = 0; c < 4; c++) out[i * 4 + c] = ((64 - weight) * a[c] + weight * b[c] + 32) >> 6;
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
