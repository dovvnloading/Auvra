import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import * as THREE from 'three';
import {
  NAV_REBAKE_INTERVAL_MS,
  advanceWaypoint,
  buildNavGrid,
  findPath,
  hasLineOfSight,
  isWalkable,
  isWalledOff,
  navGridSignature,
  planPath,
  useNavGrid,
} from '../../runtime/navigation';
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

  it('does not bake props without a model, such as lights', () => {
    // LightingPanel creates point/spot lights as model-less props carrying only a light component.
    const light = levelObject('light', {
      modelId: '',
      position: [0, 2, 0],
      components: [{ id: 'light-c', type: 'pointLight', enabled: true, props: { intensity: 1 } }],
    });
    const grid = buildNavGrid([light], OPTIONS);
    expect(isWalkable(grid, 0, 0)).toBe(true);
    // A model-less prop with a mesh collider has no geometry for physics either.
    const meshOnly = levelObject('empty-mesh', { modelId: '', components: [boxCollider('empty-mesh', [1, 1, 1], { shape: 'mesh' })] });
    expect(isWalkable(buildNavGrid([meshOnly], OPTIONS), 0, 0)).toBe(true);
  });

  it('keeps thin walls when large bounds coarsen the cells', () => {
    const thinWall = wall('wall', [0, 0, 0], [0.3, 3, 12]);
    // A walk-on floor slab whose top face is the y = 0 ground: it never blocks, so it must not stretch the grid.
    const floor = levelObject('floor', { components: [boxCollider('floor', [1000, 1, 1000], { offset: [0, -0.5, 0] })] });
    const grid = buildNavGrid([thinWall, floor]);
    expect(grid.cellSize).toBeCloseTo(0.5);
    expect(isWalkable(grid, 0, 0)).toBe(false);
    expect(planPath(grid, { x: -5, z: 0 }, { x: 5, z: 0 })!.points.length).toBeGreaterThan(2);

    // Cells wider than the inflated wall: the wall must still cover a cell centre in every row it crosses.
    const coarse = buildNavGrid([thinWall], { ...OPTIONS, cellSize: 2 });
    expect(coarse.cellSize).toBe(2);
    expect(isWalkable(coarse, 0.9, 0)).toBe(false);
    expect(isWalkable(coarse, -0.9, 0)).toBe(false);
    expect(hasLineOfSight(coarse, { x: -5, z: 0 }, { x: 5, z: 0 })).toBe(false);
  });

  it('bakes capsules along their rotated axis with the physics height convention', () => {
    const capsule = (id: string, position: Vec3, rotation: Vec3, radius: number, height: number): LevelObject => levelObject(id, {
      position,
      rotation,
      components: [{ id: `${id}-c`, type: 'collider', enabled: true, props: { shape: 'capsule', radius, height, offset: [0, 0, 0], isTrigger: false } }],
    });
    // A 4 m log lying along world X.
    const log = buildNavGrid([capsule('log', [0, 0.4, 0], [0, 0, Math.PI / 2], 0.3, 4)], OPTIONS);
    for (const x of [0.75, 1.25, 1.75]) expect(isWalkable(log, x, 0)).toBe(false);
    expect(isWalkable(log, 3, 0)).toBe(true);
    expect(planPath(log, { x: 1.3, z: -3 }, { x: 1.3, z: 3 })!.points.length).toBeGreaterThan(2);

    // Upright, hanging with its bottom at 2.9 - (2 / 2) = 1.9 m: above agentHeight, so agents walk under.
    expect(isWalkable(buildNavGrid([capsule('lamp', [0, 2.9, 0], [0, 0, 0], 0.3, 2)], OPTIONS), 0, 0)).toBe(true);
    // A horizontal pipe spanning y 2.2..2.8 is walked under too.
    expect(isWalkable(buildNavGrid([capsule('pipe', [0, 2.5, 0], [0, 0, Math.PI / 2], 0.3, 6)], OPTIONS), 0, 0)).toBe(true);
    // Upright on the ground it still blocks.
    expect(isWalkable(buildNavGrid([capsule('post', [0, 1, 0], [0, 0, 0], 0.3, 2)], OPTIONS), 0, 0)).toBe(false);
  });

  it('bakes mesh colliders and fixed auto-hull bodies from their shape bounds', () => {
    // An imported model is normalised to 5 m; at scale 1 its bounds are about 5 m across.
    const rockBounds = new THREE.Box3(new THREE.Vector3(-2.5, 0, -2.5), new THREE.Vector3(2.5, 5, 2.5));
    const shapeBounds = (object: LevelObject) => (object.modelId === 'rock' ? rockBounds : null);
    const meshRock = levelObject('mesh-rock', { modelId: 'rock', components: [boxCollider('mesh-rock', [1, 1, 1], { shape: 'mesh', offset: [0, 0, 0] })] });
    const hullRock = levelObject('hull-rock', { modelId: 'rock', components: [{ id: 'rb', type: 'rigidBody', enabled: true, props: { type: 'fixed' } }] });
    for (const rock of [meshRock, hullRock]) {
      expect(isWalkable(buildNavGrid([rock], { ...OPTIONS, shapeBounds }), 2, 0)).toBe(false);
      expect(isWalkable(buildNavGrid([rock], { ...OPTIONS, shapeBounds }), 3.5, 0)).toBe(true);
      // Without bounds they keep the scale footprint circle.
      expect(isWalkable(buildNavGrid([rock], OPTIONS), 2, 0)).toBe(true);
      expect(isWalkable(buildNavGrid([rock], OPTIONS), 0, 0)).toBe(false);
    }
  });

  it('tells a walled-off target from one the grid just does not cover', () => {
    // Off the grid: unbaked open ground, so a chase keeps going past the edge.
    const open = buildNavGrid([], OPTIONS);
    const offGrid = planPath(open, { x: 8, z: 0 }, { x: 20, y: 0, z: 0 }, { partial: true })!;
    expect(offGrid.reachable).toBe(false);
    expect(isWalledOff(open, { x: 20, y: 0, z: 0 })).toBe(false);

    // On a 10 x 10 m platform spanning y 0..1, which the single ground layer bakes as blocked.
    const platform = levelObject('platform', {
      position: [0, 0.5, 0],
      scale: [10, 1, 10],
      components: [boxCollider('platform', [1, 1, 1], { offset: [0, 0, 0] })],
    });
    const raised = buildNavGrid([platform], OPTIONS);
    expect(raised.maxStepHeight).toBeCloseTo(0.35);
    expect(planPath(raised, { x: 8, z: 0 }, { x: 0, y: 1, z: 0 }, { partial: true })!.reachable).toBe(false);
    expect(isWalledOff(raised, { x: 0, y: 1, z: 0 })).toBe(false);
    // Standing on the ground right against it is still walled off.
    expect(isWalledOff(raised, { x: 0, y: 0, z: 0 })).toBe(true);

    // Inside a closed pen at ground level: walled off, so a chase holds outside.
    const pen = buildNavGrid([
      wall('north', [5, 0, 8], [7, 2, 1]),
      wall('south', [5, 0, 2], [7, 2, 1]),
      wall('east', [8, 0, 5], [1, 2, 7]),
      wall('west', [2, 0, 5], [1, 2, 7]),
    ], OPTIONS);
    expect(isWalledOff(pen, { x: 5, y: 0, z: 5 })).toBe(true);
    expect(isWalledOff(pen, { x: 5, z: 5 })).toBe(true);
  });
});

