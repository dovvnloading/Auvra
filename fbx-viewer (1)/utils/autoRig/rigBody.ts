import * as THREE from 'three';
import { largestPiece } from './bodyField';
import { readBody, turnAboutY, turnSoupAboutY, type BodyExtents, type BodyMarkers, type BodyReading, type MarkerName, type Point } from './bodyMarkers';
import { bodySkeleton, fourLegSkeleton, turnJointsAboutY, type RigJoint } from './bodySkeleton';
import { looksFourLegged, readFourLegs, type FourLegExtents, type FourLegMarkerName, type FourLegMarkers, type FourLegReading } from './fourLegReading';
import { readFingers } from './handReading';
import { bindSkin, type PartWeights, type SkinnedPart } from './skinWeights';
import { soupBounds, voxelIndex, voxelize, voxelOf, type TriangleSoup, type VoxelGrid } from './voxels';

/**
 * Fits a skeleton and skin weights to a body from where its markers are. A marker is placed in one
 * view of the body, so one a person has moved is put back in the middle of the limb at its new place:
 * front to back on a person, seen from the front, and side to side on an animal, seen from the side.
 */

export type BodyKind = 'person' | 'fourLegs';
export type RigReading = BodyReading | FourLegReading;
export type RigMarkerName = MarkerName | FourLegMarkerName;
export type RigMarkers = BodyMarkers | FourLegMarkers;

/** Voxels along the longest side when finding a limb's middle. */
const CENTRING_RESOLUTION = 180;
/** Columns looked at around a marker that has landed just off the body. */
const CENTRING_REACH = 4;

/** The middle, along `axis` (0 for side to side, 2 for front to back), of the part of the body at `point`, keeping nearest its present place. */
const centreAlong = (grid: VoxelGrid, mask: Uint8Array, point: Point, axis: 0 | 2): Point => {
  const voxel = voxelOf(grid, point[0], point[1], point[2]);
  const count = axis === 0 ? grid.nx : grid.nz;
  const otherAxis = axis === 0 ? 2 : 0;
  const otherCount = axis === 0 ? grid.nz : grid.nx;
  const origin = axis === 0 ? grid.ox : grid.oz;
  for (let reach = 0; reach <= CENTRING_REACH; reach += 1) {
    let best: number | null = null;
    let bestGap = Infinity;
    for (let dy = -reach; dy <= reach; dy += 1) {
      for (let across = -reach; across <= reach; across += 1) {
        if (Math.max(Math.abs(across), Math.abs(dy)) !== reach) continue;
        const other = voxel[otherAxis] + across;
        const y = voxel[1] + dy;
        if (other < 0 || y < 0 || other >= otherCount || y >= grid.ny) continue;
        // Each run of body voxels along this column.
        let from = -1;
        for (let at = 0; at <= count; at += 1) {
          const inside = at < count && mask[axis === 0 ? voxelIndex(grid, at, y, other) : voxelIndex(grid, other, y, at)];
          if (inside && from < 0) from = at;
          if (!inside && from >= 0) {
            const middle = (from + at - 1) / 2;
            const gap = Math.abs(middle - voxel[axis]);
            if (gap < bestGap) {
              bestGap = gap;
              best = middle;
            }
            from = -1;
          }
        }
      }
    }
    if (best !== null) {
      const place: Point = [point[0], point[1], point[2]];
      place[axis] = origin + (best + 0.5) * grid.size;
      return place;
    }
  }
  return point;
};

/** A reading's points through a turn. */
const turnPoints = <T extends object>(points: T, turn: (point: Point) => Point): T => {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(points)) {
    if (typeof value === 'number') out[name] = value;
    else if (Array.isArray(value) && Array.isArray(value[0])) out[name] = (value as Point[]).map(turn);
    else if (Array.isArray(value)) out[name] = turn(value as Point);
    else out[name] = value;
  }
  return out as T;
};

/**
 * What a person standing in this box might be: for a mesh that does not read as one, a start for
 * placing the markers by hand. `facing` is the way they face, +Z if not said.
 */
