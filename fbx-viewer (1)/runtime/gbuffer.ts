import * as THREE from 'three';

/**
 * SURFACE BUFFER
 *
 * What screen-space lighting needs to know about each pixel's surface, drawn in one extra pass over the
 * scene into two targets at once, with a depth texture of its own:
 *  - normal and roughness: the view-space normal (xyz) and the material's roughness (w);
 *  - albedo and metalness: the material's base colour, with its colour map and vertex or instance
 *    colours (rgb), and its metalness (a).
 * Each lit material draws with a small twin that copies those values every frame. Unlit, transparent and
 * non-mesh objects (sky, water, particles, lines, sprites) stay out: their pixels read as open sky.
 */

const GBUFFER_VERTEX = /* glsl */ `
#include <common>
#include <batching_pars_vertex>
#include <color_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
uniform mat3 mapTransform;
out vec3 vViewNormal;
out vec2 vSurfaceUv;
#ifdef SURFACE_ALPHA_MAP
uniform mat3 alphaMapTransform;
out vec2 vAlphaUv;
#endif
void main() {
    vSurfaceUv = ( mapTransform * vec3( uv, 1.0 ) ).xy;
    #ifdef SURFACE_ALPHA_MAP
    vAlphaUv = ( alphaMapTransform * vec3( uv, 1.0 ) ).xy;
    #endif
    #include <color_vertex>
    #include <batching_vertex>
    #include <beginnormal_vertex>
    #include <morphinstance_vertex>
    #include <morphnormal_vertex>
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    #include <defaultnormal_vertex>
    vViewNormal = normalize( transformedNormal );
    #include <begin_vertex>
    #include <morphtarget_vertex>
    #include <skinning_vertex>
    #include <project_vertex>
}`;

const GBUFFER_FRAGMENT = /* glsl */ `
#include <color_pars_fragment>
layout( location = 0 ) out vec4 gNormalRoughness;
layout( location = 1 ) out vec4 gAlbedoMetalness;
uniform vec3 diffuse;
uniform float roughness;
uniform float metalness;
uniform float alphaTest;
#ifdef SURFACE_MAP
uniform sampler2D map;
#endif
#ifdef SURFACE_ALPHA_MAP
uniform sampler2D alphaMap;
in vec2 vAlphaUv;
#endif
in vec3 vViewNormal;
in vec2 vSurfaceUv;
void main() {
    vec4 albedo = vec4( diffuse, 1.0 );
    #ifdef SURFACE_MAP
    albedo *= texture( map, vSurfaceUv );
    #endif
    #ifdef SURFACE_ALPHA_MAP
    albedo.a *= texture( alphaMap, vAlphaUv ).g;
    #endif
    #ifdef SURFACE_ALPHA_TEST
    if ( albedo.a < alphaTest ) discard;
    #endif
    #if defined( USE_COLOR_ALPHA )
    albedo *= vColor;
    #elif defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR ) || defined( USE_BATCHING_COLOR )
    albedo.rgb *= vColor;
    #endif
    vec3 normal = normalize( vViewNormal ) * ( gl_FrontFacing ? 1.0 : -1.0 );
    gNormalRoughness = vec4( normal, roughness );
    gAlbedoMetalness = vec4( albedo.rgb, metalness );
}`;

type LitMaterial = THREE.MeshStandardMaterial | THREE.MeshPhongMaterial | THREE.MeshLambertMaterial;

const isLit = (material: THREE.Material): material is LitMaterial =>
    (material as THREE.MeshStandardMaterial).isMeshStandardMaterial === true
    || (material as THREE.MeshPhongMaterial).isMeshPhongMaterial === true
    || (material as THREE.MeshLambertMaterial).isMeshLambertMaterial === true
    || (material as THREE.MeshToonMaterial).isMeshToonMaterial === true;

/** Whether a material belongs in the surface buffer: lit, opaque (or alpha-tested) and drawn into depth. */
export const drawsSurface = (material: THREE.Material): boolean =>
    isLit(material) && material.visible && !material.transparent && material.depthWrite && material.colorWrite;

/** Roughness and metalness as the screen sees them: Phong's shininess maps onto roughness, Lambert is matte. */
export const surfaceOf = (material: LitMaterial): { roughness: number; metalness: number } => {
    const standard = material as THREE.MeshStandardMaterial;
    if (standard.isMeshStandardMaterial) return { roughness: standard.roughness, metalness: standard.metalness };
    const phong = material as THREE.MeshPhongMaterial;
    if (phong.isMeshPhongMaterial) return { roughness: Math.sqrt(2 / (phong.shininess + 2)), metalness: 0 };
    return { roughness: 1, metalness: 0 };
};

const twins = new WeakMap<THREE.Material, THREE.ShaderMaterial>();

/** A twin goes with its material: nothing else can reach it to free it. */
const freeTwin = (event: { target: THREE.Material }) => {
    twins.get(event.target)?.dispose();
    twins.delete(event.target);
};

/** Cut out by an alpha map as well as (or instead of) the colour map's alpha, as three.js reads it (green). */
const cutByAlphaMap = (material: LitMaterial) => material.alphaTest > 0 && !!material.alphaMap;

const twinKey = (material: LitMaterial) =>
    `${material.map ? 'm' : ''}${material.alphaTest > 0 ? 'a' : ''}${cutByAlphaMap(material) ? 'p' : ''}${material.vertexColors ? 'c' : ''}`;

