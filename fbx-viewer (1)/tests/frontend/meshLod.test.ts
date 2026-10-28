import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { chooseLodLevel, lodPixelsPerUnit, meshLodChain, meshLodReady, MIN_LOD_TRIANGLES, type MeshLodLevel } from '../../utils/meshLod';

beforeAll(async () => { await meshLodReady; });

describe('mesh level of detail chain', () => {
  it('makes coarser levels over the same vertices, each with fewer triangles and more error', () => {
    const sphere = new THREE.SphereGeometry(1, 64, 48);
    const levels = meshLodChain(sphere);
    expect(levels.length).toBeGreaterThan(2);
    expect(levels[0].geometry).toBe(sphere);
    for (let level = 1; level < levels.length; level++) {
      expect(levels[level].triangles).toBeLessThan(levels[level - 1].triangles);
      expect(levels[level].error).toBeGreaterThanOrEqual(levels[level - 1].error);
      // A level is only an index buffer: the vertices (and so skinning) are the full mesh's.
      expect(levels[level].geometry.attributes.position).toBe(sphere.attributes.position);
      expect(levels[level].geometry.attributes.normal).toBe(sphere.attributes.normal);
      expect(levels[level].geometry.boundingSphere?.radius).toBeCloseTo(1, 3);
    }
    // Built once per geometry.
    expect(meshLodChain(sphere)).toBe(levels);
  });

  it('welds a mesh of separate triangles before simplifying it', () => {
    const separate = new THREE.SphereGeometry(1, 48, 32).toNonIndexed();
    const levels = meshLodChain(separate);
    expect(levels.length).toBeGreaterThan(1);
    expect(levels[0].geometry.index).not.toBeNull();
    expect(levels[0].geometry.attributes.position.count).toBeLessThan(separate.attributes.position.count);
  });

  it('keeps each material group whole in every level', () => {
    const sphere = new THREE.SphereGeometry(1, 64, 48);
    const half = Math.floor(sphere.index!.count / 6) * 3;
    sphere.clearGroups();
    sphere.addGroup(0, half, 0);
    sphere.addGroup(half, sphere.index!.count - half, 1);
    const levels = meshLodChain(sphere);
    expect(levels.length).toBeGreaterThan(1);
    for (const { geometry } of levels.slice(1)) {
      expect(geometry.groups.map(group => group.materialIndex)).toEqual([0, 1]);
      expect(geometry.groups[0].start).toBe(0);
      expect(geometry.groups[1].start).toBe(geometry.groups[0].count);
      expect(geometry.groups[0].count + geometry.groups[1].count).toBe(geometry.index!.count);
    }
  });

  it('leaves small meshes with their one level', () => {
    const box = new THREE.BoxGeometry(1, 1, 1, 2, 2, 2);
    expect(box.index!.count / 3).toBeLessThan(MIN_LOD_TRIANGLES);
    expect(meshLodChain(box)).toHaveLength(1);
  });
});

describe('choosing a level', () => {
  const levels = [0, 0.01, 0.05].map((error, index) => ({ geometry: new THREE.BufferGeometry(), error, triangles: 1000 >> index })) as MeshLodLevel[];

  it('takes the coarsest level whose error stays under a pixel at that distance', () => {
    const pixelsPerUnit = 1000;
    expect(chooseLodLevel(levels, 1, 5, pixelsPerUnit)).toBe(0);
    expect(chooseLodLevel(levels, 1, 20, pixelsPerUnit)).toBe(1);
    expect(chooseLodLevel(levels, 1, 100, pixelsPerUnit)).toBe(2);
    // A mesh scaled up shows its error larger, so it keeps detail further out.
    expect(chooseLodLevel(levels, 10, 100, pixelsPerUnit)).toBe(1);
    // Without a perspective camera everything stays at full detail.
    expect(chooseLodLevel(levels, 1, 100, 0)).toBe(0);
  });

  it('measures how many pixels a unit covers from the camera\'s field of view', () => {
    const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
    expect(lodPixelsPerUnit(camera, 1000)).toBeCloseTo(500, 6);
    camera.zoom = 2;
    expect(lodPixelsPerUnit(camera, 1000)).toBeCloseTo(1000, 6);
    expect(lodPixelsPerUnit(new THREE.OrthographicCamera(), 1000)).toBe(0);
  });
});
