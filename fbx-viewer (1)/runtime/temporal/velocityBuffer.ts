import * as THREE from 'three';

/**
 * VELOCITY BUFFER
 *
 * How far each pixel of a moving object has come on screen since the last frame. Everything that stands
 * still gets its motion from the camera and its depth alone, so only what actually moved draws here: skinned
 * meshes, any mesh whose world matrix changed, and instanced meshes whose instances were moved. A scene that
 * stands still costs a clear.
 *
 * Moving meshes draw through stand-ins in a scene of their own, sharing geometry, skeleton and matrices, so
 * the level's scene is never touched and its lights and sky never run again. They draw against the scene's
 * own depth without writing to it, so only what can be seen writes a velocity. Zero means "nothing moving
 * here": a mesh that really did not move writes the smallest step instead.
 *
 * Vertex-shader motion (wind, water) and morph changes are not seen; the resolve's colour clipping covers them.
 */

const VELOCITY_VERTEX = /* glsl */ `
#include <common>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
uniform mat4 cleanViewProjection;
uniform mat4 previousViewProjection;
uniform mat4 previousModel;
uniform mat3 mapTransform;
out vec4 vCurrent;
out vec4 vPrevious;
out vec2 vSurfaceUv;
#ifdef VELOCITY_ALPHA_MAP
uniform mat3 alphaMapTransform;
out vec2 vAlphaUv;
#endif
#if defined( USE_SKINNING ) || defined( USE_INSTANCING )
// Last frame's matrices, four texels each, laid out the way three lays out a skeleton's.
mat4 matrixAt( highp sampler2D source, int index ) {
    int size = textureSize( source, 0 ).x;
    int j = index * 4;
    int x = j % size;
    int y = j / size;
    return mat4(
        texelFetch( source, ivec2( x, y ), 0 ),
        texelFetch( source, ivec2( x + 1, y ), 0 ),
        texelFetch( source, ivec2( x + 2, y ), 0 ),
        texelFetch( source, ivec2( x + 3, y ), 0 )
    );
}
#endif
#ifdef USE_SKINNING
uniform highp sampler2D previousBones;
#endif
#ifdef USE_INSTANCING
uniform highp sampler2D previousInstances;
#endif
void main() {
    vSurfaceUv = ( mapTransform * vec3( uv, 1.0 ) ).xy;
    #ifdef VELOCITY_ALPHA_MAP
    vAlphaUv = ( alphaMapTransform * vec3( uv, 1.0 ) ).xy;
    #endif
    #include <morphinstance_vertex>
    #include <begin_vertex>
    #include <morphtarget_vertex>
    vec3 unskinned = transformed;
    #include <skinbase_vertex>
    #include <skinning_vertex>
    #include <project_vertex>

    vec4 local = vec4( transformed, 1.0 );
    #ifdef USE_INSTANCING
    local = instanceMatrix * local;
    #endif
    vCurrent = cleanViewProjection * modelMatrix * local;

    #ifdef USE_SKINNING
    // Bones carry the mesh's own motion, so previousModel here holds the world matrix times the bind inverse.
    vec4 boundBefore = bindMatrix * vec4( unskinned, 1.0 );
    vec4 before = matrixAt( previousBones, int( skinIndex.x ) ) * boundBefore * skinWeight.x
        + matrixAt( previousBones, int( skinIndex.y ) ) * boundBefore * skinWeight.y
        + matrixAt( previousBones, int( skinIndex.z ) ) * boundBefore * skinWeight.z
        + matrixAt( previousBones, int( skinIndex.w ) ) * boundBefore * skinWeight.w;
    #else
    vec4 before = vec4( unskinned, 1.0 );
    #ifdef USE_INSTANCING
    before = matrixAt( previousInstances, gl_InstanceID ) * before;
    #endif
    #endif
    vPrevious = previousViewProjection * previousModel * before;
}`;

const VELOCITY_FRAGMENT = /* glsl */ `
precision highp float;
layout( location = 0 ) out vec4 velocityColor;
uniform float alphaTest;
uniform float opacity;
#ifdef VELOCITY_MAP
uniform sampler2D map;
#endif
#ifdef VELOCITY_ALPHA_MAP
uniform sampler2D alphaMap;
in vec2 vAlphaUv;
#endif
in vec4 vCurrent;
in vec4 vPrevious;
in vec2 vSurfaceUv;
void main() {
    #ifdef VELOCITY_ALPHA_TEST
    float alpha = opacity;
    #ifdef VELOCITY_MAP
    alpha *= texture( map, vSurfaceUv ).a;
    #endif
    #ifdef VELOCITY_ALPHA_MAP
    alpha *= texture( alphaMap, vAlphaUv ).g;
    #endif
    if ( alpha < alphaTest ) discard;
    #endif
    // Behind last frame's camera a position has no place on its screen, and dividing would mirror it onto one.
    vec2 velocity = vPrevious.w > 0.0 ? ( vCurrent.xy / vCurrent.w - vPrevious.xy / vPrevious.w ) * 0.5 : vec2( 0.0 );
    if ( dot( velocity, velocity ) < 1e-10 ) velocity = vec2( 1e-5, 0.0 );
    velocityColor = vec4( velocity, 0.0, 1.0 );
}`;

