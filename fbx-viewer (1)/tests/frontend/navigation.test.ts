import { beforeAll, describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import * as THREE from 'three';
import {
  NAV_REBAKE_INTERVAL_MS,
  advanceWaypoint,
  useLevelNavMesh,
  type LevelNavMesh,
} from '../../runtime/navigation';
import { LevelNavMesh as NavMeshClass, recastReady } from '../../runtime/navMesh';
import { collectNavGeometry, modelTriangles, navGeometrySignature, type NavGeometryOptions } from '../../runtime/navGeometry';
import { resolveNavSettings } from '../../runtime/navSettings';
import type { LevelComponent, LevelObject } from '../../types';

type Vec3 = [number, number, number];

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

const boxCollider = (id: string, size: Vec3, props: Record<string, unknown> = {}): LevelComponent => ({
  id: `${id}-collider`,
  type: 'collider',
  enabled: true,
  props: { shape: 'box', size, offset: [0, size[1] / 2, 0], isTrigger: false, ...props },
});

/** A static wall: a box collider of `size` standing on the ground at `position`. */
const wall = (id: string, position: Vec3, size: Vec3): LevelObject =>
  levelObject(id, { position, components: [boxCollider(id, size)] });

const bake = (objects: LevelObject[], options: NavGeometryOptions = {}): LevelNavMesh => {
  const settings = resolveNavSettings(options.settings);
  const geometry = collectNavGeometry(objects, options);
  return NavMeshClass.bake({ positions: geometry.positions, indices: geometry.indices, links: geometry.links, settings }, geometry.groundHeight);
};

const at = (x: number, y: number, z: number) => ({ x, y, z });

const pathLength = (points: THREE.Vector3[]): number =>
  points.slice(1).reduce((sum, point, i) => sum + Math.hypot(point.x - points[i].x, point.z - points[i].z), 0);

const samplePath = (points: THREE.Vector3[], step = 0.05): THREE.Vector3[] => {
  const samples: THREE.Vector3[] = [];
  for (let i = 1; i < points.length; i++) {
    const count = Math.max(1, Math.ceil(points[i - 1].distanceTo(points[i]) / step));
    for (let s = 0; s <= count; s++) samples.push(points[i - 1].clone().lerp(points[i], s / count));
  }
  return samples;
};

// A closed pen around (5, 5).
const pen = (): LevelObject[] => [
  wall('north', [5, 0, 8], [7, 2, 1]),
  wall('south', [5, 0, 2], [7, 2, 1]),
  wall('east', [8, 0, 5], [1, 2, 7]),
  wall('west', [2, 0, 5], [1, 2, 7]),
];

describe('level navmesh', () => {
  it('routes around an obstacle in a few straight legs', () => {
    // A wall 1 m thick across z = -6..6 between the agent and its target.
    const navMesh = bake([wall('wall', [0, 0, 0], [1, 2, 12])]);
    expect(navMesh.isWalkable(at(-5, 0, 0))).toBe(true);
    expect(navMesh.isWalkable(at(0, 0, 0))).toBe(false);

    const plan = navMesh.planPath(at(-5, 0, 0), at(5, 0, 0))!;
    expect(plan.reachable).toBe(true);
    const points = plan.points;
    expect(points[0].x).toBeCloseTo(-5);
    expect(points[points.length - 1].x).toBeCloseTo(5);
    expect(points.length).toBeGreaterThan(2);
    // Never through the wall (Recast's contours may cut its corners a little inside the agent's radius).
    for (const sample of samplePath(points)) {
      expect(Math.abs(sample.x) > 0.6 || Math.abs(sample.z) > 6.1).toBe(true);
    }
    // String pulling leaves the corners of the shortest way round (~2 * hypot(5, 6.4)).
    expect(points.length).toBeLessThan(6);
    const length = pathLength(points);
    expect(length).toBeGreaterThan(2 * Math.hypot(5, 6));
    expect(length).toBeLessThan(17.5);
    navMesh.dispose();
  });

  it('bakes solid colliders solid, with only their tops walkable', () => {
    const crate = wall('crate', [0, 0, 0], [5, 5, 5]);
    const navMesh = bake([crate]);
    expect(navMesh.isWalkable(at(0, 0, 0))).toBe(false);
    expect(navMesh.isWalkable(at(1.5, 2.5, 0))).toBe(false);
    expect(navMesh.isWalkable(at(0, 5, 0))).toBe(true);
    navMesh.dispose();
  });

  it('keeps an open-field path straight', () => {
    const navMesh = bake([]);
    expect(navMesh.planPath(at(-6, 0, -4), at(7, 0, 5))!.points).toHaveLength(2);
    navMesh.dispose();
  });

  it('rejects an unreachable target, or stops as close as it can when asked', () => {
    const navMesh = bake(pen());
    const from = at(-5, 0, -5);
    const to = at(5, 0, 5);
    expect(navMesh.isWalkable(to)).toBe(true);
    expect(navMesh.planPath(from, to)).toBeNull();

    const partial = navMesh.planPath(from, to, { partial: true })!;
    expect(partial.reachable).toBe(false);
    const end = partial.points[partial.points.length - 1];
    // Outside the pen, right up against it.
    expect(Math.max(Math.abs(end.x - 5), Math.abs(end.z - 5))).toBeGreaterThan(3.5);
    expect(Math.hypot(end.x - 5, end.z - 5)).toBeLessThan(5.5);
    navMesh.dispose();
  });

  it('bakes only static, solid props', () => {
    const navMesh = bake([
      // No collider: the player's circle (radius = max(scale.x, scale.z) / 2).
      levelObject('crate', { position: [-5, 0, 0], scale: [2, 2, 2] }),
      // Moves at runtime, so it is not baked.
      levelObject('platform', { position: [0, 0, 0], scale: [2, 2, 2], components: [{ id: 'm', type: 'mover', enabled: true, props: {} }] }),
      // Trigger volumes do not block.
      levelObject('zone', { position: [5, 0, 0], components: [boxCollider('zone', [3, 2, 3], { isTrigger: true })] }),
      // Pickups are walked into.
      levelObject('medkit', { position: [-5, 0, 6], components: [{ id: 'p', type: 'pickup', enabled: true, props: {} }] }),
      // Overhead beam: an agent walks under it.
      levelObject('beam', { position: [0, 3, 5], components: [boxCollider('beam', [4, 0.5, 1])] }),
    ]);
    expect(navMesh.isWalkable(at(-5, 0, 0))).toBe(false);
    expect(navMesh.isWalkable(at(-6.8, 0, 0))).toBe(true);
    expect(navMesh.isWalkable(at(0, 0, 0))).toBe(true);
    expect(navMesh.isWalkable(at(5, 0, 0))).toBe(true);
    expect(navMesh.isWalkable(at(-5, 0, 6))).toBe(true);
    expect(navMesh.isWalkable(at(0, 0, 5))).toBe(true);
    navMesh.dispose();
  });

  it('keeps off terrain steeper than the slope limit, and follows the surface over gentle ground', () => {
    // A 20 m terrain with a ridge running along Z through x = 0 (5 m between samples).
    const terrain = (ridge: number): LevelObject => levelObject('terrain', {
      type: 'terrain',
      modelId: '',
      terrainData: { resolution: 4, width: 20, depth: 20, heights: Array.from({ length: 25 }, (_, i) => (i % 5 === 2 ? ridge : 0)) },
    });
    const from = at(-8, 0, 0);
    const to = at(8, 0, 0);

    // Steep: its flanks are not walkable, so the way across goes round the terrain's end.
    const steep = bake([terrain(10)]);
    expect(steep.isWalkable(at(-2.5, 5, 0))).toBe(false);
    expect(pathLength(steep.planPath(from, to)!.points)).toBeGreaterThan(25);
    steep.dispose();

    // Gentle: straight over the ridge, and an agent on its crest is on the navmesh.
    const gentle = bake([terrain(1)]);
    const plan = gentle.planPath(from, to)!;
    expect(pathLength(plan.points)).toBeLessThan(17);
    expect(gentle.moveAlongSurface(at(-0.5, 0.9, 0), at(0, 1, 0))).not.toBeNull();
    gentle.dispose();
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
    const light = levelObject('light', { modelId: '', position: [0, 2, 0], components: [{ id: 'light-c', type: 'pointLight', enabled: true, props: { intensity: 1 } }] });
    // A model-less prop with a mesh collider has no geometry for physics either.
    const meshOnly = levelObject('empty-mesh', { modelId: '', position: [4, 0, 0], components: [boxCollider('empty-mesh', [1, 1, 1], { shape: 'mesh' })] });
    const navMesh = bake([light, meshOnly]);
    expect(navMesh.isWalkable(at(0, 0, 0))).toBe(true);
    expect(navMesh.isWalkable(at(4, 0, 0))).toBe(true);
    navMesh.dispose();
  });

  it('keeps thin walls', () => {
    const navMesh = bake([wall('wall', [0, 0, 0], [0.1, 3, 12])]);
    expect(navMesh.isWalkable(at(0, 0, 0))).toBe(false);
    expect(navMesh.planPath(at(-5, 0, 0), at(5, 0, 0))!.points.length).toBeGreaterThan(2);
    // Moving straight at it slides along it and stops short of it.
    const moved = navMesh.moveAlongSurface(at(-2, 0, 0), at(2, 0, 0))!;
    expect(moved.x).toBeLessThan(-0.3);
    navMesh.dispose();
  });

  it('bakes capsules along their rotated axis with the physics height convention', () => {
    const capsule = (id: string, position: Vec3, rotation: Vec3, radius: number, height: number): LevelObject => levelObject(id, {
      position,
      rotation,
      components: [{ id: `${id}-c`, type: 'collider', enabled: true, props: { shape: 'capsule', radius, height, offset: [0, 0, 0], isTrigger: false } }],
    });
    // A 4 m log lying along world X.
    const log = bake([capsule('log', [0, 0.4, 0], [0, 0, Math.PI / 2], 0.3, 4)]);
    for (const x of [0.75, 1.25, 1.75]) expect(log.isWalkable(at(x, 0, 0))).toBe(false);
    expect(log.isWalkable(at(3, 0, 0))).toBe(true);
    expect(log.planPath(at(1.3, 0, -3), at(1.3, 0, 3))!.points.length).toBeGreaterThan(2);
    log.dispose();

    // Hanging with its bottom at 3.2 - (2 / 2) = 2.2 m, above the agent's height: walked under.
    const lamp = bake([capsule('lamp', [0, 3.2, 0], [0, 0, 0], 0.3, 2)]);
    expect(lamp.isWalkable(at(0, 0, 0))).toBe(true);
    lamp.dispose();
    // Upright on the ground it blocks.
    const post = bake([capsule('post', [0, 1, 0], [0, 0, 0], 0.3, 2)]);
    expect(post.isWalkable(at(0, 0, 0))).toBe(false);
    post.dispose();
  });

  it('bakes mesh colliders and fixed auto-hull bodies from the model\'s own triangles', () => {
    // An imported model is normalised to 5 m: here a 5 m cube standing on its base.
    const cube = new THREE.BoxGeometry(5, 5, 5).translate(0, 2.5, 0);
    const triangles = { positions: new Float32Array(cube.getAttribute('position').array), indices: new Uint32Array(cube.index!.array) };
    const shapeGeometry = (object: LevelObject) => (object.modelId === 'rock' ? triangles : null);
    const meshRock = levelObject('mesh-rock', { modelId: 'rock', components: [boxCollider('mesh-rock', [1, 1, 1], { shape: 'mesh', offset: [0, 0, 0] })] });
    const hullRock = levelObject('hull-rock', { modelId: 'rock', components: [{ id: 'rb', type: 'rigidBody', enabled: true, props: { type: 'fixed' } }] });
    for (const rock of [meshRock, hullRock]) {
      const shaped = bake([rock], { shapeGeometry });
      // Agents go round it, and cannot get into it.
      expect(shaped.isWalkable(at(3.5, 0, 0))).toBe(true);
      expect(shaped.planPath(at(-4, 0, 0), at(4, 0, 0))!.points.length).toBeGreaterThan(2);
      // Its middle is out of reach (a point just inside it would snap to the ground beside it).
      expect(shaped.planPath(at(-4, 0, 0), at(0, 0, 0))).toBeNull();
      // A hull is solid; a triangle mesh may be hollow (a building), so only its outside is certain.
      if (rock === hullRock) expect(shaped.isWalkable(at(2, 0, 0))).toBe(false);
      // Its top is walkable, out of reach.
      expect(shaped.isWalkable(at(0, 5, 0))).toBe(true);
      shaped.dispose();
      // Without the model's triangles they keep the scale circle.
      const circle = bake([rock]);
      expect(circle.isWalkable(at(2, 0, 0))).toBe(true);
      expect(circle.isWalkable(at(0, 0, 0))).toBe(false);
      circle.dispose();
    }
  });

  it('bakes a prop without colliders from its model: its trunk blocks, its branches are walked under', () => {
    // A tree: a 0.6 m trunk up to 2.5 m, under a 4 m wide canopy from 2.5 m to 4 m.
    const trunk = new THREE.BoxGeometry(0.6, 2.5, 0.6).translate(0, 1.25, 0);
    const canopy = new THREE.BoxGeometry(4, 1.5, 4).translate(0, 3.25, 0);
    const merge = (parts: THREE.BufferGeometry[]) => {
      const positions: number[] = [];
      const indices: number[] = [];
      for (const part of parts) {
        const base = positions.length / 3;
        positions.push(...part.getAttribute('position').array);
        indices.push(...Array.from(part.index!.array, i => i + base));
      }
      return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
    };
    const tree = merge([trunk, canopy]);
    const navMesh = bake([levelObject('tree', { modelId: 'tree', position: [0, 0, 0] })], { shapeGeometry: o => (o.modelId === 'tree' ? tree : null) });
    expect(navMesh.isWalkable(at(0, 0, 0))).toBe(false);
    expect(navMesh.isWalkable(at(1.5, 0, 0))).toBe(true);
    expect(navMesh.planPath(at(-5, 0, 1.2), at(5, 0, 1.2))!.points).toHaveLength(2);
    navMesh.dispose();
  });

  it('takes the triangles of a model as it is placed, its import normalisation included', () => {
    // An FBX authored in centimetres: a 200-unit cube, normalised to 2 m by its root's scale.
    const model = new THREE.Group();
    model.scale.setScalar(0.01);
    model.add(new THREE.Mesh(new THREE.BoxGeometry(200, 200, 200).translate(0, 100, 0)));
    const triangles = modelTriangles(model)!;
    const box = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(triangles.positions, 3));
    expect(box.max.x - box.min.x).toBeCloseTo(2);
    expect(box.max.y).toBeCloseTo(2);
  });

  it('tells a walled-off target from one that is only out of reach for now', () => {
    // Off the navmesh: a chase keeps closing in rather than giving up.
    const open = bake([]);
    const away = at(150, 0, 0);
    expect(open.planPath(at(8, 0, 0), away, { partial: true })!.reachable).toBe(false);
    expect(open.isWalledOff(away)).toBe(false);
    // In the air above walkable ground: may land within reach.
    expect(open.isWalledOff(at(0, 3, 0))).toBe(false);
    open.dispose();

    // On top of a 10 x 10 m platform 1 m high with no way up: may be reached by jumping.
    const raised = bake([levelObject('platform', { position: [0, 0.5, 0], scale: [10, 1, 10], components: [boxCollider('platform', [1, 1, 1], { offset: [0, 0, 0] })] })]);
    const top = at(0, 1, 0);
    expect(raised.isWalkable(top)).toBe(true);
    expect(raised.planPath(at(8, 0, 0), top, { partial: true })!.reachable).toBe(false);
    expect(raised.isWalledOff(top)).toBe(false);
    raised.dispose();

    // Inside a closed pen at ground level: walled off, so a chase holds outside.
    const penned = bake(pen());
    expect(penned.isWalledOff(at(5, 0, 5))).toBe(true);
    expect(penned.isWalledOff({ x: 5, z: 5 })).toBe(true);
    penned.dispose();
  });

  it('picks random patrol points the agent can reach', () => {
    const navMesh = bake(pen());
    for (let i = 0; i < 20; i++) {
      const point = navMesh.randomPointAround(at(-5, 0, -5), 6)!;
      expect(point).not.toBeNull();
      expect(navMesh.planPath(at(-5, 0, -5), point)!.reachable).toBe(true);
    }
    navMesh.dispose();
  });
});

