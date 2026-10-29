import * as THREE from 'three';
import { PARTICLE_PRESETS, sanitizeParticleEffect, type BuiltinSprite, type ParticleEffect } from './particleEffect';
import { ParticleRenderer } from './particleRenderer';
import { ParticleSimulation, type ParticleRaycast } from './particleSimulation';
import { builtinSpriteTexture, SPRITE_GRIDS } from './particleSprites';
import { SURFACES, type SurfaceKind } from './surfaces';
import type { Vec3 } from './destructibles';

/**
 * IMPACT EFFECTS
 *
 * What hits look like, on the particle system: a bullet striking metal or stone throws sparks,
 * striking wood, earth or plaster a puff of dust and chips in the surface's own colour, striking
 * water a splash; a breaking object raises a dust cloud and chips; an explosion is a fireball,
 * smoke, flying debris and sparks with a flash of light. One emitter per kind serves every hit.
 */

const base = (preset: ParticleEffect, overrides: Partial<ParticleEffect>): ParticleEffect =>
    sanitizeParticleEffect({ ...JSON.parse(JSON.stringify(preset)), rate: 0, bursts: [], loop: true, ...overrides }, preset);

const SPARKS = base(PARTICLE_PRESETS.sparks, {
    maxParticles: 1200, lifetime: [0.15, 0.4], speed: [2, 5], size: [0.02, 0.035],
    shape: { ...PARTICLE_PRESETS.sparks.shape, kind: 'sphere', radius: 0.01, volume: 1 },
    light: { ...PARTICLE_PRESETS.sparks.light, enabled: false },
});

const PUFF = base(PARTICLE_PRESETS.smoke, {
    maxParticles: 900, lifetime: [0.5, 1.1], speed: [0.2, 0.6], size: [0.12, 0.25], gravity: -0.2, drag: 2.5, turbulence: 0.4,
    shape: { ...PARTICLE_PRESETS.smoke.shape, kind: 'sphere', radius: 0.03, volume: 1 },
    colorOverLife: { stops: [{ t: 0, color: '#ffffff', alpha: 0.55 }, { t: 1, color: '#ffffff', alpha: 0 }] },
    sizeOverLife: { points: [[0, 0.6], [1, 2]] },
    light: { ...PARTICLE_PRESETS.smoke.light, enabled: false },
});

const CLOUD = base(PARTICLE_PRESETS.smoke, {
    maxParticles: 600, lifetime: [1.6, 3], speed: [0.3, 0.9], size: [0.5, 0.9], gravity: -0.15, drag: 1.8, turbulence: 0.5,
    shape: { ...PARTICLE_PRESETS.smoke.shape, kind: 'sphere', radius: 0.05, volume: 1 },
    colorOverLife: { stops: [{ t: 0, color: '#ffffff', alpha: 0 }, { t: 0.08, color: '#ffffff', alpha: 0.5 }, { t: 1, color: '#ffffff', alpha: 0 }] },
    sizeOverLife: { points: [[0, 0.5], [1, 1.8]] },
    light: { ...PARTICLE_PRESETS.smoke.light, enabled: false },
});

const CHIPS = base(PARTICLE_PRESETS.debris, {
    maxParticles: 1500, lifetime: [0.5, 1.2], speed: [0.5, 2.5], size: [0.02, 0.05],
    shape: { ...PARTICLE_PRESETS.debris.shape, kind: 'sphere', radius: 0.02, volume: 1 },
    collision: { mode: 'world', bounce: 0.3, friction: 0.5, kill: false },
});

const SPLASH = base(PARTICLE_PRESETS.sparks, {
    maxParticles: 800, lifetime: [0.3, 0.6], speed: [1, 3], size: [0.03, 0.05], gravity: 9.8, drag: 0.5,
    shape: { ...PARTICLE_PRESETS.sparks.shape, kind: 'hemisphere', radius: 0.03, angle: 40, axis: [0, 1, 0] },
    startColor: ['#d8e8f8', '#c0d4ea'],
    colorOverLife: { stops: [{ t: 0, color: '#e0f0ff', alpha: 0.7 }, { t: 1, color: '#e0f0ff', alpha: 0 }] },
    collision: { mode: 'none', bounce: 0, friction: 0, kill: false },
    render: { ...PARTICLE_PRESETS.sparks.render, mode: 'stretched', sprite: 'droplet', blending: 'alpha', emissive: 1, stretch: 0.08 },
    light: { ...PARTICLE_PRESETS.sparks.light, enabled: false },
});

const FIREBALL = base(PARTICLE_PRESETS.explosion, {
    maxParticles: 600, light: { ...PARTICLE_PRESETS.explosion.light, enabled: false },
});

