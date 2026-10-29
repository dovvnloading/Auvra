import * as THREE from 'three';
import { BAKE_SAMPLES, bakeCurve, bakeGradient, linearColor, type ParticleEffect, type ParticleShapeKind } from './particleEffect';
import { MODE_DEFINE, PARTICLE_CORNER, PARTICLE_FRAGMENT, WorldMesh } from './particleRenderer';
import { MAX_PARTICLE_STEP, type MeshSurface } from './particleSimulation';
import { FullscreenPass } from './postEffects';

/**
 * GPU PARTICLES
 *
 * One emitter's particles simulated and drawn on the graphics card, for effects of hundreds of
 * thousands of particles. Each particle is a texel in two float textures (position and age; velocity
 * and lifetime), stepped by a fragment pass into a second pair each frame. New particles take the
 * slots after the last ones written, round a ring, so the oldest give way when the emitter outruns its
 * capacity. The CPU only keeps the emission clock (delay, rate, bursts, trails, the cycle) and hands
 * the pass how many to spawn and where; their randomness comes from each slot's index and the frame.
 * Drawing is one instanced quad per slot, reading its particle from the textures; dead ones fold away.
 *
 * Shapes (the model's surface from 4096 points sampled across it), forces, life curves, flipbooks and
 * every quad mode follow the CPU simulation. World collision is with the ground under the emitter
 * (found by the caller); sub-emitters, ribbons and sorting are not done here.
 */

const SHAPE_DEFINE: Record<ParticleShapeKind, number> = { point: 0, sphere: 1, hemisphere: 2, cone: 3, box: 4, circle: 5, edge: 6, mesh: 7 };
const FRAME_DEFINE = { life: 0, fps: 1, random: 2 } as const;

/** Points sampled over a model's surface for the mesh shape, as a MESH_SIDE × MESH_SIDE table. */
export const MESH_SIDE = 64;
const MESH_POINTS = MESH_SIDE * MESH_SIDE;
/** Rows of the life-curve table: colour and alpha, size, speed. */
const CURVE_ROWS = 3;

const SIMULATE = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D positionAge;
uniform sampler2D velocityLife;
uniform sampler2D curves;
uniform sampler2D meshPoints;
uniform sampler2D meshNormals;
uniform vec2 stateSize;
uniform float capacity;
uniform float dt;
uniform float clock;
uniform float seed;
uniform float emitStart;
uniform float trailCount;
uniform float cycleCount;
uniform float pointCount;
uniform mat4 emitter;
uniform mat4 previousEmitter;
uniform vec3 pointPosition;
uniform vec3 pointVelocity;
uniform vec3 emitterVelocity;
uniform float localSpace;
uniform vec3 force;
uniform float gravity;
uniform vec2 lifetime;
uniform vec2 speed;
uniform float inheritVelocity;
uniform float drag;
uniform float turbulence;
uniform float turbulenceScale;
uniform float orbit;
uniform vec3 orbitCentre;
uniform float shapeRadius;
uniform float shapeAngle;
uniform vec3 shapeSize;
uniform float shapeVolume;
uniform float randomDirection;
uniform vec3 shapeAxis;
uniform float meshCount;
uniform float collide;
uniform float groundY;
uniform float bounce;
uniform float friction;
uniform float killOnHit;
varying vec2 vUv;
layout( location = 0 ) out vec4 outPositionAge;
layout( location = 1 ) out vec4 outVelocityLife;

uint state;
uint pcg( uint v ) {
    uint s = v * 747796405u + 2891336453u;
    uint word = ( ( s >> ( ( s >> 28u ) + 4u ) ) ^ s ) * 277803737u;
    return ( word >> 22u ) ^ word;
}
float random() {
    state = pcg( state );
    return float( state ) * ( 1.0 / 4294967296.0 );
}
float between( vec2 range ) { return mix( range.x, range.y, random() ); }
vec3 randomUnit() {
    float z = 2.0 * random() - 1.0;
    float t = 6.2831853 * random();
    float s = sqrt( max( 0.0, 1.0 - z * z ) );
    return vec3( s * cos( t ), s * sin( t ), z );
}
float lifeCurve( float life, float row, int channel ) {
    vec4 v = texture( curves, vec2( ( clamp( life, 0.0, 1.0 ) * float( SAMPLES - 1 ) + 0.5 ) / float( SAMPLES ), ( row + 0.5 ) / float( ROWS ) ) );
    return channel == 0 ? v.r : v.a;
}

