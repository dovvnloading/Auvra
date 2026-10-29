import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  appendSplinePoint,
  buildSpline,
  duplicateSplinePoint,
  insertSplinePointAt,
  readSplineData,
  removeSplinePoint,
  reverseSpline,
  splineFrameQuaternion,
  splinePoint,
  updateSplinePoint,
  writeSplineData,
  type SplineData,
  type SplineVec3,
} from '../../runtime/splines';
import {
  buildSplineMesh,
  planSplineMeshCopies,
  readSplineMeshSettings,
  readSplineScatterSettings,
  scatterAlongSpline,
  scatterBoxes,
  sliceGeometry,
  splineMeshTriangles,
  splineModelParts,
  splineObjectTriangles,
} from '../../runtime/splineMesh';
import { stepFollow } from '../../runtime/components/splineComponents';
import { flattenTerrainAlongSpline, paintTerrainAlongSpline } from '../../components/Environment/splineTerrain';
import { collectNavGeometry } from '../../runtime/navGeometry';
import type { LevelObject } from '../../types';
import { SplinePatrol } from '../../runtime/patrolPath';
import { liveSplineQuery, type LiveSpline } from '../../runtime/splineRegistry';
import { flowNodeOutputValue, type FlowNode } from '../../hooks/levelBlueprintNodes/flow';
import { WORLD_NODE_DEFINITIONS, WORLD_NODE_EXECUTORS, type WorldNodeServices, type WorldNodeType } from '../../hooks/levelBlueprintNodes/world';
import { createLevelVariablesStore } from '../../runtime/levelVariables';
import { createBehaviorMemory, tickBehaviorTree } from '../../runtime/behaviorTree';
import { createScriptSpline } from '../../runtime/scripting/scriptSplines';
import { scriptSplineUpdates } from '../../runtime/scripting/ScriptRuntime';
import { createScriptHost, isScriptSnapshot } from '../../runtime/scripting/scriptApi';
import type { ScriptCommand, ScriptSnapshot } from '../../runtime/scripting/protocol';

const spline = (positions: SplineVec3[], patch: Partial<SplineData> = {}, mode: 'auto' | 'linear' = 'auto') =>
  ({ points: positions.map(position => splinePoint(position, { mode })), closed: false, up: 'world', ...patch }) as SplineData;

const ARC: SplineVec3[] = [[0, 0, 0], [5, 0, -3], [10, 0, 0], [15, 0, 4]];

