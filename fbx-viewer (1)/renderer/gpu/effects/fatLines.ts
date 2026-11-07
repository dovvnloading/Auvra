/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { TARGET_FORMATS, type GpuFrame, type GpuPass } from "../frame";
import { beginForwardRenderPass, bindForwardView } from "../passes/forward";
import { BindGroupCache, UniformSlices, VIEW_HEAD_WGSL, effectPipelinesFor, type GpuEffect } from "./common";

/**
 * WIDE LINES
 *
 * What drei's Line draws: a line as wide as it likes, used by the nav links, splines and spline handles. Its material is
 * a shader written against vertex data the geometry pool has no place for, one quad repeated with a segment per instance,
 * and WebGPU lines are one pixel wide. So the lines stay in the scene, where the pointer still finds them, and this
 * looks for them there and draws each segment as a quad on the screen from the same numbers. There is nothing to
 * change where they are used, and nothing is looked for until the renderer has met one.
 */

const LINE_ORDER = 20;
const LINE_BYTES = 112;
/** How a line's material names itself to the material pool when nothing can draw it. */
const LINE_MATERIAL_TYPE = "LineMaterial";

const LINE_WGSL = /* wgsl */ `
${VIEW_HEAD_WGSL}
struct WideLine {
  model: mat4x4f,
  color: vec4f,
  // Half its width, in pixels of this picture.
  halfWidth: f32,
}
@group(2) @binding(0) var<uniform> line: WideLine;
// Six numbers each: where the segment starts and where it ends.
@group(2) @binding(1) var<storage, read> segments: array<f32>;

struct LineVarying {
  @builtin(position) clip: vec4f,
  @location(0) along: f32,
}

@vertex fn lineVertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) segment: u32) -> LineVarying {
  let at = segment * 6u;
  var a = view.viewProjection * (line.model * vec4f(segments[at], segments[at + 1u], segments[at + 2u], 1.0));
  var b = view.viewProjection * (line.model * vec4f(segments[at + 3u], segments[at + 4u], segments[at + 5u], 1.0));
  // A segment reaching behind the eye is cut where it would cross, so its screen direction means something.
  const NEAR_W = 1e-3;
  if (a.w < NEAR_W && b.w < NEAR_W) {
    var out: LineVarying;
    out.clip = vec4f(0.0, 0.0, -1.0, 1.0);
    out.along = 0.0;
    return out;
  }
  if (a.w < NEAR_W) { a = mix(a, b, (NEAR_W - a.w) / (b.w - a.w)); }
  if (b.w < NEAR_W) { b = mix(b, a, (NEAR_W - b.w) / (a.w - b.w)); }
  let aPixels = a.xy / a.w * view.size.xy;
  let bPixels = b.xy / b.w * view.size.xy;
  var direction = bPixels - aPixels;
  let size = length(direction);
  direction = select(vec2f(1.0, 0.0), direction / max(size, 1e-5), size > 1e-5);
  let side = vec2f(-direction.y, direction.x);
  var corners = array<vec2f, 6>(vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let c = corners[corner];
  // Half a width past each end, which closes the corners where segments join.
  let end = select(a, b, c.x > 0.5);
  let reach = side * c.y + direction * (c.x * 2.0 - 1.0);
  var out: LineVarying;
  out.clip = vec4f(end.xy + reach * line.halfWidth * 2.0 * view.size.zw * end.w, end.zw);
  out.along = c.x;
  return out;
}

@fragment fn lineFragment(in: LineVarying) -> @location(0) vec4f {
  return line.color;
}
`;

interface LineMaterialLike extends THREE.Material {
  color: THREE.Color;
  linewidth: number;
  resolution: THREE.Vector2;
}

interface SegmentBuffer {
  buffer: GPUBuffer;
  version: number;
  count: number;
}

type LineMesh = THREE.Mesh<THREE.BufferGeometry, LineMaterialLike> & { isLine2?: boolean; isLineSegments2?: boolean };

class WideLinePass implements GpuPass {
  readonly id = "effect-wide-lines";
  readonly stage = "forward" as const;
  readonly order = LINE_ORDER;
  private layout: GPUBindGroupLayout | null = null;
  private slices: UniformSlices | null = null;
  private readonly groups = new BindGroupCache(256);
  private readonly segments = new WeakMap<THREE.BufferGeometry, SegmentBuffer>();
  private readonly found: LineMesh[] = [];

