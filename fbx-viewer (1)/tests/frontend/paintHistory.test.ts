import { describe, expect, it } from 'vitest';
import type { TileBake } from '../../texturing/bake/meshBaker';
import { bakeBytes, bakeStepsToForget, historyKind, strokeLabel } from '../../texturing/paint/history';
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
});
