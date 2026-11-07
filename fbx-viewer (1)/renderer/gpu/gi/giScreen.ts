/// <reference types="@webgpu/types" />
import * as THREE from "three";
import type { GpuFrame, GpuPass, GpuRendererApi } from "../frame";
import type { SkyEnvironmentProduct } from "../sky/skySettings";
import { GiLighting } from "./giShared";
import { GI_SCREEN_WGSL } from "./giWgsl";
import { LightVolumeResources } from "./lightVolume";

/**
 * INDIRECT LIGHT PER PIXEL
 *
 * Reads whatever indirect light the level has, gathered, baked or both, at each pixel of the surface buffer, for the
 * lighting pass. Either component needs this, so it is registered once however many ask (acquireGiScreen).
 *
 * Writes:
 *   "lightVolume" = `LightVolumeProduct`, from the "prepare" stage, while the scene has a baked volume.
 *   "gi" = `GiProduct`, stage "afterSurfaces" order 30, while there is any indirect light to read.
 * Reads "giProbes" = `GiProbesProduct`, written by the dynamic light's gathering, and "environment".
 */

export interface GiProduct {
  /** Screen-sized rgba16float. rgb: all the indirect light reaching each pixel; a: how much of it is more than open sky. */
  view: GPUTextureView;
}

/** What gathering hands on for the pixels to read. */
export interface GiProbesProduct {
  lighting: GiLighting;
  atlas: GPUTextureView;
}

const NO_GRIDS: readonly (readonly [number, number, number, number])[] = [];
const NOTHING: readonly never[] = [];
const ORIGIN = new THREE.Vector3();

class GiVolumePass implements GpuPass {
  readonly id = "gi-light-volume";
  readonly stage = "prepare";
  readonly order = -50;
  private products: GpuFrame["products"] | null = null;

  constructor(readonly volume: LightVolumeResources) {}

  execute(frame: GpuFrame): void {
    this.products = frame.products;
    const product = this.volume.sync(frame.scene);
    if (product) frame.products.set("lightVolume", product);
    else frame.products.delete("lightVolume");
  }

  dispose(): void {
    this.products?.delete("lightVolume");
    this.products = null;
  }
}

class GiScreenPass implements GpuPass {
  readonly id = "gi-screen";
  readonly stage = "afterSurfaces";
  readonly order = 30;
  private readonly surfaceLayout: GPUBindGroupLayout;
  private pipeline: GPUComputePipeline | null = null;
  private output: { texture: GPUTexture; view: GPUTextureView; width: number; height: number } | null = null;
  private inputs: { group: GPUBindGroup; views: GPUTextureView[] } | null = null;
  /** The numbers for a level with a bake and no gathering: the fill, and no probes to read. */
  private bakedOnly: { lighting: GiLighting; atlasTexture: GPUTexture; atlas: GPUTextureView } | null = null;
  private products: GpuFrame["products"] | null = null;

  constructor(private readonly device: GPUDevice, private readonly volume: LightVolumeResources) {
    const visibility = GPUShaderStage.COMPUTE;
    this.surfaceLayout = device.createBindGroupLayout({
      label: "gi screen",
      entries: [
        { binding: 0, visibility, texture: { sampleType: "depth" } },
        { binding: 1, visibility, texture: { sampleType: "unfilterable-float" } },
        { binding: 2, visibility, texture: { sampleType: "unfilterable-float" } },
        { binding: 3, visibility, storageTexture: { access: "write-only", format: "rgba16float" } },
        { binding: 4, visibility, texture: { sampleType: "float", viewDimension: "3d" } },
        { binding: 5, visibility, buffer: { type: "uniform" } },
      ],
    });
  }

  private pipelineFor(frame: GpuFrame, lighting: GiLighting): GPUComputePipeline {
    if (this.pipeline) return this.pipeline;
    this.pipeline = this.device.createComputePipeline({
      label: "gi screen",
      layout: this.device.createPipelineLayout({ label: "gi screen", bindGroupLayouts: [frame.cameraLayout, lighting.layout, this.surfaceLayout] }),
      compute: { module: this.device.createShaderModule({ label: "gi screen", code: GI_SCREEN_WGSL }), entryPoint: "giScreen" },
    });
    return this.pipeline;
  }

