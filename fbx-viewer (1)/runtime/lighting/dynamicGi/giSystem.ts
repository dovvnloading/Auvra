import * as THREE from 'three';
import { FramePressure, GpuSpanTimer, RayBudget } from '../../raytracing/rayBudget';
import { RayScene, type RayFilter, type TextureMean } from '../../raytracing/rayScene';
import { traceUniforms } from '../../raytracing/traceShader';
import { giAtlas, holdGiAtlas, setGiGrid, stepGiNoise, DYNAMIC_GI_UNIFORMS, type RayReflectionInputs } from './giMaterials';
import {
    CLEAR_FRAGMENT,
    FULLSCREEN_VERTEX,
    IRRADIANCE_FRAGMENT,
    MAX_DIRECTIONAL_LIGHTS,
    MAX_LOCAL_LIGHTS,
    OFFSET_FRAGMENT,
    PROBE_QUAD_VERTEX,
    RAY_VIEW_FRAGMENT,
    REFLECTION_RAYS_FRAGMENT,
    SCRATCH_HEIGHT,
    SCRATCH_WIDTH,
    STORE_FRAGMENT,
    TRACE_FRAGMENT,
    VISIBILITY_FRAGMENT,
} from './giShaders';
import {
    ATLAS_HEIGHT,
    ATLAS_WIDTH,
    CASCADE_RATIO,
    GI_CASCADES,
    GI_QUALITY,
    IRRADIANCE_CELL,
    MAX_PROBES_PER_FRAME,
    MAX_RAYS_PER_PROBE,
    PROBES_PER_CASCADE,
    ProbeCascade,
    VISIBILITY_CELL,
    budgetedPlan,
    sphericalFibonacci,
    type DynamicGiSettings,
    type ScheduledProbe,
} from './probeGrid';

/**
 * DYNAMIC GLOBAL ILLUMINATION
 *
 * Light that bounces around a level as it is now: every frame a few hundred probes around the camera send rays
 * through the ray scene (runtime/raytracing), and every lit material reads what they gather (giMaterials.ts). So
 * it needs no bake and takes in what is off screen, unlike the screen-space bounce: turn from a sunlit red wall
 * and the floor stays tinted; move the sun, a lamp or a wall and the room follows within a second or so.
 *
 * See probeGrid.ts for where the probes are, and giShaders.ts for the passes.
 */

/**
 * Seconds a large change takes to settle at each cascade. Light carries on bouncing through what the probes hold, so a
 * room takes a few of these to fill or to drain.
 */
const SETTLE_SECONDS = 0.5;
/** The most of the frame's GPU time limit the probes may take: reflections have what they leave. */
const GATHER_PART = 0.5;
/** Reflection rays a frame sends at the most, whatever the clock says: a limit a very large window cannot pass, and the only one on the first frames. */
const MAX_REFLECTION_RAYS = 1 << 20;
/** A pixel keeps its reflection until its next turn: with turns further apart than this it trails behind a moving camera, and the screen's alone looks better. */
const LEAST_REFLECTION_SHARE = 1 / 8;
/** Moves each pixel's turn along each frame: the golden ratio spreads them evenly over any number of frames. */
const GOLDEN_STEP = 0.61803399;
/** How wide the sun looks, as the sine of its angle: rays aim anywhere on it, which softens the shadows they find. */
const SUN_RADIUS = 0.02;
/** Most cells a frame may clear: a jump past every cascade at once. */
const MAX_CLEARED = GI_CASCADES * PROBES_PER_CASCADE;
/** Smallest texture a surface's average can be read from without being a poor one. */
const MEAN_SIZE = 16;
/** New texture averages read per frame at most, each a small stall on the GPU. */
const MEANS_PER_FRAME = 2;

const passTarget = (width: number, height: number, type: THREE.TextureDataType = THREE.HalfFloatType): THREE.WebGLRenderTarget =>
    new THREE.WebGLRenderTarget(width, height, {
        type,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
    });

const floatList = (width: number, height = 1): THREE.DataTexture => {
    const texture = new THREE.DataTexture(new Float32Array(width * height * 4), width, height, THREE.RGBAFormat, THREE.FloatType);
    texture.minFilter = texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.unpackAlignment = 1;
    return texture;
};

const quadGeometry = (): THREE.InstancedBufferGeometry => {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.instanceCount = 0;
    return geometry;
};

