import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PARTICLE_EFFECT, GPU_PARTICLE_LIMIT, PARTICLE_PRESETS, RUNTIME_PARTICLE_LIMIT, particleLimits, resolveParticleEffect,
  sanitizeParticleEffect, type ParticleEffect,
} from '../../runtime/particleEffect';
import { EmissionClock, GpuParticleSystem, MESH_SIDE, sampleSurface, stateSize } from '../../runtime/gpuParticles';

/*
 * GPU particles, CPU side: the effect's simulation choice and its limits, the emission clock, the state
 * texture layout, surface sampling, and what the system hands its simulation pass each step. The passes
 * themselves run in the engine.
 */

const effectWith = (overrides: Partial<ParticleEffect>): ParticleEffect =>
  sanitizeParticleEffect({ ...DEFAULT_PARTICLE_EFFECT, simulation: 'gpu', ...overrides });

/** A renderer that draws nothing and records each target drawn into. */
const fakeRenderer = () => {
  const drawn: unknown[] = [];
  const cleared: unknown[] = [];
  let target: unknown = null;
  const renderer = {
    getRenderTarget: () => target,
    setRenderTarget: (next: unknown) => { target = next; },
    getClearColor: (into: THREE.Color) => into.set(0x112233),
    getClearAlpha: () => 1,
    setClearColor: () => undefined,
    clear: () => { cleared.push(target); },
    render: () => { drawn.push(target); },
  };
  return { renderer: renderer as unknown as THREE.WebGLRenderer, drawn, cleared, target: () => target };
};

const uniforms = (system: GpuParticleSystem) =>
  (system as unknown as { simulation: { material: THREE.ShaderMaterial } }).simulation.material.uniforms;

describe('gpu particle effects', () => {
  it('chooses where an effect simulates, with limits to match', () => {
    expect(DEFAULT_PARTICLE_EFFECT.simulation).toBe('cpu');
    expect(particleLimits('cpu').particles).toBe(RUNTIME_PARTICLE_LIMIT);
    expect(particleLimits('gpu').particles).toBe(GPU_PARTICLE_LIMIT);
    // A CPU effect is held to the CPU's limits; the same numbers stand on the GPU.
    const huge = { rate: 400000, maxParticles: 900000, bursts: [{ time: 0, count: 300000 }] };
    expect(sanitizeParticleEffect({ ...huge })).toMatchObject({ simulation: 'cpu', rate: 5000, maxParticles: RUNTIME_PARTICLE_LIMIT });
    expect(sanitizeParticleEffect({ ...huge }).bursts[0].count).toBe(5000);
    const gpu = sanitizeParticleEffect({ ...huge, simulation: 'gpu' });
    expect(gpu).toMatchObject({ simulation: 'gpu', rate: 400000, maxParticles: 900000 });
    expect(gpu.bursts[0].count).toBe(300000);
    expect(sanitizeParticleEffect({ simulation: 'quantum' }).simulation).toBe('cpu');
  });

  it('offers presets too big for the CPU', () => {
    for (const id of ['fountain', 'swarm', 'downpour'] as const) {
      const preset = PARTICLE_PRESETS[id];
      expect(preset.simulation).toBe('gpu');
      expect(preset.maxParticles).toBeGreaterThan(RUNTIME_PARTICLE_LIMIT);
      expect(resolveParticleEffect({ preset: id })).toEqual(preset);
    }
  });
});

describe('emission clock', () => {
  it('counts the rate evenly, waits out the delay and fires bursts once per cycle', () => {
    const clock = new EmissionClock();
    const effect = effectWith({ rate: 100, delay: 0.5, duration: 1, loop: true, bursts: [{ time: 0.25, count: 7 }] });
    expect(clock.advance(effect, 0.1, 0)).toEqual({ trail: 0, cycle: 0 });
    clock.play();
    expect(clock.advance(effect, 0.5, 0).cycle).toBe(0);
    let total = 0;
    for (let i = 0; i < 20; i++) total += clock.advance(effect, 0.1, 0).cycle;
    // Two seconds after the delay: 200 at the rate and the burst in each of two cycles.
    expect(total).toBe(200 + 14);
  });

  it('ends a one-shot effect after its cycle and lays trails by distance', () => {
    const clock = new EmissionClock();
    clock.play();
    const once = effectWith({ rate: 0, loop: false, duration: 0.5, bursts: [{ time: 0, count: 30 }] });
    expect(clock.advance(once, 0.1, 0).cycle).toBe(30);
    for (let i = 0; i < 5; i++) clock.advance(once, 0.1, 0);
    expect(clock.finished).toBe(true);
    expect(clock.advance(once, 0.1, 0).cycle).toBe(0);

    const trail = new EmissionClock();
    trail.play();
    const along = effectWith({ rate: 0, rateOverDistance: 4 });
    expect(trail.advance(along, 0.1, 2.5).trail).toBe(10);
    // Fractions carry over.
    expect(trail.advance(along, 0.1, 0.1).trail + trail.advance(along, 0.1, 0.15).trail).toBe(1);
  });
});

