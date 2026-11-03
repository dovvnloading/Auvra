import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { frontendDiagnostics } from '../../../diagnostics/runtime';
import { getNeutralLayerTexture } from './terrainLayerMaterial';

/**
 * TERRAIN LAYER TEXTURES
 *
 * A terrain's layers keep their textures in two texture arrays, one slice per layer: colour with height
 * in alpha, and normal (red, green) with roughness (blue). Eight layers with four maps each would take
 * thirty-two samplers, more than a shader has; these take two. Every slice is the same size, so each
 * picture is scaled to it.
 */

/** Pixels along each side of a slice. */
export const TERRAIN_LAYER_TEXTURE_SIZE = 1024;

export interface TerrainLayerSources {
  albedo?: string;
  normal?: string;
  roughness?: string;
  height?: string;
}

export interface TerrainLayerArrays {
  albedo: THREE.DataArrayTexture;
  detail: THREE.DataArrayTexture;
  /** One texture per layer: what bounced light takes from it. */
  rayMaps: THREE.Texture[];
}

type LoadedImages = Map<string, HTMLImageElement | null>;

let drawCanvas: HTMLCanvasElement | null = null;

/** The picture's pixels at slice size, bottom row first, as textures hold them. */
const pixelsOf = (image: HTMLImageElement, size: number): Uint8ClampedArray => {
  drawCanvas ??= document.createElement('canvas');
  drawCanvas.width = size;
  drawCanvas.height = size;
  const context = drawCanvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('A 2D canvas is not available');
  context.setTransform(1, 0, 0, -1, 0, size);
  context.drawImage(image, 0, 0, size, size);
  return context.getImageData(0, 0, size, size).data;
};

const createArray = (size: number, layers: number, colorSpace: THREE.ColorSpace): THREE.DataArrayTexture => {
  const texture = new THREE.DataArrayTexture(new Uint8Array(size * size * layers * 4), size, size, layers);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.unpackAlignment = 1;
  return texture;
};

/** Writes one layer's slice of each array from whatever of its pictures have loaded. */
export const writeLayerSlices = (
  albedo: Uint8Array,
  detail: Uint8Array,
  size: number,
  layer: number,
  images: { albedo?: HTMLImageElement | null; normal?: HTMLImageElement | null; roughness?: HTMLImageElement | null; height?: HTMLImageElement | null },
): void => {
  const start = layer * size * size * 4;
  const count = size * size;
  if (images.albedo) {
    const pixels = pixelsOf(images.albedo, size);
    for (let index = 0; index < count; index++) {
      albedo[start + index * 4] = pixels[index * 4];
      albedo[start + index * 4 + 1] = pixels[index * 4 + 1];
      albedo[start + index * 4 + 2] = pixels[index * 4 + 2];
    }
  } else {
    for (let index = 0; index < count; index++) {
      albedo[start + index * 4] = 0x55;
      albedo[start + index * 4 + 1] = 0x55;
      albedo[start + index * 4 + 2] = 0x55;
    }
  }
  if (images.height) {
    const pixels = pixelsOf(images.height, size);
    for (let index = 0; index < count; index++) albedo[start + index * 4 + 3] = pixels[index * 4];
  } else {
    for (let index = 0; index < count; index++) albedo[start + index * 4 + 3] = 128;
  }
  if (images.normal) {
    const pixels = pixelsOf(images.normal, size);
    for (let index = 0; index < count; index++) {
      detail[start + index * 4] = pixels[index * 4];
      detail[start + index * 4 + 1] = pixels[index * 4 + 1];
    }
  } else {
    for (let index = 0; index < count; index++) {
      detail[start + index * 4] = 128;
      detail[start + index * 4 + 1] = 128;
    }
  }
  if (images.roughness) {
    const pixels = pixelsOf(images.roughness, size);
    for (let index = 0; index < count; index++) detail[start + index * 4 + 2] = pixels[index * 4 + 1];
  } else {
    for (let index = 0; index < count; index++) detail[start + index * 4 + 2] = 255;
  }
  for (let index = 0; index < count; index++) detail[start + index * 4 + 3] = 255;
};

/**
 * The texture arrays for these layers, rebuilt as their pictures load. Null with no layers. Each URL is
 * loaded once while a layer uses it.
 */
export const useTerrainLayerArrays = (sources: readonly TerrainLayerSources[]): TerrainLayerArrays | null => {
  const key = sources.map(source => `${source.albedo ?? ''}|${source.normal ?? ''}|${source.roughness ?? ''}|${source.height ?? ''}`).join('\n');
  const loaded = useRef<LoadedImages>(new Map());
  const [version, setVersion] = useState(0);
  const count = sources.length;

  const arrays = useMemo<TerrainLayerArrays | null>(() => {
    if (count === 0) return null;
    return {
      albedo: createArray(TERRAIN_LAYER_TEXTURE_SIZE, count, THREE.SRGBColorSpace),
      detail: createArray(TERRAIN_LAYER_TEXTURE_SIZE, count, THREE.NoColorSpace),
      rayMaps: [],
    };
  }, [count]);
  useEffect(() => () => {
    arrays?.albedo.dispose();
    arrays?.detail.dispose();
  }, [arrays]);

  useEffect(() => {
    let active = true;
    const images = loaded.current;
    const wanted = new Set<string>();
    for (const source of sources) {
      for (const url of [source.albedo, source.normal, source.roughness, source.height]) if (url) wanted.add(url);
    }
    for (const url of images.keys()) if (!wanted.has(url)) images.delete(url);
    for (const url of wanted) {
      if (images.has(url)) continue;
      images.set(url, null);
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => {
        if (!active && !images.has(url)) return;
        images.set(url, image);
        setVersion(value => value + 1);
      };
      image.onerror = (error) => frontendDiagnostics.failure('terrain_layer_texture_load_failed', error);
      image.src = url;
    }
    return () => { active = false; };
  }, [key]);

  // Slices change only when a layer's pictures do, or the array is new.
  const written = useRef<{ arrays: TerrainLayerArrays | null; signatures: string[] }>({ arrays: null, signatures: [] });
  useEffect(() => {
    if (!arrays) return;
    const images = loaded.current;
    if (written.current.arrays !== arrays) written.current = { arrays, signatures: [] };
    const albedoData = arrays.albedo.image.data as unknown as Uint8Array;
    const detailData = arrays.detail.image.data as unknown as Uint8Array;
    let changed = false;
    sources.forEach((source, layer) => {
      const get = (url?: string) => (url ? images.get(url) ?? null : null);
      const parts = { albedo: get(source.albedo), normal: get(source.normal), roughness: get(source.roughness), height: get(source.height) };
      const signature = [source.albedo && parts.albedo ? source.albedo : '', source.normal && parts.normal ? source.normal : '', source.roughness && parts.roughness ? source.roughness : '', source.height && parts.height ? source.height : ''].join('|');
      if (written.current.signatures[layer] === signature) return;
      written.current.signatures[layer] = signature;
      writeLayerSlices(albedoData, detailData, TERRAIN_LAYER_TEXTURE_SIZE, layer, parts);
      changed = true;
    });
    if (changed) {
      arrays.albedo.needsUpdate = true;
      arrays.detail.needsUpdate = true;
    }
    arrays.rayMaps.forEach(texture => { if (texture !== getNeutralLayerTexture()) texture.dispose(); });
    arrays.rayMaps = sources.map((source) => {
      const image = source.albedo ? images.get(source.albedo) : null;
      if (!image) return getNeutralLayerTexture();
      const texture = new THREE.Texture(image);
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    });
  }, [arrays, key, version]);

  return arrays;
};
