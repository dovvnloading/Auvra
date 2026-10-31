import {
  ATLAS_HEIGHT,
  ATLAS_IRRADIANCE_WIDTH,
  ATLAS_OFFSET_Y,
  ATLAS_ROWS,
  ATLAS_WIDTH,
  GI_CASCADES,
  GRID_LIFT,
  IRRADIANCE_CELL,
  IRRADIANCE_TEXELS,
  MAX_RAYS_PER_PROBE,
  PROBES_PER_CASCADE,
  PROBES_X,
  PROBES_Y,
  PROBES_Z,
  VISIBILITY_CELL,
  VISIBILITY_TEXELS,
} from "../../../runtime/lighting/dynamicGi/probeGrid";
import { RAY_REFLECTION_ROUGHNESS } from "../../../runtime/lighting/dynamicGi/giMaterials";
import { LIGHTING_WGSL } from "../lightingWgsl";
import { CAMERA_BINDINGS_WGSL, FULLSCREEN_WGSL, VIEW_WGSL } from "../shaders";
import { GI_DIRECT_WGSL, giSharedWgsl } from "./giShared";
import { lightVolumeWgsl } from "./lightVolumeWgsl";
import { raySceneWgsl } from "./rayWgsl";

/**
 * THE PROGRAMS THAT GATHER LIGHT
 *
 *  1. Trace: each probe sends its rays. A ray that lands takes the light at that point: the sun and lights that reach
 *     it, shadow rays deciding, what it gives off, and the light the probes there hold, which is how light carries on
 *     bouncing from frame to frame. One that escapes brings the sky.
 *  2. Integrate: for each direction a surface may face, the rays in a probe's table are summed and eased into what it
 *     held. Its distances likewise. A probe whose rays met the insides of things moves out of them, so that one buried
 *     in a wall or a crate comes back into use. All of this goes to a scratch buffer.
 *  3. Store: the scratch buffer goes into the atlas, which cannot be read and written by one dispatch.
 *
 * Then what reads them: gathered irradiance per pixel for the lighting pass, reflections through rays, the program that
 * puts those on the lit picture, and the views that show the light itself.
 *
 * Atlas (half-float), as probeGrid.ts lays it out:
 *   left:  each probe's irradiance over the directions a surface may face; a holds 1 where it is sound, 0 where it
 *          stands inside something, and -1 until it has been traced
 *   right: each probe's mean distance to what it sees and the square of it, in the same directions
 *   under the left: how far each probe has moved from its place in the grid, one texel each
 */

/** A probe's words in the scratch buffer, all of them vec4f: its irradiance cell, its visibility cell, its offset. */
export const SCRATCH_STRIDE = IRRADIANCE_CELL * IRRADIANCE_CELL + VISIBILITY_CELL * VISIBILITY_CELL + 1;
/** Power of the cosine lobe each visibility texel gathers rays over. */
const VISIBILITY_SHARPNESS = 64;
/** How close to a surface a probe may stand, and how far it may move from its place in the grid, in spacings. */
const PROBE_MARGIN = 0.15;
const PROBE_MOVE_LIMIT = 0.45;

const ROUGH_LOW = RAY_REFLECTION_ROUGHNESS[0].toFixed(2);
const ROUGH_HIGH = RAY_REFLECTION_ROUGHNESS[1].toFixed(2);

const FOLD_WGSL = /* wgsl */ `
// A direction folded flat, each coordinate -1 to 1.
fn giFold(direction: vec3f) -> vec2f {
  let a = direction / (abs(direction.x) + abs(direction.y) + abs(direction.z));
  if (a.z < 0.0) {
    return (vec2f(1.0) - abs(a.yx)) * select(vec2f(-1.0), vec2f(1.0), a.xy >= vec2f(0.0));
  }
  return a.xy;
}

fn giUnfold(folded: vec2f) -> vec3f {
  var n = vec3f(folded, 1.0 - abs(folded.x) - abs(folded.y));
  if (n.z < 0.0) {
    n = vec3f((vec2f(1.0) - abs(n.yx)) * select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0)), n.z);
  }
  return normalize(n);
}
`;

