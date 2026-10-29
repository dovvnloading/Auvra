import { SURFACES, type SurfaceKind } from './surfaces';

/**
 * WEATHER AND TIME OF DAY
 *
 * The world's clock and weather: the hour, which moves through a day of a set length in play, and
 * the weather (clouds, rain, snow, fog, wind and lightning), which blends to a new state over a
 * transition. Ground gets wet while it rains and dries after; snow settles and melts. The sky reads
 * all of it each frame for its light, fog, clouds, stars and precipitation, and level scripts and
 * gameplay scripts change it. Pure: no rendering here.
 */

export type WeatherKind = 'clear' | 'cloudy' | 'overcast' | 'fog' | 'rain' | 'storm' | 'snow' | 'blizzard';

export const WEATHER_KINDS: readonly WeatherKind[] = ['clear', 'cloudy', 'overcast', 'fog', 'rain', 'storm', 'snow', 'blizzard'];

export const WEATHER_LABELS: Record<WeatherKind, string> = {
    clear: 'Clear',
    cloudy: 'Cloudy',
    overcast: 'Overcast',
    fog: 'Fog',
    rain: 'Rain',
    storm: 'Thunderstorm',
    snow: 'Snow',
    blizzard: 'Blizzard',
};

/** What the weather is doing. */
export interface WeatherState {
    /** How much of the sky the clouds cover, 0-1. */
    clouds: number;
    /** Rain and snow, 0 (none) to 1 (as heavy as it gets). */
    rain: number;
    snow: number;
    /** Mist on top of the sky's own fog, 0-1: at 1 you see about 40 m. */
    fog: number;
    /** Wind speed, m/s, and the compass bearing it blows toward, degrees (0: +Z, 90: +X). */
    wind: number;
    windDirection: number;
    /** Lightning strikes a minute. */
    lightning: number;
}

export const WEATHER_FIELDS: readonly (keyof WeatherState)[] = ['clouds', 'rain', 'snow', 'fog', 'wind', 'windDirection', 'lightning'];

export const WEATHER_LIMITS: Record<keyof WeatherState, readonly [number, number]> = {
    clouds: [0, 1],
    rain: [0, 1],
    snow: [0, 1],
    fog: [0, 1],
    wind: [0, 40],
    windDirection: [0, 360],
    lightning: [0, 30],
};

export const WEATHER_PRESETS: Record<WeatherKind, WeatherState> = {
    clear: { clouds: 0.12, rain: 0, snow: 0, fog: 0, wind: 2, windDirection: 60, lightning: 0 },
    cloudy: { clouds: 0.5, rain: 0, snow: 0, fog: 0.05, wind: 4, windDirection: 60, lightning: 0 },
    overcast: { clouds: 0.92, rain: 0, snow: 0, fog: 0.15, wind: 5, windDirection: 60, lightning: 0 },
    fog: { clouds: 0.7, rain: 0, snow: 0, fog: 0.85, wind: 0.5, windDirection: 60, lightning: 0 },
    rain: { clouds: 0.88, rain: 0.55, snow: 0, fog: 0.12, wind: 5, windDirection: 60, lightning: 0 },
    storm: { clouds: 1, rain: 1, snow: 0, fog: 0.25, wind: 13, windDirection: 60, lightning: 8 },
    snow: { clouds: 0.85, rain: 0, snow: 0.55, fog: 0.2, wind: 2, windDirection: 60, lightning: 0 },
    blizzard: { clouds: 1, rain: 0, snow: 1, fog: 0.7, wind: 15, windDirection: 60, lightning: 0 },
};

/** No weather at all: a sky saved before there was weather keeps its look. */
export const NO_WEATHER: Readonly<WeatherState> = { clouds: 0, rain: 0, snow: 0, fog: 0, wind: 0, windDirection: 0, lightning: 0 };

/** A sky's weather as saved: the preset it started from and its values, which may differ from it. */
export interface WeatherSettings extends WeatherState {
    preset: WeatherKind;
}

export const isWeatherKind = (value: unknown): value is WeatherKind =>
    typeof value === 'string' && (WEATHER_KINDS as readonly string[]).includes(value);

