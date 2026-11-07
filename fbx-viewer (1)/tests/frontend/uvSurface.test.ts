import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildPartMesh } from '../../texturing/mesh/partMesh';
import { SurfacePicker } from '../../texturing/mesh/picker';
import { UvSurfaceLookup, layoutPlaceOf } from '../../texturing/paint/uvSurface';

const partOf = (geometry: THREE.BufferGeometry) => {
    const material = new THREE.MeshStandardMaterial();
    return buildPartMesh(new THREE.Mesh(geometry, material), new Set([material]), { udim: false });
};

describe('the surface under a point of the UV layout', () => {
    it('gives the point, normal, the way U and V run, and model units per UV unit', () => {
        const lookup = new UvSurfaceLookup(partOf(new THREE.PlaneGeometry(2, 2, 3, 3)), 1001);
        const hit = lookup.at(0.25, 0.75)!;
        expect(hit.point.toArray().map((value) => Number(value.toFixed(5)))).toEqual([-0.5, 0.5, 0]);
        expect(hit.normal.toArray()).toEqual([0, 0, 1]);
        expect(hit.alongU.x).toBeCloseTo(2);
        expect(hit.alongV.y).toBeCloseTo(2);
        expect(hit.scale).toBeCloseTo(2);
        expect(lookup.at(1.5, 0.5)).toBeNull();
    });

    it('finds nothing where no island lies, and reads a mirrored island the other way round', () => {
        const geometry = new THREE.PlaneGeometry(1, 1);
        // Only the left half of the tile, flipped left to right.
        const uv = geometry.attributes.uv as THREE.BufferAttribute;
        for (let i = 0; i < uv.count; i++) uv.setX(i, 0.5 - uv.getX(i) * 0.5);
        const lookup = new UvSurfaceLookup(partOf(geometry), 1001);
        expect(lookup.at(0.75, 0.5)).toBeNull();
        const hit = lookup.at(0.25, 0.5)!;
        // U grows to the model's left: the island is mirrored.
        expect(hit.alongU.x).toBeCloseTo(-2);
        expect(new THREE.Vector3().crossVectors(hit.normal, hit.alongU).dot(hit.alongV)).toBeLessThan(0);
        expect(hit.scale).toBeCloseTo(Math.SQRT2);
    });

    it('finds where a point of the model lies on the layout, and back', () => {
        const part = partOf(new THREE.PlaneGeometry(2, 2, 4, 4));
        const place = layoutPlaceOf(part, new SurfacePicker(part), new THREE.Vector3(-0.5, 0.5, 0.01), 0.1)!;
        expect(place.tile).toBe(1001);
        expect(place.u).toBeCloseTo(0.25, 5);
        expect(place.v).toBeCloseTo(0.75, 5);
        const back = new UvSurfaceLookup(part, place.tile).at(place.u, place.v)!;
        expect(back.point.toArray().map((value) => Number(value.toFixed(5)))).toEqual([-0.5, 0.5, 0]);
        expect(layoutPlaceOf(part, new SurfacePicker(part), new THREE.Vector3(0, 0, 3), 0.1)).toBeNull();
    });
});
