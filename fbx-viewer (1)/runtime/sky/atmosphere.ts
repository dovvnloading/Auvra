import type { Rgb } from '../weather';
import type { SkyAtmosphereSettings } from './skySettings';

/**
 * THE ATMOSPHERE, ON THE CPU
 *
 * A planet's air as scattering and absorbing layers, and what it does to light. The GPU draws the sky
 * from the same coefficients (components/Environment/sky/atmosphereShaders.ts); this copy gives what the
 * rest of the engine needs without reading pixels back: the colour of the sunlight that reaches the
 * ground, the colour of the horizon for fog, a soft average of the sky for clouds and the picture on a
 * preset's swatch. Distances are kilometres, scattering per kilometre, and light is per unit of sunlight
 * above the atmosphere, so a white surface facing the sun reads 1/pi. Pure.
 */

/** Earth's radius and the top of its air, km. */
export const GROUND_RADIUS = 6360;
export const TOP_RADIUS = 6460;

/** Scale heights: how fast the air and the haze thin out with height, km. */
export const RAYLEIGH_HEIGHT = 8;
export const MIE_HEIGHT = 1.2;
/** Where the ozone layer peaks, and half its depth, km. */
export const OZONE_CENTRE = 25;
export const OZONE_HALF_WIDTH = 15;

/** Earth's scattering at sea level, per km, red to blue. */
const RAYLEIGH_SCATTER: Rgb = [0.005802, 0.013558, 0.0331];
const MIE_SCATTER = 0.003996;
const MIE_ABSORB = 0.00044;
const OZONE_ABSORB: Rgb = [0.00065, 0.001881, 0.000085];

/**
 * The sky's light against the sun's. A camera's picture of a bright day lifts the sky well above where a
 * strict ratio to sunlit ground would put it, and shade with it: this keeps the air's own colours but sets
 * how bright the sky reads, and so how much light the Sky Light gives, at about a fifth of direct sun.
 */
export const SKY_EXPOSURE = 2.4;

const smooth = (edge0: number, edge1: number, x: number): number => {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
};

/**
 * How far the eye (or a camera) opens up as the sun sinks, for its height (the sun's direction's y). Daylight
 * falls about a thousandfold from noon to the end of twilight, and we hardly notice: without this, a sunset is
 * a dark picture and the blue hour a black one. Full day is 1.
 */
export const eyeAdaptation = (sunY: number): number =>
    1 + 3.2 * (1 - smooth(0, 0.34, sunY)) + 40 * (1 - smooth(-0.13, 0.035, sunY));

/** What heavy cloud leaves of the clear sky's light, for how much of the sky is covered. */
export const overcastSky = (coverage: number): number => 1 - 0.68 * smooth(0.55, 1, coverage);

/**
 * How much cloud a place must tend to have for clouds to form there, by how much of the sky they cover (0-1).
 * Matches the weather map's spread: about 0.48 on average, within 0.09 of that two times in three.
 */
export const cloudThreshold = (coverage: number): number => 0.72 - 0.48 * coverage;
/** How much further it goes from no cloud to full cloud. */
export const CLOUD_EDGE = 0.12;

/** The sun's angular radius as it really looks, radians. */
export const SUN_ANGULAR_RADIUS = 0.004675;
/** The moon's, radians. */
export const MOON_ANGULAR_RADIUS = 0.0045;

export interface AtmosphereCoefficients {
    rayleigh: Rgb;
    mieScatter: Rgb;
    mieAbsorb: Rgb;
    ozone: Rgb;
    ground: Rgb;
    /** How forward the haze scatters. */
    mieG: number;
}

const srgbChannel = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

/** "#rrggbb" as linear RGB. */
export const linearFromHex = (hex: string, out: Rgb = [0, 0, 0]): Rgb => {
    const value = parseInt(hex.slice(1), 16);
    out[0] = srgbChannel(((value >> 16) & 255) / 255);
    out[1] = srgbChannel(((value >> 8) & 255) / 255);
    out[2] = srgbChannel((value & 255) / 255);
    return out;
};

