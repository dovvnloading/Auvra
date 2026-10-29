import * as THREE from 'three';
import { COVER_CELLS, OPEN_SKY, type WeatherCover } from './weatherCover';
import { windUniforms } from './wind';

/**
 * WEATHER AND WIND ON SURFACES
 *
 * Rain darkens what it falls on and makes it shine, pooling into puddles on flat ground; snow
 * settles on what faces up, patchily while it is thin. Done in the lit materials' own shaders: a
 * standard or physical material is patched once, and then every patched material reads the same
 * few uniforms, so a change in the weather costs nothing per material. Under cover (see
 * weatherCover) surfaces stay dry. Materials with a shader patch of their own are left alone unless
 * they say they take the weather (userData.weatherSurface, as the terrain's do).
 *
 * Foliage sways in the wind the same way: leaves, grass and the like (found by their materials'
 * names, or set on an object by a Wind Sway component) bend from the base, more toward the top,
 * gusting with the wind, leaves fluttering. A material's sway is part of its patch, so one program
 * serves every material that sways and weathers alike.
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
varying vec3 vWeatherWorld;
#ifdef AUVRA_WIND
uniform float uWindTime;
uniform vec2 uWindDirection;
uniform float uWindStrength;
uniform float uWindSway;
uniform float uWindFlutter;
uniform float uWindBottom;
uniform float uWindHeight;
#endif`;

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
}
#ifdef AUVRA_WIND
{
    // Bends from the base, more toward the top (the square of the height up the plant).
    float windUp = clamp( ( transformed.y - uWindBottom ) / max( uWindHeight, 1e-4 ), 0.0, 1.3 );
    float windScale = length( modelMatrix[ 1 ].xyz );
    vec4 windOrigin = vec4( 0.0, 0.0, 0.0, 1.0 );
    #ifdef USE_INSTANCING
        windScale *= length( instanceMatrix[ 1 ].xyz );
        windOrigin = instanceMatrix * windOrigin;
    #endif
    windOrigin = modelMatrix * windOrigin;
    float windTall = uWindHeight * windScale;
    float windPhase = dot( windOrigin.xz, vec2( 0.37, 0.61 ) );
    // A lean with the wind that swells and eases, and a sway about it.
    float windLean = uWindStrength * ( 0.55 + 0.25 * sin( uWindTime * 1.1 + windPhase ) + 0.12 * sin( uWindTime * 2.7 + windPhase * 1.9 ) );
    float windBend = windUp * windUp * uWindSway * 0.012 * windLean * windTall;
    vec3 windOffset = vec3( uWindDirection.x, -0.15 * abs( windBend ) / max( windTall, 1e-3 ), uWindDirection.y ) * windBend;
    // Leaves flutter across the wind, quickly and each a little differently.
    float windFlick = sin( uWindTime * 7.0 + windPhase * 5.0 + dot( transformed, vec3( 3.1, 2.3, 2.9 ) ) );
    windOffset += vec3( -uWindDirection.y, 0.4, uWindDirection.x ) * windFlick * uWindFlutter * min( uWindStrength, 20.0 ) * 0.0025 * windUp * min( windTall, 6.0 );
    mvPosition.xyz += ( viewMatrix * vec4( windOffset, 0.0 ) ).xyz;
    gl_Position = projectionMatrix * mvPosition;
}
#endif`;

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
        const wind = windOf(material);
        if (wind) {
            Object.assign(shader.uniforms, windUniforms, materialWindUniforms(material));
            shader.vertexShader = `#define AUVRA_WIND\n${shader.vertexShader}`;
        }
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
        return material.onBeforeCompile === patch ? `${base}|${PROGRAM_KEY}${windOf(material) ? '|wind' : ''}` : base;
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

// ---------------------------------------------------------------------------
// Wind

/** Materials whose names mean leaves, grass or the like: they sway and flutter. */
export const FOLIAGE_MATERIAL = /leaf|leaves|foliage|grass|bush|shrub|plant|needle|frond|fern|flower|petal|reed|hedge|ivy|vine|canopy/i;
/** Woody parts: they sway a little and do not flutter. */
export const WOODY_MATERIAL = /bark|trunk|branch|stem|stalk|twig/i;

export interface WindSway {
    /** How far it bends: 1 for leaves and grass. */
    sway: number;
    /** How much its leaves flutter: 0-1. */
    flutter: number;
}

/** How a material of this name sways by default; null: it does not. */
export const swayOfMaterial = (name: string | undefined): WindSway | null => {
    if (!name) return null;
    if (FOLIAGE_MATERIAL.test(name)) return { sway: 1, flutter: 1 };
    if (WOODY_MATERIAL.test(name)) return { sway: 0.35, flutter: 0 };
    return null;
};

