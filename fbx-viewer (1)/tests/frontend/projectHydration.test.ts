import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadGameContent, HUD_DOCUMENT_ID } from '../../utils/projectHydration';
import { DEFAULT_GAME_SETTINGS, GAME_SETTINGS_DOCUMENT_ID } from '../../runtime/types';

// No FBX here: models and attachments go through the import worker, which the
// editor import tests cover. These cases pin the content contract the player
// relies on: what is resolved, what is passed through, and what is released.
const created: string[] = [];
const revoked: string[] = [];
const fetched: string[] = [];
const resolveAssetUrl = vi.fn(async (assetId: string) => `pack://assets/${assetId}`);

beforeEach(() => {
  created.length = 0;
  revoked.length = 0;
  fetched.length = 0;
  resolveAssetUrl.mockClear();
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: () => { const url = `blob:test/${created.length}`; created.push(url); return url; },
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: (url: string) => { revoked.push(url); },
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetched.push(url);
    if (url.includes('missing')) return { ok: false, status: 404, headers: new Headers(), blob: async () => new Blob() };
    return { ok: true, status: 200, headers: new Headers({ 'Content-Type': 'image/png' }), blob: async () => new Blob(['bytes']) };
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadGameContent', () => {
  it('resolves binary assets and passes authored documents through', async () => {
    const progress: Array<[number, string | undefined]> = [];
    const loaded = await loadGameContent({
      textures: [{ id: 'tex-1', name: 'Grass', assetId: 'asset-grass', dimensions: { width: 4, height: 4 } }],
      audio: [{ id: 'snd-1', name: 'Step', assetId: 'asset-step', type: 'audio/wav', duration: 1.5 }],
      blueprints: [{ id: 'bp-player', name: 'Player' }],
      sockets: [{ id: 'socket-1', name: 'Hand' }],
      levels: [{ id: 'level-1', name: 'Main Level', createdAt: 1 }],
      objects: [{ id: 'start', levelId: 'level-1', type: 'player_start' }],
      metadata: [{ id: 'editor-state' }, { id: GAME_SETTINGS_DOCUMENT_ID, settings: { name: 'Demo', quality: { fov: 75 } } }],
      hud: [{ id: 'other-hud', elements: [] }, { id: HUD_DOCUMENT_ID, elements: [{ id: 'health' }] }],
    }, {
      resolveAssetUrl,
      generateThumbnails: false,
      onProgress: (value, label) => progress.push([value, label]),
    });

    expect(resolveAssetUrl.mock.calls.map(([assetId]) => assetId)).toEqual(['asset-grass', 'asset-step']);
    expect(fetched).toEqual(['pack://assets/asset-grass', 'pack://assets/asset-step']);
    expect(loaded.content.textures).toEqual([{ id: 'tex-1', name: 'Grass', dimensions: { width: 4, height: 4 }, url: created[0] }]);
    expect(loaded.content.audioAssets).toEqual([{ id: 'snd-1', name: 'Step', type: 'audio/wav', duration: 1.5, url: created[1] }]);
    expect(loaded.content.models).toEqual([]);
    expect(loaded.content.attachments).toEqual([]);
    expect(loaded.content.blueprints.map((blueprint) => blueprint.id)).toEqual(['bp-player']);
    expect(loaded.content.sockets.map((socket) => socket.id)).toEqual(['socket-1']);
    expect(loaded.levels.map((level) => level.id)).toEqual(['level-1']);
    expect(loaded.objects.map((object) => object.type)).toEqual(['player_start']);
    expect(loaded.hud?.elements).toEqual([{ id: 'health' }]);
    expect(loaded.settings.name).toBe('Demo');
    expect(loaded.settings.quality).toEqual({ ...DEFAULT_GAME_SETTINGS.quality, fov: 75 });
    expect(loaded.settings.input).toEqual(DEFAULT_GAME_SETTINGS.input);
    expect(progress.at(-1)).toEqual([1, 'Project assets ready']);
    expect(progress.slice(0, -1).every(([value]) => value < 1)).toBe(true);
    expect(revoked).toEqual([]);
  });

  it('defaults settings and HUD when the project has none', async () => {
    const loaded = await loadGameContent({}, { resolveAssetUrl, generateThumbnails: false });
    expect(loaded.settings).toEqual(DEFAULT_GAME_SETTINGS);
    expect(loaded.hud).toBeNull();
    expect(loaded.content.textures).toEqual([]);
    expect(loaded.levels).toEqual([]);
  });

  it('fails as a whole and releases what it loaded when an asset fails', async () => {
    await expect(loadGameContent({
      textures: [
        { id: 'tex-1', name: 'Grass', assetId: 'asset-grass' },
        { id: 'tex-2', name: 'Gone', assetId: 'asset-missing' },
      ],
    }, { resolveAssetUrl, generateThumbnails: false })).rejects.toThrow('Project hydration failed for 1 asset');
    expect(created).toHaveLength(1);
    expect(revoked).toEqual(created);
  });

  it('does not resolve anything once cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(loadGameContent({
      textures: [{ id: 'tex-1', name: 'Grass', assetId: 'asset-grass' }],
    }, { resolveAssetUrl, generateThumbnails: false, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(resolveAssetUrl).not.toHaveBeenCalled();
  });
});
