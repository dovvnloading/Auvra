import * as THREE from 'three';
import { Effect, EffectAttribute, LookupTexture } from 'postprocessing';
import { skyLight } from './daylight';

/**
 * CINEMATIC SCREEN EFFECTS
 *
 * The camera's side of the picture, as postprocessing effects:
 *  - Auto exposure: the eye adapting, brighter in the dark and darker in glare, over a second or two.
 *    The scene's average brightness is measured on the GPU (a log-luminance image reduced to one
 *    pixel and eased toward each frame), so nothing is read back.
 *  - Motion blur: the camera's own motion, from each pixel's depth and the previous frame's view;
 *    what is close to the camera (the character it follows) is spared.
 *  - Light shafts: beams of sunlight through gaps in what stands against the sky, a radial blur of
 *    the sky's glare around the sun drawn at half size.
 *  - Sunlit haze: fog and mist glowing toward the sun, by how much fog lies along each pixel's ray.
 *  - White balance, and looks (colour grading lookup tables made here).
 */

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4( position.xy, 0.0, 1.0 );
}`;

/** One full-screen triangle drawn with a material into a render target. */
export class FullscreenPass {
    private readonly scene = new THREE.Scene();
    private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    readonly material: THREE.ShaderMaterial;

    constructor(fragmentShader: string, uniforms: Record<string, THREE.IUniform>) {
        this.material = new THREE.ShaderMaterial({
            vertexShader: FULLSCREEN_VERTEX, fragmentShader, uniforms,
            depthTest: false, depthWrite: false, toneMapped: false,
        });
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
        const mesh = new THREE.Mesh(geometry, this.material);
        mesh.frustumCulled = false;
        this.scene.add(mesh);
    }

    render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget): void {
        renderer.setRenderTarget(target);
        renderer.render(this.scene, this.camera);
    }

    dispose(): void {
        this.material.dispose();
        (this.scene.children[0] as THREE.Mesh).geometry.dispose();
    }
}

/** A half-float colour target for an effect's own passes. */
export const effectTarget = (width: number, height: number): THREE.WebGLRenderTarget =>
    new THREE.WebGLRenderTarget(width, height, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        depthBuffer: false, generateMipmaps: false,
    });

// ---------------------------------------------------------------------------
// Auto exposure

const LUMINANCE_SIZE = 64;

const LOG_LUMINANCE = /* glsl */ `
uniform sampler2D inputBuffer;
varying vec2 vUv;
void main() {
    // Four taps a cell, so small bright things are not missed between samples.
    vec2 o = vec2( 0.25 / ${LUMINANCE_SIZE}.0 );
    vec3 c = ( texture2D( inputBuffer, vUv + vec2( -o.x, -o.y ) ).rgb + texture2D( inputBuffer, vUv + vec2( o.x, -o.y ) ).rgb
             + texture2D( inputBuffer, vUv + vec2( -o.x, o.y ) ).rgb + texture2D( inputBuffer, vUv + vec2( o.x, o.y ) ).rgb ) * 0.25;
    float luminance = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
    // Centre-weighted metering: the middle of the view counts most.
    float weight = 1.0 - 0.7 * smoothstep( 0.1, 0.75, length( vUv - 0.5 ) * 1.4 );
    gl_FragColor = vec4( log( max( luminance, 1e-4 ) ) * weight, weight, 0.0, 1.0 );
}`;

const REDUCE = /* glsl */ `
uniform sampler2D source;
uniform float sourceSize;
varying vec2 vUv;
void main() {
    // Each output pixel sums the 4 x 4 source pixels under it.
    vec2 sum = vec2( 0.0 );
    vec2 base = floor( vUv * sourceSize / 4.0 ) * 4.0;
    for ( int y = 0; y < 4; y++ ) {
        for ( int x = 0; x < 4; x++ ) {
            sum += texture2D( source, ( base + vec2( float( x ), float( y ) ) + 0.5 ) / sourceSize ).rg;
        }
    }
    gl_FragColor = vec4( sum, 0.0, 1.0 );
}`;

const ADAPT = /* glsl */ `
uniform sampler2D measured;
uniform sampler2D previous;
uniform float deltaTime;
uniform float brighten;
uniform float darken;
uniform float first;
varying vec2 vUv;
void main() {
    vec2 m = texture2D( measured, vec2( 0.5 ) ).rg;
    float current = exp( m.x / max( m.y, 1e-4 ) );
    float before = first > 0.5 ? current : texture2D( previous, vec2( 0.5 ) ).r;
    // The eye takes longer to adjust to the dark than to glare.
    float rate = current > before ? darken : brighten;
    gl_FragColor = vec4( before + ( current - before ) * ( 1.0 - exp( -deltaTime * rate ) ), 0.0, 0.0, 1.0 );
}`;

const AUTO_EXPOSURE_EFFECT = /* glsl */ `
uniform sampler2D adapted;
uniform float reference;
uniform float response;
uniform float minExposure;
uniform float maxExposure;
uniform float compensation;
void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
    float average = max( texture2D( adapted, vec2( 0.5 ) ).r, 1e-4 );
    float exposure = clamp( pow( reference / average, response ), minExposure, maxExposure ) * compensation;
    outputColor = vec4( inputColor.rgb * exposure, inputColor.a );
}`;

export interface AutoExposureOptions {
    /** Average brightness that needs no change: the level's daylight look stays as authored. */
    reference?: number;
    /** 0-1: how fully it adapts (1 makes every scene the same average brightness). */
    response?: number;
    minExposure?: number;
    maxExposure?: number;
    /** Stops (EV) brighter or darker after adapting. */
    compensation?: number;
    /** How fast it adapts to glare and to the dark, per second. */
    brighten?: number;
    darken?: number;
}

/**
 * The average (log, centre-weighted) brightness of a clear midday scene as the default sky lights it:
 * there auto exposure leaves the picture as authored. Looking into a bright sky dims it a little (to 0.6
 * at most), dusk lifts gently, and night is lifted at most 2.5 times, so it stays night.
 */
export const AUTO_EXPOSURE_REFERENCE = 0.06;

export class AutoExposureEffect extends Effect {
    private readonly logPass: FullscreenPass;
    private readonly reducePass: FullscreenPass;
    private readonly adaptPass: FullscreenPass;
    private readonly targets: THREE.WebGLRenderTarget[];
    private adapted: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
    private first = true;

    constructor(options: AutoExposureOptions = {}) {
        super('AutoExposureEffect', AUTO_EXPOSURE_EFFECT, {
            uniforms: new Map<string, THREE.Uniform>([
                ['adapted', new THREE.Uniform(null)],
                ['reference', new THREE.Uniform(options.reference ?? AUTO_EXPOSURE_REFERENCE)],
                ['response', new THREE.Uniform(options.response ?? 0.5)],
                ['minExposure', new THREE.Uniform(options.minExposure ?? 0.6)],
                ['maxExposure', new THREE.Uniform(options.maxExposure ?? 2.5)],
                ['compensation', new THREE.Uniform(2 ** (options.compensation ?? 0))],
            ]),
        });
        this.logPass = new FullscreenPass(LOG_LUMINANCE, { inputBuffer: { value: null } });
        this.reducePass = new FullscreenPass(REDUCE, { source: { value: null }, sourceSize: { value: LUMINANCE_SIZE } });
        this.adaptPass = new FullscreenPass(ADAPT, {
            measured: { value: null }, previous: { value: null }, deltaTime: { value: 0 },
            brighten: { value: options.brighten ?? 3 }, darken: { value: options.darken ?? 1.2 }, first: { value: 1 },
        });
        this.targets = [effectTarget(LUMINANCE_SIZE, LUMINANCE_SIZE), effectTarget(16, 16), effectTarget(4, 4), effectTarget(1, 1)];
        for (const t of this.targets) t.texture.minFilter = t.texture.magFilter = THREE.NearestFilter;
        this.adapted = [effectTarget(1, 1), effectTarget(1, 1)];
    }

    set(options: AutoExposureOptions): void {
        const u = this.uniforms;
        if (options.reference !== undefined) u.get('reference')!.value = options.reference;
        if (options.response !== undefined) u.get('response')!.value = options.response;
        if (options.minExposure !== undefined) u.get('minExposure')!.value = options.minExposure;
        if (options.maxExposure !== undefined) u.get('maxExposure')!.value = options.maxExposure;
        if (options.compensation !== undefined) u.get('compensation')!.value = 2 ** options.compensation;
        if (options.brighten !== undefined) this.adaptPass.material.uniforms.brighten.value = options.brighten;
        if (options.darken !== undefined) this.adaptPass.material.uniforms.darken.value = options.darken;
    }

    override update(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget, deltaTime = 1 / 60): void {
        const before = renderer.getRenderTarget();
        this.logPass.material.uniforms.inputBuffer.value = inputBuffer.texture;
        this.logPass.render(renderer, this.targets[0]);
        let size = LUMINANCE_SIZE;
        for (let i = 1; i < this.targets.length; i++) {
            this.reducePass.material.uniforms.source.value = this.targets[i - 1].texture;
            this.reducePass.material.uniforms.sourceSize.value = size;
            this.reducePass.render(renderer, this.targets[i]);
            size /= 4;
        }
        const [read, write] = this.adapted;
        const adapt = this.adaptPass.material.uniforms;
        adapt.measured.value = this.targets[this.targets.length - 1].texture;
        adapt.previous.value = read.texture;
        adapt.deltaTime.value = Math.min(0.25, Math.max(0, deltaTime));
        adapt.first.value = this.first ? 1 : 0;
        this.adaptPass.render(renderer, write);
        this.adapted = [write, read];
        this.uniforms.get('adapted')!.value = write.texture;
        this.first = false;
        renderer.setRenderTarget(before);
    }

    /** Snaps to the scene's brightness at once (a cut, a new level) instead of easing to it. */
    snap(): void {
        this.first = true;
    }

    override dispose(): void {
        super.dispose();
        for (const t of [...this.targets, ...this.adapted]) t.dispose();
        this.logPass.dispose();
        this.reducePass.dispose();
        this.adaptPass.dispose();
    }
}

// ---------------------------------------------------------------------------
// Motion blur

// Each pixel's motion on screen since the last frame, from its depth and the camera's previous view, at
// half size. Reading depth here, into a target of its own, keeps the blur pass from sampling the depth
// texture attached to the buffer it may be drawing into.
const MOTION_VELOCITY = /* glsl */ `
uniform sampler2D depthBuffer;
uniform mat4 inverseProjection;
uniform mat4 cameraWorld;
uniform mat4 previousViewProjection;
uniform float strength;
varying vec2 vUv;
void main() {
    float d = min( texture2D( depthBuffer, vUv ).r, 0.99999 );
    vec4 view = inverseProjection * vec4( vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
    view /= view.w;
    vec4 before = previousViewProjection * ( cameraWorld * vec4( view.xyz, 1.0 ) );
    vec2 velocity = ( vUv - ( before.xy / before.w * 0.5 + 0.5 ) ) * strength;
    // What is close to the camera moves with it (the character it follows): spare it.
    velocity *= smoothstep( 2.0, 6.0, -view.z );
    float speed = length( velocity );
    velocity *= speed > 0.06 ? 0.06 / speed : 1.0;
    gl_FragColor = vec4( velocity, 0.0, 1.0 );
}`;

const MOTION_BLUR_EFFECT = /* glsl */ `
uniform sampler2D velocityBuffer;
uniform float active;
void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
    outputColor = inputColor;
    if ( active < 0.5 ) return;
    vec2 velocity = texture2D( velocityBuffer, uv ).xy;
    if ( length( velocity ) < 0.0005 ) return;
    float jitter = fract( sin( dot( uv * resolution, vec2( 12.9898, 78.233 ) ) + time ) * 43758.5453 );
    vec3 sum = inputColor.rgb;
    for ( int i = 1; i <= 8; i++ ) {
        float t = ( float( i ) + jitter ) / 8.0 - 0.5;
        sum += texture2D( inputBuffer, uv - velocity * t ).rgb;
    }
    outputColor = vec4( sum / 9.0, inputColor.a );
}`;

export class MotionBlurEffect extends Effect {
    private readonly camera: THREE.Camera;
    private readonly previous = new THREE.Matrix4();
    private readonly velocityPass: FullscreenPass;
    private readonly velocityTarget = effectTarget(1, 1);
    private depth: THREE.Texture | null = null;
    private placed = false;

    constructor(camera: THREE.Camera, strength = 0.5) {
        // DEPTH hands it the composer's depth texture; only the velocity pass reads it (mainImage takes no depth).
        super('MotionBlurEffect', MOTION_BLUR_EFFECT, {
            attributes: EffectAttribute.CONVOLUTION | EffectAttribute.DEPTH,
            uniforms: new Map<string, THREE.Uniform>([
                ['velocityBuffer', new THREE.Uniform(null)],
                ['active', new THREE.Uniform(0)],
            ]),
        });
        this.camera = camera;
        this.velocityPass = new FullscreenPass(MOTION_VELOCITY, {
            depthBuffer: { value: null },
            inverseProjection: { value: new THREE.Matrix4() },
            cameraWorld: { value: new THREE.Matrix4() },
            previousViewProjection: { value: new THREE.Matrix4() },
            strength: { value: strength },
        });
        this.uniforms.get('velocityBuffer')!.value = this.velocityTarget.texture;
    }

    set strength(value: number) {
        this.velocityPass.material.uniforms.strength.value = value;
    }

    override setDepthTexture(depthTexture: THREE.Texture): void {
        this.depth = depthTexture;
    }

    override setSize(width: number, height: number): void {
        this.velocityTarget.setSize(Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2)));
    }

    override update(renderer: THREE.WebGLRenderer): void {
        const camera = this.camera;
        camera.updateMatrixWorld();
        const u = this.velocityPass.material.uniforms;
        u.depthBuffer.value = this.depth;
        (u.inverseProjection.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
        (u.cameraWorld.value as THREE.Matrix4).copy(camera.matrixWorld);
        (u.previousViewProjection.value as THREE.Matrix4).copy(this.previous);
        const active = this.placed && this.depth !== null;
        this.uniforms.get('active')!.value = active ? 1 : 0;
        this.previous.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        this.placed = true;
        if (!active) return;
        const before = renderer.getRenderTarget();
        this.velocityPass.render(renderer, this.velocityTarget);
        renderer.setRenderTarget(before);
    }

    override dispose(): void {
        super.dispose();
        this.velocityTarget.dispose();
        this.velocityPass.dispose();
    }
}

// ---------------------------------------------------------------------------
// Light shafts

const SHAFT_MASK = /* glsl */ `
#include <packing>
uniform sampler2D inputBuffer;
uniform sampler2D depthBuffer;
uniform vec2 sunUv;
uniform float aspect;
varying vec2 vUv;
void main() {
    float depth = texture2D( depthBuffer, vUv ).r;
    // Only the open sky shines through, and only its glare around the sun: anything in front blocks the light.
    float sky = step( 0.99999, depth );
    vec3 c = texture2D( inputBuffer, vUv ).rgb;
    vec2 toSun = ( vUv - sunUv ) * vec2( aspect, 1.0 );
    float near = exp( -dot( toSun, toSun ) * 12.0 );
    gl_FragColor = vec4( min( max( c - vec3( 0.8 ), vec3( 0.0 ) ), vec3( 8.0 ) ) * sky * near, 1.0 );
}`;

const SHAFT_BLUR = /* glsl */ `
uniform sampler2D mask;
uniform vec2 sunUv;
uniform float density;
uniform float decay;
varying vec2 vUv;
void main() {
    vec2 step = ( vUv - sunUv ) * density / 64.0;
    vec2 at = vUv;
    vec3 sum = vec3( 0.0 );
    float weight = 1.0;
    for ( int i = 0; i < 64; i++ ) {
        at -= step;
        sum += texture2D( mask, at ).rgb * weight;
        weight *= decay;
    }
    gl_FragColor = vec4( sum / 64.0, 1.0 );
}`;

const SHAFTS_EFFECT = /* glsl */ `
uniform sampler2D shafts;
uniform vec3 tint;
uniform float intensity;
void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
    outputColor = vec4( inputColor.rgb + texture2D( shafts, uv ).rgb * tint * intensity, inputColor.a );
}`;

const _sun = new THREE.Vector3();
const _forward = new THREE.Vector3();

export class LightShaftsEffect extends Effect {
    private readonly camera: THREE.Camera;
    private readonly maskPass: FullscreenPass;
    private readonly blurPass: FullscreenPass;
    private maskTarget = effectTarget(1, 1);
    private blurTarget = effectTarget(1, 1);
    private depth: THREE.Texture | null = null;
    private strength: number;

    constructor(camera: THREE.Camera, intensity = 0.35) {
        super('LightShaftsEffect', SHAFTS_EFFECT, {
            attributes: EffectAttribute.DEPTH,
            uniforms: new Map<string, THREE.Uniform>([
                ['shafts', new THREE.Uniform(null)],
                ['tint', new THREE.Uniform(new THREE.Color(1, 1, 1))],
                ['intensity', new THREE.Uniform(0)],
            ]),
        });
        this.camera = camera;
        this.strength = intensity;
        this.maskPass = new FullscreenPass(SHAFT_MASK, { inputBuffer: { value: null }, depthBuffer: { value: null }, sunUv: { value: new THREE.Vector2() }, aspect: { value: 1 } });
        this.blurPass = new FullscreenPass(SHAFT_BLUR, { mask: { value: null }, sunUv: { value: new THREE.Vector2() }, density: { value: 0.9 }, decay: { value: 0.965 } });
    }

    set intensity(value: number) {
        this.strength = value;
    }

    override setDepthTexture(depthTexture: THREE.Texture): void {
        this.depth = depthTexture;
    }

    override setSize(width: number, height: number): void {
        const w = Math.max(1, Math.round(width / 2)), h = Math.max(1, Math.round(height / 2));
        this.maskTarget.setSize(w, h);
        this.blurTarget.setSize(w, h);
        this.maskPass.material.uniforms.aspect.value = width / Math.max(1, height);
    }

    override update(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget): void {
        const camera = this.camera;
        // Where the sun is on screen, and how much of it shows: none behind the camera or below the horizon.
        _sun.set(skyLight.sun.x, skyLight.sun.y, skyLight.sun.z);
        camera.getWorldDirection(_forward);
        const facing = _forward.dot(_sun);
        const above = THREE.MathUtils.smoothstep(skyLight.sun.y, -0.02, 0.08);
        const shown = THREE.MathUtils.smoothstep(facing, 0.1, 0.45) * above * Math.min(1, skyLight.sunStrength / 1.5);
        this.uniforms.get('intensity')!.value = shown * this.strength;
        if (shown <= 0.001 || !this.depth) return;
        camera.getWorldPosition(_forward);
        _sun.multiplyScalar(1000).add(_forward).project(camera);
        const sunUv = new THREE.Vector2(_sun.x * 0.5 + 0.5, _sun.y * 0.5 + 0.5);
        (this.uniforms.get('tint')!.value as THREE.Color).setRGB(skyLight.sunColor[0], skyLight.sunColor[1], skyLight.sunColor[2]);
        const before = renderer.getRenderTarget();
        const mask = this.maskPass.material.uniforms;
        mask.inputBuffer.value = inputBuffer.texture;
        mask.depthBuffer.value = this.depth;
        mask.sunUv.value.copy(sunUv);
        this.maskPass.render(renderer, this.maskTarget);
        const blur = this.blurPass.material.uniforms;
        blur.mask.value = this.maskTarget.texture;
        blur.sunUv.value.copy(sunUv);
        this.blurPass.render(renderer, this.blurTarget);
        this.uniforms.get('shafts')!.value = this.blurTarget.texture;
        renderer.setRenderTarget(before);
    }

    override dispose(): void {
        super.dispose();
        this.maskTarget.dispose();
        this.blurTarget.dispose();
        this.maskPass.dispose();
        this.blurPass.dispose();
    }
}

// ---------------------------------------------------------------------------
// Sunlit haze

const HAZE_EFFECT = /* glsl */ `
uniform mat4 inverseProjection;
uniform mat4 cameraWorld;
uniform vec3 sunDirection;
uniform vec3 sunColor;
uniform float fogDensity;
uniform float intensity;
void mainImage( const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor ) {
    outputColor = inputColor;
    if ( intensity <= 0.0 || fogDensity <= 0.0 ) return;
    float d = min( depth, 0.99999 );
    vec4 view = inverseProjection * vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
    view /= view.w;
    vec3 ray = normalize( ( cameraWorld * vec4( view.xyz, 0.0 ) ).xyz );
    // How much fog lies along the ray (the scene's own exponential fog), the sky counting as far.
    float distance = depth >= 0.99999 ? 400.0 : length( view.xyz );
    float fog = 1.0 - exp( -pow( fogDensity * distance, 2.0 ) );
    // Light scattered toward the eye, strongly forward (Henyey-Greenstein, g = 0.7), plus a soft glow.
    float cosine = dot( ray, sunDirection );
    float g = 0.7;
    float phase = ( 1.0 - g * g ) / pow( 1.0 + g * g - 2.0 * g * cosine, 1.5 ) * 0.006 + 0.004;
    float skyShare = depth >= 0.99999 ? 0.35 : 1.0;
    outputColor = vec4( inputColor.rgb + sunColor * phase * fog * intensity * skyShare, inputColor.a );
}`;

export class SunHazeEffect extends Effect {
    private readonly camera: THREE.Camera;

    constructor(camera: THREE.Camera, intensity = 0.5) {
        super('SunHazeEffect', HAZE_EFFECT, {
            attributes: EffectAttribute.DEPTH,
            uniforms: new Map<string, THREE.Uniform>([
                ['inverseProjection', new THREE.Uniform(new THREE.Matrix4())],
                ['cameraWorld', new THREE.Uniform(new THREE.Matrix4())],
                ['sunDirection', new THREE.Uniform(new THREE.Vector3(0, 1, 0))],
                ['sunColor', new THREE.Uniform(new THREE.Color())],
                ['fogDensity', new THREE.Uniform(0)],
                ['intensity', new THREE.Uniform(intensity)],
            ]),
        });
        this.camera = camera;
    }

    set intensity(value: number) {
        this.uniforms.get('intensity')!.value = value;
    }

    override update(): void {
        const u = this.uniforms;
        (u.get('inverseProjection')!.value as THREE.Matrix4).copy(this.camera.projectionMatrixInverse);
        (u.get('cameraWorld')!.value as THREE.Matrix4).copy(this.camera.matrixWorld);
        (u.get('sunDirection')!.value as THREE.Vector3).set(skyLight.sun.x, skyLight.sun.y, skyLight.sun.z);
        const strength = skyLight.sunStrength * THREE.MathUtils.smoothstep(skyLight.sun.y, -0.05, 0.05);
        (u.get('sunColor')!.value as THREE.Color).setRGB(skyLight.sunColor[0] * strength, skyLight.sunColor[1] * strength, skyLight.sunColor[2] * strength);
        u.get('fogDensity')!.value = skyLight.fogDensity;
    }
}

// ---------------------------------------------------------------------------
// White balance

const WHITE_BALANCE_EFFECT = /* glsl */ `
uniform vec3 balance;
void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
    outputColor = vec4( inputColor.rgb * balance, inputColor.a );
}`;

/** Multipliers for a warmer (temperature > 0) or cooler picture, greener or more magenta (tint), keeping brightness. */
export const whiteBalance = (temperature: number, tint: number): [number, number, number] => {
    const r = 1 + 0.22 * temperature - 0.05 * tint;
    const g = 1 - 0.12 * tint;
    const b = 1 - 0.22 * temperature - 0.05 * tint;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return [r / luminance, g / luminance, b / luminance];
};

export class WhiteBalanceEffect extends Effect {
    constructor(temperature = 0, tint = 0) {
        super('WhiteBalanceEffect', WHITE_BALANCE_EFFECT, {
            uniforms: new Map<string, THREE.Uniform>([['balance', new THREE.Uniform(new THREE.Vector3(...whiteBalance(temperature, tint)))]]),
        });
    }

    set(temperature: number, tint: number): void {
        (this.uniforms.get('balance')!.value as THREE.Vector3).set(...whiteBalance(temperature, tint));
    }
}

// ---------------------------------------------------------------------------
// Looks

export type ColorLook = 'none' | 'warm' | 'cool' | 'cinematic' | 'bleach' | 'noir' | 'vintage' | 'night';

export const COLOR_LOOKS: readonly ColorLook[] = ['none', 'warm', 'cool', 'cinematic', 'bleach', 'noir', 'vintage', 'night'];

const smooth = (x: number) => x * x * (3 - 2 * x);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** What a look does to one display colour (0-1 each). */
export const applyLook = (look: ColorLook, r: number, g: number, b: number): [number, number, number] => {
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const saturate = (amount: number): [number, number, number] => [luma + (r - luma) * amount, luma + (g - luma) * amount, luma + (b - luma) * amount];
    const contrast = (v: number, amount: number) => clamp01(v + (smooth(v) - v) * amount);
    switch (look) {
        case 'warm': {
            const [sr, sg, sb] = saturate(1.08);
            return [clamp01(sr * 1.06 + 0.01), clamp01(sg * 1.01), clamp01(sb * 0.9)];
        }
        case 'cool': {
            const [sr, sg, sb] = saturate(0.95);
            return [clamp01(sr * 0.92), clamp01(sg * 0.99), clamp01(sb * 1.08 + 0.01)];
        }
        case 'cinematic': {
            // Shadows toward teal, highlights toward orange, a gentle S-curve.
            const shadow = 1 - smooth(clamp01(luma * 1.6));
            const light = smooth(clamp01((luma - 0.35) * 1.6));
            return [
                contrast(clamp01(r - 0.04 * shadow + 0.06 * light), 0.35),
                contrast(clamp01(g + 0.015 * shadow + 0.02 * light), 0.35),
                contrast(clamp01(b + 0.06 * shadow - 0.07 * light), 0.35),
            ];
        }
        case 'bleach': {
            const [sr, sg, sb] = saturate(0.45);
            return [contrast(sr, 0.6), contrast(sg, 0.6), contrast(sb, 0.6)];
        }
        case 'noir': {
            const v = contrast(clamp01(luma), 0.8);
            return [v, v, v];
        }
        case 'vintage': {
            // Faded: lifted blacks, softened whites, warm and a little washed out.
            const [sr, sg, sb] = saturate(0.78);
            const fade = (v: number) => 0.07 + v * 0.86;
            return [clamp01(fade(sr) * 1.04), clamp01(fade(sg)), clamp01(fade(sb) * 0.88)];
        }
        case 'night': {
            // Moonlit: blue, low saturation, darker mids.
            const [sr, sg, sb] = saturate(0.55);
            return [clamp01(sr * 0.82), clamp01(sg * 0.92), clamp01(sb * 1.12 + 0.02)];
        }
        default:
            return [r, g, b];
    }
};

const LUT_SIZE = 32;
const lookCache = new Map<ColorLook, LookupTexture>();

/** A look as a 3D lookup texture for LUT3DEffect (made once). */
export const lookTexture = (look: ColorLook): LookupTexture => {
    const cached = lookCache.get(look);
    if (cached) return cached;
    const data = new Float32Array(LUT_SIZE ** 3 * 4);
    let at = 0;
    for (let z = 0; z < LUT_SIZE; z++) {
        for (let y = 0; y < LUT_SIZE; y++) {
            for (let x = 0; x < LUT_SIZE; x++) {
                const [r, g, b] = applyLook(look, x / (LUT_SIZE - 1), y / (LUT_SIZE - 1), z / (LUT_SIZE - 1));
                data[at++] = r;
                data[at++] = g;
                data[at++] = b;
                data[at++] = 1;
            }
        }
    }
    const texture = new LookupTexture(data, LUT_SIZE);
    texture.type = THREE.FloatType;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    lookCache.set(look, texture);
    return texture;
};
