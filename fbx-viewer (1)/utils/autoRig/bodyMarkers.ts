import { distanceThrough, distanceToSkin, largestPiece, neighboursOf, pathsAlongMiddle, pathTo, UNREACHED, type Neighbours } from './bodyField';
import { voxelize, type TriangleSoup, type VoxelGrid } from './voxels';

/**
 * Finds where a person's joints are from their mesh alone, for rigging a mesh that came without a
 * skeleton. The mesh is read as a solid body standing with its arms out to the sides or lowered:
 * the points furthest apart through the body are the hands, the feet and the top of the head, the
 * lines down the middle of the limbs lead to them, and the joints sit along those lines where the
 * limb's shape says so, or else where a person's proportions put them.
 */

export type Point = [number, number, number];

/** The joints a person places to fit a skeleton to a body. */
export interface BodyMarkers {
  chin: Point;
  groin: Point;
  leftShoulder: Point;
  rightShoulder: Point;
  leftElbow: Point;
  rightElbow: Point;
  leftWrist: Point;
  rightWrist: Point;
  leftKnee: Point;
  rightKnee: Point;
  leftAnkle: Point;
  rightAnkle: Point;
}

export type MarkerName = keyof BodyMarkers;

/** What else a skeleton needs to know of the body, found along with the markers. */
export interface BodyExtents {
  headTop: Point;
  leftHandTip: Point;
  rightHandTip: Point;
  leftToe: Point;
  rightToe: Point;
  floor: number;
}

export interface BodyReading {
  markers: BodyMarkers;
  extents: BodyExtents;
  /** The way the figure faces, a unit vector in the ground plane as x and z. */
  facing: [number, number];
}

/** Voxels along the longest side when reading the body. */
const READ_RESOLUTION = 180;
/** Tips looked at: the five a person has, and a few for capes, hair and held things. */
const TIPS_TRIED = 9;

/**
 * A person's parts as shares of their height, as rigs made by people and by rigging tools place them
 * (and they agree to within a few parts in a hundred).
 */
const PROPORTION = {
  /** Where the crotch is from the floor: for a figure this many heads tall, and for the shortest we expect. */
  crotchUsual: 0.47,
  crotchUsualHeads: 7,
  crotchShort: 0.3,
  crotchShortHeads: 3,
  crotchHigh: 0.62,
  /** Highest an ankle is looked for, and how far above the narrowing it finds the joint is. */
  ankleHigh: 0.15,
  ankleUsual: 0.07,
  ankleAboveNarrowing: 0.025,
  /** The knee's place from ankle to hip joint. */
  kneeAlongLeg: 0.51,
  /** How far in front of the leg's middle a knee is. */
  kneeForward: 0.015,
  /** The hip joint above the crotch. */
  hipAboveCrotch: 0.05,
  /** How much of the arm from the shoulder to the fingertips is before the wrist. */
  wristAlongArm: 0.74,
  /** How much of the arm from the shoulder to the wrist is before the elbow. */
  elbowAlongArm: 0.5,
  /** How far a cut across an arm reaches up and down before it has met the body. */
  armCutReach: 0.2,
  /** Where a shoulder joint can be from the body's middle. */
  shoulderFar: 0.2,
  /** The chin below the top of the head when no neck can be told from the head, and how far to look. */
  chinUsual: 0.13,
  chinNear: 0.09,
  chinFar: 0.45,
} as const;

/** A voxel's x, y and z indices. */
const cellOf = (grid: VoxelGrid, index: number): Point => {
  const stride = grid.nx * grid.ny;
  const z = Math.floor(index / stride);
  const rest = index - z * stride;
  const y = Math.floor(rest / grid.nx);
  return [rest - y * grid.nx, y, z];
};

/** Places in voxel indices to places in space. */
const placeOf = (grid: VoxelGrid, cell: Point): Point => [
  grid.ox + (cell[0] + 0.5) * grid.size,
  grid.oy + (cell[1] + 0.5) * grid.size,
  grid.oz + (cell[2] + 0.5) * grid.size,
];

const pointOf = (grid: VoxelGrid, index: number): Point => placeOf(grid, cellOf(grid, index));

const stepLength = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** `point` turned about the Y axis by the angle with this sine and cosine. */
export const turnAboutY = (point: Point, sin: number, cos: number): Point => [point[0] * cos + point[2] * sin, point[1], point[2] * cos - point[0] * sin];