const passMaterial = (fragmentShader: string, vertexShader: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial =>
    new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms,
        depthTest: false,
        depthWrite: false,
        blending: THREE.NoBlending,
        toneMapped: false,
    });

const _position = new THREE.Vector3();
const _target = new THREE.Vector3();
const _way = new THREE.Vector3();
const _rotation = new THREE.Matrix4();
const _euler = new THREE.Euler();
const _quaternion = new THREE.Quaternion();
const _axis = new THREE.Vector3();

export class DynamicGi {
    readonly rayScene = new RayScene();
    private readonly cascades: ProbeCascade[] = [];
    private spacing = 0;
    private frame = 0;

    private readonly rays = passTarget(MAX_RAYS_PER_PROBE, MAX_PROBES_PER_FRAME);
    private readonly scratch = passTarget(SCRATCH_WIDTH, SCRATCH_HEIGHT);
    /** First row: each probe's place, and its code. Second row: the quaternion turning its rays. */
    private readonly probeList = floatList(MAX_PROBES_PER_FRAME, 2);
    private readonly clearList = floatList(Math.min(MAX_CLEARED, 8192));
    private readonly scheduled: ScheduledProbe[] = [];

    private directionCount = 0;
    private readonly rayDirections = Array.from({ length: MAX_RAYS_PER_PROBE }, () => new THREE.Vector4());

    private readonly passScene = new THREE.Scene();
    private readonly passCamera = new THREE.Camera();
    private readonly fullscreen = new THREE.BufferGeometry();
    private readonly quads = quadGeometry();
    private readonly passMesh: THREE.Mesh;

    private readonly common: Record<string, THREE.IUniform>;
    private readonly traceMaterial: THREE.ShaderMaterial;
    private readonly irradianceMaterial: THREE.ShaderMaterial;
    private readonly visibilityMaterial: THREE.ShaderMaterial;
    private readonly storeIrradianceMaterial: THREE.ShaderMaterial;
    private readonly storeVisibilityMaterial: THREE.ShaderMaterial;
    private readonly offsetMaterial: THREE.ShaderMaterial;
    private readonly storeOffsetMaterial: THREE.ShaderMaterial;
    private readonly clearMaterial: THREE.ShaderMaterial;
    private readonly clearVisibilityMaterial: THREE.ShaderMaterial;
    private readonly clearOffsetMaterial: THREE.ShaderMaterial;
    readonly rayViewMaterial: THREE.ShaderMaterial;
    private readonly reflectionMaterial: THREE.ShaderMaterial;

    private readonly releaseAtlas = holdGiAtlas();
    private traceReady = false;
    private traceCompiling = false;
    /** Which compile of the trace counts, and how many are still running: three reads a material's program until they end. */
    private compileNumber = 0;
    private compilesRunning = 0;
    private disposed = false;
    private reflectionsReady = false;
    private reflectionsCompiling = false;
    private reflectionCompileNumber = 0;
    private reflectionCompilesRunning = 0;
    private readonly environment: { source: THREE.Texture | null; version: number; form: number; target: THREE.WebGLRenderTarget | null; pmrem: THREE.PMREMGenerator | null } =
        { source: null, version: -1, form: 0, target: null, pmrem: null };

    private readonly means = new Map<string, [number, number, number]>();
    private meansLeft = 0;
    private meanTarget: THREE.WebGLRenderTarget | null = null;
    private meanMaterial: THREE.ShaderMaterial | null = null;

    private readonly gatherBudget = new RayBudget();
    private readonly reflectionBudget = new RayBudget(LEAST_REFLECTION_SHARE);
    private readonly pressure = new FramePressure();
    private readonly gatherTimer: GpuSpanTimer;
    private readonly reflectionTimer: GpuSpanTimer;
    private lastUpdate: number | null = null;
    private rayLimit = 0;

    private readonly lights = {
        ambientLight: new THREE.Color(),
        hemiSky: new THREE.Color(),
        hemiGround: new THREE.Color(),
        hemiUp: new THREE.Vector3(0, 1, 0),
    };

