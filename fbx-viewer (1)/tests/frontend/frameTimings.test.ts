import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FrameTimings } from '../../renderer/gpu/frameTimings';

interface FakeBuffer {
  times: BigInt64Array;
  mapAsync: () => Promise<void>;
  getMappedRange: () => ArrayBuffer;
  unmap: () => void;
  destroy: () => void;
}

const fakeDevice = () => {
  const buffers: FakeBuffer[] = [];
  const device = {
    createQuerySet: ({ count }: { count: number }) => ({ count, destroy: () => undefined }),
    createBuffer: ({ size }: { size: number }) => {
      const times = new BigInt64Array(size / 8);
      const buffer: FakeBuffer = {
        times,
        mapAsync: () => Promise.resolve(),
        getMappedRange: () => times.buffer as ArrayBuffer,
        unmap: () => undefined,
        destroy: () => undefined,
      };
      buffers.push(buffer);
      return buffer;
    },
  };
  return { device: device as unknown as GPUDevice, buffers };
};

const fakeEncoder = () => {
  const resolves: { first: number; count: number; offset: number }[] = [];
  const encoder = {
    beginComputePass: () => ({ end: () => undefined }),
    resolveQuerySet: (_set: unknown, first: number, count: number, _target: unknown, offset: number) => resolves.push({ first, count, offset }),
    copyBufferToBuffer: () => undefined,
  };
  return { encoder: encoder as unknown as GPUCommandEncoder, resolves };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('frame timings spans', () => {
  beforeEach(() => {
    vi.stubGlobal('GPUBufferUsage', { QUERY_RESOLVE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8 });
    vi.stubGlobal('GPUMapMode', { READ: 1 });
  });

  it('resolves spans to where a query set may write: a multiple of 256 bytes', () => {
    const { device } = fakeDevice();
    const timings = new FrameTimings(device, true);
    const { encoder, resolves } = fakeEncoder();
    timings.begin(encoder);
    timings.span('rays');
    timings.end(encoder, 'afterSurfaces');
    timings.finish(encoder);
    expect(resolves).toHaveLength(2);
    for (const { offset } of resolves) expect(offset % 256).toBe(0);
  });

  it("adds up a name's spans in a frame and hands them over with the share they ran at", async () => {
    const { device, buffers } = fakeDevice();
    const timings = new FrameTimings(device, true);
    const { encoder } = fakeEncoder();
    const seen: number[][] = [];
    timings.onSpan('rays', (ms, share) => seen.push([ms, share]));
    timings.begin(encoder);
    const first = timings.span('rays', 0.5);
    const second = timings.span('rays', 0.5);
    timings.end(encoder, 'afterSurfaces');
    const readback = timings.finish(encoder);

    const held = buffers.find((buffer) => buffer === (readback as unknown as { buffer: FakeBuffer }).buffer)!;
    const at = (index: number | undefined) => 256 / 8 + index! - 16;
    held.times[at(first.first!.beginningOfPassWriteIndex)] = 1_000_000n;
    held.times[at(first.last!.endOfPassWriteIndex)] = 3_000_000n;
    held.times[at(second.first!.beginningOfPassWriteIndex)] = 5_000_000n;
    held.times[at(second.last!.endOfPassWriteIndex)] = 6_000_000n;
    timings.collect(readback);
    await settle();
    expect(seen).toEqual([[3, 0.5]]);
  });

  it('times nothing where the card has no clock', () => {
    const { device } = fakeDevice();
    const timings = new FrameTimings(device, false);
    expect(timings.timed).toBe(false);
    expect(timings.span('rays')).toEqual({});
  });

  it('stops timing once a frame runs out of marks', () => {
    const { device } = fakeDevice();
    const timings = new FrameTimings(device, true);
    const { encoder } = fakeEncoder();
    timings.begin(encoder);
    for (let index = 0; index < 16; index++) expect(timings.span('rays').first).toBeDefined();
    expect(timings.span('rays')).toEqual({});
  });
});
