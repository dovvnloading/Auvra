/// <reference types="@webgpu/types" />
import type * as THREE from "three";
import type { ClusterBuildRequest, ClusterBuildResponse } from "../../../workers/clusterBuild.worker";
import { GrowableBuffer } from "../buffers";
import type { GpuCore } from "../device";
import { TARGET_FORMATS, type GpuFrame, type GpuPass } from "../frame";
import type { DrawGroup } from "../gpuScene";
import { OCCLUDED_WGSL } from "../passes/surfaces";
import { reportGpu } from "../report";
import { CAMERA_BINDINGS_WGSL, INSTANCE_WGSL, VIEW_WGSL, surfaceBufferShader } from "../shaders";
import type { SurfaceKind } from "../surfaces";
import { CLUSTER_WORDS, GROUP_WORDS, MAX_CLUSTER_TRIANGLES, MIN_CLUSTERED_TRIANGLES, NO_GROUP, PAGE_WORDS, readClusterHierarchy } from "./clusterFormat";

/**
 * TRIANGLE CLUSTERS
 *
 * Meshes of very many triangles, drawn at the detail each part of them needs from where the camera is. A worker splits
 * such a mesh into a hierarchy of small clusters (clusterBuild.ts) and from then on the mesh leaves the surface pass's
 * instanced draw: every frame a compute pass looks at each cluster of each instance, keeps those whose error shows less
 * than a pixel while their parent's would show more, and drops what is outside the view or behind what the surface pass
 * drew. What is left is one indirect draw for each material, an instance per cluster, whose vertex shader finds its
 * triangles from the instance's number. WebGPU has no mesh shaders to do this more directly, and a fixed number of
 * vertices per cluster keeps the draw free of any index stream: a cluster with fewer triangles collapses the rest.
 *
 * Shadow views keep the mesh's ordinary detail levels. Every cluster stays in memory for now; the hierarchy's pages are
 * laid out for streaming, which is not done here.
 */

const WORKGROUP = 64;
const RECORD_WORDS = 24;
const VERTICES_PER_CLUSTER = MAX_CLUSTER_TRIANGLES * 3;
const JOB_BYTES = 256;
const INITIAL_JOBS = 64;
const DRAW_BYTES = 256;
const ARGS_WORDS = 4;
/** What one dispatch may cover, under the limit on workgroups in a dimension. */
const MAX_DISPATCH_TESTS = 65535 * WORKGROUP;
/** Clusters drawn at most, across every clustered mesh: 8 bytes each. */
const VISIBLE_CAPACITY = 1 << 20;
/** How much error may show, in pixels: the same bound the mesh detail levels use. */
const PIXEL_ERROR = 1;
const READBACK_EVERY_FRAMES = 30;

const CLUSTER_RECORD_WGSL = /* wgsl */ `
struct ClusterRecord {
  bounds: vec4f,
  cone: vec4f,
  own: vec4f,
  parent: vec4f,
  ownError: f32,
  parentError: f32,
  firstVertex: u32,
  firstTriangle: u32,
  counts: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
}
struct ClusterVisible { row: u32, cluster: u32 }
`;

