/**
 * TERRAIN BRUSH
 *
 * The brush every terrain tool shares: a size, a falloff and a shape, turned into a mask of weights
 * over the grid samples under it. Everything here works in the terrain plane's local units: x across
 * the width, y across the depth with row 0 at +depth/2, the same layout as THREE.PlaneGeometry.
 */

export type TerrainBrushFalloff = 'smooth' | 'linear' | 'spherical' | 'tip';
/** Circle: round, with a falloff. Stamp: a picture stretched over the brush. Pattern: a picture tiled over the terrain, seen through the circle. */
export type TerrainBrushShape = 'circle' | 'stamp' | 'pattern';

/** A picture a stamp or pattern brush reads its strength from: 0-1, row 0 at the top of the picture. */
export interface TerrainBrushPicture {
  width: number;
  height: number;
  data: Float32Array;
}

/** Inclusive rectangle of grid samples. */
export interface TerrainGridRect {
  c0: number;
  r0: number;
  c1: number;
  r1: number;
}

export interface TerrainEditGrid {
  /** Samples per side. */
  columns: number;
  rows: number;
  width: number;
  depth: number;
}

export interface TerrainBrushStamp {
  /** Centre in the plane's local units. */
  x: number;
  y: number;
  /** Half-size along x and y in local units: they differ on a terrain scaled unevenly. */
  radiusX: number;
  radiusY: number;
  /** 0: the whole radius is full strength. 1: strength fades from the very centre. */
  falloff: number;
  falloffType: TerrainBrushFalloff;
  shape: TerrainBrushShape;
  picture?: TerrainBrushPicture | null;
  /** Degrees the stamp or pattern is turned by. */
  rotation?: number;
  /** Local units one tile of a pattern covers. */
  patternSize?: number;
}

/** The weight of a sample `t` of the way through the falloff band (0 inner edge, 1 outer edge). */
export const falloffCurve = (type: TerrainBrushFalloff, t: number): number => {
  const s = Math.min(1, Math.max(0, t));
  switch (type) {
    case 'linear': return 1 - s;
    case 'spherical': return Math.sqrt(Math.max(0, 1 - s * s));
    case 'tip': return 1 - Math.sqrt(Math.max(0, 1 - (1 - s) * (1 - s)));
    case 'smooth':
    default: return 1 - s * s * (3 - 2 * s);
  }
};