describe('raised collider tops', () => {
  // A 6 x 6 m platform, 1 m high, over x 1..7, z -3..3.
  const platform = wall('platform', [4, 0, 0], [6, 1, 6]);
  // A 2 m wide ramp whose top face runs from the ground at x = -4 up to the platform edge at (1, 1).
  const rampAngle = Math.atan2(1, 5);
  const ramp = levelObject('ramp', {
    position: [-1.5 + Math.sin(rampAngle) * 0.1, 0.5 - Math.cos(rampAngle) * 0.1, 0],
    rotation: [0, 0, rampAngle],
    components: [boxCollider('ramp', [Math.hypot(5, 1), 0.2, 2], { offset: [0, 0, 0] })],
  });
  // Stairs up the platform's south side: 0.25 m risers on 0.4 m treads, narrower than a cell.
  const stairs = [1, 2, 3].map(i => wall(`step${i}`, [4, 0, -3 - 0.4 * (4 - i) + 0.2], [2, 0.25 * i, 0.4]));
  const top = { x: 4, y: 1, z: 0 };

  const cellAt = (grid: ReturnType<typeof buildNavGrid>, x: number, z: number): number =>
    Math.floor((z - grid.originZ) / grid.cellSize) * grid.columns + Math.floor((x - grid.originX) / grid.cellSize);

  it('bakes a platform top as a raised walkable region of its own', () => {
    const grid = buildNavGrid([platform], OPTIONS);
    const cell = cellAt(grid, 4, 0);
    expect(isWalkable(grid, 4, 0)).toBe(true);
    expect(grid.heights[cell]).toBeCloseTo(1);
    expect(grid.raised[cell]).toBe(1);
    // Kept the agent radius back from its ledges, and walled by the inflated obstacle at ground level.
    expect(isWalkable(grid, 1.25, 0)).toBe(false);
    expect(isWalkable(grid, 0.75, 0)).toBe(false);
    expect(isWalkable(grid, 0.25, 0)).toBe(true);

    // A 1 m climb is more than a step: no path, and no sight line across the ledge.
    const ground = { x: -8, y: 0, z: 0 };
    expect(grid.regions[cell]).not.toBe(grid.regions[cellAt(grid, -8, 0)]);
    expect(findPath(grid, ground, top)).toBeNull();
    expect(hasLineOfSight(grid, ground, top)).toBe(false);
    const partial = planPath(grid, ground, top, { partial: true })!;
    expect(partial.reachable).toBe(false);
    expect(partial.points[partial.points.length - 1].y).toBeCloseTo(0);
    // Up on the platform the target may still be reached by jumping; at ground level under it, it is shut off.
    expect(isWalledOff(grid, top)).toBe(false);
    expect(isWalledOff(grid, { x: 4, y: 0, z: 0 })).toBe(true);
  });

  it('climbs onto a platform up a ramp, with waypoints at the surface height', () => {
    const grid = buildNavGrid([platform, ramp], OPTIONS);
    // The cell centred on x = -1.25 sits 2.75 m up the 1-in-5 ramp.
    expect(grid.heights[cellAt(grid, -1.25, 0)]).toBeCloseTo(0.55, 3);
    const plan = planPath(grid, { x: -8, y: 0, z: 0 }, top)!;
    expect(plan).not.toBeNull();
    expect(plan.reachable).toBe(true);
    expect(plan.points[plan.points.length - 1].y).toBeCloseTo(1);

    const cells = findPath(grid, { x: -8, y: 0, z: 0 }, top, { smooth: false })!;
    for (let i = 1; i < cells.length; i++) expect(Math.abs(cells[i].y - cells[i - 1].y)).toBeLessThanOrEqual(grid.maxStepHeight);
    // Everything above a step off the ground is on the ramp or the platform.
    for (const point of cells.filter(p => p.y > grid.maxStepHeight)) {
      expect(point.x > 1 || (point.x > -4 && Math.abs(point.z) < 1)).toBe(true);
    }
    expect(cells.some(p => p.x > -3 && p.x < 0 && p.y > 0.2 && p.y < 0.8)).toBe(true);
  });

  it('climbs stairs with treads narrower than a cell, but not risers above maxStepHeight', () => {
    const from = { x: 4, y: 0, z: -8 };
    const grid = buildNavGrid([platform, ...stairs], OPTIONS);
    const plan = planPath(grid, from, top);
    expect(plan).not.toBeNull();
    expect(plan!.reachable).toBe(true);
    const cells = findPath(grid, from, top, { smooth: false })!;
    for (let i = 1; i < cells.length; i++) expect(Math.abs(cells[i].y - cells[i - 1].y)).toBeLessThanOrEqual(0.5 + 1e-6);

    const lowStep = buildNavGrid([platform, ...stairs], { ...OPTIONS, maxStepHeight: 0.2 });
    expect(planPath(lowStep, from, top)).toBeNull();
    expect(isWalkable(lowStep, 4, 0)).toBe(true);
  });

  it('keeps walking under a top with headroom above the ground', () => {
    const canopy = levelObject('canopy', { position: [0, 2, 0], components: [boxCollider('canopy', [4, 0.2, 4])] });
    const grid = buildNavGrid([canopy], OPTIONS);
    const cell = cellAt(grid, 0, 0);
    expect(isWalkable(grid, 0, 0)).toBe(true);
    expect(grid.heights[cell]).toBeCloseTo(0);
    expect(grid.raised[cell]).toBe(0);
    expect(findPath(grid, { x: -5, z: 0 }, { x: 5, z: 0 })).toHaveLength(2);
  });
});

