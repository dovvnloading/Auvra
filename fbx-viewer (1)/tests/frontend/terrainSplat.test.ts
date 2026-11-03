import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { TerrainHeightfieldEncodingError } from '../../utils/terrainHeightfieldCodec';
import {
  createDefaultTerrainSplat,
  decodeTerrainSplat,
  DEFAULT_TERRAIN_LAYER_TILING,
  encodeTerrainSplat,
  isTerrainSplatPending,
  normalizeTerrainLayers,
  paintTerrainSplat,
  TERRAIN_SPLATMAP_HEADER_BYTES,
  TERRAIN_SPLATMAP_MIME,
  terrainLayersReferenceTexture,
  terrainSplatLength,
  TerrainSplatEncodingError,
  withoutTerrainLayerTexture,
  withoutTerrainSplatChannel,
} from '../../components/Environment/Terrain/terrainSplatCodec';
import { externalizeTerrainSplat, resolveTerrainSplatmap } from '../../components/Environment/Terrain/terrainSplat';
import {
  bindTerrainLayers,
  createTerrainLayerMaterial,
  createTerrainSplatTexture,
  getEmptySplat,
  getNeutralLayerTexture,
  setTerrainSplatTextures,
  patchTerrainLayerShader,
} from '../../components/Environment/Terrain/terrainLayerMaterial';

// The asset layout the host would validate: "AUVRASP1", uint32 columns, uint32 rows, RGBA8 weights.
const GOLDEN_WEIGHTS = [255, 0, 0, 0, 0, 128, 127, 0, 10, 20, 30, 195, 0, 0, 0, 255];
const GOLDEN_SPLATMAP = '41555652415350310200000002000000' + 'ff000000' + '00807f00' + '0a141ec3' + '000000ff';
const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const sums = (weights: ArrayLike<number>) => Array.from({ length: weights.length / 4 }, (_, sample) => (
  weights[sample * 4] + weights[sample * 4 + 1] + weights[sample * 4 + 2] + weights[sample * 4 + 3]
));

describe('terrain splat codec', () => {
  it('encodes the RGBA8 layout and round trips it', () => {
    const bytes = encodeTerrainSplat(GOLDEN_WEIGHTS, 2, 2);
    expect(toHex(bytes)).toBe(GOLDEN_SPLATMAP);
    expect(bytes.byteLength).toBe(TERRAIN_SPLATMAP_HEADER_BYTES + GOLDEN_WEIGHTS.length);
    expect(decodeTerrainSplat(bytes.buffer, { columns: 2, rows: 2 })).toEqual(GOLDEN_WEIGHTS);
  });

  it('rejects weights that do not describe the grid or a byte', () => {
    expect(() => encodeTerrainSplat([255, 0, 0], 2, 2)).toThrow(/resolution/);
    expect(() => encodeTerrainSplat(GOLDEN_WEIGHTS.map((value, index) => (index === 3 ? 256 : value)), 2, 2)).toThrow(/0 to 255/);
    expect(() => encodeTerrainSplat(GOLDEN_WEIGHTS.map((value, index) => (index === 3 ? 0.5 : value)), 2, 2)).toThrow(/0 to 255/);
    // A rejected edit must not be retried: the level manager reverts heightfield encoding errors.
    expect(() => encodeTerrainSplat([], 1, 1)).toThrow(TerrainHeightfieldEncodingError);
    expect(new TerrainSplatEncodingError('x')).toBeInstanceOf(TerrainHeightfieldEncodingError);

    const bytes = encodeTerrainSplat(GOLDEN_WEIGHTS, 2, 2);
    expect(() => decodeTerrainSplat(bytes.slice(0, bytes.byteLength - 1))).toThrow(/size/);
    expect(() => decodeTerrainSplat(bytes, { columns: 3, rows: 3 })).toThrow(/reference/);
    const unknown = bytes.slice();
    unknown[7] = 0x32;
    expect(() => decodeTerrainSplat(unknown)).toThrow(/format/);
  });

  it('describes (resolution + 1)^2 RGBA samples that start on layer 0', () => {
    expect(terrainSplatLength(64)).toBe(65 * 65 * 4);
    const weights = createDefaultTerrainSplat(3, 3);
    expect(weights).toHaveLength(36);
    expect(sums(weights).every((sum) => sum === 255)).toBe(true);
    expect(Array.from(weights.subarray(0, 4))).toEqual([255, 0, 0, 0]);
  });

  it('treats a splat map without loaded weights as pending', () => {
    const splatmap = { assetId: 'a'.repeat(64), encoding: 'rgba8', columns: 2, rows: 2 };
    expect(isTerrainSplatPending({ splatmap })).toBe(true);
    expect(isTerrainSplatPending({ splatmap, splat: GOLDEN_WEIGHTS })).toBe(false);
    expect(isTerrainSplatPending({})).toBe(false);
    expect(isTerrainSplatPending(undefined)).toBe(false);
  });
});

