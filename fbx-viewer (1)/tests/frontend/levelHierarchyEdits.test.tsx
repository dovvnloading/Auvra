import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LevelData, LevelObject } from '../../types';
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
    addNotification: vi.fn(),
  };
});

vi.mock('../../utils/db', () => ({
  dbOperations: {
    updateLevelObject: vi.fn(),
    addLevelObject: vi.fn(),
    deleteLevelObject: vi.fn(),
    getAllNativeLevelObjects: vi.fn(async () => []),
    getAllLevels: vi.fn(async () => []),
    getLevelObjects: vi.fn(async () => []),
    addLevel: vi.fn(),
    deleteLevel: vi.fn(),
  },
}));

vi.mock('../../utils/projectService', () => ({
  projectService: {
    getStatus: () => ({ ...mocks.status }),
    assertWritable: () => { if (!mocks.status.projectId) throw new Error('No project is open'); },
    subscribe: (listener: (status: typeof mocks.status) => void) => { listener({ ...mocks.status }); return () => undefined; },
  },
}));

vi.mock('../../context/NotificationContext', () => ({
  useNotification: () => ({ addNotification: mocks.addNotification }),
}));

import { dbOperations } from '../../utils/db';
import { projectService } from '../../utils/projectService';
import { editorSession } from '../../utils/editorSession';
import { useLevelManager } from '../../hooks/useLevelManager';

const level = (id: string): LevelData => ({ id, name: id, createdAt: 0, blueprint: { nodes: [], connections: [], variables: [] } });
const node = (id: string, parentId: string | null = null, extra: Partial<LevelObject> = {}): LevelObject => ({
  id, levelId: 'level-a', modelId: '', name: id, type: 'spawn_point',
  position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], parentId, ...extra,
});

/** Mirrors the host: a write needs the exact current revision and advances it. */
const hostWrite = (label: string, lease?: EditorSessionLease) => {
  editorSession.requireWritable(lease, projectService.getStatus());
  mocks.calls.push(label);
  mocks.status.revision += 1;
  editorSession.advanceRevision(mocks.status.projectId, mocks.status.revision);
};

const renderLevels = (objects: LevelObject[]) => {
  const transition = editorSession.beginTransition();
  editorSession.complete(transition, 'project-a', 'level-a', mocks.status.revision);
  const hook = renderHook(() => useLevelManager([]));
  act(() => hook.result.current.hydrateProjectState([level('level-a')], objects, 'level-a'));
  return hook;
};

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.status.revision = 1;
  mocks.addNotification.mockReset();
  vi.mocked(dbOperations.addLevelObject).mockImplementation(async (object, lease) => hostWrite(`add:${object.id}`, lease));
  vi.mocked(dbOperations.updateLevelObject).mockImplementation(async (id, _updates, lease) => hostWrite(`update:${id}`, lease));
  vi.mocked(dbOperations.deleteLevelObject).mockImplementation(async (id, lease) => hostWrite(`delete:${id}`, lease));
});

describe('addLevelObjects', () => {
  it('writes complete documents parents first as one undo step', async () => {
    const { result } = renderLevels([node('existing')]);
    const component = { id: 'c1', type: 'light', enabled: true, props: { intensity: 2 } };
    let ids: string[] = [];
    await act(async () => {
      ids = await result.current.addLevelObjects([
        node('child', 'root', { components: [component], levelId: 'other-level' }),
        node('root', 'existing'),
        node('grandchild', 'child'),
      ]);
    });
    expect(ids).toEqual(['root', 'child', 'grandchild']);
    expect(mocks.calls).toEqual(['add:root', 'add:child', 'add:grandchild']);
    const child = result.current.levelObjects.find((object) => object.id === 'child');
    expect(child).toMatchObject({ parentId: 'root', levelId: 'level-a', components: [component] });

    mocks.calls.length = 0;
    await act(() => result.current.undo());
    // Undo removes the whole batch, children before parents.
    expect(mocks.calls).toEqual(['delete:grandchild', 'delete:child', 'delete:root']);
    expect(result.current.levelObjects.map((object) => object.id)).toEqual(['existing']);
    expect(result.current.canUndo).toBe(false);
  });

  it('makes an object with a missing or cyclic parent a root', async () => {
    const { result } = renderLevels([]);
    await act(async () => {
      await result.current.addLevelObjects([node('a', 'missing'), node('b', 'c'), node('c', 'b')]);
    });
    const parents = Object.fromEntries(result.current.levelObjects.map((object) => [object.id, object.parentId]));
    expect(parents.a).toBeNull();
    // One link of the cycle is cut so the hierarchy stays acyclic.
    expect([parents.b, parents.c].filter((parent) => parent === null)).toHaveLength(1);
  });

  it('refuses ids already used in the level', async () => {
    const { result } = renderLevels([node('taken')]);
    await expect(result.current.addLevelObjects([node('taken')])).rejects.toThrow(/already used/);
    expect(mocks.calls).toEqual([]);
  });
});

describe('removing level objects', () => {
  it('deletes the whole subtree children first, and undo restores it parents first', async () => {
    const { result } = renderLevels([node('root'), node('child', 'root'), node('grandchild', 'child'), node('other')]);
    await act(() => result.current.removeLevelObject('root'));
    expect(mocks.calls).toEqual(['delete:grandchild', 'delete:child', 'delete:root']);
    expect(result.current.levelObjects.map((object) => object.id)).toEqual(['other']);

    mocks.calls.length = 0;
    await act(() => result.current.undo());
    expect(mocks.calls).toEqual(['add:root', 'add:child', 'add:grandchild']);
  });

  it('deletes overlapping selections once, never a parent before its child', async () => {
    const { result } = renderLevels([node('root'), node('child', 'root'), node('leaf', 'child')]);
    await act(() => result.current.removeLevelObjects(['child', 'root']));
    expect(mocks.calls).toEqual(['delete:leaf', 'delete:child', 'delete:root']);
    expect(result.current.levelObjects).toEqual([]);
  });

  it('keeps the objects that were not deleted when a delete fails', async () => {
    vi.mocked(dbOperations.deleteLevelObject)
      .mockImplementationOnce(async (id, lease) => hostWrite(`delete:${id}`, lease))
      .mockRejectedValueOnce(new Error('host unavailable'));
    const { result } = renderLevels([node('root'), node('child', 'root'), node('leaf', 'child')]);
    await act(() => result.current.removeLevelObject('root'));
    expect(mocks.calls).toEqual(['delete:leaf']);
    expect(result.current.levelObjects.map((object) => object.id)).toEqual(['root', 'child']);
    expect(mocks.addNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});
