/// <reference types="@webgpu/types" />
import * as THREE from "three";
import type { SkyFrame } from "../../../components/Environment/sky/SkyRenderer";
import { GROUND_RADIUS, TOP_RADIUS } from "../../../runtime/sky/atmosphere";
import type { Rgb } from "./skySettings";

/**
 * THE DOME
 *
 * What a direction of the sky looks like, read from the atmosphere's tables and the clouds' map: the air or a panorama,
 * the stars, moon and sun on it, then the clouds in front of everything. The sky pass asks it for the screen's pixels,
 * and the capture for what the Sky Light sees: the same air and clouds, without the sun's disc (the sun's own light
 * already lights the scene directly) or the stars' detail.
 */

export const DOME_BYTES = 256;

const COMPUTE = 4; // GPUShaderStage.COMPUTE, without touching the browser's globals as the module loads.

const NOISE_WGSL = /* wgsl */ `
fn skyHash(input: vec3f) -> f32 {
  var p = fract(input * 0.3183099 + vec3f(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

fn skyNoise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(skyHash(i), skyHash(i + vec3f(1.0, 0.0, 0.0)), u.x), mix(skyHash(i + vec3f(0.0, 1.0, 0.0)), skyHash(i + vec3f(1.0, 1.0, 0.0)), u.x), u.y),
    mix(mix(skyHash(i + vec3f(0.0, 0.0, 1.0)), skyHash(i + vec3f(1.0, 0.0, 1.0)), u.x), mix(skyHash(i + vec3f(0.0, 1.0, 1.0)), skyHash(i + vec3f(1.0, 1.0, 1.0)), u.x), u.y),
    u.z);
}

fn skyFbm(input: vec3f, octaves: i32) -> f32 {
  var p = input;
  var sum = 0.0;
  var amplitude = 0.5;
  var total = 0.0;
  for (var i = 0; i < octaves; i++) {
    sum += skyNoise(p) * amplitude;
    total += amplitude;
    p = p * 2.03 + vec3f(3.1, 1.7, 2.3);
    amplitude *= 0.5;
  }
  return sum / total;
}
`;

