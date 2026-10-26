import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LevelData, LevelObject, TerrainData, TerrainSplatmapReference } from '../../types';

const mocks = vi.hoisted(() => {
  // Legacy IndexedDB is opened (read-only) when utils/db.ts is imported.
  (globalThis as { indexedDB?: unknown }).indexedDB = { open: () => ({}) };
  return {
    status: {
      projectId: 'project-a' as string | null, name: 'Project', revision: 1, dirty: false, readOnly: false,
      busy: false, progress: null, recoveryAvailable: false, recoveryPoints: [], recentProjects: [],
    },
    snapshotObjects: [] as Array<Record<string, unknown>>,
    addNotification: vi.fn(),
  };
});

// The level manager writes through a mock; the persistence tests use the real
// module (vi.importActual) against the mocked project service.
vi.mock('../../utils/db', () => ({
  dbOperations: {
    updateLevelObject: vi.fn(),
    addLevelObject: vi.fn(),
    deleteLevelObject: vi.fn(),
    getAllNativeLevelObjects: vi.fn(),
    getAllLevels: vi.fn(),
    getLevelObjects: vi.fn(),
    addLevel: vi.fn(),
    deleteLevel: vi.fn(),
  },
}));

vi.mock('../../utils/projectService', () => ({
  projectService: {
    getStatus: () => ({ ...mocks.status }),
    assertWritable: () => { if (!mocks.status.projectId) throw new Error('No project is open'); },
    subscribe: (listener: (status: typeof mocks.status) => void) => { listener({ ...mocks.status }); return () => undefined; },
    refreshStatus: vi.fn(),
    applyChanges: vi.fn(),
    getSnapshotAll: vi.fn(),
    resolveAsset: vi.fn(),
    uploadAsset: vi.fn(),
  },
}));

vi.mock('../../context/NotificationContext', () => ({
  useNotification: () => ({ addNotification: mocks.addNotification }),
}));

import { dbOperations } from '../../utils/db';
import { projectService } from '../../utils/projectService';
import { editorSession } from '../../utils/editorSession';
import { emitDomainCascade } from '../../utils/domainCascade';
import { useLevelManager } from '../../hooks/useLevelManager';
import {
  createDefaultTerrainSplat,
  decodeTerrainSplat,
  encodeTerrainSplat,
  TERRAIN_SPLATMAP_HEADER_BYTES,
  TERRAIN_SPLATMAP_MIME,
} from '../../components/Environment/Terrain/terrainSplatCodec';

const ASSET_ID = 'c'.repeat(64);
const STORED_ID = 'e'.repeat(64);
const COLUMNS = 3;

// A 2x2-cell terrain (3x3 samples) painted from layer 0 towards layer 1.
const painted = (): number[] => Array.from({ length: COLUMNS * COLUMNS }, (_, sample) => [255 - sample * 20, sample * 20, 0, 0]).flat();
const splatmap = (assetId: string): TerrainSplatmapReference => ({ assetId, encoding: 'rgba8', columns: COLUMNS, rows: COLUMNS });
const baseTerrain = { resolution: 2, width: 10, depth: 10 };

const level = (id: string): LevelData => ({ id, name: id, createdAt: 0, blueprint: { nodes: [], connections: [], variables: [] } });
const terrain = (terrainData: TerrainData, id = 'terrain'): LevelObject => ({
  id, levelId: 'level-a', modelId: '', name: 'Terrain', type: 'terrain',
  position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], terrainData,
});

const renderLevels = (objects: LevelObject[]) => {
  const transition = editorSession.beginTransition();
  editorSession.complete(transition, 'project-a', 'level-a', mocks.status.revision);
  const hook = renderHook(() => useLevelManager([]));
  act(() => hook.result.current.hydrateProjectState([level('level-a')], objects, 'level-a'));
  return hook;
};

const committedChanges = () => vi.mocked(projectService.applyChanges).mock.calls.map(([changes]) => changes);

const serveSplatmap = (weights: number[], gate?: Promise<unknown>) => {
  vi.mocked(projectService.resolveAsset).mockResolvedValue('https://assets.auvra.local/v1/get/token');
  vi.stubGlobal('fetch', vi.fn(async () => {
    await gate;
    return { ok: true, status: 200, arrayBuffer: async () => encodeTerrainSplat(weights, COLUMNS, COLUMNS).buffer };
  }));
};

