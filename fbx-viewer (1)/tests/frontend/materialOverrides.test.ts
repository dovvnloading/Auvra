import * as THREE from 'three';
import { createElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LoadedModelData } from '../../types';
import { MaterialEditor } from '../../components/Tools/MaterialEditor';
import {
  applyMaterialOverrides,
  collectOverrideTextures,
  hydrateMaterialOverrides,
  listModelMaterials,
  materialOverrideTextureIds,
  materialOverridesEqual,
  normalizeMaterialOverrides,
  setMaterialOverrideField,
  tagOverrideTexture,
  type MaterialTextureSlot,
} from '../../utils/materialOverrides';

const standard = (name: string, params: THREE.MeshStandardMaterialParameters = {}) => {
  const material = new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.5, metalness: 0.1, ...params });
  material.name = name;
  return material;
};

/** body (two meshes share one material, a third has its own instance), visor, and an unnamed material. */
const model = () => {
  const body = standard('Body');
  const bodyCopy = standard('Body');
  const visor = standard('Visor', { emissive: 0x000000 });
  const unnamed = standard('');
  const root = new THREE.Group();
  const geometry = new THREE.BoxGeometry();
  root.add(new THREE.Mesh(geometry, body), new THREE.Mesh(geometry, body), new THREE.Mesh(geometry, bodyCopy));
  root.add(new THREE.Mesh(geometry, [visor, unnamed]));
  return { root, body, bodyCopy, visor, unnamed };
};

describe('material override normalization', () => {
  it('keeps valid fields, clamps numbers and drops malformed entries', () => {
    expect(normalizeMaterialOverrides({
      Body: { color: '#FF0000', roughness: 2, metalness: -1, opacity: 0.5, emissiveIntensity: 1e9, extra: 1 },
      Visor: { color: 'red', roughness: Number.NaN, mapTextureId: '' },
      '': { color: '#00ff00' },
      Glass: { normalTextureId: 'tex-normal' },
    })).toEqual({
      Body: { color: '#ff0000', roughness: 1, metalness: 0, opacity: 0.5, emissiveIntensity: 100 },
      Glass: { normalTextureId: 'tex-normal' },
    });
    expect(normalizeMaterialOverrides(null)).toEqual({});
    expect(normalizeMaterialOverrides(['Body'])).toEqual({});
  });

  it('edits one field immutably and removes emptied entries', () => {
    const initial = { Body: { color: '#ff0000' } };
    const withRoughness = setMaterialOverrideField(initial, 'Body', 'roughness', 0.2);
    expect(withRoughness).toEqual({ Body: { color: '#ff0000', roughness: 0.2 } });
    expect(initial).toEqual({ Body: { color: '#ff0000' } });
    const cleared = setMaterialOverrideField(setMaterialOverrideField(withRoughness, 'Body', 'roughness', undefined), 'Body', 'color', undefined);
    expect(cleared).toEqual({});
  });

  it('compares overrides regardless of key order', () => {
    expect(materialOverridesEqual({ A: { color: '#000000', opacity: 1 }, B: {} }, { B: {}, A: { opacity: 1, color: '#000000' } })).toBe(true);
    expect(materialOverridesEqual({ A: { opacity: 1 } }, { A: { opacity: 0.5 } })).toBe(false);
  });
});