/** A soup of xyz triples turned about the Y axis. */
export const turnSoupAboutY = (points: ArrayLike<number>, sin: number, cos: number): Float32Array => {
  const out = new Float32Array(points.length);
  for (let i = 0; i + 2 < points.length; i += 3) {
    const x = points[i];
    const z = points[i + 2];
    out[i] = x * cos + z * sin;
    out[i + 1] = points[i + 1];
    out[i + 2] = z * cos - x * sin;
  }
  return out;
};

/**
 * The points of the body furthest from each other through it. Each new tip is the voxel furthest
 * from all those found so far.
 */
const farTips = (mask: Uint8Array, neighbours: Neighbours, count: number): number[] => {
  let start = -1;
  for (let index = 0; index < mask.length && start < 0; index += 1) if (mask[index]) start = index;
  if (start < 0) return [];
  const furthest = (field: Uint32Array): number => {
    let best = -1;
    let bestValue = -1;
    for (let index = 0; index < field.length; index += 1) {
      const value = field[index];
      if (value !== UNREACHED && value > bestValue) {
        bestValue = value;
        best = index;
      }
    }
    return best;
  };
  const field = new Uint32Array(mask.length);
  const nearestTip = new Uint32Array(mask.length).fill(UNREACHED);
  const tips: number[] = [];
  distanceThrough(mask, neighbours, [start], field);
  let next = furthest(field);
  for (let i = 0; i < count && next >= 0; i += 1) {
    tips.push(next);
    distanceThrough(mask, neighbours, [next], field);
    for (let index = 0; index < field.length; index += 1) if (field[index] < nearestTip[index]) nearestTip[index] = field[index];
    next = furthest(nearestTip);
  }
  return tips;
};

/** Which way a voxel slice runs: its fixed axis. 0 cuts the body across X, 1 across Y. */
type SliceAxis = 0 | 1;

interface Slice {
  /** Voxels in the piece of the slice holding the starting voxel. */
  area: number;
  /** Middle of those voxels, in voxel indices on the whole grid. */
  centre: Point;
  /** Lowest and highest place of the piece along each axis, in voxel indices. */
  low: Point;
  high: Point;
}

/** The connected piece of a slice of the body around a voxel, kept to one side of `side.from` if given (for legs grown together). */
const sliceAround = (grid: VoxelGrid, mask: Uint8Array, axis: SliceAxis, x: number, y: number, z: number, side: { from: number; sign: number } | null = null): Slice | null => {
  const { nx, ny } = grid;
  const stride = nx * ny;
  const first = Math.round(x) + Math.round(y) * nx + Math.round(z) * stride;
  if (!mask[first]) return null;
  const stepA = axis === 0 ? nx : 1;
  const stepB = stride;
  const seen = new Set<number>([first]);
  const queue = [first];
  let area = 0;
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  const low: Point = [Infinity, Infinity, Infinity];
  const high: Point = [-Infinity, -Infinity, -Infinity];
  while (queue.length) {
    const index = queue.pop()!;
    const [vx, vy, vz] = cellOf(grid, index);
    area += 1;
    sumX += vx;
    sumY += vy;
    sumZ += vz;
    low[0] = Math.min(low[0], vx); low[1] = Math.min(low[1], vy); low[2] = Math.min(low[2], vz);
    high[0] = Math.max(high[0], vx); high[1] = Math.max(high[1], vy); high[2] = Math.max(high[2], vz);
    for (const step of [stepA, -stepA, stepB, -stepB]) {
      const other = index + step;
      if (other < 0 || other >= mask.length || !mask[other] || seen.has(other)) continue;
      if (side && ((other % nx) - side.from) * side.sign < 0) continue;
      seen.add(other);
      queue.push(other);
    }
  }
  return { area, centre: [sumX / area, sumY / area, sumZ / area], low, high };
};

interface LegReading {
  ankle: Point;
  knee: Point;
  toe: Point;
  /** Middle of the leg at the top of the thigh, in voxel indices. */
  hipCell: Point;
}

