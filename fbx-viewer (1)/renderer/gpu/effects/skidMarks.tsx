/// <reference types="@webgpu/types" />
import React, { useMemo } from "react";
import type * as THREE from "three";
import { useThree } from "@react-three/fiber";
import type { GpuFrame, GpuPass } from "../frame";
import { BindGroupCache, PAINT_LIGHT_TARGETS, PAINT_REACH_WGSL, PAINT_SURFACE_TARGETS, VIEW_HEAD_WGSL, WORLD_FROM_DEPTH_WGSL, beginPaintLight, beginPaintSurface, effectPipelinesFor, useEffectEntry, type GpuEntryEffect } from "./common";

/**
 * TYRE MARKS
 *
 * The session's ring of quads (SkidMarkBuffer in runtime/skidMarks.ts), painted into the surface buffer so that rubber
 * on a road is dark by the road's light: an unlit mark would glow at night. Only the quads laid since the last frame are
 * sent, and the vertices are read straight from those two buffers: a mesh would send its whole ring every time a wheel
 * moved.
 */

const SKID_ORDER = 21;
const POSITION_WORDS_PER_QUAD = 12;
const COLOR_WORDS_PER_QUAD = 16;

const SKID_WGSL = /* wgsl */ `
${VIEW_HEAD_WGSL}
@group(2) @binding(0) var<storage, read> markPositions: array<f32>;
@group(2) @binding(1) var<storage, read> markColors: array<f32>;
@group(2) @binding(2) var surfaceDepth: texture_depth_2d;
@group(2) @binding(3) var underAlbedo: texture_2d<f32>;

${WORLD_FROM_DEPTH_WGSL}
${PAINT_REACH_WGSL}

struct MarkVarying {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) color: vec4f,
}

@vertex fn markVertex(@builtin(vertex_index) index: u32) -> MarkVarying {
  var corners = array<u32, 6>(0u, 1u, 2u, 2u, 1u, 3u);
  let corner = (index / 6u) * 4u + corners[index % 6u];
  let world = vec3f(markPositions[corner * 3u], markPositions[corner * 3u + 1u], markPositions[corner * 3u + 2u]);
  var out: MarkVarying;
  out.clip = view.viewProjection * vec4f(world, 1.0);
  out.world = world;
  out.color = vec4f(markColors[corner * 4u], markColors[corner * 4u + 1u], markColors[corner * 4u + 2u], markColors[corner * 4u + 3u]);
  return out;
}

struct PaintOut {
  @location(0) albedo: vec4f,
  @location(1) surface: vec4f,
}

@fragment fn markSurface(in: MarkVarying) -> PaintOut {
  if (!paintReaches(in.clip.xy, in.world)) { discard; }
  var out: PaintOut;
  out.albedo = in.color;
  // Rubber is dull, and not metal.
  out.surface = vec4f(0.0, 0.0, 0.85, in.color.a);
  return out;
}

@fragment fn markLight(in: MarkVarying) -> @location(0) vec4f {
  if (!paintReaches(in.clip.xy, in.world)) { discard; }
  let under = textureLoad(underAlbedo, vec2i(in.clip.xy), 0).rgb;
  return vec4f(paintLightRatio(in.color.rgb, under, in.color.a), 1.0);
}
`;

/** The part of a SkidMarkBuffer this reads. */
export interface GpuSkidSource {
  readonly capacity: number;
  readonly positions: Float32Array;
  readonly colors: Float32Array;
  next: number;
  count: number;
}

export class GpuSkidEntry {
  positions: GPUBuffer | null = null;
  colors: GPUBuffer | null = null;
  sentNext = 0;
  sentCount = 0;

  constructor(readonly scene: THREE.Object3D, readonly source: GpuSkidSource) {}

