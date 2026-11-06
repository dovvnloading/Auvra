import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedModelData } from '../../types';
import { UV_ORIGIN_TOP_LEFT_KEY } from '../../utils/materialOverrides';

const mocks = vi.hoisted(() => ({ loadFBXFile: vi.fn(), textures: [] as unknown[] }));

vi.mock('../../utils/modelLoader', () => ({ loadFBXFile: mocks.loadFBXFile, importPhaseLabel: () => 'Loading' }));
vi.mock('../../utils/processing/ModelTransforms', () => ({
  applyModelImportSettings: () => undefined,
  convertOptionsFor: () => ({}),
  stripGeometry: () => undefined,
}));

import { loadGameContent } from '../../utils/projectHydration';

const bodyModel = (gltf: boolean) => {
  const body = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
  body.name = 'Body';
  const object = new THREE.Group();
  if (gltf) object.userData[UV_ORIGIN_TOP_LEFT_KEY] = true;
  object.add(new THREE.Mesh(new THREE.BoxGeometry(), body));
  const model: LoadedModelData = {
    id: 'm1', name: 'Robot', url: '', object, animations: [], category: 'Prop', isPlacedInScene: false,
  };
  return { model, body };
};

beforeEach(() => {
  let urls = 0;
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => `blob:test/${urls++}` });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, headers: new Headers({ 'Content-Type': 'image/png' }), blob: async () => new Blob(['bytes']),
  })));
  mocks.textures.length = 0;
  vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockImplementation(async () => {
    const texture = new THREE.Texture<HTMLImageElement>();
    mocks.textures.push(texture);
    return texture;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('loadGameContent texture overrides', () => {
  it.each([
    ['glb', false, true],
    ['fbx', true, false],
  ])('orient a stored override on a .%s model with flipY %s, as the editor does', async (extension, flipY, gltf) => {
    const { model, body } = bodyModel(gltf);
    mocks.loadFBXFile.mockResolvedValue(model);
    const loaded = await loadGameContent({
      textures: [{ id: 'tex-1', name: 'Skin', assetId: 'asset-skin' }],
      models: [{ id: 'm1', name: `Robot.${extension}`, assetId: 'asset-robot', textureOverrides: { Body: 'tex-1' } }],
    }, { resolveAssetUrl: async (assetId: string) => `pack://assets/${assetId}`, generateThumbnails: false });

    expect(loaded.content.models).toHaveLength(1);
    expect(loaded.content.models[0].object).toBe(model.object);
    expect(mocks.textures).toHaveLength(1);
    expect(body.map).toBe(mocks.textures[0]);
    expect(body.map!.flipY).toBe(flipY);
    expect(body.map!.colorSpace).toBe(THREE.SRGBColorSpace);
  });

  it('takes an older texture override in as a painted base map of the material overrides', async () => {
    const { model, body } = bodyModel(false);
    mocks.loadFBXFile.mockResolvedValue(model);
    const loaded = await loadGameContent({
      textures: [{ id: 'tex-1', name: 'Skin', assetId: 'asset-skin' }],
      models: [{ id: 'm1', name: 'Robot.fbx', assetId: 'asset-robot', textureOverrides: { Body: 'tex-1' }, materialOverrides: { Body: { roughness: 0.3 } } }],
    }, { resolveAssetUrl: async (assetId: string) => `pack://assets/${assetId}`, generateThumbnails: false });
    const [hydrated] = loaded.content.models;
    expect(hydrated.materialOverrides).toEqual({ Body: { roughness: 0.3, mapTextureId: 'tex-1', paintedMap: true } });
    expect(hydrated.textureOverrides).toEqual({});
    // Drawn as it always was: cut out where see-through, from both sides.
    expect([body.transparent, body.alphaTest, body.side]).toEqual([true, 0.5, THREE.DoubleSide]);
    expect(body.roughness).toBe(0.3);
  });

  it('leaves an older texture override out once the material overrides decided the base map', async () => {
    const { model, body } = bodyModel(false);
    const imported = body.map;
    mocks.loadFBXFile.mockResolvedValue(model);
    const loaded = await loadGameContent({
      textures: [{ id: 'tex-1', name: 'Skin', assetId: 'asset-skin' }],
      // The base map was cleared in Material Overrides.
      models: [{ id: 'm1', name: 'Robot.fbx', assetId: 'asset-robot', textureOverrides: { Body: 'tex-1' }, materialOverrides: { Body: { paintedMap: false } } }],
    }, { resolveAssetUrl: async (assetId: string) => `pack://assets/${assetId}`, generateThumbnails: false });
    expect(loaded.content.models[0].materialOverrides).toEqual({ Body: { paintedMap: false } });
    expect(body.map).toBe(imported);
    expect(body.side).toBe(THREE.FrontSide);
  });
});