describe('spline curve', () => {
  it('measures a straight run of corner points exactly and samples it evenly', () => {
    const line = buildSpline(spline([[0, 0, 0], [4, 0, 0], [10, 0, 0]], {}, 'linear'));
    expect(line.length).toBeCloseTo(10, 6);
    expect(line.positionAt(2.5).x).toBeCloseTo(2.5, 4);
    expect(line.positionAt(7).x).toBeCloseTo(7, 4);
    expect(line.distanceAtPoint(1)).toBeCloseTo(4, 6);
  });

  it('passes through every point, at the distance it reports for it', () => {
    const curve = buildSpline(spline(ARC));
    ARC.forEach((position, index) => {
      const at = curve.positionAt(curve.distanceAtPoint(index));
      expect(at.distanceTo(new THREE.Vector3(...position))).toBeLessThan(1e-4);
    });
  });

  it('moves the same distance for the same step anywhere along it', () => {
    const curve = buildSpline(spline([[0, 0, 0], [1, 0, 1], [8, 0, 0], [9, 0, 6], [20, 0, 6]]));
    const steps = 200;
    const step = curve.length / steps;
    let previous = curve.positionAt(0);
    for (let i = 1; i <= steps; i++) {
      const next = curve.positionAt(i * step);
      // Chords of a curve are a little shorter than the arc; never longer, and never far off.
      expect(next.distanceTo(previous)).toBeLessThanOrEqual(step * 1.0005);
      expect(next.distanceTo(previous)).toBeGreaterThan(step * 0.97);
      previous = next;
    }
  });

  it('keeps unevenly spaced points free of loops (centripetal)', () => {
    const curve = buildSpline(spline([[0, 0, 0], [0.2, 0, 0], [10, 0, 0.1], [10.2, 0, 0]]));
    // A uniform Catmull-Rom overshoots back past the start here; the centripetal one stays ahead of it.
    for (let i = 0; i <= 100; i++) expect(curve.positionAt((curve.length * i) / 100).x).toBeGreaterThan(-0.05);
  });

  it('closes into a loop that wraps distances round', () => {
    const radius = 5;
    const around: SplineVec3[] = Array.from({ length: 8 }, (_, i) => [Math.cos(i * Math.PI / 4) * radius, 0, Math.sin(i * Math.PI / 4) * radius]);
    const circle = buildSpline(spline(around, { closed: true }));
    expect(circle.closed).toBe(true);
    // Eight Catmull-Rom points round a circle come within a percent or two of it.
    expect(circle.length / (2 * Math.PI * radius)).toBeGreaterThan(0.98);
    expect(circle.length / (2 * Math.PI * radius)).toBeLessThan(1.01);
    expect(circle.positionAt(circle.length + 1).distanceTo(circle.positionAt(1))).toBeLessThan(1e-6);
    expect(circle.positionAt(-1).distanceTo(circle.positionAt(circle.length - 1))).toBeLessThan(1e-6);
  });

  it('honours a custom tangent', () => {
    const data = updateSplinePoint(spline([[0, 0, 0], [10, 0, 0]]), 0, { mode: 'custom', tangent: [0, 0, 20] });
    const tangent = buildSpline(data).tangentAt(0);
    expect(tangent.z).toBeCloseTo(1, 4);
  });

  it('finds the nearest distance to a point beside it', () => {
    const curve = buildSpline(spline(ARC));
    const at = curve.length * 0.37;
    const frame = curve.frameAt(at);
    const beside = frame.position.clone().addScaledVector(frame.right, 0.8);
    expect(curve.closestDistance(beside)).toBeCloseTo(at, 2);
  });
});

describe('spline frames', () => {
  it('stays level on a flat curve, and its rotation faces a model along it', () => {
    const curve = buildSpline(spline(ARC));
    for (let i = 0; i <= 20; i++) {
      const frame = curve.frameAt((curve.length * i) / 20);
      expect(frame.up.y).toBeCloseTo(1, 5);
      expect(frame.right.clone().sub(new THREE.Vector3().crossVectors(frame.tangent, frame.up)).length()).toBeLessThan(1e-6);
      const rotation = splineFrameQuaternion(frame);
      expect(new THREE.Vector3(0, 0, 1).applyQuaternion(rotation).distanceTo(frame.tangent)).toBeLessThan(1e-5);
      expect(new THREE.Vector3(0, 1, 0).applyQuaternion(rotation).distanceTo(frame.up)).toBeLessThan(1e-5);
    }
  });

  it('rolls at a point by its roll, easing in and out between points', () => {
    const data = updateSplinePoint(spline([[0, 0, 0], [5, 0, 0], [10, 0, 0]], {}, 'linear'), 1, { roll: 90 });
    const curve = buildSpline(data);
    const middle = curve.frameAt(5);
    // Travelling +X, a quarter roll turns up (+Y) toward +Z or -Z.
    expect(Math.abs(middle.up.z)).toBeCloseTo(1, 4);
    expect(curve.frameAt(0).up.y).toBeCloseTo(1, 4);
    const partWay = curve.frameAt(2.5).roll;
    expect(partWay).toBeGreaterThan(0);
    expect(partWay).toBeLessThan(Math.PI / 2);
  });

  it('turns as little as possible round a climbing helix, and stays square to it', () => {
    const turns: SplineVec3[] = [];
    for (let i = 0; i <= 16; i++) turns.push([Math.cos(i * Math.PI / 4) * 6, i * 1.5, Math.sin(i * Math.PI / 4) * 6]);
    const curve = buildSpline(spline(turns, { up: 'minimal' }));
    let previous = curve.frameAt(0).up.clone();
    for (let i = 1; i <= 400; i++) {
      const frame = curve.frameAt((curve.length * i) / 400);
      expect(Math.abs(frame.up.dot(frame.tangent))).toBeLessThan(1e-5);
      // No flips between neighbouring samples.
      expect(frame.up.dot(previous)).toBeGreaterThan(0.95);
      previous = frame.up.clone();
    }
  });

  it('carries scale between points', () => {
    const data = updateSplinePoint(spline([[0, 0, 0], [10, 0, 0]], {}, 'linear'), 1, { scale: [3, 2] });
    const curve = buildSpline(data);
    expect(curve.frameAt(0).scale.x).toBeCloseTo(1, 5);
    expect(curve.frameAt(10).scale.x).toBeCloseTo(3, 5);
    expect(curve.frameAt(10).scale.y).toBeCloseTo(2, 5);
  });
});

