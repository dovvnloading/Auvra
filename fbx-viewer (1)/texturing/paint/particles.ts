import * as THREE from 'three';

/**
 * PARTICLE BRUSHES
 *
 * Each dab throws particles that run down over the surface (drips, leaks), fall through the air and
 * stick where they land (dust), or bounce where they land (splashes), leaving paint along their paths.
 * Gravity pulls down the model's Y axis; speeds, gravity and reach are in shares of the model's size a
 * second, so a preset behaves the same on a ring and on a tank. The paths are worked out at once (on
 * the CPU, steady for a given seed) and painted as surface dabs.
 */

export type ParticleMotion = 'flow' | 'fall' | 'bounce';

export interface ParticleSettings {
    enabled: boolean;
    motion: ParticleMotion;
    /** Particles each dab throws. */
    count: number;
    /** How far their directions spread: 0 all the same way, 1 every way. */
    spread: number;
    /** Starting speed, in model sizes a second. */
    speed: number;
    /** Pull down the model's Y axis, in model sizes a second squared. */
    gravity: number;
    /** Seconds each particle lives. */
    life: number;
    /** Its size at the start and at the end of its life, as a share of the brush's size. */
    sizeStart: number;
    sizeEnd: number;
    /** How much its way wanders as it goes (0 straight). */
    wander: number;
    /** Speed kept at each bounce (bouncing particles). */
    bounce: number;
    /** The brush paints where it is too, not only along the particles' paths. */
    paintAtBrush: boolean;
}

export const DEFAULT_PARTICLES: ParticleSettings = {
    enabled: false, motion: 'flow', count: 3, spread: 0.2, speed: 0.05, gravity: 0.6, life: 1.5, sizeStart: 0.35, sizeEnd: 0.15, wander: 0.2, bounce: 0.5, paintAtBrush: true,
};

/** Particle presets to start from. */
export const PARTICLE_PRESETS: ReadonlyArray<{ id: string; name: string; settings: ParticleSettings }> = [
    { id: 'drips', name: 'Drips', settings: { ...DEFAULT_PARTICLES, enabled: true, motion: 'flow', count: 2, spread: 0.15, speed: 0.02, gravity: 0.8, life: 2, sizeStart: 0.3, sizeEnd: 0.12, wander: 0.1, paintAtBrush: true } },
    { id: 'leaks', name: 'Leaks', settings: { ...DEFAULT_PARTICLES, enabled: true, motion: 'flow', count: 1, spread: 0.05, speed: 0.01, gravity: 0.35, life: 4, sizeStart: 0.22, sizeEnd: 0.22, wander: 0.45, paintAtBrush: false } },
    { id: 'dust', name: 'Dust', settings: { ...DEFAULT_PARTICLES, enabled: true, motion: 'fall', count: 14, spread: 0.9, speed: 0.15, gravity: 1, life: 1.5, sizeStart: 0.05, sizeEnd: 0.03, wander: 0.3, paintAtBrush: false } },
    { id: 'splashes', name: 'Splashes', settings: { ...DEFAULT_PARTICLES, enabled: true, motion: 'bounce', count: 8, spread: 0.6, speed: 0.6, gravity: 2, life: 1.2, sizeStart: 0.16, sizeEnd: 0.05, wander: 0, bounce: 0.45, paintAtBrush: true } },
];

const MOTIONS: readonly ParticleMotion[] = ['flow', 'fall', 'bounce'];

/** Particle settings read back from a preset or a saved brush, made safe (anything missing at its default). */
export const readParticles = (value: unknown): ParticleSettings => {
    const raw = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof ParticleSettings, unknown>>;
    const number = (key: keyof ParticleSettings, min: number, max: number): number => {
        const got = raw[key];
        return typeof got === 'number' && Number.isFinite(got) ? Math.min(max, Math.max(min, got)) : DEFAULT_PARTICLES[key] as number;
    };
    return {
        enabled: raw.enabled === true,
        motion: MOTIONS.includes(raw.motion as ParticleMotion) ? raw.motion as ParticleMotion : DEFAULT_PARTICLES.motion,
        count: Math.round(number('count', 1, 40)),
        spread: number('spread', 0, 1),
        speed: number('speed', 0, 5),
        gravity: number('gravity', 0, 10),
        life: number('life', 0.05, 10),
        sizeStart: number('sizeStart', 0.01, 2),
        sizeEnd: number('sizeEnd', 0.01, 2),
        wander: number('wander', 0, 1),
        bounce: number('bounce', 0, 1),
        paintAtBrush: raw.paintAtBrush === undefined ? DEFAULT_PARTICLES.paintAtBrush : raw.paintAtBrush === true,
    };
};

/** What particles move over: rays cast at it, and its nearest point. */
export interface ParticleSurface {
    cast(origin: THREE.Vector3, direction: THREE.Vector3): { point: THREE.Vector3; normal: THREE.Vector3; distance: number } | null;
    nearest(point: THREE.Vector3, reach: number): { point: THREE.Vector3; normal: THREE.Vector3 } | null;
}

/** A dab a particle leaves. */
export interface ParticleDab {
    point: THREE.Vector3;
    normal: THREE.Vector3;
    worldRadius: number;
    flow: number;
}

