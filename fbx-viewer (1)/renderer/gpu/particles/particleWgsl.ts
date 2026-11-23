/// <reference types="@webgpu/types" />
import { VERTEX_WGSL } from "../geometryPool";
import { CAMERA_BINDINGS_WGSL, VIEW_WGSL } from "../shaders";
import { MAX_PARTICLE_FORCE_FIELDS } from "../../../runtime/particleEffect";
import { PARTICLE_FORCE_FIELD_FLOATS } from "../../../runtime/particleForceFields";

/**
 * PARTICLE SHADERS
 *
 * The compute and draw shaders every emitter shares. A particle is one record in a storage buffer and never moves; what
 * moves is its number, through three lists: the free slots (dead), the particles alive now (aliveIn) and the ones still
 * alive after this step (aliveOut). A frame is, in order:
 *
 *   spawn         takes slots off the free list for what the CPU asked for this step, in the order it asked.
 *   spawnEvents   the same for what other emitters' particles set off last frame (sub-emitters).
 *   simulate      moves every particle on, collides it against last frame's depth, and hands dead slots back.
 *   sort          orders the alive list back to front, by a radix sort, for what blends.
 *   light         one lighting result per particle, in the forward stage where the light clusters are current.
 *
 * Drawing is one indirect draw over the alive list. A particle born this step carries a negative age (-1 - age) until
 * simulate has seen it once, so it is drawn where it was placed and not one step further on.
 */

/** A particle's bytes. */
export const PARTICLE_BYTES = 64;
export const EVENT_BYTES = 32;
export const EVENT_HEADER_BYTES = 16;
/** What the CPU asks for in one step, in records: anything past this waits for the next step. */
export const MAX_REQUESTS = 256;
export const REQUEST_BYTES = 80;
export const REQUEST_WORDS = REQUEST_BYTES / 4;
export const FORCE_FIELDS_OFFSET_WORDS = 120;
export const PARAMS_WORDS = FORCE_FIELDS_OFFSET_WORDS + MAX_PARTICLE_FORCE_FIELDS * PARTICLE_FORCE_FIELD_FLOATS;
export const PARAMS_BYTES = PARAMS_WORDS * 4;
/** 64 rows of colour and alpha over life, then 64 of size (x) and speed (y). */
export const CURVE_ROWS = 128;
export const CURVE_BYTES = CURVE_ROWS * 16;
export const LINK_BYTES = 32;
export const COUNTER_BYTES = 16;
export const WORKGROUP = 64;
/** Keys one invocation of the radix sort handles in order; what keeps the sort stable while it runs in parallel. */
export const SORT_BLOCK = 1024;
export const SORT_DIGITS = 256;
/** A link meaning "nothing before this one". */
export const NO_LINK = 0xffffffff;

/** Where each set of arguments lies in an emitter's argument buffer, in words. */
export const ARGS = { simulate: 0, events: 3, sortBlocks: 6, eachParticle: 9, quad: 12, mesh: 16 } as const;
export const ARGS_WORDS = 21;

export const PARTICLE_FLAG = {
  local: 1,
  depthCollision: 2,
  groundPlane: 4,
  heightGrid: 8,
  killOnHit: 16,
  wantsDeath: 32,
  wantsCollision: 64,
  ribbon: 128,
  field: 256,
  wrap: 512,
  lit: 1024,
  curl: 2048,
} as const;

/** What a particle sets off: the bits of a sub-emitter's trigger mask. */
export const EVENT_TRIGGER = { death: 1, collision: 2, trail: 4 } as const;

export const PARTICLE_TYPES_WGSL = /* wgsl */ `
const NO_LINK = ${NO_LINK}u;
const FLAG_LOCAL = ${PARTICLE_FLAG.local}u;
const FLAG_DEPTH = ${PARTICLE_FLAG.depthCollision}u;
const FLAG_GROUND = ${PARTICLE_FLAG.groundPlane}u;
const FLAG_GRID = ${PARTICLE_FLAG.heightGrid}u;
const FLAG_KILL = ${PARTICLE_FLAG.killOnHit}u;
const FLAG_WANTS_DEATH = ${PARTICLE_FLAG.wantsDeath}u;
const FLAG_WANTS_COLLISION = ${PARTICLE_FLAG.wantsCollision}u;
const FLAG_RIBBON = ${PARTICLE_FLAG.ribbon}u;
const FLAG_FIELD = ${PARTICLE_FLAG.field}u;
const FLAG_WRAP = ${PARTICLE_FLAG.wrap}u;
const FLAG_LIT = ${PARTICLE_FLAG.lit}u;
const FLAG_CURL = ${PARTICLE_FLAG.curl}u;
const TRIGGER_DEATH = ${EVENT_TRIGGER.death}u;
const TRIGGER_COLLISION = ${EVENT_TRIGGER.collision}u;
const TRIGGER_TRAIL = ${EVENT_TRIGGER.trail}u;

struct Particle {
  position: vec3f,
  // Negative until simulate first sees it: -1 - age.
  age: f32,
  velocity: vec3f,
  lifetime: f32,
  size: f32,
  rotation: f32,
  spin: f32,
  seed: f32,
  color: vec3f,
  // The particle before this one in its ribbon. Valid while that one is alive and not younger than this one: a slot
  // that has been given to somebody else since is younger.
  link: u32,
}

struct ForceField {
  centreRadius: vec4f,
  // Curl uses the first three words for its animated, seeded phases.
  axisStrength: vec4f,
  // Kind, falloff, curl frequency and curl strength normalization.
  settings: vec4f,
}

struct Params {
  emitter: mat4x4f,
  previousEmitter: mat4x4f,
  force: vec3f, dt: f32,
  emitterVelocity: vec3f, clock: f32,
  orbitCentre: vec3f, orbit: f32,
  shapeAxis: vec3f, shapeRadius: f32,
  shapeSize: vec3f, shapeAngle: f32,
  startColorA: vec3f, shapeVolume: f32,
  startColorB: vec3f, randomDirection: f32,
  lifetime: vec2f, speed: vec2f,
  sizeRange: vec2f, rotationRange: vec2f,
  spinRange: vec2f, inheritVelocity: f32, drag: f32,
  turbulence: f32, turbulenceScale: f32, curlStrength: f32, curlScale: f32,
  curlSpeed: f32, fieldStrength: f32, fieldTightness: f32, thickness: f32,
  fieldMin: vec3f, bounce: f32,
  fieldInverseSize: vec3f, friction: f32,
  wrapCentre: vec3f, wrapHalf: f32,
  gridOrigin: vec2f, gridInverseCell: f32, groundY: f32,
  uvGrid: vec2f, fps: f32, stretch: f32,
  emissive: f32, softDistance: f32, fogNear: f32, fogFar: f32,
  fogColor: vec3f, fogDensity: f32,
  trailEvery: f32, spawnTotal: u32, requestCount: u32, seed: u32,
  shapeKind: u32, flags: u32, meshCount: u32, mode: u32,
  frameMode: u32, fogMode: u32, gridCells: u32, forceFieldCount: u32,
  forceFields: array<ForceField, ${MAX_PARTICLE_FORCE_FIELDS}>,
}

struct Curves { rows: array<vec4f, ${CURVE_ROWS}> }

struct SubEvent {
  position: vec3f,
  trigger: u32,
  velocity: vec3f,
  // Which ribbon a particle set off by this joins: the slot of the particle that raised it.
  chain: u32,
}
`;

