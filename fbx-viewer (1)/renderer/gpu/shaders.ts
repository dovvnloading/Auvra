import { VERTEX_WGSL } from "./geometryPool";
import type { SurfaceKind } from "./surfaces";

/**
 * SHADER PIECES
 *
 * The WGSL every pass shares: the view, the instance table, the vertex path that reads both, and the frame that
 * a surface fills in. A pass's shader is these pieces, its own code and, where it draws materials, the
 * surface kind's. Group 0 is what is common to a view; group 1 is the scene's tables; group 2 is the material.
 */

export const VIEW_BYTES = 1024;

export const VIEW_WGSL = /* wgsl */ `
struct View {
  viewProjection: mat4x4f,
  unjitteredViewProjection: mat4x4f,
  previousViewProjection: mat4x4f,
  viewMatrix: mat4x4f,
  projection: mat4x4f,
  inverseViewProjection: mat4x4f,
  inverseProjection: mat4x4f,
  eye: vec4f,
  planes: array<vec4f, 6>,
  size: vec4f,
  jitter: vec4f,
  // time, pixels per unit at distance one, near, far
  params: vec4f,
  lodEye: vec4f,
  layers: u32,
  kind: u32,
  planeCount: u32,
  orthographic: u32,
}
`;

export const INSTANCE_WORDS = 36;

export const INSTANCE_FLAG = {
  active: 1,
  castsShadow: 2,
  receivesShadow: 4,
  alwaysVisible: 8,
  posed: 16,
  moved: 32,
  /** Drawn by the cluster pass in the main view, so the surface pass leaves it out there. */
  clustered: 64,
} as const;

export const INSTANCE_WGSL = /* wgsl */ `
struct Instance {
  world0: vec4f, world1: vec4f, world2: vec4f,
  previous0: vec4f, previous1: vec4f, previous2: vec4f,
  sphere: vec4f,
  color: vec4f,
  group: u32,
  flags: u32,
  layers: u32,
  // Add to a vertex's index to reach its position a frame ago, for a posed mesh.
  previousOffset: i32,
}
const INSTANCE_ACTIVE = ${INSTANCE_FLAG.active}u;
const INSTANCE_CASTS_SHADOW = ${INSTANCE_FLAG.castsShadow}u;
const INSTANCE_RECEIVES_SHADOW = ${INSTANCE_FLAG.receivesShadow}u;
const INSTANCE_ALWAYS_VISIBLE = ${INSTANCE_FLAG.alwaysVisible}u;
const INSTANCE_POSED = ${INSTANCE_FLAG.posed}u;
const INSTANCE_CLUSTERED = ${INSTANCE_FLAG.clustered}u;
`;

export const CAMERA_BINDINGS_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> view: View;
`;

export const SCENE_BINDINGS_WGSL = /* wgsl */ `
${VERTEX_WGSL}
@group(1) @binding(0) var<storage, read> instances: array<Instance>;
@group(1) @binding(1) var<storage, read> vertices: array<Vertex>;
@group(1) @binding(2) var<storage, read> previousPositions: array<f32>;
`;

const SURFACE_INTERFACE_WGSL = /* wgsl */ `
struct SurfaceIn {
  worldPosition: vec3f,
  normal: vec3f,
  geometricNormal: vec3f,
  tangent: vec3f,
  bitangentSign: f32,
  uv0: vec2f,
  uv1: vec2f,
  vertexColor: vec4f,
  instanceColor: vec4f,
  viewDirection: vec3f,
  frontFacing: bool,
  time: f32,
  // Its row in the instance table, for a surface that reads where it is on the object.
  instanceId: u32,
}

struct SurfaceOut {
  albedo: vec3f,
  opacity: f32,
  alphaTest: f32,
  normal: vec3f,
  roughness: f32,
  metalness: f32,
  occlusion: f32,
  emissive: vec3f,
  bakedLight: vec3f,
  hasBakedLight: bool,
  unlit: bool,
  // It shows only as much as the sun's shadow falls on it.
  catchesShadow: bool,
  // See-through as it is, what it mirrors stays at full strength.
  keepsReflections: bool,
}

