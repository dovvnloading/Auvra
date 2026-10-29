import * as THREE from 'three';
import { SURFACES, type SurfaceKind } from '../surfaces';
import { createSkidTrail, extendSkidTrail, markIntensity, skidMarks, type SkidTrail } from '../skidMarks';
import type { VehicleTelemetry } from '../vehicles';
import {
    ageParticles,
    applyParticleStyle,
    createParticleMaterial,
    createParticlePool,
    emitParticleAt,
    uploadParticles,
    WorldSpacePoints,
    type ParticleLook,
    type ParticlePool,
    type ParticleStyle,
} from './particles';

/**
 * What a vehicle's tyres leave behind: smoke from a sliding or spinning tyre on hard ground, dust
 * or spray thrown up on loose ground (more the faster it rolls), and marks on the ground.
 */

type Look = ParticleLook & ParticleStyle;

const SMOKE: Look = {
    lifetime: 2.4, speed: 0, spread: 0, size: 0.7, colorStart: '#e4e4e4', colorEnd: '#a6a6a6', gravity: -0.35,
    blending: 'normal', opacity: 0.32, sizeEnd: 5, drag: 1.4, radius: 0, wobble: 0.35, variance: 0.35, softness: 0,
};

const DUST: Look = {
    lifetime: 1.6, speed: 0, spread: 0, size: 0.5, colorStart: '#8f7656', colorEnd: '#6e5a42', gravity: -0.12,
    blending: 'normal', opacity: 0.5, sizeEnd: 4, drag: 1.8, radius: 0, wobble: 0.25, variance: 0.4, softness: 0,
};

/** Smoke puffs per second from a fully sliding tyre. */
const SMOKE_RATE = 70;
/** Dust per second from a tyre rolling at DUST_SPEED or faster on loose ground, and extra when it slides. */
const DUST_RATE = 24;
const DUST_SKID_RATE = 60;
const DUST_SPEED = 12;
/** Particles each vehicle keeps alive per kind. */
const CAPACITY = 1024;

interface Emitter {
    pool: ParticlePool;
    material: THREE.ShaderMaterial;
    points: WorldSpacePoints;
    look: Look;
}

const createEmitter = (look: Look): Emitter => {
    const pool = createParticlePool(CAPACITY);
    const material = createParticleMaterial();
    applyParticleStyle(material, look);
    return { pool, material, points: new WorldSpacePoints(pool, material), look: { ...look } };
};

export interface TyreEffects {
    smoke: Emitter;
    dust: Emitter;
    trails: SkidTrail[];
    /** Particles owed per wheel and kind, carried between frames. */
    carry: { smoke: number; dust: number }[];
    /** The ground the dust is coloured for. */
    dustSurface: SurfaceKind | null;
    dispose(): void;
}

export const createTyreEffects = (): TyreEffects => {
    const smoke = createEmitter(SMOKE);
    const dust = createEmitter(DUST);
    return {
        smoke,
        dust,
        trails: [],
        carry: [],
        dustSurface: null,
        dispose() {
            for (const emitter of [smoke, dust]) {
                emitter.points.geometry.dispose();
                emitter.material.dispose();
            }
        },
    };
};

const _kick = new THREE.Color();
const _point = new THREE.Vector3();

/**
 * One frame of a vehicle's tyre effects from its last simulation step: `halfWidths` per wheel,
 * `velocity` the chassis's (m/s, world), `viewportHeight` the drawing buffer's height in pixels.
 */
export const stepTyreEffects = (
    effects: TyreEffects,
    telemetry: VehicleTelemetry,
    halfWidths: readonly number[],
    velocity: THREE.Vector3,
    dt: number,
    viewportHeight: number,
): void => {
    const { smoke, dust } = effects;
    ageParticles(smoke.pool, smoke.look, dt);
    ageParticles(dust.pool, dust.look, dt);
    const marks = skidMarks();
    let loudestDust = 0;
    let dustSurface = null as SurfaceKind | null;
    telemetry.wheels.forEach((wheel, index) => {
        const trail = (effects.trails[index] ??= createSkidTrail());
        const carry = (effects.carry[index] ??= { smoke: 0, dust: 0 });
        const surface = SURFACES[wheel.surface];
        const intensity = markIntensity(wheel, surface);
        extendSkidTrail(marks, trail, wheel.contactPoint, wheel.contactNormal, halfWidths[index] ?? 0.1, intensity, wheel.surface);
        if (!wheel.contact) return;
        const slide = Math.min(1, Math.max(0, Math.abs(wheel.slipAngle) - 0.18) / 0.35);
        const spin = Math.min(1, Math.max(0, Math.abs(wheel.slipRatio) - 0.3) / 0.7);
        const skid = wheel.groundSpeed > 1.5 || Math.abs(wheel.slipRatio) > 0.5 ? Math.max(slide, spin) : 0;
        _point.copy(wheel.contactPoint).addScaledVector(wheel.contactNormal, 0.15);
        if (surface.kick === 'smoke' && skid > 0) {
            carry.smoke += SMOKE_RATE * skid * dt;
            for (; carry.smoke >= 1; carry.smoke -= 1) {
                emitParticleAt(smoke.pool, smoke.look, _point.x, _point.y, _point.z,
                    velocity.x * 0.15 + (Math.random() - 0.5) * 1.2, 0.3 + Math.random() * 0.5, velocity.z * 0.15 + (Math.random() - 0.5) * 1.2);
            }
        } else carry.smoke = 0;
        if (surface.kick === 'dust' || surface.kick === 'spray') {
            const rolling = Math.min(1, wheel.groundSpeed / DUST_SPEED);
            const rate = DUST_RATE * rolling + DUST_SKID_RATE * skid;
            if (rate > loudestDust) {
                loudestDust = rate;
                dustSurface = wheel.surface;
            }
            carry.dust += rate * dt;
            const lift = surface.kick === 'spray' ? 2.2 : 1.1;
            for (; carry.dust >= 1; carry.dust -= 1) {
                // Thrown up and back off the tread.
                emitParticleAt(dust.pool, dust.look, _point.x, _point.y, _point.z,
                    -velocity.x * 0.2 + (Math.random() - 0.5) * 1.5, lift * (0.5 + Math.random()), -velocity.z * 0.2 + (Math.random() - 0.5) * 1.5);
            }
        } else carry.dust = 0;
    });
    // The dust takes the colour of the ground throwing up the most of it.
    if (dustSurface && dustSurface !== effects.dustSurface) {
        effects.dustSurface = dustSurface;
        _kick.set(SURFACES[dustSurface].kickColor);
        dust.look.colorStart = `#${_kick.getHexString()}`;
        dust.look.colorEnd = `#${_kick.multiplyScalar(0.78).getHexString()}`;
        applyParticleStyle(dust.material, dust.look);
    }
    for (const emitter of [smoke, dust]) {
        emitter.material.uniforms.uViewportHeight.value = viewportHeight;
        uploadParticles(emitter.points, emitter.pool);
    }
};
