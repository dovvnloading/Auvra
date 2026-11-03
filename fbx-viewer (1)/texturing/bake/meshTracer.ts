import * as THREE from 'three';
import { BOUNDS_FLOATS, NODE_FLOATS, buildBvh } from '../../runtime/raytracing/bvh';

/**
 * RAYS AGAINST ONE MESH
 *
 * A bounding volume tree over a mesh's triangles, packed into two float textures a fragment shader
 * walks: the nodes (two texels each: lowest corner and left child or first triangle; highest corner
 * and triangle count), and the triangles in the tree's leaf order (six texels each: three corners
 * and three normals). `TRACE_MESH_GLSL` finds the nearest hit along a ray and where on the triangle.
 */

const WIDTH = 2048;
const SHIFT = 11;

export const TRACE_MESH_GLSL = /* glsl */ `
uniform highp sampler2D tTris;
uniform highp sampler2D tNodes;
ivec2 trTexel(int i) { return ivec2(i & ${WIDTH - 1}, i >> ${SHIFT}); }
float trBox(vec3 lo, vec3 hi, vec3 o, vec3 inv, float limit) {
    vec3 a = (lo - o) * inv;
    vec3 b = (hi - o) * inv;
    vec3 near = min(a, b);
    vec3 far = max(a, b);
    float enter = max(max(near.x, near.y), max(near.z, 0.0));
    float leave = min(min(far.x, far.y), min(far.z, limit));
    return enter <= leave ? enter : -1.0;
}
struct TraceHit { float t; int tri; vec2 bary; };
bool traceMesh(vec3 o, vec3 d, float tMin, float tMax, out TraceHit hit) {
    hit.t = tMax;
    hit.tri = -1;
    hit.bary = vec2(0.0);
    vec3 inv = 1.0 / (d + vec3(equal(d, vec3(0.0))) * 1e-9);
    vec4 rootLo = texelFetch(tNodes, trTexel(0), 0);
    vec4 rootHi = texelFetch(tNodes, trTexel(1), 0);
    if (trBox(rootLo.xyz, rootHi.xyz, o, inv, tMax) < 0.0) return false;
    int stack[40];
    int top = 0;
    int node = 0;
    for (int steps = 0; steps < 4096; steps++) {
        vec4 lo = texelFetch(tNodes, trTexel(node * 2), 0);
        vec4 hi = texelFetch(tNodes, trTexel(node * 2 + 1), 0);
        int count = int(hi.w);
        if (count != 0) {
            int first = int(lo.w);
            for (int k = 0; k < 8; k++) {
                if (k >= count) break;
                int t = first + k;
                vec3 a = texelFetch(tTris, trTexel(t * 6), 0).xyz;
                vec3 b = texelFetch(tTris, trTexel(t * 6 + 1), 0).xyz;
                vec3 c = texelFetch(tTris, trTexel(t * 6 + 2), 0).xyz;
                vec3 e1 = b - a;
                vec3 e2 = c - a;
                vec3 p = cross(d, e2);
                float det = dot(e1, p);
                if (abs(det) < 1e-14) continue;
                float invDet = 1.0 / det;
                vec3 s = o - a;
                float u = dot(s, p) * invDet;
                if (u < 0.0 || u > 1.0) continue;
                vec3 q = cross(s, e1);
                float v = dot(d, q) * invDet;
                if (v < 0.0 || u + v > 1.0) continue;
                float tt = dot(e2, q) * invDet;
                if (tt > tMin && tt < hit.t) { hit.t = tt; hit.tri = t; hit.bary = vec2(u, v); }
            }
            if (top == 0) break;
            node = stack[--top];
            continue;
        }
        int left = int(lo.w);
        int right = left + 1;
        float dl = trBox(texelFetch(tNodes, trTexel(left * 2), 0).xyz, texelFetch(tNodes, trTexel(left * 2 + 1), 0).xyz, o, inv, hit.t);
        float dr = trBox(texelFetch(tNodes, trTexel(right * 2), 0).xyz, texelFetch(tNodes, trTexel(right * 2 + 1), 0).xyz, o, inv, hit.t);
        if (dl < 0.0 && dr < 0.0) {
            if (top == 0) break;
            node = stack[--top];
        } else if (dl < 0.0) node = right;
        else if (dr < 0.0) node = left;
        else if (dl <= dr) { node = left; if (top < 40) stack[top++] = right; }
        else { node = right; if (top < 40) stack[top++] = left; }
    }
    return hit.tri >= 0;
}
vec3 hitNormal(TraceHit h) {
    vec3 n0 = texelFetch(tTris, trTexel(h.tri * 6 + 3), 0).xyz;
    vec3 n1 = texelFetch(tTris, trTexel(h.tri * 6 + 4), 0).xyz;
    vec3 n2 = texelFetch(tTris, trTexel(h.tri * 6 + 5), 0).xyz;
    return normalize(n0 * (1.0 - h.bary.x - h.bary.y) + n1 * h.bary.x + n2 * h.bary.y);
}
`;