fn surfaceDefaults(in: SurfaceIn) -> SurfaceOut {
  var out: SurfaceOut;
  out.albedo = vec3f(1.0);
  out.opacity = 1.0;
  out.alphaTest = 0.0;
  out.normal = in.normal;
  out.roughness = 1.0;
  out.metalness = 0.0;
  out.occlusion = 1.0;
  out.emissive = vec3f(0.0);
  out.bakedLight = vec3f(0.0);
  out.hasBakedLight = false;
  out.unlit = false;
  out.catchesShadow = false;
  out.keepsReflections = false;
  return out;
}

// A normal-map texel in the space around the surface, by the tangent when the mesh has one and otherwise by how the
// position and the uv change across the pixel.
fn perturbNormal(in: SurfaceIn, normal: vec3f, texel: vec3f, uv: vec2f) -> vec3f {
  var t: vec3f;
  var b: vec3f;
  if (dot(in.tangent, in.tangent) > 0.0) {
    t = normalize(in.tangent - normal * dot(normal, in.tangent));
    b = cross(normal, t) * in.bitangentSign;
  } else {
    let dpx = dpdx(in.worldPosition);
    let dpy = dpdy(in.worldPosition);
    let dux = dpdx(uv);
    let duy = dpdy(uv);
    let dp2perp = cross(dpy, normal);
    let dp1perp = cross(normal, dpx);
    let tangent = dp2perp * dux.x + dp1perp * duy.x;
    let bitangent = dp2perp * dux.y + dp1perp * duy.y;
    let scale = max(dot(tangent, tangent), dot(bitangent, bitangent));
    if (scale <= 0.0) { return normal; }
    let inverse = inverseSqrt(scale);
    t = tangent * inverse;
    b = bitangent * inverse;
  }
  return normalize(t * texel.x + b * texel.y + normal * texel.z);
}
`;

const VERTEX_PATH_WGSL = /* wgsl */ `
struct DrawIn {
  @builtin(vertex_index) vertexIndex: u32,
  @location(0) instanceId: u32,
}

fn unpackNormal(word: u32) -> vec3f {
  let e = unpack2x16snorm(word);
  var n = vec3f(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  if (n.z < 0.0) {
    let flipped = (vec2f(1.0) - abs(n.yx)) * select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0));
    n = vec3f(flipped, n.z);
  }
  return normalize(n);
}

fn worldOf(instance: Instance, p: vec3f) -> vec3f {
  let at = vec4f(p, 1.0);
  return vec3f(dot(instance.world0, at), dot(instance.world1, at), dot(instance.world2, at));
}

fn previousWorldOf(instance: Instance, p: vec3f) -> vec3f {
  let at = vec4f(p, 1.0);
  return vec3f(dot(instance.previous0, at), dot(instance.previous1, at), dot(instance.previous2, at));
}

// A direction's world form through the instance's matrix, with non-uniform scale handled: its cofactor.
fn worldNormalOf(instance: Instance, n: vec3f) -> vec3f {
  let a = instance.world0.xyz;
  let b = instance.world1.xyz;
  let c = instance.world2.xyz;
  let cofactor = mat3x3f(cross(b, c), cross(c, a), cross(a, b));
  // The columns above are the cofactor's rows, so the vector goes on the left.
  return normalize(n * cofactor);
}

fn worldDirectionOf(instance: Instance, d: vec3f) -> vec3f {
  return normalize(vec3f(dot(instance.world0.xyz, d), dot(instance.world1.xyz, d), dot(instance.world2.xyz, d)));
}

fn previousLocalPosition(instance: Instance, vertexIndex: u32, current: vec3f) -> vec3f {
  if ((instance.flags & INSTANCE_POSED) == 0u) { return current; }
  let at = u32(i32(vertexIndex) + instance.previousOffset) * 3u;
  return vec3f(previousPositions[at], previousPositions[at + 1u], previousPositions[at + 2u]);
}