/** The dome's data and bindings, in bind group `group`, and what it does. */
export const domeWgsl = (group: number): string => /* wgsl */ `
const DOME_PI = 3.14159265358979;

struct Dome {
  planet: vec2f,
  viewRadius: f32,
  skyGrey: f32,
  skyScale: vec3f,
  cloudsOn: f32,
  cloudScale: vec3f,
  cloudTexel: f32,
  flatCloud: vec3f,
  flatCover: f32,
  lowerColor: vec3f,
  lowerSolid: f32,
  panoramaScale: vec3f,
  panoramaTurn: f32,
  sun: vec3f,
  panoramaOn: f32,
  sunRadiance: vec3f,
  flash: f32,
  moon: vec3f,
  moonSine: f32,
  moonRight: vec3f,
  moonPhase: f32,
  moonUp: vec3f,
  stars: f32,
  moonRadiance: vec3f,
  milkyWay: f32,
  // Cosines: inner and outer edge of the disc.
  sunEdge: vec2f,
  time: f32,
  starTurn: mat3x3f,
}

@group(${group}) @binding(0) var<uniform> dome: Dome;
@group(${group}) @binding(1) var skyViewTable: texture_2d<f32>;
@group(${group}) @binding(2) var transmittanceTable: texture_2d<f32>;
@group(${group}) @binding(3) var cloudTable: texture_2d<f32>;
@group(${group}) @binding(4) var panoramaImage: texture_2d<f32>;
@group(${group}) @binding(5) var skyViewSampler: sampler;
@group(${group}) @binding(6) var clampSampler: sampler;
@group(${group}) @binding(7) var panoramaSampler: sampler;

${NOISE_WGSL}

fn starLayer(direction: vec3f, cells: f32, threshold: f32, size: f32, brightness: f32) -> vec3f {
  let id = floor(direction * cells);
  let pick = skyHash(id + vec3f(19.3));
  if (pick > threshold) { return vec3f(0.0); }
  let offset = vec3f(skyHash(id + vec3f(1.7)), skyHash(id + vec3f(5.3)), skyHash(id + vec3f(9.1))) - vec3f(0.5);
  let centre = normalize(id + vec3f(0.5) + offset * 0.7);
  let away = length(direction - centre) * cells;
  let rank = pick / threshold;
  let disc = exp(-away * away / (size * size));
  // A star's colour by its temperature: most white, some red and some blue.
  let warmth = skyHash(id + vec3f(13.9));
  let colour = mix(vec3f(1.0, 0.72, 0.5), mix(vec3f(1.0, 0.97, 0.92), vec3f(0.68, 0.8, 1.0), smoothstep(0.45, 1.0, warmth)), smoothstep(0.0, 0.3, warmth));
  // Most are faint and a few are bright.
  let strength = brightness * (0.12 + 1.6 * pow(1.0 - rank, 6.0));
  // Twinkling, stronger low down where the light crosses more air.
  let twinkle = 1.0 - 0.45 * (1.0 - clamp(direction.y * 2.0, 0.0, 1.0)) * (0.5 + 0.5 * sin(dome.time * (1.5 + 5.0 * warmth) + 40.0 * pick));
  return colour * disc * strength * twinkle;
}

fn milkyWay(direction: vec3f) -> vec3f {
  // A band round a tilted great circle, brightest toward its core, split by lanes of dust.
  let pole = vec3f(0.46, 0.75, -0.47);
  let core = vec3f(0.82, -0.17, 0.54);
  let across = dot(direction, pole);
  let towardCore = dot(direction, core) * 0.5 + 0.5;
  let width = mix(0.09, 0.2, towardCore * towardCore);
  let band = exp(-across * across / (width * width));
  if (band < 0.003) { return vec3f(0.0); }
  let clouds = skyFbm(direction * 7.0, 5);
  let lanes = smoothstep(0.35, 0.72, skyFbm(direction * 14.0 + vec3f(4.0), 4));
  let dust = 1.0 - 0.75 * lanes * exp(-across * across / (width * width * 0.28));
  let colour = mix(vec3f(0.55, 0.68, 1.0), vec3f(1.0, 0.85, 0.66), towardCore * towardCore);
  return colour * band * dust * (0.35 + clouds * clouds * 1.8) * (0.35 + 0.95 * towardCore);
}

// The moon's disc: seas and craters on a sphere, lit from the side its phase says.
fn moonDisc(direction: vec3f) -> vec4f {
  let along = dot(direction, dome.moon);
  if (along <= 0.0) { return vec4f(0.0); }
  let p = vec2f(dot(direction, dome.moonRight), dot(direction, dome.moonUp)) / dome.moonSine;
  let rr = dot(p, p);
  if (rr >= 1.0) { return vec4f(0.0); }
  let n = vec3f(p, sqrt(1.0 - rr));
  let angle = (dome.moonPhase - 0.5) * 2.0 * DOME_PI;
  let toSun = vec3f(sin(angle), 0.0, cos(angle));
  // The surface: dark seas, and bright rims round small craters.
  let s = n * 3.1 + vec3f(7.0);
  let seas = smoothstep(0.42, 0.62, skyFbm(s, 5));
  let rough = skyFbm(n * 14.0 + vec3f(3.0), 4);
  let albedo = mix(0.95, 0.42, seas) * (0.74 + 0.5 * rough);
  let lit = pow(max(dot(n, toSun), 0.0), 0.6);
  // The dark side keeps a trace of light from the Earth.
  let surface = albedo * (lit * vec3f(1.0, 0.98, 0.94) + vec3f(0.012, 0.016, 0.024));
  let edge = 1.0 - smoothstep(0.96, 1.0, rr);
  return vec4f(surface * edge, edge);
}

// Where a direction falls in the sky-view table.
fn skyViewUv(direction: vec3f) -> vec2f {
  let latitude = asin(clamp(direction.y, -1.0, 1.0));
  let v = 0.5 + 0.5 * sign(latitude) * sqrt(abs(latitude) / (DOME_PI * 0.5));
  let u = atan2(direction.z, direction.x) / (2.0 * DOME_PI) + 0.5;
  return vec2f(u, v);
}

fn transmittanceUvFor(r: f32, mu: f32) -> vec2f {
  let top = dome.planet.y;
  let ground = dome.planet.x;
  let h = sqrt(top * top - ground * ground);
  let rho = sqrt(max(0.0, r * r - ground * ground));
  let discriminant = r * r * (mu * mu - 1.0) + top * top;
  let d = max(0.0, -r * mu + sqrt(max(0.0, discriminant)));
  let dMin = top - r;
  let dMax = rho + h;
  return vec2f((d - dMin) / max(dMax - dMin, 1e-5), rho / h);
}

// The sky behind everything: an image, or the air.
fn domeBehind(direction: vec3f) -> vec3f {
  if (dome.panoramaOn > 0.5) {
    // An image for a sky: wrapped round the dome.
    let longitude = atan2(direction.z, direction.x) + dome.panoramaTurn;
    let uv = vec2f(fract(longitude / (2.0 * DOME_PI) + 0.5), asin(clamp(direction.y, -1.0, 1.0)) / DOME_PI + 0.5);
    return textureSampleLevel(panoramaImage, panoramaSampler, uv, 0.0).rgb * dome.panoramaScale;
  }
  var colour = textureSampleLevel(skyViewTable, skyViewSampler, skyViewUv(direction), 0.0).rgb * dome.skyScale;
  // Under heavy cloud the air between is lit by the grey above it.
  if (dome.skyGrey > 0.0) { colour = mix(colour, vec3f(dot(colour, vec3f(0.2126, 0.7152, 0.0722))), dome.skyGrey); }
  return colour;
}

// Stars, moon and sun on it, each through the air.
fn domeBodies(behind: vec3f, direction: vec3f) -> vec3f {
  var colour = behind;
  if (dome.panoramaOn > 0.5) { return colour; }
  let mu = direction.y;
  let through = textureSampleLevel(transmittanceTable, clampSampler, transmittanceUvFor(dome.viewRadius, mu), 0.0).rgb * smoothstep(-0.004, 0.01, mu);
  if (dome.stars > 0.003) {
    let turned = dome.starTurn * direction;
    var night = starLayer(turned, 240.0, 0.05, 0.11, 0.8) + starLayer(turned, 95.0, 0.05, 0.07, 1.6);
    if (dome.milkyWay > 0.003) { night += milkyWay(turned) * dome.milkyWay * 0.11; }
    colour += night * dome.stars * through;
  }
  let moon = moonDisc(direction);
  if (moon.a > 0.0) {
    // By day it fades out with its light; below the horizon the ground hides it.
    let seen = moon.a * clamp(dot(dome.moonRadiance, vec3f(3.0)), 0.0, 1.0) * smoothstep(-0.004, 0.006, direction.y);
    colour = mix(colour, colour * 0.25 + moon.rgb * dome.moonRadiance * through, seen);
  }
  // The sun's disc, darker at its rim, with its colour after the air.
  let along = dot(direction, dome.sun);
  if (along > dome.sunEdge.x) {
    let disc = smoothstep(dome.sunEdge.x, dome.sunEdge.y, along);
    let rim = sqrt(max(0.0, 1.0 - (1.0 - along * along) / max(1.0 - dome.sunEdge.y * dome.sunEdge.y, 1e-9)));
    colour += dome.sunRadiance * through * disc * pow(vec3f(rim), vec3f(0.397, 0.503, 0.652));
  }
  return colour;
}

// Clouds in front of everything, from their own map of the sky; then the weather's grey, and what the capture puts below.
fn domeFront(behind: vec3f, direction: vec3f) -> vec3f {
  var colour = behind;
  if (dome.cloudsOn > 0.5 && direction.y > 0.0) {
    let uv = direction.xz / (1.0 + direction.y) * 0.5 + 0.5;
    // A small tent over the map, to smooth what is left of the ray march's noise.
    let t = dome.cloudTexel;
    let cloud = (textureSampleLevel(cloudTable, clampSampler, uv, 0.0) * 2.0
      + textureSampleLevel(cloudTable, clampSampler, uv + vec2f(t, t), 0.0)
      + textureSampleLevel(cloudTable, clampSampler, uv + vec2f(-t, t), 0.0)
      + textureSampleLevel(cloudTable, clampSampler, uv + vec2f(t, -t), 0.0)
      + textureSampleLevel(cloudTable, clampSampler, uv + vec2f(-t, -t), 0.0)) / 6.0;
    // They sink into the haze before the horizon, never ending at a line.
    let horizon = smoothstep(0.0, 0.03, direction.y);
    colour = colour * mix(1.0, cloud.a, horizon) + cloud.rgb * dome.cloudScale * horizon;
    colour += dome.flash * (1.0 - cloud.a) * vec3f(0.75, 0.82, 1.0) * horizon * (0.5 + 0.8 * (1.0 - cloud.a));
  }
  if (dome.flatCover > 0.0) { colour = mix(colour, dome.flatCloud, dome.flatCover * smoothstep(-0.05, 0.1, direction.y)); }
  if (dome.lowerSolid > 0.5 && direction.y < 0.0) { colour = dome.lowerColor; }
  return colour;
}

// As the screen shows it.
fn domeColour(direction: vec3f) -> vec3f {
  return domeFront(domeBodies(domeBehind(direction), direction), direction);
}

// As the Sky Light sees it.
fn domeCaptureColour(direction: vec3f) -> vec3f {
  return domeFront(domeBehind(direction), direction);
}
`;

