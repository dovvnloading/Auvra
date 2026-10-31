/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { TARGET_FORMATS, type GpuFrame, type GpuPass, type GpuRendererApi } from "../frame";
import { WEATHER_UNIFORMS } from "../../../runtime/weatherSurfaces";
import { OPEN_SKY, type WeatherCover } from "../../../runtime/weatherCover";
import type { WeatherState } from "../../../runtime/weather";
import { windAt, windTime } from "../../../runtime/wind";
import { beginForwardRenderPass, bindForwardView } from "../passes/forward";
import { BindGroupCache, VIEW_HEAD_WGSL, effectPipelinesFor } from "./common";

/**
 * PRECIPITATION
 *
 * Rain and snow round the camera, with no simulation at all. Every drop is a pure function of its number and how far all
 * the rain has fallen and blown so far: where it starts in a box that wraps round the camera, so drops keep their place
 * in the world and the camera never outruns the weather. Reading what is overhead (the weather cover) in the vertex
 * shader ends each one at the roof above it. Splashes and ripples are the same idea on a clock: each has a slot of time
 * and a place chosen by its number and its slot, only ever where something is there to land on.
 *
 * This is `Precipitation` in runtime/precipitation.ts for the GPU renderer, with the same `update` and `object`, so the
 * sky keeps calling it the same way. Runs at order 30 in the forward stage: over the scene's transparent things.
 */

const PRECIPITATION_ORDER = 30;
const UNIFORM_BYTES = 96;

/** Half the box's width, m, how far above the camera it starts, and how far down it reaches. */
const RAIN_HALF = 16;
const RAIN_TOP = 16;
const RAIN_DEPTH = 46;
const SNOW_HALF = 16;
const SNOW_TOP = 12;
const SNOW_DEPTH = 26;
/** Drops and flakes alive at full strength. */
const RAIN_CAPACITY = 14000;
const SNOW_CAPACITY = 16000;
const SPLASH_CAPACITY = 2400;
const RIPPLE_CAPACITY = 600;
/** Splashes and ripples only where they can be seen, m. */
const SPLASH_RANGE = 20;
const RIPPLE_RANGE = 14;
/** How fast rain falls, m/s (its terminal speed), and snow. */
const RAIN_SPEED = 9.5;
const SNOW_SPEED = 1.1;
/** How strongly snow takes the wind beside rain. */
const SNOW_WIND = 0.8;
/** With no cover known, where the ground is. */
const GROUND_PLANE = 0;
/** Seconds an instant of rain has to show, by how heavy it is: heavy rain fills the box, a drizzle does not. */
const RAIN_POWER = 1.3;

