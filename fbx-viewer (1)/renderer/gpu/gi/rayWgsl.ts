/**
 * RAYS IN COMPUTE
 *
 * The ray scene's tables as WGSL, and the walk through them: `rtTrace` follows a ray through the tree of instances and
 * down into the mesh tree of each one it may hit, in that mesh's own space, so a scaled or turned object costs what any
 * other does. No ray tracing hardware is asked for. Also here: the shaders that bring the trees up to date, posed
 * triangles first, then each tree from its deepest level to its root, one dispatch a level.
 *
 * A node is a box and two words: `link` is the left child of an interior node, the first triangle of a mesh leaf and
 * the instance of a scene leaf; `count` is 0 for an interior node, what a leaf holds, or below 0 for a leaf with nothing.
 */

/** Pending nodes at most: a tree of a million triangles is not 32 deep on either level, and the walk has both. */
const STACK_SIZE = 64;
/** Nodes a ray may visit before it gives up and counts as having missed: only a bound, far above what a ray needs. */
const MAX_STEPS = 4096;

/** A material drawn without lighting: what it shows is what it gives off. Same numbers as the WebGL tables. */
export const RT_MATERIAL_UNLIT = 1;
export const RT_MATERIAL_TWO_SIDED = 2;
/** Rays meeting it from behind pass through: a character, which probes may stand inside. */
export const RT_INSTANCE_ONE_WAY = 1;
/** Casts no shadow when drawn, and blocks no shadow ray. */
export const RT_INSTANCE_NO_SHADOW = 2;
/** A box standing in for a character: fine for bounced light, wrong in a mirror. */
export const RT_INSTANCE_BOX = 4;

export const RAY_TRIANGLE_WORDS = 12;
export const RAY_NODE_WORDS = 8;
export const RAY_INSTANCE_WORDS = 28;
export const RAY_MATERIAL_WORDS = 8;
/** One posed triangle: where it goes in the triangle table, then its three vertices' places in the vertex table. */
export const POSED_TRIANGLE_WORDS = 4;

export const RAY_STRUCTS_WGSL = /* wgsl */ `
struct RayTriangle { corner: vec3f, slot: u32, edge1: vec3f, pad0: f32, edge2: vec3f, pad1: f32 }
struct RayNode { low: vec3f, link: u32, high: vec3f, count: i32 }
struct RayInstance {
  toLocal0: vec4f, toLocal1: vec4f, toLocal2: vec4f,
  world0: vec4f, world1: vec4f, world2: vec4f,
  root: u32, firstMaterial: u32, flags: u32, pad: u32,
}
struct RayMaterial { albedo: vec3f, flags: u32, emissive: vec3f, pad: f32 }
`;

