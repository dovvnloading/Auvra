/// <reference types="@webgpu/types" />
import * as THREE from "three";
import type { GpuFeatures } from "./device";

/**
 * THE TEXTURE POOL
 *
 * three.js textures as GPU textures and samplers: images and canvases copied up, compressed mip chains uploaded
 * as they are, data textures written directly, and mips made on the GPU where the source has none. A texture
 * whose `version` moves is uploaded again; one that is disposed frees its memory.
 */

export interface TextureEntry {
  texture: GPUTexture;
  view: GPUTextureView;
  sampler: GPUSampler;
  version: number;
  /** Goes up when the view changes, so bind groups holding it are made again. */
  revision: number;
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
  private readonly samplers = new Map<string, GPUSampler>();
  private readonly mipPipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
  private mipSampler: GPUSampler | null = null;
  private mipModule: GPUShaderModule | null = null;
  /** A white pixel, a flat normal and a black pixel, standing in for maps a material does not have. */
  readonly white: TextureEntry;
  readonly flatNormal: TextureEntry;
  readonly black: TextureEntry;
  readonly defaultSampler: GPUSampler;

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
    if (texture.version === 0) return entry ?? null;
    const made = this.upload(texture, entry);
    if (made && !entry) texture.addEventListener("dispose", () => this.release(texture));
    return made ?? entry ?? null;
  }

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
    let entry: TextureEntry | null;
    if (compressed.isCompressedTexture) entry = this.uploadCompressed(compressed, previous);
    else if (isCopyable(texture.image)) entry = this.uploadImage(texture, texture.image, previous);
    else if ((texture as THREE.DataTexture).isDataTexture || (texture.image as { data?: unknown } | null)?.data) entry = this.uploadData(texture, previous);
    else return null;
    if (!entry) return null;
    this.entries.set(texture, entry);
    return entry;
  }

  private finish(texture: THREE.Texture, gpu: GPUTexture, mips: number, previous: TextureEntry | undefined): TextureEntry {
    previous?.texture.destroy();
    return {
      texture: gpu,
      view: gpu.createView(),
      sampler: this.samplerFor(texture, mips > 1),
      version: texture.version,
      revision: (previous?.revision ?? 0) + 1,
    };
  }

  private uploadImage(texture: THREE.Texture, image: ImageLike, previous: TextureEntry | undefined): TextureEntry | null {
    const { width, height } = imageSize(image);
    if (!width || !height) return null;
    const srgb = texture.colorSpace === THREE.SRGBColorSpace;
    const format: GPUTextureFormat = srgb ? "rgba8unorm-srgb" : "rgba8unorm";
    const wantsMips = texture.generateMipmaps && texture.minFilter !== THREE.NearestFilter && texture.minFilter !== THREE.LinearFilter;
    const mips = wantsMips ? mipCount(width, height) : 1;
    const gpu = this.device.createTexture({
      label: texture.name || "gpu image",
      size: [width, height],
      format,
      mipLevelCount: mips,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture(
      { source: image, flipY: texture.flipY },
      { texture: gpu, premultipliedAlpha: texture.premultiplyAlpha, colorSpace: "srgb" },
      [width, height],
    );
    if (mips > 1) this.generateMips(gpu, format, mips);
    return this.finish(texture, gpu, mips, previous);
  }

  private uploadCompressed(texture: THREE.CompressedTexture, previous: TextureEntry | undefined): TextureEntry | null {
    const description = COMPRESSED[texture.format as number];
    if (!description || !this.features[description.feature]) return null;
    const levels = texture.mipmaps as unknown as { data: ArrayBufferView; width: number; height: number }[];
    if (!levels?.length) return null;
    const srgb = texture.colorSpace === THREE.SRGBColorSpace && description.srgb;
    const format = srgb ? description.srgb! : description.format;
    const { blockSize, blockBytes } = description;
    // A compressed texture must be whole blocks; the mips past the last that is are left out.
    const roundedWidth = Math.ceil(levels[0].width / blockSize) * blockSize;
    const roundedHeight = Math.ceil(levels[0].height / blockSize) * blockSize;
    const mips = Math.min(levels.length, mipCount(roundedWidth, roundedHeight));
    const gpu = this.device.createTexture({
      label: texture.name || "gpu compressed",
      size: [roundedWidth, roundedHeight],
      format,
      mipLevelCount: mips,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    for (let mip = 0; mip < mips; mip++) {
      const { data } = levels[mip];
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
    return this.finish(texture, gpu, mips, previous);
  }

  private uploadData(texture: THREE.Texture, previous: TextureEntry | undefined): TextureEntry | null {
    const image = texture.image as { data: ArrayBufferView & ArrayLike<number>; width: number; height: number } | undefined;
    if (!image?.data || !image.width || !image.height) return null;
    const layout = dataLayout(texture, image.data);
    if (!layout) return null;
    const { width, height } = image;
    const srgb = texture.colorSpace === THREE.SRGBColorSpace && layout.format === "rgba8unorm";
    const format: GPUTextureFormat = srgb ? "rgba8unorm-srgb" : layout.format;
    const wantsMips = texture.generateMipmaps && layout.renderable && texture.minFilter !== THREE.NearestFilter && texture.minFilter !== THREE.LinearFilter;
    const mips = wantsMips ? mipCount(width, height) : 1;
    const gpu = this.device.createTexture({
      label: texture.name || "gpu data",
      size: [width, height],
      format,
      mipLevelCount: mips,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | (layout.renderable ? GPUTextureUsage.RENDER_ATTACHMENT : 0),
    });
    let bytes = layout.expand ? layout.expand(image.data) : image.data as unknown as ArrayBufferView;
    if (texture.flipY && height > 1) bytes = flipRows(bytes, width * layout.bytesPerTexel, height);
    this.device.queue.writeTexture({ texture: gpu }, bytes as unknown as GPUAllowSharedBufferSource, { bytesPerRow: width * layout.bytesPerTexel, rowsPerImage: height }, [width, height]);
    if (mips > 1) this.generateMips(gpu, format, mips);
    return this.finish(texture, gpu, mips, previous);
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
    const entry = this.entries.get(texture);
    if (!entry) return;
    this.entries.delete(texture);
    entry.texture.destroy();
  }
}

interface DataLayout {
  format: GPUTextureFormat;
  bytesPerTexel: number;
  renderable: boolean;
  expand?: (data: ArrayLike<number>) => ArrayBufferView;
}

const dataLayout = (texture: THREE.Texture, data: ArrayBufferView): DataLayout | null => {
  const { format, type } = texture;
  const float = type === THREE.FloatType;
  const half = type === THREE.HalfFloatType;
  const bytes = type === THREE.UnsignedByteType || data instanceof Uint8Array || data instanceof Uint8ClampedArray;
  if (format === THREE.RGBAFormat) {
    if (float) return { format: "rgba32float", bytesPerTexel: 16, renderable: false };
    if (half) return { format: "rgba16float", bytesPerTexel: 8, renderable: true };
    if (bytes) return { format: "rgba8unorm", bytesPerTexel: 4, renderable: true };
  }
  if (format === THREE.RGFormat) {
    if (float) return { format: "rg32float", bytesPerTexel: 8, renderable: false };
    if (half) return { format: "rg16float", bytesPerTexel: 4, renderable: true };
    if (bytes) return { format: "rg8unorm", bytesPerTexel: 2, renderable: true };
  }
  if (format === THREE.RedFormat) {
    if (float) return { format: "r32float", bytesPerTexel: 4, renderable: false };
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
