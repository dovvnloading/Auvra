import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { getComponentDefinition } from '../../runtime/components/registry';
import {
  bakeCurve,
  bakeGradient,
  BAKE_SAMPLES,
  DEFAULT_PARTICLE_EFFECT,
  estimateParticles,
  evaluateCurve,
  PARTICLE_PRESET_IDS,
  PARTICLE_PRESETS,
  resolveParticleEffect,
  sanitizeParticleEffect,
  type ParticleEffect,
} from '../../runtime/particleEffect';
import { MAX_PARTICLE_STEP, ParticleSimulation, type ParticleHit } from '../../runtime/particleSimulation';
import { ParticleRenderer } from '../../runtime/particleRenderer';
import { particleEmitters } from '../../runtime/particleEmitters';
import { flowNodeOutputValue, type FlowNode } from '../../hooks/levelBlueprintNodes/flow';
import { WORLD_NODE_DEFINITIONS, WORLD_NODE_EXECUTORS, type WorldNodeServices, type WorldNodeType } from '../../hooks/levelBlueprintNodes/world';
import { createLevelVariablesStore } from '../../runtime/levelVariables';
import { parseScriptCommand } from '../../runtime/scripting/ScriptRuntime';

/** A deterministic random, so particle tests do not flake. */
const seeded = (seed = 1) => {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
};

const effectOf = (overrides: Record<string, unknown>): ParticleEffect => sanitizeParticleEffect({ ...DEFAULT_PARTICLE_EFFECT, ...overrides });
const still = { gravity: 0, drag: 0, turbulence: 0, wind: [0, 0, 0], speed: [0, 0] };
const translate = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z).elements;

