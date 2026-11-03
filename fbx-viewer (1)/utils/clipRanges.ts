import * as THREE from 'three';
import type { ClipRange, ModelImportSettings } from '../types';
import type { ModelConvertOptions } from '../workers/fbxImport.worker';
import { findRootMotionTrack, positionTrackNode } from '../components/AnimationGraph/utils/rootMotion';

/**
 * Cutting takes into clips. Many art kits and motion capture files keep every action on one long
 * timeline, so a model can name stretches of a take, and each stretch comes in as a clip of its own.
 * The cut works on the clips as loaded, so every format gets it the same way.
 */

/** How an import reads a model: what the importer is told, and the clips to cut from what it reads. */
export type ModelReadOptions = ModelConvertOptions & { clipRanges?: readonly ClipRange[] };

const MAX_RANGES = 1024;
const MAX_NAME_LENGTH = 256;
/** The shortest clip a range makes, in seconds. */
const MIN_RANGE_SECONDS = 1e-3;
/** A key this close to where a range starts or ends is taken to be there. */
const KEY_EPSILON = 1e-4;
/** Keys per second a smooth glTF curve is sampled at, as a cut makes it a plain one. */
const SPLINE_SAMPLE_RATE = 60;
/** A root further than this share of its height from where the take starts has travelled, rather than swayed. */
const TRAVEL_SHARE = 0.5;

/** Where a clip came from: its take's name in its file, and where the take sits on the file's timeline. */
interface TakeNote {
  take: string;
  start: number;
  framesPerSecond: number;
}

const notes = new WeakMap<THREE.AnimationClip, TakeNote>();
const cuts = new WeakMap<THREE.AnimationClip, ClipRange>();

/** The take's own name: exporters often stack its object's name in front ("Armature|Armature|Walk"). */
export const takeLabel = (name: string): string => name.split('|').pop() || name;

/** Records the take a clip is, under its name in the file, before anything renames it. */
export const noteClipTake = (clip: THREE.AnimationClip, take: string, start = 0, framesPerSecond = 0): void => {
  notes.set(clip, { take, start, framesPerSecond });
};

/** The take a clip came from, by its name in the file; null for a clip nothing recorded one for. */
export const clipTake = (clip: THREE.AnimationClip): string | null => notes.get(clip)?.take ?? null;

/** Where a clip's take starts on its file's timeline, and the file's frames per second; 0 when the file does not say. */
export const clipTiming = (clip: THREE.AnimationClip): { start: number; framesPerSecond: number } => {
  const note = notes.get(clip);
  return { start: note?.start ?? 0, framesPerSecond: note?.framesPerSecond ?? 0 };
};

/** The range a clip was cut by; null for a whole take. */
export const clipRange = (clip: THREE.AnimationClip): ClipRange | null => cuts.get(clip) ?? null;

/** Whether a clip loops, when it says: a clip cut by a range does, and a whole take leaves it to what plays it. */
export const clipLoops = (clip: THREE.AnimationClip): boolean | undefined => cuts.get(clip)?.loop;

/** Makes `copy` say what `clip` says about looping: a mirrored copy loops if its clip does. */
export const copyClipRange = (clip: THREE.AnimationClip, copy: THREE.AnimationClip): void => {
  const range = cuts.get(clip);
  if (range) cuts.set(copy, range);
};

/** The whole takes among `clips`: the ones the names stored with a model's document are for. */
export const wholeClips = (clips: readonly THREE.AnimationClip[]): THREE.AnimationClip[] => clips.filter((clip) => !cuts.has(clip));

