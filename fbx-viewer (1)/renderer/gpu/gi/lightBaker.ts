/// <reference types="@webgpu/types" />
import * as THREE from "three";
import {
  fillInvalidProbes,
  isStaticLightingLight,
  isStaticLightingMesh,
  planProbeGrid,
  setSceneLightVolume,
  SH_FLOATS_PER_PROBE,
  type LightVolume,
  type ProbeGrid,
} from "../../../runtime/lighting/bakedLighting";
import type { LightBakeOptions, LightBakeProgress, LightBakeResult } from "../../../runtime/lighting/lightBaker";
import type { RayFilter } from "../../../runtime/raytracing/rayScene";
import type { GpuCore } from "../device";
import type { SkyEnvironmentProduct } from "../sky/skySettings";
import type { TexturePool } from "../texturePool";
import { GI_DIRECT_WGSL, GiLighting, LIGHT_CELLS, giSharedWgsl } from "./giShared";
import { GpuRayScene } from "./rayTables";
import { raySceneWgsl } from "./rayWgsl";
import { TextureMeans } from "./textureMeans";

/**
 * THE LIGHT BAKE IN COMPUTE
 *
 * Bakes a level's light probes (see runtime/lighting/bakedLighting.ts) with rays rather than by drawing the level around
 * each probe. Each probe sends rays through the static geometry; what they bring back, lit by the scene's lights with
 * shadow rays deciding and by the sky, is reduced to spherical harmonics. The first bounce lights the geometry with the
 * unoccluded sky fill; each further bounce lights it with the bounce before, so light reaching an enclosed room is what
 * came in through its openings. Before that, a pass that tells front faces from back faces finds the probes buried
 * inside geometry; they take their neighbours' light instead of the dark they see.
 *
 * It answers as LightBaker does, a step at a time from the frame loop, so the same job runner can drive either. The
 * result is the same volume asset either way. Unlike that baker it draws nothing, so it leaves the scene alone.
 */

/** Rays from each probe, about what a cube of 16 pixels a side sees. */
const BAKE_RAYS = 1536;
/** A probe that sees more back faces than this share of the geometry around it is inside geometry. */
const INSIDE_BACK_FACE_SHARE = 0.25;
/** Probes traced in one go, at most and at first: how many it does is then worked out from how long they took. */
const MOST_PROBES_AT_ONCE = 256;
const FIRST_PROBES_AT_ONCE = 8;
/** Steps it may wait for texture averages before baking with what it has. */
const MEANS_PATIENCE = 120;
const RAY_BYTES = 32;
/** Beyond the outer probes a volume's light gives way to the sky fill over this many spacings, as when drawing. */
const EDGE_FADE = 0.5;
const NORMAL_OFFSET = 0.35;

const BAKE_STRUCT_WGSL = /* wgsl */ `
struct BakeParams {
  // xyz: the first probe; w: spacing.
  origin: vec4f,
  // Probes along each axis; 0 finding faces, 1 the first bounce, 2 a later one.
  counts: vec4u,
  // First probe of this run, how many, rays from each.
  run: vec4u,
  // How far out from a surface to read the last bounce, how far past the edge of the volume it fades.
  volume: vec4f,
  // The sky's radiance as a + b * y.
  skyConstant: vec4f,
  skyUp: vec4f,
}
struct BakeRay { light: vec3f, along: f32, way: vec3f, pad: f32 }
`;