// A launch direction within 'angle' of the axis a, with u and w across it.
vec3 coneDirection( vec3 a, vec3 u, vec3 w, float angle ) {
    float cosT = 1.0 - random() * ( 1.0 - cos( angle ) );
    float sinT = sqrt( max( 0.0, 1.0 - cosT * cosT ) );
    float phi = 6.2831853 * random();
    return a * cosT + u * ( sinT * cos( phi ) ) + w * ( sinT * sin( phi ) );
}

// kind: 0 laid along the emitter's path this step, 1 the cycle's own, 2 a burst at a point.
void spawn( float index, float kind, float along, out vec4 pa, out vec4 vl ) {
    state = uint( index ) * 1664525u + uint( seed ) * 1013904223u + 12345u;
    random();
    float life = between( lifetime );
    vec3 a = normalize( shapeAxis );
    vec3 u = abs( a.x ) > 0.9 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
    vec3 w = normalize( cross( a, u ) );
    u = cross( w, a );
    vec3 pos = vec3( 0.0 );
    vec3 dir = a;
    float depth = 1.0 - shapeVolume + shapeVolume * random();
#if SHAPE == 0
    dir = coneDirection( a, u, w, shapeAngle );
#elif SHAPE == 1 || SHAPE == 2
    dir = randomUnit();
#if SHAPE == 2
    float side = dot( dir, a );
    if ( side < 0.0 ) dir -= 2.0 * side * a;
#endif
    pos = dir * shapeRadius * pow( depth, 1.0 / 3.0 );
#elif SHAPE == 3 || SHAPE == 5
    float phi = 6.2831853 * random();
    float out_ = sqrt( depth );
    vec3 across = u * cos( phi ) + w * sin( phi );
    pos = across * out_ * shapeRadius;
#if SHAPE == 3
    // Opens outwards: the further from the middle, the more it leans out.
    float lean = shapeAngle * out_;
    dir = a * cos( lean ) + across * sin( lean );
#else
    dir = coneDirection( a, u, w, shapeAngle );
#endif
#elif SHAPE == 4
    pos = ( vec3( random(), random(), random() ) - 0.5 ) * shapeSize;
    if ( shapeVolume < 1.0 && random() >= shapeVolume ) {
        // A face, picked by its area.
        vec3 areas = vec3( shapeSize.y * shapeSize.z, shapeSize.x * shapeSize.z, shapeSize.x * shapeSize.y );
        float pick = random() * ( areas.x + areas.y + areas.z );
        float face = random() < 0.5 ? -0.5 : 0.5;
        if ( pick < areas.x ) pos.x = face * shapeSize.x;
        else if ( pick < areas.x + areas.y ) pos.y = face * shapeSize.y;
        else pos.z = face * shapeSize.z;
    }
    dir = coneDirection( a, u, w, shapeAngle );
#elif SHAPE == 6
    pos.x = ( random() - 0.5 ) * shapeSize.x;
    dir = coneDirection( a, u, w, shapeAngle );
#elif SHAPE == 7
    if ( meshCount > 0.0 ) {
        float k = min( meshCount - 1.0, floor( random() * meshCount ) );
        vec2 at = ( vec2( mod( k, float( MESH_SIDE ) ), floor( k / float( MESH_SIDE ) ) ) + 0.5 ) / float( MESH_SIDE );
        pos = texture( meshPoints, at ).xyz;
        dir = texture( meshNormals, at ).xyz;
    } else {
        dir = coneDirection( a, u, w, shapeAngle );
    }
#endif
    if ( randomDirection > 0.0 ) dir = normalize( mix( dir, randomUnit(), randomDirection ) + vec3( 1e-6 ) );
    vec3 p;
    vec3 d = dir;
    if ( localSpace > 0.5 ) {
        p = kind > 1.5 ? pos + pointPosition : pos;
    } else if ( kind > 1.5 ) {
        p = pos + pointPosition;
    } else {
        vec3 now = ( emitter * vec4( pos, 1.0 ) ).xyz;
        p = kind < 0.5 ? mix( ( previousEmitter * vec4( pos, 1.0 ) ).xyz, now, along ) : now;
        d = normalize( mat3( emitter ) * dir + vec3( 1e-6 ) );
    }
    vec3 v = d * between( speed ) + emitterVelocity * inheritVelocity + ( kind > 1.5 ? pointVelocity : vec3( 0.0 ) );
    // Placed where it would be after its share of the step, so emission within a step is smooth.
    float age = kind > 1.5 ? 0.0 : dt * ( 1.0 - along );
    p += v * age;
    p.y -= 0.5 * gravity * age * age;
    pa = vec4( p, min( age, life ) );
    vl = vec4( v, life );
}

