import { describe, expect, it } from 'vitest';
import { FramePressure, GpuSpanTimer, MIN_RAY_SHARE, RayBudget } from '../../runtime/raytracing/rayBudget';
import { GI_QUALITY, budgetedPlan, resolveDynamicGiSettings } from '../../runtime/lighting/dynamicGi/probeGrid';

/** Runs a budget against a GPU where the whole work costs `fullCostMs`, with timings coming back at once. */
const run = (budget: RayBudget, fullCostMs: number, limitMs: number, frames: number): number => {
    for (let frame = 0; frame < frames; frame++) {
        budget.noteSpent(fullCostMs * budget.share, budget.share);
        budget.settle(limitMs, 1);
    }
    return budget.share;
};

describe('ray budget', () => {
    it('starts on a share a weak card can take, before any timing has come back', () => {
        expect(new RayBudget().share).toBeLessThan(0.25);
    });

    it('does all of the work where the limit pays for it', () => {
        expect(run(new RayBudget(), 2, 4, 120)).toBe(1);
    });

    it('cuts the work until it costs what the limit allows', () => {
        const budget = new RayBudget();
        run(budget, 16, 4, 300);
        expect(budget.share).toBeCloseTo(0.25, 2);
        expect(budget.spentMs).toBeCloseTo(4, 1);
    });

    it('falls at once when the work turns expensive, and climbs back over many frames', () => {
        const budget = new RayBudget();
        run(budget, 1, 4, 120);
        budget.noteSpent(64, 1);
        budget.settle(4, 1);
        const fallen = budget.share;
        expect(fallen).toBeLessThan(0.2);
        budget.noteSpent(fallen, fallen);
        budget.settle(4, 1);
        expect(budget.share).toBeLessThan(0.3);
        expect(run(budget, 1, 4, 300)).toBe(1);
    });

    it('never goes below the least share, however dear the rays', () => {
        expect(run(new RayBudget(), 10000, 0.5, 120)).toBe(MIN_RAY_SHARE);
    });

    it('stands down when even the least worth doing is too dear, and tries again later', () => {
        const budget = new RayBudget(1 / 8);
        budget.noteSpent(100, 1);
        budget.settle(2, 1);
        expect(budget.affordable).toBe(false);
        let frames = 0;
        while (!budget.affordable && frames < 100000) {
            budget.settle(2, 1);
            frames++;
        }
        expect(frames).toBeGreaterThan(120);
        expect(budget.share).toBeCloseTo(1 / 8, 2);
    });

    it('stays affordable with no clock to say otherwise', () => {
        const budget = new RayBudget(1 / 8);
        budget.settle(2, 0.25);
        expect(budget.affordable).toBe(true);
    });

    it('goes by how the frames keep up on a GPU with no clock', () => {
        const budget = new RayBudget();
        for (let frame = 0; frame < 60; frame++) budget.settle(4, 1);
        expect(budget.share).toBe(1);
        expect(budget.settle(4, 0.5)).toBe(0.5);
    });
});

describe('frame pressure', () => {
    const frames = (pressure: FramePressure, ms: number, count: number) => {
        for (let frame = 0; frame < count; frame++) pressure.noteFrame(ms);
    };

    it('stays off while frames keep up', () => {
        const pressure = new FramePressure();
        frames(pressure, 16.7, 600);
        expect(pressure.value).toBe(1);
    });

    it('builds while frames are slow, to a floor, and eases once they keep up', () => {
        const pressure = new FramePressure();
        frames(pressure, 40, 600);
        expect(pressure.value).toBe(0.25);
        frames(pressure, 16.7, 1200);
        expect(pressure.value).toBe(1);
    });

    it('takes a hitch or a hidden tab for nothing', () => {
        const pressure = new FramePressure();
        frames(pressure, 5000, 600);
        expect(pressure.value).toBe(1);
        expect(pressure.frameMs).toBeCloseTo(1000 / 60);
    });
});

describe('budgeted plan', () => {
    const plan = GI_QUALITY.medium;

    it('is the plan itself at full share', () => {
        expect(budgetedPlan(plan, 1)).toEqual(plan);
    });

    it('gives up probes first, keeping each probe as good', () => {
        const half = budgetedPlan(plan, 0.5);
        expect(half.rays).toBe(plan.rays);
        expect(half.probes).toEqual([96, 16, 8, 4]);
    });

    it('then gives up rays, and always leaves every cascade moving', () => {
        const least = budgetedPlan(plan, MIN_RAY_SHARE);
        expect(least.rays).toBe(16);
        expect(Math.min(...least.probes)).toBeGreaterThanOrEqual(1);
        expect(least.probes[0]).toBe(24);
    });

    it('moves its ray count in steps, so a share that wavers does not remake the directions', () => {
        expect(budgetedPlan(plan, 0.095).rays).toBe(budgetedPlan(plan, 0.1).rays);
    });
});

