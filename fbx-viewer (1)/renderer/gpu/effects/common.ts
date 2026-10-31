/// <reference types="@webgpu/types" />
import { useEffect } from "react";
import type * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { TARGET_FORMATS, isGpuRenderer, type GpuFrame, type GpuPass, type GpuRendererApi } from "../frame";
import { CAMERA_BINDINGS_WGSL, INSTANCE_WGSL, SCENE_BINDINGS_WGSL, VIEW_WGSL } from "../shaders";
import { reportGpu } from "../report";

/**
 * WHAT THE LEVEL EFFECTS SHARE
 *
 * The effects in this folder are what a level draws beyond plain materials: water, decals, scatter, weather and the
 * editor's helpers. Each is one or more passes that stay on the renderer for as long as any level component wants
 * them, a list of what those components asked for, and WGSL. A component adds an entry; the pass finds, each frame, the
 * entries of the scene being drawn, because four editor views are four scenes on one renderer.
 *
 * "Painting" here means changing the surface buffer after the surface pass and before it is lit: what a decal or
 * settled snow does to a surface then lights exactly as the surface does. The surface buffer has no room for "what
 * was the baked light" and no pixel can read the target it writes, so a paint is two render passes. One multiplies the
 * light already in the emissive target by how much the colour under it changed, reading the albedo. The other writes
 * the albedo, roughness and metalness.
 *
 * Nothing in this file or beside it touches a WebGPU global as it loads: a browser without WebGPU still imports all of
 * it for the WebGL path.
 */

// GPUColorWrite's numbers, for the same reason.
const WRITE_BLUE = 4;
const WRITE_ALPHA = 8;

/** The view and the scene's tables. */
export const EFFECT_HEAD_WGSL = `${VIEW_WGSL}${INSTANCE_WGSL}${CAMERA_BINDINGS_WGSL}${SCENE_BINDINGS_WGSL}`;

/** The view alone. */
export const VIEW_HEAD_WGSL = `${VIEW_WGSL}${CAMERA_BINDINGS_WGSL}`;

/** From a pixel and its depth back to the world, by the main view; needs `view`. */
export const WORLD_FROM_DEPTH_WGSL = /* wgsl */ `
fn worldFromDepth(pixel: vec2f, depth: f32) -> vec3f {
  let uv = pixel * view.size.zw;
  let world = view.inverseViewProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  return world.xyz / world.w;
}
`;

/** The surface buffer's normal; the inverse of what the surface shader packs. */
export const OCTAHEDRAL_WGSL = /* wgsl */ `
fn decodeOctahedral(e: vec2f) -> vec3f {
  var n = vec3f(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  if (n.z < 0.0) {
    let flipped = (vec2f(1.0) - abs(n.yx)) * select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0));
    n = vec3f(flipped, n.z);
  }
  return normalize(n);
}
`;

/**
 * How a paint reaches a surface: only where the surface drawn at this pixel is the one it is meant for. Up to a
 * few centimetres apart, more with distance, which forgives a mesh drawn at a coarser level of detail than the one a
 * mark was laid on and turns away whatever stands in front of it. Needs `surfaceDepth` and worldFromDepth.
 */
export const PAINT_REACH_WGSL = /* wgsl */ `
fn paintReaches(pixel: vec2f, world: vec3f) -> bool {
  let depth = textureLoad(surfaceDepth, vec2i(pixel), 0);
  if (depth <= 0.0) { return false; }
  let gap = distance(worldFromDepth(pixel, depth), world);
  return gap <= 0.06 + 0.004 * distance(view.eye.xyz, world);
}

// What the light already in the emissive target should be multiplied by when a colour is painted over the surface.
fn paintLightRatio(painted: vec3f, under: vec3f, amount: f32) -> vec3f {
  let ratio = min(painted / max(under, vec3f(0.04)), vec3f(4.0));
  return mix(vec3f(1.0), ratio, amount);
}
`;

/**
 * Colour and the roughness and metalness of the normal target, by the fragment's alpha. The normal target writes only
 * its last two channels, and blends its alpha to zero: painted surfaces are not metal.
 */
export const PAINT_SURFACE_TARGETS: GPUColorTargetState[] = [
  {
    format: TARGET_FORMATS.albedo,
    blend: {
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
      // Occlusion lives in the alpha and is not paint's to change.
      alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
    },
  },
  {
    format: TARGET_FORMATS.normal,
    writeMask: WRITE_BLUE | WRITE_ALPHA,
    blend: {
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "zero", dstFactor: "one-minus-src-alpha", operation: "add" },
    },
  },
];

