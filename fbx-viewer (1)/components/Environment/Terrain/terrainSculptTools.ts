import { brushMask, gridRectOf, type TerrainBrushStamp, type TerrainEditGrid, type TerrainGridRect } from './terrainBrush';

/**
 * TERRAIN SCULPT TOOLS
 *
 * What each sculpting tool does to a terrain's heights. Brush tools run every frame the button is
 * held, scaled by the frame's time, so holding still keeps working and the result does not depend on
 * the frame rate. Discrete tools (ramp, mirror, paste) run once. Heights are in the plane's local
 * height units; `metres` converts from world metres on a terrain scaled upright.
 */

export interface TerrainHeightGrid extends TerrainEditGrid {
  heights: Float32Array;
}

export type FlattenMode = 'both' | 'raise' | 'lower';
export type NoiseMode = 'both' | 'raise' | 'lower';
export type PasteMode = 'both' | 'raise' | 'lower';

export interface HeightToolContext {
  grid: TerrainHeightGrid;
  stamp: TerrainBrushStamp;
  /** 0-1. */
  strength: number;
  /** Seconds this application stands for. */
  dt: number;
  /** Shift held: the tool's opposite. */
  invert: boolean;
  /** Local height units per world metre upward. */
  metres: number;
}

export interface FlattenOptions {
  mode: FlattenMode;
  /** The height it levels to, in local units. */
  target: number;
  /** Local height change per local unit along x and y: levels to a sloped plane through the target at the origin point. */
  slopeX?: number;
  slopeY?: number;
  originX?: number;
  originY?: number;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const sampleX = (grid: TerrainEditGrid, column: number): number => (column * grid.width) / (grid.columns - 1) - grid.width / 2;
const sampleY = (grid: TerrainEditGrid, row: number): number => grid.depth / 2 - (row * grid.depth) / (grid.rows - 1);

/** Bilinear height at plane-local (x, y); clamped to the terrain. */
export const heightAt = (grid: TerrainHeightGrid, x: number, y: number): number => {
  const fx = Math.min(grid.columns - 1, Math.max(0, ((x + grid.width / 2) / grid.width) * (grid.columns - 1)));
  const fy = Math.min(grid.rows - 1, Math.max(0, ((grid.depth / 2 - y) / grid.depth) * (grid.rows - 1)));
  const c0 = Math.min(grid.columns - 2, Math.floor(fx));
  const r0 = Math.min(grid.rows - 2, Math.floor(fy));
  const tx = fx - c0;
  const ty = fy - r0;
  const { heights, columns } = grid;
  const top = heights[r0 * columns + c0] * (1 - tx) + heights[r0 * columns + c0 + 1] * tx;
  const bottom = heights[(r0 + 1) * columns + c0] * (1 - tx) + heights[(r0 + 1) * columns + c0 + 1] * tx;
  return top * (1 - ty) + bottom * ty;
};

/** Height change per local unit along x and y at plane-local (x, y). */
export const slopeAt = (grid: TerrainHeightGrid, x: number, y: number): { x: number; y: number } => {
  const stepX = grid.width / (grid.columns - 1);
  const stepY = grid.depth / (grid.rows - 1);
  return {
    x: (heightAt(grid, x + stepX, y) - heightAt(grid, x - stepX, y)) / (2 * stepX),
    y: (heightAt(grid, x, y + stepY) - heightAt(grid, x, y - stepY)) / (2 * stepY),
  };
};

/**
 * Sculpt: raises under the brush, lowers with Shift. At full strength it rises 10 metres a second
 * under a small brush, faster under a large one, so a large brush can still shape a large hill.
 */
export const applySculpt = ({ grid, stamp, strength, dt, invert, metres }: HeightToolContext): TerrainGridRect | null => {
  const mask = brushMask(grid, stamp);
  if (!mask) return null;
  const worldRadius = Math.max(stamp.radiusX, stamp.radiusY) * metres;
  const rate = strength * 10 * (0.5 + Math.min(4, worldRadius / 40)) * dt * metres * (invert ? -1 : 1);
  const { rect, weights } = mask;
  const { heights, columns } = grid;
  for (let row = rect.r0, slot = 0; row <= rect.r1; row++) {
    const base = row * columns;
    for (let column = rect.c0; column <= rect.c1; column++, slot++) {
      const weight = weights[slot];
      if (weight > 0) heights[base + column] += rate * weight;
    }
  }
  return rect;
};

let blurA = new Float32Array(1024);
let blurB = new Float32Array(1024);

/** Blurs `rect` of the heights with two passes of a box `kernel` samples each way into blurA, row by row over the rectangle. */
const blurredHeights = (grid: TerrainHeightGrid, rect: TerrainGridRect, kernel: number): { values: Float32Array; x0: number; y0: number; w: number; h: number } => {
  const pad = kernel * 2;
  const x0 = Math.max(0, rect.c0 - pad);
  const x1 = Math.min(grid.columns - 1, rect.c1 + pad);
  const y0 = Math.max(0, rect.r0 - pad);
  const y1 = Math.min(grid.rows - 1, rect.r1 + pad);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (blurA.length < w * h) {
    blurA = new Float32Array(Math.ceil(w * h * 1.5));
    blurB = new Float32Array(blurA.length);
  }
  for (let y = 0; y < h; y++) blurA.set(grid.heights.subarray((y0 + y) * grid.columns + x0, (y0 + y) * grid.columns + x0 + w), y * w);
  const horizontal = (from: Float32Array, to: Float32Array) => {
    for (let y = 0; y < h; y++) {
      let sum = 0;
      for (let i = -kernel; i <= kernel; i++) sum += from[y * w + Math.min(w - 1, Math.max(0, i))];
      for (let x = 0; x < w; x++) {
        to[y * w + x] = sum / (kernel * 2 + 1);
        sum += from[y * w + Math.min(w - 1, x + kernel + 1)] - from[y * w + Math.max(0, x - kernel)];
      }
    }
  };
  const vertical = (from: Float32Array, to: Float32Array) => {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let i = -kernel; i <= kernel; i++) sum += from[Math.min(h - 1, Math.max(0, i)) * w + x];
      for (let y = 0; y < h; y++) {
        to[y * w + x] = sum / (kernel * 2 + 1);
        sum += from[Math.min(h - 1, y + kernel + 1) * w + x] - from[Math.max(0, y - kernel) * w + x];
      }
    }
  };
  horizontal(blurA, blurB);
  vertical(blurB, blurA);
  horizontal(blurA, blurB);
  vertical(blurB, blurA);
  return { values: blurA, x0, y0, w, h };
};

