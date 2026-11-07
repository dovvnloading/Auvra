/// <reference types="@webgpu/types" />
import type { GpuStage } from "./frame";

/**
 * FRAME TIMINGS
 *
 * How long each stage of a frame took on the graphics card, and on the page's thread to record. An empty compute pass
 * between stages writes a timestamp, so no pass has to know it is being timed. Results come back some frames later
 * and are smoothed, so a reading is a recent average rather than one frame's luck.
 *
 * Work that is cut to fit its time on the card (runtime/raytracing/rayBudget.ts) times its own passes as a span as well.
 */

const MAX_MARKS = 16;
/** Marks for spans, after the stages': two for each stretch of work timed in a frame. */
const SPAN_MARKS = 32;
/** Where the spans' times go in the buffers: a query set resolves only to a multiple of 256 bytes. */
const SPAN_BYTES_AT = 256;
const BUFFER_BYTES = SPAN_BYTES_AT + SPAN_MARKS * 8;
const READBACKS = 4;
const SMOOTHING = 0.1;

export interface StageTiming {
  stage: GpuStage | "present";
  gpuMs: number;
  cpuMs: number;
}

/** What goes on the first and last compute pass of a stretch of work to time it: nothing, where the card has no clock or the frame is full. */
export interface TimedSpan {
  first?: GPUComputePassTimestampWrites;
  last?: GPUComputePassTimestampWrites;
}

interface SpanMark {
  name: string;
  at: number;
  share: number;
}

interface Readback {
  buffer: GPUBuffer;
  busy: boolean;
  stages: (GpuStage | "present")[];
  spans: SpanMark[];
}

export class FrameTimings {
  private readonly querySet: GPUQuerySet | null;
  private readonly resolve: GPUBuffer | null;
  private readonly readbacks: Readback[] = [];
  private stages: (GpuStage | "present")[] = [];
  private mark = 0;
  private lastCpu = 0;
  private readonly gpu = new Map<string, number>();
  private readonly cpu = new Map<string, number>();
  private order: (GpuStage | "present")[] = [];
  private spans: SpanMark[] = [];
  private readonly spanListeners = new Map<string, (ms: number, share: number) => void>();
  gpuTotalMs = 0;
  cpuTotalMs = 0;

