import * as THREE from 'three';
import { createElement } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { LoadedModelData } from '../../types';
import { MaterialEditor } from '../../components/Tools/MaterialEditor';
import { createMaterialGraph } from '../../runtime/materials/materialGraph';
import { materialAssetUse, materialLibrary } from '../../runtime/materials/materialLibrary';
import { retextureSessions } from '../../components/Tools/Retexture/retextureSession';
import {
  applyMaterialOverrides,
  listModelMaterials,
  normalizeMaterialOverride,
  rememberImportedLook,
  tagOverrideTexture,
  withBaseMap,
  withLegacyBaseMaps,
  type MaterialOverrides,
} from '../../utils/materialOverrides';

const bodyOf = (params: THREE.MeshStandardMaterialParameters = {}) => {
  const body = new THREE.MeshStandardMaterial({ color: 0x804020, ...params });
  body.name = 'Body';
  const root = new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), body));
  return { root, body };
};

describe('one path for the base map', () => {
  it('takes an older per-model texture override in as a painted base map, once', () => {
    const taken = withLegacyBaseMaps({ Body: { roughness: 0.3 } }, { Body: 'paint', Visor: 'glass' });
    expect(taken).toEqual({
      Body: { roughness: 0.3, mapTextureId: 'paint', paintedMap: true },
      Visor: { mapTextureId: 'glass', paintedMap: true },
    });
    expect(withLegacyBaseMaps(taken, { Body: 'paint', Visor: 'glass' })).toEqual(taken);
    expect(withLegacyBaseMaps(taken, undefined)).toBe(taken);
  });

  it('lets a base map chosen in Material Overrides win over an older one', () => {
    expect(withLegacyBaseMaps({ Body: { mapTextureId: 'chosen' } }, { Body: 'older' })).toEqual({ Body: { mapTextureId: 'chosen' } });
  });

  it('remembers a cleared or replaced painted base map, so the older one does not come back', () => {
    const taken = withLegacyBaseMaps({}, { Body: 'paint' });
    const cleared = withBaseMap(taken, 'Body', undefined);
    expect(cleared).toEqual({ Body: { paintedMap: false } });
    expect(withLegacyBaseMaps(cleared, { Body: 'paint' })).toEqual(cleared);
    expect(withBaseMap(taken, 'Body', 'other')).toEqual({ Body: { mapTextureId: 'other', paintedMap: false } });
    // A plain base map set where there was none stays plain, with nothing more stored.
    expect(withBaseMap({}, 'Body', 'plain')).toEqual({ Body: { mapTextureId: 'plain' } });
    expect(normalizeMaterialOverride({ paintedMap: false })).toEqual({ paintedMap: false });
    expect(normalizeMaterialOverride({ paintedMap: 'yes' })).toBeNull();
  });

  it('draws a painted base map as one, and gives the material back as it was', () => {
    const { root, body } = bodyOf();
    const picture = new THREE.Texture();
    applyMaterialOverrides(root, { Body: { mapTextureId: 'paint', paintedMap: true } }, () => picture);
    expect(body.map).toBe(picture);
    expect([body.transparent, body.alphaTest, body.side, body.forceSinglePass]).toEqual([true, 0.5, THREE.DoubleSide, true]);
    // A plain colour tinted nothing until now: the picture shows its own colours.
    expect(body.color.getHex()).toBe(0xffffff);
    applyMaterialOverrides(root, { Body: { mapTextureId: 'paint' } }, () => picture);
    expect([body.transparent, body.alphaTest, body.side]).toEqual([false, 0, THREE.FrontSide]);
    expect(body.color.getHex()).toBe(0x804020);
    applyMaterialOverrides(root, {});
    expect(body.map).toBeNull();
  });

  it('does not mistake a map an override binds for the imported one', () => {
    // Retexture tries a result on, then saves it: the result is tagged for its override before it is applied.
    const imported = new THREE.Texture();
    const { root, body } = bodyOf({ map: imported });
    rememberImportedLook([body]);
    const result = new THREE.Texture();
    body.map = result;
    body.side = THREE.DoubleSide;
    tagOverrideTexture(result, 'take', 'map');
    applyMaterialOverrides(root, { Body: { mapTextureId: 'take', paintedMap: true } }, () => result);
    expect(body.map).toBe(result);
    applyMaterialOverrides(root, {});
    expect(body.map).toBe(imported);
    expect(body.side).toBe(THREE.FrontSide);
  });

  it('lists every map slot, and which materials a material asset can shade', () => {
    const root = new THREE.Group();
    const standard = new THREE.MeshStandardMaterial({ name: 'Hull' });
    const unlit = new THREE.MeshBasicMaterial({ name: 'Sign' });
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), [standard, unlit]));
    const [hull, sign] = listModelMaterials(root);
    expect(hull.takesAsset).toBe(true);
    expect([hull.base.hasRoughnessSlot, hull.base.hasMetalnessSlot]).toEqual([true, true]);
    expect(sign.takesAsset).toBe(false);
    expect(sign.base.hasRoughnessSlot).toBe(false);
  });
});