/** Smooth: eases each sample towards the average of the samples around it, `kernel` samples each way. */
export const applySmooth = ({ grid, stamp, strength, dt }: HeightToolContext, kernel: number): TerrainGridRect | null => {
  const mask = brushMask(grid, stamp);
  if (!mask) return null;
  const { rect, weights } = mask;
  const blurred = blurredHeights(grid, rect, Math.max(1, Math.round(kernel)));
  const rate = 1 - Math.exp(-strength * 14 * dt);
  const { heights, columns } = grid;
  for (let row = rect.r0, slot = 0; row <= rect.r1; row++) {
    for (let column = rect.c0; column <= rect.c1; column++, slot++) {
      const weight = weights[slot] * rate;
      if (weight <= 0) continue;
      const index = row * columns + column;
      heights[index] += (blurred.values[(row - blurred.y0) * blurred.w + column - blurred.x0] - heights[index]) * weight;
    }
  }
  return rect;
};

/** Flatten: eases towards a height, or a slope through it, only upward or only downward if asked. */
export const applyFlatten = ({ grid, stamp, strength, dt, invert }: HeightToolContext, options: FlattenOptions): TerrainGridRect | null => {
  const mask = brushMask(grid, stamp);
  if (!mask) return null;
  const { rect, weights } = mask;
  const rate = 1 - Math.exp(-strength * 10 * dt);
  const { heights, columns } = grid;
  const { target, slopeX = 0, slopeY = 0, originX = 0, originY = 0 } = options;
  const mode: FlattenMode = invert ? (options.mode === 'raise' ? 'lower' : options.mode === 'lower' ? 'raise' : 'both') : options.mode;
  const sloped = slopeX !== 0 || slopeY !== 0;
  for (let row = rect.r0, slot = 0; row <= rect.r1; row++) {
    const py = sampleY(grid, row);
    for (let column = rect.c0; column <= rect.c1; column++, slot++) {
      const weight = weights[slot] * rate;
      if (weight <= 0) continue;
      const index = row * columns + column;
      const goal = sloped ? target + (sampleX(grid, column) - originX) * slopeX + (py - originY) * slopeY : target;
      const change = goal - heights[index];
      if ((mode === 'raise' && change < 0) || (mode === 'lower' && change > 0)) continue;
      heights[index] += change * weight;
    }
  }
  return rect;
};

