import * as THREE from 'three';
import type { ParticleEffect, ParticleRenderMode } from './particleEffect';
import type { ParticleSimulation } from './particleSimulation';

/**
 * Draws a ParticleSimulation: one instanced quad per particle (camera-facing, stretched along its
 * motion, flat on the ground or upright), or a ribbon through the particles in the order they were
 * born. Sprites and flipbook frames come from the effect's texture; alpha-blended particles are
 * sorted back to front. Positions are already in world space (or the emitter's, turned into world
 * space by the emitter matrix in the shader), so the meshes keep an identity transform wherever
 * they sit in the scene graph.
 */

const MODE_DEFINE: Record<Exclude<ParticleRenderMode, 'ribbon'>, number> = { billboard: 0, stretched: 1, horizontal: 2, vertical: 3 };

const QUAD_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec3 iPosition;
attribute vec3 iVelocity;
attribute vec4 iColor;
attribute float iSize;
attribute float iRotation;
attribute float iFrame;
uniform mat4 uEmitter;
uniform vec2 uGrid;
uniform float uStretch;
varying vec2 vUv;
varying vec4 vColor;

void main() {
    vec3 center = (uEmitter * vec4(iPosition, 1.0)).xyz;
    vec2 corner = position.xy;
    vec3 world;
#if MODE == 1
    vec3 velocity = mat3(uEmitter) * iVelocity;
    float speed = length(velocity);
    vec3 axis = speed > 1e-4 ? velocity / speed : vec3(0.0, 1.0, 0.0);
    vec3 side = cross(axis, normalize(cameraPosition - center));
    float sideLength = length(side);
    side = sideLength > 1e-4 ? side / sideLength : vec3(1.0, 0.0, 0.0);
    world = center + side * corner.x * iSize + axis * corner.y * iSize * (1.0 + uStretch * speed);
#elif MODE == 2
    float c = cos(iRotation), s = sin(iRotation);
    vec2 turned = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * iSize;
    world = center + vec3(turned.x, 0.0, turned.y);
#elif MODE == 3
    vec3 toCamera = cameraPosition - center;
    vec3 right = normalize(vec3(toCamera.z, 0.0, -toCamera.x) + vec3(1e-5, 0.0, 0.0));
    world = center + right * corner.x * iSize + vec3(0.0, corner.y * iSize, 0.0);
#else
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    float c = cos(iRotation), s = sin(iRotation);
    vec2 turned = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * iSize;
    world = center + right * turned.x + up * turned.y;
#endif
    vec4 mvPosition = viewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    float column = mod(iFrame, uGrid.x);
    float row = floor(iFrame / uGrid.x);
    vUv = (vec2(column, uGrid.y - 1.0 - row) + uv) / uGrid;
    vColor = iColor;
    #include <fog_vertex>
}
`;

const RIBBON_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aColor;
varying vec2 vUv;
varying vec4 vColor;

void main() {
    vec4 mvPosition = viewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    vUv = uv;
    vColor = aColor;
    #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uMap;
uniform float uEmissive;
varying vec2 vUv;
varying vec4 vColor;

void main() {
    vec4 texel = texture2D(uMap, vUv);
    gl_FragColor = vec4(vColor.rgb * texel.rgb * uEmissive, vColor.a * texel.a);
    if (gl_FragColor.a < 0.003) discard;
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
#ifdef USE_FOG
    #ifdef FOG_EXP2
        float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
        float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    #ifdef ADDITIVE
        // Added light fades into fog rather than turning the fog's colour.
        gl_FragColor.rgb *= 1.0 - fogFactor;
    #else
        gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
    #endif
#endif
}
`;

const createMaterial = (vertexShader: string): THREE.ShaderMaterial => new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
            uMap: { value: null },
            uEmissive: { value: 1 },
            uGrid: { value: new THREE.Vector2(1, 1) },
            uStretch: { value: 0 },
            uEmitter: { value: new THREE.Matrix4() },
        },
    ]),
    vertexShader,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    fog: true,
});

/** A mesh that stays at the world origin whatever its parent: its vertices are already in world space. */
class WorldMesh extends THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> {
    constructor(geometry: THREE.BufferGeometry, material: THREE.ShaderMaterial) {
        super(geometry, material);
        this.matrixAutoUpdate = false;
        this.matrixWorldAutoUpdate = false;
        this.frustumCulled = false;
    }

    override updateMatrixWorld(): void {}

    override updateWorldMatrix(): void {}

    override raycast(): void {}
}

const dynamic = (array: Float32Array, itemSize: number, instanced: boolean) => {
    const attribute = instanced ? new THREE.InstancedBufferAttribute(array, itemSize) : new THREE.BufferAttribute(array, itemSize);
    return attribute.setUsage(THREE.DynamicDrawUsage);
};

const _cameraPosition = new THREE.Vector3();
const _cameraForward = new THREE.Vector3();

