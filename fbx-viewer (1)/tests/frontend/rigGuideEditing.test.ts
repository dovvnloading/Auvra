import { describe, expect, it } from 'vitest';
import { guideLinksFor, guidePlanePosition, guidePointAt, guideStep, listRigGuides, RigGuideEdits } from '../../utils/autoRig/guideEditing';
import { standardFourLegReading, standardReading } from '../../utils/autoRig/rigBody';
import type { Point } from '../../utils/autoRig/bodyMarkers';

const bounds = new Float32Array([-1, 0, -0.5, 1, 0, 0.5, 0, 2, 0]);
const person = () => standardReading(bounds)!;
const quad = () => standardFourLegReading(bounds, [0, 1])!;

describe('rig guide editing', () => {
  it('tracks a mirrored drag as one edit and leaves read coordinates intact', () => {
    const fit = person();
    const initial = fit.markers.leftWrist;
    const edits = new RigGuideEdits(fit);
    edits.beginDrag();
    edits.move('leftWrist', [0.5, 1.1, 0.1], true);
    edits.move('leftWrist', [0.6, 1.2, 0.2], true);
    edits.endDrag();
    expect(edits.markers.leftWrist).toEqual([0.6, 1.2, 0.2]);
    expect(edits.markers.rightWrist).toEqual([-0.6, 1.2, 0.2]);
    expect(fit.markers.leftWrist).toEqual(initial);
    expect(edits.edited).toEqual(['leftWrist', 'rightWrist']);
    edits.undo();
    expect(edits.canUndo).toBe(false);
    expect(edits.markers).toBe(fit.markers);
    expect(edits.edited).toEqual([]);
    edits.redo();
    expect(edits.edited).toEqual(['leftWrist', 'rightWrist']);
  });

  it('cancels a drag without consuming redo or leaving changes for the binder', () => {
    const fit = person();
    const edits = new RigGuideEdits(fit);
    edits.move('chin', [0.2, 1.9, 0], true);
    edits.undo();
    edits.beginDrag();
    edits.move('leftKnee', [0.13, 1, 0], true);
    edits.endDrag(true);
    expect(edits.canRedo).toBe(true);
    expect(edits.canUndo).toBe(false);
    expect(edits.edited).toEqual([]);
    edits.redo();
    expect(edits.edited).toEqual(['chin']);
  });

  it('keeps unmirrored changes separate and resets each partner to its own fitted position', () => {
    const fit = person();
    fit.markers.rightWrist = [-0.7, 1.45, 0.18];
    const edits = new RigGuideEdits(fit);
    edits.move('leftWrist', [0.6, 1.2, 0.2], false);
    expect(edits.edited).toEqual(['leftWrist']);
    edits.move('rightWrist', [-0.8, 1.52, -0.1], false);
    edits.reset('leftWrist', true);
    expect(edits.edited).toEqual([]);
    expect(edits.markers.rightWrist).toBe(fit.markers.rightWrist);
    edits.undo();
    expect(edits.edited).toEqual(['leftWrist', 'rightWrist']);
    edits.reset('leftWrist', false);
    expect(edits.edited).toEqual(['rightWrist']);
    edits.reset();
    expect(edits.edited).toEqual([]);
    expect(edits.canRedo).toBe(false);
  });

  it('applies a full profile as one edit and keeps only its actual deltas', () => {
    const fit = person();
    const edits = new RigGuideEdits(fit);
    const profileMarkers = { ...fit.markers, chin: [0, 1.92, 0] as Point, leftKnee: [0.14, 0.7, 0] as Point };
    edits.replace(profileMarkers);
    edits.replace({ ...profileMarkers });
    expect(edits.edited).toEqual(['chin', 'leftKnee']);
    edits.undo();
    expect(edits.edited).toEqual([]);
    expect(edits.canUndo).toBe(false);
    edits.redo();
    expect(edits.markers).toEqual(profileMarkers);
  });

  it('does not add history for empty drags, invalid coordinates or absent guides', () => {
    const fit = person();
    const edits = new RigGuideEdits(fit);
    edits.beginDrag();
    edits.move('chin', [...fit.markers.chin], true);
    edits.endDrag();
    edits.move('rightWrist', [Infinity, 1, 0], true);
    edits.move('nose', [0, 1, 0], false);
    edits.reset('tailTip');
    expect(edits.canUndo).toBe(false);
    expect(edits.markers).toBe(fit.markers);
  });

  it('projects numeric and keyboard edits onto a rotated biped or quadruped fitting plane', () => {
    const facing: [number, number] = [Math.SQRT1_2, Math.SQRT1_2];
    for (const fit of [standardReading(bounds, facing)!, standardFourLegReading(bounds, facing)!]) {
      const [u, v] = guidePlanePosition(fit, 'leftElbow')!;
      const old = fit.markers.leftElbow;
      const step = guideStep(fit);
      const moved = guidePointAt(fit, 'leftElbow', u + step, v - step)!;
      const newFit = { ...fit, markers: { ...fit.markers, leftElbow: moved } } as typeof fit;
      const [newU, newV] = guidePlanePosition(newFit, 'leftElbow')!;
      expect(newU).toBeCloseTo(u + step);
      expect(newV).toBeCloseTo(v - step);
      const depth = (p: Point) => fit.kind === 'person'
        ? p[0] * facing[0] + p[2] * facing[1] : p[0] * facing[1] - p[2] * facing[0];
      expect(depth(moved)).toBeCloseTo(depth(old));
      expect(guidePointAt(fit, 'leftElbow', NaN, 0)).toBeNull();
    }
  });

  it('lists the markers available in each individual fit and distinguishes both sets of paws', () => {
    const fit = quad();
    delete fit.markers.tailBase;
    delete fit.markers.tailTip;
    const guides = listRigGuides(fit);
    expect(guides).toContainEqual({ name: 'leftHindPaw', label: 'Left hind paw', side: 'Left', point: fit.markers.leftHindPaw });
    expect(guides).toContainEqual({ name: 'rightFrontPaw', label: 'Right front paw', side: 'Right', point: fit.markers.rightFrontPaw });
    expect(guides.some((guide) => guide.name === 'tailTip')).toBe(false);
    expect(guidePlanePosition(fit, 'tailTip')).toBeNull();
    expect(guideLinksFor(fit)).toContainEqual(['leftHock', 'leftHindPaw']);
    expect(guideLinksFor(person())).toContainEqual(['leftElbow', 'leftWrist']);
  });
});