/** Bilinear lookup of a picture, wrapping when `wrap`, else 0 outside it. */
export const samplePicture = (picture: TerrainBrushPicture, u: number, v: number, wrap: boolean): number => {
  const { width, height, data } = picture;
  if (!wrap && (u < 0 || u > 1 || v < 0 || v > 1)) return 0;
  const fx = (wrap ? u - Math.floor(u) : u) * (width - 1);
  const fy = (wrap ? v - Math.floor(v) : v) * (height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = wrap ? (x0 + 1) % width : Math.min(width - 1, x0 + 1);
  const y1 = wrap ? (y0 + 1) % height : Math.min(height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const top = data[y0 * width + x0] * (1 - tx) + data[y0 * width + x1] * tx;
  const bottom = data[y1 * width + x0] * (1 - tx) + data[y1 * width + x1] * tx;
  return top * (1 - ty) + bottom * ty;
};

/** The samples a rectangle of local units covers, clipped to the grid; null when it misses. */
export const gridRectOf = (grid: TerrainEditGrid, x: number, y: number, radiusX: number, radiusY: number, padding = 0): TerrainGridRect | null => {
  const cellX = grid.width / (grid.columns - 1);
  const cellY = grid.depth / (grid.rows - 1);
  const c0 = Math.max(0, Math.ceil((x - radiusX + grid.width / 2) / cellX) - padding);
  const c1 = Math.min(grid.columns - 1, Math.floor((x + radiusX + grid.width / 2) / cellX) + padding);
  const r0 = Math.max(0, Math.ceil((grid.depth / 2 - y - radiusY) / cellY) - padding);
  const r1 = Math.min(grid.rows - 1, Math.floor((grid.depth / 2 - y + radiusY) / cellY) + padding);
  return c0 > c1 || r0 > r1 ? null : { c0, r0, c1, r1 };
};

export const unionRect = (a: TerrainGridRect | null, b: TerrainGridRect | null): TerrainGridRect | null => {
  if (!a) return b;
  if (!b) return a;
  return { c0: Math.min(a.c0, b.c0), r0: Math.min(a.r0, b.r0), c1: Math.max(a.c1, b.c1), r1: Math.max(a.r1, b.r1) };
};

export interface TerrainBrushMask {
  rect: TerrainGridRect;
  /** Row by row over the rectangle; shared between calls, so read it before the next one. */
  weights: Float32Array;
  /** Samples across the rectangle. */
  stride: number;
}

let scratchMask = new Float32Array(1024);

/** The brush's weight (0-1) at every sample under it; null when it is off the terrain. */
export const brushMask = (grid: TerrainEditGrid, stamp: TerrainBrushStamp): TerrainBrushMask | null => {
  const { x, y, radiusX, radiusY, shape, picture } = stamp;
  if (!(radiusX > 0) || !(radiusY > 0)) return null;
  const rect = gridRectOf(grid, x, y, radiusX, radiusY);
  if (!rect) return null;
  const stride = rect.c1 - rect.c0 + 1;
  const count = stride * (rect.r1 - rect.r0 + 1);
  if (scratchMask.length < count) scratchMask = new Float32Array(Math.ceil(count * 1.5));
  const weights = scratchMask;
  const cellX = grid.width / (grid.columns - 1);
  const cellY = grid.depth / (grid.rows - 1);
  const band = Math.min(1, Math.max(0, stamp.falloff));
  const inner = 1 - band;
  const angle = ((stamp.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const patternSize = Math.max(1e-3, stamp.patternSize ?? radiusX * 2);
  const stamped = shape === 'stamp' && Boolean(picture);
  const patterned = shape === 'pattern' && Boolean(picture);
  let slot = 0;
  for (let row = rect.r0; row <= rect.r1; row++) {
    const py = grid.depth / 2 - row * cellY;
    const dy = (py - y) / radiusY;
    for (let column = rect.c0; column <= rect.c1; column++, slot++) {
      const px = column * cellX - grid.width / 2;
      const dx = (px - x) / radiusX;
      if (stamped) {
        // The picture fills the brush's square, turned about its centre.
        const u = (dx * cos + dy * sin) * 0.5 + 0.5;
        const v = 0.5 - (-dx * sin + dy * cos) * 0.5;
        weights[slot] = samplePicture(picture!, u, v, false);
        continue;
      }
      const t = Math.sqrt(dx * dx + dy * dy);
      if (t >= 1) {
        weights[slot] = 0;
        continue;
      }
      let weight = t <= inner || band === 0 ? 1 : falloffCurve(stamp.falloffType, (t - inner) / band);
      if (patterned) {
        const u = (px * cos + py * sin) / patternSize;
        const v = (-px * sin + py * cos) / patternSize;
        weight *= samplePicture(picture!, u, -v, true);
      }
      weights[slot] = weight;
    }
  }
  return { rect, weights, stride };
};

/** Reads a loaded image into a brush picture: its brightness, at most `limit` samples a side. */
export const pictureFromImage = (image: CanvasImageSource & { width: number; height: number }, limit = 512): TerrainBrushPicture => {
  const scale = Math.min(1, limit / Math.max(image.width, image.height, 1));
  const width = Math.max(2, Math.round(image.width * scale));
  const height = Math.max(2, Math.round(image.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('A 2D canvas is not available');
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const data = new Float32Array(width * height);
  for (let index = 0; index < data.length; index++) {
    data[index] = (pixels[index * 4] * 0.2126 + pixels[index * 4 + 1] * 0.7152 + pixels[index * 4 + 2] * 0.0722) / 255 * (pixels[index * 4 + 3] / 255);
  }
  return { width, height, data };
};