export const weatherFromPreset = (kind: WeatherKind): WeatherSettings => ({ preset: kind, ...WEATHER_PRESETS[kind] });

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const smoothstep = (value: number, from: number, to: number) => {
    const t = clamp01((value - from) / (to - from));
    return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export const wrapDegrees = (degrees: number): number => ((degrees % 360) + 360) % 360;

/** Saved weather made whole and in range; null when there is none (a sky from before weather). */
export const sanitizeWeather = (value: unknown): WeatherSettings | null => {
    if (!value || typeof value !== 'object') return null;
    const source = value as Record<string, unknown>;
    const preset = isWeatherKind(source.preset) ? source.preset : 'clear';
    const out = weatherFromPreset(preset);
    for (const field of WEATHER_FIELDS) {
        const raw = source[field];
        if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
        const [min, max] = WEATHER_LIMITS[field];
        out[field] = field === 'windDirection' ? wrapDegrees(raw) : Math.min(max, Math.max(min, raw));
    }
    return out;
};

/** Whether the values are still their preset's own (the editor shows "Custom" otherwise). */
export const matchesPreset = (settings: WeatherSettings): boolean =>
    WEATHER_FIELDS.every(field => Math.abs(settings[field] - WEATHER_PRESETS[settings.preset][field]) < 1e-6);

/** The weather `t` (0-1) of the way from one state to another; the wind turns the short way round. */
export const blendWeather = (from: WeatherState, to: WeatherState, t: number, out: WeatherState): WeatherState => {
    const k = clamp01(t);
    out.clouds = mix(from.clouds, to.clouds, k);
    out.rain = mix(from.rain, to.rain, k);
    out.snow = mix(from.snow, to.snow, k);
    out.fog = mix(from.fog, to.fog, k);
    out.wind = mix(from.wind, to.wind, k);
    out.lightning = mix(from.lightning, to.lightning, k);
    const turn = ((to.windDirection - from.windDirection + 540) % 360) - 180;
    out.windDirection = wrapDegrees(from.windDirection + turn * k);
    return out;
};

/** Copies a weather's values (and nothing else, such as a preset's name) into `out`. */
export const copyWeather = (from: WeatherState, out: WeatherState): WeatherState => {
    for (const field of WEATHER_FIELDS) out[field] = from[field];
    return out;
};

/** The wind as a world velocity, m/s: x and z. */
export const windVelocity = (weather: WeatherState): [number, number] => {
    const bearing = (weather.windDirection * Math.PI) / 180;
    return [Math.sin(bearing) * weather.wind, Math.cos(bearing) * weather.wind];
};

// ---------------------------------------------------------------------------
// The sun and the light

/** Hours 0-24, wrapped. */
export const wrapHours = (hours: number): number => ((hours % 24) + 24) % 24;

/** Hours the clock moves a real second in a day `minutes` long; 0 (time stands still) for 0 or less. */
export const hoursPerSecond = (minutes: number): number => (minutes > 0 && Number.isFinite(minutes) ? 24 / (minutes * 60) : 0);

/** "14:05" for 14.08 hours. */
export const formatHours = (hours: number): string => {
    const minutes = Math.floor(wrapHours(hours) * 60 + 1e-6);
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
};

/**
 * Unit vector toward the sun at `hours`: it rises at 6, stands overhead at 12 and sets at 18, its
 * path turned round the vertical by `azimuth` (a share of a full turn).
 */
export const sunDirection = (hours: number, azimuth: number, out: { x: number; y: number; z: number }) => {
    const theta = ((hours - 6) / 24) * Math.PI * 2;
    const turn = azimuth * Math.PI * 2;
    const x = Math.cos(theta);
    out.x = x * Math.cos(turn);
    out.y = Math.sin(theta);
    out.z = -x * Math.sin(turn);
    return out;
};

/** How far up the sun is (its direction's height, -1 to 1) at `hours`. */
export const sunHeight = (hours: number): number => Math.sin(((hours - 6) / 24) * Math.PI * 2);

/** How much the sun lights the scene for its height: none below the horizon, full a little above it. */
export const sunDaylight = (height: number): number => smoothstep(height, -0.05, 0.15);

/** How stormy it is, 0-1: what dims the day under the weather. */
export const storminess = (weather: WeatherState): number =>
    Math.max(weather.fog, Math.max(weather.rain, weather.snow) * Math.max(0.5, weather.clouds));

/** Linear RGB. */
export type Rgb = [number, number, number];

/** Everything the sky lights the scene with, for an hour and weather (see skyLighting). */
export interface SkyLighting {
    sun: { x: number; y: number; z: number };
    /** The sun's own light, 0-1, before weather (0 below the horizon). */
    daylight: number;
    /** How light it is after clouds and weather, 0-1: what headlights in Auto and similar react to. */
    light: number;
    /** Multipliers on the sky's Sun Intensity: the sun's, and the moon's opposite it. */
    sunIntensity: number;
    moonIntensity: number;
    /** Tint on the sky's Sun Colour: warm near the horizon. */
    sunTint: Rgb;
    /** Multiplier on the sky's Ambience, and the fill's colours from above and below. */
    ambient: number;
    skyFill: Rgb;
    groundFill: Rgb;
    /** The colour of the sky at the horizon, which fog takes in Sky mode and clouds fade into. */
    horizon: Rgb;
    /** Weather fog: its colour and how much of the fog it makes (0-1), and density added (FogExp2). */
    weatherFog: Rgb;
    weatherFogAmount: number;
    fogDensity: number;
    /** How much the stars and moon show, 0-1. */
    stars: number;
}

export const createSkyLighting = (): SkyLighting => ({
    sun: { x: 0, y: 1, z: 0 },
    daylight: 1,
    light: 1,
    sunIntensity: 1,
    moonIntensity: 0,
    sunTint: [1, 1, 1],
    ambient: 1,
    skyFill: [0, 0, 0],
    groundFill: [0, 0, 0],
    horizon: [0, 0, 0],
    weatherFog: [0, 0, 0],
    weatherFogAmount: 0,
    fogDensity: 0,
    stars: 0,
});

const srgbChannel = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
const linear = (hex: number): Rgb => [srgbChannel(((hex >> 16) & 255) / 255), srgbChannel(((hex >> 8) & 255) / 255), srgbChannel((hex & 255) / 255)];
const mixRgb = (a: Rgb, b: Rgb, t: number, out: Rgb): Rgb => {
    out[0] = mix(a[0], b[0], t);
    out[1] = mix(a[1], b[1], t);
    out[2] = mix(a[2], b[2], t);
    return out;
};

const WHITE: Rgb = [1, 1, 1];
const SUNSET_SUN = linear(0xffa45c);
const DAY_SKY_FILL = linear(0xcfe0ff);
const NIGHT_SKY_FILL = linear(0x7f95cc);
const OVERCAST_FILL = linear(0xc3c8d0);
const GROUND_FILL = linear(0x5a4a3a);
const NIGHT_GROUND_FILL = linear(0x2c2a33);
const DAY_HORIZON = linear(0xb4c9de);
const SUNSET_HORIZON = linear(0xe39a66);
const NIGHT_HORIZON = linear(0x0d1424);
const WEATHER_GREY = linear(0xa3abb5);
const NIGHT_GREY = linear(0x10141b);
/** Below this much moonlight, an ambient floor at night. */
const NIGHT_AMBIENT = 0.38;
/** FogExp2 density added at full mist, and per unit of rain and snow. */
const MIST_DENSITY = 0.04;
const RAIN_DENSITY = 0.004;
const SNOW_DENSITY = 0.01;

const _tint: Rgb = [0, 0, 0];

/** Fills `out` with the sky's light at `hours` under `weather`, its sun path turned by `azimuth`. */
export const skyLighting = (hours: number, azimuth: number, weather: WeatherState, out: SkyLighting): SkyLighting => {
    sunDirection(hours, azimuth, out.sun);
    const height = out.sun.y;
    const daylight = sunDaylight(height);
    const stormy = storminess(weather);
    const precipitation = Math.max(weather.rain, weather.snow);
    out.daylight = daylight;
    out.light = daylight * (1 - 0.8 * stormy);

    // Clouds and mist block the sun; a storm darkens what is left.
    const direct = Math.max(0.04, (1 - 0.8 * smoothstep(weather.clouds, 0.35, 1) - 0.35 * weather.fog) * (1 - 0.3 * precipitation));
    out.sunIntensity = daylight * direct;
    out.moonIntensity = (1 - daylight) * (1 - 0.85 * weather.clouds);
    mixRgb(SUNSET_SUN, WHITE, smoothstep(height, 0.02, 0.32), out.sunTint);

    // The sky's fill: lower at night (twilight lingers), stronger under cloud, where the sky scatters the sun.
    const twilight = smoothstep(height, -0.25, 0.1);
    out.ambient = mix(NIGHT_AMBIENT, 1, twilight) * (1 + 0.9 * (1 - direct) * daylight) * (1 - 0.4 * precipitation * weather.clouds);
    mixRgb(NIGHT_SKY_FILL, DAY_SKY_FILL, twilight, out.skyFill);
    mixRgb(out.skyFill, OVERCAST_FILL, smoothstep(weather.clouds, 0.4, 1) * 0.8, out.skyFill);
    mixRgb(NIGHT_GROUND_FILL, GROUND_FILL, twilight, out.groundFill);

    // The horizon: blue by day, orange round sunrise and sunset, dark blue at night; grey under weather.
    const sunset = 1 - smoothstep(Math.abs(height - 0.03), 0, 0.28);
    mixRgb(DAY_HORIZON, SUNSET_HORIZON, sunset, out.horizon);
    mixRgb(out.horizon, NIGHT_HORIZON, 1 - smoothstep(height, -0.22, 0.04), out.horizon);
    // The grey of the weather: lit by the day, darker the heavier the rain or snow.
    mixRgb(NIGHT_GREY, WEATHER_GREY, twilight, _tint);
    const gloom = 1 - 0.6 * precipitation * weather.clouds;
    _tint[0] *= gloom;
    _tint[1] *= gloom;
    _tint[2] *= gloom;
    const grey = clamp01(weather.clouds * 0.75 + weather.fog * 0.6) * (0.4 + 0.6 * clamp01(weather.clouds + weather.fog));
    mixRgb(out.horizon, _tint, grey, out.horizon);

    // Weather fog is the grey of the light through it.
    out.weatherFog[0] = _tint[0];
    out.weatherFog[1] = _tint[1];
    out.weatherFog[2] = _tint[2];
    out.weatherFogAmount = clamp01(weather.fog * 1.4 + precipitation * 0.5);
    out.fogDensity = weather.fog * MIST_DENSITY + weather.rain * RAIN_DENSITY + weather.snow * SNOW_DENSITY;

    out.stars = (1 - smoothstep(height, -0.2, 0.02)) * (1 - weather.clouds) ** 2 * (1 - weather.fog);
    return out;
};

// ---------------------------------------------------------------------------
// Lightning

/** A lightning strike, as long as it is remembered. */
export interface LightningStrike {
    id: number;
    /** Seconds since it struck. */
    age: number;
    /** Compass bearing to it, radians (0: +Z), and how far away it is, m. */
    bearing: number;
    distance: number;
    /** 0-1, for the shape of its bolt. */
    seed: number;
}

/** Speed of sound, m/s: how long thunder takes. */
export const SOUND_SPEED = 343;

/** A strike's brightness `age` seconds after it: a flash, a flicker, a second flash, a fade. */
export const flashEnvelope = (age: number): number => {
    if (age < 0) return 0;
    if (age < 0.06) return 1;
    if (age < 0.12) return 0.25;
    if (age < 0.2) return 0.85;
    return 0.85 * Math.exp(-(age - 0.2) * 9);
};

/** How long a strike counts as flashing, s. */
export const FLASH_TIME = 0.8;

// ---------------------------------------------------------------------------
// The clock

/** Seconds of rain it takes heavy rain to soak dry ground, and the slowest drying, s. */
const SOAK_TIME = 45;
const DRY_TIME = 240;
/** Seconds of heavy snow for snow to settle fully, and for it to melt with none falling. */
const SETTLE_TIME = 90;
const MELT_TIME = 900;

/** Wetness and settled snow the ground holds in steady weather. */
export const steadyWetness = (weather: WeatherState): number => clamp01(weather.rain * 1.6);
export const steadySnowCover = (weather: WeatherState): number => clamp01(weather.snow * 1.5);

/**
 * The world's hour and weather. One instance (worldClock) is shared by the sky, what reacts to the
 * weather and the scripts that change it; the sky resets it from the level's sky as it loads.
 */
export class WorldClock {
    /** Hours, 0-24. */
    hours = 14;
    /** Minutes in a day of play; 0: time stands still. */
    dayLength = 0;
    /** The weather now. */
    readonly weather: WeatherState = { ...NO_WEATHER };
    /** The preset the weather is heading for, or null for none (custom values, or none at all). */
    preset: WeatherKind | null = null;
    /** How wet the ground is, and how much snow lies on it, 0-1. */
    wetness = 0;
    snowCover = 0;
    /** The lightning's brightness now, 0-1. */
    flash = 0;
    /** The last strike, while it is flashing or its thunder may still be coming. */
    strike: LightningStrike | null = null;
    /** Bumps when something sets the clock or weather at once, so the sky shows it. */
    version = 0;

    private readonly from: WeatherState = { ...NO_WEATHER };
    private readonly to: WeatherState = { ...NO_WEATHER };
    private transition = 0;
    private elapsed = 0;
    private untilStrike = Infinity;
    private strikes = 0;

    /** Starts over: this hour, day length and weather, the ground as wet and snowy as that weather leaves it. */
    reset(hours: number, dayLength: number, weather: WeatherState | null, preset: WeatherKind | null): void {
        this.hours = wrapHours(Number.isFinite(hours) ? hours : 14);
        this.dayLength = Number.isFinite(dayLength) ? Math.max(0, dayLength) : 0;
        copyWeather(weather ?? NO_WEATHER, this.weather);
        copyWeather(this.weather, this.from);
        copyWeather(this.weather, this.to);
        this.preset = preset;
        this.transition = 0;
        this.elapsed = 0;
        this.wetness = steadyWetness(this.weather);
        this.snowCover = steadySnowCover(this.weather);
        this.flash = 0;
        this.strike = null;
        this.untilStrike = Infinity;
        this.version++;
    }

    setHours(hours: number): void {
        if (!Number.isFinite(hours)) return;
        this.hours = wrapHours(hours);
        this.version++;
    }

    setDayLength(minutes: number): void {
        if (!Number.isFinite(minutes)) return;
        this.dayLength = Math.max(0, minutes);
    }

    /** Heads for `weather` over `seconds` (at once for 0); `preset` names it, when it is one. */
    setWeather(weather: WeatherState, seconds: number, preset: WeatherKind | null): void {
        copyWeather(this.weather, this.from);
        copyWeather(weather, this.to);
        this.preset = preset;
        this.transition = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
        this.elapsed = 0;
        if (this.transition === 0) {
            copyWeather(weather, this.weather);
            this.version++;
        }
        if (this.weather.lightning <= 0 && weather.lightning <= 0) this.untilStrike = Infinity;
    }

    /** Whether the weather is still changing. */
    get changing(): boolean {
        return this.elapsed < this.transition;
    }

    /** Moves time, the weather's transition, the ground's wetness and snow and the lightning on by `dt` seconds. */
    step(dt: number, random: () => number = Math.random): void {
        if (!(dt > 0) || !Number.isFinite(dt)) return;
        this.hours = wrapHours(this.hours + dt * hoursPerSecond(this.dayLength));
        if (this.elapsed < this.transition) {
            this.elapsed = Math.min(this.transition, this.elapsed + dt);
            const t = this.elapsed / this.transition;
            blendWeather(this.from, this.to, t * t * (3 - 2 * t), this.weather);
        }
        const weather = this.weather;

        // Rain soaks the ground and it dries after, faster in sun and wind; snow settles and melts.
        const wet = steadyWetness(weather);
        if (this.wetness < wet) this.wetness = Math.min(wet, this.wetness + (dt / SOAK_TIME) * (0.3 + weather.rain));
        else {
            const drying = (1 + 2 * sunDaylight(sunHeight(this.hours)) + weather.wind / 8) / DRY_TIME;
            this.wetness = Math.max(wet, this.wetness - dt * drying);
        }
        const snow = steadySnowCover(weather);
        if (this.snowCover < snow) this.snowCover = Math.min(snow, this.snowCover + (dt / SETTLE_TIME) * (0.3 + weather.snow));
        else this.snowCover = Math.max(snow, this.snowCover - (dt / MELT_TIME) * (1 + 4 * weather.rain));

        // Lightning: strikes at random, as often as the weather says.
        if (this.strike) {
            this.strike.age += dt;
            if (this.strike.age > FLASH_TIME + this.strike.distance / SOUND_SPEED + 1) this.strike = null;
        }
        const rate = weather.lightning / 60;
        if (rate > 0) {
            if (!Number.isFinite(this.untilStrike)) this.untilStrike = -Math.log(1 - random() * 0.999) / rate;
            this.untilStrike -= dt;
            if (this.untilStrike <= 0) {
                const near = random();
                this.strike = { id: ++this.strikes, age: 0, bearing: random() * Math.PI * 2, distance: 250 + near ** 0.7 * 2750, seed: random() };
                this.untilStrike = -Math.log(1 - random() * 0.999) / rate;
            }
        } else this.untilStrike = Infinity;
        const strike = this.strike;
        this.flash = strike && strike.age < FLASH_TIME ? flashEnvelope(strike.age) * (0.35 + 0.65 * Math.min(1, 700 / strike.distance)) : 0;
    }

    /** The sky's light now (see skyLighting). */
    lighting(azimuth: number, out: SkyLighting): SkyLighting {
        return skyLighting(this.hours, azimuth, this.weather, out);
    }
}

export const worldClock = new WorldClock();

/** A weather preset from a name: its id or label in any case ("rain", "Thunderstorm"), or "storm"; null for none. */
export const weatherKindFromName = (name: string): WeatherKind | null => {
    const wanted = name.trim().toLowerCase();
    if (isWeatherKind(wanted)) return wanted;
    return WEATHER_KINDS.find(kind => WEATHER_LABELS[kind].toLowerCase() === wanted) ?? null;
};

/** The world's hour, how light it is after the weather and whether it is night (level scripts and scripts). */
export const worldTime = (): { hours: number; light: number; night: boolean } => {
    const daylight = sunDaylight(sunHeight(worldClock.hours));
    return { hours: worldClock.hours, light: daylight * (1 - 0.8 * storminess(worldClock.weather)), night: daylight < 0.2 };
};

/** Sets the world's hour and/or how long a day takes. */
export const setWorldTime = (change: { hours?: number; dayLength?: number }): void => {
    if (change.hours !== undefined) worldClock.setHours(change.hours);
    if (change.dayLength !== undefined) worldClock.setDayLength(change.dayLength);
};

/** Heads for the weather preset named `name` over `seconds`; false for a name that is no preset. */
export const setWorldWeather = (name: string, seconds: number): boolean => {
    const kind = weatherKindFromName(name);
    if (!kind) return false;
    worldClock.setWeather(WEATHER_PRESETS[kind], seconds, kind);
    return true;
};

/** The weather now, as level scripts and scripts read it. */
export const worldWeather = () => ({
    preset: worldClock.preset ?? '',
    clouds: worldClock.weather.clouds,
    rain: worldClock.weather.rain,
    snow: worldClock.weather.snow,
    fog: worldClock.weather.fog,
    wind: worldClock.weather.wind,
    wetness: worldClock.wetness,
    snowCover: worldClock.snowCover,
});

// ---------------------------------------------------------------------------
// Tyres in the weather

/** What a fully wet road keeps of its grip; loose ground less affected. */
const WET_ROAD_GRIP = 0.7;
const WET_LOOSE_GRIP = 0.85;

/**
 * Grip on `surface` as a share of its dry grip, when the ground is `wetness` wet and has
 * `snowCover` snow on it: a wet road holds about 70%; under settled snow, about what the Snow
 * surface does. Snow, ice and water are what they are already.
 */
export const weatherGrip = (surface: SurfaceKind, wetness: number, snowCover: number): number => {
    if (surface === 'snow' || surface === 'ice' || surface === 'water') return 1;
    const spec = SURFACES[surface];
    const wetGrip = spec.loose ? WET_LOOSE_GRIP : WET_ROAD_GRIP;
    const wet = 1 - (1 - wetGrip) * clamp01(wetness);
    const underSnow = Math.min(wet, SURFACES.snow.grip / Math.max(0.05, spec.grip));
    return mix(wet, underSnow, clamp01(snowCover));
};
