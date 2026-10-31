/// <reference types="@webgpu/types" />
import type { GpuCore } from "../device";
import type { GpuFrame, GpuPass } from "../frame";
import { CLUSTER_COUNT, LIGHTING_CLUSTER_WGSL, LIGHTING_TYPES_WGSL, LightingResources } from "../lightingWgsl";

/**
 * LIGHT CLUSTERS
 *
 * Which lights can reach which part of the screen. The view is cut into a grid: 16 tiles across, 9 down, 24 slices of
 * depth, each thicker than the last by the same factor, because a pixel's size in the world grows with distance. Each
 * cell holds one bit per light, in as many 32-bit words as this frame's lights need, and a pixel then loops over the set
 * bits of its own cell. That is what lets thousands of small lights cost about what the few near each pixel cost.
 *
 * Every light takes one compute invocation, so a small light's cost is the few cells it touches rather than the whole
 * grid. A light goes straight to the cells its sphere can overlap and tests its sphere against each one's box in view
 * space; a spot light also tests its cone against the cell.
 *
 * This pass uploads the frame's lights and publishes frame.products "lighting" (lightingWgsl.ts).
 */

const WORKGROUP_LIGHTS = 32;

const CLUSTER_BUILD_WGSL = /* wgsl */ `
${LIGHTING_TYPES_WGSL}
@group(0) @binding(0) var<uniform> lighting: LightingUniforms;
@group(0) @binding(1) var<storage, read> lightingLocals: array<LocalLight>;
@group(0) @binding(2) var<storage, read_write> clusterBits: array<atomic<u32>>;
${LIGHTING_CLUSTER_WGSL}

// Where a stretch of a view axis, from low to high, can land on the screen between two depths, as low and high ndc.
// A positive coordinate lands nearest the centre at the far depth, a negative one at the near depth.
fn screenSpan(low: f32, high: f32, scale: f32, shift: f32, nearDepth: f32, farDepth: f32) -> vec2f {
  if (lighting.orthographic != 0u) { return vec2f(low, high) * scale - shift; }
  let least = low / select(nearDepth, farDepth, low >= 0.0);
  let most = high / select(farDepth, nearDepth, high >= 0.0);
  return vec2f(least, most) * scale - shift;
}

// How far a tile's edges, in ndc, reach along a view axis across a cell's depth: the box holds the widest of both ends.
fn cellSpan(ndcLow: f32, ndcHigh: f32, scale: f32, shift: f32, nearDepth: f32, farDepth: f32) -> vec2f {
  let low = (ndcLow + shift) / scale;
  let high = (ndcHigh + shift) / scale;
  if (lighting.orthographic != 0u) { return vec2f(low, high); }
  return vec2f(min(low * nearDepth, low * farDepth), max(high * nearDepth, high * farDepth));
}

// Whether a cell, taken as a sphere around its box, lies wholly outside a cone: off its side, past its end or behind it.
fn outsideCone(low: vec3f, high: vec3f, tip: vec3f, axis: vec3f, coneCos: f32, coneSin: f32, reach: f32) -> bool {
  let center = (low + high) * 0.5 - tip;
  let radius = length(high - low) * 0.5;
  let along = dot(center, axis);
  let aside = sqrt(max(dot(center, center) - along * along, 0.0));
  return coneCos * aside - along * coneSin > radius || along > radius + reach || along < -radius;
}

@compute @workgroup_size(${WORKGROUP_LIGHTS})
fn buildClusters(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= lighting.localCount) { return; }
  let light = lightingLocals[index];
  let radius = light.cullRadius;
  if (radius <= 0.0) { return; }

  // Below, z is depth: it grows away from the camera, where view z grows toward it.
  let sphere = lighting.clusterView * vec4f(light.cullCenter, 1.0);
  let center = vec3f(sphere.xy, -sphere.z);
  if (center.z + radius < lighting.clusterDepth.x || center.z - radius > lighting.clusterDepth.z) { return; }

  // A cone wider than a hemisphere has no sides to test.
  let hasCone = light.coneCos > 0.0;
  let tipView = lighting.clusterView * vec4f(light.position, 1.0);
  let axisView = lighting.clusterView * vec4f(-light.direction, 0.0);
  let tip = vec3f(tipView.xy, -tipView.z);
  let axis = vec3f(axisView.xy, -axisView.z);
  let coneSin = sqrt(max(1.0 - light.coneCos * light.coneCos, 0.0));

  let projection = lighting.clusterProjection;
  let word = index / 32u;
  let bit = 1u << (index % 32u);
  let firstSlice = lightingSliceOf(center.z - radius);
  let lastSlice = lightingSliceOf(center.z + radius);
  for (var z = firstSlice; z <= lastSlice; z++) {
    let nearDepth = lightingSliceDepth(z);
    let farDepth = lightingSliceDepth(z + 1u);
    // The part of the sphere in this slice decides which tiles it can touch.
    let reachNear = max(nearDepth, center.z - radius);
    let reachFar = min(farDepth, center.z + radius);
    if (reachNear > reachFar) { continue; }
    let across = screenSpan(center.x - radius, center.x + radius, projection.x, projection.z, reachNear, reachFar);
    let down = screenSpan(center.y - radius, center.y + radius, projection.y, projection.w, reachNear, reachFar);
    if (across.y < -1.0 || across.x > 1.0 || down.y < -1.0 || down.x > 1.0) { continue; }

    let gridX = f32(LIGHTING_GRID_X);
    let gridY = f32(LIGHTING_GRID_Y);
    let firstX = u32(clamp((across.x + 1.0) * 0.5 * gridX, 0.0, gridX - 1.0));
    let lastX = u32(clamp((across.y + 1.0) * 0.5 * gridX, 0.0, gridX - 1.0));
    // Rows count down from the top of the screen, so the highest ndc is the first row.
    let firstY = u32(clamp((1.0 - down.y) * 0.5 * gridY, 0.0, gridY - 1.0));
    let lastY = u32(clamp((1.0 - down.x) * 0.5 * gridY, 0.0, gridY - 1.0));

    for (var y = firstY; y <= lastY; y++) {
      let ySpan = cellSpan(1.0 - 2.0 * f32(y + 1u) / gridY, 1.0 - 2.0 * f32(y) / gridY, projection.y, projection.w, nearDepth, farDepth);
      for (var x = firstX; x <= lastX; x++) {
        let xSpan = cellSpan(2.0 * f32(x) / gridX - 1.0, 2.0 * f32(x + 1u) / gridX - 1.0, projection.x, projection.z, nearDepth, farDepth);
        let low = vec3f(xSpan.x, ySpan.x, nearDepth);
        let high = vec3f(xSpan.y, ySpan.y, farDepth);
        let gap = center - clamp(center, low, high);
        if (dot(gap, gap) > radius * radius) { continue; }
        if (hasCone && outsideCone(low, high, tip, axis, light.coneCos, coneSin, light.cullRange)) { continue; }
        let cluster = x + LIGHTING_GRID_X * (y + LIGHTING_GRID_Y * z);
        atomicOr(&clusterBits[cluster * lighting.wordsPerCluster + word], bit);
      }
    }
  }
}
`;

