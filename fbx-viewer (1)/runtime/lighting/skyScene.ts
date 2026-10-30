import * as THREE from 'three';
import { CLOUD_EDGE } from '../sky/atmosphere';
import './bakedLighting';

/**
 * THE SKY IN EVERY LIT MATERIAL
 *
 * Three things the sky gives every lit material, without patching any of them: distant fog that melts into
 * the sky behind it in each direction, the shadows of the clouds, and sky visibility, which shuts the Sky
 * Light out of what is covered. They come from one small atlas and a few values, set as each scene starts
 * drawing, so views and canvases with different skies, or none, each draw with their own.
 *
 * Atlas (768 x 512), half-float:
 *   left  512 x 512: sky visibility around the camera, R over the top of what stands there, G under it, B its height
 *   right 256 x 128 at the bottom: the sky-view table
 *   right 256 x 256 at the top: the clouds' weather map
 */

export const SKY_ATLAS_WIDTH = 768;
export const SKY_ATLAS_HEIGHT = 512;

export const skyAtlas = new THREE.WebGLRenderTarget(SKY_ATLAS_WIDTH, SKY_ATLAS_HEIGHT, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
});
skyAtlas.texture.name = 'SkyAtlas';

/** A value every material's copy of the uniforms shares: three copies uniform values per material. */
class SharedVector4 extends THREE.Vector4 {
    override clone(): this { return this; }
}

/** rgb: scale on the sky's colour; a: 0 when fog keeps its own colour, else 1 plus how far it takes the sky's. */
const fog = new SharedVector4();
/** x: how grey heavy cloud has made the air, as the dome shows it. */
const fogGrey = new SharedVector4();
/** x: how far covered places lose the sky; y: the least they keep; z: scale on reflections; w: 1 when the sky light is on. */
const light = new SharedVector4();
/** x, y: the visibility map's corner in the world's x and z; z: 1 / its side; w: the height its heights count from. */
const area = new SharedVector4();
/** x: weather map tiles per metre; y, z: its drift; w: below this much cloud, none. */
const cloudMap = new SharedVector4();
/** x, y: how the sun's rays lean per metre of height; z: the clouds' height; w: how dark their shadow. */
const cloudSun = new SharedVector4();

export const SKY_SCENE_UNIFORMS = {
    // One texture in an array: three copies arrays by reference to what they hold, and never a render target otherwise.
    auvraSkyAtlas: { value: [skyAtlas.texture] },
    auvraSkyFog: { value: fog },
    auvraSkyFogGrey: { value: fogGrey },
    auvraSkyLight: { value: light },
    auvraSkyArea: { value: area },
    auvraCloudMap: { value: cloudMap },
    auvraCloudSun: { value: cloudSun },
};

