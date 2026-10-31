/// <reference types="@webgpu/types" />
import type * as THREE from "three";
import type { GpuCore } from "./device";
import type { GeometryPool } from "./geometryPool";
import type { GpuScene } from "./gpuScene";
import type { MaterialPool } from "./materialPool";
import type { TexturePool } from "./texturePool";

/**
 * THE FRAME
 *
 * What a pass is given and what it may add. GpuRenderer runs a frame as a list of stages; each stage runs its
 * registered passes in `order`. A pass is one self-contained job on the frame's command encoder. Anything a pass makes
 * for another to read goes in `frame.products` under a name written down where it is made.
 *
 * Depth is reversed: 1 at the near plane, 0 at the far plane, compared with "greater".
 */

export type GpuStage =
  /** Compute that runs before anything is drawn: skinning, particle simulation. */
  | "prepare"
  /** Shadow maps: every shadow view's culling and drawing. */
  | "shadow"
  /** Culling for the main view and the surface buffer's drawing. */
  | "surfaces"
  /** Compute over the finished surface buffer: depth pyramid, ambient occlusion, light clusters, reflections, GI. */
  | "afterSurfaces"
  /** The surface buffer lit into the HDR target. */
  | "lighting"
  /** Compute or drawing onto the lit HDR target before transparent things: sky, fog, decals composite. */
  | "afterLighting"
  /** Transparent surfaces, particles, water, lines, points and sprites, into the HDR target with depth. */
  | "forward"
  /** HDR to HDR: temporal resolve, bloom, depth of field, grading. */
  | "post"
  /** After tone mapping, directly on the canvas: what `toneMapped: false` asks for, editor gizmos. */
  | "overlay";

export const STAGE_ORDER: readonly GpuStage[] = ["prepare", "shadow", "surfaces", "afterSurfaces", "lighting", "afterLighting", "forward", "post", "overlay"];

export const TARGET_FORMATS = {
  /** Base colour, and occlusion in alpha. */
  albedo: "rgba8unorm-srgb",
  /** Octahedral normal, roughness, metalness. */
  normal: "rgba16float",
  /** Emitted light (and unlit colour); alpha is 0 lit, 0.5 baked light included, 1 unlit. */
  emissive: "rgba16float",
  /** Screen-space motion: where this pixel was last frame minus where it is, in uv. */
  motion: "rg16float",
  depth: "depth32float",
  hdr: "rgba16float",
} as const;

export interface GpuTarget {
  texture: GPUTexture;
  view: GPUTextureView;
}

/** The frame's screen-sized textures. All have TEXTURE_BINDING; hdr also STORAGE_BINDING; all RENDER_ATTACHMENT. */
export interface GpuTargets {
  width: number;
  height: number;
  albedo: GpuTarget;
  normal: GpuTarget;
  emissive: GpuTarget;
  motion: GpuTarget;
  depth: GpuTarget;
  hdr: GpuTarget;
}

/** A camera for a view other than the main one, such as a shadow cascade. */
export interface GpuViewSpec {
  /** World to clip, with the depth range still as three.js has it (-1 to 1); the renderer reverses it. */
  projection: THREE.Matrix4;
  matrixWorldInverse: THREE.Matrix4;
  eye: THREE.Vector3;
  /** The eye detail levels are chosen for: the main camera's for a shadow view. */
  lodEye?: THREE.Vector3;
  width: number;
  height: number;
  layers?: number;
  /** 0 main, 1 shadow: a shadow view takes casters only and has no occlusion test. */
  kind?: number;
  orthographic?: boolean;
}

/** Cull and draw for one view, provided by the surface pass (passes/surfaces.ts). */
export interface GpuViewDrawer {
  /** Runs the compute cull for the view at `viewOffset`, outside any render pass. */
  cullView(frame: GpuFrame, viewOffset: number, viewKey: string): void;
  /** Draws what `cullView` chose into an open depth-only render pass whose depth format is `depthFormat`. */
  drawDepth(frame: GpuFrame, viewOffset: number, viewKey: string, pass: GPURenderPassEncoder, depthFormat: GPUTextureFormat): void;
}

export interface GpuFrame {
  core: GpuCore;
  device: GPUDevice;
  encoder: GPUCommandEncoder;
  scene: THREE.Scene;
  camera: THREE.Camera;
  gpuScene: GpuScene;
  geometries: GeometryPool;
  materials: MaterialPool;
  textures: TexturePool;
  targets: GpuTargets;
  /** Canvas's current texture, valid for the overlay stage. */
  canvasView: GPUTextureView;
  /**
   * Where on the canvas this view goes, in device pixels with y down. The targets are this size (times render scale).
   * Anything drawing to canvasView calls setViewport and setScissorRect with it: four editor views share one canvas.
   */
  viewport: { x: number; y: number; width: number; height: number };
  /** "clear" for the first view drawn on this canvas texture, "load" for the rest, which must keep what is there. */
  canvasLoadOp: GPULoadOp;
  presentFormat: GPUTextureFormat;
  frameNumber: number;
  time: number;
  delta: number;
  /** Uniform buffer of views (VIEW_WGSL), one every VIEW_BYTES; bound with a dynamic offset. */
  viewBuffer: GPUBuffer;
  mainViewOffset: number;
  /** Writes another view for this frame and returns its dynamic offset. */
  writeView(spec: GpuViewSpec): number;
  /** Group 0: the view, one dynamic-offset uniform visible to vertex, fragment and compute. */
  cameraLayout: GPUBindGroupLayout;
  cameraBindGroup: GPUBindGroup;
  /** Group 1: instances, vertices, previousPositions, read-only storage visible to vertex, fragment and compute. */
  sceneLayout: GPUBindGroupLayout;
  sceneBindGroup: GPUBindGroup;
  /** Set by the surface pass once registered. */
  drawer: GpuViewDrawer | null;
  /** Runs once this frame's commands have been submitted: for mapping a buffer they copied into. */
  afterSubmit(run: () => void): void;
  /** What passes publish for each other. See the pass that writes a name for what it holds. */
  products: Map<string, unknown>;
}

export interface GpuPass {
  readonly id: string;
  readonly stage: GpuStage;
  /** Lower runs first within a stage; default 0. */
  readonly order?: number;
  execute(frame: GpuFrame): void;
  dispose?(): void;
}

/** What level components use to reach the renderer: useThree().gl is this when isGpuRenderer(gl). */
export interface GpuRendererApi {
  readonly isGpuRenderer: true;
  readonly core: GpuCore;
  readonly geometries: GeometryPool;
  readonly materials: MaterialPool;
  readonly textures: TexturePool;
  addPass(pass: GpuPass): void;
  removePass(pass: GpuPass): void;
  /** Named settings level components hand to passes: sky, post stack, GI and so on. */
  readonly settings: Map<string, unknown>;
}

export const isGpuRenderer = (renderer: unknown): renderer is GpuRendererApi => !!(renderer as GpuRendererApi | null)?.isGpuRenderer;
