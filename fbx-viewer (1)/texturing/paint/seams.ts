import * as THREE from 'three';
import type { PartMesh } from '../mesh/partMesh';
import type { GpuImage, TextureGpu } from '../gpu/textureGpu';
import { weldOf } from './decals';
import type { Rect } from './regions';

/**
 * FILTERS ACROSS UV SEAMS
 *
 * Where the mesh runs on across a UV seam, the two sides lie apart on the picture, so a blur at one edge
 * reads the empty gap beyond it and a line shows. Before such a filter, each island's border is extended
 * with what lies across the seam: the neighbouring triangle, unfolded across the shared edge into the gap
 * (a flap), drawn with the picture as it is on the other side. The filter then reads the right texels on
 * both sides, and only the islands' own texels are kept.
 */

/** Flaps of one tile: three corners each, where it is drawn on the tile and where it reads from (UVs in the tile). */
export interface SeamFlaps {
    target: Float32Array;
    source: Float32Array;
    /** Each flap's box on the tile (u0, v0, u1, v1), to tell which flaps a rectangle reaches. */
    boxes: Float32Array;
    count: number;
}

type FlapPart = Pick<PartMesh, 'positions' | 'normals' | 'indices' | 'uvs' | 'triangleTile' | 'triangleShift'>;

const flapCache = new WeakMap<FlapPart, Map<number, SeamFlaps>>();

/**
 * Flaps for every seam edge of `tile`: for each edge two triangles share on the mesh but not on the UV
 * layout (both on this tile), the neighbour unfolded across the edge on each side.
 */
export const seamFlaps = (part: FlapPart, tile: number): SeamFlaps => {
    let byTile = flapCache.get(part);
    if (!byTile) flapCache.set(part, byTile = new Map());
    const cached = byTile.get(tile);
    if (cached) return cached;
    const { indices, uvs, triangleTile, triangleShift } = part;
    const weld = weldOf(part);
    // Edges by their welded ends: the triangles (and which edge of each) on them.
    const edges = new Map<string, Array<{ triangle: number; k: number }>>();
    for (let t = 0; t < indices.length / 3; t++) {
        for (let k = 0; k < 3; k++) {
            const a = weld.ids[indices[t * 3 + k]], b = weld.ids[indices[t * 3 + ((k + 1) % 3)]];
            const key = a < b ? `${a},${b}` : `${b},${a}`;
            const list = edges.get(key);
            if (list) list.push({ triangle: t, k });
            else edges.set(key, [{ triangle: t, k }]);
        }
    }
    const uvOf = (triangle: number, vertex: number): [number, number] => [uvs[vertex * 2] - triangleShift[triangle * 2], uvs[vertex * 2 + 1] - triangleShift[triangle * 2 + 1]];
    const target: number[] = [];
    const source: number[] = [];
    const boxes: number[] = [];
    const same = (p: readonly number[], q: readonly number[]) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;
    for (const list of edges.values()) {
        if (list.length !== 2) continue;
        const [one, two] = list;
        if (triangleTile[one.triangle] !== tile || triangleTile[two.triangle] !== tile) continue;
        const ends = (side: { triangle: number; k: number }) => {
            const v0 = indices[side.triangle * 3 + side.k], v1 = indices[side.triangle * 3 + ((side.k + 1) % 3)], v2 = indices[side.triangle * 3 + ((side.k + 2) % 3)];
            return { w0: weld.ids[v0], uv0: uvOf(side.triangle, v0), uv1: uvOf(side.triangle, v1), uv2: uvOf(side.triangle, v2) };
        };
        const a = ends(one), b = ends(two);
        // The other side's ends in the same order as this side's.
        const bIn = (end: 0 | 1, from: typeof a, to: typeof b) => (from.w0 === to.w0 ? (end === 0 ? to.uv0 : to.uv1) : (end === 0 ? to.uv1 : to.uv0));
        // Joined on the layout too: no seam.
        if (same(a.uv0, bIn(0, a, b)) && same(a.uv1, bIn(1, a, b))) continue;
        for (const [here, there] of [[a, b], [b, a]] as const) {
            const h0 = here.uv0, h1 = here.uv1, h2 = here.uv2;
            const t0 = bIn(0, here, there), t1 = bIn(1, here, there), t2 = there.uv2;
            const eb = [t1[0] - t0[0], t1[1] - t0[1]];
            const lengthB = eb[0] * eb[0] + eb[1] * eb[1];
            const ea = [h1[0] - h0[0], h1[1] - h0[1]];
            if (lengthB < 1e-16 || ea[0] * ea[0] + ea[1] * ea[1] < 1e-16) continue;
            const d = [t2[0] - t0[0], t2[1] - t0[1]];
            const along = (d[0] * eb[0] + d[1] * eb[1]) / lengthB;
            const across = Math.abs(eb[0] * d[1] - eb[1] * d[0]) / lengthB;
            // Out on the far side of the edge from this triangle's own third corner.
            const side = Math.sign(ea[0] * (h2[1] - h0[1]) - ea[1] * (h2[0] - h0[0])) || 1;
            const p = [h0[0] + along * ea[0] + side * across * ea[1], h0[1] + along * ea[1] - side * across * ea[0]];
            target.push(h0[0], h0[1], h1[0], h1[1], p[0], p[1]);
            source.push(t0[0], t0[1], t1[0], t1[1], t2[0], t2[1]);
            boxes.push(Math.min(h0[0], h1[0], p[0]), Math.min(h0[1], h1[1], p[1]), Math.max(h0[0], h1[0], p[0]), Math.max(h0[1], h1[1], p[1]));
        }
    }
    const flaps = { target: Float32Array.from(target), source: Float32Array.from(source), boxes: Float32Array.from(boxes), count: boxes.length / 4 };
    byTile.set(tile, flaps);
    return flaps;
};

