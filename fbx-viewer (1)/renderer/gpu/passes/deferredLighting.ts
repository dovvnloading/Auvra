/// <reference types="@webgpu/types" />
import type { GpuCore } from "../device";
import type { GpuFrame, GpuPass } from "../frame";
import { LIGHTING_GROUP, LIGHTING_WGSL, type LightingProduct } from "../lightingWgsl";
import { reportGpu } from "../report";
import { CAMERA_BINDINGS_WGSL, VIEW_WGSL } from "../shaders";
import { VIRTUAL_SHADOWS_READER, virtualShadowLayoutEntries, virtualShadowsWgsl, type VirtualShadowsProduct } from "./virtualShadows";

/**
 * LIGHTING THE SURFACE BUFFER
 *
 * Every pixel the surface pass drew is lit here, in compute: its position comes back from its depth, its material from
 * the surface buffer, and its lights from the clusters. Pixels nothing drew on are left at zero with alpha 0 for the sky
 * pass to fill. The result goes straight into the HDR target.
 *
 * Products read, each optional, for this pass only since they describe the screen and a transparent surface is not on
 * the screen they describe:
 *   "ao" = { view } occlusion in one channel, multiplied into what arrives indirectly.
 *   "gi" = { view } gathered irradiance in rgb, in place of the ambient lights.
 * A missing one is bound as a neutral pixel, so there is one pipeline whatever a level has switched on.
 *
 * While "virtualShadows" is published the sun's shadow comes from those pages, by a second pipeline compiled off the frame
 * the first time it is wanted: until that is ready the cascades carry on.
 */

const deferredWgsl = (pages: boolean): string => /* wgsl */ `
${VIEW_WGSL}
${CAMERA_BINDINGS_WGSL}
${LIGHTING_WGSL}
${pages ? virtualShadowsWgsl(1, 0) : ""}

struct DeferredParams {
  hasIndirect: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
}

@group(2) @binding(0) var surfaceDepth: texture_depth_2d;
@group(2) @binding(1) var surfaceAlbedo: texture_2d<f32>;
@group(2) @binding(2) var surfaceNormal: texture_2d<f32>;
@group(2) @binding(3) var surfaceEmissive: texture_2d<f32>;
@group(2) @binding(4) var litTarget: texture_storage_2d<rgba16float, write>;
@group(2) @binding(5) var screenOcclusion: texture_2d<f32>;
@group(2) @binding(6) var screenIndirect: texture_2d<f32>;
@group(2) @binding(7) var<uniform> deferred: DeferredParams;

fn decodeOctahedral(e: vec2f) -> vec3f {
  var n = vec3f(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  if (n.z < 0.0) {
    let flipped = (vec2f(1.0) - abs(n.yx)) * select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0));
    n = vec3f(flipped, n.z);
  }
  return normalize(n);
}

// A screen input read by hand between its pixels: it may be at a lower resolution than the screen, and reading by load
// takes any float format where a filtering sampler would rule some out.
fn loadScreenInput(source: texture_2d<f32>, uv: vec2f) -> vec4f {
  let size = textureDimensions(source);
  let limit = vec2i(size) - vec2i(1);
  let at = uv * vec2f(size) - 0.5;
  let base = floor(at);
  let t = at - base;
  let low = clamp(vec2i(base), vec2i(0), limit);
  let high = clamp(vec2i(base) + vec2i(1), vec2i(0), limit);
  let top = mix(textureLoad(source, low, 0), textureLoad(source, vec2i(high.x, low.y), 0), t.x);
  let bottom = mix(textureLoad(source, vec2i(low.x, high.y), 0), textureLoad(source, high, 0), t.x);
  return mix(top, bottom, t.y);
}

@compute @workgroup_size(8, 8)
fn lightPixels(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(surfaceDepth);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let at = vec2i(id.xy);
  let depth = textureLoad(surfaceDepth, at, 0);
  if (depth <= 0.0) {
    textureStore(litTarget, at, vec4f(0.0));
    return;
  }

  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let clip = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let reached = view.inverseViewProjection * clip;
  let world = reached.xyz / reached.w;

  let emissive = textureLoad(surfaceEmissive, at, 0);
  if (emissive.a > 0.875) {
    textureStore(litTarget, at, vec4f(lightingApplyFog(emissive.rgb, world), 1.0));
    return;
  }

  let albedo = textureLoad(surfaceAlbedo, at, 0);
  let packed = textureLoad(surfaceNormal, at, 0);
  // An orthographic camera's rays are all parallel, so the eye is in one direction from everywhere.
  let toEye = select(
    normalize(view.eye.xyz - world),
    vec3f(view.viewMatrix[0][2], view.viewMatrix[1][2], view.viewMatrix[2][2]),
    view.orthographic != 0u,
  );
  let normal = decodeOctahedral(packed.xy);
  var input = lightingInput(world, normal, toEye, albedo.rgb, packed.z, packed.w, vec2f(id.xy) + 0.5);
  ${pages ? "input.sunShade = virtualShadow(world, normal);" : ""}
  input.occlusion = albedo.a * loadScreenInput(screenOcclusion, uv).r;
  input.hasBakedLight = emissive.a > 0.375;
  input.receivesShadow = fract(emissive.a * 2.0) < 0.25;
  input.selfShadow = surfaceSelfShadow(emissive.a);
  if (deferred.hasIndirect != 0u && !input.hasBakedLight) {
    input.indirectIrradiance = loadScreenInput(screenIndirect, uv).rgb;
    input.hasIndirect = true;
  }
  let lit = lightSurface(input) + emissive.rgb;
  textureStore(litTarget, at, vec4f(lightingApplyFog(lit, world), 1.0));
}
`;

