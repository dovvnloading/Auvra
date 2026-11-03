import * as THREE from 'three';
import { GLSL_LIBRARY } from '../gpu/glslLibrary';
import type { GpuImage, TextureGpu } from '../gpu/textureGpu';
import { jumpFlood } from '../graph/nodes/distance';
import { padImage } from '../bake/meshBaker';
import type { PartMesh } from '../mesh/partMesh';

/**
 * CARRYING PICTURES OVER TO A NEW LAYOUT
 *
 * Every triangle is drawn at its new texture coordinates, reading the old picture at its old ones, so
 * the surface looks the same after unwrapping again. A tangent-space normal map is turned into model
 * space with the old layout's frame (as the renderer worked it out from the old coordinates) and back
 * with the new one, so islands that were turned or mirrored keep their lighting. The result is padded
 * past its islands.
 */

const VERTEX = `in vec3 position;
in vec3 normal;
in vec2 oldUv;
in vec3 edge1;
in vec3 edge2;
in vec4 oldEdges;
in vec4 newEdges;
out vec2 vOldUv;
out vec3 vNormal;
flat out vec3 vE1;
flat out vec3 vE2;
flat out vec4 vOld;
flat out vec4 vNew;
void main() {
    vOldUv = oldUv;
    vNormal = normal;
    vE1 = edge1;
    vE2 = edge2;
    vOld = oldEdges;
    vNew = newEdges;
    gl_Position = vec4(position.xy * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `uniform sampler2D source;
uniform int uMode;
uniform int uSrgb;
in vec2 vOldUv;
in vec3 vNormal;
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
void main() {
    vec4 c = texture(source, vOldUv);
    if (uSrgb == 1) c.rgb = linearToSrgb(c.rgb);
    if (uMode == 1) {
        vec3 n = normalize(vNormal);
        vec2 xy = c.xy * 2.0 - 1.0;
        vec3 t = vec3(xy, sqrt(saturate(1.0 - dot(xy, xy))));
        vec3 world = normalize(frameOf(n, vOld) * t);
        vec3 back = normalize(inverse(frameOf(n, vNew)) * world);
        c = vec4(back * 0.5 + 0.5, 1.0);
    }
    outColor = c;
}`;

/**
 * Draws `source` (laid out by the part's current coordinates) onto a new picture laid out by
 * `cornerUv` (two per corner, triangle order, within 0..1). `normalMap` re-frames tangent normals.
 */
export const transferPicture = async (gpu: TextureGpu, part: PartMesh, cornerUv: Float32Array | Float64Array, source: THREE.Texture | GpuImage, size: number, normalMap = false): Promise<GpuImage> => {
    const triangles = part.indices.length / 3;
    const count = triangles * 3;
    const position = new Float32Array(count * 3);
    const normal = new Float32Array(count * 3);
    const oldUv = new Float32Array(count * 2);
    const edge1 = new Float32Array(count * 3);
    const edge2 = new Float32Array(count * 3);
    const oldEdges = new Float32Array(count * 4);
    const newEdges = new Float32Array(count * 4);
    for (let t = 0; t < triangles; t++) {
        const [a, b, c] = [part.indices[t * 3], part.indices[t * 3 + 1], part.indices[t * 3 + 2]];
        const e1 = [0, 1, 2].map((axis) => part.positions[b * 3 + axis] - part.positions[a * 3 + axis]);
        const e2 = [0, 1, 2].map((axis) => part.positions[c * 3 + axis] - part.positions[a * 3 + axis]);
        const od = [part.uvs[b * 2] - part.uvs[a * 2], part.uvs[b * 2 + 1] - part.uvs[a * 2 + 1], part.uvs[c * 2] - part.uvs[a * 2], part.uvs[c * 2 + 1] - part.uvs[a * 2 + 1]];
        const nu = (k: number) => [cornerUv[(t * 3 + k) * 2], cornerUv[(t * 3 + k) * 2 + 1]];
        const n0 = nu(0), n1 = nu(1), n2 = nu(2);
        const nd = [n1[0] - n0[0], n1[1] - n0[1], n2[0] - n0[0], n2[1] - n0[1]];
        [a, b, c].forEach((vertex, k) => {
            const at = t * 3 + k;
            const uv = nu(k);
            position.set([uv[0] - Math.floor(n0[0]), uv[1] - Math.floor(n0[1]), 0], at * 3);
            normal.set(part.normals.subarray(vertex * 3, vertex * 3 + 3), at * 3);
            oldUv.set([part.uvs[vertex * 2], part.uvs[vertex * 2 + 1]], at * 2);
            edge1.set(e1, at * 3);
            edge2.set(e2, at * 3);
            oldEdges.set(od, at * 4);
            newEdges.set(nd, at * 4);
        });
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geometry.setAttribute('oldUv', new THREE.BufferAttribute(oldUv, 2));
    geometry.setAttribute('edge1', new THREE.BufferAttribute(edge1, 3));
    geometry.setAttribute('edge2', new THREE.BufferAttribute(edge2, 3));
    geometry.setAttribute('oldEdges', new THREE.BufferAttribute(oldEdges, 4));
    geometry.setAttribute('newEdges', new THREE.BufferAttribute(newEdges, 4));
    const texture = (source as GpuImage).target ? (source as GpuImage).target.texture : source as THREE.Texture;
    const material = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: `precision highp float;\n${VERTEX}`,
        fragmentShader: `precision highp float;\nprecision highp int;\n${GLSL_LIBRARY}\n${FRAGMENT}`,
        uniforms: { source: { value: texture }, uMode: { value: normalMap ? 1 : 0 }, uSrgb: { value: texture.colorSpace === THREE.SRGBColorSpace ? 1 : 0 } },
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    const drawn = gpu.image(size, size, 'color', 8);
    const coverage = gpu.image(size, size, 'gray', 8);
    gpu.clear(drawn, [0, 0, 0, 0]);
    const renderer = gpu.renderer;
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(drawn.target);
    renderer.render(scene, new THREE.Camera());
    renderer.setRenderTarget(previous);
    // Where the surface is, drawn on its own: a painted layer's clear texels are still surface.
    gpu.clear(coverage, [0, 0, 0, 1]);
    const covering = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: 'precision highp float;\nin vec3 position;\nvoid main() { gl_Position = vec4(position.xy * 2.0 - 1.0, 0.0, 1.0); }',
        fragmentShader: 'precision highp float;\nout vec4 outColor;\nvoid main() { outColor = vec4(1.0); }',
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
    });
    mesh.material = covering;
    renderer.setRenderTarget(coverage.target);
    renderer.render(scene, new THREE.Camera());
    renderer.setRenderTarget(previous);
    covering.dispose();
    const nearest = await jumpFlood(gpu, coverage, size, size, 'm.r >= 0.5');
    const padded = padImage(gpu, drawn, coverage, nearest);
    gpu.release(drawn);
    gpu.release(coverage);
    gpu.release(nearest);
    geometry.dispose();
    material.dispose();
    return padded;
};