export const atmosphereCoefficients = (settings: SkyAtmosphereSettings): AtmosphereCoefficients => {
    const tint = linearFromHex(settings.rayleighTint);
    const haze = settings.haze;
    return {
        rayleigh: [
            RAYLEIGH_SCATTER[0] * settings.rayleigh * tint[0],
            RAYLEIGH_SCATTER[1] * settings.rayleigh * tint[1],
            RAYLEIGH_SCATTER[2] * settings.rayleigh * tint[2],
        ],
        mieScatter: [MIE_SCATTER * haze, MIE_SCATTER * haze, MIE_SCATTER * haze],
        mieAbsorb: [MIE_ABSORB * haze, MIE_ABSORB * haze, MIE_ABSORB * haze],
        ozone: [OZONE_ABSORB[0] * settings.ozone, OZONE_ABSORB[1] * settings.ozone, OZONE_ABSORB[2] * settings.ozone],
        ground: linearFromHex(settings.ground),
        mieG: settings.hazeGlow,
    };
};

/** The nearest way along a ray (from height `r` at `mu`, the cosine from straight up) to a sphere of `radius`; -1 for none ahead. */
const toSphere = (r: number, mu: number, radius: number): number => {
    const b = r * mu;
    const discriminant = b * b - r * r + radius * radius;
    if (discriminant < 0) return -1;
    const root = Math.sqrt(discriminant);
    const near = -b - root;
    if (near > 0) return near;
    const far = -b + root;
    return far > 0 ? far : -1;
};

const OPTICAL_STEPS = 24;

/** Fills `out` with what share of light survives from height `r` out along `mu` (the cosine from straight up) to space. */
export const transmittance = (co: AtmosphereCoefficients, r: number, mu: number, out: Rgb): Rgb => {
    // Behind the ground: no light gets through.
    const toGround = mu < 0 ? toSphere(r, mu, GROUND_RADIUS) : -1;
    if (toGround > 0) {
        out[0] = out[1] = out[2] = 0;
        return out;
    }
    const length = toSphere(r, mu, TOP_RADIUS);
    let air = 0;
    let haze = 0;
    let ozone = 0;
    if (length > 0) {
        const step = length / OPTICAL_STEPS;
        for (let i = 0; i < OPTICAL_STEPS; i++) {
            const t = (i + 0.5) * step;
            const radius = Math.sqrt(r * r + t * t + 2 * r * t * mu);
            const height = Math.max(0, radius - GROUND_RADIUS);
            air += Math.exp(-height / RAYLEIGH_HEIGHT);
            haze += Math.exp(-height / MIE_HEIGHT);
            ozone += Math.max(0, 1 - Math.abs(height - OZONE_CENTRE) / OZONE_HALF_WIDTH);
        }
        air *= step;
        haze *= step;
        ozone *= step;
    }
    for (let c = 0; c < 3; c++) {
        out[c] = Math.exp(-(co.rayleigh[c] * air + (co.mieScatter[c] + co.mieAbsorb[c]) * haze + co.ozone[c] * ozone));
    }
    return out;
};

const rayleighPhase = (cosine: number): number => (3 / (16 * Math.PI)) * (1 + cosine * cosine);

const miePhase = (cosine: number, g: number): number => {
    const k = 1 + g * g - 2 * g * cosine;
    return (3 / (8 * Math.PI)) * ((1 - g * g) * (1 + cosine * cosine)) / ((2 + g * g) * Math.pow(Math.max(k, 1e-4), 1.5));
};

const SKY_STEPS = 16;
/** Stands in for the light scattered more than once, as a share of the sky's ambient level. */
const MULTIPLE_SCATTER = 0.42;

const _sunLight: Rgb = [0, 0, 0];

export interface Direction { x: number; y: number; z: number }

/**
 * Fills `out` with the sky's light looking along `view` (a unit vector) from `height` km up, per unit of
 * sunlight from `sun` (a unit vector): single scattering, with a share standing in for the rest.
 */
