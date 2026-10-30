import type { SkyConfig } from '../../types';
import { weatherFromPreset, type WeatherKind, type WeatherSettings } from '../weather';
import { atmosphereCoefficients, eyeAdaptation, GROUND_RADIUS, linearFromHex, SKY_EXPOSURE, skyRadiance, transmittance } from './atmosphere';
import {
    DEFAULT_ATMOSPHERE, DEFAULT_CLOUDS, DEFAULT_NIGHT, DEFAULT_SKY_LIGHT, resolveAtmosphere,
    type SkyAtmosphereSettings, type SkyCloudSettings, type SkyNightSettings,
} from './skySettings';

/**
 * SKY PRESETS
 *
 * Ready-made skies: a whole look (hour, sun path, air, clouds, weather, night and fog) a level starts
 * from and can then change. Applying one keeps what is the level's own (its Sky Light settings, shadow
 * distance and day length). Pure, so level scripts and the editor read the same list.
 */

export type SkyPresetGroup = 'Day' | 'Golden Hour' | 'Night' | 'Weather' | 'Other Worlds';
export const SKY_PRESET_GROUPS: readonly SkyPresetGroup[] = ['Day', 'Golden Hour', 'Night', 'Weather', 'Other Worlds'];

export interface SkyPreset {
    id: string;
    label: string;
    group: SkyPresetGroup;
    hour: number;
    /** Sun path: how far it leans (degrees) and turned round the vertical (a share of a turn). */
    tilt: number;
    azimuth: number;
    sunIntensity: number;
    sunColor?: string;
    sunSize?: number;
    atmosphere?: Partial<SkyAtmosphereSettings>;
    clouds?: Partial<SkyCloudSettings>;
    night?: Partial<SkyNightSettings>;
    weather: WeatherKind;
    /** Overrides on the weather preset's values. */
    weatherValues?: Partial<WeatherSettings>;
    fogDensity: number;
}

/** Full sunlight: a white surface facing it reads about 1. */
const SUN = Math.PI;

