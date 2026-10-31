/// <reference types="@webgpu/types" />
import { useEffect, useMemo } from "react";
import type * as THREE from "three";
import { useThree } from "@react-three/fiber";
import type { GpuFrame, GpuPass } from "../frame";
import { BindGroupCache, EFFECT_HEAD_WGSL, PAINT_LIGHT_TARGETS, PAINT_REACH_WGSL, PAINT_SURFACE_TARGETS, WORLD_FROM_DEPTH_WGSL, beginPaintLight, beginPaintSurface, effectPipelinesFor, isDrawnIn, useEffectEntry, useGpuRenderer, type GpuEntryEffect } from "./common";

/**
 * DECALS
 *
 * A decal is painted into the surface buffer after the surface pass, so it takes the light, the shadows and the bounce
 * of whatever it lies on. Which triangles it lands on is still the projector's business on the CPU (DecalProjector in
 * runtime/components/decalComponent.tsx): that is what keeps it on its own object, and off anything skinned walking
 * through its box. This draws the geometry it built, in the place of the transparent mesh the WebGL path draws.
 */

const DECAL_ORDER = 20;
const ROW_WORDS = 16;
const INITIAL_ROWS = 64;

const DECAL_WGSL = /* wgsl */ `
${EFFECT_HEAD_WGSL}
struct DecalRow {
  world0: vec4f,
  world1: vec4f,
  world2: vec4f,
  color: vec4f,
}
@group(2) @binding(0) var<storage, read> rows: array<DecalRow>;
@group(2) @binding(1) var surfaceDepth: texture_depth_2d;
@group(2) @binding(2) var underAlbedo: texture_2d<f32>;
@group(3) @binding(0) var decalMap: texture_2d<f32>;
@group(3) @binding(1) var decalSampler: sampler;

${WORLD_FROM_DEPTH_WGSL}
${PAINT_REACH_WGSL}

struct DecalVarying {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) uv: vec2f,
  @location(2) @interpolate(flat) row: u32,
}

@vertex fn decalVertex(@builtin(vertex_index) index: u32, @builtin(instance_index) row: u32) -> DecalVarying {
  let v = vertices[index];
  let at = vec4f(v.px, v.py, v.pz, 1.0);
  let decal = rows[row];
  let world = vec3f(dot(decal.world0, at), dot(decal.world1, at), dot(decal.world2, at));
  var out: DecalVarying;
  out.clip = view.viewProjection * vec4f(world, 1.0);
  out.world = world;
  out.uv = vec2f(v.u0, v.v0);
  out.row = row;
  return out;
}

struct Painted {
  color: vec3f,
  amount: f32,
}

fn paintedAt(in: DecalVarying) -> Painted {
  // Read before anything can be turned away: the sampling has to happen on every pixel for its slope to mean anything.
  let texel = textureSample(decalMap, decalSampler, in.uv);
  let tint = rows[in.row].color;
  var out: Painted;
  out.color = texel.rgb * tint.rgb;
  out.amount = select(0.0, texel.a * tint.a, paintReaches(in.clip.xy, in.world));
  return out;
}

struct PaintOut {
  @location(0) albedo: vec4f,
  @location(1) surface: vec4f,
}

@fragment fn decalSurface(in: DecalVarying) -> PaintOut {
  let painted = paintedAt(in);
  if (painted.amount <= 0.0) { discard; }
  var out: PaintOut;
  out.albedo = vec4f(painted.color, painted.amount);
  // The WebGL decal is a plain standard material: as rough as they come, and not metal.
  out.surface = vec4f(0.0, 0.0, 1.0, painted.amount);
  return out;
}

@fragment fn decalLight(in: DecalVarying) -> @location(0) vec4f {
  let painted = paintedAt(in);
  if (painted.amount <= 0.0) { discard; }
  let under = textureLoad(underAlbedo, vec2i(in.clip.xy), 0).rgb;
  return vec4f(paintLightRatio(painted.color, under, painted.amount), 1.0);
}
`;

