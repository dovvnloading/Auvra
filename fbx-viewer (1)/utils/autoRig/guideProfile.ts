import type { Point } from './bodyMarkers';
import { listRigGuides } from './guideEditing';
import type { BodyKind, RigMarkerName, RigMarkers, RigReading } from './rigBody';

/** Relative edits in the fitted body's lateral, vertical and forward axes. */
export interface RigGuideProfile {
  format: 'auvra-rig-guides';
  version: 1;
  body: BodyKind;
  offsets: Partial<Record<RigMarkerName, Point>>;
}

export const parseGuideProfile = (text: string): RigGuideProfile => {
  const value = JSON.parse(text);
  if (value?.format !== 'auvra-rig-guides' || value.version !== 1 || !['person', 'fourLegs'].includes(value.body)
    || !value.offsets || typeof value.offsets !== 'object' || Array.isArray(value.offsets)) {
    throw new Error('Choose an Auvra guide profile, version 1.');
  }
  for (const [name, delta] of Object.entries(value.offsets)) {
    if (!/^[a-z][a-zA-Z]*$/.test(name) || !Array.isArray(delta) || delta.length !== 3 || !delta.every(Number.isFinite)) {
      throw new Error('This profile contains an invalid guide offset.');
    }
  }
  return value as RigGuideProfile;
};

// The initial fit, independent of all later edits, defines a stable scale for differently sized models.
const fitScale = (markers: RigMarkers): number => {
  const points = Object.values(markers).filter((point): point is Point => Array.isArray(point));
  let span = 0;
  for (const [i, a] of points.entries()) {
    for (const b of points.slice(i + 1)) {
      span = Math.max(span, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
  }
  if (!Number.isFinite(span) || span <= 0) throw new Error('The fitted guides have no measurable extent.');
  return span;
};

export const captureGuideProfile = (reading: RigReading, original: RigMarkers): RigGuideProfile => {
  const scale = fitScale(original);
  const [fx, fz] = reading.facing;
  const offsets: RigGuideProfile['offsets'] = {};
  for (const { name, point } of listRigGuides(reading)) {
    const from = (original as Partial<Record<RigMarkerName, Point>>)[name];
    if (!from) continue;
    const [x, y, z] = point.map((value, axis) => (value - from[axis]) / scale);
    if (x || y || z) offsets[name] = [fz * x - fx * z, y, fx * x + fz * z];
  }
  return { format: 'auvra-rig-guides', version: 1, body: reading.kind, offsets };
};

export const restoreGuideProfile = (profile: RigGuideProfile, reading: RigReading, original: RigMarkers): RigMarkers => {
  if (profile.body !== reading.kind) throw new Error(`Choose a ${reading.kind === 'person' ? 'humanoid' : 'quadruped'} guide profile for this mesh.`);
  const scale = fitScale(original);
  const [fx, fz] = reading.facing;
  const result = { ...original } as Partial<Record<RigMarkerName, Point>>;
  for (const [name, delta] of Object.entries(profile.offsets)) {
    const guide = name as RigMarkerName;
    if (!Object.hasOwn(original, guide) || !result[guide]) throw new Error(`This fit has no ${name} guide.`);
    const [a, h, f] = delta;
    const from = result[guide];
    const point: Point = [from[0] + (fz * a + fx * f) * scale, from[1] + h * scale, from[2] + (-fx * a + fz * f) * scale];
    if (!point.every(Number.isFinite)) throw new Error('The guide coordinates exceed the model’s range.');
    result[guide] = point;
  }
  return result as RigMarkers;
};
