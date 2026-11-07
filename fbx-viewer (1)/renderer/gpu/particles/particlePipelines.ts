/// <reference types="@webgpu/types" />
import { TARGET_FORMATS } from "../frame";
import type { LightingProduct } from "../lightingWgsl";
import {
  CONTROL_WGSL,
  DRAW_WGSL,
  SIMULATE_WGSL,
  SORT_WGSL,
  SPAWN_WGSL,
  litMeshDrawWgsl,
  particleLightWgsl,
} from "./particleWgsl";

/**
 * PARTICLE PIPELINES
 *
 * Every emitter runs the same pipelines: what differs between effects is numbers in a uniform, not code, so a level full of
 * different effects compiles nothing new. The draw pipelines differ only in their shape and how they blend, and are made
 * as they are first asked for, as are the two that need the lighting's own WGSL.
 */

export type ParticleDrawShape = "quad" | "ribbon" | "mesh";

const COMPUTE = 4; // GPUShaderStage.COMPUTE
const VERTEX = 1; // GPUShaderStage.VERTEX
const FRAGMENT = 2; // GPUShaderStage.FRAGMENT

const blendOf = (additive: boolean): GPUBlendState => additive
  ? {
    color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
  }
  : {
    color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  };

const ENTRY_OF: Record<ParticleDrawShape, string> = { quad: "quadVertex", ribbon: "ribbonVertex", mesh: "meshVertex" };

export class ParticlePipelines {
  readonly emitterLayout: GPUBindGroupLayout;
  readonly spawnLayout: GPUBindGroupLayout;
  readonly linkLayout: GPUBindGroupLayout;
  readonly simulateLayout: GPUBindGroupLayout;
  readonly sceneDepthLayout: GPUBindGroupLayout;
  readonly argsLayout: GPUBindGroupLayout;
  readonly sortLayout: GPUBindGroupLayout;
  readonly keysLayout: GPUBindGroupLayout;
  readonly drawLayout: GPUBindGroupLayout;
  readonly lightListLayout: GPUBindGroupLayout;
  readonly lightOutLayout: GPUBindGroupLayout;

  readonly spawn: GPUComputePipeline;
  readonly spawnEnd: GPUComputePipeline;
  readonly spawnEvents: GPUComputePipeline;
  readonly beginStep: GPUComputePipeline;
  readonly simulate: GPUComputePipeline;
  readonly endStep: GPUComputePipeline;
  readonly makeKeys: GPUComputePipeline;
  readonly digitOffsets: GPUComputePipeline;
  readonly writeBack: GPUComputePipeline;
  /** One per radix round: the round's digit is built into the pipeline. */
  readonly countDigits: readonly GPUComputePipeline[];
  readonly scatter: readonly GPUComputePipeline[];

  private readonly drawModule: GPUShaderModule;
  private readonly drawPipelines = new Map<string, GPURenderPipeline>();
  private litMeshModule: GPUShaderModule | null = null;
  private lightPipelineMade: GPUComputePipeline | null = null;

