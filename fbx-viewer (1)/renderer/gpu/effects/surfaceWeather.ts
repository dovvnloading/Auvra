/// <reference types="@webgpu/types" />
import { TARGET_FORMATS, type GpuFrame, type GpuPass } from "../frame";
import { FULLSCREEN_WGSL } from "../shaders";
import { WEATHER_UNIFORMS } from "../../../runtime/weatherSurfaces";
import { BindGroupCache, OCTAHEDRAL_WGSL, PAINT_LIGHT_TARGETS, TargetCopy, VIEW_HEAD_WGSL, WORLD_FROM_DEPTH_WGSL, beginPaintLight, effectPipelinesFor, type GpuEffect } from "./common";

/**
 * WEATHER ON SURFACES
 *
 * Rain darkens what it falls on and makes it shine, pooling into puddles on flat ground; snow settles on what faces up,
 * patchily while it is thin. In the WebGL path this is a patch in every lit material's shader. Here the whole surface
 * buffer is painted in one pass after the surface pass and the decals, so it reaches every kind of material at once and
 * costs nothing on a dry day. It reads the same numbers the sky already publishes for that patch (WEATHER_UNIFORMS),
 * cover included, so under a roof stays dry.
 *
 * What it reads is what it is about to change, so the normal and the emissive target are copied first.
 */

const WEATHER_ORDER = 30;
const UNIFORM_BYTES = 32;
/** Below this the weather has left nothing on the ground. */
const NOTHING = 0.001;

const WRITE_BLUE_ALPHA = 12;

const WEATHER_WGSL = /* wgsl */ `
${VIEW_HEAD_WGSL}
${FULLSCREEN_WGSL}
${OCTAHEDRAL_WGSL}
${WORLD_FROM_DEPTH_WGSL}

struct SurfaceWeather {
  coverOrigin: vec2f,
  wetness: f32,
  snow: f32,
  coverCell: f32,
  coverOn: f32,
}
@group(2) @binding(0) var<uniform> weather: SurfaceWeather;
@group(2) @binding(1) var surfaceDepth: texture_depth_2d;
@group(2) @binding(2) var normalCopy: texture_2d<f32>;
@group(2) @binding(3) var emissiveCopy: texture_2d<f32>;
@group(2) @binding(4) var cover: texture_2d<f32>;
@group(2) @binding(5) var underAlbedo: texture_2d<f32>;

fn weatherHash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn weatherNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (vec2f(3.0) - 2.0 * f);
  return mix(
    mix(weatherHash(i), weatherHash(i + vec2f(1.0, 0.0)), u.x),
    mix(weatherHash(i + vec2f(0.0, 1.0)), weatherHash(i + vec2f(1.0, 1.0)), u.x),
    u.y,
  );
}

fn weatherOpenAt(cell: vec2i, y: f32) -> f32 {
  let cells = vec2i(textureDimensions(cover));
  if (any(cell < vec2i(0)) || any(cell >= cells)) { return 1.0; }
  let top = textureLoad(cover, cell, 0).r;
  return smoothstep(top - 0.6, top - 0.2, y);
}

// How open to the sky a point is: 1 out in the weather, 0 under a roof, blended between cells.
fn weatherOpen(world: vec3f) -> f32 {
  if (weather.coverOn < 0.5) { return 1.0; }
  let g = (world.xz - weather.coverOrigin) / weather.coverCell - vec2f(0.5);
  let c = vec2i(floor(g));
  let f = g - floor(g);
  return mix(
    mix(weatherOpenAt(c, world.y), weatherOpenAt(c + vec2i(1, 0), world.y), f.x),
    mix(weatherOpenAt(c + vec2i(0, 1), world.y), weatherOpenAt(c + vec2i(1, 1), world.y), f.x),
    f.y,
  );
}

struct WeatherHere {
  // What the colour under it is multiplied by, and how much of snow's goes on top.
  keep: f32,
  snow: f32,
  roughness: f32,
  metalness: f32,
}

// The weather at a pixel of the surface buffer; returns false where there is no surface that takes it.
fn weatherAt(pixel: vec2f, out: ptr<function, WeatherHere>) -> bool {
  let coords = vec2i(pixel);
  let depth = textureLoad(surfaceDepth, coords, 0);
  if (depth <= 0.0) { return false; }
  // Unlit surfaces are markers and glows.
  if (textureLoad(emissiveCopy, coords, 0).a > 0.75) { return false; }
  let packed = textureLoad(normalCopy, coords, 0);
  let normal = decodeOctahedral(packed.xy);
  let world = worldFromDepth(pixel, depth);
  let facing = normal.y;
  let open = weatherOpen(world);
  let patches = weatherNoise(world.xz * 0.6) * 0.65 + weatherNoise(world.xz * 2.3) * 0.35;
  // Snow on what faces up, thin and patchy at first.
  let snow = open * smoothstep(0.0, 0.25, weather.snow * 1.25 - (1.0 - facing) * 0.9 - patches * 0.35);
  // Wet: darker and glossier, vertical faces less, flat ground pooling into puddles.
  let wet = weather.wetness * open * (1.0 - snow) * (0.6 + 0.4 * saturate(facing));
  let puddle = wet * smoothstep(0.5, 0.68, patches + weather.wetness * 0.12) * pow(saturate(facing), 6.0);
  var roughness = packed.b;
  roughness = mix(roughness, min(roughness, 0.22), wet);
  roughness = mix(roughness, 0.03, puddle);
  roughness = mix(roughness, 0.75, snow);
  (*out).keep = (1.0 - 0.42 * wet - 0.2 * puddle) * (1.0 - snow);
  (*out).snow = snow;
  (*out).roughness = roughness;
  (*out).metalness = mix(packed.a, 0.0, snow);
  return true;
}

const SNOW_COLOR = vec3f(0.86, 0.89, 0.93);

struct PaintOut {
  @location(0) albedo: vec4f,
  @location(1) surface: vec4f,
}

@fragment fn weatherSurface(in: FullscreenOut) -> PaintOut {
  var here: WeatherHere;
  if (!weatherAt(in.position.xy, &here)) { discard; }
  var out: PaintOut;
  // Added to the colour already there times this alpha.
  out.albedo = vec4f(SNOW_COLOR * here.snow, here.keep);
  out.surface = vec4f(0.0, 0.0, here.roughness, here.metalness);
  return out;
}

@fragment fn weatherLight(in: FullscreenOut) -> @location(0) vec4f {
  var here: WeatherHere;
  if (!weatherAt(in.position.xy, &here)) { discard; }
  let under = max(textureLoad(underAlbedo, vec2i(in.position.xy), 0).rgb, vec3f(0.04));
  let becomes = under * here.keep + SNOW_COLOR * here.snow;
  return vec4f(min(becomes / under, vec3f(4.0)), 1.0);
}
`;

