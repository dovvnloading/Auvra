/**
 * A model as a solid block of voxels: what automatic rigging measures the body with. Works on any
 * triangle soup, as AI-made and scanned meshes are rarely clean: surfaces are marked, small holes are
 * closed by flooding the outside around a slightly thickened surface, and whatever the flood cannot
 * reach counts as inside.
 */

/** Triangles as flat xyz triples: three corners each, in one space. */
export type TriangleSoup = Float32Array;

export interface VoxelGrid {
  nx: number;
  ny: number;
  nz: number;
  /** Corner of the first voxel. */
  ox: number;
  oy: number;
  oz: number;
  /** A voxel's edge. */
  size: number;
  /** 1 for voxels in the body, 0 outside it; x runs fastest, then y, then z. */
  solid: Uint8Array;
  /** 1 for voxels the surface passes through. */
  surface: Uint8Array;
}

export const voxelIndex = (grid: VoxelGrid, x: number, y: number, z: number): number => x + y * grid.nx + z * grid.nx * grid.ny;

/** The voxel a point falls in, clamped to the grid. */
export const voxelOf = (grid: VoxelGrid, px: number, py: number, pz: number): [number, number, number] => [
  Math.max(0, Math.min(grid.nx - 1, Math.floor((px - grid.ox) / grid.size))),
  Math.max(0, Math.min(grid.ny - 1, Math.floor((py - grid.oy) / grid.size))),
  Math.max(0, Math.min(grid.nz - 1, Math.floor((pz - grid.oz) / grid.size))),
];

/** Largest number of voxels a grid may hold, whatever size is asked for. */
const MAX_VOXELS = 64_000_000;
/** Empty voxels kept around the body, so the flood can reach all of its outside. */
const MARGIN = 3;
/** How many layers in from a grid's sides count as its edge, for a part cut out of a larger body. */
const EDGE_LAYERS = MARGIN + 2;

/** Marks every voxel the triangles pass through, by walking each in steps shorter than a voxel. */
const markSurface = (grid: VoxelGrid, triangles: TriangleSoup): void => {
  const { nx, ny, nz, ox, oy, oz, size, surface } = grid;
  const step = size * 0.6;
  const stride = nx * ny;
  const mark = (x: number, y: number, z: number): void => {
    const vx = Math.floor((x - ox) / size);
    const vy = Math.floor((y - oy) / size);
    const vz = Math.floor((z - oz) / size);
    if (vx >= 0 && vy >= 0 && vz >= 0 && vx < nx && vy < ny && vz < nz) surface[vx + vy * nx + vz * stride] = 1;
  };
  for (let t = 0; t + 8 < triangles.length; t += 9) {
    const ax = triangles[t];
    const ay = triangles[t + 1];
    const az = triangles[t + 2];
    const ux = triangles[t + 3] - ax;
    const uy = triangles[t + 4] - ay;
    const uz = triangles[t + 5] - az;
    const vx = triangles[t + 6] - ax;
    const vy = triangles[t + 7] - ay;
    const vz = triangles[t + 8] - az;
    const longest = Math.sqrt(Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz, (ux - vx) * (ux - vx) + (uy - vy) * (uy - vy) + (uz - vz) * (uz - vz)));
    const parts = Math.max(1, Math.ceil(longest / step));
    for (let i = 0; i <= parts; i += 1) {
      const a = i / parts;
      for (let j = 0; j <= parts - i; j += 1) {
        const b = j / parts;
        mark(ax + ux * a + vx * b, ay + uy * a + vy * b, az + uz * a + vz * b);
      }
    }
  }
};