export const skyRadiance = (co: AtmosphereCoefficients, view: Direction, sun: Direction, height: number, out: Rgb): Rgb => {
    const r = GROUND_RADIUS + Math.max(height, 0.001);
    const below = view.y < 0 ? toSphere(r, view.y, GROUND_RADIUS) : -1;
    const length = below > 0 ? below : toSphere(r, view.y, TOP_RADIUS);
    out[0] = out[1] = out[2] = 0;
    if (length <= 0) return out;
    const cosine = view.x * sun.x + view.y * sun.y + view.z * sun.z;
    const pr = rayleighPhase(cosine);
    const pm = miePhase(cosine, co.mieG);
    const throughput: Rgb = [1, 1, 1];
    let previous = 0;
    for (let i = 0; i < SKY_STEPS; i++) {
        // Shorter steps near the viewer, where the air is thickest along a level ray.
        const f = (i + 1) / SKY_STEPS;
        const t = length * f * f;
        const dt = t - previous;
        const mid = previous + dt * 0.5;
        previous = t;
        const px = view.x * mid;
        const py = r + view.y * mid;
        const pz = view.z * mid;
        const radius = Math.hypot(px, py, pz);
        const altitude = Math.max(0, radius - GROUND_RADIUS);
        const air = Math.exp(-altitude / RAYLEIGH_HEIGHT);
        const haze = Math.exp(-altitude / MIE_HEIGHT);
        const ozone = Math.max(0, 1 - Math.abs(altitude - OZONE_CENTRE) / OZONE_HALF_WIDTH);
        const sunMu = (px * sun.x + py * sun.y + pz * sun.z) / radius;
        transmittance(co, radius, sunMu, _sunLight);
        // The sky stays a little lit past sunset: light scattered round the edge of the planet's shadow.
        const ambient = Math.max(0, Math.min(1, (sunMu + 0.25) / 0.45));
        for (let c = 0; c < 3; c++) {
            const scatterAir = co.rayleigh[c] * air;
            const scatterHaze = co.mieScatter[c] * haze;
            const extinction = scatterAir + scatterHaze + co.mieAbsorb[c] * haze + co.ozone[c] * ozone;
            const source = (scatterAir * pr + scatterHaze * pm) * _sunLight[c]
                + (scatterAir + scatterHaze) * MULTIPLE_SCATTER * ambient * ambient * (1 / (4 * Math.PI));
            const stepTransmittance = Math.exp(-extinction * dt);
            const integral = extinction > 1e-9 ? (source - source * stepTransmittance) / extinction : source * dt;
            out[c] += throughput[c] * integral;
            throughput[c] *= stepTransmittance;
        }
    }
    if (below > 0) {
        // The ground: what lights it, seen through the air.
        const up = Math.max(0, sun.y);
        transmittance(co, GROUND_RADIUS + 0.001, Math.max(sun.y, 0), _sunLight);
        for (let c = 0; c < 3; c++) out[c] += throughput[c] * _sunLight[c] * up * co.ground[c] / Math.PI;
    }
    return out;
};

/** Fills `out` with the sunlight (per unit above the atmosphere) reaching `height` km from `sunY`, the sun's height as a cosine. */
export const sunlightAt = (co: AtmosphereCoefficients, sunY: number, height: number, out: Rgb): Rgb =>
    transmittance(co, GROUND_RADIUS + Math.max(height, 0.001), sunY, out);

const HORIZON_ELEVATION = 0.035;
const COMPASS = [[1, 0], [0.5, 0.866], [-0.5, 0.866], [-1, 0], [-0.5, -0.866], [0.5, -0.866]] as const;
const _sample: Rgb = [0, 0, 0];
const _direction: Direction = { x: 0, y: 0, z: 0 };

/** Fills `out` with the horizon's colour, averaged round the compass, per unit of sunlight. */
export const horizonColour = (co: AtmosphereCoefficients, sun: Direction, height: number, out: Rgb): Rgb => {
    out[0] = out[1] = out[2] = 0;
    const across = Math.sqrt(1 - HORIZON_ELEVATION * HORIZON_ELEVATION);
    for (const [x, z] of COMPASS) {
        _direction.x = x * across;
        _direction.y = HORIZON_ELEVATION;
        _direction.z = z * across;
        skyRadiance(co, _direction, sun, height, _sample);
        out[0] += _sample[0];
        out[1] += _sample[1];
        out[2] += _sample[2];
    }
    out[0] /= COMPASS.length;
    out[1] /= COMPASS.length;
    out[2] /= COMPASS.length;
    return out;
};

const DOME_RINGS = [[0.2, 0.33], [0.55, 0.33], [0.9, 0.34]] as const;

/** Fills `out` with the sky's average light from above, per unit of sunlight: what lights a cloud's shaded side. */
export const skyAmbient = (co: AtmosphereCoefficients, sun: Direction, height: number, out: Rgb): Rgb => {
    out[0] = out[1] = out[2] = 0;
    for (const [y, weight] of DOME_RINGS) {
        const across = Math.sqrt(1 - y * y);
        for (const [x, z] of COMPASS) {
            _direction.x = x * across;
            _direction.y = y;
            _direction.z = z * across;
            skyRadiance(co, _direction, sun, height, _sample);
            const share = weight / COMPASS.length;
            out[0] += _sample[0] * share;
            out[1] += _sample[1] * share;
            out[2] += _sample[2] * share;
        }
    }
    return out;
};