void main() {
    vec2 cell = floor( gl_FragCoord.xy );
    float index = cell.y * stateSize.x + cell.x;
    if ( index >= capacity ) {
        outPositionAge = vec4( 0.0 );
        outVelocityLife = vec4( 0.0 );
        return;
    }
    vec4 pa = texture( positionAge, vUv );
    vec4 vl = texture( velocityLife, vUv );
    float slot = mod( index - emitStart + capacity, capacity );
    if ( slot < trailCount + cycleCount + pointCount ) {
        if ( slot < trailCount ) spawn( index, 0.0, ( slot + 1.0 ) / trailCount, pa, vl );
        else if ( slot < trailCount + cycleCount ) spawn( index, 1.0, ( slot - trailCount + 0.5 ) / cycleCount, pa, vl );
        else spawn( index, 2.0, 0.0, pa, vl );
        outPositionAge = pa;
        outVelocityLife = vl;
        return;
    }
    float age = pa.w + dt;
    // Dead, or dying this step: held at the end of its life, which draws nothing.
    if ( pa.w >= vl.w || age >= vl.w ) {
        outPositionAge = vec4( pa.xyz, vl.w );
        outVelocityLife = vl;
        return;
    }
    vec3 v = vl.xyz + force * dt;
    if ( turbulence > 0.0 ) {
        vec3 q = pa.xyz / turbulenceScale;
        float t = clock * 0.6;
        v += vec3(
            sin( q.y * 1.3 + t ) + cos( q.z * 0.7 - t * 0.8 ),
            sin( q.z * 1.1 + t * 1.2 ) + cos( q.x * 0.9 + t * 0.5 ),
            sin( q.x * 1.2 - t * 0.9 ) + cos( q.y * 1.5 + t * 1.1 )
        ) * turbulence * 0.5 * dt;
    }
    v *= exp( -drag * dt );
    vec3 p = pa.xyz + v * lifeCurve( age / vl.w, 2.0, 0 ) * dt;
    if ( orbit != 0.0 ) {
        // Circling the emitter's vertical axis.
        vec2 r = p.xz - orbitCentre.xz;
        float c = cos( orbit * dt );
        float s = sin( orbit * dt );
        p.xz = orbitCentre.xz + vec2( r.x * c + r.y * s, -r.x * s + r.y * c );
    }
    if ( collide > 0.5 && p.y < groundY && v.y < 0.0 ) {
        if ( killOnHit > 0.5 ) {
            outPositionAge = vec4( p.x, groundY, p.z, vl.w );
            outVelocityLife = vl;
            return;
        }
        // Bounce: the speed into the ground reversed and cut, the speed along it slowed.
        v.y = -v.y * bounce;
        v.xz *= 1.0 - friction;
        p.y = groundY + 0.01;
    }
    outPositionAge = vec4( p, age );
    outVelocityLife = vec4( v, vl.w );
}`;

const DRAW_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute float aIndex;
uniform sampler2D positionAge;
uniform sampler2D velocityLife;
uniform sampler2D curves;
uniform vec2 stateSize;
uniform mat4 uEmitter;
uniform vec2 uGrid;
uniform vec3 startColorA;
uniform vec3 startColorB;
uniform vec2 sizeRange;
uniform vec2 rotationRange;
uniform vec2 spinRange;
uniform float fps;
varying vec2 vUv;
varying vec4 vColor;
${PARTICLE_CORNER}
// A particle's own random number for 'salt', the same every frame of its life.
float particleRandom( float index, float lifetime, float salt ) {
    return fract( sin( index * 12.9898 + lifetime * 78.233 + salt * 37.719 ) * 43758.5453 );
}
void main() {
    vec2 at = ( vec2( mod( aIndex, stateSize.x ), floor( aIndex / stateSize.x ) ) + 0.5 ) / stateSize;
    vec4 pa = texture2D( positionAge, at );
    vec4 vl = texture2D( velocityLife, at );
    if ( pa.w >= vl.w ) {
        // Dead: folded away outside the view.
        gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
        vUv = vec2( 0.0 );
        vColor = vec4( 0.0 );
        return;
    }
    float life = clamp( pa.w / vl.w, 0.0, 1.0 );
    float x = ( life * float( SAMPLES - 1 ) + 0.5 ) / float( SAMPLES );
    vec4 tint = texture2D( curves, vec2( x, 0.5 / float( ROWS ) ) );
    float grow = texture2D( curves, vec2( x, 1.5 / float( ROWS ) ) ).r;
    vColor = vec4( mix( startColorA, startColorB, particleRandom( aIndex, vl.w, 1.0 ) ) * tint.rgb, tint.a );
    float size = mix( sizeRange.x, sizeRange.y, particleRandom( aIndex, vl.w, 2.0 ) ) * grow;
    float rotation = mix( rotationRange.x, rotationRange.y, particleRandom( aIndex, vl.w, 3.0 ) )
        + mix( spinRange.x, spinRange.y, particleRandom( aIndex, vl.w, 4.0 ) ) * pa.w;
    float frames = uGrid.x * uGrid.y;
    float pick = particleRandom( aIndex, vl.w, 5.0 );
#if FRAME_MODE == 0
    float frame = min( frames - 1.0, floor( life * frames ) );
#elif FRAME_MODE == 1
    float frame = mod( floor( pick * frames + pa.w * fps ), frames );
#else
    float frame = floor( pick * frames );
#endif
    vec3 center = ( uEmitter * vec4( pa.xyz, 1.0 ) ).xyz;
    vec3 world = particleCorner( center, mat3( uEmitter ) * vl.xyz, position.xy, size, rotation );
    vec4 mvPosition = viewMatrix * vec4( world, 1.0 );
    gl_Position = projectionMatrix * mvPosition;
    vUv = particleFrameUv( frame, uv, uGrid );
    #include <fog_vertex>
}`;