describe('nav grid re-baking', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const moved = (object: LevelObject, position: Vec3): LevelObject => ({ ...object, position });

  it('keys the signature only on what the grid bakes', () => {
    const group = levelObject('group', { modelId: '', type: 'player_start' });
    const crate = wall('crate', [3, 0, 0], [1, 1, 1]);
    const child = { ...wall('child', [0, 0, 0], [1, 1, 1]), parentId: 'group' };
    const light = levelObject('light', { modelId: '', components: [{ id: 'l', type: 'pointLight', enabled: true, props: {} }] });
    const mover = levelObject('mover', { components: [{ id: 'm', type: 'mover', enabled: true, props: {} }, boxCollider('mover', [1, 1, 1])] });
    const spawn = levelObject('spawn', { modelId: '', type: 'spawn_point' });
    const base = [group, crate, child, light, mover, spawn];
    const signature = navGridSignature(base);

    expect(navGridSignature([group, crate, child, moved(light, [5, 2, 5]), moved(mover, [9, 0, 9]), moved(spawn, [1, 0, 1])])).toBe(signature);
    expect(navGridSignature([group, moved(crate, [4, 0, 0]), child, light, mover, spawn])).not.toBe(signature);
    // The child's world transform comes from its parent.
    expect(navGridSignature([moved(group, [0, 0, 2]), crate, child, light, mover, spawn])).not.toBe(signature);
    // Giving an empty prop a model makes it solid.
    expect(navGridSignature([group, crate, child, { ...light, modelId: 'lamp' }, mover, spawn])).not.toBe(signature);
  });

  it('re-bakes outside render, at most once per interval', () => {
    vi.useFakeTimers();
    const crate = wall('crate', [0, 0, 0], [1, 1, 1]);
    const { result, rerender } = renderHook(
      ({ objects }: { objects: LevelObject[] | null }) => useNavGrid(objects, OPTIONS),
      { initialProps: { objects: [crate] as LevelObject[] | null } },
    );
    const first = result.current!;
    expect(isWalkable(first, 0, 0)).toBe(false);

    // Identity churn alone keeps the grid.
    rerender({ objects: [{ ...crate }] });
    expect(result.current).toBe(first);

    // A baked object moved: agents keep the old grid until the re-bake lands.
    rerender({ objects: [moved(crate, [4, 0, 0])] });
    expect(result.current).toBe(first);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    const second = result.current!;
    expect(second).not.toBe(first);
    expect(isWalkable(second, 0, 0)).toBe(true);
    expect(isWalkable(second, 4, 0)).toBe(false);

    // Moving it every frame re-bakes at most once per interval, with the latest objects.
    for (let frame = 1; frame <= 10; frame++) {
      rerender({ objects: [moved(crate, [4, 0, frame * 0.5])] });
      act(() => {
        vi.advanceTimersByTime(16);
      });
    }
    expect(result.current).toBe(second);
    act(() => {
      vi.advanceTimersByTime(NAV_REBAKE_INTERVAL_MS);
    });
    expect(result.current).not.toBe(second);
    expect(isWalkable(result.current!, 4, 5)).toBe(false);

    rerender({ objects: null });
    expect(result.current).toBeNull();
  });
});
