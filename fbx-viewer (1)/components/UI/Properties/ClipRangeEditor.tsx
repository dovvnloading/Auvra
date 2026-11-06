import React, { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CrossIcon, LoopIcon, PauseIcon, PlayIcon, PlusIcon, RangeEndIcon, RangeStartIcon, ScissorsIcon, SkipBackIcon, StepBackIcon, StepForwardIcon, TrashIcon } from '../Icons';
import type { ClipRange } from '../../../types';
import { frameOfTime, rangeRootShift, rootTravel, takeLabel, timeOfFrame, uniqueClipNames } from '../../../utils/clipRanges';
import type { ClipTake, ClipTakeSource } from '../../../utils/clipTakes';
import { Button, IconButton, Kbd, Segmented, Spinner, TextInput } from '../kit';
import { Select } from '../Select';
import { ClipRangePreview, type ClipPlayback } from './ClipRangePreview';

export interface ClipRangeResult {
  clipRanges: ClipRange[];
  excludedClips: string[];
}

interface ClipRangeEditorProps {
  /** The file or model being cut. */
  name: string;
  /** Reads the takes, and what to show them on. */
  load: (signal: AbortSignal) => Promise<ClipTakeSource>;
  ranges: readonly ClipRange[];
  /** Takes that do not come in as clips themselves. */
  excludedClips: readonly string[];
  /** Opens on this take, and on its clip of `initialClip`'s name if it has one. */
  initialTake?: string;
  initialClip?: string;
  confirmLabel: string;
  onConfirm: (result: ClipRangeResult) => void;
  onCancel: () => void;
}

type EditedRange = ClipRange & { key: number };
type TimeUnit = 'frames' | 'seconds';

const UNITS = [{ value: 'frames', label: 'Frames' }, { value: 'seconds', label: 'Seconds' }] as const;

const seconds = (time: number): string => (time < 10 ? time.toFixed(2) : time.toFixed(1));

/** Times as stored: more exact than any frame, without the noise of the sums that made them. */
const tidyTime = (time: number): number => Math.round(time * 1e6) / 1e6;

const timeText = (time: number, take: ClipTake, unit: TimeUnit): string =>
  (unit === 'frames' ? String(frameOfTime(time, take.start, take.framesPerSecond)) : time.toFixed(3));

/** A start or end, typed in the unit on show. It takes effect when the typing is over. */
const TimeField: React.FC<{ label: string; value: number; take: ClipTake; unit: TimeUnit; onCommit: (time: number) => void }> = ({ label, value, take, unit, onCommit }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const typed = Number(draft);
    setDraft(null);
    if (draft.trim() === '' || !Number.isFinite(typed)) return;
    onCommit(unit === 'frames' ? timeOfFrame(typed, take.start, take.framesPerSecond) : typed);
  };
  return (
    <TextInput
      type="number"
      aria-label={label}
      step={unit === 'frames' ? 1 : 0.001}
      value={draft ?? timeText(value, take, unit)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }}
      className="!w-full text-right tabular-nums"
    />
  );
};

/** Rows of bands, as clips can overlap: each goes in the first row with room for it. */
const laneOf = (ranges: readonly EditedRange[]): Map<number, number> => {
  const ends: number[] = [];
  const lanes = new Map<number, number>();
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    let lane = ends.findIndex((end) => end <= range.start + 1e-6);
    if (lane < 0) lane = ends.length;
    ends[lane] = range.end;
    lanes.set(range.key, lane);
  }
  return lanes;
};

const RULER_HEIGHT = 20;
const LANE_HEIGHT = 22;
const MIN_LANES = 2;
const LABEL_SPACING = 70;
const FRAME_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
const SECOND_STEPS = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200];

interface TimelineHandle {
  /** Moves the playhead, which is drawn straight to the page as it changes every frame. */
  setTime: (time: number, follow: boolean) => void;
}

type Drag =
  | { mode: 'scrub' }
  | { mode: 'start'; key: number }
  | { mode: 'end'; key: number }
  | { mode: 'move'; key: number; grab: number; length: number; moved: boolean; x: number }
  | { mode: 'mark'; from: number; x: number; moved: boolean };