const BAKE_TRACE_WGSL = /* wgsl */ `
${giSharedWgsl(0)}
${raySceneWgsl(1)}
${GI_DIRECT_WGSL}
${BAKE_STRUCT_WGSL}
@group(2) @binding(0) var<uniform> bake: BakeParams;
@group(2) @binding(1) var<storage, read> lastBounce: array<vec4f>;
@group(2) @binding(2) var<storage, read_write> rays: array<BakeRay>;

fn probeCell(index: u32) -> vec3f {
  let nx = bake.counts.x;
  let ny = bake.counts.y;
  return vec3f(f32(index % nx), f32((index / nx) % ny), f32(index / (nx * ny)));
}

// Evenly spread directions over the sphere, each probe's turned its own way so their patterns do not line up.
fn rayWay(ray: u32, rayCount: u32, probe: u32) -> vec3f {
  let around = 6.2831853 * fract(f32(ray) * 0.6180339887);
  let cosine = 1.0 - (2.0 * f32(ray) + 1.0) / f32(rayCount);
  let sine = sqrt(max(0.0, 1.0 - cosine * cosine));
  let way = vec3f(cos(around) * sine, sin(around) * sine, cosine);
  giRng = probe * 9277u + 17u;
  let axis = normalize(vec3f(giRandom() - 0.5, giRandom() - 0.5, giRandom() - 0.5) + vec3f(1e-4, 0.0, 0.0));
  let half = giRandom() * 3.14159265;
  let turn = vec4f(axis * sin(half), cos(half));
  return way + 2.0 * cross(turn.xyz, cross(turn.xyz, way) + turn.w * way);
}

// The last bounce read at a surface: the eight probes around it, each by how near it is and whether it lies in front.
fn lastBounceIrradiance(position: vec3f, normal: vec3f) -> vec3f {
  let dims = vec3i(bake.counts.xyz);
  let last = vec3f(dims - vec3i(1));
  let spacing = bake.origin.w;
  let cell = clamp((position + normal * bake.volume.x - bake.origin.xyz) / spacing, vec3f(0.0), last);
  let base = min(floor(cell), max(last - vec3f(1.0), vec3f(0.0)));
  let f = cell - base;
  var a = vec4f(0.0);
  var b = vec4f(0.0);
  var c = vec4f(0.0);
  var total = 0.0;
  for (var i = 0u; i < giShared.counts.y; i++) {
    let corner = vec3f(f32(i & 1u), f32((i >> 1u) & 1u), f32((i >> 2u) & 1u));
    let probe = min(base + corner, last);
    let near = mix(vec3f(1.0) - f, f, corner);
    let toProbe = bake.origin.xyz + probe * spacing - position;
    let facing = dot(toProbe, normal) / max(length(toProbe), 1e-4);
    let weight = near.x * near.y * near.z * max(smoothstep(-0.2, 0.3, facing), 0.001);
    let at = vec3i(probe);
    let index = u32(at.x + dims.x * (at.y + dims.y * at.z)) * 3u;
    a += lastBounce[index] * weight;
    b += lastBounce[index + 1u] * weight;
    c += lastBounce[index + 2u] * weight;
    total += weight;
  }
  a /= total;
  b /= total;
  c /= total;
  // three's order: constant, then y, z, x.
  let irradiance = a.rgb * 0.886227 + 1.023328 * (vec3f(a.a, b.rg) * normal.y + vec3f(b.ba, c.r) * normal.z + c.gba * normal.x);
  return max(irradiance, vec3f(0.0));
}

fn volumeShare(position: vec3f) -> f32 {
  let extent = vec3f(bake.counts.xyz - vec3u(1u)) * bake.origin.w;
  let outside = max(bake.origin.xyz - position, position - (bake.origin.xyz + extent));
  return 1.0 - smoothstep(0.0, bake.volume.y, max(max(outside.x, outside.y), outside.z));
}

fn bakedShade(point: vec3f, hit: RtHit) -> vec3f {
  let material = rayMaterials[hit.material];
  if ((material.flags & RT_MATERIAL_UNLIT) != 0u) { return material.albedo + material.emissive; }
  let normal = select(-hit.normal, hit.normal, hit.front);
  var received = giDirectional(point, normal) + giLocal(point, normal);
  let open = giOpenIrradiance(normal);
  if (bake.counts.w == 1u) {
    received += open;
  } else {
    received += mix(open, lastBounceIrradiance(point, normal), volumeShare(point));
  }
  return material.emissive + material.albedo * received * GI_RECIPROCAL_PI;
}

@compute @workgroup_size(64)
fn bakeRays(@builtin(global_invocation_id) id: vec3u) {
  let rayCount = bake.run.z;
  if (id.x >= bake.run.y * rayCount) { return; }
  let slot = id.x / rayCount;
  let ray = id.x % rayCount;
  let probe = bake.run.x + slot;
  let way = rayWay(ray, rayCount, probe);
  giRng = ray * 1973u + probe * 9277u + bake.counts.w * 26699u + 1u;
  let origin = bake.origin.xyz + probeCell(probe) * bake.origin.w;
  var hit: RtHit;
  let met = rtTrace(origin, way, 1e5, false, &hit);
  var light = vec3f(0.0);
  var along = 1e4;
  if (met) {
    // Drawn from both sides, a back is as good as a front: it says nothing of being inside.
    let shows = hit.front || (rayMaterials[hit.material].flags & RT_MATERIAL_TWO_SIDED) != 0u;
    along = select(-hit.distance, hit.distance, shows);
    if (shows && bake.counts.w != 0u) { light = bakedShade(origin + way * hit.distance, hit); }
  } else if (bake.counts.w != 0u) {
    light = max(bake.skyConstant.rgb + bake.skyUp.rgb * way.y, vec3f(0.0)) + giEnvironmentRadiance(way, 0.0);
  }
  rays[id.x] = BakeRay(min(light, vec3f(4096.0)), along, way, 0.0);
}
`;

