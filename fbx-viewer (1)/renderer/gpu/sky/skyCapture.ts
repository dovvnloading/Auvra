/// <reference types="@webgpu/types" />
import * as THREE from "three";
import type { SkyFrame } from "../../../components/Environment/sky/SkyRenderer";
import type { GpuFrame } from "../frame";
import { DOME_BYTES, domeBindGroupLayout, DomeBindings, domeWgsl, writeDome } from "./dome";
import type { AtmosphereTables } from "./atmosphereTables";
import type { CloudMap } from "./cloudMap";
import type { GpuRigPanel, GpuSkyCapture, SkyEnvironmentProduct } from "./skySettings";

/**
 * THE SKY LIGHT
 *
 * The sky as image-based light: drawn into a cube by compute, its specular mips prefiltered by importance sampling a
 * GGX lobe, and its diffuse light projected onto nine spherical-harmonic coefficients. A capture is spread over several
 * frames, one prefiltered mip a frame, into a second cube, so what lighting reads is always a whole capture. The very
 * first one, or the first of a new kind of source, is done at once so a level never starts in the dark.
 */

const WORKGROUP = 8;
const NEUTRAL_RESOLUTION = 32;
/** The diffuse projection reads a mip about this size: the sky's broad light is all it needs. */
const HARMONICS_SIZE = 32;
/** Rays per texel of a prefiltered mip. */
const PREFILTER_SAMPLES = 64;
const RIG_BYTES = 288;
const PREFILTER_BYTES = 16;
const HARMONICS_BYTES = 9 * 16;
/** The dim gradient of a level with nothing else to light it, radiance at the bottom and top of the sky. */
const NEUTRAL_LOW = 0.06;
const NEUTRAL_HIGH = 0.18;

const FACE_WGSL = /* wgsl */ `
// The world direction through a texel of a cube's face, as a cube is sampled.
fn faceDirection(face: u32, uv: vec2f) -> vec3f {
  let a = uv.x * 2.0 - 1.0;
  let b = uv.y * 2.0 - 1.0;
  switch (face) {
    case 0u: { return normalize(vec3f(1.0, -b, -a)); }
    case 1u: { return normalize(vec3f(-1.0, -b, a)); }
    case 2u: { return normalize(vec3f(a, 1.0, b)); }
    case 3u: { return normalize(vec3f(a, -1.0, -b)); }
    case 4u: { return normalize(vec3f(a, -b, 1.0)); }
    default: { return normalize(vec3f(-a, -b, -1.0)); }
  }
}
`;

const CAPTURE_SKY_WGSL = /* wgsl */ `
${domeWgsl(0)}
${FACE_WGSL}
@group(1) @binding(0) var faces: texture_storage_2d_array<rgba16float, write>;

@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP}, 1) fn captureSky(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(faces);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let direction = faceDirection(id.z, (vec2f(id.xy) + 0.5) / vec2f(size));
  textureStore(faces, id.xy, id.z, vec4f(domeCaptureColour(direction), 1.0));
}
`;

const CAPTURE_RIG_WGSL = /* wgsl */ `
${FACE_WGSL}
struct Panel {
  position: vec3f,
  halfWidth: f32,
  across: vec3f,
  halfHeight: f32,
  upward: vec3f,
  facing: vec3f,
  colour: vec3f,
}
struct Rig {
  low: vec3f,
  high: vec3f,
  count: u32,
  panels: array<Panel, 3>,
}
@group(0) @binding(0) var<uniform> rig: Rig;
@group(0) @binding(1) var faces: texture_storage_2d_array<rgba16float, write>;

// The soft panels of the plain lighting rig, whichever a direction meets first, over a gentle gradient.
@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP}, 1) fn captureRig(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(faces);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let direction = faceDirection(id.z, (vec2f(id.xy) + 0.5) / vec2f(size));
  var colour = mix(rig.low, rig.high, direction.y * 0.5 + 0.5);
  var nearest = 1e9;
  for (var i = 0u; i < rig.count; i++) {
    let panel = rig.panels[i];
    let cosine = dot(direction, panel.facing);
    if (cosine >= 0.0) { continue; }
    let t = dot(panel.position, panel.facing) / cosine;
    if (t <= 0.0 || t >= nearest) { continue; }
    let local = direction * t - panel.position;
    if (abs(dot(local, panel.across)) <= panel.halfWidth && abs(dot(local, panel.upward)) <= panel.halfHeight) {
      colour = panel.colour;
      nearest = t;
    }
  }
  textureStore(faces, id.xy, id.z, vec4f(colour, 1.0));
}
`;

