import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LevelData, LevelObject, TerrainData } from '../../types';
import type { EditorSessionLease } from '../../utils/editorSession';

const mocks = vi.hoisted(() => {
  // Legacy IndexedDB is opened (read-only) when utils/db.ts is imported.
  (globalThis as { indexedDB?: unknown }).indexedDB = { open: () => ({}) };
  return {
    calls: [] as string[],
    status: {
      projectId: 'project-a' as string | null, name: 'Project', revision: 1, dirty: false, readOnly: false,
      busy: false, progress: null, recoveryAvailable: false, recoveryPoints: [], recentProjects: [],
    },
    snapshotObjects: [] as Array<Record<string, unknown>>,
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
    save: vi.fn(),
    close: vi.fn(),
    resolveAsset: vi.fn(),
    uploadAsset: vi.fn(),
  },
}));

vi.mock('../../context/NotificationContext', () => ({
  useNotification: () => ({ addNotification: mocks.addNotification }),
}));

vi.mock('../../context/OperationContext', () => ({
  useOperationActions: () => ({
    startOperation: () => ({
      id: 'operation', traceId: 'trace', spanId: 'span', signal: new AbortController().signal,
      update: () => undefined, lockCancellation: () => undefined, finish: () => undefined,
    }),
    cancelOperation: () => undefined,
  }),
}));

import { dbOperations } from '../../utils/db';
import { projectService } from '../../utils/projectService';
import { editorSession } from '../../utils/editorSession';
import { useLevelManager } from '../../hooks/useLevelManager';
import { useProjectManager } from '../../hooks/useProjectManager';
import { encodeTerrainHeightfield, TERRAIN_HEIGHTFIELD_HEADER_BYTES, TERRAIN_HEIGHTFIELD_MIME } from '../../utils/terrainHeightfieldCodec';
import { resolveTerrainHeightfield } from '../../utils/terrainHeightfield';

const SNAPSHOT_PAGE_LIMIT = 192 * 1024;
const ASSET_ID = 'c'.repeat(64);

const level = (id: string): LevelData => ({ id, name: id, createdAt: 0, blueprint: { nodes: [], connections: [], variables: [] } });
const spawn = (id: string, levelId = 'level-a'): LevelObject => ({
  id, levelId, modelId: '', name: id, type: 'spawn_point', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
});
const terrain = (terrainData: TerrainData): LevelObject => ({
  id: 'terrain', levelId: 'level-a', modelId: '', name: 'Terrain', type: 'terrain',
  position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], terrainData,
});

/** Mirrors the host: a write needs the exact current revision and advances it. */
const hostWrite = (label: string) => async (_id: string, _value: unknown, lease?: EditorSessionLease) => {
  editorSession.requireWritable(lease, projectService.getStatus());
  mocks.calls.push(label);
  mocks.status.revision += 1;
  editorSession.advanceRevision(mocks.status.projectId, mocks.status.revision);
};

const useEditor = () => {
  const levels = useLevelManager([]);
  const project = useProjectManager({
    setIsLoading: () => undefined,
    cameraState: { position: [4, 4, 8], target: [0, 1, 0] },
    setCameraState: () => undefined,
    selectedModelId: null,
    selectedBlueprintId: null,
    selectModel: () => undefined,
    selectBlueprint: () => undefined,
    restoreSession: async () => undefined,
    resetScene: async () => undefined,
    getCurrentLevelId: levels.getCurrentLevelId,
    flushPendingLevelEdits: levels.flushPendingLevelEdits,
  });
  return { levels, project };
};