export const standardReading = (triangles: TriangleSoup, facing: [number, number] = [0, 1]): BodyReading | null => {
  // Worked out on the box of a body turned to face +Z, then turned back.
  const cos = facing[1];
  const sin = -facing[0];
  const bounds = soupBounds(sin === 0 && cos === 1 ? triangles : turnSoupAboutY(triangles, sin, cos));
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
  const back = (point: Point): Point => turnAboutY(point, -sin, cos);
  return {
    kind: 'person',
    facing,
    markers: turnPoints<BodyMarkers>({
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
    }, back),
    extents: turnPoints<BodyExtents>({
      headTop: at(0, 1),
      leftHandTip: armAt(1, 1),
      rightHandTip: armAt(1, -1),
      leftToe: [x + 0.08 * height, min[1], z + 0.1 * height],
      rightToe: [x - 0.08 * height, min[1], z + 0.1 * height],
      floor: min[1],
    }, back),
  };
};

/**
 * What an animal on four legs standing in this box might be, its head towards `facing`: for a mesh
 * that does not read as one, a start for placing the markers by hand.
 */
export const standardFourLegReading = (triangles: TriangleSoup, facing?: [number, number]): FourLegReading | null => {
  const whole = soupBounds(triangles);
  if (!whole) return null;
  // Along its longer way across the ground, unless told.
  const way: [number, number] = facing ?? (whole.max[2] - whole.min[2] >= whole.max[0] - whole.min[0] ? [0, 1] : [1, 0]);
  const cos = way[1];
  const sin = -way[0];
  const bounds = soupBounds(sin === 0 && cos === 1 ? triangles : turnSoupAboutY(triangles, sin, cos));
  if (!bounds) return null;
  const { min, max } = bounds;
  const height = max[1] - min[1];
  const length = max[2] - min[2];
  const width = max[0] - min[0];
  if (!(height > 0) || !(length > 0)) return null;
  const x = (min[0] + max[0]) / 2;
  // `along` runs from the back of the box to the front, `up` from its floor to its top, `across` out to its side.
  const at = (across: number, up: number, along: number): Point => [x + (across * width) / 2, min[1] + up * height, min[2] + along * length];
  const back = (point: Point): Point => turnAboutY(point, -sin, cos);
  const frontLeg = (side: number) => ({
    shoulder: at(side * 0.5, 0.5, 0.68),
    elbow: at(side * 0.55, 0.35, 0.65),
    wrist: at(side * 0.55, 0.17, 0.66),
    paw: at(side * 0.55, 0.06, 0.66),
    toe: at(side * 0.55, 0, 0.7),
  });
  const hindLeg = (side: number) => ({
    hip: at(side * 0.5, 0.56, 0.2),
    knee: at(side * 0.55, 0.36, 0.26),
    hock: at(side * 0.55, 0.2, 0.15),
    paw: at(side * 0.55, 0.06, 0.18),
    toe: at(side * 0.55, 0, 0.22),
  });
  const [frontLeft, frontRight, hindLeft, hindRight] = [frontLeg(1), frontLeg(-1), hindLeg(1), hindLeg(-1)];
  const hips = at(0, 0.68, 0.2);
  const neck = at(0, 0.72, 0.68);
  const head = at(0, 0.85, 0.85);
  const tailBase = at(0, 0.72, 0.08);
  const tailTip = at(0, 0.45, 0);
  return {
    kind: 'fourLegs',
    facing: way,
    markers: turnPoints<FourLegMarkers>({
      nose: at(0, 0.72, 1),
      head,
      neck,
      hips,
      leftShoulder: frontLeft.shoulder,
      rightShoulder: frontRight.shoulder,
      leftElbow: frontLeft.elbow,
      rightElbow: frontRight.elbow,
      leftWrist: frontLeft.wrist,
      rightWrist: frontRight.wrist,
      leftFrontPaw: frontLeft.paw,
      rightFrontPaw: frontRight.paw,
      leftHip: hindLeft.hip,
      rightHip: hindRight.hip,
      leftKnee: hindLeft.knee,
      rightKnee: hindRight.knee,
      leftHock: hindLeft.hock,
      rightHock: hindRight.hock,
      leftHindPaw: hindLeft.paw,
      rightHindPaw: hindRight.paw,
      tailBase,
      tailTip,
    }, back),
    extents: turnPoints<FourLegExtents>({
      floor: min[1],
      leftFrontToe: frontLeft.toe,
      rightFrontToe: frontRight.toe,
      leftHindToe: hindLeft.toe,
      rightHindToe: hindRight.toe,
      back: [hips, neck],
      neckLine: [head, neck],
      tailLine: [tailBase, tailTip],
    }, back),
  };
};

