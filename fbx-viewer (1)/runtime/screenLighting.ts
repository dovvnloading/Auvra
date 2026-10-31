import * as THREE from 'three';
import { Effect } from 'postprocessing';
import { SurfaceBuffer } from './gbuffer';
import { DYNAMIC_GI_UNIFORMS, GI_SAMPLE_GLSL, sceneReadsGi } from './lighting/dynamicGi/giMaterials';
import { effectTarget, FullscreenPass } from './postEffects';

/**
 * SCREEN-SPACE LIGHTING
 *
 * Light that bounces, worked out each frame from what is on screen:
 *  - Global illumination: light from lit surfaces falls on the surfaces around them, so a sunlit red
 *    wall tints the floor beside it and a sunlit floor lights a room's shadowed walls; and what is
 *    enclosed loses the sky light it cannot see, so a room is darker inside than out. Each pixel sends a
 *    few rays over its hemisphere (cosine-weighted, rotated every frame) through the depth of the scene:
 *    one that lands takes the lit colour there, one that escapes brings the sky's ambient light. The
 *    difference from the ambient light already drawn is eased over frames (reprojected with the camera's
 *    motion, restarting where something new comes into view) and smoothed along surfaces, at half size.
 *  - Reflections: each glossy pixel follows its mirror ray through the scene's depth and takes the lit
 *    colour it meets, rougher surfaces scattering it more, faded toward the screen edges where the ray
 *    leaves what can be seen. Added by the surface's Fresnel reflectance, so metals reflect their own
 *    colour and other surfaces mostly at grazing angles.
 * Both read the surface buffer (gbuffer.ts) and only bounce light the camera can see: what is off
 * screen or hidden behind something casts no bounce and shows in no reflection.
 *
 * With Dynamic Global Illumination on (lighting/dynamicGi), the probes have the far light and this keeps the near:
 * the detail between probes, small things touching and close-up colour. A ray that lands still takes what it
 * finds; one that escapes brings what the probes gave this pixel, so that it adds nothing to it.
 */

const COMMON = /* glsl */ `
uniform sampler2D surfaceDepth;
uniform sampler2D surfaceNormal;
uniform mat4 projection;
uniform mat4 inverseProjection;
uniform float cameraNear;
uniform float cameraFar;
uniform float frame;
varying vec2 vUv;

vec3 viewAt( vec2 uv, float depth ) {
    vec4 p = inverseProjection * vec4( uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0 );
    return p.xyz / p.w;
}

float viewZAt( vec2 uv ) {
    float depth = texture2D( surfaceDepth, uv ).r;
    return ( cameraNear * cameraFar ) / ( ( cameraFar - cameraNear ) * depth - cameraFar );
}

vec2 projectUv( vec3 p ) {
    vec4 clip = projection * vec4( p, 1.0 );
    return clip.xy / clip.w * 0.5 + 0.5;
}

bool onScreen( vec2 uv ) {
    return uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0;
}

// Interleaved gradient noise: well spread from pixel to pixel.
float noiseAt( vec2 pixel ) {
    return fract( 52.9829189 * fract( dot( pixel, vec2( 0.06711056, 0.00583715 ) ) ) );
}
`;

