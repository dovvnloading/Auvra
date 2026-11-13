import { afterEach, expect, it, vi } from 'vitest';

function device() {
  let lose!: () => void;
  const lost = new Promise(resolve => { lose = () => resolve({ reason: 'destroyed' }); });
  return { lost, lose, features: new Set(), addEventListener: vi.fn(), destroy: vi.fn() };
}

async function setup() {
  vi.resetModules();
  const old = device();
  const replacement = device();
  const requestDevice = vi.fn().mockResolvedValueOnce(old).mockResolvedValue(replacement);
  vi.stubGlobal('navigator', { gpu: {
    requestAdapter: async () => ({ limits: {}, features: new Set(), requestDevice }),
    getPreferredCanvasFormat: () => 'bgra8unorm',
  } });
  const api = await import('../../renderer/gpu/device');
  const first = (await api.acquireGpuCore()).core!;
  expect(first.device).toBe(old);
  return { api, old, first, replacement, requestDevice };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('a delayed loss notification leaves a replacement shared device in the cache', async () => {
  const { api, old, first, replacement, requestDevice } = await setup();
  expect(await api.releaseIdleGpuCore()).toBe(true);
  expect(old.destroy).toHaveBeenCalledOnce();
  const next = (await api.acquireGpuCore()).core!;
  expect(next.device).toBe(replacement);
  old.lose();
  await first.lost;
  expect((await api.acquireGpuCore()).core).toBe(next);
  expect(requestDevice).toHaveBeenCalledTimes(2);
});

it('the last old surface to unmount releases the idle current device after recovery', async () => {
  vi.useFakeTimers();
  const { api, first, old, replacement } = await setup();
  const closeOld = api.holdGpuCore();
  old.lose();
  await first.lost;
  expect((await api.acquireGpuCore()).core?.device).toBe(replacement);
  const closeNext = api.holdGpuCore();
  closeNext();
  expect(await api.releaseIdleGpuCore()).toBe(false);
  closeOld();
  closeOld();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(old.destroy).not.toHaveBeenCalled();
  expect(replacement.destroy).toHaveBeenCalledOnce();
});
