/// <reference types="@webgpu/types" />
import * as THREE from "three";
import type { GpuFrame, GpuPass, GpuRendererApi, GpuTargets } from "../frame";
import type { LightingProduct } from "../lightingWgsl";
import { CASCADES_WANTED } from "../passes/virtualShadows";
import type { DepthPyramidProduct } from "../passes/depthPyramid";
import { ComputeEmitter, type EmitterHome } from "./computeEmitter";
import { ParticlePipelines } from "./particlePipelines";
import { EVENT_BYTES, EVENT_HEADER_BYTES } from "./particleWgsl";

/**
 * THE PARTICLE WORLD
 *
 * Everything one renderer's emitters share, and the two passes that run them: simulation in the "prepare" stage, drawing in
 * the "forward" stage. A renderer gets its world the first time something asks for one.
 *
 * Reads frame.products "depthPyramid" (DepthPyramidProduct) and "lighting" (LightingProduct), and targets.depth and
 * targets.normal, all as they were left by the frame before when simulating: what collides, collides with last frame.
 */

/** After ForwardPass (order 0) and the lines and grids it leaves to EffectsPass. */
export const PARTICLE_DRAW_ORDER = 40;
const PARTICLE_SIMULATE_ORDER = 40;

const _eye = new THREE.Vector3();

export class ParticleWorld implements EmitterHome {
  readonly device: GPUDevice;
  private made: ParticlePipelines | null = null;
  private readonly emitters = new Set<ComputeEmitter>();
  /** Emitters by whatever their owners name them, so one can find another to set off. */
  readonly named = new Map<string, ComputeEmitter>();
  stepTick = 0;

  readonly noField: GPUTextureView;
  readonly noGrid: GPUTextureView;
  readonly fieldSampler: GPUSampler;
  readonly noStorage: GPUBuffer;
  readonly noEvents: GPUBuffer;
  private readonly noPyramid: GPUTextureView;
  private readonly standIns: GPUTexture[];

  private sceneDepthGroup: GPUBindGroup | null = null;
  private sceneDepthKey: unknown[] = [];
  /** What the depth target last held: a different camera or a different size says nothing about this one. */
  private lastCamera: THREE.Camera | null = null;
  private lastTargets: GpuTargets | null = null;
  private drawList: ComputeEmitter[] = [];

  private readonly simulationPass: GpuPass;
  private readonly drawingPass: GpuPass;

