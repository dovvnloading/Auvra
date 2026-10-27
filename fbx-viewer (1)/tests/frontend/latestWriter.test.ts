import { describe, expect, it } from 'vitest';
import { createLatestWriter } from '../../utils/latestWriter';

/** A persist call the test finishes by hand. */
const controlled = () => {
  const calls: Array<{ id: string; value: string; resolve: () => void; reject: (error: unknown) => void }> = [];
  const persist = (id: string, value: string) => new Promise<void>((resolve, reject) => { calls.push({ id, value, resolve, reject }); });
  return { calls, persist };
};

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('latest writer', () => {
  it('writes the first value, then only the newest of those that came in meanwhile', async () => {
    const { calls, persist } = controlled();
    const write = createLatestWriter(persist);
    const outcomes: string[] = [];
    write('graph', 'W').then(() => outcomes.push('W'));
    write('graph', 'Wa').then(() => outcomes.push('Wa'));
    write('graph', 'Wal').then(() => outcomes.push('Wal'));
    write('graph', 'Walk').then(() => outcomes.push('Walk'));
    expect(calls.map(call => call.value)).toEqual(['W']);

    calls[0].resolve();
    await flush();
    expect(calls.map(call => call.value)).toEqual(['W', 'Walk']);
    calls[1].resolve();
    await flush();
    expect(outcomes).toEqual(['W', 'Wa', 'Wal', 'Walk']);
  });

  it('settles every edit a failed write carried with its error, and keeps ids apart', async () => {
    const { calls, persist } = controlled();
    const write = createLatestWriter(persist);
    write('a', '1');
    const waiting = write('a', '2');
    const other = write('b', 'x');
    expect(calls.map(call => `${call.id}:${call.value}`)).toEqual(['a:1', 'b:x']);
    calls[0].resolve();
    await flush();
    calls[2].reject(new Error('refused'));
    await expect(waiting).rejects.toThrow('refused');
    calls[1].resolve();
    await expect(other).resolves.toBeUndefined();
    // Nothing is in flight now, so the next write goes straight out.
    write('a', '3');
    expect(calls.at(-1)?.value).toBe('3');
  });
});