/** Spawns asked of one step: laid along the emitter's path, and the cycle's own (rate and bursts). */
export interface EmissionCounts {
    trail: number;
    cycle: number;
}

/**
 * When an effect emits, as counts per step: the start delay, the continuous rate, bursts at their
 * times in each cycle, the rate per metre moved, looping or ending after one cycle.
 */
export class EmissionClock {
    emitting = false;
    finished = false;
    private clock = 0;
    private cycleTime = 0;
    private burstsDone = 0;
    private carry = 0;
    private distanceCarry = 0;

    play(): void {
        this.emitting = true;
        this.finished = false;
        this.clock = 0;
        this.cycleTime = 0;
        this.burstsDone = 0;
        this.carry = 0;
        this.distanceCarry = 0;
    }

    stop(): void {
        this.emitting = false;
    }

    /** Advances by `step` seconds while the emitter moved `moved` metres. */
    advance(effect: ParticleEffect, step: number, moved: number): EmissionCounts {
        const counts = { trail: 0, cycle: 0 };
        if (!this.emitting || this.finished) return counts;
        this.clock += step;
        let left = step;
        if (this.clock - step < effect.delay) {
            left -= Math.min(left, effect.delay - (this.clock - step));
            if (left <= 0) return counts;
        }
        if (effect.rateOverDistance > 0 && moved > 0) {
            this.distanceCarry += moved * effect.rateOverDistance;
            counts.trail = Math.floor(this.distanceCarry + 1e-6);
            this.distanceCarry -= counts.trail;
        }
        const duration = Math.max(0.05, effect.duration);
        while (left > 0 && !this.finished) {
            const active = Math.min(left, duration - this.cycleTime);
            const end = this.cycleTime + active;
            while (this.burstsDone < effect.bursts.length && effect.bursts[this.burstsDone].time <= end + 1e-9) {
                counts.cycle += effect.bursts[this.burstsDone].count;
                this.burstsDone++;
            }
            this.carry += effect.rate * active;
            const due = Math.floor(this.carry + 1e-6);
            this.carry -= due;
            counts.cycle += due;
            this.cycleTime = end;
            left -= active;
            if (this.cycleTime >= duration - 1e-9) {
                this.cycleTime = 0;
                this.burstsDone = 0;
                if (!effect.loop) {
                    this.finished = true;
                    this.carry = 0;
                }
            }
        }
        return counts;
    }
}

/** The state texture's size for `capacity` particles: square-ish, as narrow as it can be. */
export const stateSize = (capacity: number): [number, number] => {
    const width = Math.ceil(Math.sqrt(Math.max(1, capacity)));
    return [width, Math.ceil(Math.max(1, capacity) / width)];
};

