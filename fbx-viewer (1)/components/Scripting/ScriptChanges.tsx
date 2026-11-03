import React, { useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '../UI/kit';
import { applyKeptChanges, changesIn, diffScript, type ChangeBlock } from './scriptDiff';

/** Unchanged lines shown around each change; the rest fold away. */
const CONTEXT_LINES = 3;

const CodeLine: React.FC<{ before?: number; after?: number; mark?: '+' | '-'; dimmed?: boolean; struck?: boolean; children: string }> = ({ before, after, mark, dimmed, struck, children }) => (
  <div className={`flex min-w-max ${mark === '+' ? 'bg-ok/10' : mark === '-' ? 'bg-bad/10' : ''} ${dimmed ? 'opacity-45' : ''}`}>
    <span aria-hidden className="w-10 shrink-0 select-none pr-2 text-right text-ink-3">{before ?? ''}</span>
    <span aria-hidden className="w-10 shrink-0 select-none pr-2 text-right text-ink-3">{after ?? ''}</span>
    <span aria-hidden className={`w-4 shrink-0 select-none ${mark === '+' ? 'text-ok' : mark === '-' ? 'text-bad' : ''}`}>{mark ?? ''}</span>
    <span className={`whitespace-pre pr-4 ${struck ? 'line-through' : ''} ${mark ? 'text-ink' : 'text-ink-2'}`}>{children || ' '}</span>
  </div>
);

const Change: React.FC<{ change: ChangeBlock; number: number; kept: boolean; onToggle: () => void }> = ({ change, number, kept, onToggle }) => (
  <div role="group" aria-label={`Change ${number}`} className="border-y border-line/60">
    <div className="sticky left-0 flex h-6 items-center gap-2 bg-panel px-2 font-sans text-2xs text-ink-2">
      <button
        type="button"
        role="checkbox"
        aria-checked={kept}
        aria-label={`Keep change ${number}`}
        onClick={onToggle}
        className={`flex h-3.5 w-3.5 items-center justify-center rounded-sm border transition-colors duration-75 ${kept ? 'border-accent bg-accent text-accent-ink' : 'border-gray-600 hover:border-ink-3'}`}
      >
        {kept && <Check size={10} strokeWidth={3} />}
      </button>
      Change {number}
      {!kept && <span className="text-ink-3">left as it is</span>}
    </div>
    {change.removed.map((line, index) => (
      <CodeLine key={`-${index}`} before={change.beforeLine + index} mark="-" dimmed={!kept && false} struck={kept}>{line}</CodeLine>
    ))}
    {change.added.map((line, index) => (
      <CodeLine key={`+${index}`} after={change.afterLine + index} mark="+" dimmed={!kept}>{line}</CodeLine>
    ))}
  </div>
);

/**
 * What the model proposes, shown in place of the code: every change can be kept or left out, and nothing reaches the script
 * until Apply, which goes through the editor so that undo takes it back.
 */
export const ScriptChanges: React.FC<{ before: string; after: string; onApply: (text: string) => void; onDiscard: () => void }> = ({ before, after, onApply, onDiscard }) => {
  const blocks = useMemo(() => diffScript(before, after), [before, after]);
  const changes = useMemo(() => changesIn(blocks), [blocks]);
  const [kept, setKept] = useState<ReadonlySet<number>>(() => new Set(changes.map((change) => change.id)));

  const toggle = (id: number) => setKept((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <div role="region" aria-label="Proposed changes" className="absolute inset-0 z-10 flex flex-col bg-well">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <h3 className="text-xs font-medium text-ink">
          {changes.length === 0 ? 'The answer is the same as the script' : `${changes.length} ${changes.length === 1 ? 'change' : 'changes'} proposed`}
        </h3>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onDiscard}>{changes.length ? 'Discard' : 'Close'}</Button>
        {changes.length > 0 && (
          <Button variant="primary" size="sm" disabled={kept.size === 0} onClick={() => onApply(applyKeptChanges(blocks, kept))}>
            {kept.size === changes.length ? 'Apply' : `Apply ${kept.size} of ${changes.length}`}
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1 font-mono text-[12px] leading-5">
        {blocks.map((block, blockIndex) => {
          if (block.kind === 'change') return <Change key={`change-${block.id}`} change={block} number={block.id + 1} kept={kept.has(block.id)} onToggle={() => toggle(block.id)} />;
          const first = blockIndex === 0;
          const last = blockIndex === blocks.length - 1;
          const headCount = first ? 0 : CONTEXT_LINES;
          const tailCount = last ? 0 : CONTEXT_LINES;
          const folded = block.lines.length - headCount - tailCount;
          if (folded <= 0) {
            return block.lines.map((line, index) => <CodeLine key={`${blockIndex}-${index}`} before={block.beforeLine + index} after={block.afterLine + index}>{line}</CodeLine>);
          }
          const tailStart = block.lines.length - tailCount;
          return (
            <React.Fragment key={blockIndex}>
              {block.lines.slice(0, headCount).map((line, index) => <CodeLine key={index} before={block.beforeLine + index} after={block.afterLine + index}>{line}</CodeLine>)}
              <div className="py-0.5 pl-24 font-sans text-2xs text-ink-3">{folded} unchanged {folded === 1 ? 'line' : 'lines'}</div>
              {block.lines.slice(tailStart).map((line, index) => <CodeLine key={`t${index}`} before={block.beforeLine + tailStart + index} after={block.afterLine + tailStart + index}>{line}</CodeLine>)}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};
