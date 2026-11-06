import * as THREE from 'three';
import { GLSL_LIBRARY } from '../gpu/glslLibrary';
import type { GpuImage, ImagePrecision, TextureGpu } from '../gpu/textureGpu';
import { jumpFlood } from '../graph/nodes/distance';
import { padImage } from '../bake/meshBaker';
import { tileOf, tileOffset, type PartMesh } from '../mesh/partMesh';

/**
 * CARRYING PICTURES OVER TO A NEW LAYOUT
 *
 * Every triangle is drawn at its new texture coordinates, reading the old picture at its old ones, so
 * the surface looks the same after unwrapping again. A tangent-space normal map is turned into model
 * space with the old layout's frame (the mesh's own tangents when it has them, else the frame the renderer
 * works out from the old coordinates) and back with the new one (a new layout leaves the old tangents
 * behind), so islands that were turned or mirrored keep their lighting. A painted picture keeps its value
 * and coverage apart: its colour is weighted by coverage as it is read, so stroke edges do not darken.
 * The result is padded past its islands.
 */

const VERTEX = `in vec3 position;
in vec3 normal;
in vec4 tangent;
in vec2 oldUv;
in vec3 edge1;
in vec3 edge2;
in vec4 oldEdges;
in vec4 newEdges;
out vec2 vOldUv;
out vec3 vNormal;
out vec4 vTangent;
flat out vec3 vE1;
flat out vec3 vE2;
flat out vec4 vOld;
flat out vec4 vNew;
void main() {
    vOldUv = oldUv;
    vNormal = normal;
    vTangent = tangent;
    vE1 = edge1;
    vE2 = edge2;
    vOld = oldEdges;
    vNew = newEdges;
    gl_Position = vec4(position.xy * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `uniform sampler2D source;