const PRECIPITATION_WGSL = /* wgsl */ `
${VIEW_HEAD_WGSL}
struct Weather {
  // How far the wind has carried the rain, then the snow.
  rainDrift: vec2f,
  snowDrift: vec2f,
  // How far they have fallen; the time; how strong the wind is across the rain now.
  rainFall: f32,
  snowFall: f32,
  time: f32,
  rainSpeed: f32,
  rainLean: vec2f,
  coverOrigin: vec2f,
  coverCell: f32,
  coverOn: f32,
  rainLight: f32,
  snowLight: f32,
  groundPlane: f32,
  openSky: f32,
  rainFlakes: f32,
  ripples: f32,
}
@group(2) @binding(0) var<uniform> weather: Weather;
@group(2) @binding(1) var cover: texture_2d<f32>;

fn hash(seed: u32) -> u32 {
  let state = seed * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn random3(seed: u32) -> vec3f {
  let a = hash(seed);
  let b = hash(a);
  let c = hash(b);
  return vec3f(f32(a), f32(b), f32(c)) / 4294967296.0;
}

// The coordinate wrapped to within half of the box around the camera's.
fn wrapped(value: f32, center: f32, half: f32) -> f32 {
  let span = half * 2.0;
  return center + (fract((value - center) / span + 0.5) - 0.5) * span;
}

// The top of what is over a point: nothing out of the cover's reach, the ground with no cover known.
fn landingAt(xz: vec2f) -> f32 {
  if (weather.coverOn < 0.5) { return weather.groundPlane; }
  let cell = vec2i(floor((xz - weather.coverOrigin) / weather.coverCell));
  if (any(cell < vec2i(0)) || any(cell >= vec2i(textureDimensions(cover)))) { return weather.openSky; }
  return textureLoad(cover, cell, 0).r;
}

struct DropVarying {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
}

const CORNERS = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));

fn hidden() -> DropVarying {
  var out: DropVarying;
  out.clip = vec4f(0.0, 0.0, -1.0, 1.0);
  out.uv = vec2f(0.0);
  out.color = vec4f(0.0);
  return out;
}

// Never thinner than most of a pixel, so that far rain thins out by fading and not by flickering between pixels.
fn pixelWide(world: vec3f, width: f32) -> f32 {
  if (view.orthographic != 0u || view.params.y <= 0.0) { return width; }
  return max(width, distance(view.eye.xyz, world) / view.params.y * 0.8);
}

@vertex fn rainVertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) index: u32) -> DropVarying {
  let seed = random3(index * 3u + 1u);
  let eye = view.eye.xyz;
  let span = ${RAIN_HALF * 2}.0;
  let x = wrapped(seed.x * span + weather.rainDrift.x, eye.x, ${RAIN_HALF}.0);
  let z = wrapped(seed.z * span + weather.rainDrift.y, eye.z, ${RAIN_HALF}.0);
  let bottom = eye.y + ${RAIN_TOP}.0 - ${RAIN_DEPTH}.0;
  let y = bottom + fract((seed.y * ${RAIN_DEPTH}.0 - weather.rainFall - bottom) / ${RAIN_DEPTH}.0) * ${RAIN_DEPTH}.0;
  if (y < landingAt(vec2f(x, z))) { return hidden(); }
  let at = vec3f(x, y, z);
  let velocity = vec3f(weather.rainLean.x, -weather.rainSpeed, weather.rainLean.y);
  let direction = normalize(velocity);
  // As long as how far a drop falls while the eye takes it in, and turned to face the eye about its length.
  let streak = 0.024 * length(velocity) * 2.0 * (0.8 + 0.4 * fract(seed.x * 13.0));
  let width = pixelWide(at, 0.012 + 0.008 * seed.y);
  let across = normalize(cross(direction, eye - at));
  let c = CORNERS[corner];
  var out: DropVarying;
  out.clip = view.viewProjection * vec4f(at + across * c.x * width + direction * c.y * streak, 1.0);
  out.uv = c;
  let fade = 1.0 - smoothstep(10.0, ${RAIN_HALF}.0, distance(vec2f(x, z), eye.xz));
  out.color = vec4f(vec3f(0.66, 0.76, 0.89) * weather.rainLight, 0.5 * fade);
  return out;
}

@vertex fn snowVertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) index: u32) -> DropVarying {
  let seed = random3(index * 3u + 2u);
  let eye = view.eye.xyz;
  let span = ${SNOW_HALF * 2}.0;
  // Each flake wanders about its path, a little differently.
  let wander = vec2f(sin(weather.time * (0.4 + seed.y) + seed.x * 40.0), cos(weather.time * (0.3 + seed.x) + seed.z * 40.0)) * 0.5;
  let x = wrapped(seed.x * span + weather.snowDrift.x + wander.x, eye.x, ${SNOW_HALF}.0);
  let z = wrapped(seed.z * span + weather.snowDrift.y + wander.y, eye.z, ${SNOW_HALF}.0);
  let bottom = eye.y + ${SNOW_TOP}.0 - ${SNOW_DEPTH}.0;
  let y = bottom + fract((seed.y * ${SNOW_DEPTH}.0 - weather.snowFall - bottom) / ${SNOW_DEPTH}.0) * ${SNOW_DEPTH}.0;
  if (y < landingAt(vec2f(x, z))) { return hidden(); }
  let at = vec3f(x, y, z);
  let size = pixelWide(at, 0.045 + 0.035 * seed.z);
  let right = vec3f(view.viewMatrix[0].x, view.viewMatrix[1].x, view.viewMatrix[2].x);
  let up = vec3f(view.viewMatrix[0].y, view.viewMatrix[1].y, view.viewMatrix[2].y);
  let c = CORNERS[corner];
  var out: DropVarying;
  out.clip = view.viewProjection * vec4f(at + (right * c.x + up * c.y) * size, 1.0);
  out.uv = c;
  let fade = 1.0 - smoothstep(11.0, ${SNOW_HALF}.0, distance(vec2f(x, z), eye.xz));
  out.color = vec4f(vec3f(0.9, 0.93, 0.97) * weather.snowLight, 0.85 * fade);
  return out;
}

struct Slot {
  xz: vec2f,
  age: f32,
  seed: vec3f,
}

// Where one of the count things lands on the clock, in a cycle of a given length.
fn slotOf(index: u32, salt: u32, cycle: f32, range: f32) -> Slot {
  let phase = random3(index * 5u + salt).x;
  let t = weather.time / cycle + phase;
  let turn = u32(floor(t));
  let chosen = random3((turn * 8191u) ^ (index * 31u + salt));
  var out: Slot;
  out.age = t - floor(t);
  out.seed = chosen;
  out.xz = view.eye.xz + (chosen.xy - vec2f(0.5)) * range * 2.0;
  return out;
}

@vertex fn splashVertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) index: u32) -> DropVarying {
  let slot = slotOf(index, 11u, 0.32, ${SPLASH_RANGE}.0);
  let ground = landingAt(slot.xz);
  if (ground <= weather.openSky + 1.0 || ground > view.eye.y + ${RAIN_TOP}.0) { return hidden(); }
  // Thrown up and out from where the drop hit, and falling back.
  let angle = slot.seed.z * 6.2831853;
  let speed = 0.9 + 0.9 * fract(slot.seed.x * 17.0);
  let time = slot.age * 0.32;
  let along = vec2f(cos(angle), sin(angle)) * speed * 0.5 * time;
  let height = speed * 0.85 * time - 4.9 * time * time;
  if (height < 0.0) { return hidden(); }
  let at = vec3f(slot.xz.x + along.x, ground + 0.01 + height, slot.xz.y + along.y);
  let size = 0.012 + 0.008 * slot.seed.y;
  let right = vec3f(view.viewMatrix[0].x, view.viewMatrix[1].x, view.viewMatrix[2].x);
  let up = vec3f(view.viewMatrix[0].y, view.viewMatrix[1].y, view.viewMatrix[2].y);
  let c = CORNERS[corner];
  var out: DropVarying;
  out.clip = view.viewProjection * vec4f(at + (right * c.x + up * c.y) * size, 1.0);
  out.uv = c;
  out.color = vec4f(vec3f(0.69, 0.8, 0.94) * weather.rainLight, 0.55 * (1.0 - slot.age));
  return out;
}

@vertex fn rippleVertex(@builtin(vertex_index) corner: u32, @builtin(instance_index) index: u32) -> DropVarying {
  let slot = slotOf(index, 23u, 0.45, ${RIPPLE_RANGE}.0);
  let ground = landingAt(slot.xz);
  if (ground <= weather.openSky + 1.0 || ground > view.eye.y + ${RAIN_TOP}.0) { return hidden(); }
  let c = CORNERS[corner];
  let radius = (0.12 + 0.08 * slot.seed.y) * mix(0.3, 1.6, slot.age);
  var out: DropVarying;
  out.clip = view.viewProjection * vec4f(slot.xz.x + c.x * radius, ground + 0.015, slot.xz.y + c.y * radius, 1.0);
  out.uv = c;
  out.color = vec4f(vec3f(0.74, 0.84, 0.94) * weather.rainLight, 0.35 * (1.0 - slot.age));
  return out;
}

// A streak: sharp ends and soft sides.
@fragment fn rainFragment(in: DropVarying) -> @location(0) vec4f {
  let across = 1.0 - abs(in.uv.x);
  let along = 1.0 - in.uv.y * in.uv.y;
  return vec4f(in.color.rgb, in.color.a * across * along);
}

// A soft round flake or droplet.
@fragment fn softFragment(in: DropVarying) -> @location(0) vec4f {
  let fall = saturate(1.0 - dot(in.uv, in.uv));
  return vec4f(in.color.rgb, in.color.a * fall * fall);
}

// A thin ring.
@fragment fn ringFragment(in: DropVarying) -> @location(0) vec4f {
  let radius = length(in.uv);
  let ring = 1.0 - saturate(abs(radius - 0.8) / 0.16);
  return vec4f(in.color.rgb, in.color.a * ring * ring);
}
`;

