import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { frontendDiagnostics } from '../../../diagnostics/runtime';
import { getNeutralLayerTexture } from './terrainLayerMaterial';
import { pictureToRgba8 } from '../../../texturing/textureDecode';
import { decodePictureOffPage, encodeTextureOffPage } from '../../../texturing/texturePipeline';
import { compressionSupport } from '../../../texturing/materialTextureLoader';
import { keptFormat, type CompressionSupport } from '../../../texturing/textureSettings';
import type { EncodedLevel, MaterialTextureFormat, MaterialTextureKind } from '../../../utils/textureCompression/materialTextureEncoder';

/**
 * TERRAIN LAYER TEXTURES
 *
 * A terrain's layers keep their textures in three texture arrays, one slice per layer: colour; normal (red,
 * green); and height with roughness (red, green). Eight layers with four maps each would take thirty-two
 * samplers, more than a shader has; these take three. Every slice is the same size, so each picture is
 * scaled to it.
 *
 * Kept apart like this, each array compresses by what it holds, as material textures do: BC7 colour, BC5
 * normals, BC5 for height and roughness (two channels that have nothing to do with each other), or ASTC or
 * ETC2 on phones. The uncompressed arrays show as the pictures load; once every layer's are in, compressed
 * arrays are made off the page and take their place, at well under half the memory.
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
  /** Colour. */
  albedo: THREE.DataArrayTexture | THREE.CompressedArrayTexture;
  /** Normal, red and green. */
  detail: THREE.DataArrayTexture | THREE.CompressedArrayTexture;
  /** Height in red, roughness in green. */
  surface: THREE.DataArrayTexture | THREE.CompressedArrayTexture;
  /** One texture per layer: what bounced light takes from it. */
  rayMaps: THREE.Texture[];
}

/** The arrays as they are built, before any are compressed. */
type UncompressedArrays = TerrainLayerArrays & { albedo: THREE.DataArrayTexture; detail: THREE.DataArrayTexture; surface: THREE.DataArrayTexture };

/** A layer's picture, decoded at its own depth and ready to draw. */
type LayerPicture = CanvasImageSource & { width: number; height: number };

/** Each picture by URL: loaded, still loading (null), or failed (false). */
type LoadedImages = Map<string, LayerPicture | null | false>;

let drawCanvas: HTMLCanvasElement | null = null;

/** The picture's pixels at slice size, bottom row first, as textures hold them. */
const pixelsOf = (image: CanvasImageSource, size: number): Uint8ClampedArray => {
  drawCanvas ??= document.createElement('canvas');
  drawCanvas.width = size;
  drawCanvas.height = size;
  const context = drawCanvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('A 2D canvas is not available');
  context.setTransform(1, 0, 0, -1, 0, size);
  context.drawImage(image, 0, 0, size, size);
  return context.getImageData(0, 0, size, size).data;
};

/** Channels each array keeps uncompressed: colour as RGBA, the others as two. */
const CHANNELS = { albedo: 4, detail: 2, surface: 2 } as const;

const createArray = (size: number, layers: number, colorSpace: THREE.ColorSpace, channels: 2 | 4): THREE.DataArrayTexture => {
  const texture = new THREE.DataArrayTexture(new Uint8Array(size * size * layers * channels), size, size, layers);
  texture.format = channels === 4 ? THREE.RGBAFormat : THREE.RGFormat;
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
  surface: Uint8Array,
  size: number,
  layer: number,
  images: { albedo?: LayerPicture | null; normal?: LayerPicture | null; roughness?: LayerPicture | null; height?: LayerPicture | null },
): void => {
  const count = size * size;
  const colourAt = layer * count * 4;
  const pairAt = layer * count * 2;
  const colour = images.albedo ? pixelsOf(images.albedo, size) : null;
  for (let index = 0; index < count; index++) {
    albedo[colourAt + index * 4] = colour ? colour[index * 4] : 0x55;
    albedo[colourAt + index * 4 + 1] = colour ? colour[index * 4 + 1] : 0x55;
    albedo[colourAt + index * 4 + 2] = colour ? colour[index * 4 + 2] : 0x55;
    albedo[colourAt + index * 4 + 3] = 255;
  }
  const normal = images.normal ? pixelsOf(images.normal, size) : null;
  for (let index = 0; index < count; index++) {
    detail[pairAt + index * 2] = normal ? normal[index * 4] : 128;
    detail[pairAt + index * 2 + 1] = normal ? normal[index * 4 + 1] : 128;
  }
  const height = images.height ? pixelsOf(images.height, size) : null;
  // Roughness pictures are read from green, as packed maps keep it there.
  const roughness = images.roughness ? pixelsOf(images.roughness, size) : null;
  for (let index = 0; index < count; index++) {
    surface[pairAt + index * 2] = height ? height[index * 4] : 128;
    surface[pairAt + index * 2 + 1] = roughness ? roughness[index * 4 + 1] : 255;
  }
};

