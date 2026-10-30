import * as THREE from 'three';

/**
 * DISTANCE SHADOWS
 *
 * The sun's own shadow map is sharp but covers only the area around what the camera looks at. Distance
 * shadows add cascades: shadow-only lights (black, so they light nothing) facing the same way as the
 * sun, each with a map fitted to a wider slice of the view, out to the shadow distance. Every lit
 * material shares one lighting chunk that, where the sun's own map does not reach a point, takes the
 * shadow from the nearest cascade map that covers it, blending across the edge.
 *
 * It is all in the shared chunk, so no material needs patching: a light is a cascade of a lit light
 * when it casts shadows, has no colour and faces the same way. Cascade maps are fitted to the sphere
 * around their slice of the view (the same size however the camera turns) and moved in whole texels,
 * so their shadows hold still as the camera moves. Each map hands over to the next across its edge,
 * and the last fades out, so no seam or end line shows.
 *
 * The slices start where the sun's own map stops and reach the shadow distance past what an orbiting
 * camera looks at: up close the near map is sharp; pulled back (an overview in the editor) everything
 * moves out with the view. A camera that orbits nothing, as in play, counts from itself.
 */

/** Share of a shadow map, at its edges, over which the sun's own shadow hands over to a cascade's. */
export const DISTANCE_SHADOW_BLEND = 0.04;
/** With distance shadows on, the sun's own map covers the view's first this many units, sharp. */
export const NEAR_SHADOW_REACH = 25;
/** Default reach of distance shadows (world units). */
export const DEFAULT_SHADOW_DISTANCE = 250;
/**
 * Cascades beyond the sun's own map whenever distance shadows are on. Always the same number, so
 * changing the distance (scrubbing it in the inspector) never changes the light count every lit
 * material is compiled for.
 */
export const SHADOW_CASCADES = 2;
/** The most a look adds to the reach (world units). */
const MAX_LOOK_DISTANCE = 2000;
/** The near map's reach per unit of look, and the ratio it changes in, so a zoom re-fits it only now and then. */
const LOOK_REACH = 1.2;
const LOOK_REACH_STEP = 1.25;
/** How far behind its slice a cascade's light stands, so what stands between it and the sun still casts. */
const CASCADE_BACKOFF = 600;

/** The parts of three.js's chunk distance shadows replace, matched whatever their indentation. */
const DIRECTIONAL_DECLARATION = /DirectionalLight directionalLight;\s*#if defined\( USE_SHADOWMAP \) && NUM_DIR_LIGHT_SHADOWS > 0\s*DirectionalLightShadow directionalLightShadow;\s*#endif/;
const DIRECTIONAL_SHADOW = /#if defined\( USE_SHADOWMAP \) && \( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS \)\s*directionalLightShadow = directionalLightShadows\[ i \];\s*directLight\.color \*= [^;]*;\s*#endif\s*(RE_Direct\( directLight,[^;]*;)/;

const BLEND = DISTANCE_SHADOW_BLEND.toFixed(3);

/** Before the directional lights: the nearest cascade covering the point, where the lit light's own map does not. */
const CASCADE_SEARCH = /* glsl */ `
	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	// Distance shadows: see runtime/lighting/distanceShadows.ts.
	vec3 shadowCascadeCoord;
	float shadowCascadeEdge;
	float shadowCascadeSample;
	float shadowCascade = 1.0;
	bool shadowCascadeFound = false;
	bool shadowCascadeBlended = false;
	float shadowCascadeFirstEdge = 0.0;
	vec3 shadowCascadeDirection = vec3( 0.0 );
	vec3 shadowCoveredDirection = vec3( 0.0 );
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
		shadowCascadeCoord = vDirectionalShadowCoord[ i ].xyz / vDirectionalShadowCoord[ i ].w;
		shadowCascadeEdge = shadowCascadeCoord.z > 1.0 ? - 1.0 : min( min( shadowCascadeCoord.x, 1.0 - shadowCascadeCoord.x ), min( shadowCascadeCoord.y, 1.0 - shadowCascadeCoord.y ) );
		if ( dot( directionalLights[ i ].color, directionalLights[ i ].color ) > 0.0 ) {
			if ( shadowCascadeEdge > ${BLEND} ) shadowCoveredDirection = directionalLights[ i ].direction;
		} else if ( receiveShadow && shadowCascadeEdge > 0.002 && dot( directionalLights[ i ].direction, shadowCoveredDirection ) < 0.999 && ( ! shadowCascadeFound || ( ! shadowCascadeBlended && shadowCascadeFirstEdge < ${BLEND} && dot( directionalLights[ i ].direction, shadowCascadeDirection ) > 0.999 ) ) ) {
			directionalLightShadow = directionalLightShadows[ i ];
			shadowCascadeSample = getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] );
			if ( shadowCascadeFound ) {
				// Near the nearer cascade's edge, eased into this farther one: cascades meet without a seam.
				shadowCascade = mix( shadowCascadeSample, shadowCascade, smoothstep( 0.0, ${BLEND}, shadowCascadeFirstEdge ) );
				shadowCascadeBlended = true;
			} else {
				shadowCascade = shadowCascadeSample;
				shadowCascadeDirection = directionalLights[ i ].direction;
				shadowCascadeFirstEdge = shadowCascadeEdge;
				shadowCascadeFound = true;
			}
		}
	}
	#pragma unroll_loop_end
	// At the last cascade's edge the shadows fade out instead of stopping at a line.
	if ( shadowCascadeFound && ! shadowCascadeBlended ) shadowCascade = mix( 1.0, shadowCascade, smoothstep( 0.0, ${BLEND}, shadowCascadeFirstEdge ) );
	#endif`;