const renderEditor = (objects: LevelObject[] = [spawn('obj-1'), spawn('obj-2'), spawn('obj-b', 'level-b')]) => {
  const transition = editorSession.beginTransition();
  editorSession.complete(transition, 'project-a', 'level-a', mocks.status.revision);
  const hook = renderHook(() => useEditor());
  act(() => hook.result.current.levels.hydrateProjectState([level('level-a'), level('level-b')], objects, 'level-a'));
  return hook;
};

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.snapshotObjects = [];
  mocks.status.projectId = 'project-a';
  mocks.status.revision = 1;
  mocks.addNotification.mockReset();
  vi.mocked(dbOperations.updateLevelObject).mockImplementation((id, updates, lease) => hostWrite(`update:${id}`)(id, updates, lease));
  vi.mocked(dbOperations.deleteLevelObject).mockImplementation((id, lease) => hostWrite(`delete:${id}`)(id, undefined, lease));
  // Legacy browser storage is only read once no native project is open.
  vi.mocked(dbOperations.getLevelObjects).mockResolvedValue([]);
  vi.mocked(dbOperations.getAllLevels).mockResolvedValue([]);
  vi.mocked(dbOperations.getAllNativeLevelObjects).mockImplementation(async () => {
    mocks.calls.push('read-objects');
    return [spawn('obj-1'), spawn('obj-2'), spawn('obj-b', 'level-b')];
  });
  vi.mocked(projectService.refreshStatus).mockResolvedValue({ ...mocks.status });
  vi.mocked(projectService.applyChanges).mockImplementation(async (changes) => {
    mocks.calls.push('applyChanges');
    mocks.status.revision += 1;
    editorSession.advanceRevision(mocks.status.projectId, mocks.status.revision);
    return { revision: mocks.status.revision, changes } as never;
  });
  vi.mocked(projectService.getSnapshotAll).mockImplementation(async () => ({
    revision: mocks.status.revision, domains: { objects: mocks.snapshotObjects },
  }));
  vi.mocked(projectService.save).mockImplementation(async () => { mocks.calls.push('save'); return null; });
  vi.mocked(projectService.close).mockImplementation(async () => { mocks.calls.push('close'); mocks.status.projectId = null; });
  vi.mocked(projectService.uploadAsset).mockResolvedValue(ASSET_ID);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('pending level edits', () => {
  it('are written before an immediate save', async () => {
    const { result } = renderEditor();
    act(() => result.current.levels.updateLevelObject('obj-1', { position: [5, 0, 0] }));
    await act(() => result.current.project.saveProject());
    expect(mocks.calls).toEqual(['update:obj-1', 'applyChanges', 'save']);
    expect(dbOperations.updateLevelObject).toHaveBeenCalledWith('obj-1', { position: [5, 0, 0] }, expect.objectContaining({ projectId: 'project-a', levelId: 'level-a' }));
  });

  it('are written into the closing project before it closes', async () => {
    const { result } = renderEditor();
    act(() => result.current.levels.updateLevelObject('obj-1', { name: 'Renamed' }));
    await act(() => result.current.project.closeProject());
    expect(mocks.calls).toEqual(['update:obj-1', 'close']);
    expect(editorSession.getSnapshot().phase).toBe('closed');
  });

  it('are written into the current level before switching levels', async () => {
    const { result } = renderEditor();
    act(() => result.current.levels.updateLevelObject('obj-1', { position: [1, 2, 3] }));
    await act(() => result.current.levels.loadLevel('level-b'));
    expect(mocks.calls).toEqual(['update:obj-1', 'read-objects']);
    expect(result.current.levels.currentLevelId).toBe('level-b');
    expect(mocks.addNotification).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('are written when the editor unmounts', async () => {
    const { result, unmount } = renderEditor();
    act(() => result.current.levels.updateLevelObject('obj-1', { position: [7, 0, 0] }));
    unmount();
    await waitFor(() => expect(mocks.calls).toEqual(['update:obj-1']));
  });

  it('persist every object edited in one debounce window', async () => {
    vi.useFakeTimers();
    const { result } = renderEditor();
    act(() => {
      result.current.levels.updateLevelObject('obj-1', { position: [1, 0, 0] });
      result.current.levels.updateLevelObject('obj-2', { position: [2, 0, 0] });
    });
    expect(mocks.calls).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(mocks.calls).toEqual(['update:obj-1', 'update:obj-2']);
  });

  it('report a failed write and keep the edit for a retry instead of reverting it', async () => {
    vi.useFakeTimers();
    vi.mocked(dbOperations.updateLevelObject).mockRejectedValueOnce(new Error('host unavailable'));
    const { result } = renderEditor();
    act(() => result.current.levels.updateLevelObject('obj-1', { position: [5, 0, 0] }));
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(mocks.addNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: expect.stringMatching(/Level edits could not be saved: host unavailable/),
    }));
    expect(result.current.levels.levelObjects.find((object) => object.id === 'obj-1')?.position).toEqual([5, 0, 0]);
    vi.useRealTimers();
    await act(() => result.current.project.saveProject());
    expect(mocks.calls).toEqual(['update:obj-1', 'applyChanges', 'save']);
    expect(dbOperations.updateLevelObject).toHaveBeenLastCalledWith('obj-1', { position: [5, 0, 0] }, expect.anything());
  });

  it('cancel a save while they cannot be written', async () => {
    vi.mocked(dbOperations.updateLevelObject).mockRejectedValue(new Error('host unavailable'));
    const { result } = renderEditor();
    act(() => result.current.levels.updateLevelObject('obj-1', { position: [5, 0, 0] }));
    await act(async () => {
      await expect(result.current.project.saveProject()).rejects.toThrow(/Level edits could not be saved/);
    });
    expect(projectService.save).not.toHaveBeenCalled();
    expect(mocks.addNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringMatching(/host unavailable/) }));
    await act(async () => {
      await expect(result.current.project.closeProject()).rejects.toThrow(/Level edits could not be saved/);
    });
    expect(projectService.close).not.toHaveBeenCalled();
    expect(editorSession.getSnapshot().phase).toBe('ready');
  });

  it('are superseded when their object is deleted', async () => {
    vi.useFakeTimers();
    const { result } = renderEditor();
    act(() => result.current.levels.updateLevelObject('obj-1', { position: [5, 0, 0] }));
    await act(() => result.current.levels.removeLevelObject('obj-1'));
    // A partial edit written after the delete would recreate a broken document.
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(mocks.calls).toEqual(['delete:obj-1']);
    expect(mocks.addNotification).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});