    constructor(private readonly gl: THREE.WebGLRenderer) {
        this.gatherTimer = new GpuSpanTimer(gl.getContext() as WebGL2RenderingContext);
        this.reflectionTimer = new GpuSpanTimer(gl.getContext() as WebGL2RenderingContext);
        this.fullscreen.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
        this.passMesh = new THREE.Mesh(this.fullscreen);
        this.passMesh.frustumCulled = false;
        this.passScene.add(this.passMesh);

        this.common = {
            ...traceUniforms(this.rayScene),
            auvraGiAtlas: DYNAMIC_GI_UNIFORMS.auvraGiAtlas,
            auvraGiGrid: DYNAMIC_GI_UNIFORMS.auvraGiGrid,
            auvraGiCorners: DYNAMIC_GI_UNIFORMS.auvraGiCorners,
            ambientLight: { value: this.lights.ambientLight },
            hemiSky: { value: this.lights.hemiSky },
            hemiGround: { value: this.lights.hemiGround },
            hemiUp: { value: this.lights.hemiUp },
            envRotation: { value: new THREE.Matrix3() },
            envIntensity: { value: 1 },
            envMap: { value: null },
            directionalCount: { value: 0 },
            directional: { value: new Float32Array(MAX_DIRECTIONAL_LIGHTS * 2 * 4) },
            localCount: { value: 0 },
            local: { value: new Float32Array(MAX_LOCAL_LIGHTS * 3 * 4) },
            bounce: { value: 1 },
            frame: { value: 0 },
        };

        const shared = { rayDirections: { value: this.rayDirections }, probeList: { value: this.probeList } };
        this.traceMaterial = passMaterial(TRACE_FRAGMENT, FULLSCREEN_VERTEX, { ...this.common, ...shared });
        this.rayViewMaterial = passMaterial(RAY_VIEW_FRAGMENT, FULLSCREEN_VERTEX, {
            ...this.common,
            viewportSize: { value: new THREE.Vector2(1, 1) },
            viewportOrigin: { value: new THREE.Vector2() },
            inverseViewProjection: { value: new THREE.Matrix4() },
            rayOrigin: { value: new THREE.Vector3() },
        });
        this.reflectionMaterial = passMaterial(REFLECTION_RAYS_FRAGMENT, FULLSCREEN_VERTEX, {
            ...this.common,
            surfaceDepth: { value: null },
            surfaceNormal: { value: null },
            screenReflection: { value: null },
            inverseProjection: { value: new THREE.Matrix4() },
            cameraWorld: { value: new THREE.Matrix4() },
            targetSize: { value: new THREE.Vector2(1, 1) },
            rayShare: { value: 1 },
            rayPhase: { value: 0 },
        });
        this.reflectionMaterial.defines.RT_SKIP_CHARACTERS = '';
        const quad = (cellSize: number, quadMode: number, width: number, height: number) => ({
            targetSize: { value: new THREE.Vector2(width, height) },
            cellSize: { value: cellSize },
            quadMode: { value: quadMode },
        });
        const integrate = {
            ...shared,
            rays: { value: this.rays.texture },
            atlas: { value: giAtlas.texture },
            rayCount: { value: 0 },
            cascadeBlend: { value: [0.3, 0.3, 0.3, 0.3] },
            cascadeSpacing: { value: [1, 1, 1, 1] },
        };
        this.irradianceMaterial = passMaterial(IRRADIANCE_FRAGMENT, PROBE_QUAD_VERTEX, { ...integrate, ...quad(IRRADIANCE_CELL, 0, SCRATCH_WIDTH, SCRATCH_HEIGHT) });
        this.visibilityMaterial = passMaterial(VISIBILITY_FRAGMENT, PROBE_QUAD_VERTEX, { ...integrate, ...quad(VISIBILITY_CELL, 0, SCRATCH_WIDTH, SCRATCH_HEIGHT) });
        const store = { probeList: shared.probeList, scratch: { value: this.scratch.texture } };
        this.storeIrradianceMaterial = passMaterial(STORE_FRAGMENT, PROBE_QUAD_VERTEX, { ...store, ...quad(IRRADIANCE_CELL, 1, ATLAS_WIDTH, ATLAS_HEIGHT) });
        this.storeVisibilityMaterial = passMaterial(STORE_FRAGMENT, PROBE_QUAD_VERTEX, { ...store, ...quad(VISIBILITY_CELL, 1, ATLAS_WIDTH, ATLAS_HEIGHT) });
        this.clearMaterial = passMaterial(CLEAR_FRAGMENT, PROBE_QUAD_VERTEX, { probeList: { value: this.clearList }, ...quad(IRRADIANCE_CELL, 1, ATLAS_WIDTH, ATLAS_HEIGHT) });
        this.clearVisibilityMaterial = passMaterial(CLEAR_FRAGMENT, PROBE_QUAD_VERTEX, { probeList: { value: this.clearList }, ...quad(VISIBILITY_CELL, 1, ATLAS_WIDTH, ATLAS_HEIGHT) });
        this.offsetMaterial = passMaterial(OFFSET_FRAGMENT, PROBE_QUAD_VERTEX, { ...integrate, ...quad(1, 0, SCRATCH_WIDTH, SCRATCH_HEIGHT) });
        this.storeOffsetMaterial = passMaterial(STORE_FRAGMENT, PROBE_QUAD_VERTEX, { ...store, ...quad(1, 1, ATLAS_WIDTH, ATLAS_HEIGHT) });
        this.clearOffsetMaterial = passMaterial(CLEAR_FRAGMENT, PROBE_QUAD_VERTEX, { probeList: { value: this.clearList }, ...quad(1, 1, ATLAS_WIDTH, ATLAS_HEIGHT) });

        for (const material of [this.rayViewMaterial]) material.toneMapped = true;
    }

