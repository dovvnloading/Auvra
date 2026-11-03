import { cellOf, type VoxelGrid } from './voxels';

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

/** A part of the body standing out from its middle. */
export interface Protrusion {
  /** The voxel at its end. */
  tip: number;
  /** How far the tip is from the middle, in tenths of a voxel. */
  reach: number;
  /** How far it stands out before it meets a part reaching further, in tenths of a voxel. */
  length: number;
  /** Its voxels, up to that meeting. */
  volume: number;
}

/**
 * The parts of the body standing out from wherever `field` measures from, longest first. Going down
 * from the furthest voxels, each new top starts a part; where two parts meet, the one reaching less
 * ends. A broad chest has many far points, all of them joined to each other a voxel or two down, so
 * they count for nothing, while a head shows as a part however close it is to the shoulders.
 */
export const protrusions = (mask: Uint8Array, neighbours: Neighbours, field: Uint32Array): Protrusion[] => {
  let highest = 0;
  let count = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index] || field[index] === UNREACHED) continue;
    count += 1;
    if (field[index] > highest) highest = field[index];
  }
  // Furthest first, sorted by counting.
  const starts = new Uint32Array(highest + 2);
  for (let index = 0; index < mask.length; index += 1) if (mask[index] && field[index] !== UNREACHED) starts[highest - field[index] + 1] += 1;
  for (let value = 0; value <= highest; value += 1) starts[value + 1] += starts[value];
  const order = new Int32Array(count);
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] && field[index] !== UNREACHED) {
      order[starts[highest - field[index]]] = index;
      starts[highest - field[index]] += 1;
    }
  }
  const parent = new Int32Array(mask.length).fill(-1);
  const volume = new Int32Array(mask.length);
  const tipOf = new Int32Array(mask.length);
  const partOf = (ended: number, length: number): Protrusion => ({ tip: tipOf[ended], reach: field[tipOf[ended]], length, volume: volume[ended] });
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    let at = index;
    while (parent[at] !== root && at !== root) {
      const next = parent[at];
      parent[at] = root;
      at = next;
    }
    return root;
  };
  const found: Protrusion[] = [];
  const { offset } = neighbours;
  for (let at = 0; at < count; at += 1) {
    const index = order[at];
    let elder = -1;
    for (let n = 0; n < offset.length; n += 1) {
      const other = index + offset[n];
      if (other < 0 || other >= mask.length || parent[other] < 0) continue;
      const root = find(other);
      if (root === elder) continue;
      if (elder < 0) {
        elder = root;
        continue;
      }
      // Two parts meet here: the one reaching less ends.
      const kept = field[tipOf[root]] > field[tipOf[elder]] ? root : elder;
      const ended = kept === root ? elder : root;
      found.push(partOf(ended, field[tipOf[ended]] - field[index]));
      parent[ended] = kept;
      volume[kept] += volume[ended];
      elder = kept;
    }
    const owner = elder < 0 ? index : elder;
    parent[index] = owner;
    if (elder < 0) tipOf[index] = index;
    volume[owner] += 1;
  }
  if (count) {
    const root = find(order[count - 1]);
    found.push(partOf(root, field[tipOf[root]]));
  }
  return found.sort((a, b) => b.length - a.length);
};

/**
 * The thick middle of the body: what is left of it when everything too thin to hold a ball of
 * `radius` voxels is taken away, around `heart`. Arms and legs fall away from it, and so does a head
 * on a neck.
 */
export const thickMiddle = (grid: VoxelGrid, mask: Uint8Array, skin: Float32Array, heart: number, radius: number): Uint8Array => {
  const { nx, ny } = grid;
  const stride = nx * ny;
  const core = new Uint8Array(mask.length);
  const stack = [heart];
  core[heart] = 1;
  while (stack.length) {
    const index = stack.pop()!;
    for (const step of [1, -1, nx, -nx, stride, -stride]) {
      const other = index + step;
      if (other < 0 || other >= mask.length || core[other] || skin[other] < radius) continue;
      core[other] = 1;
      stack.push(other);
    }
  }
  // The core grown back out by what it was thinned by, staying in the body.
  const outside = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) outside[index] = core[index] ? 0 : 1;
  const away = distanceToSkin(grid, outside);
  const middle = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) if (mask[index] && away[index] <= radius) middle[index] = 1;
  return middle;
};

/** A step of a wave spreading through the body from one voxel: what it covers, a voxel or two thick. */
export interface WaveBand {
  /** How far the wave has come, in voxels. */
  distance: number;
  /** The wave's cross-section, in voxels. */
  area: number;
  /** Its middle, in voxel indices. */
  centre: [number, number, number];
  /** Its share in `within`, and the middle of that share. */
  withinShare: number;
  withinCentre: [number, number, number];
}

/** How thick a wave's bands are, in tenths of a voxel: the longest step of the field, so each band touches the last. */
const WAVE_BAND = 18;

/**
 * Follows a wave from `start` through the body until `stop` says so, or the body runs out. Cuts across
 * a limb this way are square to it whichever way it runs, and bend with it. Only the part of each band
 * that follows on from the band before is taken, so another limb the wave reaches is left out till the
 * two have joined. `within` is a part of the body to say how much of each band is in.
 */
export const waveFrom = (
  grid: VoxelGrid,
  mask: Uint8Array,
  neighbours: Neighbours,
  start: number,
  stop: (band: WaveBand, bands: readonly WaveBand[]) => boolean,
  within?: Uint8Array,
): WaveBand[] => {
  const field = distanceThrough(mask, neighbours, [start]);
  const { offset } = neighbours;
  const seen = new Uint8Array(mask.length);
  const bands: WaveBand[] = [];
  let piece: number[] = [start];
  seen[start] = 1;
  for (let step = 0; piece.length; step += 1) {
    // All of this band joined to what is already in it.
    const queue = piece.slice();
    const members: number[] = [];
    while (queue.length) {
      const index = queue.pop()!;
      members.push(index);
      for (let n = 0; n < offset.length; n += 1) {
        const other = index + offset[n];
        if (other < 0 || other >= mask.length || !mask[other] || seen[other] || field[other] === UNREACHED) continue;
        if (Math.floor(field[other] / WAVE_BAND) !== step) continue;
        seen[other] = 1;
        queue.push(other);
      }
    }
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    let sumField = 0;
    let inX = 0;
    let inY = 0;
    let inZ = 0;
    let inCount = 0;
    for (const index of members) {
      const [x, y, z] = cellOf(grid, index);
      sumX += x;
      sumY += y;
      sumZ += z;
      sumField += field[index];
      if (within?.[index]) {
        inX += x;
        inY += y;
        inZ += z;
        inCount += 1;
      }
    }
    const count = Math.max(1, members.length);
    const band: WaveBand = {
      distance: sumField / count / 10,
      area: members.length / (WAVE_BAND / 10),
      centre: [sumX / count, sumY / count, sumZ / count],
      withinShare: inCount / count,
      withinCentre: inCount ? [inX / inCount, inY / inCount, inZ / inCount] : [sumX / count, sumY / count, sumZ / count],
    };
    bands.push(band);
    if (stop(band, bands)) break;
    // What the next band starts from: its voxels touching this one.
    const next: number[] = [];
    for (const index of members) {
      for (let n = 0; n < offset.length; n += 1) {
        const other = index + offset[n];
        if (other < 0 || other >= mask.length || !mask[other] || seen[other] || field[other] === UNREACHED) continue;
        if (Math.floor(field[other] / WAVE_BAND) !== step + 1) continue;
        seen[other] = 1;
        next.push(other);
      }
    }
    piece = next;
  }
  return bands;
};
