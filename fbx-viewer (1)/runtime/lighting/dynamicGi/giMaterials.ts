import * as THREE from 'three';
import {
    ATLAS_OFFSET_Y,
    GRID_LIFT,
    ATLAS_HEIGHT,
    ATLAS_IRRADIANCE_WIDTH,
    ATLAS_ROWS,
    ATLAS_WIDTH,
    GI_CASCADES,
    IRRADIANCE_CELL,
    IRRADIANCE_TEXELS,
    PROBES_X,
    PROBES_Y,
    PROBES_Z,
    VISIBILITY_CELL,
    VISIBILITY_TEXELS,
} from './probeGrid';

/**
 * THE PROBE VOLUME IN EVERY LIT MATERIAL
 *
 * What lets a surface read the light gathered around it: the probes at the corners of the cell it lies in,
 * each weighted by how near it is, whether it stands in front of the surface, and whether it could actually
 * see the surface, from the distances it recorded around itself. That last test is what keeps light from
 * leaking through walls without any seams or hand-placed volumes.
 *
 * Only a scene that reads the volume compiles any of this: it holds a light probe with nothing in it (see
 * LevelDynamicGi.tsx), which is what makes three build its shaders with USE_LIGHT_PROBES, and so a separate set of
 * programs. Reading the volume more than doubles how long a lit shader takes to compile, and a level without it
 * should not pay that.
 *
 * Atlas (half-float), in each map's cells (see probeGrid.ts):
 *   left:  each probe's irradiance over the directions a surface may face; a holds 1 where it is sound, 0 where
 *          it stands inside something, and -1 until it has been traced
 *   right: each probe's mean distance to what it sees and the square of it, in the same directions
 *   under the left: how far each probe has moved from its place in the grid, one texel each
 */

export const giAtlas = new THREE.WebGLRenderTarget(ATLAS_WIDTH, ATLAS_HEIGHT, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
});
giAtlas.texture.name = 'GlobalIlluminationAtlas';

let atlasUsers = 0;

/**
 * Holds the atlas until the returned function is called. It is shared by every renderer, and disposing it frees it in
 * all of them: pressing Play swaps one canvas for another, and the last one out must not take the new one's light.
 */
export const holdGiAtlas = (): (() => void) => {
    atlasUsers++;
    let held = true;
    return () => {
        if (!held) return;
        held = false;
        atlasUsers--;
        if (atlasUsers === 0) giAtlas.dispose();
    };
};

/** A value every material's copy of the uniforms shares: three copies uniform values per material. */
class SharedVector4 extends THREE.Vector4 {
    override clone(): this { return this; }
}

/** xyz: each cascade's lowest probe, in the world; w: the distance between its probes. */
const grids = Array.from({ length: GI_CASCADES }, () => new SharedVector4(0, 0, 0, 1));
/** x: intensity; y: 1 when this frame's scene reads the volume; z: 1 when only indirect light is shown; w: moves the noise on, frame by frame. */
const params = new SharedVector4(1, 0, 0, 0);

export const DYNAMIC_GI_UNIFORMS = {
    // One texture in an array: three copies arrays by reference to what they hold, and never a render target otherwise.
    auvraGiAtlas: { value: [giAtlas.texture] },
    auvraGiGrid: { value: grids },
    auvraGiParams: { value: params },
    auvraGiCorners: { value: 8 },
};

/**
 * Reads the volume. Needs only `auvraGiAtlas`, `auvraGiGrid` and GLSL ES 3.00, so the passes that gather light
 * use it too, for the light that comes back round after bouncing.
 */
