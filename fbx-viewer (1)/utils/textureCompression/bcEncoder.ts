/**
 * BLOCK COMPRESSION (BC1 / BC3 / BC5)
 *
 * Desktop GPUs sample BC textures straight from memory, at an eighth (BC1) or a quarter (BC3) of
 * the size of plain RGBA. Each 4x4 block of pixels keeps two endpoint colours on the line its
 * pixels lie closest to (their principal axis) and a 2-bit choice per pixel among the endpoints and
 * two colours between them; BC3 adds a block of 8 alpha levels. BC5 keeps a normal map's two
 * angles (red and green) in two such 8-level blocks, at a quarter of the size; the shader rebuilds
 * the third. Mip levels are made by averaging 2x2 pixels, in linear light for colour textures (so a
 * texture keeps its brightness when small) and as renormalised directions for normal maps.
 */

export type BlockFormat = 'bc1' | 'bc3' | 'bc5';

export interface CompressedLevel {
    data: Uint8Array;
    width: number;
    height: number;
}

/** Bytes per 4x4 block. */
export const BLOCK_BYTES: Record<BlockFormat, number> = { bc1: 8, bc3: 16, bc5: 16 };

const SRGB_TO_LINEAR = new Float32Array(256);
for (let value = 0; value < 256; value++) {
    const c = value / 255;
    SRGB_TO_LINEAR[value] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const linearToSrgb = (value: number): number => {
    const c = value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
};

/** Whether any pixel of an RGBA image is less than nearly opaque. */
export const hasAlpha = (rgba: Uint8Array | Uint8ClampedArray): boolean => {
    for (let index = 3; index < rgba.length; index += 4) if (rgba[index] < 250) return true;
    return false;
};

/** An RGBA image at half the size (each side at least 1), averaging 2x2 pixels; in linear light when `srgb`. */
export const halveImage = (rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, srgb: boolean): { data: Uint8Array; width: number; height: number } => {
    const outWidth = Math.max(1, width >> 1);
    const outHeight = Math.max(1, height >> 1);
    const out = new Uint8Array(outWidth * outHeight * 4);
    for (let y = 0; y < outHeight; y++) {
        for (let x = 0; x < outWidth; x++) {
            const sx = Math.min(width - 1, x * 2);
            const sy = Math.min(height - 1, y * 2);
            const sx1 = Math.min(width - 1, sx + 1);
            const sy1 = Math.min(height - 1, sy + 1);
            const corners = [(sy * width + sx) * 4, (sy * width + sx1) * 4, (sy1 * width + sx) * 4, (sy1 * width + sx1) * 4];
            const target = (y * outWidth + x) * 4;
            for (let channel = 0; channel < 4; channel++) {
                if (srgb && channel < 3) {
                    let sum = 0;
                    for (const corner of corners) sum += SRGB_TO_LINEAR[rgba[corner + channel]];
                    out[target + channel] = linearToSrgb(sum / 4);
                } else {
                    let sum = 0;
                    for (const corner of corners) sum += rgba[corner + channel];
                    out[target + channel] = Math.round(sum / 4);
                }
            }
        }
    }
    return { data: out, width: outWidth, height: outHeight };
};

/** A normal map at half the size: each texel the renormalised average of the 2x2 directions under it. */
export const halveNormals = (rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): { data: Uint8Array; width: number; height: number } => {
    const outWidth = Math.max(1, width >> 1);
    const outHeight = Math.max(1, height >> 1);
    const out = new Uint8Array(outWidth * outHeight * 4);
    for (let y = 0; y < outHeight; y++) {
        for (let x = 0; x < outWidth; x++) {
            const sx = Math.min(width - 1, x * 2), sy = Math.min(height - 1, y * 2);
            const sx1 = Math.min(width - 1, sx + 1), sy1 = Math.min(height - 1, sy + 1);
            let nx = 0, ny = 0, nz = 0;
            for (const corner of [(sy * width + sx) * 4, (sy * width + sx1) * 4, (sy1 * width + sx) * 4, (sy1 * width + sx1) * 4]) {
                nx += rgba[corner] / 127.5 - 1;
                ny += rgba[corner + 1] / 127.5 - 1;
                nz += rgba[corner + 2] / 127.5 - 1;
            }
            const length = Math.hypot(nx, ny, nz) || 1;
            const target = (y * outWidth + x) * 4;
            out[target] = Math.round((nx / length + 1) * 127.5);
            out[target + 1] = Math.round((ny / length + 1) * 127.5);
            out[target + 2] = Math.round((nz / length + 1) * 127.5);
            out[target + 3] = 255;
        }
    }
    return { data: out, width: outWidth, height: outHeight };
};

const to565 = (r: number, g: number, b: number): number =>
    ((Math.round(r * 31 / 255) & 31) << 11) | ((Math.round(g * 63 / 255) & 63) << 5) | (Math.round(b * 31 / 255) & 31);

const from565 = (color: number, out: number[], offset: number): void => {
    const r = (color >> 11) & 31;
    const g = (color >> 5) & 63;
    const b = color & 31;
    out[offset] = (r << 3) | (r >> 2);
    out[offset + 1] = (g << 2) | (g >> 4);
    out[offset + 2] = (b << 3) | (b >> 2);
};

// Scratch space for one block: 16 pixels of RGBA, the palette and the axis.
const block = new Float32Array(64);
const palette: number[] = new Array(12).fill(0);

/** Gathers the 4x4 block at (bx, by) into `block`, repeating edge pixels past the image's edges. */
const readBlock = (rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, bx: number, by: number): void => {
    for (let y = 0; y < 4; y++) {
        const sy = Math.min(height - 1, by * 4 + y);
        for (let x = 0; x < 4; x++) {
            const sx = Math.min(width - 1, bx * 4 + x);
            const source = (sy * width + sx) * 4;
            const target = (y * 4 + x) * 4;
            block[target] = rgba[source];
            block[target + 1] = rgba[source + 1];
            block[target + 2] = rgba[source + 2];
            block[target + 3] = rgba[source + 3];
        }
    }
};

/** Writes the colour part of the block in `block` (8 bytes) at `offset`: endpoints on the pixels' principal axis. */
const writeColourBlock = (out: Uint8Array, offset: number, threeColourAllowed: boolean): void => {
    // Mean and covariance of the pixels' colours.
    let mr = 0, mg = 0, mb = 0;
    for (let pixel = 0; pixel < 16; pixel++) { mr += block[pixel * 4]; mg += block[pixel * 4 + 1]; mb += block[pixel * 4 + 2]; }
    mr /= 16; mg /= 16; mb /= 16;
    let crr = 0, crg = 0, crb = 0, cgg = 0, cgb = 0, cbb = 0;
    for (let pixel = 0; pixel < 16; pixel++) {
        const r = block[pixel * 4] - mr, g = block[pixel * 4 + 1] - mg, b = block[pixel * 4 + 2] - mb;
        crr += r * r; crg += r * g; crb += r * b; cgg += g * g; cgb += g * b; cbb += b * b;
    }
    // Principal axis by power iteration, from the brightest direction.
    let ar = 0.6, ag = 0.8, ab = 0.4;
    for (let step = 0; step < 6; step++) {
        const nr = crr * ar + crg * ag + crb * ab;
        const ng = crg * ar + cgg * ag + cgb * ab;
        const nb = crb * ar + cgb * ag + cbb * ab;
        const length = Math.hypot(nr, ng, nb);
        if (length < 1e-6) break;
        ar = nr / length; ag = ng / length; ab = nb / length;
    }
    // The pixels furthest along the axis each way are the endpoints.
    let low = 0, high = 0, lowDot = Infinity, highDot = -Infinity;
    for (let pixel = 0; pixel < 16; pixel++) {
        const dot = block[pixel * 4] * ar + block[pixel * 4 + 1] * ag + block[pixel * 4 + 2] * ab;
        if (dot < lowDot) { lowDot = dot; low = pixel; }
        if (dot > highDot) { highDot = dot; high = pixel; }
    }
    let c0 = to565(block[high * 4], block[high * 4 + 1], block[high * 4 + 2]);
    let c1 = to565(block[low * 4], block[low * 4 + 1], block[low * 4 + 2]);
    // Four-colour mode needs c0 > c1 (BC3's colour block is always four-colour).
    if (c0 < c1) { const swap = c0; c0 = c1; c1 = swap; }
    let indices = 0;
    if (c0 !== c1 || !threeColourAllowed) {
        from565(c0, palette, 0);
        from565(c1, palette, 3);
        for (let channel = 0; channel < 3; channel++) {
            palette[6 + channel] = (2 * palette[channel] + palette[3 + channel]) / 3;
            palette[9 + channel] = (palette[channel] + 2 * palette[3 + channel]) / 3;
        }
        for (let pixel = 15; pixel >= 0; pixel--) {
            let best = 0, bestError = Infinity;
            for (let entry = 0; entry < 4; entry++) {
                const dr = block[pixel * 4] - palette[entry * 3];
                const dg = block[pixel * 4 + 1] - palette[entry * 3 + 1];
                const db = block[pixel * 4 + 2] - palette[entry * 3 + 2];
                const error = dr * dr + dg * dg + db * db;
                if (error < bestError) { bestError = error; best = entry; }
            }
            indices = (indices << 2) | best;
        }
        if (c0 === c1) indices = 0;
    }
    out[offset] = c0 & 255; out[offset + 1] = c0 >> 8;
    out[offset + 2] = c1 & 255; out[offset + 3] = c1 >> 8;
    out[offset + 4] = indices & 255; out[offset + 5] = (indices >>> 8) & 255;
    out[offset + 6] = (indices >>> 16) & 255; out[offset + 7] = (indices >>> 24) & 255;
};

/**
 * Writes one channel of the block in `block` (8 bytes: BC3's alpha, or each half of BC5) at
 * `offset`: 8 levels between the channel's least and most in the block.
 */
const writeChannelBlock = (out: Uint8Array, offset: number, channel: number): void => {
    let a0 = 0, a1 = 255;
    for (let pixel = 0; pixel < 16; pixel++) { a0 = Math.max(a0, block[pixel * 4 + channel]); a1 = Math.min(a1, block[pixel * 4 + channel]); }
    out[offset] = a0; out[offset + 1] = a1;
    const levels = [a0, a1];
    for (let step = 1; step < 7; step++) levels.push(a0 > a1 ? ((7 - step) * a0 + step * a1) / 7 : a0);
    // Indices 0..7 into a0, a1 and the six between: 48 bits, pixel 0 lowest, written as two 24-bit halves.
    for (let half = 0; half < 2; half++) {
        let bits = 0;
        for (let pixel = half * 8 + 7; pixel >= half * 8; pixel--) {
            const alpha = block[pixel * 4 + channel];
            let best = 0, bestError = Infinity;
            for (let level = 0; level < 8; level++) {
                const error = Math.abs(alpha - levels[level]);
                if (error < bestError) { bestError = error; best = level; }
            }
            bits = bits * 8 + best;
        }
        out[offset + 2 + half * 3] = bits & 255;
        out[offset + 3 + half * 3] = (bits >> 8) & 255;
        out[offset + 4 + half * 3] = (bits >> 16) & 255;
    }
};

/** BC-compresses one RGBA image (any size; edge blocks repeat edge pixels). */
export const encodeBlocks = (rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, format: BlockFormat): Uint8Array => {
    const blocksX = Math.ceil(width / 4);
    const blocksY = Math.ceil(height / 4);
    const size = BLOCK_BYTES[format];
    const out = new Uint8Array(blocksX * blocksY * size);
    for (let by = 0; by < blocksY; by++) {
        for (let bx = 0; bx < blocksX; bx++) {
            readBlock(rgba, width, height, bx, by);
            const offset = (by * blocksX + bx) * size;
            if (format === 'bc3') {
                writeChannelBlock(out, offset, 3);
                writeColourBlock(out, offset + 8, false);
            } else if (format === 'bc5') {
                writeChannelBlock(out, offset, 0);
                writeChannelBlock(out, offset + 8, 1);
            } else {
                writeColourBlock(out, offset, true);
            }
        }
    }
    return out;
};

/** The image's full mip chain, BC-compressed, largest first (a BC5 normal map's levels renormalised). */
export const compressMipChain = (rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, format: BlockFormat, srgb: boolean): CompressedLevel[] => {
    const levels: CompressedLevel[] = [];
    let level = { data: rgba as Uint8Array, width, height };
    for (;;) {
        levels.push({ data: encodeBlocks(level.data, level.width, level.height, format), width: level.width, height: level.height });
        if (level.width === 1 && level.height === 1) break;
        level = format === 'bc5' ? halveNormals(level.data, level.width, level.height) : halveImage(level.data, level.width, level.height, srgb);
    }
    return levels;
};

/** One 8-level channel block at `offset` decoded into `channel` of `out` for the block at (bx, by). */
const decodeChannelBlock = (data: Uint8Array, offset: number, out: Uint8Array, width: number, height: number, bx: number, by: number, channel: number): void => {
    const a0 = data[offset], a1 = data[offset + 1];
    const levels = [a0, a1];
    for (let step = 1; step < 7; step++) levels.push(a0 > a1 ? ((7 - step) * a0 + step * a1) / 7 : a0);
    const halves = [0, 1].map(half => data[offset + 2 + half * 3] | (data[offset + 3 + half * 3] << 8) | (data[offset + 4 + half * 3] << 16));
    for (let pixel = 0; pixel < 16; pixel++) {
        const x = bx * 4 + (pixel & 3), y = by * 4 + (pixel >> 2);
        if (x >= width || y >= height) continue;
        out[(y * width + x) * 4 + channel] = Math.round(levels[(halves[pixel >> 3] >> ((pixel & 7) * 3)) & 7]);
    }
};

/** Decodes a BC1/BC3 image back to RGBA, for checking the encoder. */
export const decodeBlocks = (data: Uint8Array, width: number, height: number, format: BlockFormat): Uint8Array => {
    const out = new Uint8Array(width * height * 4);
    const blocksX = Math.ceil(width / 4);
    const size = BLOCK_BYTES[format];
    const colours: number[] = new Array(12).fill(0);
    for (let by = 0; by < Math.ceil(height / 4); by++) {
        for (let bx = 0; bx < blocksX; bx++) {
            const offset = (by * blocksX + bx) * size;
            if (format === 'bc5') {
                decodeChannelBlock(data, offset, out, width, height, bx, by, 0);
                decodeChannelBlock(data, offset + 8, out, width, height, bx, by, 1);
                continue;
            }
            const colourOffset = format === 'bc3' ? offset + 8 : offset;
            const c0 = data[colourOffset] | (data[colourOffset + 1] << 8);
            const c1 = data[colourOffset + 2] | (data[colourOffset + 3] << 8);
            from565(c0, colours, 0);
            from565(c1, colours, 3);
            const four = format === 'bc3' || c0 > c1;
            for (let channel = 0; channel < 3; channel++) {
                colours[6 + channel] = four ? (2 * colours[channel] + colours[3 + channel]) / 3 : (colours[channel] + colours[3 + channel]) / 2;
                colours[9 + channel] = four ? (colours[channel] + 2 * colours[3 + channel]) / 3 : 0;
            }
            const indices = (data[colourOffset + 4] | (data[colourOffset + 5] << 8) | (data[colourOffset + 6] << 16) | (data[colourOffset + 7] << 24)) >>> 0;
            let alphas: number[] | null = null;
            const alphaHalves = [0, 0];
            if (format === 'bc3') {
                const a0 = data[offset], a1 = data[offset + 1];
                alphas = [a0, a1];
                for (let step = 1; step < 7; step++) alphas.push(a0 > a1 ? ((7 - step) * a0 + step * a1) / 7 : a0);
                for (let half = 0; half < 2; half++) {
                    alphaHalves[half] = data[offset + 2 + half * 3] | (data[offset + 3 + half * 3] << 8) | (data[offset + 4 + half * 3] << 16);
                }
            }
            for (let pixel = 0; pixel < 16; pixel++) {
                const x = bx * 4 + (pixel & 3), y = by * 4 + (pixel >> 2);
                if (x >= width || y >= height) continue;
                const entry = (indices >>> (pixel * 2)) & 3;
                const target = (y * width + x) * 4;
                out[target] = Math.round(colours[entry * 3]);
                out[target + 1] = Math.round(colours[entry * 3 + 1]);
                out[target + 2] = Math.round(colours[entry * 3 + 2]);
                out[target + 3] = alphas ? Math.round(alphas[(alphaHalves[pixel >> 3] >> ((pixel & 7) * 3)) & 7]) : 255;
            }
        }
    }
    return out;
};