const hash2 = (x: number, y: number, seed: number): number => {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

const valueNoise = (x: number, y: number, seed: number): number => {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a + (a - b - c + d) * sx) * sy;
};

/** Four octaves of value noise, -1 to 1. */
export const fractalNoise = (x: number, y: number, seed: number): number => {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  for (let octave = 0; octave < 4; octave++) {
    value += (valueNoise(x * frequency, y * frequency, seed + octave * 17) * 2 - 1) * amplitude;
    amplitude *= 0.5;
    frequency *= 2.03;
  }
  return value / 0.9375;
};

/** Noise: roughens the ground with hills `scale` metres across, both ways or only up or down. */
export const applyNoise = ({ grid, stamp, strength, dt, invert, metres }: HeightToolContext, scale: number, mode: NoiseMode): TerrainGridRect | null => {
  const mask = brushMask(grid, stamp);
  if (!mask) return null;
  const { rect, weights } = mask;
  const size = Math.max(0.01, scale) * metres;
  const rate = strength * 8 * dt * metres * (invert ? -1 : 1);
  const { heights, columns } = grid;
  for (let row = rect.r0, slot = 0; row <= rect.r1; row++) {
    const py = sampleY(grid, row);
    for (let column = rect.c0; column <= rect.c1; column++, slot++) {
      const weight = weights[slot];
      if (weight <= 0) continue;
      const value = fractalNoise(sampleX(grid, column) / size, py / size, 7);
      const shaped = mode === 'both' ? value : mode === 'raise' ? Math.abs(value) : -Math.abs(value);
      heights[row * columns + column] += shaped * rate * weight;
    }
  }
  return rect;
};

/** Terrace: pulls the ground to steps `step` metres apart; `sharpness` 1 makes hard ledges, 0 soft ones. */
export const applyTerrace = ({ grid, stamp, strength, dt, metres }: HeightToolContext, step: number, sharpness: number): TerrainGridRect | null => {
  const mask = brushMask(grid, stamp);
  if (!mask) return null;
  const { rect, weights } = mask;
  const stepHeight = Math.max(0.01, step) * metres;
  const rate = 1 - Math.exp(-strength * 8 * dt);
  const hardness = 1 + clamp01(sharpness) * 7;
  const { heights, columns } = grid;
  for (let row = rect.r0, slot = 0; row <= rect.r1; row++) {
    for (let column = rect.c0; column <= rect.c1; column++, slot++) {
      const weight = weights[slot] * rate;
      if (weight <= 0) continue;
      const index = row * columns + column;
      const level = heights[index] / stepHeight;
      const base = Math.floor(level);
      const t = level - base;
      // Stays on the ledge and climbs steeply to the next, as sharply as asked.
      const shaped = t < 0.5 ? 0.5 * Math.pow(2 * t, hardness) : 1 - 0.5 * Math.pow(2 * (1 - t), hardness);
      heights[index] += ((base + shaped) * stepHeight - heights[index]) * weight;
    }
  }
  return rect;
};