export class ParticleRenderer {
    readonly object = new THREE.Group();
    private readonly capacity: number;
    private readonly quads: WorldMesh;
    private readonly ribbon: WorldMesh;
    private readonly quadMaterial = createMaterial(QUAD_VERTEX);
    private readonly ribbonMaterial = createMaterial(RIBBON_VERTEX);
    private readonly position: Float32Array;
    private readonly velocity: Float32Array;
    private readonly color: Float32Array;
    private readonly size: Float32Array;
    private readonly rotation: Float32Array;
    private readonly frame: Float32Array;
    private readonly ribbonPosition: Float32Array;
    private readonly ribbonColor: Float32Array;
    private readonly ribbonUv: Float32Array;
    private readonly order: Uint32Array;
    private readonly keys: Float32Array;
    private mode: ParticleRenderMode = 'billboard';
    private sorted = true;
    private local = false;

    constructor(capacity: number) {
        this.capacity = Math.max(1, capacity);
        const n = this.capacity;
        this.position = new Float32Array(n * 3);
        this.velocity = new Float32Array(n * 3);
        this.color = new Float32Array(n * 4);
        this.size = new Float32Array(n);
        this.rotation = new Float32Array(n);
        this.frame = new Float32Array(n);
        this.order = new Uint32Array(n);
        this.keys = new Float32Array(n);

        const quad = new THREE.InstancedBufferGeometry();
        quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
        quad.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
        quad.setIndex([0, 1, 2, 0, 2, 3]);
        quad.setAttribute('iPosition', dynamic(this.position, 3, true));
        quad.setAttribute('iVelocity', dynamic(this.velocity, 3, true));
        quad.setAttribute('iColor', dynamic(this.color, 4, true));
        quad.setAttribute('iSize', dynamic(this.size, 1, true));
        quad.setAttribute('iRotation', dynamic(this.rotation, 1, true));
        quad.setAttribute('iFrame', dynamic(this.frame, 1, true));
        quad.instanceCount = 0;
        // Sorted by the emitter's position (kept current), never a sphere computed over unused instances.
        quad.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
        this.quads = new WorldMesh(quad, this.quadMaterial);
        this.quads.name = 'Particles';

        this.ribbonPosition = new Float32Array(n * 2 * 3);
        this.ribbonColor = new Float32Array(n * 2 * 4);
        this.ribbonUv = new Float32Array(n * 2 * 2);
        const strip = new THREE.BufferGeometry();
        strip.setAttribute('position', dynamic(this.ribbonPosition, 3, false));
        strip.setAttribute('aColor', dynamic(this.ribbonColor, 4, false));
        strip.setAttribute('uv', dynamic(this.ribbonUv, 2, false));
        const indices = new Uint32Array(Math.max(1, n - 1) * 6);
        for (let k = 0; k < n - 1; k++) indices.set([k * 2, k * 2 + 1, k * 2 + 2, k * 2 + 2, k * 2 + 1, k * 2 + 3], k * 6);
        strip.setIndex(new THREE.BufferAttribute(indices, 1));
        strip.setDrawRange(0, 0);
        strip.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
        this.ribbon = new WorldMesh(strip, this.ribbonMaterial);
        this.ribbon.name = 'ParticleRibbon';
        this.ribbon.visible = false;

        this.object.name = 'ParticleRenderer';
        this.object.add(this.quads, this.ribbon);
    }

    /** Takes an effect's look: its sprite texture, flipbook grid, mode and blending. */
    setLook(effect: ParticleEffect, texture: THREE.Texture, grid: [number, number]): void {
        const render = effect.render;
        this.mode = render.mode;
        this.local = effect.space === 'local';
        this.sorted = render.sort && render.blending === 'alpha';
        const additive = render.blending === 'additive';
        for (const material of [this.quadMaterial, this.ribbonMaterial]) {
            material.uniforms.uMap.value = texture;
            material.uniforms.uEmissive.value = render.emissive;
            (material.uniforms.uGrid.value as THREE.Vector2).set(grid[0], grid[1]);
            material.uniforms.uStretch.value = render.stretch;
            material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
            const defines: Record<string, unknown> = { MODE: render.mode === 'ribbon' ? 0 : MODE_DEFINE[render.mode] };
            if (additive) defines.ADDITIVE = '';
            if (JSON.stringify(defines) !== JSON.stringify(material.defines)) {
                material.defines = defines;
                material.needsUpdate = true;
            }
        }
        // Ribbons draw both sides; quads always face their way.
        this.ribbonMaterial.side = THREE.DoubleSide;
        this.quadMaterial.side = render.mode === 'horizontal' ? THREE.DoubleSide : THREE.FrontSide;
        this.quads.visible = render.mode !== 'ribbon';
        this.ribbon.visible = render.mode === 'ribbon';
    }

    /**
     * Uploads this frame's particles. `emitter` is the emitter's world matrix (it places local-space
     * particles, and is where transparent draws are sorted from); `camera` orders and faces them.
     */
    update(simulation: ParticleSimulation, emitter: THREE.Matrix4, camera: THREE.Camera): void {
        const count = Math.min(this.capacity, simulation.count);
        const emitterMatrix = this.local ? emitter : IDENTITY;
        for (const material of [this.quadMaterial, this.ribbonMaterial]) (material.uniforms.uEmitter.value as THREE.Matrix4).copy(emitterMatrix);
        _cameraPosition.setFromMatrixPosition(camera.matrixWorld);
        _cameraForward.set(0, 0, -1).transformDirection(camera.matrixWorld);
        this.quads.geometry.boundingSphere!.center.setFromMatrixPosition(emitter);
        this.ribbon.geometry.boundingSphere!.center.setFromMatrixPosition(emitter);
        if (this.mode === 'ribbon') this.updateRibbon(simulation, count, emitterMatrix);
        else this.updateQuads(simulation, count, emitterMatrix);
    }

