import * as THREE from 'three';
import { SURFACES, type SurfaceKind } from '../surfaces';
import { createSkidTrail, extendSkidTrail, markIntensity, skidMarks, type SkidTrail } from '../skidMarks';
import type { VehicleTelemetry } from '../vehicles';
import { PARTICLE_PRESETS, sanitizeParticleEffect, type ParticleEffect } from '../particleEffect';
import { ParticleRenderer } from '../particleRenderer';
import { ParticleSimulation } from '../particleSimulation';
import { builtinSpriteTexture, SPRITE_GRIDS } from '../particleSprites';

/**
 * What a vehicle's tyres leave behind: smoke from a sliding or spinning tyre on hard ground, dust
 * or spray thrown up on loose ground (more the faster it rolls), and marks on the ground. The smoke
 * and dust are particle effects the tyres emit into themselves; they never emit on their own.
 */

/** Tyre smoke: billowing and lingering, lifting and spreading as it goes. */
export const TYRE_SMOKE: ParticleEffect = sanitizeParticleEffect({
    ...PARTICLE_PRESETS.smoke,
    rate: 0, maxParticles: 1200, lifetime: [1.8, 2.8], speed: [0.2, 0.6], size: [0.6, 0.9],
    shape: { ...PARTICLE_PRESETS.smoke.shape, kind: 'point', angle: 70 },
    gravity: -0.35, drag: 1.4, turbulence: 0.4, startColor: ['#e4e4e4', '#cfcfcf'],
    colorOverLife: { stops: [{ t: 0, color: '#ffffff', alpha: 0 }, { t: 0.08, color: '#ffffff', alpha: 0.4 }, { t: 0.6, color: '#e0e0e0', alpha: 0.25 }, { t: 1, color: '#c0c0c0', alpha: 0 }] },
    sizeOverLife: { points: [[0, 0.6], [1, 5]] },
});

/** Dust or spray kicked up and back off loose ground, falling back as it thins. */
export const TYRE_DUST: ParticleEffect = sanitizeParticleEffect({
    ...PARTICLE_PRESETS.smoke,
    rate: 0, maxParticles: 1200, lifetime: [1.2, 2], speed: [0.4, 1], size: [0.35, 0.6],
    shape: { ...PARTICLE_PRESETS.smoke.shape, kind: 'point', angle: 40 },
    gravity: 0.6, drag: 1.8, turbulence: 0.3, startColor: ['#ffffff', '#e8e8e8'],
    colorOverLife: { stops: [{ t: 0, color: '#8f7656', alpha: 0 }, { t: 0.08, color: '#8f7656', alpha: 0.55 }, { t: 0.7, color: '#6e5a42', alpha: 0.35 }, { t: 1, color: '#6e5a42', alpha: 0 }] },
    sizeOverLife: { points: [[0, 0.6], [1, 4]] },
});

/** Smoke puffs per second from a fully sliding tyre. */
const SMOKE_RATE = 70;
/** Dust per second from a tyre rolling at DUST_SPEED or faster on loose ground, and extra when it slides. */
const DUST_RATE = 24;
const DUST_SKID_RATE = 60;
const DUST_SPEED = 12;

interface Emitter {
    simulation: ParticleSimulation;
    renderer: ParticleRenderer;
    effect: ParticleEffect;
}

const createEmitter = (effect: ParticleEffect): Emitter => {
    const simulation = new ParticleSimulation(effect, effect.maxParticles);
    // Emits only what the tyres put into it.
    simulation.stop();
    const renderer = new ParticleRenderer(effect.maxParticles);
    renderer.setLook(effect, builtinSpriteTexture('smoke'), SPRITE_GRIDS.smoke);
    return { simulation, renderer, effect };
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
    const smoke = createEmitter(TYRE_SMOKE);
    const dust = createEmitter(TYRE_DUST);
    return {
        smoke,
        dust,
        trails: [],
        carry: [],
        dustSurface: null,
        dispose() {
            smoke.renderer.dispose();
            dust.renderer.dispose();
        },
    };
};

const _kick = new THREE.Color();
const _point = new THREE.Vector3();
const IDENTITY = new THREE.Matrix4();

/** The dust effect coloured for the ground throwing it up. */
export const dustFor = (surface: SurfaceKind): ParticleEffect => {
    _kick.set(SURFACES[surface].kickColor);
    const start = `#${_kick.getHexString()}`;
    const end = `#${_kick.multiplyScalar(0.78).getHexString()}`;
    const spray = SURFACES[surface].kick === 'spray';
    return {
        ...TYRE_DUST,
        // Spray is thrown higher and falls faster than dust.
        gravity: spray ? 3 : TYRE_DUST.gravity,
        colorOverLife: { stops: [{ t: 0, color: start, alpha: 0 }, { t: 0.08, color: start, alpha: spray ? 0.7 : 0.55 }, { t: 0.7, color: end, alpha: 0.35 }, { t: 1, color: end, alpha: 0 }] },
    };
};

/**
 * One frame of a vehicle's tyre effects from its last simulation step: `halfWidths` per wheel,
 * `velocity` the chassis's (m/s, world), `camera` the view the effects are drawn for.
 */
export const stepTyreEffects = (
    effects: TyreEffects,
    telemetry: VehicleTelemetry,
    halfWidths: readonly number[],
    velocity: THREE.Vector3,
    dt: number,
    camera: THREE.Camera,
): void => {
    const { smoke, dust } = effects;
    smoke.simulation.step(dt, null);
    dust.simulation.step(dt, null);
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
            const due = Math.floor(carry.smoke);
            carry.smoke -= due;
            smoke.simulation.emitAt(due, _point.x, _point.y, _point.z, velocity.x * 0.15, 0.3, velocity.z * 0.15);
        } else carry.smoke = 0;
        if (surface.kick === 'dust' || surface.kick === 'spray') {
            const rolling = Math.min(1, wheel.groundSpeed / DUST_SPEED);
            const rate = DUST_RATE * rolling + DUST_SKID_RATE * skid;
            if (rate > loudestDust) {
                loudestDust = rate;
                dustSurface = wheel.surface;
            }
            carry.dust += rate * dt;
            const due = Math.floor(carry.dust);
            carry.dust -= due;
            const lift = surface.kick === 'spray' ? 2.2 : 1.1;
            // Thrown up and back off the tread.
            dust.simulation.emitAt(due, _point.x, _point.y, _point.z, -velocity.x * 0.2, lift, -velocity.z * 0.2);
        } else carry.dust = 0;
    });
    // The dust takes the colour of the ground throwing up the most of it.
    if (dustSurface && dustSurface !== effects.dustSurface) {
        effects.dustSurface = dustSurface;
        dust.effect = dustFor(dustSurface);
        dust.simulation.setEffect(dust.effect);
    }
    smoke.renderer.update(smoke.simulation, IDENTITY, camera);
    dust.renderer.update(dust.simulation, IDENTITY, camera);
};