export interface ReadBody {
  reading: RigReading | null;
  /** The mesh did not read as this kind of body, so the markers only start from its usual proportions. */
  guessed: boolean;
}

/** Reads a mesh as a body of this kind, or starts from its usual proportions if it does not read as one. */
export const readAs = (triangles: TriangleSoup, kind: BodyKind, facing?: [number, number]): ReadBody => {
  const reading = kind === 'fourLegs' ? readFourLegs(triangles, facing) : readBody(triangles, facing);
  if (reading) return { reading, guessed: false };
  return { reading: kind === 'fourLegs' ? standardFourLegReading(triangles, facing) : standardReading(triangles, facing), guessed: true };
};

/** Reads a mesh as whichever kind of body it looks like, or as the other if that is what it turns out to read as. */
export const readAnyBody = (triangles: TriangleSoup): ReadBody => {
  const first: BodyKind = looksFourLegged(triangles) ? 'fourLegs' : 'person';
  const read = readAs(triangles, first);
  if (!read.guessed) return read;
  const other = readAs(triangles, first === 'person' ? 'fourLegs' : 'person');
  return other.guessed ? read : other;
};

/** A hand tip when a person moves the forearm: keeps the hand's length and its direction from the forearm. */
const followForearm = (oldElbow: Point, oldWrist: Point, elbow: Point, wrist: Point, tip: Point): Point => {
  const before = new THREE.Vector3(...oldWrist).sub(new THREE.Vector3(...oldElbow)).normalize();
  const after = new THREE.Vector3(...wrist).sub(new THREE.Vector3(...elbow)).normalize();
  const hand = new THREE.Vector3(...tip).sub(new THREE.Vector3(...oldWrist)).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(before, after));
  return [wrist[0] + hand.x, wrist[1] + hand.y, wrist[2] + hand.z];
};

/** A toe when a person moves the ankle or the paw above it. */
const followAnkle = (oldAnkle: Point, ankle: Point, toe: Point): Point => [
  toe[0] + ankle[0] - oldAnkle[0],
  toe[1],
  toe[2] + ankle[2] - oldAnkle[2],
];

export interface RiggedBody {
  joints: RigJoint[];
  weights: PartWeights[];
}

/** The skeleton of a person from their markers, in a body turned to face +Z. */
const personJoints = (triangles: TriangleSoup, reading: BodyReading, up: (point: Point) => Point, moved: readonly RigMarkerName[], original: RigMarkers | undefined, withFingers: boolean): RigJoint[] => {
  const markers = turnPoints(reading.markers, up);
  const extents = turnPoints(reading.extents, up);
  if (moved.length) {
    const grid = voxelize(triangles, CENTRING_RESOLUTION);
    if (grid) {
      const mask = largestPiece(grid);
      for (const name of moved as MarkerName[]) markers[name] = centreAlong(grid, mask, markers[name], 2);
    }
    if (original) {
      const before = original as BodyMarkers;
      if (moved.includes('leftWrist') || moved.includes('leftElbow')) extents.leftHandTip = followForearm(up(before.leftElbow), up(before.leftWrist), markers.leftElbow, markers.leftWrist, extents.leftHandTip);
      if (moved.includes('rightWrist') || moved.includes('rightElbow')) extents.rightHandTip = followForearm(up(before.rightElbow), up(before.rightWrist), markers.rightElbow, markers.rightWrist, extents.rightHandTip);
      if (moved.includes('leftAnkle')) extents.leftToe = followAnkle(up(before.leftAnkle), markers.leftAnkle, extents.leftToe);
      if (moved.includes('rightAnkle')) extents.rightToe = followAnkle(up(before.rightAnkle), markers.rightAnkle, extents.rightToe);
    }
  }
  return bodySkeleton(markers, extents, withFingers ? {
    left: readFingers(triangles, markers.leftWrist, extents.leftHandTip),
    right: readFingers(triangles, markers.rightWrist, extents.rightHandTip),
  } : {});
};