// The indirect light reaching each pixel, less the ambient light the renderer already gave it. A ray
// that lands on a surface brings that surface's lit colour; one that escapes brings the sky's ambient
// light from its direction (the scene's ambient and hemisphere lights and its environment map, in the
// renderer's own terms), so an open surface comes out unchanged, an enclosed one loses the sky it cannot
// see and gains what bounces in.
const GI_TRACE = /* glsl */ `
#include <common>
${COMMON}
uniform sampler2D lit;
uniform float radius;
uniform mat4 cameraWorld;
uniform vec3 ambientLight;
uniform vec3 hemiSky;
uniform vec3 hemiGround;
uniform vec3 hemiUp;
uniform mat3 envRotation;
uniform float envIntensity;
#ifdef SKY_ENVIRONMENT
uniform sampler2D envMap;
#include <cube_uv_reflection_fragment>
#endif
#ifdef AUVRA_DYNAMIC_GI
uniform vec4 auvraGiParams;
${GI_SAMPLE_GLSL}
#endif
#define RAYS 4
#define STEPS 10

vec3 cosineDirection( vec3 n, vec2 xi ) {
    float phi = 6.2831853 * xi.x;
    float r = sqrt( xi.y );
    vec3 t = normalize( abs( n.y ) < 0.99 ? cross( n, vec3( 0.0, 1.0, 0.0 ) ) : cross( n, vec3( 1.0, 0.0, 0.0 ) ) );
    vec3 b = cross( n, t );
    return normalize( t * ( cos( phi ) * r ) + b * ( sin( phi ) * r ) + n * sqrt( max( 0.0, 1.0 - xi.y ) ) );
}

// Ambient light as radiance from a world direction. The hemisphere weight is chosen so that its
// cosine-weighted average over a surface's hemisphere is the renderer's own hemisphere term.
vec3 skyFrom( vec3 worldDir, float hemiWeight ) {
    vec3 light = ( ambientLight + mix( hemiGround, hemiSky, clamp( hemiWeight, 0.0, 1.0 ) ) ) * RECIPROCAL_PI;
    #ifdef SKY_ENVIRONMENT
    light += textureCubeUV( envMap, envRotation * worldDir, 1.0 ).rgb * envIntensity;
    #endif
    return light;
}

void main() {
    float depth = texture2D( surfaceDepth, vUv ).r;
    if ( depth >= 1.0 ) { gl_FragColor = vec4( 0.0 ); return; }
    vec3 p = viewAt( vUv, depth );
    vec3 n = normalize( texture2D( surfaceNormal, vUv ).xyz );
    vec3 worldNormal = normalize( ( cameraWorld * vec4( n, 0.0 ) ).xyz );
    vec3 origin = p + n * ( 0.02 - p.z * 0.01 );
    float n0 = noiseAt( gl_FragCoord.xy + frame * 5.588238 );
    float n1 = noiseAt( gl_FragCoord.xy * 1.37 + frame * 3.1416 + 17.0 );
    #ifdef AUVRA_DYNAMIC_GI
    vec3 worldPoint = ( cameraWorld * vec4( p, 1.0 ) ).xyz;
    vec3 toCamera = normalize( ( cameraWorld * vec4( -p, 0.0 ) ).xyz );
    vec4 gathered4 = auvraGiIrradiance( worldPoint, worldNormal, toCamera, n0 );
    vec3 probeLight = gathered4.rgb * auvraGiParams.x * RECIPROCAL_PI;
    #endif
    vec3 sum = vec3( 0.0 );
    for ( int r = 0; r < RAYS; r++ ) {
        vec2 xi = fract( vec2( n0, n1 ) + vec2( float( r ) * 0.618034, float( r ) * 0.381966 ) );
        vec3 dir = cosineDirection( n, xi );
        float jitter = fract( n1 + float( r ) * 0.25 );
        vec3 worldDir = normalize( ( cameraWorld * vec4( dir, 0.0 ) ).xyz );
        vec3 sky = skyFrom( worldDir, 0.5 + 0.75 * dot( worldDir, hemiUp ) );
        #ifdef AUVRA_DYNAMIC_GI
        sky = mix( sky, probeLight, gathered4.a );
        #endif
        vec3 gathered = sky;
        for ( int s = 0; s < STEPS; s++ ) {
            float along = ( float( s ) + jitter ) / float( STEPS );
            float t = radius * along * along + 0.05;
            vec3 q = origin + dir * t;
            if ( q.z > -cameraNear ) break;
            vec2 uv = projectUv( q );
            if ( !onScreen( uv ) ) break;
            float delta = viewZAt( uv ) - q.z;
            // The scene's surface lies just in front of the ray point: the ray went in there.
            if ( delta > 0.0 && delta < 0.15 + t * 0.3 ) {
                vec3 hitNormal = texture2D( surfaceNormal, uv ).xyz;
                // The lit side of what it met; the back of something brings nothing.
                vec3 hit = dot( hitNormal, dir ) < 0.0 ? min( texture2D( lit, uv ).rgb, vec3( 6.0 ) ) : vec3( 0.0 );
                // Far blockers fade toward the sky: past the reach the screen cannot say what light comes round them.
                gathered = mix( hit, sky, smoothstep( 0.4, 1.0, t / radius ) );
                break;
            }
        }
        sum += gathered;
    }
    vec3 ambient = skyFrom( worldNormal, 0.5 + 0.5 * dot( worldNormal, hemiUp ) );
    #ifdef AUVRA_DYNAMIC_GI
    ambient = mix( ambient, probeLight, gathered4.a );
    #endif
    gl_FragColor = vec4( sum / float( RAYS ) - ambient, -p.z );
}`;