const COUNTERS_WGSL = /* wgsl */ `
struct Counters {
  alive: atomic<u32>,
  next: atomic<u32>,
  // Signed: taking a slot that is not there goes below nothing for a moment, and is put back.
  dead: atomic<i32>,
  pad: u32,
}
`;

const EMITTER_BINDINGS_WGSL = /* wgsl */ `
@group(1) @binding(0) var<uniform> params: Params;
@group(1) @binding(1) var<uniform> curves: Curves;
@group(1) @binding(2) var<storage, read_write> particles: array<Particle>;
@group(1) @binding(3) var<storage, read_write> counters: Counters;
@group(1) @binding(4) var<storage, read_write> dead: array<u32>;
@group(1) @binding(5) var<storage, read_write> aliveIn: array<u32>;
@group(1) @binding(6) var<storage, read_write> aliveOut: array<u32>;
`;

const RANDOM_WGSL = /* wgsl */ `
var<private> rng: u32;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let word = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (word >> 22u) ^ word;
}

fn random() -> f32 {
  rng = pcg(rng);
  return f32(rng) * (1.0 / 4294967296.0);
}

fn between(range: vec2f) -> f32 {
  return mix(range.x, range.y, random());
}

fn randomUnit() -> vec3f {
  let z = 2.0 * random() - 1.0;
  let t = 6.2831853 * random();
  let s = sqrt(max(0.0, 1.0 - z * z));
  return vec3f(s * cos(t), s * sin(t), z);
}
`;

/** Taking slots and making particles: the CPU's requests and other emitters' events. */
export const SPAWN_WGSL = /* wgsl */ `
${VIEW_WGSL}
${CAMERA_BINDINGS_WGSL}
${PARTICLE_TYPES_WGSL}
${COUNTERS_WGSL}
${EMITTER_BINDINGS_WGSL}
${RANDOM_WGSL}

struct SpawnRequest {
  position: vec3f,
  first: u32,
  velocity: vec3f,
  count: u32,
  colorA: vec3f,
  // 0 laid along the emitter's path this step, 1 the cycle's own, 2 at a point.
  kind: u32,
  colorB: vec3f,
  chain: u32,
  sizeRange: vec2f,
  // How the first one finds what it follows: 0 the chain's table, 1 the request before it, 2 it starts a new ribbon.
  linksBack: u32,
  // Whether the last one becomes what the chain's next particle follows.
  closesChain: u32,
}

struct SpawnData {
  requests: array<SpawnRequest, ${MAX_REQUESTS}>,
  // A point on the model's surface and then its normal, repeating.
  meshPoints: array<vec4f>,
}

@group(2) @binding(0) var<storage, read> spawnData: SpawnData;
@group(2) @binding(1) var<storage, read_write> chains: array<atomic<u32>>;

struct SourceEvents {
  count: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
  items: array<SubEvent>,
}

struct Link {
  triggers: u32,
  count: u32,
  inheritVelocity: f32,
  chance: f32,
  rangeSquared: f32,
  lift: f32,
  salt: u32,
  pad: u32,
}

@group(3) @binding(0) var<storage, read> sourceEvents: SourceEvents;
@group(3) @binding(1) var<uniform> link: Link;

struct SpawnInput {
  kind: u32,
  along: f32,
  point: vec3f,
  velocity: vec3f,
  colorA: vec3f,
  colorB: vec3f,
  sizeRange: vec2f,
}

// A launch direction within 'angle' of the axis a, with u and w across it.
fn coneDirection(a: vec3f, u: vec3f, w: vec3f, angle: f32) -> vec3f {
  let cosT = 1.0 - random() * (1.0 - cos(angle));
  let sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
  let phi = 6.2831853 * random();
  return a * cosT + u * (sinT * cos(phi)) + w * (sinT * sin(phi));
}

fn makeParticle(input: SpawnInput) -> Particle {
  let life = between(params.lifetime);
  let a = params.shapeAxis;
  var u = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(a.x) > 0.9);
  let w = normalize(cross(a, u));
  u = cross(w, a);
  var position = vec3f(0.0);
  var direction = a;
  let depth = 1.0 - params.shapeVolume + params.shapeVolume * random();
  switch params.shapeKind {
    case 1u, 2u: {
      direction = randomUnit();
      if (params.shapeKind == 2u) {
        let side = dot(direction, a);
        if (side < 0.0) { direction -= 2.0 * side * a; }
      }
      position = direction * params.shapeRadius * pow(depth, 1.0 / 3.0);
    }
    case 3u, 5u: {
      let phi = 6.2831853 * random();
      let fraction = sqrt(depth);
      let across = u * cos(phi) + w * sin(phi);
      position = across * fraction * params.shapeRadius;
      if (params.shapeKind == 3u) {
        // Opens outwards: the further from the middle, the more it leans out.
        let lean = params.shapeAngle * fraction;
        direction = a * cos(lean) + across * sin(lean);
      } else {
        direction = coneDirection(a, u, w, params.shapeAngle);
      }
    }
    case 4u: {
      position = (vec3f(random(), random(), random()) - 0.5) * params.shapeSize;
      if (params.shapeVolume < 1.0 && random() >= params.shapeVolume) {
        // A face, picked by its area.
        let size = params.shapeSize;
        let areas = vec3f(size.y * size.z, size.x * size.z, size.x * size.y);
        let pick = random() * (areas.x + areas.y + areas.z);
        let face = select(0.5, -0.5, random() < 0.5);
        if (pick < areas.x) {
          position.x = face * size.x;
        } else if (pick < areas.x + areas.y) {
          position.y = face * size.y;
        } else {
          position.z = face * size.z;
        }
      }
      direction = coneDirection(a, u, w, params.shapeAngle);
    }
    case 6u: {
      position.x = (random() - 0.5) * params.shapeSize.x;
      direction = coneDirection(a, u, w, params.shapeAngle);
    }
    case 7u: {
      if (params.meshCount > 0u) {
        let k = min(u32(random() * f32(params.meshCount)), params.meshCount - 1u);
        position = spawnData.meshPoints[k * 2u].xyz;
        direction = spawnData.meshPoints[k * 2u + 1u].xyz;
      } else {
        direction = coneDirection(a, u, w, params.shapeAngle);
      }
    }
    default: {
      direction = coneDirection(a, u, w, params.shapeAngle);
    }
  }
  if (params.randomDirection > 0.0) {
    direction = normalize(mix(direction, randomUnit(), params.randomDirection) + vec3f(1e-6));
  }

  var placed: vec3f;
  var heading = direction;
  if (input.kind == 2u) {
    // At a point, in whatever space the emitter keeps its particles.
    placed = position + input.point;
  } else if ((params.flags & FLAG_LOCAL) != 0u) {
    placed = position;
  } else {
    let now = (params.emitter * vec4f(position, 1.0)).xyz;
    placed = now;
    if (input.kind == 0u) {
      placed = mix((params.previousEmitter * vec4f(position, 1.0)).xyz, now, input.along);
    }
    let m = params.emitter;
    heading = normalize(mat3x3f(m[0].xyz, m[1].xyz, m[2].xyz) * direction + vec3f(1e-6));
  }
  let velocity = heading * between(params.speed) + params.emitterVelocity * params.inheritVelocity + input.velocity;
  // Where it would be after its share of the step, so emission within a step is smooth.
  let offset = select(params.dt * (1.0 - input.along), 0.0, input.kind == 2u);

  var particle: Particle;
  particle.position = placed + velocity * offset + 0.5 * params.force * offset * offset;
  particle.age = -1.0 - min(offset, life);
  particle.velocity = velocity;
  particle.lifetime = life;
  particle.size = between(input.sizeRange);
  particle.rotation = between(params.rotationRange);
  particle.spin = between(params.spinRange);
  particle.color = mix(input.colorA, input.colorB, random());
  particle.seed = random();
  particle.link = NO_LINK;
  return particle;
}

// One invocation per particle asked for. The numbers fall in the order they were asked for, which is what a ribbon
// needs: each takes the slot the one before it did not, and can name that slot without waiting for it.
@compute @workgroup_size(${WORKGROUP}) fn spawn(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= params.spawnTotal) { return; }
  let available = u32(max(atomicLoad(&counters.dead), 0));
  if (index >= available) { return; }
  let slot = dead[available - 1u - index];

  var low = 0u;
  var high = params.requestCount - 1u;
  while (low < high) {
    let middle = (low + high + 1u) >> 1u;
    if (spawnData.requests[middle].first <= index) { low = middle; } else { high = middle - 1u; }
  }
  let request = spawnData.requests[low];
  let k = index - request.first;
  rng = index * 1664525u + params.seed * 1013904223u + 12345u;
  rng = pcg(rng);

  var input: SpawnInput;
  input.kind = request.kind;
  input.along = 0.0;
  if (request.kind == 0u) {
    input.along = f32(k + 1u) / f32(request.count);
  } else if (request.kind == 1u) {
    input.along = (f32(k) + 0.5) / f32(request.count);
  }
  input.point = request.position;
  input.velocity = request.velocity;
  input.colorA = request.colorA;
  input.colorB = request.colorB;
  input.sizeRange = request.sizeRange;
  var particle = makeParticle(input);

  if ((params.flags & FLAG_RIBBON) != 0u) {
    if (k > 0u || (request.linksBack == 1u && index > 0u)) {
      particle.link = dead[available - index];
    } else if (request.linksBack == 0u) {
      particle.link = atomicLoad(&chains[request.chain % arrayLength(&chains)]);
    }
  }
  particles[slot] = particle;
  aliveIn[atomicLoad(&counters.alive) + index] = slot;
}

// What every invocation above left the counters to say, and where each chain stands now.
@compute @workgroup_size(1) fn spawnEnd() {
  let available = u32(max(atomicLoad(&counters.dead), 0));
  let taken = min(params.spawnTotal, available);
  if ((params.flags & FLAG_RIBBON) != 0u) {
    for (var r = 0u; r < params.requestCount; r++) {
      let first = spawnData.requests[r].first;
      if (spawnData.requests[r].closesChain == 0u || first >= taken) { continue; }
      let last = min(first + spawnData.requests[r].count, taken) - 1u;
      atomicStore(&chains[spawnData.requests[r].chain % arrayLength(&chains)], dead[available - 1u - last]);
    }
  }
  atomicStore(&counters.dead, i32(available - taken));
  atomicStore(&counters.alive, atomicLoad(&counters.alive) + taken);
}

// One invocation per event another emitter raised last frame, each making as many particles as its link says.
@compute @workgroup_size(${WORKGROUP}) fn spawnEvents(@builtin(global_invocation_id) id: vec3u) {
  let total = min(sourceEvents.count, arrayLength(&sourceEvents.items));
  if (id.x >= total) { return; }
  let event = sourceEvents.items[id.x];
  if ((event.trigger & link.triggers) == 0u) { return; }
  rng = id.x * 1664525u + (params.seed ^ link.salt) * 1013904223u + 987654u;
  rng = pcg(rng);
  if (link.chance < 1.0 && random() >= link.chance) { return; }
  if (link.rangeSquared > 0.0) {
    let away = event.position.xz - view.eye.xz;
    if (dot(away, away) > link.rangeSquared) { return; }
  }
  for (var k = 0u; k < link.count; k++) {
    let top = atomicSub(&counters.dead, 1);
    if (top <= 0) {
      atomicAdd(&counters.dead, 1);
      return;
    }
    let slot = dead[u32(top - 1)];
    var input: SpawnInput;
    input.kind = 2u;
    input.along = 0.0;
    input.point = event.position + vec3f(0.0, link.lift, 0.0);
    input.velocity = event.velocity * link.inheritVelocity;
    input.colorA = params.startColorA;
    input.colorB = params.startColorB;
    input.sizeRange = params.sizeRange;
    var particle = makeParticle(input);
    if ((params.flags & FLAG_RIBBON) != 0u) {
      particle.link = atomicExchange(&chains[event.chain % arrayLength(&chains)], slot);
    }
    particles[slot] = particle;
    aliveIn[atomicAdd(&counters.alive, 1u)] = slot;
  }
}
`;

