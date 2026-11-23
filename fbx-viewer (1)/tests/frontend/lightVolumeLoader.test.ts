import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  encodeLightVolume, readBakedProbeVolume, SH_FLOATS_PER_PROBE,
} from '../../runtime/lighting/bakedLighting';
import { loadLightVolume, setLightVolumeSource } from '../../runtime/lighting/lightVolumeLoader';

const probes = readBakedProbeVolume({
  assetId: 'volume', origin: [0, 0, 0], spacing: 1,
  counts: [1, 1, 1], bakedAt: 'test', signature: 'test',
})!;

const response = () => {
  const bytes = encodeLightVolume(new Float32Array(SH_FLOATS_PER_PROBE), [1, 1, 1]);
  return new Response(bytes.buffer as ArrayBuffer);
};

afterEach(() => {
  setLightVolumeSource(null);
  vi.unstubAllGlobals();
});

describe('light-volume source ownership', () => {
  it('releases the original source and rejects a load superseded by a project switch', async () => {
    const releaseA = vi.fn();
    const releaseB = vi.fn();
    let resumeA!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resumeA = resolve; }))
      .mockImplementationOnce(async () => response());
    vi.stubGlobal('fetch', fetchMock);

    setLightVolumeSource(async () => 'blob:project-a', releaseA);
    const pendingA = loadLightVolume(probes);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    setLightVolumeSource(async () => 'blob:project-b', releaseB);
    resumeA(response());
    await expect(pendingA).rejects.toThrow(/source changed during load/);
    expect(releaseA).toHaveBeenCalledTimes(1);
    expect(releaseA).toHaveBeenCalledWith('volume');
    expect(releaseB).not.toHaveBeenCalled();

    const fromB = await loadLightVolume(probes);
    expect(fromB).toHaveLength(SH_FLOATS_PER_PROBE);
    expect(releaseB).toHaveBeenCalledTimes(1);
    expect(releaseB).toHaveBeenCalledWith('volume');
  });

  it('releases an acquired URL even when its fetch fails', async () => {
    const release = vi.fn();
    setLightVolumeSource(async () => 'blob:failure', release);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    await expect(loadLightVolume(probes)).rejects.toThrow(/download failed/);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith('volume');
  });
});