const CUBE_MIP_WGSL = /* wgsl */ `
@group(0) @binding(0) var above: texture_2d_array<f32>;
@group(0) @binding(1) var below: texture_storage_2d_array<rgba16float, write>;

@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP}, 1) fn cubeMip(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(below);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy) * 2;
  let layer = i32(id.z);
  let sum = textureLoad(above, p, layer, 0)
    + textureLoad(above, p + vec2i(1, 0), layer, 0)
    + textureLoad(above, p + vec2i(0, 1), layer, 0)
    + textureLoad(above, p + vec2i(1, 1), layer, 0);
  textureStore(below, id.xy, id.z, sum * 0.25);
}
`;

const PREFILTER_WGSL = /* wgsl */ `
const FILTER_PI = 3.14159265358979;
${FACE_WGSL}
struct Prefilter {
  roughness: f32,
  sourceSize: f32,
  gain: f32,
  samples: u32,
}
@group(0) @binding(0) var<uniform> filterStep: Prefilter;
@group(0) @binding(1) var sourceCube: texture_cube<f32>;
@group(0) @binding(2) var cubeSampler: sampler;
@group(0) @binding(3) var faces: texture_storage_2d_array<rgba16float, write>;

fn hammersley(i: u32, count: u32) -> vec2f {
  return vec2f(f32(i) / f32(count), f32(reverseBits(i)) * 2.3283064365386963e-10);
}

// A mirror's view straight along the normal, so each ray's reflection is sampled from a GGX lobe round it. Rays are read
// from a blurrier mip the less likely they are, so a few of them cover the lobe without leaving bright sparks behind.
@compute @workgroup_size(4, 4, 1) fn prefilter(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(faces);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let n = faceDirection(id.z, (vec2f(id.xy) + 0.5) / vec2f(size));
  if (filterStep.roughness <= 0.0) {
    textureStore(faces, id.xy, id.z, vec4f(textureSampleLevel(sourceCube, cubeSampler, n, 0.0).rgb * filterStep.gain, 1.0));
    return;
  }
  let helper = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(n.z) < 0.999);
  let tangent = normalize(cross(helper, n));
  let bitangent = cross(n, tangent);
  let alpha = filterStep.roughness * filterStep.roughness;
  let alpha2 = alpha * alpha;
  let texelAngle = 4.0 * FILTER_PI / (6.0 * filterStep.sourceSize * filterStep.sourceSize);
  var sum = vec3f(0.0);
  var total = 0.0;
  for (var i = 0u; i < filterStep.samples; i++) {
    let xi = hammersley(i, filterStep.samples);
    let phi = 2.0 * FILTER_PI * xi.x;
    let cosTheta = sqrt((1.0 - xi.y) / (1.0 + (alpha2 - 1.0) * xi.y));
    let sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
    let h = normalize(tangent * (cos(phi) * sinTheta) + bitangent * (sin(phi) * sinTheta) + n * cosTheta);
    let l = reflect(-n, h);
    let cosine = dot(n, l);
    if (cosine <= 0.0) { continue; }
    let d = cosTheta * cosTheta * (alpha2 - 1.0) + 1.0;
    // With the view along the normal, the half vector's cosines to both are the same and the lobe's density is D / 4.
    let density = alpha2 / (FILTER_PI * d * d) * 0.25;
    let rayAngle = 1.0 / (f32(filterStep.samples) * max(density, 1e-6));
    let lod = max(0.5 * log2(rayAngle / texelAngle), 0.0);
    sum += textureSampleLevel(sourceCube, cubeSampler, l, lod).rgb * cosine;
    total += cosine;
  }
  textureStore(faces, id.xy, id.z, vec4f(sum / max(total, 1e-4) * filterStep.gain, 1.0));
}
`;