  constructor(device: GPUDevice, enabled: boolean) {
    this.querySet = enabled ? device.createQuerySet({ label: "gpu stage timestamps", type: "timestamp", count: MAX_MARKS + SPAN_MARKS }) : null;
    this.resolve = enabled
      ? device.createBuffer({ label: "gpu stage timestamps", size: BUFFER_BYTES, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
      : null;
    if (enabled) {
      for (let index = 0; index < READBACKS; index++) {
        this.readbacks.push({
          buffer: device.createBuffer({ label: "gpu stage timestamp readback", size: BUFFER_BYTES, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
          busy: false,
          stages: [],
          spans: [],
        });
      }
    }
  }

  begin(encoder: GPUCommandEncoder): void {
    this.mark = 0;
    this.stages = [];
    this.spans = [];
    this.lastCpu = performance.now();
    this.stamp(encoder);
  }

  /** Marks the end of `stage`. */
  end(encoder: GPUCommandEncoder, stage: GpuStage | "present"): void {
    const now = performance.now();
    this.cpu.set(stage, smooth(this.cpu.get(stage), now - this.lastCpu));
    this.lastCpu = now;
    this.stages.push(stage);
    this.stamp(encoder);
  }

  private stamp(encoder: GPUCommandEncoder): void {
    if (!this.querySet || this.mark >= MAX_MARKS) return;
    encoder.beginComputePass({ timestampWrites: { querySet: this.querySet, beginningOfPassWriteIndex: this.mark++ } }).end();
  }

  /**
   * Times a stretch of this frame's work done at `share` of its full amount. All the spans of one name in a frame are
   * added up and handed to the listener given to `onSpan` once the card has answered, some frames later.
   */
  span(name: string, share = 1): TimedSpan {
    const at = MAX_MARKS + this.spans.length * 2;
    if (!this.querySet || at + 2 > MAX_MARKS + SPAN_MARKS) return {};
    this.spans.push({ name, at, share });
    return {
      first: { querySet: this.querySet, beginningOfPassWriteIndex: at },
      last: { querySet: this.querySet, endOfPassWriteIndex: at + 1 },
    };
  }

  /** Whether spans can be timed on this card at all. */
  get timed(): boolean {
    return this.querySet !== null;
  }

  onSpan(name: string, listener: ((ms: number, share: number) => void) | null): void {
    if (listener) this.spanListeners.set(name, listener);
    else this.spanListeners.delete(name);
  }

  /** Before the frame's encoder finishes. A free readback buffer takes this frame's marks; with none free, the frame goes unmeasured. */
  finish(encoder: GPUCommandEncoder): Readback | null {
    if (!this.querySet || !this.resolve || this.mark < 2) return null;
    const free = this.readbacks.find((readback) => !readback.busy);
    if (!free) return null;
    encoder.resolveQuerySet(this.querySet, 0, this.mark, this.resolve, 0);
    encoder.copyBufferToBuffer(this.resolve, 0, free.buffer, 0, this.mark * 8);
    if (this.spans.length) {
      const marks = this.spans.length * 2;
      encoder.resolveQuerySet(this.querySet, MAX_MARKS, marks, this.resolve, SPAN_BYTES_AT);
      encoder.copyBufferToBuffer(this.resolve, SPAN_BYTES_AT, free.buffer, SPAN_BYTES_AT, marks * 8);
    }
    free.busy = true;
    free.stages = this.stages.slice(0, this.mark - 1);
    free.spans = this.spans;
    return free;
  }

  /** After the frame is submitted. */
  collect(readback: Readback | null): void {
    if (!readback) return;
    readback.buffer.mapAsync(GPUMapMode.READ).then(() => {
      const times = new BigInt64Array(readback.buffer.getMappedRange());
      let total = 0;
      readback.stages.forEach((stage, index) => {
        const ms = Number(times[index + 1] - times[index]) / 1e6;
        // Some drivers report out of order across queues; a negative span is noise.
        if (ms < 0 || ms > 1000) return;
        this.gpu.set(stage, smooth(this.gpu.get(stage), ms));
        total += ms;
      });
      this.gpuTotalMs = smooth(this.gpuTotalMs || undefined, total);
      this.order = readback.stages;
      const added = new Map<string, { ms: number; share: number }>();
      const spanTimes = new BigInt64Array(times.buffer, SPAN_BYTES_AT);
      for (const { name, at, share } of readback.spans) {
        const ms = Number(spanTimes[at - MAX_MARKS + 1] - spanTimes[at - MAX_MARKS]) / 1e6;
        if (ms < 0 || ms > 1000) continue;
        const held = added.get(name);
        if (held) held.ms += ms;
        else added.set(name, { ms, share });
      }
      for (const [name, { ms, share }] of added) this.spanListeners.get(name)?.(ms, share);
      readback.buffer.unmap();
      readback.busy = false;
    }).catch(() => {
      // A lost device takes its buffers with it.
    });
  }

  /** The latest averages, in stage order. */
  read(): StageTiming[] {
    this.cpuTotalMs = 0;
    const list = (this.order.length ? this.order : this.stages).map((stage) => {
      const cpuMs = this.cpu.get(stage) ?? 0;
      this.cpuTotalMs += cpuMs;
      return { stage, gpuMs: this.gpu.get(stage) ?? 0, cpuMs };
    });
    return list;
  }

  destroy(): void {
    this.querySet?.destroy();
    this.resolve?.destroy();
    for (const readback of this.readbacks) readback.buffer.destroy();
  }
}

const smooth = (previous: number | undefined, next: number): number => previous === undefined ? next : previous + (next - previous) * SMOOTHING;
