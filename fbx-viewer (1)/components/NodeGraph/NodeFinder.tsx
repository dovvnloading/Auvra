import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { SearchIcon, StarIcon } from '../UI/Icons';
import { entrySection, loadFinderMemory, pushRecent, rankEntries, saveFinderMemory, toggleFavourite, type FinderEntry, type FinderMemory } from './finder';
import type { Point } from './model';

/**
 * The node finder: type to find a node (loosely, by name, the words it is known by, its category or
 * what it does), with a picture of what each node makes, favourites and recent nodes first. Fully
 * usable from the keyboard: arrows (and Page Up/Down, Home/End) choose, Enter adds, Ctrl+D marks a
 * favourite, Escape closes. It opens at the pointer but always wholly inside the canvas.
 */

const WIDTH = 304;
const MAX_HEIGHT = 440;
const MARGIN = 8;

export const NodeFinder: React.FC<{
    /** Where it opens, in the canvas's own pixels. */
    at: Point;
    bounds: { width: number; height: number };
    entries: readonly FinderEntry[];
    /** Which graph's favourites and recent nodes to keep. */
    memoryKey: string;
    /** What a new node will be wired to, said above the search box. */
    context?: string;
    /** Entries that suit what the node is for (a dragged wire, a wire to splice into). */
    filter?: (entry: FinderEntry) => boolean;
    renderPicture?: (entry: FinderEntry, size: number) => React.ReactNode;
    onChoose: (entry: FinderEntry) => void;
    onClose: () => void;
}> = ({ at, bounds, entries, memoryKey, context, filter, renderPicture, onChoose, onClose }) => {
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const [memory, setMemory] = useState<FinderMemory>(() => loadFinderMemory(memoryKey));
    const input = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLDivElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    const [height, setHeight] = useState(MAX_HEIGHT);

    useEffect(() => { input.current?.focus(); }, []);
    useLayoutEffect(() => {
        const element = panel.current;
        if (!element) return undefined;
        const measure = () => setHeight(element.offsetHeight);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const shown = useMemo(() => rankEntries(filter ? entries.filter(filter) : entries, query, memory), [entries, filter, memory, query]);
    useEffect(() => { setActive(0); }, [query]);
    useEffect(() => { list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);

    const remember = (next: FinderMemory) => {
        setMemory(next);
        saveFinderMemory(memoryKey, next);
    };
    const choose = (entry: FinderEntry) => {
        remember({ ...memory, recent: pushRecent(memory.recent, entry.id) });
        onChoose(entry);
    };
    const toggle = (entry: FinderEntry) => remember({ ...memory, favourites: toggleFavourite(memory.favourites, entry.id) });

    const onKeyDown = (event: React.KeyboardEvent) => {
        event.stopPropagation();
        const last = shown.length - 1;
        if (event.key === 'Escape') { event.preventDefault(); onClose(); }
        else if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => Math.min(last, value + 1)); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); }
        else if (event.key === 'PageDown') { event.preventDefault(); setActive((value) => Math.min(last, value + 8)); }
        else if (event.key === 'PageUp') { event.preventDefault(); setActive((value) => Math.max(0, value - 8)); }
        else if ((event.key === 'Home' || event.key === 'End') && event.ctrlKey) { event.preventDefault(); setActive(event.key === 'Home' ? 0 : last); }
        else if (event.key === 'Enter' && shown[active]) { event.preventDefault(); choose(shown[active]); }
        else if ((event.key === 'd' || event.key === 'D') && (event.ctrlKey || event.metaKey) && shown[active]) { event.preventDefault(); toggle(shown[active]); }
    };

    const maxHeight = Math.max(160, Math.min(MAX_HEIGHT, bounds.height - MARGIN * 2));
    const left = Math.max(MARGIN, Math.min(at.x, bounds.width - WIDTH - MARGIN));
    const top = Math.max(MARGIN, Math.min(at.y, bounds.height - Math.min(height, maxHeight) - MARGIN));
    const grouped = !query.trim();
    const current = shown[active];
    let lastSection = '';

    return (
        <div
            ref={panel}
            data-overlay
            role="dialog"
            aria-label="Add a node"
            className="absolute z-30 flex flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-[0_12px_32px_rgb(0_0_0/0.55)]"
            style={{ left, top, width: WIDTH, maxHeight }}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            {context && <div className="truncate border-b border-line px-2.5 pb-1 pt-1.5 text-2xs text-accent">{context}</div>}
            <div className="flex items-center gap-2 border-b border-line px-2.5 py-1.5">
                <SearchIcon size={13} className="shrink-0 text-ink-3" />
                <input
                    ref={input}
                    role="combobox"
                    aria-expanded
                    aria-controls="node-finder-list"
                    aria-activedescendant={current ? `node-finder-${active}` : undefined}
                    aria-label="Find a node"
                    placeholder="Find a node…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={onKeyDown}
                    className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-3"
                />
            </div>
            <div ref={list} id="node-finder-list" role="listbox" aria-label="Nodes" className="min-h-0 flex-1 overflow-y-auto py-1">
                {shown.length === 0 && <p className="px-3 py-2 text-2xs text-ink-3">No node matches. Try another word for what it does.</p>}
                {shown.map((entry, index) => {
                    const section = grouped ? entrySection(entry, memory) : null;
                    const header = section && section !== lastSection ? section : null;
                    if (section) lastSection = section;
                    const favourite = memory.favourites.includes(entry.id);
                    return (
                        <React.Fragment key={entry.id}>
                            {header && <div className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-ink-3">{header}</div>}
                            <div
                                id={`node-finder-${index}`}
                                data-index={index}
                                role="option"
                                aria-selected={index === active}
                                onMouseEnter={() => setActive(index)}
                                onClick={() => choose(entry)}
                                className={`group flex h-7 cursor-pointer items-center gap-2 px-2.5 text-xs ${index === active ? 'bg-accent/15 text-ink' : 'text-ink-2 hover:bg-white/5'}`}
                            >
                                {renderPicture && <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-sm">{renderPicture(entry, 20)}</span>}
                                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                                {!grouped && <span className="shrink-0 truncate text-2xs text-ink-3">{entry.category}</span>}
                                <button
                                    type="button"
                                    tabIndex={-1}
                                    aria-label={favourite ? `Take ${entry.label} out of favourites` : `Add ${entry.label} to favourites`}
                                    aria-pressed={favourite}
                                    title={favourite ? 'A favourite: click to take it out (Ctrl+D)' : 'Add to favourites (Ctrl+D)'}
                                    onClick={(event) => { event.stopPropagation(); toggle(entry); }}
                                    className={`shrink-0 rounded-sm p-0.5 ${favourite ? 'text-accent' : 'text-ink-3 opacity-0 hover:text-ink group-hover:opacity-100'} ${index === active ? 'opacity-100' : ''}`}
                                >
                                    <StarIcon size={11} fill={favourite ? 'currentColor' : undefined} />
                                </button>
                            </div>
                        </React.Fragment>
                    );
                })}
            </div>
            {current && (
                <div className="flex gap-2.5 border-t border-line p-2.5">
                    {renderPicture && <span className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded border border-line bg-well">{renderPicture(current, 64)}</span>}
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-semibold text-ink">{current.label}</div>
                        {current.description && <p className="mt-0.5 line-clamp-3 text-2xs leading-snug text-ink-3">{current.description}</p>}
                    </div>
                </div>
            )}
            <div className="border-t border-line px-2.5 py-1 text-[10px] text-ink-3">↑↓ choose · Enter add · Ctrl+D favourite · Esc close</div>
        </div>
    );
};