/** Whether a rectangle of a tile `size` texels across, grown by `reach`, reaches any flap (a seam's gap). */
export const reachesSeam = (flaps: SeamFlaps, rect: Rect, size: number, reach: number): boolean => {
    const x0 = (rect.x0 - reach) / size, y0 = (rect.y0 - reach) / size, x1 = (rect.x1 + reach) / size, y1 = (rect.y1 + reach) / size;
    for (let i = 0; i < flaps.count; i++) {
        if (flaps.boxes[i * 4] <= x1 && flaps.boxes[i * 4 + 2] >= x0 && flaps.boxes[i * 4 + 1] <= y1 && flaps.boxes[i * 4 + 3] >= y0) return true;
    }
    return false;
};

const FLAP_VERTEX = /* glsl */ `
precision highp float;
in vec2 target;
in vec2 source;
out vec2 vTarget;
out vec2 vSource;
// The image's place on its tile: its first texel (xy) and size (zw), and the tile's size.
uniform vec4 uArea;
uniform float uTile;
void main() {
    vTarget = target;
    vSource = source;
    vec2 at = (target * uTile - uArea.xy) / uArea.zw;
    gl_Position = vec4(at * 2.0 - 1.0, 0.0, 1.0);
}`;

const FLAP_FRAGMENT = /* glsl */ `
precision highp float;
precision highp int;
in vec2 vTarget;
in vec2 vSource;
out vec4 outColor;
uniform sampler2D uImage;
uniform sampler2D uCoverage;
uniform vec4 uArea;
uniform float uTile;
void main() {
    // Only the gaps: the islands keep their own texels.
    if (texture(uCoverage, vTarget).r > 0.5) discard;
    vec2 at = (vSource * uTile - uArea.xy) / uArea.zw;
    if (at.x < 0.0 || at.x > 1.0 || at.y < 0.0 || at.y > 1.0) discard;
    outColor = texture(uImage, at);
}`;

/** Draws a tile's flaps into images of it (or of part of it), reading each from across its seam. */
export class SeamRaster {
    private readonly meshes = new Map<number, THREE.Mesh>();
    private readonly material = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: FLAP_VERTEX,
        fragmentShader: FLAP_FRAGMENT,
        uniforms: { uImage: { value: null }, uCoverage: { value: null }, uArea: { value: new THREE.Vector4() }, uTile: { value: 1 } },
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.NoBlending,
    });
    private readonly scene = new THREE.Scene();
    private readonly camera = new THREE.Camera();

    constructor(private readonly gpu: TextureGpu, private readonly part: FlapPart) {}

    /** Whether the tile has seams to cross. */
    has(tile: number): boolean {
        return seamFlaps(this.part, tile).count > 0;
    }

    private meshOf(tile: number): THREE.Mesh | null {
        let mesh = this.meshes.get(tile);
        if (mesh) return mesh;
        const flaps = seamFlaps(this.part, tile);
        if (!flaps.count) return null;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('target', new THREE.BufferAttribute(flaps.target, 2));
        geometry.setAttribute('source', new THREE.BufferAttribute(flaps.source, 2));
        // Three wants a position to count corners by.
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(flaps.count * 9), 3));
        mesh = new THREE.Mesh(geometry, this.material);
        mesh.frustumCulled = false;
        this.meshes.set(tile, mesh);
        return mesh;
    }

    /**
     * `image` (the texels of `rect` of the tile, `size` across) with its gaps by the tile's seams filled
     * from across them, as a new image; `coverage` marks the islands (the whole tile's). The caller lets
     * go of both.
     */
    extend(image: GpuImage, tile: number, rect: Rect, size: number, coverage: GpuImage): GpuImage {
        const out = this.gpu.image(image.width, image.height, image.kind, image.precision);
        this.gpu.copy(image, out);
        const mesh = this.meshOf(tile);
        if (!mesh) return out;
        const uniforms = this.material.uniforms;
        uniforms.uImage.value = image.target.texture;
        uniforms.uCoverage.value = coverage.target.texture;
        uniforms.uArea.value.set(rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0);
        uniforms.uTile.value = size;
        const renderer = this.gpu.renderer;
        const previous = renderer.getRenderTarget();
        out.target.viewport.set(0, 0, out.width, out.height);
        renderer.setRenderTarget(out.target);
        this.scene.add(mesh);
        renderer.render(this.scene, this.camera);
        this.scene.remove(mesh);
        renderer.setRenderTarget(previous);
        return out;
    }

    dispose(): void {
        for (const mesh of this.meshes.values()) mesh.geometry.dispose();
        this.meshes.clear();
        this.material.dispose();
    }
}
