import { TRACE_GLSL } from '../../raytracing/traceShader';
import { GI_SAMPLE_GLSL } from './giMaterials';
import {
    ATLAS_OFFSET_Y,
    ATLAS_ROWS,
    ATLAS_IRRADIANCE_WIDTH,
    GRID_LIFT,
    IRRADIANCE_CELL,
    IRRADIANCE_TEXELS,
    MAX_PROBES_PER_FRAME,
    MAX_RAYS_PER_PROBE,
    PROBES_PER_CASCADE,
    PROBES_X,
    PROBES_Y,
    PROBES_Z,
    VISIBILITY_CELL,
    VISIBILITY_TEXELS,
} from './probeGrid';

/**
 * THE PASSES THAT GATHER LIGHT
 *
 *  1. Trace: each probe sends its rays, one pixel each. A ray that lands takes the light at that point: the sun
 *     and lights that reach it, shadow rays deciding, what it gives off, and the light the probes there hold,
 *     which is how light carries on bouncing from frame to frame. One that escapes brings the sky.
 *  2. Integrate: for each direction a surface may face, the rays in a probe's table are summed, into a scratch
 *     target, and eased into what it held. Its distances likewise. A probe whose rays met the insides of things
 *     moves out of them, so that one buried in a wall or a crate comes back into use.
 *  3. Store: what was worked out goes into the atlas. The atlas cannot be read and written at once, which is why
 *     step 2 has somewhere else to write.
 */

export const MAX_DIRECTIONAL_LIGHTS = 2;
export const MAX_LOCAL_LIGHTS = 32;
export const SCRATCH_COLUMNS = 16;
export const SCRATCH_WIDTH = SCRATCH_COLUMNS * (IRRADIANCE_CELL + VISIBILITY_CELL);
export const SCRATCH_HEIGHT = Math.ceil(MAX_PROBES_PER_FRAME / SCRATCH_COLUMNS) * VISIBILITY_CELL;
/** Where probes' moved positions go in the scratch target: below their irradiance cells. */
const SCRATCH_OFFSET_Y = Math.ceil(MAX_PROBES_PER_FRAME / SCRATCH_COLUMNS) * IRRADIANCE_CELL;
/** How close to a surface a probe may stand, and how far it may move from its place in the grid, in spacings. */
const PROBE_MARGIN = 0.15;
const PROBE_MOVE_LIMIT = 0.45;

export const FULLSCREEN_VERTEX = /* glsl */ `
void main() {
    gl_Position = vec4( position.xy, 1.0, 1.0 );
}`;

/**
 * Each probe turns the shared set of ray directions its own way, by a quaternion in the second row of the probe
 * list. Turned alike, every probe's noise would rise and fall together and the whole room would pulse; turned
 * apart, the eight around a surface average it away.
 */
const TURN_GLSL = /* glsl */ `
vec3 giTurn( vec4 turn, vec3 direction ) {
    return direction + 2.0 * cross( turn.xyz, cross( turn.xyz, direction ) + turn.w * direction );
}`;

/** Which texel holds how far a probe has moved, from its code (cascade and cell). */
const OFFSET_TEXEL_GLSL = /* glsl */ `
ivec2 giPlaceOf( int code ) {
    int cascade = code / ${PROBES_PER_CASCADE};
    int cell = code % ${PROBES_PER_CASCADE};
    int x = cell % ${PROBES_X};
    int z = ( cell / ${PROBES_X} ) % ${PROBES_Z};
    int y = cell / ${PROBES_X * PROBES_Z};
    return ivec2( x + ${PROBES_X} * ( y & 3 ), z + ${PROBES_Z} * ( y >> 2 ) + cascade * ${ATLAS_ROWS} );
}
ivec2 giOffsetTexel( int code ) {
    return giPlaceOf( code ) + ivec2( 0, ${ATLAS_OFFSET_Y} );
}`;