/** A lit light's shadow: its own map's, handing over at its edges to the cascade facing its way. Cascades (and dark lights) shade nothing and cost no lighting. */
const CASCADED_SHADOW = /* glsl */ `
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		if ( dot( directionalLight.color, directionalLight.color ) > 0.0 ) {
			directionalLightShadow = directionalLightShadows[ i ];
			shadowCascadeCoord = vDirectionalShadowCoord[ i ].xyz / vDirectionalShadowCoord[ i ].w;
			shadowCascadeEdge = shadowCascadeCoord.z > 1.0 ? - 1.0 : min( min( shadowCascadeCoord.x, 1.0 - shadowCascadeCoord.x ), min( shadowCascadeCoord.y, 1.0 - shadowCascadeCoord.y ) );
			directLight.color *= ( directLight.visible && receiveShadow ) ? mix(
				( shadowCascadeFound && dot( directionalLight.direction, shadowCascadeDirection ) > 0.999 ) ? shadowCascade : 1.0,
				getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ),
				smoothstep( 0.0, ${BLEND}, shadowCascadeEdge )
			) : 1.0;
			#ifdef AUVRA_SKY
				if ( receiveShadow ) directLight.color *= auvraCloudShade( auvraWorldPoint( geometryPosition ) );
			#endif
		}
		#endif
		if ( dot( directLight.color, directLight.color ) > 0.0 ) $DIRECT`;

/** three.js's lighting chunk with distance shadows, or null when the chunk is not the one this was written against. */
export const cascadedLightsChunk = (chunk: string): string | null => {
    if (!DIRECTIONAL_DECLARATION.test(chunk) || !DIRECTIONAL_SHADOW.test(chunk)) return null;
    return chunk
        .replace(DIRECTIONAL_DECLARATION, () => CASCADE_SEARCH.trim())
        .replace(DIRECTIONAL_SHADOW, (_match, direct: string) => CASCADED_SHADOW.trim().replace('$DIRECT', () => direct));
};

let installed: boolean | null = null;

/** Puts the distance-shadow lighting chunk in place for every lit material compiled from now on; returns whether it could. */
export const installDistanceShadows = (): boolean => {
    if (installed !== null) return installed;
    const chunk = cascadedLightsChunk(THREE.ShaderChunk.lights_fragment_begin);
    installed = chunk !== null;
    if (chunk) (THREE.ShaderChunk as Record<string, string>).lights_fragment_begin = chunk;
    return installed;
};

const _eye = new THREE.Vector3();

/**
 * How far the camera is from what it orbits (`controls`, the view's default controls): 0 without an
 * orbit, and `held`, the last answer, while the orbit is off (the editor's fly camera, which orbits the
 * same distance again afterwards).
 */
export const lookDistance = (camera: THREE.Camera, controls: unknown, held: number): number => {
    const orbit = controls as { target?: THREE.Vector3; enabled?: boolean } | null;
    if (!orbit?.target) return 0;
    if (orbit.enabled === false) return held;
    return Math.min(camera.getWorldPosition(_eye).distanceTo(orbit.target), MAX_LOOK_DISTANCE);
};