    /** What the ray scene holds now and what is still to come in, for the inspector and for checks. */
    get status() {
        const stats = this.rayScene.stats;
        return {
            ...stats,
            traceReady: this.traceReady,
            waiting: this.cascades.reduce((sum, cascade) => sum + cascade.pending, 0),
            frame: this.frame,
            budget: {
                timed: this.gatherTimer.available,
                limitMs: this.rayLimit * this.pressure.value,
                pressure: this.pressure.value,
                gather: { share: this.gatherBudget.share, ms: this.gatherBudget.spentMs },
                reflections: { share: this.reflectionBudget.affordable ? this.reflectionBudget.share : 0, ms: this.reflectionBudget.affordable ? this.reflectionBudget.spentMs : 0 },
            },
        };
    }

    /** One frame's gathering. `scene` and `camera` are the view the probes follow. */
    update(scene: THREE.Scene, camera: THREE.Camera, include: RayFilter, settings: DynamicGiSettings): void {
        const gl = this.gl;
        const before = gl.getRenderTarget();
        const autoClear = gl.autoClear;
        gl.autoClear = false;
        this.meansLeft = MEANS_PER_FRAME;
        this.rayScene.update(scene, include, this.textureMean, 4);
        this.settleBudgets(settings.rayLimit);
        this.frame++;
        stepGiNoise(this.frame);
        this.common.frame.value = this.frame;
        this.common.bounce.value = settings.bounce;
        this.syncEnvironment(scene);
        this.gatherLights(scene, camera);
        this.placeCascades(settings.spacing, camera);
        if (this.compiled()) this.gather(settings);
        gl.setRenderTarget(before);
        gl.autoClear = autoClear;
    }

    /** Takes in what the GPU's clock and the time between frames say, and sets how much of its work the coming frame does. */
    private settleBudgets(rayLimit: number): void {
        const now = performance.now();
        if (this.lastUpdate !== null) this.pressure.noteFrame(now - this.lastUpdate);
        this.lastUpdate = now;
        this.rayLimit = rayLimit;
        this.gatherTimer.read((ms, share) => this.gatherBudget.noteSpent(ms, share));
        this.reflectionTimer.read((ms, share) => this.reflectionBudget.noteSpent(ms, share));
        const limit = rayLimit * this.pressure.value;
        const forGather = limit * GATHER_PART;
        this.gatherBudget.settle(forGather, this.pressure.value);
        this.reflectionBudget.settle(limit - Math.min(this.gatherBudget.spentMs, forGather), this.pressure.value);
    }

