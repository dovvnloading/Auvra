import * as THREE from 'three';

/**
 * PARTICLE BRUSHES
 *
 * Each dab throws particles that run down over the surface (drips, leaks), fall through the air and
 * stick where they land (dust), or bounce where they land (splashes), leaving paint along their paths.
 * Gravity pulls down the model's Y axis unless set another way; speeds, gravity and reach are in shares of the model's size a
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
    /** The way gravity pulls, in the model's space (down its Y axis unless set). */
    gravityDirection?: [number, number, number];
}

/** Ways gravity can pull, offered in the Brush panel. */
export const GRAVITY_DIRECTIONS: ReadonlyArray<{ key: string; label: string; direction: [number, number, number] }> = [
    { key: '-y', label: 'Down', direction: [0, -1, 0] },
    { key: '+y', label: 'Up', direction: [0, 1, 0] },
    { key: '-x', label: '−X', direction: [-1, 0, 0] },
    { key: '+x', label: '+X', direction: [1, 0, 0] },
    { key: '-z', label: '−Z', direction: [0, 0, -1] },
    { key: '+z', label: '+Z', direction: [0, 0, 1] },
];

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
        ...(Array.isArray(raw.gravityDirection) && raw.gravityDirection.length === 3 && raw.gravityDirection.every((value) => typeof value === 'number' && Number.isFinite(value)) && raw.gravityDirection.some((value) => value !== 0)
            ? { gravityDirection: raw.gravityDirection.map(Number) as [number, number, number] } : {}),
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
    /** Pixels to the model unit of the dab that threw it, passed on to the dabs it leaves. */
    scale?: number;
}

/** A direction laid on the plane square to `n`. */
const tangentOf = (v: THREE.Vector3, n: THREE.Vector3): THREE.Vector3 => v.clone().addScaledVector(n, -v.dot(n));

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

/** A particle on its way. */
interface Live {
    from: ParticleDab;
    pos: THREE.Vector3;
    normal: THREE.Vector3;
    velocity: THREE.Vector3;
    step: number;
    sinceDab: number;
    bounces: number;
    done: boolean;
}

/**
 * Particles running over time: dabs throw particles as a stroke is drawn (spawn), and each moment the
 * stroke goes on (advance, by seconds) they move on, giving the dabs they leave along that part of their
 * paths; finish runs the rest to their ends. Steady for a given seed and the same calls.
 */
export class ParticleRun {
    private readonly next: () => number;
    private readonly gravity: THREE.Vector3;
    private readonly steps: number;
    private live: Live[] = [];
    /** Time not yet stepped (less than a step). */
    private owed = 0;

    constructor(private readonly settings: ParticleSettings, private readonly surface: ParticleSurface, private readonly modelSize: number, seed: number) {
        this.next = randoms(seed);
        this.gravity = new THREE.Vector3(...(settings.gravityDirection ?? [0, -1, 0])).normalize().multiplyScalar(settings.gravity * modelSize);
        this.steps = Math.min(MAX_STEPS, Math.ceil(settings.life / STEP));
    }

    /** Particles still on their way. */
    get alive(): number { return this.live.length; }

    private radiusAt(particle: Live): number {
        return particle.from.worldRadius * THREE.MathUtils.lerp(this.settings.sizeStart, this.settings.sizeEnd, Math.min(1, particle.step / Math.max(1, this.steps)));
    }

    /** The particles one dab throws. */
    spawn(from: ParticleDab): void {
        const { settings, surface, modelSize, next } = this;
        for (let p = 0; p < settings.count; p++) {
            if (settings.motion === 'flow') {
                // Starting somewhere under the brush, on the surface.
                const offset = tangentOf(cone(from.normal, 0.5, next), from.normal).normalize().multiplyScalar(from.worldRadius * 0.6 * Math.sqrt(next()));
                const at = surface.nearest(from.point.clone().add(offset), from.worldRadius * 2) ?? { point: from.point.clone(), normal: from.normal.clone() };
                const downhill = tangentOf(this.gravity, at.normal);
                const start = downhill.lengthSq() > 1e-12 ? downhill.normalize() : tangentOf(cone(at.normal, 0.5, next), at.normal).normalize();
                // Turned off downhill by up to the spread.
                const velocity = start.applyAxisAngle(at.normal, (next() - 0.5) * Math.PI * settings.spread).multiplyScalar(settings.speed * modelSize);
                this.live.push({ from, pos: at.point.clone(), normal: at.normal.clone(), velocity, step: 0, sinceDab: Infinity, bounces: 0, done: false });
                continue;
            }
            // Thrown off the surface into the air, falling.
            const pos = from.point.clone().addScaledVector(from.normal, from.worldRadius * 0.5);
            const velocity = cone(from.normal, settings.spread * 0.5, next).multiplyScalar(settings.speed * modelSize * (0.5 + 0.5 * next()));
            this.live.push({ from, pos, normal: from.normal.clone(), velocity, step: 0, sinceDab: 0, bounces: settings.motion === 'bounce' ? 4 : 0, done: false });
        }
    }

