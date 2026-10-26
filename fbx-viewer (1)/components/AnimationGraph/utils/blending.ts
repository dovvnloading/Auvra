/** Default crossfade when a transition has no usable duration. */
export const DEFAULT_BLEND_SECONDS = 0.2;

/** Frames longer than this are treated as this long, so a hitch does not snap blends. */
export const MAX_ANIMATION_DELTA = 0.1;

export const clampAnimationDelta = (delta: number) =>
    Number.isFinite(delta) && delta > 0 ? Math.min(delta, MAX_ANIMATION_DELTA) : 0;

export const blendSeconds = (duration: unknown) =>
    typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : DEFAULT_BLEND_SECONDS;

/**
 * Moves a weight linearly toward its target so a full 0->1 crossfade takes `duration` seconds,
 * independent of frame rate. A zero duration snaps.
 */
export const stepWeight = (current: number, target: number, delta: number, duration: number): number => {
    if (duration <= 0) return target;
    const step = delta / duration;
    return current < target ? Math.min(target, current + step) : Math.max(target, current - step);
};

export interface BlendSample2D {
    position: [number, number];
}

/**
 * Weights for a 2D blend space. A sample at (or extremely near) the parameter point gets the
 * whole weight; otherwise inverse-distance weights with a steep falloff, so the nearest samples
 * dominate and weights reach a clean 0/1 at sample positions. Weights sum to 1.
 */
export const blendWeights2D = (samples: BlendSample2D[], x: number, y: number): number[] => {
    if (!samples.length) return [];
    const distances = samples.map(sample => Math.hypot(sample.position[0] - x, sample.position[1] - y));
    const exact = distances.findIndex(distance => distance < 1e-4);
    if (exact >= 0) return samples.map((_, index) => (index === exact ? 1 : 0));
    const raw = distances.map(distance => 1 / Math.pow(distance, 4));
    const total = raw.reduce((sum, value) => sum + value, 0);
    return raw.map(value => value / total);
};