export const raySceneWgsl = (group: number): string => /* wgsl */ `
${RAY_STRUCTS_WGSL}
@group(${group}) @binding(0) var<storage, read> rayTriangles: array<RayTriangle>;
@group(${group}) @binding(1) var<storage, read> rayMeshNodes: array<RayNode>;
@group(${group}) @binding(2) var<storage, read> raySceneNodes: array<RayNode>;
@group(${group}) @binding(3) var<storage, read> rayInstances: array<RayInstance>;
@group(${group}) @binding(4) var<storage, read> rayMaterials: array<RayMaterial>;

const RT_MATERIAL_UNLIT = ${RT_MATERIAL_UNLIT}u;
const RT_MATERIAL_TWO_SIDED = ${RT_MATERIAL_TWO_SIDED}u;
const RT_INSTANCE_ONE_WAY = ${RT_INSTANCE_ONE_WAY}u;
const RT_INSTANCE_NO_SHADOW = ${RT_INSTANCE_NO_SHADOW}u;
const RT_INSTANCE_BOX = ${RT_INSTANCE_BOX}u;
// Set where what rays meet is looked at directly: a character's box must not show in a mirror.
override RT_SKIP_BOXES: bool = false;

struct RtHit {
  distance: f32,
  normal: vec3f,
  material: u32,
  front: bool,
}

fn rtInvert(direction: vec3f) -> vec3f {
  // A direction along an axis would divide by zero: leaning it by a hair loses nothing.
  return 1.0 / (direction + select(vec3f(0.0), vec3f(1e-9), direction == vec3f(0.0)));
}

fn rtEnter(low: vec3f, high: vec3f, origin: vec3f, inverted: vec3f, limit: f32) -> f32 {
  let a = (low - origin) * inverted;
  let b = (high - origin) * inverted;
  let near = min(a, b);
  let far = max(a, b);
  let enter = max(max(near.x, near.y), max(near.z, 0.0));
  let leave = min(min(far.x, far.y), min(far.z, limit));
  return select(-1.0, enter, enter <= leave);
}

// Follows a ray up to limit. With anyHit it stops at the first thing met, which is all a shadow ray asks.
fn rtTrace(worldOrigin: vec3f, worldDirection: vec3f, limit: f32, anyHit: bool, hit: ptr<function, RtHit>) -> bool {
  (*hit).distance = limit;
  (*hit).normal = vec3f(0.0, 1.0, 0.0);
  (*hit).material = 0u;
  (*hit).front = true;
  var closest = limit;
  var stack: array<i32, ${STACK_SIZE}>;
  var top = 0u;
  var node = 0i;
  var instance = -1i;
  var hitTriangle = -1i;
  var hitInstance = -1i;
  var hitMaterial = 0u;
  var firstMaterial = 0u;
  var oneWay = false;
  var origin = worldOrigin;
  var direction = worldDirection;
  var inverted = rtInvert(direction);
  for (var visits = 0u; visits < ${MAX_STEPS}u; visits++) {
    var current: RayNode;
    if (instance < 0i) {
      current = raySceneNodes[u32(node)];
    } else {
      current = rayMeshNodes[u32(node)];
    }
    var descend = false;
    if (current.count == 0i) {
      // Both children: the nearer next, the other for later.
      let left = current.link;
      let right = left + 1u;
      var toLeft: f32;
      var toRight: f32;
      if (instance < 0i) {
        toLeft = rtEnter(raySceneNodes[left].low, raySceneNodes[left].high, origin, inverted, closest);
        toRight = rtEnter(raySceneNodes[right].low, raySceneNodes[right].high, origin, inverted, closest);
      } else {
        toLeft = rtEnter(rayMeshNodes[left].low, rayMeshNodes[left].high, origin, inverted, closest);
        toRight = rtEnter(rayMeshNodes[right].low, rayMeshNodes[right].high, origin, inverted, closest);
      }
      if (toLeft >= 0.0 && toRight >= 0.0) {
        let leftFirst = toLeft <= toRight;
        if (top < ${STACK_SIZE}u) {
          stack[top] = i32(select(left, right, leftFirst));
          top++;
        }
        node = i32(select(right, left, leftFirst));
        descend = true;
      } else if (toLeft >= 0.0) {
        node = i32(left);
        descend = true;
      } else if (toRight >= 0.0) {
        node = i32(right);
        descend = true;
      }
    } else if (current.count > 0i) {
      if (instance < 0i) {
        let flags = rayInstances[current.link].flags;
        // What casts no shadow when drawn stops no shadow ray.
        var enter = !anyHit || (flags & RT_INSTANCE_NO_SHADOW) == 0u;
        if (RT_SKIP_BOXES && !anyHit && (flags & RT_INSTANCE_BOX) != 0u) { enter = false; }
        if (enter) {
          // Into an instance: the ray in its own space, not normalised, so its distances stay the world's.
          instance = i32(current.link);
          let row0 = rayInstances[current.link].toLocal0;
          let row1 = rayInstances[current.link].toLocal1;
          let row2 = rayInstances[current.link].toLocal2;
          let worldPoint = vec4f(worldOrigin, 1.0);
          let worldWay = vec4f(worldDirection, 0.0);
          origin = vec3f(dot(row0, worldPoint), dot(row1, worldPoint), dot(row2, worldPoint));
          direction = vec3f(dot(row0, worldWay), dot(row1, worldWay), dot(row2, worldWay));
          inverted = rtInvert(direction);
          firstMaterial = rayInstances[current.link].firstMaterial;
          oneWay = (flags & RT_INSTANCE_ONE_WAY) != 0u;
          node = i32(rayInstances[current.link].root);
          // Marks where the walk comes back out to the world.
          if (top < ${STACK_SIZE}u) {
            stack[top] = -1i;
            top++;
          }
          descend = true;
        }
      } else {
        let first = current.link;
        for (var index = first; index < first + u32(current.count); index++) {
          let edge1 = rayTriangles[index].edge1;
          let edge2 = rayTriangles[index].edge2;
          let p = cross(direction, edge2);
          let determinant = dot(edge1, p);
          if (determinant == 0.0 || (oneWay && determinant < 0.0)) { continue; }
          let f = 1.0 / determinant;
          let s = origin - rayTriangles[index].corner;
          let u = f * dot(s, p);
          if (u < 0.0 || u > 1.0) { continue; }
          let q = cross(s, edge1);
          let v = f * dot(direction, q);
          if (v < 0.0 || u + v > 1.0) { continue; }
          let along = f * dot(edge2, q);
          if (along <= 1e-4 || along >= closest) { continue; }
          closest = along;
          if (anyHit) {
            (*hit).distance = along;
            return true;
          }
          hitTriangle = i32(index);
          hitInstance = instance;
          hitMaterial = firstMaterial + rayTriangles[index].slot;
        }
      }
    }
    if (descend) { continue; }
    // Back to the last thing set aside, coming out to the world first if that is where it was.
    if (top == 0u) { break; }
    top--;
    node = stack[top];
    if (node < 0i) {
      instance = -1i;
      origin = worldOrigin;
      direction = worldDirection;
      inverted = rtInvert(direction);
      if (top == 0u) { break; }
      top--;
      node = stack[top];
    }
  }
  if (hitTriangle < 0i) { return false; }
  let own = cross(rayTriangles[u32(hitTriangle)].edge1, rayTriangles[u32(hitTriangle)].edge2);
  let row0 = rayInstances[u32(hitInstance)].toLocal0.xyz;
  let row1 = rayInstances[u32(hitInstance)].toLocal1.xyz;
  let row2 = rayInstances[u32(hitInstance)].toLocal2.xyz;
  let normal = normalize(row0 * own.x + row1 * own.y + row2 * own.z);
  (*hit).distance = closest;
  (*hit).material = hitMaterial;
  (*hit).normal = normal;
  (*hit).front = dot(normal, worldDirection) < 0.0;
  return true;
}
`;