    /** A surface's average colour, read back from the GPU once, whatever form the texture takes. */
    private readonly textureMean: TextureMean = (texture) => {
        const key = `${texture.uuid}:${texture.version}`;
        const known = this.means.get(key);
        if (known) return known;
        if (!texture.image || this.meansLeft <= 0) return [0.5, 0.5, 0.5];
        this.meansLeft--;
        this.meanTarget ??= passTarget(MEAN_SIZE, MEAN_SIZE, THREE.FloatType);
        this.meanMaterial ??= passMaterial(
            'uniform sampler2D map; varying vec2 vUv; void main() { gl_FragColor = texture2D( map, vUv ); }',
            'varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4( position.xy, 1.0, 1.0 ); }',
            { map: { value: null } },
        );
        this.meanMaterial.uniforms.map.value = texture;
        this.draw(this.meanTarget, this.meanMaterial, this.fullscreen);
        const pixels = new Float32Array(MEAN_SIZE * MEAN_SIZE * 4);
        this.gl.readRenderTargetPixels(this.meanTarget, 0, 0, MEAN_SIZE, MEAN_SIZE, pixels);
        // Over what shows: the see-through part of a leaf texture is whatever colour it happens to be.
        const sum: [number, number, number] = [0, 0, 0];
        let shown = 0;
        for (let at = 0; at < pixels.length; at += 4) {
            sum[0] += pixels[at] * pixels[at + 3];
            sum[1] += pixels[at + 1] * pixels[at + 3];
            sum[2] += pixels[at + 2] * pixels[at + 3];
            shown += pixels[at + 3];
        }
        const mean: [number, number, number] = shown > 0 ? [sum[0] / shown, sum[1] / shown, sum[2] / shown] : [0.5, 0.5, 0.5];
        this.means.set(key, mean);
        return mean;
    };

    private draw(target: THREE.WebGLRenderTarget, material: THREE.Material, geometry: THREE.BufferGeometry): void {
        this.passMesh.material = material;
        this.passMesh.geometry = geometry;
        this.gl.setRenderTarget(target);
        this.gl.render(this.passScene, this.passCamera);
    }

    /** The trace is a big shader: compiled in the background where the browser can, so the editor does not stall on it. */
    private compiled(): boolean {
        if (this.traceReady) return true;
        if (this.traceCompiling) return false;
        this.traceCompiling = true;
        this.passMesh.material = this.traceMaterial;
        this.passMesh.geometry = this.fullscreen;
        // Compiled for the target it draws to, so drawing finds this same program.
        this.gl.setRenderTarget(this.rays);
        const number = ++this.compileNumber;
        this.compilesRunning++;
        const ready = () => {
            this.compilesRunning--;
            if (number === this.compileNumber) this.traceReady = true;
            if (this.disposed && this.compilesRunning === 0) this.traceMaterial.dispose();
        };
        void this.gl.compileAsync(this.passScene, this.passCamera).then(ready, ready);
        return false;
    }

    /**
     * Carries reflections on past what the screen shows, into `target`. False until its big shader has compiled, in
     * the background like the trace's, and the probes have something to light what the rays meet.
     */
    traceReflections(target: THREE.WebGLRenderTarget, inputs: RayReflectionInputs): boolean {
        if (!this.traceReady) return false;
        if (!this.reflectionsReady) {
            if (this.reflectionsCompiling) return false;
            this.reflectionsCompiling = true;
            this.passMesh.material = this.reflectionMaterial;
            this.passMesh.geometry = this.fullscreen;
            this.gl.setRenderTarget(target);
            const number = ++this.reflectionCompileNumber;
            this.reflectionCompilesRunning++;
            const ready = () => {
                this.reflectionCompilesRunning--;
                if (number === this.reflectionCompileNumber) this.reflectionsReady = true;
                if (this.disposed && this.reflectionCompilesRunning === 0) this.reflectionMaterial.dispose();
            };
            void this.gl.compileAsync(this.passScene, this.passCamera).then(ready, ready);
            return false;
        }
        if (!this.reflectionBudget.affordable) return false;
        const uniforms = this.reflectionMaterial.uniforms;
        uniforms.surfaceDepth.value = inputs.depth;
        uniforms.surfaceNormal.value = inputs.normalRoughness;
        uniforms.screenReflection.value = inputs.screen;
        (uniforms.inverseProjection.value as THREE.Matrix4).copy((inputs.camera as THREE.PerspectiveCamera).projectionMatrixInverse);
        (uniforms.cameraWorld.value as THREE.Matrix4).copy(inputs.camera.matrixWorld);
        (uniforms.targetSize.value as THREE.Vector2).set(target.width, target.height);
        const share = Math.min(this.reflectionBudget.share, MAX_REFLECTION_RAYS / (target.width * target.height));
        uniforms.rayShare.value = share;
        uniforms.rayPhase.value = (this.frame * GOLDEN_STEP) % 1;
        const autoClear = this.gl.autoClear;
        this.gl.autoClear = false;
        this.reflectionTimer.begin(this.frame, share);
        this.draw(target, this.reflectionMaterial, this.fullscreen);
        this.reflectionTimer.end();
        this.gl.autoClear = autoClear;
        return true;
    }