/** The compressed format each array takes on a graphics card, or null where one of them would be kept whole. */
export const terrainArrayFormats = (support: CompressionSupport): Record<keyof typeof CHANNELS, MaterialTextureFormat> | null => {
  const shape = { depth: 8, hdr: false, width: TERRAIN_LAYER_TEXTURE_SIZE, height: TERRAIN_LAYER_TEXTURE_SIZE };
  const albedo = keptFormat('colour', undefined, support, { ...shape, channels: 3 });
  const detail = keptFormat('normal', undefined, support, { ...shape, channels: 2 });
  // Two channels of data: BC5 keeps each with its own end points.
  const surface = keptFormat('data', { compression: 'bc5' }, support, { ...shape, channels: 2 });
  if (albedo === 'rgba8' || albedo === 'half' || detail === 'rgba8' || detail === 'half' || surface === 'rgba8' || surface === 'half') return null;
  return { albedo, detail, surface };
};

/** One layer's slice of an array as RGBA, as the encoders take it; a normal's blue is rebuilt from red and green. */
export const sliceRgba = (data: Uint8Array, channels: 2 | 4, size: number, layer: number, normal = false): Uint8Array => {
  const count = size * size;
  const at = layer * count * channels;
  if (channels === 4) return data.slice(at, at + count * 4);
  const out = new Uint8Array(count * 4);
  for (let index = 0; index < count; index++) {
    const r = data[at + index * 2];
    const g = data[at + index * 2 + 1];
    out[index * 4] = r;
    out[index * 4 + 1] = g;
    if (normal) {
      const x = r / 127.5 - 1;
      const y = g / 127.5 - 1;
      out[index * 4 + 2] = Math.round((Math.sqrt(Math.max(0, 1 - x * x - y * y)) * 0.5 + 0.5) * 255);
    }
    out[index * 4 + 3] = 255;
  }
  return out;
};

/** Each layer's mip levels laid one array level after another, as a compressed array texture holds them. */
export const arrayLevels = (layers: readonly EncodedLevel[][]): EncodedLevel[] => layers[0].map((level, index) => {
  const data = new Uint8Array(layers.reduce((total, levels) => total + levels[index].data.length, 0));
  let offset = 0;
  for (const levels of layers) {
    data.set(levels[index].data, offset);
    offset += levels[index].data.length;
  }
  return { data, width: level.width, height: level.height };
});

const COMPRESSED_ARRAY_FORMATS: Record<MaterialTextureFormat, THREE.CompressedPixelFormat> = {
  bc7: THREE.RGBA_BPTC_Format,
  bc5: THREE.RED_GREEN_RGTC2_Format,
  bc4: THREE.SIGNED_RED_RGTC1_Format,
  astc: THREE.RGBA_ASTC_4x4_Format,
  etc2: THREE.RGB_ETC2_Format,
  etc2a: THREE.RGBA_ETC2_EAC_Format,
};

type Encode = (rgba: Uint8Array, width: number, height: number, format: MaterialTextureFormat, kind: MaterialTextureKind, mips: boolean) => Promise<EncodedLevel[]>;

/** Compressed versions of the arrays, made by role, layer by layer (off the page in the editor). */
export const compressTerrainArrays = async (
  arrays: Pick<UncompressedArrays, 'albedo' | 'detail' | 'surface'>,
  layers: number,
  size: number,
  formats: Record<keyof typeof CHANNELS, MaterialTextureFormat>,
  encode: Encode = encodeTextureOffPage,
): Promise<Record<keyof typeof CHANNELS, THREE.CompressedArrayTexture>> => {
  const roles = [
    { key: 'albedo', kind: 'colour', colorSpace: THREE.SRGBColorSpace },
    { key: 'detail', kind: 'normal', colorSpace: THREE.NoColorSpace },
    { key: 'surface', kind: 'data', colorSpace: THREE.NoColorSpace },
  ] as const;
  const made: Partial<Record<keyof typeof CHANNELS, THREE.CompressedArrayTexture>> = {};
  for (const role of roles) {
    const data = arrays[role.key].image.data as unknown as Uint8Array;
    const perLayer: EncodedLevel[][] = [];
    for (let layer = 0; layer < layers; layer++) {
      perLayer.push(await encode(sliceRgba(data, CHANNELS[role.key], size, layer, role.kind === 'normal'), size, size, formats[role.key], role.kind, true));
    }
    const levels = arrayLevels(perLayer);
    const texture = new THREE.CompressedArrayTexture(levels as unknown as ImageData[], size, size, layers, COMPRESSED_ARRAY_FORMATS[formats[role.key]]);
    texture.colorSpace = role.colorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = levels.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
    made[role.key] = texture;
  }
  return made as Record<keyof typeof CHANNELS, THREE.CompressedArrayTexture>;
};

/**
 * The texture arrays for these layers, rebuilt as their pictures load, then compressed once all have. Null
 * with no layers. Each URL is loaded once while a layer uses it.
 */