const OCTAHEDRAL_WGSL = /* wgsl */ `
fn unpackOctahedral(e: vec2f) -> vec3f {
  var n = vec3f(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  if (n.z < 0.0) {
    let flipped = (vec2f(1.0) - abs(n.yx)) * select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0));
    n = vec3f(flipped, n.z);
  }
  return normalize(n);
}
`;

const EVENT_LIST_WGSL = /* wgsl */ `
struct EventList {
  count: atomic<u32>,
  pad0: u32,
  pad1: u32,
  pad2: u32,
  items: array<SubEvent>,
}
`;

/** Moving every particle on one step. */
export const SIMULATE_WGSL = /* wgsl */ `
${VIEW_WGSL}
${CAMERA_BINDINGS_WGSL}
${PARTICLE_TYPES_WGSL}
${COUNTERS_WGSL}
${EMITTER_BINDINGS_WGSL}
${EVENT_LIST_WGSL}
${OCTAHEDRAL_WGSL}

@group(2) @binding(0) var<storage, read_write> eventList: EventList;
@group(2) @binding(1) var fieldTexture: texture_3d<f32>;
@group(2) @binding(2) var fieldSampler: sampler;
@group(2) @binding(3) var heightGrid: texture_2d<f32>;

@group(3) @binding(0) var depthTexture: texture_depth_2d;
@group(3) @binding(1) var normalTexture: texture_2d<f32>;
@group(3) @binding(2) var pyramidTexture: texture_2d<f32>;

// A grid cell with nothing in it, as the weather cover has it.
const GRID_OPEN = -1e4;

fn speedAt(life: f32) -> f32 {
  let x = clamp(life, 0.0, 1.0) * 63.0;
  let i = u32(x);
  return mix(curves.rows[64u + i].y, curves.rows[64u + min(i + 1u, 63u)].y, fract(x));
}

fn worldPointOf(position: vec3f) -> vec3f {
  if ((params.flags & FLAG_LOCAL) == 0u) { return position; }
  return (params.emitter * vec4f(position, 1.0)).xyz;
}

// Curl of a windowed vector potential, including the derivative of the radial window.
fn boundedCurl(offset: vec3f, field: ForceField) -> vec3f {
  let radius = field.centreRadius.w;
  // Scale first so even very small radii have a representable squared distance.
  if (any(abs(offset) >= vec3f(radius))) { return vec3f(0.0); }
  let unitOffset = offset / radius;
  let h = 1.0 - dot(unitOffset, unitOffset);
  if (h <= 0.0) { return vec3f(0.0); }
  let exponent = field.settings.y + 2.0;
  let frequency = field.settings.z;
  // The wave vectors share a 20π period per coordinate. Split the period to avoid
  // cancellation when offsets span many wavelengths at f32 precision.
  let q = offset * frequency;
  let turns = round(q * 0.015915494309189534);
  let reduced = (q - turns * 62.828125) - turns * 0.003728071795864769;
  let angle = vec3f(reduced.y + 0.5 * reduced.z, reduced.z + 0.7 * reduced.x, reduced.x - 0.6 * reduced.y) + field.axisStrength.xyz;
  let c = cos(angle);
  let curl = vec3f(-0.6 * c.z - c.y, 0.5 * c.x - c.z, 0.7 * c.y - c.x);
  let windowSlope = pow(h, exponent - 1.0);
  let edgeScale = -2.0 * exponent / (3.0 * radius * frequency + 4.0 * exponent);
  return windowSlope * (h * field.settings.w * curl + edgeScale * cross(unitOffset, sin(angle)));
}

fn fieldAcceleration(position: vec3f) -> vec3f {
  var acceleration = vec3f(0.0);
  for (var i = 0u; i < params.forceFieldCount; i++) {
    let field = params.forceFields[i];
    let offset = position - field.centreRadius.xyz;
    if (field.settings.x == 3.0) {
      acceleration += field.axisStrength.w * boundedCurl(offset, field);
      continue;
    }
    let radius = field.centreRadius.w;
    let distanceSq = dot(offset, offset);
    if (distanceSq >= radius * radius) { continue; }
    var direction = field.axisStrength.xyz;
    if (field.settings.x < 2.0) {
      direction = select(cross(direction, offset), -offset, field.settings.x == 0.0);
      let lengthSq = dot(direction, direction);
      if (lengthSq <= 1e-12) { continue; }
      direction *= inverseSqrt(lengthSq);
    }
    var weight = 1.0;
    if (field.settings.y != 0.0) {
      weight = pow(max(0.0, 1.0 - sqrt(distanceSq) / radius), field.settings.y);
    }
    acceleration += direction * (field.axisStrength.w * weight);
  }
  return acceleration;
}

fn worldDirectionOf(direction: vec3f) -> vec3f {
  if ((params.flags & FLAG_LOCAL) == 0u) { return direction; }
  let m = params.emitter;
  return mat3x3f(m[0].xyz, m[1].xyz, m[2].xyz) * direction;
}

// From world axes into the emitter's own, for a rotation and an even scale.
fn fromWorldDirection(direction: vec3f) -> vec3f {
  if ((params.flags & FLAG_LOCAL) == 0u) { return direction; }
  let m = mat3x3f(params.emitter[0].xyz, params.emitter[1].xyz, params.emitter[2].xyz);
  return transpose(m) * direction / max(dot(m[0], m[0]), 1e-8);
}

fn raise(trigger: u32, position: vec3f, velocity: vec3f, slot: u32) {
  let at = atomicAdd(&eventList.count, 1u);
  if (at >= arrayLength(&eventList.items)) { return; }
  eventList.items[at] = SubEvent(worldPointOf(position), trigger, worldDirectionOf(velocity), slot);
}

fn keep(slot: u32) {
  aliveOut[atomicAdd(&counters.next, 1u)] = slot;
}

fn retire(slot: u32, lifetime: f32) {
  particles[slot].age = lifetime;
  dead[u32(atomicAdd(&counters.dead, 1))] = slot;
}

fn cornerGradient(cell: vec3i, salt: u32) -> vec3f {
  var h = (u32(cell.x) * 73856093u) ^ (u32(cell.y) * 19349663u) ^ (u32(cell.z) * 83492791u) ^ (salt * 2654435761u);
  h = pcg3(h);
  let a = f32(h & 1023u) / 1023.0 * 2.0 - 1.0;
  let b = f32((h >> 10u) & 1023u) / 1023.0 * 6.2831853;
  let s = sqrt(max(0.0, 1.0 - a * a));
  return vec3f(s * cos(b), s * sin(b), a);
}

fn pcg3(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let word = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (word >> 22u) ^ word;
}

// How gradient noise changes across space at p, worked out from the noise itself rather than by more samples of it.
fn noiseSlope(p: vec3f, salt: u32) -> vec3f {
  let cell = vec3i(floor(p));
  let f = p - floor(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  let ga = cornerGradient(cell + vec3i(0, 0, 0), salt);
  let gb = cornerGradient(cell + vec3i(1, 0, 0), salt);
  let gc = cornerGradient(cell + vec3i(0, 1, 0), salt);
  let gd = cornerGradient(cell + vec3i(1, 1, 0), salt);
  let ge = cornerGradient(cell + vec3i(0, 0, 1), salt);
  let gf = cornerGradient(cell + vec3i(1, 0, 1), salt);
  let gg = cornerGradient(cell + vec3i(0, 1, 1), salt);
  let gh = cornerGradient(cell + vec3i(1, 1, 1), salt);
  let va = dot(ga, f - vec3f(0.0, 0.0, 0.0));
  let vb = dot(gb, f - vec3f(1.0, 0.0, 0.0));
  let vc = dot(gc, f - vec3f(0.0, 1.0, 0.0));
  let vd = dot(gd, f - vec3f(1.0, 1.0, 0.0));
  let ve = dot(ge, f - vec3f(0.0, 0.0, 1.0));
  let vf = dot(gf, f - vec3f(1.0, 0.0, 1.0));
  let vg = dot(gg, f - vec3f(0.0, 1.0, 1.0));
  let vh = dot(gh, f - vec3f(1.0, 1.0, 1.0));
  return ga + u.x * (gb - ga) + u.y * (gc - ga) + u.z * (ge - ga)
    + u.x * u.y * (ga - gb - gc + gd) + u.y * u.z * (ga - gc - ge + gg) + u.z * u.x * (ga - gb - ge + gf)
    + (-ga + gb + gc - gd + ge - gf - gg + gh) * u.x * u.y * u.z
    + du * (vec3f(vb - va, vc - va, ve - va)
      + u.yzx * vec3f(va - vb - vc + vd, va - vc - ve + vg, va - vb - ve + vf)
      + u.zxy * vec3f(va - vb - ve + vf, va - vb - vc + vd, va - vc - ve + vg)
      + u.yzx * u.zxy * (-va + vb + vc - vd + ve - vf - vg + vh));
}

// A swirling field with no sources or sinks: what it pushes along stays spread out rather than bunching up.
fn curlNoise(p: vec3f) -> vec3f {
  let a = noiseSlope(p, 1u);
  let b = noiseSlope(p + vec3f(31.7, 11.3, 47.1), 2u);
  let c = noiseSlope(p + vec3f(-17.9, 53.3, 7.7), 3u);
  return vec3f(c.y - b.z, a.z - c.x, b.x - a.y);
}

// How far along the camera's axis a depth-buffer value lies.
fn viewDepthOf(depth: f32) -> f32 {
  let m = view.inverseProjection;
  return -(m[2][2] * depth + m[3][2]) / (m[2][3] * depth + m[3][3]);
}

struct SceneHit {
  found: bool,
  position: vec3f,
  normal: vec3f,
}

fn gridHeightAt(place: vec2f) -> f32 {
  let cell = floor((place - params.gridOrigin) * params.gridInverseCell);
  if (any(cell < vec2f(0.0)) || any(cell >= vec2f(f32(params.gridCells)))) { return GRID_OPEN; }
  return textureLoad(heightGrid, vec2i(cell), 0).r;
}

// Whether a move crossed a surface in last frame's depth buffer, which is what this runs against: the depth of this
// frame is not drawn yet. Anything off the picture is unknown, and is taken to have hit nothing.
fn depthCollide(start: vec3f, stop: vec3f, velocity: vec3f) -> SceneHit {
  var hit: SceneHit;
  let clipFrom = view.previousViewProjection * vec4f(start, 1.0);
  let clipTo = view.previousViewProjection * vec4f(stop, 1.0);
  if (clipFrom.w <= 0.0 || clipTo.w <= 0.0) { return hit; }
  let ndcFrom = clipFrom.xyz / clipFrom.w;
  let ndcTo = clipTo.xyz / clipTo.w;
  if (any(abs(ndcFrom.xy) >= vec2f(1.0)) || any(abs(ndcTo.xy) >= vec2f(1.0))) { return hit; }
  let size = vec2f(textureDimensions(depthTexture));
  let pixelFrom = (ndcFrom.xy * vec2f(0.5, -0.5) + vec2f(0.5)) * size;
  let pixelTo = (ndcTo.xy * vec2f(0.5, -0.5) + vec2f(0.5)) * size;
  let span = length(pixelTo - pixelFrom);
  let viewFrom = viewDepthOf(ndcFrom.z);
  let viewTo = viewDepthOf(ndcTo.z);
  let margin = params.thickness + abs(viewTo - viewFrom);

  // One pyramid texel big enough to cover the whole move holds the farthest surface in that patch. A move behind even
  // that by more than the margin is behind everything there, and needs no closer look: most of what walls hide.
  let level = clamp(i32(ceil(log2(max(span, 1.0)))), 0, i32(textureNumLevels(pyramidTexture)) - 1);
  let tiles = vec2i(textureDimensions(pyramidTexture, level)) - vec2i(1);
  let tileFrom = min(vec2i(pixelFrom) >> vec2u(u32(level)), tiles);
  let tileTo = min(vec2i(pixelTo) >> vec2u(u32(level)), tiles);
  let farthest = min(textureLoad(pyramidTexture, tileFrom, level).r, textureLoad(pyramidTexture, tileTo, level).r);
  if (farthest > 0.0 && min(viewFrom, viewTo) - viewDepthOf(farthest) > margin) { return hit; }

  // A fast particle takes a few looks along its way, so it cannot jump a thin thing between one pixel and the next.
  let samples = min(u32(span / 6.0) + 1u, 4u);
  for (var i = 1u; i <= samples; i++) {
    let t = f32(i) / f32(samples);
    let pixel = vec2i(mix(pixelFrom, pixelTo, t));
    let sceneDepth = textureLoad(depthTexture, pixel, 0);
    // Reversed: a smaller number is further away. Nothing drawn here, or the particle is still in front.
    let particleDepth = mix(ndcFrom.z, ndcTo.z, t);
    if (sceneDepth <= 0.0 || particleDepth >= sceneDepth) { continue; }
    let sceneView = viewDepthOf(sceneDepth);
    if (viewDepthOf(particleDepth) - sceneView > margin) { continue; }
    let normal = unpackOctahedral(textureLoad(normalTexture, pixel, 0).xy);
    if (dot(velocity, normal) >= 0.0) { continue; }
    let crossing = (sceneView - viewFrom) / max(abs(viewTo - viewFrom), 1e-5) * sign(viewTo - viewFrom);
    hit.found = true;
    hit.position = mix(start, stop, saturate(crossing));
    hit.normal = normal;
    return hit;
  }
  return hit;
}

fn sceneHitOf(start: vec3f, stop: vec3f, velocity: vec3f) -> SceneHit {
  var hit: SceneHit;
  let flags = params.flags;
  if ((flags & FLAG_GROUND) != 0u && stop.y < params.groundY && velocity.y < 0.0) {
    hit.found = true;
    hit.position = vec3f(stop.x, params.groundY, stop.z);
    hit.normal = vec3f(0.0, 1.0, 0.0);
    return hit;
  }
  if ((flags & FLAG_GRID) != 0u) {
    let top = gridHeightAt(stop.xz);
    if (top > GRID_OPEN && stop.y <= top) {
      hit.found = true;
      hit.position = vec3f(stop.x, top, stop.z);
      hit.normal = vec3f(0.0, 1.0, 0.0);
      return hit;
    }
  }
  if ((flags & FLAG_DEPTH) != 0u) { return depthCollide(start, stop, velocity); }
  return hit;
}

@compute @workgroup_size(${WORKGROUP}) fn simulate(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= atomicLoad(&counters.alive)) { return; }
  let slot = aliveIn[id.x];
  let before = particles[slot];
  if (before.age < 0.0) {
    // Placed this step already.
    particles[slot].age = -1.0 - before.age;
    keep(slot);
    return;
  }
  let dt = params.dt;
  let flags = params.flags;
  let age = before.age + dt;
  if (age >= before.lifetime) {
    if ((flags & FLAG_WANTS_DEATH) != 0u) { raise(TRIGGER_DEATH, before.position, before.velocity, slot); }
    retire(slot, before.lifetime);
    return;
  }

  var velocity = before.velocity + params.force * dt;
  if (params.forceFieldCount > 0u) {
    velocity += fieldAcceleration(before.position) * dt;
  }
  if (params.turbulence > 0.0) {
    let q = before.position / params.turbulenceScale;
    let t = params.clock * 0.6;
    velocity += vec3f(
      sin(q.y * 1.3 + t) + cos(q.z * 0.7 - t * 0.8),
      sin(q.z * 1.1 + t * 1.2) + cos(q.x * 0.9 + t * 0.5),
      sin(q.x * 1.2 - t * 0.9) + cos(q.y * 1.5 + t * 1.1),
    ) * params.turbulence * 0.5 * dt;
  }
  if ((flags & (FLAG_CURL | FLAG_FIELD)) != 0u) {
    let world = worldPointOf(before.position);
    if ((flags & FLAG_CURL) != 0u) {
      let at = world / params.curlScale + vec3f(0.0, params.clock * params.curlSpeed, 0.0);
      velocity += fromWorldDirection(curlNoise(at)) * params.curlStrength * dt;
    }
    if ((flags & FLAG_FIELD) != 0u) {
      let uvw = (world - params.fieldMin) * params.fieldInverseSize;
      if (all(uvw >= vec3f(0.0)) && all(uvw <= vec3f(1.0))) {
        let field = fromWorldDirection(textureSampleLevel(fieldTexture, fieldSampler, uvw, 0.0).xyz) * params.fieldStrength;
        // With a tightness it steers toward the field's velocity; with none the field is a push.
        if (params.fieldTightness > 0.0) {
          velocity = mix(velocity, field, 1.0 - exp(-params.fieldTightness * dt));
        } else {
          velocity += field * dt;
        }
      }
    }
  }
  velocity *= exp(-params.drag * dt);
  var position = before.position + velocity * speedAt(age / before.lifetime) * dt;
  if (params.orbit != 0.0) {
    // Circling the emitter's vertical axis.
    let r = position.xz - params.orbitCentre.xz;
    let c = cos(params.orbit * dt);
    let s = sin(params.orbit * dt);
    position.x = params.orbitCentre.x + r.x * c + r.y * s;
    position.z = params.orbitCentre.z - r.x * s + r.y * c;
  }
  if ((flags & FLAG_WRAP) != 0u) {
    // Round the box, so a camera never leaves the weather behind.
    let span = params.wrapHalf * 2.0;
    let away = position.xz - params.wrapCentre.xz;
    position.x -= span * (f32(away.x > params.wrapHalf) - f32(away.x < -params.wrapHalf));
    position.z -= span * (f32(away.y > params.wrapHalf) - f32(away.y < -params.wrapHalf));
  }
  if ((flags & (FLAG_DEPTH | FLAG_GROUND | FLAG_GRID)) != 0u) {
    let hit = sceneHitOf(before.position, position, velocity);
    if (hit.found) {
      if ((flags & FLAG_WANTS_COLLISION) != 0u) { raise(TRIGGER_COLLISION, hit.position, velocity, slot); }
      if ((flags & FLAG_KILL) != 0u) {
        if ((flags & FLAG_WANTS_DEATH) != 0u) { raise(TRIGGER_DEATH, hit.position, velocity, slot); }
        retire(slot, before.lifetime);
        return;
      }
      // Bounce: the speed into the surface reversed and cut, the speed along it slowed.
      let into = dot(velocity, hit.normal);
      let along = velocity - into * hit.normal;
      let back = select(into, -into * params.bounce, into < 0.0);
      velocity = along * (1.0 - params.friction) + hit.normal * back;
      position = hit.position + hit.normal * 0.01;
    }
  }
  if (params.trailEvery > 0.0 && floor(age / params.trailEvery) != floor(before.age / params.trailEvery)) {
    raise(TRIGGER_TRAIL, position, velocity, slot);
  }
  particles[slot].position = position;
  particles[slot].velocity = velocity;
  particles[slot].age = age;
  keep(slot);
}
`;