/** Reads the probes: needs giSharedWgsl. */
export const PROBE_SAMPLE_WGSL = /* wgsl */ `
${FOLD_WGSL}
// The column and row of a probe in its cascade's part of the atlas: wraps with the world, as probeGrid.ts does.
fn giPlace(world: vec3i) -> vec2i {
  let cell = world & vec3i(${PROBES_X - 1}, ${PROBES_Y - 1}, ${PROBES_Z - 1});
  return vec2i(cell.x + ${PROBES_X} * (cell.y & 3), cell.z + ${PROBES_Z} * (cell.y >> 2u));
}

fn giCascadeIrradiance(cascade: u32, point: vec3f, normal: vec3f, toViewer: vec3f) -> vec4f {
  let grid = giShared.grids[cascade];
  let spacing = grid.w;
  // Read a little out from the surface and toward the viewer, so a surface does not sit on the probes' horizon.
  let biased = point + (normal * 0.2 + toViewer * 0.8) * spacing * 0.3;
  let local = (biased - grid.xyz) / spacing;
  let base = clamp(floor(local), vec3f(0.0), vec3f(${(PROBES_X - 2).toFixed(1)}, ${(PROBES_Y - 2).toFixed(1)}, ${(PROBES_Z - 2).toFixed(1)}));
  let f = clamp(local - base, vec3f(0.0), vec3f(1.0));
  let low = vec3i(floor(grid.xyz / spacing - vec3f(0.0, ${GRID_LIFT}, 0.0) + 0.5)) + vec3i(base);
  let normalFold = giFold(normal) * 0.5 + 0.5;
  let atlasSize = vec2f(${ATLAS_WIDTH.toFixed(1)}, ${ATLAS_HEIGHT.toFixed(1)});
  let row = vec2i(0, i32(cascade) * ${ATLAS_ROWS});
  var sum = vec3f(0.0);
  var total = 0.0;
  for (var i = 0u; i < giShared.counts.y; i++) {
    let corner = vec3u(i & 1u, (i >> 1u) & 1u, (i >> 2u) & 1u);
    let place = giPlace(low + vec3i(corner)) + row;
    let irradianceAt = vec2f(place) * ${IRRADIANCE_CELL.toFixed(1)} + 1.0 + normalFold * ${IRRADIANCE_TEXELS.toFixed(1)};
    let irradiance = textureSampleLevel(giAtlas, giLinear, irradianceAt / atlasSize, 0.0);
    if (irradiance.a <= 0.0) { continue; }
    // It may have moved out of something it was buried in; what it saw, it saw from there.
    let probe = grid.xyz + (base + vec3f(corner)) * spacing + textureLoad(giAtlas, place + vec2i(0, ${ATLAS_OFFSET_Y}), 0).xyz;
    let away = biased - probe;
    let gap = length(away);
    let awayFold = giFold(away / max(gap, 1e-4)) * 0.5 + 0.5;
    let visibilityAt = vec2f(${ATLAS_IRRADIANCE_WIDTH.toFixed(1)}, 0.0) + vec2f(place) * ${VISIBILITY_CELL.toFixed(1)} + 1.0 + awayFold * ${VISIBILITY_TEXELS.toFixed(1)};
    let moments = textureSampleLevel(giAtlas, giLinear, visibilityAt / atlasSize, 0.0).rg;
    var seen = 1.0;
    if (gap > moments.x) {
      let variance = abs(moments.y - moments.x * moments.x);
      let beyond = gap - moments.x;
      seen = variance / max(variance + beyond * beyond, 1e-5);
      seen = seen * seen * seen;
    }
    // Behind the surface it counts for little, without ever dropping to nothing: that leaves dark rings.
    let facing = (dot(normalize(probe - point), normal) + 1.0) * 0.5;
    let near = mix(vec3f(1.0) - f, f, vec3f(corner));
    var weight = near.x * near.y * near.z * (facing * facing + 0.2) * max(seen, 0.02);
    // Very small weights crushed further: otherwise a sea of them from unseen probes greys the dark.
    if (weight < 0.2) { weight *= weight * weight / 0.04; }
    // Never quite nothing: at a corner every probe may seem hidden, and the least hidden must still answer.
    weight = max(weight, 1e-12);
    // Blended in a gentler space, so one bright probe does not outshine its neighbours across the whole cell.
    sum += sqrt(max(irradiance.rgb, vec3f(0.0))) * weight;
    total += weight;
  }
  if (total <= 0.0) { return vec4f(0.0); }
  let mean = sum / total;
  return vec4f(mean * mean, 1.0);
}

// The light reaching a surface, and in a how far it holds: 0 where nothing has been gathered yet or out of range.
// Between two cascades a pixel reads one or the other, as noise (0 to 1) falls, and temporal anti-aliasing evens them
// out. A cascade with nothing sound in this cell gives way to the next.
fn giIrradiance(point: vec3f, normal: vec3f, toViewer: vec3f, noise: f32) -> vec4f {
  if (giShared.has.x == 0u) { return vec4f(0.0); }
  var inside = -1i;
  var reach = 0.0;
  for (var cascade = 0; cascade < ${GI_CASCADES}; cascade++) {
    let grid = giShared.grids[cascade];
    let local = (point - grid.xyz) / grid.w;
    let room = min(local, vec3f(${(PROBES_X - 1).toFixed(1)}, ${(PROBES_Y - 1).toFixed(1)}, ${(PROBES_Z - 1).toFixed(1)}) - local);
    let inner = min(min(room.x, room.y), room.z);
    if (inner > 0.5) {
      inside = cascade;
      reach = inner;
      break;
    }
  }
  if (inside < 0i) { return vec4f(0.0); }
  let settle = smoothstep(0.5, 2.0, reach);
  if (inside < ${GI_CASCADES - 1} && noise > settle) { inside++; }
  // The outermost has nothing beyond it to hand over to, so it fades.
  let share = select(1.0, settle, inside == ${GI_CASCADES - 1});
  var here = vec4f(0.0);
  for (var cascade = u32(inside); cascade < ${GI_CASCADES}u; cascade++) {
    here = giCascadeIrradiance(cascade, point, normal, toViewer);
    if (here.a > 0.0) { break; }
  }
  return vec4f(here.rgb, here.a * share);
}
`;

/** The light leaving what a ray met. Needs raySceneWgsl, giSharedWgsl, GI_DIRECT_WGSL and PROBE_SAMPLE_WGSL. */
const SHADE_WGSL = /* wgsl */ `
// probeNoise scatters what it reads between cascades: rays gathered by a probe average that out, and a reflection,
// which has only the one, passes a steady value instead.
fn giShade(point: vec3f, direction: vec3f, hit: RtHit, probeNoise: f32) -> vec3f {
  let material = rayMaterials[hit.material];
  if ((material.flags & RT_MATERIAL_UNLIT) != 0u) { return material.albedo + material.emissive; }
  let normal = select(-hit.normal, hit.normal, hit.front);
  var received = giDirectional(point, normal) + giLocal(point, normal);
  let bounce = giShared.settings.y;
  if (bounce > 0.0) {
    let gathered = giIrradiance(point, normal, -direction, probeNoise);
    // Out of range of every probe, the open sky is the best guess there is.
    let fill = giSky(normal) * GI_PI * (1.0 - gathered.a);
    received += (gathered.rgb * gathered.a + fill) * bounce;
  }
  return material.emissive + material.albedo * received * GI_RECIPROCAL_PI;
}
`;