/** The part of a DecalProjector this needs. */
export interface GpuDecalSource {
  mesh: THREE.Mesh;
}

export class GpuDecalEntry {
  constructor(readonly scene: THREE.Object3D, readonly mesh: THREE.Mesh) {}
}

interface DecalDraw {
  row: number;
  firstIndex: number;
  indexCount: number;
  baseVertex: number;
  map: GPUBindGroup;
}

class DecalPass implements GpuPass {
  readonly id = "effect-decals";
  readonly stage = "surfaces" as const;
  readonly order = DECAL_ORDER;
  private layouts: { surface: GPUBindGroupLayout; light: GPUBindGroupLayout; map: GPUBindGroupLayout } | null = null;
  private rows: GPUBuffer | null = null;
  private data = new Float32Array(INITIAL_ROWS * ROW_WORDS);
  private readonly surfaceGroups = new BindGroupCache();
  private readonly lightGroups = new BindGroupCache();
  private readonly mapGroups = new BindGroupCache(64);
  private readonly draws: DecalDraw[] = [];

  constructor(private readonly entries: Set<GpuDecalEntry>) {}

  execute(frame: GpuFrame): void {
    const { device } = frame;
    const layouts = this.layouts ?? (this.layouts = this.makeLayouts(device));
    const { draws } = this;
    draws.length = 0;
    for (const entry of this.entries) {
      if (entry.scene !== frame.scene || !entry.mesh.visible || !isDrawnIn(entry.mesh, frame.scene)) continue;
      const geometry = frame.geometries.acquire(entry.mesh.geometry);
      if (!geometry?.indexCount) continue;
      const row = draws.length;
      this.writeRow(row, entry.mesh);
      const material = entry.mesh.material as THREE.MeshStandardMaterial;
      const map = (material.map ? frame.textures.acquire(material.map) : null) ?? frame.textures.white;
      draws.push({
        row,
        firstIndex: geometry.indexBase,
        indexCount: geometry.indexCount,
        baseVertex: geometry.vertexBase,
        map: this.mapGroups.get([map.view, map.sampler], () => device.createBindGroup({
          label: "gpu decal map",
          layout: layouts.map,
          entries: [{ binding: 0, resource: map.view }, { binding: 1, resource: map.sampler }],
        })),
      });
    }
    if (!draws.length) return;

    const pipelines = effectPipelinesFor(device);
    const module = pipelines.module("decal", () => DECAL_WGSL);
    const pipeline = (key: string, entryPoint: string, layout: GPUBindGroupLayout, targets: GPUColorTargetState[]) => pipelines.render(key, () => ({
      layout: device.createPipelineLayout({ label: `gpu ${key}`, bindGroupLayouts: [frame.cameraLayout, frame.sceneLayout, layout, layouts.map] }),
      vertex: { module, entryPoint: "decalVertex" },
      fragment: { module, entryPoint, targets },
      // No depth attachment: paintReaches compares by distance. A mirrored owner turns its triangles over, and either way
      // they were chosen to face the projector.
      primitive: { topology: "triangle-list", cullMode: "none" },
    }));
    const surfacePipeline = pipeline("decal surface", "decalSurface", layouts.surface, PAINT_SURFACE_TARGETS);
    const lightPipeline = pipeline("decal light", "decalLight", layouts.light, PAINT_LIGHT_TARGETS);
    if (!surfacePipeline || !lightPipeline) return;

    const rows = this.uploadRows(device, draws.length);
    const { albedo, depth } = frame.targets;
    const surfaceGroup = this.surfaceGroups.get([rows, depth.view], () => device.createBindGroup({
      label: "gpu decal surface",
      layout: layouts.surface,
      entries: [{ binding: 0, resource: { buffer: rows } }, { binding: 1, resource: depth.view }],
    }));
    const lightGroup = this.lightGroups.get([rows, depth.view, albedo.view], () => device.createBindGroup({
      label: "gpu decal light",
      layout: layouts.light,
      entries: [{ binding: 0, resource: { buffer: rows } }, { binding: 1, resource: depth.view }, { binding: 2, resource: albedo.view }],
    }));

    // The light first: it reads the colour that is about to be painted over.
    const light = beginPaintLight(frame, "gpu decal light");
    this.draw(frame, light, lightPipeline, lightGroup);
    light.end();
    const surface = beginPaintSurface(frame, "gpu decal surface");
    this.draw(frame, surface, surfacePipeline, surfaceGroup);
    surface.end();
  }

