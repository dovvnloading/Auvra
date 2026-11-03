/**
 * TERRAIN HEIGHTMAP FILES
 *
 * Reads and writes the files other terrain tools trade in: 16-bit (or 8-bit) grey PNGs and headerless
 * 16-bit RAW. A browser's own image decoding flattens PNGs to 8 bits, which turns slopes into stairs,
 * so PNGs are read and written here.
 */

export interface HeightmapImage {
  width: number;
  height: number;
  /** 0-1, row by row from the top of the image. */
  values: Float32Array;
}

const inflate = async (data: Uint8Array): Promise<Uint8Array> => {
  const stream = new Response(data as BodyInit).body!.pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const deflate = async (data: Uint8Array): Promise<Uint8Array> => {
  const stream = new Response(data as BodyInit).body!.pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Reads a PNG's brightness, keeping all 16 bits of a 16-bit file. Interlaced and palette files are refused. */
export const decodeHeightmapPng = async (bytes: Uint8Array): Promise<HeightmapImage> => {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (signature.some((value, index) => bytes[index] !== value)) throw new Error('This is not a PNG file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  const parts: Uint8Array[] = [];
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      depth = bytes[offset + 16];
      colour = bytes[offset + 17];
      if (bytes[offset + 20] !== 0) throw new Error('Interlaced PNGs cannot be read as heightmaps. Save it without interlacing.');
    } else if (type === 'IDAT') {
      parts.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const channels = colour === 0 ? 1 : colour === 2 ? 3 : colour === 4 ? 2 : colour === 6 ? 4 : 0;
  if (!channels || (depth !== 8 && depth !== 16)) throw new Error('Heightmaps must be 8 or 16 bit grey or RGB PNGs.');
  if (width < 2 || height < 2) throw new Error('The heightmap is too small.');
  const compressed = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of parts) {
    compressed.set(part, cursor);
    cursor += part.length;
  }
  const raw = await inflate(compressed);
  const pixelBytes = (channels * depth) / 8;
  const stride = width * pixelBytes;
  if (raw.length < (stride + 1) * height) throw new Error('The PNG is truncated.');
  const values = new Float32Array(width * height);
  const line = new Uint8Array(stride);
  const previous = new Uint8Array(stride);
  for (let row = 0; row < height; row++) {
    const start = row * (stride + 1);
    const filter = raw[start];
    for (let index = 0; index < stride; index++) {
      const value = raw[start + 1 + index];
      const left = index >= pixelBytes ? line[index - pixelBytes] : 0;
      const up = previous[index];
      const upLeft = index >= pixelBytes ? previous[index - pixelBytes] : 0;
      switch (filter) {
        case 1: line[index] = value + left; break;
        case 2: line[index] = value + up; break;
        case 3: line[index] = value + ((left + up) >> 1); break;
        case 4: line[index] = value + paeth(left, up, upLeft); break;
        default: line[index] = value;
      }
    }
    for (let column = 0; column < width; column++) {
      const at = column * pixelBytes;
      values[row * width + column] = depth === 16 ? (line[at] * 256 + line[at + 1]) / 65535 : line[at] / 255;
    }
    previous.set(line);
  }
  return { width, height, values };
};

/** Reads headerless little-endian 16-bit samples; the file must be square. */
export const decodeHeightmapRaw = (bytes: Uint8Array): HeightmapImage => {
  const samples = Math.floor(bytes.byteLength / 2);
  const side = Math.round(Math.sqrt(samples));
  if (side < 2 || side * side !== samples || samples * 2 !== bytes.byteLength) {
    throw new Error('A RAW heightmap must hold a square of 16-bit samples.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Float32Array(samples);
  for (let index = 0; index < samples; index++) values[index] = view.getUint16(index * 2, true) / 65535;
  return { width: side, height: side, values };
};

export const decodeHeightmapFile = async (file: File): Promise<HeightmapImage> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return /\.(r16|raw)$/i.test(file.name) ? decodeHeightmapRaw(bytes) : decodeHeightmapPng(bytes);
};

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (parts: Uint8Array[]): number => {
  let c = 0xffffffff;
  for (const part of parts) {
    for (let index = 0; index < part.length; index++) c = crcTable[(c ^ part[index]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, body: Uint8Array): Uint8Array => {
  const name = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(name, 4);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32([name, body]));
  return out;
};

const pngFrom = async (width: number, height: number, depth: 8 | 16, raw: Uint8Array): Promise<Uint8Array<ArrayBuffer>> => {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = depth;
  header[9] = 0; // Grey.
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
};

/** A 16-bit grey PNG of values 0-1. */
export const encodeHeightmapPng = (image: HeightmapImage): Promise<Uint8Array<ArrayBuffer>> => {
  const { width, height, values } = image;
  const raw = new Uint8Array((width * 2 + 1) * height);
  for (let row = 0; row < height; row++) {
    const start = row * (width * 2 + 1);
    for (let column = 0; column < width; column++) {
      const sample = Math.round(Math.min(1, Math.max(0, values[row * width + column])) * 65535);
      raw[start + 1 + column * 2] = sample >> 8;
      raw[start + 2 + column * 2] = sample & 0xff;
    }
  }
  return pngFrom(width, height, 16, raw);
};

/** An 8-bit grey PNG of values 0-1. */
export const encodeWeightmapPng = (image: HeightmapImage): Promise<Uint8Array<ArrayBuffer>> => {
  const { width, height, values } = image;
  const raw = new Uint8Array((width + 1) * height);
  for (let row = 0; row < height; row++) {
    const start = row * (width + 1);
    for (let column = 0; column < width; column++) {
      raw[start + 1 + column] = Math.round(Math.min(1, Math.max(0, values[row * width + column])) * 255);
    }
  }
  return pngFrom(width, height, 8, raw);
};

export const encodeHeightmapRaw = (image: HeightmapImage): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(image.values.length * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < image.values.length; index++) {
    view.setUint16(index * 2, Math.round(Math.min(1, Math.max(0, image.values[index])) * 65535), true);
  }
  return out;
};

/** Bilinear resample of a row-by-row grid of `channels` values per sample. */
export const resampleGrid = (
  source: ArrayLike<number>,
  fromColumns: number,
  fromRows: number,
  toColumns: number,
  toRows: number,
  channels = 1,
): Float32Array => {
  const out = new Float32Array(toColumns * toRows * channels);
  for (let row = 0; row < toRows; row++) {
    const fy = toRows > 1 ? (row / (toRows - 1)) * (fromRows - 1) : 0;
    const r0 = Math.min(fromRows - 2, Math.floor(fy));
    const ty = fy - r0;
    for (let column = 0; column < toColumns; column++) {
      const fx = toColumns > 1 ? (column / (toColumns - 1)) * (fromColumns - 1) : 0;
      const c0 = Math.min(fromColumns - 2, Math.floor(fx));
      const tx = fx - c0;
      for (let channel = 0; channel < channels; channel++) {
        const a = source[(r0 * fromColumns + c0) * channels + channel];
        const b = source[(r0 * fromColumns + c0 + 1) * channels + channel];
        const c = source[((r0 + 1) * fromColumns + c0) * channels + channel];
        const d = source[((r0 + 1) * fromColumns + c0 + 1) * channels + channel];
        out[(row * toColumns + column) * channels + channel] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
      }
    }
  }
  return out;
};

/** Hands the browser a file to save. */
export const downloadBytes = (bytes: Uint8Array<ArrayBuffer>, name: string, type: string): void => {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
};

/** The height range an exported file's name records, so importing it again restores the same heights. */
export const heightRangeFromName = (name: string): { low: number; high: number } | null => {
  const match = /_h(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)\./.exec(name);
  return match ? { low: Number(match[1]), high: Number(match[2]) } : null;
};