/** Markers down the middle of an animal: dragged side on, they stay there. */
const FOUR_LEG_MIDDLE = new Set<RigMarkerName>(['nose', 'head', 'neck', 'hips', 'tailBase', 'tailTip']);

/** The skeleton of an animal from its markers, in a body turned to face +Z. */
const fourLegJoints = (triangles: TriangleSoup, reading: FourLegReading, up: (point: Point) => Point, moved: readonly RigMarkerName[], original: RigMarkers | undefined, withTail: boolean): RigJoint[] => {
  const markers = turnPoints(reading.markers, up);
  const extents = turnPoints(reading.extents, up);
  if (moved.length) {
    const grid = voxelize(triangles, CENTRING_RESOLUTION);
    if (grid) {
      const mask = largestPiece(grid);
      for (const name of moved as FourLegMarkerName[]) {
        const place = markers[name];
        if (place && !FOUR_LEG_MIDDLE.has(name)) markers[name] = centreAlong(grid, mask, place, 0);
      }
    }
    if (original) {
      const before = original as FourLegMarkers;
      if (moved.includes('leftFrontPaw')) extents.leftFrontToe = followAnkle(up(before.leftFrontPaw), markers.leftFrontPaw, extents.leftFrontToe);
      if (moved.includes('rightFrontPaw')) extents.rightFrontToe = followAnkle(up(before.rightFrontPaw), markers.rightFrontPaw, extents.rightFrontToe);
      if (moved.includes('leftHindPaw')) extents.leftHindToe = followAnkle(up(before.leftHindPaw), markers.leftHindPaw, extents.leftHindToe);
      if (moved.includes('rightHindPaw')) extents.rightHindToe = followAnkle(up(before.rightHindPaw), markers.rightHindPaw, extents.rightHindToe);
    }
  }
  return fourLegSkeleton(markers, extents, withTail);
};

/**
 * The skeleton for `reading`'s markers, with `moved` ones put back in the limb's middle, and its
 * weights on `parts`. `original` holds where the markers were before they were moved, if any were;
 * everything is in the mesh's space. With `withFingers`, a person's hands that have room for them get
 * fingers; with `withTail`, an animal's tail gets bones if it has one.
 */
export const rigBody = (
  triangles: TriangleSoup,
  parts: readonly SkinnedPart[],
  reading: RigReading,
  moved: readonly RigMarkerName[],
  onProgress?: (share: number) => void,
  original?: RigMarkers,
  withFingers = true,
  withTail = true,
): RiggedBody => {
  // Everything is worked out on a body turned to face +Z, then turned back.
  const cos = reading.facing[1];
  const sin = -reading.facing[0];
  const square = sin === 0 && cos === 1;
  const uprightTriangles = square ? triangles : turnSoupAboutY(triangles, sin, cos);
  const up = (point: Point): Point => (square ? point : turnAboutY(point, sin, cos));
  onProgress?.(0.02);
  const joints = reading.kind === 'fourLegs'
    ? fourLegJoints(uprightTriangles, reading, up, moved, original, withTail)
    : personJoints(uprightTriangles, reading, up, moved, original, withFingers);
  onProgress?.(0.05);
  const uprightParts = square ? parts : parts.map((part) => ({ ...part, positions: turnSoupAboutY(part.positions, sin, cos) }));
  const weights = bindSkin(uprightTriangles, joints, uprightParts, (share) => onProgress?.(0.05 + share * 0.95));
  return { joints: square ? joints : turnJointsAboutY(joints, -sin, cos), weights };
};
