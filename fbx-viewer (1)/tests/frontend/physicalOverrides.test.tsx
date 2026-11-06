import * as THREE from 'three';
import { createElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { LoadedModelData } from '../../types';
import { MaterialEditor } from '../../components/Tools/MaterialEditor';
import { OUTPUT_NODE_TYPE, defaultParams, normalizeMaterialGraph } from '../../runtime/materials/materialGraph';
import { materialLibrary } from '../../runtime/materials/materialLibrary';
import { applyMaterialOverrides, listModelMaterials, normalizeMaterialOverride } from '../../utils/materialOverrides';

/** A car paint glTF's material: a coat over a red base. */
const carPaint = () => {
  const paint = new THREE.MeshPhysicalMaterial({ name: 'Paint', color: 0xaa1111, clearcoat: 1, clearcoatRoughness: 0.1 });
  const root = new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), paint));
  return { root, paint };
};

afterEach(() => materialLibrary.replaceAll([]));

describe('a physical material\'s values in its override', () => {
  it('are kept within their ranges when stored', () => {
    expect(normalizeMaterialOverride({ coat: 2, ior: 0.5, sheenColor: '#CC6688', anisotropyRotation: 90, thinFilmThickness: 420, attenuationColor: 'blue' }))
      .toEqual({ coat: 1, ior: 1, sheenColor: '#cc6688', anisotropyRotation: 90, thinFilmThickness: 420 });
  });

  it('tune the material, and give back its own values when they go', () => {
    const { root, paint } = carPaint();
    applyMaterialOverrides(root, { Paint: { coatRoughness: 0.02, ior: 1.6, sheenColor: '#336699', anisotropy: 0.5, anisotropyRotation: 90, transmission: 0.2 } });
    expect(paint.clearcoat).toBe(1);
    expect(paint.clearcoatRoughness).toBeCloseTo(0.02);
    expect(paint.ior).toBeCloseTo(1.6);
    expect(paint.sheen).toBe(1);
    expect(`#${paint.sheenColor.getHexString()}`).toBe('#336699');
    expect(paint.anisotropyRotation).toBeCloseTo(Math.PI / 2);
    expect(paint.transmission).toBeCloseTo(0.2);
    // Black is no sheen.
    applyMaterialOverrides(root, { Paint: { sheenColor: '#000000' } });
    expect(paint.sheen).toBe(0);
    applyMaterialOverrides(root, {});
    expect([paint.clearcoatRoughness, paint.ior, paint.sheen, paint.anisotropy, paint.transmission]).toEqual([0.1, 1.5, 0, 0, 0]);
  });

  it('do nothing to a standard material', () => {
    const plain = new THREE.MeshStandardMaterial({ name: 'Paint' });
    applyMaterialOverrides(new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), plain)), { Paint: { coat: 1 } });
    expect('clearcoat' in plain).toBe(false);
    expect(plain.type).toBe('MeshStandardMaterial');
  });

  it('give way to a material asset shading it, and apply again once it is gone', () => {
    materialLibrary.replaceAll([{ id: 'plain', name: 'Plain', graph: normalizeMaterialGraph({ nodes: [{ id: 'out', type: OUTPUT_NODE_TYPE, x: 0, y: 0, params: defaultParams(OUTPUT_NODE_TYPE) }], links: [] }) }]);
    const { root, paint } = carPaint();
    applyMaterialOverrides(root, { Paint: { coat: 0.5, materialId: 'plain' } });
    // The graph uses no coat, so the material draws none while it shades it.
    expect(paint.clearcoat).toBe(0);
    applyMaterialOverrides(root, { Paint: { coat: 0.5 } });
    expect(paint.clearcoat).toBeCloseTo(0.5);
    applyMaterialOverrides(root, {});
    expect(paint.clearcoat).toBe(1);
  });

  it('are listed with the material, as imported', () => {
    const { root } = carPaint();
    const [paint] = listModelMaterials(root);
    expect(paint.base.physical).toMatchObject({ coat: 1, coatRoughness: 0.1, sheenColor: '#000000', ior: 1.5, transmission: 0 });
    const [plain] = listModelMaterials(new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'Plain' }))));
    expect(plain.base.physical).toBeNull();
  });
});

describe('Material Overrides on a physical material', () => {
  const open = (root: THREE.Group) => {
    const model: LoadedModelData = { id: 'car', name: 'Car', url: '', object: root, animations: [], category: 'Prop', isPlacedInScene: true, materialOverrides: {} };
    render(createElement(MaterialEditor, { model, textures: [], onSave: async () => undefined }));
    fireEvent.click(screen.getByRole('button', { name: /Paint/ }));
  };

  it('shows its values by group, the groups it uses open, and edits them live', () => {
    const { root, paint } = carPaint();
    open(root);
    expect(screen.getByRole('button', { name: /^Coat$/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /^Sheen$/ }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.change(screen.getByLabelText('Coat roughness'), { target: { value: '0.4' } });
    expect(paint.clearcoatRoughness).toBeCloseTo(0.4);
    fireEvent.click(screen.getByRole('button', { name: /^Transmission$/ }));
    expect(screen.getByText('none')).toBeTruthy();
  });

  it('shows no physical values for a standard material', () => {
    open(new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'Paint' }))));
    expect(screen.queryByRole('button', { name: /^Coat$/ })).toBeNull();
  });
});
