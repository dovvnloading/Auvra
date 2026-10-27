import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  applyWaterForces, buoyancyForce, resolveWaterSettings, WATER_COMPONENT, WATER_DEFAULTS, waveOffset, waveSet,
} from '../../runtime/components/waterComponent';
import type { LevelComponent } from '../../types';
import { loadRuntimeRapier } from './rapierRuntime';

const component = (props: Record<string, unknown>): LevelComponent => ({ id: 'w', type: 'water', enabled: true, props });

describe('water settings', () => {
  it('defaults and clamps every prop', () => {
    expect(resolveWaterSettings(component({}))).toEqual(WATER_DEFAULTS);
    const settings = resolveWaterSettings(component({ size: [-5, 3, 1e9], opacity: 9, waveLength: 0, color: 'red', buoyancy: 'yes', density: Number.NaN }));
    expect(settings.size).toEqual([0.1, 0, 10000]);
    expect(settings.opacity).toBe(1);
    expect(settings.waveLength).toBe(0.5);
    expect(settings.color).toBe(WATER_DEFAULTS.color);
    expect(settings.buoyancy).toBe(true);
    expect(settings.density).toBe(1000);
  });

  it('offers every setting in the inspector', () => {
    expect(WATER_COMPONENT.props.map(prop => prop.key).sort()).toEqual(Object.keys(WATER_DEFAULTS).sort());
  });
});

describe('waves', () => {
  it('stays within the wave height and is flat without waves', () => {
    const waves = waveSet({ waveHeight: 0.5, waveLength: 6, waveSpeed: 1 });
    let max = 0;
    for (let i = 0; i < 400; i++) max = Math.max(max, Math.abs(waveOffset(waves, i * 0.37, i * 0.11, i * 0.05)));
    expect(max).toBeGreaterThan(0.1);
    expect(max).toBeLessThanOrEqual(0.5 + 1e-9);
    const calm = waveSet({ waveHeight: 0, waveLength: 6, waveSpeed: 1 });
    expect(waveOffset(calm, 3, 4, 5)).toBe(0);
  });

  it('moves over time unless the speed is 0', () => {
    const moving = waveSet({ waveHeight: 0.5, waveLength: 6, waveSpeed: 1 });
    expect(waveOffset(moving, 1, 1, 0)).not.toBeCloseTo(waveOffset(moving, 1, 1, 0.7), 3);
    const still = waveSet({ waveHeight: 0.5, waveLength: 6, waveSpeed: 0 });
    expect(waveOffset(still, 1, 1, 0)).toBeCloseTo(waveOffset(still, 1, 1, 0.7), 12);
  });
});

describe('buoyancy', () => {
  it('is the weight of the displaced water', () => {
    expect(buoyancyForce(1, 0.5, 10, 1000)).toBeCloseTo(9810);
    expect(buoyancyForce(1, 0.5, 0, 1000)).toBeCloseTo(4905);
    expect(buoyancyForce(1, 0.5, -1, 1000)).toBe(0);
    expect(buoyancyForce(0, 0.5, 10, 1000)).toBe(0);
  });

  it('floats a light box at its waterline and lets a heavy one sink', async () => {
    const rapier = await loadRuntimeRapier();
    const world = new rapier.World({ x: 0, y: -9.81, z: 0 });
    const box = (x: number, density: number) => {
      const body = world.createRigidBody(rapier.RigidBodyDesc.dynamic().setTranslation(x, 2, 0));
      world.createCollider(rapier.ColliderDesc.cuboid(0.5, 0.5, 0.5).setDensity(density), body);
      return body;
    };
    const light = box(-3, 500);
    const heavy = box(3, 2000);
    const settings = { ...WATER_DEFAULTS, waveHeight: 0, drag: 2 };
    const water = { worldToLocal: new THREE.Matrix4(), settings, waves: waveSet(settings), time: 0, ownerId: 'water' };
    for (let i = 0; i < 600; i++) {
      applyWaterForces(world, rapier.ShapeType, water, world.timestep);
      world.step();
    }
    // Half as dense as water: half of it under the surface (centre at y = 0).
    expect(light.translation().y).toBeCloseTo(0, 1);
    expect(heavy.translation().y).toBeLessThan(-3);
    world.free();
  });
});