describe('spline editing', () => {
  it('reads what it writes, and falls back to a default curve for bad props', () => {
    const data = updateSplinePoint(spline(ARC, { closed: true, up: 'minimal' }), 2, { mode: 'custom', tangent: [1, 2, 3], roll: 15, scale: [2, 1] });
    expect(readSplineData(writeSplineData(data))).toEqual(data);
    expect(readSplineData({ points: 'nonsense' }).points.length).toBeGreaterThanOrEqual(2);
    expect(readSplineData({ points: [{ position: [0, 0, 'x'] }, { nope: 1 }, { position: [1, 2, 3] }] }).points.map(point => point.position)).toEqual([[0, 0, 0], [1, 2, 3]]);
    // Auto points without roll or scale store only their position.
    expect(writeSplineData(spline([[1, 2, 3]])).points).toEqual([{ position: [1, 2, 3] }]);
  });

  it('inserts a point on the curve where it is asked for', () => {
    const data = spline(ARC);
    const before = buildSpline(data);
    const at = before.length * 0.6;
    const { data: inserted, index } = insertSplinePointAt(data, at);
    expect(inserted.points).toHaveLength(ARC.length + 1);
    expect(new THREE.Vector3(...inserted.points[index].position).distanceTo(before.positionAt(at))).toBeLessThan(1e-3);
  });

  it('duplicates, appends, removes and reverses points', () => {
    const data = spline(ARC);
    const duplicated = duplicateSplinePoint(data, 1);
    expect(duplicated.index).toBe(2);
    expect(duplicated.data.points[2].position).toEqual(ARC[1]);
    // At the start of an open spline the copy goes before, so dragging it extends the start.
    expect(duplicateSplinePoint(data, 0).index).toBe(0);

    const appended = appendSplinePoint(data);
    expect(appended.data.points).toHaveLength(ARC.length + 1);
    expect(appended.data.points[appended.index].position[0]).toBeGreaterThan(ARC[ARC.length - 1][0]);

    expect(removeSplinePoint(data, 1).points.map(point => point.position)).toEqual([ARC[0], ARC[2], ARC[3]]);
    expect(removeSplinePoint(spline([[0, 0, 0], [1, 0, 0]]), 0).points).toHaveLength(2);

    const reversed = reverseSpline(updateSplinePoint(data, 0, { mode: 'custom', tangent: [1, 0, 0] }));
    expect(reversed.points.map(point => point.position)).toEqual([...ARC].reverse());
    expect(reversed.points[ARC.length - 1].tangent).toEqual([-1, -0, -0]);
    expect(buildSpline(reversed).length).toBeCloseTo(buildSpline(updateSplinePoint(data, 0, { mode: 'custom', tangent: [1, 0, 0] })).length, 3);
  });
});

/** A box model 2 wide, 1 high and 4 long along Z, as a loaded model's mesh. */
const plank = () => {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(2, 1, 4), new THREE.MeshStandardMaterial()));
  return group;
};