export const SKY_PRESETS: readonly SkyPreset[] = [
    { id: 'fair-day', label: 'Fair Day', group: 'Day', hour: 11, tilt: 35, azimuth: 0.1, sunIntensity: SUN, weather: 'clear', weatherValues: { clouds: 0.44 }, fogDensity: 0.0016 },
    { id: 'clear-noon', label: 'Clear Noon', group: 'Day', hour: 12, tilt: 28, azimuth: 0.1, sunIntensity: SUN, weather: 'clear', weatherValues: { clouds: 0 }, fogDensity: 0.0012, atmosphere: { haze: 0.7 } },
    { id: 'morning', label: 'Morning', group: 'Day', hour: 8.4, tilt: 30, azimuth: 0.18, sunIntensity: SUN, weather: 'clear', weatherValues: { clouds: 0.34 }, fogDensity: 0.002, atmosphere: { haze: 1.3 } },
    { id: 'towering-clouds', label: 'Towering Clouds', group: 'Day', hour: 14.6, tilt: 32, azimuth: 0.1, sunIntensity: SUN, weather: 'cloudy', weatherValues: { clouds: 0.6 }, fogDensity: 0.002, clouds: { thickness: 3400, scale: 1.5, detail: 0.65 } },
    { id: 'alpine', label: 'Alpine', group: 'Day', hour: 10.2, tilt: 40, azimuth: 0.28, sunIntensity: SUN * 1.1, weather: 'clear', weatherValues: { clouds: 0.3 }, fogDensity: 0.0008, atmosphere: { rayleigh: 0.72, haze: 0.28 } },

    { id: 'golden-hour', label: 'Golden Hour', group: 'Golden Hour', hour: 16.95, tilt: 22, azimuth: 0.08, sunIntensity: SUN, weather: 'clear', weatherValues: { clouds: 0.4 }, fogDensity: 0.0022, atmosphere: { haze: 1.6 } },
    { id: 'sunset', label: 'Sunset', group: 'Golden Hour', hour: 17.72, tilt: 18, azimuth: 0.08, sunIntensity: SUN, weather: 'clear', weatherValues: { clouds: 0.48 }, fogDensity: 0.0024, atmosphere: { haze: 2 }, clouds: { altitude: 2600, thickness: 1500 } },
    { id: 'dawn', label: 'Dawn', group: 'Golden Hour', hour: 6.22, tilt: 20, azimuth: 0.62, sunIntensity: SUN * 0.9, weather: 'clear', weatherValues: { clouds: 0.34, fog: 0.04 }, fogDensity: 0.0034, atmosphere: { haze: 2.6, hazeGlow: 0.86 } },
    { id: 'blue-hour', label: 'Blue Hour', group: 'Golden Hour', hour: 18.26, tilt: 18, azimuth: 0.08, sunIntensity: SUN, weather: 'clear', weatherValues: { clouds: 0.12 }, fogDensity: 0.0018, night: { stars: 0.5, milkyWay: 0.2 }, atmosphere: { ozone: 1.3 } },

    { id: 'moonlit-night', label: 'Moonlit Night', group: 'Night', hour: 23.2, tilt: 30, azimuth: 0.15, sunIntensity: SUN, weather: 'clear', weatherValues: { clouds: 0.16 }, fogDensity: 0.0012, night: { moonPhase: 0.5, moonSize: 3, moonBrightness: 0.3, milkyWay: 0.45 } },
    { id: 'starry-night', label: 'Starry Night', group: 'Night', hour: 1, tilt: 30, azimuth: 0.15, sunIntensity: SUN, weather: 'clear', weatherValues: { clouds: 0 }, fogDensity: 0.0008, night: { moonPhase: 0.08, moonSize: 2, moonBrightness: 0.06, stars: 1.6, milkyWay: 1.4, glow: '#111d36' } },
    { id: 'crescent-night', label: 'Crescent Night', group: 'Night', hour: 21.4, tilt: 30, azimuth: 0.4, sunIntensity: SUN, weather: 'cloudy', weatherValues: { clouds: 0.3 }, fogDensity: 0.0014, night: { moonPhase: 0.14, moonSize: 3.4, moonBrightness: 0.22, milkyWay: 0.8 } },

    { id: 'overcast', label: 'Overcast', group: 'Weather', hour: 12.5, tilt: 30, azimuth: 0.1, sunIntensity: SUN, weather: 'overcast', fogDensity: 0.003, clouds: { thickness: 2600, density: 1.2, detail: 0.35 } },
    { id: 'rain', label: 'Rain', group: 'Weather', hour: 13.5, tilt: 30, azimuth: 0.1, sunIntensity: SUN, weather: 'rain', fogDensity: 0.0044, clouds: { altitude: 900, thickness: 3000, density: 1.5, detail: 0.3 } },
    { id: 'thunderstorm', label: 'Thunderstorm', group: 'Weather', hour: 16, tilt: 30, azimuth: 0.1, sunIntensity: SUN, weather: 'storm', fogDensity: 0.0052, clouds: { altitude: 800, thickness: 4500, density: 2, detail: 0.45, scale: 1.4 } },
    { id: 'misty-morning', label: 'Misty Morning', group: 'Weather', hour: 7.3, tilt: 25, azimuth: 0.6, sunIntensity: SUN * 0.9, weather: 'fog', weatherValues: { clouds: 0.2, fog: 0.55 }, fogDensity: 0.006, atmosphere: { haze: 5 } },
    { id: 'snowfall', label: 'Snowfall', group: 'Weather', hour: 11.5, tilt: 40, azimuth: 0.1, sunIntensity: SUN, weather: 'snow', fogDensity: 0.005, clouds: { altitude: 1000, thickness: 2600, density: 1.3 }, atmosphere: { ground: '#c9ced6' } },

    { id: 'hazy-desert', label: 'Hazy Desert', group: 'Other Worlds', hour: 14.5, tilt: 16, azimuth: 0.3, sunIntensity: SUN * 1.15, sunColor: '#fff4e0', weather: 'clear', weatherValues: { clouds: 0.04 }, fogDensity: 0.0034, atmosphere: { haze: 8, hazeGlow: 0.72, ground: '#b08a5e' } },
    { id: 'dust-world', label: 'Dust World', group: 'Other Worlds', hour: 11.5, tilt: 25, azimuth: 0.15, sunIntensity: SUN * 0.8, sunSize: 0.7, weather: 'clear', weatherValues: { clouds: 0 }, fogDensity: 0.0026, atmosphere: { rayleigh: 0.4, rayleighTint: '#ff9a5c', haze: 16, hazeGlow: 0.62, ozone: 0, ground: '#8a4a2c' } },
    { id: 'emerald-world', label: 'Emerald World', group: 'Other Worlds', hour: 15.5, tilt: 25, azimuth: 0.4, sunIntensity: SUN, sunColor: '#fff6d8', sunSize: 2.4, weather: 'clear', weatherValues: { clouds: 0.3 }, fogDensity: 0.0018, atmosphere: { rayleigh: 1.1, rayleighTint: '#7dffb0', haze: 1.2, ozone: 0.2, ground: '#2d4a3a' } },
    { id: 'violet-world', label: 'Violet World', group: 'Other Worlds', hour: 16.6, tilt: 20, azimuth: 0.2, sunIntensity: SUN, sunColor: '#ffe6f4', sunSize: 3.2, weather: 'clear', weatherValues: { clouds: 0.22 }, fogDensity: 0.002, atmosphere: { rayleigh: 1.5, rayleighTint: '#d58cff', haze: 1.6, ozone: 0.3, ground: '#3a2c4a' }, night: { glow: '#1c1030' } },
];

