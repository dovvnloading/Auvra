import { distanceThrough, distanceToSkin, largestPiece, neighboursOf, protrusions, thickMiddle, UNREACHED, waveFrom, type Protrusion, type WaveBand } from './bodyField';
import { acrossBody, bendOf, bodyHeart, evenSides, heightsOf, limbLine, lineAt, onTheFloor, squared, TRUNK_THICKNESS, turnAboutY, turnSoupAboutY, type FloorPiece, type LimbLine, type Point } from './bodyMarkers';
import { cellOf, placeOf, voxelize, type TriangleSoup, type VoxelGrid } from './voxels';

/**
 * Finds where the joints of an animal on four legs are from its mesh alone. The body is read side on,
 * running along Z with its head towards +Z and its left at +X. What stands on the floor is the paws,
 * a wave from each follows its leg up to the trunk, and the same from the far ends of the body finds
 * the neck and the tail. Rigs keep most of a four-legged leg's bend outside the trunk, so the joints
 * of the leg's visible part sit where its shape says or where such legs have them, and those hidden
 * inside the trunk at the usual place from where the leg comes out.
 */

/** The joints placed to fit a skeleton to an animal on four legs. */
export interface FourLegMarkers {
  /** The end of the muzzle. */
  nose: Point;
  /** Where the skull meets the neck. */
  head: Point;
  /** Where the neck meets the trunk. */
  neck: Point;
  hips: Point;
  leftShoulder: Point;
  rightShoulder: Point;
  leftElbow: Point;
  rightElbow: Point;
  leftWrist: Point;
  rightWrist: Point;
  leftFrontPaw: Point;
  rightFrontPaw: Point;
  leftHip: Point;
  rightHip: Point;
  leftKnee: Point;
  rightKnee: Point;
  leftHock: Point;
  rightHock: Point;
  leftHindPaw: Point;
  rightHindPaw: Point;
  /** Where the tail meets the body and where it ends, when it has one. */
  tailBase?: Point;
  tailTip?: Point;
}

export type FourLegMarkerName = keyof FourLegMarkers;

/** What else a skeleton needs to know of the body, found along with the markers. */
export interface FourLegExtents {
  floor: number;
  leftFrontToe: Point;
  rightFrontToe: Point;
  leftHindToe: Point;
  rightHindToe: Point;
  /** The back as read, from the hips to the neck; the neck from the trunk to the head; and the tail from its base to its tip. */
  back: Point[];
  neckLine: Point[];
  tailLine?: Point[];
}

export interface FourLegReading {
  kind: 'fourLegs';
  markers: FourLegMarkers;
  extents: FourLegExtents;
  /** The way the head is, a unit vector in the ground plane as x and z. */
  facing: [number, number];
}

/** Voxels along the longest side when reading the body. */
const READ_RESOLUTION = 180;
/** How many times more the thick of a body must spread along its length than across it to have a length. */
const LONG_TRUNK = 1.3;
/** The most its length may rise, as the sine of the angle, for it to run along the ground: about 35 degrees. */
const LEVEL_TRUNK = 0.57;
/** Shortest a part may stand out from the body to be taken for a head or a tail, as a share of the body's length. */
const LEAST_PART = 0.025;
/** Shortest a tail may be, as a share of the body's length: anything less is a bump. */
const LEAST_TAIL = 0.08;
/** How far from the paws a part must be to be more than part of the leg, as a share of height. */
const CLEAR_OF_PAWS = 0.2;
/** How much thicker one far end of the body must be than the other to be the head. */
const HEAD_OVER_TAIL = 1.1;
/** What a leg's bend counts for in saying which way a body faces, against how far its paws point, as shares of height. */
const HOCKS_OVER_PAWS = 0.25;
/** How far paws must point, as a share of height, to say anything. */
const LEGS_SAY_NOTHING = 0.02;
/** A leg bent by more than this share of its length has its joint at the bend. */
const CLEAR_BEND = 0.08;
/** How much of the body's thickness at its middle counts as the rump a tail comes out of. */
const TAIL_JOINS_AT = 0.35;

/**
 * Where a four-legged body's parts are, from rigs and from how such animals are built. Shares along a
 * leg are of its visible length from the toes; the joints hidden in the trunk are offsets in that length.
 */
