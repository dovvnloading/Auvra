/**
 * Image work for imported materials: recognising a file's format from its bytes, packing separate
 * roughness and metalness maps the way glTF keeps them, and writing the result as a PNG. The PNG is
 * only a handoff inside one load (the GPU compression that follows starts from its pixels), so it
 * is written with no compression at all: quick to write and exact, whatever the alpha holds.
 */

/** Decoded pixels: four bytes each, straight alpha, first row at the top. */
export interface Pixels {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

export type ImageKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'avif' | 'tiff' | 'tga' | 'dds' | 'psd' | 'exr' | 'hdr' | 'unknown';

const MIME_TYPES: Partial<Record<ImageKind, string>> = {
  png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
};

/** The MIME type a browser decodes an image kind with, or undefined for a kind it cannot. */
export const browserImageType = (kind: ImageKind): string | undefined => MIME_TYPES[kind];

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean =>
  bytes.length >= at + signature.length && signature.every((value, index) => bytes[at + index] === value);

const ascii = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0));

/** Which format an image's bytes are in. TGA has no signature, so only its file name can say. */
export const sniffImageKind = (bytes: Uint8Array, fileName = ''): ImageKind => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, ascii('GIF8'))) return 'gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'webp';
  if (startsWith(bytes, ascii('BM'))) return 'bmp';
  if (startsWith(bytes, ascii('ftypavif'), 4) || startsWith(bytes, ascii('ftypavis'), 4)) return 'avif';
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff';
  if (startsWith(bytes, ascii('DDS '))) return 'dds';
  if (startsWith(bytes, ascii('8BPS'))) return 'psd';
  if (startsWith(bytes, [0x76, 0x2f, 0x31, 0x01])) return 'exr';
  if (startsWith(bytes, ascii('#?'))) return 'hdr';
  if (/\.(tga|targa)$/i.test(fileName)) return 'tga';
  return 'unknown';
};

/** Whether an encoded image has an alpha channel, as far as its header says. */
export const imageHasAlpha = (bytes: Uint8Array, kind: ImageKind): boolean => {
  if (kind === 'jpeg') return false;
  if (kind !== 'png' || bytes.length < 26) return kind !== 'bmp';
  const colourType = bytes[25];
  if (colourType === 4 || colourType === 6) return true;
  // A palette or grey image may carry alpha in a tRNS chunk, before its first IDAT.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (type === 'tRNS') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    at += 12 + length;
  }
  return false;
};

/** `pixels` at another size, by the nearest pixel: masks and material maps need no more. */
export const resizedTo = (pixels: Pixels, width: number, height: number): Pixels => {
  if (pixels.width === width && pixels.height === height) return pixels;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(pixels.height - 1, Math.floor((y * pixels.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(pixels.width - 1, Math.floor((x * pixels.width) / width));
      const from = (sourceY * pixels.width + sourceX) * 4;
      const to = (y * width + x) * 4;
      data[to] = pixels.data[from];
      data[to + 1] = pixels.data[from + 1];
      data[to + 2] = pixels.data[from + 2];
      data[to + 3] = pixels.data[from + 3];
    }
  }
  return { data, width, height };
};

export interface MetalRoughInput {
  /** The roughness map (read from green), or null to leave roughness to the material's factor. */
  roughness: Pixels | null;
  /** The map holds glossiness: bright is shiny, so it is inverted. */
  invertRoughness?: boolean;
  /** The metalness map (read from blue), or null to leave metalness to the material's factor. */
  metalness: Pixels | null;
}

/** One image holding roughness in green and metalness in blue, as glTF keeps them. */
export const packMetalRough = ({ roughness, invertRoughness = false, metalness }: MetalRoughInput): Pixels => {
  const width = Math.max(roughness?.width ?? 0, metalness?.width ?? 0);
  const height = Math.max(roughness?.height ?? 0, metalness?.height ?? 0);
  const rough = roughness ? resizedTo(roughness, width, height) : null;
  const metal = metalness ? resizedTo(metalness, width, height) : null;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    const g = rough ? rough.data[i + 1] : 255;
    data[i + 1] = rough && invertRoughness ? 255 - g : g;
    data[i + 2] = metal ? metal.data[i + 2] : 255;
    data[i + 3] = 255;
  }
  return { data, width, height };
};