/** Reads one leg, in voxel indices up to `crotch`. `sign` is the side of the body it is on, from `middleX`. */
const readLeg = (grid: VoxelGrid, mask: Uint8Array, path: readonly number[], bottom: number, crotch: number, voxels: number, middleX: number, sign: number): LegReading | null => {
  const cells = path.map((index) => cellOf(grid, index));
  const side = { from: middleX, sign };
  // The leg's middle at a height: the path's voxel there, first time it gets there from the foot.
  const atHeight = (y: number): Point | null => {
    for (const cell of cells) {
      if (cell[1] === y) return cell;
      if (cell[1] > y) return null;
    }
    return null;
  };
  // The sole's length: the foot's longest run front to back near the floor.
  const lowest = Math.max(1, Math.round(voxels * 0.03));
  let footSlice: Slice | null = null;
  for (let y = bottom; y <= bottom + lowest; y += 1) {
    const cell = atHeight(y) ?? cells[0];
    const slice = sliceAround(grid, mask, 1, cell[0], y, cell[2], side);
    if (slice && (!footSlice || slice.high[2] - slice.low[2] > footSlice.high[2] - footSlice.low[2])) footSlice = slice;
  }
  if (!footSlice) return null;
  const footLength = footSlice.high[2] - footSlice.low[2] + 1;
  // The ankle: a little above the first height whose slice is well shorter than the sole.
  const ankleHigh = bottom + Math.round(voxels * PROPORTION.ankleHigh);
  let ankleY = bottom + Math.round(voxels * PROPORTION.ankleUsual);
  for (let y = bottom + lowest; y <= ankleHigh; y += 1) {
    const cell = atHeight(y);
    if (!cell) continue;
    const slice = sliceAround(grid, mask, 1, cell[0], y, cell[2], side);
    if (slice && slice.high[2] - slice.low[2] + 1 < footLength * 0.62) {
      ankleY = y + Math.round(voxels * PROPORTION.ankleAboveNarrowing);
      break;
    }
  }
  const middleOf = (y: number): Point | null => {
    const cell = atHeight(y);
    if (!cell) return null;
    const slice = sliceAround(grid, mask, 1, cell[0], y, cell[2], side);
    return slice ? slice.centre : cell;
  };
  const ankleCell = middleOf(ankleY);
  if (!ankleCell) return null;
  // The toes: as far forward as the sole goes.
  const toeCell: Point = [ankleCell[0], bottom + 1, footSlice.high[2]];
  const hipY = crotch + Math.round(voxels * PROPORTION.hipAboveCrotch);
  const kneeY = Math.round(ankleY + (hipY - ankleY) * PROPORTION.kneeAlongLeg);
  const kneeCell = middleOf(kneeY);
  if (!kneeCell) return null;
  const thighCell = middleOf(Math.max(ankleY + 1, crotch - Math.round(voxels * 0.03))) ?? kneeCell;
  return {
    ankle: placeOf(grid, ankleCell),
    knee: placeOf(grid, [kneeCell[0], kneeCell[1], kneeCell[2] + voxels * PROPORTION.kneeForward]),
    toe: placeOf(grid, toeCell),
    hipCell: [thighCell[0], hipY, thighCell[2]],
  };
};

interface ArmReading {
  shoulder: Point;
  elbow: Point;
  wrist: Point;
  tip: Point;
}