const _camera = new THREE.Vector3();
const _wind = { x: 0, y: 0, z: 0 };

class PrecipitationPass implements GpuPass {
  readonly id = "effect-precipitation";
  readonly stage = "forward" as const;
  readonly order = PRECIPITATION_ORDER;
  private layout: GPUBindGroupLayout | null = null;
  private uniforms: GPUBuffer | null = null;
  private readonly groups = new BindGroupCache(4);
  readonly data = new Float32Array(UNIFORM_BYTES / 4);
  rain = 0;
  snow = 0;
  splashes = 0;
  ripples = 0;

  constructor(private readonly scene: THREE.Object3D) {}

  execute(frame: GpuFrame): void {
    if (frame.scene !== this.scene || !(this.rain + this.snow > 0)) return;
    const cover = frame.textures.acquire(WEATHER_UNIFORMS.uWeatherCover.value);
    if (!cover) return;
    const { device } = frame;
    const layout = this.layout ?? (this.layout = device.createBindGroupLayout({
      label: "gpu precipitation",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "unfilterable-float" } },
      ],
    }));
    const pipelines = effectPipelinesFor(device);
    const module = pipelines.module("precipitation", () => PRECIPITATION_WGSL);
    const make = (name: string, vertex: string, fragment: string) => pipelines.render(`precipitation ${name}`, () => ({
      layout: device.createPipelineLayout({ label: "gpu precipitation", bindGroupLayouts: [frame.cameraLayout, frame.sceneLayout, layout] }),
      vertex: { module, entryPoint: vertex },
      fragment: {
        module,
        entryPoint: fragment,
        targets: [{
          format: TARGET_FORMATS.hdr,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: TARGET_FORMATS.depth, depthWriteEnabled: false, depthCompare: "greater-equal" },
    }));
    const rain = make("rain", "rainVertex", "rainFragment");
    const snow = make("snow", "snowVertex", "softFragment");
    const splash = make("splash", "splashVertex", "softFragment");
    const ripple = make("ripple", "rippleVertex", "ringFragment");
    if (!rain || !snow || !splash || !ripple) return;

    const uniforms = this.uniforms ?? (this.uniforms = device.createBuffer({ label: "gpu precipitation", size: UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    device.queue.writeBuffer(uniforms, 0, this.data);
    const group = this.groups.get([cover.view, uniforms], () => device.createBindGroup({
      label: "gpu precipitation",
      layout,
      entries: [{ binding: 0, resource: { buffer: uniforms } }, { binding: 1, resource: cover.view }],
    }));

    const pass = beginForwardRenderPass(frame, "gpu precipitation");
    bindForwardView(pass, frame);
    pass.setBindGroup(2, group);
    const draw = (pipeline: GPURenderPipeline, count: number) => {
      if (count <= 0) return;
      pass.setPipeline(pipeline);
      pass.draw(6, count);
    };
    draw(ripple, this.ripples);
    draw(splash, this.splashes);
    draw(rain, this.rain);
    draw(snow, this.snow);
    pass.end();
  }

  dispose(): void {
    this.uniforms?.destroy();
    this.uniforms = null;
  }
}

/** Rain and snow on the GPU renderer: what the sky holds in the place of `Precipitation`. */
export class GpuPrecipitation {
  readonly object = new THREE.Group();
  private readonly pass: PrecipitationPass;
  private rainDriftX = 0;
  private rainDriftZ = 0;
  private snowDriftX = 0;
  private snowDriftZ = 0;
  private rainFall = 0;
  private snowFall = 0;
  private time = 0;

  constructor(private readonly renderer: GpuRendererApi, scene: THREE.Object3D) {
    this.object.name = "Precipitation";
    this.object.userData.noWeather = true;
    this.pass = new PrecipitationPass(scene);
    renderer.addPass(this.pass);
  }

  /** Raindrops and snowflakes alive. */
  get alive(): { rain: number; snow: number; splashes: number } {
    return { rain: this.pass.rain, snow: this.pass.snow, splashes: this.pass.splashes };
  }

  /** One frame: as `Precipitation.update`, with the same meaning of each argument. */
  update(dt: number, camera: THREE.Camera, weather: WeatherState, cover: WeatherCover | null, light: number): void {
    camera.getWorldPosition(_camera);
    windAt(_camera.x, _camera.y, _camera.z, windTime(), _wind, weather);
    this.time += dt;
    this.rainDriftX += _wind.x * dt;
    this.rainDriftZ += _wind.z * dt;
    this.snowDriftX += _wind.x * SNOW_WIND * dt;
    this.snowDriftZ += _wind.z * SNOW_WIND * dt;
    this.rainFall += RAIN_SPEED * dt;
    this.snowFall += SNOW_SPEED * dt;

    const heavy = weather.rain > 0.002 ? weather.rain ** RAIN_POWER : 0;
    const { pass } = this;
    pass.rain = Math.round(RAIN_CAPACITY * heavy);
    pass.snow = Math.round(SNOW_CAPACITY * (weather.snow > 0.002 ? weather.snow : 0));
    pass.splashes = Math.round(SPLASH_CAPACITY * heavy);
    pass.ripples = Math.round(RIPPLE_CAPACITY * heavy);

    const { data } = pass;
    data[0] = this.rainDriftX;
    data[1] = this.rainDriftZ;
    data[2] = this.snowDriftX;
    data[3] = this.snowDriftZ;
    data[4] = this.rainFall;
    data[5] = this.snowFall;
    data[6] = this.time;
    data[7] = RAIN_SPEED;
    data[8] = _wind.x;
    data[9] = _wind.z;
    data[10] = cover?.originX ?? 0;
    data[11] = cover?.originZ ?? 0;
    data[12] = cover?.cellSize ?? 1;
    data[13] = cover ? 1 : 0;
    // Rain and snow catch the sky's light from all round, so they stay faintly visible at night.
    data[14] = 0.22 + 0.78 * light;
    data[15] = Math.min(1, 0.4 + 0.6 * light);
    data[16] = GROUND_PLANE;
    data[17] = OPEN_SKY;
  }

  dispose(): void {
    this.renderer.removePass(this.pass);
    this.pass.dispose();
    this.object.removeFromParent();
  }
}
