/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { TARGET_FORMATS, type GpuFrame } from "../frame";

/**
 * SKY VISIBILITY
 *
 * How much sky each place around the camera can see, which shuts the Sky Light out of what is covered. It looks straight
 * down at what casts shadows and, from the height of what stands highest at each spot, works out how much sky reaches
 * the top of it and how much reaches under it. It follows the camera in steps, and looks again every so often for what
 * has moved.
 */

const OVERHEAD_SIZE = 1024;
const MAP_SIZE = 512;
const OVERHEAD_FAR = 1000;
const OVERHEAD_LIFT = 500;
/** Seconds between looks for what has moved, however still the camera. */
const LOOK_AGAIN_AFTER = 1.5;
/** The map follows the camera in steps of its side over this. */
const FOLLOW_STEPS = 16;

const RAW_WGSL = /* wgsl */ `
struct Look {
  top: f32,
  depthRange: f32,
  texelMetres: f32,
  side: f32,
}
@group(0) @binding(0) var<uniform> look: Look;
@group(0) @binding(1) var overhead: texture_depth_2d;
@group(0) @binding(2) var rawOut: texture_storage_2d<rgba16float, write>;

// How far down the camera's range what stands here is, 0 at the camera: its depth is reversed.
fn depthAt(uv: vec2f) -> f32 {
  let size = vec2i(textureDimensions(overhead));
  let pixel = clamp(vec2i(uv * vec2f(size)), vec2i(0), size - vec2i(1));
  return 1.0 - textureLoad(overhead, pixel, 0);
}

fn heightAt(uv: vec2f) -> f32 {
  return look.top - depthAt(uv) * look.depthRange;
}

const DIRECTIONS = 12;
const STEPS = 9;

// R: how much sky reaches the top of what is there, G: how much reaches under it, from how open the place around it is;
// B: its height.
@compute @workgroup_size(8, 8) fn rawMain(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(rawOut);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let at = vec2f(id.xy) + 0.5;
  let uv = at / vec2f(size);
  // Nothing there at all: open to the sky.
  if (depthAt(uv) >= 0.9999) {
    textureStore(rawOut, id.xy, vec4f(1.0, 1.0, -1000.0, 1.0));
    return;
  }
  let here = heightAt(uv);
  var blocked = 0.0;
  var open = 0.0;
  var weightTotal = 0.0;
  // Turned and started differently per texel, so fixed radii leave no rings; the blur that follows evens this out.
  let jitter = fract(52.9829189 * fract(dot(at, vec2f(0.06711056, 0.00583715))));
  for (var d = 0; d < DIRECTIONS; d++) {
    let angle = (f32(d) + jitter) / f32(DIRECTIONS) * 6.2831853;
    let way = vec2f(cos(angle), sin(angle));
    var horizon = 0.0;
    var metres = max(0.6, look.texelMetres * 1.2) * (0.7 + 0.6 * fract(jitter + f32(d) * 0.381966));
    for (var s = 0; s < STEPS; s++) {
      let there = uv + way * metres / look.side;
      let above = heightAt(there) - here;
      if (above > 0.0) { horizon = max(horizon, above / sqrt(above * above + metres * metres)); }
      let weight = 1.0 / metres;
      open += weight * smoothstep(0.15, 1.2, -above);
      weightTotal += weight;
      metres *= 1.5;
    }
    // Sky a level surface sees over this side: all of it but what lies under the horizon, cosine weighted.
    blocked += horizon * horizon;
  }
  // What is under something has lost the sky overhead, the part that counts most: never more than this of it.
  // What stands beside a place shades it less than the geometry alone says: light bounces off what blocks the sky.
  textureStore(rawOut, id.xy, vec4f(pow(1.0 - blocked / f32(DIRECTIONS), 0.55), open / weightTotal * 0.55, here, 1.0));
}
`;

const BLUR_WGSL = /* wgsl */ `
@group(0) @binding(0) var raw: texture_2d<f32>;
@group(0) @binding(1) var mapOut: texture_storage_2d<rgba16float, write>;

// Evens out the map's noise, across what stands at about the same height only, so edges stay where they are.
@compute @workgroup_size(8, 8) fn blurMain(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(textureDimensions(mapOut));
  let pixel = vec2i(id.xy);
  if (pixel.x >= size.x || pixel.y >= size.y) { return; }
  let centre = textureLoad(raw, pixel, 0);
  var sum = centre.rg;
  var weight = 1.0;
  var heightSum = centre.b;
  var heightWeight = 1.0;
  for (var x = -2; x <= 2; x++) {
    for (var y = -2; y <= 2; y++) {
      if (x == 0 && y == 0) { continue; }
      let other = textureLoad(raw, clamp(pixel + vec2i(x, y), vec2i(0), size - vec2i(1)), 0);
      let near = 1.0 / (1.0 + f32(x * x + y * y) * 0.35);
      let w = near * exp(-abs(other.b - centre.b) * 1.2);
      sum += other.rg * w;
      weight += w;
      // A soft height, so a place goes from open to covered over a stretch and not at a line.
      heightSum += other.b * near;
      heightWeight += near;
    }
  }
  textureStore(mapOut, id.xy, vec4f(sum / weight, heightSum / heightWeight, 1.0));
}
`;

const VIEW_KEY = "sky-overhead";

const _eye = new THREE.Vector3();