describe('terrain layers', () => {
  it('gives every layer a positive tiling and drops what is not a texture id', () => {
    const layers = normalizeTerrainLayers([
      { textureId: 'grass', tiling: 8 },
      { textureId: '', tiling: -1 },
      { tiling: Number.NaN },
      null,
      { textureId: 'snow', tiling: 2 },
    ]);
    expect(layers).toEqual([
      { textureId: 'grass', tiling: 8 },
      { tiling: DEFAULT_TERRAIN_LAYER_TILING },
      { tiling: DEFAULT_TERRAIN_LAYER_TILING },
      { tiling: DEFAULT_TERRAIN_LAYER_TILING },
      { textureId: 'snow', tiling: 2 },
    ]);
    expect(normalizeTerrainLayers(undefined)).toEqual([]);
  });

  it('drops a deleted texture without shifting the splat channels', () => {
    const terrain = { resolution: 1, textureLayers: [{ textureId: 'rock', tiling: 4 }, { textureId: 'grass', tiling: 8 }] };
    expect(terrainLayersReferenceTexture(terrain, 'grass')).toBe(true);
    expect(withoutTerrainLayerTexture(terrain, 'sand')).toBe(terrain);
    expect(withoutTerrainLayerTexture(terrain, 'grass').textureLayers).toEqual([{ textureId: 'rock', tiling: 4 }, { tiling: 8 }]);
  });

  it('folds a removed layer channel back into layer 0', () => {
    expect(withoutTerrainSplatChannel(GOLDEN_WEIGHTS, 3)).toEqual([255, 0, 0, 0, 0, 128, 127, 0, 205, 20, 30, 0, 255, 0, 0, 0]);
    expect(sums(withoutTerrainSplatChannel(GOLDEN_WEIGHTS, 1)).every((sum) => sum === 255)).toBe(true);
  });
});

