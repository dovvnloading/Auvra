import type { VoxelGrid } from './voxels';

/**
 * Measures through a voxelized body: how far each voxel is from the skin, and how far apart two
 * voxels are going through the body rather than across the air between a hand and a thigh.
 */

/** Steps to the 26 neighbours of a voxel: offsets and their lengths, in tenths of a voxel. */
export interface Neighbours {
  offset: Int32Array;
  dx: Int8Array;
  dy: Int8Array;
  dz: Int8Array;
  cost: Uint8Array;
}

export const neighboursOf = (grid: VoxelGrid): Neighbours => {
  const offset: number[] = [];
  const dxs: number[] = [];
  const dys: number[] = [];
  const dzs: number[] = [];
  const cost: number[] = [];
  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const taxi = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        if (!taxi) continue;
        offset.push(dx + dy * grid.nx + dz * grid.nx * grid.ny);
        dxs.push(dx);
        dys.push(dy);
        dzs.push(dz);
        cost.push(taxi === 1 ? 10 : taxi === 2 ? 14 : 17);
      }
    }
  }
  return { offset: Int32Array.from(offset), dx: Int8Array.from(dxs), dy: Int8Array.from(dys), dz: Int8Array.from(dzs), cost: Uint8Array.from(cost) };
};

/**
 * The largest connected piece of the body, as a mask. Everything else (a floating belt, a loose
 * buckle) is ignored when working out where the joints go.
 */
export const largestPiece = (grid: VoxelGrid): Uint8Array => {
  const { solid, nx, ny } = grid;
  const label = new Int32Array(solid.length);
  const stack = new Int32Array(solid.length);
  const stride = nx * ny;
  let best = 0;
  let bestSize = 0;
  let next = 0;
  for (let start = 0; start < solid.length; start += 1) {
    if (!solid[start] || label[start]) continue;
    next += 1;
    let top = 0;
    let size = 0;
    stack[top] = start;
    top += 1;
    label[start] = next;
    while (top > 0) {
      top -= 1;
      const index = stack[top];
      size += 1;
      // Six neighbours are enough to tell pieces apart. The margin keeps these inside the grid.
      for (const step of [1, -1, nx, -nx, stride, -stride]) {
        const other = index + step;
        if (other < 0 || other >= solid.length || !solid[other] || label[other]) continue;
        label[other] = next;
        stack[top] = other;
        top += 1;
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = next;
    }
  }
  const mask = new Uint8Array(solid.length);
  for (let index = 0; index < solid.length; index += 1) if (label[index] === best) mask[index] = 1;
  return mask;
};

/** Distance from each voxel of `mask` to the nearest voxel outside it, in voxels (a chamfer estimate). */
export const distanceToSkin = (grid: VoxelGrid, mask: Uint8Array): Float32Array => {
  const { nx, ny, nz } = grid;
  const stride = nx * ny;
  const field = new Float32Array(mask.length);
  const far = 1e9;
  for (let index = 0; index < mask.length; index += 1) field[index] = mask[index] ? far : 0;
  const a = 0.96;
  const b = 1.36;
  const c = 1.67;
  const relax = (index: number, step: number, cost: number): void => {
    const value = field[index + step] + cost;
    if (value < field[index]) field[index] = value;
  };
  for (let z = 1; z < nz - 1; z += 1) {
    for (let y = 1; y < ny - 1; y += 1) {
      for (let x = 1; x < nx - 1; x += 1) {
        const index = x + y * nx + z * stride;
        if (!mask[index]) continue;
        relax(index, -1, a); relax(index, -nx, a); relax(index, -stride, a);
        relax(index, -1 - nx, b); relax(index, 1 - nx, b); relax(index, -1 - stride, b); relax(index, 1 - stride, b);
        relax(index, -nx - stride, b); relax(index, nx - stride, b);
        relax(index, -1 - nx - stride, c); relax(index, 1 - nx - stride, c); relax(index, -1 + nx - stride, c); relax(index, 1 + nx - stride, c);
      }
    }
  }
  for (let z = nz - 2; z >= 1; z -= 1) {
    for (let y = ny - 2; y >= 1; y -= 1) {
      for (let x = nx - 2; x >= 1; x -= 1) {
        const index = x + y * nx + z * stride;
        if (!mask[index]) continue;
        relax(index, 1, a); relax(index, nx, a); relax(index, stride, a);
        relax(index, 1 + nx, b); relax(index, -1 + nx, b); relax(index, 1 + stride, b); relax(index, -1 + stride, b);
        relax(index, nx + stride, b); relax(index, -nx + stride, b);
        relax(index, 1 + nx + stride, c); relax(index, -1 + nx + stride, c); relax(index, 1 - nx + stride, c); relax(index, -1 - nx + stride, c);
      }
    }
  }
  return field;
};

/** Marks a voxel as not reached by a distance field. */
export const UNREACHED = 0xffffffff;

/**
 * Distance from `seeds` to every voxel of `mask`, through it, in tenths of a voxel. Buckets keep this
 * linear in the voxels visited, so it can run once per bone.
 */
export const distanceThrough = (mask: Uint8Array, neighbours: Neighbours, seeds: ArrayLike<number>, field: Uint32Array = new Uint32Array(mask.length)): Uint32Array => {
  field.fill(UNREACHED);
  const buckets: number[][] = Array.from({ length: 18 }, () => []);
  for (let i = 0; i < seeds.length; i += 1) {
    const seed = seeds[i];
    if (mask[seed] && field[seed] !== 0) {
      field[seed] = 0;
      buckets[0].push(seed);
    }
  }
  const { offset, cost } = neighbours;
  const count = offset.length;
  let distance = 0;
  let waiting = buckets[0].length;
  while (waiting > 0) {
    const bucket = buckets[distance % 18];
    while (bucket.length > 0) {
      const index = bucket.pop()!;
      waiting -= 1;
      if (field[index] !== distance) continue;
      for (let n = 0; n < count; n += 1) {
        const other = index + offset[n];
        if (other < 0 || other >= mask.length || !mask[other]) continue;
        const value = distance + cost[n];
        if (value < field[other]) {
          field[other] = value;
          buckets[value % 18].push(other);
          waiting += 1;
        }
      }
    }
    distance += 1;
  }
  return field;
};

/** A binary heap of voxels by a float key, for shortest paths whose steps cost different amounts. */
class VoxelHeap {
  private keys: Float64Array;
  private items: Int32Array;
  size = 0;

  constructor(capacity: number) {
    this.keys = new Float64Array(capacity);
    this.items = new Int32Array(capacity);
  }

  push(item: number, key: number): void {
    if (this.size === this.items.length) {
      const keys = new Float64Array(this.size * 2);
      keys.set(this.keys);
      this.keys = keys;
      const items = new Int32Array(this.size * 2);
      items.set(this.items);
      this.items = items;
    }
    let at = this.size;
    this.size += 1;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.keys[at] = this.keys[parent];
      this.items[at] = this.items[parent];
      at = parent;
    }
    this.keys[at] = key;
    this.items[at] = item;
  }

  popKey = 0;

  pop(): number {
    const top = this.items[0];
    this.popKey = this.keys[0];
    this.size -= 1;
    const key = this.keys[this.size];
    const item = this.items[this.size];
    let at = 0;
    for (;;) {
      let child = at * 2 + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && this.keys[child + 1] < this.keys[child]) child += 1;
      if (this.keys[child] >= key) break;
      this.keys[at] = this.keys[child];
      this.items[at] = this.items[child];
      at = child;
    }
    this.keys[at] = key;
    this.items[at] = item;
    return top;
  }
}

