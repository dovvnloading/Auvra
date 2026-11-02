import { brushMask, type TerrainBrushStamp, type TerrainEditGrid, type TerrainGridRect } from './terrainBrush';
import { fractalNoise } from './terrainSculptTools';
import { MAX_TERRAIN_LAYERS, TERRAIN_SPLAT_CHANNELS } from './terrainSplatCodec';

/**
 * TERRAIN PAINT TOOLS
 *
 * What the paint tools do to a terrain's layer weights. A sample holds a weight per layer, in two RGBA
 * maps: `weights` for layers 0-3 and `weights2` for layers 4-7. Weights always add up to 255: painting one
 * layer in takes the others down in proportion, and taking one away gives its share to the others, or to
 * the base layer when nothing else is there.
 */

export interface TerrainWeightGrid extends TerrainEditGrid {
  weights: Uint8Array;
  /** Only there once a terrain has more than four layers. */
  weights2: Uint8Array | null;
  layerCount: number;
}

export interface WeightToolContext {
  grid: TerrainWeightGrid;
  stamp: TerrainBrushStamp;
  layer: number;
  strength: number;
  dt: number;
  invert: boolean;
}

const FULL = 255;
const scratch = new Float64Array(MAX_TERRAIN_LAYERS);
const rounded = new Int32Array(MAX_TERRAIN_LAYERS);

/** Reads a sample's weights as shares of 1 into `scratch`; a sample with none is all base layer. */
const readShares = (grid: TerrainWeightGrid, base: number): void => {
  const { weights, weights2 } = grid;
  let total = 0;
  for (let channel = 0; channel < TERRAIN_SPLAT_CHANNELS; channel++) {
    scratch[channel] = weights[base + channel];
    scratch[channel + TERRAIN_SPLAT_CHANNELS] = weights2 ? weights2[base + channel] : 0;
    total += scratch[channel] + scratch[channel + TERRAIN_SPLAT_CHANNELS];
  }
  if (total <= 0) {
    scratch.fill(0);
    scratch[0] = 1;
    return;
  }
  for (let channel = 0; channel < MAX_TERRAIN_LAYERS; channel++) scratch[channel] /= total;
};

/** Writes `scratch` back as bytes that add up to 255, the leftover going to `favoured`. True when a byte changed. */
const writeShares = (grid: TerrainWeightGrid, base: number, favoured: number): boolean => {
  const { weights, weights2 } = grid;
  let sum = 0;
  let largest = 0;
  for (let channel = 0; channel < MAX_TERRAIN_LAYERS; channel++) {
    rounded[channel] = Math.round(scratch[channel] * FULL);
    sum += rounded[channel];
    if (rounded[channel] > rounded[largest]) largest = channel;
  }
  const remainder = FULL - sum;
  if (remainder !== 0) {
    const target = rounded[favoured] + remainder >= 0 && rounded[favoured] + remainder <= FULL ? favoured : largest;
    rounded[target] += remainder;
  }
  let changed = false;
  for (let channel = 0; channel < TERRAIN_SPLAT_CHANNELS; channel++) {
    if (weights[base + channel] !== rounded[channel]) {
      weights[base + channel] = rounded[channel];
      changed = true;
    }
    if (weights2 && weights2[base + channel] !== rounded[channel + TERRAIN_SPLAT_CHANNELS]) {
      weights2[base + channel] = rounded[channel + TERRAIN_SPLAT_CHANNELS];
      changed = true;
    }
  }
  return changed;
};

/** Moves one layer's share of `scratch` to `next`; the others make room in proportion. */
const setShare = (layer: number, next: number, layerCount: number): void => {
  const value = Math.min(1, Math.max(0, next));
  const rest = 1 - scratch[layer];
  if (rest > 1e-6) {
    const scale = (1 - value) / rest;
    for (let channel = 0; channel < MAX_TERRAIN_LAYERS; channel++) {
      if (channel !== layer) scratch[channel] *= scale;
    }
  } else if (value < 1) {
    // This layer was all there was: what it gives up goes to the base, or to the next layer if it is the base.
    const heir = layer === 0 ? Math.min(1, layerCount - 1) : 0;
    if (heir === layer) return;
    scratch[heir] = 1 - value;
  }
  scratch[layer] = value;
};