export const useTerrainLayerArrays = (sources: readonly TerrainLayerSources[]): TerrainLayerArrays | null => {
  const key = sources.map(source => `${source.albedo ?? ''}|${source.normal ?? ''}|${source.roughness ?? ''}|${source.height ?? ''}`).join('\n');
  const loaded = useRef<LoadedImages>(new Map());
  const [version, setVersion] = useState(0);
  const [compressed, setCompressed] = useState<{ key: string; arrays: TerrainLayerArrays } | null>(null);
  const count = sources.length;

  const arrays = useMemo<UncompressedArrays | null>(() => {
    if (count === 0) return null;
    return {
      albedo: createArray(TERRAIN_LAYER_TEXTURE_SIZE, count, THREE.SRGBColorSpace, CHANNELS.albedo),
      detail: createArray(TERRAIN_LAYER_TEXTURE_SIZE, count, THREE.NoColorSpace, CHANNELS.detail),
      surface: createArray(TERRAIN_LAYER_TEXTURE_SIZE, count, THREE.NoColorSpace, CHANNELS.surface),
      rayMaps: [],
    };
  }, [count]);
  useEffect(() => () => {
    arrays?.albedo.dispose();
    arrays?.detail.dispose();
    arrays?.surface.dispose();
  }, [arrays]);
  useEffect(() => () => {
    compressed?.arrays.albedo.dispose();
    compressed?.arrays.detail.dispose();
    compressed?.arrays.surface.dispose();
  }, [compressed]);

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
      // Decoded at its own depth (16-bit, floating point, TIFF, TGA, PSD), off the page, then laid into the layer's slices.
      fetch(url)
        .then(response => response.arrayBuffer())
        .then(buffer => decodePictureOffPage(new Uint8Array(buffer)))
        .then(picture => createImageBitmap(new ImageData(new Uint8ClampedArray(pictureToRgba8(picture)), picture.width, picture.height), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))
        .then((bitmap) => {
          if (!active && !images.has(url)) return;
          images.set(url, bitmap);
          setVersion(value => value + 1);
        }, (error: unknown) => {
          // Settled without it, so the rest can still be compressed.
          if (images.has(url)) images.set(url, false);
          setVersion(value => value + 1);
          frontendDiagnostics.failure('terrain_layer_texture_load_failed', error);
        });
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
    const surfaceData = arrays.surface.image.data as unknown as Uint8Array;
    let changed = false;
    sources.forEach((source, layer) => {
      const get = (url?: string) => (url ? images.get(url) || null : null);
      const parts = { albedo: get(source.albedo), normal: get(source.normal), roughness: get(source.roughness), height: get(source.height) };
      const signature = [source.albedo && parts.albedo ? source.albedo : '', source.normal && parts.normal ? source.normal : '', source.roughness && parts.roughness ? source.roughness : '', source.height && parts.height ? source.height : ''].join('|');
      if (written.current.signatures[layer] === signature) return;
      written.current.signatures[layer] = signature;
      writeLayerSlices(albedoData, detailData, surfaceData, TERRAIN_LAYER_TEXTURE_SIZE, layer, parts);
      changed = true;
    });
    if (changed) {
      arrays.albedo.needsUpdate = true;
      arrays.detail.needsUpdate = true;
      arrays.surface.needsUpdate = true;
    }
    arrays.rayMaps.forEach(texture => { if (texture !== getNeutralLayerTexture()) texture.dispose(); });
    arrays.rayMaps = sources.map((source) => {
      const image = source.albedo ? images.get(source.albedo) : null;
      if (!image) return getNeutralLayerTexture();
      const texture = new THREE.Texture(image);
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    });

    // Once every picture has settled, the arrays are compressed by role and take the uncompressed ones' place.
    const settled = sources.every(source => [source.albedo, source.normal, source.roughness, source.height].every(url => !url || images.get(url) !== null));
    const formats = settled ? terrainArrayFormats(compressionSupport()) : null;
    if (!formats) return;
    let current = true;
    const rayMaps = arrays.rayMaps;
    compressTerrainArrays(arrays, count, TERRAIN_LAYER_TEXTURE_SIZE, formats).then((made) => {
      if (!current) {
        made.albedo.dispose(); made.detail.dispose(); made.surface.dispose();
        return;
      }
      setCompressed({ key, arrays: { ...made, rayMaps } });
      // The uncompressed arrays leave the graphics card; their pixels stay for a layer that changes.
      arrays.albedo.dispose(); arrays.detail.dispose(); arrays.surface.dispose();
    }, (error: unknown) => frontendDiagnostics.failure('terrain_layer_compression_failed', error));
    return () => { current = false; };
  }, [arrays, key, version]); // eslint-disable-line react-hooks/exhaustive-deps

  return compressed && compressed.key === key && arrays ? compressed.arrays : arrays;
};
