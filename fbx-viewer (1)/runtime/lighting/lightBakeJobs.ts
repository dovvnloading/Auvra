import type { LevelObject } from '../../types';
import type { BakedLightingSettings } from './bakedLighting';
import type { LightBakeProgress, LightBakeResult } from './lightBaker';

/**
 * Hands a light bake from the editor's panels to the viewport that draws the level (where
 * LightBakeRunner bakes it, a few probes a frame), and its progress and result back. One bake runs
 * at a time.
 */

export interface LightBakeRequest {
    levelId: string;
    levelObjects: readonly LevelObject[];
    settings: BakedLightingSettings;
}

export interface LightBakeJob {
    readonly request: LightBakeRequest;
    /** Set once a runner has taken it. */
    started: boolean;
}

export interface LightBakeStatus {
    /** The level being baked, or null when none is. */
    levelId: string | null;
    progress: LightBakeProgress;
}

export class LightBakeCancelled extends Error {
    constructor() {
        super('The light bake was cancelled.');
        this.name = 'LightBakeCancelled';
    }
}

interface Pending {
    job: LightBakeJob;
    resolve: (result: LightBakeResult) => void;
    reject: (error: unknown) => void;
}

const IDLE: LightBakeStatus = { levelId: null, progress: { fraction: 0, bounce: 0 } };

let pending: Pending | null = null;
let status = IDLE;
const listeners = new Set<() => void>();

const publish = (next: LightBakeStatus): void => {
    status = next;
    for (const listener of listeners) listener();
};

const settle = (job: LightBakeJob): Pending | null => {
    if (pending?.job !== job) return null;
    const settled = pending;
    pending = null;
    publish(IDLE);
    return settled;
};

export const lightBakeJobs = {
    /** Starts a bake; rejects when one is already running. */
    start(request: LightBakeRequest): Promise<LightBakeResult> {
        if (pending) return Promise.reject(new Error('A light bake is already running.'));
        return new Promise<LightBakeResult>((resolve, reject) => {
            pending = { job: { request, started: false }, resolve, reject };
            publish({ levelId: request.levelId, progress: { fraction: 0, bounce: 0 } });
        });
    },
    cancel(): void {
        if (pending) settle(pending.job)?.reject(new LightBakeCancelled());
    },
    /** The bake a runner should work on, if any. */
    current(): LightBakeJob | null {
        return pending?.job ?? null;
    },
    report(job: LightBakeJob, progress: LightBakeProgress): void {
        if (pending?.job === job) publish({ levelId: job.request.levelId, progress });
    },
    finish(job: LightBakeJob, result: LightBakeResult): void {
        settle(job)?.resolve(result);
    },
    fail(job: LightBakeJob, error: unknown): void {
        settle(job)?.reject(error);
    },
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    },
    getSnapshot(): LightBakeStatus {
        return status;
    },
};
