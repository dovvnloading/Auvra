import { createHistory } from '../history';
import type { Point } from './bodyMarkers';
import type { RigMarkerName, RigMarkers, RigReading } from './rigBody';

export interface RigGuide {
  name: RigMarkerName;
  label: string;
  side: 'Left' | 'Right' | 'Center';
  point: Point;
}

const PERSON_GUIDES: readonly RigMarkerName[] = [
  'chin', 'groin', 'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow',
  'leftWrist', 'rightWrist', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle',
];
const FOUR_LEG_GUIDES: readonly RigMarkerName[] = [
  'nose', 'head', 'neck', 'hips', 'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow',
  'leftWrist', 'rightWrist', 'leftFrontPaw', 'rightFrontPaw', 'leftHip', 'rightHip',
  'leftKnee', 'rightKnee', 'leftHock', 'rightHock', 'leftHindPaw', 'rightHindPaw', 'tailBase', 'tailTip',
];

/** Markers joined by lines, to show the skeleton they make. */
const PERSON_LINKS: readonly (readonly [RigMarkerName, RigMarkerName])[] = [
  ['chin', 'groin'],
  ['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist'],
  ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist'],
  ['leftShoulder', 'rightShoulder'],
  ['groin', 'leftKnee'], ['leftKnee', 'leftAnkle'],
  ['groin', 'rightKnee'], ['rightKnee', 'rightAnkle'],
];

const FOUR_LEG_LINKS: readonly (readonly [RigMarkerName, RigMarkerName])[] = [
  ['nose', 'head'], ['head', 'neck'], ['neck', 'hips'], ['hips', 'tailBase'], ['tailBase', 'tailTip'],
  ['neck', 'leftShoulder'], ['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist'], ['leftWrist', 'leftFrontPaw'],
  ['neck', 'rightShoulder'], ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist'], ['rightWrist', 'rightFrontPaw'],
  ['hips', 'leftHip'], ['leftHip', 'leftKnee'], ['leftKnee', 'leftHock'], ['leftHock', 'leftHindPaw'],
  ['hips', 'rightHip'], ['rightHip', 'rightKnee'], ['rightKnee', 'rightHock'], ['rightHock', 'rightHindPaw'],
];

export const guideLinksFor = (reading: RigReading): readonly (readonly [RigMarkerName, RigMarkerName])[] =>
  reading.kind === 'person' ? PERSON_LINKS : FOUR_LEG_LINKS;

const pointOf = (markers: RigMarkers, name: RigMarkerName): Point | undefined =>
  (markers as Partial<Record<RigMarkerName, Point>>)[name];

export const markerAt = (reading: RigReading, name: RigMarkerName): Point | undefined => pointOf(reading.markers, name);

export const listRigGuides = (reading: RigReading): RigGuide[] =>
  (reading.kind === 'person' ? PERSON_GUIDES : FOUR_LEG_GUIDES).flatMap((name) => {
    const point = markerAt(reading, name);
    if (!point) return [];
    const words = name.replace(/[A-Z]/g, (letter) => ' ' + letter.toLowerCase());
    const label = words[0].toUpperCase() + words.slice(1);
    const side = name.startsWith('left') ? 'Left' : name.startsWith('right') ? 'Right' : 'Center';
    return [{ name, label, side, point }];
  });

const partnerOf = (name: RigMarkerName): RigMarkerName | null => {
  if (name.startsWith('left')) return `right${name.slice(4)}` as RigMarkerName;
  if (name.startsWith('right')) return `left${name.slice(5)}` as RigMarkerName;
  return null;
};

const samePoint = (a: Point, b: Point): boolean => a.every((v, i) =>
  Math.abs(v - b[i]) <= 8 * Number.EPSILON * Math.max(1, Math.abs(v), Math.abs(b[i])));

/** Horizontal axis in the fitted view: across a person, along the flank of an animal. */
const horizontalAxis = (reading: RigReading): [number, number] => {
  const [fx, fz] = reading.facing;
  return reading.kind === 'person' ? [fz, -fx] : [-fx, -fz];
};

export const projectGuidePoint = (reading: RigReading, point: Point): [number, number] => {
  const [x, z] = horizontalAxis(reading);
  return [x * point[0] + z * point[2], point[1]];
};

