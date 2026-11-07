/// <reference types="@webgpu/types" />
import type * as THREE from "three";
import type { TextureMean } from "../../../runtime/raytracing/rayScene";
import type { TexturePool } from "../texturePool";

/**
 * THE AVERAGE OF A TEXTURE
 *
 * Rays see a surface as one colour: its material's, times the average of its texture. Compute works that average out on
 * the graphics card, so any form a texture takes will do, compressed included. The answer comes back some frames later;
 * until then a surface counts as middling grey, and the ray scene is told to look again when it arrives.
 */

const MEAN_WGSL = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> result: vec4f;

@compute @workgroup_size(1)
fn averageTexture() {
  // Over the level nearest sixteen texels across, which a chain of mips has already averaged.
  let levels = textureNumLevels(source);
  var level = 0u;
  while (level + 1u < levels && max(textureDimensions(source, level).x, textureDimensions(source, level).y) > 16u) { level++; }
  let size = textureDimensions(source, level);
  let steps = min(size, vec2u(16u));
  var sum = vec3f(0.0);
  var shown = 0.0;
  for (var y = 0u; y < steps.y; y++) {
    for (var x = 0u; x < steps.x; x++) {
      let at = (vec2u(x, y) * 2u + vec2u(1u)) * size / (steps * 2u);
      let texel = textureLoad(source, at, level);
      // Over what shows: the see-through part of a leaf texture is whatever colour it happens to be.
      sum += texel.rgb * texel.a;
      shown += texel.a;
    }
  }
  result = vec4f(sum / max(shown, 1e-5), shown);
}
`;

/** New averages asked for per frame at most. */
const MEANS_PER_FRAME = 4;
const GREY: [number, number, number] = [0.5, 0.5, 0.5];
/** Frames a texture may have no image before it is taken to be grey for good: a form this pool cannot read. */
const GIVE_UP_AFTER = 600;

export class TextureMeans {
  private readonly known = new Map<string, [number, number, number]>();
  private readonly waiting = new Map<string, { texture: THREE.Texture; tries: number }>();
  private readonly running = new Set<string>();
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly results: GPUBuffer;
  private readonly readbacks: GPUBuffer[] = [];
  private disposed = false;

  constructor(private readonly device: GPUDevice, private readonly onArrived: () => void) {
    this.layout = device.createBindGroupLayout({
      label: "gi texture mean",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    this.pipeline = device.createComputePipeline({
      label: "gi texture mean",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: device.createShaderModule({ label: "gi texture mean", code: MEAN_WGSL }), entryPoint: "averageTexture" },
    });
    this.results = device.createBuffer({ label: "gi texture mean", size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  }

  /** For rayMaterialFor: what is known of a texture's average, and a note to find out if nothing is. */
  readonly mean: TextureMean = (texture) => {
    const key = `${texture.uuid}:${texture.version}`;
    const known = this.known.get(key);
    if (known) return known;
    if (!this.running.has(key) && !this.waiting.has(key)) this.waiting.set(key, { texture, tries: 0 });
    return GREY;
  };

  /** How many averages are still to come in. */
  get pending(): number {
    return this.waiting.size + this.running.size;
  }

  /** Sends off a few of the averages asked for. */
  run(pool: TexturePool): void {
    let left = MEANS_PER_FRAME;
    for (const [key, entry] of this.waiting) {
      if (left <= 0) return;
      const gpu = pool.acquire(entry.texture);
      if (!gpu) {
        if (++entry.tries > GIVE_UP_AFTER) {
          this.waiting.delete(key);
          this.known.set(key, GREY);
        }
        continue;
      }
      left--;
      this.waiting.delete(key);
      this.running.add(key);
      this.send(key, gpu.view);
    }
  }

  private send(key: string, view: GPUTextureView): void {
    const { device } = this;
    const readback = this.readbacks.pop() ?? device.createBuffer({ label: "gi texture mean read", size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder({ label: "gi texture mean" });
    const pass = encoder.beginComputePass({ label: "gi texture mean" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, device.createBindGroup({
      layout: this.layout,
      entries: [{ binding: 0, resource: view }, { binding: 1, resource: { buffer: this.results } }],
    }));
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(this.results, 0, readback, 0, 16);
    device.queue.submit([encoder.finish()]);
    readback.mapAsync(GPUMapMode.READ).then(() => {
      const values = new Float32Array(readback.getMappedRange());
      const mean: [number, number, number] = values[3] > 0 ? [values[0], values[1], values[2]] : GREY;
      readback.unmap();
      this.finish(key, mean, readback);
    }, () => this.finish(key, GREY, readback));
  }

  private finish(key: string, mean: [number, number, number], readback: GPUBuffer): void {
    this.running.delete(key);
    if (this.disposed) {
      readback.destroy();
      return;
    }
    this.readbacks.push(readback);
    this.known.set(key, mean);
    this.onArrived();
  }

  destroy(): void {
    this.disposed = true;
    this.results.destroy();
    for (const readback of this.readbacks) readback.destroy();
  }
}
