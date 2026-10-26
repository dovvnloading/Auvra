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
  getNeutralLayerTexture,
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
  it('keeps at most four layers with a positive tiling', () => {
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
  it('patches the standard program to blend the layers by the splat map', () => {
    const splat = createTerrainSplatTexture(createDefaultTerrainSplat(3, 3), 3, 3);
    const material = createTerrainLayerMaterial(splat);
    const shader = {
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
      uniforms: {} as Record<string, THREE.IUniform>,
    };
    patchTerrainLayerShader(shader, material.userData.terrainUniforms);
    expect(shader.vertexShader).toContain('vTerrainSplatUv = vec2(');
    expect(shader.fragmentShader).toContain('uniform sampler2D terrainLayer3;');
    expect(shader.fragmentShader.indexOf('#include <map_fragment>'))
      .toBeLessThan(shader.fragmentShader.indexOf('diffuseColor.rgb *= terrainColor;'));
    expect(shader.uniforms.terrainSplat.value).toBe(splat);
    expect(shader.uniforms.terrainSplatSize.value).toEqual(new THREE.Vector2(3, 3));
    expect(material.customProgramCacheKey()).toBe('auvra-terrain-layers-v1');
    material.dispose();
    splat.dispose();
  });

  it('binds layer textures, tiling and the mask of existing layers', () => {
    const splat = createTerrainSplatTexture(createDefaultTerrainSplat(2, 2), 2, 2);
    const material = createTerrainLayerMaterial(splat);
    const grass = new THREE.Texture();
    bindTerrainLayers(material, { textures: [grass, null], tilings: [8, 4], aspect: 0.5 });
    const uniforms = material.userData.terrainUniforms;
    expect(uniforms.terrainLayer0.value).toBe(grass);
    expect(uniforms.terrainLayer1.value).toBe(getNeutralLayerTexture());
    expect(uniforms.terrainLayer2.value).toBe(getNeutralLayerTexture());
    expect(uniforms.terrainLayerTiling.value.toArray()).toEqual([8, 4, 1, 1]);
    expect(uniforms.terrainLayerMask.value.toArray()).toEqual([1, 1, 0, 0]);
    expect(uniforms.terrainUvAspect.value.toArray()).toEqual([1, 0.5]);
    material.dispose();
    splat.dispose();
  });
});