const NEIGHBOUR_COLUMNS = [-1, 0, 1, -1, 1, -1, 0, 1];
const NEIGHBOUR_ROWS = [-1, -1, -1, 0, 0, 1, 1, 1];
/** The four neighbours that share an edge. */
const EDGE_NEIGHBOURS = [1, 3, 4, 6];

/** A copy of `rect` grown by `pad`, with where it sits; shared between calls. */
let workHeights = new Float32Array(1024);
let workDelta = new Float32Array(1024);
let workWater = new Float32Array(1024);
let workSediment = new Float32Array(1024);

const prepareWork = (grid: TerrainHeightGrid, rect: TerrainGridRect, pad: number) => {
  const x0 = Math.max(0, rect.c0 - pad);
  const x1 = Math.min(grid.columns - 1, rect.c1 + pad);
  const y0 = Math.max(0, rect.r0 - pad);
  const y1 = Math.min(grid.rows - 1, rect.r1 + pad);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const count = w * h;
  if (workHeights.length < count) {
    const size = Math.ceil(count * 1.5);
    workHeights = new Float32Array(size);
    workDelta = new Float32Array(size);
    workWater = new Float32Array(size);
    workSediment = new Float32Array(size);
  }
  for (let y = 0; y < h; y++) workHeights.set(grid.heights.subarray((y0 + y) * grid.columns + x0, (y0 + y) * grid.columns + x0 + w), y * w);
  return { x0, y0, w, h };
};

/** Writes the worked heights back, blended by the brush and the tool's strength. */
const blendWork = (grid: TerrainHeightGrid, rect: TerrainGridRect, weights: Float32Array, area: { x0: number; y0: number; w: number }, blend: number): void => {
  const { heights, columns } = grid;
  for (let row = rect.r0, slot = 0; row <= rect.r1; row++) {
    for (let column = rect.c0; column <= rect.c1; column++, slot++) {
      const weight = weights[slot] * blend;
      if (weight <= 0) continue;
      const index = row * columns + column;
      heights[index] += (workHeights[(row - area.y0) * area.w + column - area.x0] - heights[index]) * weight;
    }
  }
};

/** Holes: cuts the cells under the brush out of the terrain, or fills them with Shift. */
export const applyHoles = (grid: TerrainEditGrid, stamp: TerrainBrushStamp, invert: boolean, mark: (rect: TerrainGridRect, weights: Float32Array, cut: boolean) => boolean): boolean => {
  const mask = brushMask(grid, stamp);
  return mask ? mark(mask.rect, mask.weights, !invert) : false;
};

export interface ErosionOptions {
  /** Metres of height a sample may stand above a neighbour before it slumps. */
  threshold: number;
  /** Metres that can move off a sample in one pass. */
  thickness: number;
  iterations: number;
}

/** Erosion: material slumps down slopes steeper than the threshold, as weathered ground does. */
export const applyErosion = ({ grid, stamp, strength, dt, metres }: HeightToolContext, options: ErosionOptions): TerrainGridRect | null => {
  const mask = brushMask(grid, stamp);
  if (!mask) return null;
  const { rect, weights } = mask;
  const area = prepareWork(grid, rect, 2);
  const { w, h } = area;
  const talus = Math.max(0, options.threshold) * metres;
  const limit = Math.max(1e-4, options.thickness) * metres;
  const iterations = Math.max(1, Math.min(32, Math.round(options.iterations)));
  for (let iteration = 0; iteration < iterations; iteration++) {
    workDelta.fill(0, 0, w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const index = y * w + x;
        const here = workHeights[index];
        let total = 0;
        let largest = 0;
        for (let n = 0; n < 8; n++) {
          const drop = here - workHeights[index + NEIGHBOUR_ROWS[n] * w + NEIGHBOUR_COLUMNS[n]] - talus;
          if (drop > 0) {
            total += drop;
            if (drop > largest) largest = drop;
          }
        }
        if (total <= 0) continue;
        const moved = Math.min(largest * 0.5, limit);
        workDelta[index] -= moved;
        for (let n = 0; n < 8; n++) {
          const neighbour = index + NEIGHBOUR_ROWS[n] * w + NEIGHBOUR_COLUMNS[n];
          const drop = here - workHeights[neighbour] - talus;
          if (drop > 0) workDelta[neighbour] += (moved * drop) / total;
        }
      }
    }
    for (let index = 0; index < w * h; index++) workHeights[index] += workDelta[index];
  }
  blendWork(grid, rect, weights, area, 1 - Math.exp(-strength * 12 * dt));
  return rect;
};