/** Steady random numbers in 0..1 from a seed. */
const randoms = (seed: number) => {
    let state = (seed >>> 0) || 1;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

/** A direction round `axis`, at most `spread` of a half turn away from it. */
const cone = (axis: THREE.Vector3, spread: number, next: () => number): THREE.Vector3 => {
    const helper = Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const t = new THREE.Vector3().crossVectors(axis, helper).normalize();
    const b = new THREE.Vector3().crossVectors(axis, t);
    const theta = Math.acos(1 - next() * (1 - Math.cos(spread * Math.PI)));
    const phi = next() * Math.PI * 2;
    return axis.clone().multiplyScalar(Math.cos(theta)).addScaledVector(t, Math.sin(theta) * Math.cos(phi)).addScaledVector(b, Math.sin(theta) * Math.sin(phi)).normalize();
};

const STEP = 1 / 60;
const MAX_STEPS = 600;

/**
 * The dabs the particles one dab throws leave: `from` is the dab on the surface, `modelSize` the model's
 * size (its box's diagonal). At most `maxDabs` are made.
 */
export const throwParticles = (from: ParticleDab, settings: ParticleSettings, surface: ParticleSurface, modelSize: number, seed: number, maxDabs = 600): ParticleDab[] => {
    const next = randoms(seed);
    const dabs: ParticleDab[] = [];
    const gravity = new THREE.Vector3(0, -settings.gravity * modelSize, 0);
    const steps = Math.min(MAX_STEPS, Math.ceil(settings.life / STEP));
    const radiusAt = (step: number) => from.worldRadius * THREE.MathUtils.lerp(settings.sizeStart, settings.sizeEnd, Math.min(1, step / Math.max(1, steps)));
    const leave = (point: THREE.Vector3, normal: THREE.Vector3, step: number) => {
        if (dabs.length < maxDabs) dabs.push({ point: point.clone(), normal: normal.clone(), worldRadius: radiusAt(step), flow: from.flow });
    };
    const tangent = (v: THREE.Vector3, n: THREE.Vector3) => v.clone().addScaledVector(n, -v.dot(n));
    for (let p = 0; p < settings.count && dabs.length < maxDabs; p++) {
        if (settings.motion === 'flow') {
            // Starting somewhere under the brush, on the surface.
            const offset = tangent(cone(from.normal, 0.5, next), from.normal).normalize().multiplyScalar(from.worldRadius * 0.6 * Math.sqrt(next()));
            let at = surface.nearest(from.point.clone().add(offset), from.worldRadius * 2) ?? { point: from.point.clone(), normal: from.normal.clone() };
            let pos = at.point.clone();
            let normal = at.normal.clone();
            const downhill = tangent(gravity, normal);
            const start = downhill.lengthSq() > 1e-12 ? downhill.normalize() : tangent(cone(normal, 0.5, next), normal).normalize();
            // Turned off downhill by up to the spread.
            let velocity = start.applyAxisAngle(normal, (next() - 0.5) * Math.PI * settings.spread).multiplyScalar(settings.speed * modelSize);
            let sinceDab = Infinity;
            for (let step = 0; step < steps; step++) {
                const radius = radiusAt(step);
                if (sinceDab >= radius * 0.35) { leave(pos, normal, step); sinceDab = 0; }
                velocity.add(tangent(gravity, normal).multiplyScalar(STEP));
                // Thick paint: a drag that sets how fast it can run.
                velocity.multiplyScalar(1 - Math.min(0.9, 2.5 * STEP));
                if (settings.wander > 0 && velocity.lengthSq() > 1e-16) velocity.applyAxisAngle(normal, (next() - 0.5) * settings.wander * 0.6);
                const move = velocity.clone().multiplyScalar(STEP);
                const length = move.length();
                if (length < modelSize * 1e-6) break;
                const landed = surface.nearest(pos.clone().add(move), length * 2 + radius);
                // Off an edge with nothing to run onto: it stops.
                if (!landed) break;
                sinceDab += landed.point.distanceTo(pos);
                pos = landed.point;
                normal = landed.normal;
                velocity = tangent(velocity, normal).setLength(velocity.length());
            }
            continue;
        }
        // Thrown off the surface into the air, falling.
        let pos = from.point.clone().addScaledVector(from.normal, from.worldRadius * 0.5);
        const velocity = cone(from.normal, settings.spread * 0.5, next).multiplyScalar(settings.speed * modelSize * (0.5 + 0.5 * next()));
        let bounces = settings.motion === 'bounce' ? 4 : 0;
        for (let step = 0; step < steps; step++) {
            velocity.add(gravity.clone().multiplyScalar(STEP));
            if (settings.wander > 0) velocity.add(cone(new THREE.Vector3(0, 1, 0), 1, next).multiplyScalar(settings.wander * settings.speed * modelSize * STEP * 4));
            const move = velocity.clone().multiplyScalar(STEP);
            const length = move.length();
            if (length < 1e-12) continue;
            const hit = surface.cast(pos, move.clone().divideScalar(length));
            if (!hit || hit.distance > length) { pos.add(move); continue; }
            leave(hit.point, hit.normal, step);
            if (bounces-- <= 0) break;
            // Bounced off, slower, a little off the surface.
            velocity.reflect(hit.normal).multiplyScalar(settings.bounce);
            pos = hit.point.clone().addScaledVector(hit.normal, modelSize * 1e-4);
            if (velocity.length() < settings.speed * modelSize * 0.05) break;
        }
    }
    return dabs;
};