/** `count` points spread over a surface by area (in its own space), with their faces' normals. */
export const sampleSurface = (surface: MeshSurface, count: number, random: () => number = Math.random): { points: Float32Array; normals: Float32Array } => {
    const { positions, indices } = surface;
    const triangles = Math.floor(indices.length / 3);
    const points = new Float32Array(count * 4);
    const normals = new Float32Array(count * 4);
    if (triangles === 0) return { points, normals };
    const cdf = new Float64Array(triangles);
    const normal = new Float32Array(triangles * 3);
    let total = 0;
    for (let t = 0; t < triangles; t++) {
        const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
        const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2];
        const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2];
        const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
        total += length / 2;
        cdf[t] = total;
        normal[t * 3] = length > 0 ? nx / length : 0;
        normal[t * 3 + 1] = length > 0 ? ny / length : 1;
        normal[t * 3 + 2] = length > 0 ? nz / length : 0;
    }
    for (let i = 0; i < count; i++) {
        const pick = random() * total;
        let lo = 0, hi = triangles - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (cdf[mid] < pick) lo = mid + 1; else hi = mid;
        }
        const a = indices[lo * 3] * 3, b = indices[lo * 3 + 1] * 3, c = indices[lo * 3 + 2] * 3;
        let s = random(), t = random();
        if (s + t > 1) { s = 1 - s; t = 1 - t; }
        for (let k = 0; k < 3; k++) {
            points[i * 4 + k] = positions[a + k] + (positions[b + k] - positions[a + k]) * s + (positions[c + k] - positions[a + k]) * t;
            normals[i * 4 + k] = normal[lo * 3 + k];
        }
        points[i * 4 + 3] = 1;
    }
    return { points, normals };
};

const floatTexture = (data: Float32Array, width: number, height: number): THREE.DataTexture => {
    const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
    texture.minFilter = texture.magFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    return texture;
};

const stateTarget = (width: number, height: number): THREE.WebGLRenderTarget =>
    new THREE.WebGLRenderTarget(width, height, {
        count: 2, type: THREE.FloatType, format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false,
    });

const IDENTITY = new THREE.Matrix4();
const _clear = new THREE.Color();

interface PointBurst { count: number; position: [number, number, number]; velocity: [number, number, number] }

export class GpuParticleSystem {
    readonly capacity: number;
    readonly object = new THREE.Group();
    readonly width: number;
    readonly height: number;
    private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
    private readonly simulation: FullscreenPass;
    private readonly curves = floatTexture(new Float32Array(BAKE_SAMPLES * CURVE_ROWS * 4), BAKE_SAMPLES, CURVE_ROWS);
    private readonly meshPoints = floatTexture(new Float32Array(MESH_POINTS * 4), MESH_SIDE, MESH_SIDE);
    private readonly meshNormals = floatTexture(new Float32Array(MESH_POINTS * 4), MESH_SIDE, MESH_SIDE);
    private readonly material: THREE.ShaderMaterial;
    private readonly mesh: WorldMesh;
    private readonly emission = new EmissionClock();
    private effect: ParticleEffect | null = null;
    private cursor = 0;
    private serial = 0;
    private elapsed = 0;
    private previous: THREE.Matrix4 | null = null;
    private readonly emitterVelocity = new THREE.Vector3();
    private readonly bursts: PointBurst[] = [];
    /** Particles spawned per step lately, to tell how many are alive without reading the GPU back. */
    private readonly spawned: Array<{ time: number; count: number }> = [];
    private needsClear = true;
    private warm = false;

