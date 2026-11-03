import * as THREE from 'three';
import { CLOUD_EDGE, cloudThreshold, GROUND_RADIUS, TOP_RADIUS, type AtmosphereCoefficients } from '../../../runtime/sky/atmosphere';
import type { CloudQuality } from '../../../runtime/sky/skySettings';
import { skyAtlas } from '../../../runtime/lighting/skyScene';
import {
    COPY_FRAGMENT, FULLSCREEN_VERTEX, MULTISCATTER_FRAGMENT, SKY_DOME_FRAGMENT, SKY_DOME_VERTEX, SKY_VIEW_FRAGMENT,
    TRANSMITTANCE_FRAGMENT,
} from './atmosphereShaders';
import {
    CLOUD_DETAIL_FRAGMENT, CLOUD_SHAPE_FRAGMENT, CLOUD_TRACE_FRAGMENT, CLOUD_WEATHER_FRAGMENT, SKY_VISIBILITY_BLUR_FRAGMENT, SKY_VISIBILITY_FRAGMENT,
} from './cloudShaders';

/**
 * Draws the sky: keeps the atmosphere's tables and the clouds' map up to date, owns the dome that shows
 * them, captures what the Sky Light sees, and works out how much sky each place around the camera can see.
 * One instance serves every view: the sky is the same in all of them.
 */

export interface SkyFrame {
    /** The frame's clock: a second view drawing the same frame changes nothing. */
    time: number;
    coefficients: AtmosphereCoefficients;
    sun: THREE.Vector3;
    moon: THREE.Vector3;
    /** The moon's light in the air, as a share of the sun's. */
    moonLight: number;
    /** The night air's own light, per unit of sunlight. */
    glow: [number, number, number];
    /** Camera height over the ground, km. */
    viewHeight: number;
    /** Light scale on the sky: sun's strength, colour and the sky's brightness. */
    skyScale: [number, number, number];
    /** And on the clouds, which do not take the sky's exposure: they are lit directly. */
    cloudScale: [number, number, number];
    /** How grey heavy cloud has made the air under it, 0-1. */
    skyGrey: number;
    sunRadiance: [number, number, number];
    /** The sun's angular radius, radians. */
    sunRadius: number;
    moonRadiance: [number, number, number];
    moonRadius: number;
    moonPhase: number;
    stars: number;
    milkyWay: number;
    /** Round the pole the stars turn on, radians. */
    starAngle: number;
    flash: number;
    clouds: {
        quality: CloudQuality;
        coverage: number;
        /** Cloud base and depth, km. */
        base: number;
        depth: number;
        density: number;
        detail: number;
        scale: number;
        /** Drift, km (x, z). */
        offsetX: number;
        offsetZ: number;
        key: THREE.Vector3;
        keyStrength: number;
        ambient: [number, number, number];
        groundAmbient: [number, number, number];
    };
    /** A sky with no volumetric clouds shows the weather in the Sky Light as this colour over this much of the sky. */
    flatCloud: [number, number, number];
    flatCover: number;
    panorama: THREE.Texture | null;
    panoramaTurn: number;
    panoramaScale: [number, number, number];
}

/** The clouds' weather map repeats this often per kilometre, at Cloud Size 1. */
export const WEATHER_TILES_PER_KM = 0.055;

const TRANSMITTANCE_SIZE: readonly [number, number] = [256, 64];
const MULTISCATTER_SIZE = 32;
const SKY_VIEW_SIZE: readonly [number, number] = [256, 128];
const SHAPE_SIZE = 64;
const DETAIL_SIZE = 32;
const WEATHER_SIZE = 512;
const OVERHEAD_SIZE = 1024;
/** The clouds' map's side and march steps, by quality. */
const CLOUD_MAPS: Record<'low' | 'medium' | 'high', { size: number; steps: number }> = {
    low: { size: 1024, steps: 32 },
    medium: { size: 1536, steps: 48 },
    high: { size: 2048, steps: 64 },
};
/** Blended over what was there, once settled: light each texel by several frames' worth of rays. */
const CLOUD_SETTLE_BLEND = 0.3;
/** A full pass over the map, in frames; each frame one of these tiles' texels. */
const CLOUD_PASS = 16;
/** Tile order, so a pass fills in evenly. */
const TILES = [0, 10, 2, 8, 5, 15, 7, 13, 1, 11, 3, 9, 4, 14, 6, 12];

const HALF_FLOAT_TARGET = (width: number, height: number): THREE.WebGLRenderTarget => new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
});

