import type React from 'react';

/** How the canvas shows a node and its pins: given by each graph's adapter. */

export interface PinView {
    key: string;
    label: string;
    /** What it carries: picks its colour and the words in its tooltip. */
    kind: string;
    /** The heading it is listed under (Base, Coat...), on nodes laid out in rows. */
    group?: string;
    /** A short value shown beside an unwired input. */
    inline?: string;
    /** A colour swatch shown beside an unwired input (#rrggbb). */
    inlineColour?: string;
}

export interface NodeView {
    /** The title in its header (the user's own name when it has one). */
    title: string;
    /** The header's colour. */
    tint: string;
    /**
     * 'rows': a labelled row per pin, under group headings; 'edges': pins spread down the sides of its
     * picture; 'dot': a reroute point.
     */
    layout: 'rows' | 'edges' | 'dot';
    width: number;
    /** Height of the picture under its pins (0 for none). */
    body: number;
    inputs: readonly PinView[];
    outputs: readonly PinView[];
    /** Shown dimmed: it feeds nothing the result reads. */
    unused?: boolean;
    /** What went wrong, shown as a mark and in its tooltip. */
    error?: string;
    /** A placeholder for a node this build does not have. */
    missing?: boolean;
    /** A short note at the right of its header (how long it took, the parameter it exposes). */
    badge?: string;
    /** What it does, for its tooltip. */
    description?: string;
    canBypass: boolean;
    canDelete: boolean;
    /** The material's output, drawn with a border of its own. */
    output?: boolean;
    /** A graph used as a node, which can be opened in place. */
    canOpen?: boolean;
    /** Words "find in graph" matches besides the title: its kind, what it does. */
    searchText?: string;
}

/** A kind of thing pins carry: its colour, how a tooltip names it, and whether its wires are drawn wide (a whole material). */
export interface PinKindStyle { colour: string; words: string; wide?: boolean }

export interface MenuItem {
    label: string;
    icon?: React.ReactNode;
    shortcut?: string;
    disabled?: boolean;
    /** Shown as its tooltip, saying why it is greyed out. */
    hint?: string;
    /** Destroys something: drawn in the warning colour. */
    danger?: boolean;
    /** Items of one section sit together, parted from the next by a line. */
    section?: string;
    onSelect: () => void;
}