/** Moves a sample `amount` (0-1) of the way to all this layer. */
export const blendSampleTowardsLayer = (grid: TerrainWeightGrid, sample: number, layer: number, amount: number): void => {
  const base = sample * TERRAIN_SPLAT_CHANNELS;
  readShares(grid, base);
  setShare(layer, scratch[layer] + (1 - scratch[layer]) * amount, grid.layerCount);
  writeShares(grid, base, layer);
};

/** A layer's weight (0-1) at a grid sample. */
export const layerWeightAt = (grid: TerrainWeightGrid, sample: number, layer: number): number => {
  readShares(grid, sample * TERRAIN_SPLAT_CHANNELS);
  return scratch[layer];
};

/** A layer's weight (0-1) at plane-local (x, y), from the nearest sample. */
export const layerWeightNear = (grid: TerrainWeightGrid, x: number, y: number, layer: number): number => {
  const column = Math.min(grid.columns - 1, Math.max(0, Math.round(((x + grid.width / 2) / grid.width) * (grid.columns - 1))));
  const row = Math.min(grid.rows - 1, Math.max(0, Math.round(((grid.depth / 2 - y) / grid.depth) * (grid.rows - 1))));
  return layerWeightAt(grid, row * grid.columns + column, layer);
};

/** Paint: eases the layer towards `target` under the brush. Shift takes it away. */
export const applyPaintLayer = ({ grid, stamp, layer, strength, dt, invert }: WeightToolContext, target: number): TerrainGridRect | null => {
  const mask = brushMask(grid, stamp);
  if (!mask) return null;
  const { rect, weights } = mask;
  const goal = invert ? 0 : target;
  const rate = strength * 9 * dt;
  let modified = false;
  for (let row = rect.r0, slot = 0; row <= rect.r1; row++) {
    for (let column = rect.c0; column <= rect.c1; column++, slot++) {
      const weight = weights[slot];
      if (weight <= 0) continue;
      const base = (row * grid.columns + column) * TERRAIN_SPLAT_CHANNELS;
      readShares(grid, base);
      const current = scratch[layer];
      const amount = 1 - Math.exp(-rate * weight);
      // Weights are bytes: below one step a slow stroke would never move, so it always moves a step.
      let next = current + (goal - current) * amount;
      if (Math.abs(next - current) < 1 / FULL && next !== goal) next = current + Math.sign(goal - current) / FULL;
      setShare(layer, next, grid.layerCount);
      if (writeShares(grid, base, layer)) modified = true;
    }
  }
  return modified ? rect : null;
};

/** Flatten: eases the layer towards the weight it had under the first click. */
export const applyFlattenLayer = (context: WeightToolContext, target: number): TerrainGridRect | null =>
  applyPaintLayer({ ...context, invert: false }, target);

/** Noise: eases the layer up or down in patches `scale` local units across, for broken-up edges. */
export const applyNoiseLayer = ({ grid, stamp, layer, strength, dt, invert }: WeightToolContext, scale: number): TerrainGridRect | null => {
  const mask = brushMask(grid, stamp);
  if (!mask) return null;
  const { rect, weights } = mask;
  const cellX = grid.width / (grid.columns - 1);
  const cellY = grid.depth / (grid.rows - 1);
  const size = Math.max(1e-3, scale);
  const rate = strength * 9 * dt * (invert ? -1 : 1);
  let modified = false;
  for (let row = rect.r0, slot = 0; row <= rect.r1; row++) {
    const py = grid.depth / 2 - row * cellY;
    for (let column = rect.c0; column <= rect.c1; column++, slot++) {
      const weight = weights[slot];
      if (weight <= 0) continue;
      const value = fractalNoise((column * cellX - grid.width / 2) / size, py / size, 11);
      const base = (row * grid.columns + column) * TERRAIN_SPLAT_CHANNELS;
      readShares(grid, base);
      setShare(layer, scratch[layer] + value * rate * weight, grid.layerCount);
      if (writeShares(grid, base, layer)) modified = true;
    }
  }
  return modified ? rect : null;
};

