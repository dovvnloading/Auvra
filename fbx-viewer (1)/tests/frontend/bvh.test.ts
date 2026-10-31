import { describe, expect, it } from 'vitest';
import { BOUNDS_FLOATS, NODE_FLOATS, buildBvh, closestPrimitive, refitBvh, type Bvh } from '../../runtime/raytracing/bvh';

/** Repeatable random numbers, so a failure can be run again. */
const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const boxesOf = (count: number, seed: number, size = 1): Float32Array => {
    const next = random(seed);
    const bounds = new Float32Array(count * BOUNDS_FLOATS);
    for (let index = 0; index < count; index++) {
        const from = index * BOUNDS_FLOATS;
        for (let k = 0; k < 3; k++) {
            const low = next() * 100 - 50;
            bounds[from + k] = low;
            bounds[from + 3 + k] = low + next() * size;
        }
    }
    return bounds;
};

const hitBox = (bounds: Float32Array, primitive: number, o: readonly number[], d: readonly number[]): number => {
    const from = primitive * BOUNDS_FLOATS;
    let near = 0;
    let far = Infinity;
    for (let k = 0; k < 3; k++) {
        const t1 = (bounds[from + k] - o[k]) / d[k];
        const t2 = (bounds[from + 3 + k] - o[k]) / d[k];
        near = Math.max(near, Math.min(t1, t2));
        far = Math.min(far, Math.max(t1, t2));
    }
    return near <= far ? near : Infinity;
};

const leavesOf = (bvh: Bvh): number[] => {
    const seen: number[] = [];
    for (let node = 0; node < bvh.nodeCount; node++) {
        const offset = node * NODE_FLOATS;
        const count = bvh.nodes[offset + 7];
        if (count > 0) for (let at = 0; at < count; at++) seen.push(bvh.order[bvh.nodes[offset + 3] + at]);
    }
    return seen;
};

const contains = (bvh: Bvh, node: number, bounds: Float32Array, primitive: number): boolean => {
    const offset = node * NODE_FLOATS;
    const from = primitive * BOUNDS_FLOATS;
    for (let k = 0; k < 3; k++) {
        if (bounds[from + k] < bvh.nodes[offset + k] - 1e-3) return false;
        if (bounds[from + 3 + k] > bvh.nodes[offset + 4 + k] + 1e-3) return false;
    }
    return true;
};

const everyBoxHolds = (bvh: Bvh, bounds: Float32Array): void => {
    const check = (node: number): number[] => {
        const offset = node * NODE_FLOATS;
        const count = bvh.nodes[offset + 7];
        let held: number[];
        if (count > 0) {
            const first = bvh.nodes[offset + 3];
            held = Array.from(bvh.order.subarray(first, first + count));
        } else {
            const left = bvh.nodes[offset + 3];
            expect(left).toBeGreaterThan(node);
            held = [...check(left), ...check(left + 1)];
        }
        for (const primitive of held) expect(contains(bvh, node, bounds, primitive)).toBe(true);
        return held;
    };
    check(0);
};

describe('building a tree', () => {
    it('holds every primitive exactly once, in boxes that contain them', () => {
        const bounds = boxesOf(5000, 1);
        const bvh = buildBvh(bounds, 5000);
        expect(leavesOf(bvh).sort((a, b) => a - b)).toEqual(Array.from({ length: 5000 }, (_, index) => index));
        everyBoxHolds(bvh, bounds);
    });

    it('finds what a test of every primitive finds', () => {
        const bounds = boxesOf(2000, 2, 5);
        const bvh = buildBvh(bounds, 2000);
        const next = random(3);
        let hits = 0;
        for (let ray = 0; ray < 500; ray++) {
            const origin = [next() * 120 - 60, next() * 120 - 60, next() * 120 - 60] as const;
            const direction = [next() - 0.5, next() - 0.5, next() - 0.5] as const;
            let best = Infinity;
            for (let primitive = 0; primitive < 2000; primitive++) best = Math.min(best, hitBox(bounds, primitive, origin, direction));
            const found = closestPrimitive(bvh, origin, direction, primitive => hitBox(bounds, primitive, origin, direction));
            if (best === Infinity) {
                expect(found.primitive).toBe(-1);
            } else {
                hits++;
                expect(found.distance).toBeCloseTo(best, 3);
            }
        }
        expect(hits).toBeGreaterThan(50);
    });

    it('visits far fewer nodes than there are primitives', () => {
        const bounds = boxesOf(20000, 4, 0.5);
        const bvh = buildBvh(bounds, 20000);
        const next = random(5);
        let visited = 0;
        for (let ray = 0; ray < 200; ray++) {
            const origin = [next() * 100 - 50, next() * 100 - 50, next() * 100 - 50] as const;
            const direction = [next() - 0.5, next() - 0.5, next() - 0.5] as const;
            visited += closestPrimitive(bvh, origin, direction, primitive => hitBox(bounds, primitive, origin, direction)).nodesVisited;
        }
        expect(visited / 200).toBeLessThan(600);
    });

    it('splits primitives that all sit in one place, so no leaf grows without limit', () => {
        const count = 100;
        const bounds = new Float32Array(count * BOUNDS_FLOATS);
        for (let index = 0; index < count; index++) bounds.set([0, 0, 0, 1, 1, 1], index * BOUNDS_FLOATS);
        const bvh = buildBvh(bounds, count, 4);
        expect(leavesOf(bvh)).toHaveLength(count);
        for (let node = 0; node < bvh.nodeCount; node++) expect(bvh.nodes[node * NODE_FLOATS + 7]).toBeLessThanOrEqual(4);
    });

    it('makes one leaf of one primitive when asked for leaves of one', () => {
        const bounds = boxesOf(64, 6);
        const bvh = buildBvh(bounds, 64, 1);
        for (let node = 0; node < bvh.nodeCount; node++) expect(bvh.nodes[node * NODE_FLOATS + 7]).toBeLessThanOrEqual(1);
        expect(leavesOf(bvh)).toHaveLength(64);
    });

    it('builds a tree over nothing that no ray can enter', () => {
        const bvh = buildBvh(new Float32Array(0), 0);
        expect(bvh.nodeCount).toBe(1);
        expect(closestPrimitive(bvh, [0, 0, 0], [1, 1, 1], () => 1).primitive).toBe(-1);
    });

    it('handles rays along an axis, whose inverse direction is infinite', () => {
        const bounds = new Float32Array([5, -1, -1, 6, 1, 1]);
        const bvh = buildBvh(bounds, 1);
        const found = closestPrimitive(bvh, [0, 0, 0], [1, 0, 0], () => 5);
        expect(found.primitive).toBe(0);
    });
});

describe('refitting a tree', () => {
    it('follows primitives that moved', () => {
        const bounds = boxesOf(1000, 7);
        const bvh = buildBvh(bounds, 1000, 1);
        const next = random(8);
        for (let index = 0; index < 1000; index += 3) {
            const from = index * BOUNDS_FLOATS;
            const shift = next() * 20 - 10;
            for (let k = 0; k < 6; k++) bounds[from + k] += shift;
        }
        refitBvh(bvh, bounds);
        everyBoxHolds(bvh, bounds);
        const origin = [-80, -80, -80] as const;
        const direction = [1, 1.1, 0.9] as const;
        let best = Infinity;
        for (let primitive = 0; primitive < 1000; primitive++) best = Math.min(best, hitBox(bounds, primitive, origin, direction));
        const found = closestPrimitive(bvh, origin, direction, primitive => hitBox(bounds, primitive, origin, direction));
        expect(found.distance).toBeCloseTo(best, 3);
    });
});
