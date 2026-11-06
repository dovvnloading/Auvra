import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { PauseIcon, PlayIcon, RedoIcon, UndoIcon } from '../Icons';
import { useScene } from '../../../context/SceneContext';
import type { LoadedModelData } from '../../../types';
import { isEditableTarget } from '../../../utils/history';
import { skinPaintSession, useSkinPaintStatus } from '../../../utils/skinPaint/paintSession';
import { clipPlace, setSkeletonView, useSkeletonView, type SkinBrushMode } from '../../../utils/skeletonView';
import { Button, IconButton, Section, Segmented, type SegmentedOption } from '../kit';
import { Select } from '../Select';
import { ScrubbableInput } from './ScrubbableInput';

export interface ClipPlayback {
  activeClip: THREE.AnimationClip | null;
  isPlaying: boolean;
  onAnimationSelect: (clip: THREE.AnimationClip | null) => void;
  onPlayPause: () => void;
}

const BRUSHES: readonly SegmentedOption<SkinBrushMode>[] = [
  { value: 'off', label: 'Off', hint: 'Look without changing anything' },
  { value: 'add', label: 'Add', hint: 'The picked bone moves what the brush touches more' },
  { value: 'remove', label: 'Remove', hint: 'The picked bone moves what the brush touches less, and the other bones there take over' },
  { value: 'smooth', label: 'Smooth', hint: 'Evens out the weights of all the bones under the brush' },
];

const SMALLEST = 1;
const LARGEST = 100;
const POSE_AT_REST = '';

const NumberRow: React.FC<{ label: string; value: number; onChange: (value: number) => void; hint: string }> = ({ label, value, onChange, hint }) => (
  <div className="flex min-h-[26px] items-center justify-between gap-2" title={hint}>
    <span className="truncate text-xs text-ink-2">{label}</span>
    <div className="w-[104px] shrink-0">
      <ScrubbableInput label="%" value={value} step={1} labelWidth="w-7" onChange={(next) => { if (Number.isFinite(next)) onChange(Math.min(LARGEST, Math.max(SMALLEST, Math.round(next)))); }} />
    </div>
  </div>
);

/** Goes along with the clip in the view; dragging it stops the clip at that moment. */
const ClipSlider: React.FC<{ clip: THREE.AnimationClip; isPlaying: boolean; onPause: () => void }> = ({ clip, isPlaying, onPause }) => {
  const slider = useRef<HTMLInputElement>(null);
  const readout = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let frame = 0;
    const follow = (): void => {
      const time = clipPlace.wanted ?? clipPlace.time;
      if (slider.current) slider.current.value = String(time);
      if (readout.current) readout.current.textContent = `${time.toFixed(2)} s`;
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div className="flex h-6 items-center gap-2">
      <input
        ref={slider}
        type="range"
        aria-label="Moment in the clip"
        min={0}
        max={clip.duration}
        step={0.01}
        defaultValue={0}
        onChange={(event) => {
          if (isPlaying) onPause();
          clipPlace.wanted = Number(event.target.value);
        }}
        className="min-w-0 flex-1 accent-[var(--accent,#e8842c)]"
      />
      <span ref={readout} className="w-10 shrink-0 text-right text-2xs tabular-nums text-ink-3" />
    </div>
  );
};

