import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  EDITOR_PARTICLE_LIMIT,
  MAX_PARTICLE_STEP,
  PARTICLE_PRESETS,
  PARTICLES_COMPONENT,
  createParticlePool,
  fitParticleBudget,
  particleCapacity,
  resetParticlePool,
  resolveParticleSettings,
  stepParticles,
  type ParticleSettings,
} from '../../runtime/components/particles';

/** Deterministic 0..1 sequence (mulberry32). */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const custom = (overrides: Record<string, unknown> = {}): ParticleSettings => resolveParticleSettings({
  preset: 'custom', rate: 0, burst: 0, loop: true, lifetime: 1, speed: 0, spread: 0, size: 0.5,
  colorStart: '#ffffff', colorEnd: '#000000', gravity: 0, ...overrides,
});

const defaults = () => Object.fromEntries(PARTICLES_COMPONENT.props.map(prop => [prop.key, prop.default]));

describe('particles settings', () => {
  it('declares a renderable component whose defaults resolve to the smoke preset', () => {
    expect(PARTICLES_COMPONENT.type).toBe('particles');
    expect(typeof PARTICLES_COMPONENT.Render).toBe('function');
    expect(PARTICLES_COMPONENT.props.map(prop => prop.key)).toEqual([
      'preset', 'rate', 'lifetime', 'speed', 'spread', 'size', 'colorStart', 'colorEnd', 'gravity', 'burst', 'loop',
    ]);
    for (const prop of PARTICLES_COMPONENT.props) {
      if (prop.type === 'select') expect(prop.options?.map(option => option.value)).toContain(prop.default);
      if (prop.type === 'number' && prop.min !== undefined) expect(prop.default as number).toBeGreaterThanOrEqual(prop.min);
      if (prop.type === 'number' && prop.max !== undefined) expect(prop.default as number).toBeLessThanOrEqual(prop.max);
    }
    expect(resolveParticleSettings(defaults())).toMatchObject({ preset: 'smoke', ...PARTICLE_PRESETS.smoke, rate: 20, burst: 0, loop: true });
    // A Custom emitter starts from the same look the fields show.
    expect(resolveParticleSettings({ ...defaults(), preset: 'custom' })).toMatchObject({
      lifetime: PARTICLE_PRESETS.smoke.lifetime, colorStart: PARTICLE_PRESETS.smoke.colorStart, gravity: PARTICLE_PRESETS.smoke.gravity,
    });
  });

  it('takes the look from a named preset but rate, burst and loop from the fields', () => {
    const fire = resolveParticleSettings({ ...defaults(), preset: 'fire', size: 9, colorStart: '#00ff00', rate: 55, burst: 4, loop: false });
    expect(fire).toMatchObject({ ...PARTICLE_PRESETS.fire, preset: 'fire', rate: 55, burst: 4, loop: false });

    const own = resolveParticleSettings({ ...defaults(), preset: 'custom', size: 9, colorStart: '#00ff00', gravity: -3 });
    expect(own).toMatchObject({ preset: 'custom', size: 9, colorStart: '#00ff00', gravity: -3 });
  });

  it('falls back and clamps malformed or out-of-range props', () => {
    const settings = resolveParticleSettings({
      preset: 'lava', rate: -5, burst: 4.6, loop: 'yes',
    });
    expect(settings).toMatchObject({ preset: 'smoke', rate: 0, burst: 5, loop: true });

    const wild = resolveParticleSettings({
      preset: 'custom', lifetime: 0, speed: Number.NaN, spread: 720, size: -1, colorStart: 'red', colorEnd: '#12345', gravity: 1e6,
    });
    expect(wild).toMatchObject({
      lifetime: 0.05, speed: PARTICLE_PRESETS.smoke.speed, spread: 180, size: 0.01,
      colorStart: PARTICLE_PRESETS.smoke.colorStart, colorEnd: PARTICLE_PRESETS.smoke.colorEnd, gravity: 100,
    });
  });

  it('keeps big emitters within budget and sizes pools in powers of two', () => {
    const heavy = custom({ rate: 1000, lifetime: 30, burst: 1000 });
    const fitted = fitParticleBudget(heavy, EDITOR_PARTICLE_LIMIT);
    expect(fitted.rate).toBeLessThan(heavy.rate);
    expect(fitted.lifetime).toBe(heavy.lifetime);
    expect(particleCapacity(fitted, EDITOR_PARTICLE_LIMIT)).toBe(EDITOR_PARTICLE_LIMIT);

    const light = custom({ rate: 10, lifetime: 1 });
    expect(fitParticleBudget(light, EDITOR_PARTICLE_LIMIT)).toBe(light);
    const capacity = particleCapacity(light, EDITOR_PARTICLE_LIMIT);
    expect(Math.log2(capacity) % 1).toBe(0);
    expect(capacity).toBeGreaterThanOrEqual(10 * 1 * (1 + light.variance));
  });
});