    constructor(capacity: number) {
        this.capacity = Math.max(1, Math.floor(capacity));
        [this.width, this.height] = stateSize(this.capacity);
        this.targets = [stateTarget(this.width, this.height), stateTarget(this.width, this.height)];
        const u = <T>(value: T) => ({ value });
        this.simulation = new FullscreenPass(SIMULATE, {
            positionAge: u(null), velocityLife: u(null), curves: u(this.curves), meshPoints: u(this.meshPoints), meshNormals: u(this.meshNormals),
            stateSize: u(new THREE.Vector2(this.width, this.height)), capacity: u(this.capacity), dt: u(0), clock: u(0), seed: u(0),
            emitStart: u(0), trailCount: u(0), cycleCount: u(0), pointCount: u(0),
            emitter: u(new THREE.Matrix4()), previousEmitter: u(new THREE.Matrix4()),
            pointPosition: u(new THREE.Vector3()), pointVelocity: u(new THREE.Vector3()), emitterVelocity: u(this.emitterVelocity),
            localSpace: u(0), force: u(new THREE.Vector3()), gravity: u(0), lifetime: u(new THREE.Vector2(1, 1)), speed: u(new THREE.Vector2()),
            inheritVelocity: u(0), drag: u(0), turbulence: u(0), turbulenceScale: u(1), orbit: u(0), orbitCentre: u(new THREE.Vector3()),
            shapeRadius: u(0), shapeAngle: u(0), shapeSize: u(new THREE.Vector3(1, 1, 1)), shapeVolume: u(1), randomDirection: u(0),
            shapeAxis: u(new THREE.Vector3(0, 1, 0)), meshCount: u(0),
            collide: u(0), groundY: u(0), bounce: u(0), friction: u(0), killOnHit: u(0),
        }, THREE.GLSL3);
        this.simulation.material.defines = { SAMPLES: BAKE_SAMPLES, ROWS: CURVE_ROWS, MESH_SIDE, SHAPE: 0 };

        const quad = new THREE.InstancedBufferGeometry();
        quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
        quad.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
        quad.setIndex([0, 1, 2, 0, 2, 3]);
        const index = new Float32Array(this.capacity);
        for (let i = 0; i < this.capacity; i++) index[i] = i;
        quad.setAttribute('aIndex', new THREE.InstancedBufferAttribute(index, 1));
        quad.instanceCount = this.capacity;
        quad.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
        this.material = new THREE.ShaderMaterial({
            uniforms: THREE.UniformsUtils.merge([
                THREE.UniformsLib.fog,
                {
                    positionAge: { value: null }, velocityLife: { value: null }, curves: { value: null },
                    stateSize: { value: new THREE.Vector2(this.width, this.height) },
                    uEmitter: { value: new THREE.Matrix4() }, uMap: { value: null }, uEmissive: { value: 1 },
                    uGrid: { value: new THREE.Vector2(1, 1) }, uStretch: { value: 0 },
                    startColorA: { value: new THREE.Color() }, startColorB: { value: new THREE.Color() },
                    sizeRange: { value: new THREE.Vector2(1, 1) }, rotationRange: { value: new THREE.Vector2() },
                    spinRange: { value: new THREE.Vector2() }, fps: { value: 12 },
                },
            ]),
            defines: { SAMPLES: BAKE_SAMPLES, ROWS: CURVE_ROWS, MODE: 0, FRAME_MODE: 0 },
            vertexShader: DRAW_VERTEX,
            fragmentShader: PARTICLE_FRAGMENT,
            transparent: true,
            depthWrite: false,
            fog: true,
        });
        // Merged uniforms are copies: point the textures at the live ones.
        this.material.uniforms.curves.value = this.curves;
        this.mesh = new WorldMesh(quad, this.material);
        this.mesh.name = 'GpuParticles';
        this.object.name = 'GpuParticleSystem';
        this.object.add(this.mesh);
        this.bindState();
    }

    /** Takes an effect's emission, shape, forces and life curves. */
    setEffect(effect: ParticleEffect): void {
        this.effect = effect;
        const u = this.simulation.material.uniforms;
        const shape = effect.shape;
        const defines = this.simulation.material.defines as Record<string, number>;
        if (defines.SHAPE !== SHAPE_DEFINE[shape.kind]) {
            defines.SHAPE = SHAPE_DEFINE[shape.kind];
            this.simulation.material.needsUpdate = true;
        }
        (u.lifetime.value as THREE.Vector2).set(effect.lifetime[0], effect.lifetime[1]);
        (u.speed.value as THREE.Vector2).set(effect.speed[0], effect.speed[1]);
        u.inheritVelocity.value = effect.inheritVelocity;
        u.gravity.value = effect.gravity;
        u.drag.value = effect.drag;
        u.turbulence.value = effect.turbulence;
        u.turbulenceScale.value = effect.turbulenceScale;
        u.orbit.value = effect.orbit;
        u.shapeRadius.value = shape.radius;
        u.shapeAngle.value = shape.angle * Math.PI / 180;
        (u.shapeSize.value as THREE.Vector3).fromArray(shape.size);
        u.shapeVolume.value = shape.volume;
        u.randomDirection.value = shape.randomDirection;
        const axis = (u.shapeAxis.value as THREE.Vector3).fromArray(shape.axis);
        if (axis.lengthSq() < 1e-8) axis.set(0, 1, 0);
        u.localSpace.value = effect.space === 'local' ? 1 : 0;
        u.bounce.value = effect.collision.bounce;
        u.friction.value = effect.collision.friction;
        u.killOnHit.value = effect.collision.kill ? 1 : 0;

        const table = this.curves.image.data as Float32Array;
        table.set(bakeGradient(effect.colorOverLife), 0);
        const size = bakeCurve(effect.sizeOverLife);
        const speed = bakeCurve(effect.speedOverLife);
        for (let i = 0; i < BAKE_SAMPLES; i++) {
            table[(BAKE_SAMPLES + i) * 4] = size[i];
            table[(BAKE_SAMPLES * 2 + i) * 4] = speed[i];
        }
        this.curves.needsUpdate = true;

        const m = this.material.uniforms;
        (m.startColorA.value as THREE.Color).fromArray(linearColor(effect.startColor[0]) as number[]);
        (m.startColorB.value as THREE.Color).fromArray(linearColor(effect.startColor[1]) as number[]);
        (m.sizeRange.value as THREE.Vector2).set(effect.size[0], effect.size[1]);
        (m.rotationRange.value as THREE.Vector2).set(effect.rotation[0], effect.rotation[1]).multiplyScalar(Math.PI / 180);
        (m.spinRange.value as THREE.Vector2).set(effect.spin[0], effect.spin[1]).multiplyScalar(Math.PI / 180);
        m.fps.value = effect.render.fps;
    }