const SMOKE = base(PARTICLE_PRESETS.smoke, {
    maxParticles: 900, lifetime: [2.5, 4.5], speed: [0.5, 1.5], size: [0.8, 1.4], gravity: -0.6, drag: 1.2, turbulence: 0.6,
    shape: { ...PARTICLE_PRESETS.smoke.shape, kind: 'sphere', radius: 0.5, volume: 1 },
    startColor: ['#4a4642', '#2e2c2a'],
    colorOverLife: { stops: [{ t: 0, color: '#ffffff', alpha: 0 }, { t: 0.1, color: '#ffffff', alpha: 0.6 }, { t: 1, color: '#ffffff', alpha: 0 }] },
    sizeOverLife: { points: [[0, 0.6], [1, 2.6]] },
    light: { ...PARTICLE_PRESETS.smoke.light, enabled: false },
});

interface Emitter {
    effect: ParticleEffect;
    simulation: ParticleSimulation;
    renderer: ParticleRenderer;
    /** The start colours the effect was last set to. */
    colors: string;
}

const spriteOf = (effect: ParticleEffect): BuiltinSprite =>
    Object.prototype.hasOwnProperty.call(SPRITE_GRIDS, effect.render.sprite) ? (effect.render.sprite as BuiltinSprite) : 'soft';

const emitter = (effect: ParticleEffect, random: () => number): Emitter => {
    const own = JSON.parse(JSON.stringify(effect)) as ParticleEffect;
    const simulation = new ParticleSimulation(own, own.maxParticles, random);
    const renderer = new ParticleRenderer(own.maxParticles);
    const sprite = spriteOf(own);
    renderer.setLook(own, builtinSpriteTexture(sprite), SPRITE_GRIDS[sprite]);
    renderer.object.userData.noWeather = true;
    return { effect: own, simulation, renderer, colors: own.startColor.join() };
};

/** Lighter and darker versions of a colour, for the two ends of a start colour range. */
const shade = (hex: string, amount: number): string => {
    const color = new THREE.Color(hex);
    color.offsetHSL(0, 0, amount);
    return `#${color.getHexString()}`;
};

/** What a surface throws when hit: sparks, dust and chips, or a splash. */
export const impactKind = (surface: SurfaceKind): 'sparks' | 'dust' | 'splash' => {
    if (surface === 'water') return 'splash';
    if (surface === 'metal' || surface === 'asphalt' || surface === 'concrete' || surface === 'default') return 'sparks';
    return 'dust';
};

const IDENTITY = new THREE.Matrix4();

export class ImpactEffects {
    readonly object = new THREE.Group();
    /** The explosion flash; always in the scene, dark while idle, so lit materials never recompile. */
    readonly light = new THREE.PointLight('#ffb060', 0, 30, 2);
    private readonly sparks: Emitter;
    private readonly puff: Emitter;
    private readonly cloud: Emitter;
    private readonly chips: Emitter;
    private readonly splash: Emitter;
    private readonly fireball: Emitter;
    private readonly smoke: Emitter;
    private flash = 0;
    private flashPeak = 0;
    private readonly random: () => number;
    private raycast: ParticleRaycast | null = null;

    constructor(random: () => number = Math.random) {
        this.random = random;
        this.sparks = emitter(SPARKS, random);
        this.puff = emitter(PUFF, random);
        this.cloud = emitter(CLOUD, random);
        this.chips = emitter(CHIPS, random);
        this.splash = emitter(SPLASH, random);
        this.fireball = emitter(FIREBALL, random);
        this.smoke = emitter(SMOKE, random);
        this.object.name = 'ImpactEffects';
        this.object.userData.noWeather = true;
        for (const each of this.emitters) this.object.add(each.renderer.object);
        this.light.name = 'ExplosionFlash';
        this.object.add(this.light);
    }

    private get emitters(): Emitter[] {
        return [this.sparks, this.puff, this.cloud, this.chips, this.splash, this.fireball, this.smoke];
    }

    /** Particles alive across every kind. */
    get alive(): number {
        return this.emitters.reduce((sum, each) => sum + each.simulation.count, 0);
    }

    /** How world collision is queried, for chips and sparks (null: none). */
    setRaycast(raycast: ParticleRaycast | null): void {
        this.raycast = raycast;
    }

