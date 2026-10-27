/**
 * Writes whole documents one at a time per id, latest wins. While a write for an id is in flight,
 * newer values for it wait and only the newest is written next, so it carries the project revision
 * the previous write produced. Without this, quick successive edits (typing in a name field) are
 * queued with the same revision, the later ones are refused as stale, and the newest edit is lost.
 *
 * The promise `write(id, value)` returns settles with the outcome of the write that carried `value`
 * or a newer value for the same id.
 */
export const createLatestWriter = <T,>(persist: (id: string, value: T) => Promise<unknown>) => {
    interface Waiting {
        value: T;
        settle: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
    }
    const running = new Set<string>();
    const waiting = new Map<string, Waiting>();

    const start = (id: string, value: T): Promise<void> => {
        running.add(id);
        const done = persist(id, value).then(() => undefined);
        const next = () => {
            running.delete(id);
            const queued = waiting.get(id);
            if (!queued) return;
            waiting.delete(id);
            start(id, queued.value).then(
                () => queued.settle.forEach(({ resolve }) => resolve()),
                (error) => queued.settle.forEach(({ reject }) => reject(error)),
            );
        };
        done.then(next, next);
        return done;
    };

    return (id: string, value: T): Promise<void> => {
        if (!running.has(id)) return start(id, value);
        return new Promise<void>((resolve, reject) => {
            const queued = waiting.get(id);
            if (queued) {
                queued.value = value;
                queued.settle.push({ resolve, reject });
            } else {
                waiting.set(id, { value, settle: [{ resolve, reject }] });
            }
        });
    };
};
