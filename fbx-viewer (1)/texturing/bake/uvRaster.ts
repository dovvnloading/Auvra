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
in vec3 ids;
in vec4 cage;
out vec3 vPos;
out vec3 vNormal;
out vec2 vUv;
out vec2 vSourceUv;
out vec4 vTangent;
out vec3 vColor;
flat out vec3 vE1;
flat out vec3 vE2;
flat out vec4 vD;
flat out vec3 vIds;
out vec4 vCage;
// A window of the tile (u0, v0, u1, v1) drawn over the whole target, for bakes made in strips; all zero for the whole tile.
uniform vec4 uWindow;
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
    vCage = cage;
    vec2 at = uWindow.z > uWindow.x ? (uv - uWindow.xy) / (uWindow.zw - uWindow.xy) : uv;
    gl_Position = vec4(at * 2.0 - 1.0, 0.0, 1.0);
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
flat in vec3 vIds;
// Bakes: the way a cage ray leaves (xyz) and how far out it starts (w, below 0 for the bake's own distance).
in vec4 vCage;
uniform int uHasTangent;
// Bakes may ask for the frame worked out from texture coordinate slopes even where the mesh has tangents.
uniform int uFrameFromUvs;
// The tangent frame the renderer will use for a normal map on this surface: the mesh's own tangents
// when it has them, else the one worked out from texture coordinate slopes, as the standard shader does.
mat3 surfaceFrame(vec3 n) {
    // A w of 0 marks a mesh of the set that has no tangents of its own.
    if (uFrameFromUvs == 0 && uHasTangent == 1 && abs(vTangent.w) > 0.5) {
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
    /** Draws only this window of each tile (u0, v0, u1, v1) over the whole target: a strip of a large bake. */
    window: [number, number, number, number] | null = null;

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
     * `fragment` (which declares its own uniforms and samplers and writes outColor). With edges, a texel
     * can be drawn more than once (by its triangle and by the lines along its and its neighbours' edges):
     * replacing or keeping the largest value is safe, but adding or laying over would count it twice.
     * With `scissor` (texels, from the bottom left), only that rectangle is cleared and drawn.
     */
    draw(target: GpuImage | THREE.WebGLRenderTarget, tile: number, fragment: string, options: {
        uniforms?: Record<string, unknown>;
        blend?: 'none' | 'max' | 'add' | 'alpha';
        edges?: boolean;
        clear?: [number, number, number, number] | null;
        scissor?: { x0: number; y0: number; x1: number; y1: number };
    } = {}): void {
        const meshes = this.tiles.get(tile);
        const renderTarget = (target as GpuImage).target ?? target as THREE.WebGLRenderTarget;
        const area = options.scissor;
        const limit = () => {
            if (!area) return;
            renderTarget.scissor.set(area.x0, area.y0, area.x1 - area.x0, area.y1 - area.y0);
            renderTarget.scissorTest = true;
        };
        if (options.clear) {
            limit();
            this.gpu.clear(renderTarget, options.clear);
            renderTarget.scissorTest = false;
        }
        if (!meshes) return;
        const material = this.material(fragment, options.blend ?? 'none');
        const kept = material.uniforms;
        const values: Record<string, unknown> = { uSize: new THREE.Vector2(renderTarget.width, renderTarget.height), uHasTangent: this.hasTangents ? 1 : 0, uWindow: new THREE.Vector4(...(this.window ?? [0, 0, 0, 0])), ...(options.uniforms ?? {}) };
        for (const [name, value] of Object.entries(values)) {
            const unwrapped = value && typeof value === 'object' && (value as GpuImage).target ? (value as GpuImage).target.texture : value;
            if (kept[name]) kept[name].value = unwrapped;
            else kept[name] = { value: unwrapped };
        }
        material.uniformsNeedUpdate = true;
        const renderer = this.gpu.renderer;
        const previous = renderer.getRenderTarget();
        renderTarget.viewport.set(0, 0, renderTarget.width, renderTarget.height);
        limit();
        renderer.setRenderTarget(renderTarget);
        meshes.triangles.material = material;
        meshes.edges.material = material;
        this.scene.add(meshes.triangles);
        if (options.edges !== false) this.scene.add(meshes.edges);
        renderer.render(this.scene, this.camera);
        this.scene.remove(meshes.triangles);
        this.scene.remove(meshes.edges);
        renderTarget.scissorTest = false;
        renderer.setRenderTarget(previous);
    }

    /**
     * Gives each vertex a cage ray (four per part vertex: the unit way out and the distance it starts at,
     * below 0 for the bake's own distance), or takes them away (null).
     */
    setCage(values: Float32Array | null): void {
        const part = this.part;
        for (const [tile, meshes] of this.tiles) {
            if (!values) { meshes.geometry.deleteAttribute('cage'); continue; }
            const corners: number[] = [];
            for (let t = 0; t < part.triangleTile.length; t++) {
                if (part.triangleTile[t] !== tile) continue;
                for (let k = 0; k < 3; k++) corners.push(part.indices[t * 3 + k]);
            }
            const data = new Float32Array(corners.length * 4);
            corners.forEach((vertex, i) => data.set(values.subarray(vertex * 4, vertex * 4 + 4), i * 4));
            meshes.geometry.setAttribute('cage', new THREE.BufferAttribute(data, 4));
            // The lines along the edges share the triangles' corners.
            meshes.lines.dispose();
            const lines = edgeGeometry(meshes.geometry);
            meshes.edges.geometry = lines;
            meshes.lines = lines;
        }
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
