/**
 * How much daylight the scene's sky gives, 0 (night) to 1 (full day), for what reacts to it
 * (vehicle headlights in Auto); 1 when the level has no sky. The sky publishes it as it changes.
 */
let current = 1;

export const sceneDaylight = (): number => current;

export const publishDaylight = (value: number | null): void => {
    current = value === null || !Number.isFinite(value) ? 1 : Math.min(1, Math.max(0, value));
};

/**
 * The sun and the fog as the sky last drew them, for screen effects that work with the light
 * (light shafts, sunlit haze): a unit vector toward the sun, its colour (linear) and strength,
 * and the scene fog's density (FogExp2) and colour. The sky publishes these each frame;
 * without a sky the sun is overhead and dim and there is no fog.
 */
export const skyLight = {
    sun: { x: 0.3, y: 0.9, z: 0.3 },
    sunColor: [1, 1, 1] as [number, number, number],
    sunStrength: 0,
    fogDensity: 0,
    fogColor: [0, 0, 0] as [number, number, number],
};

export const publishSkyLight = (
    sun: { x: number; y: number; z: number },
    color: { r: number; g: number; b: number },
    strength: number,
    fogDensity: number,
    fogColor: { r: number; g: number; b: number },
): void => {
    const length = Math.hypot(sun.x, sun.y, sun.z) || 1;
    skyLight.sun.x = sun.x / length;
    skyLight.sun.y = sun.y / length;
    skyLight.sun.z = sun.z / length;
    skyLight.sunColor[0] = color.r;
    skyLight.sunColor[1] = color.g;
    skyLight.sunColor[2] = color.b;
    skyLight.sunStrength = Number.isFinite(strength) ? Math.max(0, strength) : 0;
    skyLight.fogDensity = Number.isFinite(fogDensity) ? Math.max(0, fogDensity) : 0;
    skyLight.fogColor[0] = fogColor.r;
    skyLight.fogColor[1] = fogColor.g;
    skyLight.fogColor[2] = fogColor.b;
};
