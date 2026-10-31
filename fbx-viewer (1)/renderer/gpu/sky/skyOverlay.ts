/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { TARGET_FORMATS, type GpuFrame } from "../frame";
import { CAMERA_BINDINGS_WGSL, FULLSCREEN_WGSL, VIEW_WGSL } from "../shaders";
import type { GpuBolt, GpuFlatClouds, GpuNightSky, GpuSkySettings } from "./skySettings";

/**
 * THINGS ON THE SKY
 *
 * What is drawn over the sky's own colour, where nothing in the scene stands in front of it: the classic sky's stars and
 * moon, the flat painted cloud layer and lightning bolts. Each sits at infinity, at the far plane with the depth test
 * on, and turns with the camera but never moves with it.
 */

const OVERLAY_BYTES = 144;
/** Where the moon's plane hangs on the sky, and its side there, as shares of the sky's radius. */
const MOON_SIDE = 0.09;

const OVERLAY_WGSL = /* wgsl */ `
${VIEW_WGSL}
${CAMERA_BINDINGS_WGSL}
struct Overlay {
  starOpacity: f32,
  starTime: f32,
  moonOpacity: f32,
  boltBrightness: f32,
  moonDirection: vec3f,
  coverage: f32,
  moonRight: vec3f,
  storm: f32,
  moonUp: vec3f,
  light: f32,
  sunDirection: vec3f,
  flash: f32,
  sunColor: vec3f,
  offsetX: f32,
  horizon: vec3f,
  offsetY: f32,
  shade: vec3f,
}
@group(1) @binding(0) var<uniform> overlay: Overlay;

// A direction's place on the screen, at the far plane: reversed depth makes that 0.
fn atInfinity(direction: vec3f) -> vec4f {
  let m = view.viewMatrix;
  var clip = view.projection * vec4f(mat3x3f(m[0].xyz, m[1].xyz, m[2].xyz) * direction, 1.0);
  clip.z = 0.0;
  return clip;
}

fn viewDirection(uv: vec2f) -> vec3f {
  let p = view.inverseProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.5, 1.0);
  let local = p.xyz / p.w;
  let m = view.viewMatrix;
  return normalize(vec3f(dot(m[0].xyz, local), dot(m[1].xyz, local), dot(m[2].xyz, local)));
}

fn cornerOf(index: u32) -> vec2f {
  switch (index) {
    case 0u: { return vec2f(-1.0, -1.0); }
    case 1u: { return vec2f(1.0, -1.0); }
    case 2u: { return vec2f(-1.0, 1.0); }
    case 3u: { return vec2f(-1.0, 1.0); }
    case 4u: { return vec2f(1.0, -1.0); }
    default: { return vec2f(1.0, 1.0); }
  }
}

// Stars.
struct StarIn {
  @builtin(vertex_index) index: u32,
  @location(0) position: vec3f,
  @location(1) size: f32,
  @location(2) brightness: f32,
}
struct StarOut {
  @builtin(position) clip: vec4f,
  @location(0) corner: vec2f,
  @location(1) brightness: f32,
}
@vertex fn starVertex(in: StarIn) -> StarOut {
  var out: StarOut;
  out.corner = cornerOf(in.index);
  out.brightness = in.brightness * (0.75 + 0.25 * sin(overlay.starTime * (1.5 + in.brightness * 3.0) + in.position.x * 0.37));
  out.clip = atInfinity(in.position);
  // The size is the star's whole width in pixels.
  out.clip = vec4f(out.clip.xy + out.corner * in.size * view.size.zw * out.clip.w, out.clip.zw);
  return out;
}
@fragment fn starFragment(in: StarOut) -> @location(0) vec4f {
  let glow = 1.0 - smoothstep(0.0, 1.0, length(in.corner));
  return vec4f(vec3f(0.9, 0.94, 1.0) * glow * in.brightness * overlay.starOpacity, 1.0);
}

// The moon.
struct MoonOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
}
@vertex fn moonVertex(@builtin(vertex_index) index: u32) -> MoonOut {
  let corner = cornerOf(index);
  var out: MoonOut;
  out.uv = corner * 0.5 + 0.5;
  out.clip = atInfinity(overlay.moonDirection + (overlay.moonRight * corner.x + overlay.moonUp * corner.y) * ${(MOON_SIDE / 2).toFixed(4)});
  return out;
}
fn moonHash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453); }
fn moonNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(moonHash(i), moonHash(i + vec2f(1.0, 0.0)), u.x), mix(moonHash(i + vec2f(0.0, 1.0)), moonHash(i + vec2f(1.0, 1.0)), u.x), u.y);
}
@fragment fn moonFragment(in: MoonOut) -> @location(0) vec4f {
  let p = in.uv * 2.0 - 1.0;
  let r = length(p);
  // The disc, its grey seas, and a glow round it.
  let disc = 1.0 - smoothstep(0.33, 0.36, r);
  let seas = moonNoise(p * 4.0) * 0.6 + moonNoise(p * 9.0) * 0.4;
  let surface = vec3f(0.95, 0.96, 1.0) * (0.78 + 0.22 * smoothstep(0.35, 0.7, seas)) * 2.2;
  let halo = exp(-max(r - 0.3, 0.0) * 6.0) * 0.25 * (1.0 - disc);
  let colour = surface * disc + vec3f(0.6, 0.7, 0.9) * halo;
  return vec4f(colour * overlay.moonOpacity, 1.0);
}

// The flat cloud layer.
${FULLSCREEN_WGSL}
fn cloudHash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn cloudNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(cloudHash(i), cloudHash(i + vec2f(1.0, 0.0)), u.x), mix(cloudHash(i + vec2f(0.0, 1.0)), cloudHash(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn cloudFbm(input: vec2f) -> f32 {
  var p = input;
  var sum = 0.0;
  var amplitude = 0.5;
  let turn = mat2x2f(0.8, 0.6, -0.6, 0.8);
  for (var i = 0; i < 5; i++) {
    sum += cloudNoise(p) * amplitude;
    p = turn * p * 2.03 + vec2f(3.1);
    amplitude *= 0.5;
  }
  return sum / 0.97;
}
@fragment fn flatCloudFragment(in: FullscreenOut) -> @location(0) vec4f {
  let direction = viewDirection(in.uv);
  // Below the horizon, a heavy sky closes in as haze, where the sky's own bright horizon would show.
  if (direction.y <= 0.0) {
    let closed = smoothstep(0.55, 0.95, overlay.coverage);
    if (closed < 0.002) { discard; }
    return vec4f(overlay.horizon + overlay.flash * vec3f(0.2, 0.22, 0.26), closed);
  }
  // The clouds lie on a plane overhead: further off, they crowd toward the horizon.
  let uv = direction.xz / (direction.y + 0.1) * 1.4 + vec2f(overlay.offsetX, overlay.offsetY);
  let shape = cloudFbm(uv * 0.55) * 0.72 + cloudFbm(uv * 2.1 + vec2f(11.0)) * 0.28;
  let threshold = mix(0.95, -0.15, pow(overlay.coverage, 0.85));
  let density = smoothstep(threshold, threshold + 0.28, shape);
  if (density < 0.002) { discard; }
  let thickness = smoothstep(threshold, threshold + 0.55, shape);

  // Thin edges take the sun, thick cores are grey, darker in a storm; toward the sun they glow.
  let sunward = pow(max(dot(direction, overlay.sunDirection), 0.0), 8.0);
  let lit = overlay.sunColor * (1.0 + 1.4 * sunward) + overlay.shade * 0.35;
  var colour = mix(lit, overlay.shade, clamp(thickness * (0.55 + 0.45 * overlay.storm), 0.0, 1.0)) * overlay.light;
  colour += overlay.flash * vec3f(0.75, 0.82, 1.0) * (0.5 + 0.8 * thickness);
  // Low down they fade into the haze at the horizon.
  colour = mix(colour, overlay.horizon, (1.0 - smoothstep(0.0, 0.3, direction.y)) * 0.75);
  let closing = smoothstep(0.55, 0.95, overlay.coverage);
  let alpha = mix(density * smoothstep(0.0, 0.05, direction.y), max(density, closing), closing * (1.0 - smoothstep(0.0, 0.3, direction.y)));
  return vec4f(colour, alpha);
}

// Lightning.
struct BoltIn {
  @location(0) position: vec3f,
  @location(1) edge: f32,
}
struct BoltOut {
  @builtin(position) clip: vec4f,
  @location(0) edge: f32,
}
@vertex fn boltVertex(in: BoltIn) -> BoltOut {
  var out: BoltOut;
  out.edge = in.edge;
  out.clip = atInfinity(in.position);
  return out;
}
@fragment fn boltFragment(in: BoltOut) -> @location(0) vec4f {
  let core = 1.0 - abs(in.edge);
  let colour = vec3f(0.75, 0.82, 1.0) * (core * core * 6.0 + core * 1.5) * overlay.boltBrightness;
  return vec4f(colour, 1.0);
}
`;

