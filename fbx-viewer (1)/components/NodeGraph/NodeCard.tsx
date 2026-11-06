import React, { useRef, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon, LayersIcon, WarningIcon } from '../UI/Icons';
import { HEADER, ROW, type CardLayout } from './layout';
import type { EditableNode } from './model';
import type { NodeView, PinKindStyle } from './types';

/**
 * One node on the canvas: its header (title, marks), its pins in rows or down its sides, and its
 * picture. Cards are memoised: one redraws only when its own node, look or wiring changes.
 */

export interface CardActions {
    /** A new name typed in the title, or null when the typing was given up. */
    rename: (nodeId: string, name: string | null) => void;
    toggleGroup: (nodeId: string, group: string) => void;
    toggleCollapsed: (nodeId: string) => void;
    openGraph: (nodeId: string) => void;
}

export interface NodeCardProps {
    node: EditableNode;
    view: NodeView;
    layout: CardLayout;
    /** Wired pins, as 'in:key' and 'out:key'. */
    wired: ReadonlySet<string>;
    selected: boolean;
    /** Shown in another view (the 2D view): marked with the accent. */
    highlighted: boolean;
    /** How far it is being dragged, in graph units. */
    dx: number;
    dy: number;
    /** 'chip' when zoomed far out: a coloured block with its title. */
    detail: 'full' | 'chip';
    renaming: boolean;
    /** Whether it can be folded to its header (its graph keeps that). */
    folds: boolean;
    kinds: Readonly<Record<string, PinKindStyle>>;
    actions: CardActions;
    renderBody?: (nodeId: string, view: NodeView) => React.ReactNode;
}

const styleOf = (kinds: Readonly<Record<string, PinKindStyle>>, kind: string): PinKindStyle => kinds[kind] ?? { colour: '#a3a3a3', words: kind };

/** The title typed in place: kept on Enter or on leaving the box, given up on Escape. */
const TitleBox: React.FC<{ value: string; onDone: (value: string | null) => void }> = ({ value, onDone }) => {
    const [draft, setDraft] = useState(value);
    const finished = useRef(false);
    const finish = (result: string | null) => {
        if (finished.current) return;
        finished.current = true;
        onDone(result);
    };
    return (
        <input
            autoFocus
            aria-label="Node name"
            value={draft}
            maxLength={64}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={(event) => event.target.select()}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onBlur={() => finish(draft)}
            onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') finish(draft);
                if (event.key === 'Escape') finish(null);
            }}
            className="h-[18px] min-w-0 flex-1 rounded-sm bg-black/40 px-1 text-2xs font-semibold text-ink outline-none ring-1 ring-accent/70"
        />
    );
};

const Pin: React.FC<{ nodeId: string; side: 'in' | 'out'; pinKey: string; label: string; kind: PinKindStyle; wired: boolean; x: number; y: number }> = ({ nodeId, side, pinKey, label, kind, wired, x, y }) => (
    <div
        data-pin={side}
        data-node={nodeId}
        data-key={pinKey}
        title={`${label} (${kind.words})`}
        className="absolute h-3 w-3 cursor-crosshair rounded-full border-2 transition-transform duration-75 hover:scale-125"
        style={{ left: x - 6, top: y - 6, borderColor: kind.colour, background: wired || side === 'out' ? kind.colour : '#111214' }}
    />
);

