/// <reference types="@webgpu/types" />
import { DataUtils } from "three";
import { applyLook, type ColorLook } from "../../../runtime/postEffects";

/**
 * LOOKS AS LOOKUP TEXTURES
 *
 * A colour grading look (runtime/postEffects.ts says what each one does to a display colour) baked into a 3D texture,
 * made once for each look a level asks for. Half floats, because they filter on every device.
 */

export const LOOK_SIZE = 32;
const BYTES_PER_TEXEL = 8;

const bakeLook = (device: GPUDevice, look: ColorLook): GPUTexture => {
  const data = new Uint16Array(LOOK_SIZE ** 3 * 4);
  let at = 0;
  for (let z = 0; z < LOOK_SIZE; z++) {
    for (let y = 0; y < LOOK_SIZE; y++) {
      for (let x = 0; x < LOOK_SIZE; x++) {
        const [r, g, b] = applyLook(look, x / (LOOK_SIZE - 1), y / (LOOK_SIZE - 1), z / (LOOK_SIZE - 1));
        data[at++] = DataUtils.toHalfFloat(r);
        data[at++] = DataUtils.toHalfFloat(g);
        data[at++] = DataUtils.toHalfFloat(b);
        data[at++] = DataUtils.toHalfFloat(1);
      }
    }
  }
  const texture = device.createTexture({
    label: `post look ${look}`,
    dimension: "3d",
    size: [LOOK_SIZE, LOOK_SIZE, LOOK_SIZE],
    format: "rgba16float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    data,
    { bytesPerRow: LOOK_SIZE * BYTES_PER_TEXEL, rowsPerImage: LOOK_SIZE },
    [LOOK_SIZE, LOOK_SIZE, LOOK_SIZE],
  );
  return texture;
};

export class LookTextures {
  private readonly textures = new Map<ColorLook, { texture: GPUTexture; view: GPUTextureView }>();

  constructor(private readonly device: GPUDevice) {}

  viewOf(look: ColorLook): GPUTextureView {
    let entry = this.textures.get(look);
    if (!entry) {
      const texture = bakeLook(this.device, look);
      entry = { texture, view: texture.createView({ dimension: "3d" }) };
      this.textures.set(look, entry);
    }
    return entry.view;
  }

  dispose(): void {
    for (const entry of this.textures.values()) entry.texture.destroy();
    this.textures.clear();
  }
}
