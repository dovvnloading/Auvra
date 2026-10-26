import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import * as THREE from 'three';
import { useAILocomotion } from '../../components/Sandbox/AI/useAILocomotion';
import type { AIState } from '../../components/Sandbox/AI/AIConfig';
import { buildNavGrid, type NavGrid, type NavGridOptions } from '../../runtime/navigation';
import type { LevelComponent, LevelObject } from '../../types';

type Vec3 = [number, number, number];

const FRAME = 1 / 60;

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

/** Runs `frames` frames of locomotion toward a fixed destination and returns the enemy. */
const simulate = (grid: NavGrid, start: Vec3, destination: Vec3, state: AIState, frames: number): THREE.Object3D => {
  const { result } = renderHook(() => useAILocomotion());
  const enemy = new THREE.Object3D();
  enemy.position.set(...start);
  const target = new THREE.Vector3(...destination);
  for (let frame = 0; frame < frames; frame++) {
    result.current.updateLocomotion({
      enemyObject: enemy,
      destination: target.clone(),
      targetFocus: state === 'CHASE' ? target.clone() : null,
      state,
      delta: FRAME,
      navGrid: grid,
    });
  }
  return enemy;
};

const BOUNDS: NavGridOptions = { bounds: { minX: -15, minZ: -15, maxX: 15, maxZ: 15 }, cellSize: 0.5, agentRadius: 0.4 };

describe('AI locomotion over the nav grid', () => {
  it('keeps chasing a target beyond the edge of the baked grid', () => {
    const grid = buildNavGrid([], BOUNDS);
    const enemy = simulate(grid, [12, 0, 0], [25, 0, 0], 'CHASE', 240);
    // Off the grid is open ground: the enemy leaves the grid and closes in instead of holding at its edge.
    expect(enemy.position.x).toBeGreaterThan(20);
    expect(enemy.position.distanceTo(new THREE.Vector3(25, 0, 0))).toBeLessThan(2.2);
  });

  it('keeps chasing a target standing on a raised platform', () => {
    // A 10 x 10 m platform spanning y 0..1, which the single-layer grid bakes as blocked.
    const platform = levelObject('platform', {
      position: [0, 0.5, 0],
      scale: [10, 1, 10],
      components: [boxCollider('platform', [1, 1, 1], [0, 0, 0])],
    });
    const grid = buildNavGrid([platform], BOUNDS);
    const enemy = simulate(grid, [12, 0, 0], [0, 1, 0], 'CHASE', 300);
    expect(enemy.position.distanceTo(new THREE.Vector3(0, 1, 0))).toBeLessThan(2.2);
  });

  it('still holds outside a closed pen when its target is walled off at ground level', () => {
    const pen = [
      wall('north', [5, 0, 8], [7, 2, 1]),
      wall('south', [5, 0, 2], [7, 2, 1]),
      wall('east', [8, 0, 5], [1, 2, 7]),
      wall('west', [2, 0, 5], [1, 2, 7]),
    ];
    const grid = buildNavGrid(pen, BOUNDS);
    const enemy = simulate(grid, [-5, 0, -5], [5, 0, 5], 'CHASE', 600);
    // Waits right outside the pen instead of walking through its wall.
    expect(Math.max(Math.abs(enemy.position.x - 5), Math.abs(enemy.position.z - 5))).toBeGreaterThan(3.5);
    expect(Math.hypot(enemy.position.x - 5, enemy.position.z - 5)).toBeLessThan(5);
  });
});