/** Reads one arm from its path, tip first, using cuts across X; `sign` is the side of the body it is on. */
const readArm = (grid: VoxelGrid, mask: Uint8Array, path: readonly number[], middleX: number, sign: number, voxels: number): ArmReading | null => {
  const cells = path.map((index) => cellOf(grid, index));
  // Cross-sections from the hand in: each x once, as the path first reaches it.
  const cuts: { x: number; slice: Slice; along: number }[] = [];
  let along = 0;
  let lastX = Infinity * sign;
  for (let i = 0; i < cells.length; i += 1) {
    if (i > 0) along += stepLength(cells[i], cells[i - 1]);
    const cell = cells[i];
    if ((cell[0] - lastX) * sign >= 0) continue;
    lastX = cell[0];
    if ((cell[0] - middleX) * sign < voxels * 0.03) break;
    const slice = sliceAround(grid, mask, 0, cell[0], cell[1], cell[2]);
    if (slice) cuts.push({ x: cell[0], slice, along });
  }
  if (cuts.length < 5) return null;
  // The armpit: the first cut that reaches far up and down, as only one through the body does.
  const furthest = middleX + sign * voxels * PROPORTION.shoulderFar;
  let shoulderAt = cuts.findIndex((cut, i) => i > 1 && (cut.x - furthest) * sign <= 0 && cut.slice.high[1] - cut.slice.low[1] > voxels * PROPORTION.armCutReach);
  if (shoulderAt < 0) {
    // No armpit to go by: take the far limit of where shoulders are.
    shoulderAt = cuts.findIndex((cut) => (cut.x - furthest) * sign <= 0);
    if (shoulderAt < 0) shoulderAt = cuts.length - 1;
  }
  // How thick the arm is: the middle value of the cuts outside the armpit.
  const areas = cuts.slice(0, Math.max(1, shoulderAt)).map((cut) => cut.slice.area).sort((a, b) => a - b);
  const armArea = areas[Math.floor(areas.length / 2)];
  // The arm's middle just outside the armpit gives the shoulder's height and depth.
  const outside = cuts[Math.max(0, shoulderAt - 2)];
  const shoulderCell: Point = [cuts[shoulderAt].x, outside.slice.centre[1], outside.slice.centre[2]];
  const shoulderAlong = cuts[shoulderAt].along;
  if (!(shoulderAlong > 0)) return null;

  // Along the arm's own line from the shoulder towards the tip.
  const placeAlong = (share: number): Point => {
    const wanted = shoulderAlong * (1 - share);
    let distance = 0;
    for (let i = 1; i < cells.length; i += 1) {
      const step = stepLength(cells[i], cells[i - 1]);
      if (distance + step >= wanted) {
        const slice = sliceAround(grid, mask, 0, cells[i][0], cells[i][1], cells[i][2]);
        return slice && slice.area < armArea * 2 ? slice.centre : cells[i];
      }
      distance += step;
    }
    return cells[cells.length - 1];
  };

  // The wrist: the thinnest cut around where wrists are, if it is clearly thinner than the rest.
  let wristShare: number = PROPORTION.wristAlongArm;
  let thinnest = Infinity;
  for (const cut of cuts) {
    const share = 1 - cut.along / shoulderAlong;
    if (share < 0.66 || share > 0.82) continue;
    if (cut.slice.area < thinnest) {
      thinnest = cut.slice.area;
      if (thinnest < armArea * 0.7) wristShare = share;
    }
  }
  return {
    shoulder: placeOf(grid, shoulderCell),
    elbow: placeOf(grid, placeAlong(wristShare * PROPORTION.elbowAlongArm)),
    wrist: placeOf(grid, placeAlong(wristShare)),
    tip: placeOf(grid, cells[0]),
  };
};

/** The chin's height: the narrowest place below the head, in voxel indices on the grid. */
const readChinY = (grid: VoxelGrid, mask: Uint8Array, path: readonly number[], top: number, voxels: number): number => {
  const cells = path.map((index) => cellOf(grid, index));
  const atHeight = (y: number): Point | null => {
    for (const cell of cells) {
      if (cell[1] === y) return cell;
      if (cell[1] < y) return null;
    }
    return null;
  };
  const near = top - Math.round(voxels * PROPORTION.chinNear);
  const far = top - Math.round(voxels * PROPORTION.chinFar);
  let widest = 0;
  let thinnest = Infinity;
  let thinnestY = -1;
  for (let y = top - 1; y >= far; y -= 1) {
    const cell = atHeight(y);
    if (!cell) continue;
    const slice = sliceAround(grid, mask, 1, cell[0], y, cell[2]);
    if (!slice) continue;
    if (thinnestY >= 0 && slice.area > thinnest * 1.6) {
      // A narrowing has opened out again into the shoulders, or it was no more than a dent in the head.
      if (thinnest < widest * 0.8) return thinnestY;
      thinnestY = -1;
    }
    widest = Math.max(widest, slice.area);
    if (y <= near && (thinnestY < 0 || slice.area < thinnest)) {
      thinnest = slice.area;
      thinnestY = y;
    }
  }
  return top - Math.round(voxels * PROPORTION.chinUsual);
};

/** How a mesh's tips read as a person's: which is which. */
interface Tips {
  head: number;
  leftHand: number;
  rightHand: number;
  leftFoot: number;
  rightFoot: number;
}