describe('spline mesh', () => {
  it('cuts triangles across the length without losing area', () => {
    const geometry = new THREE.PlaneGeometry(1, 10).rotateX(-Math.PI / 2).toNonIndexed();
    const sliced = sliceGeometry(geometry, 2, [-2.5, 0, 2.5]);
    expect(sliced.getAttribute('position').count).toBeGreaterThan(geometry.getAttribute('position').count);
    const area = (g: THREE.BufferGeometry) => {
      const p = g.getAttribute('position');
      let sum = 0;
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      for (let i = 0; i < p.count; i += 3) {
        a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
        sum += b.sub(a).cross(c.sub(a)).length() / 2;
      }
      return sum;
    };
    expect(area(sliced)).toBeCloseTo(area(geometry), 4);
    // UVs are blended at the cuts like positions.
    expect(sliced.getAttribute('uv').count).toBe(sliced.getAttribute('position').count);
  });

  it('tiles a model end to end along the spline', () => {
    const plan = planSplineMeshCopies(21, 4, { fit: 'tile', gap: 0, scale: [1, 1, 1], start: 0, end: 0 });
    expect(plan.copies).toBe(5);
    expect(plan.length).toBeCloseTo(4.2, 6);
    expect(planSplineMeshCopies(21, 4, { fit: 'stretch', gap: 0, scale: [1, 1, 1], start: 1, end: 2 })).toEqual({ copies: 1, first: 1, pitch: 18, length: 18 });
    expect(planSplineMeshCopies(21, 4, { fit: 'tile', gap: 1, scale: [1, 1, 1], start: 0, end: 0 }).copies).toBe(4);
  });

  it('bends the model along the curve, its width across it', () => {
    const curve = buildSpline(spline(ARC));
    const settings = readSplineMeshSettings({ modelId: 'plank', smoothness: 0.25 });
    const build = buildSplineMesh(splineModelParts(plank()), curve, settings);
    expect(build.copies).toBe(Math.round(curve.length / 4));
    const position = build.parts[0].geometry.getAttribute('position');
    const vertex = new THREE.Vector3();
    for (let i = 0; i < position.count; i += 7) {
      vertex.fromBufferAttribute(position, i);
      const frame = curve.frameAt(curve.closestDistance(vertex));
      const offset = vertex.clone().sub(frame.position);
      // Every vertex sits within the plank's half width (1) and height (0.5) of the curve, never ahead or behind it.
      expect(Math.abs(offset.dot(frame.right))).toBeLessThan(1.02);
      expect(Math.abs(offset.dot(frame.up))).toBeLessThan(0.52);
    }
    const normal = build.parts[0].geometry.getAttribute('normal');
    for (let i = 0; i < normal.count; i += 11) expect(new THREE.Vector3().fromBufferAttribute(normal, i).length()).toBeCloseTo(1, 4);
  });

  it('gives collision a welded triangle mesh', () => {
    const curve = buildSpline(spline([[0, 0, 0], [8, 0, 0]], {}, 'linear'));
    const build = buildSplineMesh(splineModelParts(plank()), curve, readSplineMeshSettings({ modelId: 'plank' }));
    const triangles = splineMeshTriangles(build.parts)!;
    expect(triangles.indices.length % 3).toBe(0);
    // Welding shares the corners of neighbouring faces.
    expect(triangles.positions.length / 3).toBeLessThan(build.parts[0].geometry.getAttribute('position').count);
  });
});

