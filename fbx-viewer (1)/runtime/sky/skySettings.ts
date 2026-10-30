import type { SkyConfig } from '../../types';

/**
 * SKY SETTINGS
 *
 * What a level's sky is made of, past the clock and the weather (runtime/weather.ts): the model that
 * draws it, its atmosphere, clouds and night, and the Sky Light it lights the level with. Saved values
 * are made whole and in range here, so everything downstream reads a complete, valid sky. Pure.
 */

/** Physically based atmosphere; the older analytic sky, which levels saved before the atmosphere keep; or a panorama image. */
export type SkyModel = 'atmosphere' | 'classic' | 'image';
export const SKY_MODELS: readonly SkyModel[] = ['atmosphere', 'classic', 'image'];
export const SKY_MODEL_LABELS: Record<SkyModel, string> = { atmosphere: 'Atmosphere', classic: 'Classic', image: 'Panorama Image' };

/** How the clouds are drawn: none, a flat painted layer, or volumetric at rising detail. */
export type CloudQuality = 'off' | 'layer' | 'low' | 'medium' | 'high';
export const CLOUD_QUALITIES: readonly CloudQuality[] = ['off', 'layer', 'low', 'medium', 'high'];
export const CLOUD_QUALITY_LABELS: Record<CloudQuality, string> = { off: 'Off', layer: 'Flat Layer', low: 'Volumetric Low', medium: 'Volumetric Medium', high: 'Volumetric High' };

export interface SkyAtmosphereSettings {
    /** How much the air scatters light, 1: Earth's. More is a deeper colour and a redder sunset. */
    rayleigh: number;
    /** What the air scatters: white is Earth's blue; a tint shifts the sky (a dusty world). */
    rayleighTint: string;
    /** Dust and droplets in the air, 1: a clear day. More is a whiter, hazier sky. */
    haze: number;
    /** How strongly the haze glows toward the sun, 0-0.98. */
    hazeGlow: number;
    /** Ozone, 1: Earth's: what keeps the sky blue at dusk. */
    ozone: number;
    /** The ground far below the horizon, which also lights the sky a little. */
    ground: string;
    /** A multiplier on the sky's brightness, without changing its colour or the sun. */
    brightness: number;
}

export interface SkyCloudSettings {
    quality: CloudQuality;
    /** Height of the cloud base and how deep the clouds are, metres. */
    altitude: number;
    thickness: number;
    /** How dense they are: lighter and more see-through below 1, heavier above. */
    density: number;
    /** How much fine detail eats into their edges, 0-1. */
    detail: number;
    /** How large the cloud shapes are, 1: ordinary fair-weather clouds. */
    scale: number;
    /** How much clouds shade the ground from the sun, 0-1. */
    shadows: number;
}

export interface SkyNightSettings {
    /** 0 and 1: new moon; 0.5: full. */
    moonPhase: number;
    /** The moon's size, 1: as it really looks. */
    moonSize: number;
    /** The moon's light, as a share of the Sun Intensity. */
    moonBrightness: number;
    stars: number;
    milkyWay: number;
    /** The faint glow of the night air, which keeps a moonless night from being pure black. */
    glow: string;
}

export type SkyLightSource = 'sky' | 'image';
export type SkyLightCapture = 'live' | 'once';

export interface SkyLightSettings {
    /** Light the level from the sky as it looks: off leaves the older flat fill. */
    enabled: boolean;
    /** What it captures: this sky, or a panorama image. */
    source: SkyLightSource;
    /** Follow the sky as it changes, or capture once, when it is set. */
    capture: SkyLightCapture;
    /** Side of the captured cube map, in texels. */
    resolution: number;
    intensity: number;
    tint: string;
    /** How much of it shows in reflections, 1: all of it. */
    reflections: number;
    /** Use a colour instead of what is below the horizon. */
    lowerSolid: boolean;
    lowerColor: string;
    /** How far what stands overhead shuts out the sky, 0: not at all. */
    occlusion: number;
    /** The least sky a covered place keeps. */
    occlusionFloor: number;
    /** Half the side of the square around the camera that occlusion covers, metres. */
    occlusionRange: number;
}

export interface SkyImageSettings {
    /** The panorama's texture asset (id or name). */
    textureId: string;
    /** Turns it round the vertical, degrees. */
    rotation: number;
    brightness: number;
}

const HEX = /^#[0-9a-f]{6}$/i;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const number = (value: unknown, fallback: number, min: number, max: number): number =>
    (typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback);

const colour = (value: unknown, fallback: string): string => (typeof value === 'string' && HEX.test(value) ? value : fallback);

/** `value` when it is "#rrggbb", else `fallback`. */
export const hexColour = colour;

const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
    ((options as readonly unknown[]).includes(value) ? value as T : fallback);

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {});

export const DEFAULT_ATMOSPHERE: Readonly<SkyAtmosphereSettings> = {
    rayleigh: 1, rayleighTint: '#ffffff', haze: 1, hazeGlow: 0.8, ozone: 1, ground: '#6b5f4e', brightness: 1,
};

export const DEFAULT_CLOUDS: Readonly<SkyCloudSettings> = {
    quality: 'medium', altitude: 1500, thickness: 1500, density: 1, detail: 0.5, scale: 1, shadows: 0.75,
};

export const DEFAULT_NIGHT: Readonly<SkyNightSettings> = {
    moonPhase: 0.5, moonSize: 2.2, moonBrightness: 0.25, stars: 1, milkyWay: 0.6, glow: '#0e182a',
};

export const DEFAULT_SKY_LIGHT: Readonly<SkyLightSettings> = {
    enabled: true, source: 'sky', capture: 'live', resolution: 128, intensity: 1, tint: '#ffffff', reflections: 1,
    lowerSolid: false, lowerColor: '#3b352c', occlusion: 1, occlusionFloor: 0.06, occlusionRange: 128,
};

