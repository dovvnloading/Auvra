import React, { useEffect, useRef } from 'react';
import { Bone, Loader2 } from 'lucide-react';
import { useScene } from '../../../context/SceneContext';
import type { LoadedModelData } from '../../../types';
import type { BodyKind } from '../../../utils/autoRig/rigBody';
import { cancelRig, failRig, finishRig, rigNotSaved, setRigBody, setRigBothSides, setRigWithFingers, setRigWithTail, startRig, turnRigAround, useRigSession } from '../../../utils/autoRig/rigSession';
import { convertOptionsFor } from '../../../utils/processing/ModelTransforms';
import { Button, Segmented } from '../kit';

const BODIES = [
  { value: 'person', label: 'Person', hint: 'Stands on two feet, upright or hunched' },
  { value: 'fourLegs', label: 'Four legs', hint: 'An animal standing on four legs' },
] as const satisfies readonly { value: BodyKind; label: string; hint: string }[];

/** Gives a mesh without bones a skeleton: from reading its body, through placing the markers, to the rigged model. */
export const AutoRigPanel: React.FC<{ model: LoadedModelData }> = ({ model }) => {
  const { readModelSource, readModelSourceImages, reimportModel, placeInScene, projectStatus } = useScene();
  const session = useRigSession();
  const mine = session.modelId === model.id;

  // A session belongs to the model it was started on. It outlives this tab: the markers stay in the view.
  useEffect(() => {
    if (session.modelId && !mine) cancelRig();
  }, [mine, session.modelId]);

  // Placing the model in the scene can take a while, and hand it on changed.
  const latest = useRef(model);
  latest.current = model;

  const begin = async () => {
    if (!model.isPlacedInScene) await placeInScene(model.id);
    const [file, images] = await Promise.all([readModelSource(model.id), readModelSourceImages(model.id)]);
    await startRig(model.id, latest.current.object, file, { convert: convertOptionsFor(model.importSettings), images });
  };
  const finish = async () => {
    const file = await finishRig(model.name, model.object);
    if (!file) return;
    if (await reimportModel(model.id, file, undefined, [], 'Character')) cancelRig();
    else rigNotSaved();
  };

  const stage = mine ? session.stage : 'idle';

  if (stage === 'placing' && session.reading) {
    const { kind } = session.reading;
    const hasTail = kind === 'fourLegs' && !!session.reading.markers.tailBase;
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3 text-xs text-ink-2">
        <div className="min-w-0 truncate font-medium text-ink" title={model.name}>{model.name}</div>
        <div className="flex items-center justify-between gap-2">
          <Segmented label="Kind of body" value={kind} options={BODIES} onChange={setRigBody} />
          <Button size="sm" title={kind === 'fourLegs' ? 'For a head and tail read the wrong way round' : 'For a front and back read the wrong way round'} onClick={turnRigAround}>Turn around</Button>
        </div>
        <p>Drag the markers onto the joints. Only their place in this view counts: each is kept in the middle of the limb it is on.</p>
        {session.guessed && (
          <p className="text-amber-400">{kind === 'fourLegs' ? 'This does not read clearly as an animal on four legs' : 'This does not read clearly as a person'}, so the markers are only a start.</p>
        )}
        {!!model.sourceClipNames?.length && (
          <p className="text-amber-400">The clips in this model's file will go, as they move parts of the mesh that bones will move instead.</p>
        )}
        <label className="flex h-6 cursor-pointer items-center gap-2">
          <input type="checkbox" checked={session.bothSides} onChange={(event) => setRigBothSides(event.target.checked)} className="h-3.5 w-3.5 shrink-0 accent-blue-500" />
          Move both sides together
        </label>
        {kind === 'person' && (
          <label className="flex h-6 cursor-pointer items-center gap-2">
            <input type="checkbox" checked={session.withFingers} onChange={(event) => setRigWithFingers(event.target.checked)} className="h-3.5 w-3.5 shrink-0 accent-blue-500" />
            Give the hands fingers
          </label>
        )}
        {hasTail && (
          <label className="flex h-6 cursor-pointer items-center gap-2">
            <input type="checkbox" checked={session.withTail} onChange={(event) => setRigWithTail(event.target.checked)} className="h-3.5 w-3.5 shrink-0 accent-blue-500" />
            Give the tail bones
          </label>
        )}
        {session.error && <p className="text-red-400">{session.error}</p>}
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={() => { void finish(); }}>Make the skeleton</Button>
          <Button onClick={cancelRig}>Cancel</Button>
        </div>
      </div>
    );
  }

  if (stage === 'saving') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-xs text-ink-3">
        <Loader2 size={16} className="animate-spin" />
        <span>Saving the model with its skeleton</span>
      </div>
    );
  }

  if (stage === 'reading' || stage === 'binding') {
    const progress = stage === 'binding' ? session.progress : null;
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-xs text-ink-3">
        <Loader2 size={16} className="animate-spin" />
        <span>{stage === 'reading' ? 'Reading the body' : 'Working out what each bone moves'}</span>
        {progress !== null && (
          <div className="h-1 w-40 overflow-hidden rounded-sm bg-white/10">
            <div className="h-full bg-accent" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
        <Button size="sm" onClick={cancelRig}>Cancel</Button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-xs text-ink-3">
      <p className="w-full [overflow-wrap:anywhere]">{model.name} has no skeleton.</p>
      {!projectStatus.readOnly && (
        <>
          <Button variant="primary" icon={<Bone size={12} />} onClick={() => { void begin().catch((error: unknown) => failRig(error, 'The model could not be read.', model.id)); }}>Make a skeleton</Button>
          <p className="text-2xs">For a person, upright or hunched, or an animal on four legs. Clips from other rigs can then play on them.</p>
        </>
      )}
      {mine && session.error && <p className="text-red-400">{session.error}</p>}
    </div>
  );
};