struct SurfaceVarying {
  @builtin(position) clip: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) normal: vec3f,
  @location(2) tangent: vec4f,
  @location(3) uv: vec4f,
  @location(4) vertexColor: vec4f,
  @location(5) instanceColor: vec4f,
  @location(6) motionNow: vec4f,
  @location(7) motionThen: vec4f,
  @location(8) @interpolate(flat) flags: u32,
  @location(9) @interpolate(flat) instanceId: u32,
}

fn surfaceVarying(draw: DrawIn) -> SurfaceVarying {
  let instance = instances[draw.instanceId];
  let v = vertices[draw.vertexIndex];
  var local = vec3f(v.px, v.py, v.pz);
  var normal = unpackNormal(v.normal);
  let previousLocal = previousLocalPosition(instance, draw.vertexIndex, local);
  DISPLACE_CALL
  var out: SurfaceVarying;
  let world = worldOf(instance, local);
  out.worldPosition = world;
  out.clip = view.viewProjection * vec4f(world, 1.0);
  out.normal = worldNormalOf(instance, normal);
  if (v.tangent != 0u) {
    out.tangent = vec4f(worldDirectionOf(instance, unpackNormal(v.tangent & 0xfffefffeu)), select(-1.0, 1.0, (v.tangent & 0x10000u) != 0u));
  } else {
    out.tangent = vec4f(0.0);
  }
  out.uv = vec4f(v.u0, v.v0, v.u1, v.v1);
  out.vertexColor = unpack4x8unorm(v.color);
  out.instanceColor = instance.color;
  out.motionNow = view.unjitteredViewProjection * vec4f(world, 1.0);
  out.motionThen = view.previousViewProjection * vec4f(previousWorldOf(instance, previousLocal), 1.0);
  out.flags = instance.flags;
  out.instanceId = draw.instanceId;
  return out;
}

fn surfaceInput(in: SurfaceVarying, frontFacing: bool) -> SurfaceIn {
  var s: SurfaceIn;
  s.worldPosition = in.worldPosition;
  let geometric = normalize(cross(dpdx(in.worldPosition), dpdy(in.worldPosition)));
  // The derivative's handedness in a pass with y going down the screen: facing the eye either way.
  s.geometricNormal = select(geometric, -geometric, dot(geometric, view.eye.xyz - in.worldPosition) < 0.0);
  let shaded = normalize(in.normal);
  s.normal = select(-shaded, shaded, frontFacing);
  s.tangent = in.tangent.xyz;
  s.bitangentSign = in.tangent.w;
  s.uv0 = in.uv.xy;
  s.uv1 = in.uv.zw;
  s.vertexColor = in.vertexColor;
  s.instanceColor = in.instanceColor;
  s.viewDirection = normalize(view.eye.xyz - in.worldPosition);
  s.frontFacing = frontFacing;
  s.time = view.params.x;
  s.instanceId = in.instanceId;
  return s;
}
`;

const SURFACE_BUFFER_WGSL = /* wgsl */ `
struct GBuffer {
  @location(0) albedo: vec4f,
  @location(1) normalRoughnessMetal: vec4f,
  @location(2) emissive: vec4f,
  @location(3) motion: vec2f,
}

@vertex fn vertexMain(draw: DrawIn) -> SurfaceVarying { return surfaceVarying(draw); }

fn encodeOctahedral(n: vec3f) -> vec2f {
  let l = abs(n.x) + abs(n.y) + abs(n.z);
  var e = n.xy / l;
  if (n.z < 0.0) {
    e = (vec2f(1.0) - abs(e.yx)) * select(vec2f(-1.0), vec2f(1.0), e >= vec2f(0.0));
  }
  return e;
}

