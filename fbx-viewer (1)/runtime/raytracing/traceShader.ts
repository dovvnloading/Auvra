import * as THREE from 'three';
import { RAY_TEXTURE_SHIFT, RAY_TEXTURE_WIDTH, type RayScene } from './rayScene';

/**
 * RAYS IN A FRAGMENT SHADER
 *
 * Walks the ray scene's tables (rayScene.ts) with nothing but texel reads, so it needs no ray tracing hardware
 * and no compute shaders. `rtTrace` follows a ray through the tree of instances and down into the mesh tree of
 * each one it may hit, in that mesh's own space, so a scaled or turned object costs what any other does.
 *
 * GLSL ES 3.00.
 */

/** Pending nodes at most: a tree of a million triangles is not 32 deep on either level. */
const STACK_SIZE = 48;
/** Nodes a ray may visit before it gives up and counts as having missed: only a bound, far above what a ray needs. */
const MAX_STEPS = 1024;

export const TRACE_GLSL = /* glsl */ `
uniform highp sampler2D rtTriangles;
uniform highp sampler2D rtMeshNodes;
uniform highp sampler2D rtSceneNodes;
uniform highp sampler2D rtInstances;
uniform highp sampler2D rtMaterials;

#define RT_MATERIAL_UNLIT 1
#define RT_MATERIAL_TWO_SIDED 2
#define RT_INSTANCE_ONE_WAY 1
#define RT_INSTANCE_NO_SHADOW 2

struct RtHit {
    float distance;
    vec3 normal;
    int material;
    bool front;
};

ivec2 rtTexel( int index ) {
    return ivec2( index & ${RAY_TEXTURE_WIDTH - 1}, index >> ${RAY_TEXTURE_SHIFT} );
}

vec3 rtInvert( vec3 direction ) {
    // A direction along an axis would divide by zero: leaning it by a hair loses nothing.
    return 1.0 / ( direction + vec3( equal( direction, vec3( 0.0 ) ) ) * 1e-9 );
}

float rtEnter( vec3 low, vec3 high, vec3 origin, vec3 inverted, float limit ) {
    vec3 a = ( low - origin ) * inverted;
    vec3 b = ( high - origin ) * inverted;
    vec3 near = min( a, b );
    vec3 far = max( a, b );
    float enter = max( max( near.x, near.y ), max( near.z, 0.0 ) );
    float leave = min( min( far.x, far.y ), min( far.z, limit ) );
    return enter <= leave ? enter : -1.0;
}

// Follows a ray up to limit. With anyHit it stops at the first thing met, which is all a shadow ray asks.
bool rtTrace( vec3 worldOrigin, vec3 worldDirection, float limit, bool anyHit, out RtHit hit ) {
    hit.distance = limit;
    hit.normal = vec3( 0.0, 1.0, 0.0 );
    hit.material = 0;
    hit.front = true;
    int stack[ ${STACK_SIZE} ];
    int top = 0;
    int node = 0;
    int instance = -1;
    int hitTriangle = -1;
    int hitInstance = -1;
    int firstMaterial = 0;
    bool oneWay = false;
    vec3 origin = worldOrigin;
    vec3 direction = worldDirection;
    vec3 inverted = rtInvert( direction );
    for ( int visits = 0; visits < ${MAX_STEPS}; visits++ ) {
        vec4 low;
        vec4 high;
        if ( instance < 0 ) {
            low = texelFetch( rtSceneNodes, rtTexel( node * 2 ), 0 );
            high = texelFetch( rtSceneNodes, rtTexel( node * 2 + 1 ), 0 );
        } else {
            low = texelFetch( rtMeshNodes, rtTexel( node * 2 ), 0 );
            high = texelFetch( rtMeshNodes, rtTexel( node * 2 + 1 ), 0 );
        }
        int count = int( high.w );
        bool descend = false;
        if ( count == 0 ) {
            // Both children: the nearer next, the other for later.
            int left = int( low.w );
            int right = left + 1;
            vec4 leftLow;
            vec4 leftHigh;
            vec4 rightLow;
            vec4 rightHigh;
            if ( instance < 0 ) {
                leftLow = texelFetch( rtSceneNodes, rtTexel( left * 2 ), 0 );
                leftHigh = texelFetch( rtSceneNodes, rtTexel( left * 2 + 1 ), 0 );
                rightLow = texelFetch( rtSceneNodes, rtTexel( right * 2 ), 0 );
                rightHigh = texelFetch( rtSceneNodes, rtTexel( right * 2 + 1 ), 0 );
            } else {
                leftLow = texelFetch( rtMeshNodes, rtTexel( left * 2 ), 0 );
                leftHigh = texelFetch( rtMeshNodes, rtTexel( left * 2 + 1 ), 0 );
                rightLow = texelFetch( rtMeshNodes, rtTexel( right * 2 ), 0 );
                rightHigh = texelFetch( rtMeshNodes, rtTexel( right * 2 + 1 ), 0 );
            }
            float toLeft = rtEnter( leftLow.xyz, leftHigh.xyz, origin, inverted, hit.distance );
            float toRight = rtEnter( rightLow.xyz, rightHigh.xyz, origin, inverted, hit.distance );
            if ( toLeft >= 0.0 && toRight >= 0.0 ) {
                bool leftFirst = toLeft <= toRight;
                if ( top < ${STACK_SIZE} ) {
                    stack[ top ] = leftFirst ? right : left;
                    top++;
                }
                node = leftFirst ? left : right;
                descend = true;
            } else if ( toLeft >= 0.0 ) {
                node = left;
                descend = true;
            } else if ( toRight >= 0.0 ) {
                node = right;
                descend = true;
            }
        } else if ( count > 0 ) {
            if ( instance < 0 ) {
                vec4 about = texelFetch( rtInstances, rtTexel( int( low.w ) * 4 + 3 ), 0 );
                int flags = int( about.z );
                // What casts no shadow when drawn stops no shadow ray.
                bool enter = !anyHit || ( flags & RT_INSTANCE_NO_SHADOW ) == 0;
                #ifdef RT_SKIP_CHARACTERS
                // A character is a box to these rays: fine for bounced light, wrong in a mirror.
                if ( !anyHit && ( flags & RT_INSTANCE_ONE_WAY ) != 0 ) enter = false;
                #endif
                if ( enter ) {
                    // Into an instance: the ray in its own space, not normalised, so its distances stay the world's.
                    instance = int( low.w );
                    vec4 row0 = texelFetch( rtInstances, rtTexel( instance * 4 ), 0 );
                    vec4 row1 = texelFetch( rtInstances, rtTexel( instance * 4 + 1 ), 0 );
                    vec4 row2 = texelFetch( rtInstances, rtTexel( instance * 4 + 2 ), 0 );
                    vec4 worldPoint = vec4( worldOrigin, 1.0 );
                    vec4 worldWay = vec4( worldDirection, 0.0 );
                    origin = vec3( dot( row0, worldPoint ), dot( row1, worldPoint ), dot( row2, worldPoint ) );
                    direction = vec3( dot( row0, worldWay ), dot( row1, worldWay ), dot( row2, worldWay ) );
                    inverted = rtInvert( direction );
                    firstMaterial = int( about.y );
                    oneWay = ( flags & RT_INSTANCE_ONE_WAY ) != 0;
                    node = int( about.x );
                    // Marks where the walk comes back out to the world.
                    if ( top < ${STACK_SIZE} ) {
                        stack[ top ] = -1;
                        top++;
                    }
                    descend = true;
                }
            } else {
                int first = int( low.w );
                for ( int index = first; index < first + count; index++ ) {
                    int triangle = index * 3;
                    vec4 corner = texelFetch( rtTriangles, rtTexel( triangle ), 0 );
                    vec3 edge1 = texelFetch( rtTriangles, rtTexel( triangle + 1 ), 0 ).xyz;
                    vec3 edge2 = texelFetch( rtTriangles, rtTexel( triangle + 2 ), 0 ).xyz;
                    vec3 p = cross( direction, edge2 );
                    float determinant = dot( edge1, p );
                    if ( determinant == 0.0 || ( oneWay && determinant < 0.0 ) ) continue;
                    float f = 1.0 / determinant;
                    vec3 s = origin - corner.xyz;
                    float u = f * dot( s, p );
                    if ( u < 0.0 || u > 1.0 ) continue;
                    vec3 q = cross( s, edge1 );
                    float v = f * dot( direction, q );
                    if ( v < 0.0 || u + v > 1.0 ) continue;
                    float along = f * dot( edge2, q );
                    if ( along <= 1e-4 || along >= hit.distance ) continue;
                    if ( anyHit ) {
                        hit.distance = along;
                        return true;
                    }
                    hit.distance = along;
                    hitTriangle = index;
                    hitInstance = instance;
                    hit.material = firstMaterial + int( corner.w );
                }
            }
        }
        if ( descend ) continue;
        // Back to the last thing set aside, coming out to the world first if that is where it was.
        if ( top == 0 ) break;
        top--;
        node = stack[ top ];
        if ( node < 0 ) {
            instance = -1;
            origin = worldOrigin;
            direction = worldDirection;
            inverted = rtInvert( direction );
            if ( top == 0 ) break;
            top--;
            node = stack[ top ];
        }
    }
    if ( hitTriangle < 0 ) return false;
    int triangle = hitTriangle * 3;
    vec3 edge1 = texelFetch( rtTriangles, rtTexel( triangle + 1 ), 0 ).xyz;
    vec3 edge2 = texelFetch( rtTriangles, rtTexel( triangle + 2 ), 0 ).xyz;
    vec3 own = cross( edge1, edge2 );
    vec3 row0 = texelFetch( rtInstances, rtTexel( hitInstance * 4 ), 0 ).xyz;
    vec3 row1 = texelFetch( rtInstances, rtTexel( hitInstance * 4 + 1 ), 0 ).xyz;
    vec3 row2 = texelFetch( rtInstances, rtTexel( hitInstance * 4 + 2 ), 0 ).xyz;
    hit.normal = normalize( row0 * own.x + row1 * own.y + row2 * own.z );
    hit.front = dot( hit.normal, worldDirection ) < 0.0;
    return true;
}

void rtReadMaterial( int material, out vec3 albedo, out vec3 emissive, out int flags ) {
    vec4 first = texelFetch( rtMaterials, rtTexel( material * 2 ), 0 );
    albedo = first.rgb;
    flags = int( first.a );
    emissive = texelFetch( rtMaterials, rtTexel( material * 2 + 1 ), 0 ).rgb;
}
`;

/** The uniforms TRACE_GLSL reads, for a material that holds on to `scene`. */
export const traceUniforms = (scene: RayScene): Record<string, THREE.IUniform> => ({
    rtTriangles: { value: scene.triangles.texture },
    rtMeshNodes: { value: scene.meshNodes.texture },
    rtSceneNodes: { value: scene.sceneNodes.texture },
    rtInstances: { value: scene.instances.texture },
    rtMaterials: { value: scene.materials.texture },
});