/** Before and after a step: the sizes everything indirect takes, worked out where the counts are. */
export const CONTROL_WGSL = /* wgsl */ `
${VIEW_WGSL}
${CAMERA_BINDINGS_WGSL}
${PARTICLE_TYPES_WGSL}
${COUNTERS_WGSL}
${EMITTER_BINDINGS_WGSL}
${EVENT_LIST_WGSL}

@group(2) @binding(0) var<storage, read_write> eventList: EventList;
@group(3) @binding(0) var<storage, read_write> args: array<u32>;

@compute @workgroup_size(1) fn beginStep() {
  args[${ARGS.simulate}] = (atomicLoad(&counters.alive) + ${WORKGROUP - 1}u) / ${WORKGROUP}u;
  atomicStore(&counters.next, 0u);
  atomicStore(&eventList.count, 0u);
}

@compute @workgroup_size(1) fn endStep() {
  let next = atomicLoad(&counters.next);
  atomicStore(&counters.alive, next);
  let events = min(atomicLoad(&eventList.count), arrayLength(&eventList.items));
  atomicStore(&eventList.count, events);
  args[${ARGS.events}] = (events + ${WORKGROUP - 1}u) / ${WORKGROUP}u;
  args[${ARGS.sortBlocks}] = (next + ${SORT_BLOCK - 1}u) / ${SORT_BLOCK}u;
  args[${ARGS.eachParticle}] = (next + ${WORKGROUP - 1}u) / ${WORKGROUP}u;
  args[${ARGS.quad + 1}] = next;
  args[${ARGS.mesh + 1}] = next;
}
`;

