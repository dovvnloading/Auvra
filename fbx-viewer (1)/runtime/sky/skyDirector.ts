import type { SkyConfig } from '../../types';
import { WEATHER_PRESETS, worldClock, wrapHours } from '../weather';
import { skyPreset, skyPresetFromName, type SkyPreset } from './skyPresets';
import {
    DEFAULT_ATMOSPHERE, DEFAULT_CLOUDS, DEFAULT_NIGHT, hexColour, resolveAtmosphere, resolveClouds, resolveNight, sunSize, sunTilt,
    type SkyAtmosphereSettings, type SkyCloudSettings, type SkyNightSettings,
} from './skySettings';

/**
 * THE SKY'S LOOK, AS IT CHANGES
 *
 * Everything a preset sets, in one value that can be blended, so a level can head from one sky to another
 * in play: a clear morning that clouds over into a storm over a minute. The level's own sky is where it
 * starts; level scripts and gameplay scripts say where it goes. Pure, but for the one director the sky reads.
 */

export interface SkyLook {
    atmosphere: SkyAtmosphereSettings;
    clouds: SkyCloudSettings;
    night: SkyNightSettings;
    tilt: number;
    azimuth: number;
    sunIntensity: number;
    sunColor: string;
    sunSize: number;
    fogDensity: number;
}

export const skyLookOf = (config: SkyConfig): SkyLook => ({
    atmosphere: resolveAtmosphere(config.atmosphere),
    clouds: resolveClouds(config.cloudLayer),
    night: resolveNight(config.night),
    tilt: sunTilt(config),
    azimuth: config.azimuth,
    sunIntensity: config.sunIntensity,
    sunColor: hexColour(config.sunColor, '#ffffff'),
    sunSize: sunSize(config),
    fogDensity: config.fogDensity,
});

/** What a preset's sky looks like, its clouds drawn at `quality`: that is the machine's, not the look's. */
export const skyLookOfPreset = (preset: SkyPreset, quality: SkyCloudSettings['quality']): SkyLook => ({
    atmosphere: resolveAtmosphere({ ...DEFAULT_ATMOSPHERE, ...preset.atmosphere }),
    clouds: resolveClouds({ ...DEFAULT_CLOUDS, ...preset.clouds, quality }),
    night: resolveNight({ ...DEFAULT_NIGHT, ...preset.night }),
    tilt: preset.tilt,
    azimuth: preset.azimuth,
    sunIntensity: preset.sunIntensity,
    sunColor: preset.sunColor ?? '#ffffff',
    sunSize: preset.sunSize ?? 1,
    fogDensity: preset.fogDensity,
});

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

const channel = (hex: string, shift: number): number => (parseInt(hex.slice(1), 16) >> shift) & 255;

/** Between two "#rrggbb" colours. */
export const mixHex = (a: string, b: string, t: number): string => {
    const value = (shift: number) => Math.round(mix(channel(a, shift), channel(b, shift), t));
    return `#${((value(16) << 16) | (value(8) << 8) | value(0)).toString(16).padStart(6, '0')}`;
};

