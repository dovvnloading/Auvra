import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { DEFAULT_BAKE_SETTINGS, prepareRays } from '../../texturing/bake/meshBaker';
import { MeshTracer } from '../../texturing/bake/meshTracer';
import { buildHighPoly, buildPartMesh, buildWholeMesh } from '../../texturing/mesh/partMesh';
import { cornerTable, cornerValueAt } from '../../texturing/mesh/cornerTable';
import { UvRaster } from '../../texturing/bake/uvRaster';
import type { TextureGpu } from '../../texturing/gpu/textureGpu';

/** Two meshes side by side, named as people name low- and high-poly pairs. */
const pair = (suffix: string, detail: number) => {
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group();
    for (const [name, x] of [['Helmet', 0], ['Strap', 5]] as const) {
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2, detail, detail), material);
        mesh.name = `${name}_${suffix}`;
        mesh.position.x = x;
        root.add(mesh);
    }
    return { root, material };
};

describe('ray structures for a bake', () => {
    it('are made once for every strip: a tracer for the whole model and one per high-poly group, let go of together', () => {
        const low = pair('low', 1);
        const high = pair('high', 4);
        const part = buildPartMesh(low.root, new Set([low.material]), { udim: false });
        const sources = { part, occluder: buildWholeMesh(low.root), highPoly: buildHighPoly(high.root) };
        const disposed = vi.spyOn(MeshTracer.prototype, 'dispose');
        const rays = prepareRays(sources, { ...DEFAULT_BAKE_SETTINGS, matchByName: true });
        // Each low-poly mesh traces only its own high-poly mesh, each group with a tracer of its own.
        expect(rays.groups.map((group) => group.lowMesh)).toEqual([0, 1]);
        expect(new Set(rays.groups.map((group) => group.tracer)).size).toBe(2);
        expect(rays.groups.every((group) => group.tracer instanceof MeshTracer && group.tracer !== rays.occluder)).toBe(true);
        // Cage rays: a start and a length for every low-poly vertex.
        expect(rays.cageRays).toHaveLength((part.positions.length / 3) * 4);
        // Nothing is let go of until the bake is over; then all of it at once.
        expect(disposed).not.toHaveBeenCalled();
        rays.dispose();
        expect(disposed).toHaveBeenCalledTimes(3);
        disposed.mockRestore();
    });

    it('trace every high-poly mesh in one group when names do not pair them', () => {
        const low = pair('low', 1);
        const part = buildPartMesh(low.root, new Set([low.material]), { udim: false });
        const single = prepareRays({ part, occluder: buildWholeMesh(low.root), highPoly: buildHighPoly(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), low.material)) }, DEFAULT_BAKE_SETTINGS);
        expect(single.groups).toHaveLength(1);
        expect(single.groups[0].lowMesh).toBe(-1);
        single.dispose();
    });

    it('hand each texel its cage ray by triangle, through the geometry the UV raster draws', () => {
        const low = pair('low', 3);
        const high = pair('high', 4);
        const part = buildPartMesh(low.root, new Set([low.material]), { udim: false });
        const rays = prepareRays({ part, occluder: buildWholeMesh(low.root), highPoly: buildHighPoly(high.root) }, DEFAULT_BAKE_SETTINGS);
        // Averaged normals make cage rays, laid out by triangle for the shaders.
        expect(rays.cageTable).not.toBeNull();
        const table = cornerTable(part, rays.cageRays!);
        expect(Array.from(rays.cageTable!.image.data as Float32Array)).toEqual(Array.from(table.data));
        const raster = new UvRaster({} as TextureGpu, part);
        const tiles = (raster as unknown as { tiles: Map<number, { geometry: THREE.BufferGeometry }> }).tiles;
        for (const { geometry } of tiles.values()) {
            const ids = geometry.getAttribute('ids'), position = geometry.getAttribute('position');
            const edge1 = geometry.getAttribute('edge1'), edge2 = geometry.getAttribute('edge2');
            for (let corner = 0; corner < position.count; corner++) {
                const triangle = Math.round(ids.getZ(corner));
                const value = cornerValueAt(table, triangle, [position.getX(corner), position.getY(corner), position.getZ(corner)], [edge1.getX(corner), edge1.getY(corner), edge1.getZ(corner)], [edge2.getX(corner), edge2.getY(corner), edge2.getZ(corner)]);
                // At a corner, that corner's own ray, as the attribute gave it.
                const vertex = part.indices[triangle * 3 + (corner % 3)];
                for (let i = 0; i < 4; i++) expect(value[i]).toBeCloseTo(rays.cageRays![vertex * 4 + i], 4);
            }
        }
        rays.dispose();
    });
});