const PARS = /* glsl */ `
#if defined( STANDARD ) || defined( LAMBERT ) || defined( PHONG ) || defined( TOON )
#define AUVRA_SKY
uniform sampler2D auvraSkyAtlas[ 1 ];
uniform vec4 auvraSkyFog;
uniform vec4 auvraSkyFogGrey;
uniform vec4 auvraSkyLight;
uniform vec4 auvraSkyArea;
uniform vec4 auvraCloudMap;
uniform vec4 auvraCloudSun;

vec3 auvraWorldPoint( const in vec3 viewPoint ) {
	return ( vec4( viewPoint, 0.0 ) * viewMatrix ).xyz + cameraPosition;
}

// The sky behind a point, for the fog in front of it: never below the horizon, where it would be the ground's colour.
vec3 auvraSkyColour( vec3 direction ) {
	direction.y = max( direction.y, 0.035 );
	direction = normalize( direction );
	float latitude = asin( direction.y );
	float v = 0.5 + 0.5 * sqrt( latitude / 1.570796 );
	float u = clamp( atan( direction.z, direction.x ) / 6.283185 + 0.5, 0.002, 0.998 );
	vec2 uv = vec2( ( 512.0 + u * 256.0 ) / ${SKY_ATLAS_WIDTH.toFixed(1)}, ( v * 128.0 ) / ${SKY_ATLAS_HEIGHT.toFixed(1)} );
	vec3 sky = texture2D( auvraSkyAtlas[ 0 ], uv ).rgb * auvraSkyFog.rgb;
	return mix( sky, vec3( dot( sky, vec3( 0.2126, 0.7152, 0.0722 ) ) ), auvraSkyFogGrey.x );
}

// How much the clouds overhead let the sun through at a point.
float auvraCloudShade( const in vec3 point ) {
	if ( auvraCloudSun.w <= 0.0 ) return 1.0;
	vec2 at = fract( ( point.xz + auvraCloudSun.xy * ( auvraCloudSun.z - point.y ) ) * auvraCloudMap.x + auvraCloudMap.yz );
	vec2 uv = vec2( ( 512.5 + at.x * 255.0 ) / ${SKY_ATLAS_WIDTH.toFixed(1)}, ( 256.5 + at.y * 255.0 ) / ${SKY_ATLAS_HEIGHT.toFixed(1)} );
	float amount = texture2D( auvraSkyAtlas[ 0 ], uv ).r;
	return 1.0 - auvraCloudSun.w * smoothstep( auvraCloudMap.w, auvraCloudMap.w + ${CLOUD_EDGE.toFixed(2)}, amount );
}

// How much of the sky a point can see: over the top of what stands there, or from under it by how open the place around is.
// A wall is read a little out from itself, where the map shows the ground it stands on and not its own top.
float auvraSkyVisibility( const in vec3 point, const in vec3 normal ) {
	vec2 uv = ( point.xz + normal.xz * 3.0 / ( 512.0 * auvraSkyArea.z ) - auvraSkyArea.xy ) * auvraSkyArea.z;
	vec2 inside = min( uv, 1.0 - uv );
	float fade = smoothstep( 0.0, 0.08, min( inside.x, inside.y ) );
	if ( fade <= 0.0 ) return 1.0;
	vec3 sampled = texture2D( auvraSkyAtlas[ 0 ], vec2( clamp( uv.x, 0.001, 0.999 ) * 512.0 / ${SKY_ATLAS_WIDTH.toFixed(1)}, clamp( uv.y, 0.001, 0.999 ) ) ).rgb;
	float under = sampled.b - ( point.y - auvraSkyArea.w );
	float seen = mix( sampled.r, sampled.g, smoothstep( 0.3, 1.4, under ) );
	// A wall only ever faced half the sky: it loses less of what it had than the ground does.
	seen = mix( sqrt( seen ), seen, abs( normal.y ) );
	return max( mix( 1.0, seen, fade * auvraSkyLight.x ), auvraSkyLight.y );
}
#endif
`;