describe('spline scatter', () => {
  it('spaces copies along an open spline from end to end, the same for the same seed', () => {
    const curve = buildSpline(spline([[0, 0, 0], [10, 0, 0]], {}, 'linear'));
    const settings = readSplineScatterSettings({ spacing: 2.5, yawJitter: 30, scaleJitter: 0.2, seed: 7 });
    const copies = scatterAlongSpline(curve, settings);
    expect(copies).toHaveLength(5);
    expect(new THREE.Vector3().setFromMatrixPosition(copies[4]).x).toBeCloseTo(10, 5);
    expect(scatterAlongSpline(curve, settings).map(m => m.elements)).toEqual(copies.map(m => m.elements));
    expect(scatterAlongSpline(curve, { ...settings, bothSides: true, offset: [3, 0] })).toHaveLength(10);
  });

  it('faces copies along the spline when upright', () => {
    const curve = buildSpline(spline([[0, 0, 0], [0, 0, 10]], {}, 'linear'));
    const [first] = scatterAlongSpline(curve, readSplineScatterSettings({ spacing: 5 }));
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(first));
    expect(forward.z).toBeCloseTo(1, 5);
  });

  it('boxes each copy for collision', () => {
    const boxes = scatterBoxes(new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1)), [new THREE.Matrix4(), new THREE.Matrix4().makeTranslation(5, 0, 0)])!;
    expect(boxes.positions.length).toBe(2 * 8 * 3);
    expect(boxes.indices.length).toBe(2 * 36);
  });
});

describe('follow spline', () => {
  it('loops, goes back and forth, or stops at the end', () => {
    const start = { distance: 8, direction: 1 as const, finished: false };
    expect(stepFollow(start, 4, 10, false, 'loop').distance).toBeCloseTo(2);
    const bounced = stepFollow(start, 4, 10, false, 'pingPong');
    expect(bounced.distance).toBeCloseTo(8);
    expect(bounced.direction).toBe(-1);
    const once = stepFollow(start, 4, 10, false, 'once');
    expect(once).toEqual({ distance: 10, direction: 1, finished: true });
    expect(stepFollow(once, 4, 10, false, 'once')).toBe(once);
    // Round a closed loop it keeps going.
    expect(stepFollow(start, 4, 10, true, 'loop').distance).toBeCloseTo(2);
  });
});

const terrain = (heights?: number[]): LevelObject => ({
  id: 'terrain', levelId: 'level', modelId: '', name: 'Terrain', type: 'terrain',
  position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
  terrainData: { resolution: 40, width: 40, depth: 40, heights: heights ?? new Array(41 * 41).fill(0) },
} as LevelObject);

describe('terrain along a spline', () => {
  it('flattens a strip to the curve height and blends back over the falloff', () => {
    // A road 3 m up, running along X through the middle of the terrain.
    const road = buildSpline(spline([[-15, 3, 0], [15, 3, 0]], {}, 'linear'));
    const heights = flattenTerrainAlongSpline(terrain(), road, new THREE.Matrix4(), { width: 4, falloff: 4, depth: 0.5 })!;
    const at = (x: number, z: number) => heights[(z + 20) * 41 + (x + 20)];
    expect(at(0, 0)).toBeCloseTo(2.5, 5);
    expect(at(0, 2)).toBeCloseTo(2.5, 5);
    expect(at(0, 4)).toBeGreaterThan(0);
    expect(at(0, 4)).toBeLessThan(2.5);
    expect(at(0, 10)).toBe(0);
    // Past the ends the strip blends out in a round cap.
    expect(at(19, 0)).toBeGreaterThan(0);
    expect(at(19, 0)).toBeLessThan(2.5);
    expect(flattenTerrainAlongSpline(terrain(), buildSpline(spline([[100, 0, 100], [110, 0, 100]], {}, 'linear')), new THREE.Matrix4(), { width: 4, falloff: 2, depth: 0 })).toBeNull();
  });

  it('paints a layer under the curve, keeping weights summing to 255', () => {
    const road = buildSpline(spline([[-15, 0, 0], [15, 0, 0]], {}, 'linear'));
    const splat = paintTerrainAlongSpline(terrain(), road, new THREE.Matrix4(), { width: 4, falloff: 2, depth: 0 }, 2)!;
    const at = (x: number, z: number) => splat.slice(((z + 20) * 41 + (x + 20)) * 4, ((z + 20) * 41 + (x + 20)) * 4 + 4);
    expect(at(0, 0)).toEqual([0, 0, 255, 0]);
    expect(at(0, 15)).toEqual([255, 0, 0, 0]);
    const edge = at(0, 3);
    expect(edge.reduce((sum, value) => sum + value, 0)).toBe(255);
  });
});

