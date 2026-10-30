/**
 * TEMPORAL ANTI-ALIASING: THE NUMBERS
 *
 * Each frame the picture is drawn from a slightly different spot inside every pixel, and the frames are
 * gathered up over time. These are the small pure rules behind that: where the spots fall, how many to
 * cycle through, what size to draw at, how much sharper textures must be chosen to make up for a smaller
 * picture, and when the view has changed so much that the past frames are of no use.
 */

/** Below half size in each direction there are too few pixels to rebuild the picture from. */
export const MIN_RENDER_SCALE = 0.5;
export const MAX_RENDER_SCALE = 1;

/** Eight spots serve one output pixel per drawn pixel; a smaller picture needs more to cover each output pixel. */
const BASE_PHASES = 8;
const MAX_PHASES = 64;

/** A view that turns further than this in one frame, or moves further (in metres), was cut to, not moved through. */
const CUT_TURN_COS = Math.cos((35 * Math.PI) / 180);
const CUT_DISTANCE = 12;

/** Gathered frames resolve finer detail than one, so textures can sit this many mip levels sharper at full size. */
const GATHERED_MIP_BIAS = -0.25;

export const clampRenderScale = (scale: number): number =>
    Number.isFinite(scale) ? Math.min(MAX_RENDER_SCALE, Math.max(MIN_RENDER_SCALE, scale)) : MAX_RENDER_SCALE;

/** The size the lit scene is drawn at for a display size and a render scale. */
export const renderSizeOf = (width: number, height: number, scale: number): { width: number; height: number } => {
    const s = clampRenderScale(scale);
    return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
};

/** Element `index` (from 1) of the low-discrepancy sequence in `base`, in 0..1. */
export const halton = (index: number, base: number): number => {
    let fraction = 1;
    let value = 0;
    for (let i = index; i > 0; i = Math.floor(i / base)) {
        fraction /= base;
        value += fraction * (i % base);
    }
    return value;
};

/** How many spots to cycle through before repeating at a render scale. */
export const jitterPhases = (scale: number): number => {
    const s = clampRenderScale(scale);
    return Math.min(MAX_PHASES, Math.ceil(BASE_PHASES / (s * s)));
};

/** This frame's offset inside the drawn pixel, in drawn pixels, each axis within -0.5..0.5. */
export const temporalJitter = <T extends { x: number; y: number }>(frame: number, scale: number, out: T): T => {
    const phase = (Math.abs(Math.trunc(frame)) % jitterPhases(scale)) + 1;
    out.x = halton(phase, 2) - 0.5;
    out.y = halton(phase, 3) - 0.5;
    return out;
};

/** What remembered contrast keeps of itself per frame, so half of it is left after one cycle of jitter. */
export const contrastFadeFor = (scale: number): number => Math.pow(0.5, 1 / jitterPhases(scale));

/** Mip levels to shift texture lookups by, so a smaller picture keeps the texture detail of the output size. */
export const mipBiasFor = (scale: number): number => Math.log2(clampRenderScale(scale)) + GATHERED_MIP_BIAS;

/** Whether the camera jumped between two frames, from where it stood and which way it faced (unit vectors). */
export const isCameraCut = (distance: number, facingDot: number): boolean => distance > CUT_DISTANCE || facingDot < CUT_TURN_COS;
