import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { MaterialPool } from "../../renderer/gpu/materialPool";
import type { TexturePool } from "../../renderer/gpu/texturePool";

// What the pool needs of a browser with no WebGPU in it.
Object.assign(globalThis, {
  GPUBufferUsage: { UNIFORM: 64, STORAGE: 128, COPY_SRC: 4, COPY_DST: 8 },
});

const SLICE_BYTES = 768;

/** A device that only remembers what was written where. */
const fakeDevice = () => {
  const writes: { offset: number; red: number }[] = [];
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 27 },
    createBuffer: (descriptor: { size: number }) => ({ size: descriptor.size, destroy: () => undefined }),
    createBindGroupLayout: () => ({}),
    createBindGroup: (descriptor: unknown) => ({ descriptor }),
    createCommandEncoder: () => ({ copyBufferToBuffer: () => undefined, finish: () => ({}) }),
    queue: {
      submit: () => undefined,
      writeBuffer: (_buffer: unknown, offset: number, data: ArrayBuffer, dataOffset: number) => {
        writes.push({ offset, red: new Float32Array(data, dataOffset, 1)[0] });
      },
    },
  };
  return { device: device as unknown as GPUDevice, writes };
};

const fakeTextures = (): TexturePool => {
  const solid = { view: {}, sampler: {}, revision: 1, version: 1 };
  return { acquire: () => null, white: solid, flatNormal: solid, black: solid, deaths: 0 } as unknown as TexturePool;
};

const newPool = () => {
  const { device, writes } = fakeDevice();
  return { pool: new MaterialPool(device, fakeTextures()), writes };
};

describe("MaterialPool", () => {
  it("counts frames itself, so a renderer starting its count again still sends what changed", () => {
    const { pool, writes } = newPool();
    const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(1, 0, 0) });
    // One renderer draws it; then another, whose own count starts at one again, draws it with a new colour.
    pool.beginFrame();
    const entry = pool.acquire(material)!;
    expect(writes.at(-1)).toEqual({ offset: entry.slot * SLICE_BYTES, red: 1 });
    material.color.setRGB(0.25, 0, 0);
    pool.beginFrame();
    expect(pool.acquire(material)).toBe(entry);
    expect(writes.at(-1)).toEqual({ offset: entry.slot * SLICE_BYTES, red: 0.25 });
  });

  it("packs a material once a frame, however many draw it", () => {
    const { pool, writes } = newPool();
    const material = new THREE.MeshStandardMaterial();
    pool.beginFrame();
    pool.acquire(material);
    const sent = writes.length;
    material.color.setRGB(0.5, 0.5, 0.5);
    pool.acquire(material);
    expect(writes.length).toBe(sent);
  });

  it("gives back the slice of a material no scene holds any more, for the next material to take", () => {
    const { pool } = newPool();
    const old = new THREE.MeshStandardMaterial();
    pool.beginFrame();
    const entry = pool.acquire(old)!;
    pool.hold(entry);
    // Its scene's renderer closes: the scene lets go of what it drew, and nothing looks the material up again.
    pool.drop(entry);
    for (let frame = 0; frame < 40; frame++) pool.beginFrame();
    expect(entry.gone).toBe(true);
    const next = pool.acquire(new THREE.MeshStandardMaterial())!;
    expect(next.slot).toBe(entry.slot);
    // The old material, should it be drawn again, comes back as a new entry.
    const again = pool.acquire(old)!;
    expect(again).not.toBe(entry);
    expect(again.slot).not.toBe(next.slot);
  });

  it("keeps what a scene holds, however long other renderers draw without it", () => {
    const { pool } = newPool();
    pool.beginFrame();
    const held = pool.acquire(new THREE.MeshStandardMaterial())!;
    pool.hold(held);
    for (let frame = 0; frame < 1000; frame++) pool.beginFrame();
    expect(held.gone).toBe(false);
    expect(pool.acquire(new THREE.MeshStandardMaterial())!.slot).not.toBe(held.slot);
  });

  it("keeps a material drawn without a scene's group, such as a sprite, while it is still looked up", () => {
    const { pool } = newPool();
    const sprite = new THREE.SpriteMaterial();
    pool.beginFrame();
    const entry = pool.acquire(sprite)!;
    for (let frame = 0; frame < 100; frame++) {
      pool.beginFrame();
      expect(pool.acquire(sprite)).toBe(entry);
    }
    expect(entry.gone).toBe(false);
  });
});
