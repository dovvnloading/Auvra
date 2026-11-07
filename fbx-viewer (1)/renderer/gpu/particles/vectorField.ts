/// <reference types="@webgpu/types" />
import * as THREE from "three";

/**
 * VECTOR FIELDS
 *
 * A box of the world filled with directions, as a 3D texture particles read as they fly: wind round a building, a vortex,
 * the flow out of a fluid solve. The grid is filtered between cells, so a coarse one still reads smooth.
 */

export interface VectorFieldData {
  /** Cells along x, y and z. */
  size: readonly [number, number, number];
  /** The box it fills in the world. */
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  /** Three numbers per cell, x fastest, then y, then z. */
  values: ArrayLike<number>;
}

export class GpuVectorField {
  readonly view: GPUTextureView;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  private readonly texture: GPUTexture;

  constructor(device: GPUDevice, data: VectorFieldData) {
    const [width, height, depth] = data.size;
    const cells = width * height * depth;
    const texels = new Uint16Array(cells * 4);
    for (let cell = 0; cell < cells; cell++) {
      texels[cell * 4] = THREE.DataUtils.toHalfFloat(data.values[cell * 3] ?? 0);
      texels[cell * 4 + 1] = THREE.DataUtils.toHalfFloat(data.values[cell * 3 + 1] ?? 0);
      texels[cell * 4 + 2] = THREE.DataUtils.toHalfFloat(data.values[cell * 3 + 2] ?? 0);
    }
    this.texture = device.createTexture({
      label: "gpu particle vector field",
      size: [width, height, depth],
      dimension: "3d",
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: this.texture }, texels, { bytesPerRow: width * 8, rowsPerImage: height }, [width, height, depth]);
    this.view = this.texture.createView({ dimension: "3d" });
    this.min = data.min;
    this.max = data.max;
  }

  /** A field made by asking a function for the direction at the middle of every cell. */
  static fromFunction(
    device: GPUDevice,
    size: readonly [number, number, number],
    min: readonly [number, number, number],
    max: readonly [number, number, number],
    direction: (x: number, y: number, z: number, out: THREE.Vector3) => void,
  ): GpuVectorField {
    const [width, height, depth] = size;
    const values = new Float32Array(width * height * depth * 3);
    const out = new THREE.Vector3();
    let at = 0;
    for (let k = 0; k < depth; k++) {
      for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++) {
          out.set(0, 0, 0);
          direction(
            min[0] + ((i + 0.5) / width) * (max[0] - min[0]),
            min[1] + ((j + 0.5) / height) * (max[1] - min[1]),
            min[2] + ((k + 0.5) / depth) * (max[2] - min[2]),
            out,
          );
          values[at++] = out.x;
          values[at++] = out.y;
          values[at++] = out.z;
        }
      }
    }
    return new GpuVectorField(device, { size, min, max, values });
  }

  dispose(): void {
    this.texture.destroy();
  }
}

/**
 * The heights of what is overhead round a point, as the weather cover keeps them, up on the graphics card where falling
 * particles stop at them. A cell with nothing in it holds `open`.
 */
export class GpuHeightGrid {
  readonly view: GPUTextureView;
  readonly cells: number;
  private readonly texture: GPUTexture;
  private readonly scratch: Float32Array;
  private version = -1;

  constructor(private readonly device: GPUDevice, cells: number, private readonly open: number) {
    this.cells = cells;
    this.scratch = new Float32Array(cells * cells);
    this.texture = device.createTexture({
      label: "gpu particle height grid",
      size: [cells, cells],
      format: "r32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.view = this.texture.createView();
  }

  /** Sends the heights if `version` moved. Rows run along +Z, and x within each row. */
  update(heights: Float32Array, version: number): void {
    if (version === this.version) return;
    this.version = version;
    for (let cell = 0; cell < this.scratch.length; cell++) {
      const height = heights[cell];
      this.scratch[cell] = Number.isNaN(height) ? this.open : height;
    }
    this.device.queue.writeTexture({ texture: this.texture }, this.scratch, { bytesPerRow: this.cells * 4, rowsPerImage: this.cells }, [this.cells, this.cells]);
  }

  dispose(): void {
    this.texture.destroy();
  }
}