const ADDITIVE: GPUBlendState = {
  color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
  alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
};

const NORMAL: GPUBlendState = {
  color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
  alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
};

const _moonRight = new THREE.Vector3();
const _moonUp = new THREE.Vector3();
const _toward = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

interface OverlayPipelines {
  stars: GPURenderPipeline;
  moon: GPURenderPipeline;
  flatClouds: GPURenderPipeline;
  bolt: GPURenderPipeline;
  group: GPUBindGroup;
}

export class SkyOverlay {
  private readonly buffer: GPUBuffer;
  private readonly data = new Float32Array(OVERLAY_BYTES / 4);
  private pipelines: OverlayPipelines | null = null;
  private starSource: Float32Array | null = null;
  private starBuffer: GPUBuffer | null = null;
  private starCount = 0;
  private boltVertices: GPUBuffer | null = null;
  private boltIndices: GPUBuffer | null = null;
  private boltIndexCount = 0;
  private boltVersion = -1;
  private boltInterleaved: Float32Array | null = null;

  constructor(private readonly device: GPUDevice) {
    this.buffer = device.createBuffer({ label: "sky overlay", size: OVERLAY_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  private ensurePipelines(cameraLayout: GPUBindGroupLayout): OverlayPipelines {
    if (this.pipelines) return this.pipelines;
    const { device } = this;
    const module = device.createShaderModule({ label: "sky overlay", code: OVERLAY_WGSL });
    const overlayLayout = device.createBindGroupLayout({
      label: "sky overlay",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
    });
    const layout = device.createPipelineLayout({ label: "sky overlay", bindGroupLayouts: [cameraLayout, overlayLayout] });
    const pipeline = (label: string, vertexEntry: string, fragmentEntry: string, blend: GPUBlendState, buffers: GPUVertexBufferLayout[] = []): GPURenderPipeline => device.createRenderPipeline({
      label,
      layout,
      vertex: { module, entryPoint: vertexEntry, buffers },
      fragment: { module, entryPoint: fragmentEntry, targets: [{ format: TARGET_FORMATS.hdr, blend }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: TARGET_FORMATS.depth, depthWriteEnabled: false, depthCompare: "greater-equal" },
    });
    this.pipelines = {
      stars: pipeline("sky stars", "starVertex", "starFragment", ADDITIVE, [{
        arrayStride: 20,
        stepMode: "instance",
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" },
          { shaderLocation: 1, offset: 12, format: "float32" },
          { shaderLocation: 2, offset: 16, format: "float32" },
        ],
      }]),
      moon: pipeline("sky moon", "moonVertex", "moonFragment", ADDITIVE),
      flatClouds: pipeline("sky flat clouds", "fullscreenVertex", "flatCloudFragment", NORMAL),
      bolt: pipeline("sky bolt", "boltVertex", "boltFragment", ADDITIVE, [{
        arrayStride: 16,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" },
          { shaderLocation: 1, offset: 12, format: "float32" },
        ],
      }]),
      group: device.createBindGroup({ label: "sky overlay", layout: overlayLayout, entries: [{ binding: 0, resource: { buffer: this.buffer } }] }),
    };
    return this.pipelines;
  }

  private ensureStars(night: GpuNightSky): void {
    if (this.starSource === night.starPositions && this.starBuffer) return;
    this.starSource = night.starPositions;
    this.starBuffer?.destroy();
    const count = night.starPositions.length / 3;
    const data = new Float32Array(count * 5);
    for (let index = 0; index < count; index++) {
      data[index * 5] = night.starPositions[index * 3];
      data[index * 5 + 1] = night.starPositions[index * 3 + 1];
      data[index * 5 + 2] = night.starPositions[index * 3 + 2];
      data[index * 5 + 3] = night.starSizes[index];
      data[index * 5 + 4] = night.starBrightness[index];
    }
    this.starBuffer = this.device.createBuffer({ label: "sky stars", size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.starBuffer, 0, data);
    this.starCount = count;
  }

  private ensureBolt(bolt: GpuBolt): void {
    const { device } = this;
    const vertexCount = bolt.positions.length / 3;
    if (!this.boltVertices || this.boltVertices.size !== vertexCount * 16) {
      this.boltVertices?.destroy();
      this.boltVertices = device.createBuffer({ label: "sky bolt", size: vertexCount * 16, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      this.boltInterleaved = new Float32Array(vertexCount * 4);
      this.boltVersion = -1;
    }
    if (!this.boltIndices) {
      const indices = Uint32Array.from(bolt.indices as ArrayLike<number>);
      this.boltIndices = device.createBuffer({ label: "sky bolt indices", size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(this.boltIndices, 0, indices);
      this.boltIndexCount = indices.length;
    }
    if (bolt.version === this.boltVersion) return;
    this.boltVersion = bolt.version;
    const data = this.boltInterleaved!;
    for (let index = 0; index < vertexCount; index++) {
      data[index * 4] = bolt.positions[index * 3];
      data[index * 4 + 1] = bolt.positions[index * 3 + 1];
      data[index * 4 + 2] = bolt.positions[index * 3 + 2];
      data[index * 4 + 3] = bolt.edges[index];
    }
    device.queue.writeBuffer(this.boltVertices, 0, data);
  }

  private writeUniforms(night: GpuNightSky | null, flat: GpuFlatClouds | null, bolt: GpuBolt | null): void {
    const { data } = this;
    if (night) {
      data[0] = night.starOpacity;
      data[1] = night.starTime;
      data[2] = night.moonOpacity;
      // The plane faces the camera, the right way up.
      _toward.copy(night.moonDirection).negate();
      _moonRight.crossVectors(WORLD_UP, _toward).normalize();
      _moonUp.crossVectors(_toward, _moonRight);
      data[4] = night.moonDirection.x;
      data[5] = night.moonDirection.y;
      data[6] = night.moonDirection.z;
      data[8] = _moonRight.x;
      data[9] = _moonRight.y;
      data[10] = _moonRight.z;
      data[12] = _moonUp.x;
      data[13] = _moonUp.y;
      data[14] = _moonUp.z;
    }
    if (bolt) data[3] = bolt.brightness;
    if (flat) {
      data[7] = flat.coverage;
      data[11] = flat.storm;
      data[15] = flat.light;
      data[16] = flat.sunDirection.x;
      data[17] = flat.sunDirection.y;
      data[18] = flat.sunDirection.z;
      data[19] = flat.flash;
      data[20] = flat.sunColor.r;
      data[21] = flat.sunColor.g;
      data[22] = flat.sunColor.b;
      data[23] = flat.offset.x;
      data[24] = flat.horizon.r;
      data[25] = flat.horizon.g;
      data[26] = flat.horizon.b;
      data[27] = flat.offset.y;
      data[28] = flat.shade.r;
      data[29] = flat.shade.g;
      data[30] = flat.shade.b;
    }
    this.device.queue.writeBuffer(this.buffer, 0, data);
  }

  /** Draws what the sky has on it, over the HDR target where the depth says there is only sky. */
  draw(frame: GpuFrame, settings: GpuSkySettings): void {
    const night = settings.night;
    const flat = settings.flatClouds;
    const bolt = settings.bolt;
    const showStars = !!night && night.starOpacity > 0.01;
    const showMoon = !!night && night.moonOpacity > 0.01;
    if (!showStars && !showMoon && !flat && !bolt) return;
    if ((frame.camera as THREE.PerspectiveCamera).isPerspectiveCamera !== true) return;
    const pipelines = this.ensurePipelines(frame.cameraLayout);
    this.writeUniforms(night, flat, bolt);
    if (night && showStars) this.ensureStars(night);
    if (bolt) this.ensureBolt(bolt);

    const pass = frame.encoder.beginRenderPass({
      label: "sky overlay",
      colorAttachments: [{ view: frame.targets.hdr.view, loadOp: "load", storeOp: "store" }],
      depthStencilAttachment: { view: frame.targets.depth.view, depthReadOnly: true },
    });
    pass.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    pass.setBindGroup(1, pipelines.group);
    if (showStars && this.starBuffer) {
      pass.setPipeline(pipelines.stars);
      pass.setVertexBuffer(0, this.starBuffer);
      pass.draw(6, this.starCount);
    }
    if (showMoon) {
      pass.setPipeline(pipelines.moon);
      pass.draw(6);
    }
    if (flat) {
      pass.setPipeline(pipelines.flatClouds);
      pass.draw(3);
    }
    if (bolt && this.boltVertices && this.boltIndices) {
      pass.setPipeline(pipelines.bolt);
      pass.setVertexBuffer(0, this.boltVertices);
      pass.setIndexBuffer(this.boltIndices, "uint32");
      pass.drawIndexed(this.boltIndexCount);
    }
    pass.end();
  }

  dispose(): void {
    this.buffer.destroy();
    this.starBuffer?.destroy();
    this.boltVertices?.destroy();
    this.boltIndices?.destroy();
  }
}

