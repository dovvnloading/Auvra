import * as THREE from 'three';

/**
 * Shaders for what is drawn on the sky: clouds, stars, the moon and lightning bolts. Each sits at
 * infinity (its depth pushed to the far plane), so it is never clipped and everything in the scene
 * draws in front of it, and follows the camera.
 */

/** Draw order among transparent things: stars, then the moon, then clouds, then bolts, all before the scene's own. */
export const SKY_RENDER_ORDER = { stars: -1003, moon: -1002, clouds: -1001, bolt: -1000 } as const;

const AT_INFINITY = /* glsl */ `
    gl_Position.z = gl_Position.w;`;

export const CLOUD_VERTEX = /* glsl */ `
varying vec3 vDirection;
void main() {
    vDirection = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );${AT_INFINITY}
}`;

export const CLOUD_FRAGMENT = /* glsl */ `
varying vec3 vDirection;
uniform float uCoverage;
uniform float uStorm;
uniform float uLight;
uniform float uFlash;
uniform vec2 uOffset;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uHorizon;
uniform vec3 uShade;

float cloudHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float cloudNoise( vec2 p ) {
    vec2 i = floor( p );
    vec2 f = fract( p );
    vec2 u = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( cloudHash( i ), cloudHash( i + vec2( 1.0, 0.0 ) ), u.x ),
                mix( cloudHash( i + vec2( 0.0, 1.0 ) ), cloudHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
float cloudFbm( vec2 p ) {
    float sum = 0.0;
    float amplitude = 0.5;
    mat2 turn = mat2( 0.8, 0.6, -0.6, 0.8 );
    for ( int i = 0; i < 5; i++ ) {
        sum += cloudNoise( p ) * amplitude;
        p = turn * p * 2.03 + 3.1;
        amplitude *= 0.5;
    }
    return sum / 0.97;
}

void main() {
    vec3 direction = normalize( vDirection );
    // Below the horizon, a heavy sky closes in as haze, where the sky's own bright horizon would show.
    if ( direction.y <= 0.0 ) {
        float closed = smoothstep( 0.55, 0.95, uCoverage );
        if ( closed < 0.002 ) discard;
        gl_FragColor = vec4( uHorizon + uFlash * vec3( 0.2, 0.22, 0.26 ), closed );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        return;
    }
    // The clouds lie on a plane overhead: further off, they crowd toward the horizon.
    vec2 uv = direction.xz / ( direction.y + 0.1 ) * 1.4 + uOffset;
    float shape = cloudFbm( uv * 0.55 ) * 0.72 + cloudFbm( uv * 2.1 + 11.0 ) * 0.28;
    float threshold = mix( 0.95, -0.15, pow( uCoverage, 0.85 ) );
    float density = smoothstep( threshold, threshold + 0.28, shape );
    if ( density < 0.002 ) discard;
    float thickness = smoothstep( threshold, threshold + 0.55, shape );

    // Thin edges take the sun, thick cores are grey, darker in a storm; toward the sun they glow.
    float sunward = pow( max( dot( direction, uSunDirection ), 0.0 ), 8.0 );
    vec3 lit = uSunColor * ( 1.0 + 1.4 * sunward ) + uShade * 0.35;
    vec3 colour = mix( lit, uShade, clamp( thickness * ( 0.55 + 0.45 * uStorm ), 0.0, 1.0 ) ) * uLight;
    colour += uFlash * vec3( 0.75, 0.82, 1.0 ) * ( 0.5 + 0.8 * thickness );
    // Low down they fade into the haze at the horizon.
    colour = mix( colour, uHorizon, ( 1.0 - smoothstep( 0.0, 0.3, direction.y ) ) * 0.75 );
    float alpha = mix( density * smoothstep( 0.0, 0.05, direction.y ), max( density, smoothstep( 0.55, 0.95, uCoverage ) ), smoothstep( 0.55, 0.95, uCoverage ) * ( 1.0 - smoothstep( 0.0, 0.3, direction.y ) ) );
    gl_FragColor = vec4( colour, alpha );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`;

export const STAR_VERTEX = /* glsl */ `
attribute float aSize;
attribute float aBrightness;
uniform float uTime;
varying float vBrightness;
void main() {
    vBrightness = aBrightness * ( 0.75 + 0.25 * sin( uTime * ( 1.5 + aBrightness * 3.0 ) + position.x * 0.37 ) );
    gl_PointSize = aSize;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );${AT_INFINITY}
}`;

export const STAR_FRAGMENT = /* glsl */ `
uniform float uOpacity;
varying float vBrightness;
void main() {
    float r = length( gl_PointCoord - 0.5 ) * 2.0;
    float glow = smoothstep( 1.0, 0.0, r );
    gl_FragColor = vec4( vec3( 0.9, 0.94, 1.0 ) * glow * vBrightness * uOpacity, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`;

export const MOON_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );${AT_INFINITY}
}`;

export const MOON_FRAGMENT = /* glsl */ `
uniform float uOpacity;
varying vec2 vUv;
float moonHash( vec2 p ) { return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }
float moonNoise( vec2 p ) {
    vec2 i = floor( p );
    vec2 f = fract( p );
    vec2 u = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( moonHash( i ), moonHash( i + vec2( 1.0, 0.0 ) ), u.x ),
                mix( moonHash( i + vec2( 0.0, 1.0 ) ), moonHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length( p );
    // The disc, its grey seas, and a glow round it.
    float disc = smoothstep( 0.36, 0.33, r );
    float seas = moonNoise( p * 4.0 ) * 0.6 + moonNoise( p * 9.0 ) * 0.4;
    vec3 surface = vec3( 0.95, 0.96, 1.0 ) * ( 0.78 + 0.22 * smoothstep( 0.35, 0.7, seas ) ) * 2.2;
    float halo = exp( -max( r - 0.3, 0.0 ) * 6.0 ) * 0.25 * ( 1.0 - disc );
    vec3 colour = surface * disc + vec3( 0.6, 0.7, 0.9 ) * halo;
    gl_FragColor = vec4( colour * uOpacity, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`;

export const BOLT_VERTEX = /* glsl */ `
attribute float aEdge;
varying float vEdge;
void main() {
    vEdge = aEdge;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );${AT_INFINITY}
}`;

export const BOLT_FRAGMENT = /* glsl */ `
uniform float uBrightness;
varying float vEdge;
void main() {
    float core = 1.0 - abs( vEdge );
    vec3 colour = vec3( 0.75, 0.82, 1.0 ) * ( core * core * 6.0 + core * 1.5 ) * uBrightness;
    gl_FragColor = vec4( colour, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`;

/** A material for something at infinity on the sky. */
export const skyMaterial = (vertexShader: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform>, additive: boolean): THREE.ShaderMaterial =>
    new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        fog: false,
        side: THREE.DoubleSide,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