describe('gpu particle state', () => {
  it('lays particles out in a square-ish texture just big enough', () => {
    expect(stateSize(1)).toEqual([1, 1]);
    expect(stateSize(100)).toEqual([10, 10]);
    expect(stateSize(101)).toEqual([11, 10]);
    expect(stateSize(GPU_PARTICLE_LIMIT)).toEqual([1024, 1024]);
  });

  it('samples points over a surface by area, with their faces\' normals', () => {
    // A big floor quad and a tiny wall triangle: nearly every point lands on the floor.
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10, 0, 0, 0, 0, 0.1, 0, 0.1, 0, 0]);
    const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6]);
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const { points, normals } = sampleSurface({ positions, indices }, 500, random);
    let onFloor = 0;
    for (let i = 0; i < 500; i++) {
      const x = points[i * 4], y = points[i * 4 + 1], z = points[i * 4 + 2];
      expect(x).toBeGreaterThanOrEqual(-1e-6);
      expect(x).toBeLessThanOrEqual(10 + 1e-6);
      expect(z).toBeLessThanOrEqual(10 + 1e-6);
      if (Math.abs(y) < 1e-6 && normals[i * 4 + 1] > 0.99) onFloor++;
    }
    expect(onFloor).toBeGreaterThan(495);
    // Nothing to sample: all zeros.
    expect(sampleSurface({ positions: new Float32Array(), indices: new Uint32Array() }, 4).points.every(v => v === 0)).toBe(true);
  });
});

