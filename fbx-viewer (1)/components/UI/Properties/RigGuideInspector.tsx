import React, { useState } from 'react';
import { guideLinksFor, guidePlanePosition, listRigGuides } from '../../../utils/autoRig/guideEditing';
import type { RigMarkerName, RigReading } from '../../../utils/autoRig/rigBody';
import {
  frameRigGuides, handleRigGuideKey, redoRigGuides, resetRigGuides, setActiveRigMarker, setRigBothSides,
  setRigGuidePosition, undoRigGuides, type RigSessionState,
} from '../../../utils/autoRig/rigSession';
import { Button, IconButton } from '../kit';
import { CrosshairIcon, MirrorIcon, RedoIcon, ResetIcon, UndoIcon } from '../Icons';

/** Commit exact coordinates on Enter or blur, so typing a number makes one undo step. */
const Coordinate: React.FC<{ label: string; value: number; onCommit: (value: number) => void }> = ({ label, value, onCommit }) => {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded border border-line bg-well px-2 focus-within:border-accent">
      <span className="text-2xs text-ink-3">{label}</span>
      <input type="number" step="any" aria-label={`Guide ${label.toLowerCase()}`} value={draft ?? Number(value.toPrecision(7))}
        className="h-7 w-full min-w-0 bg-transparent text-right font-mono text-2xs text-ink outline-none"
        onFocus={(event) => event.target.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => {
          const number = event.currentTarget.valueAsNumber;
          if (draft !== null && Number.isFinite(number) && number !== value) onCommit(number);
          setDraft(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === 'Escape') { event.stopPropagation(); setDraft(null); }
        }} />
    </label>
  );
};

/** Surface a collapsed limb in model space and let the artist select the joint in one click. */
const coincidentGuides = (reading: RigReading): [RigMarkerName, string][] => {
  const guides = listRigGuides(reading);
  const points = new Map(guides.map((guide) => [guide.name, guide]));
  const heights = guides.map((guide) => guide.point[1]);
  const tolerance = (Math.max(...heights) - Math.min(...heights)) * 0.001;
  return guideLinksFor(reading).flatMap(([from, to]) => {
    const first = points.get(from);
    const second = points.get(to);
    if (!first || !second) return [];
    const distance = Math.hypot(...first.point.map((value, index) => value - second.point[index]));
    return distance <= tolerance ? [[to, `${first.label} and ${second.label.toLowerCase()} overlap.`] as [RigMarkerName, string]] : [];
  });
};

export const RigGuideInspector: React.FC<{ session: RigSessionState; reading: RigReading }> = ({ session, reading }) => {
  const guides = listRigGuides(reading);
  const selected = session.activeMarker;
  const point = selected && guidePlanePosition(reading, selected);
  const issues = coincidentGuides(reading);
  return (
    <section className="space-y-2.5 border-b border-line px-3 py-3" onKeyDown={(event) => handleRigGuideKey(event.nativeEvent)}>
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-ink">Joint guides <span className="ml-1 font-mono text-2xs font-normal text-ink-3">{guides.length}</span></h3>
        <div className="flex items-center gap-0.5">
          <IconButton label="Frame guides" onClick={frameRigGuides}><CrosshairIcon size={13} /></IconButton>
          <IconButton label="Undo guide edit" shortcut="Ctrl Z" disabled={!session.canUndoGuides} onClick={undoRigGuides}><UndoIcon size={13} /></IconButton>
          <IconButton label="Redo guide edit" shortcut="Ctrl Shift Z" disabled={!session.canRedoGuides} onClick={redoRigGuides}><RedoIcon size={13} /></IconButton>
          <IconButton label="Reset all guides" disabled={!session.editedGuides.length} onClick={() => resetRigGuides()}><ResetIcon size={13} /></IconButton>
        </div>
      </div>
      <p className="text-2xs leading-relaxed text-ink-2">Drag a joint in the viewport, or select a guide to enter its position.</p>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="rig-guide" className="text-2xs text-ink-2">Selected guide</label>
        <Button size="sm" variant={session.bothSides ? 'default' : 'ghost'} icon={<MirrorIcon size={12} />} aria-pressed={session.bothSides}
          title="Reflect guide edits across the body's center line" onClick={() => setRigBothSides(!session.bothSides)}
          className={session.bothSides ? 'text-accent' : ''}>Mirror edits</Button>
      </div>
      <select id="rig-guide" className="rig-select" value={selected ?? ''} onChange={(event) => setActiveRigMarker(event.target.value as RigMarkerName)}>
        <option value="" disabled>Choose a guide…</option>
        {(['Center', 'Left', 'Right'] as const).map((side) => <optgroup key={side} label={side}>{guides.filter((guide) => guide.side === side).map((guide) =>
          <option key={guide.name} value={guide.name}>{guide.label}{session.editedGuides.includes(guide.name) ? ' · edited' : ''}</option>)}</optgroup>)}
      </select>
      {selected && point && (
        <div key={selected} className="space-y-1.5">
          <div className="flex gap-1.5">
            <Coordinate label="Across" value={point[0]} onCommit={(x) => setRigGuidePosition(selected, x, point[1])} />
            <Coordinate label="Height" value={point[1]} onCommit={(y) => setRigGuidePosition(selected, point[0], y)} />
          </div>
          <div className="flex items-center justify-between gap-1 text-2xs text-ink-3">
            <span>Arrows nudge · Shift for fine</span>
            <Button size="sm" variant="ghost" disabled={!session.editedGuides.includes(selected)} onClick={() => resetRigGuides(selected)}>Reset guide</Button>
          </div>
        </div>
      )}
      {issues.map(([name, message]) => <button key={message} type="button" onClick={() => setActiveRigMarker(name)} className="block text-left text-2xs text-warn underline">{message}</button>)}
    </section>
  );
};