beforeEach(() => {
  mocks.snapshotObjects = [];
  mocks.status.projectId = 'project-a';
  mocks.status.revision = 1;
  mocks.addNotification.mockReset();
  vi.mocked(dbOperations.updateLevelObject).mockResolvedValue(undefined);
  vi.mocked(dbOperations.getLevelObjects).mockResolvedValue([]);
  vi.mocked(dbOperations.getAllLevels).mockResolvedValue([]);
  vi.mocked(dbOperations.getAllNativeLevelObjects).mockResolvedValue([]);
  vi.mocked(projectService.refreshStatus).mockResolvedValue({ ...mocks.status });
  vi.mocked(projectService.applyChanges).mockImplementation(async (changes) => {
    mocks.status.revision += 1;
    editorSession.advanceRevision(mocks.status.projectId, mocks.status.revision);
    return { revision: mocks.status.revision, changes } as never;
  });
  vi.mocked(projectService.getSnapshotAll).mockImplementation(async () => ({
    revision: mocks.status.revision, domains: { objects: mocks.snapshotObjects },
  }) as never);
  vi.mocked(projectService.uploadAsset).mockResolvedValue(ASSET_ID);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('saving painted terrain', () => {
  it('externalizes the weights to a splat map asset and stores only its reference', async () => {
    const { dbOperations: realDb } = await vi.importActual<typeof import('../../utils/db')>('../../utils/db');
    const splat = painted();
    mocks.snapshotObjects = [{ ...terrain(baseTerrain) }];
    await realDb.updateLevelObject('terrain', { terrainData: {
      ...baseTerrain, textureLayers: [{ textureId: 'grass', tiling: 8 }, { tiling: -1 }], splat,
    } });

    expect(projectService.uploadAsset).toHaveBeenCalledTimes(1);
    const file = vi.mocked(projectService.uploadAsset).mock.calls[0][0];
    expect(file.type).toBe(TERRAIN_SPLATMAP_MIME);
    expect(file.size).toBe(TERRAIN_SPLATMAP_HEADER_BYTES + splat.length);
    expect(decodeTerrainSplat(new Uint8Array(await file.arrayBuffer()), splatmap(ASSET_ID))).toEqual(splat);
    const [[change]] = committedChanges();
    const document = change.value as LevelObject;
    expect(document.terrainData).toEqual({
      ...baseTerrain,
      textureLayers: [{ textureId: 'grass', tiling: 8 }, { tiling: 16 }],
      splatmap: splatmap(ASSET_ID),
    });
    expect(document.terrainData).not.toHaveProperty('splat');
  });

  it('does not upload committed weights again while the stored document still references them', async () => {
    const { dbOperations: realDb } = await vi.importActual<typeof import('../../utils/db')>('../../utils/db');
    const splat = painted();
    mocks.snapshotObjects = [{ ...terrain(baseTerrain) }];
    await realDb.updateLevelObject('terrain', { terrainData: { ...baseTerrain, textureLayers: [{ tiling: 4 }], splat } });
    mocks.snapshotObjects = [{ ...terrain({ ...baseTerrain, textureLayers: [{ tiling: 4 }], splatmap: splatmap(ASSET_ID) }) }];

    await realDb.updateLevelObject('terrain', { terrainData: { ...baseTerrain, textureLayers: [{ tiling: 6 }], splat } });

    expect(projectService.uploadAsset).toHaveBeenCalledTimes(1);
    const document = committedChanges()[1][0].value as LevelObject;
    expect(document.terrainData).toEqual({ ...baseTerrain, textureLayers: [{ tiling: 6 }], splatmap: splatmap(ASSET_ID) });
  });

  it('keeps an unresolved splat map reference as it is', async () => {
    const { dbOperations: realDb } = await vi.importActual<typeof import('../../utils/db')>('../../utils/db');
    mocks.snapshotObjects = [{ ...terrain({ ...baseTerrain, splatmap: splatmap(STORED_ID) }) }];
    await realDb.updateLevelObject('terrain', { terrainData: { ...baseTerrain, textureLayers: [{ tiling: 2 }], splatmap: splatmap(STORED_ID) } });

    expect(projectService.uploadAsset).not.toHaveBeenCalled();
    const [[change]] = committedChanges();
    expect((change.value as LevelObject).terrainData).toEqual({ ...baseTerrain, textureLayers: [{ tiling: 2 }], splatmap: splatmap(STORED_ID) });
  });
});

describe('loading painted terrain', () => {
  it('resolves the splat map into in-memory weights, and blocks painting until then', async () => {
    let release: (value: unknown) => void = () => undefined;
    const weights = painted();
    serveSplatmap(weights, new Promise((resolve) => { release = resolve; }));
    const stored = { ...baseTerrain, textureLayers: [{ textureId: 'grass', tiling: 8 }, { tiling: 16 }], splatmap: splatmap(STORED_ID) };
    const { result } = renderLevels([terrain(stored)]);

    act(() => result.current.updateLevelObject('terrain', { terrainData: { ...stored, splat: Array.from(createDefaultTerrainSplat(COLUMNS, COLUMNS)) } }));
    expect(mocks.addNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringMatching(/paint is still loading/) }));
    expect(result.current.levelObjects[0].terrainData?.splat).toBeUndefined();

    release(undefined);
    await waitFor(() => expect(result.current.levelObjects[0].terrainData?.splat).toEqual(weights));
    expect(result.current.levelObjects[0].terrainData?.splatmap).toEqual(splatmap(STORED_ID));
    expect(projectService.resolveAsset).toHaveBeenCalledWith(STORED_ID);
    // Loading the weights is not an edit.
    await act(() => result.current.flushPendingLevelEdits());
    expect(dbOperations.updateLevelObject).not.toHaveBeenCalled();
  });

  it('reports a splat map that cannot be loaded and keeps painting disabled', async () => {
    vi.mocked(projectService.resolveAsset).mockResolvedValue('https://assets.auvra.local/v1/get/token');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) })));
    const stored = { ...baseTerrain, textureLayers: [{ tiling: 16 }], splatmap: splatmap('f'.repeat(64)) };
    const { result } = renderLevels([terrain(stored)]);

    await waitFor(() => expect(mocks.addNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: expect.stringMatching(/Terrain paint could not be loaded .*painting is disabled/),
    })));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.current.levelObjects[0].terrainData?.splat).toBeUndefined();
  });
});