describe('applyMaterialOverrides', () => {
  it('applies by material name to every instance and leaves other materials alone', () => {
    const { root, body, bodyCopy, visor } = model();
    const result = applyMaterialOverrides(root, {
      Body: { color: '#ff0000', roughness: 0.9, metalness: 0.8 },
      Visor: { emissive: '#00ff00', emissiveIntensity: 4 },
      Missing: { color: '#0000ff' },
    });
    for (const material of [body, bodyCopy]) {
      expect(material.color.getHexString()).toBe('ff0000');
      expect(material.roughness).toBe(0.9);
      expect(material.metalness).toBe(0.8);
    }
    expect(visor.emissive.getHexString()).toBe('00ff00');
    expect(visor.emissiveIntensity).toBe(4);
    expect(visor.color.getHexString()).toBe('808080');
    expect([...result.appliedMaterialNames].sort()).toEqual(['Body', 'Visor']);
  });

  it('is idempotent and reverts fields and entries that are removed', () => {
    const { root, body } = model();
    applyMaterialOverrides(root, { Body: { color: '#ff0000', roughness: 0.9 } });
    applyMaterialOverrides(root, { Body: { color: '#ff0000', roughness: 0.9 } });
    expect(body.roughness).toBe(0.9);
    applyMaterialOverrides(root, { Body: { color: '#ff0000' } });
    expect(body.roughness).toBe(0.5);
    expect(body.color.getHexString()).toBe('ff0000');
    applyMaterialOverrides(root, {});
    expect(body.color.getHexString()).toBe('808080');
  });

  it('turns transparency on below full opacity and restores it after', () => {
    const { root, body } = model();
    const version = body.version;
    applyMaterialOverrides(root, { Body: { opacity: 0.25 } });
    expect(body.opacity).toBe(0.25);
    expect(body.transparent).toBe(true);
    expect(body.version).toBeGreaterThan(version);
    applyMaterialOverrides(root, {});
    expect(body.opacity).toBe(1);
    expect(body.transparent).toBe(false);
  });

  it('binds resolved textures, keeps the imported map when one is missing, and restores it', () => {
    const { root, body, visor } = model();
    const imported = new THREE.Texture();
    body.map = imported;
    const albedo = new THREE.Texture();
    const normal = new THREE.Texture();
    const resolve = vi.fn((textureId: string, slot: MaterialTextureSlot) => (
      textureId === 'tex-albedo' && slot === 'map' ? albedo : textureId === 'tex-normal' && slot === 'normal' ? normal : null
    ));
    const result = applyMaterialOverrides(root, {
      Body: { mapTextureId: 'tex-albedo', normalTextureId: 'tex-normal' },
      Visor: { mapTextureId: 'tex-pending' },
    }, resolve);
    expect(body.map).toBe(albedo);
    expect(body.normalMap).toBe(normal);
    expect(visor.map).toBeNull();
    expect([...result.boundTextureKeys].sort()).toEqual(['map:tex-albedo', 'normal:tex-normal']);
    expect([...result.missingTextureIds]).toEqual(['tex-pending']);
    applyMaterialOverrides(root, {});
    expect(body.map).toBe(imported);
    expect(body.normalMap).toBeNull();
  });

  it('only sets PBR fields on materials that have them', () => {
    const phong = new THREE.MeshPhongMaterial({ color: 0x808080 });
    phong.name = 'Old';
    const root = new THREE.Mesh(new THREE.BoxGeometry(), phong);
    applyMaterialOverrides(root, { Old: { color: '#123456', roughness: 0.3 } });
    expect(phong.color.getHexString()).toBe('123456');
    expect('roughness' in phong).toBe(false);
  });
});

describe('listModelMaterials', () => {
  it('groups by name and reports imported values even after overrides', () => {
    const { root } = model();
    applyMaterialOverrides(root, { Body: { color: '#ff0000' } });
    const materials = listModelMaterials(root);
    expect(materials.map((material) => [material.name, material.instanceCount])).toEqual([['Body', 2], ['Visor', 1], ['', 1]]);
    expect(materials[0].base).toMatchObject({ color: '#808080', roughness: 0.5, metalness: 0.1, opacity: 1, hasMapSlot: true });
  });
});

