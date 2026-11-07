/// <reference types="@webgpu/types" />
import { retire } from "../buffers";

/**
 * THE POST STACK'S PICTURES
 *
 * Every step of the post stack reads one picture and writes another, by compute, so these are all rgba16float with
 * storage access. `ImagePool` keeps them by name and size: four editor views can be four sizes in one frame, and a
 * picture nothing has asked for in a while gives its memory back. `BindCache` keeps the bind groups a frame needs, so
 * an unchanged frame makes none.
 */

export const POST_FORMAT: GPUTextureFormat = "rgba16float";

/** What the post stack hands on: the finished HDR picture at the display's size. Written under the product name "resolved". */
export interface ResolvedImage {
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
  /** The frame it belongs to: products outlive a frame, so one left over from an earlier view says nothing about this one. */
  frameNumber: number;
}

export interface PostImage {
  texture: GPUTexture;
  /** The whole picture, for a one-level image. An image with levels is reached through `levels`. */
  view: GPUTextureView;
  width: number;
  height: number;
  /** One view for each mip level. */
  levels: GPUTextureView[];
}

interface PooledImage {
  image: PostImage;
  size: string;
  lastUsed: number;
}

/** A size unused for this many frames was a window that was resized, or an effect that was turned off. */
const IMAGES_KEPT_FRAMES = 240;
/**
 * How many sizes are kept whatever their age. Four views at a few sizes each fit, and a window whose edge is being dragged
 * goes through new sizes every frame: without this it holds a whole stack of pictures for each until they age out.
 */
const SIZES_KEPT = 16;

export class ImagePool {
  private readonly images = new Map<string, PooledImage>();
  /** Each size in the pool and when it was last asked for. */
  private readonly sizes = new Map<string, number>();
  private frame = 0;
  /** Goes up whenever an image is destroyed, so what was bound to it binds again. */
  generation = 0;

  constructor(private readonly device: GPUDevice) {}

  beginFrame(frame: number): void {
    this.frame = frame;
  }

  image(name: string, width: number, height: number, mipLevelCount = 1): PostImage {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const size = `${w}x${h}`;
    const key = `${name}:${size}`;
    if (!this.sizes.has(size) && this.sizes.size >= SIZES_KEPT) this.dropOldestSize();
    this.sizes.set(size, this.frame);
    const pooled = this.images.get(key);
    if (pooled) {
      pooled.lastUsed = this.frame;
      return pooled.image;
    }
    const texture = this.device.createTexture({
      label: `post ${name}`,
      size: [w, h],
      format: POST_FORMAT,
      mipLevelCount,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    const levels: GPUTextureView[] = [];
    for (let level = 0; level < mipLevelCount; level++) levels.push(texture.createView({ baseMipLevel: level, mipLevelCount: 1 }));
    const image: PostImage = { texture, view: levels[0], width: w, height: h, levels };
    this.images.set(key, { image, size, lastUsed: this.frame });
    return image;
  }

  private dropOldestSize(): void {
    let oldest = "";
    let oldestUsed = Infinity;
    for (const [size, used] of this.sizes) {
      if (used < oldestUsed) {
        oldest = size;
        oldestUsed = used;
      }
    }
    for (const [key, pooled] of this.images) {
      if (pooled.size === oldest) this.drop(key, pooled);
    }
    this.sizes.delete(oldest);
  }

  private drop(key: string, pooled: PooledImage): void {
    retire(pooled.image.texture);
    this.images.delete(key);
    this.generation++;
  }

  /** Frees what has not been asked for lately. */
  sweep(): void {
    for (const [key, pooled] of this.images) {
      if (this.frame - pooled.lastUsed > IMAGES_KEPT_FRAMES) this.drop(key, pooled);
    }
    for (const [size, used] of this.sizes) {
      if (this.frame - used > IMAGES_KEPT_FRAMES) this.sizes.delete(size);
    }
  }

  dispose(): void {
    for (const pooled of this.images.values()) retire(pooled.image.texture);
    this.images.clear();
    this.sizes.clear();
    this.generation++;
  }
}

export type PostResource = GPUTextureView | GPUSampler | GPUBuffer;

/** A cache this long has been through several window sizes: most of what it holds is stale. */
const MOST_BIND_GROUPS = 1024;

export class BindCache {
  private readonly ids = new WeakMap<object, number>();
  private readonly groups = new Map<string, GPUBindGroup>();
  private nextId = 1;

  constructor(private readonly device: GPUDevice) {}

  private idOf(resource: object): number {
    let id = this.ids.get(resource);
    if (id === undefined) {
      id = this.nextId++;
      this.ids.set(resource, id);
    }
    return id;
  }

  /** The bind group for a pipeline with these resources, given in binding order from 0. */
  group(pipeline: GPUComputePipeline | GPURenderPipeline, resources: readonly PostResource[]): GPUBindGroup {
    let key = `${this.idOf(pipeline)}`;
    for (const resource of resources) key += `/${this.idOf(resource)}`;
    let group = this.groups.get(key);
    if (group) return group;
    if (this.groups.size >= MOST_BIND_GROUPS) this.groups.clear();
    group = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: resources.map((resource, binding) => ({
        binding,
        resource: resource instanceof GPUBuffer ? { buffer: resource } : resource,
      })),
    });
    this.groups.set(key, group);
    return group;
  }

  clear(): void {
    this.groups.clear();
  }
}