/** Light at what a ray meets. Shared by the probes' rays and the view that shows the ray scene itself. */
const SHADE_GLSL = /* glsl */ `
#include <common>
${TRACE_GLSL}
${GI_SAMPLE_GLSL}
uniform vec3 ambientLight;
uniform vec3 hemiSky;
uniform vec3 hemiGround;
uniform vec3 hemiUp;
uniform mat3 envRotation;
uniform float envIntensity;
uniform int directionalCount;
uniform vec4 directional[ ${MAX_DIRECTIONAL_LIGHTS * 2} ];
uniform int localCount;
uniform vec4 local[ ${MAX_LOCAL_LIGHTS * 3} ];
uniform float bounce;
uniform float frame;
#ifdef SKY_ENVIRONMENT
uniform sampler2D envMap;
#include <cube_uv_reflection_fragment>
#endif

uint giRng;

float giRandom() {
    giRng = giRng * 747796405u + 2891336453u;
    uint word = ( ( giRng >> ( ( giRng >> 28u ) + 4u ) ) ^ giRng ) * 277803737u;
    word = ( word >> 22u ) ^ word;
    return float( word ) / 4294967296.0;
}

// The sky from a direction, in the renderer's own terms (see the screen-space trace in screenLighting.ts).
vec3 giSky( vec3 direction ) {
    float weight = clamp( 0.5 + 0.75 * dot( direction, hemiUp ), 0.0, 1.0 );
    vec3 light = ( ambientLight + mix( hemiGround, hemiSky, weight ) ) * RECIPROCAL_PI;
    #ifdef SKY_ENVIRONMENT
    light += textureCubeUV( envMap, envRotation * direction, 1.0 ).rgb * envIntensity;
    #endif
    return light;
}

// The sun and moon, each through a shadow ray aimed somewhere on its disc.
vec3 giDirectional( vec3 point, vec3 normal ) {
    vec3 light = vec3( 0.0 );
    for ( int i = 0; i < directionalCount; i++ ) {
        vec4 way = directional[ i * 2 ];
        float facing = dot( normal, way.xyz );
        if ( facing <= 0.0 ) continue;
        vec3 side = normalize( abs( way.y ) < 0.99 ? cross( way.xyz, vec3( 0.0, 1.0, 0.0 ) ) : cross( way.xyz, vec3( 1.0, 0.0, 0.0 ) ) );
        vec3 other = cross( way.xyz, side );
        float angle = 6.2831853 * giRandom();
        float radius = sqrt( giRandom() ) * way.w;
        vec3 aim = normalize( way.xyz + ( side * cos( angle ) + other * sin( angle ) ) * radius );
        RtHit blocked;
        if ( !rtTrace( point + normal * 0.02, aim, 1e5, true, blocked ) ) light += directional[ i * 2 + 1 ].rgb * facing;
    }
    return light;
}

// One lamp chosen in proportion to what it would give here, through one shadow ray: however many there are, this
// costs a loop and one ray, and what the others would have added is what the average comes to over the frames.
vec3 giLocal( vec3 point, vec3 normal ) {
    float total = 0.0;
    float chosenWeight = 0.0;
    float chosenDistance = 0.0;
    vec3 chosenWay = vec3( 0.0 );
    vec3 chosenLight = vec3( 0.0 );
    for ( int i = 0; i < localCount; i++ ) {
        vec4 place = local[ i * 3 ];
        vec3 toLight = place.xyz - point;
        float distance = length( toLight );
        if ( place.w > 0.0 && distance >= place.w ) continue;
        toLight /= max( distance, 1e-4 );
        float facing = dot( normal, toLight );
        if ( facing <= 0.0 ) continue;
        float falloff = 1.0 / max( distance * distance, 0.01 );
        if ( place.w > 0.0 ) {
            float ratio = distance / place.w;
            float edge = clamp( 1.0 - ratio * ratio * ratio * ratio, 0.0, 1.0 );
            falloff *= edge * edge;
        }
        vec4 cone = local[ i * 3 + 2 ];
        if ( cone.w > -1.5 ) falloff *= smoothstep( cone.w, local[ i * 3 + 1 ].w, dot( toLight, cone.xyz ) );
        vec3 light = local[ i * 3 + 1 ].rgb * falloff * facing;
        float weight = dot( light, vec3( 0.2126, 0.7152, 0.0722 ) );
        if ( weight <= 0.0 ) continue;
        total += weight;
        if ( giRandom() * total < weight ) {
            chosenWeight = weight;
            chosenDistance = distance;
            chosenWay = toLight;
            chosenLight = light;
        }
    }
    // The random number can round up to exactly 1, and then none was chosen.
    if ( total <= 0.0 || chosenWeight <= 0.0 ) return vec3( 0.0 );
    RtHit blocked;
    if ( rtTrace( point + normal * 0.02, chosenWay, chosenDistance - 0.04, true, blocked ) ) return vec3( 0.0 );
    return chosenLight * ( total / chosenWeight );
}

vec3 giShade( vec3 point, vec3 direction, RtHit hit ) {
    vec3 albedo;
    vec3 emissive;
    int flags;
    rtReadMaterial( hit.material, albedo, emissive, flags );
    if ( ( flags & RT_MATERIAL_UNLIT ) != 0 ) return albedo + emissive;
    vec3 normal = hit.front ? hit.normal : -hit.normal;
    vec3 received = giDirectional( point, normal ) + giLocal( point, normal );
    if ( bounce > 0.0 ) {
        vec4 gathered = auvraGiIrradiance( point, normal, -direction );
        // Out of range of every probe, the open sky is the best guess there is.
        vec3 fill = giSky( normal ) * PI * ( 1.0 - gathered.a );
        received += ( gathered.rgb * gathered.a + fill ) * bounce;
    }
    return emissive + albedo * received * RECIPROCAL_PI;
}
`;

