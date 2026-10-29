import { windVelocity, worldClock, type WeatherState } from './weather';

/**
 * WIND
 *
 * The wind everything that moves in it reads: the weather's wind, swelling and easing in gusts,
 * swirling a little from place to place, plus wind zones (a Wind Zone component: a fan, a
 * downdraft, a gap between buildings that funnels it) where they reach. Foliage sways with it,
 * cloth billows, loose hair and tails stream. Pure: the shaders read the global part through
 * `windUniforms`, and CPU simulations ask `windAt` for a point.
 */

export type WindVec = { x: number; y: number; z: number };

export type WindZoneShape = 'directional' | 'radial';

/** A wind zone where it is now (world space). */
export interface WindZoneState {
    shape: WindZoneShape;
    /** Its centre, and for a directional zone the way it blows (unit). */
    x: number; y: number; z: number;
    dx: number; dy: number; dz: number;
    /** m/s at the centre, and how far it reaches, m (0: everywhere, directional only). */
    strength: number;
    radius: number;
    /** 0-1: how much it gusts and swirls. */
    turbulence: number;
}

const zones = new Map<string, WindZoneState>();

export const windZones = {
    set(id: string, zone: WindZoneState): void {
        zones.set(id, zone);
    },
    remove(id: string): void {
        zones.delete(id);
    },
    all(): WindZoneState[] {
        return [...zones.values()];
    },
    clear(): void {
        zones.clear();
    },
};

/** How strong the gusts are right now, 0.4 (a lull) to 1.4 (a gust), from slow overlapping waves. */
export const gustFactor = (time: number, phase = 0): number =>
    0.9 + 0.32 * Math.sin(time * 0.31 + phase) + 0.18 * Math.sin(time * 0.83 + phase * 1.7) + 0.08 * Math.sin(time * 2.1 + phase * 3.1);

/** The weather's wind at a point and time, gusting and swirling: m/s. */
export const weatherWindAt = (weather: WeatherState, x: number, y: number, z: number, time: number, out: WindVec): WindVec => {
    const [wx, wz] = windVelocity(weather);
    const speed = Math.hypot(wx, wz);
    if (speed < 1e-4) {
        out.x = 0; out.y = 0; out.z = 0;
        return out;
    }
    // Gusts roll across the ground with the wind: the phase follows the position along it.
    const along = (x * wx + z * wz) / speed;
    const gust = gustFactor(time, -along * 0.08);
    // A little swirl across and up, varying from place to place.
    const swirl = 0.18 * Math.sin(time * 1.7 + x * 0.21 + z * 0.17) + 0.1 * Math.sin(time * 3.3 + z * 0.43);
    const lift = 0.06 * Math.sin(time * 2.3 + x * 0.3 - z * 0.2) + 0.02 * Math.max(0, y) / (1 + Math.max(0, y));
    const sideX = -wz / speed, sideZ = wx / speed;
    out.x = wx * gust + sideX * swirl * speed;
    out.y = lift * speed;
    out.z = wz * gust + sideZ * swirl * speed;
    return out;
};

/** A wind zone's push at a point, m/s (nothing outside its reach). */
export const zoneWindAt = (zone: WindZoneState, x: number, y: number, z: number, time: number, out: WindVec): WindVec => {
    out.x = 0; out.y = 0; out.z = 0;
    const rx = x - zone.x, ry = y - zone.y, rz = z - zone.z;
    const distance = Math.hypot(rx, ry, rz);
    let reach = 1;
    if (zone.radius > 0) {
        if (distance >= zone.radius) return out;
        const t = distance / zone.radius;
        reach = 1 - t * t;
    }
    const flutter = 1 + zone.turbulence * (0.35 * Math.sin(time * 4.1 + distance * 1.3) + 0.25 * Math.sin(time * 7.3 + x - z));
    const strength = zone.strength * reach * flutter;
    if (zone.shape === 'radial') {
        if (distance < 1e-4) return out;
        out.x = (rx / distance) * strength;
        out.y = (ry / distance) * strength;
        out.z = (rz / distance) * strength;
    } else {
        out.x = zone.dx * strength;
        out.y = zone.dy * strength;
        out.z = zone.dz * strength;
    }
    return out;
};

const _zone: WindVec = { x: 0, y: 0, z: 0 };

/** The wind at a point: the weather's, plus every zone that reaches it. m/s. */
export const windAt = (x: number, y: number, z: number, time: number, out: WindVec, weather: WeatherState = worldClock.weather): WindVec => {
    weatherWindAt(weather, x, y, z, time, out);
    for (const zone of zones.values()) {
        zoneWindAt(zone, x, y, z, time, _zone);
        out.x += _zone.x;
        out.y += _zone.y;
        out.z += _zone.z;
    }
    return out;
};

/** What swaying surfaces read each frame (see runtime/weatherSurfaces.ts). */
export const windUniforms = {
    uWindTime: { value: 0 },
    /** The weather wind's direction on the ground (unit), and its speed with the gusts, m/s. */
    uWindDirection: { value: [1, 0] as [number, number] },
    uWindStrength: { value: 0 },
};

let clock = 0;

/** Moves the wind on by `dt` and sets what swaying surfaces read. */
export const stepWind = (dt: number, weather: WeatherState = worldClock.weather): void => {
    if (dt > 0 && Number.isFinite(dt)) clock += Math.min(dt, 0.1);
    const [wx, wz] = windVelocity(weather);
    const speed = Math.hypot(wx, wz);
    windUniforms.uWindTime.value = clock;
    if (speed > 1e-4) windUniforms.uWindDirection.value = [wx / speed, wz / speed];
    windUniforms.uWindStrength.value = speed * gustFactor(clock);
};

/** Seconds the wind has blown this session (what simulations time their gusts by). */
export const windTime = (): number => clock;