export const domeBindGroupLayout = (device: GPUDevice): GPUBindGroupLayout => device.createBindGroupLayout({
  label: "sky dome",
  entries: [
    { binding: 0, visibility: COMPUTE, buffer: { type: "uniform" } },
    { binding: 1, visibility: COMPUTE, texture: { sampleType: "float" } },
    { binding: 2, visibility: COMPUTE, texture: { sampleType: "float" } },
    { binding: 3, visibility: COMPUTE, texture: { sampleType: "float" } },
    { binding: 4, visibility: COMPUTE, texture: { sampleType: "float" } },
    { binding: 5, visibility: COMPUTE, sampler: { type: "filtering" } },
    { binding: 6, visibility: COMPUTE, sampler: { type: "filtering" } },
    { binding: 7, visibility: COMPUTE, sampler: { type: "filtering" } },
  ],
});

/** What changes between the screen's dome and the capture's. */
export interface DomeOptions {
  viewRadius: number;
  cloudsOn: boolean;
  cloudTexel: number;
  panoramaOn: boolean;
  /** The tint on all the light that makes up a capture. */
  tint?: Rgb;
  /** Without the sky's own weather, for an image captured alone. */
  noFlatCover?: boolean;
  lowerSolid?: boolean;
  lower?: Rgb;
}

