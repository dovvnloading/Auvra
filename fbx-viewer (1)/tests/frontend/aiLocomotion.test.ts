import { beforeAll, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import * as THREE from 'three';
import { useAILocomotion } from '../../components/Sandbox/AI/useAILocomotion';
import type { AIState } from '../../components/Sandbox/AI/AIConfig';
import { LevelNavMesh, recastReady } from '../../runtime/navMesh';
import { collectNavGeometry } from '../../runtime/navGeometry';
import { resolveNavSettings } from '../../runtime/navSettings';
import type { LevelComponent, LevelObject } from '../../types';

type Vec3 = [number, number, number];

const FRAME = 1 / 60;

beforeAll(async () => {
  await recastReady();
});

const levelObject = (id: string, overrides: Partial<LevelObject> = {}): LevelObject => ({
  id,
  levelId: 'level',
  modelId: 'model',
  name: id,
  type: 'prop',
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  ...overrides,
});

const boxCollider = (id: string, size: Vec3, offset: Vec3): LevelComponent => ({
  id: `${id}-collider`,
  type: 'collider',
  enabled: true,
  props: { shape: 'box', size, offset, isTrigger: false },
});

const wall = (id: string, position: Vec3, size: Vec3): LevelObject =>
  levelObject(id, { position, components: [boxCollider(id, size, [0, size[1] / 2, 0])] });

const bake = (objects: LevelObject[]): LevelNavMesh => {
  const geometry = collectNavGeometry(objects);
  return LevelNavMesh.bake({ positions: geometry.positions, indices: geometry.indices, links: geometry.links, settings: resolveNavSettings(undefined) }, geometry.groundHeight);
};

/** Runs `frames` frames of locomotion toward a fixed destination; returns the enemy and where it was each frame. */
const simulate = (navMesh: LevelNavMesh, start: Vec3, destination: Vec3, state: AIState, frames: number) => {
  const { result } = renderHook(() => useAILocomotion());
  const enemy = new THREE.Object3D();
  enemy.position.set(...start);
  const target = new THREE.Vector3(...destination);
  const trail: THREE.Vector3[] = [];
  for (let frame = 0; frame < frames; frame++) {
    result.current.updateLocomotion({
      enemyObject: enemy,
      destination: target.clone(),
      targetFocus: state === 'CHASE' ? target.clone() : null,
      state,
      delta: FRAME,
      navMesh,
    });
    trail.push(enemy.position.clone());
  }
  return { enemy, trail };
};

describe('AI locomotion over the navmesh', () => {
  it('chases a target across open ground', () => {
    const navMesh = bake([]);
    const { enemy } = simulate(navMesh, [12, 0, 0], [25, 0, 0], 'CHASE', 240);
    expect(enemy.position.distanceTo(new THREE.Vector3(25, 0, 0))).toBeLessThan(2.2);
    navMesh.dispose();
  });

  it('keeps to the navmesh when its target leaves it', () => {
    // The flat ground covers the level and 10 m round it: ±60 m here.
    const navMesh = bake([]);
    const { enemy, trail } = simulate(navMesh, [40, 0, 0], [150, 0, 0], 'CHASE', 600);
    expect(enemy.position.x).toBeGreaterThan(55);
    for (const point of trail) expect(point.x).toBeLessThan(60);
    navMesh.dispose();
  });

  it('closes in on a target standing on a platform it cannot climb, staying on the ground', () => {
    const platform = levelObject('platform', { position: [0, 0.5, 0], scale: [10, 1, 10], components: [boxCollider('platform', [1, 1, 1], [0, 0, 0])] });
    const navMesh = bake([platform]);
    const { enemy } = simulate(navMesh, [12, 0, 0], [0, 1, 0], 'CHASE', 300);
    // At the navmesh's edge: the platform's half-width and the agent's radius, within Recast's contour error.
    expect(Math.hypot(enemy.position.x, enemy.position.z)).toBeLessThan(6.1);
    expect(Math.abs(enemy.position.y)).toBeLessThan(0.05);
    navMesh.dispose();
  });

  it('holds outside a closed pen when its target is walled off at ground level', () => {
    const pen = [
      wall('north', [5, 0, 8], [7, 2, 1]),
      wall('south', [5, 0, 2], [7, 2, 1]),
      wall('east', [8, 0, 5], [1, 2, 7]),
      wall('west', [2, 0, 5], [1, 2, 7]),
    ];
    const navMesh = bake(pen);
    const { enemy } = simulate(navMesh, [-5, 0, -5], [5, 0, 5], 'CHASE', 600);
    // Waits right outside the pen instead of walking through its wall.
    expect(Math.max(Math.abs(enemy.position.x - 5), Math.abs(enemy.position.z - 5))).toBeGreaterThan(3.5);
    expect(Math.hypot(enemy.position.x - 5, enemy.position.z - 5)).toBeLessThan(5.5);
    navMesh.dispose();
  });

  it('walks up a ramp onto a platform, at the surface height', () => {
    // A 6 x 6 m platform, 1 m high, over x 1..7, and a ramp up to its west edge from the ground at x = -4.
    const platform = wall('platform', [4, 0, 0], [6, 1, 6]);
    const angle = Math.atan2(1, 5);
    const ramp = levelObject('ramp', {
      position: [-1.5 + Math.sin(angle) * 0.1, 0.5 - Math.cos(angle) * 0.1, 0],
      rotation: [0, 0, angle],
      components: [boxCollider('ramp', [Math.hypot(5, 1), 0.2, 2], [0, 0, 0])],
    });
    const navMesh = bake([platform, ramp]);
    const { enemy, trail } = simulate(navMesh, [-8, 0, 0], [4, 1, 0], 'CHASE', 480);
    expect(Math.hypot(enemy.position.x - 4, enemy.position.z)).toBeLessThan(2.2);
    // Without a physics world the height is the navmesh's, true to within a cell height.
    expect(Math.abs(enemy.position.y - 1)).toBeLessThan(0.1);
    // Up the ramp, never through the platform's side: well above the ground only on the ramp or on top.
    // (Off the ramp's foot the navmesh height leans a little toward it, so only clearly raised points count.)
    for (const point of trail.filter(p => p.y > 0.5)) expect(point.x > 0.9 || (point.x > -4.1 && Math.abs(point.z) < 1.1)).toBe(true);
    navMesh.dispose();
  });

  it('never walks through a wall, however its target lines up', () => {
    const navMesh = bake([wall('wall', [0, 0, 0], [1, 2, 12])]);
    const { enemy, trail } = simulate(navMesh, [-5, 0, 0], [5, 0, 0], 'CHASE', 600);
    for (const point of trail) expect(Math.abs(point.x) > 0.5 || Math.abs(point.z) > 6).toBe(true);
    expect(enemy.position.distanceTo(new THREE.Vector3(5, 0, 0))).toBeLessThan(2.2);
    navMesh.dispose();
  });
});
