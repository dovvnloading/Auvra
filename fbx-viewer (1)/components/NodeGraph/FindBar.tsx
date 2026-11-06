import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CrossIcon, SearchIcon } from '../UI/Icons';
import { scoreEntry } from './finder';

/**
 * Find in graph (Ctrl+F): nodes by their title, own name or kind, and frames by their title. Enter
 * goes to the chosen match (again for the next), arrows choose, Escape closes.
 */

export interface FindTarget {
    id: string;
    kind: 'node' | 'frame';
    title: string;
    /** What it is (its kind of node), shown beside the title. */
    detail: string;
    /** Other words it is found by. */
    words: readonly string[];
}

const LIMIT = 12;

export const FindBar: React.FC<{
    targets: readonly FindTarget[];
    onGo: (target: FindTarget) => void;
    onClose: () => void;
}> = ({ targets, onGo, onClose }) => {
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const input = useRef<HTMLInputElement>(null);
    /** The match last gone to, so Enter again goes on to the next. */
    const went = useRef<number | null>(null);
    useEffect(() => { input.current?.focus(); }, []);

    const matches = useMemo(() => {
        const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (!words.length) return [];
        return targets
            .map((target) => ({ target, score: scoreEntry({ id: target.id, label: target.title, category: target.detail, keywords: target.words }, words) }))
            .filter((item) => item.score > 0)
            .sort((a, b) => b.score - a.score || a.target.title.localeCompare(b.target.title))
            .map((item) => item.target);
    }, [query, targets]);
    useEffect(() => { setActive(0); went.current = null; }, [query]);

    const go = (index: number) => {
        const target = matches[index];
        if (!target) return;
        went.current = index;
        setActive(index);
        onGo(target);
    };

    return (
        <div
            data-overlay
            className="absolute left-1/2 top-2 z-30 w-80 -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-panel shadow-[0_12px_32px_rgb(0_0_0/0.55)]"
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <div className="flex items-center gap-2 px-2.5 py-1.5">
                <SearchIcon size={13} className="shrink-0 text-ink-3" />
                <input
                    ref={input}
                    aria-label="Find in graph"
                    placeholder="Find a node or frame by name or kind…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === 'Escape') { event.preventDefault(); onClose(); }
                        else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.currentTarget.select(); }
                        else if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => Math.min(Math.min(matches.length, LIMIT) - 1, value + 1)); }
                        else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); }
                        else if (event.key === 'Enter' && matches.length) {
                            // The first Enter goes to the chosen match, each one after to the next (Shift: the one before).
                            event.preventDefault();
                            const count = Math.min(matches.length, LIMIT);
                            const from = went.current === active ? active : null;
                            go(from === null ? active : (from + (event.shiftKey ? count - 1 : 1)) % count);
                        }
                    }}
                    className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-3"
                />
                {query.trim() && <span className="shrink-0 text-2xs text-ink-3">{matches.length ? `${Math.min(active + 1, matches.length)} of ${matches.length}` : 'None'}</span>}
                <button type="button" aria-label="Close find" title="Close (Esc)" onClick={onClose} className="shrink-0 rounded p-0.5 text-ink-3 hover:bg-white/5 hover:text-ink"><CrossIcon size={12} /></button>
            </div>
            {matches.length > 0 && (
                <div role="listbox" aria-label="Matches" className="max-h-64 overflow-y-auto border-t border-line py-1">
                    {matches.slice(0, LIMIT).map((target, index) => (
                        <button
                            key={`${target.kind}:${target.id}`}
                            type="button"
                            role="option"
                            aria-selected={index === active}
                            onMouseEnter={() => setActive(index)}
                            onClick={() => go(index)}
                            className={`flex h-7 w-full items-center gap-2 px-2.5 text-left text-xs ${index === active ? 'bg-accent/15 text-ink' : 'text-ink-2 hover:bg-white/5'}`}
                        >
                            <span className="min-w-0 flex-1 truncate">{target.title}</span>
                            <span className="shrink-0 truncate text-2xs text-ink-3">{target.kind === 'frame' ? 'Frame' : target.detail}</span>
                        </button>
                    ))}
                    {matches.length > LIMIT && <p className="px-2.5 py-1 text-2xs text-ink-3">{matches.length - LIMIT} more: type more of the name</p>}
                </div>
            )}
        </div>
    );
};
