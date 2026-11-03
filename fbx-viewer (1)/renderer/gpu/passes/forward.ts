/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { GrowableBuffer } from "../buffers";
import type { GpuCore } from "../device";
import { TARGET_FORMATS, type GpuFrame, type GpuPass } from "../frame";
import type { DrawRange } from "../geometryPool";
import type { GpuRenderer } from "../GpuRenderer";
import type { GpuScene } from "../gpuScene";
import type { LightingProduct } from "../lightingWgsl";
import type { MaterialEntry } from "../materialPool";
import { FULLSCREEN_WGSL, INSTANCE_FLAG, INSTANCE_WORDS, forwardHead } from "../shaders";
import { reportGpu } from "../report";
import { STANDARD_SURFACE, type SurfaceKind } from "../surfaces";

/**
 * FORWARD DRAWING
 *
 * What the surface buffer has no room for. ForwardPass draws onto the lit HDR picture, testing against the scene's
 * depth: surfaces you can see through, and everything that is not a filled opaque triangle (lines, wireframes, points
 * and sprites). OverlayPass draws what asked not to be tone mapped straight onto the canvas after tone mapping, and
 * encodes to sRGB in its shader because the canvas format does not. One walk of the scene a frame feeds both, sorted
 * the way three.js sorts: what does not blend first, then the rest from back to front, with groupOrder and renderOrder
 * above both.
 *
 * ADDING ANOTHER FORWARD EFFECT
 *
 * There is no list to join. A level component adds its own pass, and that pass opens its own render pass:
 *
 *   const gl = useThree((state) => state.gl);
 *   useEffect(() => {
 *     if (!isGpuRenderer(gl)) return;
 *     const effect: GpuPass = { id: "my-effect", stage: "forward", order: 10, execute: drawMyEffect };
 *     gl.addPass(effect);
 *     return () => gl.removePass(effect);
 *   }, [gl]);
 *
 * 1. Choose `order`. ForwardPass runs at FORWARD_ORDER (0): below that draws before the scene's transparent things, and
 *    above it draws over them.
 * 2. Open the render pass with beginForwardRenderPass(frame, label). That is frame.targets.hdr as the one colour
 *    attachment with loadOp "load", and frame.targets.depth with depthLoadOp "load", both stored. Never clear either:
 *    the lit picture and the scene's depth are already in them.
 * 3. Bind what is shared with bindForwardView(pass, frame): group 0 at frame.mainViewOffset, and group 1.
 * 4. Build the pipeline for colour format TARGET_FORMATS.hdr and depth format TARGET_FORMATS.depth. Depth is reversed, so
 *    compare with "greater-equal" and usually leave depthWriteEnabled off. forwardPipelinesFor(frame.device) keeps it:
 *    shared(key, make) for your own pipeline, material(frame, entry, spec) to draw a pool material the usual way.
 *    Vertex slot 0 in the material pipelines is FORWARD_INSTANCE_SLOT: one uint32 instance row per instance.
 * 5. End the render pass before execute returns. The frame's encoder carries on to the next pass.
 *
 * Group 2 is the material. Group 3 is free unless the pipeline uses lighting, which is frame.products "lighting"
 * (LightingProduct): add its layout as group 3, paste its wgsl into the shader, and bind its bindGroup each frame.
 *
 * An effect drawn on frame.canvasView instead, in stage "overlay", loads the canvas and calls setViewport and
 * setScissorRect with frame.viewport, because other views may share that canvas.
 */

/** ForwardPass's place in the "forward" stage. */
export const FORWARD_ORDER = 0;

/** The part of frame.products "lighting" (LightingProduct in lightingWgsl.ts) drawing with light needs. */
export type ForwardLighting = Pick<LightingProduct, "layout" | "bindGroup" | "wgsl">;

export type ForwardDrawPath = "surface" | "point" | "sprite";

export interface ForwardDrawSpec {
  format: GPUTextureFormat;
  /** "line-list" or "triangle-list" for a surface, "point-list" for a point and "triangle-list" for a sprite. */
  topology: GPUPrimitiveTopology;
  path: ForwardDrawPath;
  frontFace?: GPUFrontFace;
  /** Group 3 of a surface that takes light or fog; leave it out and the surface is drawn without. */
  lighting?: ForwardLighting | null;
  /** Whether shadows fall on a lit surface; the default is that they do. */
  receivesShadow?: boolean;
}

/** Vertex slot 0 of the material pipelines: the row in the instance table, one per instance. */
export const FORWARD_INSTANCE_SLOT: GPUVertexBufferLayout = {
  arrayStride: 4,
  stepMode: "instance",
  attributes: [{ shaderLocation: 0, offset: 0, format: "uint32" }],
};

/** Opens the render pass a forward effect draws in: the lit HDR picture and the scene's depth, both kept. */
export const beginForwardRenderPass = (frame: GpuFrame, label = "gpu forward effect"): GPURenderPassEncoder =>
  frame.encoder.beginRenderPass({
    label,
    colorAttachments: [{ view: frame.targets.hdr.view, loadOp: "load", storeOp: "store" }],
    depthStencilAttachment: { view: frame.targets.depth.view, depthLoadOp: "load", depthStoreOp: "store" },
  });

/** Groups 0 and 1: the main view and the scene's tables. */
export const bindForwardView = (pass: GPURenderPassEncoder, frame: GpuFrame): void => {
  pass.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
  pass.setBindGroup(1, frame.sceneBindGroup);
};

const DEPTH_COMPARE: Record<number, GPUCompareFunction> = {
  [THREE.NeverDepth]: "never",
  [THREE.AlwaysDepth]: "always",
  [THREE.LessDepth]: "greater",
  [THREE.LessEqualDepth]: "greater-equal",
  [THREE.EqualDepth]: "equal",
  [THREE.GreaterEqualDepth]: "less-equal",
  [THREE.GreaterDepth]: "less",
  [THREE.NotEqualDepth]: "not-equal",
};