/** Writes each posed triangle from the vertex table, where skinning left it. Its material slot stays as it was. */
export const POSE_WGSL = /* wgsl */ `
${RAY_STRUCTS_WGSL}
struct PosedVertex { px: f32, py: f32, pz: f32, normal: u32, tangent: u32, u0: f32, v0: f32, u1: f32, v1: f32, color: u32 }
struct PosedTriangle { place: u32, a: u32, b: u32, c: u32 }
struct PoseRange { count: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<uniform> range: PoseRange;
@group(0) @binding(1) var<storage, read> posed: array<PosedTriangle>;
@group(0) @binding(2) var<storage, read> vertices: array<PosedVertex>;
@group(0) @binding(3) var<storage, read_write> triangles: array<RayTriangle>;

fn at(index: u32) -> vec3f {
  return vec3f(vertices[index].px, vertices[index].py, vertices[index].pz);
}

@compute @workgroup_size(64) fn poseTriangles(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= range.count) { return; }
  let one = posed[id.x];
  let corner = at(one.a);
  triangles[one.place].corner = corner;
  triangles[one.place].edge1 = at(one.b) - corner;
  triangles[one.place].edge2 = at(one.c) - corner;
}
`;

const REFIT_HEAD_WGSL = /* wgsl */ `
${RAY_STRUCTS_WGSL}
struct RefitRange { first: u32, count: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<uniform> range: RefitRange;
@group(0) @binding(1) var<storage, read> order: array<u32>;
@group(0) @binding(2) var<storage, read_write> nodes: array<RayNode>;
`;

/** One level of the mesh trees of posed meshes: a leaf from its triangles, an interior node from its children. */
export const REFIT_MESH_WGSL = /* wgsl */ `
${REFIT_HEAD_WGSL}
@group(0) @binding(3) var<storage, read> triangles: array<RayTriangle>;

@compute @workgroup_size(64) fn refitMesh(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= range.count) { return; }
  let node = order[range.first + id.x];
  let count = nodes[node].count;
  if (count < 0i) { return; }
  var low = vec3f(1e30);
  var high = vec3f(-1e30);
  let link = nodes[node].link;
  if (count > 0i) {
    for (var index = link; index < link + u32(count); index++) {
      let corner = triangles[index].corner;
      let b = corner + triangles[index].edge1;
      let c = corner + triangles[index].edge2;
      low = min(low, min(corner, min(b, c)));
      high = max(high, max(corner, max(b, c)));
    }
  } else {
    low = min(nodes[link].low, nodes[link + 1u].low);
    high = max(nodes[link].high, nodes[link + 1u].high);
  }
  nodes[node].low = low;
  nodes[node].high = high;
}
`;

/** One level of the tree over instances: a leaf from its mesh's root box through its matrix, an interior node from its children. */
export const REFIT_SCENE_WGSL = /* wgsl */ `
${REFIT_HEAD_WGSL}
@group(0) @binding(3) var<storage, read> instances: array<RayInstance>;
@group(0) @binding(4) var<storage, read> meshNodes: array<RayNode>;

fn span(row: vec4f, low: vec3f, high: vec3f) -> vec2f {
  let a = row.xyz * low;
  let b = row.xyz * high;
  let least = min(a, b);
  let most = max(a, b);
  return vec2f(row.w + least.x + least.y + least.z, row.w + most.x + most.y + most.z);
}

@compute @workgroup_size(64) fn refitScene(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= range.count) { return; }
  let node = order[range.first + id.x];
  let count = nodes[node].count;
  if (count < 0i) { return; }
  let link = nodes[node].link;
  if (count > 0i) {
    let instance = instances[link];
    let box = meshNodes[instance.root];
    let x = span(instance.world0, box.low, box.high);
    let y = span(instance.world1, box.low, box.high);
    let z = span(instance.world2, box.low, box.high);
    nodes[node].low = vec3f(x.x, y.x, z.x);
    nodes[node].high = vec3f(x.y, y.y, z.y);
  } else {
    nodes[node].low = min(nodes[link].low, nodes[link + 1u].low);
    nodes[node].high = max(nodes[link].high, nodes[link + 1u].high);
  }
}
`;
