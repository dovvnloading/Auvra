import { distanceThrough, distanceToSkin, largestPiece, neighboursOf, pathsAlongMiddle, pathTo, protrusions, thickMiddle, UNREACHED, waveFrom, type Neighbours, type Protrusion, type WaveBand } from './bodyField';
import { cellOf, placeOf, voxelize, type TriangleSoup, type VoxelGrid } from './voxels';

/**
 * Finds where a person's joints are from their mesh alone, for rigging a mesh that came without a
 * skeleton. The mesh is read as a solid body standing on two feet, upright or hunched, with its arms
 * anywhere that keeps them clear of the rest of it: what touches the floor is the feet, the parts
 * standing furthest out from the middle of the body are the hands and the head, a wave spreading from
 * each of those follows the limb whichever way it runs, and the joints sit along that line where the
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
  /** The middle of the back as read, from the chin down to the groin: how far it curves. */
  spine?: Point[];
}

export interface BodyReading {
  kind: 'person';
  markers: BodyMarkers;
  extents: BodyExtents;
  /** The way the figure faces, a unit vector in the ground plane as x and z. */
  facing: [number, number];
}

/** Voxels along the longest side when reading the body. */
const READ_RESOLUTION = 180;
/** Shortest a part may stand out from the body to be taken for a limb or a head, as a share of height. */
const LEAST_PART = 0.025;
/** The share of the body's thickness at its middle that a part must hold to count as the thick of the body. */
export const TRUNK_THICKNESS = 0.6;
/** How far forward of its neck the top of a head may be, against its height above it, and still stand over it. */
const HEAD_LEAN = 0.7;
/** How much bigger than the highest part around the middle another must be for that to be the head instead. */
const HEAD_OVER_TUFT = 4;
/** How much the body must grow above where the legs meet for that to be the crotch, not legs grown together below it. */
const CROTCH_GROWTH = 1.6;
/** How much thinner than the chest and the hips a waist is, to be sure of it. */
const CLEAR_WAIST = 0.85;
/** How much longer one arm may be than the other and still be read for itself. */
const ARMS_ALIKE = 1.15;
/** How much a wave has spread from a thick limb's own cross-section at the limb's joint with the body. */
const THICK_LIMB_SPREAD = 1.5;
/** How many more of an arm's thicknesses its joint is past where it meets the body when it hangs straight down. */
const HANGING_ARM_JOINT = 1.25;
/** A limb bent by more than this share of its length has its joint at the bend. */
const CLEAR_BEND = 0.1;
/** A limb this much thinner at a place than either side of it has narrowed there. */
const CLEAR_NARROWING = 0.94;
/** How much of the largest piece on the floor another must be to be a foot, not the end of a blade or a cape. */
const FOOT_PIECE = 0.2;
/** How many times wider than deep a body must be for its widest way to be taken for across, if it mirrors itself nearly as well that way. */
const WIDE_BODY = 1.5;
const MIRROR_SLACK = 0.08;
/** How far above the floor a raised foot is looked for, as shares of height, nearest first. */
const FLOOR_LAYERS = [0.02, 0.04, 0.06, 0.08];

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
  crotchLeast: 0.12,
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
  wristAlongArm: 0.68,
  /** How much of the arm from the shoulder to the wrist is before the elbow. */
  elbowAlongArm: 0.5,
  /** Where a narrowing in an arm can be a wrist, from the shoulder to the fingertips. */
  wristNear: 0.4,
  wristFar: 0.85,
  /** The chin from the middle of the shoulders when no neck can be told from the head, and how near and far it can be. */
  chinUsual: 0.065,
  chinNear: 0.02,
  chinFar: 0.11,
  /** How much of the height of a clear waist the top of the thighs is. */
  thighsToWaist: 0.8,
} as const;

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
  // A line down the middle of legs grown together can run on the far side of where they part.
  const startX = side && (Math.round(x) - side.from) * side.sign < 0 ? Math.round(side.from + side.sign) : Math.round(x);
  const first = startX + Math.round(y) * nx + Math.round(z) * stride;
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
  /** How far the wrist and the elbow are from the shoulder, along the arm, in voxels. */
  wristAt: number;
  elbowAt: number;
}

/** The middle of a limb, tip first, as a wave follows it to the thick of the body. */
export interface LimbLine {
  bands: WaveBand[];
  /** How far it is from the tip to where it meets the thick of the body, in voxels. */
  reach: number;
  /** How thick it is there, in voxels from its middle to its skin. */
  radius: number;
  /** Its length to its joint with the body: a limb's joint is about as far inside it as the limb is thick. */
  length: number;
}

/** The place on a limb's line at `distance` voxels from its tip. */
export const lineAt = (bands: readonly WaveBand[], distance: number): Point => {
  for (let i = 1; i < bands.length; i += 1) {
    if (bands[i].distance >= distance) {
      const share = (distance - bands[i - 1].distance) / Math.max(1e-6, bands[i].distance - bands[i - 1].distance);
      const a = bands[i - 1].centre;
      const b = bands[i].centre;
      return [a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share, a[2] + (b[2] - a[2]) * share];
    }
  }
  return bands[bands.length - 1].centre;
};