uniform int uMode;
uniform int uSrgb;
uniform int uCoverage;
uniform int uHasTangent;
in vec2 vOldUv;
in vec3 vNormal;
in vec4 vTangent;
flat in vec3 vE1;
flat in vec3 vE2;
flat in vec4 vOld;
flat in vec4 vNew;
out vec4 outColor;
mat3 frameOf(vec3 n, vec4 d) {
    vec3 q1perp = cross(vE2, n);
    vec3 q0perp = cross(n, vE1);
    vec3 t = q1perp * d.x + q0perp * d.z;
    vec3 b = q1perp * d.y + q0perp * d.w;
    float det = max(dot(t, t), dot(b, b));
    float s = det == 0.0 ? 0.0 : inversesqrt(det);
    return mat3(t * s, b * s, n);
}
// The frame normal maps had under the old layout: the mesh's own tangents where it has them (a w of 0
// marks a mesh of the set without), as painting and the renderer used them; else from the coordinates.
mat3 oldFrame(vec3 n) {
    if (uHasTangent == 1 && abs(vTangent.w) > 0.5) {
        vec3 along = vTangent.xyz - n * dot(n, vTangent.xyz);
        if (dot(along, along) > 1e-12) {
            vec3 t = normalize(along);
            return mat3(t, normalize(cross(n, t) * vTangent.w), n);
        }
    }
    return frameOf(n, vOld);
}
// Blended between the four nearest texels with colour weighted by coverage, so see-through texels round a
// stroke add no black (the picture wraps, as it repeats on the model).
vec4 covered(vec2 uv) {
    vec2 at = uv * vec2(textureSize(source, 0)) - 0.5;
    ivec2 i = ivec2(floor(at));
    vec2 f = fract(at);
    vec4 a = texelWrap(source, i);
    vec4 b = texelWrap(source, i + ivec2(1, 0));
    vec4 c = texelWrap(source, i + ivec2(0, 1));
    vec4 d = texelWrap(source, i + ivec2(1, 1));
    vec4 s = mix(mix(vec4(a.rgb * a.a, a.a), vec4(b.rgb * b.a, b.a), f.x), mix(vec4(c.rgb * c.a, c.a), vec4(d.rgb * d.a, d.a), f.x), f.y);
    return s.a > 1e-5 ? vec4(s.rgb / s.a, s.a) : vec4(0.0);
}
void main() {
    vec4 c = uCoverage == 1 ? covered(vOldUv) : texture(source, vOldUv);
    if (uSrgb == 1) c.rgb = linearToSrgb(c.rgb);
    if (uMode == 1) {
        vec3 n = normalize(vNormal);
        vec2 xy = c.xy * 2.0 - 1.0;
        vec3 t = vec3(xy, sqrt(saturate(1.0 - dot(xy, xy))));
        vec3 world = normalize(oldFrame(n) * t);
        vec3 back = normalize(inverse(frameOf(n, vNew)) * world);
        // A painted picture's coverage stays as it was.
        c = vec4(back * 0.5 + 0.5, c.a);
    }
    outColor = c;
}`;

/** The UDIM tile each triangle of a new layout lands in (by its middle). */
export const newTriangleTiles = (cornerUv: Float32Array | Float64Array): Uint16Array => {
    const tiles = new Uint16Array(cornerUv.length / 6);
    for (let t = 0; t < tiles.length; t++) {
        const u = (cornerUv[t * 6] + cornerUv[t * 6 + 2] + cornerUv[t * 6 + 4]) / 3;
        const v = (cornerUv[t * 6 + 1] + cornerUv[t * 6 + 3] + cornerUv[t * 6 + 5]) / 3;
        tiles[t] = tileOf(u, v);
    }
    return tiles;
};

export interface TransferOptions {
    /** Re-frames tangent normals. */
    normalMap?: boolean;
    /** Only the triangles landing in this tile of the new layout, at their place in it. */
    tile?: number;
    /** The result's: 8 bits, or 16 for half-float pictures such as painted height. */
    precision?: ImagePrecision;
    /** A painted picture (value in colour, coverage in alpha): colour is weighted by coverage as it is read. */
    coverage?: boolean;
}

/**
 * Draws pictures laid out by the part's current coordinates onto a new picture laid out by `cornerUv`
 * (two per corner, triangle order). `source` is one picture, or the picture of each of the part's current
 * tiles (UDIM). With `options.tile`, only the triangles landing in that tile of the new layout are drawn,
 * at their place in it; without, every triangle is drawn within 0..1.
 */
export const transferPicture = async (
    gpu: TextureGpu,
    part: PartMesh,
    cornerUv: Float32Array | Float64Array,
    source: THREE.Texture | GpuImage | ((tile: number) => THREE.Texture | GpuImage | null),
    size: number,
    options: TransferOptions = {},
): Promise<GpuImage> => {
    const { normalMap = false, tile, precision = 8, coverage: weighted = false } = options;
    const sourceOf = typeof source === 'function' ? source : () => source;
    const landing = tile === undefined ? null : newTriangleTiles(cornerUv);
    // Drawn a current tile at a time: each reads that tile's picture.
    const groups = new Map<number, number[]>();
    for (let t = 0; t < part.indices.length / 3; t++) {
        if (landing && landing[t] !== tile) continue;
        const from = part.triangleTile[t];
        let list = groups.get(from);
        if (!list) groups.set(from, list = []);
        list.push(t);
    }
    const [tileU, tileV] = tile === undefined ? [0, 0] : tileOffset(tile);
    const material = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: `precision highp float;\n${VERTEX}`,
        fragmentShader: `precision highp float;\nprecision highp int;\n${GLSL_LIBRARY}\n${FRAGMENT}`,
        uniforms: { source: { value: null }, uMode: { value: normalMap ? 1 : 0 }, uSrgb: { value: 0 }, uCoverage: { value: weighted ? 1 : 0 }, uHasTangent: { value: part.tangents ? 1 : 0 } },
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
    });
    const covering = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: 'precision highp float;\nin vec3 position;\nvoid main() { gl_Position = vec4(position.xy * 2.0 - 1.0, 0.0, 1.0); }',
        fragmentShader: 'precision highp float;\nout vec4 outColor;\nvoid main() { outColor = vec4(1.0); }',
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
    });
    const drawn = gpu.image(size, size, 'color', precision);
    const coverage = gpu.image(size, size, 'gray', 8);
    gpu.clear(drawn, [0, 0, 0, 0]);
    // Where the surface is, drawn on its own: a painted layer's clear texels are still surface.
    gpu.clear(coverage, [0, 0, 0, 1]);
    const renderer = gpu.renderer;
    const previous = renderer.getRenderTarget();
    for (const [from, list] of groups) {
        const picture = sourceOf(from);
        if (!picture) continue;
        const count = list.length * 3;
        const position = new Float32Array(count * 3);
        const normal = new Float32Array(count * 3);
        const tangent = new Float32Array(count * 4);
        const oldUv = new Float32Array(count * 2);
        const edge1 = new Float32Array(count * 3);
        const edge2 = new Float32Array(count * 3);
        const oldEdges = new Float32Array(count * 4);
        const newEdges = new Float32Array(count * 4);
        list.forEach((t, index) => {
            const [a, b, c] = [part.indices[t * 3], part.indices[t * 3 + 1], part.indices[t * 3 + 2]];
            const e1 = [0, 1, 2].map((axis) => part.positions[b * 3 + axis] - part.positions[a * 3 + axis]);
            const e2 = [0, 1, 2].map((axis) => part.positions[c * 3 + axis] - part.positions[a * 3 + axis]);
            const od = [part.uvs[b * 2] - part.uvs[a * 2], part.uvs[b * 2 + 1] - part.uvs[a * 2 + 1], part.uvs[c * 2] - part.uvs[a * 2], part.uvs[c * 2 + 1] - part.uvs[a * 2 + 1]];
            const nu = (k: number) => [cornerUv[(t * 3 + k) * 2], cornerUv[(t * 3 + k) * 2 + 1]];
            const n0 = nu(0), n1 = nu(1), n2 = nu(2);
            const nd = [n1[0] - n0[0], n1[1] - n0[1], n2[0] - n0[0], n2[1] - n0[1]];
            // Into the picture: by the tile asked for, or by the tile the triangle starts in.
            const shiftU = tile === undefined ? Math.floor(n0[0]) : tileU;
            const shiftV = tile === undefined ? Math.floor(n0[1]) : tileV;
            [a, b, c].forEach((vertex, k) => {
                const at = index * 3 + k;
                const uv = nu(k);
                position.set([uv[0] - shiftU, uv[1] - shiftV, 0], at * 3);
                normal.set(part.normals.subarray(vertex * 3, vertex * 3 + 3), at * 3);
                if (part.tangents) tangent.set(part.tangents.subarray(vertex * 4, vertex * 4 + 4), at * 4);
                // Read within the current tile's own picture.
                oldUv.set([part.uvs[vertex * 2] - part.triangleShift[t * 2], part.uvs[vertex * 2 + 1] - part.triangleShift[t * 2 + 1]], at * 2);
                edge1.set(e1, at * 3);
                edge2.set(e2, at * 3);
                oldEdges.set(od, at * 4);
                newEdges.set(nd, at * 4);
            });
        });
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
        geometry.setAttribute('tangent', new THREE.BufferAttribute(tangent, 4));
        geometry.setAttribute('oldUv', new THREE.BufferAttribute(oldUv, 2));
        geometry.setAttribute('edge1', new THREE.BufferAttribute(edge1, 3));
        geometry.setAttribute('edge2', new THREE.BufferAttribute(edge2, 3));
        geometry.setAttribute('oldEdges', new THREE.BufferAttribute(oldEdges, 4));
        geometry.setAttribute('newEdges', new THREE.BufferAttribute(newEdges, 4));
        const texture = (picture as GpuImage).target ? (picture as GpuImage).target.texture : picture as THREE.Texture;
        material.uniforms.source.value = texture;
        material.uniforms.uSrgb.value = texture.colorSpace === THREE.SRGBColorSpace ? 1 : 0;
        material.uniformsNeedUpdate = true;
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        const scene = new THREE.Scene();
        scene.add(mesh);
        renderer.setRenderTarget(drawn.target);
        renderer.render(scene, new THREE.Camera());
        mesh.material = covering;
        renderer.setRenderTarget(coverage.target);
        renderer.render(scene, new THREE.Camera());
        renderer.setRenderTarget(previous);
        geometry.dispose();
    }
    covering.dispose();
    material.dispose();
    const nearest = await jumpFlood(gpu, coverage, size, size, 'm.r >= 0.5');
    const padded = padImage(gpu, drawn, coverage, nearest);
    gpu.release(drawn);
    gpu.release(coverage);
    gpu.release(nearest);
    return padded;
};