/** A sky light that is off: what a sky saved before there was one reads. */
const NO_SKY_LIGHT: Readonly<SkyLightSettings> = { ...DEFAULT_SKY_LIGHT, enabled: false };

export const DEFAULT_SKY_IMAGE: Readonly<SkyImageSettings> = { textureId: '', rotation: 0, brightness: 1 };

const CUBE_SIZES: readonly number[] = [64, 128, 256];

export const resolveAtmosphere = (value: unknown): SkyAtmosphereSettings => {
    const v = record(value);
    return {
        rayleigh: number(v.rayleigh, DEFAULT_ATMOSPHERE.rayleigh, 0, 8),
        rayleighTint: colour(v.rayleighTint, DEFAULT_ATMOSPHERE.rayleighTint),
        haze: number(v.haze, DEFAULT_ATMOSPHERE.haze, 0, 40),
        hazeGlow: number(v.hazeGlow, DEFAULT_ATMOSPHERE.hazeGlow, 0, 0.98),
        ozone: number(v.ozone, DEFAULT_ATMOSPHERE.ozone, 0, 4),
        ground: colour(v.ground, DEFAULT_ATMOSPHERE.ground),
        brightness: number(v.brightness, DEFAULT_ATMOSPHERE.brightness, 0, 10),
    };
};

export const resolveClouds = (value: unknown): SkyCloudSettings => {
    const v = record(value);
    return {
        quality: oneOf(v.quality, CLOUD_QUALITIES, DEFAULT_CLOUDS.quality),
        altitude: number(v.altitude, DEFAULT_CLOUDS.altitude, 200, 12000),
        thickness: number(v.thickness, DEFAULT_CLOUDS.thickness, 100, 8000),
        density: number(v.density, DEFAULT_CLOUDS.density, 0.05, 4),
        detail: number(v.detail, DEFAULT_CLOUDS.detail, 0, 1),
        scale: number(v.scale, DEFAULT_CLOUDS.scale, 0.2, 5),
        shadows: number(v.shadows, DEFAULT_CLOUDS.shadows, 0, 1),
    };
};

export const resolveNight = (value: unknown): SkyNightSettings => {
    const v = record(value);
    return {
        moonPhase: number(v.moonPhase, DEFAULT_NIGHT.moonPhase, 0, 1),
        moonSize: number(v.moonSize, DEFAULT_NIGHT.moonSize, 0.2, 12),
        moonBrightness: number(v.moonBrightness, DEFAULT_NIGHT.moonBrightness, 0, 1),
        stars: number(v.stars, DEFAULT_NIGHT.stars, 0, 4),
        milkyWay: number(v.milkyWay, DEFAULT_NIGHT.milkyWay, 0, 4),
        glow: colour(v.glow, DEFAULT_NIGHT.glow),
    };
};

/** A saved sky light made whole; a sky with none saved has it off, so it keeps the look it was saved with. */
export const resolveSkyLight = (value: unknown): SkyLightSettings => {
    if (!value || typeof value !== 'object') return { ...NO_SKY_LIGHT };
    const v = record(value);
    const size = Number(v.resolution);
    return {
        enabled: typeof v.enabled === 'boolean' ? v.enabled : DEFAULT_SKY_LIGHT.enabled,
        source: oneOf(v.source, ['sky', 'image'] as const, DEFAULT_SKY_LIGHT.source),
        capture: oneOf(v.capture, ['live', 'once'] as const, DEFAULT_SKY_LIGHT.capture),
        resolution: CUBE_SIZES.includes(size) ? size : DEFAULT_SKY_LIGHT.resolution,
        intensity: number(v.intensity, DEFAULT_SKY_LIGHT.intensity, 0, 16),
        tint: colour(v.tint, DEFAULT_SKY_LIGHT.tint),
        reflections: number(v.reflections, DEFAULT_SKY_LIGHT.reflections, 0, 4),
        lowerSolid: typeof v.lowerSolid === 'boolean' ? v.lowerSolid : DEFAULT_SKY_LIGHT.lowerSolid,
        lowerColor: colour(v.lowerColor, DEFAULT_SKY_LIGHT.lowerColor),
        occlusion: number(v.occlusion, DEFAULT_SKY_LIGHT.occlusion, 0, 1),
        occlusionFloor: number(v.occlusionFloor, DEFAULT_SKY_LIGHT.occlusionFloor, 0, 1),
        occlusionRange: number(v.occlusionRange, DEFAULT_SKY_LIGHT.occlusionRange, 16, 1024),
    };
};

export const resolveSkyImage = (value: unknown): SkyImageSettings => {
    const v = record(value);
    return {
        textureId: typeof v.textureId === 'string' ? v.textureId.trim() : DEFAULT_SKY_IMAGE.textureId,
        rotation: number(v.rotation, DEFAULT_SKY_IMAGE.rotation, -360, 360),
        brightness: number(v.brightness, DEFAULT_SKY_IMAGE.brightness, 0, 16),
    };
};

/** A sky's model: one saved before there was a choice is Classic, and keeps its look. */
export const skyModel = (config: Pick<SkyConfig, 'model'>): SkyModel => oneOf(config.model, SKY_MODELS, 'classic');

/** How far (degrees) the sun's path leans from passing straight overhead. */
export const sunTilt = (config: Pick<SkyConfig, 'sunTilt'>): number => number(config.sunTilt, 0, -80, 80);

/** The sun's size, 1: as it really looks. */
export const sunSize = (config: Pick<SkyConfig, 'sunSize'>): number => number(config.sunSize, 1, 0.1, 12);