/** Sorts the tips into a head, two hands and two feet, or says the body is not a person's. */
const sortTips = (grid: VoxelGrid, tips: readonly number[], bottom: number, top: number): Tips | null => {
  const height = top - bottom;
  if (height < 8) return null;
  const all = tips.map((tip) => ({ tip, cell: cellOf(grid, tip) }));
  // Feet: the two low tips furthest apart from side to side. Their middle is the body's.
  const low = all.filter(({ cell }) => cell[1] < bottom + height * 0.2).sort((a, b) => a.cell[0] - b.cell[0]);
  if (low.length < 2) return null;
  const rightFoot = low[0];
  const leftFoot = low[low.length - 1];
  const middle = (rightFoot.cell[0] + leftFoot.cell[0]) / 2;
  if (leftFoot.cell[0] - rightFoot.cell[0] < height * 0.02) return null;
  const others = all.filter(({ tip, cell }) => tip !== leftFoot.tip && tip !== rightFoot.tip && cell[1] > bottom + height * 0.3);
  const hand = (sign: number) => {
    let best: (typeof others)[number] | null = null;
    for (const other of others) {
      const reach = (other.cell[0] - middle) * sign;
      if (reach < height * 0.1) continue;
      if (!best || reach > (best.cell[0] - middle) * sign) best = other;
    }
    return best;
  };
  const leftHand = hand(1);
  const rightHand = hand(-1);
  if (!leftHand || !rightHand) return null;
  let head: (typeof others)[number] | null = null;
  for (const other of others) {
    if (other === leftHand || other === rightHand) continue;
    if (Math.abs(other.cell[0] - middle) > height * 0.15 || other.cell[1] < bottom + height * 0.6) continue;
    if (!head || other.cell[1] > head.cell[1]) head = other;
  }
  if (!head) return null;
  return { head: head.tip, leftHand: leftHand.tip, rightHand: rightHand.tip, leftFoot: leftFoot.tip, rightFoot: rightFoot.tip };
};

/** The lowest and highest voxel layers of a mask. */
const heightsOf = (grid: VoxelGrid, mask: Uint8Array): { bottom: number; top: number } => {
  let bottom = grid.ny;
  let top = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const y = Math.floor(index / grid.nx) % grid.ny;
    if (y < bottom) bottom = y;
    if (y > top) top = y;
  }
  return { bottom, top };
};

/** Reach of the soles forward of the ankles, along `facing`: negative when they reach further back. */
const solesAhead = (grid: VoxelGrid, mask: Uint8Array, facing: [number, number], bottom: number, top: number): number => {
  const measure = (fromY: number, toY: number): { front: number; back: number } | null => {
    let front = -Infinity;
    let back = Infinity;
    for (let index = 0; index < mask.length; index += 1) {
      if (!mask[index]) continue;
      const cell = cellOf(grid, index);
      if (cell[1] < fromY || cell[1] > toY) continue;
      const along = cell[0] * facing[0] + cell[2] * facing[1];
      if (along > front) front = along;
      if (along < back) back = along;
    }
    return front > -Infinity ? { front, back } : null;
  };
  const height = top - bottom;
  const sole = measure(bottom, bottom + height * 0.03);
  const shin = measure(bottom + height * 0.1, bottom + height * 0.2);
  if (!sole || !shin) return 0;
  return (sole.front - shin.front) - (shin.back - sole.back);
};

/**
 * Which way a body faces, from a coarse look at it: square to the line between its hands, on the side
 * its toes point to. Null when its tips do not read as a person's.
 */
const bodyFacing = (grid: VoxelGrid, mask: Uint8Array, tips: readonly number[]): [number, number] | null => {
  const { bottom, top } = heightsOf(grid, mask);
  const height = top - bottom;
  if (!(height > 0)) return null;
  // On the ground plane the two tips furthest apart, high above the floor, are the hands.
  const high = tips.map((tip) => cellOf(grid, tip)).filter((cell) => cell[1] > bottom + height * 0.3);
  let across: [number, number] | null = null;
  let widest = 0;
  for (let i = 0; i < high.length; i += 1) {
    for (let j = i + 1; j < high.length; j += 1) {
      const dx = high[j][0] - high[i][0];
      const dz = high[j][2] - high[i][2];
      const span = dx * dx + dz * dz;
      if (span > widest) {
        widest = span;
        across = [dx, dz];
      }
    }
  }
  if (!across || Math.sqrt(widest) < height * 0.2) return null;
  const length = Math.sqrt(widest);
  let facing: [number, number] = [-across[1] / length, across[0] / length];
  const ahead = solesAhead(grid, mask, facing, bottom, top);
  // Feet that do not say which way they point stand as most models do, looking down +Z.
  if (ahead < 0 || (ahead === 0 && (facing[1] < 0 || (facing[1] === 0 && facing[0] < 0)))) facing = [-facing[0], -facing[1]];
  // A body standing square stays exactly square, so its mesh is not turned for nothing.
  for (const axis of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
    if (facing[0] * axis[0] + facing[1] * axis[1] > 0.97) return [axis[0], axis[1]];
  }
  return facing;
};

