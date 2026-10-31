/// <reference types="@webgpu/types" />
import type * as THREE from "three";
import { MAX_PROBES, SH_FLOATS_PER_PROBE, lightVolumeFor } from "../../../runtime/lighting/bakedLighting";
import { COVER_CELLS } from "../../../runtime/weatherCover";
import { WEATHER_UNIFORMS } from "../../../runtime/weatherSurfaces";
import { windUniforms } from "../../../runtime/wind";
import type { GpuFrame, GpuPass } from "../frame";
import type { TexturePool } from "../texturePool";

/**
 * WHAT EVERY SURFACE READS ALIKE
 *
 * The weather, the wind and the level's baked light are one set of numbers for the whole frame, so a change in them
 * costs one write and nothing per material. They sit behind three bindings at the end of each kind's bind group: the
 * frame's numbers, the baked probes, and the grid of what covers each place from the sky. All three keep their GPU
 * object for good, so what they hold can change every frame without any material's bind group being made again.
 */

const FLOATS = 24;
const VISIBLE_TO_BOTH = 3;
const VISIBLE_TO_PIXELS = 2;
/** Baked light is read this far along the surface normal, and fades out this far past the outer probes, in spacings. */
const BAKED_NORMAL_OFFSET = 0.35;
const BAKED_EDGE_FADE = 0.5;

/** Bindings a kind gives the world, from `first` on. */
export const worldLayoutEntries = (first: number): GPUBindGroupLayoutEntry[] => [
  { binding: first, visibility: VISIBLE_TO_BOTH, buffer: { type: "uniform" } },
  { binding: first + 1, visibility: VISIBLE_TO_PIXELS, buffer: { type: "read-only-storage" } },
  { binding: first + 2, visibility: VISIBLE_TO_PIXELS, texture: { sampleType: "unfilterable-float" } },
];

/** How a kind declares those bindings. */
export const worldWgsl = (first: number): string => /* wgsl */ `
struct SurfaceWorld {
  // Wetness, snow, 1 when the cover grid is in use, the size of its cells.
  weather: vec4f,
  // The world x and z of the grid's corner; in z, how far past the outer probes the baked light fades out.
  coverOrigin: vec4f,
  // Seconds of wind, its direction on the ground, its speed with the gusts.
  wind: vec4f,
  // The first probe; its intensity in w.
  probeOrigin: vec4f,
  // From the first probe to the last; 1 in w when the scene has a baked volume.
  probeExtent: vec4f,
  // Probes along each axis; how far along the normal to read them in w.
  probeCounts: vec4f,
}
@group(2) @binding(${first}) var<uniform> surfaceWorld: SurfaceWorld;
@group(2) @binding(${first + 1}) var<storage, read> surfaceProbes: array<vec4f>;
@group(2) @binding(${first + 2}) var surfaceCover: texture_2d<f32>;
`;

/** A picture-stable noise from 0 to 1 per pixel, changing each frame: the temporal resolve smooths it into a blend. */
export const STIPPLE_WGSL = /* wgsl */ `
fn surfaceStipple(in: SurfaceIn) -> f32 {
  let clip = view.unjitteredViewProjection * vec4f(in.worldPosition, 1.0);
  let pixel = floor((clip.xy / clip.w * vec2f(0.5, -0.5) + vec2f(0.5)) * view.size.xy);
  let tick = floor(fract(in.time) * 60.0);
  return fract(52.9829189 * fract(dot(pixel + vec2f(tick * 5.588238), vec2f(0.06711056, 0.00583715))));
}
`;

/** From world to instance space: a point, and a direction such as an offset. */
export const INSTANCE_INVERSE_WGSL = /* wgsl */ `
fn instanceLocalDirection(instance: Instance, d: vec3f) -> vec3f {
  let a = instance.world0.xyz;
  let b = instance.world1.xyz;
  let c = instance.world2.xyz;
  let adjugate = mat3x3f(cross(b, c), cross(c, a), cross(a, b));
  return adjugate * d / dot(a, cross(b, c));
}
fn instanceLocalPoint(instance: Instance, p: vec3f) -> vec3f {
  return instanceLocalDirection(instance, p - vec3f(instance.world0.w, instance.world1.w, instance.world2.w));
}
`;

class SurfaceWorldResources {
  private readonly numbers: GPUBuffer;
  private readonly probes: GPUBuffer;
  private readonly cover: GPUTexture;
  private readonly coverView: GPUTextureView;
  private readonly data = new Float32Array(FLOATS);
  private readonly sent = new Float32Array(FLOATS).fill(Number.NaN);
  private sentProbes: Float32Array | null = null;
  private sentCover = -1;