describe('raised surfaces', () => {
  // A 6 x 6 m platform, 1 m high, over x 1..7, z -3..3.
  const platform = wall('platform', [4, 0, 0], [6, 1, 6]);
  // A 2 m wide ramp whose top face runs from the ground at x = -4 up to the platform edge at (1, 1).
  const rampAngle = Math.atan2(1, 5);
  const ramp = levelObject('ramp', {
    position: [-1.5 + Math.sin(rampAngle) * 0.1, 0.5 - Math.cos(rampAngle) * 0.1, 0],
    rotation: [0, 0, rampAngle],
    components: [boxCollider('ramp', [Math.hypot(5, 1), 0.2, 2], { offset: [0, 0, 0] })],
  });
  // Stairs up the platform's south side: 0.25 m risers on 0.4 m treads.
  const stairs = [1, 2, 3].map(i => wall(`step${i}`, [4, 0, -3 - 0.4 * (4 - i) + 0.2], [2, 0.25 * i, 0.4]));
  const top = at(4, 1, 0);

  it('bakes a platform top as walkable, kept the agent radius back from its edges', () => {
    const navMesh = bake([platform]);
    expect(navMesh.isWalkable(top)).toBe(true);
    expect(navMesh.isWalkable(at(1.25, 1, 0))).toBe(false);
    expect(navMesh.isWalkable(at(0.75, 0, 0))).toBe(false);
    expect(navMesh.isWalkable(at(0.25, 0, 0))).toBe(true);

    // A 1 m climb is more than a step: no path, and a partial one ends on the ground.
    const ground = at(-8, 0, 0);
    expect(navMesh.planPath(ground, top)).toBeNull();
    const partial = navMesh.planPath(ground, top, { partial: true })!;
    expect(partial.reachable).toBe(false);
    expect(Math.abs(partial.points[partial.points.length - 1].y)).toBeLessThan(0.05);
    navMesh.dispose();
  });

  it('climbs onto a platform up a ramp', () => {
    const navMesh = bake([platform, ramp]);
    expect(navMesh.isWalkable(at(-1.25, 0.55, 0))).toBe(true);
    const plan = navMesh.planPath(at(-8, 0, 0), top)!;
    expect(plan.reachable).toBe(true);
    expect(plan.points[plan.points.length - 1].y).toBeCloseTo(1, 1);
    navMesh.dispose();
  });

  it('climbs stairs whose risers are a step high, but not when the step is lower', () => {
    const from = at(4, 0, -8);
    const navMesh = bake([platform, ...stairs]);
    expect(navMesh.planPath(from, top)!.reachable).toBe(true);
    navMesh.dispose();

    const lowStep = bake([platform, ...stairs], { settings: { maxStepHeight: 0.15 } });
    expect(lowStep.planPath(from, top)).toBeNull();
    expect(lowStep.isWalkable(top)).toBe(true);
    lowStep.dispose();
  });

  it('keeps walking under a top with headroom above the ground', () => {
    const canopy = levelObject('canopy', { position: [0, 2, 0], components: [boxCollider('canopy', [4, 0.2, 4])] });
    const navMesh = bake([canopy]);
    expect(navMesh.isWalkable(at(0, 0, 0))).toBe(true);
    expect(navMesh.planPath(at(-5, 0, 0), at(5, 0, 0))!.points).toHaveLength(2);
    navMesh.dispose();
  });

  it('crosses Nav Links where the navmesh does not join up, only the ways they go', () => {
    const link = (bidirectional: boolean): LevelObject => levelObject('ladder', {
      modelId: '',
      position: [0, 0, 0],
      components: [{ id: 'link', type: 'navLink', enabled: true, props: { end: [2, 1, 0], bidirectional, radius: 0.6 } }],
    });
    const ground = at(-6, 0, 0);
    const both = bake([platform, link(true)]);
    expect(both.links).toHaveLength(1);
    expect(both.planPath(ground, top)!.reachable).toBe(true);
    expect(both.planPath(top, ground)!.reachable).toBe(true);
    both.dispose();

    const upOnly = bake([platform, link(false)]);
    expect(upOnly.planPath(ground, top)!.reachable).toBe(true);
    expect(upOnly.planPath(top, ground)).toBeNull();
    upOnly.dispose();
  });
});