const BAKE_REDUCE_WGSL = /* wgsl */ `
${BAKE_STRUCT_WGSL}
@group(0) @binding(0) var<uniform> bake: BakeParams;
@group(0) @binding(1) var<storage, read> rays: array<BakeRay>;
@group(0) @binding(2) var<storage, read_write> sh: array<f32>;

// What a probe saw as first-order spherical harmonics, one band per invocation: three's order, constant, y, z, x.
@compute @workgroup_size(4)
fn reduceLight(@builtin(global_invocation_id) id: vec3u) {
  let band = id.x;
  let slot = id.y;
  if (slot >= bake.run.y) { return; }
  let rayCount = bake.run.z;
  let first = slot * rayCount;
  var sum = vec3f(0.0);
  for (var ray = 0u; ray < rayCount; ray++) {
    let way = rays[first + ray].way;
    var basis = 0.282095;
    if (band == 1u) { basis = 0.488603 * way.y; }
    if (band == 2u) { basis = 0.488603 * way.z; }
    if (band == 3u) { basis = 0.488603 * way.x; }
    sum += rays[first + ray].light * basis;
  }
  let result = sum * (12.566370614 / f32(rayCount));
  let to = (bake.run.x + slot) * ${SH_FLOATS_PER_PROBE}u + band * 3u;
  sh[to] = result.x;
  sh[to + 1u] = result.y;
  sh[to + 2u] = result.z;
}

// In the probe's first two numbers: how many rays met a front, and how many a back.
@compute @workgroup_size(16)
fn reduceFaces(@builtin(global_invocation_id) id: vec3u) {
  let slot = id.x;
  if (slot >= bake.run.y) { return; }
  let rayCount = bake.run.z;
  let first = slot * rayCount;
  var front = 0u;
  var back = 0u;
  for (var ray = 0u; ray < rayCount; ray++) {
    let along = rays[first + ray].along;
    if (along < 0.0) { back++; } else if (along < 9999.0) { front++; }
  }
  let to = (bake.run.x + slot) * ${SH_FLOATS_PER_PROBE}u;
  sh[to] = f32(front);
  sh[to + 1u] = f32(back);
}
`;

const effectivelyVisible = (object: THREE.Object3D): boolean => {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) if (!node.visible) return false;
  return true;
};

type BakePhase = "preparing" | "tracing" | "waiting" | "reading";

const _color = new THREE.Color();