  constructor(
    private readonly device: GPUDevice,
    private readonly cameraLayout: GPUBindGroupLayout,
    private readonly sceneLayout: GPUBindGroupLayout,
  ) {
    const buffer = (binding: number, visibility: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({ binding, visibility, buffer: { type } });
    const layout = (label: string, entries: GPUBindGroupLayoutEntry[]) => device.createBindGroupLayout({ label: `gpu particles ${label}`, entries });

    this.emitterLayout = layout("emitter", [
      buffer(0, COMPUTE, "uniform"),
      buffer(1, COMPUTE, "uniform"),
      buffer(2, COMPUTE, "storage"),
      buffer(3, COMPUTE, "storage"),
      buffer(4, COMPUTE, "storage"),
      buffer(5, COMPUTE, "storage"),
      buffer(6, COMPUTE, "storage"),
    ]);
    this.spawnLayout = layout("spawn", [buffer(0, COMPUTE, "read-only-storage"), buffer(1, COMPUTE, "storage")]);
    this.linkLayout = layout("link", [buffer(0, COMPUTE, "read-only-storage"), buffer(1, COMPUTE, "uniform")]);
    this.simulateLayout = layout("simulate", [
      buffer(0, COMPUTE, "storage"),
      { binding: 1, visibility: COMPUTE, texture: { sampleType: "float", viewDimension: "3d" } },
      { binding: 2, visibility: COMPUTE, sampler: { type: "filtering" } },
      { binding: 3, visibility: COMPUTE, texture: { sampleType: "unfilterable-float" } },
    ]);
    this.sceneDepthLayout = layout("scene depth", [
      { binding: 0, visibility: COMPUTE, texture: { sampleType: "depth" } },
      { binding: 1, visibility: COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 2, visibility: COMPUTE, texture: { sampleType: "unfilterable-float" } },
    ]);
    this.argsLayout = layout("arguments", [buffer(0, COMPUTE, "storage")]);
    this.sortLayout = layout("sort", [
      buffer(0, COMPUTE, "uniform"),
      buffer(1, COMPUTE, "read-only-storage"),
      buffer(2, COMPUTE, "storage"),
      buffer(3, COMPUTE, "read-only-storage"),
    ]);
    this.keysLayout = layout("sort keys", [buffer(0, COMPUTE, "read-only-storage"), buffer(1, COMPUTE, "storage"), buffer(2, COMPUTE, "storage")]);
    this.drawLayout = layout("draw", [
      buffer(0, VERTEX | FRAGMENT, "uniform"),
      buffer(1, VERTEX, "uniform"),
      buffer(2, VERTEX, "read-only-storage"),
      buffer(3, VERTEX, "read-only-storage"),
      { binding: 4, visibility: FRAGMENT, texture: { sampleType: "float" } },
      { binding: 5, visibility: FRAGMENT, sampler: { type: "filtering" } },
      { binding: 6, visibility: FRAGMENT, texture: { sampleType: "depth" } },
      buffer(7, VERTEX, "read-only-storage"),
    ]);
    this.lightListLayout = layout("light list", [buffer(0, COMPUTE, "uniform"), buffer(1, COMPUTE, "read-only-storage"), buffer(2, COMPUTE, "read-only-storage")]);
    this.lightOutLayout = layout("light out", [buffer(0, COMPUTE, "read-only-storage"), buffer(1, COMPUTE, "storage")]);

    const spawnModule = device.createShaderModule({ label: "gpu particle spawn", code: SPAWN_WGSL });
    const simulateModule = device.createShaderModule({ label: "gpu particle simulate", code: SIMULATE_WGSL });
    const controlModule = device.createShaderModule({ label: "gpu particle control", code: CONTROL_WGSL });
    const sortModule = device.createShaderModule({ label: "gpu particle sort", code: SORT_WGSL });
    this.drawModule = device.createShaderModule({ label: "gpu particle draw", code: DRAW_WGSL });

    const pipelineLayout = (...groups: GPUBindGroupLayout[]) => device.createPipelineLayout({ bindGroupLayouts: groups });
    const compute = (label: string, groups: GPUPipelineLayout, module: GPUShaderModule, entryPoint: string, constants?: Record<string, number>) =>
      device.createComputePipeline({ label: `gpu particle ${label}`, layout: groups, compute: { module, entryPoint, constants } });

    const spawnGroups = pipelineLayout(cameraLayout, this.emitterLayout, this.spawnLayout);
    this.spawn = compute("spawn", spawnGroups, spawnModule, "spawn");
    this.spawnEnd = compute("spawn end", spawnGroups, spawnModule, "spawnEnd");
    this.spawnEvents = compute("spawn events", pipelineLayout(cameraLayout, this.emitterLayout, this.spawnLayout, this.linkLayout), spawnModule, "spawnEvents");

    const controlGroups = pipelineLayout(cameraLayout, this.emitterLayout, this.simulateLayout, this.argsLayout);
    this.beginStep = compute("begin step", controlGroups, controlModule, "beginStep");
    this.endStep = compute("end step", controlGroups, controlModule, "endStep");
    this.simulate = compute("simulate", pipelineLayout(cameraLayout, this.emitterLayout, this.simulateLayout, this.sceneDepthLayout), simulateModule, "simulate");

    const sortGroups = pipelineLayout(cameraLayout, this.sortLayout, this.keysLayout);
    this.makeKeys = compute("sort keys", sortGroups, sortModule, "makeKeys");
    this.digitOffsets = compute("sort offsets", sortGroups, sortModule, "digitOffsets");
    this.writeBack = compute("sort write back", sortGroups, sortModule, "writeBack");
    this.countDigits = [0, 8].map((shift) => compute("sort count", sortGroups, sortModule, "countDigits", { SHIFT: shift }));
    this.scatter = [0, 8].map((shift) => compute("sort scatter", sortGroups, sortModule, "scatter", { SHIFT: shift }));
  }

  drawPipeline(shape: ParticleDrawShape, additive: boolean): GPURenderPipeline {
    const key = `${shape}|${additive ? 1 : 0}`;
    let pipeline = this.drawPipelines.get(key);
    if (pipeline) return pipeline;
    pipeline = this.makeDraw(`gpu particle draw ${key}`, shape, additive, this.drawModule, "fragmentMain", [this.cameraLayout, this.sceneLayout, this.drawLayout]);
    this.drawPipelines.set(key, pipeline);
    return pipeline;
  }

  /** A mesh particle lit pixel by pixel, with the lighting's group as group 3. */
  litMeshPipeline(additive: boolean, lighting: LightingProduct): GPURenderPipeline {
    const key = `lit|${additive ? 1 : 0}`;
    let pipeline = this.drawPipelines.get(key);
    if (pipeline) return pipeline;
    if (!this.litMeshModule) this.litMeshModule = this.device.createShaderModule({ label: "gpu particle lit mesh", code: litMeshDrawWgsl(lighting.wgsl) });
    pipeline = this.makeDraw(`gpu particle draw ${key}`, "mesh", additive, this.litMeshModule, "fragmentLit", [this.cameraLayout, this.sceneLayout, this.drawLayout, lighting.layout]);
    this.drawPipelines.set(key, pipeline);
    return pipeline;
  }

  private makeDraw(label: string, shape: ParticleDrawShape, additive: boolean, module: GPUShaderModule, fragmentEntry: string, groups: GPUBindGroupLayout[]): GPURenderPipeline {
    return this.device.createRenderPipeline({
      label,
      layout: this.device.createPipelineLayout({ bindGroupLayouts: groups }),
      vertex: { module, entryPoint: ENTRY_OF[shape] },
      fragment: {
        module,
        entryPoint: fragmentEntry,
        constants: { ADDITIVE: additive ? 1 : 0 },
        targets: [{ format: TARGET_FORMATS.hdr, blend: blendOf(additive) }],
      },
      primitive: { topology: "triangle-list", cullMode: shape === "mesh" ? "back" : "none" },
      depthStencil: { format: TARGET_FORMATS.depth, depthWriteEnabled: false, depthCompare: "greater-equal" },
    });
  }

  /** One lighting result per particle: run in the forward stage, where the light clusters are this frame's. */
  lightPipeline(lighting: LightingProduct): GPUComputePipeline {
    if (this.lightPipelineMade) return this.lightPipelineMade;
    this.lightPipelineMade = this.device.createComputePipeline({
      label: "gpu particle light",
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.cameraLayout, this.lightListLayout, this.lightOutLayout, lighting.layout] }),
      compute: { module: this.device.createShaderModule({ label: "gpu particle light", code: particleLightWgsl(lighting.wgsl) }), entryPoint: "lightParticles" },
    });
    return this.lightPipelineMade;
  }
}