describe('gpu particle system', () => {
  it('takes an effect into its passes: shape, forces, life curves and look', () => {
    const system = new GpuParticleSystem(1000);
    expect([system.width, system.height]).toEqual(stateSize(1000));
    const effect = effectWith({ shape: { ...DEFAULT_PARTICLE_EFFECT.shape, kind: 'box', angle: 90 }, lifetime: [1, 2], gravity: 4, orbit: 2 });
    system.setEffect(effect);
    const u = uniforms(system);
    const defines = (system as unknown as { simulation: { material: THREE.ShaderMaterial } }).simulation.material.defines;
    expect(defines.SHAPE).toBe(4);
    expect(u.shapeAngle.value).toBeCloseTo(Math.PI / 2);
    expect((u.lifetime.value as THREE.Vector2).toArray()).toEqual([1, 2]);
    expect(u.orbit.value).toBe(2);

    system.setLook({ ...effect, render: { ...effect.render, mode: 'ribbon', blending: 'additive', frameMode: 'fps' } }, new THREE.Texture(), [4, 2]);
    const draw = (system.object.children[0] as THREE.Mesh).material as THREE.ShaderMaterial;
    // Ribbons draw as camera-facing quads; additive blending; the flipbook grid.
    expect(draw.defines).toMatchObject({ MODE: 0, FRAME_MODE: 1, ADDITIVE: '' });
    expect(draw.blending).toBe(THREE.AdditiveBlending);
    expect((draw.uniforms.uGrid.value as THREE.Vector2).toArray()).toEqual([4, 2]);
    expect((system.object.children[0] as THREE.InstancedMesh).geometry).toBeInstanceOf(THREE.InstancedBufferGeometry);
    expect(((system.object.children[0] as THREE.Mesh).geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(1000);
    system.dispose();
  });

  it('spawns round a ring of slots each step, ping-ponging its state and leaving the renderer as it was', () => {
    const system = new GpuParticleSystem(100);
    system.setEffect(effectWith({ rate: 600, lifetime: [1, 1] }));
    const { renderer, drawn, cleared, target } = fakeRenderer();
    const u = uniforms(system);
    const at = new THREE.Matrix4();

    // Not playing: steps but spawns nothing; the first step clears both state targets.
    system.step(renderer, 0.05, at, null);
    expect(cleared).toHaveLength(2);
    expect(u.cycleCount.value).toBe(0);
    expect(target()).toBeNull();

    system.play();
    system.step(renderer, 0.05, at, null);
    expect(u.cycleCount.value).toBe(30);
    expect(u.emitStart.value).toBe(0);
    const firstRead = u.positionAge.value;
    system.step(renderer, 0.05, at, null);
    expect(u.emitStart.value).toBe(30);
    expect(u.positionAge.value).not.toBe(firstRead);
    expect(drawn).toHaveLength(3);
    expect(system.count).toBe(60);

    // Round the ring: the fourth step starts at slot 90 and wraps.
    system.step(renderer, 0.05, at, null);
    system.step(renderer, 0.05, at, null);
    expect(u.emitStart.value).toBe(90);
    // Never more alive than it holds.
    expect(system.count).toBe(100);
    system.dispose();
  });

  it('gives way in proportion when a step asks for more than it holds', () => {
    const system = new GpuParticleSystem(50);
    system.setEffect(effectWith({ rate: 0, bursts: [{ time: 0, count: 200 }], rateOverDistance: 100, lifetime: [1, 1] }));
    const { renderer } = fakeRenderer();
    system.play();
    system.step(renderer, 0.02, new THREE.Matrix4(), null);
    // Moving 1 m lays 100 more along the path: 300 asked of 50 slots.
    system.step(renderer, 0.02, new THREE.Matrix4().makeTranslation(1, 0, 0), null);
    const u = uniforms(system);
    expect(u.trailCount.value + u.cycleCount.value + u.pointCount.value).toBeLessThanOrEqual(50);
    system.dispose();
  });

  it('bursts at points, one burst a step, with their velocity', () => {
    const system = new GpuParticleSystem(500);
    system.setEffect(effectWith({ rate: 0, lifetime: [0.5, 0.5] }));
    const { renderer } = fakeRenderer();
    system.emitAt(20, 1, 2, 3, 0, 5, 0);
    system.emitAt(10, -1, 0, 0);
    expect(system.isDone).toBe(false);
    const u = uniforms(system);
    system.step(renderer, 0.05, new THREE.Matrix4(), null);
    expect(u.pointCount.value).toBe(20);
    expect((u.pointPosition.value as THREE.Vector3).toArray()).toEqual([1, 2, 3]);
    expect((u.pointVelocity.value as THREE.Vector3).toArray()).toEqual([0, 5, 0]);
    system.step(renderer, 0.05, new THREE.Matrix4(), null);
    expect(u.pointCount.value).toBe(10);
    expect(system.count).toBe(30);
    // Once their lives are over it is done.
    for (let i = 0; i < 12; i++) system.step(renderer, 0.05, new THREE.Matrix4(), null);
    expect(system.count).toBe(0);
    expect(system.isDone).toBe(true);
    system.dispose();
  });

  it('collides with the ground it is given, feels forces in its own space when local, and clears on a hard stop', () => {
    const system = new GpuParticleSystem(100);
    const { renderer, cleared } = fakeRenderer();
    const u = uniforms(system);
    const turned = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
    system.setEffect(effectWith({ collision: { mode: 'world', bounce: 0.5, friction: 0.2, kill: false }, gravity: 10, wind: [0, 0, 0] }));
    system.step(renderer, 0.02, turned, 1.5);
    expect(u.collide.value).toBe(1);
    expect(u.groundY.value).toBe(1.5);
    expect((u.force.value as THREE.Vector3).toArray()).toEqual([0, -10, 0]);
    system.step(renderer, 0.02, turned, null);
    expect(u.collide.value).toBe(0);

    system.setEffect(effectWith({ space: 'local', gravity: 10, collision: { mode: 'world', bounce: 0.5, friction: 0.2, kill: false } }));
    system.step(renderer, 0.02, turned, 1.5);
    // Down, turned into a frame rolled a quarter turn about Z.
    const force = (u.force.value as THREE.Vector3);
    expect(force.x).toBeCloseTo(-10);
    expect(force.y).toBeCloseTo(0);
    // Local particles never collide with the world.
    expect(u.collide.value).toBe(0);

    const before = cleared.length;
    system.stop(true);
    system.step(renderer, 0.02, turned, null);
    expect(cleared.length).toBe(before + 2);
    system.dispose();
  });

  it('takes a model surface for the mesh shape, or none', () => {
    const system = new GpuParticleSystem(10);
    const u = uniforms(system);
    system.setMeshSurface({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) });
    expect(u.meshCount.value).toBe(MESH_SIDE * MESH_SIDE);
    system.setMeshSurface(null);
    expect(u.meshCount.value).toBe(0);
    system.dispose();
  });
});