  /** Sends the quads laid since last time, wrapping round the ring. */
  send(device: GPUDevice): void {
    const { source } = this;
    if (!this.positions || !this.colors) {
      this.positions = device.createBuffer({ label: "gpu tyre mark positions", size: source.positions.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.colors = device.createBuffer({ label: "gpu tyre mark colours", size: source.colors.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.sentNext = 0;
      this.sentCount = 0;
    }
    if (source.count < this.sentCount) {
      // Cleared.
      this.sentNext = 0;
      this.sentCount = 0;
    }
    if (source.next === this.sentNext && source.count === this.sentCount) return;
    const sendRun = (first: number, quads: number) => {
      if (quads <= 0) return;
      device.queue.writeBuffer(this.positions!, first * POSITION_WORDS_PER_QUAD * 4, source.positions, first * POSITION_WORDS_PER_QUAD, quads * POSITION_WORDS_PER_QUAD);
      device.queue.writeBuffer(this.colors!, first * COLOR_WORDS_PER_QUAD * 4, source.colors, first * COLOR_WORDS_PER_QUAD, quads * COLOR_WORDS_PER_QUAD);
    };
    if (source.next >= this.sentNext) {
      sendRun(this.sentNext, source.next - this.sentNext);
    } else {
      sendRun(this.sentNext, source.capacity - this.sentNext);
      sendRun(0, source.next);
    }
    this.sentNext = source.next;
    this.sentCount = source.count;
  }

  destroy(): void {
    this.positions?.destroy();
    this.colors?.destroy();
    this.positions = null;
    this.colors = null;
  }
}

class SkidPass implements GpuPass {
  readonly id = "effect-skid-marks";
  readonly stage = "surfaces" as const;
  readonly order = SKID_ORDER;
  private layouts: { surface: GPUBindGroupLayout; light: GPUBindGroupLayout } | null = null;
  private readonly surfaceGroups = new BindGroupCache();
  private readonly lightGroups = new BindGroupCache();

  constructor(private readonly entries: Set<GpuSkidEntry>) {}

  execute(frame: GpuFrame): void {
    const { device } = frame;
    for (const entry of this.entries) {
      if (entry.scene !== frame.scene) continue;
      entry.send(device);
      if (entry.source.count > 0) this.drawEntry(frame, entry);
    }
  }

  private drawEntry(frame: GpuFrame, entry: GpuSkidEntry): void {
    const { device } = frame;
    const layouts = this.layouts ?? (this.layouts = this.makeLayouts(device));
    const pipelines = effectPipelinesFor(device);
    const module = pipelines.module("skid", () => SKID_WGSL);
    const pipeline = (key: string, entryPoint: string, layout: GPUBindGroupLayout, targets: GPUColorTargetState[]) => pipelines.render(key, () => ({
      layout: device.createPipelineLayout({ label: `gpu ${key}`, bindGroupLayouts: [frame.cameraLayout, frame.sceneLayout, layout] }),
      vertex: { module, entryPoint: "markVertex" },
      fragment: { module, entryPoint, targets },
      primitive: { topology: "triangle-list", cullMode: "none" },
    }));
    const surfacePipeline = pipeline("skid surface", "markSurface", layouts.surface, PAINT_SURFACE_TARGETS);
    const lightPipeline = pipeline("skid light", "markLight", layouts.light, PAINT_LIGHT_TARGETS);
    if (!surfacePipeline || !lightPipeline) return;

    const { albedo, depth } = frame.targets;
    const positions = entry.positions!;
    const colors = entry.colors!;
    const buffers: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: positions } }, { binding: 1, resource: { buffer: colors } }];
    const surfaceGroup = this.surfaceGroups.get([positions, depth.view], () => device.createBindGroup({
      label: "gpu tyre marks",
      layout: layouts.surface,
      entries: [...buffers, { binding: 2, resource: depth.view }],
    }));
    const lightGroup = this.lightGroups.get([positions, depth.view, albedo.view], () => device.createBindGroup({
      label: "gpu tyre marks",
      layout: layouts.light,
      entries: [...buffers, { binding: 2, resource: depth.view }, { binding: 3, resource: albedo.view }],
    }));
    const vertices = entry.source.count * 6;
    const light = beginPaintLight(frame, "gpu tyre mark light");
    light.setPipeline(lightPipeline);
    light.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    light.setBindGroup(1, frame.sceneBindGroup);
    light.setBindGroup(2, lightGroup);
    light.draw(vertices);
    light.end();
    const surface = beginPaintSurface(frame, "gpu tyre marks");
    surface.setPipeline(surfacePipeline);
    surface.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    surface.setBindGroup(1, frame.sceneBindGroup);
    surface.setBindGroup(2, surfaceGroup);
    surface.draw(vertices);
    surface.end();
  }

  private makeLayouts(device: GPUDevice) {
    const buffer = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } });
    const depth: GPUBindGroupLayoutEntry = { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } };
    return {
      surface: device.createBindGroupLayout({ label: "gpu tyre marks", entries: [buffer(0), buffer(1), depth] }),
      light: device.createBindGroupLayout({
        label: "gpu tyre mark light",
        entries: [buffer(0), buffer(1), depth, { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } }],
      }),
    };
  }

  dispose(): void {
    for (const entry of this.entries) entry.destroy();
  }
}

class SkidEffect implements GpuEntryEffect<GpuSkidEntry> {
  readonly entries = new Set<GpuSkidEntry>();
  readonly passes = [new SkidPass(this.entries)];
}

const makeSkidMarks = (): SkidEffect => new SkidEffect();

/** Draws a ring of tyre marks, in the place of its mesh. */
export const GpuSkidMarks: React.FC<{ source: GpuSkidSource }> = ({ source }) => {
  const scene = useThree((state) => state.scene);
  const entry = useMemo(() => new GpuSkidEntry(scene, source), [scene, source]);
  useEffectEntry("skid-marks", makeSkidMarks, entry);
  return null;
};
