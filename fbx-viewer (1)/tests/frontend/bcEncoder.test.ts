import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { NORMAL_READ } from '../../utils/textureCompression/compressTextures';
import { BLOCK_BYTES, compressMipChain, decodeBlocks, encodeBlocks, halveImage, halveNormals, hasAlpha } from '../../utils/textureCompression/bcEncoder';

/** A smooth colour gradient with some noise, like a photographed texture. */
const photo = (width: number, height: number, alpha = false) => {
  const rgba = new Uint8Array(width * height * 4);
  let seed = 7;
  const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed % 9) - 4; };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = Math.max(0, Math.min(255, Math.round((x / width) * 220) + 20 + noise()));
      rgba[i + 1] = Math.max(0, Math.min(255, Math.round((y / height) * 180) + 40 + noise()));
      rgba[i + 2] = Math.max(0, Math.min(255, 120 + Math.round(Math.sin(x / 9) * 60) + noise()));
      rgba[i + 3] = alpha ? Math.round((x / width) * 255) : 255;
    }
  }
  return rgba;
};

/** Peak signal-to-noise ratio of the colour channels, in dB. */
const psnr = (a: Uint8Array, b: Uint8Array, channels = [0, 1, 2]) => {
  let sum = 0, count = 0;
  for (let i = 0; i < a.length; i += 4) for (const c of channels) { sum += (a[i + c] - b[i + c]) ** 2; count++; }
  return 10 * Math.log10((255 * 255) / (sum / count));
};

describe('BC block compression', () => {
  it('keeps a textured image close to the source at an eighth of its size (BC1)', () => {
    const image = photo(64, 64);
    const blocks = encodeBlocks(image, 64, 64, 'bc1');
    expect(blocks.length).toBe((64 / 4) * (64 / 4) * BLOCK_BYTES.bc1);
    expect(blocks.length * 8).toBe(image.length);
    expect(psnr(image, decodeBlocks(blocks, 64, 64, 'bc1'))).toBeGreaterThan(32);
  });

  it('keeps a flat colour exactly as near as 5:6:5 bits allow', () => {
    const image = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < image.length; i += 4) { image[i] = 200; image[i + 1] = 100; image[i + 2] = 40; image[i + 3] = 255; }
    const decoded = decodeBlocks(encodeBlocks(image, 16, 16, 'bc1'), 16, 16, 'bc1');
    for (let i = 0; i < decoded.length; i += 4) {
      expect(Math.abs(decoded[i] - 200)).toBeLessThanOrEqual(4);
      expect(Math.abs(decoded[i + 1] - 100)).toBeLessThanOrEqual(2);
      expect(Math.abs(decoded[i + 2] - 40)).toBeLessThanOrEqual(4);
    }
  });

  it('keeps alpha in its own block (BC3)', () => {
    const image = photo(64, 32, true);
    expect(hasAlpha(image)).toBe(true);
    expect(hasAlpha(photo(8, 8))).toBe(false);
    const decoded = decodeBlocks(encodeBlocks(image, 64, 32, 'bc3'), 64, 32, 'bc3');
    expect(psnr(image, decoded, [3])).toBeGreaterThan(40);
    expect(psnr(image, decoded)).toBeGreaterThan(32);
  });

  it('handles sizes that are not whole blocks', () => {
    // A 10x6 corner of the larger image: the same texture, cut off mid-block on both sides.
    const full = photo(64, 64);
    const image = new Uint8Array(10 * 6 * 4);
    for (let y = 0; y < 6; y++) image.set(full.subarray(y * 64 * 4, y * 64 * 4 + 40), y * 40);
    const blocks = encodeBlocks(image, 10, 6, 'bc1');
    expect(blocks.length).toBe(3 * 2 * 8);
    expect(psnr(image, decodeBlocks(blocks, 10, 6, 'bc1'))).toBeGreaterThan(30);
  });
});

describe('mip levels', () => {
  it('averages colour textures in linear light, so a fine black-and-white pattern stays as bright', () => {
    const checker = new Uint8Array(2 * 2 * 4);
    [0, 255, 255, 0].forEach((value, pixel) => { checker.fill(value, pixel * 4, pixel * 4 + 3); checker[pixel * 4 + 3] = 255; });
    // Half white in linear light is about 188 in sRGB, not 128.
    expect(halveImage(checker, 2, 2, true).data[0]).toBeGreaterThan(180);
    expect(halveImage(checker, 2, 2, false).data[0]).toBe(128);
  });

  it('makes the whole chain down to one pixel', () => {
    const levels = compressMipChain(photo(32, 16), 32, 16, 'bc1', true);
    expect(levels.map(level => [level.width, level.height])).toEqual([[32, 16], [16, 8], [8, 4], [4, 2], [2, 1], [1, 1]]);
    levels.forEach(level => expect(level.data.length).toBe(Math.ceil(level.width / 4) * Math.ceil(level.height / 4) * 8));
  });
});

describe('normal maps (BC5)', () => {
  /** A bumpy tangent-space normal map: unit directions, mostly facing out. */
  const bumps = (size: number) => {
    const rgba = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const nx = Math.sin(x / 5) * 0.4, ny = Math.cos(y / 7) * 0.3;
        const nz = Math.sqrt(1 - nx * nx - ny * ny);
        const i = (y * size + x) * 4;
        rgba.set([Math.round((nx + 1) * 127.5), Math.round((ny + 1) * 127.5), Math.round((nz + 1) * 127.5), 255], i);
      }
    }
    return rgba;
  };
  const direction = (rgba: Uint8Array, i: number, rebuildZ: boolean) => {
    const x = rgba[i] / 127.5 - 1, y = rgba[i + 1] / 127.5 - 1;
    const z = rebuildZ ? Math.sqrt(Math.max(0, 1 - x * x - y * y)) : rgba[i + 2] / 127.5 - 1;
    const length = Math.hypot(x, y, z) || 1;
    return [x / length, y / length, z / length];
  };

  it('keeps the directions to within a degree or so, the third rebuilt from the two kept', () => {
    const map = bumps(64);
    const blocks = encodeBlocks(map, 64, 64, 'bc5');
    expect(blocks.length * 4).toBe(map.length);
    const decoded = decodeBlocks(blocks, 64, 64, 'bc5');
    let worst = 0, total = 0;
    for (let i = 0; i < map.length; i += 4) {
      const a = direction(map, i, false), b = direction(decoded, i, true);
      const angle = Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180 / Math.PI;
      worst = Math.max(worst, angle);
      total += angle;
    }
    expect(total / (map.length / 4)).toBeLessThan(1);
    expect(worst).toBeLessThan(4);
  });

  it('averages normals as directions in its mip levels', () => {
    const level = halveNormals(bumps(8), 8, 8);
    for (let i = 0; i < level.data.length; i += 4) {
      const [x, y, z] = [level.data[i], level.data[i + 1], level.data[i + 2]].map(value => value / 127.5 - 1);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 1);
    }
    expect(compressMipChain(bumps(16), 16, 16, 'bc5', false).map(l => l.data.length)).toEqual([256, 64, 16, 16, 16]);
  });
});

describe('rebuilding normals in the shader', () => {
  it('finds the line that reads a tangent-space normal in three.js, to replace it', () => {
    expect(THREE.ShaderChunk.normal_fragment_maps).toContain(NORMAL_READ);
  });
});