/**
 * Back to front by a radix sort of two rounds over 16-bit keys. Each block of keys is counted on its own, and the counts
 * of all the blocks say exactly where each block's keys of each digit go, so blocks can move their keys at the same time
 * and still keep equal keys in order. The keys are the logarithm of the distance along the camera's axis: fine close up,
 * where order shows.
 */
export const SORT_WGSL = /* wgsl */ `
${VIEW_WGSL}
${CAMERA_BINDINGS_WGSL}
${PARTICLE_TYPES_WGSL}

override SHIFT: u32 = 0u;

@group(1) @binding(0) var<uniform> params: Params;
@group(1) @binding(1) var<storage, read> particles: array<Particle>;
@group(1) @binding(2) var<storage, read_write> alive: array<u32>;
@group(1) @binding(3) var<storage, read> aliveCount: u32;

@group(2) @binding(0) var<storage, read> keysIn: array<vec2u>;
@group(2) @binding(1) var<storage, read_write> keysOut: array<vec2u>;
@group(2) @binding(2) var<storage, read_write> histogram: array<u32>;

@compute @workgroup_size(${WORKGROUP}) fn makeKeys(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= aliveCount) { return; }
  let slot = alive[id.x];
  var position = particles[slot].position;
  if ((params.flags & FLAG_LOCAL) != 0u) { position = (params.emitter * vec4f(position, 1.0)).xyz; }
  let m = view.viewMatrix;
  let distance = -(m[0][2] * position.x + m[1][2] * position.y + m[2][2] * position.z + m[3][2]);
  let scaled = clamp(log2(1.0 + max(distance, 0.0)) / 16.0, 0.0, 1.0);
  // Furthest first: the smallest key.
  keysOut[id.x] = vec2u(65535u - u32(scaled * 65535.0), slot);
}

@compute @workgroup_size(1) fn countDigits(@builtin(global_invocation_id) id: vec3u) {
  let block = id.x;
  let start = block * ${SORT_BLOCK}u;
  let end = min(start + ${SORT_BLOCK}u, aliveCount);
  var counts: array<u32, ${SORT_DIGITS}>;
  for (var i = start; i < end; i++) {
    let digit = (keysIn[i].x >> SHIFT) & ${SORT_DIGITS - 1}u;
    counts[digit] += 1u;
  }
  for (var digit = 0u; digit < ${SORT_DIGITS}u; digit++) {
    histogram[block * ${SORT_DIGITS}u + digit] = counts[digit];
  }
}

@compute @workgroup_size(1) fn digitOffsets() {
  let blocks = (aliveCount + ${SORT_BLOCK - 1}u) / ${SORT_BLOCK}u;
  var running = 0u;
  for (var digit = 0u; digit < ${SORT_DIGITS}u; digit++) {
    for (var block = 0u; block < blocks; block++) {
      let at = block * ${SORT_DIGITS}u + digit;
      let count = histogram[at];
      histogram[at] = running;
      running += count;
    }
  }
}

@compute @workgroup_size(1) fn scatter(@builtin(global_invocation_id) id: vec3u) {
  let block = id.x;
  var offsets: array<u32, ${SORT_DIGITS}>;
  for (var digit = 0u; digit < ${SORT_DIGITS}u; digit++) {
    offsets[digit] = histogram[block * ${SORT_DIGITS}u + digit];
  }
  let start = block * ${SORT_BLOCK}u;
  let end = min(start + ${SORT_BLOCK}u, aliveCount);
  for (var i = start; i < end; i++) {
    let key = keysIn[i];
    let digit = (key.x >> SHIFT) & ${SORT_DIGITS - 1}u;
    keysOut[offsets[digit]] = key;
    offsets[digit] += 1u;
  }
}

@compute @workgroup_size(${WORKGROUP}) fn writeBack(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= aliveCount) { return; }
  alive[id.x] = keysIn[id.x].y;
}
`;

