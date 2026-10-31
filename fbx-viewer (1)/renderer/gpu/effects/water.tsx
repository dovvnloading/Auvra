/// <reference types="@webgpu/types" />
import React, { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { TARGET_FORMATS, type GpuFrame, type GpuPass } from "../frame";
import type { LightingProduct } from "../lightingWgsl";
import type { DepthPyramidProduct } from "../passes/depthPyramid";
import { CASCADES_WANTED } from "../passes/virtualShadows";
import { VIEW_WGSL, CAMERA_BINDINGS_WGSL } from "../shaders";
import { BindGroupCache, TargetCopy, UniformSlices, WORLD_FROM_DEPTH_WGSL, effectPipelinesFor, isDrawnIn, useEffectEntry, type GpuEntryEffect } from "./common";

/**
 * WATER
 *
 * A surface of summed waves drawn in the forward stage, before the transparent things that float over it. What is under
 * the water is the lit picture so far, copied and read back bent by the waves, dimmed and tinted by how far the light
 * has come through the water. What is on it is the frame's light: the sun with its shadow, the environment, foam. Above
 * that goes what the surface mirrors: found by walking the depth buffer along the reflected ray, and where that finds
 * nothing, the environment the light already took.
 *
 * The depth it reads is level 0 of frame.products "depthPyramid", the opaque scene as a texture it may read while
 * writing its own depth to the target. It writes the screen's motion too, because under open sea there is nothing else
 * at those pixels to reproject by.
 *
 * Waves must be the ones buoyancy floats things on, so the time comes from the component and not from the renderer.
 */

/** Before everything else in the forward stage. */
const WATER_ORDER = -10;
const WATER_BYTES = 288;
const MAX_SEGMENTS = 256;

export interface GpuWave {
  amplitude: number;
  k: number;
  omega: number;
  dx: number;
  dz: number;
}

export interface GpuWaterSettings {
  /** Extent along the object's local X and Z (Y is ignored). */
  size: readonly [number, number, number];
  color: string;
  opacity: number;
  waveLength: number;
  foam: number;
  roughness: number;
}

const WATER_WGSL = /* wgsl */ `
${VIEW_WGSL}${CAMERA_BINDINGS_WGSL}
struct Water {
  model: mat4x4f,
  previousModel: mat4x4f,
  // Amplitude, wavenumber, angular speed, unused.
  waves: array<vec4f, 3>,
  // Direction x, direction z, unused, unused.
  directions: array<vec4f, 3>,
  color: vec4f,
  // Foam, roughness, time, the highest the waves reach.
  params: vec4f,
  // Size x, size z, segments x, segments z.
  grid: vec4f,
  // Light lost per metre of water, rgb.
  absorption: vec4f,
}
@group(2) @binding(0) var<uniform> water: Water;
@group(2) @binding(1) var sceneColor: texture_2d<f32>;
@group(2) @binding(2) var sceneDepth: texture_2d<f32>;
@group(2) @binding(3) var sceneSampler: sampler;

${WORLD_FROM_DEPTH_WGSL}
LIGHTING_WGSL_HERE

fn waveHeightAt(p: vec2f) -> f32 {
  var height = 0.0;
  for (var index = 0u; index < 3u; index++) {
    let wave = water.waves[index];
    height += wave.x * sin(wave.y * dot(water.directions[index].xy, p) - wave.z * water.params.z);
  }
  return height;
}

fn waveSlopeAt(p: vec2f) -> vec2f {
  var slope = vec2f(0.0);
  for (var index = 0u; index < 3u; index++) {
    let wave = water.waves[index];
    slope += wave.x * wave.y * water.directions[index].xy * cos(wave.y * dot(water.directions[index].xy, p) - wave.z * water.params.z);
  }
  return slope;
}

struct WaterVarying {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) local: vec2f,
  @location(2) height: f32,
  @location(3) motionNow: vec4f,
  @location(4) motionThen: vec4f,
}

@vertex fn waterVertex(@builtin(vertex_index) index: u32) -> WaterVarying {
  let segments = vec2u(water.grid.zw);
  let quad = index / 6u;
  var corners = array<vec2u, 6>(vec2u(0u, 0u), vec2u(0u, 1u), vec2u(1u, 0u), vec2u(1u, 0u), vec2u(0u, 1u), vec2u(1u, 1u));
  let cell = vec2u(quad % segments.x, quad / segments.x) + corners[index % 6u];
  let local = (vec2f(cell) / vec2f(segments) - vec2f(0.5)) * water.grid.xy;
  let height = waveHeightAt(local);
  let at = vec4f(local.x, height, local.y, 1.0);
  let world = water.model * at;
  var out: WaterVarying;
  out.clip = view.viewProjection * world;
  out.world = world.xyz;
  out.local = local;
  out.height = height;
  out.motionNow = view.unjitteredViewProjection * world;
  out.motionThen = view.previousViewProjection * (water.previousModel * at);
  return out;
}

fn rippleHash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

// Smooth noise's height and how it rises in x and y.
fn rippleNoise(p: vec2f) -> vec3f {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (vec2f(3.0) - 2.0 * f);
  let du = 6.0 * f * (vec2f(1.0) - f);
  let a = rippleHash(i);
  let b = rippleHash(i + vec2f(1.0, 0.0));
  let c = rippleHash(i + vec2f(0.0, 1.0));
  let d = rippleHash(i + vec2f(1.0, 1.0));
  return vec3f(
    a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y,
    du.x * ((b - a) + (a - b - c + d) * u.y),
    du.y * ((c - a) + (a - b - c + d) * u.x),
  );
}

// Small waves too fine for the mesh, which go when there are no waves at all and fade with distance before they alias.
fn rippleSlope(p: vec2f, distanceAway: f32) -> vec2f {
  let time = water.params.z;
  let amount = min(water.params.w * 4.0, 1.0) * 0.09 / (1.0 + distanceAway * 0.04);
  let near = rippleNoise(p * 1.7 + vec2f(time * 0.31, time * 0.17)).yz;
  let far = rippleNoise(p.yx * 4.3 - vec2f(time * 0.47, time * 0.29)).yz;
  return (near + far * 0.5) * amount;
}

fn worldNormalOf(n: vec3f) -> vec3f {
  let a = water.model[0].xyz;
  let b = water.model[1].xyz;
  let c = water.model[2].xyz;
  return normalize(mat3x3f(cross(b, c), cross(c, a), cross(a, b)) * n);
}

// Walks the reflected ray across the screen against the depth buffer. A hit is the picture there; rgb is black and alpha
// zero where the ray left the screen or met nothing, which the caller fills from the environment.
fn traceReflection(origin: vec3f, direction: vec3f, roughness: f32) -> vec4f {
  const STEPS = 28u;
  const REACH = 80.0;
  var start = view.viewProjection * vec4f(origin, 1.0);
  var end = view.viewProjection * vec4f(origin + direction * REACH, 1.0);
  // A ray toward the eye's own plane is cut short where it would go behind it.
  if (end.w < 0.05) {
    let keep = (start.w - 0.05) / max(start.w - end.w, 1e-4);
    end = mix(start, end, keep);
  }
  let a = start.xyz / start.w;
  let b = end.xyz / end.w;
  let stepNdc = (b - a) / f32(STEPS);
  // A thin wall should not stop a ray that passed behind it, and how thick is judged in depth at that distance.
  var at = a + stepNdc * 1.5;
  var previous = a;
  for (var index = 0u; index < STEPS; index++) {
    if (any(abs(at.xy) > vec2f(1.0))) { break; }
    let uv = vec2f(at.x, -at.y) * 0.5 + vec2f(0.5);
    let pixel = vec2i(uv * view.size.xy);
    let surface = textureLoad(sceneDepth, pixel, 0).r;
    // Depth is reversed: the ray is behind what is drawn when its number is smaller.
    if (surface > 0.0 && at.z < surface) {
      let gap = surface - at.z;
      if (gap <= abs(at.z - previous.z) * 2.0 + 1e-5) {
        // Where the ray runs off the screen it fades, rather than ending in a line.
        let edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
        let along = 1.0 - f32(index) / f32(STEPS);
        let hit = smoothstep(0.0, 0.08, edge) * smoothstep(0.0, 0.25, along) * (1.0 - roughness);
        return vec4f(textureSampleLevel(sceneColor, sceneSampler, uv, 0.0).rgb, hit);
      }
    }
    previous = at;
    at += stepNdc;
  }
  return vec4f(0.0);
}

struct WaterOut {
  @location(0) color: vec4f,
  @location(1) motion: vec2f,
}

@fragment fn waterFragment(in: WaterVarying) -> WaterOut {
  let pixel = in.clip.xy;
  let toEye = view.eye.xyz - in.world;
  let distanceAway = length(toEye);
  let viewDirection = toEye / distanceAway;
  let slope = waveSlopeAt(in.local) + rippleSlope(in.world.xz, distanceAway);
  let planeUp = worldNormalOf(vec3f(0.0, 1.0, 0.0));
  let above = dot(toEye, planeUp) >= 0.0;
  var normal = worldNormalOf(normalize(vec3f(-slope.x, 1.0, -slope.y)));
  if (!above) { normal = -normal; }

  // What is seen through the water, bent by its surface; a bend that lands on something in front of it is not taken.
  let uv = pixel * view.size.zw;
  let groundDepth = textureLoad(sceneDepth, vec2i(pixel), 0).r;
  let groundGap = select(1e4, distance(worldFromDepth(pixel, groundDepth), in.world), groundDepth > 0.0);
  let bend = (slope * vec2f(1.0, -1.0)) * 0.12 * min(groundGap, 4.0) / (1.0 + distanceAway * 0.05);
  var seenUv = clamp(uv + bend, vec2f(0.0), vec2f(1.0));
  var seenDepth = textureLoad(sceneDepth, vec2i(seenUv * view.size.xy), 0).r;
  if (seenDepth > in.clip.z) {
    seenUv = uv;
    seenDepth = groundDepth;
  }
  let seen = textureSampleLevel(sceneColor, sceneSampler, seenUv, 0.0).rgb;

  // How far the light has come through the water to the eye, and what is left of it.
  let throughWater = select(1e4, distance(worldFromDepth(seenUv * view.size.xy, seenDepth), in.world), seenDepth > 0.0);
  var transmitted = exp(-water.absorption.rgb * throughWater);
  let body = 1.0 - dot(transmitted, vec3f(1.0 / 3.0));
  var albedo = water.color.rgb * body;

  // Foam on the crests, and where the water meets what stands in it.
  let foamAmount = water.params.x;
  let crest = select(0.0, smoothstep(0.35, 1.0, in.height / water.params.w), water.params.w > 0.0);
  let lapping = 1.0 - smoothstep(0.0, 0.5, groundGap);
  let breakup = rippleNoise(in.world.xz * 3.0 + vec2f(water.params.z * 0.2, 0.0)).x;
  let foam = saturate(crest * foamAmount + lapping * foamAmount * smoothstep(0.25, 0.75, breakup));
  albedo = mix(albedo, vec3f(0.92, 0.96, 1.0), foam);
  transmitted *= 1.0 - foam;
  let roughness = mix(water.params.y, 0.85, foam);

  // The light on it, sun and environment both. Colour was scaled by how much body the water has there, so shallow water
  // gives its light to what is under it and keeps the highlights.
  let lit = lightSurface(lightingInput(in.world, normal, viewDirection, albedo, roughness, 0.1, pixel));

  let f0 = mix(vec3f(0.04), albedo, 0.1);
  let dotNV = saturate(dot(normal, viewDirection));
  let reflectance = F_Schlick(f0, 1.0, dotNV);
  let reflected = reflect(-viewDirection, normal);
  // Up off the surface, so a steep wave does not reflect what is under the water.
  let side = select(-planeUp, planeUp, above);
  let aimed = normalize(reflected + side * max(-dot(reflected, side), 0.0) * 1.05);
  let traced = traceReflection(in.world, aimed, roughness);
  var mirrored = vec3f(0.0);
  if (traced.a > 0.0) {
    // In place of what lightSurface took from the environment in this direction.
    var environment = vec3f(0.0);
    if (lighting.environmentMips > 0.0) {
      environment = textureSampleLevel(lightingEnvironment, lightingEnvironmentSampler, aimed, roughness * (lighting.environmentMips - 1.0)).rgb;
    }
    mirrored = (traced.rgb - environment) * reflectance * traced.a;
  }

  let total = lit + mirrored + seen * transmitted * (vec3f(1.0) - reflectance);
  var out: WaterOut;
  out.color = vec4f(lightingApplyFog(max(total, vec3f(0.0)), in.world), 1.0);
  let now = in.motionNow.xy / in.motionNow.w;
  let then = in.motionThen.xy / max(in.motionThen.w, 1e-5);
  out.motion = (then - now) * vec2f(0.5, -0.5);
  return out;
}
`;

/** One water surface: what the component set and where its object is. */
export class GpuWaterEntry {
  anchor: THREE.Object3D | null = null;
  settings: GpuWaterSettings | null = null;
  waves: readonly GpuWave[] = [];
  time = 0;
  readonly previous = new THREE.Matrix4();
  hasPrevious = false;

  constructor(readonly scene: THREE.Object3D) {}
}

const _sphere = new THREE.Sphere();
const _frustum = new THREE.Frustum();
const _matrix = new THREE.Matrix4();
const _scale = new THREE.Vector3();
const _color = new THREE.Color();

/** About eight quads per wavelength, at most 256 per side: as many as the WebGL path. */
const segmentsFor = (extent: number, waveLength: number): number => Math.min(MAX_SEGMENTS, Math.max(1, Math.ceil((extent / waveLength) * 8)));

class WaterPass implements GpuPass {
  readonly id = "effect-water";
  readonly stage = "forward" as const;
  readonly order = WATER_ORDER;
  private layout: GPUBindGroupLayout | null = null;
  private sampler: GPUSampler | null = null;
  private slices: UniformSlices | null = null;
  private copy: TargetCopy | null = null;
  private readonly groups = new BindGroupCache();
  private readonly drawn: GpuWaterEntry[] = [];

  constructor(private readonly entries: Set<GpuWaterEntry>) {}

  execute(frame: GpuFrame): void {
    const { drawn } = this;
    drawn.length = 0;
    _frustum.setFromProjectionMatrix(_matrix.multiplyMatrices(frame.camera.projectionMatrix, frame.camera.matrixWorldInverse));
    for (const entry of this.entries) {
      if (entry.scene !== frame.scene || !entry.settings || !isDrawnIn(entry.anchor, frame.scene)) continue;
      const { size } = entry.settings;
      const world = entry.anchor!.matrixWorld;
      _sphere.center.setFromMatrixPosition(world);
      _scale.setFromMatrixScale(world);
      const height = entry.waves.reduce((sum, wave) => sum + wave.amplitude, 0);
      _sphere.radius = Math.hypot(size[0] * _scale.x, size[2] * _scale.z) / 2 + height * _scale.y;
      if (_frustum.intersectsSphere(_sphere)) drawn.push(entry);
    }
    if (!drawn.length) return;
    const lighting = frame.products.get("lighting") as LightingProduct | undefined;
    frame.products.set(CASCADES_WANTED, frame.frameNumber);
    const pyramid = frame.products.get("depthPyramid") as DepthPyramidProduct | undefined;
    if (!lighting || !pyramid) return;

    const { device } = frame;
    const layout = this.layout ?? (this.layout = device.createBindGroupLayout({
      label: "gpu water",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: WATER_BYTES } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    }));
    const pipelines = effectPipelinesFor(device);
    const pipeline = pipelines.render("water", () => {
      const module = pipelines.module("water", () => WATER_WGSL.replace("LIGHTING_WGSL_HERE", lighting.wgsl));
      return {
        layout: device.createPipelineLayout({ label: "gpu water", bindGroupLayouts: [frame.cameraLayout, frame.sceneLayout, layout, lighting.layout] }),
        vertex: { module, entryPoint: "waterVertex" },
        fragment: { module, entryPoint: "waterFragment", targets: [{ format: TARGET_FORMATS.hdr }, { format: TARGET_FORMATS.motion }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: TARGET_FORMATS.depth, depthWriteEnabled: true, depthCompare: "greater-equal" },
      };
    });
    if (!pipeline) return;

    const slices = this.slices ?? (this.slices = new UniformSlices(device, "gpu water", WATER_BYTES));
    slices.ensure(drawn.length);
    const offsets = drawn.map((entry, index) => this.pack(slices, entry, index));

    const copy = this.copy ?? (this.copy = new TargetCopy(device, "gpu water scene copy", TARGET_FORMATS.hdr));
    const seen = copy.take(frame, frame.targets.hdr.texture);
    const sampler = this.sampler ?? (this.sampler = device.createSampler({ label: "gpu water", magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }));
    const group = this.groups.get([seen, pyramid.view, slices.buffer], () => device.createBindGroup({
      label: "gpu water",
      layout,
      entries: [
        { binding: 0, resource: slices.binding },
        { binding: 1, resource: seen },
        { binding: 2, resource: pyramid.view },
        { binding: 3, resource: sampler },
      ],
    }));

    const { hdr, motion, depth } = frame.targets;
    const pass = frame.encoder.beginRenderPass({
      label: "gpu water",
      colorAttachments: [
        { view: hdr.view, loadOp: "load", storeOp: "store" },
        { view: motion.view, loadOp: "load", storeOp: "store" },
      ],
      depthStencilAttachment: { view: depth.view, depthLoadOp: "load", depthStoreOp: "store" },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    pass.setBindGroup(1, frame.sceneBindGroup);
    pass.setBindGroup(3, lighting.bindGroup);
    drawn.forEach((entry, index) => {
      const { size, waveLength } = entry.settings!;
      pass.setBindGroup(2, group, [offsets[index]]);
      pass.draw(segmentsFor(size[0], waveLength) * segmentsFor(size[2], waveLength) * 6);
    });
    pass.end();
  }

  private pack(slices: UniformSlices, entry: GpuWaterEntry, index: number): number {
    const { data } = slices;
    const settings = entry.settings!;
    const world = entry.anchor!.matrixWorld;
    if (!entry.hasPrevious) {
      entry.previous.copy(world);
      entry.hasPrevious = true;
    }
    data.set(world.elements, 0);
    data.set(entry.previous.elements, 16);
    entry.previous.copy(world);
    let top = 0;
    for (let wave = 0; wave < 3; wave++) {
      const each = entry.waves[wave];
      data[32 + wave * 4] = each?.amplitude ?? 0;
      data[33 + wave * 4] = each?.k ?? 0;
      data[34 + wave * 4] = each?.omega ?? 0;
      data[44 + wave * 4] = each?.dx ?? 0;
      data[45 + wave * 4] = each?.dz ?? 0;
      top += each?.amplitude ?? 0;
    }
    _color.set(settings.color);
    data[56] = _color.r;
    data[57] = _color.g;
    data[58] = _color.b;
    data[59] = settings.opacity;
    data[60] = settings.foam;
    data[61] = settings.roughness;
    data[62] = entry.time;
    data[63] = top;
    data[64] = settings.size[0];
    data[65] = settings.size[2];
    data[66] = segmentsFor(settings.size[0], settings.waveLength);
    data[67] = segmentsFor(settings.size[2], settings.waveLength);
    // Opacity says how soon the water closes over what is in it, and its colour which light goes first.
    const density = (settings.opacity / Math.max(1.02 - settings.opacity, 0.02)) * 0.25;
    data[68] = density * (1.2 - _color.r);
    data[69] = density * (1.2 - _color.g);
    data[70] = density * (1.2 - _color.b);
    return slices.write(index);
  }

  dispose(): void {
    this.slices?.destroy();
    this.copy?.destroy();
    this.slices = null;
    this.copy = null;
    this.groups.clear();
  }
}

class WaterEffect implements GpuEntryEffect<GpuWaterEntry> {
  readonly entries = new Set<GpuWaterEntry>();
  readonly passes = [new WaterPass(this.entries)];
}

const makeWater = (): WaterEffect => new WaterEffect();

/** Draws a water surface at this point in the scene graph; the object's own transform places it. */
export const GpuWaterSurface: React.FC<{ settings: GpuWaterSettings; waves: readonly GpuWave[] }> = ({ settings, waves }) => {
  const scene = useThree((state) => state.scene);
  const anchor = useRef<THREE.Group>(null);
  const entry = useMemo(() => new GpuWaterEntry(scene), [scene]);
  useEffectEntry("water", makeWater, entry);
  useEffect(() => {
    entry.anchor = anchor.current;
    return () => {
      entry.anchor = null;
    };
  }, [entry]);
  useEffect(() => {
    entry.settings = settings;
    entry.waves = waves;
  }, [entry, settings, waves]);
  useFrame(({ clock }) => {
    entry.time = clock.elapsedTime;
  });
  return <group ref={anchor} />;
};
