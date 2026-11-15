import { describe, expect, it } from 'vitest';
import type { Point } from '../../utils/autoRig/bodyMarkers';
import { captureGuideProfile, parseGuideProfile, restoreGuideProfile } from '../../utils/autoRig/guideProfile';
import { standardReading } from '../../utils/autoRig/rigBody';

const bounds = new Float32Array([-1, 0, -0.5, 1, 0, 0.5, 0, 2, 0]);
const source = () => standardReading(bounds, [0, 1])!;

describe('portable rig guide profiles', () => {
  it('transfers relative edits between different scales, orientations and origins', () => {
    const fit = source();
    const wrist = fit.markers.leftWrist;
    const adjusted = { ...fit, markers: { ...fit.markers, leftWrist: [wrist[0] + 0.3, wrist[1] - 0.2, wrist[2] + 0.08] as Point } };
    const profile = parseGuideProfile(JSON.stringify(captureGuideProfile(adjusted, fit.markers)));
    expect(Object.keys(profile.offsets)).toEqual(['leftWrist']);
    const transform = ([x, y, z]: Point): Point => [5 + 3 * z, 10 + 3 * y, -2 - 3 * x];
    const targetMarkers = { ...fit.markers };
    for (const key of Object.keys(targetMarkers) as (keyof typeof targetMarkers)[]) targetMarkers[key] = transform(fit.markers[key]);
    const target = { ...fit, facing: [1, 0] as [number, number], markers: targetMarkers };
    const result = restoreGuideProfile(profile, target, targetMarkers);
    transform(adjusted.markers.leftWrist).forEach((coordinate, i) => expect(result.leftWrist[i]).toBeCloseTo(coordinate, 9));
    expect(result.rightWrist).toBe(targetMarkers.rightWrist);
    expect(targetMarkers.leftWrist).toEqual(transform(wrist));
    expect(captureGuideProfile(fit, fit.markers).offsets).toEqual({});
  });

  it('rejects unsupported formats, non-finite offsets, incompatible bodies and unavailable guides', () => {
    const fit = source();
    const profile = captureGuideProfile(fit, fit.markers);
    expect(() => parseGuideProfile(JSON.stringify({ ...profile, version: 2 }))).toThrow(/version/);
    expect(() => parseGuideProfile(JSON.stringify({ ...profile, offsets: { chin: [1, null, 0] } }))).toThrow(/invalid/);
    expect(() => restoreGuideProfile({ ...profile, body: 'fourLegs' }, fit, fit.markers)).toThrow(/humanoid/);
    expect(() => restoreGuideProfile({ ...profile, offsets: { tailTip: [0, 0, 0] } }, fit, fit.markers)).toThrow(/no tailTip/);
  });
});