const noiseTarget = (size: number): THREE.WebGL3DRenderTarget => {
    const target = new THREE.WebGL3DRenderTarget(size, size, size, { depthBuffer: false, stencilBuffer: false });
    // A 3D target makes its own texture and leaves the options it was given out of it: these go on the texture.
    const { texture } = target;
    texture.format = THREE.RGBAFormat;
    texture.type = THREE.UnsignedByteType;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    // Three only makes mips for 2D and cube targets: prepareClouds makes these, once all the slices are drawn.
    texture.generateMipmaps = false;
    texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
    return target;
};

const passMaterial = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial => new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
    blending: THREE.NoBlending,
});

/** What belongs to one renderer: each canvas has its own GPU copy of the tables. */
interface RendererState {
    lastTime: number;
    atmosphereKey: string;
    skyViewKey: string;
    noiseReady: boolean;
    traceReady: boolean;
    traceCompiling: boolean;
    cloudSize: number;
    cloudKey: string;
    /** Frames before a change has been traced into the whole map. */
    cloudFresh: number;
    tile: number;
    pmrem: THREE.PMREMGenerator | null;
    environment: THREE.WebGLRenderTarget | null;
    /** The clock of the frame that last captured: views share a capture. */
    captureTime: number;
    /** The visibility map now in this renderer's atlas: its centre, side and height origin. */
    visibilityX: number;
    visibilityZ: number;
    visibilitySize: number;
    visibilityY: number;
    visibilityAge: number;
    /** The clock of the frame that last looked after it: the first view of a frame does, for all of them. */
    visibilityTime: number;
}

const _clear = new THREE.Color();
const _axis = new THREE.Vector3(0.2, 0.92, 0.33).normalize();
const _turn = new THREE.Matrix4();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _eye = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_FORWARD = new THREE.Vector3(0, 0, 1);

export class SkyRenderer {
    private readonly domeGeometry = new THREE.SphereGeometry(10, 32, 16);
    private readonly domeMaterial: THREE.ShaderMaterial;