const CLUSTER_CULL_WGSL = /* wgsl */ `
${VIEW_WGSL}${INSTANCE_WGSL}${CAMERA_BINDINGS_WGSL}
${CLUSTER_RECORD_WGSL}
struct Job {
  firstRow: u32,
  rowCount: u32,
  firstCluster: u32,
  clusterCount: u32,
  args: u32,
  firstVisible: u32,
  capacity: u32,
  useCone: u32,
  pixelError: f32,
}
struct Args { vertexCount: u32, instanceCount: atomic<u32>, firstVertex: u32, firstInstance: u32 }

@group(1) @binding(0) var<storage, read> instances: array<Instance>;
@group(2) @binding(0) var<uniform> job: Job;
@group(2) @binding(1) var<storage, read> rows: array<u32>;
@group(2) @binding(2) var<storage, read> clusters: array<ClusterRecord>;
@group(2) @binding(3) var<storage, read_write> args: array<Args>;
@group(2) @binding(4) var<storage, read_write> visible: array<ClusterVisible>;
@group(2) @binding(5) var pyramid: texture_2d<f32>;

${OCCLUDED_WGSL}

fn worldPoint(instance: Instance, p: vec3f) -> vec3f {
  let at = vec4f(p, 1.0);
  return vec3f(dot(instance.world0, at), dot(instance.world1, at), dot(instance.world2, at));
}

fn scaleOf(instance: Instance) -> f32 {
  let x = vec3f(instance.world0.x, instance.world1.x, instance.world2.x);
  let y = vec3f(instance.world0.y, instance.world1.y, instance.world2.y);
  let z = vec3f(instance.world0.z, instance.world1.z, instance.world2.z);
  return sqrt(max(max(dot(x, x), dot(y, y)), dot(z, z)));
}

// How many pixels an error shows at, for a sphere around what it applies to, from the sphere's nearest point.
fn pixelsOf(instance: Instance, scale: f32, sphere: vec4f, error: f32) -> f32 {
  if (view.orthographic != 0u) { return error * scale * view.projection[1][1] * view.size.y * 0.5; }
  let reach = distance(worldPoint(instance, sphere.xyz), view.lodEye.xyz) - sphere.w * scale;
  if (reach <= 1e-4) { return 1e20; }
  return error * scale * view.params.y / reach;
}

@compute @workgroup_size(${WORKGROUP}) fn cullClusters(@builtin(global_invocation_id) id: vec3u) {
  let test = id.x;
  let total = job.rowCount * job.clusterCount;
  if (test >= total) { return; }
  let row = rows[job.firstRow + test / job.clusterCount];
  let instance = instances[row];
  if ((instance.flags & INSTANCE_ACTIVE) == 0u || (instance.layers & view.layers) == 0u) { return; }
  let index = job.firstCluster + test % job.clusterCount;
  let cluster = clusters[index];
  let scale = scaleOf(instance);
  if (pixelsOf(instance, scale, cluster.own, cluster.ownError) > job.pixelError) { return; }
  if (pixelsOf(instance, scale, cluster.parent, cluster.parentError) <= job.pixelError) { return; }

  let center = worldPoint(instance, cluster.bounds.xyz);
  let sphere = vec4f(center, cluster.bounds.w * scale);
  for (var plane = 0u; plane < min(view.planeCount, 6u); plane++) {
    if (dot(view.planes[plane].xyz, center) + view.planes[plane].w < -sphere.w) { return; }
  }
  if (job.useCone != 0u && cluster.cone.w < 1.0 && view.orthographic == 0u) {
    let axis = normalize(vec3f(dot(instance.world0.xyz, cluster.cone.xyz), dot(instance.world1.xyz, cluster.cone.xyz), dot(instance.world2.xyz, cluster.cone.xyz)));
    if (dot(normalize(center - view.eye.xyz), axis) >= cluster.cone.w + sphere.w / max(distance(center, view.eye.xyz), 1e-4)) { return; }
  }
  if (occluded(view.unjitteredViewProjection, sphere)) { return; }

  let slot = atomicAdd(&args[job.args].instanceCount, 1u);
  if (slot < job.capacity) { visible[job.firstVisible + slot] = ClusterVisible(row, index); }
}
`;

const CLUSTER_VERTEX_WGSL = /* wgsl */ `
${CLUSTER_RECORD_WGSL}
struct ClusterDraw { firstVisible: u32, baseVertex: u32, pad0: u32, pad1: u32 }
@group(3) @binding(0) var<uniform> clusterDraw: ClusterDraw;
@group(3) @binding(1) var<storage, read> clusterVisible: array<ClusterVisible>;
@group(3) @binding(2) var<storage, read> clusterRecords: array<ClusterRecord>;
@group(3) @binding(3) var<storage, read> clusterVertexRefs: array<u32>;
@group(3) @binding(4) var<storage, read> clusterTriangles: array<u32>;

@vertex fn clusterVertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) index: u32) -> SurfaceVarying {
  let entry = clusterVisible[clusterDraw.firstVisible + index];
  let cluster = clusterRecords[entry.cluster];
  let triangle = corner / 3u;
  if (triangle >= ((cluster.counts >> 8u) & 0xffu)) {
    // Past this cluster's triangles: nothing, however the rest of the varying reads.
    var nothing: SurfaceVarying;
    nothing.clip = vec4f(0.0, 0.0, 0.0, 0.0);
    return nothing;
  }
  let local = (clusterTriangles[cluster.firstTriangle + triangle] >> ((corner % 3u) * 8u)) & 0xffu;
  let vertex = clusterVertexRefs[cluster.firstVertex + local];
  return surfaceVarying(DrawIn(clusterDraw.baseVertex + vertex, entry.row));
}
`;