  constructor(readonly device: GPUDevice) {
    this.numbers = device.createBuffer({ label: "gpu surface world", size: FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.probes = device.createBuffer({ label: "gpu baked probes", size: MAX_PROBES * SH_FLOATS_PER_PROBE * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.cover = device.createTexture({
      label: "gpu weather cover",
      size: [COVER_CELLS, COVER_CELLS],
      format: "r32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.coverView = this.cover.createView();
  }

  bindEntries(first: number): GPUBindGroupEntry[] {
    return [
      { binding: first, resource: { buffer: this.numbers } },
      { binding: first + 1, resource: { buffer: this.probes } },
      { binding: first + 2, resource: this.coverView },
    ];
  }

  update(scene: THREE.Object3D): void {
    const { data, device } = this;
    const weather = WEATHER_UNIFORMS;
    data[0] = weather.uWeatherWetness.value;
    data[1] = weather.uWeatherSnow.value;
    data[2] = weather.uWeatherCoverOn.value;
    data[3] = weather.uWeatherCoverCell.value;
    data[4] = weather.uWeatherCoverOrigin.value.x;
    data[5] = weather.uWeatherCoverOrigin.value.y;
    data[8] = windUniforms.uWindTime.value;
    data[9] = windUniforms.uWindDirection.value[0];
    data[10] = windUniforms.uWindDirection.value[1];
    data[11] = windUniforms.uWindStrength.value;

    const volume = lightVolumeFor(scene);
    if (volume) {
      if (this.sentProbes !== volume.sh) {
        device.queue.writeBuffer(this.probes, 0, volume.sh);
        this.sentProbes = volume.sh;
      }
      const [nx, ny, nz] = volume.counts;
      data[12] = volume.origin.x;
      data[13] = volume.origin.y;
      data[14] = volume.origin.z;
      data[15] = volume.intensity;
      data[16] = (nx - 1) * volume.spacing;
      data[17] = (ny - 1) * volume.spacing;
      data[18] = (nz - 1) * volume.spacing;
      data[19] = 1;
      data[20] = nx;
      data[21] = ny;
      data[22] = nz;
      data[23] = BAKED_NORMAL_OFFSET * volume.spacing;
      data[6] = BAKED_EDGE_FADE * volume.spacing;
    } else {
      data[19] = 0;
    }

    let changed = false;
    for (let index = 0; index < FLOATS; index++) {
      if (data[index] !== this.sent[index]) {
        changed = true;
        this.sent[index] = data[index];
      }
    }
    if (changed) device.queue.writeBuffer(this.numbers, 0, data);

    const cover = weather.uWeatherCover.value;
    if (cover.version !== this.sentCover) {
      this.sentCover = cover.version;
      const cells = (cover.image as { data: Float32Array }).data;
      device.queue.writeTexture({ texture: this.cover }, cells as unknown as GPUAllowSharedBufferSource, { bytesPerRow: COVER_CELLS * 4, rowsPerImage: COVER_CELLS }, [COVER_CELLS, COVER_CELLS]);
    }
  }
}

const worlds = new WeakMap<TexturePool, SurfaceWorldResources>();

/** Makes the world's GPU objects for a device's pools, once. */
export const ensureSurfaceWorld = (device: GPUDevice, pool: TexturePool): void => {
  if (!worlds.has(pool)) worlds.set(pool, new SurfaceWorldResources(device));
};

const worldOf = (pool: TexturePool): SurfaceWorldResources => {
  const world = worlds.get(pool);
  if (!world) throw new Error("Surface kinds are in use on a device they were not installed for (installSurfaces).");
  return world;
};

export const worldBindEntries = (pool: TexturePool, first: number): GPUBindGroupEntry[] => worldOf(pool).bindEntries(first);

/** The device behind a pool, for a kind with GPU objects of its own. */
export const deviceOf = (pool: TexturePool): GPUDevice => worldOf(pool).device;

let scene: THREE.Scene | null = null;

/** The scene last drawn, for a kind that has to find the object its material is on. */
export const surfaceScene = (): THREE.Scene | null => scene;

/** Brings the world up to date before anything draws. */
export const createSurfaceWorldPass = (): GpuPass => ({
  id: "surface-world",
  stage: "prepare",
  order: -1000,
  execute(frame: GpuFrame) {
    scene = frame.scene;
    worldOf(frame.textures).update(frame.scene);
  },
});