    private readonly transmittance = HALF_FLOAT_TARGET(TRANSMITTANCE_SIZE[0], TRANSMITTANCE_SIZE[1]);
    private readonly multiScatter = HALF_FLOAT_TARGET(MULTISCATTER_SIZE, MULTISCATTER_SIZE);
    private readonly skyView = HALF_FLOAT_TARGET(SKY_VIEW_SIZE[0], SKY_VIEW_SIZE[1]);
    private readonly shape = noiseTarget(SHAPE_SIZE);
    private readonly detail = noiseTarget(DETAIL_SIZE);
    private readonly weather = new THREE.WebGLRenderTarget(WEATHER_SIZE, WEATHER_SIZE, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
        wrapS: THREE.RepeatWrapping,
        wrapT: THREE.RepeatWrapping,
    });
    private readonly clouds = HALF_FLOAT_TARGET(CLOUD_MAPS.medium.size, CLOUD_MAPS.medium.size);
    private readonly visibilityRaw = HALF_FLOAT_TARGET(512, 512);
    private readonly overhead = new THREE.WebGLRenderTarget(OVERHEAD_SIZE, OVERHEAD_SIZE, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: true,
        stencilBuffer: false,
        generateMipmaps: false,
        depthTexture: new THREE.DepthTexture(OVERHEAD_SIZE, OVERHEAD_SIZE, THREE.UnsignedIntType),
    });
    private cube: THREE.WebGLCubeRenderTarget | null = null;
    private cubeCamera: THREE.CubeCamera | null = null;

    private readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    private readonly passCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    private readonly overheadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1000);
    private readonly depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false });

    private readonly planet = { uPlanet: { value: new THREE.Vector2(GROUND_RADIUS, TOP_RADIUS) } };
    private readonly air = {
        ...this.planet,
        uRayleigh: { value: new THREE.Vector3() },
        uMieScatter: { value: new THREE.Vector3() },
        uMieAbsorb: { value: new THREE.Vector3() },
        uOzone: { value: new THREE.Vector3() },
        uGroundAlbedo: { value: new THREE.Vector3() },
        uMieG: { value: 0.8 },
    };
    private readonly transmittanceMaterial = passMaterial(TRANSMITTANCE_FRAGMENT, this.air);
    private readonly multiScatterMaterial = passMaterial(MULTISCATTER_FRAGMENT, { ...this.air, uTransmittance: { value: this.transmittance.texture } });
    private readonly viewRadius = { value: GROUND_RADIUS + 0.002 };
    private readonly skyViewMaterial = passMaterial(SKY_VIEW_FRAGMENT, {
        ...this.air,
        uTransmittance: { value: this.transmittance.texture },
        uMultiScatter: { value: this.multiScatter.texture },
        uViewRadius: this.viewRadius,
        uSun: { value: new THREE.Vector3(0, 1, 0) },
        uMoon: { value: new THREE.Vector3(0, -1, 0) },
        uMoonLight: { value: 0 },
        uGlow: { value: new THREE.Vector3() },
    });
    private readonly copyMaterial = passMaterial(COPY_FRAGMENT, { uSource: { value: null } });
    private readonly noiseSlice = { value: 0 };
    private readonly shapeMaterial = passMaterial(CLOUD_SHAPE_FRAGMENT, { uSlice: this.noiseSlice });
    private readonly detailMaterial = passMaterial(CLOUD_DETAIL_FRAGMENT, { uSlice: this.noiseSlice });
    private readonly weatherMaterial = passMaterial(CLOUD_WEATHER_FRAGMENT, {});
    private readonly traceMaterial: THREE.ShaderMaterial;
    private readonly visibilityMaterial = passMaterial(SKY_VISIBILITY_FRAGMENT, {
        uDepth: { value: this.overhead.depthTexture },
        uTop: { value: 0 },
        uDepthRange: { value: 1000 },
        uTexelMetres: { value: 1 },
        uSize: { value: 256 },
    });
    private readonly visibilityBlurMaterial = passMaterial(SKY_VISIBILITY_BLUR_FRAGMENT, { uRaw: { value: this.visibilityRaw.texture } });

    private readonly domeUniforms: Record<string, THREE.IUniform>;
    private readonly captureScene = new THREE.Scene();

    private states = new WeakMap<THREE.WebGLRenderer, RendererState>();
    private users = 0;

    constructor() {
        this.quad.frustumCulled = false;
        // Round the compass it joins up.
        this.skyView.texture.wrapS = THREE.RepeatWrapping;
        this.overheadCamera.up.set(0, 0, -1);
        this.overheadCamera.rotation.set(-Math.PI / 2, 0, 0);
        this.traceMaterial = passMaterial(CLOUD_TRACE_FRAGMENT, {
            ...this.planet,
            uShape: { value: this.shape.texture },
            uDetail: { value: this.detail.texture },
            uWeather: { value: this.weather.texture },
            uTransmittance: { value: this.transmittance.texture },
            uSkyView: { value: this.skyView.texture },
            uViewRadius: this.viewRadius,
            uKeyDirection: { value: new THREE.Vector3(0, 1, 0) },
            uKeyStrength: { value: 1 },
            uAmbient: { value: new THREE.Vector3() },
            uGroundAmbient: { value: new THREE.Vector3() },
            uCoverage: { value: 0 },
            uThreshold: { value: 1 },
            uEdge: { value: CLOUD_EDGE },
            uWeatherTiling: { value: WEATHER_TILES_PER_KM },
            uBase: { value: 1.5 },
            uDepth: { value: 2.2 },
            uDensity: { value: 1 },
            uDetailAmount: { value: 0.5 },
            uShapeScale: { value: 1 },
            uOffset: { value: new THREE.Vector3() },
            uSkyToCloud: { value: 1 },
            uSkyGrey: { value: 0 },
            uTile: { value: new THREE.Vector2() },
            uPhase: { value: 0 },
            uSteps: { value: 48 },
        });
        this.traceMaterial.blending = THREE.CustomBlending;
        this.traceMaterial.blendSrc = THREE.ConstantAlphaFactor;
        this.traceMaterial.blendDst = THREE.OneMinusConstantAlphaFactor;
        this.traceMaterial.blendAlpha = 1;

        this.domeUniforms = {
            ...this.planet,
            uViewRadius: this.viewRadius,
            uSkyView: { value: this.skyView.texture },
            uTransmittance: { value: this.transmittance.texture },
            uClouds: { value: this.clouds.texture },
            uPanorama: { value: null },
            uPanoramaOn: { value: 0 },
            uPanoramaTurn: { value: 0 },
            uPanoramaScale: { value: new THREE.Vector3(1, 1, 1) },
            uSkyScale: { value: new THREE.Vector3(1, 1, 1) },
            uSkyGrey: { value: 0 },
            uCloudsOn: { value: 0 },
            uCloudScale: { value: new THREE.Vector3(1, 1, 1) },
            uCloudTexel: { value: new THREE.Vector2(0.001, 0.001) },
            uFlash: { value: 0 },
            uFlatCloud: { value: new THREE.Vector3() },
            uFlatCover: { value: 0 },
            uLowerColor: { value: new THREE.Vector3() },
            uLowerSolid: { value: 0 },
            uSun: { value: new THREE.Vector3(0, 1, 0) },
            uSunRadiance: { value: new THREE.Vector3() },
            uSunEdge: { value: new THREE.Vector2(0.99999, 0.99999) },
            uMoon: { value: new THREE.Vector3(0, -1, 0) },
            uMoonRight: { value: new THREE.Vector3(1, 0, 0) },
            uMoonUp: { value: new THREE.Vector3(0, 0, 1) },
            uMoonSine: { value: 0.01 },
            uMoonRadiance: { value: new THREE.Vector3() },
            uMoonPhase: { value: 0.5 },
            uStars: { value: 0 },
            uMilkyWay: { value: 0 },
            uStarTurn: { value: new THREE.Matrix3() },
            uTime: { value: 0 },
        };
        this.domeMaterial = new THREE.ShaderMaterial({
            vertexShader: SKY_DOME_VERTEX,
            fragmentShader: SKY_DOME_FRAGMENT,
            uniforms: this.domeUniforms,
            side: THREE.DoubleSide,
            depthWrite: false,
            depthTest: true,
            fog: false,
        });

        const capture = new THREE.ShaderMaterial({
            vertexShader: SKY_DOME_VERTEX,
            fragmentShader: `#define SKY_CAPTURE\n${SKY_DOME_FRAGMENT}`,
            uniforms: this.domeUniforms,
            side: THREE.DoubleSide,
            depthWrite: false,
            depthTest: false,
            fog: false,
            toneMapped: false,
        });
        const box = new THREE.Mesh(new THREE.SphereGeometry(5, 16, 12), capture);
        box.frustumCulled = false;
        this.captureScene.add(box);
    }

    /** A dome for one view. Every view's shows the same sky. */
    createDome(): THREE.Mesh {
        const dome = new THREE.Mesh(this.domeGeometry, this.domeMaterial);
        dome.name = 'SkyDome';
        dome.frustumCulled = false;
        // Last of the opaque things, so only what the scene left uncovered is shaded.
        dome.renderOrder = 1000000;
        dome.userData.noWeather = true;
        return dome;
    }

    /** Someone will draw the sky. Returns what to call when they stop: the last one frees the GPU's copies. */
    acquire(): () => void {
        this.users += 1;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.users -= 1;
            if (this.users === 0) this.freeGpu();
        };
    }

    private freeGpu(): void {
        for (const target of [this.transmittance, this.multiScatter, this.skyView, this.shape, this.detail, this.weather, this.clouds, this.visibilityRaw, this.overhead, skyAtlas]) target.dispose();
        this.cube?.dispose();
        this.cube = null;
        this.cubeCamera = null;
        this.states = new WeakMap();
    }

    private stateFor(gl: THREE.WebGLRenderer): RendererState {
        let state = this.states.get(gl);
        if (!state) {
            state = {
                lastTime: -1, atmosphereKey: '', skyViewKey: '', noiseReady: false, traceReady: false, traceCompiling: false,
                cloudSize: 0, cloudKey: '', cloudFresh: 0, tile: 0, pmrem: null, environment: null, captureTime: -1,
                visibilityX: NaN, visibilityZ: NaN, visibilitySize: 0, visibilityY: 0, visibilityAge: Infinity, visibilityTime: -1,
            };
            this.states.set(gl, state);
            // A context that comes back has lost everything drawn on the GPU: start again.
            gl.domElement.addEventListener('webglcontextrestored', () => this.states.delete(gl), { once: true });
        }
        return state;
    }

    private draw(gl: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | THREE.WebGL3DRenderTarget, material: THREE.Material, layer?: number): void {
        this.quad.material = material;
        gl.setRenderTarget(target as THREE.WebGLRenderTarget, layer);
        gl.render(this.quad, this.passCamera);
    }

    private drawAtlas(gl: THREE.WebGLRenderer, material: THREE.Material, x: number, y: number, width: number, height: number): void {
        skyAtlas.viewport.set(x, y, width, height);
        skyAtlas.scissor.set(x, y, width, height);
        skyAtlas.scissorTest = true;
        this.draw(gl, skyAtlas, material);
    }

    /** Brings the tables and clouds up to `frame`. Call once a frame, before anything draws. */
    update(gl: THREE.WebGLRenderer, frame: SkyFrame): void {
        const state = this.stateFor(gl);
        const drawnAlready = state.lastTime === frame.time;
        this.setDomeUniforms(frame);
        if (drawnAlready) return;
        state.lastTime = frame.time;
        const target = gl.getRenderTarget();
        const autoClear = gl.autoClear;
        gl.autoClear = false;
        this.updateTables(gl, state, frame);
        this.updateClouds(gl, state, frame);
        gl.setRenderTarget(target);
        gl.autoClear = autoClear;
    }

    private updateTables(gl: THREE.WebGLRenderer, state: RendererState, frame: SkyFrame): void {
        const co = frame.coefficients;
        const key = JSON.stringify(co);
        const air = this.air;
        if (key !== state.atmosphereKey) {
            state.atmosphereKey = key;
            state.skyViewKey = '';
            air.uRayleigh.value.fromArray(co.rayleigh);
            air.uMieScatter.value.fromArray(co.mieScatter);
            air.uMieAbsorb.value.fromArray(co.mieAbsorb);
            air.uOzone.value.fromArray(co.ozone);
            air.uGroundAlbedo.value.fromArray(co.ground);
            air.uMieG.value = co.mieG;
            this.draw(gl, this.transmittance, this.transmittanceMaterial);
            this.draw(gl, this.multiScatter, this.multiScatterMaterial);
        }
        const radius = GROUND_RADIUS + Math.min(Math.max(frame.viewHeight, 0.002), TOP_RADIUS - GROUND_RADIUS - 0.01);
        const skyKey = [
            frame.sun.x, frame.sun.y, frame.sun.z, frame.moon.x, frame.moon.y, frame.moon.z,
            frame.moonLight, frame.glow[0], frame.glow[1], frame.glow[2], Math.round(radius * 2000),
        ].map(value => value.toFixed(4)).join();
        if (skyKey !== state.skyViewKey) {
            state.skyViewKey = skyKey;
            this.viewRadius.value = radius;
            const u = this.skyViewMaterial.uniforms;
            (u.uSun.value as THREE.Vector3).copy(frame.sun);
            (u.uMoon.value as THREE.Vector3).copy(frame.moon);
            u.uMoonLight.value = frame.moonLight;
            (u.uGlow.value as THREE.Vector3).fromArray(frame.glow);
            this.draw(gl, this.skyView, this.skyViewMaterial);
            this.copyMaterial.uniforms.uSource.value = this.skyView.texture;
            this.drawAtlas(gl, this.copyMaterial, 512, 0, SKY_VIEW_SIZE[0], SKY_VIEW_SIZE[1]);
        }
    }

    private makeMips(gl: THREE.WebGLRenderer, target: THREE.WebGL3DRenderTarget): void {
        const context = gl.getContext() as WebGL2RenderingContext;
        const texture = gl.properties.get(target.texture) as { __webglTexture?: WebGLTexture };
        if (!texture.__webglTexture) return;
        gl.state.bindTexture(context.TEXTURE_3D, texture.__webglTexture);
        context.generateMipmap(context.TEXTURE_3D);
        gl.state.unbindTexture();
    }

    private prepareClouds(gl: THREE.WebGLRenderer, state: RendererState): boolean {
        if (!state.noiseReady) {
            state.noiseReady = true;
            for (let slice = 0; slice < SHAPE_SIZE; slice++) {
                this.noiseSlice.value = (slice + 0.5) / SHAPE_SIZE;
                this.draw(gl, this.shape, this.shapeMaterial, slice);
            }
            for (let slice = 0; slice < DETAIL_SIZE; slice++) {
                this.noiseSlice.value = (slice + 0.5) / DETAIL_SIZE;
                this.draw(gl, this.detail, this.detailMaterial, slice);
            }
            this.makeMips(gl, this.shape);
            this.makeMips(gl, this.detail);
            this.draw(gl, this.weather, this.weatherMaterial);
            this.copyMaterial.uniforms.uSource.value = this.weather.texture;
            this.drawAtlas(gl, this.copyMaterial, 512, 256, 256, 256);
        }
        if (state.traceReady) return true;
        if (!state.traceCompiling) {
            // A big shader: compiled in the background where the browser can, so the editor does not stall on it.
            state.traceCompiling = true;
            const mesh = new THREE.Mesh(this.quad.geometry, this.traceMaterial);
            mesh.frustumCulled = false;
            const scene = new THREE.Scene();
            scene.add(mesh);
            // Compiled for the target it draws to, so drawing finds this same program.
            gl.setRenderTarget(this.clouds);
            const ready = () => { state.traceReady = true; };
            void gl.compileAsync(scene, this.passCamera).then(ready, ready);
        }
        return false;
    }

    private updateClouds(gl: THREE.WebGLRenderer, state: RendererState, frame: SkyFrame): void {
        const clouds = frame.clouds;
        const volumetric = clouds.quality === 'low' || clouds.quality === 'medium' || clouds.quality === 'high';
        const showing = volumetric && clouds.coverage > 0.005 && state.traceReady;
        this.domeUniforms.uCloudsOn.value = showing ? 1 : 0;
        if (!volumetric || clouds.coverage <= 0.005) {
            state.cloudKey = '';
            return;
        }
        if (!this.prepareClouds(gl, state)) return;

        const map = CLOUD_MAPS[clouds.quality as 'low' | 'medium' | 'high'];
        if (state.cloudSize !== map.size || this.clouds.width !== map.size) {
            state.cloudSize = map.size;
            this.clouds.setSize(map.size, map.size);
            state.cloudKey = '';
        }
        const key = [clouds.coverage.toFixed(3), clouds.base, clouds.depth, clouds.density, clouds.detail, clouds.scale, clouds.quality].join();
        if (key !== state.cloudKey) {
            if (state.cloudKey === '') {
                const clearColor = gl.getClearColor(_clear);
                const clearAlpha = gl.getClearAlpha();
                gl.setRenderTarget(this.clouds);
                gl.setClearColor(0x000000, 1);
                gl.clear(true, false, false);
                gl.setClearColor(clearColor, clearAlpha);
            }
            state.cloudKey = key;
            state.cloudFresh = CLOUD_PASS;
        }

        const u = this.traceMaterial.uniforms;
        (u.uKeyDirection.value as THREE.Vector3).copy(clouds.key);
        u.uKeyStrength.value = clouds.keyStrength;
        (u.uAmbient.value as THREE.Vector3).fromArray(clouds.ambient);
        (u.uGroundAmbient.value as THREE.Vector3).fromArray(clouds.groundAmbient);
        u.uCoverage.value = clouds.coverage;
        u.uThreshold.value = cloudThreshold(clouds.coverage);
        u.uWeatherTiling.value = WEATHER_TILES_PER_KM;
        u.uBase.value = clouds.base;
        u.uDepth.value = clouds.depth;
        u.uDensity.value = clouds.density;
        u.uDetailAmount.value = clouds.detail;
        u.uShapeScale.value = clouds.scale;
        (u.uOffset.value as THREE.Vector3).set(clouds.offsetX, 0, clouds.offsetZ);
        u.uSkyToCloud.value = frame.skyScale[1] / Math.max(frame.cloudScale[1], 1e-6);
        u.uSkyGrey.value = frame.skyGrey;
        u.uSteps.value = map.steps;
        const tile = TILES[state.tile % TILES.length];
        (u.uTile.value as THREE.Vector2).set(tile & 3, tile >> 2);
        // Every tile of a pass shares its noise: a phase per frame would leave the tiles different, as a fine grid.
        u.uPhase.value = (Math.floor(state.tile / TILES.length) % 64) * 0.61803398875;
        state.tile += 1;
        this.traceMaterial.blendAlpha = state.cloudFresh > 0 ? 1 : CLOUD_SETTLE_BLEND;
        if (state.cloudFresh > 0) state.cloudFresh -= 1;
        this.draw(gl, this.clouds, this.traceMaterial);
    }

    private setDomeUniforms(frame: SkyFrame): void {
        const u = this.domeUniforms;
        (u.uSkyScale.value as THREE.Vector3).fromArray(frame.skyScale);
        (u.uCloudScale.value as THREE.Vector3).fromArray(frame.cloudScale);
        u.uSkyGrey.value = frame.skyGrey;
        (u.uCloudTexel.value as THREE.Vector2).setScalar(1 / this.clouds.width);
        (u.uSun.value as THREE.Vector3).copy(frame.sun);
        (u.uSunRadiance.value as THREE.Vector3).fromArray(frame.sunRadiance);
        (u.uSunEdge.value as THREE.Vector2).set(Math.cos(frame.sunRadius * 1.05), Math.cos(frame.sunRadius * 0.93));
        (u.uMoon.value as THREE.Vector3).copy(frame.moon);
        _right.crossVectors(Math.abs(frame.moon.y) > 0.99 ? WORLD_FORWARD : WORLD_UP, frame.moon).normalize();
        _up.crossVectors(frame.moon, _right);
        (u.uMoonRight.value as THREE.Vector3).copy(_right);
        (u.uMoonUp.value as THREE.Vector3).copy(_up);
        u.uMoonSine.value = Math.sin(frame.moonRadius);
        (u.uMoonRadiance.value as THREE.Vector3).fromArray(frame.moonRadiance);
        u.uMoonPhase.value = frame.moonPhase;
        u.uStars.value = frame.stars;
        u.uMilkyWay.value = frame.milkyWay;
        (u.uStarTurn.value as THREE.Matrix3).setFromMatrix4(_turn.makeRotationAxis(_axis, frame.starAngle));
        u.uTime.value = frame.time;
        u.uFlash.value = frame.flash;
        (u.uFlatCloud.value as THREE.Vector3).fromArray(frame.flatCloud);
        u.uFlatCover.value = frame.flatCover;
        u.uPanorama.value = frame.panorama;
        u.uPanoramaOn.value = frame.panorama ? 1 : 0;
        u.uPanoramaTurn.value = frame.panoramaTurn;
        (u.uPanoramaScale.value as THREE.Vector3).fromArray(frame.panoramaScale);
    }

    /**
     * Captures the sky as the Sky Light sees it, and prefilters it for materials of every roughness. Returns
     * the map for `scene.environment`, which stays the same texture from capture to capture.
     */
    captureSkyLight(gl: THREE.WebGLRenderer, time: number, resolution: number, lowerSolid: boolean, lower: [number, number, number], tint: [number, number, number], image: THREE.Texture | null): THREE.Texture {
        const state = this.stateFor(gl);
        if (state.captureTime === time && state.environment && this.cube?.width === resolution) return state.environment.texture;
        state.captureTime = time;
        if (!this.cube || this.cube.width !== resolution) {
            this.cube?.dispose();
            this.cube = new THREE.WebGLCubeRenderTarget(resolution, {
                type: THREE.HalfFloatType,
                format: THREE.RGBAFormat,
                minFilter: THREE.LinearFilter,
                magFilter: THREE.LinearFilter,
                depthBuffer: false,
                stencilBuffer: false,
                generateMipmaps: false,
            });
            this.cubeCamera = new THREE.CubeCamera(0.1, 10, this.cube);
            state.environment?.dispose();
            state.environment = null;
        }
        const u = this.domeUniforms;
        // The tint on all the light that makes up the capture, put back after.
        const tinted = [u.uSkyScale, u.uPanoramaScale, u.uCloudScale, u.uFlatCloud].map(uniform => uniform.value as THREE.Vector3);
        const untinted = tinted.map(value => value.clone());
        for (const value of tinted) value.set(value.x * tint[0], value.y * tint[1], value.z * tint[2]);
        (u.uLowerColor.value as THREE.Vector3).fromArray(lower);
        u.uLowerSolid.value = lowerSolid ? 1 : 0;
        const panorama = u.uPanorama.value;
        const panoramaOn = u.uPanoramaOn.value;
        const cloudsOn = u.uCloudsOn.value;
        const flatCover = u.uFlatCover.value;
        if (image) {
            // The image alone: the sky's own clouds are not in it.
            u.uPanorama.value = image;
            u.uPanoramaOn.value = 1;
            u.uCloudsOn.value = 0;
            u.uFlatCover.value = 0;
        }
        this.cubeCamera!.update(gl, this.captureScene);
        u.uPanorama.value = panorama;
        u.uPanoramaOn.value = panoramaOn;
        u.uCloudsOn.value = cloudsOn;
        u.uFlatCover.value = flatCover;
        tinted.forEach((value, index) => value.copy(untinted[index]));
        u.uLowerSolid.value = 0;

        state.pmrem ??= new THREE.PMREMGenerator(gl);
        state.environment = state.pmrem.fromCubemap(this.cube.texture, state.environment);
        return state.environment.texture;
    }

    /** The sky as it stands onto `onto`, for whatever needs it as a picture, with or without a Sky Light. */
    drawSkyOnto(gl: THREE.WebGLRenderer, onto: THREE.WebGLCubeRenderTarget): void {
        new THREE.CubeCamera(0.1, 10, onto).update(gl, this.captureScene);
    }

    /** Whether `gl` holds a capture: none at first, after a release and after its context came back. */
    hasSkyLight(gl: THREE.WebGLRenderer): boolean {
        return !!this.states.get(gl)?.environment;
    }

    /** Whether `gl` can draw volumetric clouds yet: their big shader compiles in the background. */
    cloudsReady(gl: THREE.WebGLRenderer): boolean {
        return !!this.states.get(gl)?.traceReady;
    }

    /**
     * Frees what the Sky Light captured for `gl`; a capture afterwards makes it again.
     */
    releaseSkyLight(gl: THREE.WebGLRenderer): void {
        const state = this.states.get(gl);
        if (!state) return;
        state.environment?.dispose();
        state.environment = null;
        state.pmrem?.dispose();
        state.pmrem = null;
    }

    /**
     * Keeps the sky visibility map around `camera` current: it looks straight down at what casts shadows
     * and works out how much sky each place sees. It follows the camera in steps, and looks again every so
     * often for what has moved. Returns the map's corner, side and height origin.
     */
    updateVisibility(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, halfSide: number, dt: number, time: number, out: { x: number; z: number; size: number; y: number }): void {
        const state = this.stateFor(gl);
        // The first view of a frame looks after the map, and all the views read it: there is one, in the atlas.
        if (state.visibilityTime !== time) {
            state.visibilityTime = time;
            const stride = (halfSide * 2) / 16;
            const eye = camera.getWorldPosition(_eye);
            const x = Math.round(eye.x / stride) * stride;
            const z = Math.round(eye.z / stride) * stride;
            const size = halfSide * 2;
            state.visibilityAge += dt;
            if (x !== state.visibilityX || z !== state.visibilityZ || size !== state.visibilitySize || state.visibilityAge > 1.5) {
                state.visibilityAge = 0;
                state.visibilityX = x;
                state.visibilityZ = z;
                state.visibilitySize = size;
                state.visibilityY = Math.round(eye.y);
                this.drawVisibility(gl, scene, x, z, halfSide, state.visibilityY);
            }
        }
        out.x = state.visibilityX - state.visibilitySize / 2;
        out.z = state.visibilityZ - state.visibilitySize / 2;
        out.size = state.visibilitySize;
        out.y = state.visibilityY;
    }

    private drawVisibility(gl: THREE.WebGLRenderer, scene: THREE.Scene, x: number, z: number, halfSide: number, originY: number): void {
        const camera = this.overheadCamera;
        const top = originY + 500;
        camera.left = camera.bottom = -halfSide;
        camera.right = camera.top = halfSide;
        camera.position.set(x, top, z);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();

        // Only what takes part in shadows counts: not the dome, the clouds, helpers or anything else that lets light by.
        const hidden: THREE.Object3D[] = [];
        scene.traverseVisible(object => {
            const drawn = (object as THREE.Mesh).isMesh || (object as THREE.Points).isPoints || (object as THREE.Line).isLine || (object as THREE.Sprite).isSprite;
            if (drawn && !object.castShadow && !object.receiveShadow) hidden.push(object);
        });
        for (const object of hidden) object.visible = false;
        const override = scene.overrideMaterial;
        const background = scene.background;
        const shadows = gl.shadowMap.autoUpdate;
        const target = gl.getRenderTarget();
        const autoClear = gl.autoClear;
        scene.overrideMaterial = this.depthOnly;
        scene.background = null;
        gl.shadowMap.autoUpdate = false;
        gl.autoClear = true;
        gl.setRenderTarget(this.overhead);
        gl.render(scene, camera);
        gl.autoClear = false;
        scene.overrideMaterial = override;
        scene.background = background;
        gl.shadowMap.autoUpdate = shadows;
        for (const object of hidden) object.visible = true;

        const u = this.visibilityMaterial.uniforms;
        u.uTop.value = top - originY;
        u.uDepthRange.value = camera.far - camera.near;
        u.uSize.value = halfSide * 2;
        u.uTexelMetres.value = (halfSide * 2) / 512;
        this.draw(gl, this.visibilityRaw, this.visibilityMaterial);
        this.drawAtlas(gl, this.visibilityBlurMaterial, 0, 0, 512, 512);
        gl.setRenderTarget(target);
        gl.autoClear = autoClear;
    }
}

export const skyRenderer = new SkyRenderer();