const _axis = new THREE.Vector3(0.2, 0.92, 0.33).normalize();
const _turn = new THREE.Matrix4();
const _turn3 = new THREE.Matrix3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_FORWARD = new THREE.Vector3(0, 0, 1);
const WHITE: Rgb = [1, 1, 1];
const BLACK: Rgb = [0, 0, 0];

/** Fills `data` (DOME_BYTES of it) from the sky's frame. */
export const writeDome = (data: Float32Array, frame: SkyFrame, options: DomeOptions): void => {
  const tint = options.tint ?? WHITE;
  const lower = options.lower ?? BLACK;
  data[0] = GROUND_RADIUS;
  data[1] = TOP_RADIUS;
  data[2] = options.viewRadius;
  data[3] = frame.skyGrey;
  data[4] = frame.skyScale[0] * tint[0];
  data[5] = frame.skyScale[1] * tint[1];
  data[6] = frame.skyScale[2] * tint[2];
  data[7] = options.cloudsOn ? 1 : 0;
  data[8] = frame.cloudScale[0] * tint[0];
  data[9] = frame.cloudScale[1] * tint[1];
  data[10] = frame.cloudScale[2] * tint[2];
  data[11] = options.cloudTexel;
  data[12] = frame.flatCloud[0] * tint[0];
  data[13] = frame.flatCloud[1] * tint[1];
  data[14] = frame.flatCloud[2] * tint[2];
  data[15] = options.noFlatCover ? 0 : frame.flatCover;
  data[16] = lower[0];
  data[17] = lower[1];
  data[18] = lower[2];
  data[19] = options.lowerSolid ? 1 : 0;
  data[20] = frame.panoramaScale[0] * tint[0];
  data[21] = frame.panoramaScale[1] * tint[1];
  data[22] = frame.panoramaScale[2] * tint[2];
  data[23] = frame.panoramaTurn;
  data[24] = frame.sun.x;
  data[25] = frame.sun.y;
  data[26] = frame.sun.z;
  data[27] = options.panoramaOn ? 1 : 0;
  data.set(frame.sunRadiance, 28);
  data[31] = frame.flash;
  data[32] = frame.moon.x;
  data[33] = frame.moon.y;
  data[34] = frame.moon.z;
  data[35] = Math.sin(frame.moonRadius);
  _right.crossVectors(Math.abs(frame.moon.y) > 0.99 ? WORLD_FORWARD : WORLD_UP, frame.moon).normalize();
  _up.crossVectors(frame.moon, _right);
  data[36] = _right.x;
  data[37] = _right.y;
  data[38] = _right.z;
  data[39] = frame.moonPhase;
  data[40] = _up.x;
  data[41] = _up.y;
  data[42] = _up.z;
  data[43] = frame.stars;
  data.set(frame.moonRadiance, 44);
  data[47] = frame.milkyWay;
  data[48] = Math.cos(frame.sunRadius * 1.05);
  data[49] = Math.cos(frame.sunRadius * 0.93);
  data[50] = frame.time;
  // A mat3x3f in a uniform: three columns of four numbers.
  const turn = _turn3.setFromMatrix4(_turn.makeRotationAxis(_axis, frame.starAngle)).elements;
  data[52] = turn[0];
  data[53] = turn[1];
  data[54] = turn[2];
  data[56] = turn[3];
  data[57] = turn[4];
  data[58] = turn[5];
  data[60] = turn[6];
  data[61] = turn[7];
  data[62] = turn[8];
};