/**
 * One lighting result per particle, from the lighting the rest of the scene gets. A sprite has no surface to light, so it
 * is taken as a bit of thin haze: what falls on its near side and on its far side, averaged. Pasted after the lighting
 * WGSL, which is group 3.
 */
export const particleLightWgsl = (lightingWgsl: string): string => /* wgsl */ `
${VIEW_WGSL}
${CAMERA_BINDINGS_WGSL}
${PARTICLE_TYPES_WGSL}
${lightingWgsl}

@group(1) @binding(0) var<uniform> params: Params;
@group(1) @binding(1) var<storage, read> alive: array<u32>;
@group(1) @binding(2) var<storage, read> aliveCount: u32;
@group(2) @binding(0) var<storage, read> particles: array<Particle>;
@group(2) @binding(1) var<storage, read_write> particleLight: array<vec4f>;

@compute @workgroup_size(${WORKGROUP}) fn lightParticles(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= aliveCount) { return; }
  let slot = alive[id.x];
  var position = particles[slot].position;
  if ((params.flags & FLAG_LOCAL) != 0u) { position = (params.emitter * vec4f(position, 1.0)).xyz; }
  let toEye = normalize(view.eye.xyz - position);
  let pixel = vec2f(f32(slot % 256u), f32((slot / 256u) % 256u));
  let near = lightingInput(position, toEye, toEye, vec3f(1.0), 1.0, 0.0, pixel);
  let far = lightingInput(position, -toEye, -toEye, vec3f(1.0), 1.0, 0.0, pixel);
  particleLight[slot] = vec4f((lightSurface(near) + lightSurface(far)) * 0.5, 1.0);
}
`;