interface ClusterAsset {
  firstCluster: number;
  clusterCount: number;
}

/** One group's place in this frame's work. */
interface ClusterRun {
  group: DrawGroup;
  asset: ClusterAsset;
  firstRow: number;
  rowCount: number;
  firstVisible: number;
  capacity: number;
}

const float32 = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, size: number): Float32Array => {
  const out = new Float32Array(attribute.count * size);
  for (let at = 0; at < attribute.count; at++) {
    out[at * size] = attribute.getX(at);
    if (size > 1) out[at * size + 1] = attribute.getY(at);
    if (size > 2) out[at * size + 2] = attribute.getZ(at);
  }
  return out;
};

export class ClusterPass implements GpuPass {
  readonly id = "clusters";
  readonly stage = "surfaces" as const;
  readonly order = 10;

  private readonly device: GPUDevice;
  private readonly records: GrowableBuffer;
  private readonly vertexRefs: GrowableBuffer;
  private readonly triangles: GrowableBuffer;
  private readonly rows: GrowableBuffer;
  private readonly visible: GPUBuffer;
  private readonly args: GrowableBuffer;
  private readonly jobs: GrowableBuffer;
  private readonly draws: GrowableBuffer;
  private readonly noPyramid: GPUTexture;
  private clusterCount = 0;
  private vertexRefCount = 0;
  private triangleCount = 0;
  private readonly assets = new WeakMap<THREE.BufferGeometry, Map<string, ClusterAsset | "building" | "none">>();
  private worker: Worker | null = null;
  private nextRequest = 1;
  private readonly requests = new Map<number, { geometry: THREE.BufferGeometry; key: string }>();
  private cullLayout: GPUBindGroupLayout | null = null;
  private cullPipeline: GPUComputePipeline | null = null;
  private cullInstances: GPUBindGroupLayout | null = null;
  private drawLayout: GPUBindGroupLayout;
  private readonly surfacePipelines = new Map<string, GPURenderPipeline | "pending">();
  private readback: GPUBuffer;
  private readbackBusy = false;
  /** Clusters and triangles drawn, as last read back: what `renderer.info` and the checks can look at. */
  drawnClusters = 0;