/** What a material asks of depth, with its comparison turned around for reversed depth. */
export const forwardDepthState = (entry: MaterialEntry, topology: GPUPrimitiveTopology): GPUDepthStencilState => {
  const { state, material } = entry;
  const filled = topology === "triangle-list";
  return {
    format: TARGET_FORMATS.depth,
    depthWriteEnabled: state.depthTest && state.depthWrite,
    depthCompare: state.depthTest ? DEPTH_COMPARE[material.depthFunc] ?? "greater-equal" : "always",
    // A positive three.js offset pushes away from the eye, which with reversed depth is the smaller number. WebGPU takes
    // no offset at all on lines or points.
    depthBias: filled ? -Math.round(state.depthBias) : 0,
    depthBiasSlopeScale: filled ? -state.depthBiasSlope : 0,
  };
};

// Comes first in a shader. A surface may take a derivative under a branch, as perturbNormal does for a mesh with no
// tangents. The pixels of a triangle all go the same way there, so the answer is sound, but the compiler cannot see that.
const DERIVATIVES_WGSL = "diagnostic(off, derivative_uniformity);\n";

// Pipeline constants: what lands on the canvas is past the temporal resolve, so it is drawn without the frame's jitter
// and carries the encoding the canvas format does not do. Encoded first and multiplied by alpha after, as three.js does.
const FINISH_WGSL = /* wgsl */ `
override UNJITTERED: bool = false;
override ENCODE_SRGB: bool = false;
override PREMULTIPLY: bool = false;
override OPAQUE: bool = false;

fn linearToSrgb(color: vec3f) -> vec3f {
  let c = max(color, vec3f(0.0));
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}

fn finishColor(color: vec3f, opacity: f32) -> vec4f {
  let alpha = select(opacity, 1.0, OPAQUE);
  var rgb = color;
  if (ENCODE_SRGB) { rgb = linearToSrgb(rgb); }
  if (PREMULTIPLY) { rgb *= alpha; }
  return vec4f(rgb, alpha);
}
`;

const SURFACE_PATH_WGSL = /* wgsl */ `
@vertex fn surfaceVertex(draw: DrawIn) -> SurfaceVarying {
  var out = surfaceVarying(draw);
  if (UNJITTERED) { out.clip = out.motionNow; }
  return out;
}

@fragment fn surfaceFragment(in: SurfaceVarying, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {
  let input = surfaceInput(in, frontFacing);
  let s = surface(input);
  if (s.opacity < s.alphaTest) { discard; }
  return finishColor(shade(s, input, in), shownOpacity(s, input, in));
}
`;

const UNLIT_SHADE_WGSL = /* wgsl */ `
fn shade(s: SurfaceOut, input: SurfaceIn, in: SurfaceVarying) -> vec3f {
  return s.albedo + s.emissive;
}

fn shownOpacity(s: SurfaceOut, input: SurfaceIn, in: SurfaceVarying) -> f32 { return s.opacity; }
`;

// A surface that says it is unlit is here only for its fog. Baked light is counted the way the surface buffer counts it.
const LIT_SHADE_WGSL = /* wgsl */ `
override FOGGED: bool = true;
override RECEIVES_SHADOW: bool = true;

fn shade(s: SurfaceOut, input: SurfaceIn, in: SurfaceVarying) -> vec3f {
  var color = s.albedo + s.emissive;
  if (!s.unlit) {
    var light = lightingInput(input.worldPosition, s.normal, input.viewDirection, s.albedo, s.roughness, s.metalness, in.clip.xy);
    light.occlusion = s.occlusion;
    light.hasBakedLight = s.hasBakedLight;
    light.receivesShadow = RECEIVES_SHADOW;
    color = lightSurface(light) + s.emissive;
    if (s.hasBakedLight) { color += s.bakedLight * s.albedo * (1.0 - s.metalness) / 3.14159265; }
    // Blending takes the colour down by the opacity, and what a pane of glass mirrors is not dimmed by being clear.
    if (s.keepsReflections) { color /= max(s.opacity, 0.05); }
  }
  if (s.catchesShadow) { color = s.albedo; }
  if (FOGGED) { color = lightingApplyFog(color, input.worldPosition); }
  return color;
}

fn shownOpacity(s: SurfaceOut, input: SurfaceIn, in: SurfaceVarying) -> f32 {
  if (!s.catchesShadow) { return s.opacity; }
  let light = lightingInput(input.worldPosition, s.normal, input.viewDirection, s.albedo, s.roughness, s.metalness, in.clip.xy);
  return s.opacity * (1.0 - lightingSunShadowOf(light));
}
`;

const QUAD_BYTES = 64;

