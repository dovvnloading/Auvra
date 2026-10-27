import { describe, expect, it, vi } from 'vitest';

// A browser that never had legacy storage: opening it asks for an upgrade, which the editor aborts.
vi.hoisted(() => {
  const request: Record<string, unknown> & { onupgradeneeded?: () => void; onerror?: (event: { preventDefault(): void }) => void } = {
    error: new DOMException('The upgrade was aborted.', 'AbortError'),
    result: undefined,
  };
  request.transaction = { abort: () => setTimeout(() => request.onerror?.({ preventDefault: () => undefined }), 0) };
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => {
      setTimeout(() => request.onupgradeneeded?.(), 0);
      return request;
    },
  };
});

import { frontendDiagnostics } from '../../diagnostics/runtime';
import { dbOperations } from '../../utils/db';

describe('legacy browser storage', () => {
  it('reads as empty, without a failure, where there never was any', async () => {
    const failure = vi.spyOn(frontendDiagnostics, 'failure');
    await expect(dbOperations.getAllModelMetadata()).resolves.toEqual([]);
    await expect(dbOperations.getAllAttachmentMetadata()).resolves.toEqual([]);
    await expect(dbOperations.getModelFiles('model')).resolves.toBeNull();
    await expect(dbOperations.getLevelObjects('level')).resolves.toEqual([]);
    expect(failure).not.toHaveBeenCalledWith('legacy_database_request_failed', expect.anything());
  });
});
