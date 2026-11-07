/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { lightVolumeFor, SH_FLOATS_PER_PROBE, type LightVolume } from "../../../runtime/lighting/bakedLighting";
import { LIGHT_VOLUME_PARAM_BYTES, lightVolumeWgsl } from "./lightVolumeWgsl";

/**
 * A BAKED LIGHT VOLUME ON THE GRAPHICS CARD
 *
 * The volume the scene draws with, as level code has set it (setSceneLightVolume, in bakedLighting.ts), kept as a 3D
 * texture and a uniform. Whichever way the volume was baked, the probes on the graphics card are the same.
 *
 * Writes products "lightVolume" = `LightVolumeProduct` while the scene has a volume; lightVolumeWgsl.ts says how to read
 * it. The lighting pass reads it by way of products "gi" (giScreen.ts), which already holds the baked light.
 */

/** Sampling sits this far along the surface normal, in probe spacings, so a surface reads the probes in front of it. */
const NORMAL_OFFSET = 0.35;
/** Beyond the outer probes the baked light fades out over this many spacings. */
const EDGE_FADE = 0.5;

export interface LightVolumeProduct {
  /** rgba16float 3D: three stacked copies of the grid, four rgb coefficients per probe. */
  view: GPUTextureView;
  /** LightVolumeParams, LIGHT_VOLUME_PARAM_BYTES long. */
  uniform: GPUBuffer;
  /** Binding this view at `binding` and the uniform at `binding` + 1. */
  wgsl: typeof lightVolumeWgsl;
}

const toHalf = THREE.DataUtils.toHalfFloat;

export class LightVolumeResources {
  readonly uniform: GPUBuffer;
  /** Always something to bind, whether or not there is a volume. */
  view: GPUTextureView;
  private texture: GPUTexture;
  private uploaded: Float32Array | null = null;
  private readonly params = new Float32Array(LIGHT_VOLUME_PARAM_BYTES / 4);
  private readonly product: LightVolumeProduct;

  constructor(private readonly device: GPUDevice) {
    this.uniform = device.createBuffer({ label: "gi light volume", size: LIGHT_VOLUME_PARAM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.texture = this.makeTexture(1, 1, 3);
    this.view = this.texture.createView();
    this.product = { view: this.view, uniform: this.uniform, wgsl: lightVolumeWgsl };
    device.queue.writeBuffer(this.uniform, 0, this.params);
  }

  private makeTexture(width: number, height: number, depth: number): GPUTexture {
    return this.device.createTexture({
      label: "gi light volume",
      size: [width, height, depth],
      dimension: "3d",
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
  }

  private upload(volume: LightVolume): void {
    const [nx, ny, nz] = volume.counts;
    const probes = nx * ny * nz;
    const packed = new Uint16Array(probes * 4 * 3);
    for (let probe = 0; probe < probes; probe++) {
      const from = probe * SH_FLOATS_PER_PROBE;
      for (let k = 0; k < SH_FLOATS_PER_PROBE; k++) packed[((k >> 2) * probes + probe) * 4 + (k & 3)] = toHalf(volume.sh[from + k]);
    }
    this.texture.destroy();
    this.texture = this.makeTexture(nx, ny, nz * 3);
    this.view = this.texture.createView();
    this.product.view = this.view;
    this.device.queue.writeTexture({ texture: this.texture }, packed, { bytesPerRow: nx * 8, rowsPerImage: ny }, [nx, ny, nz * 3]);
    this.uploaded = volume.sh;
  }

  /** Brings the texture and uniform up with what `scene` draws with; returns the product, or null with no volume. */
  sync(scene: THREE.Object3D): LightVolumeProduct | null {
    const volume = lightVolumeFor(scene);
    const { params } = this;
    if (!volume) {
      if (params[9] !== 0) {
        params[9] = 0;
        this.device.queue.writeBuffer(this.uniform, 0, params);
      }
      return null;
    }
    if (this.uploaded !== volume.sh) this.upload(volume);
    params[0] = volume.origin.x;
    params[1] = volume.origin.y;
    params[2] = volume.origin.z;
    params[4] = (volume.counts[0] - 1) * volume.spacing;
    params[5] = (volume.counts[1] - 1) * volume.spacing;
    params[6] = (volume.counts[2] - 1) * volume.spacing;
    params[8] = volume.intensity;
    params[9] = 1;
    params[10] = NORMAL_OFFSET * volume.spacing;
    params[11] = EDGE_FADE * volume.spacing;
    this.device.queue.writeBuffer(this.uniform, 0, params);
    return this.product;
  }

  destroy(): void {
    this.uniform.destroy();
    this.texture.destroy();
  }
}