// Eases each pixel's bounce over frames: this frame's rays blended into what the same surface point
// gathered before, found by reprojecting it with the previous view. Where that point was not on screen
// or something else stood there (its distance from the camera disagrees), it starts over.
const ACCUMULATE = /* glsl */ `
${COMMON}
uniform sampler2D current;
uniform sampler2D history;
uniform mat4 cameraWorld;
uniform mat4 previousView;
uniform mat4 previousViewProjection;
uniform float blend;
uniform float hasHistory;
void main() {
    vec4 now = texture2D( current, vUv );
    float depth = texture2D( surfaceDepth, vUv ).r;
    if ( depth >= 1.0 ) { gl_FragColor = vec4( 0.0 ); return; }
    vec3 p = viewAt( vUv, depth );
    vec4 world = cameraWorld * vec4( p, 1.0 );
    vec4 clip = previousViewProjection * world;
    vec2 before = clip.xy / clip.w * 0.5 + 0.5;
    float expected = -( previousView * world ).z;
    vec3 result = now.rgb;
    if ( hasHistory > 0.5 && onScreen( before ) ) {
        vec4 past = texture2D( history, before );
        if ( past.a > 0.0 && abs( past.a - expected ) < expected * 0.06 + 0.02 ) result = mix( past.rgb, now.rgb, blend );
    }
    gl_FragColor = vec4( result, -p.z );
}`;

// One step of an edge-stopping blur: neighbours count by how alike their distance and facing are.
const SMOOTH = /* glsl */ `
${COMMON}
uniform sampler2D source;
uniform vec2 texel;
uniform float stride;
void main() {
    vec4 centre = texture2D( source, vUv );
    if ( centre.a <= 0.0 ) { gl_FragColor = centre; return; }
    vec3 n = texture2D( surfaceNormal, vUv ).xyz;
    vec3 sum = vec3( 0.0 );
    float total = 0.0;
    for ( int y = -1; y <= 1; y++ ) {
        for ( int x = -1; x <= 1; x++ ) {
            vec2 uv = vUv + vec2( float( x ), float( y ) ) * texel * stride;
            vec4 s = texture2D( source, uv );
            if ( s.a <= 0.0 ) continue;
            float w = ( x == 0 ? 2.0 : 1.0 ) * ( y == 0 ? 2.0 : 1.0 );
            w *= exp( -abs( s.a - centre.a ) / ( centre.a * 0.04 + 0.02 ) );
            w *= pow( max( dot( n, texture2D( surfaceNormal, uv ).xyz ), 0.0 ), 8.0 );
            sum += s.rgb * w;
            total += w;
        }
    }
    gl_FragColor = vec4( sum / max( total, 1e-4 ), centre.a );
}`;

const REFLECTION_TRACE = /* glsl */ `
${COMMON}
uniform sampler2D lit;
uniform float maxDistance;
#define STEPS 28
#define REFINE 5
void main() {
    float depth = texture2D( surfaceDepth, vUv ).r;
    vec4 normalRoughness = texture2D( surfaceNormal, vUv );
    float roughness = normalRoughness.w;
    if ( depth >= 1.0 || roughness > 0.75 ) { gl_FragColor = vec4( 0.0 ); return; }
    vec3 p = viewAt( vUv, depth );
    vec3 n = normalize( normalRoughness.xyz );
    // Rough surfaces scatter the mirror ray; the noise holds still so the pattern does not crawl.
    float n0 = noiseAt( gl_FragCoord.xy );
    float n1 = noiseAt( gl_FragCoord.xy * 1.37 + 17.0 );
    vec3 scatter = vec3( n0 - 0.5, n1 - 0.5, fract( n0 + n1 ) - 0.5 ) * roughness * roughness * 0.8;
    vec3 r = reflect( normalize( p ), normalize( n + scatter ) );
    if ( dot( r, n ) <= 0.0 ) { gl_FragColor = vec4( 0.0 ); return; }
    vec3 origin = p + n * ( 0.01 - p.z * 0.004 );
    float jitter = n0;
    float previous = 0.0;
    float found = -1.0;
    for ( int i = 0; i < STEPS; i++ ) {
        float along = ( float( i ) + jitter ) / float( STEPS );
        float t = maxDistance * along * along + 0.02;
        vec3 q = origin + r * t;
        if ( q.z > -cameraNear ) break;
        vec2 uv = projectUv( q );
        if ( !onScreen( uv ) ) break;
        float delta = viewZAt( uv ) - q.z;
        if ( delta > 0.0 && delta < 0.2 + t * 0.15 ) {
            // Close in on where the ray crosses the surface.
            float low = previous;
            float high = t;
            for ( int b = 0; b < REFINE; b++ ) {
                float middle = ( low + high ) * 0.5;
                vec3 m = origin + r * middle;
                if ( viewZAt( projectUv( m ) ) - m.z > 0.0 ) high = middle; else low = middle;
            }
            found = high;
            break;
        }
        previous = t;
    }
    if ( found < 0.0 ) { gl_FragColor = vec4( 0.0 ); return; }
    vec2 hit = projectUv( origin + r * found );
    vec3 hitNormal = texture2D( surfaceNormal, hit ).xyz;
    vec2 edge = smoothstep( 0.0, 0.08, hit ) * ( 1.0 - smoothstep( 0.92, 1.0, hit ) );
    float confidence = edge.x * edge.y;
    confidence *= 1.0 - smoothstep( 0.6, 1.0, found / maxDistance );
    confidence *= 1.0 - smoothstep( 0.5, 0.75, roughness );
    confidence *= step( dot( hitNormal, r ), 0.05 );
    gl_FragColor = vec4( min( texture2D( lit, hit ).rgb, vec3( 8.0 ) ), confidence );
}`;

