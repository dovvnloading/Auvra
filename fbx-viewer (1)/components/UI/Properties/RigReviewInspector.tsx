import React from 'react';
import type { LoadedModelData } from '../../../types';
import {
  resetRigIkGoal, reviewedRigFile, setRigIkLimb, setRigInspectBone, setRigPose, setRigPoseAngle, setRigPoseAxis, setRigPoseBone,
  setRigPoseStrength, setShowRigBones, type RigPose, type RigSessionState,
} from '../../../utils/autoRig/rigSession';
import { rigIkOptions, type RigIkLimb } from '../../../utils/autoRig/reviewIk';
import { download } from '../../../texturing/zip';
import { CheckCircleIcon, DownloadIcon } from '../Icons';
import { Button, Segmented } from '../kit';

const POSES = [{ value: 'rest', label: 'Rest' }, { value: 'flex', label: 'Flex' }, { value: 'stride', label: 'Stride' },
  { value: 'twist', label: 'Twist' }, { value: 'joint', label: 'Joint' }, { value: 'ik', label: 'IK', hint: 'Pose limbs with inverse kinematics' }] as const;
const AXES = [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }, { value: 'z', label: 'Z' }] as const;

export const RigReviewInspector: React.FC<{ session: RigSessionState; model: LoadedModelData }> = ({ session, model }) => {
  const review = session.review;
  if (!review) return null;
  const bones = review.boneNames.map((name) => <option key={name} value={name}>{name}</option>);
  return (
    <>
      <section className="border-b border-line px-3 py-3">
        <div className="mb-3 flex items-center gap-1.5 font-medium text-ink"><CheckCircleIcon className="text-ok" size={15} />Binding verified</div>
        <dl className="grid grid-cols-3 divide-x divide-line">
          {[[review.joints, 'Bones'], [review.vertices, 'Vertices'], [review.maxInfluences, 'Max influences']].map(([value, label]) => <div key={label} className="px-2 first:pl-0">
            <dt className="text-2xs text-ink-3">{label}</dt><dd className="font-mono text-sm text-ink">{value.toLocaleString()}</dd>
          </div>)}
        </dl>
      </section>
      <section className="space-y-2.5 border-b border-line px-3 py-3">
        <h3 className="font-medium text-ink">Test deformation</h3>
        <Segmented<RigPose> label="Test pose" value={session.pose} options={POSES} onChange={setRigPose} />
        {session.pose === 'ik' && session.reading && <>
          <label className="block space-y-1 text-2xs">IK target
            <select className="rig-select" value={session.ikLimb} onChange={(event) => setRigIkLimb(event.target.value as RigIkLimb)}>
              {rigIkOptions(session.reading.kind).map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <p className="text-2xs leading-relaxed text-ink-2">Drag the target’s arrows or plane handles in the viewport. Other placed targets stay planted.</p>
          <div className="flex gap-1"><Button size="sm" disabled={!session.ikGoals[session.ikLimb]} onClick={() => resetRigIkGoal(session.ikLimb)}>Reset target</Button>
            <Button size="sm" variant="ghost" disabled={!Object.keys(session.ikGoals).length} onClick={() => resetRigIkGoal()}>Reset all targets</Button></div>
        </>}
        {session.pose === 'joint' && <>
          <label className="block space-y-1 text-2xs">Bone to rotate<select className="rig-select" value={session.poseBone} onChange={(event) => setRigPoseBone(event.target.value)}>{bones}</select></label>
          <div className="flex items-center justify-between gap-2"><span>Local axis</span><Segmented label="Joint rotation axis" options={AXES} value={session.poseAxis} onChange={setRigPoseAxis} /></div>
          <label className="flex items-center gap-2 text-2xs">Angle<input type="range" min={-90} max={90} value={session.poseAngle} className="min-w-0 flex-1 accent-blue-500" onChange={(event) => setRigPoseAngle(Number(event.target.value))} /><span className="w-9 text-right font-mono">{session.poseAngle}°</span></label>
        </>}
        {session.pose !== 'rest' && <label className="flex items-center gap-2 text-2xs">Pose strength<input type="range" min={0} max={100} value={Math.round(session.poseStrength * 100)}
          className="min-w-0 flex-1 accent-blue-500" onChange={(event) => setRigPoseStrength(Number(event.target.value) / 100)} /><span className="w-9 text-right font-mono">{Math.round(session.poseStrength * 100)}%</span></label>}
        <label className="flex min-h-6 items-center gap-2"><input className="h-3.5 w-3.5 accent-blue-500" type="checkbox" checked={session.showRigBones} onChange={(event) => setShowRigBones(event.target.checked)} />Show skeleton</label>
      </section>
      <section className="space-y-2 border-b border-line px-3 py-3">
        <label className="block space-y-2 font-medium text-ink">Inspect skin weights
          <select className="rig-select" value={session.inspectBone ?? ''} onChange={(event) => setRigInspectBone(event.target.value || null)}>
            <option value="">Material view</option>{bones}
          </select>
        </label>
        {session.inspectBone && <div className="flex items-center gap-2 text-2xs text-ink-3"><span>0%</span><span className="h-1.5 flex-1 rounded-sm" style={{ background: 'linear-gradient(90deg,#333847,#0d40d9,#1ad966,#f2261a)' }} /><span>100%</span></div>}
      </section>
      <div className="space-y-2 px-3 py-3"><p className="text-2xs leading-relaxed">Apply the rest-pose rig to this project asset, or download a separate skinned model.</p>
        <Button size="sm" icon={<DownloadIcon size={12} />} onClick={() => { const file = reviewedRigFile(model.object); if (file) download(file, file.name); }}>Download GLB</Button>
      </div>
    </>
  );
};
