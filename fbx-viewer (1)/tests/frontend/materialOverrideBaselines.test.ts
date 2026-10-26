import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  UV_ORIGIN_TOP_LEFT_KEY,
  applyMaterialOverrides,
  collectOverrideTextures,
  hydrateMaterialOverrides,
  overrideTextureFlipY,
  tagOverrideTexture,
} from '../../utils/materialOverrides';

const bodyModel = () => {
  const imported = new THREE.Texture();
  const body = new THREE.MeshStandardMaterial({ color: 0x808080, map: imported });
  body.name = 'Body';
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(), body));
  return { root, body, imported };
};

/** What retextureModel / previewTexture do outside the override layer. */
const retexture = (material: THREE.MeshStandardMaterial, texture: THREE.Texture) => {
  material.map?.dispose();
  material.map = texture;
  material.transparent = true;
  material.alphaTest = 0.5;
  material.needsUpdate = true;
};

describe('material override baselines', () => {
  it('keeps a map rebound outside the override layer when the overrides are applied again', () => {
    const { root, body } = bodyModel();
    const overrides = { Body: { color: '#ff0000' } };
    applyMaterialOverrides(root, overrides);
    const retextured = new THREE.Texture();
    retexture(body, retextured);

    applyMaterialOverrides(root, overrides);
    expect(body.map).toBe(retextured);
    expect(body.transparent).toBe(true);
    expect(body.color.getHexString()).toBe('ff0000');

    // Removing every override (reimport/reset detach) keeps the retextured map too.
    applyMaterialOverrides(root, {});
    expect(body.map).toBe(retextured);
    expect(body.transparent).toBe(true);
    expect(body.color.getHexString()).toBe('808080');
  });

  it('keeps a rebound map after an earlier session edited and reverted the material', () => {
    const { root, body } = bodyModel();
    applyMaterialOverrides(root, { Body: { roughness: 0.2 } });
    applyMaterialOverrides(root, {});
    const previewed = new THREE.Texture();
    retexture(body, previewed);
    applyMaterialOverrides(root, {});
    expect(body.map).toBe(previewed);
  });

  it('lays an override map over a rebound map and restores the rebound one, not the imported one', () => {
    const { root, body, imported } = bodyModel();
    const albedo = tagOverrideTexture(new THREE.Texture(), 'tex-albedo', 'map');
    const resolve = (textureId: string) => (textureId === 'tex-albedo' ? albedo : null);
    applyMaterialOverrides(root, { Body: { color: '#00ff00' } });
    const retextured = new THREE.Texture();
    retexture(body, retextured);

    applyMaterialOverrides(root, { Body: { mapTextureId: 'tex-albedo' } }, resolve);
    expect(body.map).toBe(albedo);
    // The override's own binding is not mistaken for an outside rebind.
    applyMaterialOverrides(root, { Body: { mapTextureId: 'tex-albedo' } }, resolve);
    expect(body.map).toBe(albedo);
    applyMaterialOverrides(root, {});
    expect(body.map).toBe(retextured);
    expect(body.map).not.toBe(imported);
    expect(collectOverrideTextures(root).size).toBe(0);
  });

  it('keeps transparency an opacity override turned on only while the override is set', () => {
    const { root, body } = bodyModel();
    applyMaterialOverrides(root, { Body: { opacity: 0.5 } });
    applyMaterialOverrides(root, { Body: { opacity: 0.5 } });
    expect(body.transparent).toBe(true);
    applyMaterialOverrides(root, {});
    expect(body.transparent).toBe(false);
  });
});

describe('override texture sampling', () => {
  it('repeats override textures like imported maps', () => {
    const texture = tagOverrideTexture(new THREE.Texture(), 'tile', 'map');
    expect(texture.wrapS).toBe(THREE.RepeatWrapping);
    expect(texture.wrapT).toBe(THREE.RepeatWrapping);
    expect(texture.flipY).toBe(true);
    expect(tagOverrideTexture(new THREE.Texture(), 'n', 'normal', false).flipY).toBe(false);
  });

  it('flips only for models whose UVs use the three.js bottom-left origin', () => {
    const gltfRoot = new THREE.Group();
    gltfRoot.userData[UV_ORIGIN_TOP_LEFT_KEY] = true;
    expect(overrideTextureFlipY(gltfRoot)).toBe(false);
    expect(overrideTextureFlipY(new THREE.Group())).toBe(true);
  });

  it('hydrates glTF-convention models with unflipped override textures and others flipped', async () => {
    const hydrate = async (topLeft: boolean) => {
      const { root, body } = bodyModel();
      if (topLeft) root.userData[UV_ORIGIN_TOP_LEFT_KEY] = true;
      await hydrateMaterialOverrides(root, { Body: { mapTextureId: 'skin', normalTextureId: 'bumps' } }, {
        resolveTextureUrl: (textureId) => `blob:${textureId}`,
        loadTexture: async () => new THREE.Texture(),
      });
      return body;
    };
    const glb = await hydrate(true);
    expect(glb.map?.flipY).toBe(false);
    expect(glb.normalMap?.flipY).toBe(false);
    expect(glb.map?.wrapS).toBe(THREE.RepeatWrapping);
    const fbx = await hydrate(false);
    expect(fbx.map?.flipY).toBe(true);
    expect(fbx.normalMap?.flipY).toBe(true);
  });
});