const WORKGROUP_SIZE = 8;

interface ScreenProduct {
  view: GPUTextureView;
}

export class DeferredLightingPass implements GpuPass {
  readonly id = "deferred-lighting";
  readonly stage = "lighting";

  private readonly device: GPUDevice;
  private readonly inputLayout: GPUBindGroupLayout;
  /** Nothing in group 1 for this pass unless shadow pages are in use, but the lighting group keeps its number in every shader that uses it. */
  private readonly emptyLayout: GPUBindGroupLayout;
  private readonly emptyGroup: GPUBindGroup;
  private readonly paramsBuffer: GPUBuffer;
  private readonly params = new Uint32Array(4);
  private readonly fallbackTextures: GPUTexture[];
  private readonly noOcclusion: GPUTextureView;
  private readonly noIndirect: GPUTextureView;
  private pipeline: GPUComputePipeline | null = null;
  private readonly pagesLayout: GPUBindGroupLayout;
  /** Null until it has compiled, and for good if that failed. */
  private pagesPipeline: GPUComputePipeline | null = null;
  private pagesAsked = false;
  private pagesGroup: GPUBindGroup | null = null;
  private pagesProduct: VirtualShadowsProduct | null = null;
  private inputGroup: GPUBindGroup | null = null;
  private inputViews: GPUTextureView[] = [];