describe('the GPU time limit setting', () => {
    it('falls back on the default, and stays within what makes sense', () => {
        expect(resolveDynamicGiSettings({}).rayLimit).toBe(4);
        expect(resolveDynamicGiSettings({ rayLimit: 8 }).rayLimit).toBe(8);
        expect(resolveDynamicGiSettings({ rayLimit: 0 }).rayLimit).toBe(0.5);
        expect(resolveDynamicGiSettings({ rayLimit: 1000 }).rayLimit).toBe(33);
        expect(resolveDynamicGiSettings({ rayLimit: 'fast' }).rayLimit).toBe(4);
    });
});

describe('GPU span timer', () => {
    interface FakeQuery { available: boolean; nanoseconds: number }

    const fakeGl = (options: { extension?: boolean } = {}) => {
        const state = { lost: false, disjoint: false, running: null as FakeQuery | null, created: 0, deleted: 0, queries: [] as FakeQuery[] };
        const gl = {
            QUERY_RESULT_AVAILABLE: 1,
            QUERY_RESULT: 2,
            createQuery: () => {
                state.created++;
                const query = { available: false, nanoseconds: 0 };
                state.queries.push(query);
                return query;
            },
            deleteQuery: () => { state.deleted++; },
            beginQuery: (_target: number, query: FakeQuery) => { state.running = query; },
            endQuery: () => { state.running = null; },
            getExtension: () => (options.extension === false ? null : {}),
            isContextLost: () => state.lost,
            getParameter: () => state.disjoint,
            getQueryParameter: (query: FakeQuery, which: number) => (which === 1 ? query.available : query.nanoseconds),
        };
        return { gl: gl as unknown as WebGL2RenderingContext, state };
    };

    const finish = (query: FakeQuery, ms: number) => {
        query.available = true;
        query.nanoseconds = ms * 1e6;
    };

    it('hands back a span once the GPU has answered, not before', () => {
        const { gl, state } = fakeGl();
        const timer = new GpuSpanTimer(gl);
        timer.begin(1, 0.5);
        timer.end();
        const seen: number[][] = [];
        timer.read((ms, share) => seen.push([ms, share]));
        expect(seen).toEqual([]);
        finish(state.queries[0], 3);
        timer.read((ms, share) => seen.push([ms, share]));
        expect(seen).toEqual([[3, 0.5]]);
    });

    it("adds up each view's span of one frame, and waits for them all", () => {
        const { gl, state } = fakeGl();
        const timer = new GpuSpanTimer(gl);
        timer.begin(1, 1);
        timer.end();
        timer.begin(1, 1);
        timer.end();
        finish(state.queries[0], 2);
        const seen: number[] = [];
        timer.read(ms => seen.push(ms));
        expect(seen).toEqual([]);
        finish(state.queries[1], 3);
        timer.read(ms => seen.push(ms));
        expect(seen).toEqual([5]);
    });

    it('uses its queries again, and stops timing rather than pile up on a stalled GPU', () => {
        const { gl, state } = fakeGl();
        const timer = new GpuSpanTimer(gl);
        for (let frame = 0; frame < 40; frame++) {
            timer.begin(frame, 1);
            timer.end();
        }
        expect(state.created).toBe(8);
        for (const query of state.queries) finish(query, 1);
        timer.read(() => undefined);
        timer.begin(100, 1);
        timer.end();
        expect(state.created).toBe(8);
    });

    it('throws away what ran while the clock jumped', () => {
        const { gl, state } = fakeGl();
        const timer = new GpuSpanTimer(gl);
        timer.begin(1, 1);
        timer.end();
        finish(state.queries[0], 2);
        state.disjoint = true;
        const seen: number[] = [];
        timer.read(ms => seen.push(ms));
        expect(seen).toEqual([]);
    });

    it('forgets its queries with a lost context', () => {
        const { gl, state } = fakeGl();
        const timer = new GpuSpanTimer(gl);
        timer.begin(1, 1);
        timer.end();
        state.lost = true;
        expect(() => timer.read(() => { throw new Error('nothing to hand back'); })).not.toThrow();
        timer.begin(2, 1);
        expect(state.running).toBeNull();
    });

    it('does nothing where the GPU has no clock', () => {
        const { gl, state } = fakeGl({ extension: false });
        const timer = new GpuSpanTimer(gl);
        expect(timer.available).toBe(false);
        timer.begin(1, 1);
        timer.end();
        expect(state.created).toBe(0);
    });
});