// Points and sprites are quads the vertex shader faces to the camera, so neither has vertices of its own in the index
// buffer: a point reads its vertex by instance through the index table, and a sprite has only the numbers below.
const QUAD_PATH_WGSL = /* wgsl */ `
struct QuadDraw {
  position: vec3f,
  rotation: f32,
  scale: vec2f,
  center: vec2f,
  size: f32,
  attenuate: u32,
  row: u32,
  firstIndex: u32,
  baseVertex: i32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
}
@group(3) @binding(0) var<uniform> quad: QuadDraw;
@group(3) @binding(1) var<storage, read> pointIndices: array<u32>;

struct QuadVarying {
  @builtin(position) clip: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) uv: vec2f,
  @location(2) vertexColor: vec4f,
  @location(3) instanceColor: vec4f,
  @location(4) @interpolate(flat) row: u32,
}

fn quadCorner(index: u32) -> vec2f {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  return corners[index];
}

fn quadClip(world: vec3f) -> vec4f {
  if (UNJITTERED) { return view.unjitteredViewProjection * vec4f(world, 1.0); }
  return view.viewProjection * vec4f(world, 1.0);
}

@vertex fn pointVertex(@builtin(vertex_index) cornerIndex: u32, @builtin(instance_index) pointIndex: u32) -> QuadVarying {
  let instance = instances[quad.row];
  let v = vertices[u32(i32(pointIndices[quad.firstIndex + pointIndex]) + quad.baseVertex)];
  let world = worldOf(instance, vec3f(v.px, v.py, v.pz));
  let center = quadClip(world);
  // A size that attenuates is the material's size in world units at the distance three.js measures it, half a screen
  // high at distance one; otherwise it is already in pixels of this picture.
  var pixels = quad.size;
  if (quad.attenuate != 0u && view.orthographic == 0u) { pixels *= view.size.y * 0.5 / max(center.w, 1e-4); }
  let corner = quadCorner(cornerIndex);
  var out: QuadVarying;
  out.clip = vec4f(center.xy + corner * pixels * view.size.zw * center.w, center.zw);
  out.worldPosition = world;
  out.uv = corner * 0.5 + vec2f(0.5);
  out.vertexColor = unpack4x8unorm(v.color);
  out.instanceColor = instance.color;
  out.row = quad.row;
  return out;
}

@vertex fn spriteVertex(@builtin(vertex_index) cornerIndex: u32) -> QuadVarying {
  let corner = quadCorner(cornerIndex) * 0.5;
  var scale = quad.scale;
  // Without attenuation a sprite grows with distance by just what the projection takes away.
  let distance = -(view.viewMatrix * vec4f(quad.position, 1.0)).z;
  if (quad.attenuate == 0u && view.orthographic == 0u) { scale *= distance; }
  let aligned = (corner - (quad.center - vec2f(0.5))) * scale;
  let c = cos(quad.rotation);
  let s = sin(quad.rotation);
  let rotated = vec2f(c * aligned.x - s * aligned.y, s * aligned.x + c * aligned.y);
  // The camera's right and up are the rows of the view matrix.
  let right = vec3f(view.viewMatrix[0].x, view.viewMatrix[1].x, view.viewMatrix[2].x);
  let up = vec3f(view.viewMatrix[0].y, view.viewMatrix[1].y, view.viewMatrix[2].y);
  let world = quad.position + right * rotated.x + up * rotated.y;
  var out: QuadVarying;
  out.clip = quadClip(world);
  out.worldPosition = world;
  out.uv = corner + vec2f(0.5);
  out.vertexColor = vec4f(1.0);
  out.instanceColor = vec4f(1.0);
  out.row = quad.row;
  return out;
}

@fragment fn quadFragment(in: QuadVarying) -> @location(0) vec4f {
  let toEye = normalize(view.eye.xyz - in.worldPosition);
  var input: SurfaceIn;
  input.worldPosition = in.worldPosition;
  input.normal = toEye;
  input.geometricNormal = toEye;
  input.tangent = vec3f(0.0);
  input.bitangentSign = 1.0;
  input.uv0 = in.uv;
  input.uv1 = in.uv;
  input.vertexColor = in.vertexColor;
  input.instanceColor = in.instanceColor;
  input.viewDirection = toEye;
  input.frontFacing = true;
  input.time = view.params.x;
  input.instanceId = in.row;
  let s = surface(input);
  if (s.opacity < s.alphaTest) { discard; }
  return finishColor(s.albedo + s.emissive, s.opacity);
}
`;

/** Whether scene.fog reaches a material. Only a few three.js materials have the flag at all, and they set it. */
const fogs = (material: THREE.Material): boolean => (material as THREE.Material & { fog?: boolean }).fog !== false;

const VERTEX_ENTRY: Record<ForwardDrawPath, string> = { surface: "surfaceVertex", point: "pointVertex", sprite: "spriteVertex" };

// The functions of LIGHTING_WGSL that drawing with light calls, written for ambient light only. The floor keeps a surface
// in a scene with no such light from going black.
const AMBIENT_WGSL = /* wgsl */ `
struct AmbientLight { ambient: vec4f, sky: vec4f, ground: vec4f }
@group(3) @binding(0) var<uniform> ambientLight: AmbientLight;

struct LightingInput {
  worldPosition: vec3f,
  normal: vec3f,
  viewDirection: vec3f,
  albedo: vec3f,
  roughness: f32,
  metalness: f32,
  occlusion: f32,
  pixel: vec2f,
  hasBakedLight: bool,
  receivesShadow: bool,
}

fn lightingInput(worldPosition: vec3f, normal: vec3f, viewDirection: vec3f, albedo: vec3f, roughness: f32, metalness: f32, pixel: vec2f) -> LightingInput {
  var input: LightingInput;
  input.worldPosition = worldPosition;
  input.normal = normal;
  input.viewDirection = viewDirection;
  input.albedo = albedo;
  input.roughness = roughness;
  input.metalness = metalness;
  input.occlusion = 1.0;
  input.pixel = pixel;
  input.hasBakedLight = false;
  input.receivesShadow = true;
  return input;
}

fn lightSurface(s: LightingInput) -> vec3f {
  if (s.hasBakedLight) { return vec3f(0.0); }
  let hemi = mix(ambientLight.ground.rgb, ambientLight.sky.rgb, 0.5 * s.normal.y + 0.5);
  let irradiance = max(ambientLight.ambient.rgb + hemi, vec3f(0.3));
  return s.albedo * (1.0 - s.metalness) * irradiance * s.occlusion / 3.14159265;
}

fn lightingApplyFog(color: vec3f, worldPosition: vec3f) -> vec3f { return color; }
`;

/** The scene's ambient and hemisphere light alone, for when no lighting pass has published anything. */
class AmbientLighting implements ForwardLighting {
  readonly wgsl = AMBIENT_WGSL;
  readonly layout: GPUBindGroupLayout;
  readonly bindGroup: GPUBindGroup;
  private readonly buffer: GPUBuffer;
  private readonly data = new Float32Array(12);

