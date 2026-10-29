import * as THREE from 'three';
import { PARTICLE_PRESETS, sanitizeParticleEffect, type BuiltinSprite, type ParticleEffect } from './particleEffect';
import { ParticleRenderer } from './particleRenderer';
import { ParticleSimulation, type ParticleHit, type ParticleRaycast } from './particleSimulation';
import { builtinSpriteTexture, SPRITE_GRIDS } from './particleSprites';
import { OPEN_SKY, type WeatherCover } from './weatherCover';
import { windVelocity, type WeatherState } from './weather';

/**
 * PRECIPITATION
 *
 * Rain and snow round the camera, on the particle system: a box of falling drops or flakes, as
 * dense as the weather says, blown by its wind. Particles that drift out of the box wrap round to
 * its other side, so the camera never outruns the weather. They die where they reach what is
 * overhead (the weather cover, so none falls under a roof) or, with no cover known, the ground
 * plane; raindrops splash there and ring ripples on open ground. Brightness follows the light.
 */

/** Half the box's width, m, and how far above the camera it starts. */
const RAIN_HALF = 16;
const RAIN_TOP = 16;
const SNOW_HALF = 16;
const SNOW_TOP = 12;
/** Drops and flakes a second at full strength. */
const RAIN_RATE = 7000;
const SNOW_RATE = 1600;
const RAIN_CAPACITY = 14000;
const SNOW_CAPACITY = 16000;
const SPLASH_CAPACITY = 2400;
const RIPPLE_CAPACITY = 600;
/** Splashes and ripples only where they can be seen, m. */
const SPLASH_RANGE = 20;
const RIPPLE_RANGE = 14;
/** How fast rain falls, m/s (its terminal speed), and snow. */
const RAIN_SPEED = 9.5;
const SNOW_SPEED = 1.1;
/** With no cover known, where the ground is. */
const GROUND_PLANE = 0;

const base = (preset: ParticleEffect, overrides: Partial<ParticleEffect>): ParticleEffect =>
    sanitizeParticleEffect({ ...JSON.parse(JSON.stringify(preset)), ...overrides }, preset);

export const RAIN_EFFECT = base(PARTICLE_PRESETS.rain, {
    rate: 0, maxParticles: RAIN_CAPACITY, lifetime: [(RAIN_TOP + 30) / RAIN_SPEED, (RAIN_TOP + 34) / RAIN_SPEED],
    speed: [RAIN_SPEED * 0.9, RAIN_SPEED * 1.1], size: [0.02, 0.03], gravity: RAIN_SPEED, drag: 1,
    shape: { ...PARTICLE_PRESETS.rain.shape, kind: 'box', size: [RAIN_HALF * 2, 0.1, RAIN_HALF * 2], volume: 1, angle: 1, axis: [0, -1, 0] },
    startColor: ['#b8cce0', '#a4bad0'],
    colorOverLife: { stops: [{ t: 0, color: '#d4e2f2', alpha: 0.5 }, { t: 1, color: '#d4e2f2', alpha: 0.5 }] },
    collision: { mode: 'world', bounce: 0, friction: 0, kill: true },
    subEmitters: [{ trigger: 'collision', target: 'splash', count: 1, inheritVelocity: 0 }],
    render: { ...PARTICLE_PRESETS.rain.render, mode: 'stretched', sprite: 'soft', stretch: 2.6, sort: false, emissive: 1 },
});

export const SNOW_EFFECT = base(PARTICLE_PRESETS.snow, {
    rate: 0, maxParticles: SNOW_CAPACITY, lifetime: [(SNOW_TOP + 14) / SNOW_SPEED, (SNOW_TOP + 18) / SNOW_SPEED],
    speed: [SNOW_SPEED * 0.8, SNOW_SPEED * 1.2], size: [0.045, 0.08], gravity: SNOW_SPEED * 1.2, drag: 1.2, turbulence: 0.9, turbulenceScale: 2.5,
    shape: { ...PARTICLE_PRESETS.snow.shape, kind: 'box', size: [SNOW_HALF * 2, 0.1, SNOW_HALF * 2], volume: 1, angle: 20, axis: [0, -1, 0] },
    collision: { mode: 'world', bounce: 0, friction: 0, kill: true },
    render: { ...PARTICLE_PRESETS.snow.render, sprite: 'snowflake', sort: false, emissive: 1 },
});