  private outputFor(width: number, height: number): GPUTextureView {
    if (this.output?.width === width && this.output.height === height) return this.output.view;
    // This frame's earlier passes may have recorded the old one already, and it has to outlive their submit.
    const replaced = this.output;
    if (replaced) setTimeout(() => replaced.texture.destroy(), 500);
    const texture = this.device.createTexture({
      label: "gi screen",
      size: [width, height],
      format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.output = { texture, view: texture.createView(), width, height };
    return this.output.view;
  }

  private inputsFor(frame: GpuFrame, output: GPUTextureView): GPUBindGroup {
    const { targets } = frame;
    const views = [targets.depth.view, targets.normal.view, targets.emissive.view, output, this.volume.view];
    if (this.inputs && views.every((view, index) => view === this.inputs?.views[index])) return this.inputs.group;
    const group = this.device.createBindGroup({
      label: "gi screen",
      layout: this.surfaceLayout,
      entries: [
        ...views.map((resource, binding) => ({ binding, resource })),
        { binding: 5, resource: { buffer: this.volume.uniform } },
      ],
    });
    this.inputs = { group, views };
    return group;
  }

  private bakedOnlyLighting(frame: GpuFrame, environment: SkyEnvironmentProduct | undefined): { lighting: GiLighting; atlas: GPUTextureView } {
    if (!this.bakedOnly) {
      const atlasTexture = this.device.createTexture({ label: "gi no probes", size: [1, 1], format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING });
      this.bakedOnly = { lighting: new GiLighting(this.device), atlasTexture, atlas: atlasTexture.createView() };
    }
    const { gpuScene } = frame;
    this.bakedOnly.lighting.update({
      directional: NOTHING,
      local: NOTHING,
      ambient: gpuScene.ambient,
      hemiSky: gpuScene.hemiSky,
      hemiGround: gpuScene.hemiGround,
      environment,
      grids: NO_GRIDS,
      intensity: 1,
      bounce: 0,
      frame: frame.frameNumber,
      centre: ORIGIN,
      cellSize: 1,
    });
    return this.bakedOnly;
  }

  execute(frame: GpuFrame): void {
    this.products = frame.products;
    const probes = frame.products.get("giProbes") as GiProbesProduct | undefined;
    const baked = frame.products.has("lightVolume");
    if (!probes && !baked) {
      frame.products.delete("gi");
      return;
    }
    const environment = frame.products.get("environment") as SkyEnvironmentProduct | undefined;
    const source = probes ?? this.bakedOnlyLighting(frame, environment);
    const { lighting } = source;
    const { targets } = frame;
    const output = this.outputFor(targets.width, targets.height);
    const pass = frame.encoder.beginComputePass({ label: "gi screen" });
    pass.setPipeline(this.pipelineFor(frame, lighting));
    pass.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    pass.setBindGroup(1, lighting.bindGroup(source.atlas, lighting.environmentView(environment)));
    pass.setBindGroup(2, this.inputsFor(frame, output));
    pass.dispatchWorkgroups(Math.ceil(targets.width / 8), Math.ceil(targets.height / 8));
    pass.end();
    frame.products.set("gi", this.output as GiProduct);
  }

  dispose(): void {
    this.products?.delete("gi");
    this.products = null;
    // A frame being recorded may still hold it, and a destroyed texture would throw that whole frame away.
    const output = this.output;
    if (output) setTimeout(() => output.texture.destroy(), 500);
    this.bakedOnly?.lighting.destroy();
    this.bakedOnly?.atlasTexture.destroy();
  }
}

interface SharedScreen {
  users: number;
  passes: GpuPass[];
  volume: LightVolumeResources;
}

const screens = new WeakMap<GpuRendererApi, SharedScreen>();

/** Has the pixels read indirect light on this renderer until the returned function is called. */
export const acquireGiScreen = (renderer: GpuRendererApi): (() => void) => {
  let shared = screens.get(renderer);
  if (!shared) {
    const { device } = renderer.core;
    const volume = new LightVolumeResources(device);
    shared = { users: 0, volume, passes: [new GiVolumePass(volume), new GiScreenPass(device, volume)] };
    for (const pass of shared.passes) renderer.addPass(pass);
    screens.set(renderer, shared);
  }
  shared.users++;
  const held = shared;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.users--;
    if (held.users > 0) return;
    screens.delete(renderer);
    for (const pass of held.passes) {
      renderer.removePass(pass);
      pass.dispose?.();
    }
    held.volume.destroy();
  };
};
