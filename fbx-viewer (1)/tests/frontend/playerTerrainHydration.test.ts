import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadGameContent } from '../../utils/projectHydration';
import { encodeTerrainHeightfield } from '../../utils/terrainHeightfieldCodec';
import { encodeTerrainSplat } from '../../components/Environment/Terrain/terrainSplatCodec';
import { frontendDiagnostics } from '../../diagnostics/runtime';

// The standalone player has no level manager to resolve terrain assets after
// a level opens, so loadGameContent resolves them when asked to.
const SAMPLES = 3; // resolution 2
const HEIGHTS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
const SPLAT = Array.from({ length: SAMPLES * SAMPLES }, (_, index) => (index % 2 === 0 ? [255, 0, 0, 0] : [55, 200, 0, 0])).flat();

const assets = new Map<string, Uint8Array>();
const fetched: string[] = [];
const resolveAssetUrl = vi.fn(async (assetId: string) => `pack://assets/${assetId}`);

const terrainObject = (id: string, terrainData: Record<string, unknown>) => ({
  id,
  levelId: 'level-1',
  modelId: '',
  name: id,
  type: 'terrain',
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  terrainData: { resolution: 2, width: 10, depth: 10, textureLayers: [{ tiling: 16 }, { tiling: 8 }], ...terrainData },
});
const heightfield = (assetId: string) => ({ assetId, encoding: 'float32le', columns: SAMPLES, rows: SAMPLES });
const splatmap = (assetId: string) => ({ assetId, encoding: 'rgba8', columns: SAMPLES, rows: SAMPLES });

const failureCodes = (spy: { mock: { calls: unknown[][] } }): unknown[] => spy.mock.calls
  .filter(([, event]) => event === 'frontend.failure')
  .map(([, , attributes]) => (attributes as { code?: unknown }).code);

beforeEach(() => {
  assets.clear();
  fetched.length = 0;
  resolveAssetUrl.mockClear();
  assets.set('hf-ground', encodeTerrainHeightfield(HEIGHTS, SAMPLES, SAMPLES));
  assets.set('sp-ground', encodeTerrainSplat(SPLAT, SAMPLES, SAMPLES));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetched.push(url);
    const bytes = assets.get(url.replace('pack://assets/', ''));
    if (!bytes) return { ok: false, status: 404, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) };
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/octet-stream' }),
      arrayBuffer: async () => bytes.slice().buffer,
    };
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('loadGameContent terrain hydration', () => {
  it('resolves terrain heights and paint into copies of the object documents', async () => {
    const ground = terrainObject('ground', { heightfield: heightfield('hf-ground'), splatmap: splatmap('sp-ground') });
    const start = { id: 'start', levelId: 'level-1', type: 'player_start' };
    const domains = { levels: [{ id: 'level-1', name: 'Main', createdAt: 1 }], objects: [ground, start] };
    const before = JSON.parse(JSON.stringify(domains));
    const progress: number[] = [];

    const loaded = await loadGameContent(domains, {
      resolveAssetUrl,
      generateThumbnails: false,
      resolveTerrains: true,
      onProgress: (value) => progress.push(value),
    });

    expect(fetched).toEqual(['pack://assets/hf-ground', 'pack://assets/sp-ground']);
    const [terrain, other] = loaded.objects;
    expect(terrain).not.toBe(ground);
    expect(terrain.terrainData?.heights).toEqual(HEIGHTS);
    expect(terrain.terrainData?.splat).toEqual(SPLAT);
    expect(terrain.terrainData?.heightfield).toEqual(heightfield('hf-ground'));
    expect(terrain.terrainData?.textureLayers).toEqual([{ tiling: 16 }, { tiling: 8 }]);
    expect(other).toBe(start);
    expect(domains).toEqual(before);
    expect(progress.at(-1)).toBe(1);
    expect(progress.slice(0, -1).every((value) => value < 1)).toBe(true);
  });

  it('returns the object documents unchanged unless asked to resolve terrains', async () => {
    const ground = terrainObject('ground', { heightfield: heightfield('hf-ground'), splatmap: splatmap('sp-ground') });
    const loaded = await loadGameContent({ objects: [ground] }, { resolveAssetUrl, generateThumbnails: false });
    expect(loaded.objects[0]).toBe(ground);
    expect(loaded.objects[0].terrainData?.heights).toBeUndefined();
    expect(resolveAssetUrl).not.toHaveBeenCalled();
    expect(fetched).toEqual([]);
  });

  it('reads a heightfield shared by several terrains once and gives each its own heights', async () => {
    const first = terrainObject('first', { heightfield: heightfield('hf-ground') });
    const second = terrainObject('second', { heightfield: heightfield('hf-ground') });
    const loaded = await loadGameContent({ objects: [first, second] }, {
      resolveAssetUrl,
      generateThumbnails: false,
      resolveTerrains: true,
    });
    expect(fetched).toEqual(['pack://assets/hf-ground']);
    expect(loaded.objects[0].terrainData?.heights).toEqual(HEIGHTS);
    expect(loaded.objects[1].terrainData?.heights).toEqual(HEIGHTS);
    expect(loaded.objects[0].terrainData?.heights).not.toBe(loaded.objects[1].terrainData?.heights);
  });

  it('still loads the game without paint when a splat map cannot be read', async () => {
    const record = vi.spyOn(frontendDiagnostics, 'record');
    const ground = terrainObject('ground', { heightfield: heightfield('hf-ground'), splatmap: splatmap('sp-missing') });
    const loaded = await loadGameContent({ objects: [ground] }, {
      resolveAssetUrl,
      generateThumbnails: false,
      resolveTerrains: true,
    });
    const terrain = loaded.objects[0];
    expect(terrain.terrainData?.heights).toEqual(HEIGHTS);
    expect(terrain.terrainData?.splat).toBeUndefined();
    expect(failureCodes(record)).toContain('terrain_splatmap_hydration_failed');
    expect(ground.terrainData).not.toHaveProperty('heights');
  });

  it('fails the load when a heightfield cannot be read', async () => {
    const record = vi.spyOn(frontendDiagnostics, 'record');
    const ground = terrainObject('ground', { heightfield: heightfield('hf-missing'), splatmap: splatmap('sp-ground') });
    await expect(loadGameContent({ objects: [ground] }, {
      resolveAssetUrl,
      generateThumbnails: false,
      resolveTerrains: true,
    })).rejects.toThrow('Project hydration failed for 1 asset');
    expect(failureCodes(record)).toContain('terrain_heightfield_hydration_failed');
  });

  it('does not read terrain assets once cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const ground = terrainObject('ground', { heightfield: heightfield('hf-ground') });
    await expect(loadGameContent({ objects: [ground] }, {
      resolveAssetUrl,
      generateThumbnails: false,
      resolveTerrains: true,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetched).toEqual([]);
  });
});