describe('particle effects', () => {
  it('declares a renderable component that plays on start and resolves to smoke by default', () => {
    const definition = getComponentDefinition('particles')!;
    expect(typeof definition.Render).toBe('function');
    expect(definition.props.find(prop => prop.key === 'playOnStart')?.default).toBe(true);
    expect(resolveParticleEffect({})).toEqual(PARTICLE_PRESETS.smoke);
  });

  it('keeps every preset in range and gives each a distinct look', () => {
    expect(PARTICLE_PRESET_IDS.length).toBeGreaterThanOrEqual(15);
    for (const id of PARTICLE_PRESET_IDS) expect(sanitizeParticleEffect(PARTICLE_PRESETS[id])).toEqual(PARTICLE_PRESETS[id]);
    expect(PARTICLE_PRESETS.rain.shape.axis).toEqual([0, -1, 0]);
    expect(PARTICLE_PRESETS.sparks.render.mode).toBe('stretched');
    expect(PARTICLE_PRESETS.trail.render.mode).toBe('ribbon');
  });

  it("keeps an older emitter's look: the preset, with its rate, burst and loop, and Custom's own fields", () => {
    const fire = resolveParticleEffect({ preset: 'fire', rate: 5, burst: 12, loop: false });
    expect(fire.render.sprite).toBe(PARTICLE_PRESETS.fire.render.sprite);
    expect(fire.rate).toBe(5);
    expect(fire.bursts).toEqual([{ time: 0, count: 12 }]);
    expect(fire.loop).toBe(false);
    const custom = resolveParticleEffect({ preset: 'custom', lifetime: 2, speed: 4, spread: 50, size: 1, colorStart: '#ff0000', colorEnd: '#0000ff', gravity: 3 });
    expect(custom.lifetime).toEqual([1.6, 2.4]);
    expect(custom.shape).toMatchObject({ kind: 'point', angle: 50 });
    expect(custom.gravity).toBe(3);
    expect(custom.colorOverLife.stops[1].color).toBe('#ff0000');
    expect(custom.colorOverLife.stops[3].color).toBe('#0000ff');
    // An inspector-written effect wins over the plain fields.
    expect(resolveParticleEffect({ preset: 'fire', rate: 5, effect: { ...PARTICLE_PRESETS.snow } }).rate).toBe(PARTICLE_PRESETS.snow.rate);
  });

  it('clamps, orders and defaults malformed stored effects', () => {
    const effect = sanitizeParticleEffect({
      rate: -4, lifetime: [5, 1], speed: 'fast', maxParticles: 1e9, shape: { kind: 'teapot', angle: 900 },
      colorOverLife: { stops: [{ t: 0.8, color: 'red', alpha: 3 }, { t: 0.2, color: '#00ff00', alpha: 0.5 }] },
      sizeOverLife: { points: [[1, 2], [0, 'x'], 'bad'] }, render: { mode: 'hologram', sprite: '../etc' }, bursts: [{ time: -1, count: 3.6 }],
    });
    expect(effect.rate).toBe(0);
    expect(effect.lifetime).toEqual([1, 5]);
    expect(effect.speed).toEqual(DEFAULT_PARTICLE_EFFECT.speed);
    expect(effect.maxParticles).toBe(20000);
    expect(effect.shape.kind).toBe(DEFAULT_PARTICLE_EFFECT.shape.kind);
    expect(effect.shape.angle).toBe(180);
    expect(effect.colorOverLife.stops.map(stop => stop.t)).toEqual([0.2, 0.8]);
    expect(effect.colorOverLife.stops[1]).toEqual({ t: 0.8, color: '#ffffff', alpha: 1 });
    expect(effect.sizeOverLife.points).toEqual([[0, 1], [1, 2]]);
    expect(effect.render.mode).toBe('billboard');
    expect(effect.render.sprite).toBe(DEFAULT_PARTICLE_EFFECT.render.sprite);
    expect(effect.bursts).toEqual([{ time: 0, count: 4 }]);
  });

  it('bakes gradients and curves across the life, holding them flat past their ends', () => {
    expect(evaluateCurve([[0.2, 1], [0.6, 3]], 0)).toBe(1);
    expect(evaluateCurve([[0.2, 1], [0.6, 3]], 0.4)).toBeCloseTo(2, 9);
    expect(evaluateCurve([[0.2, 1], [0.6, 3]], 1)).toBe(3);
    const curve = bakeCurve({ points: [[0, 0], [1, 10]] });
    expect(curve[0]).toBe(0);
    expect(curve[BAKE_SAMPLES - 1]).toBe(10);
    const gradient = bakeGradient({ stops: [{ t: 0, color: '#000000', alpha: 0 }, { t: 1, color: '#ffffff', alpha: 1 }] });
    expect(gradient[3]).toBe(0);
    expect(gradient[(BAKE_SAMPLES - 1) * 4]).toBeCloseTo(1, 6);
    expect(gradient[(BAKE_SAMPLES - 1) * 4 + 3]).toBe(1);
  });

  it('estimates how many particles an effect keeps alive', () => {
    expect(estimateParticles(effectOf({ rate: 10, lifetime: [1, 2], bursts: [] }))).toBe(20);
    expect(estimateParticles(effectOf({ rate: 0, loop: false, lifetime: [1, 1], bursts: [{ time: 0, count: 30 }] }))).toBe(30);
  });
});

