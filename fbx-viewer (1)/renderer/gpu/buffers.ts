/// <reference types="@webgpu/types" />

/**
 * BUFFERS THAT GROW, AND RANGES WITHIN THEM
 *
 * The renderer keeps its data in a few long buffers rather than one per object: that is what lets a compute
 * pass walk everything at once. `GrowableBuffer` replaces its GPU buffer with a larger one when it runs out of
 * room and says so through `generation`, so whatever bound the old one binds again. `RangeAllocator` hands
 * out and takes back runs of elements within such a buffer.
 */

const GROWTH = 1.5;
const COPY_ALIGNMENT = 4;

export class GrowableBuffer {
  buffer: GPUBuffer;
  bytes: number;
  /** Goes up whenever `buffer` is replaced. */
  generation = 0;

  constructor(
    private readonly device: GPUDevice,
    private readonly label: string,
    private readonly usage: GPUBufferUsageFlags,
    initialBytes: number,
  ) {
    this.bytes = alignBytes(initialBytes);
    this.buffer = device.createBuffer({ label, size: this.bytes, usage: usage | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  }

  /** Makes room for `bytes`, keeping what the buffer holds. Returns whether the GPU buffer changed. */
  ensure(bytes: number): boolean {
    if (bytes <= this.bytes) return false;
    const limit = this.device.limits.maxBufferSize;
    const size = alignBytes(Math.min(limit, Math.max(bytes, Math.ceil(this.bytes * GROWTH))));
    if (size < bytes) throw new RangeError(`${this.label} would need ${bytes} bytes, past the device's ${limit}`);
    const next = this.device.createBuffer({ label: this.label, size, usage: this.usage | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder({ label: `${this.label} growth` });
    encoder.copyBufferToBuffer(this.buffer, 0, next, 0, this.bytes);
    this.device.queue.submit([encoder.finish()]);
    this.buffer.destroy();
    this.buffer = next;
    this.bytes = size;
    this.generation++;
    return true;
  }

  write(byteOffset: number, data: ArrayBufferView, dataOffset = 0, dataBytes?: number): void {
    const bytes = dataBytes ?? data.byteLength - dataOffset;
    if (bytes <= 0) return;
    this.device.queue.writeBuffer(this.buffer, byteOffset, data.buffer as ArrayBuffer, data.byteOffset + dataOffset, bytes);
  }

  destroy(): void {
    this.buffer.destroy();
  }
}

const alignBytes = (bytes: number): number => Math.max(COPY_ALIGNMENT, Math.ceil(bytes / COPY_ALIGNMENT) * COPY_ALIGNMENT);

interface FreeRange {
  start: number;
  count: number;
}

/** First-fit allocation of runs of elements; freed runs join their neighbours. */
export class RangeAllocator {
  private readonly free: FreeRange[] = [];
  /** One past the last element ever handed out. */
  end = 0;

  allocate(count: number): number {
    for (let index = 0; index < this.free.length; index++) {
      const range = this.free[index];
      if (range.count < count) continue;
      const start = range.start;
      range.start += count;
      range.count -= count;
      if (!range.count) this.free.splice(index, 1);
      return start;
    }
    const start = this.end;
    this.end += count;
    return start;
  }

  release(start: number, count: number): void {
    if (!count) return;
    let at = 0;
    while (at < this.free.length && this.free[at].start < start) at++;
    this.free.splice(at, 0, { start, count });
    const next = this.free[at + 1];
    if (next && start + count === next.start) {
      this.free[at].count += next.count;
      this.free.splice(at + 1, 1);
    }
    const previous = this.free[at - 1];
    if (previous && previous.start + previous.count === start) {
      previous.count += this.free[at].count;
      this.free.splice(at, 1);
    }
  }
}

/**
 * A CPU copy of a table of fixed-size records and the runs of it that changed, uploaded together.
 * The copy is what makes "write this record" cheap: changes gather and go up once a frame.
 */
export class RecordTable {
  data: Float32Array;
  private lowDirty = Infinity;
  private highDirty = -1;
  private wordsView: Uint32Array;

  constructor(readonly recordWords: number, initialRecords: number) {
    this.data = new Float32Array(recordWords * initialRecords);
    this.wordsView = new Uint32Array(this.data.buffer);
  }

  get uints(): Uint32Array {
    return this.wordsView;
  }

  get capacity(): number {
    return this.data.length / this.recordWords;
  }

  ensure(records: number): void {
    if (records <= this.capacity) return;
    const next = new Float32Array(this.recordWords * Math.max(records, Math.ceil(this.capacity * GROWTH)));
    next.set(this.data);
    this.data = next;
    this.wordsView = new Uint32Array(next.buffer);
  }

  markDirty(first: number, count = 1): void {
    if (first < this.lowDirty) this.lowDirty = first;
    if (first + count - 1 > this.highDirty) this.highDirty = first + count - 1;
  }

  /** Sends what changed since the last upload. */
  upload(target: GrowableBuffer): void {
    target.ensure(this.data.byteLength);
    if (this.highDirty < 0) return;
    const bytesPerRecord = this.recordWords * 4;
    target.write(this.lowDirty * bytesPerRecord, this.data, this.lowDirty * bytesPerRecord, (this.highDirty - this.lowDirty + 1) * bytesPerRecord);
    this.lowDirty = Infinity;
    this.highDirty = -1;
  }

  /** Has the next upload send everything: a new GPU buffer holds nothing useful. */
  markAllDirty(records: number): void {
    if (records > 0) this.markDirty(0, records);
  }
}