  constructor(core: GpuCore) {
    const { device } = core;
    this.device = device;
    this.records = new GrowableBuffer(device, "gpu cluster records", GPUBufferUsage.STORAGE, RECORD_WORDS * 4 * 4096);
    this.vertexRefs = new GrowableBuffer(device, "gpu cluster vertices", GPUBufferUsage.STORAGE, 1 << 20);
    this.triangles = new GrowableBuffer(device, "gpu cluster triangles", GPUBufferUsage.STORAGE, 1 << 20);
    this.rows = new GrowableBuffer(device, "gpu cluster rows", GPUBufferUsage.STORAGE, 4096);
    this.visible = device.createBuffer({ label: "gpu clusters visible", size: VISIBLE_CAPACITY * 8, usage: GPUBufferUsage.STORAGE });
    this.args = new GrowableBuffer(device, "gpu cluster draws", GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT, ARGS_WORDS * 4 * 64);
    this.jobs = new GrowableBuffer(device, "gpu cluster jobs", GPUBufferUsage.UNIFORM, JOB_BYTES * INITIAL_JOBS);
    this.draws = new GrowableBuffer(device, "gpu cluster draw params", GPUBufferUsage.UNIFORM, DRAW_BYTES * INITIAL_JOBS);
    this.noPyramid = device.createTexture({ label: "gpu no pyramid", size: [1, 1], format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING });
    this.readback = device.createBuffer({ label: "gpu cluster count", size: ARGS_WORDS * 4 * 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const everywhere = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.drawLayout = device.createBindGroupLayout({
      label: "gpu cluster draw",
      entries: [
        { binding: 0, visibility: everywhere, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 16 } },
        ...[1, 2, 3, 4].map((binding) => ({ binding, visibility: everywhere, buffer: { type: "read-only-storage" as const } })),
      ],
    });
  }

  private assetFor(group: DrawGroup): ClusterAsset | null {
    const { geometry } = group.geometry;
    const key = `${group.range.firstIndex - group.geometry.indexBase}/${group.range.indexCount}`;
    let forGeometry = this.assets.get(geometry);
    if (!forGeometry) {
      forGeometry = new Map();
      this.assets.set(geometry, forGeometry);
    }
    const known = forGeometry.get(key);
    if (known === "building" || known === "none") return null;
    if (known) return known;
    forGeometry.set(key, "building");
    this.requestBuild(group, geometry, key);
    return null;
  }

  private requestBuild(group: DrawGroup, geometry: THREE.BufferGeometry, key: string): void {
    const { position, normal, uv } = geometry.attributes;
    if (!position) return;
    if (!this.worker) {
      this.worker = new Worker(new URL("../../../workers/clusterBuild.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (event: MessageEvent<ClusterBuildResponse>) => this.receive(event.data);
      this.worker.onerror = (event) => reportGpu("the cluster builder stopped:", event.message);
    }
    const id = this.nextRequest++;
    this.requests.set(id, { geometry, key });
    const positions = float32(position, 3);
    const normals = normal ? float32(normal, 3) : null;
    const uvs = uv ? float32(uv, 2) : null;
    const indices = geometry.index ? Uint32Array.from(geometry.index.array as ArrayLike<number>) : null;
    const start = group.range.firstIndex - group.geometry.indexBase;
    const request: ClusterBuildRequest = { id, positions, normals, uvs, indices, parts: [{ start, count: group.range.indexCount }] };
    const transfer: Transferable[] = [positions.buffer];
    if (normals) transfer.push(normals.buffer);
    if (uvs) transfer.push(uvs.buffer);
    if (indices) transfer.push(indices.buffer);
    this.worker.postMessage(request, transfer);
  }

  private receive(response: ClusterBuildResponse): void {
    const request = this.requests.get(response.id);
    if (!request) return;
    this.requests.delete(response.id);
    const forGeometry = this.assets.get(request.geometry);
    if (!forGeometry) return;
    if ("error" in response) {
      reportGpu("a mesh could not be split into clusters:", response.error);
      forGeometry.set(request.key, "none");
      return;
    }
    const bytes = response.parts[0]?.hierarchy;
    const hierarchy = bytes ? readClusterHierarchy(bytes) : null;
    if (!hierarchy) {
      forGeometry.set(request.key, "none");
      return;
    }
    forGeometry.set(request.key, this.upload(hierarchy));
  }

  /** The hierarchy in the renderer's tables: each cluster with the two errors its choice reads, and every part in place. */
  private upload(hierarchy: NonNullable<ReturnType<typeof readClusterHierarchy>>): ClusterAsset {
    const { clusters, groups, pages, vertexRefs, triangles, clusterCount } = hierarchy;
    const clusterFloats = new Float32Array(clusters.buffer, clusters.byteOffset, clusters.length);
    const groupFloats = new Float32Array(groups.buffer, groups.byteOffset, groups.length);
    const firstCluster = this.clusterCount;
    const firstVertexRef = this.vertexRefCount;
    const firstTriangle = this.triangleCount;
    const data = new ArrayBuffer(clusterCount * RECORD_WORDS * 4);
    const floats = new Float32Array(data);
    const words = new Uint32Array(data);
    for (let cluster = 0; cluster < clusterCount; cluster++) {
      const from = cluster * CLUSTER_WORDS;
      const to = cluster * RECORD_WORDS;
      for (let word = 0; word < 8; word++) floats[to + word] = clusterFloats[from + word];
      const memberOf = clusters[from + 8];
      const cameFrom = clusters[from + 9];
      if (cameFrom === NO_GROUP) {
        for (let word = 0; word < 4; word++) floats[to + 8 + word] = clusterFloats[from + word];
        floats[to + 16] = 0;
      } else {
        const at = cameFrom * GROUP_WORDS;
        for (let word = 0; word < 4; word++) floats[to + 8 + word] = groupFloats[at + word];
        floats[to + 16] = groupFloats[at + 4];
      }
      const parent = memberOf * GROUP_WORDS;
      for (let word = 0; word < 4; word++) floats[to + 12 + word] = groupFloats[parent + word];
      floats[to + 17] = groupFloats[parent + 4];
      const page = memberOf * PAGE_WORDS;
      words[to + 18] = firstVertexRef + pages[page] + clusters[from + 10];
      words[to + 19] = firstTriangle + pages[page + 2] + clusters[from + 11];
      words[to + 20] = clusters[from + 12];
    }
    this.records.ensure((firstCluster + clusterCount) * RECORD_WORDS * 4);
    this.records.write(firstCluster * RECORD_WORDS * 4, floats);
    this.vertexRefs.ensure((firstVertexRef + vertexRefs.length) * 4);
    this.vertexRefs.write(firstVertexRef * 4, vertexRefs);
    this.triangles.ensure((firstTriangle + triangles.length) * 4);
    this.triangles.write(firstTriangle * 4, triangles);
    this.clusterCount += clusterCount;
    this.vertexRefCount += vertexRefs.length;
    this.triangleCount += triangles.length;
    return { firstCluster, clusterCount };
  }

  private cullPipelineFor(frame: GpuFrame): GPUComputePipeline {
    if (this.cullPipeline) return this.cullPipeline;
    const { device } = this;
    this.cullLayout = device.createBindGroupLayout({
      label: "gpu cluster cull",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 48 } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      ],
    });
    this.cullInstances = device.createBindGroupLayout({
      label: "gpu cluster instances",
      entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }],
    });
    this.cullPipeline = device.createComputePipeline({
      label: "gpu cluster cull",
      layout: device.createPipelineLayout({ bindGroupLayouts: [frame.cameraLayout, this.cullInstances, this.cullLayout] }),
      compute: { module: device.createShaderModule({ label: "gpu cluster cull", code: CLUSTER_CULL_WGSL }), entryPoint: "cullClusters" },
    });
    return this.cullPipeline;
  }

  private surfacePipelineFor(frame: GpuFrame, kind: SurfaceKind, masked: boolean, cull: GPUCullMode): GPURenderPipeline | null {
    const key = `${kind.id}|${masked ? 1 : 0}|${cull}`;
    const known = this.surfacePipelines.get(key);
    if (known === "pending") return null;
    if (known) return known;
    this.surfacePipelines.set(key, "pending");
    const { device } = this;
    const code = `diagnostic(off, derivative_uniformity);\n${surfaceBufferShader(kind)}${CLUSTER_VERTEX_WGSL}`;
    const module = device.createShaderModule({ label: `gpu cluster surface ${kind.id}`, code });
    const formats = [TARGET_FORMATS.albedo, TARGET_FORMATS.normal, TARGET_FORMATS.emissive, TARGET_FORMATS.motion];
    device.createRenderPipelineAsync({
      label: `gpu clusters ${key}`,
      layout: device.createPipelineLayout({ bindGroupLayouts: [frame.cameraLayout, frame.sceneLayout, frame.materials.layoutFor(kind), this.drawLayout] }),
      vertex: { module, entryPoint: "clusterVertex" },
      fragment: { module, entryPoint: "fragmentMain", targets: formats.map((format) => ({ format })) },
      primitive: { topology: "triangle-list", cullMode: cull, frontFace: "ccw" },
      depthStencil: { format: TARGET_FORMATS.depth, depthWriteEnabled: true, depthCompare: "greater" },
    }).then((pipeline) => this.surfacePipelines.set(key, pipeline)).catch((error: unknown) => reportGpu(`cluster pipeline ${key} failed`, error));
    return null;
  }

  /** Which of the scene's groups clusters draw, new ones starting their build, and each group's rows. */
  private gather(frame: GpuFrame): { runs: ClusterRun[]; rows: Uint32Array } {
    const { gpuScene } = frame;
    const runs: ClusterRun[] = [];
    const rows: number[] = [];
    let firstVisible = 0;
    for (const group of gpuScene.groupList) {
      if (group.forward || group.topology !== "triangle-list" || group.posed || !group.material || group.material.kind.displaces) continue;
      if (group.range.indexCount / 3 < MIN_CLUSTERED_TRIANGLES) continue;
      const asset = this.assetFor(group);
      if (!asset) continue;
      gpuScene.markClustered(group);
      const firstRow = rows.length;
      gpuScene.rowsOf(group, rows);
      const rowCount = rows.length - firstRow;
      if (!rowCount) continue;
      const capacity = Math.min(rowCount * asset.clusterCount, VISIBLE_CAPACITY - firstVisible);
      if (capacity <= 0) {
        reportGpu("more triangle clusters than can be drawn at once; some meshes are missing");
        break;
      }
      runs.push({ group, asset, firstRow, rowCount, firstVisible, capacity });
      firstVisible += capacity;
    }
    return { runs, rows: Uint32Array.from(rows) };
  }

  execute(frame: GpuFrame): void {
    const { runs, rows } = this.gather(frame);
    if (!runs.length) return;
    const { device, encoder, targets } = frame;

    const argsBytes = runs.length * ARGS_WORDS * 4;
    this.args.ensure(argsBytes);
    const argsData = new Uint32Array(runs.length * ARGS_WORDS);
    runs.forEach((_, index) => { argsData[index * ARGS_WORDS] = VERTICES_PER_CLUSTER; });
    this.args.write(0, argsData);
    this.rows.ensure(rows.byteLength);
    this.rows.write(0, rows);

    const pipeline = this.cullPipelineFor(frame);
    const pyramid = (frame.products.get("depthPyramid") as { view: GPUTextureView } | undefined)?.view ?? this.noPyramid.createView();

    // Each run as one or more dispatches, so that none passes the limit on workgroups.
    const jobs: { run: number; firstRow: number; rowCount: number }[] = [];
    runs.forEach((run, index) => {
      const rowsPerJob = Math.max(1, Math.floor(MAX_DISPATCH_TESTS / run.asset.clusterCount));
      for (let first = 0; first < run.rowCount; first += rowsPerJob) {
        jobs.push({ run: index, firstRow: run.firstRow + first, rowCount: Math.min(rowsPerJob, run.rowCount - first) });
      }
    });
    this.jobs.ensure(jobs.length * JOB_BYTES);
    this.draws.ensure(runs.length * DRAW_BYTES);
    const jobData = new ArrayBuffer(jobs.length * JOB_BYTES);
    const jobWords = new Uint32Array(jobData);
    const jobFloats = new Float32Array(jobData);
    jobs.forEach((job, index) => {
      const run = runs[job.run];
      const at = (index * JOB_BYTES) / 4;
      jobWords[at] = job.firstRow;
      jobWords[at + 1] = job.rowCount;
      jobWords[at + 2] = run.asset.firstCluster;
      jobWords[at + 3] = run.asset.clusterCount;
      jobWords[at + 4] = job.run;
      jobWords[at + 5] = run.firstVisible;
      jobWords[at + 6] = run.capacity;
      jobWords[at + 7] = run.group.material.state.cull === "back" ? 1 : 0;
      jobFloats[at + 8] = PIXEL_ERROR;
    });
    this.jobs.write(0, jobWords);
    const drawData = new Uint32Array((runs.length * DRAW_BYTES) / 4);
    runs.forEach((run, index) => {
      const at = (index * DRAW_BYTES) / 4;
      drawData[at] = run.firstVisible;
      drawData[at + 1] = run.group.baseVertex;
    });
    this.draws.write(0, drawData);

    const cullGroup = device.createBindGroup({
      label: "gpu cluster cull",
      layout: this.cullLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.jobs.buffer, size: 48 } },
        { binding: 1, resource: { buffer: this.rows.buffer } },
        { binding: 2, resource: { buffer: this.records.buffer } },
        { binding: 3, resource: { buffer: this.args.buffer } },
        { binding: 4, resource: { buffer: this.visible } },
        { binding: 5, resource: pyramid },
      ],
    });
    const instanceGroup = device.createBindGroup({
      label: "gpu cluster instances",
      layout: this.cullInstances!,
      entries: [{ binding: 0, resource: { buffer: frame.gpuScene.instanceBuffer.buffer } }],
    });
    const compute = encoder.beginComputePass({ label: "gpu cluster cull" });
    compute.setPipeline(pipeline);
    compute.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    compute.setBindGroup(1, instanceGroup);
    jobs.forEach((job, index) => {
      compute.setBindGroup(2, cullGroup, [index * JOB_BYTES]);
      compute.dispatchWorkgroups(Math.ceil((job.rowCount * runs[job.run].asset.clusterCount) / WORKGROUP));
    });
    compute.end();

    const drawGroup = device.createBindGroup({
      label: "gpu cluster draw",
      layout: this.drawLayout,
      entries: [
        { binding: 0, resource: { buffer: this.draws.buffer, size: 16 } },
        { binding: 1, resource: { buffer: this.visible } },
        { binding: 2, resource: { buffer: this.records.buffer } },
        { binding: 3, resource: { buffer: this.vertexRefs.buffer } },
        { binding: 4, resource: { buffer: this.triangles.buffer } },
      ],
    });
    const load = (view: GPUTextureView): GPURenderPassColorAttachment => ({ view, loadOp: "load", storeOp: "store" });
    const pass = encoder.beginRenderPass({
      label: "gpu clusters",
      colorAttachments: [load(targets.albedo.view), load(targets.normal.view), load(targets.emissive.view), load(targets.motion.view)],
      depthStencilAttachment: { view: targets.depth.view, depthLoadOp: "load", depthStoreOp: "store" },
    });
    pass.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    pass.setBindGroup(1, frame.sceneBindGroup);
    runs.forEach((run, index) => {
      const { material } = run.group;
      const surface = this.surfacePipelineFor(frame, material.kind, material.state.masked, material.state.cull);
      if (!surface || !material.bindGroup) return;
      pass.setPipeline(surface);
      pass.setBindGroup(2, material.bindGroup);
      pass.setBindGroup(3, drawGroup, [index * DRAW_BYTES]);
      pass.drawIndirect(this.args.buffer, index * ARGS_WORDS * 4);
    });
    pass.end();

    this.readCounts(frame, runs.length);
  }

  /** Now and then, how many clusters were drawn. */
  private readCounts(frame: GpuFrame, runCount: number): void {
    if (this.readbackBusy || frame.frameNumber % READBACK_EVERY_FRAMES !== 0) return;
    const bytes = Math.min(runCount * ARGS_WORDS * 4, this.readback.size);
    frame.encoder.copyBufferToBuffer(this.args.buffer, 0, this.readback, 0, bytes);
    this.readbackBusy = true;
    frame.afterSubmit(() => {
      this.readback.mapAsync(GPUMapMode.READ, 0, bytes).then(() => {
        const counts = new Uint32Array(this.readback.getMappedRange(0, bytes));
        let total = 0;
        for (let at = 1; at < counts.length; at += ARGS_WORDS) total += counts[at];
        this.drawnClusters = total;
        this.readback.unmap();
        this.readbackBusy = false;
      }).catch(() => { this.readbackBusy = false; });
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.records.destroy();
    this.vertexRefs.destroy();
    this.triangles.destroy();
    this.rows.destroy();
    this.visible.destroy();
    this.args.destroy();
    this.jobs.destroy();
    this.draws.destroy();
    this.noPyramid.destroy();
    this.readback.destroy();
  }
}
