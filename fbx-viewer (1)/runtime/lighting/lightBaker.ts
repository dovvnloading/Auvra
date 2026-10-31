import * as THREE from 'three';
import { pauseSceneGi } from './dynamicGi/giMaterials';
import { pauseSceneSky } from './skyScene';
import {
    fillInvalidProbes,
    isStaticLightingLight,
    isStaticLightingMesh,
    planProbeGrid,
    probePosition,
    setSceneLightVolume,
    SH_FLOATS_PER_PROBE,
    type LightVolume,
    type ProbeGrid,
} from './bakedLighting';

/**
 * THE LIGHT BAKER
 *
 * Bakes a level's light probes (see bakedLighting.ts) in the scene the editor draws, a few probes
 * a frame. At each probe a small cube camera sees the level's static geometry, lit by the scene's
 * lights, against a sky that gives the same fill as the scene's ambient, hemisphere and
 * environment light; the picture is reduced to spherical harmonics. The first bounce lights the
 * geometry with the unoccluded sky fill; each further bounce lights it with the bounce before, so
 * light reaching an enclosed room is what came in through its openings. Before that, a pass that
 * tells front faces from back faces finds the probes buried inside geometry; they take their
 * neighbours' light instead of the dark they see.
 */

/** Side of each cube face the probes see, in pixels. */
const CAPTURE_SIZE = 16;
const CAPTURE_NEAR = 0.05;
const CAPTURE_FAR = 5000;
const SKY_RADIUS = 4000;
/** A probe that sees more back faces than this share of the geometry around it is inside geometry. */
const INSIDE_BACK_FACE_SHARE = 0.25;
/** Probes captured before their results are read back, and at most captured in one step. */
const BATCH = 64;
/** Pixels each probe's result takes in the read-back strip: one per spherical harmonics band. */
const SLOT = 4;

export interface LightBakeOptions {
    /** Level objects that never move (see staticLightingObjectIds). */
    staticIds: ReadonlySet<string>;
    spacing: number;
    bounces: number;
    maxProbes?: number;
}

export interface LightBakeProgress {
    /** 0 to 1 over the whole bake. */
    fraction: number;
    /** 0 while finding probes inside geometry, then the bounce being baked. */
    bounce: number;
}

export interface LightBakeResult {
    grid: ProbeGrid;
    sh: Float32Array;
    /** Probes found inside geometry, which took their neighbours' light. */
    insideProbes: number;
}

const SKY_VERTEX = /* glsl */`
varying vec3 vDirection;
void main() {
	vDirection = position;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const SKY_FRAGMENT = /* glsl */`