/**
 * Follows a limb from its tip until the wave has reached the thick of the body. That is where it first
 * touches it, but a limb as thick as that itself counts as part of it, and it meets the body further
 * on, where the wave has spread out from its own thickness. Null for a limb too short to read.
 */
export const limbLine = (grid: VoxelGrid, mask: Uint8Array, neighbours: Neighbours, trunk: Uint8Array, trunkRadius: number, tip: number): LimbLine | null => {
  const thick = Math.PI * trunkRadius * trunkRadius;
  let touched = 0;
  let touchedAt = -1;
  let met = false;
  let seen = 0;
  const bands = waveFrom(grid, mask, neighbours, tip, (band) => {
    if (band.withinShare > 0.15 && !touched) {
      touched = band.area;
      touchedAt = seen;
    }
    seen += 1;
    met = touched > 0 && (touched < thick || band.area >= touched * THICK_LIMB_SPREAD);
    return met;
  }, trunk);
  if (!touched) return null;
  // A limb as thick as the body may never spread that far: it meets the body where it first touched it.
  if (!met) bands.length = touchedAt + 1;
  if (bands.length < 6) return null;
  bands.pop();
  const reach = bands[bands.length - 1].distance;
  // Where it has spread out, it is at its joint already; where it only touches, its joint is further on.
  const lastAreas = bands.slice(-5).map((band) => band.area).sort((a, b) => a - b);
  const radius = touched < thick ? Math.sqrt(lastAreas[Math.floor(lastAreas.length / 2)] / Math.PI) : 0;
  return { bands, reach, radius, length: reach + radius };
};

/**
 * The place on an arm's line where it joins the body: on past where it meets the thick of it, the way
 * it is going there, by as much as the arm is thick. An arm hanging meets the body at the armpit, which
 * is further below its joint than one held out's is along it.
 */
const armJoint = (line: LimbLine): Point => {
  const end = lineAt(line.bands, line.reach);
  if (!line.radius) return end;
  const before = lineAt(line.bands, Math.max(0, line.reach - line.radius * 3));
  const length = Math.max(1e-6, stepLength(end, before));
  const rising = Math.abs(end[1] - before[1]) / length;
  const share = (line.radius * (1 + HANGING_ARM_JOINT * rising)) / length;
  return [end[0] + (end[0] - before[0]) * share, end[1] + (end[1] - before[1]) * share, end[2] + (end[2] - before[2]) * share];
};

/** Where a limb narrows most against what is either side of it, if it clearly does, from `near` to `far` voxels from its tip. */
const narrowing = (bands: readonly WaveBand[], near: number, far: number): number | null => {
  const areas = bands.map((band, i) => (bands[Math.max(0, i - 1)].area + band.area + bands[Math.min(bands.length - 1, i + 1)].area) / 3);
  let best: number | null = null;
  let bestDepth = CLEAR_NARROWING;
  for (let i = 2; i < bands.length - 2; i += 1) {
    if (bands[i].distance < near || bands[i].distance > far) continue;
    if (areas[i] > areas[i - 1] || areas[i] > areas[i + 1]) continue;
    let towardsTip = 0;
    for (let j = 0; j < i; j += 1) towardsTip = Math.max(towardsTip, areas[j]);
    let towardsBody = 0;
    for (let j = i + 1; j < bands.length; j += 1) towardsBody = Math.max(towardsBody, areas[j]);
    const depth = areas[i] / Math.min(towardsTip, towardsBody);
    if (depth < bestDepth) {
      bestDepth = depth;
      best = bands[i].distance;
    }
  }
  return best;
};

/** Where a limb's line strays furthest from the straight line between two places on it, and by what share of that line. */
export const bendOf = (bands: readonly WaveBand[], from: number, to: number): { distance: number; share: number } | null => {
  const a = lineAt(bands, from);
  const b = lineAt(bands, to);
  const length = stepLength(a, b);
  if (!(length > 0)) return null;
  const chord: Point = [(b[0] - a[0]) / length, (b[1] - a[1]) / length, (b[2] - a[2]) / length];
  let best: { distance: number; share: number } | null = null;
  for (const band of bands) {
    if (band.distance <= from || band.distance >= to) continue;
    const gap: Point = [band.centre[0] - a[0], band.centre[1] - a[1], band.centre[2] - a[2]];
    const along = gap[0] * chord[0] + gap[1] * chord[1] + gap[2] * chord[2];
    const share = Math.hypot(gap[0] - chord[0] * along, gap[1] - chord[1] * along, gap[2] - chord[2] * along) / length;
    if (!best || share > best.share) best = { distance: band.distance, share };
  }
  return best;
};

/**
 * Reads one arm from its line. `like` is the other arm when this one runs on past it, into a blade
 * or something held: its joints then sit where the other's do, measured from the shoulder.
 */