export interface HydroOptions {
  /** How much rain falls in a pass. */
  rain: number;
  /** How much a given flow of water can carry. */
  sediment: number;
  iterations: number;
}

/**
 * Hydro erosion: rain runs downhill, cutting channels and dropping what it carries where it slows.
 * Water spreads between neighbouring samples by the drop of ground plus water.
 */
export const applyHydroErosion = ({ grid, stamp, strength, dt, metres }: HeightToolContext, options: HydroOptions): TerrainGridRect | null => {
  const mask = brushMask(grid, stamp);
  if (!mask) return null;
  const { rect, weights } = mask;
  const area = prepareWork(grid, rect, 2);
  const { w, h } = area;
  const count = w * h;
  workWater.fill(0, 0, count);
  workSediment.fill(0, 0, count);
  const rain = Math.max(0.0001, options.rain) * metres * 0.05;
  const capacity = Math.max(0.0001, options.sediment);
  const iterations = Math.max(1, Math.min(64, Math.round(options.iterations)));
  const evaporation = 0.92;
  for (let iteration = 0; iteration < iterations; iteration++) {
    if (iteration < iterations / 2) {
      for (let index = 0; index < count; index++) workWater[index] += rain;
    }
    workDelta.fill(0, 0, count);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const index = y * w + x;
        const water = workWater[index];
        if (water <= 1e-6) continue;
        const surface = workHeights[index] + water;
        let total = 0;
        for (const n of EDGE_NEIGHBOURS) {
          const neighbour = index + NEIGHBOUR_ROWS[n] * w + NEIGHBOUR_COLUMNS[n];
          const drop = surface - workHeights[neighbour] - workWater[neighbour];
          if (drop > 0) total += drop;
        }
        if (total <= 0) continue;
        const outflow = Math.min(water, total * 0.5);
        for (const n of EDGE_NEIGHBOURS) {
          const neighbour = index + NEIGHBOUR_ROWS[n] * w + NEIGHBOUR_COLUMNS[n];
          const drop = surface - workHeights[neighbour] - workWater[neighbour];
          if (drop <= 0) continue;
          const share = (outflow * drop) / total;
          workDelta[neighbour] += share;
          const carried = water > 0 ? (workSediment[index] * share) / water : 0;
          workSediment[neighbour] += carried;
          workSediment[index] -= carried;
        }
        workDelta[index] -= outflow;
        // What this flow can carry grows with how much runs and how steep it is.
        const carry = capacity * outflow * Math.min(4, total / Math.max(1e-4, metres));
        const difference = carry - workSediment[index];
        const exchange = difference * (difference > 0 ? 0.1 : 0.3);
        workHeights[index] -= exchange;
        workSediment[index] += exchange;
      }
    }
    for (let index = 0; index < count; index++) workWater[index] = (workWater[index] + workDelta[index]) * evaporation;
  }
  // Whatever is still being carried settles where it is.
  for (let index = 0; index < count; index++) workHeights[index] += workSediment[index];
  blendWork(grid, rect, weights, area, 1 - Math.exp(-strength * 8 * dt));
  return rect;
};

export interface RampOptions {
  start: { x: number; y: number; z: number };
  end: { x: number; y: number; z: number };
  /** Full width of the flat top, in local units. */
  width: number;
  /** Fraction of the half width over which the sides blend back into the ground. */
  sideFalloff: number;
}