const PROBE_CODES_WGSL = /* wgsl */ `
struct GiProbe { position: vec3f, code: u32, turn: vec4f }
struct GatherParams { rayCount: u32, probeCount: u32, pad0: u32, pad1: u32, blend: vec4f, spacing: vec4f }

fn giPlaceOfCode(code: u32) -> vec2u {
  let cascade = code / ${PROBES_PER_CASCADE}u;
  let cell = code % ${PROBES_PER_CASCADE}u;
  let x = cell % ${PROBES_X}u;
  let z = (cell / ${PROBES_X}u) % ${PROBES_Z}u;
  let y = cell / ${PROBES_X * PROBES_Z}u;
  return vec2u(x + ${PROBES_X}u * (y & 3u), z + ${PROBES_Z}u * (y >> 2u) + cascade * ${ATLAS_ROWS}u);
}
fn giOffsetTexel(code: u32) -> vec2u { return giPlaceOfCode(code) + vec2u(0u, ${ATLAS_OFFSET_Y}u); }
fn giIrradianceCorner(code: u32) -> vec2u { return giPlaceOfCode(code) * ${IRRADIANCE_CELL}u; }
fn giVisibilityCorner(code: u32) -> vec2u { return vec2u(${ATLAS_IRRADIANCE_WIDTH}u, 0u) + giPlaceOfCode(code) * ${VISIBILITY_CELL}u; }
`;

const PROBE_RAY_WGSL = /* wgsl */ `
struct ProbeRay { light: vec3f, along: f32, way: vec3f, pad: f32 }
`;

/** A ray takes two rows in the table: what it brought and how far, negative where a back was met, and which way it went. */
export const PROBE_RAY_BYTES = 32;
export const PROBE_BYTES = 32;

export const TRACE_RAYS_WORKGROUP: readonly [number, number] = [8, 4];

export const TRACE_WGSL = /* wgsl */ `
${giSharedWgsl(0)}
${raySceneWgsl(1)}
${GI_DIRECT_WGSL}
${PROBE_SAMPLE_WGSL}
${SHADE_WGSL}
${PROBE_CODES_WGSL}
${PROBE_RAY_WGSL}
@group(2) @binding(0) var<uniform> gather: GatherParams;
@group(2) @binding(1) var<storage, read> probes: array<GiProbe>;
@group(2) @binding(2) var<storage, read_write> rays: array<ProbeRay>;
@group(2) @binding(3) var<uniform> rayWays: array<vec4f, ${MAX_RAYS_PER_PROBE}>;

// Each probe turns the shared set of ray directions its own way. Turned alike, every probe's noise would rise and fall
// together and the whole room would pulse; turned apart, the eight around a surface average it away.
fn giTurn(turn: vec4f, direction: vec3f) -> vec3f {
  return direction + 2.0 * cross(turn.xyz, cross(turn.xyz, direction) + turn.w * direction);
}

@compute @workgroup_size(${TRACE_RAYS_WORKGROUP[0]}, ${TRACE_RAYS_WORKGROUP[1]})
fn traceProbeRays(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= gather.rayCount || id.y >= gather.probeCount) { return; }
  giRng = id.x * 1973u + id.y * 9277u + giShared.counts.w * 26699u + 1u;
  let code = probes[id.y].code;
  let origin = probes[id.y].position + textureLoad(giAtlas, giOffsetTexel(code), 0).xyz;
  let direction = giTurn(probes[id.y].turn, rayWays[id.x].xyz);
  var hit: RtHit;
  var light = vec3f(0.0);
  var along = 1e4;
  if (rtTrace(origin, direction, 1e5, false, &hit)) {
    let twoSided = (rayMaterials[hit.material].flags & RT_MATERIAL_TWO_SIDED) != 0u;
    if (hit.front || twoSided) {
      light = giShade(origin + direction * hit.distance, direction, hit, giRandom());
    }
    // A back means the probe may be inside something. For a two-sided material only when it is close: most boxes that
    // come from modelling tools are two-sided, and a probe buried in one must find out, but the walls of a room can
    // be two-sided planes facing away from it, and that room has nothing wrong with it.
    let nearby = giShared.grids[code / ${PROBES_PER_CASCADE}u].w * 0.5;
    let inside = !hit.front && (!twoSided || hit.distance < nearby);
    along = select(hit.distance, -hit.distance, inside);
  } else {
    light = giSky(direction);
  }
  rays[id.y * gather.rayCount + id.x] = ProbeRay(min(light, vec3f(64.0)), along, direction, 0.0);
}
`;

