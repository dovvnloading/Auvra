/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { retire } from "./buffers";
import type { GpuFeatures } from "./device";
import { reportGpu } from "./report";

/**
 * THE TEXTURE POOL
 *
 * three.js textures as GPU textures and samplers: images and canvases copied up, compressed mip chains uploaded
 * as they are, data textures written directly, and mips made on the GPU where the source has none. A texture
 * whose `version` moves is written again in place when it is still the same shape, which is what a video or a painted
 * map does every frame; one that is disposed frees its memory.
 *
 * Textures over one source and read the same way share one picture on the graphics card, as they do in three.js: a
 * model's maps cloned for other uv settings cost one upload. A picture that cannot be made (too large, a closed bitmap,
 * a form nothing reads) is named once and the material goes on without it: an unusable texture bound to a draw would
 * throw away the whole frame.
 */

export interface TextureEntry {
  texture: GPUTexture;
  view: GPUTextureView;
  sampler: GPUSampler;
  version: number;
  /** Goes up when the view changes, so bind groups holding it are made again. */
  revision: number;
  /** The shared picture behind it. Absent on the pool's own solid colours. */
  image?: GpuImage;
}

/** One picture on the graphics card and how many textures draw from it. */
interface GpuImage {
  texture: GPUTexture;
  view: GPUTextureView;
  source: THREE.Source<unknown>;
  key: string;
  width: number;
  height: number;
  mips: number;
  bytes: number;
  users: number;
  sourceVersion: number;
}

/** What a texture needs on the card: its shape, and how to fill a GPU texture of that shape. */
interface ImagePlan {
  format: GPUTextureFormat;
  width: number;
  height: number;
  mips: number;
  usage: GPUTextureUsageFlags;
  bytesPerTexel: number;
  fill(texture: GPUTexture): void;
}

interface CompressedFormat {
  format: GPUTextureFormat;
  srgb?: GPUTextureFormat;
  feature: keyof Pick<GpuFeatures, "bc" | "etc2" | "astc">;
  blockBytes: number;
  blockSize: number;
}

const COMPRESSED: Partial<Record<number, CompressedFormat>> = {
  [THREE.RGB_S3TC_DXT1_Format]: { format: "bc1-rgba-unorm", srgb: "bc1-rgba-unorm-srgb", feature: "bc", blockBytes: 8, blockSize: 4 },
  [THREE.RGBA_S3TC_DXT1_Format]: { format: "bc1-rgba-unorm", srgb: "bc1-rgba-unorm-srgb", feature: "bc", blockBytes: 8, blockSize: 4 },
  [THREE.RGBA_S3TC_DXT3_Format]: { format: "bc2-rgba-unorm", srgb: "bc2-rgba-unorm-srgb", feature: "bc", blockBytes: 16, blockSize: 4 },
  [THREE.RGBA_S3TC_DXT5_Format]: { format: "bc3-rgba-unorm", srgb: "bc3-rgba-unorm-srgb", feature: "bc", blockBytes: 16, blockSize: 4 },
  [THREE.RGBA_BPTC_Format]: { format: "bc7-rgba-unorm", srgb: "bc7-rgba-unorm-srgb", feature: "bc", blockBytes: 16, blockSize: 4 },
  [THREE.RED_RGTC1_Format]: { format: "bc4-r-unorm", feature: "bc", blockBytes: 8, blockSize: 4 },
  [THREE.RED_GREEN_RGTC2_Format]: { format: "bc5-rg-unorm", feature: "bc", blockBytes: 16, blockSize: 4 },
  [THREE.RGB_ETC2_Format]: { format: "etc2-rgb8unorm", srgb: "etc2-rgb8unorm-srgb", feature: "etc2", blockBytes: 8, blockSize: 4 },
  [THREE.RGBA_ETC2_EAC_Format]: { format: "etc2-rgba8unorm", srgb: "etc2-rgba8unorm-srgb", feature: "etc2", blockBytes: 16, blockSize: 4 },
  [THREE.RGBA_ASTC_4x4_Format]: { format: "astc-4x4-unorm", srgb: "astc-4x4-unorm-srgb", feature: "astc", blockBytes: 16, blockSize: 4 },
};