const readArm = (grid: VoxelGrid, line: LimbLine, like?: ArmReading & { length: number }): ArmReading => {
  const { bands, length } = line;
  const tipAt = like ? length - like.length : 0;
  let wristAt = like ? like.wristAt : length * PROPORTION.wristAlongArm;
  let elbowAt = like ? like.elbowAt : -1;
  if (!like) {
    const thin = narrowing(bands, length * (1 - PROPORTION.wristFar), length * (1 - PROPORTION.wristNear));
    if (thin !== null) wristAt = length - thin;
    const bend = bendOf(bands, length - wristAt, line.reach);
    elbowAt = bend && bend.share > CLEAR_BEND ? length - bend.distance : wristAt * PROPORTION.elbowAlongArm;
  }
  return {
    shoulder: placeOf(grid, armJoint(line)),
    elbow: placeOf(grid, lineAt(bands, length - elbowAt)),
    wrist: placeOf(grid, lineAt(bands, length - wristAt)),
    tip: placeOf(grid, lineAt(bands, tipAt)),
    wristAt,
    elbowAt,
  };
};

/**
 * The band of a wave from the top of the head at the chin: the narrowest place between the head and
 * the shoulders, else a usual neck's length from the middle of the shoulders, as a big head on no
 * neck says nothing itself.
 */
const chinBand = (bands: readonly WaveBand[], voxels: number, shoulders: Point): WaveBand => {
  const fromShoulders = (band: WaveBand): number => stepLength(band.centre, shoulders);
  const near = voxels * PROPORTION.chinNear;
  const far = voxels * PROPORTION.chinFar;
  let widest = 0;
  let thinnest: WaveBand | null = null;
  for (const band of bands) {
    const gap = fromShoulders(band);
    if (gap < near) break;
    widest = Math.max(widest, band.area);
    if (gap > far) continue;
    if (thinnest && band.area > thinnest.area * 1.6) {
      // A narrowing has opened out again into the shoulders, or it was no more than a dent in the head.
      if (thinnest.area < widest * 0.8) return thinnest;
      thinnest = null;
    }
    if (!thinnest || band.area < thinnest.area) thinnest = band;
  }
  if (thinnest && thinnest.area < widest * 0.8) return thinnest;
  const usual = voxels * PROPORTION.chinUsual;
  return bands.find((band) => fromShoulders(band) <= usual) ?? bands[bands.length - 1];
};

/** The lowest and highest voxel layers of a mask. */
export const heightsOf = (grid: VoxelGrid, mask: Uint8Array): { bottom: number; top: number } => {
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

/** A piece of the body in the layers just above the floor. */
export interface FloorPiece {
  voxels: number[];
  low: Point;
  high: Point;
  middleX: number;
  middleZ: number;
}

/** The connected pieces of the body in the layers from `bottom` to `upTo`, largest first. */
export const floorPieces = (grid: VoxelGrid, mask: Uint8Array, bottom: number, upTo: number): FloorPiece[] => {
  const { nx, ny, nz } = grid;
  const stride = nx * ny;
  const seen = new Uint8Array(mask.length);
  const pieces: FloorPiece[] = [];
  for (let z = 0; z < nz; z += 1) {
    for (let y = bottom; y <= upTo; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const start = x + y * nx + z * stride;
        if (!mask[start] || seen[start]) continue;
        const voxels: number[] = [];
        const low: Point = [x, y, z];
        const high: Point = [x, y, z];
        let sumX = 0;
        let sumZ = 0;
        const stack = [start];
        seen[start] = 1;
        while (stack.length) {
          const index = stack.pop()!;
          voxels.push(index);
          const cell = cellOf(grid, index);
          sumX += cell[0];
          sumZ += cell[2];
          for (let axis = 0; axis < 3; axis += 1) {
            low[axis] = Math.min(low[axis], cell[axis]);
            high[axis] = Math.max(high[axis], cell[axis]);
          }
          for (const step of [1, -1, nx, -nx, stride, -stride]) {
            const other = index + step;
            if (other < 0 || other >= mask.length || seen[other] || !mask[other]) continue;
            const otherY = Math.floor(other / nx) % ny;
            if (otherY < bottom || otherY > upTo) continue;
            seen[other] = 1;
            stack.push(other);
          }
        }
        pieces.push({ voxels, low, high, middleX: sumX / voxels.length, middleZ: sumZ / voxels.length });
      }
    }
  }
  return pieces.sort((a, b) => b.voxels.length - a.voxels.length);
};

/** What stands on the floor: the big enough pieces of the body there, in layers as high as it takes to find `wanted`. */
export const onTheFloor = (grid: VoxelGrid, mask: Uint8Array, bottom: number, voxels: number, wanted = 2): FloorPiece[] => {
  let pieces: FloorPiece[] = [];
  for (const share of FLOOR_LAYERS) {
    const all = floorPieces(grid, mask, bottom, bottom + Math.max(1, Math.round(voxels * share)));
    if (!all.length) continue;
    pieces = all.filter((piece) => piece.voxels.length >= all[0].voxels.length * FOOT_PIECE);
    if (pieces.length >= wanted) break;
  }
  return pieces;
};