/** The surface-buffer twin of a lit material, made once and refreshed each frame. */
export const surfaceTwin = (material: LitMaterial): THREE.ShaderMaterial => {
    const key = twinKey(material);
    let twin = twins.get(material);
    if (!twin || twin.userData.key !== key) {
        twin?.dispose();
        material.addEventListener('dispose', freeTwin);
        const defines: Record<string, string> = {};
        if (material.map) defines.SURFACE_MAP = '';
        if (material.alphaTest > 0) defines.SURFACE_ALPHA_TEST = '';
        if (cutByAlphaMap(material)) defines.SURFACE_ALPHA_MAP = '';
        twin = new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: GBUFFER_VERTEX,
            fragmentShader: GBUFFER_FRAGMENT,
            defines,
            uniforms: {
                diffuse: { value: new THREE.Color() },
                roughness: { value: 1 },
                metalness: { value: 0 },
                alphaTest: { value: 0 },
                map: { value: null },
                mapTransform: { value: new THREE.Matrix3() },
                alphaMap: { value: null },
                alphaMapTransform: { value: new THREE.Matrix3() },
            },
        });
        twin.vertexColors = material.vertexColors;
        twin.userData.key = key;
        twins.set(material, twin);
    }
    const u = twin.uniforms;
    (u.diffuse.value as THREE.Color).copy(material.color);
    const { roughness, metalness } = surfaceOf(material);
    u.roughness.value = roughness;
    u.metalness.value = metalness;
    u.alphaTest.value = material.alphaTest;
    u.map.value = material.map;
    if (material.map) {
        if (material.map.matrixAutoUpdate) material.map.updateMatrix();
        (u.mapTransform.value as THREE.Matrix3).copy(material.map.matrix);
    } else {
        (u.mapTransform.value as THREE.Matrix3).identity();
    }
    if (cutByAlphaMap(material)) {
        const alphaMap = material.alphaMap!;
        u.alphaMap.value = alphaMap;
        if (alphaMap.matrixAutoUpdate) alphaMap.updateMatrix();
        (u.alphaMapTransform.value as THREE.Matrix3).copy(alphaMap.matrix);
    }
    twin.side = material.side;
    return twin;
};

const _clear = new THREE.Color();

/** Draws nothing: what a mesh that is not a lit surface draws when it cannot simply be hidden. */
const SKIP = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });

export class SurfaceBuffer {
    readonly target: THREE.WebGLRenderTarget;
    readonly depth: THREE.DepthTexture;
    private readonly swapped: Array<[THREE.Mesh, THREE.Material | THREE.Material[]]> = [];
    private readonly hidden: THREE.Object3D[] = [];

    constructor(width = 1, height = 1) {
        this.target = new THREE.WebGLRenderTarget(width, height, {
            count: 2,
            type: THREE.HalfFloatType,
            format: THREE.RGBAFormat,
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            depthBuffer: true,
            generateMipmaps: false,
        });
        this.depth = new THREE.DepthTexture(width, height, THREE.FloatType);
        this.target.depthTexture = this.depth;
    }

    get normalRoughness(): THREE.Texture { return this.target.textures[0]; }
    get albedoMetalness(): THREE.Texture { return this.target.textures[1]; }

    setSize(width: number, height: number): void {
        this.target.setSize(Math.max(1, width), Math.max(1, height));
    }

    /** Draws the scene's lit surfaces from `camera`, leaving the renderer and the scene as they were. */
    render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
        scene.traverseVisible(object => {
            const mesh = object as THREE.Mesh;
            if (!mesh.isMesh) {
                // Lines, points and sprites draw nothing here; groups stay to carry their children.
                if ((object as THREE.Line).isLine || (object as THREE.Points).isPoints || (object as THREE.Sprite).isSprite) {
                    this.hidden.push(object);
                }
                return;
            }
            const original = mesh.material;
            const materials = Array.isArray(original) ? original : [original];
            if (!materials.some(drawsSurface)) {
                // Hidden when it can be; a mesh carrying children draws nothing instead, so they still draw.
                if (mesh.children.length === 0) {
                    this.hidden.push(mesh);
                } else {
                    this.swapped.push([mesh, original]);
                    mesh.material = Array.isArray(original) ? original.map(() => SKIP) : SKIP;
                }
                return;
            }
            this.swapped.push([mesh, original]);
            mesh.material = Array.isArray(original)
                ? original.map(material => (drawsSurface(material) ? surfaceTwin(material as LitMaterial) : SKIP))
                : surfaceTwin(original as LitMaterial);
        });
        for (const object of this.hidden) object.visible = false;

        const before = renderer.getRenderTarget();
        const clearAlpha = renderer.getClearAlpha();
        renderer.getClearColor(_clear);
        const autoClear = renderer.autoClear;
        const shadows = renderer.shadowMap.autoUpdate;
        const background = scene.background;
        const overrideMaterial = scene.overrideMaterial;
        renderer.shadowMap.autoUpdate = false;
        renderer.autoClear = false;
        scene.background = null;
        scene.overrideMaterial = null;
        renderer.setRenderTarget(this.target);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, false);
        renderer.render(scene, camera);
        renderer.setRenderTarget(before);
        renderer.setClearColor(_clear, clearAlpha);
        renderer.autoClear = autoClear;
        renderer.shadowMap.autoUpdate = shadows;
        scene.background = background;
        scene.overrideMaterial = overrideMaterial;

        for (const object of this.hidden) object.visible = true;
        for (const [mesh, material] of this.swapped) mesh.material = material;
        this.hidden.length = 0;
        this.swapped.length = 0;
    }

    dispose(): void {
        this.target.dispose();
        this.depth.dispose();
    }
}