  constructor(private readonly device: GPUDevice) {
    this.buffer = device.createBuffer({ label: "gpu forward ambient", size: this.data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.layout = device.createBindGroupLayout({
      label: "gpu forward ambient",
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
    });
    this.bindGroup = device.createBindGroup({ label: "gpu forward ambient", layout: this.layout, entries: [{ binding: 0, resource: { buffer: this.buffer } }] });
  }

  update(scene: GpuScene): void {
    const { data } = this;
    scene.ambient.toArray(data, 0);
    scene.hemiSky.toArray(data, 4);
    scene.hemiGround.toArray(data, 8);
    this.device.queue.writeBuffer(this.buffer, 0, data);
  }
}

/**
 * The pipelines forward drawing uses, one set for a device. A material's pipeline is found by what splits it: its
 * surface kind, its state, whether it takes light, the path it is drawn by and the format it lands in. Other forward
 * effects keep their own pipelines and shader modules here too, under keys of their own.
 */
export class ForwardPipelines {
  /** Group 3 of a point or sprite: the draw's numbers at a dynamic offset, and the index table. */
  readonly quadLayout: GPUBindGroupLayout;
  private readonly modules = new Map<string, GPUShaderModule>();
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  /** Null until the driver has finished compiling it, and for good if that failed. */
  private readonly materialPipelines = new Map<string, GPURenderPipeline | null>();
  private readonly lightingCode = new Map<string, number>();
  private ambient: AmbientLighting | null = null;

  constructor(private readonly device: GPUDevice) {
    this.quadLayout = device.createBindGroupLayout({
      label: "gpu forward quad",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: QUAD_BYTES } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });
  }

  /** The shader module under `key`, compiled the first time it is asked for. */
  module(key: string, code: () => string): GPUShaderModule {
    let module = this.modules.get(key);
    if (!module) {
      module = this.device.createShaderModule({ label: `gpu forward ${key}`, code: code() });
      this.modules.set(key, module);
    }
    return module;
  }

  /** The pipeline under `key`, made the first time it is asked for. */
  shared(key: string, make: () => GPURenderPipeline): GPURenderPipeline {
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = make();
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  /** What the frame lights forward surfaces with: the lighting pass's product, or the scene's ambient light. */
  lightingFor(frame: GpuFrame): ForwardLighting {
    const published = frame.products.get("lighting") as ForwardLighting | undefined;
    if (published) return published;
    if (!this.ambient) this.ambient = new AmbientLighting(this.device);
    this.ambient.update(frame.gpuScene);
    return this.ambient;
  }

  /**
   * The pipeline that draws a pool material by `spec`, or null until it is ready. A material's shader can be anyone's
   * work, so it is compiled off the frame: a slow one holds up nothing, and one that fails is left out of the picture
   * rather than throwing away the whole frame it was bound in.
   */
  material(frame: GpuFrame, entry: MaterialEntry, spec: ForwardDrawSpec): GPURenderPipeline | null {
    const { path, format, topology } = spec;
    const frontFace = spec.frontFace ?? "ccw";
    const lighting = path === "surface" ? spec.lighting ?? null : null;
    const light = lighting ? this.lightingKey(lighting) : 0;
    const { material } = entry;
    const received = lighting && spec.receivesShadow !== false ? 1 : 0;
    const key = `${path}|${entry.kind.id}|${light}|${received}|${fogs(material) ? 1 : 0}|${format}|${topology}|${frontFace}|${entry.stateKey}|${material.depthFunc}|${material.colorWrite ? 1 : 0}|${material.premultipliedAlpha ? 1 : 0}`;
    const known = this.materialPipelines.get(key);
    if (known !== undefined) return known;
    this.materialPipelines.set(key, null);
    this.device.createRenderPipelineAsync(this.describeMaterialPipeline(frame, entry, spec, frontFace, lighting, light)).then((pipeline) => {
      this.materialPipelines.set(key, pipeline);
    }).catch((error: unknown) => {
      reportGpu(`[gpu] forward pipeline ${entry.kind.id} failed`, error);
    });
    return null;
  }

  /** Lighting code is told apart by what it says, so a lighting pass made again keeps its pipelines. */
  private lightingKey(lighting: ForwardLighting): number {
    let id = this.lightingCode.get(lighting.wgsl);
    if (id === undefined) {
      id = this.lightingCode.size + 1;
      this.lightingCode.set(lighting.wgsl, id);
    }
    return id;
  }

  private moduleFor(kind: SurfaceKind, path: ForwardDrawPath, lighting: ForwardLighting | null, light: number): GPUShaderModule {
    const head = `${DERIVATIVES_WGSL}${forwardHead(kind)}${FINISH_WGSL}`;
    if (path !== "surface") return this.module(`quad ${kind.id}`, () => `${head}${QUAD_PATH_WGSL}`);
    if (!lighting) return this.module(`unlit ${kind.id}`, () => `${head}${UNLIT_SHADE_WGSL}${SURFACE_PATH_WGSL}`);
    return this.module(`lit ${light} ${kind.id}`, () => `${head}${lighting.wgsl}${LIT_SHADE_WGSL}${SURFACE_PATH_WGSL}`);
  }

  private describeMaterialPipeline(frame: GpuFrame, entry: MaterialEntry, spec: ForwardDrawSpec, frontFace: GPUFrontFace, lighting: ForwardLighting | null, light: number): GPURenderPipelineDescriptor {
    const { path, format, topology } = spec;
    const { kind, state, material } = entry;
    const module = this.moduleFor(kind, path, lighting, light);
    const bindGroupLayouts = [frame.cameraLayout, frame.sceneLayout, frame.materials.layoutFor(kind)];
    if (path !== "surface") bindGroupLayouts.push(this.quadLayout);
    else if (lighting) bindGroupLayouts.push(lighting.layout);
    const onCanvas = format !== TARGET_FORMATS.hdr;
    const target: GPUColorTargetState = { format, writeMask: material.colorWrite ? GPUColorWrite.ALL : 0 };
    if (state.blend) target.blend = state.blend;
    const filled = topology === "triangle-list";
    const constants: Record<string, number> = {
      ENCODE_SRGB: onCanvas && !format.endsWith("-srgb") ? 1 : 0,
      PREMULTIPLY: state.transparent && material.premultipliedAlpha ? 1 : 0,
      OPAQUE: state.transparent ? 0 : 1,
    };
    if (lighting) {
      constants.FOGGED = fogs(material) ? 1 : 0;
      constants.RECEIVES_SHADOW = spec.receivesShadow === false ? 0 : 1;
    }
    return {
      label: `gpu forward ${path} ${kind.id} ${format}`,
      layout: this.device.createPipelineLayout({ label: `gpu forward ${path} ${kind.id}`, bindGroupLayouts }),
      vertex: {
        module,
        entryPoint: VERTEX_ENTRY[path],
        constants: { UNJITTERED: onCanvas ? 1 : 0 },
        buffers: path === "surface" ? [FORWARD_INSTANCE_SLOT] : [],
      },
      fragment: {
        module,
        entryPoint: path === "surface" ? "surfaceFragment" : "quadFragment",
        constants,
        targets: [target],
      },
      primitive: path === "surface"
        ? { topology, cullMode: filled ? state.cull : "none", frontFace }
        : { topology: "triangle-list", cullMode: "none" },
      depthStencil: forwardDepthState(entry, topology),
    };
  }
}

const pipelinesByDevice = new WeakMap<GPUDevice, ForwardPipelines>();

/** The device's forward pipelines: what the two passes below use, and what other forward effects reuse. */
export const forwardPipelinesFor = (device: GPUDevice): ForwardPipelines => {
  let pipelines = pipelinesByDevice.get(device);
  if (!pipelines) {
    pipelines = new ForwardPipelines(device);
    pipelinesByDevice.set(device, pipelines);
  }
  return pipelines;
};

type ScenePart = GpuScene["forward"][number]["part"];

/** One draw, as the walk found it. */
interface ForwardItem {
  path: ForwardDrawPath;
  entry: MaterialEntry;
  topology: GPUPrimitiveTopology;
  frontFace: GPUFrontFace;
  lit: boolean;
  receivesShadow: boolean;
  groupOrder: number;
  renderOrder: number;
  z: number;
  id: number;
  /** A surface's range, and for a point its range as the number of points. */
  firstIndex: number;
  indexCount: number;
  baseVertex: number;
  /** A surface's run in the frame's list of instance rows. */
  firstRow: number;
  rows: number;
  /** A point's or sprite's numbers in the frame's quad buffer. */
  quadOffset: number;
}

// Where things lie in a row of the instance table (INSTANCE_WGSL).
const ROW_SPHERE = 24;
const ROW_FLAGS = 33;

const _screen = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _point = new THREE.Vector3();
const _size = new THREE.Vector2();

const rendererOf = (frame: GpuFrame): GpuRenderer | undefined => frame.products.get("renderer") as GpuRenderer | undefined;

/** Whether a row is to be drawn and any of its bounds lies inside the view. */
const rowVisible = (scene: GpuScene, row: number): boolean => {
  const at = row * INSTANCE_WORDS;
  const flags = scene.instances.uints[at + ROW_FLAGS];
  if (!(flags & INSTANCE_FLAG.active)) return false;
  if (flags & INSTANCE_FLAG.alwaysVisible) return true;
  const { data } = scene.instances;
  const x = data[at + ROW_SPHERE];
  const y = data[at + ROW_SPHERE + 1];
  const z = data[at + ROW_SPHERE + 2];
  const radius = data[at + ROW_SPHERE + 3];
  const { planes } = _frustum;
  for (let index = 0; index < 6; index++) {
    const { normal, constant } = planes[index];
    if (normal.x * x + normal.y * y + normal.z * z + constant < -radius) return false;
  }
  return true;
};

/** Where three.js says an object is along the view, for sorting: the centre of its bounds after projection. */
const depthOf = (object: THREE.Mesh): number => {
  const bounded = object as unknown as { boundingSphere?: THREE.Sphere | null; computeBoundingSphere?: () => void };
  if (bounded.boundingSphere === null) bounded.computeBoundingSphere?.();
  const { geometry } = object;
  if (!bounded.boundingSphere && !geometry.boundingSphere) geometry.computeBoundingSphere();
  const sphere = bounded.boundingSphere ?? geometry.boundingSphere;
  if (sphere) _point.copy(sphere.center);
  else _point.set(0, 0, 0);
  return _point.applyMatrix4(object.matrixWorld).applyMatrix4(_screen).z;
};

type NumberedMaterial = THREE.Material & { id: number };

/** What does not blend goes first, and then the rest; inside each, the orders three.js sorts by. */
const drawOrder = (a: ForwardItem, b: ForwardItem): number => {
  const clear = a.entry.state.transparent;
  if (clear !== b.entry.state.transparent) return clear ? 1 : -1;
  if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
  if (!clear) {
    const difference = (a.entry.material as NumberedMaterial).id - (b.entry.material as NumberedMaterial).id;
    if (difference) return difference;
  }
  if (a.z !== b.z) return clear ? b.z - a.z : a.z - b.z;
  return a.id - b.id;
};

/** Whether a surface takes light. A kind of its own may still say per pixel that it does not. */
const takesLight = (entry: MaterialEntry): boolean => {
  if (entry.kind !== STANDARD_SURFACE) return true;
  const m = entry.material as THREE.Material & { isMeshBasicMaterial?: boolean; isLineBasicMaterial?: boolean; isPointsMaterial?: boolean; isSpriteMaterial?: boolean };
  return !(m.isMeshBasicMaterial || m.isLineBasicMaterial || m.isPointsMaterial || m.isSpriteMaterial);
};

/** A filled opaque mesh with one material can be passed over without looking it up. */
const mayDrawHere = (object: THREE.Mesh): boolean => {
  if (!object.isMesh) return true;
  const { material } = object;
  if (Array.isArray(material)) return true;
  return material.transparent || !material.toneMapped || !!(material as THREE.MeshBasicMaterial).wireframe;
};

/** The indices of one part as it stands now, draw range included. */
const rangeOf = (frame: GpuFrame, mesh: THREE.Mesh, part: ScenePart): DrawRange => {
  const { group } = part;
  const entry = group.geometry;
  const { drawRange } = mesh.geometry;
  const line = mesh as unknown as THREE.Line;
  if (group.topology === "line-list") {
    if (!line.isLine) return frame.geometries.wireRange(entry);
    if (!(line as THREE.LineSegments).isLineSegments) {
      // A strip's indices are a pair for each segment, and a geometry that changed gets them made again.
      const strip = frame.geometries.stripRange(entry, !!(line as THREE.LineLoop).isLineLoop);
      const skipped = Math.min(drawRange.start * 2, strip.indexCount);
      const wanted = Number.isFinite(drawRange.count) ? Math.max(drawRange.count - 1, 0) * 2 : Infinity;
      return { firstIndex: strip.firstIndex + skipped, indexCount: Math.min(wanted, strip.indexCount - skipped) };
    }
  }
  if (Array.isArray(mesh.material)) return group.range;
  const skipped = Math.min(drawRange.start, entry.indexCount);
  return { firstIndex: entry.indexBase + skipped, indexCount: Math.min(drawRange.count, entry.indexCount - skipped) };
};

const INITIAL_ROWS = 1024;
const INITIAL_QUADS = 64;

/** What is drawn this frame and the small buffers that say how, made once a frame and shared by both passes. */
class ForwardDrawList {
  readonly forward: ForwardItem[] = [];
  readonly overlay: ForwardItem[] = [];
  destroyed = false;
  private frameNumber = -1;
  private readonly rowBuffer: GrowableBuffer;
  private rowWords = new Uint32Array(INITIAL_ROWS);
  private rowCount = 0;
  private readonly quadBuffer: GrowableBuffer;
  private readonly quadStride: number;
  private quadBytes: Uint8Array;
  private quadCount = 0;
  private quadBindGroup: GPUBindGroup | null = null;
  private quadBindKey = "";
  /** Pixels of this picture to one unit of a material's size that does not attenuate. */
  private pointScale = 1;

  constructor(private readonly device: GPUDevice) {
    const alignment = device.limits.minUniformBufferOffsetAlignment;
    this.quadStride = Math.ceil(QUAD_BYTES / alignment) * alignment;
    this.quadBytes = new Uint8Array(this.quadStride * INITIAL_QUADS);
    this.rowBuffer = new GrowableBuffer(device, "gpu forward rows", GPUBufferUsage.VERTEX, INITIAL_ROWS * 4);
    this.quadBuffer = new GrowableBuffer(device, "gpu forward quads", GPUBufferUsage.UNIFORM, this.quadBytes.byteLength);
  }

  gather(frame: GpuFrame): void {
    if (this.frameNumber === frame.frameNumber) return;
    this.frameNumber = frame.frameNumber;
    this.forward.length = 0;
    this.overlay.length = 0;
    this.rowCount = 0;
    this.quadCount = 0;
    const { camera } = frame;
    _screen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_screen);
    this.pointScale = (rendererOf(frame)?.getPixelRatio() ?? 1) * frame.targets.height / frame.viewport.height;
    this.walk(frame, frame.scene, 0);
    this.forward.sort(drawOrder);
    this.overlay.sort(drawOrder);
    if (this.rowCount) {
      this.rowBuffer.ensure(this.rowCount * 4);
      this.rowBuffer.write(0, this.rowWords, 0, this.rowCount * 4);
    }
    if (this.quadCount) {
      this.quadBuffer.ensure(this.quadCount * this.quadStride);
      this.quadBuffer.write(0, this.quadBytes, 0, this.quadCount * this.quadStride);
    }
  }

  private walk(frame: GpuFrame, object: THREE.Object3D, groupOrder: number): void {
    if (!object.visible) return;
    if (object.layers.test(frame.camera.layers)) {
      const drawn = object as THREE.Mesh;
      if ((object as THREE.Group).isGroup) groupOrder = object.renderOrder;
      else if ((object as THREE.Sprite).isSprite) this.addSprite(frame, object as THREE.Sprite, groupOrder);
      else if (drawn.isMesh || (object as THREE.Line).isLine || (object as THREE.Points).isPoints) this.addDrawn(frame, drawn, groupOrder);
    }
    const { children } = object;
    for (let index = 0; index < children.length; index++) this.walk(frame, children[index], groupOrder);
  }

  /** The list a material belongs on, or null where it is the surface buffer's or asks to draw nothing at all. */
  private listFor(entry: MaterialEntry, inSurfaceBuffer: boolean): ForwardItem[] | null {
    const { state, material } = entry;
    if (!material.visible) return null;
    if (!material.colorWrite && !(state.depthTest && state.depthWrite)) return null;
    if (!state.toneMapped) return this.overlay;
    return state.transparent || !inSurfaceBuffer ? this.forward : null;
  }

  private addDrawn(frame: GpuFrame, mesh: THREE.Mesh, groupOrder: number): void {
    if (!mayDrawHere(mesh)) return;
    // The scene's rows are kept per object in a table of its own; bracket access is the one way in for now.
    const record = frame.gpuScene["records"].get(mesh);
    if (!record) return;
    for (const part of record.parts) {
      const { group } = part;
      const list = this.listFor(group.material, group.topology === "triangle-list");
      if (!list) continue;
      const range = rangeOf(frame, mesh, part);
      if (range.indexCount <= 0) continue;
      if (group.topology === "point-list") this.addPoints(frame, mesh, part, range, list, groupOrder);
      else this.addSurface(frame, mesh, part, range, list, groupOrder);
    }
  }

  private addSurface(frame: GpuFrame, mesh: THREE.Mesh, part: ScenePart, range: DrawRange, list: ForwardItem[], groupOrder: number): void {
    const { group } = part;
    const instanced = mesh as unknown as THREE.InstancedMesh;
    const count = instanced.isInstancedMesh ? Math.min(part.count, instanced.count) : part.count;
    const firstRow = this.rowCount;
    for (let row = 0; row < count; row++) {
      if (rowVisible(frame.gpuScene, part.firstInstance + row)) this.pushRow(part.firstInstance + row);
    }
    if (this.rowCount === firstRow) return;
    const filled = group.topology === "triangle-list";
    list.push({
      path: "surface",
      entry: group.material,
      topology: group.topology,
      // A mirrored object's triangles wind the other way round, and three.js turns its front face to match.
      frontFace: filled && mesh.matrixWorld.determinant() < 0 ? "cw" : "ccw",
      // An unlit surface still takes fog, which the lighting group holds; it skips the light inside the shader.
      lit: takesLight(group.material) || (!!frame.scene.fog && fogs(group.material.material) && frame.products.has("lighting")),
      receivesShadow: mesh.receiveShadow,
      groupOrder,
      renderOrder: mesh.renderOrder,
      z: depthOf(mesh),
      id: mesh.id,
      firstIndex: range.firstIndex,
      indexCount: range.indexCount,
      baseVertex: group.baseVertex,
      firstRow,
      rows: this.rowCount - firstRow,
      quadOffset: 0,
    });
  }

  private addPoints(frame: GpuFrame, mesh: THREE.Mesh, part: ScenePart, range: DrawRange, list: ForwardItem[], groupOrder: number): void {
    if (!rowVisible(frame.gpuScene, part.firstInstance)) return;
    const { group } = part;
    const material = group.material.material as THREE.PointsMaterial;
    const attenuates = !!material.isPointsMaterial && material.sizeAttenuation;
    const size = material.isPointsMaterial ? material.size : 1;
    const at = this.pushQuad();
    const floats = new Float32Array(this.quadBytes.buffer, at, QUAD_BYTES / 4);
    const words = new Uint32Array(this.quadBytes.buffer, at, QUAD_BYTES / 4);
    floats[8] = attenuates ? size : size * this.pointScale;
    words[9] = attenuates ? 1 : 0;
    words[10] = part.firstInstance;
    words[11] = range.firstIndex;
    words[12] = group.baseVertex;
    list.push({
      path: "point",
      entry: group.material,
      topology: "point-list",
      frontFace: "ccw",
      lit: false,
      receivesShadow: false,
      groupOrder,
      renderOrder: mesh.renderOrder,
      z: depthOf(mesh),
      id: mesh.id,
      firstIndex: range.firstIndex,
      indexCount: range.indexCount,
      baseVertex: group.baseVertex,
      firstRow: 0,
      rows: 0,
      quadOffset: at,
    });
  }

  private addSprite(frame: GpuFrame, sprite: THREE.Sprite, groupOrder: number): void {
    const { material } = sprite;
    if (!material?.visible) return;
    if (sprite.frustumCulled && !_frustum.intersectsSprite(sprite)) return;
    const entry = frame.materials.acquire(material);
    if (!entry) return;
    const list = this.listFor(entry, false);
    if (!list) return;
    const e = sprite.matrixWorld.elements;
    const at = this.pushQuad();
    const floats = new Float32Array(this.quadBytes.buffer, at, QUAD_BYTES / 4);
    const words = new Uint32Array(this.quadBytes.buffer, at, QUAD_BYTES / 4);
    floats[0] = e[12];
    floats[1] = e[13];
    floats[2] = e[14];
    floats[3] = material.rotation;
    floats[4] = Math.hypot(e[0], e[1], e[2]);
    floats[5] = Math.hypot(e[4], e[5], e[6]);
    floats[6] = sprite.center.x;
    floats[7] = sprite.center.y;
    words[9] = material.sizeAttenuation ? 1 : 0;
    list.push({
      path: "sprite",
      entry,
      topology: "triangle-list",
      frontFace: "ccw",
      lit: false,
      receivesShadow: false,
      groupOrder,
      renderOrder: sprite.renderOrder,
      z: _point.set(e[12], e[13], e[14]).applyMatrix4(_screen).z,
      id: sprite.id,
      firstIndex: 0,
      indexCount: 0,
      baseVertex: 0,
      firstRow: 0,
      rows: 0,
      quadOffset: at,
    });
  }

  private pushRow(row: number): void {
    if (this.rowCount === this.rowWords.length) {
      const grown = new Uint32Array(this.rowWords.length * 2);
      grown.set(this.rowWords);
      this.rowWords = grown;
    }
    this.rowWords[this.rowCount++] = row;
  }

  /** A cleared slice of the quad buffer, and its byte offset. */
  private pushQuad(): number {
    const at = this.quadCount * this.quadStride;
    if (at + this.quadStride > this.quadBytes.byteLength) {
      const grown = new Uint8Array(this.quadBytes.byteLength * 2);
      grown.set(this.quadBytes);
      this.quadBytes = grown;
    }
    this.quadBytes.fill(0, at, at + this.quadStride);
    this.quadCount++;
    return at;
  }

  private quadBindGroupFor(frame: GpuFrame, pipelines: ForwardPipelines): GPUBindGroup {
    const { indices } = frame.geometries;
    const key = `${this.quadBuffer.generation}/${indices.generation}`;
    if (this.quadBindGroup && this.quadBindKey === key) return this.quadBindGroup;
    this.quadBindKey = key;
    this.quadBindGroup = this.device.createBindGroup({
      label: "gpu forward quad",
      layout: pipelines.quadLayout,
      entries: [
        { binding: 0, resource: { buffer: this.quadBuffer.buffer, offset: 0, size: QUAD_BYTES } },
        { binding: 1, resource: { buffer: indices.buffer } },
      ],
    });
    return this.quadBindGroup;
  }

  /** Records `items` into an open render pass whose colour attachment is `format`. */
  record(pipelines: ForwardPipelines, frame: GpuFrame, pass: GPURenderPassEncoder, items: readonly ForwardItem[], format: GPUTextureFormat): void {
    const lighting = items.some((item) => item.lit) ? pipelines.lightingFor(frame) : null;
    bindForwardView(pass, frame);
    pass.setIndexBuffer(frame.geometries.indices.buffer, "uint32");
    pass.setVertexBuffer(0, this.rowBuffer.buffer);
    let boundPipeline: GPURenderPipeline | null = null;
    let boundMaterial: GPUBindGroup | null = null;
    let lightingBound = false;
    for (const item of items) {
      const pipeline = pipelines.material(frame, item.entry, {
        path: item.path,
        format,
        topology: item.topology,
        frontFace: item.frontFace,
        lighting: item.lit ? lighting : null,
        receivesShadow: item.receivesShadow,
      });
      if (!pipeline || !item.entry.bindGroup) continue;
      if (pipeline !== boundPipeline) {
        pass.setPipeline(pipeline);
        boundPipeline = pipeline;
      }
      if (item.entry.bindGroup !== boundMaterial) {
        pass.setBindGroup(2, item.entry.bindGroup);
        boundMaterial = item.entry.bindGroup;
      }
      if (item.path === "surface") {
        if (lighting && item.lit && !lightingBound) {
          pass.setBindGroup(3, lighting.bindGroup);
          lightingBound = true;
        }
        pass.drawIndexed(item.indexCount, item.rows, item.firstIndex, item.baseVertex, item.firstRow);
      } else {
        pass.setBindGroup(3, this.quadBindGroupFor(frame, pipelines), [item.quadOffset]);
        lightingBound = false;
        pass.draw(6, item.path === "point" ? item.indexCount : 1);
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.rowBuffer.destroy();
    this.quadBuffer.destroy();
  }
}

const drawListFor = (frame: GpuFrame): ForwardDrawList => {
  let list = frame.products.get("forwardDrawList") as ForwardDrawList | undefined;
  if (!list || list.destroyed) {
    list = new ForwardDrawList(frame.device);
    frame.products.set("forwardDrawList", list);
  }
  list.gather(frame);
  return list;
};

/** Surfaces you can see through, lines, wireframes, points and sprites, onto the lit HDR picture. */
export class ForwardPass implements GpuPass {
  readonly id = "forward";
  readonly stage = "forward" as const;
  readonly order = FORWARD_ORDER;
  private readonly pipelines: ForwardPipelines;
  private list: ForwardDrawList | null = null;

  constructor(core: GpuCore) {
    this.pipelines = forwardPipelinesFor(core.device);
  }

  execute(frame: GpuFrame): void {
    const list = drawListFor(frame);
    this.list = list;
    if (!list.forward.length) return;
    const pass = beginForwardRenderPass(frame, "gpu forward");
    list.record(this.pipelines, frame, pass, list.forward, TARGET_FORMATS.hdr);
    pass.end();
  }

  dispose(): void {
    this.list?.destroy();
    this.list = null;
  }
}

const DEPTH_COPY_WGSL = /* wgsl */ `
${FULLSCREEN_WGSL}
@group(0) @binding(0) var sceneDepth: texture_depth_2d;

@fragment fn copyDepth(in: FullscreenOut) -> @builtin(frag_depth) f32 {
  return textureLoad(sceneDepth, vec2i(in.uv * vec2f(textureDimensions(sceneDepth))), 0);
}
`;

/** This view's rectangle of the canvas, which other views may share: what anything drawing to frame.canvasView sets. */
const setCanvasRect = (pass: GPURenderPassEncoder, frame: GpuFrame): void => {
  const { x, y, width, height } = frame.viewport;
  pass.setViewport(x, y, width, height, 0, 1);
  pass.setScissorRect(x, y, width, height);
};

/** What asked not to be tone mapped, onto the canvas: gizmos, selection wireframes, helpers. */
export class OverlayPass implements GpuPass {
  readonly id = "overlay";
  readonly stage = "overlay" as const;
  readonly order = FORWARD_ORDER;
  private readonly pipelines: ForwardPipelines;
  private list: ForwardDrawList | null = null;
  private canvasDepth: GPUTexture | null = null;
  private canvasDepthView: GPUTextureView | null = null;
  private copyBindGroup: GPUBindGroup | null = null;
  private copySource: GPUTextureView | null = null;

  constructor(core: GpuCore) {
    this.pipelines = forwardPipelinesFor(core.device);
  }

  execute(frame: GpuFrame): void {
    const list = drawListFor(frame);
    this.list = list;
    if (!list.overlay.length) return;
    const depth = this.depthFor(frame);
    const pass = frame.encoder.beginRenderPass({
      label: "gpu overlay",
      colorAttachments: [{ view: frame.canvasView, loadOp: "load", storeOp: "store" }],
      depthStencilAttachment: { view: depth, depthLoadOp: "load", depthStoreOp: "store" },
    });
    setCanvasRect(pass, frame);
    list.record(this.pipelines, frame, pass, list.overlay, frame.presentFormat);
    pass.end();
  }

  /**
   * The scene's depth as an attachment the size of the canvas texture, which a render pass needs of everything attached.
   * That is the depth target itself when one view fills the canvas at full scale. A view that is only part of the canvas
   * or drawn smaller gets its depth copied into its rectangle of a canvas-sized texture.
   */
  private depthFor(frame: GpuFrame): GPUTextureView {
    const { targets, device } = frame;
    const renderer = rendererOf(frame);
    if (!renderer) return targets.depth.view;
    const { x: width, y: height } = renderer.getDrawingBufferSize(_size);
    if (width === targets.width && height === targets.height) return targets.depth.view;
    if (!this.canvasDepth || this.canvasDepth.width !== width || this.canvasDepth.height !== height) {
      this.canvasDepth?.destroy();
      this.canvasDepth = device.createTexture({ label: "gpu overlay depth", size: [width, height], format: TARGET_FORMATS.depth, usage: GPUTextureUsage.RENDER_ATTACHMENT });
      this.canvasDepthView = this.canvasDepth.createView();
    }
    const { pipelines } = this;
    const pipeline = pipelines.shared("overlay depth copy", () => {
      const module = pipelines.module("overlay depth copy", () => DEPTH_COPY_WGSL);
      return device.createRenderPipeline({
        label: "gpu overlay depth copy",
        layout: "auto",
        vertex: { module, entryPoint: "fullscreenVertex" },
        fragment: { module, entryPoint: "copyDepth", targets: [] },
        depthStencil: { format: TARGET_FORMATS.depth, depthWriteEnabled: true, depthCompare: "always" },
      });
    });
    if (!this.copyBindGroup || this.copySource !== targets.depth.view) {
      this.copySource = targets.depth.view;
      this.copyBindGroup = device.createBindGroup({
        label: "gpu overlay depth copy",
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: targets.depth.view }],
      });
    }
    const view = this.canvasDepthView as GPUTextureView;
    const pass = frame.encoder.beginRenderPass({
      label: "gpu overlay depth copy",
      colorAttachments: [],
      depthStencilAttachment: { view, depthClearValue: 0, depthLoadOp: "clear", depthStoreOp: "store" },
    });
    setCanvasRect(pass, frame);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.copyBindGroup);
    pass.draw(3);
    pass.end();
    return view;
  }

  dispose(): void {
    this.list?.destroy();
    this.list = null;
    this.canvasDepth?.destroy();
    this.canvasDepth = null;
    this.canvasDepthView = null;
    this.copyBindGroup = null;
    this.copySource = null;
  }
}