export class LightClusterPass implements GpuPass {
  readonly id = "light-clusters";
  readonly stage = "afterSurfaces";
  readonly order = 10;
  /** Owns what the lighting group binds; the same object frame.products "lighting" names. */
  readonly resources: LightingResources;

  private readonly pipeline: GPUComputePipeline;
  private readonly bindGroup: GPUBindGroup;

  constructor(core: GpuCore) {
    const { device } = core;
    this.resources = new LightingResources(core);
    const layout = device.createBindGroupLayout({
      label: "gpu cluster build",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    this.pipeline = device.createComputePipeline({
      label: "gpu cluster build",
      layout: device.createPipelineLayout({ label: "gpu cluster build", bindGroupLayouts: [layout] }),
      compute: {
        module: device.createShaderModule({ label: "gpu cluster build", code: CLUSTER_BUILD_WGSL }),
        entryPoint: "buildClusters",
      },
    });
    this.bindGroup = device.createBindGroup({
      label: "gpu cluster build",
      layout,
      entries: [
        { binding: 0, resource: { buffer: this.resources.uniformBuffer } },
        { binding: 1, resource: { buffer: this.resources.localBuffer } },
        { binding: 2, resource: { buffer: this.resources.clusterBuffer } },
      ],
    });
  }

  execute(frame: GpuFrame): void {
    const { resources } = this;
    resources.refresh(frame);
    if (!resources.localCount) return;
    // Only as much of the grid as this frame reads: the words per cluster move with the number of lights.
    frame.encoder.clearBuffer(resources.clusterBuffer, 0, CLUSTER_COUNT * resources.wordsPerCluster * 4);
    const pass = frame.encoder.beginComputePass({ label: "gpu cluster build" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(resources.localCount / WORKGROUP_LIGHTS));
    pass.end();
  }

  dispose(): void {
    this.resources.destroy();
  }
}