describe('terrain splat painting', () => {
  // A 3x3 grid on a 2x2 plane: samples at x = -1, 0, 1 and y = 1, 0, -1 (row 0 at +y).
  const grid = { columns: 3, rows: 3, width: 2, depth: 2 };
  const sample = (weights: Uint8Array, row: number, column: number) => Array.from(weights.subarray((row * 3 + column) * 4, (row * 3 + column) * 4 + 4));

  it('blends the layer in under the brush and keeps every sample at 255', () => {
    const weights = createDefaultTerrainSplat(3, 3);
    expect(paintTerrainSplat(weights, grid, { x: 0, y: 0, radius: 0.9, strength: 1, layer: 1 })).toBe(true);
    expect(sample(weights, 1, 1)).toEqual([0, 255, 0, 0]);
    expect(sample(weights, 0, 1)).toEqual([255, 0, 0, 0]);

    expect(paintTerrainSplat(weights, grid, { x: 0, y: 0, radius: 0.9, strength: 0.5, layer: 2 })).toBe(true);
    // 127.5 / 127.5 rounds to 256 in total; the painted layer absorbs the remainder.
    expect(sample(weights, 1, 1)).toEqual([0, 128, 127, 0]);
    expect(sums(weights).every((sum) => sum === 255)).toBe(true);
  });

  it('maps the brush to PlaneGeometry sample order', () => {
    const weights = createDefaultTerrainSplat(3, 3);
    paintTerrainSplat(weights, grid, { x: -1, y: 1, radius: 0.5, strength: 1, layer: 3 });
    expect(sample(weights, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(sample(weights, 2, 2)).toEqual([255, 0, 0, 0]);
  });

  it('leaves the weights alone for an invalid layer or an empty brush', () => {
    const weights = createDefaultTerrainSplat(3, 3);
    expect(paintTerrainSplat(weights, grid, { x: 0, y: 0, radius: 1, strength: 1, layer: 4 })).toBe(false);
    expect(paintTerrainSplat(weights, grid, { x: 0, y: 0, radius: 0, strength: 1, layer: 1 })).toBe(false);
    expect(paintTerrainSplat(weights, grid, { x: 0, y: 0, radius: 1, strength: 1, layer: 0 })).toBe(false);
    expect(Array.from(weights)).toEqual(Array.from(createDefaultTerrainSplat(3, 3)));
  });
});

describe('terrain splat assets', () => {
  const assetId = 'b'.repeat(64);

  it('uploads painted weights and stores only the reference', async () => {
    const upload = vi.fn(async (file: File) => {
      expect(file.type).toBe(TERRAIN_SPLATMAP_MIME);
      expect(new Uint8Array(await file.arrayBuffer()).byteLength).toBe(TERRAIN_SPLATMAP_HEADER_BYTES + 16);
      return assetId;
    });
    const terrain = { resolution: 1, width: 10, depth: 10, splat: GOLDEN_WEIGHTS.slice(), textureLayers: [{ textureId: 'grass', tiling: 0 }] };
    const { terrainData, remember } = await externalizeTerrainSplat(terrain, { upload });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(terrainData).toEqual({
      resolution: 1, width: 10, depth: 10,
      textureLayers: [{ textureId: 'grass', tiling: DEFAULT_TERRAIN_LAYER_TILING }],
      splatmap: { assetId, encoding: 'rgba8', columns: 2, rows: 2 },
    });

    // The same weights are not uploaded again while the stored document still references them.
    remember?.();
    const again = await externalizeTerrainSplat(terrain, { upload, storedSplatmap: async () => terrainData.splatmap });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(again.terrainData.splatmap).toEqual(terrainData.splatmap);
  });

  it('keeps an unresolved reference and resolves it from its asset', async () => {
    const splatmap = { assetId, encoding: 'rgba8' as const, columns: 2, rows: 2 };
    const upload = vi.fn(async () => assetId);
    const kept = await externalizeTerrainSplat({ resolution: 1, splatmap }, { upload });
    expect(kept.terrainData).toEqual({ resolution: 1, splatmap });
    expect(upload).not.toHaveBeenCalled();

    const load = vi.fn(async () => encodeTerrainSplat(GOLDEN_WEIGHTS, 2, 2).buffer);
    const [first, second] = await Promise.all([resolveTerrainSplatmap(splatmap, load), resolveTerrainSplatmap(splatmap, load)]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(first).toEqual(GOLDEN_WEIGHTS);
    expect(second).toBe(first);
    await expect(externalizeTerrainSplat({ resolution: 1, splat: [1, 2, 3] }, { upload })).rejects.toThrow(/resolution/);
  });
});

describe('terrain layer material', () => {
  it('patches the standard program to blend the layers by the splat maps', () => {
    const splat = createTerrainSplatTexture(createDefaultTerrainSplat(3, 3), 3, 3);
    const material = createTerrainLayerMaterial(splat);
    const shader = {
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
      uniforms: {} as Record<string, THREE.IUniform>,
    };
    patchTerrainLayerShader(shader, material.userData.terrainUniforms);
    expect(shader.vertexShader).toContain('vTerrainSplatUv = vec2(');
    expect(shader.fragmentShader).toContain('uniform sampler2DArray terrainAlbedoArray;');
    expect(shader.fragmentShader).toContain('uniform sampler2D terrainSplat2;');
    expect(shader.fragmentShader.indexOf('#include <map_fragment>'))
      .toBeLessThan(shader.fragmentShader.indexOf('diffuseColor.rgb *= terrainColor'));
    expect(shader.fragmentShader.indexOf('#include <normal_fragment_maps>'))
      .toBeLessThan(shader.fragmentShader.indexOf('terrainBlendedNormal );'));
    expect(shader.uniforms.terrainSplat.value).toBe(splat);
    expect(shader.uniforms.terrainSplatSize.value).toEqual(new THREE.Vector2(3, 3));
    expect(material.customProgramCacheKey()).toBe('auvra-terrain-layers-v2');
    material.dispose();
    splat.dispose();
  });

  it('binds the arrays and each layer\'s look', () => {
    const splat = createTerrainSplatTexture(createDefaultTerrainSplat(2, 2), 2, 2);
    const material = createTerrainLayerMaterial(splat);
    const albedo = new THREE.DataArrayTexture();
    const detail = new THREE.DataArrayTexture();
    bindTerrainLayers(material, {
      albedo,
      detail,
      width: 100,
      depth: 50,
      layers: [
        { tileSize: 4, rotation: 90, normalStrength: 0.5 },
        { tileSize: 8, heightContrast: 1.5, cliffProjection: true, roughness: 0.25, variation: 0.3 },
      ],
    });
    const uniforms = material.userData.terrainUniforms;
    expect(uniforms.terrainAlbedoArray.value).toBe(albedo);
    expect(uniforms.terrainDetailArray.value).toBe(detail);
    expect(uniforms.terrainLayerCount.value).toBe(2);
    expect(uniforms.terrainLayerUv.value[0].x).toBeCloseTo(0.25);
    expect(uniforms.terrainLayerUv.value[0].y).toBeCloseTo(0);
    expect(uniforms.terrainLayerUv.value[0].z).toBeCloseTo(1);
    expect(uniforms.terrainLayerLook.value[0].w).toBeCloseTo(0.5);
    expect(uniforms.terrainLayerUv.value[1].w).toBeCloseTo(1.5);
    expect(uniforms.terrainLayerSurface.value[1].toArray()).toEqual([0.25, 1, 0.3, 0]);
    expect(uniforms.terrainHeightBlend.value).toBe(1);
    expect(uniforms.terrainPlaneSize.value.toArray()).toEqual([100, 50]);
    // Without maps, bounced light takes the flat colour.
    expect(material.userData.rayAlbedoMaps).toEqual([getNeutralLayerTexture()]);
    material.dispose();
    splat.dispose();
  });

  it('never needs more than two samplers for its layers, and a second map only past four', () => {
    const splat = createTerrainSplatTexture(createDefaultTerrainSplat(2, 2), 2, 2);
    const material = createTerrainLayerMaterial(splat);
    expect(material.userData.terrainUniforms.terrainSplat2.value).toBe(getEmptySplat());
    const second = createTerrainSplatTexture(new Uint8Array(16), 2, 2);
    setTerrainSplatTextures(material, splat, second);
    expect(material.userData.terrainUniforms.terrainSplat2.value).toBe(second);
    setTerrainSplatTextures(material, splat, null);
    expect(material.userData.terrainUniforms.terrainSplat2.value).toBe(getEmptySplat());
    material.dispose();
    splat.dispose();
    second.dispose();
  });
});