    /** Takes an effect's look: its sprite texture, flipbook grid, quad mode, frames and blending. */
    setLook(effect: ParticleEffect, texture: THREE.Texture, grid: [number, number]): void {
        const render = effect.render;
        const m = this.material.uniforms;
        m.uMap.value = texture;
        m.uEmissive.value = render.emissive;
        (m.uGrid.value as THREE.Vector2).set(grid[0], grid[1]);
        m.uStretch.value = render.stretch;
        const additive = render.blending === 'additive';
        this.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
        // Ribbons need particles in birth order, which a ring of slots does not keep: drawn as quads.
        const mode = render.mode === 'ribbon' ? 'billboard' : render.mode;
        const defines: Record<string, unknown> = { SAMPLES: BAKE_SAMPLES, ROWS: CURVE_ROWS, MODE: MODE_DEFINE[mode], FRAME_MODE: FRAME_DEFINE[render.frameMode] };
        if (additive) defines.ADDITIVE = '';
        if (JSON.stringify(defines) !== JSON.stringify(this.material.defines)) {
            this.material.defines = defines;
            this.material.needsUpdate = true;
        }
        this.material.side = mode === 'horizontal' ? THREE.DoubleSide : THREE.FrontSide;
    }

    /** The model's surface for the mesh shape, in the emitter's space; null leaves the shape's cone. */
    setMeshSurface(surface: MeshSurface | null): void {
        const u = this.simulation.material.uniforms;
        if (!surface) {
            u.meshCount.value = 0;
            return;
        }
        const { points, normals } = sampleSurface(surface, MESH_POINTS);
        (this.meshPoints.image.data as Float32Array).set(points);
        (this.meshNormals.image.data as Float32Array).set(normals);
        this.meshPoints.needsUpdate = true;
        this.meshNormals.needsUpdate = true;
        u.meshCount.value = surface.indices.length >= 3 ? MESH_POINTS : 0;
    }

    get isEmitting(): boolean {
        return this.emission.emitting && !this.emission.finished;
    }

    /** About how many particles are alive: those spawned within the longest lifetime. */
    get count(): number {
        const longest = this.effect?.lifetime[1] ?? 0;
        let alive = 0;
        for (const entry of this.spawned) if (this.elapsed - entry.time < longest) alive += entry.count;
        return Math.min(this.capacity, alive);
    }

    /** Done: it emits no more and every particle it made has lived out its life. */
    get isDone(): boolean {
        return !this.isEmitting && this.bursts.length === 0 && this.count === 0;
    }

    play(): void {
        this.emission.play();
    }

    stop(clear = false): void {
        this.emission.stop();
        if (clear) {
            this.needsClear = true;
            this.spawned.length = 0;
            this.bursts.length = 0;
        }
    }

    /** Runs one looping cycle at once on the next step, as if it had been going a while. */
    prewarm(): void {
        this.warm = true;
    }

    /** Spawns `count` from the shape placed at a world point, with `velocity` (world, m/s) added. */
    emitAt(count: number, x: number, y: number, z: number, vx = 0, vy = 0, vz = 0): void {
        if (count > 0) this.bursts.push({ count: Math.min(this.capacity, count), position: [x, y, z], velocity: [vx, vy, vz] });
    }

