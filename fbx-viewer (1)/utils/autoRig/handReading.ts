import type { Point } from './bodyMarkers';
import { voxelIndex, voxelize, type TriangleSoup, type VoxelGrid } from './voxels';

/**
 * Finds where the fingers go in a hand, from the mesh around it. A hand is read in its own frame: along
 * from the wrist to the fingertips, across towards the thumb, and through from the back to the palm.
 * Fingers that stand apart are found where they are. Many meshes have a hand as a mitten, its fingers
 * grown together, and those are shared out across its width, as a person would mark them on it. Each
 * finger ends where the outline of the hand does, and sits in the middle of the hand's thickness.
 */

export type FingerName = 'Thumb' | 'Index' | 'Middle' | 'Ring' | 'Pinky';

/** Four places along a finger from its root to its tip. */
export interface FingerReading {
  name: FingerName;
  joints: [Point, Point, Point, Point];
}

/** Voxels along a hand. */
const HAND_RESOLUTION = 96;
/** How far around the hand to take triangles, in hand lengths. */
const HAND_ZONE = 1.3;
/** Where a finger's root is along it, as rigs made by people place it. */
const FINGER_ROOT_ALONG = 0.57;
/** Where fingers are looked for along the hand, in hand lengths: past the thumb, short of the tips. */
const FINGERS_FROM = 0.68;
const FINGERS_TO = 0.86;
/** The share of the hand's length past which the palm has given way to the fingers. */
const PALM_END = 0.6;
/** The thumb's root from the wrist, in hand lengths: along it, towards the thumb, and through it. */
const THUMB_ROOT: [number, number, number] = [0.23, 0.12, 0.07];
/** Shares of the way from the thumb's root to its tip of its two middle joints. */
const THUMB_JOINTS: [number, number] = [0.43, 0.77];
/** A piece of the slice where the fingers start is the end of a thumb if it is under this share of the slice. */
const THUMB_SLIVER = 0.1;
/** A hand must stick out this far past the palm's edge, in hand widths, for that to be a thumb. */
const THUMB_STANDS_OUT = 0.1;
/** Thinnest a hand may be for its fingers to be read, in voxels across. */
const LEAST_WIDTH = 6;

const dot = (a: Point, b: Point): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const minus = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (a: Point): Point => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};

/** The hand's axes, in a body facing +Z: along it, towards the thumb, and from the back to the palm. */
const handAxes = (wrist: Point, tip: Point): { along: Point; across: Point; through: Point; length: number } => {
  const toTip = minus(tip, wrist);
  const along = unit(toTip);
  // The thumb is to the front of a hand held out or lowered.
  const across = unit([-along[2] * along[0], -along[2] * along[1], 1 - along[2] * along[2]]);
  // Side by side the palms face down, whichever hand this is.
  let through: Point = [along[1] * across[2] - along[2] * across[1], along[2] * across[0] - along[0] * across[2], along[0] * across[1] - along[1] * across[0]];
  if (through[1] > 0) through = [-through[0], -through[1], -through[2]];
  return { along, across, through, length: Math.hypot(toTip[0], toTip[1], toTip[2]) };
};

/** Each connected piece of a slice along the hand, as its lowest and highest place across and through, and its size. */
interface SlicePiece {
  area: number;
  lowY: number;
  highY: number;
  lowZ: number;
  highZ: number;
}