/** A probe's rays, one pixel each: x along its rays, y which probe. r, g, b: the light; a: how far, negative where a back was met. */
export const TRACE_FRAGMENT = /* glsl */ `
${SHADE_GLSL}
${OFFSET_TEXEL_GLSL}
${TURN_GLSL}
uniform highp sampler2D probeList;
uniform vec4 rayDirections[ ${MAX_RAYS_PER_PROBE} ];
void main() {
    ivec2 pixel = ivec2( gl_FragCoord.xy );
    giRng = uint( pixel.x ) * 1973u + uint( pixel.y ) * 9277u + uint( frame ) * 26699u + 1u;
    vec4 listed = texelFetch( probeList, ivec2( pixel.y, 0 ), 0 );
    vec3 origin = listed.xyz + texelFetch( auvraGiAtlas[ 0 ], giOffsetTexel( int( listed.w ) ), 0 ).xyz;
    vec3 direction = giTurn( texelFetch( probeList, ivec2( pixel.y, 1 ), 0 ), rayDirections[ pixel.x ].xyz );
    RtHit hit;
    if ( !rtTrace( origin, direction, 1e5, false, hit ) ) {
        gl_FragColor = vec4( giSky( direction ), 1e4 );
        return;
    }
    vec3 albedo;
    vec3 emissive;
    int flags;
    rtReadMaterial( hit.material, albedo, emissive, flags );
    bool twoSided = ( flags & RT_MATERIAL_TWO_SIDED ) != 0;
    vec3 light = hit.front || twoSided ? giShade( origin + direction * hit.distance, direction, hit ) : vec3( 0.0 );
    // A back means the probe may be inside something. For a two-sided material only when it is close: most boxes that
    // come from modelling tools are two-sided, and a probe buried in one must find out, but the walls of a room can
    // be two-sided planes facing away from it, and that room has nothing wrong with it.
    float nearby = auvraGiGrid[ int( listed.w ) / ${PROBES_PER_CASCADE} ].w * 0.5;
    bool inside = !hit.front && ( !twoSided || hit.distance < nearby );
    gl_FragColor = vec4( min( light, vec3( 64.0 ) ), inside ? -hit.distance : hit.distance );
}`;