@fragment fn fragmentMain(in: SurfaceVarying, @builtin(front_facing) frontFacing: bool) -> GBuffer {
  let s = surface(surfaceInput(in, frontFacing));
  if (s.opacity < s.alphaTest) { discard; }
  var out: GBuffer;
  out.albedo = vec4f(s.albedo, s.occlusion);
  out.normalRoughnessMetal = vec4f(encodeOctahedral(s.normal), s.roughness, s.metalness);
  // Alpha: 0 lit, 1 unlit. A surface with baked light carries it here, on top of what it gives off, and says so with 0.5.
  // A quarter more says it takes no shadows.
  var emitted = s.emissive;
  var model = 0.0;
  if (s.unlit) {
    emitted += s.albedo;
    model = 1.0;
  } else {
    if (s.hasBakedLight) {
      emitted += s.bakedLight * s.albedo * (1.0 - s.metalness) / 3.14159265;
      model = 0.5;
    }
    if ((in.flags & INSTANCE_RECEIVES_SHADOW) == 0u) { model += 0.25; }
  }
  out.emissive = vec4f(emitted, model);
  let now = in.motionNow.xy / in.motionNow.w;
  let then = in.motionThen.xy / max(in.motionThen.w, 1e-5);
  out.motion = (then - now) * vec2f(0.5, -0.5);
  return out;
}
`;

const SHADOW_WGSL = /* wgsl */ `
@vertex fn vertexMain(draw: DrawIn) -> SurfaceVarying { return surfaceVarying(draw); }
@fragment fn fragmentMain(in: SurfaceVarying, @builtin(front_facing) frontFacing: bool) {
  let s = surface(surfaceInput(in, frontFacing));
  if (s.opacity < s.alphaTest) { discard; }
}
`;

const SHADOW_VERTEX_ONLY_WGSL = /* wgsl */ `
struct DrawIn {
  @builtin(vertex_index) vertexIndex: u32,
  @location(0) instanceId: u32,
}
@vertex fn vertexMain(draw: DrawIn) -> @builtin(position) vec4f {
  let instance = instances[draw.instanceId];
  let v = vertices[draw.vertexIndex];
  let at = vec4f(v.px, v.py, v.pz, 1.0);
  return view.viewProjection * vec4f(dot(instance.world0, at), dot(instance.world1, at), dot(instance.world2, at), 1.0);
}
`;

const withDisplace = (code: string, kind: SurfaceKind): string =>
  code.replace("DISPLACE_CALL", kind.displaces ? "local = displace(local, normal, instance, view.params.x);" : "");

const head = `${VIEW_WGSL}${INSTANCE_WGSL}${CAMERA_BINDINGS_WGSL}${SCENE_BINDINGS_WGSL}`;

/** The surface-buffer shader for a kind. */
export const surfaceBufferShader = (kind: SurfaceKind): string =>
  `${head}${SURFACE_INTERFACE_WGSL}${kind.wgsl}${withDisplace(VERTEX_PATH_WGSL, kind)}${SURFACE_BUFFER_WGSL}`;

/** The depth-only shader: masked surfaces run their surface to know where they have holes. */
export const shadowShader = (kind: SurfaceKind, masked: boolean): string => masked || kind.displaces
  ? `${head}${SURFACE_INTERFACE_WGSL}${kind.wgsl}${withDisplace(VERTEX_PATH_WGSL, kind)}${SHADOW_WGSL}`
  : `${head}${SHADOW_VERTEX_ONLY_WGSL}`;

/** The vertex path and surface interface, for the forward pass to add its lighting to. */
export const forwardHead = (kind: SurfaceKind): string =>
  `${head}${SURFACE_INTERFACE_WGSL}${kind.wgsl}${withDisplace(VERTEX_PATH_WGSL, kind)}`;

export const FULLSCREEN_WGSL = /* wgsl */ `
struct FullscreenOut { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn fullscreenVertex(@builtin(vertex_index) index: u32) -> FullscreenOut {
  let uv = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return FullscreenOut(vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0), uv);
}
`;