export const INTEGRATE_WGSL = /* wgsl */ `
${FOLD_WGSL}
${PROBE_CODES_WGSL}
${PROBE_RAY_WGSL}
const PI = 3.141592653589793;
@group(0) @binding(0) var<uniform> gather: GatherParams;
@group(0) @binding(1) var<storage, read> probes: array<GiProbe>;
@group(0) @binding(2) var<storage, read> rays: array<ProbeRay>;
@group(0) @binding(3) var atlas: texture_2d<f32>;
@group(0) @binding(4) var<storage, read_write> scratch: array<vec4f>;

// The rays of one probe summed for each direction a surface may face: x, y the texel of its cell, z which probe.
@compute @workgroup_size(${IRRADIANCE_CELL}, ${IRRADIANCE_CELL})
fn integrateIrradiance(@builtin(global_invocation_id) id: vec3u) {
  let probe = id.z;
  if (probe >= gather.probeCount) { return; }
  let code = probes[probe].code;
  // A texel of the rim takes the value of the edge it stands by, so filtering at the edge stays with this probe.
  let folded = clamp((vec2f(id.xy) - 0.5) / ${IRRADIANCE_TEXELS.toFixed(1)}, vec2f(0.0), vec2f(1.0)) * 2.0 - 1.0;
  let facing = giUnfold(folded);
  var sum = vec3f(0.0);
  var total = 0.0;
  var backs = 0u;
  let first = probe * gather.rayCount;
  for (var r = 0u; r < gather.rayCount; r++) {
    let ray = rays[first + r];
    let weight = max(dot(facing, ray.way), 0.0);
    total += weight;
    if (ray.along < 0.0) { backs++; }
    sum += ray.light * weight;
  }
  let irradiance = PI * sum / max(total, 1e-4);
  let before = textureLoad(atlas, giIrradianceCorner(code) + id.xy, 0);
  var result = irradiance;
  // What it held while buried, or before it was first traced, is nothing to ease from.
  if (before.a > 0.0) {
    // Eased most of the way, so noise stays out of it, except for a change too large for noise to explain, which it
    // follows quickly. One probe's rays can easily be a third out on their own.
    let blend = gather.blend[code / ${PROBES_PER_CASCADE}u];
    let largest = max(max(before.r, before.g), max(before.b, 0.05));
    let difference = abs(irradiance - before.rgb) / largest;
    let change = smoothstep(0.3, 0.9, max(max(difference.r, difference.g), difference.b));
    result = mix(before.rgb, irradiance, mix(blend * 0.35, blend, change));
  }
  // More than a quarter of its rays met backs: it stands inside something.
  let sound = select(1.0, 0.0, backs * 4u > gather.rayCount);
  scratch[probe * ${SCRATCH_STRIDE}u + id.y * ${IRRADIANCE_CELL}u + id.x] = vec4f(result, sound);
}

// The distances one probe saw, for each direction, and their squares: how surfaces tell whether it can see them.
@compute @workgroup_size(8, 8)
fn integrateVisibility(@builtin(global_invocation_id) id: vec3u) {
  let probe = id.z;
  if (probe >= gather.probeCount) { return; }
  let code = probes[probe].code;
  let folded = clamp((vec2f(id.xy) - 0.5) / ${VISIBILITY_TEXELS.toFixed(1)}, vec2f(0.0), vec2f(1.0)) * 2.0 - 1.0;
  let facing = giUnfold(folded);
  // Short of where its square would overflow what a half-float holds.
  let limit = min(gather.spacing[code / ${PROBES_PER_CASCADE}u] * 2.5, 250.0);
  var sum = vec2f(0.0);
  var total = 0.0;
  let first = probe * gather.rayCount;
  for (var r = 0u; r < gather.rayCount; r++) {
    let ray = rays[first + r];
    // Narrow, and each frame's rays turned: a wide lobe would let a probe just over a thin roof, seeing out to the
    // horizon nearby, count everything under the roof as in sight.
    let weight = pow(max(dot(facing, ray.way), 0.0), ${VISIBILITY_SHARPNESS.toFixed(1)});
    // A back is met nearer than it looks, so nothing beyond it is taken to be in sight.
    let reach = min(select(ray.along, -ray.along * 0.5, ray.along < 0.0), limit);
    sum += vec2f(reach, reach * reach) * weight;
    total += weight;
  }
  var moments = sum / max(total, 1e-4);
  if (total <= 1e-4) { moments = vec2f(limit, limit * limit); }
  let before = textureLoad(atlas, giVisibilityCorner(code) + id.xy, 0);
  // Nothing to ease from in a texel never written, or for a probe that was buried, and saw this from somewhere else.
  let sound = before.g > 0.0 && textureLoad(atlas, giIrradianceCorner(code) + vec2u(1u), 0).a > 0.0;
  // Each frame's rays count by how many landed in this texel's lobe. With few rays often none land near it, and the
  // nearest, far off to one side, would otherwise speak for it in full: for a probe just over a thin roof that might be
  // a ray out to the horizon, and everything under the roof would seem to be in sight.
  let expected = f32(gather.rayCount) / ${(2 * (VISIBILITY_SHARPNESS + 1)).toFixed(1)};
  let share = min(total / expected, 1.0);
  let value = select(moments, mix(before.rg, moments, 0.2 * share), sound);
  scratch[probe * ${SCRATCH_STRIDE}u + ${IRRADIANCE_CELL * IRRADIANCE_CELL}u + id.y * ${VISIBILITY_CELL}u + id.x] = vec4f(value, 0.0, 1.0);
}

// A probe moving out of the way of geometry. More than a quarter of its rays met backs: it is inside something, and goes
// through the nearest. Nearly touching a surface: it eases back, as what it sees from there would be mostly that
// surface. With nothing near, it drifts home, so a probe does not stay moved after what moved it has gone.
@compute @workgroup_size(16)
fn integrateOffset(@builtin(global_invocation_id) id: vec3u) {
  let probe = id.x;
  if (probe >= gather.probeCount) { return; }
  let code = probes[probe].code;
  let spacing = gather.spacing[code / ${PROBES_PER_CASCADE}u];
  var offset = textureLoad(atlas, giOffsetTexel(code), 0).xyz;
  var nearestBack = 1e9;
  var nearestFront = 1e9;
  var backWay = vec3f(0.0);
  var frontWay = vec3f(0.0);
  var backs = 0u;
  let first = probe * gather.rayCount;
  for (var r = 0u; r < gather.rayCount; r++) {
    let along = rays[first + r].along;
    let way = rays[first + r].way;
    if (along < 0.0) {
      backs++;
      if (-along < nearestBack) {
        nearestBack = -along;
        backWay = way;
      }
    } else if (along < nearestFront) {
      nearestFront = along;
      frontWay = way;
    }
  }
  let margin = spacing * ${PROBE_MARGIN.toFixed(2)};
  if (backs * 4u > gather.rayCount) {
    offset += backWay * (nearestBack + margin);
  } else if (nearestFront < margin) {
    offset -= frontWay * (margin - nearestFront);
  } else if (nearestFront > spacing) {
    offset *= 0.8;
  }
  let limit = spacing * ${PROBE_MOVE_LIMIT.toFixed(2)};
  let moved = length(offset);
  if (moved > limit) { offset *= limit / moved; }
  scratch[probe * ${SCRATCH_STRIDE}u + ${SCRATCH_STRIDE - 1}u] = vec4f(offset, 1.0);
}
`;

