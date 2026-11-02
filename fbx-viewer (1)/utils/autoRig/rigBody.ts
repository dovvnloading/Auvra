import { largestPiece } from './bodyField';
import { turnAboutY, turnSoupAboutY, type BodyExtents, type BodyMarkers, type BodyReading, type MarkerName, type Point } from './bodyMarkers';
import { bodySkeleton, turnJointsAboutY, type RigJoint } from './bodySkeleton';
import { bindSkin, type PartWeights, type SkinnedPart } from './skinWeights';
import { soupBounds, voxelIndex, voxelize, voxelOf, type TriangleSoup, type VoxelGrid } from './voxels';

/**
 * Fits a skeleton and skin weights to a body from where its markers are. A marker is placed in front
 * view, so one a person has moved is put back in the middle of the limb at its new place.
 */

/** Voxels along the longest side when finding a limb's middle. */
const CENTRING_RESOLUTION = 180;
/** Columns looked at around a marker that has landed just off the body. */
const CENTRING_REACH = 4;

/** The middle, front to back, of the part of the body at `point`, keeping nearest its present depth. */
const centreInDepth = (grid: VoxelGrid, mask: Uint8Array, point: Point): Point => {
  const [cx, cy, cz] = voxelOf(grid, point[0], point[1], point[2]);
  for (let reach = 0; reach <= CENTRING_REACH; reach += 1) {
    let best: number | null = null;
    let bestGap = Infinity;
    for (let dy = -reach; dy <= reach; dy += 1) {
      for (let dx = -reach; dx <= reach; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== reach) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= grid.nx || y >= grid.ny) continue;
        // Each run of body voxels along this column.
        let from = -1;
        for (let z = 0; z <= grid.nz; z += 1) {
          const inside = z < grid.nz && mask[voxelIndex(grid, x, y, z)];
          if (inside && from < 0) from = z;
          if (!inside && from >= 0) {
            const middle = (from + z - 1) / 2;
            const gap = Math.abs(middle - cz);
            if (gap < bestGap) {
              bestGap = gap;
              best = middle;
            }
            from = -1;
          }
        }
      }
    }
    if (best !== null) return [point[0], point[1], grid.oz + (best + 0.5) * grid.size];
  }
  return point;
};

/** What a person standing in this box might be: for a mesh that does not read as one, a start for placing the markers by hand. */
export const standardReading = (triangles: TriangleSoup): BodyReading | null => {
  const bounds = soupBounds(triangles);
  if (!bounds) return null;
  const { min, max } = bounds;
  const height = max[1] - min[1];
  if (!(height > 0)) return null;
  const x = (min[0] + max[0]) / 2;
  const z = (min[2] + max[2]) / 2;
  const at = (across: number, up: number): Point => [x + across * height, min[1] + up * height, z];
  // Arms reach as far as the box does, up to what arms can.
  const reach = Math.min(0.46, Math.max(0.3, (max[0] - min[0]) / height / 2));
  const armAt = (share: number, side: number): Point => at(side * (0.1 + (reach - 0.1) * share), 0.8 - 0.08 * share * (reach < 0.4 ? 1 : 0));
  return {
    facing: [0, 1],
    markers: {
      chin: at(0, 0.87),
      groin: at(0, 0.47),
      leftShoulder: armAt(0, 1),
      rightShoulder: armAt(0, -1),
      leftElbow: armAt(0.37, 1),
      rightElbow: armAt(0.37, -1),
      leftWrist: armAt(0.74, 1),
      rightWrist: armAt(0.74, -1),
      leftKnee: at(0.07, 0.3),
      rightKnee: at(-0.07, 0.3),
      leftAnkle: at(0.08, 0.07),
      rightAnkle: at(-0.08, 0.07),
    },
    extents: {
      headTop: at(0, 1),
      leftHandTip: armAt(1, 1),
      rightHandTip: armAt(1, -1),
      leftToe: [x + 0.08 * height, min[1], z + 0.1 * height],
      rightToe: [x - 0.08 * height, min[1], z + 0.1 * height],
      floor: min[1],
    },
  };
};

/** Hand tips follow their wrists when a person moves those: keeps a hand's length and direction from the forearm. */
const followWrist = (oldWrist: Point, wrist: Point, tip: Point): Point => [
  tip[0] + wrist[0] - oldWrist[0],
  tip[1] + wrist[1] - oldWrist[1],
  tip[2] + wrist[2] - oldWrist[2],
];

export interface RiggedBody {
  joints: RigJoint[];
  weights: PartWeights[];
}

/**
 * The skeleton for `reading`'s markers, with `moved` ones put back in the limb's middle, and its
 * weights on `parts`. `original` holds where the markers were before they were moved, if any were;
 * everything is in the mesh's space.
 */
export const rigBody = (
  triangles: TriangleSoup,
  parts: readonly SkinnedPart[],
  reading: BodyReading,
  moved: readonly MarkerName[],
  onProgress?: (share: number) => void,
  original?: BodyMarkers,
): RiggedBody => {
  // Everything is worked out on a body turned to face +Z, then turned back.
  const cos = reading.facing[1];
  const sin = -reading.facing[0];
  const square = sin === 0 && cos === 1;
  const uprightTriangles = square ? triangles : turnSoupAboutY(triangles, sin, cos);
  const up = (point: Point): Point => (square ? point : turnAboutY(point, sin, cos));
  const markers = Object.fromEntries(Object.entries(reading.markers).map(([name, point]) => [name, up(point)])) as unknown as BodyMarkers;
  const extents: BodyExtents = {
    headTop: up(reading.extents.headTop),
    leftHandTip: up(reading.extents.leftHandTip),
    rightHandTip: up(reading.extents.rightHandTip),
    leftToe: up(reading.extents.leftToe),
    rightToe: up(reading.extents.rightToe),
    floor: reading.extents.floor,
  };
  if (moved.length) {
    const grid = voxelize(uprightTriangles, CENTRING_RESOLUTION);
    if (grid) {
      const mask = largestPiece(grid);
      for (const name of moved) markers[name] = centreInDepth(grid, mask, markers[name]);
    }
    if (original) {
      if (moved.includes('leftWrist')) extents.leftHandTip = followWrist(up(original.leftWrist), markers.leftWrist, extents.leftHandTip);
      if (moved.includes('rightWrist')) extents.rightHandTip = followWrist(up(original.rightWrist), markers.rightWrist, extents.rightHandTip);
    }
  }
  onProgress?.(0.05);
  const joints = bodySkeleton(markers, extents);
  const uprightParts = square ? parts : parts.map((part) => ({ ...part, positions: turnSoupAboutY(part.positions, sin, cos) }));
  const weights = bindSkin(uprightTriangles, joints, uprightParts, (share) => onProgress?.(0.05 + share * 0.95));
  return { joints: square ? joints : turnJointsAboutY(joints, -sin, cos), weights };
};
