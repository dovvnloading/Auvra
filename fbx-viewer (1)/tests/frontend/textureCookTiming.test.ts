import { describe, expect, it } from 'vitest';
import { TextureCookTimingWindow } from '../../texturing/graph/cookTiming';

describe('texture graph authoring latency observations', () => {
    it('uses nearest-rank p50/p95 for successful recomputes, excluding pure cache hits', () => {
        const timing = new TextureCookTimingWindow();
        for (let i = 1; i <= 20; i++) timing.record('4k/stones', { drawnNodes: 3, milliseconds: i });
        for (let i = 0; i < 10; i++) timing.record('4k/stones', { drawnNodes: 0, milliseconds: 0.05 });
        expect(timing.summary()).toEqual({
            totalRuns: 30, recomputedRuns: 20, cachedRuns: 10,
            p50Milliseconds: 10, p95Milliseconds: 19, sampleWindow: 64,
        });
    });

    it('resets the window on a changed graph topology or resolution', () => {
        const timing = new TextureCookTimingWindow();
        timing.record('512/three-nodes', { drawnNodes: 3, milliseconds: 12 });
        timing.record('512/three-nodes', { drawnNodes: 0, milliseconds: 0.1 });
        timing.record('2048/three-nodes', { drawnNodes: 3, milliseconds: 100 });
        expect(timing.summary()).toMatchObject({
            totalRuns: 1, recomputedRuns: 1, cachedRuns: 0,
            p50Milliseconds: 100, p95Milliseconds: 100,
        });
    });

    it('keeps only the last 64 observations and rejects invalid timestamps', () => {
        const timing = new TextureCookTimingWindow();
        for (let n = 1; n <= 100; n++) timing.record('graph', { drawnNodes: 1, milliseconds: n });
        for (const bad of [NaN, Infinity, -5]) timing.record('graph', { drawnNodes: 1, milliseconds: bad });
        timing.record('graph', { drawnNodes: -1, milliseconds: 10 });
        timing.record('', { drawnNodes: 1, milliseconds: 9999 });
        expect(timing.summary()).toEqual({
            totalRuns: 64, recomputedRuns: 64, cachedRuns: 0,
            p50Milliseconds: 68, p95Milliseconds: 97, sampleWindow: 64,
        });
        timing.clear();
        expect(timing.summary()).toMatchObject({
            totalRuns: 0, recomputedRuns: 0, cachedRuns: 0,
            p50Milliseconds: null, p95Milliseconds: null,
        });
    });

    it('does not report a fake successful p95 from cache-only runs', () => {
        const timing = new TextureCookTimingWindow();
        timing.record('graph', { drawnNodes: 0, milliseconds: 0.01 });
        expect(timing.summary()).toMatchObject({
            totalRuns: 1, recomputedRuns: 0, cachedRuns: 1,
            p50Milliseconds: null, p95Milliseconds: null,
        });
    });
});
