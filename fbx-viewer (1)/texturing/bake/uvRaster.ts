import * as THREE from 'three';
import { GLSL_LIBRARY } from '../gpu/glslLibrary';
import type { GpuImage, TextureGpu } from '../gpu/textureGpu';
import { edgeGeometry, tileGeometry, type PartMesh } from '../mesh/partMesh';

/**
 * DRAWING IN UV SPACE
 *
 * A texture set's triangles drawn at their texture coordinates, one UDIM tile at a time, so a
 * fragment shader runs once for every texel the surface covers and knows the texel's place on the
 * model, its normal and tangent frame. Baking and painting both draw this way. Triangle edges are
 * drawn again as lines so texels a sliver of triangle crosses are covered too.
 */

export const UV_VERTEX = /* glsl */ `
in vec3 position;
in vec3 normal;
in vec2 uv;
in vec2 sourceUv;
in vec3 edge1;
in vec3 edge2;
in vec4 uvEdges;
in vec4 tangent;
in vec3 color;
in vec2 ids;
out vec3 vPos;
out vec3 vNormal;
out vec2 vUv;
out vec2 vSourceUv;
out vec4 vTangent;
out vec3 vColor;
flat out vec3 vE1;
flat out vec3 vE2;
flat out vec4 vD;
flat out vec2 vIds;
void main() {
    vPos = position;
    vNormal = normal;
    vUv = uv;
    vSourceUv = sourceUv;
    vTangent = tangent;
    vColor = color;
    vE1 = edge1;
    vE2 = edge2;
    vD = uvEdges;
    vIds = ids;
    gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Fragment-side declarations every UV-space shader gets. */
export const UV_FRAGMENT_PRELUDE = /* glsl */ `
in vec3 vPos;
in vec3 vNormal;
in vec2 vUv;
// The surface's own texture coordinates (vUv is within the tile being drawn).
in vec2 vSourceUv;
in vec4 vTangent;
in vec3 vColor;
flat in vec3 vE1;
flat in vec3 vE2;
flat in vec4 vD;
flat in vec2 vIds;
uniform int uHasTangent;
// The tangent frame the renderer will use for a normal map on this surface: the mesh's own tangents
// when it has them, else the one worked out from texture coordinate slopes, as the standard shader does.
mat3 surfaceFrame(vec3 n) {
    // A w of 0 marks a mesh of the set that has no tangents of its own.
    if (uHasTangent == 1 && abs(vTangent.w) > 0.5) {
        vec3 along = vTangent.xyz - n * dot(n, vTangent.xyz);
        if (dot(along, along) > 1e-12) {
            vec3 t = normalize(along);
            vec3 b = normalize(cross(n, t) * vTangent.w);
            return mat3(t, b, n);
        }
    }
    vec3 q1perp = cross(vE2, n);
    vec3 q0perp = cross(n, vE1);
    vec3 t = q1perp * vD.x + q0perp * vD.z;
    vec3 b = q1perp * vD.y + q0perp * vD.w;
    float det = max(dot(t, t), dot(b, b));
    float s = det == 0.0 ? 0.0 : inversesqrt(det);
    return mat3(t * s, b * s, n);
}
`;

interface TileMeshes { triangles: THREE.Mesh; edges: THREE.LineSegments; geometry: THREE.BufferGeometry; lines: THREE.BufferGeometry }

/** The GPU geometry of a texture set, per tile, drawn by any UV-space shader. */
export class UvRaster {
    private readonly tiles = new Map<number, TileMeshes>();
    private readonly scene = new THREE.Scene();
    private readonly camera = new THREE.Camera();
    private readonly materials = new Map<string, THREE.RawShaderMaterial>();
    readonly hasTangents: boolean;

    constructor(private readonly gpu: TextureGpu, readonly part: PartMesh) {
        this.hasTangents = Boolean(part.tangents);
        for (const tile of part.tiles) {
            const geometry = tileGeometry(part, tile);
            const lines = edgeGeometry(geometry);
            const triangles = new THREE.Mesh(geometry);
            const edges = new THREE.LineSegments(lines);
            triangles.frustumCulled = edges.frustumCulled = false;
            this.tiles.set(tile, { triangles, edges, geometry, lines });
        }
    }

    private material(fragment: string, blend: 'none' | 'max' | 'add' | 'alpha'): THREE.RawShaderMaterial {
        const key = `${blend}\n${fragment}`;
        let material = this.materials.get(key);
        if (material) return material;
        material = new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: `precision highp float;\n${UV_VERTEX}`,
            fragmentShader: `precision highp float;\nprecision highp int;\nout vec4 outColor;\nuniform vec2 uSize;\n${GLSL_LIBRARY}\n${UV_FRAGMENT_PRELUDE}\n${fragment}`,
            uniforms: {},
            depthTest: false,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
        if (blend === 'max' || blend === 'add') {
            material.blending = THREE.CustomBlending;
            material.blendEquation = blend === 'max' ? THREE.MaxEquation : THREE.AddEquation;
            material.blendSrc = THREE.OneFactor;
            material.blendDst = THREE.OneFactor;
        } else if (blend === 'alpha') {
            material.blending = THREE.CustomBlending;
            material.blendEquation = THREE.AddEquation;
            material.blendSrc = THREE.OneFactor;
            material.blendDst = THREE.OneMinusSrcAlphaFactor;
        } else material.blending = THREE.NoBlending;
        this.materials.set(key, material);
        return material;
    }

    /**
     * Draws tile `tile`'s triangles (and their edges, unless `edges` is false) into `target` with
     * `fragment` (which declares its own uniforms and samplers and writes outColor).
     */
    draw(target: GpuImage | THREE.WebGLRenderTarget, tile: number, fragment: string, options: {
        uniforms?: Record<string, unknown>;
        blend?: 'none' | 'max' | 'add' | 'alpha';
        edges?: boolean;
        clear?: [number, number, number, number] | null;
    } = {}): void {
        const meshes = this.tiles.get(tile);
        const renderTarget = (target as GpuImage).target ?? target as THREE.WebGLRenderTarget;
        if (options.clear) this.gpu.clear(renderTarget, options.clear);
        if (!meshes) return;
        const material = this.material(fragment, options.blend ?? 'none');
        const kept = material.uniforms;
        const values: Record<string, unknown> = { uSize: new THREE.Vector2(renderTarget.width, renderTarget.height), uHasTangent: this.hasTangents ? 1 : 0, ...(options.uniforms ?? {}) };
        for (const [name, value] of Object.entries(values)) {
            const unwrapped = value && typeof value === 'object' && (value as GpuImage).target ? (value as GpuImage).target.texture : value;
            if (kept[name]) kept[name].value = unwrapped;
            else kept[name] = { value: unwrapped };
        }
        material.uniformsNeedUpdate = true;
        const renderer = this.gpu.renderer;
        const previous = renderer.getRenderTarget();
        renderer.setRenderTarget(renderTarget);
        renderTarget.viewport.set(0, 0, renderTarget.width, renderTarget.height);
        meshes.triangles.material = material;
        meshes.edges.material = material;
        this.scene.add(meshes.triangles);
        if (options.edges !== false) this.scene.add(meshes.edges);
        renderer.render(this.scene, this.camera);
        this.scene.remove(meshes.triangles);
        this.scene.remove(meshes.edges);
        renderer.setRenderTarget(previous);
    }

    dispose(): void {
        for (const meshes of this.tiles.values()) {
            meshes.geometry.dispose();
            meshes.lines.dispose();
        }
        for (const material of this.materials.values()) material.dispose();
        this.tiles.clear();
        this.materials.clear();
    }
}
