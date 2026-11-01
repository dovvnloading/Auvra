/**
 * A result painted from a part's own texture, put back over that texture: colour and broad shading from the result, fine
 * detail from the original. However far a model drifts, seams, folds and print stay where the model's UVs expect them, what
 * is cut out of the original stays cut out, and what the model does not use of the map stays as it was.
 */

/** How much of the original's fine detail a result keeps unless told otherwise. */
export const DEFAULT_KEEP = 0.75;

/** The scale below which detail counts as fine, as a share of the map's width. */
const FINE_DETAIL_SHARE = 1 / 96;
const MIN_RADIUS = 2;
/** Two box blurs are close enough to a gaussian, and take the same time at any radius. */
const BLUR_PASSES = 2;
/** Keeps a black pixel from dividing by nothing. */
const LUMINANCE_FLOOR = 1;

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, one byte each. */
  data: Uint8ClampedArray;
}

const blurOnce = (from: Float32Array, to: Float32Array, lines: number, length: number, lineStep: number, step: number, radius: number) => {
  const span = radius * 2 + 1;
  const last = length - 1;
  for (let line = 0; line < lines; line += 1) {
    const start = line * lineStep;
    let sum = from[start] * (radius + 1);
    for (let at = 1; at <= radius; at += 1) sum += from[start + Math.min(at, last) * step];
    for (let at = 0; at < length; at += 1) {
      to[start + at * step] = sum / span;
      sum += from[start + Math.min(at + radius + 1, last) * step] - from[start + Math.max(at - radius, 0) * step];
    }
  }
};

export const blurred = (values: Float32Array, width: number, height: number, radius: number): Float32Array => {
  let current = values;
  let spare = new Float32Array(values.length);
  for (let pass = 0; pass < BLUR_PASSES; pass += 1) {
    blurOnce(current, spare, height, width, width, 1, radius);
    const rows = spare;
    spare = current === values ? new Float32Array(values.length) : current;
    blurOnce(rows, spare, width, height, 1, width, radius);
    current = spare;
    spare = rows;
  }
  return current;
};

/** What a result and its map are mixed by. */
export interface DetailMix {
  /** Writes the mix to `into`, RGBA: at 1 all the fine detail is the original's, at 0 all of it is the result's. */
  mix(keep: number, into: Uint8ClampedArray): void;
}

/** The way through a long job that keeps the editor drawing. */
const breathe = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

export class OriginalDetail implements DetailMix {
  private constructor(
    private readonly original: Uint8ClampedArray,
    private readonly result: Uint8ClampedArray,
    /** The result's colour without its fine detail. */
    private readonly broad: readonly [Float32Array, Float32Array, Float32Array],
    /** How much lighter or darker each pixel of the original is than its surroundings. */
    private readonly fine: Float32Array,
    private readonly used: Uint8Array | null,
  ) {}

  /** Works out what mixing needs. `original` and `result` are the same size, and `used` has a byte per pixel, not 0 where the model draws it. */
  static async prepare(original: Pixels, result: Pixels, used: Uint8Array | null = null): Promise<OriginalDetail> {
    if (original.width !== result.width || original.height !== result.height) throw new Error('A result must be the size of the map it came from.');
    const { width, height } = original;
    const pixels = width * height;
    const radius = Math.max(MIN_RADIUS, Math.round(width * FINE_DETAIL_SHARE));
    const luminance = new Float32Array(pixels);
    for (let index = 0; index < pixels; index += 1) {
      const at = index * 4;
      luminance[index] = (original.data[at] + original.data[at + 1] + original.data[at + 2]) / 3 + LUMINANCE_FLOOR;
    }
    await breathe();
    const surroundings = blurred(luminance, width, height, radius);
    const fine = new Float32Array(pixels);
    for (let index = 0; index < pixels; index += 1) fine[index] = luminance[index] / surroundings[index];
    const channels: Float32Array[] = [];
    for (let channel = 0; channel < 3; channel += 1) {
      await breathe();
      const values = new Float32Array(pixels);
      for (let index = 0; index < pixels; index += 1) values[index] = result.data[index * 4 + channel];
      channels.push(blurred(values, width, height, radius));
    }
    return new OriginalDetail(original.data, result.data, channels as unknown as [Float32Array, Float32Array, Float32Array], fine, used);
  }

  mix(keep: number, into: Uint8ClampedArray): void {
    const amount = Math.max(0, Math.min(1, keep));
    const rest = 1 - amount;
    const [red, green, blue] = this.broad;
    for (let index = 0; index < this.fine.length; index += 1) {
      const at = index * 4;
      if (this.used && !this.used[index]) {
        into[at] = this.original[at];
        into[at + 1] = this.original[at + 1];
        into[at + 2] = this.original[at + 2];
        into[at + 3] = this.original[at + 3];
        continue;
      }
      const detail = this.fine[index] * amount;
      into[at] = red[index] * detail + this.result[at] * rest;
      into[at + 1] = green[index] * detail + this.result[at + 1] * rest;
      into[at + 2] = blue[index] * detail + this.result[at + 2] * rest;
      into[at + 3] = this.original[at + 3];
    }
  }
}

/**
 * The same mix for an edit made through views of the object: the map's own pixels moved by how much the edit changed the
 * colour around them on the object. No camera saw a pixel inside something or underneath, so those move by the average.
 */
export class ViewedDetail implements DetailMix {
  private readonly average: [number, number, number];

  constructor(
    private readonly original: Uint8ClampedArray,
    private readonly broad: Uint8Array,
    private readonly before: Uint8Array,
    private readonly painted: Uint8Array,
    private readonly used: Uint8Array | null,
  ) {
    const totals = [0, 0, 0];
    let seen = 0;
    for (let at = 0; at < broad.length; at += 4) {
      if (!broad[at + 3]) continue;
      seen += 1;
      for (let channel = 0; channel < 3; channel += 1) totals[channel] += broad[at + channel] - before[at + channel];
    }
    this.average = [totals[0] / (seen || 1), totals[1] / (seen || 1), totals[2] / (seen || 1)];
  }

  mix(keep: number, into: Uint8ClampedArray): void {
    const amount = Math.max(0, Math.min(1, keep));
    const rest = 1 - amount;
    const pixels = this.original.length / 4;
    for (let index = 0; index < pixels; index += 1) {
      const at = index * 4;
      into[at + 3] = this.original[at + 3];
      if (this.used && !this.used[index]) {
        into[at] = this.original[at];
        into[at + 1] = this.original[at + 1];
        into[at + 2] = this.original[at + 2];
        continue;
      }
      const seen = this.broad[at + 3] > 0;
      for (let channel = 0; channel < 3; channel += 1) {
        const moved = this.original[at + channel] + (seen ? this.broad[at + channel] - this.before[at + channel] : this.average[channel]);
        into[at + channel] = moved * amount + (seen ? this.painted[at + channel] : moved) * rest;
      }
    }
  }
}