// Softens reflections on rougher surfaces, keeping to the surface they fall on.
const REFLECTION_SMOOTH = /* glsl */ `
${COMMON}
uniform sampler2D source;
uniform vec2 texel;
void main() {
    vec4 normalRoughness = texture2D( surfaceNormal, vUv );
    float depth = texture2D( surfaceDepth, vUv ).r;
    vec4 centre = texture2D( source, vUv );
    if ( depth >= 1.0 ) { gl_FragColor = centre; return; }
    float z = -viewZAt( vUv );
    float spread = 1.0 + normalRoughness.w * 6.0;
    vec4 sum = vec4( 0.0 );
    float total = 0.0;
    for ( int y = -1; y <= 1; y++ ) {
        for ( int x = -1; x <= 1; x++ ) {
            vec2 uv = vUv + vec2( float( x ), float( y ) ) * texel * spread;
            float w = ( x == 0 ? 2.0 : 1.0 ) * ( y == 0 ? 2.0 : 1.0 );
            w *= exp( -abs( -viewZAt( uv ) - z ) / ( z * 0.03 + 0.02 ) );
            w *= pow( max( dot( normalRoughness.xyz, texture2D( surfaceNormal, uv ).xyz ), 0.0 ), 16.0 );
            vec4 s = texture2D( source, uv );
            // Weighted by confidence, so a missed ray next door does not darken a hit.
            sum += vec4( s.rgb * s.a, s.a ) * w;
            total += w;
        }
    }
    gl_FragColor = sum.a > 0.0 ? vec4( sum.rgb / sum.a, sum.a / max( total, 1e-4 ) ) : vec4( 0.0 );
}`;