    private placeCascades(baseSpacing: number, camera: THREE.Camera): void {
        if (baseSpacing !== this.spacing) {
            this.spacing = baseSpacing;
            this.cascades.length = 0;
            for (let index = 0; index < GI_CASCADES; index++) this.cascades.push(new ProbeCascade(index, baseSpacing * CASCADE_RATIO ** index));
        }
        camera.getWorldPosition(_position);
        const list = this.clearList.image.data as unknown as Float32Array;
        let cleared = 0;
        const room = list.length / 4;
        this.cascades.forEach((cascade, index) => {
            const entered = cascade.recentre(_position.x, _position.y, _position.z);
            for (let at = 0; at < entered.length && cleared < room; at++) {
                list[cleared * 4 + 3] = index * PROBES_PER_CASCADE + entered[at];
                cleared++;
            }
            const [x, y, z] = cascade.corner();
            setGiGrid(index, x, y, z, cascade.spacing);
        });
        if (cleared > 0) {
            this.clearList.needsUpdate = true;
            this.quads.instanceCount = cleared;
            this.draw(giAtlas, this.clearMaterial, this.quads);
            this.draw(giAtlas, this.clearVisibilityMaterial, this.quads);
            this.draw(giAtlas, this.clearOffsetMaterial, this.quads);
        }
    }

    private gather(settings: DynamicGiSettings): void {
        const plan = budgetedPlan(GI_QUALITY[settings.quality], this.gatherBudget.share);
        const rayCount = Math.min(plan.rays, MAX_RAYS_PER_PROBE);
        const scheduled = this.scheduled;
        scheduled.length = 0;
        this.cascades.forEach((cascade, index) => cascade.take(plan.probes[index], scheduled));
        const count = Math.min(scheduled.length, MAX_PROBES_PER_FRAME);
        if (!count) return;
        const list = this.probeList.image.data as unknown as Float32Array;
        for (let index = 0; index < count; index++) {
            const probe = scheduled[index];
            list[index * 4] = probe.x;
            list[index * 4 + 1] = probe.y;
            list[index * 4 + 2] = probe.z;
            list[index * 4 + 3] = probe.cascade * PROBES_PER_CASCADE + probe.cell;
            _axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
            _quaternion.setFromAxisAngle(_axis, Math.random() * Math.PI * 2);
            const turn = (MAX_PROBES_PER_FRAME + index) * 4;
            list[turn] = _quaternion.x;
            list[turn + 1] = _quaternion.y;
            list[turn + 2] = _quaternion.z;
            list[turn + 3] = _quaternion.w;
        }
        this.probeList.needsUpdate = true;
        this.setRays(rayCount);

        const blend = this.irradianceMaterial.uniforms.cascadeBlend.value as number[];
        const spacing = this.irradianceMaterial.uniforms.cascadeSpacing.value as number[];
        const framesToSettle = SETTLE_SECONDS * 1000 / this.pressure.frameMs;
        this.cascades.forEach((cascade, index) => {
            const framesBetween = PROBES_PER_CASCADE / Math.max(plan.probes[index], 1);
            blend[index] = 1 - Math.exp(-framesBetween / framesToSettle);
            spacing[index] = cascade.spacing;
        });
        this.irradianceMaterial.uniforms.rayCount.value = rayCount;
        this.visibilityMaterial.uniforms.rayCount.value = rayCount;
        this.offsetMaterial.uniforms.rayCount.value = rayCount;

        this.rays.viewport.set(0, 0, rayCount, count);
        this.rays.scissor.set(0, 0, rayCount, count);
        this.rays.scissorTest = true;
        this.gatherTimer.begin(this.frame, this.gatherBudget.share);
        this.draw(this.rays, this.traceMaterial, this.fullscreen);
        this.quads.instanceCount = count;
        this.draw(this.scratch, this.irradianceMaterial, this.quads);
        this.draw(this.scratch, this.visibilityMaterial, this.quads);
        this.draw(this.scratch, this.offsetMaterial, this.quads);
        this.draw(giAtlas, this.storeIrradianceMaterial, this.quads);
        this.draw(giAtlas, this.storeVisibilityMaterial, this.quads);
        this.draw(giAtlas, this.storeOffsetMaterial, this.quads);
        this.gatherTimer.end();
    }

    /** The set of directions each probe turns its own way (see the probe list). */
    private setRays(rayCount: number): void {
        if (this.directionCount === rayCount) return;
        this.directionCount = rayCount;
        const directions = sphericalFibonacci(rayCount);
        for (let index = 0; index < rayCount; index++) {
            this.rayDirections[index].set(directions[index * 3], directions[index * 3 + 1], directions[index * 3 + 2], 0);
        }
    }

