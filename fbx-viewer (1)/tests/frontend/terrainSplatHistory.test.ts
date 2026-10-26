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
    addNotification: vi.fn(),
  };
});

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
import { useLevelManager } from '../../hooks/useLevelManager';
import { encodeTerrainSplat } from '../../components/Environment/Terrain/terrainSplatCodec';

const COLUMNS = 3;
const STORED_ID = '9'.repeat(64);
const weights = (): number[] => Array.from({ length: COLUMNS * COLUMNS }, (_, sample) => [255 - sample * 20, sample * 20, 0, 0]).flat();
const splatmap = (assetId: string): TerrainSplatmapReference => ({ assetId, encoding: 'rgba8', columns: COLUMNS, rows: COLUMNS });
const stored: TerrainData = { resolution: 2, width: 10, depth: 10, textureLayers: [{ tiling: 16 }, { tiling: 8 }], splatmap: splatmap(STORED_ID) };

const level = (id: string): LevelData => ({ id, name: id, createdAt: 0, blueprint: { nodes: [], connections: [], variables: [] } });
const terrain = (terrainData: TerrainData): LevelObject => ({
  id: 'terrain', levelId: 'level-a', modelId: '', name: 'Terrain', type: 'terrain',
  position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], terrainData,
});

beforeEach(() => {
  mocks.status.projectId = 'project-a';
  mocks.status.revision = 1;
  mocks.addNotification.mockReset();
  vi.mocked(dbOperations.updateLevelObject).mockReset();
  vi.mocked(dbOperations.updateLevelObject).mockResolvedValue(undefined);
  vi.mocked(dbOperations.getLevelObjects).mockResolvedValue([]);
  vi.mocked(dbOperations.getAllLevels).mockResolvedValue([]);
  vi.mocked(dbOperations.getAllNativeLevelObjects).mockResolvedValue([]);
  vi.mocked(projectService.refreshStatus).mockResolvedValue({ ...mocks.status });
  vi.mocked(projectService.resolveAsset).mockResolvedValue('https://assets.auvra.local/v1/get/token');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('undoing terrain paint', () => {
  it('gives history snapshots taken while weights load the resolved weights, so undo can upload them again', async () => {
    let release: (value: unknown) => void = () => undefined;
    const download = new Promise((resolve) => { release = resolve; });
    const original = weights();
    vi.stubGlobal('fetch', vi.fn(async () => {
      await download;
      return { ok: true, status: 200, arrayBuffer: async () => encodeTerrainSplat(original, COLUMNS, COLUMNS).buffer };
    }));
    const transition = editorSession.beginTransition();
    editorSession.complete(transition, 'project-a', 'level-a', mocks.status.revision);
    const { result } = renderHook(() => useLevelManager([]));
    act(() => result.current.hydrateProjectState([level('level-a')], [terrain(stored)], 'level-a'));

    act(() => result.current.snapshotHistory());
    release(undefined);
    await waitFor(() => expect(result.current.levelObjects[0].terrainData?.splat).toEqual(original));

    const repainted = original.map((value, index) => index % 4 === 2 ? 0 : 255 - value);
    act(() => result.current.updateLevelObject('terrain', { terrainData: { ...stored, splat: repainted } }));
    await act(() => result.current.undo());
    // The paint's commit may already have discarded the original splat map;
    // undo writes the weights, which are uploaded again.
    const undone = vi.mocked(dbOperations.updateLevelObject).mock.calls.at(-1)?.[1] as LevelObject;
    expect(undone.terrainData?.splat).toEqual(original);
    expect(undone.terrainData?.splatmap).toEqual(splatmap(STORED_ID));
    expect(result.current.levelObjects[0].terrainData?.splat).toEqual(original);
  });
});