const PROPORTION = {
  /** Along a front leg from the toes: the paw's joint and the wrist. */
  frontPaw: 0.18,
  wrist: 0.48,
  /** Along a hind leg from the toes: the paw's joint and the hock. */
  hindPaw: 0.15,
  hock: 0.5,
  /** The shoulder joint along the body from the elbow, and the hip joint from the knee, in the leg's length. */
  shoulderForward: 0.17,
  hipBack: 0.2,
  /** Where they are up the trunk, as a share of its depth from the belly to the back. */
  shoulderUp: 0.42,
  hipUp: 0.55,
  /** Where the spine runs up the trunk. */
  backUp: 0.75,
  /** How much of a skull there is, as a share of the length from the nose to the hips. */
  headLength: 0.24,
  /** How far behind the shoulders the trunk's top is taken, as a share of the way to the hips: further forward the neck rises from it. */
  backBehindShoulders: 0.15,
} as const;

interface Paw {
  voxels: number[];
  /** As far forward as it goes. */
  toe: number;
  middleX: number;
  middleZ: number;
}

const pawOf = (grid: VoxelGrid, voxels: number[]): Paw => {
  let toe = voxels[0];
  let toeZ = -Infinity;
  let sumX = 0;
  let sumZ = 0;
  for (const index of voxels) {
    const cell = cellOf(grid, index);
    sumX += cell[0];
    sumZ += cell[2];
    if (cell[2] > toeZ) {
      toeZ = cell[2];
      toe = index;
    }
  }
  return { voxels, toe, middleX: sumX / voxels.length, middleZ: sumZ / voxels.length };
};

/** A piece on the floor parted across its longer way, for paws grown together. */
const parted = (grid: VoxelGrid, piece: FloorPiece): [number[], number[]] => {
  const axis = piece.high[0] - piece.low[0] > piece.high[2] - piece.low[2] ? 0 : 2;
  const middle = axis === 0 ? piece.middleX : piece.middleZ;
  const low: number[] = [];
  const high: number[] = [];
  for (const index of piece.voxels) (cellOf(grid, index)[axis] < middle ? low : high).push(index);
  return [low, high];
};

interface Paws {
  frontLeft: Paw;
  frontRight: Paw;
  hindLeft: Paw;
  hindRight: Paw;
}

/** The four paws among what stands on the floor. Fewer pieces are paws grown together, parted across their longer way. */
const readPaws = (grid: VoxelGrid, pieces: readonly FloorPiece[]): Paws | null => {
  if (pieces.length < 2) return null;
  let groups = pieces.slice(0, 4).map((piece) => piece.voxels);
  // The biggest pieces part until there are four.
  const queue = pieces.slice(0, 4).slice();
  while (groups.length < 4 && queue.length) {
    const piece = queue.shift()!;
    const [a, b] = parted(grid, piece);
    if (!a.length || !b.length) return null;
    groups = groups.filter((group) => group !== piece.voxels);
    groups.push(a, b);
  }
  if (groups.length < 4) return null;
  const paws = groups.map((voxels) => pawOf(grid, voxels)).sort((a, b) => b.middleZ - a.middleZ);
  const [frontRight, frontLeft] = paws[0].middleX < paws[1].middleX ? [paws[0], paws[1]] : [paws[1], paws[0]];
  const [hindRight, hindLeft] = paws[2].middleX < paws[3].middleX ? [paws[2], paws[3]] : [paws[3], paws[2]];
  return { frontLeft, frontRight, hindLeft, hindRight };
};

/** How far ahead of the leg above it a paw lies, in voxels: paws point the way the body faces. */
const pawAhead = (grid: VoxelGrid, mask: Uint8Array, paw: Paw, bottom: number, tall: number): number => {
  let lowZ = Infinity;
  let highZ = -Infinity;
  let lowX = Infinity;
  let highX = -Infinity;
  for (const index of paw.voxels) {
    const cell = cellOf(grid, index);
    lowZ = Math.min(lowZ, cell[2]);
    highZ = Math.max(highZ, cell[2]);
    lowX = Math.min(lowX, cell[0]);
    highX = Math.max(highX, cell[0]);
  }
  // The leg: what stands over the paw a little way up, or just beside it where the leg leans.
  const reach = Math.round(tall * 0.02);
  const stride = grid.nx * grid.ny;
  let sum = 0;
  let count = 0;
  for (let y = bottom + Math.round(tall * 0.08); y <= bottom + Math.round(tall * 0.12); y += 1) {
    for (let z = lowZ - reach; z <= highZ + reach; z += 1) {
      for (let x = lowX - reach; x <= highX + reach; x += 1) {
        if (mask[x + y * grid.nx + z * stride]) {
          sum += z;
          count += 1;
        }
      }
    }
  }
  return count ? (lowZ + highZ) / 2 - sum / count : 0;
};