  constructor(private readonly renderer: GpuRendererApi) {
    const { device } = renderer.core;
    this.device = device;
    const field = device.createTexture({ label: "gpu particles no field", size: [1, 1, 1], dimension: "3d", format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING });
    const grid = device.createTexture({ label: "gpu particles no grid", size: [1, 1], format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING });
    const pyramid = device.createTexture({ label: "gpu particles no pyramid", size: [1, 1], format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING });
    this.standIns = [field, grid, pyramid];
    this.noField = field.createView({ dimension: "3d" });
    this.noGrid = grid.createView();
    this.noPyramid = pyramid.createView();
    this.fieldSampler = device.createSampler({ label: "gpu particles field", magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" });
    this.noStorage = device.createBuffer({ label: "gpu particles nothing", size: 64, usage: GPUBufferUsage.STORAGE });
    this.noEvents = device.createBuffer({ label: "gpu particles no events", size: EVENT_HEADER_BYTES + EVENT_BYTES, usage: GPUBufferUsage.STORAGE });

    this.simulationPass = {
      id: "particle-simulation",
      stage: "prepare",
      order: PARTICLE_SIMULATE_ORDER,
      execute: (frame) => this.simulateAll(frame),
      dispose: () => this.dispose(),
    };
    this.drawingPass = {
      id: "particle-drawing",
      stage: "forward",
      order: PARTICLE_DRAW_ORDER,
      execute: (frame) => this.drawAll(frame),
    };
    renderer.addPass(this.simulationPass);
    renderer.addPass(this.drawingPass);
  }

  get pipelines(): ParticlePipelines {
    if (!this.made) throw new Error("No frame has run yet");
    return this.made;
  }

  /** A new emitter of at most `capacity` particles. It does nothing until it is given an effect and asked to step. */
  createEmitter(capacity: number): ComputeEmitter {
    const emitter = new ComputeEmitter(this, capacity);
    this.emitters.add(emitter);
    return emitter;
  }

  forget(emitter: ComputeEmitter): void {
    this.emitters.delete(emitter);
    for (const [name, each] of this.named) if (each === emitter) this.named.delete(name);
  }

  private ensurePipelines(frame: GpuFrame): ParticlePipelines {
    if (!this.made) this.made = new ParticlePipelines(this.device, frame.cameraLayout, frame.sceneLayout);
    return this.made;
  }

  /** Whether the depth target holds this view's own last frame, which only a view drawn twice running can say. */
  private depthUsable(frame: GpuFrame): boolean {
    return this.lastCamera === frame.camera && this.lastTargets === frame.targets;
  }

  private sceneDepthOf(frame: GpuFrame, pipelines: ParticlePipelines, usable: boolean): GPUBindGroup {
    const depth = frame.targets.depth.view;
    const normal = frame.targets.normal.view;
    // The pyramid belongs to a camera and a size; on a change this frame's surface pass replaces it before this runs.
    const product = usable ? (frame.products.get("depthPyramid") as DepthPyramidProduct | undefined) : undefined;
    const pyramid = product?.view ?? this.noPyramid;
    const key = this.sceneDepthKey;
    if (this.sceneDepthGroup && key[0] === depth && key[1] === normal && key[2] === pyramid) return this.sceneDepthGroup;
    this.sceneDepthKey = [depth, normal, pyramid];
    this.sceneDepthGroup = this.device.createBindGroup({
      label: "gpu particles scene depth",
      layout: pipelines.sceneDepthLayout,
      entries: [
        { binding: 0, resource: depth },
        { binding: 1, resource: normal },
        { binding: 2, resource: pyramid },
      ],
    });
    return this.sceneDepthGroup;
  }

  private simulateAll(frame: GpuFrame): void {
    if (this.emitters.size === 0) return;
    const pipelines = this.ensurePipelines(frame);
    const usable = this.depthUsable(frame);
    const sceneDepth = this.sceneDepthOf(frame, pipelines, usable);
    const lightingReady = frame.products.has("lighting");

    // A step run on its own, for a prewarm: its numbers have to reach the queue before it, so it cannot share this frame's.
    const runAlone = (run: (pass: GPUComputePassEncoder) => void) => {
      const encoder = this.device.createCommandEncoder({ label: "gpu particle prewarm" });
      const pass = encoder.beginComputePass({ label: "gpu particle prewarm" });
      run(pass);
      pass.end();
      this.device.queue.submit([encoder.finish()]);
    };

    const stepping: ComputeEmitter[] = [];
    for (const emitter of this.emitters) {
      if (emitter.beginFrame(frame, usable, lightingReady, sceneDepth, runAlone)) stepping.push(emitter);
    }
    // Only frames that step move this on: views of the same moment drawn after the first see the same events.
    if (stepping.length) this.stepTick++;

    const pass = frame.encoder.beginComputePass({ label: "gpu particles" });
    // Everything spawns before anything steps, because a step overwrites the events the spawning reads.
    for (const emitter of stepping) emitter.encodeSpawn(pass, frame, true);
    for (const emitter of stepping) emitter.encodeSimulate(pass, frame, sceneDepth);
    // Any view may be looking from elsewhere, so what blends is put in order every time, stepped or not.
    for (const emitter of this.emitters) if (emitter.drawable) emitter.encodeSort(pass, frame);
    pass.end();
    for (const emitter of stepping) emitter.encodeReadback(frame.encoder);
  }

  private drawAll(frame: GpuFrame): void {
    const camera = frame.camera;
    const targets = frame.targets;
    if (this.emitters.size === 0 || !this.made) {
      this.lastCamera = camera;
      this.lastTargets = targets;
      return;
    }
    const lighting = (frame.products.get("lighting") as LightingProduct | undefined) ?? null;
    frame.products.set(CASCADES_WANTED, frame.frameNumber);
    const list = this.drawList;
    list.length = 0;
    for (const emitter of this.emitters) if (emitter.drawable && emitter.shownIn(frame)) list.push(emitter);
    if (list.length) {
      if (lighting && list.some((emitter) => emitter.wantsLight)) {
        const pass = frame.encoder.beginComputePass({ label: "gpu particle light" });
        for (const emitter of list) emitter.encodeLight(pass, frame, lighting);
        pass.end();
      }
      // What blends goes back to front between emitters as well as within them.
      camera.getWorldPosition(_eye);
      list.sort((a, b) => b.distanceTo(_eye) - a.distanceTo(_eye));
      const pass = frame.encoder.beginRenderPass({
        label: "gpu particles",
        colorAttachments: [{ view: targets.hdr.view, loadOp: "load", storeOp: "store" }],
        // Read-only, because the fragments also read this depth for their soft edges.
        depthStencilAttachment: { view: targets.depth.view, depthReadOnly: true },
      });
      pass.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
      pass.setBindGroup(1, frame.sceneBindGroup);
      for (const emitter of list) emitter.encodeDraw(pass, frame, lighting);
      pass.end();
    }
    this.lastCamera = camera;
    this.lastTargets = targets;
  }

  dispose(): void {
    for (const emitter of [...this.emitters]) emitter.dispose();
    for (const texture of this.standIns) texture.destroy();
    this.noStorage.destroy();
    this.noEvents.destroy();
    worlds.delete(this.renderer);
    this.renderer.removePass(this.simulationPass);
    this.renderer.removePass(this.drawingPass);
  }
}

const worlds = new WeakMap<GpuRendererApi, ParticleWorld>();

/** The renderer's particle world, made and its passes added the first time it is asked for. */
export const particleWorldOf = (renderer: GpuRendererApi): ParticleWorld => {
  let world = worlds.get(renderer);
  if (!world) {
    world = new ParticleWorld(renderer);
    worlds.set(renderer, world);
  }
  return world;
};