/** The light already in a surface, multiplied by the fragment's colour; its model in the alpha is left alone. */
export const PAINT_LIGHT_TARGETS: GPUColorTargetState[] = [
  {
    format: TARGET_FORMATS.emissive,
    blend: {
      color: { srcFactor: "zero", dstFactor: "src", operation: "add" },
      alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
    },
  },
];

export const beginPaintSurface = (frame: GpuFrame, label: string): GPURenderPassEncoder => frame.encoder.beginRenderPass({
  label,
  colorAttachments: [
    { view: frame.targets.albedo.view, loadOp: "load", storeOp: "store" },
    { view: frame.targets.normal.view, loadOp: "load", storeOp: "store" },
  ],
});

export const beginPaintLight = (frame: GpuFrame, label: string): GPURenderPassEncoder => frame.encoder.beginRenderPass({
  label,
  colorAttachments: [{ view: frame.targets.emissive.view, loadOp: "load", storeOp: "store" }],
});

/** Pipelines and modules for a device, compiled off the frame: a pipeline not ready yet is null and is asked for again. */
export class EffectPipelines {
  private readonly modules = new Map<string, GPUShaderModule>();
  private readonly renders = new Map<string, GPURenderPipeline | null>();
  private readonly computes = new Map<string, GPUComputePipeline | null>();

  constructor(private readonly device: GPUDevice) {}

  module(key: string, code: () => string): GPUShaderModule {
    let module = this.modules.get(key);
    if (!module) {
      module = this.device.createShaderModule({ label: `gpu effect ${key}`, code: code() });
      this.modules.set(key, module);
    }
    return module;
  }

  render(key: string, describe: () => GPURenderPipelineDescriptor): GPURenderPipeline | null {
    if (this.renders.has(key)) return this.renders.get(key) ?? null;
    this.renders.set(key, null);
    this.device.createRenderPipelineAsync({ label: `gpu effect ${key}`, ...describe() }).then((pipeline) => {
      this.renders.set(key, pipeline);
    }).catch((error: unknown) => {
      reportGpu(`[gpu] effect pipeline ${key} failed`, error);
    });
    return null;
  }

  compute(key: string, describe: () => GPUComputePipelineDescriptor): GPUComputePipeline | null {
    if (this.computes.has(key)) return this.computes.get(key) ?? null;
    this.computes.set(key, null);
    this.device.createComputePipelineAsync({ label: `gpu effect ${key}`, ...describe() }).then((pipeline) => {
      this.computes.set(key, pipeline);
    }).catch((error: unknown) => {
      reportGpu(`[gpu] effect pipeline ${key} failed`, error);
    });
    return null;
  }
}

const pipelinesByDevice = new WeakMap<GPUDevice, EffectPipelines>();

export const effectPipelinesFor = (device: GPUDevice): EffectPipelines => {
  let pipelines = pipelinesByDevice.get(device);
  if (!pipelines) {
    pipelines = new EffectPipelines(device);
    pipelinesByDevice.set(device, pipelines);
  }
  return pipelines;
};

/**
 * Bind groups by what they hold. Views change with the camera and the screen size, so one pass needs several and goes
 * back and forth between them; the oldest are let go.
 */
export class BindGroupCache {
  private readonly entries: { key: readonly unknown[]; group: GPUBindGroup }[] = [];

  constructor(private readonly keep = 16) {}

  get(key: readonly unknown[], make: () => GPUBindGroup): GPUBindGroup {
    const { entries } = this;
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (entry.key.length === key.length && entry.key.every((value, at) => value === key[at])) return entry.group;
    }
    const group = make();
    entries.unshift({ key: [...key], group });
    if (entries.length > this.keep) entries.pop();
    return group;
  }

  clear(): void {
    this.entries.length = 0;
  }
}

/** A texture the size of the targets that a target is copied into, one per size in use. */
export class TargetCopy {
  private readonly copies = new Map<string, { texture: GPUTexture; view: GPUTextureView }>();

  constructor(private readonly device: GPUDevice, private readonly label: string, private readonly format: GPUTextureFormat) {}