/** Whether a material shows in depth, and so can own the velocity of the pixels it covers. */
export const drawsVelocity = (material: THREE.Material): boolean =>
    material.visible && !material.transparent && material.depthWrite && material.depthTest && material.colorWrite;

type CutoutMaterial = THREE.Material & { map?: THREE.Texture | null; alphaMap?: THREE.Texture | null };

const cutoutKey = (material: CutoutMaterial) =>
    material.alphaTest > 0 ? `a${material.map ? 'm' : ''}${material.alphaMap ? 'p' : ''}` : '';

/** Both frames' view and projection, one pair shared by every twin. */
const sharedViews = {
    cleanViewProjection: { value: new THREE.Matrix4() },
    previousViewProjection: { value: new THREE.Matrix4() },
};

const twins = new WeakMap<THREE.Material, THREE.ShaderMaterial>();

const velocityTwin = (material: CutoutMaterial): THREE.ShaderMaterial => {
    const key = cutoutKey(material);
    let twin = twins.get(material);
    if (!twin || twin.userData.key !== key) {
        twin?.dispose();
        const defines: Record<string, string> = {};
        if (material.alphaTest > 0) {
            defines.VELOCITY_ALPHA_TEST = '';
            if (material.map) defines.VELOCITY_MAP = '';
            if (material.alphaMap) defines.VELOCITY_ALPHA_MAP = '';
        }
        twin = new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: VELOCITY_VERTEX,
            fragmentShader: VELOCITY_FRAGMENT,
            defines,
            uniforms: {
                ...sharedViews,
                previousModel: { value: null },
                previousBones: { value: null },
                previousInstances: { value: null },
                alphaTest: { value: 0 },
                opacity: { value: 1 },
                map: { value: null },
                mapTransform: { value: new THREE.Matrix3() },
                alphaMap: { value: null },
                alphaMapTransform: { value: new THREE.Matrix3() },
            },
            depthWrite: false,
            depthFunc: THREE.LessEqualDepth,
            blending: THREE.NoBlending,
            // The twin's depth can differ from the lit draw's in the last bits; pulled forward so it still passes.
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
            toneMapped: false,
        });
        twin.userData.key = key;
        twins.set(material, twin);
    }
    const u = twin.uniforms;
    u.alphaTest.value = material.alphaTest;
    u.opacity.value = material.opacity;
    if (material.alphaTest > 0) {
        if (material.map) {
            if (material.map.matrixAutoUpdate) material.map.updateMatrix();
            u.map.value = material.map;
            (u.mapTransform.value as THREE.Matrix3).copy(material.map.matrix);
        }
        if (material.alphaMap) {
            if (material.alphaMap.matrixAutoUpdate) material.alphaMap.updateMatrix();
            u.alphaMap.value = material.alphaMap;
            (u.alphaMapTransform.value as THREE.Matrix3).copy(material.alphaMap.matrix);
        }
    }
    twin.side = material.side;
    return twin;
};

/** Draws nothing: stands in for the materials of a multi-material mesh that do not show in depth. */
const SKIP = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });

/** How long a history not looked at is kept, in frames: what spawns and goes must not pile up on the GPU. */
const HISTORY_KEPT_FRAMES = 256;

/** Last frame's matrices of one skeleton or instanced mesh, as a texture. */
interface MatrixHistory {
    texture: THREE.DataTexture;
    data: Float32Array;
    sourceLength: number;
    seenAt: number;
    savedAt: number;
}

/** What is remembered of one mesh from frame to frame. */
interface Tracked {
    mesh: THREE.Mesh;
    /** Last frame's world matrix; for a skinned mesh, times its bind inverse. */
    previous: THREE.Matrix4;
    seenAt: number;
    /** The version of the instance matrices last seen, on an instanced mesh. */
    instanceVersion: number;
    standIn: THREE.Mesh | null;
    bones: MatrixHistory | null;
    instances: MatrixHistory | null;
    materials: THREE.Material[] | null;
}

const _current = new THREE.Matrix4();
const _clear = new THREE.Color();