describe('terrain heightfields', () => {
  const heightfield = { assetId: ASSET_ID, encoding: 'float32le' as const, columns: 3, rows: 3 };
  const samples = [0, 1, 2, 3, 4, 5, 6, 7, 8];

  it('resolve into in-memory heights when the level loads, and block sculpting until then', async () => {
    let release: (value: unknown) => void = () => undefined;
    const download = new Promise((resolve) => { release = resolve; });
    vi.mocked(projectService.resolveAsset).mockResolvedValue('https://assets.auvra.local/v1/get/token');
    vi.stubGlobal('fetch', vi.fn(async () => {
      await download;
      return { ok: true, status: 200, arrayBuffer: async () => encodeTerrainHeightfield(samples, 3, 3).buffer };
    }));
    const { result } = renderEditor([terrain({ resolution: 2, width: 10, depth: 10, heightfield })]);

    act(() => result.current.levels.updateLevelObject('terrain', { terrainData: { resolution: 2, width: 10, depth: 10, heightfield, heights: new Array(9).fill(0) } }));
    expect(mocks.addNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringMatching(/still loading/) }));
    expect(result.current.levels.levelObjects[0].terrainData?.heights).toBeUndefined();

    release(undefined);
    await waitFor(() => expect(result.current.levels.levelObjects[0].terrainData?.heights).toEqual(samples));
    expect(result.current.levels.levelObjects[0].terrainData?.heightfield).toEqual(heightfield);
  });

  it('commit a sculpted 513x513 terrain as an asset reference far below the snapshot page limit', async () => {
    const { dbOperations: realDb } = await vi.importActual<typeof import('../../utils/db')>('../../utils/db');
    const resolution = 512;
    const heights = Array.from({ length: (resolution + 1) ** 2 }, (_, index) => Math.sin(index) * 25.123456789);
    // The stored document is still the legacy inline form; the next terrain commit migrates it.
    mocks.snapshotObjects = [{ ...terrain({ resolution, width: 100, depth: 100, heights: heights.map(() => 0) }) }];
    await realDb.updateLevelObject('terrain', { terrainData: { resolution, width: 100, depth: 100, heights, textureId: 'texture' } });

    expect(projectService.uploadAsset).toHaveBeenCalledTimes(1);
    const file = vi.mocked(projectService.uploadAsset).mock.calls[0][0];
    expect(file.type).toBe(TERRAIN_HEIGHTFIELD_MIME);
    expect(file.size).toBe(TERRAIN_HEIGHTFIELD_HEADER_BYTES + heights.length * 4);
    const [[changes]] = vi.mocked(projectService.applyChanges).mock.calls;
    const document = changes[0].value as LevelObject;
    expect(document.terrainData).toEqual({
      resolution, width: 100, depth: 100, textureId: 'texture',
      heightfield: { assetId: ASSET_ID, encoding: 'float32le', columns: 513, rows: 513 },
    });
    const size = new TextEncoder().encode(JSON.stringify(document)).byteLength;
    expect(size).toBeLessThan(2 * 1024);
    expect(size).toBeLessThan(SNAPSHOT_PAGE_LIMIT / 64);
  });

  it('does not re-upload resolved heights when other terrain fields change', async () => {
    const { dbOperations: realDb } = await vi.importActual<typeof import('../../utils/db')>('../../utils/db');
    const resolved = await resolveTerrainHeightfield(heightfield, async () => encodeTerrainHeightfield(samples, 3, 3).buffer);
    mocks.snapshotObjects = [{ ...terrain({ resolution: 2, width: 10, depth: 10, heightfield }) }];
    await realDb.updateLevelObject('terrain', { terrainData: { resolution: 2, width: 10, depth: 10, heightfield, heights: resolved, textureId: 'texture' } });
    expect(projectService.uploadAsset).not.toHaveBeenCalled();
    const [[changes]] = vi.mocked(projectService.applyChanges).mock.calls;
    expect((changes[0].value as LevelObject).terrainData).toEqual({ resolution: 2, width: 10, depth: 10, textureId: 'texture', heightfield });
  });
});
