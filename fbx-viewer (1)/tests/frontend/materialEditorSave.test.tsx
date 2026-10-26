import * as THREE from 'three';
import { createElement } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LoadedModelData, TextureData } from '../../types';
import { MaterialEditor } from '../../components/Tools/MaterialEditor';
import {
  UV_ORIGIN_TOP_LEFT_KEY,
  applyMaterialOverrides,
  collectOverrideTextures,
  overrideTextureCacheKey,
  type MaterialOverrides,
} from '../../utils/materialOverrides';

const setup = (topLeftUvs = false) => {
  const imported = new THREE.Texture();
  const body = new THREE.MeshStandardMaterial({ color: 0x808080, map: imported });
  body.name = 'Body';
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(), body));
  if (topLeftUvs) root.userData[UV_ORIGIN_TOP_LEFT_KEY] = true;
  const model: LoadedModelData & { materialOverrides?: unknown } = {
    id: 'model-1', name: 'Robot', url: '', object: root, animations: [], category: 'Prop', isPlacedInScene: true,
    materialOverrides: {},
  };
  const textures: TextureData[] = [{ id: 'T3', name: 'Skin', url: 'blob:skin', dimensions: { width: 1, height: 1 } }];
  const preview = new THREE.Texture<HTMLImageElement>();
  const disposed: THREE.Texture[] = [];
  preview.addEventListener('dispose', () => disposed.push(preview));
  vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockResolvedValue(preview);
  return { root, body, imported, model, textures, preview, disposed };
};

const pickBaseMap = async (preview: THREE.Texture, body: THREE.MeshStandardMaterial) => {
  fireEvent.click(screen.getByRole('button', { name: /Body/ }));
  fireEvent.click(within(screen.getByLabelText('Base map')).getByRole('combobox'));
  fireEvent.click(screen.getByRole('option', { name: 'Skin' }));
  await waitFor(() => expect(body.map).toBe(preview));
};

/** Mirrors updateModelMaterialOverrides: once the host write settles, bind from the textures on the object. */
const hostSave = (root: THREE.Object3D, outcome: 'resolve' | 'reject') => {
  let settle!: () => void;
  const missing: string[] = [];
  const onSave = vi.fn((_modelId: string, overrides: MaterialOverrides) => new Promise<void>((resolve, reject) => {
    settle = () => {
      if (outcome === 'reject') {
        reject(new Error('host write failed'));
        return;
      }
      const textures = collectOverrideTextures(root);
      const result = applyMaterialOverrides(root, overrides, (textureId, slot) => textures.get(overrideTextureCacheKey(textureId, slot)));
      missing.push(...result.missingTextureIds);
      resolve();
    };
  }));
  return { onSave, settle: () => settle(), missing };
};

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

describe('MaterialEditor save in flight', () => {
  it('keeps the saved texture bound when the panel closes before the save settles', async () => {
    const { root, body, model, textures, preview, disposed } = setup();
    const save = hostSave(root, 'resolve');
    const view = render(createElement(MaterialEditor, { model, textures, onSave: save.onSave }));
    await pickBaseMap(preview, body);

    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    expect(save.onSave).toHaveBeenCalledWith('model-1', { Body: { mapTextureId: 'T3' } });
    view.unmount();
    // Closing does not revert while the host write is pending.
    expect(body.map).toBe(preview);

    save.settle();
    await flush();
    expect(save.missing).toEqual([]);
    expect(body.map).toBe(preview);
    expect(disposed).toEqual([]);
  });

  it('reverts to the previous saved value when a save that outlived the panel fails', async () => {
    const { root, body, imported, model, textures, preview, disposed } = setup();
    const save = hostSave(root, 'reject');
    const view = render(createElement(MaterialEditor, { model, textures, onSave: save.onSave }));
    await pickBaseMap(preview, body);

    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    view.unmount();
    expect(body.map).toBe(preview);

    save.settle();
    await flush();
    expect(body.map).toBe(imported);
    expect(disposed).toEqual([preview]);
  });

  it('loads previewed override textures in the model UV orientation', async () => {
    const glb = setup(true);
    const view = render(createElement(MaterialEditor, { model: glb.model, textures: glb.textures }));
    await pickBaseMap(glb.preview, glb.body);
    expect(glb.preview.flipY).toBe(false);
    expect(glb.preview.wrapS).toBe(THREE.RepeatWrapping);
    view.unmount();
    vi.restoreAllMocks();

    const fbx = setup(false);
    render(createElement(MaterialEditor, { model: fbx.model, textures: fbx.textures }));
    await pickBaseMap(fbx.preview, fbx.body);
    expect(fbx.preview.flipY).toBe(true);
  });
});
