/// <reference types="@webgpu/types" />

/**
 * THE DEPTH PYRAMID
 *
 * The depth buffer again at half size, quarter size and so on down to one texel, each texel holding the farthest
 * depth of everything it covers. Depth is reversed, so the farthest is the smallest number. One texel can then answer
 * for a whole patch of the screen: a thing covering that patch is hidden if even its nearest point is farther away
 * than the farthest depth there, which is to say its nearest depth is a smaller number than the texel's.
 *
 * A pyramid says something only about the camera that saw it, so each camera of each scene has its own, and they all
 * share one set of pipelines.
 *
 * Published by the surface pass as frame.products "depthPyramid" (DepthPyramidProduct): one r32float texture with a
 * full mip chain, the same size as the depth target at level 0. It cannot be filtered without an optional feature, so
 * read it with textureLoad. The view differs from camera to camera and is replaced when the screen changes size, so
 * a bind group over it is kept per view or made again when the view differs.
 */

export const PYRAMID_FORMAT: GPUTextureFormat = "r32float";

export interface DepthPyramidProduct {
  view: GPUTextureView;
  mips: number;
}

const WORKGROUP = 8;

const PYRAMID_WGSL = /* wgsl */ `
@group(0) @binding(0) var depthSource: texture_depth_2d;
@group(0) @binding(1) var levelSource: texture_2d<f32>;
@group(0) @binding(2) var levelOut: texture_storage_2d<r32float, write>;

@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP}) fn copyDepth(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(levelOut))) { return; }
  textureStore(levelOut, id.xy, vec4f(textureLoad(depthSource, id.xy, 0), 0.0, 0.0, 1.0));
}

// A level's size is half the one above it rounded down, so where the level above is odd its last texels would belong
// to nobody with a plain two-by-two. Taking a third column or row there means every texel really does cover everything
// in the part of the screen it stands for, which is what lets a test trust a single level.
@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP}) fn downsample(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(levelOut))) { return; }
  let above = textureDimensions(levelSource);
  let last = above - vec2u(1u);
  let extra = above % vec2u(2u);
  let base = id.xy * 2u;
  var farthest = 1.0;
  for (var y = 0u; y < 2u + extra.y; y++) {
    for (var x = 0u; x < 2u + extra.x; x++) {
      farthest = min(farthest, textureLoad(levelSource, min(base + vec2u(x, y), last), 0).r);
    }
  }
  textureStore(levelOut, id.xy, vec4f(farthest, 0.0, 0.0, 1.0));
}
`;

const mipCount = (width: number, height: number): number => Math.floor(Math.log2(Math.max(width, height))) + 1;
const groupsFor = (size: number): number => Math.ceil(size / WORKGROUP);

/** What every pyramid on a device builds with. */
export class DepthPyramidPipelines {
  readonly copyLayout: GPUBindGroupLayout;
  readonly levelLayout: GPUBindGroupLayout;
  readonly copy: GPUComputePipeline;
  readonly downsample: GPUComputePipeline;

  constructor(device: GPUDevice) {
    const visibility = GPUShaderStage.COMPUTE;
    const storageTexture: GPUStorageTextureBindingLayout = { access: "write-only", format: PYRAMID_FORMAT, viewDimension: "2d" };
    this.copyLayout = device.createBindGroupLayout({
      label: "gpu depth pyramid copy",
      entries: [
        { binding: 0, visibility, texture: { sampleType: "depth" } },
        { binding: 2, visibility, storageTexture },
      ],
    });
    this.levelLayout = device.createBindGroupLayout({
      label: "gpu depth pyramid level",
      entries: [
        { binding: 1, visibility, texture: { sampleType: "unfilterable-float" } },
        { binding: 2, visibility, storageTexture },
      ],
    });
    const module = device.createShaderModule({ label: "gpu depth pyramid", code: PYRAMID_WGSL });
    this.copy = device.createComputePipeline({
      label: "gpu depth pyramid copy",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.copyLayout] }),
      compute: { module, entryPoint: "copyDepth" },
    });
    this.downsample = device.createComputePipeline({
      label: "gpu depth pyramid downsample",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.levelLayout] }),
      compute: { module, entryPoint: "downsample" },
    });
  }
}

export class DepthPyramid {
  width = 0;
  height = 0;
  mips = 1;
  /** Every level, for reading. */
  view!: GPUTextureView;
  /** Goes up when the texture is replaced, so bind groups over `view` are made again. */
  generation = 0;
  /** Whether the texture holds a depth buffer yet: a new one has nothing to test against. */
  built = false;
  private texture: GPUTexture | null = null;
  private levelGroups: GPUBindGroup[] = [];
  private copyGroup: GPUBindGroup | null = null;
  private copiedDepth: GPUTextureView | null = null;
  private levelZero!: GPUTextureView;

  constructor(private readonly device: GPUDevice, private readonly pipelines: DepthPyramidPipelines, width: number, height: number) {
    this.ensure(width, height);
  }

  /** Matches the texture to the screen. */
  ensure(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.texture?.destroy();
    this.width = width;
    this.height = height;
    this.mips = mipCount(width, height);
    const texture = this.device.createTexture({
      label: "gpu depth pyramid",
      size: [width, height],
      format: PYRAMID_FORMAT,
      mipLevelCount: this.mips,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    this.texture = texture;
    this.view = texture.createView({ label: "gpu depth pyramid" });
    const levels: GPUTextureView[] = [];
    for (let level = 0; level < this.mips; level++) levels.push(texture.createView({ baseMipLevel: level, mipLevelCount: 1 }));
    this.levelZero = levels[0];
    this.levelGroups = [];
    for (let level = 1; level < this.mips; level++) {
      this.levelGroups.push(this.device.createBindGroup({
        label: `gpu depth pyramid level ${level}`,
        layout: this.pipelines.levelLayout,
        entries: [
          { binding: 1, resource: levels[level - 1] },
          { binding: 2, resource: levels[level] },
        ],
      }));
    }
    this.copyGroup = null;
    this.built = false;
    this.generation++;
  }

  /** Fills every level from the depth target, which must not be in an open render pass. */
  build(encoder: GPUCommandEncoder, depth: GPUTextureView): void {
    if (!this.copyGroup || this.copiedDepth !== depth) {
      this.copiedDepth = depth;
      this.copyGroup = this.device.createBindGroup({
        label: "gpu depth pyramid copy",
        layout: this.pipelines.copyLayout,
        entries: [
          { binding: 0, resource: depth },
          { binding: 2, resource: this.levelZero },
        ],
      });
    }
    const pass = encoder.beginComputePass({ label: "gpu depth pyramid" });
    pass.setPipeline(this.pipelines.copy);
    pass.setBindGroup(0, this.copyGroup);
    pass.dispatchWorkgroups(groupsFor(this.width), groupsFor(this.height));
    pass.setPipeline(this.pipelines.downsample);
    for (let level = 1; level < this.mips; level++) {
      pass.setBindGroup(0, this.levelGroups[level - 1]);
      pass.dispatchWorkgroups(groupsFor(Math.max(1, this.width >> level)), groupsFor(Math.max(1, this.height >> level)));
    }
    pass.end();
    this.built = true;
  }

  destroy(): void {
    this.texture?.destroy();
    this.texture = null;
  }
}
