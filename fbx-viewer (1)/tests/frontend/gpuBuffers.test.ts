import { describe, expect, it } from "vitest";
import { GrowableBuffer, RangeAllocator, RecordTable } from "../../renderer/gpu/buffers";
import { ImagePool } from "../../renderer/gpu/post/postImages";

// What the tests below need of a browser with no WebGPU in it.
Object.assign(globalThis, {
  GPUBufferUsage: { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8 },
  GPUTextureUsage: { TEXTURE_BINDING: 4, STORAGE_BINDING: 8 },
});

describe("RangeAllocator", () => {
  it("hands out runs one after another", () => {
    const ranges = new RangeAllocator();
    expect(ranges.allocate(4)).toBe(0);
    expect(ranges.allocate(2)).toBe(4);
    expect(ranges.end).toBe(6);
  });

  it("reuses a freed run before growing", () => {
    const ranges = new RangeAllocator();
    const first = ranges.allocate(4);
    ranges.allocate(2);
    ranges.release(first, 4);
    expect(ranges.allocate(3)).toBe(0);
    expect(ranges.allocate(1)).toBe(3);
    expect(ranges.end).toBe(6);
  });

  it("joins neighbouring freed runs", () => {
    const ranges = new RangeAllocator();
    const a = ranges.allocate(2);
    const b = ranges.allocate(2);
    const c = ranges.allocate(2);
    ranges.allocate(1);
    ranges.release(a, 2);
    ranges.release(c, 2);
    ranges.release(b, 2);
    expect(ranges.allocate(6)).toBe(0);
    expect(ranges.end).toBe(7);
  });
});

describe("RecordTable", () => {
  it("keeps its contents when it grows", () => {
    const table = new RecordTable(4, 2);
    table.data[5] = 7;
    table.ensure(100);
    expect(table.capacity).toBeGreaterThanOrEqual(100);
    expect(table.data[5]).toBe(7);
    expect(new Float32Array(table.uints.buffer)[5]).toBe(7);
  });

  it("sends only the run that changed", () => {
    const table = new RecordTable(2, 8);
    const writes: [number, number, number][] = [];
    const target = {
      ensure: () => false,
      write: (byteOffset: number, _data: ArrayBufferView, dataOffset: number, bytes: number) => { writes.push([byteOffset, dataOffset, bytes]); },
    };
    table.markDirty(2);
    table.markDirty(4);
    table.upload(target as never);
    expect(writes).toEqual([[16, 16, 24]]);
    table.upload(target as never);
    expect(writes.length).toBe(1);
  });
});

const fakeDevice = (limits: Partial<GPUSupportedLimits> = {}) => {
  const destroyed: string[] = [];
  const stamp = (label: string | undefined) => ({ label, destroy: () => destroyed.push(label ?? ""), createView: () => ({}) });
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30, ...limits },
    createBuffer: (descriptor: GPUBufferDescriptor) => stamp(descriptor.label),
    createTexture: (descriptor: GPUTextureDescriptor) => stamp(descriptor.label),
    createCommandEncoder: () => ({ copyBufferToBuffer: () => undefined, finish: () => ({}) }),
    queue: { submit: () => undefined },
  };
  return { device: device as unknown as GPUDevice, destroyed };
};

describe("GrowableBuffer", () => {
  it("cannot grow a buffer a shader reads whole past what a shader may bind", () => {
    const { device } = fakeDevice({ maxBufferSize: 1024, maxStorageBufferBindingSize: 256 });
    const buffer = new GrowableBuffer(device, "table", GPUBufferUsage.STORAGE, 64);
    expect(() => buffer.ensure(512)).toThrow(RangeError);
    expect(buffer.ensure(200)).toBe(true);
    expect(buffer.bytes).toBeLessThanOrEqual(256);
  });

  it("keeps the old buffer until what is being recorded has been handed over", async () => {
    const { device, destroyed } = fakeDevice();
    const buffer = new GrowableBuffer(device, "table", GPUBufferUsage.STORAGE, 64);
    buffer.ensure(1024);
    expect(destroyed).toEqual([]);
    await Promise.resolve();
    expect(destroyed).toEqual(["table"]);
  });
});

describe("ImagePool", () => {
  it("does not keep a whole stack of pictures for every size a dragged window goes through", async () => {
    const { device, destroyed } = fakeDevice();
    const pool = new ImagePool(device);
    pool.beginFrame(1);
    for (let width = 100; width < 140; width++) {
      pool.beginFrame(width);
      pool.image("history", width, 100);
    }
    await Promise.resolve();
    expect(destroyed.length).toBeGreaterThanOrEqual(24);
    const kept = pool.image("history", 139, 100);
    expect(kept.width).toBe(139);
  });
});