export const SPLASH_EFFECT = base(PARTICLE_PRESETS.sparks, {
    rate: 0, bursts: [], loop: true, maxParticles: SPLASH_CAPACITY, lifetime: [0.18, 0.32], speed: [0.9, 1.8], size: [0.012, 0.02],
    shape: { ...PARTICLE_PRESETS.sparks.shape, kind: 'hemisphere', radius: 0.02, angle: 50, axis: [0, 1, 0] },
    gravity: 9.8, drag: 0, startColor: ['#d0e0f0', '#c0d0e4'],
    colorOverLife: { stops: [{ t: 0, color: '#d8e8f8', alpha: 0.55 }, { t: 1, color: '#d8e8f8', alpha: 0 }] },
    collision: { mode: 'none', bounce: 0, friction: 0, kill: false },
    render: { ...PARTICLE_PRESETS.sparks.render, mode: 'stretched', sprite: 'droplet', blending: 'alpha', emissive: 1, stretch: 0.06, sort: false },
    light: { ...PARTICLE_PRESETS.sparks.light, enabled: false },
});

export const RIPPLE_EFFECT = base(PARTICLE_PRESETS.shockwave, {
    rate: 0, bursts: [], loop: true, maxParticles: RIPPLE_CAPACITY, lifetime: [0.35, 0.55], speed: [0, 0], size: [0.12, 0.2],
    shape: { ...PARTICLE_PRESETS.shockwave.shape, kind: 'point', radius: 0, angle: 0, axis: [0, 1, 0] },
    gravity: 0, drag: 0, startColor: ['#e0ecf8', '#e0ecf8'],
    colorOverLife: { stops: [{ t: 0, color: '#e0ecf8', alpha: 0.35 }, { t: 1, color: '#e0ecf8', alpha: 0 }] },
    sizeOverLife: { points: [[0, 0.3], [1, 1.6]] },
    render: { ...PARTICLE_PRESETS.shockwave.render, mode: 'horizontal', sprite: 'ring', blending: 'alpha', emissive: 1, sort: false },
    light: { ...PARTICLE_PRESETS.shockwave.light, enabled: false },
});

const spriteOf = (effect: ParticleEffect): BuiltinSprite =>
    Object.prototype.hasOwnProperty.call(SPRITE_GRIDS, effect.render.sprite) ? (effect.render.sprite as BuiltinSprite) : 'soft';

interface Layer {
    effect: ParticleEffect;
    simulation: ParticleSimulation;
    renderer: ParticleRenderer;
    brightness: number;
}

const layer = (effect: ParticleEffect, capacity: number, cheapCollision: boolean): Layer => {
    const own = JSON.parse(JSON.stringify(effect)) as ParticleEffect;
    const simulation = new ParticleSimulation(own, capacity);
    if (cheapCollision) simulation.collisionBudget = Infinity;
    const renderer = new ParticleRenderer(capacity);
    const sprite = spriteOf(own);
    renderer.setLook(own, builtinSpriteTexture(sprite), SPRITE_GRIDS[sprite]);
    renderer.object.userData.noWeather = true;
    return { effect: own, simulation, renderer, brightness: own.render.emissive };
};

const IDENTITY = new THREE.Matrix4();
const _camera = new THREE.Vector3();
const _emitter = new THREE.Matrix4();
const _hit: ParticleHit = { x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0 };

export class Precipitation {
    readonly object = new THREE.Group();
    private readonly rain = layer(RAIN_EFFECT, RAIN_CAPACITY, true);
    private readonly snow = layer(SNOW_EFFECT, SNOW_CAPACITY, true);
    private readonly splash = layer(SPLASH_EFFECT, SPLASH_CAPACITY, false);
    private readonly ripple = layer(RIPPLE_EFFECT, RIPPLE_CAPACITY, false);
    private cover: WeatherCover | null = null;
    private readonly random: () => number;
    /** Where what falls stops: the cover's top, or the ground plane. */
    private readonly landing: ParticleRaycast = (_fx, _fy, _fz, tx, ty, tz) => {
        const top = this.cover ? this.cover.heightAt(tx, tz) : GROUND_PLANE;
        if (top <= OPEN_SKY || ty > top) return null;
        _hit.x = tx;
        _hit.y = top;
        _hit.z = tz;
        return _hit;
    };