/** Two joints' difference from being mirror images, below which it is more likely the reading's than the body's. */
const SIDES_ALIKE = 0.04;

/**
 * Makes a joint and its partner mirror images across `middleX` when they nearly are. A pose that
 * really has them apart keeps them apart.
 */
const evenSides = (left: Point, right: Point, middleX: number, height: number): [Point, Point] => {
  const reach = ((left[0] - middleX) + (middleX - right[0])) / 2;
  const alike = Math.abs((left[0] - middleX) - (middleX - right[0])) < height * SIDES_ALIKE
    && Math.abs(left[1] - right[1]) < height * SIDES_ALIKE
    && Math.abs(left[2] - right[2]) < height * SIDES_ALIKE;
  if (!alike) return [left, right];
  const y = (left[1] + right[1]) / 2;
  const z = (left[2] + right[2]) / 2;
  return [[middleX + reach, y, z], [middleX - reach, y, z]];
};

/**
 * Reads a standing person from `triangles`, in the triangles' space. Null when the mesh does not
 * read as one.
 */
export const readBody = (triangles: TriangleSoup): BodyReading | null => {
  // A first, coarse look finds where the hands and feet are, so the body can be turned to face +Z.
  const coarse = voxelize(triangles, 96);
  if (!coarse) return null;
  const coarseMask = largestPiece(coarse);
  const facing = bodyFacing(coarse, coarseMask, farTips(coarseMask, neighboursOf(coarse), TIPS_TRIED));
  if (!facing) return null;
  // The turn that brings the facing direction to +Z.
  const cos = facing[1];
  const sin = -facing[0];
  const upright = sin === 0 && cos === 1 ? triangles : turnSoupAboutY(triangles, sin, cos);
  const grid = voxelize(upright, READ_RESOLUTION);
  if (!grid) return null;
  const mask = largestPiece(grid);
  const neighbours = neighboursOf(grid);
  const skin = distanceToSkin(grid, mask);
  const { bottom, top } = heightsOf(grid, mask);
  const tips = sortTips(grid, farTips(mask, neighbours, TIPS_TRIED), bottom, top);
  if (!tips) return null;

  const voxels = top - bottom;
  const headCell = cellOf(grid, tips.head);
  const middleX = (cellOf(grid, tips.leftFoot)[0] + cellOf(grid, tips.rightFoot)[0]) / 2;

  // The heart of the body: the thickest place between the waist and the neck.
  let heart = -1;
  let heartDepth = -1;
  const stride = grid.nx * grid.ny;
  const yLow = bottom + Math.round(voxels * 0.5);
  const yHigh = bottom + Math.round(voxels * 0.8);
  const xReach = voxels * 0.15;
  for (let z = 0; z < grid.nz; z += 1) {
    for (let y = yLow; y <= yHigh; y += 1) {
      for (let x = Math.max(0, Math.round(middleX - xReach)); x <= Math.min(grid.nx - 1, Math.round(middleX + xReach)); x += 1) {
        const index = x + y * grid.nx + z * stride;
        if (mask[index] && skin[index] > heartDepth) {
          heartDepth = skin[index];
          heart = index;
        }
      }
    }
  }
  if (heart < 0) return null;
  const previous = pathsAlongMiddle(mask, skin, neighbours, heart);
  const path = (tip: number): number[] => pathTo(previous, tip);

  const leftPath = path(tips.leftFoot);
  const rightPath = path(tips.rightFoot);
  const cellAtHeight = (cells: number[], y: number): Point | null => {
    for (const index of cells) {
      const cell = cellOf(grid, index);
      if (cell[1] === y) return cell;
      if (cell[1] > y) break;
    }
    return null;
  };
  const headPath = path(tips.head);
  const chinY = readChinY(grid, mask, headPath, headCell[1], voxels);
  // Meshes often have their legs grown together below the crotch, so where the legs meet only says
  // where it is when that is higher than a figure with this size of head would have it.
  const heads = voxels / Math.max(1, headCell[1] - chinY);
  const headsShare = Math.max(0, Math.min(1, (heads - PROPORTION.crotchShortHeads) / (PROPORTION.crotchUsualHeads - PROPORTION.crotchShortHeads)));
  let crotch = bottom + Math.round(voxels * (PROPORTION.crotchShort + (PROPORTION.crotchUsual - PROPORTION.crotchShort) * headsShare));
  const crotchHigh = bottom + Math.round(voxels * PROPORTION.crotchHigh);
  for (let y = crotch; y <= crotchHigh; y += 1) {
    const left = cellAtHeight(leftPath, y);
    const right = cellAtHeight(rightPath, y);
    if (!left || !right) continue;
    const slice = sliceAround(grid, mask, 1, left[0], y, left[2]);
    if (slice && slice.low[0] <= right[0] && slice.high[0] >= right[0]) {
      crotch = y;
      break;
    }
  }

  const leftLeg = readLeg(grid, mask, leftPath, bottom, crotch, voxels, middleX, 1);
  const rightLeg = readLeg(grid, mask, rightPath, bottom, crotch, voxels, middleX, -1);
  if (!leftLeg || !rightLeg) return null;
  const leftArm = readArm(grid, mask, path(tips.leftHand), middleX, 1, voxels);
  const rightArm = readArm(grid, mask, path(tips.rightHand), middleX, -1, voxels);
  if (!leftArm || !rightArm) return null;

  const chinPathCell = headPath.map((index) => cellOf(grid, index)).find((cell) => cell[1] <= chinY) ?? headCell;
  const chinSlice = sliceAround(grid, mask, 1, chinPathCell[0], chinPathCell[1], chinPathCell[2]);
  const chinCell: Point = chinSlice ? [chinSlice.centre[0], chinY, chinSlice.centre[2]] : [chinPathCell[0], chinY, chinPathCell[2]];

  const groinPathCell = cellAtHeight(leftPath, crotch);
  const groinSlice = groinPathCell ? sliceAround(grid, mask, 1, groinPathCell[0], crotch, groinPathCell[2]) : null;
  const groinCell: Point = [
    (leftLeg.hipCell[0] + rightLeg.hipCell[0]) / 2,
    crotch,
    groinSlice ? groinSlice.centre[2] : (leftLeg.hipCell[2] + rightLeg.hipCell[2]) / 2,
  ];

  const back = (p: Point): Point => turnAboutY(p, -sin, cos);
  const groin = placeOf(grid, groinCell);
  const sides = (left: Point, right: Point): [Point, Point] => {
    const [evenLeft, evenRight] = evenSides(left, right, groin[0], voxels * grid.size);
    return [back(evenLeft), back(evenRight)];
  };
  const [leftShoulder, rightShoulder] = sides(leftArm.shoulder, rightArm.shoulder);
  const [leftElbow, rightElbow] = sides(leftArm.elbow, rightArm.elbow);
  const [leftWrist, rightWrist] = sides(leftArm.wrist, rightArm.wrist);
  const [leftKnee, rightKnee] = sides(leftLeg.knee, rightLeg.knee);
  const [leftAnkle, rightAnkle] = sides(leftLeg.ankle, rightLeg.ankle);
  return {
    facing,
    markers: {
      chin: back(placeOf(grid, chinCell)),
      groin: back(groin),
      leftShoulder,
      rightShoulder,
      leftElbow,
      rightElbow,
      leftWrist,
      rightWrist,
      leftKnee,
      rightKnee,
      leftAnkle,
      rightAnkle,
    },
    extents: {
      headTop: back(pointOf(grid, tips.head)),
      leftHandTip: back(leftArm.tip),
      rightHandTip: back(rightArm.tip),
      leftToe: back(leftLeg.toe),
      rightToe: back(rightLeg.toe),
      floor: grid.oy + bottom * grid.size,
    },
  };
};