    /** One step of one particle, leaving any dabs into `out`. */
    private stepOne(particle: Live, out: ParticleDab[]): void {
        const { settings, surface, modelSize, next, gravity } = this;
        if (particle.step >= this.steps) { particle.done = true; return; }
        const leave = (point: THREE.Vector3, normal: THREE.Vector3) => out.push({ point: point.clone(), normal: normal.clone(), worldRadius: this.radiusAt(particle), flow: particle.from.flow, scale: particle.from.scale });
        if (settings.motion === 'flow') {
            const radius = this.radiusAt(particle);
            if (particle.sinceDab >= radius * 0.35) { leave(particle.pos, particle.normal); particle.sinceDab = 0; }
            particle.velocity.add(tangentOf(gravity, particle.normal).multiplyScalar(STEP));
            // Thick paint: a drag that sets how fast it can run.
            particle.velocity.multiplyScalar(1 - Math.min(0.9, 2.5 * STEP));
            if (settings.wander > 0 && particle.velocity.lengthSq() > 1e-16) particle.velocity.applyAxisAngle(particle.normal, (next() - 0.5) * settings.wander * 0.6);
            const move = particle.velocity.clone().multiplyScalar(STEP);
            const length = move.length();
            particle.step++;
            if (length < modelSize * 1e-6) { particle.done = true; return; }
            const landed = surface.nearest(particle.pos.clone().add(move), length * 2 + radius);
            // Off an edge with nothing to run onto: it stops.
            if (!landed) { particle.done = true; return; }
            particle.sinceDab += landed.point.distanceTo(particle.pos);
            particle.pos = landed.point;
            particle.normal = landed.normal;
            particle.velocity = tangentOf(particle.velocity, particle.normal).setLength(particle.velocity.length());
            return;
        }
        particle.velocity.add(gravity.clone().multiplyScalar(STEP));
        if (settings.wander > 0) particle.velocity.add(cone(new THREE.Vector3(0, 1, 0), 1, next).multiplyScalar(settings.wander * settings.speed * modelSize * STEP * 4));
        const move = particle.velocity.clone().multiplyScalar(STEP);
        const length = move.length();
        if (length < 1e-12) { particle.step++; return; }
        const hit = surface.cast(particle.pos, move.clone().divideScalar(length));
        if (!hit || hit.distance > length) { particle.pos.add(move); particle.step++; return; }
        leave(hit.point, hit.normal);
        particle.step++;
        if (particle.bounces-- <= 0) { particle.done = true; return; }
        // Bounced off, slower, a little off the surface.
        particle.velocity.reflect(hit.normal).multiplyScalar(settings.bounce);
        particle.pos = hit.point.clone().addScaledVector(hit.normal, modelSize * 1e-4);
        if (particle.velocity.length() < settings.speed * modelSize * 0.05) particle.done = true;
    }

    /** Moves every particle on by \`seconds\`, giving the dabs they leave meanwhile. */
    advance(seconds: number): ParticleDab[] {
        const out: ParticleDab[] = [];
        this.owed += Math.max(0, seconds);
        while (this.owed >= STEP && this.live.length) {
            this.owed -= STEP;
            for (const particle of this.live) this.stepOne(particle, out);
            this.live = this.live.filter((particle) => !particle.done);
        }
        if (!this.live.length) this.owed = 0;
        return out;
    }

    /** Runs every particle to the end of its way, giving the dabs it leaves. */
    finish(): ParticleDab[] {
        return this.advance(this.steps * STEP + STEP);
    }
}

/**
 * The dabs the particles one dab throws leave, run to their ends at once: \`from\` is the dab on the
 * surface, \`modelSize\` the model's size (its box's diagonal). At most \`maxDabs\` are given.
 */
export const throwParticles = (from: ParticleDab, settings: ParticleSettings, surface: ParticleSurface, modelSize: number, seed: number, maxDabs = 600): ParticleDab[] => {
    const run = new ParticleRun(settings, surface, modelSize, seed);
    run.spawn(from);
    return run.finish().slice(0, maxDabs);
};