    private gatherLights(scene: THREE.Scene, camera: THREE.Camera): void {
        const { ambientLight, hemiSky, hemiGround, hemiUp } = this.lights;
        ambientLight.setRGB(0, 0, 0);
        hemiSky.setRGB(0, 0, 0);
        hemiGround.setRGB(0, 0, 0);
        hemiUp.set(0, 1, 0);
        const directional: THREE.DirectionalLight[] = [];
        const local: THREE.Light[] = [];
        let hemispheres = 0;
        scene.traverseVisible((object) => {
            const light = object as THREE.Light;
            if (!light.isLight || light.intensity <= 0) return;
            if ((light as THREE.AmbientLight).isAmbientLight) {
                ambientLight.r += light.color.r * light.intensity;
                ambientLight.g += light.color.g * light.intensity;
                ambientLight.b += light.color.b * light.intensity;
            } else if ((light as THREE.HemisphereLight).isHemisphereLight) {
                const hemisphere = light as THREE.HemisphereLight;
                hemiSky.r += hemisphere.color.r * hemisphere.intensity;
                hemiSky.g += hemisphere.color.g * hemisphere.intensity;
                hemiSky.b += hemisphere.color.b * hemisphere.intensity;
                hemiGround.r += hemisphere.groundColor.r * hemisphere.intensity;
                hemiGround.g += hemisphere.groundColor.g * hemisphere.intensity;
                hemiGround.b += hemisphere.groundColor.b * hemisphere.intensity;
                if (hemispheres++ === 0) hemiUp.copy(hemisphere.getWorldPosition(_position)).normalize();
            } else if ((light as THREE.DirectionalLight).isDirectionalLight) {
                // Shadow-only cascades are black (runtime/lighting/DistanceShadowLights.tsx): they add nothing.
                if (light.color.r + light.color.g + light.color.b > 0) directional.push(light as THREE.DirectionalLight);
            } else if ((light as THREE.PointLight).isPointLight || (light as THREE.SpotLight).isSpotLight) {
                local.push(light);
            }
        });
        if (hemiUp.lengthSq() < 1e-6) hemiUp.set(0, 1, 0);

        const strength = (light: THREE.Light) => (light.color.r + light.color.g + light.color.b) * light.intensity;
        directional.sort((a, b) => strength(b) - strength(a));
        const directionalCount = Math.min(directional.length, MAX_DIRECTIONAL_LIGHTS);
        const dirs = this.common.directional.value as Float32Array;
        for (let index = 0; index < directionalCount; index++) {
            const light = directional[index];
            light.getWorldPosition(_position);
            light.target.getWorldPosition(_target);
            _way.subVectors(_position, _target).normalize();
            dirs.set([_way.x, _way.y, _way.z, SUN_RADIUS, light.color.r * light.intensity, light.color.g * light.intensity, light.color.b * light.intensity, 0], index * 8);
        }
        this.common.directionalCount.value = directionalCount;

        camera.getWorldPosition(_target);
        if (local.length > MAX_LOCAL_LIGHTS) {
            const weight = (light: THREE.Light) => strength(light) / Math.max(light.getWorldPosition(_position).distanceToSquared(_target), 1);
            local.sort((a, b) => weight(b) - weight(a));
        }
        const localCount = Math.min(local.length, MAX_LOCAL_LIGHTS);
        const locals = this.common.local.value as Float32Array;
        for (let index = 0; index < localCount; index++) {
            const light = local[index] as THREE.PointLight & Partial<THREE.SpotLight>;
            light.getWorldPosition(_position);
            const to = index * 12;
            const range = light.distance;
            locals.set([_position.x, _position.y, _position.z, range], to);
            if (light.isSpotLight && light.target) {
                light.target.getWorldPosition(_way);
                _way.sub(_position).negate().normalize();
                const outer = Math.cos(light.angle ?? Math.PI / 3);
                const inner = Math.cos((light.angle ?? Math.PI / 3) * (1 - (light.penumbra ?? 0)));
                locals.set([light.color.r * light.intensity, light.color.g * light.intensity, light.color.b * light.intensity, inner], to + 4);
                locals.set([_way.x, _way.y, _way.z, outer], to + 8);
            } else {
                locals.set([light.color.r * light.intensity, light.color.g * light.intensity, light.color.b * light.intensity, 0], to + 4);
                // No cone.
                locals.set([0, 0, 0, -2], to + 8);
            }
        }
        this.common.localCount.value = localCount;
    }