/** How far a leg's line strays along the body from the straight line up it, as a share of that line: hocks bend back. */
const strayAlong = (bands: readonly WaveBand[]): number => {
  const a = bands[Math.floor(bands.length * 0.1)].centre;
  const b = bands[bands.length - 1].centre;
  const chord: Point = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const length = Math.hypot(chord[0], chord[1], chord[2]) || 1;
  let stray = 0;
  for (const band of bands) {
    const gap: Point = [band.centre[0] - a[0], band.centre[1] - a[1], band.centre[2] - a[2]];
    const along = (gap[0] * chord[0] + gap[1] * chord[1] + gap[2] * chord[2]) / length;
    const off = gap[2] - (chord[2] / length) * along;
    if (Math.abs(off) > Math.abs(stray)) stray = off;
  }
  return stray / length;
};

/** How thick a limb is on average, from its tip to the body: what tells a head and its neck from a tail, however long that is. */
const meanThickness = (bands: readonly WaveBand[]): number => {
  let total = 0;
  for (const band of bands) total += Math.sqrt(band.area / Math.PI);
  return bands.length ? total / bands.length : 0;
};

/** A few places along a list of them, evenly. */
const thinned = (points: readonly Point[], count: number): Point[] => {
  if (points.length <= count) return [...points];
  const out: Point[] = [];
  for (let i = 0; i < count; i += 1) out.push(points[Math.round((i * (points.length - 1)) / (count - 1))]);
  return out;
};

/**
 * Whether a body stands on four legs and not on two, from a coarse look at it: the thick of it runs
 * along the ground and not up from it. A round body says nothing, and is taken to be upright.
 */
export const looksFourLegged = (triangles: TriangleSoup): boolean => {
  const grid = voxelize(triangles, 96);
  if (!grid) return false;
  const mask = largestPiece(grid);
  const neighbours = neighboursOf(grid);
  const skin = distanceToSkin(grid, mask);
  const heart = bodyHeart(mask, neighbours, skin);
  if (heart < 0) return false;
  const trunk = thickMiddle(grid, mask, skin, heart, Math.max(1, skin[heart] * TRUNK_THICKNESS));
  // How the thick of it spreads along each axis and between them.
  const sum: Point = [0, 0, 0];
  let count = 0;
  for (let index = 0; index < trunk.length; index += 1) {
    if (!trunk[index]) continue;
    const cell = cellOf(grid, index);
    for (let axis = 0; axis < 3; axis += 1) sum[axis] += cell[axis];
    count += 1;
  }
  if (!count) return false;
  const middle: Point = [sum[0] / count, sum[1] / count, sum[2] / count];
  const spread = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let index = 0; index < trunk.length; index += 1) {
    if (!trunk[index]) continue;
    const cell = cellOf(grid, index);
    for (let a = 0; a < 3; a += 1) for (let b = 0; b < 3; b += 1) spread[a * 3 + b] += ((cell[a] - middle[a]) * (cell[b] - middle[b])) / count;
  }
  // The way it spreads most, by turning a direction through the spread until it settles.
  let way: Point = [1, 1, 1];
  let most = 0;
  for (let step = 0; step < 24; step += 1) {
    const next: Point = [
      spread[0] * way[0] + spread[1] * way[1] + spread[2] * way[2],
      spread[3] * way[0] + spread[4] * way[1] + spread[5] * way[2],
      spread[6] * way[0] + spread[7] * way[1] + spread[8] * way[2],
    ];
    most = Math.hypot(next[0], next[1], next[2]);
    if (!(most > 0)) return false;
    way = [next[0] / most, next[1] / most, next[2] / most];
  }
  const others = (spread[0] + spread[4] + spread[8] - most) / 2;
  return most >= others * LONG_TRUNK && Math.abs(way[1]) <= LEVEL_TRUNK;
};

/**
 * Reads an animal on four legs from `triangles`, in the triangles' space. Null when the mesh does not
 * read as one. `facing` says which way its head is, if that is known already.
 */
