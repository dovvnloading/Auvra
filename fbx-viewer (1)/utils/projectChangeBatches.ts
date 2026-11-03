import type { ProjectChange } from './projectService';

/** Roughly what fits in one host message, whose limit is 256 KiB, leaving room for its envelope. */
const MAX_CHANGE_BATCH_BYTES = 180 * 1024;

/** Splits changes, in order, into batches that each fit one host message; a change too big for that goes alone. */
export const changeBatches = (changes: readonly ProjectChange[]): ProjectChange[][] => {
    const batches: ProjectChange[][] = [];
    let batch: ProjectChange[] = [];
    let bytes = 0;
    for (const change of changes) {
        const size = JSON.stringify(change).length;
        if (batch.length && bytes + size > MAX_CHANGE_BATCH_BYTES) {
            batches.push(batch);
            batch = [];
            bytes = 0;
        }
        batch.push(change);
        bytes += size;
    }
    if (batch.length) batches.push(batch);
    return batches;
};