/** The take from end to end: a ruler to scrub on, its clips as bands to select, move and trim, and room to mark a new one. */
const Timeline = React.forwardRef<TimelineHandle, {
  take: ClipTake;
  unit: TimeUnit;
  ranges: readonly EditedRange[];
  selected: number | null;
  onScrub: (time: number) => void;
  onSelect: (key: number | null) => void;
  onPlayRange: (key: number) => void;
  onChange: (key: number, start: number, end: number) => void;
  onMark: (start: number, end: number) => void;
}>(({ take, unit, ranges, selected, onScrub, onSelect, onPlayRange, onChange, onMark }, ref) => {
  const duration = take.clip.duration;
  const [view, setView] = useState({ from: 0, to: duration });
  const viewRef = useRef(view);
  viewRef.current = view;
  const span = view.to - view.from;
  const area = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const lastTime = useRef(0);
  const [width, setWidth] = useState(0);
  const [marking, setMarking] = useState<{ from: number; to: number } | null>(null);
  const drag = useRef<Drag | null>(null);
  const lanes = useMemo(() => laneOf(ranges), [ranges]);
  const laneCount = Math.max(MIN_LANES, ...[...lanes.values()].map((lane) => lane + 1));
  const frameLength = 1 / take.framesPerSecond;

  const percent = (time: number): number => ((time - view.from) / span) * 100;
  const timeAt = (clientX: number): number => {
    const rect = area.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return view.from;
    const { from, to } = viewRef.current;
    return from + ((clientX - rect.left) / rect.width) * (to - from);
  };
  const snap = useCallback((time: number): number => {
    const frame = frameOfTime(Math.max(0, Math.min(duration, time)), take.start, take.framesPerSecond);
    return Math.max(0, Math.min(duration, timeOfFrame(frame, take.start, take.framesPerSecond)));
  }, [duration, take.framesPerSecond, take.start]);

  const placePlayhead = useCallback(() => {
    const line = playhead.current;
    if (!line) return;
    const { from, to } = viewRef.current;
    const at = (lastTime.current - from) / (to - from);
    line.style.display = at < 0 || at > 1 ? 'none' : '';
    line.style.left = `${at * 100}%`;
  }, []);

  useImperativeHandle(ref, () => ({
    setTime: (time, follow) => {
      lastTime.current = time;
      if (follow) {
        const { from, to } = viewRef.current;
        if (time < from || time > to) {
          const length = to - from;
          const start = Math.max(0, Math.min(duration - length, time - length * 0.1));
          setView({ from: start, to: start + length });
        }
      }
      placePlayhead();
    },
  }), [duration, placePlayhead]);
  useLayoutEffect(placePlayhead, [placePlayhead, view]);

  useEffect(() => {
    const element = area.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    // Scrolling zooms about the pointer, and goes along the take with Shift held or sideways.
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const { from, to } = viewRef.current;
      const length = to - from;
      const sideways = event.shiftKey ? event.deltaY : event.deltaX;
      if (sideways) {
        const start = Math.max(0, Math.min(duration - length, from + (sideways / Math.max(1, element.clientWidth)) * length));
        setView({ from: start, to: start + length });
        return;
      }
      const next = Math.max(Math.min(duration, frameLength * 12), Math.min(duration, length * Math.exp(event.deltaY * 0.0015)));
      const rect = element.getBoundingClientRect();
      const share = (event.clientX - rect.left) / Math.max(1, rect.width);
      const start = Math.max(0, Math.min(duration - next, from + (length - next) * share));
      setView({ from: start, to: start + next });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => {
      observer.disconnect();
      element.removeEventListener('wheel', wheel);
    };
  }, [duration, frameLength]);

  const ticks = useMemo(() => {
    const room = Math.max(1, width) / LABEL_SPACING;
    if (unit === 'frames') {
      const step = FRAME_STEPS.find((candidate) => (span * take.framesPerSecond) / candidate <= room) ?? FRAME_STEPS[FRAME_STEPS.length - 1];
      const first = Math.ceil(((take.start + view.from) * take.framesPerSecond) / step) * step;
      const list: { time: number; label: string }[] = [];
      for (let frame = first; timeOfFrame(frame, take.start, take.framesPerSecond) <= view.to + 1e-6; frame += step) {
        list.push({ time: timeOfFrame(frame, take.start, take.framesPerSecond), label: String(frame) });
      }
      return list;
    }
    const step = SECOND_STEPS.find((candidate) => span / candidate <= room) ?? SECOND_STEPS[SECOND_STEPS.length - 1];
    const list: { time: number; label: string }[] = [];
    for (let at = Math.ceil(view.from / step) * step; at <= view.to + 1e-6; at += step) {
      list.push({ time: at, label: `${Number(at.toFixed(2))} s` });
    }
    return list;
  }, [span, take.framesPerSecond, take.start, unit, view.from, view.to, width]);

  const begin = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const target = event.target as HTMLElement;
    const band = target.closest<HTMLElement>('[data-range]');
    const time = timeAt(event.clientX);
    if (band) {
      const key = Number(band.dataset.range);
      const range = ranges.find((candidate) => candidate.key === key);
      if (!range) return;
      onSelect(key);
      const edge = target.dataset.edge as 'start' | 'end' | undefined;
      if (edge === 'start') {
        drag.current = { mode: 'start', key };
        onScrub(range.start);
      } else if (edge === 'end') {
        drag.current = { mode: 'end', key };
        onScrub(range.end);
      } else {
        drag.current = { mode: 'move', key, grab: time - range.start, length: range.end - range.start, moved: false, x: event.clientX };
      }
    } else if (target.closest('[data-ruler]')) {
      drag.current = { mode: 'scrub' };
      onScrub(snap(time));
    } else {
      drag.current = { mode: 'mark', from: snap(time), x: event.clientX, moved: false };
    }
  };

  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    const time = snap(timeAt(event.clientX));
    if (current.mode === 'scrub') {
      onScrub(time);
    } else if (current.mode === 'start' || current.mode === 'end') {
      const range = ranges.find((candidate) => candidate.key === current.key);
      if (!range) return;
      if (current.mode === 'start') {
        const start = Math.min(time, range.end - frameLength);
        onChange(current.key, Math.max(0, start), range.end);
        onScrub(Math.max(0, start));
      } else {
        const end = Math.max(time, range.start + frameLength);
        onChange(current.key, range.start, Math.min(duration, end));
        onScrub(Math.min(duration, end));
      }
    } else if (current.mode === 'move') {
      if (!current.moved && Math.abs(event.clientX - current.x) < 3) return;
      current.moved = true;
      const start = Math.max(0, Math.min(duration - current.length, snap(timeAt(event.clientX) - current.grab)));
      onChange(current.key, start, start + current.length);
      onScrub(start);
    } else {
      if (!current.moved && Math.abs(event.clientX - current.x) < 3) return;
      current.moved = true;
      setMarking({ from: Math.min(current.from, time), to: Math.max(current.from, time) });
    }
  };

  const end = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    drag.current = null;
    if (!current) return;
    if (current.mode === 'move' && !current.moved) {
      onPlayRange(current.key);
    } else if (current.mode === 'mark') {
      const time = snap(timeAt(event.clientX));
      setMarking(null);
      if (current.moved && Math.abs(time - current.from) >= frameLength) {
        onMark(Math.min(current.from, time), Math.max(current.from, time));
      } else {
        onSelect(null);
        onScrub(current.from);
      }
    }
  };

  return (
    <div
      ref={area}
      role="group"
      aria-label="Timeline of the take"
      className="relative shrink-0 cursor-default select-none overflow-hidden bg-well touch-none"
      style={{ height: RULER_HEIGHT + laneCount * LANE_HEIGHT + 4 }}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <div data-ruler className="absolute inset-x-0 top-0 cursor-ew-resize border-b border-line" style={{ height: RULER_HEIGHT }}>
        {ticks.map((tick) => (
          <span key={tick.time} className="pointer-events-none absolute top-0 flex h-full items-end pb-0.5 pl-1 text-2xs leading-none text-ink-3 tabular-nums" style={{ left: `${percent(tick.time)}%` }}>
            <span className="absolute inset-y-0 left-0 w-px bg-line" />
            {tick.label}
          </span>
        ))}
      </div>
      {ranges.map((range) => {
        const isSelected = range.key === selected;
        return (
          <div
            key={range.key}
            data-range={range.key}
            title={range.name}
            className={`absolute flex cursor-grab items-center overflow-hidden rounded-sm border text-2xs active:cursor-grabbing ${isSelected ? 'z-10 border-accent bg-accent/25 text-ink' : 'border-gray-700 bg-gray-800 text-ink-2 hover:bg-gray-750'}`}
            style={{
              left: `${percent(range.start)}%`,
              width: `${((range.end - range.start) / span) * 100}%`,
              top: RULER_HEIGHT + 2 + (lanes.get(range.key) ?? 0) * LANE_HEIGHT,
              height: LANE_HEIGHT - 3,
            }}
          >
            <span className="pointer-events-none min-w-0 truncate px-2">{takeLabel(range.name) || 'Unnamed'}</span>
            <span data-edge="start" aria-hidden className={`absolute inset-y-0 left-0 w-1.5 cursor-ew-resize ${isSelected ? 'bg-accent' : ''}`} />
            <span data-edge="end" aria-hidden className={`absolute inset-y-0 right-0 w-1.5 cursor-ew-resize ${isSelected ? 'bg-accent' : ''}`} />
          </div>
        );
      })}
      {marking && (
        <div
          className="pointer-events-none absolute rounded-sm border border-accent/70 bg-accent/15"
          style={{ left: `${percent(marking.from)}%`, width: `${((marking.to - marking.from) / span) * 100}%`, top: RULER_HEIGHT + 2, bottom: 2 }}
        />
      )}
      <div ref={playhead} data-playhead className="pointer-events-none absolute inset-y-0 z-20 w-px bg-white" />
    </div>
  );
});
Timeline.displayName = 'Timeline';

