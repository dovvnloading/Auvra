import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface StubResponse {
    id: number;
    picture?: unknown;
    error?: string;
}

class StubWorker {
    static instances: StubWorker[] = [];
    static failCreation = false;
    static failPost = false;

    onmessage: ((event: MessageEvent<StubResponse>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: ((event: MessageEvent) => void) | null = null;
    sent: Array<{ id: number }> = [];
    terminated = false;

    constructor() {
        if (StubWorker.failCreation) throw new Error('worker creation rejected');
        StubWorker.instances.push(this);
    }

    postMessage(value: { id: number }, _transfer?: Transferable[]): void {
        if (StubWorker.failPost) throw new Error('post rejected');
        this.sent.push(value);
    }

    terminate(): void {
        this.terminated = true;
    }

    reply(response: StubResponse): void {
        this.onmessage?.(new MessageEvent('message', { data: response }));
    }

    crash(): void {
        this.onerror?.(new ErrorEvent('error'));
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

describe('texture pipeline worker failures', () => {
    it('rejects every pending job on a crash and creates a working replacement', async () => {
        const { decodePictureOffPage } = await import('../../texturing/texturePipeline');
        const first = decodePictureOffPage(new Uint8Array([1]), 'first.png');
        const second = decodePictureOffPage(new Uint8Array([2]), 'second.png');
        const original = StubWorker.instances[0];
        const firstFailure = expect(first).rejects.toThrow('Texture worker failed');
        const secondFailure = expect(second).rejects.toThrow('Texture worker failed');
        original.crash();
        await Promise.all([firstFailure, secondFailure]);
        expect(original.terminated).toBe(true);

        const recovered = decodePictureOffPage(new Uint8Array([3]), 'recovered.png');
        const next = StubWorker.instances[1];
        const picture = { width: 1, height: 1, rgba: new Uint8Array(4) };
        next.reply({ id: next.sent[0].id, picture });
        await expect(recovered).resolves.toEqual(picture);
    });

    it('rejects unreadable replies and synchronous postMessage failures', async () => {
        const { decodePictureOffPage } = await import('../../texturing/texturePipeline');
        const unreadable = decodePictureOffPage(new Uint8Array([1]));
        const first = StubWorker.instances[0];
        const failed = expect(unreadable).rejects.toThrow('could not be read');
        first.unreadable();
        await failed;
        expect(first.terminated).toBe(true);

        StubWorker.failPost = true;
        const postFailure = decodePictureOffPage(new Uint8Array([2]));
        await expect(postFailure).rejects.toThrow('could not accept');
        expect(StubWorker.instances[1].terminated).toBe(true);

        StubWorker.failPost = false;
        const working = decodePictureOffPage(new Uint8Array([3]));
        const replacement = StubWorker.instances[2];
        replacement.reply({ id: replacement.sent[0].id, picture: { width: 1 } });
        await expect(working).resolves.toEqual({ width: 1 });
    });

    it('rejects worker startup failures without leaving pending jobs', async () => {
        const { decodePictureOffPage } = await import('../../texturing/texturePipeline');
        StubWorker.failCreation = true;
        await expect(decodePictureOffPage(new Uint8Array([1]))).rejects.toThrow('could not start');
        StubWorker.failCreation = false;
        const recovered = decodePictureOffPage(new Uint8Array([2]));
        const replacement = StubWorker.instances[0];
        replacement.reply({ id: replacement.sent[0].id, picture: { width: 2 } });
        await expect(recovered).resolves.toEqual({ width: 2 });
    });

    it('times out a permanently unresponsive worker and allows the next request', async () => {
        const { decodePictureOffPage, TEXTURE_WORKER_TIMEOUT_MS } = await import('../../texturing/texturePipeline');
        vi.useFakeTimers();
        const stalled = decodePictureOffPage(new Uint8Array([1]));
        const failed = expect(stalled).rejects.toThrow('timed out');
        await vi.advanceTimersByTimeAsync(TEXTURE_WORKER_TIMEOUT_MS + 1);
        await failed;
        expect(StubWorker.instances[0].terminated).toBe(true);

        const recovered = decodePictureOffPage(new Uint8Array([2]));
        const replacement = StubWorker.instances[1];
        replacement.reply({ id: replacement.sent[0].id, picture: { width: 2 } });
        await expect(recovered).resolves.toEqual({ width: 2 });
    });
});
