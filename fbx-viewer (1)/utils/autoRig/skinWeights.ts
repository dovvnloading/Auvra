import { distanceThrough, distanceToSkin, neighboursOf, UNREACHED } from './bodyField';
import type { RigJoint } from './bodySkeleton';
import { voxelIndex, voxelize, voxelOf, type TriangleSoup, type VoxelGrid } from './voxels';

/**
 * Works out how much each bone moves each vertex, by geodesic voxel binding: a vertex follows the
 * bones nearest to it through the body, measured inside a solid voxel version of the mesh, so a hand
 * resting on a thigh does not pull the thigh along, however close the two are in the air. Nearness is
 * in lengths of the limb's own thickness: skin a hand's width from the spine is close to it, while
 * the same skin is far from a slim arm, so a chest does not lift with the arm beside it. The mesh can
 * be any soup of triangles, in any number of pieces.
 */

/** A part of the mesh, its corners in the same space as the triangles and joints. */
export interface SkinnedPart {
  positions: Float32Array;
  /** Triangle corners; every three vertices are a triangle without them. */
  indices?: Uint32Array | Uint16Array | null;
}

export interface PartWeights {
  /** Four bones per vertex, as indices into the joints. */
  joints: Uint16Array;
  /** Their shares, adding up to one. */
  weights: Float32Array;
}

/** Voxels along the longest side when binding. */
const BIND_RESOLUTION = 256;
/** How sharply a bone's pull falls off with distance: the higher, the crisper the joints. */
const FALLOFF = 5;
/** Added to a distance in limb thicknesses, so a vertex right on a bone stays finite. */
const NEAREST_DISTANCE = 0.25;
/** Thinnest a limb is taken to be, in voxels. */
const LEAST_THICKNESS = 1.5;
/** Bones this many steps from a vertex's nearest bone may move it; further ones (the other leg) may not. */
const HOPS_ALLOWED = 2;
/** Bones a vertex keeps while smoothing, and in the end. */
const KEPT_WHILE_SMOOTHING = 8;
const KEPT = 4;
/** Smallest share kept: less than this moves nothing you would see. */
const LEAST_SHARE = 0.01;
const SMOOTHING_ROUNDS = 2;
const SMOOTHING = 0.5;
/** A distance no bone reaches, in a short. */
const FAR = 65535;

/**
 * Joins loose pieces (a belt that does not touch the body) to the largest piece with thin bridges,
 * so distances reach them. Returns the body with its bridges.
 */
const bridgedBody = (grid: VoxelGrid): Uint8Array => {
  const { solid, nx, ny } = grid;
  const stride = nx * ny;
  const steps = [1, -1, nx, -nx, stride, -stride];
  const label = new Int32Array(solid.length);
  const stack = new Int32Array(solid.length);
  const sizes: number[] = [0];
  for (let start = 0; start < solid.length; start += 1) {
    if (!solid[start] || label[start]) continue;
    const id = sizes.length;
    let size = 0;
    let top = 0;
    stack[top] = start;
    top += 1;
    label[start] = id;
    while (top > 0) {
      top -= 1;
      const index = stack[top];
      size += 1;
      for (const step of steps) {
        const other = index + step;
        if (other < 0 || other >= solid.length || !solid[other] || label[other]) continue;
        label[other] = id;
        stack[top] = other;
        top += 1;
      }
    }
    sizes.push(size);
  }
  const mask = solid.slice();
  if (sizes.length <= 2) return mask;
  let main = 1;
  for (let id = 2; id < sizes.length; id += 1) if (sizes[id] > sizes[main]) main = id;
  // A flood from the largest piece through the air meets the others nearest point first.
  const from = new Int32Array(solid.length).fill(-1);
  const queue = new Int32Array(solid.length);
  let head = 0;
  let tail = 0;
  for (let index = 0; index < solid.length; index += 1) {
    if (label[index] === main) {
      from[index] = index;
      queue[tail] = index;
      tail += 1;
    }
  }
  const joined = new Set<number>([main]);
  while (head < tail && joined.size < sizes.length - 1) {
    const index = queue[head];
    head += 1;
    for (const step of steps) {
      const other = index + step;
      if (other < 0 || other >= solid.length || from[other] >= 0) continue;
      from[other] = index;
      const piece = label[other];
      if (piece && !joined.has(piece)) {
        joined.add(piece);
        for (let at = index; from[at] !== at; at = from[at]) mask[at] = 1;
      }
      queue[tail] = other;
      tail += 1;
    }
  }
  return mask;
};

