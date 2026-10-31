/// <reference types="@webgpu/types" />
import * as THREE from "three";
import type { TexturePool } from "./texturePool";

/**
 * REFLECTION PROBES
 *
 * A level's probes share one array of cube maps, each holding what its probe saw in all directions, blurred further down
 * each mip for rougher surfaces. Lighting finds the nearest probe around a pixel and reflects that instead of the sky.
 *
 * The cube faces are drawn by ordinary cameras, whose picture is a mirror image of how a cube map is laid out. So the
 * world is mirrored in z instead: lighting flips z when it looks into a probe, and the face cameras here look along the
 * same flipped directions.
 */

export const MAX_PROBES = 8;
export const PROBE_SIZE = 256;
export const PROBE_FORMAT: GPUTextureFormat = "rgba16float";
const PROBE_MIPS = 7;

/** Each face in the order cube maps keep them: where its camera looks, and which way is up. */
const FACES: readonly { look: [number, number, number]; up: [number, number, number] }[] = [
  { look: [1, 0, 0], up: [0, 1, 0] },
  { look: [-1, 0, 0], up: [0, 1, 0] },
  { look: [0, 1, 0], up: [0, 0, 1] },
  { look: [0, -1, 0], up: [0, 0, -1] },
  { look: [0, 0, -1], up: [0, 1, 0] },
  { look: [0, 0, 1], up: [0, 1, 0] },
];

export interface ProbesProduct {
  count: number;
  /** A sphere for each probe: its place and radius. */
  spheres: Float32Array;
  /** Each probe's strength, in x of a vec4. */
  intensities: Float32Array;
  mips: number;
  /** A cube array. */
  view: GPUTextureView;
}

const _target = new THREE.Vector3();

export class ProbeStore {
  private texture: GPUTexture | null = null;
  private view: GPUTextureView | null = null;
  private readonly slots = new Map<string, number>();
  private readonly spheres = new Float32Array(MAX_PROBES * 4);
  private readonly intensities = new Float32Array(MAX_PROBES * 4);
  private readonly cameras: THREE.PerspectiveCamera[] = [];
  private readonly product: ProbesProduct = { count: 0, spheres: this.spheres, intensities: this.intensities, mips: PROBE_MIPS, view: null as unknown as GPUTextureView };

  constructor(private readonly device: GPUDevice, private readonly textures: TexturePool) {}

  /** The six cameras, placed at `position`. */
  facesAt(position: THREE.Vector3): THREE.PerspectiveCamera[] {
    if (!this.cameras.length) {
      for (let face = 0; face < FACES.length; face++) this.cameras.push(new THREE.PerspectiveCamera(90, 1, 0.05, 1000));
    }
    this.cameras.forEach((camera, face) => {
      const { look, up } = FACES[face];
      camera.up.set(up[0], up[1], up[2]);
      camera.position.copy(position);
      camera.lookAt(_target.set(position.x + look[0], position.y + look[1], position.z + look[2]));
      camera.updateMatrixWorld(true);
      camera.updateProjectionMatrix();
    });
    return this.cameras;
  }

  private ensureTexture(): GPUTexture {
    if (this.texture) return this.texture;
    this.texture = this.device.createTexture({
      label: "gpu reflection probes",
      size: [PROBE_SIZE, PROBE_SIZE, MAX_PROBES * 6],
      format: PROBE_FORMAT,
      mipLevelCount: PROBE_MIPS,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.view = this.texture.createView({ dimension: "cube-array", arrayLayerCount: MAX_PROBES * 6 });
    this.product.view = this.view;
    return this.texture;
  }

  /** The probe's slot, a new one if it has none; null with every slot taken. */
  slotFor(id: string): number | null {
    const known = this.slots.get(id);
    if (known !== undefined) return known;
    if (this.slots.size >= MAX_PROBES) return null;
    const used = new Set(this.slots.values());
    for (let slot = 0; slot < MAX_PROBES; slot++) {
      if (!used.has(slot)) {
        this.slots.set(id, slot);
        return slot;
      }
    }
    return null;
  }

  /** Puts a finished face into the array. */
  copyFace(encoder: GPUCommandEncoder, source: GPUTexture, slot: number, face: number): void {
    encoder.copyTextureToTexture({ texture: source }, { texture: this.ensureTexture(), origin: [0, 0, slot * 6 + face] }, [PROBE_SIZE, PROBE_SIZE, 1]);
  }

  /** Once all six faces are in: the blurred mips, and the probe joins what lighting reads. */
  finish(slot: number, position: THREE.Vector3, radius: number, intensity: number): void {
    const texture = this.ensureTexture();
    for (let face = 0; face < 6; face++) this.textures.generateMips(texture, PROBE_FORMAT, PROBE_MIPS, slot * 6 + face);
    this.place(slot, position, radius, intensity);
  }

  /** Its numbers, without capturing it again. */
  place(slot: number, position: THREE.Vector3, radius: number, intensity: number): void {
    this.spheres.set([position.x, position.y, position.z, radius], slot * 4);
    this.intensities[slot * 4] = intensity;
    this.product.count = Math.max(this.product.count, slot + 1);
  }

  remove(id: string): void {
    const slot = this.slots.get(id);
    if (slot === undefined) return;
    this.slots.delete(id);
    // A radius of nothing holds no pixel.
    this.spheres[slot * 4 + 3] = -1;
    let count = 0;
    for (const used of this.slots.values()) count = Math.max(count, used + 1);
    this.product.count = count;
  }

  /** What lighting reads, or null with no probe captured. */
  get current(): ProbesProduct | null {
    return this.product.count && this.view ? this.product : null;
  }

  destroy(): void {
    this.texture?.destroy();
    this.texture = null;
    this.view = null;
    this.slots.clear();
    this.product.count = 0;
  }
}