/** Ramp: a straight road of ground between two points, its sides blending back into the terrain. */
export const applyRamp = (grid: TerrainHeightGrid, { start, end, width, sideFalloff }: RampOptions): TerrainGridRect | null => {
  const half = Math.max(1e-3, width / 2);
  const blend = half * Math.max(0, sideFalloff) * 2;
  const reach = half + blend;
  const rect = gridRectOf(grid,
    (start.x + end.x) / 2, (start.y + end.y) / 2,
    Math.abs(end.x - start.x) / 2 + reach, Math.abs(end.y - start.y) / 2 + reach);
  if (!rect) return null;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < 1e-6) return null;
  const { heights, columns } = grid;
  for (let row = rect.r0; row <= rect.r1; row++) {
    const py = sampleY(grid, row);
    for (let column = rect.c0; column <= rect.c1; column++) {
      const px = sampleX(grid, column);
      const t = ((px - start.x) * dx + (py - start.y) * dy) / lengthSq;
      if (t < -reach / Math.sqrt(lengthSq) || t > 1 + reach / Math.sqrt(lengthSq)) continue;
      const along = Math.min(1, Math.max(0, t));
      const distance = Math.hypot(px - (start.x + dx * along), py - (start.y + dy * along));
      if (distance >= reach) continue;
      const side = distance <= half || blend <= 0 ? 1 : 1 - (distance - half) / blend;
      const weight = side * side * (3 - 2 * side);
      const index = row * columns + column;
      const goal = start.z + (end.z - start.z) * along;
      heights[index] += (goal - heights[index]) * weight;
    }
  }
  return rect;
};

/** Which half is copied onto which: "x-to-plus" copies the -X half onto the +X half. Y is along the rows, world +Z. */
export type MirrorOperation = 'x-to-plus' | 'x-to-minus' | 'y-to-plus' | 'y-to-minus' | 'x-turn' | 'y-turn';

/**
 * Mirror: copies one half of the terrain onto the other about a line through the terrain, `offset`
 * local units along the rows or columns from its centre, or turns the copy half way round ("turn"),
 * for symmetric maps. `blend` local units either side of the line ease between the two.
 */
export const applyMirror = (grid: TerrainHeightGrid, operation: MirrorOperation, offset: number, blend: number): TerrainGridRect => {
  const source = grid.heights.slice();
  const lengthwise = operation.startsWith('x');
  const span = lengthwise ? grid.width : grid.depth;
  const samples = lengthwise ? grid.columns : grid.rows;
  const cell = span / (samples - 1);
  const line = (offset + span / 2) / cell;
  const copyFromPlus = operation === 'x-to-minus' || operation === 'y-to-minus' || operation === 'x-turn' || operation === 'y-turn';
  const turn = operation === 'x-turn' || operation === 'y-turn';
  const blendCells = Math.max(0, blend) / cell;
  const { heights, columns, rows } = grid;
  const read = (column: number, row: number) => {
    const fx = Math.min(columns - 1, Math.max(0, column));
    const fy = Math.min(rows - 1, Math.max(0, row));
    const c0 = Math.min(columns - 2, Math.floor(fx));
    const r0 = Math.min(rows - 2, Math.floor(fy));
    const tx = fx - c0;
    const ty = fy - r0;
    const top = source[r0 * columns + c0] * (1 - tx) + source[r0 * columns + c0 + 1] * tx;
    const bottom = source[(r0 + 1) * columns + c0] * (1 - tx) + source[(r0 + 1) * columns + c0 + 1] * tx;
    return top * (1 - ty) + bottom * ty;
  };
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const along = lengthwise ? column : row;
      const past = copyFromPlus ? line - along : along - line;
      if (past < -blendCells) continue;
      const mirrored = 2 * line - along;
      const across = lengthwise ? row : column;
      const acrossFrom = turn ? (lengthwise ? rows - 1 : columns - 1) - across : across;
      const value = lengthwise ? read(mirrored, acrossFrom) : read(acrossFrom, mirrored);
      const t = blendCells > 0 ? clamp01((past + blendCells) / (2 * blendCells)) : 1;
      const weight = t * t * (3 - 2 * t);
      const index = row * columns + column;
      heights[index] = source[index] + (value - source[index]) * weight;
    }
  }
  return { c0: 0, r0: 0, c1: columns - 1, r1: rows - 1 };
};

