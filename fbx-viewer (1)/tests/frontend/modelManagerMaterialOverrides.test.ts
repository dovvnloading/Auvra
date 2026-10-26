import * as THREE from 'three';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedModelData } from '../../types';
import { applyMaterialOverrides, tagOverrideTexture } from '../../utils/materialOverrides';

const mocks = vi.hoisted(() => ({
  loadFBXFile: vi.fn(),
  projectService: {
    assertWritable: vi.fn(),
    getSnapshotAll: vi.fn(),
    uploadAsset: vi.fn(),
    applyChanges: vi.fn(),
    resolveAsset: vi.fn(),
  },
  dbOperations: {
    updateModelMaterialOverrides: vi.fn(),
    updateModelTextureOverrides: vi.fn(),
  },
  addNotification: vi.fn(),
}));

vi.mock('../../utils/modelLoader', () => ({ loadFBXFile: mocks.loadFBXFile, importPhaseLabel: () => 'Loading' }));
vi.mock('../../utils/projectService', () => ({ projectService: mocks.projectService }));
vi.mock('../../utils/db', () => ({
  dbOperations: mocks.dbOperations,
  normalizeAssetInfoUpdate: (value: unknown) => value,
  withoutMaterialOverrideTexture: (value: unknown) => value,
}));
vi.mock('../../utils/processing/ModelTransforms', () => ({
  applyModelImportSettings: () => undefined,
  resolveImportSettings: (value: unknown) => value,
  stripGeometry: () => undefined,
}));
vi.mock('../../utils/thumbnailGenerator', () => ({ generateThumbnail: () => 'data:thumbnail' }));
vi.mock('../../utils/animationBinding', () => ({ prepareAnimationClips: () => ({ clips: [], mode: 'direct' }) }));
vi.mock('../../context/NotificationContext', () => ({ useNotification: () => ({ addNotification: mocks.addNotification }) }));
vi.mock('../../context/OperationContext', () => ({
  isAbortError: (error: unknown) => error instanceof Error && error.name === 'AbortError',
  useOperationActions: () => ({
    startOperation: () => ({
      id: 'op', traceId: 'trace', spanId: 'span', signal: new AbortController().signal,
      update: () => undefined, finish: () => undefined, lockCancellation: () => undefined,
    }),
  }),
}));

import { useModelManager } from '../../hooks/useModelManager';

const bodyModel = (id: string, url = '') => {
  const body = new THREE.MeshStandardMaterial({ color: 0x808080, map: new THREE.Texture() });
  body.name = 'Body';
  const object = new THREE.Group();
  object.add(new THREE.Mesh(new THREE.BoxGeometry(), body));
  const model: LoadedModelData = {
    id, name: 'Robot.fbx', url, object, animations: [], category: 'Prop', isPlacedInScene: false,
    textureOverrides: {}, materialOverrides: {},
  };
  return { model, body };
};

const deferred = <T>(value: T) => {
  let release!: () => void;
  const promise = new Promise<T>((resolve) => { release = () => resolve(value); });
  return { promise, release: () => release() };
};

const saved = { Body: { color: '#00ff00', mapTextureId: 'T' } };

/** The material editor's live preview binds T, then its save commits while the long operation awaits. */
const saveDuringOperation = async (
  result: { current: ReturnType<typeof useModelManager> },
  object: THREE.Object3D,
) => {
  const texture = tagOverrideTexture(new THREE.Texture(), 'T', 'map');
  const disposed = vi.fn();
  texture.addEventListener('dispose', disposed);
  applyMaterialOverrides(object, saved, () => texture);
  await act(() => result.current.updateModelMaterialOverrides('m1', saved));
  expect(result.current.models[0].materialOverrides).toEqual(saved);
  return { texture, disposed };
};

const renderManager = (existing: LoadedModelData) => {
  const view = renderHook(() => useModelManager(vi.fn(), vi.fn(), null, vi.fn(), vi.fn()));
  act(() => view.result.current.setModels([existing]));
  return view;
};

describe('useModelManager material overrides during long operations', () => {
  beforeEach(() => {
    mocks.dbOperations.updateModelMaterialOverrides.mockResolvedValue(undefined);
    mocks.projectService.getSnapshotAll.mockResolvedValue({ domains: { models: [], animations: [] } });
    mocks.projectService.applyChanges.mockResolvedValue(undefined);
  });

  it('reimport publishes the overrides saved while it ran', async () => {
    const existing = bodyModel('m1');
    const replacement = bodyModel('m1');
    mocks.loadFBXFile.mockResolvedValue(replacement.model);
    const upload = deferred('asset-2');
    mocks.projectService.uploadAsset.mockReturnValue(upload.promise);
    const { result } = renderManager(existing.model);

    let reimport!: Promise<void>;
    act(() => { reimport = result.current.reimportModel('m1', new File(['fbx'], 'Robot.fbx')); });
    await waitFor(() => expect(mocks.projectService.uploadAsset).toHaveBeenCalled());
    const { texture, disposed } = await saveDuringOperation(result, existing.model.object);

    await act(async () => { upload.release(); await reimport; });
    expect(mocks.addNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    const published = result.current.models[0];
    expect(published.object).toBe(replacement.model.object);
    expect(published.materialOverrides).toEqual(saved);
    expect(replacement.body.color.getHexString()).toBe('00ff00');
    expect(replacement.body.map).toBe(texture);
    expect(disposed).not.toHaveBeenCalled();
  });

  it('texture reset publishes the overrides saved while it ran', async () => {
    const existing = bodyModel('m1', 'blob:robot');
    const reset = bodyModel('m1');
    mocks.loadFBXFile.mockResolvedValue(reset.model);
    vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob(['fbx']) })));
    const clearTextures = deferred(undefined);
    mocks.dbOperations.updateModelTextureOverrides.mockReturnValue(clearTextures.promise);
    const { result } = renderManager(existing.model);

    let resetting!: Promise<void>;
    act(() => { resetting = result.current.resetModelTexture('m1'); });
    await waitFor(() => expect(mocks.dbOperations.updateModelTextureOverrides).toHaveBeenCalled());
    const { texture, disposed } = await saveDuringOperation(result, existing.model.object);

    await act(async () => { clearTextures.release(); await resetting; });
    const published = result.current.models[0];
    expect(published.object).toBe(reset.model.object);
    expect(published.materialOverrides).toEqual(saved);
    expect(reset.body.color.getHexString()).toBe('00ff00');
    expect(reset.body.map).toBe(texture);
    expect(disposed).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