/** `t` (0-1) of the way from one look to another. The sun's path turns the short way round. */
export const blendSkyLook = (from: SkyLook, to: SkyLook, t: number): SkyLook => {
    const turn = ((to.azimuth - from.azimuth + 1.5) % 1) - 0.5;
    return {
        atmosphere: {
            rayleigh: mix(from.atmosphere.rayleigh, to.atmosphere.rayleigh, t),
            rayleighTint: mixHex(from.atmosphere.rayleighTint, to.atmosphere.rayleighTint, t),
            haze: mix(from.atmosphere.haze, to.atmosphere.haze, t),
            hazeGlow: mix(from.atmosphere.hazeGlow, to.atmosphere.hazeGlow, t),
            ozone: mix(from.atmosphere.ozone, to.atmosphere.ozone, t),
            ground: mixHex(from.atmosphere.ground, to.atmosphere.ground, t),
            brightness: mix(from.atmosphere.brightness, to.atmosphere.brightness, t),
        },
        clouds: {
            quality: to.clouds.quality,
            altitude: mix(from.clouds.altitude, to.clouds.altitude, t),
            thickness: mix(from.clouds.thickness, to.clouds.thickness, t),
            density: mix(from.clouds.density, to.clouds.density, t),
            detail: mix(from.clouds.detail, to.clouds.detail, t),
            scale: mix(from.clouds.scale, to.clouds.scale, t),
            shadows: mix(from.clouds.shadows, to.clouds.shadows, t),
        },
        night: {
            moonPhase: mix(from.night.moonPhase, to.night.moonPhase, t),
            moonSize: mix(from.night.moonSize, to.night.moonSize, t),
            moonBrightness: mix(from.night.moonBrightness, to.night.moonBrightness, t),
            stars: mix(from.night.stars, to.night.stars, t),
            milkyWay: mix(from.night.milkyWay, to.night.milkyWay, t),
            glow: mixHex(from.night.glow, to.night.glow, t),
        },
        tilt: mix(from.tilt, to.tilt, t),
        azimuth: from.azimuth + turn * t,
        sunIntensity: mix(from.sunIntensity, to.sunIntensity, t),
        sunColor: mixHex(from.sunColor, to.sunColor, t),
        sunSize: mix(from.sunSize, to.sunSize, t),
        fogDensity: mix(from.fogDensity, to.fogDensity, t),
    };
};

/** Hours `t` (0-1) of the way between two hours, forward round the clock. */
export const blendHours = (from: number, to: number, t: number): number => {
    const ahead = ((to - from) % 24 + 24) % 24;
    return wrapHours(from + ahead * t);
};

class SkyDirector {
    private target: SkyPreset | null = null;
    private arrival: SkyLook | null = null;
    private from: SkyLook | null = null;
    private seconds = 0;
    private elapsed = 0;
    private hourFrom = 0;
    private hourTo: number | null = null;
    private now: SkyLook | null = null;

    /** Back to the level's own sky. */
    reset(): void {
        this.target = null;
        this.arrival = null;
        this.from = null;
        this.seconds = 0;
        this.elapsed = 0;
        this.hourTo = null;
        this.now = null;
    }

    /** Heads for `preset` over `seconds` (0: at once), its hour too when `withHour`. */
    head(preset: SkyPreset, seconds: number, withHour: boolean): void {
        this.from = this.now;
        this.target = preset;
        this.arrival = null;
        this.seconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
        this.elapsed = 0;
        this.hourFrom = worldClock.hours;
        this.hourTo = withHour ? preset.hour : null;
        worldClock.setWeather({ ...WEATHER_PRESETS[preset.weather], ...preset.weatherValues }, this.seconds, preset.weather);
    }

    get active(): boolean {
        return this.target !== null;
    }

    /** Moves on by `dt` and returns the look now: the level's own (`base`) until told otherwise. */
    step(base: SkyLook, dt: number): SkyLook {
        const target = this.target;
        if (!target) {
            this.now = base;
            return base;
        }
        if (this.arrival?.clouds.quality !== base.clouds.quality) this.arrival = skyLookOfPreset(target, base.clouds.quality);
        const to = this.arrival;
        const from = this.from ?? base;
        if (this.seconds <= 0 || this.elapsed >= this.seconds) {
            if (this.hourTo !== null) {
                worldClock.setHours(this.hourTo);
                this.hourTo = null;
            }
            this.now = to;
            return to;
        }
        this.elapsed = Math.min(this.seconds, this.elapsed + Math.max(0, dt));
        const k = this.elapsed / this.seconds;
        const t = k * k * (3 - 2 * k);
        if (this.hourTo !== null) worldClock.setHours(blendHours(this.hourFrom, this.hourTo, t));
        this.now = blendSkyLook(from, to, t);
        return this.now;
    }
}

export const skyDirector = new SkyDirector();

/** Heads for the sky preset named `name` over `seconds`, its hour too when `withHour`; false for a name that is no preset. */
export const setWorldSkyPreset = (name: string, seconds: number, withHour = false): boolean => {
    const preset = skyPresetFromName(name) ?? skyPreset(name);
    if (!preset) return false;
    skyDirector.head(preset, seconds, withHour);
    return true;
};