/**
 * For every voxel of `mask`, the step towards `start` on the way that keeps to the middle of the
 * limbs: a step costs more the nearer it runs to the skin. `previous[index]` is -1 at `start`, and
 * for voxels it cannot reach.
 */
export const pathsAlongMiddle = (mask: Uint8Array, skin: Float32Array, neighbours: Neighbours, start: number): Int32Array => {
  const previous = new Int32Array(mask.length).fill(-1);
  const best = new Float64Array(mask.length).fill(Infinity);
  const heap = new VoxelHeap(1 << 16);
  best[start] = 0;
  heap.push(start, 0);
  const { offset, cost } = neighbours;
  while (heap.size > 0) {
    const index = heap.pop();
    if (heap.popKey > best[index]) continue;
    for (let n = 0; n < offset.length; n += 1) {
      const other = index + offset[n];
      if (other < 0 || other >= mask.length || !mask[other]) continue;
      const depth = Math.max(0.5, skin[other]);
      const value = best[index] + cost[n] * (1 + 6 / (depth * depth));
      if (value < best[other]) {
        best[other] = value;
        previous[other] = index;
        heap.push(other, value);
      }
    }
  }
  return previous;
};

/** The voxels from `end` back to the start of `previous`. */
export const pathTo = (previous: Int32Array, end: number): number[] => {
  const path: number[] = [];
  for (let at = end; at >= 0; at = previous[at]) path.push(at);
  return path;
};