/** Fills the body: everything a flood from outside cannot reach past the thickened surface. */
const fillInside = (grid: VoxelGrid, insideAtEdge?: (x: number, y: number, z: number) => boolean): void => {
  const { nx, ny, nz, surface, solid } = grid;
  const stride = nx * ny;
  const total = nx * ny * nz;
  // The surface thickened by one voxel closes holes up to two voxels across.
  const wall = new Uint8Array(total);
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        if (!surface[x + y * nx + z * stride]) continue;
        for (let dz = Math.max(0, z - 1); dz <= Math.min(nz - 1, z + 1); dz += 1) {
          for (let dy = Math.max(0, y - 1); dy <= Math.min(ny - 1, y + 1); dy += 1) {
            for (let dx = Math.max(0, x - 1); dx <= Math.min(nx - 1, x + 1); dx += 1) wall[dx + dy * nx + dz * stride] = 1;
          }
        }
      }
    }
  }
  // A part cut out of a mesh is open where it was cut: a flood must not get in that way.
  if (insideAtEdge) {
    for (let z = 0; z < nz; z += 1) {
      for (let y = 0; y < ny; y += 1) {
        for (let x = 0; x < nx; x += 1) {
          if (Math.min(x, y, z, nx - 1 - x, ny - 1 - y, nz - 1 - z) >= EDGE_LAYERS) continue;
          if (insideAtEdge(grid.ox + (x + 0.5) * grid.size, grid.oy + (y + 0.5) * grid.size, grid.oz + (z + 0.5) * grid.size)) wall[x + y * nx + z * stride] = 1;
        }
      }
    }
  }
  const outside = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  const visit = (index: number): void => {
    if (wall[index] || outside[index]) return;
    outside[index] = 1;
    queue[tail] = index;
    tail += 1;
  };
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) visit(x + y * nx + z * stride);
      }
    }
  }
  while (head < tail) {
    const index = queue[head];
    head += 1;
    const z = Math.floor(index / stride);
    const rest = index - z * stride;
    const y = Math.floor(rest / nx);
    const x = rest - y * nx;
    if (x > 0) visit(index - 1);
    if (x < nx - 1) visit(index + 1);
    if (y > 0) visit(index - nx);
    if (y < ny - 1) visit(index + nx);
    if (z > 0) visit(index - stride);
    if (z < nz - 1) visit(index + stride);
  }
  // The flood stopped a voxel short of the surface: take that layer back, but never the surface itself.
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const index = x + y * nx + z * stride;
        if (surface[index]) {
          solid[index] = 1;
          continue;
        }
        if (outside[index]) continue;
        const touchesOutside = (x > 0 && outside[index - 1]) || (x < nx - 1 && outside[index + 1])
          || (y > 0 && outside[index - nx]) || (y < ny - 1 && outside[index + nx])
          || (z > 0 && outside[index - stride]) || (z < nz - 1 && outside[index + stride]);
        if (!touchesOutside) solid[index] = 1;
      }
    }
  }
};

/** Bounding box of a triangle soup, or null if it has none. */
export const soupBounds = (triangles: TriangleSoup): { min: [number, number, number]; max: [number, number, number] } | null => {
  if (triangles.length < 9) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = triangles[i + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  return min[0] <= max[0] ? { min, max } : null;
};

/**
 * The body of `triangles` in voxels, `resolution` of them along its longest side. For triangles cut
 * out of a larger body, `insideAtEdge` says which places at the grid's edge are inside that body.
 */
export const voxelize = (triangles: TriangleSoup, resolution: number, insideAtEdge?: (x: number, y: number, z: number) => boolean): VoxelGrid | null => {
  const bounds = soupBounds(triangles);
  if (!bounds) return null;
  const extent = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
  const longest = Math.max(...extent);
  if (!(longest > 0) || !Number.isFinite(longest)) return null;
  let size = longest / resolution;
  const cells = (edge: number): [number, number, number] => [
    Math.ceil(extent[0] / edge) + MARGIN * 2,
    Math.ceil(extent[1] / edge) + MARGIN * 2,
    Math.ceil(extent[2] / edge) + MARGIN * 2,
  ];
  let [nx, ny, nz] = cells(size);
  while (nx * ny * nz > MAX_VOXELS) {
    size *= 1.25;
    [nx, ny, nz] = cells(size);
  }
  const grid: VoxelGrid = {
    nx,
    ny,
    nz,
    ox: bounds.min[0] - size * MARGIN,
    oy: bounds.min[1] - size * MARGIN,
    oz: bounds.min[2] - size * MARGIN,
    size,
    solid: new Uint8Array(nx * ny * nz),
    surface: new Uint8Array(nx * ny * nz),
  };
  markSurface(grid, triangles);
  fillInside(grid, insideAtEdge);
  return grid;
};
