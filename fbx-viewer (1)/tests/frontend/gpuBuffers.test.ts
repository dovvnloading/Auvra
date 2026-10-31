import { describe, expect, it } from "vitest";
import { RangeAllocator, RecordTable } from "../../renderer/gpu/buffers";

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