export const GI_SAMPLE_GLSL = /* glsl */ `
uniform highp sampler2D auvraGiAtlas[ 1 ];
uniform vec4 auvraGiGrid[ ${GI_CASCADES} ];
// Always 8: a loop bound the shader compiler cannot see, as on Windows it would otherwise copy out the loop's body for
// each pass round it, and take several times as long.
uniform int auvraGiCorners;

// A direction folded flat, each coordinate -1 to 1.
vec2 auvraGiFold( vec3 direction ) {
    vec3 a = direction / ( abs( direction.x ) + abs( direction.y ) + abs( direction.z ) );
    if ( a.z < 0.0 ) {
        vec2 flip = vec2( a.x >= 0.0 ? 1.0 : -1.0, a.y >= 0.0 ? 1.0 : -1.0 );
        return ( 1.0 - abs( a.yx ) ) * flip;
    }
    return a.xy;
}

vec3 auvraGiUnfold( vec2 folded ) {
    vec3 n = vec3( folded, 1.0 - abs( folded.x ) - abs( folded.y ) );
    if ( n.z < 0.0 ) {
        vec2 flip = vec2( n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0 );
        n.xy = ( 1.0 - abs( n.yx ) ) * flip;
    }
    return normalize( n );
}

// The column and row of a probe in its cascade's part of the atlas: wraps with the world, as probeGrid.ts does.
vec2 auvraGiPlace( ivec3 world ) {
    ivec3 cell = world & ivec3( ${PROBES_X - 1}, ${PROBES_Y - 1}, ${PROBES_Z - 1} );
    return vec2( float( cell.x + ${PROBES_X} * ( cell.y & 3 ) ), float( cell.z + ${PROBES_Z} * ( cell.y >> 2 ) ) );
}

vec4 auvraGiCascade( int cascade, vec3 point, vec3 normal, vec3 toViewer ) {
    vec4 grid = auvraGiGrid[ cascade ];
    float spacing = grid.w;
    // Read a little out from the surface and toward the viewer, so a surface does not sit on the probes' horizon.
    vec3 biased = point + ( normal * 0.2 + toViewer * 0.8 ) * spacing * 0.3;
    vec3 local = ( biased - grid.xyz ) / spacing;
    vec3 last = vec3( ${(PROBES_X - 2).toFixed(1)}, ${(PROBES_Y - 2).toFixed(1)}, ${(PROBES_Z - 2).toFixed(1)} );
    vec3 base = clamp( floor( local ), vec3( 0.0 ), last );
    vec3 f = clamp( local - base, 0.0, 1.0 );
    ivec3 low = ivec3( floor( grid.xyz / spacing - vec3( 0.0, ${GRID_LIFT}, 0.0 ) + 0.5 ) ) + ivec3( base );
    vec2 normalFold = auvraGiFold( normal ) * 0.5 + 0.5;
    vec2 row = vec2( 0.0, float( cascade * ${ATLAS_ROWS} ) );
    vec3 sum = vec3( 0.0 );
    float total = 0.0;
    for ( int i = 0; i < auvraGiCorners; i++ ) {
        ivec3 corner = ivec3( i & 1, ( i >> 1 ) & 1, ( i >> 2 ) & 1 );
        vec3 probe = grid.xyz + ( base + vec3( corner ) ) * spacing;
        vec2 place = auvraGiPlace( low + corner ) + row;
        vec2 irradianceAt = place * ${IRRADIANCE_CELL.toFixed(1)} + 1.0 + normalFold * ${IRRADIANCE_TEXELS.toFixed(1)};
        vec4 irradiance = textureLod( auvraGiAtlas[ 0 ], irradianceAt / vec2( ${ATLAS_WIDTH.toFixed(1)}, ${ATLAS_HEIGHT.toFixed(1)} ), 0.0 );
        if ( irradiance.a <= 0.0 ) continue;
        // It may have moved out of something it was buried in; what it saw, it saw from there.
        probe += texelFetch( auvraGiAtlas[ 0 ], ivec2( place ) + ivec2( 0, ${ATLAS_OFFSET_Y} ), 0 ).xyz;
        vec3 away = biased - probe;
        float distance = length( away );
        vec2 awayFold = auvraGiFold( away / max( distance, 1e-4 ) ) * 0.5 + 0.5;
        vec2 visibilityAt = vec2( ${ATLAS_IRRADIANCE_WIDTH.toFixed(1)}, 0.0 ) + place * ${VISIBILITY_CELL.toFixed(1)} + 1.0 + awayFold * ${VISIBILITY_TEXELS.toFixed(1)};
        vec2 moments = textureLod( auvraGiAtlas[ 0 ], visibilityAt / vec2( ${ATLAS_WIDTH.toFixed(1)}, ${ATLAS_HEIGHT.toFixed(1)} ), 0.0 ).rg;
        float seen = 1.0;
        if ( distance > moments.x ) {
            float variance = abs( moments.y - moments.x * moments.x );
            float beyond = distance - moments.x;
            seen = variance / max( variance + beyond * beyond, 1e-5 );
            seen = max( seen * seen * seen, 0.0 );
        }
        // Behind the surface it counts for little, without ever dropping to nothing: that leaves dark rings.
        float facing = ( dot( normalize( probe - point ), normal ) + 1.0 ) * 0.5;
        vec3 near = mix( 1.0 - f, f, vec3( corner ) );
        float weight = near.x * near.y * near.z * ( facing * facing + 0.2 ) * max( seen, 0.02 );
        // Very small weights crushed further: otherwise a sea of them from unseen probes greys the dark.
        const float crush = 0.2;
        if ( weight < crush ) weight *= weight * weight / ( crush * crush );
        // Never quite nothing: at a corner every probe may seem hidden, and the least hidden must still answer.
        weight = max( weight, 1e-12 );
        // Blended in a gentler space, so one bright probe does not outshine its neighbours across the whole cell.
        sum += sqrt( max( irradiance.rgb, vec3( 0.0 ) ) ) * weight;
        total += weight;
    }
    if ( total <= 0.0 ) return vec4( 0.0 );
    vec3 mean = sum / total;
    return vec4( mean * mean, 1.0 );
}

// The light reaching a surface, and in a how far it holds: 0 where nothing has been gathered yet or out of range.
// Between two cascades a pixel reads one or the other, as noise (0 to 1) falls, and temporal anti-aliasing evens them
// out: reading both would cost twice as much at run time, and far more than that to compile. A cascade with nothing
// sound in this cell gives way to the next.
vec4 auvraGiIrradiance( vec3 point, vec3 normal, vec3 toViewer, float noise ) {
    int inside = -1;
    float reach = 0.0;
    for ( int cascade = 0; cascade < ${GI_CASCADES}; cascade++ ) {
        vec4 grid = auvraGiGrid[ cascade ];
        vec3 local = ( point - grid.xyz ) / grid.w;
        vec3 room = min( local, vec3( ${(PROBES_X - 1).toFixed(1)}, ${(PROBES_Y - 1).toFixed(1)}, ${(PROBES_Z - 1).toFixed(1)} ) - local );
        float inner = min( min( room.x, room.y ), room.z );
        if ( inner > 0.5 ) {
            inside = cascade;
            reach = inner;
            break;
        }
    }
    if ( inside < 0 ) return vec4( 0.0 );
    float settle = smoothstep( 0.5, 2.0, reach );
    if ( inside < ${GI_CASCADES - 1} && noise > settle ) inside++;
    // The outermost has nothing beyond it to hand over to, so it fades.
    float share = inside == ${GI_CASCADES - 1} ? settle : 1.0;
    vec4 here = vec4( 0.0 );
    for ( int cascade = inside; cascade < auvraGiCorners; cascade++ ) {
        if ( cascade >= ${GI_CASCADES} ) break;
        here = auvraGiCascade( cascade, point, normal, toViewer );
        if ( here.a > 0.0 ) break;
    }
    return vec4( here.rgb, here.a * share );
}
`;