/** Smooth: eases the layer's weight towards its average around each sample, softening edges. */
export const applySmoothLayer = ({ grid, stamp, layer, strength, dt }: WeightToolContext, kernel: number): TerrainGridRect | null => {
  const mask = brushMask(grid, stamp);
  if (!mask) return null;
  const { rect, weights, stride } = mask;
  const reach = Math.max(1, Math.round(kernel));
  const height = rect.r1 - rect.r0 + 1;
  const source = new Float32Array(stride * height);
  const { columns, rows } = grid;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < stride; column++) {
      let sum = 0;
      let count = 0;
      for (let dy = -reach; dy <= reach; dy++) {
        const r = rect.r0 + row + dy;
        if (r < 0 || r >= rows) continue;
        for (let dx = -reach; dx <= reach; dx++) {
          const c = rect.c0 + column + dx;
          if (c < 0 || c >= columns) continue;
          sum += layerWeightAt(grid, r * columns + c, layer);
          count++;
        }
      }
      source[row * stride + column] = sum / count;
    }
  }
  const rate = 1 - Math.exp(-strength * 14 * dt);
  let modified = false;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < stride; column++) {
      const weight = weights[row * stride + column] * rate;
      if (weight <= 0) continue;
      const base = ((rect.r0 + row) * columns + rect.c0 + column) * TERRAIN_SPLAT_CHANNELS;
      readShares(grid, base);
      setShare(layer, scratch[layer] + (source[row * stride + column] - scratch[layer]) * weight, grid.layerCount);
      if (writeShares(grid, base, layer)) modified = true;
    }
  }
  return modified ? rect : null;
};

/** Every sample all this layer. */
export const fillLayer = (grid: TerrainWeightGrid, layer: number): void => {
  const count = grid.columns * grid.rows;
  for (let sample = 0; sample < count; sample++) {
    const base = sample * TERRAIN_SPLAT_CHANNELS;
    readShares(grid, base);
    setShare(layer, 1, grid.layerCount);
    writeShares(grid, base, layer);
  }
};

/** Every sample none of this layer: its share goes to the other layers there. */
export const clearLayer = (grid: TerrainWeightGrid, layer: number): void => {
  const count = grid.columns * grid.rows;
  for (let sample = 0; sample < count; sample++) {
    const base = sample * TERRAIN_SPLAT_CHANNELS;
    readShares(grid, base);
    setShare(layer, 0, grid.layerCount);
    writeShares(grid, base, 0);
  }
};

/** Sets a layer's weight at every sample from a grid of values 0-1 (an imported weight map). */
export const setLayerFromValues = (grid: TerrainWeightGrid, layer: number, values: ArrayLike<number>): void => {
  const count = grid.columns * grid.rows;
  for (let sample = 0; sample < count; sample++) {
    const base = sample * TERRAIN_SPLAT_CHANNELS;
    readShares(grid, base);
    setShare(layer, values[sample], grid.layerCount);
    writeShares(grid, base, layer);
  }
};

/** A layer's weight (0-1) at every sample. */
export const layerValues = (grid: TerrainWeightGrid, layer: number): Float32Array => {
  const count = grid.columns * grid.rows;
  const out = new Float32Array(count);
  for (let sample = 0; sample < count; sample++) out[sample] = layerWeightAt(grid, sample, layer);
  return out;
};

/**
 * Removes a layer: its weight goes to the base layer (or the next, when it is the base), and later
 * layers' weights move down one place, as the layers themselves do.
 */
export const removeLayerWeights = (grid: TerrainWeightGrid, layer: number): void => {
  const count = grid.columns * grid.rows;
  for (let sample = 0; sample < count; sample++) {
    const base = sample * TERRAIN_SPLAT_CHANNELS;
    readShares(grid, base);
    const heir = layer === 0 ? 1 : 0;
    scratch[heir] += scratch[layer];
    for (let channel = layer; channel < MAX_TERRAIN_LAYERS - 1; channel++) scratch[channel] = scratch[channel + 1];
    scratch[MAX_TERRAIN_LAYERS - 1] = 0;
    writeShares(grid, base, 0);
  }
};

