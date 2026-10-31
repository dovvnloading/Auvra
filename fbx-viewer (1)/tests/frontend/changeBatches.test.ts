import { describe, expect, it } from 'vitest';
import { changeBatches } from '../../utils/projectChangeBatches';
import type { ProjectChange } from '../../utils/projectService';

const change = (id: string, size = 10): ProjectChange => ({ domain: 'objects', operation: 'upsert', id, value: { text: 'x'.repeat(size) } });

describe('committing many level objects', () => {
    it('sends few changes as one commit, in order', () => {
        const changes = [change('a'), change('b'), change('c')];
        expect(changeBatches(changes)).toEqual([changes]);
    });

    it('sends nothing for no changes', () => {
        expect(changeBatches([])).toEqual([]);
    });

    it('splits on what fits a host message, keeping the order', () => {
        const changes = Array.from({ length: 10 }, (_, index) => change(`object-${index}`, 40 * 1024));
        const batches = changeBatches(changes);
        expect(batches.length).toBeGreaterThan(1);
        expect(batches.flat()).toEqual(changes);
        for (const batch of batches) expect(JSON.stringify(batch).length).toBeLessThan(256 * 1024);
    });

    it('stays within the most changes the host takes in one commit, even for the smallest changes', () => {
        const batches = changeBatches(Array.from({ length: 30000 }, (_, index) => ({ domain: 'o', operation: 'remove' as const, id: String(index) })));
        for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(10000);
    });

    it('still sends a change too big to share a message, alone', () => {
        const big = change('big', 300 * 1024);
        expect(changeBatches([change('a'), big, change('b')]).map(batch => batch.length)).toEqual([1, 1, 1]);
    });
});