/** Where lit materials take in the volume's light, before the renderer adds its own fill. */
export const GI_MATERIAL_PARS = /* glsl */ `
#if ( defined( STANDARD ) || defined( LAMBERT ) || defined( PHONG ) || defined( TOON ) ) && defined( USE_LIGHT_PROBES )
#define AUVRA_DYNAMIC_GI
uniform vec4 auvraGiParams;
${GI_SAMPLE_GLSL}
#endif
`;

const states = new Map<THREE.Object3D, { intensity: number; indirectOnly: boolean }>();
const paused = new Set<THREE.Object3D>();

/** Draws `scene` with the volume until the returned function is called. */
export const setSceneGi = (scene: THREE.Object3D, state: { intensity: number; indirectOnly: boolean }): (() => void) => {
    states.set(scene, state);
    return () => {
        if (states.get(scene) === state) states.delete(scene);
    };
};

/** Draws `scene` without the volume until the returned function is called: a bake must see only what it bakes. */
export const pauseSceneGi = (scene: THREE.Object3D): (() => void) => {
    paused.add(scene);
    return () => {
        paused.delete(scene);
    };
};

/** Whether `scene` reads the volume now (tests). */
export const sceneReadsGi = (scene: THREE.Object3D): boolean => states.has(scene) && !paused.has(scene);

/** Turns the volume on or off for `scene`; runs as each scene starts drawing. */
export const applySceneGi = (scene: THREE.Object3D): void => {
    const state = states.get(scene);
    if (!state || paused.has(scene)) {
        params.y = 0;
        params.z = 0;
        return;
    }
    params.set(state.intensity, 1, state.indirectOnly ? 1 : 0, params.w);
};

/** Moves the noise that scatters pixels between cascades on, so temporal anti-aliasing can even it out. */
export const stepGiNoise = (frame: number): void => {
    params.w = frame % 64;
};

/** Points every material at where each cascade's probes are now. */
export const setGiGrid = (cascade: number, x: number, y: number, z: number, spacing: number): void => {
    grids[cascade].set(x, y, z, spacing);
};