/** Swaps two layers' weights, as the layers themselves swap places. */
export const swapLayerWeights = (grid: TerrainWeightGrid, a: number, b: number): void => {
  const count = grid.columns * grid.rows;
  const read = (sample: number, layer: number) => (layer < TERRAIN_SPLAT_CHANNELS ? grid.weights[sample * 4 + layer] : (grid.weights2 ? grid.weights2[sample * 4 + layer - 4] : 0));
  const write = (sample: number, layer: number, value: number) => {
    if (layer < TERRAIN_SPLAT_CHANNELS) grid.weights[sample * 4 + layer] = value;
    else if (grid.weights2) grid.weights2[sample * 4 + layer - 4] = value;
  };
  for (let sample = 0; sample < count; sample++) {
    const first = read(sample, a);
    write(sample, a, read(sample, b));
    write(sample, b, first);
  }
};

export interface SlopePaintRule {
  /** Degrees of slope the layer goes on, with a soft edge of `softness` degrees. */
  slopeMin: number;
  slopeMax: number;
  /** World metres of height it goes between. */
  heightMin: number;
  heightMax: number;
  softness: number;
  /** World metres per local unit. */
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  /** The terrain's own world height. */
  originY: number;
}

const soft = (value: number, low: number, high: number, edge: number): number => {
  const up = edge > 0 ? Math.min(1, Math.max(0, (value - low) / edge + 0.5)) : (value >= low ? 1 : 0);
  const down = edge > 0 ? Math.min(1, Math.max(0, (high - value) / edge + 0.5)) : (value <= high ? 1 : 0);
  return up * down;
};

/** Paints the layer wherever the ground fits a slope and height range: rock on cliffs, snow on peaks. */
export const paintLayerByRule = (grid: TerrainWeightGrid, heights: ArrayLike<number>, layer: number, rule: SlopePaintRule): void => {
  const { columns, rows, width, depth } = grid;
  const cellX = (width / (columns - 1)) * rule.scaleX;
  const cellY = (depth / (rows - 1)) * rule.scaleY;
  for (let row = 0; row < rows; row++) {
    const above = Math.max(0, row - 1);
    const below = Math.min(rows - 1, row + 1);
    for (let column = 0; column < columns; column++) {
      const left = Math.max(0, column - 1);
      const right = Math.min(columns - 1, column + 1);
      const dhdx = ((heights[row * columns + right] - heights[row * columns + left]) * rule.scaleZ) / ((right - left) * cellX);
      const dhdy = ((heights[below * columns + column] - heights[above * columns + column]) * rule.scaleZ) / ((below - above) * cellY);
      const slope = (Math.atan(Math.hypot(dhdx, dhdy)) * 180) / Math.PI;
      const height = rule.originY + heights[row * columns + column] * rule.scaleZ;
      const fit = soft(slope, rule.slopeMin, rule.slopeMax, rule.softness) * soft(height, rule.heightMin, rule.heightMax, rule.softness);
      if (fit <= 0) continue;
      const base = (row * columns + column) * TERRAIN_SPLAT_CHANNELS;
      readShares(grid, base);
      setShare(layer, scratch[layer] + (1 - scratch[layer]) * fit, grid.layerCount);
      writeShares(grid, base, layer);
    }
  }
};

/** How much of the terrain each layer covers, 0-1, from a sparse look over its samples. */
export const layerCoverage = (weights: ArrayLike<number> | undefined, weights2: ArrayLike<number> | undefined, samples: number, layerCount: number): number[] => {
  const coverage = new Array<number>(layerCount).fill(0);
  if (layerCount === 0) return coverage;
  if (!weights || weights.length !== samples * TERRAIN_SPLAT_CHANNELS) {
    coverage[0] = 1;
    return coverage;
  }
  const step = Math.max(1, Math.floor(samples / 20000));
  let seen = 0;
  for (let sample = 0; sample < samples; sample += step) {
    seen++;
    for (let layer = 0; layer < layerCount; layer++) {
      const value = layer < TERRAIN_SPLAT_CHANNELS ? weights[sample * 4 + layer] : (weights2 ? weights2[sample * 4 + layer - 4] : 0);
      coverage[layer] += value / FULL;
    }
  }
  return coverage.map(value => value / Math.max(1, seen));
};
