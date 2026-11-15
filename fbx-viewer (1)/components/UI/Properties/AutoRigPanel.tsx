import React, { useEffect, useRef, useState } from 'react';
import { useScene } from '../../../context/SceneContext';
import type { LoadedModelData } from '../../../types';
import type { BodyKind } from '../../../utils/autoRig/rigBody';
import {
  cancelRig, completeRigSave, failRig, finishRig, previewRig, reviseRig, setRigBinding, setRigBody,
  setRigWithFingers, setRigWithTail, startRig, turnRigAround, useRigSession, type RigStage,
} from '../../../utils/autoRig/rigSession';
import { convertOptionsFor } from '../../../utils/processing/ModelTransforms';
import { ArrowRightIcon, BoneIcon, CheckIcon, ModelFileIcon, RotateIcon, SlidersIcon, WarningIcon } from '../Icons';
import { Button, Segmented, Spinner } from '../kit';
import { RigGuideInspector } from './RigGuideInspector';
import { RigGuideProfiles } from './RigGuideProfiles';
import { RigReviewInspector } from './RigReviewInspector';

const BODIES = [{ value: 'person', label: 'Humanoid' }, { value: 'fourLegs', label: 'Quadruped' }] as const;
const INFLUENCES = ['1', '2', '4'].map((value) => ({ value, label: value }));
const FALLOFF = [{ value: 'soft', label: 'Soft' }, { value: 'balanced', label: 'Balanced' }, { value: 'firm', label: 'Firm' }] as const;

