/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { TARGET_FORMATS, type GpuFrame } from "../frame";
import type { MaterialEntry } from "../materialPool";
import { shadowShader, surfaceBufferShader } from "../shaders";
import type { SurfaceKind } from "../surfaces";
import { effectPipelinesFor } from "./common";

/**
 * DRAWING MATERIALS FROM ELSEWHERE
 *
 * For effects that draw pool materials with instance tables of their own (scatter, probes, baking an impostor), by the
 * same shaders the surface pass compiles. Group 1 is theirs: their rows, with the geometry pool's vertices.
 */

/** The one vertex buffer: each drawn instance's row number. */
export const INSTANCE_ROW_SLOT: GPUVertexBufferLayout = {
  arrayStride: 4,
  stepMode: "instance",
  attributes: [{ shaderLocation: 0, offset: 0, format: "uint32" }],
};

const SURFACE_TARGETS: GPUColorTargetState[] = [
  { format: TARGET_FORMATS.albedo },
  { format: TARGET_FORMATS.normal },
  { format: TARGET_FORMATS.emissive },
  { format: TARGET_FORMATS.motion },
];

// Where a displaced vertex was last frame is where it is now, moved only by its row and the camera. The vertex path
// asks for the undisplaced one, which for a billboard is nowhere near it.
const MOTION_UNDISPLACED = "previousWorldOf(instance, previousLocal)";
const MOTION_DISPLACED = "previousWorldOf(instance, local)";

const surfaceCode = (kind: SurfaceKind): string => {
  const code = surfaceBufferShader(kind);
  return kind.displaces ? code.replace(MOTION_UNDISPLACED, MOTION_DISPLACED) : code;
};

const cutouts = new Map<string, SurfaceKind>();

/**
 * A kind that blends has no place in the surface buffer, so where one must be drawn there it is cut out at half its
 * opacity instead, which for foliage is what the picture meant. It binds what the kind it comes from binds.
 */
const cutoutOf = (kind: SurfaceKind): SurfaceKind => {
  let cut = cutouts.get(kind.id);
  if (!cut) {
    cut = {
      ...kind,
      id: `${kind.id}:cutout`,
      wgsl: `${kind.wgsl.replace("fn surface(", "fn surfaceBeforeCut(")}
fn surface(in: SurfaceIn) -> SurfaceOut {
  var out = surfaceBeforeCut(in);
  out.alphaTest = max(out.alphaTest, 0.5);
  return out;
}
`,
    };
    cutouts.set(kind.id, cut);
  }
  return cut;
};

/** What decides a surface pipeline, for a kind drawn without a pool material. */
export interface DrawnSurface {
  kind: SurfaceKind;
  cull: GPUCullMode;
  /** Whether it blends: drawn cut out. */
  transparent?: boolean;
  masked?: boolean;
  depthBias?: number;
  depthBiasSlope?: number;
}

export const drawnSurfaceOf = ({ kind, state }: MaterialEntry): DrawnSurface => ({
  kind,
  cull: state.cull,
  transparent: state.transparent,
  masked: state.masked,
  depthBias: state.depthBias,
  depthBiasSlope: state.depthBiasSlope,
});

/**
 * The pipeline drawing into the surface targets, or null while it compiles. `frontFace` is for a view that mirrors the
 * world, such as a cube map's face.
 */
export const surfacePipelineFor = (frame: GpuFrame, surface: DrawnSurface, frontFace: GPUFrontFace = "ccw"): GPURenderPipeline | null => {
  const kind = surface.transparent ? cutoutOf(surface.kind) : surface.kind;
  // A polygon offset pushes away from the eye, and with reversed depth that is towards smaller numbers.
  const depthBias = Math.round(-(surface.depthBias ?? 0));
  const depthBiasSlopeScale = -(surface.depthBiasSlope ?? 0);
  const pipelines = effectPipelinesFor(frame.device);
  return pipelines.render(`surface ${kind.id} ${surface.cull} ${frontFace} ${depthBias} ${depthBiasSlopeScale}`, () => {
    const module = pipelines.module(`surface ${kind.id}`, () => surfaceCode(kind));
    return {
      layout: frame.device.createPipelineLayout({
        label: `gpu effect surface ${kind.id}`,
        bindGroupLayouts: [frame.cameraLayout, frame.sceneLayout, frame.materials.layoutFor(surface.kind)],
      }),
      vertex: { module, entryPoint: "vertexMain", buffers: [INSTANCE_ROW_SLOT] },
      fragment: { module, entryPoint: "fragmentMain", targets: SURFACE_TARGETS },
      primitive: { topology: "triangle-list", cullMode: surface.cull, frontFace },
      depthStencil: { format: TARGET_FORMATS.depth, depthWriteEnabled: true, depthCompare: "greater", depthBias, depthBiasSlopeScale },
    };
  });
};

/** Which faces a depth view draws, as three.js chooses them: the far side of what the material shows. */
export const depthCullOf = (entry: MaterialEntry): GPUCullMode => {
  const side = entry.material.shadowSide;
  if (side === null || side === undefined) return entry.state.cull === "back" ? "front" : entry.state.cull === "front" ? "back" : "none";
  return side === THREE.DoubleSide ? "none" : side === THREE.BackSide ? "front" : "back";
};

export interface DepthDraw {
  pipeline: GPURenderPipeline;
  /** A depth-only pipeline that runs no surface code binds no material. */
  bindsMaterial: boolean;
}

/** The pipeline drawing into a depth-only pass, or null while it compiles. */
export const depthPipelineFor = (frame: GpuFrame, surface: DrawnSurface, cull: GPUCullMode, format: GPUTextureFormat, bias: number, slope: number): DepthDraw | null => {
  const kind = surface.transparent ? cutoutOf(surface.kind) : surface.kind;
  const masked = !!surface.masked || !!surface.transparent;
  const runsSurface = masked || !!kind.displaces;
  const depthBias = Math.round(bias - (surface.depthBias ?? 0));
  const depthBiasSlopeScale = slope - (surface.depthBiasSlope ?? 0);
  const pipelines = effectPipelinesFor(frame.device);
  const pipeline = pipelines.render(`depth ${runsSurface ? kind.id : ""} ${masked} ${cull} ${format} ${depthBias} ${depthBiasSlopeScale}`, () => {
    const module = runsSurface
      ? pipelines.module(`depth ${kind.id} ${masked}`, () => shadowShader(kind, masked))
      : pipelines.module("depth plain", () => shadowShader(kind, false));
    const bindGroupLayouts = runsSurface ? [frame.cameraLayout, frame.sceneLayout, frame.materials.layoutFor(surface.kind)] : [frame.cameraLayout, frame.sceneLayout];
    return {
      layout: frame.device.createPipelineLayout({ label: "gpu effect depth", bindGroupLayouts }),
      vertex: { module, entryPoint: "vertexMain", buffers: [INSTANCE_ROW_SLOT] },
      fragment: runsSurface ? { module, entryPoint: "fragmentMain", targets: [] } : undefined,
      primitive: { topology: "triangle-list", cullMode: cull, frontFace: "ccw", unclippedDepth: frame.core.features.depthClipControl },
      depthStencil: { format, depthWriteEnabled: true, depthCompare: "greater", depthBias, depthBiasSlopeScale },
    };
  });
  return pipeline ? { pipeline, bindsMaterial: runsSurface } : null;
};