describe('Retexture saving a result on a part', () => {
  it('puts its picture in the material overrides with its other maps, and lets go of the older texture override after', async () => {
    const { root, body } = bodyOf();
    const calls: string[] = [];
    let savedMaterials: MaterialOverrides | null = null;
    let savedLegacy: Record<string, string> | null = null;
    const sessions = retextureSessions as unknown as { keep: () => Promise<string>; textures: Map<string, THREE.Texture> };
    const keep = sessions.keep;
    sessions.keep = async () => 'take-picture';
    try {
      const part = { materialNames: ['Body'], baselineOverrides: { Body: 'older' }, baselineMaterialOverrides: {}, saved: null, worn: null, followNext: false };
      const take = { id: 'take-1', maps: [{ role: 'roughness', textureId: 'take-rough' }] };
      await retextureSessions.saveOnModel(
        { object: root, attached: false } as never, part as never, take as never,
        { overrides: { Body: 'older', Visor: 'kept' }, materials: { Body: { metalness: 0.5 } } },
        async (legacy) => { calls.push('legacy'); savedLegacy = legacy; },
        async (materials) => { calls.push('materials'); savedMaterials = materials; },
      );
      expect(calls).toEqual(['materials', 'legacy']);
      expect(savedMaterials).toEqual({ Body: { metalness: 0.5, mapTextureId: 'take-picture', paintedMap: true, roughnessTextureId: 'take-rough' } });
      expect(savedLegacy).toEqual({ Visor: 'kept' });
    } finally {
      sessions.keep = keep;
    }
    expect(body.name).toBe('Body');
  });
});

describe('Material Overrides', () => {
  afterEach(() => materialLibrary.replaceAll([]));

  const open = (material: THREE.Material, overrides: MaterialOverrides = {}) => {
    const root = new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    const model: LoadedModelData & { materialOverrides?: unknown } = {
      id: 'model-1', name: 'Robot', url: '', object: root, animations: [], category: 'Prop', isPlacedInScene: true, materialOverrides: overrides,
    };
    render(createElement(MaterialEditor, { model, textures: [{ id: 'rough', name: 'Rough', url: 'blob:rough', dimensions: { width: 1, height: 1 } }], onSave: async () => undefined }));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(material.name) }));
  };

  it('shows the roughness and metalness maps an override holds, to clear or replace', () => {
    open(new THREE.MeshStandardMaterial({ name: 'Body' }), { Body: { roughnessTextureId: 'rough' } });
    expect(within(screen.getByLabelText('Roughness map')).getByRole('combobox').textContent).toContain('Rough');
    expect(screen.getByLabelText('Metalness map')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset roughness map' }));
    expect(within(screen.getByLabelText('Roughness map')).getByRole('combobox').textContent).toContain('Imported');
  });

  it('offers only material assets that draw', () => {
    materialLibrary.replaceAll([
      { id: 'shader', name: 'Glow', graph: createMaterialGraph() },
      { id: 'drawn', name: 'Bricks', graph: createMaterialGraph(), textureGraph: { baked: { textures: { baseColor: 'tex' } } } },
      { id: 'undrawn', name: 'Moss', graph: createMaterialGraph(), textureGraph: {} },
      { id: 'function', name: 'Edge mask', graph: createMaterialGraph(), textureGraph: { library: true } },
    ]);
    expect(materialLibrary.list().map((asset) => [asset.name, materialAssetUse(asset)])).toEqual([
      ['Bricks', 'material'], ['Edge mask', 'forOtherGraphs'], ['Glow', 'material'], ['Moss', 'needsPictures'],
    ]);
    open(new THREE.MeshStandardMaterial({ name: 'Body' }));
    fireEvent.click(within(screen.getByLabelText('Material asset')).getByRole('combobox'));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Its own', 'Bricks', 'Glow']);
    expect(screen.getByText(/Not offered until they have pictures: Moss/)).toBeTruthy();
  });

  it('names a painted picture the model wears that the library does not list, and keeps "Missing texture" for what is nowhere', () => {
    const body = new THREE.MeshStandardMaterial({ name: 'Body', map: new THREE.Texture() });
    // The mask tool's picture: stored in the project and worn, but not in the library list until the project opens again.
    const picture = tagOverrideTexture(new THREE.Texture(), 'mask-picture', 'map');
    applyMaterialOverrides(new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), body)), { Body: { mapTextureId: 'mask-picture', paintedMap: true } }, () => picture);
    open(body, { Body: { mapTextureId: 'mask-picture', paintedMap: true, normalTextureId: 'gone' } });
    expect(within(screen.getByLabelText('Base map')).getByRole('combobox').textContent).toContain('Painted picture');
    expect(screen.getByText(/A painted picture: it shows its own colours/)).toBeTruthy();
    expect(within(screen.getByLabelText('Normal map')).getByRole('combobox').textContent).toContain('Missing texture');
  });

  it('names a Retexture result by its name in the library', () => {
    open(new THREE.MeshStandardMaterial({ name: 'Body' }), { Body: { mapTextureId: 'rough', paintedMap: true } });
    expect(within(screen.getByLabelText('Base map')).getByRole('combobox').textContent).toContain('Rough');
    expect(screen.getByText(/A painted picture/)).toBeTruthy();
  });

  it('says plainly when a material cannot take a material asset', () => {
    open(new THREE.MeshBasicMaterial({ name: 'Sign' }));
    expect(within(screen.getByLabelText('Material asset')).getByRole('combobox').hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/can't shade this material: it is drawn without lighting/)).toBeTruthy();
  });
});