const HARMONICS_WGSL = /* wgsl */ `
const SPHERE_ANGLE = 12.566370614359172;
${FACE_WGSL}
@group(0) @binding(0) var source: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> coefficients: array<vec4f, 9>;

// The cube's light onto the first nine spherical harmonics, each texel by the part of the sphere it covers.
@compute @workgroup_size(1) fn harmonics() {
  let size = textureDimensions(source);
  var sums: array<vec3f, 9>;
  var weight = 0.0;
  for (var face = 0u; face < 6u; face++) {
    for (var y = 0u; y < size.y; y++) {
      for (var x = 0u; x < size.x; x++) {
        let uv = (vec2f(f32(x), f32(y)) + 0.5) / vec2f(size);
        let a = uv.x * 2.0 - 1.0;
        let b = uv.y * 2.0 - 1.0;
        let rr = 1.0 + a * a + b * b;
        let angle = 4.0 / (f32(size.x) * f32(size.y) * rr * sqrt(rr));
        let n = faceDirection(face, uv);
        let light = textureLoad(source, vec2u(x, y), face, 0).rgb * angle;
        sums[0] += light * 0.282095;
        sums[1] += light * (0.488603 * n.y);
        sums[2] += light * (0.488603 * n.z);
        sums[3] += light * (0.488603 * n.x);
        sums[4] += light * (1.092548 * n.x * n.y);
        sums[5] += light * (1.092548 * n.y * n.z);
        sums[6] += light * (0.315392 * (3.0 * n.z * n.z - 1.0));
        sums[7] += light * (1.092548 * n.x * n.z);
        sums[8] += light * (0.546274 * (n.x * n.x - n.y * n.y));
        weight += angle;
      }
    }
  }
  let scale = SPHERE_ANGLE / weight;
  for (var i = 0; i < 9; i++) {
    coefficients[i] = vec4f(sums[i] * scale, 0.0);
  }
}
`;

const log2Of = (size: number): number => Math.round(Math.log2(size));

const NEUTRAL_RIG: GpuRigPanel[] = [];

/** A cube and its mips, with what writes each. */
interface CubeSet {
  resolution: number;
  raw: GPUTexture;
  rawMips: number;
  rawLayers: GPUTextureView;
  mipGroups: GPUBindGroup[];
  specular: [GPUTexture, GPUTexture];
  specularMips: number;
  specularViews: [GPUTextureView, GPUTextureView];
  /** By which of the two cubes, then by mip. */
  prefilterGroups: [GPUBindGroup[], GPUBindGroup[]];
  prefilterBuffers: GPUBuffer[];
  harmonicsGroup: GPUBindGroup;
}

interface CaptureJob {
  set: CubeSet;
  /** The cube being filled. */
  back: 0 | 1;
  nextMip: number;
  gain: number;
  sky: boolean;
  /** The set this one takes over from, freed when it does. */
  replaces: CubeSet | null;
}

export interface CaptureSky {
  frame: SkyFrame;
  tables: AtmosphereTables;
  clouds: CloudMap;
}

export class SkyCapture {
  private readonly device: GPUDevice;
  private readonly sampler: GPUSampler;
  private readonly domeLayout: GPUBindGroupLayout;
  private readonly facesLayout: GPUBindGroupLayout;
  private readonly domeBuffer: GPUBuffer;
  private readonly domeData = new Float32Array(DOME_BYTES / 4);
  private readonly domeBindings: DomeBindings;
  private readonly rigBuffer: GPUBuffer;
  private readonly rigData = new Float32Array(RIG_BYTES / 4);
  private readonly rigWords = new Uint32Array(this.rigData.buffer);
  private readonly harmonicsBuffer: GPUBuffer;

