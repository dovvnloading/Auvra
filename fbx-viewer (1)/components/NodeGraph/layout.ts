import type { NodeLook, Point, Rect } from './model';
import type { NodeView, PinView } from './types';

/**
 * Where everything sits on a node card: its rows of pins (under group headings), its picture, and the
 * place of every pin, which the wires are drawn to. The card and the wire layer both read this, so
 * a wire always ends on its pin.
 */

export const HEADER = 24;
export const ROW = 20;
/** A reroute point's size. */
export const DOT = 16;
const BODY_GAP = 4;
const FOOT = 6;

export type CardRow =
    | { kind: 'pins'; top: number; input?: PinView; output?: PinView }
    | { kind: 'group'; top: number; group: string; open: boolean; hidden: number };

export interface CardLayout {
    width: number;
    height: number;
    rows: CardRow[];
    /** Top of the picture, from the card's top. */
    bodyTop: number;
    /** Each shown pin's place, from the card's top-left; pins of a closed group that nothing is wired to are left out. */
    inputs: ReadonlyMap<string, Point>;
    outputs: ReadonlyMap<string, Point>;
}

/** The groups of a node's pins, in the order they first appear. */
export const pinGroups = (view: NodeView): string[] => {
    const groups: string[] = [];
    for (const pin of [...view.inputs, ...view.outputs]) if (pin.group && !groups.includes(pin.group)) groups.push(pin.group);
    return groups;
};

/** Whether a group starts open when the user has not opened or closed it: the first one does. */
export const groupOpenByDefault = (view: NodeView, group: string): boolean => pinGroups(view)[0] === group;

/**
 * The card's layout. `wired` holds 'in:key' and 'out:key' for every wired pin; `openGroups` the groups
 * the user has opened or closed (true or false), others taking their default.
 */
export const cardLayout = (view: NodeView, look: NodeLook, wired: ReadonlySet<string>, openGroups?: ReadonlyMap<string, boolean>): CardLayout => {
    const inputs = new Map<string, Point>();
    const outputs = new Map<string, Point>();
    if (view.layout === 'dot') {
        for (const pin of view.inputs) inputs.set(pin.key, { x: 0, y: DOT / 2 });
        for (const pin of view.outputs) outputs.set(pin.key, { x: DOT, y: DOT / 2 });
        return { width: DOT, height: DOT, rows: [], bodyTop: DOT, inputs, outputs };
    }
    const width = view.width;
    if (look.collapsed) {
        // Folded to its header: the wired pins meet at the header's two ends.
        for (const pin of view.inputs) if (wired.has(`in:${pin.key}`)) inputs.set(pin.key, { x: 0, y: HEADER / 2 });
        for (const pin of view.outputs) if (wired.has(`out:${pin.key}`)) outputs.set(pin.key, { x: width, y: HEADER / 2 });
        return { width, height: HEADER, rows: [], bodyTop: HEADER, inputs, outputs };
    }
    if (view.layout === 'edges') {
        const span = Math.max(view.inputs.length, view.outputs.length) * ROW;
        const body = Math.max(view.body + 8, span + 8);
        const place = (pins: readonly PinView[], x: number, into: Map<string, Point>) => {
            const top = HEADER + (body - pins.length * ROW) / 2 + ROW / 2;
            pins.forEach((pin, index) => into.set(pin.key, { x, y: top + index * ROW }));
        };
        place(view.inputs, 0, inputs);
        place(view.outputs, width, outputs);
        return { width, height: HEADER + body, rows: [], bodyTop: HEADER + (body - view.body) / 2, inputs, outputs };
    }
    // Rows: pins without a group first, inputs on the left and outputs on the right of the same rows,
    // then each group under its heading; a closed group shows only its wired pins.
    const rows: CardRow[] = [];
    let top = HEADER;
    const addPins = (ins: readonly PinView[], outs: readonly PinView[]) => {
        const count = Math.max(ins.length, outs.length);
        for (let i = 0; i < count; i++) {
            const input = ins[i];
            const output = outs[i];
            rows.push({ kind: 'pins', top, input, output });
            if (input) inputs.set(input.key, { x: 0, y: top + ROW / 2 });
            if (output) outputs.set(output.key, { x: width, y: top + ROW / 2 });
            top += ROW;
        }
    };
    addPins(view.inputs.filter((pin) => !pin.group), view.outputs.filter((pin) => !pin.group));
    for (const group of pinGroups(view)) {
        const open = openGroups?.get(group) ?? groupOpenByDefault(view, group);
        const ins = view.inputs.filter((pin) => pin.group === group);
        const outs = view.outputs.filter((pin) => pin.group === group);
        const shownIns = open ? ins : ins.filter((pin) => wired.has(`in:${pin.key}`));
        const shownOuts = open ? outs : outs.filter((pin) => wired.has(`out:${pin.key}`));
        rows.push({ kind: 'group', top, group, open, hidden: ins.length + outs.length - shownIns.length - shownOuts.length });
        top += ROW;
        addPins(shownIns, shownOuts);
    }
    const bodyTop = top + (view.body ? BODY_GAP : 0);
    const height = view.body ? bodyTop + view.body + FOOT : top + FOOT;
    return { width, height, rows, bodyTop, inputs, outputs };
};

/** The card's rectangle on the canvas. */
export const cardRect = (node: Point, layout: CardLayout): Rect => ({ x: node.x, y: node.y, width: layout.width, height: layout.height });