    private updateQuads(simulation: ParticleSimulation, count: number, emitter: THREE.Matrix4): void {
        const order = this.order;
        for (let i = 0; i < count; i++) order[i] = i;
        if (this.sorted && count > 1) {
            const e = emitter.elements;
            const p = simulation.positions;
            for (let i = 0; i < count; i++) {
                const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
                const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
                const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
                const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
                this.keys[i] = (wx - _cameraPosition.x) * _cameraForward.x + (wy - _cameraPosition.y) * _cameraForward.y + (wz - _cameraPosition.z) * _cameraForward.z;
            }
            // Furthest first.
            order.subarray(0, count).sort((a, b) => this.keys[b] - this.keys[a]);
        }
        for (let k = 0; k < count; k++) {
            const i = order[k];
            for (let c = 0; c < 3; c++) {
                this.position[k * 3 + c] = simulation.positions[i * 3 + c];
                this.velocity[k * 3 + c] = simulation.velocities[i * 3 + c];
            }
            for (let c = 0; c < 4; c++) this.color[k * 4 + c] = simulation.colors[i * 4 + c];
            this.size[k] = simulation.sizes[i];
            this.rotation[k] = simulation.rotations[i];
            this.frame[k] = simulation.frames[i];
        }
        const geometry = this.quads.geometry as THREE.InstancedBufferGeometry;
        geometry.instanceCount = count;
        if (count === 0) return;
        for (const [name, itemSize] of QUAD_ATTRIBUTES) {
            const attribute = geometry.getAttribute(name) as THREE.BufferAttribute;
            attribute.clearUpdateRanges();
            attribute.addUpdateRange(0, count * itemSize);
            attribute.needsUpdate = true;
        }
    }

    private updateRibbon(simulation: ParticleSimulation, count: number, emitter: THREE.Matrix4): void {
        const geometry = this.ribbon.geometry;
        if (count < 2) {
            geometry.setDrawRange(0, 0);
            return;
        }
        // Oldest first: the tail of the ribbon to its head.
        const order = this.order;
        for (let i = 0; i < count; i++) order[i] = i;
        order.subarray(0, count).sort((a, b) => simulation.ages[b] - simulation.ages[a]);
        const e = emitter.elements;
        const world = (i: number, out: THREE.Vector3) => {
            const x = simulation.positions[i * 3], y = simulation.positions[i * 3 + 1], z = simulation.positions[i * 3 + 2];
            return out.set(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
        };
        const point = new THREE.Vector3(), before = new THREE.Vector3(), after = new THREE.Vector3(), side = new THREE.Vector3(), tangent = new THREE.Vector3();
        for (let k = 0; k < count; k++) {
            const i = order[k];
            world(i, point);
            world(order[Math.max(0, k - 1)], before);
            world(order[Math.min(count - 1, k + 1)], after);
            tangent.subVectors(after, before);
            side.subVectors(_cameraPosition, point).cross(tangent);
            const length = side.length();
            if (length > 1e-6) side.multiplyScalar(simulation.sizes[i] / 2 / length);
            else side.set(simulation.sizes[i] / 2, 0, 0);
            for (const [slot, sign] of [[0, 1], [1, -1]] as const) {
                const v = (k * 2 + slot) * 3;
                this.ribbonPosition[v] = point.x + side.x * sign;
                this.ribbonPosition[v + 1] = point.y + side.y * sign;
                this.ribbonPosition[v + 2] = point.z + side.z * sign;
                for (let c = 0; c < 4; c++) this.ribbonColor[(k * 2 + slot) * 4 + c] = simulation.colors[i * 4 + c];
                this.ribbonUv[(k * 2 + slot) * 2] = slot;
                this.ribbonUv[(k * 2 + slot) * 2 + 1] = 0.5;
            }
        }
        geometry.setDrawRange(0, (count - 1) * 6);
        for (const name of ['position', 'aColor', 'uv']) {
            const attribute = geometry.getAttribute(name) as THREE.BufferAttribute;
            attribute.clearUpdateRanges();
            attribute.addUpdateRange(0, count * 2 * attribute.itemSize);
            attribute.needsUpdate = true;
        }
    }

    dispose(): void {
        this.quads.geometry.dispose();
        this.ribbon.geometry.dispose();
        this.quadMaterial.dispose();
        this.ribbonMaterial.dispose();
        this.object.removeFromParent();
    }
}

const IDENTITY = new THREE.Matrix4();
const QUAD_ATTRIBUTES: [string, number][] = [['iPosition', 3], ['iVelocity', 3], ['iColor', 4], ['iSize', 1], ['iRotation', 1], ['iFrame', 1]];