export class GpuLightBaker {
  readonly grid: ProbeGrid;
  private readonly device: GPUDevice;
  private readonly probes: number;
  private readonly sh: Float32Array;
  private readonly inside: Uint8Array;
  private readonly bounds = new THREE.Box3();
  private readonly include: RayFilter;
  private readonly rayScene: GpuRayScene;
  private readonly lighting: GiLighting;
  private readonly means: TextureMeans;
  private readonly noAtlas: GPUTexture;
  private readonly noAtlasView: GPUTextureView;
  private readonly params: GPUBuffer;
  private readonly lastBounce: GPUBuffer;
  private readonly output: GPUBuffer;
  private readonly rays: GPUBuffer;
  private readonly readback: GPUBuffer;
  private readonly traceLayout: GPUBindGroupLayout;
  private readonly reduceLayout: GPUBindGroupLayout;
  private readonly traceGroup: GPUBindGroup;
  private readonly reduceGroup: GPUBindGroup;
  private readonly reduceLight: GPUComputePipeline;
  private readonly reduceFaces: GPUComputePipeline;
  private tracePipeline: GPUComputePipeline | null = null;
  private readonly paramData = new Float32Array(24);
  private readonly paramWords = new Uint32Array(this.paramData.buffer);
  private readonly centre = new THREE.Vector3();
  private readonly cellSize: number;
  private readonly directional: THREE.DirectionalLight[] = [];
  private readonly local: (THREE.PointLight | THREE.SpotLight)[] = [];
  private readonly ambient = new THREE.Color();
  private readonly hemiSky = new THREE.Color();
  private readonly hemiGround = new THREE.Color();
  private environment: SkyEnvironmentProduct | undefined;
  private phase: BakePhase = "preparing";
  private patience = MEANS_PATIENCE;
  private next = 0;
  private bounce = 0;
  private finished = false;
  private failure: unknown = null;
  private probesAtOnce = FIRST_PROBES_AT_ONCE;
  private disposed = false;
  /** Takes back the volume the scene draws with: none at first, then the last bounce, to show how it goes. */
  private release: (() => void) | null;