uniform vec3 constantRadiance;
uniform vec3 upRadiance;
varying vec3 vDirection;
void main() {
	gl_FragColor = vec4( max( constantRadiance + upRadiance * normalize( vDirection ).y, 0.0 ), 1.0 );
}
`;

const FACE_VERTEX = /* glsl */`
#include <common>
#include <batching_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
void main() {
	#include <batching_vertex>
	#include <skinbase_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <project_vertex>
}
`;

/** Red where a front face is seen, green where a back face is; the clear colour (blue) is open sky. */
const faceMaterial = (side: THREE.Side): THREE.ShaderMaterial => new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: FACE_VERTEX,
    fragmentShader: side === THREE.FrontSide
        ? 'void main() { gl_FragColor = gl_FrontFacing ? vec4( 1.0, 0.0, 0.0, 1.0 ) : vec4( 0.0, 1.0, 0.0, 1.0 ); }'
        : 'void main() { gl_FragColor = vec4( 1.0, 0.0, 0.0, 1.0 ); }',
});

const REDUCE_VERTEX = /* glsl */`
void main() {
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

/**
 * Reduces a probe's cube map to its slot of the read-back strip. Light: the first-order spherical
 * harmonics of what it sees, one band per pixel, each texel weighted by its solid angle (as three's
 * LightProbeGenerator does on the CPU). Faces: in the first pixel, how many texels show a front
 * face (red) and how many a back face (green).
 */
const REDUCE_FRAGMENT = /* glsl */`
uniform samplerCube cube;
uniform float slot;
uniform float faces;
const int SIZE = ${CAPTURE_SIZE};
const float PI = 3.141592653589793;
vec3 texelDirection( const in int face, const in vec2 uv ) {
	if ( face == 0 ) return vec3( 1.0, - uv.y, - uv.x );
	if ( face == 1 ) return vec3( - 1.0, - uv.y, uv.x );
	if ( face == 2 ) return vec3( uv.x, 1.0, uv.y );
	if ( face == 3 ) return vec3( uv.x, - 1.0, - uv.y );
	if ( face == 4 ) return vec3( uv.x, - uv.y, 1.0 );
	return vec3( - uv.x, - uv.y, - 1.0 );
}
void main() {
	int band = int( gl_FragCoord.x - slot );
	vec3 sum = vec3( 0.0 );
	float total = 0.0;
	float front = 0.0;
	float back = 0.0;
	for ( int face = 0; face < 6; face ++ ) {
		for ( int j = 0; j < SIZE; j ++ ) {
			for ( int i = 0; i < SIZE; i ++ ) {
				vec3 direction = texelDirection( face, ( vec2( float( i ), float( j ) ) + 0.5 ) / float( SIZE ) * 2.0 - 1.0 );
				float lengthSq = dot( direction, direction );
				direction = normalize( direction );
				vec3 seen = textureCube( cube, direction ).rgb;
				if ( faces > 0.5 ) {
					float isFront = step( 0.5, seen.r );
					front += isFront;
					back += step( 0.5, seen.g ) * ( 1.0 - isFront );
				} else {
					float weight = 4.0 / ( sqrt( lengthSq ) * lengthSq );
					float basis = band == 0 ? 0.282095 : 0.488603 * ( band == 1 ? direction.y : band == 2 ? direction.z : direction.x );
					sum += seen * basis * weight;
					total += weight;
				}
			}
		}
	}
	gl_FragColor = faces > 0.5 ? vec4( front, back, 0.0, 1.0 ) : vec4( sum * ( 4.0 * PI / total ), 1.0 );
}
`;

const isRenderable = (object: THREE.Object3D): boolean => {
    const candidate = object as THREE.Object3D & { isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean };
    return Boolean(candidate.isMesh || candidate.isLine || candidate.isPoints || candidate.isSprite);
};

const effectivelyVisible = (object: THREE.Object3D): boolean => {
    for (let node: THREE.Object3D | null = object; node; node = node.parent) if (!node.visible) return false;
    return true;
};

/** Settings the bake changes on the scene and renderer for a step, put back after it. */
interface SceneState {
    hidden: THREE.Object3D[];
    background: THREE.Scene['background'];
    backgroundIntensity: number;
    backgroundBlurriness: number;
    backgroundRotation: THREE.Euler;
    fog: THREE.Scene['fog'];
    shadowAutoUpdate: boolean;
    shadows: Array<{ light: THREE.DirectionalLight; position: THREE.Vector3; target: THREE.Vector3; camera: [number, number, number, number, number, number] }>;
}

export class LightBaker {
    readonly grid: ProbeGrid;
    private readonly probes: number;
    private readonly sh: Float32Array;
    private readonly inside: Uint8Array;
    private readonly bounds = new THREE.Box3();
    private readonly statics: THREE.Mesh[] = [];
    private readonly target = new THREE.WebGLCubeRenderTarget(CAPTURE_SIZE, { type: THREE.HalfFloatType, generateMipmaps: false });
    private readonly camera = new THREE.CubeCamera(CAPTURE_NEAR, CAPTURE_FAR, this.target);
    private readonly sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
    private resumeSky: (() => void) | null = null;
    private resumeGi: (() => void) | null = null;
    private readonly frontFaces = faceMaterial(THREE.FrontSide);
    private readonly anyFaces = faceMaterial(THREE.DoubleSide);
    /** Each captured probe's result, SLOT pixels apiece, read back a batch at a time. */
    private readonly strip = new THREE.WebGLRenderTarget(BATCH * SLOT, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    private readonly reducer = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
        vertexShader: REDUCE_VERTEX,
        fragmentShader: REDUCE_FRAGMENT,
        uniforms: { cube: { value: this.target.texture }, slot: { value: 0 }, faces: { value: 0 } },
        depthTest: false,
        depthWrite: false,
    }));
    private readonly reducerCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    private readonly pixels = new Uint16Array(BATCH * SLOT * 4);
    /** The probes in the strip, by slot. */
    private readonly pending: number[] = [];
    /** Probes done in the current pass; passes are the inside test, then each bounce. */
    private next = 0;
    private bounce = 0;
    private finished = false;
    /** Takes back the volume the geometry is lit by: none for the first bounce, then the last bounce. */
    private release: (() => void) | null;

    constructor(
        private readonly renderer: THREE.WebGLRenderer,
        private readonly scene: THREE.Scene,
        private readonly options: LightBakeOptions,
    ) {
        scene.updateMatrixWorld(true);
        scene.traverse((object) => {
            if (isStaticLightingMesh(object, options.staticIds) && effectivelyVisible(object)) {
                this.statics.push(object);
                this.bounds.expandByObject(object);
            }
        });
        if (!this.statics.length) throw new Error('The level has no static geometry to bake.');
        // Light Bake Volumes, where there are any, say where the probes go.
        const volumes = new THREE.Box3();
        scene.traverse((object) => {
            if (object.userData?.lightBakeVolume === true && effectivelyVisible(object)) volumes.expandByObject(object);
        });
        this.grid = planProbeGrid(volumes.isEmpty() ? this.bounds : volumes, options.spacing, options.maxProbes);
        this.probes = this.grid.counts[0] * this.grid.counts[1] * this.grid.counts[2];
        this.sh = new Float32Array(this.probes * SH_FLOATS_PER_PROBE);
        this.inside = new Uint8Array(this.probes);
        this.sky = new THREE.Mesh(
            new THREE.SphereGeometry(SKY_RADIUS, 32, 16),
            new THREE.ShaderMaterial({
                vertexShader: SKY_VERTEX,
                fragmentShader: SKY_FRAGMENT,
                uniforms: { constantRadiance: { value: new THREE.Vector3() }, upRadiance: { value: new THREE.Vector3() } },
                side: THREE.BackSide,
                transparent: true,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
            }),
        );
        this.sky.frustumCulled = false;
        this.sky.renderOrder = -1;
        this.release = setSceneLightVolume(scene, null);
    }

    get done(): boolean {
        return this.finished;
    }

    get progress(): LightBakeProgress {
        const passes = this.options.bounces + 1;
        return { fraction: Math.min(1, (this.bounce * this.probes + this.next) / (passes * this.probes)), bounce: this.bounce };
    }

    /** Bakes probes for about `budgetMs` (at most a batch); returns true once the bake is finished. */
    step(budgetMs: number): boolean {
        if (this.finished) return true;
        const start = performance.now();
        const state = this.prepare();
        let showLight = this.bounce === 0 ? this.showFaces() : null;
        try {
            for (let captured = 0; captured < BATCH && performance.now() - start < budgetMs && !this.finished; captured++) {
                this.capture(this.next);
                this.next++;
                if (this.pending.length === BATCH) this.flush();
                if (this.next < this.probes) continue;
                this.flush();
                this.next = 0;
                if (this.bounce > 0) this.keepBounce();
                else {
                    showLight?.();
                    showLight = null;
                }
                this.bounce++;
                if (this.bounce > this.options.bounces) this.finished = true;
            }
            this.flush();
        } finally {
            showLight?.();
            this.restore(state);
        }
        return this.finished;
    }

    /** The baked probes; the bake must be finished. */
    result(): LightBakeResult {
        if (!this.finished) throw new Error('The light bake is not finished.');
        return { grid: this.grid, sh: this.sh.slice(), insideProbes: this.inside.reduce((count, value) => count + value, 0) };
    }

    dispose(): void {
        this.release?.();
        this.release = null;
        this.target.dispose();
        this.sky.geometry.dispose();
        this.sky.material.dispose();
        this.frontFaces.dispose();
        this.anyFaces.dispose();
        this.strip.dispose();
        this.reducer.geometry.dispose();
        this.reducer.material.dispose();
    }

    /**
     * Ends a bounce: probes inside geometry take their neighbours' light, and the bounce is kept
     * (a copy, while the next one is baked into `sh`) to light the geometry for the next. The
     * scene draws with it as it starts each capture (see installBakedLighting).
     */
    private keepBounce(): void {
        fillInvalidProbes(this.sh, this.inside.map(value => (value ? 0 : 1)), this.grid.counts);
        const volume: LightVolume = {
            origin: this.grid.origin.clone(),
            spacing: this.grid.spacing,
            counts: this.grid.counts,
            sh: this.sh.slice(),
            intensity: 1,
        };
        this.release?.();
        this.release = setSceneLightVolume(this.scene, volume);
    }

    private placeCamera(index: number): void {
        const [nx, ny] = this.grid.counts;
        probePosition(this.grid, index % nx, Math.floor(index / nx) % ny, Math.floor(index / (nx * ny)), this.camera.position);
        this.camera.updateMatrixWorld(true);
        this.sky.position.copy(this.camera.position);
        this.sky.updateMatrixWorld();
    }

    /** Captures a probe and reduces what it sees into its slot of the strip, without waiting on the GPU. */
    private capture(index: number): void {
        this.placeCamera(index);
        this.camera.update(this.renderer, this.scene);
        const x = this.pending.length * SLOT;
        const uniforms = this.reducer.material.uniforms;
        uniforms.slot.value = x;
        uniforms.faces.value = this.bounce === 0 ? 1 : 0;
        this.strip.viewport.set(x, 0, SLOT, 1);
        this.strip.scissor.set(x, 0, SLOT, 1);
        this.strip.scissorTest = true;
        const previous = this.renderer.getRenderTarget();
        this.renderer.setRenderTarget(this.strip);
        this.renderer.render(this.reducer, this.reducerCamera);
        this.renderer.setRenderTarget(previous);
        this.pending.push(index);
    }

    /** Reads the strip back and stores each pending probe's result. */
    private flush(): void {
        const count = this.pending.length;
        if (!count) return;
        this.renderer.readRenderTargetPixels(this.strip, 0, 0, count * SLOT, 1, this.pixels);
        const half = THREE.DataUtils.fromHalfFloat;
        this.pending.forEach((probe, slot) => {
            const base = slot * SLOT * 4;
            if (this.bounce === 0) {
                const front = half(this.pixels[base]);
                const back = half(this.pixels[base + 1]);
                this.inside[probe] = back > 0 && back / (front + back) > INSIDE_BACK_FACE_SHARE ? 1 : 0;
                return;
            }
            for (let band = 0; band < SLOT; band++) {
                for (let channel = 0; channel < 3; channel++) {
                    this.sh[probe * SH_FLOATS_PER_PROBE + band * 3 + channel] = half(this.pixels[base + band * 4 + channel]);
                }
            }
        });
        this.pending.length = 0;
    }

    /** Draws the static geometry as front (red) and back (green) faces on blue, for the inside test; returns the undo. */
    private showFaces(): () => void {
        const swapped = this.statics.map(mesh => {
            const material = mesh.material;
            const face = (m: THREE.Material) => (m.side === THREE.FrontSide ? this.frontFaces : this.anyFaces);
            mesh.material = Array.isArray(material) ? material.map(face) : face(material);
            return [mesh, material] as const;
        });
        const clearColor = this.renderer.getClearColor(new THREE.Color());
        const clearAlpha = this.renderer.getClearAlpha();
        const background = this.scene.background;
        this.sky.visible = false;
        this.scene.background = null;
        this.renderer.setClearColor(0x0000ff, 1);
        return () => {
            for (const [mesh, material] of swapped) mesh.material = material;
            this.renderer.setClearColor(clearColor, clearAlpha);
            this.scene.background = background;
            this.sky.visible = true;
        };
    }

    /** Shows only static geometry and its lights, under the bake sky, with shadows over the whole level. */
    private prepare(): SceneState {
        const scene = this.scene;
        const keep = new Set<THREE.Object3D>(this.statics);
        const hidden: THREE.Object3D[] = [];
        const constant = new THREE.Vector3();
        const up = new THREE.Vector3();
        const color = new THREE.Vector3();
        const shadows: SceneState['shadows'] = [];
        scene.traverse((object) => {
            if (!object.visible) return;
            const light = object as THREE.Light;
            if (light.isLight) {
                if (!isStaticLightingLight(light, this.options.staticIds)) {
                    object.visible = false;
                    hidden.push(object);
                    return;
                }
                const hemisphere = object as THREE.HemisphereLight;
                if (hemisphere.isHemisphereLight) {
                    // Radiance a + b*y lights a surface like three's hemisphere light: irradiance (s+g)/2 + (s-g)/2 n.y.
                    const sky = color.set(hemisphere.color.r, hemisphere.color.g, hemisphere.color.b).multiplyScalar(hemisphere.intensity).clone();
                    const ground = color.set(hemisphere.groundColor.r, hemisphere.groundColor.g, hemisphere.groundColor.b).multiplyScalar(hemisphere.intensity).clone();
                    constant.add(sky.clone().add(ground).multiplyScalar(1 / (2 * Math.PI)));
                    up.add(sky.sub(ground).multiplyScalar(3 / (4 * Math.PI)));
                } else if ((object as THREE.AmbientLight).isAmbientLight) {
                    constant.add(color.set(light.color.r, light.color.g, light.color.b).multiplyScalar(light.intensity / Math.PI));
                } else if ((object as THREE.DirectionalLight).isDirectionalLight && light.castShadow) {
                    shadows.push(this.fitShadow(object as THREE.DirectionalLight));
                }
                return;
            }
            if (isRenderable(object) && !keep.has(object)) {
                object.visible = false;
                hidden.push(object);
            }
        });
        this.sky.material.uniforms.constantRadiance.value.copy(constant);
        this.sky.material.uniforms.upRadiance.value.copy(up);
        scene.add(this.sky);
        const state: SceneState = {
            hidden,
            background: scene.background,
            backgroundIntensity: scene.backgroundIntensity,
            backgroundBlurriness: scene.backgroundBlurriness,
            backgroundRotation: scene.backgroundRotation.clone(),
            fog: scene.fog,
            shadowAutoUpdate: this.renderer.shadowMap.autoUpdate,
            shadows,
        };
        this.resumeSky = pauseSceneSky(scene);
        this.resumeGi = pauseSceneGi(scene);
        // The environment map's light, as the sky the probes see.
        scene.background = scene.environment;
        scene.backgroundIntensity = scene.environmentIntensity ?? 1;
        scene.backgroundBlurriness = 0;
        scene.backgroundRotation.copy(scene.environmentRotation);
        scene.fog = null;
        // The shadow maps fitted to the level are drawn once and reused by every probe.
        this.renderer.shadowMap.autoUpdate = false;
        this.renderer.shadowMap.needsUpdate = true;
        return state;
    }

    private fitShadow(light: THREE.DirectionalLight): SceneState['shadows'][number] {
        const camera = light.shadow.camera;
        const saved = {
            light,
            position: light.position.clone(),
            target: light.target.position.clone(),
            camera: [camera.left, camera.right, camera.top, camera.bottom, camera.near, camera.far] as [number, number, number, number, number, number],
        };
        const sphere = this.bounds.getBoundingSphere(new THREE.Sphere());
        const direction = light.position.clone().sub(light.target.position);
        if (direction.lengthSq() < 1e-8) direction.set(0, 1, 0);
        direction.normalize();
        light.target.position.copy(sphere.center);
        light.target.updateMatrixWorld();
        light.position.copy(sphere.center).addScaledVector(direction, sphere.radius * 2 + 10);
        light.updateMatrixWorld();
        camera.left = camera.bottom = -sphere.radius;
        camera.right = camera.top = sphere.radius;
        camera.near = 0.1;
        camera.far = sphere.radius * 4 + 20;
        camera.updateProjectionMatrix();
        light.shadow.needsUpdate = true;
        return saved;
    }

    private restore(state: SceneState): void {
        const scene = this.scene;
        this.resumeSky?.();
        this.resumeSky = null;
        this.resumeGi?.();
        this.resumeGi = null;
        scene.remove(this.sky);
        for (const object of state.hidden) object.visible = true;
        scene.background = state.background;
        scene.backgroundIntensity = state.backgroundIntensity;
        scene.backgroundBlurriness = state.backgroundBlurriness;
        scene.backgroundRotation.copy(state.backgroundRotation);
        scene.fog = state.fog;
        for (const { light, position, target, camera } of state.shadows) {
            light.position.copy(position);
            light.target.position.copy(target);
            light.target.updateMatrixWorld();
            light.updateMatrixWorld();
            const shadowCamera = light.shadow.camera;
            [shadowCamera.left, shadowCamera.right, shadowCamera.top, shadowCamera.bottom, shadowCamera.near, shadowCamera.far] = camera;
            shadowCamera.updateProjectionMatrix();
            light.shadow.needsUpdate = true;
        }
        this.renderer.shadowMap.autoUpdate = state.shadowAutoUpdate;
        this.renderer.shadowMap.needsUpdate = true;
    }
}