export class VelocityBuffer {
    readonly target: THREE.WebGLRenderTarget;
    private readonly scene = new THREE.Scene();
    private readonly tracked = new WeakMap<THREE.Mesh, Tracked>();
    private readonly histories = new Map<object, MatrixHistory>();
    private readonly moving: Tracked[] = [];
    private readonly layers = new THREE.Layers();
    private frame = 0;

    constructor(width = 1, height = 1) {
        this.target = new THREE.WebGLRenderTarget(width, height, {
            type: THREE.HalfFloatType,
            format: THREE.RGFormat,
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            depthBuffer: true,
            generateMipmaps: false,
        });
        this.scene.matrixWorldAutoUpdate = false;
    }

    get texture(): THREE.Texture { return this.target.texture; }

    /** Draws against `depth`, which must be the size of this target. */
    setDepth(depth: THREE.DepthTexture | null): void {
        if (this.target.depthTexture === depth) return;
        this.target.depthTexture = depth;
        this.target.dispose();
    }

    setSize(width: number, height: number): void {
        this.target.setSize(Math.max(1, width), Math.max(1, height));
    }

    /** The current world position of a mesh as the previous-frame matrix would hold it. */
    private currentMatrix(mesh: THREE.Mesh): THREE.Matrix4 {
        const skinned = mesh as THREE.SkinnedMesh;
        return skinned.isSkinnedMesh ? _current.multiplyMatrices(skinned.matrixWorld, skinned.bindMatrixInverse) : mesh.matrixWorld;
    }

    /** The saved copy of `now`, made on first sight. After a gap (`stale`) its old values say nothing about motion now. */
    private historyOf(owner: object, now: Float32Array, stale: boolean): MatrixHistory {
        let history = this.histories.get(owner);
        if (!history || history.sourceLength !== now.length) {
            history?.texture.dispose();
            // A square whose rows hold whole matrices: four texels each, as the shader reads them.
            const size = Math.max(4, Math.ceil(Math.sqrt(now.length / 4) / 4) * 4);
            const data = new Float32Array(size * size * 4);
            data.set(now);
            const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
            texture.minFilter = THREE.NearestFilter;
            texture.magFilter = THREE.NearestFilter;
            texture.generateMipmaps = false;
            texture.needsUpdate = true;
            history = { texture, data, sourceLength: now.length, seenAt: -1, savedAt: -1 };
            this.histories.set(owner, history);
        } else if (stale) {
            history.data.set(now);
            history.texture.needsUpdate = true;
        }
        history.seenAt = this.frame;
        return history;
    }

    private save(history: MatrixHistory | null, now: Float32Array): void {
        if (!history || history.savedAt === this.frame) return;
        history.savedAt = this.frame;
        history.data.set(now);
        history.texture.needsUpdate = true;
    }

    private standInFor(mesh: THREE.Mesh, entry: Tracked): THREE.Mesh {
        let standIn = entry.standIn;
        if (!standIn) {
            const skinned = mesh as THREE.SkinnedMesh;
            const instanced = mesh as THREE.InstancedMesh;
            standIn = skinned.isSkinnedMesh
                ? new THREE.SkinnedMesh()
                : instanced.isInstancedMesh ? new THREE.InstancedMesh(mesh.geometry, SKIP, 0) : new THREE.Mesh();
            standIn.frustumCulled = false;
            standIn.matrixAutoUpdate = false;
            standIn.matrixWorldAutoUpdate = false;
            standIn.onBeforeRender = (_renderer, _scene, _camera, _geometry, material) => {
                const twin = material as THREE.ShaderMaterial;
                if (!twin.uniforms) return;
                twin.uniforms.previousModel.value = entry.previous;
                twin.uniforms.previousBones.value = entry.bones?.texture ?? null;
                twin.uniforms.previousInstances.value = entry.instances?.texture ?? null;
                twin.uniformsNeedUpdate = true;
            };
            entry.standIn = standIn;
        }
        standIn.geometry = mesh.geometry;
        standIn.matrixWorld = mesh.matrixWorld;
        standIn.morphTargetInfluences = mesh.morphTargetInfluences;
        standIn.morphTargetDictionary = mesh.morphTargetDictionary;
        const skinned = mesh as THREE.SkinnedMesh;
        if (skinned.isSkinnedMesh) {
            const skinnedStandIn = standIn as THREE.SkinnedMesh;
            skinnedStandIn.skeleton = skinned.skeleton;
            skinnedStandIn.bindMatrix = skinned.bindMatrix;
            skinnedStandIn.bindMatrixInverse = skinned.bindMatrixInverse;
            skinnedStandIn.bindMode = skinned.bindMode;
        }
        const instanced = mesh as THREE.InstancedMesh;
        if (instanced.isInstancedMesh) {
            const instancedStandIn = standIn as THREE.InstancedMesh;
            instancedStandIn.instanceMatrix = instanced.instanceMatrix;
            instancedStandIn.count = instanced.count;
        }
        return standIn;
    }