  private draw(frame: GpuFrame, pass: GPURenderPassEncoder, pipeline: GPURenderPipeline, group: GPUBindGroup): void {
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    pass.setBindGroup(1, frame.sceneBindGroup);
    pass.setBindGroup(2, group);
    pass.setIndexBuffer(frame.geometries.indices.buffer, "uint32");
    for (const draw of this.draws) {
      pass.setBindGroup(3, draw.map);
      pass.drawIndexed(draw.indexCount, 1, draw.firstIndex, draw.baseVertex, draw.row);
    }
  }

  private writeRow(row: number, mesh: THREE.Mesh): void {
    if ((row + 1) * ROW_WORDS > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    const { data } = this;
    const at = row * ROW_WORDS;
    const e = mesh.matrixWorld.elements;
    data[at] = e[0]; data[at + 1] = e[4]; data[at + 2] = e[8]; data[at + 3] = e[12];
    data[at + 4] = e[1]; data[at + 5] = e[5]; data[at + 6] = e[9]; data[at + 7] = e[13];
    data[at + 8] = e[2]; data[at + 9] = e[6]; data[at + 10] = e[10]; data[at + 11] = e[14];
    const material = mesh.material as THREE.MeshStandardMaterial;
    data[at + 12] = material.color.r;
    data[at + 13] = material.color.g;
    data[at + 14] = material.color.b;
    data[at + 15] = material.opacity;
  }

  private uploadRows(device: GPUDevice, count: number): GPUBuffer {
    const bytes = this.data.byteLength;
    if (!this.rows || this.rows.size < bytes) {
      this.rows?.destroy();
      this.rows = device.createBuffer({ label: "gpu decal rows", size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    }
    device.queue.writeBuffer(this.rows, 0, this.data, 0, count * ROW_WORDS);
    return this.rows;
  }

  private makeLayouts(device: GPUDevice) {
    const visibility = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const rows: GPUBindGroupLayoutEntry = { binding: 0, visibility, buffer: { type: "read-only-storage" } };
    const depth: GPUBindGroupLayoutEntry = { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } };
    return {
      surface: device.createBindGroupLayout({ label: "gpu decal surface", entries: [rows, depth] }),
      light: device.createBindGroupLayout({
        label: "gpu decal light",
        entries: [rows, depth, { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } }],
      }),
      map: device.createBindGroupLayout({
        label: "gpu decal map",
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        ],
      }),
    };
  }

  dispose(): void {
    this.rows?.destroy();
    this.rows = null;
  }
}

class DecalEffect implements GpuEntryEffect<GpuDecalEntry> {
  readonly entries = new Set<GpuDecalEntry>();
  readonly passes = [new DecalPass(this.entries)];
}

const makeDecals = (): DecalEffect => new DecalEffect();

/**
 * On the GPU renderer, paints `projector`'s decal into the surface buffer. Its mesh stays in the scene for the projector
 * to keep its geometry on, with its material hidden from the ordinary passes. Does nothing on WebGL.
 */
export const useGpuDecal = (projector: GpuDecalSource): void => {
  const api = useGpuRenderer();
  const scene = useThree((state) => state.scene);
  const { mesh } = projector;
  const entry = useMemo(() => (api ? new GpuDecalEntry(scene, mesh) : null), [api, scene, mesh]);
  useEffectEntry("decals", makeDecals, entry);
  useEffect(() => {
    if (!api) return;
    const material = mesh.material as THREE.Material;
    material.visible = false;
    return () => {
      material.visible = true;
    };
  }, [api, mesh]);
};