/** The scene as rays see it, from the camera: to check rays against what is drawn. */
export const RAY_VIEW_FRAGMENT = /* glsl */ `
${SHADE_GLSL}
uniform vec2 viewportSize;
uniform vec2 viewportOrigin;
uniform mat4 inverseViewProjection;
uniform vec3 rayOrigin;
void main() {
    vec2 uv = ( gl_FragCoord.xy - viewportOrigin ) / viewportSize;
    giRng = uint( gl_FragCoord.x ) * 1973u + uint( gl_FragCoord.y ) * 9277u + uint( frame ) * 26699u + 1u;
    vec4 far = inverseViewProjection * vec4( uv * 2.0 - 1.0, 1.0, 1.0 );
    vec3 direction = normalize( far.xyz / far.w - rayOrigin );
    RtHit hit;
    vec3 light = rtTrace( rayOrigin, direction, 1e5, false, hit ) ? giShade( rayOrigin + direction * hit.distance, direction, hit ) : giSky( direction );
    gl_FragColor = vec4( light, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`;

/** One quad per probe, placed by its index; the fragment shader knows its cell's corner and which probe it is. */
export const PROBE_QUAD_VERTEX = /* glsl */ `
uniform highp sampler2D probeList;
uniform vec2 targetSize;
uniform int cellSize;
uniform int quadMode;
flat varying int vProbe;
flat varying int vCode;
flat varying vec4 vTurn;
flat varying ivec2 vCorner;
flat varying ivec2 vAtlasCorner;
flat varying ivec2 vScratchCorner;
${OFFSET_TEXEL_GLSL}

ivec2 atlasCorner( int code ) {
    ivec2 place = giPlaceOf( code );
    if ( cellSize == ${IRRADIANCE_CELL} ) return place * ${IRRADIANCE_CELL};
    if ( cellSize == ${VISIBILITY_CELL} ) return ivec2( ${ATLAS_IRRADIANCE_WIDTH}, 0 ) + place * ${VISIBILITY_CELL};
    return giOffsetTexel( code );
}

ivec2 scratchCorner( int index ) {
    ivec2 place = ivec2( index % ${SCRATCH_COLUMNS}, index / ${SCRATCH_COLUMNS} );
    if ( cellSize == ${IRRADIANCE_CELL} ) return place * ${IRRADIANCE_CELL};
    if ( cellSize == ${VISIBILITY_CELL} ) return ivec2( ${SCRATCH_COLUMNS * IRRADIANCE_CELL}, 0 ) + place * ${VISIBILITY_CELL};
    // Below the irradiance cells, where the scratch target has room.
    return ivec2( index % ${SCRATCH_COLUMNS * IRRADIANCE_CELL}, ${SCRATCH_OFFSET_Y} + index / ${SCRATCH_COLUMNS * IRRADIANCE_CELL} );
}

void main() {
    int code = int( texelFetch( probeList, ivec2( gl_InstanceID, 0 ), 0 ).w );
    // 0: into the scratch target. 1: from it into the atlas. Which map follows from the cell's size.
    vProbe = gl_InstanceID;
    vCode = code;
    vTurn = texelFetch( probeList, ivec2( gl_InstanceID, 1 ), 0 );
    vAtlasCorner = atlasCorner( code );
    vScratchCorner = scratchCorner( gl_InstanceID );
    vCorner = quadMode == 0 ? vScratchCorner : vAtlasCorner;
    vec2 at = ( vec2( vCorner ) + ( position.xy * 0.5 + 0.5 ) * float( cellSize ) ) / targetSize;
    gl_Position = vec4( at * 2.0 - 1.0, 0.0, 1.0 );
}`;

