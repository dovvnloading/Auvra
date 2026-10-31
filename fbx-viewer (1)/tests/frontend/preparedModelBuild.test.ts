import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeHost } from '../../host/fakeHost';
import { GAME_SETTINGS_DOCUMENT_ID } from '../../runtime/types';
import { PREPARED_MODEL_VERSION } from '../../utils/preparedModels/format';
import { preparedModelKey, preparedModelSources, prepareModelsForBuild, unpreparedNotice } from '../../utils/preparedModels/buildPreparation';
import { projectService } from '../../utils/projectService';

vi.mock('../../utils/projectService', () => ({
  projectService: {
    getSnapshotAll: vi.fn(),
    queryPreparedModels: vi.fn(),
    resolveAsset: vi.fn(),
    uploadPreparedModel: vi.fn(),
  },
}));

const service = vi.mocked(projectService);
const heroId = 'a'.repeat(64);
const swordId = 'b'.repeat(64);
const walkId = 'c'.repeat(64);

const stubProject = (domains: Record<string, unknown[]>): void => {
  service.getSnapshotAll.mockImplementation(async (domain) => ({ revision: 1, domains: { [domain as string]: domains[domain as string] ?? [] } }));
};

/** Stands in for the worker that prepares a model; a file named in `failing` fails. */
const stubWorkers = (replies: Array<{ type: string; glb?: ArrayBuffer; message?: string; reason?: string }>): unknown[] => {
  const requests: unknown[] = [];
  class StubWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    postMessage(request: unknown): void {
      requests.push(request);
      const reply = replies.shift() ?? { type: 'complete', glb: new ArrayBuffer(4) };
      queueMicrotask(() => this.onmessage?.({ data: reply }));
    }
    terminate(): void { /* nothing runs */ }
  }
  vi.stubGlobal('Worker', StubWorker);
  return requests;
};

beforeEach(() => {
  service.queryPreparedModels.mockResolvedValue([]);
  service.resolveAsset.mockImplementation(async (assetId) => `https://assets.auvra.local/${assetId}`);
  service.uploadPreparedModel.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'Content-Type': 'model/gltf-binary' }),
    arrayBuffer: async () => new ArrayBuffer(4),
  })));
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('which files a build prepares', () => {
  it('prepares each file once, and as a model when it is used as a model at all', () => {
    expect(preparedModelSources({
      models: [
        { id: 'hero', name: 'Hero.glb', assetId: heroId, category: 'Character' },
        { id: 'clips', name: 'Clips.glb', assetId: walkId, category: 'Animation' },
        { id: 'broken', name: 'Broken.glb', assetId: 'not-an-asset' },
      ],
      attachments: [{ id: 'sword', name: 'Sword.glb', assetId: swordId }],
      animations: [{ id: 'walk', name: 'Walk.glb', assetId: walkId, modelId: 'hero' }, { id: 'same', name: 'Hero.glb', assetId: heroId, modelId: 'hero' }],
    })).toEqual([
      { assetId: heroId, kind: 'model', name: 'Hero.glb' },
      { assetId: walkId, kind: 'animation', name: 'Clips.glb' },
      { assetId: swordId, kind: 'model', name: 'Sword.glb' },
    ]);
  });
});

describe('prepared model keys', () => {
  it('change with what is baked, and with nothing else', async () => {
    const model = { assetId: heroId, kind: 'model' as const };
    const key = await preparedModelKey(model, true, true);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await preparedModelKey(model, true, true)).toBe(key);
    const others = await Promise.all([
      preparedModelKey({ ...model, assetId: swordId }, true, true),
      preparedModelKey({ ...model, kind: 'animation' }, true, true),
      preparedModelKey(model, false, true),
      preparedModelKey(model, true, false),
    ]);
    expect(new Set([key, ...others]).size).toBe(5);
  });
});

