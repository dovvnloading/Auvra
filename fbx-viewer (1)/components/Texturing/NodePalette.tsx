import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { createNode } from '../../texturing/graph/document';
import { MESH_MAPS, MESH_MAP_LABELS, MESH_MAP_NODE_TYPE, OUTPUT_NODE_TYPE } from '../../texturing/graph/nodes/io';
import { NODE_CATEGORY_ORDER, TEXTURE_NODE_DEFINITIONS } from '../../texturing/graph/registry';
import { OUTPUT_CHANNELS, OUTPUT_CHANNEL_LABELS, type PortKind, type TexGraphNode } from '../../texturing/graph/types';
import type { Point } from './graphEditing';

/** The list of nodes to add, searchable by name, words they are known by and what they do. */

export type PaletteChoice =
    | { kind: 'node'; createNodeAt: (at: Point) => TexGraphNode }
    | { kind: 'graph'; graphId: string };

interface Entry {
    id: string;
    label: string;
    category: string;
    description: string;
    words: string;
    inputs: Array<PortKind | 'any'>;
    outputs: Array<PortKind | 'any'>;
    choice: PaletteChoice;
}

const ENTRIES: Entry[] = (() => {
    const entries: Entry[] = [];
    for (const definition of TEXTURE_NODE_DEFINITIONS) {
        if (definition.type === OUTPUT_NODE_TYPE || definition.type === MESH_MAP_NODE_TYPE) continue;
        entries.push({
            id: definition.type,
            label: definition.label,
            category: definition.category,
            description: definition.description,
            words: [definition.label, ...(definition.keywords ?? []), definition.description].join(' ').toLowerCase(),
            inputs: definition.inputs.map((port) => port.kind),
            outputs: definition.outputs.map((port) => port.kind),
            choice: { kind: 'node', createNodeAt: (at) => createNode(definition.type, at.x, at.y) },
        });
    }
    // One entry per output channel and per mesh map, so they come ready set.
    for (const channel of OUTPUT_CHANNELS) {
        entries.push({
            id: `output:${channel}`,
            label: `Output: ${OUTPUT_CHANNEL_LABELS[channel]}`,
            category: 'Inputs and outputs',
            description: channel === 'custom' ? 'A named image the graph gives, for using it inside other graphs.' : `The material's ${OUTPUT_CHANNEL_LABELS[channel].toLowerCase()}.`,
            words: `output result channel ${channel} ${OUTPUT_CHANNEL_LABELS[channel]}`.toLowerCase(),
            inputs: ['any'],
            outputs: [],
            choice: { kind: 'node', createNodeAt: (at) => createNode(OUTPUT_NODE_TYPE, at.x, at.y, { channel, name: '' }) },
        });
    }
    for (const map of MESH_MAPS) {
        entries.push({
            id: `mesh:${map}`,
            label: `Mesh map: ${MESH_MAP_LABELS[map]}`,
            category: 'Mesh maps',
            description: `The ${MESH_MAP_LABELS[map].toLowerCase()} map baked from the model being painted.`,
            words: `mesh map baked ${map} ${MESH_MAP_LABELS[map]}`.toLowerCase(),
            inputs: [],
            outputs: ['any'],
            choice: { kind: 'node', createNodeAt: (at) => createNode(MESH_MAP_NODE_TYPE, at.x, at.y, { map }) },
        });
    }
    return entries;
})();

const fits = (entry: Entry, wire: { side: 'in' | 'out'; kind: PortKind | 'any' } | null): boolean => {
    if (!wire) return true;
    const ports = wire.side === 'out' ? entry.inputs : entry.outputs;
    return ports.some((kind) => kind === 'any' || wire.kind === 'any' || kind === wire.kind);
};

export const NodePalette: React.FC<{
    at: Point;
    graphs: ReadonlyArray<{ id: string; name: string }>;
    wireKind: { side: 'in' | 'out'; kind: PortKind | 'any' } | null;
    onChoose: (choice: PaletteChoice) => void;
    onClose: () => void;
}> = ({ at, graphs, wireKind, onChoose, onClose }) => {
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const input = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLDivElement>(null);
    useEffect(() => { input.current?.focus(); }, []);

    const entries = useMemo(() => {
        const graphEntries: Entry[] = graphs.map((graph) => ({
            id: `graph:${graph.id}`,
            label: graph.name,
            category: 'Graphs in this project',
            description: 'Another texture graph of the project, used as one node.',
            words: `${graph.name} graph subgraph instance`.toLowerCase(),
            inputs: ['any'],
            outputs: ['any'],
            choice: { kind: 'graph', graphId: graph.id },
        }));
        const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const all = [...ENTRIES, ...graphEntries].filter((entry) => fits(entry, wireKind));
        if (!words.length) {
            const order = [...NODE_CATEGORY_ORDER, 'Graphs in this project'] as string[];
            return all.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
        }
        return all
            .map((entry) => {
                const label = entry.label.toLowerCase();
                let score = 0;
                for (const word of words) {
                    if (!entry.words.includes(word)) return null;
                    score += label.startsWith(word) ? 3 : label.includes(word) ? 2 : 1;
                }
                return { entry, score };
            })
            .filter((item): item is { entry: Entry; score: number } => item !== null)
            .sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label))
            .map((item) => item.entry);
    }, [graphs, query, wireKind]);

    useEffect(() => { setActive(0); }, [query]);
    useEffect(() => {
        list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
    }, [active]);

    const left = Math.max(8, at.x);
    const top = Math.max(8, at.y);
    let lastCategory = '';
    return (
        <div
            className="absolute z-30 flex w-72 flex-col overflow-hidden rounded-md border border-zinc-700 bg-zinc-900 shadow-2xl"
            style={{ left, top, maxHeight: 420 }}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
        >
            <div className="flex items-center gap-2 border-b border-zinc-800 px-2 py-1.5">
                <Search size={13} className="text-zinc-500" />
                <input
                    ref={input}
                    aria-label="Find a node"
                    placeholder={wireKind ? 'Nodes that fit this wire…' : 'Find a node…'}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Escape') onClose();
                        else if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => Math.min(entries.length - 1, value + 1)); }
                        else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); }
                        else if (event.key === 'Enter' && entries[active]) onChoose(entries[active].choice);
                    }}
                    className="min-w-0 flex-1 bg-transparent text-xs text-white outline-none placeholder:text-zinc-500"
                />
            </div>
            <div ref={list} className="min-h-0 flex-1 overflow-y-auto py-1">
                {entries.length === 0 && <p className="px-3 py-2 text-2xs text-zinc-500">Nothing by that name.</p>}
                {entries.map((entry, index) => {
                    const header = !query.trim() && entry.category !== lastCategory ? entry.category : null;
                    lastCategory = entry.category;
                    return (
                        <React.Fragment key={entry.id}>
                            {header && <div className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{header}</div>}
                            <button
                                data-index={index}
                                onMouseEnter={() => setActive(index)}
                                onClick={() => onChoose(entry.choice)}
                                className={`block w-full px-3 py-1 text-left ${index === active ? 'bg-sky-700/40' : 'hover:bg-zinc-800'}`}
                            >
                                <div className="text-xs text-zinc-100">{entry.label}</div>
                                {index === active && <div className="text-2xs leading-snug text-zinc-400">{entry.description}</div>}
                            </button>
                        </React.Fragment>
                    );
                })}
            </div>
        </div>
    );
};