    /** A hit on `surface` at `point` facing `normal`; strength 0-1 (a pistol round about 0.3, a blast 1). */
    impact(surface: SurfaceKind, point: Vec3, normal: Vec3, strength: number): void {
        const s = Math.min(1, Math.max(0.05, strength));
        const kind = impactKind(surface);
        const kick = SURFACES[surface].kickColor;
        const out = (speed: number) => [normal.x * speed, normal.y * speed, normal.z * speed] as const;
        const x = point.x + normal.x * 0.02, y = point.y + normal.y * 0.02, z = point.z + normal.z * 0.02;
        if (kind === 'splash') {
            const [vx, vy, vz] = out(1.5);
            this.splash.simulation.emitAt(Math.round(6 + 14 * s), x, y, z, vx, vy + 1, vz);
            return;
        }
        if (kind === 'sparks') {
            const [vx, vy, vz] = out(2.5);
            this.sparks.simulation.emitAt(Math.round(4 + 10 * s), x, y, z, vx, vy, vz);
        }
        // Dust and chips in the surface's colour (a little of both on hard surfaces too).
        this.tint(this.puff, [shade(kick, 0.05), shade(kick, -0.05)]);
        this.tint(this.chips, [shade(kick, 0), shade(kick, -0.15)]);
        const [px, py, pz] = out(0.6);
        this.puff.simulation.emitAt(Math.round((kind === 'dust' ? 3 : 1) + 3 * s), x, y, z, px, py, pz);
        const [cx, cy, cz] = out(2);
        this.chips.simulation.emitAt(Math.round((kind === 'dust' ? 3 : 1) + 6 * s), x, y, z, cx, cy, cz);
    }

    /** An object breaking: a dust cloud the size of it and chips, in `color`. */
    breakApart(centre: Vec3, radius: number, color: string): void {
        const r = Math.max(0.2, radius);
        this.tint(this.cloud, [shade(color, 0.12), shade(color, 0)]);
        this.tint(this.chips, [shade(color, 0), shade(color, -0.2)]);
        // The cloud's puffs grow with the object: a crate puffs, a wall billows.
        this.cloud.effect.size = [0.35 + r * 0.25, 0.6 + r * 0.4];
        this.cloud.simulation.setEffect(this.cloud.effect);
        const puffs = Math.round(Math.min(48, 8 + r * 10));
        for (let i = 0; i < puffs; i++) {
            const a = this.random() * Math.PI * 2, h = this.random() - 0.4, d = Math.sqrt(this.random()) * r * 0.8;
            this.cloud.simulation.emitAt(1, centre.x + Math.cos(a) * d, centre.y + h * r, centre.z + Math.sin(a) * d, Math.cos(a) * 0.7, 0.3, Math.sin(a) * 0.7);
        }
        this.chips.simulation.emitAt(Math.round(Math.min(120, 20 + r * 30)), centre.x, centre.y, centre.z, 0, 1.5, 0);
    }

    /** A blast at `centre` reaching `radius`: fireball, smoke, debris, sparks and a flash. */
    explosion(centre: Vec3, radius: number): void {
        const r = Math.max(0.5, radius);
        const size = Math.min(3, Math.sqrt(r / 4));
        this.fireball.simulation.emitAt(Math.round(30 + 40 * size), centre.x, centre.y, centre.z);
        for (let i = 0; i < Math.round(8 + 10 * size); i++) {
            const a = this.random() * Math.PI * 2;
            this.smoke.simulation.emitAt(1, centre.x + Math.cos(a) * 0.5, centre.y + 0.3, centre.z + Math.sin(a) * 0.5, Math.cos(a) * 1.5 * size, 1.2, Math.sin(a) * 1.5 * size);
        }
        this.tint(this.chips, ['#4a4038', '#2a2622']);
        this.chips.simulation.emitAt(Math.round(40 * size), centre.x, centre.y + 0.2, centre.z, 0, 4 * size, 0);
        this.sparks.simulation.emitAt(Math.round(40 * size), centre.x, centre.y + 0.2, centre.z, 0, 2 * size, 0);
        this.light.position.set(centre.x, centre.y + 1, centre.z);
        this.light.distance = r * 4;
        this.flashPeak = Math.max(this.flashPeak * this.flash, 300 * size);
        this.flash = 1;
    }

    update(dt: number, camera: THREE.Camera): void {
        for (const each of this.emitters) {
            const collide = each === this.chips || each === this.sparks ? this.raycast : null;
            each.simulation.step(dt, null, collide);
            each.simulation.events.length = 0;
            each.renderer.object.visible = each.simulation.count > 0;
            if (each.simulation.count > 0) each.renderer.update(each.simulation, IDENTITY, camera);
        }
        this.flash = Math.max(0, this.flash - dt * 4);
        this.light.intensity = this.flashPeak * this.flash * this.flash;
    }

    dispose(): void {
        for (const each of this.emitters) each.renderer.dispose();
        this.object.removeFromParent();
    }

    private tint(target: Emitter, colors: [string, string]): void {
        const key = colors.join();
        if (target.colors === key) return;
        target.colors = key;
        target.effect.startColor = colors;
        target.simulation.setEffect(target.effect);
    }
}
