/**
 * How much daylight the scene's sky gives, 0 (night) to 1 (full day), for what reacts to it
 * (vehicle headlights in Auto); 1 when the level has no sky. The sky publishes it as it changes.
 */
let current = 1;

export const sceneDaylight = (): number => current;

export const publishDaylight = (value: number | null): void => {
    current = value === null || !Number.isFinite(value) ? 1 : Math.min(1, Math.max(0, value));
};
