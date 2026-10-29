import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { LevelObject } from '../../types';
import { createPlacementQuery, raycastPlacement } from '../../utils/surfacePlacement';

const down = (x: number, z: number, height = 50) =>
  new THREE.Raycaster(new THREE.Vector3(x, height, z), new THREE.Vector3(0, -1, 0));

const expectVector = (actual: THREE.Vector3 | undefined, expected: [number, number, number]) => {
  expect(actual).toBeDefined();
  expected.forEach((value, axis) => expect(actual!.getComponent(axis)).toBeCloseTo(value));
};

const levelObject = (overrides: Partial<LevelObject> & Pick<LevelObject, 'id' | 'type'>): LevelObject => ({
  levelId: 'level',
  modelId: '',
  name: overrides.id,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  ...overrides,
});

const boxScene = () => {
  const scene = new THREE.Scene();
  const box = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial());
  box.position.set(0, 1, 0);
  scene.add(box);
  scene.updateMatrixWorld(true);
  return { scene, box };
};

// Mirrors TerrainObject: a group carrying the level transform and a -90 degree
// X-rotated PlaneGeometry whose Z is the sculpted height.
const terrainScene = (terrain: LevelObject) => {
  const { resolution, width, depth, heights = [] } = terrain.terrainData!;
  const group = new THREE.Group();
  group.position.fromArray(terrain.position);
  group.rotation.fromArray(terrain.rotation);
  group.scale.fromArray(terrain.scale);
  group.userData = { levelObjectId: terrain.id, isTerrain: true };
  const geometry = new THREE.PlaneGeometry(width, depth, resolution, resolution);
  const position = geometry.getAttribute('position');
  heights.forEach((height, index) => position.setZ(index, height));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.userData = { levelObjectId: terrain.id, isTerrain: true };
  group.add(mesh);
  const scene = new THREE.Scene();
  scene.add(group);
  scene.updateMatrixWorld(true);
  return { scene, mesh };
};

