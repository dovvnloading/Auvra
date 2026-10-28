import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { MaterialNodeDef } from '../../runtime/materials/materialGraph';
import { searchNodes } from './materialGraphEditing';

/**
 * The node palette: type to find a node (by name, keyword or category), arrow keys and Enter to
 * pick, Escape to close. With nothing typed it lists every node by category.
 */
export const MaterialNodePalette: React.FC<{
    left: number;
    top: number;
    /** What the picked node will be wired to, when a wire was dragged out to open the palette. */
    context?: string;
    onPick: (type: string) => void;
    onClose: () => void;
}> = ({ left, top, context, onPick, onClose }) => {
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const list = useRef<HTMLDivElement>(null);
    const results = useMemo(() => searchNodes(query), [query]);
    const grouped = !query.trim();

    useEffect(() => setActive(0), [query]);
    useEffect(() => {
        list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
    }, [active]);

    const onKeyDown = (event: React.KeyboardEvent) => {
        event.stopPropagation();
        if (event.key === 'Escape') onClose();
        else if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(results.length - 1, index + 1)); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)); }
        else if (event.key === 'Enter' && results[active]) { event.preventDefault(); onPick(results[active].type); }
    };

    let lastCategory = '';
    return (
        <div
            className="absolute z-30 w-72 rounded-md border border-gray-700 bg-gray-900/98 p-2 shadow-2xl"
            style={{ left, top }}
            onMouseDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            {context && <div className="mb-1 truncate px-1 text-[10px] text-blue-300">{context}</div>}
            <div className="mb-2 flex items-center gap-1 rounded border border-gray-700 bg-gray-950 px-2">
                <Search size={12} className="text-gray-500" />
                <input
                    autoFocus
                    aria-label="Search nodes"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="Search nodes…"
                    className="w-full bg-transparent py-1 text-xs text-white outline-none"
                />
            </div>
            <div ref={list} className="max-h-80 overflow-y-auto" role="listbox" aria-label="Nodes">
                {results.length === 0 && <p className="px-2 py-1 text-[11px] text-gray-500">No node matches.</p>}
                {results.map((definition: MaterialNodeDef, index) => {
                    const header = grouped && definition.category !== lastCategory ? definition.category : null;
                    lastCategory = definition.category;
                    return (
                        <React.Fragment key={definition.type}>
                            {header && <div className="px-2 pb-0.5 pt-2 text-[9px] font-bold uppercase tracking-wider text-gray-500">{header}</div>}
                            <button
                                data-index={index}
                                role="option"
                                aria-selected={index === active}
                                onMouseEnter={() => setActive(index)}
                                onClick={() => onPick(definition.type)}
                                title={definition.description}
                                className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs ${index === active ? 'bg-blue-700/50 text-white' : 'text-gray-200'}`}
                            >
                                <span>{definition.label}</span>
                                {!grouped && <span className="text-[9px] uppercase text-gray-500">{definition.category}</span>}
                            </button>
                        </React.Fragment>
                    );
                })}
            </div>
            {results[active] && <p className="mt-1 border-t border-gray-800 px-1 pt-1 text-[10px] leading-snug text-gray-400">{results[active].description}</p>}
        </div>
    );
};
