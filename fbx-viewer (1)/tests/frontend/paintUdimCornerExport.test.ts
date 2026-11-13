import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { materialGraphForTextures, tileAtlasLayout } from '../../texturing/materialOutput';
import { appliedAtlasLayout, atlasGeometryUvCorners, atlasMaterialUvCorners, markPaintedMaterials, PAINTED_KEY } from '../../texturing/paint/gltfExport';

/**
 * Two triangles share an edge vertex at exactly U=1. The left triangle
 * belongs to tile 1001 (its U=1 corner is the right edge); the right belongs
 * to 1002 (that same source UV becomes its left edge).
 */
const sharedEdgeMesh = (): THREE.BufferGeometry => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
        0, 0, 0,  -1, -1, 0,  -1, 1, 0,  1, -1, 0,  1, 1, 0,
    ], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
        1, 0.5,  0.5, 0.25,  0.6, 0.75,  1.25, 0.25,  1.5, 0.75,
    ], 2));
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([
        1, 0, 0, 0,  1, 0, 0, 0,  1, 0, 0, 0,  2, 0, 0, 0,  2, 0, 0, 0,
    ], 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([
        1, 0, 0, 0,  1, 0, 0, 0,  1, 0, 0, 0,  1, 0, 0, 0,  1, 0, 0, 0,
    ], 4));
    geometry.morphAttributes.position = [new THREE.Float32BufferAttribute([
        0, 0, 0,  0, 0, 0,  0, 0, 0,  0, 0, 0,  0, 0, 0,
    ], 3)];
    geometry.setIndex([0, 1, 2, 0, 3, 4]);
    geometry.addGroup(0, 3, 0);
    geometry.addGroup(3, 3, 1);
    return geometry;
};

const layout = tileAtlasLayout([1001, 1002], 64, 4096);
const stride = layout.cell + 2 * layout.gutter;
const atlasU = (cell: number, localU: number) =>
    (cell * stride + layout.gutter + localU * layout.cell) / layout.width;

describe('whole-model UDIM glTF geometry atlas', () => {
    it('splits shared integer-edge vertices by triangle and preserves skin/morph attributes', () => {
        const source = sharedEdgeMesh();
        const original = Array.from(source.getAttribute('uv').array as ArrayLike<number>);
        const out = atlasGeometryUvCorners(source, layout, () => true);
        const uv = out.getAttribute('uv');

        expect(out).not.toBe(source);
        expect(source.index?.count).toBe(6);
        expect(Array.from(source.getAttribute('uv').array)).toEqual(original);
        expect(out.index).toBeNull();
        expect(uv.count).toBe(6); // One independent UV corner per triangle.
        expect(uv.getX(0)).toBeCloseTo(atlasU(0, 1), 6);
        expect(uv.getX(3)).toBeCloseTo(atlasU(1, 0), 6);
        expect(uv.getX(1)).toBeCloseTo(atlasU(0, 0.5), 6);
        expect(uv.getX(4)).toBeCloseTo(atlasU(1, 0.25), 6);

        // Splitting UV corners must not drop other geometry streams, particularly
        // skin indices/weights and morph targets in exported animated models.
        expect(out.getAttribute('skinIndex').count).toBe(6);
        expect(out.getAttribute('skinWeight').count).toBe(6);
        expect(out.getAttribute('skinIndex').getX(0)).toBe(1);
        expect(out.getAttribute('skinIndex').getX(3)).toBe(1);
        expect(out.morphAttributes.position?.[0].count).toBe(6);
        expect(out.groups.map(g => [g.start, g.count, g.materialIndex])).toEqual([[0, 3, 0], [3, 3, 1]]);
        source.dispose();
        out.dispose();
    });

    it('does not alter UVs in a different, nonpainted material group', () => {
        const source = sharedEdgeMesh();
        const out = atlasGeometryUvCorners(source, layout, (index) => index === 0);
        const uv = out.getAttribute('uv');
        expect(uv.getX(0)).toBeCloseTo(atlasU(0, 1), 6);
        expect(uv.getX(3)).toBe(1);
        expect(uv.getX(4)).toBe(1.25);
        expect(uv.getY(5)).toBe(0.75);
        source.dispose();
        out.dispose();
    });

    it('remaps two painted sets on the same mesh using their independently saved layouts', () => {
        const first = tileAtlasLayout([1001, 1003], 256, 4096);
        const other = tileAtlasLayout([1002, 1011, 1021], 128, 4096);
        const legacy = materialGraphForTextures({ baseColor: 'other-paint' }, { tiles: other });
        const restored = appliedAtlasLayout(undefined, legacy);
        expect(restored).toEqual(other);
        expect(appliedAtlasLayout(first, legacy)).toEqual(first);
        const source = sharedEdgeMesh();
        const body = new THREE.MeshStandardMaterial({ name: 'Body' }), trim = new THREE.MeshStandardMaterial({ name: 'Trim' });
        const copy = new THREE.Mesh(source, [body, trim]);
        const keys = markPaintedMaterials(copy, material => material.name, material => material === body ? first : restored);
        expect([...keys]).toEqual(['Body', 'Trim']);
        expect(copy.material.map(material => material.userData[PAINTED_KEY])).toEqual(['Body', 'Trim']);
        const out = copy.geometry;
        const uv = out.getAttribute('uv');
        expect(uv.getX(0)).toBeCloseTo((first.cell + first.gutter) / first.width, 6);
        expect(uv.getX(3)).toBeCloseTo(other.gutter / other.width, 6);
        expect(uv.getY(3)).toBeCloseTo((other.cell * 0.5 + other.gutter) / other.height, 6);
        expect(source.getAttribute('uv').getX(0)).toBe(1);
        expect(out.getAttribute('skinWeight').count).toBe(6);
        expect(atlasMaterialUvCorners(source, () => null)).toBe(source);
        expect(() => appliedAtlasLayout({ ...first, columns: 0 }, legacy)).toThrow(/invalid/);
        out.dispose();
        source.dispose();
    });

    it('also handles nonindexed geometry and a single material without groups', () => {
        const source = sharedEdgeMesh().toNonIndexed();
        source.clearGroups();
        const out = atlasGeometryUvCorners(source, layout, (index) => index === 0);
        expect(out).not.toBe(source);
        expect(out.getAttribute('uv').getX(0)).toBeCloseTo(atlasU(0, 1), 6);
        expect(out.getAttribute('uv').getX(3)).toBeCloseTo(atlasU(1, 0), 6);
        source.dispose();
        out.dispose();
    });

    it('refuses unsupported/missing tiles and triangles spanning multiple tile interiors', () => {
        const source = sharedEdgeMesh();
        const only1001 = tileAtlasLayout([1001], 64, 4096);
        expect(() => atlasGeometryUvCorners(source, only1001, () => true)).toThrow(/tile 1002/);
        const crossing = sharedEdgeMesh();
        crossing.getAttribute('uv').setX(1, -0.2);
        expect(() => atlasGeometryUvCorners(crossing, layout, () => true)).toThrow(/spans multiple UDIM/);
        source.dispose();
        crossing.dispose();
    });

    it('keeps original geometry with no UV set for caller-side skip handling', () => {
        const withoutUV = new THREE.BufferGeometry();
        withoutUV.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
        expect(atlasGeometryUvCorners(withoutUV, layout, () => true)).toBe(withoutUV);
        withoutUV.dispose();
    });
});