describe('raycastPlacement', () => {
  it('falls back to the y = 0 ground plane and misses rays pointing away from it', () => {
    const scene = new THREE.Scene();
    const hit = raycastPlacement(down(3, -4), scene, []);
    expectVector(hit?.point, [3, 0, -4]);
    expectVector(hit?.normal, [0, 1, 0]);

    const up = new THREE.Raycaster(new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, 1, 0));
    expect(raycastPlacement(up, scene, [])).toBeNull();
  });

  it('lands on scene meshes with a world-space normal facing the ray', () => {
    const { scene } = boxScene();
    const top = raycastPlacement(down(0.5, 0.25), scene, []);
    expect(top?.point.y).toBeCloseTo(2);
    expect(top?.normal.y).toBeCloseTo(1);

    const side = raycastPlacement(new THREE.Raycaster(new THREE.Vector3(10, 1, 0), new THREE.Vector3(-1, 0, 0)), scene, []);
    expect(side?.point.x).toBeCloseTo(1);
    expectVector(side?.normal, [1, 0, 0]);
  });

  it('passes through ignored objects, helpers and marker level objects', () => {
    const { scene, box } = boxScene();
    expect(raycastPlacement(down(0, 0), scene, [], { ignore: [box] })?.point.y).toBeCloseTo(0);

    box.userData = { levelObjectId: 'spawn' };
    expect(raycastPlacement(down(0, 0), scene, [levelObject({ id: 'spawn', type: 'spawn_point' })])?.point.y).toBeCloseTo(0);
    expect(raycastPlacement(down(0, 0), scene, [levelObject({ id: 'spawn', type: 'prop' })])?.point.y).toBeCloseTo(2);

    box.userData = {};
    box.visible = false;
    expect(raycastPlacement(down(0, 0), scene, [])?.point.y).toBeCloseTo(0);

    box.visible = true;
    box.material = new THREE.ShaderMaterial();
    expect(raycastPlacement(down(0, 0), scene, [])?.point.y).toBeCloseTo(0);

    box.material = new THREE.MeshBasicMaterial();
    box.userData = { ignorePlacement: true };
    expect(raycastPlacement(down(0, 0), scene, [])?.point.y).toBeCloseTo(0);
  });

  it('samples an unrendered terrain heightfield with the editor orientation', () => {
    // 3x3 samples over a 10x10 terrain; row 0 is the -Z edge, column 0 the -X edge.
    const terrain = levelObject({
      id: 'terrain',
      type: 'terrain',
      position: [0, 1, 0],
      terrainData: { resolution: 2, width: 10, depth: 10, heights: [0, 0, 0, 1, 1, 1, 2, 2, 2] },
    });
    const scene = new THREE.Scene();
    expect(raycastPlacement(down(0, -5), scene, [terrain])?.point.y).toBeCloseTo(1);
    expect(raycastPlacement(down(1, 0), scene, [terrain])?.point.y).toBeCloseTo(2);
    expect(raycastPlacement(down(-3, 2.5), scene, [terrain])?.point.y).toBeCloseTo(2.5);
    // Height rises 1 per 5 units of +Z, so the surface tilts back toward -Z.
    const expected = new THREE.Vector3(0, 1, -0.2).normalize();
    expectVector(raycastPlacement(down(0, 1), scene, [terrain])?.normal, [expected.x, expected.y, expected.z]);
    // Off the terrain the ground plane takes over.
    expect(raycastPlacement(down(20, 0), scene, [terrain])?.point.y).toBeCloseTo(0);
  });

  it('matches the rendered terrain triangles, including transformed terrains', () => {
    const heights = [0, 2, 1, 3, -1, 4, 0.5, 2, 1, 0, 3, 1, 2, -2, 1, 0];
    const terrain = levelObject({
      id: 'terrain',
      type: 'terrain',
      position: [2, -1, 3],
      rotation: [0, 0.6, 0],
      scale: [1.5, 1, 1.5],
      terrainData: { resolution: 3, width: 12, depth: 9, heights },
    });
    const { scene, mesh } = terrainScene(terrain);
    // The stored document is stale (flat); the rendered mesh is the truth.
    const stale = { ...terrain, terrainData: { ...terrain.terrainData!, heights: undefined } };
    const query = createPlacementQuery(scene, [stale]);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    for (const [x, z] of [[2, 3], [0.3, 1.7], [6, 5], [-4, 0.5], [4, -1]]) {
      const ray = new THREE.Raycaster(new THREE.Vector3(x, 30, z), new THREE.Vector3(0.05, -1, 0.03).normalize());
      const expected: THREE.Intersection[] = [];
      mesh.raycast(ray, expected);
      expected.sort((a, b) => a.distance - b.distance);
      const hit = query(ray);
      expect(hit).not.toBeNull();
      expect(hit!.point.distanceTo(expected[0].point)).toBeLessThan(1e-4);
      const faceNormal = expected[0].face!.normal.clone().applyMatrix3(normalMatrix).normalize();
      expect(Math.abs(hit!.normal.dot(faceNormal))).toBeCloseTo(1, 4);
      expect(hit!.normal.y).toBeGreaterThan(0);
    }
  });

  it('can find nothing instead of the ground plane, and samples a chunked terrain through its hidden full mesh', () => {
    expect(createPlacementQuery(new THREE.Scene(), [], { groundPlane: false })(down(3, -4))).toBeNull();
    const heights = Array.from({ length: 16 }, (_, i) => (i % 3) - 1);
    const terrain = levelObject({ id: 'terrain', type: 'terrain', terrainData: { resolution: 3, width: 12, depth: 9, heights } });
    const { scene, mesh } = terrainScene(terrain);
    const expected: THREE.Intersection[] = [];
    mesh.raycast(down(1, 1), expected);
    // Drawn in chunks: the full mesh is hidden, but it is still the shape of the ground.
    mesh.visible = false;
    const hit = createPlacementQuery(scene, [], { groundPlane: false })(down(1, 1));
    expect(hit).not.toBeNull();
    expect(hit!.point.distanceTo(expected[0].point)).toBeLessThan(1e-4);
  });

  it('returns the nearest surface when a mesh stands on terrain', () => {
    const terrain = levelObject({ id: 'terrain', type: 'terrain', terrainData: { resolution: 4, width: 20, depth: 20 } });
    const { scene } = boxScene();
    expect(raycastPlacement(down(0, 0), scene, [terrain])?.point.y).toBeCloseTo(2);
    expect(raycastPlacement(down(5, 5), scene, [terrain])?.point.y).toBeCloseTo(0);
    const raised = { ...terrain, position: [0, 3, 0] as [number, number, number] };
    expect(raycastPlacement(down(0, 0), scene, [raised])?.point.y).toBeCloseTo(3);
  });
});