  execute(frame: GpuFrame): void {
    // No line has been met yet: nothing to look for.
    if (!frame.materials.unsupported.has(LINE_MATERIAL_TYPE)) return;
    const { found } = this;
    found.length = 0;
    this.gather(frame.scene);
    if (!found.length) return;

    const { device } = frame;
    const layout = this.layout ?? (this.layout = device.createBindGroupLayout({
      label: "gpu wide line",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: LINE_BYTES } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    }));
    const pipelines = effectPipelinesFor(device);
    const module = pipelines.module("wide line", () => LINE_WGSL);
    const make = (test: boolean) => pipelines.render(`wide line ${test ? "tested" : "over"}`, () => ({
      layout: device.createPipelineLayout({ label: "gpu wide line", bindGroupLayouts: [frame.cameraLayout, frame.sceneLayout, layout] }),
      vertex: { module, entryPoint: "lineVertex" },
      fragment: {
        module,
        entryPoint: "lineFragment",
        targets: [{
          format: TARGET_FORMATS.hdr,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: TARGET_FORMATS.depth, depthWriteEnabled: false, depthCompare: test ? "greater-equal" : "always" },
    }));
    const tested = make(true);
    const over = make(false);
    if (!tested || !over) return;

    const slices = this.slices ?? (this.slices = new UniformSlices(device, "gpu wide lines", LINE_BYTES, 16));
    slices.ensure(found.length);
    const pass = beginForwardRenderPass(frame, "gpu wide lines");
    bindForwardView(pass, frame);
    found.forEach((mesh, index) => {
      const segment = this.segmentsOf(device, mesh.geometry);
      if (!segment?.count) return;
      const offset = this.pack(frame, slices, mesh, index);
      pass.setPipeline(mesh.material.depthTest ? tested : over);
      pass.setBindGroup(2, this.groups.get([segment.buffer, slices.buffer], () => device.createBindGroup({
        label: "gpu wide line",
        layout,
        entries: [{ binding: 0, resource: slices.binding }, { binding: 1, resource: { buffer: segment.buffer } }],
      })), [offset]);
      pass.draw(6, segment.count);
    });
    pass.end();
  }

  private gather(object: THREE.Object3D): void {
    if (!object.visible) return;
    const line = object as LineMesh;
    // A line drawn with nothing to see is there for the pointer alone.
    if ((line.isLine2 || line.isLineSegments2) && line.material?.visible !== false && line.material.opacity > 0) this.found.push(line);
    const { children } = object;
    for (let index = 0; index < children.length; index++) this.gather(children[index]);
  }

  /** The line's segments on the card, sent again when they change. */
  private segmentsOf(device: GPUDevice, geometry: THREE.BufferGeometry): SegmentBuffer | null {
    const start = geometry.getAttribute("instanceStart") as THREE.InterleavedBufferAttribute | undefined;
    if (!start?.data) return null;
    const { data } = start;
    const source = data.array as Float32Array;
    const count = Math.floor(source.length / 6);
    const known = this.segments.get(geometry);
    if (known && known.version === data.version && known.count === count) return known;
    let { buffer } = known ?? {};
    if (!buffer || buffer.size < source.byteLength) {
      buffer?.destroy();
      if (!source.byteLength) return null;
      buffer = device.createBuffer({ label: "gpu wide line segments", size: source.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      geometry.addEventListener("dispose", () => {
        this.segments.get(geometry)?.buffer.destroy();
        this.segments.delete(geometry);
      });
    }
    device.queue.writeBuffer(buffer, 0, source);
    const made: SegmentBuffer = { buffer, version: data.version, count };
    this.segments.set(geometry, made);
    return made;
  }

  private pack(frame: GpuFrame, slices: UniformSlices, mesh: LineMesh, index: number): number {
    const { data } = slices;
    const { material } = mesh;
    data.set(mesh.matrixWorld.elements, 0);
    data[16] = material.color.r;
    data[17] = material.color.g;
    data[18] = material.color.b;
    data[19] = material.opacity;
    // A width in the pixels of the resolution the line was told, as a share of this picture.
    const height = material.resolution?.y || frame.targets.height;
    data[20] = (material.linewidth * frame.targets.height) / height / 2;
    return slices.write(index);
  }

  dispose(): void {
    this.slices?.destroy();
    this.slices = null;
    this.groups.clear();
  }
}

export class WideLineEffect implements GpuEffect {
  readonly passes = [new WideLinePass()];
}
