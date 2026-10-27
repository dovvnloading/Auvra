import * as THREE from 'three';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedModelData } from '../../types';
import { UV_ORIGIN_TOP_LEFT_KEY, applyMaterialOverrides, tagOverrideTexture } from '../../utils/materialOverrides';

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
    addModelTextureOverride: vi.fn(),
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
vi.mock('../../utils/animationBinding', () => ({
  prepareAnimationClips: () => ({ clips: [], mode: 'direct' }),
  uniqueClipNames: (names: string[]) => [...names],
  applyStoredClipNames: () => undefined,
}));
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

const bodyModel = (id: string, { gltf = false, name = 'Robot.fbx' } = {}) => {
  const body = new THREE.MeshStandardMaterial({ color: 0x808080, map: new THREE.Texture() });
  body.name = 'Body';
  const object = new THREE.Group();
  if (gltf) object.userData[UV_ORIGIN_TOP_LEFT_KEY] = true;
  object.add(new THREE.Mesh(new THREE.BoxGeometry(), body));
  const model: LoadedModelData = {
    id, name, url: '', object, animations: [], category: 'Prop', isPlacedInScene: false,
    textureOverrides: {}, materialOverrides: {},
  };
  return { model, body };
};

const deferred = <T>(value: T) => {
  let release!: () => void;
  const promise = new Promise<T>((resolve) => { release = () => resolve(value); });
  return { promise, release: () => release() };
};

const renderManager = (existing: LoadedModelData) => {
  const view = renderHook(() => useModelManager(vi.fn(), vi.fn(), null, vi.fn(), vi.fn()));
  act(() => view.result.current.setModels([existing]));
  return view;
};

beforeEach(() => {
  vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockImplementation(async () => new THREE.Texture());
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['png'], { type: 'image/png' }) })));
  mocks.dbOperations.updateModelMaterialOverrides.mockResolvedValue(undefined);
  mocks.dbOperations.addModelTextureOverride.mockResolvedValue('tex-1');
  mocks.projectService.getSnapshotAll.mockResolvedValue({ domains: { models: [], animations: [] } });
  mocks.projectService.uploadAsset.mockResolvedValue('asset-2');
  mocks.projectService.applyChanges.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useModelManager texture overrides follow the model UV origin', () => {
  it.each([
    ['glTF', false, true],
    ['FBX', true, false],
  ])('preview on a %s model binds the texture with flipY %s', async (_label, flipY, gltf) => {
    const { model, body } = bodyModel('m1', { gltf });
    const { result } = renderManager(model);
    await act(() => result.current.previewTexture('m1', 'blob:preview'));
    expect(body.map).not.toBeNull();
    expect(body.map!.flipY).toBe(flipY);
  });

  it.each([
    ['glTF', false, true],
    ['FBX', true, false],
  ])('retexture on a %s model binds the texture with flipY %s', async (_label, flipY, gltf) => {
    const { model, body } = bodyModel('m1', { gltf });
    const { result } = renderManager(model);
    await act(() => result.current.retextureModel('m1', 'blob:retexture'));
    expect(mocks.dbOperations.addModelTextureOverride).toHaveBeenCalled();
    expect(result.current.models[0].textureOverrides).toEqual({ Body: 'tex-1' });
    expect(body.map!.flipY).toBe(flipY);
  });

  it('reimport from FBX to glTF reorients the adopted override textures', async () => {
    const existing = bodyModel('m1');
    existing.model.textureOverrides = { Body: 'tex-1' };
    const adopted = existing.body.map!;
    adopted.flipY = true;
    const normal = tagOverrideTexture(new THREE.Texture(), 'N', 'normal', true);
    existing.model.materialOverrides = { Body: { normalTextureId: 'N' } };
    applyMaterialOverrides(existing.model.object, existing.model.materialOverrides, () => normal);
    expect(existing.body.normalMap).toBe(normal);
    const replacement = bodyModel('m1', { gltf: true, name: 'Robot.glb' });
    mocks.loadFBXFile.mockResolvedValue(replacement.model);
    const { result } = renderManager(existing.model);

    await act(() => result.current.reimportModel('m1', new File(['glb'], 'Robot.glb')));
    expect(result.current.models[0].object).toBe(replacement.model.object);
    expect(replacement.body.map).toBe(adopted);
    expect(adopted.flipY).toBe(false);
    expect(replacement.body.normalMap).toBe(normal);
    expect(normal.flipY).toBe(false);
  });
});

describe('useModelManager material override save that settles after a reimport', () => {
  it('applies to the published replacement, not the disposed original', async () => {
    const existing = bodyModel('m1');
    const replacement = bodyModel('m1');
    mocks.loadFBXFile.mockResolvedValue(replacement.model);
    const write = deferred(undefined);
    mocks.dbOperations.updateModelMaterialOverrides.mockReturnValue(write.promise);
    const { result } = renderManager(existing.model);
    const saved = { Body: { color: '#00ff00' } };

    let save!: Promise<void>;
    act(() => { save = result.current.updateModelMaterialOverrides('m1', saved); });
    await act(() => result.current.reimportModel('m1', new File(['fbx'], 'Robot.fbx')));
    expect(result.current.models[0].object).toBe(replacement.model.object);
    expect(replacement.body.color.getHexString()).toBe('808080');

    await act(async () => { write.release(); await save; });
    const published = result.current.models[0];
    expect(published.object).toBe(replacement.model.object);
    expect(published.materialOverrides).toEqual(saved);
    expect(replacement.body.color.getHexString()).toBe('00ff00');
    expect(existing.body.color.getHexString()).toBe('808080');
  });

  it('applies nothing when the model was removed while the save ran', async () => {
    const { model, body } = bodyModel('m1');
    const write = deferred(undefined);
    mocks.dbOperations.updateModelMaterialOverrides.mockReturnValue(write.promise);
    const { result } = renderManager(model);

    let save!: Promise<void>;
    act(() => { save = result.current.updateModelMaterialOverrides('m1', { Body: { color: '#00ff00' } }); });
    act(() => result.current.setModels([]));
    await act(async () => { write.release(); await save; });
    expect(result.current.models).toEqual([]);
    expect(body.color.getHexString()).toBe('808080');
  });
});