const ADDRESS: Record<number, GPUAddressMode> = {
  [THREE.RepeatWrapping]: "repeat",
  [THREE.ClampToEdgeWrapping]: "clamp-to-edge",
  [THREE.MirroredRepeatWrapping]: "mirror-repeat",
};

const nearestMag = (filter: number) => filter === THREE.NearestFilter;
const nearestMin = (filter: number) => filter === THREE.NearestFilter || filter === THREE.NearestMipmapNearestFilter || filter === THREE.NearestMipmapLinearFilter;
const nearestMip = (filter: number) => filter === THREE.NearestFilter || filter === THREE.LinearFilter || filter === THREE.NearestMipmapNearestFilter || filter === THREE.LinearMipmapNearestFilter;

const MIP_WGSL = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linearly: sampler;
struct Out { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) index: u32) -> Out {
  let uv = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return Out(vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0), uv);
}
@fragment fn fs(in: Out) -> @location(0) vec4f { return textureSampleLevel(source, linearly, in.uv, 0.0); }
`;

const mipCount = (width: number, height: number): number => Math.floor(Math.log2(Math.max(width, height))) + 1;

type ImageLike = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | HTMLVideoElement;

const isCopyable = (image: unknown): image is ImageLike => {
  if (!image) return false;
  return (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap)
    || (typeof HTMLImageElement !== "undefined" && image instanceof HTMLImageElement)
    || (typeof HTMLCanvasElement !== "undefined" && image instanceof HTMLCanvasElement)
    || (typeof OffscreenCanvas !== "undefined" && image instanceof OffscreenCanvas)
    || (typeof HTMLVideoElement !== "undefined" && image instanceof HTMLVideoElement);
};

const imageSize = (image: ImageLike): { width: number; height: number } => {
  const element = image as HTMLImageElement;
  if (element.naturalWidth) return { width: element.naturalWidth, height: element.naturalHeight };
  const video = image as HTMLVideoElement;
  if (video.videoWidth) return { width: video.videoWidth, height: video.videoHeight };
  return { width: (image as ImageBitmap).width, height: (image as ImageBitmap).height };
};

export class TexturePool {
  private readonly entries = new WeakMap<THREE.Texture, TextureEntry>();
  /** By source and then by how it is read: one source can be needed both as colour and as data. */
  private readonly images = new WeakMap<THREE.Source<unknown>, Map<string, GpuImage>>();
  /** The version of each texture that could not be made, so that it is not tried again until it changes. */
  private readonly refused = new WeakMap<THREE.Texture, number>();
  private readonly samplers = new Map<string, GPUSampler>();
  private readonly mipPipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
  private mipSampler: GPUSampler | null = null;
  private mipModule: GPUShaderModule | null = null;
  /** A white pixel, a flat normal and a black pixel, standing in for maps a material does not have. */
  readonly white: TextureEntry;
  readonly flatNormal: TextureEntry;
  readonly black: TextureEntry;
  readonly defaultSampler: GPUSampler;
  /** How many pictures are on the card, and roughly what they take. */
  count = 0;
  bytes = 0;

  constructor(private readonly device: GPUDevice, private readonly features: GpuFeatures) {
    this.defaultSampler = device.createSampler({ label: "gpu default sampler", magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "repeat" });
    this.white = this.solid("gpu white", [255, 255, 255, 255]);
    this.flatNormal = this.solid("gpu flat normal", [128, 128, 255, 255]);
    this.black = this.solid("gpu black", [0, 0, 0, 255]);
  }

  private solid(label: string, rgba: number[]): TextureEntry {
    const texture = this.device.createTexture({ label, size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.device.queue.writeTexture({ texture }, new Uint8Array(rgba), { bytesPerRow: 4 }, [1, 1]);
    return { texture, view: texture.createView(), sampler: this.defaultSampler, version: 1, revision: 1 };
  }

  /** The texture's GPU form, or null while its image has not arrived (or it has none the renderer can read). */
  acquire(texture: THREE.Texture | null | undefined): TextureEntry | null {
    if (!texture) return null;
    const entry = this.entries.get(texture);
    if (entry && entry.version === texture.version) return entry;
    if (texture.version === 0 || this.refused.get(texture) === texture.version) return entry ?? null;
    let made: TextureEntry | null = null;
    try {
      made = this.upload(texture, entry);
    } catch (error) {
      this.refused.set(texture, texture.version);
      reportGpu(`[gpu] texture "${texture.name || texture.uuid}" could not be made:`, error);
    }
    if (made && !entry) texture.addEventListener("dispose", this.onDispose);
    return made ?? entry ?? null;
  }

  private readonly onDispose = (event: { target?: unknown }): void => {
    this.release(event.target as THREE.Texture);
  };

  private samplerFor(texture: THREE.Texture, mipped: boolean): GPUSampler {
    const anisotropy = Math.max(1, Math.min(16, texture.anisotropy || 1));
    const key = `${texture.wrapS}/${texture.wrapT}/${texture.magFilter}/${texture.minFilter}/${mipped ? 1 : 0}/${anisotropy}`;
    let sampler = this.samplers.get(key);
    if (sampler) return sampler;
    const magFilter: GPUFilterMode = nearestMag(texture.magFilter) ? "nearest" : "linear";
    const minFilter: GPUFilterMode = nearestMin(texture.minFilter) ? "nearest" : "linear";
    const mipmapFilter: GPUMipmapFilterMode = !mipped || nearestMip(texture.minFilter) ? "nearest" : "linear";
    // Anisotropy needs every filter linear.
    const anisotropic = anisotropy > 1 && magFilter === "linear" && minFilter === "linear" && mipmapFilter === "linear";
    sampler = this.device.createSampler({
      addressModeU: ADDRESS[texture.wrapS] ?? "repeat",
      addressModeV: ADDRESS[texture.wrapT] ?? "repeat",
      magFilter,
      minFilter,
      mipmapFilter,
      maxAnisotropy: anisotropic ? anisotropy : 1,
    });
    this.samplers.set(key, sampler);
    return sampler;
  }

  private upload(texture: THREE.Texture, previous: TextureEntry | undefined): TextureEntry | null {
    const compressed = texture as THREE.CompressedTexture;
    let plan: ImagePlan | null;
    if (compressed.isCompressedTexture) plan = this.planCompressed(compressed);
    else if (isCopyable(texture.image)) plan = this.planImage(texture, texture.image);
    else if ((texture as THREE.DataTexture).isDataTexture || (texture.image as { data?: unknown } | null)?.data) plan = this.planData(texture);
    else return null;
    if (!plan) return null;
    const image = this.place(texture, plan, previous?.image);
    const sampler = this.samplerFor(texture, plan.mips > 1);
    if (previous && previous.image === image && previous.sampler === sampler) {
      previous.version = texture.version;
      return previous;
    }
    const entry: TextureEntry = {
      texture: image.texture,
      view: image.view,
      sampler,
      version: texture.version,
      revision: (previous?.revision ?? 0) + 1,
      image,
    };
    this.entries.set(texture, entry);
    return entry;
  }

  /** The picture a texture draws from: the one its source already has where that fits, written again if it has changed. */
  private place(texture: THREE.Texture, plan: ImagePlan, held: GpuImage | undefined): GpuImage {
    const { source } = texture;
    let forSource = this.images.get(source);
    if (!forSource) {
      forSource = new Map();
      this.images.set(source, forSource);
    }
    const key = `${plan.format}|${plan.mips}|${texture.flipY ? 1 : 0}|${texture.premultiplyAlpha ? 1 : 0}`;
    let image = forSource.get(key);
    if (image && image.width === plan.width && image.height === plan.height) {
      if (image.sourceVersion !== source.version) {
        plan.fill(image.texture);
        image.sourceVersion = source.version;
      }
    } else {
      const gpu = this.device.createTexture({
        label: texture.name || "gpu image",
        size: [plan.width, plan.height],
        format: plan.format,
        mipLevelCount: plan.mips,
        usage: plan.usage,
      });
      plan.fill(gpu);
      // A picture of the old shape stays for the textures still on it, and goes with the last of them.
      image = {
        texture: gpu,
        view: gpu.createView(),
        source,
        key,
        width: plan.width,
        height: plan.height,
        mips: plan.mips,
        bytes: Math.ceil(plan.width * plan.height * plan.bytesPerTexel * (plan.mips > 1 ? 4 / 3 : 1)),
        users: 0,
        sourceVersion: source.version,
      };
      forSource.set(key, image);
      this.count++;
      this.bytes += image.bytes;
    }
    if (image !== held) {
      image.users++;
      if (held) this.letGo(held);
    }
    return image;
  }

  private letGo(image: GpuImage): void {
    if (--image.users > 0) return;
    const forSource = this.images.get(image.source);
    if (forSource?.get(image.key) === image) forSource.delete(image.key);
    this.count--;
    this.bytes -= image.bytes;
    retire(image.texture);
  }

  private planImage(texture: THREE.Texture, image: ImageLike): ImagePlan | null {
    const size = imageSize(image);
    if (!size.width || !size.height) return null;
    const { source, width, height } = this.fitted(texture, image, size.width, size.height);
    const srgb = texture.colorSpace === THREE.SRGBColorSpace;
    const format: GPUTextureFormat = srgb ? "rgba8unorm-srgb" : "rgba8unorm";
    const wantsMips = texture.generateMipmaps && texture.minFilter !== THREE.NearestFilter && texture.minFilter !== THREE.LinearFilter;
    const mips = wantsMips ? mipCount(width, height) : 1;
    return {
      format,
      width,
      height,
      mips,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      bytesPerTexel: 4,
      fill: (gpu) => {
        this.device.queue.copyExternalImageToTexture(
          { source, flipY: texture.flipY },
          { texture: gpu, premultipliedAlpha: texture.premultiplyAlpha, colorSpace: "srgb" },
          [width, height],
        );
        if (mips > 1) this.generateMips(gpu, format, mips);
      },
    };
  }

  /** An image past what this card can hold is drawn smaller first; a texture that size could not be made at all. */
  private fitted(texture: THREE.Texture, image: ImageLike, width: number, height: number): { source: ImageLike; width: number; height: number } {
    const largest = this.device.limits.maxTextureDimension2D;
    if (Math.max(width, height) <= largest) return { source: image, width, height };
    const scale = largest / Math.max(width, height);
    const fitWidth = Math.max(1, Math.floor(width * scale));
    const fitHeight = Math.max(1, Math.floor(height * scale));
    reportGpu(`[gpu] texture "${texture.name || texture.uuid}" is ${width}x${height}, past this card's ${largest}: it draws at ${fitWidth}x${fitHeight}`);
    const canvas = new OffscreenCanvas(fitWidth, fitHeight);
    canvas.getContext("2d")?.drawImage(image, 0, 0, fitWidth, fitHeight);
    return { source: canvas, width: fitWidth, height: fitHeight };
  }

  private planCompressed(texture: THREE.CompressedTexture): ImagePlan | null {
    const description = COMPRESSED[texture.format as number];
    if (!description || !this.features[description.feature]) {
      throw new Error(`this card cannot read its compressed format (${texture.format})`);
    }
    const levels = texture.mipmaps as unknown as { data: ArrayBufferView; width: number; height: number }[];
    if (!levels?.length) return null;
    // A chain too large for this card starts at its first level that fits.
    const largest = this.device.limits.maxTextureDimension2D;
    let top = 0;
    while (top < levels.length - 1 && Math.max(levels[top].width, levels[top].height) > largest) top++;
    if (Math.max(levels[top].width, levels[top].height) > largest) throw new Error(`it is larger than this card's ${largest}`);
    const srgb = texture.colorSpace === THREE.SRGBColorSpace && description.srgb;
    const format = srgb ? description.srgb! : description.format;
    const { blockSize, blockBytes } = description;
    // A compressed texture must be whole blocks; the mips past the last that is are left out.
    const roundedWidth = Math.ceil(levels[top].width / blockSize) * blockSize;
    const roundedHeight = Math.ceil(levels[top].height / blockSize) * blockSize;
    const mips = Math.min(levels.length - top, mipCount(roundedWidth, roundedHeight));
    return {
      format,
      width: roundedWidth,
      height: roundedHeight,
      mips,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      bytesPerTexel: blockBytes / (blockSize * blockSize),
      fill: (gpu) => {
        for (let mip = 0; mip < mips; mip++) {
          const { data } = levels[top + mip];
          const mipWidth = Math.max(1, roundedWidth >> mip);
          const mipHeight = Math.max(1, roundedHeight >> mip);
          const blocksWide = Math.ceil(mipWidth / blockSize);
          const blocksHigh = Math.ceil(mipHeight / blockSize);
          this.device.queue.writeTexture(
            { texture: gpu, mipLevel: mip },
            data as unknown as GPUAllowSharedBufferSource,
            { bytesPerRow: blocksWide * blockBytes, rowsPerImage: blocksHigh },
            [blocksWide * blockSize, blocksHigh * blockSize],
          );
        }
      },
    };
  }

  private planData(texture: THREE.Texture): ImagePlan | null {
    const image = texture.image as { data: ArrayBufferView & ArrayLike<number>; width: number; height: number; depth?: number } | undefined;
    if (!image?.data || !image.width || !image.height) return null;
    if ((image.depth ?? 1) > 1) throw new Error("it has layers, and a surface reads flat pictures");
    const largest = this.device.limits.maxTextureDimension2D;
    if (Math.max(image.width, image.height) > largest) throw new Error(`it is ${image.width}x${image.height}, past this card's ${largest}`);
    const layout = dataLayout(texture, image.data, this.features.float32Filterable);
    if (!layout) throw new Error(`nothing reads format ${texture.format} of type ${texture.type}`);
    const { width, height } = image;
    const srgb = texture.colorSpace === THREE.SRGBColorSpace && layout.format === "rgba8unorm";
    const format: GPUTextureFormat = srgb ? "rgba8unorm-srgb" : layout.format;
    const wantsMips = texture.generateMipmaps && layout.renderable && texture.minFilter !== THREE.NearestFilter && texture.minFilter !== THREE.LinearFilter;
    const mips = wantsMips ? mipCount(width, height) : 1;
    return {
      format,
      width,
      height,
      mips,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | (layout.renderable ? GPUTextureUsage.RENDER_ATTACHMENT : 0),
      bytesPerTexel: layout.bytesPerTexel,
      fill: (gpu) => {
        let bytes = layout.expand ? layout.expand(image.data) : image.data as unknown as ArrayBufferView;
        if (texture.flipY && height > 1) bytes = flipRows(bytes, width * layout.bytesPerTexel, height);
        this.device.queue.writeTexture({ texture: gpu }, bytes as unknown as GPUAllowSharedBufferSource, { bytesPerRow: width * layout.bytesPerTexel, rowsPerImage: height }, [width, height]);
        if (mips > 1) this.generateMips(gpu, format, mips);
      },
    };
  }

  /** Each mip drawn from the one above it. */
  generateMips(texture: GPUTexture, format: GPUTextureFormat, mips: number, layer = 0): void {
    const pipeline = this.mipPipeline(format);
    const encoder = this.device.createCommandEncoder({ label: "gpu mips" });
    for (let mip = 1; mip < mips; mip++) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: texture.createView({ dimension: "2d", baseArrayLayer: layer, arrayLayerCount: 1, baseMipLevel: mip, mipLevelCount: 1 }), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: texture.createView({ dimension: "2d", baseArrayLayer: layer, arrayLayerCount: 1, baseMipLevel: mip - 1, mipLevelCount: 1 }) },
          { binding: 1, resource: this.mipSampler! },
        ],
      }));
      pass.draw(3);
      pass.end();
    }
    this.device.queue.submit([encoder.finish()]);
  }

  private mipPipeline(format: GPUTextureFormat): GPURenderPipeline {
    let pipeline = this.mipPipelines.get(format);
    if (pipeline) return pipeline;
    if (!this.mipModule) this.mipModule = this.device.createShaderModule({ label: "gpu mip shader", code: MIP_WGSL });
    if (!this.mipSampler) this.mipSampler = this.device.createSampler({ minFilter: "linear", magFilter: "linear" });
    pipeline = this.device.createRenderPipeline({
      label: `gpu mips ${format}`,
      layout: "auto",
      vertex: { module: this.mipModule, entryPoint: "vs" },
      fragment: { module: this.mipModule, entryPoint: "fs", targets: [{ format }] },
    });
    this.mipPipelines.set(format, pipeline);
    return pipeline;
  }

  private release(texture: THREE.Texture): void {
    texture.removeEventListener("dispose", this.onDispose);
    this.refused.delete(texture);
    const entry = this.entries.get(texture);
    if (!entry) return;
    this.entries.delete(texture);
    if (entry.image) this.letGo(entry.image);
  }
}