/** Group 0 the view, group 1 the scene's vertex table, group 2 the emitter. */
export const DRAW_WGSL = /* wgsl */ `
${VIEW_WGSL}
${CAMERA_BINDINGS_WGSL}
${VERTEX_WGSL}
${PARTICLE_TYPES_WGSL}
${OCTAHEDRAL_WGSL}

@group(1) @binding(1) var<storage, read> vertices: array<Vertex>;

@group(2) @binding(0) var<uniform> params: Params;
@group(2) @binding(1) var<uniform> curves: Curves;
@group(2) @binding(2) var<storage, read> particles: array<Particle>;
@group(2) @binding(3) var<storage, read> alive: array<u32>;
@group(2) @binding(4) var sprite: texture_2d<f32>;
@group(2) @binding(5) var spriteSampler: sampler;
@group(2) @binding(6) var sceneDepth: texture_depth_2d;
@group(2) @binding(7) var<storage, read> particleLight: array<vec4f>;

struct DrawVarying {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) viewDepth: f32,
  @location(3) world: vec3f,
  @location(4) normal: vec3f,
}

fn gradientAt(life: f32) -> vec4f {
  let x = clamp(life, 0.0, 1.0) * 63.0;
  let i = u32(x);
  return mix(curves.rows[i], curves.rows[min(i + 1u, 63u)], fract(x));
}

fn sizeAt(life: f32) -> f32 {
  let x = clamp(life, 0.0, 1.0) * 63.0;
  let i = u32(x);
  return mix(curves.rows[64u + i].x, curves.rows[64u + min(i + 1u, 63u)].x, fract(x));
}

fn worldPointOf(position: vec3f) -> vec3f {
  if ((params.flags & FLAG_LOCAL) == 0u) { return position; }
  return (params.emitter * vec4f(position, 1.0)).xyz;
}

fn worldDirectionOf(direction: vec3f) -> vec3f {
  if ((params.flags & FLAG_LOCAL) == 0u) { return direction; }
  let m = params.emitter;
  return mat3x3f(m[0].xyz, m[1].xyz, m[2].xyz) * direction;
}

fn lightOf(slot: u32) -> vec3f {
  if ((params.flags & FLAG_LIT) == 0u) { return vec3f(1.0); }
  return particleLight[slot].rgb;
}

fn frameOf(particle: Particle, life: f32) -> f32 {
  let frames = params.uvGrid.x * params.uvGrid.y;
  if (frames <= 1.0) { return 0.0; }
  if (params.frameMode == 0u) { return min(frames - 1.0, floor(life * frames)); }
  if (params.frameMode == 1u) { return floor(particle.seed * frames + particle.age * params.fps) % frames; }
  return min(frames - 1.0, floor(particle.seed * frames));
}

// A sheet's frames read across then down from its top left; v rises up the picture.
fn frameUv(frame: f32, corner: vec2f) -> vec2f {
  let column = frame % params.uvGrid.x;
  let row = floor(frame / params.uvGrid.x);
  return (vec2f(column, params.uvGrid.y - 1.0 - row) + corner) / params.uvGrid;
}

fn turned(corner: vec2f, rotation: f32) -> vec2f {
  let c = cos(rotation);
  let s = sin(rotation);
  return vec2f(c * corner.x - s * corner.y, s * corner.x + c * corner.y);
}

// Where one corner of a particle's quad goes: facing the camera and turned by its rotation (0), stretched along its motion
// (1), flat facing up (2), or upright facing the camera (3).
fn cornerOf(center: vec3f, velocity: vec3f, corner: vec2f, size: f32, rotation: f32) -> vec3f {
  switch params.mode {
    case 1u: {
      let speed = length(velocity);
      let axis = select(vec3f(0.0, 1.0, 0.0), velocity / max(speed, 1e-6), speed > 1e-4);
      let across = cross(axis, normalize(view.eye.xyz - center));
      let acrossLength = length(across);
      let side = select(vec3f(1.0, 0.0, 0.0), across / max(acrossLength, 1e-6), acrossLength > 1e-4);
      return center + side * corner.x * size + axis * corner.y * size * (1.0 + params.stretch * speed);
    }
    case 2u: {
      let lying = turned(corner, rotation) * size;
      return center + vec3f(lying.x, 0.0, lying.y);
    }
    case 3u: {
      let toEye = view.eye.xyz - center;
      let right = normalize(vec3f(toEye.z, 0.0, -toEye.x) + vec3f(1e-5, 0.0, 0.0));
      return center + right * corner.x * size + vec3f(0.0, corner.y * size, 0.0);
    }
    default: {
      let m = view.viewMatrix;
      let right = vec3f(m[0][0], m[1][0], m[2][0]);
      let up = vec3f(m[0][1], m[1][1], m[2][1]);
      let spun = turned(corner, rotation) * size;
      return center + right * spun.x + up * spun.y;
    }
  }
}

fn finish(out: ptr<function, DrawVarying>, world: vec3f) {
  (*out).clip = view.viewProjection * vec4f(world, 1.0);
  let m = view.viewMatrix;
  (*out).viewDepth = -(m[0][2] * world.x + m[1][2] * world.y + m[2][2] * world.z + m[3][2]);
  (*out).world = world;
}

const QUAD_CORNERS = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));

@vertex fn quadVertex(@builtin(vertex_index) index: u32, @builtin(instance_index) instance: u32) -> DrawVarying {
  let slot = alive[instance];
  let particle = particles[slot];
  let life = clamp(particle.age / particle.lifetime, 0.0, 1.0);
  let tint = gradientAt(life);
  let corner = QUAD_CORNERS[index];
  let world = cornerOf(
    worldPointOf(particle.position),
    worldDirectionOf(particle.velocity),
    corner - vec2f(0.5),
    particle.size * sizeAt(life),
    particle.rotation + particle.spin * particle.age,
  );
  var out: DrawVarying;
  finish(&out, world);
  out.uv = frameUv(frameOf(particle, life), corner);
  out.color = vec4f(particle.color * tint.rgb * lightOf(slot), tint.a);
  out.normal = normalize(view.eye.xyz - world);
  return out;
}

// Which particle (0 this one, 1 the one it follows) and which edge a ribbon segment's corner takes.
const RIBBON_CORNERS = array<vec2f, 6>(vec2f(0.0, 1.0), vec2f(0.0, -1.0), vec2f(1.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, -1.0), vec2f(1.0, -1.0));

fn followed(particle: Particle) -> u32 {
  if (particle.link == NO_LINK) { return NO_LINK; }
  let before = particles[particle.link];
  // Gone, or the slot belongs to someone born since.
  if (before.age >= before.lifetime || before.age < particle.age) { return NO_LINK; }
  return particle.link;
}

// One segment per particle, from it back to the particle it follows. Each end's width direction comes only from that end's
// particle and the one behind it, so the next segment along shares its edge exactly and no gap opens at a bend.
@vertex fn ribbonVertex(@builtin(vertex_index) index: u32, @builtin(instance_index) instance: u32) -> DrawVarying {
  var out: DrawVarying;
  let slot = alive[instance];
  let particle = particles[slot];
  let linked = followed(particle);
  if (linked == NO_LINK) {
    out.clip = vec4f(2.0, 2.0, 2.0, 1.0);
    return out;
  }
  let before = particles[linked];
  let here = worldPointOf(particle.position);
  let there = worldPointOf(before.position);
  let corner = RIBBON_CORNERS[index];
  var end = particle;
  var endSlot = slot;
  var at = here;
  var tangent = here - there;
  if (corner.x > 0.5) {
    end = before;
    endSlot = linked;
    at = there;
    let further = followed(before);
    if (further != NO_LINK) { tangent = there - worldPointOf(particles[further].position); }
  }
  let life = clamp(end.age / end.lifetime, 0.0, 1.0);
  let tint = gradientAt(life);
  let width = end.size * sizeAt(life) * 0.5;
  let across = cross(view.eye.xyz - at, tangent);
  let acrossLength = length(across);
  let side = select(vec3f(width, 0.0, 0.0), across * (width / max(acrossLength, 1e-6)), acrossLength > 1e-6);
  let world = at + side * corner.y;
  finish(&out, world);
  out.uv = vec2f(select(1.0, 0.0, corner.y > 0.0), 0.5);
  out.color = vec4f(end.color * tint.rgb * lightOf(endSlot), tint.a);
  out.normal = normalize(view.eye.xyz - world);
  return out;
}

fn rotateAbout(v: vec3f, axis: vec3f, angle: f32) -> vec3f {
  let c = cos(angle);
  let s = sin(angle);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}

// A model in the geometry pool, one per particle, turning about an axis of its own picked from its seed.
@vertex fn meshVertex(@builtin(vertex_index) index: u32, @builtin(instance_index) instance: u32) -> DrawVarying {
  let slot = alive[instance];
  let particle = particles[slot];
  let life = clamp(particle.age / particle.lifetime, 0.0, 1.0);
  let tint = gradientAt(life);
  let v = vertices[index];
  let t = particle.seed * 6.2831853 * 13.0;
  let z = particle.seed * 2.0 - 1.0;
  let s = sqrt(max(0.0, 1.0 - z * z));
  let axis = vec3f(s * cos(t), s * sin(t), z);
  let angle = particle.rotation + particle.spin * particle.age;
  let local = rotateAbout(vec3f(v.px, v.py, v.pz) * (particle.size * sizeAt(life)), axis, angle);
  let world = worldPointOf(particle.position) + local;
  var out: DrawVarying;
  finish(&out, world);
  out.uv = frameUv(frameOf(particle, life), vec2f(v.u0, v.v0));
  out.color = vec4f(particle.color * tint.rgb, tint.a);
  out.normal = rotateAbout(unpackOctahedral(unpack2x16snorm(v.normal)), axis, angle);
  return out;
}

fn sceneViewDepth(depth: f32) -> f32 {
  let m = view.inverseProjection;
  return -(m[2][2] * depth + m[3][2]) / (m[2][3] * depth + m[3][3]);
}

// Fades out where it meets the scene behind it, so a sprite never shows the straight line it cuts through a wall.
fn softFade(in: DrawVarying) -> f32 {
  if (params.softDistance <= 0.0) { return 1.0; }
  let depth = textureLoad(sceneDepth, vec2i(in.clip.xy), 0);
  if (depth <= 0.0) { return 1.0; }
  return saturate((sceneViewDepth(depth) - in.viewDepth) / params.softDistance);
}

// scene.fog by the distance along the camera's axis. Added light fades away rather than turning the fog's colour.
fn fogged(color: vec3f, viewDepth: f32, additive: bool) -> vec3f {
  if (params.fogMode == 0u) { return color; }
  var factor: f32;
  if (params.fogMode == 1u) {
    let t = saturate((viewDepth - params.fogNear) / max(params.fogFar - params.fogNear, 1e-5));
    factor = t * t * (3.0 - 2.0 * t);
  } else {
    let amount = params.fogDensity * viewDepth;
    factor = 1.0 - exp(-amount * amount);
  }
  if (additive) { return color * (1.0 - factor); }
  return mix(color, params.fogColor, factor);
}

override ADDITIVE: bool = false;

@fragment fn fragmentMain(in: DrawVarying) -> @location(0) vec4f {
  let texel = textureSample(sprite, spriteSampler, in.uv);
  let alpha = in.color.a * texel.a * softFade(in);
  if (alpha < 0.003) { discard; }
  return vec4f(fogged(in.color.rgb * texel.rgb * params.emissive, in.viewDepth, ADDITIVE), alpha);
}
`;

/** The draw shader for a mesh particle lit pixel by pixel: it has real normals, which a sprite does not. */
export const litMeshDrawWgsl = (lightingWgsl: string): string => /* wgsl */ `
${DRAW_WGSL}
${lightingWgsl}

@fragment fn fragmentLit(in: DrawVarying, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {
  let texel = textureSample(sprite, spriteSampler, in.uv);
  let alpha = in.color.a * texel.a * softFade(in);
  if (alpha < 0.003) { discard; }
  let normal = normalize(in.normal) * select(-1.0, 1.0, frontFacing);
  let toEye = normalize(view.eye.xyz - in.world);
  let input = lightingInput(in.world, normal, toEye, in.color.rgb * texel.rgb, 0.8, 0.0, in.clip.xy);
  return vec4f(fogged(lightSurface(input) * params.emissive, in.viewDepth, ADDITIVE), alpha);
}
`;