describe('spline navigation', () => {
  it('bakes a spline mesh with collision into the navmesh', () => {
    const model = plank();
    const object = {
      id: 'road', levelId: 'level', modelId: '', name: 'Road', type: 'prop',
      position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
      components: [
        { id: 's', type: 'spline', enabled: true, props: writeSplineData(spline([[0, 2, 0], [12, 2, 0]], {}, 'linear')) },
        { id: 'm', type: 'splineMesh', enabled: true, props: { modelId: 'plank' } },
      ],
    } as LevelObject;
    const triangles = splineObjectTriangles(object, id => (id === 'plank' ? model : null));
    expect(triangles).not.toBeNull();
    const without = collectNavGeometry([object]);
    const withSpline = collectNavGeometry([object], { splineGeometry: candidate => splineObjectTriangles(candidate, id => (id === 'plank' ? model : null)) });
    expect(withSpline.indices.length - without.indices.length).toBeGreaterThan(0);
    // With collision off it is not solid.
    const ghost = { ...object, components: [object.components![0], { ...object.components![1], props: { modelId: 'plank', collision: false } }] } as LevelObject;
    expect(splineObjectTriangles(ghost, () => model)).toBeNull();
  });
});

/** A spline drawn by an object at `position`, as the registry holds it. */
const live = (data: SplineData, position: SplineVec3 = [0, 0, 0], scale = 1): LiveSpline => {
  const node = new THREE.Object3D();
  node.position.set(...position);
  node.scale.setScalar(scale);
  node.updateMatrixWorld(true);
  return { objectId: 'path', mode: 'runtime', spline: buildSpline(data), node };
};

describe('patrol paths', () => {
  it('joins an open path where it is nearest, walks it to the end and back, pausing at the end', () => {
    const path = live(spline([[0, 0, 0], [12, 0, 0]], {}, 'linear'), [0, 0, 5]);
    const patrol = new SplinePatrol(() => path, 3);
    const first = patrol.next(new THREE.Vector3(2, 0, 7))!;
    expect(first.point.toArray().map(v => +v.toFixed(3))).toEqual([2, 0, 5]);
    const seen: number[] = [];
    const ends: boolean[] = [];
    let at = first.point;
    for (let i = 0; i < 8; i++) {
      const waypoint = patrol.next(at)!;
      seen.push(+waypoint.point.x.toFixed(3));
      ends.push(waypoint.end);
      at = waypoint.point;
    }
    // Toward the longer stretch first, 3 m at a time, back from the end.
    expect(seen).toEqual([5, 8, 11, 12, 9, 6, 3, 0]);
    expect(ends).toEqual([false, false, false, true, false, false, false, true]);
  });

  it('goes round a closed path, in metres however the path object is scaled', () => {
    const square: SplineVec3[] = [[0, 0, 0], [4, 0, 0], [4, 0, 4], [0, 0, 4]];
    const path = live(spline(square, { closed: true }, 'linear'), [0, 0, 0], 2);
    const patrol = new SplinePatrol(() => path, 4);
    let at = patrol.next(new THREE.Vector3(0, 0, 0))!.point;
    for (let i = 0; i < 4; i++) {
      const next = patrol.next(at)!;
      expect(next.end).toBe(false);
      expect(next.point.distanceTo(at)).toBeCloseTo(4, 3);
      at = next.point;
    }
    expect(at.distanceTo(new THREE.Vector3(8, 0, 8))).toBeLessThan(1e-3);
  });

  it('rejoins the path after wandering off it, and gives nothing without one', () => {
    const path = live(spline([[0, 0, 0], [30, 0, 0]], {}, 'linear'));
    const patrol = new SplinePatrol(() => path, 3);
    patrol.next(new THREE.Vector3(0, 0, 0));
    patrol.next(new THREE.Vector3(0, 0, 0));
    // Chased the player to the far end: the next waypoint is the nearest point there, not 3 m on from the old one.
    expect(patrol.next(new THREE.Vector3(25, 0, 20))!.point.x).toBeCloseTo(25, 3);
    expect(new SplinePatrol(() => null).next(new THREE.Vector3())).toBeNull();
  });

  it('feeds a behavior tree Patrol action', () => {
    const tree = { behaviorNodes: [{ id: 'root', type: 'action' as const, action: 'patrol' as const, children: [] }], rootId: 'root' };
    const along = new THREE.Vector3(7, 0, 3);
    const base = {
      position: new THREE.Vector3(), home: new THREE.Vector3(), playerPosition: null, distToPlayer: Infinity, canSee: false, remembers: false,
      lastKnown: null, healthPct: 100, attackRange: 2, patrolRadius: 8, delta: 0.1, time: 0, random: () => 0.5,
      variable: () => undefined, objectPosition: () => null, reachable: (point: THREE.Vector3) => point,
    };
    const effects = {
      attackReady: () => false, startAttack: () => undefined, attacking: () => false, setVariable: () => undefined,
      playAnimation: () => false, canShoot: () => false, holdTrigger: () => undefined,
    };
    const { intent } = tickBehaviorTree(tree as never, createBehaviorMemory(), { ...base, patrolPoint: () => along }, effects);
    expect(intent.state).toBe('PATROL');
    expect(intent.destination.distanceTo(along)).toBeLessThan(1e-6);
  });
});