describe('hydrateMaterialOverrides', () => {
  it('loads referenced textures and binds them to the named materials', async () => {
    const { root, body } = model();
    const textures = new Map<string, THREE.Texture>();
    const loadTexture = vi.fn(async (url: string) => {
      const texture = new THREE.Texture();
      textures.set(url, texture);
      return texture;
    });
    const overrides = await hydrateMaterialOverrides(root, {
      Body: { mapTextureId: 'tex-albedo', roughness: 0.2 },
      Missing: { normalTextureId: 'tex-normal' },
      Ghost: { mapTextureId: 'tex-not-in-project' },
    }, {
      resolveTextureUrl: (textureId) => (textureId === 'tex-not-in-project' ? undefined : `blob:${textureId}`),
      loadTexture,
    });
    expect(Object.keys(overrides)).toEqual(['Body', 'Missing', 'Ghost']);
    expect(loadTexture).toHaveBeenCalledTimes(2);
    const albedo = textures.get('blob:tex-albedo')!;
    expect(body.map).toBe(albedo);
    expect(body.roughness).toBe(0.2);
    expect(albedo.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(collectOverrideTextures(root).get('map:tex-albedo')).toBe(albedo);
  });

  it('disposes every loaded texture when the load is superseded', async () => {
    const { root, body } = model();
    const loaded: THREE.Texture[] = [];
    const disposed: THREE.Texture[] = [];
    const loadTexture = async () => {
      const texture = new THREE.Texture();
      texture.addEventListener('dispose', () => disposed.push(texture));
      loaded.push(texture);
      return texture;
    };
    await expect(hydrateMaterialOverrides(root, { Body: { mapTextureId: 'a' } }, {
      resolveTextureUrl: (textureId) => `blob:${textureId}`,
      loadTexture,
      assertCurrent: () => { throw new DOMException('superseded', 'AbortError'); },
    })).rejects.toThrow('superseded');
    expect(disposed).toEqual(loaded);
    expect(body.map).toBeNull();
  });

  it('disposes textures no material binds', async () => {
    const { root } = model();
    const disposed: string[] = [];
    await hydrateMaterialOverrides(root, { Missing: { normalTextureId: 'tex-normal' } }, {
      resolveTextureUrl: (textureId) => `blob:${textureId}`,
      loadTexture: async (url) => {
        const texture = new THREE.Texture();
        texture.addEventListener('dispose', () => disposed.push(url));
        return texture;
      },
    });
    expect(disposed).toEqual(['blob:tex-normal']);
  });

  it('tags override textures with their slot colour space', () => {
    expect(tagOverrideTexture(new THREE.Texture(), 'n', 'normal').colorSpace).toBe(THREE.NoColorSpace);
  });
});

describe('MaterialEditor', () => {
  it('previews edits live, saves them and reverts unsaved edits on close', async () => {
    const { root, body } = model();
    const loaded: LoadedModelData & { materialOverrides?: unknown } = {
      id: 'model-1', name: 'Robot', url: '', object: root, animations: [], category: 'Prop', isPlacedInScene: true,
      materialOverrides: { Body: { roughness: 0.3 } },
    };
    const onSave = vi.fn(async () => undefined);
    const view = render(createElement(MaterialEditor, { model: loaded, textures: [], onSave }));
    expect(body.roughness).toBe(0.3);

    fireEvent.click(screen.getByRole('button', { name: /Body/ }));
    fireEvent.change(screen.getByLabelText('Roughness'), { target: { value: '0.8' } });
    expect(body.roughness).toBe(0.8);
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('model-1', { Body: { roughness: 0.8 } }));

    fireEvent.change(screen.getByLabelText('Metalness'), { target: { value: '0.9' } });
    expect(body.metalness).toBe(0.9);
    view.unmount();
    expect(body.metalness).toBe(0.1);
    expect(body.roughness).toBe(0.8);
  });
});

describe('surface maps on a material', () => {
  const textured = () => {
    const material = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.2 });
    material.name = 'Body';
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BufferGeometry(), material));
    return { root, material };
  };
  const maps = { roughnessTextureId: 'tex-rough', metalnessTextureId: 'tex-metal' };

  it('binds roughness and metal maps, the values stepping aside for them', () => {
    const { root, material } = textured();
    const rough = new THREE.Texture();
    const metal = new THREE.Texture();
    applyMaterialOverrides(root, { Body: maps }, (id) => (id === 'tex-rough' ? rough : metal));
    expect(material.roughnessMap).toBe(rough);
    expect(material.metalnessMap).toBe(metal);
    expect(material.roughness).toBe(1);
    expect(material.metalness).toBe(1);
  });

  it('puts everything back when the override goes', () => {
    const { root, material } = textured();
    applyMaterialOverrides(root, { Body: maps }, () => new THREE.Texture());
    applyMaterialOverrides(root, {});
    expect(material.roughnessMap).toBeNull();
    expect(material.metalnessMap).toBeNull();
    expect(material.roughness).toBe(0.4);
    expect(material.metalness).toBe(0.2);
  });

  it('keeps the fields when reading stored overrides, and lists their textures', () => {
    const overrides = normalizeMaterialOverrides({ Body: maps });
    expect(overrides.Body).toEqual(maps);
    expect(materialOverrideTextureIds(overrides)).toEqual([{ textureId: 'tex-rough', slot: 'roughness' }, { textureId: 'tex-metal', slot: 'metalness' }]);
  });

  it('stores the maps as data, not colour', () => {
    const texture = tagOverrideTexture(new THREE.Texture(), 'tex-rough', 'roughness');
    expect(texture.colorSpace).toBe(THREE.NoColorSpace);
  });
});
