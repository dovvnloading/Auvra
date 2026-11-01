import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Image as ImageIcon } from 'lucide-react';
import { Spinner, Tooltip } from '../../UI/kit';
import { startingLookName, type SessionPart, type Take } from './retextureSession';

const seconds = (take: Take, now: number) => `${Math.max(0, Math.round(((take.finishedAt ?? now) - take.startedAt) / 1000))} s`;

/** Keeps a clock going while anything is being painted. */
const useNow = (running: boolean) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
};

export const STATE_WORDS: Record<Take['state'], string> = {
  starting: 'Sending',
  queued: 'In queue',
  painting: 'Painting',
  ready: 'Ready',
  failed: 'Failed',
};

const Tile: React.FC<{ selected: boolean; saved: boolean; label: string; tip: React.ReactNode; onClick: () => void; children: React.ReactNode }> = ({ selected, saved, label, tip, onClick, children }) => (
  <Tooltip text={tip}>
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      onClick={onClick}
      className={`relative h-14 w-14 shrink-0 overflow-hidden rounded-sm bg-well outline outline-1 -outline-offset-1 transition-[outline-color] duration-75 ${selected ? 'outline-2 outline-accent' : 'outline-line hover:outline-gray-600'}`}
    >
      {children}
      {saved && (
        <span title="On the model" className="absolute right-0.5 top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-accent text-accent-ink">
          <Check size={9} strokeWidth={3} />
        </span>
      )}
    </button>
  </Tooltip>
);

/** Every result for a part, with the original first. The one chosen is on the model. */
export const TakesStrip: React.FC<{
  part: SessionPart;
  focusedId: string | null;
  onFocus: (take: Take | null) => void;
  actions: React.ReactNode;
}> = ({ part, focusedId, onFocus, actions }) => {
  const running = part.takes.some((take) => take.state !== 'ready' && take.state !== 'failed');
  const now = useNow(running);
  const scroller = useRef<HTMLDivElement>(null);
  const count = part.takes.length;
  useEffect(() => {
    if (count) scroller.current?.scrollTo({ left: scroller.current.scrollWidth, behavior: 'smooth' });
  }, [count]);

  return (
    <div className="flex h-[72px] shrink-0 items-center gap-3 bg-panel px-2">
      <div ref={scroller} role="group" aria-label="Results" className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-1 pl-0.5">
        <Tile selected={focusedId === null} saved={part.saved === null} label={startingLookName(part)} tip={startingLookName(part) === 'Original' ? 'The original' : 'What this part wore when the project opened'} onClick={() => onFocus(null)}>
          {part.thumbnail
            ? <img src={part.thumbnail} alt="" draggable={false} className="h-full w-full object-cover" />
            : <span className="flex h-full w-full items-center justify-center text-ink-3"><ImageIcon size={14} /></span>}
          <span className="absolute inset-x-0 bottom-0 bg-ground/75 py-px text-center text-2xs leading-3 text-ink-2">{startingLookName(part)}</span>
        </Tile>
        {count > 0 && <span className="mx-0.5 h-8 w-px shrink-0 bg-line" />}
        {part.takes.map((take) => (
          <Tile
            key={take.id}
            selected={focusedId === take.id}
            saved={part.saved === take.id}
            label={`Result ${take.number}, ${STATE_WORDS[take.state].toLowerCase()}`}
            tip={take.error ?? take.prompt}
            onClick={() => onFocus(take)}
          >
            {take.state === 'ready' && take.url && <img src={take.url} alt="" draggable={false} className="h-full w-full object-cover" />}
            {take.state === 'failed' && <span className="flex h-full w-full items-center justify-center text-bad"><AlertTriangle size={15} /></span>}
            {take.state !== 'ready' && take.state !== 'failed' && (
              <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-ink-2">
                <Spinner className="text-accent" />
                <span className="text-2xs leading-3 tabular-nums">{seconds(take, now)}</span>
              </span>
            )}
            <span className="absolute bottom-0 left-0 rounded-tr-sm bg-ground/75 px-1 text-2xs leading-3 tabular-nums text-ink-2">{take.number}</span>
          </Tile>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
    </div>
  );
};