const ids = new WeakMap<object, number>();
let nextId = 1;
const idOf = (object: object): number => {
  let id = ids.get(object);
  if (!id) {
    id = nextId++;
    ids.set(object, id);
  }
  return id;
};

/** Makes the dome's bind groups, keeping those still in use: the clouds' map changes hands every frame. */
export class DomeBindings {
  private readonly groups = new Map<string, GPUBindGroup>();

  constructor(private readonly device: GPUDevice, private readonly layout: GPUBindGroupLayout, private readonly buffer: GPUBuffer) {}

  groupFor(skyView: GPUTextureView, transmittance: GPUTextureView, clouds: GPUTextureView, panorama: GPUTextureView, skyViewSampler: GPUSampler, clampSampler: GPUSampler, panoramaSampler: GPUSampler): GPUBindGroup {
    const key = `${idOf(skyView)}/${idOf(clouds)}/${idOf(panorama)}/${idOf(panoramaSampler)}`;
    let group = this.groups.get(key);
    if (group) return group;
    // Only a couple are ever current; what has dropped out holds views of textures that may have gone.
    if (this.groups.size >= 6) this.groups.clear();
    group = this.device.createBindGroup({
      label: "sky dome",
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.buffer } },
        { binding: 1, resource: skyView },
        { binding: 2, resource: transmittance },
        { binding: 3, resource: clouds },
        { binding: 4, resource: panorama },
        { binding: 5, resource: skyViewSampler },
        { binding: 6, resource: clampSampler },
        { binding: 7, resource: panoramaSampler },
      ],
    });
    this.groups.set(key, group);
    return group;
  }

  clear(): void {
    this.groups.clear();
  }
}