    /**
     * Keeps the scene's environment in the prefiltered (cube UV) form the rays sample, made again when it
     * changes, as the screen-space trace does (screenLighting.ts).
     */
    private syncEnvironment(scene: THREE.Scene): void {
        this.common.envIntensity.value = scene.environmentIntensity;
        const source = scene.environment;
        const held = this.environment;
        if (source === held.source && (source === null || source.version === held.version)) return;
        held.target?.dispose();
        held.target = null;
        held.source = source;
        held.version = source?.version ?? -1;
        let prefiltered: THREE.Texture | null = null;
        if (source && source.mapping === THREE.CubeUVReflectionMapping) {
            prefiltered = source;
        } else if (source) {
            held.pmrem ??= new THREE.PMREMGenerator(this.gl);
            held.target = (source as THREE.CubeTexture).isCubeTexture
                ? held.pmrem.fromCubemap(source as THREE.CubeTexture)
                : held.pmrem.fromEquirectangular(source);
            prefiltered = held.target.texture;
        }
        this.common.envMap.value = prefiltered;
        if (prefiltered) {
            _euler.copy(scene.environmentRotation);
            _euler.x *= -1;
            _euler.y *= -1;
            _euler.z *= -1;
            const cube = source as THREE.CubeTexture & { isRenderTargetTexture?: boolean };
            if (cube?.isCubeTexture && !cube.isRenderTargetTexture) {
                _euler.y *= -1;
                _euler.z *= -1;
            }
            (this.common.envRotation.value as THREE.Matrix3).setFromMatrix4(_rotation.makeRotationFromEuler(_euler));
        }
        // The shader only depends on whether there is a map, and its size: a sky captured again changes neither.
        const form = prefiltered ? (prefiltered.image as { height: number }).height : 0;
        if (form === held.form) return;
        held.form = form;
        for (const material of [this.traceMaterial, this.rayViewMaterial, this.reflectionMaterial]) {
            const defines = material.defines as Record<string, string | number>;
            for (const key of ['SKY_ENVIRONMENT', 'ENVMAP_TYPE_CUBE_UV', 'CUBEUV_TEXEL_WIDTH', 'CUBEUV_TEXEL_HEIGHT', 'CUBEUV_MAX_MIP']) delete defines[key];
            if (prefiltered) {
                const height = (prefiltered.image as { height: number }).height;
                const maxMip = Math.log2(height) - 2;
                defines.SKY_ENVIRONMENT = '';
                defines.ENVMAP_TYPE_CUBE_UV = '';
                defines.CUBEUV_TEXEL_WIDTH = 1 / (3 * Math.max(2 ** maxMip, 7 * 16));
                defines.CUBEUV_TEXEL_HEIGHT = 1 / height;
                defines.CUBEUV_MAX_MIP = `${maxMip}.0`;
            }
            material.needsUpdate = true;
        }
        // A changed shader: compile it in the background again.
        this.traceReady = false;
        this.traceCompiling = false;
        this.reflectionsReady = false;
        this.reflectionsCompiling = false;
        this.reflectionCompileNumber++;
    }

    dispose(): void {
        this.disposed = true;
        this.gatherTimer.dispose();
        this.reflectionTimer.dispose();
        this.rayScene.dispose();
        this.rays.dispose();
        this.scratch.dispose();
        this.probeList.dispose();
        this.clearList.dispose();
        this.fullscreen.dispose();
        this.quads.dispose();
        this.environment.target?.dispose();
        this.environment.pmrem?.dispose();
        this.meanTarget?.dispose();
        this.meanMaterial?.dispose();
        // Not while three is still waiting on its program: it would read a program that is gone, and throw.
        if (this.compilesRunning === 0) this.traceMaterial.dispose();
        if (this.reflectionCompilesRunning === 0) this.reflectionMaterial.dispose();
        for (const material of [this.irradianceMaterial, this.visibilityMaterial, this.storeIrradianceMaterial, this.storeVisibilityMaterial, this.offsetMaterial, this.storeOffsetMaterial, this.clearMaterial, this.clearVisibilityMaterial, this.clearOffsetMaterial, this.rayViewMaterial]) material.dispose();
        this.releaseAtlas();
    }
}
