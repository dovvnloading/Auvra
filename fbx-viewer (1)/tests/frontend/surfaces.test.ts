import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SURFACES, surfaceFromName, surfaceOfHit, tagSurface, triangleSurfaces } from '../../runtime/surfaces';
import { terrainSurfaceAt, terrainSurfaceTag } from '../../runtime/terrainPhysics';
import { collectHostGeometry, hostSurface } from '../../runtime/components/physicsComponents';
import type { LevelObject } from '../../types';

describe('surfaces', () => {
  it('reads a surface from material and object names', () => {
    expect(surfaceFromName('Asphalt')).toBe('asphalt');
    expect(surfaceFromName('Road_Tarmac_01')).toBe('asphalt');
    expect(surfaceFromName('M_Gravel')).toBe('gravel');
    expect(surfaceFromName('grass-blades')).toBe('grass');
    expect(surfaceFromName('Ice.001')).toBe('ice');
    expect(surfaceFromName('Ground')).toBeNull();
    expect(surfaceFromName('Price')).toBeNull();
    expect(surfaceFromName(undefined)).toBeNull();
  });

  it('grips less and drags more on loose and slippery ground than on a road', () => {
    expect(SURFACES.asphalt.grip).toBe(1);
    for (const kind of ['dirt', 'gravel', 'grass', 'sand', 'mud', 'snow', 'ice'] as const) {
      expect(SURFACES[kind].grip).toBeLessThan(SURFACES.asphalt.grip);
    }
    expect(SURFACES.ice.grip).toBeLessThan(SURFACES.snow.grip);
    expect(SURFACES.sand.rolling).toBeGreaterThan(SURFACES.asphalt.rolling);
  });

  it('maps each triangle of a merged mesh to its material, and says nothing when no name names a surface', () => {
    const tag = triangleSurfaces([{ count: 2, name: 'Asphalt' }, { count: 3, name: 'Ground' }, { count: 1, name: 'Sand' }])!;
    expect(Array.from(tag.triangles!, slot => tag.kinds![slot])).toEqual(['asphalt', 'asphalt', 'default', 'default', 'default', 'sand']);
    expect(triangleSurfaces([{ count: 4, name: 'Ground' }])).toBeNull();
  });

  it('finds the surface under a hit: the triangle, a point, or the whole collider', () => {
    const mesh = { userData: { levelObjectId: 'pg' } };
    tagSurface(mesh, triangleSurfaces([{ count: 1, name: 'Grass' }, { count: 1, name: 'Asphalt' }]));
    expect(mesh.userData.levelObjectId).toBe('pg');
    expect(surfaceOfHit(mesh, 1, 0, 0)).toBe('asphalt');
    // A triangle hit from behind reports its id offset by the triangle count.
    expect(surfaceOfHit(mesh, 2, 0, 0)).toBe('grass');
    const terrain = {};
    tagSurface(terrain, { kind: 'grass', at: x => (x > 0 ? 'dirt' : 'grass') });
    expect(surfaceOfHit(terrain, 7, 5, 0)).toBe('dirt');
    const box = {};
    tagSurface(box, { kind: 'ice' });
    expect(surfaceOfHit(box, undefined, 0, 0)).toBe('ice');
    expect(surfaceOfHit({}, 0, 0, 0)).toBe('default');
    expect(surfaceOfHit(null, 0, 0, 0)).toBe('default');
    tagSurface(box, null);
    expect(surfaceOfHit(box, undefined, 0, 0)).toBe('default');
  });

  it("builds a mesh collider's triangle surfaces from its meshes' materials", () => {
    const host = new THREE.Group();
    const road = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicMaterial({ name: 'Asphalt' }));
    const verge = new THREE.Mesh(new THREE.PlaneGeometry(4, 4, 2, 1), new THREE.MeshBasicMaterial({ name: 'Grass' }));
    host.add(road, verge);
    const geometry = collectHostGeometry(host, 'level')!;
    expect(geometry.indices.length / 3).toBe(6);
    const kinds = Array.from(geometry.surfaces!.triangles!, slot => geometry.surfaces!.kinds![slot]);
    expect(kinds).toEqual(['asphalt', 'asphalt', 'grass', 'grass', 'grass', 'grass']);
    expect(hostSurface(host, 'level')).toBe('asphalt');
  });

  it("reads a terrain's painted layer under a point, its texture naming the surface", () => {
    const resolution = 2;
    const samples = resolution + 1;
    // Layer 0 (grass) everywhere but the +X column, painted with layer 1 (gravel).
    const splat: number[] = [];
    for (let row = 0; row < samples; row++) {
      for (let column = 0; column < samples; column++) splat.push(column === 2 ? 0 : 255, column === 2 ? 255 : 0, 0, 0);
    }
    const terrain = {
      id: 't', name: 'Terrain', type: 'terrain', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
      terrainData: { resolution, width: 10, depth: 10, splat, textureLayers: [{ textureId: 'a', tiling: 1 }, { textureId: 'b', tiling: 1 }] },
    } as unknown as LevelObject;
    const textures = [{ id: 'a', name: 'grass_01.png' }, { id: 'b', name: 'Gravel' }];
    expect(terrainSurfaceAt(terrain, ['grass', 'gravel'], 'default', -4, 0)).toBe('grass');
    expect(terrainSurfaceAt(terrain, ['grass', 'gravel'], 'default', 4.9, 0)).toBe('gravel');
    expect(terrainSurfaceAt(terrain, ['grass', 'gravel'], 'default', 40, 0)).toBe('default');
    const tag = terrainSurfaceTag(terrain, textures);
    expect(tag.at!(4.9, 0)).toBe('gravel');
    expect(tag.at!(-4.9, 0)).toBe('grass');
  });
});