const WorkflowHeader: React.FC<{ model: LoadedModelData; stage: RigStage }> = ({ model, stage }) => {
  const active = stage === 'review' || stage === 'saving' ? 2 : stage === 'placing' || stage === 'binding' ? 1 : 0;
  return (
    <header className="shrink-0 border-b border-line bg-panel">
      <div className="flex items-center gap-2.5 px-3 pb-3 pt-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded border border-line bg-well">
          {model.thumbnail ? <img className="h-full w-full object-contain" src={model.thumbnail} alt="" /> : <BoneIcon size={19} className="text-accent" />}
        </div>
        <div className="min-w-0"><h2 className="text-sm font-semibold text-ink">Auto rig</h2><div className="truncate text-2xs text-ink-3" title={model.name}>{model.name}</div></div>
      </div>
      <ol aria-label="Rigging stages" className="flex gap-1 px-3">
        {['Analyze', 'Fit guides', 'Review'].map((label, index) => (
          <li key={label} aria-current={index === active ? 'step' : undefined}
            className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 border-b-2 py-1.5 text-2xs ${index === active ? 'border-accent font-medium text-ink' : 'border-line text-ink-3'}`}>
            {index < active && <CheckIcon size={11} className="text-accent" />}{label}
          </li>
        ))}
      </ol>
    </header>
  );
};

const checkClass = 'flex min-h-6 items-center gap-2 text-2xs text-ink-2';
const inputClass = 'h-3.5 w-3.5 shrink-0 accent-blue-500';

export const AutoRigPanel: React.FC<{ model: LoadedModelData }> = ({ model }) => {
  const { readModelSource, readModelSourceImages, reimportModel, placeInScene, projectStatus } = useScene();
  const session = useRigSession();
  const mine = session.modelId === model.id;
  const latest = useRef(model);
  latest.current = model;
  const pendingRead = useRef(0);
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  useEffect(() => () => { pendingRead.current += 1; openingRef.current = false; }, [model.id, model.object]);

  const begin = async () => {
    if (openingRef.current || projectStatus.readOnly) return;
    const ticket = ++pendingRead.current;
    openingRef.current = true;
    setOpening(true);
    try {
      if (!model.isPlacedInScene) await placeInScene(model.id);
      if (ticket !== pendingRead.current) return;
      const [file, images] = await Promise.all([readModelSource(model.id), readModelSourceImages(model.id)]);
      if (ticket !== pendingRead.current || latest.current.object !== model.object) return;
      await startRig(model.id, model.object, file, { convert: convertOptionsFor(model.importSettings), images });
    } catch (error) {
      if (ticket === pendingRead.current) failRig(error, 'The model could not be read.', model.id);
    } finally {
      if (ticket === pendingRead.current) { openingRef.current = false; setOpening(false); }
    }
  };
  const cancel = () => {
    pendingRead.current += 1;
    openingRef.current = false;
    setOpening(false);
    cancelRig();
  };
  const apply = async () => {
    if (projectStatus.readOnly) return;
    const file = await finishRig(model.name, model.object);
    if (!file) return;
    try {
      const saved = await reimportModel(model.id, file, undefined, [], 'Character');
      completeRigSave(file, !!saved);
    } catch (error) {
      completeRigSave(file, false, error instanceof Error ? error.message : 'The rig could not be saved.');
    }
  };

  const stage: RigStage = mine && session.stage !== 'idle' ? session.stage : opening ? 'reading' : 'idle';
  const reading = mine ? session.reading : null;
  const clips = model.sourceClipNames?.length ?? 0;
  const busy = stage === 'reading' || stage === 'binding' || stage === 'saving';
  const stored = !projectStatus.readOnly;
  const progress = Math.round(100 * session.progress);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-panel text-xs text-ink-2" aria-label="Auto rig">
      <WorkflowHeader model={model} stage={stage} />
      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto">
        {stage === 'idle' && (
          <section className="space-y-3 p-4">
            <h3 className="text-sm font-medium text-ink">Fit a skeleton to this mesh</h3>
            <p className="leading-relaxed">Auvra locates the joints of a humanoid or four-legged animal. Adjust the guides, then test how the skin moves before applying the rig.</p>
            {stored ? <Button variant="primary" icon={<BoneIcon size={14} />} onClick={() => void begin()}>Analyze mesh</Button>
              : <p className="text-2xs text-warn">Open a writable project to rig this model.</p>}
          </section>
        )}
        {busy && (
          <section className="space-y-3 px-4 py-6" role="status" aria-live="polite">
            <div className="flex items-center gap-2 font-medium text-ink"><Spinner className="text-accent" />
              {stage === 'reading' ? 'Finding joint guides…' : stage === 'binding' ? 'Binding skin to bones…' : 'Applying rig to project…'}
              {stage === 'binding' && <span className="ml-auto font-mono text-2xs text-ink-3">{progress}%</span>}
            </div>
            {stage === 'binding' && <progress value={progress} max={100} aria-label="Binding progress" className="h-1 w-full accent-blue-500" />}
          </section>
        )}
        {stage === 'placing' && reading && <>
          <section className="space-y-2 border-b border-line px-3 py-3">
            <div className="flex items-center justify-between gap-2"><h3 className="font-medium text-ink">Body type</h3>
              <Button variant="ghost" size="sm" title="Read the mesh from the opposite direction and refit its guides" icon={<RotateIcon size={12} />} onClick={turnRigAround}>Flip facing</Button></div>
            <Segmented<BodyKind> label="Body type" value={reading.kind} options={BODIES} onChange={setRigBody} />
            {session.guessed && <p className="flex gap-1.5 text-2xs leading-relaxed text-warn"><WarningIcon size={13} className="mt-0.5 shrink-0" />Auvra used standard proportions. Check each guide against the mesh.</p>}
          </section>
          <RigGuideInspector session={session} reading={reading} />
          <section className="space-y-2 border-b border-line px-3 py-3">
            <div className="flex items-center gap-1.5"><SlidersIcon size={13} className="text-ink-3" /><h3 className="font-medium text-ink">Skin binding</h3></div>
            <div className="flex items-center justify-between gap-1"><span className="text-2xs" title="Maximum bones affecting a vertex">Max influences</span>
              <Segmented label="Maximum influences per vertex" value={String(session.binding.maxInfluences)} options={INFLUENCES} onChange={(value) => setRigBinding({ ...session.binding, maxInfluences: Number(value) as 1 | 2 | 4 })} /></div>
            <div className="flex items-center justify-between gap-1"><span className="text-2xs" title="How quickly influence decreases away from a bone">Falloff</span>
              <Segmented label="Weight falloff" value={session.binding.falloff} options={FALLOFF} onChange={(falloff) => setRigBinding({ ...session.binding, falloff })} /></div>
            {reading.kind === 'person' && <label className={checkClass}><input className={inputClass} type="checkbox" checked={session.withFingers} onChange={(event) => setRigWithFingers(event.target.checked)} />Include finger bones</label>}
            {reading.kind === 'fourLegs' && reading.markers.tailBase && <label className={checkClass}><input className={inputClass} type="checkbox" checked={session.withTail} onChange={(event) => setRigWithTail(event.target.checked)} />Include tail bones</label>}
          </section>
          <RigGuideProfiles modelName={model.name} edited={session.editedGuides.length > 0} />
        </>}
        {stage === 'review' && session.review && <RigReviewInspector session={session} model={model} />}
        {stage === 'review' && clips > 0 && <p className="mx-3 my-3 flex gap-1.5 text-2xs leading-relaxed text-warn"><WarningIcon size={14} className="shrink-0" />Applying replaces this model’s source and removes its {clips} embedded animation {clips === 1 ? 'clip' : 'clips'}.</p>}
        {mine && session.error && <p role="alert" className="px-3 py-2 text-xs text-bad">{session.error}</p>}
      </div>
      {stage !== 'idle' && stage !== 'saving' && (
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-line bg-panel px-3 py-2.5">
          <Button variant="ghost" size="sm" onClick={cancel}>Cancel</Button>
          {stage === 'placing' && <Button variant="primary" onClick={() => void previewRig(model.name, model.object)}>Bind &amp; preview <ArrowRightIcon size={13} /></Button>}
          {stage === 'review' && <div className="flex gap-1.5"><Button onClick={reviseRig}>Edit guides</Button><Button variant="primary" disabled={!stored} icon={<ModelFileIcon size={13} />} onClick={() => void apply()}>Apply rig</Button></div>}
        </footer>
      )}
    </div>
  );
};