/** How steep a height map's slopes are drawn: a step from black to white in one pixel leans a normal by about 63 degrees. */
const HEIGHT_STRENGTH = 4;

/**
 * A normal map worked out from a height map, as materials here shade with normals. Slopes are read
 * over each pixel's neighbours (a Sobel filter), wrapping at the edges as textures tile. Green points
 * towards the top of the image, as glTF expects.
 */
export const normalsFromHeight = (heights: Pixels, strength = HEIGHT_STRENGTH): Pixels => {
  const { data: source, width, height } = heights;
  const data = new Uint8Array(width * height * 4);
  // Height maps are grey, so one channel is enough; green is the one every format keeps best.
  const at = (x: number, y: number): number => source[(((y + height) % height) * width + ((x + width) % width)) * 4 + 1] / 255;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const across = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) / 8;
      const down = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)) / 8;
      // Uphill to the right leans the surface left; uphill towards the bottom of the image leans it to the top.
      const nx = -across * strength;
      const ny = down * strength;
      const scale = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const to = (y * width + x) * 4;
      data[to] = Math.round((nx * scale * 0.5 + 0.5) * 255);
      data[to + 1] = Math.round((ny * scale * 0.5 + 0.5) * 255);
      data[to + 2] = Math.round((scale * 0.5 + 0.5) * 255);
      data[to + 3] = 255;
    }
  }
  return { data, width, height };
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array, start: number, end: number): number => {
  let crc = 0xffffffff;
  for (let i = start; i < end; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const STORED_BLOCK = 0xffff;

/** `pixels` as a PNG with no compression. Alpha is left out when every pixel is opaque. */
export const encodePng = (pixels: Pixels): Uint8Array => {
  const { data, width, height } = pixels;
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) { opaque = false; break; }
  }
  const channels = opaque ? 3 : 4;
  const row = width * channels + 1;
  const raw = row * height;
  const blocks = Math.max(1, Math.ceil(raw / STORED_BLOCK));
  const idat = 2 + raw + blocks * 5 + 4;
  const output = new Uint8Array(8 + (12 + 13) + (12 + idat) + 12);
  const view = new DataView(output.buffer);
  output.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let at = 8;
  const chunkStart = (length: number, type: string): number => {
    view.setUint32(at, length);
    for (let i = 0; i < 4; i += 1) output[at + 4 + i] = type.charCodeAt(i);
    at += 8;
    return at - 4;
  };
  const chunkEnd = (typeAt: number): void => {
    view.setUint32(at, crc32(output, typeAt, at));
    at += 4;
  };

  let start = chunkStart(13, 'IHDR');
  view.setUint32(at, width);
  view.setUint32(at + 4, height);
  output[at + 8] = 8;
  output[at + 9] = opaque ? 2 : 6;
  at += 13;
  chunkEnd(start);

  start = chunkStart(idat, 'IDAT');
  output[at++] = 0x78;
  output[at++] = 0x01;
  let adlerA = 1;
  let adlerB = 0;
  let remaining = raw;
  let inBlock = 0;
  const openBlock = (): void => {
    inBlock = Math.min(remaining, STORED_BLOCK);
    remaining -= inBlock;
    output[at++] = remaining === 0 ? 1 : 0;
    output[at++] = inBlock & 0xff;
    output[at++] = inBlock >> 8;
    output[at++] = ~inBlock & 0xff;
    output[at++] = (~inBlock >> 8) & 0xff;
  };
  const put = (value: number): void => {
    if (inBlock === 0) openBlock();
    output[at++] = value;
    inBlock -= 1;
    adlerA = (adlerA + value) % 65521;
    adlerB = (adlerB + adlerA) % 65521;
  };
  for (let y = 0; y < height; y += 1) {
    put(0);
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const pixel = rowStart + x * 4;
      put(data[pixel]);
      put(data[pixel + 1]);
      put(data[pixel + 2]);
      if (channels === 4) put(data[pixel + 3]);
    }
  }
  view.setUint32(at, ((adlerB << 16) | adlerA) >>> 0);
  at += 4;
  chunkEnd(start);

  start = chunkStart(0, 'IEND');
  chunkEnd(start);
  return output;
};