    private visit = (object: THREE.Object3D): void => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh || (mesh as unknown as { isBatchedMesh?: boolean }).isBatchedMesh) return;
        if (!mesh.layers.test(this.layers)) return;
        const original = mesh.material;
        if (Array.isArray(original) ? !original.some(drawsVelocity) : !drawsVelocity(original)) return;

        const skinned = mesh as THREE.SkinnedMesh;
        const instanced = mesh as THREE.InstancedMesh;
        const hasBones = skinned.isSkinnedMesh === true && !!skinned.skeleton;
        const hasInstances = instanced.isInstancedMesh === true;
        let entry = this.tracked.get(mesh);
        if (!entry) {
            entry = {
                mesh, previous: new THREE.Matrix4(), seenAt: -1, instanceVersion: hasInstances ? instanced.instanceMatrix.version : 0,
                standIn: null, bones: null, instances: null, materials: null,
            };
            this.tracked.set(mesh, entry);
        }
        const now = this.currentMatrix(mesh);
        // Back after being out of sight, or new: no motion to speak of yet.
        const backInSight = entry.seenAt < this.frame - 1;
        if (backInSight) entry.previous.copy(now);
        entry.seenAt = this.frame;
        const instancesMoved = hasInstances && entry.instanceVersion !== instanced.instanceMatrix.version;
        if (hasInstances) entry.instanceVersion = instanced.instanceMatrix.version;
        if (!hasBones && !instancesMoved && entry.previous.equals(now)) return;

        if (hasBones) {
            if (skinned.skeleton.boneTexture === null) skinned.skeleton.computeBoneTexture();
            entry.bones = this.historyOf(skinned.skeleton, skinned.skeleton.boneMatrices as Float32Array, backInSight);
        }
        if (hasInstances) entry.instances = this.historyOf(mesh, instanced.instanceMatrix.array as Float32Array, backInSight);
        const standIn = this.standInFor(mesh, entry);
        if (Array.isArray(original)) {
            const materials = entry.materials ?? (entry.materials = []);
            materials.length = original.length;
            for (let i = 0; i < original.length; i++) materials[i] = drawsVelocity(original[i]) ? velocityTwin(original[i]) : SKIP;
            standIn.material = materials;
        } else {
            standIn.material = velocityTwin(original);
        }
        this.moving.push(entry);
    };

    /**
     * Writes this frame's moving objects. `camera` holds the frame's jittered projection, so they land on the
     * same pixels as the lit draw; the two view matrices measure the motion without the jitter in it.
     */
    render(
        renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera,
        cleanViewProjection: THREE.Matrix4, previousViewProjection: THREE.Matrix4,
    ): void {
        this.frame += 1;
        this.layers.mask = camera.layers.mask;
        sharedViews.cleanViewProjection.value.copy(cleanViewProjection);
        sharedViews.previousViewProjection.value.copy(previousViewProjection);
        scene.traverseVisible(this.visit);

        const children = this.scene.children;
        children.length = 0;
        for (const entry of this.moving) children.push(entry.standIn!);

        const before = renderer.getRenderTarget();
        const autoClear = renderer.autoClear;
        const clearAlpha = renderer.getClearAlpha();
        renderer.getClearColor(_clear);
        renderer.autoClear = false;
        renderer.setRenderTarget(this.target);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, false, false);
        if (children.length > 0) renderer.render(this.scene, camera);
        renderer.setRenderTarget(before);
        renderer.setClearColor(_clear, clearAlpha);
        renderer.autoClear = autoClear;

        for (const entry of this.moving) {
            entry.previous.copy(this.currentMatrix(entry.mesh));
            if (entry.bones) this.save(entry.bones, (entry.mesh as THREE.SkinnedMesh).skeleton.boneMatrices as Float32Array);
            if (entry.instances) this.save(entry.instances, (entry.mesh as THREE.InstancedMesh).instanceMatrix.array as Float32Array);
        }
        this.moving.length = 0;

        if (this.frame % HISTORY_KEPT_FRAMES === 0) {
            for (const [owner, history] of this.histories) {
                if (history.seenAt >= this.frame - HISTORY_KEPT_FRAMES) continue;
                history.texture.dispose();
                this.histories.delete(owner);
            }
        }
    }

    dispose(): void {
        this.target.dispose();
        for (const history of this.histories.values()) history.texture.dispose();
        this.histories.clear();
    }
}