const Tick: React.FC<{ label: string; hint?: string; checked: boolean; onChange: (checked: boolean) => void }> = ({ label, hint, checked, onChange }) => (
  <label className="flex h-6 items-center gap-1.5 text-2xs text-ink-2" title={hint}>
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-3.5 w-3.5 shrink-0 accent-blue-500" />
    {label}
  </label>
);

/** Marks stretches of a take as clips of their own, with a name and whether they loop, played on the model as they are marked. */
export const ClipRangeEditor: React.FC<ClipRangeEditorProps> = ({ name, load, ranges: startRanges, excludedClips, initialTake, initialClip, confirmLabel, onConfirm, onCancel }) => {
  const nextKey = useRef(1);
  const newKey = () => { nextKey.current += 1; return nextKey.current; };
  const [source, setSource] = useState<ClipTakeSource | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [ranges, setRanges] = useState<EditedRange[]>(() => startRanges.map((range) => ({ ...range, key: newKey() })));
  const [keepWhole, setKeepWhole] = useState<ReadonlySet<string>>(() => new Set(startRanges.map((range) => range.take).filter((take) => !excludedClips.includes(take))));
  const [takeId, setTakeId] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [unit, setUnit] = useState<TimeUnit>('frames');
  const [playing, setPlaying] = useState(false);
  const [focusName, setFocusName] = useState(false);
  const playback = useRef<ClipPlayback>({ time: 0, playing: false, from: 0, to: 0, loop: true, shift: null });
  const timeline = useRef<TimelineHandle>(null);
  const readout = useRef<HTMLSpanElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  // Takes this file calls something else now: what was left out under the old name is left out under the new.
  const oldTakeNames = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    load(controller.signal).then((read) => {
      if (!current) { read.dispose(); return; }
      setSource(read);
      // A file with one take can have been saved with it under another name; its ranges go with it.
      const own = read.takes.filter((candidate) => !candidate.attached);
      if (own.length === 1) {
        const renamed = (range: ClipRange): boolean => !range.attached && !read.takes.some((candidate) => candidate.id === range.take);
        oldTakeNames.current = new Set(ranges.filter(renamed).map((range) => range.take));
        setRanges((list) => list.map((range) => (renamed(range) ? { ...range, take: own[0].id } : range)));
        setKeepWhole((kept) => new Set([...kept].map((id) => (ranges.some((range) => range.take === id && renamed(range)) ? own[0].id : id))));
      }
      const clip = ranges.find((range) => range.name === initialClip);
      const take = read.takes.find((candidate) => candidate.id === (clip?.take ?? initialTake))
        ?? read.takes.find((candidate) => candidate.clipName === initialClip)
        ?? read.takes.find((candidate) => ranges.some((range) => range.take === candidate.id))
        ?? read.takes[0];
      setTakeId(take?.id ?? null);
      if (clip) {
        setSelected(clip.key);
        playback.current.time = clip.start;
      }
      if (!read.takes.length) setFailure('This file has no animation to cut.');
    }).catch((error: unknown) => {
      if (current) setFailure(error instanceof Error && error.message ? error.message : 'The file could not be read.');
    });
    return () => {
      current = false;
      controller.abort();
    };
    // Read once for what the editor opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => (source ? () => source.dispose() : undefined), [source]);

  const take = source?.takes.find((candidate) => candidate.id === takeId) ?? null;
  const duration = take?.clip.duration ?? 0;
  const frameLength = take ? 1 / take.framesPerSecond : 1 / 30;
  const takeRanges = useMemo(() => ranges.filter((range) => range.take === takeId), [ranges, takeId]);
  const selectedRange = takeRanges.find((range) => range.key === selected) ?? null;

  /** What the preview plays is the clip that is selected, or the whole take with none. */
  useEffect(() => {
    if (!take) return;
    const play = playback.current;
    play.from = selectedRange ? selectedRange.start : 0;
    play.to = selectedRange ? Math.min(selectedRange.end, duration) : duration;
    play.loop = selectedRange ? selectedRange.loop : true;
    play.shift = selectedRange && source ? rangeRootShift(take.clip, selectedRange, source.object) : null;
  }, [duration, selectedRange, source, take]);

  const writeReadout = useCallback((time: number) => {
    if (!readout.current || !take) return;
    readout.current.textContent = unit === 'frames'
      ? `Frame ${frameOfTime(time, take.start, take.framesPerSecond)}`
      : `${seconds(time)} s`;
  }, [take, unit]);

  const onFrame = useCallback((time: number, nowPlaying: boolean) => {
    timeline.current?.setTime(time, nowPlaying);
    writeReadout(time);
    setPlaying((was) => (was === nowPlaying ? was : nowPlaying));
  }, [writeReadout]);

  const scrub = useCallback((time: number) => {
    playback.current.time = time;
    playback.current.playing = false;
    timeline.current?.setTime(time, false);
    writeReadout(time);
    setPlaying(false);
  }, [writeReadout]);

  const startPlaying = useCallback((from?: number) => {
    const play = playback.current;
    if (from !== undefined) play.time = from;
    else if (play.time < play.from || play.time >= play.to - 1e-4) play.time = play.from;
    play.playing = true;
    setPlaying(true);
  }, []);

  const togglePlay = useCallback(() => {
    if (playback.current.playing) {
      playback.current.playing = false;
      setPlaying(false);
    } else {
      startPlaying();
    }
  }, [startPlaying]);

  const stepFrame = useCallback((frames: number) => {
    if (!take) return;
    const frame = frameOfTime(playback.current.time, take.start, take.framesPerSecond) + frames;
    scrub(Math.max(0, Math.min(duration, timeOfFrame(frame, take.start, take.framesPerSecond))));
  }, [duration, scrub, take]);

  const patch = useCallback((key: number, change: Partial<ClipRange>) => {
    setRanges((list) => list.map((range) => (range.key === key ? { ...range, ...change } : range)));
  }, []);

  /** A range's ends, kept on the take and a frame apart at least. */
  const setEnds = useCallback((key: number, start: number, end: number) => {
    const from = Math.max(0, Math.min(duration - frameLength, start));
    patch(key, { start: tidyTime(from), end: tidyTime(Math.max(from + frameLength, Math.min(duration, end))) });
  }, [duration, frameLength, patch]);

  const namesInUse = useCallback((list: readonly EditedRange[], without?: string): Set<string> => {
    const names = new Set(list.map((range) => range.name));
    for (const candidate of source?.takes ?? []) {
      const kept = list.some((range) => range.take === candidate.id) ? keepWhole.has(candidate.id) : !excludedClips.includes(candidate.id);
      if (kept && candidate.id !== without) names.add(candidate.clipName);
    }
    return names;
  }, [excludedClips, keepWhole, source]);

  /** Adds a clip from `start` to `end` and selects it; the first on a take goes by the take's own clip name, so a trim changes no name. */
  const addRange = useCallback((start: number, end: number, from?: EditedRange) => {
    if (!take) return;
    const first = !ranges.some((range) => range.take === take.id);
    const free = namesInUse(ranges, first && !keepWhole.has(take.id) ? take.id : undefined);
    const [clipName] = uniqueClipNames([from?.name ?? take.clipName], free);
    const key = newKey();
    const added: EditedRange = {
      key, take: take.id, name: clipName, start: tidyTime(start), end: tidyTime(end), loop: from?.loop ?? true,
      ...(take.attached ? { attached: true } : {}),
      ...(from?.recentre !== undefined ? { recentre: from.recentre } : {}),
    };
    setRanges((list) => [...list, added]);
    setSelected(key);
    // A clip that was split off keeps the keyboard on the timeline, for the next split.
    setFocusName(!from);
    scrub(added.start);
  }, [keepWhole, namesInUse, ranges, scrub, take]);

  /** From the playhead if no clip covers it, else after the last clip; up to the next clip, or the take's end. */
  const addAtPlayhead = useCallback(() => {
    if (!take) return;
    const now = playback.current.time;
    const covered = takeRanges.some((range) => now >= range.start && now < range.end);
    let start = covered ? Math.max(...takeRanges.map((range) => range.end)) : now;
    if (start > duration - frameLength) start = Math.max(0, duration - Math.min(duration, 1));
    const next = takeRanges.filter((range) => range.start > start).map((range) => range.start);
    addRange(start, Math.min(duration, ...next), undefined);
  }, [addRange, duration, frameLength, take, takeRanges]);

  /** The clip under the playhead becomes two, on either side of it. */
  const splitAtPlayhead = useCallback(() => {
    const now = playback.current.time;
    const target = (selectedRange && now > selectedRange.start && now < selectedRange.end ? selectedRange : null)
      ?? takeRanges.find((range) => now > range.start && now < range.end);
    if (!target || now - target.start < frameLength || target.end - now < frameLength) return;
    patch(target.key, { end: tidyTime(now) });
    addRange(now, target.end, target);
  }, [addRange, frameLength, patch, selectedRange, takeRanges]);

  const remove = useCallback((key: number) => {
    setRanges((list) => list.filter((range) => range.key !== key));
    setSelected((was) => (was === key ? null : was));
  }, []);

  const select = useCallback((key: number | null) => setSelected(key), []);

  const playRange = useCallback((key: number) => {
    const range = ranges.find((candidate) => candidate.key === key);
    if (!range) return;
    setSelected(key);
    const play = playback.current;
    play.from = range.start;
    play.to = Math.min(range.end, duration);
    play.loop = range.loop;
    startPlaying(range.start);
  }, [duration, ranges, startPlaying]);

  const problem = useMemo(() => {
    if (ranges.some((range) => !range.name.trim())) return 'Every clip needs a name.';
    const seen = new Set<string>();
    for (const range of ranges) {
      const clipName = range.name.trim();
      if (seen.has(clipName)) return `Two clips are called "${clipName}". Graphs find clips by name, so they have to differ.`;
      seen.add(clipName);
    }
    for (const candidate of source?.takes ?? []) {
      const kept = ranges.some((range) => range.take === candidate.id) ? keepWhole.has(candidate.id) : !excludedClips.includes(candidate.id);
      if (kept && seen.has(candidate.clipName)) return `The whole take "${candidate.label}" comes in as a clip called "${candidate.clipName}" too. Rename the clip, or leave the whole take out.`;
    }
    return null;
  }, [excludedClips, keepWhole, ranges, source]);

  const confirm = () => {
    if (!source || problem) return;
    const left = new Set(excludedClips.filter((take) => !oldTakeNames.current.has(take)));
    for (const candidate of source.takes) {
      const has = ranges.some((range) => range.take === candidate.id);
      if (has && !keepWhole.has(candidate.id)) left.add(candidate.id);
      else if (has || startRanges.some((range) => range.take === candidate.id)) left.delete(candidate.id);
    }
    onConfirm({
      clipRanges: ranges.map(({ key: _key, ...range }) => ({ ...range, name: range.name.trim() })),
      excludedClips: [...left],
    });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        if (typing) target?.blur(); else onCancel();
        return;
      }
      // A list that is open takes its own keys.
      if (typing || target?.closest?.('[role="combobox"],[role="listbox"]')) return;
      // Nothing behind the dialog reacts to keys while it is open.
      event.stopPropagation();
      if (!take || event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === ' ' && target?.tagName === 'BUTTON') return;
      const act: Record<string, () => void> = {
        ' ': togglePlay,
        arrowleft: () => stepFrame(-1),
        arrowright: () => stepFrame(1),
        s: splitAtPlayhead,
      };
      if (selectedRange) {
        act['['] = () => setEnds(selectedRange.key, playback.current.time, selectedRange.end);
        act[']'] = () => setEnds(selectedRange.key, selectedRange.start, playback.current.time);
        act.delete = () => remove(selectedRange.key);
        act.backspace = act.delete;
      }
      if (!act[key]) return;
      // A key that did something here is not also typed into whatever takes the focus next.
      event.preventDefault();
      act[key]();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel, remove, selectedRange, setEnds, splitAtPlayhead, stepFrame, take, togglePlay]);

  useEffect(() => { dialog.current?.focus(); }, []);

  const wholeKept = !!take && keepWhole.has(take.id);
  const recentred = !!selectedRange && !!take && !!source && (selectedRange.recentre ?? (selectedRange.start > 0 && !!rootTravel(take.clip, selectedRange.start, source.object)?.far));

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Cut into clips"
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div ref={dialog} tabIndex={-1} className="flex h-[680px] max-h-full w-[1040px] max-w-full flex-col overflow-hidden rounded-lg border border-line bg-ground shadow-[0_8px_32px_rgb(0_0_0/0.6)] !outline-none">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-3 py-2">
          <div className="min-w-0">
            <h2 className="text-xs font-semibold text-ink">Cut into clips</h2>
            <p className="truncate text-2xs text-ink-3" title={name}>{name}</p>
          </div>
          <IconButton label="Cancel" onClick={onCancel}><CrossIcon size={14} /></IconButton>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="relative min-w-0 flex-1 bg-[#0a0a0a]">
            {source && take && <ClipRangePreview object={source.object} clip={take.clip} playback={playback} onFrame={onFrame} />}
            {!source && !failure && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-ink-3"><Spinner /> Reading the file…</div>
            )}
            {failure && <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-ink-3">{failure}</div>}
          </div>

          <div className="flex w-[300px] shrink-0 flex-col border-l border-line">
            {take && source && source.takes.length > 1 && (
              <div className="shrink-0 border-b border-line px-3 py-2">
                <Select
                  value={take.id}
                  onChange={(value: string) => { setTakeId(value); setSelected(null); scrub(0); }}
                  options={source.takes.map((candidate) => ({ value: candidate.id, label: `${candidate.label} (${seconds(candidate.clip.duration)} s)` }))}
                />
              </div>
            )}
            <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-line pl-3 pr-2">
              <h3 className="truncate text-2xs font-medium text-ink-3">
                {takeRanges.length ? `${takeRanges.length} ${takeRanges.length === 1 ? 'clip' : 'clips'} from this take` : 'Clips'}
              </h3>
              <Button size="sm" icon={<PlusIcon size={12} />} disabled={!take} onClick={addAtPlayhead}>Add clip</Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {take && !takeRanges.length && (
                <p className="px-3 py-3 text-2xs leading-4 text-ink-3">
                  Nothing is cut from this take yet. Drag along the timeline to mark a clip, or press Add clip to start from the whole take and trim its ends.
                </p>
              )}
              {take && [...takeRanges].sort((a, b) => a.start - b.start).map((range) => (range.key === selected ? (
                <div key={range.key} className="border-b border-line bg-white/[0.03] px-3 py-2">
                  <div className="flex items-center gap-1">
                    <TextInput
                      aria-label="Clip name"
                      maxLength={256}
                      value={range.name}
                      autoFocus={focusName}
                      onFocus={(event) => { if (focusName) { event.target.select(); setFocusName(false); } }}
                      onChange={(event) => patch(range.key, { name: event.target.value })}
                    />
                    <IconButton label="Remove this clip" onClick={() => remove(range.key)}><TrashIcon size={13} /></IconButton>
                  </div>
                  <div className="mt-1.5 grid grid-cols-[1fr_auto_1fr_auto] items-center gap-x-1 gap-y-1">
                    <span className="col-span-2 text-2xs text-ink-3">Start</span>
                    <span className="col-span-2 text-2xs text-ink-3">End</span>
                    <TimeField label="Start" value={range.start} take={take} unit={unit} onCommit={(time) => setEnds(range.key, time, range.end)} />
                    <IconButton label="Start at the playhead" shortcut="[" onClick={() => setEnds(range.key, playback.current.time, range.end)}><RangeStartIcon size={13} /></IconButton>
                    <TimeField label="End" value={range.end} take={take} unit={unit} onCommit={(time) => setEnds(range.key, range.start, time)} />
                    <IconButton label="End at the playhead" shortcut="]" onClick={() => setEnds(range.key, range.start, playback.current.time)}><RangeEndIcon size={13} /></IconButton>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <Tick label="Loops" checked={range.loop} onChange={(loop) => patch(range.key, { loop })} />
                    <Tick
                      label="Start at the origin"
                      hint="Moves the clip so the character starts where the take starts, not wherever it has walked to by then."
                      checked={recentred}
                      onChange={(recentre) => patch(range.key, { recentre })}
                    />
                  </div>
                  <p className="text-2xs text-ink-3 tabular-nums">
                    {seconds(range.end - range.start)} s, {Math.round((range.end - range.start) * take.framesPerSecond)} frames at {Number(take.framesPerSecond.toFixed(2))} per second
                  </p>
                </div>
              ) : (
                <button
                  key={range.key}
                  type="button"
                  onClick={() => playRange(range.key)}
                  className="flex h-7 w-full items-center gap-2 border-b border-line px-3 text-left text-xs text-ink-2 hover:bg-white/5"
                  title={range.loop ? 'Loops' : 'Plays once'}
                >
                  <span className="min-w-0 flex-1 truncate" title={range.name}>{takeLabel(range.name) || 'Unnamed'}</span>
                  {range.loop && <LoopIcon size={11} className="shrink-0 text-ink-3" aria-label="Loops" />}
                  <span className="shrink-0 text-2xs text-ink-3 tabular-nums">{timeText(range.start, take, unit)}–{timeText(range.end, take, unit)}</span>
                </button>
              )))}
            </div>
            {take && takeRanges.length > 0 && (
              <div className="shrink-0 border-t border-line px-3 py-1">
                <Tick
                  label={`Also keep the whole take as "${takeLabel(take.clipName)}"`}
                  checked={wholeKept}
                  onChange={(keep) => setKeepWhole((was) => {
                    const next = new Set(was);
                    if (keep) next.add(take.id); else next.delete(take.id);
                    return next;
                  })}
                />
              </div>
            )}
          </div>
        </div>

        <div className="flex h-9 shrink-0 items-center gap-1 border-t border-line px-2">
          <IconButton label={playing ? 'Pause' : 'Play'} shortcut="Space" disabled={!take} onClick={togglePlay}>{playing ? <PauseIcon size={13} /> : <PlayIcon size={13} />}</IconButton>
          <IconButton label="Back to where this starts" disabled={!take} onClick={() => scrub(playback.current.from)}><SkipBackIcon size={13} /></IconButton>
          <IconButton label="A frame back" shortcut="←" disabled={!take} onClick={() => stepFrame(-1)}><StepBackIcon size={13} /></IconButton>
          <IconButton label="A frame on" shortcut="→" disabled={!take} onClick={() => stepFrame(1)}><StepForwardIcon size={13} /></IconButton>
          <span ref={readout} className="ml-1 w-20 shrink-0 text-2xs text-ink-2 tabular-nums" />
          <Button size="sm" variant="ghost" icon={<ScissorsIcon size={12} />} disabled={!take || !takeRanges.length} onClick={splitAtPlayhead}>Split at playhead <Kbd className="ml-1">S</Kbd></Button>
          <span className="min-w-0 flex-1 truncate px-2 text-right text-2xs text-ink-3">Scroll over the timeline to zoom in. Shift and scroll goes along it.</span>
          <Segmented label="Show times in" value={unit} onChange={setUnit} options={UNITS} />
        </div>
        {take && (
          <Timeline
            key={take.id}
            ref={timeline}
            take={take}
            unit={unit}
            ranges={takeRanges}
            selected={selected}
            onScrub={scrub}
            onSelect={select}
            onPlayRange={playRange}
            onChange={setEnds}
            onMark={(start, end) => addRange(start, end)}
          />
        )}

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-3 py-2">
          {problem && <p role="alert" className="min-w-0 flex-1 truncate text-2xs text-amber-400" title={problem}>{problem}</p>}
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" disabled={!source || !take || !!problem} onClick={confirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default ClipRangeEditor;