  constructor(core: GpuCore, private readonly textures: TexturePool, private readonly scene: THREE.Scene, private readonly options: LightBakeOptions) {
    const { device } = core;
    this.device = device;
    scene.updateMatrixWorld(true);
    let statics = 0;
    scene.traverse((object) => {
      if (isStaticLightingMesh(object, options.staticIds) && effectivelyVisible(object)) {
        statics++;
        this.bounds.expandByObject(object);
      }
    });
    if (!statics) throw new Error("The level has no static geometry to bake.");
    // Light Bake Volumes, where there are any, say where the probes go.
    const volumes = new THREE.Box3();
    scene.traverse((object) => {
      if (object.userData?.lightBakeVolume === true && effectivelyVisible(object)) volumes.expandByObject(object);
    });
    this.grid = planProbeGrid(volumes.isEmpty() ? this.bounds : volumes, options.spacing, options.maxProbes);
    this.probes = this.grid.counts[0] * this.grid.counts[1] * this.grid.counts[2];
    this.sh = new Float32Array(this.probes * SH_FLOATS_PER_PROBE);
    this.inside = new Uint8Array(this.probes);

    this.include = (mesh) => {
      // A terrain's drawn pieces change with distance; its whole mesh stays, hidden, beside them.
      for (let node: THREE.Object3D | null = mesh; node; node = node.parent) {
        if (node.userData?.isTerrain && !mesh.userData?.isTerrain) return false;
      }
      return isStaticLightingMesh(mesh, options.staticIds);
    };
    this.rayScene = new GpuRayScene(device);
    this.lighting = new GiLighting(device);
    this.means = new TextureMeans(device, () => undefined);
    this.rayScene.settle(scene, this.include, this.means.mean);

    this.bounds.getCenter(this.centre);
    const size = this.bounds.getSize(new THREE.Vector3());
    // Room to spare, since the grid's corner rounds to a whole number of cells.
    this.cellSize = Math.max(size.x / LIGHT_CELLS[0], size.y / LIGHT_CELLS[1], size.z / LIGHT_CELLS[2], 0.25) * 1.15;
    this.gatherLights();

    this.noAtlas = device.createTexture({ label: "gi no probes", size: [1, 1], format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING });
    this.noAtlasView = this.noAtlas.createView();
    this.params = device.createBuffer({ label: "gi bake", size: this.paramData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const shBytes = this.sh.byteLength;
    this.lastBounce = device.createBuffer({ label: "gi bake last bounce", size: shBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.output = device.createBuffer({ label: "gi bake output", size: shBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.rays = device.createBuffer({ label: "gi bake rays", size: MOST_PROBES_AT_ONCE * BAKE_RAYS * RAY_BYTES, usage: GPUBufferUsage.STORAGE });
    this.readback = device.createBuffer({ label: "gi bake read", size: shBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

    const compute = GPUShaderStage.COMPUTE;
    this.traceLayout = device.createBindGroupLayout({
      label: "gi bake trace",
      entries: [
        { binding: 0, visibility: compute, buffer: { type: "uniform" } },
        { binding: 1, visibility: compute, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: compute, buffer: { type: "storage" } },
      ],
    });
    this.reduceLayout = device.createBindGroupLayout({
      label: "gi bake reduce",
      entries: [
        { binding: 0, visibility: compute, buffer: { type: "uniform" } },
        { binding: 1, visibility: compute, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: compute, buffer: { type: "storage" } },
      ],
    });
    this.traceGroup = device.createBindGroup({
      label: "gi bake trace",
      layout: this.traceLayout,
      entries: [{ binding: 0, resource: { buffer: this.params } }, { binding: 1, resource: { buffer: this.lastBounce } }, { binding: 2, resource: { buffer: this.rays } }],
    });
    this.reduceGroup = device.createBindGroup({
      label: "gi bake reduce",
      layout: this.reduceLayout,
      entries: [{ binding: 0, resource: { buffer: this.params } }, { binding: 1, resource: { buffer: this.rays } }, { binding: 2, resource: { buffer: this.output } }],
    });
    const reduceModule = device.createShaderModule({ label: "gi bake reduce", code: BAKE_REDUCE_WGSL });
    const reduce = device.createPipelineLayout({ label: "gi bake reduce", bindGroupLayouts: [this.reduceLayout] });
    this.reduceLight = device.createComputePipeline({ label: "gi bake reduce light", layout: reduce, compute: { module: reduceModule, entryPoint: "reduceLight" } });
    this.reduceFaces = device.createComputePipeline({ label: "gi bake reduce faces", layout: reduce, compute: { module: reduceModule, entryPoint: "reduceFaces" } });
    void device.createComputePipelineAsync({
      label: "gi bake trace",
      layout: device.createPipelineLayout({ label: "gi bake trace", bindGroupLayouts: [this.lighting.layout, this.rayScene.layout, this.traceLayout] }),
      compute: { module: device.createShaderModule({ label: "gi bake trace", code: BAKE_TRACE_WGSL }), entryPoint: "bakeRays" },
    }).then((pipeline) => {
      this.tracePipeline = pipeline;
    }, (error: unknown) => {
      this.failure = error;
    });
    this.release = setSceneLightVolume(scene, null);
  }

  get done(): boolean {
    return this.finished;
  }

  get progress(): LightBakeProgress {
    const passes = this.options.bounces + 1;
    return { fraction: Math.min(1, (this.bounce * this.probes + this.next) / (passes * this.probes)), bounce: this.bounce };
  }

  /** The sky's image-based light, as it stands when the bake runs. */
  setEnvironment(environment: SkyEnvironmentProduct | undefined): void {
    this.environment = environment;
  }

  /** Sends off probes that should take about `budgetMs` on the graphics card; returns true once the bake is finished. */
  step(budgetMs: number): boolean {
    if (this.failure) throw this.failure;
    if (this.finished) return true;
    if (this.phase === "preparing") {
      this.means.run(this.textures);
      if (this.means.pending > 0 && --this.patience > 0) return false;
      // Now with each surface's own colour, for what has come in.
      this.rayScene.settle(this.scene, this.include, this.means.mean);
      this.phase = "tracing";
    }
    if (this.phase === "tracing" && this.tracePipeline) this.traceSome(budgetMs, this.tracePipeline);
    return false;
  }

  private gatherLights(): void {
    const staticIds = this.options.staticIds;
    const constant = new THREE.Vector3();
    const up = new THREE.Vector3();
    this.scene.traverseVisible((object) => {
      const light = object as THREE.Light;
      if (!light.isLight || light.intensity <= 0 || !isStaticLightingLight(light, staticIds)) return;
      const hemisphere = object as THREE.HemisphereLight;
      if (hemisphere.isHemisphereLight) {
        this.hemiSky.add(_color.copy(hemisphere.color).multiplyScalar(light.intensity));
        this.hemiGround.add(_color.copy(hemisphere.groundColor).multiplyScalar(light.intensity));
        // Radiance a + b*y lights a surface like three's hemisphere light: irradiance (s+g)/2 + (s-g)/2 n.y.
        const sr = hemisphere.color.r * light.intensity, sg = hemisphere.color.g * light.intensity, sb = hemisphere.color.b * light.intensity;
        const gr = hemisphere.groundColor.r * light.intensity, gg = hemisphere.groundColor.g * light.intensity, gb = hemisphere.groundColor.b * light.intensity;
        constant.x += (sr + gr) / (2 * Math.PI);
        constant.y += (sg + gg) / (2 * Math.PI);
        constant.z += (sb + gb) / (2 * Math.PI);
        up.x += ((sr - gr) * 3) / (4 * Math.PI);
        up.y += ((sg - gg) * 3) / (4 * Math.PI);
        up.z += ((sb - gb) * 3) / (4 * Math.PI);
      } else if ((object as THREE.AmbientLight).isAmbientLight) {
        this.ambient.add(_color.copy(light.color).multiplyScalar(light.intensity));
        constant.x += (light.color.r * light.intensity) / Math.PI;
        constant.y += (light.color.g * light.intensity) / Math.PI;
        constant.z += (light.color.b * light.intensity) / Math.PI;
      } else if ((object as THREE.DirectionalLight).isDirectionalLight) {
        this.directional.push(object as THREE.DirectionalLight);
      } else if ((object as THREE.PointLight).isPointLight || (object as THREE.SpotLight).isSpotLight) {
        this.local.push(object as THREE.PointLight);
      }
    });
    const data = this.paramData;
    data[16] = constant.x;
    data[17] = constant.y;
    data[18] = constant.z;
    data[20] = up.x;
    data[21] = up.y;
    data[22] = up.z;
  }

  private traceSome(budgetMs: number, pipeline: GPUComputePipeline): void {
    const { device, grid, paramData, paramWords } = this;
    const count = Math.min(this.probesAtOnce, MOST_PROBES_AT_ONCE, this.probes - this.next);
    this.lighting.update({
      directional: this.directional,
      local: this.local,
      ambient: this.ambient,
      hemiSky: this.hemiSky,
      hemiGround: this.hemiGround,
      environment: this.environment,
      grids: [],
      intensity: 1,
      bounce: 1,
      frame: this.bounce,
      centre: this.centre,
      cellSize: this.cellSize,
    });
    paramData[0] = grid.origin.x;
    paramData[1] = grid.origin.y;
    paramData[2] = grid.origin.z;
    paramData[3] = grid.spacing;
    paramWords[4] = grid.counts[0];
    paramWords[5] = grid.counts[1];
    paramWords[6] = grid.counts[2];
    paramWords[7] = Math.min(this.bounce, 2);
    paramWords[8] = this.next;
    paramWords[9] = count;
    paramWords[10] = BAKE_RAYS;
    paramData[12] = NORMAL_OFFSET * grid.spacing;
    paramData[13] = EDGE_FADE * grid.spacing;
    device.queue.writeBuffer(this.params, 0, paramData);

    const encoder = device.createCommandEncoder({ label: "gi bake" });
    this.rayScene.encodeRefit(encoder, this.rayScene.triangles);
    const tracing = encoder.beginComputePass({ label: "gi bake trace" });
    tracing.setPipeline(pipeline);
    tracing.setBindGroup(0, this.lighting.bindGroup(this.noAtlasView, this.lighting.environmentView(this.environment)));
    tracing.setBindGroup(1, this.rayScene.bindGroup());
    tracing.setBindGroup(2, this.traceGroup);
    tracing.dispatchWorkgroups(Math.ceil((count * BAKE_RAYS) / 64));
    tracing.end();
    const reducing = encoder.beginComputePass({ label: "gi bake reduce" });
    reducing.setBindGroup(0, this.reduceGroup);
    if (this.bounce === 0) {
      reducing.setPipeline(this.reduceFaces);
      reducing.dispatchWorkgroups(Math.ceil(count / 16));
    } else {
      reducing.setPipeline(this.reduceLight);
      reducing.dispatchWorkgroups(1, count);
    }
    reducing.end();
    this.next += count;
    const passEnded = this.next >= this.probes;
    if (passEnded) encoder.copyBufferToBuffer(this.output, 0, this.readback, 0, this.sh.byteLength);
    device.queue.submit([encoder.finish()]);

    this.phase = "waiting";
    const sent = performance.now();
    void device.queue.onSubmittedWorkDone().then(() => {
      if (this.disposed) return;
      // As many as would have taken about the time it has, next time.
      const each = Math.max((performance.now() - sent) / count, 1e-3);
      this.probesAtOnce = Math.max(1, Math.min(MOST_PROBES_AT_ONCE, Math.floor(budgetMs / each)));
      if (passEnded) this.readPass();
      else this.phase = "tracing";
    }, (error: unknown) => {
      this.failure = error;
    });
  }

  /** Ends a pass: what the graphics card worked out comes back, and is made ready for the next. */
  private readPass(): void {
    this.phase = "reading";
    void this.readback.mapAsync(GPUMapMode.READ).then(() => {
      if (this.disposed) return;
      const values = new Float32Array(this.readback.getMappedRange());
      if (this.bounce === 0) {
        for (let probe = 0; probe < this.probes; probe++) {
          const front = values[probe * SH_FLOATS_PER_PROBE];
          const back = values[probe * SH_FLOATS_PER_PROBE + 1];
          this.inside[probe] = back > 0 && back / (front + back) > INSIDE_BACK_FACE_SHARE ? 1 : 0;
        }
      } else {
        this.sh.set(values);
        this.keepBounce();
      }
      this.readback.unmap();
      this.next = 0;
      this.bounce++;
      if (this.bounce > this.options.bounces) this.finished = true;
      this.phase = "tracing";
    }, (error: unknown) => {
      if (!this.disposed) this.failure = error;
    });
  }

  /**
   * Ends a bounce: probes inside geometry take their neighbours' light, and the bounce is kept to light the geometry for
   * the next. The scene draws with it meanwhile, so what the bake has come to so far can be seen.
   */
  private keepBounce(): void {
    fillInvalidProbes(this.sh, this.inside.map((value) => (value ? 0 : 1)), this.grid.counts);
    this.device.queue.writeBuffer(this.lastBounce, 0, this.sh as Float32Array<ArrayBuffer>);
    const volume: LightVolume = {
      origin: this.grid.origin.clone(),
      spacing: this.grid.spacing,
      counts: this.grid.counts,
      sh: this.sh.slice(),
      intensity: 1,
    };
    this.release?.();
    this.release = setSceneLightVolume(this.scene, volume);
  }

  /** The baked probes; the bake must be finished. */
  result(): LightBakeResult {
    if (!this.finished) throw new Error("The light bake is not finished.");
    return { grid: this.grid, sh: this.sh.slice(), insideProbes: this.inside.reduce((count, value) => count + value, 0) };
  }

  dispose(): void {
    this.disposed = true;
    this.release?.();
    this.release = null;
    this.rayScene.destroy();
    this.lighting.destroy();
    this.means.destroy();
    this.noAtlas.destroy();
    for (const buffer of [this.params, this.lastBounce, this.output, this.rays, this.readback]) buffer.destroy();
  }
}