/** What the scratch buffer holds, moved into the atlas: x, y a texel of the largest cell, z which probe. */
export const STORE_WGSL = /* wgsl */ `
${PROBE_CODES_WGSL}
@group(0) @binding(0) var<uniform> gather: GatherParams;
@group(0) @binding(1) var<storage, read> probes: array<GiProbe>;
@group(0) @binding(2) var<storage, read> scratch: array<vec4f>;
@group(0) @binding(3) var atlas: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(${VISIBILITY_CELL}, ${VISIBILITY_CELL})
fn storeProbes(@builtin(global_invocation_id) id: vec3u) {
  let probe = id.z;
  if (probe >= gather.probeCount) { return; }
  let code = probes[probe].code;
  let first = probe * ${SCRATCH_STRIDE}u;
  textureStore(atlas, giVisibilityCorner(code) + id.xy, scratch[first + ${IRRADIANCE_CELL * IRRADIANCE_CELL}u + id.y * ${VISIBILITY_CELL}u + id.x]);
  if (all(id.xy < vec2u(${IRRADIANCE_CELL}u))) {
    textureStore(atlas, giIrradianceCorner(code) + id.xy, scratch[first + id.y * ${IRRADIANCE_CELL}u + id.x]);
  }
  if (all(id.xy == vec2u(0u))) {
    textureStore(atlas, giOffsetTexel(code), scratch[first + ${SCRATCH_STRIDE - 1}u]);
  }
}
`;

/** Cells whose probes just came into range: what they hold is what the probes that left them saw. */
export const CLEAR_WGSL = /* wgsl */ `
${PROBE_CODES_WGSL}
struct ClearParams { count: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<uniform> clearing: ClearParams;
@group(0) @binding(1) var<storage, read> codes: array<u32>;
@group(0) @binding(2) var atlas: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(${VISIBILITY_CELL}, ${VISIBILITY_CELL})
fn clearProbes(@builtin(global_invocation_id) id: vec3u) {
  if (id.z >= clearing.count) { return; }
  let code = codes[id.z];
  let nothing = vec4f(0.0, 0.0, 0.0, -1.0);
  textureStore(atlas, giVisibilityCorner(code) + id.xy, nothing);
  if (all(id.xy < vec2u(${IRRADIANCE_CELL}u))) {
    textureStore(atlas, giIrradianceCorner(code) + id.xy, nothing);
  }
  if (all(id.xy == vec2u(0u))) {
    textureStore(atlas, giOffsetTexel(code), nothing);
  }
}
`;

const DECODE_NORMAL_WGSL = /* wgsl */ `
fn decodeOctahedral(e: vec2f) -> vec3f {
  var n = vec3f(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  if (n.z < 0.0) {
    n = vec3f((vec2f(1.0) - abs(n.yx)) * select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0)), n.z);
  }
  return normalize(n);
}

fn worldOfPixel(uv: vec2f, depth: f32) -> vec3f {
  let reached = view.inverseViewProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  return reached.xyz / reached.w;
}
`;

/**
 * Light reaching each pixel, for the lighting pass, which takes it in place of the ambient lights everywhere: so rgb is
 * always the whole of the indirect light. Gathered light comes first; where it has nothing yet or does not reach, a bake
 * still stands; where neither does, the open sky. In a is how much of it is more than the open sky.
 */
export const GI_SCREEN_WGSL = /* wgsl */ `
${VIEW_WGSL}
${CAMERA_BINDINGS_WGSL}
${giSharedWgsl(1)}
${PROBE_SAMPLE_WGSL}
${DECODE_NORMAL_WGSL}
${lightVolumeWgsl(2, 4)}
@group(2) @binding(0) var surfaceDepth: texture_depth_2d;
@group(2) @binding(1) var surfaceNormal: texture_2d<f32>;
@group(2) @binding(2) var surfaceEmissive: texture_2d<f32>;
@group(2) @binding(3) var giOut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn giScreen(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(surfaceDepth);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let at = vec2i(id.xy);
  let depth = textureLoad(surfaceDepth, at, 0);
  // Nothing drawn here, or something that takes no light.
  if (depth <= 0.0 || textureLoad(surfaceEmissive, at, 0).a > 0.75) {
    textureStore(giOut, at, vec4f(0.0));
    return;
  }
  let packed = textureLoad(surfaceNormal, at, 0);
  let normal = decodeOctahedral(packed.xy);
  let point = worldOfPixel((vec2f(id.xy) + 0.5) / vec2f(size), depth);
  let noise = fract(52.9829189 * fract(dot(vec2f(id.xy) + giShared.settings.w * 5.588238, vec2f(0.06711056, 0.00583715))));
  let gathered = giIrradiance(point, normal, normalize(view.eye.xyz - point), noise);
  let bakedBlend = lightVolumeWeight(point);
  var baked = vec3f(0.0);
  if (bakedBlend > 0.0) { baked = lightVolumeIrradiance(point, normal); }
  let bakedShare = bakedBlend * (1.0 - gathered.a);
  let together = gathered.a + bakedShare;
  let open = giOpenIrradiance(normal) * (1.0 - together);
  textureStore(giOut, at, vec4f(gathered.rgb * giShared.settings.x * gathered.a + baked * bakedShare + open, together));
}
`;