/** Where the sun's own map stops for a camera `look` from what it orbits: the near reach, or past that in steps. */
export const nearShadowReach = (look: number): number => {
    const wanted = look * LOOK_REACH;
    if (wanted <= NEAR_SHADOW_REACH) return NEAR_SHADOW_REACH;
    return NEAR_SHADOW_REACH * LOOK_REACH_STEP ** Math.ceil(Math.log(wanted / NEAR_SHADOW_REACH) / Math.log(LOOK_REACH_STEP) - 1e-9);
};

/** Where the cascades stop: the shadow distance on from where the sun's own map stops for that look. */
export const farShadowReach = (distance: number, look: number): number => distance + nearShadowReach(look) - NEAR_SHADOW_REACH;

/**
 * Where each cascade's slice of the view ends (world units from the camera), nearest first: spread
 * between an even and a logarithmic split, so near cascades are tight and far ones reach the distance.
 */
export const cascadeSplits = (near: number, distance: number, count: number): number[] => {
    const splits: number[] = [];
    const start = Math.max(0.01, Math.min(near, distance));
    for (let i = 1; i <= count; i++) {
        const t = i / count;
        const even = start + (distance - start) * t;
        const log = start * (distance / start) ** t;
        splits.push(0.6 * log + 0.4 * even);
    }
    return splits;
};

const _corner = new THREE.Vector3();
const _near = new THREE.Vector3();
const _far = new THREE.Vector3();
const NDC_CORNERS: ReadonlyArray<[number, number]> = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

/**
 * The sphere around the camera's view from its near plane to `distance` (world units, along the view):
 * its centre in world space and its radius. It is the same size however the camera turns.
 */
export const viewSliceSphere = (camera: THREE.Camera, distance: number, out: THREE.Vector3): number => {
    const corners: THREE.Vector3[] = [];
    for (const [x, y] of NDC_CORNERS) {
        _near.set(x, y, -1).applyMatrix4(camera.projectionMatrixInverse);
        _far.set(x, y, 1).applyMatrix4(camera.projectionMatrixInverse);
        // Along the corner's ray to where it is `distance` deep (view space looks down -Z).
        const depthNear = -_near.z, depthFar = -_far.z;
        const t = depthFar > depthNear ? Math.min(1, Math.max(0, (distance - depthNear) / (depthFar - depthNear))) : 1;
        corners.push(_near.clone(), _corner.copy(_near).lerp(_far, t).clone());
    }
    out.set(0, 0, 0);
    for (const corner of corners) out.add(corner);
    out.divideScalar(corners.length);
    let radius = 0;
    for (const corner of corners) radius = Math.max(radius, corner.distanceTo(out));
    out.applyMatrix4(camera.matrixWorld);
    // A little room, rounded up so float noise does not change the map's size.
    return Math.ceil(radius * 1.02 * 100) / 100;
};

const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _toward = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_FORWARD = new THREE.Vector3(0, 0, 1);

/**
 * Points a cascade light at the sphere around its slice (`centre`, `radius`) from `towardSun`, its map
 * just covering the sphere and its centre moved onto the map's texel grid in the light's own axes.
 */
export const fitCascade = (light: THREE.DirectionalLight, centre: THREE.Vector3, radius: number, towardSun: THREE.Vector3): void => {
    _toward.copy(towardSun).normalize();
    _right.crossVectors(Math.abs(_toward.y) > 0.999 ? WORLD_FORWARD : WORLD_UP, _toward).normalize();
    _up.crossVectors(_toward, _right);
    const size = light.shadow.mapSize.x || 1024;
    const texel = (2 * radius) / size;
    const across = Math.round(centre.dot(_right) / texel) * texel;
    const along = Math.round(centre.dot(_up) / texel) * texel;
    const depth = centre.dot(_toward);
    light.target.position.copy(_right).multiplyScalar(across).addScaledVector(_up, along).addScaledVector(_toward, depth);
    // Far enough back for the whole sphere, however wide.
    const backoff = Math.max(CASCADE_BACKOFF, radius);
    light.position.copy(light.target.position).addScaledVector(_toward, backoff);
    light.target.updateMatrixWorld();
    const camera = light.shadow.camera;
    const far = backoff + radius * 2;
    if (camera.right !== radius || camera.far !== far) {
        camera.left = camera.bottom = -radius;
        camera.right = camera.top = radius;
        camera.near = 0.5;
        camera.far = far;
        camera.updateProjectionMatrix();
    }
    // Wider texels need more lift off the surface to keep from shading themselves. Sized by the texel, not
    // the map's depth range: a close map's shadows stay on what casts them.
    light.shadow.normalBias = texel * 1.5;
    light.shadow.bias = -(texel * 2) / (far - camera.near);
};