/** The sway a patched material was given, when it sways. */
const windOf = (material: THREE.Material): WindSway | null => {
    const wind = material.userData.windSway as WindSway | undefined;
    return wind && wind.sway > 0 ? wind : null;
};

/** Its own sway and where its plant's base and top are (in its geometry's space). */
const materialWindUniforms = (material: THREE.Material): Record<string, THREE.IUniform> => {
    let uniforms = material.userData.windUniforms as Record<string, THREE.IUniform> | undefined;
    if (!uniforms) {
        uniforms = { uWindSway: { value: 0 }, uWindFlutter: { value: 0 }, uWindBottom: { value: 0 }, uWindHeight: { value: 1 } };
        material.userData.windUniforms = uniforms;
    }
    const wind = windOf(material);
    const shape = material.userData.windShape as { bottom: number; height: number } | undefined;
    uniforms.uWindSway.value = wind?.sway ?? 0;
    uniforms.uWindFlutter.value = wind?.flutter ?? 0;
    uniforms.uWindBottom.value = shape?.bottom ?? 0;
    uniforms.uWindHeight.value = Math.max(1e-3, shape?.height ?? 1);
    return uniforms;
};

/** The nearest Wind Sway set on the mesh or above it (userData.windSway); undefined: none. */
const swayOverride = (node: THREE.Object3D): WindSway | null | undefined => {
    for (let current: THREE.Object3D | null = node; current; current = current.parent) {
        const value = current.userData.windSway as WindSway | null | undefined;
        if (value !== undefined) return value && value.sway > 0 ? value : null;
        if (current.userData.levelObjectId !== undefined) break;
    }
    return undefined;
};

const _box = new THREE.Box3();
const _point = new THREE.Vector3();
const _toLocal = new THREE.Matrix4();

/**
 * Where a mesh's plant stands in the mesh's own space: the bottom and height of the whole object
 * it belongs to (all its meshes), so a trunk and its leaves bend as one.
 */
const plantShape = (mesh: THREE.Mesh): { bottom: number; height: number } => {
    let root: THREE.Object3D = mesh;
    for (let current: THREE.Object3D | null = mesh; current; current = current.parent) {
        root = current;
        if (current.userData.levelObjectId !== undefined) break;
    }
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
        // Instanced parts share their model's space: the union of their geometries.
        _box.makeEmpty();
        for (const sibling of mesh.parent?.children ?? [mesh]) {
            const geometry = (sibling as THREE.Mesh).geometry;
            if (!geometry) continue;
            if (!geometry.boundingBox) geometry.computeBoundingBox();
            if (geometry.boundingBox) _box.union(geometry.boundingBox);
        }
        if (_box.isEmpty()) return { bottom: 0, height: 1 };
        return { bottom: _box.min.y, height: Math.max(1e-3, _box.max.y - _box.min.y) };
    }
    root.updateWorldMatrix(true, true);
    _box.setFromObject(root, true);
    if (_box.isEmpty()) return { bottom: 0, height: 1 };
    _toLocal.copy(mesh.matrixWorld).invert();
    _box.getCenter(_point);
    const bottom = _point.clone().setY(_box.min.y).applyMatrix4(_toLocal).y;
    const top = _point.clone().setY(_box.max.y).applyMatrix4(_toLocal).y;
    return { bottom: Math.min(bottom, top), height: Math.max(1e-3, Math.abs(top - bottom)) };
};

/**
 * Gives every swaying material under `root` its sway and shape and patches it (once; a material
 * whose sway changes recompiles). Returns how many changed.
 */
export const patchWindSurfaces = (root: THREE.Object3D): number => {
    let changed = 0;
    root.traverse(object => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh || mesh.userData.noWeather || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
        const override = swayOverride(mesh);
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
            if (!material || !(material as THREE.MeshStandardMaterial).isMeshStandardMaterial) continue;
            const wanted = override === undefined ? swayOfMaterial(material.name) : override;
            const had = windOf(material);
            if (!wanted && !had) continue;
            if (wanted && had && wanted.sway === had.sway && wanted.flutter === had.flutter && material.userData.windShape) continue;
            material.userData.windSway = wanted ? { ...wanted } : null;
            if (wanted && !material.userData.windShape) material.userData.windShape = plantShape(mesh);
            materialWindUniforms(material);
            if (!isWeatherPatched(material)) {
                if (!patchWeatherMaterial(material)) continue;
            } else if (Boolean(had) !== Boolean(wanted)) material.needsUpdate = true;
            changed++;
        }
    });
    return changed;
};

/** Whether a material has been patched (tests). */
export const isWeatherPatched = (material: THREE.Material): boolean => patched.has(material);