    constructor(random: () => number = Math.random) {
        this.random = random;
        this.object.name = 'Precipitation';
        this.object.userData.noWeather = true;
        for (const each of [this.rain, this.snow, this.splash, this.ripple]) this.object.add(each.renderer.object);
    }

    /** Raindrops and snowflakes alive. */
    get alive(): { rain: number; snow: number; splashes: number } {
        return { rain: this.rain.simulation.count, snow: this.snow.simulation.count, splashes: this.splash.simulation.count };
    }

    /**
     * One frame: emits as the weather says round the camera, moves everything on and draws it.
     * `cover` is what is overhead (null: none known, so the ground plane); `light` 0-1 how lit it is.
     */
    update(dt: number, camera: THREE.Camera, weather: WeatherState, cover: WeatherCover | null, light: number): void {
        this.cover = cover;
        camera.getWorldPosition(_camera);
        const [wx, wz] = windVelocity(weather);
        // Rain and snow catch the sky's light from all round, so they stay faintly visible at night.
        const brightness = 0.22 + 0.78 * light;

        this.fall(this.rain, dt, weather.rain > 0.002 ? RAIN_RATE * weather.rain ** 1.3 : 0, RAIN_TOP, RAIN_HALF, wx, wz, camera, brightness);
        // White flakes catch more of what light there is than raindrops.
        this.fall(this.snow, dt, weather.snow > 0.002 ? SNOW_RATE * weather.snow : 0, SNOW_TOP, SNOW_HALF, wx * 0.8, wz * 0.8, camera, Math.min(1, 0.4 + 0.6 * light));

        // Raindrops that landed near enough splash, and ring ripples on open ground.
        const events = this.rain.simulation.events;
        for (const event of events) {
            const distance = Math.hypot(event.x - _camera.x, event.z - _camera.z);
            if (distance > SPLASH_RANGE || this.random() > 0.45) continue;
            this.splash.simulation.emitAt(2, event.x, event.y + 0.01, event.z);
            if (distance < RIPPLE_RANGE && this.random() < 0.5) this.ripple.simulation.emitAt(1, event.x, event.y + 0.015, event.z);
        }
        events.length = 0;
        this.snow.simulation.events.length = 0;
        for (const each of [this.splash, this.ripple]) {
            each.simulation.step(dt, null);
            this.light(each, brightness);
            each.renderer.update(each.simulation, IDENTITY, camera);
        }
    }

    private fall(part: Layer, dt: number, rate: number, top: number, half: number, wx: number, wz: number, camera: THREE.Camera, brightness: number): void {
        const { effect, simulation } = part;
        effect.rate = rate;
        // Wind, as a pull toward moving with it (drag 1 makes its speed the wind's).
        effect.wind[0] = wx * effect.drag;
        effect.wind[2] = wz * effect.drag;
        if (rate === 0 && simulation.count === 0) {
            part.renderer.object.visible = false;
            return;
        }
        part.renderer.object.visible = true;
        _emitter.makeTranslation(_camera.x, _camera.y + top, _camera.z);
        simulation.step(dt, _emitter.elements, this.landing);
        // Wrapped round the box, so the camera never leaves the weather behind.
        const p = simulation.positions;
        const span = half * 2;
        for (let i = 0; i < simulation.count; i++) {
            const v = i * 3;
            const dx = p[v] - _camera.x, dz = p[v + 2] - _camera.z;
            if (dx > half) p[v] -= span;
            else if (dx < -half) p[v] += span;
            if (dz > half) p[v + 2] -= span;
            else if (dz < -half) p[v + 2] += span;
        }
        this.light(part, brightness);
        part.renderer.update(simulation, IDENTITY, camera);
    }

    private light(part: Layer, brightness: number): void {
        if (Math.abs(part.brightness - brightness) < 0.02) return;
        part.brightness = brightness;
        part.effect.render.emissive = brightness;
        const sprite = spriteOf(part.effect);
        part.renderer.setLook(part.effect, builtinSpriteTexture(sprite), SPRITE_GRIDS[sprite]);
    }

    dispose(): void {
        for (const each of [this.rain, this.snow, this.splash, this.ripple]) each.renderer.dispose();
        this.object.removeFromParent();
    }
}
