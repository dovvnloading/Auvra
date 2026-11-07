import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { BrushIcon, BucketIcon, DropletsIcon, EraserIcon, FlameIcon, HistoryIcon, ImageIcon, LayersIcon } from '../../UI/Icons';
import type { HistoryKind } from '../../../texturing/paint/history';
import type { PaintSession } from './paintSession';

/**
 * THE PAINT HISTORY PANEL
 *
 * Every kept step of the set's history in order, newest at the bottom: strokes, fills, bakes and layer
 * changes. Clicking a step takes the set back (or forward) to just after it; the steps after it stay,
 * greyed, until a new change replaces them.
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
    const current = useRef<HTMLButtonElement>(null);
    const doneCount = steps.filter((step) => step.done).length;
    useEffect(() => { current.current?.scrollIntoView({ block: 'nearest' }); }, [doneCount, steps.length]);
    const now = Date.now();
    const locked = !session.usable || Boolean(session.locked);

    const row = (key: string, icon: React.ReactNode, label: string, detail: string, state: 'current' | 'done' | 'undone', onClick: () => void, note?: string) => (
        <button key={key} ref={state === 'current' ? current : undefined} type="button" disabled={locked} onClick={onClick} title={note}
            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-2xs transition-colors duration-75 disabled:cursor-default ${
                state === 'current' ? 'bg-sky-500/15 text-zinc-100' : state === 'done' ? 'text-zinc-300 hover:bg-zinc-800/70' : 'text-zinc-600 hover:bg-zinc-800/50 hover:text-zinc-400'}`}>
            <span className={`shrink-0 ${state === 'current' ? 'text-sky-400' : ''}`}>{icon}</span>
            <span className="min-w-0 flex-1 truncate">{label}{note && <span className="text-zinc-500"> (kept as it is)</span>}</span>
            <span className="shrink-0 text-zinc-500">{detail}</span>
        </button>
    );

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-px overflow-y-auto p-2">
                {row('start', <HistoryIcon size={12} />, steps.length ? 'Before these steps' : 'As opened', '', doneCount === 0 ? 'current' : 'done', () => session.goTo(null))}
                {steps.map((step, index) => {
                    const Icon = KIND_ICONS[step.kind];
                    const state = step.done ? (index === doneCount - 1 ? 'current' : 'done') : 'undone';
                    return row(`${index}`, <Icon size={12} />, step.label, ago(step.at, now), state, () => session.goTo(step.entry),
                        step.putsBack ? undefined : 'Let go of to keep memory: going back over this step leaves the set as it is.');
                })}
            </div>
            <p className="border-t border-zinc-800 p-2 text-2xs leading-snug text-zinc-500">
                Click a step to go back to it; the steps after it stay until you change something. Up to {stepLimit} steps and {memoryMb} MB of painted pixels are kept, the oldest going first.
            </p>
        </div>
    );
};