/**
 * How far the middles of the soles are forward of the ankles, along `facing`: negative when they are
 * behind. Only what stands over the feet counts, so a blade or a cape hanging behind says nothing, and
 * it stays low enough that a bent knee does not.
 */
const solesAhead = (grid: VoxelGrid, mask: Uint8Array, facing: [number, number], bottom: number, top: number): number => {
  const height = top - bottom;
  const stride = grid.nx * grid.ny;
  let total = 0;
  for (const piece of onTheFloor(grid, mask, bottom, height).slice(0, 2)) {
    let soleFront = -Infinity;
    let soleBack = Infinity;
    for (const index of piece.voxels) {
      const cell = cellOf(grid, index);
      const along = cell[0] * facing[0] + cell[2] * facing[1];
      if (along > soleFront) soleFront = along;
      if (along < soleBack) soleBack = along;
    }
    // The ankle: what stands over this piece, a little way up.
    let sum = 0;
    let count = 0;
    for (let y = bottom + Math.round(height * 0.07); y <= bottom + Math.round(height * 0.11); y += 1) {
      for (let z = piece.low[2]; z <= piece.high[2]; z += 1) {
        for (let x = piece.low[0]; x <= piece.high[0]; x += 1) {
          if (!mask[x + y * grid.nx + z * stride]) continue;
          sum += x * facing[0] + z * facing[1];
          count += 1;
        }
      }
    }
    if (count) total += (soleFront + soleBack) / 2 - sum / count;
  }
  return total;
};

/** How far the top half of a body is ahead of its bottom half, along `facing`. */
const leanAhead = (grid: VoxelGrid, mask: Uint8Array, facing: [number, number], bottom: number, top: number): number => {
  const middle = (bottom + top) / 2;
  let highSum = 0;
  let highCount = 0;
  let lowSum = 0;
  let lowCount = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const cell = cellOf(grid, index);
    const along = cell[0] * facing[0] + cell[2] * facing[1];
    if (cell[1] > middle) {
      highSum += along;
      highCount += 1;
    } else {
      lowSum += along;
      lowCount += 1;
    }
  }
  return highCount && lowCount ? highSum / highCount - lowSum / lowCount : 0;
};

/** The way a body is widest on the ground plane, as x and z, and how many times wider that is than the way square to it. */
export const widestWay = (grid: VoxelGrid, mask: Uint8Array): { way: [number, number]; ratio: number } | null => {
  let count = 0;
  let sumX = 0;
  let sumZ = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const cell = cellOf(grid, index);
    sumX += cell[0];
    sumZ += cell[2];
    count += 1;
  }
  if (!count) return null;
  const meanX = sumX / count;
  const meanZ = sumZ / count;
  let xx = 0;
  let zz = 0;
  let xz = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const cell = cellOf(grid, index);
    xx += (cell[0] - meanX) ** 2;
    zz += (cell[2] - meanZ) ** 2;
    xz += (cell[0] - meanX) * (cell[2] - meanZ);
  }
  const angle = 0.5 * Math.atan2(2 * xz, xx - zz);
  const spread = Math.hypot((xx - zz) / 2, xz);
  const middle = (xx + zz) / 2;
  return { way: [Math.cos(angle), Math.sin(angle)], ratio: Math.sqrt((middle + spread) / Math.max(1e-6, middle - spread)) };
};

/** A body's voxels, one in a few, to try mirror planes on. */
const sampleOf = (grid: VoxelGrid, mask: Uint8Array): Int32Array => {
  let count = 0;
  for (let index = 0; index < mask.length; index += 1) if (mask[index]) count += 1;
  const every = Math.max(1, Math.floor(count / 12000));
  const cells = new Int32Array(Math.ceil(count / every) * 3);
  let at = 0;
  let seen = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    if (seen % every === 0) {
      const [x, y, z] = cellOf(grid, index);
      cells[at] = x;
      cells[at + 1] = y;
      cells[at + 2] = z;
      at += 3;
    }
    seen += 1;
  }
  return cells.subarray(0, at);
};

/** How much of a body has itself opposite it, in a mirror standing square to `way` through its middle. */
const mirrored = (grid: VoxelGrid, mask: Uint8Array, cells: Int32Array, way: [number, number]): number => {
  const count = cells.length / 3;
  const along = new Float32Array(count);
  for (let i = 0; i < count; i += 1) along[i] = cells[i * 3] * way[0] + cells[i * 3 + 2] * way[1];
  const middle = along.slice().sort()[Math.floor(count / 2)];
  let hits = 0;
  for (let i = 0; i < count; i += 1) {
    const gap = 2 * (along[i] - middle);
    const x = Math.round(cells[i * 3] - gap * way[0]);
    const z = Math.round(cells[i * 3 + 2] - gap * way[1]);
    if (x >= 0 && z >= 0 && x < grid.nx && z < grid.nz && mask[x + cells[i * 3 + 1] * grid.nx + z * grid.nx * grid.ny]) hits += 1;
  }
  return hits / count;
};

/**
 * A body's way across, from one side to the other: the way that it mirrors itself best. `long` says it
 * is a body longer than it is wide, whose widest way runs along it and not across.
 */