describe('preparing a project for a build', () => {
  it('prepares what the host does not hold and asks the build to use everything it holds', async () => {
    stubProject({
      models: [{ id: 'hero', name: 'Hero.glb', assetId: heroId }, { id: 'clips', name: 'Clips.glb', assetId: walkId, category: 'Animation' }],
      attachments: [{ id: 'sword', name: 'Sword.glb', assetId: swordId }],
    });
    const heldKey = await preparedModelKey({ assetId: swordId, kind: 'model' }, true, true);
    service.queryPreparedModels.mockResolvedValue([heldKey]);
    const requests = stubWorkers([]);
    const result = await prepareModelsForBuild();

    expect(service.resolveAsset.mock.calls.map(([assetId]) => assetId)).toEqual([heroId, walkId]);
    const heroKey = await preparedModelKey({ assetId: heroId, kind: 'model' }, true, true);
    const clipsKey = await preparedModelKey({ assetId: walkId, kind: 'animation' }, true, true);
    expect(service.uploadPreparedModel.mock.calls.map(([key]) => key)).toEqual([heroKey, clipsKey]);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ format: 'glb', options: { kind: 'animation', sourceFormat: 'glb', textureCompression: true, meshLod: true } });
    expect(result.unprepared).toEqual([]);
    expect(result.prepared).toEqual({
      version: PREPARED_MODEL_VERSION,
      textures: 'bc',
      models: [{ source: heroId, asset: heroKey }, { source: walkId, asset: clipsKey }, { source: swordId, asset: heldKey }],
    });
  });

  it('follows the game settings into the keys and the manifest', async () => {
    stubProject({
      metadata: [{ id: GAME_SETTINGS_DOCUMENT_ID, settings: { quality: { textureCompression: false, meshLod: false } } }],
      models: [{ id: 'hero', name: 'Hero.glb', assetId: heroId }],
    });
    const requests = stubWorkers([]);
    const result = await prepareModelsForBuild();
    expect(requests[0]).toMatchObject({ options: { textureCompression: false, meshLod: false } });
    expect(result.prepared).toMatchObject({
      textures: 'none',
      models: [{ source: heroId, asset: await preparedModelKey({ assetId: heroId, kind: 'model' }, false, false) }],
    });
  });

  it('leaves a model it cannot prepare to its source, reports it, and carries on', async () => {
    stubProject({
      models: [{ id: 'one', name: 'Draco.glb', assetId: heroId }, { id: 'two', name: 'Broken.glb', assetId: swordId }, { id: 'three', name: 'Fine.glb', assetId: walkId }],
    });
    stubWorkers([{ type: 'unpreparable', reason: 'Its geometry is compressed.' }, { type: 'error', message: 'no' }]);
    const result = await prepareModelsForBuild();
    expect(result.unprepared).toEqual(['Draco.glb', 'Broken.glb']);
    expect(result.prepared?.models.map((model) => model.source)).toEqual([walkId]);
    // Nothing was kept of the failures, so the next build tries them again.
    expect(service.uploadPreparedModel).toHaveBeenCalledTimes(1);
  });

  it('never fails a build: a host that refuses the query leaves the game its sources', async () => {
    stubProject({ models: [{ id: 'hero', name: 'Hero.glb', assetId: heroId }] });
    service.queryPreparedModels.mockRejectedValue(new Error('The host cannot do this'));
    await expect(prepareModelsForBuild()).resolves.toEqual({ unprepared: ['every model'] });
  });

  it('has nothing to send for a project without models', async () => {
    stubProject({});
    await expect(prepareModelsForBuild()).resolves.toEqual({ unprepared: [] });
    expect(service.queryPreparedModels).not.toHaveBeenCalled();
  });

  it('stops when the build is cancelled', async () => {
    stubProject({ models: [{ id: 'hero', name: 'Hero.glb', assetId: heroId }] });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('Stopped.', 'AbortError'); }));
    await expect(prepareModelsForBuild()).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('telling the user what stayed unprepared', () => {
  const prepared = { version: PREPARED_MODEL_VERSION, textures: 'bc' as const, models: [{ source: heroId, asset: 'e'.repeat(64) }] };

  it('says nothing when every model shipped prepared', () => {
    expect(unpreparedNotice({ prepared, unprepared: [] }, { preparedModels: 1 })).toBeNull();
    expect(unpreparedNotice({ unprepared: [] }, undefined)).toBeNull();
  });

  it('names what preparation gave up on, and counts what the build could not use', () => {
    expect(unpreparedNotice({ prepared, unprepared: ['Draco.glb'] }, { preparedModels: 1 })).toContain('Draco.glb');
    expect(unpreparedNotice({ prepared, unprepared: [] }, { preparedModels: 0 })).toContain('1 more the build could not use');
    const many = unpreparedNotice({ unprepared: ['a', 'b', 'c', 'd', 'e'] }, undefined);
    expect(many).toContain('a, b, c and 2 more');
  });
});

describe('the fake host', () => {
  it('holds a prepared model once it is uploaded, read-only project or not, and leaves the revision alone', async () => {
    const host = new FakeHost();
    const request = { protocol: 'auvra.host/1' as const, type: 'request' as const, session: host.session };
    let revision = host.currentRevision;
    const send = async (id: string, method: 'project.open' | 'asset.queryPrepared' | 'asset.beginPreparedUpload', payload: Record<string, unknown>) => {
      const reply = await host.request({ ...request, id, revision, method, payload });
      if (!reply.ok) throw new Error(reply.error.message);
      revision = reply.revision;
      return reply.result as Record<string, any>;
    };
    const opened = await send('open', 'project.open', { projectHandle: 'readonly' });
    const key = 'e'.repeat(64);
    const projectId = opened.projectId as string;
    expect((await send('query', 'asset.queryPrepared', { projectId, keys: [key] })).preparedKeys).toEqual([]);
    const before = revision;
    const ticket = await send('begin', 'asset.beginPreparedUpload', { projectId, key, size: 3 });
    expect(revision).toBe(before);
    await host.requestAsset({ method: 'PUT', url: ticket.url, origin: 'https://assets.auvra.local', mime: 'model/gltf-binary', body: new Uint8Array([1, 2, 3]) });
    expect((await send('query-again', 'asset.queryPrepared', { projectId, keys: [key] })).preparedKeys).toEqual([key]);
  });
});