  constructor(core: GpuCore) {
    const { device } = core;
    this.device = device;
    const visibility = GPUShaderStage.COMPUTE;
    this.inputLayout = device.createBindGroupLayout({
      label: "gpu deferred inputs",
      entries: [
        { binding: 0, visibility, texture: { sampleType: "depth" } },
        { binding: 1, visibility, texture: { sampleType: "unfilterable-float" } },
        { binding: 2, visibility, texture: { sampleType: "unfilterable-float" } },
        { binding: 3, visibility, texture: { sampleType: "unfilterable-float" } },
        { binding: 4, visibility, storageTexture: { access: "write-only", format: "rgba16float" } },
        { binding: 5, visibility, texture: { sampleType: "unfilterable-float" } },
        { binding: 6, visibility, texture: { sampleType: "unfilterable-float" } },
        { binding: 7, visibility, buffer: { type: "uniform" } },
      ],
    });
    this.emptyLayout = device.createBindGroupLayout({ label: "gpu deferred nothing", entries: [] });
    this.emptyGroup = device.createBindGroup({ label: "gpu deferred nothing", layout: this.emptyLayout, entries: [] });
    this.pagesLayout = device.createBindGroupLayout({ label: "gpu deferred shadow pages", entries: virtualShadowLayoutEntries(0) });
    this.paramsBuffer = device.createBuffer({ label: "gpu deferred params", size: this.params.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const pixel = (label: string, value: number[]): GPUTexture => {
      const texture = device.createTexture({ label, size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      device.queue.writeTexture({ texture }, new Uint8Array(value), { bytesPerRow: 4 }, [1, 1]);
      return texture;
    };
    const white = pixel("gpu no occlusion", [255, 255, 255, 255]);
    const black = pixel("gpu no gathered light", [0, 0, 0, 255]);
    this.fallbackTextures = [white, black];
    this.noOcclusion = white.createView();
    this.noIndirect = black.createView();
  }

  private pipelineFor(frame: GpuFrame, lighting: LightingProduct): GPUComputePipeline {
    if (this.pipeline) return this.pipeline;
    const bindGroupLayouts: GPUBindGroupLayout[] = [frame.cameraLayout, this.emptyLayout, this.inputLayout];
    bindGroupLayouts[LIGHTING_GROUP] = lighting.layout;
    this.pipeline = this.device.createComputePipeline({
      label: "gpu deferred lighting",
      layout: this.device.createPipelineLayout({ label: "gpu deferred lighting", bindGroupLayouts }),
      compute: {
        module: this.device.createShaderModule({ label: "gpu deferred lighting", code: deferredWgsl(false) }),
        entryPoint: "lightPixels",
      },
    });
    return this.pipeline;
  }

  /** The pipeline that reads the sun's shadow from pages, once it has compiled. */
  private pagesPipelineFor(frame: GpuFrame, lighting: LightingProduct): GPUComputePipeline | null {
    if (this.pagesAsked) return this.pagesPipeline;
    this.pagesAsked = true;
    const bindGroupLayouts: GPUBindGroupLayout[] = [frame.cameraLayout, this.pagesLayout, this.inputLayout];
    bindGroupLayouts[LIGHTING_GROUP] = lighting.layout;
    this.device.createComputePipelineAsync({
      label: "gpu deferred lighting with shadow pages",
      layout: this.device.createPipelineLayout({ label: "gpu deferred lighting with shadow pages", bindGroupLayouts }),
      compute: {
        module: this.device.createShaderModule({ label: "gpu deferred lighting with shadow pages", code: deferredWgsl(true) }),
        entryPoint: "lightPixels",
      },
    }).then((pipeline) => {
      this.pagesPipeline = pipeline;
    }).catch((error: unknown) => {
      reportGpu("[gpu] lighting with shadow pages would not compile; cascades carry on", error);
    });
    return null;
  }

  private pagesGroupFor(product: VirtualShadowsProduct): GPUBindGroup {
    if (this.pagesGroup && this.pagesProduct === product) return this.pagesGroup;
    this.pagesProduct = product;
    this.pagesGroup = this.device.createBindGroup({
      label: "gpu deferred shadow pages",
      layout: this.pagesLayout,
      entries: product.bindGroupEntries(0),
    });
    return this.pagesGroup;
  }

  private inputsFor(frame: GpuFrame, occlusion: GPUTextureView, indirect: GPUTextureView): GPUBindGroup {
    const { targets } = frame;
    const views = [targets.depth.view, targets.albedo.view, targets.normal.view, targets.emissive.view, targets.hdr.view, occlusion, indirect];
    if (this.inputGroup && views.every((view, index) => view === this.inputViews[index])) return this.inputGroup;
    this.inputViews = views;
    this.inputGroup = this.device.createBindGroup({
      label: "gpu deferred inputs",
      layout: this.inputLayout,
      entries: [
        ...views.map((resource, binding) => ({ binding, resource })),
        { binding: 7, resource: { buffer: this.paramsBuffer } },
      ],
    });
    return this.inputGroup;
  }

  execute(frame: GpuFrame): void {
    const lighting = frame.products.get("lighting") as LightingProduct | undefined;
    if (!lighting) throw new Error("Deferred lighting needs the light cluster pass registered before it");
    lighting.resources.refresh(frame);

    const occlusion = frame.products.get("ao") as ScreenProduct | undefined;
    const indirect = frame.products.get("gi") as ScreenProduct | undefined;
    this.params[0] = indirect ? 1 : 0;
    this.device.queue.writeBuffer(this.paramsBuffer, 0, this.params);

    const inputs = this.inputsFor(frame, occlusion?.view ?? this.noOcclusion, indirect?.view ?? this.noIndirect);
    const pages = frame.products.get("virtualShadows") as VirtualShadowsProduct | undefined;
    const pagesPipeline = pages ? this.pagesPipelineFor(frame, lighting) : null;
    // Said only once the shader can read them, because it is what lets the cascades stop being drawn.
    if (pagesPipeline) frame.products.set(VIRTUAL_SHADOWS_READER, true);
    else frame.products.delete(VIRTUAL_SHADOWS_READER);
    const pass = frame.encoder.beginComputePass({ label: "gpu deferred lighting" });
    pass.setPipeline(pagesPipeline ?? this.pipelineFor(frame, lighting));
    pass.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    pass.setBindGroup(1, pages && pagesPipeline ? this.pagesGroupFor(pages) : this.emptyGroup);
    pass.setBindGroup(2, inputs);
    pass.setBindGroup(LIGHTING_GROUP, lighting.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(frame.targets.width / WORKGROUP_SIZE), Math.ceil(frame.targets.height / WORKGROUP_SIZE));
    pass.end();
  }

  dispose(): void {
    this.paramsBuffer.destroy();
    for (const texture of this.fallbackTextures) texture.destroy();
  }
}