const floatTexture = (data: Float32Array, texels: number): THREE.DataTexture => {
    const rows = Math.max(1, Math.ceil(texels / WIDTH));
    const padded = new Float32Array(WIDTH * rows * 4);
    padded.set(data);
    const texture = new THREE.DataTexture(padded, WIDTH, rows, THREE.RGBAFormat, THREE.FloatType);
    texture.minFilter = texture.magFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    return texture;
};

export class MeshTracer {
    readonly triangles: THREE.DataTexture;
    readonly nodes: THREE.DataTexture;
    readonly triangleCount: number;

    constructor(positions: Float32Array, normals: Float32Array, indices: Uint32Array) {
        const count = indices.length / 3;
        this.triangleCount = count;
        const bounds = new Float32Array(count * BOUNDS_FLOATS);
        for (let t = 0; t < count; t++) {
            let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
            for (let k = 0; k < 3; k++) {
                const v = indices[t * 3 + k] * 3;
                minX = Math.min(minX, positions[v]); maxX = Math.max(maxX, positions[v]);
                minY = Math.min(minY, positions[v + 1]); maxY = Math.max(maxY, positions[v + 1]);
                minZ = Math.min(minZ, positions[v + 2]); maxZ = Math.max(maxZ, positions[v + 2]);
            }
            bounds.set([minX, minY, minZ, maxX, maxY, maxZ], t * BOUNDS_FLOATS);
        }
        const bvh = buildBvh(bounds, count);
        const triangleData = new Float32Array(count * 6 * 4);
        for (let k = 0; k < count; k++) {
            const t = bvh.order[k];
            for (let corner = 0; corner < 3; corner++) {
                const v = indices[t * 3 + corner] * 3;
                triangleData.set([positions[v], positions[v + 1], positions[v + 2], 0], (k * 6 + corner) * 4);
                triangleData.set([normals[v], normals[v + 1], normals[v + 2], 0], (k * 6 + 3 + corner) * 4);
            }
        }
        const nodeData = new Float32Array(bvh.nodeCount * 2 * 4);
        for (let n = 0; n < bvh.nodeCount; n++) {
            const o = n * NODE_FLOATS;
            nodeData.set([bvh.nodes[o], bvh.nodes[o + 1], bvh.nodes[o + 2], bvh.nodes[o + 3]], n * 8);
            nodeData.set([bvh.nodes[o + 4], bvh.nodes[o + 5], bvh.nodes[o + 6], bvh.nodes[o + 7]], n * 8 + 4);
        }
        this.triangles = floatTexture(triangleData, count * 6);
        this.nodes = floatTexture(nodeData, bvh.nodeCount * 2);
    }

    get inputs(): { tTris: THREE.Texture; tNodes: THREE.Texture } {
        return { tTris: this.triangles, tNodes: this.nodes };
    }

    dispose(): void {
        this.triangles.dispose();
        this.nodes.dispose();
    }
}