export const skyPreset = (id: unknown): SkyPreset | null => SKY_PRESETS.find(preset => preset.id === id) ?? null;

/** A preset from a name: its id or label in any case ("sunset", "Golden Hour"); null for none. */
export const skyPresetFromName = (name: string): SkyPreset | null => {
    const wanted = name.trim().toLowerCase();
    return SKY_PRESETS.find(preset => preset.id === wanted || preset.label.toLowerCase() === wanted) ?? null;
};

/** What a preset sets in a sky's config. */
const presetFields = (preset: SkyPreset): Partial<SkyConfig> => ({
    model: 'atmosphere',
    preset: preset.id,
    timeOfDay: preset.hour,
    sunTilt: preset.tilt,
    azimuth: preset.azimuth,
    sunIntensity: preset.sunIntensity,
    sunColor: preset.sunColor ?? '#ffffff',
    sunSize: preset.sunSize ?? 1,
    fogDensity: preset.fogDensity,
    fogMode: 'sky',
    atmosphere: { ...DEFAULT_ATMOSPHERE, ...preset.atmosphere },
    cloudLayer: { ...DEFAULT_CLOUDS, ...preset.clouds },
    night: { ...DEFAULT_NIGHT, ...preset.night },
    weather: { ...weatherFromPreset(preset.weather), ...preset.weatherValues },
});

/**
 * `config` as `preset` makes it. The quality of the clouds stays as it was set, since that is about the
 * machine and not the look; so do the Sky Light, shadow distance and day length.
 */
export const applySkyPreset = (config: SkyConfig, preset: SkyPreset): SkyConfig => {
    const fields = presetFields(preset);
    const quality = config.cloudLayer?.quality;
    const next: SkyConfig = { ...config, ...fields };
    if (quality && next.cloudLayer) next.cloudLayer = { ...next.cloudLayer, quality };
    if (!next.skyLight) next.skyLight = { ...DEFAULT_SKY_LIGHT };
    return next;
};

/** A new level's sky: this preset, with the Sky Light on. */
export const NEW_SKY_PRESET = 'fair-day';

/** The sky a new Sky Sphere starts as. */
export const newSkyConfig = (): SkyConfig => {
    const base: SkyConfig = {
        timeOfDay: 11, sunIntensity: SUN, ambienceIntensity: 0.5, sunColor: '#ffffff', fogColor: '#8caebf', fogDensity: 0.0016,
        turbidity: 8, rayleigh: 1, mieCoefficient: 0.005, mieDirectionalG: 0.7, inclination: 0.49, azimuth: 0.1,
    };
    return applySkyPreset(base, skyPreset(NEW_SKY_PRESET)!);
};

const same = (a: unknown, b: unknown): boolean => {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-4;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const key of keys) {
            if (!same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
        }
        return true;
    }
    return a === b;
};