export const acrossBody = (grid: VoxelGrid, mask: Uint8Array, long = false): [number, number] | null => {
  const widest = widestWay(grid, mask);
  if (!widest) return null;
  const cells = sampleOf(grid, mask);
  const wayAt = (degrees: number): [number, number] => [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)];
  let best = 0;
  let bestScore = -1;
  for (let degrees = 0; degrees < 180; degrees += 5) {
    const score = mirrored(grid, mask, cells, wayAt(degrees));
    if (score > bestScore) {
      bestScore = score;
      best = degrees;
    }
  }
  for (let degrees = best - 4; degrees <= best + 4; degrees += 1) {
    const score = mirrored(grid, mask, cells, wayAt(degrees));
    if (score > bestScore) {
      bestScore = score;
      best = degrees;
    }
  }
  // Arms held out make a body wide and flat, and it can mirror itself front to back about as well. The widest way is then across.
  const wide: [number, number] = long ? [-widest.way[1], widest.way[0]] : widest.way;
  return widest.ratio >= WIDE_BODY && mirrored(grid, mask, cells, wide) >= bestScore - MIRROR_SLACK ? wide : wayAt(best);
};

/** A direction close to a square one becomes exactly it, so a mesh standing square is not turned for nothing. */
export const squared = (direction: [number, number]): [number, number] => {
  for (const axis of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
    if (direction[0] * axis[0] + direction[1] * axis[1] > 0.97) return [axis[0], axis[1]];
  }
  return direction;
};

/**
 * Which way a body faces, from a coarse look at it: square to the way across it, on the side its toes
 * point to, or failing those the side it leans to. Null for an empty body.
 */
const bodyFacing = (grid: VoxelGrid, mask: Uint8Array): [number, number] | null => {
  const { bottom, top } = heightsOf(grid, mask);
  const height = top - bottom;
  const across = acrossBody(grid, mask);
  if (!(height > 0) || !across) return null;
  let facing: [number, number] = [-across[1], across[0]];
  const ahead = solesAhead(grid, mask, facing, bottom, top);
  const lean = leanAhead(grid, mask, facing, bottom, top);
  // Feet that do not say which way they point leave the lean. Without that it stands as most models do, looking down +Z.
  const says = Math.abs(ahead) >= height * 0.015 ? ahead : Math.abs(lean) >= height * 0.03 ? lean : facing[1] || facing[0];
  if (says < 0) facing = [-facing[0], -facing[1]];
  return squared(facing);
};

/** The middle of the body: the thickest place around the halfway point of the longest way through it. */
export const bodyHeart = (mask: Uint8Array, neighbours: Neighbours, skin: Float32Array): number => {
  let start = -1;
  for (let index = 0; index < mask.length && start < 0; index += 1) if (mask[index]) start = index;
  if (start < 0) return -1;
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
  const oneEnd = furthest(distanceThrough(mask, neighbours, [start]));
  const fromOne = distanceThrough(mask, neighbours, [oneEnd]);
  const otherEnd = furthest(fromOne);
  const fromOther = distanceThrough(mask, neighbours, [otherEnd]);
  const span = fromOne[otherEnd];
  let heart = -1;
  let depth = -1;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index] || fromOne[index] === UNREACHED || fromOther[index] === UNREACHED) continue;
    if (Math.abs(fromOne[index] - span / 2) > span * 0.15 || Math.abs(fromOther[index] - span / 2) > span * 0.15) continue;
    if (skin[index] > depth) {
      depth = skin[index];
      heart = index;
    }
  }
  return heart;
};

interface Foot {
  voxels: number[];
  /** As far forward as the sole goes. */
  toe: number;
  middleX: number;
}

/** A foot from some voxels on the floor. */
const footOf = (grid: VoxelGrid, voxels: number[]): Foot => {
  let toe = voxels[0];
  let toeZ = -Infinity;
  let sumX = 0;
  for (const index of voxels) {
    const cell = cellOf(grid, index);
    sumX += cell[0];
    if (cell[2] > toeZ) {
      toeZ = cell[2];
      toe = index;
    }
  }
  return { voxels, toe, middleX: sumX / voxels.length };
};

/**
 * The two feet among what stands on the floor. With more on it, such as hands that reach it, those
 * whose limbs join the thick of the body lowest are the legs. One piece is two feet grown together,
 * parted at the body's middle.
 */
const readFeet = (grid: VoxelGrid, pieces: readonly FloorPiece[], heartX: number, jointHeight: (voxels: number[]) => number): { left: Foot; right: Foot } | null => {
  if (!pieces.length) return null;
  if (pieces.length === 1) {
    const left = pieces[0].voxels.filter((index) => cellOf(grid, index)[0] >= heartX);
    const right = pieces[0].voxels.filter((index) => cellOf(grid, index)[0] < heartX);
    if (Math.min(left.length, right.length) < pieces[0].voxels.length * FOOT_PIECE) return null;
    return { left: footOf(grid, left), right: footOf(grid, right) };
  }
  const ordered = pieces.length === 2 ? pieces : pieces.slice().sort((a, b) => jointHeight(a.voxels) - jointHeight(b.voxels)).slice(0, 2);
  const [a, b] = ordered[0].middleX > ordered[1].middleX ? ordered : [ordered[1], ordered[0]];
  return { left: footOf(grid, a.voxels), right: footOf(grid, b.voxels) };
};