interface DataLayout {
  format: GPUTextureFormat;
  bytesPerTexel: number;
  renderable: boolean;
  expand?: (data: ArrayLike<number>) => ArrayBufferView;
}

/** Floats as half floats, for a card that cannot filter the full kind: a surface reads every texture through a filter. */
const toHalves = (data: ArrayLike<number>): Uint16Array => {
  const halves = new Uint16Array(data.length);
  for (let at = 0; at < data.length; at++) halves[at] = THREE.DataUtils.toHalfFloat(Math.max(-65504, Math.min(65504, data[at])));
  return halves;
};

const dataLayout = (texture: THREE.Texture, data: ArrayBufferView, floatsFilter: boolean): DataLayout | null => {
  const { format, type } = texture;
  const float = type === THREE.FloatType;
  const half = type === THREE.HalfFloatType;
  const bytes = type === THREE.UnsignedByteType || data instanceof Uint8Array || data instanceof Uint8ClampedArray;
  if (format === THREE.RGBAFormat) {
    if (float) return floatsFilter ? { format: "rgba32float", bytesPerTexel: 16, renderable: false } : { format: "rgba16float", bytesPerTexel: 8, renderable: true, expand: toHalves };
    if (half) return { format: "rgba16float", bytesPerTexel: 8, renderable: true };
    if (bytes) return { format: "rgba8unorm", bytesPerTexel: 4, renderable: true };
  }
  if (format === THREE.RGFormat) {
    if (float) return floatsFilter ? { format: "rg32float", bytesPerTexel: 8, renderable: false } : { format: "rg16float", bytesPerTexel: 4, renderable: true, expand: toHalves };
    if (half) return { format: "rg16float", bytesPerTexel: 4, renderable: true };
    if (bytes) return { format: "rg8unorm", bytesPerTexel: 2, renderable: true };
  }
  if (format === THREE.RedFormat) {
    if (float) return floatsFilter ? { format: "r32float", bytesPerTexel: 4, renderable: false } : { format: "r16float", bytesPerTexel: 2, renderable: true, expand: toHalves };
    if (half) return { format: "r16float", bytesPerTexel: 2, renderable: true };
    if (bytes) return { format: "r8unorm", bytesPerTexel: 1, renderable: true };
  }
  return null;
};

const flipRows = (data: ArrayBufferView, rowBytes: number, rows: number): ArrayBufferView => {
  const source = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const flipped = new Uint8Array(source.length);
  for (let row = 0; row < rows; row++) {
    flipped.set(source.subarray(row * rowBytes, (row + 1) * rowBytes), (rows - 1 - row) * rowBytes);
  }
  return flipped;
};