/** Whether the sky is still its preset's own (the editor shows it as changed otherwise). Cloud quality does not count. */
export const matchesSkyPreset = (config: SkyConfig): boolean => {
    const preset = skyPreset(config.preset);
    if (!preset) return false;
    const fields = presetFields(preset) as Record<string, unknown>;
    return Object.keys(fields).every(key => {
        const own = (config as unknown as Record<string, unknown>)[key];
        if (key === 'cloudLayer') {
            const { quality: _a, ...theirs } = fields[key] as SkyCloudSettings;
            const { quality: _b, ...ours } = (own ?? {}) as SkyCloudSettings;
            return same(theirs, ours);
        }
        return same(fields[key], own);
    });
};

const SWATCH_ELEVATIONS = [0.72, 0.38, 0.17, 0.05, 0.005];
const SWATCH_TURN_COS = Math.cos(1.2);
const SWATCH_TURN_SIN = Math.sin(1.2);
/** Swatches are small: a little under the viewport's brightness, to keep their colour. */
const SWATCH_EXPOSURE = 0.6;
const _rgb: [number, number, number] = [0, 0, 0];
const _sun = { x: 0, y: 0, z: 0 };
const _view = { x: 0, y: 0, z: 0 };

const displayChannel = (value: number): number => {
    // ACES-like curve, then to sRGB: close enough to what the viewport shows for a swatch.
    const toned = Math.min(1, Math.max(0, (value * (2.51 * value + 0.03)) / (value * (2.43 * value + 0.59) + 0.14)));
    return Math.round(255 * (toned <= 0.0031308 ? toned * 12.92 : 1.055 * toned ** (1 / 2.4) - 0.055));
};

/**
 * A CSS gradient of a preset's sky, looking off to one side of the sun (straight at it, the horizon only
 * glares), from high up down to the horizon. Night has almost no sky of its own, so it shows the glow of
 * the night air.
 */
export const skyPresetSwatch = (preset: SkyPreset): string => {
    const atmosphere = resolveAtmosphere({ ...DEFAULT_ATMOSPHERE, ...preset.atmosphere });
    const co = atmosphereCoefficients(atmosphere);
    const theta = ((preset.hour - 6) / 24) * Math.PI * 2;
    const tilt = (preset.tilt * Math.PI) / 180;
    _sun.x = Math.cos(theta);
    _sun.y = Math.sin(theta) * Math.cos(tilt);
    _sun.z = Math.sin(theta) * Math.sin(tilt);
    const across = Math.hypot(_sun.x, _sun.z) || 1;
    const sideX = (_sun.x * SWATCH_TURN_COS - _sun.z * SWATCH_TURN_SIN) / across;
    const sideZ = (_sun.x * SWATCH_TURN_SIN + _sun.z * SWATCH_TURN_COS) / across;
    const glow = linearFromHex(preset.night?.glow ?? DEFAULT_NIGHT.glow);
    const stops = SWATCH_ELEVATIONS.map((y, index) => {
        const side = Math.sqrt(1 - y * y);
        _view.x = sideX * side;
        _view.y = y;
        _view.z = sideZ * side;
        skyRadiance(co, _view, _sun, 0.002, _rgb);
        const scale = preset.sunIntensity * atmosphere.brightness * SKY_EXPOSURE * eyeAdaptation(_sun.y) * SWATCH_EXPOSURE;
        const [r, g, b] = [0, 1, 2].map(c => displayChannel(_rgb[c] * scale + glow[c] * (_sun.y < 0 ? 4.8 : 0)));
        return `rgb(${r},${g},${b}) ${Math.round((index / (SWATCH_ELEVATIONS.length - 1)) * 100)}%`;
    });
    return `linear-gradient(to bottom, ${stops.join(', ')})`;
};

/** The sunlight's colour at ground level for a preset (for checks). */
export const presetSunlight = (preset: SkyPreset, sunY: number, out: [number, number, number]): [number, number, number] =>
    transmittance(atmosphereCoefficients(resolveAtmosphere({ ...DEFAULT_ATMOSPHERE, ...preset.atmosphere })), GROUND_RADIUS + 0.002, sunY, out);