/** Half-size: each glossy pixel follows the same scattered mirror ray as the screen's reflections, on past the screen. */
export const REFLECTION_RAYS_WGSL = /* wgsl */ `
${VIEW_WGSL}
${CAMERA_BINDINGS_WGSL}
${giSharedWgsl(1)}
${raySceneWgsl(2)}
${GI_DIRECT_WGSL}
${PROBE_SAMPLE_WGSL}
${SHADE_WGSL}
${DECODE_NORMAL_WGSL}
@group(3) @binding(0) var surfaceDepth: texture_depth_2d;
@group(3) @binding(1) var surfaceNormal: texture_2d<f32>;
@group(3) @binding(2) var screenReflections: texture_2d<f32>;
@group(3) @binding(3) var reflectionOut: texture_storage_2d<rgba16float, write>;

fn noiseAt(pixel: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(pixel, vec2f(0.06711056, 0.00583715))));
}

@compute @workgroup_size(8, 8)
fn traceReflections(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(reflectionOut);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(dims);
  let size = textureDimensions(surfaceDepth);
  let pixel = min(vec2u(uv * vec2f(size)), size - vec2u(1u));
  let depth = textureLoad(surfaceDepth, pixel, 0);
  let surface = textureLoad(surfaceNormal, pixel, 0);
  let roughness = surface.z;
  let cover = 1.0 - smoothstep(${ROUGH_LOW}, ${ROUGH_HIGH}, roughness);
  let screenSize = textureDimensions(screenReflections);
  // How far the screen's own reflection can be trusted here: where it can, it is the better of the two.
  let trusted = textureLoad(screenReflections, min(vec2u(uv * vec2f(screenSize)), screenSize - vec2u(1u)), 0).a;
  // Open sky, too rough to be the rays' business, or the screen knows already.
  if (depth <= 0.0 || cover <= 0.0 || trusted >= 0.99) {
    textureStore(reflectionOut, id.xy, vec4f(0.0));
    return;
  }
  let world = worldOfPixel(uv, depth);
  let normal = decodeOctahedral(surface.xy);
  // The noise holds still, so that the pattern on a rough surface does not crawl.
  let n0 = noiseAt(vec2f(id.xy));
  let n1 = noiseAt(vec2f(id.xy) * 1.37 + 17.0);
  let scatter = vec3f(n0 - 0.5, n1 - 0.5, fract(n0 + n1) - 0.5) * roughness * roughness * 0.8;
  let direction = reflect(normalize(world - view.eye.xyz), normalize(normal + scatter));
  if (dot(direction, normal) <= 0.0) {
    textureStore(reflectionOut, id.xy, vec4f(0.0));
    return;
  }
  giRng = id.x * 1973u + id.y * 9277u + 1u;
  let origin = world + normal * (0.01 + length(world - view.eye.xyz) * 0.004);
  var hit: RtHit;
  var light = vec3f(0.0);
  if (rtTrace(origin, direction, 1e5, false, &hit)) {
    if (hit.front || (rayMaterials[hit.material].flags & RT_MATERIAL_TWO_SIDED) != 0u) {
      light = giShade(origin + direction * hit.distance, direction, hit, 0.5);
    }
  } else if (giShared.has.y != 0u) {
    // The environment as a mirror shows it: the fill only where there is no map to show.
    light = giEnvironmentRadiance(direction, roughness);
  } else {
    light = giFillRadiance(direction);
  }
  // Only what the screen leaves: alpha says how much of the environment this takes the place of.
  textureStore(reflectionOut, id.xy, vec4f(min(light, vec3f(8.0)), cover * (1.0 - trusted)));
}
`;

/** Softens reflections on rougher surfaces, keeping to the surface they fall on: half-size to half-size. */
export const REFLECTION_SMOOTH_WGSL = /* wgsl */ `
@group(0) @binding(0) var surfaceDepth: texture_depth_2d;
@group(0) @binding(1) var surfaceNormal: texture_2d<f32>;
@group(0) @binding(2) var source: texture_2d<f32>;
@group(0) @binding(3) var smoothed: texture_storage_2d<rgba16float, write>;

fn pixelFor(at: vec2i, dims: vec2i, size: vec2i) -> vec2i {
  return min((2i * at + vec2i(1)) * size / (2i * dims), size - vec2i(1));
}

@compute @workgroup_size(8, 8)
fn smoothReflections(@builtin(global_invocation_id) id: vec3u) {
  let dims = vec2i(textureDimensions(source));
  if (i32(id.x) >= dims.x || i32(id.y) >= dims.y) { return; }
  let size = vec2i(textureDimensions(surfaceDepth));
  let at = vec2i(id.xy);
  let pixel = pixelFor(at, dims, size);
  let depth = textureLoad(surfaceDepth, pixel, 0);
  if (depth <= 0.0) {
    textureStore(smoothed, at, vec4f(0.0));
    return;
  }
  let surface = textureLoad(surfaceNormal, pixel, 0);
  let spread = 1.0 + surface.z * 6.0;
  var sum = vec4f(0.0);
  var total = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let there = clamp(at + vec2i(floor(vec2f(f32(x), f32(y)) * spread + 0.5)), vec2i(0), dims - vec2i(1));
      var weight = select(1.0, 2.0, x == 0) * select(1.0, 2.0, y == 0);
      // Depth runs as one over distance: a relative change in it is the same relative change in distance.
      let other = textureLoad(surfaceDepth, pixelFor(there, dims, size), 0);
      weight *= exp(-abs(other - depth) / (depth * 0.03));
      let s = textureLoad(source, there, 0);
      sum += vec4f(s.rgb * s.a, s.a) * weight;
      total += weight;
    }
  }
  if (sum.a <= 0.0) {
    textureStore(smoothed, at, vec4f(0.0));
    return;
  }
  textureStore(smoothed, at, vec4f(sum.rgb / sum.a, sum.a / max(total, 1e-4)));
}
`;