describe('spline script nodes', () => {
  const services = (extra: Partial<WorldNodeServices>): WorldNodeServices => ({
    spawnPrefab: () => [], playSound: () => undefined, getObject: () => null, setObjectTransform: () => undefined,
    applyImpulse: () => undefined, raycast: () => null, input: { isDown: () => false },
    vars: createLevelVariablesStore(() => {}), print: () => undefined, ...extra,
  });
  const run = (type: WorldNodeType, inputs: Record<string, unknown>, svc: WorldNodeServices) => {
    const definition = WORLD_NODE_DEFINITIONS.find(entry => entry.type === type)!;
    const node: FlowNode = {
      id: 'n', type, data: { ...definition.data },
      inputs: definition.inputs.map((pin, i) => ({ ...pin, id: `in-${i}` })),
      outputs: definition.outputs.map((pin, i) => ({ ...pin, id: `out-${i}` })),
    };
    const nodeState: Record<string, unknown> = {};
    WORLD_NODE_EXECUTORS[type]!(node, {
      evaluate: pin => (pin in inputs ? inputs[pin] : node.data?.[`default_${pin}`] ?? null),
      fire: () => undefined,
      schedule: () => undefined,
      nodeState,
      services: svc,
    });
    return (pin: string) => flowNodeOutputValue(nodeState, pin);
  };
  // A 10 m path along +X from (0, 0, 5), drawn by an object scaled 2x: 20 m in the world.
  const path = liveSplineQuery(live(spline([[0, 0, 0], [10, 0, 0]], {}, 'linear'), [0, 0, 5], 2));
  const withPath = services({ spline: id => (id === 'path' ? path : null) });

  it('measure a spline in metres, and find nothing for an actor without one', () => {
    const out = run('GetSplineLength', { Spline: 'path' }, withPath);
    expect(out('Found')).toBe(true);
    expect(out('Length')).toBeCloseTo(20, 4);
    expect(out('Closed')).toBe(false);
    expect(run('GetSplineLength', { Spline: 'crate' }, withPath)('Found')).toBe(false);
  });

  it('give a point along it and the nearest point to a position', () => {
    const point = run('GetSplinePoint', { Spline: 'path', Distance: 5 }, withPath);
    expect(point('Position X')).toBeCloseTo(5, 6);
    expect(point('Position Y')).toBeCloseTo(0, 6);
    expect(point('Position Z')).toBeCloseTo(5, 6);
    expect(point('Direction X')).toBeCloseTo(1, 6);
    expect(point('Up Y')).toBeCloseTo(1, 6);
    const closest = run('FindClosestOnSpline', { Spline: 'path', 'Position X': 12, 'Position Y': 3, 'Position Z': 9 }, withPath);
    expect(closest('Distance')).toBeCloseTo(12, 3);
    expect(closest('Closest X')).toBeCloseTo(12, 3);
    expect(closest('Closest Z')).toBeCloseTo(5, 6);
  });
});