/** Two joints' difference from being mirror images, below which it is more likely the reading's than the body's. */
const SIDES_ALIKE = 0.04;

/**
 * Makes a joint and its partner mirror images across `middleX` when they nearly are. A pose that
 * really has them apart keeps them apart.
 */
export const evenSides = (left: Point, right: Point, middleX: number, height: number): [Point, Point] => {
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
 * Reads a person from `triangles`, in the triangles' space. Null when the mesh does not read as one.
 * `knownFacing` says which way they face, if that is known already.
 */
export const readBody = (triangles: TriangleSoup, knownFacing?: [number, number]): BodyReading | null => {
  // A first, coarse look finds which way it stands, so the body can be turned to face +Z.
  const coarse = voxelize(triangles, 96);
  if (!coarse) return null;
  const facing = knownFacing ?? bodyFacing(coarse, largestPiece(coarse));
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
  const voxels = top - bottom;
  if (voxels < 8) return null;

  const heart = bodyHeart(mask, neighbours, skin);
  if (heart < 0) return null;
  const trunkRadius = Math.max(1, skin[heart] * TRUNK_THICKNESS);
  const trunk = thickMiddle(grid, mask, skin, heart, trunkRadius);
  const previous = pathsAlongMiddle(mask, skin, neighbours, heart);
  const path = (tip: number): number[] => pathTo(previous, tip);

  // What stands on the floor is the feet. A limb joins the thick of the body where its path to the middle first does.
  const jointHeight = (pieceVoxels: number[]): number => {
    for (const index of path(footOf(grid, pieceVoxels).toe)) if (trunk[index]) return cellOf(grid, index)[1];
    return Infinity;
  };
  const feet = readFeet(grid, onTheFloor(grid, mask, bottom, voxels), cellOf(grid, heart)[0], jointHeight);
  if (!feet) return null;
  const middleX = (feet.left.middleX + feet.right.middleX) / 2;
  if (feet.left.middleX - feet.right.middleX < voxels * 0.02) return null;

  // The parts standing out, as far as they do. Those near the feet are part of the feet.
  const fromHeart = distanceThrough(mask, neighbours, [heart]);
  const parts = protrusions(mask, neighbours, fromHeart).filter((part) => part.length / 10 >= voxels * LEAST_PART);
  const fromFeet = distanceThrough(mask, neighbours, [...feet.left.voxels, ...feet.right.voxels]);
  const clear = parts.filter((part) => fromFeet[part.tip] !== UNREACHED && fromFeet[part.tip] / 10 >= voxels * 0.25);

  // A hand is the end of what stands out furthest on its side of the body.
  const handOn = (sign: number): Protrusion | null => {
    let best: Protrusion | null = null;
    for (const part of clear) {
      if ((cellOf(grid, part.tip)[0] - middleX) * sign < voxels * 0.05) continue;
      if (!best || part.length > best.length) best = part;
    }
    return best;
  };
  const leftHand = handOn(1);
  const rightHand = handOn(-1);
  if (!leftHand || !rightHand) return null;
  const leftLine = limbLine(grid, mask, neighbours, trunk, trunkRadius, leftHand.tip);
  const rightLine = limbLine(grid, mask, neighbours, trunk, trunkRadius, rightHand.tip);
  if (!leftLine || !rightLine) return null;
  // Arms are alike: one running on well past the other is running on into a blade or something held.
  const shorter = leftLine.length <= rightLine.length ? leftLine : rightLine;
  const longer = shorter === leftLine ? rightLine : leftLine;
  const shorterArm = readArm(grid, shorter);
  const runsOn = longer.length > shorter.length * ARMS_ALIKE;
  const longerArm = readArm(grid, longer, runsOn ? { ...shorterArm, length: shorter.length } : undefined);
  // Its shoulder is the other's across the body: what it runs on into can drag where the wave meets the body.
  if (runsOn) {
    const across = grid.ox + (middleX + 0.5) * grid.size;
    longerArm.shoulder = [2 * across - shorterArm.shoulder[0], shorterArm.shoulder[1], shorterArm.shoulder[2]];
  }
  const leftArm = shorter === leftLine ? shorterArm : longerArm;
  const rightArm = shorter === leftLine ? longerArm : shorterArm;

  // The head: around the middle of the body, standing out past the shoulders. Of those the highest,
  // unless it is no more than a tuft on something much bigger. A hunched head can be down by the shoulders.
  const inVoxels = (place: Point): Point => [(place[0] - grid.ox) / grid.size - 0.5, (place[1] - grid.oy) / grid.size - 0.5, (place[2] - grid.oz) / grid.size - 0.5];
  const shoulders: Point = inVoxels([(leftArm.shoulder[0] + rightArm.shoulder[0]) / 2, (leftArm.shoulder[1] + rightArm.shoulder[1]) / 2, (leftArm.shoulder[2] + rightArm.shoulder[2]) / 2]);
  const aroundMiddle = clear.filter((part) => part !== leftHand && part !== rightHand && Math.abs(cellOf(grid, part.tip)[0] - middleX) <= voxels * 0.15);
  const pickHead = (from: Protrusion[]): Protrusion | null => {
    let best: Protrusion | null = null;
    for (const part of from) {
      if (!best) best = part;
      else if (cellOf(grid, part.tip)[1] > cellOf(grid, best.tip)[1] ? part.volume * HEAD_OVER_TUFT > best.volume : part.volume > best.volume * HEAD_OVER_TUFT) best = part;
    }
    return best;
  };
  let headTip = (pickHead(aroundMiddle.filter((part) => cellOf(grid, part.tip)[1] >= shoulders[1] + voxels * PROPORTION.chinUsual))
    ?? pickHead(aroundMiddle.filter((part) => cellOf(grid, part.tip)[1] >= shoulders[1] - voxels * 0.1)))?.tip ?? -1;
  if (headTip < 0) {
    // Horns or ears wide apart leave a head no part of its own: its top is what is highest at the body's middle, between them.
    const high = clear.filter((part) => part !== leftHand && part !== rightHand && cellOf(grid, part.tip)[1] >= shoulders[1] + voxels * PROPORTION.chinUsual);
    if (high.some((part) => cellOf(grid, part.tip)[0] > middleX) && high.some((part) => cellOf(grid, part.tip)[0] < middleX)) {
      const x = Math.round(middleX);
      for (let y = top; y > shoulders[1] && headTip < 0; y -= 1) {
        for (let z = 0; z < grid.nz && headTip < 0; z += 1) {
          const index = x + y * grid.nx + z * grid.nx * grid.ny;
          if (mask[index]) headTip = index;
        }
      }
    }
  }
  if (headTip < 0) return null;
  const headCell = cellOf(grid, headTip);
  const headBands = waveFrom(grid, mask, neighbours, headTip, (band) => band.centre[1] < bottom, trunk);
  const chin = chinBand(headBands, voxels, shoulders);

  const leftPath = path(feet.left.toe);
  const rightPath = path(feet.right.toe);
  const cellAtHeight = (cells: number[], y: number): Point | null => {
    for (const index of cells) {
      const cell = cellOf(grid, index);
      if (cell[1] === y) return cell;
      if (cell[1] > y) break;
    }
    return null;
  };
  // The body's cross-section at a height, around its middle: arms held out are left out of it.
  const middleArea = (y: number): number => {
    const reach = voxels * 0.2;
    let z = -1;
    let longest = 0;
    let run = 0;
    const x = Math.round(middleX);
    for (let at = 0; at < grid.nz; at += 1) {
      run = mask[x + y * grid.nx + at * grid.nx * grid.ny] ? run + 1 : 0;
      if (run > longest) {
        longest = run;
        z = at - Math.floor(run / 2);
      }
    }
    if (z < 0) return 0;
    const seen = new Set<number>([x + z * grid.nx]);
    const stack: [number, number][] = [[x, z]];
    while (stack.length) {
      const [px, pz] = stack.pop()!;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const qx = px + dx;
        const qz = pz + dz;
        if (qx < 0 || qz < 0 || qx >= grid.nx || qz >= grid.nz || Math.abs(qx - middleX) > reach || seen.has(qx + qz * grid.nx) || !mask[qx + y * grid.nx + qz * grid.nx * grid.ny]) continue;
        seen.add(qx + qz * grid.nx);
        stack.push([qx, qz]);
      }
    }
    return seen.size;
  };
  // Where the crotch is. Meshes often have their legs grown together below it, so where the legs meet
  // only says when that is high enough for such a figure, or the body grows all at once above it. A
  // clear waist says where the top of the thighs is, and otherwise the size of the head does.
  const headLength = stepLength(headCell, chin.centre);
  const heads = voxels / Math.max(1, headLength);
  const headsShare = Math.max(0, Math.min(1, (heads - PROPORTION.crotchShortHeads) / (PROPORTION.crotchUsualHeads - PROPORTION.crotchShortHeads)));
  let crotch = bottom + Math.round(voxels * (PROPORTION.crotchShort + (PROPORTION.crotchUsual - PROPORTION.crotchShort) * headsShare));
  // Down from the chest, the first narrowing that opens out again into the hips.
  const armpit = Math.round(shoulders[1] - voxels * 0.06);
  const lowest = bottom + Math.round(voxels * 0.3);
  const areas = new Map<number, number>();
  for (let y = lowest; y <= armpit; y += 1) areas.set(y, middleArea(y));
  const smooth = (y: number): number => ((areas.get(y - 1) ?? areas.get(y) ?? 0) + (areas.get(y) ?? 0) + (areas.get(y + 1) ?? areas.get(y) ?? 0)) / 3;
  let chest = 0;
  let waistY = -1;
  for (let y = armpit; y >= lowest; y -= 1) {
    const area = smooth(y);
    chest = Math.max(chest, area);
    if (y < armpit && y > lowest && area <= smooth(y - 1) && area <= smooth(y + 1)) {
      waistY = y;
      break;
    }
  }
  if (waistY >= 0) {
    let hips = 0;
    for (let y = waistY - 1; y >= lowest; y -= 1) hips = Math.max(hips, smooth(y));
    if (smooth(waistY) <= chest * CLEAR_WAIST && smooth(waistY) <= hips * CLEAR_WAIST) {
      const thighs = (waistY - bottom) * PROPORTION.thighsToWaist;
      crotch = bottom + Math.round(thighs - voxels * PROPORTION.hipAboveCrotch);
    }
  }
  // Down from the hips, where the legs are first apart: feet touching lower down say nothing.
  let meet = -1;
  for (let y = bottom + Math.round(voxels * PROPORTION.crotchHigh); y >= bottom + Math.round(voxels * PROPORTION.crotchLeast) && meet < 0; y -= 1) {
    const left = cellAtHeight(leftPath, y);
    const right = cellAtHeight(rightPath, y);
    if (!left || !right) continue;
    const slice = sliceAround(grid, mask, 1, left[0], y, left[2]);
    if (slice && !(slice.low[0] <= right[0] && slice.high[0] >= right[0])) meet = y + 1;
  }
  if (meet >= 0) {
    const below = meet - Math.round(voxels * 0.03);
    const above = meet + Math.round(voxels * 0.06);
    const legsThere = (y: number): number => {
      const left = cellAtHeight(leftPath, y);
      const right = cellAtHeight(rightPath, y);
      const leftSlice = left ? sliceAround(grid, mask, 1, left[0], y, left[2]) : null;
      const rightSlice = right ? sliceAround(grid, mask, 1, right[0], y, right[2]) : null;
      return (leftSlice?.area ?? 0) + (rightSlice?.area ?? 0);
    };
    const legs = legsThere(below);
    if (meet >= crotch || (legs > 0 && middleArea(above) >= legs * CROTCH_GROWTH)) crotch = meet;
  }

  const leftLeg = readLeg(grid, mask, leftPath, bottom, crotch, voxels, middleX, 1);
  const rightLeg = readLeg(grid, mask, rightPath, bottom, crotch, voxels, middleX, -1);
  if (!leftLeg || !rightLeg) return null;

  const groinPathCell = cellAtHeight(leftPath, crotch);
  const groinSlice = groinPathCell ? sliceAround(grid, mask, 1, groinPathCell[0], crotch, groinPathCell[2]) : null;
  const groinCell: Point = [
    (leftLeg.hipCell[0] + rightLeg.hipCell[0]) / 2,
    crotch,
    groinSlice ? groinSlice.centre[2] : (leftLeg.hipCell[2] + rightLeg.hipCell[2]) / 2,
  ];

  // The back's middle, from the chin down to the groin, kept to the thick of the body once it is in it.
  const spineCells: Point[] = headBands
    .filter((band) => band.distance > chin.distance && band.withinShare > 0 && band.withinCentre[1] > crotch)
    .map((band) => [groinCell[0], band.withinCentre[1], band.withinCentre[2]]);

  // The chin's middle. A wave from a top off to one side, an ear or a hood's peak, leans the same way
  // at the neck, so it is on the line from the shoulders to the middle of the head, as far along as the
  // wave says. A head standing over its neck has its top right above the chin, as rigs have it.
  const headMiddle: Point = [0, 0, 0];
  let headArea = 0;
  for (const band of headBands) {
    if (band === chin) break;
    headArea += band.area;
    for (let axis = 0; axis < 3; axis += 1) headMiddle[axis] += band.centre[axis] * band.area;
  }
  for (let axis = 0; axis < 3; axis += 1) headMiddle[axis] /= Math.max(1e-6, headArea);
  const neckLine: Point = [headMiddle[0] - shoulders[0], headMiddle[1] - shoulders[1], headMiddle[2] - shoulders[2]];
  const neckLength = Math.max(1e-6, Math.hypot(neckLine[0], neckLine[1], neckLine[2]));
  const chinFrom = stepLength(chin.centre, shoulders) / neckLength;
  const chinCell: Point = [shoulders[0] + neckLine[0] * chinFrom, shoulders[1] + neckLine[1] * chinFrom, shoulders[2] + neckLine[2] * chinFrom];
  const headLean = Math.abs(headCell[2] - chinCell[2]) / Math.max(1, headCell[1] - chinCell[1]);
  const headTop: Point = [chinCell[0], headCell[1], headLean < HEAD_LEAN ? chinCell[2] : headCell[2]];

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
    kind: 'person',
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
      headTop: back(placeOf(grid, headTop)),
      leftHandTip: back(leftArm.tip),
      rightHandTip: back(rightArm.tip),
      leftToe: back(leftLeg.toe),
      rightToe: back(rightLeg.toe),
      floor: grid.oy + bottom * grid.size,
      spine: spineCells.map((cell) => back(placeOf(grid, cell))),
    },
  };
};
