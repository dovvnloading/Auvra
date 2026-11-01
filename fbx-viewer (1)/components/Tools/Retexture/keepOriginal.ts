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
 * For each pixel of a picture whose alpha says which were seen, the nearest one that was, or -1 with none at all. One sweep
 * each way carries them across the picture, closely enough for what is out of sight.
 */
const nearestSeen = (seen: Uint8Array, width: number, height: number): Int32Array => {
  const count = width * height;
  const nearest = new Int32Array(count).fill(-1);
  const distance = new Float64Array(count).fill(Infinity);
  for (let index = 0; index < count; index += 1) {
    if (!seen[index * 4 + 3]) continue;
    nearest[index] = index;
    distance[index] = 0;
  }
  const consider = (index: number, x: number, y: number, fromX: number, fromY: number) => {
    if (fromX < 0 || fromX >= width || fromY < 0 || fromY >= height) return;
    const from = nearest[fromY * width + fromX];
    if (from < 0) return;
    const dx = (from % width) - x;
    const dy = Math.floor(from / width) - y;
    const away = dx * dx + dy * dy;
    if (away < distance[index]) { distance[index] = away; nearest[index] = from; }
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!distance[index]) continue;
      consider(index, x, y, x - 1, y);
      consider(index, x, y, x, y - 1);
      consider(index, x, y, x - 1, y - 1);
      consider(index, x, y, x + 1, y - 1);
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      if (!distance[index]) continue;
      consider(index, x, y, x + 1, y);
      consider(index, x, y, x, y + 1);
      consider(index, x, y, x + 1, y + 1);
      consider(index, x, y, x - 1, y + 1);
    }
  }
  return nearest;
};

/**
 * The same mix for an edit made through views of the object: the map's own pixels moved by how much the edit changed the
 * colour around them on the object. No camera saw a pixel inside something or underneath, or some along a seam: those move
 * as the nearest one a camera did see. By what the whole object moved, they would show up as lines along every seam.
 */
export class ViewedDetail implements DetailMix {
  /** `broad`, `before` and `painted` are taken over and filled in. `width` is the map's. */
  constructor(
    private readonly original: Uint8ClampedArray,
    private readonly broad: Uint8Array,
    private readonly before: Uint8Array,
    private readonly painted: Uint8Array,
    private readonly used: Uint8Array | null,
    width: number,
  ) {
    const count = broad.length / 4;
    const nearest = nearestSeen(broad, width, count / width);
    for (let index = 0; index < count; index += 1) {
      const from = nearest[index];
      if (from === index) continue;
      for (let channel = 0; channel < 3; channel += 1) {
        const at = index * 4 + channel;
        if (from < 0) {
          // Nothing was seen at all, so nothing changes.
          broad[at] = 0;
          before[at] = 0;
          painted[at] = original[at];
        } else {
          broad[at] = broad[from * 4 + channel];
          before[at] = before[from * 4 + channel];
          painted[at] = painted[from * 4 + channel];
        }
      }
    }
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
      for (let channel = 0; channel < 3; channel += 1) {
        const moved = this.original[at + channel] + this.broad[at + channel] - this.before[at + channel];
        into[at + channel] = moved * amount + this.painted[at + channel] * rest;
      }
    }
  }
}

/** What a pixel holds where nothing was ever seen at all. */
const NOTHING_SEEN = 128;

/**
 * A map painted through views of an object that had none: what the views show, with what no camera saw taken from the
 * nearest place one did. That covers what is inside or underneath, and the gaps around each piece of the layout, which are
 * read from at a distance, so that nothing dark shows along a seam.
 */
export class PaintedMap implements DetailMix {
  private readonly filled: Uint8ClampedArray;

  /** `painted` is RGBA, its alpha saying whether any camera saw that pixel. */
  constructor(painted: Uint8Array, width: number, height: number) {
    const count = width * height;
    const nearest = nearestSeen(painted, width, height);
    this.filled = new Uint8ClampedArray(count * 4);
    for (let index = 0; index < count; index += 1) {
      const from = nearest[index];
      const at = index * 4;
      for (let channel = 0; channel < 3; channel += 1) this.filled[at + channel] = from < 0 ? NOTHING_SEEN : painted[from * 4 + channel];
      this.filled[at + 3] = 255;
    }
  }

  /** There is no original to keep anything of, so `keep` changes nothing. */
  mix(_keep: number, into: Uint8ClampedArray): void {
    into.set(this.filled);
  }
}