/** The brush for correcting a model's weights by hand, shown while a bone is picked and its weights are on view. */
export const SkinPaintSection: React.FC<{ model: LoadedModelData; playback: ClipPlayback }> = ({ model, playback }) => {
  const { saveModelSkinPaint } = useScene();
  const view = useSkeletonView();
  const session = useMemo(() => skinPaintSession(model.object), [model.object]);
  const status = useSkinPaintStatus(session);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    session.setSaver((encode) => saveModelSkinPaint(model.id, encode));
  }, [model.id, saveModelSkinPaint, session]);

  // Gone from view, the brush stops: nothing should paint with no sign of it on screen.
  useEffect(() => () => setSkeletonView({ brush: 'off' }), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target)) return;
      if (event.ctrlKey || event.metaKey) {
        const key = event.key.toLowerCase();
        if (key === 'z') {
          event.preventDefault();
          if (event.shiftKey) session.redo(); else session.undo();
        } else if (key === 'y') {
          event.preventDefault();
          session.redo();
        }
        return;
      }
      const { brush, brushSize, brushStrength } = viewRef.current;
      if (brush === 'off') return;
      const bounded = (value: number): number => Math.min(LARGEST, Math.max(SMALLEST, Math.round(value)));
      if (event.key === '[') setSkeletonView({ brushSize: bounded(Math.min(brushSize - 1, brushSize / 1.2)) });
      else if (event.key === ']') setSkeletonView({ brushSize: bounded(Math.max(brushSize + 1, brushSize * 1.2)) });
      else if (event.key === ',') setSkeletonView({ brushStrength: bounded(brushStrength - 5) });
      else if (event.key === '.') setSkeletonView({ brushStrength: bounded(brushStrength + 5) });
      else if (event.key === 'Escape') setSkeletonView({ brush: 'off' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session]);

  const { activeClip, isPlaying, onAnimationSelect, onPlayPause } = playback;
  const clipOptions = useMemo(() => [
    { label: 'At rest', value: POSE_AT_REST },
    ...model.animations.map((clip) => ({ label: clip.name, value: clip.name })),
  ], [model.animations]);

  if (session.isEmpty) return null;

  return (
    <Section
      title="Paint weights"
      className="shrink-0 border-t border-line"
      actions={(
        <div className="flex items-center gap-0.5">
          <IconButton label="Undo stroke" shortcut="Ctrl+Z" disabled={!status.canUndo} onClick={() => session.undo()}><UndoIcon size={12} /></IconButton>
          <IconButton label="Redo stroke" shortcut="Ctrl+Y" disabled={!status.canRedo} onClick={() => session.redo()}><RedoIcon size={12} /></IconButton>
        </div>
      )}
    >
      <div className="space-y-1">
        <Segmented label="Brush" value={view.brush} options={BRUSHES} onChange={(brush) => setSkeletonView({ brush })} className="flex w-full [&>button]:flex-1" />
        <NumberRow label="Size" value={view.brushSize} onChange={(brushSize) => setSkeletonView({ brushSize })} hint="Across the brush, as a share of the model's longest side. Keys: [ and ]" />
        <NumberRow label="Strength" value={view.brushStrength} onChange={(brushStrength) => setSkeletonView({ brushStrength })} hint="How far one touch moves a vertex. Keys: , and ." />
        {model.animations.length > 0 && (
          <div className="flex items-center gap-2" title="Try the weights in a clip. Drag along it to where it looks wrong, and paint there.">
            <span className="shrink-0 text-xs text-ink-2">Pose</span>
            <Select
              value={activeClip && model.animations.includes(activeClip) ? activeClip.name : POSE_AT_REST}
              options={clipOptions}
              onChange={(name: string) => onAnimationSelect(model.animations.find((clip) => clip.name === name) ?? null)}
              className="min-w-0 flex-1"
            />
            <IconButton label={isPlaying ? 'Pause' : 'Play'} disabled={!activeClip} onClick={onPlayPause}>
              {isPlaying ? <PauseIcon size={12} /> : <PlayIcon size={12} />}
            </IconButton>
          </div>
        )}
        {activeClip && model.animations.includes(activeClip) && <ClipSlider clip={activeClip} isPlaying={isPlaying} onPause={onPlayPause} />}
        {view.brush !== 'off' && (
          <p className="pt-0.5 text-2xs text-ink-3">Drag on the model. Shift does the opposite, Alt-drag turns the view, Ctrl-click picks the bone moving that spot most.</p>
        )}
        {status.saveFailed && <p className="text-2xs text-amber-400">The last change could not be saved. It will be saved with the next, or use Try again.</p>}
        {(status.painted > 0 || status.saveFailed) && (
          <div className="flex items-center justify-between gap-2 pt-0.5">
            <span className="min-w-0 truncate text-2xs tabular-nums text-ink-3">{status.painted.toLocaleString()} vertices painted</span>
            {status.saveFailed
              ? <Button size="sm" onClick={() => session.requestSave()}>Try again</Button>
              : <Button size="sm" variant="ghost" title="Back to the weights the model came with. Undo brings the paint back." onClick={() => session.putBack()}>Put back original</Button>}
          </div>
        )}
      </div>
    </Section>
  );
};