const NodeCardBase: React.FC<NodeCardProps> = ({ node, view, layout, wired, selected, highlighted, dx, dy, detail, renaming, folds, kinds, actions, renderBody }) => {
    const left = node.x + dx;
    const top = node.y + dy;
    const tint = node.color ?? view.tint;
    const dim = view.unused && !selected ? 0.55 : 1;
    const tooltip = view.error ?? view.description;

    if (view.layout === 'dot') {
        const pinKind = styleOf(kinds, view.outputs[0]?.kind ?? view.inputs[0]?.kind ?? 'any');
        return (
            <div data-node={node.id} title="Reroute point" className={`absolute rounded-full border-2 ${selected ? 'border-accent' : 'border-ground'}`}
                style={{ left, top, width: layout.width, height: layout.height, background: pinKind.colour, opacity: dim }}>
                {view.inputs.map((pin) => <div key={`in:${pin.key}`} data-pin="in" data-node={node.id} data-key={pin.key} className="absolute left-0 top-0 h-full w-1/2 cursor-crosshair" />)}
                {view.outputs.map((pin) => <div key={`out:${pin.key}`} data-pin="out" data-node={node.id} data-key={pin.key} className="absolute right-0 top-0 h-full w-1/2 cursor-crosshair" />)}
            </div>
        );
    }

    const border = selected ? 'border-accent ring-1 ring-accent/50' : view.missing ? 'border-dashed border-warn' : view.error ? 'border-bad' : highlighted ? 'border-accent/60' : view.output ? 'border-ok/60' : 'border-line';

    if (detail === 'chip') {
        // Far out: a block the size of the card, coloured as its header, with its title.
        return (
            <div data-node={node.id} title={view.title} className={`absolute overflow-hidden rounded-md border ${border}`}
                style={{ left, top, width: layout.width, height: layout.height, background: '#1e1f22', opacity: node.bypass ? dim * 0.5 : dim }}>
                <div className="truncate px-2 text-[22px] font-semibold leading-[34px] text-ink" style={{ background: tint, height: Math.min(layout.height, HEADER * 1.6) }}>{view.title}</div>
            </div>
        );
    }

    return (
        <div
            data-node={node.id}
            title={renaming ? undefined : tooltip}
            className={`absolute select-none rounded-md border bg-panel shadow-[0_2px_8px_rgb(0_0_0/0.45)] ${border}`}
            style={{ left, top, width: layout.width, height: layout.height, opacity: dim }}
        >
            <div className={`flex items-center gap-1 rounded-t-md px-1 text-2xs font-semibold text-white ${node.collapsed ? 'rounded-b-md' : ''}`} style={{ height: HEADER, background: tint }}>
                {folds || node.collapsed ? (
                    <button type="button" data-node-action="collapse" aria-label={node.collapsed ? 'Unfold' : 'Fold to its header'} title={node.collapsed ? 'Unfold (H)' : 'Fold to its header (H)'}
                        onClick={() => actions.toggleCollapsed(node.id)} className="shrink-0 rounded-sm text-white/70 hover:text-white">
                        {node.collapsed ? <ChevronRightIcon size={11} /> : <ChevronDownIcon size={11} />}
                    </button>
                ) : null}
                {renaming
                    ? <TitleBox value={view.title} onDone={(name) => actions.rename(node.id, name)} />
                    : <span className="min-w-0 flex-1 truncate">{view.title}</span>}
                {node.bypass && <span className="shrink-0 rounded-sm bg-black/40 px-1 text-[9px] font-medium uppercase tracking-wide text-white/80" title="Bypassed: its main input passes straight through">Bypassed</span>}
                {view.canOpen && (
                    <button type="button" data-node-action="open" aria-label="Open the graph inside" title="Open the graph inside"
                        onClick={() => actions.openGraph(node.id)} className="shrink-0 rounded-sm p-px text-white/70 hover:bg-black/30 hover:text-white">
                        <LayersIcon size={11} />
                    </button>
                )}
                {view.error && <WarningIcon size={11} className={`shrink-0 ${view.missing ? 'text-warn' : 'text-bad'}`} />}
                {!view.error && view.badge && <span className="shrink-0 font-mono text-[9px] font-normal text-white/70">{view.badge}</span>}
            </div>
            {!node.collapsed && view.layout === 'rows' && layout.rows.map((row) => (row.kind === 'group' ? (
                <button
                    key={`group:${row.group}`}
                    type="button"
                    data-node-action="group"
                    onClick={() => actions.toggleGroup(node.id, row.group)}
                    title={row.open ? `Close ${row.group}: only its wired pins stay` : `Open ${row.group}`}
                    className="absolute left-0 flex w-full items-center gap-1 border-t border-line/70 px-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-ink-3 hover:text-ink-2"
                    style={{ top: row.top, height: ROW }}
                >
                    {row.open ? <ChevronDownIcon size={10} /> : <ChevronRightIcon size={10} />}
                    <span className="flex-1 truncate">{row.group}</span>
                    {!row.open && row.hidden > 0 && <span className="font-normal normal-case tracking-normal text-ink-3">{row.hidden} more</span>}
                </button>
            ) : (
                <div key={`row:${row.top}`} className="absolute left-0 flex w-full items-center text-2xs text-ink-2" style={{ top: row.top, height: ROW }}>
                    {row.input && (
                        <span className="flex min-w-0 flex-1 items-center gap-1 pl-2.5">
                            <span className="truncate">{row.input.label}</span>
                            {!wired.has(`in:${row.input.key}`) && row.input.inlineColour && <span className="h-2.5 w-3.5 shrink-0 rounded-sm border border-line" style={{ background: row.input.inlineColour }} />}
                            {!wired.has(`in:${row.input.key}`) && row.input.inline && <span className="shrink-0 font-mono text-[10px] text-ink-3">{row.input.inline}</span>}
                        </span>
                    )}
                    {!row.input && <span className="flex-1" />}
                    {row.output && <span className="max-w-[60%] truncate pr-2.5 text-right">{row.output.label}</span>}
                </div>
            )))}
            {!node.collapsed && view.body > 0 && renderBody && (
                <div className="pointer-events-none absolute left-0 flex w-full justify-center" style={{ top: layout.bodyTop, height: view.body }}>
                    {renderBody(node.id, view)}
                </div>
            )}
            {node.bypass && !node.collapsed && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 rounded-b-md" style={{ top: HEADER, background: 'repeating-linear-gradient(135deg, rgb(0 0 0 / 0.38) 0 6px, transparent 6px 12px)' }} />
            )}
            {view.missing && !node.collapsed && (
                <p className="pointer-events-none absolute inset-x-0 px-2 text-center text-2xs leading-snug text-warn/80" style={{ top: layout.bodyTop + 4 }}>Not available in this version. Settings and wires are kept.</p>
            )}
            {view.inputs.map((pin) => {
                const at = layout.inputs.get(pin.key);
                if (!at) return null;
                return <Pin key={`in:${pin.key}`} nodeId={node.id} side="in" pinKey={pin.key} label={pin.label} kind={styleOf(kinds, pin.kind)} wired={wired.has(`in:${pin.key}`)} x={at.x} y={at.y} />;
            })}
            {view.outputs.map((pin) => {
                const at = layout.outputs.get(pin.key);
                if (!at) return null;
                return <Pin key={`out:${pin.key}`} nodeId={node.id} side="out" pinKey={pin.key} label={pin.label} kind={styleOf(kinds, pin.kind)} wired={wired.has(`out:${pin.key}`)} x={at.x} y={at.y} />;
            })}
            {view.layout === 'edges' && !node.collapsed && view.outputs.length > 1 && view.outputs.map((pin) => {
                const at = layout.outputs.get(pin.key);
                return at ? <span key={`label:${pin.key}`} className="pointer-events-none absolute whitespace-nowrap text-[10px] text-ink-3" style={{ left: layout.width + 8, top: at.y - 7 }}>{pin.label}</span> : null;
            })}
        </div>
    );
};

export const NodeCard = React.memo(NodeCardBase);
NodeCard.displayName = 'NodeCard';