    /**
     * Advances by `dt` seconds (clamped to MAX_PARTICLE_STEP) with the emitter at `matrix` (world).
     * `ground` is the height of the ground under the emitter for world collision, or null for none.
     */
    step(renderer: THREE.WebGLRenderer, dt: number, matrix: THREE.Matrix4, ground: number | null): void {
        const effect = this.effect;
        if (!effect) return;
        const before = renderer.getRenderTarget();
        if (this.needsClear) {
            const alpha = renderer.getClearAlpha();
            renderer.getClearColor(_clear);
            renderer.setClearColor(0x000000, 0);
            for (const target of this.targets) {
                renderer.setRenderTarget(target);
                renderer.clear(true, false, false);
            }
            renderer.setClearColor(_clear, alpha);
            this.needsClear = false;
        }
        if (this.warm) {
            this.warm = false;
            const steps = 30;
            for (let i = 0; i < steps; i++) this.advance(renderer, effect.duration / steps, matrix, ground);
        }
        this.advance(renderer, Math.min(MAX_PARTICLE_STEP, Math.max(0, dt)), matrix, ground);
        renderer.setRenderTarget(before);
    }

    private advance(renderer: THREE.WebGLRenderer, step: number, matrix: THREE.Matrix4, ground: number | null): void {
        const effect = this.effect!;
        const u = this.simulation.material.uniforms;
        const local = effect.space === 'local';
        const e = matrix.elements;
        const previous = this.previous;
        let moved = 0;
        if (previous && step > 0) {
            const p = previous.elements;
            this.emitterVelocity.set((e[12] - p[12]) / step, (e[13] - p[13]) / step, (e[14] - p[14]) / step);
            moved = Math.hypot(e[12] - p[12], e[13] - p[13], e[14] - p[14]);
        }
        const counts = this.emission.advance(effect, step, moved);
        const burst = this.bursts.shift();
        let trail = counts.trail, cycle = counts.cycle, points = burst?.count ?? 0;
        const total = trail + cycle + points;
        if (total > this.capacity) {
            // More than it can hold this step: each kind gives way in proportion.
            const keep = this.capacity / total;
            trail = Math.floor(trail * keep);
            cycle = Math.floor(cycle * keep);
            points = Math.min(this.capacity - trail - cycle, Math.floor(points * keep));
        }
        const spawned = trail + cycle + points;

        u.dt.value = step;
        u.clock.value = this.elapsed;
        u.seed.value = this.serial = (this.serial + 1) % 1000003;
        u.emitStart.value = this.cursor;
        u.trailCount.value = trail;
        u.cycleCount.value = cycle;
        u.pointCount.value = points;
        (u.emitter.value as THREE.Matrix4).copy(matrix);
        (u.previousEmitter.value as THREE.Matrix4).copy(previous ?? matrix);
        if (burst) {
            (u.pointPosition.value as THREE.Vector3).fromArray(burst.position);
            (u.pointVelocity.value as THREE.Vector3).fromArray(burst.velocity);
        }
        // Gravity and wind act along world axes; a local-space emitter feels them turned into its frame.
        const ax = effect.wind[0], ay = effect.wind[1] - effect.gravity, az = effect.wind[2];
        const force = u.force.value as THREE.Vector3;
        if (local) force.set(e[0] * ax + e[1] * ay + e[2] * az, e[4] * ax + e[5] * ay + e[6] * az, e[8] * ax + e[9] * ay + e[10] * az);
        else force.set(ax, ay, az);
        (u.orbitCentre.value as THREE.Vector3).set(local ? 0 : e[12], local ? 0 : e[13], local ? 0 : e[14]);
        const collide = effect.collision.mode === 'world' && ground !== null && !local;
        u.collide.value = collide ? 1 : 0;
        u.groundY.value = ground ?? 0;

        const [read, write] = this.targets;
        u.positionAge.value = read.textures[0];
        u.velocityLife.value = read.textures[1];
        this.simulation.render(renderer, write);
        this.targets = [write, read];
        this.bindState();
        (this.material.uniforms.uEmitter.value as THREE.Matrix4).copy(local ? matrix : IDENTITY);

        this.cursor = (this.cursor + spawned) % this.capacity;
        if (spawned > 0) this.spawned.push({ time: this.elapsed, count: spawned });
        this.elapsed += step;
        const longest = effect.lifetime[1];
        while (this.spawned.length && this.elapsed - this.spawned[0].time >= longest) this.spawned.shift();
        this.previous = (this.previous ?? new THREE.Matrix4()).copy(matrix);
    }

    private bindState(): void {
        const [current] = this.targets;
        this.material.uniforms.positionAge.value = current.textures[0];
        this.material.uniforms.velocityLife.value = current.textures[1];
    }

    dispose(): void {
        for (const target of this.targets) target.dispose();
        this.simulation.dispose();
        this.material.dispose();
        this.mesh.geometry.dispose();
        this.curves.dispose();
        this.meshPoints.dispose();
        this.meshNormals.dispose();
    }
}