/**
 * Puts what rays and probes know on the lit picture. The lighting pass added the environment's reflection in full, as if
 * nothing stood in its way. This adds the change: toward what the rays saw where they reach, and elsewhere down to as
 * much of the environment as this place sees, so that in a dark room a polished floor shows no sky.
 */
export const REFLECTION_COMPOSE_WGSL = /* wgsl */ `
${VIEW_WGSL}
${CAMERA_BINDINGS_WGSL}
${LIGHTING_WGSL}
${FULLSCREEN_WGSL}
${DECODE_NORMAL_WGSL}
struct ComposeParams { rays: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(2) @binding(0) var surfaceDepth: texture_depth_2d;
@group(2) @binding(1) var surfaceAlbedo: texture_2d<f32>;
@group(2) @binding(2) var surfaceNormal: texture_2d<f32>;
@group(2) @binding(3) var surfaceEmissive: texture_2d<f32>;
@group(2) @binding(4) var reflections: texture_2d<f32>;
@group(2) @binding(5) var gathered: texture_2d<f32>;
@group(2) @binding(6) var occlusion: texture_2d<f32>;
@group(2) @binding(7) var<uniform> compose: ComposeParams;

// Half-size reflections at a full-size pixel, from the four nearest samples on the same surface.
fn reflectionAt(uv: vec2f, depth: f32, size: vec2i) -> vec4f {
  let half = vec2i(textureDimensions(reflections));
  let place = uv * vec2f(half) - 0.5;
  let base = floor(place);
  let f = place - base;
  var sum = vec4f(0.0);
  var total = 0.0;
  for (var i = 0; i < 4; i++) {
    let corner = vec2i(i % 2, i / 2);
    let at = clamp(vec2i(base) + corner, vec2i(0), half - vec2i(1));
    var weight = select(1.0 - f.x, f.x, corner.x == 1) * select(1.0 - f.y, f.y, corner.y == 1) + 1e-3;
    let pixel = min((2i * at + vec2i(1)) * size / (2i * half), size - vec2i(1));
    weight *= exp(-abs(textureLoad(surfaceDepth, pixel, 0) - depth) / (depth * 0.05));
    sum += textureLoad(reflections, at, 0) * weight;
    total += weight;
  }
  return sum / max(total, 1e-4);
}

fn occlusionAt(uv: vec2f) -> f32 {
  let size = vec2f(textureDimensions(occlusion));
  return textureLoad(occlusion, vec2i(min(uv * size, size - vec2f(1.0))), 0).r;
}

@fragment
fn composeReflections(in: FullscreenOut) -> @location(0) vec4f {
  let at = vec2i(in.position.xy);
  let size = vec2i(textureDimensions(surfaceDepth));
  let depth = textureLoad(surfaceDepth, at, 0);
  if (depth <= 0.0) { discard; }
  let emissive = textureLoad(surfaceEmissive, at, 0);
  if (emissive.a > 0.75) { discard; }
  let uv = (vec2f(at) + 0.5) / vec2f(size);
  let world = worldOfPixel(uv, depth);
  let surface = textureLoad(surfaceNormal, at, 0);
  let albedo = textureLoad(surfaceAlbedo, at, 0);
  let n = decodeOctahedral(surface.xy);
  let toEye = select(
    normalize(view.eye.xyz - world),
    vec3f(view.viewMatrix[0][2], view.viewMatrix[1][2], view.viewMatrix[2][2]),
    view.orthographic != 0u,
  );
  // Exactly the sums of the lighting pass, so that exactly what it added can be taken back.
  let roughness = clamp(surface.z, 0.0525, 1.0);
  let dotNV = saturate(dot(n, toEye));
  let f0 = mix(vec3f(0.04), albedo.rgb, surface.w);
  let fab = lightingDFG(dotNV, roughness);
  let single = f0 * fab.x + vec3f(fab.y);
  var environment = vec3f(0.0);
  var openness = 0.0;
  if (lighting.environmentMips > 0.0) {
    let reflected = normalize(mix(reflect(-toEye, n), n, roughness * roughness));
    let level = roughness * (lighting.environmentMips - 1.0);
    environment = textureSampleLevel(lightingEnvironment, lightingEnvironmentSampler, reflected, level).rgb * lighting.environmentIntensity;
    openness = dot(lightingIrradianceSH(n) * lighting.environmentIntensity, vec3f(0.2126, 0.7152, 0.0722));
  }
  var wanted = environment;
  // A surface with baked light took none of the gathered light, and goes by its own.
  if (emissive.a <= 0.25) {
    let reached = textureLoad(gathered, at, 0);
    let seen = saturate(dot(reached.rgb, vec3f(0.2126, 0.7152, 0.0722)) / max(openness, 1e-3));
    wanted *= mix(1.0, seen, reached.a);
  }
  if (compose.rays != 0u) {
    let traced = reflectionAt(uv, depth, size);
    wanted = mix(wanted, traced.rgb, saturate(traced.a));
  }
  let open = lightingSpecularOcclusion(dotNV, albedo.a * occlusionAt(uv), roughness);
  // Fog fell on what the lighting pass wrote, and falls on the change the same way.
  let throughFog = lightingApplyFog(vec3f(1.0), world) - lightingApplyFog(vec3f(0.0), world);
  return vec4f((wanted - environment) * single * open * throughFog, 0.0);
}
`;