/** Heights copied off a terrain to paste elsewhere: relative to their lowest sample, in world metres. */
export interface TerrainClip {
  columns: number;
  rows: number;
  /** Metres one sample apart on the terrain they came from. */
  cellX: number;
  cellY: number;
  values: Float32Array;
  /** The height the values are relative to, in world metres. */
  base: number;
}

export const copyRegion = (grid: TerrainHeightGrid, rect: TerrainGridRect, metres: number, scaleX: number, scaleY: number): TerrainClip => {
  const columns = rect.c1 - rect.c0 + 1;
  const rows = rect.r1 - rect.r0 + 1;
  const values = new Float32Array(columns * rows);
  let lowest = Infinity;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const value = grid.heights[(rect.r0 + row) * grid.columns + rect.c0 + column] / metres;
      values[row * columns + column] = value;
      if (value < lowest) lowest = value;
    }
  }
  for (let index = 0; index < values.length; index++) values[index] -= lowest;
  return {
    columns, rows, values, base: lowest,
    cellX: (grid.width / (grid.columns - 1)) * scaleX,
    cellY: (grid.depth / (grid.rows - 1)) * scaleY,
  };
};

export interface PasteOptions {
  /** Where the middle of the clip lands, in plane-local units. */
  x: number;
  y: number;
  /** Degrees the clip is turned by. */
  rotation: number;
  /** Local units per world metre across the plane. */
  metresX: number;
  metresY: number;
  /** Local height units per world metre. */
  metres: number;
  /** Local height the clip's lowest sample sits at. */
  floor: number;
  /** Fraction of each side over which it blends into the ground. */
  edge: number;
  mode: PasteMode;
}

/** Stamps a copied clip into the terrain, blending at its edges. */
export const pasteClip = (grid: TerrainHeightGrid, clip: TerrainClip, options: PasteOptions): TerrainGridRect | null => {
  const { x, y, metresX, metresY, metres, floor, mode } = options;
  const halfX = ((clip.columns - 1) * clip.cellX * metresX) / 2;
  const halfY = ((clip.rows - 1) * clip.cellY * metresY) / 2;
  const reach = Math.hypot(halfX, halfY);
  const rect = gridRectOf(grid, x, y, reach, reach);
  if (!rect) return null;
  const angle = (options.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const edge = Math.max(0.001, Math.min(0.5, options.edge));
  const { heights, columns } = grid;
  for (let row = rect.r0; row <= rect.r1; row++) {
    const py = sampleY(grid, row) - y;
    for (let column = rect.c0; column <= rect.c1; column++) {
      const px = sampleX(grid, column) - x;
      const u = (px * cos + py * sin) / (halfX * 2) + 0.5;
      const v = 0.5 - (-px * sin + py * cos) / (halfY * 2);
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const fx = u * (clip.columns - 1);
      const fy = v * (clip.rows - 1);
      const c0 = Math.min(clip.columns - 2, Math.floor(fx));
      const r0 = Math.min(clip.rows - 2, Math.floor(fy));
      const tx = fx - c0;
      const ty = fy - r0;
      const top = clip.values[r0 * clip.columns + c0] * (1 - tx) + clip.values[r0 * clip.columns + c0 + 1] * tx;
      const bottom = clip.values[(r0 + 1) * clip.columns + c0] * (1 - tx) + clip.values[(r0 + 1) * clip.columns + c0 + 1] * tx;
      const value = floor + (top * (1 - ty) + bottom * ty) * metres;
      const near = Math.min(Math.min(u, 1 - u), Math.min(v, 1 - v)) / edge;
      const t = clamp01(near);
      const weight = t * t * (3 - 2 * t);
      const index = row * columns + column;
      const change = value - heights[index];
      if ((mode === 'raise' && change < 0) || (mode === 'lower' && change > 0)) continue;
      heights[index] += change * weight;
    }
  }
  return rect;
};