/** The voxel of the body closest to a point. */
const nearestBodyVoxel = (grid: VoxelGrid, mask: Uint8Array, px: number, py: number, pz: number): number => {
  const [cx, cy, cz] = voxelOf(grid, px, py, pz);
  const direct = voxelIndex(grid, cx, cy, cz);
  if (mask[direct]) return direct;
  const largest = Math.max(grid.nx, grid.ny, grid.nz);
  for (let radius = 1; radius < largest; radius += 1) {
    let best = -1;
    let bestDistance = Infinity;
    for (let z = Math.max(0, cz - radius); z <= Math.min(grid.nz - 1, cz + radius); z += 1) {
      for (let y = Math.max(0, cy - radius); y <= Math.min(grid.ny - 1, cy + radius); y += 1) {
        for (let x = Math.max(0, cx - radius); x <= Math.min(grid.nx - 1, cx + radius); x += 1) {
          if (Math.max(Math.abs(x - cx), Math.abs(y - cy), Math.abs(z - cz)) !== radius) continue;
          const index = voxelIndex(grid, x, y, z);
          if (!mask[index]) continue;
          const distance = (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = index;
          }
        }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
};

/** The voxels of the body a joint's bones run through. */
const seedsOf = (grid: VoxelGrid, mask: Uint8Array, from: readonly number[], to: readonly (readonly number[])[]): number[] => {
  const seeds = new Set<number>();
  for (const end of to) {
    const length = Math.hypot(end[0] - from[0], end[1] - from[1], end[2] - from[2]);
    const steps = Math.max(1, Math.ceil(length / (grid.size * 0.5)));
    for (let step = 0; step <= steps; step += 1) {
      const share = step / steps;
      const [x, y, z] = voxelOf(grid, from[0] + (end[0] - from[0]) * share, from[1] + (end[1] - from[1]) * share, from[2] + (end[2] - from[2]) * share);
      const index = voxelIndex(grid, x, y, z);
      if (mask[index]) seeds.add(index);
    }
  }
  if (seeds.size) return [...seeds];
  // A bone wholly outside the body starts from the body's nearest voxel.
  const nearest = nearestBodyVoxel(grid, mask, from[0], from[1], from[2]);
  return nearest >= 0 ? [nearest] : [];
};

/** Steps along the skeleton between every two moving joints. */
const hopsBetween = (joints: readonly RigJoint[], moving: readonly number[]): Uint8Array => {
  const count = moving.length;
  const hops = new Uint8Array(count * count).fill(255);
  const links: number[][] = joints.map(() => []);
  joints.forEach((joint, index) => {
    if (joint.parent >= 0) {
      links[index].push(joint.parent);
      links[joint.parent].push(index);
    }
  });
  const slot = new Map(moving.map((joint, at) => [joint, at]));
  moving.forEach((start, at) => {
    const seen = new Map<number, number>([[start, 0]]);
    const queue = [start];
    while (queue.length) {
      const joint = queue.shift()!;
      const distance = seen.get(joint)!;
      const other = slot.get(joint);
      if (other !== undefined) hops[at * count + other] = Math.min(255, distance);
      for (const link of links[joint]) {
        if (!seen.has(link)) {
          seen.set(link, distance + 1);
          queue.push(link);
        }
      }
    }
  });
  return hops;
};

/** Vertices at the same place across parts and seams move as one: gives each a shared number. */
const weldVertices = (parts: readonly SkinnedPart[], size: number): { ids: Int32Array[]; first: { part: number; vertex: number }[] } => {
  const tolerance = size / 64;
  const seen = new Map<number, number>();
  const first: { part: number; vertex: number }[] = [];
  const ids = parts.map((part, partIndex) => {
    const count = Math.floor(part.positions.length / 3);
    const out = new Int32Array(count);
    for (let vertex = 0; vertex < count; vertex += 1) {
      const qx = Math.round(part.positions[vertex * 3] / tolerance) & 0x1ffff;
      const qy = Math.round(part.positions[vertex * 3 + 1] / tolerance) & 0x1ffff;
      const qz = Math.round(part.positions[vertex * 3 + 2] / tolerance) & 0x1ffff;
      // Three coordinates into one number that a double holds exactly.
      const packed = qx * 17179869184 + qy * 131072 + qz;
      let id = seen.get(packed);
      if (id === undefined) {
        id = first.length;
        seen.set(packed, id);
        first.push({ part: partIndex, vertex });
      }
      out[vertex] = id;
    }
    return out;
  });
  return { ids, first };
};

/** Which vertices share a triangle with each vertex: those of vertex v are `links[starts[v]]` to `links[starts[v + 1] - 1]`. */
const edgesOf = (parts: readonly SkinnedPart[], ids: readonly Int32Array[], count: number): { starts: Uint32Array; links: Int32Array } => {
  const eachTriangle = (visit: (a: number, b: number, c: number) => void): void => {
    parts.forEach((part, partIndex) => {
      const partIds = ids[partIndex];
      const corners = part.indices ?? null;
      const total = corners ? corners.length : partIds.length;
      for (let corner = 0; corner + 2 < total; corner += 3) {
        visit(partIds[corners ? corners[corner] : corner], partIds[corners ? corners[corner + 1] : corner + 1], partIds[corners ? corners[corner + 2] : corner + 2]);
      }
    });
  };
  const starts = new Uint32Array(count + 1);
  eachTriangle((a, b, c) => {
    starts[a + 1] += 2;
    starts[b + 1] += 2;
    starts[c + 1] += 2;
  });
  for (let vertex = 0; vertex < count; vertex += 1) starts[vertex + 1] += starts[vertex];
  const links = new Int32Array(starts[count]);
  const next = starts.slice(0, count);
  eachTriangle((a, b, c) => {
    links[next[a]++] = b;
    links[next[a]++] = c;
    links[next[b]++] = a;
    links[next[b]++] = c;
    links[next[c]++] = a;
    links[next[c]++] = b;
  });
  return { starts, links };
};

/**
 * Writes the strongest of `pull` for a vertex, shares adding up to one, and clears `pull`. A list of
 * bones per vertex holds -1 where it has run out.
 */
const keepStrongest = (pull: Float32Array, vertex: number, bones: Int16Array, shares: Float32Array): void => {
  let total = 0;
  const at = vertex * KEPT_WHILE_SMOOTHING;
  for (let slot = 0; slot < KEPT_WHILE_SMOOTHING; slot += 1) {
    let best = -1;
    let bestValue = 0;
    for (let bone = 0; bone < pull.length; bone += 1) {
      if (pull[bone] > bestValue) {
        bestValue = pull[bone];
        best = bone;
      }
    }
    bones[at + slot] = best;
    shares[at + slot] = bestValue;
    if (best >= 0) {
      total += bestValue;
      pull[best] = 0;
    }
  }
  if (total > 0) for (let slot = 0; slot < KEPT_WHILE_SMOOTHING; slot += 1) shares[at + slot] /= total;
  pull.fill(0);
};

/** How much each bone moves each vertex of `parts`. `triangles`, `joints` and `parts` are all in one space. */
export const bindSkin = (
  triangles: TriangleSoup,
  joints: readonly RigJoint[],
  parts: readonly SkinnedPart[],
  onProgress?: (share: number) => void,
): PartWeights[] => {
  const grid = voxelize(triangles, BIND_RESOLUTION);
  if (!grid) throw new Error('The mesh has no surface to bind.');
  const mask = bridgedBody(grid);
  onProgress?.(0.1);
  const neighbours = neighboursOf(grid);

  const moving = joints.flatMap((joint, index) => (joint.skins ? [index] : []));
  const childrenOf = joints.map((_, index) => joints.flatMap((joint, at) => (joint.parent === index ? [at] : [])));
  // The body's voxels, numbered, so each bone's distances fit in a short list.
  let bodyVoxels = 0;
  const numberOf = new Int32Array(mask.length).fill(-1);
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index]) {
      numberOf[index] = bodyVoxels;
      bodyVoxels += 1;
    }
  }
  const field = new Uint32Array(mask.length);
  const skin = distanceToSkin(grid, mask);
  const thickness = new Float32Array(moving.length);
  const distances = moving.map((jointIndex, at) => {
    const joint = joints[jointIndex];
    const ends = childrenOf[jointIndex].map((child) => joints[child].position);
    const seeds = seedsOf(grid, mask, joint.position, ends.length ? ends : [joint.position]);
    // How far the bone is from the skin along most of its length.
    const depths = seeds.map((seed) => skin[seed]).sort((a, b) => a - b);
    thickness[at] = Math.max(LEAST_THICKNESS, depths[Math.floor(depths.length / 2)] ?? 0);
    distanceThrough(mask, neighbours, seeds, field);
    const list = new Uint16Array(bodyVoxels);
    for (let index = 0; index < mask.length; index += 1) {
      const number = numberOf[index];
      if (number >= 0) list[number] = field[index] === UNREACHED ? FAR : Math.min(FAR - 1, field[index]);
    }
    onProgress?.(0.1 + 0.6 * ((at + 1) / moving.length));
    return list;
  });

  const hops = hopsBetween(joints, moving);
  const boneCount = moving.length;
  const { ids, first } = weldVertices(parts, grid.size);
  const welded = first.length;

  // Every welded vertex: its strongest bones and shares.
  let bones = new Int16Array(welded * KEPT_WHILE_SMOOTHING).fill(-1);
  let shares = new Float32Array(welded * KEPT_WHILE_SMOOTHING);
  const pull = new Float32Array(boneCount);
  for (let vertex = 0; vertex < welded; vertex += 1) {
    const { part, vertex: at } = first[vertex];
    const positions = parts[part].positions;
    const voxel = nearestBodyVoxel(grid, mask, positions[at * 3], positions[at * 3 + 1], positions[at * 3 + 2]);
    const number = voxel >= 0 ? numberOf[voxel] : -1;
    let nearest = 0;
    let nearestDistance = Infinity;
    for (let bone = 0; bone < boneCount; bone += 1) {
      const distance = number >= 0 ? distances[bone][number] : FAR;
      if (distance === FAR) continue;
      const relative = distance / 10 / thickness[bone];
      if (relative < nearestDistance) {
        nearestDistance = relative;
        nearest = bone;
      }
    }
    for (let bone = 0; bone < boneCount; bone += 1) {
      if (hops[nearest * boneCount + bone] > HOPS_ALLOWED) continue;
      const distance = number >= 0 ? distances[bone][number] : FAR;
      if (distance === FAR) continue;
      pull[bone] = (1 / (distance / 10 / thickness[bone] + NEAREST_DISTANCE)) ** FALLOFF;
    }
    pull[nearest] = Math.max(pull[nearest], 1e-30);
    keepStrongest(pull, vertex, bones, shares);
  }
  onProgress?.(0.8);

  // A few rounds of evening out over the surface, so joints bend without a crease from a voxel's edge.
  const { starts, links } = edgesOf(parts, ids, welded);
  let nextBones = new Int16Array(bones.length);
  let nextShares = new Float32Array(shares.length);
  for (let round = 0; round < SMOOTHING_ROUNDS; round += 1) {
    for (let vertex = 0; vertex < welded; vertex += 1) {
      const first = starts[vertex];
      const last = starts[vertex + 1];
      const own = last > first ? 1 - SMOOTHING : 1;
      for (let slot = 0; slot < KEPT_WHILE_SMOOTHING; slot += 1) {
        const bone = bones[vertex * KEPT_WHILE_SMOOTHING + slot];
        if (bone >= 0) pull[bone] += shares[vertex * KEPT_WHILE_SMOOTHING + slot] * own;
      }
      if (last > first) {
        const each = SMOOTHING / (last - first);
        for (let link = first; link < last; link += 1) {
          const other = links[link];
          for (let slot = 0; slot < KEPT_WHILE_SMOOTHING; slot += 1) {
            const bone = bones[other * KEPT_WHILE_SMOOTHING + slot];
            if (bone >= 0) pull[bone] += shares[other * KEPT_WHILE_SMOOTHING + slot] * each;
          }
        }
      }
      keepStrongest(pull, vertex, nextBones, nextShares);
    }
    [bones, nextBones] = [nextBones, bones];
    [shares, nextShares] = [nextShares, shares];
  }
  onProgress?.(0.92);

  // The four strongest of each, back on every part's own vertices.
  const weights = parts.map((_, partIndex) => {
    const partIds = ids[partIndex];
    const outJoints = new Uint16Array(partIds.length * 4);
    const outWeights = new Float32Array(partIds.length * 4);
    for (let vertex = 0; vertex < partIds.length; vertex += 1) {
      const id = partIds[vertex];
      let total = 0;
      let kept = 0;
      for (let slot = 0; slot < KEPT; slot += 1) {
        const share = shares[id * KEPT_WHILE_SMOOTHING + slot];
        const bone = bones[id * KEPT_WHILE_SMOOTHING + slot];
        if (bone < 0 || share < LEAST_SHARE) continue;
        outJoints[vertex * 4 + kept] = moving[bone];
        outWeights[vertex * 4 + kept] = share;
        total += share;
        kept += 1;
      }
      if (kept === 0) {
        // Everything spread too thin to keep: the strongest takes it all.
        outJoints[vertex * 4] = moving[Math.max(0, bones[id * KEPT_WHILE_SMOOTHING])];
        outWeights[vertex * 4] = 1;
      } else {
        for (let slot = 0; slot < kept; slot += 1) outWeights[vertex * 4 + slot] /= total;
      }
    }
    return { joints: outJoints, weights: outWeights };
  });
  onProgress?.(1);
  return weights;
};