class SurfaceWeatherPass implements GpuPass {
  readonly id = "effect-surface-weather";
  readonly stage = "surfaces" as const;
  readonly order = WEATHER_ORDER;
  private layouts: { surface: GPUBindGroupLayout; light: GPUBindGroupLayout } | null = null;
  private uniforms: GPUBuffer | null = null;
  private normalCopy: TargetCopy | null = null;
  private emissiveCopy: TargetCopy | null = null;
  private readonly data = new Float32Array(UNIFORM_BYTES / 4);
  private readonly surfaceGroups = new BindGroupCache();
  private readonly lightGroups = new BindGroupCache();

  execute(frame: GpuFrame): void {
    const wetness = WEATHER_UNIFORMS.uWeatherWetness.value;
    const snow = WEATHER_UNIFORMS.uWeatherSnow.value;
    if (wetness + snow <= NOTHING) return;
    const cover = frame.textures.acquire(WEATHER_UNIFORMS.uWeatherCover.value);
    if (!cover) return;

    const { device, targets } = frame;
    const layouts = this.layouts ?? (this.layouts = this.makeLayouts(device));
    const pipelines = effectPipelinesFor(device);
    const module = pipelines.module("surface weather", () => WEATHER_WGSL);
    const surfacePipeline = pipelines.render("surface weather", () => ({
      layout: device.createPipelineLayout({ label: "gpu surface weather", bindGroupLayouts: [frame.cameraLayout, frame.sceneLayout, layouts.surface] }),
      vertex: { module, entryPoint: "fullscreenVertex" },
      fragment: {
        module,
        entryPoint: "weatherSurface",
        targets: [
          {
            format: TARGET_FORMATS.albedo,
            blend: {
              color: { srcFactor: "one", dstFactor: "src-alpha", operation: "add" },
              alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
            },
          },
          // What it read from the copy, changed: the normal's own two channels stay.
          { format: TARGET_FORMATS.normal, writeMask: WRITE_BLUE_ALPHA },
        ],
      },
      primitive: { topology: "triangle-list" },
    }));
    const lightPipeline = pipelines.render("surface weather light", () => ({
      layout: device.createPipelineLayout({ label: "gpu surface weather light", bindGroupLayouts: [frame.cameraLayout, frame.sceneLayout, layouts.light] }),
      vertex: { module, entryPoint: "fullscreenVertex" },
      fragment: { module, entryPoint: "weatherLight", targets: PAINT_LIGHT_TARGETS },
      primitive: { topology: "triangle-list" },
    }));
    if (!surfacePipeline || !lightPipeline) return;

    const uniforms = this.uniforms ?? (this.uniforms = device.createBuffer({ label: "gpu surface weather", size: UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    const { data } = this;
    data[0] = WEATHER_UNIFORMS.uWeatherCoverOrigin.value.x;
    data[1] = WEATHER_UNIFORMS.uWeatherCoverOrigin.value.y;
    data[2] = wetness;
    data[3] = snow;
    data[4] = WEATHER_UNIFORMS.uWeatherCoverCell.value;
    data[5] = WEATHER_UNIFORMS.uWeatherCoverOn.value;
    device.queue.writeBuffer(uniforms, 0, data);

    const normalCopy = (this.normalCopy ?? (this.normalCopy = new TargetCopy(device, "gpu weather normal copy", TARGET_FORMATS.normal))).take(frame, targets.normal.texture);
    const emissiveCopy = (this.emissiveCopy ?? (this.emissiveCopy = new TargetCopy(device, "gpu weather emissive copy", TARGET_FORMATS.emissive))).take(frame, targets.emissive.texture);
    const shared: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: uniforms } },
      { binding: 1, resource: targets.depth.view },
      { binding: 2, resource: normalCopy },
      { binding: 3, resource: emissiveCopy },
      { binding: 4, resource: cover.view },
    ];
    const lightGroup = this.lightGroups.get([targets.depth.view, normalCopy, emissiveCopy, cover.view, targets.albedo.view], () => device.createBindGroup({
      label: "gpu surface weather light",
      layout: layouts.light,
      entries: [...shared, { binding: 5, resource: targets.albedo.view }],
    }));
    const surfaceGroup = this.surfaceGroups.get([targets.depth.view, normalCopy, emissiveCopy, cover.view], () => device.createBindGroup({
      label: "gpu surface weather",
      layout: layouts.surface,
      entries: shared,
    }));

    // The light first: it reads the colour before this changes it.
    const light = beginPaintLight(frame, "gpu surface weather light");
    light.setPipeline(lightPipeline);
    light.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    light.setBindGroup(1, frame.sceneBindGroup);
    light.setBindGroup(2, lightGroup);
    light.draw(3);
    light.end();
    const surface = frame.encoder.beginRenderPass({
      label: "gpu surface weather",
      colorAttachments: [
        { view: targets.albedo.view, loadOp: "load", storeOp: "store" },
        { view: targets.normal.view, loadOp: "load", storeOp: "store" },
      ],
    });
    surface.setPipeline(surfacePipeline);
    surface.setBindGroup(0, frame.cameraBindGroup, [frame.mainViewOffset]);
    surface.setBindGroup(1, frame.sceneBindGroup);
    surface.setBindGroup(2, surfaceGroup);
    surface.draw(3);
    surface.end();
  }

  private makeLayouts(device: GPUDevice) {
    const visibility = GPUShaderStage.FRAGMENT;
    const texture = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility, texture: { sampleType: "unfilterable-float" } });
    const shared: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility, buffer: { type: "uniform" } },
      { binding: 1, visibility, texture: { sampleType: "depth" } },
      texture(2),
      texture(3),
      texture(4),
    ];
    return {
      surface: device.createBindGroupLayout({ label: "gpu surface weather", entries: shared }),
      light: device.createBindGroupLayout({ label: "gpu surface weather light", entries: [...shared, texture(5)] }),
    };
  }

  dispose(): void {
    this.uniforms?.destroy();
    this.normalCopy?.destroy();
    this.emissiveCopy?.destroy();
    this.uniforms = null;
    this.normalCopy = null;
    this.emissiveCopy = null;
  }
}

export class SurfaceWeatherEffect implements GpuEffect {
  readonly passes = [new SurfaceWeatherPass()];
}