const AFTER_MAPS = /* glsl */ `
#if defined( AUVRA_SKY ) && defined( USE_ENVMAP ) && defined( STANDARD )
	if ( auvraSkyLight.w > 0.5 ) {
		float auvraSeen = auvraSkyVisibility( auvraWorldPoint( geometryPosition ), inverseTransformDirection( geometryNormal, viewMatrix ) );
		#if defined( RE_IndirectDiffuse )
			#ifdef AUVRA_BAKED_GI
				iblIrradiance *= mix( auvraSeen, 1.0, bakedGiBlend );
			#else
				iblIrradiance *= auvraSeen;
			#endif
		#endif
		#if defined( RE_IndirectSpecular ) && ! defined( AUVRA_LOCAL_REFLECTION )
			radiance *= auvraSeen * auvraSkyLight.z;
			#ifdef USE_CLEARCOAT
				clearcoatRadiance *= auvraSeen * auvraSkyLight.z;
			#endif
		#endif
	}
#endif
`;

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	vec3 fogTint = fogColor;
	#ifdef AUVRA_SKY
		if ( auvraSkyFog.a > 0.0 ) {
			// Fog is drawn after tone mapping, so a colour meant to match the sky must be mapped as the sky is.
			fogTint = mix( fogColor, auvraSkyColour( ( vec4( - vViewPosition, 0.0 ) * viewMatrix ).xyz ), auvraSkyFog.a - 1.0 );
			#if defined( TONE_MAPPING )
				fogTint = toneMapping( fogTint );
			#endif
			fogTint = linearToOutputTexel( vec4( fogTint, 1.0 ) ).rgb;
		}
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogTint, fogFactor );
#endif
`;

/** Marks the patched chunks, so a second load of this module (a hot reload) does not patch them again. */
const INSTALLED_MARK = '// auvra sky scene';

/** What one scene's sky gives its materials. */
export interface SceneSky {
    fogScale: [number, number, number];
    /** Fog follows the sky, drawn as the sky is. Otherwise it is a plain colour. */
    fogFollowsSky: boolean;
    /** How far it takes the sky's colour over the weather's: 0 none (thick mist), 1 all the sky's. */
    fogShare: number;
    /** How grey heavy cloud has made the air, 0-1. */
    fogGrey: number;
    lightOn: boolean;
    occlusion: number;
    occlusionFloor: number;
    reflections: number;
    /** Visibility map: its corner (world x and z), side and height origin. */
    areaX: number;
    areaZ: number;
    areaSize: number;
    areaY: number;
    /** Weather map tiles per metre, its drift, and the amount under which there is no cloud. */
    cloudTiling: number;
    cloudDriftU: number;
    cloudDriftV: number;
    cloudThreshold: number;
    /** Sun's lean per metre, the clouds' height and how dark their shadow (0: none). */
    cloudLeanX: number;
    cloudLeanZ: number;
    cloudHeight: number;
    cloudStrength: number;
}

const skies = new Map<THREE.Object3D, SceneSky>();
const paused = new Set<THREE.Object3D>();

/**
 * Draws `scene` without its sky's effects until the returned function is called. A bake sees the real
 * occlusion for itself, and must not take in the shadow of a cloud that happens to be passing.
 */
export const pauseSceneSky = (scene: THREE.Object3D): (() => void) => {
    paused.add(scene);
    return () => {
        paused.delete(scene);
    };
};

/** Draws `scene` with `sky` until the returned function is called. */
export const setSceneSky = (scene: THREE.Object3D, sky: SceneSky): (() => void) => {
    skies.set(scene, sky);
    return () => {
        if (skies.get(scene) === sky) skies.delete(scene);
    };
};

/** Points the shared uniforms at `scene`'s sky, or turns them off; runs as each scene starts drawing. */
export const applySceneSky = (scene: THREE.Object3D): void => {
    const sky = skies.get(scene);
    if (!sky || paused.has(scene)) {
        fog.w = 0;
        light.w = 0;
        cloudSun.w = 0;
        return;
    }
    fog.set(sky.fogScale[0], sky.fogScale[1], sky.fogScale[2], sky.fogFollowsSky ? 1 + sky.fogShare : 0);
    fogGrey.x = sky.fogGrey;
    light.set(sky.occlusion, sky.occlusionFloor, sky.reflections, sky.lightOn ? 1 : 0);
    area.set(sky.areaX, sky.areaZ, 1 / Math.max(sky.areaSize, 1e-3), sky.areaY);
    cloudMap.set(sky.cloudTiling, sky.cloudDriftU, sky.cloudDriftV, sky.cloudThreshold);
    cloudSun.set(sky.cloudLeanX, sky.cloudLeanZ, sky.cloudHeight, sky.cloudStrength);
};

/**
 * Teaches three's lit materials to read the sky. Runs once, before any of them compiles: it edits the
 * shared shader chunks and the uniforms each material copies when its program is built.
 */
export const installSkyScene = (): void => {
    if (!THREE.ShaderChunk.lights_pars_begin.includes(INSTALLED_MARK)) {
        THREE.ShaderChunk.lights_pars_begin += `\n${INSTALLED_MARK}\n${PARS}`;
        THREE.ShaderChunk.lights_fragment_maps += AFTER_MAPS;
        (THREE.ShaderChunk as Record<string, string>).fog_fragment = FOG_FRAGMENT;
    }
    for (const name of ['standard', 'physical', 'lambert', 'phong', 'toon'] as const) {
        Object.assign(THREE.ShaderLib[name].uniforms, SKY_SCENE_UNIFORMS);
    }
    const before = THREE.Scene.prototype.onBeforeRender as (this: THREE.Scene, ...args: unknown[]) => void;
    const marked = before as unknown as { auvraSky?: boolean };
    if (marked.auvraSky) return;
    const chained = function onBeforeRender(this: THREE.Scene, ...args: unknown[]) {
        before.apply(this, args);
        applySceneSky(this);
    };
    (chained as unknown as { auvraSky: boolean }).auvraSky = true;
    THREE.Scene.prototype.onBeforeRender = chained as typeof THREE.Scene.prototype.onBeforeRender;
};

installSkyScene();
