import * as THREE from 'three';
import { COVER_CELLS, OPEN_SKY, type WeatherCover } from './weatherCover';

/**
 * WEATHER ON SURFACES
 *
 * Rain darkens what it falls on and makes it shine, pooling into puddles on flat ground; snow
 * settles on what faces up, patchily while it is thin. Done in the lit materials' own shaders: a
 * standard or physical material is patched once, and then every patched material reads the same
 * few uniforms, so a change in the weather costs nothing per material. Under cover (see
 * weatherCover) surfaces stay dry. Materials with a shader patch of their own are left alone unless
 * they say they take the weather (userData.weatherSurface, as the terrain's do).
 */

const coverData = new Float32Array(COVER_CELLS * COVER_CELLS).fill(OPEN_SKY);
const coverTexture = new THREE.DataTexture(coverData, COVER_CELLS, COVER_CELLS, THREE.RedFormat, THREE.FloatType);
coverTexture.minFilter = THREE.NearestFilter;
coverTexture.magFilter = THREE.NearestFilter;
coverTexture.needsUpdate = true;

/** Shared by every patched material. */
export const WEATHER_UNIFORMS = {
    uWeatherWetness: { value: 0 },
    uWeatherSnow: { value: 0 },
    uWeatherCover: { value: coverTexture as THREE.Texture },
    uWeatherCoverOn: { value: 0 },
    uWeatherCoverOrigin: { value: new THREE.Vector2() },
    uWeatherCoverCell: { value: 1 },
};

let coverVersion = -1;

/** Sets how wet and snowy surfaces are, and (in play) what covers them. */
export const setSurfaceWeather = (wetness: number, snow: number, cover: WeatherCover | null): void => {
    WEATHER_UNIFORMS.uWeatherWetness.value = wetness;
    WEATHER_UNIFORMS.uWeatherSnow.value = snow;
    WEATHER_UNIFORMS.uWeatherCoverOn.value = cover ? 1 : 0;
    if (!cover || cover.cells !== COVER_CELLS) return;
    WEATHER_UNIFORMS.uWeatherCoverOrigin.value.set(cover.originX, cover.originZ);
    WEATHER_UNIFORMS.uWeatherCoverCell.value = cover.cellSize;
    if (cover.version === coverVersion) return;
    coverVersion = cover.version;
    const heights = cover.heights;
    for (let i = 0; i < coverData.length; i++) coverData[i] = Number.isNaN(heights[i]) ? OPEN_SKY : heights[i];
    coverTexture.needsUpdate = true;
};

const VERTEX_HEAD = /* glsl */ `
varying vec3 vWeatherWorld;`;

const VERTEX_BODY = /* glsl */ `
{
    vec4 weatherWorld = vec4( transformed, 1.0 );
    #ifdef USE_BATCHING
        weatherWorld = batchingMatrix * weatherWorld;
    #endif
    #ifdef USE_INSTANCING
        weatherWorld = instanceMatrix * weatherWorld;
    #endif
    vWeatherWorld = ( modelMatrix * weatherWorld ).xyz;
}`;

const FRAGMENT_HEAD = /* glsl */ `
varying vec3 vWeatherWorld;
uniform float uWeatherWetness;
uniform float uWeatherSnow;
uniform sampler2D uWeatherCover;
uniform float uWeatherCoverOn;
uniform vec2 uWeatherCoverOrigin;
uniform float uWeatherCoverCell;
float weatherHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float weatherNoise( vec2 p ) {
    vec2 i = floor( p );
    vec2 f = fract( p );
    vec2 u = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( weatherHash( i ), weatherHash( i + vec2( 1.0, 0.0 ) ), u.x ),
                mix( weatherHash( i + vec2( 0.0, 1.0 ) ), weatherHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
float weatherOpenAt( ivec2 cell, float y ) {
    if ( any( lessThan( cell, ivec2( 0 ) ) ) || any( greaterThanEqual( cell, ivec2( ${COVER_CELLS} ) ) ) ) return 1.0;
    float top = texelFetch( uWeatherCover, cell, 0 ).r;
    return smoothstep( top - 0.6, top - 0.2, y );
}
// How open to the sky this point is: 1 out in the weather, 0 under a roof (blended between cells).
float weatherOpen() {
    if ( uWeatherCoverOn < 0.5 ) return 1.0;
    vec2 g = ( vWeatherWorld.xz - uWeatherCoverOrigin ) / uWeatherCoverCell - 0.5;
    ivec2 c = ivec2( floor( g ) );
    vec2 f = fract( g );
    float y = vWeatherWorld.y;
    return mix(
        mix( weatherOpenAt( c, y ), weatherOpenAt( c + ivec2( 1, 0 ), y ), f.x ),
        mix( weatherOpenAt( c + ivec2( 0, 1 ), y ), weatherOpenAt( c + ivec2( 1, 1 ), y ), f.x ),
        f.y );
}`;