/** The scene as rays see it, from the camera: to check rays against what is drawn. Writes the lit picture. */
export const RAY_VIEW_WGSL = /* wgsl */ `
${VIEW_WGSL}
${CAMERA_BINDINGS_WGSL}
${giSharedWgsl(1)}
${raySceneWgsl(2)}
${GI_DIRECT_WGSL}
${PROBE_SAMPLE_WGSL}
${SHADE_WGSL}
@group(3) @binding(0) var hdrOut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn traceView(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(hdrOut);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(dims);
  giRng = id.x * 1973u + id.y * 9277u + giShared.counts.w * 26699u + 1u;
  let reached = view.inverseViewProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.5, 1.0);
  let direction = normalize(reached.xyz / reached.w - view.eye.xyz);
  var hit: RtHit;
  var light: vec3f;
  if (rtTrace(view.eye.xyz, direction, 1e5, false, &hit)) {
    light = giShade(view.eye.xyz + direction * hit.distance, direction, hit, 0.5);
  } else {
    light = giSky(direction);
  }
  textureStore(hdrOut, id.xy, vec4f(light, 1.0));
}
`;

/** Only the indirect light, on white. */
export const LIGHTING_VIEW_WGSL = /* wgsl */ `
@group(0) @binding(0) var surfaceDepth: texture_depth_2d;
@group(0) @binding(1) var gathered: texture_2d<f32>;
@group(0) @binding(2) var hdrOut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn showLighting(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(hdrOut);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  if (textureLoad(surfaceDepth, id.xy, 0) <= 0.0) { return; }
  textureStore(hdrOut, id.xy, vec4f(textureLoad(gathered, id.xy, 0).rgb * 0.3183098861837907, 1.0));
}
`;

/** Each probe of the finest cascade as a small ball showing the light it holds, red where it stands inside something. */
export const PROBE_VIEW_WGSL = /* wgsl */ `
${VIEW_WGSL}
${CAMERA_BINDINGS_WGSL}
${giSharedWgsl(1)}
${FOLD_WGSL}
const BALL_SIDES = 10u;
const BALL_RINGS = 8u;
struct BallOut {
  @builtin(position) clip: vec4f,
  @location(0) normal: vec3f,
  @location(1) @interpolate(flat) place: vec2i,
}

fn ballPoint(side: u32, ring: u32) -> vec3f {
  let around = f32(side) / f32(BALL_SIDES) * 6.2831853;
  let down = f32(ring) / f32(BALL_RINGS) * 3.14159265;
  return vec3f(cos(around) * sin(down), cos(down), sin(around) * sin(down));
}

@vertex
fn ballVertex(@builtin(vertex_index) vertex: u32, @builtin(instance_index) probe: u32) -> BallOut {
  let quad = vertex / 6u;
  let side = quad % BALL_SIDES;
  let ring = quad / BALL_SIDES;
  var corners = array<vec2u, 6>(vec2u(0u, 0u), vec2u(0u, 1u), vec2u(1u, 1u), vec2u(0u, 0u), vec2u(1u, 1u), vec2u(1u, 0u));
  let corner = corners[vertex % 6u];
  let normal = ballPoint(side + corner.x, ring + corner.y);
  let index = vec3i(i32(probe % ${PROBES_X}u), i32(probe / ${PROBES_X * PROBES_Z}u), i32((probe / ${PROBES_X}u) % ${PROBES_Z}u));
  let grid = giShared.grids[0];
  let cell = (vec3i(floor(grid.xyz / grid.w - vec3f(0.0, ${GRID_LIFT}, 0.0) + 0.5)) + index) & vec3i(${PROBES_X - 1}, ${PROBES_Y - 1}, ${PROBES_Z - 1});
  let place = vec2i(cell.x + ${PROBES_X} * (cell.y & 3), cell.z + ${PROBES_Z} * (cell.y >> 2u));
  let world = grid.xyz + vec3f(index) * grid.w + textureLoad(giAtlas, place + vec2i(0, ${ATLAS_OFFSET_Y}), 0).xyz;
  var out: BallOut;
  out.clip = view.viewProjection * vec4f(world + normal * grid.w * 0.12, 1.0);
  out.normal = normal;
  out.place = place;
  return out;
}

@fragment
fn ballFragment(in: BallOut) -> @location(0) vec4f {
  let at = vec2f(in.place) * ${IRRADIANCE_CELL.toFixed(1)} + 1.0 + (giFold(normalize(in.normal)) * 0.5 + 0.5) * ${IRRADIANCE_TEXELS.toFixed(1)};
  let held = textureSampleLevel(giAtlas, giLinear, at / vec2f(${ATLAS_WIDTH.toFixed(1)}, ${ATLAS_HEIGHT.toFixed(1)}), 0.0);
  if (held.a < 0.0) { discard; }
  return select(vec4f(0.6, 0.05, 0.05, 1.0), vec4f(held.rgb * 0.318, 1.0), held.a > 0.5);
}
`;

/** Vertices one ball takes in the probe view. */
export const BALL_VERTICES = 10 * 8 * 6;