const FOLD_GLSL = /* glsl */ `
vec3 giUnfold( vec2 folded ) {
    vec3 n = vec3( folded, 1.0 - abs( folded.x ) - abs( folded.y ) );
    if ( n.z < 0.0 ) {
        vec2 flip = vec2( n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0 );
        n.xy = ( 1.0 - abs( n.yx ) ) * flip;
    }
    return normalize( n );
}`;

/** The rays of one probe summed for each direction a surface may face. */
export const IRRADIANCE_FRAGMENT = /* glsl */ `
#define PI 3.141592653589793
uniform highp sampler2D rays;
uniform highp sampler2D atlas;
uniform vec4 rayDirections[ ${MAX_RAYS_PER_PROBE} ];
uniform int rayCount;
uniform highp sampler2D probeList;
uniform float cascadeBlend[ 4 ];
flat varying int vProbe;
flat varying int vCode;
flat varying vec4 vTurn;
flat varying ivec2 vCorner;
flat varying ivec2 vAtlasCorner;
flat varying ivec2 vScratchCorner;
${FOLD_GLSL}
${TURN_GLSL}
void main() {
    ivec2 texel = ivec2( gl_FragCoord.xy ) - vCorner;
    // A texel of the rim takes the value of the edge it stands by, so filtering at the edge stays with this probe.
    vec2 folded = clamp( ( vec2( texel ) - 1.0 + 0.5 ) / ${IRRADIANCE_TEXELS.toFixed(1)}, 0.0, 1.0 ) * 2.0 - 1.0;
    vec3 facing = giUnfold( folded );
    vec3 sum = vec3( 0.0 );
    float total = 0.0;
    int backs = 0;
    for ( int r = 0; r < rayCount; r++ ) {
        vec4 ray = texelFetch( rays, ivec2( r, vProbe ), 0 );
        float weight = max( dot( facing, giTurn( vTurn, rayDirections[ r ].xyz ) ), 0.0 );
        total += weight;
        if ( ray.a < 0.0 ) backs++;
        sum += ray.rgb * weight;
    }
    vec3 irradiance = PI * sum / max( total, 1e-4 );
    vec4 before = texelFetch( atlas, vAtlasCorner + texel, 0 );
    float blend = cascadeBlend[ vCode / ${PROBES_PER_CASCADE} ];
    vec3 result = irradiance;
    // What it held while buried, or before it was first traced, is nothing to ease from.
    if ( before.a > 0.0 ) {
        // Eased most of the way, so noise stays out of it, except for a change too large for noise to explain,
        // which it follows quickly. One probe's rays can easily be a third out on their own.
        float largest = max( max( before.r, before.g ), max( before.b, 0.05 ) );
        vec3 gap = abs( irradiance - before.rgb ) / largest;
        float change = smoothstep( 0.4, 1.0, max( max( gap.r, gap.g ), gap.b ) );
        result = mix( before.rgb, irradiance, mix( blend * 0.3, blend, change ) );
    }
    // More than a quarter of its rays met backs: it stands inside something.
    gl_FragColor = vec4( result, backs * 4 > rayCount ? 0.0 : 1.0 );
}`;