/** `names` made unique among themselves and against `taken` ("Idle", then "Idle 2"); `taken` gains them. */
export const uniqueClipNames = (names: readonly string[], taken: Set<string>): string[] =>
  names.map((name) => {
    let candidate = name;
    for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${name} ${suffix}`;
    taken.add(candidate);
    return candidate;
  });

/** Stored or edited ranges as valid ones: anything malformed goes, and of clips with one name the first stays. */
export const resolveClipRanges = (stored: unknown): ClipRange[] => {
  if (!Array.isArray(stored)) return [];
  const names = new Set<string>();
  const ranges: ClipRange[] = [];
  for (const entry of stored) {
    const { take, name, start, end, loop, recentre, attached } = (entry ?? {}) as Partial<ClipRange>;
    if (typeof take !== 'string' || !take || take.length > MAX_NAME_LENGTH) continue;
    if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME_LENGTH || names.has(name)) continue;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue;
    names.add(name);
    ranges.push({
      take, name, start, end, loop: loop === true,
      ...(typeof recentre === 'boolean' ? { recentre } : {}),
      ...(attached === true ? { attached } : {}),
    });
    if (ranges.length === MAX_RANGES) break;
  }
  return ranges;
};

type TrackType = new (name: string, times: ArrayLike<number>, values: ArrayLike<number>, interpolation?: THREE.InterpolationModes) => THREE.KeyframeTrack;
type CurveTrack = THREE.KeyframeTrack & {
  createInterpolant: ((result?: Float32Array) => THREE.Interpolant) & { isInterpolantFactoryMethodGLTFCubicSpline?: boolean };
};

const isSpline = (track: THREE.KeyframeTrack): boolean => (track as CurveTrack).createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline === true;

/** The times a cut track has keys at: where it starts and ends, and the track's own keys between. */
const keyTimes = (track: THREE.KeyframeTrack, start: number, end: number): number[] => {
  const times = [start];
  for (const time of track.times) {
    if (time > start + KEY_EPSILON && time < end - KEY_EPSILON) times.push(time);
  }
  if (isSpline(track)) {
    // A plain track only follows a smooth curve with keys along it.
    const steps = Math.ceil((end - start) * SPLINE_SAMPLE_RATE);
    for (let step = 1; step < steps; step += 1) times.push(start + ((end - start) * step) / steps);
    times.sort((a, b) => a - b);
    for (let index = times.length - 1; index > 0; index -= 1) {
      if (times[index] - times[index - 1] < KEY_EPSILON) times.splice(index, 1);
    }
  }
  if (end - times[times.length - 1] < KEY_EPSILON) times.pop();
  times.push(end);
  return times;
};

/** `track` from `start` to `end`, keeping its keys there and adding one where each end falls, at the value the track has there. */
const cutTrack = (track: THREE.KeyframeTrack, start: number, end: number): THREE.KeyframeTrack => {
  const Type = track.constructor as TrackType;
  const spline = isSpline(track);
  const size = spline ? track.getValueSize() / 3 : track.getValueSize();
  const sampler = (track as CurveTrack).createInterpolant();
  // One key holds one value throughout.
  const times = track.times.length === 1 ? [start] : keyTimes(track, start, end);
  const values = new (track.values.constructor as Float32ArrayConstructor)(times.length * size);
  times.forEach((time, key) => {
    const value = sampler.evaluate(time);
    for (let part = 0; part < size; part += 1) values[key * size + part] = value[part];
  });
  return new Type(track.name, times.map((time) => time - start), values, spline ? undefined : track.getInterpolation());
};

/** The root bone's travel along the floor by a time in a take. */
export interface RootTravel {
  /** The node the root track moves. */
  node: THREE.Object3D | null;
  /** The name of the node, as the track names it. */
  nodeName: string;
  /** The travel in the node's parent's space, the space the track's values are in. */
  shift: THREE.Vector3;
  /** Whether the root has gone far enough to mean it: not a sway, and not a crouch or a sit. */
  far: boolean;
}

/** How far along the floor the root is at `time` from where it is when the take starts; null without a root track. */
export const rootTravel = (take: THREE.AnimationClip, time: number, root?: THREE.Object3D | null): RootTravel | null => {
  const track = findRootMotionTrack(take, root);
  const nodeName = track && positionTrackNode(track);
  if (!track || !nodeName) return null;
  const sampler = (track as unknown as CurveTrack).createInterpolant();
  const first = new THREE.Vector3().fromArray(sampler.evaluate(0) as unknown as number[]);
  const shift = new THREE.Vector3().fromArray(sampler.evaluate(time) as unknown as number[]).sub(first);
  const node = root ? THREE.PropertyBinding.findNode(root, nodeName) as THREE.Object3D | null : null;
  // A file stood up on import can have the track's space on its side, so the floor is found in the world.
  const toWorld = new THREE.Matrix3();
  if (node?.parent) {
    node.parent.updateWorldMatrix(true, false);
    toWorld.setFromMatrix4(node.parent.matrixWorld);
  }
  shift.applyMatrix3(toWorld);
  shift.y = 0;
  const far = shift.length() > Math.abs(first.applyMatrix3(toWorld).y) * TRAVEL_SHARE;
  shift.applyMatrix3(toWorld.invert());
  return { node, nodeName, shift, far };
};

/** The travel a clip cut by `range` takes off its root so that it starts where the take starts; null when it keeps its place. */
export const rangeRootShift = (take: THREE.AnimationClip, range: Pick<ClipRange, 'start' | 'recentre'>, root?: THREE.Object3D | null): RootTravel | null => {
  if (range.recentre === false || range.start <= 0) return null;
  const travel = rootTravel(take, range.start, root);
  return travel && (range.recentre || travel.far) ? travel : null;
};

/** The clip `range` cuts from `take`, or null when none of the range is on the take. */
export const cutClip = (take: THREE.AnimationClip, range: ClipRange, root?: THREE.Object3D | null): THREE.AnimationClip | null => {
  const start = Math.max(0, range.start);
  const end = Math.min(take.duration, range.end);
  if (end - start < MIN_RANGE_SECONDS) return null;
  const rootTrack = findRootMotionTrack(take, root);
  const travel = rangeRootShift(take, range, root);
  const tracks = take.tracks.map((track) => {
    const cut = cutTrack(track, start, end);
    if (travel && track === rootTrack) {
      for (let key = 0; key < cut.values.length; key += 3) {
        cut.values[key] -= travel.shift.x;
        cut.values[key + 1] -= travel.shift.y;
        cut.values[key + 2] -= travel.shift.z;
      }
    }
    return cut;
  });
  const clip = new THREE.AnimationClip(range.name, end - start, tracks, take.blendMode);
  const { start: takeStart, framesPerSecond } = clipTiming(take);
  noteClipTake(clip, clipTake(take) ?? range.take, takeStart, framesPerSecond);
  cuts.set(clip, range);
  return clip;
};

/**
 * Settings chosen for one file, as they apply to other files of a batch: a range is of that file's
 * take, and a take left out because it was cut says nothing about a take of that name elsewhere.
 */
export const withoutClipRanges = (settings: ModelImportSettings): ModelImportSettings => {
  if (!settings.clipRanges?.length) return settings;
  const { clipRanges, excludedClips, ...rest } = settings;
  const kept = excludedClips?.filter((name) => !clipRanges.some((range) => range.take === name));
  return { ...rest, ...(kept?.length ? { excludedClips: kept } : {}) };
};

/** The take a range is cut from: by name, or the only one in the file, as a take's name can change between exports. */
const takeOfRange = (range: ClipRange, takes: readonly THREE.AnimationClip[]): THREE.AnimationClip | undefined =>
  takes.find((take) => clipTake(take) === range.take) ?? (takes.length === 1 ? takes[0] : undefined);

/** `takes` as a model should have them: those not left out, then the clips cut from them. */
const withRanges = (
  takes: readonly THREE.AnimationClip[],
  ranges: readonly ClipRange[],
  excludedClips: readonly string[] | undefined,
  root?: THREE.Object3D | null,
): THREE.AnimationClip[] => {
  const cutClips: THREE.AnimationClip[] = [];
  for (const range of ranges) {
    const take = takeOfRange(range, takes);
    const clip = take ? cutClip(take, range, root) : null;
    if (clip) cutClips.push(clip);
  }
  const out = new Set(excludedClips);
  // A take that was renamed is left out by its old name, which its ranges still say.
  for (const range of ranges) {
    const take = takes.length === 1 && out.has(range.take) ? clipTake(takes[0]) : null;
    if (take !== null) out.add(take);
  }
  return [...takes.filter((take) => !out.has(clipTake(take) ?? take.name)), ...cutClips];
};

/** A model's own takes, as read from its file, with its ranges cut and the takes it leaves out gone. */
export const cutModelTakes = (takes: readonly THREE.AnimationClip[], options: ModelReadOptions, root?: THREE.Object3D | null): THREE.AnimationClip[] =>
  withRanges(takes, (options.clipRanges ?? []).filter((range) => !range.attached), options.excludedClips, root);

/** Clips imported onto a model from a file of their own, under the names stored for them, as `cutModelTakes` treats its takes. */
export const cutAttachedClips = (clips: readonly THREE.AnimationClip[], options: ModelReadOptions, root?: THREE.Object3D | null): THREE.AnimationClip[] => {
  const ranges = (options.clipRanges ?? []).filter((range) => range.attached && clips.some((clip) => clip.name === range.take));
  // Such a clip is only left out for being cut: a take of the file with that name says nothing about it.
  return withRanges(clips, ranges, options.excludedClips?.filter((name) => ranges.some((range) => range.take === name)), root);
};

/**
 * Records where clips prepared for a model came from, under the names they now have: `prepared` were
 * made one for each of `source`. They are cloned or rebuilt in the making, so they know nothing of it.
 */
export const noteAttachedClips = (prepared: readonly THREE.AnimationClip[], source: readonly THREE.AnimationClip[]): void => {
  prepared.forEach((clip, index) => {
    const from = source[index];
    if (!from) return;
    const { start, framesPerSecond } = clipTiming(from);
    noteClipTake(clip, clip.name, start, framesPerSecond);
  });
};

/** What the importer is told: a take that is cut is read even when the take itself is left out. */
export const importerOptions = (read: ModelReadOptions | undefined): ModelConvertOptions | undefined => {
  if (!read) return undefined;
  const { clipRanges, ...convert } = read;
  if (!clipRanges?.length || !convert.excludedClips?.length) return convert;
  const cut = new Set(clipRanges.filter((range) => !range.attached).map((range) => range.take));
  return { ...convert, excludedClips: convert.excludedClips.filter((name) => !cut.has(name)) };
};

/**
 * The names a model's whole takes have when its file is read again. A take keeps the name it had, so
 * whatever plays it still finds it, whichever other takes come and go. Only a new file can have its
 * takes named differently: `newFileNames` are the stored names to give them in order, when it has as
 * many and none is a take the model had. Anything else keeps the name the file gives it. `taken`
 * holds the names of its other clips, and gains these.
 */
export const carriedClipNames = (
  clips: readonly THREE.AnimationClip[],
  previous: readonly THREE.AnimationClip[],
  newFileNames: unknown,
  taken: Set<string>,
): string[] => {
  const before = new Map<string, string>();
  for (const clip of wholeClips(previous)) {
    const take = clipTake(clip);
    if (take !== null && !before.has(take)) before.set(take, clip.name);
  }
  const known = (clip: THREE.AnimationClip): string | undefined => before.get(clipTake(clip) ?? '');
  const inOrder = !clips.some(known) && Array.isArray(newFileNames) && newFileNames.length === clips.length && newFileNames.every((name) => typeof name === 'string' && name.length > 0);
  return uniqueClipNames(clips.map((clip, index) => known(clip) ?? (inOrder ? newFileNames[index] as string : clip.name)), taken);
};

/** A time in a take as a frame on its file's timeline, as the file's author sees it. */
export const frameOfTime = (time: number, start: number, framesPerSecond: number): number => Math.round((start + time) * framesPerSecond);

/** A frame on a file's timeline as a time in a take that starts at `start`. */
export const timeOfFrame = (frame: number, start: number, framesPerSecond: number): number => frame / framesPerSecond - start;
