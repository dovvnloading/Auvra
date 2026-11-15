import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NavBakeInput } from '../../runtime/navMesh';
import type { BakeResponse } from '../../workers/navBake.worker';

// These tests exercise the shared worker client, not Recast's mesh generation.
vi.mock('../../runtime/navMesh', () => ({
    LevelNavMesh: { fromData: (data: Uint8Array) => ({ data }) },
    recastReady: async () => undefined,
    advanceWaypoint: () => 0,
}));
vi.mock('../../runtime/navGeometry', () => ({
    collectNavGeometry: () => ({
        positions: new Float32Array(),
        indices: new Uint32Array(),
        links: [],
        groundHeight: () => 0,
    }),
    navGeometrySignature: () => '',
}));

type BakeRequest = { id: number; input: NavBakeInput };

class StubWorker {
    static instances: StubWorker[] = [];
    static failCreation = false;
    static failPost = false;

    onmessage: ((event: MessageEvent<BakeResponse>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: ((event: MessageEvent) => void) | null = null;
    requests: BakeRequest[] = [];
    terminated = false;

    constructor() {
        if (StubWorker.failCreation) throw new Error('worker startup failed');
        StubWorker.instances.push(this);
    }

    postMessage(request: BakeRequest): void {
        if (StubWorker.failPost) throw new Error('post rejected');
        this.requests.push(request);
    }

    terminate(): void {
        this.terminated = true;
    }

    reply(response: BakeResponse): void {
        this.onmessage?.(new MessageEvent('message', { data: response }));
    }

    crash(): void {
        this.onerror?.(new ErrorEvent('error', { message: 'WASM module import failed' }));
    }

    unreadable(): void {
        this.onmessageerror?.(new MessageEvent('messageerror'));
    }
}

beforeEach(() => {
    vi.resetModules();
    StubWorker.instances = [];
    StubWorker.failCreation = false;
    StubWorker.failPost = false;
    vi.stubGlobal('Worker', StubWorker);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('shared navmesh bake worker failures', () => {
    it('rejects both an in-flight bake and a queued bake when the worker crashes', async () => {
        const { bakeLevelNavMesh } = await import('../../runtime/navigation');
        const inFlight = bakeLevelNavMesh([]);
        const queued = bakeLevelNavMesh([]);
        const active = StubWorker.instances[0];
        expect(active.requests).toHaveLength(2);

        // The first request is running and the second has been posted but not processed.
        const failedInFlight = expect(inFlight).rejects.toThrow(/Navmesh bake worker failed.*WASM module import failed/);
        const failedQueued = expect(queued).rejects.toThrow(/Navmesh bake worker failed.*WASM module import failed/);
        active.crash();
        await Promise.all([failedInFlight, failedQueued]);
        expect(active.terminated).toBe(true);
    });

    it('rejects all outstanding jobs when a response cannot be deserialized', async () => {
        const { bakeLevelNavMesh } = await import('../../runtime/navigation');
        const first = bakeLevelNavMesh([]);
        const second = bakeLevelNavMesh([]);
        const active = StubWorker.instances[0];

        const results = [
            expect(first).rejects.toThrow('Navmesh bake worker response could not be read'),
            expect(second).rejects.toThrow('Navmesh bake worker response could not be read'),
        ];
        active.unreadable();
        await Promise.all(results);
        expect(active.terminated).toBe(true);
    });

    it('keeps a completed bake settled when another pending bake crashes', async () => {
        const { bakeLevelNavMesh } = await import('../../runtime/navigation');
        const onResolved = vi.fn();
        const onRejected = vi.fn();
        const completed = bakeLevelNavMesh([]).then(onResolved, onRejected);
        const queued = bakeLevelNavMesh([]);
        const active = StubWorker.instances[0];
        const data = new Uint8Array([1, 2, 3]);

        active.reply({ id: active.requests[0].id, data });
        await completed;
        const failed = expect(queued).rejects.toThrow('Navmesh bake worker failed');
        active.crash();
        await failed;

        // Duplicate replies, error events, and late replies cannot settle a job again.
        active.reply({ id: active.requests[0].id, data });
        active.crash();
        await Promise.resolve();
        expect(onResolved).toHaveBeenCalledTimes(1);
        expect(onResolved).toHaveBeenCalledWith({ data });
        expect(onRejected).not.toHaveBeenCalled();
    });

    it('creates a fresh worker after a crash and ignores late events from the old worker', async () => {
        const { bakeLevelNavMesh } = await import('../../runtime/navigation');
        const failedBake = bakeLevelNavMesh([]);
        const original = StubWorker.instances[0];
        const failure = expect(failedBake).rejects.toThrow('Navmesh bake worker failed');
        original.crash();
        await failure;

        const onResolved = vi.fn();
        const onRejected = vi.fn();
        const recovered = bakeLevelNavMesh([]).then(onResolved, onRejected);
        const replacement = StubWorker.instances[1];
        expect(replacement).not.toBe(original);
        expect(original.terminated).toBe(true);
        expect(replacement.requests).toHaveLength(1);

        // Even if a terminated worker emits a late reply with the new job's ID, it is ignored.
        original.reply({ id: replacement.requests[0].id, data: new Uint8Array([99]) });
        original.crash();
        await Promise.resolve();
        expect(onResolved).not.toHaveBeenCalled();
        expect(onRejected).not.toHaveBeenCalled();

        const data = new Uint8Array([4, 5]);
        replacement.reply({ id: replacement.requests[0].id, data });
        await recovered;
        expect(onResolved).toHaveBeenCalledExactlyOnceWith({ data });
        expect(onRejected).not.toHaveBeenCalled();
        expect(replacement.terminated).toBe(false);
    });

    it('rejects and resets a worker that throws synchronously while posting', async () => {
        const { bakeLevelNavMesh } = await import('../../runtime/navigation');
        StubWorker.failPost = true;
        await expect(bakeLevelNavMesh([])).rejects.toThrow('Navmesh bake worker could not accept the request');
        expect(StubWorker.instances[0].terminated).toBe(true);

        StubWorker.failPost = false;
        const recovered = bakeLevelNavMesh([]);
        const replacement = StubWorker.instances[1];
        const data = new Uint8Array([7]);
        replacement.reply({ id: replacement.requests[0].id, data });
        await expect(recovered).resolves.toEqual({ data });
    });

    it('times out a silent worker, settling every pending job and allowing recovery', async () => {
        const { bakeLevelNavMesh, NAV_BAKE_WORKER_TIMEOUT_MS } = await import('../../runtime/navigation');
        vi.useFakeTimers();
        const first = bakeLevelNavMesh([]);
        const second = bakeLevelNavMesh([]);
        const results = [
            expect(first).rejects.toThrow('Navmesh bake worker timed out'),
            expect(second).rejects.toThrow('Navmesh bake worker timed out'),
        ];
        await vi.advanceTimersByTimeAsync(NAV_BAKE_WORKER_TIMEOUT_MS + 1);
        await Promise.all(results);
        expect(StubWorker.instances[0].terminated).toBe(true);

        const recovered = bakeLevelNavMesh([]);
        const replacement = StubWorker.instances[1];
        const data = new Uint8Array([8]);
        replacement.reply({ id: replacement.requests[0].id, data });
        await expect(recovered).resolves.toEqual({ data });
    });

    it('preserves successful replies and isolates per-bake errors without replacing the worker', async () => {
        const { bakeLevelNavMesh } = await import('../../runtime/navigation');
        const rejected = bakeLevelNavMesh([]);
        const successful = bakeLevelNavMesh([]);
        const active = StubWorker.instances[0];
        const data = new Uint8Array([10, 20]);

        const failed = expect(rejected).rejects.toThrow('No walkable geometry');
        active.reply({ id: active.requests[0].id, error: 'No walkable geometry' });
        active.reply({ id: active.requests[1].id, data });
        await failed;
        await expect(successful).resolves.toEqual({ data });
        expect(active.terminated).toBe(false);

        const next = bakeLevelNavMesh([]);
        expect(StubWorker.instances).toHaveLength(1);
        active.reply({ id: active.requests[2].id, data });
        await expect(next).resolves.toEqual({ data });
    });

    it('rejects a worker startup failure and can start one later', async () => {
        const { bakeLevelNavMesh } = await import('../../runtime/navigation');
        StubWorker.failCreation = true;
        await expect(bakeLevelNavMesh([])).rejects.toThrow('Navmesh bake worker could not start');
        expect(StubWorker.instances).toHaveLength(0);

        StubWorker.failCreation = false;
        const recovered = bakeLevelNavMesh([]);
        const active = StubWorker.instances[0];
        const data = new Uint8Array([6]);
        active.reply({ id: active.requests[0].id, data });
        await expect(recovered).resolves.toEqual({ data });
    });
});