/** The distances one probe saw, for each direction, and their squares: how surfaces tell whether it can see them. */
export const VISIBILITY_FRAGMENT = /* glsl */ `
uniform highp sampler2D rays;
uniform highp sampler2D atlas;
uniform vec4 rayDirections[ ${MAX_RAYS_PER_PROBE} ];
uniform int rayCount;
uniform highp sampler2D probeList;
uniform float cascadeSpacing[ 4 ];
flat varying int vProbe;
flat varying int vCode;
flat varying vec4 vTurn;
flat varying ivec2 vCorner;
flat varying ivec2 vAtlasCorner;
flat varying ivec2 vScratchCorner;
${OFFSET_TEXEL_GLSL}
${FOLD_GLSL}
${TURN_GLSL}
void main() {
    ivec2 texel = ivec2( gl_FragCoord.xy ) - vCorner;
    vec2 folded = clamp( ( vec2( texel ) - 1.0 + 0.5 ) / ${VISIBILITY_TEXELS.toFixed(1)}, 0.0, 1.0 ) * 2.0 - 1.0;
    vec3 facing = giUnfold( folded );
    // Short of where its square would overflow what a half-float holds.
    float limit = min( cascadeSpacing[ vCode / ${PROBES_PER_CASCADE} ] * 2.5, 250.0 );
    vec2 sum = vec2( 0.0 );
    float total = 0.0;
    for ( int r = 0; r < rayCount; r++ ) {
        vec4 ray = texelFetch( rays, ivec2( r, vProbe ), 0 );
        // Narrow, and each frame's rays turned: a wide lobe would let a probe just over a thin roof, seeing out to
        // the horizon nearby, count everything under the roof as in sight.
        float weight = pow( max( dot( facing, giTurn( vTurn, rayDirections[ r ].xyz ) ), 0.0 ), 64.0 );
        // A back is met nearer than it looks, so nothing beyond it is taken to be in sight.
        float distance = min( ray.a < 0.0 ? -ray.a * 0.5 : ray.a, limit );
        sum += vec2( distance, distance * distance ) * weight;
        total += weight;
    }
    vec2 moments = sum / max( total, 1e-4 );
    if ( total <= 1e-4 ) moments = vec2( limit, limit * limit );
    vec4 before = texelFetch( atlas, vAtlasCorner + texel, 0 );
    // Nothing to ease from in a texel never written, or for a probe that was buried, and saw this from somewhere else.
    bool sound = before.g > 0.0 && texelFetch( atlas, giPlaceOf( vCode ) * ${IRRADIANCE_CELL} + ivec2( 1 ), 0 ).a > 0.0;
    gl_FragColor = vec4( sound ? mix( before.rg, moments, 0.2 ) : moments, 0.0, 1.0 );
}`;

/**
 * A probe moving out of the way of geometry. More than a quarter of its rays met backs: it is inside something,
 * and goes through the nearest. Nearly touching a surface: it eases back, as what it sees from there would be mostly
 * that surface. With nothing near, it drifts home, so a probe does not stay moved after what moved it has gone.
 */
export const OFFSET_FRAGMENT = /* glsl */ `
uniform highp sampler2D rays;
uniform highp sampler2D atlas;
uniform vec4 rayDirections[ ${MAX_RAYS_PER_PROBE} ];
uniform int rayCount;
uniform float cascadeSpacing[ 4 ];
flat varying int vProbe;
flat varying int vCode;
flat varying vec4 vTurn;
flat varying ivec2 vAtlasCorner;
${TURN_GLSL}
void main() {
    float spacing = cascadeSpacing[ vCode / ${PROBES_PER_CASCADE} ];
    vec3 offset = texelFetch( atlas, vAtlasCorner, 0 ).xyz;
    float nearestBack = 1e9;
    float nearestFront = 1e9;
    vec3 backWay = vec3( 0.0 );
    vec3 frontWay = vec3( 0.0 );
    int backs = 0;
    for ( int r = 0; r < rayCount; r++ ) {
        float along = texelFetch( rays, ivec2( r, vProbe ), 0 ).a;
        vec3 way = giTurn( vTurn, rayDirections[ r ].xyz );
        if ( along < 0.0 ) {
            backs++;
            if ( -along < nearestBack ) {
                nearestBack = -along;
                backWay = way;
            }
        } else if ( along < nearestFront ) {
            nearestFront = along;
            frontWay = way;
        }
    }
    float margin = spacing * ${PROBE_MARGIN.toFixed(2)};
    if ( backs * 4 > rayCount ) offset += backWay * ( nearestBack + margin );
    else if ( nearestFront < margin ) offset -= frontWay * ( margin - nearestFront );
    else if ( nearestFront > spacing ) offset *= 0.8;
    float limit = spacing * ${PROBE_MOVE_LIMIT.toFixed(2)};
    float moved = length( offset );
    if ( moved > limit ) offset *= limit / moved;
    gl_FragColor = vec4( offset, 1.0 );
}`;