describe('particle simulation', () => {
  it('emits its rate evenly, packed at the front, and retires particles at the end of their life', () => {
    const simulation = new ParticleSimulation(effectOf({ ...still, rate: 10, lifetime: [1, 1] }), 64, seeded());
    for (let i = 0; i < 10; i++) simulation.step(0.05, null);
    expect(simulation.count).toBe(5);
    for (let i = 0; i < 30; i++) simulation.step(0.05, null);
    // A steady state: a second's worth alive.
    expect(simulation.count).toBe(10);
    for (let i = 0; i < simulation.count; i++) expect(simulation.ages[i]).toBeLessThan(1);
    simulation.stop();
    for (let i = 0; i < 25; i++) simulation.step(0.05, null);
    expect(simulation.count).toBe(0);
    expect(simulation.isDone).toBe(true);
  });

  it('fires bursts at their time in every cycle when looping, and once otherwise', () => {
    const looping = new ParticleSimulation(effectOf({ ...still, rate: 0, duration: 1, lifetime: [5, 5], bursts: [{ time: 0.5, count: 4 }] }), 64, seeded());
    looping.step(0.4, null);
    expect(looping.count).toBe(0);
    for (let i = 0; i < 6; i++) looping.step(0.1, null);
    expect(looping.count).toBe(4);
    for (let i = 0; i < 10; i++) looping.step(0.1, null);
    expect(looping.count).toBe(8);
    const once = new ParticleSimulation(effectOf({ ...still, rate: 0, loop: false, duration: 1, lifetime: [5, 5], bursts: [{ time: 0, count: 4 }] }), 64, seeded());
    for (let i = 0; i < 40; i++) once.step(0.1, null);
    expect(once.count).toBe(4);
    expect(once.isEmitting).toBe(false);
  });

  it('waits out its delay, and prewarms a looping effect to a full cycle', () => {
    const delayed = new ParticleSimulation(effectOf({ ...still, rate: 10, delay: 0.5, lifetime: [5, 5] }), 64, seeded());
    for (let i = 0; i < 4; i++) delayed.step(0.1, null);
    expect(delayed.count).toBe(0);
    for (let i = 0; i < 6; i++) delayed.step(0.1, null);
    expect(delayed.count).toBeGreaterThanOrEqual(4);
    const warmed = new ParticleSimulation(effectOf({ ...still, rate: 10, duration: 2, lifetime: [5, 5] }), 64, seeded());
    warmed.prewarm(null);
    expect(warmed.count).toBe(20);
  });

  it('launches inside its cone around the axis, turned and placed by the emitter matrix', () => {
    const simulation = new ParticleSimulation(effectOf({ ...still, rate: 100, speed: [2, 2], lifetime: [5, 5], shape: { kind: 'point', angle: 10, axis: [0, 1, 0] } }), 64, seeded());
    // The emitter lies on its side at (5, 0, 0): its up is world +X.
    const matrix = new THREE.Matrix4().makeRotationZ(-Math.PI / 2).setPosition(5, 0, 0).elements;
    simulation.step(0.1, matrix);
    expect(simulation.count).toBe(10);
    for (let i = 0; i < simulation.count; i++) {
      const v = new THREE.Vector3(simulation.velocities[i * 3], simulation.velocities[i * 3 + 1], simulation.velocities[i * 3 + 2]);
      expect(v.length()).toBeCloseTo(2, 5);
      expect(v.angleTo(new THREE.Vector3(1, 0, 0))).toBeLessThanOrEqual(THREE.MathUtils.degToRad(10) + 1e-6);
      expect(simulation.positions[i * 3]).toBeGreaterThanOrEqual(5);
    }
    // Rain's axis points down.
    const rain = new ParticleSimulation(effectOf({ ...still, rate: 100, speed: [10, 10], lifetime: [5, 5], shape: PARTICLE_PRESETS.rain.shape }), 64, seeded());
    rain.step(0.1, null);
    for (let i = 0; i < rain.count; i++) expect(rain.velocities[i * 3 + 1]).toBeLessThan(-9.9);
  });

  it('places particles on and in its shapes', () => {
    const sample = (shape: Record<string, unknown>) => {
      const simulation = new ParticleSimulation(effectOf({ ...still, rate: 2000, lifetime: [5, 5], shape: { ...DEFAULT_PARTICLE_EFFECT.shape, ...shape } }), 256, seeded(7));
      simulation.step(0.1, null);
      return Array.from({ length: simulation.count }, (_, i) => new THREE.Vector3(simulation.positions[i * 3], simulation.positions[i * 3 + 1], simulation.positions[i * 3 + 2]));
    };
    for (const point of sample({ kind: 'sphere', radius: 2, volume: 0 })) expect(point.length()).toBeCloseTo(2, 4);
    for (const point of sample({ kind: 'sphere', radius: 2, volume: 1 })) expect(point.length()).toBeLessThanOrEqual(2 + 1e-6);
    for (const point of sample({ kind: 'hemisphere', radius: 1, volume: 0 })) expect(point.y).toBeGreaterThanOrEqual(-1e-6);
    for (const point of sample({ kind: 'box', size: [4, 2, 6] })) {
      expect(Math.abs(point.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(point.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(point.z)).toBeLessThanOrEqual(3);
    }
    for (const point of sample({ kind: 'circle', radius: 3, volume: 0 })) {
      expect(point.y).toBeCloseTo(0, 6);
      expect(Math.hypot(point.x, point.z)).toBeCloseTo(3, 4);
    }
    for (const point of sample({ kind: 'edge', size: [10, 0, 0] })) {
      expect(Math.abs(point.x)).toBeLessThanOrEqual(5);
      expect(point.z).toBe(0);
    }
  });

  it("emits from a mesh's surface, along its normal", () => {
    const simulation = new ParticleSimulation(effectOf({ ...still, rate: 1000, speed: [1, 1], lifetime: [5, 5], shape: { ...DEFAULT_PARTICLE_EFFECT.shape, kind: 'mesh' } }), 128, seeded(3));
    // One triangle lying in the y = 2 plane, facing up.
    simulation.setMeshSurface({ positions: new Float32Array([0, 2, 0, 0, 2, 1, 1, 2, 0]), indices: new Uint32Array([0, 1, 2]) });
    simulation.step(0.1, null);
    expect(simulation.count).toBeGreaterThan(50);
    for (let i = 0; i < simulation.count; i++) {
      // On the triangle, risen along its normal for however much of the step it has flown.
      expect(simulation.positions[i * 3 + 1]).toBeGreaterThanOrEqual(2);
      expect(simulation.positions[i * 3 + 1]).toBeLessThanOrEqual(2.1);
      expect(simulation.positions[i * 3] + simulation.positions[i * 3 + 2]).toBeLessThanOrEqual(1 + 1e-5);
      expect(Math.abs(simulation.velocities[i * 3 + 1])).toBeCloseTo(1, 5);
    }
  });

  it('lays a trail along the path the emitter moved', () => {
    const simulation = new ParticleSimulation(effectOf({ ...still, rate: 0, rateOverDistance: 4, lifetime: [5, 5], shape: { ...DEFAULT_PARTICLE_EFFECT.shape, kind: 'point' } }), 128, seeded());
    simulation.step(0.1, translate(0, 0, 0));
    simulation.step(0.1, translate(5, 0, 0));
    expect(simulation.count).toBe(20);
    const xs = Array.from({ length: simulation.count }, (_, i) => simulation.positions[i * 3]).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(0.25, 5);
    expect(xs[xs.length - 1]).toBeCloseTo(5, 5);
    // Evenly spaced along the path.
    expect(xs[1] - xs[0]).toBeCloseTo(0.25, 5);
  });

  it("starts particles with a share of the emitter's own velocity", () => {
    const simulation = new ParticleSimulation(effectOf({ ...still, rate: 100, inheritVelocity: 0.5, lifetime: [5, 5] }), 128, seeded());
    simulation.step(0.1, translate(0, 0, 0));
    simulation.step(0.1, translate(5, 0, 0));
    // The emitter moved at 50 m/s: the newest particles started at half that.
    expect(simulation.velocities[(simulation.count - 1) * 3]).toBeCloseTo(25, 3);
  });

  it('pulls particles down with gravity, damps them with drag, pushes them with wind, and clamps long frames', () => {
    const simulation = new ParticleSimulation(effectOf({ ...still, rate: 0, bursts: [{ time: 0, count: 1 }], lifetime: [30, 30], gravity: 10, drag: 0, wind: [2, 0, 0] }), 4, seeded());
    simulation.step(0.0001, null);
    simulation.step(0.1, null);
    expect(simulation.velocities[1]).toBeCloseTo(-1, 2);
    expect(simulation.velocities[0]).toBeCloseTo(0.2, 2);
    simulation.step(5, null);
    expect(simulation.velocities[1]).toBeCloseTo(-1 - 10 * MAX_PARTICLE_STEP, 2);
    simulation.step(Number.NaN, null);
    simulation.step(-1, null);
    expect(simulation.velocities[1]).toBeCloseTo(-2, 2);
    const damped = new ParticleSimulation(effectOf({ ...still, rate: 0, bursts: [{ time: 0, count: 1 }], speed: [10, 10], lifetime: [30, 30], drag: 2 }), 4, seeded());
    damped.step(0.0001, null);
    for (let i = 0; i < 10; i++) damped.step(0.1, null);
    expect(Math.hypot(damped.velocities[0], damped.velocities[1], damped.velocities[2])).toBeCloseTo(10 * Math.exp(-2), 1);
  });

  it('stirs particles with turbulence and circles them round the emitter with orbit', () => {
    const stirred = new ParticleSimulation(effectOf({ ...still, rate: 0, bursts: [{ time: 0, count: 1 }], lifetime: [30, 30], turbulence: 5 }), 4, seeded());
    stirred.step(0.0001, null);
    for (let i = 0; i < 10; i++) stirred.step(0.1, null);
    expect(Math.hypot(stirred.velocities[0], stirred.velocities[1], stirred.velocities[2])).toBeGreaterThan(0.1);
    const circling = new ParticleSimulation(effectOf({ ...still, rate: 0, bursts: [{ time: 0, count: 1 }], lifetime: [30, 30], orbit: Math.PI, shape: { ...DEFAULT_PARTICLE_EFFECT.shape, kind: 'circle', radius: 2, volume: 0 } }), 4, seeded());
    circling.step(0.0001, null);
    const start = new THREE.Vector2(circling.positions[0], circling.positions[2]);
    for (let i = 0; i < 10; i++) circling.step(0.05, null);
    const end = new THREE.Vector2(circling.positions[0], circling.positions[2]);
    expect(end.length()).toBeCloseTo(2, 3);
    expect(Math.abs(start.angle() - end.angle())).toBeGreaterThan(1);
  });

  it('bounces off what it hits, or dies there, and raises events for sub-emitters', () => {
    // The ground: y = 0.
    const ground = vi.fn((fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): ParticleHit | null => {
      if (ty >= 0) return null;
      const t = fy / (fy - ty);
      return { x: fx + (tx - fx) * t, y: 0, z: fz + (tz - fz) * t, nx: 0, ny: 1, nz: 0 };
    });
    const falling = { ...still, rate: 0, bursts: [{ time: 0, count: 1 }], lifetime: [30, 30], gravity: 10, shape: { ...DEFAULT_PARTICLE_EFFECT.shape, kind: 'point' } };
    const bouncing = new ParticleSimulation(effectOf({ ...falling, collision: { mode: 'world', bounce: 0.5, friction: 0, kill: false }, subEmitters: [{ trigger: 'collision', target: 'splash', count: 3, inheritVelocity: 0 }] }), 4, seeded());
    bouncing.step(0.0001, translate(0, 1, 0));
    let bounced = false;
    for (let i = 0; i < 20; i++) {
      bouncing.step(0.05, translate(0, 1, 0), ground);
      expect(bouncing.positions[1]).toBeGreaterThanOrEqual(0);
      if (bouncing.velocities[1] > 0) bounced = true;
    }
    expect(bounced).toBe(true);
    expect(bouncing.events.some(event => event.trigger === 'collision' && Math.abs(event.y) < 1e-6)).toBe(true);
    const dying = new ParticleSimulation(effectOf({ ...falling, collision: { mode: 'world', bounce: 0, friction: 0, kill: true }, subEmitters: [{ trigger: 'death', target: 'splash', count: 3, inheritVelocity: 0 }] }), 4, seeded());
    dying.step(0.0001, translate(0, 1, 0));
    for (let i = 0; i < 20; i++) dying.step(0.05, translate(0, 1, 0), ground);
    expect(dying.count).toBe(0);
    expect(dying.events).toHaveLength(1);
    expect(dying.events[0]).toMatchObject({ trigger: 'death', y: 0 });
  });

  it('bursts from its shape at a world point, starting with a given velocity', () => {
    const simulation = new ParticleSimulation(effectOf({ ...still, rate: 0, lifetime: [5, 5], shape: { ...DEFAULT_PARTICLE_EFFECT.shape, kind: 'point' } }), 16, seeded());
    simulation.stop();
    simulation.emitAt(5, 3, 4, 5, 0, 7, 0);
    expect(simulation.count).toBe(5);
    expect([simulation.positions[0], simulation.positions[1], simulation.positions[2]]).toEqual([3, 4, 5]);
    expect(simulation.velocities[1]).toBe(7);
    // Never past its capacity.
    simulation.emitAt(100, 0, 0, 0);
    expect(simulation.count).toBe(16);
  });

  it('colours, sizes and frames particles over their life', () => {
    const simulation = new ParticleSimulation(effectOf({
      ...still, rate: 0, bursts: [{ time: 0, count: 1 }], lifetime: [1, 1], size: [2, 2], startColor: ['#ffffff', '#ffffff'],
      colorOverLife: { stops: [{ t: 0, color: '#ff0000', alpha: 1 }, { t: 1, color: '#0000ff', alpha: 0 }] },
      sizeOverLife: { points: [[0, 1], [1, 3]] },
      render: { ...DEFAULT_PARTICLE_EFFECT.render, columns: 4, rows: 4, frameMode: 'life' },
    }), 4, seeded());
    simulation.step(0.0001, null);
    expect(simulation.colors[0]).toBeCloseTo(1, 2);
    expect(simulation.colors[2]).toBeCloseTo(0, 2);
    expect(simulation.colors[3]).toBeCloseTo(1, 2);
    expect(simulation.sizes[0]).toBeCloseTo(2, 2);
    expect(simulation.frames[0]).toBe(0);
    for (let i = 0; i < 9; i++) simulation.step(0.1, null);
    expect(simulation.colors[2]).toBeGreaterThan(0.8);
    expect(simulation.colors[3]).toBeLessThan(0.2);
    expect(simulation.sizes[0]).toBeGreaterThan(5);
    expect(simulation.frames[0]).toBeGreaterThanOrEqual(14);
  });
});

describe('particle rendering', () => {
  const camera = () => {
    const view = new THREE.PerspectiveCamera();
    view.position.set(0, 0, 10);
    view.lookAt(0, 0, 0);
    view.updateMatrixWorld(true);
    return view;
  };

  it('sorts by the emitter position, never a sphere computed over unused instances, and draws back to front', () => {
    const simulation = new ParticleSimulation(effectOf({ ...still, rate: 0, lifetime: [5, 5], shape: { ...DEFAULT_PARTICLE_EFFECT.shape, kind: 'point' } }), 8, seeded());
    simulation.stop();
    simulation.emitAt(1, 0, 0, 5);
    simulation.emitAt(1, 0, 0, -5);
    simulation.step(0.01, null);
    const renderer = new ParticleRenderer(8);
    renderer.setLook(DEFAULT_PARTICLE_EFFECT, new THREE.Texture(), [1, 1]);
    const quads = renderer.object.children[0] as THREE.Mesh<THREE.InstancedBufferGeometry>;
    const compute = vi.spyOn(quads.geometry, 'computeBoundingSphere');
    expect(quads.geometry.boundingSphere).not.toBeNull();
    renderer.update(simulation, new THREE.Matrix4().makeTranslation(100, 0, 0), camera());
    expect(quads.geometry.boundingSphere!.center.toArray()).toEqual([100, 0, 0]);
    expect(quads.geometry.instanceCount).toBe(2);
    // The far one (z = -5) first.
    expect((quads.geometry.getAttribute('iPosition') as THREE.BufferAttribute).getZ(0)).toBe(-5);
    expect(compute).not.toHaveBeenCalled();
    // The mesh keeps an identity transform wherever it sits.
    const parent = new THREE.Group();
    parent.position.set(4, 5, 6);
    parent.add(renderer.object);
    parent.updateMatrixWorld(true);
    expect(quads.matrixWorld.equals(new THREE.Matrix4())).toBe(true);
    renderer.dispose();
  });

  it('draws a ribbon through the particles oldest first', () => {
    const simulation = new ParticleSimulation(effectOf({ ...still, rate: 0, lifetime: [5, 5], shape: { ...DEFAULT_PARTICLE_EFFECT.shape, kind: 'point' } }), 8, seeded());
    simulation.stop();
    for (let x = 0; x < 4; x++) {
      simulation.emitAt(1, x, 0, 0);
      simulation.step(0.05, null);
    }
    const renderer = new ParticleRenderer(8);
    renderer.setLook(PARTICLE_PRESETS.trail, new THREE.Texture(), [1, 1]);
    renderer.update(simulation, new THREE.Matrix4(), camera());
    const ribbon = renderer.object.children[1] as THREE.Mesh;
    expect(ribbon.visible).toBe(true);
    expect(ribbon.geometry.drawRange.count).toBe(3 * 6);
    const position = ribbon.geometry.getAttribute('position') as THREE.BufferAttribute;
    // The oldest particle (x = 0) is the tail.
    expect((position.getX(0) + position.getX(1)) / 2).toBeCloseTo(0, 5);
    expect((position.getX(6) + position.getX(7)) / 2).toBeCloseTo(3, 5);
    renderer.dispose();
  });
});

describe('particle emitter registry', () => {
  it('finds emitters by object and component, apart for the editor and the play session', () => {
    const handle = { objectId: 'o', componentId: 'c', play: vi.fn(), stop: vi.fn(), emit: vi.fn(), emitAt: vi.fn(), isPlaying: () => true, alive: () => 0 };
    const remove = particleEmitters.register('runtime', handle);
    expect(particleEmitters.get('runtime', 'o', 'c')).toBe(handle);
    expect(particleEmitters.get('editor', 'o', 'c')).toBeUndefined();
    expect(particleEmitters.forObject('runtime', 'o')).toEqual([handle]);
    remove();
    expect(particleEmitters.forObject('runtime', 'o')).toEqual([]);
  });
});

describe('particles in level and gameplay scripts', () => {
  const run = (type: WorldNodeType, inputs: Record<string, unknown>, extra: Partial<WorldNodeServices>) => {
    const definition = WORLD_NODE_DEFINITIONS.find(d => d.type === type)!;
    const node: FlowNode = {
      id: type, type,
      inputs: definition.inputs.map((pin, i) => ({ ...pin, id: `in-${i}` })),
      outputs: definition.outputs.map((pin, i) => ({ ...pin, id: `out-${i}` })),
      data: { ...definition.data },
    };
    const nodeState: Record<string, unknown> = {};
    const services: WorldNodeServices = {
      spawnPrefab: () => [], playSound: () => undefined, getObject: () => null, setObjectTransform: () => undefined,
      applyImpulse: () => undefined, raycast: () => null, input: { isDown: () => false },
      vars: createLevelVariablesStore(() => {}), print: () => undefined, ...extra,
    };
    WORLD_NODE_EXECUTORS[type]!(node, {
      evaluate: name => (name in inputs ? inputs[name] : node.data?.[`default_${name}`] ?? null),
      fire: () => undefined,
      schedule: () => undefined,
      nodeState,
      services,
    });
    return (pin: string) => flowNodeOutputValue(nodeState, pin);
  };

  it("plays, stops, bursts and reads an actor's emitters from the level script", () => {
    const playParticles = vi.fn(() => 2);
    const stopParticles = vi.fn(() => 2);
    const emitParticles = vi.fn(() => 2);
    expect(run('PlayParticles', { Actor: 'torch' }, { playParticles })('Emitters')).toBe(2);
    expect(playParticles).toHaveBeenCalledWith('torch');
    run('StopParticles', { Actor: 'torch', Clear: true }, { stopParticles });
    expect(stopParticles).toHaveBeenCalledWith('torch', true);
    run('EmitParticles', { Actor: 'torch', Count: 9999.4 }, { emitParticles });
    expect(emitParticles).toHaveBeenCalledWith('torch', 5000);
    const state = run('GetParticles', { Actor: 'torch' }, { particles: () => ({ playing: true, alive: 42, emitters: 2 }) });
    expect([state('Playing'), state('Alive'), state('Emitters')]).toEqual([true, 42, 2]);
    expect(run('PlayParticles', { Actor: '' }, { playParticles })('Emitters')).toBe(0);
  });

  it('accepts well-formed particle commands only', () => {
    expect(parseScriptCommand({ type: 'playParticles', objectId: 'torch' })).toEqual({ type: 'playParticles', objectId: 'torch' });
    expect(parseScriptCommand({ type: 'stopParticles', objectId: 'torch', clear: false })).toEqual({ type: 'stopParticles', objectId: 'torch', clear: false });
    expect(parseScriptCommand({ type: 'emitParticles', objectId: 'torch', count: 30 })).toEqual({ type: 'emitParticles', objectId: 'torch', count: 30 });
    expect(parseScriptCommand({ type: 'emitParticles', objectId: 'torch', count: 1.5 })).toBeNull();
    expect(parseScriptCommand({ type: 'emitParticles', objectId: 'torch', count: 1e9 })).toBeNull();
    expect(parseScriptCommand({ type: 'stopParticles', objectId: 'torch' })).toBeNull();
    expect(parseScriptCommand({ type: 'playParticles', objectId: '' })).toBeNull();
  });
});