describe('moving obstacles', () => {
  it('carves a hole agents path around, and closes it when removed', () => {
    const navMesh = bake([]);
    const from = at(-6, 0, 0);
    const to = at(6, 0, 0);
    expect(navMesh.planPath(from, to)!.points).toHaveLength(2);

    const version = navMesh.version;
    const obstacle = navMesh.addCylinderObstacle(at(0, -1, 0), 2, 3);
    for (let i = 0; i < 16 && navMesh.version === version; i++) navMesh.update();
    expect(navMesh.version).toBeGreaterThan(version);
    expect(navMesh.isWalkable(at(0, 0, 0))).toBe(false);
    const around = navMesh.planPath(from, to)!;
    expect(around.points.length).toBeGreaterThan(2);
    for (const sample of samplePath(around.points)) expect(Math.hypot(sample.x, sample.z)).toBeGreaterThan(1.9);

    navMesh.removeObstacle(obstacle);
    for (let i = 0; i < 16 && navMesh.version === version + 1; i++) navMesh.update();
    expect(navMesh.planPath(from, to)!.points).toHaveLength(2);
    navMesh.dispose();
  });
});

describe('navmesh re-baking', () => {
  const moved = (object: LevelObject, position: Vec3): LevelObject => ({ ...object, position });

  it('keys the signature only on what the navmesh bakes', () => {
    const group = levelObject('group', { modelId: '', type: 'player_start' });
    const crate = wall('crate', [3, 0, 0], [1, 1, 1]);
    const child = { ...wall('child', [0, 0, 0], [1, 1, 1]), parentId: 'group' };
    const light = levelObject('light', { modelId: '', components: [{ id: 'l', type: 'pointLight', enabled: true, props: {} }] });
    const mover = levelObject('mover', { components: [{ id: 'm', type: 'mover', enabled: true, props: {} }, boxCollider('mover', [1, 1, 1])] });
    const spawn = levelObject('spawn', { modelId: '', type: 'spawn_point' });
    const base = [group, crate, child, light, mover, spawn];
    const signature = navGeometrySignature(base);

    expect(navGeometrySignature([group, crate, child, moved(light, [5, 2, 5]), moved(mover, [9, 0, 9]), moved(spawn, [1, 0, 1])])).toBe(signature);
    expect(navGeometrySignature([group, moved(crate, [4, 0, 0]), child, light, mover, spawn])).not.toBe(signature);
    // The child's world transform comes from its parent.
    expect(navGeometrySignature([moved(group, [0, 0, 2]), crate, child, light, mover, spawn])).not.toBe(signature);
    // Giving an empty prop a model makes it solid.
    expect(navGeometrySignature([group, crate, child, { ...light, modelId: 'lamp' }, mover, spawn])).not.toBe(signature);
    // A Nav Link is baked even on an object that blocks nothing.
    const linked = { ...spawn, components: [{ id: 'link', type: 'navLink', enabled: true, props: { end: [0, 0, 3] } }] };
    expect(navGeometrySignature([group, crate, child, light, mover, linked])).not.toBe(signature);
  });

  it('bakes when objects arrive, and again at most once per interval as they change', async () => {
    const crate = wall('crate', [0, 0, 0], [1, 1, 1]);
    const { result, rerender, unmount } = renderHook(
      ({ objects }: { objects: LevelObject[] | null }) => useLevelNavMesh(objects),
      { initialProps: { objects: [crate] as LevelObject[] | null } },
    );
    await waitFor(() => expect(result.current).not.toBeNull(), { timeout: 10000 });
    const first = result.current!;
    expect(first.isWalkable(at(0, 0, 0))).toBe(false);

    // Identity churn alone keeps the navmesh.
    rerender({ objects: [{ ...crate }] });
    expect(result.current).toBe(first);

    // A baked object moved: agents keep the old navmesh until the new one is ready.
    rerender({ objects: [moved(crate, [4, 0, 0])] });
    expect(result.current).toBe(first);
    await waitFor(() => expect(result.current).not.toBe(first), { timeout: NAV_REBAKE_INTERVAL_MS + 10000 });
    const second = result.current!;
    expect(second.isWalkable(at(0, 0, 0))).toBe(true);
    expect(second.isWalkable(at(4, 0, 0))).toBe(false);

    rerender({ objects: null });
    expect(result.current).toBeNull();
    unmount();
  }, 30000);
});