  /** Records the copy of `source` and returns what it was copied to. */
  take(frame: GpuFrame, source: GPUTexture): GPUTextureView {
    const { width, height } = frame.targets;
    const key = `${width}x${height}`;
    let copy = this.copies.get(key);
    if (!copy) {
      const texture = this.device.createTexture({
        label: this.label,
        size: [width, height],
        format: this.format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      copy = { texture, view: texture.createView() };
      this.copies.set(key, copy);
    }
    frame.encoder.copyTextureToTexture({ texture: source }, { texture: copy.texture }, [width, height]);
    return copy.view;
  }

  destroy(): void {
    for (const copy of this.copies.values()) copy.texture.destroy();
    this.copies.clear();
  }
}

/** A run of uniform slices, one per thing drawn, far enough apart for a dynamic offset on any device. */
export class UniformSlices {
  readonly stride: number;
  buffer: GPUBuffer;
  readonly data: Float32Array;
  readonly words: Uint32Array;
  private capacity: number;
  /** Goes up when `buffer` is replaced. */
  generation = 0;

  constructor(private readonly device: GPUDevice, private readonly label: string, private readonly bytes: number, initial = 8) {
    const alignment = device.limits.minUniformBufferOffsetAlignment;
    this.stride = Math.ceil(bytes / alignment) * alignment;
    this.capacity = initial;
    this.buffer = this.make();
    this.data = new Float32Array(bytes / 4);
    this.words = new Uint32Array(this.data.buffer);
  }

  private make(): GPUBuffer {
    return this.device.createBuffer({ label: this.label, size: this.capacity * this.stride, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  ensure(count: number): void {
    if (count <= this.capacity) return;
    this.buffer.destroy();
    this.capacity = Math.max(count, this.capacity * 2);
    this.buffer = this.make();
    this.generation++;
  }

  /** Sends `data` as slice `index`, and returns the slice's dynamic offset. */
  write(index: number): number {
    const offset = index * this.stride;
    this.device.queue.writeBuffer(this.buffer, offset, this.data);
    return offset;
  }

  /** What a bind group gives the shader: one slice, moved by the dynamic offset. */
  get binding(): GPUBufferBinding {
    return { buffer: this.buffer, offset: 0, size: this.bytes };
  }

  destroy(): void {
    this.buffer.destroy();
  }
}

/** Whether an object is drawn: it and everything above it visible, and it in this scene. */
export const isDrawnIn = (object: THREE.Object3D | null | undefined, scene: THREE.Object3D): boolean => {
  let current = object ?? null;
  if (!current) return false;
  while (current.parent) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return current === scene && current.visible;
};

/** An effect: the passes it keeps on the renderer while anything wants it. */
export interface GpuEffect {
  readonly passes: readonly GpuPass[];
  dispose?(): void;
}

interface HeldEffect {
  effect: GpuEffect;
  users: number;
}

const heldByRenderer = new WeakMap<GpuRendererApi, Map<string, HeldEffect>>();

/** Keeps the effect named `id` on the renderer, making it if this is the first to want it. */
export const retainEffect = <T extends GpuEffect>(api: GpuRendererApi, id: string, make: (api: GpuRendererApi) => T): { effect: T; release: () => void } => {
  let held = heldByRenderer.get(api);
  if (!held) {
    held = new Map();
    heldByRenderer.set(api, held);
  }
  let entry = held.get(id);
  if (!entry) {
    entry = { effect: make(api), users: 0 };
    held.set(id, entry);
    for (const pass of entry.effect.passes) api.addPass(pass);
  }
  entry.users++;
  const owned = entry;
  const map = held;
  let released = false;
  return {
    effect: owned.effect as T,
    release: () => {
      if (released) return;
      released = true;
      owned.users--;
      if (owned.users > 0) return;
      map.delete(id);
      for (const pass of owned.effect.passes) {
        api.removePass(pass);
        pass.dispose?.();
      }
      owned.effect.dispose?.();
    },
  };
};

/** An effect that draws a list of entries. */
export interface GpuEntryEffect<E> extends GpuEffect {
  readonly entries: Set<E>;
}

/** Puts `entry` on the effect named `id` for as long as the component is mounted, on the GPU renderer only. */
export const useEffectEntry = <E, T extends GpuEntryEffect<E>>(id: string, make: (api: GpuRendererApi) => T, entry: E | null): void => {
  const gl = useThree((state) => state.gl) as unknown;
  useEffect(() => {
    if (!entry || !isGpuRenderer(gl)) return;
    const { effect, release } = retainEffect(gl, id, make);
    effect.entries.add(entry);
    return () => {
      effect.entries.delete(entry);
      release();
    };
    // `make` is a constant of the effect's file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, id, entry]);
};

/** The GPU renderer, or null on any other. */
export const useGpuRenderer = (): GpuRendererApi | null => {
  const gl = useThree((state) => state.gl) as unknown;
  return isGpuRenderer(gl) ? gl : null;
};
