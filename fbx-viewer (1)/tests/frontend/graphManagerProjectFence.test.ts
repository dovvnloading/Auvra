import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const status = { projectId: 'project-a' as string | null };
const applyChanges = vi.fn();

vi.mock('../../utils/projectService', () => ({
  projectService: {
    assertWritable: vi.fn(),
    getStatus: () => ({ projectId: status.projectId, revision: 1 }),
    applyChanges: (...args: unknown[]) => applyChanges(...args),
  },
}));

const { useGraphManager } = await import('../../hooks/useGraphManager');

describe('animation graph writes', () => {
  beforeEach(() => {
    status.projectId = 'project-a';
    applyChanges.mockReset();
  });

  it('drops an edit still queued when another project opens', async () => {
    let finishFirst: () => void = () => undefined;
    applyChanges.mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }));
    applyChanges.mockResolvedValue(undefined);
    const { result } = renderHook(() => useGraphManager());

    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.updateGraph('model-1', { activeStateId: 'idle' });
    });
    act(() => {
      // Queued behind the write in flight.
      second = result.current.updateGraph('model-1', { activeStateId: 'run' });
    });
    status.projectId = 'project-b';
    await act(async () => {
      finishFirst();
      await first;
      await second;
    });

    expect(applyChanges).toHaveBeenCalledTimes(1);
    expect(applyChanges.mock.calls[0][0][0].value.activeStateId).toBe('idle');
  });

  it('writes queued edits in the same project', async () => {
    let finishFirst: () => void = () => undefined;
    applyChanges.mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }));
    applyChanges.mockResolvedValue(undefined);
    const { result } = renderHook(() => useGraphManager());

    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.updateGraph('model-1', { activeStateId: 'idle' });
    });
    act(() => {
      second = result.current.updateGraph('model-1', { activeStateId: 'run' });
    });
    await act(async () => {
      finishFirst();
      await first;
      await second;
    });

    expect(applyChanges).toHaveBeenCalledTimes(2);
    expect(applyChanges.mock.calls[1][0][0].value.activeStateId).toBe('run');
  });
});