describe('deleting a texture used by a terrain layer', () => {
  it('strips the layer reference in the same batch that removes the texture', async () => {
    const { dbOperations: realDb } = await vi.importActual<typeof import('../../utils/db')>('../../utils/db');
    const both = terrain({ ...baseTerrain, textureId: 'rock', textureLayers: [{ textureId: 'rock', tiling: 4 }, { textureId: 'grass', tiling: 8 }], splatmap: splatmap(STORED_ID) }, 'both');
    const layerOnly = terrain({ ...baseTerrain, textureId: 'grass', textureLayers: [{ textureId: 'grass', tiling: 2 }, { textureId: 'rock', tiling: 3 }] }, 'layer-only');
    const unrelated = terrain({ ...baseTerrain, textureLayers: [{ textureId: 'grass', tiling: 2 }] }, 'unrelated');
    vi.mocked(projectService.getSnapshotAll).mockResolvedValue({
      revision: 1, domains: { textures: [{ id: 'rock' }], objects: [both, layerOnly, unrelated] },
    } as never);

    await realDb.deleteTexture('rock');

    expect(committedChanges()).toEqual([[
      { domain: 'textures', operation: 'remove', id: 'rock' },
      { domain: 'objects', operation: 'upsert', id: 'both', value: { ...both, terrainData: {
        ...baseTerrain, textureLayers: [{ tiling: 4 }, { textureId: 'grass', tiling: 8 }], splatmap: splatmap(STORED_ID),
      } } },
      { domain: 'objects', operation: 'upsert', id: 'layer-only', value: { ...layerOnly, terrainData: {
        ...baseTerrain, textureId: 'grass', textureLayers: [{ textureId: 'grass', tiling: 2 }, { tiling: 3 }],
      } } },
    ]]);
  });

  it('strips the layer reference from the open level and from its unwritten edits', async () => {
    const stored = { ...baseTerrain, textureLayers: [{ textureId: 'rock', tiling: 4 }, { textureId: 'grass', tiling: 8 }] };
    const { result } = renderLevels([terrain(stored)]);
    act(() => result.current.updateLevelObject('terrain', {
      terrainData: { ...stored, textureLayers: [{ textureId: 'rock', tiling: 5 }, { textureId: 'grass', tiling: 8 }] },
    }));

    act(() => emitDomainCascade({ kind: 'texture', id: 'rock', projectId: 'project-a' }));

    const expected = { ...baseTerrain, textureLayers: [{ tiling: 5 }, { textureId: 'grass', tiling: 8 }] };
    expect(result.current.levelObjects[0].terrainData).toEqual(expected);
    await act(() => result.current.flushPendingLevelEdits());
    expect(dbOperations.updateLevelObject).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dbOperations.updateLevelObject).mock.calls[0][1]).toEqual({ terrainData: expected });
  });
});
