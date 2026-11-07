import { decodeLevel, encodeLevel, type MaterialTextureFormat } from '../utils/textureCompression/materialTextureEncoder';
import type { TextureRole } from './textureSettings';

/**
 * WHERE COMPRESSION HURTS
 *
 * A texture compressed as the game keeps it, compared with itself whole: a sample of it is compressed and read back,
 * and what is lost is measured the way it shows. Colour is judged where it is smooth (a gradient bands before detail
 * blurs), normal maps by how far their directions turn (sharp edges soften), data by the largest step. A texture that
 * loses too much gets a plain fix: keep it uncompressed, or raise its size limit when the limit is what shrank it.
 */

export type CompressionFix = 'uncompressed' | 'raiseLimit';

export interface CompressionAdvice {
    /** What is lost, in plain words; absent when it compresses well. */
    problem?: string;
    fix?: CompressionFix;
    /** The measure behind it: largest step in smooth colour (0-255), 95th-percentile turn of normals (degrees), or largest data step. */
    measure: number;
}

/** Pixels across the sample measured. */
const SAMPLE = 128;

/** The middle of a picture, at most SAMPLE pixels a side and whole blocks. */
const sampleOf = (rgba: Uint8Array, width: number, height: number): { pixels: Uint8Array; size: number } => {
    const size = Math.max(4, Math.min(SAMPLE, width, height) & ~3);
    const left = Math.floor((width - size) / 2);
    const top = Math.floor((height - size) / 2);
    const pixels = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) pixels.set(rgba.subarray(((top + y) * width + left) * 4, ((top + y) * width + left + size) * 4), y * size * 4);
    return { pixels, size };
};

/** Largest colour step inside 4×4 blocks that were smooth to begin with (their spread under 24 steps): where banding shows. */
const smoothColourError = (source: Uint8Array, kept: Uint8Array, size: number): number => {
    let worst = 0;
    for (let by = 0; by < size; by += 4) for (let bx = 0; bx < size; bx += 4) {
        let low = 255, high = 0, error = 0;
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
            const at = ((by + y) * size + bx + x) * 4;
            for (let c = 0; c < 3; c++) {
                low = Math.min(low, source[at + c]);
                high = Math.max(high, source[at + c]);
                error = Math.max(error, Math.abs(source[at + c] - kept[at + c]));
            }
        }
        if (high - low < 24 && high - low > 0) worst = Math.max(worst, error);
    }
    return worst;
};

/** How far normals turn, in degrees: the 95th percentile over the sample (blue rebuilt from red and green on both). */
const normalTurn = (source: Uint8Array, kept: Uint8Array, size: number): number => {
    const turns: number[] = [];
    const direction = (bytes: Uint8Array, at: number): [number, number, number] => {
        const x = bytes[at] / 127.5 - 1;
        const y = bytes[at + 1] / 127.5 - 1;
        return [x, y, Math.sqrt(Math.max(0, 1 - x * x - y * y))];
    };
    for (let i = 0; i < size * size; i++) {
        const a = direction(source, i * 4);
        const b = direction(kept, i * 4);
        const dot = Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / Math.max(1e-6, Math.hypot(...a) * Math.hypot(...b))));
        turns.push(Math.acos(dot) * 180 / Math.PI);
    }
    turns.sort((a, b) => a - b);
    return turns[Math.floor(turns.length * 0.95)] ?? 0;
};

const largestStep = (source: Uint8Array, kept: Uint8Array): number => {
    let worst = 0;
    for (let i = 0; i < source.length; i += 4) worst = Math.max(worst, Math.abs(source[i] - kept[i]));
    return worst;
};

/** The thresholds past which the loss shows. */
export const COMPRESSION_LIMITS = { smoothColour: 6, normalTurn: 6, dataStep: 16 } as const;

/**
 * What compressing a picture (RGBA, as the game reads it) into `format` loses for its role, and the fix. `limited`
 * says its size limit drew it smaller than its file.
 */
export const compressionAdvice = (rgba: Uint8Array, width: number, height: number, role: TextureRole, format: MaterialTextureFormat, limited = false): CompressionAdvice => {
    const { pixels, size } = sampleOf(rgba, width, height);
    const kept = decodeLevel(encodeLevel(pixels, size, size, format), size, size, format);
    if (role === 'normal') {
        const measure = normalTurn(pixels, kept, size);
        return measure > COMPRESSION_LIMITS.normalTurn
            ? { measure, problem: `Sharp normal detail softens when compressed: edges turn by up to ${Math.round(measure)}°.`, fix: 'uncompressed' }
            : { measure };
    }
    if (role === 'colour') {
        const measure = smoothColourError(pixels, kept, size);
        return measure > COMPRESSION_LIMITS.smoothColour
            ? { measure, problem: `Smooth gradients band when compressed (steps of ${measure} in 255).`, fix: limited ? 'raiseLimit' : 'uncompressed' }
            : { measure };
    }
    const measure = largestStep(pixels, kept);
    return measure > COMPRESSION_LIMITS.dataStep
        ? { measure, problem: `Fine values step when compressed (by up to ${measure} in 255).`, fix: 'uncompressed' }
        : { measure };
};

/** A fix in plain words, for its button. */
export const FIX_WORDS: Record<CompressionFix, string> = {
    uncompressed: 'Keep it uncompressed',
    raiseLimit: 'Raise the size limit',
};