const FRAGMENT_BODY = /* glsl */ `
if ( uWeatherWetness + uWeatherSnow > 0.001 ) {
    float weatherFacing = dot( normal, normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz ) );
    float weatherSky = weatherOpen();
    float weatherPatch = weatherNoise( vWeatherWorld.xz * 0.6 ) * 0.65 + weatherNoise( vWeatherWorld.xz * 2.3 ) * 0.35;
    // Snow on what faces up, thin and patchy at first.
    float weatherSnowAmount = weatherSky * smoothstep( 0.0, 0.25, uWeatherSnow * 1.25 - ( 1.0 - weatherFacing ) * 0.9 - weatherPatch * 0.35 );
    // Wet: darker and glossier, vertical faces less, flat ground pooling into puddles.
    float weatherWet = uWeatherWetness * weatherSky * ( 1.0 - weatherSnowAmount ) * ( 0.6 + 0.4 * clamp( weatherFacing, 0.0, 1.0 ) );
    float weatherPuddle = weatherWet * smoothstep( 0.5, 0.68, weatherPatch + uWeatherWetness * 0.12 ) * pow( clamp( weatherFacing, 0.0, 1.0 ), 6.0 );
    diffuseColor.rgb *= 1.0 - 0.42 * weatherWet - 0.2 * weatherPuddle;
    roughnessFactor = mix( roughnessFactor, min( roughnessFactor, 0.22 ), weatherWet );
    roughnessFactor = mix( roughnessFactor, 0.03, weatherPuddle );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.86, 0.89, 0.93 ), weatherSnowAmount );
    roughnessFactor = mix( roughnessFactor, 0.75, weatherSnowAmount );
    metalnessFactor = mix( metalnessFactor, 0.0, weatherSnowAmount );
}`;

const PROGRAM_KEY = 'auvra-weather-1';
const patched = new WeakSet<THREE.Material>();

const takesWeather = (material: THREE.Material): material is THREE.MeshStandardMaterial => {
    if (!(material as THREE.MeshStandardMaterial).isMeshStandardMaterial) return false;
    if (material.userData.noWeather) return false;
    return material.onBeforeCompile === THREE.Material.prototype.onBeforeCompile || material.userData.weatherSurface === true;
};

/** Patches one material to take the weather (once; false when it does not take it). */
export const patchWeatherMaterial = (material: THREE.Material): boolean => {
    if (patched.has(material)) return true;
    if (!takesWeather(material)) return false;
    patched.add(material);
    const before = material.onBeforeCompile;
    const ownKey = Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey')
        ? material.customProgramCacheKey.bind(material)
        : null;
    const beforeSource = before.toString();
    const patch: THREE.Material['onBeforeCompile'] = (shader, renderer) => {
        before.call(material, shader, renderer);
        if (!shader.fragmentShader.includes('#include <lights_physical_fragment>')) return;
        Object.assign(shader.uniforms, WEATHER_UNIFORMS);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>${VERTEX_HEAD}`)
            .replace('#include <project_vertex>', `#include <project_vertex>${VERTEX_BODY}`);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>${FRAGMENT_HEAD}`)
            .replace('#include <lights_physical_fragment>', `${FRAGMENT_BODY}\n#include <lights_physical_fragment>`);
    };
    material.onBeforeCompile = patch;
    // Programs are shared by key: a patched material must not share one with an unpatched one, and if
    // something later replaces the patch, the key goes back to what it was.
    material.customProgramCacheKey = () => {
        const base = ownKey ? ownKey() : (material.onBeforeCompile === patch ? beforeSource : material.onBeforeCompile.toString());
        return material.onBeforeCompile === patch ? `${base}|${PROGRAM_KEY}` : base;
    };
    material.needsUpdate = true;
    return true;
};

/** Patches every lit material under `root` that takes the weather; returns how many were new. */
export const patchWeatherSurfaces = (root: THREE.Object3D): number => {
    let count = 0;
    root.traverse(object => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh || mesh.userData.noWeather) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
            if (material && !patched.has(material) && patchWeatherMaterial(material)) count++;
        }
    });
    return count;
};

/** Whether a material has been patched (tests). */
export const isWeatherPatched = (material: THREE.Material): boolean => patched.has(material);
