import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { advanceWaypoint, buildNavGrid, findPath, hasLineOfSight, isWalkable, planPath } from '../../runtime/navigation';
import type { LevelComponent, LevelObject } from '../../types';

type Vec3 = [number, number, number];

const OPTIONS = { bounds: { minX: -10, minZ: -10, maxX: 10, maxZ: 10 }, cellSize: 0.5, agentRadius: 0.4 };

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

const boxCollider = (id: string, size: Vec3, props: Record<string, unknown> = {}): LevelComponent => ({
  id: `${id}-collider`,
  type: 'collider',
  enabled: true,
  props: { shape: 'box', size, offset: [0, size[1] / 2, 0], isTrigger: false, ...props },
});

/** A static wall: a box collider of `size` standing on the ground at `position`. */
const wall = (id: string, position: Vec3, size: Vec3): LevelObject =>
  levelObject(id, { position, components: [boxCollider(id, size)] });

const pathLength = (points: THREE.Vector3[]): number =>
  points.slice(1).reduce((sum, point, i) => sum + Math.hypot(point.x - points[i].x, point.z - points[i].z), 0);

const samplePath = (points: THREE.Vector3[], step = 0.05): THREE.Vector3[] => {
  const samples: THREE.Vector3[] = [];
  for (let i = 1; i < points.length; i++) {
    const count = Math.ceil(points[i - 1].distanceTo(points[i]) / step);
    for (let s = 0; s <= count; s++) samples.push(points[i - 1].clone().lerp(points[i], s / count));
  }
  return samples;
};

describe('navigation grid', () => {
  it('routes around an obstacle and smooths the path', () => {
    // A wall 1 m thick across z = -6..6 between the agent and its target.
    const grid = buildNavGrid([wall('wall', [0, 0, 0], [1, 2, 12])], OPTIONS);
    const from = new THREE.Vector3(-5, 0, 0);
    const to = new THREE.Vector3(5, 0, 0);
    expect(isWalkable(grid, -5, 0)).toBe(true);
    expect(isWalkable(grid, 0, 0)).toBe(false);
    expect(hasLineOfSight(grid, from, to)).toBe(false);

    const path = findPath(grid, from, to);
    expect(path).not.toBeNull();
    const points = path!;
    expect(points[0].x).toBeCloseTo(-5);
    expect(points[points.length - 1].x).toBeCloseTo(5);
    expect(points.length).toBeGreaterThan(2);
    // Never through the wall itself.
    for (const sample of samplePath(points)) {
      expect(Math.abs(sample.x) > 0.5 || Math.abs(sample.z) > 6).toBe(true);
    }
    // String pulling leaves a handful of corners close to the shortest way round (~2 * hypot(5, 6.4)).
    expect(points.length).toBeLessThan(8);
    const length = pathLength(points);
    expect(length).toBeGreaterThan(2 * Math.hypot(5, 6));
    expect(length).toBeLessThan(19);
  });

  it('keeps an open-field path straight', () => {
    const grid = buildNavGrid([], OPTIONS);
    const path = findPath(grid, { x: -6, z: -4 }, { x: 7, z: 5 });
    expect(path).toHaveLength(2);
  });

  it('rejects an unreachable target, or stops as close as it can when asked', () => {
    // A closed pen around (5, 5).
    const pen = [
      wall('north', [5, 0, 8], [7, 2, 1]),
      wall('south', [5, 0, 2], [7, 2, 1]),
      wall('east', [8, 0, 5], [1, 2, 7]),
      wall('west', [2, 0, 5], [1, 2, 7]),
    ];
    const grid = buildNavGrid(pen, OPTIONS);
    const from = { x: -5, z: -5 };
    const to = { x: 5, z: 5 };
    expect(isWalkable(grid, 5, 5)).toBe(true);
    expect(grid.regions[0]).not.toBe(-1);

    expect(findPath(grid, from, to)).toBeNull();
    expect(planPath(grid, from, to)).toBeNull();

    const partial = planPath(grid, from, to, { partial: true });
    expect(partial).not.toBeNull();
    expect(partial!.reachable).toBe(false);
    const end = partial!.points[partial!.points.length - 1];
    // Outside the pen, right up against it.
    expect(Math.max(Math.abs(end.x - 5), Math.abs(end.z - 5))).toBeGreaterThan(3.5);
    expect(Math.hypot(end.x - 5, end.z - 5)).toBeLessThan(4.6);
  });

  it('bakes only static, solid props', () => {
    const grid = buildNavGrid([
      // No collider: the player's circle footprint (radius = max(scale.x, scale.z) / 2).
      levelObject('crate', { position: [-5, 0, 0], scale: [2, 2, 2] }),
      // Moves at runtime, so it is not baked.
      levelObject('platform', { position: [0, 0, 0], scale: [2, 2, 2], components: [{ id: 'm', type: 'mover', enabled: true, props: {} }] }),
      // Trigger volumes do not block.
      levelObject('zone', { position: [5, 0, 0], components: [boxCollider('zone', [3, 2, 3], { isTrigger: true })] }),
      // Overhead beam: an agent walks under it.
      levelObject('beam', { position: [0, 3, 5], components: [boxCollider('beam', [4, 0.5, 1])] }),
    ], OPTIONS);
    expect(isWalkable(grid, -5, 0)).toBe(false);
    expect(isWalkable(grid, -6.6, 0)).toBe(true);
    expect(isWalkable(grid, 0, 0)).toBe(true);
    expect(isWalkable(grid, 5, 0)).toBe(true);
    expect(isWalkable(grid, 0, 5)).toBe(true);
  });

  it('treats terrain steeper than the slope limit as unwalkable', () => {
    // A 20 m terrain with a ridge running along Z through x = 0 (5 m between samples).
    const terrain = (ridge: number): LevelObject => levelObject('terrain', {
      type: 'terrain',
      modelId: '',
      terrainData: {
        resolution: 4,
        width: 20,
        depth: 20,
        heights: Array.from({ length: 25 }, (_, i) => (i % 5 === 2 ? ridge : 0)),
      },
    });
    const from = { x: -8, z: 0 };
    const to = { x: 8, z: 0 };

    const steep = buildNavGrid([terrain(10)], OPTIONS);
    expect(isWalkable(steep, -2.5, 0)).toBe(false);
    expect(findPath(steep, from, to)).toBeNull();

    const gentle = buildNavGrid([terrain(1)], OPTIONS);
    const path = findPath(gentle, from, to, { smooth: false });
    expect(path).not.toBeNull();
    const crest = path!.reduce((best, point) => Math.max(best, point.y), -Infinity);
    expect(crest).toBeGreaterThan(0.8);
  });

  it('advances past waypoints the agent has reached', () => {
    const path = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 0, 4), new THREE.Vector3(5, 0, 4)];
    expect(advanceWaypoint(path, 1, { x: 0.2, z: 0 }, 0.45)).toBe(1);
    expect(advanceWaypoint(path, 1, { x: 0.9, z: 0.1 }, 0.45)).toBe(2);
    expect(advanceWaypoint(path, 2, { x: 4.9, z: 4 }, 0.45)).toBe(2);
    expect(advanceWaypoint(path, 3, { x: 4.9, z: 4 }, 0.45)).toBe(3);
  });
});
