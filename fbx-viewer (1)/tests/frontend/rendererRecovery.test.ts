import { afterEach, describe, expect, it } from 'vitest';
import { rendererCoordinator } from '../../renderer/registry';

const surfaceId = `test-recovery-${Math.random().toString(36).slice(2)}`;
const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;

afterEach(() => rendererCoordinator.unregisterSurface(surfaceId));

describe('renderer recovery budget', () => {
  it('resets consecutive attempts after restoration and remount', () => {
    rendererCoordinator.registerSurface({ id: surfaceId, role: 'reference', canvas });
    rendererCoordinator.markReady(surfaceId);
    rendererCoordinator.markContextLost(surfaceId);
    expect(rendererCoordinator.beginRecovery(surfaceId, 1)).toBe(true);
    rendererCoordinator.markContextRestoring(surfaceId);
    rendererCoordinator.markContextRestored(surfaceId);
    const snapshot = rendererCoordinator.getSnapshot(surfaceId);
    expect(Array.isArray(snapshot) ? undefined : snapshot.recoveryCount).toBe(0);
    expect(rendererCoordinator.beginRecovery(surfaceId, 1)).toBe(true);

    rendererCoordinator.unregisterSurface(surfaceId);
    rendererCoordinator.registerSurface({ id: surfaceId, role: 'reference', canvas });
    expect(rendererCoordinator.beginRecovery(surfaceId, 1)).toBe(true);
  });
});