  private readonly skyPipeline: GPUComputePipeline;
  private readonly rigPipeline: GPUComputePipeline;
  private readonly mipPipeline: GPUComputePipeline;
  private readonly prefilterPipeline: GPUComputePipeline;
  private readonly harmonicsPipeline: GPUComputePipeline;

  private set: CubeSet | null = null;
  private job: CaptureJob | null = null;
  private front: 0 | 1 = 0;
  private seenRequest = -1;
  private seenSource: GpuSkyCapture["source"] | null = null;
  private readonly staging: GPUBuffer[] = [];
  private readonly readable: GPUBuffer[] = [];
  /** The coefficients as captured, and at this frame's strength. */
  private readonly harmonics = new Float32Array(27);
  private readonly scaled = new Float32Array(27);
  private disposed = false;

  /** Published as "environment"; a new object when a capture finishes. */
  product: SkyEnvironmentProduct | null = null;
  /** A capture of the sky itself is in the cube. */
  hasSkyCapture = false;

  constructor(device: GPUDevice) {
    this.device = device;
    this.sampler = device.createSampler({ label: "sky environment", magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });
    this.domeLayout = domeBindGroupLayout(device);
    this.facesLayout = device.createBindGroupLayout({
      label: "sky cube faces",
      entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float", viewDimension: "2d-array" } }],
    });
    this.domeBuffer = device.createBuffer({ label: "sky capture dome", size: DOME_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.domeBindings = new DomeBindings(device, this.domeLayout, this.domeBuffer);
    this.rigBuffer = device.createBuffer({ label: "sky capture rig", size: RIG_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.harmonicsBuffer = device.createBuffer({ label: "sky harmonics", size: HARMONICS_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });

    const compute = (label: string, code: string, entryPoint: string, layout: GPUPipelineLayout | "auto"): GPUComputePipeline => device.createComputePipeline({
      label,
      layout,
      compute: { module: device.createShaderModule({ label, code }), entryPoint },
    });
    this.skyPipeline = compute("sky capture", CAPTURE_SKY_WGSL, "captureSky", device.createPipelineLayout({ bindGroupLayouts: [this.domeLayout, this.facesLayout] }));
    this.rigPipeline = compute("sky capture rig", CAPTURE_RIG_WGSL, "captureRig", "auto");
    this.mipPipeline = compute("sky cube mips", CUBE_MIP_WGSL, "cubeMip", "auto");
    this.prefilterPipeline = compute("sky prefilter", PREFILTER_WGSL, "prefilter", "auto");
    this.harmonicsPipeline = compute("sky harmonics", HARMONICS_WGSL, "harmonics", "auto");

    // Dim and neutral until something is captured: what the gradient below comes to, from a straight sum.
    this.harmonics[0] = this.harmonics[1] = this.harmonics[2] = ((NEUTRAL_LOW + NEUTRAL_HIGH) / 2) * 3.544908;
    this.harmonics[3] = this.harmonics[4] = this.harmonics[5] = ((NEUTRAL_HIGH - NEUTRAL_LOW) / 2) * 2.046653;
  }

  private makeSet(resolution: number): CubeSet {
    const { device } = this;
    const rawMips = log2Of(resolution) + 1;
    const specularMips = Math.max(2, log2Of(resolution) - 1);
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;
    const raw = device.createTexture({ label: "sky capture", size: [resolution, resolution, 6], format: "rgba16float", mipLevelCount: rawMips, usage });
    const layers = (texture: GPUTexture, mip: number) => texture.createView({ dimension: "2d-array", baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 6 });
    const rawCube = raw.createView({ dimension: "cube" });
    const makeSpecular = (label: string) => device.createTexture({ label, size: [resolution, resolution, 6], format: "rgba16float", mipLevelCount: specularMips, usage });
    const specular: [GPUTexture, GPUTexture] = [makeSpecular("sky specular a"), makeSpecular("sky specular b")];
    const mipGroups: GPUBindGroup[] = [];
    for (let mip = 1; mip < rawMips; mip++) {
      mipGroups.push(device.createBindGroup({
        label: "sky cube mip",
        layout: this.mipPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: layers(raw, mip - 1) },
          { binding: 1, resource: layers(raw, mip) },
        ],
      }));
    }
    const prefilterBuffers: GPUBuffer[] = [];
    for (let mip = 0; mip < specularMips; mip++) {
      prefilterBuffers.push(device.createBuffer({ label: "sky prefilter step", size: PREFILTER_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    }
    const prefilterGroupsFor = (texture: GPUTexture) => prefilterBuffers.map((buffer, mip) => device.createBindGroup({
      label: "sky prefilter",
      layout: this.prefilterPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer } },
        { binding: 1, resource: rawCube },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: layers(texture, mip) },
      ],
    }));
    const harmonicsMip = Math.max(0, log2Of(resolution) - log2Of(HARMONICS_SIZE));
    return {
      resolution,
      raw,
      rawMips,
      rawLayers: layers(raw, 0),
      mipGroups,
      specular,
      specularMips,
      specularViews: [specular[0].createView({ dimension: "cube" }), specular[1].createView({ dimension: "cube" })],
      prefilterGroups: [prefilterGroupsFor(specular[0]), prefilterGroupsFor(specular[1])],
      prefilterBuffers,
      harmonicsGroup: device.createBindGroup({
        label: "sky harmonics",
        layout: this.harmonicsPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: layers(raw, harmonicsMip) },
          { binding: 1, resource: { buffer: this.harmonicsBuffer } },
        ],
      }),
    };
  }

  private freeSet(set: CubeSet): void {
    set.raw.destroy();
    set.specular[0].destroy();
    set.specular[1].destroy();
    for (const buffer of set.prefilterBuffers) buffer.destroy();
  }

  private writeRig(panels: readonly GpuRigPanel[], low: number, high: number): void {
    const data = this.rigData;
    data.fill(0);
    data[0] = data[1] = data[2] = low;
    data[4] = data[5] = data[6] = high;
    const count = Math.min(panels.length, 3);
    this.rigWords[7] = count;
    panels.slice(0, 3).forEach((panel, index) => {
      const at = 8 + index * 20;
      const position = _position.set(panel.position[0], panel.position[1], panel.position[2]);
      // Each turned to face the middle, as it hangs in the rig.
      _facing.copy(position).negate().normalize();
      _across.crossVectors(WORLD_UP, _facing).normalize();
      _upward.crossVectors(_facing, _across);
      data[at] = position.x;
      data[at + 1] = position.y;
      data[at + 2] = position.z;
      data[at + 3] = panel.scale[0] / 2;
      data[at + 4] = _across.x;
      data[at + 5] = _across.y;
      data[at + 6] = _across.z;
      data[at + 7] = panel.scale[1] / 2;
      data[at + 8] = _upward.x;
      data[at + 9] = _upward.y;
      data[at + 10] = _upward.z;
      data[at + 12] = _facing.x;
      data[at + 13] = _facing.y;
      data[at + 14] = _facing.z;
      data[at + 16] = panel.color.r * panel.intensity;
      data[at + 17] = panel.color.g * panel.intensity;
      data[at + 18] = panel.color.b * panel.intensity;
    });
    this.device.queue.writeBuffer(this.rigBuffer, 0, data);
  }

  /** Into the raw cube, with its mips and the diffuse projection. */
  private captureFaces(frame: GpuFrame, set: CubeSet, request: GpuSkyCapture, sky: CaptureSky | null): void {
    const { device } = this;
    const source = request.source;
    const fromDome = (source === "sky" || source === "image") && !!sky;
    let domeGroup: GPUBindGroup | null = null;
    if (fromDome && sky) {
      const imageEntry = source === "image" ? frame.textures.acquire(request.image) : null;
      const image = source === "image";
      const panorama = image ? imageEntry : frame.textures.acquire(sky.frame.panorama);
      const usePanorama = !!panorama;
      // The image alone: the sky's own clouds are not in it.
      const cloudsOn = !image && sky.clouds.showing;
      writeDome(this.domeData, sky.frame, {
        viewRadius: sky.tables.viewRadius,
        cloudsOn,
        cloudTexel: sky.clouds.texel,
        panoramaOn: usePanorama,
        tint: request.tint,
        noFlatCover: image,
        lowerSolid: request.lowerSolid,
        lower: request.lower,
      });
      device.queue.writeBuffer(this.domeBuffer, 0, this.domeData);
      domeGroup = this.domeBindings.groupFor(
        sky.tables.skyView.view,
        sky.tables.transmittance.view,
        sky.clouds.view ?? frame.textures.black.view,
        panorama?.view ?? frame.textures.black.view,
        sky.tables.skyViewSampler,
        sky.tables.clampSampler,
        panorama?.sampler ?? sky.tables.clampSampler,
      );
    } else if (source === "rig") {
      this.writeRig(request.rig, 0, 0);
    } else {
      this.writeRig(NEUTRAL_RIG, NEUTRAL_LOW, NEUTRAL_HIGH);
    }

    const groups = Math.ceil(set.resolution / WORKGROUP);
    const pass = frame.encoder.beginComputePass({ label: "sky capture" });
    if (domeGroup) {
      pass.setPipeline(this.skyPipeline);
      pass.setBindGroup(0, domeGroup);
      pass.setBindGroup(1, device.createBindGroup({ label: "sky cube faces", layout: this.facesLayout, entries: [{ binding: 0, resource: set.rawLayers }] }));
    } else {
      pass.setPipeline(this.rigPipeline);
      pass.setBindGroup(0, device.createBindGroup({
        label: "sky capture rig",
        layout: this.rigPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.rigBuffer } },
          { binding: 1, resource: set.rawLayers },
        ],
      }));
    }
    pass.dispatchWorkgroups(groups, groups, 6);

    pass.setPipeline(this.mipPipeline);
    set.mipGroups.forEach((group, index) => {
      pass.setBindGroup(0, group);
      const size = Math.max(1, set.resolution >> (index + 1));
      const mipGroups = Math.ceil(size / WORKGROUP);
      pass.dispatchWorkgroups(mipGroups, mipGroups, 6);
    });

    pass.setPipeline(this.harmonicsPipeline);
    pass.setBindGroup(0, set.harmonicsGroup);
    pass.dispatchWorkgroups(1);
    pass.end();

    // Read back once this frame's commands have gone: see readBack.
    const staging = this.staging.pop() ?? device.createBuffer({ label: "sky harmonics read", size: HARMONICS_BYTES, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    frame.encoder.copyBufferToBuffer(this.harmonicsBuffer, 0, staging, 0, HARMONICS_BYTES);
    this.readable.push(staging);
  }

  private readBack(): void {
    // Buffers copied into last frame: their commands have been handed over by now.
    while (this.readable.length) {
      const staging = this.readable.shift()!;
      void staging.mapAsync(GPUMapMode.READ).then(() => {
        if (this.disposed) return;
        const words = new Float32Array(staging.getMappedRange());
        for (let index = 0; index < 9; index++) {
          this.harmonics[index * 3] = words[index * 4];
          this.harmonics[index * 3 + 1] = words[index * 4 + 1];
          this.harmonics[index * 3 + 2] = words[index * 4 + 2];
        }
        staging.unmap();
        this.staging.push(staging);
      }, () => undefined);
    }
  }

  private prefilterMips(frame: GpuFrame, job: CaptureJob, count: number): void {
    const { set } = job;
    const pass = frame.encoder.beginComputePass({ label: "sky prefilter" });
    pass.setPipeline(this.prefilterPipeline);
    for (let step = 0; step < count && job.nextMip < set.specularMips; step++) {
      const mip = job.nextMip++;
      const roughness = mip / (set.specularMips - 1);
      const words = new ArrayBuffer(PREFILTER_BYTES);
      const floats = new Float32Array(words);
      floats[0] = roughness;
      floats[1] = set.resolution;
      floats[2] = job.gain;
      new Uint32Array(words)[3] = PREFILTER_SAMPLES;
      this.device.queue.writeBuffer(set.prefilterBuffers[mip], 0, words);
      pass.setBindGroup(0, set.prefilterGroups[job.back][mip]);
      const groups = Math.ceil(Math.max(1, set.resolution >> mip) / 4);
      pass.dispatchWorkgroups(groups, groups, 6);
    }
    pass.end();
  }

  private finish(job: CaptureJob): void {
    this.set = job.set;
    this.front = job.back;
    if (job.replaces && job.replaces !== job.set) this.freeSet(job.replaces);
    if (job.sky) this.hasSkyCapture = true;
    this.product = {
      diffuseSH: this.scaled,
      specular: job.set.specularViews[job.back],
      specularMips: job.set.specularMips,
      sampler: this.sampler,
    };
    this.job = null;
  }

  /** Moves any capture on by a frame, and starts the one `request` asks for. Keeps the product's coefficients up to date. */
  update(frame: GpuFrame, request: GpuSkyCapture, sky: CaptureSky | null): void {
    this.readBack();
    const changed = request.request !== this.seenRequest || request.source !== this.seenSource;
    if (changed && !this.job) {
      this.seenRequest = request.request;
      const wasSky = this.seenSource === "sky" || this.seenSource === "image";
      this.seenSource = request.source;
      const isSky = request.source === "sky" || request.source === "image";
      if (!isSky) this.hasSkyCapture = false;
      const resolution = isSky || request.source === "rig" ? request.resolution : NEUTRAL_RESOLUTION;
      const current = this.set;
      const fits = current?.resolution === resolution;
      const set = fits && current ? current : this.makeSet(resolution);
      const back: 0 | 1 = fits ? (this.front === 0 ? 1 : 0) : 0;
      const job: CaptureJob = { set, back, nextMip: 0, gain: request.specularScale, sky: isSky, replaces: fits ? null : current };
      this.job = job;
      this.captureFaces(frame, set, request, sky);
      // At once when it would otherwise leave the level in the dark, or in other light than it asked for.
      const atOnce = !this.product || isSky !== wasSky;
      this.prefilterMips(frame, job, atOnce ? set.specularMips : 1);
    } else if (this.job) {
      this.prefilterMips(frame, this.job, 1);
    }
    if (this.job && this.job.nextMip >= this.job.set.specularMips) this.finish(this.job);
    const { harmonics, scaled } = this;
    const scale = request.diffuseScale;
    for (let index = 0; index < 27; index++) scaled[index] = harmonics[index] * scale;
  }

  dispose(): void {
    this.disposed = true;
    if (this.job && this.job.set !== this.set) this.freeSet(this.job.set);
    if (this.set) this.freeSet(this.set);
    this.set = null;
    this.job = null;
    this.domeBuffer.destroy();
    this.rigBuffer.destroy();
    this.harmonicsBuffer.destroy();
    for (const buffer of this.staging) buffer.destroy();
    for (const buffer of this.readable) buffer.destroy();
  }
}

const _position = new THREE.Vector3();
const _facing = new THREE.Vector3();
const _across = new THREE.Vector3();
const _upward = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** What a sky with nothing else to say captures: the dim neutral gradient. */
export const NEUTRAL_CAPTURE: GpuSkyCapture = {
  request: 0,
  source: "neutral",
  resolution: NEUTRAL_RESOLUTION,
  lowerSolid: false,
  lower: [0, 0, 0],
  tint: [1, 1, 1],
  image: null,
  rig: [],
  diffuseScale: 1,
  specularScale: 1,
};
