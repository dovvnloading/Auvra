import { describe, expect, it } from 'vitest';
import type { TileBake } from '../../texturing/bake/meshBaker';
import { bakeBytes, bakeStepsToForget, branchBeforeStep, branchesToDrop, historyKind, strokeLabel, travelTo, type HistoryLines } from '../../texturing/paint/history';
import { DEFAULT_PARTICLES, PARTICLE_PRESETS } from '../../texturing/paint/particles';
import type { HistoryEntry } from '../../texturing/paint/strokes';
import type { PaintDocument } from '../../texturing/paint/paintTypes';

const image = (size: number, kind: 'color' | 'gray' = 'color', precision: 8 | 16 | 32 = 8) => ({ width: size, height: size, kind, precision, refs: 1 }) as unknown as TileBake['coverage'];
/** A bake of one tile whose maps hold `mb` megabytes. */
const bake = (mb: number): Map<number, TileBake> => new Map([[1001, { maps: { normal: image(512 * Math.sqrt(mb), 'color', 8) }, coverage: image(1, 'gray'), nearest: image(1, 'gray') } as unknown as TileBake]]);
const doc = {} as PaintDocument;

describe('the paint history as a list', () => {
    it('names each step by what it holds', () => {
        expect(historyKind({ label: 'Paint', pixels: [] })).toBe('paint');
        expect(historyKind({ label: 'Erase', pixels: [] })).toBe('erase');
        expect(historyKind({ label: 'Fill island', pixels: [] })).toBe('fill');
        expect(historyKind({ label: 'Bake mesh maps', bakeMaps: { before: null, after: new Map() }, document: { before: doc, after: doc } })).toBe('bake');
        expect(historyKind({ label: 'Rename layer', document: { before: doc, after: doc } })).toBe('change');
    });

    it('keeps bakes for undo within their budget, oldest let go of first, the newest always', () => {
        const maps = [bake(1), bake(1), bake(1), bake(1)];
        expect(bakeBytes(maps[1])).toBe(1024 * 1024 + 2);
        const steps: HistoryEntry[] = [1, 2, 3].map((i) => ({ label: `Bake ${i}`, bakeMaps: { before: maps[i - 1], after: maps[i] } }));
        const paint: HistoryEntry = { label: 'Paint', pixels: [] };
        const past = [steps[0], paint, steps[1], steps[2]];
        const mb = 1024 * 1024 + 2;
        // Held: the maps before each bake (the last bake's are in use). Room for two of three.
        expect(bakeStepsToForget(past, [], maps[3], 2 * mb)).toEqual([steps[0]]);
        expect(bakeStepsToForget(past, [], maps[3], 3 * mb)).toEqual([]);
        // However small the budget, the newest bake can still be undone.
        expect(bakeStepsToForget(past, [], maps[3], 0)).toEqual([steps[0], steps[1]]);
        // After undoing the last bake its maps wait in the redo list and count too; the maps in use do not.
        expect(bakeStepsToForget([steps[0], paint, steps[1]], [steps[2]], maps[2], 2 * mb)).toEqual([steps[0]]);
    });

    it('names brush strokes by what they did, particle ones with their own kind', () => {
        const drips = PARTICLE_PRESETS.find((each) => each.id === 'drips')!.settings;
        expect(strokeLabel('paint', { mode: 'paint', particles: drips })).toBe('Drips');
        expect(strokeLabel('paint', { mode: 'paint', particles: { ...drips, count: 7 } })).toBe('Running particles');
        expect(strokeLabel('paint', { mode: 'paint', particles: { ...DEFAULT_PARTICLES, enabled: true, motion: 'bounce' } })).toBe('Bouncing particles');
        expect(strokeLabel('paint', { mode: 'smudge', particles: DEFAULT_PARTICLES })).toBe('Smudge');
        expect(strokeLabel('erase', { mode: 'paint', particles: drips })).toBe('Erase');
        expect(strokeLabel('paint', { mode: 'paint' })).toBe('Paint');
        for (const label of ['Drips', 'Leaks', 'Dust', 'Splashes', 'Running particles']) expect(historyKind({ label, pixels: [] })).toBe('particles');
        expect(historyKind({ label: 'Lay decal', pixels: [] })).toBe('decal');
    });

    it('keep undone steps as a branch, and go to any step on any branch, the line left kept as one', () => {
        const step = (label: string): HistoryEntry => ({ label, pixels: [] });
        const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(step);
        // A state that undo and redo change, so the moves can be checked.
        const applied: string[] = [];
        const lines: HistoryLines = { past: [a, b, c], future: [], branches: [] };
        const move = (direction: 'undo' | 'redo') => {
            if (direction === 'undo') { const entry = lines.past.pop(); if (!entry) return false; lines.future.push(entry); applied.push('-' + entry.label); return true; }
            const entry = lines.future.pop();
            if (!entry) return false;
            lines.past.push(entry);
            applied.push('+' + entry.label);
            return true;
        };
        // Back to after a, then a new step d: b and c are a branch off a.
        expect(travelTo(lines, a, move)).toBe(true);
        branchBeforeStep(lines);
        lines.past.push(d);
        expect(lines.branches).toEqual([{ from: a, steps: [b, c] }]);
        // Going to c: back to a, d kept as a branch, then b and c again.
        applied.length = 0;
        expect(travelTo(lines, c, move)).toBe(true);
        expect(applied).toEqual(['-d', '+b', '+c']);
        expect(lines.past).toEqual([a, b, c]);
        expect(lines.branches).toEqual([{ from: a, steps: [d] }]);
        // A branch off a step of another branch: reached through it.
        travelTo(lines, b, move);
        branchBeforeStep(lines);
        lines.past.push(e);
        expect(travelTo(lines, d, move)).toBe(true);
        expect(lines.past).toEqual([a, d]);
        applied.length = 0;
        expect(travelTo(lines, c, move)).toBe(true);
        expect(lines.past).toEqual([a, b, c]);
        // The start, and a step nobody has.
        expect(travelTo(lines, null, move)).toBe(true);
        expect(lines.past).toEqual([]);
        expect(travelTo(lines, step('gone'), move)).toBe(false);
    });

    it('let go of the oldest branches first past the memory or the count, and of those nothing reaches', () => {
        const step = (label: string, bytes: number): HistoryEntry => ({ label, pixels: [{ key: 'k', tile: 1001, rects: [{ x: 0, y: 0, width: 1, height: 1, before: new Uint8Array(bytes), after: null }] }] });
        const a = step('a', 10), b = step('b', 100), c = step('c', 100), d = step('d', 10);
        const lines: HistoryLines = { past: [a, d], future: [], branches: [{ from: a, steps: [b] }, { from: b, steps: [c] }] };
        // Over budget: the oldest branch goes, and the one coming off it with it.
        expect(branchesToDrop(lines, 150, 10, false)).toEqual(lines.branches);
        expect(branchesToDrop(lines, 1000, 10, false)).toEqual([]);
        expect(branchesToDrop(lines, 1000, 1, false)).toEqual(lines.branches);
        // Off the start, once older steps went, nothing reaches it.
        expect(branchesToDrop({ past: [d], future: [], branches: [{ from: null, steps: [c] }] }, 1000, 10, true)).toHaveLength(1);
        expect(branchesToDrop({ past: [d], future: [], branches: [{ from: null, steps: [c] }] }, 1000, 10, false)).toHaveLength(0);
    });
});