const COMPOSITE = /* glsl */ `
uniform sampler2D surfaceDepth;
uniform sampler2D surfaceNormal;
uniform sampler2D surfaceAlbedo;
uniform sampler2D bounce;
uniform sampler2D reflection;
uniform mat4 inverseProjection;
uniform vec2 traceTexel;
uniform float bounceIntensity;
uniform float reflectionIntensity;
uniform float active;
uniform float showOnly;

// The half-size bounce at a full-size pixel, from the four nearest samples on the same surface.
vec3 bounceAt( vec2 uv, float z ) {
    vec2 at = uv / traceTexel - 0.5;
    vec2 base = floor( at );
    vec2 f = at - base;
    vec3 sum = vec3( 0.0 );
    float total = 0.0;
    for ( int i = 0; i < 4; i++ ) {
        vec2 o = vec2( float( i - ( i / 2 ) * 2 ), float( i / 2 ) );
        vec4 s = texture2D( bounce, ( base + o + 0.5 ) * traceTexel );
        float w = ( o.x > 0.5 ? f.x : 1.0 - f.x ) * ( o.y > 0.5 ? f.y : 1.0 - f.y ) + 1e-3;
        w *= s.a > 0.0 ? exp( -abs( s.a - z ) / ( z * 0.05 + 0.02 ) ) : 0.0;
        sum += s.rgb * w;
        total += w;
    }
    return total > 1e-4 ? sum / total : vec3( 0.0 );
}

void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
    outputColor = inputColor;
    if ( active < 0.5 ) return;
    float depth = texture2D( surfaceDepth, uv ).r;
    if ( depth >= 1.0 ) return;
    vec4 normalRoughness = texture2D( surfaceNormal, uv );
    vec4 albedoMetalness = texture2D( surfaceAlbedo, uv );
    vec4 view = inverseProjection * vec4( uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0 );
    vec3 p = view.xyz / view.w;
    vec3 n = normalize( normalRoughness.xyz );
    float facing = clamp( dot( n, normalize( -p ) ), 0.0, 1.0 );
    vec3 f0 = mix( vec3( 0.04 ), albedoMetalness.rgb, albedoMetalness.a );
    vec3 fresnel = f0 + ( max( vec3( 1.0 - normalRoughness.w ), f0 ) - f0 ) * pow( 1.0 - facing, 5.0 );
    vec3 color = inputColor.rgb;
    if ( bounceIntensity > 0.0 ) {
        vec3 diffuse = albedoMetalness.rgb * ( 1.0 - albedoMetalness.a ) * ( 1.0 - fresnel );
        color = max( color + diffuse * bounceAt( uv, -p.z ) * bounceIntensity, vec3( 0.0 ) );
    }
    if ( reflectionIntensity > 0.0 ) {
        vec4 reflected = texture2D( reflection, uv );
        color += reflected.rgb * reflected.a * fresnel * reflectionIntensity;
        if ( showOnly > 1.5 ) color = reflected.rgb * reflected.a;
    }
    // Grey where nothing changes; darker where sky light is lost, coloured where light bounces in.
    if ( showOnly > 0.5 && showOnly < 1.5 ) color = vec3( 0.25 ) + bounceAt( uv, -p.z );
    outputColor = vec4( color, inputColor.a );
}`;

export interface ScreenLightingOptions {
    /** Strength of the bounced light; 0 turns it off. */
    bounce?: number;
    /** How far bounced light reaches, in metres. */
    bounceRadius?: number;
    /** Strength of screen-space reflections; 0 turns them off. */
    reflections?: number;
    /** How far a reflection ray travels, in metres. */
    reflectionDistance?: number;
}

/**
 * What the effect shows: the lit picture, or one part on its own. 'bounce' is the change it makes to
 * indirect light, on grey: darker where sky light is lost, coloured where light bounces in.
 */
export type ScreenLightingView = 'final' | 'bounce' | 'reflections';

export const SCREEN_LIGHTING_DEFAULTS: Required<ScreenLightingOptions> = {
    bounce: 1,
    bounceRadius: 3,
    reflections: 1,
    reflectionDistance: 20,
};

const uniform = <T>(value: T) => ({ value });

const _euler = new THREE.Euler();
const _rotation = new THREE.Matrix4();
const _position = new THREE.Vector3();

type AmbientUniforms = Record<'ambientLight' | 'hemiSky' | 'hemiGround' | 'hemiUp', { value: unknown }>;

/**
 * The scene's ambient and hemisphere light in the terms three's lighting uses (colour times intensity;
 * a hemisphere's up is toward its position), into the trace's uniforms.
 */
export const gatherAmbient = (scene: THREE.Object3D, into: AmbientUniforms): void => {
    const ambient = (into.ambientLight.value as THREE.Color).setRGB(0, 0, 0);
    const sky = (into.hemiSky.value as THREE.Color).setRGB(0, 0, 0);
    const ground = (into.hemiGround.value as THREE.Color).setRGB(0, 0, 0);
    const up = (into.hemiUp.value as THREE.Vector3).set(0, 1, 0);
    let hemispheres = 0;
    scene.traverseVisible(object => {
        const light = object as THREE.Light;
        if (!light.isLight) return;
        if ((light as THREE.AmbientLight).isAmbientLight) {
            ambient.r += light.color.r * light.intensity;
            ambient.g += light.color.g * light.intensity;
            ambient.b += light.color.b * light.intensity;
        } else if ((light as THREE.HemisphereLight).isHemisphereLight) {
            const hemisphere = light as THREE.HemisphereLight;
            sky.r += hemisphere.color.r * hemisphere.intensity;
            sky.g += hemisphere.color.g * hemisphere.intensity;
            sky.b += hemisphere.color.b * hemisphere.intensity;
            ground.r += hemisphere.groundColor.r * hemisphere.intensity;
            ground.g += hemisphere.groundColor.g * hemisphere.intensity;
            ground.b += hemisphere.groundColor.b * hemisphere.intensity;
            if (hemispheres++ === 0) up.copy(hemisphere.getWorldPosition(_position)).normalize();
        }
    });
    if (up.lengthSq() < 1e-6) up.set(0, 1, 0);
};