/** What the scratch target holds, moved into the atlas. */
export const STORE_FRAGMENT = /* glsl */ `
uniform highp sampler2D scratch;
flat varying int vProbe;
flat varying int vCode;
flat varying ivec2 vCorner;
flat varying ivec2 vAtlasCorner;
flat varying ivec2 vScratchCorner;
void main() {
    ivec2 texel = ivec2( gl_FragCoord.xy ) - vAtlasCorner;
    gl_FragColor = texelFetch( scratch, vScratchCorner + texel, 0 );
}`;

/** Cells whose probes just came into range: what they hold is what the probes that left them saw. */
export const CLEAR_FRAGMENT = /* glsl */ `
void main() {
    gl_FragColor = vec4( 0.0, 0.0, 0.0, -1.0 );
}`;

/** Each probe as a small ball showing the light it holds, red where it stands inside something. */
export const PROBE_VIEW_VERTEX = /* glsl */ `
uniform vec4 auvraGiGrid[ 4 ];
uniform highp sampler2D auvraGiAtlas[ 1 ];
uniform int cascadeShown;
varying vec3 vNormal;
flat varying ivec3 vWorld;
void main() {
    int id = gl_InstanceID;
    ivec3 place = ivec3( id % ${PROBES_X}, ( id / ${PROBES_X * PROBES_Z} ), ( id / ${PROBES_X} ) % ${PROBES_Z} );
    vec4 grid = auvraGiGrid[ cascadeShown ];
    vec3 world = grid.xyz + vec3( place ) * grid.w;
    vWorld = ivec3( floor( grid.xyz / grid.w - vec3( 0.0, ${GRID_LIFT}, 0.0 ) + 0.5 ) ) + place;
    ivec3 cell = vWorld & ivec3( ${PROBES_X - 1}, ${PROBES_Y - 1}, ${PROBES_Z - 1} );
    ivec2 at = ivec2( cell.x + ${PROBES_X} * ( cell.y & 3 ), cell.z + ${PROBES_Z} * ( cell.y >> 2 ) + cascadeShown * ${ATLAS_ROWS} );
    world += texelFetch( auvraGiAtlas[ 0 ], at + ivec2( 0, ${ATLAS_OFFSET_Y} ), 0 ).xyz;
    vNormal = normal;
    gl_Position = projectionMatrix * viewMatrix * vec4( world + position * grid.w * 0.12, 1.0 );
}`;

export const PROBE_VIEW_FRAGMENT = /* glsl */ `
${GI_SAMPLE_GLSL}
uniform int cascadeShown;
varying vec3 vNormal;
flat varying ivec3 vWorld;
void main() {
    vec2 place = auvraGiPlace( vWorld ) + vec2( 0.0, float( cascadeShown * ${ATLAS_ROWS} ) );
    vec2 at = place * ${IRRADIANCE_CELL.toFixed(1)} + 1.0 + ( auvraGiFold( normalize( vNormal ) ) * 0.5 + 0.5 ) * ${IRRADIANCE_TEXELS.toFixed(1)};
    vec4 held = textureLod( auvraGiAtlas[ 0 ], at / vec2( textureSize( auvraGiAtlas[ 0 ], 0 ) ), 0.0 );
    if ( held.a < 0.0 ) discard;
    gl_FragColor = held.a > 0.5 ? vec4( held.rgb * 0.318, 1.0 ) : vec4( 0.6, 0.05, 0.05, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`;
