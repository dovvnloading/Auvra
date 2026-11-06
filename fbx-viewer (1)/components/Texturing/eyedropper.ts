import { useSyncExternalStore } from 'react';

/**
 * PICKING FROM THE VIEWS
 *
 * A setting's eyedropper asks for a colour, or a gradient, from the 2D or 3D view: while a pick is
 * waiting, a click in the 2D view (or on the model in the 3D view) gives the colour under it, and a
 * line dragged across the 2D image gives the colours along it as gradient stops. Escape, or starting
 * another pick, gives up the waiting one.
 */

export type Rgba = [number, number, number, number];
export interface GradientStop { position: number; color: Rgba }

export type Pick =
    | { kind: 'colour'; label: string; done: (colour: Rgba) => void }
    | { kind: 'gradient'; label: string; done: (stops: GradientStop[]) => void };

let waiting: Pick | null = null;
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };

const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') stopPicking(); };

/** Waits for a pick from the views (giving up any pick already waiting). */
export const startPicking = (pick: Pick): void => {
    waiting = pick;
    window.addEventListener('keydown', onKey, true);
    changed();
};

export const stopPicking = (): void => {
    if (!waiting) return;
    waiting = null;
    window.removeEventListener('keydown', onKey, true);
    changed();
};

/** Hands the waiting pick its colour (or stops) and ends it. */
export const finishPicking = (value: Rgba | GradientStop[]): void => {
    const pick = waiting;
    stopPicking();
    if (!pick) return;
    if (pick.kind === 'colour') { if (typeof value[0] === 'number') pick.done(value as Rgba); }
    else if (typeof value[0] === 'object') pick.done(value as GradientStop[]);
};

const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

/** The pick waiting, if any: views show it and take the next click for it. */
export const usePicking = (): Pick | null => useSyncExternalStore(subscribe, () => waiting);

/** Stops `count` evenly placed along sampled colours (first at 0, last at 1). */
export const stopsFrom = (colours: readonly Rgba[]): GradientStop[] =>
    colours.map((color, index) => ({ position: colours.length > 1 ? Math.round((index / (colours.length - 1)) * 1000) / 1000 : 0, color }));