export const guidePlanePosition = (reading: RigReading, name: RigMarkerName): [number, number] | null => {
  const point = markerAt(reading, name);
  return point ? projectGuidePoint(reading, point) : null;
};

/** Edits the two coordinates used by the binder, preserving the hidden depth. */
export const guidePointAt = (reading: RigReading, name: RigMarkerName, horizontal: number, height: number): Point | null => {
  const old = markerAt(reading, name);
  if (!old || !Number.isFinite(horizontal) || !Number.isFinite(height)) return null;
  const [x, z] = horizontalAxis(reading);
  const delta = horizontal - (x * old[0] + z * old[2]);
  return [old[0] + x * delta, height, old[2] + z * delta];
};

export const guideStep = (reading: RigReading): number => {
  const height = reading.kind === 'person'
    ? reading.extents.headTop[1] - reading.extents.floor
    : Math.max(reading.markers.head[1] - reading.extents.floor,
      Math.hypot(reading.markers.nose[0] - reading.markers.hips[0], reading.markers.nose[2] - reading.markers.hips[2]));
  return height * 0.005;
};

/** Immutable marker snapshots retain hand edits and their mirror partners as one operation. */
export class RigGuideEdits {
  private history = createHistory<RigMarkers>();
  private dragStart: RigMarkers | null = null;
  readonly original: RigMarkers;
  markers: RigMarkers;
  private readonly names: RigMarkerName[];

  constructor(private readonly fit: RigReading) {
    this.original = fit.markers;
    this.markers = this.original;
    this.names = listRigGuides(fit).map((guide) => guide.name);
  }

  private different(a: RigMarkers, b: RigMarkers): RigMarkerName[] {
    return this.names.filter((name) => !samePoint(pointOf(a, name)!, pointOf(b, name)!));
  }

  get edited(): RigMarkerName[] { return this.different(this.markers, this.original); }
  get canUndo(): boolean { return this.history.canUndo; }
  get canRedo(): boolean { return this.history.canRedo; }

  beginDrag(): void {
    if (!this.dragStart) this.dragStart = this.markers;
  }

  endDrag(cancel = false): void {
    const before = this.dragStart;
    if (!before) return;
    this.dragStart = null;
    if (cancel) this.markers = before;
    else if (this.different(before, this.markers).length) this.history.push(before);
  }

  private apply(next: RigMarkers): void {
    if (!this.different(this.markers, next).length) return;
    if (!this.dragStart) this.history.push(this.markers);
    this.markers = next;
  }

  move(name: RigMarkerName, point: Point, mirror: boolean): void {
    const previous = pointOf(this.markers, name);
    if (!previous || !point.every(Number.isFinite) || samePoint(previous, point)) return;
    const markers = { ...this.markers, [name]: point };
    const partner = mirror ? partnerOf(name) : null;
    if (partner && pointOf(this.markers, partner)) {
      const middle = pointOf(this.markers, this.fit.kind === 'fourLegs' ? 'hips' : 'groin')!;
      const [fx, fz] = this.fit.facing;
      const distance = (point[0] - middle[0]) * fz - (point[2] - middle[2]) * fx;
      const reflected: Point = [point[0] - 2 * distance * fz, point[1], point[2] + 2 * distance * fx];
      Object.assign(markers, { [partner]: reflected });
    }
    this.apply(markers);
  }

  replace(markers: RigMarkers): void {
    this.endDrag();
    this.apply(markers);
  }

  reset(name?: RigMarkerName, mirror = false): void {
    if (!name) { this.apply(this.original); return; }
    const point = pointOf(this.original, name);
    if (!point) return;
    const markers = { ...this.markers, [name]: point };
    const partner = mirror ? partnerOf(name) : null;
    if (partner && pointOf(this.original, partner)) Object.assign(markers, { [partner]: pointOf(this.original, partner) });
    this.apply(markers);
  }

  undo(): void {
    this.endDrag();
    this.markers = this.history.undo(this.markers) ?? this.markers;
  }

  redo(): void {
    this.endDrag();
    this.markers = this.history.redo(this.markers) ?? this.markers;
  }
}