const piecesOfSlice = (grid: VoxelGrid, mask: Uint8Array, x: number): SlicePiece[] => {
  const seen = new Uint8Array(grid.ny * grid.nz);
  const pieces: SlicePiece[] = [];
  for (let z = 0; z < grid.nz; z += 1) {
    for (let y = 0; y < grid.ny; y += 1) {
      if (seen[y + z * grid.ny] || !mask[voxelIndex(grid, x, y, z)]) continue;
      const piece: SlicePiece = { area: 0, lowY: y, highY: y, lowZ: z, highZ: z };
      const stack: [number, number][] = [[y, z]];
      seen[y + z * grid.ny] = 1;
      while (stack.length) {
        const [py, pz] = stack.pop()!;
        piece.area += 1;
        piece.lowY = Math.min(piece.lowY, py);
        piece.highY = Math.max(piece.highY, py);
        piece.lowZ = Math.min(piece.lowZ, pz);
        piece.highZ = Math.max(piece.highZ, pz);
        for (const [dy, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const qy = py + dy;
          const qz = pz + dz;
          if (qy < 0 || qz < 0 || qy >= grid.ny || qz >= grid.nz || seen[qy + qz * grid.ny] || !mask[voxelIndex(grid, x, qy, qz)]) continue;
          seen[qy + qz * grid.ny] = 1;
          stack.push([qy, qz]);
        }
      }
      pieces.push(piece);
    }
  }
  return pieces;
};

/** The piece of the grid holding one voxel, reached through the body. */
const pieceAround = (grid: VoxelGrid, start: number): Uint8Array => {
  const { solid, nx, ny } = grid;
  const stride = nx * ny;
  const mask = new Uint8Array(solid.length);
  if (!solid[start]) return mask;
  const stack = [start];
  mask[start] = 1;
  while (stack.length) {
    const index = stack.pop()!;
    for (const step of [1, -1, nx, -nx, stride, -stride]) {
      const other = index + step;
      if (other < 0 || other >= solid.length || !solid[other] || mask[other]) continue;
      mask[other] = 1;
      stack.push(other);
    }
  }
  return mask;
};

/**
 * Where the fingers of a hand go, in the triangles' space, from the wrist and the tip of the hand. Null
 * when what is past the wrist is too small or too odd to hold fingers: the hand stays one bone.
 */
export const readFingers = (triangles: TriangleSoup, wrist: Point, tip: Point): FingerReading[] | null => {
  const { along, across, through, length } = handAxes(wrist, tip);
  if (!(length > 0)) return null;
  const zone = length * HAND_ZONE;

  // The triangles around the hand, in the hand's frame.
  const local: number[] = [];
  const corner: Point = [0, 0, 0];
  for (let t = 0; t + 8 < triangles.length; t += 9) {
    let inside = true;
    const placed: number[] = [];
    for (let c = 0; c < 3 && inside; c += 1) {
      corner[0] = triangles[t + c * 3] - wrist[0];
      corner[1] = triangles[t + c * 3 + 1] - wrist[1];
      corner[2] = triangles[t + c * 3 + 2] - wrist[2];
      const s = dot(corner, along);
      const a = dot(corner, across);
      const b = dot(corner, through);
      if (s < -length * 0.1 || s > zone || Math.abs(a) > zone || Math.abs(b) > zone) inside = false;
      placed.push(s, a, b);
    }
    if (inside) local.push(...placed);
  }
  if (local.length < 27) return null;
  const grid = voxelize(Float32Array.from(local), HAND_RESOLUTION);
  if (!grid) return null;
  const toVoxel = (value: number, origin: number): number => Math.floor((value - origin) / grid.size);
  const placeOf = (x: number, y: number, z: number): Point => {
    const s = grid.ox + (x + 0.5) * grid.size;
    const a = grid.oy + (y + 0.5) * grid.size;
    const b = grid.oz + (z + 0.5) * grid.size;
    return [
      wrist[0] + along[0] * s + across[0] * a + through[0] * b,
      wrist[1] + along[1] * s + across[1] * a + through[1] * b,
      wrist[2] + along[2] * s + across[2] * a + through[2] * b,
    ];
  };

  // Only what is joined to the wrist is the hand: a thigh it hangs beside is not.
  const clamp = (value: number, high: number): number => Math.max(0, Math.min(high, value));
  const wristX = clamp(toVoxel(0, grid.ox), grid.nx - 1);
  const wristY = clamp(toVoxel(0, grid.oy), grid.ny - 1);
  const wristZ = clamp(toVoxel(0, grid.oz), grid.nz - 1);
  // The nearest of the hand's voxels to the middle of the wrist, as the cut arm may be hollow here.
  let start = -1;
  let startGap = Infinity;
  for (let z = 0; z < grid.nz; z += 1) {
    for (let y = 0; y < grid.ny; y += 1) {
      const index = voxelIndex(grid, wristX, y, z);
      const gap = (y - wristY) ** 2 + (z - wristZ) ** 2;
      if (grid.solid[index] && gap < startGap) {
        startGap = gap;
        start = index;
      }
    }
  }
  if (start < 0) return null;
  const mask = pieceAround(grid, start);
  const xOf = (share: number): number => clamp(toVoxel(share * length, grid.ox), grid.nx - 1);

  // The hand's width where the palm gives way to the fingers: all of that slice, whose fingers may
  // already stand apart, but for a sliver that can only be the end of a long thumb.
  const palmPieces = piecesOfSlice(grid, mask, xOf(PALM_END));
  if (!palmPieces.length) return null;
  const palmArea = palmPieces.reduce((total, piece) => total + piece.area, 0);
  const handPieces = palmPieces.filter((piece) => piece.area >= palmArea * THUMB_SLIVER);
  const palm = {
    lowY: Math.min(...handPieces.map((piece) => piece.lowY)),
    highY: Math.max(...handPieces.map((piece) => piece.highY)),
    lowZ: Math.min(...handPieces.map((piece) => piece.lowZ)),
    highZ: Math.max(...handPieces.map((piece) => piece.highZ)),
  };
  const palmWidth = palm.highY - palm.lowY + 1;
  if (palmWidth < LEAST_WIDTH) return null;

  // Where the fingers are across the hand: the pieces of a slice past the thumb, if they stand apart.
  let apart: SlicePiece[] = [];
  for (let x = xOf(FINGERS_FROM); x <= xOf(FINGERS_TO); x += 1) {
    const pieces = piecesOfSlice(grid, mask, x).filter((piece) => piece.area >= 2);
    if (pieces.length > apart.length && pieces.length <= 4) apart = pieces;
  }
  const centres: number[] = apart.length === 4
    ? apart.map((piece) => (piece.lowY + piece.highY) / 2).sort((a, b) => b - a)
    : [0.875, 0.625, 0.375, 0.125].map((share) => palm.lowY + palmWidth * share);
  const halfBand = Math.max(1, palmWidth / 8);

  // Each finger runs as far along the hand as the hand goes in its band, in the middle of the hand's thickness.
  const NAMES: FingerName[] = ['Index', 'Middle', 'Ring', 'Pinky'];
  const fingers: FingerReading[] = [];
  const middleThrough = (x: number, y: number, band = halfBand): number | null => {
    let low = Infinity;
    let high = -Infinity;
    for (let by = Math.max(0, Math.round(y - band)); by <= Math.min(grid.ny - 1, Math.round(y + band)); by += 1) {
      for (let z = 0; z < grid.nz; z += 1) {
        if (!mask[voxelIndex(grid, x, by, z)]) continue;
        if (z < low) low = z;
        if (z > high) high = z;
      }
    }
    return high >= low ? (low + high) / 2 : null;
  };
  for (let finger = 0; finger < 4; finger += 1) {
    const y = centres[finger];
    let end = -1;
    for (let x = grid.nx - 1; x >= xOf(PALM_END) && end < 0; x -= 1) if (middleThrough(x, y, halfBand / 2) !== null) end = x;
    if (end < 0) return null;
    const wristAt = toVoxel(0, grid.ox);
    const root = wristAt + (end - wristAt) * FINGER_ROOT_ALONG;
    const joints = [0, 1 / 3, 2 / 3, 1].map((share) => {
      const x = Math.round(root + (end - root) * share);
      return placeOf(x, y, middleThrough(x, y) ?? (palm.lowZ + palm.highZ) / 2);
    }) as [Point, Point, Point, Point];
    fingers.push({ name: NAMES[finger], joints });
  }

  // The thumb: the part of the hand standing furthest out past the palm's edge on the thumb's side.
  let thumbTip: [number, number, number] | null = null;
  const palmEdge = palm.highY + palmWidth * THUMB_STANDS_OUT;
  for (let x = xOf(0.1); x <= xOf(FINGERS_TO); x += 1) {
    for (let y = grid.ny - 1; y > palmEdge; y -= 1) {
      let found = false;
      for (let z = 0; z < grid.nz && !found; z += 1) {
        if (!mask[voxelIndex(grid, x, y, z)]) continue;
        found = true;
        if (!thumbTip || y > thumbTip[1]) thumbTip = [x, y, z];
      }
      if (found) break;
    }
  }
  if (thumbTip) {
    const [tipX, tipY] = thumbTip;
    const tipZ = middleThrough(tipX, tipY) ?? thumbTip[2];
    const rootPlace = placeOf(toVoxel(length * THUMB_ROOT[0], grid.ox), toVoxel(length * THUMB_ROOT[1], grid.oy), toVoxel(length * THUMB_ROOT[2], grid.oz));
    const tipPlace = placeOf(tipX, tipY, tipZ);
    const at = (share: number): Point => [
      rootPlace[0] + (tipPlace[0] - rootPlace[0]) * share,
      rootPlace[1] + (tipPlace[1] - rootPlace[1]) * share,
      rootPlace[2] + (tipPlace[2] - rootPlace[2]) * share,
    ];
    fingers.unshift({ name: 'Thumb', joints: [rootPlace, at(THUMB_JOINTS[0]), at(THUMB_JOINTS[1]), tipPlace] });
  }
  return fingers;
};