export const readFourLegs = (triangles: TriangleSoup, facing?: [number, number]): FourLegReading | null => {
  if (facing) return readFacing(triangles, facing, false);
  const coarse = voxelize(triangles, 96);
  if (!coarse) return null;
  const across = acrossBody(coarse, largestPiece(coarse), true);
  if (!across) return null;
  return readFacing(triangles, squared([-across[1], across[0]]), true);
};

const readFacing = (triangles: TriangleSoup, facing: [number, number], mayTurn: boolean): FourLegReading | null => {
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
  const tall = top - bottom;
  if (tall < 8) return null;
  let lowZ = grid.nz;
  let highZ = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const z = cellOf(grid, index)[2];
    if (z < lowZ) lowZ = z;
    if (z > highZ) highZ = z;
  }
  const long = highZ - lowZ;

  const heart = bodyHeart(mask, neighbours, skin);
  if (heart < 0) return null;
  const trunkRadius = Math.max(1, skin[heart] * TRUNK_THICKNESS);
  const trunk = thickMiddle(grid, mask, skin, heart, trunkRadius);

  const paws = readPaws(grid, onTheFloor(grid, mask, bottom, tall, 4));
  if (!paws) return null;
  const { frontLeft, frontRight, hindLeft, hindRight } = paws;
  const frontZ = (frontLeft.middleZ + frontRight.middleZ) / 2;
  const hindZ = (hindLeft.middleZ + hindRight.middleZ) / 2;
  if (frontZ - hindZ < long * 0.15) return null;
  const middleX = (frontLeft.middleX + frontRight.middleX + hindLeft.middleX + hindRight.middleX) / 4;

  // The parts standing out at each end of the body. Those near the paws are part of the legs.
  const fromHeart = distanceThrough(mask, neighbours, [heart]);
  const fromPaws = distanceThrough(mask, neighbours, [...frontLeft.voxels, ...frontRight.voxels, ...hindLeft.voxels, ...hindRight.voxels]);
  const parts = protrusions(mask, neighbours, fromHeart)
    .filter((part) => part.length / 10 >= long * LEAST_PART && fromPaws[part.tip] !== UNREACHED && fromPaws[part.tip] / 10 >= tall * CLEAR_OF_PAWS);
  const zOf = (part: Protrusion): number => cellOf(grid, part.tip)[2];
  // The nose is what goes furthest that way: antlers and ears reach higher, and further through the body, but not as far forward.
  const nearest = (from: Protrusion[], better: (a: Protrusion, b: Protrusion) => boolean): Protrusion | null => {
    let best: Protrusion | null = null;
    for (const part of from) if (!best || better(part, best)) best = part;
    return best;
  };
  const frontEnd = parts.filter((part) => zOf(part) > frontZ);
  const backEnd = parts.filter((part) => zOf(part) < hindZ);
  const noseAt = nearest(frontEnd, (a, b) => zOf(a) > zOf(b));
  const tailAt = nearest(backEnd, (a, b) => a.length > b.length);
  const lineOf = (part: Protrusion | null): LimbLine | null => (part ? limbLine(grid, mask, neighbours, trunk, trunkRadius, part.tip) : null);
  const noseLine = lineOf(noseAt);
  const legLines = [frontLeft, frontRight, hindLeft, hindRight].map((paw) => limbLine(grid, mask, neighbours, trunk, trunkRadius, paw.toe));
  // Which way the body faces. Paws point forward and hocks bend back, whatever is at either end of it.
  // Legs that say neither leave the ends: a head and its neck stay thicker than a tail, all the way along.
  if (mayTurn) {
    const pawsSay = [frontLeft, frontRight, hindLeft, hindRight].reduce((total, paw) => total + pawAhead(grid, mask, paw, bottom, tall), 0) / tall;
    const [frontStray, otherFront, hindStray, otherHind] = legLines.map((line) => (line ? strayAlong(line.bands) : 0));
    const hocksSay = -(hindStray + otherHind) - (frontStray + otherFront);
    let turn = pawsSay + hocksSay * HOCKS_OVER_PAWS < 0;
    if (Math.abs(pawsSay) < LEGS_SAY_NOTHING && Math.abs(hocksSay) < LEGS_SAY_NOTHING * 5) {
      // A head as thick as the trunk has no line of its own to speak of, and neither has a rump with nothing on it.
      const otherAt = nearest(backEnd, (a, b) => zOf(a) < zOf(b));
      const otherLine = lineOf(otherAt);
      const thicknessOf = (part: Protrusion | null, line: LimbLine | null): number => (!part ? 0 : line ? meanThickness(line.bands) : Infinity);
      turn = thicknessOf(otherAt, otherLine) > thicknessOf(noseAt, noseLine) * HEAD_OVER_TAIL;
    }
    if (turn) return readFacing(triangles, squared([-facing[0], -facing[1]]), false);
  }
  if (!noseAt || zOf(noseAt) < frontZ) return null;
  if (legLines.some((line) => !line)) return null;
  const [frontLeftLine, frontRightLine, hindLeftLine, hindRightLine] = legLines as LimbLine[];

  const readFront = (line: LimbLine) => {
    const { bands, reach } = line;
    return {
      toe: lineAt(bands, 0),
      paw: lineAt(bands, reach * PROPORTION.frontPaw),
      wrist: lineAt(bands, reach * PROPORTION.wrist),
      elbow: lineAt(bands, reach),
    };
  };
  const readHind = (line: LimbLine) => {
    const { bands, reach } = line;
    const bend = bendOf(bands, reach * PROPORTION.hindPaw, reach);
    const hockAt = bend && bend.share > CLEAR_BEND ? bend.distance : reach * PROPORTION.hock;
    return {
      toe: lineAt(bands, 0),
      paw: lineAt(bands, reach * PROPORTION.hindPaw),
      hock: lineAt(bands, hockAt),
      knee: lineAt(bands, reach),
    };
  };
  const frontLeftLeg = readFront(frontLeftLine);
  const frontRightLeg = readFront(frontRightLine);
  const hindLeftLeg = readHind(hindLeftLine);
  const hindRightLeg = readHind(hindRightLine);

  // The trunk down the middle of the body: how far it reaches up and down at a place along it, where it is deepest there.
  const trunkAt = (z: number): { low: number; high: number } | null => {
    const x = Math.round(middleX);
    const atZ = Math.round(z);
    let best: { low: number; high: number } | null = null;
    let from = -1;
    for (let y = bottom; y <= top + 1; y += 1) {
      const inside = y <= top && mask[x + y * grid.nx + atZ * grid.nx * grid.ny];
      if (inside && from < 0) from = y;
      if (!inside && from >= 0) {
        if (!best || y - 1 - from > best.high - best.low) best = { low: from, high: y - 1 };
        from = -1;
      }
    }
    return best;
  };
  const shoulderZ = (frontLeftLeg.elbow[2] + frontRightLeg.elbow[2]) / 2 + ((frontLeftLine.reach + frontRightLine.reach) / 2) * PROPORTION.shoulderForward;
  const hipZ = (hindLeftLeg.knee[2] + hindRightLeg.knee[2]) / 2 - ((hindLeftLine.reach + hindRightLine.reach) / 2) * PROPORTION.hipBack;
  // A neck rising from the trunk carries the top of the body with it, so near the shoulders the top is as it is a little behind them.
  const backHigh = trunkAt(shoulderZ - (shoulderZ - hipZ) * PROPORTION.backBehindShoulders)?.high;
  const heightUp = (z: number, share: number): number | null => {
    const at = trunkAt(z);
    if (!at) return null;
    const high = z > shoulderZ - (shoulderZ - hipZ) * PROPORTION.backBehindShoulders && backHigh !== undefined ? Math.min(at.high, backHigh) : at.high;
    return at.low + (high - at.low) * share;
  };
  const shoulderY = heightUp(shoulderZ, PROPORTION.shoulderUp);
  const hipY = heightUp(hipZ, PROPORTION.hipUp);
  const hipsY = heightUp(hipZ, PROPORTION.backUp);
  const neckY = heightUp(shoulderZ, PROPORTION.backUp);
  if (shoulderY === null || hipY === null || hipsY === null || neckY === null) return null;
  const leftShoulderCell: Point = [frontLeftLeg.elbow[0], shoulderY, shoulderZ];
  const rightShoulderCell: Point = [frontRightLeg.elbow[0], shoulderY, shoulderZ];
  const leftHipCell: Point = [hindLeftLeg.knee[0], hipY, hipZ];
  const rightHipCell: Point = [hindRightLeg.knee[0], hipY, hipZ];
  const hipsCell: Point = [middleX, hipsY, hipZ];
  const neckCell: Point = [middleX, neckY, shoulderZ];
  const noseCell = cellOf(grid, noseAt.tip);

  // The back runs along the top of the trunk from the hips to the neck, and the neck on from there to the skull.
  const BACK_POINTS = 10;
  const backCells: Point[] = [];
  for (let step = 0; step <= BACK_POINTS; step += 1) {
    const z = hipZ + ((shoulderZ - hipZ) * step) / BACK_POINTS;
    const y = heightUp(z, PROPORTION.backUp);
    if (y !== null) backCells.push([middleX, y, z]);
  }
  // A skull's length from the nose, which on a body with no neck to speak of is already in the chest,
  // and the neck's line on from there, as long as the wave is ahead of the shoulders.
  const headFrom = stepTo(noseCell, hipsCell) * PROPORTION.headLength;
  const headBands = waveFrom(grid, mask, neighbours, noseAt.tip, (band) => band.distance > headFrom && band.centre[2] < shoulderZ);
  const headCell: Point = lineAt(headBands, headFrom);
  headCell[0] = middleX;
  const neckCells: Point[] = headBands
    .filter((band) => band.distance > headFrom && band.centre[2] > shoulderZ)
    .map((band) => [middleX, band.centre[1], band.centre[2]]);
  neckCells.push(neckCell);

  // The tail, if something long enough leaves the back of the body: it starts where the wave up it first spreads out into the rump.
  let tailBand: { base: Point; tip: Point; line: Point[] } | null = null;
  if (tailAt && tailAt.length / 10 >= long * LEAST_TAIL) {
    const rump = thickMiddle(grid, mask, skin, heart, Math.max(1, skin[heart] * TAIL_JOINS_AT));
    const tail = limbLine(grid, mask, neighbours, rump, Math.max(1, skin[heart] * TAIL_JOINS_AT), tailAt.tip);
    if (tail) {
      const base = lineAt(tail.bands, tail.reach);
      tailBand = {
        tip: lineAt(tail.bands, 0),
        base: [middleX, base[1], base[2]],
        line: tail.bands.map((band): Point => [middleX, band.centre[1], band.centre[2]]).reverse(),
      };
    }
  }

  const back = (p: Point): Point => turnAboutY(p, -sin, cos);
  const place = (cell: readonly number[]): Point => back(placeOf(grid, cell));
  const pair = (left: readonly number[], right: readonly number[]): [Point, Point] => {
    const [evenLeft, evenRight] = evenSides(placeOf(grid, left), placeOf(grid, right), placeOf(grid, [middleX, 0, 0])[0], tall * grid.size);
    return [back(evenLeft), back(evenRight)];
  };
  const [leftShoulder, rightShoulder] = pair(leftShoulderCell, rightShoulderCell);
  const [leftElbow, rightElbow] = pair(frontLeftLeg.elbow, frontRightLeg.elbow);
  const [leftWrist, rightWrist] = pair(frontLeftLeg.wrist, frontRightLeg.wrist);
  const [leftFrontPaw, rightFrontPaw] = pair(frontLeftLeg.paw, frontRightLeg.paw);
  const [leftHip, rightHip] = pair(leftHipCell, rightHipCell);
  const [leftKnee, rightKnee] = pair(hindLeftLeg.knee, hindRightLeg.knee);
  const [leftHock, rightHock] = pair(hindLeftLeg.hock, hindRightLeg.hock);
  const [leftHindPaw, rightHindPaw] = pair(hindLeftLeg.paw, hindRightLeg.paw);
  return {
    kind: 'fourLegs',
    facing,
    markers: {
      nose: place(noseCell),
      head: place(headCell),
      neck: place(neckCell),
      hips: place(hipsCell),
      leftShoulder,
      rightShoulder,
      leftElbow,
      rightElbow,
      leftWrist,
      rightWrist,
      leftFrontPaw,
      rightFrontPaw,
      leftHip,
      rightHip,
      leftKnee,
      rightKnee,
      leftHock,
      rightHock,
      leftHindPaw,
      rightHindPaw,
      ...(tailBand ? { tailBase: place(tailBand.base), tailTip: place(tailBand.tip) } : {}),
    },
    extents: {
      floor: grid.oy + bottom * grid.size,
      leftFrontToe: place(frontLeftLeg.toe),
      rightFrontToe: place(frontRightLeg.toe),
      leftHindToe: place(hindLeftLeg.toe),
      rightHindToe: place(hindRightLeg.toe),
      back: backCells.map(place),
      neckLine: thinned(neckCells, 10).map(place),
      ...(tailBand ? { tailLine: thinned(tailBand.line, 10).map(place) } : {}),
    },
  };
};

const stepTo = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