export class ScreenLightingEffect extends Effect {
    private readonly scene: THREE.Scene;
    private readonly camera: THREE.Camera;
    readonly surface = new SurfaceBuffer();
    private readonly common = {
        surfaceDepth: uniform<THREE.Texture | null>(null),
        surfaceNormal: uniform<THREE.Texture | null>(null),
        projection: uniform(new THREE.Matrix4()),
        inverseProjection: uniform(new THREE.Matrix4()),
        cameraNear: uniform(0.1),
        cameraFar: uniform(1000),
        frame: uniform(0),
    };
    private readonly bounceTrace: FullscreenPass;
    private readonly accumulate: FullscreenPass;
    private readonly smooth: FullscreenPass;
    private readonly reflectionTrace: FullscreenPass;
    private readonly reflectionSmooth: FullscreenPass;
    private readonly bounceRaw = effectTarget(1, 1);
    private history: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] = [effectTarget(1, 1), effectTarget(1, 1)];
    private readonly smoothed: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] = [effectTarget(1, 1), effectTarget(1, 1)];
    private readonly reflectionRaw = effectTarget(1, 1);
    private readonly reflectionSoft = effectTarget(1, 1);
    private readonly previousView = new THREE.Matrix4();
    private readonly previousViewProjection = new THREE.Matrix4();
    private hasHistory = false;
    private options: Required<ScreenLightingOptions>;
    private pmrem: THREE.PMREMGenerator | null = null;
    private readonly environment: { source: THREE.Texture | null; version: number; target: THREE.WebGLRenderTarget | null } =
        { source: null, version: -1, target: null };

    constructor(scene: THREE.Scene, camera: THREE.Camera, options: ScreenLightingOptions = {}) {
        super('ScreenLightingEffect', COMPOSITE, {
            uniforms: new Map<string, THREE.Uniform>([
                ['surfaceDepth', new THREE.Uniform(null)],
                ['surfaceNormal', new THREE.Uniform(null)],
                ['surfaceAlbedo', new THREE.Uniform(null)],
                ['bounce', new THREE.Uniform(null)],
                ['reflection', new THREE.Uniform(null)],
                ['inverseProjection', new THREE.Uniform(new THREE.Matrix4())],
                ['traceTexel', new THREE.Uniform(new THREE.Vector2(1, 1))],
                ['bounceIntensity', new THREE.Uniform(0)],
                ['reflectionIntensity', new THREE.Uniform(0)],
                ['active', new THREE.Uniform(0)],
                ['showOnly', new THREE.Uniform(0)],
            ]),
        });
        this.scene = scene;
        this.camera = camera;
        this.options = { ...SCREEN_LIGHTING_DEFAULTS, ...options };
        const c = this.common;
        this.bounceTrace = new FullscreenPass(GI_TRACE, {
            ...c, lit: uniform(null), radius: uniform(3), cameraWorld: uniform(new THREE.Matrix4()),
            ambientLight: uniform(new THREE.Color()), hemiSky: uniform(new THREE.Color()), hemiGround: uniform(new THREE.Color()),
            hemiUp: uniform(new THREE.Vector3(0, 1, 0)), envMap: uniform<THREE.Texture | null>(null),
            envRotation: uniform(new THREE.Matrix3()), envIntensity: uniform(1),
            auvraGiAtlas: DYNAMIC_GI_UNIFORMS.auvraGiAtlas, auvraGiGrid: DYNAMIC_GI_UNIFORMS.auvraGiGrid, auvraGiParams: DYNAMIC_GI_UNIFORMS.auvraGiParams, auvraGiCorners: DYNAMIC_GI_UNIFORMS.auvraGiCorners,
        });
        this.accumulate = new FullscreenPass(ACCUMULATE, {
            ...c, current: uniform(null), history: uniform(null), cameraWorld: uniform(new THREE.Matrix4()),
            previousView: uniform(this.previousView), previousViewProjection: uniform(this.previousViewProjection),
            blend: uniform(0.12), hasHistory: uniform(0),
        });
        this.smooth = new FullscreenPass(SMOOTH, { ...c, source: uniform(null), texel: uniform(new THREE.Vector2()), stride: uniform(1) });
        this.reflectionTrace = new FullscreenPass(REFLECTION_TRACE, { ...c, lit: uniform(null), maxDistance: uniform(20) });
        this.reflectionSmooth = new FullscreenPass(REFLECTION_SMOOTH, { ...c, source: uniform(null), texel: uniform(new THREE.Vector2()) });
        for (const t of [this.bounceRaw, ...this.history, ...this.smoothed, this.reflectionRaw, this.reflectionSoft]) {
            t.texture.minFilter = t.texture.magFilter = THREE.LinearFilter;
        }
        // History holds a colour and a distance per pixel: blending across an edge in looking one up would make a
        // value true of neither side, which passes the distance check and stays. Bounced light is soft enough
        // not to miss the filtering, and a jittered camera looks up off-centre every frame.
        for (const t of this.history) t.texture.minFilter = t.texture.magFilter = THREE.NearestFilter;
        const u = this.uniforms;
        u.get('surfaceDepth')!.value = this.surface.depth;
        u.get('surfaceNormal')!.value = this.surface.normalRoughness;
        u.get('surfaceAlbedo')!.value = this.surface.albedoMetalness;
        u.get('reflection')!.value = this.reflectionSoft.texture;
        u.get('bounce')!.value = this.smoothed[1].texture;
        c.surfaceDepth.value = this.surface.depth;
        c.surfaceNormal.value = this.surface.normalRoughness;
    }

    set(options: ScreenLightingOptions): void {
        this.options = { ...this.options, ...options };
    }

    get settings(): Readonly<Required<ScreenLightingOptions>> {
        return this.options;
    }

    set view(view: ScreenLightingView) {
        this.uniforms.get('showOnly')!.value = view === 'bounce' ? 1 : view === 'reflections' ? 2 : 0;
    }

    override setSize(width: number, height: number): void {
        this.surface.setSize(width, height);
        const w = Math.max(1, Math.round(width / 2)), h = Math.max(1, Math.round(height / 2));
        for (const t of [this.bounceRaw, ...this.history, ...this.smoothed, this.reflectionRaw, this.reflectionSoft]) t.setSize(w, h);
        (this.uniforms.get('traceTexel')!.value as THREE.Vector2).set(1 / w, 1 / h);
        (this.smooth.material.uniforms.texel.value as THREE.Vector2).set(1 / w, 1 / h);
        (this.reflectionSmooth.material.uniforms.texel.value as THREE.Vector2).set(1 / w, 1 / h);
        this.hasHistory = false;
    }

    override update(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget): void {
        const camera = this.camera as THREE.PerspectiveCamera;
        const { bounce, reflections } = this.options;
        const active = camera.isPerspectiveCamera === true && (bounce > 0 || reflections > 0);
        const u = this.uniforms;
        u.get('active')!.value = active ? 1 : 0;
        if (!active) {
            this.hasHistory = false;
            return;
        }
        camera.updateMatrixWorld();
        const before = renderer.getRenderTarget();
        this.surface.render(renderer, this.scene, camera);

        const c = this.common;
        c.projection.value.copy(camera.projectionMatrix);
        c.inverseProjection.value.copy(camera.projectionMatrixInverse);
        c.cameraNear.value = camera.near;
        c.cameraFar.value = camera.far;
        c.frame.value = (c.frame.value + 1) % 64;
        (u.get('inverseProjection')!.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
        u.get('bounceIntensity')!.value = bounce;
        u.get('reflectionIntensity')!.value = reflections;

        if (bounce > 0) {
            const trace = this.bounceTrace.material.uniforms;
            trace.lit.value = inputBuffer.texture;
            trace.radius.value = this.options.bounceRadius;
            (trace.cameraWorld.value as THREE.Matrix4).copy(camera.matrixWorld);
            trace.envIntensity.value = this.scene.environmentIntensity;
            gatherAmbient(this.scene, trace as unknown as AmbientUniforms);
            this.syncEnvironment(renderer);
            this.followProbes();
            this.bounceTrace.render(renderer, this.bounceRaw);

            const [read, write] = this.history;
            const accumulate = this.accumulate.material.uniforms;
            accumulate.current.value = this.bounceRaw.texture;
            accumulate.history.value = read.texture;
            (accumulate.cameraWorld.value as THREE.Matrix4).copy(camera.matrixWorld);
            accumulate.hasHistory.value = this.hasHistory ? 1 : 0;
            this.accumulate.render(renderer, write);
            this.history = [write, read];

            const smooth = this.smooth.material.uniforms;
            smooth.source.value = write.texture;
            smooth.stride.value = 1;
            this.smooth.render(renderer, this.smoothed[0]);
            smooth.source.value = this.smoothed[0].texture;
            smooth.stride.value = 2;
            this.smooth.render(renderer, this.smoothed[1]);
            this.hasHistory = true;
        } else {
            this.hasHistory = false;
        }

        if (reflections > 0) {
            const trace = this.reflectionTrace.material.uniforms;
            trace.lit.value = inputBuffer.texture;
            trace.maxDistance.value = this.options.reflectionDistance;
            this.reflectionTrace.render(renderer, this.reflectionRaw);
            this.reflectionSmooth.material.uniforms.source.value = this.reflectionRaw.texture;
            this.reflectionSmooth.render(renderer, this.reflectionSoft);
        }

        this.previousView.copy(camera.matrixWorldInverse);
        this.previousViewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        renderer.setRenderTarget(before);
    }

    /** The trace reads the probes while the scene does: what it gathered without them means nothing with them. */
    private followProbes(): void {
        const material = this.bounceTrace.material;
        const defines = material.defines as Record<string, string | number>;
        const reading = sceneReadsGi(this.scene);
        if (reading === 'AUVRA_DYNAMIC_GI' in defines) return;
        if (reading) defines.AUVRA_DYNAMIC_GI = '';
        else delete defines.AUVRA_DYNAMIC_GI;
        material.needsUpdate = true;
        this.hasHistory = false;
    }

    /**
     * Keeps the sky's environment map in the prefiltered (cube UV) form the trace samples, made again
     * when the scene's environment changes. Three keeps its own copy out of reach, so this is a second.
     */
    private syncEnvironment(renderer: THREE.WebGLRenderer): void {
        const source = this.scene.environment;
        const held = this.environment;
        if (source === held.source && (source === null || source.version === held.version)) return;
        held.target?.dispose();
        held.target = null;
        held.source = source;
        held.version = source?.version ?? -1;
        const material = this.bounceTrace.material;
        let prefiltered: THREE.Texture | null = null;
        if (source && source.mapping === THREE.CubeUVReflectionMapping) {
            prefiltered = source;
        } else if (source) {
            this.pmrem ??= new THREE.PMREMGenerator(renderer);
            const before = renderer.getRenderTarget();
            held.target = (source as THREE.CubeTexture).isCubeTexture
                ? this.pmrem.fromCubemap(source as THREE.CubeTexture)
                : this.pmrem.fromEquirectangular(source);
            renderer.setRenderTarget(before);
            prefiltered = held.target.texture;
        }
        material.uniforms.envMap.value = prefiltered;
        const defines = material.defines as Record<string, string | number>;
        for (const key of ['SKY_ENVIRONMENT', 'ENVMAP_TYPE_CUBE_UV', 'CUBEUV_TEXEL_WIDTH', 'CUBEUV_TEXEL_HEIGHT', 'CUBEUV_MAX_MIP']) delete defines[key];
        if (prefiltered) {
            // Sized as three sizes a prefiltered map for its own materials.
            const height = (prefiltered.image as { height: number }).height;
            const maxMip = Math.log2(height) - 2;
            defines.SKY_ENVIRONMENT = '';
            defines.ENVMAP_TYPE_CUBE_UV = '';
            defines.CUBEUV_TEXEL_WIDTH = 1 / (3 * Math.max(2 ** maxMip, 7 * 16));
            defines.CUBEUV_TEXEL_HEIGHT = 1 / height;
            defines.CUBEUV_MAX_MIP = `${maxMip}.0`;
            // The scene's environment rotation, turned as three turns it.
            _euler.copy(this.scene.environmentRotation);
            _euler.x *= -1;
            _euler.y *= -1;
            _euler.z *= -1;
            const cube = source as THREE.CubeTexture & { isRenderTargetTexture?: boolean };
            if (cube?.isCubeTexture && !cube.isRenderTargetTexture) {
                _euler.y *= -1;
                _euler.z *= -1;
            }
            (material.uniforms.envRotation.value as THREE.Matrix3).setFromMatrix4(_rotation.makeRotationFromEuler(_euler));
        }
        material.needsUpdate = true;
    }

    override dispose(): void {
        super.dispose();
        this.environment.target?.dispose();
        this.pmrem?.dispose();
        this.surface.dispose();
        for (const t of [this.bounceRaw, ...this.history, ...this.smoothed, this.reflectionRaw, this.reflectionSoft]) t.dispose();
        for (const pass of [this.bounceTrace, this.accumulate, this.smooth, this.reflectionTrace, this.reflectionSmooth]) pass.dispose();
    }
}