export class SkyVisibility {
  private readonly overhead: GPUTexture;
  private readonly overheadView: GPUTextureView;
  private readonly raw: GPUTexture;
  private readonly map: GPUTexture;
  readonly view: GPUTextureView;
  readonly sampler: GPUSampler;
  private readonly lookBuffer: GPUBuffer;
  private readonly rawPipeline: GPUComputePipeline;
  private readonly blurPipeline: GPUComputePipeline;
  private readonly rawGroup: GPUBindGroup;
  private readonly blurGroup: GPUBindGroup;
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, OVERHEAD_FAR);

  private centreX = NaN;
  private centreZ = NaN;
  private side = 0;
  private age = Infinity;
  private time = -1;
  /** The map has been drawn at least once. */
  drawn = false;
  /** The height its heights count from. */
  originY = 0;

  constructor(private readonly device: GPUDevice) {
    this.overhead = device.createTexture({
      label: "sky overhead depth",
      size: [OVERHEAD_SIZE, OVERHEAD_SIZE],
      format: TARGET_FORMATS.depth,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.overheadView = this.overhead.createView();
    const map = (label: string) => device.createTexture({
      label,
      size: [MAP_SIZE, MAP_SIZE],
      format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.raw = map("sky visibility raw");
    this.map = map("sky visibility");
    this.view = this.map.createView();
    this.sampler = device.createSampler({ label: "sky visibility", magFilter: "linear", minFilter: "linear" });
    this.lookBuffer = device.createBuffer({ label: "sky visibility look", size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.rawPipeline = device.createComputePipeline({
      label: "sky visibility raw",
      layout: "auto",
      compute: { module: device.createShaderModule({ label: "sky visibility raw", code: RAW_WGSL }), entryPoint: "rawMain" },
    });
    this.blurPipeline = device.createComputePipeline({
      label: "sky visibility blur",
      layout: "auto",
      compute: { module: device.createShaderModule({ label: "sky visibility blur", code: BLUR_WGSL }), entryPoint: "blurMain" },
    });
    this.rawGroup = device.createBindGroup({
      label: "sky visibility raw",
      layout: this.rawPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.lookBuffer } },
        { binding: 1, resource: this.overheadView },
        { binding: 2, resource: this.raw.createView() },
      ],
    });
    this.blurGroup = device.createBindGroup({
      label: "sky visibility blur",
      layout: this.blurPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.raw.createView() },
        { binding: 1, resource: this.view },
      ],
    });
    this.camera.up.set(0, 0, -1);
    this.camera.rotation.set(-Math.PI / 2, 0, 0);
  }

  get cornerX(): number {
    return this.centreX - this.side / 2;
  }

  get cornerZ(): number {
    return this.centreZ - this.side / 2;
  }

  get inverseSide(): number {
    return 1 / Math.max(this.side, 1e-3);
  }

  /** Keeps the map current around the main camera. Call in the shadow stage, with the frame's sky clock. */
  update(frame: GpuFrame, halfSide: number, time: number): void {
    const { drawer } = frame;
    if (!drawer) return;
    // The first view of a frame looks after the map, and all the views read it.
    if (this.time === time) return;
    this.time = time;
    const stride = (halfSide * 2) / FOLLOW_STEPS;
    const eye = frame.camera.getWorldPosition(_eye);
    const x = Math.round(eye.x / stride) * stride;
    const z = Math.round(eye.z / stride) * stride;
    const side = halfSide * 2;
    this.age += frame.delta;
    if (x === this.centreX && z === this.centreZ && side === this.side && this.age <= LOOK_AGAIN_AFTER) return;
    this.age = 0;
    this.centreX = x;
    this.centreZ = z;
    this.side = side;
    this.originY = Math.round(eye.y);

    const { camera } = this;
    const top = this.originY + OVERHEAD_LIFT;
    camera.left = camera.bottom = -halfSide;
    camera.right = camera.top = halfSide;
    camera.position.set(x, top, z);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    const viewOffset = frame.writeView({
      projection: camera.projectionMatrix,
      matrixWorldInverse: camera.matrixWorldInverse,
      eye: camera.position,
      width: OVERHEAD_SIZE,
      height: OVERHEAD_SIZE,
      kind: 1,
      orthographic: true,
    });
    drawer.cullView(frame, viewOffset, VIEW_KEY);
    const depthPass = frame.encoder.beginRenderPass({
      label: "sky overhead",
      colorAttachments: [],
      depthStencilAttachment: { view: this.overheadView, depthClearValue: 0, depthLoadOp: "clear", depthStoreOp: "store" },
    });
    drawer.drawDepth(frame, viewOffset, VIEW_KEY, depthPass, TARGET_FORMATS.depth);
    depthPass.end();

    this.device.queue.writeBuffer(this.lookBuffer, 0, new Float32Array([top - this.originY, camera.far - camera.near, side / MAP_SIZE, side]));
    const pass = frame.encoder.beginComputePass({ label: "sky visibility" });
    const groups = Math.ceil(MAP_SIZE / 8);
    pass.setPipeline(this.rawPipeline);
    pass.setBindGroup(0, this.rawGroup);
    pass.dispatchWorkgroups(groups, groups);
    pass.setPipeline(this.blurPipeline);
    pass.setBindGroup(0, this.blurGroup);
    pass.dispatchWorkgroups(groups, groups);
    pass.end();
    this.drawn = true;
  }

  dispose(): void {
    this.overhead.destroy();
    this.raw.destroy();
    this.map.destroy();
    this.lookBuffer.destroy();
  }
}