describe('splines in scripts', () => {
  it('sample and search the points they are sent, in metres', () => {
    const square = createScriptSpline({ closed: true, points: [0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10], ups: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0] });
    expect(square.length).toBeCloseTo(40, 6);
    expect(square.pointAt(15).position).toEqual([10, 0, 5]);
    expect(square.pointAt(15).direction).toEqual([0, 0, 1]);
    expect(square.pointAt(45).position).toEqual([5, 0, 0]);
    expect(square.closest([4, 3, -2])).toEqual({ distance: 4, position: [4, 0, 0] });
    const open = createScriptSpline({ closed: false, points: [0, 0, 0, 10, 0, 0], ups: [0, 1, 0, 0, 1, 0] });
    expect(open.pointAt(99).position).toEqual([10, 0, 0]);
    expect(open.pointAt(-5).position).toEqual([0, 0, 0]);
  });

  it('are sent once, again when they change, and as null once gone', () => {
    const entry = live(spline([[0, 0, 0], [8, 0, 0]], {}, 'linear'));
    const sent = new Map<string, string>();
    let found: LiveSpline | null = entry;
    const first = scriptSplineUpdates(sent, ['path'], () => found)!;
    expect(first.path!.points.slice(0, 3)).toEqual([0, 0, 0]);
    expect(first.path!.points.length / 3).toBe(17);
    expect(scriptSplineUpdates(sent, ['path'], () => found)).toBeUndefined();
    entry.node.position.x = 2;
    expect(scriptSplineUpdates(sent, ['path'], () => found)!.path!.points.slice(0, 3)).toEqual([2, 0, 0]);
    found = null;
    expect(scriptSplineUpdates(sent, ['path'], () => found)).toEqual({ path: null });
  });

  it('reach scripts through ctx.spline, kept between snapshots', () => {
    const base: ScriptSnapshot = {
      frame: 1, time: 0, delta: 0.1, objects: [{ id: 'cart', name: 'Cart', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], parentId: null, visible: true }],
      player: null, input: {}, variables: {}, events: [], raycasts: {}, net: { connected: false, isHost: true, selfId: null, peers: [] },
    };
    const withSpline = { ...base, splines: { track: { closed: false, points: [0, 0, 0, 0, 0, 20], ups: [0, 1, 0, 0, 1, 0] } } };
    expect(isScriptSnapshot(withSpline)).toBe(true);
    expect(isScriptSnapshot({ ...base, splines: { track: { closed: false, points: [0, 0], ups: [] } } })).toBe(false);
    const host = createScriptHost();
    const source = "function onUpdate(ctx) { const track = ctx.spline('track'); ctx.log(track ? track.length + ' ' + track.pointAt(5).position.join(',') : 'none', ctx.spline('cart') === null); }";
    host.load([{ id: 's', objectId: 'cart', source }], code => code, withSpline);
    const logged = (commands: ScriptCommand[]) => commands.flatMap(command => (command.type === 'log' ? [command.message] : []));
    expect(logged(host.frame(withSpline))).toEqual(['20 0,0,5 true']);
    // Not sent again: still known.
    expect(logged(host.frame({ ...base, frame: 2 }))).toEqual(['20 0,0,5 true']);
    expect(logged(host.frame({ ...base, frame: 3, splines: { track: null } }))).toEqual(['none true']);
  });
});
