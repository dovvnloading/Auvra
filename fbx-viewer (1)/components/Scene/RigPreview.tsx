import React, { useCallback, useLayoutEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type * as THREE from 'three';
import { getRigPreview, setRigInspectBone, setRigPoseBone, useRigSession } from '../../utils/autoRig/rigSession';
import { rigIkRestGoal, solveRigReviewIk } from '../../utils/autoRig/reviewIk';
import { RigIkGoal } from './RigIkGoal';
import { poseRigReview } from '../../utils/autoRig/rigReview';
import { SkeletonLines } from './SkeletonOverlay';
import { clearPreviewWeights, showPreviewWeights } from '../../utils/autoRig/previewWeights';

/** Shows the actual exported skin in the source model's place until Apply, Revise, or Cancel. */
export const RigPreview: React.FC<{ modelId: string; root: THREE.Object3D }> = ({ modelId, root }) => {
  const { stage, reading, pose, ikGoals, ikLimb, poseStrength, showRigBones, inspectBone, poseBone, poseAxis, poseAngle } = useRigSession();
  const preview = getRigPreview(modelId, root);
  const invalidate = useThree(three => three.invalidate);
  const select = useCallback((name: string) => {
    const entry = preview?.bones.find(({ bone }) => bone.name === name);
    if (!entry) return;
    setRigInspectBone(entry.name);
    if (pose === 'joint') setRigPoseBone(entry.name);
  }, [preview, pose]);

  useLayoutEffect(() => {
    if (!preview) return;
    const visible = root.visible;
    root.visible = false;
    invalidate();
    return () => { clearPreviewWeights(preview.model.object); root.visible = visible; invalidate(); };
  }, [preview, root, invalidate]);

  useLayoutEffect(() => {
    if (!preview || !reading) return;
    poseRigReview(preview.bones, reading.kind, pose, poseStrength, { name: poseBone, axis: poseAxis, angle: poseAngle });
    if (pose === 'ik') solveRigReviewIk(preview.model.object, preview.bones, reading.kind, reading.facing, ikGoals, poseStrength);
    preview.model.object.updateMatrixWorld(true);
    invalidate();
  }, [preview, reading, pose, poseStrength, poseBone, poseAxis, poseAngle, ikGoals, invalidate]);

  // Both roots are siblings. Copy the editor's placement, including any asset unit and blueprint scale.
  useFrame(() => {
    if (!preview) return;
    const object = preview.model.object;
    object.position.copy(root.position);
    object.quaternion.copy(root.quaternion);
    object.scale.copy(root.scale);
    object.updateWorldMatrix(true, true);
  }, -1);

  const selected = preview?.bones.find(entry => entry.name === inspectBone)?.bone.name ?? null;
  useLayoutEffect(() => {
    if (!preview) return;
    if (selected) showPreviewWeights(preview.model.object, selected);
    else clearPreviewWeights(preview.model.object);
    invalidate();
  }, [preview, selected, invalidate]);

  if (!preview) return null;
  const object = preview.model.object;
  const ikPoint = pose === 'ik' && stage === 'review' && reading
    ? ikGoals[ikLimb] ?? rigIkRestGoal(preview.bones, reading.kind, ikLimb)
    : null;
  return (
    <>
      <primitive object={object} dispose={null} />
      {ikPoint && <RigIkGoal key={ikLimb} model={object} limb={ikLimb} point={ikPoint} />}
      {showRigBones && <SkeletonLines root={object} selectedBone={selected} pickable={pose !== 'ik'} onPick={select} />}
    </>
  );
};
