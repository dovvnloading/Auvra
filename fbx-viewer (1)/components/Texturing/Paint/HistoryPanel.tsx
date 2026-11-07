import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BranchIcon, BrushIcon, BucketIcon, ChevronDownIcon, ChevronRightIcon, CompareIcon, CrossIcon, DropletsIcon, EraserIcon, FlameIcon, HistoryIcon, ImageIcon, LayersIcon } from '../../UI/Icons';
import type { HistoryBranch, HistoryKind } from '../../../texturing/paint/history';
import type { HistoryEntry } from '../../../texturing/paint/strokes';
import { SliderRow } from './PaintFields';
import type { PaintSession } from './paintSession';

/**
 * THE PAINT HISTORY PANEL
 *
 * Every kept step of the set's history in order, newest at the bottom: strokes, fills, bakes and layer
 * changes. Clicking a step takes the set back (or forward) to just after it. Painting after going back
 * keeps the steps it replaces as a branch, shown under the step it comes off; any step of any branch can
 * be gone to, and the line left is kept as a branch in turn. Compare splits the view between a step and
 * the set as it is now, with a wipe.
 */

const KIND_ICONS: Record<HistoryKind, React.FC<{ size?: number; className?: string }>> = {
    paint: BrushIcon, erase: EraserIcon, fill: BucketIcon, bake: FlameIcon, decal: ImageIcon, particles: DropletsIcon, change: LayersIcon,
};

/** How long ago, in plain words. */
const ago = (at: number | null, now: number): string => {
    if (at === null) return '';
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds} s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    return `${Math.round(minutes / 60)} h ago`;
};

export const HistoryPanel: React.FC<{ session: PaintSession; stepLimit: number; memoryMb: number }> = ({ session, stepLimit, memoryMb }) => {
    const version = useSyncExternalStore(session.subscribe, session.getVersion);
    void version;
    const steps = session.steps;
    const branches = session.branchSteps;
    const current = useRef<HTMLDivElement>(null);
    const doneCount = steps.filter((step) => step.done).length;
    const [open, setOpen] = useState<ReadonlySet<HistoryBranch>>(new Set());
    useEffect(() => { current.current?.scrollIntoView({ block: 'nearest' }); }, [doneCount, steps.length]);
    const now = Date.now();
    const locked = !session.usable || Boolean(session.locked) || Boolean(session.busy);
    const comparing = session.comparison;

    const row = (key: string, entry: HistoryEntry | null, icon: React.ReactNode, label: string, detail: string, state: 'current' | 'done' | 'undone' | 'branch', depth: number, note?: string) => (
        <div key={key} ref={state === 'current' ? current : undefined} className={`group flex items-center rounded ${comparing?.entry === entry && comparing ? 'ring-1 ring-inset ring-amber-500/60' : ''}`} style={{ paddingLeft: depth * 12 }}>
            <button type="button" disabled={locked} onClick={() => session.goTo(entry)} title={note}
                className={`flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-2xs transition-colors duration-75 disabled:cursor-default ${
                    state === 'current' ? 'bg-sky-500/15 text-zinc-100' : state === 'done' ? 'text-zinc-300 hover:bg-zinc-800/70' : state === 'branch' ? 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200' : 'text-zinc-600 hover:bg-zinc-800/50 hover:text-zinc-400'}`}>
                <span className={`shrink-0 ${state === 'current' ? 'text-sky-400' : ''}`}>{icon}</span>
                <span className="min-w-0 flex-1 truncate">{label}{note && <span className="text-zinc-500"> (kept as it is)</span>}</span>
                <span className="shrink-0 text-zinc-500">{detail}</span>
            </button>
            {state !== 'current' && (
                <button type="button" disabled={locked} aria-label={`Compare ${label} with now`} title="Compare with now: the view splits, this step on the left"
                    onClick={() => void session.compareWith(entry)}
                    className="ml-0.5 shrink-0 rounded p-1 text-zinc-600 opacity-0 hover:bg-zinc-800 hover:text-zinc-200 focus:opacity-100 group-hover:opacity-100 disabled:opacity-0"><CompareIcon size={11} /></button>
            )}
        </div>
    );

    /** The branches coming off a step (null: the start), each folded to one line until opened, at `depth`. */
    const branchesOff = (from: HistoryEntry | null, depth: number): React.ReactNode[] => branches.filter((each) => each.from === from).flatMap((each, i) => {
        const shown = open.has(each.branch);
        const header = (
            <div key={`branch:${i}:${each.steps[0]?.entry.label}`} style={{ paddingLeft: depth * 12 + 4 }}>
                <button type="button" onClick={() => setOpen((before) => { const next = new Set(before); if (shown) next.delete(each.branch); else next.add(each.branch); return next; })}
                    className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-2xs text-amber-300/80 hover:bg-zinc-800/60">
                    {shown ? <ChevronDownIcon size={10} /> : <ChevronRightIcon size={10} />}
                    <BranchIcon size={11} />
                    <span className="min-w-0 flex-1 truncate">Branch: {each.steps.length} step{each.steps.length === 1 ? '' : 's'}, last {each.steps[each.steps.length - 1]?.label.toLowerCase()}</span>
                </button>
            </div>
        );
        if (!shown) return [header];
        return [header, ...each.steps.flatMap((step, k) => {
            const Icon = KIND_ICONS[step.kind];
            return [
                row(`branch:${i}:${k}`, step.entry, <Icon size={12} />, step.label, ago(step.at, now), 'branch', depth + 2, step.putsBack ? undefined : 'Let go of to keep memory.'),
                ...branchesOff(step.entry, depth + 3),
            ];
        })];
    });

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            {comparing && (
                <div className="space-y-1 border-b border-zinc-800 p-2">
                    <div className="flex items-center gap-2 text-2xs text-zinc-300">
                        <CompareIcon size={12} className="shrink-0 text-amber-400" />
                        <span className="min-w-0 flex-1 truncate">Comparing "{comparing.label}" (left) with now</span>
                        <button type="button" onClick={() => session.stopComparing()} aria-label="Stop comparing" className="rounded p-0.5 text-zinc-500 hover:text-zinc-200"><CrossIcon size={11} /></button>
                    </div>
                    <SliderRow label="Wipe" labelWidth="w-12" value={comparing.wipe} min={0} max={1} onChange={(wipe) => session.setCompareWipe(wipe)} />
                </div>
            )}
            <div className="min-h-0 flex-1 space-y-px overflow-y-auto p-2">
                {row('start', null, <HistoryIcon size={12} />, steps.length ? 'Before these steps' : 'As opened', '', doneCount === 0 ? 'current' : 'done', 0)}
                {branchesOff(null, 0)}
                {steps.flatMap((step, index) => {
                    const Icon = KIND_ICONS[step.kind];
                    const state = step.done ? (index === doneCount - 1 ? 'current' : 'done') : 'undone';
                    return [
                        row(`${index}`, step.entry, <Icon size={12} />, step.label, ago(step.at, now), state, 0, step.putsBack ? undefined : 'Let go of to keep memory: going back over this step leaves the set as it is.'),
                        ...branchesOff(step.entry, 0),
                    ];
                })}
            </div>
            <p className="border-t border-zinc-800 p-2 text-2xs leading-snug text-zinc-500">
                Click a step to go back to it. Painting after going back keeps the steps it replaces as a branch, under the step it comes off. The compare button beside a step splits the view with it. Up to {stepLimit} steps and {memoryMb} MB of painted pixels are kept, branches and then the oldest steps going first.
            </p>
        </div>
    );
};