describe('stepParticles', () => {
  it('emits the continuous rate evenly, packed at the front of the pool', () => {
    const settings = custom({ rate: 60, lifetime: 10 });
    const pool = createParticlePool(1024);
    const random = seeded(1);
    for (let frame = 0; frame < 30; frame++) stepParticles(pool, settings, 1 / 60, null, random);
    expect(pool.count).toBe(30);
    // Each frame's particles are spread across the frame, so ages are all distinct and in range.
    const ages = Array.from(pool.ages.subarray(0, pool.count));
    expect(new Set(ages).size).toBe(ages.length);
    expect(Math.max(...ages)).toBeLessThanOrEqual(0.5 + 1e-6);
    expect(pool.life[0]).toBeCloseTo(pool.ages[0] / pool.lifetimes[0], 6);
  });

  it('retires particles at the end of their lifetime and keeps the rest packed', () => {
    const settings = { ...custom({ rate: 0, burst: 10, lifetime: 0.5, loop: false }), variance: 0 };
    const pool = createParticlePool(64);
    stepParticles(pool, settings, 0, null, seeded(2));
    expect(pool.count).toBe(10);
    stepParticles(pool, settings, 0.1, null, seeded(3));
    expect(pool.count).toBe(10);
    for (let frame = 0; frame < 5; frame++) stepParticles(pool, settings, 0.1, null, seeded(4));
    expect(pool.count).toBe(0);
    expect(pool.finished).toBe(true);
    // Finished one-shot emitters stay quiet until reset.
    stepParticles(pool, settings, 0.1, null, seeded(5));
    expect(pool.count).toBe(0);
    resetParticlePool(pool);
    stepParticles(pool, settings, 0, null, seeded(6));
    expect(pool.count).toBe(10);
  });

  it('repeats the burst every cycle when looping, and only once otherwise', () => {
    // Frames of 1/16 s against 1/4 s cycles land exactly on each cycle boundary.
    const step = 1 / 16;
    const looping = { ...custom({ rate: 0, burst: 3, lifetime: 0.25, loop: true }), variance: 0 };
    const pool = createParticlePool(64);
    const random = seeded(14);
    for (let frame = 0; frame < 16; frame++) {
      stepParticles(pool, looping, step, null, random);
      // Each burst dies exactly as the next cycle's burst is emitted, aged 0 at the boundary.
      expect(pool.count).toBe(3);
      if (frame % 4 === 3) expect(Array.from(pool.ages.subarray(0, 3))).toEqual([0, 0, 0]);
    }

    const once = { ...looping, loop: false };
    const single = createParticlePool(64);
    for (let frame = 0; frame < 16; frame++) stepParticles(single, once, step, null, random);
    expect(single.count).toBe(0);
    expect(single.finished).toBe(true);
  });

  it('launches inside the cone around the emitter up axis, transformed by its world matrix', () => {
    const settings = custom({ burst: 200, speed: 2, spread: 30, lifetime: 5, loop: false });
    const emitter = new THREE.Matrix4().compose(
      new THREE.Vector3(5, 1, -2),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2),
      new THREE.Vector3(1, 1, 1),
    );
    const pool = createParticlePool(256);
    stepParticles(pool, settings, 0, emitter.elements, seeded(7));
    expect(pool.count).toBe(200);
    // Rotated -90 deg about Z, local +Y points along world +X.
    const axis = new THREE.Vector3(1, 0, 0);
    const direction = new THREE.Vector3();
    for (let i = 0; i < pool.count; i++) {
      expect([pool.positions[i * 3], pool.positions[i * 3 + 1], pool.positions[i * 3 + 2]]).toEqual([5, 1, -2]);
      direction.fromArray(pool.velocities, i * 3).normalize();
      expect(THREE.MathUtils.radToDeg(direction.angleTo(axis))).toBeLessThanOrEqual(30 + 1e-3);
    }
  });

  it('pulls particles down with gravity, damps them with drag, and clamps long frames', () => {
    const settings = { ...custom({ burst: 1, gravity: 10, lifetime: 10, loop: false }), drag: 0 };
    const pool = createParticlePool(4);
    stepParticles(pool, settings, 0, null, seeded(8));
    stepParticles(pool, settings, 5, null, seeded(9));
    // A 5 s hitch only advances one capped step.
    expect(pool.ages[0]).toBeCloseTo(MAX_PARTICLE_STEP, 6);
    expect(pool.velocities[1]).toBeCloseTo(-10 * MAX_PARTICLE_STEP, 5);
    expect(pool.positions[1]).toBeLessThan(0);

    const damped = { ...custom({ burst: 1, speed: 4, lifetime: 10, loop: false }), drag: 2, variance: 0 };
    const dampedPool = createParticlePool(4);
    stepParticles(dampedPool, damped, 0, null, seeded(10));
    stepParticles(dampedPool, damped, 0.1, null, seeded(11));
    expect(dampedPool.velocities[1]).toBeCloseTo(4 * Math.exp(-0.2), 5);
  });

  it('drops emissions once the pool is full and ignores bad deltas', () => {
    const settings = custom({ burst: 50, lifetime: 5 });
    const pool = createParticlePool(8);
    stepParticles(pool, settings, Number.NaN, null, seeded(12));
    expect(pool.count).toBe(8);
    stepParticles(pool, settings, -1, null, seeded(13));
    expect(pool.count).toBe(8);
    expect(Array.from(pool.positions).every(Number.isFinite)).toBe(true);
  });
});
